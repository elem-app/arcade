import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

const fakeAgent = vi.hoisted(() => ({
  response: '{"report":{"outcome":"completed"}}',
  usage: undefined as Record<string, unknown> | undefined,
  prompts: [] as string[],
  systems: [] as Array<string | undefined>,
  error: undefined as unknown,
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state: { messages: unknown[] } = { messages: [] };

    constructor(options: { initialState?: { systemPrompt?: string } }) {
      fakeAgent.systems.push(options.initialState?.systemPrompt);
    }

    async prompt(prompt: string): Promise<void> {
      fakeAgent.prompts.push(prompt);
      if (fakeAgent.error !== undefined) throw fakeAgent.error;
      this.state.messages = [
        {
          role: "assistant",
          model: "pi-test",
          content: [{ type: "text", text: fakeAgent.response }],
          ...(fakeAgent.usage ? { usage: fakeAgent.usage } : {}),
        },
      ];
    }
  },
}));

import { createPiAgentBackend } from "../src/backends/pi-agent-backend.js";
import type { Backend, WorkerHost, WorkerSlot } from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  WorkerHubService,
  type ArcHostService,
  type Task,
} from "../src/testing.js";
import { firstTaskWithArcHost, makeArcHost } from "./helpers.js";
import { routineContext } from "./worker-hub-helpers.js";

describe("PI backend shared protocol adapter", () => {
  it("creates independent PI workers for configured slots", async () => {
    const backend = createPiAgentBackend({
      runner: async () => ({ outcome: "completed" }),
    });
    const host = workerHost();
    const first = await backend.createWorker(host, {
      backend: "pi-agent",
      kind: "role",
      role: "designer",
    });
    const second = await backend.createWorker(host, {
      backend: "pi-agent",
      kind: "role",
      role: "reviewer",
    });

    expect(first).not.toBe(second);
  });

  it("routes role and default worker slots through distinct PI workers", async () => {
    const backend = createPiAgentBackend({
      runner: async () => ({ outcome: "completed" }),
    });
    const host = workerHost();
    const slots: WorkerSlot[] = [
      { backend: "pi-agent", kind: "default" },
      {
        backend: "pi-agent",
        kind: "role",
        role: "researcher",
      },
    ];

    const workers = await Promise.all(
      slots.map((slot) => backend.createWorker(host, slot)),
    );

    expect(workers[0]).not.toBe(workers[1]);
  });

  it("executes instruction and semantic routines through the stock PI worker", async () => {
    resetFakeAgent();
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    instruction.guidance = ["Use the PI instruction policy."];
    const { workerHub } = await makePiHub(arcHost, createPiAgentBackend());

    await expect(
      workerHub.handleTask(instruction, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { outcome: "completed" },
    });
    fakeAgent.response = JSON.stringify({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });
    const semantic = semanticTaskFor(instruction);
    if (semantic.kind !== "semantic") throw new Error("Expected semantic task");
    semantic.requests[0]!.guidance = "Use the PI judgment policy.";
    await expect(
      workerHub.handleTask(semantic, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });

    expect(fakeAgent.prompts[0]).toContain("Work item:");
    expect(fakeAgent.prompts[1]).toContain("<semantic-requests>");
    expect(fakeAgent.prompts[0]).toContain(
      '"guidance": "Use the PI instruction policy."',
    );
    expect(fakeAgent.prompts[1]).toContain(
      '"guidance": "Use the PI judgment policy."',
    );
    expect(fakeAgent.prompts[1]).toContain(
      '"guidance": "Use the PI instruction policy."',
    );
    expect(fakeAgent.systems[0]).toContain(
      "Apply the work item's standing guidance",
    );
    expect(fakeAgent.systems[1]).toContain(
      "Apply each request's standing guidance",
    );
  });

  it("accepts flat reports from stock and injected PI runners", async () => {
    resetFakeAgent();
    fakeAgent.response = '{"report":{"outcome":"completed"}}';
    const { arcHost, task } = await firstTaskWithArcHost();
    const stock = await makePiHub(arcHost, createPiAgentBackend());
    await expect(
      stock.workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { outcome: "completed" },
    });

    const injected = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () => ({
          error: "failed",
          code: "agent-refused",
          message: "refused",
        }),
      }),
    );
    await expect(
      injected.workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { error: "failed", code: "agent-refused" },
    });
  });

  it("validates flat reports from an injected PI runner", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const { workerHub } = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () =>
          ({ outcome: "completed", error: "failed" }) as never,
      }),
    );

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { error: "failed", code: "backend-error" },
    });
  });

  it("records PI usage through RoutineEffects before applying its report", async () => {
    resetFakeAgent();
    fakeAgent.usage = {
      input: 8,
      output: 3,
      totalTokens: 11,
      cacheRead: 2,
      cacheWrite: 1,
      cost: { total: 0.1 },
    };
    const { arcHost, task } = await firstTaskWithArcHost();
    const { workerHub } = await makePiHub(arcHost, createPiAgentBackend());

    await workerHub.handleTask(task, routineContext());

    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:usage",
          tokenUsage: expect.objectContaining({
            inputTokens: 8,
            outputTokens: 3,
            totalTokens: 11,
          }),
        }),
      ]),
    );
  });

  it("translates expected PI capacity and transport failures inside the worker", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const capacity = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () => {
          throw Object.assign(new Error("Rate limit reached"), {
            status: 429,
            code: "rate_limit_exceeded",
          });
        },
      }),
      { provider: "openai", model: "gpt-test" },
    );
    await expect(
      capacity.workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({ status: "queued" });

    const transport = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () => {
          throw Object.assign(new Error("socket hang up"), {
            code: "ECONNRESET",
          });
        },
      }),
      { provider: "openai", model: "gpt-test" },
    );
    await expect(
      transport.workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({ status: "queued" });
  });

  it("translates PI provider rate limits to capacity interrupts", async () => {
    const backend = createPiAgentBackend({
      runner: async () => {
        throw Object.assign(new Error("Tokens per minute exceeded"), {
          status: 429,
          code: "rate_limit_exceeded",
        });
      },
    });
    const worker = await backend.createWorker(workerHost(), {
      backend: "pi-agent",
      kind: "role",
      role: "researcher",
      provider: "openai",
      model: "gpt-test",
    });

    await expect(worker.run(routineInput())).resolves.toMatchObject({
      suspension: "capacity-limited",
      reason: { reason: "token rate limit", provider: "openai" },
    });
  });

  it("translates PI provider transport failures to transport interrupts", async () => {
    const backend = createPiAgentBackend({
      runner: async () => {
        throw Object.assign(new Error("socket hang up"), {
          code: "ECONNRESET",
        });
      },
    });
    const worker = await backend.createWorker(workerHost(), {
      backend: "pi-agent",
      kind: "role",
      role: "researcher",
      provider: "anthropic",
      model: "claude-test",
    });

    await expect(worker.run(routineInput())).resolves.toMatchObject({
      suspension: "transport-lost",
      reason: { reason: "connection reset" },
    });
  });

  it("rejects removed status reports from stock and injected PI runners", async () => {
    resetFakeAgent();
    fakeAgent.response = '{"report":{"status":"queued"}}';
    const { arcHost, task } = await firstTaskWithArcHost();
    const stock = await makePiHub(arcHost, createPiAgentBackend());
    await expect(
      stock.workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { error: "failed", code: "backend-error" },
    });

    const injected = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () => ({ status: "queued" }) as never,
      }),
    );
    await expect(
      injected.workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { error: "failed", code: "backend-error" },
    });
  });

  it("routes only trigger-stage semantic work through a PI fast-trigger worker", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const piRunner = vi.fn(async (task: Task) =>
      task.kind === "semantic"
        ? {
            outcome: "completed" as const,
            semantic: { judgments: { "judge:required": true } },
          }
        : { outcome: "completed" as const },
    );
    const ordinaryRun = vi.fn(async () => ({ outcome: "completed" }) as const);
    const workerHub = createWorkerHub(arcHost);
    workerHub.addBackend(
      "pi-agent",
      createPiAgentBackend({ runner: piRunner }),
    );
    workerHub.addBackend("ordinary-agent", {
      supportedSlotKinds: new Set(["default"]),
      createWorker: () => ({
        disposeRoutine: async () => {},
        run: ordinaryRun,
      }),
    });
    await workerHub.start({
      workers: {
        default: { backend: "ordinary-agent" },
        fastTrigger: { backend: "pi-agent" },
      },
    });

    await workerHub.handleTask(
      semanticTaskFor(instruction, "trigger"),
      routineContext(),
    );
    await workerHub.handleTask(
      semanticTaskFor(instruction, "action"),
      routineContext(),
    );
    await workerHub.handleTask(instruction, routineContext());

    expect(piRunner).toHaveBeenCalledTimes(1);
    expect(ordinaryRun).toHaveBeenCalledTimes(2);
  });

  it("accepts a complete semantic report through the stock PI text path", async () => {
    resetFakeAgent();
    fakeAgent.response = JSON.stringify({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const { workerHub } = await makePiHub(arcHost, createPiAgentBackend());

    await expect(
      workerHub.handleTask(semanticTaskFor(instruction), routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });
  });

  it("rejects an incomplete semantic report through an injected PI runner", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const { workerHub } = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () => ({ outcome: "completed" }),
      }),
    );

    await expect(
      workerHub.handleTask(semanticTaskFor(instruction), routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: { error: "failed", code: "backend-error" },
    });
  });

  it("records unrequested PI semantic ids through central validation", async () => {
    const { arcHost, task: instruction } = await firstTaskWithArcHost();
    const { workerHub } = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () => ({
          outcome: "completed",
          semantic: {
            judgments: {
              "judge:required": true,
              "judge:extra": false,
            },
          },
        }),
      }),
    );

    await expect(
      workerHub.handleTask(semanticTaskFor(instruction), routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });
  });
});

function resetFakeAgent(): void {
  fakeAgent.response = '{"report":{"outcome":"completed"}}';
  fakeAgent.usage = undefined;
  fakeAgent.prompts = [];
  fakeAgent.systems = [];
  fakeAgent.error = undefined;
}

function createWorkerHub(
  arcHost: ArcHostService = makeArcHost(),
): WorkerHubService {
  return new WorkerHubService({
    arcHost,
    historyStore: new InMemoryHistoryStore(),
    routineStore: executionControlFor(arcHost),
    workEvents: workEventsFor(arcHost),
    routineDiagnosticsStore: new FileRoutineDiagnosticsStore(
      join(tmpdir(), "arcade-pi-backend-tests"),
    ),
    capacityRetry: { enabled: false },
  });
}

async function makePiHub(
  arcHost: ArcHostService,
  backend: Backend,
  slotConfig: Record<string, string> = {
    provider: "openai",
    model: "gpt-test",
  },
) {
  const workerHub = createWorkerHub(arcHost);
  workerHub.addBackend("pi-agent", backend);
  await workerHub.start({
    workers: {
      roles: {
        researcher: { backend: "pi-agent", ...slotConfig },
      },
    },
  });
  return { workerHub };
}

function semanticTaskFor(
  instruction: Extract<Task, { kind: "instruction" }>,
  stage: "trigger" | "action" = "action",
): Task {
  return {
    kind: "semantic",
    allowedDispositions: [],
    batchId: `semantic:pi:${stage}`,
    role: instruction.role,
    stage,
    contextIsolation: instruction.contextIsolation,
    arcRunId: instruction.arcRunId,
    dialog: instruction.dialog,
    activeInstruction: instruction,
    requests: [
      {
        kind: "judgment",
        briefId: "judge:required",
        role: instruction.role,
        question: "Is it ready?",
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

function workerHost(): WorkerHost {
  const state = new Map<string, unknown>();
  return {
    logger: {
      level: "silent",
      format: "json",
      info: () => undefined,
      debug: () => undefined,
    },
    state: {
      get: async (arcRunId, key) => state.get(`${arcRunId}:${key}`) as never,
      put: async (arcRunId, key, value) => {
        state.set(`${arcRunId}:${key}`, value);
      },
    },
  };
}

function routineInput() {
  const task: Extract<Task, { kind: "instruction" }> = {
    kind: "instruction",
    allowedDispositions: [],
    briefIds: ["instruction:pi"],
    role: "researcher",
    texts: ["Do work."],
    tools: [],
    cells: {},
    arcRunId: "arc-run:pi",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    sourceRef: "node:test:Main",
    contextIsolation: "role",
    phase: "apply",
  };
  return {
    routine: {
      id: "routine:pi",
      arcRunId: task.arcRunId,
      role: task.role,
      contextKey: "ctx:pi",
      task,
    },
    context: routineContext(),
    effects: {
      emit: async () => undefined,
      requestPermission: async () => ({ decision: "allow" as const }),
      logToolEvent: async () => ({}) as never,
      recordTokenUsage: async () => ({}) as never,
      checkSignal: async () => undefined,
    },
    diagnostics: {
      writeText: async () => undefined,
      writeJson: async () => undefined,
      appendText: async () => undefined,
      appendJsonl: async () => undefined,
    },
  };
}
