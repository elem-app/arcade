import { ORIGINATOR_AUDIENCE } from "../constants.js";
import type { OutboundCause, OutboundSituation } from "../types/messaging.js";
import type { PromptAudienceReference } from "./semantic-text-renderer.js";
export {
  AgentRoutineReportSchema,
  RoutineReportSchema,
  validateAgentRoutineReport,
  validateRoutineReport,
} from "../types/routine.js";

/**
 * Situation shape a worker may emit. The host stamps `role` from the
 * originating instruction, so workers only supply audience (optional, defaults
 * to `originator`) and cause.
 */
export type ParsedWorkerOutboundSituation = Omit<OutboundSituation, "role">;

export function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a worker-supplied outbound item.
 *
 * The host stamps `situation.role` from the originating instruction, so worker
 * JSON only needs to provide `audience` (optional, defaults to `originator`)
 * and `cause`. Any `situation.role` supplied by the worker is ignored.
 */
export function validateOutboundItem(
  value: unknown,
  label: string,
): {
  situation: ParsedWorkerOutboundSituation;
  content: string;
} {
  if (
    !isRecord(value) ||
    !isRecord(value.situation) ||
    !isNonEmptyString(value.situation.cause) ||
    typeof value.content !== "string"
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  const audience =
    typeof value.situation.audience === "string" &&
    value.situation.audience.trim().length > 0
      ? value.situation.audience
      : "originator";
  return {
    situation: {
      audience,
      cause: value.situation.cause,
    },
    content: value.content,
  };
}

function ensureReferencedAudience(
  audience: string,
  audienceReferences: readonly PromptAudienceReference[],
): string | undefined {
  for (const ref of audienceReferences) {
    if (audience === ref.marker || audience === ref.audience) {
      return ref.audience;
    }
  }
  return undefined;
}

/**
 * Resolve the target audience for a worker's one-way `emit_outbound` reply, or
 * `undefined` when the reply should be suppressed.
 *
 * `emit_outbound` is suppressible by design, and asymmetric with
 * {@link normalizeQuestionAudience}, which rejects an unrecognized audience.
 * The model tends to call `emit_outbound` over-eagerly — surfacing messages
 * (often to the user) when it should stay silent — so a reply to an audience
 * the instruction does not name, or to no audience at all, is silently dropped
 * (`undefined`) rather than erroring. A tool error reads to the model as "try
 * again" and invites another call; suppression lets the caller return a private
 * success acknowledgement that neither delivers the message nor encourages a
 * retry. A blocking question has no such silent option, so it fails loudly.
 */
export function normalizeReplyAudience(
  audience: string | undefined,
  audienceReferences: readonly PromptAudienceReference[],
): string | undefined {
  if (audienceReferences.length === 0) return undefined;
  const trimmed = typeof audience === "string" ? audience.trim() : "";
  if (trimmed.length === 0) return undefined;
  return ensureReferencedAudience(trimmed, audienceReferences);
}

/**
 * Resolve the target audience for a worker's question.
 *
 * A question is blocking — the worker waits for an answer — so it must always
 * resolve to a real recipient. An unspecified audience defaults to the
 * originator; a named one is normalized to the canonical audience the current
 * instruction exposes. An explicit `originator` is always allowed even when the
 * instruction does not list it, since it is a built-in recipient.
 *
 * Any other unrecognized audience is rejected. Addressing a question to a
 * audience the instruction never named is a worker error; passing it onward
 * would only fail later with an opaque "no outbound handler" delivery error, so
 * we surface a clear, actionable failure here instead.
 */
export function normalizeQuestionAudience(
  audience: string | undefined,
  audienceReferences: readonly PromptAudienceReference[],
): string {
  if (!audience) return ORIGINATOR_AUDIENCE;
  const normalized = ensureReferencedAudience(audience, audienceReferences);
  if (normalized) return normalized;
  if (audience === ORIGINATOR_AUDIENCE) return ORIGINATOR_AUDIENCE;
  const markers = [...new Set(audienceReferences.map((ref) => ref.marker))];
  const options =
    markers.length > 0
      ? ` Name one of: ${markers.join(", ")}, or omit it to address the originator.`
      : " Omit the audience to address the originator.";
  throw new Error(
    `Question audience ${JSON.stringify(audience)} is not named by the current instruction.${options}`,
  );
}

/**
 * Resolve the target audience for a question that must address a named
 * non-originator audience. Claude uses this for its managed `ask_audience`
 * tool because native `AskUserQuestion` handles structured originator questions.
 */
export function normalizeNonOriginatorQuestionAudience(
  audience: string,
  audienceReferences: readonly PromptAudienceReference[],
): string {
  const trimmed = audience.trim();
  const normalized = ensureReferencedAudience(trimmed, audienceReferences);
  if (normalized && normalized !== ORIGINATOR_AUDIENCE) return normalized;
  const audiences = [
    ...new Set(
      audienceReferences
        .map((ref) => ref.audience)
        .filter((value) => value !== ORIGINATOR_AUDIENCE),
    ),
  ];
  const options =
    audiences.length > 0
      ? ` Name one of: ${audiences.join(", ")}.`
      : " The current instruction names no non-originator audience.";
  throw new Error(
    `Question audience ${JSON.stringify(audience)} must name a non-originator audience from the current instruction.${options}`,
  );
}

function isNonEmptyString(value: unknown): value is OutboundCause {
  return typeof value === "string" && value.trim().length > 0;
}
