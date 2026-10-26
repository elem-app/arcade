import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";
import {
  createTestArcHost,
  executionControlFor,
} from "./work-event-fixtures.js";

import {
  AgentRoutineReportSchema,
  validateRoutineReport,
  type RoutineReport,
} from "../src/index.js";
import {
  DEFAULT_WORKER_ROLE,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  arcRunKey,
  type ArcRunId,
  type InstructionTask,
  type OutboundMessage,
  type RoleWorker,
  type Task,
  type WorkEvent,
  type WorkerHubService,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  ARC_RUN_ID,
  GREET_SOURCE,
  WATCH_SOURCE,
  collectAsync,
  createCapturingLogger,
  firstTaskWithArcHost,
  makeArcHost,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import {
  recordAdvanceInputs,
  routineContext,
  submitActivation,
} from "./worker-hub-helpers.js";

describe("Routines, dialog projection, and work events", () => {
  it("maps an escaping worker exception to backend-error", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workerSlots: { default: "openai-sdk" },
      openAiSdk: {
        apiKey: "sk-test",
        run: async () => {
          throw new Error("openai failed");
        },
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: {
        error: "failed",
        code: "backend-error",
        message: "openai failed",
      },
    });
    const routines = await collectAsync(routineStore.listRoutines());
    expect(routines[0]).toMatchObject({
      status: "finished",
      error: { code: "backend-error", message: "openai failed" },
    });
  });

  it("projects each dispatched task's dialog for its own worker role", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const historyStore = new InMemoryHistoryStore();
    const at = "2026-05-21T00:00:00.000Z";
    await historyStore.appendEntry(task.arcRunId, {
      from: { kind: "audience", name: "originator" },
      to: { kind: "arcade" },
      content: "watch it",
      at,
    });
    await historyStore.appendEntry(task.arcRunId, {
      from: { kind: "audience", name: "supervisor", ofRole: task.role },
      to: { kind: "role", id: task.role },
      content: "approved",
      at,
    });
    await historyStore.appendEntry(task.arcRunId, {
      from: { kind: "audience", name: "supervisor", ofRole: "other-role" },
      to: { kind: "role", id: "other-role" },
      content: "secret",
      at,
    });

    let captured: Task | undefined;
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: {
        [task.role]: async (received) => {
          captured = received;
          return { outcome: "completed" };
        },
      },
    });

    await workerHub.handleTask(task, routineContext());

    // The worker sees the principal's shared turn and its own forwarded audience
    // reply, but not another role's scoped traffic — even though arc host handed
    // the task an empty run-level dialog.
    expect(captured?.dialog.lastTurns).toEqual([
      { role: "user", message: "watch it" },
      { role: "self", message: "(forwarded from supervisor) approved" },
    ]);
  });

  it("runs registered role workers and marks routines completed", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    const worker = vi.fn(async () => ({ outcome: "completed" as const }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workers: { researcher: worker },
    });

    const result = await workerHub.handleTask(task, routineContext());

    expect(result).toEqual({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });
    expect(worker).toHaveBeenCalledWith(
      // The dispatched task's dialog is re-projected for the worker's own role,
      // so it carries that role's view stamp.
      { ...task, dialog: { ...task.dialog, view: "researcher" } },
      expect.objectContaining({
        workspacePath: expect.any(String),
        workspaceBundle: {},
      }),
      expect.objectContaining({
        emit: expect.any(Function),
        logToolEvent: expect.any(Function),
      }),
    );
    const routines = [];
    for await (const routine of routineStore.listRoutines(ARC_RUN_ID)) {
      routines.push(routine);
    }
    expect(routines).toEqual([
      expect.objectContaining({
        role: "researcher",
        status: "finished",
      }),
    ]);
  });

  it("normalizes handler reports and failures", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const reportHandler = vi.fn(async () => ({
      outcome: "completed" as const,
      semantic: {
        judgments: { "judge:1": true },
      },
    }));
    const { workerHub: reportWorkerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: reportHandler },
    });

    await expect(
      reportWorkerHub.handleTask(task, routineContext()),
    ).resolves.toEqual({
      status: "finished",
      routineId: expect.any(String),
      report: {
        outcome: "completed",
        semantic: {
          judgments: { "judge:1": true },
        },
      },
    });

    const failingHandler = vi.fn(async () => {
      throw new Error("boom");
    });
    const { workerHub: failingWorkerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: failingHandler },
    });

    const failed = await failingWorkerHub.handleTask(task, routineContext());

    expect(failed).toEqual({
      status: "finished",
      routineId: expect.any(String),
      report: {
        error: "failed",
        code: "handler-error",
        message: "boom",
      },
    });
    if (failed.status !== "finished")
      throw new Error("Expected a finished routine");
    expect(await routineStore.getRoutine(failed.routineId)).toEqual(
      expect.objectContaining({
        status: "finished",
        error: { code: "handler-error", message: "boom" },
      }),
    );
  });

  it("maps an in-process callback exception to handler-error", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => {
          throw new Error("callback failed");
        },
      },
    });

    await expect(workerHub.handleTask(task, routineContext())).resolves.toEqual(
      {
        status: "finished",
        routineId: expect.any(String),
        report: {
          error: "failed",
          code: "handler-error",
          message: "callback failed",
        },
      },
    );
  });

  it("applies every flat routine report variant exhaustively", async () => {
    const reports: RoutineReport[] = [
      { outcome: "completed" },
      { outcome: "disposition", deflect: {} },
      { outcome: "disposition", interrupt: { id: "external", reason: "ping" } },
      { error: "failed", code: "agent-failed", message: "failed" },
      {
        error: "unavailable",
        code: "temporarily-unavailable",
        message: "unavailable",
      },
      { suspension: "paused" },
      {
        suspension: "capacity-limited",
        reason: {
          reason: "provider overloaded",
          provider: "custom",
          message: "overloaded",
        },
      },
      {
        suspension: "transport-lost",
        reason: {
          reason: "network timeout",
          message: "timed out",
        },
      },
    ];

    for (const report of reports) {
      const { arcHost, task } = await firstTaskWithArcHost();
      const { workerHub } = makeWorkerHub({
        arcHost,
        workers: { researcher: async () => report },
      });
      const result = await workerHub.handleTask(task, routineContext());
      if (report.suspension !== undefined) {
        expect(result).toMatchObject({ status: "queued" });
      } else if (report.error === "unavailable") {
        expect(result).toMatchObject({
          status: "skipped",
          error: { code: report.code, message: report.message },
        });
      } else {
        expect(result).toEqual({
          status: "finished",
          routineId: expect.any(String),
          report,
        });
      }
    }
  });

  it("accepts exactly one disposition payload and keeps dispositions out of agent reports", () => {
    for (const report of [
      { outcome: "disposition", deflect: {} },
      { outcome: "disposition", interrupt: { id: "external" } },
      { outcome: "disposition", interrupt: { id: "external", reason: "ping" } },
      { outcome: "disposition", deflect: {}, backendDetails: { step: 1 } },
    ]) {
      expect(validateRoutineReport(report)).toEqual(report);
      expect(AgentRoutineReportSchema.safeParse(report).success).toBe(false);
    }
    for (const report of [
      { outcome: "disposition" },
      { outcome: "disposition", deflect: {}, interrupt: { id: "external" } },
      { outcome: "disposition", deflect: true },
      { outcome: "disposition", deflect: { reason: "misplaced" } },
      { outcome: "disposition", interrupt: {} },
      { outcome: "disposition", interrupt: { id: "" } },
      {
        outcome: "disposition",
        interrupt: { id: "external", reason: undefined },
      },
      { outcome: "disposition", deflect: {}, semantic: {} },
      { outcome: "completed", deflect: {} },
      { outcome: "deflected" },
    ]) {
      expect(() => validateRoutineReport(report)).toThrow("failed validation");
    }
  });

  it("passes a disposition on a semantic task through without semantic results", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const task = semanticTaskFor(instruction);
    const report = {
      outcome: "disposition",
      interrupt: { id: "external" },
    } as const;
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: async () => report },
    });

    await expect(workerHub.handleTask(task, routineContext())).resolves.toEqual(
      {
        status: "finished",
        routineId: expect.any(String),
        report,
      },
    );
  });

  it("rejects status-shaped and multiply discriminated routine reports", async () => {
    expect(() => validateRoutineReport({ status: "queued" })).toThrow(
      "failed validation",
    );
    expect(() =>
      validateRoutineReport({ outcome: "completed", status: "queued" }),
    ).toThrow("failed validation");
    expect(() =>
      validateRoutineReport({ outcome: "completed", suspension: "paused" }),
    ).toThrow("failed validation");

    const { arcHost, task } = await firstTaskWithArcHost();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ status: "queued" }) as never,
      },
    });
    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: { error: "failed", code: "backend-error" },
    });
  });

  it("persists backendDetails for every report variant with deterministic resume overwrite", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    let invocation = 0;
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workers: {
        researcher: async () => {
          invocation += 1;
          if (invocation === 1) {
            return {
              suspension: "paused",
              backendDetails: { step: 1 },
            } as const;
          }
          if (invocation === 2) {
            return {
              suspension: "paused",
              backendDetails: { step: 2 },
            } as const;
          }
          return { outcome: "completed", backendDetails: null } as const;
        },
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "queued",
    });
    const [routine] = await collectAsync(
      routineStore.listRoutines(task.arcRunId),
    );
    if (!routine) throw new Error("expected routine");
    await expect(routineStore.getRoutine(routine.id)).resolves.toMatchObject({
      status: "paused",
      backendDetails: { step: 1 },
    });

    await workerHub.resume(task.arcRunId);
    await waitFor(async () => {
      const current = await routineStore.getRoutine(routine.id);
      return (
        current?.status === "paused" &&
        current.backendDetails !== null &&
        typeof current.backendDetails === "object" &&
        !Array.isArray(current.backendDetails) &&
        (current.backendDetails as Record<string, unknown>)["step"] === 2
      );
    });
    await workerHub.resume(task.arcRunId);
    await waitFor(
      async () =>
        (await routineStore.getRoutine(routine.id))?.status === "finished",
    );
    const finished = await routineStore.getRoutine(routine.id);
    expect(finished).toMatchObject({ status: "finished" });
    expect(finished).not.toHaveProperty("backendDetails");
  });

  it("rejects a custom backend completed semantic report missing a requested id", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const task = semanticTaskFor(instruction);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: {
        error: "failed",
        code: "backend-error",
        message: expect.stringContaining(
          "worker report.semantic is required for semantic work",
        ),
      },
    });
  });

  it("records custom backend semantic drift before applying the normalized report", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const task = semanticTaskFor(instruction);
    const { logger, records } = createCapturingLogger();
    const { workerHub } = makeWorkerHub({
      arcHost,
      logger,
      workers: {
        researcher: async () => ({
          outcome: "completed",
          semantic: {
            judgments: {
              "judge:required": true,
              "judge:extra": false,
            },
            observations: {
              "observe:extra": { status: "unknown" },
            },
          },
        }),
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_hub.semantic_report_drift",
          unrequestedJudgments: ["judge:extra"],
          unrequestedObservations: ["observe:extra"],
        }),
      ]),
    );
  });

  it("keeps paused handler routines running", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ suspension: "paused" }),
      },
    });

    const result = await workerHub.handleTask(task, routineContext());

    const routines = [];
    for await (const routine of routineStore.listRoutines(ARC_RUN_ID)) {
      routines.push(routine);
    }
    expect(result).toEqual({ status: "queued", routineId: routines[0]!.id });
    expect(routines[0]).toEqual(expect.objectContaining({ status: "paused" }));
  });

  it("emits ordered structured logs for inbound and outbound messages", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const worker: RoleWorker = async (_task, _context, effects) => {
      await effects.emit({
        situation: { cause: "reply" },
        content: "Research update.",
      });
      return { outcome: "completed" };
    };
    const { logger, records } = createCapturingLogger();
    const { workerHub } = makeWorkerHub({
      arcHost,
      logger,
      workers: { researcher: worker },
    });
    const emitted: OutboundMessage[] = [];
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "reply" },
      (message) => {
        emitted.push(message);
      },
    );

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(() => emitted.length === 1);
    const entries = records.filter(
      (entry) =>
        entry.level === "info" &&
        ["worker_hub.inbound.accepted", "worker_hub.outbound.emitted"].includes(
          entry.event,
        ),
    );
    expect(entries.map((entry) => entry.event)).toEqual([
      "worker_hub.inbound.accepted",
      "worker_hub.outbound.emitted",
    ]);
    expect(entries).toMatchObject([
      {
        domain: "messaging",
        arcRunId,
        audience: { name: "originator" },
        metadata: { principal: ALICE_OWNER },
      },
      {
        domain: "messaging",
        arcRunId,
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "reply",
        },
      },
    ]);
    expect(entries.every((entry) => !("content" in entry))).toBe(true);
    expect(
      records
        .filter(
          (entry) => entry.level === "debug" && entry.domain === "messaging",
        )
        .map((entry) => ({ event: entry.event, content: entry.content })),
    ).toEqual(
      expect.arrayContaining([
        {
          event: "worker_hub.inbound.content",
          content: "watch this",
        },
        {
          event: "worker_hub.outbound.content",
          content: "Research update.",
        },
      ]),
    );
  });

  it("poisons the run when handler work fails", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = createTestArcHost({ store });
    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    const advanceInputs = recordAdvanceInputs(arcHost);
    const worker = vi.fn<RoleWorker>(async () => {
      throw new Error("model timed out");
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { greeter: worker },
    });

    const arcRunId = await submitActivation(workerHub, "hi");
    await waitFor(() => worker.mock.calls.length === 1);
    expect(worker).toHaveBeenCalledTimes(1);
    await waitFor(() => advanceInputs.length === 1);
    expect(advanceInputs).toEqual([
      {
        reports: [
          {
            error: "failed",
            code: "handler-error",
            message: "model timed out",
          },
        ],
        instructionCoverage: {
          "instruction:[arc:greet:Greet]:[node:greet:Greet]:body/0": "failed",
        },
        intent: "agent-work",
      },
    ]);
    await expect(store.getState(arcRunKey(arcRunId))).resolves.toEqual(
      expect.objectContaining({ lifecycle: "poisoned" }),
    );
  });

  it("does not commit paused handler results as ignored coverage", async () => {
    const arcHost = await makeArcHostWithSource("greet", GREET_SOURCE);
    const advanceInputs = recordAdvanceInputs(arcHost);
    const worker = vi.fn<RoleWorker>(async () => ({
      suspension: "paused",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { greeter: worker },
    });

    await submitActivation(workerHub, "hi");

    await waitFor(() => worker.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(advanceInputs).toEqual([]);
  });
});

function semanticTaskFor(instruction: InstructionTask): Task {
  return {
    kind: "semantic",
    allowedDispositions: [],
    batchId: "semantic:central-validation",
    role: instruction.role,
    stage: "action",
    contextIsolation: instruction.contextIsolation,
    arcRunId: instruction.arcRunId,
    dialog: instruction.dialog,
    activeInstruction: instruction,
    requests: [
      {
        kind: "judgment",
        briefId: "judge:required",
        role: instruction.role,
        question: "Is the work ready?",
        sourceRef: instruction.sourceRef,
        tool: {
          type: "function",
          name: "judge_required",
          description: "Resolve readiness.",
          strict: true,
          parameters: {
            type: "object",
            properties: { result: { type: "boolean" } },
            required: ["result"],
            additionalProperties: false,
          },
        },
      },
    ],
  };
}

describe("transition views and position events", () => {
  const STALE_SOURCE = `
"arc";

function Main() {
  this.trigger = () => { return true; };
  $enter(Empty);
  $enter(A);
  $enter(B);
  function Empty() {}
  function A() {
    this.hostParams = { workerRole: "researcher" };
    $instruct(\`emit token\`);
  }
  function B() {
    this.hostParams = { workerRole: "researcher" };
    this.guard = () => {
      if (!/token-42/.test(Dialog.lastTurns(6))) {
        return State.SKIPPED;
      }
    };

    $instruct(\`b work\`);  }
}
`;

  async function runStaleFlow(): Promise<{
    workerHub: WorkerHubService;
    arcRunId: ArcRunId;
    texts: string[];
  }> {
    const arcHost = makeArcHost();
    await arcHost.registerArc("stale", parse(STALE_SOURCE));
    const texts: string[] = [];
    const worker: RoleWorker = async (task, _context, effects) => {
      if (task.kind === "instruction") {
        const text = String(task.texts[0]);
        texts.push(text);
        if (text.includes("emit token")) {
          await effects.emit({
            situation: { cause: "reply" },
            content: "token-42",
          });
        }
      }
      return { outcome: "completed" };
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });
    const arcRunId = await submitActivation(workerHub, "go");
    await waitFor(() => texts.length === 2);
    return { workerHub, arcRunId, texts };
  }

  it("makes mid-lap history visible to the next node's view within one lap", async () => {
    // A's worker appends an outbound to history mid-lap; the transition into B
    // rotates the view, so B's guard sees it and B's work dispatches — the
    // original staleness defect, fixed.
    const { texts } = await runStaleFlow();
    expect(texts).toEqual(["emit token", "b work"]);
  });

  it("persists node entered/exited work events from acknowledged transitions", async () => {
    const { workerHub, arcRunId } = await runStaleFlow();
    const events = await workerHub.listWorkEvents(arcRunId);
    const nodeEvents = events
      .filter(
        (event): event is Extract<WorkEvent, { kind: `node:${string}` }> =>
          event.kind === "node:entered" || event.kind === "node:exited",
      )
      .map((event) => `${event.kind}:${event.nodeName}:${event.role}`);
    expect(nodeEvents).toContain("node:entered:A:researcher");
    // An exit's transition rotates to the position it returns to — Main here,
    // whose worker role is the default role.
    expect(nodeEvents).toContain(`node:exited:A:${DEFAULT_WORKER_ROLE}`);
    expect(nodeEvents).toContain("node:entered:B:researcher");
    const emptyEntered = nodeEvents.indexOf(
      `node:entered:Empty:${DEFAULT_WORKER_ROLE}`,
    );
    const emptyExited = nodeEvents.indexOf(
      `node:exited:Empty:${DEFAULT_WORKER_ROLE}`,
    );
    expect(emptyEntered).toBeGreaterThanOrEqual(0);
    expect(emptyExited).toBeGreaterThan(emptyEntered);
  });
});
