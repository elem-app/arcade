import { Buffer } from "node:buffer";

import type { NodeRef } from "@elem-app/arc/runtime";

import type { SemanticTask, Task, WorkerContextOwner } from "../types/task.js";

const CONTEXT_KEY_VERSION = "v2";

type SemanticTaskSource = Pick<
  SemanticTask,
  "activeInstruction" | "batchId" | "requests" | "stage"
>;

/**
 * Resolve the node that owns one semantic task.
 *
 * Action tasks are node-local by Arc frontier construction. Assert that
 * invariant here rather than allowing context identity, policy lookup, and
 * work-event metadata to choose different nodes.
 */
export function semanticTaskSourceRef(task: SemanticTaskSource): NodeRef {
  const sourceRef =
    task.activeInstruction?.sourceRef ?? task.requests[0]?.sourceRef;
  if (!sourceRef) {
    throw new Error(`Semantic task ${task.batchId} has no source node ref.`);
  }
  if (task.stage === "action") {
    const sourceRefs = new Set([
      sourceRef,
      ...task.requests.map((request) => request.sourceRef),
    ]);
    if (sourceRefs.size > 1) {
      throw new Error(
        `Action semantic task ${task.batchId} spans source nodes: ${[...sourceRefs].join(", ")}.`,
      );
    }
  }
  return sourceRef;
}

/** Resolve the single source node Arcade uses for task ownership and metadata. */
export function taskSourceRef(task: Task): NodeRef {
  return task.kind === "instruction"
    ? task.sourceRef
    : semanticTaskSourceRef(task);
}

/** Resolve the trigger-, role-, or node-owned managed context carried by one task. */
export function workerContextOwner(task: Task): WorkerContextOwner {
  if (task.kind === "semantic" && task.stage === "trigger") {
    return { kind: "trigger", role: task.role, batchId: task.batchId };
  }
  if (task.contextIsolation === "role") {
    return { kind: "role", role: task.role };
  }
  return {
    kind: "node",
    role: task.role,
    sourceRef: taskSourceRef(task),
  };
}

/** Encode one task's managed-context identity as an opaque run-scoped key. */
export function workerContextKey(
  task: Task,
  reactivationCount: number,
): string {
  const owner = workerContextOwner(task);
  const tuple =
    owner.kind === "trigger"
      ? [reactivationCount, "trigger", owner.role, owner.batchId]
      : owner.kind === "role"
        ? [reactivationCount, "role", owner.role]
        : [reactivationCount, "node", owner.role, owner.sourceRef];
  const encoded = Buffer.from(JSON.stringify(tuple), "utf8").toString(
    "base64url",
  );
  return `${task.arcRunId}:${CONTEXT_KEY_VERSION}.${encoded}`;
}
