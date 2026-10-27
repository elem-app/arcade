import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionControlFor, workEventsFor } from "./work-event-fixtures.js";

import { describe, expect, it, vi } from "vitest";

const fakeAgent = vi.hoisted(() => ({
  response: '{"report":{"outcome":"completed"}}' as
    | string
    | ((prompt: string) => string),
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
          content: [
            {
              type: "text",
              text:
                typeof fakeAgent.response === "function"
                  ? fakeAgent.response(prompt)
                  : fakeAgent.response,
            },
          ],
          ...(fakeAgent.usage ? { usage: fakeAgent.usage } : {}),
        },
      ];
    }
  },
}));

import { createPiAgentBackend } from "../src/backends/pi-agent-backend.js";
import type {
  Backend,
  RoutineInput,
  RoutineReport,
  WorkerHost,
  WorkerSlot,
} from "../src/index.js";
import {
  FileRoutineDiagnosticsStore,
  InMemoryHistoryStore,
  WorkerHubService,
  type ArcHostService,
  type Task,
} from "../src/testing.js";
import {
  makeArcHost,
  makeArcHostWithSource,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import {
  recordAdvanceInputs,
  routineContext,
  semanticRequestIds,
  settleFirstRoutine,
  submitActivation,
} from "./worker-hub-helpers.js";

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
    fakeAgent.response = (prompt) =>
      prompt.includes("<semantic-requests>")
        ? JSON.stringify({
            report: {
              outcome: "completed",
              semantic: {
                judgments: Object.fromEntries(
                  requestIds(prompt).map((id) => [id, true]),
                ),
              },
            },
          })
        : '{"report":{"outcome":"completed"}}';
    const arcHost = await makeArcHostWithSource(
      "guided",
      `"arc";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  this.guidance = \`Use the PI policy.\`;
  $instructLoop(\`Watch for updates.\`, {
    resolveWhen: \`the updates are collected\`,
  });
}`,
    );
    const { workerHub } = await makePiHub(arcHost, createPiAgentBackend());

    const arcRunId = await submitActivation(workerHub, "start");
    await waitForRunEnd(workerHub, arcRunId);

    // The instruction's apply phase, then its postcheck judgment.
    expect(fakeAgent.prompts).toHaveLength(2);
    expect(fakeAgent.prompts[0]).toContain("Work item:");
    expect(fakeAgent.prompts[1]).toContain("<semantic-requests>");
    expect(fakeAgent.prompts[0]).toContain('"guidance": "Use the PI policy."');
    expect(fakeAgent.prompts[1]).toContain('"guidance": "Use the PI policy."');
    expect(fakeAgent.prompts[1]).toContain("<active-instruction>");
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
    const stockHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const stock = await makePiHub(stockHost, createPiAgentBackend());
    const { routine: stockRoutine } = await settleFirstRoutine(
      stock.workerHub,
      executionControlFor(stockHost),
    );
    expect(stockRoutine).toMatchObject({ status: "finished" });
    expect(stockRoutine.error).toBeUndefined();

    const injectedHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const injected = await makePiHub(
      injectedHost,
      createPiAgentBackend({
        runner: async () => ({
          error: "failed",
          code: "agent-refused",
          message: "refused",
        }),
      }),
    );
    const { routine } = await settleFirstRoutine(
      injected.workerHub,
      executionControlFor(injectedHost),
    );
    expect(routine).toMatchObject({
      status: "finished",
      error: { code: "agent-refused" },
    });
  });

  it("validates flat reports from an injected PI runner", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub } = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () =>
          ({ outcome: "completed", error: "failed" }) as never,
      }),
    );

    const { routine } = await settleFirstRoutine(
      workerHub,
      executionControlFor(arcHost),
    );
    expect(routine).toMatchObject({
      status: "finished",
      error: { code: "backend-error" },
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
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub } = await makePiHub(arcHost, createPiAgentBackend());

    const { arcRunId } = await settleFirstRoutine(
      workerHub,
      executionControlFor(arcHost),
    );

    await expect(workerHub.listWorkEvents(arcRunId)).resolves.toEqual(
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
    const capacityHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const capacity = await makePiHub(
      capacityHost,
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
    const { routine: capacityRoutine } = await settleFirstRoutine(
      capacity.workerHub,
      executionControlFor(capacityHost),
    );
    expect(capacityRoutine.status).toBe("capacity-limited");

    const transportHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const transport = await makePiHub(
      transportHost,
      createPiAgentBackend({
        runner: async () => {
          throw Object.assign(new Error("socket hang up"), {
            code: "ECONNRESET",
          });
        },
      }),
      { provider: "openai", model: "gpt-test" },
    );
    const { routine: transportRoutine } = await settleFirstRoutine(
      transport.workerHub,
      executionControlFor(transportHost),
    );
    expect(transportRoutine.status).toBe("transport-lost");
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
    const stockHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const stock = await makePiHub(stockHost, createPiAgentBackend());
    const { routine: stockRoutine } = await settleFirstRoutine(
      stock.workerHub,
      executionControlFor(stockHost),
    );
    expect(stockRoutine).toMatchObject({
      status: "finished",
      error: { code: "backend-error" },
    });

    const injectedHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const injected = await makePiHub(
      injectedHost,
      createPiAgentBackend({
        runner: async () => ({ status: "queued" }) as never,
      }),
    );
    const { routine } = await settleFirstRoutine(
      injected.workerHub,
      executionControlFor(injectedHost),
    );
    expect(routine).toMatchObject({
      status: "finished",
      error: { code: "backend-error" },
    });
  });

  it("routes only trigger-stage semantic work through a PI fast-trigger worker", async () => {
    // A judged trigger, then an action judgment and the instruction it gates.
    const arcHost = await makeArcHostWithSource(
      "judged",
      `"arc";
function Watch() {
  this.trigger = () => judge(\`should this start?\`);
  this.hostParams = { workerRole: "researcher" };
  if (judge(\`is the work ready?\`)) {
    $instruct(\`Proceed.\`);
  }
}`,
    );
    const piRunner = vi.fn(async (task: Task) => answerAll(task));
    const ordinaryRun = vi.fn(async (input: RoutineInput) =>
      answerAll(input.routine.task),
    );
    const workerHub = await createWorkerHub(arcHost);
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

    const arcRunId = await submitActivation(workerHub, "start");
    await waitForRunEnd(workerHub, arcRunId);

    expect(piRunner).toHaveBeenCalledTimes(1);
    expect(ordinaryRun).toHaveBeenCalledTimes(2);
  });

  it("accepts a complete semantic report through the stock PI text path", async () => {
    resetFakeAgent();
    // Declining the judgment keeps the run to its semantic routine.
    fakeAgent.response = (prompt) =>
      JSON.stringify({
        report: {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              requestIds(prompt).map((id) => [id, false]),
            ),
          },
        },
      });
    const arcHost = await makeArcHostWithSource("judge", JUDGE_SOURCE);
    const advanceInputs = recordAdvanceInputs(arcHost);
    const { workerHub } = await makePiHub(arcHost, createPiAgentBackend());

    const { routine } = await settleFirstRoutine(
      workerHub,
      executionControlFor(arcHost),
    );
    expect(routine).toMatchObject({ status: "finished" });
    await waitFor(() => advanceInputs.length === 1);
    expect(advanceInputs[0]).toMatchObject({
      reports: [
        expect.objectContaining({
          outcome: "completed",
          semantic: { judgments: { [judgmentId(routine.task)]: false } },
        }),
      ],
    });
  });

  it("rejects an incomplete semantic report through an injected PI runner", async () => {
    const arcHost = await makeArcHostWithSource("judge", JUDGE_SOURCE);
    const { workerHub } = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async () => ({ outcome: "completed" }),
      }),
    );

    const { routine } = await settleFirstRoutine(
      workerHub,
      executionControlFor(arcHost),
    );
    expect(routine).toMatchObject({
      status: "finished",
      error: { code: "backend-error" },
    });
  });

  it("records unrequested PI semantic ids through central validation", async () => {
    const arcHost = await makeArcHostWithSource("judge", JUDGE_SOURCE);
    const advanceInputs = recordAdvanceInputs(arcHost);
    const { workerHub } = await makePiHub(
      arcHost,
      createPiAgentBackend({
        runner: async (task) => ({
          outcome: "completed",
          semantic: {
            judgments: {
              [judgmentId(task)]: false,
              "judge:extra": false,
            },
          },
        }),
      }),
    );

    const { routine } = await settleFirstRoutine(
      workerHub,
      executionControlFor(arcHost),
    );
    await waitFor(() => advanceInputs.length === 1);
    expect(advanceInputs[0]).toMatchObject({
      reports: [
        expect.objectContaining({
          outcome: "completed",
          semantic: { judgments: { [judgmentId(routine.task)]: false } },
        }),
      ],
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

async function createWorkerHub(
  arcHost?: ArcHostService,
): Promise<WorkerHubService> {
  arcHost ??= await makeArcHost();
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
  const workerHub = await createWorkerHub(arcHost);
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

const JUDGE_SOURCE = `"arc";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  if (judge(\`is it ready?\`)) {
    $instruct(\`Proceed.\`);
  }
}`;

/** The id of the single judgment a semantic task requests. */
function judgmentId(task: Task): string {
  if (task.kind !== "semantic") throw new Error("expected semantic task");
  return task.requests[0]!.briefId;
}

/** Request ids in a PI semantic prompt's request block. */
function requestIds(prompt: string): string[] {
  const block =
    prompt.split("<semantic-requests>")[1]?.split("</semantic-requests>")[0] ??
    "";
  return semanticRequestIds(block);
}

/** Answer every semantic request true, and complete instruction work. */
function answerAll(task: Task): RoutineReport {
  return task.kind === "semantic"
    ? {
        outcome: "completed",
        semantic: {
          judgments: Object.fromEntries(
            task.requests.map((request) => [request.briefId, true]),
          ),
        },
      }
    : { outcome: "completed" };
}

/** Wait until the run's work events record its end. */
async function waitForRunEnd(
  workerHub: WorkerHubService,
  arcRunId: string,
): Promise<void> {
  await waitFor(async () =>
    (await workerHub.listWorkEvents(arcRunId)).some(
      (event) =>
        event.kind === "run:completed" || event.kind === "run:poisoned",
    ),
  );
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
