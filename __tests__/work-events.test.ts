import { parse } from "@elem-app/arc/parser";
import { toNodeRef } from "@elem-app/arc/runtime";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as workerInstructions from "../src/instructions/worker-role.js";
import { createArcadeLogger } from "../src/logging.js";
import { InMemoryArcHostStore, WorkEventService } from "../src/testing.js";
import { beginActivatedDriver, projectorFor } from "./arc-host-helpers.js";
import { createTestArcHost, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  InMemoryWorkEventStore,
  JsonFileWorkEventStore,
  taskId,
  type CreateWorkEventInput,
  type InstructionTask,
  type OpenAiSdkRunFn,
  type RoutineContext,
  type WorkEvent,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  INVALID_INSTRUCTION_SOURCE,
  WATCH_SOURCE,
  collectAsync,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import { drainLifecycle } from "./worker-hub-helpers.js";

describe("WorkEvent stores", () => {
  it("keeps in-memory events in append order per Arc run", async () => {
    const store = new InMemoryWorkEventStore();
    for (const input of workEventInputs("run:one")) {
      await store.appendEvent(input);
    }
    await store.appendEvent(workEventInputs("run:two")[0]!);

    await expect(collectAsync(store.listEvents("run:one"))).resolves.toEqual([
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({ kind: "tool:started" }),
      expect.objectContaining({ kind: "blocked:question" }),
      expect.objectContaining({ kind: "control:pause-requested" }),
    ]);
  });

  it("keeps JSON-file events in append order per Arc run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-work-events-"));
    const store = new JsonFileWorkEventStore({ dir });
    for (const input of workEventInputs("run:one")) {
      await store.appendEvent(input);
    }

    await expect(collectAsync(store.listEvents("run:one"))).resolves.toEqual([
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({ kind: "tool:started" }),
      expect.objectContaining({ kind: "blocked:question" }),
      expect.objectContaining({ kind: "control:pause-requested" }),
    ]);
  });

  it("retains exact failed routine diagnostics in a fresh history reader without a live probe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-failed-probe-events-"));
    const store = new JsonFileWorkEventStore({ dir });
    const event = await store.appendEvent({
      kind: "routine:failed",
      arcRunId: "retired-probe",
      routineId: "failed-routine",
      backend: "test",
      role: "tester",
      nodeName: "Main",
      error: { code: "provider-failed", message: "Cannot continue." },
    });
    const fresh = new JsonFileWorkEventStore({ dir });
    await expect(
      collectAsync(fresh.listEvents("retired-probe")),
    ).resolves.toEqual([event]);
  });

  it("preserves token usage on routine usage events", async () => {
    const tokenUsage = {
      requests: 2,
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      cacheReadInputTokens: 5,
      costUsd: 0.25,
      models: {
        "model:test": {
          inputTokens: 30,
          outputTokens: 12,
          totalTokens: 42,
          costUsd: 0.25,
        },
      },
    };
    const stores = [
      new InMemoryWorkEventStore(),
      new JsonFileWorkEventStore({
        dir: await mkdtemp(join(tmpdir(), "arcade-work-events-usage-")),
      }),
    ];

    for (const store of stores) {
      const event = await store.appendEvent({
        arcRunId: "run:usage",
        routineId: "routine:usage",
        role: "writer",
        backend: "openai-sdk",
        nodeName: "CreateDocs",
        kind: "routine:usage",
        tokenUsage,
      });

      await expect(
        collectAsync(store.listEvents("run:usage")),
      ).resolves.toEqual([
        expect.objectContaining({ id: event.id, tokenUsage }),
      ]);
    }
  });
});

describe("WorkerHubService WorkEvents", () => {
  it("emits deterministic routine lifecycle labels", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "finished" });

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({
        kind: "routine:started",
        role: "researcher",
        nodeName: "Watch",
      }),
      expect.objectContaining({
        kind: "routine:finished",
        outcome: "completed",
      }),
    ]);
  });

  it("emits routine usage events from observed backend usage", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return {
        lastResponseId: "resp-usage",
        runContext: {
          usage: {
            requests: 1,
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
            inputTokensDetails: [{ cached_tokens: 3 }],
            outputTokensDetails: [{ reasoning_tokens: 2 }],
          },
        },
      };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "openai-sdk" },
      openAiSdk: { apiKey: "sk-test", run },
    });

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "finished" });

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({
        kind: "routine:usage",
        tokenUsage: {
          requests: 1,
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          cacheReadInputTokens: 3,
          reasoningTokens: 2,
        },
      }),
      expect.objectContaining({
        kind: "routine:finished",
        outcome: "completed",
      }),
    ]);
  });

  it("emits routine usage events before failed routine events", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const run = vi.fn<OpenAiSdkRunFn>(async (_input) => {
      if (run.mock.calls.length === 1) {
        return {
          lastResponseId: "resp-before-failure",
          runContext: {
            usage: {
              requests: 1,
              inputTokens: 20,
              outputTokens: 4,
              totalTokens: 24,
            },
          },
        };
      }
      throw new Error("recovery failed");
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "openai-sdk" },
      openAiSdk: { apiKey: "sk-test", run },
    });

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        error: "failed",
        code: "backend-error",
        message: "recovery failed",
      },
    });

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({ kind: "routine:started" }),
      expect.objectContaining({
        kind: "routine:usage",
        tokenUsage: {
          requests: 1,
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
        },
      }),
      expect.objectContaining({
        kind: "routine:failed",
        error: { code: "backend-error", message: "recovery failed" },
      }),
    ]);
  });

  it("omits the role from default-worker routine labels", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const defaultTask = { ...task, role: DEFAULT_WORKER_ROLE };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        [DEFAULT_WORKER_ROLE]: async () => ({ outcome: "completed" }),
      },
    });

    await expect(
      workerHub.handleTask(defaultTask, routineContext(defaultTask)),
    ).resolves.toMatchObject({ status: "finished" });

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual([
      expect.objectContaining({ kind: "run:started", route: "fresh" }),
      expect.objectContaining({
        kind: "routine:started",
        role: DEFAULT_WORKER_ROLE,
        nodeName: "Watch",
      }),
      expect.objectContaining({
        kind: "routine:finished",
        outcome: "completed",
      }),
    ]);
  });

  it("notifies work event observers after durable append", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const { workerHub, workEventStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });
    const observed: string[] = [];
    workerHub.registerWorkEventHandler(async (event) => {
      const stored = await collectAsync(
        workEventStore.listEvents(event.arcRunId),
      );
      if (stored.some((candidate) => candidate.id === event.id)) {
        observed.push(event.id);
      }
    });

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "finished" });
    const events = await workerHub.listWorkEvents(task.arcRunId);

    expect(observed).toEqual(
      events
        .filter((event) => event.kind !== "run:started")
        .map((event) => event.id),
    );
  });

  it("stops notifying a work event observer after it unregisters", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });
    const kept: string[] = [];
    const dropped: string[] = [];
    workerHub.registerWorkEventHandler(async (event) => {
      kept.push(event.id);
    });
    const unregister = workerHub.registerWorkEventHandler(async (event) => {
      dropped.push(event.id);
    });
    unregister();

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "finished" });
    const events = await workerHub.listWorkEvents(task.arcRunId);

    // The still-registered observer sees every appended event; the unregistered
    // one is never called, so the returned function really detaches it.
    expect(events.length).toBeGreaterThan(0);
    expect(kept).toEqual(
      events
        .filter((event) => event.kind !== "run:started")
        .map((event) => event.id),
    );
    expect(dropped).toEqual([]);
  });

  it("stamps parsed node descriptions on routine and backend work events", async () => {
    const { arcHost, task } = await instructionTaskFromRun(`
      "arc";

      function Watch() {
        this.description = "Monitor important workspace updates.";
        this.trigger = () => {
          return true;
        };
        this.hostParams = {
          workerRole: "researcher",
        };
        $instruct(\`Watch for updates.\`);
      }
    `);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.logToolEvent({
            kind: "tool:started",
            toolCallId: "tool:test",
            toolName: "backend-tool",
          });
          return { outcome: "completed" };
        },
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext(task)),
    ).resolves.toMatchObject({ status: "finished" });

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:started",
          nodeName: "Watch",
          nodeDescription: "Monitor important workspace updates.",
        }),
        expect.objectContaining({
          kind: "tool:started",
          toolCallId: "tool:test",
          toolName: "backend-tool",
          nodeName: "Watch",
          nodeDescription: "Monitor important workspace updates.",
        }),
      ]),
    );
  });

  it("emits blocked after a question is surfaced and before the tool finishes", async () => {
    const { arcHost, task } = await instructionTaskFromRun();
    let surfaceQuestion!: () => void;
    const questionSurfaced = new Promise<void>((resolve) => {
      surfaceQuestion = resolve;
    });
    let internalAskId: string | undefined;
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.logToolEvent({
            kind: "tool:started",
            toolCallId: "tool:question",
            toolName: "discuss",
          });
          const answer = await effects.emit({
            situation: { audience: "supervisor", cause: "question" },
            content: "Need approval?",
            metadata: {
              toolCallId: "tool:question",
            },
          });
          expect(answer).toBe("approved");
          await effects.logToolEvent({
            kind: "tool:finished",
            toolCallId: "tool:question",
            toolName: "discuss",
            outcome: "answered",
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "supervisor", cause: "question" },
      (message) => {
        internalAskId = message.metadata?.askId as string | undefined;
        surfaceQuestion();
      },
    );

    const running = workerHub.handleTask(task, routineContext(task));
    await questionSurfaced;
    await waitFor(async () => {
      const events = await workerHub.listWorkEvents(task.arcRunId);
      return events.some((event) => event.kind === "blocked:question");
    });

    const waitingEvents = await workerHub.listWorkEvents(task.arcRunId);
    expect(formatEventSequence(waitingEvents)).toEqual([
      "run:started",
      "routine:started",
      "tool:started:discuss",
      "blocked:question",
    ]);

    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId: task.arcRunId,
        content: "approved",
        metadata: { askId: internalAskId },
      }),
    );
    await expect(running).resolves.toMatchObject({ status: "finished" });

    const finalEvents = await workerHub.listWorkEvents(task.arcRunId);
    expect(formatEventSequence(finalEvents)).toEqual([
      "run:started",
      "routine:started",
      "tool:started:discuss",
      "blocked:question",
      "tool:finished:discuss:answered",
      "routine:finished:completed",
    ]);
  });
});

function workEventInputs(arcRunId: string): CreateWorkEventInput[] {
  const base = {
    arcRunId,
    routineId: "routine:1",
    role: "writer",
    nodeName: "CreateDocs",
    backend: "claude-sdk" as const,
  };
  return [
    {
      ...base,
      kind: "routine:started",
    },
    {
      ...base,
      kind: "tool:started",
      toolCallId: "tool:1",
      toolName: "emit_outbound",
    },
    {
      ...base,
      kind: "blocked:question",
      audience: "originator",
      askId: "tool:1",
      toolCallId: "tool:1",
    },
    {
      arcRunId,
      kind: "control:pause-requested",
      routineId: "routine:1",
    },
  ];
}

function formatEventSequence(events: WorkEvent[]): string[] {
  return events.map((event) => {
    switch (event.kind) {
      case "asks:invalidated":
      case "run:handshake-pending":
      case "run:handshake-resolved":
      case "run:started":
      case "run:deflection-occurred":
      case "run:interruption-occurred":
      case "run:completed":
      case "run:deflected":
      case "run:poisoned":
        return event.kind;
      case "routine:started":
      case "routine:finished":
      case "routine:failed":
      case "routine:skipped":
        return [event.kind, event.outcome].filter(Boolean).join(":");
      case "routine:capacity-limited":
        return [event.kind, event.capacityReason.reason].join(":");
      case "routine:transport-lost":
        return [event.kind, event.transportReason.reason].join(":");
      case "routine:usage":
        return event.kind;
      case "tool:started":
      case "tool:finished":
      case "tool:failed":
        return [event.kind, event.toolName, event.outcome]
          .filter(Boolean)
          .join(":");
      case "blocked:question":
      case "blocked:permission":
      case "control:pause-requested":
      case "control:paused":
      case "control:resume-requested":
      case "control:resumed":
        return event.kind;
      case "node:entered":
      case "node:exited":
        return [event.kind, event.nodeName].join(":");
    }
  });
}

async function callOpenAiTool(
  agent: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tools = (agent as { tools: { name: string; invoke: Function }[] })
    .tools;
  const fn = tools.find((tool) => tool.name === name);
  if (!fn) throw new Error(`tool not found: ${name}`);
  return await fn.invoke({} as never, JSON.stringify(input), {});
}

async function instructionTaskFromRun(source = WATCH_SOURCE): Promise<{
  arcHost: Awaited<ReturnType<typeof makeArcHostWithSource>>;
  task: InstructionTask;
}> {
  const arcHost = await makeArcHostWithSource("watch", source);
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
    workspacePath: join(tmpdir(), "arcade-work-event-test-workspace"),
    workspaceBundle: {},
  };
}

describe("Run work event publication", () => {
  it("publishes direct host start before acknowledged nodes and immediate completion with readable persisted views", async () => {
    const host = createTestArcHost({ store: new InMemoryArcHostStore() });
    await host.registerArc(
      "event-order",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $enter(Child); function Child() {} }`,
      ),
    );
    const events: WorkEvent[] = [];
    workEventsFor(host).registerWorkEventHandler(async (event) => {
      expect(await host.getRunView(event.arcRunId)).toMatchObject({
        stage: "actioning",
        lifecycle: "completed",
      });
      expect((await workEventsFor(host).list(event.arcRunId)).at(-1)?.id).toBe(
        event.id,
      );
      events.push(event);
    });
    await host.begin({
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      principal: "operator-owner",
      inbound: { content: "go" },
      projectDialog: projectorFor({
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      }),
    });
    expect(events[0]).toMatchObject({ kind: "run:started", route: "fresh" });
    expect(events.at(-1)).toMatchObject({ kind: "run:completed" });
    expect(events.some((event) => event.kind === "node:entered")).toBe(true);
    const eventCount = events.length;
    await expect(
      host.begin({
        arcRunId: events[0]!.arcRunId,
        projectDialog: projectorFor({
          cursor: { user: 0, self: 0 },
          lastTurns: [],
        }),
      }),
    ).resolves.toEqual([]);
    expect(events).toHaveLength(eventCount);
    expect(await host.getRunView(events[0]!.arcRunId)).toMatchObject({
      lifecycle: "completed",
    });
    expect(
      events.filter((event) => event.kind === "run:completed"),
    ).toHaveLength(1);
  });

  it("isolates synchronous observer failures and copies while serializing equal-time events across principals", async () => {
    const service = new WorkEventService(
      new InMemoryWorkEventStore(),
      createArcadeLogger(),
    );
    const received: WorkEvent[] = [];
    service.registerWorkEventHandler((event) => {
      event.arcRunId = "mutated";
      throw new Error("observer failure");
    });
    service.registerWorkEventHandler(async (event) => {
      received.push(event);
      expect(
        (await service.list(event.arcRunId)).some(
          (item) => item.id === event.id,
        ),
      ).toBe(true);
    });
    const now = vi
      .spyOn(Date.prototype, "toISOString")
      .mockReturnValue("2026-09-16T00:00:00.000Z");
    try {
      await Promise.all([
        service.append({
          kind: "run:started",
          arcRunId: "one",
          route: "fresh",
        }),
        service.append({ kind: "run:completed", arcRunId: "one" }),
        service.append({
          kind: "run:handshake-resolved",
          arcRunId: "other-principal",
          handshakeId: "ended",
          outcome: { kind: "declined" },
        }),
      ]);
    } finally {
      now.mockRestore();
    }
    expect((await service.list("one")).map((event) => event.kind)).toEqual([
      "run:started",
      "run:completed",
    ]);
    expect(received.map((event) => event.arcRunId)).toContain(
      "other-principal",
    );
    expect(received.every((event) => event.arcRunId !== "mutated")).toBe(true);
  });

  it("retains both diagnostic arrays when initial instruction validation poisons execution", async () => {
    const host = await makeArcHostWithSource(
      "poison-events",
      INVALID_INSTRUCTION_SOURCE,
    );
    const readInstruction = vi
      .spyOn(workerInstructions, "readWorkerInstruction")
      .mockReturnValueOnce({
        ok: false,
        issues: [
          {
            instructionId: "invalid",
            text: "Work",
            code: "invalid-worker-tools",
            message: "Invalid instruction tools",
            path: "hostParams.tools",
          },
        ],
      });
    const steps = await host.begin({
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      principal: ALICE_OWNER,
      inbound: { content: "go" },
      projectDialog: projectorFor({
        cursor: { user: 0, self: 0 },
        lastTurns: [],
      }),
    });
    readInstruction.mockRestore();
    const step = steps[0];
    if (step?.kind !== "action") throw new Error("Expected action");
    const events = await workEventsFor(host).list(step.arcRunId);
    expect(events[0]).toMatchObject({ kind: "run:started" });
    const poisoned = events.at(-1);
    expect(poisoned?.kind).toBe("run:poisoned");
    if (poisoned?.kind !== "run:poisoned") throw new Error("Expected poison");
    expect(poisoned.instructionIssues.length).toBeGreaterThan(0);
    expect(poisoned.issues).toEqual(step.frontier.issues);
  });

  it("withholds acknowledged node facts when their state commit fails and preserves the operational error", async () => {
    const store = new InMemoryArcHostStore();
    const host = createTestArcHost({ store });
    await host.registerArc(
      "late-write",
      parse(
        `"arc"; function Main() { this.trigger = () => true; $instruct("First"); $enter(Child); function Child() { $instruct("Second"); } }`,
      ),
    );
    const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(host, dialog);
    const before = (await workEventsFor(host).list(driver.arcRunId)).length;
    const write = store.putState.bind(store);
    let writes = 0;
    store.putState = async (key, state) => {
      writes += 1;
      if (writes === 2) throw new Error("later state write failed");
      await write(key, state);
    };
    await expect(
      driver.advance({
        dialog,
        input: {
          reports: [],
          instructionCoverage: {
            [taskId(driver.frontier.tasks[0]!)]: "applied",
          },
        },
      }),
    ).rejects.toThrow("later state write failed");
    expect(writes).toBe(2);
    expect(
      (await workEventsFor(host).list(driver.arcRunId)).slice(before),
    ).toEqual([]);
  });

  it("round trips every run lifecycle payload through both work stores", async () => {
    const stores = [
      new InMemoryWorkEventStore(),
      new JsonFileWorkEventStore({
        dir: await mkdtemp(join(tmpdir(), "run-events-roundtrip-")),
      }),
    ];
    const inputs: CreateWorkEventInput[] = [
      {
        kind: "run:handshake-pending",
        arcRunId: "selection",
        handshakeId: "h",
      },
      {
        kind: "run:handshake-resolved",
        arcRunId: "selection",
        handshakeId: "h",
        outcome: { kind: "reentry", arcRunId: "target" },
      },
      ...(["fresh", "reentry", "join", "rewind", "jump"] as const).map(
        (route) => ({
          kind: "run:started" as const,
          arcRunId: "selection",
          route,
        }),
      ),
      {
        kind: "run:deflection-occurred",
        arcRunId: "selection",
        reactivationCount: 2,
        origin: toNodeRef("control", ["Main", "Child"]),
      },
      {
        kind: "run:interruption-occurred",
        arcRunId: "selection",
        origin: toNodeRef("control", ["Main"]),
        interruption: { id: "duplicate-id", reason: "requested" },
      },
      {
        kind: "asks:invalidated",
        arcRunId: "selection",
        askIds: ["ask-one", "ask-two"],
      },
      { kind: "run:completed", arcRunId: "selection" },
      { kind: "run:deflected", arcRunId: "selection" },
      {
        kind: "run:poisoned",
        arcRunId: "selection",
        issues: [],
        instructionIssues: [],
      },
    ];
    for (const store of stores) {
      const written = [];
      for (const input of inputs) written.push(await store.appendEvent(input));
      expect(await collectAsync(store.listEvents("selection"))).toEqual(
        written,
      );
    }
  });
});
