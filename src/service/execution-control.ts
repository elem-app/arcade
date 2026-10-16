/**
 * Sentinels and classifiers for execution control — pausing an arc run and
 * resuming it.
 *
 * A cooperative pause is requested by the operator. Protocol workers return a
 * paused interrupt after retaining their continuation; an in-process callback
 * can throw `RoutinePausedError` for its adapter to translate into that report.
 * The two provider-recovery classifiers turn backend-private errors into the
 * serializable capacity-limited and transport-lost reasons consumed by built-in
 * worker adapters. Both classifiers share the error-chain inspection helpers at
 * the bottom of this module.
 */

import type {
  CapacityLimit,
  ExecutionControlState,
  ExecutionControlView,
  TransportLoss,
} from "../types/execution-control.js";
import type { BackendName } from "../types/worker-slot.js";

// --- Cooperative pause ------------------------------------------------------

/** Adapter-local sentinel thrown by an in-process callback at a safe boundary. */
export class RoutinePausedError extends Error {
  constructor() {
    super("Routine paused at an in-turn safe boundary.");
    this.name = "RoutinePausedError";
  }
}

/** Detect the shared pause sentinel via the exported guard. */
export function isRoutinePausedError(
  error: unknown,
): error is RoutinePausedError {
  return error instanceof RoutinePausedError;
}

// --- Capacity limit ---------------------------------------------------------

/**
 * Sentinel raised when a backend call fails because the upstream provider is out
 * of capacity (an API rate limit or a token usage limit). Carries the structured,
 * serializable reason so the hub can park the run in a recoverable
 * `capacity-limited` state for later resumption.
 */
export class CapacityLimitError extends Error {
  constructor(readonly reason: CapacityLimit) {
    super(reason.message);
    this.name = "CapacityLimitError";
  }
}

/** Detect the capacity limit sentinel via the exported guard. */
export function isCapacityLimitError(
  error: unknown,
): error is CapacityLimitError {
  return error instanceof CapacityLimitError;
}

/**
 * Classify a thrown backend error as a provider-capacity failure, or return
 * `undefined` when it is something else (a real worker bug, a timeout, etc.).
 *
 * Structured fields win: the error chain is walked for status, headers, code,
 * and type signals before falling back to message matching.
 *
 * The reason split distinguishes transient throttling (RPM, TPM, provider
 * overload — recover by waiting) from a hard quota/credit exhaustion (needs a
 * billing action). It is structural for OpenAI (error `code`) but
 * provider-asymmetric for Anthropic, where both RPM and TPM limits surface as
 * `429 rate_limit_error` and the TPM case is promoted from `x-ratelimit-*`
 * headers or message wording, while overload surfaces as a separate `529`.
 *
 * Permanent failures that merely mention "token" (a context-length overflow, an
 * invalid request, a JSON parse error in a worker) are deliberately not
 * classified as capacity blocks: parking them would loop forever on resume.
 */
export function classifyCapacityLimit(
  error: unknown,
  backend: BackendName,
): CapacityLimit | undefined {
  // Gate to SDK backends, including their trigger stage task variants. Without
  // this, the message fallback could misclassify an in-process worker that
  // happens to throw a string containing "429"/"rate limit" as a capacity limit.
  if (
    backend !== "claude-sdk" &&
    backend !== "claude-sdk-tst" &&
    backend !== "openai-sdk" &&
    backend !== "openai-sdk-tst"
  ) {
    return undefined;
  }

  const isOpenAi = backend === "openai-sdk" || backend === "openai-sdk-tst";
  const provider = isOpenAi ? "openai" : "anthropic";
  const chain = errorChain(error);
  const message = errorChainMessage(chain) || errorMessage(error);
  const status = firstNumber(chain, "status", "statusCode");
  const code = firstString(chain, "code");
  const type = firstString(chain, "type");
  const headers = firstHeaders(chain);
  const retryAfterMs = headers ? retryAfterMsFromHeaders(headers) : undefined;

  const finish = (reason: CapacityLimit["reason"]): CapacityLimit => ({
    reason,
    provider,
    backend,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

  // A permanent invalid-request / context-length failure is a real worker error,
  // not a recoverable capacity block, so leave it unclassified. Bail before any
  // message matching, since its message contains "token".
  if (
    code === "context_length_exceeded" ||
    code === "string_above_max_length" ||
    type === "invalid_request_error"
  ) {
    return undefined;
  }

  // Provider-side overload (Anthropic 529 `overloaded_error`): transient and
  // retryable, but not the caller's rate or usage limit.
  if (
    status === 529 ||
    type === "overloaded_error" ||
    /overloaded/i.test(message)
  ) {
    return finish("provider overloaded");
  }

  if (isOpenAi) {
    if (
      status === 429 ||
      code === "rate_limit_exceeded" ||
      code === "insufficient_quota"
    ) {
      if (code === "insufficient_quota" || type === "insufficient_quota") {
        return finish("token usage limit");
      }
      // OpenAI separates RPM from TPM only in the message wording.
      if (tokenRateWording(message)) return finish("token rate limit");
      if (quotaWording(message)) return finish("token usage limit");
      return finish("api rate limit");
    }
    // No structured 429; fall through to message matching.
  } else {
    // Anthropic. Both RPM and TPM limits surface as 429 rate_limit_error, so
    // default to api rate limit and promote to token rate limit on signal.
    if (status === 429 || type === "rate_limit_error") {
      if (tokenBucketExhausted(headers) || tokenRateWording(message)) {
        return finish("token rate limit");
      }
      return finish("api rate limit");
    }
    // A billing/credit exhaustion often surfaces as 400 rather than 429.
    if (
      type === "billing_error" ||
      code === "billing_error" ||
      quotaWording(message)
    ) {
      return finish("token usage limit");
    }
  }

  // Message fallback: no structured status (e.g. the wrapped `result.errors`
  // Error). Require explicit rate/quota wording — never a bare "token" — and
  // check quota first so a hard limit is not mistaken for transient throttling.
  if (quotaWording(message)) return finish("token usage limit");
  if (tokenRateWording(message)) return finish("token rate limit");
  if (apiRateWording(message)) return finish("api rate limit");
  return undefined;
}

/** Wording for a hard quota or credit-balance exhaustion (a billing problem). */
function quotaWording(message: string): boolean {
  return /insufficient[_ ]quota|exceeded your current quota|credit balance|out of credits|billing|usage limit/i.test(
    message,
  );
}

/** Wording for tokens-per-minute throttling (transient). */
function tokenRateWording(message: string): boolean {
  return /tokens? per (?:minute|min|day)|token rate limit|\btpm\b|\btpd\b/i.test(
    message,
  );
}

/** Wording for requests-per-minute throttling or a generic rate limit (transient). */
function apiRateWording(message: string): boolean {
  return /requests? per (?:minute|min|day)|rate[ _]limit|too many requests|\brpm\b|\b429\b/i.test(
    message,
  );
}

function firstHeaders(
  chain: readonly unknown[],
): Record<string, string> | undefined {
  for (const entry of chain) {
    if (!isRecord(entry)) continue;
    const headers = entry["headers"];
    if (!headers) continue;
    // Support both plain objects and Headers-like instances with `get`.
    if (typeof (headers as { get?: unknown }).get === "function") {
      return headers as unknown as Record<string, string>;
    }
    if (!isRecord(headers)) continue;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") out[key.toLowerCase()] = value;
    }
    return out;
  }
  return undefined;
}

/** Read one header value from a plain map or a Headers-like instance. */
function readHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const getter = (headers as { get?: (name: string) => string | null }).get;
  if (typeof getter === "function") {
    return getter.call(headers, name) ?? undefined;
  }
  return headers[name.toLowerCase()];
}

/** Whether Anthropic's token-bucket headers report the token allowance exhausted. */
function tokenBucketExhausted(
  headers: Record<string, string> | undefined,
): boolean {
  if (!headers) return false;
  const remaining =
    readHeader(headers, "anthropic-ratelimit-tokens-remaining") ??
    readHeader(headers, "x-ratelimit-tokens-remaining") ??
    readHeader(headers, "x-ratelimit-remaining-tokens");
  if (remaining !== undefined) {
    const value = Number(remaining);
    if (Number.isFinite(value) && value <= 0) return true;
  }
  return false;
}

function retryAfterMsFromHeaders(
  headers: Record<string, string>,
): number | undefined {
  const value = readHeader(headers, "retry-after");
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

// --- Transport loss ---------------------------------------------------------

/**
 * Sentinel raised when a backend call fails because the round-trip to the
 * provider was lost (host sleep, network loss, a connection reset, or the
 * backend's own SDK timeout). Carries the structured, serializable reason so the
 * hub can park the run in a recoverable `transport-lost` state for later
 * resumption.
 */
export class TransportLossError extends Error {
  constructor(readonly reason: TransportLoss) {
    super(reason.message);
    this.name = "TransportLossError";
  }
}

/** Detect the transport-loss sentinel via the exported guard. */
export function isTransportLossError(
  error: unknown,
): error is TransportLossError {
  return error instanceof TransportLossError;
}

/**
 * Classify a thrown backend error as a transport loss, or return `undefined`
 * when it is something else.
 *
 * Structured fields win: the error chain is walked for a `code` signal before
 * falling back to message wording. A transport loss is the round-trip dying as a
 * whole, so all three reasons are always retryable and none carries a
 * `retry-after`. Genuine worker bugs are left unclassified, so they surface as
 * normal routine failures.
 */
export function classifyTransportLoss(
  error: unknown,
  backend: BackendName,
): TransportLoss | undefined {
  // Gate to SDK backends, matching the capacity classifier. Without this, an
  // in-process worker that happens to throw a string containing "timeout" or
  // "ECONNRESET" could be misclassified as a transport loss.
  if (
    backend !== "claude-sdk" &&
    backend !== "claude-sdk-tst" &&
    backend !== "openai-sdk" &&
    backend !== "openai-sdk-tst"
  ) {
    return undefined;
  }

  const chain = errorChain(error);
  const message = errorChainMessage(chain) || errorMessage(error);
  const code = firstString(chain, "code");

  const finish = (reason: TransportLoss["reason"]): TransportLoss => ({
    reason,
    backend,
    message,
  });

  // A connection reset: the socket dropped mid-call.
  if (
    code === "ECONNRESET" ||
    /socket hang up|connection reset/i.test(message)
  ) {
    return finish("connection reset");
  }

  // A network-level failure: the round-trip never completed (DNS, refusal,
  // timeout, or a stream that closed before it was done).
  if (
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    /fetch failed|\bnetwork\b|premature close|terminated|aborted/i.test(message)
  ) {
    return finish("network timeout");
  }

  // The backend's own liveness timeout aborted the call (`claude-sdk-backend`
  // and `openai-sdk-backend` both throw `…instruction timed out after <n>ms`).
  if (
    /instruction timed out after \d+ms|timed out after \d+ms/i.test(message)
  ) {
    return finish("sdk timeout");
  }

  return undefined;
}

// --- View projection --------------------------------------------------------

/** Durable resume pointer carried by a park control, or `undefined` when not parked. */
export function parkedRoutineId(
  control: ExecutionControlState,
): string | undefined {
  return control.status === "capacity-limited"
    ? control.capacityLimitedRoutineId
    : control.status === "transport-lost"
      ? control.transportLostRoutineId
      : undefined;
}

/**
 * Project a durable execution-control state onto its cross-boundary view
 * variant. Generic so a narrowed input state yields the matching narrowed view,
 * which lets the pause/resume result types carry a precisely-typed control. The
 * auto-retry projection on a parked view is filled in by the worker hub's
 * `getExecutionControlView`.
 */
export function executionControlView<S extends ExecutionControlState>(
  control: S,
): Extract<ExecutionControlView, { status: S["status"] }> {
  return buildExecutionControlView(control) as Extract<
    ExecutionControlView,
    { status: S["status"] }
  >;
}

function buildExecutionControlView(
  control: ExecutionControlState,
): ExecutionControlView {
  switch (control.status) {
    case "running":
      return {
        arcRunId: control.arcRunId,
        status: "running",
        updatedAt: control.updatedAt,
      };
    case "pauseRequested":
      return {
        arcRunId: control.arcRunId,
        status: "pauseRequested",
        requestedAt: control.requestedAt,
        updatedAt: control.updatedAt,
      };
    case "paused":
      return {
        arcRunId: control.arcRunId,
        status: "paused",
        ...(control.requestedAt !== undefined
          ? { requestedAt: control.requestedAt }
          : {}),
        pausedAt: control.pausedAt,
        ...(control.pausedRoutineId !== undefined
          ? { pausedRoutineId: control.pausedRoutineId }
          : {}),
        ...(control.pausedRoutineOrigin !== undefined
          ? { pausedRoutineOrigin: control.pausedRoutineOrigin }
          : {}),
        updatedAt: control.updatedAt,
      };
    case "capacity-limited":
      return {
        arcRunId: control.arcRunId,
        status: "capacity-limited",
        capacityLimitedAt: control.capacityLimitedAt,
        capacityLimitedRoutineId: control.capacityLimitedRoutineId,
        capacityReason: control.capacityReason,
        updatedAt: control.updatedAt,
      };
    case "transport-lost":
      return {
        arcRunId: control.arcRunId,
        status: "transport-lost",
        transportLostAt: control.transportLostAt,
        transportLostRoutineId: control.transportLostRoutineId,
        transportReason: control.transportReason,
        updatedAt: control.updatedAt,
      };
  }
}

// --- Shared error-chain inspection ------------------------------------------

/** Best-effort message extraction across Error and plain-object error shapes. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error["message"] === "string") {
    return error["message"];
  }
  return String(error);
}

/**
 * Walk the `error` → `.cause` → `.error` chain so wrapper status/header fields
 * can be combined with nested provider code/type fields.
 */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    if (isRecord(current)) {
      current = current["cause"] ?? current["error"];
    } else {
      break;
    }
  }
  return chain;
}

/** Join the readable messages found across an error chain. */
function errorChainMessage(chain: readonly unknown[]): string {
  return chain
    .map((entry) => {
      if (entry instanceof Error) return entry.message;
      if (typeof entry === "string") return entry;
      if (isRecord(entry) && typeof entry["message"] === "string") {
        return entry["message"];
      }
      return "";
    })
    .filter((entry) => entry.length > 0)
    .join(" ");
}

/** First numeric value found under any of `keys` across the chain. */
function firstNumber(
  chain: readonly unknown[],
  ...keys: readonly string[]
): number | undefined {
  for (const entry of chain) {
    if (!isRecord(entry)) continue;
    for (const key of keys) {
      const value = entry[key];
      if (typeof value === "number") return value;
    }
  }
  return undefined;
}

/** First string value found under any of `keys` across the chain. */
function firstString(
  chain: readonly unknown[],
  ...keys: readonly string[]
): string | undefined {
  for (const entry of chain) {
    if (!isRecord(entry)) continue;
    for (const key of keys) {
      const value = entry[key];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
