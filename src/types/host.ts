import type {
  ActionMove,
  ArcRef,
  ArcTraversalSet,
  BriefId,
  Dialog,
  InstructionBrief,
  JudgmentBrief,
  NodeRef,
  ObservationBrief,
  ObservationGroupBrief,
  RuntimeIssue,
} from "@elem-app/arc/runtime";
import type { Document, HostModuleSpec } from "@elem-app/arc/types";

import type {
  ArcDocumentSnapshotId,
  ArcRunId,
  ArcRunLifecycle,
} from "./core.js";
import type { ActivationRequirement } from "./handshake.js";
import type { HostModuleEffect, HostModuleState } from "./host-module.js";
import type { ArcManifest } from "./manifest.js";
import type { InboundMessage } from "./messaging.js";
import type { RoutineReport } from "./routine.js";
import type { ContextIsolation, InstructionIssue, Task } from "./task.js";

/** Immutable parsed Arc document record id. */
export type ArcDocumentRecordId = string;

/** Immutable parsed Arc document record stored by Arc host. */
export type ArcDocumentRecord = {
  /** Stable record id. */
  id: ArcDocumentRecordId;
  /** Runtime source name used by Arc refs and imports. */
  source: string;
  /** Parsed Arc document for this source version. */
  document: Document;
  /** Normalized manifest captured with this document version. */
  manifest: ArcManifest;
  /** ISO creation timestamp. */
  createdAt: string;
};

/** Lightweight snapshot of Arc document records used by one activated run. */
export type ArcDocumentSnapshot = {
  /** Stable snapshot id. */
  id: ArcDocumentSnapshotId;
  /** Immutable document records included in this snapshot. */
  documents: readonly ArcDocumentRecordId[];
  /** Arc-visible declarations for the host modules imported by those records. */
  hostModuleSpecs: Readonly<Record<string, HostModuleSpec>>;
  /** ISO creation timestamp. */
  createdAt: string;
};

/** Durable Arc run state owned by `ArcHostService`. */
export type ArcRunState = {
  /** Canonical submissions and admitted outcomes retained with traversal state. */
  hostModules: HostModuleState;
  /** Arc run this traversal state belongs to. */
  arcRunId: ArcRunId;
  /**
   * Opaque connector-supplied principal that activated this run. Used by
   * connectors to filter run-choice candidates; the host never interprets it.
   */
  ownerPrincipal: string;
  /** Root Arc currently active for the run. */
  arcRef: ArcRef;
  /** Arc definitions that must stay compatible with this run's traversals. */
  deps: readonly ArcRef[];
  /** Document snapshot containing compatible definitions for `deps`. */
  snapshotId: ArcDocumentSnapshotId;
  /** Opaque runtime traversal state to persist after each host yield. */
  traversals: ArcTraversalSet;
  /** Number of deflected-run reactivations committed into this run state. */
  reactivationCount: number;
  /** Durable lifecycle used for implicit run selection. */
  lifecycle: ArcRunLifecycle;
  /** ISO timestamp for when this run was created. */
  createdAt: string;
  /** ISO timestamp for the last persisted update. */
  updatedAt: string;
  /** Absolute workspace path resolved for this run. */
  workspacePath: string;
  /** Captured run-wide managed-agent context isolation floor. */
  contextIsolation: ContextIsolation;
  /**
   * Unique logical artifact paths the run's action briefs have emitted so far.
   *
   * Grows as traversal surfaces new artifact references in semantic text.
   */
  artifactPaths: readonly string[];
};

/** Current live preparation or persisted execution, projected by getRunView/listRunViews. */
export type ArcRunView = { arcRunId: ArcRunId; ownerPrincipal: string } & (
  | { stage: "triggering"; arcRef?: ArcRef; workspacePath?: string }
  | { stage: "handshaking"; arcRef: ArcRef; handshakeId: string }
  | { stage: "preparing"; arcRef: ArcRef; workspacePath?: string }
  | {
      stage: "actioning";
      arcRef: ArcRef;
      workspacePath: string;
      lifecycle: ArcRunLifecycle;
      reactivationCount: number;
      createdAt: string;
      updatedAt: string;
      artifactCount: number;
    }
);

/** Structured outcome from Arc host begin/advance methods. */
export type RunFrontier = {
  /** Opaque host execution identity; action feedback must name its originating frontier. */
  frontierId: string;
  /** Coarse lifecycle state for the run at this frontier. */
  status: "idle" | "ready" | "blocked" | "completed" | "poisoned";
  /** Arc run this frontier describes. */
  arcRunId: ArcRunId;
  /** Root Arc selected or re-entered for the run, when one exists. */
  arcRef?: ArcRef;
  /** Arc definitions that must stay compatible with this frontier's traversals. */
  deps: readonly ArcRef[];
  /** Document snapshot containing compatible definitions for `deps`. */
  snapshotId?: ArcDocumentSnapshotId;
  /** Durable traversal snapshot after the latest host yield. */
  traversals: ArcTraversalSet;
  /** Active Arc node that produced the current frontier, when available. */
  active?: NodeRef;
  /** Whether the runtime can make progress after an accepted report. */
  canProgress: boolean;
  /** Runtime moves currently accepted for the frontier. */
  allowedMoves: readonly ActionMove[];
  /** Runtime issues surfaced while settling to this frontier. */
  issues: readonly RuntimeIssue[];
  /** Instruction metadata issues found while deriving agent instructions. */
  instructionIssues: readonly InstructionIssue[];
  /** Raw runtime frontier briefs for advanced caller-side reporting. */
  briefs: {
    /** Pending judgment requests from Arc runtime. */
    judgments: readonly JudgmentBrief[];
    /** Pending observation requests from Arc runtime, single and grouped. */
    observations: readonly (ObservationBrief | ObservationGroupBrief)[];
    /** Pending instruction briefs before worker-role routing. */
    instructions: readonly InstructionBrief[];
  };
  /** All parsed tasks returned for this frontier. */
  tasks: readonly Task[];
  /** Uncaught interruption the frontier rests on, when one ended the lap. */
  interruption?: { id: string; reason: string };
  /** Position changes acknowledged while settling to this frontier. */
  transitions: readonly RunTransition[];
};

/**
 * Which matchable arcs an inbound activates when the trigger matches several.
 *
 * - `first`: activate one (the first match) — the pre-fan-out default, so
 *   existing single-activation callers are unchanged.
 * - `all`: activate every matchable arc concurrently (autopivot).
 * - `choose`: when >1 arc matches, stage a host-level arc-choice handshake so
 *   the client selects the subset to activate.
 */
export type ActivationPolicy = "first" | "all" | "choose";

/**
 * Hub-supplied dialog view for a worker role during one host operation.
 * Activation projects the held inbound; established action work projects run
 * history. The host requests a new view when traversal changes worker role.
 */
export type DialogProjector = (view: { roleId: string }) => Promise<Dialog>;

/** Input passed by agent management when beginning one inbound lifecycle. */
export type BeginInput =
  | {
      /** Known Arc run whose persisted traversal should begin actioning. */
      arcRunId: ArcRunId;
      /** Projects the run's dialog for a worker role at call time. */
      projectDialog: DialogProjector;
    }
  | {
      /** Absent when Arcade should match the inbound against registered arcs. */
      arcRunId?: undefined;
      /** Trigger-stage view: the activating inbound's projection. */
      dialog: Dialog;
      /** Inbound message that triggered activation. */
      inbound: InboundMessage;
      /** Projects the held inbound's dialog for a worker role. */
      projectDialog: DialogProjector;
      /** Opaque connector-supplied principal for this activation request. */
      principal: string;
      /** Connector-tagged client id recorded as the handshake resolver. */
      clientId?: string;
      /** How many matchable arcs to activate; defaults to `first`. */
      activationPolicy?: ActivationPolicy;
    };

/**
 * Input accepted by `advanceTrigger`/`advanceAction` when advancing a run.
 * Supply empty reports and coverage when there are no entries to report.
 */
export type AdvanceInput = {
  /** Projects the run's dialog for a worker role during this operation. */
  projectDialog: DialogProjector;
  intent?: string;
} & (
  | {
      reports: readonly RoutineReport[];
      instructionCoverage: InstructionCoverage;
    }
  | HostModuleEffect
);

/**
 * One acknowledged position change of a run's walk, surfaced on the frontier
 * so the hub can persist node entered/exited work events. `role` is the worker
 * role the host projected the new view for.
 */
export type RunTransition = {
  exited: readonly NodeRef[];
  entered: readonly NodeRef[];
  position: NodeRef;
  role: string;
};

/** Per-brief coverage for instructions returned in an action frontier. */
export type InstructionCoverage = Record<
  BriefId,
  "applied" | "deflected" | "failed" | "ignored"
>;

/**
 * One id-addressed unit of Arc work handed back to the caller. **Exactly one
 * identity per step** — plurality lives only in the arrays `begin`/
 * `advanceTrigger` return, never inside a step.
 *
 * - `trigger`: the trigger frontier for a run's trigger stage (`arcRunId` is
 *   volatile until activation fan-out). Run its semantic work, then
 *   `advanceTrigger(arcRunId, …)`.
 * - `action`: an action frontier for a run; `frontier.status` may be terminal
 *   (`idle`/`completed`/`poisoned`). Submit worker feedback and module effects through `advanceAction`.
 *   Release the process-local session with `releaseAction` when the driver finishes.
 * - `handshake`: a gated match — the hub-facing projection of a staged
 *   handshake (its `PendingHandshake` stays arc host-internal). Relay to the
 *   client, then `resolveHandshake(handshakeId, …)`. Carries the preparation `arcRunId`.
 * - `rejected`: a matched arc's activation was refused. Carries no `arcRunId`.
 */
export type ArcHostStep =
  | { kind: "trigger"; arcRunId: ArcRunId; frontier: RunFrontier }
  | {
      kind: "action";
      arcRunId: ArcRunId;
      frontier: RunFrontier;
      reactivationCount: number;
    }
  | {
      kind: "handshake";
      arcRunId: ArcRunId;
      handshakeId: string;
      arcRef: ArcRef;
      requirement: ActivationRequirement;
    }
  | { kind: "rejected"; arcRef: ArcRef; reason: string };

/**
 * Result of resolving a previously staged activation handshake.
 *
 * `ok` produced a `rejected` step, a fresh activation's `action` step, or a
 * next-round `handshake` step (e.g. an arc-choice "activate" that now needs
 * run-choice/workspace). `joined` names a validated active run for immediate
 * join handling; the submission input is not delivered to that run.
 * `missing`/`invalid` are lookup acks.
 */
export type ResolveHandshakeResult =
  | { status: "missing" }
  | { status: "invalid"; reason: string }
  | { status: "ok"; step: ArcHostStep }
  | { status: "joined"; arcRunId: ArcRunId; reactivationCount: number };
