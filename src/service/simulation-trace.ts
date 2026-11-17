import type {
  ArcRef,
  ArcTraversalSet,
  Dialog,
  NodeRef,
  NodeState,
} from "@elem-app/arc/runtime";
import { deserialize, serialize } from "node:v8";

import type { ReplayCheckpoint, ReplayStep } from "../types/replay.js";
import type {
  SimulationChoice,
  SimulationId,
  SimulationOutcome,
  SimulationPath,
  SimulationPathChoice,
  SimulationPathId,
} from "../types/simulation.js";

/** A retained choice with its submitted answer and consultation key for comparing paths. */
export type AnswerRecord = SimulationPathChoice & {
  choice: SimulationChoice;
  key: string;
};

/** The shared prefix and the two observed leaves reached by varying its input. */
export type Fork = { prefix: Prefix; left: Prefix; right: Prefix };

export type StoredCheckpoint = Omit<ReplayCheckpoint, "traversals"> & {
  traversals: Buffer;
};

/** Capture the replay state without retaining a second live traversal tree. */
export function storeCheckpoint(
  position: ReplayCheckpoint["position"],
  traversals: ArcTraversalSet,
  hostModules: ReplayCheckpoint["hostModules"],
): StoredCheckpoint {
  return {
    ...structuredClone({ position, hostModules }),
    traversals: serialize(traversals),
  };
}

/** One shared prefix ending at an actual runtime output. */
export type Prefix = {
  id: SimulationPathId;
  parent?: Prefix;
  steps: ReplayStep[];
  checkpoints: StoredCheckpoint[];
  triggerTraversals?: ArcTraversalSet;
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

/** Materialize detached replay records, traversal state and ordered JSONL for one path. */
export function readPath(
  simulationId: SimulationId,
  arcRef: ArcRef,
  prefix: Prefix,
): SimulationPath {
  const nodes = history(prefix);
  const lines: string[] = [];
  const checkpoints: ReplayCheckpoint[] = [];
  let finalTraversals: ArcTraversalSet = [];
  for (const node of nodes) {
    if (node.triggerTraversals) finalTraversals = node.triggerTraversals;
    for (const { position, hostModules, traversals } of node.checkpoints) {
      finalTraversals = deserialize(traversals) as ArcTraversalSet;
      checkpoints.push({
        ...structuredClone({ position, hostModules }),
        traversals: finalTraversals,
      });
    }
    for (const step of node.steps) {
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
    finalTraversals: prefix.triggerTraversals
      ? structuredClone(finalTraversals)
      : finalTraversals,
    traceJsonl: lines.join("\n") + "\n",
  };
}

/** Initial Dialog supplied to a provider before the first trigger is evaluated. */
export const emptyDialog = (): Dialog => ({
  lastTurns: [],
  cursor: { user: 0, self: 0 },
});
