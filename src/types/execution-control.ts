import type { ArcRunId } from "./core.js";
import type { BackendName } from "./worker-slot.js";

/**
 * Serializable description of a provider-capacity failure that parks an Arc run
 * in a recoverable `capacity-limited` state for later resumption.
 */
export type CapacityLimit = {
  /**
   * Which capacity limit the provider reported. The three transient reasons
   * (`api rate limit`, `token rate limit`, `provider overloaded`) recover by
   * waiting and are eligible for automatic retry; `token usage limit` is a hard
   * quota/credit exhaustion that needs a billing action and is never auto-retried.
   *
   * - `api rate limit` — requests-per-minute (RPM) throttling.
   * - `token rate limit` — tokens-per-minute (TPM) throttling.
   * - `token usage limit` — quota or credit-balance exhaustion (hard).
   * - `provider overloaded` — provider-side overload (Anthropic 529), not the
   *   caller's limit.
   */
  reason:
    | "api rate limit"
    | "token rate limit"
    | "token usage limit"
    | "provider overloaded";
  /** Upstream model provider that rejected the call. */
  provider: string;
  /** SDK backend that surfaced the failure. */
  backend: BackendName;
  /** Human-readable diagnostic preserved from the provider error. */
  message: string;
  /** Suggested retry delay in milliseconds, parsed from `retry-after` when present. */
  retryAfterMs?: number;
};

/**
 * Whether a capacity reason recovers by waiting and is therefore eligible for
 * automatic retry. A `token usage limit` (hard quota/credit exhaustion) is not:
 * retrying it only re-blocks until a human resolves billing.
 */
export function isTransientCapacity(reason: CapacityLimit["reason"]): boolean {
  return reason !== "token usage limit";
}

/**
 * Serializable description of a transport loss that parks an Arc run in a
 * recoverable `transport-lost` state for later resumption.
 *
 * A transport loss is a failure of the round-trip to the provider as a whole —
 * the socket, the network, or application-level liveness (the backend's own SDK
 * timeout) — as opposed to a provider-level capacity rejection (`CapacityLimit`).
 * Every transport loss is retryable by waiting and carries no provider
 * `retry-after`, so it has no transient/hard split.
 */
export type TransportLoss = {
  /**
   * Which transport-level failure interrupted the call.
   *
   * - `connection reset` — the socket dropped (`ECONNRESET`, socket hang up).
   * - `network timeout` — the network round-trip failed (`ETIMEDOUT`, DNS
   *   failure, connection refused, a premature/aborted stream close).
   * - `sdk timeout` — the backend's own liveness timeout aborted the call
   *   (`…instruction timed out after <n>ms`).
   */
  reason: "sdk timeout" | "network timeout" | "connection reset";
  /** SDK backend that surfaced the failure. */
  backend: BackendName;
  /** Human-readable diagnostic preserved from the underlying error. */
  message: string;
};

/**
 * Where a paused routine stopped, recorded on the run's execution control and
 * read at resume to choose the continuation mode. `routine-start` parked at the
 * pre-run checkpoint; `in-turn` parked mid-routine at a safe boundary. The
 * literals are persisted in execution-control state, so they keep their names.
 */
export type PausedRoutineOrigin = "routine-start" | "in-turn";

/**
 * Durable execution-control state for one Arc run.
 *
 * Covers cooperative pause and two sibling parks. `capacity-limited` and
 * `transport-lost` are both recoverable, fresh-re-run parks: `capacity-limited`
 * when an upstream provider rejects the call for being out of capacity,
 * `transport-lost` when the round-trip to the provider dies (host sleep, network
 * loss, connection reset, or the backend's own SDK timeout). Each carries the
 * parked routine pointer and a serializable reason. Both are distinct from the
 * Arc host's structural `blocked` run status (a graph waiting on dependencies) —
 * hence the explicit park names.
 */
export type ExecutionControlState =
  | {
      arcRunId: ArcRunId;
      status: "running";
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "pauseRequested";
      requestedAt: string;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "paused";
      requestedAt?: string;
      pausedAt: string;
      pausedRoutineId?: string;
      pausedRoutineOrigin?: PausedRoutineOrigin;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "capacity-limited";
      capacityLimitedAt: string;
      capacityLimitedRoutineId: string;
      capacityReason: CapacityLimit;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "transport-lost";
      transportLostAt: string;
      transportLostRoutineId: string;
      transportReason: TransportLoss;
      updatedAt: string;
    };

/**
 * Automatic-recovery projection carried by a parked control view.
 *
 * `pending` is true when a deferred auto-resume is scheduled; `attempt` and
 * `maxAttempts` bound the consecutive auto-resume streak; `nextAttemptAt` is the
 * scheduled time of the next try when pending. Derived from in-memory retry
 * state, so it reads as not-pending after a process restart even while the
 * durable park status persists.
 */
export type ParkAutoRetry = {
  pending: boolean;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt?: string;
};

/**
 * Stable cross-boundary view of one run's execution-control state, surfaced to
 * connectors and the web UI.
 *
 * Discriminated by `status`. An active run is running, paused, or parked, and
 * a park names what stopped it: a worker raises `capacity-limited` and
 * `transport-lost`, the host raises `uncaught-interruption`, and the hub
 * raises `internal-error` and `hub-restarted`. Inactive executions carry only
 * their run identity; lifecycle takes precedence over retained control state.
 */
export type ExecutionControlView =
  | {
      status: "inactive";
      arcRunId: ArcRunId;
    }
  | {
      arcRunId: ArcRunId;
      status: "running";
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "pauseRequested";
      requestedAt: string;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "paused";
      requestedAt?: string;
      pausedAt: string;
      pausedRoutineId?: string;
      pausedRoutineOrigin?: PausedRoutineOrigin;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "capacity-limited";
      capacityLimitedAt: string;
      capacityLimitedRoutineId: string;
      capacityReason: CapacityLimit;
      autoRetry?: ParkAutoRetry;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "transport-lost";
      transportLostAt: string;
      transportLostRoutineId: string;
      transportReason: TransportLoss;
      autoRetry?: ParkAutoRetry;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "internal-error";
      error: { message: string };
      failedAt: string;
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "uncaught-interruption";
      interruption: { id: string; reason: string };
      updatedAt: string;
    }
  | {
      arcRunId: ArcRunId;
      status: "hub-restarted";
      updatedAt: string;
    };
