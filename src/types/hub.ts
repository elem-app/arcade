import type { ArcRunId } from "./core.js";
import type { ExecutionControlView } from "./execution-control.js";
import type { JsonValue } from "./json.js";
import type { OutboundMessage } from "./messaging.js";
import type {
  RoutineContext,
  RoutineEffects,
  RoutineReport,
} from "./routine.js";
import type { Task } from "./task.js";
import type { WorkEvent } from "./work-event.js";
import type { BackendName } from "./worker-slot.js";

/** Connector-owned callback registered for hub outbound dispatch. */
export type OutboundMessageHandler = (
  message: OutboundMessage,
) => Promise<void> | void;

/**
 * Runs after persistence; may read available views/history and enqueue local
 * work. Return promptly so publication can finish.
 */
export type WorkEventHandler = (event: WorkEvent) => Promise<void> | void;

/**
 * Hub-side outcome of one dispatched task, returned by `handleTask`.
 *
 * - `finished` — the hub ran a worker; `report` describes whatever the worker
 *   said (which may itself be a success, a deflection, or a failure).
 *   `routineId` identifies the persisted routine and its work events.
 * - `queued` — the underlying routine is retained after an interrupt or hub
 *   pause; `routineId` is the hub's handle for later lookup via
 *   `WorkerHubService.getRoutine`.
 * - `skipped` — the worker reported unavailable work or its frontier was
 *   superseded. No coverage is recorded for the skipped task.
 */
export type TaskResult =
  | { status: "finished"; routineId: string; report: RoutineReport }
  | { status: "queued"; routineId: string }
  | { status: "skipped"; error: { code: string; message: string } };

/** Worker used by `WorkerHubService` for in-process routines. */
export type RoleWorker = (
  task: Task,
  context: RoutineContext,
  effects: RoutineEffects,
) => Promise<RoutineReport>;

/** Durable hub routine state. */
export type RoutineState = {
  /** Routine id allocated by `WorkerHubService`. */
  id: string;
  /** Role that owns the routine. */
  role: string;
  /** Registered backend selected for this routine. */
  backend: BackendName;
  /** Arc run associated with the routine. */
  arcRunId: ArcRunId;
  /** Current durable routine status. */
  status:
    | "running"
    | "paused"
    | "capacity-limited"
    | "transport-lost"
    | "finished"
    | "skipped";
  /** Task that this routine carries out. */
  task: Task;
  /** ISO timestamp for the last persisted update. */
  updatedAt: string;
  /** Optional canonical backend-owned execution evidence. */
  backendDetails?: JsonValue;
  /** Structured failure detail when `status` is `skipped`. */
  error?: { code: string; message: string };
};

/**
 * Result of requesting cooperative pause for one Arc run.
 *
 * `requested` means Arcade accepted the request; the returned control may already
 * be `paused` when no routine was running. `duplicate-request` means a pause was
 * already pending. `not-running` means the run is already paused or parked, so
 * there is nothing to pause. In all three cases `control.status` reports the
 * specific state. `inactive` means the run is completed, deflected, or poisoned.
 * `missing` means no eligible run is known to the host.
 */
export type RequestPauseResult =
  | {
      outcome: "inactive";
      arcRunId: ArcRunId;
    }
  | {
      outcome: "requested";
      control: Extract<
        ExecutionControlView,
        { status: "pauseRequested" | "paused" }
      >;
    }
  | {
      outcome: "duplicate-request";
      control: Extract<ExecutionControlView, { status: "pauseRequested" }>;
    }
  | {
      outcome: "not-running";
      control: Extract<
        ExecutionControlView,
        { status: "paused" | "capacity-limited" | "transport-lost" }
      >;
    }
  | {
      outcome: "missing";
      arcRunId: ArcRunId;
    };

/**
 * Result of resuming one paused or parked Arc run.
 *
 * `resumed` means Arcade restored permission to run and attempted continuation.
 * An already-running settlement may complete before more work is dispatched.
 * `not-paused` means the run was already running. `not-ready` means the paused
 * or parked run has no captured same-process continuation, so nothing advances.
 * `inactive` means the run is completed, deflected, or poisoned.
 * `missing` means no eligible run is known to the host.
 */
export type ResumeResult =
  | {
      outcome: "inactive";
      arcRunId: ArcRunId;
    }
  | {
      outcome: "resumed";
      control: Extract<ExecutionControlView, { status: "running" }>;
    }
  | {
      outcome: "missing";
      arcRunId: ArcRunId;
    }
  | {
      outcome: "not-paused";
      control: Extract<ExecutionControlView, { status: "running" }>;
    }
  | {
      outcome: "not-ready";
      control: Extract<
        ExecutionControlView,
        { status: "paused" | "capacity-limited" | "transport-lost" }
      >;
    };
