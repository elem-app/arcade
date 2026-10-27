import type { ArcadeLogger } from "../logging.js";
import type { CreateWorkEventInput, WorkEventStore } from "../storage/base.js";
import type { ArcRunId } from "../types/core.js";
import type { WorkEventHandler } from "../types/hub.js";
import type { WorkEvent } from "../types/work-event.js";

type ObservationJob = () => Promise<void>;

/** A bounded retained subset, ordered independently for each run. */
class ObservationQueue {
  readonly #lanes = new Map<ArcRunId, ObservationJob[]>();
  #size = 0;
  #closed = false;

  constructor(readonly limit: number) {}

  offer(arcRunId: ArcRunId, job: ObservationJob): boolean {
    if (this.#closed || this.#size >= this.limit) return false;
    this.#size++;
    const lane = this.#lanes.get(arcRunId);
    if (lane) lane.push(job);
    else {
      const jobs: ObservationJob[] = [];
      this.#lanes.set(arcRunId, jobs);
      // Each job contains its own diagnostics. Keep a final rejection handler
      // here so even an unexpected reporting failure cannot escape observation.
      void this.#run(arcRunId, jobs, job).catch(() => undefined);
    }
    return true;
  }

  async #run(
    arcRunId: ArcRunId,
    lane: ObservationJob[],
    first: ObservationJob,
  ): Promise<void> {
    let job: ObservationJob | undefined = first;
    while (job) {
      try {
        await job();
      } catch {
        /* The producer diagnoses observation failures. */
      } finally {
        this.#size--;
      }
      job = lane.shift();
    }
    this.#lanes.delete(arcRunId);
  }

  close(): void {
    this.#closed = true;
    for (const lane of this.#lanes.values()) {
      this.#size -= lane.length;
      lane.length = 0;
    }
  }
}

type Subscriber = {
  handler: WorkEventHandler;
  queue: ObservationQueue;
  active: boolean;
};

/** Internal publication bounds, overridable by controlled service tests. */
type WorkEventLimits = {
  publications?: number;
  deliveriesPerSubscriber?: number;
};

/** Optional ordered observations, independent of operational progression. */
export class WorkEventService {
  readonly #handlers = new Map<WorkEventHandler, Subscriber>();
  readonly #publications: ObservationQueue;
  readonly #deliveryLimit: number;
  #closed = false;

  constructor(
    readonly store: WorkEventStore,
    private readonly logger: ArcadeLogger,
    limits: WorkEventLimits = {},
  ) {
    this.#publications = new ObservationQueue(limits.publications ?? 1024);
    this.#deliveryLimit = limits.deliveriesPerSubscriber ?? 256;
  }

  registerWorkEventHandler(handler: WorkEventHandler): () => void {
    if (this.#closed) return () => undefined;
    const subscriber = this.#handlers.get(handler) ?? {
      handler,
      queue: new ObservationQueue(this.#deliveryLimit),
      active: true,
    };
    this.#handlers.set(handler, subscriber);
    return () => {
      subscriber.active = false;
      subscriber.queue.close();
      if (this.#handlers.get(handler) === subscriber)
        this.#handlers.delete(handler);
    };
  }

  async list(arcRunId: ArcRunId): Promise<WorkEvent[]> {
    const events: WorkEvent[] = [];
    for await (const event of this.store.listEvents(arcRunId))
      events.push(event);
    return events;
  }

  /** Capture the transition's facts without exposing an observation promise. */
  publish(input: CreateWorkEventInput | (() => CreateWorkEventInput)): void {
    if (this.#closed) return;
    try {
      const captured = structuredClone(
        typeof input === "function" ? input() : input,
      );
      this.publishPrepared(captured.arcRunId, () => captured);
    } catch (error) {
      this.#diagnose("capture_failed", error);
    }
  }

  /** Optional eligibility reads share the bounded, ordered publication queue. */
  publishPrepared(
    arcRunId: ArcRunId,
    prepare: () =>
      | CreateWorkEventInput
      | undefined
      | Promise<CreateWorkEventInput | undefined>,
  ): void {
    if (this.#closed) return;
    try {
      const admitted = this.#publications.offer(arcRunId, async () => {
        try {
          const input = await prepare();
          if (this.#closed || !input) return;
          if (input.arcRunId !== arcRunId)
            throw new Error("Prepared WorkEvent changed its run identity.");
          const event = await this.store.appendEvent(structuredClone(input));
          if (this.#closed) return;
          for (const subscriber of [...this.#handlers.values()])
            this.#deliver(subscriber, event);
        } catch (error) {
          this.#diagnose("publication_failed", error, arcRunId);
        }
      });
      if (!admitted) this.#diagnose("publication_dropped", undefined, arcRunId);
    } catch (error) {
      this.#diagnose("publication_failed", error, arcRunId);
    }
  }

  #deliver(subscriber: Subscriber, event: WorkEvent): void {
    try {
      const captured = structuredClone(event);
      const admitted = subscriber.queue.offer(event.arcRunId, async () => {
        if (this.#closed || !subscriber.active) return;
        try {
          await subscriber.handler(captured);
        } catch (error) {
          this.#diagnose("handler_failed", error, event.arcRunId);
        }
      });
      if (!admitted)
        this.#diagnose("delivery_dropped", undefined, event.arcRunId);
    } catch (error) {
      this.#diagnose("delivery_failed", error, event.arcRunId);
    }
  }

  #diagnose(event: string, error?: unknown, arcRunId?: ArcRunId): void {
    try {
      this.logger.info(`worker_hub.work_event.${event}`, {
        arcRunId,
        ...(error === undefined ? {} : { message: String(error) }),
      });
    } catch {
      /* Optional diagnostics cannot change an operational outcome. */
    }
  }

  /** Close admission and discard waiting observations; never drain external work. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#publications.close();
    for (const subscriber of this.#handlers.values()) {
      subscriber.active = false;
      subscriber.queue.close();
    }
    this.#handlers.clear();
  }
}
