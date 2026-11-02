import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  InMemoryArcHostStore,
  probeRetention,
  type ArcHostStep,
  type Dialog,
  type OutboundMessage,
} from "../src/testing.js";
import {
  expectSoleDriver,
  expectSoleTrigger,
  projectorFor,
} from "./arc-host-helpers.js";
import {
  ALICE_OWNER,
  collectAsync,
  deferred,
  makeWorkerHub,
} from "./helpers.js";
import { createTestArcHost, workEventsFor } from "./work-event-fixtures.js";

const waitFor = (predicate: () => boolean | Promise<boolean>) =>
  vi.waitFor(async () => expect(await predicate()).toBe(true));

async function fixture(gated = false) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const store = new InMemoryArcHostStore();
  const host = await createTestArcHost({
    store,
  });
  const inbound = {
    content: "keep this activating inbound",
    metadata: { principal: ALICE_OWNER },
  };
  const dialog: Dialog = {
    cursor: { user: 1, self: 0 },
    lastTurns: [{ role: "user", message: inbound.content }],
  };
  await host.registerArc(
    "batch-expiry",
    parse(`"arc"; function Main() {
    this.trigger = () => judge("event matches");
    $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; }
  }`),
  );
  const probe = expectSoleTrigger(
    await host.begin({
      principal: ALICE_OWNER,
      projectDialog: projectorFor(dialog),
    }),
  );
  const old = expectSoleDriver(
    await host.advanceTrigger(probe.arcRunId, {
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: { [probe.frontier.briefs.judgments[0]!.id]: true },
          },
        },
      ],
    }),
  );
  expect(await host.getRunView(old.arcRunId)).toMatchObject({
    lifecycle: "deflected",
  });
  await host.releaseAction(old.arcRunId, old.frontier.frontierId);
  // The fresh revision matches synchronously. The deflected run probes its
  // captured semantic trigger and remains unfinished when this batch expires.
  await host.registerArc(
    "batch-expiry",
    parse(`"arc"; function Main() {
    this.trigger = () => true; this.hostParams = { workerRole: "researcher" }; $instruct("Work");
  }`),
    {
      workspaceScope: gated ? "arc" : "run",
      bundle: {},
      contextIsolation: "role",
    },
    { replace: true },
  );
  const entered = deferred();
  const release = deferred();
  const action = deferred();
  const setup = makeWorkerHub({
    arcHost: host,
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
      researcher: async () => {
        action.resolve();
        return { outcome: "completed" };
      },
    },
  });
  workEventsFor(host).close();
  return {
    ...setup,
    host,
    store,
    inbound,
    entered,
    release,
    action,
    expire() {
      vi.advanceTimersByTime(86_400_000);
    },
    async stop() {
      release.resolve();
      await setup.workerHub.stop();
      await host.stop();
      vi.useRealTimers();
    },
  };
}

describe("Hub trigger deadline ownership", () => {
  it.each(["initial", "capacity-limited", "transport-lost"] as const)(
    "admits %s trigger work while duplicate module advancement retains the frontier",
    async (entry) => {
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      await host.registerArc(
        "duplicate-trigger-outcome",
        parse(
          '"arc"; import Time from "host:time"; function Main() { this.trigger = () => Time.nowMillis() > 0 && judge("matches?"); }',
        ),
      );
      const preparing = deferred();
      const allowPreparation = deferred();
      const advancing = deferred();
      const allowAdvance = deferred();
      const finish = deferred();
      let calls = 0;
      const { workerHub, routineStore } = makeWorkerHub({
        arcHost: host,
        workers: {
          [DEFAULT_WORKER_ROLE]: async (task) => {
            calls++;
            if (entry !== "initial" && calls === 1)
              return entry === "capacity-limited"
                ? {
                    suspension: entry,
                    reason: {
                      reason: "token usage limit",
                      provider: "test",
                      message: "held",
                    },
                  }
                : {
                    suspension: entry,
                    reason: { reason: "connection reset", message: "held" },
                  };
            await finish.promise;
            if (task.kind !== "semantic")
              throw new Error("Expected trigger judgment.");
            return {
              outcome: "completed",
              semantic: {
                judgments: Object.fromEntries(
                  task.requests.map(({ briefId }) => [briefId, true]),
                ),
              },
            };
          },
        },
      });
      const deliveries = vi.spyOn(workerHub, "enqueueModuleEffect");
      const advanceTrigger = host.advanceTrigger.bind(host);
      let moduleAdvances = 0;
      const advances = vi
        .spyOn(host, "advanceTrigger")
        .mockImplementation(async (...args) => {
          if ("hostCallId" in args[1] && ++moduleAdvances === 2) {
            advancing.resolve();
            await allowAdvance.promise;
          }
          return advanceTrigger(...args);
        });
      if (entry === "initial") {
        const nodeInfo = host.nodeInfoForRef.bind(host);
        vi.spyOn(host, "nodeInfoForRef").mockImplementationOnce(
          async (...args) => {
            const node = await nodeInfo(...args);
            preparing.resolve();
            await allowPreparation.promise;
            return node;
          },
        );
      }
      try {
        const events = workerHub.submitInbound({
          content: "start",
          metadata: { principal: ALICE_OWNER },
        });
        let resuming: Promise<unknown> | undefined;
        if (entry !== "initial") {
          await waitFor(
            () => probeRetention(workerHub).transient.continuations === 1,
          );
          const getRoutine = routineStore.getRoutine.bind(routineStore);
          vi.spyOn(routineStore, "getRoutine").mockImplementationOnce(
            async (...args) => {
              const routine = await getRoutine(...args);
              preparing.resolve();
              await allowPreparation.promise;
              return routine;
            },
          );
          resuming = workerHub.resume(deliveries.mock.calls[0]![0]);
        }
        await preparing.promise;
        const prior = expectSoleTrigger(await advances.mock.results[0]!.value);
        workerHub.enqueueModuleEffect(...deliveries.mock.calls[0]!);
        await advancing.promise;
        allowPreparation.resolve();
        await resuming;
        // The duplicate is still advancing, but the unexpired work remains owned.
        await waitFor(() => calls === (entry === "initial" ? 1 : 2));
        allowAdvance.resolve();
        const duplicate = expectSoleTrigger(
          await advances.mock.results[1]!.value,
        );
        expect(duplicate.frontier.frontierId).toBe(prior.frontier.frontierId);
        finish.resolve();
        expect(await collectAsync(events)).toEqual([
          expect.objectContaining({ kind: "activated" }),
        ]);
        expect(calls).toBe(entry === "initial" ? 1 : 2);
        expect(
          advances.mock.calls.some(([, input]) => input.skip !== undefined),
        ).toBe(false);
        expect(probeRetention(workerHub).transient).toMatchObject({
          submissions: 0,
          continuations: 0,
          triggerProbes: 0,
        });
        expect(probeRetention(host).transient.pendingProbes).toBe(0);
      } finally {
        allowPreparation.resolve();
        allowAdvance.resolve();
        finish.resolve();
        await workerHub.stop();
        await host.stop();
        vi.restoreAllMocks();
      }
    },
  );

  it("keeps another trigger run and its ask live when an earlier run times out", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    await host.registerArc(
      "independent-deadlines",
      parse('"arc"; function Main() { this.trigger = () => judge("start?"); }'),
    );
    const asks: OutboundMessage[] = [];
    const asked = [deferred(), deferred()];
    const resumed: string[] = [];
    let calls = 0;
    const { workerHub } = makeWorkerHub({
      arcHost: host,
      workers: {
        [DEFAULT_WORKER_ROLE]: async (task, _context, effects) => {
          calls++;
          await effects.emit({
            situation: { audience: "originator", cause: "question" },
            content: "Start?",
          });
          resumed.push(task.arcRunId);
          if (task.kind !== "semantic")
            throw new Error("Expected trigger work.");
          return {
            outcome: "completed",
            semantic: {
              judgments: Object.fromEntries(
                task.requests.map((request) => [request.briefId, true]),
              ),
            },
          };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: DEFAULT_WORKER_ROLE, audience: "*", cause: "*" },
      (message) => {
        asks.push(message);
        asked[asks.length - 1]!.resolve();
      },
    );
    try {
      const inbound = {
        content: "start",
        metadata: { principal: ALICE_OWNER },
      };
      const first = workerHub.submitInbound(inbound);
      await asked[0]!.promise;
      await vi.advanceTimersByTimeAsync(43_200_000);
      const second = workerHub.submitInbound(inbound);
      await asked[1]!.promise;
      expect(asks[0]!.arcRunId).not.toBe(asks[1]!.arcRunId);
      await vi.advanceTimersByTimeAsync(43_200_000);
      expect(await collectAsync(first)).toEqual([]);
      expect(probeRetention(workerHub).transient).toMatchObject({
        scopes: 1,
        routines: 1,
        asks: 1,
        triggerProbes: 1,
        submissions: 1,
      });
      expect(await host.getRunView(asks[1]!.arcRunId)).toMatchObject({
        stage: "triggering",
      });
      expect(
        await collectAsync(
          workerHub.submitInbound({
            arcRunId: asks[1]!.arcRunId,
            content: "yes",
            metadata: { askId: asks[1]!.metadata!.askId },
          }),
        ),
      ).toEqual([{ kind: "continued", arcRunId: asks[1]!.arcRunId }]);
      expect(await collectAsync(second)).toEqual([
        expect.objectContaining({ kind: "activated" }),
      ]);
      expect(resumed).toEqual([asks[1]!.arcRunId]);
      expect(calls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await workerHub.stop();
      await host.stop();
      vi.useRealTimers();
    }
  });

  it.each(["capacity-limited", "transport-lost"] as const)(
    "keeps the original trigger deadline across a %s retry",
    async (park) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      await host.registerArc(
        "deadline-retry",
        parse(
          '"arc"; function Main() { this.trigger = () => judge("start?"); }',
        ),
      );
      const release = deferred();
      const firstInvocation = deferred<number>();
      let calls = 0;
      let runId = "";
      const { workerHub } = makeWorkerHub({
        arcHost: host,
        capacityRetry: { enabled: false },
        workers: {
          [DEFAULT_WORKER_ROLE]: async (task) => {
            runId = task.arcRunId;
            calls++;
            if (calls === 1) {
              firstInvocation.resolve(Date.now());
              if (park === "capacity-limited")
                return {
                  suspension: park,
                  reason: {
                    reason: "token usage limit",
                    provider: "test",
                    message: "held",
                  },
                };
              return {
                suspension: park,
                reason: { reason: "connection reset", message: "held" },
              };
            }
            await release.promise;
            return { outcome: "completed" };
          },
        },
      });
      const advance = vi.spyOn(host, "advanceTrigger");
      try {
        const events = workerHub.submitInbound({
          content: "start",
          metadata: { principal: ALICE_OWNER },
        });
        const startedAt = await firstInvocation.promise;
        await waitFor(
          () => probeRetention(workerHub).transient.continuations === 1,
        );
        await vi.advanceTimersByTimeAsync(
          43_200_000 - (Date.now() - startedAt),
        );
        await expect(workerHub.resume(runId)).resolves.toMatchObject({
          outcome: "resumed",
        });
        await waitFor(() => calls === 2);
        await vi.advanceTimersByTimeAsync(
          86_399_999 - (Date.now() - startedAt),
        );
        expect(advance).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(advance).toHaveBeenCalledExactlyOnceWith(
          runId,
          expect.objectContaining({ skip: { frontierId: expect.any(String) } }),
        );
        release.resolve();
        expect(await collectAsync(events)).toEqual([]);
        expect(probeRetention(workerHub).transient).toMatchObject({
          submissions: 0,
          continuations: 0,
          retries: 0,
          triggerProbes: 0,
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release.resolve();
        await workerHub.stop();
        await host.stop();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["capacity-limited", "before resume"],
    ["transport-lost", "before resume"],
    ["capacity-limited", "during resume preparation"],
    ["transport-lost", "during resume preparation"],
  ] as const)(
    "skips a %s trigger when its deadline passes %s with timer delivery delayed",
    async (park, timing) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      await host.registerArc(
        "expired-park-resume",
        parse(
          '"arc"; function Main() { this.trigger = () => judge("start?"); }',
        ),
      );
      const entered = deferred();
      const unblock = deferred();
      const decided = deferred();
      const finish = deferred();
      let calls = 0;
      let runId = "";
      const { workerHub } = makeWorkerHub({
        arcHost: host,
        capacityRetry: { enabled: false },
        workers: {
          [DEFAULT_WORKER_ROLE]: async (task) => {
            runId = task.arcRunId;
            if (++calls === 1)
              return park === "capacity-limited"
                ? {
                    suspension: park,
                    reason: {
                      reason: "token usage limit",
                      provider: "test",
                      message: "held",
                    },
                  }
                : {
                    suspension: park,
                    reason: { reason: "connection reset", message: "held" },
                  };
            decided.resolve();
            await finish.promise;
            return { outcome: "completed" };
          },
        },
      });
      const advanceTrigger = host.advanceTrigger.bind(host);
      const advance = vi
        .spyOn(host, "advanceTrigger")
        .mockImplementation((...args) => {
          if (args[1].skip) decided.resolve();
          return advanceTrigger(...args);
        });
      try {
        const events = workerHub.submitInbound({
          content: "start",
          metadata: { principal: ALICE_OWNER },
        });
        await waitFor(
          () => probeRetention(workerHub).transient.continuations === 1,
        );
        if (timing === "during resume preparation") {
          const nodeInfo = host.nodeInfoForRef.bind(host);
          vi.spyOn(host, "nodeInfoForRef").mockImplementationOnce(
            async (...args) => {
              const node = await nodeInfo(...args);
              entered.resolve();
              await unblock.promise;
              return node;
            },
          );
        } else {
          vi.setSystemTime(Date.now() + 86_400_001);
        }
        const resuming = workerHub.resume(runId);
        if (timing === "during resume preparation") {
          await entered.promise;
          vi.setSystemTime(Date.now() + 86_400_001);
          unblock.resolve();
        }
        await resuming;
        // Moving the wall clock does not deliver the deadline timer. Resume
        // must decide to skip before making a second worker invocation.
        await decided.promise;
        expect(calls).toBe(1);
        expect(advance).toHaveBeenCalledExactlyOnceWith(
          runId,
          expect.objectContaining({ skip: { frontierId: expect.any(String) } }),
        );
        expect(await collectAsync(events)).toEqual([]);
        expect(probeRetention(workerHub).transient).toMatchObject({
          submissions: 0,
          continuations: 0,
          retries: 0,
          triggerProbes: 0,
          laps: 0,
          lapFailures: 0,
        });
        expect(probeRetention(host).transient.pendingProbes).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        unblock.resolve();
        finish.resolve();
        await workerHub.stop();
        await host.stop();
        vi.restoreAllMocks();
        vi.useRealTimers();
      }
    },
  );

  it("skips expired trigger feedback when timer delivery is delayed", async () => {
    const f = await fixture();
    const advance = vi.spyOn(f.host, "advanceTrigger");
    try {
      const events = f.workerHub.submitInbound(f.inbound);
      await f.entered.promise;
      vi.setSystemTime(Date.now() + 86_400_000);
      f.release.resolve();
      expect(await collectAsync(events)).toEqual([
        expect.objectContaining({ kind: "activated" }),
      ]);
      expect(advance).toHaveBeenCalledTimes(1);
      expect(advance.mock.calls[0]![1]).toMatchObject({
        skip: { frontierId: expect.any(String) },
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.stop();
    }
  });

  it.each([
    ["skip", "success"],
    ["skip", "failure"],
    ["abandon", "success"],
    ["abandon", "failure"],
  ] as const)(
    "fences claimed trigger answers during %s and history %s",
    async (ending, persistence) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      await host.registerArc(
        "trigger-answer-retirement",
        parse(
          '"arc"; function Main() { this.trigger = () => judge("Should this start?"); }',
        ),
      );
      const asked = deferred<OutboundMessage>();
      let resumed = false;
      const { workerHub, historyStore } = makeWorkerHub({
        arcHost: host,
        workers: {
          [DEFAULT_WORKER_ROLE]: async (_task, _context, effects) => {
            await effects.emit({
              situation: { audience: "originator", cause: "question" },
              content: "Start?",
            });
            resumed = true;
            return { outcome: "completed" };
          },
        },
      });
      workerHub.registerOutboundHandler(
        { role: DEFAULT_WORKER_ROLE, audience: "*", cause: "*" },
        (message) => asked.resolve(message),
      );
      const controller = new AbortController();
      const release = deferred();
      try {
        const initial = collectAsync(
          workerHub.submitInbound(
            { content: "start", metadata: { principal: ALICE_OWNER } },
            { signal: controller.signal },
          ),
        );
        const ask = await asked.promise;
        const entered = deferred();
        const append = historyStore.appendEntry.bind(historyStore);
        vi.spyOn(historyStore, "appendEntry").mockImplementationOnce(
          async (...args) => {
            entered.resolve();
            await release.promise;
            if (persistence === "failure")
              throw new Error("Trigger answer history failed.");
            await append(...args);
          },
        );
        let delivered = false;
        const answer = collectAsync(
          workerHub.submitInbound({
            arcRunId: ask.arcRunId,
            content: "yes",
            metadata: { askId: ask.metadata!.askId },
          }),
        )
          .catch((error: unknown) => error)
          .then((result) => {
            delivered = true;
            return result;
          });
        await entered.promise;
        if (ending === "skip") await vi.advanceTimersByTimeAsync(86_400_000);
        else controller.abort();
        expect(delivered).toBe(false);
        expect(probeRetention(workerHub).transient.answerDeliveries).toBe(1);
        release.resolve();
        expect(await answer).toBeInstanceOf(Error);
        expect(await initial).toEqual([]);
        expect(resumed).toBe(false);
        await waitFor(
          () => probeRetention(workerHub).transient.runDrains === 0,
        );
        expect(probeRetention(workerHub).transient).toMatchObject({
          submissions: 0,
          scopes: 0,
          routines: 0,
          asks: 0,
          answerDeliveries: 0,
          triggerProbes: 0,
          laps: 0,
          lapFailures: 0,
        });
        expect(probeRetention(host).transient.triggering).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        release.resolve();
        await workerHub.stop();
        await host.stop();
        vi.useRealTimers();
      }
    },
  );

  it("skips a trigger exactly after 24 hours and retains cleanup until its worker returns", async () => {
    const f = await fixture();
    const advance = vi.spyOn(f.host, "advanceTrigger");
    try {
      const events = f.workerHub.submitInbound(f.inbound);
      await f.entered.promise;
      await vi.advanceTimersByTimeAsync(86_399_999);
      expect(advance).not.toHaveBeenCalled();
      expect(probeRetention(f.workerHub).transient.triggerProbes).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(advance).toHaveBeenCalledTimes(1);
      expect(advance.mock.calls[0]![1]).toMatchObject({
        skip: { frontierId: expect.any(String) },
      });
      expect(probeRetention(f.workerHub).transient.submissions).toBe(1);
      f.release.resolve();
      expect(await collectAsync(events)).toEqual([
        expect.objectContaining({ kind: "activated" }),
      ]);
      expect(probeRetention(f.workerHub).transient.submissions).toBe(0);
    } finally {
      await f.stop();
    }
  });

  it("lets claimed trigger advancement cross its deadline and gives the successor a fresh 24 hours", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    await host.registerArc(
      "successor",
      parse(
        '"arc"; function Main() { this.trigger = () => judge("first?") && judge("second?"); }',
      ),
    );
    const returning = deferred();
    const returnNext = deferred();
    const secondWorker = deferred();
    const finishWorker = deferred();
    const advance = host.advanceTrigger.bind(host);
    const calls = vi
      .spyOn(host, "advanceTrigger")
      .mockImplementation(async (...args) => {
        const result = await advance(...args);
        if (args[1].skip === undefined) {
          returning.resolve();
          await returnNext.promise;
        }
        return result;
      });
    let round = 0;
    const { workerHub } = makeWorkerHub({
      arcHost: host,
      workers: {
        [DEFAULT_WORKER_ROLE]: async (task) => {
          if (++round === 2) {
            secondWorker.resolve();
            await finishWorker.promise;
          }
          if (task.kind !== "semantic")
            throw new Error("Expected semantic task.");
          return {
            outcome: "completed",
            semantic: {
              judgments: Object.fromEntries(
                task.requests.map((request) => [request.briefId, true]),
              ),
            },
          };
        },
      },
    });
    try {
      const events = workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      });
      await returning.promise;
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(calls).toHaveBeenCalledTimes(1);
      returnNext.resolve();
      await secondWorker.promise;
      await vi.advanceTimersByTimeAsync(86_399_999);
      expect(calls).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(calls.mock.calls[1]![1]).toMatchObject({
        skip: { frontierId: expect.any(String) },
      });
      finishWorker.resolve();
      expect(await collectAsync(events)).toEqual([]);
      expect(probeRetention(workerHub).transient).toMatchObject({
        submissions: 0,
        triggerProbes: 0,
        laps: 0,
        lapFailures: 0,
      });
    } finally {
      returnNext.resolve();
      finishWorker.resolve();
      await workerHub.stop();
      await host.stop();
      vi.useRealTimers();
    }
  });

  it("adopts a successor returned by timeout skip without carrying the predecessor deadline", async () => {
    const f = await fixture();
    const begin = f.host.begin.bind(f.host);
    let trigger: Extract<ArcHostStep, { kind: "trigger" }> | undefined;
    vi.spyOn(f.host, "begin").mockImplementation(async (input) => {
      const steps = await begin(input);
      trigger = steps.find((step) => step.kind === "trigger");
      return steps;
    });
    const advance = f.host.advanceTrigger.bind(f.host);
    let firstSkip = true;
    const preparingSuccessor = deferred();
    const finishPreparation = deferred();
    const workspace = f.host.getRunWorkspaceContext.bind(f.host);
    vi.spyOn(f.host, "getRunWorkspaceContext").mockImplementation(
      async (runId) => {
        const context = await workspace(runId);
        if (runId === trigger?.arcRunId && !firstSkip) {
          preparingSuccessor.resolve();
          await finishPreparation.promise;
        }
        return context;
      },
    );
    const calls = vi
      .spyOn(f.host, "advanceTrigger")
      .mockImplementation(async (runId, input) => {
        if (input.skip !== undefined && firstSkip) {
          firstSkip = false;
          if (!trigger) throw new Error("Expected trigger.");
          // Exercise the hub's returned-step protocol independently of host selection.
          return [
            {
              ...trigger,
              frontier: {
                ...trigger.frontier,
                frontierId: "successor-frontier",
              },
            },
          ];
        }
        return advance(
          runId,
          input.skip !== undefined
            ? { ...input, skip: { frontierId: trigger!.frontier.frontierId } }
            : input,
        );
      });
    try {
      const events = f.workerHub.submitInbound(f.inbound);
      await f.entered.promise;
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(probeRetention(f.workerHub).transient.triggerProbes).toBe(1);
      await preparingSuccessor.promise;
      await vi.advanceTimersByTimeAsync(86_399_999);
      expect(calls).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(calls.mock.calls[1]![1]).toMatchObject({
        skip: { frontierId: "successor-frontier" },
      });
      await waitFor(() => probeRetention(f.host).transient.triggering === 0);
      finishPreparation.resolve();
      f.release.resolve();
      expect(await collectAsync(events)).toEqual([
        expect.objectContaining({ kind: "activated" }),
      ]);
    } finally {
      finishPreparation.resolve();
      await f.stop();
    }
  });

  it.each(["finalization", "history"] as const)(
    "fails timed-out trigger %s without completing before owned cleanup",
    async (failureAt) => {
      const f = await fixture();
      let expired = false;
      const list = f.store.listStates.bind(f.store);
      if (failureAt === "finalization")
        vi.spyOn(f.store, "listStates").mockImplementation(async function* () {
          if (expired) throw new Error("Finalization storage failed.");
          yield* list();
        });
      else
        vi.spyOn(f.historyStore, "appendEntry").mockRejectedValue(
          new Error("Admission history failed."),
        );
      try {
        const submission = f.workerHub.submitInbound(f.inbound);
        await f.entered.promise;
        let done = false;
        const result = collectAsync(submission).then(
          (events) => {
            done = true;
            return events;
          },
          (error: unknown) => {
            done = true;
            return error;
          },
        );
        expired = true;
        f.expire();
        await waitFor(
          () => probeRetention(f.workerHub).transient.finalizations === 0,
        );
        expect(done).toBe(false);
        f.release.resolve();
        expect(await result).toEqual(
          new Error(
            failureAt === "finalization"
              ? "Finalization storage failed."
              : "Admission history failed.",
          ),
        );
        expect(probeRetention(f.workerHub).transient).toMatchObject({
          submissions: 0,
          finalizations: 0,
          laps: 0,
          lapFailures: 0,
          triggerProbes: 0,
        });
        await waitFor(
          () => probeRetention(f.host).transient.batchOperations === 0,
        );
      } finally {
        await f.stop();
      }
    },
  );

  it.each(["finalization", "history"] as const)(
    "retains timed-out trigger ownership through held %s and dispatches its collected match",
    async (hold) => {
      const f = await fixture();
      const held = deferred();
      const resume = deferred();
      let expired = false;
      const list = f.store.listStates.bind(f.store);
      const append = f.historyStore.appendEntry.bind(f.historyStore);
      if (hold === "finalization")
        vi.spyOn(f.store, "listStates").mockImplementation(async function* () {
          if (expired) {
            held.resolve();
            await resume.promise;
          }
          yield* list();
        });
      else
        vi.spyOn(f.historyStore, "appendEntry").mockImplementation(
          async (...args) => {
            held.resolve();
            await resume.promise;
            await append(...args);
          },
        );
      try {
        const submission = f.workerHub.submitInbound(f.inbound);
        await f.entered.promise;
        let done = false;
        const iterator = submission[Symbol.asyncIterator]();
        const first = iterator.next();
        const terminal = first
          .then(() => iterator.next())
          .then((next) => {
            done = true;
            return next;
          });
        expired = true;
        f.expire();
        await held.promise;
        expect(done).toBe(false);
        expect(probeRetention(f.workerHub).transient).toMatchObject({
          submissions: 1,
          triggerProbes: 0,
          finalizations: 1,
          laps: 0,
          lapFailures: 0,
        });
        if (hold === "finalization")
          expect(probeRetention(f.host).transient.finalizingBatches).toBe(1);
        resume.resolve();
        const event = (await first).value;
        expect(event).toMatchObject({ kind: "activated" });
        await f.action.promise;
        expect(
          (await f.historyStore.listEntries(event.arcRunId)).map(
            (entry) => entry.content,
          ),
        ).toContain(f.inbound.content);
        // The sibling outcome arrives before the cancelled provider acknowledges.
        expect(done).toBe(false);
        f.release.resolve();
        expect((await terminal).done).toBe(true);
        await waitFor(() => probeRetention(f.workerHub).transient.scopes === 0);
        expect(probeRetention(f.workerHub).transient).toMatchObject({
          submissions: 0,
          triggerProbes: 0,
          finalizations: 0,
          laps: 0,
          lapFailures: 0,
        });
        await waitFor(
          () => probeRetention(f.host).transient.batchOperations === 0,
        );
      } finally {
        resume.resolve();
        await f.stop();
      }
    },
  );

  it("transfers a timed-out trigger hold to its resulting handshake before finalization ends", async () => {
    const f = await fixture(true);
    try {
      const submissionAbort = new AbortController();
      const submission = f.workerHub.submitInbound(f.inbound, {
        signal: submissionAbort.signal,
      });
      await f.entered.promise;
      f.expire();
      const iterator = submission[Symbol.asyncIterator]();
      const gate = (await iterator.next()).value;
      expect(gate).toMatchObject({ kind: "handshake-required" });
      f.release.resolve();
      await waitFor(
        () => probeRetention(f.workerHub).transient.finalizations === 0,
      );
      expect(probeRetention(f.workerHub).transient).toMatchObject({
        submissions: 1,
        handshakeCorrelations: 1,
        triggerProbes: 0,
      });
      submissionAbort.abort();
      expect(
        await collectAsync({ [Symbol.asyncIterator]: () => iterator }),
      ).toEqual([
        {
          kind: "handshake-settled",
          handshakeId: gate.handshakeId,
          outcome: "cancelled",
        },
      ]);
      expect(probeRetention(f.host).transient.pendingHandshakes).toBe(0);
    } finally {
      await f.stop();
    }
  });

  it("cancels unclaimed activation while a timed-out trigger advancement is awaiting candidates", async () => {
    const f = await fixture();
    const held = deferred();
    const resume = deferred();
    let expired = false;
    const list = f.store.listStates.bind(f.store);
    vi.spyOn(f.store, "listStates").mockImplementation(async function* () {
      if (expired) {
        held.resolve();
        await resume.promise;
      }
      yield* list();
    });
    try {
      const submissionAbort = new AbortController();
      const submission = f.workerHub.submitInbound(f.inbound, {
        signal: submissionAbort.signal,
      });
      await f.entered.promise;
      expired = true;
      f.expire();
      await held.promise;
      let done = false;
      submissionAbort.abort();
      const cancelled = collectAsync(submission).then((result) => {
        done = true;
        return result;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(done).toBe(false);
      resume.resolve();
      f.release.resolve();
      expect(await cancelled).toEqual([]);
      expect(
        (await f.host.listRunViews()).filter(
          (view) => view.stage === "actioning",
        ),
      ).toHaveLength(1);
      expect(probeRetention(f.workerHub).transient).toMatchObject({
        submissions: 0,
        laps: 0,
        lapFailures: 0,
      });
    } finally {
      resume.resolve();
      await f.stop();
    }
  });

  it.each(["expiry", "completion"] as const)(
    "finalizes a collected batch once when %s wins the last-probe race",
    async (winner) => {
      const f = await fixture();
      try {
        const submission = f.workerHub.submitInbound(f.inbound);
        await f.entered.promise;
        if (winner === "expiry") f.expire();
        f.release.resolve();
        const iterator = submission[Symbol.asyncIterator]();
        const event = (await iterator.next()).value;
        if (winner === "expiry") f.expire();
        if (event.kind === "handshake-required")
          await f.workerHub.handshake(event.handshakeId, { decline: true });
        const remaining = await collectAsync({
          [Symbol.asyncIterator]: () => iterator,
        });
        expect(
          [event, ...remaining].filter(
            (item) =>
              item.kind === "activated" || item.kind === "handshake-required",
          ),
        ).toHaveLength(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(probeRetention(f.host).transient).toMatchObject({
          collectingBatches: 0,
          finalizingBatches: 0,
        });
      } finally {
        await f.stop();
      }
    },
  );
});
