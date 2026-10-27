import { hmd } from "@elem-app/arc/host-utils";
import { parse } from "@elem-app/arc/parser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ArcHostStep,
  RoutineInput,
  RoutineReport,
  Worker,
} from "../src/index.js";
import { RecordingRuntime } from "../src/service/replay-recorder.js";
import {
  InMemoryArcHostStore,
  InMemoryReplayStore,
  InMemoryWorkerHubStore,
  arcRunKey,
  taskId,
} from "../src/testing.js";
import {
  beginActivatedDriver,
  beginDriver,
  drainModuleEffects,
  projectorFor,
} from "./arc-host-helpers.js";
import { makeControlledTime } from "./controlled-time.js";
import {
  collectAsync,
  createCapturingLogger,
  hostModule,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import {
  createTestArcHost,
  moduleHubFor,
  takeModuleEffects,
  workEventsFor,
} from "./work-event-fixtures.js";

const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
const source = (caught = true, poison = false) => `"arc";
import Time from "host:time";
function Main() {
  this.trigger = () => true;
  let n = Num(); n.$set(1);
  this.catchInterruption = () => ${poison ? "{ n.$set(0 / 0); return true; }" : caught ? "judge(`catch interruption`)" : "false"};
  Time.$addTimeout(100, "deadline");
  $instruct(\`original work\`);
}`;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function fixture(worker?: Worker, poison = false) {
  const clock = makeControlledTime();
  const store = new InMemoryArcHostStore();
  const replayStore = new InMemoryReplayStore();
  const host = await createTestArcHost({ store, replayStore, ...clock });
  const logging = createCapturingLogger();
  await host.registerArc("ownership", parse(source(true, poison)));
  const hub = worker
    ? makeWorkerHub({
        arcHost: host,
        logger: logging.logger,

        backends: {
          controlled: {
            supportedSlotKinds: new Set(["default"]),
            createWorker: () => worker,
          },
        },
        workerSlots: { default: "controlled" },
      })
    : undefined;
  return {
    host,
    store,
    replayStore,
    clock,
    events: workEventsFor(host),
    logs: logging.records,
    ...hub,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Host interruption ownership", () => {
  it.each([
    ["completed", { outcome: "completed" }],
    ["paused", { suspension: "paused" }],
    [
      "capacity-limited",
      {
        suspension: "capacity-limited",
        reason: {
          reason: "api rate limit",
          provider: "test",
          message: "retry",
        },
      },
    ],
    [
      "transport-lost",
      {
        suspension: "transport-lost",
        reason: { reason: "network timeout", message: "retry" },
      },
    ],
    ["cancelled", { cancellation: "superseded" }],
    ["failed", { error: "failed", code: "late", message: "late failure" }],
  ] satisfies Array<[string, RoutineReport]>)(
    "interruption.ownership discards a late %s report while preserving a concurrent manual pause",
    async (_kind, report) => {
      const release = deferred();
      const catchRelease = deferred();
      const inputs: RoutineInput[] = [];
      let notified = false;
      let disposals = 0;
      const env = await fixture({
        async run(input) {
          inputs.push(input);
          if (inputs.length === 1) {
            await release.promise;
            return { ...report, backendDetails: { late: true } };
          }
          await catchRelease.promise;
          return { outcome: "completed" };
        },
        async disposeRoutine() {
          disposals++;
        },
      });
      // Exercise hub batch cancellation while Arc instruction batching is dormant.
      const advance = env.host.advanceAction.bind(env.host);
      vi.spyOn(env.host, "advanceAction").mockImplementation(
        async (...args) => {
          const step = await advance(...args);
          if (step.kind !== "action") return step;
          const first = step.frontier.tasks[0];
          if (first?.kind !== "instruction") return step;
          return {
            ...step,
            frontier: {
              ...step.frontier,
              tasks: [
                first,
                { ...first, briefIds: ["queued-old-instruction"] as const },
              ],
            },
          };
        },
      );
      env.events.registerWorkEventHandler((event) => {
        if (event.kind !== "run:interruption-occurred") return;
        notified = true;
      });
      try {
        await collectAsync(
          env.workerHub!.submitInbound({
            content: "start",
            metadata: { principal: "owner" },
          }),
        );
        await waitFor(() => inputs.length === 1);
        const old = inputs[0]!;
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        await waitFor(() => notified);
        await env.workerHub!.requestPause(old.routine.arcRunId);
        expect(await old.effects.checkSignal()).toEqual({ kind: "cancel" });
        release.resolve();
        await waitFor(
          async () =>
            (await env.routineStore!.getRoutine(old.routine.id))?.status ===
            "skipped",
        );
        await waitFor(
          async () =>
            (await env.workerHub!.getExecutionControlView(old.routine.arcRunId))
              .status === "paused",
        );
        expect(inputs).toHaveLength(1);
        expect(disposals).toBe(1);
        const saved = await env.routineStore!.getRoutine(old.routine.id);
        expect(saved?.error?.code).toBe("run-interrupted");
        expect(saved?.backendDetails).toBeUndefined();
        const discriminator =
          "outcome" in report
            ? "outcome"
            : "suspension" in report
              ? "suspension"
              : "cancellation" in report
                ? "cancellation"
                : "error";
        expect(env.logs).toContainEqual(
          expect.objectContaining({
            event: "worker_hub.routine.superseded",
            reportDiscriminator: discriminator,
            reportValue: _kind === "cancelled" ? "superseded" : _kind,
          }),
        );
        expect(
          (await env.events.list(old.routine.arcRunId)).some(
            (event) =>
              event.kind === "routine:capacity-limited" ||
              event.kind === "routine:transport-lost",
          ),
        ).toBe(false);
        await env.workerHub!.resume(old.routine.arcRunId);
        await waitFor(() => inputs.length === 2);
        expect(inputs[1]!.routine.id).not.toBe(old.routine.id);
        expect(inputs[1]!.routine.task.kind).toBe("semantic");
        expect(await inputs[1]!.effects.checkSignal()).toBeUndefined();
        expect(await old.effects.checkSignal()).toEqual({ kind: "cancel" });
        expect(
          (await env.store.getState(arcRunKey(old.routine.arcRunId)))
            ?.lifecycle,
        ).toBe("active");
      } finally {
        release.resolve();
        catchRelease.resolve();
        env.host.stop();
        await env.workerHub!.stop();
      }
    },
  );

  it.each(["question", "permission", "message"] as const)(
    "interruption.ownership rejects %s publication prepared across supersession",
    async (cause) => {
      const preparing = deferred();
      const releasePreparation = deferred();
      const releaseCatch = deferred();
      const inputs: RoutineInput[] = [];
      const received: string[] = [];
      let rejected = false;
      let notified = false;
      const env = await fixture({
        async run(input) {
          inputs.push(input);
          if (inputs.length > 1) {
            await releaseCatch.promise;
            return { outcome: "completed" };
          }
          const effect =
            cause === "permission"
              ? input.effects.requestPermission({
                  toolCallId: "old-tool",
                  toolName: "write",
                  input: {},
                })
              : input.effects.emit({
                  situation: { cause },
                  content: "old effect",
                });
          await effect.catch(() => {
            rejected = true;
          });
          await releasePreparation.promise;
          return { outcome: "completed" };
        },
        async disposeRoutine() {},
      });
      const append = env.historyStore!.appendEntry.bind(env.historyStore);
      env.historyStore!.appendEntry = async (runId, entry) => {
        if (entry.from.kind === "role") {
          preparing.resolve();
          await releasePreparation.promise;
        }
        return append(runId, entry);
      };
      env.workerHub!.registerOutboundHandler(
        { role: "*", audience: "*", cause: "*" },
        (message) => {
          received.push(String(message.content));
        },
      );
      env.events.registerWorkEventHandler((event) => {
        if (event.kind !== "run:interruption-occurred") return;
        notified = true;
      });
      try {
        await collectAsync(
          env.workerHub!.submitInbound({
            content: "start",
            metadata: { principal: "owner" },
          }),
        );
        await preparing.promise;
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        await waitFor(() => notified);
        releasePreparation.resolve();
        await waitFor(() => rejected && inputs.length === 2);
        expect(received).toEqual([]);
        const events = await env.events.list(inputs[0]!.routine.arcRunId);
        expect(
          events.some(
            (event) =>
              event.kind === "blocked:question" ||
              event.kind === "blocked:permission",
          ),
        ).toBe(false);
      } finally {
        releasePreparation.resolve();
        releaseCatch.resolve();
        env.host.stop();
        await env.workerHub!.stop();
      }
    },
  );

  it("interruption.ownership keeps independent execution and context reuse live during disposal", async () => {
    const releaseWorker = deferred();
    const releaseDisposal = deferred();
    const releaseCatch = deferred();
    const releaseOther = deferred();
    const inputs: RoutineInput[] = [];
    let disposing = false;
    let otherRunId: string | undefined;
    let notified = false;
    const env = await fixture({
      async run(input) {
        inputs.push(input);
        if (inputs.length === 1) await releaseWorker.promise;
        else if (input.routine.arcRunId === inputs[0]!.routine.arcRunId)
          await releaseCatch.promise;
        else await releaseOther.promise;
        return { outcome: "completed" };
      },
      async disposeRoutine(input) {
        if (input.routineId !== inputs[0]!.routine.id) return;
        disposing = true;
        await releaseDisposal.promise;
      },
    });
    env.events.registerWorkEventHandler((event) => {
      if (event.kind !== "run:interruption-occurred") return;
      notified = true;
    });
    try {
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "start",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => inputs.length === 1);
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      await waitFor(() => notified);
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "other",
          metadata: { principal: "other" },
        }),
      );
      otherRunId = (await collectAsync(env.store.listStates())).find(
        ([, state]) => state.ownerPrincipal === "other",
      )![1].arcRunId;
      expect(otherRunId).not.toBe(inputs[0]!.routine.arcRunId);
      await waitFor(
        async () =>
          (await collectAsync(env.routineStore!.listRoutines(otherRunId)))
            .length === 1,
      );
      await waitFor(() => inputs.length === 2);
      expect(inputs[1]!.routine.arcRunId).toBe(otherRunId);
      expect(disposing).toBe(false);
      releaseWorker.resolve();
      await waitFor(() => disposing && inputs.length === 3);
      expect(inputs[2]!.routine.contextKey).toBe(inputs[0]!.routine.contextKey);
      releaseOther.resolve();
      await waitFor(async () =>
        (await collectAsync(env.routineStore!.listRoutines(otherRunId!))).every(
          (routine) => routine.status === "finished",
        ),
      );
      releaseDisposal.resolve();
    } finally {
      releaseWorker.resolve();
      releaseDisposal.resolve();
      releaseCatch.resolve();
      releaseOther.resolve();
      env.host.stop();
      await env.workerHub!.stop();
    }
  });

  it("interruption.context waits for old writes while independent work bypasses the context waiter", async () => {
    const releaseWrite = deferred();
    const releaseDisposal = deferred();
    const releaseCatch = deferred();
    const inputs: RoutineInput[] = [];
    const warmed: string[] = [];
    let oldRunId: string | undefined;
    let disposing = false;
    const env = await fixture(
      {
        async warm(input) {
          warmed.push(input.contextKey);
        },
        async run(input) {
          inputs.push(input);
          if (inputs.length === 1) {
            oldRunId = input.routine.arcRunId;
            await releaseWrite.promise;
          } else if (input.routine.arcRunId === oldRunId) {
            await releaseCatch.promise;
          }
          return { outcome: "completed" };
        },
        async disposeRoutine(input) {
          if (input.routineId !== inputs[0]?.routine.id) return;
          disposing = true;
          await releaseDisposal.promise;
        },
      },
      false,
    );
    try {
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "start",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => inputs.length === 1);
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      await waitFor(
        async () =>
          (await collectAsync(env.routineStore!.listRoutines(oldRunId!)))
            .length === 2,
      );
      expect(inputs).toHaveLength(1);
      expect(warmed).toHaveLength(1);
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "other",
          metadata: { principal: "other" },
        }),
      );
      await waitFor(() => inputs.length === 2);
      expect(inputs[1]!.routine.arcRunId).not.toBe(oldRunId);
      expect(disposing).toBe(false);
      releaseWrite.resolve();
      await waitFor(() => disposing && inputs.length === 3);
      expect(inputs[2]!.routine.contextKey).toBe(inputs[0]!.routine.contextKey);
      expect(warmed).toHaveLength(3);
    } finally {
      releaseWrite.resolve();
      releaseDisposal.resolve();
      releaseCatch.resolve();
      env.host.stop();
      await env.workerHub!.stop();
    }
  });

  it("interruption.context never warms or invokes a superseded context waiter", async () => {
    const releaseWrite = deferred();
    const releaseCatch = deferred();
    const inputs: RoutineInput[] = [];
    let warmed = 0;
    const env = await fixture(
      {
        async warm() {
          warmed++;
        },
        async run(input) {
          inputs.push(input);
          await (inputs.length === 1
            ? releaseWrite.promise
            : releaseCatch.promise);
          return { outcome: "completed" };
        },
        async disposeRoutine() {},
      },
      false,
    );
    await env.host.registerArc(
      "ownership",
      parse(
        source().replace(
          'Time.$addTimeout(100, "deadline");',
          'Time.$addTimeout(100, "first"); Time.$addTimeout(200, "second");',
        ),
      ),
      undefined,
      { replace: true },
    );
    try {
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "start",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => inputs.length === 1);
      const runId = inputs[0]!.routine.arcRunId;
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      await waitFor(
        async () =>
          (await collectAsync(env.routineStore!.listRoutines(runId))).length ===
          2,
      );
      env.clock.advanceTo(1200);
      env.clock.fireDue();
      await waitFor(
        async () =>
          (await collectAsync(env.routineStore!.listRoutines(runId))).length ===
          3,
      );
      expect(warmed).toBe(1);
      releaseWrite.resolve();
      await waitFor(() => inputs.length === 2);
      expect(warmed).toBe(2);
      const routines = await collectAsync(
        env.routineStore!.listRoutines(runId),
      );
      expect(
        routines.filter((routine) => routine.status === "skipped"),
      ).toHaveLength(2);
    } finally {
      releaseWrite.resolve();
      releaseCatch.resolve();
      env.host.stop();
      await env.workerHub!.stop();
    }
  });

  it("interruption.ownership keeps replacement work live after eventual disposal fails", async () => {
    const release = deferred();
    const releaseDisposal = deferred();
    const releaseCatch = deferred();
    const inputs: RoutineInput[] = [];
    let questionReleased = false;
    const env = await fixture({
      async run(input) {
        inputs.push(input);
        if (inputs.length > 1) {
          await releaseCatch.promise;
          // Catch the interruption, so Arc reissues the original work.
          const task = input.routine.task;
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
        }
        await input.effects
          .emit({ situation: { cause: "question" }, content: "old question" })
          .catch(() => {
            questionReleased = true;
          });
        await release.promise;
        return { suspension: "paused" };
      },
      async disposeRoutine(input) {
        if (input.routineId !== inputs[0]?.routine.id) return;
        await releaseDisposal.promise;
        throw new Error("disposal failed");
      },
    });
    const releases = vi.spyOn(env.host, "releaseAction");
    try {
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "start",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => inputs.length === 1);
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      await waitFor(() => questionReleased);
      release.resolve();
      await waitFor(() => inputs.length === 2);
      releaseDisposal.resolve();
      await waitFor(() =>
        env.logs.some(
          (record) => record.event === "worker_hub.routine.disposal_failed",
        ),
      );
      const old = inputs[0]!;
      expect((await env.routineStore!.getRoutine(old.routine.id))?.status).toBe(
        "skipped",
      );
      expect(
        await env.workerHub!.getExecutionControlView(old.routine.arcRunId),
      ).toMatchObject({ status: "running" });
      expect(await inputs[1]!.effects.checkSignal()).not.toEqual({
        kind: "cancel",
      });
      expect(releases).not.toHaveBeenCalled();
      expect(env.host.getLiveSessionCounts().actioning).toBe(1);
      expect(env.workerHub!.getLiveWorkCounts().scopes).toBe(1);
      // The reissued original work selects the worker whose disposal failed.
      releaseCatch.resolve();
      await waitFor(
        async () =>
          (await env.workerHub!.getExecutionControlView(old.routine.arcRunId))
            .status === "internal-error",
      );
      expect(
        await env.workerHub!.getExecutionControlView(old.routine.arcRunId),
      ).toMatchObject({
        status: "internal-error",
        error: { message: expect.stringContaining("cannot be reused") },
      });
    } finally {
      release.resolve();
      releaseDisposal.resolve();
      releaseCatch.resolve();
      env.host.stop();
      await env.workerHub!.stop();
    }
  });

  it("interruption.continuation dispatches catch work before eventual disposal completes", async () => {
    const releaseWorker = deferred();
    const releaseDisposal = deferred();
    const releaseCatch = deferred();
    let runs = 0;
    let disposing = false;
    const env = await fixture({
      async run() {
        runs++;
        if (runs === 1) await releaseWorker.promise;
        else await releaseCatch.promise;
        return { outcome: "completed" };
      },
      async disposeRoutine() {
        disposing = true;
        await releaseDisposal.promise;
      },
    });
    const advances = vi.spyOn(env.host, "advanceAction");
    try {
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "start",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => runs === 1);
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      await waitFor(() =>
        advances.mock.calls.some(
          ([, , input]) =>
            "hostCallId" in input &&
            input.hostCallOutcome.kind === "interruption",
        ),
      );
      const delivery = advances.mock.results.at(-1)!;
      const next = await delivery.value;
      expect(next.frontier.briefs.judgments).toHaveLength(1);
      expect(disposing).toBe(false);
      releaseWorker.resolve();
      await waitFor(() => disposing && runs === 2);
      expect(
        advances.mock.calls.filter(
          ([, , input]) =>
            "hostCallId" in input &&
            input.hostCallOutcome.kind === "interruption",
        ),
      ).toHaveLength(1);
      releaseDisposal.resolve();
    } finally {
      releaseWorker.resolve();
      releaseDisposal.resolve();
      releaseCatch.resolve();
      env.host.stop();
      await env.workerHub!.stop();
    }
  });
  it("interruption.continuation settles retained catch host work after a concurrent pause", async () => {
    const clock = makeControlledTime();
    const executionControl = new InMemoryWorkerHubStore();
    const host = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      executionControl,
      ...clock,
    });
    let called = 0;
    await host.registerHostModule(
      "gate",
      hostModule(
        moduleHubFor(host),
        hmd.define({ check: () => hmd.Bool() }),
        async () => {
          called++;
          return true;
        },
      ),
    );
    await host.registerArc(
      "retained",
      parse(
        '"arc"; import Time from "host:time"; import Gate from "host:gate"; function Main() { this.trigger = () => true; this.catchInterruption = () => Gate.check(); Time.$addTimeout(100); $instruct(`work`); }',
      ),
    );
    const driver = await beginActivatedDriver(host, dialog);
    const progress = RecordingRuntime.prototype.progress;
    vi.spyOn(RecordingRuntime.prototype, "progress").mockImplementation(
      async function (this: RecordingRuntime, ...args) {
        const next = await progress.apply(this, args);
        if (args[1].move === "interrupt")
          await executionControl.putExecutionControl({
            arcRunId: driver.arcRunId,
            status: "paused",
            pausedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        return next;
      },
    );
    try {
      clock.advanceTo(1100);
      clock.fireDue();
      const paused = (await driver.deliverEffects({ dialog })).driver;
      expect(called).toBe(0);
      expect(paused.frontier.frontierId).not.toBe(driver.frontier.frontierId);
      await executionControl.putExecutionControl({
        arcRunId: driver.arcRunId,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
      const resumed = await beginDriver(host, driver.arcRunId, dialog);
      expect(called).toBe(1);
      expect(resumed.frontier.tasks[0]?.kind).toBe("instruction");
      await beginDriver(host, driver.arcRunId, dialog);
      expect(called).toBe(1);
    } finally {
      await host.stop();
    }
  });
  it.each(["paused", "capacity-limited", "transport-lost"] as const)(
    "interruption.suspension supersedes an in-flight %s control write",
    async (suspension) => {
      const committing = deferred();
      const release = deferred();
      const catchRelease = deferred();
      let runs = 0;
      let runId = "";
      let oldRoutineId = "";
      let disposed = 0;
      let notified = false;
      const env = await fixture({
        async run(input): Promise<RoutineReport> {
          runId = input.routine.arcRunId;
          runs++;
          if (runs > 1) {
            await catchRelease.promise;
            return { cancellation: "superseded" };
          }
          oldRoutineId = input.routine.id;
          if (suspension === "paused") return { suspension };
          if (suspension === "capacity-limited")
            return {
              suspension,
              reason: {
                reason: "api rate limit",
                provider: "test",
                message: "retry",
              },
            };
          return {
            suspension,
            reason: { reason: "network timeout", message: "retry" },
          };
        },
        async disposeRoutine() {
          disposed++;
        },
      });
      env.events.registerWorkEventHandler((event) => {
        if (event.kind !== "run:interruption-occurred") return;
        notified = true;
      });
      const put = env.routineStore!.putExecutionControl.bind(env.routineStore);
      env.routineStore!.putExecutionControl = async (control) => {
        if (control.status === suspension) {
          committing.resolve();
          await release.promise;
        }
        await put(control);
      };
      try {
        await collectAsync(
          env.workerHub!.submitInbound({
            content: "start",
            metadata: { principal: "owner" },
          }),
        );
        await committing.promise;
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        await waitFor(() => notified && disposed === 1);
        release.resolve();
        await waitFor(() => runs === 2);
        await waitFor(
          async () =>
            (await env.routineStore!.getRoutine(oldRoutineId))?.status ===
            "skipped",
        );
        expect(
          await env.workerHub!.getExecutionControlView(runId),
        ).toMatchObject({ status: "running" });
        expect(
          (await env.events.list(runId)).filter(
            (event) =>
              event.kind === "routine:capacity-limited" ||
              event.kind === "routine:transport-lost" ||
              event.kind === "control:paused",
          ),
        ).toEqual([]);
      } finally {
        release.resolve();
        catchRelease.resolve();
        env.host.stop();
        await env.workerHub!.stop();
      }
    },
  );
  it.each([false, true])(
    "interruption.ownership notifies before runtime handling with catch poisoning=%s",
    async (poison) => {
      const release = deferred();
      const inputs: RoutineInput[] = [];
      const disposed: string[] = [];
      let questionReleased = false;
      let retained = false;
      const env = await fixture(
        {
          async run(input) {
            inputs.push(input);
            await input.effects
              .emit({
                situation: { cause: "question" },
                content:
                  inputs.length === 1 ? "old question" : "catch question",
              })
              .catch(() => {
                questionReleased = true;
              });
            if (inputs.length === 1) {
              await release.promise;
              retained = true;
              return { suspension: "paused" };
            }
            return { cancellation: "superseded" };
          },
          async disposeRoutine({ routineId }) {
            retained = false;
            disposed.push(routineId);
          },
        },
        poison,
      );
      const order: string[] = [];
      const runtimeProgress = RecordingRuntime.prototype.progress;
      vi.spyOn(RecordingRuntime.prototype, "progress").mockImplementation(
        function (this: RecordingRuntime, ...args) {
          if (args[1].move === "interrupt") order.push("runtime");
          return runtimeProgress.apply(this, args);
        },
      );
      env.events.registerWorkEventHandler((event) => {
        if (event.kind !== "run:interruption-occurred") return;
        order.push("notification");
      });
      const asks: string[] = [];
      env.workerHub!.registerOutboundHandler(
        { role: "*", audience: "*", cause: "*" },
        (message) => {
          asks.push(String(message.metadata?.askId));
        },
      );
      try {
        await collectAsync(
          env.workerHub!.submitInbound({
            content: "start",
            metadata: { principal: "owner" },
          }),
        );
        await waitFor(() => asks.length === 1);
        const old = inputs[0]!;
        env.clock.advanceTo(1100);
        env.clock.fireDue();
        await waitFor(() => order.length === 2 && questionReleased);
        expect(order).toEqual(
          expect.arrayContaining(["notification", "runtime"]),
        );
        expect(disposed).toEqual([]);
        expect(inputs).toHaveLength(1);
        expect(await old.effects.checkSignal()).toEqual({ kind: "cancel" });
        await expect(
          old.effects.emit({
            situation: { cause: "message" },
            content: "late",
          }),
        ).rejects.toThrow();
        const events = await env.events.list(old.routine.arcRunId);
        const occurrence = events.find(
          (event) => event.kind === "run:interruption-occurred",
        )!;
        expect(occurrence).not.toHaveProperty("invalidatedAskIds");
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: "asks:invalidated",
            askIds: [asks[0]],
          }),
        );
        release.resolve();
        await waitFor(() => disposed.length === 1);
        expect(retained).toBe(false);
        if (poison) {
          await waitFor(async () =>
            (await env.events.list(old.routine.arcRunId)).some(
              (event) => event.kind === "routine:skipped",
            ),
          );
          expect(inputs).toHaveLength(1);
          const state = await env.store.getState(
            arcRunKey(old.routine.arcRunId),
          );
          expect(state?.lifecycle).toBe("poisoned");
          expect(
            state?.hostModules.calls[0]?.effects.some(
              (effect) => effect.hostCallOutcome.kind === "interruption",
            ),
          ).toBe(true);
          expect(
            (await env.events.list(old.routine.arcRunId)).filter(
              (event) => event.kind === "run:interruption-occurred",
            ),
          ).toHaveLength(1);
        } else {
          await waitFor(() => asks.length === 2);
          expect(await old.effects.checkSignal()).toEqual({ kind: "cancel" });
          expect(await inputs[1]!.effects.checkSignal()).toBeUndefined();
          await expect(
            old.effects.emit({
              situation: { cause: "question" },
              content: "old scope ask",
            }),
          ).rejects.toThrow();
          expect(asks[1]).not.toBe(asks[0]);
        }
      } finally {
        release.resolve();
        env.host.stop();
        await env.workerHub!.stop();
      }
    },
  );

  it.each(["completed", "failed"] as const)(
    "interruption.admission discards queued %s feedback after timer projection",
    async (kind) => {
      const env = await fixture();
      const driver = await beginActivatedDriver(env.host, dialog);
      const projecting = deferred();
      const release = deferred();
      const notifications: string[] = [];
      env.events.registerWorkEventHandler((event) => {
        if (event.kind === "run:interruption-occurred")
          notifications.push(event.id);
      });
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      const delivery = takeModuleEffects(env.host)[0]!;
      const interruption = env.host.advanceAction(
        driver.arcRunId,
        driver.frontier.frontierId,
        {
          ...delivery.effect,
          projectDialog: async () => {
            projecting.resolve();
            await release.promise;
            return dialog;
          },
        },
      );
      await projecting.promise;
      const feedback = env.host.advanceAction(
        driver.arcRunId,
        driver.frontier.frontierId,
        {
          projectDialog: projectorFor(dialog),
          instructionCoverage: Object.fromEntries(
            driver.frontier.tasks.map((task) => [
              taskId(task),
              "applied" as const,
            ]),
          ),
          reports:
            kind === "completed"
              ? [{ outcome: "completed" }]
              : [
                  {
                    error: "failed",
                    code: "stale",
                    message: "must not poison catch",
                  },
                ],
        },
      );
      release.resolve();
      try {
        await interruption;
        const next = await feedback;
        if (next.kind !== "action") throw new Error("Expected action");
        expect(next.frontier.frontierId).not.toBe(driver.frontier.frontierId);
        expect(next.frontier.briefs.judgments).toHaveLength(1);
        expect(notifications).toHaveLength(1);
        const again = await env.host.advanceAction(
          driver.arcRunId,
          driver.frontier.frontierId,
          {
            instructionCoverage: {},
            reports: [],
            projectDialog: async () => {
              throw new Error("stale projector used");
            },
          },
        );
        expect(again).toEqual(next);
        expect(
          (await env.store.getState(arcRunKey(driver.arcRunId)))?.lifecycle,
        ).toBe("active");
      } finally {
        env.host.stop();
      }
    },
  );

  it("interruption.publication dispatches replacement and disposes old work despite a held then failed occurrence append", async () => {
    const releaseWorker = deferred();
    const releaseAppend = deferred();
    const releaseReplacement = deferred();
    let old: RoutineInput | undefined;
    let releasedAsk = false;
    let disposed = false;
    let runs = 0;
    const env = await fixture({
      async run(input) {
        runs++;
        if (runs > 1) {
          await releaseReplacement.promise;
          return { outcome: "completed" };
        }
        old = input;
        await input.effects
          .emit({ situation: { cause: "question" }, content: "hold" })
          .catch(() => {
            releasedAsk = true;
          });
        await releaseWorker.promise;
        return { outcome: "completed" };
      },
      async disposeRoutine() {
        disposed = true;
      },
    });
    let asked = false;
    let runtimeReceived = false;
    let advancementError: unknown;
    const advance = env.host.advanceAction.bind(env.host);
    vi.spyOn(env.host, "advanceAction").mockImplementation(async (...args) => {
      try {
        return await advance(...args);
      } catch (error) {
        advancementError = error;
        throw error;
      }
    });
    env.workerHub!.registerOutboundHandler(
      { role: "*", audience: "*", cause: "*" },
      () => {
        asked = true;
      },
    );
    const progress = RecordingRuntime.prototype.progress;
    vi.spyOn(RecordingRuntime.prototype, "progress").mockImplementation(
      function (this: RecordingRuntime, ...args) {
        if (args[1].move === "interrupt") runtimeReceived = true;
        return progress.apply(this, args);
      },
    );
    const append = env.events.store.appendEvent.bind(env.events.store);
    env.events.store.appendEvent = async (event) => {
      if (event.kind === "run:interruption-occurred") {
        await releaseAppend.promise;
        throw new Error("occurrence append failed");
      }
      return append(event);
    };
    try {
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "start",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => asked);
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      await waitFor(() => releasedAsk && runtimeReceived);
      expect(await old!.effects.checkSignal()).toEqual({ kind: "cancel" });
      releaseWorker.resolve();
      await waitFor(() => disposed);
      await waitFor(() => runs === 2);
      expect(advancementError).toBeUndefined();
      expect(env.host.getLiveSessionCounts().actioning).toBe(1);
      expect(env.workerHub!.getLiveWorkCounts().scopes).toBe(1);
      releaseAppend.resolve();
      await waitFor(async () =>
        (await env.events.list(old!.routine.arcRunId)).some(
          (event) => event.kind === "asks:invalidated",
        ),
      );
      expect(advancementError).toBeUndefined();
      expect(runs).toBe(2);
      expect(env.clock.pendingCount).toBe(0);
      const state = (await env.store.getState(
        arcRunKey(old!.routine.arcRunId),
      ))!;
      expect(
        state.hostModules.calls[0]?.effects.some(
          (effect) => effect.hostCallOutcome.kind === "interruption",
        ),
      ).toBe(true);
    } finally {
      releaseWorker.resolve();
      releaseAppend.resolve();
      const stopping = env.host.stop();
      releaseReplacement.resolve();
      await env.workerHub!.stop();
      await stopping;
    }
  });

  it("interruption.delivery waits for the caller without autonomous runtime progression", async () => {
    const env = await fixture();
    try {
      const driver = await beginActivatedDriver(env.host, dialog);
      const progress = vi.spyOn(RecordingRuntime.prototype, "progress");
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      expect(progress).not.toHaveBeenCalled();
      const effects = takeModuleEffects(env.host);
      expect(effects).toHaveLength(1);
      const next = await env.host.advanceAction(
        driver.arcRunId,
        driver.frontier.frontierId,
        { ...effects[0]!.effect, projectDialog: projectorFor(dialog) },
      );
      expect(progress).toHaveBeenCalledTimes(1);
      expect(
        next.kind === "action" && next.frontier.briefs.judgments,
      ).toHaveLength(1);
    } finally {
      await env.host.stop();
    }
  });

  it("interruption.check submits empty reports and coverage as a worker report", async () => {
    const env = await fixture();
    try {
      const driver = await beginActivatedDriver(env.host, dialog);
      const progress = vi.spyOn(RecordingRuntime.prototype, "progress");
      const next = await env.host.advanceAction(
        driver.arcRunId,
        driver.frontier.frontierId,
        {
          projectDialog: projectorFor(dialog),
          reports: [],
          instructionCoverage: {},
        },
      );
      expect(progress).toHaveBeenCalledTimes(1);
      expect(progress.mock.calls[0]?.[1]).toMatchObject({ move: "proceed" });
      expect(
        (await env.replayStore.listSteps(driver.arcRunId)).filter(
          (step) => step.kind === "action-report" && step.origin === "worker",
        ),
      ).toHaveLength(1);
      if (next.kind !== "action") throw new Error("Expected action");
      expect(next.frontier.briefs.instructions).toEqual(
        driver.frontier.briefs.instructions,
      );
    } finally {
      env.host.stop();
    }
  });

  it.each(["reports", "instructionCoverage"] as const)(
    "interruption.check processes supplied %s feedback through ordinary advancement",
    async (kind) => {
      const env = await fixture();
      try {
        const driver = await beginActivatedDriver(env.host, dialog);
        const feedback =
          kind === "reports"
            ? {
                instructionCoverage: {},
                reports: [
                  {
                    error: "failed" as const,
                    code: "test-failure",
                    message: "worker failed",
                  },
                ],
              }
            : {
                reports: [],
                instructionCoverage: Object.fromEntries(
                  driver.frontier.briefs.instructions.map(({ id }) => [
                    id,
                    "applied" as const,
                  ]),
                ),
              };
        const next = await env.host.advanceAction(
          driver.arcRunId,
          driver.frontier.frontierId,
          {
            projectDialog: projectorFor(dialog),
            ...feedback,
          },
        );
        const reports = (
          await env.replayStore.listSteps(driver.arcRunId)
        ).filter(
          (step) => step.kind === "action-report" && step.origin === "worker",
        );
        expect(reports).toHaveLength(1);
        if (next.kind !== "action") throw new Error("Expected action");
        if (kind === "reports") expect(next.frontier.status).toBe("poisoned");
        if (kind === "instructionCoverage")
          expect(next.frontier.status).toBe("completed");
      } finally {
        env.host.stop();
      }
    },
  );

  it("interruption.retirement releases live sessions and fences queued timer checks across a new begin", async () => {
    const env = await fixture();
    try {
      const driver = await beginActivatedDriver(env.host, dialog);
      const before = await env.store.getState(arcRunKey(driver.arcRunId));
      const replay = await env.replayStore.listSteps(driver.arcRunId);
      env.clock.advanceTo(1100);
      const releasing = env.host.releaseAction(
        driver.arcRunId,
        driver.frontier.frontierId,
      );
      // The notification captures the old session but queues behind release.
      env.clock.fireDue();
      await releasing;
      await env.host.releaseAction(driver.arcRunId, driver.frontier.frontierId);
      expect(env.host.getLiveSessionCounts()).toMatchObject({
        actioning: 0,
      });
      expect(env.clock.pendingCount).toBe(0);
      expect(await env.store.getState(arcRunKey(driver.arcRunId))).toEqual(
        before,
      );
      expect(await env.replayStore.listSteps(driver.arcRunId)).toEqual(replay);
      const [next] = await env.host.begin({
        arcRunId: driver.arcRunId,
        projectDialog: projectorFor(dialog),
      });
      if (next?.kind !== "action") throw new Error("Expected action");
      expect(next.frontier.tasks[0]?.kind).toBe("instruction");
      expect(next.frontier.frontierId).not.toBe(driver.frontier.frontierId);
      await env.host.releaseAction(driver.arcRunId, driver.frontier.frontierId);
      await expect(
        env.host.advanceAction(driver.arcRunId, driver.frontier.frontierId, {
          reports: [],
          instructionCoverage: {},
          projectDialog: projectorFor(dialog),
        }),
      ).rejects.toThrow("Begin action execution");
      const [caught] = await drainModuleEffects(env.host, [next], dialog);
      expect(
        caught?.kind === "action" && caught.frontier.briefs.judgments,
      ).toHaveLength(1);
      expect(env.host.getLiveSessionCounts().actioning).toBe(1);
      await env.host.releaseAction(driver.arcRunId, next.frontier.frontierId);
      expect(env.host.getLiveSessionCounts().actioning).toBe(0);
    } finally {
      env.host.stop();
    }
  });

  it("interruption.retirement shutdown fences effects and waits for invocation before disposal", async () => {
    const invocation = deferred();
    let input: RoutineInput | undefined;
    let disposed = false;
    const env = await fixture({
      async run(value) {
        input = value;
        await invocation.promise;
        return { outcome: "completed" };
      },
      async disposeRoutine() {
        disposed = true;
      },
    });
    try {
      await collectAsync(
        env.workerHub!.submitInbound({
          content: "go",
          metadata: { principal: "owner" },
        }),
      );
      await waitFor(() => input !== undefined);
      const old = input!;
      const before = await env.store.getState(arcRunKey(old.routine.arcRunId));
      const stopping = env.workerHub!.stop();
      expect(await old.effects.checkSignal()).toEqual({ kind: "cancel" });
      expect(disposed).toBe(false);
      invocation.resolve();
      await stopping;
      expect(disposed).toBe(true);
      expect(env.host.getLiveSessionCounts()).toMatchObject({
        actioning: 0,
      });
      expect(env.workerHub!.getLiveWorkCounts()).toEqual({
        scopes: 0,
        routines: 0,
        continuations: 0,
      });
      expect(await old.effects.checkSignal()).toEqual({ kind: "cancel" });
      expect(await env.store.getState(arcRunKey(old.routine.arcRunId))).toEqual(
        before,
      );
    } finally {
      invocation.resolve();
      env.host.stop();
      await env.workerHub!.stop();
    }
  });

  it("interruption.retirement cleans targeted begin with no returned token", async () => {
    const clock = makeControlledTime();
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store, ...clock });
    try {
      for (let i = 0; i < 20; i++) {
        expect(
          await host.begin({
            arcRunId: `unknown-${i}`,
            projectDialog: projectorFor(dialog),
          }),
        ).toEqual([]);
      }
      expect(host.getLiveSessionCounts().actioning).toBe(0);
      await host.registerArc("uncaught", parse(source(false)));
      const driver = await beginActivatedDriver(host, dialog);
      await host.releaseAction(driver.arcRunId, driver.frontier.frontierId);
      clock.advanceTo(1100);
      const steps = await host.begin({
        arcRunId: driver.arcRunId,
        projectDialog: projectorFor(dialog),
      });
      expect(steps).toHaveLength(1);
      expect(host.getLiveSessionCounts().actioning).toBe(1);
      const [interrupted] = await drainModuleEffects(host, steps, dialog);
      if (interrupted?.kind !== "action") throw new Error("Missing handoff.");
      expect(interrupted.frontier.traversals[0]?.state).toBe("interrupted");
      await host.releaseAction(
        driver.arcRunId,
        interrupted.frontier.frontierId,
      );
      expect(host.getLiveSessionCounts().actioning).toBe(0);
      expect(clock.pendingCount).toBe(0);
      expect(
        (await store.getState(arcRunKey(driver.arcRunId)))?.lifecycle,
      ).toBe("active");
    } finally {
      host.stop();
    }
  });

  it("interruption.retirement cleans reconstruction failure before returning a token", async () => {
    const env = await fixture();
    try {
      const driver = await beginActivatedDriver(env.host, dialog);
      await env.host.releaseAction(driver.arcRunId, driver.frontier.frontierId);
      const before = await env.store.getState(arcRunKey(driver.arcRunId));
      const failure = new Error("projection failed during reconstruction");
      await expect(
        env.host.begin({
          arcRunId: driver.arcRunId,
          projectDialog: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(env.host.getLiveSessionCounts()).toMatchObject({
        actioning: 0,
      });
      expect(env.clock.pendingCount).toBe(0);
      expect(await env.store.getState(arcRunKey(driver.arcRunId))).toEqual(
        before,
      );
      const [next] = await env.host.begin({
        arcRunId: driver.arcRunId,
        projectDialog: projectorFor(dialog),
      });
      expect(next?.kind).toBe("action");
    } finally {
      env.host.stop();
    }
  });

  it("interruption.retirement releases earlier activations when a fan-out cannot return its tokens", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    await host.registerArc(
      "fanout",
      parse(`"arc";
      function First() { this.trigger = () => true; $instruct("first"); }
      function Second() { this.trigger = () => true; $instruct("second"); }
    `),
    );
    const failure = new Error("second activation failed");
    let projections = 0;
    try {
      await expect(
        host.begin({
          dialog,
          inbound: { content: "go" },
          principal: "owner",
          activationPolicy: "all",
          projectDialog: async () => {
            if (++projections === 2) throw failure;
            return dialog;
          },
        }),
      ).rejects.toBe(failure);
      expect(host.getLiveSessionCounts()).toMatchObject({
        preparing: 0,
        actioning: 0,
      });
      expect(
        (await host.listRunViews()).some((run) => run.stage === "actioning"),
      ).toBe(true);
    } finally {
      host.stop();
    }
  });

  it.each([false, true])(
    "interruption.retirement drains completed runs with immediate=%s",
    async (immediate) => {
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      await host.registerArc(
        "finished",
        parse(
          `"arc"; function Main() { this.trigger = () => true; ${immediate ? "" : '$instruct("work");'} }`,
        ),
      );
      let calls = 0;
      const { workerHub } = makeWorkerHub({
        arcHost: host,
        workers: {
          "$default-worker": async () => {
            calls++;
            return { outcome: "completed" };
          },
        },
      });
      try {
        for (let i = 0; i < 20; i++)
          await collectAsync(
            workerHub.submitInbound({
              content: "go",
              metadata: { principal: `owner-${i}` },
            }),
          );
        await waitFor(() => host.getLiveSessionCounts().actioning === 0);
        expect(calls).toBe(immediate ? 0 : 20);
        expect(workerHub.getLiveWorkCounts()).toEqual({
          scopes: 0,
          routines: 0,
          continuations: 0,
        });
      } finally {
        host.stop();
        await workerHub.stop();
      }
    },
  );

  it("interruption.ownership preserves issuance and suppresses redelivery when the runtime rejects the move", async () => {
    const env = await fixture();
    const driver = await beginActivatedDriver(env.host, dialog);
    const notifications: string[] = [];
    env.events.registerWorkEventHandler((event) => {
      if (event.kind === "run:interruption-occurred")
        notifications.push(event.id);
    });
    const progress = RecordingRuntime.prototype.progress;
    let deliveries = 0;
    vi.spyOn(RecordingRuntime.prototype, "progress").mockImplementation(
      function (this: RecordingRuntime, ...args) {
        if (args[1].move === "interrupt") {
          deliveries++;
          throw new Error("runtime rejected move");
        }
        return progress.apply(this, args);
      },
    );
    try {
      env.clock.advanceTo(1100);
      env.clock.fireDue();
      const delivery = takeModuleEffects(env.host)[0]!;
      const input = { ...delivery.effect, projectDialog: projectorFor(dialog) };
      await expect(
        env.host.advanceAction(
          driver.arcRunId,
          driver.frontier.frontierId,
          input,
        ),
      ).rejects.toThrow("runtime rejected move");
      expect(delivery.signal.aborted).toBe(true);
      await expect(
        env.host.advanceAction(
          driver.arcRunId,
          driver.frontier.frontierId,
          input,
        ),
      ).rejects.toThrow("Begin action execution");
      expect(deliveries).toBe(1);
      expect(notifications).toHaveLength(1);
      expect(
        (await env.events.list(driver.arcRunId)).filter(
          (event) => event.kind === "run:interruption-occurred",
        ),
      ).toHaveLength(1);
    } finally {
      env.host.stop();
    }
  });
});

describe("Host module execution retirement", () => {
  it("interruption.setup stop aborts opening host module work before a release token exists", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const entered = deferred();
    const released = vi.fn(async () => {});
    let signal: AbortSignal | undefined;
    await host.registerHostModule("gate", {
      declaration: hmd.define({ wait: () => hmd.Bool() }),
      submit: async (calls, options) => {
        signal = options.signal;
        entered.resolve();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        moduleHubFor(host).enqueueModuleEffect(
          options.arcRunId,
          {
            hostCallId: calls[0]!.call.hostCallId,
            hostCallOutcome: { kind: "resolution", value: true },
          },
          options.signal,
        );
        return calls.map(({ call }) => ({
          hostCallId: call.hostCallId,
          moduleData: { setup: "late" },
        }));
      },
      releaseRun: released,
    });
    await host.registerArc(
      "setup",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => true; Gate.$wait(); $instruct("work"); }',
      ),
    );
    const pending = host.begin({
      dialog,
      inbound: { content: "go" },
      principal: "owner",
      projectDialog: projectorFor(dialog),
    });
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    const stopped = host.stop();
    expect(signal?.aborted).toBe(true);
    await Promise.all([stopped, rejection]);
    expect(released).toHaveBeenCalledTimes(1);
    expect(host.getLiveSessionCounts().actioning).toBe(0);
    expect(takeModuleEffects(host)).toEqual([]);
    const states = await collectAsync(store.listStates());
    expect(states[0]?.[1].hostModules.calls[0]).toMatchObject({
      acknowledged: false,
      effects: [],
    });
    expect(
      states[0]?.[1].hostModules.calls[0]?.call.moduleData,
    ).toBeUndefined();
  });

  it("interruption.setup failure returns poison and leaves participating modules for explicit release", async () => {
    const host = await createTestArcHost({ store: new InMemoryArcHostStore() });
    const firstRelease = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const secondRelease = vi.fn(async () => {});
    const signals: AbortSignal[] = [];
    const failure = new Error("second setup failed");
    await host.registerHostModule("first", {
      declaration: hmd.define({ value: () => hmd.Bool() }),
      submit: async (calls, { arcRunId, signal }) => {
        signals.push(signal);
        calls.forEach(({ call }) =>
          moduleHubFor(host).enqueueModuleEffect(
            arcRunId,
            {
              hostCallId: call.hostCallId,
              hostCallOutcome: { kind: "resolution", value: true },
            },
            signal,
          ),
        );
        return calls.map(({ call }) => ({ hostCallId: call.hostCallId }));
      },
      releaseRun: firstRelease,
    });
    await host.registerHostModule("second", {
      declaration: hmd.define({ value: () => hmd.Bool() }),
      submit: async (_calls, { signal }) => {
        signals.push(signal);
        throw failure;
      },
      releaseRun: secondRelease,
    });
    await host.registerArc(
      "setup",
      parse(
        '"arc"; import First from "host:first"; import Second from "host:second"; function Main() { this.trigger = () => true; First.$value(); Second.$value(); $instruct("work"); }',
      ),
    );
    try {
      const driver = await beginActivatedDriver(host, dialog);
      expect(driver.frontier.status).toBe("poisoned");
      expect(driver.frontier.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reasonCode: "host-module-submission-failed",
            reason: expect.stringContaining(failure.message),
          }),
        ]),
      );
      expect(firstRelease).not.toHaveBeenCalled();
      expect(secondRelease).not.toHaveBeenCalled();
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      expect(host.getLiveSessionCounts().actioning).toBe(1);
      await expect(
        host.releaseAction(driver.arcRunId, driver.frontier.frontierId),
      ).rejects.toThrow("Host module cleanup failed.");
      expect(firstRelease).toHaveBeenCalledTimes(1);
      expect(secondRelease).toHaveBeenCalledTimes(1);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(host.getLiveSessionCounts().actioning).toBe(0);
    } finally {
      await host.stop();
    }
  });
});

describe("Host module execution generation boundaries", () => {
  it("interruption.setup release aborts host module submission reached during advancement", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const entered = deferred();
    const released = vi.fn(async () => {});
    let signal: AbortSignal | undefined;
    await host.registerHostModule("gate", {
      declaration: hmd.define({ wait: () => hmd.Bool() }),
      submit: async (calls, options) => {
        signal = options.signal;
        entered.resolve();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return calls.map(({ call }) => ({ hostCallId: call.hostCallId }));
      },
      releaseRun: released,
    });
    await host.registerArc(
      "setup",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => true; $instruct("first"); Gate.$wait(); $instruct("next"); }',
      ),
    );
    const driver = await beginActivatedDriver(host, dialog);
    const pending = driver.advance({
      dialog,
      input: {
        reports: [{ outcome: "completed" }],
        instructionCoverage: Object.fromEntries(
          driver.frontier.tasks.map((task) => [
            taskId(task),
            "applied" as const,
          ]),
        ),
      },
    });
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    const release = host.releaseAction(
      driver.arcRunId,
      driver.frontier.frontierId,
    );
    expect(signal?.aborted).toBe(true);
    await Promise.all([release, rejection]);
    expect(released).toHaveBeenCalledTimes(1);
    expect(host.getLiveSessionCounts().actioning).toBe(0);
    expect(
      (await store.getState(arcRunKey(driver.arcRunId)))?.hostModules.calls[0],
    ).toMatchObject({ acknowledged: false, effects: [] });
    await host.stop();
  });

  it("interruption.setup restoration failure returns poison with ordinary release ownership", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const firstRelease = vi.fn(async () => {});
    const secondRelease = vi.fn(async () => {});
    let restoring = false;
    const failure = new Error("restoration setup failed");
    for (const [name, releaseRun] of [
      ["first", firstRelease],
      ["second", secondRelease],
    ] as const) {
      await host.registerHostModule(name, {
        declaration: hmd.define({ value: () => hmd.Bool() }),
        submit: async (calls, { arcRunId, signal }) => {
          if (restoring && name === "second") throw failure;
          for (const { call, effects } of calls)
            if (!effects.length)
              moduleHubFor(host).enqueueModuleEffect(
                arcRunId,
                {
                  hostCallId: call.hostCallId,
                  hostCallOutcome: { kind: "resolution", value: true },
                },
                signal,
              );
          return calls.map(({ call }) => ({ hostCallId: call.hostCallId }));
        },
        releaseRun,
      });
    }
    await host.registerArc(
      "setup",
      parse(
        '"arc"; import First from "host:first"; import Second from "host:second"; function Main() { this.trigger = () => true; First.$value(); Second.$value(); $instruct("work"); }',
      ),
    );
    try {
      const first = await beginActivatedDriver(host, dialog);
      await host.releaseAction(first.arcRunId, first.frontier.frontierId);
      firstRelease.mockClear();
      secondRelease.mockClear();
      const before = (await store.getState(arcRunKey(first.arcRunId)))!;
      restoring = true;
      const [step] = await host.begin({
        arcRunId: first.arcRunId,
        projectDialog: projectorFor(dialog),
      });
      expect(step).toMatchObject({
        kind: "action",
        frontier: { status: "poisoned" },
      });
      expect((await store.getState(arcRunKey(first.arcRunId)))?.lifecycle).toBe(
        "poisoned",
      );
      expect(firstRelease).not.toHaveBeenCalled();
      expect(secondRelease).not.toHaveBeenCalled();
      expect(host.getLiveSessionCounts().actioning).toBe(1);
      if (step?.kind !== "action") throw new Error("Expected action frontier.");
      const next = await host.advanceAction(
        first.arcRunId,
        step.frontier.frontierId,
        {
          reports: [],
          instructionCoverage: {},
          projectDialog: projectorFor(dialog),
        },
      );
      expect(next.kind === "action" && next.frontier).toBe(step.frontier);
      await host.releaseAction(first.arcRunId, step.frontier.frontierId);
      expect(firstRelease).toHaveBeenCalledTimes(1);
      expect(secondRelease).toHaveBeenCalledTimes(1);
      expect(host.getLiveSessionCounts().actioning).toBe(0);
      expect(
        (await store.getState(arcRunKey(first.arcRunId)))?.hostModules,
      ).toEqual(before.hostModules);
    } finally {
      await host.stop();
    }
  });

  it("interruption.generation drops queued and late host module effects in the hub after reopening the same run", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    let runs = 0;
    const { workerHub } = makeWorkerHub({
      arcHost: host,
      workers: {
        "$default-worker": async () => {
          runs++;
          return { outcome: "completed" };
        },
      },
    });
    const emissions: (() => void)[] = [];
    await host.registerHostModule("gate", {
      declaration: hmd.define({ value: () => hmd.Bool() }),
      submit: async (calls, { arcRunId, signal }) => {
        const id = calls[0]!.call.hostCallId;
        emissions.push(() =>
          workerHub.enqueueModuleEffect(
            arcRunId,
            {
              hostCallId: id,
              hostCallOutcome: { kind: "resolution", value: true },
            },
            signal,
          ),
        );
        return calls.map(({ call }) => ({ hostCallId: call.hostCallId }));
      },
    });
    await host.registerArc(
      "setup",
      parse(
        '"arc"; import Gate from "host:gate"; function Main() { this.trigger = () => true; Gate.$value(); $instruct("work"); }',
      ),
    );
    const beginnings = vi.spyOn(host, "begin");
    const advances = vi.spyOn(host, "advanceAction");
    try {
      await collectAsync(
        workerHub.submitInbound({
          content: "go",
          metadata: { principal: "owner" },
        }),
      );
      const steps: ArcHostStep[] = await beginnings.mock.results[0]!.value;
      const first = steps.find((step) => step.kind === "action");
      if (first?.kind !== "action")
        throw new Error("Expected action frontier.");
      await workerHub.requestPause(first.arcRunId);
      emissions[0]!();
      await host.releaseAction(first.arcRunId, first.frontier.frontierId);
      expect(await workerHub.resume(first.arcRunId)).toMatchObject({
        outcome: "resumed",
      });
      expect(emissions).toHaveLength(2);
      const before = (await store.getState(arcRunKey(first.arcRunId)))!
        .hostModules;
      emissions[0]!();
      expect(advances).not.toHaveBeenCalled();
      expect(runs).toBe(0);
      expect(
        (await store.getState(arcRunKey(first.arcRunId)))?.hostModules,
      ).toEqual(before);
      emissions[1]!();
      await waitFor(
        async () =>
          (await store.getState(arcRunKey(first.arcRunId)))?.lifecycle ===
          "completed",
      );
      expect(runs).toBe(1);
      expect(
        (await store.getState(arcRunKey(first.arcRunId)))?.hostModules.calls[0]
          ?.effects,
      ).toHaveLength(1);
      expect(
        advances.mock.calls.filter(([, , input]) => "hostCallId" in input),
      ).toHaveLength(1);
    } finally {
      await Promise.all([host.stop(), workerHub.stop()]);
    }
  });
});
