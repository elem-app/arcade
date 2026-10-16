import type { ZodType } from "zod";

import type { ArcadeLogger } from "../logging.js";
import type { ArcRunId } from "./core.js";
import type { JsonValue } from "./json.js";
import type { RoutineInput, RoutineReport } from "./routine.js";
import {
  parseWorkerSlotSchema,
  type WorkerSlot,
  type WorkerSlotKind,
} from "./worker-slot.js";

/** Backend implementation registered by the application builder. */
export interface Backend {
  supportedSlotKinds: ReadonlySet<WorkerSlotKind>;
  /** Optional synchronous Zod contract applied before worker construction. */
  workerSlotSchema?: ZodType<unknown>;
  createWorker(host: WorkerHost, slot: WorkerSlot): Worker | Promise<Worker>;
}

/**
 * Define a backend whose Zod slot schema validates and types its worker factory.
 * Direct `createWorker(...)` calls receive the same normalization and supported
 * kind checks as hub-mediated calls.
 */
export function defineBackend<TSlot extends WorkerSlot>(definition: {
  supportedSlotKinds: ReadonlySet<WorkerSlotKind>;
  workerSlotSchema: ZodType<TSlot>;
  createWorker(host: WorkerHost, slot: TSlot): Worker | Promise<Worker>;
}): Backend {
  return {
    supportedSlotKinds: definition.supportedSlotKinds,
    workerSlotSchema: definition.workerSlotSchema as ZodType<unknown>,
    createWorker: (host, slot) => {
      const parsed = parseWorkerSlotSchema(definition.workerSlotSchema, slot);
      if (!definition.supportedSlotKinds.has(parsed.kind)) {
        throw new Error(
          `Backend ${JSON.stringify(parsed.backend)} does not support ${parsed.kind} worker slots.`,
        );
      }
      return definition.createWorker(host, parsed);
    },
  };
}

/** Durable state facade scoped to one configured worker slot. */
export interface WorkerStateStore {
  get(arcRunId: ArcRunId, key: string): Promise<JsonValue | undefined>;
  put(arcRunId: ArcRunId, key: string, value: JsonValue): Promise<void>;
}

/** Slot-scoped host services available while creating and running a worker. */
export interface WorkerHost {
  logger: ArcadeLogger;
  state: WorkerStateStore;
}

/** Configured live instance of one backend implementation. */
export interface Worker {
  warm?(input: WorkerWarmupInput): Promise<void>;
  run(input: RoutineInput): Promise<RoutineReport>;
  /** Idempotently release this routine's continuation after its invocation settles. */
  disposeRoutine(input: {
    arcRunId: ArcRunId;
    routineId: string;
  }): Promise<void>;
  stop?(): void | Promise<void>;
}

/** Preparation awaited under the worker context admission before invocation. */
export type WorkerWarmupInput = {
  arcRunId: ArcRunId;
  role: string;
  contextKey: string;
  workspacePath: string;
};
