import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversalSet,
  BriefId,
  Dialog,
  NodeRef,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "@elem-app/arc/runtime";
import type { HostModuleEffect, HostModuleState } from "./host-module.js";

import type { ArcDocumentSnapshotId, ArcRunId } from "./core.js";

/**
 * Replay records two ordered streams under one Arc run: a trigger stream (work
 * done before activation) and an action stream (work done after activation).
 * Positions are stage-tagged so a failure in either stage is locatable.
 *
 * A trigger position numbers from 1. An action position numbers from 0, where
 * index 0 is the activation seed checkpoint (the traversals handed to the first
 * action `start`) and the first emitted action output is index 1.
 */
export type TriggerReplayPosition = {
  stage: "trigger";
  index: number;
  /** Reactivation count assigned to this replay position. */
  reactivationCount: number;
};
export type ActionReplayPosition = {
  stage: "action";
  index: number;
  /** Reactivation count assigned to this replay position. */
  reactivationCount: number;
};
export type ReplayPosition = TriggerReplayPosition | ActionReplayPosition;

/** Stable string key for a replay position, used by stores keyed on position. */
export function positionKey(position: ReplayPosition): string {
  return `${position.reactivationCount}:${position.stage}:${position.index}`;
}

/** A trigger brief with its `traversals` stripped (recorded in checkpoint 0). */
export type BareTriggerBrief = Omit<TriggerBrief, "traversals">;

/** An action brief with its `traversals` stripped (stored in its checkpoint). */
export type BareActionBrief = Omit<ActionBrief, "traversals">;

/** A terminal brief with its `traversals` stripped (stored in its checkpoint). */
export type BareTerminalBrief = BareBrief<TerminalBrief>;

type BareBrief<TBrief> = TBrief extends unknown
  ? Omit<TBrief, "traversals">
  : never;

/** Project a brief to its bare recorded form, dropping `traversals`. */
export function stripBrief<
  TBrief extends TriggerBrief | ActionBrief | TerminalBrief,
>(brief: TBrief): BareBrief<TBrief> {
  const { traversals: _traversals, ...rest } = brief;
  return rest as BareBrief<TBrief>;
}

/**
 * Recorded trigger brief step. Stores the bare payload; the trigger stage's
 * terminal traversals are recorded once as action checkpoint 0.
 */
export type TriggerBriefStep = {
  hostModules: HostModuleState;
  kind: "trigger-brief";
  position: TriggerReplayPosition;
  dialog: Dialog;
  brief: BareTriggerBrief;
};

/** Recorded trigger report step. `origin` is Arcade metadata; replay ignores it. */
export type TriggerReportStep = {
  kind: "trigger-report";
  position: TriggerReplayPosition;
  dialog: Dialog;
  report: TriggerReport;
  origin: "worker" | "host-module" | "host-preferred-match";
  moduleEffect?: HostModuleEffect;
};

/** Recorded action brief step. Stores the bare payload (traversals stripped). */
export type ActionBriefStep = {
  kind: "action-brief";
  position: ActionReplayPosition;
  dialog: Dialog;
  brief: BareActionBrief;
};

/** Recorded terminal brief step. Stores the bare payload; traversals live in its checkpoint. */
export type TerminalBriefStep = {
  kind: "terminal-brief";
  position: ActionReplayPosition;
  dialog: Dialog;
  brief: BareTerminalBrief;
};

/** Recorded action report step. Shares its index with the brief it progresses. */
export type ActionReportStep = {
  kind: "action-report";
  position: ActionReplayPosition;
  dialog: Dialog;
  report: ActionReport;
  origin:
    | "worker"
    | "host-proceed"
    | "host-interruption"
    | "host-deflection"
    | "host-poison"
    | "host-transition"
    | "host-module";
  moduleEffect?: HostModuleEffect;
};

export type TriggerReplayStep = TriggerBriefStep | TriggerReportStep;
export type ActionReplayStep =
  | ActionBriefStep
  | ActionReportStep
  | TerminalBriefStep;
export type ReplayStep = TriggerReplayStep | ActionReplayStep;

/**
 * Installable runtime state at one action position. The sole owner of recorded
 * traversals: brief steps store only the bare payload. Index 0 is the
 * activation seed; index N holds the traversals of action output N.
 */
export type ReplayCheckpoint = {
  /** Host module recording at this exact traversal boundary. */
  hostModules: HostModuleState;
  position: ActionReplayPosition;
  traversals: ArcTraversalSet;
};

/**
 * A typed whole-ref bijection used by the verifier.
 *
 * `set(key, value)` throws on contradiction: when `key` is already mapped to a
 * different value, or `value` is already claimed by a different key.
 */
export type BiMap<K, V> = {
  get(key: K): V | undefined;
  getReverse(value: V): K | undefined;
  has(key: K): boolean;
  set(key: K, value: V): void;
};

/**
 * Typed whole-ref bijections, built from matched brief items during the walk.
 * Whole-ref mapping preserves path position, so two nodes sharing an identifier
 * in different branches cannot be wrongly coupled.
 */
export type ReplayIso = {
  arcs: BiMap<ArcRef, ArcRef>;
  nodes: BiMap<NodeRef, NodeRef>;
  briefIds: BiMap<BriefId, BriefId>;
};

/** Candidate history through the handoff checkpoint persisted by a successor. */
export type RegeneratedReplay = {
  /** Regenerated trigger stream that selected the candidate. */
  triggerSteps: TriggerReplayStep[];
  /** Action history ending at the selected pre-report boundary. */
  actionSteps: ActionReplayStep[];
  /** Regenerated checkpoints for every accepted episode through the continuation. */
  checkpoints: ReplayCheckpoint[];
};

/**
 * The checkpoint where a compatible replay hands off to live execution: a fork
 * installs here and resumes. Its position, traversals, and host module state
 * describe the candidate continuation reached by the replayed prefix.
 */
export function handoffCheckpoint(
  regenerated: RegeneratedReplay,
): ReplayCheckpoint {
  const checkpoint = regenerated.checkpoints.at(-1);
  if (!checkpoint) {
    throw new Error("Compatible replay has no regenerated checkpoints.");
  }
  return checkpoint;
}

/**
 * The verdict on a candidate that reproduced the run's first checkpoint (the
 * activation seed traversal set). Once that checkpoint matches, candidate
 * divergence hands off with one of these verdicts. Invalid recordings and
 * unexpected runtime failures remain errors.
 *
 * - `reproduced`: the candidate reproduces the recorded run in full, to the end
 *   of the recording or to a requested `untilPosition`.
 * - `diverged`: the candidate parts from the run at the handoff position, where
 *   a brief, report, or checkpoint differs. Live execution takes over from there.
 */
export type ReplayHandoffReason = "reproduced" | "diverged";

/**
 * The candidate never reaches the recorded run's first checkpoint: its trigger
 * stream is incompatible, or its activation checkpoint differs from the
 * recording (a candidate that shares the trigger but activates a different run).
 * `reason` describes the failure and `position` locates it.
 */
export type FailedReplay = {
  status: "incompatible";
  position: ReplayPosition;
  reason: string;
};

/**
 * A successful jump: a new run (`arcRunId`) installed at the handoff point.
 * `arcRef`/`deps`/`snapshotId` are the candidate binding it installed, `handoff`
 * is the verdict, `iso` is the source→candidate rename, and `regenerated` is the
 * replay prefix the new run carries forward.
 */
export type JumpedReplay = {
  status: "compatible";
  arcRunId: ArcRunId;
  iso: ReplayIso;
  arcRef: ArcRef;
  deps: readonly ArcRef[];
  snapshotId: ArcDocumentSnapshotId;
  handoff: ReplayHandoffReason;
  regenerated: RegeneratedReplay;
};

/**
 * A compatible alignment that has not been jumped: the verify result, holding
 * the candidate binding, handoff verdict, and regenerated prefix a jump installs.
 */
export type CompatibleReplay = Omit<JumpedReplay, "arcRunId">;
