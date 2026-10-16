import { InProcessBackend } from "../backends/in-process-backend.js";
import { previewLogValue, type ArcadeLogger } from "../logging.js";
import type { WorkerStatePersistence } from "../storage/base.js";
import type { Backend, Worker, WorkerHost } from "../types/backend.js";
import type { RoleWorker } from "../types/hub.js";
import { canonicalizeJsonValue } from "../types/json.js";
import type { Task } from "../types/task.js";
import {
  parseBackendName,
  parseRawWorkersConfig,
  parseWorkerSlot,
  parseWorkerSlotSchema,
  type BackendName,
  type RawWorkerSlot,
  type RawWorkersConfig,
  type WorkerSlot,
  type WorkerSlotKind,
} from "../types/worker-slot.js";

type WorkerDestination = "default" | "role" | "fast-trigger";

type WorkerDefinition = {
  destination: WorkerDestination;
  role?: string;
  backend: Backend;
  slot: WorkerSlot;
};

/** One configured worker and the binding that selected it. */
export type ResolvedWorker = {
  backend: BackendName;
  slot: WorkerSlot;
  worker: Worker;
};

type ResolvedWorkers = {
  default?: ResolvedWorker;
  roles: Map<string, ResolvedWorker>;
  fastTrigger?: ResolvedWorker;
  inProcess: ResolvedWorker;
  fail: ResolvedWorker;
};

/** Owns backend registration and the transactional lifecycle of configured workers. */
export class WorkerRegistry {
  readonly #logger: ArcadeLogger;
  readonly #stateStore: WorkerStatePersistence;
  readonly #backends = new Map<BackendName, Backend>();
  readonly #inProcessBackend = new InProcessBackend();
  #resolved?: ResolvedWorkers;
  #created: ResolvedWorker[] = [];

  constructor(options: {
    logger: ArcadeLogger;
    stateStore: WorkerStatePersistence;
  }) {
    this.#logger = options.logger;
    this.#stateStore = options.stateStore;
  }

  /** Whether every configured worker was constructed synchronously. */
  get started(): boolean {
    return this.#resolved !== undefined;
  }

  /** Register one trusted backend implementation before startup. */
  addBackend(name: BackendName, backend: Backend): void {
    parseBackendName(name);
    if (name === "in-process" || name === "fail") {
      throw new Error(`Backend name ${JSON.stringify(name)} is reserved.`);
    }
    if (this.#backends.has(name)) {
      throw new Error(`Backend ${JSON.stringify(name)} is already registered.`);
    }
    this.#backends.set(name, backend);
  }

  /** Register one in-process role implementation. */
  registerRoleWorker(role: string, worker: RoleWorker): void {
    this.#inProcessBackend.registerRoleWorker(role, worker);
  }

  /** Resolve configured slots and create every worker as one transaction. */
  start(workers: RawWorkersConfig = {}): Promise<void> {
    const definitions = this.#resolveDefinitions(
      parseRawWorkersConfig(workers),
    );
    const resolved: ResolvedWorkers = {
      roles: new Map(),
      inProcess: undefined as never,
      fail: undefined as never,
    };
    const created: ResolvedWorker[] = [];
    const allDefinitions = [
      ...definitions,
      {
        destination: "in-process" as const,
        backend: this.#inProcessBackend,
        slot: parseWorkerSlot({
          backend: "in-process",
          kind: "default",
        }),
      },
    ];

    // Keep the all-synchronous path synchronous through publication. Worker hub
    // intentionally supports callers that start a fully synchronous registry
    // and immediately dispatch without awaiting its already-resolved promise.
    // Once one factory is async, recursion preserves definition order while the
    // final assignment still publishes all workers atomically.
    const createFrom = (index: number): Promise<void> => {
      while (index < allDefinitions.length) {
        const definition = allDefinitions[index]!;
        let candidate: Worker | Promise<Worker>;
        try {
          candidate = definition.backend.createWorker(
            this.#workerHost(definition.slot),
            definition.slot,
          );
        } catch (error) {
          return this.#rollback(created, error);
        }
        if (isPromiseLike(candidate)) {
          return Promise.resolve(candidate).then(
            (worker) => {
              try {
                this.#recordCreated(resolved, created, definition, worker);
              } catch (error) {
                return this.#rollback(created, error);
              }
              return createFrom(index + 1);
            },
            (error: unknown) => this.#rollback(created, error),
          );
        }
        try {
          this.#recordCreated(resolved, created, definition, candidate);
        } catch (error) {
          return this.#rollback(created, error);
        }
        index += 1;
      }

      resolved.fail = createFailWorker();
      // Do not expose a partially constructed routing table: rollback owns all
      // workers in `created` until every configured factory has succeeded.
      this.#resolved = resolved;
      this.#created = created;
      return Promise.resolve();
    };

    return createFrom(0);
  }

  /** Stop every created worker in reverse construction order. */
  async stop(): Promise<void> {
    const failures: unknown[] = [];
    for (const resolved of [...this.#created].reverse()) {
      try {
        await resolved.worker.stop?.();
      } catch (error) {
        failures.push(error);
        this.#logger.info("worker_hub.worker.stop_failed", {
          backend: resolved.backend,
          slot: resolved.slot,
          error: previewLogValue(error),
        });
      }
    }
    this.#created = [];
    this.#resolved = undefined;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more worker hub workers failed to stop.",
      );
    }
  }

  /** Select the configured worker for one task. */
  select(task: Task): ResolvedWorker {
    const workers = this.#resolved;
    if (!workers) throw new Error("Worker hub has no resolved workers.");
    if (
      task.kind === "semantic" &&
      task.stage === "trigger" &&
      workers.fastTrigger
    ) {
      return workers.fastTrigger;
    }
    return (
      workers.roles.get(task.role) ??
      (this.#inProcessBackend.hasRole(task.role)
        ? workers.inProcess
        : undefined) ??
      workers.default ??
      workers.fail
    );
  }

  #resolveDefinitions(workers: RawWorkersConfig): WorkerDefinition[] {
    const declarations: Array<{
      destination: WorkerDestination;
      role?: string;
      raw: RawWorkerSlot;
    }> = [];
    if (workers.default !== undefined) {
      declarations.push({ destination: "default", raw: workers.default });
    }
    for (const [role, raw] of Object.entries(workers.roles ?? {})) {
      declarations.push({ destination: "role", role, raw });
    }
    if (workers.fastTrigger !== undefined && workers.fastTrigger !== null) {
      declarations.push({
        destination: "fast-trigger",
        raw: workers.fastTrigger,
      });
    }

    return declarations.map((declaration) => {
      const raw = declaration.raw;
      const backend =
        raw.backend === "in-process"
          ? this.#inProcessBackend
          : this.#backends.get(raw.backend);
      if (!backend) {
        throw new Error(
          `Worker slot selects unregistered backend ${JSON.stringify(raw.backend)}.`,
        );
      }
      const kind: WorkerSlotKind = declaration.destination;
      if (!backend.supportedSlotKinds.has(kind)) {
        throw new Error(
          `Backend ${JSON.stringify(raw.backend)} does not support ${kind} worker slots.`,
        );
      }
      const completeSlot = parseWorkerSlot(
        declaration.role === undefined
          ? { ...raw, kind }
          : { ...raw, kind, role: declaration.role },
      );
      const slot = backend.workerSlotSchema
        ? parseWorkerSlotSchema(backend.workerSlotSchema, completeSlot)
        : completeSlot;
      return { ...declaration, backend, slot };
    });
  }

  #recordCreated(
    resolved: ResolvedWorkers,
    created: ResolvedWorker[],
    definition: {
      destination: WorkerDestination | "in-process";
      role?: string;
      slot: WorkerSlot;
    },
    worker: Worker,
  ): void {
    if (
      !worker ||
      typeof worker.run !== "function" ||
      typeof worker.disposeRoutine !== "function"
    ) {
      throw new Error(
        `Backend ${JSON.stringify(definition.slot.backend)} did not create a Worker.`,
      );
    }
    if (created.some((entry) => entry.worker === worker)) {
      throw new Error(
        `Backend ${JSON.stringify(definition.slot.backend)} returned one Worker for more than one slot.`,
      );
    }
    const entry = {
      backend: definition.slot.backend,
      slot: definition.slot,
      worker,
    };
    created.push(entry);
    if (definition.destination === "default") resolved.default = entry;
    else if (definition.destination === "fast-trigger") {
      resolved.fastTrigger = entry;
    } else if (definition.destination === "role") {
      resolved.roles.set(definition.role!, entry);
    } else {
      resolved.inProcess = entry;
    }
  }

  async #rollback(
    created: readonly ResolvedWorker[],
    originalError: unknown,
  ): Promise<never> {
    for (const resolved of [...created].reverse()) {
      try {
        await resolved.worker.stop?.();
      } catch (error) {
        this.#logger.info("worker_hub.worker.rollback_stop_failed", {
          backend: resolved.backend,
          slot: resolved.slot,
          error: previewLogValue(error),
        });
      }
    }
    throw originalError;
  }

  #workerHost(slot: WorkerSlot): WorkerHost {
    const backend = slot.backend;
    const role = slot.kind === "role" ? slot.role : undefined;
    const fields = { backend, slotKind: slot.kind, ...(role ? { role } : {}) };
    return {
      logger: {
        level: this.#logger.level,
        format: this.#logger.format,
        info: (event, eventFields) =>
          this.#logger.info(event, { ...fields, ...eventFields }),
        debug: (event, eventFields) =>
          this.#logger.debug(event, { ...fields, ...eventFields }),
      },
      state: {
        get: async (arcRunId, key) => {
          const value = await this.#stateStore.getWorkerState(
            backend,
            slot.kind,
            role,
            arcRunId,
            key,
          );
          return value === undefined
            ? undefined
            : canonicalizeJsonValue(value, "worker state");
        },
        put: (arcRunId, key, value) =>
          this.#stateStore.putWorkerState(
            backend,
            slot.kind,
            role,
            arcRunId,
            key,
            canonicalizeJsonValue(value, "worker state"),
          ),
      },
    };
  }
}

function createFailWorker(): ResolvedWorker {
  const slot = parseWorkerSlot({ backend: "fail", kind: "default" });
  return {
    backend: "fail",
    slot,
    worker: {
      disposeRoutine: async () => {},
      run: async (input) => ({
        error: "failed",
        code: "role-not-delegated",
        message: `No configured worker is available for role "${input.routine.role}".`,
      }),
    },
  };
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
