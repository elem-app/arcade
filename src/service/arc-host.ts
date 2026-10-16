import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, rmdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversalSet,
  BriefId,
  Dialog,
  InstructionBrief,
  NodeRef,
  ObservationGroupReport,
  ObservationReport,
  PayloadValue,
  SemanticText,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "@elem-app/arc/runtime";
import {
  findActiveRoot,
  isArtifactValue,
  Runtime,
  toArcRef,
  toArcRefParts,
  toNodeRef,
  toNodeRefParts,
  validateActionReport,
} from "@elem-app/arc/runtime";
import type {
  Node as ArcNode,
  PayloadValue as ArcPayloadValue,
  Statement as ArcStatement,
  StructValue as ArcStructValue,
  Document,
  HostModuleSpec,
} from "@elem-app/arc/types";
import { validateHostModuleSpec } from "@elem-app/arc/types";

import { DEFAULT_WORKER_ROLE } from "../constants.js";
import {
  buildInstructionTaskFromBriefs,
  instructionTaskSourceRef,
  readWorkerInstruction,
  type WorkerInstruction,
} from "../instructions/worker-role.js";
import { createArcadeLogger, type ArcadeLogger } from "../logging.js";
import {
  arcRunKey,
  structurallyEqual,
  type ArcHostStore,
  type CreateWorkEventInput,
  type ReplayStore,
  type WorkerHubStore,
} from "../storage/base.js";
import type {
  ArcDocumentSnapshotId,
  ArcRunId,
  ArcRunLifecycle,
} from "../types/core.js";
import type {
  HandshakeOutcome,
  HandshakeResolution,
  PendingHandshake,
  PendingReentrySelection,
  PendingTriggerSelection,
  RunChoiceCandidate,
} from "../types/handshake.js";
import type {
  HostModule,
  HostModuleEffect,
  HostModuleState,
} from "../types/host-module.js";
import {
  assertHostModuleState,
  assertModuleEffect,
} from "../types/host-module.js";
import type {
  ActivationPolicy,
  AdvanceInput,
  ArcDocumentSnapshot,
  ArcHostStep,
  ArcManifest,
  ArcRunState,
  ArcRunView,
  BeginInput,
  DialogProjector,
  InstructionCoverage,
  ResolveHandshakeResult,
  RunFrontier,
  RunTransition,
} from "../types/host.js";
import {
  handoffCheckpoint,
  type ActionReplayPosition,
  type ActionReplayStep,
  type CompatibleReplay,
  type FailedReplay,
  type JumpedReplay,
  type RegeneratedReplay,
  type ReplayCheckpoint,
  type ReplayStep,
  type TriggerReplayStep,
} from "../types/replay.js";
import type { RoutineReport } from "../types/routine.js";
import type {
  ContextIsolation,
  InstructionIssue,
  InstructionTask,
  SemanticRequest,
  SemanticTask,
} from "../types/task.js";
import { KeyedSerializer } from "../utils/keyed-serializer.js";
import { HandshakeStore } from "./handshake.js";
import { audienceDeclaration } from "./host-module-declarations.js";
import { ModuleExecution } from "./module-execution.js";
import { RecordingRuntime } from "./replay-recorder.js";
import {
  alignActionReplay,
  alignTriggerReplay,
  createReplayIso,
} from "./replay-verify.js";
import type { WorkEventService } from "./work-events.js";
import { semanticTaskSourceRef } from "./worker-context.js";

const DEFAULT_ARC_MANIFEST: ArcManifest = {
  workspaceScope: "run",
  bundle: {},
  contextIsolation: "role",
};

/** One document update committed as part of an Arc registration transaction. */
export type ArcRegistrationInput = {
  source: string;
  document: Document;
  manifest?: ArcManifest;
  workspacePath?: string;
  replace?: boolean;
};

/**
 * Arc node metadata.
 */
export type NodeInfo = { name: string; description?: string };

type RegisteredArc = {
  source: string;
  identifier: string;
  document: Document;
  documentRecordId: string;
  manifest: ArcManifest;
  workspacePath?: string;
};

type ArcRunRuntimeState = {
  hostModules: HostModuleState;
  arcRef: ArcRef;
  deps: readonly ArcRef[];
  snapshotId: ArcDocumentSnapshotId;
  traversals: ArcTraversalSet;
  reactivationCount: number;
  workspacePath: string;
  contextIsolation: ContextIsolation;
  ownerPrincipal: string;
  artifactPaths: readonly string[];
};

/** One matched arc's seed, derived from a single trigger resolution. */
type TriggerMatch = {
  arcRef: ArcRef;
  deps: readonly ArcRef[];
  traversals: ArcTraversalSet;
};

type TriggerPlanResult =
  | { status: "idle" }
  | {
      status: "ready";
      deps: readonly ArcRef[];
      snapshotId: ArcDocumentSnapshotId;
      brief: TriggerBrief;
    }
  | {
      status: "matched";
      // Every matchable arc is seeded and activated (fan-out), not just one.
      matches: readonly TriggerMatch[];
      // One snapshot pinned over the union of all matches' deps.
      snapshotId: ArcDocumentSnapshotId;
    };

type TriggerProbeOrigin =
  | { kind: "fresh"; recordIds: ReadonlyMap<string, string> }
  | {
      kind: "deflected";
      state: ArcRunState;
      reactivationCount: number;
      order: number;
    };

type ActivationCandidateGroup = {
  arcRef: ArcRef;
  fresh?: PendingTriggerSelection;
  reentries: PendingReentrySelection[];
  order: number;
};

type ActivationBatch = {
  id: string;
  dialog: Dialog;
  request: ActivationRequest;
  groups: Map<ArcRef, ActivationCandidateGroup>;
  pendingProbeIds: Set<ArcRunId>;
  cancelExpiry: () => void;
};

type LiveArcSession =
  | ActionSession
  | {
      kind: "preparing";
      ownerPrincipal: string;
      arcRef: ArcRef;
      workspacePath?: string;
    }
  | {
      kind: "triggering";
      recorder: RecordingRuntime;
      deps: readonly ArcRef[];
      snapshotId: ArcDocumentSnapshotId;
      brief: TriggerBrief;
      workspacePath: string;
      // The activation request is captured on the live session so an id-addressed
      // advance can re-derive it (principal / clientId / activationPolicy /
      // inbound) without the caller threading it back through.
      request: ActivationRequest;
      batchId?: string;
      origin?: TriggerProbeOrigin;
    };

type PlannedRunStartResult =
  | { kind: "idle" }
  | { kind: "invalid"; reason: string }
  | { kind: "trigger"; arcRunId: ArcRunId; frontier: RunFrontier }
  | { kind: "matched"; arcRunId: ArcRunId; frontier: RunFrontier };

type PreparationOperation = {
  entry?: Extract<LiveArcSession, { kind: "preparing" }>;
  arcRunId?: ArcRunId;
};

type RunEventCollection = {
  start?: Extract<CreateWorkEventInput, { kind: "run:started" }>;
  staged: CreateWorkEventInput[];
  committed: CreateWorkEventInput[];
  onCommit: (() => void)[];
  publications?: Promise<unknown>[];
};

type LiveAction = {
  state: ArcRunRuntimeState;
  brief: ActionBrief;
  recorder: RecordingRuntime;
};

type ActionSession = {
  kind: "actioning";
  generation: string;
  preparation?: Extract<LiveArcSession, { kind: "preparing" }>;
  admissionId?: string;
  frontier?: RunFrontier;
  phase:
    | { kind: "starting" }
    | { kind: "live"; live: LiveAction; settlement: "ready" | "pending" }
    | { kind: "ended" };
};

const MAX_SETTLE_STEPS = 32;
/**
 * Backstop on inline-acknowledged transitions per settle. Transitions are
 * cheap yield points and do not count toward `MAX_SETTLE_STEPS`; this bound
 * only guards a runaway loop.
 */
const MAX_SETTLE_TRANSITIONS = 256;
const MAX_TRIGGER_STEPS = 8;
const DEFAULT_SNAPSHOT_RUNTIME_CACHE_SIZE = 32;
const DEFAULT_ACTIVATION_BATCH_TTL_MS = 5 * 60 * 1000;

export type ArcHostServiceIssue =
  | {
      kind: "invalid-instruction";
      issues: InstructionIssue[];
      instructionId: string;
      text: string;
    }
  | { kind: "runtime"; reason: string };

/** Constructor options for `ArcHostService`. */
export type ArcHostServiceOptions = {
  /** Policy-neutral event publisher shared with the worker hub. */
  workEvents: WorkEventService;
  /** Durable store for registered sources, traversal state, and host events. */
  store: ArcHostStore;
  /** Read the same run execution-control state that the worker hub updates. */
  executionControl: Pick<WorkerHubStore, "getExecutionControl">;
  /** Root directory used to resolve run-scoped Arc workspaces. */
  artifactRoot?: string;
  /** Optional pending-handshake store for `workspaceScope: "arc"` activations. */
  handshakes?: HandshakeStore;
  /**
   * Maximum number of immutable snapshot runtimes to keep in memory.
   *
   * Defaults to 32. Set to 0 to disable runtime caching.
   */
  snapshotRuntimeCacheSize?: number;
  /** Maximum lifetime of an unresolved multi-probe activation batch. */
  activationBatchTtlMs?: number;
  /**
   * Optional replay store. When supplied, the host records the trigger/action
   * brief and report streams plus the action checkpoints for each run, enabling
   * replay verification and fork operations. When omitted, recording is off and
   * behavior is unchanged.
   */
  replayStore?: ReplayStore;
  /** Optional logger. Defaults to a silent logger. */
  logger?: ArcadeLogger;
};

type ActivationRequest = {
  /** Connector-tagged client id recorded on staged handshakes. */
  clientId?: string;
  /** Opaque connector-supplied principal for this activation request. */
  principal: string;
  /** How many matchable arcs to activate; defaults to `first`. */
  activationPolicy: ActivationPolicy;
};

/**
 * Adapter-facing Arc host service with an explicit begin/advance lifecycle.
 *
 * Callers pass facts about one inbound message to `begin(...)`, which returns
 * the `ArcHostStep[]` worklist. Each step is id-addressed; callers submit
 * trigger feedback through `advanceTrigger`, action feedback through
 * `advanceAction`, and release
 * the process-local action session through `releaseAction`.
 *
 * The service keeps Arc runtime brief objects in memory for the active process
 * and persists only durable traversal state through `ArcHostStore`.
 */
export class ArcHostService {
  readonly #actionMutations = new KeyedSerializer<ArcRunId>();
  readonly #frontierIds = new WeakMap<object, string>();
  readonly #moduleExecutions = new Map<ArcRunId, ModuleExecution>();
  #stopped = false;
  readonly #committedControlBriefs = new WeakSet<ActionBrief>();
  readonly #store: ArcHostStore;
  readonly #executionControl: Pick<WorkerHubStore, "getExecutionControl">;
  readonly #workEvents: WorkEventService;
  readonly #logger: ArcadeLogger;
  #latestRuntime = new Runtime().init();
  readonly #snapshotRuntimes = new Map<ArcDocumentSnapshotId, Runtime>();
  readonly #arcs = new Map<ArcRef, RegisteredArc>();
  readonly #hostModules = new Map<string, HostModule>();
  readonly #latestDocumentRecordIds = new Map<string, string>();
  readonly #liveSessions = new Map<string, LiveArcSession>();
  readonly #activationBatches = new Map<string, ActivationBatch>();
  readonly #reentrySerializer = new KeyedSerializer<ArcRunId>();
  readonly #artifactRoot: string;
  readonly #handshakes: HandshakeStore;
  readonly #replayStore: ReplayStore | undefined;
  readonly #snapshotRuntimeCacheSize: number;
  readonly #activationBatchTtlMs: number;

  /** Create an Arc host bound to the supplied durable state store. */
  constructor(opts: ArcHostServiceOptions) {
    this.#store = opts.store;
    this.#executionControl = opts.executionControl;
    this.#workEvents = opts.workEvents;
    this.#logger = opts.logger ?? createArcadeLogger();
    this.#artifactRoot = opts.artifactRoot ?? ".arcade-artifacts";
    this.#handshakes =
      opts.handshakes ?? new HandshakeStore({ logger: this.#logger });
    this.#replayStore = opts.replayStore;
    this.#snapshotRuntimeCacheSize = Math.max(
      0,
      Math.trunc(
        opts.snapshotRuntimeCacheSize ?? DEFAULT_SNAPSHOT_RUNTIME_CACHE_SIZE,
      ),
    );
    this.#activationBatchTtlMs = Math.max(
      1,
      Math.trunc(opts.activationBatchTtlMs ?? DEFAULT_ACTIVATION_BATCH_TTL_MS),
    );
    this.registerHostModule("audience", {
      declaration: audienceDeclaration,
    });
  }

  /** Abort host module resources before waiting for in-flight host operations. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const batch of this.#activationBatches.values()) batch.cancelExpiry();
    this.#activationBatches.clear();
    for (const execution of this.#moduleExecutions.values()) execution.abort();
    const results = await Promise.allSettled(
      [...this.#moduleExecutions.keys()].map((arcRunId) =>
        this.#actionMutations.run(arcRunId, () =>
          this.#retireExecution(arcRunId),
        ),
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(errors, "Host execution cleanup failed.");
  }

  async #openModuleExecution(
    arcRunId: ArcRunId,
    action: boolean,
  ): Promise<void> {
    const previous = this.#moduleExecutions.get(arcRunId);
    if (previous) await previous.release();
    if (this.#stopped) throw new Error("The arc host has stopped.");
    this.#moduleExecutions.set(
      arcRunId,
      new ModuleExecution(arcRunId, action, this.#hostModules),
    );
  }

  async #retireExecution(arcRunId: ArcRunId): Promise<void> {
    const execution = this.#moduleExecutions.get(arcRunId);
    execution?.abort();
    this.#liveSessions.delete(arcRunKey(arcRunId));
    try {
      await execution?.release();
    } finally {
      if (this.#moduleExecutions.get(arcRunId) === execution)
        this.#moduleExecutions.delete(arcRunId);
    }
  }

  /** Read run permission at each execution boundary, independently of hub dispatch. */
  async #canAdvance(arcRunId: ArcRunId): Promise<boolean> {
    if (this.#stopped) return false;
    this.#moduleExecutions.get(arcRunId)?.assertOpen();
    const control = await this.#executionControl.getExecutionControl(arcRunId);
    this.#moduleExecutions.get(arcRunId)?.assertOpen();
    return !this.#stopped && (control?.status ?? "running") === "running";
  }

  #frontierId(brief: object, arcRunId?: ArcRunId): string {
    let id = this.#frontierIds.get(brief);
    if (!id) {
      const generation = arcRunId && this.#actionSession(arcRunId)?.generation;
      id = generation ? `${generation}:${randomUUID()}` : randomUUID();
      this.#frontierIds.set(brief, id);
    }
    return id;
  }

  /** @internal Inspect process-local session retention in deterministic tests. */
  getLiveSessionCounts(): {
    preparing: number;
    triggering: number;
    actioning: number;
  } {
    const counts = {
      preparing: 0,
      triggering: 0,
      actioning: 0,
    };
    for (const session of this.#liveSessions.values()) counts[session.kind]++;
    return counts;
  }

  #actionSession(arcRunId: ArcRunId): ActionSession | undefined {
    const session = this.#liveSessions.get(arcRunKey(arcRunId));
    return session?.kind === "actioning" ? session : undefined;
  }

  async #newActionSession(arcRunId: ArcRunId): Promise<ActionSession> {
    const previous = this.#liveSessions.get(arcRunKey(arcRunId));
    await this.#openModuleExecution(arcRunId, true);
    const session: ActionSession = {
      kind: "actioning",
      generation: randomUUID(),
      phase: { kind: "starting" },
      preparation: previous?.kind === "preparing" ? previous : undefined,
    };
    this.#liveSessions.set(arcRunKey(arcRunId), session);
    return session;
  }

  async #retireAction(
    arcRunId: ArcRunId,
    execution: ActionSession,
  ): Promise<void> {
    if (this.#actionSession(arcRunId) !== execution) return;
    execution.admissionId = undefined;
    execution.frontier = undefined;
    execution.phase = { kind: "ended" };
    await this.#retireExecution(arcRunId);
  }

  /** Relinquish this execution while preserving its committed durable state. */
  releaseAction(arcRunId: ArcRunId, frontierId: string): Promise<void> {
    const trigger = this.#liveSessions.get(arcRunKey(arcRunId));
    if (
      trigger?.kind === "triggering" &&
      this.#frontierId(trigger.brief) === frontierId
    ) {
      this.#moduleExecutions.get(arcRunId)?.abort();
      return this.#actionMutations.run(arcRunId, async () => {
        if (this.#liveSessions.get(arcRunKey(arcRunId)) === trigger)
          await this.#retireExecution(arcRunId);
      });
    }
    const execution = this.#actionSession(arcRunId);
    if (!execution || !frontierId.startsWith(`${execution.generation}:`))
      return Promise.resolve();
    this.#moduleExecutions.get(arcRunId)?.abort();
    return this.#actionMutations.run(arcRunId, () =>
      this.#retireAction(arcRunId, execution),
    );
  }

  #liveAction(arcRunId: ArcRunId): LiveAction | undefined {
    const phase = this.#actionSession(arcRunId)?.phase;
    return phase?.kind === "live" ? phase.live : undefined;
  }

  #installFrontier(execution: ActionSession, frontier: RunFrontier): void {
    execution.frontier = frontier;
    execution.admissionId = frontier.frontierId;
    if (!frontier.canProgress) {
      execution.phase = { kind: "ended" };
    }
  }

  #mutateAction(
    arcRunId: ArcRunId,
    frontierId: string,
    operation: () => Promise<RunFrontier>,
  ): Promise<RunFrontier> {
    return this.#actionMutations.run(arcRunId, () => {
      const session = this.#actionSession(arcRunId);
      if (!frontierId)
        throw new TypeError(
          "Action advancement requires its originating frontierId.",
        );
      if (
        !session?.frontier ||
        !frontierId.startsWith(`${session.generation}:`)
      )
        throw new Error(
          "Begin action execution before advancing its frontier.",
        );
      return this.#mutateActionLocked(arcRunId, operation);
    });
  }

  /** Each caller mutation owns its returned frontier and cleanup on failure. */
  async #mutateActionLocked(
    arcRunId: ArcRunId,
    operation: () => Promise<RunFrontier>,
  ): Promise<RunFrontier> {
    const execution = this.#actionSession(arcRunId);
    if (!execution)
      throw new Error("Begin action execution before advancing its frontier.");
    try {
      this.#moduleExecutions.get(arcRunId)?.assertOpen();
      const frontier = await operation();
      this.#moduleExecutions.get(arcRunId)?.assertOpen();
      if (this.#actionSession(arcRunId) === execution)
        this.#installFrontier(execution, frontier);
      return frontier;
    } catch (error) {
      try {
        await this.#retireAction(arcRunId, execution);
      } catch (cleanupError) {
        this.#logger.info("arc_host.cleanup.failed", {
          arcRunId,
          message: String(cleanupError),
        });
      }
      throw error;
    }
  }

  /**
   * Register the declaration and implementer of one `host:*` module. The host
   * owns the host-module registry; embedders and connectors register a module
   * here rather than intercepting frontiers. At most one registration per
   * module — registering a second for the same module throws. Returns an
   * unregister function.
   */
  registerHostModule(module: string, impl: HostModule): () => void {
    if (this.#hostModules.has(module)) {
      throw new Error(`Host module "${module}" already has an implementer.`);
    }

    const nextModules = new Map(this.#hostModules);
    nextModules.set(module, impl);
    const latestDocuments = this.#latestDocuments();
    const nextRuntime = this.#buildRuntime(
      latestDocuments,
      this.#hostModuleSpecs(nextModules),
    );
    assertHostDispatcherContracts(latestDocuments, nextModules);

    const ownedImplementation: HostModule = {
      ...impl,
      declaration: structuredClone(impl.declaration),
    };
    this.#hostModules.set(module, ownedImplementation);
    this.#latestRuntime = nextRuntime;
    this.#snapshotRuntimes.clear();
    return () => {
      if (this.#hostModules.get(module) !== ownedImplementation) return;

      const remainingModules = new Map(this.#hostModules);
      remainingModules.delete(module);
      const remainingDocuments = this.#latestDocuments();
      const remainingRuntime = this.#buildRuntime(
        remainingDocuments,
        this.#hostModuleSpecs(remainingModules),
      );
      assertHostDispatcherContracts(remainingDocuments, remainingModules);

      this.#hostModules.delete(module);
      this.#latestRuntime = remainingRuntime;
      this.#snapshotRuntimes.clear();
    };
  }

  #hostModuleSpecs(
    modules: ReadonlyMap<string, HostModule> = this.#hostModules,
  ): ReadonlyMap<string, HostModuleSpec> {
    return new Map(
      [...modules].map(([module, implementation]) => [
        module,
        implementation.declaration,
      ]),
    );
  }

  #latestDocuments(): ReadonlyMap<string, Document> {
    const documents = new Map<string, Document>();
    for (const registered of this.#arcs.values()) {
      if (!documents.has(registered.source)) {
        documents.set(registered.source, registered.document);
      }
    }
    return documents;
  }

  #buildRuntime(
    documents: ReadonlyMap<string, Document>,
    hostModules: ReadonlyMap<string, HostModuleSpec> = this.#hostModuleSpecs(),
  ): Runtime {
    const runtime = new Runtime({ hostModules });
    for (const [source, document] of documents) {
      runtime.add(source, document);
    }
    return runtime.init();
  }

  /**
   * Register every root Arc in a parsed Arc document.
   *
   * `source` must match the source name used by imports and persisted Arc
   * refs. Registration adds the document to the latest in-process runtime,
   * stores the latest source for diagnostics, and stores an immutable document
   * record that future activation snapshots can reference.
   */
  async registerArc(
    source: string,
    document: Document,
    manifest: ArcManifest = DEFAULT_ARC_MANIFEST,
    opts: { workspacePath?: string; replace?: boolean } = {},
  ): Promise<void> {
    return this.registerArcs([{ source, document, manifest, ...opts }]);
  }

  /** Validate and commit a complete Arc document update as one registry batch. */
  async registerArcs(
    registrations: readonly ArcRegistrationInput[],
  ): Promise<void> {
    if (registrations.length === 0) return;
    const batchSources = new Set<string>();
    const prepared = registrations.map((registration) => {
      const { source, document } = registration;
      if (batchSources.has(source)) {
        throw new Error(
          `Duplicate Arc source in registration batch: ${source}`,
        );
      }
      batchSources.add(source);
      if (document.roots.length === 0) {
        throw new Error(`Document for source "${source}" has no arc roots.`);
      }
      assertWorkerRoleContracts(source, document);
      const manifest = registration.manifest ?? DEFAULT_ARC_MANIFEST;
      const workspacePath =
        manifest.workspaceScope === "arc" &&
        registration.workspacePath !== undefined
          ? resolve(registration.workspacePath)
          : undefined;
      if (!registration.replace) {
        for (const root of document.roots) {
          const arc = toArcRef(source, root.identifier);
          if (this.#arcs.has(arc)) {
            throw new Error(
              `Duplicate registered ArcRef: ${source}/${root.identifier} (${arc})`,
            );
          }
        }
        if (this.#latestDocumentRecordIds.has(source)) {
          throw new Error(`Arc source already registered: ${source}`);
        }
      }
      return { source, document, manifest, workspacePath };
    });

    // Build the prospective latest runtime before committing any registration
    // state. Existing runs remain pinned to their immutable document snapshots;
    // only future trigger evaluation sees this replacement.
    const latestDocuments = new Map(this.#latestDocuments());
    for (const source of batchSources) latestDocuments.delete(source);
    for (const registration of prepared) {
      latestDocuments.set(registration.source, registration.document);
    }
    const nextRuntime = this.#buildRuntime(latestDocuments);
    assertHostDispatcherContracts(latestDocuments, this.#hostModules);

    const at = new Date().toISOString();
    const commits = prepared.map((registration) => ({
      ...registration,
      documentRecordId: `arc-doc:${randomUUID()}`,
    }));
    for (const commit of commits) {
      await this.#store.putArcDocumentRecord({
        id: commit.documentRecordId,
        source: commit.source,
        document: commit.document,
        createdAt: at,
      });
      await this.#store.putArcSource(commit.source, commit.document);
    }
    for (const [arcRef, registered] of this.#arcs) {
      if (batchSources.has(registered.source)) this.#arcs.delete(arcRef);
    }
    this.#latestRuntime = nextRuntime;
    for (const commit of commits) {
      this.#latestDocumentRecordIds.set(commit.source, commit.documentRecordId);
      for (const root of commit.document.roots) {
        const arc = toArcRef(commit.source, root.identifier);
        this.#arcs.set(arc, {
          source: commit.source,
          identifier: root.identifier,
          document: commit.document,
          documentRecordId: commit.documentRecordId,
          manifest: commit.manifest,
          workspacePath: commit.workspacePath,
        });
        this.#logger.info("arc_host.registered", {
          source: commit.source,
          root: root.identifier,
          manifest: commit.manifest,
          workspacePath: commit.workspacePath,
        });
      }
    }
  }

  /** Return stable parsed-node metadata for a runtime source node ref. */
  nodeInfoForRef(ref: NodeRef): NodeInfo {
    const node = this.#latestRuntime.nodeForRef(ref);
    if (!node) {
      throw new Error(`No registered Arc node for source ref ${ref}.`);
    }
    return {
      name: node.identifier,
      description: node.description,
    };
  }

  /** Return node metadata from the immutable document snapshot of one run. */
  async nodeInfoForRunRef(arcRunId: ArcRunId, ref: NodeRef): Promise<NodeInfo> {
    const state = await this.#stateFor(arcRunId);
    if (!state) throw new Error(`Unknown Arc run ${arcRunId}.`);
    const runtime = await this.#runtimeForSnapshot(state.snapshotId);
    const node = runtime.nodeForRef(ref);
    if (!node) {
      throw new Error(
        `Arc run ${arcRunId} snapshot has no node for source ref ${ref}.`,
      );
    }
    return {
      name: node.identifier,
      description: node.description,
    };
  }

  /**
   * Set of worker roles referenced by any registered arc document.
   *
   * Includes `DEFAULT_WORKER_ROLE` because any instruction without a declared
   * worker role falls back to it at dispatch time. Used by transport connectors
   * to expand wildcard delivery rules against the actual roles present in the
   * deployment.
   */
  knownWorkerRoles(): Set<string> {
    const roles = new Set<string>([DEFAULT_WORKER_ROLE]);
    for (const arc of this.#arcs.values()) {
      collectWorkerRolesFromDocument(arc.document, roles);
    }
    return roles;
  }

  /**
   * Returns a view of current live preparation or persisted execution.
   * Returns undefined when neither exists for the identity. Persisted execution
   * takes precedence. At run:started, the selected run has an actioning view.
   * Reads capture live preparation before awaiting storage and never persist it.
   */
  async getRunView(arcRunId: ArcRunId): Promise<ArcRunView | undefined> {
    const preparation = this.#readPreparationView(arcRunId);
    const state = await this.#store.getState(arcRunKey(arcRunId));
    return state ? arcRunView(state) : preparation;
  }

  async getRunWorkspaceContext(arcRunId: ArcRunId): Promise<{
    workspacePath: string;
    workspaceBundle: Record<string, string>;
    reactivationCount: number;
  }> {
    const action = this.#liveAction(arcRunId);
    const live = this.#liveSessions.get(arcRunKey(arcRunId));
    if (action) {
      const arc = this.#arcs.get(action.state.arcRef);
      const manifest = cloneArcManifest(arc?.manifest);
      return {
        workspacePath: action.state.workspacePath,
        workspaceBundle: { ...manifest.bundle },
        reactivationCount: action.state.reactivationCount,
      };
    }
    if (live?.kind === "triggering") {
      const registered = this.#registeredArcForReadyPlan({
        status: "ready",
        deps: live.deps,
        snapshotId: live.snapshotId,
        brief: live.brief,
      });
      const manifest = cloneArcManifest(registered?.arc.manifest);
      return {
        workspacePath: live.workspacePath,
        workspaceBundle: { ...manifest.bundle },
        reactivationCount: 0,
      };
    }

    const state = await this.#store.getState(arcRunKey(arcRunId));
    if (!state) {
      throw new Error(`Arc run ${arcRunId} has no workspace context.`);
    }
    const arc = this.#arcs.get(state.arcRef);
    const manifest = cloneArcManifest(arc?.manifest);
    return {
      workspacePath: state.workspacePath,
      workspaceBundle: { ...manifest.bundle },
      reactivationCount: state.reactivationCount,
    };
  }

  /**
   * Delete abandoned run workspaces under the artifact root, returning the count.
   *
   * Until trigger-stage semantic work was exempted from workspace
   * materialization, every trigger probe created a run workspace under its
   * provisional probe id — an id that is not a run and never becomes one — so a
   * deployment accumulates one empty directory per probe. This removes those
   * leftovers.
   *
   * Three gates keep it from touching live data, and the last makes loss
   * structurally impossible:
   *
   * 1. Only directories named exactly as `defaultRunWorkspaceRoot` writes them
   *    are considered, so an arc-scoped or discovered workspace that happens to
   *    sit under the artifact root is never a candidate.
   * 2. Only ids with no persisted run state are considered.
   * 3. Removal uses `rmdir`, which fails on a non-empty directory. A probe
   *    workspace is empty by construction because nothing ever wrote to it, so
   *    anything holding content survives even if the first two gates are wrong.
   */
  async pruneOrphanedRunWorkspaces(): Promise<number> {
    const root = resolve(this.#artifactRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      // No artifact root yet: nothing was ever materialized.
      return 0;
    }

    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const arcRunId = runIdFromWorkspaceDirName(entry.name);
      if (arcRunId === undefined) continue;
      if (await this.#store.getState(arcRunKey(arcRunId))) continue;
      try {
        await rmdir(join(root, entry.name));
      } catch {
        // Non-empty, or removed concurrently. Either way, leave it alone.
        continue;
      }
      removed += 1;
      this.#logger.info("arc_host.workspace.orphan_pruned", {
        arcRunId,
        workspacePath: join(root, entry.name),
      });
    }
    if (removed > 0) {
      this.#logger.info("arc_host.workspace.orphans_pruned", {
        artifactRoot: root,
        removed,
      });
    }
    return removed;
  }

  /** List live preparation and persisted execution views, optionally by owner. */
  async listRunViews(ownerPrincipal?: string): Promise<ArcRunView[]> {
    const ids = new Set<ArcRunId>();
    for await (const [, state] of this.#store.listStates())
      ids.add(state.arcRunId);
    for (const key of this.#liveSessions.keys())
      ids.add(decodeURIComponent(key));
    for (const handshake of this.#handshakes.listPending())
      ids.add(handshake.triggerSelection.arcRunId);
    const runs: ArcRunView[] = [];
    for (const id of ids) {
      const view = await this.getRunView(id);
      if (
        view &&
        (ownerPrincipal === undefined || view.ownerPrincipal === ownerPrincipal)
      )
        runs.push(view);
    }
    return runs.sort((a, b) => {
      if (a.stage === "actioning" && b.stage === "actioning")
        return (
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.arcRunId.localeCompare(b.arcRunId)
        );
      if (a.stage === "actioning") return 1;
      if (b.stage === "actioning") return -1;
      return a.arcRunId.localeCompare(b.arcRunId);
    });
  }

  #readPreparationView(arcRunId: ArcRunId): ArcRunView | undefined {
    const handshake = this.#handshakes.findPendingByRunId(arcRunId);
    if (handshake)
      return {
        stage: "handshaking",
        arcRunId,
        ownerPrincipal: handshake.principal,
        arcRef: handshake.arcRef,
        handshakeId: handshake.id,
      };
    const live = this.#liveSessions.get(arcRunKey(arcRunId));
    if (live?.kind === "triggering")
      return {
        stage: "triggering",
        arcRunId,
        ownerPrincipal: live.request.principal,
        ...(live.origin?.kind === "deflected"
          ? { arcRef: live.origin.state.arcRef }
          : {}),
        workspacePath: live.workspacePath,
      };
    const preparation = live?.kind === "actioning" ? live.preparation : live;
    if (preparation?.kind === "preparing")
      return {
        stage: "preparing",
        arcRunId,
        ownerPrincipal: preparation.ownerPrincipal,
        arcRef: preparation.arcRef,
        ...(preparation.workspacePath !== undefined
          ? { workspacePath: preparation.workspacePath }
          : {}),
      };
    return undefined;
  }

  #prepare(id: ArcRunId, ownerPrincipal: string, arcRef: ArcRef) {
    const key = arcRunKey(id);
    const current = this.#liveSessions.get(key);
    if (current?.kind === "preparing") return current;
    const entry = {
      kind: "preparing" as const,
      ownerPrincipal,
      arcRef,
      workspacePath: undefined as string | undefined,
    };
    this.#liveSessions.set(key, entry);
    return entry;
  }

  #releasePreparation(id: ArcRunId, entry: LiveArcSession): void {
    const key = arcRunKey(id);
    if (this.#liveSessions.get(key) === entry) this.#liveSessions.delete(key);
  }

  /**
   * Begin Arc host work for one inbound message; returns the step worklist.
   *
   * With `input.arcRunId`, continues an active run and returns its `action` step,
   * or `[]` for inactive executions and entries with no work. Without it,
   * evaluates registered arc triggers and returns the activation fork —
   * `action`/`handshake`/`rejected` steps, or a single still-resolving `trigger`
   * step for a semantic trigger. An empty array means this entry produced no
   * work. Each step carries at most one run identity; plurality lives in the array.
   */
  async begin(input: BeginInput): Promise<ArcHostStep[]> {
    if (input.arcRunId !== undefined) {
      const arcRunId = input.arcRunId;
      return this.#actionMutations.run(arcRunId, async () => {
        const state = await this.#store.getState(arcRunKey(arcRunId));
        if (state && state.lifecycle !== "active") return [];
        if (this.#liveSessions.get(arcRunKey(arcRunId))?.kind === "triggering")
          return [
            this.#frontierToStep(
              arcRunId,
              await this.#beginActioning(arcRunId, input.projectDialog),
            ),
          ];
        const retained = this.#actionSession(arcRunId);
        if (
          retained?.frontier &&
          (retained.phase.kind !== "ended" ||
            !(await this.#canAdvance(arcRunId)))
        ) {
          const frontier = await this.#mutateActionLocked(arcRunId, () =>
            this.#resumeRetainedAction(arcRunId, retained, input.projectDialog),
          );
          return [this.#frontierToStep(arcRunId, frontier)];
        }
        const session = await this.#newActionSession(arcRunId);
        try {
          const frontier = await this.#mutateActionLocked(arcRunId, () =>
            this.#beginActioning(arcRunId, input.projectDialog),
          );
          if (frontier.status === "idle") {
            await this.#retireAction(arcRunId, session);
            return [];
          }
          return [this.#frontierToStep(arcRunId, frontier)];
        } catch (error) {
          await this.#retireAction(arcRunId, session);
          throw error;
        }
      });
    }

    return this.#beginTriggering(input);
  }

  /**
   * Advance a run's trigger frontier with semantic reports. Returns the next
   * steps: `[trigger]` for another round, the fan-out set once it settles, or
   * `[]` when idle. `dialog` is the trigger-stage view (the activating
   * inbound's projection); `input.projectDialog` serves the activation
   * fan-out's action settles.
   */
  advanceTrigger(
    arcRunId: ArcRunId,
    dialog: Dialog,
    input: AdvanceInput,
  ): Promise<ArcHostStep[]> {
    return this.#actionMutations.run(arcRunId, async () => {
      try {
        return await this.#advanceTriggering(arcRunId, dialog, input);
      } catch (error) {
        try {
          await this.#retireExecution(arcRunId);
        } catch (cleanupError) {
          this.#logger.info("arc_host.cleanup.failed", {
            arcRunId,
            message: String(cleanupError),
          });
        }
        throw error;
      }
    });
  }

  /** Admit worker feedback or one host module outcome against the current execution. */
  async advanceAction(
    arcRunId: ArcRunId,
    frontierId: string,
    input: AdvanceInput,
  ): Promise<ArcHostStep> {
    const frontier = await this.#mutateAction(
      arcRunId,
      frontierId,
      async () => {
        const execution = this.#actionSession(arcRunId)!;
        if (
          !execution.frontier!.canProgress ||
          execution.admissionId !== frontierId
        )
          return execution.frontier!;
        return this.#advanceActioning(arcRunId, input);
      },
    );
    return { kind: "action", arcRunId, frontier };
  }

  async #resumeRetainedAction(
    arcRunId: ArcRunId,
    execution: ActionSession,
    projectDialog: DialogProjector,
  ): Promise<RunFrontier> {
    const phase = execution.phase;
    if (phase.kind !== "live" || !(await this.#canAdvance(arcRunId)))
      return execution.frontier!;
    const live = phase.live;
    if (phase.settlement !== "pending") return execution.frontier!;
    const runtime = await this.#runtimeForSnapshot(live.state.snapshotId);
    const dialog = await projectDialog({
      roleId: this.#workerRoleForTraversals(runtime, live.state.traversals),
    });
    if (!(await this.#canAdvance(arcRunId))) return execution.frontier!;
    return this.#settleActioningAdvance(
      arcRunKey(arcRunId),
      live.recorder,
      arcRunId,
      live.state,
      live.brief,
      dialog,
      projectDialog,
    );
  }

  async #beginTriggering(
    input: Extract<BeginInput, { arcRunId?: undefined }>,
  ): Promise<ArcHostStep[]> {
    this.#latestRuntime.init();
    const request = activationRequestFrom(input);
    const batchId = `activation-batch:${randomUUID()}`;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const batch: ActivationBatch = {
      id: batchId,
      dialog: input.dialog,
      request,
      groups: new Map(),
      pendingProbeIds: new Set(),
      cancelExpiry: () => {
        if (expiry !== undefined) clearTimeout(expiry);
      },
    };
    this.#activationBatches.set(batch.id, batch);

    try {
      const steps: ArcHostStep[] = [];
      steps.push(
        ...(await this.#startActivationProbe(
          batch,
          {
            kind: "fresh",
            recordIds: new Map(this.#latestDocumentRecordIds),
          },
          this.#latestRuntime,
          [],
        )),
      );
      const deflectedStates: ArcRunState[] = [];
      for await (const [, state] of this.#store.listStates()) {
        if (
          state.ownerPrincipal !== request.principal ||
          state.lifecycle !== "deflected"
        ) {
          continue;
        }
        deflectedStates.push(state);
      }
      deflectedStates.sort(
        (a, b) =>
          a.arcRef.localeCompare(b.arcRef) ||
          a.createdAt.localeCompare(b.createdAt) ||
          a.arcRunId.localeCompare(b.arcRunId),
      );
      for (const [order, state] of deflectedStates.entries()) {
        const runtime = await this.#runtimeForSnapshot(state.snapshotId);
        const reactivationCount = state.reactivationCount + 1;
        steps.push(
          ...(await this.#startActivationProbe(
            batch,
            { kind: "deflected", state, reactivationCount, order },
            runtime,
            state.traversals,
          )),
        );
      }

      expiry = setTimeout(
        () => this.#expireActivationBatch(batch.id),
        this.#activationBatchTtlMs,
      );
      expiry.unref?.();

      if (batch.pendingProbeIds.size > 0) return steps;
      return await this.#finalizeActivationBatch(batch, input.projectDialog);
    } catch (error) {
      batch.cancelExpiry();
      this.#activationBatches.delete(batch.id);
      await Promise.allSettled(
        [...batch.pendingProbeIds].map((probeId) =>
          this.#actionMutations.run(probeId, () =>
            this.#retireExecution(probeId),
          ),
        ),
      );
      throw error;
    }
  }

  async #startActivationProbe(
    batch: ActivationBatch,
    origin: TriggerProbeOrigin,
    runtime: Runtime,
    traversals: ArcTraversalSet,
  ): Promise<ArcHostStep[]> {
    const probeId: ArcRunId = `arc-run:${randomUUID()}`;
    return this.#actionMutations.run(probeId, async () => {
      const recorder = this.#newRecorder(
        runtime,
        origin.kind === "deflected" ? origin.state.arcRunId : probeId,
        {
          reactivationCount:
            origin.kind === "deflected" ? origin.reactivationCount : 0,
        },
      );
      await this.#openModuleExecution(probeId, false);
      let handedOff = false;
      let failed = false;
      try {
        const planned = await this.#planTrigger(
          probeId,
          batch.dialog,
          recorder,
          {
            traversals,
            arcRefs:
              origin.kind === "deflected" ? [origin.state.arcRef] : undefined,
            snapshotId:
              origin.kind === "deflected" ? origin.state.snapshotId : undefined,
            recordIds: origin.kind === "fresh" ? origin.recordIds : undefined,
          },
        );
        if (planned.status === "idle") return [];
        if (planned.status === "matched") {
          this.#collectProbeMatches(batch, origin, planned, recorder);
          return [];
        }

        batch.pendingProbeIds.add(probeId);
        const started = await this.#startTriggeringFromReadyPlan(
          probeId,
          planned,
          batch.dialog,
          { request: batch.request },
          recorder,
        );
        const live = this.#liveSessions.get(arcRunKey(probeId));
        if (live?.kind === "triggering") {
          this.#liveSessions.set(arcRunKey(probeId), {
            ...live,
            batchId: batch.id,
            origin,
          });
        }
        handedOff = true;
        return [this.#frontierToStep(started.arcRunId, started.frontier)];
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (!handedOff) {
          try {
            await this.#retireExecution(probeId);
          } catch (error) {
            if (!failed) throw error;
            this.#logger.info("arc_host.cleanup.failed", {
              arcRunId: probeId,
              message: String(error),
            });
          }
        }
      }
    });
  }

  #collectProbeMatches(
    batch: ActivationBatch,
    origin: TriggerProbeOrigin,
    planned: Extract<TriggerPlanResult, { status: "matched" }>,
    recorder: RecordingRuntime,
  ): void {
    const triggerSteps = recorder.drainTriggerBuffer();
    for (const [matchOrder, match] of planned.matches.entries()) {
      const originOrder =
        origin.kind === "fresh" ? matchOrder : 1_000_000 + origin.order;
      const group = batch.groups.get(match.arcRef) ?? {
        arcRef: match.arcRef,
        reentries: [],
        order: originOrder,
      };
      group.order = Math.min(group.order, originOrder);
      if (origin.kind === "fresh") {
        group.fresh = {
          ...pendingTriggerSelection(
            `arc-run:${randomUUID()}`,
            match,
            planned.snapshotId,
          ),
          triggerSteps: [...triggerSteps],
        };
      } else if (match.arcRef === origin.state.arcRef) {
        group.reentries.push({
          arcRunId: origin.state.arcRunId,
          arcRef: origin.state.arcRef,
          deps: [...match.deps],
          snapshotId: origin.state.snapshotId,
          traversals: structuredClone(match.traversals),
          triggerSteps: [...triggerSteps],
          expectedUpdatedAt: origin.state.updatedAt,
          reactivationCount: origin.reactivationCount,
        });
      }
      batch.groups.set(match.arcRef, group);
    }
  }

  async #finalizeActivationBatch(
    batch: ActivationBatch,
    projectDialog: DialogProjector,
  ): Promise<ArcHostStep[]> {
    if (!this.#activationBatches.delete(batch.id)) return [];
    batch.cancelExpiry();
    const groups = [...batch.groups.values()].sort(
      (a, b) => a.order - b.order || a.arcRef.localeCompare(b.arcRef),
    );
    const selected =
      batch.request.activationPolicy === "first" ? groups.slice(0, 1) : groups;
    const choose =
      batch.request.activationPolicy === "choose" && selected.length > 1;
    const steps: ArcHostStep[] = [];

    try {
      for (const group of selected) {
        const placeholder =
          group.fresh ?? this.#placeholderSelection(group.reentries[0]!);
        if (choose) {
          steps.push(
            this.#handshakeStep(
              await this.#stageArcChoiceHandshake(
                group.arcRef,
                batch.request,
                placeholder,
                batch.dialog,
                {
                  reentrySelections: group.reentries,
                  freshAvailable: group.fresh !== undefined,
                },
              ),
            ),
          );
          continue;
        }

        const activeCandidates = group.fresh
          ? await this.#findRunChoiceCandidates(
              batch.request.principal,
              group.arcRef,
            )
          : [];
        const reentryCandidates = await this.#runChoiceViews(group.reentries);
        const candidates = [...activeCandidates, ...reentryCandidates].sort(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt),
        );
        if (candidates.length > 0) {
          steps.push(
            this.#handshakeStep(
              await this.#stageRunChoiceHandshake(
                group.arcRef,
                candidates,
                batch.request,
                placeholder,
                batch.dialog,
                {
                  reentrySelections: group.reentries,
                  freshAvailable: group.fresh !== undefined,
                },
              ),
            ),
          );
        } else if (group.fresh) {
          const handshake = await this.#stageHandshakeForTriggerSelection(
            group.fresh,
            batch.request.principal,
            batch.request,
            batch.dialog,
          );
          if (handshake) {
            steps.push(this.#handshakeStep(handshake));
            continue;
          }
          const started = await this.#activateFromTriggerSelection(
            group.fresh,
            {
              ownerPrincipal: batch.request.principal,
              projectDialog,
            },
          );
          steps.push(
            started.kind === "invalid"
              ? {
                  kind: "rejected",
                  arcRef: group.arcRef,
                  reason: started.reason,
                }
              : {
                  kind: "action",
                  arcRunId: started.arcRunId,
                  frontier: started.frontier,
                },
          );
        }
      }
    } catch (error) {
      await Promise.all(
        steps.map((step) =>
          step.kind === "action"
            ? this.releaseAction(step.arcRunId, step.frontier.frontierId)
            : undefined,
        ),
      );
      throw error;
    }
    return steps;
  }

  #expireActivationBatch(batchId: string): void {
    const batch = this.#activationBatches.get(batchId);
    if (!batch || !this.#activationBatches.delete(batchId)) return;
    batch.cancelExpiry();
    for (const probeId of batch.pendingProbeIds) {
      this.#moduleExecutions.get(probeId)?.abort();
      void this.#actionMutations
        .run(probeId, () => this.#retireExecution(probeId))
        .catch((error) => {
          this.#logger.info("arc_host.cleanup.failed", {
            arcRunId: probeId,
            message: String(error),
          });
        });
    }
    this.#logger.info("arc_host.activation_batch.expired", {
      batchId,
      pendingProbeCount: batch.pendingProbeIds.size,
    });
  }

  #placeholderSelection(
    selection: PendingReentrySelection,
  ): PendingTriggerSelection {
    return {
      arcRunId: `arc-run:${randomUUID()}`,
      arcRef: selection.arcRef,
      deps: selection.deps,
      snapshotId: selection.snapshotId,
      traversals: selection.traversals,
      triggerSteps: selection.triggerSteps,
    };
  }

  async #beginActioning(
    arcRunId: ArcRunId,
    projectDialog: DialogProjector,
  ): Promise<RunFrontier> {
    const events: RunEventCollection = {
      staged: [],
      committed: [],
      onCommit: [],
    };
    let failed = false;
    try {
      const key = arcRunKey(arcRunId);
      const live = this.#liveSessions.get(key);
      if (live?.kind === "triggering") {
        return this.#frontierFromTriggerBrief(
          arcRunId,
          live.deps,
          live.snapshotId,
          live.brief,
          await projectDialog({ roleId: DEFAULT_WORKER_ROLE }),
        );
      }
      const state = await this.#stateFor(arcRunId);
      if (!state) {
        const frontier = idleFrontier(arcRunId);
        this.#logger.info("arc_host.run.begun", {
          arcRunId,
          phase: "actioning",
          arcStatus: frontier.status,
          work: workSummary(frontier),
        });
        return frontier;
      }

      const runtime = await this.#runtimeForSnapshot(state.snapshotId);
      // The report-time view follows the run's current position: derive its
      // worker role from the persisted frontier and project for it.
      const dialog = await projectDialog({
        roleId: this.#workerRoleForTraversals(runtime, state.traversals),
      });
      const recorder = this.#newRecorder(runtime, arcRunId, {
        reactivationCount: state.reactivationCount,
      });
      recorder.setHostModuleState(state.hostModules);
      const brief = await recorder.start(state.traversals, dialog);
      const settled = await this.#settle(
        recorder,
        arcRunId,
        state,
        brief,
        dialog,
        projectDialog,
        { events },
      );
      this.#trackActioningSession(key, settled, recorder);
      this.#logger.info("arc_host.run.begun", {
        arcRunId,
        arcRef: state.arcRef,
        phase: "actioning",
        arcStatus: settled.frontier.status,
        work: workSummary(settled.frontier),
      });
      return settled.frontier;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await this.#publishRunEvents(events);
      } catch (error) {
        if (!failed) throw error;
        this.#logger.info("arc_host.work_event.publication_failed", {
          message: String(error),
        });
      }
    }
  }

  /**
   * Resolve a previously staged activation handshake.
   *
   * Validates the supplied values and produces the next step — a fresh
   * activation's `action` step, a next-round `handshake` step, or a `rejected`
   * step — or a `joined` outcome naming a validated active run for worker hub
   * to publish as attachment. The submission input is not
   * delivered to that run. A fresh
   * activation settles against the dialog captured on the staged handshake at
   * trigger time; arc host holds no inbound of its own.
   */
  async resolveHandshake(
    id: string,
    values: HandshakeResolution,
    opts: {
      clientId?: string;
      projectDialog: DialogProjector;
    },
  ): Promise<ResolveHandshakeResult> {
    const operation: PreparationOperation = {};
    try {
      return await this.#resolveHandshaking(id, values, opts, operation);
    } finally {
      if (operation.arcRunId && operation.entry)
        this.#releasePreparation(operation.arcRunId, operation.entry);
    }
  }

  async #resolveHandshaking(
    id: string,
    values: HandshakeResolution,
    opts: {
      clientId?: string;
      projectDialog: DialogProjector;
    },
    operation: PreparationOperation,
  ): Promise<ResolveHandshakeResult> {
    const clientId = opts.clientId;
    const handshake = this.#handshakes.get(id);
    if (!handshake) return { status: "missing" };
    if (
      clientId !== undefined &&
      handshake.clientId !== "" &&
      handshake.clientId !== clientId
    ) {
      this.#logger.info("arc_host.handshake.cross_client_resolve", {
        handshakeId: id,
        stagedClientId: handshake.clientId,
        resolvingClientId: clientId,
      });
    }

    const requirement = handshake.requirements[0];
    if (!requirement) {
      return { status: "invalid", reason: "Handshake has no requirements." };
    }

    if (requirement.kind === "arc-choice") {
      const choice = values.arcChoice;
      if (!choice) {
        return {
          status: "invalid",
          reason: "This handshake requires arcChoice: { activate }.",
        };
      }
      await this.#consumeHandshake(
        handshake,
        { kind: choice.activate ? "proceed" : "declined" },
        operation,
      );
      if (!choice.activate) {
        return {
          status: "ok",
          step: {
            kind: "rejected",
            arcRef: handshake.arcRef,
            reason: "Arc activation declined by client.",
          },
        };
      }
      // Activating: the arc may still need run-choice/workspace — stage that as
      // the next-round handshake — otherwise activate now.
      const request: ActivationRequest = {
        clientId: handshake.clientId === "" ? undefined : handshake.clientId,
        principal: handshake.principal,
        activationPolicy: "all",
      };
      if ((handshake.reentrySelections?.length ?? 0) > 0) {
        const reentryCandidates = await this.#runChoiceViews(
          handshake.reentrySelections ?? [],
        );
        const activeCandidates = handshake.freshAvailable
          ? await this.#findRunChoiceCandidates(
              handshake.principal,
              handshake.arcRef,
            )
          : [];
        const candidates = [
          ...new Map(
            [...activeCandidates, ...reentryCandidates].map((candidate) => [
              candidate.arcRunId,
              candidate,
            ]),
          ).values(),
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (candidates.length > 0) {
          const next = await this.#stageRunChoiceHandshake(
            handshake.arcRef,
            candidates,
            request,
            handshake.triggerSelection,
            handshake.dialog,
            {
              reentrySelections: handshake.reentrySelections,
              freshAvailable: handshake.freshAvailable ?? false,
            },
          );
          return { status: "ok", step: this.#handshakeStep(next) };
        }
        if (!handshake.freshAvailable) {
          return {
            status: "ok",
            step: {
              kind: "rejected",
              arcRef: handshake.arcRef,
              reason:
                "Matching existing runs changed before activation was selected.",
            },
          };
        }
      }
      const next = await this.#stageHandshakeForTriggerSelection(
        handshake.triggerSelection,
        handshake.principal,
        request,
        handshake.dialog,
      );
      if (next) return { status: "ok", step: this.#handshakeStep(next) };
      return this.#activateFreshFromHandshake(
        handshake,
        undefined,
        opts.projectDialog,
      );
    }

    if (requirement.kind === "run-choice") {
      const choice = values.runChoice;
      if (!choice) {
        return {
          status: "invalid",
          reason:
            "This handshake requires runChoice: { action: 'join', arcRunId } or { action: 'fresh' }.",
        };
      }
      if (choice.action === "join") {
        const candidate = requirement.candidates.find(
          (item) => item.arcRunId === choice.arcRunId,
        );
        if (!candidate) {
          this.#logger.info("arc_host.resolve.run_choice_mismatch", {
            handshakeId: id,
            receivedArcRunId: choice.arcRunId,
            candidateArcRunIds: requirement.candidates.map(
              (item) => item.arcRunId,
            ),
          });
          const candidateIds = requirement.candidates
            .map((item) => item.arcRunId)
            .join(", ");
          return {
            status: "invalid",
            reason: `Run ${JSON.stringify(choice.arcRunId)} is not a candidate for this handshake. Valid candidates: ${candidateIds || "(none)"}.`,
          };
        }
        const reentrySelection = handshake.reentrySelections?.find(
          (item) => item.arcRunId === choice.arcRunId,
        );
        if (reentrySelection) {
          return this.#reentrySerializer.run(choice.arcRunId, async () => {
            const state = await this.#store.getState(
              arcRunKey(choice.arcRunId),
            );
            if (
              !state ||
              state.lifecycle !== "deflected" ||
              state.ownerPrincipal !== handshake.principal ||
              state.arcRef !== reentrySelection.arcRef ||
              state.snapshotId !== reentrySelection.snapshotId ||
              state.updatedAt !== reentrySelection.expectedUpdatedAt ||
              state.reactivationCount + 1 !== reentrySelection.reactivationCount
            ) {
              return {
                status: "invalid",
                reason: `Run ${choice.arcRunId} changed after trigger planning.`,
              };
            }
            await this.#consumeHandshake(
              handshake,
              { kind: "reentry", arcRunId: choice.arcRunId },
              operation,
            );
            const frontier = await this.#activateDeflectedReentry(
              state,
              reentrySelection,
              opts.projectDialog,
            );
            return {
              status: "ok",
              step: { kind: "action", arcRunId: state.arcRunId, frontier },
            };
          });
        }
        const state = await this.#store.getState(arcRunKey(choice.arcRunId));
        if (
          !state ||
          !this.#isRunChoiceCandidateState(
            state,
            handshake.arcRef,
            handshake.principal,
          )
        ) {
          return {
            status: "invalid",
            reason: `Run ${choice.arcRunId} cannot be advanced.`,
          };
        }
        await this.#consumeHandshake(
          handshake,
          { kind: "join", arcRunId: choice.arcRunId },
          operation,
        );
        // Validated active run: worker hub publishes additive attachment without
        // scheduling or mutating the selected run.
        return { status: "joined", arcRunId: choice.arcRunId };
      }

      if (!(handshake.freshAvailable ?? requirement.freshAvailable)) {
        return {
          status: "invalid",
          reason: "This run-choice has no matching fresh activation.",
        };
      }

      const arc = this.#arcs.get(handshake.arcRef);
      let workspace: string | undefined;
      if (arc?.manifest.workspaceScope === "arc") {
        workspace = arc.workspacePath;
        if (workspace === undefined) {
          const resolvedWorkspace = this.#validatedWorkspace(values.workspace);
          if (resolvedWorkspace.status === "invalid") return resolvedWorkspace;
          workspace = resolvedWorkspace.value;
        }
      }
      await this.#consumeHandshake(handshake, { kind: "proceed" }, operation);
      return this.#activateFreshFromHandshake(
        handshake,
        workspace,
        opts.projectDialog,
      );
    }

    const workspace = this.#validatedWorkspace(values.workspace);
    if (workspace.status === "invalid") {
      return workspace;
    }
    await this.#consumeHandshake(handshake, { kind: "proceed" }, operation);
    return this.#activateFreshFromHandshake(
      handshake,
      workspace.value,
      opts.projectDialog,
    );
  }

  async #activateFreshFromHandshake(
    handshake: PendingHandshake,
    workspace: string | undefined,
    projectDialog: DialogProjector,
  ): Promise<ResolveHandshakeResult> {
    const started = await this.#activateFromTriggerSelection(
      handshake.triggerSelection,
      {
        workspacePath: workspace,
        ownerPrincipal: handshake.principal,
        projectDialog,
      },
    );
    if (started.kind === "invalid") {
      return { status: "invalid", reason: started.reason };
    }
    this.#logger.info("arc_host.handshake.resolved", {
      handshakeId: handshake.id,
      arcRef: handshake.arcRef,
      arcRunId: started.arcRunId,
      workspacePath: workspace,
      continuedTriggerArcRunId: handshake.triggerSelection.arcRunId,
    });
    const step = this.#frontierToStep(started.arcRunId, started.frontier);
    if (step.kind !== "action") {
      return {
        status: "invalid",
        reason: "Resolved handshake did not produce runnable Arc work.",
      };
    }
    return { status: "ok", step };
  }

  async #stageHandshakeForTriggerSelection(
    selection: PendingTriggerSelection,
    ownerPrincipal: string,
    request: ActivationRequest,
    dialog: Dialog,
    opts: { excludeArcRunId?: ArcRunId } = {},
  ): Promise<PendingHandshake | undefined> {
    const arc = this.#arcs.get(selection.arcRef);
    if (!arc) return undefined;
    const candidates = await this.#findRunChoiceCandidates(
      ownerPrincipal,
      selection.arcRef,
      opts,
    );
    if (candidates.length > 0) {
      return await this.#stageRunChoiceHandshake(
        selection.arcRef,
        candidates,
        request,
        selection,
        dialog,
      );
    }
    if (
      arc.manifest.workspaceScope === "arc" &&
      arc.workspacePath === undefined
    ) {
      return await this.#stageWorkspaceHandshake(
        selection.arcRef,
        request,
        selection,
        dialog,
      );
    }
    return undefined;
  }

  async #startTriggeringFromReadyPlan(
    arcRunId: ArcRunId,
    planned: Extract<TriggerPlanResult, { status: "ready" }>,
    dialog: Dialog,
    opts: {
      request: ActivationRequest;
    },
    recorder: RecordingRuntime,
  ): Promise<Extract<PlannedRunStartResult, { kind: "trigger" }>> {
    const key = arcRunKey(arcRunId);
    const workspacePath = defaultRunWorkspaceRoot(this.#artifactRoot, arcRunId);
    this.#liveSessions.set(key, {
      kind: "triggering",
      recorder,
      deps: planned.deps,
      snapshotId: planned.snapshotId,
      brief: planned.brief,
      workspacePath,
      request: opts.request,
    });
    this.#logger.info("arc_host.run.begun", {
      arcRunId,
      phase: "triggering",
    });
    const frontier = await this.#frontierFromTriggerBrief(
      arcRunId,
      planned.deps,
      planned.snapshotId,
      planned.brief,
      dialog,
    );
    return { kind: "trigger", arcRunId, frontier };
  }

  async #activateFromTriggerSelection(
    selection: PendingTriggerSelection,
    opts: {
      workspacePath?: string;
      ownerPrincipal: string;
      projectDialog: DialogProjector;
    },
  ): Promise<Extract<PlannedRunStartResult, { kind: "matched" | "invalid" }>> {
    const preparing = this.#prepare(
      selection.arcRunId,
      opts.ownerPrincipal,
      selection.arcRef,
    );
    try {
      const arc = this.#arcs.get(selection.arcRef);
      if (!arc) {
        return {
          kind: "invalid",
          reason: `Cannot start unregistered arc ${selection.arcRef}.`,
        };
      }
      const workspacePath =
        arc.manifest.workspaceScope === "arc"
          ? (opts.workspacePath ?? arc.workspacePath)
          : defaultRunWorkspaceRoot(this.#artifactRoot, selection.arcRunId);
      if (workspacePath === undefined) {
        return {
          kind: "invalid",
          reason:
            "Starting a fresh run for this arc requires an absolute workspace path.",
        };
      }
      preparing.workspacePath = workspacePath;
      const existing = await this.#store.getState(
        arcRunKey(selection.arcRunId),
      );
      const frontier = await this.#activateMatchedRun(
        selection.arcRunId,
        {
          arcRef: selection.arcRef,
          deps: selection.deps,
          snapshotId: selection.snapshotId,
          traversals: selection.traversals,
          reactivationCount: 0,
          workspacePath,
          contextIsolation: arc.manifest.contextIsolation,
          ownerPrincipal: opts.ownerPrincipal,
          artifactPaths: existing?.artifactPaths ?? [],
          hostModules: { calls: [] },
        },
        opts.projectDialog,
        {
          route: "fresh",
          appendBegun: !existing,
          triggerSteps: selection.triggerSteps,
        },
      );
      return { kind: "matched", arcRunId: selection.arcRunId, frontier };
    } finally {
      this.#releasePreparation(selection.arcRunId, preparing);
    }
  }

  /**
   * Activate matched arcs from one inbound per the activation policy. `first`
   * activates one; `all` activates every match; `choose` (with >1 match) stages a
   * host-level arc-choice handshake per match so the client selects the subset.
   * Each activation gets its own fresh run id; gated matches are returned as
   * handshakes (no run yet — they activate later via the resolve path);
   * unregistered/invalid matches are rejected. The captured trigger replay is
   * replicated into each activated run.
   */
  async #fanOutActivation(
    matches: readonly TriggerMatch[],
    snapshotId: ArcDocumentSnapshotId,
    sharedTriggerSteps: readonly TriggerReplayStep[],
    dialog: Dialog,
    ownerPrincipal: string,
    request: ActivationRequest | undefined,
    policy: ActivationPolicy,
    projectDialog: DialogProjector,
    opts: { excludeArcRunId?: ArcRunId } = {},
  ): Promise<ArcHostStep[]> {
    const steps: ArcHostStep[] = [];
    const freshSelection = (match: TriggerMatch): PendingTriggerSelection => ({
      ...pendingTriggerSelection(`arc-run:${randomUUID()}`, match, snapshotId),
      triggerSteps: [...sharedTriggerSteps],
    });

    // `choose` with >1 match: ask the client which arcs to activate, one
    // arc-choice handshake per match. Resolution activates (or declines) each.
    if (policy === "choose" && matches.length > 1 && request) {
      for (const match of matches) {
        steps.push(
          this.#handshakeStep(
            await this.#stageArcChoiceHandshake(
              match.arcRef,
              request,
              freshSelection(match),
              dialog,
            ),
          ),
        );
      }
      return steps;
    }

    const selected = policy === "first" ? matches.slice(0, 1) : matches;
    try {
      for (const match of selected) {
        const selection = freshSelection(match);
        if (request) {
          const handshake = await this.#stageHandshakeForTriggerSelection(
            selection,
            ownerPrincipal,
            request,
            dialog,
            opts,
          );
          if (handshake) {
            steps.push(this.#handshakeStep(handshake));
            continue;
          }
        }
        const started = await this.#activateFromTriggerSelection(selection, {
          ownerPrincipal,
          projectDialog,
        });
        if (started.kind === "invalid") {
          steps.push({
            kind: "rejected",
            arcRef: match.arcRef,
            reason: started.reason,
          });
          continue;
        }
        steps.push({
          kind: "action",
          arcRunId: started.arcRunId,
          frontier: started.frontier,
        });
      }
    } catch (error) {
      await Promise.all(
        steps.map((step) =>
          step.kind === "action"
            ? this.releaseAction(step.arcRunId, step.frontier.frontierId)
            : undefined,
        ),
      );
      throw error;
    }
    return steps;
  }

  #registeredArcForReadyPlan(
    planned: Extract<TriggerPlanResult, { status: "ready" }>,
  ): { arcRef: ArcRef; arc: RegisteredArc } | undefined {
    const roots = new Set<ArcRef>(planned.brief.matchableArcs);
    const addNodeRoot = (ref: NodeRef) => {
      const parts = toNodeRefParts(ref);
      roots.add(toArcRef(parts.source, parts.path[0] ?? ""));
    };
    for (const item of planned.brief.judgments) {
      addNodeRoot(item.sourceRef);
    }
    for (const item of planned.brief.observations) {
      addNodeRoot(item.sourceRef);
    }
    for (const item of planned.brief.hostCalls) {
      addNodeRoot(item.sourceRef);
    }
    if (roots.size !== 1) return undefined;
    const arcRef = [...roots][0]!;
    const arc = this.#arcs.get(arcRef);
    return arc ? { arcRef, arc } : undefined;
  }

  async #activateMatchedRun(
    arcRunId: ArcRunId,
    activated: ArcRunRuntimeState,
    projectDialog: DialogProjector,
    opts: {
      route: "fresh" | "reentry";
      appendBegun?: boolean;
      triggerSteps?: readonly TriggerReplayStep[];
    },
  ): Promise<RunFrontier> {
    return this.#actionMutations.run(arcRunId, async () => {
      const session = await this.#newActionSession(arcRunId);
      try {
        return await this.#mutateActionLocked(arcRunId, () =>
          this.#activateMatchedRunUnderMutation(
            arcRunId,
            activated,
            projectDialog,
            opts,
          ),
        );
      } catch (error) {
        await this.#retireAction(arcRunId, session);
        throw error;
      } finally {
        session.preparation = undefined;
      }
    });
  }

  async #activateMatchedRunUnderMutation(
    arcRunId: ArcRunId,
    activated: ArcRunRuntimeState,
    projectDialog: DialogProjector,
    opts: {
      route: "fresh" | "reentry";
      appendBegun?: boolean;
      triggerSteps?: readonly TriggerReplayStep[];
    },
  ): Promise<RunFrontier> {
    const events: RunEventCollection = {
      staged: [],
      committed: [],
      onCommit: [],
    };
    events.start = { kind: "run:started", arcRunId, route: opts.route };
    let failed = false;
    try {
      const key = arcRunKey(arcRunId);
      const runtime = await this.#runtimeForSnapshot(activated.snapshotId);
      const recorder = this.#newRecorder(runtime, arcRunId, {
        reactivationCount: activated.reactivationCount,
      });
      recorder.setHostModuleState(activated.hostModules);
      if (opts.triggerSteps) await recorder.flushTrigger(opts.triggerSteps);
      // Trigger matching uses the activation dialog, but action evaluation starts
      // at the root position. Project that root's worker role before the first
      // runtime walk; root entry itself produces no transition to rotate it.
      const actionDialog = await projectDialog({
        roleId: this.#workerRoleForTraversals(runtime, activated.traversals),
      });
      recorder.setHostModuleState(activated.hostModules);
      const brief = await recorder.start(activated.traversals, actionDialog);
      const settled = await this.#settle(
        recorder,
        arcRunId,
        activated,
        brief,
        actionDialog,
        projectDialog,
        { deferStatePublish: true, events },
      );
      if (opts.appendBegun ?? true) {
        this.#logger.info("arc_host.run.begun", {
          arcRunId,
          arcRef: activated.arcRef,
          phase: "actioning",
        });
      }
      await this.#putState(arcRunId, settled.state, events, settled.frontier);
      this.#trackActioningSession(key, settled, recorder);
      return settled.frontier;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await this.#publishRunEvents(events);
      } catch (error) {
        if (!failed) throw error;
        this.#logger.info("arc_host.work_event.publication_failed", {
          message: String(error),
        });
      }
    }
  }

  async #activateDeflectedReentry(
    existing: ArcRunState,
    selection: PendingReentrySelection,
    projectDialog: DialogProjector,
  ): Promise<RunFrontier> {
    await this.#replayStore?.truncateAfterReactivationCount(
      existing.arcRunId,
      existing.reactivationCount,
    );
    return this.#activateMatchedRun(
      existing.arcRunId,
      {
        arcRef: existing.arcRef,
        deps: selection.deps,
        snapshotId: selection.snapshotId,
        traversals: selection.traversals,
        reactivationCount: selection.reactivationCount,
        workspacePath: existing.workspacePath,
        contextIsolation: existing.contextIsolation,
        ownerPrincipal: existing.ownerPrincipal,
        artifactPaths: existing.artifactPaths,
        hostModules: structuredClone(existing.hostModules),
      },
      projectDialog,
      {
        route: "reentry",
        appendBegun: false,
        triggerSteps: selection.triggerSteps,
      },
    );
  }

  async #runChoiceViews(
    selections: readonly PendingReentrySelection[],
  ): Promise<RunChoiceCandidate[]> {
    const candidates: RunChoiceCandidate[] = [];
    for (const selection of selections) {
      const state = await this.#store.getState(arcRunKey(selection.arcRunId));
      if (!state || state.lifecycle !== "deflected") continue;
      candidates.push({
        arcRunId: state.arcRunId,
        arcRef: state.arcRef,
        lifecycle: "deflected",
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        workspacePath: state.workspacePath,
      });
    }
    candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates;
  }

  async #advanceTriggering(
    arcRunId: ArcRunId,
    dialog: Dialog,
    input: AdvanceInput,
  ): Promise<ArcHostStep[]> {
    const key = arcRunKey(arcRunId);
    const live = this.#liveSessions.get(key);
    if (live?.kind !== "triggering") {
      return [];
    }

    let effect: HostModuleEffect | undefined;
    let report: TriggerReport | undefined;
    if ("hostCallId" in input) {
      assertModuleEffect(input);
      const record = live.recorder.hostModuleState.calls.find(
        (item) => item.call.hostCallId === input.hostCallId,
      );
      if (!record) throw new Error("Unknown host call occurrence.");
      const pending = live.brief.hostCalls.find(
        (call) => call.id === record.runtimeCallId,
      );
      if (
        !pending ||
        record.effects.some(
          (item) =>
            item.hostCallOutcome.kind === "resolution" ||
            item.hostCallOutcome.kind === "failure",
        )
      )
        return [
          this.#frontierToStep(
            arcRunId,
            await this.#frontierFromTriggerBrief(
              arcRunId,
              live.deps,
              live.snapshotId,
              live.brief,
              dialog,
            ),
          ),
        ];
      if (input.hostCallOutcome.kind === "interruption")
        throw new TypeError("Interruption requires an action execution.");
      effect = {
        hostCallId: input.hostCallId,
        hostCallOutcome: input.hostCallOutcome,
      };
      if (input.hostCallOutcome.kind === "resolution")
        report = {
          hostCalls: {
            [pending.id]: {
              status: "resolved",
              value: input.hostCallOutcome.value,
            },
          },
        };
    } else {
      report = buildTriggerReport(input.reports);
    }
    if (
      hasFailedTriggerFeedback(input) ||
      effect?.hostCallOutcome.kind === "failure"
    ) {
      await this.#retireExecution(arcRunId);
      const batch = live.batchId
        ? this.#activationBatches.get(live.batchId)
        : undefined;
      batch?.pendingProbeIds.delete(arcRunId);
      this.#logger.info("arc_host.run.committed", {
        arcRunId,
        phase: "triggering",
        outcome: "failed-feedback",
      });
      if (batch && batch.pendingProbeIds.size === 0) {
        return this.#finalizeActivationBatch(batch, input.projectDialog);
      }
      return [];
    }

    const next = await live.recorder.progressTrigger(
      live.brief,
      report!,
      dialog,
      effect ? "host-module" : "worker",
      effect,
    );
    const planned = await this.#planTriggerFromBrief(
      arcRunId,
      live.recorder,
      next,
      dialog,
      {
        snapshotId:
          live.origin?.kind === "deflected"
            ? live.origin.state.snapshotId
            : undefined,
        recordIds:
          live.origin?.kind === "fresh" ? live.origin.recordIds : undefined,
      },
    );
    if (planned.status === "ready") {
      this.#liveSessions.set(key, {
        kind: "triggering",
        recorder: live.recorder,
        deps: planned.deps,
        snapshotId: planned.snapshotId,
        brief: planned.brief,
        workspacePath: live.workspacePath,
        request: live.request,
        batchId: live.batchId,
        origin: live.origin,
      });
      const frontier = await this.#frontierFromTriggerBrief(
        arcRunId,
        planned.deps,
        planned.snapshotId,
        planned.brief,
        dialog,
      );
      this.#logger.info("arc_host.run.committed", {
        arcRunId,
        phase: "triggering",
        outcome: "ready",
      });
      return [this.#frontierToStep(arcRunId, frontier)];
    }

    await this.#retireExecution(arcRunId);
    const batch = live.batchId
      ? this.#activationBatches.get(live.batchId)
      : undefined;
    if (batch) {
      batch.pendingProbeIds.delete(arcRunId);
      if (planned.status === "matched") {
        if (!live.origin) {
          throw new Error(`Activation probe ${arcRunId} has no origin.`);
        }
        this.#collectProbeMatches(batch, live.origin, planned, live.recorder);
      }
      this.#logger.info("arc_host.run.committed", {
        arcRunId,
        phase: "triggering",
        outcome: planned.status,
      });
      if (batch.pendingProbeIds.size > 0) return [];
      return this.#finalizeActivationBatch(batch, input.projectDialog);
    }
    if (planned.status === "idle") {
      this.#logger.info("arc_host.run.committed", {
        arcRunId,
        phase: "triggering",
        outcome: "idle",
      });
      return [];
    }

    // Fan out per the activation policy, under fresh run ids, replicating the
    // captured trigger replay into each. The trigger stage (arcRunId) is closed
    // with a committed event and is never itself a run.
    const activated = await this.#fanOutActivation(
      planned.matches,
      planned.snapshotId,
      live.recorder.drainTriggerBuffer(),
      dialog,
      live.request.principal,
      live.request,
      live.request.activationPolicy,
      input.projectDialog,
      { excludeArcRunId: arcRunId },
    );
    this.#logger.info("arc_host.run.committed", {
      arcRunId,
      phase: "triggering",
      outcome: "activated",
    });
    return activated;
  }

  async #advanceActioning(
    arcRunId: ArcRunId,
    input: AdvanceInput,
  ): Promise<RunFrontier> {
    const execution = this.#actionSession(arcRunId)!;
    const live = this.#liveAction(arcRunId);
    if (!live) return execution.frontier!;
    const { state, brief, recorder } = live;
    let report: ActionReport;
    let effect: HostModuleEffect | undefined;
    if ("hostCallId" in input) {
      assertModuleEffect(input);
      const record = state.hostModules.calls.find(
        (item) => item.call.hostCallId === input.hostCallId,
      );
      if (!record) throw new Error("Unknown host call occurrence.");
      const outcome = input.hostCallOutcome;
      const pending = brief.hostCalls.find(
        (call) => call.id === record.runtimeCallId,
      );
      if (!(await this.#canAdvance(arcRunId))) return execution.frontier!;
      if (outcome.kind === "interruption") {
        if (
          !brief.allowedMoves.includes("interrupt") ||
          record.effects.some(
            (item) =>
              item.hostCallOutcome.kind === "interruption" &&
              structurallyEqual(item.hostCallOutcome, outcome),
          )
        )
          return execution.frontier!;
        report = { move: "interrupt", interruption: outcome.interruption };
      } else if (outcome.kind === "failure") {
        if (
          !brief.allowedMoves.includes("poison") ||
          record.effects.some(
            (item) => item.hostCallOutcome.kind === "failure",
          ) ||
          (!pending &&
            !record.effects.some(
              (item) => item.hostCallOutcome.kind === "resolution",
            ))
        )
          return execution.frontier!;
        report = {
          move: "poison",
          poisonReason: {
            reasonCode: "host-call-failed",
            reason: `Host call ${[record.call.module, ...record.call.target, record.call.operation].join(".")} failed: ${outcome.reason}`,
          },
        };
      } else {
        if (
          !pending ||
          record.effects.some(
            (item) =>
              item.hostCallOutcome.kind === "resolution" ||
              item.hostCallOutcome.kind === "failure",
          )
        )
          return execution.frontier!;
        report = {
          move: "proceed",
          hostCalls: {
            [pending.id]: { status: "resolved", value: outcome.value },
          },
        };
      }
      effect = { hostCallId: input.hostCallId, hostCallOutcome: outcome };
    } else {
      report = this.#buildReport(
        brief,
        input.reports,
        input.instructionCoverage,
      );
    }
    const runtime = await this.#runtimeForSnapshot(state.snapshotId);
    const dialog = await input.projectDialog({
      roleId: this.#workerRoleForTraversals(runtime, state.traversals),
    });
    if (effect && !(await this.#canAdvance(arcRunId)))
      return execution.frontier!;
    recorder.setHostModuleState(state.hostModules);
    return this.#settleActioningAdvance(
      arcRunKey(arcRunId),
      recorder,
      arcRunId,
      state,
      brief,
      dialog,
      input.projectDialog,
      report,
      effect,
    );
  }

  async #settleActioningAdvance(
    key: string,
    recorder: RecordingRuntime,
    arcRunId: ArcRunId,
    state: ArcRunRuntimeState,
    initial: ActionBrief | TerminalBrief,
    dialog: Dialog,
    projectDialog: DialogProjector,
    report?: ActionReport,
    effect?: HostModuleEffect,
  ): Promise<RunFrontier> {
    const events: RunEventCollection = {
      staged: [],
      committed: [],
      onCommit: [],
    };
    let failed = false;
    try {
      if (report && initial.canProgress)
        initial = await this.#progressAction(
          recorder,
          arcRunId,
          state,
          events,
          initial,
          report,
          dialog,
          effect ? "host-module" : "worker",
          effect,
        );
      const settled = await this.#settle(
        recorder,
        arcRunId,
        state,
        initial,
        dialog,
        projectDialog,
        { events },
      );
      this.#trackActioningSession(key, settled, recorder);
      this.#logger.info("arc_host.run.committed", {
        arcRunId,
        arcRef: state.arcRef,
        phase: "actioning",
        arcStatus: settled.frontier.status,
        work: workSummary(settled.frontier),
      });
      return settled.frontier;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await this.#publishRunEvents(events);
      } catch (error) {
        if (!failed) throw error;
        this.#logger.info("arc_host.work_event.publication_failed", {
          message: String(error),
        });
      }
    }
  }

  async #stateFor(arcRunId: ArcRunId): Promise<ArcRunRuntimeState | undefined> {
    const existing = await this.#store.getState(arcRunKey(arcRunId));
    if (!existing) return undefined;
    assertHostModuleState(existing.hostModules);
    return {
      arcRef: existing.arcRef,
      deps: existing.deps,
      snapshotId: existing.snapshotId,
      traversals: existing.traversals,
      reactivationCount: existing.reactivationCount,
      workspacePath: existing.workspacePath,
      contextIsolation: existing.contextIsolation,
      ownerPrincipal: existing.ownerPrincipal,
      artifactPaths: existing.artifactPaths,
      hostModules: structuredClone(existing.hostModules),
    };
  }

  async #planTrigger(
    arcRunId: ArcRunId,
    dialog: Dialog,
    recorder: RecordingRuntime,
    opts: {
      traversals?: ArcTraversalSet;
      arcRefs?: readonly ArcRef[];
      snapshotId?: ArcDocumentSnapshotId;
      recordIds?: ReadonlyMap<string, string>;
    } = {},
  ): Promise<TriggerPlanResult> {
    return this.#planTriggerFromBrief(
      arcRunId,
      recorder,
      await recorder.startTrigger(opts.traversals ?? [], dialog, {
        arcRefs: opts.arcRefs,
      }),
      dialog,
      { snapshotId: opts.snapshotId, recordIds: opts.recordIds },
    );
  }

  async #planTriggerFromBrief(
    arcRunId: ArcRunId,
    recorder: RecordingRuntime,
    initial: TriggerBrief,
    dialog: Dialog,
    opts: {
      snapshotId?: ArcDocumentSnapshotId;
      recordIds?: ReadonlyMap<string, string>;
    } = {},
  ): Promise<TriggerPlanResult> {
    let brief: TriggerBrief = initial;
    for (let step = 0; step <= MAX_TRIGGER_STEPS; step += 1) {
      if (brief.hostCalls.length > 0) {
        const failure = await this.#moduleExecutions
          .get(arcRunId)!
          .submit(
            recorder.hostModuleState,
            brief.hostCalls,
            {},
            brief.traversals,
            () => recorder.captureHostModuleState(brief),
          );
        if (failure) {
          this.#logger.info("arc_host.host_module.submission_failed", {
            arcRunId,
            ...failure,
          });
          return { status: "idle" };
        }
        return {
          status: "ready",
          deps: [...brief.deps],
          snapshotId:
            opts.snapshotId ??
            (await this.#pinSnapshot(brief.deps, opts.recordIds)),
          brief,
        };
      }

      if (brief.matched) {
        const snapshotId =
          opts.snapshotId ??
          (await this.#pinSnapshot(brief.deps, opts.recordIds));
        return {
          status: "matched",
          matches: [
            {
              arcRef: brief.matched,
              deps: [...brief.deps],
              traversals: structuredClone(brief.traversals),
            },
          ],
          snapshotId,
        };
      }

      if (hasTriggerFrontierWork(brief)) {
        const snapshotId =
          opts.snapshotId ??
          (await this.#pinSnapshot(brief.deps, opts.recordIds));
        return {
          status: "ready",
          deps: [...brief.deps],
          snapshotId,
          brief,
        };
      }

      if (brief.matchableArcs.length > 1) {
        // Every matchable arc activates. Seed each by replaying the settled brief
        // with its own preferred match; the probes are not recorded (the captured
        // trigger stream is replicated into each run at activation), and each
        // probe yields an independent traversal set for its arc.
        const matches: TriggerMatch[] = [];
        const depUnion = new Set<ArcRef>();
        for (const arcRef of brief.matchableArcs) {
          const probe = recorder.probeTrigger(
            brief,
            { preferredMatch: arcRef },
            dialog,
          );
          const deps = [...probe.deps];
          for (const dep of deps) depUnion.add(dep);
          matches.push({
            arcRef,
            deps,
            traversals: structuredClone(probe.traversals),
          });
        }
        return {
          status: "matched",
          matches,
          snapshotId:
            opts.snapshotId ??
            (await this.#pinSnapshot([...depUnion], opts.recordIds)),
        };
      }

      return { status: "idle" };
    }

    return { status: "idle" };
  }

  /**
   * The arcs that participated in a recorded run's trigger resolution, read from
   * its first trigger brief (which evaluates every candidate arc upfront).
   */
  #recordedTriggerDeps(steps: readonly ReplayStep[]): readonly ArcRef[] {
    const firstBrief = steps.find((step) => step.kind === "trigger-brief");
    return firstBrief?.kind === "trigger-brief" ? firstBrief.brief.deps : [];
  }

  async #pinSnapshot(
    deps: readonly ArcRef[],
    recordIds: ReadonlyMap<string, string> = this.#latestDocumentRecordIds,
  ): Promise<ArcDocumentSnapshotId> {
    const sources = new Set<string>();
    for (const dep of deps) sources.add(toArcRefParts(dep).source);
    const documents: string[] = [];
    const capturedDocuments: Document[] = [];
    for (const source of sources) {
      const recordId = recordIds.get(source);
      if (!recordId) {
        throw new Error(
          `No document record registered for Arc source "${source}".`,
        );
      }
      documents.push(recordId);
      const record = await this.#store.getArcDocumentRecord(recordId);
      if (!record) {
        throw new Error(`Arc document record not found: ${recordId}`);
      }
      capturedDocuments.push(record.document);
    }
    const hostModuleSpecs = this.#captureHostModuleSpecs(capturedDocuments);
    const snapshotId = `arc-snapshot:${randomUUID()}`;
    await this.#store.putArcDocumentSnapshot({
      id: snapshotId,
      documents,
      hostModuleSpecs,
      createdAt: new Date().toISOString(),
    });
    return snapshotId;
  }

  #captureHostModuleSpecs(
    documents: readonly Document[],
  ): Readonly<Record<string, HostModuleSpec>> {
    const modules = new Set<string>();
    for (const document of documents) {
      for (const binding of document.hostModules) modules.add(binding.module);
    }
    return Object.fromEntries(
      [...modules].sort().map((module) => {
        const implementation = this.#hostModules.get(module);
        if (!implementation) {
          throw new Error(
            `Cannot snapshot unregistered host module ${JSON.stringify(module)}.`,
          );
        }
        return [module, structuredClone(implementation.declaration)];
      }),
    );
  }

  async #runtimeForSnapshot(
    snapshotId: ArcDocumentSnapshotId,
  ): Promise<Runtime> {
    const cached = this.#snapshotRuntimes.get(snapshotId);
    if (cached) {
      this.#snapshotRuntimes.delete(snapshotId);
      this.#snapshotRuntimes.set(snapshotId, cached);
      return cached;
    }
    const snapshot = await this.#store.getArcDocumentSnapshot(snapshotId);
    if (!snapshot)
      throw new Error(`Arc document snapshot not found: ${snapshotId}`);
    const documents = new Map<string, Document>();
    for (const recordId of snapshot.documents) {
      const record = await this.#store.getArcDocumentRecord(recordId);
      if (!record)
        throw new Error(`Arc document record not found: ${recordId}`);
      documents.set(record.source, record.document);
    }
    const hostModules = this.#hostModulesForSnapshot(snapshot, documents);
    const runtime = this.#buildRuntime(documents, hostModules);
    this.#cacheSnapshotRuntime(snapshotId, runtime);
    return runtime;
  }

  #hostModulesForSnapshot(
    snapshot: ArcDocumentSnapshot,
    documents: ReadonlyMap<string, Document>,
  ): ReadonlyMap<string, HostModuleSpec> {
    const stored = snapshot.hostModuleSpecs;
    if (
      stored === null ||
      typeof stored !== "object" ||
      Array.isArray(stored)
    ) {
      throw new Error(
        `Arc document snapshot ${snapshot.id} has invalid host-module declarations.`,
      );
    }

    const required = new Set<string>();
    for (const document of documents.values()) {
      for (const binding of document.hostModules) required.add(binding.module);
    }
    const storedModules = Object.keys(stored);
    if (
      storedModules.length !== required.size ||
      storedModules.some((module) => !required.has(module))
    ) {
      throw new Error(
        `Arc document snapshot ${snapshot.id} host-module declarations do not match its document imports.`,
      );
    }

    const current = new Map<string, HostModuleSpec>();
    for (const module of [...required].sort()) {
      const persisted = stored[module];
      const issue = validateHostModuleSpec(persisted)[0];
      if (issue) {
        throw new Error(
          `Arc document snapshot ${snapshot.id} has an invalid declaration for host module ${JSON.stringify(module)} at ${issue.path}: ${issue.detail}`,
        );
      }
      const registered = this.#hostModules.get(module)?.declaration;
      if (!registered) {
        throw new Error(
          `Arc document snapshot ${snapshot.id} requires host module ${JSON.stringify(module)}, which is not currently registered.`,
        );
      }
      if (!structurallyEqual(persisted, registered)) {
        throw new Error(
          `Arc document snapshot ${snapshot.id} host module ${JSON.stringify(module)} declaration does not match the current registration.`,
        );
      }
      current.set(module, registered);
    }
    return current;
  }

  #cacheSnapshotRuntime(
    snapshotId: ArcDocumentSnapshotId,
    runtime: Runtime,
  ): void {
    if (this.#snapshotRuntimeCacheSize === 0) return;
    this.#snapshotRuntimes.set(snapshotId, runtime);
    while (this.#snapshotRuntimes.size > this.#snapshotRuntimeCacheSize) {
      const oldest = this.#snapshotRuntimes.keys().next().value;
      if (oldest === undefined) return;
      this.#snapshotRuntimes.delete(oldest);
    }
  }

  #newRecorder(
    runtime: Runtime,
    arcRunId: ArcRunId,
    opts: { reactivationCount: number },
  ): RecordingRuntime {
    return new RecordingRuntime(runtime, this.#replayStore, arcRunId, opts);
  }

  /**
   * Replay an in-flight run against a candidate script and report how the
   * candidate behaves — a read-only probe that forks no run and leaves all
   * state intact. Pass `untilPosition` to stop at a given action position.
   */
  async verifyReplay(
    sourceArcRunId: ArcRunId,
    candidateArcRef: ArcRef,
    opts: { untilPosition?: ActionReplayPosition } = {},
  ): Promise<CompatibleReplay | FailedReplay> {
    return this.#verifyReplay(sourceArcRunId, candidateArcRef, opts);
  }

  /**
   * Move an in-flight run onto a candidate script by forking: verify the
   * candidate, then install a new run at the handoff point, ready to advance.
   * Forks only on a verified candidate, and the source run stays intact.
   */
  async jump(
    sourceArcRunId: ArcRunId,
    candidateArcRef: ArcRef,
    opts: { untilPosition?: ActionReplayPosition } = {},
  ): Promise<JumpedReplay | FailedReplay> {
    const alignment = await this.#verifyReplay(
      sourceArcRunId,
      candidateArcRef,
      opts,
    );
    if (alignment.status === "incompatible") return alignment;
    const sourceRun = await this.#requireRunState(sourceArcRunId);
    const arcRunId = await this.#materializeFork(
      handoffCheckpoint(alignment.regenerated).traversals,
      {
        arcRef: alignment.arcRef,
        deps: alignment.deps,
        snapshotId: alignment.snapshotId,
      },
      sourceRun,
      alignment.regenerated,
      "jump",
    );
    return { ...alignment, arcRunId };
  }

  /**
   * Rewind a run to an earlier recorded checkpoint, producing a new run
   * installed at that checkpoint under the same script, ready to advance. The
   * source run is left untouched. Returns the new run's id.
   */
  async rewind(
    sourceArcRunId: ArcRunId,
    atPosition: ActionReplayPosition,
  ): Promise<{ arcRunId: ArcRunId }> {
    const replayStore = this.#requireReplayStore();
    const sourceRun = await this.#requireRunState(sourceArcRunId);
    if (atPosition.reactivationCount > sourceRun.reactivationCount) {
      throw new Error(
        `Replay position reactivation count ${atPosition.reactivationCount} is newer than committed reactivation count ${sourceRun.reactivationCount} for run ${sourceArcRunId}.`,
      );
    }
    const traversals = await replayStore.getCheckpoint(
      sourceArcRunId,
      atPosition,
    );
    if (!traversals) {
      throw new Error(
        `No replay checkpoint at action:${atPosition.index} for run ${sourceArcRunId}.`,
      );
    }
    const prefix = await this.#copySourcePrefix(sourceArcRunId, atPosition);
    const arcRunId = await this.#materializeFork(
      traversals,
      {
        arcRef: sourceRun.arcRef,
        deps: [...sourceRun.deps],
        snapshotId: sourceRun.snapshotId,
      },
      sourceRun,
      prefix,
      "rewind",
    );
    return { arcRunId };
  }

  /**
   * Drive verification purely on an in-memory runtime (no outbound, no host
   * work): align the recorded trigger stream to produce the activation target,
   * then align the recorded action stream from the activation seed, comparing
   * each regenerated brief and checkpoint modulo a typed-ref isomorphism.
   */
  async #verifyReplay(
    sourceArcRunId: ArcRunId,
    candidateArcRef: ArcRef,
    opts: { untilPosition?: ActionReplayPosition },
  ): Promise<CompatibleReplay | FailedReplay> {
    const replayStore = this.#requireReplayStore();
    const sourceRun = await this.#requireRunState(sourceArcRunId);
    const steps = await replayStore.listSteps(sourceArcRunId);
    const checkpoints = await replayStore.listCheckpoints(sourceArcRunId);

    const iso = createReplayIso();
    iso.arcs.set(sourceRun.arcRef, candidateArcRef);

    // Scope trigger replay to the arcs that participated in the recorded
    // resolution, mapped through the rename iso — the same scoping the action
    // stage gets below via `#pinSnapshot(deps)`. Replaying against the global
    // latest runtime would re-pose a judgment for a coexisting, un-renamed
    // original arc (the candidate's pre-rename self) that the recorded report,
    // rewritten onto the candidate, never answers — leaving `matched` unset.
    const recordedTriggerDeps = this.#recordedTriggerDeps(steps);
    const triggerScopeDeps = recordedTriggerDeps.map(
      (dep) => iso.arcs.get(dep) ?? dep,
    );
    const triggerRuntime =
      triggerScopeDeps.length > 0
        ? await this.#runtimeForSnapshot(
            await this.#pinSnapshot(triggerScopeDeps),
          )
        : this.#latestRuntime;

    const targetReactivationCount = opts.untilPosition
      ? opts.untilPosition.reactivationCount
      : sourceRun.reactivationCount;
    if (targetReactivationCount > sourceRun.reactivationCount) {
      throw new Error(
        `Replay position reactivation count ${targetReactivationCount} is newer than committed reactivation count ${sourceRun.reactivationCount} for run ${sourceArcRunId}.`,
      );
    }
    let replayTriggerRuntime = triggerRuntime;
    let seedTraversals: ArcTraversalSet | undefined;
    let snapshotId: ArcDocumentSnapshotId | undefined;
    let snapshotRuntime: Runtime | undefined;
    let finalTrigger:
      | Extract<ReturnType<typeof alignTriggerReplay>, { status: "compatible" }>
      | undefined;
    let finalAction:
      | Extract<ReturnType<typeof alignActionReplay>, { status: "compatible" }>
      | undefined;
    const regeneratedTriggerSteps: TriggerReplayStep[] = [];
    const regeneratedActionSteps: ActionReplayStep[] = [];
    const regeneratedCheckpoints: ReplayCheckpoint[] = [];

    for (
      let reactivationCount = 0;
      reactivationCount <= targetReactivationCount;
      reactivationCount += 1
    ) {
      const triggerAlignment = alignTriggerReplay({
        triggerRuntime: replayTriggerRuntime,
        steps,
        candidateArcRef,
        iso,
        reactivationCount,
        seedTraversals,
        arcRefs: reactivationCount === 0 ? undefined : [candidateArcRef],
      });
      if (triggerAlignment.status === "incompatible") return triggerAlignment;
      finalTrigger = triggerAlignment;
      regeneratedTriggerSteps.push(...triggerAlignment.regenerated);

      if (!snapshotRuntime) {
        snapshotId = await this.#pinSnapshot(triggerAlignment.deps);
        snapshotRuntime = await this.#runtimeForSnapshot(snapshotId);
      }
      const actionAlignment = alignActionReplay({
        snapshotRuntime,
        steps,
        checkpoints,
        seedTraversals: triggerAlignment.activationTraversals,
        iso,
        reactivationCount,
        untilPosition:
          reactivationCount === targetReactivationCount
            ? opts.untilPosition
            : undefined,
      });
      if (actionAlignment.status === "incompatible") return actionAlignment;
      finalAction = actionAlignment;
      regeneratedActionSteps.push(...actionAlignment.regeneratedSteps);
      regeneratedCheckpoints.push(...actionAlignment.regeneratedCheckpoints);
      seedTraversals =
        actionAlignment.regeneratedCheckpoints.at(-1)?.traversals;
      replayTriggerRuntime = snapshotRuntime;
    }

    if (!finalTrigger || !finalAction || !snapshotId) {
      throw new Error("Replay produced no activation.");
    }
    return {
      status: "compatible",
      iso,
      arcRef: finalTrigger.arcRef,
      deps: finalTrigger.deps,
      snapshotId,
      handoff: finalAction.handoff,
      regenerated: {
        triggerSteps: regeneratedTriggerSteps,
        actionSteps: regeneratedActionSteps,
        checkpoints: regeneratedCheckpoints,
      },
    };
  }

  /**
   * Install a new run materialized from a fork or rewind. Creates a fresh run
   * id, persists run state with the seed traversals, inherits the source run's
   * owner/workspace/artifacts, and writes the supplied replay prefix as the new
   * run's own replay data so it stays replayable from its origin. Does not call
   * `start`/`#settle`; the source run is left untouched.
   */
  async #materializeFork(
    seedTraversals: ArcTraversalSet,
    binding: {
      arcRef: ArcRef;
      deps: readonly ArcRef[];
      snapshotId: ArcDocumentSnapshotId;
    },
    sourceRun: ArcRunState,
    replayPrefix: RegeneratedReplay,
    route: "jump" | "rewind",
  ): Promise<ArcRunId> {
    const arcRunId: ArcRunId = `arc-run:${randomUUID()}`;
    const now = new Date().toISOString();
    const reactivationCount =
      handoffCheckpoint(replayPrefix).position.reactivationCount;
    const replayStore = this.#replayStore;
    if (replayStore) {
      for (const step of replayPrefix.triggerSteps) {
        await replayStore.appendStep(arcRunId, step);
      }
      for (const step of replayPrefix.actionSteps) {
        await replayStore.appendStep(arcRunId, step);
      }
      for (const checkpoint of replayPrefix.checkpoints) {
        await replayStore.putCheckpoint(arcRunId, checkpoint);
      }
    }
    await this.#store.putState(arcRunKey(arcRunId), {
      arcRunId,
      ownerPrincipal: sourceRun.ownerPrincipal,
      arcRef: binding.arcRef,
      deps: [...binding.deps],
      snapshotId: binding.snapshotId,
      traversals: structuredClone(seedTraversals),
      reactivationCount,
      lifecycle: lifecycleFromTraversals(binding.arcRef, seedTraversals),
      createdAt: now,
      updatedAt: now,
      workspacePath: sourceRun.workspacePath,
      contextIsolation: sourceRun.contextIsolation,
      artifactPaths: [...sourceRun.artifactPaths],
      hostModules: structuredClone(handoffCheckpoint(replayPrefix).hostModules),
    });
    await this.#workEvents.append({ kind: "run:started", arcRunId, route });
    const lifecycle = lifecycleFromTraversals(binding.arcRef, seedTraversals);
    if (lifecycle !== "active") {
      await this.#workEvents.append(
        lifecycle === "poisoned"
          ? {
              kind: "run:poisoned",
              arcRunId,
              issues:
                replayPrefix.actionSteps
                  .filter(
                    (step) =>
                      step.kind === "terminal-brief" ||
                      step.kind === "action-brief",
                  )
                  .at(-1)?.brief.issues ?? [],
              instructionIssues: [],
            }
          : {
              kind:
                lifecycle === "completed" ? "run:completed" : "run:deflected",
              arcRunId,
            },
      );
    }
    return arcRunId;
  }

  /**
   * Copy a run's own replay data through `forkPoint`: the full trigger stream,
   * action briefs and checkpoints through the fork point, and action reports
   * only for indexes strictly before it (the install point is pre-report).
   */
  async #copySourcePrefix(
    sourceArcRunId: ArcRunId,
    forkPoint: ActionReplayPosition,
  ): Promise<RegeneratedReplay> {
    const replayStore = this.#requireReplayStore();
    const steps = await replayStore.listSteps(sourceArcRunId);
    const checkpoints = await replayStore.listCheckpoints(sourceArcRunId);
    const triggerSteps: TriggerReplayStep[] = [];
    const actionSteps: RegeneratedReplay["actionSteps"] = [];
    const targetReactivationCount = forkPoint.reactivationCount;
    const beforeTargetReactivation = (position: {
      reactivationCount: number;
    }) => position.reactivationCount < targetReactivationCount;
    const atTargetReactivation = (position: { reactivationCount: number }) =>
      position.reactivationCount === targetReactivationCount;
    for (const step of steps) {
      if (step.kind === "trigger-brief" || step.kind === "trigger-report") {
        if (
          beforeTargetReactivation(step.position) ||
          atTargetReactivation(step.position)
        ) {
          triggerSteps.push(step);
        }
      } else if (
        step.kind === "action-brief" ||
        step.kind === "terminal-brief"
      ) {
        if (
          beforeTargetReactivation(step.position) ||
          (atTargetReactivation(step.position) &&
            step.position.index <= forkPoint.index)
        ) {
          actionSteps.push(step);
        }
      } else if (
        beforeTargetReactivation(step.position) ||
        (atTargetReactivation(step.position) &&
          step.position.index < forkPoint.index)
      ) {
        actionSteps.push(step);
      }
    }
    return {
      triggerSteps,
      actionSteps,
      checkpoints: checkpoints.filter(
        (checkpoint) =>
          beforeTargetReactivation(checkpoint.position) ||
          (atTargetReactivation(checkpoint.position) &&
            checkpoint.position.index <= forkPoint.index),
      ),
    };
  }

  #requireReplayStore(): ReplayStore {
    if (!this.#replayStore) {
      throw new Error("Replay operations require a configured replayStore.");
    }
    return this.#replayStore;
  }

  async #requireRunState(arcRunId: ArcRunId): Promise<ArcRunState> {
    const state = await this.#store.getState(arcRunKey(arcRunId));
    if (!state) throw new Error(`Unknown Arc run ${arcRunId}.`);
    assertHostModuleState(state.hostModules);
    return state;
  }

  async #progressAction(
    recorder: RecordingRuntime,
    arcRunId: ArcRunId,
    state: ArcRunRuntimeState,
    events: RunEventCollection,
    brief: ActionBrief,
    report: ActionReport,
    dialog: Dialog,
    origin: Extract<ActionReplayStep, { kind: "action-report" }>["origin"],
    effect?: HostModuleEffect,
  ): Promise<ActionBrief | TerminalBrief> {
    const validation = validateActionReport(brief, report);
    if (!validation.rejected && validation.accepted.move === "interrupt") {
      events.committed.push({
        kind: "run:interruption-occurred",
        arcRunId,
        origin: brief.active,
        interruption: {
          id: validation.accepted.interruption!.id,
          reason: validation.accepted.interruption!.reason ?? "",
        },
      });
      this.#enqueueRunEvents(events);
    }
    return recorder.progress(brief, report, dialog, origin, {
      moduleEffect: effect,
      beforeProgress: () => this.#moduleExecutions.get(arcRunId)?.assertOpen(),
      progressed: () => {
        if (
          validation.rejected ||
          this.#committedControlBriefs.has(brief) ||
          validation.accepted.move !== "deflect"
        )
          return;
        events.staged.push({
          kind: "run:deflection-occurred",
          arcRunId,
          reactivationCount: state.reactivationCount,
          origin: brief.deflection?.origin ?? brief.active,
        });
        events.onCommit.push(() => {
          this.#committedControlBriefs.add(brief);
        });
      },
    });
  }

  async #settle(
    recorder: RecordingRuntime,
    arcRunId: ArcRunId,
    initialState: ArcRunRuntimeState,
    initial: ActionBrief | TerminalBrief,
    dialog: Dialog,
    projectDialog: DialogProjector,
    opts: { deferStatePublish?: boolean; events: RunEventCollection },
  ): Promise<{
    frontier: RunFrontier;
    brief: ActionBrief | TerminalBrief;
    state: ArcRunRuntimeState;
  }> {
    // Host module submission and required deflection establish durable boundaries.
    const publishState = async (next: ArcRunRuntimeState): Promise<void> => {
      if (!brief.canProgress) {
        await recorder.captureHostModuleState(brief);
      }
      if (opts.events.onCommit.length > 0) opts.deferStatePublish = false;
      if (!opts.deferStatePublish) {
        await this.#putState(arcRunId, next, opts.events, {
          issues: brief.issues,
          instructionIssues,
        });
        this.#trackActionState(arcRunId, next, brief, recorder);
        await this.#publishRunEvents(opts.events);
      }
    };
    let brief = initial;
    const instructionIssues: InstructionIssue[] = [];
    let state = initialState;
    const execution = this.#actionSession(arcRunId);
    this.#trackActionState(arcRunId, state, brief, recorder, "ready");
    recorder.setHostModuleState(state.hostModules);
    // The settle-scoped current view. A transition rotates it to the new
    // position's worker role; every later report in this settle uses the
    // rotated view.
    let view = dialog;
    const transitions: RunTransition[] = [];
    let steps = 0;
    let transitionCount = 0;
    while (steps < MAX_SETTLE_STEPS) {
      state = {
        ...state,
        traversals: brief.traversals,
      };

      if (!brief.canProgress) {
        await publishState(state);
        return {
          frontier: this.#frontierFromHandback(
            arcRunId,
            state,
            brief,
            transitions,
          ),
          brief,
          state,
        };
      }
      state = {
        ...state,
        artifactPaths: unionArtifactPaths(state.artifactPaths, brief),
      };
      await publishState(state);

      if (!(await this.#canAdvance(arcRunId))) {
        if (execution?.phase.kind === "live")
          execution.phase.settlement = "pending";
        return {
          frontier: await this.#frontierFromBrief(
            arcRunId,
            state,
            brief,
            view,
            transitions,
          ),
          brief,
          state,
        };
      }

      // The transition branch runs first: any accepted report acknowledges the
      // pending transition, so no report may be issued before the view rotates.
      // Transition briefs are exclusive (runtime-asserted empty frontier), so
      // the acknowledgment is a bare proceed, and these iterations do not count
      // toward `MAX_SETTLE_STEPS`.
      if (brief.transition) {
        transitionCount += 1;
        if (transitionCount > MAX_SETTLE_TRANSITIONS) {
          brief = await recorder.progress(
            brief,
            {
              move: "poison",
              poisonReason: {
                reasonCode: "transition-limit-exceeded",
                reason: `Settle exceeded ${MAX_SETTLE_TRANSITIONS} transitions.`,
              },
            },
            view,
            "host-poison",
          );
          continue;
        }
        const role = roleFromHostParams(brief.transition.hostParams);
        try {
          view = await projectDialog({ roleId: role });
        } catch (error: unknown) {
          // The host cannot produce the new position's view; continuing on the
          // old one is exactly the wrong-view defect, so fail like a failed
          // host call.
          brief = await recorder.progress(
            brief,
            {
              move: "poison",
              poisonReason: {
                reasonCode: "dialog-projection-failed",
                reason: error instanceof Error ? error.message : String(error),
              },
            },
            view,
            "host-poison",
          );
          continue;
        }
        const transition: RunTransition = {
          exited: [...brief.transition.exited],
          entered: [...brief.transition.entered],
          position: brief.transition.position,
          role,
        };
        brief = await recorder.progress(
          brief,
          { move: "proceed" },
          view,
          "host-transition",
        );
        transitions.push(transition);
        for (const [kind, refs] of [
          ["node:entered", transition.entered],
          ["node:exited", transition.exited],
        ] as const)
          for (const ref of refs)
            opts.events.staged.push(
              await this.#nodeTransitionEvent(
                arcRunId,
                kind,
                ref,
                transition.role,
                state.snapshotId,
              ),
            );
        continue;
      }
      const failure = await this.#moduleExecutions
        .get(arcRunId)!
        .submit(
          state.hostModules,
          brief.hostCalls,
          { arcRunId, arcRef: state.arcRef },
          brief.traversals,
          async () => {
            opts.deferStatePublish = false;
            await recorder.captureHostModuleState(brief);
            await publishState(state);
          },
        );

      if (failure) {
        brief = await recorder.progress(
          brief,
          { move: "poison", poisonReason: failure },
          view,
          "host-poison",
        );
        continue;
      }
      steps += 1;
      if (brief.deflection) {
        if (opts.deferStatePublish) {
          opts.deferStatePublish = false;
          await publishState(state);
        }
        brief = await this.#progressAction(
          recorder,
          arcRunId,
          state,
          opts.events,
          brief,
          { move: "deflect" },
          view,
          "host-deflection",
        );
        continue;
      }
      if (brief.hostCalls.length > 0) {
        return {
          frontier: await this.#frontierFromBrief(
            arcRunId,
            state,
            brief,
            view,
            transitions,
          ),
          brief,
          state,
        };
      }

      if (!hasReturnableFrontier(brief)) {
        // A brief with nothing dispatchable and no legal proceed rests here;
        // auto-proceeding would be an illegal move and spin on re-briefs.
        if (!brief.allowedMoves.includes("proceed")) {
          return {
            frontier: await this.#frontierFromBrief(
              arcRunId,
              state,
              brief,
              view,
              transitions,
            ),
            brief,
            state,
          };
        }
        brief = await recorder.progress(
          brief,
          { move: "proceed" },
          view,
          "host-proceed",
        );
        continue;
      }

      const frontier = await this.#frontierFromBrief(
        arcRunId,
        state,
        brief,
        view,
        transitions,
      );
      if (
        frontier.instructionIssues.length === 0 ||
        !brief.allowedMoves.includes("poison")
      ) {
        return { frontier: frontier, brief, state };
      }
      instructionIssues.push(...frontier.instructionIssues);
      const issue = frontier.instructionIssues[0]!;
      brief = await recorder.progress(
        brief,
        {
          move: "poison",
          poisonReason: { reasonCode: issue.code, reason: issue.message },
        },
        view,
        "host-poison",
      );
      state = {
        ...state,
        traversals: brief.traversals,
      };
      if (brief.canProgress) {
        state = {
          ...state,
          artifactPaths: unionArtifactPaths(state.artifactPaths, brief),
        };
      }
      await publishState(state);
      return {
        frontier: {
          ...(await this.#frontierFromOutput(
            arcRunId,
            state,
            brief,
            view,
            transitions,
          )),
          instructionIssues,
        },
        brief,
        state,
      };
    }
    state = { ...state, traversals: brief.traversals };
    await publishState(state);
    return {
      frontier: await this.#frontierFromOutput(
        arcRunId,
        state,
        brief,
        view,
        transitions,
      ),
      brief,
      state,
    };
  }

  #trackActioningSession(
    key: string,
    settled: {
      frontier: RunFrontier;
      brief: ActionBrief | TerminalBrief;
      state: ArcRunRuntimeState;
    },
    recorder: RecordingRuntime,
  ): void {
    this.#trackActionState(
      decodeURIComponent(key),
      { ...settled.state, traversals: settled.frontier.traversals },
      settled.brief,
      recorder,
    );
  }

  #trackActionState(
    arcRunId: ArcRunId,
    state: ArcRunRuntimeState,
    brief: ActionBrief | TerminalBrief,
    recorder: RecordingRuntime,
    settlement?: "ready" | "pending",
  ): void {
    const execution = this.#actionSession(arcRunId);
    if (!execution) return;
    const previous = execution.phase;
    execution.phase = brief.canProgress
      ? {
          kind: "live",
          live: { state, brief, recorder },
          settlement:
            settlement ??
            (previous.kind === "live" ? previous.settlement : "ready"),
        }
      : { kind: "ended" };
  }

  async #frontierFromOutput(
    arcRunId: ArcRunId,
    state: ArcRunRuntimeState,
    brief: ActionBrief | TerminalBrief,
    dialog: Dialog,
    transitions: readonly RunTransition[] = [],
  ): Promise<RunFrontier> {
    return brief.canProgress
      ? this.#frontierFromBrief(arcRunId, state, brief, dialog, transitions)
      : this.#frontierFromHandback(arcRunId, state, brief, transitions);
  }

  #frontierFromHandback(
    arcRunId: ArcRunId,
    state: ArcRunRuntimeState,
    brief: TerminalBrief,
    transitions: readonly RunTransition[] = [],
  ): RunFrontier {
    return {
      status:
        brief.outcome === "covered"
          ? "completed"
          : brief.outcome === "poisoned"
            ? "poisoned"
            : "idle",
      frontierId: this.#frontierId(brief, arcRunId),
      arcRunId,
      arcRef: state.arcRef,
      deps: [...state.deps],
      snapshotId: state.snapshotId,
      traversals: structuredClone(brief.traversals),
      canProgress: false,
      allowedMoves: [],
      issues: brief.issues,
      instructionIssues: [],
      briefs: {
        judgments: [],
        observations: [],
        instructions: [],
      },
      tasks: [],
      transitions: [...transitions],
    };
  }

  async #frontierFromBrief(
    arcRunId: ArcRunId,
    state: ArcRunRuntimeState,
    brief: ActionBrief,
    dialog: Dialog,
    transitions: readonly RunTransition[] = [],
  ): Promise<RunFrontier> {
    const { instruction, instructionIssues, postcheckingInstructions } =
      await this.#agentInstructionFromActionBrief(
        arcRunId,
        state,
        brief,
        dialog,
      );
    // Arcade waits for instruction application before dispatching these checks,
    // so they use the updated dialog, including any awaited reply.
    // This is Arcade's scheduling policy; Arc also accepts check evidence before
    // or alongside application. This policy ensures that $instructLoop would not
    // prematurely start a new lap to deliver the same instruction while the
    // previous one is still being applied.
    const deferredPostcheckIds = new Set(
      brief.instructions
        .filter((item) => item.phase === "apply")
        .flatMap((item) => [
          ...(item.postcheck?.judgmentIds ?? []),
          ...(item.postcheck?.observationIds ?? []),
        ]),
    );
    const semanticTasks = await semanticTasksFromBrief({
      stage: "action",
      arcRunId,
      dialog,
      contextIsolationForSourceRef: (sourceRef) =>
        this.#effectiveContextIsolation(state, sourceRef),
      judgments: brief.judgments.filter(
        (item) => !deferredPostcheckIds.has(item.id),
      ),
      observations: brief.observations.filter(
        (item) => !deferredPostcheckIds.has(item.id),
      ),
      postcheckingInstructions,
    });
    const status = statusFromBrief(state.arcRef, brief);
    return {
      status,
      frontierId: this.#frontierId(brief, arcRunId),
      arcRunId,
      arcRef: state.arcRef,
      deps: [...state.deps],
      snapshotId: state.snapshotId,
      traversals: structuredClone(brief.traversals),
      active: brief.active,
      canProgress: brief.canProgress,
      allowedMoves: [...brief.allowedMoves],
      issues: brief.issues,
      instructionIssues,
      briefs: {
        judgments: brief.judgments,
        observations: brief.observations,
        instructions: brief.instructions,
      },
      tasks: instruction ? [...semanticTasks, instruction] : semanticTasks,
      transitions: [...transitions],
    };
  }

  async #frontierFromTriggerBrief(
    arcRunId: ArcRunId,
    deps: readonly ArcRef[],
    snapshotId: ArcDocumentSnapshotId,
    brief: TriggerBrief,
    dialog: Dialog,
  ): Promise<RunFrontier> {
    const semanticTasks = await semanticTasksFromBrief({
      stage: "trigger",
      arcRunId,
      dialog,
      contextIsolationForSourceRef: () => "role",
      judgments: brief.judgments,
      observations: brief.observations,
      postcheckingInstructions: new Map(),
    });
    return {
      status: semanticTasks.length ? "ready" : "blocked",
      frontierId: this.#frontierId(brief),
      arcRunId,
      deps: [...deps],
      snapshotId,
      traversals: structuredClone(brief.traversals),
      canProgress: true,
      allowedMoves: [],
      issues: brief.issues,
      instructionIssues: [],
      briefs: {
        judgments: brief.judgments,
        observations: brief.observations,
        instructions: [],
      },
      tasks: semanticTasks,
      transitions: [],
    };
  }

  /**
   * The worker role for a run's current position, read from the persisted
   * frontier: the active frame's node when one is recorded, else the root
   * itself. A declared `hostParams.workerRole` wins; everything else is the
   * default worker role.
   */
  #workerRoleForTraversals(
    runtime: Runtime,
    traversals: ArcTraversalSet,
  ): string {
    const root = findActiveRoot(traversals);
    if (!root) return DEFAULT_WORKER_ROLE;
    const rootParts = toArcRefParts(root.ref);
    const positionRef =
      root.activeFrame?.activeRef ??
      toNodeRef(rootParts.source, [rootParts.identifier]);
    const node = runtime.nodeForRef(positionRef);
    return roleFromHostParams(node?.hostParams);
  }

  async #effectiveContextIsolation(
    state: ArcRunRuntimeState,
    ref: NodeRef,
  ): Promise<ContextIsolation> {
    const runtime = await this.#runtimeForSnapshot(state.snapshotId);
    const node = runtime.nodeForRef(ref);
    if (!node) {
      throw new Error(
        `Arc run snapshot ${state.snapshotId} has no node for source ref ${ref}.`,
      );
    }
    return resolveContextIsolation(
      state.contextIsolation,
      readNodeContextIsolation(node.hostParams),
    );
  }

  async #agentInstructionFromActionBrief(
    arcRunId: ArcRunId,
    state: ArcRunRuntimeState,
    actionBrief: ActionBrief,
    dialog: Dialog,
  ): Promise<{
    instruction?: InstructionTask;
    postcheckingInstructions: Map<BriefId, InstructionTask>;
    instructionIssues: InstructionIssue[];
  }> {
    const parsedItems: ParsedInstructionItem[] = [];
    const instructionIssues: InstructionIssue[] = [];
    for (const item of actionBrief.instructions) {
      const result = readWorkerInstruction(item);
      if (!result.ok) {
        instructionIssues.push(...result.issues);
        continue;
      }
      parsedItems.push({ brief: item, instruction: result.instruction });
    }
    // Only `apply` instructions are dispatched as work. A `postcheck`
    // instruction is still pending, but the brief is focused on resolving its
    // follow-up checks, so re-presenting it would re-run the instruction once
    // per check cycle. It reaches the worker as context on the semantic task
    // instead, via `postcheckingInstructions`.
    const dispatchItems = parsedItems.filter(
      (item) => item.brief.phase === "apply",
    );
    let instruction: InstructionTask | undefined;
    if (dispatchItems.length > 0) {
      const sourceRef = instructionTaskSourceRef(dispatchItems);
      instruction = buildInstructionTaskFromBriefs({
        items: dispatchItems,
        traversals: actionBrief.traversals,
        active: actionBrief.active,
        arcRunId,
        dialog,
        contextIsolation: await this.#effectiveContextIsolation(
          state,
          sourceRef,
        ),
      });
    }
    const postcheckingInstructions = await buildPostcheckingInstructions({
      items: parsedItems,
      traversals: actionBrief.traversals,
      active: actionBrief.active,
      arcRunId,
      dialog,
      contextIsolationForSourceRef: (sourceRef) =>
        this.#effectiveContextIsolation(state, sourceRef),
    });
    return { instruction, postcheckingInstructions, instructionIssues };
  }

  #buildReport(
    brief: ActionBrief,
    reports: readonly RoutineReport[],
    coverage: InstructionCoverage,
  ): ActionReport {
    const failedReport = reports.find(
      (report): report is Extract<RoutineReport, { error: "failed" }> =>
        report.error === "failed",
    );
    const failedCoverage = Object.entries(coverage).find(
      ([, value]) => value === "failed",
    );
    if (failedReport || failedCoverage) {
      return {
        move: "poison",
        poisonReason: {
          reasonCode: failedReport?.code ?? "worker-failed",
          reason:
            failedReport?.message ??
            `Worker failed while applying ${failedCoverage?.[0] ?? "an instruction"}.`,
        },
      };
    }

    const shouldDeflect =
      reports.some((report) => report.outcome === "deflected") ||
      Object.values(coverage).some((value) => value === "deflected");
    if (shouldDeflect && brief.allowedMoves.includes("deflect"))
      return { move: "deflect" };

    const semantic = collectSemanticResults(reports);
    const instructions = Object.fromEntries(
      Object.entries(coverage)
        .filter(([, status]) => status === "applied")
        .map(([id]) => [id, { status: "applied" as const }]),
    );
    return {
      move: "proceed",
      instructions:
        Object.keys(instructions).length > 0 ? instructions : undefined,
      judgments:
        Object.keys(semantic.judgments).length > 0
          ? semantic.judgments
          : undefined,
      observations:
        Object.keys(semantic.observations).length > 0
          ? semantic.observations
          : undefined,
    };
  }

  #enqueueRunEvents(events: RunEventCollection): void {
    const publications = (events.publications ??= []);
    for (const event of events.committed.splice(0)) {
      let publication: Promise<unknown>;
      try {
        publication = this.#workEvents.append(event);
      } catch (error) {
        publication = Promise.reject(error);
      }
      void publication.catch(() => undefined);
      publications.push(publication);
    }
  }

  async #publishRunEvents(events: RunEventCollection): Promise<void> {
    this.#enqueueRunEvents(events);
    await Promise.all(events.publications ?? []);
    events.publications = [];
  }

  async #nodeTransitionEvent(
    arcRunId: ArcRunId,
    kind: "node:entered" | "node:exited",
    ref: NodeRef,
    role: string,
    snapshotId: ArcDocumentSnapshotId,
  ): Promise<CreateWorkEventInput> {
    // Activation can stage transitions before the first run-state commit.
    // Resolve from its immutable snapshot, which already exists at this point.
    const runtime = await this.#runtimeForSnapshot(snapshotId);
    const node = runtime.nodeForRef(ref);
    return {
      arcRunId,
      kind,
      nodeName: node?.identifier ?? toNodeRefParts(ref).path.join("."),
      ...(node?.description !== undefined
        ? { nodeDescription: node.description }
        : {}),
      role,
    };
  }

  async #putState(
    arcRunId: string,
    state: ArcRunRuntimeState,
    events: RunEventCollection,
    diagnostics: Pick<RunFrontier, "issues" | "instructionIssues">,
  ): Promise<void> {
    this.#moduleExecutions.get(arcRunId)?.assertOpen();
    const existing = await this.#store.getState(arcRunKey(arcRunId));
    const lifecycle = lifecycleFromTraversals(state.arcRef, state.traversals);
    const now = new Date().toISOString();
    await this.#store.putState(arcRunKey(arcRunId), {
      arcRunId,
      ownerPrincipal: state.ownerPrincipal,
      arcRef: state.arcRef,
      deps: [...state.deps],
      snapshotId: state.snapshotId,
      traversals: structuredClone(state.traversals),
      reactivationCount: state.reactivationCount,
      lifecycle,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      workspacePath: state.workspacePath,
      contextIsolation: state.contextIsolation,
      artifactPaths: [...state.artifactPaths],
      hostModules: structuredClone(state.hostModules),
    });
    if (events.start) {
      events.committed.push(events.start);
      events.start = undefined;
    }
    events.committed.push(...events.staged.splice(0));
    for (const commit of events.onCommit.splice(0)) commit();
    if (
      lifecycle !== "active" &&
      (existing?.lifecycle !== lifecycle ||
        existing.reactivationCount !== state.reactivationCount)
    ) {
      events.committed.push(
        lifecycle === "poisoned"
          ? {
              kind: "run:poisoned",
              arcRunId,
              issues: structuredClone(diagnostics.issues),
              instructionIssues: structuredClone(diagnostics.instructionIssues),
            }
          : {
              kind:
                lifecycle === "completed" ? "run:completed" : "run:deflected",
              arcRunId,
            },
      );
    }
  }

  async #findRunChoiceCandidates(
    ownerPrincipal: string,
    arcRef: ArcRef,
    opts: { excludeArcRunId?: ArcRunId } = {},
  ): Promise<RunChoiceCandidate[]> {
    const result: RunChoiceCandidate[] = [];
    for await (const [, state] of this.#store.listStates()) {
      if (state.arcRunId === opts.excludeArcRunId) continue;
      if (
        this.#isRunChoiceCandidateState(state, arcRef, ownerPrincipal) &&
        state.lifecycle === "active" &&
        (await this.#usesCurrentArcDocuments(state))
      ) {
        result.push({
          arcRunId: state.arcRunId,
          arcRef: state.arcRef,
          lifecycle: state.lifecycle,
          createdAt: state.createdAt,
          updatedAt: state.updatedAt,
          workspacePath: state.workspacePath,
        });
      }
    }
    result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return result;
  }

  #isRunChoiceCandidateState(
    state: {
      arcRef: ArcRef;
      ownerPrincipal: string;
      lifecycle?: ArcRunLifecycle;
    },
    arcRef: ArcRef,
    ownerPrincipal: string,
  ): state is typeof state & {
    lifecycle: Extract<ArcRunLifecycle, "active" | "deflected">;
  } {
    return (
      state.ownerPrincipal === ownerPrincipal &&
      state.arcRef === arcRef &&
      (state.lifecycle === "active" || state.lifecycle === "deflected")
    );
  }

  /**
   * A replaced Arc source starts a fresh run instead of joining a run pinned
   * to an older source snapshot. Identical documents registered after a process
   * restart remain compatible even though their immutable record ids differ.
   */
  async #usesCurrentArcDocuments(state: ArcRunState): Promise<boolean> {
    const snapshot = await this.#store.getArcDocumentSnapshot(state.snapshotId);
    if (!snapshot) return false;

    const dependencySources = new Set(
      state.deps.map((dep) => toArcRefParts(dep).source),
    );
    const usesLatestRecordIds = [...dependencySources].every((source) => {
      const latestRecordId = this.#latestDocumentRecordIds.get(source);
      return (
        latestRecordId !== undefined &&
        snapshot.documents.includes(latestRecordId)
      );
    });
    if (usesLatestRecordIds) return true;

    const snapshotDocuments = new Map<string, Document>();
    for (const recordId of snapshot.documents) {
      const record = await this.#store.getArcDocumentRecord(recordId);
      if (record) snapshotDocuments.set(record.source, record.document);
    }

    for (const source of dependencySources) {
      const latest = [...this.#arcs.values()].find(
        (registered) => registered.source === source,
      )?.document;
      const pinned = snapshotDocuments.get(source);
      if (
        !latest ||
        !pinned ||
        !structurallyEqual(jsonComparable(latest), jsonComparable(pinned))
      ) {
        return false;
      }
    }
    return true;
  }

  /** Map a live frontier to its step, keyed by whether the run is triggering. */
  #frontierToStep(arcRunId: ArcRunId, frontier: RunFrontier): ArcHostStep {
    const kind =
      this.#liveSessions.get(arcRunKey(arcRunId))?.kind === "triggering"
        ? "trigger"
        : "action";
    return { kind, arcRunId, frontier };
  }

  /** Hub-facing projection of a staged handshake (its `PendingHandshake` stays internal). */
  #handshakeStep(
    handshake: PendingHandshake,
  ): Extract<ArcHostStep, { kind: "handshake" }> {
    const requirement = handshake.requirements[0];
    if (!requirement) {
      throw new Error(`Staged handshake ${handshake.id} has no requirement.`);
    }
    return {
      kind: "handshake",
      arcRunId: handshake.triggerSelection.arcRunId,
      handshakeId: handshake.id,
      arcRef: handshake.arcRef,
      requirement,
    };
  }

  async #stageRunChoiceHandshake(
    arcRef: ArcRef,
    candidates: readonly RunChoiceCandidate[],
    request: ActivationRequest,
    triggerSelection: PendingTriggerSelection,
    dialog: Dialog,
    opts: {
      reentrySelections?: readonly PendingReentrySelection[];
      freshAvailable?: boolean;
    } = {},
  ): Promise<PendingHandshake> {
    const freshAvailable = opts.freshAvailable ?? true;
    return this.#stageHandshake({
      id: this.#handshakes.newId(),
      clientId: request.clientId ?? "",
      principal: request.principal,
      arcRef,
      triggerSelection,
      reentrySelections: opts.reentrySelections,
      freshAvailable,
      dialog,
      requirements: [
        {
          kind: "run-choice",
          freshAvailable,
          candidates,
        },
      ],
      createdAt: new Date().toISOString(),
    });
  }

  async #stageArcChoiceHandshake(
    arcRef: ArcRef,
    request: ActivationRequest,
    triggerSelection: PendingTriggerSelection,
    dialog: Dialog,
    opts: {
      reentrySelections?: readonly PendingReentrySelection[];
      freshAvailable?: boolean;
    } = {},
  ): Promise<PendingHandshake> {
    return this.#stageHandshake({
      id: this.#handshakes.newId(),
      clientId: request.clientId ?? "",
      principal: request.principal,
      arcRef,
      triggerSelection,
      reentrySelections: opts.reentrySelections,
      freshAvailable: opts.freshAvailable,
      dialog,
      requirements: [
        {
          kind: "arc-choice",
        },
      ],
      createdAt: new Date().toISOString(),
    });
  }

  async #stageWorkspaceHandshake(
    arcRef: ArcRef,
    request: ActivationRequest,
    triggerSelection: PendingTriggerSelection,
    dialog: Dialog,
  ): Promise<PendingHandshake> {
    return this.#stageHandshake({
      id: this.#handshakes.newId(),
      clientId: request.clientId ?? "",
      principal: request.principal,
      arcRef,
      triggerSelection,
      dialog,
      requirements: [
        {
          kind: "workspace",
        },
      ],
      createdAt: new Date().toISOString(),
    });
  }

  async #stageHandshake(
    handshake: PendingHandshake,
  ): Promise<PendingHandshake> {
    this.#handshakes.stage(handshake);
    const key = arcRunKey(handshake.triggerSelection.arcRunId);
    if (this.#liveSessions.get(key)?.kind === "preparing")
      this.#liveSessions.delete(key);
    await this.#workEvents.append({
      kind: "run:handshake-pending",
      arcRunId: handshake.triggerSelection.arcRunId,
      handshakeId: handshake.id,
    });
    return handshake;
  }

  async #consumeHandshake(
    handshake: PendingHandshake,
    outcome: HandshakeOutcome,
    operation: PreparationOperation,
  ): Promise<void> {
    if (this.#handshakes.get(handshake.id) !== handshake)
      throw new Error(`Handshake ${handshake.id} is no longer pending.`);
    const preparing =
      outcome.kind === "proceed" || outcome.kind === "reentry"
        ? this.#prepare(
            handshake.triggerSelection.arcRunId,
            handshake.principal,
            handshake.arcRef,
          )
        : undefined;
    if (!this.#handshakes.take(handshake.id)) {
      if (preparing)
        this.#releasePreparation(
          handshake.triggerSelection.arcRunId,
          preparing,
        );
      throw new Error(`Handshake ${handshake.id} is no longer pending.`);
    }
    operation.entry = preparing;
    operation.arcRunId = handshake.triggerSelection.arcRunId;
    await this.#workEvents.append({
      kind: "run:handshake-resolved",
      arcRunId: handshake.triggerSelection.arcRunId,
      handshakeId: handshake.id,
      outcome,
    });
  }

  #validatedWorkspace(
    workspace: string | undefined,
  ): { status: "ok"; value: string } | { status: "invalid"; reason: string } {
    if (typeof workspace !== "string" || !isAbsolute(workspace)) {
      return {
        status: "invalid",
        reason: `Workspace must be an absolute path. Got ${JSON.stringify(workspace)}.`,
      };
    }
    return { status: "ok", value: resolve(workspace) };
  }
}

function activationRequestFrom(
  input: Extract<BeginInput, { arcRunId?: undefined }>,
): ActivationRequest {
  return {
    clientId: input.clientId,
    principal: input.principal,
    activationPolicy: input.activationPolicy ?? "first",
  };
}

function pendingTriggerSelection(
  arcRunId: ArcRunId,
  match: TriggerMatch,
  snapshotId: ArcDocumentSnapshotId,
): PendingTriggerSelection {
  return {
    arcRunId,
    arcRef: match.arcRef,
    deps: [...match.deps],
    snapshotId,
    traversals: structuredClone(match.traversals),
  };
}

function arcDescriptionFor(arc: RegisteredArc): string {
  return `The ${arc.source}/${arc.identifier} arc needs a persistent workspace path for user-owned files shared across runs.`;
}

function cloneArcManifest(manifest: ArcManifest | undefined): ArcManifest {
  return {
    workspaceScope: manifest?.workspaceScope ?? "run",
    bundle: { ...(manifest?.bundle ?? {}) },
    contextIsolation: manifest?.contextIsolation ?? "role",
  };
}

/** Normalize JSON-persisted values by dropping explicitly undefined fields. */
function jsonComparable<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function defaultRunWorkspaceRoot(
  artifactRoot: string,
  arcRunId: ArcRunId,
): string {
  return join(resolve(artifactRoot), arcRunId.replaceAll(":", "-"));
}

/**
 * Invert `defaultRunWorkspaceRoot`'s directory naming, or `undefined` when the
 * name was not written by it.
 *
 * Run ids are `arc-run:<uuid>` and a uuid carries no colon, so the only
 * substitution to undo is the one separating the prefix from the uuid.
 */
function runIdFromWorkspaceDirName(name: string): ArcRunId | undefined {
  const match = /^arc-run-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(
    name,
  );
  return match ? `arc-run:${match[1]}` : undefined;
}

function idleFrontier(arcRunId: ArcRunId): RunFrontier {
  return {
    frontierId: randomUUID(),
    status: "idle",
    arcRunId,
    deps: [],
    traversals: [],
    canProgress: false,
    allowedMoves: [],
    issues: [],
    instructionIssues: [],
    briefs: {
      judgments: [],
      observations: [],
      instructions: [],
    },
    tasks: [],
    transitions: [],
  };
}

type ParsedInstructionItem = {
  brief: InstructionBrief;
  instruction: WorkerInstruction;
};

async function buildPostcheckingInstructions(args: {
  items: readonly ParsedInstructionItem[];
  traversals: ArcTraversalSet;
  active: NodeRef;
  arcRunId: ArcRunId;
  dialog: Dialog;
  contextIsolationForSourceRef: (
    sourceRef: NodeRef,
  ) => ContextIsolation | Promise<ContextIsolation>;
}): Promise<Map<BriefId, InstructionTask>> {
  const postcheckingInstructions = new Map<BriefId, InstructionTask>();
  for (const item of args.items) {
    const postcheck = item.brief.postcheck;
    if (!postcheck) continue;
    const sourceRef = instructionTaskSourceRef([item]);
    const instruction = buildInstructionTaskFromBriefs({
      items: [item],
      traversals: args.traversals,
      active: args.active,
      arcRunId: args.arcRunId,
      dialog: args.dialog,
      contextIsolation: await args.contextIsolationForSourceRef(sourceRef),
    });
    for (const briefId of [
      ...postcheck.judgmentIds,
      ...postcheck.observationIds,
      ...postcheck.hostCallIds,
    ]) {
      postcheckingInstructions.set(briefId, instruction);
    }
  }
  return postcheckingInstructions;
}

async function semanticTasksFromBrief(args: {
  stage: SemanticTask["stage"];
  arcRunId: ArcRunId;
  dialog: Dialog;
  contextIsolationForSourceRef: (
    sourceRef: NodeRef,
  ) => ContextIsolation | Promise<ContextIsolation>;
  judgments: readonly TriggerBrief["judgments"][number][];
  observations: readonly TriggerBrief["observations"][number][];
  postcheckingInstructions: ReadonlyMap<BriefId, InstructionTask>;
}): Promise<SemanticTask[]> {
  const byRole = new Map<string, SemanticTaskGroup[]>();
  let ordinal = 0;

  for (const judgment of args.judgments) {
    ordinal += 1;
    const role = roleFromHostParams(judgment.hostParams);
    const request: SemanticRequest = {
      kind: "judgment",
      briefId: judgment.id,
      role,
      question: judgment.question,
      sourceRef: judgment.sourceRef,
      tool: {
        type: "function",
        name: `arc_judgment_${ordinal}`,
        description: `Resolve Arc judgment ${judgment.id}.`,
        parameters: {
          type: "object",
          properties: {
            value: {
              type: "boolean",
              description: "Boolean judgment result.",
            },
          },
          required: ["value"],
          additionalProperties: false,
        },
        strict: true,
      },
    };
    appendSemanticRequest(
      byRole,
      role,
      request,
      args.postcheckingInstructions.get(request.briefId),
    );
  }

  for (const observation of args.observations) {
    ordinal += 1;
    const role = roleFromHostParams(observation.hostParams);
    const request: SemanticRequest =
      "fields" in observation
        ? {
            kind: "observation-group",
            briefId: observation.id,
            role,
            mode: observation.mode,
            fields: observation.fields,
            sourceRef: observation.sourceRef,
            tool: {
              type: "function",
              name: `arc_observation_group_${ordinal}`,
              description: `Resolve Arc observation group ${
                observation.id
              } for ${observation.fields
                .map((field) => field.cell)
                .join(", ")}.`,
              parameters: observationGroupResultSchema(observation),
              strict: true,
            },
          }
        : {
            kind: "observation",
            briefId: observation.id,
            role,
            cell: observation.cell,
            mode: observation.mode,
            question: observation.question,
            currentValue: observation.currentValue,
            meta: observation.meta,
            sourceRef: observation.sourceRef,
            tool: {
              type: "function",
              name: `arc_observation_${ordinal}`,
              description: `Resolve Arc observation ${observation.id} for ${observation.cell}.`,
              parameters: observationResultSchema(observation),
              strict: true,
            },
          };
    appendSemanticRequest(
      byRole,
      role,
      request,
      args.postcheckingInstructions.get(request.briefId),
    );
  }

  const groups = [...byRole.values()].flat();
  return Promise.all(
    groups.map(async ({ role, requests, activeInstruction }) => {
      const batchId = `semantic:${args.arcRunId}:${args.stage}:${role}:${requests
        .map((request) => request.briefId)
        .join(",")}`;
      const sourceRef = semanticTaskSourceRef({
        stage: args.stage,
        batchId,
        requests,
        activeInstruction,
      });
      return {
        kind: "semantic",
        batchId,
        role,
        stage: args.stage,
        arcRunId: args.arcRunId,
        dialog: args.dialog,
        requests,
        contextIsolation: await args.contextIsolationForSourceRef(sourceRef),
        activeInstruction,
      };
    }),
  );
}

type SemanticTaskGroup = {
  role: string;
  activeInstruction?: InstructionTask;
  requests: SemanticRequest[];
};

function appendSemanticRequest(
  byRole: Map<string, SemanticTaskGroup[]>,
  role: string,
  request: SemanticRequest,
  activeInstruction: InstructionTask | undefined,
): void {
  const groups = byRole.get(role) ?? [];
  const current = groups.find(
    (group) => group.activeInstruction === activeInstruction,
  );
  if (current) {
    current.requests.push(request);
    return;
  }
  groups.push({ role, activeInstruction, requests: [request] });
  byRole.set(role, groups);
}

function roleFromHostParams(params: PayloadValue): string {
  if (!isPayloadObject(params)) return DEFAULT_WORKER_ROLE;
  const role = params.workerRole;
  return typeof role === "string" && role.trim() !== ""
    ? role
    : DEFAULT_WORKER_ROLE;
}

function scalarObservationValueSchema(meta: {
  type: "boolean" | "string" | "enum" | "rangedInt" | "number";
  values?: string[];
  min?: number;
  max?: number;
}): Record<string, unknown> {
  return meta.type === "boolean"
    ? { type: "boolean" }
    : meta.type === "rangedInt"
      ? {
          type: "integer",
          minimum: meta.min,
          maximum: meta.max,
        }
      : meta.type === "number"
        ? {
            type: "number",
            minimum: meta.min,
            maximum: meta.max,
          }
        : {
            type: "string",
            enum: meta.values,
          };
}

function observationResultSchema(
  request: Pick<SemanticRequest & { kind: "observation" }, "mode" | "meta">,
): Record<string, unknown> {
  const valueSchema =
    request.meta.type === "array"
      ? {
          type: "array",
          items: scalarObservationValueSchema(request.meta.element),
        }
      : scalarObservationValueSchema(request.meta);

  return {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum:
          request.mode === "observeOrAsk"
            ? ["resolved", "unknown", "needs-user"]
            : ["resolved", "unknown"],
      },
      value: valueSchema,
    },
    required: ["status"],
    additionalProperties: false,
  };
}

/**
 * Tool schema for a grouped observation: one property per grouped cell, each
 * carrying the same per-cell observation result schema a single observation
 * uses. Every field is required so the model reports the whole group atomically.
 */
function observationGroupResultSchema(
  request: Pick<
    SemanticRequest & { kind: "observation-group" },
    "mode" | "fields"
  >,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of request.fields) {
    properties[field.cell] = observationResultSchema({
      mode: request.mode,
      meta: field.meta,
    });
  }
  return {
    type: "object",
    properties,
    required: request.fields.map((field) => field.cell),
    additionalProperties: false,
  };
}

function isPayloadObject(
  value: PayloadValue | undefined,
): value is ArcStructValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function workSummary(frontier: RunFrontier): Record<string, number> {
  return {
    instructions: frontier.tasks.length,
    judgments: frontier.briefs.judgments.length,
    observations: frontier.briefs.observations.length,
    instructionIssues: frontier.instructionIssues.length,
    issues: frontier.issues.length,
  };
}

function hasTriggerFrontierWork(brief: TriggerBrief): boolean {
  return brief.judgments.length > 0 || brief.observations.length > 0;
}

function hasReturnableFrontier(brief: ActionBrief): boolean {
  return (
    brief.instructions.length > 0 ||
    brief.judgments.length > 0 ||
    brief.observations.length > 0
  );
}

function statusFromBrief(
  arcRef: ArcRef,
  brief: ActionBrief,
): RunFrontier["status"] {
  const root = brief.traversals.find((item) => item.ref === arcRef);
  if (root?.phase === "completed") return "completed";
  if (root?.phase === "poisoned") return "poisoned";
  if (hasReturnableFrontier(brief)) return "ready";
  if (!brief.canProgress) return "idle";
  return "blocked";
}

function lifecycleFromTraversals(
  arcRef: ArcRef,
  traversals: ArcTraversalSet,
): ArcRunLifecycle {
  const root = traversals.find((item) => item.ref === arcRef);
  if (root?.phase === "completed") return "completed";
  if (root?.phase === "poisoned") return "poisoned";
  if (root?.phase === "suspended" && root.state === "deflected")
    return "deflected";
  return "active";
}

function hasFailedTriggerFeedback(input: AdvanceInput): boolean {
  return (
    "reports" in input &&
    input.reports.some(
      (report) => report.error === "failed" || report.outcome === "deflected",
    )
  );
}

function buildTriggerReport(reports: readonly RoutineReport[]): TriggerReport {
  const semantic = collectSemanticResults(reports);
  return {
    preferredMatch: semantic.preferredMatch,
    judgments:
      Object.keys(semantic.judgments).length > 0
        ? semantic.judgments
        : undefined,
    observations:
      Object.keys(semantic.observations).length > 0
        ? semantic.observations
        : undefined,
  };
}

function collectSemanticResults(reports: readonly RoutineReport[]): {
  preferredMatch?: ArcRef;
  judgments: Record<string, boolean>;
  observations: Record<string, ObservationReport | ObservationGroupReport>;
} {
  const judgments: Record<string, boolean> = {};
  const observations: Record<
    string,
    ObservationReport | ObservationGroupReport
  > = {};
  let preferredMatch: ArcRef | undefined;
  for (const report of reports) {
    if (report.outcome !== "completed") continue;
    Object.assign(judgments, report.semantic?.judgments);
    Object.assign(observations, report.semantic?.observations);
    preferredMatch = report.semantic?.preferredMatch ?? preferredMatch;
  }
  return { preferredMatch, judgments, observations };
}

function collectWorkerRolesFromDocument(
  document: Document,
  out: Set<string>,
): void {
  for (const root of document.roots) collectWorkerRolesFromNode(root, out);
}

/** Project durable run state into the connector-facing read view. */
function arcRunView(state: ArcRunState): ArcRunView {
  return {
    stage: "actioning",
    arcRunId: state.arcRunId,
    arcRef: state.arcRef,
    ownerPrincipal: state.ownerPrincipal,
    lifecycle: state.lifecycle,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    workspacePath: state.workspacePath,
    artifactCount: state.artifactPaths.length,
  };
}

/**
 * Union the artifact paths already seen by a run with every artifact
 * reference surfaced by one action brief.
 *
 * Returns the existing array unchanged when the brief adds nothing new, so
 * unchanged state spreads stay cheap across settle steps.
 */
function unionArtifactPaths(
  existing: readonly string[],
  brief: ActionBrief,
): readonly string[] {
  const seen = new Set(existing);
  for (const item of brief.instructions) {
    collectArtifactPathsFromSemanticText(item.text, seen);
  }
  for (const item of brief.judgments) {
    collectArtifactPathsFromSemanticText(item.question, seen);
  }
  for (const item of brief.observations) {
    if ("fields" in item) {
      for (const field of item.fields) {
        collectArtifactPathsFromSemanticText(field.question, seen);
      }
    } else {
      collectArtifactPathsFromSemanticText(item.question, seen);
    }
  }
  for (const item of brief.hostCalls) {
    for (const argument of item.arguments) {
      collectArtifactPathsFromPayload(argument, seen);
    }
  }
  return seen.size === existing.length ? existing : [...seen];
}

function collectArtifactPathsFromSemanticText(
  text: SemanticText,
  out: Set<string>,
): void {
  if (typeof text === "string") return;
  for (const part of text) {
    if (part.kind === "artifact") out.add(part.path);
  }
}

function collectArtifactPathsFromPayload(
  value: unknown,
  out: Set<string>,
): void {
  if (value === null || typeof value !== "object") return;
  if (isArtifactValue(value)) {
    out.add(value.path);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArtifactPathsFromPayload(item, out);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "artifact" && typeof record.path === "string") {
    out.add(record.path);
    return;
  }
  for (const item of Object.values(record)) {
    collectArtifactPathsFromPayload(item, out);
  }
}

function collectWorkerRolesFromNode(node: ArcNode, out: Set<string>): void {
  const declared = workerRoleFromParams(node.hostParams);
  if (declared) out.add(declared);
  for (const child of node.children) collectWorkerRolesFromNode(child, out);
}

type HostActionShape = {
  kind: "host-call";
  module: string;
  target: string[];
  operation: string;
};

/** Require a dispatcher handler for every host operation a document uses. */
function assertHostDispatcherContracts(
  documents: ReadonlyMap<string, Document>,
  modules: ReadonlyMap<string, HostModule>,
): void {
  for (const [source, document] of documents) {
    const visited = new Set<object>();
    visitDocumentObjects(document, visited, (value) => {
      if (!isHostActionShape(value)) return;
      const implementation = modules.get(value.module);
      if (implementation?.submit) return;
      const path = [value.module, ...value.target, value.operation].join(".");
      throw new Error(
        `Arc source "${source}" host call ${path} requires a registered submit handler.`,
      );
    });
  }
}

function visitDocumentObjects(
  value: unknown,
  visited: Set<object>,
  visit: (value: object) => void,
): void {
  if (!value || typeof value !== "object" || visited.has(value)) return;
  visited.add(value);
  visit(value);
  if (isHostActionShape(value)) return;
  if (Array.isArray(value)) {
    for (const entry of value) visitDocumentObjects(entry, visited, visit);
    return;
  }
  for (const entry of Object.values(value)) {
    visitDocumentObjects(entry, visited, visit);
  }
}

function isHostActionShape(value: object): value is HostActionShape {
  const record = value as Record<string, unknown>;
  return (
    record.kind === "host-call" &&
    typeof record.module === "string" &&
    Array.isArray(record.target) &&
    record.target.every((segment) => typeof segment === "string") &&
    typeof record.operation === "string"
  );
}

/** Validate node host params and reject instruction-level ownership overrides. */
function assertWorkerRoleContracts(source: string, document: Document): void {
  for (const root of document.roots) {
    assertWorkerRoleContractsInNode(source, root);
  }
}

function assertWorkerRoleContractsInNode(source: string, node: ArcNode): void {
  assertValidNodeWorkerRole(source, node);
  for (const statement of node.statements) {
    assertNodeLevelWorkerRoleInStatement(source, node, statement);
  }
  for (const child of node.children) {
    assertWorkerRoleContractsInNode(source, child);
  }
}

function assertValidNodeWorkerRole(source: string, node: ArcNode): void {
  if (!isPayloadObject(node.hostParams)) return;
  const role = node.hostParams.workerRole;
  if (role !== undefined && (typeof role !== "string" || role.trim() === "")) {
    throw new Error(
      `Arc source "${source}" node "${node.identifier}" declares malformed hostParams.workerRole: expected a non-empty string.`,
    );
  }
  const tools = node.hostParams.tools;
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))
  ) {
    throw new Error(
      `Arc source "${source}" node "${node.identifier}" declares malformed hostParams.tools: expected an array of strings.`,
    );
  }
  const contextIsolation = node.hostParams.contextIsolation;
  if (
    contextIsolation !== undefined &&
    contextIsolation !== "role" &&
    contextIsolation !== "node"
  ) {
    throw new Error(
      `Arc source "${source}" node "${node.identifier}" declares malformed hostParams.contextIsolation: expected "role" or "node".`,
    );
  }
}

function assertNodeLevelWorkerRoleInStatement(
  source: string,
  node: ArcNode,
  statement: ArcStatement,
): void {
  if (statement.kind === "if") {
    statement.consequent.forEach((entry) =>
      assertNodeLevelWorkerRoleInStatement(source, node, entry),
    );
    statement.alternate?.forEach((entry) =>
      assertNodeLevelWorkerRoleInStatement(source, node, entry),
    );
    return;
  }
  if (
    statement.kind === "label" ||
    statement.kind === "invoke" ||
    statement.kind === "map"
  ) {
    statement.body.forEach((entry) =>
      assertNodeLevelWorkerRoleInStatement(source, node, entry),
    );
    return;
  }
  if (
    statement.kind === "instruction" &&
    hasWorkerRoleParam(statement.hostParams)
  ) {
    throw new Error(
      `Arc source "${source}" node "${node.identifier}" declares a workerRole inside instruction hostParams. Declare the worker role on the node's hostParams instead; work for another role belongs in a child node.`,
    );
  }
  if (
    statement.kind === "instruction" &&
    hasContextIsolationParam(statement.hostParams)
  ) {
    throw new Error(
      `Arc source "${source}" node "${node.identifier}" declares contextIsolation inside instruction hostParams. Declare contextIsolation on the node's hostParams instead.`,
    );
  }
}

function hasWorkerRoleParam(params: ArcPayloadValue): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  return "workerRole" in params;
}

function hasContextIsolationParam(params: ArcPayloadValue): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  return "contextIsolation" in params;
}

function workerRoleFromParams(params: ArcPayloadValue): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const role = (params as Record<string, unknown>).workerRole;
  return typeof role === "string" && role.length > 0 ? role : undefined;
}

function readNodeContextIsolation(
  params: ArcPayloadValue,
): ContextIsolation | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>).contextIsolation;
  return value === "role" || value === "node" ? value : undefined;
}

function resolveContextIsolation(
  runIsolation: ContextIsolation,
  nodeIsolation: ContextIsolation | undefined,
): ContextIsolation {
  return runIsolation === "node" || nodeIsolation === "node" ? "node" : "role";
}
