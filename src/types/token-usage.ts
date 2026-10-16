/** Normalized host-observed token usage. */
export type RoutineTokenUsage = {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  models?: Record<
    string,
    {
      requests?: number;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cacheCreationInputTokens?: number;
      cacheReadInputTokens?: number;
      reasoningTokens?: number;
      costUsd?: number;
    }
  >;
};
