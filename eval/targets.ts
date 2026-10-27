import packageManifest from "../package.json";
import type { EvalTargetCapability, EvalTargetName } from "./types.js";

export type EvalTarget = {
  name: EvalTargetName;
  model?: string;
  metadata?: Record<string, unknown>;
  capabilities: readonly EvalTargetCapability[];
  preflight(): Promise<Record<string, unknown>>;
  isTargetWideFailure(error: unknown): boolean;
};

const AUTH_FAILURE = /auth|api[_ -]?key|credential|unauthori[sz]ed|forbidden/i;

export const EVAL_CLAUDE_SDK_MODEL =
  process.env.ARCADE_EVAL_CLAUDE_SDK_MODEL?.trim() || "claude-sonnet-4-6";
export const EVAL_CLAUDE_TST_MODEL = "claude-haiku-4-5";
export const EVAL_OPENAI_SDK_MODEL = "gpt-5.5";
export const EVAL_OPENAI_TST_MODEL = "gpt-5.4-mini";
const dependencies = packageManifest.dependencies as Record<string, string>;

export const EVAL_TARGETS: Readonly<Record<EvalTargetName, EvalTarget>> = {
  "claude-sdk": {
    name: "claude-sdk",
    capabilities: [
      "instruction-work",
      "prepared-start",
      "session-continuity",
      "filesystem",
    ],
    model: EVAL_CLAUDE_SDK_MODEL,
    metadata: {
      sdk: "@anthropic-ai/claude-agent-sdk",
      sdkVersion: dependencies["@anthropic-ai/claude-agent-sdk"],
    },
    preflight: async () => ({ model: EVAL_CLAUDE_SDK_MODEL }),
    isTargetWideFailure: (error) => AUTH_FAILURE.test(errorMessage(error)),
  },
  "openai-sdk": {
    name: "openai-sdk",
    capabilities: ["instruction-work", "session-continuity", "filesystem"],
    model: EVAL_OPENAI_SDK_MODEL,
    metadata: {
      sdk: "@openai/agents",
      sdkVersion: dependencies["@openai/agents"],
      openaiVersion: dependencies["openai"],
    },
    preflight: async () => requireOpenAiKey(EVAL_OPENAI_SDK_MODEL),
    isTargetWideFailure: (error) => AUTH_FAILURE.test(errorMessage(error)),
  },
  "claude-sdk-tst": {
    name: "claude-sdk-tst",
    capabilities: ["semantic-trigger", "prepared-start"],
    model: EVAL_CLAUDE_TST_MODEL,
    metadata: {
      sdk: "@anthropic-ai/claude-agent-sdk",
      sdkVersion: dependencies["@anthropic-ai/claude-agent-sdk"],
    },
    preflight: async () => ({ model: EVAL_CLAUDE_TST_MODEL }),
    isTargetWideFailure: (error) => AUTH_FAILURE.test(errorMessage(error)),
  },
  "openai-sdk-tst": {
    name: "openai-sdk-tst",
    capabilities: ["semantic-trigger"],
    model: EVAL_OPENAI_TST_MODEL,
    metadata: {
      sdk: "@openai/agents",
      sdkVersion: dependencies["@openai/agents"],
      openaiVersion: dependencies["openai"],
    },
    preflight: async () => requireOpenAiKey(EVAL_OPENAI_TST_MODEL),
    isTargetWideFailure: (error) => AUTH_FAILURE.test(errorMessage(error)),
  },
};

function requireOpenAiKey(model: string): Record<string, unknown> {
  if (!process.env.ARCADE_OPENAI_API_KEY?.trim()) {
    throw new Error(
      "ARCADE_OPENAI_API_KEY is required for OpenAI eval targets.",
    );
  }
  return { model, credential: "ARCADE_OPENAI_API_KEY" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
