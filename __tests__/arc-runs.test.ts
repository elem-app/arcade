import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestArcHost, workEventsFor } from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import { Runtime, toArcRef } from "@elem-app/arc/runtime";
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryArcHostStore,
  InMemoryReplayStore,
  JsonFileArcHostStore,
  arcRunKey,
  taskId,
  type Dialog,
} from "../src/testing.js";
import {
  StepDriver,
  advanceView,
  beginActivatedDriver,
  beginActivatedView,
  beginActivation,
  beginView,
  expectSoleDriver,
  expectSoleHandshake,
  expectSoleTrigger,
  inboundFromDialog,
  projectorFor,
  type TriggerStep,
} from "./arc-host-helpers.js";
import {
  ALICE_OWNER,
  ARC_RUN_ID,
  DEFLECTABLE_SOURCE,
  GREET_SOURCE,
  createCapturingLogger,
  makeArcHost,
  makeArcHostWithSource,
  waitFor,
} from "./helpers.js";

import { KeyedSerializer } from "../src/utils/keyed-serializer.js";
import { makeControlledTime } from "./controlled-time.js";

describe("Arc runs", () => {
  it.each(["completed", "deflected", "poisoned"] as const)(
    "run.control-inactive preserves %s execution on targeted entry and reconstruction",
    async (lifecycle) => {
      const store = new InMemoryArcHostStore();
      const replayStore = new InMemoryReplayStore();
      const host = createTestArcHost({ store, replayStore });
      await host.registerArc(
        "inactive-entry",
        parse(
          lifecycle === "deflected"
            ? `"arc"; function Main() { this.trigger = () => true; this.forgetfulEntry = true; $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }`
            : `"arc"; function Main() { this.trigger = () => true; $instruct("final"); }`,
        ),
      );
      const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const driver = await beginActivatedDriver(host, dialog);
      const terminal =
        lifecycle === "deflected"
          ? driver.frontier
          : await advanceView(
              driver,
              dialog,
              lifecycle === "completed"
                ? {
                    reports: [],
                    instructionCoverage: {
                      [taskId(driver.frontier.tasks[0]!)]: "applied",
                    },
                  }
                : {
                    instructionCoverage: {},
                    reports: [
                      {
                        error: "failed",
                        code: "test-failure",
                        message: "failed",
                      },
                    ],
                  },
            );
      const id = driver.arcRunId;
      const state = await store.getState(arcRunKey(id));
      expect(state?.lifecycle).toBe(lifecycle);
      const replay = await replayStore.listSteps(id);
      const checkpoints = await replayStore.listCheckpoints(id);
      const events = await workEventsFor(host).list(id);
      const write = vi.spyOn(store, "putState");
      const append = vi.spyOn(replayStore, "appendStep");
      const checkpoint = vi.spyOn(replayStore, "putCheckpoint");
      const restarted = createTestArcHost({
        store,
        replayStore,
        workEvents: workEventsFor(host),
      });
      const projectDialog = vi.fn(async () => dialog);
      try {
        for (const entry of [host, restarted]) {
          await expect(
            entry.begin({ arcRunId: id, projectDialog }),
          ).resolves.toEqual([]);
          await expect(
            entry.advanceTrigger(id, dialog, {
              reports: [],
              instructionCoverage: {},
              projectDialog,
            }),
          ).resolves.toEqual([]);
          expect(await store.getState(arcRunKey(id))).toEqual(state);
          expect(await replayStore.listSteps(id)).toEqual(replay);
          expect(await replayStore.listCheckpoints(id)).toEqual(checkpoints);
          expect(await workEventsFor(host).list(id)).toEqual(events);
        }
        expect(projectDialog).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        expect(append).not.toHaveBeenCalled();
        expect(checkpoint).not.toHaveBeenCalled();
        const next = await host.advanceAction(id, terminal.frontierId, {
          instructionCoverage: {},
          projectDialog,
          reports: [],
        });
        if (next.kind !== "action") throw new Error("Expected action");
        expect(next.frontier).toBe(terminal);
      } finally {
        write.mockRestore();
        append.mockRestore();
        checkpoint.mockRestore();
        host.stop();
        restarted.stop();
      }
    },
  );

  it("run.control-inactive rechecks lifecycle after targeted begin waits for final settlement", async () => {
    const store = new InMemoryArcHostStore();
    const replayStore = new InMemoryReplayStore();
    const time = makeControlledTime();
    const host = createTestArcHost({ store, replayStore, ...time });
    await host.registerArc(
      "queued-entry",
      parse(
        `"arc"; import Time from "host:time"; function Main() { this.trigger = () => true; Time.$addTimeout(5000, "deadline"); $instruct("final"); }`,
      ),
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(host, dialog);
    const id = driver.arcRunId;
    let atCommit = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const putState = store.putState.bind(store);
    const write = vi
      .spyOn(store, "putState")
      .mockImplementation(async (key, state) => {
        if (state.lifecycle === "completed") {
          atCommit = true;
          await gate;
        }
        await putState(key, state);
      });
    let baseline!: {
      state: unknown;
      replay: unknown;
      checkpoints: unknown;
      events: unknown;
      deadlines: number;
    };
    const settlement = host
      .advanceAction(id, driver.frontier.frontierId, {
        reports: [],
        projectDialog: projectorFor(dialog),
        instructionCoverage: { [taskId(driver.frontier.tasks[0]!)]: "applied" },
      })
      .then(async (terminal) => {
        baseline = {
          state: await store.getState(arcRunKey(id)),
          replay: await replayStore.listSteps(id),
          checkpoints: await replayStore.listCheckpoints(id),
          events: await workEventsFor(host).list(id),
          deadlines: time.pendingCount,
        };
        return terminal;
      });
    await waitFor(() => atCommit);
    expect((await store.getState(arcRunKey(id)))?.lifecycle).toBe("active");
    const append = vi.spyOn(replayStore, "appendStep");
    const checkpoint = vi.spyOn(replayStore, "putCheckpoint");
    const serialized = vi.spyOn(KeyedSerializer.prototype, "run");
    const start = vi.spyOn(Runtime.prototype, "start");
    const projectDialog = vi.fn(async () => dialog);
    let began = false;
    const queued = host.begin({ arcRunId: id, projectDialog }).then((steps) => {
      began = true;
      return steps;
    });
    try {
      await waitFor(() => serialized.mock.calls.some(([key]) => key === id));
      expect(began).toBe(false);
      expect((await store.getState(arcRunKey(id)))?.lifecycle).toBe("active");
      release();
      const terminal = await settlement;
      await expect(queued).resolves.toEqual([]);
      expect(projectDialog).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(1);
      expect(append).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(await store.getState(arcRunKey(id))).toEqual(baseline.state);
      expect(await replayStore.listSteps(id)).toEqual(baseline.replay);
      expect(await replayStore.listCheckpoints(id)).toEqual(
        baseline.checkpoints,
      );
      expect(await workEventsFor(host).list(id)).toEqual(baseline.events);
      expect(time.pendingCount).toBe(baseline.deadlines);
      if (terminal.kind !== "action") throw new Error("Expected action");
      expect(terminal.frontier.status).toBe("completed");
      const retained = await host.advanceAction(
        id,
        terminal.frontier.frontierId,
        {
          instructionCoverage: {},
          projectDialog,
          reports: [],
        },
      );
      if (retained.kind !== "action") throw new Error("Expected action");
      expect(retained.frontier).toBe(terminal.frontier);
    } finally {
      release();
      serialized.mockRestore();
      start.mockRestore();
      write.mockRestore();
      append.mockRestore();
      checkpoint.mockRestore();
      host.stop();
    }
  });

  it("run.control-inactive retires failed execution while preserving terminal commit", async () => {
    const store = new InMemoryArcHostStore();
    const host = createTestArcHost({ store });
    await host.registerArc(
      "failed-commit",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $instruct("final"); }`,
      ),
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(host, dialog);
    const failure = new Error("commit acknowledgement failed");
    const put = store.putState.bind(store);
    const write = vi
      .spyOn(store, "putState")
      .mockImplementation(async (key, state) => {
        await put(key, state);
        if (state.lifecycle === "completed") throw failure;
      });
    const projectDialog = vi.fn(async () => dialog);
    try {
      await expect(
        host.advanceAction(driver.arcRunId, driver.frontier.frontierId, {
          reports: [],
          projectDialog,
          instructionCoverage: {
            [taskId(driver.frontier.tasks[0]!)]: "applied",
          },
        }),
      ).rejects.toBe(failure);
      const state = await store.getState(arcRunKey(driver.arcRunId));
      expect(state?.lifecycle).toBe("completed");
      const events = await workEventsFor(host).list(driver.arcRunId);
      write.mockClear();
      projectDialog.mockClear();
      await expect(
        host.begin({ arcRunId: driver.arcRunId, projectDialog }),
      ).resolves.toEqual([]);
      await expect(
        host.advanceAction(driver.arcRunId, driver.frontier.frontierId, {
          instructionCoverage: {},
          projectDialog,
          reports: [],
        }),
      ).rejects.toThrow(
        "Begin action execution before advancing its frontier.",
      );
      expect(await store.getState(arcRunKey(driver.arcRunId))).toEqual(state);
      expect(await workEventsFor(host).list(driver.arcRunId)).toEqual(events);
      expect(write).not.toHaveBeenCalled();
      expect(projectDialog).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      host.stop();
    }
  });

  it("lists live stages once with owner filtering and drops ephemeral views on restart without writes", async () => {
    const store = new InMemoryArcHostStore();
    const host = createTestArcHost({ store });
    await host.registerArc(
      "live-views",
      parse(
        `"arc"; function Main() { this.trigger = () => judge(\`ready\`); $instruct("Work"); }`,
      ),
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const [step] = await host.begin({
      dialog,
      principal: ALICE_OWNER,
      inbound: { content: "go" },
      projectDialog: projectorFor(dialog),
    });
    if (step?.kind !== "trigger") throw new Error("Expected trigger");
    expect(await host.getRunView(step.arcRunId)).toMatchObject({
      stage: "triggering",
      ownerPrincipal: ALICE_OWNER,
    });
    expect(await host.listRunViews(ALICE_OWNER)).toHaveLength(1);
    expect(await host.listRunViews("other")).toEqual([]);
    expect(await store.getState(arcRunKey(step.arcRunId))).toBeUndefined();
    const restarted = createTestArcHost({ store });
    expect(await restarted.listRunViews()).toEqual([]);
    expect(await restarted.getRunView(step.arcRunId)).toBeUndefined();
  });

  it("starts a scope:'arc' activation with a registered workspace path", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    const registeredWorkspacePath = "registered-stock-workspace";
    const expectedWorkspacePath = resolve(registeredWorkspacePath);
    await arcHost.registerArc(
      "stock-research",
      parse(GREET_SOURCE),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: registeredWorkspacePath },
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };

    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "research FIX" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });

    const driver = expectSoleDriver(begun);
    await expect(store.getState(arcRunKey(driver.arcRunId))).resolves.toEqual(
      expect.objectContaining({
        ownerPrincipal: ALICE_OWNER,
        workspacePath: expectedWorkspacePath,
      }),
    );
  });

  it("persists a resolved workspace path for run-scoped activations", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "arcade-run-root-"));
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store, artifactRoot });
    await arcHost.registerArc(
      "stock-research",
      parse(GREET_SOURCE),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/ignored-run-scope-workspace" },
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };

    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "research FIX" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });

    const driver = expectSoleDriver(begun);
    const expectedWorkspacePath = join(
      artifactRoot,
      driver.arcRunId.replaceAll(":", "-"),
    );
    await expect(store.getState(arcRunKey(driver.arcRunId))).resolves.toEqual(
      expect.objectContaining({
        workspacePath: expectedWorkspacePath,
      }),
    );
  });

  it("lists run views newest first, and across every owner when unfiltered", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE));
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "research FIX" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const driver = expectSoleDriver(begun);
    const base = await store.getState(arcRunKey(driver.arcRunId));
    if (!base) throw new Error("expected persisted run state");

    // Clone the activated run into two more, with owners and update times
    // chosen so listing order cannot coincide with insertion order.
    await store.putState(arcRunKey("arc-run:bob-oldest"), {
      ...base,
      arcRunId: "arc-run:bob-oldest",
      ownerPrincipal: "bob",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.putState(arcRunKey("arc-run:alice-newest"), {
      ...base,
      arcRunId: "arc-run:alice-newest",
      ownerPrincipal: ALICE_OWNER,
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    await store.putState(arcRunKey(driver.arcRunId), {
      ...base,
      updatedAt: "2026-03-01T00:00:00.000Z",
    });

    // No owner argument lists every principal's runs, newest updatedAt first.
    await expect(
      arcHost.listRunViews().then((views) => views.map((v) => v.arcRunId)),
    ).resolves.toEqual([
      "arc-run:alice-newest",
      driver.arcRunId,
      "arc-run:bob-oldest",
    ]);
    // An owner argument filters to that principal, keeping the same order.
    await expect(
      arcHost
        .listRunViews(ALICE_OWNER)
        .then((views) => views.map((v) => v.arcRunId)),
    ).resolves.toEqual(["arc-run:alice-newest", driver.arcRunId]);
    await expect(
      arcHost.listRunViews("bob").then((views) => views.map((v) => v.arcRunId)),
    ).resolves.toEqual(["arc-run:bob-oldest"]);
  });

  it("returns the workspace path and bundle for a run, live and from persisted state", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    const policy = {
      workspaceScope: "arc",
      bundle: { docs: "/srv/docs" },
      contextIsolation: "role",
    } as const;
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE), policy, {
      workspacePath: "/tmp/alice-stock-workspace",
    });
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "research FIX" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const { arcRunId } = expectSoleDriver(begun);

    // The live action session answers with the run's workspace and the arc's
    // bundle, resolved from the registered policy.
    await expect(arcHost.getRunWorkspaceContext(arcRunId)).resolves.toEqual({
      workspacePath: "/tmp/alice-stock-workspace",
      workspaceBundle: { docs: "/srv/docs" },
      reactivationCount: 0,
    });

    // A fresh service over the same store holds no live session, so the same
    // question is answered from persisted run state instead.
    const restarted = createTestArcHost({ store });
    await restarted.registerArc("stock-research", parse(GREET_SOURCE), policy, {
      workspacePath: "/tmp/alice-stock-workspace",
    });
    await expect(restarted.getRunWorkspaceContext(arcRunId)).resolves.toEqual({
      workspacePath: "/tmp/alice-stock-workspace",
      workspaceBundle: { docs: "/srv/docs" },
      reactivationCount: 0,
    });
  });

  it("reads workspace context from the live trigger session before run state exists", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "arcade-probe-root-"));
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store, artifactRoot });
    await arcHost.registerArc(
      "stock-research",
      parse(`
"arc";

function Stock() {
  this.trigger = () => {
    return judge(\`user wants stock research\`);
  };
  $instruct(\`Handle stock research.\`);
}
`),
      {
        workspaceScope: "arc",
        bundle: { docs: "/srv/docs" },
        contextIsolation: "role",
      },
      { workspacePath: "/tmp/registered-stock-workspace" },
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "start stock research" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "start stock research" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const trig = expectSoleTrigger(begun);

    // The probe has not activated, so nothing is persisted under its id — the
    // live trigger session is the only thing that can answer. It reports the
    // probe's provisional workspace, since the registered arc workspace is not
    // adopted until the fan-out mints the real run.
    await expect(
      store.getState(arcRunKey(trig.arcRunId)),
    ).resolves.toBeUndefined();
    await expect(
      arcHost.getRunWorkspaceContext(trig.arcRunId),
    ).resolves.toEqual({
      workspacePath: join(artifactRoot, trig.arcRunId.replaceAll(":", "-")),
      workspaceBundle: { docs: "/srv/docs" },
      reactivationCount: 0,
    });

    // Without that live session the persisted branch has nothing to read.
    const restarted = createTestArcHost({ store });
    await expect(
      restarted.getRunWorkspaceContext(trig.arcRunId),
    ).rejects.toThrow(/no workspace context/);
  });

  it("prunes an abandoned run workspace and keeps the live one", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "arcade-prune-live-"));
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store, artifactRoot });
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE));
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "research FIX" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "research FIX" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const { arcRunId } = expectSoleDriver(begun);
    const liveDir = join(artifactRoot, arcRunId.replaceAll(":", "-"));
    await mkdir(liveDir, { recursive: true });
    // A leftover from a trigger probe: shaped like a run workspace, but no run
    // state ever claimed the id.
    const orphanDir = join(
      artifactRoot,
      "arc-run-4f1d2c3b-9a8e-47d6-8b5a-1e2f3a4b5c6d",
    );
    await mkdir(orphanDir, { recursive: true });

    await expect(arcHost.pruneOrphanedRunWorkspaces()).resolves.toBe(1);

    await expect(readdir(artifactRoot)).resolves.toEqual([
      arcRunId.replaceAll(":", "-"),
    ]);
  });

  it("keeps a workspace directory that fails any pruning guard", async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "arcade-prune-guards-"));
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
      artifactRoot,
    });

    // Named as a run workspace and unclaimed, but holding content.
    const nonEmpty = join(
      artifactRoot,
      "arc-run-11111111-2222-3333-4444-555555555555",
    );
    await mkdir(nonEmpty, { recursive: true });
    await writeFile(join(nonEmpty, "report.md"), "findings");
    // Empty and unclaimed, but not named the way run workspaces are named —
    // an arc-scoped or discovered workspace parked under the artifact root.
    const foreign = join(artifactRoot, "alice-investments");
    await mkdir(foreign, { recursive: true });

    await expect(arcHost.pruneOrphanedRunWorkspaces()).resolves.toBe(0);

    await expect(
      readdir(artifactRoot).then((names) => names.sort()),
    ).resolves.toEqual([
      "alice-investments",
      "arc-run-11111111-2222-3333-4444-555555555555",
    ]);
    await expect(readFile(join(nonEmpty, "report.md"), "utf8")).resolves.toBe(
      "findings",
    );
  });

  it("reports nothing pruned when the artifact root does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-prune-absent-"));
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
      artifactRoot: join(root, "never-created"),
    });

    await expect(arcHost.pruneOrphanedRunWorkspaces()).resolves.toBe(0);
  });

  it("returns idle when no registered Arc triggers for the dialog", async () => {
    const arcHost = makeArcHost();
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "hello" }],
    };

    const turn = await arcHost.begin({
      arcRunId: ARC_RUN_ID,
      projectDialog: projectorFor(dialog),
    });

    expect(turn).toEqual([]);
  });

  it("begins an instruction from caller-provided dialog and commits coverage", async () => {
    const arcHost = await makeArcHostWithSource("greet", GREET_SOURCE);
    const dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user" as const, message: "hi" }],
    };

    const driver = await beginActivatedDriver(arcHost, dialog);
    const begun = driver.frontier;

    expect(begun.status).toBe("ready");
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        role: "greeter",
        texts: ["Welcome the user warmly."],
        arcRunId: driver.arcRunId,
        dialog,
      }),
    ]);

    const committed = await advanceView(
      driver,
      {
        cursor: { user: 0, self: 0 },
        lastTurns: [...dialog.lastTurns, { role: "self", message: "Welcome." }],
      },
      {
        reports: [],
        instructionCoverage: {
          [taskId(begun.tasks[0]!)]: "applied",
        },
      },
    );

    expect(committed.status).toBe("completed");
  });

  it("keeps explicit run lifecycles on the action driver path", async () => {
    const arcHost = await makeArcHostWithSource("greet", GREET_SOURCE);
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "hi" }],
    };

    const driver = await beginActivatedDriver(arcHost, dialog);
    expect(driver.kind).toBe("action");
    if (driver.kind !== "action") return;

    const advanced = await driver.advance({
      dialog: {
        cursor: { user: 0, self: 0 },
        lastTurns: [...dialog.lastTurns, { role: "self", message: "Welcome." }],
      },
      input: {
        reports: [],
        instructionCoverage: {
          [taskId(driver.frontier.tasks[0]!)]: "applied",
        },
      },
    });
    expect(advanced.kind).toBe("action");
    expect(advanced.driver.frontier.status).toBe("completed");
  });

  it("poisons a run when worker feedback reports failure", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "hi" }],
    };

    const begun = await beginActivation(arcHost, dialog, {
      inbound: inboundFromDialog(dialog),
      principal: ALICE_OWNER,
    });
    const driver = new StepDriver(arcHost, expectSoleDriver(begun));

    const advanced = await driver.advance({
      dialog,
      input: {
        reports: [
          {
            error: "failed",
            code: "worker-timeout",
            message: "Worker timed out.",
          },
        ],
        instructionCoverage: {
          [taskId(driver.frontier.tasks[0]!)]: "failed",
        },
      },
    });

    expect(advanced.kind).toBe("action");
    expect(advanced.driver.frontier.status).toBe("poisoned");
    expect(advanced.driver.frontier.issues).toEqual([
      expect.objectContaining({
        kind: "poisoned-traversal",
        reasonCode: "worker-timeout",
        reason: "Worker timed out.",
      }),
    ]);
    await expect(store.getState(arcRunKey(driver.arcRunId))).resolves.toEqual(
      expect.objectContaining({ lifecycle: "poisoned" }),
    );
  });

  it("keeps ready trigger work out of durable run state", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc(
      "ready",
      parse(`
"arc";

function CheckReady() {
  this.hostParams = {
    workerRole: "judge-runner",
  };
  this.trigger = () => {
    return judge(\`is the user ready\`);
  };
  $instruct(\`Welcome.\`);
}
`),
    );
    const dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user" as const, message: "hi" }],
    };

    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "hi" },
      principal: ALICE_OWNER,
    });

    const trig = expectSoleTrigger(begun);
    await expect(
      store.getState(arcRunKey(trig.arcRunId)),
    ).resolves.toBeUndefined();
  });

  it("persists trigger deps with activated run state and run views", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArcs([
      {
        source: "main",
        document: parse(`
"arc";
import { Helper } from "helper";

function Main() {
  this.trigger = () => {
    return true;
  };
  $enter(Helper);
}
`),
      },
      {
        source: "helper",
        document: parse(`
"arc";

function Helper() {
  this.hostParams = {
    workerRole: "helper",
  };
  $instruct(\`Help.\`);
}
`),
      },
    ]);

    const driver = await beginActivatedDriver(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    const begun = driver.frontier;

    expect(begun.deps).toEqual([
      toArcRef("main", "Main"),
      toArcRef("helper", "Helper"),
    ]);
    expect(begun.snapshotId).toMatch(/^arc-snapshot:/);
    await advanceView(
      driver,
      {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "self", message: "Helped." }],
      },
      {
        reports: [],
        instructionCoverage: {
          [taskId(begun.tasks[0]!)]: "applied",
        },
      },
    );
    const state = await store.getState(arcRunKey(driver.arcRunId));
    expect(state?.deps).toEqual(begun.deps);
    expect(state?.snapshotId).toBe(begun.snapshotId);
    const snapshot = await store.getArcDocumentSnapshot(state!.snapshotId);
    expect(snapshot?.documents).toHaveLength(2);
  });

  it("uses only the activating root manifest as the imported-node isolation floor", async () => {
    const mainSource = `
"arc";
import { Helper } from "helper";

function Main() {
  this.trigger = () => true;
  $enter(Helper);
}
`;
    const helperSource = `
"arc";

function Helper() {
  this.hostParams = {
    workerRole: "helper",
    contextIsolation: "role",
  };
  $instruct(\`Help.\`);
}
`;
    const nodeFloorStore = new InMemoryArcHostStore();
    const nodeFloorHost = createTestArcHost({ store: nodeFloorStore });
    await nodeFloorHost.registerArcs([
      {
        source: "main",
        document: parse(mainSource),
        manifest: {
          workspaceScope: "run",
          bundle: {},
          contextIsolation: "node",
        },
      },
      {
        source: "helper",
        document: parse(helperSource),
        manifest: {
          workspaceScope: "run",
          bundle: {},
          contextIsolation: "role",
        },
      },
    ]);

    const nodeFloorRun = await beginActivatedDriver(nodeFloorHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    expect(nodeFloorRun.frontier.tasks[0]).toMatchObject({
      kind: "instruction",
      contextIsolation: "node",
      sourceRef: "node:helper:Helper",
    });
    await expect(
      nodeFloorStore.getState(arcRunKey(nodeFloorRun.arcRunId)),
    ).resolves.toEqual(expect.objectContaining({ contextIsolation: "node" }));

    const roleFloorStore = new InMemoryArcHostStore();
    const roleFloorHost = createTestArcHost({ store: roleFloorStore });
    await roleFloorHost.registerArcs([
      {
        source: "main",
        document: parse(mainSource),
        manifest: {
          workspaceScope: "run",
          bundle: {},
          contextIsolation: "role",
        },
      },
      {
        source: "helper",
        document: parse(helperSource),
        manifest: {
          workspaceScope: "run",
          bundle: {},
          contextIsolation: "node",
        },
      },
    ]);

    const roleFloorRun = await beginActivatedDriver(roleFloorHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    expect(roleFloorRun.frontier.tasks[0]).toMatchObject({
      kind: "instruction",
      contextIsolation: "role",
      sourceRef: "node:helper:Helper",
    });
    await expect(
      roleFloorStore.getState(arcRunKey(roleFloorRun.arcRunId)),
    ).resolves.toEqual(expect.objectContaining({ contextIsolation: "role" }));
  });

  it("promotes a node host parameter and keeps its action semantic task node-local", async () => {
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc(
      "node-opt-in",
      parse(`
"arc";

function Main() {
  this.trigger = () => true;
  this.hostParams = {
    workerRole: "researcher",
    contextIsolation: "node",
  };
  if (judge(\`is the request ready\`)) {
    $instruct(\`Proceed.\`);
  }
}
`),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
    );

    const frontier = (
      await beginActivatedDriver(arcHost, {
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      })
    ).frontier;
    const task = frontier.tasks[0]!;
    expect(task).toMatchObject({
      kind: "semantic",
      stage: "action",
      contextIsolation: "node",
    });
    if (task.kind !== "semantic") return;
    expect(new Set(task.requests.map((request) => request.sourceRef))).toEqual(
      new Set(["node:node-opt-in:Main"]),
    );
  });

  it("applies replacement manifest isolation only to fresh runs", async () => {
    const source = `
"arc";

function Main() {
  this.trigger = () => true;
  $enter(First);
  $enter(Second);

  function First() {
    this.hostParams = { workerRole: "worker" };
    $instruct(\`First.\`);
  }

  function Second() {
    this.hostParams = { workerRole: "worker" };
    $instruct(\`Second.\`);
  }
}
`;
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("policy-replacement", parse(source), {
      workspaceScope: "run",
      bundle: {},
      contextIsolation: "role",
    });
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "run" }],
    };
    const existing = await beginActivatedDriver(arcHost, dialog);
    const firstTask = existing.frontier.tasks[0]!;
    expect(firstTask).toMatchObject({ contextIsolation: "role" });

    await arcHost.registerArc(
      "policy-replacement",
      parse(source),
      { workspaceScope: "run", bundle: {}, contextIsolation: "node" },
      { replace: true },
    );
    const continued = await advanceView(existing, dialog, {
      reports: [],
      instructionCoverage: { [taskId(firstTask)]: "applied" },
    });
    expect(continued.tasks[0]).toMatchObject({
      contextIsolation: "role",
      sourceRef: "node:policy-replacement:Main.Second",
    });
    await expect(store.getState(arcRunKey(existing.arcRunId))).resolves.toEqual(
      expect.objectContaining({ contextIsolation: "role" }),
    );

    const fresh = await beginActivatedDriver(arcHost, dialog, {
      principal: "bob",
    });
    expect(fresh.frontier.tasks[0]).toMatchObject({
      contextIsolation: "node",
      sourceRef: "node:policy-replacement:Main.First",
    });
    await expect(store.getState(arcRunKey(fresh.arcRunId))).resolves.toEqual(
      expect.objectContaining({ contextIsolation: "node" }),
    );
  });

  it("surfaces artifact instruction text as structured SemanticText", async () => {
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc(
      "artifact",
      parse(`
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  let log = Artifact("research/log.md");
  $instruct(\`Write findings to \${log}.\`);
}
`),
    );

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        role: "writer",
        texts: [
          [
            { kind: "text", value: "Write findings to " },
            { kind: "artifact", path: "research/log.md" },
            { kind: "text", value: "." },
          ],
        ],
      }),
    ]);
  });

  it("counts unique artifact paths as action briefs emit them", async () => {
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc(
      "artifact-count",
      parse(`
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };

  let shared = Artifact("notes/shared.md");
  let summary = Artifact("reports/summary.md");

  $enter(WriteNote);
  $enter(ReadNote);

  function WriteNote() {
    let local = Artifact("scratch/local.md");
    $instruct(\`Write \${shared} and \${local}.\`);
  }

  function ReadNote() {
    $instruct(\`Read \${shared} and update \${summary}.\`);
  }
}
`),
    );
    const dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    };

    const driver = await beginActivatedDriver(arcHost, dialog);

    await expect(arcHost.getRunView(driver.arcRunId)).resolves.toEqual(
      expect.objectContaining({ artifactCount: 2 }),
    );

    await advanceView(driver, dialog, {
      reports: [],
      instructionCoverage: {
        [taskId(driver.frontier.tasks[0]!)]: "applied",
      },
    });

    await expect(arcHost.getRunView(driver.arcRunId)).resolves.toEqual(
      expect.objectContaining({ artifactCount: 3 }),
    );
    await expect(arcHost.listRunViews(ALICE_OWNER)).resolves.toEqual([
      expect.objectContaining({ artifactCount: 3 }),
    ]);
  });

  it("keeps one artifact path reachable across writer and reader nodes", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "arcade-artifacts-"));
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
    });
    await arcHost.registerArc(
      "artifact-flow",
      parse(`
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  let note = Artifact("notes/shared.md");

  $enter(WriteNote);
  $enter(ReadNote);

  function WriteNote() {
    this.hostParams = {
      workerRole: "writer",
    };
    $instruct(\`Write the note into \${note}.\`);
  }

  function ReadNote() {
    this.hostParams = {
      workerRole: "reader",
    };
    $instruct(\`Read the note from \${note}.\`);
  }
}
`),
    );
    const dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const begun = driver.frontier;

    expect(begun.tasks).toEqual([
      expect.objectContaining({
        role: "writer",
        texts: [
          [
            { kind: "text", value: "Write the note into " },
            { kind: "artifact", path: "notes/shared.md" },
            { kind: "text", value: "." },
          ],
        ],
      }),
    ]);
    await mkdir(join(workspacePath, "notes"), { recursive: true });
    const notePath = join(workspacePath, "notes", "shared.md");
    await writeFile(notePath, "artifact text from writer", "utf8");

    const committed = await advanceView(driver, dialog, {
      reports: [],
      instructionCoverage: {
        [taskId(begun.tasks[0]!)]: "applied",
      },
    });

    expect(await readFile(notePath, "utf8")).toBe("artifact text from writer");
    expect(committed.tasks).toEqual([
      expect.objectContaining({
        role: "reader",
        texts: [
          [
            { kind: "text", value: "Read the note from " },
            { kind: "artifact", path: "notes/shared.md" },
            { kind: "text", value: "." },
          ],
        ],
      }),
    ]);
  });

  it("begins a run without requiring a live frontier", async () => {
    const arcHost = await makeArcHostWithSource("greet", GREET_SOURCE);

    const begun = await beginActivatedView(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });

    expect(begun.status).toBe("ready");
    expect(begun.tasks[0]).toEqual(
      expect.objectContaining({ role: "greeter" }),
    );
  });

  it("returns idle when beginning a run without state or trigger match", async () => {
    const arcHost = makeArcHost();
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };

    const begun = await arcHost.begin({
      arcRunId: ARC_RUN_ID,
      projectDialog: projectorFor(dialog),
    });

    expect(begun).toEqual([]);
  });

  it("re-yields unacknowledged instruction work from durable JSON state after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-host-"));
    const store = new JsonFileArcHostStore({ dir });
    const first = createTestArcHost({ store });
    await first.registerArc("greet", parse(GREET_SOURCE));
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    };
    const activated = await beginActivatedView(first, dialog);

    const second = createTestArcHost({ store });
    const restored = await beginView(second, activated.arcRunId, dialog);

    expect(restored.status).toBe("ready");
    expect(restored.briefs.instructions).toEqual(activated.briefs.instructions);
    const instruction = restored.tasks.find(
      (task) => task.kind === "instruction",
    );
    expect(instruction).toEqual(
      expect.objectContaining({
        kind: "instruction",
        phase: "apply",
        texts: ["Welcome the user warmly."],
      }),
    );

    const completedStep = await second.advanceAction(
      activated.arcRunId,
      restored.frontierId,
      {
        reports: [],
        projectDialog: projectorFor(dialog),
        instructionCoverage: {
          [taskId(instruction!)]: "applied",
        },
      },
    );
    expect(completedStep.kind).toBe("action");
    if (completedStep.kind !== "action") throw new Error("expected action");
    const completed = completedStep.frontier;

    expect(completed.status).toBe("completed");
    expect(completed.tasks).toEqual([]);
  });

  it("restores a postcheck frontier without redispatching its instruction", async () => {
    const store = new InMemoryArcHostStore();
    const first = createTestArcHost({ store });
    await first.registerArc(
      "persistent-restart",
      parse(`
"arc";

function Main() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "worker" };
  $instructLoop(\`Keep going.\`, {
    resolveWhen: \`the work is done\`,
  });
}
`),
    );
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const activated = await beginActivatedView(first, dialog);
    const instruction = activated.tasks.find(
      (task) => task.kind === "instruction",
    );
    const postcheckStep = await first.advanceAction(
      activated.arcRunId,
      activated.frontierId,
      {
        reports: [],
        projectDialog: projectorFor(dialog),
        instructionCoverage: {
          [taskId(instruction!)]: "applied",
        },
      },
    );
    expect(postcheckStep.kind).toBe("action");
    if (postcheckStep.kind !== "action") throw new Error("expected action");
    const postcheck = postcheckStep.frontier;
    expect(postcheck.briefs.instructions).toMatchObject([
      { text: "Keep going.", phase: "postcheck" },
    ]);
    expect(postcheck.briefs.judgments).toHaveLength(1);

    const second = createTestArcHost({ store });
    const restored = await beginView(second, activated.arcRunId, dialog);
    expect(restored.briefs.instructions).toEqual(postcheck.briefs.instructions);
    expect(restored.briefs.judgments).toEqual(postcheck.briefs.judgments);
    expect(restored.tasks.some((task) => task.kind === "instruction")).toBe(
      false,
    );

    const completedStep = await second.advanceAction(
      activated.arcRunId,
      restored.frontierId,
      {
        instructionCoverage: {},
        projectDialog: projectorFor(dialog),
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: { [restored.briefs.judgments[0]!.id]: true },
            },
          },
        ],
      },
    );
    expect(completedStep.kind).toBe("action");
    if (completedStep.kind !== "action") throw new Error("expected action");
    const completed = completedStep.frontier;
    expect(completed.status).toBe("completed");
  });

  it("logs begun and committed lifecycle events for a run", async () => {
    const store = new InMemoryArcHostStore();
    const { logger, records } = createCapturingLogger("info");
    const arcHost = createTestArcHost({ store, logger });
    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    const driver = await beginActivatedDriver(arcHost, {
      cursor: { user: 0, self: 0 },
      lastTurns: [],
    });
    const begun = driver.frontier;
    await advanceView(
      driver,
      {
        cursor: { user: 0, self: 0 },
        lastTurns: [{ role: "self", message: "Welcome." }],
      },
      {
        reports: [],
        instructionCoverage: {
          [taskId(begun.tasks[0]!)]: "applied",
        },
      },
    );

    expect(
      records
        .filter((record) => record.arcRunId === driver.arcRunId)
        .map((record) => record.event),
    ).toEqual(["arc_host.run.begun", "arc_host.run.committed"]);
  });

  it("does not choose a workspace handshake from ambiguous trigger deps", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc(
      "scratchpad",
      parse(`
"arc";

function Scratchpad() {
  this.trigger = () => {
    return judge(\`user wants scratchpad notes\`);
  };
  $instruct(\`Handle scratchpad notes.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    await arcHost.registerArc(
      "stock-research",
      parse(`
"arc";

function Stock() {
  this.trigger = () => {
    return judge(\`user wants stock research\`);
  };
  $instruct(\`Handle stock research.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );

    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "start stock research" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "start stock research" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });

    const trig = expectSoleTrigger(begun);
    expect(trig.frontier.status).toBe("ready");
    expect(trig.frontier.briefs.judgments).toHaveLength(2);
    await expect(store.getState(arcRunKey(trig.arcRunId))).resolves.toBe(
      undefined,
    );
  });

  it("carries activationPolicy through a semantic-trigger round-trip (fan-out honors the request)", async () => {
    // Guards the ActivationRequest-on-live-session lift: a semantic trigger that
    // round-trips (begin → trigger driver → advance) must fan out under the
    // caller's policy, not silently regress to "first". Two always-matching arcs
    // with registered workspaces activate directly under policy "all".
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc(
      "alpha",
      parse(`
"arc";
function Alpha() {
  this.trigger = () => { return judge(\`match\`); };
  $instruct(\`Alpha.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/alpha-ws" },
    );
    await arcHost.registerArc(
      "beta",
      parse(`
"arc";
function Beta() {
  this.trigger = () => { return judge(\`match\`); };
  $instruct(\`Beta.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/beta-ws" },
    );

    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "go" }],
    };
    const begun = await arcHost.begin({
      dialog,
      inbound: { content: "go" },
      principal: ALICE_OWNER,
      clientId: "client-1",
      activationPolicy: "all",
      projectDialog: projectorFor(dialog),
    });
    const trig = expectSoleTrigger(begun);

    const advanced = await arcHost.advanceTrigger(trig.arcRunId, dialog, {
      instructionCoverage: {},
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              trig.frontier.briefs.judgments.map((judgment) => [
                judgment.id,
                true,
              ]),
            ),
          },
        },
      ],
    });

    // Policy "all" survived the round-trip on the live session: BOTH arcs
    // activate, not just the first.
    const actions = advanced.filter((step) => step.kind === "action");
    expect(actions).toHaveLength(2);
    expect(actions.map((step) => step.frontier.arcRef).sort()).toEqual(
      [toArcRef("alpha", "Alpha"), toArcRef("beta", "Beta")].sort(),
    );
    // One-identity invariant: the fan-out yields two steps with DISTINCT run
    // ids — plurality lives in the array, never inside a step.
    const runIds = actions.map((step) => step.arcRunId);
    expect(new Set(runIds).size).toBe(2);
  });

  it("carries distinct execution and preparation identities across a mixed fan-out", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc(
      "ready",
      parse(`
"arc";
function Ready() {
  this.trigger = () => { return true; };
  $instruct(\`Ready.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/ready-ws" },
    );
    await arcHost.registerArc(
      "gated",
      parse(`
"arc";
function Gated() {
  this.trigger = () => { return true; };
  $instruct(\`Gated.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );

    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "go" }],
    };
    const begun = await arcHost.begin({
      dialog,
      inbound: { content: "go" },
      principal: ALICE_OWNER,
      activationPolicy: "all",
      projectDialog: projectorFor(dialog),
    });

    const action = begun.find((step) => step.kind === "action");
    const handshake = begun.find((step) => step.kind === "handshake");
    expect(action?.kind).toBe("action");
    expect(handshake?.kind).toBe("handshake");
    if (action?.kind !== "action" || handshake?.kind !== "handshake") return;

    expect(typeof action.arcRunId).toBe("string");
    expect(typeof handshake.handshakeId).toBe("string");
    expect(handshake.arcRef).toBe(toArcRef("gated", "Gated"));
    expect(handshake.arcRunId).not.toBe(action.arcRunId);
    expect(await arcHost.getRunView(handshake.arcRunId)).toMatchObject({
      stage: "handshaking",
      handshakeId: handshake.handshakeId,
    });
  });

  it("uses registered workspace for a trigger-stage fresh activation", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc(
      "scratchpad",
      parse(`
"arc";

function Scratchpad() {
  this.trigger = () => {
    return judge(\`user wants scratchpad notes\`);
  };
  $instruct(\`Handle scratchpad notes.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    await arcHost.registerArc(
      "stock-research",
      parse(`
"arc";

function Stock() {
  this.trigger = () => {
    return judge(\`user wants stock research\`);
  };
  $instruct(\`Handle stock research.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/registered-stock-workspace" },
    );

    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "start stock research" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "start stock research" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const trig = expectSoleTrigger(begun);
    const advanced = await arcHost.advanceTrigger(trig.arcRunId, dialog, {
      instructionCoverage: {},
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              trig.frontier.briefs.judgments.map((judgment) => [
                judgment.id,
                judgment.sourceRef.includes("stock-research"),
              ]),
            ),
          },
        },
      ],
    });

    const advancedDriver = expectSoleDriver(advanced);
    await expect(
      store.getState(arcRunKey(advancedDriver.arcRunId)),
    ).resolves.toEqual(
      expect.objectContaining({
        ownerPrincipal: ALICE_OWNER,
        workspacePath: "/tmp/registered-stock-workspace",
      }),
    );

    const again = await beginActivation(arcHost, dialog, {
      inbound: { content: "start stock research" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const againTrig = expectSoleTrigger(again);
    const repeated = await arcHost.advanceTrigger(againTrig.arcRunId, dialog, {
      instructionCoverage: {},
      projectDialog: projectorFor(dialog),
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              againTrig.frontier.briefs.judgments.map((judgment) => [
                judgment.id,
                judgment.sourceRef.includes("stock-research"),
              ]),
            ),
          },
        },
      ],
    });
    expect(expectSoleHandshake(repeated).requirement).toEqual(
      expect.objectContaining({ kind: "run-choice" }),
    );
  });

  it("closes unresolved trigger activation when semantic trigger work fails", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc(
      "scratchpad",
      parse(`
"arc";

function Scratchpad() {
  this.trigger = () => {
    return judge(\`user wants scratchpad notes\`);
  };
  $instruct(\`Handle scratchpad notes.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    await arcHost.registerArc(
      "stock-research",
      parse(`
"arc";

function Stock() {
  this.trigger = () => {
    return judge(\`user wants stock research\`);
  };
  $instruct(\`Handle stock research.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );

    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "start stock research" }],
    };
    const begun = await beginActivation(arcHost, dialog, {
      inbound: { content: "start stock research" },
      clientId: "client-1",
      principal: ALICE_OWNER,
    });
    const trig = expectSoleTrigger(begun);

    await expect(
      arcHost.advanceTrigger(trig.arcRunId, dialog, {
        instructionCoverage: {},
        projectDialog: projectorFor(dialog),
        reports: trig.frontier.briefs.judgments.map((judgment) => ({
          error: "failed" as const,
          code: "semantic-failed",
          message: `Could not resolve ${judgment.id}.`,
        })),
      }),
    ).resolves.toEqual([]);
    await expect(arcHost.listRunViews()).resolves.toEqual([]);
    await expect(store.getState(arcRunKey(trig.arcRunId))).resolves.toBe(
      undefined,
    );
  });

  it("trigger-plans and re-enters a deflected run under the same id", async () => {
    const store = new InMemoryArcHostStore();
    const replay = new InMemoryReplayStore();
    const arcHost = createTestArcHost({ store, replayStore: replay });
    await arcHost.registerArc(
      "wait",
      parse(`"arc";

function Main() {
  this.trigger = () => true;
  this.forgetfulEntry = true;
  $enter(Wait);

  function Wait() {
    this.guard = () => State.DEFLECTED;
  }
}`),
    );
    const firstDialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "first event" }],
    };
    const first = await beginActivatedDriver(arcHost, firstDialog);
    const root = first.frontier.traversals.find(
      (traversal) => traversal.ref === first.frontier.arcRef,
    );

    expect(root).toMatchObject({ phase: "suspended", state: "deflected" });

    const secondDialog: Dialog = {
      cursor: { user: 2, self: 0 },
      lastTurns: [{ role: "user", message: "second event" }],
    };
    const second = await beginActivation(arcHost, secondDialog, {
      inbound: inboundFromDialog(secondDialog),
      principal: ALICE_OWNER,
    });
    const handshake = expectSoleHandshake(second);
    expect(handshake.requirement).toMatchObject({
      kind: "run-choice",
      freshAvailable: true,
      candidates: [
        expect.objectContaining({
          arcRunId: first.arcRunId,
          lifecycle: "deflected",
        }),
      ],
    });

    const resolved = await arcHost.resolveHandshake(
      handshake.handshakeId,
      { runChoice: { action: "join", arcRunId: first.arcRunId } },
      {
        projectDialog: projectorFor(secondDialog),
      },
    );
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok" || resolved.step.kind !== "action") return;
    expect(resolved.step.arcRunId).toBe(first.arcRunId);
    const reenteredFrontier = resolved.step.frontier;
    const restartedRoot = reenteredFrontier.traversals.find(
      (traversal) => traversal.ref === reenteredFrontier.arcRef,
    );
    expect(restartedRoot).toMatchObject({
      phase: "suspended",
      state: "deflected",
      enterCount: 2,
    });
    expect(
      new Set(
        (await replay.listCheckpoints(first.arcRunId)).map(
          (checkpoint) => checkpoint.position.reactivationCount,
        ),
      ),
    ).toEqual(new Set([0, 1]));
    const verified = await arcHost.verifyReplay(
      first.arcRunId,
      toArcRef("wait", "Main"),
    );
    expect(verified.status).toBe("compatible");
    if (verified.status !== "compatible") return;
    expect(
      verified.regenerated.checkpoints.some(
        (checkpoint) => checkpoint.position.reactivationCount === 1,
      ),
    ).toBe(true);
    const rewound = await arcHost.rewind(first.arcRunId, {
      stage: "action",
      index: 0,
      reactivationCount: 1,
    });
    expect(rewound.arcRunId).not.toBe(first.arcRunId);
  });

  it("ignores and replaces an uncommitted reactivation after re-entry fails", async () => {
    const store = new InMemoryArcHostStore();
    const replay = new InMemoryReplayStore();
    const arcHost = createTestArcHost({ store, replayStore: replay });
    await arcHost.registerArc(
      "failed-reentry",
      parse(`"arc";
function Main() {
  this.trigger = () => true;
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const first = await beginActivatedDriver(arcHost, dialog);
    const failedChoice = expectSoleHandshake(
      await beginActivation(arcHost, dialog, {
        inbound: inboundFromDialog(dialog),
        principal: ALICE_OWNER,
      }),
    );

    await expect(
      arcHost.resolveHandshake(
        failedChoice.handshakeId,
        { runChoice: { action: "join", arcRunId: first.arcRunId } },
        {
          projectDialog: async () => {
            throw new Error("projection failed");
          },
        },
      ),
    ).rejects.toThrow("projection failed");
    await expect(store.getState(arcRunKey(first.arcRunId))).resolves.toEqual(
      expect.objectContaining({ reactivationCount: 0 }),
    );
    expect(
      (await replay.listSteps(first.arcRunId)).some(
        (step) => step.position.reactivationCount === 1,
      ),
    ).toBe(true);
    await expect(
      arcHost.verifyReplay(first.arcRunId, toArcRef("failed-reentry", "Main"), {
        untilPosition: { stage: "action", index: 0, reactivationCount: 1 },
      }),
    ).rejects.toThrow("newer than committed reactivation count 0");

    const verified = await arcHost.verifyReplay(
      first.arcRunId,
      toArcRef("failed-reentry", "Main"),
    );
    expect(verified.status).toBe("compatible");
    if (verified.status !== "compatible") return;
    expect(
      verified.regenerated.triggerSteps.every(
        (step) => step.position.reactivationCount === 0,
      ),
    ).toBe(true);

    const retryChoice = expectSoleHandshake(
      await beginActivation(arcHost, dialog, {
        inbound: inboundFromDialog(dialog),
        principal: ALICE_OWNER,
      }),
    );
    const retried = await arcHost.resolveHandshake(
      retryChoice.handshakeId,
      { runChoice: { action: "join", arcRunId: first.arcRunId } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(retried.status).toBe("ok");
    await expect(store.getState(arcRunKey(first.arcRunId))).resolves.toEqual(
      expect.objectContaining({ reactivationCount: 1 }),
    );
    expect(
      new Set(
        (await replay.listCheckpoints(first.arcRunId)).map(
          (checkpoint) => checkpoint.position.reactivationCount,
        ),
      ),
    ).toEqual(new Set([0, 1]));
  });

  it("serializes concurrent re-entry of the same deflected run", async () => {
    const store = new InMemoryArcHostStore();
    const replay = new InMemoryReplayStore();
    const arcHost = createTestArcHost({ store, replayStore: replay });
    await arcHost.registerArc(
      "concurrent-reentry",
      parse(`"arc";
function Main() {
  this.trigger = () => true;
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const first = await beginActivatedDriver(arcHost, dialog);
    const handshakes = await Promise.all(
      [0, 1].map(async () =>
        expectSoleHandshake(
          await beginActivation(arcHost, dialog, {
            inbound: inboundFromDialog(dialog),
            principal: ALICE_OWNER,
          }),
        ),
      ),
    );

    const results = await Promise.all(
      handshakes.map((handshake) =>
        arcHost.resolveHandshake(
          handshake.handshakeId,
          { runChoice: { action: "join", arcRunId: first.arcRunId } },
          { projectDialog: projectorFor(dialog) },
        ),
      ),
    );
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "invalid"),
    ).toHaveLength(1);
    await expect(store.getState(arcRunKey(first.arcRunId))).resolves.toEqual(
      expect.objectContaining({ reactivationCount: 1 }),
    );
    expect(
      new Set(
        (await replay.listCheckpoints(first.arcRunId)).map(
          (checkpoint) => checkpoint.position.reactivationCount,
        ),
      ),
    ).toEqual(new Set([0, 1]));
  });

  it("offers a pinned deflected run when the latest Arc trigger no longer matches", async () => {
    const source = (word: string) => `"arc";
function Main() {
  this.trigger = () => /${word}/.test(Dialog.lastUserMessage);
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`;
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("watch", parse(source("old")));
    const oldDialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "old event" }],
    };
    const first = await beginActivatedDriver(arcHost, oldDialog);

    await arcHost.registerArc(
      "watch",
      parse(source("new")),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );

    const planned = await beginActivation(arcHost, oldDialog, {
      inbound: inboundFromDialog(oldDialog),
      principal: ALICE_OWNER,
    });
    const handshake = expectSoleHandshake(planned);
    expect(handshake.requirement).toMatchObject({
      kind: "run-choice",
      freshAvailable: false,
      candidates: [expect.objectContaining({ arcRunId: first.arcRunId })],
    });
    await expect(
      arcHost.resolveHandshake(
        handshake.handshakeId,
        { runChoice: { action: "fresh" } },
        {
          projectDialog: projectorFor(oldDialog),
        },
      ),
    ).resolves.toMatchObject({ status: "invalid" });

    const reentered = await arcHost.resolveHandshake(
      handshake.handshakeId,
      { runChoice: { action: "join", arcRunId: first.arcRunId } },
      { projectDialog: projectorFor(oldDialog) },
    );
    expect(reentered.status).toBe("ok");
    if (reentered.status !== "ok" || reentered.step.kind !== "action") return;
    expect(reentered.step.arcRunId).toBe(first.arcRunId);
    await expect(store.getState(arcRunKey(first.arcRunId))).resolves.toEqual(
      expect.objectContaining({ snapshotId: first.frontier.snapshotId }),
    );
  });

  it("offers fresh and pinned re-entry after a replacement when both triggers match", async () => {
    const source = (revision: string) => `"arc";
function Main() {
  this.description = "${revision}";
  this.trigger = () => /event/.test(Dialog.lastUserMessage);
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`;
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("both-match", parse(source("revision one")));
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const existing = await beginActivatedDriver(arcHost, dialog);
    const originalSnapshot = existing.frontier.snapshotId;
    await arcHost.registerArc(
      "both-match",
      parse(source("revision two")),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );

    const handshake = expectSoleHandshake(
      await beginActivation(arcHost, dialog, {
        inbound: inboundFromDialog(dialog),
        principal: ALICE_OWNER,
      }),
    );
    expect(handshake.requirement).toMatchObject({
      kind: "run-choice",
      freshAvailable: true,
      candidates: [expect.objectContaining({ arcRunId: existing.arcRunId })],
    });
    const reentered = await arcHost.resolveHandshake(
      handshake.handshakeId,
      { runChoice: { action: "join", arcRunId: existing.arcRunId } },
      { projectDialog: projectorFor(dialog) },
    );
    expect(reentered.status).toBe("ok");
    if (reentered.status !== "ok" || reentered.step.kind !== "action") return;
    expect(reentered.step.arcRunId).toBe(existing.arcRunId);
    expect(reentered.step.frontier.snapshotId).toBe(originalSnapshot);
  });

  it("starts fresh from the replacement when its trigger matches and the pinned trigger does not", async () => {
    const source = (word: string) => `"arc";
function Main() {
  this.trigger = () => /${word}/.test(Dialog.lastUserMessage);
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`;
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("replacement-only", parse(source("old")));
    const oldDialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "old" }],
    };
    const existing = await beginActivatedDriver(arcHost, oldDialog);
    await arcHost.registerArc(
      "replacement-only",
      parse(source("new")),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );
    const newDialog: Dialog = {
      cursor: { user: 2, self: 0 },
      lastTurns: [{ role: "user", message: "new" }],
    };

    const fresh = expectSoleDriver(
      await beginActivation(arcHost, newDialog, {
        inbound: inboundFromDialog(newDialog),
        principal: ALICE_OWNER,
      }),
    );
    expect(fresh.arcRunId).not.toBe(existing.arcRunId);
    expect(fresh.frontier.snapshotId).not.toBe(existing.frontier.snapshotId);
    await expect(store.getState(arcRunKey(existing.arcRunId))).resolves.toEqual(
      expect.objectContaining({ lifecycle: "deflected" }),
    );
  });

  it("applies first policy by probe order rather than match settlement order", async () => {
    const deflectedSource = (matches: boolean) => `"arc";
function Pinned() {
  this.trigger = () => ${matches};
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`;
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("pinned-order", parse(deflectedSource(true)));
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    await beginActivatedDriver(arcHost, dialog);
    await arcHost.registerArc(
      "pinned-order",
      parse(deflectedSource(false)),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );
    await arcHost.registerArc(
      "fresh-order",
      parse(`"arc";
function Fresh() {
  this.trigger = () => judge("fresh match");
  $instruct("Fresh wins first policy.");
}`),
    );
    const probe = expectSoleTrigger(
      await arcHost.begin({
        dialog,
        inbound: inboundFromDialog(dialog),
        principal: ALICE_OWNER,
        activationPolicy: "first",
        projectDialog: projectorFor(dialog),
      }),
    );

    const settled = expectSoleDriver(
      await arcHost.advanceTrigger(probe.arcRunId, dialog, {
        instructionCoverage: {},
        projectDialog: projectorFor(dialog),
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: {
                [probe.frontier.briefs.judgments[0]!.id]: true,
              },
            },
          },
        ],
      }),
    );
    expect(settled.frontier.arcRef).toBe(toArcRef("fresh-order", "Fresh"));
  });

  it("finalizes a concurrently settled activation batch only once", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc(
      "semantic-race",
      parse(`"arc";
function Main() {
  this.trigger = () => judge("event matches");
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const firstProbe = expectSoleTrigger(
      await beginActivation(arcHost, dialog, {
        inbound: inboundFromDialog(dialog),
        principal: ALICE_OWNER,
      }),
    );
    const first = expectSoleDriver(
      await arcHost.advanceTrigger(firstProbe.arcRunId, dialog, {
        instructionCoverage: {},
        projectDialog: projectorFor(dialog),
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: {
                [firstProbe.frontier.briefs.judgments[0]!.id]: true,
              },
            },
          },
        ],
      }),
    );
    const probes = (await beginActivation(arcHost, dialog, {
      inbound: inboundFromDialog(dialog),
      principal: ALICE_OWNER,
    })) as TriggerStep[];
    expect(probes).toHaveLength(2);

    const results = await Promise.all(
      probes.map((probe) =>
        arcHost.advanceTrigger(probe.arcRunId, dialog, {
          instructionCoverage: {},
          projectDialog: projectorFor(dialog),
          reports: [
            {
              outcome: "completed",
              semantic: {
                judgments: {
                  [probe.frontier.briefs.judgments[0]!.id]: true,
                },
              },
            },
          ],
        }),
      ),
    );
    const steps = results.flat();
    expect(steps).toHaveLength(1);
    expect(expectSoleHandshake(steps).requirement).toMatchObject({
      kind: "run-choice",
      candidates: [expect.objectContaining({ arcRunId: first.arcRunId })],
    });
  });

  it("retires only the failed trigger probe and finalizes successful sibling matches", async () => {
    for (const failureFirst of [true, false]) {
      const store = new InMemoryArcHostStore();
      const arcHost = createTestArcHost({ store });
      await arcHost.registerArc(
        "failed-batch",
        parse(`"arc";
function Main() {
  this.trigger = () => judge("event matches");
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`),
      );
      const dialog: Dialog = {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "event" }],
      };
      const begin = () =>
        beginActivation(arcHost, dialog, {
          inbound: inboundFromDialog(dialog),
          principal: ALICE_OWNER,
        });
      const match = (probe: TriggerStep) =>
        arcHost.advanceTrigger(probe.arcRunId, dialog, {
          instructionCoverage: {},
          projectDialog: projectorFor(dialog),
          reports: [
            {
              outcome: "completed",
              semantic: {
                judgments: { [probe.frontier.briefs.judgments[0]!.id]: true },
              },
            },
          ],
        });
      const initial = expectSoleTrigger(await begin());
      const deflected = expectSoleDriver(await match(initial));
      const prior = await store.getState(arcRunKey(deflected.arcRunId));
      expect(prior?.lifecycle).toBe("deflected");

      const probes = (await begin()) as TriggerStep[];
      expect(probes).toHaveLength(2);
      if (!failureFirst) await expect(match(probes[1]!)).resolves.toEqual([]);
      const failedSteps = await arcHost.advanceTrigger(
        probes[0]!.arcRunId,
        dialog,
        {
          instructionCoverage: {},
          projectDialog: projectorFor(dialog),
          reports: [
            {
              error: "failed",
              code: "provider-failed",
              message: "Provider refused work.",
            },
          ],
        },
      );
      if (failureFirst) expect(failedSteps).toEqual([]);
      const settled = failureFirst ? await match(probes[1]!) : failedSteps;
      expect(expectSoleHandshake(settled).requirement).toMatchObject({
        kind: "run-choice",
        candidates: [expect.objectContaining({ arcRunId: deflected.arcRunId })],
      });
      await expect(arcHost.listRunViews()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            arcRunId: deflected.arcRunId,
            lifecycle: "deflected",
          }),
        ]),
      );
      await expect(
        store.getState(arcRunKey(deflected.arcRunId)),
      ).resolves.toEqual(prior);
    }
  });

  it("pins a fresh semantic probe to the documents current when probing began", async () => {
    const source = (label: string) => `"arc";
function Main() {
  this.trigger = () => judge("event matches");
  $instruct("${label}");
}`;
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    const v1 = parse(source("revision one"));
    await arcHost.registerArc("snapshot-race", v1);
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const probe = expectSoleTrigger(
      await beginActivation(arcHost, dialog, {
        inbound: inboundFromDialog(dialog),
        principal: ALICE_OWNER,
      }),
    );
    await arcHost.registerArc(
      "snapshot-race",
      parse(source("revision two")),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );

    const activated = expectSoleDriver(
      await arcHost.advanceTrigger(probe.arcRunId, dialog, {
        instructionCoverage: {},
        projectDialog: projectorFor(dialog),
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: {
                [probe.frontier.briefs.judgments[0]!.id]: true,
              },
            },
          },
        ],
      }),
    );
    const state = await store.getState(arcRunKey(activated.arcRunId));
    const snapshot = await store.getArcDocumentSnapshot(state!.snapshotId);
    const record = await store.getArcDocumentRecord(snapshot!.documents[0]!);
    expect(record?.document).toEqual(v1);
    expect(activated.frontier.tasks[0]).toMatchObject({
      texts: ["revision one"],
    });
  });

  it("expires unresolved activation probes without later activating them", async () => {
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
      activationBatchTtlMs: 5,
    });
    await arcHost.registerArc(
      "expiring-probe",
      parse(`"arc";
function Main() { this.trigger = () => judge("event matches"); }
`),
    );
    const dialog: Dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "event" }],
    };
    const probe = expectSoleTrigger(
      await beginActivation(arcHost, dialog, {
        inbound: inboundFromDialog(dialog),
        principal: ALICE_OWNER,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      arcHost.advanceTrigger(probe.arcRunId, dialog, {
        instructionCoverage: {},
        projectDialog: projectorFor(dialog),
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: {
                [probe.frontier.briefs.judgments[0]!.id]: true,
              },
            },
          },
        ],
      }),
    ).resolves.toEqual([]);
  });

  it("commits a deflect move when a report deflects on a judgment-only brief", async () => {
    const arcHost = await makeArcHostWithSource("ready", DEFLECTABLE_SOURCE);
    const dialog: Dialog = {
      cursor: { user: 0, self: 0 },
      lastTurns: [{ role: "user", message: "hi" }],
    };
    const driver = await beginActivatedDriver(arcHost, dialog);
    const begun = driver.frontier;

    expect(begun.status).toBe("ready");
    expect(begun.allowedMoves).toContain("deflect");
    expect(begun.briefs.judgments).toHaveLength(1);
    expect(begun.tasks).toEqual([
      expect.objectContaining({
        kind: "semantic",
        role: "judge-runner",
      }),
    ]);

    const committed = await advanceView(driver, dialog, {
      instructionCoverage: {},
      reports: [{ outcome: "deflected" }],
    });

    expect(committed.canProgress).toBe(false);
    const root = committed.traversals.find(
      (traversal) => traversal.ref === begun.arcRef,
    );
    expect(root).toMatchObject({
      phase: "suspended",
      state: "deflected",
    });
  });
});
