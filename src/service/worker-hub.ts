import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import type { ArcRef, Dialog } from "@elem-app/arc/runtime";

import {
  DEFAULT_WORKER_ROLE,
  PERMISSION_APPROVER_AUDIENCE,
  PERMISSION_ASK_CAUSE,
} from "../constants.js";
import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import type { RoutineDiagnosticsStore } from "../storage/base.js";
import {
  type CreateWorkEventInput,
  type HistoryStore,
  type WorkerHubStore,
} from "../storage/base.js";
import type { Backend } from "../types/backend.js";
import type { ArcRunId } from "../types/core.js";
import {
  isTransientCapacity,
  type CapacityLimit,
  type ExecutionControlState,
  type ExecutionControlView,
  type ParkAutoRetry,
  type PausedRoutineOrigin,
  type TransportLoss,
} from "../types/execution-control.js";
import type {
  HandshakeReceipt,
  HandshakeResolution,
} from "../types/handshake.js";
import {
  assertModuleEffect,
  type HostModuleEffect,
} from "../types/host-module.js";
import type {
  AdvanceInput,
  ArcHostStep,
  ArcRunView,
  InstructionCoverage,
  RunFrontier,
} from "../types/host.js";
import type {
  OutboundMessageHandler,
  RequestPauseResult,
  ResumeResult,
  RoleWorker,
  RoutineState,
  TaskResult,
  WorkEventHandler,
} from "../types/hub.js";
import { canonicalizeJsonValue } from "../types/json.js";
import type {
  HistoryEntry,
  InboundAudience,
  InboundLifecycleEvent,
  InboundMessage,
  OutboundMessage,
  OutboundSituation,
} from "../types/messaging.js";
import type {
  PermissionVerdict,
  RoutineContext,
  RoutineDescriptor,
  RoutineDiagnostics,
  RoutineEffects,
  RoutineInput,
  RoutineReport,
  ToolEventInput,
} from "../types/routine.js";
import { taskId, type Task, type TaskDisposition } from "../types/task.js";
import type {
  BlockedEventFields,
  ControlEvent,
  WorkEvent,
} from "../types/work-event.js";
import type { BackendName, RawWorkersConfig } from "../types/worker-slot.js";
import { HotAsyncQueue } from "../utils/hot-async-queue.js";
import { KeyedSerializer } from "../utils/keyed-serializer.js";
import type { ArcHostService, NodeInfo } from "./arc-host.js";
import {
  answerHistoryEntry,
  inboundHistoryEntry,
  projectDialog,
  projectInboundDialog,
} from "./dialog-projection.js";
import { executionControlView, parkedRoutineId } from "./execution-control.js";
import {
  recordSemanticReportDrift,
  validateCompletedSemanticReport,
} from "./semantic-resolver.js";
import { validateRoutineReport } from "./utils.js";
import type { WorkEventService } from "./work-events.js";
import { taskSourceRef, workerContextKey } from "./worker-context.js";
import { WorkerRegistry, type ResolvedWorker } from "./worker-registry.js";

/**
 * Tuning for automatic recovery of capacity-limited runs.
 *
 * A transient capacity park (RPM/TPM throttling or provider overload) schedules
 * a deferred resume; a hard `token usage limit` never auto-retries. Backoff uses
 * the provider `retry-after` when present, else exponential off `baseDelayMs`,
 * clamped to `maxDelayMs`. After `maxAttempts` consecutive auto-resumes the run
 * is left `capacity-limited` for a manual resume.
 */
export type CapacityRetryOptions = {
  /** Whether to auto-resume transient capacity-limited runs. Defaults to `true`. */
  enabled?: boolean;
  /** Consecutive auto-resume attempts before parking for manual resume. Defaults to `6`. */
  maxAttempts?: number;
  /** Backoff base used when the provider gives no `retry-after`. Defaults to `1000`. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff delay. Defaults to `60000`. */
  maxDelayMs?: number;
  /**
   * Schedules a deferred callback and returns a canceller. Defaults to a
   * `setTimeout`-backed scheduler; tests inject a manual one.
   */
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

type ResolvedCapacityRetry = Required<Omit<CapacityRetryOptions, "schedule">> &
  Pick<Required<CapacityRetryOptions>, "schedule">;

/** Constructor options for `WorkerHubService`. */
export type WorkerHubServiceOptions = {
  arcHost: ArcHostService;
  /**
   * Flat per-run history log. Source of truth for conversation history;
   * per-role `Dialog` snapshots are projected on read.
   */
  historyStore: HistoryStore;
  /** Durable store for routine state and handler-visible metadata. */
  routineStore: WorkerHubStore;
  /** Policy-neutral event publisher shared with the arc host. */
  workEvents: WorkEventService;
  /** Durable diagnostics store for provider routine artifacts. */
  routineDiagnosticsStore: RoutineDiagnosticsStore;
  /** Optional logger. Defaults to a silent logger. */
  logger?: ArcadeLogger;
  /** Optional automatic-recovery tuning for capacity-limited runs. */
  capacityRetry?: CapacityRetryOptions;
};

/** One-shot startup input resolved against the registered backend implementations. */
export type WorkerHubStartOptions = {
  workers?: RawWorkersConfig;
};

type Lifecycle =
  | "registering"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "failed";

/** Default deferred scheduler: a `setTimeout` that does not keep the process alive. */
function defaultCapacityRetrySchedule(
  callback: () => void,
  delayMs: number,
): () => void {
  const handle = setTimeout(callback, delayMs);
  (handle as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
}

const MAX_HOST_STEPS_PER_DRAIN = 16;
type QueueEntrypoint = "submit" | "handshake" | "background";
type SubmissionState = {
  channel: HotAsyncQueue<InboundLifecycleEvent>;
  /** Holds owned by handshakes, trigger probes, and in-flight fork dispatches. */
  pending: number;
  triggerProbeIds: Set<ArcRunId>;
  inbound: InboundMessage;
};

type HandshakeSubmission = {
  submissionId: string;
  arcRef: ArcRef;
};

type QueueEvent =
  // `submissionId` correlates a `submitInbound` activation chain to its lifecycle
  // channel across reschedules (the trigger round-trip can cross drains).
  | {
      kind: "connector-inbound";
      message: InboundMessage;
      submissionId?: string;
    }
  | {
      kind: "connector-handshake";
      id: string;
      values: HandshakeResolution;
      clientId?: string;
    }
  | {
      kind: "host-step";
      hostStep: ArcHostStep;
      scope?: FrontierWorkScope;
      dialog: Dialog;
      step: number;
      openedBy?: LapOpener;
      submissionId?: string;
    }
  | {
      kind: "task-results";
      arcRunId: ArcRunId;
      stage: "trigger" | "action";
      scope?: FrontierWorkScope;
      frontier: RunFrontier;
      dialog: Dialog;
      tasks: readonly Task[];
      results: TaskResult[];
      step: number;
      openedBy?: LapOpener;
      submissionId?: string;
    }
  | { kind: "module-effects"; arcRunId: ArcRunId }
  | {
      kind: "connector-outbound";
      message: OutboundMessage;
      scope?: FrontierWorkScope;
    };

type QueueRouteCommand =
  | { kind: "continue" }
  | { kind: "enqueue"; events: QueueEvent[] }
  | { kind: "schedule"; arcRunId: ArcRunId; events: QueueEvent[] }
  | { kind: "handshake-receipt"; receipt: HandshakeReceipt };

type QueueRouteCommands = QueueRouteCommand | QueueRouteCommand[];

/** What put a run's work on its lane, opening the lap. */
type LapOpener = "activation" | "resume" | "continuation";

/** The yield point that closed a lap. */
type LapYieldReason =
  | "awaiting-input"
  | "preempted"
  | "parked"
  | "fanned-out"
  | "terminated";

/** Bookkeeping for the lap a drain currently has open, if any. */
type LapState = {
  arcRunId?: ArcRunId;
  taskResultCount: number;
};

type QueueDrainResult =
  | { kind: "handshake-receipt"; receipt: HandshakeReceipt }
  | { kind: "drained" };

class RoutineBackendUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RoutineBackendUnavailableError";
  }
}

function isRoutineBackendUnavailableError(
  error: unknown,
): error is RoutineBackendUnavailableError {
  return error instanceof RoutineBackendUnavailableError;
}

/**
 * One node in the outbound handler tree. `exact` keys are concrete situation
 * field values; `wildcard` exists when a registration used `"*"` at this
 * dimension. Leaf nodes carry the handler set.
 */
type OutboundHandlerNode = {
  exact: Map<string, OutboundHandlerNode>;
  wildcard?: OutboundHandlerNode;
  handlers?: Set<OutboundMessageHandler>;
};

type OwnedRoutine = {
  scope: FrontierWorkScope;
  routine: RoutineState;
  selected: ResolvedWorker;
  node: NodeInfo;
  active: boolean;
  invocation?: Promise<void>;
  disposal?: Promise<void>;
  skipped?: Promise<TaskResult>;
  controlBeforeSuspension?: ExecutionControlState;
};

type FrontierWorkScope = {
  arcRunId: ArcRunId;
  frontierId: string;
  event?: Extract<QueueEvent, { kind: "host-step" }>;
  superseded: boolean;
  routines: Map<string, OwnedRoutine>;
  invalidatedAskIds: Set<string>;
  cleanup: Promise<void>;
  released: boolean;
  dispatched: boolean;
};

type AskResolverCommon = {
  arcRunId: ArcRunId;
  routineId: string;
  /** Outbound message the ask was dispatched with, read by `listAsks`. */
  outbound: OutboundMessage;
  role: string;
  audience: InboundAudience;
  isOwnerLive: () => boolean;
  scope?: FrontierWorkScope;
  reject: (error: Error) => void;
  release: () => void;
};

type AskResolverEntry =
  | ({
      cause: typeof PERMISSION_ASK_CAUSE;
      resolve: (verdict: PermissionVerdict) => void;
    } & AskResolverCommon)
  | ({
      cause: "question";
      resolve: (answer: InboundMessage) => void;
    } & AskResolverCommon);

type RoutineEffectScope = {
  effects: RoutineEffects;
  dispose(): void;
};

type PausedRoutineContinuation = {
  scope?: FrontierWorkScope;
  routineId: string;
  arcRunId: ArcRunId;
  stage: "trigger" | "action";
  frontier: RunFrontier;
  dialog: Dialog;
  tasks: readonly Task[];
  completedResults: TaskResult[];
  pausedTaskIndex: number;
  selected: ResolvedWorker;
  step: number;
  submissionId?: string;
};

/**
 * Internal worker hub for Arc-derived role work.
 *
 * The hub owns history mutation, Arc host begin/advance ordering for
 * triggering and actioning, worker-slot routing, routine
 * persistence, and connector-owned outbound handler dispatch.
 *
 * A **lap** is one continued execution of a run by the hub. It opens for an
 * activation step, a resume, or the run's own re-queued remainder, and the hub
 * then owns the run exclusively, walking the host and dispatching workers, until a yield
 * point: the frontier rests with nothing left to dispatch, the drain depth
 * bound preempts, a routine parks, the trigger stage fans out, or the run
 * terminates. An in-flight routine keeps the lap open, even while its worker
 * is blocked on a user's answer to an ask (the answer resolves the waiting
 * routine directly, off the run's lane). Active-run attachment is also off-lane
 * and opens no lap. Ownership defines the boundary, not activity. Runs execute one lap at a time, FIFO, on a per-run serializer
 * lane. `worker_hub.lap.*` events bracket each lap, with `openedBy` on the
 * start and `yieldReason` on the finish.
 */
export class WorkerHubService {
  readonly #arcHost: ArcHostService;
  readonly #workScopes = new Map<ArcRunId, FrontierWorkScope>();
  readonly #retiringRoutines = new Set<OwnedRoutine>();
  readonly #workerContexts = new WeakMap<
    ResolvedWorker["worker"],
    KeyedSerializer<string>
  >();
  readonly #taskInvocations = new Set<Promise<void>>();
  readonly #moduleSignals = new WeakSet<AbortSignal>();
  readonly #moduleEffects = new Map<
    ArcRunId,
    {
      effect: HostModuleEffect;
      signal: AbortSignal;
      attemptedFrontierId?: string;
    }[]
  >();
  readonly #laps = new Map<ArcRunId, LapState>();
  readonly #unusableWorkers = new Set<ResolvedWorker["worker"]>();
  readonly #historyStore: HistoryStore;
  readonly #routineStore: WorkerHubStore;
  readonly #workEvents: WorkEventService;
  readonly #routineDiagnosticsStore: RoutineDiagnosticsStore;
  readonly #logger: ArcadeLogger;
  readonly #runSerializer = new KeyedSerializer<string>();
  readonly #handshakeResolutions = new KeyedSerializer<string>();
  readonly #controlMutations = new KeyedSerializer<ArcRunId>();
  readonly #workerRegistry: WorkerRegistry;
  readonly #routineWorkers = new Map<string, ResolvedWorker>();
  #lifecycle: Lifecycle = "registering";
  #startupPromise?: Promise<void>;
  #stopPromise?: Promise<void>;
  /**
   * Three-level lookup tree for outbound handler dispatch: role → audience →
   * cause. Each level has an `exact` map keyed by the literal value and an
   * optional `wildcard` child for registrations whose situation field is
   * `"*"`. Match recursion visits both branches at every level, so an
   * incoming outbound fires every registered handler whose situation
   * matches under exact-or-wildcard semantics on each dimension.
   */
  readonly #outboundRoot: OutboundHandlerNode = { exact: new Map() };
  readonly #askResolvers = new Map<string, AskResolverEntry>();
  readonly #pausedContinuations = new Map<
    ArcRunId,
    PausedRoutineContinuation
  >();
  /**
   * Open submission lifecycle channels keyed by `submissionId`, each with a
   * count of outstanding decision units. A staged handshake owns one unit. The
   * channel stays open across handshake rounds and closes when `pending`
   * reaches zero. In-memory and short-lived — an entry exists only while a
   * submission is unresolved.
   */
  readonly #submissions = new Map<string, SubmissionState>();
  /** Private branch correlation used to settle one handshake hold. */
  readonly #handshakeSubmissions = new Map<string, HandshakeSubmission>();
  readonly #capacityRetry: ResolvedCapacityRetry;
  /**
   * Pending automatic capacity-resume per run. `attempts` counts consecutive
   * auto-resumes (reset by a manual resume, cleared on success); `cancel` stops
   * the in-flight timer. In-memory only, matching the same-process nature of the
   * stored continuation a capacity resume depends on.
   */
  readonly #capacityRetries = new Map<
    ArcRunId,
    { attempts: number; cancel: () => void; nextAttemptAt?: string }
  >();
  /**
   * Process-local causes of host and hub parks: `internal-error`,
   * `uncaught-interruption`, and `hub-restarted`. Admitting a resume clears the
   * first two and records the run as run since start.
   */
  readonly #lapFailures = new Map<
    ArcRunId,
    { message: string; failedAt: string; announced?: boolean }
  >();
  readonly #uncaughtInterruptions = new Map<
    ArcRunId,
    { id: string; reason: string }
  >();
  readonly #runsSinceStart = new Set<ArcRunId>();

  /** Create an unstarted worker hub bound only to hub-owned services. */
  constructor(opts: WorkerHubServiceOptions) {
    this.#arcHost = opts.arcHost;
    this.#historyStore = opts.historyStore;
    this.#routineStore = opts.routineStore;
    this.#workEvents = opts.workEvents;
    this.#routineDiagnosticsStore = opts.routineDiagnosticsStore;
    this.#logger = opts.logger ?? createArcadeLogger();
    this.#workerRegistry = new WorkerRegistry({
      logger: this.#logger,
      stateStore: this.#routineStore,
    });
    const capacityRetry = opts.capacityRetry ?? {};
    this.#capacityRetry = {
      enabled: capacityRetry.enabled ?? true,
      maxAttempts: capacityRetry.maxAttempts ?? 6,
      baseDelayMs: capacityRetry.baseDelayMs ?? 1000,
      maxDelayMs: capacityRetry.maxDelayMs ?? 60000,
      schedule: capacityRetry.schedule ?? defaultCapacityRetrySchedule,
    };
  }

  #scopeFor(
    event: Extract<QueueEvent, { kind: "host-step" }>,
  ): FrontierWorkScope {
    const step = event.hostStep;
    if (step.kind !== "action" && step.kind !== "trigger")
      throw new Error("Only executing frontiers own work scopes.");
    let scope =
      event.scope?.frontierId === step.frontier.frontierId
        ? event.scope
        : this.#workScopes.get(step.arcRunId);
    if (scope?.frontierId !== step.frontier.frontierId || scope?.superseded) {
      if (scope) {
        this.#supersedeFrontier(scope);
        this.#forgetScope(scope);
      }
      scope = undefined;
    }
    if (!scope) {
      scope = {
        arcRunId: step.arcRunId,
        frontierId: step.frontier.frontierId,
        event,
        routines: new Map(),
        invalidatedAskIds: new Set(),
        cleanup: Promise.resolve(),
        released: false,
        superseded: false,
        dispatched: false,
      };
      this.#workScopes.set(scope.arcRunId, scope);
    }
    event.scope = scope;
    scope.event = event;
    return scope;
  }

  /** @internal Inspect retained work without exposing mutable scopes. */
  getLiveWorkCounts(): {
    scopes: number;
    routines: number;
    continuations: number;
  } {
    return {
      scopes: this.#workScopes.size,
      routines: this.#routineWorkers.size,
      continuations: this.#pausedContinuations.size,
    };
  }

  #forgetScope(scope: FrontierWorkScope): void {
    scope.released = true;
    if (this.#workScopes.get(scope.arcRunId) === scope)
      this.#workScopes.delete(scope.arcRunId);
    scope.routines.clear();
    scope.event = undefined;
    scope.cleanup = Promise.resolve();
  }

  /** Completion and failure both relinquish the host session after fencing queued work. */
  async #releaseScope(scope: FrontierWorkScope): Promise<void> {
    if (scope.released) return;
    scope.released = true;
    this.#moduleEffects.delete(scope.arcRunId);
    this.#clearCapacityRetry(scope.arcRunId);
    const continuation = this.#pausedContinuations.get(scope.arcRunId);
    if (continuation?.scope === scope)
      this.#pausedContinuations.delete(scope.arcRunId);
    const askIds: string[] = [];
    for (const [id, entry] of this.#askResolvers) {
      if (entry.scope !== scope) continue;
      this.#askResolvers.delete(id);
      askIds.push(id);
      entry.release();
      entry.reject(new Error(scopeCancellationMessage(scope)));
    }
    this.#publishAskInvalidation(scope, askIds);
    for (const owned of scope.routines.values()) {
      void this.#disposeOwnedRoutine(owned);
    }
    const results = await Promise.allSettled([
      this.#arcHost.releaseAction(scope.arcRunId, scope.frontierId),
      ...[...scope.routines.values()].map((owned) =>
        this.#clearSupersededControl(owned),
      ),
    ]);
    this.#forgetScope(scope);
    for (const result of results) {
      if (result.status === "rejected")
        this.#logger.info("worker_hub.action.release_failed", {
          arcRunId: scope.arcRunId,
          message: String(result.reason),
        });
    }
  }

  #retireAcceptedResults(
    scope: FrontierWorkScope | undefined,
    results: readonly TaskResult[],
  ): void {
    if (!scope) return;
    for (const result of results) {
      if (result.status !== "finished") continue;
      const owned = scope.routines.get(result.routineId);
      if (!owned) continue;
      scope.routines.delete(result.routineId);
      void this.#disposeOwnedRoutine(owned);
    }
  }

  #supersedeFrontier(
    scope: FrontierWorkScope,
    deferPublication = false,
  ): string[] {
    if (scope.released || scope.superseded) return [];
    scope.superseded = true;
    const askIds: string[] = [];
    for (const [askId, entry] of this.#askResolvers) {
      if (entry.scope !== scope) continue;
      this.#askResolvers.delete(askId);
      askIds.push(askId);
      entry.release();
      entry.reject(new Error(scopeCancellationMessage(scope)));
    }
    this.#clearCapacityRetry(scope.arcRunId);
    const continuation = this.#pausedContinuations.get(scope.arcRunId);
    if (continuation?.frontier.frontierId === scope.frontierId)
      this.#pausedContinuations.delete(scope.arcRunId);
    if (!deferPublication) this.#publishAskInvalidation(scope, askIds);
    scope.cleanup = Promise.allSettled(
      [...scope.routines.values()].map(async (owned) => {
        const results = await Promise.allSettled([
          this.#disposeOwnedRoutine(owned),
          this.#clearSupersededControl(owned),
        ]);
        const failures = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        try {
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Routine cleanup failed.",
            );
        } finally {
          if (!owned.active && owned.routine.status !== "skipped")
            await this.#skipSupersededRoutine(owned);
        }
      }),
    ).then((results) => {
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Superseded routine cleanup failed.",
        );
    });
    void scope.cleanup.catch((error: unknown) =>
      this.#logger.info("worker_hub.interruption.cleanup_failed", {
        arcRunId: scope.arcRunId,
        message: String(error),
      }),
    );
    return askIds;
  }

  #publishAskInvalidation(
    scope: FrontierWorkScope,
    askIds: readonly string[],
  ): void {
    const exact = askIds.filter((id) => !scope.invalidatedAskIds.has(id));
    for (const id of exact) scope.invalidatedAskIds.add(id);
    if (!exact.length) return;
    this.#workEvents.publish({
      kind: "asks:invalidated",
      arcRunId: scope.arcRunId,
      askIds: exact,
    });
  }

  #disposeOwnedRoutine(owned: OwnedRoutine): Promise<void> {
    if (owned.disposal) return owned.disposal;
    this.#retiringRoutines.add(owned);
    owned.disposal = (async () => {
      if (owned.invocation) await owned.invocation;
      try {
        await owned.selected.worker.disposeRoutine({
          arcRunId: owned.routine.arcRunId,
          routineId: owned.routine.id,
        });
      } catch (error) {
        this.#unusableWorkers.add(owned.selected.worker);
        throw error;
      } finally {
        this.#routineWorkers.delete(owned.routine.id);
        const continuation = this.#pausedContinuations.get(
          owned.routine.arcRunId,
        );
        if (continuation?.routineId === owned.routine.id)
          this.#pausedContinuations.delete(owned.routine.arcRunId);
      }
    })();
    void owned.disposal.then(
      () => this.#retiringRoutines.delete(owned),
      (error: unknown) => {
        this.#retiringRoutines.delete(owned);
        this.#logger.info("worker_hub.routine.disposal_failed", {
          arcRunId: owned.routine.arcRunId,
          routineId: owned.routine.id,
          message: String(error),
        });
      },
    );
    return owned.disposal;
  }

  #clearSupersededControl(owned: OwnedRoutine): Promise<void> {
    return this.#controlMutations.run(owned.routine.arcRunId, () =>
      this.#clearSupersededControlUnderMutation(owned),
    );
  }

  async #clearSupersededControlUnderMutation(
    owned: OwnedRoutine,
  ): Promise<void> {
    if (!scopeCancelled(owned.scope)) return;
    const control = await this.#executionControlFor(owned.routine.arcRunId);
    const ownerId =
      control.status === "paused"
        ? control.pausedRoutineId
        : parkedRoutineId(control);
    if (ownerId !== owned.routine.id) return;
    const prior = owned.controlBeforeSuspension;
    const manualPause =
      prior?.status === "paused" ||
      prior?.status === "pauseRequested" ||
      (control.status === "paused" && control.requestedAt !== undefined);
    const now = new Date().toISOString();
    await this.#routineStore.putExecutionControl(
      manualPause
        ? {
            arcRunId: owned.routine.arcRunId,
            status: "paused",
            requestedAt:
              prior &&
              (prior.status === "paused" || prior.status === "pauseRequested")
                ? prior.requestedAt
                : control.status === "paused"
                  ? control.requestedAt
                  : undefined,
            pausedAt: now,
            updatedAt: now,
          }
        : {
            arcRunId: owned.routine.arcRunId,
            status: "running",
            updatedAt: now,
          },
    );
  }

  #skipSupersededRoutine(owned: OwnedRoutine): Promise<TaskResult> {
    return (owned.skipped ??= this.#skipRoutine(
      owned.routine,
      owned.node,
      owned.scope.superseded ? "run-interrupted" : "execution-released",
      scopeCancellationMessage(owned.scope),
      owned.selected.backend,
    ));
  }

  /** @internal Host modules enqueue outcomes here; the hub drives their advancement. */
  enqueueModuleEffect(
    arcRunId: ArcRunId,
    effect: HostModuleEffect,
    signal: AbortSignal,
  ): void {
    if (
      signal.aborted ||
      this.#lifecycle === "stopping" ||
      this.#lifecycle === "stopped"
    )
      return;
    assertModuleEffect(effect);
    const pending = this.#moduleEffects.get(arcRunId) ?? [];
    pending.push({
      effect: structuredClone(effect),
      signal,
    });
    this.#moduleEffects.set(arcRunId, pending);
    if (!this.#moduleSignals.has(signal)) {
      this.#moduleSignals.add(signal);
      signal.addEventListener(
        "abort",
        () => {
          const remaining = this.#moduleEffects
            .get(arcRunId)
            ?.filter((item) => !item.signal.aborted);
          if (remaining?.length) this.#moduleEffects.set(arcRunId, remaining);
          else this.#moduleEffects.delete(arcRunId);
        },
        { once: true },
      );
    }
    if (this.#workScopes.has(arcRunId))
      this.#scheduleRun(arcRunId, [{ kind: "module-effects", arcRunId }]);
  }

  async #routeModuleEffects(
    arcRunId: ArcRunId,
    lap: LapState,
  ): Promise<QueueRouteCommands> {
    const scope = this.#workScopes.get(arcRunId);
    const prior = scope?.event;
    const step = prior?.hostStep;
    if (
      !scope ||
      scope.released ||
      !prior ||
      !step ||
      (step.kind !== "action" && step.kind !== "trigger")
    )
      return { kind: "continue" };
    const pending = (this.#moduleEffects.get(arcRunId) ?? []).filter(
      (item) => !item.signal.aborted,
    );
    if (!pending.length) {
      this.#moduleEffects.delete(arcRunId);
      return { kind: "continue" };
    }
    this.#moduleEffects.set(arcRunId, pending);
    if ((await this.#executionControlFor(arcRunId)).status !== "running")
      return { kind: "continue" };
    const index = pending.findIndex(({ effect, attemptedFrontierId }) => {
      if (attemptedFrontierId === step.frontier.frontierId) return false;
      if (step.kind === "trigger") return true;
      const kind = effect.hostCallOutcome.kind;
      return step.frontier.allowedMoves.includes(
        kind === "interruption"
          ? "interrupt"
          : kind === "failure"
            ? "poison"
            : "proceed",
      );
    });
    if (index < 0) return { kind: "continue" };
    const delivery = pending.splice(index, 1)[0]!;
    if (delivery.signal.aborted) return { kind: "continue" };
    const invalidated =
      delivery.effect.hostCallOutcome.kind !== "resolution"
        ? this.#supersedeFrontier(scope, true)
        : [];
    try {
      if (step.kind === "action") {
        const next = await this.#arcHost.advanceAction(
          arcRunId,
          step.frontier.frontierId,
          {
            ...delivery.effect,
            projectDialog: ({ roleId }) =>
              this.#projectedDialog(arcRunId, roleId),
          },
        );
        if (
          next.kind === "action" &&
          next.frontier.frontierId === step.frontier.frontierId
        ) {
          delivery.attemptedFrontierId = step.frontier.frontierId;
          pending.splice(index, 0, delivery);
          if (!scope.superseded)
            return {
              kind: "enqueue",
              events: [{ kind: "module-effects", arcRunId }],
            };
        }
        return {
          kind: "enqueue",
          events: [
            {
              ...prior,
              scope: undefined,
              hostStep: next,
              step: prior.step + 1,
            },
          ],
        };
      }
      const inbound =
        prior.submissionId &&
        this.#submissions.get(prior.submissionId)?.inbound;
      if (!inbound) return { kind: "continue" };
      const steps = await this.#arcHost.advanceTrigger(arcRunId, prior.dialog, {
        ...delivery.effect,
        projectDialog: async (view) => projectInboundDialog(inbound, view),
      });
      const only = steps.length === 1 ? steps[0] : undefined;
      if (only?.kind === "trigger") {
        if (
          only.frontier.frontierId === step.frontier.frontierId &&
          !scope.superseded
        ) {
          delivery.attemptedFrontierId = step.frontier.frontierId;
          pending.splice(index, 0, delivery);
          return {
            kind: "enqueue",
            events: [{ kind: "module-effects", arcRunId }],
          };
        }
        return {
          kind: "enqueue",
          events: [
            {
              ...prior,
              scope: undefined,
              hostStep: only,
              step: prior.step + 1,
            },
          ],
        };
      }
      this.#supersedeFrontier(scope);
      this.#forgetScope(scope);
      const submission =
        prior.submissionId && this.#submissions.get(prior.submissionId);
      if (submission && submission.triggerProbeIds.delete(arcRunId))
        submission.pending = Math.max(0, submission.pending - 1);
      this.#finishLap(lap, "activated", "fanned-out");
      return this.#dispatchForkSteps(steps, inbound, prior.submissionId);
    } finally {
      this.#publishAskInvalidation(scope, invalidated);
    }
  }

  /** Register one trusted backend implementation before startup begins. */
  addBackend(name: BackendName, backend: Backend): void {
    if (this.#lifecycle !== "registering") {
      throw new Error(
        `Cannot register backend ${JSON.stringify(name)} while worker hub is ${this.#lifecycle}.`,
      );
    }
    this.#workerRegistry.addBackend(name, backend);
  }

  /** Create configured workers, then announce restored restart parks. */
  start(options: WorkerHubStartOptions = {}): Promise<void> {
    if (this.#lifecycle !== "registering") {
      throw new Error(`Worker hub cannot start while ${this.#lifecycle}.`);
    }
    this.#lifecycle = "starting";

    let startup: Promise<void>;
    try {
      startup = this.#workerRegistry.start(options.workers ?? {});
    } catch (error) {
      this.#lifecycle = "failed";
      throw error;
    }
    if (this.#workerRegistry.started) this.#lifecycle = "started";
    this.#startupPromise = startup.then(
      () => {
        this.#lifecycle = "started";
        void this.#announceRestartParks().catch((error: unknown) => {
          try {
            this.#logger.info(
              "worker_hub.work_event.restart_announcement_failed",
              { message: String(error) },
            );
          } catch {
            /* Optional startup observations cannot affect readiness. */
          }
        });
      },
      (error: unknown) => {
        this.#lifecycle = "failed";
        throw error;
      },
    );
    return this.#startupPromise;
  }

  /** Announce restored active runs once at startup; control reads stay pure. */
  async #announceRestartParks(): Promise<void> {
    for (const run of await this.#arcHost.listRunViews()) {
      if (this.#lifecycle !== "started") return;
      if (run.stage === "actioning" && run.lifecycle === "active")
        this.#emitParkedControl(
          {
            kind: "control:parked",
            arcRunId: run.arcRunId,
            status: "hub-restarted",
          },
          () => !this.#runsSinceStart.has(run.arcRunId),
        );
    }
  }

  /** Stop every created worker in reverse order and aggregate cleanup failures. */
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = this.#stopAllWorkers();
    return this.#stopPromise;
  }

  async #stopAllWorkers(): Promise<void> {
    if (this.#lifecycle === "starting" || this.#lifecycle === "started") {
      try {
        await this.#startupPromise;
      } catch {
        if (!this.#workerRegistry.started) return;
      }
    }
    if (this.#lifecycle === "stopped" || this.#lifecycle === "failed") return;
    this.#lifecycle = "stopping";
    this.#moduleEffects.clear();
    for (const retry of this.#capacityRetries.values()) retry.cancel();
    this.#capacityRetries.clear();
    this.#rejectAllAsks(
      new Error("Worker hub stopped before the ask resolved."),
    );
    const releases = [...this.#workScopes.values()].map((scope) =>
      this.#releaseScope(scope),
    );
    try {
      await this.#workerRegistry.stop();
    } finally {
      await Promise.all(releases);
      await Promise.allSettled([...this.#taskInvocations]);
      await Promise.allSettled(
        [...this.#retiringRoutines].map((owned) => owned.disposal),
      );
      this.#workScopes.clear();
      this.#pausedContinuations.clear();
      this.#routineWorkers.clear();
      this.#lifecycle = "stopped";
    }
  }

  /**
   * Opaque connector-supplied principal recorded as the owner of a run, when
   * one exists. Returns `undefined` if the run is unknown.
   */
  async getRunOwnerPrincipal(arcRunId: string): Promise<string | undefined> {
    this.#assertStarted();
    const view = await this.#arcHost.getRunView(arcRunId);
    return view?.ownerPrincipal;
  }

  /**
   * Submit an inbound connector message; returns the submission's lifecycle
   * channel.
   *
   * Routing runs asynchronously on internal drains, so the channel is returned
   * immediately and matched arcs are activated, gated, or rejected whether or not
   * the caller consumes it. The channel emits branch decisions and per-routine
   * trigger failures, and closes once nothing is outstanding. A
   * `handshake-required` keeps it open until resolved (via `handshake`), whose
   * follow-on events land on the same channel. A reported trigger failure emits
   * `failed` for each failed routine and settles only its probe. Infrastructure
   * and internal consistency exceptions fail the channel on initial or resumed
   * execution. See `InboundLifecycleEvent` for per-event semantics and ordering.
   */
  submitInbound(message: InboundMessage): AsyncIterable<InboundLifecycleEvent> {
    this.#assertStarted();
    this.#logger.info("worker_hub.inbound.received", {
      domain: "messaging",
      arcRunId: message.arcRunId,
      audience: message.audience?.name,
    });
    const submissionId = `submission:${randomUUID()}`;
    const channel = new HotAsyncQueue<InboundLifecycleEvent>();
    const submission: SubmissionState = {
      channel,
      pending: 0,
      triggerProbeIds: new Set(),
      inbound: message,
    };
    this.#submissions.set(submissionId, submission);
    // Return the channel now and run the drain asynchronously, so matched arcs
    // are scheduled whether or not the channel is consumed. The channel stays
    // open across handshake rounds and closes when nothing is outstanding (see
    // `#dispatchForkSteps` / `#routeConnectorHandshakeEvent`).
    void this.#drainQueue(
      [{ kind: "connector-inbound", message, submissionId }],
      "submit",
    ).catch((error: unknown) => {
      this.#failSubmissionChannel(submissionId, submission, error);
    });
    return channel;
  }

  #submissionChannel(
    submissionId: string | undefined,
  ): HotAsyncQueue<InboundLifecycleEvent> | undefined {
    return submissionId === undefined
      ? undefined
      : this.#submissions.get(submissionId)?.channel;
  }

  /** Push a `handshake-required` event and correlate the handshake to its channel. */
  #pushHandshakeRequired(
    submissionId: string | undefined,
    step: Extract<ArcHostStep, { kind: "handshake" }>,
  ): void {
    if (submissionId === undefined) return;
    const state = this.#submissions.get(submissionId);
    if (!state) return;
    state.channel.push({
      kind: "handshake-required",
      arcRunId: step.arcRunId,
      handshakeId: step.handshakeId,
      arcRef: step.arcRef,
      requirement: step.requirement,
    });
    this.#handshakeSubmissions.set(step.handshakeId, {
      submissionId,
      arcRef: step.arcRef,
    });
    state.pending += 1;
  }

  /**
   * Dispatch one arc host step from a fork. `handshake`/`rejected` push their
   * channel event; an `action` birth announces `activated` and schedules the run
   * on its own background drain; a `trigger` step schedules without announcing —
   * the fork it settles into announces. Only ever called from `#dispatchForkSteps`
   * (every fork is an activation), so an action birth here is always an
   * activation; continuations schedule host-steps directly and never announce.
   * Does NOT close the submission — the caller closes once, after the whole fork
   * is dispatched, so early activations don't close it before later steps push.
   */
  #dispatchStep(
    step: ArcHostStep,
    dialog: Dialog,
    submissionId: string | undefined,
  ): QueueRouteCommand {
    const channel = this.#submissionChannel(submissionId);
    if (step.kind === "handshake") {
      this.#pushHandshakeRequired(submissionId, step);
      return { kind: "continue" };
    }
    if (step.kind === "rejected") {
      channel?.push({
        kind: "rejected",
        reason: step.reason,
        arcRef: step.arcRef,
      });
      return { kind: "continue" };
    }
    // An `action` step from a fork is an activation → announce here (its
    // continuations schedule host-steps directly and don't re-announce). A
    // `trigger` step is not an activation yet → the fork it settles into does.
    if (step.kind === "action") {
      this.#runsSinceStart.add(step.arcRunId);
      channel?.push({
        kind: "activated",
        arcRunId: step.arcRunId,
        reactivationCount: step.reactivationCount,
      });
    }
    return {
      kind: "schedule",
      arcRunId: step.arcRunId,
      events: [
        {
          kind: "host-step",
          hostStep: step,
          dialog,
          step: 0,
          openedBy: "activation",
          submissionId: step.kind === "trigger" ? submissionId : undefined,
        },
      ],
    };
  }

  /**
   * Dispatch a fork's steps. Each `action` step records the held inbound into its
   * (new) run before scheduling; `trigger` steps keep the submission open while
   * they resolve. Every fork is an activation, so action births announce
   * `activated`. A dispatch hold keeps the channel open until all outcomes are
   * delivered and continuing branches own their holds.
   */
  async #dispatchForkSteps(
    steps: readonly ArcHostStep[],
    inbound: InboundMessage,
    submissionId: string | undefined,
  ): Promise<QueueRouteCommands> {
    const commands: QueueRouteCommand[] = [];
    const submission =
      submissionId === undefined
        ? undefined
        : this.#submissions.get(submissionId);
    if (submission) submission.pending += 1;
    try {
      for (const step of steps) {
        if (
          step.kind === "trigger" &&
          submission &&
          !submission.triggerProbeIds.has(step.arcRunId)
        ) {
          submission.triggerProbeIds.add(step.arcRunId);
          submission.pending += 1;
        }
        const dialog =
          step.kind === "action"
            ? await this.#recordInboundAndProject(step.arcRunId, inbound)
            : projectInboundDialog(inbound, { roleId: DEFAULT_WORKER_ROLE });
        commands.push(this.#dispatchStep(step, dialog, submissionId));
      }
    } catch (error) {
      // Fail before asynchronous cleanup or hold release lets a sibling finish.
      if (submissionId !== undefined && submission)
        this.#failSubmissionChannel(submissionId, submission, error);
      await Promise.all(
        steps.map((step) =>
          step.kind === "action"
            ? this.#arcHost.releaseAction(
                step.arcRunId,
                step.frontier.frontierId,
              )
            : undefined,
        ),
      );
      throw error;
    } finally {
      if (submission) submission.pending -= 1;
    }
    this.#closeSubmissionIfIdle(submissionId);
    return commands.length > 0 ? commands : { kind: "continue" };
  }

  /** Close the channel and drop submission state when nothing is outstanding. */
  #closeSubmissionIfIdle(submissionId: string | undefined): void {
    if (submissionId === undefined) return;
    const state = this.#submissions.get(submissionId);
    if (!state || state.pending > 0) return;
    state.channel.close();
    this.#submissions.delete(submissionId);
  }

  /** Drop one unusable submission channel without mutating arc host work. */
  #failSubmissionChannel(
    submissionId: string,
    submission: SubmissionState,
    error: unknown,
  ): void {
    if (this.#submissions.get(submissionId) !== submission) return;
    this.#releaseSubmission(submissionId, submission);
    submission.channel.fail(error);
  }

  #releaseSubmission(submissionId: string, submission: SubmissionState): void {
    this.#submissions.delete(submissionId);
    for (const probeId of submission.triggerProbeIds) {
      const continuation = this.#pausedContinuations.get(probeId);
      if (continuation) this.#routineWorkers.delete(continuation.routineId);
      this.#pausedContinuations.delete(probeId);
      this.#clearCapacityRetry(probeId);
    }
    for (const [handshakeId, correlation] of this.#handshakeSubmissions) {
      if (correlation.submissionId === submissionId) {
        this.#handshakeSubmissions.delete(handshakeId);
      }
    }
  }

  #ownsTriggerProbe(
    submissionId: string | undefined,
    arcRunId: ArcRunId,
  ): boolean {
    return (
      submissionId === undefined ||
      this.#submissions.get(submissionId)?.triggerProbeIds.has(arcRunId) ===
        true
    );
  }

  #ownsContinuation(
    continuation: PausedRoutineContinuation | undefined,
  ): boolean {
    return (
      continuation?.stage !== "trigger" ||
      this.#ownsTriggerProbe(continuation.submissionId, continuation.arcRunId)
    );
  }

  #failContinuation(
    continuation: PausedRoutineContinuation | undefined,
    error: unknown,
  ): void {
    if (
      continuation?.stage !== "trigger" ||
      continuation.submissionId === undefined
    )
      return;
    const submission = this.#submissions.get(continuation.submissionId);
    if (submission)
      this.#failSubmissionChannel(continuation.submissionId, submission, error);
  }

  /** Unconditionally close a submission (terminal-immediate paths: idle/rejected/targeted). */
  #closeSubmission(submissionId: string | undefined): void {
    if (submissionId === undefined) return;
    this.#submissions.get(submissionId)?.channel.close();
    this.#submissions.delete(submissionId);
  }

  /**
   * Resolve a pending activation handshake through the regular queue path.
   * A decline settles its branch with a rejection on the originating channel.
   */
  async handshake(
    id: string,
    values: HandshakeResolution,
    clientId?: string,
  ): Promise<HandshakeReceipt> {
    return this.#handshakeResolutions.run(id, async () => {
      this.#assertStarted();
      const correlation = this.#handshakeSubmissions.get(id);
      const submission = correlation
        ? this.#submissions.get(correlation.submissionId)
        : undefined;
      let result: QueueDrainResult;
      try {
        result = await this.#drainQueue(
          [{ kind: "connector-handshake", id, values, clientId }],
          "handshake",
        );
      } catch (error) {
        if (correlation && submission) {
          this.#failSubmissionChannel(
            correlation.submissionId,
            submission,
            error,
          );
        }
        throw error;
      }
      if (result.kind !== "handshake-receipt") {
        throw new Error(
          "handshake queue returned without a handshake receipt.",
        );
      }
      return result.receipt;
    });
  }

  #scheduleRun(arcRunId: ArcRunId, events: QueueEvent[]): void {
    void this.#run(arcRunId, () =>
      this.#drainQueue(events, "background"),
    ).catch((error: unknown) => {
      for (const event of events) {
        if (!("submissionId" in event) || event.submissionId === undefined)
          continue;
        const submission = this.#submissions.get(event.submissionId);
        if (submission)
          this.#failSubmissionChannel(event.submissionId, submission, error);
      }
      this.#logger.info("worker_hub.lap.failed", {
        arcRunId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #run<T>(arcRunId: string, task: () => Promise<T>): Promise<T> {
    return this.#runSerializer.run(arcRunId, async () => {
      try {
        return await task();
      } catch (error) {
        const scope = this.#workScopes.get(arcRunId);
        await this.#recordLapFailure(arcRunId, error, scope);
        throw error;
      }
    });
  }

  /** Retain the first failure, release its work, and announce the resulting park. */
  async #recordLapFailure(
    arcRunId: ArcRunId,
    error: unknown,
    scope?: FrontierWorkScope,
  ): Promise<void> {
    const failure = this.#lapFailures.get(arcRunId) ?? {
      message: error instanceof Error ? error.message : String(error),
      failedAt: new Date().toISOString(),
      announced: false,
    };
    this.#lapFailures.set(arcRunId, failure);
    if (scope) await this.#releaseScope(scope);
    if (failure.announced || this.#lifecycle !== "started") return;
    failure.announced = true;
    this.#emitParkedControl(
      {
        kind: "control:parked",
        arcRunId,
        status: "internal-error",
        error: { message: failure.message },
        failedAt: failure.failedAt,
      },
      () => this.#lapFailures.get(arcRunId) === failure,
    );
  }

  async #drainQueue(
    initialEvents: QueueEvent[],
    entrypoint: QueueEntrypoint,
  ): Promise<QueueDrainResult> {
    const queue = [...initialEvents];
    const first = initialEvents[0];
    const runId =
      first &&
      ("arcRunId" in first
        ? first.arcRunId
        : first.kind === "host-step" && "arcRunId" in first.hostStep
          ? first.hostStep.arcRunId
          : undefined);
    const lap: LapState = (runId && this.#laps.get(runId)) || {
      taskResultCount: 0,
    };
    if (runId) this.#laps.set(runId, lap);
    let result: QueueDrainResult | undefined;
    while (queue.length > 0) {
      const event = queue.shift();
      if (!event) break;
      const commands = await this.#routeQueueEvent(event, lap, entrypoint);
      for (const command of queueRouteCommands(commands)) {
        const commandResult = this.#applyQueueRouteCommand(command, queue);
        if (!commandResult) continue;
        if (result) {
          throw new Error(
            `${entrypoint} queue produced multiple public receipts.`,
          );
        }
        this.#assertReceiptAllowed(entrypoint, commandResult);
        result = commandResult;
      }
      if (!result) continue;
      if (queue.length === 0) return result;
      // Public receipts may be emitted only after this foreground drain has no
      // unrouted work left. Long-running continuations must first be moved to a
      // per-run background drain via a `schedule` command.
      throw new Error(
        `${entrypoint} queue produced a public receipt with ${queue.length} unrouted event(s).`,
      );
    }
    // A `submit` drain carries its outcome on the submission channel, not a
    // scalar receipt, so it simply drains like a background drain.
    if (entrypoint === "handshake") {
      throw new Error("handshake queue completed without a handshake receipt.");
    }
    return { kind: "drained" };
  }

  #applyQueueRouteCommand(
    command: QueueRouteCommand,
    queue: QueueEvent[],
  ): QueueDrainResult | undefined {
    if (command.kind === "continue") return undefined;
    if (command.kind === "enqueue") {
      queue.push(...command.events);
      return undefined;
    }
    if (command.kind === "schedule") {
      this.#scheduleRun(command.arcRunId, command.events);
      return undefined;
    }
    return command;
  }

  #assertReceiptAllowed(
    entrypoint: QueueEntrypoint,
    result: QueueDrainResult,
  ): void {
    if (result.kind === "handshake-receipt" && entrypoint === "handshake") {
      return;
    }
    throw new Error(`${entrypoint} queue produced unexpected ${result.kind}.`);
  }

  async #routeQueueEvent(
    event: QueueEvent,
    lap: LapState,
    entrypoint: QueueEntrypoint,
  ): Promise<QueueRouteCommands> {
    if ("scope" in event && event.scope?.released) return { kind: "continue" };
    if (event.kind === "connector-inbound") {
      return this.#routeConnectorInboundEvent(
        event.message,
        event.submissionId,
      );
    }
    if (event.kind === "connector-handshake") {
      return this.#routeConnectorHandshakeEvent(event);
    }
    if (event.kind === "host-step") {
      return this.#routeHostStepEvent(event, lap, entrypoint);
    }
    if (event.kind === "task-results") {
      return this.#routeTaskResultsEvent(event, lap, entrypoint);
    }
    if (event.kind === "module-effects")
      return this.#routeModuleEffects(event.arcRunId, lap);
    await this.#emitNow(event.message, event.scope);
    return { kind: "continue" };
  }

  async #routeConnectorInboundEvent(
    message: InboundMessage,
    submissionId: string | undefined,
  ): Promise<QueueRouteCommands> {
    const channel = this.#submissionChannel(submissionId);
    if (message.arcRunId !== undefined) {
      const arcRunId = message.arcRunId;
      const askId = readAskIdFromMetadata(message.metadata);
      if (askId === undefined) {
        this.#rejectInbound(
          channel,
          "Targeted inbound requires a non-empty metadata.askId for a live ask.",
          { arcRunId, reason: "missing-or-malformed-ask-id" },
        );
        this.#closeSubmission(submissionId);
        return { kind: "continue" };
      }
      const settlement = await this.#settleAskAnswer(arcRunId, askId, message);
      if (settlement === "settled") {
        channel?.push({ kind: "continued", arcRunId });
      } else {
        const invalid = settlement === "invalid";
        this.#rejectInbound(
          channel,
          invalid
            ? "The answer payload is invalid for that live ask."
            : "No live ask matches that Arc run and metadata.askId.",
          {
            arcRunId,
            askId,
            reason: invalid
              ? "invalid-answer-payload"
              : "missing-stale-or-wrong-run-ask",
          },
        );
      }
      this.#closeSubmission(submissionId);
      return { kind: "continue" };
    }

    if (hasReservedAnswerCorrelationMetadata(message.metadata)) {
      this.#rejectInbound(
        channel,
        "Free inbound cannot carry answer-correlation metadata.",
        { reason: "unsupported-answer-correlation" },
      );
      this.#closeSubmission(submissionId);
      return { kind: "continue" };
    }

    const principal =
      typeof message.metadata?.["principal"] === "string"
        ? message.metadata["principal"]
        : undefined;
    if (principal === undefined) {
      this.#logger.info("worker_hub.inbound.rejected", {
        domain: "messaging",
        reason: "missing-principal",
      });
      channel?.push({
        kind: "rejected",
        reason: "Inbound activation requires metadata.principal.",
      });
      this.#closeSubmission(submissionId);
      return { kind: "continue" };
    }
    const clientId =
      typeof message.metadata?.["clientId"] === "string"
        ? message.metadata["clientId"]
        : undefined;
    const rawPolicy = message.metadata?.["activationPolicy"];
    const activationPolicy =
      rawPolicy === "all" || rawPolicy === "choose" || rawPolicy === "first"
        ? rawPolicy
        : undefined;
    const steps = await this.#arcHost.begin({
      dialog: projectInboundDialog(message, { roleId: DEFAULT_WORKER_ROLE }),
      inbound: message,
      clientId,
      principal,
      activationPolicy,
      // Activation settles before the inbound is committed to the history
      // store, so the projector closes over the held inbound rather than
      // reading the (still-empty) run history.
      projectDialog: async (view) => projectInboundDialog(message, view),
    });

    return this.#dispatchForkSteps(steps, message, submissionId);
  }

  async #routeConnectorHandshakeEvent(
    event: Extract<QueueEvent, { kind: "connector-handshake" }>,
  ): Promise<QueueRouteCommands> {
    const correlation = this.#handshakeSubmissions.get(event.id);
    if (!correlation) {
      return { kind: "handshake-receipt", receipt: { status: "missing" } };
    }
    const { submissionId, arcRef } = correlation;
    const submission = this.#submissions.get(submissionId);
    if (!submission) {
      this.#handshakeSubmissions.delete(event.id);
      throw new Error(
        `Submission ${submissionId} for handshake ${event.id} is missing.`,
      );
    }
    if (submission.pending <= 0) {
      const error = new Error(
        `Submission ${submissionId} has no pending decision for handshake ${event.id}.`,
      );
      this.#failSubmissionChannel(submissionId, submission, error);
      throw error;
    }

    const result = await this.#arcHost.resolveHandshake(
      event.id,
      event.values,
      {
        clientId: event.clientId,
        projectDialog: async (view) =>
          projectInboundDialog(submission.inbound, view),
      },
    );
    if (
      this.#handshakeSubmissions.get(event.id) !== correlation ||
      this.#submissions.get(submissionId) !== submission
    ) {
      throw new Error(
        `Submission ${submissionId} changed while handshake ${event.id} was resolving.`,
      );
    }

    if (result.status === "missing") {
      this.#handshakeSubmissions.delete(event.id);
      submission.pending -= 1;
      this.#closeSubmissionIfIdle(submissionId);
      return { kind: "handshake-receipt", receipt: { status: "missing" } };
    }
    if (result.status === "invalid") {
      // The handshake is still pending; leave its correlation in place.
      return {
        kind: "handshake-receipt",
        receipt: result,
      };
    }

    // Resolved: the handshake correlation is spent. Its decision unit is
    // released after its authoritative lifecycle outcome is published.
    this.#handshakeSubmissions.delete(event.id);
    const okReceipt: QueueRouteCommand = {
      kind: "handshake-receipt",
      receipt: { status: "ok" },
    };

    if (result.status === "joined") {
      this.#appendWorkEvent(() => ({
        kind: "run:started",
        route: "join",
        arcRunId: result.arcRunId,
      }));
      submission.channel.push({
        kind: "joined",
        arcRunId: result.arcRunId,
        reactivationCount: result.reactivationCount,
        arcRef,
      });
      submission.pending -= 1;
      this.#closeSubmissionIfIdle(submissionId);
      try {
        this.#logInboundAccepted(result.arcRunId, submission.inbound);
      } catch {
        // Accepted logging is best-effort after authoritative attachment.
      }
      return okReceipt;
    }

    // status === "ok": one step — a fresh `action`, a next-round `handshake`, or
    // a semantic rejection. Dispatch it like a single-step fork.

    const forkCommands = await this.#dispatchForkSteps(
      [result.step],
      submission.inbound,
      submissionId,
    );
    submission.pending -= 1;
    this.#closeSubmissionIfIdle(submissionId);
    return [
      ...(Array.isArray(forkCommands) ? forkCommands : [forkCommands]),
      okReceipt,
    ];
  }

  async #routeHostStepEvent(
    event: Extract<QueueEvent, { kind: "host-step" }>,
    lap: LapState,
    entrypoint: QueueEntrypoint,
  ): Promise<QueueRouteCommands> {
    void entrypoint;
    const step = event.hostStep;
    // Only run-bearing steps are ever scheduled as host-steps.
    if (step.kind !== "action" && step.kind !== "trigger") {
      return { kind: "continue" };
    }
    const { arcRunId, frontier } = step;
    if (
      step.kind === "trigger" &&
      !this.#ownsTriggerProbe(event.submissionId, arcRunId)
    ) {
      return { kind: "continue" };
    }
    if (!lap.arcRunId) {
      this.#logger.info("worker_hub.lap.started", {
        arcRunId,
        openedBy: event.openedBy ?? "activation",
      });
      lap.arcRunId = arcRunId;
    }
    if (event.step >= MAX_HOST_STEPS_PER_DRAIN) {
      // Depth bound: yield the run's lane, re-queuing the carried frontier
      // verbatim behind anything scheduled for this run in the meantime.
      return this.#acceptFrontier(arcRunId, lap, "preempted", frontier, [
        { ...event, step: 0, openedBy: "continuation" },
      ]);
    }

    if (step.kind === "action" && !frontier.canProgress) {
      if (frontier.interruption)
        this.#uncaughtInterruptions.set(arcRunId, frontier.interruption);
      // Every other handback leaves the active lifecycle, where no park applies.
      else this.#runsSinceStart.delete(arcRunId);
      const scope = event.scope ?? this.#workScopes.get(arcRunId);
      if (scope) await this.#releaseScope(scope);
      else await this.#arcHost.releaseAction(arcRunId, frontier.frontierId);
      if (frontier.interruption) {
        // The host handback precedes hub settlement. Publish only once reads
        // expose the park; a concurrent pause can instead own control.
        const interruption = frontier.interruption;
        this.#emitParkedControl(
          {
            kind: "control:parked",
            arcRunId,
            status: "uncaught-interruption",
            interruption,
          },
          () => this.#uncaughtInterruptions.get(arcRunId) === interruption,
        );
      }
      return this.#acceptFrontier(
        arcRunId,
        lap,
        restYieldReason(frontier),
        frontier,
      );
    }
    const workScope = this.#scopeFor(event);
    if (this.#moduleEffects.get(arcRunId)?.length)
      this.#scheduleRun(arcRunId, [{ kind: "module-effects", arcRunId }]);
    const tasks = this.#dedupeTasks(frontier.tasks);
    if (tasks.length === 0)
      return this.#acceptFrontier(
        arcRunId,
        lap,
        restYieldReason(frontier),
        frontier,
      );
    if (workScope?.dispatched) return { kind: "continue" };
    if (workScope) workScope.dispatched = true;
    const invocation = this.#handleTasks(tasks, workScope).then(
      (results) => {
        this.#scheduleRun(arcRunId, [
          {
            kind: "task-results",
            arcRunId,
            stage: step.kind,
            frontier,
            scope: workScope,
            dialog: event.dialog,
            tasks,
            results,
            step: event.step,
            submissionId: event.submissionId,
          },
        ]);
      },
      async (error: unknown) => {
        await this.#recordLapFailure(arcRunId, error, workScope);
        if (event.submissionId) {
          const submission = this.#submissions.get(event.submissionId);
          if (submission)
            this.#failSubmissionChannel(event.submissionId, submission, error);
        }
        this.#logger.info("worker_hub.lap.failed", {
          arcRunId,
          message: String(error),
        });
      },
    );
    this.#taskInvocations.add(invocation);
    void invocation.then(
      () => this.#taskInvocations.delete(invocation),
      () => this.#taskInvocations.delete(invocation),
    );
    return { kind: "continue" };
  }

  async #routeTaskResultsEvent(
    event: Extract<QueueEvent, { kind: "task-results" }>,
    lap: LapState,
    entrypoint: QueueEntrypoint,
  ): Promise<QueueRouteCommands> {
    void entrypoint;
    if (
      event.stage === "trigger" &&
      !this.#ownsTriggerProbe(event.submissionId, event.arcRunId)
    ) {
      this.#clearCapacityRetry(event.arcRunId);
      for (const result of event.results) {
        if (result.status === "queued")
          this.#routineWorkers.delete(result.routineId);
      }
      return { kind: "continue" };
    }
    if (!lap.arcRunId) {
      // A drain opens on task-results only via a park-resume continuation.
      this.#logger.info("worker_hub.lap.started", {
        arcRunId: event.arcRunId,
        openedBy: event.openedBy ?? "resume",
      });
      lap.arcRunId = event.arcRunId;
    }
    const workScope = event.scope;
    if (workScope && scopeCancelled(workScope)) return { kind: "continue" };
    const hasFailedResult = event.results.some(
      (result) =>
        result.status === "finished" && result.report.error === "failed",
    );
    if (
      !hasFailedResult &&
      event.results.some((result) => result.status === "queued")
    ) {
      const pausedTaskIndex = event.results.findIndex(
        (result) => result.status === "queued",
      );
      if (pausedTaskIndex >= 0) {
        const pausedResult = event.results[pausedTaskIndex];
        if (pausedResult?.status !== "queued") {
          throw new Error(
            "Queued task result disappeared during continuation capture.",
          );
        }
        const selected = this.#routineWorkers.get(pausedResult.routineId);
        if (!selected) {
          throw new Error(
            `Queued routine ${pausedResult.routineId} has no retained worker.`,
          );
        }
        this.#pausedContinuations.set(event.arcRunId, {
          routineId: pausedResult.routineId,
          arcRunId: event.arcRunId,
          stage: event.stage,
          frontier: event.frontier,
          scope: workScope,
          dialog: event.dialog,
          tasks: event.tasks,
          completedResults: event.results.slice(0, pausedTaskIndex),
          pausedTaskIndex,
          selected,
          step: event.step,
          submissionId: event.submissionId,
        });
      }
      return this.#acceptFrontier(
        event.arcRunId,
        lap,
        "parked",
        event.frontier,
      );
    }
    this.#pausedContinuations.delete(event.arcRunId);

    const advanceInput = advanceInputFromResults(event.tasks, event.results);
    if (!advanceInput) {
      return this.#acceptFrontier(
        event.arcRunId,
        lap,
        restYieldReason(event.frontier),
        event.frontier,
      );
    }

    if (event.stage === "action") {
      // The host projects the report-time dialog itself, for the run's current
      // position; the threaded event dialog is no longer an actioning input.
      const next = await this.#arcHost.advanceAction(
        event.arcRunId,
        event.frontier.frontierId,
        {
          ...advanceInput,
          projectDialog: ({ roleId }) =>
            this.#projectedDialog(event.arcRunId, roleId),
        },
      );
      this.#retireAcceptedResults(workScope, event.results);

      return {
        kind: "enqueue",
        events: [
          {
            kind: "host-step",
            hostStep: next,
            scope: workScope,
            dialog: event.dialog,
            step: event.step + 1,
            submissionId: event.submissionId,
          },
        ],
      };
    }

    // stage === "trigger": another round stays a trigger step; otherwise it has
    // settled into the fan-out. Activation settles run before the held inbound
    // is committed, so the fan-out projector closes over it.
    const heldInbound =
      event.submissionId !== undefined
        ? this.#submissions.get(event.submissionId)?.inbound
        : undefined;
    const steps = await this.#arcHost.advanceTrigger(
      event.arcRunId,
      event.dialog,
      {
        ...advanceInput,
        projectDialog: async (view) => {
          if (!heldInbound) {
            throw new Error(
              `Trigger advance for ${event.arcRunId} cannot project a dialog: its submission is gone.`,
            );
          }
          return projectInboundDialog(heldInbound, view);
        },
      },
    );

    this.#retireAcceptedResults(workScope, event.results);

    const probeFailed = event.results.some(
      (result) => triggerFailureReason(result) !== undefined,
    );
    if (probeFailed) {
      // Failure retires this probe. A queued task in the same result batch must
      // not leave a retry or retained worker for the retired probe.
      this.#clearCapacityRetry(event.arcRunId);
      for (const result of event.results) {
        if (result.status === "queued")
          this.#routineWorkers.delete(result.routineId);
        const reason = triggerFailureReason(result);
        if (result.status !== "finished" || reason === undefined) continue;
        this.#submissionChannel(event.submissionId)?.push({
          kind: "failed",
          arcRunId: event.arcRunId,
          routineId: result.routineId,
          reason,
        });
      }
    }

    const only = steps.length === 1 ? steps[0] : undefined;
    if (only?.kind === "trigger") {
      return {
        kind: "enqueue",
        events: [
          {
            kind: "host-step",
            hostStep: only,
            dialog: event.dialog,
            step: event.step + 1,
            submissionId: event.submissionId,
          },
        ],
      };
    }
    if (event.submissionId !== undefined) {
      const submission = this.#submissions.get(event.submissionId);
      if (submission?.triggerProbeIds.delete(event.arcRunId)) {
        submission.pending = Math.max(0, submission.pending - 1);
      }
    }
    if (workScope) {
      this.#supersedeFrontier(workScope);
      this.#forgetScope(workScope);
    }
    // Settled: finish this (volatile) trigger lap and dispatch the fork onto
    // fresh per-run drains, recording the held inbound into each activated run.
    this.#finishLap(lap, probeFailed ? "failed" : "activated", "fanned-out");
    const inbound =
      event.submissionId !== undefined
        ? this.#submissions.get(event.submissionId)?.inbound
        : undefined;
    if (!inbound) return { kind: "continue" };
    return this.#dispatchForkSteps(steps, inbound, event.submissionId);
  }

  /** Close the open lap at this frontier, optionally handing off a continuation. */
  #acceptFrontier(
    arcRunId: ArcRunId,
    lap: LapState,
    yieldReason: LapYieldReason,
    frontier?: RunFrontier,
    continuation?: QueueEvent[],
  ): QueueRouteCommands {
    this.#finishLap(lap, frontier?.status, yieldReason);
    // submit drains carry their outcome on the submission channel, so accepting
    // a frontier never produces a scalar receipt — it only schedules the
    // continuation (which carries `submissionId`, keeping the channel reachable).
    const schedule =
      continuation && continuation.length > 0
        ? ({ kind: "schedule", arcRunId, events: continuation } as const)
        : undefined;
    return schedule ?? { kind: "continue" };
  }

  #finishLap(
    lap: LapState,
    arcStatus: string | undefined,
    yieldReason: LapYieldReason,
  ): void {
    if (!lap.arcRunId) return;
    this.#logger.info("worker_hub.lap.finished", {
      arcRunId: lap.arcRunId,
      arcStatus,
      yieldReason,
      taskResultCount: lap.taskResultCount,
    });
    this.#laps.delete(lap.arcRunId);
    lap.arcRunId = undefined;
    lap.taskResultCount = 0;
  }

  #dedupeTasks(tasks: readonly Task[]): Task[] {
    const seen = new Set<string>();
    return tasks.filter((task) => {
      const id = taskId(task);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  async #recordInboundAndProject(
    arcRunId: ArcRunId,
    message: InboundMessage,
  ): Promise<Dialog> {
    const inboundEntry = inboundHistoryEntry(message, new Date().toISOString());
    await this.#historyStore.appendEntry(arcRunId, inboundEntry);
    if (message.arcRunId === undefined) {
      this.#logInboundAccepted(arcRunId, message);
    }
    return this.#projectedDialog(arcRunId, DEFAULT_WORKER_ROLE);
  }

  #logInboundAccepted(arcRunId: ArcRunId, message: InboundMessage): void {
    this.#logger.info("worker_hub.inbound.accepted", {
      domain: "messaging",
      arcRunId,
      audience: message.audience ?? { name: "originator" },
      metadata: message.metadata,
    });
    this.#logger.debug("worker_hub.inbound.content", {
      domain: "messaging",
      arcRunId,
      content: previewLogValue(message.content),
    });
  }

  async #projectedDialog(arcRunId: ArcRunId, roleId: string): Promise<Dialog> {
    const entries = await this.#historyStore.listEntries(arcRunId);
    return projectDialog(entries, { roleId });
  }

  /**
   * Register an in-process worker for one Arc instruction role.
   *
   * Each role can have only one worker.
   */
  registerRoleWorker(role: string, worker: RoleWorker): void {
    this.#workerRegistry.registerRoleWorker(role, worker);
  }

  async #persistAndRunTask(
    task: Task,
    context: RoutineContext,
    contextKey: string,
    node: NodeInfo,
    selected: ResolvedWorker,
    historyEntries?: readonly HistoryEntry[],
    workScope?: FrontierWorkScope,
  ): Promise<TaskResult> {
    const routine = await this.#newRoutine(
      task,
      selected.backend,
      historyEntries,
    );
    const owned: OwnedRoutine | undefined = workScope
      ? {
          scope: workScope,
          routine,
          selected,
          node,
          active: true,
        }
      : undefined;
    if (owned) workScope!.routines.set(routine.id, owned);
    try {
      await this.#routineStore.putRoutine(routine);
      this.#routineWorkers.set(routine.id, selected);
      return await this.#runRoutine(
        routine,
        context,
        contextKey,
        node,
        selected,
        owned,
      );
    } catch (error) {
      this.#routineWorkers.delete(routine.id);
      throw error;
    } finally {
      const owned = workScope?.routines.get(routine.id);
      if (owned) owned.active = false;
      if (scopeCancelled(workScope)) this.#routineWorkers.delete(routine.id);
    }
  }

  async #handleTasks(
    tasks: readonly Task[],
    workScope?: FrontierWorkScope,
  ): Promise<TaskResult[]> {
    const results: TaskResult[] = [];
    const seen = new Set<string>();
    const entries: Array<{
      task: Task;
      context: RoutineContext;
      contextKey: string;
      node: NodeInfo;
      selected: ResolvedWorker;
    }> = [];
    for (const task of tasks) {
      if (scopeCancelled(workScope)) break;
      const id = taskId(task);
      if (seen.has(id)) continue;
      seen.add(id);
      const runContext = await this.#arcHost.getRunWorkspaceContext(
        task.arcRunId,
      );
      const contextKey = workerContextKey(task, runContext.reactivationCount);
      const context = await this.#prepareRoutineContext(task, {
        workspacePath: runContext.workspacePath,
        workspaceBundle: runContext.workspaceBundle,
      });
      const node = await this.#nodeInfoForTask(task);
      const selected = this.#selectWorker(task);
      entries.push({ task, context, contextKey, node, selected });
    }
    // Read each run's history once per batch; multiple tasks for the same run
    // would otherwise each re-read the whole log to project their role dialog.
    const historyByRun = new Map<ArcRunId, readonly HistoryEntry[]>();
    for (const entry of entries) {
      if (scopeCancelled(workScope)) break;
      let history = historyByRun.get(entry.task.arcRunId);
      if (!history) {
        history = await this.#historyStore.listEntries(entry.task.arcRunId);
        historyByRun.set(entry.task.arcRunId, history);
      }
      const result = await this.#persistAndRunTask(
        entry.task,
        entry.context,
        entry.contextKey,
        entry.node,
        entry.selected,
        history,
        workScope,
      );
      results.push(result);
      // A disposition concludes the whole frontier, so the batch's remaining
      // tasks would answer work that no longer stands.
      if (
        result.status === "queued" ||
        isDispositionResult(result) ||
        scopeCancelled(workScope)
      )
        break;
    }
    const affectedRuns = new Set(entries.map((entry) => entry.task.arcRunId));
    await Promise.all(
      [...affectedRuns].map((arcRunId) =>
        this.#reconcilePauseRequestedIfQuiescent(arcRunId),
      ),
    );
    return results;
  }

  #selectWorker(task: Task): ResolvedWorker {
    const selected = this.#workerRegistry.select(task);
    if (this.#unusableWorkers.has(selected.worker))
      throw new Error(
        "Worker resource release failed; this worker cannot be reused.",
      );
    return selected;
  }

  #assertStarted(): void {
    if (this.#lifecycle !== "started") {
      throw new Error(
        `Worker hub runtime entrypoint is unavailable while ${this.#lifecycle}.`,
      );
    }
  }

  async #warmWorker(
    selected: ResolvedWorker,
    task: Task,
    context: RoutineContext,
    contextKey: string,
  ): Promise<void> {
    if (!selected.worker.warm) return;
    const logFailure = (error: unknown): void => {
      this.#logger.info("worker_hub.worker.warm_failed", {
        backend: selected.backend,
        slot: selected.slot,
        role: task.role,
        arcRunId: task.arcRunId,
        error: previewLogValue(error),
      });
    };
    try {
      await Promise.resolve(
        selected.worker.warm({
          arcRunId: task.arcRunId,
          role: task.role,
          contextKey,
          workspacePath: context.workspacePath,
        }),
      ).catch(logFailure);
    } catch (error) {
      logFailure(error);
    }
  }

  async #runRoutine(
    routine: RoutineState,
    context: RoutineContext,
    contextKey: string,
    node: NodeInfo,
    selected: ResolvedWorker = this.#resolvedWorkerForRoutine(routine),
    owned?: OwnedRoutine,
    options: { resume?: boolean } = {},
  ): Promise<TaskResult> {
    const task = routine.task;
    const workScope = owned?.scope;
    if (owned) owned.active = true;
    const diagnostics = this.#routineDiagnosticsStore.forRoutine(
      routine.arcRunId,
      routine.role,
      routine.id,
    );
    const backend = selected.backend;
    if (routine.backend !== backend) {
      throw new Error(
        `Routine ${routine.id} selected backend ${JSON.stringify(routine.backend)} but continuation retained ${JSON.stringify(backend)}.`,
      );
    }
    this.#logger.info("worker_hub.routine.selected", {
      routineId: routine.id,
      role: task.role,
      backend,
      arcRunId: task.arcRunId,
      kind: task.kind,
      slot: selected.slot,
      ...(task.kind === "semantic"
        ? {
            stage: task.stage,
            requestCount: task.requests.length,
          }
        : {}),
    });
    let finishInvocation: (() => void) | undefined;
    if (owned)
      owned.invocation = new Promise<void>((resolve) => {
        finishInvocation = resolve;
      });
    let contexts = this.#workerContexts.get(selected.worker);
    if (!contexts) {
      contexts = new KeyedSerializer<string>();
      this.#workerContexts.set(selected.worker, contexts);
    }
    try {
      let report = await contexts.run<RoutineReport | TaskResult>(
        JSON.stringify([routine.arcRunId, contextKey]),
        async () => {
          try {
            if (scopeCancelled(workScope) && owned)
              return this.#skipSupersededRoutine(owned);
            let report: RoutineReport;
            const scope = this.#effectsForRoutine(
              routine,
              backend,
              node,
              workScope,
            );
            try {
              const paused = await this.#pauseRequested(routine.arcRunId);
              if (scopeCancelled(workScope) && owned) {
                return this.#skipSupersededRoutine(owned);
              }
              if (paused) {
                await this.#markRoutinePaused(routine, "routine-start", owned);
                if (scopeCancelled(workScope) && owned)
                  return this.#skipSupersededRoutine(owned);
                return { status: "queued", routineId: routine.id };
              }
              this.#emitRoutineEvent(routine, backend, node, "routine:started");
              // Preparation shares the context serializer with invocation and
              // continuity writes; independent contexts can prepare concurrently.
              context = await this.#prepareRoutineContext(task, context);
              if (this.#unusableWorkers.has(selected.worker))
                throw new Error(
                  "Worker resource release failed; this worker cannot be reused.",
                );
              // Resumption consumes live provider state retained by this worker.
              if (!options.resume)
                await this.#warmWorker(selected, task, context, contextKey);
              const input: RoutineInput = {
                routine: describeRoutine(routine, contextKey),
                context,
                effects: scope.effects,
                diagnostics,
              };
              if (scopeCancelled(workScope) && owned) {
                return this.#skipSupersededRoutine(owned);
              }
              if (this.#unusableWorkers.has(selected.worker))
                throw new Error(
                  "Worker resource release failed; this worker cannot be reused.",
                );
              let rawReport: unknown;
              try {
                rawReport = await selected.worker.run(input);
              } catch (error) {
                rawReport = backendFailureReport(error);
              }
              report = await this.#validateReportForTask(
                rawReport,
                routine,
                diagnostics,
                backend,
              );
            } finally {
              scope.dispose();
            }

            return report;
          } finally {
            finishInvocation?.();
          }
        },
      );
      if ("status" in report) return report;
      if (scopeCancelled(workScope) && owned) {
        this.#logger.info("worker_hub.routine.superseded", {
          routineId: routine.id,
          arcRunId: routine.arcRunId,
          ...flatReportLogFields(report),
        });
        return this.#skipSupersededRoutine(owned);
      }
      if (report.cancellation)
        report = backendFailureReport(
          new Error(
            "Worker returned superseded cancellation for current work.",
          ),
        );
      this.#applyBackendDetails(routine, report);
      if (report.suspension === "paused") {
        await this.#markRoutinePaused(routine, "in-turn", owned);
        if (scopeCancelled(workScope) && owned)
          return this.#skipSupersededRoutine(owned);
        return { status: "queued", routineId: routine.id };
      }
      if (report.suspension === "capacity-limited") {
        const reason: CapacityLimit = { ...report.reason, backend };
        await this.#markRoutineCapacityLimited(
          routine,
          backend,
          node,
          reason,
          owned,
        );
        if (scopeCancelled(workScope) && owned)
          return this.#skipSupersededRoutine(owned);
        return { status: "queued", routineId: routine.id };
      }
      if (report.suspension === "transport-lost") {
        const reason: TransportLoss = { ...report.reason, backend };
        await this.#markRoutineTransportLost(
          routine,
          backend,
          node,
          reason,
          owned,
        );
        if (scopeCancelled(workScope) && owned)
          return this.#skipSupersededRoutine(owned);
        return { status: "queued", routineId: routine.id };
      }
      if (report.error === "unavailable") {
        return this.#skipRoutine(
          routine,
          node,
          report.code,
          report.message,
          backend,
        );
      }

      routine.status = "finished";
      routine.error =
        report.error === "failed"
          ? { code: report.code, message: report.message }
          : undefined;
      routine.updatedAt = new Date().toISOString();
      await this.#routineStore.putRoutine(routine);
      this.#emitRoutineEvent(
        routine,
        backend,
        node,
        report.error === "failed" ? "routine:failed" : "routine:finished",
        {
          outcome: report.outcome,
          disposition: reportDisposition(report),
          error:
            report.error === "failed"
              ? { code: report.code, message: report.message }
              : undefined,
        },
      );
      const reportLog = flatReportLogFields(report);
      this.#logger.info("worker_hub.routine.finished", {
        routineId: routine.id,
        role: routine.role,
        status: routine.status,
        ...reportLog,
        error: routine.error,
        backendDetails: routine.backendDetails,
      });
      await this.#reconcilePauseRequestedIfQuiescent(routine.arcRunId);
      return { status: "finished", routineId: routine.id, report };
    } catch (error) {
      this.#routineWorkers.delete(routine.id);
      // A failed backend disposal must still terminate the old routine's
      // local record; otherwise it remains a false running/resume owner.
      if (scopeCancelled(workScope) && owned)
        await this.#skipSupersededRoutine(owned);
      throw error;
    } finally {
      finishInvocation?.();
      if (owned) {
        owned.active = false;
        if (scopeCancelled(workScope))
          await this.#clearSupersededControl(owned);
      }
      if (
        scopeCancelled(workScope) ||
        routine.status === "finished" ||
        routine.status === "skipped"
      ) {
        this.#routineWorkers.delete(routine.id);
      }
    }
  }

  async #validateReportForTask(
    value: unknown,
    routine: RoutineState,
    diagnostics: RoutineDiagnostics,
    backend: BackendName,
  ): Promise<RoutineReport> {
    let report: RoutineReport;
    try {
      report = validateRoutineReport(value, "worker report");
    } catch (error) {
      return backendFailureReport(error);
    }
    const task = routine.task;
    if (task.kind !== "semantic" || report.outcome !== "completed") {
      return report;
    }
    const drift = recordSemanticReportDrift(
      this.#logger,
      "worker_hub.semantic_report_drift",
      {
        arcRunId: routine.arcRunId,
        routineId: routine.id,
        role: routine.role,
        backend,
        batchId: task.batchId,
      },
    );
    try {
      return validateCompletedSemanticReport(
        report,
        task,
        "worker report",
        drift.onDrift,
      );
    } catch (error) {
      return backendFailureReport(error);
    } finally {
      await drift.persist(diagnostics);
    }
  }

  #applyBackendDetails(routine: RoutineState, report: RoutineReport): void {
    if (!Object.prototype.hasOwnProperty.call(report, "backendDetails")) return;
    if (report.backendDetails === null) {
      delete routine.backendDetails;
      return;
    }
    if (report.backendDetails !== undefined) {
      routine.backendDetails = canonicalizeJsonValue(
        report.backendDetails,
        "worker report backendDetails",
      );
    }
  }

  #resolvedWorkerForRoutine(routine: RoutineState): ResolvedWorker {
    const selected = this.#routineWorkers.get(routine.id);
    if (!selected) {
      throw new Error(
        `Routine ${routine.id} has no retained same-process worker continuation.`,
      );
    }
    return selected;
  }

  async #newRoutine(
    task: Task,
    backend: BackendName,
    historyEntries?: readonly HistoryEntry[],
  ): Promise<RoutineState> {
    const now = new Date().toISOString();
    return {
      id: `routine:${randomUUID()}`,
      role: task.role,
      backend,
      arcRunId: task.arcRunId,
      status: "running",
      task: await this.#taskWithRoleDialog(task, historyEntries),
      updatedAt: now,
    };
  }

  /**
   * Re-project an action task's dialog for its own worker role. Arc host attaches
   * the run-level dialog to every task, but each worker should see history scoped
   * to its own role — its audience traffic and ask answers, plus the principal's
   * shared turns — not the default role's view. The activating inbound is
   * committed to history before action tasks dispatch, so the store is the
   * complete source for the projection.
   *
   * Trigger-stage tasks run against the volatile trigger stage, whose inbound is
   * never committed to history (only an `action` birth records it). Their dialog
   * is the inbound projection arc host already attached; re-projecting it from the
   * (empty) trigger-stage history would wipe the message the trigger evaluates,
   * so the attached dialog is kept as-is.
   */
  async #taskWithRoleDialog(
    task: Task,
    historyEntries?: readonly HistoryEntry[],
  ): Promise<Task> {
    if (task.kind === "semantic" && task.stage === "trigger") {
      return task;
    }
    const entries =
      historyEntries ?? (await this.#historyStore.listEntries(task.arcRunId));
    return { ...task, dialog: projectDialog(entries, { roleId: task.role }) };
  }

  async #skipRoutine(
    routine: RoutineState,
    node: NodeInfo,
    code: string,
    detail: unknown,
    backend: BackendName = "fail",
  ): Promise<TaskResult> {
    const message =
      detail instanceof Error
        ? detail.message
        : typeof detail === "string"
          ? detail
          : String(detail);
    routine.status = "skipped";
    routine.error = { code, message };
    routine.updatedAt = new Date().toISOString();
    await this.#routineStore.putRoutine(routine);
    this.#emitRoutineEvent(routine, backend, node, "routine:skipped", {
      error: routine.error,
    });
    this.#logger.info("worker_hub.routine.skipped", {
      routineId: routine.id,
      role: routine.role,
      error: routine.error,
      backendDetails: routine.backendDetails,
    });
    return { status: "skipped", error: routine.error };
  }

  #effectsForRoutine(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    workScope?: FrontierWorkScope,
  ): RoutineEffectScope {
    const ownedAsks = new Map<string, AskResolverEntry>();
    // Provider tool-call ids are correlation metadata and can collide across
    // concurrent workers. The hub allocates the globally routed ask id and
    // separately tracks ownership so one routine cannot dispose another's ask.
    const allocateAskId = (): string => {
      let askId = randomUUID();
      while (this.#askResolvers.has(askId)) askId = randomUUID();
      return askId;
    };
    const registerAsk = (askId: string, entry: AskResolverEntry): void => {
      ownedAsks.set(askId, entry);
      this.#askResolvers.set(askId, entry);
    };
    const rejectAsk = (askId: string, error: Error): void => {
      const entry = ownedAsks.get(askId);
      if (!entry) return;
      if (this.#askResolvers.get(askId) === entry) {
        this.#askResolvers.delete(askId);
      }
      entry.release();
      entry.reject(error);
    };
    const emitOutbound = async (
      message: Parameters<RoutineEffects["emit"]>[0],
    ): Promise<string | void> => {
      if (scopeCancelled(workScope))
        throw new Error(scopeCancellationMessage(workScope));
      if (
        message.metadata &&
        Object.prototype.hasOwnProperty.call(message.metadata, "askId")
      ) {
        throw new Error("RoutineEffects.emit metadata.askId is hub-owned.");
      }
      if (message.situation.cause !== "question") {
        await this.#emit(
          {
            situation: {
              role: routine.role,
              audience: message.situation.audience ?? "originator",
              cause: message.situation.cause,
            },
            arcRunId: routine.arcRunId,
            content: message.content,
            metadata: message.metadata,
          },
          workScope,
        );
        return undefined;
      }

      const askId = allocateAskId();
      const toolCallId = readToolCallIdFromMetadata(message.metadata) ?? askId;
      const audienceName = message.situation.audience ?? "originator";
      const audience: InboundAudience = {
        name: audienceName,
        ...(audienceName === "originator" ? {} : { ofRole: routine.role }),
      };
      const outbound: OutboundMessage = {
        situation: {
          role: routine.role,
          audience: audienceName,
          cause: "question",
        },
        arcRunId: routine.arcRunId,
        content: message.content,
        metadata: { ...message.metadata, askId },
      };
      return new Promise<string>((resolve, reject) => {
        // Register before emitting because an in-process connector can deliver
        // the answer synchronously from its outbound callback.
        let entry: AskResolverEntry;
        entry = {
          cause: "question",
          arcRunId: routine.arcRunId,
          routineId: routine.id,
          outbound,
          scope: workScope,
          role: routine.role,
          audience,
          resolve: (answer) => resolve(answer.content),
          reject,
          isOwnerLive: () => ownedAsks.get(askId) === entry,
          release: () => {
            if (ownedAsks.get(askId) === entry) ownedAsks.delete(askId);
          },
        };
        registerAsk(askId, entry);
        void this.#emit(outbound, workScope)
          .then(() => {
            if (scopeCancelled(workScope)) return;
            this.#emitBlockedEvent(routine, backend, node, {
              kind: "blocked:question",
              audience: audienceName,
              askId,
              toolCallId,
            });
          })
          .catch((error: unknown) => {
            rejectAsk(
              askId,
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      });
    };
    const requestPermission: RoutineEffects["requestPermission"] = async (
      request,
    ) => {
      if (scopeCancelled(workScope))
        throw new Error(scopeCancellationMessage(workScope));
      const askId = allocateAskId();
      const outbound: OutboundMessage = {
        situation: {
          role: routine.role,
          audience: PERMISSION_APPROVER_AUDIENCE,
          cause: PERMISSION_ASK_CAUSE,
        },
        arcRunId: routine.arcRunId,
        content: formatPermissionAskContent(
          routine.role,
          request.toolName,
          request.input,
        ),
        metadata: {
          askId,
          toolCallId: request.toolCallId,
          permissionAsk: {
            toolName: request.toolName,
            input: request.input,
          },
        },
      };
      return new Promise<PermissionVerdict>((resolve, reject) => {
        // As with questions, publish the resolver before outbound dispatch so
        // a synchronous permission answer cannot race ahead of registration.
        let entry: AskResolverEntry;
        entry = {
          cause: PERMISSION_ASK_CAUSE,
          arcRunId: routine.arcRunId,
          routineId: routine.id,
          outbound,
          scope: workScope,
          role: routine.role,
          audience: {
            name: PERMISSION_APPROVER_AUDIENCE,
            ofRole: routine.role,
          },
          resolve,
          reject,
          isOwnerLive: () => ownedAsks.get(askId) === entry,
          release: () => {
            if (ownedAsks.get(askId) === entry) ownedAsks.delete(askId);
          },
        };
        registerAsk(askId, entry);
        void this.#emit(outbound, workScope)
          .then(() => {
            if (scopeCancelled(workScope)) return;
            this.#emitBlockedEvent(routine, backend, node, {
              kind: "blocked:permission",
              audience: PERMISSION_APPROVER_AUDIENCE,
              askId,
              toolCallId: request.toolCallId,
            });
          })
          .catch((error: unknown) => {
            rejectAsk(
              askId,
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      });
    };

    return {
      effects: {
        emit: emitOutbound,
        requestPermission,
        logToolEvent: async (event) => {
          this.#appendRoutineToolEvent(routine, backend, node, event);
        },
        recordTokenUsage: async (tokenUsage) => {
          this.#appendRoutineUsageEvent(routine, backend, node, tokenUsage);
        },
        checkSignal: async () => {
          if (scopeCancelled(workScope)) return { kind: "cancel" };
          const paused = await this.#pauseRequested(routine.arcRunId);
          if (scopeCancelled(workScope)) return { kind: "cancel" };
          return paused ? { kind: "pause" } : undefined;
        },
      },
      dispose: () => {
        for (const [askId, entry] of [...ownedAsks]) {
          if (entry.routineId !== routine.id) continue;
          rejectAsk(
            askId,
            new Error(
              `Routine ${routine.id} ended before ask ${askId} resolved.`,
            ),
          );
        }
        ownedAsks.clear();
      },
    };
  }

  async #ensureWorkspaceDirectory(workspacePath: string): Promise<void> {
    await mkdir(workspacePath, { recursive: true });
  }

  /** Supply an existing directory for every worker entry. */
  async #prepareRoutineContext(
    task: Task,
    context: RoutineContext,
  ): Promise<RoutineContext> {
    this.#assertStarted();
    const workspacePath =
      task.kind === "semantic" && task.stage === "trigger"
        ? process.cwd()
        : context.workspacePath;
    await this.#ensureWorkspaceDirectory(workspacePath);
    return { ...context, workspacePath };
  }

  async #nodeInfoForTask(task: Task): Promise<NodeInfo> {
    const ref = taskSourceRef(task);
    return this.#arcHost.nodeInfoForRef(ref, task.arcRunId);
  }

  /**
   * Register a connector-owned handler for one outbound situation.
   *
   * Each of `role`, `audience`, and `cause` may be the literal `"*"` to mean
   * "match any value at this slot." A registration with no wildcards matches
   * only exact `{ role, audience, cause }` triples. Wildcards on multiple
   * dimensions compose naturally — an outbound fires every registered
   * handler whose situation matches under exact-or-wildcard semantics on
   * each dimension. The returned function unregisters this handler.
   */
  registerOutboundHandler(
    situation: OutboundSituation,
    handler: OutboundMessageHandler,
  ): () => void {
    this.#assertStarted();
    const path = [situation.role, situation.audience, situation.cause];
    const leaf = ensureOutboundNode(this.#outboundRoot, path);
    const handlers = leaf.handlers ?? new Set<OutboundMessageHandler>();
    handlers.add(handler);
    leaf.handlers = handlers;
    return () => {
      handlers.delete(handler);
      // Pruning empty nodes is intentionally skipped: connectors register
      // once at startup, so leftover branches are harmless and the
      // bookkeeping would complicate registration.
    };
  }

  /**
   * List the run's live question and permission asks whose situation matches,
   * under the exact-or-`"*"` rule of `registerOutboundHandler`, in registration
   * order. Each entry is the outbound message the ask was dispatched with. An
   * ask that is settled, released by supersession, or disposed with its
   * routine is absent, so the result is empty while no work scope exists.
   */
  listAsks(
    arcRunId: ArcRunId,
    situation: OutboundSituation,
  ): OutboundMessage[] {
    this.#assertStarted();
    const asks: OutboundMessage[] = [];
    for (const entry of this.#askResolvers.values()) {
      if (
        entry.arcRunId === arcRunId &&
        situationMatches(situation, entry.outbound.situation)
      )
        asks.push(structuredClone(entry.outbound));
    }
    return asks;
  }

  async #emit(
    message: OutboundMessage,
    scope?: FrontierWorkScope,
  ): Promise<void> {
    if (scopeCancelled(scope)) throw new Error(scopeCancellationMessage(scope));
    await this.#drainQueue(
      [{ kind: "connector-outbound", message, scope }],
      "background",
    );
  }

  async #emitNow(
    message: OutboundMessage,
    scope?: FrontierWorkScope,
  ): Promise<void> {
    if (scopeCancelled(scope)) throw new Error(scopeCancellationMessage(scope));
    this.#logger.info("worker_hub.outbound.emitted", {
      domain: "messaging",
      arcRunId: message.arcRunId,
      situation: message.situation,
      metadata: message.metadata,
    });
    this.#logger.debug("worker_hub.outbound.content", {
      domain: "messaging",
      arcRunId: message.arcRunId,
      content: previewLogValue(message.content),
    });
    const audienceName = message.situation.audience;
    await this.#historyStore.appendEntry(message.arcRunId, {
      from: { kind: "role", id: message.situation.role },
      to: {
        kind: "audience",
        name: audienceName,
        ...(audienceName === "originator"
          ? {}
          : { ofRole: message.situation.role }),
      },
      content: outboundContentToDialogText(message.content),
      at: new Date().toISOString(),
    });
    if (scopeCancelled(scope)) throw new Error(scopeCancellationMessage(scope));
    await this.#dispatchOutbound(message);
  }

  async #dispatchOutbound(message: OutboundMessage): Promise<void> {
    const handlers: OutboundMessageHandler[] = [];
    collectOutboundHandlers(
      this.#outboundRoot,
      [
        message.situation.role,
        message.situation.audience,
        message.situation.cause,
      ],
      handlers,
    );
    if (handlers.length === 0) {
      if (readToolCallIdFromMetadata(message.metadata) !== undefined) {
        throw new Error(
          `No outbound handler registered for ${message.situation.role}/${message.situation.audience}/${message.situation.cause}.`,
        );
      }
      return;
    }
    await Promise.all(handlers.map((handler) => handler(message)));
  }

  async #settleAskAnswer(
    arcRunId: ArcRunId,
    askId: string,
    message: InboundMessage,
  ): Promise<"settled" | "invalid" | "missing"> {
    const entry = this.#askResolvers.get(askId);
    if (!entry || entry.arcRunId !== arcRunId) return "missing";

    const verdict =
      entry.cause === PERMISSION_ASK_CAUSE
        ? readPermissionVerdict(message)
        : undefined;
    if (entry.cause === PERMISSION_ASK_CAUSE && verdict === undefined) {
      return "invalid";
    }

    // Taking the map entry is the claim. No await may occur before this delete.
    this.#askResolvers.delete(askId);

    if (entry.cause === PERMISSION_ASK_CAUSE) {
      entry.release();
      entry.resolve(verdict!);
      try {
        this.#logger.info("worker_hub.permission.resolved", {
          domain: "messaging",
          arcRunId,
          askId,
          decision: verdict!.decision,
        });
        this.#logInboundAccepted(arcRunId, message);
      } catch {
        // Accepted-resolution logging is best-effort after settlement.
      }
      return "settled";
    }

    try {
      await this.#historyStore.appendEntry(
        arcRunId,
        answerHistoryEntry(
          message.content,
          entry.audience,
          entry.role,
          new Date().toISOString(),
        ),
      );
    } catch (error) {
      if (entry.isOwnerLive() && entry.scope && scopeCancelled(entry.scope)) {
        this.#publishAskInvalidation(entry.scope, [askId]);
        entry.release();
        entry.reject(new Error(scopeCancellationMessage(entry.scope)));
        throw error;
      }
      if (
        entry.isOwnerLive() &&
        this.#lifecycle === "started" &&
        !this.#askResolvers.has(askId)
      ) {
        this.#askResolvers.set(askId, entry);
      }
      throw error;
    }

    if (!entry.isOwnerLive()) {
      throw new Error(
        `Routine ${entry.routineId} ended while answer ${askId} was committing.`,
      );
    }
    entry.release();
    entry.resolve(message);
    try {
      this.#logger.info("worker_hub.answer.resolved", {
        domain: "messaging",
        arcRunId,
        askId,
        cause: entry.cause,
      });
      this.#logInboundAccepted(arcRunId, message);
    } catch {
      // Accepted-resolution logging is best-effort after settlement.
    }
    return "settled";
  }

  #rejectInbound(
    channel: HotAsyncQueue<InboundLifecycleEvent> | undefined,
    message: string,
    details: Record<string, unknown>,
  ): void {
    try {
      this.#logger.info("worker_hub.inbound.rejected", {
        domain: "messaging",
        ...details,
      });
    } catch {
      // Rejection logging is best-effort.
    }
    channel?.push({ kind: "rejected", reason: message });
  }

  #rejectAllAsks(error: Error): void {
    for (const [askId, entry] of [...this.#askResolvers]) {
      if (this.#askResolvers.get(askId) !== entry) continue;
      this.#askResolvers.delete(askId);
      entry.release();
      entry.reject(error);
    }
  }

  /** Read controlled view for one Arc run. */
  async getExecutionControlView(
    arcRunId: ArcRunId,
  ): Promise<ExecutionControlView> {
    this.#assertStarted();
    const run = await this.#arcHost.getRunView(arcRunId);
    if (isInactiveRun(run)) {
      return { status: "inactive", arcRunId };
    }
    const control = await this.#executionControlFor(arcRunId);
    const park = this.#hostOrHubPark(run, control);
    if (park) return park;
    if (
      control.status !== "capacity-limited" &&
      control.status !== "transport-lost"
    ) {
      return executionControlView(control);
    }
    // Transport losses are always retryable; capacity blocks only when transient.
    const retryable =
      control.status === "transport-lost" ||
      isTransientCapacity(control.capacityReason.reason);
    const view = executionControlView(control);
    const autoRetry = this.#autoRetryView(arcRunId, retryable);
    return autoRetry ? { ...view, autoRetry } : view;
  }

  /**
   * The host or hub park of an active actioning run whose stored control says
   * it is executing while nothing in this process executes it, or `undefined`
   * when the stored status stands. Checks run in order: live work, a lap
   * failure, an uncaught interruption, then whether this hub has run the run
   * since it started.
   */
  #hostOrHubPark(
    run: ArcRunView | undefined,
    control: ExecutionControlState,
  ):
    | Extract<
        ExecutionControlView,
        { status: "internal-error" | "uncaught-interruption" | "hub-restarted" }
      >
    | undefined {
    if (run?.stage !== "actioning" || run.lifecycle !== "active") return;
    if (control.status !== "running" && control.status !== "pauseRequested")
      return;
    const { arcRunId } = control;
    if (this.#workScopes.has(arcRunId)) return;
    const failure = this.#lapFailures.get(arcRunId);
    if (failure)
      return {
        arcRunId,
        status: "internal-error",
        error: { message: failure.message },
        failedAt: failure.failedAt,
        updatedAt: control.updatedAt,
      };
    const interruption = this.#uncaughtInterruptions.get(arcRunId);
    if (interruption)
      return {
        arcRunId,
        status: "uncaught-interruption",
        interruption: { ...interruption },
        updatedAt: control.updatedAt,
      };
    if (!this.#runsSinceStart.has(arcRunId))
      return {
        arcRunId,
        status: "hub-restarted",
        updatedAt: control.updatedAt,
      };
    return;
  }

  /**
   * Project the in-memory auto-retry state for a parked run, or `undefined` when
   * auto-retry does not apply (disabled, or a non-retryable park such as a hard
   * `token usage limit` that only a billing action resolves). When it applies,
   * `pending` is true while the next attempt is scheduled and false while one is
   * in flight or the cap is spent.
   */
  #autoRetryView(
    arcRunId: ArcRunId,
    retryable: boolean,
  ): ParkAutoRetry | undefined {
    if (!this.#capacityRetry.enabled || !retryable) {
      return undefined;
    }
    const entry = this.#capacityRetries.get(arcRunId);
    return {
      pending: entry?.nextAttemptAt !== undefined,
      attempt: entry?.attempts ?? 0,
      maxAttempts: this.#capacityRetry.maxAttempts,
      ...(entry?.nextAttemptAt !== undefined
        ? { nextAttemptAt: entry.nextAttemptAt }
        : {}),
    };
  }

  /** Request a cooperative pause for one Arc run. */
  async requestPause(arcRunId: ArcRunId): Promise<RequestPauseResult> {
    this.#assertStarted();
    const updated = await this.#controlMutations.run(arcRunId, async () => {
      const run = await this.#arcHost.getRunView(arcRunId);
      if (isInactiveRun(run)) {
        return { outcome: "inactive" as const, arcRunId };
      }
      if (run?.stage !== "actioning") {
        return { outcome: "missing" as const, arcRunId };
      }
      const existing = await this.#executionControlFor(arcRunId);
      const park = this.#hostOrHubPark(run, existing);
      if (park) return { outcome: "not-running" as const, control: park };
      if (existing.status === "pauseRequested") {
        return {
          outcome: "duplicate-request" as const,
          control: executionControlView(existing),
        };
      }
      if (existing.status !== "running") {
        // The run is already paused or parked, so there is no running routine to
        // pause. For a park (capacity-limited / transport-lost) this is also load
        // bearing: overwriting the control would destroy the park's durable resume
        // pointer. The caller reads control.status for the specific state.
        return {
          outcome: "not-running" as const,
          control: executionControlView(existing),
        };
      }

      const now = new Date().toISOString();
      const runningRoutines = await this.#runningRoutines(arcRunId);
      const controlRoutineId =
        runningRoutines.length === 1 ? runningRoutines[0]?.id : undefined;
      const control: Extract<
        ExecutionControlState,
        { status: "pauseRequested" | "paused" }
      > =
        runningRoutines.length > 0
          ? {
              arcRunId,
              status: "pauseRequested",
              requestedAt: now,
              updatedAt: now,
            }
          : {
              arcRunId,
              status: "paused",
              pausedAt: now,
              updatedAt: now,
            };
      await this.#routineStore.putExecutionControl(control);
      this.#emitControlEvent(
        arcRunId,
        control.status === "pauseRequested"
          ? "control:pause-requested"
          : "control:paused",
        controlRoutineId,
      );
      return {
        outcome: "requested" as const,
        control: executionControlView(control),
        controlState: control,
      };
    });
    if (updated.outcome !== "requested") return updated;
    const { controlState: control } = updated;

    this.#logger.info("worker_hub.pause.requested", {
      arcRunId,
      status: control.status,
    });
    if (control.status === "paused") {
      this.#logger.info("worker_hub.pause.paused", {
        arcRunId,
        status: control.status,
      });
    }
    return {
      outcome: "requested",
      control: executionControlView(control),
    };
  }

  /**
   * Resume one paused or parked Arc run. Uses the exact continuation when this
   * process still holds one, and otherwise rebuilds the run from durable state.
   */
  async resume(arcRunId: ArcRunId): Promise<ResumeResult> {
    this.#assertStarted();
    return this.#resumeRun(arcRunId, { auto: false });
  }

  /**
   * Resume a paused or capacity-limited run. `auto` distinguishes the scheduled
   * capacity retry from a user-initiated resume: a manual resume resets the
   * auto-retry attempt counter (a human has taken over), an auto resume keeps it
   * so the backoff cap still bounds the retry loop.
   */
  async #resumeRun(
    arcRunId: ArcRunId,
    { auto }: { auto: boolean },
  ): Promise<ResumeResult> {
    const continuation = this.#pausedContinuations.get(arcRunId);
    try {
      return await this.#resumeCurrentRun(arcRunId, auto, continuation);
    } catch (error) {
      await this.#recordLapFailure(arcRunId, error, continuation?.scope);
      this.#failContinuation(continuation, error);
      throw error;
    }
  }

  async #resumeCurrentRun(
    arcRunId: ArcRunId,
    auto: boolean,
    continuation: PausedRoutineContinuation | undefined,
  ): Promise<ResumeResult> {
    const accepted = await this.#controlMutations.run(arcRunId, async () => {
      const run = await this.#arcHost.getRunView(arcRunId);
      if (isInactiveRun(run)) {
        this.#clearCapacityRetry(arcRunId);
        return { outcome: "inactive" as const, arcRunId };
      }
      const existing = await this.#executionControlFor(arcRunId);
      // Trigger-stage provider parks can precede persisted execution. Their
      // captured continuation establishes readiness, after lifecycle eligibility.
      const parked =
        existing.status === "capacity-limited" ||
        existing.status === "transport-lost";
      if (run?.stage !== "actioning" && !(parked && continuation)) {
        this.#clearCapacityRetry(arcRunId);
        return { outcome: "missing" as const, arcRunId };
      }
      // A host or hub park, or a pause or worker park whose continuation this
      // process no longer holds, resumes by rebuilding the run. With live work, the
      // continuation is still to be stored, so the resume is not ready yet.
      let rebuild = this.#hostOrHubPark(run, existing) !== undefined;
      if (!rebuild && existing.status === "running") {
        return {
          outcome: "not-paused" as const,
          control: executionControlView(existing),
        };
      }
      if (parked && !continuation) {
        if (this.#workScopes.has(arcRunId)) {
          this.#logger.info("worker_hub.routine.park.resume_not_ready", {
            arcRunId,
            status: existing.status,
            parkedRoutineId: parkedRoutineId(existing),
          });
          this.#clearCapacityRetry(arcRunId);
          return {
            outcome: "not-ready" as const,
            control: executionControlView(existing),
          };
        }
        rebuild = true;
      }
      if (
        existing.status === "paused" &&
        existing.pausedRoutineId !== undefined &&
        !this.#routineWorkers.has(existing.pausedRoutineId) &&
        !continuation
      ) {
        if (this.#workScopes.has(arcRunId)) {
          this.#logger.info("worker_hub.routine.pause.resume_not_ready", {
            arcRunId,
            pausedRoutineId: existing.pausedRoutineId,
          });
          return {
            outcome: "not-ready" as const,
            control: executionControlView(existing),
          };
        }
        rebuild = true;
      }
      const running: Extract<ExecutionControlState, { status: "running" }> = {
        arcRunId,
        status: "running",
        updatedAt: new Date().toISOString(),
      };
      await this.#routineStore.putExecutionControl(running);
      this.#lapFailures.delete(arcRunId);
      this.#uncaughtInterruptions.delete(arcRunId);
      this.#runsSinceStart.add(arcRunId);
      this.#emitControlEvent(
        arcRunId,
        "control:resumed",
        rebuild
          ? undefined
          : existing.status === "paused"
            ? existing.pausedRoutineId
            : parkedRoutineId(existing),
      );
      return { outcome: "resumed" as const, existing, running, rebuild };
    });
    if (accepted.outcome !== "resumed") return accepted;
    const { existing, running, rebuild } = accepted;

    // Stop any pending auto-retry timer; a manual resume also resets the count.
    const retry = this.#capacityRetries.get(arcRunId);
    if (retry) {
      retry.cancel();
      if (auto) {
        // The scheduled attempt is now in flight: keep the count, drop the
        // next-attempt time so the view reports it retrying rather than pending.
        this.#capacityRetries.set(arcRunId, {
          attempts: retry.attempts,
          cancel: () => {},
        });
      } else {
        this.#capacityRetries.delete(arcRunId);
      }
    }

    const resumeRoutineId = rebuild
      ? undefined
      : existing.status === "paused"
        ? existing.pausedRoutineId
        : parkedRoutineId(existing);
    const parkedRoutineOrigin =
      !rebuild && existing.status === "paused"
        ? existing.pausedRoutineOrigin
        : undefined;

    this.#logger.info("worker_hub.pause.resumed", { arcRunId });

    await this.#run(arcRunId, () => {
      for (const delivery of this.#moduleEffects.get(arcRunId) ?? [])
        delivery.attemptedFrontierId = undefined;
      return this.#drainQueue(
        [{ kind: "module-effects", arcRunId }],
        "background",
      );
    });
    if (continuation?.scope && scopeCancelled(continuation.scope))
      return { outcome: "resumed", control: executionControlView(running) };
    if (resumeRoutineId) {
      await this.#resumeParkedRoutine(
        resumeRoutineId,
        parkedRoutineOrigin,
        continuation,
      );
    } else {
      // The rebuild step. Without live work, routines no execution owns are
      // retired before `begin` rebuilds the run from durable state; with live
      // work, `begin` returns the retained frontier and nothing redispatches.
      await this.#run(arcRunId, async () => {
        if (!this.#workScopes.has(arcRunId))
          await this.#skipOrphanedRoutines(arcRunId);
        const dialog = await this.#projectedDialog(
          arcRunId,
          DEFAULT_WORKER_ROLE,
        );
        const steps = await this.#arcHost.begin({
          arcRunId,
          projectDialog: ({ roleId }) =>
            this.#projectedDialog(arcRunId, roleId),
        });
        // Install begin's frontier before host module outcomes queued during setup.
        await this.#drainQueue(
          steps.map((hostStep) => ({
            kind: "host-step" as const,
            hostStep,
            dialog,
            step: 0,
            openedBy: "resume" as const,
          })),
          "background",
        );
      });
    }
    return { outcome: "resumed", control: executionControlView(running) };
  }

  async #executionControlFor(
    arcRunId: ArcRunId,
  ): Promise<ExecutionControlState> {
    return (
      (await this.#routineStore.getExecutionControl(arcRunId)) ?? {
        arcRunId,
        status: "running",
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async #runningRoutines(arcRunId: ArcRunId): Promise<RoutineState[]> {
    const routines: RoutineState[] = [];
    for await (const routine of this.#routineStore.listRoutines(arcRunId)) {
      if (routine.status === "running") routines.push(routine);
    }
    return routines;
  }

  /**
   * Skip the run's unfinished routine records that no live execution owns,
   * before a rebuild dispatches their work again. A retiring routine is left to
   * its own skip.
   */
  async #skipOrphanedRoutines(arcRunId: ArcRunId): Promise<void> {
    const orphans: RoutineState[] = [];
    for await (const routine of this.#routineStore.listRoutines(arcRunId)) {
      if (
        (routine.status === "running" ||
          routine.status === "paused" ||
          routine.status === "capacity-limited" ||
          routine.status === "transport-lost") &&
        !this.#routineWorkers.has(routine.id) &&
        ![...this.#retiringRoutines].some(
          (owned) => owned.routine.id === routine.id,
        )
      )
        orphans.push(routine);
    }
    for (const routine of orphans) {
      await this.#skipRoutine(
        routine,
        await this.#nodeInfoForTask(routine.task),
        "execution-lost",
        "No live execution owns this routine; resume rebuilt the run.",
        routine.backend,
      );
    }
  }

  async #pauseRequested(arcRunId: ArcRunId): Promise<boolean> {
    const control = await this.#executionControlFor(arcRunId);
    return control.status !== "running";
  }

  async #markRoutinePaused(
    routine: RoutineState,
    origin: PausedRoutineOrigin,
    owned?: OwnedRoutine,
  ): Promise<void> {
    const paused = await this.#controlMutations.run(
      routine.arcRunId,
      async () => {
        const control = await this.#executionControlFor(routine.arcRunId);
        if (
          scopeCancelled(owned?.scope) ||
          control.status === "capacity-limited" ||
          control.status === "transport-lost"
        )
          return;
        if (owned) owned.controlBeforeSuspension = control;
        const now = new Date().toISOString();
        const paused: ExecutionControlState =
          control.status === "paused"
            ? {
                ...control,
                pausedRoutineId: control.pausedRoutineId ?? routine.id,
                pausedRoutineOrigin: control.pausedRoutineOrigin ?? origin,
                updatedAt: now,
              }
            : {
                arcRunId: routine.arcRunId,
                status: "paused",
                requestedAt:
                  control.status === "pauseRequested"
                    ? control.requestedAt
                    : undefined,
                pausedAt: now,
                pausedRoutineId: routine.id,
                pausedRoutineOrigin: origin,
                updatedAt: now,
              };
        await this.#routineStore.putExecutionControl(paused);
        if (owned && scopeCancelled(owned?.scope)) {
          await this.#clearSupersededControlUnderMutation(owned);
          return;
        }
        routine.status = "paused";
        routine.updatedAt = now;
        await this.#routineStore.putRoutine(routine);
        if (!scopeCancelled(owned?.scope))
          this.#emitControlEvent(
            routine.arcRunId,
            "control:paused",
            routine.id,
          );
        return paused;
      },
    );
    if (!paused || scopeCancelled(owned?.scope)) return;

    this.#logger.info("worker_hub.pause.paused", {
      arcRunId: routine.arcRunId,
      status: paused.status,
    });
  }

  async #markRoutineCapacityLimited(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    capacityReason: CapacityLimit,
    owned?: OwnedRoutine,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.#parkRoutine(
      routine,
      {
        arcRunId: routine.arcRunId,
        status: "capacity-limited",
        capacityLimitedAt: now,
        capacityLimitedRoutineId: routine.id,
        capacityReason,
        updatedAt: now,
      },
      () =>
        this.#emitRoutineCapacityLimitedEvent(
          routine,
          backend,
          node,
          capacityReason,
        ),
      {
        retryable: isTransientCapacity(capacityReason.reason),
        ...(capacityReason.retryAfterMs !== undefined
          ? { retryAfterMs: capacityReason.retryAfterMs }
          : {}),
      },
      owned,
    );
  }

  async #markRoutineTransportLost(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    transportReason: TransportLoss,
    owned?: OwnedRoutine,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.#parkRoutine(
      routine,
      {
        arcRunId: routine.arcRunId,
        status: "transport-lost",
        transportLostAt: now,
        transportLostRoutineId: routine.id,
        transportReason,
        updatedAt: now,
      },
      () =>
        this.#emitRoutineTransportLostEvent(
          routine,
          backend,
          node,
          transportReason,
        ),
      // A transport loss is always retryable (no hard variant) and carries no
      // provider retry-after, so recovery is pure backoff.
      { retryable: true },
      owned,
    );
  }

  /**
   * Shared park mechanism for both sibling parks. Persists the durable park
   * control, marks the routine parked, and emits its routine outcome. It then
   * schedules bounded auto-retry unless the user requested pause, and announces
   * the readable control park. Callers supply the control, routine event, and
   * retry policy (`retryable`, optional `retryAfterMs`).
   */
  async #parkRoutine(
    routine: RoutineState,
    control: Extract<
      ExecutionControlState,
      { status: "capacity-limited" | "transport-lost" }
    >,
    emitEvent: () => void,
    retry: { retryable: boolean; retryAfterMs?: number },
    owned?: OwnedRoutine,
  ): Promise<void> {
    // A park takes precedence over any pending pause-request as the run's durable
    // reason for not advancing, and its pointer is the only handle resume() has.
    // But remember whether the user had asked to pause: if so, the run is left
    // parked for a human and is NOT auto-retried, honoring the pause intent.
    const pauseDesired = await this.#controlMutations.run(
      routine.arcRunId,
      async () => {
        const prior = await this.#executionControlFor(routine.arcRunId);
        if (scopeCancelled(owned?.scope)) return undefined;
        if (owned) owned.controlBeforeSuspension = prior;
        await this.#routineStore.putExecutionControl(control);
        if (owned && scopeCancelled(owned?.scope)) {
          await this.#clearSupersededControlUnderMutation(owned);
          return undefined;
        }
        routine.status = control.status;
        routine.updatedAt = control.updatedAt;
        await this.#routineStore.putRoutine(routine);
        if (scopeCancelled(owned?.scope)) return undefined;
        emitEvent();
        this.#appendWorkEvent(() =>
          control.status === "capacity-limited"
            ? {
                kind: "control:parked",
                arcRunId: routine.arcRunId,
                status: control.status,
                capacityReason: control.capacityReason,
              }
            : {
                kind: "control:parked",
                arcRunId: routine.arcRunId,
                status: control.status,
                transportReason: control.transportReason,
              },
        );
        return prior.status === "paused" || prior.status === "pauseRequested";
      },
    );
    if (pauseDesired === undefined || scopeCancelled(owned?.scope)) return;
    this.#logger.info("worker_hub.routine.park.parked", {
      arcRunId: routine.arcRunId,
      routineId: routine.id,
      status: control.status,
      pauseDesired,
    });

    if (pauseDesired) {
      this.#logger.info("worker_hub.routine.park.pause_pending", {
        arcRunId: routine.arcRunId,
        routineId: routine.id,
        status: control.status,
      });
      return;
    }
    if (!scopeCancelled(owned?.scope))
      this.#scheduleRetry(routine.arcRunId, retry);
  }

  /**
   * Schedule a deferred auto-resume for a retryable park, bounded by
   * `maxAttempts` consecutive tries. A non-retryable park (a hard
   * `token usage limit`) is never retried — it would only re-block. Backoff uses
   * the provider `retryAfterMs` when present, else exponential off the base.
   */
  #scheduleRetry(
    arcRunId: ArcRunId,
    { retryable, retryAfterMs }: { retryable: boolean; retryAfterMs?: number },
  ): void {
    if (!this.#capacityRetry.enabled) return;
    if (!retryable) return;

    const prior = this.#capacityRetries.get(arcRunId);
    prior?.cancel();
    const attempts = (prior?.attempts ?? 0) + 1;
    if (attempts > this.#capacityRetry.maxAttempts) {
      this.#capacityRetries.set(arcRunId, { attempts, cancel: () => {} });
      this.#logger.info("worker_hub.routine.park.retry_exhausted", {
        arcRunId,
        attempts: attempts - 1,
      });
      return;
    }

    const delayMs = this.#capacityRetryDelayMs(retryAfterMs, attempts);
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    const cancel = this.#capacityRetry.schedule(() => {
      void this.#resumeRun(arcRunId, { auto: true }).catch((error: unknown) => {
        this.#logger.info("worker_hub.routine.park.retry_failed", {
          arcRunId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, delayMs);
    this.#capacityRetries.set(arcRunId, { attempts, cancel, nextAttemptAt });
    this.#logger.info("worker_hub.routine.park.retry_scheduled", {
      arcRunId,
      attempt: attempts,
      delayMs,
      nextAttemptAt,
    });
  }

  #capacityRetryDelayMs(
    retryAfterMs: number | undefined,
    attempt: number,
  ): number {
    const raw =
      retryAfterMs !== undefined
        ? retryAfterMs
        : this.#capacityRetry.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(raw, this.#capacityRetry.maxDelayMs);
  }

  /** Cancel and forget any pending auto-retry for a run. */
  #clearCapacityRetry(arcRunId: ArcRunId): void {
    const retry = this.#capacityRetries.get(arcRunId);
    if (!retry) return;
    retry.cancel();
    this.#capacityRetries.delete(arcRunId);
  }

  async #resumeParkedRoutine(
    routineId: string,
    origin: PausedRoutineOrigin | undefined,
    continuation?: PausedRoutineContinuation,
  ): Promise<void> {
    const routine = await this.#routineStore.getRoutine(routineId);
    if (
      !routine ||
      (routine.status !== "paused" &&
        routine.status !== "capacity-limited" &&
        routine.status !== "transport-lost")
    )
      return;
    const wasPark =
      routine.status === "capacity-limited" ||
      routine.status === "transport-lost";

    routine.status = "running";
    routine.error = undefined;
    routine.updatedAt = new Date().toISOString();
    await this.#routineStore.putRoutine(routine);

    const runContext = await this.#arcHost.getRunWorkspaceContext(
      routine.arcRunId,
    );
    const contextKey = workerContextKey(
      routine.task,
      runContext.reactivationCount,
    );
    const context = await this.#prepareRoutineContext(routine.task, {
      workspacePath: runContext.workspacePath,
      workspaceBundle: runContext.workspaceBundle,
      // Invoke the same assignment on its selected worker with the same routine
      // identity. The worker owns retaining and resuming provider execution state.
      routineResume: wasPark
        ? undefined
        : origin === "routine-start"
          ? { delivery: "fresh-start" }
          : { delivery: "continue" },
    });
    void this.#continueParkedRoutine(routine, context, contextKey, {
      requireContinuation: wasPark,
      continuation,
    }).catch(async (error: unknown) => {
      await this.#recordLapFailure(
        routine.arcRunId,
        error,
        continuation?.scope,
      );
      this.#failContinuation(continuation, error);
      this.#logger.info("worker_hub.routine.resume.failed", {
        routineId: routine.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async #continueParkedRoutine(
    routine: RoutineState,
    context: RoutineContext,
    contextKey: string,
    opts: {
      requireContinuation?: boolean;
      continuation?: PausedRoutineContinuation;
    } = {},
  ): Promise<void> {
    const continuation =
      opts.continuation ?? this.#pausedContinuations.get(routine.arcRunId);
    if (!this.#ownsContinuation(continuation)) return;
    if (!continuation && opts.requireContinuation) return;
    if (continuation) {
      this.#pausedContinuations.delete(routine.arcRunId);
      const pausedTask = continuation.tasks[continuation.pausedTaskIndex];
      if (!pausedTask || taskId(pausedTask) !== taskId(routine.task)) return;
    }

    const workScope = continuation?.scope;
    if (scopeCancelled(workScope)) return;
    let result: TaskResult;
    try {
      const node = await this.#nodeInfoForTask(routine.task);
      const selected =
        continuation?.selected ?? this.#resolvedWorkerForRoutine(routine);
      result = await this.#runRoutine(
        routine,
        context,
        contextKey,
        node,
        selected,
        workScope?.routines.get(routine.id),
        { resume: true },
      );
    } catch (error) {
      if (
        continuation &&
        !scopeCancelled(workScope) &&
        this.#ownsContinuation(continuation)
      )
        this.#pausedContinuations.set(routine.arcRunId, continuation);
      throw error;
    }
    // A non-queued result means the routine advanced (or failed) rather than
    // re-parking, so the consecutive auto-retry streak is over. A re-park would
    // have re-scheduled its own retry via #parkRoutine.
    if (result.status !== "queued") this.#clearCapacityRetry(routine.arcRunId);

    if (!continuation) return;

    const remainingTasks = continuation.tasks.slice(
      continuation.pausedTaskIndex + 1,
    );
    let remainingResults: TaskResult[] = [];
    if (
      result.status !== "queued" &&
      !isDispositionResult(result) &&
      !scopeCancelled(workScope)
    )
      remainingResults = await this.#handleTasks(remainingTasks, workScope);
    this.#scheduleRun(routine.arcRunId, [
      {
        kind: "task-results",
        arcRunId: continuation.arcRunId,
        stage: continuation.stage,
        frontier: continuation.frontier,
        scope: workScope,
        dialog: continuation.dialog,
        tasks: continuation.tasks,
        results: [
          ...continuation.completedResults,
          result,
          ...remainingResults,
        ],
        step: continuation.step,
        openedBy: "resume",
        submissionId: continuation.submissionId,
      },
    ]);
  }

  async #reconcilePauseRequestedIfQuiescent(arcRunId: ArcRunId): Promise<void> {
    const changed = await this.#controlMutations.run(arcRunId, async () => {
      const control = await this.#executionControlFor(arcRunId);
      if (control.status !== "pauseRequested") return false;
      if ((await this.#runningRoutines(arcRunId)).length > 0) return false;
      const now = new Date().toISOString();
      await this.#routineStore.putExecutionControl({
        arcRunId,
        status: "paused",
        requestedAt: control.requestedAt,
        pausedAt: now,
        updatedAt: now,
      });
      this.#emitControlEvent(arcRunId, "control:paused");
      return true;
    });
    if (!changed) return;
    this.#logger.info("worker_hub.pause.paused", {
      arcRunId,
      status: "paused",
    });
  }

  /** Register an observer notified after each durable work event append. */
  registerWorkEventHandler(handler: WorkEventHandler): () => void {
    this.#assertStarted();
    return this.#workEvents.registerWorkEventHandler(handler);
  }

  /** Read originator-visible work activity for one Arc run. */
  async listWorkEvents(arcRunId: ArcRunId): Promise<WorkEvent[]> {
    this.#assertStarted();
    return this.#workEvents.list(arcRunId);
  }

  #emitRoutineEvent(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    kind: Exclude<
      Extract<WorkEvent, { kind: `routine:${string}` }>["kind"],
      "routine:usage" | "routine:capacity-limited" | "routine:transport-lost"
    >,
    opts?: {
      outcome?: "completed" | "disposition";
      disposition?: TaskDisposition;
      error?: { code: string; message: string };
    },
  ): void {
    this.#appendWorkEvent(() => ({
      arcRunId: routine.arcRunId,
      kind,
      routineId: routine.id,
      role: routine.role,
      backend,
      nodeName: node.name,
      ...(node.description !== undefined
        ? { nodeDescription: node.description }
        : {}),
      ...(opts?.outcome !== undefined ? { outcome: opts.outcome } : {}),
      ...(opts?.disposition !== undefined
        ? { disposition: opts.disposition }
        : {}),
      ...(opts?.error !== undefined ? { error: opts.error } : {}),
    }));
  }

  #emitRoutineCapacityLimitedEvent(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    capacityReason: CapacityLimit,
  ): void {
    this.#appendWorkEvent(() => ({
      arcRunId: routine.arcRunId,
      kind: "routine:capacity-limited",
      routineId: routine.id,
      role: routine.role,
      backend,
      nodeName: node.name,
      ...(node.description !== undefined
        ? { nodeDescription: node.description }
        : {}),
      capacityReason,
    }));
  }

  #emitRoutineTransportLostEvent(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    transportReason: TransportLoss,
  ): void {
    this.#appendWorkEvent(() => ({
      arcRunId: routine.arcRunId,
      kind: "routine:transport-lost",
      routineId: routine.id,
      role: routine.role,
      backend,
      nodeName: node.name,
      ...(node.description !== undefined
        ? { nodeDescription: node.description }
        : {}),
      transportReason,
    }));
  }

  #emitBlockedEvent(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    input: BlockedEventFields,
  ): void {
    this.#appendWorkEvent(() => ({
      arcRunId: routine.arcRunId,
      routineId: routine.id,
      role: routine.role,
      backend,
      nodeName: node.name,
      ...(node.description !== undefined
        ? { nodeDescription: node.description }
        : {}),
      ...input,
    }));
  }

  #emitControlEvent(
    arcRunId: ArcRunId,
    kind: Exclude<ControlEvent["kind"], "control:parked">,
    routineId?: string,
  ): void {
    this.#appendWorkEvent(() => ({
      arcRunId,
      kind,
      ...(routineId !== undefined ? { routineId } : {}),
    }));
  }

  /** Check optional park visibility without making it a progression barrier. */
  #emitParkedControl(
    event: Extract<CreateWorkEventInput, { kind: "control:parked" }>,
    ownsCause: () => boolean,
  ): void {
    try {
      const captured = structuredClone(event);
      this.#workEvents.publishPrepared(captured.arcRunId, async () => {
        if (this.#lifecycle !== "started" || !ownsCause()) return;
        const control = await this.getExecutionControlView(captured.arcRunId);
        if (
          this.#lifecycle !== "started" ||
          !ownsCause() ||
          control.status !== captured.status
        )
          return;
        return captured;
      });
    } catch (error) {
      try {
        this.#logger.info("worker_hub.work_event.capture_failed", {
          message: String(error),
        });
      } catch {
        /* Optional diagnostics cannot change handback. */
      }
    }
  }

  #appendRoutineToolEvent(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    event: ToolEventInput,
  ): void {
    this.#appendWorkEvent(() => ({
      ...event,
      arcRunId: routine.arcRunId,
      routineId: routine.id,
      role: routine.role,
      backend,
      nodeName: node.name,
      ...(node.description !== undefined
        ? { nodeDescription: node.description }
        : {}),
    }));
  }

  #appendRoutineUsageEvent(
    routine: RoutineState,
    backend: BackendName,
    node: NodeInfo,
    tokenUsage: Extract<WorkEvent, { kind: "routine:usage" }>["tokenUsage"],
  ): void {
    this.#appendWorkEvent(() => ({
      arcRunId: routine.arcRunId,
      kind: "routine:usage",
      routineId: routine.id,
      role: routine.role,
      backend,
      nodeName: node.name,
      ...(node.description !== undefined
        ? { nodeDescription: node.description }
        : {}),
      tokenUsage,
    }));
  }

  /** Capture optional activity without awaiting storage or delivery. */
  #appendWorkEvent(
    input: CreateWorkEventInput | (() => CreateWorkEventInput),
  ): void {
    this.#workEvents.publish(input);
  }
}

function isInactiveRun(run: ArcRunView | undefined): boolean {
  return run?.stage === "actioning" && run.lifecycle !== "active";
}

/** Whether a task result reports a disposition, which ends its batch. */
function isDispositionResult(result: TaskResult): boolean {
  return (
    result.status === "finished" && result.report.outcome === "disposition"
  );
}

/**
 * Why a trigger task result fails its probe, if it does. Trigger tasks accept
 * no disposition, so one fails the probe like failed work.
 */
function triggerFailureReason(result: TaskResult): string | undefined {
  if (result.status !== "finished") return undefined;
  if (result.report.error === "failed") return result.report.message;
  const disposition = reportDisposition(result.report);
  if (disposition === undefined) return undefined;
  return `Worker reported disposition "${disposition}" on a trigger task, which accepts none.`;
}

/** The disposition a report carries, if any. */
function reportDisposition(report: RoutineReport): TaskDisposition | undefined {
  if (report.deflect) return "deflect";
  if (report.interrupt) return "interrupt";
  return undefined;
}

function flatReportLogFields(report: RoutineReport): {
  reportDiscriminator: "outcome" | "suspension" | "cancellation" | "error";
  reportValue: string;
  disposition?: TaskDisposition;
} {
  if (report.outcome !== undefined) {
    const disposition = reportDisposition(report);
    return {
      reportDiscriminator: "outcome",
      reportValue: report.outcome,
      ...(disposition ? { disposition } : {}),
    };
  }
  if (report.suspension !== undefined) {
    return {
      reportDiscriminator: "suspension",
      reportValue: report.suspension,
    };
  }
  if (report.cancellation !== undefined) {
    return {
      reportDiscriminator: "cancellation",
      reportValue: report.cancellation,
    };
  }
  return { reportDiscriminator: "error", reportValue: report.error };
}

function queueRouteCommands(commands: QueueRouteCommands): QueueRouteCommand[] {
  return Array.isArray(commands) ? commands : [commands];
}

/** Yield reason when a lap comes to rest at a frontier with nothing to dispatch. */
function restYieldReason(frontier: RunFrontier): LapYieldReason {
  return frontier.status === "completed" || frontier.status === "poisoned"
    ? "terminated"
    : "awaiting-input";
}

function backendFailureReport(error: unknown): RoutineReport {
  return {
    error: "failed",
    code: "backend-error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function advanceInputFromResults(
  tasks: readonly Task[],
  results: readonly TaskResult[],
):
  | Omit<
      Extract<AdvanceInput, { reports: readonly RoutineReport[] }>,
      "projectDialog"
    >
  | undefined {
  const reports: RoutineReport[] = [];
  const coverage: InstructionCoverage = {};

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const result = results[index];
    if (!task || !result) continue;

    if (result.status === "finished") {
      // A bare completed report carries no semantic or move info; skip the
      // runtime push so we don't litter advancement with no-op reports.
      const isBareCompleted =
        result.report.outcome === "completed" && !result.report.semantic;
      if (!isBareCompleted) reports.push(result.report);
    }

    if (task.kind !== "instruction") continue;
    const coverageIds = task.briefIds;
    if (result.status === "finished") {
      let coverageStatus: InstructionCoverage[string];
      const disposition = reportDisposition(result.report);
      if (disposition === "deflect") {
        coverageStatus = "deflected";
      } else if (disposition === "interrupt") {
        coverageStatus = "ignored";
      } else if (result.report.error === "failed") {
        coverageStatus = "failed";
      } else {
        coverageStatus = "applied";
      }
      for (const briefId of coverageIds) {
        coverage[briefId] = coverageStatus;
      }
      continue;
    }
    if (result.status === "queued") {
      for (const briefId of coverageIds) {
        coverage[briefId] = "ignored";
      }
      continue;
    }
    // status === "skipped": hub never dispatched. Omit coverage so the runtime
    // can retry on the next lap.
  }

  if (reports.length === 0 && Object.keys(coverage).length === 0) {
    return undefined;
  }

  return {
    reports,
    instructionCoverage: coverage,
    intent: "agent-work",
  };
}

function ensureOutboundNode(
  root: OutboundHandlerNode,
  path: readonly string[],
): OutboundHandlerNode {
  let node = root;
  for (const value of path) {
    if (value === "*") {
      node = node.wildcard ??= { exact: new Map() };
    } else {
      let next = node.exact.get(value);
      if (!next) {
        next = { exact: new Map() };
        node.exact.set(value, next);
      }
      node = next;
    }
  }
  return node;
}

/** Whether a registered situation matches one under exact-or-`"*"` slots. */
function situationMatches(
  pattern: OutboundSituation,
  situation: OutboundSituation,
): boolean {
  return (
    (pattern.role === "*" || pattern.role === situation.role) &&
    (pattern.audience === "*" || pattern.audience === situation.audience) &&
    (pattern.cause === "*" || pattern.cause === situation.cause)
  );
}

function collectOutboundHandlers(
  node: OutboundHandlerNode,
  path: readonly string[],
  out: OutboundMessageHandler[],
): void {
  if (path.length === 0) {
    if (node.handlers) out.push(...node.handlers);
    return;
  }
  const [head, ...rest] = path;
  const exact = node.exact.get(head!);
  if (exact) collectOutboundHandlers(exact, rest, out);
  if (node.wildcard) collectOutboundHandlers(node.wildcard, rest, out);
}

function readAskIdFromMetadata(
  metadata: InboundMessage["metadata"],
): string | undefined {
  const value = metadata?.["askId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readToolCallIdFromMetadata(
  metadata: InboundMessage["metadata"],
): string | undefined {
  const value = metadata?.["toolCallId"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasReservedAnswerCorrelationMetadata(
  metadata: InboundMessage["metadata"],
): boolean {
  return (
    metadata !== undefined &&
    Object.prototype.hasOwnProperty.call(metadata, "askId")
  );
}

function readPermissionVerdict(
  message: InboundMessage,
): PermissionVerdict | undefined {
  const metadata = message.metadata ?? {};
  const rawDecision = metadata["decision"];
  if (
    rawDecision !== "allow" &&
    rawDecision !== "deny" &&
    rawDecision !== "allow_this_run"
  ) {
    return undefined;
  }
  const updatedInputRaw = metadata["updatedInput"];
  if (
    updatedInputRaw !== undefined &&
    (updatedInputRaw === null ||
      typeof updatedInputRaw !== "object" ||
      Array.isArray(updatedInputRaw))
  ) {
    return undefined;
  }
  const updatedInput =
    updatedInputRaw !== undefined
      ? (updatedInputRaw as Record<string, unknown>)
      : undefined;
  const trimmed = message.content.trim();
  return {
    decision: rawDecision,
    updatedInput,
    message: trimmed.length > 0 ? trimmed : undefined,
  };
}

function outboundContentToDialogText(
  content: OutboundMessage["content"],
): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function describeRoutine(
  routine: RoutineState,
  contextKey: string,
): RoutineDescriptor {
  return deepFreeze(
    structuredClone({
      id: routine.id,
      arcRunId: routine.arcRunId,
      role: routine.role,
      contextKey,
      task: routine.task,
    }),
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function formatPermissionAskContent(
  role: string,
  toolName: string,
  input: Record<string, unknown>,
): string {
  return [
    `The "${role}" worker is requesting permission to use the ${toolName} tool.`,
    "",
    "Input:",
    JSON.stringify(input, null, 2),
    "",
    "Reply with `allow`, `deny`, or `allow_this_run`.",
  ].join("\n");
}

/** Captured scopes remain cancelled after their service index is removed. */
function scopeCancelled(scope: FrontierWorkScope | undefined): boolean {
  return scope !== undefined && (scope.released || scope.superseded);
}

function scopeCancellationMessage(
  scope: FrontierWorkScope | undefined,
): string {
  return scope?.superseded
    ? "Run interruption superseded this frontier."
    : "Action execution was released.";
}
