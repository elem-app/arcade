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
import type { PermissionGrants } from "./managed-worker-tools.js";
import { PermissionGrantCache } from "./permission-grant-cache.js";
import { PreparedStartPool } from "./prepared-start-pool.js";

import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import { modelReportContract } from "../service/semantic-schema.js";
import {
  INSTRUCTION_EXECUTION_BOUNDARY_RULES,
  OBSERVATION_EXECUTION_RULES,
  renderActiveInstructionForPrompt,
  renderDialogPriming,
  renderInstructionAudienceReferencesForPrompt,
  renderInstructionTaskTextForPrompt,
  renderQuestionAudienceReferencesForPrompt,
  renderSemanticRequestForPrompt,
  xmlBlock,
} from "../service/task-renderer.js";
import { routineTokenUsageFromClaudeSdkMessages } from "../service/token-usage.js";
import {
  normalizeNonOriginatorQuestionAudience,
  normalizeQuestionAudience,
  normalizeReplyAudience,
} from "../service/utils.js";
import { defineBackend, type Backend, type Worker } from "../types/backend.js";
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
  readRetention,
  registerRetentionProbe,
  type PermissionGrantCacheRetention,
  type PreparedStartPoolRetention,
} from "../utils/retention-registry.js";
import {
  backendRoutine,
  providerFailureReport,
  withBackendDetails,
  type BackendRoutine,
} from "./backend-support.js";
import {
  createContinuityPreparation,
  type InvocationContinuity,
  type PrepareContinuity,
  type ResolveClaudeContinuityIdentity,
} from "./continuity.js";
import {
  answersForQuestionForm,
  appendManagedWorkerToolDiagnostic,
  ASK_AUDIENCE_TOOL_NAME,
  AskAudienceInputSchema,
  buildMissingReportRecoveryPrompt,
  DISCUSS_TOOL_NAME,
  DiscussInputSchema,
  EmitOutboundInputSchema,
  emitWorkerQuestion,
  invalidToolInputError,
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
} from "./managed-worker-tools.js";

export const DEFAULT_CLAUDE_SDK_MODEL = "claude-opus-4-7";
const DEFAULT_CLAUDE_SDK_TIMEOUT_MS = 10 * 60 * 1000;
const CLAUDE_SDK_THINKING = {
  type: "adaptive",
  display: "omitted",
} as const;
/** MCP server name registered by the Claude managed-worker adapter. */
const WORKER_MCP_SERVER_NAME = "arcade_internal";
const MISSING_REPORT_RECOVERY_PROMPT = buildMissingReportRecoveryPrompt(
  `mcp__${WORKER_MCP_SERVER_NAME}__${REPORT_TOOL_NAME}`,
);
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
  const { text, guidance, audienceReferences } = rendered;
  const parts = [
    `You are working as the "${task.role}" role.`,
    ...renderDialogPriming(task, shouldPrimeDialog),
    "",
    xmlBlock("instruction", text),
  ];
  if (guidance !== undefined) parts.push("", xmlBlock("guidance", guidance));
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
          renderSemanticRequestForPrompt(
            request,
            context,
            { kind: "host" },
            task.stage,
          ),
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
    "Call report using its declared schema to submit the completed semantic assignment.",
    ...(task.stage === "action"
      ? OBSERVATION_EXECUTION_RULES
      : [
          'Use "resolved" when the complete cell value can be determined, "unknown" when it cannot, and "needs-user" only for observeOrAsk when a user reply would help.',
        ]),
    "Interpret each observed field using its question and metadata. Preserve the requested array order.",
  ];
  if (
    task.stage === "action" &&
    task.requests.some(
      (request) =>
        request.kind !== "judgment" && request.mode === "observeOrAsk",
    )
  ) {
    const references = renderQuestionAudienceReferencesForPrompt(
      task,
      context,
      { kind: "host" },
    );
    rules.push(
      "",
      "Question audience references:",
      ...references.map((ref) => `- ${ref.marker} -> ${ref.audience}`),
      "Originator is implicitly available for input. Use the mapped audience value in audience-tool calls. Do not copy an audience marker into delivered question text.",
      `Freeform audience input: mcp__${WORKER_MCP_SERVER_NAME}__${DISCUSS_TOOL_NAME}.`,
      "Structured originator input: AskUserQuestion.",
      `Structured input from a named non-originator audience: mcp__${WORKER_MCP_SERVER_NAME}__${ASK_AUDIENCE_TOOL_NAME}.`,
    );
  }
  parts.push("", xmlBlock("rules", rules.join("\n")));
  return parts.join("\n");
}

/** Turn the Claude worker sends to continue retained work. */
const CONTINUATION_TURN = "Continue";

function appendResumeMessage(parts: string[], context: RoutineContext): void {
  if (context.routineResume?.delivery !== "continue") return;
  parts.push("", xmlBlock("resume-message", CONTINUATION_TURN));
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
    this.#queue.length = 0;
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
  #reportSchemaKey: string;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();
  signal: RoutineSignal | undefined;
  owner?: Parameters<Worker["disposeRoutine"]>[0];
  reusable = false;
  reuseKey?: string;
  sessionId?: string;
  continuity?: InvocationContinuity;

  constructor(input: {
    sessionKey: string;
    cwd: string;
    holder: ManagedWorkerToolContextHolder;
    abortController: AbortController;
    prompt: AsyncSdkUserMessageQueue;
    query: Query;
    model: string;
    owner: Parameters<Worker["disposeRoutine"]>[0];
    task?: Task;
  }) {
    this.sessionKey = input.sessionKey;
    this.cwd = input.cwd;
    this.holder = input.holder;
    this.#abortController = input.abortController;
    this.#prompt = input.prompt;
    this.#query = input.query;
    this.#iterator = input.query[Symbol.asyncIterator]();
    this.#model = input.model;
    this.#reportSchemaKey = JSON.stringify(
      modelReportContract(input.task).jsonSchema,
    );
    this.owner = input.owner;
  }

  async bindReportSchema(
    task: Task,
    externalTools: readonly ExternalWorkerTool[],
  ): Promise<void> {
    const key = JSON.stringify(modelReportContract(task).jsonSchema);
    if (key === this.#reportSchemaKey) return;
    // The SDK retains an existing in-process server by name. Disconnect it
    // before installing the current assignment's schema on the same session.
    this.#reportSchemaKey = "";
    const removed = await this.#query.setMcpServers({});
    if (Object.keys(removed.errors).length)
      throw new Error(
        `Claude report schema removal failed: ${JSON.stringify(removed.errors)}`,
      );
    const result = await this.#query.setMcpServers({
      [WORKER_MCP_SERVER_NAME]: buildClaudeSdkMcpServer(
        this.holder,
        externalTools,
        task,
      ),
    });
    if (Object.keys(result.errors).length)
      throw new Error(
        `Claude report schema binding failed: ${JSON.stringify(result.errors)}`,
      );
    this.#reportSchemaKey = key;
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
    this.holder.current = undefined;
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
  task?: Task,
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
                currentCtx.questionAudienceReferences,
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
                currentCtx.questionAudienceReferences,
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
        "Finalize the current assigned task using the declared report schema. Report a completed outcome or a terminal failure.",
        modelReportContract(task).schema.shape,
        async (raw) => {
          const currentCtx = currentManagedWorkerToolContext(ctx);
          const report = modelReportContract(currentCtx.task).parse(raw);
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
  maxPreparedStarts?: number;
  maxIdleSessions?: number;
  idleTtlMs?: number;
  initializeTimeoutMs?: number;
};

type NormalizedSessionCacheOptions = Required<ClaudeSdkSessionCacheOptions>;

const DEFAULT_SESSION_CACHE: NormalizedSessionCacheOptions = {
  enabled: true,
  maxPreparedStarts: 4,
  maxIdleSessions: 4,
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
      maxPreparedStarts: OptionalNonNegativeIntegerSchema,
      maxIdleSessions: OptionalNonNegativeIntegerSchema,
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
      const prepare = createContinuityPreparation({
        backend: "claude-sdk",
        host,
        slot,
        configuredCwd: config.cwd ?? options.cwd,
        resolveIdentity: options.resolveContinuityIdentity,
        continuityField: "sessionId",
      });
      const worker = new ClaudeSdkWorker(
        {
          ...options,
          logger: host.logger,
          model: config.model ?? options.model,
          timeoutMs: config.timeoutMs ?? options.timeoutMs,
          cwd: config.cwd ?? options.cwd,
          sessionCache: config.sessionCache ?? options.sessionCache,
        },
        prepare,
      );
      return {
        async run(input) {
          try {
            return await worker.run(input, claudeSessionResume(input));
          } catch (error) {
            const report = providerFailureReport(error, "claude-sdk");
            if (report) return report;
            throw error;
          }
        },
        disposeRoutine: (input) => worker.disposeRoutine(input),
        stop: () => worker.stop(),
      };
    },
  });
}

function claudeSessionResume(
  input: RoutineInput,
): ClaudeSdkSessionResume | undefined {
  const resume = input.context.routineResume;
  return resume?.delivery === "continue"
    ? { delivery: "session-message", message: CONTINUATION_TURN }
    : undefined;
}

type ClaudeSdkRunInput = {
  task: Task;
  reuseKey?: string;
  owner: Parameters<Worker["disposeRoutine"]>[0];
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
  liveSessionReused: boolean;
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
  readonly #retryStates = new Map<
    string,
    {
      sessionId?: string;
      arcRunId: RoutineInput["routine"]["arcRunId"];
      cwd: string;
      model: string;
      report?: RoutineReport;
      continuity?: InvocationContinuity;
    }
  >();

  hasRetryState(routineId: string): boolean {
    return this.#retryStates.has(routineId);
  }
  readonly #liveSessions = new Map<string, ClaudeSdkLiveSession>();
  readonly #idleSessions = new Map<
    string,
    {
      session: ClaudeSdkLiveSession;
      timer: ReturnType<typeof setTimeout>;
      expiresAt: number;
    }
  >();
  #idleCleanupFailure: Error | undefined;
  readonly #preparedStarts: PreparedStartPool<{
    warm: WarmQuery;
    holder: ManagedWorkerToolContextHolder;
  }>;
  readonly #grantsBySession = new PermissionGrantCache();
  #stopped = false;

  constructor(
    options: ClaudeSdkBackendTestOptions,
    private readonly prepareContinuity?: PrepareContinuity,
  ) {
    this.#options = {
      ...options,
      model: options.model ?? DEFAULT_CLAUDE_SDK_MODEL,
      timeoutMs: options.timeoutMs ?? DEFAULT_CLAUDE_SDK_TIMEOUT_MS,
    };
    this.#query = options.query ?? query;
    this.#startup = options.startup ?? startup;
    this.#logger = options.logger ?? createArcadeLogger();
    this.#sessionCache = normalizeSessionCache(options.sessionCache);
    this.#preparedStarts = new PreparedStartPool({
      max: this.#sessionCache.enabled
        ? this.#sessionCache.maxPreparedStarts
        : 0,
      idleTtlMs: this.#sessionCache.idleTtlMs,
      start: async (cwd, abortController) => {
        const holder: ManagedWorkerToolContextHolder = {};
        const warm = await this.#startup({
          options: this.#buildOptions({
            abortController,
            cwd,
            model: this.#options.model,
            workerCtx: holder,
          }),
          initializeTimeoutMs: this.#sessionCache.initializeTimeoutMs,
        });
        return { warm, holder };
      },
      close: ({ warm }) => warm.close(),
      failed: (error) =>
        this.#logger.info("backend.claude_sdk.prepared_start_failed", {
          message: String(error),
        }),
    });
    registerRetentionProbe(this, () => {
      const grants = readRetention<PermissionGrantCacheRetention>(
        this.#grantsBySession,
      );
      return {
        grantContexts: grants.contexts,
        grants: grants.grants,
        liveRoutines: this.#liveSessions.size,
        idleSessions: this.#idleSessions.size,
        retryRoutines: this.#retryStates.size,
        preparedStarts: readRetention<PreparedStartPoolRetention>(
          this.#preparedStarts,
        ).reserved,
      };
    });
  }

  async disposeRoutine(
    input: Parameters<Worker["disposeRoutine"]>[0],
  ): Promise<void> {
    const preparations = new Set<InvocationContinuity>();
    const errors: unknown[] = [];
    const retry = this.#retryStates.get(input.routineId);
    if (retry?.arcRunId === input.arcRunId) {
      if (retry.continuity) preparations.add(retry.continuity);
      this.#retryStates.delete(input.routineId);
    }
    for (const session of this.#liveSessions.values()) {
      if (
        session.owner?.routineId === input.routineId &&
        session.owner?.arcRunId === input.arcRunId
      ) {
        if (session.continuity) preparations.add(session.continuity);
        try {
          this.#closeLiveSession(session);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    const results = await Promise.allSettled(
      [...preparations].map((preparation) => preparation.close()),
    );
    for (const result of results)
      if (result.status === "rejected") errors.push(result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Claude routine cleanup failed.");
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const preparations = new Set<InvocationContinuity>();
    const errors: unknown[] = [];
    for (const retry of this.#retryStates.values())
      if (retry.continuity) preparations.add(retry.continuity);
    for (const session of this.#liveSessions.values()) {
      if (session.continuity) preparations.add(session.continuity);
      try {
        this.#closeLiveSession(session);
      } catch (error) {
        errors.push(error);
      }
    }
    this.#liveSessions.clear();
    for (const key of this.#idleSessions.keys()) this.#retireIdleSession(key);
    if (this.#idleCleanupFailure) errors.push(this.#idleCleanupFailure);
    this.#retryStates.clear();
    this.#grantsBySession.stop();
    const results = await Promise.allSettled([
      this.#preparedStarts.stop(),
      ...[...preparations].map((entry) => entry.close()),
    ]);
    for (const result of results)
      if (result.status === "rejected") errors.push(result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Claude worker cleanup failed.");
  }

  async run(
    input: RoutineInput,
    sessionResume?: ClaudeSdkSessionResume,
  ): Promise<RoutineReport> {
    if (this.#stopped) throw new Error("Claude SDK worker is stopped.");
    const ownerKey = JSON.stringify([input.routine.arcRunId, input.routine.id]);
    const preparation =
      this.#retryStates.get(input.routine.id)?.continuity ??
      this.#liveSessions.get(ownerKey)?.continuity ??
      (await this.prepareContinuity?.(input));
    try {
      if (
        this.#stopped ||
        (await input.effects.checkSignal())?.kind === "cancel"
      )
        return { cancellation: "superseded" };
      return await this.#run(
        backendRoutine(input),
        input.context,
        input.effects,
        input.diagnostics,
        this.#sessionCache.enabled,
        sessionResume,
        preparation,
      );
    } finally {
      const session = this.#liveSessions.get(ownerKey);
      if (session?.reusable && !this.#stopped) {
        try {
          await preparation?.close();
          session.continuity = undefined;
          if ((await input.effects.checkSignal())?.kind === "cancel")
            this.#closeLiveSession(session);
          else this.#cacheLiveSession(session);
        } catch (error) {
          this.#closeLiveSession(session);
          throw error;
        }
      } else {
        const retained =
          this.#retryStates.get(input.routine.id)?.continuity === preparation ||
          session?.continuity === preparation;
        if (retained && !this.#stopped) await preparation?.drain();
        else await preparation?.close();
      }
    }
  }

  async #run(
    routine: BackendRoutine,
    context: RoutineContext,
    effects: RoutineEffects,
    diagnostics: RoutineDiagnostics,
    cacheEnabled: boolean,
    sessionResume: ClaudeSdkSessionResume | undefined,
    preparation: InvocationContinuity | undefined,
  ): Promise<RoutineReport> {
    if (this.#stopped) throw new Error("Claude SDK worker is stopped.");
    const input = this.#buildRunInput(
      routine,
      context,
      sessionResume,
      preparation,
    );
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
    const { sessionKey, cwd, model, timeoutMs } = input;
    let { prompt } = input;
    await diagnostics.writeText("prompt", prompt);
    if (this.#stopped) return { cancellation: "superseded" };

    const grants = this.#grantsBySession.forContext(
      routine.arcRunId,
      routine.contextKey,
    );

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
    let session: ClaudeSdkLiveSession | undefined;
    const closeOwnedSession = () => {
      if (session?.owner === input.owner) this.#closeLiveSession(session);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      closeOwnedSession();
    }, timeoutMs);
    timeout.unref?.();

    let backendDetails: JsonValue = {
      backend: "claude-sdk",
      sessionKey,
      ...(input.resume !== undefined ? { sessionId: input.resume } : {}),
      cwd,
      model,
      sessionCacheEnabled: cacheEnabled,
      liveSessionReused: false,
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
        if (session) session.sessionId = message.session_id;
        const continuation = this.#retryStates.get(routine.id);
        if (continuation && continuation.sessionId !== message.session_id) {
          continuation.sessionId = message.session_id;
          await preparation?.observe(message.session_id);
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
    let acquisition: LiveSessionAcquisition | undefined;
    let signal: RoutineSignal | undefined;
    try {
      acquisition = await this.#getLiveSession(input);
      session = acquisition.session;
      session.continuity = preparation;
      session.reusable = false;
      session.reuseKey = this.prepareContinuity
        ? preparation?.reuseKey
        : "worker";
      if (acquisition.liveSessionReused && !retry) {
        // A live query already has its dialog even without a durable pointer.
        const continuedPrompt = buildClaudeSdkPrompt(
          routine.task,
          input.renderContext,
          sessionResume,
          false,
        );
        if (continuedPrompt !== prompt) {
          prompt = continuedPrompt;
          await diagnostics.writeText("prompt", prompt);
        }
      }
      backendDetails = {
        ...backendDetails,
        liveSessionReused: acquisition.liveSessionReused,
        preparedStartUsed: acquisition.preparedStartUsed,
      };
      if (timedOut) {
        closeOwnedSession();
        throw new Error(`Claude SDK timed out after ${timeoutMs}ms.`);
      }
      await session.runExclusive(async () => {
        session!.holder.current = workerCtx;
        try {
          await session!.bindReportSchema(
            routine.task,
            this.#options.externalTools ?? [],
          );
          await session!.setModel(model);
          if (this.#stopped) {
            signal = { kind: "cancel" };
            return;
          }
          this.#retryStates.set(routine.id, {
            arcRunId: routine.arcRunId,
            sessionId: input.resume,
            cwd,
            model,
            report,
            continuity: preparation,
          });
          await session!.runPrompt(prompt, effects.checkSignal, observeMessage);
          await diagnostics.writeJson("sdk-messages", transcript);
          if (session!.signal) {
            signal = session!.signal;
            return;
          }
          let result = summarizeSdkMessages(transcript);
          if (result.sessionId) {
            await preparation?.observe(result.sessionId);
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
              signal = session!.signal;
              return;
            }
            result = summarizeSdkMessages(transcript);
            if (result.sessionId) {
              await preparation?.observe(result.sessionId);
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
          backendDetails = {
            backend: "claude-sdk",
            sessionKey,
            ...(result.sessionId !== undefined
              ? { sessionId: result.sessionId }
              : {}),
            cwd,
            model,
            sessionCacheEnabled: cacheEnabled,
            liveSessionReused: acquisition!.liveSessionReused,
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
      // A completed turn can remain warm once its routine callbacks and
      // continuity writes have been detached by run()'s finalizer.
      session.reusable = cacheEnabled && Boolean(session.reuseKey);
      if (!session.reusable) closeOwnedSession();
      return withBackendDetails(report, backendDetails);
    } catch (error) {
      closeOwnedSession();
      await recordTranscriptTokenUsage();
      if (this.#stopped || (await effects.checkSignal())?.kind === "cancel") {
        await this.disposeRoutine({
          arcRunId: routine.arcRunId,
          routineId: routine.id,
        });
        return withBackendDetails(
          { cancellation: "superseded" },
          backendDetails,
        );
      }
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
    preparation: InvocationContinuity | undefined,
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
      task: routine.task,
      owner: { arcRunId: routine.arcRunId, routineId: routine.id },
      reuseKey: this.prepareContinuity ? preparation?.reuseKey : "worker",
      sessionKey,
      cwd,
      renderContext,
      prompt: buildClaudeSdkPrompt(
        routine.task,
        renderContext,
        sessionResume,
        !this.#liveSessions.has(
          JSON.stringify([routine.arcRunId, routine.id]),
        ) && preparation?.prior === undefined,
      ),
      model,
      timeoutMs,
      resume: preparation?.prior,
    };
  }

  async #getLiveSession(
    input: ClaudeSdkRunInput,
  ): Promise<LiveSessionAcquisition> {
    const ownerKey = JSON.stringify([
      input.owner.arcRunId,
      input.owner.routineId,
    ]);
    const existing = this.#liveSessions.get(ownerKey);
    if (existing) {
      if (existing.cwd === input.cwd) {
        // Transfer ownership before returning across the acquisition boundary.
        existing.owner = input.owner;
        return {
          session: existing,
          liveSessionReused: true,
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
      this.#closeLiveSession(existing);
    }
    const idleKey = JSON.stringify([input.owner.arcRunId, input.sessionKey]);
    const idle = this.#idleSessions.get(idleKey);
    if (idle) {
      if (
        idle.expiresAt > Date.now() &&
        input.reuseKey &&
        idle.session.reuseKey === input.reuseKey &&
        idle.session.cwd === input.cwd &&
        (!this.prepareContinuity || idle.session.sessionId === input.resume)
      ) {
        clearTimeout(idle.timer);
        this.#idleSessions.delete(idleKey);
        idle.session.owner = input.owner;
        idle.session.reusable = false;
        this.#liveSessions.set(ownerKey, idle.session);
        return {
          session: idle.session,
          liveSessionReused: true,
          preparedStartUsed: false,
        };
      }
      this.#retireIdleSession(idleKey);
    }
    const prepared = await this.#consumePreparedStart(input);
    const session = prepared ?? this.#createColdLiveSession(input);
    if (this.#stopped) {
      session.close();
      throw new Error("Claude SDK worker is stopped.");
    }
    this.#liveSessions.set(ownerKey, session);
    return {
      session,
      liveSessionReused: false,
      preparedStartUsed: prepared !== undefined,
    };
  }

  async #consumePreparedStart(
    input: ClaudeSdkRunInput,
  ): Promise<ClaudeSdkLiveSession | undefined> {
    if (input.resume) return undefined;
    const prepared = this.#preparedStarts.take(input.cwd);
    if (!prepared) return undefined;
    try {
      const prompt = new AsyncSdkUserMessageQueue();
      return new ClaudeSdkLiveSession({
        owner: input.owner,
        sessionKey: input.sessionKey,
        cwd: input.cwd,
        holder: prepared.value.holder,
        abortController: prepared.abortController,
        prompt,
        query: prepared.value.warm.query(prompt),
        model: this.#options.model,
      });
    } catch (error) {
      prepared.abortController.abort();
      prepared.value.warm.close();
      this.#logger.info("backend.claude_sdk.prepared_start_consume_failed", {
        message: String(error),
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
        task: input.task,
        workerCtx: holder,
      }),
    }) as Query;
    return new ClaudeSdkLiveSession({
      owner: input.owner,
      sessionKey: input.sessionKey,
      cwd: input.cwd,
      holder,
      abortController,
      prompt,
      query: sdkQuery,
      model: input.model,
      task: input.task,
    });
  }

  #closeLiveSession(session: ClaudeSdkLiveSession): void {
    if (session.owner) {
      const key = JSON.stringify([
        session.owner.arcRunId,
        session.owner.routineId,
      ]);
      if (this.#liveSessions.get(key) === session)
        this.#liveSessions.delete(key);
    }
    session.owner = undefined;
    session.close();
  }

  #cacheLiveSession(session: ClaudeSdkLiveSession): void {
    const owner = session.owner;
    if (!owner || this.#stopped || !this.#sessionCache.maxIdleSessions) {
      this.#closeLiveSession(session);
      return;
    }
    const ownerKey = JSON.stringify([owner.arcRunId, owner.routineId]);
    if (this.#liveSessions.get(ownerKey) === session)
      this.#liveSessions.delete(ownerKey);
    const key = JSON.stringify([owner.arcRunId, session.sessionKey]);
    session.owner = undefined;
    session.holder.current = undefined;
    this.#retireIdleSession(key);
    const timer = setTimeout(() => {
      if (this.#idleSessions.get(key) === entry) this.#retireIdleSession(key);
    }, this.#sessionCache.idleTtlMs);
    timer.unref?.();
    const entry = {
      session,
      timer,
      expiresAt: Date.now() + this.#sessionCache.idleTtlMs,
    };
    this.#idleSessions.set(key, entry);
    while (this.#idleSessions.size > this.#sessionCache.maxIdleSessions) {
      this.#retireIdleSession(this.#idleSessions.keys().next().value!);
    }
  }

  #retireIdleSession(key: string): void {
    const entry = this.#idleSessions.get(key);
    if (!entry) return;
    this.#idleSessions.delete(key);
    clearTimeout(entry.timer);
    try {
      entry.session.close();
    } catch (error) {
      this.#idleCleanupFailure ??= new Error(
        `Claude idle session cleanup failed: ${String(error).slice(0, 1024)}`,
      );
      try {
        this.#logger.info("backend.claude_sdk.idle_cleanup_failed", {
          message: this.#idleCleanupFailure.message,
        });
      } catch {
        /* Diagnostics cannot prevent eviction or remaining cleanup. */
      }
    }
  }

  #buildOptions(input: {
    abortController: AbortController;
    cwd: string;
    model: string;
    resume?: string;
    workerCtx: ManagedWorkerToolContextSource;
    task?: Task;
  }): ClaudeSdkOptions {
    return {
      abortController: input.abortController,
      canUseTool: this.#canUseTool(input.workerCtx),
      cwd: input.cwd,
      mcpServers: {
        [WORKER_MCP_SERVER_NAME]: buildClaudeSdkMcpServer(
          input.workerCtx,
          this.#options.externalTools ?? [],
          input.task,
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
      // Arcade rechecks temporary grants on every permission-gated call.
      // SDK-wide rules would outlive our expiry and may widen the grant.
      return {
        behavior: "allow",
        updatedInput: verdict.updatedInput ?? input,
        toolUseID: options.toolUseID,
        decisionClassification: "user_temporary",
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
    grants: PermissionGrants,
    onReport: (report: RoutineReport) => void,
  ): ManagedWorkerToolContext {
    return {
      arcRunId: routine.arcRunId,
      routineId: routine.id,
      role: routine.role,
      backend: "claude-sdk",
      sessionKey,
      task: routine.task,
      questionAudienceReferences: renderQuestionAudienceReferencesForPrompt(
        routine.task,
        context,
        { kind: "host" },
      ),
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
  return {
    ...DEFAULT_SESSION_CACHE,
    ...input,
    maxIdleSessions:
      OptionalNonNegativeIntegerSchema.parse(input?.maxIdleSessions) ??
      DEFAULT_SESSION_CACHE.maxIdleSessions,
  };
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
