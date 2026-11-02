import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";
import { InMemoryArcHostStore, probeRetention } from "../src/testing.js";
import { createTestArcHost } from "./work-event-fixtures.js";

import type { RoutineInput, RoutineReport, Worker } from "../src/index.js";
import {
  ALICE_OWNER,
  collectAsync,
  deferred,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";

const source = `"arc"; function Main() { this.trigger = () => true; $instruct("Work"); }`;
const inbound = { content: "start", metadata: { principal: ALICE_OWNER } };

async function fixture(worker: Worker, program = source) {
  const host = await makeArcHostWithSource("routine-retirement", program);
  const setup = makeWorkerHub({
    arcHost: host,
    backends: {
      owned: {
        supportedSlotKinds: new Set(["default"]),
        createWorker: () => worker,
      },
    },
    workerSlots: { default: "owned" },
  });
  return {
    ...setup,
    host,
    async stop() {
      await setup.workerHub.stop();
      await host.stop();
    },
  };
}

describe("Worker routine retirement", () => {
  it.each(["matched", "rejected", "failed", "expired", "cancelled"] as const)(
    "holds a %s probe submission until late invocation and routine disposal finish",
    async (ending) => {
      if (ending === "expired")
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
      });
      await host.registerArc(
        "probe",
        parse(
          `"arc"; function Main() { this.trigger = () => judge("start"); $enter(Wait); function Wait() { this.guard = () => State.DEFLECTED; } }`,
        ),
      );
      const entered = deferred();
      const release = deferred();
      const disposing = deferred();
      const releaseDisposal = deferred();
      const disposed: string[] = [];
      const { workerHub } = makeWorkerHub({
        arcHost: host,
        backends: {
          owned: {
            supportedSlotKinds: new Set(["default"]),
            createWorker: () => ({
              run: async (input): Promise<RoutineReport> => {
                entered.resolve();
                await release.promise;
                if (ending === "failed")
                  return { error: "failed", code: "probe", message: "failed" };
                const task = input.routine.task;
                if (task.kind !== "semantic") throw new Error("Expected probe");
                return {
                  outcome: "completed",
                  semantic: {
                    judgments: Object.fromEntries(
                      task.requests.map((request) => [
                        request.briefId,
                        ending !== "rejected",
                      ]),
                    ),
                  },
                };
              },
              disposeRoutine: async ({ routineId }) => {
                disposing.resolve();
                await releaseDisposal.promise;
                disposed.push(routineId);
              },
            }),
          },
        },
        workerSlots: { default: "owned" },
      });
      try {
        const submissionAbort = new AbortController();
        const submission = workerHub.submitInbound(inbound, {
          signal: submissionAbort.signal,
        });
        let settled = false;
        const consumption = collectAsync(submission).finally(() => {
          settled = true;
        });
        await entered.promise;
        if (ending === "expired") await vi.advanceTimersByTimeAsync(86_400_000);
        if (ending === "cancelled") submissionAbort.abort();
        release.resolve();
        await disposing.promise;
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(probeRetention(workerHub).transient.submissions).toBe(1);
        releaseDisposal.resolve();
        await consumption;
        expect(disposed).toHaveLength(1);
        await vi.waitFor(() =>
          expect(probeRetention(workerHub).transient.runDrains).toBe(0),
        );
        expect(probeRetention(workerHub).transient).toMatchObject({
          submissions: 0,
          retiringRoutines: 0,
          triggerProbes: 0,
          laps: 0,
          lapFailures: 0,
        });
      } finally {
        release.resolve();
        releaseDisposal.resolve();
        await workerHub.stop();
        await host.stop();
        vi.useRealTimers();
      }
    },
  );

  it("runs a same-context successor while delayed predecessor disposal remains routine-scoped", async () => {
    const inputs: RoutineInput[] = [];
    const disposed: string[] = [];
    const release = deferred();
    const f = await fixture(
      {
        run: async (input) => {
          inputs.push(input);
          return { outcome: "completed" };
        },
        disposeRoutine: async ({ routineId }) => {
          if (routineId === inputs[0]?.routine.id) await release.promise;
          disposed.push(routineId);
        },
      },
      `"arc"; function Main() { this.trigger = () => true; $instruct("First"); $enter(Second); function Second() { $instruct("Second"); } }`,
    );
    try {
      await collectAsync(f.workerHub.submitInbound(inbound));
      await waitFor(() => inputs.length === 2 && disposed.length === 1);
      expect(inputs[0]!.routine.contextKey).toBe(inputs[1]!.routine.contextKey);
      expect(disposed).toEqual([inputs[1]!.routine.id]);
      release.resolve();
      await waitFor(
        () => probeRetention(f.workerHub).transient.retiringRoutines === 0,
      );
      expect(new Set(disposed)).toEqual(
        new Set(inputs.map((input) => input.routine.id)),
      );
    } finally {
      release.resolve();
      await f.stop();
    }
  });

  it.each(["paused", "capacity-limited", "transport-lost"] as const)(
    "preserves routine ownership through a %s continuation and disposes once",
    async (status) => {
      const inputs: RoutineInput[] = [];
      const disposed: string[] = [];
      const f = await fixture({
        run: async (input): Promise<RoutineReport> => {
          inputs.push(input);
          if (inputs.length > 1) return { outcome: "completed" };
          if (status === "paused") return { suspension: status };
          if (status === "capacity-limited")
            return {
              suspension: status,
              reason: {
                reason: "token usage limit",
                provider: "test",
                message: "held",
              },
            };
          return {
            suspension: status,
            reason: { reason: "connection reset", message: "held" },
          };
        },
        disposeRoutine: async ({ routineId }) => {
          disposed.push(routineId);
        },
      });
      try {
        const events = await collectAsync(f.workerHub.submitInbound(inbound));
        const run = events.find((event) => event.kind === "activated");
        if (run?.kind !== "activated") throw new Error("Expected activation");
        await waitFor(
          async () =>
            (await f.workerHub.getExecutionControlView(run.arcRunId)).status ===
            status,
        );
        expect(disposed).toEqual([]);
        await f.workerHub.resume(run.arcRunId);
        await waitFor(() => disposed.length === 1);
        expect(inputs[0]!.routine.id).toBe(inputs[1]!.routine.id);
        expect(inputs[0]!.routine.contextKey).toBe(
          inputs[1]!.routine.contextKey,
        );
      } finally {
        await f.stop();
      }
    },
  );

  it("shutdown waits for all routine disposals despite one cleanup failure", async () => {
    const entered: string[] = [];
    const disposed: string[] = [];
    const release = deferred();
    const f = await fixture({
      run: async (input) => {
        entered.push(input.routine.id);
        return { suspension: "paused" };
      },
      disposeRoutine: async ({ routineId }) => {
        await release.promise;
        disposed.push(routineId);
        if (routineId === entered[0]) throw new Error("Routine cleanup failed");
      },
    });
    try {
      await collectAsync(f.workerHub.submitInbound(inbound));
      await collectAsync(
        f.workerHub.submitInbound({
          ...inbound,
          metadata: { principal: "other-owner" },
        }),
      );
      await waitFor(() => entered.length === 2);
      let stopped = false;
      const stopping = f.workerHub.stop().finally(() => {
        stopped = true;
      });
      const rejected = expect(stopping).rejects.toThrow(
        "Worker hub cleanup failed",
      );
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await rejected;
      expect(new Set(disposed)).toEqual(new Set(entered));
      expect(probeRetention(f.workerHub).transient).toMatchObject({
        retiringRoutines: 0,
        taskInvocations: 0,
        runDrains: 0,
      });
    } finally {
      release.resolve();
      await f.workerHub.stop().catch(() => {});
      await f.host.stop();
    }
  });

  it("waits for resumed routine persistence during stop without invoking a retired continuation", async () => {
    const entered = deferred();
    const release = deferred();
    const run = vi.fn(
      async (): Promise<RoutineReport> => ({ suspension: "paused" }),
    );
    const f = await fixture({
      run,
      disposeRoutine: async () => {},
    });
    const put = f.routineStore.putRoutine.bind(f.routineStore);
    try {
      const events = await collectAsync(f.workerHub.submitInbound(inbound));
      const activation = events.find((event) => event.kind === "activated")!;
      await waitFor(
        async () =>
          (await f.workerHub.getExecutionControlView(activation.arcRunId))
            .status === "paused",
      );
      vi.spyOn(f.routineStore, "putRoutine").mockImplementation(
        async (routine) => {
          if (routine.status === "running") {
            entered.resolve();
            await release.promise;
          }
          await put(routine);
        },
      );
      const resuming = f.workerHub.resume(activation.arcRunId);
      await entered.promise;
      let stopped = false;
      const stopping = f.workerHub.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await resuming;
      await stopping;
      expect(run).toHaveBeenCalledTimes(1);
      expect(probeRetention(f.workerHub).transient).toMatchObject({
        taskInvocations: 0,
        runDrains: 0,
      });
    } finally {
      release.resolve();
      await f.stop();
    }
  });
});
