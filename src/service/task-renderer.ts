/**
 * Backend prompt DTO renderer for Arc-derived tasks.
 *
 * Arc host keeps task text as structured `SemanticText` so backend-specific
 * filesystem paths are not chosen too early. This module is the shared
 * boundary that walks backend-facing task/request structures, renders every
 * prompt-visible `SemanticText` for a concrete target, and returns explicit
 * prompt DTO shapes for backend prompt builders to serialize into model-facing
 * text. These DTOs are not runtime state or persistence records.
 */

import type { DialogTurn } from "@elem-app/arc/runtime";

import type { RoutineContext } from "../types/routine.js";
import type {
  CellSnapshot,
  InstructionBriefIds,
  InstructionTask,
  SemanticRequest,
  SemanticTask,
  Task,
} from "../types/task.js";
import {
  renderAgentSemanticText,
  type ArtifactPathRenderTarget,
  type PromptAudienceReference,
  type RenderedSemanticText,
} from "./semantic-text-renderer.js";

export type RenderedJudgmentRequestForPrompt = {
  id: SemanticRequest["briefId"];
  kind: "judgment";
  question: string;
  guidance?: string;
};

export type RenderedObservationRequestForPrompt = {
  id: SemanticRequest["briefId"];
  kind: "observation";
  guidance?: string;
  cell: Extract<SemanticRequest, { kind: "observation" }>["cell"];
  mode: Extract<SemanticRequest, { kind: "observation" }>["mode"];
  question: string;
  currentValue?: Extract<
    SemanticRequest,
    { kind: "observation" }
  >["currentValue"];
  meta: Extract<SemanticRequest, { kind: "observation" }>["meta"];
};

export type RenderedObservationGroupFieldForPrompt = {
  cell: Extract<SemanticRequest, { kind: "observation" }>["cell"];
  question: string;
  currentValue?: Extract<
    SemanticRequest,
    { kind: "observation" }
  >["currentValue"];
  meta: Extract<SemanticRequest, { kind: "observation" }>["meta"];
};

export type RenderedObservationGroupRequestForPrompt = {
  id: SemanticRequest["briefId"];
  kind: "observation-group";
  guidance?: string;
  mode: Extract<SemanticRequest, { kind: "observation-group" }>["mode"];
  fields: RenderedObservationGroupFieldForPrompt[];
};

/**
 * An admissible example value for an observation's cell type. Worker prompts
 * seed a shape-correct example report; a wrong-typed example (a boolean for a
 * string or ranged-int cell) would teach the worker to emit values the runtime
 * rejects, looping the observation back as invalid.
 */
export function exampleObservationValue(
  meta: Extract<SemanticRequest, { kind: "observation" }>["meta"],
): boolean | number | string | (boolean | number | string)[] {
  if (meta.type === "array") {
    return [exampleScalarObservationValue(meta.element)];
  }
  return exampleScalarObservationValue(meta);
}

function exampleScalarObservationValue(meta: {
  type: "boolean" | "string" | "enum" | "rangedInt" | "number";
  values?: string[];
  min?: number;
  max?: number;
}): boolean | number | string {
  switch (meta.type) {
    case "boolean":
      return true;
    case "rangedInt":
      return meta.min ?? 0;
    case "number":
      return (
        meta.min ?? (meta.max !== undefined && meta.max < 0 ? meta.max : 0)
      );
    case "enum":
      return meta.values?.[0] ?? "";
    case "string":
      return "example";
  }
}

/** Build one shape-correct semantic report example for a worker prompt. */
export function semanticReportExample(
  task: SemanticTask,
): Record<string, unknown> {
  const semantic: Record<string, unknown> = {};
  const judgmentIds = task.requests
    .filter((request) => request.kind === "judgment")
    .map((request) => request.briefId);
  const observations: Record<string, unknown> = {};
  for (const request of task.requests) {
    if (request.kind === "observation") {
      observations[request.briefId] = {
        status: "resolved",
        value: exampleObservationValue(request.meta),
      };
    } else if (request.kind === "observation-group") {
      observations[request.briefId] = {
        fields: Object.fromEntries(
          request.fields.map((field) => [
            field.cell,
            { status: "resolved", value: exampleObservationValue(field.meta) },
          ]),
        ),
      };
    }
  }
  if (judgmentIds.length > 0) {
    semantic["judgments"] = Object.fromEntries(
      judgmentIds.map((id) => [id, true]),
    );
  }
  if (Object.keys(observations).length > 0) {
    semantic["observations"] = observations;
  }
  return semantic;
}

export type RenderedSemanticRequestForPrompt =
  | RenderedJudgmentRequestForPrompt
  | RenderedObservationRequestForPrompt
  | RenderedObservationGroupRequestForPrompt;

export type RenderedInstructionTaskForPrompt = Omit<
  InstructionTask,
  "texts" | "guidance"
> & {
  text: string;
  guidance?: string;
  audienceReferences?: readonly PromptAudienceReference[];
};

export type RenderedSemanticTaskForPrompt = Omit<
  SemanticTask,
  "requests" | "activeInstruction"
> & {
  requests: RenderedSemanticRequestForPrompt[];
  activeInstruction?: RenderedInstructionTaskForPrompt;
};

export type RenderedTaskForPrompt =
  | RenderedInstructionTaskForPrompt
  | RenderedSemanticTaskForPrompt;

export type RenderedActiveInstructionForPrompt = {
  ids: InstructionBriefIds;
  role: string;
  text: string;
  guidance?: string;
  phase: InstructionTask["phase"];
  cells?: CellSnapshot;
  audienceReferences?: readonly PromptAudienceReference[];
};

/**
 * Render dialog turns as XML `<msg>` elements for embedding in a prompt. Each
 * turn carries its author (`by`) and ordinal (`idx`) so the model can attribute
 * and order turns unambiguously. Returns the empty string for an empty dialog;
 * callers decide how to wrap or label the block.
 */
export function renderDialogTurns(turns: readonly DialogTurn[]): string {
  return turns
    .map(
      (turn, idx) =>
        `<msg by="${turn.role}" idx="${idx}">${turn.message}</msg>`,
    )
    .join("\n");
}

/** Wrap prompt content in a named XML block. */
export function xmlBlock(tag: string, content: string): string {
  return [`<${tag}>`, content, `</${tag}>`].join("\n");
}

/**
 * Prompt parts that prime a fresh backend session with the task's prior dialog
 * turns, or an empty list when priming is unnecessary or there is nothing to
 * prime. Callers spread the result into their prompt parts. The decision of
 * whether a session is fresh enough to prime (`shouldPrime`) is the backend's,
 * since each SDK has its own session model.
 */
export function renderDialogPriming(
  task: Task,
  shouldPrime: boolean,
): string[] {
  if (!shouldPrime || task.dialog.lastTurns.length === 0) return [];
  return [
    "",
    xmlBlock("prior-turns", renderDialogTurns(task.dialog.lastTurns)),
  ];
}

export const INSTRUCTION_EXECUTION_BOUNDARY_RULES = [
  "Execute only the current assigned task.",
  "Do not create, edit, delete, or move durable workspace files unless this instruction explicitly names that file operation or the file is only a scratch/output artifact required by this instruction.",
  "When the instruction asks you to read, scope, prepare, inspect, summarize, or analyze, report the result for this task without applying document changes unless the same instruction explicitly asks for those changes.",
];

export function renderInstructionTaskText(
  task: InstructionTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
): string {
  return renderInstructionTaskTextForPrompt(task, context, target).text;
}

export function renderInstructionTaskTextForPrompt(
  task: InstructionTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
): {
  text: string;
  guidance?: string;
  audienceReferences: readonly PromptAudienceReference[];
} {
  assertInstructionAlignment(task);
  const rendered = task.texts.map((text) =>
    renderAgentSemanticText(text, context, target),
  );
  const renderedGuidance = task.briefIds.flatMap((id, index) => {
    const guidance = task.guidance?.[index];
    if (guidance == null) return [];
    const rendered = renderAgentSemanticText(guidance, context, target);
    return [
      {
        ...rendered,
        text:
          task.briefIds.length === 1
            ? rendered.text
            : `Instruction ${index + 1} (${id}):\n${rendered.text}`,
      },
    ];
  });
  const guidance =
    renderedGuidance.length > 0
      ? { guidance: renderedGuidance.map((item) => item.text).join("\n\n") }
      : {};
  const audienceReferences = collectAudienceReferences([
    ...rendered,
    ...renderedGuidance,
  ]);
  if (rendered.length === 1) {
    return { text: rendered[0]!.text, ...guidance, audienceReferences };
  }
  return {
    text: rendered
      .map((text, index) =>
        [`Instruction ${index + 1} (${task.briefIds[index]}):`, text.text].join(
          "\n",
        ),
      )
      .join("\n\n"),
    ...guidance,
    audienceReferences,
  };
}

export function renderInstructionAudienceReferencesForPrompt(
  task: InstructionTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
): readonly PromptAudienceReference[] {
  return renderInstructionTaskTextForPrompt(task, context, target)
    .audienceReferences;
}

function collectAudienceReferences(
  rendered: readonly RenderedSemanticText[],
): PromptAudienceReference[] {
  const seen = new Set<string>();
  const refs: PromptAudienceReference[] = [];
  for (const item of rendered) {
    for (const ref of item.audienceReferences) {
      if (seen.has(ref.marker)) continue;
      seen.add(ref.marker);
      refs.push(ref);
    }
  }
  return refs;
}

function optionalAudienceReferences(refs: readonly PromptAudienceReference[]): {
  audienceReferences?: readonly PromptAudienceReference[];
} {
  return refs.length > 0 ? { audienceReferences: refs } : {};
}

function optionalCells(cells: CellSnapshot): {
  cells?: CellSnapshot;
} {
  return Object.keys(cells).length > 0 ? { cells } : {};
}

function renderedInstructionTaskFields(
  task: InstructionTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
): {
  text: string;
  guidance?: string;
  audienceReferences?: readonly PromptAudienceReference[];
  cells?: CellSnapshot;
} {
  const rendered = renderInstructionTaskTextForPrompt(task, context, target);
  return {
    text: rendered.text,
    ...(rendered.guidance !== undefined ? { guidance: rendered.guidance } : {}),
    ...optionalAudienceReferences(rendered.audienceReferences),
    ...optionalCells(task.cells),
  };
}

export function renderSemanticRequestForPrompt(
  request: SemanticRequest,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
  stage: SemanticTask["stage"],
): RenderedSemanticRequestForPrompt {
  const guidance =
    stage === "trigger" || request.guidance === undefined
      ? {}
      : {
          guidance: renderAgentSemanticText(request.guidance, context, target)
            .text,
        };
  if (request.kind === "observation-group") {
    return {
      id: request.briefId,
      kind: request.kind,
      ...guidance,
      mode: request.mode,
      fields: request.fields.map((field) => ({
        cell: field.cell,
        question: renderAgentSemanticText(field.question, context, target).text,
        currentValue: field.currentValue,
        meta: field.meta,
      })),
    };
  }
  const question = renderAgentSemanticText(
    request.question,
    context,
    target,
  ).text;
  if (request.kind === "judgment") {
    return {
      id: request.briefId,
      kind: request.kind,
      question,
      ...guidance,
    };
  }
  return {
    id: request.briefId,
    kind: request.kind,
    cell: request.cell,
    mode: request.mode,
    question,
    ...guidance,
    currentValue: request.currentValue,
    meta: request.meta,
  };
}

export function renderTaskForPrompt(
  task: Task,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
): RenderedTaskForPrompt {
  if (task.kind === "instruction") {
    return renderInstructionTaskForPrompt(task, context, target);
  }
  const { requests: _requests, activeInstruction, ...rest } = task;
  return {
    ...rest,
    requests: task.requests.map((request) =>
      renderSemanticRequestForPrompt(request, context, target, task.stage),
    ),
    ...(task.stage === "action" && activeInstruction
      ? {
          activeInstruction: renderInstructionTaskForPrompt(
            activeInstruction,
            context,
            target,
          ),
        }
      : {}),
  };
}

export function renderInstructionTaskForPrompt(
  task: InstructionTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
): RenderedInstructionTaskForPrompt {
  const { texts: _texts, guidance: _guidance, ...rest } = task;
  return {
    ...rest,
    ...renderedInstructionTaskFields(task, context, target),
  };
}

export function renderActiveInstructionForPrompt(
  instruction: InstructionTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget,
): RenderedActiveInstructionForPrompt {
  return {
    ids: instruction.briefIds,
    role: instruction.role,
    phase: instruction.phase,
    ...renderedInstructionTaskFields(instruction, context, target),
  };
}

function assertInstructionAlignment(task: InstructionTask): void {
  if (task.texts.length !== task.briefIds.length) {
    throw new Error(
      `Instruction task text/brief id mismatch: ${task.texts.length} text item(s) for ${task.briefIds.length} brief id(s).`,
    );
  }
  if (task.guidance && task.guidance.length !== task.briefIds.length) {
    throw new Error(
      `Instruction task guidance/brief id mismatch: ${task.guidance.length} guidance item(s) for ${task.briefIds.length} brief id(s).`,
    );
  }
}
