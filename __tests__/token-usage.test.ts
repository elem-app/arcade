import { describe, expect, it } from "vitest";

import {
  addRoutineTokenUsage,
  routineTokenUsageFromClaudeSdkMessages,
  routineTokenUsageFromOpenAiRun,
  routineTokenUsageFromPiAgentMessages,
} from "../src/service/token-usage.js";

describe("routine token usage normalization", () => {
  it("normalizes and sums Claude SDK result usage with per-model usage", () => {
    const usage = routineTokenUsageFromClaudeSdkMessages([
      claudeResult({
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
      }),
      claudeResult(
        {
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 1,
          cache_read_input_tokens: 6,
        },
        {
          modelUsage: {
            "claude-test": {
              inputTokens: 15,
              outputTokens: 6,
              cacheCreationInputTokens: 4,
              cacheReadInputTokens: 8,
              costUSD: 0.5,
            },
          },
          total_cost_usd: 0.5,
        },
      ),
    ]);

    expect(usage).toEqual({
      inputTokens: 15,
      outputTokens: 6,
      totalTokens: 21,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 8,
      costUsd: 0.5,
      models: {
        "claude-test": {
          inputTokens: 15,
          outputTokens: 6,
          totalTokens: 21,
          cacheCreationInputTokens: 4,
          cacheReadInputTokens: 8,
          costUsd: 0.5,
        },
      },
    });
  });

  it("normalizes OpenAI Agents SDK run usage from runContext or raw responses", () => {
    expect(
      routineTokenUsageFromOpenAiRun({
        runContext: {
          usage: {
            requests: 2,
            inputTokens: 20,
            outputTokens: 7,
            totalTokens: 27,
            inputTokensDetails: [{ cached_tokens: 4 }],
            outputTokensDetails: [{ reasoning_tokens: 3 }],
          },
        },
        rawResponses: [
          {
            usage: {
              requests: 99,
              inputTokens: 99,
              outputTokens: 99,
              totalTokens: 198,
            },
          },
        ],
      }),
    ).toEqual({
      requests: 2,
      inputTokens: 20,
      outputTokens: 7,
      totalTokens: 27,
      cacheReadInputTokens: 4,
      reasoningTokens: 3,
    });

    expect(
      routineTokenUsageFromOpenAiRun({
        rawResponses: [
          { usage: { requests: 1, inputTokens: 3, outputTokens: 2 } },
          { usage: { requests: 1, input_tokens: 4, output_tokens: 5 } },
        ],
      }),
    ).toEqual({
      requests: 2,
      inputTokens: 7,
      outputTokens: 7,
      totalTokens: 14,
    });
  });

  it("normalizes PI-agent assistant message usage", () => {
    expect(
      routineTokenUsageFromPiAgentMessages([
        {
          role: "assistant",
          model: "pi-test",
          usage: {
            input: 8,
            output: 3,
            totalTokens: 11,
            cacheRead: 2,
            cacheWrite: 1,
            cost: { total: 0.1 },
          },
        },
        { role: "user", content: "ignored" },
      ]),
    ).toEqual({
      requests: 1,
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
      cacheCreationInputTokens: 1,
      cacheReadInputTokens: 2,
      costUsd: 0.1,
      models: {
        "pi-test": {
          requests: 1,
          inputTokens: 8,
          outputTokens: 3,
          totalTokens: 11,
          cacheCreationInputTokens: 1,
          cacheReadInputTokens: 2,
          costUsd: 0.1,
        },
      },
    });
  });

  it("omits unrecognized usage and sums recognized values", () => {
    expect(routineTokenUsageFromClaudeSdkMessages([{ type: "result" }])).toBe(
      undefined,
    );
    expect(
      addRoutineTokenUsage(
        { inputTokens: 1, outputTokens: 2 },
        { inputTokens: 3, outputTokens: 4 },
      ),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
  });
});

function claudeResult(
  usage: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    usage,
    ...overrides,
  };
}
