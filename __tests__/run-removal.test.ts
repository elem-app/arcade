import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hmd } from "@elem-app/arc/host-utils";
import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import { parseArcadeConfig } from "../src/config.js";
import {
  startArcade,
  type ArcHostStore,
  type Backend,
  type RoutineInput,
  type WorkerHost,
} from "../src/index.js";
import { routinePathSegment } from "../src/storage/routine-diagnostics.js";
import {
  arcRunKey,
  FileRoutineDiagnosticsStore,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  InMemoryReplayStore,
  InMemoryWorkerHubStore,
  InMemoryWorkEventStore,
  JsonFileArcHostStore,
  JsonFileHistoryStore,
  JsonFileReplayStore,
  JsonFileWorkerHubStore,
  JsonFileWorkEventStore,
  RoutinePausedError,
  taskId,
  type RoutineState,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  BOB_OWNER,
  collectAsync,
  deferred,
  firstTaskWithArcHost,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";
import {
  drainLifecycle,
  lifecycleReader,
  submitActivation,
} from "./worker-hub-helpers.js";

async function isFrozen(store: ArcHostStore, id: string): Promise<boolean> {
  return (await store.getState(arcRunKey(id)))?.frozen === true;
}

async function sampleRoutine(): Promise<RoutineState> {
  const { arcHost, task } = await firstTaskWithArcHost();
  await arcHost.stop();
  return {
    id: "routine:first",
    arcRunId: task.arcRunId,
    role: task.role,
    backend: "probe",
    status: "running",
    task,
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
}

function options(root: string, file: boolean, backend?: Backend) {
  return {
    config: parseArcadeConfig(
      JSON.stringify({
        dataDir: root,
        logging: { level: "silent" },
        workers: {
          roles: { researcher: { backend: "probe" } },
          fastTrigger: null,
        },
      }),
      "test",
    ),
    backends: {
      probe: backend ?? {
        supportedSlotKinds: new Set<"role">(["role"]),
        createWorker: () => ({
          run: async () => ({ outcome: "completed" as const }),
          disposeRoutine: async () => {},
        }),
      },
    },
    arcHostStore: file
      ? new JsonFileArcHostStore({ dir: join(root, "host") })
      : new InMemoryArcHostStore(),
    workerHubStore: file
      ? new JsonFileWorkerHubStore({ dir: join(root, "hub") })
      : new InMemoryWorkerHubStore(),
    historyStore: file
      ? new JsonFileHistoryStore({ dir: join(root, "history") })
      : new InMemoryHistoryStore(),
    replayStore: file
      ? new JsonFileReplayStore({ dir: join(root, "replay") })
      : new InMemoryReplayStore(),
    workEventStore: file
      ? new JsonFileWorkEventStore({ dir: join(root, "events") })
      : new InMemoryWorkEventStore(),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(root, "diagnostics"),
    ),
  };
}

describe("run removal", () => {
  it("removes a file-backed run with unreadable routine payloads and preserves its sibling bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-corrupt-"));
    const opts = options(root, true);
    const arcade = await startArcade(opts);
    try {
      await arcade.arcHost.registerArc("watch", parse(WATCH_SOURCE));
      const activate = async (owner: string) => {
        const id = await submitActivation(arcade.workerHub, "start", owner);
        await waitFor(
          async () =>
            (await opts.arcHostStore.getState(arcRunKey(id)))?.lifecycle ===
            "completed",
        );
        return id;
      };
      const target = await activate(ALICE_OWNER);
      const sibling = await activate(BOB_OWNER);
      const targetRoutines = await collectAsync(
        opts.workerHubStore.listRoutines(target),
      );
      const siblingRoutines = await collectAsync(
        opts.workerHubStore.listRoutines(sibling),
      );
      expect(targetRoutines.length).toBeGreaterThan(0);
      expect(siblingRoutines.length).toBeGreaterThan(0);
      const payload = (id: string) =>
        join(root, "hub", "routines", `${encodeURIComponent(id)}.json`);
      const registry = (run: string) =>
        join(
          root,
          "hub",
          "routines-by-run",
          `${encodeURIComponent(arcRunKey(run))}.json`,
        );
      const siblingFile = payload(siblingRoutines[0]!.id);
      const siblingRegistry = await readFile(registry(sibling));
      await writeFile(siblingFile, "{malformed sibling");
      expect(
        await collectAsync(opts.workerHubStore.listRoutines(target)),
      ).toEqual(targetRoutines);
      await writeFile(payload(targetRoutines[0]!.id), "{malformed target");

      expect(await arcade.workerHub.removeRun(target)).toEqual({
        outcome: "removed",
        arcRunId: target,
      });
      for (const routine of targetRoutines)
        await expect(stat(payload(routine.id))).rejects.toMatchObject({
          code: "ENOENT",
        });
      await expect(stat(registry(target))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(siblingFile, "utf8")).toBe("{malformed sibling");
      expect(await readFile(registry(sibling))).toEqual(siblingRegistry);
    } finally {
      await arcade.stop();
    }
  });

  it("starts, persists progress, and removes a run with a malformed sibling routine registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-isolated-registry-"));
    const dir = join(root, "hub", "routines-by-run");
    const sibling = join(
      dir,
      `${encodeURIComponent(arcRunKey("arc-run:sibling"))}.json`,
    );
    await mkdir(dir, { recursive: true });
    await writeFile(sibling, "{malformed sibling registry");

    const opts = options(root, true);
    const arcade = await startArcade(opts);
    try {
      await arcade.arcHost.registerArc("watch", parse(WATCH_SOURCE));
      const id = await submitActivation(arcade.workerHub, "start", ALICE_OWNER);
      await waitFor(
        async () =>
          (await opts.arcHostStore.getState(arcRunKey(id)))?.lifecycle ===
          "completed",
      );
      const routines = await collectAsync(opts.workerHubStore.listRoutines(id));
      expect(routines).toContainEqual(
        expect.objectContaining({ arcRunId: id, status: "finished" }),
      );
      expect(await arcade.workerHub.removeRun(id)).toEqual({
        outcome: "removed",
        arcRunId: id,
      });
      for (const routine of routines)
        expect(
          await opts.workerHubStore.getRoutine(routine.id),
        ).toBeUndefined();
      expect(await readFile(sibling, "utf8")).toBe(
        "{malformed sibling registry",
      );
    } finally {
      await arcade.stop();
    }
  });

  it("retains concurrent routine inserts and reopens one run registry without rewriting it on status updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-routine-inserts-"));
    const store = new JsonFileWorkerHubStore({ dir });
    const first = await sampleRoutine();
    const second = { ...first, id: "routine:second" };
    const sibling = {
      ...first,
      arcRunId: "other",
      id: "routine:sibling",
      task: { ...first.task, arcRunId: "other" },
    };
    const secondHandle = new JsonFileWorkerHubStore({ dir });
    await Promise.all([
      store.putRoutine(first),
      secondHandle.putRoutine(second),
      store.putRoutine(sibling),
    ]);
    const registry = join(
      dir,
      "routines-by-run",
      `${encodeURIComponent(arcRunKey(first.arcRunId))}.json`,
    );
    const { ino } = await stat(registry);
    const updated = { ...first, status: "finished" as const };
    await store.putRoutine(updated);
    expect((await stat(registry)).ino).toBe(ino);
    const reopened = new JsonFileWorkerHubStore({ dir });
    expect(await reopened.getRoutine(first.id)).toEqual(updated);
    expect(
      new Set(await collectAsync(reopened.listRoutines(first.arcRunId))),
    ).toEqual(new Set([updated, second]));
    expect(new Set(await collectAsync(reopened.listRoutines()))).toEqual(
      new Set([updated, second, sibling]),
    );

    const siblingRegistry = join(
      dir,
      "routines-by-run",
      `${encodeURIComponent(arcRunKey(sibling.arcRunId))}.json`,
    );
    await writeFile(siblingRegistry, "{bad sibling registry");
    const cold = new JsonFileWorkerHubStore({ dir });
    await cold.deleteRunData(first.arcRunId);
    expect(await cold.getRoutine(sibling.id)).toEqual(sibling);
    expect(await readFile(siblingRegistry, "utf8")).toBe(
      "{bad sibling registry",
    );
  });

  it("retries an interrupted routine insert and a partial file cleanup after reopening the store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-routine-recovery-"));
    const store = new JsonFileWorkerHubStore({ dir });
    const first = await sampleRoutine();
    const second = { ...first, id: "routine:second" };
    const payload = (id: string) =>
      join(dir, "routines", `${encodeURIComponent(id)}.json`);
    await store.putRoutine(first);
    // Block the second payload's atomic write after its registry entry commits.
    await mkdir(`${payload(second.id)}.tmp`);
    await expect(store.putRoutine(second)).rejects.toMatchObject({
      code: "EISDIR",
    });
    await rm(`${payload(second.id)}.tmp`, { recursive: true });
    const reopened = new JsonFileWorkerHubStore({ dir });
    expect(await collectAsync(reopened.listRoutines(first.arcRunId))).toEqual([
      first,
    ]);
    await reopened.putRoutine(second);
    expect(await collectAsync(reopened.listRoutines(first.arcRunId))).toEqual([
      first,
      second,
    ]);
    // Make the second unlink fail, after the first payload has been removed.
    await rm(payload(second.id));
    await mkdir(payload(second.id));
    await expect(reopened.deleteRunData(first.arcRunId)).rejects.toThrow();
    await expect(stat(payload(first.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const retry = new JsonFileWorkerHubStore({ dir });
    await rm(payload(second.id), { recursive: true });
    await retry.deleteRunData(first.arcRunId);
    await retry.deleteRunData(first.arcRunId);
    expect(await readdir(join(dir, "routines-by-run"))).toEqual([]);
    expect(await readdir(join(dir, "routines"))).toEqual([]);
  });

  it.each(["memory", "file"])(
    "reclaims a paused run after writes settle and preserves its sibling, WorkEvents and workspace using %s storage",
    async (storage) => {
      const root = await mkdtemp(join(tmpdir(), "arcade-removal-"));
      const finish = deferred();
      const allowWrite = deferred();
      const disposed = vi.fn();
      const inputs = new Map<string, RoutineInput>();
      let workerHost!: WorkerHost;
      const opts = options(root, storage === "file", {
        supportedSlotKinds: new Set(["role"]),
        createWorker: (host) => {
          workerHost = host;
          return {
            run: async (input) => {
              const id = input.routine.arcRunId;
              await input.diagnostics.writeText("trace", "diagnostic");
              await host.state.put(id, "session", "continuity");
              inputs.set(id, input);
              await input.effects
                .emit({
                  situation: { cause: "question" },
                  content: "Continue?",
                })
                .catch(() => {});
              await finish.promise;
              if ((await input.effects.checkSignal())?.kind === "pause")
                return { suspension: "paused" };
              return { outcome: "completed" };
            },
            disposeRoutine: async ({ arcRunId }) => {
              disposed(arcRunId);
            },
          };
        },
      });
      const arcade = await startArcade(opts);
      const { workerHub: hub, arcHost } = arcade;
      const situation = { role: "*", audience: "*", cause: "*" };
      try {
        await arcHost.registerArc("watch", parse(WATCH_SOURCE));
        const id = await submitActivation(hub, "start", ALICE_OWNER);
        const sibling = await submitActivation(hub, "sibling", BOB_OWNER);
        await waitFor(
          () =>
            hub.listAsks(id, situation).length > 0 &&
            hub.listAsks(sibling, situation).length > 0,
        );
        const askId = hub.listAsks(id, situation)[0]!.metadata!.askId;
        const input = inputs.get(id)!;
        const path = join(input.context.workspacePath, "result.txt");
        await writeFile(path, "keep");
        const writeStarted = deferred();
        const put = opts.workerHubStore.putWorkerState.bind(
          opts.workerHubStore,
        );
        vi.spyOn(opts.workerHubStore, "putWorkerState").mockImplementationOnce(
          async (...args) => {
            writeStarted.resolve();
            await allowWrite.promise;
            await put(...args);
          },
        );
        const writing = workerHost.state.put(id, "session", "admitted");
        await writeStarted.promise;
        const end = await opts.historyStore.endCursor(id);
        const busy = { outcome: "in-use", arcRunId: id };
        expect(
          await Promise.all([hub.removeRun(id), hub.removeRun(id)]),
        ).toEqual([busy, busy]);
        const controls = await hub.requestPause(id);
        expect(controls).toMatchObject({
          outcome: "requested",
          control: { status: "pauseRequested" },
        });
        expect(await hub.removeRun(id)).toEqual(busy);
        expect(hub.listAsks(id, situation)[0]?.metadata?.askId).toBe(askId);
        expect(
          await drainLifecycle(
            hub.submitInbound({
              arcRunId: id,
              content: "yes",
              metadata: { principal: ALICE_OWNER, askId },
            }),
          ),
        ).toMatchObject([{ kind: "continued" }]);
        finish.resolve();
        await waitFor(
          async () =>
            (await hub.getExecutionControlView(id)).status === "paused",
        );
        const { position } = (await opts.replayStore.listCheckpoints(id))[0]!;
        const fork = (await arcHost.rewind(id, position)).arcRunId;
        const removeAs = async (principal: string) => {
          if ((await hub.getRunOwnerPrincipal(id)) !== principal)
            throw new Error("Not the owner");
          return hub.removeRun(id);
        };
        await expect(removeAs(BOB_OWNER)).rejects.toThrow("Not the owner");
        let finished = false;
        const outcomes = Promise.all([
          removeAs(ALICE_OWNER),
          removeAs(ALICE_OWNER),
        ]).then((results) => {
          finished = true;
          return results;
        });
        await waitFor(async () => (await arcHost.getRunView(id)) === undefined);
        expect(finished).toBe(false);
        expect(await arcHost.getRunView(id)).toBeUndefined();
        expect(await hub.getRunOwnerPrincipal(id)).toBeUndefined();
        allowWrite.resolve();
        await writing;
        expect(await outcomes).toEqual(
          expect.arrayContaining([
            { outcome: "removed", arcRunId: id },
            { outcome: "missing", arcRunId: id },
          ]),
        );
        expect(await hub.getRunOwnerPrincipal(id)).toBeUndefined();
        expect(
          new Set((await arcHost.listRunViews()).map((run) => run.arcRunId)),
        ).toEqual(new Set([sibling, fork]));
        expect(await opts.replayStore.listSteps(fork)).not.toEqual([]);
        expect((await arcHost.rewind(fork, position)).arcRunId).not.toBe(fork);
        expect(await hub.resume(id)).toEqual({
          outcome: "missing",
          arcRunId: id,
        });
        expect(await input.effects.checkSignal()).toEqual({ kind: "cancel" });
        expect(hub.listAsks(id, situation)).toEqual([]);
        expect(hub.listAsks(sibling, situation)).toHaveLength(1);
        expect(
          await drainLifecycle(
            hub.submitInbound({
              arcRunId: id,
              content: "late",
              metadata: { principal: ALICE_OWNER, askId },
            }),
          ),
        ).toMatchObject([{ kind: "rejected" }]);
        expect(await isFrozen(opts.arcHostStore, id)).toBe(false);
        await input.diagnostics.writeText("late", "discard");
        await workerHost.state.put(id, "session", "late");
        finish.resolve();
        await waitFor(() => disposed.mock.calls.some(([run]) => run === id));
        expect(
          await collectAsync(opts.workerHubStore.listRoutines(id)),
        ).toEqual([]);
        expect(
          await opts.workerHubStore.getExecutionControl(id),
        ).toBeUndefined();
        expect(await workerHost.state.get(id, "session")).toBeUndefined();
        expect(await workerHost.state.get(sibling, "session")).toBe(
          "continuity",
        );
        expect(await opts.historyStore.listEntries(id)).toEqual([]);
        await expect(
          collectAsync(opts.historyStore.readEntries(id, null, end)),
        ).rejects.toThrow();
        expect(await opts.replayStore.listSteps(id)).toEqual([]);
        expect(await opts.replayStore.listCheckpoints(id)).toEqual([]);
        await expect(
          readdir(join(root, "diagnostics", routinePathSegment(id))),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path, "utf8")).toBe("keep");
        expect(await hub.listWorkEvents(id)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "run:started" }),
          ]),
        );
        expect(await opts.historyStore.listEntries(sibling)).not.toEqual([]);
        expect(await opts.replayStore.listCheckpoints(sibling)).not.toEqual([]);
      } finally {
        allowWrite.resolve();
        finish.resolve();
        await arcade.stop();
      }
    },
  );

  it.each(["memory", "file"])(
    "reports failed cleanup and lets the owner retry without restart using %s storage",
    async (storage) => {
      const root = await mkdtemp(join(tmpdir(), "arcade-removal-retry-"));
      const opts = options(root, storage === "file");
      const arcade = await startArcade(opts);
      const { workerHub: hub } = arcade;
      try {
        await arcade.arcHost.registerArc("watch", parse(WATCH_SOURCE));
        const id = await submitActivation(hub, "start", ALICE_OWNER);
        await waitFor(
          async () =>
            (await opts.arcHostStore.getState(arcRunKey(id)))?.lifecycle ===
            "completed",
        );
        const fault = new Error("replay offline");
        const entered = deferred();
        const finish = deferred();
        vi.spyOn(opts.replayStore, "deleteRunData").mockImplementationOnce(
          async () => {
            entered.resolve();
            await finish.promise;
            throw fault;
          },
        );
        const removeAs = async (owner: string) => {
          if ((await hub.getRunOwnerPrincipal(id)) !== owner)
            throw new Error("Not the owner");
          return hub.removeRun(id);
        };
        const first = removeAs(ALICE_OWNER);
        await entered.promise;
        const second = hub.removeRun(id);
        finish.resolve();
        await Promise.all([
          expect(first).rejects.toBe(fault),
          expect(second).rejects.toBe(fault),
        ]);
        expect(await arcade.arcHost.getRunView(id)).toBeUndefined();
        expect(await opts.historyStore.listEntries(id)).toEqual([]);
        expect(await opts.replayStore.listSteps(id)).not.toEqual([]);
        await expect(removeAs(BOB_OWNER)).rejects.toThrow("Not the owner");
        expect(await hub.removeRun(id)).toEqual({
          outcome: "removed",
          arcRunId: id,
        });
        expect(await opts.replayStore.listSteps(id)).toEqual([]);
        expect(await hub.getRunOwnerPrincipal(id)).toBeUndefined();
        expect(await hub.removeRun(id)).toEqual({
          outcome: "missing",
          arcRunId: id,
        });
      } finally {
        await arcade.stop();
      }
    },
  );

  it("finishes committed file cleanup after the connector leaves", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-background-"));
    const opts = options(root, true);
    const arcade = await startArcade(opts);
    try {
      await arcade.arcHost.registerArc("watch", parse(WATCH_SOURCE));
      const id = await submitActivation(arcade.workerHub, "start");
      await waitFor(
        async () =>
          (await opts.arcHostStore.getState(arcRunKey(id)))?.lifecycle ===
          "completed",
      );
      const fault = new Error("temporary replay failure");
      const purge = vi
        .spyOn(opts.replayStore, "deleteRunData")
        .mockRejectedValueOnce(fault);
      await expect(arcade.workerHub.removeRun(id)).rejects.toBe(fault);
      expect(await isFrozen(opts.arcHostStore, id)).toBe(true);
      expect(await arcade.workerHub.getRunOwnerPrincipal(id)).toBeUndefined();
      await vi.waitFor(
        async () => expect(await isFrozen(opts.arcHostStore, id)).toBe(false),
        { timeout: 5000 },
      );
      expect(purge).toHaveBeenCalledTimes(2);
      expect(await opts.replayStore.listCheckpoints(id)).toEqual([]);
      expect(await arcade.workerHub.listWorkEvents(id)).not.toEqual([]);
    } finally {
      await arcade.stop();
    }
  });

  it.each(["memory", "file"])(
    "freezes and lists owned runs and deletes only frozen state using %s storage",
    async (storage) => {
      const root = await mkdtemp(join(tmpdir(), "arcade-reconcile-"));
      const opts = options(root, storage === "file");
      const arcade = await startArcade(opts);
      const { arcHost, workerHub } = arcade;
      try {
        await arcHost.registerArc("watch", parse(WATCH_SOURCE));
        const target = await submitActivation(workerHub, "remove", ALICE_OWNER);
        const retained = await submitActivation(workerHub, "retain", BOB_OWNER);
        for (const id of [target, retained])
          await waitFor(
            async () =>
              (await opts.arcHostStore.getState(arcRunKey(id)))?.lifecycle ===
              "completed",
          );
        const [checkpoint] = await opts.replayStore.listCheckpoints(target);
        const active = (await arcHost.rewind(target, checkpoint!.position))
          .arcRunId;
        expect(await arcHost.removeRun(target)).toEqual({
          outcome: "in-use",
          arcRunId: target,
        });
        const view = await arcHost.getRunView(target);
        if (view?.stage !== "actioning")
          throw new Error("Expected durable run");
        expect(
          await arcHost.freezeRun(target, {
            ...view,
            reactivationCount: view.reactivationCount + 1,
          }),
        ).toEqual({ outcome: "changed", arcRunId: target });
        expect(await arcHost.getRunView(target)).toEqual(view);
        expect(await arcHost.freezeRun(target, view)).toEqual({
          outcome: "frozen",
          arcRunId: target,
        });
        expect(await arcHost.freezeRun(target)).toEqual({
          outcome: "frozen",
          arcRunId: target,
        });
        expect(await arcHost.getRunView(target)).toBeUndefined();
        expect(await workerHub.getRunOwnerPrincipal(target)).toBeUndefined();
        expect(
          (await arcHost.listRunViews(ALICE_OWNER)).map((run) => run.arcRunId),
        ).toEqual([active]);
        expect(
          await arcHost.listRunViews({
            ownerPrincipal: ALICE_OWNER,
            frozen: true,
          }),
        ).toEqual([{ ...view, frozen: true }]);
        expect(
          await arcHost.listRunViews({
            ownerPrincipal: BOB_OWNER,
            frozen: true,
          }),
        ).toEqual([]);
        expect(
          new Set(
            (await arcHost.listRunViews({ frozen: "all" })).map(
              (run) => run.arcRunId,
            ),
          ),
        ).toEqual(new Set([target, retained, active]));
        expect(
          await arcHost.begin({ arcRunId: target, projectDialog: vi.fn() }),
        ).toEqual([]);
        await expect(
          arcHost.rewind(target, checkpoint!.position),
        ).rejects.toThrow("Unknown Arc run");
        const fault = new Error("replay unavailable");
        vi.spyOn(opts.replayStore, "deleteRunData").mockRejectedValueOnce(
          fault,
        );
        await expect(arcHost.removeRun(target)).rejects.toBe(fault);
        expect(await arcHost.listRunViews({ frozen: true })).toEqual([
          { ...view, frozen: true },
        ]);
        const deleteError = new Error("run state unavailable");
        vi.spyOn(opts.arcHostStore, "deleteState").mockRejectedValueOnce(
          deleteError,
        );
        await expect(arcHost.removeRun(target)).rejects.toBe(deleteError);
        expect(await opts.replayStore.listSteps(target)).toEqual([]);
        expect(await arcHost.listRunViews({ frozen: true })).toEqual([
          { ...view, frozen: true },
        ]);
        expect(await arcHost.removeRun(target)).toEqual({
          outcome: "removed",
          arcRunId: target,
        });
        expect(await arcHost.removeRun(target)).toEqual({
          outcome: "missing",
          arcRunId: target,
        });
        expect(await arcHost.freezeRun(target)).toEqual({
          outcome: "missing",
          arcRunId: target,
        });
        expect(await arcHost.listRunViews({ frozen: true })).toEqual([]);
        expect(await opts.replayStore.listSteps(target)).toEqual([]);
        expect(await workerHub.listWorkEvents(target)).not.toEqual([]);
        expect(await arcHost.getRunView(retained)).toMatchObject({
          lifecycle: "completed",
        });
      } finally {
        await arcade.stop();
      }
    },
  );

  it("distinguishes an inherited generation from its replacement before dispatch", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    await host.registerArc("watch", parse(WATCH_SOURCE));
    const projectDialog = async () => ({
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    const [first] = await host.begin({ principal: ALICE_OWNER, projectDialog });
    if (first?.kind !== "action") throw new Error("Expected an action step");
    const id = first.arcRunId;
    const inherited = await host.getRunView(id);
    if (inherited?.stage !== "actioning" || !inherited.generation)
      throw new Error("Expected a live action generation");
    expect(await host.listRunViews(ALICE_OWNER)).toEqual([inherited]);
    expect(await store.getState(arcRunKey(id))).not.toHaveProperty(
      "generation",
    );
    const finishStartupRead = deferred();
    const list = store.listStates.bind(store);
    vi.spyOn(store, "listStates").mockImplementationOnce(async function* () {
      await finishStartupRead.promise;
      yield* list();
    });
    const { workerHub: hub, historyStore } = makeWorkerHub({ arcHost: host });
    try {
      await host.releaseAction(id, first.frontier.frontierId);
      expect(first.signal.aborted).toBe(true);
      expect(await host.getRunView(id)).not.toHaveProperty("generation");

      const [next] = await host.begin({ arcRunId: id, projectDialog });
      if (next?.kind !== "action")
        throw new Error("Expected a replacement step");
      const live = await host.getRunView(id);
      if (live?.stage !== "actioning" || !live.generation)
        throw new Error("Expected a replacement generation");
      expect(live.generation).not.toBe(inherited.generation);
      expect(await host.listRunViews()).toEqual([live]);
      finishStartupRead.resolve();
      expect(await hub.removeRun(id)).toEqual({
        outcome: "in-use",
        arcRunId: id,
      });
      expect(
        await host.freezeRun(id, { ...live, generation: inherited.generation }),
      ).toEqual({ outcome: "changed", arcRunId: id });
      expect(next.signal.aborted).toBe(false);

      // A handoff delayed until after replacement may still return the old step.
      vi.spyOn(host, "begin").mockResolvedValueOnce([first]);
      expect(
        await drainLifecycle(
          hub.submitInbound({
            content: "stale",
            metadata: { principal: ALICE_OWNER },
          }),
        ),
      ).toEqual([]);
      expect(await historyStore.listEntries(id)).toEqual([]);
      expect(await host.freezeRun(id, live)).toEqual({
        outcome: "frozen",
        arcRunId: id,
      });
      expect(next.signal.aborted).toBe(true);
      expect((await host.listRunViews({ frozen: true }))[0]).not.toHaveProperty(
        "generation",
      );
    } finally {
      finishStartupRead.resolve();
      await hub.stop();
      await host.stop();
    }
  });

  it("recovers a committed removal when the worker hub starts directly", async () => {
    const store = new InMemoryArcHostStore();
    const replayStore = new InMemoryReplayStore();
    const host = await createTestArcHost({ store, replayStore });
    await host.registerArc("watch", parse(WATCH_SOURCE));
    const first = makeWorkerHub({
      arcHost: host,
      workers: { researcher: async () => ({ outcome: "completed" }) },
    });
    let id: string;
    try {
      id = await submitActivation(first.workerHub, "start");
      await waitFor(
        async () =>
          (await store.getState(arcRunKey(id)))?.lifecycle === "completed",
      );
      expect(await host.freezeRun(id)).toEqual({
        outcome: "frozen",
        arcRunId: id,
      });
    } finally {
      await first.workerHub.stop();
      await host.stop();
    }
    expect(await isFrozen(store, id)).toBe(true);
    const restored = await createTestArcHost({
      store,
      replayStore,
      executionControl: first.routineStore,
    });
    const second = makeWorkerHub({
      arcHost: restored,
      historyStore: first.historyStore,
    });
    try {
      await waitFor(
        async () => (await store.getState(arcRunKey(id))) === undefined,
      );
      expect(await replayStore.listSteps(id)).toEqual([]);
      expect(await first.historyStore.listEntries(id)).toEqual([]);
    } finally {
      await second.workerHub.stop();
      await restored.stop();
    }
  });

  it("recovers a partially reclaimed run on restart and preserves its independent rewind", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-retry-"));
    const opts = options(root, true);
    const first = await startArcade(opts);
    let id: string;
    let fork: string;
    let retryId: string;
    try {
      await first.arcHost.registerArc("watch", parse(WATCH_SOURCE));
      id = await submitActivation(first.workerHub, "start");
      await waitFor(
        async () =>
          (await opts.arcHostStore.getState(arcRunKey(id)))?.lifecycle ===
          "completed",
      );
      const { position } = (await opts.replayStore.listCheckpoints(id))[0]!;
      fork = (await first.arcHost.rewind(id, position)).arcRunId;
      retryId = await submitActivation(
        first.workerHub,
        "another run",
        BOB_OWNER,
      );
      await waitFor(
        async () =>
          (await opts.arcHostStore.getState(arcRunKey(retryId)))?.lifecycle ===
          "completed",
      );
      const cause = new Error("replay offline");
      vi.spyOn(opts.replayStore, "deleteRunData").mockRejectedValue(cause);
      for (const arcRunId of [id, retryId])
        await expect(first.workerHub.removeRun(arcRunId)).rejects.toBe(cause);
    } finally {
      await first.stop();
    }
    const reopened = options(root, true);
    const states = await collectAsync(reopened.arcHostStore.listStates());
    expect(
      new Set(
        states
          .filter(([, state]) => state.frozen)
          .map(([, state]) => state.arcRunId),
      ),
    ).toEqual(new Set([id, retryId]));
    const purge = reopened.replayStore.deleteRunData.bind(reopened.replayStore);
    let failedId: string | undefined;
    const failure = vi
      .spyOn(reopened.replayStore, "deleteRunData")
      .mockImplementation(async (run) => {
        failedId ??= run;
        if (run === failedId) throw new Error("persistent replay failure");
        await purge(run);
      });
    const logSink = { write: vi.fn() };
    const second = await startArcade({
      ...reopened,
      config: {
        ...reopened.config,
        logging: { ...reopened.config.logging, level: "info" },
      },
      logSink,
    });
    try {
      if (!failedId) throw new Error("Expected a frozen run to reach cleanup");
      const recoveredId = failedId === id ? retryId : id;
      expect(logSink.write).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "worker_hub.run.cleanup_failed",
          arcRunId: failedId,
          message: expect.stringContaining("persistent replay failure"),
        }),
      );
      expect(await isFrozen(reopened.arcHostStore, failedId)).toBe(true);
      expect(await isFrozen(reopened.arcHostStore, recoveredId)).toBe(false);
      expect(await second.arcHost.getRunView(failedId)).toBeUndefined();
      expect(
        await second.workerHub.getRunOwnerPrincipal(failedId),
      ).toBeUndefined();
      failure.mockRestore();
      expect(await second.workerHub.removeRun(failedId)).toEqual({
        outcome: "removed",
        arcRunId: failedId,
      });
      expect(
        await second.workerHub.getRunOwnerPrincipal(failedId),
      ).toBeUndefined();
      expect(await second.workerHub.removeRun(recoveredId)).toEqual({
        outcome: "missing",
        arcRunId: recoveredId,
      });
      expect(await second.arcHost.getRunView(id)).toBeUndefined();
      expect(await reopened.replayStore.listSteps(id)).toEqual([]);
      expect(await second.workerHub.listWorkEvents(id)).not.toEqual([]);
      expect(await second.arcHost.getRunView(fork)).toBeDefined();
      expect(await reopened.replayStore.listSteps(fork)).not.toEqual([]);
      await expect(
        second.arcHost.rewind(id, {
          stage: "action",
          index: 0,
          reactivationCount: 0,
        }),
      ).rejects.toThrow("Unknown Arc run");
      expect(
        await second.workerHub.getExecutionControlView(fork),
      ).toMatchObject({ status: "hub-restarted" });
      expect(await second.workerHub.removeRun(fork)).toEqual({
        outcome: "removed",
        arcRunId: fork,
      });
    } finally {
      await second.stop();
    }
  });

  it.each(["removal", "re-entry"])(
    "orders reclamation of a deflected run against re-entry when %s wins",
    async (winner) => {
      const root = await mkdtemp(join(tmpdir(), "arcade-removal-choice-"));
      const finish = deferred();
      const opts = options(root, false, {
        supportedSlotKinds: new Set(["role"]),
        createWorker: () => ({
          run: async () => {
            await finish.promise;
            return { outcome: "completed" };
          },
          disposeRoutine: async () => {},
        }),
      });
      const arcade = await startArcade(opts);
      const { arcHost, workerHub: hub } = arcade;
      try {
        await arcHost.registerArc(
          "choice",
          parse(`"arc"; function Main() {
        this.trigger = () => true; $enter(Work);
        function Work() { this.guard = () => { if (/deflect/.test(Dialog.lastUserMessage)) return State.DEFLECTED; }; $instruct("Continue"); }
      }`),
        );
        const id = await submitActivation(hub, "deflect");
        expect(await arcHost.getRunView(id)).toMatchObject({
          lifecycle: "deflected",
        });
        const reader = lifecycleReader(
          hub.submitInbound({
            content: "again",
            metadata: { principal: ALICE_OWNER },
          }),
        );
        const gate = await reader.next();
        if (gate.kind !== "handshake-required")
          throw new Error("Expected pending choice");
        const pending = (await arcHost.listRunViews()).find(
          (view) => view.stage === "handshaking",
        )!;
        expect(await hub.removeRun(pending.arcRunId)).toEqual({
          outcome: "missing",
          arcRunId: pending.arcRunId,
        });
        const reenter = () =>
          hub.handshake(gate.handshakeId, {
            runChoice: { action: "join", arcRunId: id },
          });
        if (winner === "removal") {
          const cleanupStarted = deferred();
          const proceed = deferred();
          const purge = opts.historyStore.deleteRunData.bind(opts.historyStore);
          vi.spyOn(opts.historyStore, "deleteRunData").mockImplementationOnce(
            async (run) => {
              cleanupStarted.resolve();
              await proceed.promise;
              await purge(run);
            },
          );
          const removal = hub.removeRun(id);
          await cleanupStarted.promise;
          try {
            expect(await reenter()).toMatchObject({ status: "invalid" });
          } finally {
            proceed.resolve();
          }
          expect(await removal).toEqual({ outcome: "removed", arcRunId: id });
          await hub.handshake(gate.handshakeId, { decline: true });
        } else {
          const freeze = arcHost.freezeRun.bind(arcHost);
          const observed = deferred();
          const proceed = deferred();
          vi.spyOn(arcHost, "freezeRun").mockImplementationOnce(
            async (...args) => {
              observed.resolve();
              await proceed.promise;
              return freeze(...args);
            },
          );
          const removal = hub.removeRun(id);
          await observed.promise;
          const reentry = reenter();
          try {
            expect(await reader.next()).toMatchObject({
              kind: "activated",
              arcRunId: id,
            });
          } finally {
            proceed.resolve();
          }
          expect(await reentry).toMatchObject({ status: "ok" });
          expect(await arcHost.getRunView(id)).toMatchObject({
            reactivationCount: 1,
          });
          expect(await removal).toEqual({
            outcome: "in-use",
            arcRunId: id,
          });
          expect(await arcHost.getRunView(id)).toMatchObject({
            lifecycle: "active",
          });
        }
      } finally {
        finish.resolve();
        await arcade.stop();
      }
    },
  );

  it.each(["paused", "capacity-limited", "transport-lost"])(
    "reclaims a %s run and prevents a later resume",
    async (status) => {
      const host = await makeArcHostWithSource("watch", WATCH_SOURCE);
      const cancel = vi.fn();
      let retry: (() => void) | undefined;
      let calls = 0;
      const { workerHub: hub, routineStore } = makeWorkerHub({
        arcHost: host,
        workers: {
          researcher: async () => {
            calls++;
            if (status === "paused") throw new RoutinePausedError();
            if (status === "transport-lost")
              return {
                suspension: "transport-lost",
                reason: { reason: "connection reset", message: "retry" },
              };
            return {
              suspension: "capacity-limited",
              reason: {
                reason: "api rate limit",
                provider: "test",
                message: "retry",
              },
            };
          },
        },
        capacityRetry: {
          enabled: true,
          schedule: (callback) => {
            retry = callback;
            return cancel;
          },
        },
      });
      try {
        const id = await submitActivation(hub, "start");
        await waitFor(
          async () =>
            (await hub.getExecutionControlView(id)).status === status &&
            (status === "paused" || !!retry),
        );
        expect(await hub.removeRun(id)).toEqual({
          outcome: "removed",
          arcRunId: id,
        });
        if (status !== "paused") {
          expect(cancel).toHaveBeenCalled();
          retry!();
        }
        expect(await hub.resume(id)).toEqual({
          outcome: "missing",
          arcRunId: id,
        });
        await waitFor(
          async () =>
            !(await collectAsync(routineStore.listRoutines(id))).length,
        );
        expect(calls).toBe(1);
      } finally {
        await hub.stop();
        await host.stop();
      }
    },
  );

  it.each([
    { source: "manual", winner: "resume" },
    { source: "manual", winner: "removal" },
    { source: "automatic", winner: "resume" },
    { source: "automatic", winner: "removal" },
  ])(
    "orders a $source resume against removal when $winner wins",
    async ({ source, winner }) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      await host.registerArc("watch", parse(WATCH_SOURCE));
      const entered = deferred();
      const release = deferred();
      const finish = deferred();
      let retry: (() => void) | undefined;
      let calls = 0;
      const { workerHub: hub, routineStore } = makeWorkerHub({
        arcHost: host,
        workers: {
          researcher: async () => {
            if (++calls === 1)
              return {
                suspension: "capacity-limited",
                reason: {
                  reason: "api rate limit",
                  provider: "test",
                  message: "retry",
                },
              };
            await finish.promise;
            return { outcome: "completed" };
          },
        },
        capacityRetry: {
          enabled: true,
          schedule: (callback) => {
            retry = callback;
            return () => {};
          },
        },
      });
      try {
        const id = await submitActivation(hub, "start");
        await waitFor(() => !!retry);
        const resume = () =>
          source === "automatic" ? retry!() : hub.resume(id);
        if (winner === "removal") {
          const commit = store.putState.bind(store);
          vi.spyOn(store, "putState").mockImplementationOnce(
            async (key, state) => {
              expect(state.frozen).toBe(true);
              entered.resolve();
              await release.promise;
              return commit(key, state);
            },
          );
          const removal = hub.removeRun(id);
          await entered.promise;
          const resuming = resume();
          release.resolve();
          expect(await removal).toEqual({ outcome: "removed", arcRunId: id });
          if (source === "manual")
            expect(await resuming).toEqual({
              outcome: "missing",
              arcRunId: id,
            });
          expect(await hub.resume(id)).toEqual({
            outcome: "missing",
            arcRunId: id,
          });
          expect(await routineStore.getExecutionControl(id)).toBeUndefined();
          expect(calls).toBe(1);
        } else {
          const put = routineStore.putExecutionControl.bind(routineStore);
          vi.spyOn(routineStore, "putExecutionControl").mockImplementationOnce(
            async (state) => {
              expect(state.status).toBe("running");
              entered.resolve();
              await release.promise;
              await put(state);
            },
          );
          const resuming = resume();
          await entered.promise;
          const removal = hub.removeRun(id);
          release.resolve();
          expect(await removal).toEqual({ outcome: "in-use", arcRunId: id });
          await waitFor(() => calls === 2);
          finish.resolve();
          await resuming;
          await waitFor(
            async () =>
              (await store.getState(arcRunKey(id)))?.lifecycle === "completed",
          );
        }
      } finally {
        release.resolve();
        finish.resolve();
        await hub.stop();
        await host.stop();
      }
    },
  );

  it("hands back a committed action frontier when a competing freeze observes stale progress", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    const writing = deferred();
    const finish = deferred();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      await host.registerArc(
        "steps",
        parse(
          '"arc"; function Main(){ this.trigger=()=>true; $instruct("first"); $instruct("second"); }',
        ),
      );
      const projectDialog = async () => ({
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      });
      const [step] = await host.begin({
        principal: ALICE_OWNER,
        projectDialog,
      });
      if (step?.kind !== "action") throw new Error("Expected an action");
      const id = step.arcRunId;
      const observed = await host.getRunView(id);
      if (observed?.stage !== "actioning") throw new Error("Expected a run");
      const put = store.putState.bind(store);
      vi.spyOn(store, "putState").mockImplementationOnce(async (key, state) => {
        writing.resolve();
        await finish.promise;
        await put(key, state);
      });
      const progress = host.advanceAction(id, step.frontier.frontierId, {
        reports: [],
        instructionCoverage: { [taskId(step.frontier.tasks[0]!)]: "applied" },
        projectDialog,
      });
      await writing.promise;
      const freeze = host.freezeRun(id, observed);
      await new Promise<void>((resolve) => setImmediate(resolve));
      finish.resolve();
      const [next, result] = await Promise.all([progress, freeze]);
      expect(result).toEqual({ outcome: "changed", arcRunId: id });
      expect(next).toMatchObject({
        kind: "action",
        frontier: { canProgress: true },
      });
      if (next.kind !== "action")
        throw new Error("Expected an action frontier");
      expect(next.signal).toBe(step.signal);
      expect(next.signal.aborted).toBe(false);
      expect(await host.getRunView(id)).toMatchObject({
        lifecycle: "active",
        generation: observed.generation,
        updatedAt: observed.updatedAt,
      });
      const last = await host.advanceAction(id, next.frontier.frontierId, {
        reports: [],
        instructionCoverage: { [taskId(next.frontier.tasks[0]!)]: "applied" },
        projectDialog,
      });
      expect(last).toMatchObject({ frontier: { status: "completed" } });
    } finally {
      finish.resolve();
      vi.useRealTimers();
      await host.stop();
    }
  });

  it.each(["commits", "fails"] as const)(
    "orders a module acknowledgment and queued action behind a freeze that %s",
    async (outcome) => {
      const store = new InMemoryArcHostStore();
      const host = await createTestArcHost({ store });
      const submitted = deferred<{ arcRunId: string; signal: AbortSignal }>();
      const acknowledge = deferred();
      const freezing = deferred();
      const finish = deferred();
      const fault = new Error("freeze write failed");
      try {
        await host.registerHostModule("gate", {
          declaration: hmd.define({ wait: () => hmd.Bool() }),
          submit: async (calls, context) => {
            submitted.resolve(context);
            await acknowledge.promise;
            return calls.map(({ call }) => ({ hostCallId: call.hostCallId }));
          },
        });
        await host.registerArc(
          "gate",
          parse(
            '"arc"; import Gate from "host:gate"; function Main(){this.trigger=()=>true; Gate.$wait();}',
          ),
        );
        const projectDialog = async () => ({
          cursor: { user: 0, self: 0 },
          lastTurns: [],
        });
        const activation = host.begin({
          principal: ALICE_OWNER,
          projectDialog,
        });
        const { arcRunId: id, signal } = await submitted.promise;
        const view = await host.getRunView(id);
        if (view?.stage !== "actioning")
          throw new Error("Expected durable submission");
        const put = store.putState.bind(store);
        vi.spyOn(store, "putState").mockImplementationOnce(
          async (key, state) => {
            expect(state.frozen).toBe(true);
            freezing.resolve();
            await finish.promise;
            if (outcome === "fails") throw fault;
            await put(key, state);
          },
        );
        const queued = host.begin({ arcRunId: id, projectDialog });
        const freeze = host.freezeRun(id, view);
        await freezing.promise;
        acknowledge.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(signal.aborted).toBe(false);
        expect(
          (await store.getState(arcRunKey(id)))?.hostModules.calls[0]
            ?.acknowledged,
        ).toBe(false);
        const settled = Promise.allSettled([
          freeze,
          activation,
          queued,
        ] as const);
        finish.resolve();
        const [frozen, begun, continued] = await settled;
        if (outcome === "commits") {
          expect(frozen).toEqual({
            status: "fulfilled",
            value: { outcome: "frozen", arcRunId: id },
          });
          expect(signal.aborted).toBe(true);
          expect(begun).toMatchObject({
            status: "rejected",
            reason: { name: "AbortError" },
          });
          expect(continued).toEqual({ status: "fulfilled", value: [] });
          expect(
            (await store.getState(arcRunKey(id)))?.hostModules.calls[0]
              ?.acknowledged,
          ).toBe(false);
        } else {
          expect(frozen).toEqual({ status: "rejected", reason: fault });
          expect(signal.aborted).toBe(false);
          for (const step of [begun, continued])
            expect(step).toMatchObject({
              status: "fulfilled",
              value: [{ kind: "action", signal }],
            });
          expect(
            (await store.getState(arcRunKey(id)))?.hostModules.calls[0]
              ?.acknowledged,
          ).toBe(true);
        }
      } finally {
        finish.resolve();
        acknowledge.resolve();
        await host.stop();
      }
    },
  );

  it("keeps a running host submission live and releases it after the run is paused", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-module-"));
    const opts = options(root, false);
    const arcade = await startArcade(opts);
    const entered = deferred<AbortSignal>();
    const release = vi.fn(async () => {});
    try {
      await arcade.arcHost.registerHostModule("gate", {
        declaration: hmd.define({ wait: () => hmd.Bool() }),
        submit: async (calls, { signal }) => {
          entered.resolve(signal);
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
          return calls.map(({ call }) => ({ hostCallId: call.hostCallId }));
        },
        releaseRun: release,
      });
      await arcade.arcHost.registerArc(
        "gate",
        parse(
          '"arc"; import Gate from "host:gate"; function Main(){this.trigger=()=>true; this.hostParams={workerRole:"researcher"}; $instruct("first"); Gate.$wait(); $instruct("next");}',
        ),
      );
      const id = await submitActivation(arcade.workerHub, "start");
      const signal = await entered.promise;
      expect(await arcade.workerHub.removeRun(id)).toEqual({
        outcome: "in-use",
        arcRunId: id,
      });
      expect(signal.aborted).toBe(false);
      expect(await arcade.workerHub.requestPause(id)).toMatchObject({
        outcome: "requested",
        control: { status: "paused" },
      });
      expect(await arcade.workerHub.removeRun(id)).toEqual({
        outcome: "removed",
        arcRunId: id,
      });
      expect(signal.aborted).toBe(true);
      await waitFor(() => release.mock.calls.length > 0);
      expect(await arcade.arcHost.getRunView(id)).toBeUndefined();
      expect(await isFrozen(opts.arcHostStore, id)).toBe(false);
      expect(await opts.replayStore.listSteps(id)).toEqual([]);
    } finally {
      await arcade.stop();
    }
  });

  it("rejects both callers with the commit error and permits a retry for a poisoned run", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-poison-"));
    const opts = options(root, false);
    const arcade = await startArcade(opts);
    try {
      await arcade.arcHost.registerHostModule("fault", {
        declaration: hmd.define({ fail: () => hmd.Bool() }),
        submit: async () => {
          throw new Error("failed module");
        },
        releaseRun: async () => {},
      });
      await arcade.arcHost.registerArc(
        "fault",
        parse(
          '"arc"; import Fault from "host:fault"; function Main(){this.trigger=()=>true; Fault.$fail();}',
        ),
      );
      const id = await submitActivation(arcade.workerHub, "start");
      expect(await arcade.arcHost.getRunView(id)).toMatchObject({
        lifecycle: "poisoned",
      });
      const cause = new Error("disk unavailable");
      vi.spyOn(opts.arcHostStore, "putState").mockRejectedValueOnce(cause);
      await Promise.all([
        expect(arcade.workerHub.removeRun(id)).rejects.toBe(cause),
        expect(arcade.workerHub.removeRun(id)).rejects.toBe(cause),
      ]);
      expect(await arcade.arcHost.getRunView(id)).toMatchObject({
        lifecycle: "poisoned",
      });
      expect(await isFrozen(opts.arcHostStore, id)).toBe(false);
      expect(await arcade.workerHub.removeRun(id)).toEqual({
        outcome: "removed",
        arcRunId: id,
      });
    } finally {
      await arcade.stop();
    }
  });

  it("reclaims a completed run only after its final progress write commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-progress-"));
    const opts = options(root, false);
    const written = deferred();
    const finish = deferred();
    const put = opts.arcHostStore.putState.bind(opts.arcHostStore);
    const durable = vi
      .spyOn(opts.arcHostStore, "putState")
      .mockImplementation(async (key, state) => {
        if (state.lifecycle === "completed") {
          written.resolve();
          await finish.promise;
        }
        await put(key, state);
      });
    const arcade = await startArcade(opts);
    try {
      await arcade.arcHost.registerArc("watch", parse(WATCH_SOURCE));
      const id = await submitActivation(arcade.workerHub, "start");
      await written.promise;
      expect(await arcade.workerHub.removeRun(id)).toEqual({
        outcome: "in-use",
        arcRunId: id,
      });
      finish.resolve();
      await waitFor(
        async () =>
          (await opts.arcHostStore.getState(arcRunKey(id)))?.lifecycle ===
          "completed",
      );
      await opts.workerHubStore.putExecutionControl({
        arcRunId: id,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
      expect(await arcade.workerHub.removeRun(id)).toEqual({
        outcome: "removed",
        arcRunId: id,
      });
      expect(durable.mock.calls.at(-1)?.[1].lifecycle).toBe("completed");
      expect(await arcade.arcHost.getRunView(id)).toBeUndefined();
      expect(await arcade.workerHub.resume(id)).toEqual({
        outcome: "missing",
        arcRunId: id,
      });
    } finally {
      finish.resolve();
      await arcade.stop();
    }
  });

  it("keeps queued action work and its sibling when a running activation is in use", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-fanout-"));
    const released = deferred();
    const inputs: string[] = [];
    const opts = options(root, false, {
      supportedSlotKinds: new Set(["role"]),
      createWorker: () => ({
        run: async (input) => {
          inputs.push(input.routine.arcRunId);
          return { outcome: "completed" };
        },
        disposeRoutine: async () => {},
      }),
    });
    const arcade = await startArcade(opts);
    try {
      await arcade.arcHost.registerArc("first", parse(WATCH_SOURCE));
      await arcade.arcHost.registerArc("second", parse(WATCH_SOURCE));
      const append = opts.historyStore.appendEntry.bind(opts.historyStore);
      let writes = 0;
      vi.spyOn(opts.historyStore, "appendEntry").mockImplementation(
        async (id, entry) => {
          if (++writes === 2) await released.promise;
          return append(id, entry);
        },
      );
      const reader = lifecycleReader(
        arcade.workerHub.submitInbound({
          content: "start",
          metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
        }),
      );
      const first = await reader.next();
      if (first.kind !== "activated")
        throw new Error("Expected first activation");
      expect(await arcade.workerHub.removeRun(first.arcRunId)).toEqual({
        outcome: "in-use",
        arcRunId: first.arcRunId,
      });
      released.resolve();
      const second = await reader.next();
      if (second.kind !== "activated")
        throw new Error("Expected sibling activation");
      await waitFor(
        async () =>
          (await opts.arcHostStore.getState(arcRunKey(second.arcRunId)))
            ?.lifecycle === "completed",
      );
      expect(new Set(inputs)).toEqual(
        new Set([first.arcRunId, second.arcRunId]),
      );
    } finally {
      released.resolve();
      await arcade.stop();
    }
  });

  it("recognizes a fresh activation as in use before its first hub dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-removal-dispatch-"));
    const opts = options(root, false);
    const arcade = await startArcade(opts);
    try {
      await arcade.arcHost.registerArc("watch", parse(WATCH_SOURCE));
      const begin = arcade.arcHost.begin.bind(arcade.arcHost);
      vi.spyOn(arcade.arcHost, "begin").mockImplementationOnce(
        async (input) => {
          const steps = await begin(input);
          const step = steps[0]!;
          if (step.kind !== "action") throw new Error("Expected activation");
          expect(await arcade.workerHub.removeRun(step.arcRunId)).toEqual({
            outcome: "in-use",
            arcRunId: step.arcRunId,
          });
          return steps;
        },
      );
      expect(
        await drainLifecycle(
          arcade.workerHub.submitInbound({
            content: "start",
            metadata: { principal: ALICE_OWNER },
          }),
        ),
      ).toMatchObject([{ kind: "activated" }]);
      await waitFor(async () =>
        (await arcade.arcHost.listRunViews()).some(
          (run) => run.stage === "actioning" && run.lifecycle === "completed",
        ),
      );
    } finally {
      await arcade.stop();
    }
  });
});
