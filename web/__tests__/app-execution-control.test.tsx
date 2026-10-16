/// <reference lib="dom" />
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { MessageList } from "../src/components/MessageList";
import type { ExecutionControlView, RunDetail, WorkEvent } from "../src/types";

class InertEventSource extends EventTarget {
  static instance: InertEventSource;
  constructor(readonly url: string) {
    super();
    InertEventSource.instance = this;
  }
  close() {}
}
const event: WorkEvent = {
  id: "work:stale",
  arcRunId: "r",
  kind: "routine:started",
  routineId: "routine:final",
  role: "$default-worker",
  nodeName: "Main",
  backend: "test",
  createdAt: "2026-10-13T00:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
async function flush() {
  await act(async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  });
}
function controlButtons() {
  return [...container.querySelectorAll("button")].filter((button) =>
    /^(Pause|Continue|Retry|Pausing)$/.test(button.textContent ?? ""),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("EventSource", InertEventSource);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each(["Pause", "Continue"] as const)(
  "web.control-inactive refreshes detail after %s receives an inactive conflict without SSE",
  async (buttonLabel) => {
    const requests: string[] = [];
    let inactive = false;
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let releaseDetail!: () => void;
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    const detail: Extract<RunDetail, { stage: "actioning" }> = {
      id: "r",
      title: "Final instruction",
      stage: "actioning",
      arcRef: "arc:test:Main",
      status: "running",
      lifecycle: "active",
      createdAt: "2026-10-13T00:00:00.000Z",
      updatedAt: "2026-10-13T00:00:00.000Z",
      workspacePath: "/tmp/r",
      artifacts: 0,
      pendingActions: 0,
      outbound: [],
      workEvents: [event],
      pause:
        buttonLabel === "Pause"
          ? { arcRunId: "r", status: "running", updatedAt: "now" }
          : {
              arcRunId: "r",
              status: "paused",
              pausedAt: "now",
              updatedAt: "now",
            },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (url === "/api/health")
          return Response.json({ ok: true, service: "arcade", wired: true });
        if (url === "/api/outbound")
          return Response.json({ messages: [], wired: true });
        if (url === "/api/runs")
          return Response.json({ runs: [detail], wired: true });
        if (init?.method === "POST") {
          await postGate;
          inactive = true;
          return Response.json(
            { error: "run-inactive", arcRunId: "r" },
            { status: 409 },
          );
        }
        if (url === "/api/runs/r") {
          if (inactive) await detailGate;
          return Response.json({
            run: {
              ...detail,
              ...(inactive
                ? {
                    lifecycle: "completed",
                    pause: { status: "inactive", arcRunId: "r" },
                  }
                : {}),
            },
            wired: true,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await act(async () => root.render(<App />));
    // Connection readiness starts initial loading; no run/control SSE is ever delivered.
    await act(async () =>
      InertEventSource.instance.dispatchEvent(new Event("stream.ready")),
    );
    await flush();
    const card = container.querySelector<HTMLButtonElement>(".run-card")!;
    expect(card).not.toBeNull();
    await act(async () => card.click());
    await flush();
    expect(
      requests.filter((request) => request === "GET /api/runs/r").length,
    ).toBeGreaterThan(0);
    const initialRequests = requests.length;
    await flush();
    expect(requests).toHaveLength(initialRequests);
    const button = controlButtons().find(
      (button) => button.textContent === buttonLabel,
    )!;
    expect(button).toBeDefined();
    requests.length = 0;
    await act(async () => button.click());
    expect(requests).toEqual([
      `POST /api/runs/r/${buttonLabel === "Pause" ? "pause" : "resume"}`,
    ]);
    await act(async () => releasePost());
    await flush();
    expect(
      requests.filter((request) => request === "GET /api/runs/r"),
    ).toHaveLength(1);
    await act(async () => releaseDetail());
    await flush();
    expect(controlButtons()).toEqual([]);
    expect(container.querySelector(".activity-status-capacity")).toBeNull();
    expect(
      container.querySelector(".run-card.selected")?.textContent,
    ).toContain("Final instruction");
    expect(container.querySelector(".activity-status-text")).not.toBeNull();
  },
);

it.each([false, true])(
  "web.control-inactive hides controls with stale activity and busy=%s",
  async (busy) => {
    await act(async () =>
      root.render(
        <MessageList
          messages={[]}
          workEvents={[event]}
          pause={{ status: "inactive", arcRunId: "r" }}
          busyRunId={busy ? "r" : undefined}
          expandedAnswered={new Set()}
          answerDrafts={{}}
          onToggleExpanded={vi.fn()}
          onDraftChange={vi.fn()}
          onAnswer={vi.fn()}
          onPermission={vi.fn()}
          onAck={vi.fn()}
          onPauseRun={vi.fn()}
          onContinueRun={vi.fn()}
        />,
      ),
    );
    expect(controlButtons()).toEqual([]);
    expect(container.querySelector(".activity-status-capacity")).toBeNull();
    expect(container.querySelector(".activity-status-text")).not.toBeNull();
  },
);

it.each(["paused", "capacity-limited", "transport-lost"] as const)(
  "web.control-inactive preserves controls for %s views",
  async (status) => {
    const pause: ExecutionControlView =
      status === "paused"
        ? { status, arcRunId: "r", pausedAt: "now", updatedAt: "now" }
        : status === "capacity-limited"
          ? {
              status,
              arcRunId: "r",
              capacityLimitedAt: "now",
              updatedAt: "now",
              capacityLimitedRoutineId: "routine",
              capacityReason: {
                reason: "api rate limit",
                backend: "test",
                provider: "test",
                message: "retry later",
              },
              autoRetry: { pending: true, attempt: 1, maxAttempts: 2 },
            }
          : {
              status,
              arcRunId: "r",
              transportLostAt: "now",
              updatedAt: "now",
              transportLostRoutineId: "routine",
              transportReason: {
                reason: "network timeout",
                backend: "test",
                message: "retry later",
              },
              autoRetry: { pending: true, attempt: 1, maxAttempts: 2 },
            };
    await act(async () =>
      root.render(
        <MessageList
          messages={[]}
          workEvents={[event]}
          pause={pause}
          expandedAnswered={new Set()}
          answerDrafts={{}}
          onToggleExpanded={vi.fn()}
          onDraftChange={vi.fn()}
          onAnswer={vi.fn()}
          onPermission={vi.fn()}
          onAck={vi.fn()}
          onPauseRun={vi.fn()}
          onContinueRun={vi.fn()}
        />,
      ),
    );
    expect(controlButtons().map((button) => button.textContent)).toEqual([
      status === "paused" ? "Continue" : "Retry",
    ]);
    if (status !== "paused")
      expect(container.textContent).toContain("Auto-retrying");
  },
);
