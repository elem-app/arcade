import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type {
  AgentRoutineReport,
  RoutineContext,
  RoutineEffects,
  RoutineReport,
} from "../types/routine.js";
import type { SemanticTask } from "../types/task.js";
import type { ArtifactPathRenderTarget } from "./semantic-text-renderer.js";
import {
  renderActiveInstructionForPrompt,
  renderDialogTurns,
  renderSemanticRequestForPrompt,
  xmlBlock,
} from "./task-renderer.js";
import {
  isRecord,
  parseJson,
  validateAgentRoutineReport,
  validateOutboundItem,
} from "./utils.js";

/** Build the system prompt for resolving a semantic frontier (judge / observe). */
export function buildSemanticSystemPrompt(
  stage: SemanticTask["stage"],
  base?: string,
): string {
  const parts = [
    base,
    "You are a semantic resolver for one managed workflow.",
    "Each request is either a judgment (boolean answer), a single observation (typed value extraction), or a grouped observation (several typed cells extracted together).",
    stage === "trigger"
      ? "Answer strictly from the supplied dialog snapshot and each request's question."
      : "Answer strictly from the supplied dialog snapshot and any active instruction context.",
    stage === "action"
      ? "Apply each request's standing guidance when interpreting its question and resolving its value; use active-instruction guidance when assessing that instruction. Guidance applies only to its associated work in the current assignment."
      : undefined,
    'Return ONLY one JSON object: {"report": {"outcome": "completed", "semantic": {"judgments": {...}, "observations": {...}}}}.',
    "Include a key for every request id under judgments (boolean) or observations. A single observation maps to {status, value?}; a grouped observation maps to {fields: {<cell>: {status, value?}}} with an entry for every listed cell.",
    'For observations, status is "resolved" (with value), "unknown" (cannot determine), or "needs-user" (observeOrAsk only; user reply would help).',
    "Do not write any text outside the JSON object.",
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Build the user prompt for resolving a semantic frontier (judge / observe). */
export function buildSemanticPrompt(
  task: SemanticTask,
  context: RoutineContext,
  target: ArtifactPathRenderTarget = { kind: "host" },
): string {
  const dialog = renderDialogTurns(task.dialog.lastTurns);
  const requests = task.requests.map((request) =>
    renderSemanticRequestForPrompt(request, context, target, task.stage),
  );
  const parts: string[] = [
    xmlBlock(
      "semantic-context",
      JSON.stringify({ stage: task.stage, role: task.role }, null, 2),
    ),
    "",
    xmlBlock("latest-conversation", dialog || "(empty)"),
    "",
    xmlBlock("semantic-requests", JSON.stringify(requests, null, 2)),
  ];
  if (task.stage === "action" && task.activeInstruction) {
    const active = renderActiveInstructionForPrompt(
      task.activeInstruction,
      context,
      target,
    );
    parts.push(
      "",
      xmlBlock("active-instruction", JSON.stringify(active, null, 2)),
    );
  }
  parts.push(
    "",
    xmlBlock(
      "rules",
      "Return only the JSON object described in the system prompt.",
    ),
  );
  return parts.join("\n");
}

/** Parse a JSON agent response as an Arcade `AgentRoutineReport`. */
export async function parseAgentJsonOutput(
  text: string,
  effects: RoutineEffects | undefined,
  label: string,
  opts: { allowOutbound?: boolean } = {},
): Promise<AgentRoutineReport> {
  const parsed = parseJson(text, label);
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  if ("report" in parsed || "outbound" in parsed) {
    const report =
      "report" in parsed
        ? validateAgentRoutineReport(parsed.report, label)
        : undefined;
    if ("outbound" in parsed) {
      if (opts.allowOutbound === false) {
        throw new Error(`${label}.outbound is not valid for semantic work.`);
      }
      if (!Array.isArray(parsed.outbound)) {
        throw new Error(`${label}.outbound must be an array.`);
      }
      for (const [index, item] of parsed.outbound.entries()) {
        if (!effects) {
          throw new Error(`${label}.outbound requires routine effects.`);
        }
        const validated = validateOutboundItem(
          item,
          `${label}.outbound[${index}]`,
        );
        await effects.emit({
          situation: validated.situation,
          content: validated.content,
        });
      }
    }
    return report ?? { outcome: "completed" };
  }
  return validateAgentRoutineReport(parsed, `${label} report`);
}

/**
 * Semantic keys a worker returned that the batch never requested. Reported when
 * such keys are dropped so the over-answering stays visible without failing the
 * run. See {@link validateCompletedSemanticReport}.
 */
export type SemanticReportDrift = {
  /** Judgment ids returned but not requested as judgments. */
  unrequestedJudgments: string[];
  /** Observation ids returned but not requested as observations. */
  unrequestedObservations: string[];
};

/** Notified when a semantic report carried unrequested keys that were dropped. */
export type OnSemanticReportDrift = (drift: SemanticReportDrift) => void;

/**
 * Record semantic drift on the two channels it belongs to. Drift is not
 * originator-visible activity, so it is deliberately not a work event: it is a
 * per-routine debugging fact and a fleet-monitoring signal.
 *
 * The returned `onDrift` logs immediately (fleet monitoring, gated by log level)
 * and captures the drift; `persist` then writes it to the routine's diagnostics
 * next to the raw worker transcript (per-run debugging, written regardless of
 * log level). `persist` is a no-op when no drift occurred.
 */
export function recordSemanticReportDrift(
  logger: { info(event: string, fields?: Record<string, unknown>): void },
  event: string,
  context: Record<string, unknown>,
): {
  onDrift: OnSemanticReportDrift;
  persist(diagnostics: {
    writeJson(handle: string, value: unknown): Promise<void>;
  }): Promise<void>;
} {
  let captured: SemanticReportDrift | undefined;
  return {
    onDrift: (drift) => {
      captured = drift;
      logger.info(event, { ...context, ...drift });
    },
    persist: async (diagnostics) => {
      if (!captured) return;
      await diagnostics.writeJson("semantic-drift", {
        ...context,
        ...captured,
      });
    },
  };
}

/** Parse and fully validate a completed semantic report. */
export async function parseCompletedSemanticOutput(
  text: string,
  task: SemanticTask,
  label: string,
  onDrift?: OnSemanticReportDrift,
): Promise<Extract<RoutineReport, { outcome: "completed" }>> {
  const report = await parseAgentJsonOutput(text, undefined, label, {
    allowOutbound: false,
  });
  return validateCompletedSemanticReport(report, task, label, onDrift);
}

/** Parse and fully validate a structured completed semantic report. */
export function parseCompletedSemanticValue(
  value: unknown,
  task: SemanticTask,
  label: string,
  onDrift?: OnSemanticReportDrift,
): Extract<RoutineReport, { outcome: "completed" }> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const report =
    "report" in value
      ? validateAgentRoutineReport(value.report, label)
      : validateAgentRoutineReport(value, `${label} report`);
  return validateCompletedSemanticReport(report, task, label, onDrift);
}

/**
 * Validate that a report answered every semantic request in the batch.
 *
 * A missing required id is a hard error: the worker failed to answer something
 * asked. Extra ids the batch never requested are the opposite — a worker that
 * over-answers (e.g. echoes a judgment id under observations) is noise, not a
 * contract violation. Those are dropped from the returned report and surfaced
 * through `onDrift` rather than failing the whole run.
 */
export function validateCompletedSemanticReport(
  report: RoutineReport,
  task: SemanticTask,
  label: string,
  onDrift?: OnSemanticReportDrift,
): Extract<RoutineReport, { outcome: "completed" }> {
  if (report.outcome !== "completed") {
    throw new Error(`${label} must return a completed semantic report.`);
  }

  if (task.requests.length === 0) return report;

  if (!report.semantic) {
    throw new Error(`${label}.semantic is required for semantic work.`);
  }

  const judgmentIds = new Set(
    task.requests
      .filter((request) => request.kind === "judgment")
      .map((request) => request.briefId),
  );
  const observationIds = new Set(
    task.requests
      .filter(
        (request) =>
          request.kind === "observation" ||
          request.kind === "observation-group",
      )
      .map((request) => request.briefId),
  );
  const judgments = report.semantic.judgments ?? {};
  const observations = report.semantic.observations ?? {};

  for (const id of judgmentIds) {
    if (!(id in judgments)) {
      throw new Error(`${label}.semantic.judgments.${id} is required.`);
    }
  }
  for (const id of observationIds) {
    if (!(id in observations)) {
      throw new Error(`${label}.semantic.observations.${id} is required.`);
    }
  }

  const unrequestedJudgments = Object.keys(judgments).filter(
    (id) => !judgmentIds.has(id),
  );
  const unrequestedObservations = Object.keys(observations).filter(
    (id) => !observationIds.has(id),
  );
  if (
    unrequestedJudgments.length === 0 &&
    unrequestedObservations.length === 0
  ) {
    return report;
  }

  onDrift?.({ unrequestedJudgments, unrequestedObservations });

  const cleaned = { ...report.semantic };
  if (report.semantic.judgments) {
    cleaned.judgments = pickRequested(judgments, judgmentIds);
  }
  if (report.semantic.observations) {
    cleaned.observations = pickRequested(observations, observationIds);
  }
  return { ...report, semantic: cleaned };
}

/** Keep only the entries whose key is in `allowed`. */
function pickRequested<T>(
  map: Record<string, T>,
  allowed: Set<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(map).filter(([id]) => allowed.has(id)),
  );
}

/** Extract the last assistant text message from a PI-agent transcript. */
export function extractLastPiAgentAssistantText(
  messages: AgentMessage[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text = message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
    if (text.trim().length > 0) return text;
  }
  throw new Error("PI agent completed without an assistant text response.");
}
