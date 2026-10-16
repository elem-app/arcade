import { describe, expect, it } from "vitest";

import { resolveOpenAiApiKey } from "../src/testing.js";

describe("resolveOpenAiApiKey", () => {
  it("uses an explicit configured secret before compatibility fallbacks", async () => {
    await expect(
      resolveOpenAiApiKey({
        env: { OPENAI_API_KEY: "sk-env" },
        secretRef: "openai.api_key",
        secretResolver: {
          getSecret: async (ref) =>
            ref === "openai.api_key" ? "sk-secret" : undefined,
        },
      }),
    ).resolves.toEqual({
      apiKey: "sk-secret",
      source: "secret",
      ref: "openai.api_key",
    });
  });

  it("fails clearly when an explicit configured secret is unresolved", async () => {
    await expect(
      resolveOpenAiApiKey({
        env: { OPENAI_API_KEY: "sk-env" },
        secretRef: "openai.api_key",
        secretResolver: { getSecret: async () => undefined },
      }),
    ).rejects.toThrow(/Check secrets\.env\["openai\.api_key"\]/);
  });

  it("fails clearly when a configured secret has no resolver", async () => {
    await expect(
      resolveOpenAiApiKey({
        env: { OPENAI_API_KEY: "sk-env" },
        secretRef: "openai.api_key",
      }),
    ).rejects.toThrow(/no secrets provider is configured/);
  });

  it("uses OPENAI_API_KEY from process env first", async () => {
    await expect(
      resolveOpenAiApiKey({
        env: { OPENAI_API_KEY: "sk-env", CODEX_HOME: "/codex" },
        homeDir: "/home/test",
        readFile: async () => JSON.stringify({ OPENAI_API_KEY: "sk-file" }),
      }),
    ).resolves.toEqual({ apiKey: "sk-env", source: "env" });
  });

  it("reads Codex auth when it contains an API key", async () => {
    await expect(
      resolveOpenAiApiKey({
        env: { CODEX_HOME: "/codex" },
        homeDir: "/home/test",
        readFile: async (path) => {
          expect(path).toBe("/codex/auth.json");
          return JSON.stringify({ OPENAI_API_KEY: "sk-codex" });
        },
      }),
    ).resolves.toEqual({
      apiKey: "sk-codex",
      source: "codex-auth",
      path: "/codex/auth.json",
    });
  });

  it("rejects Codex token-only auth without exposing secrets", async () => {
    await expect(
      resolveOpenAiApiKey({
        env: { CODEX_HOME: "/codex" },
        homeDir: "/home/test",
        readFile: async () =>
          JSON.stringify({
            tokens: {
              id_token: "secret-id-token",
              access_token: "secret-access-token",
              refresh_token: "secret-refresh-token",
            },
          }),
      }),
    ).rejects.toThrow(/session tokens are not supported/);

    await resolveOpenAiApiKey({
      env: { CODEX_HOME: "/codex" },
      homeDir: "/home/test",
      readFile: async () =>
        JSON.stringify({
          tokens: {
            id_token: "secret-id-token",
          },
        }),
    }).catch((error) => {
      expect(String(error)).not.toContain("secret-id-token");
    });
  });
});
