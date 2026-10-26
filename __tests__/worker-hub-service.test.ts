import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import type { Backend, RoutineInput } from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  WorkerHubService,
  type ArcHostService,
  type InstructionTask,
  type SemanticTask,
  type Task,
} from "../src/testing.js";
import { collectAsync, firstTaskWithArcHost, makeArcHost } from "./helpers.js";
import { routineContext } from "./worker-hub-helpers.js";

describe("Worker hub worker selection", () => {
  it("routes an explicit role slot before an in-process registration", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const configured = vi.fn(async () => ({ outcome: "completed" }) as const);
    const embedded = vi.fn(
      async () => ({ outcome: "disposition", deflect: {} }) as const,
    );
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend(
      "configured-agent",
      workerBackend(["role"], configured),
    );
    workerHub.registerRoleWorker("researcher", embedded);
    await workerHub.start({
      workers: { roles: { researcher: { backend: "configured-agent" } } },
    });

    await workerHub.handleTask(task, routineContext());

    expect(configured).toHaveBeenCalledOnce();
    expect(embedded).not.toHaveBeenCalled();
  });

  it("routes an in-process registration before the default worker slot", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const fallback = vi.fn(
      async () => ({ outcome: "disposition", deflect: {} }) as const,
    );
    const embedded = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend("default-agent", workerBackend(["default"], fallback));
    workerHub.registerRoleWorker("researcher", embedded);
    await workerHub.start({
      workers: { default: { backend: "default-agent" } },
    });

    await workerHub.handleTask(task, routineContext());

    expect(embedded).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("routes an unbound role through the default worker slot", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const fallback = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend("default-agent", workerBackend(["default"], fallback));
    await workerHub.start({
      workers: { default: { backend: "default-agent" } },
    });

    await workerHub.handleTask(task, routineContext());

    expect(fallback).toHaveBeenCalledOnce();
  });

  it("persists a terminal failed routine when no worker slot resolves", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    const workerHub = createWorkerHub(arcHost, routineStore);
    await workerHub.start();

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { error: "failed", code: "role-not-delegated" },
    });
    const routines = await collectAsync(
      routineStore.listRoutines(task.arcRunId),
    );
    expect(routines).toEqual([
      expect.objectContaining({
        backend: "fail",
        status: "finished",
        error: expect.objectContaining({ code: "role-not-delegated" }),
      }),
    ]);
    expect(await workerHub.listWorkEvents(task.arcRunId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:failed",
          error: expect.objectContaining({ code: "role-not-delegated" }),
        }),
      ]),
    );
  });

  it("persists the selected registry backend on the routine", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    const workerHub = createWorkerHub(arcHost, routineStore);
    workerHub.addBackend(
      "selected-agent",
      workerBackend(["role"], async () => ({ outcome: "completed" })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "selected-agent" } } },
    });

    await workerHub.handleTask(task, routineContext());

    const routines = await collectAsync(
      routineStore.listRoutines(task.arcRunId),
    );
    expect(routines[0]?.backend).toBe("selected-agent");
  });

  it("routes trigger-stage semantic work through the configured fast-trigger worker slot", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const fast = vi.fn(async () => ({ outcome: "completed" }) as const);
    const ordinary = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = makeConfiguredRoutingHub(arcHost, fast, ordinary);
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    await workerHub.handleTask(
      semanticTask(instruction, "trigger"),
      routineContext(),
    );

    expect(fast).toHaveBeenCalledOnce();
    expect(ordinary).not.toHaveBeenCalled();
  });

  it("routes action-stage semantic work through the role or default worker slot", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const fast = vi.fn(async () => ({ outcome: "completed" }) as const);
    const ordinary = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = makeConfiguredRoutingHub(arcHost, fast, ordinary);
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    await workerHub.handleTask(
      semanticTask(instruction, "action"),
      routineContext(),
    );

    expect(ordinary).toHaveBeenCalledOnce();
    expect(fast).not.toHaveBeenCalled();
  });

  it("routes instruction work through the role or default worker slot", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const fast = vi.fn(async () => ({ outcome: "completed" }) as const);
    const ordinary = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = makeConfiguredRoutingHub(arcHost, fast, ordinary);
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    await workerHub.handleTask(task, routineContext());

    expect(ordinary).toHaveBeenCalledOnce();
    expect(fast).not.toHaveBeenCalled();
  });

  it("does not select fast-trigger routing from a nonexistent frontier field", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const fast = vi.fn(async () => ({ outcome: "completed" }) as const);
    const ordinary = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = makeConfiguredRoutingHub(arcHost, fast, ordinary);
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });
    const task = {
      ...semanticTask(instruction, "action"),
      frontierKind: "trigger",
    } as unknown as Task;

    await workerHub.handleTask(task, routineContext());

    expect(ordinary).toHaveBeenCalledOnce();
    expect(fast).not.toHaveBeenCalled();
  });

  it("overlaps different roles and trigger action contexts on one shared default worker", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const inputs: RoutineInput[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workerHub = createWorkerHub(arcHost);
    let created = 0;
    workerHub.addBackend("shared", {
      supportedSlotKinds: new Set(["default"]),
      createWorker: () => {
        created++;
        return {
          disposeRoutine: async () => {},
          run: async (input) => {
            inputs.push(input);
            await gate;
            return { outcome: "completed" };
          },
        };
      },
    });
    await workerHub.start({
      workers: { default: { backend: "shared" }, fastTrigger: null },
    });
    const tasks: Task[] = [
      instruction,
      { ...instruction, role: "reviewer" },
      { ...semanticTask(instruction, "trigger"), role: "trigger-reviewer" },
    ];
    const pending = tasks.map((task) =>
      workerHub.handleTask(task, routineContext()),
    );
    try {
      await vi.waitFor(() => expect(inputs).toHaveLength(3));
      expect(created).toBe(1);
      expect(
        new Set(inputs.map((input) => input.routine.contextKey)).size,
      ).toBe(3);
      expect(inputs.map((input) => input.routine.role).sort()).toEqual(
        tasks.map((task) => task.role).sort(),
      );
    } finally {
      release();
      await Promise.allSettled(pending);
      await workerHub.stop();
    }
  });

  it("allows same-role trigger and action work to overlap across selected backends", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return { outcome: "completed" } as const;
    };
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend("ordinary-agent", workerBackend(["default"], run));
    workerHub.addBackend("fast-agent", workerBackend(["fast-trigger"], run));
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    const fast = workerHub.handleTask(
      semanticTask(instruction, "trigger"),
      routineContext(),
    );
    const ordinary = workerHub.handleTask(instruction, routineContext());
    await vi.waitFor(() => expect(active).toBe(2));
    release();
    await Promise.all([fast, ordinary]);

    expect(maximum).toBe(2);
  });
});

function createWorkerHub(
  arcHost: ArcHostService = makeArcHost(),
  routineStore = executionControlFor(arcHost),
): WorkerHubService {
  return new WorkerHubService({
    arcHost,
    historyStore: new InMemoryHistoryStore(),
    routineStore,
    workEvents: workEventsFor(arcHost),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(tmpdir(), "arcade-worker-hub-selection-tests"),
    ),
    capacityRetry: { enabled: false },
  });
}

function workerBackend(
  kinds: readonly ("default" | "role" | "fast-trigger")[],
  run: (input: RoutineInput) => Promise<unknown>,
): Backend {
  return {
    supportedSlotKinds: new Set(kinds),
    createWorker: () => ({ disposeRoutine: async () => {}, run: run as never }),
  };
}

function makeConfiguredRoutingHub(
  arcHost: ArcHostService,
  fast: (input: RoutineInput) => Promise<unknown>,
  ordinary: (input: RoutineInput) => Promise<unknown>,
): WorkerHubService {
  const workerHub = createWorkerHub(arcHost);
  workerHub.addBackend("fast-agent", workerBackend(["fast-trigger"], fast));
  workerHub.addBackend("ordinary-agent", workerBackend(["default"], ordinary));
  return workerHub;
}

function semanticTask(
  instruction: InstructionTask,
  stage: "trigger" | "action",
): SemanticTask {
  return {
    kind: "semantic",
    allowedDispositions: [],
    batchId: `semantic:routing:${stage}`,
    role: instruction.role,
    stage,
    contextIsolation: instruction.contextIsolation,
    arcRunId: instruction.arcRunId,
    dialog: instruction.dialog,
    activeInstruction: instruction,
    requests: [],
  };
}
