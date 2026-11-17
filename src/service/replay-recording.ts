import type {
  ActionBrief,
  ArcRef,
  ArcTraversalSet,
  Dialog,
  TerminalBrief,
  TriggerBrief,
} from "@elem-app/arc/runtime";

import type { HostModuleState } from "../types/host-module.js";
import {
  stripBrief,
  type ActionBriefStep,
  type ActionReplayPosition,
  type ActionReportStep,
  type ReplayCheckpoint,
  type TerminalBriefStep,
  type TriggerBriefStep,
  type TriggerReplayPosition,
  type TriggerReportStep,
  type TriggerStartStep,
} from "../types/replay.js";

/** Build detached execution records without retaining runtime brief identities. */
export function recordTriggerStart(
  position: TriggerReplayPosition,
  dialog: Dialog,
  arcRefs?: readonly ArcRef[],
): TriggerStartStep {
  return structuredClone({
    kind: "trigger-start",
    position,
    dialog,
    ...(arcRefs && { arcRefs }),
  });
}

/** Detach a trigger brief and its host call state at the recorded position. */
export function recordTriggerOutput(
  position: TriggerReplayPosition,
  brief: TriggerBrief,
  dialog: Dialog,
  hostModules: HostModuleState,
): TriggerBriefStep {
  return structuredClone({
    kind: "trigger-brief",
    position,
    dialog,
    brief: stripBrief(brief),
    hostModules,
  });
}

/** Capture the activation traversals and host state at action checkpoint zero. */
export function recordActionSeed(
  position: ActionReplayPosition,
  traversals: ArcTraversalSet,
  hostModules: HostModuleState,
): ReplayCheckpoint {
  return structuredClone({ position, traversals, hostModules });
}

/** Store an action or terminal brief at its output position. Its traversals belong to the checkpoint. */
export function recordActionOutput(
  position: ActionReplayPosition,
  brief: ActionBrief | TerminalBrief,
  dialog: Dialog,
): ActionBriefStep | TerminalBriefStep {
  return brief.canProgress
    ? structuredClone({
        kind: "action-brief",
        position,
        dialog,
        brief: stripBrief(brief),
      })
    : structuredClone({
        kind: "terminal-brief",
        position,
        dialog,
        brief: stripBrief(brief),
      });
}

/** Detach a submitted report together with its Dialog, origin and any host effect. */
export function recordReport<T extends ActionReportStep | TriggerReportStep>(
  step: T,
): T {
  return structuredClone(step);
}
