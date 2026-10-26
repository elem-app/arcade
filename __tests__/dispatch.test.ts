import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestArcHost,
  executionControlFor,
} from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  InMemoryArcHostStore,
  taskId,
  workerContextKey,
  type ClaudeSdkQueryFn,
  type ClaudeSdkStartupFn,
  type ClaudeSdkTstQueryFn,
  type ClaudeSdkTstStartupFn,
  type InboundLifecycleEvent,
  type InstructionTask,
  type OpenAiSdkRunFn,
  type OpenAiSdkTstRunFn,
  type RoleWorker,
  type RoutineContext,
  type RunFrontier,
  type Task,
} from "../src/testing.js";
import { callOpenAiTool } from "./backend-helpers.js";
import {
  ALICE_OWNER,
  ARC_RUN_ID,
  collectAsync,
  firstTaskWithArcHost,
  GREET_SOURCE,
  makeArcHost,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import {
  claudeSemanticMessages,
  claudeStreamingQuery,
  openAiSemanticTask,
  recordAdvanceInputs,
  routineContext,
  semanticRequestIds,
  submitActivation,
} from "./worker-hub-helpers.js";

describe("Worker hub dispatch and worker-slot routing", () => {
  it.each([
    ["first matching reply", ["SQUAWK"]],
    ["nonmatching reply then matching reply", ["hello", "SQUAWK"]],
  ] as const)(
    "postchecks a persistent instruction after %s",
    async (_name, replies) => {
      const arcHost = await makeArcHostWithSource(
        "squawk-postcheck",
        `"arc";
function Main() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "worker" };
  $instructLoop(\`Say Squawk then wait for a reply.\`, {
    resolveWhen: \`\${user} said exactly SQUAWK\`,
  });
  $instruct(\`Stopped.\`);
}`,
      );
      const sequence: string[] = [];
      const asks: { arcRunId: string; askId: string }[] = [];
      const { workerHub } = makeWorkerHub({
        arcHost,
        workers: {
          worker: async (task, _context, effects) => {
            if (task.kind === "semantic") {
              const reply = task.dialog.lastTurns
                .filter((turn) => turn.role === "user")
                .at(-1)?.message;
              sequence.push(`judge:${reply}`);
              return {
                outcome: "completed",
                semantic: {
                  judgments: Object.fromEntries(
                    task.requests.map((request) => [
                      request.briefId,
                      reply === "SQUAWK",
                    ]),
                  ),
                },
              };
            }
            if (task.texts.join("").includes("Stopped.")) {
              sequence.push("stopped");
              await effects.emit({
                situation: { audience: "originator", cause: "reply" },
                content: "Stopped.",
              });
            } else {
              sequence.push("apply");
              const reply = await effects.emit({
                situation: { audience: "originator", cause: "question" },
                content: "Squawk",
              });
              sequence.push(`answered:${reply}`);
            }
            return { outcome: "completed" };
          },
        },
      });
      workerHub.registerOutboundHandler(
        { role: "worker", audience: "originator", cause: "question" },
        (message) => {
          asks.push({
            arcRunId: message.arcRunId,
            askId: String(message.metadata?.askId),
          });
        },
      );
      const activation = submitActivation(workerHub, "Be a parrot.");
      for (const [index, reply] of replies.entries()) {
        await waitFor(() => asks.length > index);
        expect(sequence).toEqual([
          ...replies
            .slice(0, index)
            .flatMap((prior) => [
              "apply",
              `answered:${prior}`,
              `judge:${prior}`,
            ]),
          "apply",
        ]);
        const ask = asks[index]!;
        await collectAsync(
          workerHub.submitInbound({
            arcRunId: ask.arcRunId,
            content: reply,
            metadata: { askId: ask.askId },
          }),
        );
      }
      const arcRunId = await activation;
      await waitFor(() => sequence.includes("stopped"));
      expect(sequence).toEqual([
        ...replies.flatMap((reply) => [
          "apply",
          `answered:${reply}`,
          `judge:${reply}`,
        ]),
        "stopped",
      ]);
      expect(asks).toHaveLength(replies.length);
      await waitFor(
        async () =>
          (await arcHost.listRunViews())
            .filter((view) => view.stage === "actioning")
            .find((view) => view.arcRunId === arcRunId)?.lifecycle ===
          "completed",
      );
    },
  );

  it("rejects duplicate role workers", () => {
    const arcHost = makeArcHost();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });

    expect(() =>
      workerHub.registerRoleWorker("researcher", async () => ({
        outcome: "completed",
      })),
    ).toThrow('Worker hub worker already registered for role "researcher".');
  });

  it("dispatches instruction tasks to openai-sdk", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-pool" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "openai-sdk" },
      openAiSdk: {
        apiKey: "sk-test",
        run,
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid task source refs before persisting a routine", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const invalidTask = { ...task, sourceRef: "node:watch:Missing" as const };
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async () => ({ outcome: "completed" }),
      },
    });

    await expect(
      workerHub.handleTask(invalidTask, routineContext()),
    ).rejects.toThrow(
      `Arc run ${ARC_RUN_ID} snapshot has no node for source ref node:watch:Missing.`,
    );
    await expect(collectAsync(routineStore.listRoutines())).resolves.toEqual(
      [],
    );
  });

  it("resolves pinned action node metadata once per routine after source replacement", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    await arcHost.registerArc(
      "watch",
      parse(`
"arc";

function Replacement() {
  this.trigger = () => true;
}
`),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );
    expect(() => arcHost.nodeInfoForRef(task.sourceRef)).toThrow(
      `No registered Arc node for source ref ${task.sourceRef}.`,
    );
    const nodeInfoForRunRef = vi.spyOn(arcHost, "nodeInfoForRunRef");
    const worker = vi.fn<RoleWorker>(async (_task, _context, effects) => {
      await effects.logToolEvent({
        kind: "tool:started",
        toolCallId: "tool:pinned-node",
        toolName: "pinned-node",
      });
      await effects.logToolEvent({
        kind: "tool:finished",
        toolCallId: "tool:pinned-node",
        toolName: "pinned-node",
      });
      return { outcome: "completed" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });
    expect(worker).toHaveBeenCalledOnce();
    expect(nodeInfoForRunRef).toHaveBeenCalledOnce();
    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:started",
          nodeName: "Watch",
        }),
      ]),
    );
  });

  it("resolves trigger task node metadata from the latest runtime", async () => {
    const { arcHost, task: activeInstruction } = await firstTaskWithArcHost();
    await arcHost.registerArc(
      "watch",
      parse(`
"arc";

function Watch() {
  this.description = "Replacement trigger node.";
  this.trigger = () => true;
}
`),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:latest-trigger-node",
      role: DEFAULT_WORKER_ROLE,
      stage: "trigger",
      contextIsolation: "role",
      arcRunId: activeInstruction.arcRunId,
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      requests: [],
      activeInstruction,
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        [DEFAULT_WORKER_ROLE]: async () => ({ outcome: "completed" }),
      },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });
    await expect(workerHub.listWorkEvents(task.arcRunId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine:started",
          nodeName: "Watch",
          nodeDescription: "Replacement trigger node.",
        }),
      ]),
    );
  });

  it("starts Claude fresh when continuity identity is unavailable", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const routineStore = executionControlFor(arcHost);
    const getRunWorkspaceContext = arcHost.getRunWorkspaceContext.bind(arcHost);
    let restored = false;
    vi.spyOn(arcHost, "getRunWorkspaceContext").mockImplementation(
      async (arcRunId) => {
        const runContext = await getRunWorkspaceContext(arcRunId);
        if (!restored) {
          restored = true;
          const persistedTask: InstructionTask = {
            kind: "instruction",
            allowedDispositions: [],
            briefIds: ["instruction:persisted-context"],
            role: "researcher",
            texts: ["Watch for updates."],
            tools: [],
            cells: {},
            arcRunId,
            dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
            sourceRef: "node:watch:Watch",
            contextIsolation: "role",
            phase: "apply",
          };
          await routineStore.putRoutine({
            id: "routine:persisted-claude-context",
            role: persistedTask.role,
            backend: "claude-sdk",
            arcRunId,
            status: "finished",
            task: persistedTask,
            updatedAt: "2026-07-30T00:00:00.000Z",
            backendDetails: {
              backend: "claude-sdk",
              sessionKey: workerContextKey(persistedTask, 0),
              sessionId: "session-persisted-context",
              cwd: runContext.workspacePath,
              model: "claude-opus-4-7",
            },
          });
        }
        return runContext;
      },
    );
    let startupOptions: NonNullable<
      Parameters<ClaudeSdkStartupFn>[0]
    >["options"];
    const warmQuery = vi.fn(
      (prompt: Parameters<ClaudeSdkQueryFn>[0]["prompt"]) =>
        claudeStreamingQuery({
          prompt,
          options: startupOptions,
        }),
    );
    const startup = vi.fn(async (params: Parameters<ClaudeSdkStartupFn>[0]) => {
      startupOptions = params?.options;
      return { query: warmQuery, close: vi.fn() };
    });
    const coldQuery = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      claudeStreamingQuery(params),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: coldQuery as unknown as ClaudeSdkQueryFn,
        startup: startup as unknown as ClaudeSdkStartupFn,
      },
    });

    await submitActivation(workerHub, "start watching");
    await waitFor(() => warmQuery.mock.calls.length === 1);

    expect(startup).toHaveBeenCalledTimes(1);
    expect(coldQuery).not.toHaveBeenCalled();
    expect(startupOptions?.resume).toBeUndefined();
  });

  it("starts OpenAI fresh when continuity identity is unavailable", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "arcade-openai-context-reconstruction-"),
    );
    const { arcHost, task } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    await routineStore.putRoutine({
      id: "routine:persisted-openai-context",
      role: task.role,
      backend: "openai-sdk",
      arcRunId: task.arcRunId,
      status: "finished",
      task,
      updatedAt: "2026-07-30T00:00:00.000Z",
      backendDetails: {
        backend: "openai-sdk",
        sessionKey: workerContextKey(task, 0),
        responseId: "response-persisted-context",
        cwd: workspace,
        model: "gpt-5.5",
      },
    });
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "response-next-context" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      openAiSdk: { apiKey: "sk-test", run },
    });

    await expect(
      workerHub.handleTask(task, routineContext({ workspacePath: workspace })),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });
    expect(run.mock.calls[0]![0].previousResponseId).toBeUndefined();
  });

  it("keeps general-backend trigger continuity separate from action continuity", async () => {
    const { arcHost, task: actionTask } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    const context = routineContext();
    await routineStore.putRoutine({
      id: "routine:persisted-action-context",
      role: actionTask.role,
      backend: "claude-sdk",
      arcRunId: actionTask.arcRunId,
      status: "finished",
      task: actionTask,
      updatedAt: "2026-07-30T00:00:00.000Z",
      backendDetails: {
        backend: "claude-sdk",
        sessionKey: workerContextKey(actionTask, 0),
        sessionId: "session-action-context",
        cwd: context.workspacePath,
        model: "claude-opus-4-7",
      },
    });
    const triggerTask: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:general-backend-trigger",
      role: actionTask.role,
      stage: "trigger",
      contextIsolation: "role",
      arcRunId: actionTask.arcRunId,
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      requests: [],
      activeInstruction: actionTask,
    };
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      claudeStreamingQuery(params),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: { query, sessionCache: { maxPreparedStarts: 0 } },
    });

    await expect(
      workerHub.handleTask(triggerTask, context),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });

    expect(query.mock.calls[0]![0].options?.resume).toBeUndefined();
    expect(workerContextKey(triggerTask, 0)).not.toBe(
      workerContextKey(actionTask, 0),
    );
    const routines = await collectAsync(
      routineStore.listRoutines(actionTask.arcRunId),
    );
    expect(
      routines.find((routine) => routine.task.kind === "semantic")
        ?.backendDetails,
    ).toMatchObject({
      backend: "claude-sdk",
      sessionKey: workerContextKey(triggerTask, 0),
      sessionId: "session-worker-hub-prepared",
    });
  });

  it("treats warm hints as optional and preserves cold Claude execution", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let startupOptions: NonNullable<
      Parameters<ClaudeSdkStartupFn>[0]
    >["options"];
    const warmQuery = vi.fn(
      (prompt: Parameters<ClaudeSdkQueryFn>[0]["prompt"]) =>
        claudeStreamingQuery({
          prompt,
          options: startupOptions,
        }),
    );
    const startup = vi.fn(async (params: Parameters<ClaudeSdkStartupFn>[0]) => {
      startupOptions = params?.options;
      return {
        query: warmQuery,
        close: vi.fn(),
      };
    });
    const coldQuery = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      claudeStreamingQuery(params),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: coldQuery as unknown as ClaudeSdkQueryFn,
        startup: startup as unknown as ClaudeSdkStartupFn,
        sessionCache: { maxPreparedStarts: 0 },
      },
    });

    const arcRunId = await submitActivation(workerHub, "start watching");
    await waitFor(() => coldQuery.mock.calls.length === 1);
    expect(startup).not.toHaveBeenCalled();
    expect(warmQuery).not.toHaveBeenCalled();
    expect(coldQuery.mock.calls[0]?.[0].options?.cwd).toContain(
      arcRunId.replace(":", "-"),
    );
  });

  it("starts fast-trigger warmup from hub context without delaying dispatch", async () => {
    const arcHost = makeArcHost();
    await arcHost.registerArc(
      "semantic-eval",
      parse(`
"arc";

function Main() {
  this.hostParams = {
    workerRole: "responder",
  };
  this.trigger = () => {
    return judge(\`user wants this semantic eval\`);
  };
  $instruct(\`Reply to the user.\`);
}
`),
    );
    const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) =>
      claudeSemanticMessages({
        report: {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              semanticRequestIds(String(params.prompt)).map((id) => [id, true]),
            ),
          },
        },
      }),
    );
    let resolveStartup!: (warm: {
      query: (prompt: string) => ReturnType<ClaudeSdkTstQueryFn>;
      close: () => void;
    }) => void;
    const startup = vi.fn(
      () =>
        new Promise<{
          query: (prompt: string) => ReturnType<ClaudeSdkTstQueryFn>;
          close: () => void;
        }>((resolve) => {
          resolveStartup = resolve;
        }),
    );
    const worker = vi.fn<RoleWorker>(async () => ({
      outcome: "completed",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTst: {
        query: query as unknown as ClaudeSdkTstQueryFn,
        startup: startup as unknown as ClaudeSdkTstStartupFn,
        fastStarts: { enabled: true, maxPreparedStarts: 1 },
      },
      workers: { responder: worker },
    });

    expect(startup).not.toHaveBeenCalled();
    const activation = submitActivation(workerHub, "start semantic eval");
    try {
      await waitFor(() => worker.mock.calls.length === 1);
      await activation;
      expect(startup).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      resolveStartup?.({
        query: (prompt) =>
          query({
            prompt,
          } as Parameters<ClaudeSdkTstQueryFn>[0]) as ReturnType<ClaudeSdkTstQueryFn>,
        close: vi.fn(),
      });
      await workerHub.stop();
    }
  });

  it("dispatches fast trigger tasks to openai-sdk", async () => {
    const arcHost = await makeArcHostWithSource(
      "test",
      `"arc"; function Main() {}`,
    );
    vi.spyOn(arcHost, "getRunWorkspaceContext").mockResolvedValue({
      ...routineContext(),
      reactivationCount: 0,
    });
    const run = vi.fn<OpenAiSdkTstRunFn>(async () => ({
      finalOutput: JSON.stringify({
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      }),
      lastResponseId: "resp-semantic",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      fastTriggerBackend: "openai-sdk-tst",
      openAiSdkTst: {
        apiKey: "sk-test",
        run,
      },
    });

    await expect(
      workerHub.handleTask(openAiSemanticTask(), routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("persists a failed routine for unknown instruction roles", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const routineStore = executionControlFor(arcHost);
    const { workerHub } = makeWorkerHub({ arcHost, routineStore });

    const result = await workerHub.handleTask(task, routineContext());

    expect(result).toEqual({
      status: "finished",
      routineId: expect.any(String),
      report: {
        error: "failed",
        code: "role-not-delegated",
        message: 'No configured worker is available for role "researcher".',
      },
    });
    const routines = [];
    for await (const routine of routineStore.listRoutines(ARC_RUN_ID)) {
      routines.push(routine);
    }
    expect(routines).toEqual([
      expect.objectContaining({
        role: "researcher",
        status: "finished",
        error: {
          code: "role-not-delegated",
          message: 'No configured worker is available for role "researcher".',
        },
      }),
    ]);
  });

  it("requires an in-process handler for an in-process role slot", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "in-process" } },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: {
        error: "failed",
        code: "unknown-role",
        message:
          'No in-process handler registered for configured role "researcher".',
      },
    });
  });

  it("routes default-worker semantic work through the default worker slot", async () => {
    const { arcHost, task: activeInstruction } = await firstTaskWithArcHost();
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:default",
      role: DEFAULT_WORKER_ROLE,
      stage: "trigger",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      requests: [],
      activeInstruction,
    };
    const runner = vi.fn(async () => ({
      outcome: "completed" as const,
      semantic: { judgments: { "judge:1": true } },
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      runner,
      workerSlots: { default: "pi-agent" },
    });

    await expect(workerHub.handleTask(task, routineContext())).resolves.toEqual(
      {
        status: "finished",
        routineId: expect.any(String),
        report: {
          outcome: "completed",
          semantic: { judgments: { "judge:1": true } },
        },
      },
    );
    expect(runner).toHaveBeenCalledWith(task);
  });

  it("logs PI-agent backend lifecycle events", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const logger = {
      level: "info" as const,
      format: "json" as const,
      info: vi.fn(),
      debug: vi.fn(),
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      runner: async () => ({ outcome: "completed" }),
      workerSlots: { default: "pi-agent" },
      logger,
    });

    await workerHub.handleTask(task, routineContext());

    expect(logger.info).toHaveBeenCalledWith(
      "backend.pi_agent.started",
      expect.objectContaining({
        arcRunId: ARC_RUN_ID,
        routineId: expect.stringMatching(/^routine:/),
        role: task.role,
        kind: task.kind,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "backend.pi_agent.finished",
      expect.objectContaining({
        arcRunId: ARC_RUN_ID,
        routineId: expect.stringMatching(/^routine:/),
        role: task.role,
        reportKind: "completed",
      }),
    );
  });

  it("fails default-worker work when no default worker slot is configured", async () => {
    const { arcHost, task: activeInstruction } = await firstTaskWithArcHost();
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:no-default",
      role: DEFAULT_WORKER_ROLE,
      stage: "trigger",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      requests: [],
      activeInstruction,
    };
    const { workerHub } = makeWorkerHub({ arcHost });

    await expect(workerHub.handleTask(task, routineContext())).resolves.toEqual(
      {
        status: "finished",
        routineId: expect.any(String),
        report: {
          error: "failed",
          code: "role-not-delegated",
          message: `No configured worker is available for role "${DEFAULT_WORKER_ROLE}".`,
        },
      },
    );
  });

  it("routes trigger semantic work through the fast-trigger slot", async () => {
    const { arcHost, task: activeInstruction } = await firstTaskWithArcHost();
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:fast",
      role: DEFAULT_WORKER_ROLE,
      stage: "trigger",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      requests: [],
      activeInstruction,
    };
    const piRunner = vi.fn(async () => ({
      outcome: "completed" as const,
      semantic: { judgments: { "judge:fast": true } },
    }));
    const openAiRun = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return {};
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      runner: piRunner,
      workerSlots: { default: "openai-sdk" },
      fastTriggerBackend: "pi-agent",
      openAiSdk: { apiKey: "sk-test", run: openAiRun },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:fast": true } },
      },
    });
    expect(piRunner).toHaveBeenCalledTimes(1);
    expect(openAiRun).not.toHaveBeenCalled();
  });

  it("routes action semantic work through the default slot when fast trigger is configured", async () => {
    const { arcHost, task: activeInstruction } = await firstTaskWithArcHost();
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:action",
      role: DEFAULT_WORKER_ROLE,
      stage: "action",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      requests: [],
      activeInstruction,
    };
    const piRunner = vi.fn(async () => ({ outcome: "completed" as const }));
    const openAiRun = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return {};
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      runner: piRunner,
      workerSlots: { default: "openai-sdk" },
      fastTriggerBackend: "pi-agent",
      openAiSdk: { apiKey: "sk-test", run: openAiRun },
    });

    await expect(
      workerHub.handleTask(task, routineContext()),
    ).resolves.toMatchObject({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });
    expect(openAiRun).toHaveBeenCalledTimes(1);
    expect(piRunner).not.toHaveBeenCalled();
  });

  it("keeps instruction work on its configured role slot", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const piRunner = vi.fn(async () => ({ outcome: "completed" as const }));
    const openAiRun = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return {};
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      runner: piRunner,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      fastTriggerBackend: "pi-agent",
      openAiSdk: { apiKey: "sk-test", run: openAiRun },
    });

    await workerHub.handleTask(task, routineContext());

    expect(openAiRun).toHaveBeenCalledTimes(1);
    expect(piRunner).not.toHaveBeenCalled();
  });

  it("lets an explicit role slot override the default semantic backend", async () => {
    const { arcHost, task: activeInstruction } = await firstTaskWithArcHost();
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:override",
      role: DEFAULT_WORKER_ROLE,
      stage: "trigger",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
      requests: [],
      activeInstruction,
    };
    const worker = vi.fn(async () => ({
      outcome: "completed" as const,
      semantic: { judgments: { "judge:2": false } },
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { [DEFAULT_WORKER_ROLE]: "in-process" } },
      workers: { [DEFAULT_WORKER_ROLE]: worker },
    });

    await expect(workerHub.handleTask(task, routineContext())).resolves.toEqual(
      {
        status: "finished",
        routineId: expect.any(String),
        report: {
          outcome: "completed",
          semantic: { judgments: { "judge:2": false } },
        },
      },
    );
    expect(worker).toHaveBeenCalled();
  });

  it("materializes task workspace paths before dispatch", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const root = await mkdtemp(
      join(tmpdir(), "arcade-worker-hub-materialize-"),
    );
    const workspacePath = join(root, "missing", "workspace");
    const worker = vi.fn(async (_task, context: RoutineContext) => {
      expect((await stat(context.workspacePath)).isDirectory()).toBe(true);
      return { outcome: "completed" as const };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });

    const result = await workerHub.handleTask(
      task,
      routineContext({ workspacePath }),
    );

    expect(result).toEqual({
      status: "finished",
      routineId: expect.any(String),
      report: { outcome: "completed" },
    });
    expect((await stat(workspacePath)).isDirectory()).toBe(true);
  });

  it.each([
    [
      "supplies the process cwd to claude-sdk through trigger context",
      "claude-sdk",
      false,
    ],
    [
      "supplies the process cwd to openai-sdk through trigger context",
      "openai-sdk",
      false,
    ],
    [
      "leaves configured Claude cwd under configuration ownership",
      "claude-sdk",
      true,
    ],
    [
      "leaves configured OpenAI cwd under configuration ownership",
      "openai-sdk",
      true,
    ],
  ] as const)("%s", async (_name, backend, override) => {
    const { arcHost, task: actionTask } = await firstTaskWithArcHost();
    const root = await mkdtemp(join(tmpdir(), "arcade-standard-trigger-"));
    const provisionalPath = join(root, "provisional");
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      stage: "trigger",
      batchId: "temporary-workspace",
      role: actionTask.role,
      arcRunId: actionTask.arcRunId,
      contextIsolation: "role",
      dialog: actionTask.dialog,
      requests: [],
      activeInstruction: actionTask,
    };
    let observedCwd: string | undefined;
    let suppliedWorkspace: string | undefined;
    const routineOptions = ({ context }: { context: RoutineContext }) => {
      suppliedWorkspace = context.workspacePath;
      return undefined;
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { [task.role]: backend } },
      claudeSdk: {
        sessionCache: { maxPreparedStarts: 0 },
        cwd: override ? root : undefined,
        routineOptions,
        query: (params) => {
          observedCwd = params.options?.cwd;
          return claudeStreamingQuery(params);
        },
      },
      openAiSdk: {
        cwd: override ? root : undefined,
        routineOptions,
        apiKey: "sk-test",
        run: async (input) => {
          await callOpenAiTool(input.agent, "report", {
            outcome: "completed",
          });
          return { lastResponseId: "temporary-workspace-response" };
        },
        onResponseObserved: async ({ cwd }) => {
          observedCwd = cwd;
        },
      },
    });
    try {
      const result = await workerHub.handleTask(
        task,
        routineContext({ workspacePath: provisionalPath }),
      );
      expect(result).toMatchObject({
        status: "finished",
        routineId: expect.any(String),
        report: { outcome: "completed" },
      });
      expect(observedCwd).toBeDefined();
      expect(suppliedWorkspace).toBeDefined();
      expect(suppliedWorkspace).toBe(process.cwd());
      expect(observedCwd).toBe(override ? root : suppliedWorkspace);
      expect((await stat(suppliedWorkspace!)).isDirectory()).toBe(true);
      expect((await stat(observedCwd!)).isDirectory()).toBe(true);
      await expect(stat(provisionalPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await workerHub.stop();
    }
    expect((await stat(suppliedWorkspace!)).isDirectory()).toBe(true);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it.each([
    [
      "supplies the process cwd across trigger rounds before action activation",
      true,
    ],
    ["preserves the process cwd after trigger rejection", false],
    ["preserves the process cwd after trigger failure", "failed"],
  ] as const)("%s", async (_name, matches) => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "arcade-probe-ws-"));
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
      artifactRoot,
    });
    await arcHost.registerArc(
      "ready",
      parse(`
"arc";
function Ready() {
  this.hostParams = { workerRole: "responder" };
  this.trigger = () => judge(\`first question\`) && judge(\`second question\`);
  $instruct(\`Welcome the user.\`);
}
`),
    );
    const triggerPaths: string[] = [];
    let actionPath: string | undefined;
    const worker: RoleWorker = async (task, context) => {
      expect((await stat(context.workspacePath)).isDirectory()).toBe(true);
      if (task.kind === "semantic" && task.stage === "trigger") {
        triggerPaths.push(context.workspacePath);
        expect(context.workspacePath.startsWith(artifactRoot)).toBe(false);
        expect(context.workspacePath).toBe(process.cwd());
        if (matches === "failed") throw new Error("trigger worker failed");
        return {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              task.requests.map((r) => [r.briefId, matches]),
            ),
          },
        };
      }
      actionPath = context.workspacePath;
      return { outcome: "completed" };
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { responder: worker },
    });
    try {
      const pending = collectAsync(
        workerHub.submitInbound({
          content: "am I ready",
          metadata: { principal: ALICE_OWNER },
        }),
      );
      let events: InboundLifecycleEvent[] = [];
      if (matches === "failed") {
        await expect(pending).resolves.toEqual([
          {
            kind: "failed",
            routineId: expect.any(String),
            arcRunId: expect.any(String),
            reason: "trigger worker failed",
          },
        ]);
      } else {
        events = await pending;
      }
      expect(triggerPaths).toHaveLength(matches === true ? 2 : 1);
      expect(new Set(triggerPaths).size).toBe(1);
      expect((await stat(triggerPaths[0]!)).isDirectory()).toBe(true);
      if (matches === true) {
        await waitFor(() => actionPath !== undefined);
        const [view] = await arcHost.listRunViews();
        expect(view).toBeDefined();
        expect(view?.stage).toBe("actioning");
        if (view?.stage !== "actioning")
          throw new Error("Expected execution view");
        expect(actionPath).toBe(view.workspacePath);
        expect(actionPath).not.toBe(triggerPaths[0]);
        await expect(readdir(artifactRoot)).resolves.toEqual([
          view!.arcRunId.replaceAll(":", "-"),
        ]);
      } else {
        expect(events.some((event) => event.kind === "activated")).toBe(false);
        await expect(readdir(artifactRoot)).resolves.toEqual([]);
      }
    } finally {
      await workerHub.stop();
    }
  });

  it.each([
    ["supplies the process cwd again on trigger capacity resume", true],
    [
      "preserves the process cwd when the hub stops with a parked trigger",
      false,
    ],
  ] as const)("%s", async (_name, resume) => {
    const arcHost = makeArcHost();
    await arcHost.registerArc(
      "ready",
      parse(`
"arc";
function Ready() {
  this.hostParams = { workerRole: "responder" };
  this.trigger = () => judge(\`ready\`);
}
`),
    );
    let workspacePath: string | undefined;
    let triggerCalls = 0;
    const scheduled: Array<() => void> = [];
    const { workerHub } = makeWorkerHub({
      arcHost,
      capacityRetry: {
        schedule: (callback) => {
          scheduled.push(callback);
          return () => {};
        },
      },
      workers: {
        responder: async (task, context) => {
          if (task.kind !== "semantic")
            throw new Error("expected trigger task");
          triggerCalls += 1;
          if (triggerCalls === 1) {
            workspacePath = context.workspacePath;
            expect(workspacePath).toBe(process.cwd());
            return {
              suspension: "capacity-limited",
              reason: {
                reason: "api rate limit",
                provider: "test",
                message: "retry",
              },
            };
          }
          expect(context.workspacePath).toBe(workspacePath);
          expect((await stat(context.workspacePath)).isDirectory()).toBe(true);
          return {
            outcome: "completed",
            semantic: {
              judgments: Object.fromEntries(
                task.requests.map((r) => [r.briefId, false]),
              ),
            },
          };
        },
      },
    });
    const completion = collectAsync(
      workerHub.submitInbound({
        content: "ready",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    try {
      await waitFor(() => scheduled.length === 1);
      expect(workspacePath).toBeDefined();
      await expect(stat(workspacePath!)).resolves.toBeDefined();
      if (resume) {
        scheduled[0]!();
        await completion;
        expect(triggerCalls).toBe(2);
        expect((await stat(workspacePath!)).isDirectory()).toBe(true);
      }
    } finally {
      await workerHub.stop();
    }
    expect((await stat(workspacePath!)).isDirectory()).toBe(true);
  });

  it("serializes routines sharing one worker run and context", async () => {
    const { arcHost, task } = await firstTaskWithArcHost();
    const briefId = task.briefIds[0];
    const secondTask = {
      ...task,
      briefIds: [`${briefId}:second`] as const,
    };
    const order: string[] = [];
    const worker: RoleWorker = async (current) => {
      if (current.kind !== "instruction")
        throw new Error("expected instruction task");
      order.push(`start:${current.briefIds.join("+")}`);
      await Promise.resolve();
      order.push(`end:${current.briefIds.join("+")}`);
      return { outcome: "completed" };
    };
    const { workerHub } = makeWorkerHub({
      arcHost,

      workers: { researcher: worker },
    });

    await Promise.all([
      workerHub.handleTask(task, routineContext()),
      workerHub.handleTask(secondTask, routineContext()),
    ]);

    expect(order).toEqual([
      `start:${briefId}`,
      `end:${briefId}`,
      `start:${secondTask.briefIds[0]}`,
      `end:${secondTask.briefIds[0]}`,
    ]);
  });

  it("dispatches a multi-instruction task and commits every brief id", async () => {
    const arcHost = await makeArcHostWithSource(
      "brief-batch",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "greeter",
  };
  $instruct(\`Collect the outline.\`);
  $instruct(\`Draft the reply.\`);
}
`,
    );
    const realBegin = arcHost.begin.bind(arcHost);
    const advanceInputs: unknown[] = [];
    let syntheticFrontier: RunFrontier | undefined;
    vi.spyOn(arcHost, "begin").mockImplementation(async (input) => {
      const steps = await realBegin(input);
      return steps.map((step) => {
        if (step.kind !== "action") return step;
        const instruction = step.frontier.tasks.find(
          (task) => task.kind === "instruction",
        );
        if (instruction?.kind !== "instruction") return step;
        const batched = {
          ...instruction,
          briefIds: [
            instruction.briefIds[0],
            `${instruction.briefIds[0]}:synthetic-second`,
          ],
          texts: ["Collect the outline.", "Draft the reply."],
        } satisfies InstructionTask;
        syntheticFrontier = {
          ...step.frontier,
          tasks: [batched],
        };
        return { ...step, frontier: syntheticFrontier };
      });
    });
    vi.spyOn(arcHost, "advanceAction").mockImplementation(
      async (arcRunId, _frontierId, input) => {
        if (!syntheticFrontier) throw new Error("missing synthetic frontier");
        const { projectDialog: _projectDialog, ...report } = input;
        advanceInputs.push(report);
        return {
          kind: "action",
          arcRunId,
          frontier: {
            ...syntheticFrontier,
            outcome: "completed",
            canProgress: false,
            allowedMoves: [],
            tasks: [],
            briefs: {
              judgments: [],
              observations: [],
              hostCalls: [],
              instructions: [],
            },
          },
        };
      },
    );
    const worker = vi.fn<RoleWorker>(async () => ({
      outcome: "completed",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { greeter: worker },
    });

    await submitActivation(workerHub, "hi");

    await waitFor(() => worker.mock.calls.length === 1);
    const task = worker.mock.calls[0]![0];
    if (task.kind !== "instruction") {
      throw new Error("expected instruction task");
    }
    const briefIds = [...task.briefIds];
    expect(briefIds).toHaveLength(2);
    expect(task.texts).toEqual(["Collect the outline.", "Draft the reply."]);

    await waitFor(() => advanceInputs.length === 1);
    expect(advanceInputs[0]).toEqual({
      reports: [],
      instructionCoverage: Object.fromEntries(
        briefIds.map((briefId) => [briefId, "applied"]),
      ),
      intent: "agent-work",
    });
  });

  it("commits handler results as instruction coverage", async () => {
    const arcHost = await makeArcHostWithSource("greet", GREET_SOURCE);
    const advanceInputs = recordAdvanceInputs(arcHost);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        greeter: async () => ({ outcome: "completed" }),
      },
    });

    await submitActivation(workerHub, "hi");

    await waitFor(() => advanceInputs.length === 1);
    expect(advanceInputs[0]).toEqual({
      reports: [],
      instructionCoverage: {
        "instruction:[arc:greet:Greet]:[node:greet:Greet]:body/0": "applied",
      },
      intent: "agent-work",
    });
  });

  it("dispatches a repeated instruction id from a later frontier", async () => {
    const arcHost = await makeArcHostWithSource(
      "forgetful-entry",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  $enter(Child);
  $enter(forgetful(Child));

  function Child() {
    this.hostParams = {
      workerRole: "greeter",
    };
    $instruct(\`Handle child work.\`);
  }
}
`,
    );
    const advanceInputs = recordAdvanceInputs(arcHost);
    const worker = vi.fn<RoleWorker>(async () => ({
      outcome: "completed",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { greeter: worker },
    });

    await submitActivation(workerHub, "hi");

    await waitFor(() => worker.mock.calls.length === 2);
    await waitFor(() => advanceInputs.length === 2);
    expect(taskId(worker.mock.calls[0]![0])).toBe(
      taskId(worker.mock.calls[1]![0]),
    );
    expect(advanceInputs).toEqual([
      expect.objectContaining({
        instructionCoverage: {
          [taskId(worker.mock.calls[0]![0])]: "applied",
        },
      }),
      expect.objectContaining({
        instructionCoverage: {
          [taskId(worker.mock.calls[1]![0])]: "applied",
        },
      }),
    ]);
  });
});
