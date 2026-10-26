import { createHash } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  Agent,
  OpenAIProvider,
  Runner,
  tool,
  type RunState,
  type RunStreamEvent,
  type RunToolApprovalItem,
  type Tool,
  type ToolInputParameters,
} from "@openai/agents";
import {
  compaction,
  filesystem,
  Manifest,
  NoopSnapshotSpec,
  SandboxAgent,
  shell,
  type SandboxClient,
} from "@openai/agents/sandbox";
import {
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
  type UnixLocalSandboxClientOptions,
  type UnixLocalSandboxSessionState,
} from "@openai/agents/sandbox/local";
import * as z from "zod/v4";

import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import type { SecretResolver } from "../service/secrets.js";
import {
  SANDBOX_BUNDLE_ROOT,
  sandboxBundleRoot,
  WORKSPACE_SANDBOX_ROOT,
} from "../service/semantic-text-renderer.js";
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
import { routineTokenUsageFromOpenAiRun } from "../service/token-usage.js";
import {
  normalizeQuestionAudience,
  normalizeReplyAudience,
  validateAgentRoutineReport,
} from "../service/utils.js";
import { defineBackend, type Backend, type Worker } from "../types/backend.js";
import type { ExternalWorkerTool } from "../types/external-worker-tool.js";
import type { JsonValue } from "../types/json.js";
import type {
  PermissionVerdict,
  RoutineContext,
  RoutineDiagnostics,
  RoutineEffects,
  RoutineInput,
  RoutineReport,
  RoutineSignal,
} from "../types/routine.js";
import type { InstructionTask, SemanticTask, Task } from "../types/task.js";
import type { WorkerSlotKind } from "../types/worker-slot.js";
import {
  createWorkerSlotSchema,
  parseWorkerSlotSchema,
} from "../types/worker-slot.js";
import {
  backendRoutine,
  providerFailureReport,
  withBackendDetails,
  type BackendRoutine,
} from "./backend-support.js";
import {
  createContinuityController,
  type ResolveOpenAiContinuityIdentity,
} from "./continuity.js";
import {
  answersForQuestionForm,
  ASK_AUDIENCE_TOOL_NAME,
  AskAudienceInputSchema,
  DISCUSS_TOOL_NAME,
  DiscussInputSchema,
  EmitOutboundInputSchema,
  emitWorkerQuestion,
  invalidToolInputError,
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
import { resolveOpenAiApiKey } from "./openai-auth.js";

export const DEFAULT_OPENAI_SDK_MODEL = "gpt-5.5";
export const DEFAULT_OPENAI_SDK_TIMEOUT_MS = 10 * 60 * 1000;
const SUPPORTED_SLOT_KINDS: ReadonlySet<WorkerSlotKind> = new Set([
  "default",
  "role",
]);
const OpenAiWorkerSlotSchema = createWorkerSlotSchema({
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  cwd: z.string().min(1).optional(),
  baseUrl: z.url().optional(),
  apiKeySecret: z.string().min(1).optional(),
});

const MISSING_REPORT_RECOVERY_PROMPT = [
  "Your previous worker turn ended without calling the required report tool.",
  "Any assistant text you wrote remains private worker memory in this session.",
  "",
  "Continue the same assigned work:",
  "",
  '- If every obligation is complete, call report. For instruction work, pass exactly {"outcome":"completed"}. For semantic work, also include the required semantic object.',
  "- If work remains, continue it before reporting completion.",
  "- If required audience input has not been received, follow the shared audience-interaction policy and continue after the interaction tool returns its result.",
  '- If an error makes the work impossible to complete, call report with error "failed" and include the error message.',
  "",
  'Do not include code or message with outcome "completed". Do not add a plain assistant summary after the tool call.',
].join("\n");

/** OpenAI-private delivery through a parked SDK `RunState`. */
type OpenAiSdkResumeContext =
  | NonNullable<RoutineContext["routineResume"]>
  | { delivery: "native" };

type OpenAiNonStrictToolParameters = Extract<
  ToolInputParameters,
  { additionalProperties: true }
>;

type ApprovalState = {
  approve(item: RunToolApprovalItem): void;
  reject(item: RunToolApprovalItem, options?: { message: string }): void;
};

/** Sandbox shell tools gated behind per-call approval. */
export const APPROVAL_GATED_SHELL_TOOLS = new Set([
  "exec_command",
  "write_stdin",
]);

/** Mark named capability tools as approval-gated while preserving identity. */
export function gateToolApproval(
  names: ReadonlySet<string>,
): (tools: Tool<unknown>[]) => Tool<unknown>[] {
  return (tools) => {
    for (const candidate of tools) {
      if (names.has(candidate.name)) {
        Object.assign(candidate, { needsApproval: async () => true });
      }
    }
    return tools;
  };
}

/** Apply one command-scoped approval verdict without storing SDK-wide grants. */
export function applyApprovalVerdict(
  state: ApprovalState,
  item: RunToolApprovalItem,
  verdict: PermissionVerdict,
): void {
  if (verdict.decision === "deny") {
    state.reject(
      item,
      verdict.message ? { message: verdict.message } : undefined,
    );
  } else {
    state.approve(item);
  }
}

/** Translate an SDK interruption into Arcade's permission request shape. */
export function approvalRequest(item: RunToolApprovalItem): {
  toolName: string;
  input: Record<string, unknown>;
  callId: string;
} {
  const rawItem = item.rawItem as {
    callId?: string;
    id?: string;
    name?: string;
  };
  const toolName = item.toolName ?? item.name ?? rawItem.name ?? "unknown";
  const callId = rawItem.callId ?? rawItem.id ?? "";
  return { toolName, input: parseToolArguments(item.arguments), callId };
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildOpenAiSdkPrompt(
  task: Task,
  context: RoutineContext,
  resume: OpenAiSdkResumeContext | undefined,
  shouldPrimeDialog: boolean,
): string {
  if (resume?.delivery === "native") return "";
  return task.kind === "instruction"
    ? buildInstructionPrompt(task, context, resume, shouldPrimeDialog)
    : buildSemanticPrompt(task, context, resume, shouldPrimeDialog);
}

function buildInstructionPrompt(
  task: InstructionTask,
  context: RoutineContext,
  resume: OpenAiSdkResumeContext | undefined,
  shouldPrimeDialog: boolean,
): string {
  const rendered = renderInstructionTaskTextForPrompt(task, context, {
    kind: "sandbox",
    sandboxRoot: WORKSPACE_SANDBOX_ROOT,
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
  appendResumeMessage(parts, resume);
  const rules = [
    "- Use the available workspace tools as needed.",
    ...INSTRUCTION_EXECUTION_BOUNDARY_RULES.map((rule) => `- ${rule}`),
    "- After creating or editing a file, verify that it exists and contains the expected content before reporting completion.",
  ];
  if (audienceReferences.length > 0) {
    rules.push(
      "",
      "Audience references:",
      ...audienceReferences.map((ref) => `- ${ref.marker} -> ${ref.audience}`),
      "",
      "Use the mapped audience value in audience-tool calls. Do not copy an audience marker into delivered content or question text.",
      "When the instruction requires delivery to an audience listed above, use emit_outbound. Plain assistant text does not deliver that content.",
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
  resume: OpenAiSdkResumeContext | undefined,
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
            {
              kind: "sandbox",
              sandboxRoot: WORKSPACE_SANDBOX_ROOT,
            },
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
            kind: "sandbox",
            sandboxRoot: WORKSPACE_SANDBOX_ROOT,
          }),
          null,
          2,
        ),
      ),
    );
  }
  appendResumeMessage(parts, resume);
  const rules = [
    `Resolve this ${task.stage} semantic work.`,
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

function appendResumeMessage(
  parts: string[],
  resume: OpenAiSdkResumeContext | undefined,
): void {
  if (resume?.delivery !== "rendered-context") return;
  parts.push("", xmlBlock("resume-message", resume.message));
}

function buildOpenAiSdkTools(
  routine: BackendRoutine,
  context: RoutineContext,
  effects: RoutineEffects,
  onReport: (report: RoutineReport) => void,
  externalTools: readonly ExternalWorkerTool[],
): Tool[] {
  const outboundAudienceReferences =
    routine.task.kind === "instruction"
      ? renderInstructionAudienceReferencesForPrompt(routine.task, context, {
          kind: "sandbox",
          sandboxRoot: WORKSPACE_SANDBOX_ROOT,
        })
      : [];
  const baseTools = [
    tool({
      name: OUTBOUND_TOOL_NAME,
      description:
        'Deliver content to an audience named by the current instruction. The call returns {"ok":true} immediately and does not return an audience answer.',
      parameters: openAiToolParametersFromSchema(EmitOutboundInputSchema),
      strict: false,
      async execute(raw) {
        return runTool<unknown>(
          {
            logToolEvent: effects.logToolEvent,
          },
          {
            toolName: OUTBOUND_TOOL_NAME,
            run: async (toolCallId) => {
              let parsed: z.infer<typeof EmitOutboundInputSchema>;
              try {
                parsed = EmitOutboundInputSchema.parse(raw);
              } catch (error) {
                throw invalidToolInputError("emit_outbound input", error);
              }
              const { audience, content } = parsed;
              const targetAudience = normalizeReplyAudience(
                audience,
                outboundAudienceReferences,
              );
              if (targetAudience === undefined) {
                // Suppression is expected, not a failure. The worker should
                // receive a private success acknowledgement rather than a
                // delivery failure it may escalate into a failed routine.
                return {
                  value: { ok: true },
                  outcome: "ignored",
                };
              }
              try {
                await effects.emit({
                  situation: { audience: targetAudience, cause: "reply" },
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
              return { value: { ok: true }, outcome: "sent" };
            },
          },
        );
      },
    }),
    tool({
      name: DISCUSS_TOOL_NAME,
      description:
        'Collect freeform input from the originator or an authorized named audience. The call waits for the audience and returns {"answer":"..."}. The optional question adds a discussion prompt; omit it when audience-visible context already establishes what response is awaited. The prompt need not be phrased as a question.',
      parameters: openAiToolParametersFromSchema(DiscussInputSchema),
      strict: false,
      async execute(raw) {
        return runTool(
          {
            logToolEvent: effects.logToolEvent,
          },
          {
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
                outboundAudienceReferences,
              );
              const answer = await emitWorkerQuestion(
                effects.emit,
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
                value: { answer },
                outcome: "answered",
              };
            },
          },
        );
      },
    }),
    tool({
      name: ASK_AUDIENCE_TOOL_NAME,
      description:
        'Collect structured input from the originator or an authorized named audience using questions with predefined choices. The call waits for the audience, validates the response, and returns {"answers":{...}}.',
      parameters: openAiToolParametersFromSchema(AskAudienceInputSchema),
      strict: false,
      async execute(raw) {
        return runTool(
          {
            logToolEvent: effects.logToolEvent,
          },
          {
            toolName: ASK_AUDIENCE_TOOL_NAME,
            run: async (toolCallId) => {
              let parsed: ReturnType<typeof parseAskAudienceInput>;
              try {
                parsed = parseAskAudienceInput(raw);
              } catch (error) {
                throw invalidToolInputError("ask_audience input", error);
              }
              const targetAudience = normalizeQuestionAudience(
                parsed.audience,
                outboundAudienceReferences,
              );
              const answer = await emitWorkerQuestion(
                effects.emit,
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
                value: {
                  answers: answersForQuestionForm(parsed.questions, answer),
                },
                outcome: "answered",
              };
            },
          },
        );
      },
    }),
    tool({
      name: REPORT_TOOL_NAME,
      description:
        'Finalize the current assigned task. For completed instruction work, pass exactly {"outcome":"completed"}; include semantic only for semantic work. For a terminal failure, pass {"error":"failed","code":"...","message":"..."}.',
      parameters: openAiToolParameters(REPORT_PARAMETERS),
      strict: false,
      async execute(raw) {
        // Pausing before finalizing the report is intentionally disabled.
        // A safe between-tool pause must halt after a tool result is
        // committed and before the next model turn, so the resumed transcript has
        // no dangling tool call — via the SDK's cooperative interrupt in streaming
        // mode (streamed-run cancel + responseId resume), not a swallowed throw or
        // a blunt abort. Pause stays honored at the routine boundary.
        const report = validateAgentRoutineReport(
          normalizeRoutineReportInput(raw, routine.task),
          "report tool input",
        );
        onReport(report);
        return { ok: true };
      },
    }),
  ];
  return [
    ...baseTools,
    ...externalTools.map((externalTool) =>
      tool({
        name: externalTool.name,
        description: externalTool.description,
        parameters: openAiToolParameters(externalTool.jsonSchema),
        strict: false,
        async execute(raw) {
          return runTool(
            {
              logToolEvent: effects.logToolEvent,
            },
            {
              toolName: externalTool.name,
              run: async () => ({
                value: await externalTool.execute(
                  raw && typeof raw === "object"
                    ? (raw as Record<string, unknown>)
                    : {},
                  {
                    arcRunId: routine.arcRunId,
                    routineId: routine.id,
                    role: routine.role,
                    task: routine.task,
                    cwd: context.workspacePath,
                    workspacePath: context.workspacePath,
                    logToolEvent: effects.logToolEvent,
                  },
                ),
                outcome: "answered",
              }),
            },
          );
        },
      }),
    ),
  ];
}

const REPORT_PARAMETERS = {
  oneOf: [
    {
      type: "object",
      properties: {
        outcome: { const: "completed" },
        semantic: {
          type: "object",
          additionalProperties: true,
        },
      },
      required: ["outcome"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        error: { const: "failed" },
        code: { type: "string", minLength: 1 },
        message: { type: "string" },
      },
      required: ["error", "message"],
      additionalProperties: false,
    },
  ],
};

/** Derive the SDK declaration from Arcade's canonical runtime schema. */
function openAiToolParametersFromSchema(
  schema: z.ZodType,
): OpenAiNonStrictToolParameters {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema);
  return {
    ...jsonSchema,
    additionalProperties: true,
  } as OpenAiNonStrictToolParameters;
}

/** Adapt an existing JSON Schema to the SDK's narrower declaration type. */
function openAiToolParameters(schema: unknown): OpenAiNonStrictToolParameters {
  return schema as OpenAiNonStrictToolParameters;
}

/** Materialize workspace bundles inside the OpenAI sandbox root. */
async function materializeOpenAiWorkspaceBundles(
  cwd: string,
  bundle: Readonly<Record<string, string>>,
  touched: Set<string>,
): Promise<void> {
  const sandboxToHost = (sandboxPath: string): string =>
    join(cwd, relative(WORKSPACE_SANDBOX_ROOT, sandboxPath));
  const bundleRoot = sandboxToHost(SANDBOX_BUNDLE_ROOT);
  await rm(bundleRoot, { recursive: true, force: true });
  const prefixes = Object.keys(bundle);
  if (prefixes.length === 0) return;
  touched.add(bundleRoot);
  for (const prefix of prefixes) {
    await cp(bundle[prefix]!, sandboxToHost(sandboxBundleRoot(prefix)), {
      recursive: true,
    });
  }
}

export type OpenAiSdkRoutineOptions = {
  model?: string;
  timeoutMs?: number;
};

export type OpenAiSdkRunResult = {
  failureReport?: RoutineReport;
  finalOutput?: unknown;
  lastResponseId?: string;
  history?: unknown;
  rawResponses?: readonly unknown[];
  streamEvents?: readonly unknown[];
  runContext?: unknown;
  state?: OpenAiRunState;
  cancelled?: boolean;
  /** Control signal that stopped the run at a tool boundary. */
  signal?: RoutineSignal;
};

export type OpenAiRunState = RunState<unknown, Agent<any, any>>;

export type OpenAiSdkRunFn = (input: {
  agent: Agent<any, any>;
  prompt?: string;
  apiKey: string;
  baseUrl?: string;
  abortController: AbortController;
  maxTurns: number;
  previousResponseId?: string;
  resumeState?: OpenAiRunState;
  checkSignal: () => Promise<RoutineSignal | undefined>;
  /**
   * Resolve a gated tool call to allow/deny/allow_this_run. Required: there is
   * no silent-allow default, so a missing wiring surfaces as a type error rather
   * than an ungated worker.
   */
  resolveApproval: (req: {
    toolName: string;
    input: Record<string, unknown>;
    callId: string;
  }) => Promise<PermissionVerdict>;
  diagnostics: RoutineDiagnostics;
  sandboxClient: SandboxClient<
    UnixLocalSandboxClientOptions,
    UnixLocalSandboxSessionState
  >;
}) => Promise<OpenAiSdkRunResult>;

export type OpenAiSdkBackendOptions = {
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** Optional cwd override; its owner must supply and manage a usable directory. */
  cwd?: string;
  apiKey?: string;
  apiKeySecret?: string;
  secretResolver?: SecretResolver;
  externalTools?: readonly ExternalWorkerTool[];
  routineOptions?: (input: {
    routine: RoutineInput["routine"];
    context: RoutineContext;
  }) => OpenAiSdkRoutineOptions | undefined;
  /** Identity required before Arcade may reuse durable provider continuity. */
  resolveContinuityIdentity?: ResolveOpenAiContinuityIdentity;
};

/** Test-only transport seams for the stock OpenAI backend. */
export type OpenAiSdkBackendTestOptions = OpenAiSdkBackendOptions & {
  logger?: ArcadeLogger;
  run?: OpenAiSdkRunFn;
  onResponseObserved?: (input: {
    routine: RoutineInput["routine"];
    sessionKey: string;
    responseId: string;
    cwd: string;
  }) => Promise<void> | void;
};

/** Construct the stock OpenAI implementation with code-supplied dependencies. */
export function createOpenAiSdkBackend(
  options: OpenAiSdkBackendOptions = {},
): Backend {
  return createOpenAiSdkBackendForTesting(options);
}

/** Construct the stock backend with an injectable SDK runner for tests. */
export function createOpenAiSdkBackendForTesting(
  options: OpenAiSdkBackendTestOptions = {},
): Backend {
  return defineBackend({
    supportedSlotKinds: SUPPORTED_SLOT_KINDS,
    workerSlotSchema: OpenAiWorkerSlotSchema,
    createWorker(host, slot) {
      const config = slot;
      let continuity!: ReturnType<typeof createContinuityController>;
      const worker = new OpenAiSdkWorker({
        ...options,
        logger: host.logger,
        model: config.model ?? options.model,
        timeoutMs: config.timeoutMs ?? options.timeoutMs,
        cwd: config.cwd ?? options.cwd,
        baseUrl: config.baseUrl ?? options.baseUrl,
        apiKeySecret: config.apiKeySecret ?? options.apiKeySecret,
        onResponseObserved: async (observed) => {
          await options.onResponseObserved?.(observed);
          await continuity.persistObserved(
            observed.routine,
            observed.sessionKey,
            observed.responseId,
            observed.cwd,
          );
        },
      });
      continuity = createContinuityController({
        backend: "openai-sdk",
        host,
        slot,
        configuredCwd: config.cwd ?? options.cwd,
        resolveIdentity:
          options.resolveContinuityIdentity ??
          defaultOpenAiContinuityIdentity(options),
        continuityField: "responseId",
        seed: (contextKey, responseId, cwd) =>
          worker.seedSession(contextKey, responseId, cwd),
        clear: (contextKey) => worker.clearSession(contextKey),
      });
      return {
        warm: (input) => continuity.warm(input),
        async run(input) {
          const nativeResume = openAiNativeResume(input);
          try {
            await continuity.prepareRun(input, {
              preserveLiveContinuation:
                nativeResume !== undefined ||
                worker.hasRetryState(input.routine.id),
            });
            const report = await worker.run(input, nativeResume);
            continuity.finish(
              input.routine.id,
              report.suspension !== undefined,
            );
            return report;
          } catch (error) {
            continuity.fail(input.routine.id);
            const report = providerFailureReport(error, "openai-sdk");
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

function defaultOpenAiContinuityIdentity(
  options: OpenAiSdkBackendOptions,
): ResolveOpenAiContinuityIdentity {
  return async ({ slot }) => {
    const config = parseWorkerSlotSchema(OpenAiWorkerSlotSchema, slot);
    const apiKey =
      options.apiKey ??
      (
        await resolveOpenAiApiKey({
          secretRef: config.apiKeySecret ?? options.apiKeySecret,
          secretResolver: options.secretResolver,
        })
      ).apiKey;
    return {
      schema: 1,
      provider: "openai",
      endpoint:
        config.baseUrl ?? options.baseUrl ?? "https://api.openai.com/v1",
      credentialScope: createHash("sha256").update(apiKey).digest("hex"),
    };
  };
}

function openAiNativeResume(
  input: RoutineInput,
): OpenAiSdkResumeContext | undefined {
  return input.context.routineResume?.delivery === "rendered-context"
    ? { delivery: "native" }
    : undefined;
}

type StoredOpenAiSession = {
  responseId: string;
  cwd: string;
};

/** Tool-capable backend backed by OpenAI Agents SDK SandboxAgent. */
export class OpenAiSdkWorker implements Worker {
  readonly #options: Required<
    Pick<OpenAiSdkBackendTestOptions, "model" | "timeoutMs">
  > &
    Omit<OpenAiSdkBackendTestOptions, "model" | "timeoutMs">;
  readonly #run: OpenAiSdkRunFn;
  readonly #logger: ArcadeLogger;
  readonly #sessions = new Map<string, StoredOpenAiSession>();
  readonly #retryStates = new Map<
    string,
    {
      state: OpenAiRunState;
      arcRunId: RoutineInput["routine"]["arcRunId"];
      cwd: string;
      model: string;
      report?: RoutineReport;
    }
  >();

  hasRetryState(routineId: string): boolean {
    return this.#retryStates.has(routineId);
  }
  readonly #parkedStates = new Map<
    string,
    {
      state: OpenAiRunState;
      cwd: string;
      model: string;
      owner: Parameters<Worker["disposeRoutine"]>[0];
    }
  >();
  /**
   * Remembered `allow_this_run` grants per session key, so an approval persists
   * across routines in the same session (mirrors the Claude SDK backend).
   */
  readonly #grants = new Map<string, PermissionGrant[]>();
  /** Workspace bundle roots materialized this process, removed on stop(). */
  readonly #touchedBundleDirs = new Set<string>();

  constructor(options: OpenAiSdkBackendTestOptions) {
    this.#options = {
      ...options,
      model: options.model ?? DEFAULT_OPENAI_SDK_MODEL,
      timeoutMs: options.timeoutMs ?? DEFAULT_OPENAI_SDK_TIMEOUT_MS,
    };
    this.#run = options.run ?? defaultOpenAiSdkRun;
    this.#logger = options.logger ?? createArcadeLogger();
  }

  seedSession(sessionKey: string, responseId: string, cwd: string): void {
    if (!this.#sessions.has(sessionKey)) {
      this.#sessions.set(sessionKey, { responseId, cwd });
    }
  }

  clearSession(sessionKey: string): void {
    this.#sessions.delete(sessionKey);
    this.#parkedStates.delete(sessionKey);
    this.#grants.delete(sessionKey);
  }

  async disposeRoutine(
    input: Parameters<Worker["disposeRoutine"]>[0],
  ): Promise<void> {
    if (this.#retryStates.get(input.routineId)?.arcRunId === input.arcRunId)
      this.#retryStates.delete(input.routineId);
    for (const [key, parked] of this.#parkedStates) {
      if (
        parked.owner.routineId === input.routineId &&
        parked.owner.arcRunId === input.arcRunId
      )
        this.#parkedStates.delete(key);
    }
  }

  async stop(): Promise<void> {
    this.#retryStates.clear();
    this.#parkedStates.clear();
    // The OpenAI SDK backend owns no long-lived transport. Best-effort removal
    // of materialized bundle copies; reset-on-entry is the real guarantee, so a
    // missed cleanup (e.g. crash) self-heals on the next run.
    for (const dir of this.#touchedBundleDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.#touchedBundleDirs.clear();
  }

  async run(
    input: RoutineInput,
    nativeResume?: OpenAiSdkResumeContext,
  ): Promise<RoutineReport> {
    const { context, effects, diagnostics } = input;
    const routine = backendRoutine(input);
    const sessionKey = routine.contextKey;
    const currentCwd = this.#options.cwd ?? context.workspacePath;
    const resume = nativeResume ?? context.routineResume;
    const nativeState = this.#parkedStates.get(sessionKey);
    const parked =
      this.#retryStates.get(routine.id) ??
      (resume?.delivery === "native" &&
      nativeState?.owner.routineId === routine.id &&
      nativeState.owner.arcRunId === routine.arcRunId
        ? nativeState
        : undefined);
    if (resume?.delivery === "native" && !parked) {
      throw new Error(
        `OpenAI SDK routine ${routine.id} has no parked RunState to resume.`,
      );
    }
    const cwd = parked?.cwd ?? currentCwd;
    const renderContext =
      this.#options.cwd !== undefined || parked !== undefined
        ? { ...context, workspacePath: cwd }
        : context;
    const selected = this.#options.routineOptions?.({ routine, context });
    const currentModel = selected?.model ?? this.#options.model;
    const model = parked?.model ?? currentModel;
    const timeoutMs = selected?.timeoutMs ?? this.#options.timeoutMs;
    const seeded = this.#sessions.get(sessionKey);
    const previousResponseId =
      seeded && seeded.cwd === cwd ? seeded.responseId : undefined;
    if (seeded && seeded.cwd !== cwd) {
      this.#logger.info("backend.openai_sdk.resume_skipped", {
        sessionKey,
        routineId: routine.id,
        storedCwd: seeded.cwd,
        cwd,
      });
    }

    // A threaded run (previousResponseId set) continues a server-side response
    // chain that already holds the dialog; prime it only on a fresh thread.
    const shouldPrimeDialog = previousResponseId === undefined;
    const prompt = buildOpenAiSdkPrompt(
      routine.task,
      renderContext,
      resume,
      shouldPrimeDialog,
    );
    // Materialize workspace bundles as in-root copies (reset-on-entry) so the
    // worker reads them via masked `/.arcade-bundles/<prefix>` paths rather than
    // an out-of-workspace mount. Runs on every entry, including recovery and
    // resume (resume is a fresh run(): #parkedStates is in-memory only).
    await materializeOpenAiWorkspaceBundles(
      cwd,
      renderContext.workspaceBundle,
      this.#touchedBundleDirs,
    );
    await diagnostics.writeText("prompt", prompt);
    const startedAt = Date.now();

    let report: RoutineReport | undefined = this.#retryStates.get(
      routine.id,
    )?.report;
    const onReport = (value: RoutineReport) => {
      report ??= value;
    };
    const tools = buildOpenAiSdkTools(
      routine,
      renderContext,
      effects,
      onReport,
      this.#options.externalTools ?? [],
    );
    const agent = this.#agent({
      role: routine.role,
      model,
      tools,
    });

    let grants = this.#grants.get(sessionKey);
    if (!grants) {
      grants = [];
      this.#grants.set(sessionKey, grants);
    }
    const workerCtx = this.#workerContext({
      routine,
      context: renderContext,
      effects,
      cwd,
      sessionKey,
      diagnostics,
      grants,
      onReport,
    });
    const resolveApproval = (req: {
      toolName: string;
      input: Record<string, unknown>;
      callId: string;
    }) =>
      resolveWorkerPermission(
        workerCtx,
        req.callId,
        req.toolName,
        req.input,
        this.#logger,
      );
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    timeout.unref?.();

    let backendDetails: JsonValue = {
      backend: "openai-sdk",
      sessionKey,
      ...(previousResponseId !== undefined
        ? { responseId: previousResponseId }
        : {}),
      cwd,
      model,
    };

    this.#logger.info("backend.openai_sdk.started", {
      sessionKey,
      contextIsolation: routine.task.contextIsolation,
      routineId: routine.id,
      role: routine.role,
      cwd,
      model,
      previousResponseId,
    });

    let result: OpenAiSdkRunResult | undefined;
    try {
      result = await this.#run({
        agent,
        prompt: parked ? undefined : prompt,
        apiKey: await this.#apiKey(),
        baseUrl: this.#options.baseUrl,
        abortController,
        maxTurns: 24,
        previousResponseId,
        resumeState: parked?.state,
        checkSignal: effects.checkSignal,
        resolveApproval,
        diagnostics,
        sandboxClient: this.#sandboxClient(cwd),
      });
      if (result.signal?.kind === "cancel") {
        await this.disposeRoutine({
          arcRunId: routine.arcRunId,
          routineId: routine.id,
        });
        return withBackendDetails(
          { cancellation: "superseded" },
          backendDetails,
        );
      }
      if (result.failureReport) {
        if (result.state)
          this.#retryStates.set(routine.id, {
            arcRunId: routine.arcRunId,
            state: result.state,
            cwd,
            model,
            report,
          });
        else this.#retryStates.delete(routine.id);
        return withBackendDetails(result.failureReport, backendDetails);
      }
      this.#retryStates.delete(routine.id);
      if (result.signal?.kind === "pause" && result.state) {
        this.#parkedStates.set(sessionKey, {
          state: result.state,
          cwd,
          model,
          owner: { arcRunId: routine.arcRunId, routineId: routine.id },
        });
        return withBackendDetails({ suspension: "paused" }, backendDetails);
      }
      if (result.signal?.kind === "pause" && !result.state) {
        // Invariant: a streamed run is always RunState-backed, so a paused +
        // cancelled result should always carry state. Surface a violation rather
        // than silently parking nothing; fall through so the routine is not
        // stranded in a pause path (it completes or runs missing-report recovery).
        this.#logger.info("backend.openai_sdk.pause_without_state", {
          sessionKey,
          routineId: routine.id,
        });
      }
      const primaryUsage = routineTokenUsageFromOpenAiRun(result);
      if (primaryUsage) await effects.recordTokenUsage(primaryUsage);
      await diagnostics.writeJson("sdk-result", summarizeRun(result));
      if (result.lastResponseId) {
        await this.#options.onResponseObserved?.({
          routine,
          sessionKey,
          responseId: result.lastResponseId,
          cwd,
        });
      }

      if (!report) {
        this.#logger.info("backend.openai_sdk.missing_report_recovery", {
          sessionKey,
          routineId: routine.id,
          role: routine.role,
          responseId: result.lastResponseId ?? previousResponseId,
          attempt: 1,
        });
        const recovery = await this.#run({
          agent,
          prompt: MISSING_REPORT_RECOVERY_PROMPT,
          apiKey: await this.#apiKey(),
          baseUrl: this.#options.baseUrl,
          abortController,
          maxTurns: 4,
          previousResponseId: result.lastResponseId ?? previousResponseId,
          checkSignal: effects.checkSignal,
          resolveApproval,
          diagnostics,
          sandboxClient: this.#sandboxClient(cwd),
        });
        if (recovery.signal?.kind === "cancel") {
          await this.disposeRoutine({
            arcRunId: routine.arcRunId,
            routineId: routine.id,
          });
          return withBackendDetails(
            { cancellation: "superseded" },
            backendDetails,
          );
        }
        if (recovery.failureReport) {
          if (recovery.state)
            this.#retryStates.set(routine.id, {
              arcRunId: routine.arcRunId,
              state: recovery.state,
              cwd,
              model,
              report,
            });
          return withBackendDetails(recovery.failureReport, backendDetails);
        }
        if (recovery.signal?.kind === "pause" && recovery.state) {
          this.#parkedStates.set(sessionKey, {
            state: recovery.state,
            cwd,
            model,
            owner: { arcRunId: routine.arcRunId, routineId: routine.id },
          });
          return withBackendDetails({ suspension: "paused" }, backendDetails);
        }
        result = recovery;
        if (recovery.lastResponseId) {
          await this.#options.onResponseObserved?.({
            routine,
            sessionKey,
            responseId: recovery.lastResponseId,
            cwd,
          });
        }
        const recoveryUsage = routineTokenUsageFromOpenAiRun(recovery);
        if (recoveryUsage) await effects.recordTokenUsage(recoveryUsage);
        await diagnostics.writeJson(
          "sdk-result-recovery",
          summarizeRun(recovery),
        );
      }

      if (!report) {
        this.#logger.info("backend.openai_sdk.missing_report_failed", {
          sessionKey,
          routineId: routine.id,
          role: routine.role,
          responseId: result.lastResponseId ?? previousResponseId,
          attempts: 1,
        });
        throw new Error(
          "OpenAI SDK worker did not call the required report tool before exiting.",
        );
      }
      if (result.lastResponseId) {
        this.#sessions.set(sessionKey, {
          responseId: result.lastResponseId,
          cwd,
        });
      }
      if (resume?.delivery === "native") {
        this.#parkedStates.delete(sessionKey);
      }
      backendDetails = {
        backend: "openai-sdk",
        sessionKey,
        ...(result.lastResponseId !== undefined
          ? { responseId: result.lastResponseId }
          : {}),
        cwd,
        model,
        durationMs: Date.now() - startedAt,
      };
      this.#logger.info("backend.openai_sdk.finished", {
        sessionKey,
        contextIsolation: routine.task.contextIsolation,
        routineId: routine.id,
        role: routine.role,
        responseId: result.lastResponseId,
      });
      return withBackendDetails(report, backendDetails);
    } catch (error) {
      this.#retryStates.delete(routine.id);
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
      if (timedOut) {
        throw new Error(`OpenAI SDK timed out after ${timeoutMs}ms.`);
      }
      await diagnostics
        .writeJson("sdk-error", summarizeError(error))
        .catch(() => undefined);
      this.#logger.info("backend.openai_sdk.failed", {
        sessionKey,
        contextIsolation: routine.task.contextIsolation,
        routineId: routine.id,
        message: error instanceof Error ? error.message : String(error),
        result: previewLogValue(result ?? null),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  #agent(input: {
    role: string;
    model: string;
    tools: Agent<any, any>["tools"];
  }): SandboxAgent<any, any> {
    // No workspace mount: #sandboxClient roots the session at the workspace.
    // `Capabilities.default()` is [filesystem(), shell(), compaction()]; we spell
    // it out so shell's host-unconfined tools are approval-gated. Filesystem is
    // left ungated because the sandbox confines every file path to the workspace
    // root (WorkspacePathPolicy), matching Claude's in-workspace auto-approval.
    return new SandboxAgent({
      name: `Arcade ${input.role}`,
      instructions: WORKER_INTERACTION_SYSTEM_PROMPT,
      model: input.model,
      tools: input.tools,
      capabilities: [
        filesystem(),
        shell({ configureTools: gateToolApproval(APPROVAL_GATED_SHELL_TOOLS) }),
        compaction(),
      ],
    });
  }

  /**
   * Build the per-routine context the shared permission policy needs to escalate
   * gated tool calls and remember grants. Mirrors the Claude SDK backend's
   * worker context; the permission machinery is backend-agnostic.
   */
  #workerContext(input: {
    routine: BackendRoutine;
    context: RoutineContext;
    effects: RoutineEffects;
    cwd: string;
    sessionKey: string;
    diagnostics: RoutineDiagnostics;
    grants: PermissionGrant[];
    onReport: (report: RoutineReport) => void;
  }): ManagedWorkerToolContext {
    const { routine, context, effects, cwd, sessionKey, diagnostics, grants } =
      input;
    return {
      arcRunId: routine.arcRunId,
      routineId: routine.id,
      role: routine.role,
      backend: "openai-sdk",
      sessionKey,
      task: routine.task,
      outboundAudienceReferences:
        routine.task.kind === "instruction"
          ? renderInstructionAudienceReferencesForPrompt(
              routine.task,
              context,
              {
                kind: "sandbox",
                sandboxRoot: WORKSPACE_SANDBOX_ROOT,
              },
            )
          : [],
      diagnostics,
      cwd,
      workspacePath: context.workspacePath,
      emit: async (emitInput) =>
        effects.emit({
          situation: {
            audience: emitInput.situation.audience,
            cause: emitInput.situation.cause,
          },
          content: emitInput.content,
          metadata: emitInput.metadata,
        }),
      logToolEvent: effects.logToolEvent,
      resolveReport: input.onReport,
      requestPermission: effects.requestPermission,
      grants,
    };
  }

  // Shell commands run as host child processes with the host's full filesystem
  // and network (UnixLocalSandboxClient confines only the workdir, not the
  // command body), so exec_command/write_stdin are gated per-call through
  // needsApproval -> resolveWorkerPermission (allow/deny/allow_this_run), the
  // same policy the Claude SDK backend applies via canUseTool. A
  // network-restricted sandbox (Docker/egress proxy) remains available as
  // defense in depth if open egress is later disallowed.
  // Root the session directly at the workspace, named WORKSPACE_SANDBOX_ROOT.
  // The default client can't: it always mkdtemps an ephemeral owned root and
  // forbids mounting over the root, forcing a child /workspace symlink whose host
  // target escapes the mask and leaks via pwd. A named root masks pwd to
  // /workspace (the worker's prior, round-trips as a workdir) while leaving real
  // system paths (/dev/null, /etc) untouched — only "/workspace" is translated.
  // workspaceRootOwned:false keeps close() from deleting the workspace;
  // serialize/resume delegate to a real client and round-trip the unowned state.
  #sandboxClient(
    cwd: string,
  ): SandboxClient<
    UnixLocalSandboxClientOptions,
    UnixLocalSandboxSessionState
  > {
    const inner = new UnixLocalSandboxClient({});
    return {
      backendId: "unix_local",
      supportsDefaultOptions: true,
      create: async () => {
        const manifest = new Manifest({ root: WORKSPACE_SANDBOX_ROOT });
        return new UnixLocalSandboxSession({
          state: {
            manifest,
            workspaceRootPath: cwd,
            workspaceRootOwned: false,
            environment: await manifest.resolveEnvironment(),
            // Noop (not null) disables snapshot persist/restore; a durable root
            // needs none, and null would snapshot and could clobber on resume.
            snapshotSpec: new NoopSnapshotSpec(),
            snapshot: null,
            configuredExposedPorts: [],
          },
        });
      },
      resume: (state, options) => inner.resume(state, options),
      serializeSessionState: (state) => inner.serializeSessionState(state),
      deserializeSessionState: (state) => inner.deserializeSessionState(state),
    };
  }

  async #apiKey(): Promise<string> {
    return (
      this.#options.apiKey ??
      (
        await resolveOpenAiApiKey({
          secretRef: this.#options.apiKeySecret,
          secretResolver: this.#options.secretResolver,
        })
      ).apiKey
    );
  }
}

async function defaultOpenAiSdkRun({
  agent,
  prompt,
  apiKey,
  baseUrl: baseURL,
  abortController,
  maxTurns,
  previousResponseId,
  resumeState,
  checkSignal,
  resolveApproval,
  diagnostics,
  sandboxClient,
}: Parameters<OpenAiSdkRunFn>[0]): Promise<OpenAiSdkRunResult> {
  const runner = new Runner({
    modelProvider: new OpenAIProvider({ apiKey, baseURL }),
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: "Arcade OpenAI SDK Worker",
  });
  let runInput: string | OpenAiRunState | undefined = resumeState ?? prompt;
  if (runInput === undefined) {
    throw new Error("OpenAI SDK run requires a prompt or resume state.");
  }
  let prevId = previousResponseId;
  if (resumeState) {
    // Bind resumed tool execution to this invocation's effects and report sink.
    resumeState._currentAgent = agent;
    prevId = undefined;
  }
  const startLeg = () =>
    runner.run(agent, runInput as string | OpenAiRunState, {
      stream: true,
      signal: abortController.signal,
      maxTurns,
      previousResponseId: prevId,
      sandbox: { client: sandboxClient },
      toolNotFoundBehavior: "return_error_to_model",
    });

  let signal: RoutineSignal | undefined;
  const streamEvents: unknown[] = [];
  const rawResponses: unknown[] = [];
  // Resume loop: each leg streams to completion, then any tool-approval
  // interruptions are resolved through Arcade's policy and the run is resumed
  // from the same RunState. A requested pause takes priority and parks the run.
  let stream;
  try {
    stream = await startLeg();
  } catch (error) {
    const failureReport = providerFailureReport(error, "openai-sdk");
    if (failureReport?.suspension && resumeState) {
      return { failureReport, state: resumeState };
    }
    throw error;
  }
  for (;;) {
    // Land a requested pause at a tool-completion boundary. A `tool_output` run
    // item means the tool finished and its output is recorded in the RunState, so
    // aborting here parks a state with no orphaned tool call; resume reruns it and
    // the model continues the turn from the recorded outputs. We cannot gate on
    // `state._currentTurnInProgress === false` here: the run loop flips that flag
    // false→true at a turn boundary without yielding any stream event in the false
    // window, so a per-event check almost never observes it.
    try {
      for await (const event of stream) {
        const diagnosticEvent = summarizeRunStreamEvent(event);
        streamEvents.push(diagnosticEvent);
        await diagnostics.appendJsonl("sdk-events", diagnosticEvent);
        if (
          event.type === "run_item_stream_event" &&
          event.name === "tool_output" &&
          (signal = await checkSignal())
        ) {
          abortController.abort();
          break;
        }
      }
    } catch (error) {
      await diagnostics
        .writeJson("sdk-error", summarizeError(error))
        .catch(() => undefined);
      await stream.completed.catch(() => undefined);
      const failureReport = providerFailureReport(error, "openai-sdk");
      if (
        failureReport?.suspension &&
        stream.state._currentStep?.type === "next_step_run_again"
      ) {
        await diagnostics.writeJson("sdk-retry-state", {
          continuation: "retained",
          step: stream.state._currentStep.type,
          historyLength: stream.history.length,
          responseId: stream.lastResponseId,
        });
        return { failureReport, state: stream.state as OpenAiRunState };
      }
      if (failureReport?.suspension) {
        return {
          failureReport: {
            error: "failed",
            code: "unsafe-provider-resume",
            message:
              "OpenAI SDK execution cannot safely resume after provider interruption.",
          },
        };
      }
      throw error;
    }
    await stream.completed.catch(() => undefined);
    if (stream.rawResponses) rawResponses.push(...stream.rawResponses);
    if (signal) break;

    const pending = stream.state.getInterruptions();
    if (pending.length === 0) break;
    for (const item of pending) {
      const verdict = await resolveApproval(approvalRequest(item));
      applyApprovalVerdict(stream.state, item, verdict);
    }
    // Resume from the RunState, which carries its own response chain.
    runInput = stream.state as OpenAiRunState;
    prevId = undefined;
    try {
      stream = await startLeg();
    } catch (error) {
      const failureReport = providerFailureReport(error, "openai-sdk");
      if (failureReport?.suspension) {
        return { failureReport, state: runInput as OpenAiRunState };
      }
      throw error;
    }
  }

  return {
    finalOutput: signal ? undefined : stream.finalOutput,
    lastResponseId: stream.lastResponseId,
    rawResponses,
    history: stream.history,
    streamEvents,
    runContext: stream.runContext,
    state: stream.state as OpenAiRunState,
    cancelled: stream.cancelled,
    signal,
  };
}

function summarizeRun(result: OpenAiSdkRunResult): Record<string, unknown> {
  return {
    finalOutput: result.finalOutput,
    lastResponseId: result.lastResponseId,
    tokenUsage: routineTokenUsageFromOpenAiRun(result),
    rawResponseCount: result.rawResponses?.length,
    streamEventCount: result.streamEvents?.length,
    historyLength: Array.isArray(result.history)
      ? result.history.length
      : undefined,
  };
}

function summarizeRunStreamEvent(
  event: RunStreamEvent,
): Record<string, unknown> {
  if (event.type === "agent_updated_stream_event") {
    return {
      type: event.type,
      agent: event.agent.name,
    };
  }
  if (event.type === "run_item_stream_event") {
    return {
      type: event.type,
      name: event.name,
      item: toJsonSafe(event.item),
    };
  }
  return {
    type: event.type,
    source: event.source,
    data: toJsonSafe(event.data),
  };
}

function summarizeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: toJsonSafe(error.cause),
    };
  }
  return { message: String(error), value: toJsonSafe(error) };
}

function toJsonSafe(value: unknown): unknown {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : JSON.parse(text);
  } catch {
    return previewLogValue(value);
  }
}
