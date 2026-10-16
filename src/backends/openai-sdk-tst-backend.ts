import { Agent, OpenAIProvider, Runner } from "@openai/agents";
import { z } from "zod";

import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import type { SecretResolver } from "../service/secrets.js";
import {
  buildSemanticPrompt,
  buildSemanticSystemPrompt,
  parseAgentJsonOutput,
} from "../service/semantic-resolver.js";
import { routineTokenUsageFromOpenAiRun } from "../service/token-usage.js";
import { isRecord, validateAgentRoutineReport } from "../service/utils.js";
import { defineBackend, type Backend, type Worker } from "../types/backend.js";
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
import { resolveOpenAiApiKey } from "./openai-auth.js";

export const DEFAULT_OPENAI_SDK_TST_MODEL = "gpt-5.4-mini";
const DEFAULT_OPENAI_SDK_TST_TIMEOUT_MS = 60_000;
const SUPPORTED_SLOT_KINDS: ReadonlySet<WorkerSlotKind> = new Set([
  "fast-trigger",
]);
const OpenAiTstWorkerSlotSchema = createWorkerSlotSchema({
  model: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
  baseUrl: z.url().optional(),
  apiKeySecret: z.string().min(1).optional(),
});

export type OpenAiSdkTstRunResult = {
  finalOutput?: unknown;
  lastResponseId?: string;
  rawResponses?: readonly unknown[];
  runContext?: unknown;
  state?: unknown;
};

export type OpenAiSdkTstRunFn = (input: {
  agent: Agent<any, any>;
  prompt: string;
  apiKey: string;
  baseUrl?: string;
  signal: AbortSignal;
  maxTurns: number;
}) => Promise<OpenAiSdkTstRunResult>;

export type OpenAiSdkTstBackendOptions = {
  model?: string;
  timeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
  apiKeySecret?: string;
  secretResolver?: SecretResolver;
};

/** Test-only runner seam for the stock OpenAI trigger backend. */
export type OpenAiSdkTstBackendTestOptions = OpenAiSdkTstBackendOptions & {
  logger?: ArcadeLogger;
  run?: OpenAiSdkTstRunFn;
};

export function createOpenAiSdkTstBackend(
  options: OpenAiSdkTstBackendOptions = {},
): Backend {
  return createOpenAiSdkTstBackendForTesting(options);
}

/** Construct the trigger backend with an injectable SDK runner for tests. */
export function createOpenAiSdkTstBackendForTesting(
  options: OpenAiSdkTstBackendTestOptions = {},
): Backend {
  return defineBackend({
    supportedSlotKinds: SUPPORTED_SLOT_KINDS,
    workerSlotSchema: OpenAiTstWorkerSlotSchema,
    createWorker(host, slot) {
      const config = slot;
      return new OpenAiSdkTstWorker({
        ...options,
        logger: host.logger,
        model: config.model ?? options.model,
        timeoutMs: config.timeoutMs ?? options.timeoutMs,
        baseUrl: config.baseUrl ?? options.baseUrl,
        apiKeySecret: config.apiKeySecret ?? options.apiKeySecret,
      });
    },
  });
}

/** Trigger stage-only backend backed by bounded OpenAI Agents SDK runs. */
export class OpenAiSdkTstWorker implements Worker {
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #run: OpenAiSdkTstRunFn;
  readonly #logger: ArcadeLogger;
  readonly #apiKey?: string;
  readonly #baseUrl?: string;
  readonly #apiKeySecret?: string;
  readonly #secretResolver?: SecretResolver;

  constructor(options: OpenAiSdkTstBackendTestOptions = {}) {
    this.#model = options.model ?? DEFAULT_OPENAI_SDK_TST_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_SDK_TST_TIMEOUT_MS;
    this.#run = options.run ?? defaultOpenAiSdkTstRun;
    this.#logger = options.logger ?? createArcadeLogger();
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl;
    this.#apiKeySecret = options.apiKeySecret;
    this.#secretResolver = options.secretResolver;
  }

  async disposeRoutine(): Promise<void> {}

  async run(input: RoutineInput): Promise<RoutineReport> {
    const { context, effects, diagnostics } = input;
    const routine = backendRoutine(input);
    const task = routine.task;
    if (task.kind !== "semantic") {
      throw new Error("OpenAI SDK tst backend can only run semantic tasks.");
    }
    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.#timeoutMs);
    timeout.unref?.();

    const startedAt = Date.now();
    const prompt = buildSemanticPrompt(task, context);
    await diagnostics.writeText("prompt", prompt);
    const backendDetails: JsonValue = {
      backend: "openai-sdk-tst",
      sessionKey: `${task.arcRunId}:${routine.role}:${task.batchId}`,
      cwd: context.workspacePath,
      model: this.#model,
    };
    this.#logger.info("backend.openai_sdk_tst.started", {
      arcRunId: task.arcRunId,
      routineId: routine.id,
      role: routine.role,
      model: this.#model,
      timeoutMs: this.#timeoutMs,
      stage: task.stage,
      requestCount: task.requests.length,
    });

    let result: OpenAiSdkTstRunResult | undefined;
    try {
      result = await this.#run({
        agent: this.#agent(task),
        prompt,
        apiKey: await this.#resolvedApiKey(),
        baseUrl: this.#baseUrl,
        signal: abortController.signal,
        maxTurns: 2,
      });
      await diagnostics.writeJson("sdk-result", result);
      const tokenUsage = routineTokenUsageFromOpenAiRun(result);
      if (tokenUsage) await effects.recordTokenUsage(tokenUsage);
      const report =
        typeof result.finalOutput === "string"
          ? await parseAgentJsonOutput(
              result.finalOutput,
              undefined,
              "OpenAI SDK semantic output",
              { allowOutbound: false },
            )
          : validateAgentRoutineReport(
              isRecord(result.finalOutput) && "report" in result.finalOutput
                ? result.finalOutput.report
                : result.finalOutput,
              "OpenAI SDK semantic output",
            );
      this.#logger.info("backend.openai_sdk_tst.finished", {
        arcRunId: task.arcRunId,
        routineId: routine.id,
        role: routine.role,
        model: this.#model,
        durationMs: Date.now() - startedAt,
        reportKind: report.outcome ?? report.error,
      });
      return withBackendDetails(report, backendDetails);
    } catch (error) {
      const message = timedOut
        ? `OpenAI SDK semantic query timed out after ${this.#timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : String(error);
      this.#logger.info("backend.openai_sdk_tst.failed", {
        arcRunId: task.arcRunId,
        routineId: routine.id,
        role: routine.role,
        model: this.#model,
        durationMs: Date.now() - startedAt,
        message,
        error: previewLogValue(String(error)),
      });
      const failureError = timedOut ? new Error(message) : error;
      const report = providerFailureReport(failureError, "openai-sdk-tst");
      if (report) return withBackendDetails(report, backendDetails);
      if (timedOut) throw failureError;
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  #agent(task: SemanticTask): Agent<any, any> {
    return new Agent({
      name: `Arcade semantic ${task.role}`,
      instructions: buildSemanticSystemPrompt(),
      model: this.#model,
    });
  }

  async #resolvedApiKey(): Promise<string> {
    return (
      this.#apiKey ??
      (
        await resolveOpenAiApiKey({
          secretRef: this.#apiKeySecret,
          secretResolver: this.#secretResolver,
        })
      ).apiKey
    );
  }
}

async function defaultOpenAiSdkTstRun({
  agent,
  prompt,
  apiKey,
  baseUrl: baseURL,
  signal,
  maxTurns,
}: Parameters<OpenAiSdkTstRunFn>[0]): Promise<OpenAiSdkTstRunResult> {
  const runner = new Runner({
    modelProvider: new OpenAIProvider({ apiKey, baseURL }),
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: "Arcade OpenAI SDK Tst Worker",
  });
  return await runner.run(agent, prompt, {
    signal,
    maxTurns,
    toolNotFoundBehavior: "return_error_to_model",
  });
}
