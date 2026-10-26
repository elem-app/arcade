import { parse } from "@elem-app/arc/parser";
import { createTestArcHost } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import type { ResumeResult } from "../src/index.js";
import type {
  ArcadeLogger,
  ArcRunId,
  ClaudeSdkQueryFn,
  InstructionTask,
  OpenAiRunState,
  OpenAiSdkRunFn,
  RoleWorker,
  RoutineContext,
  RoutineState,
  Task,
  WorkerHubService,
  WorkerHubStore,
} from "../src/testing.js";
import {
  arcRunKey,
  classifyTransportLoss,
  createArcadeLogger,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryReplayStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
  RoutinePausedError,
  taskId,
  workerContextKey,
  WorkEventService,
} from "../src/testing.js";
import { callOpenAiTool } from "./backend-helpers.js";
import { makeControlledTime } from "./controlled-time.js";
import {
  ALICE_OWNER,
  collectAsync,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import {
  attachToActiveRun,
  claudeStreamingQuery,
  settleFirstRoutine,
  submitActivation,
} from "./worker-hub-helpers.js";

describe("WorkerHubService execution control", () => {
  it.each(["before feedback", "during dialog projection"] as const)(
    "exec.cooperative-pause preserves completed feedback and holds subsequent work when paused %s",
    async (pauseAt) => {
      const store = new InMemoryArcHostStore();
      const replayStore = new InMemoryReplayStore();
      const arcHost = createTestArcHost({
        store,
        replayStore,
        ...makeControlledTime(),
      });
      await arcHost.registerArc(
        "completed-pause",
        parse(`
"arc";
import Time from "host:time";
function Main() {
  this.trigger = () => true;
  $instruct("first");
  Time.$addTimeout(5000, "after-first");
  $instruct("second");
}
`),
      );
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let feedbackReturned = false;
      const advance = arcHost.advanceAction.bind(arcHost);
      const advanceSpy = vi
        .spyOn(arcHost, "advanceAction")
        .mockImplementation(async (...args) => {
          const [arcRunId, frontierId, input] = args;
          const isFirstFeedback = "reports" in input && calls.length === 1;
          const next = await advance(arcRunId, frontierId, {
            ...input,
            projectDialog: async (view) => {
              const dialog = await input.projectDialog(view);
              if (isFirstFeedback && pauseAt === "during dialog projection")
                await workerHub.requestPause(arcRunId);
              return dialog;
            },
          });
          feedbackReturned = true;
          return next;
        });
      const calls: string[] = [];
      let runId = "";
      const { workerHub } = makeWorkerHub({
        arcHost,
        workers: {
          "$default-worker": async (task) => {
            if (task.kind !== "instruction")
              throw new Error("Expected instruction work");
            runId = task.arcRunId;
            calls.push(String(task.texts[0]));
            if (calls.length === 1) await released;
            return { outcome: "completed" };
          },
        },
      });
      try {
        await collectAsync(
          workerHub.submitInbound({
            content: "start",
            metadata: { principal: ALICE_OWNER },
          }),
        );
        await waitFor(() => calls.length === 1);
        if (pauseAt === "before feedback") await workerHub.requestPause(runId);
        release();
        await waitFor(() => feedbackReturned);
        expect(await workerHub.getExecutionControlView(runId)).toMatchObject({
          status: "paused",
        });
        expect(calls).toEqual(["first"]);
        expect(
          (await store.getState(arcRunKey(runId)))?.hostModules.calls.length,
        ).toBe(0);
        expect(
          (await replayStore.listSteps(runId)).filter(
            (step) => step.kind === "action-report" && step.origin === "worker",
          ),
        ).toHaveLength(1);
        await expect(workerHub.resume(runId)).resolves.toMatchObject({
          outcome: "resumed",
        });
        await waitFor(async () => {
          const view = await arcHost.getRunView(runId);
          return view?.stage === "actioning" && view.lifecycle === "completed";
        });
        expect(calls).toEqual(["first", "second"]);
        const reports = (await replayStore.listSteps(runId)).filter(
          (step) => step.kind === "action-report" && step.origin === "worker",
        );
        expect(reports).toHaveLength(2);
        await expect(
          arcHost.verifyReplay(runId, "arc:completed-pause:Main"),
        ).resolves.toMatchObject({ status: "compatible" });
      } finally {
        release();
        advanceSpy.mockRestore();
        arcHost.stop();
        await workerHub.stop();
      }
    },
  );

  it.each(["before feedback", "during dialog projection"] as const)(
    "exec.control-inactive preserves final feedback when paused %s",
    async (pauseAt) => {
      const store = new InMemoryArcHostStore();
      const replayStore = new InMemoryReplayStore();
      const arcHost = createTestArcHost({
        store,
        replayStore,
        ...makeControlledTime(),
      });
      await arcHost.registerArc(
        "final-pause",
        parse(`
"arc";
function Main() {
  this.trigger = () => true;
  $instruct("final");
}
`),
      );
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const worker = vi.fn(async () => {
        await gate;
        return { outcome: "completed" as const };
      });
      const { workerHub, routineStore, workEventStore } = makeWorkerHub({
        arcHost,
        workers: { "$default-worker": worker },
      });
      const advance = arcHost.advanceAction.bind(arcHost);
      const advanceSpy = vi
        .spyOn(arcHost, "advanceAction")
        .mockImplementation(async (arcRunId, frontierId, input) =>
          advance(arcRunId, frontierId, {
            ...input,
            projectDialog: async (view) => {
              const dialog = await input.projectDialog(view);
              if (pauseAt === "during dialog projection")
                await workerHub.requestPause(arcRunId);
              return dialog;
            },
          }),
        );
      try {
        await collectAsync(
          workerHub.submitInbound({
            content: "start",
            metadata: { principal: ALICE_OWNER },
          }),
        );
        await waitFor(() => worker.mock.calls.length === 1);
        const [run] = await arcHost.listRunViews();
        const runId = run!.arcRunId;
        if (pauseAt === "before feedback") await workerHub.requestPause(runId);
        release();
        await waitFor(
          async () =>
            (await store.getState(arcRunKey(runId)))?.lifecycle === "completed",
        );
        await expect(workerHub.getExecutionControlView(runId)).resolves.toEqual(
          { status: "inactive", arcRunId: runId },
        );
        const control = await routineStore.getExecutionControl(runId);
        const events = await collectAsync(workEventStore.listEvents(runId));
        const reports = await replayStore.listSteps(runId);
        expect(
          reports.filter(
            (step) => step.kind === "action-report" && step.origin === "worker",
          ),
        ).toHaveLength(1);
        for (const operation of [
          () => workerHub.requestPause(runId),
          () => workerHub.resume(runId),
        ]) {
          await expect(operation()).resolves.toEqual({
            outcome: "inactive",
            arcRunId: runId,
          });
          expect(await routineStore.getExecutionControl(runId)).toEqual(
            control,
          );
          expect(await collectAsync(workEventStore.listEvents(runId))).toEqual(
            events,
          );
          expect(await replayStore.listSteps(runId)).toEqual(reports);
          expect(worker).toHaveBeenCalledTimes(1);
        }
      } finally {
        release();
        advanceSpy.mockRestore();
        arcHost.stop();
        await workerHub.stop();
      }
    },
  );

  it.each(["completed", "deflected", "poisoned"] as const)(
    "exec.control-inactive rejects retained controls for %s executions",
    async (lifecycle) => {
      const store = new InMemoryArcHostStore();
      const arcHost = createTestArcHost({ store });
      await arcHost.registerArc(
        "retained-control",
        parse(
          `"arc"; function Main() { this.trigger = () => true; $instruct("work"); }`,
        ),
      );
      const [step] = await arcHost.begin({
        dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
        principal: ALICE_OWNER,
        inbound: { content: "start" },
        projectDialog: async () => ({
          cursor: { user: 0, self: 0 },
          lastTurns: [],
        }),
      });
      if (step?.kind !== "action") throw new Error("Expected action");
      const runId = step.arcRunId;
      const state = (await store.getState(arcRunKey(runId)))!;
      await store.putState(arcRunKey(runId), { ...state, lifecycle });
      const worker = vi.fn();
      const { workerHub, routineStore, workEventStore } = makeWorkerHub({
        arcHost,
        workers: { "$default-worker": worker },
      });
      const begin = vi.spyOn(arcHost, "begin");
      try {
        for (const control of [
          { arcRunId: runId, status: "running" as const, updatedAt: "now" },
          {
            arcRunId: runId,
            status: "paused" as const,
            pausedAt: "now",
            updatedAt: "now",
            pausedRoutineId: "absent-worker",
          },
          {
            arcRunId: runId,
            status: "transport-lost" as const,
            transportLostAt: "now",
            updatedAt: "now",
            transportLostRoutineId: "absent-worker",
            transportReason: {
              reason: "network timeout" as const,
              backend: "test",
              message: "offline",
            },
          },
        ]) {
          await routineStore.putExecutionControl(control);
          const write = vi.spyOn(routineStore, "putExecutionControl");
          const events = await collectAsync(workEventStore.listEvents(runId));
          await expect(
            workerHub.getExecutionControlView(runId),
          ).resolves.toEqual({ status: "inactive", arcRunId: runId });
          await expect(workerHub.requestPause(runId)).resolves.toEqual({
            outcome: "inactive",
            arcRunId: runId,
          });
          await expect(workerHub.resume(runId)).resolves.toEqual({
            outcome: "inactive",
            arcRunId: runId,
          });
          expect(write).not.toHaveBeenCalled();
          expect(await routineStore.getExecutionControl(runId)).toEqual(
            control,
          );
          expect(await collectAsync(workEventStore.listEvents(runId))).toEqual(
            events,
          );
          write.mockRestore();
        }
        expect(begin).not.toHaveBeenCalled();
        expect(worker).not.toHaveBeenCalled();
      } finally {
        begin.mockRestore();
        arcHost.stop();
        await workerHub.stop();
      }
    },
  );

  it("exec.control-inactive preserves present running defaults and missing operation results", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const { workerHub, routineStore } = makeWorkerHub({ arcHost });
    try {
      // The hub never ran the persisted run, so nothing executes it here.
      for (const [id, status] of [
        [task.arcRunId, "hub-restarted"],
        ["unknown-run", "running"],
      ] as const) {
        expect(await routineStore.getExecutionControl(id)).toBeUndefined();
        await expect(
          workerHub.getExecutionControlView(id),
        ).resolves.toMatchObject({ status, arcRunId: id });
        expect(await routineStore.getExecutionControl(id)).toBeUndefined();
      }
      await expect(workerHub.requestPause("unknown-run")).resolves.toEqual({
        outcome: "missing",
        arcRunId: "unknown-run",
      });
      await expect(workerHub.resume("unknown-run")).resolves.toEqual({
        outcome: "missing",
        arcRunId: "unknown-run",
      });
    } finally {
      await workerHub.stop();
      arcHost.stop();
    }
  });

  it("exec.control-inactive allows accepted resume to overlap final settlement without restarting", async () => {
    const store = new InMemoryArcHostStore();
    const replayStore = new InMemoryReplayStore();
    const arcHost = createTestArcHost({ store, replayStore });
    await arcHost.registerArc(
      "resume-race",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $instruct("final"); }`,
      ),
    );
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let releaseAdvance!: () => void;
    const advanceGate = new Promise<void>((resolve) => {
      releaseAdvance = resolve;
    });
    let atAdvance = false;
    const worker = vi.fn(async () => {
      await workerGate;
      return { outcome: "completed" as const };
    });
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workers: { "$default-worker": worker },
    });
    const advance = arcHost.advanceAction.bind(arcHost);
    const advanceSpy = vi
      .spyOn(arcHost, "advanceAction")
      .mockImplementation(async (...args) => {
        if ("instructionCoverage" in args[2]) {
          atAdvance = true;
          await advanceGate;
        }
        return advance(...args);
      });
    const beginSpy = vi.spyOn(arcHost, "begin");
    try {
      await collectAsync(
        workerHub.submitInbound({
          content: "start",
          metadata: { principal: ALICE_OWNER },
        }),
      );
      await waitFor(() => worker.mock.calls.length === 1);
      const [run] = await arcHost.listRunViews();
      const id = run!.arcRunId;
      await workerHub.requestPause(id);
      releaseWorker();
      await waitFor(() => atAdvance);
      const resumed = workerHub.resume(id);
      await waitFor(
        async () =>
          (await routineStore.getExecutionControl(id))?.status === "running",
      );
      expect((await store.getState(arcRunKey(id)))?.lifecycle).toBe("active");
      expect(beginSpy.mock.calls.some(([input]) => input.arcRunId === id)).toBe(
        false,
      );
      releaseAdvance();
      await expect(resumed).resolves.toMatchObject({
        outcome: "resumed",
        control: { status: "running" },
      });
      const state = await store.getState(arcRunKey(id));
      expect(state?.lifecycle).toBe("completed");
      const events = await collectAsync(workEventStore.listEvents(id));
      const replay = await replayStore.listSteps(id);
      expect(
        events.filter((event) => event.kind === "control:resumed"),
      ).toHaveLength(1);
      await expect(workerHub.getExecutionControlView(id)).resolves.toEqual({
        status: "inactive",
        arcRunId: id,
      });
      const targeted = beginSpy.mock.calls.findIndex(
        ([input]) => input.arcRunId === id,
      );
      expect(targeted).toBeGreaterThanOrEqual(0);
      await expect(beginSpy.mock.results[targeted]!.value).resolves.toEqual([]);
      expect(worker).toHaveBeenCalledTimes(1);
      expect(
        events.filter((event) => event.kind === "run:started"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.kind === "run:completed"),
      ).toHaveLength(1);
      expect(
        replay.filter(
          (step) => step.kind === "action-report" && step.origin === "worker",
        ),
      ).toHaveLength(1);
    } finally {
      releaseWorker();
      releaseAdvance();
      beginSpy.mockRestore();
      advanceSpy.mockRestore();
      await workerHub.stop();
      arcHost.stop();
    }
  });

  it("exec.resume rebuilds an active run its uncaught interruption stopped", async () => {
    const store = new InMemoryArcHostStore();
    const time = makeControlledTime();
    const host = createTestArcHost({ store, ...time });
    await host.registerArc(
      "interrupted-control",
      parse(
        `"arc"; import Time from "host:time"; function Main() { this.trigger = () => true; Time.$addTimeout(25); $instruct("work"); }`,
      ),
    );
    const dispatched: Task[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const worker = vi.fn<RoleWorker>(async (task) => {
      dispatched.push(task);
      if (dispatched.length === 1) await firstGate;
      return { outcome: "completed" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost: host,
      workers: { "$default-worker": worker },
    });
    const begin = vi.spyOn(host, "begin");
    try {
      const arcRunId = await submitActivation(workerHub, "start");
      await waitFor(() => dispatched.length === 1);
      const before = (await store.getState(arcRunKey(arcRunId)))!;
      time.advanceTo(1025);
      time.fireDue();
      await waitFor(
        async () =>
          (await workerHub.getExecutionControlView(arcRunId)).status ===
          "uncaught-interruption",
      );
      expect((await store.getState(arcRunKey(arcRunId)))?.lifecycle).toBe(
        "active",
      );
      releaseFirst();

      await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
        outcome: "resumed",
        control: { status: "running" },
      });
      expect(begin).toHaveBeenCalledWith(expect.objectContaining({ arcRunId }));
      await waitFor(() => dispatched.length === 2);
      expect(taskId(dispatched[1]!)).toBe(taskId(dispatched[0]!));
      expect(
        (await store.getState(arcRunKey(arcRunId)))?.reactivationCount,
      ).toBe(before.reactivationCount);
    } finally {
      releaseFirst();
      begin.mockRestore();
      await workerHub.stop();
      host.stop();
    }
  });

  it("does not treat preparing metadata as resumable execution", async () => {
    const arcHost = await makeArcHostWithSource(
      "preparing-resume",
      WATCH_SOURCE,
    );
    const { workerHub } = makeWorkerHub({ arcHost });
    vi.spyOn(arcHost, "getRunView").mockResolvedValue({
      stage: "preparing",
      arcRunId: "preparing",
      ownerPrincipal: ALICE_OWNER,
      arcRef: "arc:preparing-resume:Watch",
    });
    await expect(workerHub.resume("preparing")).resolves.toMatchObject({
      outcome: "missing",
    });
    await expect(workerHub.requestPause("preparing")).resolves.toMatchObject({
      outcome: "missing",
    });
  });

  it("translates Claude connection resets and SDK timeouts to transport interrupts", () => {
    expect(
      classifyTransportLoss(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        "claude-sdk",
      ),
    ).toMatchObject({ reason: "connection reset", backend: "claude-sdk" });
    expect(
      classifyTransportLoss(
        new Error("Claude instruction timed out after 30000ms"),
        "claude-sdk",
      ),
    ).toMatchObject({ reason: "sdk timeout", backend: "claude-sdk" });
  });

  it("translates OpenAI network timeouts to transport interrupts", () => {
    expect(
      classifyTransportLoss(
        Object.assign(new Error("fetch failed"), { code: "ETIMEDOUT" }),
        "openai-sdk",
      ),
    ).toMatchObject({ reason: "network timeout", backend: "openai-sdk" });
  });

  it("resumes the captured worker after a paused interrupt", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const info = vi.fn();
    const logger: ArcadeLogger = {
      level: "debug",
      format: "json",
      info,
      debug: vi.fn(),
    };
    let releaseFirst!: () => void;
    const firstBoundary = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const handler = vi.fn(async (_task, context: RoutineContext) => {
      calls += 1;
      if (calls === 1) {
        await firstBoundary;
        expect("emit" in context).toBe(false);
        expect("work" in context).toBe(false);
        expect("logToolEvent" in context).toBe(false);
        // In-process callbacks use the adapter-local pause sentinel because they
        // do not implement the Worker protocol themselves.
        throw new RoutinePausedError();
      } else {
        expect(context.routineResume).toEqual({ delivery: "continue" });
      }
      return { outcome: "completed" as const };
    });
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: handler },
      logger,
    });

    const { arcRunId, routine } = await startFirstRoutine(
      workerHub,
      routineStore,
    );

    await expect(workerHub.requestPause("run:not-this-one")).resolves.toEqual({
      outcome: "missing",
      arcRunId: "run:not-this-one",
    });

    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId, status: "pauseRequested" },
    });
    expect(info).toHaveBeenCalledWith("worker_hub.pause.requested", {
      arcRunId,
      status: "pauseRequested",
    });
    releaseFirst();
    await waitFor(
      async () =>
        (await routineStore.getRoutine(routine.id))?.status === "paused",
    );
    expect(info).toHaveBeenCalledWith("worker_hub.pause.paused", {
      arcRunId,
      status: "paused",
    });

    const pausedControl = await routineStore.getExecutionControl(arcRunId);
    const pausedRoutine = await routineStore.getRoutine(routine.id);
    await attachToActiveRun(workerHub, arcRunId);
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual(
      pausedControl,
    );
    await expect(routineStore.getRoutine(routine.id)).resolves.toEqual(
      pausedRoutine,
    );
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
      control: { arcRunId, status: "running" },
    });
    await waitFor(async () =>
      (await collectAsync(workEventStore.listEvents(arcRunId))).some(
        (event) => event.kind === "run:completed",
      ),
    );

    const events = await collectAsync(workEventStore.listEvents(arcRunId));
    expect(events).toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({
        kind: "routine:started",
        routineId: routine.id,
      }),
      expect.objectContaining({
        kind: "control:pause-requested",
        routineId: routine.id,
      }),
      expect.objectContaining({
        kind: "control:paused",
        routineId: routine.id,
      }),
      expect.objectContaining({ kind: "run:started", route: "join" }),
      expect.objectContaining({
        kind: "control:resume-requested",
        routineId: routine.id,
      }),
      expect.objectContaining({
        kind: "control:resumed",
        routineId: routine.id,
      }),
      expect.objectContaining({
        kind: "routine:started",
        routineId: routine.id,
      }),
      expect.objectContaining({
        kind: "routine:finished",
        routineId: routine.id,
      }),
      expect.objectContaining({ kind: "run:completed" }),
    ]);
  });

  it("maps RoutinePausedError to a paused interrupt through the in-process adapter", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => {
          throw new RoutinePausedError();
        },
      },
    });

    const { routine } = await settleFirstRoutine(workerHub, routineStore);

    expect(routine).toMatchObject({ status: "paused" });
  });

  it("exec.resume rebuilds a paused routine whose worker is gone", async () => {
    const { arcHost, routineStore, workEvents, task } = await persistedRun();
    const runContext = await arcHost.getRunWorkspaceContext(task.arcRunId);
    const timestamp = "2026-07-31T00:00:00.000Z";
    const routineId = "routine:persisted-paused-claude";
    await routineStore.putRoutine({
      id: routineId,
      role: task.role,
      backend: "claude-sdk",
      arcRunId: task.arcRunId,
      status: "paused",
      task,
      updatedAt: timestamp,
      backendDetails: {
        backend: "claude-sdk",
        sessionKey: workerContextKey(task, 0),
        sessionId: "session-before-reconstruction",
        cwd: runContext.workspacePath,
        model: "claude-opus-4-7",
      },
    });
    await routineStore.putExecutionControl({
      arcRunId: task.arcRunId,
      status: "paused",
      pausedAt: timestamp,
      pausedRoutineId: routineId,
      pausedRoutineOrigin: "routine-start",
      updatedAt: timestamp,
    });
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      claudeStreamingQuery(params),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
    });

    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
      control: { status: "running" },
    });
    await waitFor(async () =>
      (await collectAsync(routineStore.listRoutines(task.arcRunId))).some(
        (routine) => routine.id !== routineId && routine.status === "finished",
      ),
    );
    await expect(routineStore.getRoutine(routineId)).resolves.toMatchObject({
      status: "skipped",
      error: { code: "execution-lost" },
    });
    const rebuilt = (
      await collectAsync(routineStore.listRoutines(task.arcRunId))
    ).find((routine) => routine.id !== routineId);
    expect(taskId(rebuilt!.task)).toBe(taskId(task));
    const controlEvents = (
      await collectAsync(workEvents.store.listEvents(task.arcRunId))
    ).filter(
      (event) =>
        event.kind === "control:resume-requested" ||
        event.kind === "control:resumed",
    );
    expect(controlEvents).toHaveLength(2);
    for (const event of controlEvents)
      expect(event).not.toHaveProperty("routineId");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("arms an SDK pause handle and records an in-turn parked routine", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const parkedState = {
      _currentTurnInProgress: false,
    } as OpenAiRunState;
    let releasePause!: () => void;
    const pauseRequested = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      if (run.mock.calls.length === 1) {
        await pauseRequested;
        expect(await input.checkSignal()).toEqual({ kind: "pause" });
        input.abortController.abort();
        return {
          signal: { kind: "pause" },
          cancelled: true,
          state: parkedState,
        };
      }
      expect(input.resumeState).toBe(parkedState);
      expect(input.prompt).toBeUndefined();
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-resumed", state: parkedState };
    });
    const info = vi.fn();
    const logger: ArcadeLogger = {
      level: "debug",
      format: "json",
      info,
      debug: vi.fn(),
    };
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      openAiSdk: { apiKey: "sk-test", run },
      logger,
    });

    const { arcRunId, routine } = await startFirstRoutine(
      workerHub,
      routineStore,
    );
    await waitFor(() => run.mock.calls.length === 1);
    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId, status: "pauseRequested" },
    });
    releasePause();
    await waitFor(
      async () =>
        (await routineStore.getRoutine(routine.id))?.status === "paused",
    );
    await expect(
      routineStore.getExecutionControl(arcRunId),
    ).resolves.toMatchObject({
      status: "paused",
      pausedRoutineId: routine.id,
      pausedRoutineOrigin: "in-turn",
    });

    await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
    });
    await expect(routineStore.getRoutine(routine.id)).resolves.toMatchObject({
      status: "running",
    });
    await waitFor(() => {
      if (run.mock.calls.length === 2) return true;
      if (
        info.mock.calls.filter(
          ([event]) => event === "worker_hub.routine.selected",
        ).length >= 2
      ) {
        return true;
      }
      return info.mock.calls.some(
        ([event]) => event === "worker_hub.routine.resume.failed",
      );
    });
    expect(
      info.mock.calls.filter(
        ([event]) => event === "worker_hub.routine.selected",
      ),
    ).toHaveLength(2);
    expect(info).not.toHaveBeenCalledWith(
      "worker_hub.routine.resume.failed",
      expect.anything(),
    );
    await waitFor(async () => {
      const updated = await routineStore.getRoutine(routine.id);
      return updated?.status === "finished";
    });
    await expect(routineStore.getRoutine(routine.id)).resolves.toMatchObject({
      error: undefined,
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("treats requestPause on a capacity-limited run as a no-op", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const run = vi.fn<OpenAiSdkRunFn>(async () => {
      throw Object.assign(new Error("You exceeded your current quota."), {
        status: 429,
        code: "insufficient_quota",
      });
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      openAiSdk: { apiKey: "sk-test", run },
      // Enable auto-retry to prove a hard token usage limit still never schedules.
      capacityRetry: { enabled: true },
    });

    const { arcRunId, routine } = await settleFirstRoutine(
      workerHub,
      routineStore,
    );
    expect(routine.status).toBe("capacity-limited");
    const blocked = await routineStore.getExecutionControl(arcRunId);
    expect(blocked).toMatchObject({
      status: "capacity-limited",
      capacityReason: { reason: "token usage limit" },
    });
    // A hard quota limit is not auto-retried, so the view omits autoRetry.
    const view = await workerHub.getExecutionControlView(arcRunId);
    expect("autoRetry" in view ? view.autoRetry : undefined).toBeUndefined();

    // A pause request on an already-parked run must not overwrite the
    // capacity-limited pointer.
    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "not-running",
      control: { status: "capacity-limited" },
    });
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual(
      blocked,
    );
  });

  it.each(["capacity-limited", "transport-lost"] as const)(
    "park.manual-resume is not ready for a %s park until its continuation is stored",
    async (status) => {
      const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
      const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
        if (run.mock.calls.length === 1) throw parkError(status);
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
        return { lastResponseId: "resp-after-park" };
      });
      const { workerHub, routineStore } = makeWorkerHub({
        arcHost,
        workerSlots: { roles: { researcher: "openai-sdk" } },
        openAiSdk: { apiKey: "sk-test", run },
      });
      // Resume as the park is announced, before its results are routed.
      let early: Promise<ResumeResult> | undefined;
      workerHub.registerWorkEventHandler((event) => {
        if (event.kind === `routine:${status}`)
          early ??= workerHub.resume(event.arcRunId);
      });

      const { arcRunId } = await settleFirstRoutine(workerHub, routineStore);
      await waitFor(() => early !== undefined);
      await expect(early).resolves.toMatchObject({
        outcome: "not-ready",
        control: { status },
      });
      expect(run).toHaveBeenCalledTimes(1);

      await waitFor(() => workerHub.getLiveWorkCounts().continuations === 1);
      await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
        outcome: "resumed",
      });
      await waitFor(
        async () =>
          (await collectAsync(routineStore.listRoutines(arcRunId)))[0]
            ?.status === "finished",
      );
      expect(run).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["capacity-limited", "transport-lost"] as const)(
    "park.manual-resume rebuilds a %s park after a restart",
    async (status) => {
      const { arcHost, routineStore, task } = await persistedRun();
      const timestamp = "2026-07-31T00:00:00.000Z";
      const routineId = "routine:parked-before-restart";
      await routineStore.putRoutine({
        id: routineId,
        role: task.role,
        backend: "openai-sdk",
        arcRunId: task.arcRunId,
        status,
        task,
        updatedAt: timestamp,
      });
      await routineStore.putExecutionControl(
        status === "capacity-limited"
          ? {
              arcRunId: task.arcRunId,
              status,
              capacityLimitedAt: timestamp,
              capacityLimitedRoutineId: routineId,
              capacityReason: {
                reason: "api rate limit",
                provider: "openai",
                backend: "openai-sdk",
                message: "Rate limit reached.",
              },
              updatedAt: timestamp,
            }
          : {
              arcRunId: task.arcRunId,
              status,
              transportLostAt: timestamp,
              transportLostRoutineId: routineId,
              transportReason: {
                reason: "connection reset",
                backend: "openai-sdk",
                message: "socket hang up",
              },
              updatedAt: timestamp,
            },
      );
      const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
      const { workerHub } = makeWorkerHub({
        arcHost,
        routineStore,
        workers: { researcher: worker },
      });

      await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
        outcome: "resumed",
        control: { status: "running" },
      });
      await waitFor(() => worker.mock.calls.length === 1);
      await expect(routineStore.getRoutine(routineId)).resolves.toMatchObject({
        status: "skipped",
        error: { code: "execution-lost" },
      });
    },
  );

  it("treats requestPause on a transport-lost run as a no-op", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const run = vi.fn<OpenAiSdkRunFn>(async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      openAiSdk: { apiKey: "sk-test", run },
      // Auto-retry disabled so the run stays parked for the no-op assertion.
      capacityRetry: { enabled: false },
    });

    const { arcRunId, routine } = await settleFirstRoutine(
      workerHub,
      routineStore,
    );
    expect(routine.status).toBe("transport-lost");
    const parked = await routineStore.getExecutionControl(arcRunId);
    expect(parked).toMatchObject({
      status: "transport-lost",
      transportReason: { reason: "connection reset", backend: "openai-sdk" },
    });

    // A pause request on an already-parked run must not overwrite the
    // transport-lost pointer.
    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "not-running",
      control: { status: "transport-lost" },
    });
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual(
      parked,
    );
  });

  it("refuses to resume a run that was never paused", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => {
          await gate;
          return { outcome: "completed" };
        },
      },
    });
    try {
      const { arcRunId } = await startFirstRoutine(workerHub, routineStore);
      const begin = vi.spyOn(arcHost, "begin");

      // Nothing ever requested a pause and the routine is still running, so
      // there is no pause for a resume to lift.
      await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
        outcome: "not-paused",
        control: { arcRunId, status: "running" },
      });
      expect(begin).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it("reports a repeated pause request on the same run as a duplicate", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let releaseFirst!: () => void;
    const firstBoundary = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = vi.fn(async () => {
      await firstBoundary;
      throw new RoutinePausedError();
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: handler },
    });

    const { arcRunId, routine } = await startFirstRoutine(
      workerHub,
      routineStore,
    );

    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId, status: "pauseRequested" },
    });
    const requested = await routineStore.getExecutionControl(arcRunId);

    // The second request is refused before it can re-stamp the control, so the
    // original request time survives and the pause is not restarted.
    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "duplicate-request",
      control: { arcRunId, status: "pauseRequested" },
    });
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual(
      requested,
    );

    releaseFirst();
    await waitFor(
      async () =>
        (await routineStore.getRoutine(routine.id))?.status === "paused",
    );
  });

  it("pauses a quiescent run with no routine id and resumes it back to draining", async () => {
    const time = makeControlledTime();
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
      ...time,
    });
    // The run rests on a sleep between its two routines.
    await arcHost.registerArc(
      "watch",
      parse(`"arc";
import Time from "host:time";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  $instruct(\`Watch for updates.\`);
  Time.$sleep(50);
  $instruct(\`Report the updates.\`);
}`),
    );
    const handler = vi.fn(async () => ({ outcome: "completed" as const }));
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: handler },
    });

    const { arcRunId } = await settleFirstRoutine(workerHub, routineStore);
    await waitFor(async () =>
      (await collectAsync(workEventStore.listEvents(arcRunId))).some(
        (event) => event.kind === "routine:finished",
      ),
    );

    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId, status: "paused" },
    });
    // With nothing running the run pauses outright, and the stored control
    // names no routine because there is none to point at.
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual({
      arcRunId,
      status: "paused",
      pausedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const pausedEvents = (
      await collectAsync(workEventStore.listEvents(arcRunId))
    ).filter((event) => event.kind === "control:paused");
    expect(pausedEvents).toHaveLength(1);
    expect(pausedEvents[0]).not.toHaveProperty("routineId");

    const pausedControl = await routineStore.getExecutionControl(arcRunId);
    await attachToActiveRun(workerHub, arcRunId);
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual(
      pausedControl,
    );
    // The paused run holds its due sleep outcome until resume.
    time.advanceTo(1050);
    time.fireDue();
    expect(handler).toHaveBeenCalledTimes(1);

    // Resume has no paused routine to continue, so it clears the pause state
    // and lets normal draining take over again.
    await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
      control: { arcRunId, status: "running" },
    });
    await waitFor(async () => {
      const routines = await collectAsync(routineStore.listRoutines(arcRunId));
      return (
        routines.length === 2 &&
        routines.every((routine) => routine.status === "finished")
      );
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("pauses a routine waiting for its worker context before it starts", async () => {
    const time = makeControlledTime();
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
      ...time,
    });
    // A caught timeout reissues the work into the same context while the
    // superseded routine still holds it.
    await arcHost.registerArc(
      "watch",
      parse(`"arc";
import Time from "host:time";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  this.catchInterruption = () => true;
  Time.$addTimeout(25);
  $instruct(\`Watch for updates.\`);
}`),
    );
    let releaseFirst!: () => void;
    const firstBoundary = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const handler = vi.fn<RoleWorker>(async () => {
      if (handler.mock.calls.length === 1) await firstBoundary;
      return { outcome: "completed" };
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: handler },
    });

    const { arcRunId } = await startFirstRoutine(workerHub, routineStore);
    await waitFor(() => handler.mock.calls.length === 1);
    time.advanceTo(1025);
    time.fireDue();
    await waitFor(
      async () =>
        (await collectAsync(routineStore.listRoutines(arcRunId))).length === 2,
    );
    await expect(workerHub.requestPause(arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId, status: "pauseRequested" },
    });

    releaseFirst();
    // Acquiring the context, the waiting routine checks the pause first and
    // parks at its start boundary instead of entering the worker.
    let waiting: RoutineState | undefined;
    await waitFor(async () => {
      waiting = (await collectAsync(routineStore.listRoutines(arcRunId)))[1];
      return waiting?.status === "paused";
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

const INTERRUPTED_SOURCE = `"arc"; import Time from "host:time"; function Main() { this.trigger = () => true; Time.$addTimeout(25); $instruct("work"); }`;

const RESTING_SOURCE = `"arc";
import Time from "host:time";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  $instruct(\`Watch for updates.\`);
  Time.$sleep(50);
  $instruct(\`Report the updates.\`);
}`;

describe("Host and hub parks and rebuilds", () => {
  it("exec.view reads stored control while a run has live work", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => {
          await gate;
          return { outcome: "completed" };
        },
      },
    });
    try {
      const { arcRunId } = await startFirstRoutine(workerHub, routineStore);
      await expect(
        workerHub.getExecutionControlView(arcRunId),
      ).resolves.toMatchObject({ status: "running" });
      await workerHub.requestPause(arcRunId);
      await expect(
        workerHub.getExecutionControlView(arcRunId),
      ).resolves.toMatchObject({ status: "pauseRequested" });
    } finally {
      release();
    }
  });

  it("exec.view reads a run this hub activated as running at activation", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: async () => ({ outcome: "completed" }) },
    });
    const views: string[] = [];
    for await (const event of workerHub.submitInbound({
      content: "start",
      metadata: { principal: ALICE_OWNER },
    })) {
      if (event.kind === "activated")
        views.push(
          (await workerHub.getExecutionControlView(event.arcRunId)).status,
        );
    }
    expect(views).toEqual(["running"]);
  });

  it("exec.view reads uncaught-interruption in process and hub-restarted after a restart", async () => {
    const durable = durableStores();
    const arcHost = await hostOver(durable, INTERRUPTED_SOURCE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore: durable.historyStore,
      workers: {
        "$default-worker": async () => {
          await gate;
          return { outcome: "completed" };
        },
      },
    });
    try {
      const arcRunId = await submitActivation(workerHub, "start");
      await waitFor(
        async () =>
          (await collectAsync(durable.routineStore.listRoutines(arcRunId)))
            .length === 1,
      );
      durable.time.advanceTo(1025);
      durable.time.fireDue();
      await waitFor(
        async () =>
          (await workerHub.getExecutionControlView(arcRunId)).status ===
          "uncaught-interruption",
      );
      const view = await workerHub.getExecutionControlView(arcRunId);
      expect(view).toEqual({
        arcRunId,
        status: "uncaught-interruption",
        interruption: { id: expect.any(String), reason: expect.any(String) },
        updatedAt: expect.any(String),
      });
      await expect(workerHub.requestPause(arcRunId)).resolves.toEqual({
        outcome: "not-running",
        // Without stored control, each read stamps its own updatedAt.
        control: { ...view, updatedAt: expect.any(String) },
      });

      const restarted = makeWorkerHub({
        arcHost: await hostOver(durable, INTERRUPTED_SOURCE),
        historyStore: durable.historyStore,
      });
      await expect(
        restarted.workerHub.getExecutionControlView(arcRunId),
      ).resolves.toEqual({
        arcRunId,
        status: "hub-restarted",
        updatedAt: expect.any(String),
      });
    } finally {
      release();
    }
  });

  it("exec.view reads internal-error after a failed lap and hub-restarted after a restart", async () => {
    const durable = durableStores();
    const arcHost = await hostOver(durable, WATCH_SOURCE);
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore: durable.historyStore,
      workers: { researcher: async () => ({ outcome: "completed" }) },
    });
    vi.spyOn(durable.routineStore, "putRoutine").mockRejectedValueOnce(
      new Error("routine store unavailable"),
    );

    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(
      async () =>
        (await workerHub.getExecutionControlView(arcRunId)).status ===
        "internal-error",
    );
    const view = await workerHub.getExecutionControlView(arcRunId);
    expect(view).toEqual({
      arcRunId,
      status: "internal-error",
      error: { message: "routine store unavailable" },
      failedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    await expect(workerHub.requestPause(arcRunId)).resolves.toEqual({
      outcome: "not-running",
      // Without stored control, each read stamps its own updatedAt.
      control: { ...view, updatedAt: expect.any(String) },
    });

    const restarted = makeWorkerHub({
      arcHost: await hostOver(durable, WATCH_SOURCE),
      historyStore: durable.historyStore,
    });
    await expect(
      restarted.workerHub.getExecutionControlView(arcRunId),
    ).resolves.toMatchObject({ status: "hub-restarted" });
  });

  it("exec.resume rebuilds a run left running at a restart and skips its stale routine", async () => {
    const { arcHost, routineStore, task } = await persistedRun(RESTING_SOURCE);
    const staleId = "routine:running-before-restart";
    await routineStore.putRoutine({
      id: staleId,
      role: task.role,
      backend: "in-process",
      arcRunId: task.arcRunId,
      status: "running",
      task,
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workers: { researcher: worker },
    });

    const view = await workerHub.getExecutionControlView(task.arcRunId);
    expect(view).toMatchObject({ status: "hub-restarted" });
    expect(view).not.toHaveProperty("autoRetry");
    await expect(workerHub.requestPause(task.arcRunId)).resolves.toEqual({
      outcome: "not-running",
      // Without stored control, each read stamps its own updatedAt.
      control: { ...view, updatedAt: expect.any(String) },
    });

    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
    });
    await waitFor(() => worker.mock.calls.length === 1);
    await expect(routineStore.getRoutine(staleId)).resolves.toMatchObject({
      status: "skipped",
      error: { code: "execution-lost" },
    });
    await waitFor(async () =>
      (await collectAsync(routineStore.listRoutines(task.arcRunId))).every(
        (routine) => routine.status !== "running",
      ),
    );

    // Resting on its sleep with no stale running records, the run pauses
    // outright.
    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { status: "paused" },
    });
  });

  it("exec.resume rebuilds a run left pause-requested at a restart", async () => {
    const { arcHost, routineStore, task } = await persistedRun();
    await routineStore.putExecutionControl({
      arcRunId: task.arcRunId,
      status: "pauseRequested",
      requestedAt: "2026-07-31T00:00:00.000Z",
      updatedAt: "2026-07-31T00:00:00.000Z",
    });
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workers: { researcher: worker },
    });

    await expect(
      workerHub.getExecutionControlView(task.arcRunId),
    ).resolves.toMatchObject({ status: "hub-restarted" });
    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
      control: { status: "running" },
    });
    await waitFor(() => worker.mock.calls.length === 1);
  });

  it("exec.resume clears internal-error and rebuilds the failed run", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });
    vi.spyOn(routineStore, "putRoutine").mockRejectedValueOnce(
      new Error("routine store unavailable"),
    );
    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(
      async () =>
        (await workerHub.getExecutionControlView(arcRunId)).status ===
        "internal-error",
    );

    // A rebuild that fails again rejects, and the run reads its new failure.
    vi.spyOn(arcHost, "begin").mockRejectedValueOnce(
      new Error("arc host unavailable"),
    );
    await expect(workerHub.resume(arcRunId)).rejects.toThrow(
      "arc host unavailable",
    );
    await expect(
      workerHub.getExecutionControlView(arcRunId),
    ).resolves.toMatchObject({
      status: "internal-error",
      error: { message: "arc host unavailable" },
    });

    await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
    });
    await waitFor(() => worker.mock.calls.length === 1);
    await waitFor(
      async () =>
        (await workerHub.getExecutionControlView(arcRunId)).status ===
        "inactive",
    );
  });

  it("exec.resume dispatches once for concurrent resumes of a park without live work", async () => {
    const { arcHost, routineStore, task } = await persistedRun();
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workers: { researcher: worker },
    });

    const results = await Promise.all([
      workerHub.resume(task.arcRunId),
      workerHub.resume(task.arcRunId),
    ]);
    expect(results.map((result) => result.outcome)).toContain("resumed");
    await waitFor(async () =>
      (await collectAsync(routineStore.listRoutines(task.arcRunId))).some(
        (routine) => routine.status === "finished",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker).toHaveBeenCalledTimes(1);
  });
});

/** Durable stores that an earlier and a later process share. */
function durableStores() {
  return {
    store: new InMemoryArcHostStore(),
    routineStore: new InMemoryWorkerHubStore(),
    workEvents: new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    ),
    historyStore: new InMemoryHistoryStore(),
    time: makeControlledTime(),
  };
}

/** One process's arc host over the durable stores, with the arc registered. */
async function hostOver(
  durable: ReturnType<typeof durableStores>,
  source: string,
) {
  const arcHost = createTestArcHost({
    store: durable.store,
    executionControl: durable.routineStore,
    workEvents: durable.workEvents,
    ...durable.time,
  });
  await arcHost.registerArc("watch", parse(source));
  return arcHost;
}

/**
 * Persist an active run as an earlier process left it, then return a fresh arc
 * host over the same durable stores, as after a restart.
 */
async function persistedRun(source = WATCH_SOURCE) {
  const durable = durableStores();
  const earlier = await hostOver(durable, source);
  const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
  const [step] = await earlier.begin({
    dialog,
    inbound: { content: "start" },
    principal: ALICE_OWNER,
    projectDialog: async () => dialog,
  });
  const task = step?.kind === "action" ? step.frontier.tasks[0] : undefined;
  if (task?.kind !== "instruction")
    throw new Error("expected instruction task");
  await earlier.stop();
  return { ...durable, arcHost: await hostOver(durable, source), task };
}

/** Activate the registered arc and wait until its first routine exists. */
async function startFirstRoutine(
  workerHub: WorkerHubService,
  routineStore: WorkerHubStore,
): Promise<{ arcRunId: ArcRunId; routine: RoutineState }> {
  const arcRunId = await submitActivation(workerHub, "start");
  let routine: RoutineState | undefined;
  await waitFor(async () => {
    [routine] = await collectAsync(routineStore.listRoutines(arcRunId));
    return routine !== undefined;
  });
  return { arcRunId, routine: routine! };
}

/** A provider error the OpenAI SDK worker classifies as the given park. */
function parkError(status: "capacity-limited" | "transport-lost"): Error {
  return status === "capacity-limited"
    ? Object.assign(new Error("Rate limit reached."), {
        status: 429,
        code: "rate_limit_exceeded",
      })
    : Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
}

async function instructionTaskFromRun(): Promise<{
  arcHost: Awaited<ReturnType<typeof makeArcHostWithSource>>;
  task: InstructionTask;
}> {
  const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
  const begun = await arcHost.begin({
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    inbound: { content: "start" },
    principal: ALICE_OWNER,
    projectDialog: async () => ({
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    }),
  });
  const [step] = begun;
  if (!step || (step.kind !== "action" && step.kind !== "trigger")) {
    throw new Error("expected Arc work");
  }
  const task = step.frontier.tasks[0];
  if (!task || task.kind !== "instruction") {
    throw new Error("expected instruction task");
  }
  return { arcHost, task };
}
