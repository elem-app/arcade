import {
  isArcRef,
  toArcRefParts,
  toNodeRef,
  type ArcRef,
  type ArcTraversalSet,
  type BriefId,
  type NodeRef,
  type PayloadValue,
} from "@elem-app/arc/runtime";
import type { ActionInterruption, HostModuleSpec, Traversal } from "@elem-app/arc/types";

import type { ArcRunId } from "./core.js";

/** Per-interaction context handed to a host-module implementer. */
export type HostModuleContext = {
  /** Run the interaction belongs to; absent during trigger evaluation. */
  arcRunId?: ArcRunId;
  /**
   * Arc the interaction belongs to, supplied by the host — authoritative and
   * available even before the run's state is persisted. Absent during trigger
   * evaluation across multiple matchable arcs.
   */
  arcRef?: ArcRef;
};

/** One host call outcome, correlated with its submitted occurrence. */
export type HostModuleEffect = {
  hostCallId: string;
  hostCallOutcome:
    | { kind: "resolution"; value?: PayloadValue }
    | { kind: "interruption"; interruption: ActionInterruption }
    | { kind: "failure"; reason: string };
};

/** Module-facing host call occurrence. */
export type HostCall = {
  hostCallId: string;
  sourceRef: NodeRef;
  module: string;
  target: string[];
  operation: string;
  arguments: PayloadValue[];
  hostParams: PayloadValue;
  moduleData?: PayloadValue;
};

/** Registered module implementation. Setup acknowledges before operation completion. */
export type HostModule = {
  declaration: HostModuleSpec;
  submit?: (
    submissions: readonly {
      call: HostCall;
      effects: readonly HostModuleEffect[];
      context: HostModuleContext;
    }[],
    options: {
      /** Current action run or volatile trigger probe whose execution owns this batch. */
      arcRunId: ArcRunId;
      signal: AbortSignal;
    },
  ) => Promise<readonly { hostCallId: string; moduleData?: PayloadValue }[]>;
  releaseRun?: (arcRunId: ArcRunId) => Promise<void>;
};

/** A submission and its admitted outcomes, in canonical occurrence order. */
export type HostCallRecord = {
  call: HostCall;
  context: HostModuleContext;
  runtimeCallId?: BriefId;
  /** Source traversal entry that owns this occurrence, absent for trigger calls. */
  enterCount?: number;
  acknowledged: boolean;
  effects: HostModuleEffect[];
};

/** Required durable host module recording at a traversal boundary. */
export type HostModuleState = { calls: HostCallRecord[] };

/** Locate the source entry without interpreting opaque runtime brief ids. */
export function hostCallTraversal(
  traversals: ArcTraversalSet,
  sourceRef: NodeRef,
): Traversal | undefined {
  const pending: Traversal[] = [...traversals];
  while (pending.length) {
    const traversal = pending.pop()!;
    let ref = traversal.ref;
    if (isArcRef(ref)) {
      const { source, identifier } = toArcRefParts(ref);
      ref = toNodeRef(source, [identifier]);
    }
    if (ref === sourceRef) return traversal;
    pending.push(...traversal.ownedChildren, ...traversal.ephemeralChildren);
  }
  return undefined;
}

/** Accept only finite, acyclic payload data supported by the recording. */
export function assertCallPayload(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value))
    throw new TypeError("Invalid host call payload.");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError("Invalid host call payload.");
  seen.add(value);
  for (const item of Object.values(value)) assertCallPayload(item, seen);
  seen.delete(value);
}

export function assertModuleEffect(
  value: unknown,
): asserts value is HostModuleEffect {
  const effect = value as HostModuleEffect | undefined;
  if (
    !effect ||
    typeof effect.hostCallId !== "string" ||
    !effect.hostCallId ||
    !effect.hostCallOutcome
  )
    throw new TypeError("Invalid host module effect.");
  const outcome = effect.hostCallOutcome;
  switch (outcome.kind) {
    case "resolution":
      assertCallPayload(outcome.value);
      return;
    case "failure":
      if (typeof outcome.reason === "string") return;
      break;
    case "interruption":
      if (
        outcome.interruption &&
        typeof outcome.interruption.id === "string" &&
        (outcome.interruption.reason === undefined ||
          typeof outcome.interruption.reason === "string")
      )
        return;
  }
  throw new TypeError("Invalid host module outcome.");
}

/** Persisted runs and replay checkpoints require the current host module schema. */
export function assertHostModuleState(
  value: unknown,
): asserts value is HostModuleState {
  const state = value as HostModuleState | undefined;
  if (!state || !Array.isArray(state.calls))
    throw new TypeError("Invalid host module recording.");
  const ids = new Set<string>();
  for (const record of state.calls) {
    const call = record?.call;
    if (
      !call ||
      typeof call.hostCallId !== "string" ||
      !call.hostCallId ||
      ids.has(call.hostCallId) ||
      typeof call.sourceRef !== "string" ||
      typeof call.module !== "string" ||
      typeof call.operation !== "string" ||
      !Array.isArray(call.target) ||
      call.target.some((part) => typeof part !== "string") ||
      !Array.isArray(call.arguments) ||
      (record.runtimeCallId !== undefined &&
        typeof record.runtimeCallId !== "string") ||
      (record.enterCount !== undefined &&
        (!Number.isInteger(record.enterCount) || record.enterCount < 0)) ||
      typeof record.acknowledged !== "boolean" ||
      !record.context ||
      (record.context.arcRunId !== undefined &&
        typeof record.context.arcRunId !== "string") ||
      (record.context.arcRef !== undefined &&
        typeof record.context.arcRef !== "string") ||
      !Array.isArray(record.effects)
    )
      throw new TypeError("Invalid host module call recording.");
    ids.add(call.hostCallId);
    assertCallPayload(call.arguments);
    assertCallPayload(call.hostParams);
    assertCallPayload(call.moduleData);
    for (const effect of record.effects) {
      assertModuleEffect(effect);
      if (effect.hostCallId !== call.hostCallId)
        throw new TypeError(
          "Host module effect has mismatched occurrence identity.",
        );
    }
  }
}
