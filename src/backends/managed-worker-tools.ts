import { randomUUID } from "node:crypto";
import { isAbsolute, normalize, resolve } from "node:path";

import type { ObservationGroupReport, ObservationReport } from "@elem-app/arc/runtime";
import { isPrimitiveArrayValue, type PrimitiveValue } from "@elem-app/arc/types";
import * as z from "zod/v4";

import type { ArcadeLogger } from "../logging.js";
import type { PromptAudienceReference } from "../service/semantic-text-renderer.js";
import { isRecord } from "../service/utils.js";
import type { ArcRunId } from "../types/core.js";
import type { OutboundQuestionFormContent } from "../types/messaging.js";
import type {
  OutboundMessageInput,
  PermissionVerdict,
  RoutineDiagnostics,
  RoutineEffects,
  RoutineReport,
  ToolEventError,
  ToolEventInput,
} from "../types/routine.js";
import type { SemanticRequest, Task } from "../types/task.js";
import type { BackendName } from "../types/worker-slot.js";

type SemanticReport = NonNullable<
  Extract<RoutineReport, { outcome: "completed" }>["semantic"]
>;

/** Arcade-owned tool ids exposed to managed SDK workers. */
export const OUTBOUND_TOOL_NAME = "emit_outbound";
export const DISCUSS_TOOL_NAME = "discuss";
export const ASK_AUDIENCE_TOOL_NAME = "ask_audience";
export const REPORT_TOOL_NAME = "report";

/** Fixed system-prompt policy for managed workers that expose audience tools. */
export const WORKER_INTERACTION_SYSTEM_PROMPT = [
  "You are a managed worker executing one assigned task.",
  "",
  "The current user message separates task content from execution guidance:",
  "",
  "- Treat <instruction>, when present, as the complete authority for what work the assignment requires.",
  "- Treat <semantic-requests>, when present, as the values the assignment must resolve.",
  "- Treat <active-instruction> as reference context for <semantic-requests>, not an assignment to execute. In postcheck, its instruction has already been applied; evaluate the requested values without repeating its work or audience interactions.",
  "- Treat <rules> as the execution contract for performing that work. Rules constrain execution; they do not introduce additional work.",
  "- Apply <rules> while carrying out the task content. Do not infer additional work from surrounding workflow context, role expertise, or related files.",
  "",
  "Audience interaction:",
  "",
  "- Follow every explicit requirement or prohibition in <instruction> concerning audience interaction.",
  "- Plain assistant text is private worker-session content and is not delivered to an audience.",
  "- For each audience interaction, determine what input <instruction> requires, then choose the matching interaction tool:",
  "  - No audience input is required: use emit_outbound for one-way delivery.",
  "  - Input must be captured and validated structurally: use ask_audience or the provider-native structured audience tool identified in <rules>.",
  "  - Input is required without structural constraints: use discuss.",
  "- Use emit_outbound only when <instruction> requires delivering content to an audience.",
  "- Delivery and input collection are separate obligations. When <instruction> requires both, perform both.",
  "- Audience-input tools return the audience's answer as their tool result. An input obligation is satisfied when that result is received.",
  "",
  "Completion:",
  "",
  '- When every obligation in the current task-content block has been satisfied, call report with outcome "completed".',
  '- If an error makes the assigned work impossible to complete, call report with error "failed" and describe the error.',
].join("\n");

type ToolEventSink = {
  logToolEvent(event: ToolEventInput): Promise<void>;
};

export class ToolFailure extends Error {
  readonly code: ToolEventError["code"];
  readonly detail?: unknown;

  constructor(code: ToolEventError["code"], message: string, detail?: unknown) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export async function runTool<T>(
  ctx: ToolEventSink,
  input: {
    toolName: string;
    toolCallId?: string;
    run: (
      toolCallId: string,
    ) => Promise<{ value: T; outcome?: ToolEventInput["outcome"] }>;
  },
): Promise<T> {
  const toolCallId = input.toolCallId ?? randomUUID();
  // Between-tool pause is intentionally disabled here. To reinstate
  // it safely the run must halt AFTER a tool result is committed and BEFORE the
  // next model turn, so the resumed session/response transcript has no dangling
  // tool call (which the model would not re-issue, silently dropping its effect).
  // A thrown error is swallowed by the SDK tool layer; a blunt AbortController can
  // land mid-step and drop a tool call. The viable path is the SDK's own
  // cooperative interrupt in streaming mode (Claude `query.interrupt()` / OpenAI
  // streamed-run cancel) plus session/responseId resume — the same mechanism CLIs
  // use for Esc-to-stop. Pause is still honored at the routine boundary in
  // WorkerHubService.
  await ctx.logToolEvent({
    kind: "tool:started",
    toolCallId,
    toolName: input.toolName,
  });
  try {
    const result = await input.run(toolCallId);
    await ctx.logToolEvent({
      kind: "tool:finished",
      toolCallId,
      toolName: input.toolName,
      ...(result.outcome !== undefined ? { outcome: result.outcome } : {}),
    });
    return result.value;
  } catch (error) {
    await ctx.logToolEvent({
      kind: "tool:failed",
      toolCallId,
      toolName: input.toolName,
      error: normalizeToolError(error),
    });
    throw error;
  }
}

export function invalidToolInputError(label: string, error: unknown): Error {
  return new ToolFailure(
    "invalid-input",
    `${label}: ${error instanceof Error ? error.message : String(error)}`,
    error,
  );
}

function normalizeToolError(error: unknown): ToolEventError {
  if (error instanceof ToolFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    };
  }
  return {
    code: "execution-failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Per-execution context bound to managed worker tools. Backend adapters resolve
 * each provider tool call into this context before invoking shared behavior.
 */
export type ManagedWorkerToolContext = {
  arcRunId: ArcRunId;
  routineId: string;
  role: string;
  backend: BackendName;
  sessionKey: string;
  task: Task;
  outboundAudienceReferences: readonly PromptAudienceReference[];
  diagnostics: RoutineDiagnostics;
  cwd: string;
  workspacePath?: string;
  /** Emit an outbound message through the backend's hub emit channel. */
  emit: RoutineEffects["emit"];
  /** Append an originator-visible tool event for this routine. */
  logToolEvent: RoutineEffects["logToolEvent"];
  /** Resolve the worker's final report. */
  resolveReport: (report: RoutineReport) => void;
  /** Escalate a permission request through the routine-owned hub effect. */
  requestPermission: RoutineEffects["requestPermission"];
  /**
   * Remembered grants for this `(arcRunId, sessionKey)` pair. Backends share
   * the same array across routines so an `allow_this_run` verdict on one
   * routine satisfies later routines.
   */
  grants: PermissionGrant[];
};

/**
 * Effective shell invocation, used to discriminate command-tool grants. Two
 * invocations are the same permission only when every field matches, because
 * behavior depends on the directory and shell flags, not just the command text.
 */
export type ExecScope = {
  command: string;
  workdir?: string;
  shell?: string;
  login?: boolean;
  tty?: boolean;
};

/** Remembered permission grant for the run. */
export type PermissionGrant = {
  toolName: string;
  pathPrefix?: string;
  command?: ExecScope;
};

export function normalizeRoutineReportInput(raw: unknown, task: Task): unknown {
  if (!isRecord(raw) || raw.outcome !== "completed" || !("semantic" in raw)) {
    return raw;
  }

  const parsedSemantic =
    typeof raw.semantic === "string"
      ? parseLooseJson(raw.semantic)
      : raw.semantic;
  const semantic = normalizeSemanticReport(parsedSemantic, task);
  return semantic ? { ...raw, semantic } : { ...raw, semantic: parsedSemantic };
}

function normalizeSemanticReport(
  raw: unknown,
  task: Task,
): SemanticReport | undefined {
  if (!isRecord(raw)) return undefined;

  const requests = task.kind === "semantic" ? task.requests : [];
  const byTool = new Map(
    requests.map((request) => [request.tool.name, request]),
  );
  const byId = new Map(requests.map((request) => [request.briefId, request]));
  const judgments: Record<string, boolean> = {};
  const observations: Record<
    string,
    ObservationReport | ObservationGroupReport
  > = {};

  const addJudgment = (id: string, value: unknown): void => {
    const bool = booleanValue(value);
    if (bool === undefined) return;
    judgments[id] = bool;
  };
  const addObservation = (id: string, value: unknown): void => {
    const observation = observationValue(value);
    if (!observation) return;
    observations[id] = observation;
  };
  const addObservationGroup = (
    id: string,
    request: Extract<SemanticRequest, { kind: "observation-group" }>,
    value: unknown,
  ): void => {
    const group = observationGroupValue(request, value);
    if (!group) return;
    observations[id] = group;
  };
  // Route a matched observation request to the single or grouped parser so a
  // grouped brief always yields an `ObservationGroupReport`.
  const addObservationFor = (
    request: SemanticRequest | undefined,
    id: string,
    value: unknown,
  ): void => {
    if (request?.kind === "observation-group") {
      addObservationGroup(id, request, value);
    } else {
      addObservation(id, value);
    }
  };

  if (isRecord(raw.judgments)) {
    for (const [key, value] of Object.entries(raw.judgments)) {
      const request = byTool.get(key) ?? byId.get(key);
      addJudgment(request?.briefId ?? key, value);
    }
  }
  if (Array.isArray(raw.judgments)) {
    for (const item of raw.judgments) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      const request = byTool.get(item.id) ?? byId.get(item.id);
      addJudgment(request?.briefId ?? item.id, item.value);
    }
  }
  if (isRecord(raw.observations)) {
    for (const [key, value] of Object.entries(raw.observations)) {
      const request = byTool.get(key) ?? byId.get(key);
      addObservationFor(request, request?.briefId ?? key, value);
    }
  }
  if (Array.isArray(raw.observations)) {
    for (const item of raw.observations) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      const request = byTool.get(item.id) ?? byId.get(item.id);
      addObservationFor(request, request?.briefId ?? item.id, item);
    }
  }

  if (typeof raw.requestId === "string" && isRecord(raw.arguments)) {
    const request = byId.get(raw.requestId);
    if (request?.kind === "observation-group") {
      addObservationGroup(raw.requestId, request, raw.arguments);
    } else if (request?.kind === "observation") {
      addObservation(raw.requestId, raw.arguments);
    } else if ("value" in raw.arguments) {
      addJudgment(raw.requestId, raw.arguments.value);
    }
  }

  for (const [key, value] of Object.entries(raw)) {
    const request = byTool.get(key) ?? byId.get(key);
    if (request?.kind === "judgment") addJudgment(request.briefId, value);
    if (
      request?.kind === "observation" ||
      request?.kind === "observation-group"
    )
      addObservationFor(request, request.briefId, value);
  }

  const judgmentRequests = requests.filter(
    (request) => request.kind === "judgment",
  );
  const observationRequests = requests.filter(
    (request) => request.kind === "observation",
  );
  if ("value" in raw && judgmentRequests.length === 1) {
    addJudgment(judgmentRequests[0]!.briefId, raw.value);
  }
  if ("status" in raw && observationRequests.length === 1) {
    addObservation(observationRequests[0]!.briefId, raw);
  }

  const semantic: SemanticReport = {};
  if (Object.keys(judgments).length > 0) semantic.judgments = judgments;
  if (Object.keys(observations).length > 0)
    semantic.observations = observations;
  return Object.keys(semantic).length > 0 ? semantic : undefined;
}

function booleanValue(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (isRecord(raw) && typeof raw.value === "boolean") return raw.value;
  return undefined;
}

function observationValue(raw: unknown):
  | {
      status: "resolved" | "unknown" | "needs-user";
      value?: PrimitiveValue | PrimitiveValue[];
    }
  | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    raw.status !== "resolved" &&
    raw.status !== "unknown" &&
    raw.status !== "needs-user"
  ) {
    return undefined;
  }
  const value = "value" in raw ? observedValue(raw.value) : undefined;
  if ("value" in raw && value === undefined) return undefined;
  return value === undefined
    ? { status: raw.status }
    : { status: raw.status, value };
}

/**
 * Parse a grouped observation tool-call into an `ObservationGroupReport`.
 *
 * The per-cell answers arrive either directly on the tool-call object (one
 * property per cell, matching the group's tool schema) or nested under a
 * `fields` record. The group is atomic: the report must address every field of
 * the brief, so a call that omits or malforms any field yields `undefined`,
 * leaving the group unresolved for the requiredness check to re-ask.
 */
function observationGroupValue(
  request: Extract<SemanticRequest, { kind: "observation-group" }>,
  raw: unknown,
): ObservationGroupReport | undefined {
  if (!isRecord(raw)) return undefined;
  const source = isRecord(raw.fields) ? raw.fields : raw;
  const fields: ObservationGroupReport["fields"] = {};
  for (const field of request.fields) {
    const observation = observationValue(source[field.cell]);
    if (!observation) return undefined;
    fields[field.cell] = observation;
  }
  return { fields };
}

/**
 * An observed value reported by a worker: a scalar cell's primitive, or an
 * array cell's ordered primitive list. A list whose members are not all
 * primitives is malformed and yields `undefined`, leaving the observation
 * unresolved rather than committing a partial list.
 */
function observedValue(
  raw: unknown,
): PrimitiveValue | PrimitiveValue[] | undefined {
  if (Array.isArray(raw)) {
    return isPrimitiveArrayValue(raw) ? raw : undefined;
  }
  return primitiveValue(raw);
}

function primitiveValue(raw: unknown): PrimitiveValue | undefined {
  return typeof raw === "string" ||
    typeof raw === "number" ||
    typeof raw === "boolean"
    ? raw
    : undefined;
}

function parseLooseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const WORKSPACE_FAST_PATH_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "NotebookEdit",
]);

function fastPathDecision(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ManagedWorkerToolContext,
): { reason: string } | undefined {
  if (toolName.startsWith("mcp__")) return undefined;
  if (!WORKSPACE_FAST_PATH_TOOLS.has(toolName)) return undefined;
  const paths = extractAllPaths(toolName, input);
  if (paths.length === 0) return undefined;
  if (!ctx.workspacePath) return undefined;
  const roots = [normalize(ctx.workspacePath)];
  for (const path of paths) {
    const normalized = normalizeRequestedPath(path, ctx);
    if (!isWithinRoots(normalized, roots)) return undefined;
  }
  return { reason: "workspace-fast-path" };
}

function extractAllPaths(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  const paths: string[] = [];
  if (toolName === "MultiEdit") {
    const filePath = input["file_path"];
    if (typeof filePath === "string") paths.push(filePath);
  } else if (toolName === "Glob" || toolName === "Grep" || toolName === "LS") {
    const pathArg = input["path"];
    if (typeof pathArg === "string") paths.push(pathArg);
  } else {
    const filePath = input["file_path"] ?? input["notebook_path"];
    if (typeof filePath === "string") paths.push(filePath);
  }
  return paths;
}

function extractPrimaryPath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const paths = extractAllPaths(toolName, input);
  return paths[0];
}

function extractPrimaryNormalizedPath(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ManagedWorkerToolContext,
): string | undefined {
  const path = extractPrimaryPath(toolName, input);
  return path ? normalizeRequestedPath(path, ctx) : undefined;
}

function normalizeRequestedPath(
  path: string,
  ctx: ManagedWorkerToolContext,
): string {
  return normalize(isAbsolute(path) ? path : resolve(ctx.cwd, path));
}

function isWithinRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function grantMatches(
  grant: PermissionGrant,
  toolName: string,
  input: Record<string, unknown>,
  ctx: ManagedWorkerToolContext,
): boolean {
  if (grant.toolName !== toolName) return false;
  if (grant.command !== undefined) {
    const scope = execScope(toolName, input, ctx);
    return scope !== undefined && execScopesEqual(grant.command, scope);
  }
  if (!grant.pathPrefix) return true;
  const path = extractPrimaryNormalizedPath(toolName, input, ctx);
  if (!path) return false;
  return path === grant.pathPrefix || path.startsWith(`${grant.pathPrefix}/`);
}

/**
 * Tools whose grants are discriminated by the exact shell invocation rather than
 * a path. Spans both backends: Claude `Bash` and the OpenAI sandbox
 * `exec_command`.
 */
const COMMAND_SCOPED_TOOLS = new Set(["Bash", "exec_command"]);

/**
 * True for tools whose grants are scoped to the exact command. Backends use this
 * to keep Arcade's command-scoped grant authoritative — a backend must not let
 * its SDK remember a blanket per-tool permission for these, or the per-command
 * grant would be bypassed.
 */
export function isCommandScopedPermissionTool(toolName: string): boolean {
  return COMMAND_SCOPED_TOOLS.has(toolName);
}

/**
 * Gated tools that carry no safe grant discriminator, so `allow_this_run`
 * degrades to allow-once: every invocation re-escalates rather than recording a
 * blanket per-tool grant.
 */
const NON_GRANTABLE_TOOLS = new Set(["write_stdin"]);

function execScope(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ManagedWorkerToolContext,
): ExecScope | undefined {
  if (toolName === "Bash") {
    const command = input["command"];
    return typeof command === "string"
      ? { command: command.trim() }
      : undefined;
  }
  if (toolName === "exec_command") {
    const command = input["cmd"];
    if (typeof command !== "string") return undefined;
    const workdir = input["workdir"];
    const shell = input["shell"];
    return {
      command: command.trim(),
      workdir: normalizeWorkdir(
        typeof workdir === "string" ? workdir : undefined,
        ctx,
      ),
      shell: typeof shell === "string" ? shell : undefined,
      login: input["login"] !== false,
      tty: input["tty"] === true,
    };
  }
  return undefined;
}

/** Canonicalize the working directory so omitted and explicit cwd compare equal. */
function normalizeWorkdir(
  workdir: string | undefined,
  ctx: ManagedWorkerToolContext,
): string {
  return normalizeRequestedPath(workdir ?? ".", ctx);
}

function execScopesEqual(a: ExecScope, b: ExecScope): boolean {
  return (
    a.command === b.command &&
    a.workdir === b.workdir &&
    a.shell === b.shell &&
    a.login === b.login &&
    a.tty === b.tty
  );
}

/**
 * Build the grant to remember for an `allow_this_run` verdict, or `undefined`
 * when the tool has no safe discriminator (so the verdict allows once without
 * recording a reusable grant).
 */
function buildPermissionGrant(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ManagedWorkerToolContext,
): PermissionGrant | undefined {
  if (COMMAND_SCOPED_TOOLS.has(toolName)) {
    const command = execScope(toolName, input, ctx);
    return command ? { toolName, command } : undefined;
  }
  if (NON_GRANTABLE_TOOLS.has(toolName)) return undefined;
  return {
    toolName,
    pathPrefix: extractPrimaryNormalizedPath(toolName, input, ctx),
  };
}

async function escalate(
  ctx: ManagedWorkerToolContext,
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  logger: ArcadeLogger,
): Promise<PermissionVerdict> {
  try {
    const verdict = await ctx.requestPermission({
      toolCallId,
      toolName,
      input,
    });
    logger.info("backend.worker_tools.permission_resolved", {
      toolCallId,
      decision: verdict.decision,
    });
    return verdict;
  } catch (error) {
    throw new ToolFailure(
      "surface-failed",
      `Failed to surface permission ask: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

const QuestionFormQuestionSchema = z.strictObject({
  question: z.string(),
  header: z
    .string()
    .describe(
      "Short label for this question. Use a unique header for each question in this form.",
    ),
  options: z
    .array(
      z.object({
        label: z.string(),
        description: z.string(),
        preview: z.string().optional(),
      }),
    )
    .min(2)
    .max(4),
  multiSelect: z.boolean(),
});

const AudienceInputSchema = z
  .string()
  .trim()
  .min(1)
  .describe("Audience reference whose response is awaited.");

/** Canonical input contract for a one-way outbound message. */
export const EmitOutboundInputSchema = z.strictObject({
  audience: z
    .string()
    .trim()
    .min(1)
    .describe("Audience reference named by the current instruction."),
  content: z.string().describe("User-visible message content."),
});

/** Canonical input contract for the freeform discussion tool. */
export const DiscussInputSchema = z.strictObject({
  audience: z.optional(AudienceInputSchema),
  question: z.optional(
    z
      .string()
      .trim()
      .min(1)
      .describe(
        "Optional freeform discussion prompt; omit when audience-visible context already establishes what response is awaited.",
      ),
  ),
});

/** Canonical input contract for the structured audience-question tool. */
export const AskAudienceInputSchema = z.strictObject({
  audience: z.optional(AudienceInputSchema),
  questions: z
    .array(QuestionFormQuestionSchema)
    .min(1)
    .max(4)
    .describe("Structured questions with predefined answer options."),
});

type QuestionFormQuestion = z.infer<typeof QuestionFormQuestionSchema>;
type QuestionFormAnswers = Record<string, string | string[]>;
type ParsedAnswerPayload = QuestionFormAnswers | string[] | undefined;

export function parseDiscussInput(raw: unknown) {
  return DiscussInputSchema.parse(raw);
}

export function parseAskAudienceInput(raw: unknown) {
  return AskAudienceInputSchema.parse(raw);
}

/** Adapt structured tool input into Arcade's connector-facing form contract. */
export function outboundQuestionForm(
  questions: readonly QuestionFormQuestion[],
): OutboundQuestionFormContent {
  return {
    kind: "question-form",
    questions: questions.map((question) => ({
      ...question,
      takesOtherAnswer: true,
    })),
  };
}

/** Normalize one correlated form answer into answers keyed by question text. */
export function answersForQuestionForm(
  questions: readonly QuestionFormQuestion[],
  answer: string,
): QuestionFormAnswers {
  const parsed = parseAnswerPayload(answer);
  assertAnswerPayloadMatchesQuestions(questions, parsed, answer);
  return Object.fromEntries(
    questions.map((question) => [
      question.question,
      answerValueForQuestion(question, questions, parsed, answer),
    ]),
  );
}

/** Emit one correlated worker question and require an answer payload. */
export async function emitWorkerQuestion(
  emit: RoutineEffects["emit"],
  toolCallId: string,
  outbound: OutboundMessageInput,
): Promise<string> {
  try {
    const answer = await emit({
      situation: {
        audience: outbound.situation.audience ?? "originator",
        cause: outbound.situation.cause,
      },
      content: outbound.content,
      metadata: { ...outbound.metadata, toolCallId },
    });
    if (answer === undefined) {
      throw new ToolFailure(
        "result-missing",
        "Question answer was not returned.",
      );
    }
    return answer;
  } catch (error) {
    if (error instanceof ToolFailure) throw error;
    throw new ToolFailure(
      "surface-failed",
      `Failed to surface question: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }
}

function answerValueForQuestion(
  question: QuestionFormQuestion,
  questions: readonly QuestionFormQuestion[],
  parsed: ParsedAnswerPayload,
  answer: string,
): string | string[] {
  if (Array.isArray(parsed)) {
    return questions.length === 1 ? parsed : answer;
  }
  return parsed?.[question.question] ?? parsed?.[question.header] ?? answer;
}

function assertAnswerPayloadMatchesQuestions(
  questions: readonly QuestionFormQuestion[],
  parsed: ParsedAnswerPayload,
  answer: string,
): void {
  if (questions.length === 1) return;
  if (parsed === undefined || Array.isArray(parsed)) {
    throw new ToolFailure(
      "result-invalid",
      "Multiple-question answers must be a JSON object keyed by question or header.",
      { answer },
    );
  }
  const missing = questions.filter(
    (question) =>
      parsed[question.question] === undefined &&
      parsed[question.header] === undefined,
  );
  if (missing.length > 0) {
    throw new ToolFailure(
      "result-invalid",
      "Question answer is missing one or more requested questions.",
      { missing: missing.map((question) => question.question), answer },
    );
  }
}

function parseAnswerPayload(answer: string): ParsedAnswerPayload {
  try {
    const parsed = JSON.parse(answer) as unknown;
    if (Array.isArray(parsed)) {
      const strings = parsed.filter(
        (item): item is string => typeof item === "string",
      );
      return strings.length === parsed.length ? strings : undefined;
    }
    if (!isRecord(parsed)) return undefined;
    const entries: [string, string | string[]][] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        entries.push([key, value]);
        continue;
      }
      if (Array.isArray(value)) {
        const strings = value.filter(
          (item): item is string => typeof item === "string",
        );
        if (strings.length === value.length) {
          entries.push([key, strings]);
        }
      }
    }
    return Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

/** Resolve one worker tool permission request using Arcade's shared policy. */
export async function resolveWorkerPermission(
  ctx: ManagedWorkerToolContext,
  askId: string,
  toolName: string,
  input: Record<string, unknown>,
  logger: ArcadeLogger,
): Promise<PermissionVerdict> {
  return runTool(ctx, {
    toolName,
    toolCallId: askId,
    run: async (toolCallId) => {
      await appendManagedWorkerToolDiagnostic(ctx, {
        kind: "request_permission",
        toolName,
        askId,
        input,
      });
      const fastPath = fastPathDecision(toolName, input, ctx);
      if (fastPath) {
        await appendManagedWorkerToolDiagnostic(ctx, {
          kind: "request_permission.result",
          askId,
          decision: "allow",
          reason: fastPath.reason,
        });
        return {
          value: { decision: "allow", updatedInput: input },
          outcome: "allow",
        };
      }
      const grant = ctx.grants.find((g) =>
        grantMatches(g, toolName, input, ctx),
      );
      if (grant) {
        await appendManagedWorkerToolDiagnostic(ctx, {
          kind: "request_permission.result",
          askId,
          decision: "allow",
          reason: "remembered-grant",
        });
        return {
          value: { decision: "allow", updatedInput: input },
          outcome: "allow",
        };
      }
      const verdict = await escalate(ctx, toolCallId, toolName, input, logger);
      if (verdict.decision === "allow_this_run") {
        const grant = buildPermissionGrant(toolName, input, ctx);
        if (grant) ctx.grants.push(grant);
      }
      await appendManagedWorkerToolDiagnostic(ctx, {
        kind: "request_permission.result",
        askId,
        decision: verdict.decision,
      });
      return { value: verdict, outcome: verdict.decision };
    },
  });
}

/** Append provider-neutral managed-worker tool diagnostics. */
export async function appendManagedWorkerToolDiagnostic(
  ctx: ManagedWorkerToolContext,
  event: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.diagnostics.appendJsonl("worker-tool-events", {
      at: new Date().toISOString(),
      ...event,
    });
  } catch {
    // Diagnostics file; ignore write failures.
  }
}
