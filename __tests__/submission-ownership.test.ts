import { parse } from "@elem-app/arc/parser";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKER_ROLE,
  InMemoryArcHostStore,
  type OutboundMessage,
  probeRetention,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  collectAsync,
  deferred,
  firstActivation,
  makeArcHost,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";

const inbound = { content: "start", metadata: { principal: ALICE_OWNER } };

async function askFixture(permission = false) {
  const arcHost = await makeArcHostWithSource("answer-ownership", WATCH_SOURCE);
  const asked = deferred();
  const answered = deferred();
  const finished = deferred();
  let ask: OutboundMessage;
  let accepted = false;
  const setup = makeWorkerHub({
    arcHost,
    workers: {
      researcher: async (_task, _context, effects) => {
        if (permission)
          await effects.requestPermission({
            toolCallId: "ownership",
            toolName: "Write",
            input: {},
          });
        else
          await effects.emit({
            situation: { audience: "originator", cause: "question" },
            content: "Proceed?",
          });
        accepted = true;
        answered.resolve();
        await finished.promise;
        return { outcome: "completed" };
      },
    },
  });
  setup.workerHub.registerOutboundHandler(
    { role: "researcher", audience: "*", cause: "*" },
    (message) => {
      ask = message;
      asked.resolve();
    },
  );
  const id = await firstActivation(setup.workerHub.submitInbound(inbound));
  await asked.promise;
  return {
    ...setup,
    arcHost,
    id,
    answered,
    finished,
    accepted: () => accepted,
    answer: {
      arcRunId: id,
      content: "yes",
      metadata: {
        askId: ask!.metadata!.askId,
        ...(permission ? { decision: "allow" } : {}),
      },
    },
    async stop() {
      finished.resolve();
      await setup.workerHub.stop();
      await arcHost.stop();
    },
  };
}

describe("Owned inbound submissions", () => {
  it("rejects admission through an already-aborted signal without retaining a listener", async () => {
    const arcHost = await makeArcHost();
    const { workerHub } = makeWorkerHub({ arcHost });
    const begin = vi.spyOn(arcHost, "begin");
    const controller = new AbortController();
    controller.abort();
    try {
      const events = workerHub.submitInbound(inbound, {
        signal: controller.signal,
      });
      expect(await collectAsync(events)).toEqual([]);
      expect(begin).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(probeRetention(workerHub).transient.submissions).toBe(0);
    } finally {
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it.each(["completion", "failure", "abort", "shutdown"] as const)(
    "detaches the submission abort listener after %s without event consumption",
    async (ending) => {
      const arcHost = await makeArcHost();
      const { workerHub } = makeWorkerHub({ arcHost });
      const controller = new AbortController();
      if (ending === "failure")
        vi.spyOn(arcHost, "begin").mockRejectedValue(
          new Error("admission failed"),
        );
      try {
        const events = workerHub.submitInbound(inbound, {
          signal: controller.signal,
        });
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
        if (ending === "abort") controller.abort();
        if (ending === "shutdown") await workerHub.stop();
        await waitFor(
          () => probeRetention(workerHub).transient.submissions === 0,
        );
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
        if (ending === "failure")
          await expect(collectAsync(events)).rejects.toThrow(
            "admission failed",
          );
        else expect(await collectAsync(events)).toEqual([]);
        controller.abort();
        expect(probeRetention(workerHub).transient.submissions).toBe(0);
      } finally {
        await workerHub.stop();
        await arcHost.stop();
      }
    },
  );

  it("cancels multiple pending submissions through one shared signal", async () => {
    const arcHost = await makeArcHost();
    await arcHost.registerArc("shared-abort", parse(WATCH_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const { workerHub } = makeWorkerHub({ arcHost });
    const controller = new AbortController();
    try {
      const streams = [0, 1].map(() =>
        workerHub.submitInbound(inbound, { signal: controller.signal }),
      );
      await waitFor(
        () => probeRetention(workerHub).transient.handshakeCorrelations === 2,
      );
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(2);
      controller.abort();
      const outcomes = await Promise.all(streams.map(collectAsync));
      for (const events of outcomes) {
        expect(events.map((event) => event.kind)).toEqual([
          "handshake-required",
          "handshake-settled",
        ]);
        expect(events[1]).toMatchObject({ outcome: "cancelled" });
      }
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(probeRetention(workerHub).transient).toMatchObject({
        submissions: 0,
        handshakeCorrelations: 0,
      });
      expect(probeRetention(arcHost).transient.pendingHandshakes).toBe(0);
    } finally {
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it("settles cancellation once when handshake settlements overflow a full queue", async () => {
    const arcHost = await makeArcHost();
    for (let i = 0; i < 2; i++)
      await arcHost.registerArc(
        `settlement-overflow-${i}`,
        parse(WATCH_SOURCE),
        { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      );
    const { workerHub } = makeWorkerHub({
      arcHost,
      submissionQueue: { maxEvents: 2 },
    });
    try {
      const submissionAbort = new AbortController();
      const submission = workerHub.submitInbound(
        {
          ...inbound,
          metadata: { ...inbound.metadata, activationPolicy: "all" },
        },
        { signal: submissionAbort.signal },
      );
      await waitFor(
        () => probeRetention(workerHub).transient.handshakeCorrelations === 2,
      );
      submissionAbort.abort();
      await waitFor(
        () => probeRetention(workerHub).transient.submissions === 0,
      );
      await expect(collectAsync(submission)).rejects.toThrow(
        "retention budget",
      );
      expect(probeRetention(workerHub).transient).toMatchObject({
        submissions: 0,
        handshakeCorrelations: 0,
        submissionOperations: 0,
      });
      expect(probeRetention(arcHost).transient.pendingHandshakes).toBe(0);
    } finally {
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it("waits for a cancelled probe invocation and fences its late activation", async () => {
    const arcHost = await makeArcHostWithSource(
      "probe-cancel",
      `"arc"; function Main() { this.trigger = () => judge("start"); $instruct("Work"); }`,
    );
    const entered = deferred();
    const release = deferred();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        [DEFAULT_WORKER_ROLE]: async (task) => {
          entered.resolve();
          await release.promise;
          return task.kind === "semantic"
            ? {
                outcome: "completed",
                semantic: {
                  judgments: Object.fromEntries(
                    task.requests.map((request) => [request.briefId, true]),
                  ),
                },
              }
            : { outcome: "completed" };
        },
      },
    });
    try {
      const submissionAbort = new AbortController();
      const submission = workerHub.submitInbound(inbound, {
        signal: submissionAbort.signal,
      });
      await entered.promise;
      let done = false;
      const events = collectAsync(submission).then((events) => {
        done = true;
        return events;
      });
      submissionAbort.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      release.resolve();
      expect(await events).toEqual([]);
      expect(await arcHost.listRunViews()).toEqual([]);
      expect(probeRetention(workerHub).transient).toMatchObject({
        laps: 0,
        lapFailures: 0,
        scopes: 0,
        routines: 0,
        submissions: 0,
      });
    } finally {
      release.resolve();
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it("preserves a committed activation while cancellation waits for admission history", async () => {
    const arcHost = await makeArcHostWithSource(
      "claimed-activation",
      WATCH_SOURCE,
    );
    const entered = deferred();
    const release = deferred();
    const working = deferred();
    const { workerHub, historyStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => {
          working.resolve();
          return { outcome: "completed" };
        },
      },
    });
    const append = historyStore.appendEntry.bind(historyStore);
    vi.spyOn(historyStore, "appendEntry").mockImplementationOnce(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return append(...args);
      },
    );
    try {
      const submissionAbort = new AbortController();
      const submission = workerHub.submitInbound(inbound, {
        signal: submissionAbort.signal,
      });
      await entered.promise;
      let done = false;
      const events = collectAsync(submission).then((events) => {
        done = true;
        return events;
      });
      void submissionAbort.abort();
      await new Promise((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      release.resolve();
      expect(await events).toEqual([
        expect.objectContaining({ kind: "activated" }),
      ]);
      expect(
        (await arcHost.listRunViews()).some(
          (view) => view.stage === "actioning",
        ),
      ).toBe(true);
    } finally {
      release.resolve();
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it("dispatches the committed fan-out sibling when cancellation interrupts the next claim", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "cancel-fanout",
      parse(`"arc";
        function First() { this.trigger = () => true; $instruct("first"); }
        function Second() { this.trigger = () => true; $instruct("second"); }
      `),
    );
    const entered = deferred();
    const release = deferred();
    const finishWork = deferred();
    const run = vi.fn(async () => {
      await finishWork.promise;
      return { outcome: "completed" as const };
    });
    const { workerHub, historyStore } = makeWorkerHub({
      arcHost,
      workers: { [DEFAULT_WORKER_ROLE]: run },
    });
    const committed = new Set<string>();
    const put = store.putState.bind(store);
    vi.spyOn(store, "putState").mockImplementation(async (key, state) => {
      await put(key, state);
      committed.add(key);
    });
    const get = store.getState.bind(store);
    let blocked = false;
    vi.spyOn(store, "getState").mockImplementation(async (key) => {
      const state = await get(key);
      if (!blocked && !state && committed.size === 1) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return state;
    });
    const controller = new AbortController();
    try {
      const stream = workerHub.submitInbound(
        {
          ...inbound,
          metadata: { ...inbound.metadata, activationPolicy: "all" },
        },
        { signal: controller.signal },
      );
      await entered.promise;
      expect(probeRetention(arcHost).transient.actioning).toBe(1);
      controller.abort();
      release.resolve();
      const events = await collectAsync(stream);
      expect(events).toEqual([expect.objectContaining({ kind: "activated" })]);
      const activation = events[0]!;
      if (activation.kind !== "activated")
        throw new Error("Expected activation");
      await waitFor(() => run.mock.calls.length === 1);
      expect(await historyStore.listEntries(activation.arcRunId)).toEqual([
        expect.objectContaining({ content: inbound.content }),
      ]);
      expect(committed.size).toBe(1);
      expect(probeRetention(arcHost).transient).toMatchObject({
        preparing: 0,
        pendingProbes: 0,
        pendingHandshakes: 0,
        actioning: 1,
      });
      expect(probeRetention(workerHub).transient.submissions).toBe(0);
      finishWork.resolve();
      await waitFor(() => probeRetention(arcHost).transient.actioning === 0);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      release.resolve();
      finishWork.resolve();
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it("cancels admission before begin and terminates its event stream", async () => {
    const arcHost = await makeArcHostWithSource("early-cancel", WATCH_SOURCE);
    const { workerHub } = makeWorkerHub({ arcHost });
    const begin = vi.spyOn(arcHost, "begin");
    try {
      const submissionAbort = new AbortController();
      const submission = workerHub.submitInbound(inbound, {
        signal: submissionAbort.signal,
      });
      expect(submissionAbort.abort()).toBeUndefined();
      expect(submissionAbort.abort()).toBeUndefined();
      expect(await collectAsync(submission)).toEqual([]);
      expect(begin).not.toHaveBeenCalled();
      expect(probeRetention(workerHub).transient).toMatchObject({
        submissions: 0,
        submissionOperations: 0,
      });
    } finally {
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it("keeps unread handshake ownership after iterator exit until explicit cancellation", async () => {
    const arcHost = await makeArcHost();
    await arcHost.registerArc("gated-cancel", parse(WATCH_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const { workerHub } = makeWorkerHub({ arcHost });
    try {
      const submissionAbort = new AbortController();
      const submission = workerHub.submitInbound(inbound, {
        signal: submissionAbort.signal,
      });
      for await (const event of submission) {
        expect(event.kind).toBe("handshake-required");
        break;
      }
      expect(probeRetention(workerHub).transient.submissions).toBe(1);
      submissionAbort.abort();
      expect(await collectAsync(submission)).toEqual([
        {
          kind: "handshake-settled",
          handshakeId: expect.any(String),
          outcome: "cancelled",
        },
      ]);
      expect(probeRetention(arcHost).transient.pendingHandshakes).toBe(0);
      expect(probeRetention(workerHub).transient).toMatchObject({
        submissions: 0,
        handshakeCorrelations: 0,
      });
    } finally {
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it.each([false, true])(
    "leaves an unclaimed %s permission-mode ask available when its answer is cancelled",
    async (permission) => {
      const setup = await askFixture(permission);
      try {
        const submissionAbort = new AbortController();
        const submission = setup.workerHub.submitInbound(setup.answer, {
          signal: submissionAbort.signal,
        });
        submissionAbort.abort();
        expect(await collectAsync(submission)).toEqual([]);
        expect(setup.accepted()).toBe(false);
        expect(probeRetention(setup.workerHub).transient.asks).toBe(1);
        const replacement = setup.workerHub.submitInbound(setup.answer);
        expect(await collectAsync(replacement)).toEqual([
          { kind: "continued", arcRunId: setup.id },
        ]);
        await setup.answered.promise;
      } finally {
        await setup.stop();
      }
    },
  );

  it.each(["success", "failure"] as const)(
    "holds a claimed question through cancellation and history %s",
    async (outcome) => {
      const setup = await askFixture();
      const entered = deferred();
      const release = deferred();
      const append = setup.historyStore.appendEntry.bind(setup.historyStore);
      vi.spyOn(setup.historyStore, "appendEntry").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          if (outcome === "failure") throw new Error("Answer history failed.");
          await append(...args);
        },
      );
      try {
        const submissionAbort = new AbortController();
        const submission = setup.workerHub.submitInbound(setup.answer, {
          signal: submissionAbort.signal,
        });
        const events = collectAsync(submission).then(
          (events) => ({ events }),
          (error: unknown) => ({ error }),
        );
        await entered.promise;
        let done = false;
        void events.then(() => {
          done = true;
        });
        void submissionAbort.abort();
        void submissionAbort.abort();
        await new Promise((resolve) => setImmediate(resolve));
        expect(done).toBe(false);
        expect(probeRetention(setup.workerHub).transient.answerDeliveries).toBe(
          1,
        );
        release.resolve();
        const result = await events;
        expect(setup.accepted()).toBe(outcome === "success");
        expect(probeRetention(setup.workerHub).transient).toMatchObject({
          submissions: 0,
          answerDeliveries: 0,
          asks: outcome === "success" ? 0 : 1,
        });
        if (outcome === "success")
          expect(result).toEqual({
            events: [{ kind: "continued", arcRunId: setup.id }],
          });
        else
          expect(result).toMatchObject({
            error: new Error("Answer history failed."),
          });
      } finally {
        release.resolve();
        await setup.stop();
      }
    },
  );

  it("preserves a permission verdict accepted before cancellation without answer history", async () => {
    const setup = await askFixture(true);
    const append = vi.spyOn(setup.historyStore, "appendEntry");
    try {
      const submissionAbort = new AbortController();
      const submission = setup.workerHub.submitInbound(setup.answer, {
        signal: submissionAbort.signal,
      });
      await setup.answered.promise;
      submissionAbort.abort();
      expect(append).not.toHaveBeenCalled();
      expect(await collectAsync(submission)).toEqual([
        { kind: "continued", arcRunId: setup.id },
      ]);
      expect(setup.accepted()).toBe(true);
    } finally {
      await setup.stop();
    }
  });

  it.each(["success", "failure"] as const)(
    "tracks claimed question delivery through stop and history %s",
    async (outcome) => {
      const setup = await askFixture();
      const entered = deferred();
      const release = deferred();
      vi.spyOn(setup.historyStore, "appendEntry").mockImplementationOnce(
        async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "failure") throw new Error("History stopped.");
        },
      );
      try {
        const submission = setup.workerHub.submitInbound(setup.answer);
        const events = collectAsync(submission).catch(
          (error: unknown) => error,
        );
        await entered.promise;
        let stopped = false;
        const stop = setup.workerHub.stop().then(() => {
          stopped = true;
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(stopped).toBe(false);
        release.resolve();
        await stop;
        expect(await events).toBeInstanceOf(Error);
        expect(setup.accepted()).toBe(false);
        expect(probeRetention(setup.workerHub).transient).toMatchObject({
          submissions: 0,
          asks: 0,
          answerDeliveries: 0,
        });
        await events;
      } finally {
        release.resolve();
        await setup.stop();
      }
    },
  );

  it.each(["count", "bytes"] as const)(
    "fails unread lifecycle overflow at its %s budget and cancels every pending branch",
    async (budget) => {
      const arcHost = await makeArcHostWithSource("overflow", WATCH_SOURCE);
      for (let i = 0; i < 4; i++)
        await arcHost.registerArc(`overflow-${i}`, parse(WATCH_SOURCE), {
          workspaceScope: "arc",
          bundle: {},
          contextIsolation: "role",
        });
      const { workerHub } = makeWorkerHub({
        arcHost,
        submissionQueue:
          budget === "count" ? { maxEvents: 2 } : { maxBytes: 64 },
        workers: { researcher: async () => ({ outcome: "completed" }) },
      });
      try {
        const submission = workerHub.submitInbound({
          ...inbound,
          metadata: { ...inbound.metadata, activationPolicy: "all" },
        });
        // Let the unread queue overflow before attaching its consumer.
        await waitFor(
          () => probeRetention(workerHub).transient.submissions === 0,
        );
        await expect(collectAsync(submission)).rejects.toThrow(
          "retention budget",
        );
        expect(probeRetention(arcHost).transient.pendingHandshakes).toBe(0);
        expect(probeRetention(workerHub).transient).toMatchObject({
          submissions: 0,
          handshakeCorrelations: 0,
          queuedEventBytes: 0,
        });
      } finally {
        await workerHub.stop();
        await arcHost.stop();
      }
    },
  );
});
