import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  type RoleWorker,
  type RoutineReport,
  type Task,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  collectAsync,
  createCapturingLogger,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";

const failure: RoutineReport = {
  error: "failed",
  code: "test-worker-failed",
  message: "Worker cannot continue.",
};
const park: RoutineReport = {
  suspension: "transport-lost",
  reason: { reason: "connection reset", message: "Lost connection." },
};
const capacity: RoutineReport = {
  suspension: "capacity-limited",
  reason: { reason: "api rate limit", provider: "test", message: "Try later." },
};
const inbound = {
  content: "start",
  metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
};

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function completed(task: Task): RoutineReport {
  return task.kind === "semantic"
    ? {
        outcome: "completed",
        semantic: {
          judgments: Object.fromEntries(
            task.requests
              .filter((request) => request.kind === "judgment")
              .map((request) => [request.briefId, true]),
          ),
        },
      }
    : { outcome: "completed" };
}

async function fixture(
  stage: "trigger" | "action",
  run: RoleWorker,
  extra: Partial<Parameters<typeof makeWorkerHub>[0]> = {},
) {
  const arcHost = await makeArcHostWithSource(
    "failure-boundary",
    `"arc";
function Main() {
  this.trigger = () => ${stage === "trigger" ? 'judge("start")' : "true"};
  $instruct(\`Do the work.\`);
}`,
  );
  const hub = makeWorkerHub({
    arcHost,
    backends: {
      controlled: {
        supportedSlotKinds: new Set(["default"]),
        createWorker: () => ({
          disposeRoutine: async () => {},
          run: (input) => run(input.routine.task, input.context, input.effects),
        }),
      },
    },
    workerSlots: { default: "controlled" },
    ...extra,
  });
  return { arcHost, ...hub };
}

describe("Submission failure settlement and executor boundaries", () => {
  it("propagates executor storage and publication errors without converting them to queue exhaustion", async () => {
    for (const stage of ["trigger", "action"] as const) {
      for (const boundary of [
        "setup",
        "initial-routine",
        "routine",
        "started-event",
        "failed-event",
        "bookkeeping",
      ] as const) {
        const setup = await fixture(stage, async () => failure);
        const error = new Error(`${stage} ${boundary} unavailable`);
        const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
        const [step] = await setup.arcHost.begin({
          dialog,
          inbound,
          principal: ALICE_OWNER,
          projectDialog: async () => dialog,
        });
        if (step?.kind !== "trigger" && step?.kind !== "action")
          throw new Error("Expected work.");
        const task = step.frontier.tasks[0]!;
        const context = await setup.arcHost.getRunWorkspaceContext(
          task.arcRunId,
        );
        const put = setup.routineStore.putRoutine.bind(setup.routineStore);
        const append = setup.workEventStore.appendEvent.bind(
          setup.workEventStore,
        );
        let injected = false;
        if (boundary === "setup") {
          injected = true;
          vi.spyOn(
            setup.arcHost,
            "getRunWorkspaceContext",
          ).mockRejectedValueOnce(error);
        }
        if (boundary === "initial-routine") {
          injected = true;
          vi.spyOn(setup.routineStore, "putRoutine").mockRejectedValueOnce(
            error,
          );
        }
        if (boundary === "routine")
          vi.spyOn(setup.routineStore, "putRoutine").mockImplementation(
            async (routine) => {
              if (!injected && routine.status === "finished") {
                injected = true;
                throw error;
              }
              await put(routine);
            },
          );
        if (boundary === "started-event" || boundary === "failed-event")
          vi.spyOn(setup.workEventStore, "appendEvent").mockImplementation(
            async (event) => {
              if (
                !injected &&
                event.kind ===
                  (boundary === "started-event"
                    ? "routine:started"
                    : "routine:failed")
              ) {
                injected = true;
                throw error;
              }
              return append(event);
            },
          );
        if (boundary === "bookkeeping") {
          const getControl = setup.routineStore.getExecutionControl.bind(
            setup.routineStore,
          );
          vi.spyOn(
            setup.routineStore,
            "getExecutionControl",
          ).mockImplementation(async (id) => {
            const routines = await collectAsync(
              setup.routineStore.listRoutines(id),
            );
            if (routines.some((routine) => routine.status === "finished")) {
              injected = true;
              throw error;
            }
            return getControl(id);
          });
        }
        try {
          await expect(setup.workerHub.handleTask(task, context)).rejects.toBe(
            error,
          );
          expect(injected).toBe(true);
          const routines = await collectAsync(
            setup.routineStore.listRoutines(),
          );
          expect(
            routines.some((routine) => routine.error?.code === "queue-full"),
          ).toBe(false);
          expect(
            (await setup.workerHub.listWorkEvents(task.arcRunId)).some(
              (event) => event.kind === "routine:skipped",
            ),
          ).toBe(false);
        } finally {
          await setup.workerHub.stop();
        }
      }
    }
  });

  it("rejects trigger admission when failed-routine evidence cannot be stored", async () => {
    for (const boundary of ["routine", "event"] as const) {
      const setup = await fixture("trigger", async () => failure);
      const error = new Error(`Cannot store failed ${boundary}.`);
      let injected = false;
      const put = setup.routineStore.putRoutine.bind(setup.routineStore);
      const append = setup.workEventStore.appendEvent.bind(
        setup.workEventStore,
      );
      vi.spyOn(setup.routineStore, "putRoutine").mockImplementation(
        async (routine) => {
          if (
            boundary === "routine" &&
            !injected &&
            routine.status === "finished"
          ) {
            injected = true;
            throw error;
          }
          await put(routine);
        },
      );
      vi.spyOn(setup.workEventStore, "appendEvent").mockImplementation(
        async (event) => {
          if (
            boundary === "event" &&
            !injected &&
            event.kind === "routine:failed"
          ) {
            injected = true;
            throw error;
          }
          return append(event);
        },
      );
      try {
        await expect(
          collectAsync(setup.workerHub.submitInbound(inbound)),
        ).rejects.toBe(error);
        const routines = await collectAsync(setup.routineStore.listRoutines());
        expect(routines).toHaveLength(1);
        expect(routines[0]!.status).not.toBe("skipped");
      } finally {
        await setup.workerHub.stop();
      }
    }
  });

  it("keeps genuine limiter rejection distinct from reported worker failure", async () => {
    for (const stage of ["trigger", "action"] as const) {
      const entered = barrier();
      const release = barrier();
      const setup = await fixture(
        stage,
        async () => {
          entered.resolve();
          await release.promise;
          return failure;
        },
        { maxQueueSize: 0 },
      );
      const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
      const [step] = await setup.arcHost.begin({
        dialog,
        inbound,
        principal: ALICE_OWNER,
        projectDialog: async () => dialog,
      });
      if (step?.kind !== "trigger" && step?.kind !== "action")
        throw new Error("Expected work.");
      const task = step.frontier.tasks[0]!;
      const context = await setup.arcHost.getRunWorkspaceContext(task.arcRunId);
      try {
        const active = setup.workerHub.handleTask(task, context);
        await entered.promise;
        await expect(
          setup.workerHub.handleTask(
            task.kind === "semantic" && task.stage === "trigger"
              ? { ...task, batchId: `${task.batchId}:independent` }
              : { ...task, contextIsolation: "node" },
            context,
          ),
        ).resolves.toMatchObject({
          status: "skipped",
          error: { code: "queue-full" },
        });
        release.resolve();
        await expect(active).resolves.toEqual({
          status: "finished",
          routineId: expect.any(String),
          report: failure,
        });
      } finally {
        release.resolve();
        await setup.workerHub.stop();
      }
    }
  });

  it("normalizes worker exceptions and invalid reports in both execution stages", async () => {
    for (const stage of ["trigger", "action"] as const) {
      for (const mode of ["throws", "invalid"] as const) {
        const setup = await fixture(stage, async () => {
          if (mode === "throws") throw new Error("Worker crashed.");
          return { outcome: "nonsense" } as unknown as RoutineReport;
        });
        try {
          const events = await collectAsync(
            setup.workerHub.submitInbound(inbound),
          );
          await waitFor(async () =>
            (await collectAsync(setup.routineStore.listRoutines())).some(
              (routine) => routine.status === "finished",
            ),
          );
          const [routine] = await collectAsync(
            setup.routineStore.listRoutines(),
          );
          expect(routine?.error).toMatchObject({
            code: "backend-error",
            message: expect.any(String),
          });
          if (stage === "trigger")
            expect(events).toEqual([
              {
                kind: "failed",
                arcRunId: routine!.arcRunId,
                routineId: routine!.id,
                reason: routine!.error!.message,
              },
            ]);
          else {
            expect(events).toEqual([
              expect.objectContaining({ kind: "activated" }),
            ]);
            await waitFor(async () =>
              (await setup.workerHub.listWorkEvents(routine!.arcRunId)).some(
                (event) => event.kind === "run:poisoned",
              ),
            );
          }
        } finally {
          await setup.workerHub.stop();
        }
      }
    }
  });

  it("settles a parked trigger's original channel when resumed work reports failure", async () => {
    for (const interrupt of [park, capacity]) {
      let calls = 0;
      const captured = createCapturingLogger();
      const setup = await fixture(
        "trigger",
        async () => (++calls === 1 ? interrupt : failure),
        { logger: captured.logger },
      );
      try {
        const iterator = setup.workerHub
          .submitInbound(inbound)
          [Symbol.asyncIterator]();
        const pending = iterator.next();
        await waitFor(() =>
          captured.records.some(
            (record) => record.event === "worker_hub.lap.finished",
          ),
        );
        const [routine] = await collectAsync(setup.routineStore.listRoutines());
        await expect(
          setup.workerHub.resume(routine!.arcRunId),
        ).resolves.toMatchObject({ outcome: "resumed" });
        await expect(pending).resolves.toEqual({
          done: false,
          value: {
            kind: "failed",
            arcRunId: routine!.arcRunId,
            routineId: routine!.id,
            reason: failure.message,
          },
        });
        await expect(iterator.next()).resolves.toEqual({
          done: true,
          value: undefined,
        });
        expect(await setup.workerHub.listWorkEvents(routine!.arcRunId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "routine:failed",
              routineId: routine!.id,
              error: { code: "test-worker-failed", message: failure.message },
            }),
          ]),
        );
        await expect(
          setup.workerHub.resume(routine!.arcRunId),
        ).resolves.toMatchObject({ outcome: "missing" });
      } finally {
        await setup.workerHub.stop();
      }
    }
  });

  it("propagates resumed trigger and action operational errors to their owning boundaries", async () => {
    for (const stage of ["trigger", "action"] as const) {
      for (const boundary of ["setup", "routine", "event"] as const) {
        let calls = 0;
        const captured = createCapturingLogger();
        const setup = await fixture(
          stage,
          async () => (++calls === 1 ? park : failure),
          { logger: captured.logger },
        );
        const error = new Error(`resumed ${stage} ${boundary} unavailable`);
        const pending = collectAsync(setup.workerHub.submitInbound(inbound));
        // Attach rejection handling before resumed work can fail.
        const settled = pending.then(
          (events) => ({ events }),
          (error: unknown) => ({ error }),
        );
        let probeId = "";
        await waitFor(async () => {
          const routines = await collectAsync(
            setup.routineStore.listRoutines(),
          );
          probeId = routines[0]?.arcRunId ?? "";
          return (
            routines[0]?.status === "transport-lost" &&
            (await setup.arcHost.getRunView(probeId)) !== undefined
          );
        });
        await waitFor(async () =>
          captured.records.some(
            (record) => record.event === "worker_hub.lap.finished",
          ),
        );
        if (boundary === "setup")
          vi.spyOn(
            setup.arcHost,
            "getRunWorkspaceContext",
          ).mockRejectedValueOnce(error);
        if (boundary === "routine") {
          const put = setup.routineStore.putRoutine.bind(setup.routineStore);
          vi.spyOn(setup.routineStore, "putRoutine").mockImplementation(
            async (routine) => {
              if (routine.status === "finished") throw error;
              await put(routine);
            },
          );
        }
        if (boundary === "event") {
          const append = setup.workEventStore.appendEvent.bind(
            setup.workEventStore,
          );
          vi.spyOn(setup.workEventStore, "appendEvent").mockImplementation(
            async (event) => {
              if (event.kind === "routine:failed") throw error;
              return append(event);
            },
          );
        }
        try {
          if (boundary === "setup")
            await expect(setup.workerHub.resume(probeId)).rejects.toBe(error);
          else {
            await setup.workerHub.resume(probeId);
            await waitFor(() =>
              captured.records.some(
                (record) => record.event === "worker_hub.routine.resume.failed",
              ),
            );
          }
          if (stage === "trigger") {
            await expect(settled).resolves.toEqual({ error });
            await expect(
              setup.workerHub.resume(probeId),
            ).resolves.toMatchObject({ outcome: "missing" });
          } else {
            expect(await settled).toMatchObject({
              events: [expect.objectContaining({ kind: "activated" })],
            });
            expect((await setup.arcHost.getRunView(probeId))?.stage).toBe(
              "actioning",
            );
          }
          expect(
            (await collectAsync(setup.routineStore.listRoutines())).some(
              (routine) => routine.error?.code === "queue-full",
            ),
          ).toBe(false);
          expect(
            (await setup.workerHub.listWorkEvents(probeId)).some(
              (event) => event.kind === "run:poisoned",
            ),
          ).toBe(false);
        } finally {
          await setup.workerHub.stop();
        }
      }
    }
  });

  it("preserves parked siblings and their retries after another trigger probe fails", async () => {
    for (const interruption of [park, capacity]) {
      for (const timing of ["parked", "late-park"] as const) {
        const host = await makeArcHostWithSource(
          "sibling-failure",
          `"arc";
function Main() { this.trigger = () => judge("start"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }`,
        );
        const failGate = barrier();
        const parkGate = barrier();
        const callbacks: (() => void)[] = [];
        const cancel = vi.fn();
        const capture = createCapturingLogger();
        let seed = true;
        let calls = 0;
        let siblingId = "";
        const setup = makeWorkerHub({
          arcHost: host,
          workers: {
            [DEFAULT_WORKER_ROLE]: async (task) => {
              if (seed) return completed(task);
              calls++;
              if (calls === 1) {
                await failGate.promise;
                return failure;
              }
              siblingId = task.arcRunId;
              if (calls === 2) {
                await parkGate.promise;
                return interruption;
              }
              return failure;
            },
          },
          defaultConcurrency: 2,
          logger: capture.logger,
          capacityRetry: {
            enabled: true,
            schedule: (callback) => {
              callbacks.push(callback);
              return cancel;
            },
          },
        });
        try {
          await collectAsync(setup.workerHub.submitInbound(inbound));
          seed = false;
          const iterator = setup.workerHub
            .submitInbound(inbound)
            [Symbol.asyncIterator]();
          const first = iterator.next();
          await waitFor(() => calls === 2);
          const parked = () =>
            waitFor(() =>
              capture.records.some(
                (record) =>
                  record.event === "worker_hub.lap.finished" &&
                  record.arcRunId === siblingId,
              ),
            );
          if (timing === "parked") {
            parkGate.resolve();
            await parked();
          }
          failGate.resolve();
          const failed = await first;
          expect(failed).toMatchObject({
            done: false,
            value: {
              kind: "failed",
              routineId: expect.any(String),
              reason: failure.message,
            },
          });
          parkGate.resolve();
          await parked();
          expect((await host.getRunView(siblingId))?.stage).toBe("triggering");
          expect(cancel).not.toHaveBeenCalled();
          let closed = false;
          const second = iterator.next().then((value) => {
            closed = value.done === true;
            return value;
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(closed).toBe(false);
          if (interruption === capacity) {
            expect(callbacks).toHaveLength(1);
            callbacks[0]!();
          } else
            await expect(
              setup.workerHub.resume(siblingId),
            ).resolves.toMatchObject({ outcome: "resumed" });
          const failedSibling = await second;
          expect(failedSibling).toMatchObject({
            done: false,
            value: {
              kind: "failed",
              arcRunId: siblingId,
              routineId: expect.any(String),
              reason: failure.message,
            },
          });
          expect(failedSibling.value).not.toEqual(failed.value);
          expect(await iterator.next()).toEqual({
            done: true,
            value: undefined,
          });
          expect(calls).toBe(3);
        } finally {
          failGate.resolve();
          parkGate.resolve();
          await setup.workerHub.stop();
        }
      }
    }
  });

  it("keeps sibling admission open when activated action infrastructure fails", async () => {
    const capture = createCapturingLogger();
    const setup = await fixture("action", async () => failure, {
      logger: capture.logger,
    });
    await setup.arcHost.registerArc(
      "scoped",
      parse(`"arc";
function Scoped() { this.trigger = () => true; $instruct("Work in the selected workspace."); }`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    const put = setup.routineStore.putRoutine.bind(setup.routineStore);
    let injected = false;
    vi.spyOn(setup.routineStore, "putRoutine").mockImplementation(
      async (routine) => {
        if (!injected && routine.status === "finished") {
          injected = true;
          throw new Error("Action routine store unavailable.");
        }
        await put(routine);
      },
    );
    try {
      const iterator = setup.workerHub
        .submitInbound(inbound)
        [Symbol.asyncIterator]();
      const events = [
        (await iterator.next()).value,
        (await iterator.next()).value,
      ];
      const gate = events.find((event) => event?.kind === "handshake-required");
      if (gate?.kind !== "handshake-required")
        throw new Error("Expected workspace handshake.");
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "activated" }),
      );
      await waitFor(() =>
        capture.records.some(
          (record) => record.event === "worker_hub.lap.failed",
        ),
      );
      await expect(
        setup.workerHub.handshake(gate.handshakeId, { workspace: "/tmp" }),
      ).resolves.toMatchObject({ status: "ok" });
      expect((await iterator.next()).value).toMatchObject({
        kind: "activated",
      });
      expect(await iterator.next()).toEqual({ done: true, value: undefined });
      expect(injected).toBe(true);
    } finally {
      await setup.workerHub.stop();
    }
  });

  it("discards late parked results at the closed submission boundary", async () => {
    const host = await makeArcHostWithSource(
      "late-infrastructure-result",
      `"arc";
function Main() { this.trigger = () => judge("start"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }`,
    );
    let seed = true;
    let calls = 0;
    let siblingId = "";
    const failGate = barrier();
    const parkGate = barrier();
    const cancel = vi.fn();
    const setup = makeWorkerHub({
      arcHost: host,
      defaultConcurrency: 2,
      workers: {
        [DEFAULT_WORKER_ROLE]: async (task) => {
          if (seed) return completed(task);
          if (++calls === 1) {
            await failGate.promise;
            return failure;
          }
          siblingId = task.arcRunId;
          await parkGate.promise;
          return capacity;
        },
      },
      capacityRetry: { enabled: true, schedule: () => cancel },
    });
    try {
      await collectAsync(setup.workerHub.submitInbound(inbound));
      seed = false;
      const error = new Error("Event store unavailable.");
      const append = setup.workEventStore.appendEvent.bind(
        setup.workEventStore,
      );
      vi.spyOn(setup.workEventStore, "appendEvent").mockImplementation(
        (event) => {
          if (event.kind === "routine:failed") return Promise.reject(error);
          return append(event);
        },
      );
      const pending = collectAsync(setup.workerHub.submitInbound(inbound));
      const rejected = expect(pending).rejects.toBe(error);
      await waitFor(() => calls === 2);
      failGate.resolve();
      await rejected;
      parkGate.resolve();
      // In-flight work may finish and persist its result; publication discards
      // the continuation because its submission no longer exists.
      await waitFor(() => cancel.mock.calls.length > 0);
      expect(
        (await collectAsync(setup.routineStore.listRoutines(siblingId)))[0]
          ?.status,
      ).toBe("capacity-limited");
      await expect(setup.workerHub.resume(siblingId)).resolves.toMatchObject({
        outcome: "missing",
      });
      expect(calls).toBe(2);
    } finally {
      failGate.resolve();
      parkGate.resolve();
      await setup.workerHub.stop();
    }
  });

  it("dispatches successful sibling activation when the last probe fails", async () => {
    const host = await makeArcHostWithSource(
      "mixed-failure",
      `"arc";
function Main() { this.trigger = () => judge("start"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }`,
    );
    let seed = true;
    let calls = 0;
    const failGate = barrier();
    const capture = createCapturingLogger();
    let successfulProbe = "";
    const setup = makeWorkerHub({
      arcHost: host,
      logger: capture.logger,
      defaultConcurrency: 2,
      workers: {
        [DEFAULT_WORKER_ROLE]: async (task) => {
          if (seed) return completed(task);
          calls += 1;
          if (task.arcRunId === successfulProbe) {
            return completed(task);
          }
          await failGate.promise;
          return failure;
        },
      },
    });
    try {
      const initial = await collectAsync(
        setup.workerHub.submitInbound(inbound),
      );
      seed = false;
      const begin = host.begin.bind(host);
      vi.spyOn(host, "begin").mockImplementationOnce(async (input) => {
        const steps = await begin(input);
        if (steps[0]?.kind !== "trigger")
          throw new Error("Expected fresh trigger probe.");
        successfulProbe = steps[0].arcRunId;
        return steps;
      });
      const pending = collectAsync(setup.workerHub.submitInbound(inbound));
      await waitFor(
        () =>
          calls === 2 &&
          capture.records.some(
            (record) =>
              record.event === "worker_hub.lap.finished" &&
              record.arcRunId === successfulProbe,
          ),
      );
      failGate.resolve();
      const events = await pending;
      expect(events).toEqual([
        expect.objectContaining({
          kind: "failed",
          routineId: expect.any(String),
          reason: failure.message,
        }),
        expect.objectContaining({ kind: "activated" }),
      ]);
      expect(events[1]).not.toEqual(initial[0]);
    } finally {
      failGate.resolve();
      await setup.workerHub.stop();
    }
  });

  it("releases queued work belonging to the same failed probe", async () => {
    const host = await makeArcHostWithSource(
      "failed-queued",
      `"arc";
function One() { this.hostParams = { workerRole: "one" }; this.trigger = () => judge("one"); }
function Two() { this.hostParams = { workerRole: "two" }; this.trigger = () => judge("two"); }`,
    );
    const cancel = vi.fn();
    const setup = makeWorkerHub({
      arcHost: host,
      workers: { one: async () => failure, two: async () => capacity },
      capacityRetry: { enabled: true, schedule: () => cancel },
    });
    try {
      const events = await collectAsync(setup.workerHub.submitInbound(inbound));
      expect(events).toHaveLength(1);
      const event = events[0]!;
      if (event.kind !== "failed") throw new Error("Expected failure.");
      expect(cancel).toHaveBeenCalledOnce();
      await expect(
        setup.workerHub.resume(event.arcRunId),
      ).resolves.toMatchObject({ outcome: "missing" });
    } finally {
      await setup.workerHub.stop();
    }
  });

  it("surfaces every failed probe and every failed routine within a shared probe", async () => {
    for (const separateRoles of [false, true]) {
      const roots = separateRoles
        ? ["One", "Two"]
        : ["One", "Two", "Three", "Four"];
      const host = await makeArcHostWithSource(
        "many-failures",
        `"arc"; ${roots
          .map(
            (name) => `function ${name}() {
        ${separateRoles ? `this.hostParams = { workerRole: "${name}" };` : ""}
        this.trigger = () => judge("${name}"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; }
      }`,
          )
          .join("\n")}`,
      );
      let seed = !separateRoles;
      const worker: RoleWorker = async (task) =>
        seed ? completed(task) : failure;
      const setup = makeWorkerHub({
        arcHost: host,
        workers: separateRoles
          ? { One: worker, Two: worker }
          : { [DEFAULT_WORKER_ROLE]: worker },
      });
      try {
        if (seed) {
          expect(
            await collectAsync(setup.workerHub.submitInbound(inbound)),
          ).toHaveLength(4);
          seed = false;
        }
        const events = await collectAsync(
          setup.workerHub.submitInbound(inbound),
        );
        expect(events).toHaveLength(separateRoles ? 2 : 5);
        expect(
          new Set(events.map((event) => "arcRunId" in event && event.arcRunId))
            .size,
        ).toBe(separateRoles ? 1 : 5);
        const routineIds = new Set<string>();
        for (const event of events) {
          if (event.kind !== "failed")
            throw new Error("Expected a routine failure.");
          routineIds.add(event.routineId);
          expect(
            await setup.workerHub.listWorkEvents(event.arcRunId),
          ).toContainEqual(
            expect.objectContaining({
              kind: "routine:failed",
              routineId: event.routineId,
              error: { code: failure.code, message: event.reason },
            }),
          );
        }
        expect(routineIds.size).toBe(events.length);
      } finally {
        await setup.workerHub.stop();
      }
    }
  });
});
