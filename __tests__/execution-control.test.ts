import { parse } from "@elem-app/arc/parser";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestArcHost,
  executionControlFor,
  retainModuleEffects,
} from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import type {
  ArcadeLogger,
  ClaudeSdkQueryFn,
  InstructionTask,
  OpenAiRunState,
  OpenAiSdkRunFn,
  RoleWorker,
  RoutineContext,
} from "../src/testing.js";
import {
  arcRunKey,
  classifyTransportLoss,
  InMemoryArcHostStore,
  InMemoryReplayStore,
  RoutinePausedError,
  taskId,
  workerContextKey,
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
} from "./worker-hub-helpers.js";

import { beginActivatedDriver, beginDriver } from "./arc-host-helpers.js";

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
      for (const id of [task.arcRunId, "unknown-run"]) {
        expect(await routineStore.getExecutionControl(id)).toBeUndefined();
        await expect(
          workerHub.getExecutionControlView(id),
        ).resolves.toMatchObject({ status: "running", arcRunId: id });
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

  it("exec.control-inactive keeps interrupted active runs eligible for explicit host continuation", async () => {
    const store = new InMemoryArcHostStore();
    const time = makeControlledTime();
    const host = createTestArcHost({ store, ...time });
    await host.registerArc(
      "interrupted-control",
      parse(
        `"arc"; import Time from "host:time"; function Main() { this.trigger = () => true; Time.$addTimeout(25); $instruct("work"); }`,
      ),
    );
    const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(host, dialog);
    const before = (await store.getState(arcRunKey(driver.arcRunId)))!;
    time.advanceTo(1025);
    time.fireDue();
    await driver.deliverEffects({ dialog });
    const interrupted = (await store.getState(arcRunKey(driver.arcRunId)))!;
    expect(interrupted.lifecycle).toBe("active");
    expect(interrupted.traversals[0]?.state).toBe("interrupted");
    const { workerHub } = makeWorkerHub({ arcHost: host });
    const begin = vi.spyOn(host, "begin");
    try {
      await expect(
        workerHub.getExecutionControlView(driver.arcRunId),
      ).resolves.toMatchObject({ status: "running" });
      await expect(workerHub.resume(driver.arcRunId)).resolves.toMatchObject({
        outcome: "not-paused",
      });
      expect(begin).not.toHaveBeenCalled();
      vi.spyOn(workerHub, "enqueueModuleEffect").mockImplementation(
        (arcRunId, effect, signal) =>
          retainModuleEffects(host, [{ arcRunId, effect, signal }]),
      );
      const step = await beginDriver(host, driver.arcRunId, dialog);
      expect(step.frontier.tasks).toHaveLength(1);
      expect(taskId(step.frontier.tasks[0]!)).toBe(
        taskId(driver.frontier.tasks[0]!),
      );
      expect(
        (await store.getState(arcRunKey(driver.arcRunId)))?.reactivationCount,
      ).toBe(before.reactivationCount);
    } finally {
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
    const { arcHost, task } = await instructionTaskFromRun();
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
        expect(context.routineResume).toEqual({
          message: "Continue",
          delivery: "rendered-context",
        });
      }
      return { outcome: "completed" as const };
    });
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: handler },
      logger,
    });

    const runContext = await arcHost.getRunWorkspaceContext(task.arcRunId);
    const running = workerHub.handleTask(task, {
      ...routineContext(task),
      workspacePath: runContext.workspacePath,
      workspaceBundle: runContext.workspaceBundle,
    });
    await waitFor(async () => {
      const routines = await collectAsync(routineStore.listRoutines());
      return routines.length === 1;
    });
    const [routine] = await collectAsync(routineStore.listRoutines());
    if (!routine) throw new Error("expected routine");

    await expect(workerHub.requestPause("run:not-this-one")).resolves.toEqual({
      outcome: "missing",
      arcRunId: "run:not-this-one",
    });

    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId: task.arcRunId, status: "pauseRequested" },
    });
    expect(info).toHaveBeenCalledWith("worker_hub.pause.requested", {
      arcRunId: task.arcRunId,
      status: "pauseRequested",
    });
    releaseFirst();
    await expect(running).resolves.toMatchObject({
      status: "queued",
      routineId: routine.id,
    });
    await expect(routineStore.getRoutine(routine.id)).resolves.toMatchObject({
      id: routine.id,
      status: "paused",
    });
    expect(info).toHaveBeenCalledWith("worker_hub.pause.paused", {
      arcRunId: task.arcRunId,
      status: "paused",
    });

    const pausedControl = await routineStore.getExecutionControl(task.arcRunId);
    const pausedRoutine = await routineStore.getRoutine(routine.id);
    await attachToActiveRun(workerHub, task.arcRunId);
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual(pausedControl);
    await expect(routineStore.getRoutine(routine.id)).resolves.toEqual(
      pausedRoutine,
    );
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
      control: { arcRunId: task.arcRunId, status: "running" },
    });
    await waitFor(async () => {
      const updated = await routineStore.getRoutine(routine.id);
      return updated?.status === "finished";
    });

    const events = await collectAsync(workEventStore.listEvents(task.arcRunId));
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
    ]);
  });

  it("maps RoutinePausedError to a paused interrupt through the in-process adapter", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => {
          throw new RoutinePausedError();
        },
      },
    });

    const result = await workerHub.handleTask(task, routineContext(task));

    expect(result).toMatchObject({ status: "queued" });
    const routines = await collectAsync(
      routineStore.listRoutines(task.arcRunId),
    );
    expect(routines[0]).toMatchObject({ status: "paused" });
  });

  it("keeps a reconstructed paused routine parked without its captured worker", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const routineStore = executionControlFor(arcHost);
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
      outcome: "not-ready",
      control: { status: "paused", pausedRoutineId: routineId },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("arms an SDK pause handle and records an in-turn parked routine", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
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

    const running = workerHub.handleTask(task, routineContext(task));
    await waitFor(() => run.mock.calls.length === 1);
    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId: task.arcRunId, status: "pauseRequested" },
    });
    releasePause();
    await expect(running).resolves.toMatchObject({ status: "queued" });
    const [routine] = await collectAsync(routineStore.listRoutines());
    if (!routine) throw new Error("expected routine");
    await expect(routineStore.getRoutine(routine.id)).resolves.toMatchObject({
      status: "paused",
    });
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toMatchObject({
      status: "paused",
      pausedRoutineId: routine.id,
      pausedRoutineOrigin: "in-turn",
    });

    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
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
    const { arcHost, task } = await instructionTaskFromRun();
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

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "queued" });
    const blocked = await routineStore.getExecutionControl(task.arcRunId);
    expect(blocked).toMatchObject({
      status: "capacity-limited",
      capacityReason: { reason: "token usage limit" },
    });
    // A hard quota limit is not auto-retried, so the view omits autoRetry.
    const view = await workerHub.getExecutionControlView(task.arcRunId);
    expect("autoRetry" in view ? view.autoRetry : undefined).toBeUndefined();

    // A pause request on an already-parked run must not overwrite the
    // capacity-limited pointer.
    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "not-running",
      control: { status: "capacity-limited" },
    });
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual(blocked);
  });

  it("keeps a capacity-limited run parked when resume finds no stored continuation", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const run = vi.fn<OpenAiSdkRunFn>(async () => {
      throw Object.assign(new Error("Rate limit reached."), {
        status: 429,
        code: "rate_limit_exceeded",
      });
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      openAiSdk: { apiKey: "sk-test", run },
    });

    // The direct handleTask path parks the routine without routing through the
    // queue, so no #pausedContinuations entry is ever stored — exactly the
    // emit-before-store race / post-restart shape.
    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "queued" });
    const blocked = await routineStore.getExecutionControl(task.arcRunId);
    expect(blocked).toMatchObject({ status: "capacity-limited" });

    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "not-ready",
      control: { status: "capacity-limited" },
    });
    // Control is untouched and the backend was not re-run.
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual(blocked);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("treats requestPause on a transport-lost run as a no-op", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
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

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "queued" });
    const parked = await routineStore.getExecutionControl(task.arcRunId);
    expect(parked).toMatchObject({
      status: "transport-lost",
      transportReason: { reason: "connection reset", backend: "openai-sdk" },
    });

    // A pause request on an already-parked run must not overwrite the
    // transport-lost pointer.
    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "not-running",
      control: { status: "transport-lost" },
    });
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual(parked);
  });

  it("keeps a transport-lost run parked when resume finds no stored continuation", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const run = vi.fn<OpenAiSdkRunFn>(async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      openAiSdk: { apiKey: "sk-test", run },
      // Auto-retry disabled so the only resume path is the manual one under test.
      capacityRetry: { enabled: false },
    });

    // The direct handleTask path parks the routine without routing through the
    // queue, so no #pausedContinuations entry is ever stored — exactly the
    // emit-before-store race / post-restart shape.
    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "queued" });
    const parked = await routineStore.getExecutionControl(task.arcRunId);
    expect(parked).toMatchObject({ status: "transport-lost" });

    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "not-ready",
      control: { status: "transport-lost" },
    });
    // Control is untouched and the backend was not re-run.
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual(parked);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses to resume a run that was never paused", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: async () => ({ outcome: "completed" }) },
    });

    // Nothing ever requested a pause, so the run carries the implicit running
    // state and there is no pause for a resume to lift.
    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "not-paused",
      control: { arcRunId: task.arcRunId, status: "running" },
    });
  });

  it("reports a repeated pause request on the same run as a duplicate", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
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

    const running = workerHub.handleTask(task, routineContext(task));
    await waitFor(async () => {
      const routines = await collectAsync(routineStore.listRoutines());
      return routines.length === 1;
    });

    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId: task.arcRunId, status: "pauseRequested" },
    });
    const requested = await routineStore.getExecutionControl(task.arcRunId);

    // The second request is refused before it can re-stamp the control, so the
    // original request time survives and the pause is not restarted.
    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "duplicate-request",
      control: { arcRunId: task.arcRunId, status: "pauseRequested" },
    });
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual(requested);

    releaseFirst();
    await expect(running).resolves.toMatchObject({ status: "queued" });
  });

  it("pauses a quiescent run with no routine id and resumes it back to draining", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const handler = vi.fn(async () => ({ outcome: "completed" as const }));
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: handler },
    });

    // Drain the only routine first so the request lands between routines.
    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "finished" });

    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId: task.arcRunId, status: "paused" },
    });
    // With nothing running the run pauses outright, and the stored control
    // names no routine because there is none to point at.
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual({
      arcRunId: task.arcRunId,
      status: "paused",
      pausedAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const pausedEvents = (
      await collectAsync(workEventStore.listEvents(task.arcRunId))
    ).filter((event) => event.kind === "control:paused");
    expect(pausedEvents).toHaveLength(1);
    expect(pausedEvents[0]).not.toHaveProperty("routineId");

    const pausedControl = await routineStore.getExecutionControl(task.arcRunId);
    await attachToActiveRun(workerHub, task.arcRunId);
    await expect(
      routineStore.getExecutionControl(task.arcRunId),
    ).resolves.toEqual(pausedControl);
    expect(handler).toHaveBeenCalledTimes(1);

    // Resume has no paused routine to continue, so it clears the pause state
    // and lets normal draining take over again.
    await expect(workerHub.resume(task.arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
      control: { arcRunId: task.arcRunId, status: "running" },
    });
    // Resume schedules the host's pending frontier itself. Wait for that drain
    // instead of racing it with a second manual dispatch of the same work.
    await waitFor(async () => {
      const routines = await collectAsync(
        routineStore.listRoutines(task.arcRunId),
      );
      return (
        routines.length === 2 &&
        routines.every((routine) => routine.status === "finished")
      );
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("pauses a routine waiting behind the role concurrency limit before it starts", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const second = {
      ...task,
      briefIds: [`${task.briefIds[0]}:second`] as const,
    };
    let releaseFirst!: () => void;
    const firstBoundary = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const handler = vi.fn(async (current: InstructionTask) => {
      started.push(current.briefIds.join("+"));
      if (started.length === 1) await firstBoundary;
      return { outcome: "completed" as const };
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      roleConcurrency: { researcher: 1 },
      workers: { researcher: handler as unknown as RoleWorker },
    });

    const first = workerHub.handleTask(task, routineContext(task));
    await waitFor(() => started.length === 1);
    // Dispatched while the cap is full, so this one waits outside its worker.
    const waiting = workerHub.handleTask(second, routineContext(second));
    await expect(workerHub.requestPause(task.arcRunId)).resolves.toMatchObject({
      outcome: "requested",
      control: { arcRunId: task.arcRunId, status: "pauseRequested" },
    });

    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "finished" });
    // Taking the freed slot, the waiting routine checks the pause first and
    // parks at its start boundary instead of entering the worker.
    const queued = await waiting;
    expect(queued).toMatchObject({ status: "queued" });
    expect(started).toEqual([task.briefIds.join("+")]);
    expect(handler).toHaveBeenCalledTimes(1);
    const parked = await routineStore.getRoutine(
      (queued as { routineId: string }).routineId,
    );
    expect(parked).toMatchObject({ status: "paused" });
  });
});

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

function routineContext(task: InstructionTask): RoutineContext {
  return {
    workspacePath: join(tmpdir(), "arcade-execution-control-test-workspace"),
    workspaceBundle: {},
  };
}
