import {
  createSdkMcpServer,
  query,
  startup,
  tool,
  type CanUseTool,
  type Options as ClaudeSdkOptions,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKUserMessageReplay,
  type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import * as z from "zod/v4";

import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import {
  INSTRUCTION_EXECUTION_BOUNDARY_RULES,
  renderActiveInstructionForPrompt,
  renderDialogPriming,
  renderInstructionAudienceReferencesForPrompt,
  renderInstructionTaskTextForPrompt,
  renderSemanticRequestForPrompt,
  semanticReportExample,
  xmlBlock,
} from "../service/task-renderer.js";
import { routineTokenUsageFromClaudeSdkMessages } from "../service/token-usage.js";
import {
  normalizeNonOriginatorQuestionAudience,
  normalizeQuestionAudience,
  normalizeReplyAudience,
  validateAgentRoutineReport,
} from "../service/utils.js";
import {
  defineBackend,
  type Backend,
  type Worker,
  type WorkerWarmupInput,
} from "../types/backend.js";
import type { ExternalWorkerTool } from "../types/external-worker-tool.js";
import type { JsonValue } from "../types/json.js";
import type {
  RoutineContext,
  RoutineDiagnostics,
  RoutineEffects,
  RoutineInput,
  RoutineReport,
  RoutineSignal,
} from "../types/routine.js";
import type { InstructionTask, SemanticTask, Task } from "../types/task.js";
import type { WorkerSlotKind } from "../types/worker-slot.js";
import { createWorkerSlotSchema } from "../types/worker-slot.js";
import {
  backendRoutine,
  providerFailureReport,
  withBackendDetails,
  type BackendRoutine,
} from "./backend-support.js";
import {
  createContinuityController,
  type ResolveClaudeContinuityIdentity,
} from "./continuity.js";
import {
  answersForQuestionForm,
  appendManagedWorkerToolDiagnostic,
  ASK_AUDIENCE_TOOL_NAME,
  AskAudienceInputSchema,
  DISCUSS_TOOL_NAME,
  DiscussInputSchema,
  EmitOutboundInputSchema,
  emitWorkerQuestion,
  invalidToolInputError,
  isCommandScopedPermissionTool,
  normalizeRoutineReportInput,
  OUTBOUND_TOOL_NAME,
  outboundQuestionForm,
  parseAskAudienceInput,
  parseDiscussInput,
  REPORT_TOOL_NAME,
  resolveWorkerPermission,
  runTool,
  ToolFailure,
  WORKER_INTERACTION_SYSTEM_PROMPT,
  type ManagedWorkerToolContext,
  type PermissionGrant,
} from "./managed-worker-tools.js";

export const DEFAULT_CLAUDE_SDK_MODEL = "claude-opus-4-7";
const DEFAULT_CLAUDE_SDK_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_SDK_THINKING = {
  type: "adaptive",
  display: "omitted",
} as const;
/** MCP server name registered by the Claude managed-worker adapter. */
const WORKER_MCP_SERVER_NAME = "arcade_internal";
const MISSING_REPORT_RECOVERY_PROMPT = [
  "Your previous worker turn ended without calling the required",
  `mcp__${WORKER_MCP_SERVER_NAME}__${REPORT_TOOL_NAME} tool.`,
  "Any assistant text you wrote remains private worker memory in this session.",
  "",
  "Continue the same assigned work:",
  "",
  `- If every obligation is complete, call mcp__${WORKER_MCP_SERVER_NAME}__${REPORT_TOOL_NAME}. For instruction work, pass exactly {"outcome":"completed"}. For semantic work, also include the required semantic object.`,
  "- If work remains, continue it before reporting completion.",
  "- If required audience input has not been received, follow the shared audience-interaction policy and continue after the interaction tool returns its result.",
  `- If an error makes the work impossible to complete, call mcp__${WORKER_MCP_SERVER_NAME}__${REPORT_TOOL_NAME} with error "failed" and include the error message.`,
  "",
  'Do not include code or message with outcome "completed". Do not add a plain assistant summary after the tool call.',
].join("\n");
const NATIVE_ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const SDK_PERMISSION_CONTROLLED_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
]);

/** Claude-private delivery into an already-live SDK session. */
type ClaudeSdkSessionResume = {
  delivery: "session-message";
  message: string;
};

type ManagedWorkerToolContextHolder = {
  current?: ManagedWorkerToolContext;
};

type ManagedWorkerToolContextSource =
  | ManagedWorkerToolContext
  | ManagedWorkerToolContextHolder;

function buildClaudeSdkPrompt(
  task: Task,
  context: RoutineContext,
  sessionResume: ClaudeSdkSessionResume | undefined,
  shouldPrimeDialog: boolean,
): string {
  if (sessionResume) return sessionResume.message;
  return task.kind === "instruction"
    ? buildInstructionPrompt(task, context, shouldPrimeDialog)
    : buildSemanticPrompt(task, context, shouldPrimeDialog);
}

function buildInstructionPrompt(
  task: InstructionTask,
  context: RoutineContext,
  shouldPrimeDialog: boolean,
): string {
  const rendered = renderInstructionTaskTextForPrompt(task, context, {
    kind: "host",
  });
  const { text, audienceReferences } = rendered;
  const parts = [
    `You are working as the "${task.role}" role.`,
    ...renderDialogPriming(task, shouldPrimeDialog),
    "",
    xmlBlock("instruction", text),
  ];
  if (Object.keys(task.cells).length > 0) {
    parts.push("", xmlBlock("cells", JSON.stringify(task.cells, null, 2)));
  }
  appendResumeMessage(parts, context);
  const rules = [
    "- Use workspace and Claude Code tools as needed.",
    ...INSTRUCTION_EXECUTION_BOUNDARY_RULES.map((rule) => `- ${rule}`),
  ];
  if (audienceReferences.length > 0) {
    rules.push(
      "",
      "Audience references:",
      ...audienceReferences.map((ref) => `- ${ref.marker} -> ${ref.audience}`),
      "",
      "Use the mapped audience value in audience-tool calls. Do not copy an audience marker into delivered content or question text.",
      `When the instruction requires delivery to an audience listed above, use mcp__${WORKER_MCP_SERVER_NAME}__${OUTBOUND_TOOL_NAME}. Plain assistant text does not deliver that content.`,
      "",
      "Claude tool routing:",
      `- Freeform audience input: mcp__${WORKER_MCP_SERVER_NAME}__${DISCUSS_TOOL_NAME}`,
      "- Structured originator input: AskUserQuestion",
      `- Structured input from a named non-originator audience: mcp__${WORKER_MCP_SERVER_NAME}__${ASK_AUDIENCE_TOOL_NAME}`,
      `- Final task report: mcp__${WORKER_MCP_SERVER_NAME}__${REPORT_TOOL_NAME}`,
    );
  } else {
    rules.push(
      "",
      "No audience references are available for this task. Keep one-way output private.",
    );
  }
  parts.push("", xmlBlock("rules", rules.join("\n")));
  return parts.join("\n");
}

function buildSemanticPrompt(
  task: SemanticTask,
  context: RoutineContext,
  shouldPrimeDialog: boolean,
): string {
  const parts = [
    `You are working as the "${task.role}" role.`,
    ...renderDialogPriming(task, shouldPrimeDialog),
    "",
    xmlBlock(
      "semantic-requests",
      JSON.stringify(
        task.requests.map((request) =>
          renderSemanticRequestForPrompt(request, context, { kind: "host" }),
        ),
        null,
        2,
      ),
    ),
  ];
  if (task.activeInstruction) {
    parts.push(
      "",
      xmlBlock(
        "active-instruction",
        JSON.stringify(
          renderActiveInstructionForPrompt(task.activeInstruction, context, {
            kind: "host",
          }),
          null,
          2,
        ),
      ),
    );
  }
  appendResumeMessage(parts, context);
  const rules = [
    `Resolve this ${task.stage} semantic work.`,
    "Use workspace and Claude Code tools as needed.",
    "Semantic report:",
    'Call report with outcome "completed" and a semantic object covering every request id.',
    "Put judgment answers under semantic.judgments as booleans keyed by request id.",
    "Put observation answers under semantic.observations as {status, value?} keyed by request id.",
    "A grouped observation id maps to {fields: {<cell>: {status, value?}}} instead, with an entry for every listed cell resolved together.",
    'Observation status is "resolved", "unknown", or "needs-user".',
    'Do not call report with bare {"outcome":"completed"} for semantic work.',
    "Example:",
    JSON.stringify({
      outcome: "completed",
      semantic: semanticReportExample(task),
    }),
  ];
  parts.push("", xmlBlock("rules", rules.join("\n")));
  return parts.join("\n");
}

function appendResumeMessage(parts: string[], context: RoutineContext): void {
  if (context.routineResume?.delivery !== "rendered-context") return;
  parts.push("", xmlBlock("resume-message", context.routineResume.message));
}

function sdkUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: text,
    },
    parent_tool_use_id: null,
  };
}

class AsyncSdkUserMessageQueue implements AsyncIterable<SDKUserMessage> {
  readonly #queue: SDKUserMessage[] = [];
  readonly #waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> =
    [];
  #closed = false;

  push(message: SDKUserMessage): void {
    if (this.#closed) {
      throw new Error("Cannot push to a closed Claude SDK input stream.");
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.#queue.push(message);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => this.#next(),
    };
  }

  #next(): Promise<IteratorResult<SDKUserMessage>> {
    const item = this.#queue.shift();
    if (item) return Promise.resolve({ done: false, value: item });
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolveNext) => {
      this.#waiters.push(resolveNext);
    });
  }
}

class ClaudeSdkLiveSession {
  readonly sessionKey: string;
  readonly cwd: string;
  readonly holder: ManagedWorkerToolContextHolder;
  readonly #abortController: AbortController;
  readonly #prompt: AsyncSdkUserMessageQueue;
  readonly #query: Query;
  readonly #iterator: AsyncIterator<SDKMessage>;
  #model: string;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  signal: RoutineSignal | undefined;
  owner?: Parameters<Worker["disposeRoutine"]>[0];
  lastUsedAt = Date.now();

  constructor(input: {
    sessionKey: string;
    cwd: string;
    holder: ManagedWorkerToolContextHolder;
    abortController: AbortController;
    prompt: AsyncSdkUserMessageQueue;
    query: Query;
    model: string;
  }) {
    this.sessionKey = input.sessionKey;
    this.cwd = input.cwd;
    this.holder = input.holder;
    this.#abortController = input.abortController;
    this.#prompt = input.prompt;
    this.#query = input.query;
    this.#iterator = input.query[Symbol.asyncIterator]();
    this.#model = input.model;
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  async setModel(model: string): Promise<void> {
    if (this.#model === model) return;
    await this.#query.setModel(model);
    this.#model = model;
  }

  async runPrompt(
    prompt: string,
    checkSignal: () => Promise<RoutineSignal | undefined>,
    onMessage: (message: SDKMessage) => Promise<void>,
  ): Promise<SDKMessage[]> {
    if (this.#closed) {
      throw new Error("Claude SDK session is closed.");
    }
    this.touch();
    this.signal = undefined;
    this.#prompt.push(sdkUserMessage(prompt));
    return this.#collectTurn(checkSignal, onMessage);
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#prompt.close();
    this.#abortController.abort();
    this.#query.close?.();
  }

  async #collectTurn(
    checkSignal: () => Promise<RoutineSignal | undefined>,
    onMessage: (message: SDKMessage) => Promise<void>,
  ): Promise<SDKMessage[]> {
    const messages: SDKMessage[] = [];
    while (true) {
      const next = await this.#iterator.next();
      if (next.done) break;
      messages.push(next.value);
      await onMessage(next.value);
      if (isClaudeToolResultBoundary(next.value)) {
        const signal = await checkSignal();
        if (!signal) continue;
        if (this.signal?.kind !== "cancel") this.signal = signal;
        // Best-effort: the interrupt is a control request whose outcome is
        // observed as the turn's result message on the next iteration, so a
        // rejection here is non-fatal — swallow it rather than leak an unhandled
        // rejection.
        void this.#query.interrupt().catch(() => undefined);
      }
      if (next.value.type === "result") break;
    }
    return messages;
  }
}

function isClaudeToolResultBoundary(message: SDKMessage): boolean {
  if (message.type !== "user") return false;
  if ((message as SDKUserMessageReplay).isReplay === true) return false;
  if (message.parent_tool_use_id !== null) return false;
  const content = message.message?.content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "tool_result",
    )
  );
}

function buildClaudeSdkMcpServer(
  ctx: ManagedWorkerToolContextSource,
  externalTools: readonly ExternalWorkerTool[],
) {
  return createSdkMcpServer({
    name: WORKER_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "Use these tools to send user-visible messages and report the final outcome of your assigned work.",
    tools: [
      tool(
        OUTBOUND_TOOL_NAME,
        'Deliver content to an audience named by the current instruction. The call returns {"ok":true} immediately and does not return an audience answer.',
        EmitOutboundInputSchema.shape,
        async ({ audience, content }) => {
          const currentCtx = currentManagedWorkerToolContext(ctx);
          return runTool(currentCtx, {
            toolName: OUTBOUND_TOOL_NAME,
            run: async (toolCallId) => {
              const targetAudience = normalizeReplyAudience(
                audience,
                currentCtx.outboundAudienceReferences,
              );
              if (targetAudience === undefined) {
                // Suppression is expected, not a failure. The worker should
                // receive a private success acknowledgement rather than a
                // delivery failure it may escalate into a failed routine.
                return {
                  value: jsonToolResult({ ok: true }),
                  outcome: "ignored",
                };
              }
              const situation = {
                audience: targetAudience,
                cause: "reply" as const,
              };
              await appendManagedWorkerToolDiagnostic(currentCtx, {
                kind: "emit_outbound",
                situation,
                contentLength: content.length,
              });
              try {
                await currentCtx.emit({
                  situation,
                  content,
                  metadata: { toolCallId },
                });
              } catch (error) {
                throw new ToolFailure(
                  "surface-failed",
                  `Failed to surface outbound message: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  error,
                );
              }
              return { value: jsonToolResult({ ok: true }), outcome: "sent" };
            },
          });
        },
      ),
      tool(
        DISCUSS_TOOL_NAME,
        'Collect freeform input from the originator or an authorized named audience. The call waits for the audience and returns {"answer":"..."}. The optional question adds a discussion prompt; omit it when audience-visible context already establishes what response is awaited. The prompt need not be phrased as a question.',
        DiscussInputSchema.shape,
        async (raw) => {
          const currentCtx = currentManagedWorkerToolContext(ctx);
          return runTool(currentCtx, {
            toolName: DISCUSS_TOOL_NAME,
            run: async (toolCallId) => {
              let parsed: ReturnType<typeof parseDiscussInput>;
              try {
                parsed = parseDiscussInput(raw);
              } catch (error) {
                throw invalidToolInputError("discuss input", error);
              }
              const targetAudience = normalizeQuestionAudience(
                parsed.audience,
                currentCtx.outboundAudienceReferences,
              );
              const answer = await emitWorkerQuestion(
                currentCtx.emit,
                toolCallId,
                {
                  situation: {
                    audience: targetAudience,
                    cause: "question",
                  },
                  content: parsed.question ?? "",
                },
              );
              return {
                value: jsonToolResult({ answer }),
                outcome: "answered",
              };
            },
          });
        },
      ),
      tool(
        ASK_AUDIENCE_TOOL_NAME,
        'Collect structured input from an authorized named non-originator audience using questions with predefined choices. The call waits for the audience, validates the response, and returns {"answers":{...}}.',
        {
          ...AskAudienceInputSchema.shape,
          audience: z
            .string()
            .trim()
            .min(1)
            .describe("Named non-originator audience reference."),
        },
        async (raw) => {
          const currentCtx = currentManagedWorkerToolContext(ctx);
          return runTool(currentCtx, {
            toolName: ASK_AUDIENCE_TOOL_NAME,
            run: async (toolCallId) => {
              let parsed: ReturnType<typeof parseAskAudienceInput>;
              try {
                parsed = parseAskAudienceInput(raw);
              } catch (error) {
                throw invalidToolInputError("ask_audience input", error);
              }
              const targetAudience = normalizeNonOriginatorQuestionAudience(
                parsed.audience ?? "",
                currentCtx.outboundAudienceReferences,
              );
              const answer = await emitWorkerQuestion(
                currentCtx.emit,
                toolCallId,
                {
                  situation: {
                    audience: targetAudience,
                    cause: "question",
                  },
                  content: outboundQuestionForm(parsed.questions),
                },
              );
              return {
                value: jsonToolResult({
                  answers: answersForQuestionForm(parsed.questions, answer),
                }),
                outcome: "answered",
              };
            },
          });
        },
      ),
      tool(
        REPORT_TOOL_NAME,
        'Finalize the current assigned task. For completed instruction work, pass exactly {"outcome":"completed"}; include semantic only for semantic work. For a terminal failure, pass {"error":"failed","code":"...","message":"..."}.',
        {
          outcome: z.literal("completed").optional(),
          error: z.literal("failed").optional(),
          code: z.string().optional(),
          message: z.string().optional(),
          semantic: z.unknown().optional(),
        },
        async (raw) => {
          const currentCtx = currentManagedWorkerToolContext(ctx);
          const report = validateAgentRoutineReport(
            normalizeRoutineReportInput(raw, currentCtx.task),
            "report tool input",
          );
          await appendManagedWorkerToolDiagnostic(currentCtx, {
            kind: "report",
            reportKind: report.outcome ?? report.error,
          });
          currentCtx.resolveReport(report);
          return jsonToolResult({ ok: true });
        },
      ),
      ...externalTools.map((externalTool) =>
        tool(
          externalTool.name,
          externalTool.description,
          externalTool.inputSchema,
          async (raw) => {
            const currentCtx = currentManagedWorkerToolContext(ctx);
            return runTool(currentCtx, {
              toolName: externalTool.name,
              run: async () => ({
                value: jsonToolResult(
                  await externalTool.execute(raw, {
                    arcRunId: currentCtx.arcRunId,
                    routineId: currentCtx.routineId,
                    role: currentCtx.role,
                    task: currentCtx.task,
                    cwd: currentCtx.cwd,
                    workspacePath: currentCtx.workspacePath,
                    logToolEvent: currentCtx.logToolEvent,
                  }),
                ),
                outcome: "answered",
              }),
            });
          },
        ),
      ),
    ],
    alwaysLoad: true,
  });
}

function currentManagedWorkerToolContext(
  source: ManagedWorkerToolContextSource,
): ManagedWorkerToolContext {
  if (isManagedWorkerToolContextHolder(source)) {
    if (!source.current) {
      throw new Error("Claude SDK session has no active routine context.");
    }
    return source.current;
  }
  return source;
}

function isManagedWorkerToolContextHolder(
  source: ManagedWorkerToolContextSource,
): source is ManagedWorkerToolContextHolder {
  return !("arcRunId" in source);
}

function jsonToolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

/** Adapt Arcade's normalized answers to Claude's native string-only result. */
function nativeClaudeQuestionAnswers(
  questions: ReturnType<typeof parseAskAudienceInput>["questions"],
  answer: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answersForQuestionForm(questions, answer)).map(
      ([question, value]) => [
        question,
        Array.isArray(value) ? value.join(", ") : value,
      ],
    ),
  );
}

/** Query function used by the Claude Agent SDK backend. */
export type ClaudeSdkQueryFn = typeof query;

/** Startup function used to create Claude SDK prepared starts. */
export type ClaudeSdkStartupFn = typeof startup;

/** Per-routine option override for the SDK backend. */
export type ClaudeSdkRoutineOptions = {
  model?: string;
  timeoutMs?: number;
};

export type ClaudeSdkSessionCacheOptions = {
  enabled?: boolean;
  maxLiveSessions?: number;
  maxPreparedStarts?: number;
  idleTtlMs?: number;
  initializeTimeoutMs?: number;
};

type NormalizedSessionCacheOptions = Required<ClaudeSdkSessionCacheOptions>;

const DEFAULT_SESSION_CACHE: NormalizedSessionCacheOptions = {
  enabled: true,
  maxLiveSessions: 16,
  maxPreparedStarts: 4,
  idleTtlMs: 300000,
  initializeTimeoutMs: 30000,
};
const SUPPORTED_SLOT_KINDS: ReadonlySet<WorkerSlotKind> = new Set([
  "default",
  "role",
]);
const OptionalPositiveIntegerSchema = z.number().int().positive().optional();
const OptionalNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .optional();
const ClaudeWorkerSlotSchema = createWorkerSlotSchema({
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  cwd: z.string().min(1).optional(),
  sessionCache: z
    .strictObject({
      enabled: z.boolean().optional(),
      maxLiveSessions: OptionalPositiveIntegerSchema,
      maxPreparedStarts: OptionalNonNegativeIntegerSchema,
      idleTtlMs: OptionalPositiveIntegerSchema,
      initializeTimeoutMs: OptionalPositiveIntegerSchema,
    })
    .optional(),
});

export type ClaudeSdkBackendOptions = {
  /** Default Claude model id passed directly to the SDK query. */
  model?: string;
  /** Default timeout for one query. */
  timeoutMs?: number;
  /** Optional cwd override; its owner must supply and manage a usable directory. */
  cwd?: string;
  /** Reuse/preparation config for Claude SDK sessions. */
  sessionCache?: ClaudeSdkSessionCacheOptions;
  /** Optional per-routine config selector, used by app config role slots. */
  routineOptions?: (input: {
    routine: RoutineInput["routine"];
    context: RoutineContext;
  }) => ClaudeSdkRoutineOptions | undefined;
  /** Extra harness-owned tools exposed through the worker MCP server. */
  externalTools?: readonly ExternalWorkerTool[];
  /** Identity required before Arcade may reuse durable provider continuity. */
  resolveContinuityIdentity?: ResolveClaudeContinuityIdentity;
};

/** Test-only transport seams for the stock Claude backend. */
export type ClaudeSdkBackendTestOptions = ClaudeSdkBackendOptions & {
  logger?: ArcadeLogger;
  query?: ClaudeSdkQueryFn;
  startup?: ClaudeSdkStartupFn;
  onSessionObserved?: (input: {
    routine: RoutineInput["routine"];
    sessionKey: string;
    sessionId: string;
    cwd: string;
  }) => Promise<void> | void;
};

/** Construct the stock Claude implementation with code-supplied dependencies. */
export function createClaudeSdkBackend(
  options: ClaudeSdkBackendOptions = {},
): Backend {
  return createClaudeSdkBackendForTesting(options);
}

/** Construct the stock backend with injectable transport seams for tests. */
export function createClaudeSdkBackendForTesting(
  options: ClaudeSdkBackendTestOptions = {},
): Backend {
  return defineBackend({
    supportedSlotKinds: SUPPORTED_SLOT_KINDS,
    workerSlotSchema: ClaudeWorkerSlotSchema,
    createWorker(host, slot) {
      const config = slot;
      const warmStarts = new Map<string, Promise<void>>();
      let continuity!: ReturnType<typeof createContinuityController>;
      const worker = new ClaudeSdkWorker({
        ...options,
        logger: host.logger,
        model: config.model ?? options.model,
        timeoutMs: config.timeoutMs ?? options.timeoutMs,
        cwd: config.cwd ?? options.cwd,
        sessionCache: config.sessionCache ?? options.sessionCache,
        onSessionObserved: async (observed) => {
          await options.onSessionObserved?.(observed);
          await continuity.persistObserved(
            observed.routine,
            observed.sessionKey,
            observed.sessionId,
            observed.cwd,
          );
        },
      });
      continuity = createContinuityController({
        backend: "claude-sdk",
        host,
        slot,
        configuredCwd: config.cwd ?? options.cwd,
        resolveIdentity: options.resolveContinuityIdentity,
        continuityField: "sessionId",
        seed: (contextKey, sessionId, cwd) =>
          worker.seedSession(contextKey, sessionId, cwd),
        clear: (contextKey) => worker.clearSession(contextKey),
      });
      return {
        warm(input) {
          const key = workerWarmKey(input);
          const pending = continuity
            .warm(input)
            .then(() => worker.prepareWarmStart(input))
            .catch((error: unknown) => {
              host.logger.info("backend.claude_sdk.warm_failed", {
                arcRunId: input.arcRunId,
                contextKey: input.contextKey,
                message: error instanceof Error ? error.message : String(error),
              });
            });
          warmStarts.set(key, pending);
          return pending;
        },
        async run(input) {
          const sessionResume = claudeSessionResume(input);
          try {
            await continuity.prepareRun(input, {
              preserveLiveContinuation:
                sessionResume !== undefined ||
                worker.hasRetryState(input.routine.id),
            });
            const warmStart = warmStarts.get(workerWarmKey(input));
            if (warmStart) {
              warmStarts.delete(workerWarmKey(input));
              await warmStart;
            }
            const report = await worker.run(input, sessionResume);
            continuity.finish(
              input.routine.id,
              report.suspension !== undefined,
            );
            return report;
          } catch (error) {
            continuity.fail(input.routine.id);
            const report = providerFailureReport(error, "claude-sdk");
            if (report) return report;
            throw error;
          }
        },
        async disposeRoutine(input) {
          try {
            await worker.disposeRoutine(input);
          } finally {
            continuity.disposeRoutine(input.routineId);
          }
        },
        stop: () => worker.stop(),
      };
    },
  });
}

function workerWarmKey(input: WorkerWarmupInput | RoutineInput): string {
  return "routine" in input
    ? JSON.stringify([input.routine.arcRunId, input.routine.contextKey])
    : JSON.stringify([input.arcRunId, input.contextKey]);
}

function claudeSessionResume(
  input: RoutineInput,
): ClaudeSdkSessionResume | undefined {
  const resume = input.context.routineResume;
  return resume?.delivery === "rendered-context"
    ? { delivery: "session-message", message: resume.message }
    : undefined;
}

type StoredSdkSession = {
  sessionId: string;
  cwd: string;
};

type PreparedStart = {
  key: string;
  sessionKey: string;
  cwd: string;
  holder: ManagedWorkerToolContextHolder;
  abortController: AbortController;
  model: string;
  createdAt: number;
  closed: boolean;
  promise: Promise<WarmQuery>;
};

type ClaudeSdkRunInput = {
  sessionKey: string;
  cwd: string;
  renderContext: RoutineContext;
  prompt: string;
  model: string;
  timeoutMs: number;
  resume?: string;
};

type LiveSessionAcquisition = {
  session: ClaudeSdkLiveSession;
  cacheHit: boolean;
  preparedStartUsed: boolean;
};

/** Tool-capable backend backed by Claude Agent SDK and native Claude Code tools. */
export class ClaudeSdkWorker implements Worker {
  readonly #options: Required<
    Pick<ClaudeSdkBackendTestOptions, "model" | "timeoutMs">
  > &
    Omit<ClaudeSdkBackendTestOptions, "model" | "timeoutMs">;
  readonly #query: ClaudeSdkQueryFn;
  readonly #startup: ClaudeSdkStartupFn;
  readonly #logger: ArcadeLogger;
  readonly #sessionCache: NormalizedSessionCacheOptions;
  readonly #sessions = new Map<string, StoredSdkSession>();
  readonly #retryStates = new Map<
    string,
    {
      sessionId?: string;
      arcRunId: RoutineInput["routine"]["arcRunId"];
      cwd: string;
      model: string;
      report?: RoutineReport;
    }
  >();

  hasRetryState(routineId: string): boolean {
    return this.#retryStates.has(routineId);
  }
  readonly #liveSessions = new Map<string, ClaudeSdkLiveSession>();
  readonly #preparedStarts = new Map<string, PreparedStart>();
  readonly #grantsBySession = new Map<string, PermissionGrant[]>();

  constructor(options: ClaudeSdkBackendTestOptions) {
    this.#options = {
      ...options,
      model: options.model ?? DEFAULT_CLAUDE_SDK_MODEL,
      timeoutMs: options.timeoutMs ?? DEFAULT_CLAUDE_SDK_TIMEOUT_MS,
    };
    this.#query = options.query ?? query;
    this.#startup = options.startup ?? startup;
    this.#logger = options.logger ?? createArcadeLogger();
    this.#sessionCache = normalizeSessionCache(options.sessionCache);
  }

  seedSession(sessionKey: string, sessionId: string, cwd: string): void {
    if (!this.#sessions.has(sessionKey)) {
      this.#sessions.set(sessionKey, { sessionId, cwd });
    }
  }

  clearSession(sessionKey: string): void {
    this.#sessions.delete(sessionKey);
    this.#grantsBySession.delete(sessionKey);
    this.#evictLiveSession(sessionKey);
    for (const [key, entry] of this.#preparedStarts) {
      if (entry.sessionKey !== sessionKey) continue;
      this.#closePreparedStart(entry);
      this.#preparedStarts.delete(key);
    }
  }

  async disposeRoutine(
    input: Parameters<Worker["disposeRoutine"]>[0],
  ): Promise<void> {
    if (this.#retryStates.get(input.routineId)?.arcRunId === input.arcRunId)
      this.#retryStates.delete(input.routineId);
    for (const [key, session] of this.#liveSessions) {
      if (
        session.owner?.routineId === input.routineId &&
        session.owner.arcRunId === input.arcRunId
      )
        this.#evictLiveSession(key);
    }
  }

  async stop(): Promise<void> {
    this.#retryStates.clear();
    for (const session of this.#liveSessions.values()) session.close();
    this.#liveSessions.clear();
    for (const entry of this.#preparedStarts.values()) {
      this.#closePreparedStart(entry);
    }
    this.#preparedStarts.clear();
  }

  async prepareWarmStart(input: WorkerWarmupInput): Promise<void> {
    if (
      !this.#sessionCache.enabled ||
      this.#sessionCache.maxPreparedStarts === 0
    ) {
      return;
    }
    this.#sweepCache();
    const sessionKey = input.contextKey;
    const cwd = this.#options.cwd ?? input.workspacePath;
    const live = this.#liveSessions.get(sessionKey);
    if (live && live.cwd === cwd) return;
    const key = preparedStartKey(sessionKey, cwd);
    const existing = this.#preparedStarts.get(key);
    if (existing) {
      await existing.promise;
      return;
    }
    const holder: ManagedWorkerToolContextHolder = {};
    const abortController = new AbortController();
    const resume = this.#resumeForSession(sessionKey, cwd, input.role);
    const entry: PreparedStart = {
      key,
      sessionKey,
      cwd,
      holder,
      abortController,
      model: this.#options.model,
      createdAt: Date.now(),
      closed: false,
      promise: this.#startup({
        options: this.#buildOptions({
          abortController,
          cwd,
          model: this.#options.model,
          resume,
          workerCtx: holder,
        }),
        initializeTimeoutMs: this.#sessionCache.initializeTimeoutMs,
      }),
    };
    entry.promise.catch((error) => {
      this.#logger.info("backend.claude_sdk.prepared_start_failed", {
        sessionKey,
        cwd,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.#preparedStarts.set(key, entry);
    this.#enforcePreparedStartLimit();
    await entry.promise;
  }

  async run(
    input: RoutineInput,
    sessionResume?: ClaudeSdkSessionResume,
  ): Promise<RoutineReport> {
    const { context, effects, diagnostics } = input;
    const routine = backendRoutine(input);
    if (!this.#sessionCache.enabled) {
      return this.#run(
        routine,
        context,
        effects,
        diagnostics,
        false,
        sessionResume,
      );
    }
    return this.#run(
      routine,
      context,
      effects,
      diagnostics,
      true,
      sessionResume,
    );
  }

  async #run(
    routine: BackendRoutine,
    context: RoutineContext,
    effects: RoutineEffects,
    diagnostics: RoutineDiagnostics,
    cacheEnabled: boolean,
    sessionResume: ClaudeSdkSessionResume | undefined,
  ): Promise<RoutineReport> {
    this.#sweepCache();
    const input = this.#buildRunInput(routine, context, sessionResume);
    const retry = this.#retryStates.get(routine.id);
    if (retry) {
      if (!retry.sessionId) {
        this.#retryStates.delete(routine.id);
        return {
          error: "failed",
          code: "claude-continuation-unavailable",
          message:
            "The interrupted Claude task has no recorded session to resume.",
        };
      }
      input.resume = retry.sessionId;
      input.cwd = retry.cwd;
      input.model = retry.model;
      input.prompt =
        "Continue the interrupted assigned task from the retained conversation and tool results. Account for work already performed, including delivered messages. Complete only the remaining work and call the report tool.";
    }
    const { sessionKey, cwd, prompt, model, timeoutMs } = input;
    await diagnostics.writeText("prompt", prompt);

    const grants = this.#grantsBySession.get(sessionKey) ?? [];
    this.#grantsBySession.set(sessionKey, grants);

    let report: RoutineReport | undefined = retry?.report;
    const workerCtx = this.#workerContext(
      routine,
      context,
      effects,
      cwd,
      sessionKey,
      diagnostics,
      grants,
      (value) => {
        report ??= value;
      },
    );
    let toolActivity = false;
    const logToolEvent = workerCtx.logToolEvent;
    workerCtx.logToolEvent = async (event) => {
      toolActivity = true;
      await logToolEvent(event);
    };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      const session = this.#liveSessions.get(sessionKey);
      session?.close();
    }, timeoutMs);
    timeout.unref?.();

    let backendDetails: JsonValue = {
      backend: "claude-sdk",
      sessionKey,
      ...(input.resume !== undefined ? { sessionId: input.resume } : {}),
      cwd,
      model,
      sessionCacheEnabled: cacheEnabled,
      sessionCacheHit: false,
      preparedStartUsed: false,
    };

    this.#logger.info("backend.claude_sdk.started", {
      sessionKey,
      contextIsolation: routine.task.contextIsolation,
      routineId: routine.id,
      role: routine.role,
      cwd,
      model,
      resume: input.resume,
    });

    const transcript: SDKMessage[] = [];
    const observeMessage = async (message: SDKMessage) => {
      transcript.push(message);
      await diagnostics.appendJsonl("sdk-events", message);
      if (
        "session_id" in message &&
        typeof message.session_id === "string" &&
        message.session_id
      ) {
        const continuation = this.#retryStates.get(routine.id);
        if (continuation && continuation.sessionId !== message.session_id) {
          continuation.sessionId = message.session_id;
          this.#sessions.set(sessionKey, {
            sessionId: message.session_id,
            cwd,
          });
          await this.#options.onSessionObserved?.({
            routine,
            sessionKey,
            sessionId: message.session_id,
            cwd,
          });
        }
      }
    };
    let tokenUsageRecorded = false;
    const recordTranscriptTokenUsage = async () => {
      if (tokenUsageRecorded) return;
      const tokenUsage = routineTokenUsageFromClaudeSdkMessages(transcript);
      if (!tokenUsage) return;
      await effects.recordTokenUsage(tokenUsage);
      tokenUsageRecorded = true;
    };
    let session: ClaudeSdkLiveSession | undefined;
    let acquisition: LiveSessionAcquisition | undefined;
    let signal: RoutineSignal | undefined;
    try {
      acquisition = await this.#getLiveSession(input);
      session = acquisition.session;
      await session.runExclusive(async () => {
        session!.owner = { arcRunId: routine.arcRunId, routineId: routine.id };
        session!.holder.current = workerCtx;
        try {
          await session!.setModel(model);
          this.#retryStates.set(routine.id, {
            arcRunId: routine.arcRunId,
            sessionId: input.resume,
            cwd,
            model,
            report,
          });
          await session!.runPrompt(prompt, effects.checkSignal, observeMessage);
          await diagnostics.writeJson("sdk-messages", transcript);
          if (session!.signal) {
            session!.touch();
            signal = session!.signal;
            return;
          }
          let result = summarizeSdkMessages(transcript);
          if (result.sessionId) {
            await this.#options.onSessionObserved?.({
              routine,
              sessionKey,
              sessionId: result.sessionId,
              cwd,
            });
          }
          if (result.errors.length > 0) {
            throw new Error(
              `Claude SDK query failed: ${result.errors.join("; ")}`,
            );
          }
          if (!report) {
            this.#logger.info("backend.claude_sdk.missing_report_recovery", {
              sessionKey,
              routineId: routine.id,
              role: routine.role,
              sessionId: result.sessionId ?? input.resume,
              attempt: 1,
            });
            await session!.runPrompt(
              MISSING_REPORT_RECOVERY_PROMPT,
              effects.checkSignal,
              observeMessage,
            );
            await diagnostics.writeJson("sdk-messages", transcript);
            if (session!.signal) {
              session!.touch();
              signal = session!.signal;
              return;
            }
            result = summarizeSdkMessages(transcript);
            if (result.sessionId) {
              await this.#options.onSessionObserved?.({
                routine,
                sessionKey,
                sessionId: result.sessionId,
                cwd,
              });
            }
            if (result.errors.length > 0) {
              throw new Error(
                `Claude SDK missing-report recovery query failed: ${result.errors.join("; ")}`,
              );
            }
          }
          if (!report) {
            this.#logger.info("backend.claude_sdk.missing_report_failed", {
              sessionKey,
              routineId: routine.id,
              role: routine.role,
              sessionId: result.sessionId ?? input.resume,
              attempts: 1,
            });
            throw new Error(
              `Claude SDK worker did not call the ${WORKER_MCP_SERVER_NAME}.report tool before exiting.`,
            );
          }
          if (result.sessionId) {
            this.#sessions.set(sessionKey, {
              sessionId: result.sessionId,
              cwd,
            });
          }
          session!.touch();
          backendDetails = {
            backend: "claude-sdk",
            sessionKey,
            ...(result.sessionId !== undefined
              ? { sessionId: result.sessionId }
              : {}),
            cwd,
            model,
            sessionCacheEnabled: cacheEnabled,
            sessionCacheHit: acquisition!.cacheHit,
            preparedStartUsed: acquisition!.preparedStartUsed,
            ...(result.resultSubtype !== undefined
              ? { resultSubtype: result.resultSubtype }
              : {}),
            ...(result.durationMs !== undefined
              ? { durationMs: result.durationMs }
              : {}),
          };
        } finally {
          session!.holder.current = undefined;
        }
      });
      if (signal) {
        this.#retryStates.delete(routine.id);
        await recordTranscriptTokenUsage();
        if (signal.kind === "cancel") {
          await this.disposeRoutine({
            arcRunId: routine.arcRunId,
            routineId: routine.id,
          });
          return withBackendDetails(
            { cancellation: "superseded" },
            backendDetails,
          );
        }
        return withBackendDetails({ suspension: "paused" }, backendDetails);
      }
      const result = summarizeSdkMessages(transcript);
      this.#logger.info("backend.claude_sdk.finished", {
        sessionKey,
        contextIsolation: routine.task.contextIsolation,
        routineId: routine.id,
        role: routine.role,
        sessionId: result.sessionId,
        resultSubtype: result.resultSubtype,
        durationMs: result.durationMs,
      });
      if (!report) {
        throw new Error(
          `Claude SDK worker did not call the ${WORKER_MCP_SERVER_NAME}.report tool before exiting.`,
        );
      }
      await recordTranscriptTokenUsage();
      this.#retryStates.delete(routine.id);
      if (!cacheEnabled) this.#evictLiveSession(sessionKey);
      return withBackendDetails(report, backendDetails);
    } catch (error) {
      await recordTranscriptTokenUsage();
      if ((await effects.checkSignal())?.kind === "cancel") {
        await this.disposeRoutine({
          arcRunId: routine.arcRunId,
          routineId: routine.id,
        });
        return withBackendDetails(
          { cancellation: "superseded" },
          backendDetails,
        );
      }
      this.#evictLiveSession(sessionKey);
      const continuation = this.#retryStates.get(routine.id);
      if (continuation) continuation.report = report;
      const failure = timedOut
        ? new Error(`Claude SDK timed out after ${timeoutMs}ms.`)
        : error;
      const causes: { name?: string; message: string; stack?: string }[] = [];
      const seen = new Set<unknown>();
      for (
        let cause: unknown = error;
        cause !== undefined && !seen.has(cause);
      ) {
        seen.add(cause);
        causes.push(
          cause instanceof Error
            ? { name: cause.name, message: cause.message, stack: cause.stack }
            : { message: String(cause) },
        );
        cause = cause instanceof Error ? cause.cause : undefined;
      }
      await diagnostics.writeJson("sdk-error", {
        message: failure instanceof Error ? failure.message : String(failure),
        causes,
        sessionId: continuation?.sessionId,
        retainedMessageCount: transcript.length,
      });
      this.#logger.info("backend.claude_sdk.failed", {
        sessionKey,
        contextIsolation: routine.task.contextIsolation,
        routineId: routine.id,
        message: error instanceof Error ? error.message : String(error),
        transcript: previewLogValue(JSON.stringify(transcript)),
      });
      const interrupt = providerFailureReport(failure, "claude-sdk");
      if (interrupt?.suspension) {
        // An initial query with no observed execution has no progress to resume.
        // Once work is observed, keep even a missing session identity so retry
        // can report that limitation instead of repeating the assignment.
        if (
          !retry &&
          !continuation?.sessionId &&
          !toolActivity &&
          transcript.length === 0 &&
          !report
        ) {
          this.#retryStates.delete(routine.id);
        }
        return withBackendDetails(interrupt, backendDetails);
      }
      this.#retryStates.delete(routine.id);
      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  #buildRunInput(
    routine: BackendRoutine,
    context: RoutineContext,
    sessionResume: ClaudeSdkSessionResume | undefined,
  ): ClaudeSdkRunInput {
    const sessionKey = routine.contextKey;
    const cwd = this.#options.cwd ?? context.workspacePath;
    const renderContext =
      this.#options.cwd !== undefined
        ? { ...context, workspacePath: cwd }
        : context;
    const selected = this.#options.routineOptions?.({ routine, context });
    const model = selected?.model ?? this.#options.model;
    const timeoutMs = selected?.timeoutMs ?? this.#options.timeoutMs;
    return {
      sessionKey,
      cwd,
      renderContext,
      prompt: buildClaudeSdkPrompt(
        routine.task,
        renderContext,
        sessionResume,
        this.#shouldPrimeDialog(sessionKey, cwd),
      ),
      model,
      timeoutMs,
      resume: this.#resumeForSession(sessionKey, cwd, routine.role),
    };
  }

  // Prime the dialog only into a fresh backend session. A warm live session or
  // a seeded server-side resume already carries those turns in its own history,
  // so re-rendering them would duplicate context. Resume delivery is irrelevant
  // here: what matters is whether this session has already seen the dialog.
  #shouldPrimeDialog(sessionKey: string, cwd: string): boolean {
    const existing =
      this.#liveSessions.get(sessionKey) ?? this.#sessions.get(sessionKey);
    return existing?.cwd !== cwd;
  }

  #resumeForSession(
    sessionKey: string,
    cwd: string,
    role: string,
  ): string | undefined {
    const seeded = this.#sessions.get(sessionKey);
    if (!seeded) return undefined;
    if (seeded.cwd === cwd) return seeded.sessionId;
    this.#logger.info("backend.claude_sdk.resume_skipped", {
      sessionKey,
      role,
      storedCwd: seeded.cwd,
      cwd,
    });
    return undefined;
  }

  async #getLiveSession(
    input: ClaudeSdkRunInput,
  ): Promise<LiveSessionAcquisition> {
    const existing = this.#liveSessions.get(input.sessionKey);
    if (existing) {
      if (existing.cwd === input.cwd) {
        this.#liveSessions.delete(input.sessionKey);
        this.#liveSessions.set(input.sessionKey, existing);
        existing.touch();
        return {
          session: existing,
          cacheHit: true,
          preparedStartUsed: false,
        };
      }
      // Defensive: Arcade currently guarantees a stable workspace per run; if
      // future workspace stability is relaxed, do not reuse a live SDK Query
      // across cwd changes.
      this.#logger.info("backend.claude_sdk.session_cache_cwd_mismatch", {
        sessionKey: input.sessionKey,
        storedCwd: existing.cwd,
        cwd: input.cwd,
      });
      this.#evictLiveSession(input.sessionKey);
    }
    const prepared = await this.#consumePreparedStart(input);
    const session = prepared ?? this.#createColdLiveSession(input);
    this.#liveSessions.set(input.sessionKey, session);
    this.#enforceLiveSessionLimit();
    return {
      session,
      cacheHit: false,
      preparedStartUsed: prepared !== undefined,
    };
  }

  async #consumePreparedStart(
    input: ClaudeSdkRunInput,
  ): Promise<ClaudeSdkLiveSession | undefined> {
    const key = preparedStartKey(input.sessionKey, input.cwd);
    const entry = this.#preparedStarts.get(key);
    if (!entry) return undefined;
    this.#preparedStarts.delete(key);
    if (entry.closed) return undefined;
    try {
      const prompt = new AsyncSdkUserMessageQueue();
      const warm = await entry.promise;
      const sdkQuery = warm.query(prompt);
      return new ClaudeSdkLiveSession({
        sessionKey: input.sessionKey,
        cwd: input.cwd,
        holder: entry.holder,
        abortController: entry.abortController,
        prompt,
        query: sdkQuery,
        model: entry.model,
      });
    } catch (error) {
      entry.abortController.abort();
      this.#logger.info("backend.claude_sdk.prepared_start_consume_failed", {
        sessionKey: input.sessionKey,
        cwd: input.cwd,
        message: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  #createColdLiveSession(input: ClaudeSdkRunInput): ClaudeSdkLiveSession {
    const holder: ManagedWorkerToolContextHolder = {};
    const abortController = new AbortController();
    const prompt = new AsyncSdkUserMessageQueue();
    const sdkQuery = this.#query({
      prompt,
      options: this.#buildOptions({
        abortController,
        cwd: input.cwd,
        model: input.model,
        resume: input.resume,
        workerCtx: holder,
      }),
    }) as Query;
    return new ClaudeSdkLiveSession({
      sessionKey: input.sessionKey,
      cwd: input.cwd,
      holder,
      abortController,
      prompt,
      query: sdkQuery,
      model: input.model,
    });
  }

  #evictLiveSession(sessionKey: string): void {
    const session = this.#liveSessions.get(sessionKey);
    if (!session) return;
    session.close();
    this.#liveSessions.delete(sessionKey);
  }

  #sweepCache(): void {
    const now = Date.now();
    for (const [key, session] of this.#liveSessions) {
      if (now - session.lastUsedAt > this.#sessionCache.idleTtlMs) {
        session.close();
        this.#liveSessions.delete(key);
      }
    }
    for (const [key, entry] of this.#preparedStarts) {
      if (now - entry.createdAt > this.#sessionCache.idleTtlMs) {
        this.#closePreparedStart(entry);
        this.#preparedStarts.delete(key);
      }
    }
  }

  #enforceLiveSessionLimit(): void {
    while (this.#liveSessions.size > this.#sessionCache.maxLiveSessions) {
      const oldest = this.#liveSessions.keys().next().value as
        | string
        | undefined;
      if (!oldest) return;
      this.#evictLiveSession(oldest);
    }
  }

  #enforcePreparedStartLimit(): void {
    while (this.#preparedStarts.size > this.#sessionCache.maxPreparedStarts) {
      const oldest = this.#preparedStarts.keys().next().value as
        | string
        | undefined;
      if (!oldest) return;
      const entry = this.#preparedStarts.get(oldest);
      if (entry) this.#closePreparedStart(entry);
      this.#preparedStarts.delete(oldest);
    }
  }

  #closePreparedStart(entry: PreparedStart): void {
    if (entry.closed) return;
    entry.closed = true;
    entry.abortController.abort();
    entry.promise.then((warm) => warm.close()).catch(() => undefined);
  }

  #buildOptions(input: {
    abortController: AbortController;
    cwd: string;
    model: string;
    resume?: string;
    workerCtx: ManagedWorkerToolContextSource;
  }): ClaudeSdkOptions {
    return {
      abortController: input.abortController,
      canUseTool: this.#canUseTool(input.workerCtx),
      cwd: input.cwd,
      mcpServers: {
        [WORKER_MCP_SERVER_NAME]: buildClaudeSdkMcpServer(
          input.workerCtx,
          this.#options.externalTools ?? [],
        ),
      },
      model: input.model,
      promptSuggestions: false,
      resume: input.resume,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: WORKER_INTERACTION_SYSTEM_PROMPT,
      },
      // Keep Opus adaptive thinking enabled, but do not surface thinking blocks
      // in the SDK transcript. Claude Code must replay thinking blocks exactly
      // across tool turns, and displayed transcript chunks are not a stable
      // Arcade contract.
      thinking: CLAUDE_SDK_THINKING,
      tools: { type: "preset", preset: "claude_code" },
    };
  }

  #canUseTool(ctx: ManagedWorkerToolContextSource): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const currentCtx = currentManagedWorkerToolContext(ctx);
      if (toolName === NATIVE_ASK_USER_QUESTION_TOOL_NAME) {
        let parsed: ReturnType<typeof parseAskAudienceInput>;
        try {
          parsed = parseAskAudienceInput(input);
        } catch (error) {
          throw invalidToolInputError("AskUserQuestion input", error);
        }
        const updatedInput = await runTool(currentCtx, {
          toolName: NATIVE_ASK_USER_QUESTION_TOOL_NAME,
          toolCallId: options.toolUseID,
          run: async (toolCallId) => {
            const answer = await emitWorkerQuestion(
              currentCtx.emit,
              toolCallId,
              {
                situation: {
                  audience: "originator",
                  cause: "question",
                },
                content: outboundQuestionForm(parsed.questions),
              },
            );
            return {
              value: {
                questions: parsed.questions,
                answers: nativeClaudeQuestionAnswers(parsed.questions, answer),
              },
              outcome: "answered" as const,
            };
          },
        });
        return {
          behavior: "allow",
          updatedInput,
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        };
      }
      if (!SDK_PERMISSION_CONTROLLED_TOOLS.has(toolName)) {
        return {
          behavior: "allow",
          updatedInput: input,
          toolUseID: options.toolUseID,
          decisionClassification: "user_temporary",
        };
      }
      const verdict = await resolveWorkerPermission(
        currentCtx,
        options.toolUseID,
        toolName,
        input,
        this.#logger,
      );
      if (verdict.decision === "deny") {
        return {
          behavior: "deny",
          message: verdict.message ?? "Denied by Arcade permission policy.",
          toolUseID: options.toolUseID,
          decisionClassification: "user_reject",
        };
      }
      // Command-scoped tools (Bash) must re-enter canUseTool on every call so
      // Arcade's per-command grant decides each one. Handing the SDK a blanket
      // "remember this tool" permission would let later commands skip the gate,
      // so suppress SDK-level persistence for them; Arcade remembers instead.
      // Re-entering canUseTool is NOT re-prompting: resolveWorkerPermission
      // short-circuits on a remembered grant (no escalation), so an already
      // allow_this_run'd command auto-allows silently here. Only a new, unseen
      // invocation escalates to the approver. Per Bash call != per Bash prompt.
      const persistAtSdkLevel =
        verdict.decision === "allow_this_run" &&
        !isCommandScopedPermissionTool(toolName);
      return {
        behavior: "allow",
        updatedInput: verdict.updatedInput ?? input,
        updatedPermissions: persistAtSdkLevel ? options.suggestions : undefined,
        toolUseID: options.toolUseID,
        decisionClassification: persistAtSdkLevel
          ? "user_permanent"
          : "user_temporary",
      };
    };
  }

  #workerContext(
    routine: BackendRoutine,
    context: RoutineContext,
    effects: RoutineEffects,
    cwd: string,
    sessionKey: string,
    diagnostics: RoutineDiagnostics,
    grants: PermissionGrant[],
    onReport: (report: RoutineReport) => void,
  ): ManagedWorkerToolContext {
    return {
      arcRunId: routine.arcRunId,
      routineId: routine.id,
      role: routine.role,
      backend: "claude-sdk",
      sessionKey,
      task: routine.task,
      outboundAudienceReferences:
        routine.task.kind === "instruction"
          ? renderInstructionAudienceReferencesForPrompt(
              routine.task,
              context,
              { kind: "host" },
            )
          : [],
      diagnostics,
      cwd,
      workspacePath: context.workspacePath,
      emit: async (input) => {
        return await effects.emit({
          situation: {
            audience: input.situation.audience,
            cause: input.situation.cause,
          },
          content: input.content,
          metadata: input.metadata,
        });
      },
      logToolEvent: effects.logToolEvent,
      resolveReport: onReport,
      requestPermission: effects.requestPermission,
      grants,
    };
  }
}

function normalizeSessionCache(
  input: ClaudeSdkSessionCacheOptions | undefined,
): NormalizedSessionCacheOptions {
  return { ...DEFAULT_SESSION_CACHE, ...input };
}

function preparedStartKey(sessionKey: string, cwd: string): string {
  return `${sessionKey}\0${cwd}`;
}

function summarizeSdkMessages(messages: readonly SDKMessage[]): {
  sessionId?: string;
  resultSubtype?: string;
  durationMs?: number;
  errors: string[];
} {
  let sessionId: string | undefined;
  let resultSubtype: string | undefined;
  let durationMs: number | undefined;
  const errors: string[] = [];

  for (const message of messages) {
    if ("session_id" in message && typeof message.session_id === "string") {
      sessionId = message.session_id;
    }
    if (message.type === "result") {
      resultSubtype = message.subtype;
      durationMs = message.duration_ms;
      if (message.subtype !== "success") errors.push(...message.errors);
    }
    const assistantError = readAssistantError(message);
    if (assistantError) errors.push(assistantError);
  }

  return { sessionId, resultSubtype, durationMs, errors };
}

function readAssistantError(message: SDKMessage): string | undefined {
  if (message.type !== "assistant") return undefined;
  const value = message as unknown as { error?: unknown };
  return typeof value.error === "string" ? value.error : undefined;
}
