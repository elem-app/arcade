import { describe, expect, it } from "vitest";

import { createSecretResolver } from "../src/testing.js";

describe("createSecretResolver", () => {
  it("returns undefined when no secrets config is supplied", () => {
    expect(createSecretResolver(undefined)).toBeUndefined();
  });

  it("maps logical refs to configured environment variables", async () => {
    const resolver = createSecretResolver(
      {
        provider: "env",
        env: { "openai.api_key": "ARCADE_OPENAI_API_KEY" },
      },
      { ARCADE_OPENAI_API_KEY: "sk-test" },
    );

    await expect(resolver?.getSecret("openai.api_key")).resolves.toBe(
      "sk-test",
    );
  });

  it("returns undefined for unmapped refs", async () => {
    const resolver = createSecretResolver(
      {
        provider: "env",
        env: { "openai.api_key": "ARCADE_OPENAI_API_KEY" },
      },
      { ARCADE_OPENAI_API_KEY: "sk-test" },
    );

    await expect(
      resolver?.getSecret("anthropic.api_key"),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for missing or empty env values", async () => {
    const resolver = createSecretResolver(
      {
        provider: "env",
        env: {
          "openai.api_key": "ARCADE_OPENAI_API_KEY",
          "empty.api_key": "EMPTY_API_KEY",
        },
      },
      { EMPTY_API_KEY: "   " },
    );

    await expect(
      resolver?.getSecret("openai.api_key"),
    ).resolves.toBeUndefined();
    await expect(resolver?.getSecret("empty.api_key")).resolves.toBeUndefined();
  });
});
