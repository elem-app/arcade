import type {
  ArcTraversalSet,
  Dialog,
  InstructionBrief,
  NodeRef,
  PayloadValue,
  SemanticText,
} from "@elem-app/arc/runtime";
import { toArcRef, toNodeRefParts } from "@elem-app/arc/runtime";
import type { CellValue, PrimitiveValue, StructValue } from "@elem-app/arc/types";
import { isPrimitiveValue } from "@elem-app/arc/types";

import { DEFAULT_WORKER_ROLE } from "../constants.js";
import { diagnosticSemanticText } from "../service/semantic-text-renderer.js";
import type { ArcRunId } from "../types/core.js";
import type {
  CellSnapshot,
  ContextIsolation,
  InstructionIssue,
  InstructionTask,
} from "../types/task.js";

export type WorkerInstruction = {
  role: string;
  text: SemanticText;
  tools: string[];
};

export type WorkerInstructionResult =
  | { ok: true; instruction: WorkerInstruction }
  | { ok: false; issues: InstructionIssue[] };

/**
 * Read worker-role metadata off an instruction brief.
 *
 * Missing `hostParams.workerRole` falls back to `DEFAULT_WORKER_ROLE`; the
 * worker hub then routes the instruction through its default worker path.
 * A present-but-malformed `workerRole` or `tools` still surfaces as a hard
 * issue so typos are not silently absorbed.
 */
export function readWorkerInstruction(
  brief: InstructionBrief,
): WorkerInstructionResult {
  const text = diagnosticSemanticText(brief.text);
  const params = isPayloadObject(brief.hostParams) ? brief.hostParams : {};
  const issues: InstructionIssue[] = [];

  let role = DEFAULT_WORKER_ROLE;
  if (params.workerRole !== undefined) {
    if (
      typeof params.workerRole === "string" &&
      params.workerRole.trim() !== ""
    ) {
      role = params.workerRole;
    } else {
      issues.push({
        instructionId: brief.id,
        text,
        code: "invalid-worker-role",
        message:
          "Instruction hostParams.workerRole must be a non-empty string.",
        path: "hostParams.workerRole",
      });
    }
  }

  let tools: string[] = [];
  if (params.tools !== undefined) {
    if (isStringArray(params.tools)) {
      tools = params.tools;
    } else {
      issues.push({
        instructionId: brief.id,
        text,
        code: "invalid-worker-tools",
        message: "Instruction hostParams.tools must be an array of strings.",
        path: "hostParams.tools",
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    instruction: { role, text: brief.text, tools },
  };
}

export function buildInstructionTaskFromBriefs(args: {
  items: readonly {
    brief: InstructionBrief;
    instruction: WorkerInstruction;
  }[];
  traversals: ArcTraversalSet;
  active: NodeRef;
  arcRunId: ArcRunId;
  dialog: Dialog;
  contextIsolation: ContextIsolation;
}): InstructionTask {
  const first = args.items[0];
  if (!first) {
    throw new Error("Cannot build an instruction task without briefs.");
  }
  const sourceRef = instructionTaskSourceRef(args.items);
  // The Arc runtime batches instruction briefs only when their effective
  // instruction host params match, so the first item carries the shared
  // worker-role metadata for the whole batch.
  const sharedInstruction = first.instruction;
  return {
    kind: "instruction",
    briefIds: asInstructionBriefIds(args.items.map((item) => item.brief.id)),
    role: sharedInstruction.role,
    texts: asInstructionTexts(args.items.map((item) => item.instruction.text)),
    tools: sharedInstruction.tools,
    cells: snapshotCells(args.traversals, args.active),
    arcRunId: args.arcRunId,
    dialog: args.dialog,
    sourceRef,
    contextIsolation: args.contextIsolation,
    phase: first.brief.phase,
  };
}

/**
 * Resolve the node that owns one instruction task.
 *
 * Instruction task construction is node-local. Assert that invariant before
 * policy lookup and task materialization use the source ref.
 */
export function instructionTaskSourceRef(
  items: readonly { brief: Pick<InstructionBrief, "id" | "sourceRef"> }[],
): NodeRef {
  const first = items[0];
  if (!first) {
    throw new Error("Cannot resolve an instruction task without briefs.");
  }
  const sourceRefs = new Set(items.map((item) => item.brief.sourceRef));
  if (sourceRefs.size > 1) {
    throw new Error(
      `Instruction task spans source nodes: ${[...sourceRefs].join(", ")}.`,
    );
  }
  return first.brief.sourceRef;
}

function asInstructionBriefIds(
  values: readonly string[],
): InstructionTask["briefIds"] {
  if (values.length === 0) {
    throw new Error("Instruction task must contain at least one brief id.");
  }
  return [values[0]!, ...values.slice(1)];
}

function asInstructionTexts(
  values: readonly SemanticText[],
): InstructionTask["texts"] {
  if (values.length === 0) {
    throw new Error("Instruction task must contain at least one text.");
  }
  return [values[0]!, ...values.slice(1)];
}

/**
 * Collect a flat snapshot of cell values along the traversal path from
 * the arc root down to the active node. Inner scopes win on name conflicts.
 */
export function snapshotCells(
  traversals: ArcTraversalSet,
  active: NodeRef,
): CellSnapshot {
  const path = collectPath(traversals, active);
  const merged: Record<string, PrimitiveValue> = {};
  for (const cells of path) {
    for (const [name, value] of Object.entries(cells)) {
      if (isPrimitiveValue(value)) merged[name] = value;
    }
  }
  return merged;
}

function collectPath(
  traversals: ArcTraversalSet,
  active: NodeRef,
): Array<Record<string, CellValue | undefined>> {
  const { source, path: targetPath } = toNodeRefParts(active);
  if (targetPath.length === 0) return [];

  const arc = toArcRef(source, targetPath[0]!);
  const root = traversals.find((t) => t.ref === arc);
  if (!root) return [];

  const collected: Array<Record<string, CellValue | undefined>> = [root.cells];

  let current: { ownedChildren: typeof root.ownedChildren } = root;
  for (let i = 1; i < targetPath.length; i += 1) {
    const next = current.ownedChildren.find((child) => {
      const parts = toNodeRefParts(child.ref);
      return parts.path[parts.path.length - 1] === targetPath[i];
    });
    if (!next) break;
    collected.push(next.cells);
    current = next;
  }

  return collected;
}

function isPayloadObject(
  value: PayloadValue | undefined,
): value is StructValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: PayloadValue | undefined): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
