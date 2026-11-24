import type {
  ActionBrief,
  ArcRef,
  ArcTraversalSet,
  Dialog,
  NodeRef,
  NodeState,
  Runtime,
  TerminalBrief,
  TriggerBrief,
} from "@elem-app/arc/runtime";

import type {
  HostModuleEffect,
  HostModuleState,
} from "../types/host-module.js";
import type {
  ActionReportStep,
  ReplayCheckpoint,
  ReplayStep,
  TriggerReportStep,
} from "../types/replay.js";
import type {
  SimulationChoice,
  SimulationId,
  SimulationOutcome,
  SimulationPath,
  SimulationPathChoice,
  SimulationPathId,
} from "../types/simulation.js";

import { captureCalls } from "./host-call-recording.js";
import { advanceHostModuleState } from "./replay-state.js";

/** A retained choice with its submitted answer and consultation key for comparing paths. */
export type AnswerRecord = SimulationPathChoice & {
  choice: SimulationChoice;
  key: string;
};

/** The shared prefix and the two observed leaves reached by varying its input. */
export type Fork = { prefix: Prefix; left: Prefix; right: Prefix };

/** A runtime-issued brief and its modeled host state at a single tape position. */
export type TapeState = {
  brief: TriggerBrief | ActionBrief | TerminalBrief;
  host: HostModuleState;
};

/** Capture modeled calls after the runtime produces a new brief. */
export function captureState(
  arcRef: ArcRef,
  brief: TapeState["brief"],
  previous: HostModuleState,
  effect?: HostModuleEffect,
): TapeState {
  const { hostModules: host, effectAdmitted } = advanceHostModuleState(
    previous,
    brief,
    effect,
  );
  if (effect && !effectAdmitted)
    throw new Error("Simulator host resolution was rejected.");
  if ("hostCalls" in brief && brief.hostCalls.length) {
    let sequence = host.calls.length;
    host.calls.push(
      ...captureCalls(
        "canProgress" in brief ? "action" : "trigger",
        host,
        brief.hostCalls,
        brief.traversals,
        { arcRef },
        () => `sim-call-${++sequence}`,
        true,
      ),
    );
  }
  return { brief, host };
}

/** Apply a recorded report without choosing any new inputs. */
export function progressTape(
  runtime: Runtime,
  arcRef: ArcRef,
  state: TapeState,
  step: ActionReportStep | TriggerReportStep,
): TapeState {
  let next: TapeState["brief"];
  if (step.kind === "trigger-report" && !("canProgress" in state.brief))
    next = runtime.progressTrigger(state.brief, step.report, step.dialog);
  else if (
    step.kind === "action-report" &&
    "canProgress" in state.brief &&
    state.brief.canProgress
  )
    next = runtime.progress(state.brief, step.report, step.dialog);
  else throw new Error("Report does not belong to the current frontier.");
  const invalid = next.issues.find(
    (i) => i.kind === "invalid-item" || i.kind === "invalid-report",
  );
  if (invalid)
    throw new TypeError(
      `Invalid simulation report at ${step.position.stage}:${step.position.index}: ${JSON.stringify(invalid)}`,
    );
  return captureState(arcRef, next, state.host, step.moduleEffect);
}

/** One shared prefix ending at an actual runtime output. */
export type Prefix = {
  id: SimulationPathId;
  parent?: Prefix;
  steps: ReplayStep[];
  checkpoint?: TapeState;
  /** Host invocation identities for comparisons at this output. */
  hostCallIds?: Record<string, string>;
  nodeStates: [NodeRef, NodeState | null][];
  answers: AnswerRecord[];
  depth: number;
  outcome: SimulationOutcome;
};

/** Use a sidecar of paths for unset slots. Authored payloads keep their original key space. */
function encodeRecord(data: object, canonical: boolean): string {
  const unset: (string | number)[][] = [];
  const path: (string | number)[] = [];
  function child(key: string | number, value: unknown) {
    path.push(key);
    const result = visit(value);
    path.pop();
    return result;
  }
  function visit(value: unknown): unknown {
    if (value === undefined) {
      unset.push(path.slice());
      return null;
    }
    if (Array.isArray(value)) {
      let result = value;
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) continue;
        const item = child(i, value[i]);
        if (item === value[i]) continue;
        if (result === value) result = value.slice();
        result[i] = item;
      }
      return result;
    }
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (canonical)
      return Object.fromEntries(
        keys.sort().map((key) => [key, child(key, object[key])]),
      );
    let result = object;
    for (const key of keys) {
      const item = child(key, object[key]);
      if (item === object[key]) continue;
      if (result === object) result = { ...object };
      result[key] = item;
    }
    return result;
  }
  const record = visit(data) as Record<string, unknown>;
  return JSON.stringify(
    unset.length ? { ...record, unsetPaths: unset } : record,
  );
}

/** Encode a canonical trace line or comparison key. */
export function encodeLine(data: object): string {
  return encodeRecord(data, true);
}

/** Sorting keys changes their order but preserves the serialized UTF-8 length. */
export function recordBytes(data: object): number {
  return Buffer.byteLength(encodeRecord(data, false));
}

/** Return the retained nodes from trigger entry through the selected prefix. */
export function history(prefix: Prefix): Prefix[] {
  const nodes: Prefix[] = [];
  for (let node: Prefix | undefined = prefix; node; node = node.parent)
    nodes.push(node);
  return nodes.reverse();
}

/** Restore a saved position from the nearest checkpoint on its branch. */
export function restorePosition(
  runtime: Runtime,
  arcRef: ArcRef,
  prefix: Prefix,
): TapeState {
  const reports: (ActionReportStep | TriggerReportStep)[] = [];
  let node = prefix;
  while (!node.checkpoint) {
    const step = node.steps[0];
    if (
      !node.parent ||
      (step?.kind !== "action-report" && step?.kind !== "trigger-report")
    )
      throw new Error("Missing simulation checkpoint.");
    reports.push(step);
    node = node.parent;
  }
  let state: TapeState = node.checkpoint;
  for (let i = reports.length - 1; i >= 0; i--)
    state = progressTape(runtime, arcRef, state, reports[i]!);
  return state;
}

/** Materialize detached replay records, traversal state and ordered JSONL for one path. */
export function readPath(
  runtime: Runtime,
  simulationId: SimulationId,
  arcRef: ArcRef,
  prefix: Prefix,
): SimulationPath {
  const nodes = history(prefix);
  const lines: string[] = [];
  const checkpoints: ReplayCheckpoint[] = [];
  let state: TapeState | undefined;
  let finalTraversals: ArcTraversalSet = [];
  for (const node of nodes) {
    const previous = state;
    const first = node.steps[0]!;
    if (node.checkpoint) state = node.checkpoint;
    else if (
      previous &&
      (first.kind === "trigger-report" || first.kind === "action-report")
    )
      state = progressTape(runtime, arcRef, previous, first);
    else throw new Error("Missing simulation checkpoint.");
    finalTraversals = state.brief.traversals;
    for (const step of node.steps) {
      if (step.kind === "action-brief" || step.kind === "terminal-brief") {
        if (step.position.index === 1 && previous)
          checkpoints.push(
            structuredClone({
              position: { ...step.position, index: 0 },
              traversals: previous.brief.traversals,
              hostModules: previous.host,
            }),
          );
        checkpoints.push(
          structuredClone({
            position: step.position,
            traversals: finalTraversals,
            hostModules: state.host,
          }),
        );
      }
      const base = {
        kind: step.kind,
        position: step.position,
        dialog: step.dialog,
      };
      if ("brief" in step)
        lines.push(
          encodeLine({
            ...base,
            brief: { ...step.brief, traversals: finalTraversals },
          }),
        );
      else if ("report" in step)
        lines.push(encodeLine({ ...base, report: step.report }));
      else lines.push(encodeLine({ ...base, arcRefs: step.arcRefs }));
    }
  }
  lines.push(encodeLine({ kind: "simulation-end", outcome: prefix.outcome }));
  return {
    ...structuredClone({
      simulationId,
      arcRef,
      steps: nodes.flatMap((node) => node.steps),
      id: prefix.id,
      outcome: prefix.outcome,
      reports: prefix.depth,
      choices: nodes.flatMap((node) =>
        node.answers.map(({ key: _, choice: __, ...rest }) => rest),
      ),
    }),
    checkpoints,
    finalTraversals:
      checkpoints.at(-1)?.traversals ?? structuredClone(finalTraversals),
    traceJsonl: lines.join("\n") + "\n",
  };
}

/** Initial Dialog supplied to a provider before the first trigger is evaluated. */
export const emptyDialog = (): Dialog => ({
  lastTurns: [],
  cursor: { user: 0, self: 0 },
});
