import { structurallyEqual } from "../storage/base.js";
import {
  assertHostModuleState,
  assertModuleEffect,
  type HostModuleEffect,
  type HostModuleState,
} from "../types/host-module.js";
import {
  handoffCheckpoint,
  positionKey,
  type ActionReplayPosition,
  type RegeneratedReplay,
  type ReplayCheckpoint,
  type ReplayStep,
} from "../types/replay.js";
import { assertReplayEffect } from "./replay-state.js";

/** Copy a closed pre-report prefix ending at an explicit checkpoint. */
export function replayPrefixAt(
  steps: readonly ReplayStep[],
  checkpoints: readonly ReplayCheckpoint[],
  continuation: ReplayCheckpoint,
): RegeneratedReplay {
  const target = continuation.position;
  const retained = steps.filter(
    (step) =>
      step.position.reactivationCount < target.reactivationCount ||
      (step.position.reactivationCount === target.reactivationCount &&
        (step.position.stage === "trigger" ||
          (step.kind === "action-report"
            ? step.position.index < target.index
            : step.position.index <= target.index))),
  );
  return structuredClone({
    triggerSteps: retained.filter(
      (step) => step.kind === "trigger-brief" || step.kind === "trigger-report",
    ),
    actionSteps: retained.filter(
      (step) =>
        step.kind === "action-brief" ||
        step.kind === "terminal-brief" ||
        step.kind === "action-report",
    ),
    checkpoints: checkpoints
      .filter(
        (cp) =>
          cp.position.reactivationCount < target.reactivationCount ||
          (cp.position.reactivationCount === target.reactivationCount &&
            cp.position.index <= target.index),
      )
      .map((cp) =>
        positionKey(cp.position) === positionKey(target) ? continuation : cp,
      ),
  });
}

/** Require a real action position in the selected source prefix. */
export function requireReplayTarget(
  prefix: RegeneratedReplay,
  position: ActionReplayPosition,
): ReplayCheckpoint {
  if (
    position.stage !== "action" ||
    !Number.isInteger(position.index) ||
    position.index < 0 ||
    !Number.isInteger(position.reactivationCount) ||
    position.reactivationCount < 0
  )
    throw new Error("Invalid replay action position.");
  const checkpoint = prefix.checkpoints.find(
    (cp) => positionKey(cp.position) === positionKey(position),
  );
  if (!checkpoint)
    throw new Error(
      `No replay checkpoint at ${positionKey(position)} in the selected source prefix.`,
    );
  return checkpoint;
}

/** Validate output/report closure and the provenance of retained module outcomes. */
export function validateReplayPrefix(prefix: RegeneratedReplay): void {
  const final = handoffCheckpoint(prefix);
  if (
    !Number.isSafeInteger(final.position.reactivationCount) ||
    final.position.reactivationCount < 0 ||
    final.position.reactivationCount >= prefix.checkpoints.length
  )
    throw new Error("Invalid replay reactivation count.");
  const checkpointKeys = new Set(
    prefix.checkpoints.map((cp) => positionKey(cp.position)),
  );
  if (checkpointKeys.size !== prefix.checkpoints.length)
    throw new Error("Duplicate replay checkpoint.");
  const admitted = new Map<string, HostModuleEffect[]>();
  const checkState = (state: HostModuleState, complete = false): void => {
    assertHostModuleState(state);
    // Provisional trigger snapshots omit retained resources from earlier action episodes.
    if (complete) {
      const occurrences = new Set(
        state.calls.map((record) => record.call.hostCallId),
      );
      for (const hostCallId of admitted.keys())
        if (!occurrences.has(hostCallId))
          throw new Error(
            "Replay checkpoint omits an admitted host occurrence.",
          );
    }
    for (const record of state.calls)
      if (
        !structurallyEqual(
          record.effects,
          admitted.get(record.call.hostCallId) ?? [],
        )
      )
        throw new Error(
          "Replay checkpoint contains outcomes outside its preceding inputs.",
        );
  };
  const admit = (effect: HostModuleEffect | undefined): void => {
    if (!effect) return;
    assertModuleEffect(effect);
    const effects = admitted.get(effect.hostCallId) ?? [];
    effects.push(effect);
    admitted.set(effect.hostCallId, effects);
  };
  let checkpointCount = 0;
  let actionCount = 0;
  let triggerCount = 0;
  for (let count = 0; count <= final.position.reactivationCount; count++) {
    const triggers = prefix.triggerSteps.filter(
      (step) => step.position.reactivationCount === count,
    );
    const briefs = triggers.filter((step) => step.kind === "trigger-brief");
    if (!briefs.length) throw new Error("Missing replay trigger episode.");
    for (let index = 1; index <= briefs.length; index++) {
      const brief = briefs[index - 1]!;
      if (brief.position.index !== index || brief.position.stage !== "trigger")
        throw new Error("Invalid trigger output sequence.");
      checkState(brief.hostModules);
      const reports = triggers.filter(
        (step) =>
          step.kind === "trigger-report" && step.position.index === index,
      );
      if (reports.length !== (index < briefs.length ? 1 : 0))
        throw new Error("Unclosed replay trigger report.");
      for (const report of reports)
        if (report.kind === "trigger-report") {
          assertReplayEffect(
            report.moduleEffect,
            report.report,
            brief.hostModules,
          );
          admit(report.moduleEffect);
        }
    }
    if (triggers.length !== briefs.length * 2 - 1)
      throw new Error("Unexpected replay trigger position.");
    triggerCount += triggers.length;
    const checkpoints = prefix.checkpoints.filter(
      (cp) => cp.position.reactivationCount === count,
    );
    const actions = prefix.actionSteps.filter(
      (step) => step.position.reactivationCount === count,
    );
    const outputs = actions.filter((step) => step.kind !== "action-report");
    const reports = actions.filter((step) => step.kind === "action-report");
    if (checkpoints.length !== outputs.length + 1)
      throw new Error("Missing replay output or checkpoint.");
    for (let index = 0; index < checkpoints.length; index++) {
      const cp = checkpoints[index]!;
      if (cp.position.index !== index || cp.position.stage !== "action")
        throw new Error("Invalid replay checkpoint sequence.");
      checkState(cp.hostModules, true);
      if (!index) continue;
      const output = outputs[index - 1]!;
      if (output.position.index !== index || output.position.stage !== "action")
        throw new Error("Invalid action output sequence.");
      if ((output.kind === "action-brief") !== output.brief.canProgress)
        throw new Error("Replay output kind differs from its brief.");
      const atPosition = reports.filter(
        (report) => report.position.index === index,
      );
      const hasNext = index < checkpoints.length - 1;
      const interrupted =
        output.kind === "terminal-brief" &&
        output.brief.outcome === "interrupted";
      const expected = hasNext && output.kind === "action-brief" ? 1 : 0;
      if (
        atPosition.length !== expected ||
        (hasNext && output.kind === "terminal-brief" && !interrupted)
      )
        throw new Error("Unclosed replay action report.");
      for (const report of atPosition) {
        if (report.position.stage !== "action")
          throw new Error("Invalid action report position.");
        assertReplayEffect(report.moduleEffect, report.report, cp.hostModules);
        admit(report.moduleEffect);
      }
    }
    if (
      reports.some(
        (report) =>
          report.position.index < 1 ||
          report.position.index >= checkpoints.length - 1,
      )
    )
      throw new Error("Replay report lies beyond the selected output.");
    checkpointCount += checkpoints.length;
    actionCount += actions.length;
  }
  if (
    checkpointCount !== prefix.checkpoints.length ||
    actionCount !== prefix.actionSteps.length ||
    triggerCount !== prefix.triggerSteps.length
  )
    throw new Error("Replay history contains an invalid reactivation count.");
}
