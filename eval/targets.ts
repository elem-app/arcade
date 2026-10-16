import { spawn } from "node:child_process";

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
const COMMAND_PREFLIGHT_TIMEOUT_MS = 15_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

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
  "claude-mcp-client": {
    name: "claude-mcp-client",
    capabilities: ["mcp-handshake"],
    metadata: {
      commandSource: process.env.ARCADE_EVAL_CLAUDE_COMMAND
        ? "ARCADE_EVAL_CLAUDE_COMMAND"
        : "default",
    },
    preflight: async () => {
      const [command, ...configuredArgs] = claudeCommandParts();
      const version = await collectCommand(command!, [
        ...configuredArgs,
        "--version",
      ]);
      return {
        command,
        configuredArgs,
        commandSource: process.env.ARCADE_EVAL_CLAUDE_COMMAND
          ? "ARCADE_EVAL_CLAUDE_COMMAND"
          : "default",
        version: version.trim(),
      };
    },
    isTargetWideFailure: (error) =>
      AUTH_FAILURE.test(errorMessage(error)) ||
      /ENOENT|not found|executable|spawn/i.test(errorMessage(error)),
  },
};

export function claudeCommandParts(): string[] {
  const configured = process.env.ARCADE_EVAL_CLAUDE_COMMAND?.trim();
  if (!configured) return ["claude"];
  const parts = configured.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return parts.map((part) => part.replace(/^(["'])(.*)\1$/, "$2"));
}

function requireOpenAiKey(model: string): Record<string, unknown> {
  if (!process.env.ARCADE_OPENAI_API_KEY?.trim()) {
    throw new Error(
      "ARCADE_OPENAI_API_KEY is required for OpenAI eval targets.",
    );
  }
  return { model, credential: "ARCADE_OPENAI_API_KEY" };
}

function collectCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const appended = appendBounded(stdout, chunk, MAX_COMMAND_OUTPUT_BYTES);
      stdout = appended.value;
      outputTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk: string) => {
      const appended = appendBounded(stderr, chunk, MAX_COMMAND_OUTPUT_BYTES);
      stderr = appended.value;
      outputTruncated ||= appended.truncated;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      killTimer.unref();
    }, COMMAND_PREFLIGHT_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const suffix = outputTruncated ? " [output truncated]" : "";
      if (timedOut) {
        reject(
          new Error(
            `${command} --version timed out after ${COMMAND_PREFLIGHT_TIMEOUT_MS}ms.${suffix}`,
          ),
        );
      } else if (code === 0) {
        resolve(`${stdout || stderr}${suffix}`);
      } else {
        reject(
          new Error(
            `${command} --version exited with ${code}: ${stderr}${suffix}`,
          ),
        );
      }
    });
  });
}

function appendBounded(
  current: string,
  chunk: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const remaining = maxBytes - Buffer.byteLength(current);
  if (remaining <= 0) return { value: current, truncated: true };
  const buffer = Buffer.from(chunk);
  if (buffer.byteLength <= remaining) {
    return { value: current + chunk, truncated: false };
  }
  return {
    value: current + buffer.subarray(0, remaining).toString("utf8"),
    truncated: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
