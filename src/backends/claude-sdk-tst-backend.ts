import {
  query,
  startup,
  type Options as ClaudeSdkOptions,
  type SDKMessage,
  type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

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
import {
  defineBackend,
  type Backend,
  type Worker,
  type WorkerWarmupInput,
} from "../types/backend.js";
import type { JsonValue } from "../types/json.js";
import type { RoutineInput, RoutineReport } from "../types/routine.js";
import type { SemanticTask } from "../types/task.js";
import type { WorkerSlotKind } from "../types/worker-slot.js";
import { createWorkerSlotSchema } from "../types/worker-slot.js";
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

type PreparedTstStart = {
  id: number;
  cwd: string;
  abortController: AbortController;
  createdAt: number;
  closed: boolean;
  warm?: WarmQuery;
  promise: Promise<WarmQuery>;
};

/** Trigger stage-only backend backed by bounded Claude Agent SDK queries. */
export class ClaudeSdkTstWorker implements Worker {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #configuredCwd: string | undefined;
  #poolCwd: string | undefined;
  readonly #query: ClaudeSdkTstQueryFn;
  readonly #startup: ClaudeSdkTstStartupFn;
  readonly #fastStarts: NormalizedFastStartsOptions;
  readonly #preparedStarts = new Map<number, PreparedTstStart>();
  readonly #logger: ArcadeLogger;
  #nextPreparedStartId = 0;
  #stopped = false;
  #replenishTimer: ReturnType<typeof setTimeout> | undefined;
  #maintenanceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ClaudeSdkTstBackendTestOptions = {}) {
    this.#model = options.model ?? DEFAULT_CLAUDE_SDK_TST_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_SDK_TST_TIMEOUT_MS;
    this.#configuredCwd = options.cwd;
    this.#poolCwd = options.cwd;
    this.#query = options.query ?? query;
    this.#startup = options.startup ?? startup;
    this.#fastStarts = normalizeFastStarts(options.fastStarts);
    this.#logger = options.logger ?? createArcadeLogger();
    this.#replenishPreparedStarts();
  }

  async warm(input: WorkerWarmupInput): Promise<void> {
    this.#preparePool(this.#configuredCwd ?? input.workspacePath);
  }

  #preparePool(cwd: string): void {
    if (this.#stopped) return;
    if (this.#poolCwd !== cwd) {
      for (const entry of this.#preparedStarts.values())
        this.#closePreparedStart(entry);
      this.#preparedStarts.clear();
      if (this.#maintenanceTimer) clearTimeout(this.#maintenanceTimer);
      this.#maintenanceTimer = undefined;
      this.#poolCwd = cwd;
    }
    this.#replenishPreparedStarts();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#replenishTimer) clearTimeout(this.#replenishTimer);
    if (this.#maintenanceTimer) clearTimeout(this.#maintenanceTimer);
    this.#replenishTimer = undefined;
    this.#maintenanceTimer = undefined;
    for (const entry of this.#preparedStarts.values()) {
      this.#closePreparedStart(entry);
    }
    this.#preparedStarts.clear();
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
    const cwd = this.#configuredCwd ?? context.workspacePath;
    this.#preparePool(cwd);
    this.#sweepPreparedStarts();
    const prepared = this.#consumeReadyPreparedStart(cwd);
    if (!prepared) this.#scheduleReplenish();
    const abortController = prepared?.abortController ?? new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.#timeoutMs);
    timeout.unref?.();

    const startedAt = Date.now();
    const prompt = buildSemanticPrompt(task, context);
    await diagnostics.writeText("prompt", prompt);
    let backendDetails = this.#backendDetails(routine, false, cwd);
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
      const queried = await this.#queryMessages(
        prompt,
        task,
        abortController,
        prepared,
        cwd,
      );
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
      const report = providerFailureReport(failureError, "claude-sdk-tst");
      if (report) return withBackendDetails(report, backendDetails);
      if (timedOut) throw failureError;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #queryMessages(
    prompt: string,
    task: SemanticTask,
    abortController: AbortController,
    prepared: PreparedTstStart | undefined,
    cwd: string,
  ): Promise<{
    messages: AsyncIterable<SDKMessage>;
    preparedStartUsed: boolean;
  }> {
    if (prepared) {
      try {
        const warm = prepared.warm;
        if (!warm) throw new Error("Prepared semantic start is not ready.");
        const messages = warm.query(prompt);
        prepared.closed = true;
        this.#scheduleReplenish();
        return { messages, preparedStartUsed: true };
      } catch (error) {
        this.#closePreparedStart(prepared);
        this.#scheduleReplenish();
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
    return {
      messages: this.#query({
        prompt,
        options: this.#buildOptions(abortController, cwd),
      }),
      preparedStartUsed: false,
    };
  }

  #consumeReadyPreparedStart(cwd: string): PreparedTstStart | undefined {
    for (const [id, entry] of this.#preparedStarts) {
      if (entry.closed || !entry.warm || entry.cwd !== cwd) continue;
      this.#preparedStarts.delete(id);
      return entry;
    }
    return undefined;
  }

  #replenishPreparedStarts(): void {
    if (
      this.#stopped ||
      this.#poolCwd === undefined ||
      !this.#fastStarts.enabled ||
      this.#fastStarts.maxPreparedStarts === 0
    ) {
      return;
    }
    this.#sweepPreparedStarts();
    while (this.#preparedStarts.size < this.#fastStarts.maxPreparedStarts) {
      this.#startPreparedStart(this.#poolCwd);
    }
    this.#scheduleMaintenance();
  }

  #startPreparedStart(cwd: string): void {
    const id = this.#nextPreparedStartId++;
    const abortController = new AbortController();
    const entry: PreparedTstStart = {
      id,
      cwd,
      abortController,
      createdAt: Date.now(),
      closed: false,
      promise: this.#startup({
        options: this.#buildOptions(abortController, cwd),
        initializeTimeoutMs: this.#fastStarts.initializeTimeoutMs,
      }),
    };
    this.#preparedStarts.set(id, entry);
    entry.promise.then(
      (warm) => {
        if (this.#stopped || entry.closed || !this.#preparedStarts.has(id)) {
          warm.close();
          return;
        }
        entry.warm = warm;
        this.#logger.info("backend.claude_sdk_tst.prepared_start_ready", {
          preparedStartId: id,
          model: this.#model,
          cwd,
        });
      },
      (error) => {
        if (!entry.closed) {
          this.#logger.info("backend.claude_sdk_tst.prepared_start_failed", {
            model: this.#model,
            cwd,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        this.#preparedStarts.delete(id);
        this.#scheduleReplenish(1000);
      },
    );
  }

  #scheduleReplenish(delayMs = 0): void {
    if (this.#stopped || this.#replenishTimer) return;
    this.#replenishTimer = setTimeout(() => {
      this.#replenishTimer = undefined;
      this.#replenishPreparedStarts();
    }, delayMs);
    this.#replenishTimer.unref?.();
  }

  #scheduleMaintenance(): void {
    if (this.#stopped || this.#maintenanceTimer) return;
    const nextExpiresAt = Math.min(
      ...[...this.#preparedStarts.values()].map(
        (entry) => entry.createdAt + this.#fastStarts.idleTtlMs,
      ),
    );
    if (!Number.isFinite(nextExpiresAt)) return;
    const delayMs = Math.max(0, nextExpiresAt - Date.now());
    this.#maintenanceTimer = setTimeout(() => {
      this.#maintenanceTimer = undefined;
      this.#sweepPreparedStarts();
      this.#replenishPreparedStarts();
    }, delayMs);
    this.#maintenanceTimer.unref?.();
  }

  #sweepPreparedStarts(): void {
    const now = Date.now();
    for (const [id, entry] of this.#preparedStarts) {
      if (now - entry.createdAt >= this.#fastStarts.idleTtlMs) {
        this.#closePreparedStart(entry);
        this.#preparedStarts.delete(id);
      }
    }
  }

  #closePreparedStart(entry: PreparedTstStart): void {
    if (entry.closed) return;
    entry.closed = true;
    entry.abortController.abort();
    entry.warm?.close();
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
