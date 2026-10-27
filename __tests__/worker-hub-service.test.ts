import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import type { Backend, RoutineInput, RoutineReport } from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  WorkerHubService,
  type ArcHostService,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  collectAsync,
  makeArcHost,
  makeArcHostWithSource,
  WATCH_SOURCE,
} from "./helpers.js";
import { settleFirstRoutine, submitActivation } from "./worker-hub-helpers.js";

describe("Worker hub worker selection", () => {
  it("routes an explicit role slot before an in-process registration", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const configured = vi.fn(async () => ({ outcome: "completed" }) as const);
    const embedded = vi.fn(
      async () => ({ outcome: "disposition", deflect: {} }) as const,
    );
    const workerHub = await createWorkerHub(arcHost);
    workerHub.addBackend(
      "configured-agent",
      workerBackend(["role"], configured),
    );
    workerHub.registerRoleWorker("researcher", embedded);
    await workerHub.start({
      workers: { roles: { researcher: { backend: "configured-agent" } } },
    });

    await settleFirstRoutine(workerHub, executionControlFor(arcHost));

    expect(configured).toHaveBeenCalledOnce();
    expect(embedded).not.toHaveBeenCalled();
  });

  it("routes an in-process registration before the default worker slot", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const fallback = vi.fn(
      async () => ({ outcome: "disposition", deflect: {} }) as const,
    );
    const embedded = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = await createWorkerHub(arcHost);
    workerHub.addBackend("default-agent", workerBackend(["default"], fallback));
    workerHub.registerRoleWorker("researcher", embedded);
    await workerHub.start({
      workers: { default: { backend: "default-agent" } },
    });

    await settleFirstRoutine(workerHub, executionControlFor(arcHost));

    expect(embedded).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("routes an unbound role through the default worker slot", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const fallback = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = await createWorkerHub(arcHost);
    workerHub.addBackend("default-agent", workerBackend(["default"], fallback));
    await workerHub.start({
      workers: { default: { backend: "default-agent" } },
    });

    await settleFirstRoutine(workerHub, executionControlFor(arcHost));

    expect(fallback).toHaveBeenCalledOnce();
  });

  it("persists a terminal failed routine when no worker slot resolves", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const routineStore = executionControlFor(arcHost);
    const workerHub = await createWorkerHub(arcHost, routineStore);
    await workerHub.start();

    const { arcRunId } = await settleFirstRoutine(workerHub, routineStore);

    const routines = await collectAsync(routineStore.listRoutines(arcRunId));
    expect(routines).toEqual([
      expect.objectContaining({
        backend: "fail",
        status: "finished",
        error: expect.objectContaining({ code: "role-not-delegated" }),
      }),
    ]);
    expect(await workerHub.listWorkEvents(arcRunId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:failed",
          error: expect.objectContaining({ code: "role-not-delegated" }),
        }),
      ]),
    );
  });

  it("persists the selected registry backend on the routine", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const routineStore = executionControlFor(arcHost);
    const workerHub = await createWorkerHub(arcHost, routineStore);
    workerHub.addBackend(
      "selected-agent",
      workerBackend(["role"], async () => ({ outcome: "completed" })),
    );
    await workerHub.start({
      workers: { roles: { researcher: { backend: "selected-agent" } } },
    });

    const { routine } = await settleFirstRoutine(workerHub, routineStore);

    expect(routine.backend).toBe("selected-agent");
  });

  it("routes trigger-stage semantic work through the configured fast-trigger worker slot", async () => {
    const arcHost = await makeArcHostWithSource(
      "judged",
      JUDGED_TRIGGER_SOURCE,
    );
    // A declined trigger activates nothing, so only trigger work runs.
    const fast = vi.fn(async (input: RoutineInput) =>
      semanticAnswer(input, false),
    );
    const ordinary = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = await makeConfiguredRoutingHub(arcHost, fast, ordinary);
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    await collectAsync(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      }),
    );

    expect(fast).toHaveBeenCalledOnce();
    expect(ordinary).not.toHaveBeenCalled();
  });

  it("routes action-stage semantic work through the role or default worker slot", async () => {
    const arcHost = await makeArcHostWithSource(
      "observed",
      `"arc";
function Watch() {
  this.trigger = () => true;
  let ready = Bool({ observing: "ready?" });
  $observe(ready);
}`,
    );
    const fast = vi.fn(async () => ({ outcome: "completed" }) as const);
    const ordinary = vi.fn(async (input: RoutineInput) =>
      semanticAnswer(input, true),
    );
    const workerHub = await makeConfiguredRoutingHub(arcHost, fast, ordinary);
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    await settleFirstRoutine(workerHub, executionControlFor(arcHost));

    expect(ordinary).toHaveBeenCalledOnce();
    expect(fast).not.toHaveBeenCalled();
  });

  it("routes instruction work through the role or default worker slot", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const fast = vi.fn(async () => ({ outcome: "completed" }) as const);
    const ordinary = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = await makeConfiguredRoutingHub(arcHost, fast, ordinary);
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    await settleFirstRoutine(workerHub, executionControlFor(arcHost));

    expect(ordinary).toHaveBeenCalledOnce();
    expect(fast).not.toHaveBeenCalled();
  });

  it("overlaps different roles and trigger action contexts on one shared default worker", async () => {
    const arcHost = await makeArcHost();
    await arcHost.registerArc("researcher", parse(roleSource("researcher")));
    await arcHost.registerArc("reviewer", parse(roleSource("reviewer")));
    const inputs: RoutineInput[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workerHub = await createWorkerHub(arcHost);
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
            return input.routine.task.kind === "semantic"
              ? semanticAnswer(input, false)
              : { outcome: "completed" };
          },
        };
      },
    });
    await workerHub.start({
      workers: { default: { backend: "shared" }, fastTrigger: null },
    });
    // Two action runs, then a trigger probe from a second submission.
    const actions = collectAsync(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
      }),
    );
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    await arcHost.registerArc("judged", parse(JUDGED_TRIGGER_SOURCE));
    const trigger = collectAsync(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    try {
      await vi.waitFor(() => expect(inputs).toHaveLength(3));
      expect(created).toBe(1);
      expect(
        new Set(inputs.map((input) => input.routine.contextKey)).size,
      ).toBe(3);
      expect(
        inputs
          .map((input) => {
            const task = input.routine.task;
            return task.kind === "semantic"
              ? `${task.kind}:${task.stage}`
              : `${task.kind}:${task.role}`;
          })
          .sort(),
      ).toEqual([
        "instruction:researcher",
        "instruction:reviewer",
        "semantic:trigger",
      ]);
    } finally {
      release();
      await Promise.allSettled([actions, trigger]);
      await workerHub.stop();
    }
  });

  it("allows same-role trigger and action work to overlap across selected backends", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (input: RoutineInput) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return input.routine.task.kind === "semantic"
        ? semanticAnswer(input, false)
        : ({ outcome: "completed" } as const);
    };
    const workerHub = await createWorkerHub(arcHost);
    workerHub.addBackend("ordinary-agent", workerBackend(["default"], run));
    workerHub.addBackend("fast-agent", workerBackend(["fast-trigger"], run));
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "fast-agent" },
      },
    });

    // The researcher instruction runs first, then a researcher trigger probe.
    const ordinary = submitActivation(workerHub, "start");
    await vi.waitFor(() => expect(active).toBe(1));
    await arcHost.registerArc(
      "judged",
      parse(`"arc";
function Judged() {
  this.trigger = () => judge("should this start?");
  this.hostParams = { workerRole: "researcher" };
}`),
    );
    const fast = collectAsync(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    await vi.waitFor(() => expect(active).toBe(2));
    release();
    await Promise.allSettled([fast, ordinary]);

    expect(maximum).toBe(2);
  });
});

const JUDGED_TRIGGER_SOURCE = `"arc";
function Judged() {
  this.trigger = () => judge("should this start?");
}`;

function roleSource(role: string): string {
  return `"arc";
function Work() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "${role}" };
  $instruct(\`Do the ${role} work.\`);
}`;
}

/** Answer every semantic request of the routine's task with one value. */
function semanticAnswer(input: RoutineInput, value: boolean): RoutineReport {
  const task = input.routine.task;
  const requests = task.kind === "semantic" ? task.requests : [];
  return {
    outcome: "completed",
    semantic: {
      judgments: Object.fromEntries(
        requests
          .filter((request) => request.kind === "judgment")
          .map((request) => [request.briefId, value]),
      ),
      observations: Object.fromEntries(
        requests
          .filter((request) => request.kind === "observation")
          .map((request) => [request.briefId, { status: "resolved", value }]),
      ),
    },
  };
}

async function createWorkerHub(
  arcHost?: ArcHostService,
  routineStore?: ReturnType<typeof executionControlFor>,
): Promise<WorkerHubService> {
  arcHost ??= await makeArcHost();
  return new WorkerHubService({
    arcHost,
    historyStore: new InMemoryHistoryStore(),
    routineStore: routineStore ?? executionControlFor(arcHost),
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

async function makeConfiguredRoutingHub(
  arcHost: ArcHostService,
  fast: (input: RoutineInput) => Promise<unknown>,
  ordinary: (input: RoutineInput) => Promise<unknown>,
): Promise<WorkerHubService> {
  const workerHub = await createWorkerHub(arcHost);
  workerHub.addBackend("fast-agent", workerBackend(["fast-trigger"], fast));
  workerHub.addBackend("ordinary-agent", workerBackend(["default"], ordinary));
  return workerHub;
}
