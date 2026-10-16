import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { SecretResolver } from "../service/secrets.js";
import { isRecord } from "../service/utils.js";

export type OpenAiApiKeyAuth = {
  apiKey: string;
  source: "secret" | "env" | "codex-auth";
  path?: string;
  ref?: string;
};

export type OpenAiCredentialResolverOptions = {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  homeDir?: string;
  secretRef?: string;
  secretResolver?: SecretResolver;
};

/** Resolve supported OpenAI API-key credentials for the OpenAI SDK backend. */
export async function resolveOpenAiApiKey(
  options: OpenAiCredentialResolverOptions = {},
): Promise<OpenAiApiKeyAuth> {
  const env = options.env ?? process.env;
  if (options.secretRef) {
    if (!options.secretResolver) {
      throw new Error(
        `OpenAI SDK backend could not resolve configured API key secret "${options.secretRef}" because no secrets provider is configured. Add secrets.provider and secrets.env for this ref, or remove apiKeySecret from the selected worker slot to use compatibility fallbacks.`,
      );
    }
    const secret = await options.secretResolver?.getSecret(options.secretRef);
    if (secret) {
      return { apiKey: secret, source: "secret", ref: options.secretRef };
    }
    throw new Error(
      `OpenAI SDK backend could not resolve configured API key secret "${options.secretRef}". Check secrets.env["${options.secretRef}"] and ensure the mapped environment variable is set to a non-empty value.`,
    );
  }

  const envKey = stringValue(env["OPENAI_API_KEY"]);
  if (envKey) return { apiKey: envKey, source: "env" };

  const read = options.readFile ?? ((path) => readFile(path, "utf8"));
  const paths = authFileCandidates(env, options.homeDir ?? homedir());
  let sawCodexAuth = false;
  let sawTokenOnlyAuth = false;

  for (const path of paths) {
    let raw: string;
    try {
      raw = await read(path);
      sawCodexAuth = true;
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const apiKey = extractApiKey(parsed);
    if (apiKey) return { apiKey, source: "codex-auth", path };
    if (hasCodexSessionToken(parsed)) sawTokenOnlyAuth = true;
  }

  if (sawTokenOnlyAuth) {
    throw new Error(
      "OpenAI SDK backend requires OPENAI_API_KEY or Codex auth containing an OpenAI API key. Codex ChatGPT/session tokens are not supported.",
    );
  }
  if (sawCodexAuth) {
    throw new Error(
      "OpenAI SDK backend requires OPENAI_API_KEY or Codex auth containing an OpenAI API key.",
    );
  }
  throw new Error(
    "OpenAI SDK backend requires OPENAI_API_KEY. Codex ChatGPT/session tokens are not supported.",
  );
}

function authFileCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const candidates = [
    stringValue(env["CODEX_HOME"])
      ? join(stringValue(env["CODEX_HOME"])!, "auth.json")
      : undefined,
    join(homeDir, ".codex", "auth.json"),
  ];
  return [...new Set(candidates.filter((path): path is string => !!path))];
}

function extractApiKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct =
    stringValue(value["OPENAI_API_KEY"]) ??
    stringValue(value["openai_api_key"]) ??
    stringValue(value["apiKey"]) ??
    stringValue(value["api_key"]);
  if (direct) return direct;

  for (const key of ["openai", "openAI", "api_key", "apiKey"]) {
    const nested = value[key];
    if (isRecord(nested)) {
      const nestedValue =
        stringValue(nested["OPENAI_API_KEY"]) ??
        stringValue(nested["apiKey"]) ??
        stringValue(nested["api_key"]) ??
        stringValue(nested["key"]) ??
        stringValue(nested["value"]);
      if (nestedValue) return nestedValue;
    }
  }
  return undefined;
}

function hasCodexSessionToken(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const tokens = value["tokens"];
  if (!isRecord(tokens)) return false;
  return Boolean(
    stringValue(tokens["id_token"]) ??
    stringValue(tokens["access_token"]) ??
    stringValue(tokens["refresh_token"]),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
