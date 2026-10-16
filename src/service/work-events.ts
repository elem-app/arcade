import type { ArcadeLogger } from "../logging.js";
import type { CreateWorkEventInput, WorkEventStore } from "../storage/base.js";
import type { ArcRunId } from "../types/core.js";
import type { WorkEventHandler } from "../types/hub.js";
import type { WorkEvent } from "../types/work-event.js";
import { KeyedSerializer } from "../utils/keyed-serializer.js";

/** Policy-neutral ordered publication shared by the host and hub. */
export class WorkEventService {
  readonly #handlers = new Set<WorkEventHandler>();
  readonly #serializer = new KeyedSerializer<ArcRunId>();
  constructor(
    readonly store: WorkEventStore,
    private readonly logger: ArcadeLogger,
  ) {}

  registerWorkEventHandler(handler: WorkEventHandler): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async list(arcRunId: ArcRunId): Promise<WorkEvent[]> {
    const events: WorkEvent[] = [];
    for await (const event of this.store.listEvents(arcRunId))
      events.push(event);
    return events;
  }

  append(input: CreateWorkEventInput): Promise<WorkEvent> {
    return this.#serializer.run(input.arcRunId, async () => {
      const event = await this.store.appendEvent(input);
      const results = await Promise.allSettled(
        [...this.#handlers].map(async (handler) =>
          handler(structuredClone(event)),
        ),
      );
      for (const result of results) {
        if (result.status === "rejected")
          this.logger.info("worker_hub.work_event.handler_failed", {
            arcRunId: event.arcRunId,
            workEventId: event.id,
            message:
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason),
          });
      }
      return event;
    });
  }
}
