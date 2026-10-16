import {
  classifyCapacityLimit,
  classifyTransportLoss,
  isCapacityLimitError,
  isTransportLossError,
} from "../service/execution-control.js";
import type { JsonValue } from "../types/json.js";
import type { RoutineInput, RoutineReport } from "../types/routine.js";
import type { Task } from "../types/task.js";
import type { BackendName } from "../types/worker-slot.js";

/** Backend-local mutable task copy paired with the hub-owned routine identity. */
export type BackendRoutine = Omit<RoutineInput["routine"], "task"> & {
  task: Task;
};

/** Materialize the frozen boundary task as backend-local mutable input. */
export function backendRoutine(input: RoutineInput): BackendRoutine {
  return {
    ...input.routine,
    task: structuredClone(input.routine.task) as Task,
  };
}

/** Attach worker-owned audit details to a report at the Worker boundary. */
export function withBackendDetails<T extends RoutineReport>(
  report: T,
  backendDetails: JsonValue,
): T & { backendDetails: JsonValue } {
  return { ...report, backendDetails };
}

/** Translate one recognized provider condition into the worker report protocol. */
export function providerFailureReport(
  error: unknown,
  backend: BackendName,
  classifierBackend: BackendName = backend,
): RoutineReport | undefined {
  const capacity = isCapacityLimitError(error)
    ? error.reason
    : classifyCapacityLimit(error, classifierBackend);
  if (capacity) {
    const { backend: _backend, ...reason } = capacity;
    return { suspension: "capacity-limited", reason };
  }
  const transport = isTransportLossError(error)
    ? error.reason
    : classifyTransportLoss(error, classifierBackend);
  if (transport) {
    const { backend: _backend, ...reason } = transport;
    return { suspension: "transport-lost", reason };
  }
  if (!isProviderFailure(error)) return undefined;
  return {
    error: "failed",
    code: `${backend}-failed`,
    message: error instanceof Error ? error.message : String(error),
  };
}

function isProviderFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return (
    typeof value["status"] === "number" ||
    typeof value["statusCode"] === "number" ||
    typeof value["code"] === "string" ||
    typeof value["type"] === "string"
  );
}
