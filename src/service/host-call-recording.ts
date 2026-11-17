import type { ArcTraversalSet, HostCallBrief } from "@elem-app/arc/runtime";

import {
  hostCallTraversal,
  type HostCallRecord,
  type HostModuleContext,
  type HostModuleState,
} from "../types/host-module.js";

/** Capture newly emitted invocations, retaining an unresolved record across briefs. */
export function captureCalls(
  stage: "trigger" | "action",
  state: HostModuleState,
  calls: readonly HostCallBrief[],
  traversals: ArcTraversalSet,
  context: HostModuleContext,
  allocate: () => string,
  acknowledged: boolean,
): HostCallRecord[] {
  const added: HostCallRecord[] = [];
  for (const { id, ...call } of calls) {
    const existing = [...state.calls]
      .reverse()
      .find((record) => record.runtimeCallId === id);
    if (
      existing &&
      !existing.effects.some(
        (effect) =>
          effect.hostCallOutcome.kind === "resolution" ||
          effect.hostCallOutcome.kind === "failure",
      )
    )
      continue;
    added.push({
      call: { ...structuredClone(call), hostCallId: allocate() },
      context: structuredClone(context),
      runtimeCallId: id,
      enterCount:
        stage === "action"
          ? hostCallTraversal(traversals, call.sourceRef)?.enterCount
          : undefined,
      acknowledged,
      effects: [],
    });
  }
  return added;
}
