import { describe, expect, it } from "vitest";

import { classifyCapacityLimit } from "../src/testing.js";

describe("classifyCapacityLimit", () => {
  it("translates OpenAI insufficient quota to a token usage capacity interrupt", () => {
    const error = Object.assign(new Error("You exceeded your current quota."), {
      status: 429,
      code: "insufficient_quota",
      type: "insufficient_quota",
    });
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      reason: "token usage limit",
      provider: "openai",
      backend: "openai-sdk",
    });
  });

  it("translates OpenAI rate limits to api and token rate capacity interrupts", () => {
    const error = Object.assign(new Error("Rate limit reached for gpt-4."), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      reason: "api rate limit",
      provider: "openai",
    });
    expect(
      classifyCapacityLimit(
        Object.assign(new Error("Tokens per minute exceeded"), {
          status: 429,
          code: "rate_limit_exceeded",
        }),
        "openai-sdk",
      ),
    ).toMatchObject({ reason: "token rate limit", provider: "openai" });
  });

  it("classifies OpenAI 429 quota wording without code as a token usage limit", () => {
    const error = Object.assign(new Error("You exceeded your current quota."), {
      status: 429,
    });
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      reason: "token usage limit",
      provider: "openai",
    });
  });

  it("classifies OpenAI wrapper status with nested insufficient_quota cause", () => {
    const cause = { code: "insufficient_quota" };
    const error = Object.assign(new Error("Agent run failed"), {
      status: 429,
      cause,
    });
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      reason: "token usage limit",
      provider: "openai",
    });
  });

  it("translates Anthropic rate limits overload and credit exhaustion to capacity interrupts", () => {
    const error = Object.assign(new Error("Number of requests too high."), {
      status: 429,
      type: "rate_limit_error",
    });
    expect(classifyCapacityLimit(error, "claude-sdk")).toMatchObject({
      reason: "api rate limit",
      provider: "anthropic",
      backend: "claude-sdk",
    });
    expect(
      classifyCapacityLimit(
        Object.assign(new Error("Provider overloaded"), {
          status: 529,
          type: "overloaded_error",
        }),
        "claude-sdk",
      ),
    ).toMatchObject({ reason: "provider overloaded" });
    expect(
      classifyCapacityLimit(
        Object.assign(new Error("Credit balance exhausted"), {
          status: 400,
          type: "billing_error",
        }),
        "claude-sdk",
      ),
    ).toMatchObject({ reason: "token usage limit" });
  });

  it("promotes an Anthropic token-bucket exhaustion to a token rate limit", () => {
    const error = Object.assign(new Error("Rate limited."), {
      status: 429,
      type: "rate_limit_error",
      headers: {
        "anthropic-ratelimit-tokens-remaining": "0",
        "retry-after": "30",
      },
    });
    expect(classifyCapacityLimit(error, "claude-sdk")).toMatchObject({
      reason: "token rate limit",
      retryAfterMs: 30000,
    });
  });

  it("promotes Anthropic 'tokens per minute' message wording to a token rate limit", () => {
    const error = Object.assign(
      new Error("This request exceeds your tokens per minute limit."),
      { status: 429, type: "rate_limit_error" },
    );
    expect(classifyCapacityLimit(error, "claude-sdk")).toMatchObject({
      reason: "token rate limit",
    });
  });

  it("classifies an Anthropic 529 as a provider-overloaded block", () => {
    const error = Object.assign(new Error("Overloaded."), {
      status: 529,
      type: "overloaded_error",
    });
    expect(classifyCapacityLimit(error, "claude-sdk")).toMatchObject({
      reason: "provider overloaded",
      provider: "anthropic",
    });
  });

  it("classifies Anthropic credit-balance exhaustion as a token usage limit", () => {
    const error = Object.assign(
      new Error("Your credit balance is too low to access the API."),
      { status: 400, type: "billing_error" },
    );
    expect(classifyCapacityLimit(error, "claude-sdk")).toMatchObject({
      reason: "token usage limit",
    });
  });

  it("classifies OpenAI tokens-per-min 429 wording as a token rate limit", () => {
    const error = Object.assign(
      new Error("Rate limit reached for gpt-4 on tokens per min (TPM)."),
      { status: 429, code: "rate_limit_exceeded" },
    );
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      reason: "token rate limit",
    });
  });

  it("rejects permanent token-related failures from backend capacity translation", () => {
    const error = Object.assign(
      new Error(
        "This model's maximum context length is 128000 tokens, however you requested 130000 tokens.",
      ),
      {
        status: 400,
        code: "context_length_exceeded",
        type: "invalid_request_error",
      },
    );
    expect(classifyCapacityLimit(error, "openai-sdk")).toBeUndefined();
    expect(
      classifyCapacityLimit(
        new Error("SyntaxError: Unexpected token in JSON"),
        "claude-sdk",
      ),
    ).toBeUndefined();
  });

  it("does not classify an 'unexpected token' worker error as a capacity block", () => {
    const error = new Error(
      "SyntaxError: Unexpected token < in JSON at position 0",
    );
    expect(classifyCapacityLimit(error, "claude-sdk")).toBeUndefined();
  });

  it("unwraps a nested .cause to find the structured status", () => {
    const inner = Object.assign(new Error("429 Too Many Requests"), {
      status: 429,
      code: "rate_limit_exceeded",
    });
    const wrapper = new Error("Agent run failed", { cause: inner });
    expect(classifyCapacityLimit(wrapper, "openai-sdk")).toMatchObject({
      reason: "api rate limit",
    });
  });

  it("falls back to message matching, classifying token-rate wording", () => {
    // No structured status — the wrapped result.errors string case. The token
    // rate wording must win over the generic api-rate matcher.
    const error = new Error("token rate limit exceeded for this workspace");
    expect(classifyCapacityLimit(error, "claude-sdk")).toMatchObject({
      reason: "token rate limit",
    });
  });

  it("falls back to quota wording as a token usage limit", () => {
    const error = new Error(
      "You have exceeded your current quota for this org.",
    );
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      reason: "token usage limit",
    });
  });

  it("falls back to a generic rate-limit message as an api rate limit", () => {
    const error = new Error("429: too many requests, slow down");
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      reason: "api rate limit",
    });
  });

  it("preserves backend retry-after in a capacity interrupt", () => {
    const error = Object.assign(new Error("Rate limited."), {
      status: 429,
      code: "rate_limit_exceeded",
      headers: { "retry-after": "12" },
    });
    expect(classifyCapacityLimit(error, "openai-sdk")).toMatchObject({
      retryAfterMs: 12000,
    });
  });

  it("returns undefined for a non-capacity error", () => {
    const error = new Error("the worker crashed parsing JSON");
    expect(classifyCapacityLimit(error, "claude-sdk")).toBeUndefined();
  });

  it("returns undefined for non-SDK backends even with rate-limit wording", () => {
    const error = new Error("429 rate limit exceeded");
    expect(classifyCapacityLimit(error, "in-process")).toBeUndefined();
    expect(classifyCapacityLimit(error, "pi-agent")).toBeUndefined();
  });
});
