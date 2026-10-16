/// <reference lib="dom" />
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeWorkEvents, usePolling } from "../src/hooks/usePolling";
import type { RunDetail, RunSummary, WorkEvent } from "../src/types";

class ControlledEventSource extends EventTarget {
  static instances: ControlledEventSource[] = [];
  closed = false;
  constructor(readonly url: string) {
    super();
    ControlledEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, value = {}) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) }));
  }
}
let root: Root;
let current: ReturnType<typeof usePolling>;
let requests: string[];
let runs: RunSummary[];
let detail: Extract<RunDetail, { stage: "actioning" }>;
let history: WorkEvent[];
let delayed: ((url: string) => Promise<Response> | undefined) | undefined;
const event = (
  id: string,
  kind:
    | "run:completed"
    | "control:paused"
    | "control:resumed" = "run:completed",
): WorkEvent => ({
  id,
  kind,
  arcRunId: "r",
  createdAt: "2026-09-16T00:00:00.000Z",
});
function Probe({ selected }: { selected: string | null }) {
  current = usePolling(selected);
  return null;
}
async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}
async function render(selected: string | null) {
  await act(async () => root.render(createElement(Probe, { selected })));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  ControlledEventSource.instances = [];
  vi.stubGlobal("EventSource", ControlledEventSource);
  requests = [];
  history = [];
  delayed = undefined;
  detail = {
    id: "r",
    title: "Run",
    stage: "actioning",
    arcRef: "arc:test:Main",
    status: "running",
    lifecycle: "active",
    createdAt: "now",
    updatedAt: "now",
    workspacePath: "/tmp/r",
    artifacts: 0,
    pendingActions: 0,
    outbound: [],
    workEvents: [],
    pause: { arcRunId: "r", status: "running", updatedAt: "now" },
  };
  runs = [detail];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      requests.push(url);
      const pending = delayed?.(url);
      if (pending) return pending;
      if (url === "/api/health")
        return Response.json({ ok: true, service: "arcade", wired: true });
      if (url === "/api/outbound")
        return Response.json({ messages: [], wired: true });
      if (url === "/api/runs") return Response.json({ runs, wired: true });
      if (url.startsWith("/api/handshakes/"))
        return Response.json({ arcRunId: "p", events: history, wired: true });
      const id = decodeURIComponent(url.split("/").at(-1)!);
      const run = runs.find((run) => run.id === id);
      return run
        ? Response.json({
            run:
              id === "r"
                ? {
                    ...detail,
                    workEvents: history.filter(
                      (event) => event.arcRunId === id,
                    ),
                  }
                : {
                    ...run,
                    outbound: [],
                    workEvents: history.filter(
                      (event) => event.arcRunId === id,
                    ),
                  },
            wired: true,
          })
        : Response.json({ error: "missing" }, { status: 404 });
    }),
  );
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Browser work event catch-up", () => {
  it("opens one stream without selection and keeps it across receipt-owned selection changes", async () => {
    await render(null);
    expect(ControlledEventSource.instances).toHaveLength(1);
    expect(requests).not.toContain("/api/runs");
    await act(async () =>
      ControlledEventSource.instances[0]!.emit("stream.ready"),
    );
    await flush();
    expect(current.state.runs).toHaveLength(1);
    expect(current.state.detail).toBeUndefined();
    await render("r");
    expect(current.state.detail?.id).toBe("r");
    await render(null);
    expect(ControlledEventSource.instances).toHaveLength(1);
    expect(ControlledEventSource.instances[0]!.closed).toBe(false);
  });

  it("loads handshake history from the receipt preparation identity before any event arrives", async () => {
    await render(null);
    await act(async () =>
      ControlledEventSource.instances[0]!.emit("stream.ready"),
    );
    await flush();
    await act(async () =>
      current.registerHandshake({
        id: "receipt",
        status: "handshake-required",
        arcRunId: "p",
        handshakeId: "h",
        receivedAt: "now",
      }),
    );
    await flush();
    expect(requests).toContain("/api/handshakes/h/events?arcRunId=p");
    expect(current.state.handshakes.h?.arcRunId).toBe("p");
    expect(current.state.detail).toBeUndefined();
  });

  it("merges reconnect history in append order before buffered events even at equal times", async () => {
    await render("r");
    const source = ControlledEventSource.instances[0]!;
    let release!: (response: Response) => void;
    delayed = (url) =>
      url === "/api/runs/r"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    await act(async () => source.emit("stream.ready"));
    await flush();
    const first = event("z"),
      next = event("a");
    await act(async () => source.emit("work.event", { event: next }));
    delayed = undefined;
    history = [first, next];
    await act(async () =>
      release(
        Response.json({ run: { ...detail, workEvents: [first] }, wired: true }),
      ),
    );
    await flush();
    expect(current.state.histories.r?.map((event) => event.id)).toEqual([
      "z",
      "a",
    ]);
    await act(async () => source.emit("error"));
    const count = requests.filter((url) => url === "/api/runs").length;
    await act(async () => source.emit("work.event", { event: event("b") }));
    expect(requests.filter((url) => url === "/api/runs")).toHaveLength(count);
    await act(async () => source.emit("stream.ready"));
    await flush();
    expect(current.state.histories.r?.map((event) => event.id)).toEqual([
      "z",
      "a",
      "b",
    ]);
  });

  it("retains handshake activity from events before submission and removes expired current views on the timer", async () => {
    const pending: WorkEvent = {
      id: "pending",
      kind: "run:handshake-pending",
      arcRunId: "p",
      handshakeId: "h",
      createdAt: "now",
    };
    history = [pending];
    runs = [
      {
        id: "p",
        title: "Selection",
        stage: "handshaking",
        arcRef: "arc:test:Main",
        handshakeId: "h",
        status: "waiting",
        pendingActions: 0,
      },
    ];
    await render(null);
    const source = ControlledEventSource.instances[0]!;
    await act(async () => source.emit("stream.ready"));
    await flush();
    await act(async () => source.emit("work.event", { event: pending }));
    await flush();
    await act(async () =>
      current.registerHandshake({
        id: "receipt",
        status: "handshake-required",
        arcRunId: "p",
        handshakeId: "h",
        handshakePrompt: "Choose a run",
        receivedAt: "now",
      }),
    );
    await flush();
    expect(current.state.handshakes.h).toMatchObject({
      prompt: "Choose a run",
      status: "pending",
    });
    runs = [];
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await flush();
    expect(current.state.runs).toEqual([]);
    expect(current.state.handshakes.h?.status).toBe("ended");
    expect(current.state.histories.p).toHaveLength(1);
    const count = requests.filter((url) => url === "/api/runs").length;
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await flush();
    expect(requests.filter((url) => url === "/api/runs")).toHaveLength(count);
    const resolved: WorkEvent = {
      id: "resolved",
      kind: "run:handshake-resolved",
      arcRunId: "p",
      handshakeId: "h",
      outcome: { kind: "reentry", arcRunId: "r" },
      createdAt: "now",
    };
    await act(async () => source.emit("work.event", { event: resolved }));
    await flush();
    expect(current.state.handshakes.h).toMatchObject({
      status: "resolved",
      outcome: { kind: "reentry", arcRunId: "r" },
      prompt: "Choose a run",
    });
    expect(current.state.detail).toBeUndefined();
  });

  it("refreshes selected control after asynchronous pause and resume and ignores unmounted loads", async () => {
    await render("r");
    const source = ControlledEventSource.instances[0]!;
    await act(async () => source.emit("stream.ready"));
    await flush();
    detail = {
      ...detail,
      pause: {
        arcRunId: "r",
        status: "paused",
        pausedAt: "now",
        updatedAt: "now",
      },
    };
    await act(async () =>
      source.emit("work.event", { event: event("pause", "control:paused") }),
    );
    await flush();
    expect(
      current.state.detail?.stage === "actioning" &&
        current.state.detail.pause.status,
    ).toBe("paused");
    detail = {
      ...detail,
      pause: { arcRunId: "r", status: "running", updatedAt: "now" },
    };
    await act(async () =>
      source.emit("work.event", { event: event("resume", "control:resumed") }),
    );
    await flush();
    expect(
      current.state.detail?.stage === "actioning" &&
        current.state.detail.pause.status,
    ).toBe("running");
    let release!: (response: Response) => void;
    delayed = (url) =>
      url === "/api/runs/r"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    await act(async () => current.refreshNow());
    await flush();
    const snapshot = current.state;
    await act(async () => root.unmount());
    await act(async () =>
      release(
        Response.json({ run: { ...detail, title: "stale" }, wired: true }),
      ),
    );
    await flush();
    expect(current.state).toBe(snapshot);
    expect(source.closed).toBe(true);
    root = createRoot(document.createElement("div"));
  });

  it("refreshes provider park controls on capacity and transport events", async () => {
    await render("r");
    const source = ControlledEventSource.instances[0]!;
    await act(async () => source.emit("stream.ready"));
    await flush();
    const base = {
      id: "park",
      arcRunId: "r",
      createdAt: "now",
      routineId: "routine",
      role: "worker",
      backend: "openai-sdk",
      nodeName: "Main",
    };
    const capacityReason = {
      reason: "api rate limit" as const,
      provider: "test",
      backend: "openai-sdk",
      message: "Wait",
    };
    detail = {
      ...detail,
      pause: {
        arcRunId: "r",
        status: "capacity-limited",
        capacityLimitedAt: "now",
        capacityLimitedRoutineId: "routine",
        capacityReason,
        updatedAt: "now",
      },
    };
    await act(async () =>
      source.emit("work.event", {
        event: { ...base, kind: "routine:capacity-limited", capacityReason },
      }),
    );
    await flush();
    expect(
      current.state.detail?.stage === "actioning" &&
        current.state.detail.pause.status,
    ).toBe("capacity-limited");
    const transportReason = {
      reason: "connection reset" as const,
      backend: "openai-sdk",
      message: "Disconnected",
    };
    detail = {
      ...detail,
      pause: {
        arcRunId: "r",
        status: "transport-lost",
        transportLostAt: "now",
        transportLostRoutineId: "routine",
        transportReason,
        updatedAt: "now",
      },
    };
    await act(async () =>
      source.emit("work.event", {
        event: {
          ...base,
          id: "transport",
          kind: "routine:transport-lost",
          transportReason,
        },
      }),
    );
    await flush();
    expect(
      current.state.detail?.stage === "actioning" &&
        current.state.detail.pause.status,
    ).toBe("transport-lost");
  });

  it("ignores an earlier selected-detail response after newer catch-up has completed", async () => {
    await render("r");
    const source = ControlledEventSource.instances[0]!;
    await act(async () => source.emit("stream.ready"));
    await flush();
    await render(null);
    let release!: (response: Response) => void;
    delayed = (url) =>
      url === "/api/runs/r"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : undefined;
    await render("r");
    delayed = undefined;
    detail = { ...detail, title: "latest" };
    await act(async () => current.refreshNow());
    await flush();
    await act(async () =>
      release(
        Response.json({ run: { ...detail, title: "stale" }, wired: true }),
      ),
    );
    await flush();
    expect(current.state.detail?.title).toBe("latest");
  });

  it("deduplicates work event ids without sorting append chronology", () => {
    expect(
      mergeWorkEvents([event("z")], [event("a"), event("z")]).map(
        (event) => event.id,
      ),
    ).toEqual(["z", "a"]);
  });
});
