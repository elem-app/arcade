import type {
  ActionBrief,
  ActionReport,
  ArcTraversalSet,
  HostCallBrief,
  TerminalBrief,
  TriggerBrief,
  TriggerReport,
} from "@elem-app/arc/runtime";

import { structurallyEqual } from "../storage/base.js";
import {
  assertModuleEffect,
  hostCallTraversal,
  type HostModuleEffect,
  type HostModuleState,
} from "../types/host-module.js";
import type { ReplayCheckpoint } from "../types/replay.js";

/** Project admitted outcomes and pending addresses without changing the input. */
export function advanceHostModuleState(
  state: HostModuleState,
  output: ActionBrief | TerminalBrief | TriggerBrief,
  effect?: HostModuleEffect,
  reconstruct = false,
): { hostModules: HostModuleState; effectAdmitted: boolean } {
  const hostModules = structuredClone(state);
  let effectAdmitted = false;
  if (effect) {
    const record = hostModules.calls.find(
      (item) => item.call.hostCallId === effect.hostCallId,
    );
    if (!record)
      throw new Error("Recording an effect for an unknown host call.");
    effectAdmitted = !(
      effect.hostCallOutcome.kind === "resolution" &&
      output.issues.some(
        (issue) =>
          issue.kind === "invalid-item" &&
          issue.reasonCode === "host-call-result-type" &&
          issue.briefId === record.runtimeCallId,
      )
    );
    if (effectAdmitted) record.effects.push(structuredClone(effect));
  }
  reconcilePendingCalls(
    hostModules,
    "hostCalls" in output ? output.hostCalls : [],
    output.traversals,
    reconstruct,
  );
  return { hostModules, effectAdmitted };
}

function reconcilePendingCalls(
  state: HostModuleState,
  calls: readonly HostCallBrief[],
  traversals: ArcTraversalSet,
  reconstruct: boolean,
): void {
  const available = new Set(calls);
  for (const record of state.calls) {
    if (record.runtimeCallId === undefined) continue;
    const source = hostCallTraversal(traversals, record.call.sourceRef);
    if (
      record.context.arcRunId !== undefined &&
      source?.enterCount !== record.enterCount
    ) {
      record.runtimeCallId = undefined;
      continue;
    }
    const pending = [...available].find((call) =>
      reconstruct
        ? call.sourceRef === record.call.sourceRef &&
          call.module === record.call.module &&
          call.operation === record.call.operation &&
          structurallyEqual(call.target, record.call.target) &&
          structurallyEqual(call.arguments, record.call.arguments)
        : call.id === record.runtimeCallId,
    );
    if (pending) {
      record.runtimeCallId = pending.id;
      available.delete(pending);
      continue;
    }
    const resolved = record.effects.some(
      (effect) =>
        effect.hostCallOutcome.kind === "resolution" ||
        effect.hostCallOutcome.kind === "failure",
    );
    // Catch evaluation can hide a pending call while its source entry survives.
    if (
      resolved ||
      !source ||
      source.enterCount !== record.enterCount ||
      source.state !== undefined
    )
      record.runtimeCallId = undefined;
  }
}

/** Select the latest checkpoint equivalent to the authoritative execution state. */
export function matchingReplayCheckpoint(
  checkpoints: readonly ReplayCheckpoint[],
  traversals: ArcTraversalSet,
  hostModules: HostModuleState,
  reactivationCount: number,
): ReplayCheckpoint | undefined {
  let latest: ReplayCheckpoint | undefined;
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.position.reactivationCount === reactivationCount &&
      structurallyEqual(checkpoint.traversals, traversals) &&
      structurallyEqual(
        checkpoint.hostModules.calls.flatMap((record) => record.effects),
        hostModules.calls.flatMap((record) => record.effects),
      ) &&
      (!latest || checkpoint.position.index > latest.position.index)
    )
      latest = checkpoint;
  }
  return latest;
}

/** Correlate recorded module outcomes with the runtime input they produced. */
export function assertReplayEffect(
  effect: HostModuleEffect | undefined,
  report: ActionReport | TriggerReport,
  state: HostModuleState,
): void {
  if (!effect) return;
  assertModuleEffect(effect);
  const record = state.calls.find(
    (item) => item.call.hostCallId === effect.hostCallId,
  );
  if (!record)
    throw new Error("Replay input references an unknown host occurrence.");
  const outcome = effect.hostCallOutcome;
  const move = "move" in report ? report.move : undefined;
  if (outcome.kind === "resolution") {
    const value =
      record.runtimeCallId === undefined
        ? undefined
        : report.hostCalls?.[record.runtimeCallId];
    if (
      !value ||
      value.status !== "resolved" ||
      !structurallyEqual(value.value, outcome.value)
    )
      throw new Error(
        "Replay resolution differs from its recorded runtime report.",
      );
  } else if (outcome.kind === "interruption") {
    if (
      move !== "interrupt" ||
      !("interruption" in report) ||
      !structurallyEqual(report.interruption, outcome.interruption)
    )
      throw new Error(
        "Replay interruption differs from its recorded runtime report.",
      );
  } else if (move !== "poison")
    throw new Error("Replay failure has no recorded poison report.");
}
