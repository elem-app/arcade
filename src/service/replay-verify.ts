import type {
  ActionBrief,
  ActionReport,
  ArcRef,
  ArcTraversalSet,
  BriefId,
  Dialog,
  HostCallBrief,
  InstructionBrief,
  JudgmentBrief,
  NodeRef,
  ObservationBrief,
  ObservationGroupBrief,
  Runtime,
  RuntimeIssue,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "@elem-app/arc/runtime";
import {
  isArcRef,
  validateActionReport,
  validateTriggerReport,
} from "@elem-app/arc/runtime";

import { structurallyEqual } from "../storage/base.js";
import {
  assertHostModuleState,
  assertModuleEffect,
  type HostModuleState,
} from "../types/host-module.js";
import type {
  ActionReplayPosition,
  ActionReplayStep,
  BareActionBrief,
  BareTerminalBrief,
  BareTriggerBrief,
  BiMap,
  FailedReplay,
  ReplayCheckpoint,
  ReplayHandoffReason,
  ReplayIso,
  ReplayPosition,
  ReplayStep,
  TriggerReplayPosition,
  TriggerReplayStep,
} from "../types/replay.js";
import { stripBrief } from "../types/replay.js";

/** Result of replaying the recorded trigger stream against a candidate runtime. */
type TriggerReplayResult =
  | {
      status: "compatible";
      arcRef: ArcRef;
      deps: ArcRef[];
      activationTraversals: ArcTraversalSet;
      regenerated: TriggerReplayStep[];
    }
  | FailedReplay;

/**
 * Result of replaying the recorded action stream against a candidate runtime.
 * `handoff` records why it stopped; the fork point and installable state are the
 * last `regeneratedCheckpoints` entry (see `handoffCheckpoint`).
 */
type ActionReplayResult =
  | {
      status: "compatible";
      handoff: ReplayHandoffReason;
      regeneratedSteps: ActionReplayStep[];
      regeneratedCheckpoints: ReplayCheckpoint[];
    }
  | FailedReplay;

/** Internal signal that a recorded item could not be reconciled with a candidate. */
class ReplayMismatch extends Error {
  readonly position?: ReplayPosition;
  constructor(message: string, position?: ReplayPosition) {
    super(message);
    this.position = position;
  }
}

class BiMapImpl<K, V> implements BiMap<K, V> {
  readonly #forward = new Map<K, V>();
  readonly #reverse = new Map<V, K>();

  get(key: K): V | undefined {
    return this.#forward.get(key);
  }

  getReverse(value: V): K | undefined {
    return this.#reverse.get(value);
  }

  has(key: K): boolean {
    return this.#forward.has(key);
  }

  set(key: K, value: V): void {
    const existingValue = this.#forward.get(key);
    if (existingValue !== undefined) {
      if (existingValue !== value) {
        throw new ReplayMismatch(
          `Iso contradiction: ${String(key)} already maps to ${String(existingValue)}, not ${String(value)}.`,
        );
      }
      return;
    }
    const existingKey = this.#reverse.get(value);
    if (existingKey !== undefined && existingKey !== key) {
      throw new ReplayMismatch(
        `Iso contradiction: ${String(value)} already claimed by ${String(existingKey)}, not ${String(key)}.`,
      );
    }
    this.#forward.set(key, value);
    this.#reverse.set(value, key);
  }
}

/** Build a fresh typed-ref isomorphism with empty bijections. */
export function createReplayIso(): ReplayIso {
  return {
    arcs: new BiMapImpl<ArcRef, ArcRef>(),
    nodes: new BiMapImpl<NodeRef, NodeRef>(),
    briefIds: new BiMapImpl<BriefId, BriefId>(),
  };
}

/**
 * Replay the recorded trigger stream against a runtime holding the candidate.
 *
 * Produces the activation target (`arcRef`, `deps`) and the activation
 * traversals, and registers rename pairings into the shared iso. Requires the
 * replayed trigger to reach `matched === candidateArcRef`.
 */
export function alignTriggerReplay(args: {
  triggerRuntime: Runtime;
  steps: readonly ReplayStep[];
  candidateArcRef: ArcRef;
  iso: ReplayIso;
  reactivationCount: number;
  seedTraversals?: ArcTraversalSet;
  arcRefs?: readonly ArcRef[];
}): TriggerReplayResult {
  const { triggerRuntime, candidateArcRef, iso } = args;
  const reactivationCount = args.reactivationCount;
  const triggerSteps = args.steps.filter(
    (step) =>
      isTriggerStep(step) &&
      step.position.reactivationCount === reactivationCount,
  );
  const triggerPosition = (index: number): TriggerReplayPosition => ({
    stage: "trigger",
    index,
    reactivationCount,
  });
  const briefSteps = triggerSteps.filter(
    (step): step is Extract<TriggerReplayStep, { kind: "trigger-brief" }> =>
      step.kind === "trigger-brief",
  );
  const reportStepFor = (
    position: TriggerReplayPosition,
  ): Extract<TriggerReplayStep, { kind: "trigger-report" }> | undefined =>
    triggerSteps.find(
      (step): step is Extract<TriggerReplayStep, { kind: "trigger-report" }> =>
        step.kind === "trigger-report" &&
        step.position.index === position.index,
    );

  const firstBrief = briefSteps[0];
  if (!firstBrief) {
    return {
      status: "incompatible",
      position: triggerPosition(1),
      reason: "No recorded trigger brief to replay.",
    };
  }

  const regenerated: TriggerReplayStep[] = [];
  let lastPosition = triggerPosition(1);
  try {
    let dialog: Dialog = firstBrief.dialog;
    let generated = triggerRuntime.startTrigger(
      args.seedTraversals ?? [],
      dialog,
      { arcRefs: args.arcRefs },
    );
    let index = 1;

    for (const briefStep of briefSteps) {
      const position = triggerPosition(index);
      lastPosition = position;
      matchTriggerBrief(briefStep.brief, generated, iso);
      regenerated.push({
        kind: "trigger-brief",
        position,
        dialog: briefStep.dialog,
        brief: stripBrief(generated),
        hostModules: rewriteHostModuleState(briefStep.hostModules, iso),
      });

      const reportStep = reportStepFor(briefStep.position);
      if (!reportStep) break;

      if (reportStep.moduleEffect) assertModuleEffect(reportStep.moduleEffect);
      const rewritten = rewriteTriggerReport(reportStep.report, iso);
      assertTriggerApplicable(rewritten, generated, position);
      regenerated.push({
        kind: "trigger-report",
        position,
        dialog: reportStep.dialog,
        report: rewritten,
        origin: reportStep.origin,
        ...(reportStep.moduleEffect
          ? { moduleEffect: structuredClone(reportStep.moduleEffect) }
          : {}),
      });
      dialog = reportStep.dialog;
      generated = triggerRuntime.progressTrigger(generated, rewritten, dialog);
      index += 1;
    }

    // Drive the candidate to its selection. When the candidate coexists with the
    // source arc, the recorded auto-match does not recur, so a preferred-match
    // selection (the same mechanism a normal activation uses) is synthesized.
    if (generated.matched !== candidateArcRef) {
      const selectReport: TriggerReport = { preferredMatch: candidateArcRef };
      if (validateTriggerReport(generated, selectReport).rejected) {
        return {
          status: "incompatible",
          position: triggerPosition(index),
          reason: `Replayed trigger selected ${String(generated.matched)}, candidate ${candidateArcRef} is not matchable.`,
        };
      }
      regenerated.push({
        kind: "trigger-report",
        position: triggerPosition(index),
        dialog,
        report: selectReport,
        origin: "host-preferred-match",
      });
      generated = triggerRuntime.progressTrigger(
        generated,
        selectReport,
        dialog,
      );
      index += 1;
      regenerated.push({
        kind: "trigger-brief",
        position: triggerPosition(index),
        dialog,
        brief: stripBrief(generated),
        hostModules: rewriteHostModuleState(
          briefSteps.at(-1)!.hostModules,
          iso,
        ),
      });
    }

    if (generated.matched !== candidateArcRef) {
      return {
        status: "incompatible",
        position: triggerPosition(index),
        reason: `Replayed trigger did not select candidate ${candidateArcRef} (matched ${String(generated.matched)}).`,
      };
    }

    return {
      status: "compatible",
      arcRef: candidateArcRef,
      deps: [...generated.deps],
      activationTraversals: generated.traversals,
      regenerated,
    };
  } catch (error) {
    if (error instanceof ReplayMismatch) {
      return {
        status: "incompatible",
        position: error.position ?? lastPosition,
        reason: error.message,
      };
    }
    throw error;
  }
}

/**
 * Replay the recorded action stream against a candidate runtime, forward from
 * the activation seed.
 *
 * The first checkpoint gates compatibility: action checkpoint 0 must equal the
 * seed modulo iso. Once it matches, the candidate is committed to, and the walk
 * hands off at the last reproduced checkpoint as soon as the candidate matches
 * to the end or parts from the recording.
 */
export function alignActionReplay(args: {
  snapshotRuntime: Runtime;
  steps: readonly ReplayStep[];
  checkpoints: readonly ReplayCheckpoint[];
  seedTraversals: ArcTraversalSet;
  iso: ReplayIso;
  untilPosition?: ActionReplayPosition;
  reactivationCount: number;
}): ActionReplayResult {
  const { snapshotRuntime, seedTraversals, iso, untilPosition } = args;
  const reactivationCount = args.reactivationCount;
  const actionPosition = (index: number): ActionReplayPosition => ({
    stage: "action",
    index,
    reactivationCount,
  });
  // Index steps and checkpoints by position once; positions are unique per
  // (output/report, index) by the store's idempotency contract, so the loop
  // below gets each in O(1).
  const outputSteps = new Map<
    number,
    Extract<ActionReplayStep, { kind: "action-brief" | "terminal-brief" }>
  >();
  const reportSteps = new Map<
    number,
    Extract<ActionReplayStep, { kind: "action-report" }>
  >();
  for (const step of args.steps
    .filter(isActionStep)
    .filter((step) => step.position.reactivationCount === reactivationCount)) {
    if (step.kind === "action-report") {
      reportSteps.set(step.position.index, step);
    } else {
      outputSteps.set(step.position.index, step);
    }
  }
  const checkpointTraversals = new Map<number, ArcTraversalSet>(
    args.checkpoints
      .filter(
        (checkpoint) =>
          checkpoint.position.reactivationCount === reactivationCount,
      )
      .map((checkpoint) => [checkpoint.position.index, checkpoint.traversals]),
  );
  const outputStepAt = (n: number) => outputSteps.get(n);
  const reportStepAt = (n: number) => reportSteps.get(n);
  const checkpointAt = (n: number) => checkpointTraversals.get(n);
  const hostModulesAt = (n: number): HostModuleState => {
    const checkpoint = args.checkpoints.find(
      (c) =>
        c.position.reactivationCount === reactivationCount &&
        c.position.index === n,
    );
    return rewriteHostModuleState(checkpoint?.hostModules, iso);
  };

  const regeneratedSteps: ActionReplayStep[] = [];
  const regeneratedCheckpoints: ReplayCheckpoint[] = [
    {
      position: actionPosition(0),
      traversals: seedTraversals,
      hostModules: hostModulesAt(0),
    },
  ];
  const handoff = (reason: ReplayHandoffReason): ActionReplayResult => ({
    status: "compatible",
    handoff: reason,
    regeneratedSteps,
    regeneratedCheckpoints,
  });

  // Activation gate: the candidate's seed must equal recorded checkpoint 0, the
  // one action-stage incompatibility. This is a defensive guard — a matching
  // trigger replay produces a seed equal to checkpoint 0 modulo iso (a body
  // change instead surfaces as a brief-1 divergence, with checkpoint 0 intact),
  // so a trigger-matching candidate reaching a different seed could not be
  // constructed. It stays to catch a wrong seed reaching an installed run. See
  // the "trigger matches but the body differs" test.
  const checkpoint0 = checkpointAt(0);
  if (
    checkpoint0 === undefined ||
    !traversalsEqualModuloIso(checkpoint0, seedTraversals, iso)
  ) {
    return {
      status: "incompatible",
      position: actionPosition(0),
      reason:
        "Activation traversals differ from recorded action checkpoint 0 modulo iso.",
    };
  }

  // No recorded action work after activation: the run is reproduced at the seed.
  const firstOutput = outputStepAt(1);
  if (!firstOutput) return handoff("reproduced");

  try {
    let generated = snapshotRuntime.start(seedTraversals, firstOutput.dialog);
    let n = 1;
    for (;;) {
      const position = actionPosition(n);
      // The recording ran out at an output boundary — the candidate matched
      // everything recorded.
      const outputStep = outputStepAt(n);
      if (!outputStep) return handoff("reproduced");

      const { extra } = matchActionOutput(outputStep.brief, generated, iso);
      regeneratedSteps.push(
        generated.canProgress
          ? {
              kind: "action-brief",
              position,
              dialog: outputStep.dialog,
              brief: stripBrief(generated),
            }
          : {
              kind: "terminal-brief",
              position,
              dialog: outputStep.dialog,
              brief: stripBrief(generated),
            },
      );
      regeneratedCheckpoints.push({
        position,
        traversals: generated.traversals,
        hostModules: hostModulesAt(n),
      });

      // The candidate's brief asks for more than the recording answered — it
      // parts from the run here.
      if (extra) return handoff("diverged");

      const checkpoint = checkpointAt(n);
      if (
        checkpoint === undefined ||
        !traversalsEqualModuloIso(checkpoint, generated.traversals, iso)
      ) {
        return handoff("diverged");
      }

      if (untilPosition?.index === n) return handoff("reproduced");

      const reportStep = reportStepAt(n);
      if (!generated.canProgress) {
        if (reportStep) {
          throw new ReplayMismatch(
            "Recorded action report follows a terminal generated brief.",
            position,
          );
        }
        const continuation = outputStepAt(n + 1);
        if (generated.outcome === "interrupted" && continuation) {
          generated = snapshotRuntime.start(
            generated.traversals,
            continuation.dialog,
          );
          n += 1;
          continue;
        }
        return handoff("reproduced");
      }
      if (!reportStep) return handoff("reproduced");

      if (reportStep.moduleEffect) assertModuleEffect(reportStep.moduleEffect);
      const rewritten = rewriteActionReport(reportStep.report, iso);
      assertActionApplicable(rewritten, generated, position);
      regeneratedSteps.push({
        kind: "action-report",
        position,
        dialog: reportStep.dialog,
        report: rewritten,
        origin: reportStep.origin,
        ...(reportStep.moduleEffect
          ? { moduleEffect: structuredClone(reportStep.moduleEffect) }
          : {}),
        ...(reportStep.moduleEffect === undefined
          ? {}
          : { moduleEffect: reportStep.moduleEffect }),
      });
      generated = snapshotRuntime.progress(
        generated,
        rewritten,
        reportStep.dialog,
      );
      n += 1;
    }
  } catch (error) {
    // A recorded brief or report differs from the regenerated one: the
    // candidate diverged. Hand off the reproduced prefix to live execution.
    if (error instanceof ReplayMismatch) return handoff("diverged");
    throw error;
  }
}

// Matching ------------------------------------------------------------------

function matchTriggerBrief(
  recorded: BareTriggerBrief,
  generated: TriggerBrief,
  iso: ReplayIso,
): void {
  // Only the trigger frontier (the actual semantic work) is load-bearing for
  // matching. A coexisting candidate legitimately changes `matchableArcs`,
  // `matched`, `deps`, and the `ambiguous-match` issue, so those are not
  // compared here — the terminal selection check enforces the right arc. Each
  // recorded frontier item must still pair with a generated counterpart.
  pairFrontier(recorded.judgments, generated.judgments, iso, judgmentFields);
  pairFrontier(
    recorded.observations,
    generated.observations,
    iso,
    observationFields,
  );
  pairFrontier(recorded.hostCalls, generated.hostCalls, iso, hostCallFields);
}

function matchActionOutput(
  recorded: BareActionBrief | BareTerminalBrief,
  generated: ActionBrief | TerminalBrief,
  iso: ReplayIso,
): { extra: boolean } {
  if (!recorded.canProgress && generated.canProgress) {
    return { extra: true };
  }
  if (recorded.canProgress && !generated.canProgress) {
    throw new ReplayMismatch("canProgress differs from recorded.");
  }
  if (!recorded.canProgress && !generated.canProgress) {
    compareIssues(recorded.issues, generated.issues, iso);
    if (mapArcRef(recorded.root, iso) !== generated.root) {
      throw new ReplayMismatch(
        "terminal root differs from recorded modulo iso.",
      );
    }
    if (recorded.outcome !== generated.outcome) {
      throw new ReplayMismatch("terminal outcome differs from recorded.");
    }
    if (!structurallyEqual(recorded.returns, generated.returns)) {
      throw new ReplayMismatch("terminal returns differ from recorded.");
    }
    return { extra: false };
  }
  if (!recorded.canProgress || !generated.canProgress) {
    throw new ReplayMismatch("action brief kind differs from recorded.");
  }

  // Pass 1: pair ref-blind by per-kind payload and register iso pairings.
  pairFrontier(recorded.judgments, generated.judgments, iso, judgmentFields);
  pairFrontier(
    recorded.observations,
    generated.observations,
    iso,
    observationFields,
  );
  pairFrontier(recorded.hostCalls, generated.hostCalls, iso, hostCallFields);
  pairFrontier(
    recorded.instructions,
    generated.instructions,
    iso,
    instructionFields,
  );

  const extra =
    generated.judgments.length > recorded.judgments.length ||
    generated.observations.length > recorded.observations.length ||
    generated.hostCalls.length > recorded.hostCalls.length ||
    generated.instructions.length > recorded.instructions.length;
  if (extra) return { extra: true };

  // Pass 2: id-referencing fields, now that the iso is complete for this brief.
  comparePostchecks(recorded.instructions, generated.instructions, iso);
  compareIssues(recorded.issues, generated.issues, iso);
  compareTransitions(recorded.transition, generated.transition, iso);
  compareDeflections(recorded.deflection, generated.deflection, iso);
  if (!structurallyEqual(recorded.allowedMoves, generated.allowedMoves)) {
    throw new ReplayMismatch("allowedMoves differ from recorded.");
  }
  if (mapNodeRef(recorded.active, iso) !== generated.active) {
    throw new ReplayMismatch("active node differs from recorded modulo iso.");
  }
  return { extra: false };
}

/**
 * Compares a recorded transition payload against the regenerated one, modulo
 * the ref iso. The field-selective brief comparison would silently ignore it
 * otherwise, letting a diverging position change pass verification.
 */
function compareTransitions(
  recorded: BareActionBrief["transition"],
  generated: ActionBrief["transition"],
  iso: ReplayIso,
): void {
  if (!recorded && !generated) return;
  if (!recorded || !generated) {
    throw new ReplayMismatch("transition presence differs from recorded.");
  }
  if (mapNodeRef(recorded.position, iso) !== generated.position) {
    throw new ReplayMismatch(
      "transition position differs from recorded modulo iso.",
    );
  }
  const mapRefs = (refs: readonly NodeRef[]): NodeRef[] =>
    refs.map((ref) => mapNodeRef(ref, iso));
  if (
    !structurallyEqual(mapRefs(recorded.exited), generated.exited) ||
    !structurallyEqual(mapRefs(recorded.entered), generated.entered)
  ) {
    throw new ReplayMismatch(
      "transition entered/exited refs differ from recorded modulo iso.",
    );
  }
  if (!structurallyEqual(recorded.hostParams, generated.hostParams)) {
    throw new ReplayMismatch("transition host params differ from recorded.");
  }
}

function compareDeflections(
  recorded: BareActionBrief["deflection"],
  generated: ActionBrief["deflection"],
  iso: ReplayIso,
): void {
  if (!recorded && !generated) return;
  if (!recorded || !generated) {
    throw new ReplayMismatch("deflection presence differs from recorded.");
  }
  if (
    mapNodeRef(recorded.origin, iso) !== generated.origin ||
    (recorded.from === undefined
      ? undefined
      : mapNodeRef(recorded.from, iso)) !== generated.from
  ) {
    throw new ReplayMismatch(
      "deflection context differs from recorded modulo iso.",
    );
  }
}

type Frontier =
  | JudgmentBrief
  | ObservationBrief
  | ObservationGroupBrief
  | HostCallBrief
  | InstructionBrief;

function pairFrontier<T extends Frontier>(
  recorded: readonly T[],
  generated: readonly T[],
  iso: ReplayIso,
  fields: (item: T) => unknown,
): void {
  for (let i = 0; i < recorded.length; i += 1) {
    const recordedItem = recorded[i]!;
    const generatedItem = generated[i];
    if (!generatedItem) {
      throw new ReplayMismatch(
        "Recorded brief item has no generated counterpart.",
      );
    }
    if (!structurallyEqual(fields(recordedItem), fields(generatedItem))) {
      throw new ReplayMismatch("Brief item payload differs from recorded.");
    }
    iso.nodes.set(recordedItem.sourceRef, generatedItem.sourceRef);
    iso.briefIds.set(recordedItem.id, generatedItem.id);
  }
}

function judgmentFields(item: JudgmentBrief): unknown {
  return { question: item.question, hostParams: item.hostParams };
}

function observationFields(
  item: ObservationBrief | ObservationGroupBrief,
): unknown {
  if ("fields" in item) {
    return {
      mode: item.mode,
      hostParams: item.hostParams,
      fields: item.fields.map((field) => ({
        cell: field.cell,
        question: field.question,
        currentValue: field.currentValue,
        meta: field.meta,
      })),
    };
  }
  return {
    cell: item.cell,
    mode: item.mode,
    question: item.question,
    currentValue: item.currentValue,
    meta: item.meta,
    hostParams: item.hostParams,
  };
}

function hostCallFields(item: HostCallBrief): unknown {
  return {
    module: item.module,
    target: item.target,
    operation: item.operation,
    arguments: item.arguments,
    hostParams: item.hostParams,
  };
}

function instructionFields(item: InstructionBrief): unknown {
  return {
    mode: item.mode,
    phase: item.phase,
    text: item.text,
    hostParams: item.hostParams,
  };
}

function comparePostchecks(
  recorded: readonly InstructionBrief[],
  generated: readonly InstructionBrief[],
  iso: ReplayIso,
): void {
  for (let i = 0; i < recorded.length; i += 1) {
    const recordedPostcheck = recorded[i]!.postcheck;
    const generatedPostcheck = generated[i]?.postcheck;
    if (!recordedPostcheck && !generatedPostcheck) continue;
    if (!recordedPostcheck || !generatedPostcheck) {
      throw new ReplayMismatch("Instruction postcheck presence differs.");
    }
    const mapped = {
      judgmentIds: recordedPostcheck.judgmentIds.map((id) =>
        mapBriefId(id, iso),
      ),
      observationIds: recordedPostcheck.observationIds.map((id) =>
        mapBriefId(id, iso),
      ),
      hostCallIds: recordedPostcheck.hostCallIds.map((id) =>
        mapBriefId(id, iso),
      ),
    };
    if (!structurallyEqual(mapped, generatedPostcheck)) {
      throw new ReplayMismatch("Instruction postcheck differs modulo iso.");
    }
  }
}

function compareIssues(
  recorded: readonly RuntimeIssue[],
  generated: readonly RuntimeIssue[],
  iso: ReplayIso,
): void {
  const mapped = recorded.map((issue) => rewriteIssue(issue, iso));
  if (!structurallyEqual(mapped, generated)) {
    throw new ReplayMismatch("Runtime issues differ from recorded modulo iso.");
  }
}

function rewriteIssue(issue: RuntimeIssue, iso: ReplayIso): RuntimeIssue {
  if (issue.kind === "invalid-item") {
    return { ...issue, briefId: mapBriefId(issue.briefId, iso) };
  }
  return rewriteRefsDeep(issue, iso) as RuntimeIssue;
}

// Reports -------------------------------------------------------------------

function rewriteActionReport(
  report: ActionReport,
  iso: ReplayIso,
): ActionReport {
  if (report.move === "interrupt") return { ...report };
  return {
    ...report,
    ...(report.instructions
      ? { instructions: rewriteRecordKeys(report.instructions, iso) }
      : {}),
    ...(report.judgments
      ? { judgments: rewriteRecordKeys(report.judgments, iso) }
      : {}),
    ...(report.observations
      ? { observations: rewriteRecordKeys(report.observations, iso) }
      : {}),
    ...(report.hostCalls
      ? { hostCalls: rewriteRecordKeys(report.hostCalls, iso) }
      : {}),
  };
}

function rewriteTriggerReport(
  report: TriggerReport,
  iso: ReplayIso,
): TriggerReport {
  return {
    ...report,
    preferredMatch: report.preferredMatch
      ? mapArcRef(report.preferredMatch, iso)
      : undefined,
    judgments: rewriteRecordKeys(report.judgments, iso),
    observations: rewriteRecordKeys(report.observations, iso),
    hostCalls: rewriteRecordKeys(report.hostCalls, iso),
  };
}

function rewriteRecordKeys<V>(
  record: Record<BriefId, V> | undefined,
  iso: ReplayIso,
): Record<BriefId, V> | undefined {
  if (!record) return undefined;
  const out: Record<BriefId, V> = {};
  for (const [key, value] of Object.entries(record)) {
    out[mapBriefId(key, iso)] = value;
  }
  return out;
}

function assertActionApplicable(
  report: ActionReport,
  brief: ActionBrief,
  position: ActionReplayPosition,
): void {
  const validation = validateActionReport(brief, report);
  if (!validation.rejected) return;
  throw new ReplayMismatch(
    `Recorded action report is not applicable to the generated brief: ${validationReasons(validation.issues)}`,
    position,
  );
}

function assertTriggerApplicable(
  report: TriggerReport,
  brief: TriggerBrief,
  position: TriggerReplayPosition,
): void {
  const validation = validateTriggerReport(brief, report);
  if (!validation.rejected) return;
  throw new ReplayMismatch(
    `Recorded trigger report is not applicable to the generated brief: ${validationReasons(validation.issues)}`,
    position,
  );
}

function validationReasons(issues: readonly RuntimeIssue[]): string {
  const reasons = issues.map((issue) => issue.reason).filter(Boolean);
  return reasons.length > 0 ? reasons.join("; ") : "runtime rejected report";
}

// Traversal comparison ------------------------------------------------------

/**
 * Whether `recorded` traversals (old refs) equal `generated` traversals (new
 * refs) after rewriting every arc/node ref string in `recorded` through the iso
 * (identity fallback for refs the iso does not map).
 *
 * The rewrite reaches into arc's private traversal shape by reflection, so its
 * output is verified before comparison: `assertShapePreserved` throws if the
 * rewrite changed anything but leaf ref strings (a dropped field, a merged key,
 * a retyped value), turning a silent shape corruption into a loud failure
 * rather than a false compare.
 */
export function traversalsEqualModuloIso(
  recorded: ArcTraversalSet,
  generated: ArcTraversalSet,
  iso: ReplayIso,
): boolean {
  const rewritten = rewriteRefsDeep(recorded, iso);
  assertShapePreserved(recorded, rewritten, "traversals");
  return structurallyEqual(
    withoutUndefinedFields(rewritten),
    withoutUndefinedFields(generated),
  );
}

/** JSON storage omits undefined object fields; their absence is not divergence. */
function withoutUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefinedFields);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, withoutUndefinedFields(item)]),
    );
  return value;
}

/**
 * Verifies the ref rewrite changed only leaf strings, never structure: at every
 * position the rewritten tree must match the original in JS type, array length,
 * and object key count (entries paired by order, which `rewriteRefsDeep`
 * preserves). Exported as a verification primitive; the rewrite is the only
 * caller. A key collision that merged two entries, a dropped element, or a
 * retyped value throws here with a path instead of reaching the comparison.
 */
export function assertShapePreserved(
  original: unknown,
  rewritten: unknown,
  path: string,
): void {
  if (Array.isArray(original) || Array.isArray(rewritten)) {
    if (
      !Array.isArray(original) ||
      !Array.isArray(rewritten) ||
      original.length !== rewritten.length
    ) {
      throw new Error(`Replay ref rewrite changed array shape at ${path}`);
    }
    original.forEach((item, index) =>
      assertShapePreserved(item, rewritten[index], `${path}[${index}]`),
    );
    return;
  }
  const originalIsObject = original !== null && typeof original === "object";
  const rewrittenIsObject = rewritten !== null && typeof rewritten === "object";
  if (originalIsObject || rewrittenIsObject) {
    if (!originalIsObject || !rewrittenIsObject) {
      throw new Error(`Replay ref rewrite changed object shape at ${path}`);
    }
    const originalValues = Object.values(original as Record<string, unknown>);
    const rewrittenValues = Object.values(rewritten as Record<string, unknown>);
    if (originalValues.length !== rewrittenValues.length) {
      throw new Error(
        `Replay ref rewrite changed key count at ${path} ` +
          `(${originalValues.length} → ${rewrittenValues.length})`,
      );
    }
    originalValues.forEach((item, index) =>
      assertShapePreserved(item, rewrittenValues[index], `${path}.${index}`),
    );
    return;
  }
  if (typeof original !== typeof rewritten) {
    throw new Error(
      `Replay ref rewrite changed value type at ${path} ` +
        `(${typeof original} → ${typeof rewritten})`,
    );
  }
}

// Subtrees holding opaque payloads — user cell data, staged return values,
// host-call/judge pin results — rather than runtime refs. Their contents are
// identical across versions (authored text and replayed report values), so
// rewriting them would false-mismatch payload text that merely looks like a
// ref (e.g. a cell literally holding `node:...` or `[arc:...]`). The rewrite
// skips into them entirely.
const OPAQUE_PAYLOAD_KEYS = new Set(["cells", "stagedReturns", "value"]);

function rewriteRefsDeep(value: unknown, iso: ReplayIso): unknown {
  if (typeof value === "string") return mapRefString(value, iso);
  if (Array.isArray(value))
    return value.map((item) => rewriteRefsDeep(item, iso));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      // Keys carry refs too: a catch SEG key embeds the deflection's origin/from
      // node refs, and read-set node-state maps are keyed by node ref. Map the
      // key alongside the value, and leave opaque payload subtrees untouched.
      out[mapRefString(key, iso)] = OPAQUE_PAYLOAD_KEYS.has(key)
        ? item
        : rewriteRefsDeep(item, iso);
    }
    return out;
  }
  return value;
}

function mapRefString(value: string, iso: ReplayIso): string {
  if (isArcRef(value)) return iso.arcs.get(value) ?? value;
  if (value.startsWith("node:")) {
    return iso.nodes.get(value as NodeRef) ?? value;
  }
  // Bracketed arc/node refs embedded in a composite key or id: catch SEG keys
  // (`catch:[origin]:[from]`) and persisted brief ids (pin-tape judgment and
  // host-call entries). Remap each `[...]` occurrence through the iso — the
  // brackets delimit the ref exactly, so no partial match on a prefix-sharing
  // sibling ref.
  if (value.includes("[arc:") || value.includes("[node:")) {
    return value.replace(
      /\[((?:arc|node):[^\]]+)\]/g,
      (_match, ref: string) => `[${mapRefString(ref, iso)}]`,
    );
  }
  return value;
}

function mapArcRef(ref: ArcRef, iso: ReplayIso): ArcRef {
  return iso.arcs.get(ref) ?? ref;
}

function mapNodeRef(ref: NodeRef, iso: ReplayIso): NodeRef {
  return iso.nodes.get(ref) ?? ref;
}

function mapBriefId(id: BriefId, iso: ReplayIso): BriefId {
  return iso.briefIds.get(id) ?? id;
}

// Step filters --------------------------------------------------------------

function isTriggerStep(step: ReplayStep): step is TriggerReplayStep {
  return step.kind === "trigger-brief" || step.kind === "trigger-report";
}

function isActionStep(step: ReplayStep): step is ActionReplayStep {
  return (
    step.kind === "action-brief" ||
    step.kind === "action-report" ||
    step.kind === "terminal-brief"
  );
}

/** Rewrite host-owned addressing while preserving host module-owned payloads and occurrence ids. */
function rewriteHostModuleState(
  value: unknown,
  iso: ReplayIso,
): HostModuleState {
  assertHostModuleState(value);
  const state = structuredClone(value);
  for (const record of state.calls) {
    record.call.sourceRef = mapNodeRef(record.call.sourceRef, iso);
    if (record.runtimeCallId !== undefined)
      record.runtimeCallId = mapBriefId(record.runtimeCallId, iso);
    if (record.context.arcRef !== undefined)
      record.context.arcRef = mapArcRef(record.context.arcRef, iso);
  }
  return state;
}
