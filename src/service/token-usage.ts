import type { RoutineTokenUsage } from "../types/token-usage.js";

type RoutineTokenUsageBreakdown = NonNullable<
  RoutineTokenUsage["models"]
>[string];

export function addRoutineTokenUsage(
  left: RoutineTokenUsage | undefined,
  right: RoutineTokenUsage | undefined,
): RoutineTokenUsage | undefined {
  if (!left) return normalizeRoutineTokenUsage(right);
  if (!right) return normalizeRoutineTokenUsage(left);
  const combined: RoutineTokenUsage = {};
  addField(combined, "requests", left.requests);
  addField(combined, "requests", right.requests);
  addField(combined, "inputTokens", left.inputTokens);
  addField(combined, "inputTokens", right.inputTokens);
  addField(combined, "outputTokens", left.outputTokens);
  addField(combined, "outputTokens", right.outputTokens);
  addField(combined, "totalTokens", left.totalTokens);
  addField(combined, "totalTokens", right.totalTokens);
  addField(combined, "cacheCreationInputTokens", left.cacheCreationInputTokens);
  addField(
    combined,
    "cacheCreationInputTokens",
    right.cacheCreationInputTokens,
  );
  addField(combined, "cacheReadInputTokens", left.cacheReadInputTokens);
  addField(combined, "cacheReadInputTokens", right.cacheReadInputTokens);
  addField(combined, "reasoningTokens", left.reasoningTokens);
  addField(combined, "reasoningTokens", right.reasoningTokens);
  addField(combined, "costUsd", left.costUsd);
  addField(combined, "costUsd", right.costUsd);

  const models = new Map<string, RoutineTokenUsageBreakdown>();
  mergeModels(models, left.models);
  mergeModels(models, right.models);
  if (models.size > 0) combined.models = Object.fromEntries(models);

  return normalizeRoutineTokenUsage(combined);
}

export function routineTokenUsageFromClaudeSdkMessages(
  messages: readonly unknown[],
): RoutineTokenUsage | undefined {
  let usage: RoutineTokenUsage | undefined;
  for (const message of messages) {
    if (!isRecord(message) || message.type !== "result") continue;
    usage = addRoutineTokenUsage(
      usage,
      routineTokenUsageFromClaudeResult(message),
    );
  }
  return usage;
}

export function routineTokenUsageFromOpenAiRun(
  result: unknown,
): RoutineTokenUsage | undefined {
  if (!isRecord(result)) return undefined;
  const runContext = isRecord(result.runContext)
    ? result.runContext
    : undefined;
  const runContextUsage = runContext
    ? routineTokenUsageFromOpenAiUsage(runContext.usage)
    : undefined;
  if (runContextUsage) return runContextUsage;

  const state = isRecord(result.state) ? result.state : undefined;
  const stateUsage = state
    ? routineTokenUsageFromOpenAiUsage(state.usage)
    : undefined;
  if (stateUsage) return stateUsage;

  let usage: RoutineTokenUsage | undefined;
  if (Array.isArray(result.rawResponses)) {
    for (const response of result.rawResponses) {
      if (!isRecord(response)) continue;
      usage = addRoutineTokenUsage(
        usage,
        routineTokenUsageFromOpenAiUsage(response.usage),
      );
    }
  }
  return usage;
}

export function routineTokenUsageFromPiAgentMessages(
  messages: readonly unknown[],
): RoutineTokenUsage | undefined {
  let usage: RoutineTokenUsage | undefined;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    usage = addRoutineTokenUsage(
      usage,
      routineTokenUsageFromPiMessage(message),
    );
  }
  return usage;
}

function routineTokenUsageFromClaudeResult(
  message: Record<string, unknown>,
): RoutineTokenUsage | undefined {
  const usage = normalizeRoutineTokenUsage({
    ...routineTokenUsageFromAnthropicUsage(message.usage),
    costUsd: readNumber(message, "total_cost_usd", "totalCostUsd"),
  });
  const models = routineModelUsageFromClaudeResult(message);
  if (!usage && !models) return undefined;
  return normalizeRoutineTokenUsage({
    ...usage,
    ...(models ? { models } : {}),
  });
}

function routineTokenUsageFromAnthropicUsage(
  value: unknown,
): RoutineTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return normalizeRoutineTokenUsage({
    inputTokens: readNumber(value, "input_tokens", "inputTokens"),
    outputTokens: readNumber(value, "output_tokens", "outputTokens"),
    totalTokens: readNumber(value, "total_tokens", "totalTokens"),
    cacheCreationInputTokens: readNumber(
      value,
      "cache_creation_input_tokens",
      "cacheCreationInputTokens",
    ),
    cacheReadInputTokens: readNumber(
      value,
      "cache_read_input_tokens",
      "cacheReadInputTokens",
    ),
  });
}

function routineModelUsageFromClaudeResult(
  message: Record<string, unknown>,
): Record<string, RoutineTokenUsageBreakdown> | undefined {
  if (!isRecord(message.modelUsage)) return undefined;
  const entries: [string, RoutineTokenUsageBreakdown][] = [];
  for (const [model, raw] of Object.entries(message.modelUsage)) {
    if (!isRecord(raw)) continue;
    const usage = normalizeRoutineTokenUsage({
      inputTokens: readNumber(raw, "inputTokens", "input_tokens"),
      outputTokens: readNumber(raw, "outputTokens", "output_tokens"),
      totalTokens: sumNumbers(
        readNumber(raw, "inputTokens", "input_tokens"),
        readNumber(raw, "outputTokens", "output_tokens"),
      ),
      cacheReadInputTokens: readNumber(
        raw,
        "cacheReadInputTokens",
        "cache_read_input_tokens",
      ),
      cacheCreationInputTokens: readNumber(
        raw,
        "cacheCreationInputTokens",
        "cache_creation_input_tokens",
      ),
      costUsd: readNumber(raw, "costUSD", "costUsd", "cost_usd"),
    });
    if (usage) entries.push([model, withoutModels(usage)]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function routineTokenUsageFromOpenAiUsage(
  value: unknown,
): RoutineTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputDetails = sumDetailRecords(
    value.inputTokensDetails,
    value.input_tokens_details,
  );
  const outputDetails = sumDetailRecords(
    value.outputTokensDetails,
    value.output_tokens_details,
  );
  return normalizeRoutineTokenUsage({
    requests: readNumber(value, "requests"),
    inputTokens: readNumber(value, "inputTokens", "input_tokens"),
    outputTokens: readNumber(value, "outputTokens", "output_tokens"),
    totalTokens: readNumber(value, "totalTokens", "total_tokens"),
    cacheReadInputTokens: readNumber(
      inputDetails,
      "cached_tokens",
      "cachedTokens",
    ),
    reasoningTokens: readNumber(
      outputDetails,
      "reasoning_tokens",
      "reasoningTokens",
    ),
  });
}

function routineTokenUsageFromPiMessage(
  message: Record<string, unknown>,
): RoutineTokenUsage | undefined {
  if (!isRecord(message.usage)) return undefined;
  const usage = normalizeRoutineTokenUsage({
    requests: 1,
    inputTokens: readNumber(message.usage, "input"),
    outputTokens: readNumber(message.usage, "output"),
    totalTokens: readNumber(message.usage, "totalTokens", "total_tokens"),
    cacheReadInputTokens: readNumber(message.usage, "cacheRead"),
    cacheCreationInputTokens: readNumber(message.usage, "cacheWrite"),
    costUsd: isRecord(message.usage.cost)
      ? readNumber(message.usage.cost, "total")
      : undefined,
  });
  if (!usage || typeof message.model !== "string") return usage;
  return {
    ...usage,
    models: {
      [message.model]: withoutModels(usage),
    },
  };
}

function normalizeRoutineTokenUsage(
  usage: RoutineTokenUsage | undefined,
): RoutineTokenUsage | undefined {
  if (!usage) return undefined;
  const normalized: RoutineTokenUsage = {};
  copyNumber(normalized, "requests", usage.requests);
  copyNumber(normalized, "inputTokens", usage.inputTokens);
  copyNumber(normalized, "outputTokens", usage.outputTokens);
  copyNumber(
    normalized,
    "totalTokens",
    usage.totalTokens ?? sumNumbers(usage.inputTokens, usage.outputTokens),
  );
  copyNumber(
    normalized,
    "cacheCreationInputTokens",
    usage.cacheCreationInputTokens,
  );
  copyNumber(normalized, "cacheReadInputTokens", usage.cacheReadInputTokens);
  copyNumber(normalized, "reasoningTokens", usage.reasoningTokens);
  copyNumber(normalized, "costUsd", usage.costUsd);
  if (usage.models) {
    const entries: [string, RoutineTokenUsageBreakdown][] = [];
    for (const [model, raw] of Object.entries(usage.models)) {
      const modelUsage = normalizeRoutineTokenUsage(raw);
      if (modelUsage) entries.push([model, withoutModels(modelUsage)]);
    }
    if (entries.length > 0) normalized.models = Object.fromEntries(entries);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function mergeModels(
  target: Map<string, RoutineTokenUsageBreakdown>,
  source: RoutineTokenUsage["models"],
): void {
  if (!source) return;
  for (const [model, usage] of Object.entries(source)) {
    const combined = addRoutineTokenUsage(target.get(model), usage);
    if (combined) target.set(model, withoutModels(combined));
  }
}

function withoutModels(usage: RoutineTokenUsage): RoutineTokenUsageBreakdown {
  const { models: _models, ...rest } = usage;
  return rest;
}

function addField(
  target: RoutineTokenUsage,
  key: keyof RoutineTokenUsageBreakdown,
  value: number | undefined,
): void {
  if (!isUsableNumber(value)) return;
  target[key] = ((target[key] as number | undefined) ?? 0) + value;
}

function copyNumber(
  target: RoutineTokenUsage,
  key: keyof RoutineTokenUsageBreakdown,
  value: number | undefined,
): void {
  if (isUsableNumber(value)) target[key] = value;
}

function readNumber(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (isUsableNumber(value)) return value;
  }
  return undefined;
}

function sumNumbers(...values: Array<number | undefined>): number | undefined {
  let sum = 0;
  let seen = false;
  for (const value of values) {
    if (!isUsableNumber(value)) continue;
    sum += value;
    seen = true;
  }
  return seen ? sum : undefined;
}

function sumDetailRecords(...values: unknown[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    const records = Array.isArray(value) ? value : [value];
    for (const record of records) {
      if (!isRecord(record)) continue;
      for (const [key, raw] of Object.entries(record)) {
        if (isUsableNumber(raw)) result[key] = (result[key] ?? 0) + raw;
      }
    }
  }
  return result;
}

function isUsableNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
