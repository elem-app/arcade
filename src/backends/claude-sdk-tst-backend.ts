import {
  query,
  startup,
  type Options as ClaudeSdkOptions,
  type SDKMessage,
  type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PreparedStartPool } from "./prepared-start-pool.js";

import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import {
  buildSemanticPrompt,
  buildSemanticSystemPrompt,
  parseAgentJsonOutput,
} from "../service/semantic-resolver.js";
import { routineTokenUsageFromClaudeSdkMessages } from "../service/token-usage.js";
import { isRecord, validateAgentRoutineReport } from "../service/utils.js";
import { defineBackend, type Backend, type Worker } from "../types/backend.js";
import type { JsonValue } from "../types/json.js";
import type { RoutineInput, RoutineReport } from "../types/routine.js";
import type { SemanticTask } from "../types/task.js";
import type { WorkerSlotKind } from "../types/worker-slot.js";
import { createWorkerSlotSchema } from "../types/worker-slot.js";
import {
  readRetention,
  registerRetentionProbe,
  type PreparedStartPoolRetention,
} from "../utils/retention-registry.js";
import {
  backendRoutine,
  providerFailureReport,
  withBackendDetails,
} from "./backend-support.js";

const SUPPORTED_SLOT_KINDS: ReadonlySet<WorkerSlotKind> = new Set([
  "fast-trigger",
]);
const OptionalPositiveIntegerSchema = z.number().int().positive().optional();
const OptionalNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .optional();
const FastStartsSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    maxPreparedStarts: OptionalNonNegativeIntegerSchema,
    idleTtlMs: OptionalPositiveIntegerSchema,
    initializeTimeoutMs: OptionalPositiveIntegerSchema,
  })
  .optional();
const ClaudeTstWorkerSlotSchema = createWorkerSlotSchema({
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  cwd: z.string().min(1).optional(),
  fastStarts: FastStartsSchema,
});

export const DEFAULT_CLAUDE_SDK_TST_MODEL = "claude-haiku-4-5";
const DEFAULT_CLAUDE_SDK_TST_TIMEOUT_MS = 60_000;

/** Query function used by the Claude Agent SDK tst backend. */
export type ClaudeSdkTstQueryFn = typeof query;

/** Startup function used by the Claude Agent SDK tst backend. */
export type ClaudeSdkTstStartupFn = typeof startup;

export type ClaudeSdkTstFastStartsOptions = {
  enabled?: boolean;
  maxPreparedStarts?: number;
  idleTtlMs?: number;
  initializeTimeoutMs?: number;
};

type NormalizedFastStartsOptions = Required<ClaudeSdkTstFastStartsOptions>;

const DEFAULT_FAST_STARTS: NormalizedFastStartsOptions = {
  enabled: false,
  maxPreparedStarts: 4,
  idleTtlMs: 300000,
  initializeTimeoutMs: 30000,
};

/** Options for the trigger stage-only Claude Agent SDK backend. */
export type ClaudeSdkTstBackendOptions = {
  /** Claude model id passed directly to the SDK query. */
  model?: string;
  /** Timeout for one semantic query. */
  timeoutMs?: number;
  /** Optional cwd override; otherwise use the hub-supplied context workspace. */
  cwd?: string;
  /** One-shot warm pool config; preparation begins once a cwd is supplied. */
  fastStarts?: ClaudeSdkTstFastStartsOptions;
};

/** Test-only transport seams for the stock Claude trigger backend. */
export type ClaudeSdkTstBackendTestOptions = ClaudeSdkTstBackendOptions & {
  logger?: ArcadeLogger;
  query?: ClaudeSdkTstQueryFn;
  startup?: ClaudeSdkTstStartupFn;
};

export function createClaudeSdkTstBackend(
  options: ClaudeSdkTstBackendOptions = {},
): Backend {
  return createClaudeSdkTstBackendForTesting(options);
}

/** Construct the trigger backend with injectable transport seams for tests. */
export function createClaudeSdkTstBackendForTesting(
  options: ClaudeSdkTstBackendTestOptions = {},
): Backend {
  return defineBackend({
    supportedSlotKinds: SUPPORTED_SLOT_KINDS,
    workerSlotSchema: ClaudeTstWorkerSlotSchema,
    createWorker(host, slot) {
      const config = slot;
      return new ClaudeSdkTstWorker({
        ...options,
        logger: host.logger,
        model: config.model ?? options.model,
        timeoutMs: config.timeoutMs ?? options.timeoutMs,
        cwd: config.cwd ?? options.cwd,
        fastStarts: config.fastStarts ?? options.fastStarts,
      });
    },
  });
}

type PreparedTstStart = { value: WarmQuery; abortController: AbortController };

/** Trigger stage-only backend backed by bounded Claude Agent SDK queries. */
export class ClaudeSdkTstWorker implements Worker {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #configuredCwd: string | undefined;
  readonly #query: ClaudeSdkTstQueryFn;
  readonly #startup: ClaudeSdkTstStartupFn;
  readonly #fastStarts: NormalizedFastStartsOptions;
  readonly #preparedStarts: PreparedStartPool<WarmQuery>;
  readonly #logger: ArcadeLogger;
  #stopped = false;
  readonly #activeControllers = new Set<AbortController>();

  constructor(options: ClaudeSdkTstBackendTestOptions = {}) {
    this.#model = options.model ?? DEFAULT_CLAUDE_SDK_TST_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_SDK_TST_TIMEOUT_MS;
    this.#configuredCwd = options.cwd;
    this.#query = options.query ?? query;
    this.#startup = options.startup ?? startup;
    this.#fastStarts = normalizeFastStarts(options.fastStarts);
    this.#logger = options.logger ?? createArcadeLogger();
    this.#preparedStarts = new PreparedStartPool({
      max: this.#fastStarts.enabled ? this.#fastStarts.maxPreparedStarts : 0,
      idleTtlMs: this.#fastStarts.idleTtlMs,
      start: (cwd, abortController) =>
        this.#startup({
          options: this.#buildOptions(abortController, cwd),
          initializeTimeoutMs: this.#fastStarts.initializeTimeoutMs,
        }),
      close: (warm) => warm.close(),
      failed: (error) =>
        this.#logger.info("backend.claude_sdk_tst.prepared_start_failed", {
          message: String(error),
        }),
    });
    registerRetentionProbe(this, () =>
      readRetention<PreparedStartPoolRetention>(this.#preparedStarts),
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const controller of this.#activeControllers) controller.abort();
    await this.#preparedStarts.stop();
  }

  async disposeRoutine(): Promise<void> {}

  /** Run one independent semantic task and return a completed semantic report. */
  async run(input: RoutineInput): Promise<RoutineReport> {
    const { context, effects, diagnostics } = input;
    const routine = backendRoutine(input);
    const task = routine.task;
    if (task.kind !== "semantic") {
      throw new Error("Claude SDK tst backend can only run semantic tasks.");
    }
    const prompt = buildSemanticPrompt(task, context);
    const cwd = this.#configuredCwd ?? context.workspacePath;
    if (this.#stopped) throw new Error("Claude SDK tst worker is stopped.");
    const prepared = this.#preparedStarts.take(cwd);
    let abortController = prepared?.abortController ?? new AbortController();
    this.#activeControllers.add(abortController);
    let preparedClosed = false;
    const closePrepared = () => {
      if (!prepared || preparedClosed) return;
      preparedClosed = true;
      prepared.abortController.abort();
      prepared.value.close();
    };
    let closeQuery: (() => void) | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.#timeoutMs);
    timeout.unref?.();

    const startedAt = Date.now();
    let backendDetails = this.#backendDetails(routine, false, cwd);

    let messages: SDKMessage[] = [];
    let tokenUsageRecorded = false;
    const recordMessageTokenUsage = async () => {
      if (tokenUsageRecorded) return;
      const tokenUsage = routineTokenUsageFromClaudeSdkMessages(messages);
      if (!tokenUsage) return;
      await effects.recordTokenUsage(tokenUsage);
      tokenUsageRecorded = true;
    };
    try {
      this.#logger.info("backend.claude_sdk_tst.started", {
        arcRunId: task.arcRunId,
        routineId: routine.id,
        role: routine.role,
        model: this.#model,
        timeoutMs: this.#timeoutMs,
        cwd,
        stage: task.stage,
        requestCount: task.requests.length,
      });
      await diagnostics.writeText("prompt", prompt);
      if (this.#stopped || (await effects.checkSignal())?.kind === "cancel")
        throw new Error("Claude SDK tst invocation cancelled.");
      const queried = await this.#queryMessages(
        prompt,
        task,
        abortController,
        prepared,
        cwd,
        closePrepared,
        () => {
          this.#activeControllers.delete(abortController);
          abortController = new AbortController();
          if (this.#stopped || timedOut) abortController.abort();
          this.#activeControllers.add(abortController);
          return abortController;
        },
      );
      closeQuery = queried.close;
      backendDetails = this.#backendDetails(
        routine,
        queried.preparedStartUsed,
        cwd,
      );
      const output = await collectSemanticOutput(queried.messages);
      messages = output.messages;
      await diagnostics.writeJson("sdk-messages", output.messages);
      await recordMessageTokenUsage();
      const outputKind =
        output.structured !== undefined ? "structured" : "text";
      if (output.structured !== undefined) {
        const raw =
          isRecord(output.structured) && "report" in output.structured
            ? output.structured.report
            : output.structured;
        const report = validateAgentRoutineReport(
          raw,
          "Claude SDK semantic output",
        );
        this.#logger.info("backend.claude_sdk_tst.finished", {
          arcRunId: task.arcRunId,
          routineId: routine.id,
          role: routine.role,
          model: this.#model,
          durationMs: Date.now() - startedAt,
          outputKind,
          reportKind: report.outcome ?? report.error,
        });
        return withBackendDetails(report, backendDetails);
      }
      const report = await parseAgentJsonOutput(
        output.text,
        undefined,
        "Claude SDK semantic output",
        { allowOutbound: false },
      );
      this.#logger.info("backend.claude_sdk_tst.finished", {
        arcRunId: task.arcRunId,
        routineId: routine.id,
        role: routine.role,
        model: this.#model,
        durationMs: Date.now() - startedAt,
        outputKind,
        reportKind: report.outcome ?? report.error,
      });
      return withBackendDetails(report, backendDetails);
    } catch (error) {
      await recordMessageTokenUsage();
      const message = timedOut
        ? `Claude SDK semantic query timed out after ${this.#timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : String(error);
      this.#logger.info("backend.claude_sdk_tst.failed", {
        arcRunId: task.arcRunId,
        routineId: routine.id,
        role: routine.role,
        model: this.#model,
        durationMs: Date.now() - startedAt,
        message,
        error: previewLogValue(String(error)),
      });
      const failureError = timedOut ? new Error(message) : error;
      if (this.#stopped && abortController.signal.aborted)
        return withBackendDetails(
          { cancellation: "superseded" },
          backendDetails,
        );
      const report = providerFailureReport(failureError, "claude-sdk-tst");
      if (report) return withBackendDetails(report, backendDetails);
      if (timedOut) throw failureError;
      throw error;
    } finally {
      clearTimeout(timeout);
      this.#activeControllers.delete(abortController);
      abortController.abort();
      try {
        closeQuery?.();
      } finally {
        closePrepared();
      }
    }
  }

  async #queryMessages(
    prompt: string,
    task: SemanticTask,
    abortController: AbortController,
    prepared: PreparedTstStart | undefined,
    cwd: string,
    closePrepared: () => void,
    replaceController: () => AbortController,
  ): Promise<{
    close?: () => void;
    messages: AsyncIterable<SDKMessage>;
    preparedStartUsed: boolean;
  }> {
    if (prepared) {
      try {
        const warm = prepared.value;
        if (!warm) throw new Error("Prepared semantic start is not ready.");
        const messages = warm.query(prompt);
        return { messages, preparedStartUsed: true };
      } catch (error) {
        closePrepared();
        abortController = replaceController();
        this.#logger.info(
          "backend.claude_sdk_tst.prepared_start_consume_failed",
          {
            arcRunId: task.arcRunId,
            batchId: task.batchId,
            model: this.#model,
            cwd,
            message: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    const messages = this.#query({
      prompt,
      options: this.#buildOptions(abortController, cwd),
    });
    return {
      messages,
      close: () => messages.close?.(),
      preparedStartUsed: false,
    };
  }

  #backendDetails(
    routine: RoutineInput["routine"],
    preparedStartUsed: boolean,
    cwd: string,
  ): JsonValue {
    const task = routine.task;
    return {
      backend: "claude-sdk-tst",
      sessionKey: `${task.arcRunId}:${routine.role}:${task.kind === "semantic" ? task.batchId : "semantic"}`,
      cwd,
      model: this.#model,
      preparedStartUsed,
    };
  }

  #buildOptions(
    abortController: AbortController,
    cwd: string,
  ): ClaudeSdkOptions {
    return {
      abortController,
      cwd,
      maxTurns: 2,
      model: this.#model,
      permissionMode: "dontAsk",
      persistSession: false,
      promptSuggestions: false,
      settingSources: [],
      skills: [],
      systemPrompt: buildSemanticSystemPrompt("trigger"),
      tools: [],
      outputFormat: {
        type: "json_schema",
        schema: semanticOutputSchema(),
      },
    };
  }
}

function normalizeFastStarts(
  input: ClaudeSdkTstFastStartsOptions | undefined,
): NormalizedFastStartsOptions {
  return { ...DEFAULT_FAST_STARTS, ...input };
}

async function collectSemanticOutput(
  messages: AsyncIterable<SDKMessage>,
): Promise<{
  text: string;
  structured?: unknown;
  messages: SDKMessage[];
}> {
  let text = "";
  let structured: unknown;
  const errors: string[] = [];
  const transcript: SDKMessage[] = [];

  for await (const message of messages) {
    transcript.push(message);
    if (message.type === "assistant") {
      if (message.error) errors.push(message.error);
      const assistantText = assistantMessageText(message);
      if (assistantText.trim().length > 0) text = assistantText;
      continue;
    }
    if (message.type === "result" && message.subtype !== "success") {
      errors.push(...message.errors);
      continue;
    }
    if (message.type === "result") {
      if (message.structured_output !== undefined) {
        structured = message.structured_output;
      }
      if (typeof message.result === "string" && message.result.trim()) {
        text = message.result;
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Claude SDK semantic query failed: ${errors.join("; ")}`);
  }
  if (structured === undefined && text.trim().length === 0) {
    throw new Error(
      "Claude SDK semantic query completed without semantic output.",
    );
  }
  return { text, structured, messages: transcript };
}

function assistantMessageText(
  message: Extract<SDKMessage, { type: "assistant" }>,
): string {
  const content: unknown = message.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isTextBlock(block) && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text"
  );
}

function semanticOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["report"],
    properties: {
      report: {
        type: "object",
        additionalProperties: false,
        required: ["outcome", "semantic"],
        properties: {
          outcome: { const: "completed" },
          semantic: {
            type: "object",
            additionalProperties: false,
            properties: {
              judgments: {
                type: "object",
                additionalProperties: { type: "boolean" },
              },
              observations: {
                type: "object",
                additionalProperties: {
                  type: "object",
                  additionalProperties: false,
                  required: ["status"],
                  properties: {
                    status: {
                      enum: ["resolved", "unknown", "needs-user"],
                    },
                    value: {
                      type: ["string", "number", "boolean"],
                    },
                  },
                },
              },
              preferredMatch: { type: "string" },
            },
          },
        },
      },
    },
  };
}
