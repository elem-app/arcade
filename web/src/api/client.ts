import type {
  ActionResponse,
  DirectoryChoice,
  EntryResponse,
  ExecutionControlActionResponse,
  HandshakeResolutionValues,
  HandshakeResponse,
  HealthResponse,
  OutboundItem,
  PermissionDecision,
  RunDetailResponse,
  RunsResponse,
  WorkEvent,
} from "../types";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; extra?: unknown };

export function getHealth(
  signal?: AbortSignal,
): Promise<ApiResult<HealthResponse>> {
  return requestJson<HealthResponse>("/api/health", { signal });
}

export function getRuns(
  signal?: AbortSignal,
): Promise<ApiResult<RunsResponse>> {
  return requestJson<RunsResponse>("/api/runs", { signal });
}

export function getRunDetail(
  id: string,
  signal?: AbortSignal,
): Promise<ApiResult<RunDetailResponse>> {
  return requestJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(id)}`, {
    signal,
  });
}

export function submitEntry(
  content: string,
  workingRoot: string,
  signal?: AbortSignal,
): Promise<ApiResult<EntryResponse>> {
  return requestJson<EntryResponse>("/api/entry/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, workingRoot }),
    signal,
  });
}

export function resolveHandshake(
  id: string,
  values: HandshakeResolutionValues,
  signal?: AbortSignal,
): Promise<ApiResult<HandshakeResponse>> {
  return requestJson<HandshakeResponse>(
    `/api/handshakes/${encodeURIComponent(id)}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values }),
      signal,
    },
  );
}

export function answerQuestion(
  id: string,
  content: string,
  signal?: AbortSignal,
): Promise<ApiResult<ActionResponse>> {
  return requestJson<ActionResponse>(
    `/api/outbound/${encodeURIComponent(id)}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
      signal,
    },
  );
}

export function answerPermission(
  id: string,
  decision: PermissionDecision,
  signal?: AbortSignal,
): Promise<ApiResult<ActionResponse>> {
  return requestJson<ActionResponse>(
    `/api/outbound/${encodeURIComponent(id)}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
      signal,
    },
  );
}

export function ackOutbound(
  id: string,
  signal?: AbortSignal,
): Promise<ApiResult<ActionResponse>> {
  return requestJson<ActionResponse>(
    `/api/outbound/${encodeURIComponent(id)}/ack`,
    { method: "POST", signal },
  );
}

export function resumeRun(
  arcRunId: string,
  signal?: AbortSignal,
): Promise<ApiResult<ExecutionControlActionResponse>> {
  return requestJson<ExecutionControlActionResponse>(
    `/api/runs/${encodeURIComponent(arcRunId)}/resume`,
    { method: "POST", signal },
  );
}

export function requestPause(
  arcRunId: string,
  signal?: AbortSignal,
): Promise<ApiResult<ExecutionControlActionResponse>> {
  return requestJson<ExecutionControlActionResponse>(
    `/api/runs/${encodeURIComponent(arcRunId)}/pause`,
    { method: "POST", signal },
  );
}

export async function chooseDirectory(): Promise<ApiResult<DirectoryChoice>> {
  const result = await requestJson<unknown>("/api/system/choose-directory", {
    method: "POST",
  });
  if (!result.ok) {
    if (result.status === 501) {
      return {
        ok: true,
        data: {
          status: "unavailable",
          message:
            typeof result.extra === "object" &&
            result.extra !== null &&
            "message" in result.extra &&
            typeof result.extra.message === "string"
              ? result.extra.message
              : result.error,
        },
      };
    }
    return result;
  }
  if (isSelectedDirectory(result.data) || isCanceledDirectory(result.data)) {
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    status: 0,
    error: "Unexpected directory picker response.",
    extra: result.data,
  };
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, status: 0, error: "aborted" };
    }
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : "Network request failed.",
      extra: error,
    };
  }

  const parsed = await parseJson(response);
  if (!parsed.ok) {
    return {
      ok: false,
      status: response.status,
      error: parsed.error,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: errorFromBody(parsed.data, response.statusText),
      extra: parsed.data,
    };
  }

  return { ok: true, data: parsed.data as T };
}

async function parseJson(
  response: Response,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, error: "Response was not valid JSON." };
  }
}

function errorFromBody(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = body.error;
    if (typeof error === "string") return error;
  }
  return fallback || "Request failed.";
}

function isSelectedDirectory(value: unknown): value is {
  status: "selected";
  path: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "selected" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

function isCanceledDirectory(value: unknown): value is { status: "canceled" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "canceled"
  );
}

export function getHandshakeWorkEvents(
  id: string,
  arcRunId: string,
  signal?: AbortSignal,
) {
  return requestJson<{ arcRunId: string; events: WorkEvent[]; wired: boolean }>(
    `/api/handshakes/${encodeURIComponent(id)}/events?arcRunId=${encodeURIComponent(arcRunId)}`,
    { signal },
  );
}
export function getOutbound(signal?: AbortSignal) {
  return requestJson<{ messages: OutboundItem[]; wired: boolean }>(
    "/api/outbound",
    { signal },
  );
}
