import { Agent, type AgentOptions } from "@earendil-works/pi-agent-core";
import { z } from "zod";

import {
  createArcadeLogger,
  previewLogValue,
  type ArcadeLogger,
} from "../logging.js";
import {
  buildSemanticPrompt,
  buildSemanticSystemPrompt,
  extractLastPiAgentAssistantText,
  parseAgentJsonOutput,
} from "../service/semantic-resolver.js";
import {
  buildInstructionPrompt,
  buildInstructionSystemPrompt,
} from "../service/stock-prompts.js";
import { routineTokenUsageFromPiAgentMessages } from "../service/token-usage.js";
import { validateRoutineReport } from "../service/utils.js";
import { defineBackend, type Backend, type Worker } from "../types/backend.js";
import type { RoutineInput, RoutineReport } from "../types/routine.js";
import type { Task } from "../types/task.js";
import type { WorkerSlot, WorkerSlotKind } from "../types/worker-slot.js";
import { createWorkerSlotSchema } from "../types/worker-slot.js";
import { backendRoutine, providerFailureReport } from "./backend-support.js";

const SUPPORTED_SLOT_KINDS: ReadonlySet<WorkerSlotKind> = new Set([
  "default",
  "role",
  "fast-trigger",
]);
const PiWorkerSlotSchema = createWorkerSlotSchema({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

// --- pi-agent model resolution ---

const PI_AGENT_PROVIDERS: Record<string, { api: string; baseUrl: string }> = {
  anthropic: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  },
  openai: {
    api: "openai-responses",
    baseUrl: "https://api.openai.com",
  },
};

type PiAgentModelDefaults = {
  name: string;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};

const PI_AGENT_MODEL_DEFAULTS: Record<string, PiAgentModelDefaults> = {
  "claude-haiku-4-5": {
    name: "Claude Haiku 4.5",
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  "claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6",
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
};

type PiAgentModel = {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};

/** Resolve a worker slot's provider/model strings into a pi-agent-core Model. */
export function resolvePiAgentModel(slot: WorkerSlot): PiAgentModel {
  const providerName = slot["provider"];
  if (typeof providerName !== "string" || providerName.length === 0) {
    throw new Error(
      `Worker slot with backend "${slot.backend}" requires a "provider" field to resolve a model.`,
    );
  }
  const providerInfo = PI_AGENT_PROVIDERS[providerName];
  if (!providerInfo) {
    const known = Object.keys(PI_AGENT_PROVIDERS).join(", ");
    throw new Error(
      `Unknown provider "${providerName}". Known providers: ${known}.`,
    );
  }
  const modelId = slot["model"];
  if (typeof modelId !== "string" || modelId.length === 0) {
    throw new Error(
      `Worker slot with backend "${slot.backend}" and provider "${providerName}" requires a "model" field.`,
    );
  }
  const defaults = PI_AGENT_MODEL_DEFAULTS[modelId];
  return {
    id: modelId,
    name: defaults?.name ?? modelId,
    api: providerInfo.api,
    provider: providerName,
    baseUrl: providerInfo.baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: defaults?.cost ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: defaults?.contextWindow ?? 200000,
    maxTokens: defaults?.maxTokens ?? 64000,
  };
}

/** Build pi-agent-core AgentOptions from a worker slot, if provider/model are set. */
export function buildPiAgentOptionsFromSlot(
  slot: WorkerSlot,
): { initialState: { model: PiAgentModel } } | undefined {
  if (
    typeof slot["provider"] !== "string" ||
    typeof slot["model"] !== "string"
  ) {
    return undefined;
  }
  return { initialState: { model: resolvePiAgentModel(slot) } };
}

/** Function used to run one PI-agent internal work item. */
export type PiAgentRunner = (task: Task) => Promise<RoutineReport>;

/** Embedded PI-agent backend configuration. */
export type PiAgentBackendOptions = {
  /** Test or deployment supplied PI-agent runner. */
  runner?: PiAgentRunner;
  /** Options used by the default `@earendil-works/pi-agent-core` runner. */
  agentOptions?: AgentOptions | ((task: Task) => AgentOptions | undefined);
};

type PiAgentWorkerOptions = PiAgentBackendOptions & { logger?: ArcadeLogger };

export function createPiAgentBackend(
  options: PiAgentBackendOptions = {},
): Backend {
  return defineBackend({
    supportedSlotKinds: SUPPORTED_SLOT_KINDS,
    workerSlotSchema: PiWorkerSlotSchema,
    createWorker(host, slot) {
      const config = slot;
      const slotAgentOptions = buildPiAgentOptionsFromSlot(config);
      const provider = config.provider;
      const classifierBackend =
        provider === "anthropic"
          ? "claude-sdk"
          : provider === "openai"
            ? "openai-sdk"
            : "pi-agent";
      return new PiAgentWorker(
        {
          ...options,
          logger: host.logger,
          agentOptions: options.agentOptions ?? slotAgentOptions,
        },
        classifierBackend,
      );
    },
  });
}

export class PiAgentWorker implements Worker {
  readonly #options: PiAgentWorkerOptions;
  readonly #logger: ArcadeLogger;

  constructor(
    options: PiAgentWorkerOptions = {},
    private readonly classifierBackend = "pi-agent",
  ) {
    this.#options = options;
    this.#logger = options.logger ?? createArcadeLogger();
  }

  async disposeRoutine(): Promise<void> {}

  async run(input: RoutineInput): Promise<RoutineReport> {
    const { context, effects, diagnostics } = input;
    const routine = backendRoutine(input);
    const task = routine.task;

    const startedAt = Date.now();
    this.#logger.info("backend.pi_agent.started", {
      arcRunId: task.arcRunId,
      routineId: routine.id,
      role: routine.role,
      kind: task.kind,
      customRunner: this.#options.runner !== undefined,
      ...(task.kind === "semantic"
        ? {
            stage: task.stage,
            requestCount: task.requests.length,
          }
        : {}),
    });

    try {
      if (this.#options.runner) {
        const report = validateRoutineReport(
          await this.#options.runner(task),
          "PI agent runner report",
        );
        this.#logger.info("backend.pi_agent.finished", {
          arcRunId: task.arcRunId,
          routineId: routine.id,
          role: routine.role,
          kind: task.kind,
          customRunner: true,
          durationMs: Date.now() - startedAt,
          reportKind:
            report.outcome ??
            report.suspension ??
            report.cancellation ??
            report.error,
        });
        return report;
      }

      const agentOptions = this.#resolveAgentOptions(task);

      const systemBase = agentOptions.initialState?.systemPrompt;
      const isSemantic = task.kind === "semantic";
      const prompt = isSemantic
        ? buildSemanticPrompt(task, context)
        : buildInstructionPrompt(task, context);
      await diagnostics.writeText("prompt", prompt);
      const agent = new Agent({
        ...agentOptions,
        initialState: {
          ...agentOptions.initialState,
          systemPrompt: isSemantic
            ? buildSemanticSystemPrompt(task.stage, systemBase)
            : buildInstructionSystemPrompt(task, systemBase),
        },
      });
      await agent.prompt(prompt);
      const tokenUsage = routineTokenUsageFromPiAgentMessages(
        agent.state.messages,
      );
      if (tokenUsage) await effects.recordTokenUsage(tokenUsage);
      await diagnostics.writeJson("messages", agent.state.messages);
      const report = await parseAgentJsonOutput(
        extractLastPiAgentAssistantText(agent.state.messages),
        effects,
        "PI agent output",
      );
      await diagnostics.writeJson("result", report);
      this.#logger.info("backend.pi_agent.finished", {
        arcRunId: task.arcRunId,
        routineId: routine.id,
        role: routine.role,
        kind: task.kind,
        customRunner: false,
        durationMs: Date.now() - startedAt,
        reportKind: report.outcome ?? report.error,
      });
      return report;
    } catch (error) {
      this.#logger.info("backend.pi_agent.failed", {
        arcRunId: task.arcRunId,
        routineId: routine.id,
        role: routine.role,
        kind: task.kind,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        error: previewLogValue(String(error)),
      });
      const report = providerFailureReport(
        error,
        "pi-agent",
        this.classifierBackend,
      );
      if (report) return report;
      throw error;
    }
  }

  #resolveAgentOptions(task: Task): AgentOptions {
    const agentOptions =
      typeof this.#options.agentOptions === "function"
        ? this.#options.agentOptions(task)
        : this.#options.agentOptions;
    if (!agentOptions) {
      throw new Error(
        "PI-agent backend requires piAgent.runner or piAgent.agentOptions.",
      );
    }
    return agentOptions;
  }
}
