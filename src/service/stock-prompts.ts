import type { RoutineContext } from "../types/routine.js";
import type { InstructionTask } from "../types/task.js";
import type { ArtifactPathRenderTarget } from "./semantic-text-renderer.js";
import { renderDialogTurns, renderTaskForPrompt } from "./task-renderer.js";

/** Build Arcade's stock system prompt for one instruction task. */
export function buildInstructionSystemPrompt(
  task: InstructionTask,
  base?: string,
): string {
  const parts = [
    base,
    "You are a managed agent.",
    "Handle exactly one work item and return only JSON.",
    "Apply the work item's standing guidance when interpreting and carrying out its associated instruction, including audience interaction. Guidance applies only to its associated work in the current assignment.",
    "Do not include a user-visible message unless the work item explicitly asks you to communicate with a workflow participant.",
    `Role: ${task.role}`,
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Build Arcade's stock user prompt for one instruction task. */
export function buildInstructionPrompt(
  task: InstructionTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget = { kind: "host" },
): string {
  const recent = renderDialogTurns(task.dialog.lastTurns);
  return [
    "Latest conversation:",
    recent,
    "",
    "Work item:",
    JSON.stringify(renderTaskForPrompt(task, context, target), null, 2),
    "",
    'Return JSON as {"report":{"outcome":"completed"}} or {"report":{"error":"failed","code":"...","message":"..."}}.',
  ].join("\n");
}
