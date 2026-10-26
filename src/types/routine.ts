import type { ArcRef } from "@elem-app/arc/runtime";
import { isArcRef } from "@elem-app/arc/runtime";
import type { PrimitiveValue } from "@elem-app/arc/types";
import { z } from "zod";

import type { ArcRunId } from "./core.js";
import { JsonValueSchema } from "./json.js";
import type { OutboundMessage, OutboundSituation } from "./messaging.js";
import type { Task } from "./task.js";
import type { RoutineTokenUsage } from "./token-usage.js";

/** Resume instruction passed from routine control to an arbitrary worker. */
export type RoutineResumeContext =
  | {
      /** Re-run a routine that paused before its worker started. */
      delivery: "fresh-start";
    }
  | {
      /** Render continuation text into the worker's own context mechanism. */
      delivery: "rendered-context";
      message: string;
    };

/** Hub-owned routine identity and detached task snapshot. */
export type RoutineDescriptor = {
  id: string;
  arcRunId: ArcRunId;
  role: string;
  contextKey: string;
  task: Task;
};

/** Context supplied to one worker routine. */
export type RoutineContext = {
  /**
   * Existing absolute host directory supplied and managed by the worker hub.
   * Trigger work uses the Arcade process directory; action work uses the run's
   * real workspace. Default logical artifact paths resolve here.
   *
   * A backend cwd override must name a usable directory supplied and managed by
   * its configuration owner.
   */
  workspacePath: string;
  /** Absolute host directories keyed by logical artifact prefix. */
  workspaceBundle: Readonly<Record<string, string>>;
  /**
   * Routine-control continuation supplied when a paused routine is resumed.
   * This is distinct from joining an existing Arc run through run-choice.
   */
  routineResume?: RoutineResumeContext;
};

/** Backend-facing writer for one routine's diagnostic artifacts. */
export type RoutineDiagnostics = {
  /** Write a full UTF-8 text snapshot selected by logical handle. */
  writeText(handle: string, content: string): Promise<void>;
  /** Write a pretty JSON snapshot selected by logical handle. */
  writeJson(handle: string, value: unknown): Promise<void>;
  /** Append UTF-8 text selected by logical handle. */
  appendText(handle: string, chunk: string): Promise<void>;
  /** Append one JSON object line selected by logical handle. */
  appendJsonl(handle: string, value: unknown): Promise<void>;
};

/** Error attached to a worker tool activity event. */
export type ToolEventError = {
  code:
    | "invalid-input"
    | "surface-failed"
    | "result-missing"
    | "result-invalid"
    | "execution-failed"
    | "interrupted";
  message: string;
  detail?: unknown;
};

/** Worker-authored portion of one Arcade tool activity event. */
export type ToolEventInput = {
  kind: `tool:${"started" | "finished" | "failed"}`;
  toolCallId: string;
  toolName: string;
  outcome?:
    | "sent"
    | "answered"
    | "allow"
    | "deny"
    | "allow_this_run"
    | "ignored";
  error?: ToolEventError;
};

/** Cooperative control of one routine, with cancellation taking precedence. */
export type RoutineSignal = { kind: "pause" } | { kind: "cancel" };

/** Routine-scoped effects owned by `WorkerHubService`. */
export type RoutineEffects = {
  /**
   * Emit user-visible content through Arcade's outbound situation dispatch.
   *
   * The host stamps `situation.role` from the originating task; handlers
   * supply only `audience` (optional; defaults to `originator`) and `cause`.
   *
   * Resolution depends on `cause`. A `question` is a blocking request: the
   * returned promise stays pending until the addressed party replies, then
   * resolves to the answer text (the inbound reply's `content`). Every other
   * cause is fire-and-forget and resolves to `undefined` once the message is
   * dispatched. The wait is in-memory and untimed, so an unanswered question
   * parks until the run ends.
   */
  emit: (message: OutboundMessageInput) => Promise<string | void>;
  /** Append an originator-visible tool activity event for this routine. */
  logToolEvent: (event: ToolEventInput) => Promise<void>;
  /** Append an additive token-usage delta for this routine. */
  recordTokenUsage: (tokenUsage: RoutineTokenUsage) => Promise<void>;
  /**
   * Poll at a safe boundary for resumable pause or permanent supersession.
   * A superseded routine observes cancellation even when its run is paused.
   */
  checkSignal: () => Promise<RoutineSignal | undefined>;
  /** Ask the hub-owned permission approver using an internal routine ask id. */
  requestPermission: (request: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<PermissionVerdict>;
};

/** Input accepted by routine effects before Arcade stamps role and run id. */
export type OutboundMessageInput = {
  situation: {
    /** Symbolic audience. Defaults to `originator` when omitted. */
    audience?: OutboundSituation["audience"];
    /** Why this outbound message is being emitted. */
    cause: OutboundSituation["cause"];
  };
  /** User-visible outbound payload. */
  content: OutboundMessage["content"];
  /** Optional connector or resolver metadata. */
  metadata?: OutboundMessage["metadata"];
};

/** Verdict returned by an activator for a worker permission request. */
export type PermissionVerdict = {
  /**
   * `allow` approves this request once. `deny` rejects it. `allow_this_run`
   * approves this request and matching later requests in the same run.
   */
  decision: "allow" | "deny" | "allow_this_run";
  /** Optional replacement tool input to use when the request is allowed. */
  updatedInput?: Record<string, unknown>;
  /** Optional human-readable explanation returned to the worker. */
  message?: string;
};

/** Complete capability boundary passed to `Worker.run(...)`. */
export type RoutineInput = {
  routine: RoutineDescriptor;
  context: RoutineContext;
  effects: RoutineEffects;
  diagnostics: RoutineDiagnostics;
};

const PrimitiveValueSchema: z.ZodType<PrimitiveValue> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
]);
const ObservedValueSchema = z.union([
  PrimitiveValueSchema,
  z.array(PrimitiveValueSchema),
]);
const ObservationOutcomeSchema = z
  .strictObject({
    status: z.enum(["resolved", "unknown", "needs-user"]),
    value: ObservedValueSchema.optional(),
  })
  .superRefine(rejectExplicitUndefined("value"));
const ObservationGroupSchema = z.strictObject({
  fields: z.record(z.string(), ObservationOutcomeSchema),
});
const SemanticReportSchema = z
  .strictObject({
    judgments: z.record(z.string(), z.boolean()).optional(),
    observations: z
      .record(
        z.string(),
        z.union([ObservationOutcomeSchema, ObservationGroupSchema]),
      )
      .optional(),
    preferredMatch: z
      .custom<ArcRef>(isArcRefValue, "Invalid Arc reference.")
      .optional(),
  })
  .superRefine(
    rejectExplicitUndefined("judgments", "observations", "preferredMatch"),
  );
const CapacityReasonSchema = z.strictObject({
  reason: z.enum([
    "api rate limit",
    "token rate limit",
    "token usage limit",
    "provider overloaded",
  ]),
  provider: z.string().min(1),
  message: z.string(),
  retryAfterMs: z.number().nonnegative().optional(),
});
const TransportReasonSchema = z.strictObject({
  reason: z.enum(["sdk timeout", "network timeout", "connection reset"]),
  message: z.string(),
});

const CompletedReportShape = {
  outcome: z.literal("completed"),
  semantic: SemanticReportSchema.optional(),
};
const DispositionReportShape = { outcome: z.literal("disposition") };
const FailedReportShape = {
  error: z.literal("failed"),
  code: z.string().min(1).default("agent-failed"),
  message: z.string(),
};
const BackendDetailsShape = {
  backendDetails: JsonValueSchema.optional(),
};

const AgentCompletedReportSchema = z
  .strictObject(CompletedReportShape)
  .superRefine(rejectExplicitUndefined("semantic"));
const AgentFailedReportSchema = z.strictObject(FailedReportShape);

/** Zod schema for the report subset an agent-facing tool or parser may author. */
export const AgentRoutineReportSchema = z.union([
  AgentCompletedReportSchema,
  AgentFailedReportSchema,
]);

/**
 * Agent-authored report subset. Agents can complete or report a permanent
 * failure; dispositions, backend control outcomes, and evidence are worker-owned.
 */
export type AgentRoutineReport =
  | ReportVariant<typeof AgentCompletedReportSchema>
  | ReportVariant<typeof AgentFailedReportSchema>;

const CompletedRoutineReportSchema = z
  .strictObject({ ...CompletedReportShape, ...BackendDetailsShape })
  .superRefine(rejectExplicitUndefined("semantic", "backendDetails"));
const DeflectRoutineReportSchema = z
  .strictObject({
    ...DispositionReportShape,
    deflect: z.strictObject({}),
    ...BackendDetailsShape,
  })
  .superRefine(rejectExplicitUndefined("backendDetails"));
const InterruptRoutineReportSchema = z
  .strictObject({
    ...DispositionReportShape,
    interrupt: z
      .strictObject({
        id: z.string().min(1),
        reason: z.string().optional(),
      })
      .superRefine(rejectExplicitUndefined("reason")),
    ...BackendDetailsShape,
  })
  .superRefine(rejectExplicitUndefined("backendDetails"));
const FailedRoutineReportSchema = z
  .strictObject({ ...FailedReportShape, ...BackendDetailsShape })
  .superRefine(rejectExplicitUndefined("backendDetails"));
const PausedRoutineReportSchema = z
  .strictObject({ suspension: z.literal("paused"), ...BackendDetailsShape })
  .superRefine(rejectExplicitUndefined("backendDetails"));
const CancelledRoutineReportSchema = z
  .strictObject({
    cancellation: z.literal("superseded"),
    ...BackendDetailsShape,
  })
  .superRefine(rejectExplicitUndefined("backendDetails"));
const CapacityLimitedRoutineReportSchema = z
  .strictObject({
    suspension: z.literal("capacity-limited"),
    reason: CapacityReasonSchema,
    ...BackendDetailsShape,
  })
  .superRefine(rejectExplicitUndefined("backendDetails"));
const TransportLostRoutineReportSchema = z
  .strictObject({
    suspension: z.literal("transport-lost"),
    reason: TransportReasonSchema,
    ...BackendDetailsShape,
  })
  .superRefine(rejectExplicitUndefined("backendDetails"));
const UnavailableRoutineReportSchema = z
  .strictObject({
    error: z.literal("unavailable"),
    code: z.string().min(1).default("worker-unavailable"),
    message: z.string(),
    ...BackendDetailsShape,
  })
  .superRefine(rejectExplicitUndefined("backendDetails"));

/** Zod schema for the complete structural result returned by `Worker.run(...)`. */
export const RoutineReportSchema = z.union([
  CompletedRoutineReportSchema,
  DeflectRoutineReportSchema,
  InterruptRoutineReportSchema,
  FailedRoutineReportSchema,
  PausedRoutineReportSchema,
  CancelledRoutineReportSchema,
  CapacityLimitedRoutineReportSchema,
  TransportLostRoutineReportSchema,
  UnavailableRoutineReportSchema,
]);

/**
 * Complete worker report protocol.
 *
 * Exactly one discriminator is present: `outcome` for a completed routine,
 * `suspension` for retained work that can continue, `cancellation` for
 * superseded work, or `error` for a failed or unavailable result.
 *
 * A completed routine either answers its task (`outcome: "completed"`) or
 * reports a disposition (`outcome: "disposition"`): exactly one of `deflect`
 * or `interrupt`. A disposition concludes the task's whole frontier rather
 * than answering the task, and is accepted only when listed in the task's
 * `allowedDispositions`. The run's resulting state remains Arc's decision.
 *
 * `backendDetails` is a patch over the routine's durable backend evidence:
 * omission retains the prior value, `null` clears it, and any other canonical
 * JSON value replaces it.
 */
export type RoutineReport =
  | ReportVariant<typeof CompletedRoutineReportSchema>
  | ReportVariant<typeof DeflectRoutineReportSchema>
  | ReportVariant<typeof InterruptRoutineReportSchema>
  | ReportVariant<typeof FailedRoutineReportSchema>
  | ReportVariant<typeof PausedRoutineReportSchema>
  | ReportVariant<typeof CapacityLimitedRoutineReportSchema>
  | ReportVariant<typeof TransportLostRoutineReportSchema>
  | ReportVariant<typeof CancelledRoutineReportSchema>
  | ReportVariant<typeof UnavailableRoutineReportSchema>;

/** Validate the complete `Worker.run(...)` result protocol. */
export function validateRoutineReport(
  value: unknown,
  label = "Routine report",
): RoutineReport {
  return parseSchema(RoutineReportSchema, value, label);
}

/** Validate only report variants that may be authored by an agent. */
export function validateAgentRoutineReport(
  value: unknown,
  label = "Agent routine report",
): AgentRoutineReport {
  return parseSchema(AgentRoutineReportSchema, value, label);
}

function parseSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
  throw new Error(`${label} failed validation: ${issues.join("; ")}`);
}

function rejectExplicitUndefined(...keys: string[]) {
  return (value: object, ctx: z.RefinementCtx): void => {
    for (const key of keys) {
      if (
        Object.prototype.hasOwnProperty.call(value, key) &&
        (value as Record<string, unknown>)[key] === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Explicit undefined is not part of the protocol.",
        });
      }
    }
  };
}

function isArcRefValue(value: unknown): value is ArcRef {
  return typeof value === "string" && isArcRef(value);
}

/** Every top-level field that selects or shapes a routine report variant. */
type ReportKey =
  | "outcome"
  | "suspension"
  | "cancellation"
  | "error"
  | "semantic"
  | "deflect"
  | "interrupt";

/**
 * One report variant, with each `ReportKey` it does not carry typed as an
 * absent `never`. Every variant then exposes every key, so callers can test
 * `report.error === "failed"` or `report.interrupt` on the whole union and
 * narrow by it.
 */
type ReportVariant<TSchema extends z.ZodType> = z.output<TSchema> & {
  [K in Exclude<ReportKey, keyof z.output<TSchema>>]?: never;
};
