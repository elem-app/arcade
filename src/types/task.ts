import type {
  BriefId,
  Dialog,
  InstructionBrief,
  NodeRef,
  ObservationBrief,
  ObservationGroupBrief,
  ObservationGroupField,
  SemanticText,
} from "@elem-app/arc/runtime";
import type { PrimitiveValue } from "@elem-app/arc/types";

import type { ArcRunId } from "./core.js";

/** Public structured work the hub can carry out. */
export type Task = InstructionTask | SemanticTask;

/**
 * A conclusion a worker may report about its task's whole frontier instead of
 * answering the task. See `RoutineReport`.
 */
export type TaskDisposition = "deflect" | "interrupt";

/** Managed-agent context sharing boundary selected by Arcade policy. */
export type ContextIsolation = "role" | "node";

/** Stable owner of one managed-agent context inside an Arc run. */
export type WorkerContextOwner =
  | {
      kind: "trigger";
      role: string;
      batchId: string;
    }
  | {
      kind: "role";
      role: string;
    }
  | {
      kind: "node";
      role: string;
      sourceRef: NodeRef;
    };

/** Runtime brief ids covered by one instruction task. */
export type InstructionBriefIds = readonly [BriefId, ...BriefId[]];

/** Arc `$instruct(...)` work handed to workers. */
export type InstructionTask = {
  /** Work discriminator. */
  kind: "instruction";
  /** Arc runtime brief ids covered by this task. */
  briefIds: InstructionBriefIds;
  /** Worker role requested by the Arc author. */
  role: string;
  /** Structured instruction text from Arc runtime briefs. */
  texts: readonly [SemanticText, ...SemanticText[]];
  /** Standing guidance aligned with briefIds and texts; null marks an empty slot. */
  guidance?: readonly (SemanticText | null)[];
  /** Optional tool ids requested by the Arc author. */
  tools: readonly string[];
  /** Arc cell values visible at the instruction frontier. */
  cells: CellSnapshot;
  /** Arc run this instruction belongs to. */
  arcRunId: ArcRunId;
  /** Dialog snapshot for the worker, re-projected for the task's role at dispatch. */
  dialog: Dialog;
  /** Arc source node that emitted the instruction. */
  sourceRef: NodeRef;
  /** Effective managed-agent context isolation for this task. */
  contextIsolation: ContextIsolation;
  /** Runtime phase of the source instruction brief. */
  phase: InstructionBrief["phase"];
  /** Dispositions the worker may report for this task. */
  allowedDispositions: readonly TaskDisposition[];
};

/** Semantic frontier work handed to workers. */
export type SemanticTask = {
  /** Work discriminator. */
  kind: "semantic";
  /** Stable synthetic id for this semantic batch. */
  batchId: string;
  /** Worker role requested by host params. */
  role: string;
  /** Run stage this semantic work belongs to. */
  stage: "trigger" | "action";
  /** Arc run that produced the semantic frontier. */
  arcRunId: ArcRunId;
  /**
   * Dialog snapshot for the worker: re-projected for the task's role at
   * dispatch on action frontiers; on trigger frontiers, the held inbound's
   * projection (the trigger stage has no committed history to project from).
   */
  dialog: Dialog;
  /** Semantic requests belonging to this role. */
  requests: readonly SemanticRequest[];
  /** Effective managed-agent context isolation for this task. */
  contextIsolation: ContextIsolation;
  /** Active instruction context when semantic work is part of an action frontier. */
  activeInstruction?: InstructionTask;
  /** Dispositions the worker may report for this task. */
  allowedDispositions: readonly TaskDisposition[];
};

/** Structured semantic request emitted by arc host and rendered by backends. */
export type SemanticRequest =
  | {
      kind: "judgment";
      briefId: BriefId;
      role: string;
      question: SemanticText;
      guidance?: SemanticText;
      tool: SemanticToolDefinition;
      sourceRef: NodeRef;
    }
  | {
      kind: "observation";
      briefId: BriefId;
      role: string;
      cell: string;
      mode: ObservationBrief["mode"];
      question: SemanticText;
      guidance?: SemanticText;
      currentValue?: PrimitiveValue | PrimitiveValue[];
      meta: ObservationBrief["meta"];
      tool: SemanticToolDefinition;
      sourceRef: NodeRef;
    }
  | {
      kind: "observation-group";
      briefId: BriefId;
      role: string;
      mode: ObservationGroupBrief["mode"];
      fields: ObservationGroupField[];
      guidance?: SemanticText;
      tool: SemanticToolDefinition;
      sourceRef: NodeRef;
    };

/** Arc host-owned semantic result contract that backends can render into prompt/tool surfaces. */
export type SemanticToolDefinition = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
};

/** Read-only snapshot of arc cells passed into a dispatched worker. */
export type CellSnapshot = Readonly<Record<string, PrimitiveValue>>;

/** Correlation id for a task: brief ids for instructions, batch id for semantic work. */
export function taskId(task: Task): string {
  return task.kind === "instruction" ? task.briefIds.join("+") : task.batchId;
}

/** Problem found while converting an Arc instruction brief into worker intent. */
export type InstructionIssue = {
  /** Runtime brief id for the invalid instruction item. */
  instructionId: string;
  /** Rendered instruction text for the invalid instruction item. */
  text: string;
  /** Stable machine-readable issue code. */
  code: "invalid-worker-role" | "invalid-worker-tools";
  /** Human-readable diagnostic. */
  message: string;
  /** Dot path to the invalid instruction metadata. */
  path: string;
};
