import { isRoutinePausedError } from "../service/execution-control.js";
import type { Backend, Worker, WorkerHost } from "../types/backend.js";
import type { RoleWorker } from "../types/hub.js";
import type { RoutineInput, RoutineReport } from "../types/routine.js";
import type { WorkerSlot, WorkerSlotKind } from "../types/worker-slot.js";
import {
  createWorkerSlotSchema,
  parseWorkerSlotSchema,
} from "../types/worker-slot.js";

const SUPPORTED_SLOT_KINDS: ReadonlySet<WorkerSlotKind> = new Set([
  "default",
  "role",
]);
const InProcessWorkerSlotSchema = createWorkerSlotSchema({});

/** Private registry-backed backend for embedded role callbacks. */
export class InProcessBackend implements Backend {
  readonly supportedSlotKinds = SUPPORTED_SLOT_KINDS;
  readonly workerSlotSchema = InProcessWorkerSlotSchema;
  readonly #workers = new Map<string, RoleWorker>();

  registerRoleWorker(role: string, worker: RoleWorker): void {
    if (this.#workers.has(role)) {
      throw new Error(
        `Worker hub worker already registered for role "${role}".`,
      );
    }
    this.#workers.set(role, worker);
  }

  hasRole(role: string): boolean {
    return this.#workers.has(role);
  }

  createWorker(_host: WorkerHost, slot: WorkerSlot): Worker {
    const parsed = parseWorkerSlotSchema(InProcessWorkerSlotSchema, slot);
    if (!SUPPORTED_SLOT_KINDS.has(parsed.kind)) {
      throw new Error(
        `Backend ${JSON.stringify(parsed.backend)} does not support ${parsed.kind} worker slots.`,
      );
    }
    return {
      run: (input) => this.#run(input, parsed),
      disposeRoutine: async () => {},
    };
  }

  async #run(input: RoutineInput, slot: WorkerSlot): Promise<RoutineReport> {
    const role = input.routine.role;
    const worker = this.#workers.get(role);
    if (!worker) {
      return {
        error: "failed",
        code: "unknown-role",
        message:
          slot.kind === "role"
            ? `No in-process handler registered for configured role "${slot.role}".`
            : `No in-process handler registered for role "${role}".`,
      };
    }
    try {
      return await worker(input.routine.task, input.context, input.effects);
    } catch (error) {
      if ((await input.effects.checkSignal())?.kind === "cancel")
        return { cancellation: "superseded" };
      if (isRoutinePausedError(error)) return { suspension: "paused" };
      return {
        error: "failed",
        code: "handler-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
