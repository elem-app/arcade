import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestArcHost,
  executionControlFor,
} from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import { toNodeRef } from "@elem-app/arc/runtime";
import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  InMemoryArcHostStore,
  JsonFileArcHostStore,
  taskId,
  taskSourceRef,
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
  type RoutineReport,
  type RunFrontier,
  type Task,
} from "../src/testing.js";
import { observeSnapshotReads } from "./arc-host-helpers.js";
import { callOpenAiTool } from "./backend-helpers.js";
import { makeControlledTime } from "./controlled-time.js";
import {
  ALICE_OWNER,
  collectAsync,
  GREET_SOURCE,
  makeArcHost,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import {
  callClaudeSdkTool,
  claudeSemanticMessages,
  claudeStreamingQuery,
  exampleSemanticReport,
  recordAdvanceInputs,
  semanticRequestIds,
  settleFirstRoutine,
  submitActivation,
} from "./worker-hub-helpers.js";

describe("Worker hub dispatch and worker-slot routing", () => {
  it.each(["action", "fresh trigger"] as const)(
    "measures snapshot reads across repeated %s dispatch",
    async (stage) => {
      const store = new InMemoryArcHostStore();
      const arcHost = await createTestArcHost({ store });
      await arcHost.registerArc(
        "read-counts",
        parse(`"arc";
function Main() {
  this.description = "Pinned label";
  this.trigger = () => ${stage === "action" ? "true" : 'judge("First?") && judge("Second?")'};
  $instruct("First work");
  $instruct("Second work");
}`),
      );
      const reads = observeSnapshotReads(store);
      const windows: ReturnType<typeof reads.counts>[] = [];
      const workspace = arcHost.getRunWorkspaceContext.bind(arcHost);
      vi.spyOn(arcHost, "getRunWorkspaceContext").mockImplementation(
        async (id) => {
          const before = reads.counts();
          const value = await workspace(id);
          const after = reads.counts();
          windows.push({
            state: after.state - before.state,
            snapshot: after.snapshot - before.snapshot,
            record: after.record - before.record,
          });
          return value;
        },
      );
      const node = arcHost.nodeInfoForRef.bind(arcHost);
      vi.spyOn(arcHost, "nodeInfoForRef").mockImplementation(
        async (ref, id) => {
          const before = reads.counts();
          const value = await node(ref, id);
          const after = reads.counts();
          windows.push({
            state: after.state - before.state,
            snapshot: after.snapshot - before.snapshot,
            record: after.record - before.record,
          });
          return value;
        },
      );
      const worker = vi.fn<RoleWorker>(async (task) =>
        task.kind === "semantic" ? answerAll(task) : { outcome: "completed" },
      );
      const { workerHub } = makeWorkerHub({
        arcHost,
        workers: { [DEFAULT_WORKER_ROLE]: worker },
      });
      try {
        const arcRunId = await submitActivation(workerHub, "start");
        await waitFor(async () =>
          (await workerHub.listWorkEvents(arcRunId)).some(
            (event) => event.kind === "run:completed",
          ),
        );
        const expectedTasks = stage === "action" ? 2 : 4;
        expect(worker).toHaveBeenCalledTimes(expectedTasks);
        expect(windows).toEqual(
          stage === "action"
            ? Array.from({ length: 4 }, () => ({
                state: 0,
                snapshot: 0,
                record: 0,
              }))
            : [
                { state: 0, snapshot: 1, record: 1 },
                { state: 0, snapshot: 0, record: 0 },
                { state: 0, snapshot: 1, record: 1 },
                { state: 0, snapshot: 0, record: 0 },
                ...Array.from({ length: 4 }, () => ({
                  state: 0,
                  snapshot: 0,
                  record: 0,
                })),
              ],
        );
        expect(new Set(reads.snapshot.mock.calls.map(([id]) => id)).size).toBe(
          stage === "action" ? 1 : 3,
        );
        expect(
          (await workerHub.listWorkEvents(arcRunId)).filter(
            (event) => event.kind === "routine:started",
          ),
        ).toEqual([
          expect.objectContaining({
            nodeName: "Main",
            nodeDescription: "Pinned label",
          }),
          expect.objectContaining({
            nodeName: "Main",
            nodeDescription: "Pinned label",
          }),
        ]);
      } finally {
        await workerHub.stop();
        await arcHost.stop();
      }
    },
  );

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

  it("rejects duplicate role workers", async () => {
    const arcHost = await makeArcHost();
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
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-pool" };
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "openai-sdk" },
      openAiSdk: {
        apiKey: "sk-test",
        run,
      },
    });

    const { routine } = await settleFirstRoutine(workerHub, routineStore);
    expect(routine).toMatchObject({ status: "finished" });
    expect(routine.error).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("resolves pinned action node metadata once per routine after source replacement", async () => {
    const arcHost = await makeArcHostWithSource(
      "watch",
      `"arc";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  $instruct(\`Watch for updates.\`);
  $instruct(\`Report the updates.\`);
}`,
    );
    const nodeInfoForRef = vi.spyOn(arcHost, "nodeInfoForRef");
    // The first routine replaces the source; the second resolves its node from
    // the run's pinned snapshot.
    const worker = vi.fn<RoleWorker>(async (task, _context, effects) => {
      if (worker.mock.calls.length === 1) {
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
        await expect(
          arcHost.nodeInfoForRef(taskSourceRef(task)),
        ).rejects.toThrow(
          `No registered Arc node for source ref ${taskSourceRef(task)}.`,
        );
        return { outcome: "completed" };
      }
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

    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(async () =>
      (await workerHub.listWorkEvents(arcRunId)).some(
        (event) => event.kind === "run:completed",
      ),
    );
    expect(worker).toHaveBeenCalledTimes(2);
    expect(
      nodeInfoForRef.mock.calls.filter(([, runId]) => runId === arcRunId),
    ).toHaveLength(2);
    expect(
      (await workerHub.listWorkEvents(arcRunId)).filter(
        (event) => event.kind === "routine:started",
      ),
    ).toEqual([
      expect.objectContaining({ nodeName: "Watch" }),
      expect.objectContaining({ nodeName: "Watch" }),
    ]);
  });

  it("resolves trigger task node metadata from its captured snapshot", async () => {
    const arcHost = await makeArcHostWithSource("watch", TRIGGER_JUDGE_SOURCE);
    await arcHost.registerArc(
      "watch",
      parse(`
"arc";

function Watch() {
  this.description = "Replacement trigger node.";
  this.trigger = () => judge(\`should this start?\`);
}
`),
      { workspaceScope: "run", bundle: {}, contextIsolation: "role" },
      { replace: true },
    );
    const begin = arcHost.begin.bind(arcHost);
    vi.spyOn(arcHost, "begin").mockImplementation(async (input) => {
      const steps = await begin(input);
      await arcHost.registerArc(
        "watch",
        parse(
          '"arc"; function Watch() { this.description = "Later trigger metadata."; this.trigger = () => true; }',
        ),
        undefined,
        { replace: true },
      );
      return steps;
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: {
        [DEFAULT_WORKER_ROLE]: async (task) => answerAll(task),
      },
    });

    await submitActivation(workerHub, "start");
    const [routine] = await collectAsync(routineStore.listRoutines());
    expect(routine?.task).toMatchObject({ kind: "semantic", stage: "trigger" });
    await expect(workerHub.listWorkEvents(routine!.arcRunId)).resolves.toEqual(
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
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const routineStore = executionControlFor(arcHost);
    const getRunWorkspaceContext = arcHost.getRunWorkspaceContext.bind(arcHost);
    let restored = false;
    // A routine from earlier work in the same context, recorded before the
    // first dispatch reads the run context.
    vi.spyOn(arcHost, "getRunWorkspaceContext").mockImplementation(
      async (arcRunId) => {
        const runContext = await getRunWorkspaceContext(arcRunId);
        if (!restored) {
          restored = true;
          const persistedTask = persistedInstruction(arcRunId);
          await routineStore.putRoutine({
            id: "routine:persisted-openai-context",
            role: persistedTask.role,
            backend: "openai-sdk",
            arcRunId,
            status: "finished",
            task: persistedTask,
            updatedAt: "2026-07-30T00:00:00.000Z",
            backendDetails: {
              backend: "openai-sdk",
              sessionKey: workerContextKey(persistedTask, 0),
              responseId: "response-persisted-context",
              cwd: runContext.workspacePath,
              model: "gpt-5.5",
            },
          });
        }
        return runContext;
      },
    );
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

    await submitActivation(workerHub, "start watching");
    await waitFor(() => run.mock.calls.length === 1);
    expect(run.mock.calls[0]![0].previousResponseId).toBeUndefined();
  });

  it("keeps general-backend trigger continuity separate from action continuity", async () => {
    const arcHost = await makeArcHostWithSource(
      "watch",
      `"arc";
function Watch() {
  this.trigger = () => judge(\`should this start?\`);
  this.hostParams = { workerRole: "researcher" };
}`,
    );
    const routineStore = executionControlFor(arcHost);
    const getRunWorkspaceContext = arcHost.getRunWorkspaceContext.bind(arcHost);
    let actionTask: InstructionTask | undefined;
    // An action routine in the same run's role context, recorded before the
    // trigger dispatch reads its context.
    vi.spyOn(arcHost, "getRunWorkspaceContext").mockImplementation(
      async (arcRunId) => {
        const runContext = await getRunWorkspaceContext(arcRunId);
        if (!actionTask) {
          actionTask = persistedInstruction(arcRunId);
          await routineStore.putRoutine({
            id: "routine:persisted-action-context",
            role: actionTask.role,
            backend: "claude-sdk",
            arcRunId,
            status: "finished",
            task: actionTask,
            updatedAt: "2026-07-30T00:00:00.000Z",
            backendDetails: {
              backend: "claude-sdk",
              sessionKey: workerContextKey(actionTask, 0),
              sessionId: "session-action-context",
              cwd: runContext.workspacePath,
              model: "claude-opus-4-7",
            },
          });
        }
        return runContext;
      },
    );
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      claudeSemanticQuery(params),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: { query, sessionCache: { maxPreparedStarts: 0 } },
    });

    await submitActivation(workerHub, "start");

    expect(query.mock.calls[0]![0].options?.resume).toBeUndefined();
    const trigger = (await collectAsync(routineStore.listRoutines())).find(
      (routine) => routine.task.kind === "semantic",
    );
    expect(workerContextKey(trigger!.task, 0)).not.toBe(
      workerContextKey(actionTask!, 0),
    );
    expect(trigger?.backendDetails).toMatchObject({
      backend: "claude-sdk",
      sessionKey: workerContextKey(trigger!.task, 0),
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
    const arcHost = await makeArcHost();
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
    const arcHost = await makeArcHostWithSource("test", TRIGGER_JUDGE_SOURCE);
    const run = vi.fn<OpenAiSdkTstRunFn>(async ({ prompt }) => ({
      finalOutput: JSON.stringify({
        outcome: "completed",
        semantic: {
          judgments: Object.fromEntries(
            semanticRequestIds(prompt).map((id) => [id, true]),
          ),
        },
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

    await submitActivation(workerHub, "start");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("persists a failed routine for unknown instruction roles", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const routineStore = executionControlFor(arcHost);
    const { workerHub } = makeWorkerHub({ arcHost, routineStore });

    const { arcRunId } = await settleFirstRoutine(workerHub, routineStore);

    expect(await collectAsync(routineStore.listRoutines(arcRunId))).toEqual([
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
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "in-process" } },
    });

    const { routine } = await settleFirstRoutine(workerHub, routineStore);
    expect(routine).toMatchObject({
      status: "finished",
      error: {
        code: "unknown-role",
        message:
          'No in-process handler registered for configured role "researcher".',
      },
    });
  });

  it("routes default-worker semantic work through the default worker slot", async () => {
    const arcHost = await makeArcHostWithSource("test", TRIGGER_JUDGE_SOURCE);
    const runner = vi.fn(async (task: Task) => answerAll(task));
    const { workerHub } = makeWorkerHub({
      arcHost,
      runner,
      workerSlots: { default: "pi-agent" },
    });

    await submitActivation(workerHub, "start");
    expect(runner).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "semantic",
        stage: "trigger",
        role: DEFAULT_WORKER_ROLE,
      }),
    );
  });

  it("logs PI-agent backend lifecycle events", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const logger = {
      level: "info" as const,
      format: "json" as const,
      info: vi.fn(),
      debug: vi.fn(),
    };
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      runner: async () => ({ outcome: "completed" }),
      workerSlots: { default: "pi-agent" },
      logger,
    });

    const { arcRunId, routine } = await settleFirstRoutine(
      workerHub,
      routineStore,
    );

    expect(logger.info).toHaveBeenCalledWith(
      "backend.pi_agent.started",
      expect.objectContaining({
        arcRunId,
        routineId: expect.stringMatching(/^routine:/),
        role: routine.role,
        kind: routine.task.kind,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "backend.pi_agent.finished",
      expect.objectContaining({
        arcRunId,
        routineId: expect.stringMatching(/^routine:/),
        role: routine.role,
        reportKind: "completed",
      }),
    );
  });

  it("fails default-worker work when no default worker slot is configured", async () => {
    const arcHost = await makeArcHostWithSource("test", TRIGGER_JUDGE_SOURCE);
    const { workerHub, routineStore } = makeWorkerHub({ arcHost });

    const events = await collectAsync(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "failed",
        reason: `No configured worker is available for role "${DEFAULT_WORKER_ROLE}".`,
      }),
    ]);
    expect(await collectAsync(routineStore.listRoutines())).toEqual([
      expect.objectContaining({
        role: DEFAULT_WORKER_ROLE,
        status: "finished",
        error: expect.objectContaining({ code: "role-not-delegated" }),
      }),
    ]);
  });

  it("routes trigger semantic work through the fast-trigger slot", async () => {
    const arcHost = await makeArcHostWithSource("test", TRIGGER_JUDGE_SOURCE);
    const piRunner = vi.fn(async (task: Task) => answerAll(task));
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

    await submitActivation(workerHub, "start");
    expect(piRunner).toHaveBeenCalledTimes(1);
    expect(openAiRun).not.toHaveBeenCalled();
  });

  it("routes action semantic work through the default slot when fast trigger is configured", async () => {
    const arcHost = await makeArcHostWithSource(
      "observed",
      `"arc";
function Watch() {
  this.trigger = () => true;
  let ready = Bool({ observing: "ready?" });
  $observe(ready);
}`,
    );
    const piRunner = vi.fn(async () => ({ outcome: "completed" as const }));
    const openAiRun = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(
        input.agent,
        "report",
        exampleSemanticReport(input.prompt ?? ""),
      );
      return {};
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      runner: piRunner,
      workerSlots: { default: "openai-sdk" },
      fastTriggerBackend: "pi-agent",
      openAiSdk: { apiKey: "sk-test", run: openAiRun },
    });

    const { routine } = await settleFirstRoutine(workerHub, routineStore);
    expect(routine).toMatchObject({ status: "finished" });
    expect(routine.error).toBeUndefined();
    expect(openAiRun).toHaveBeenCalledTimes(1);
    expect(piRunner).not.toHaveBeenCalled();
  });

  it("keeps instruction work on its configured role slot", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const piRunner = vi.fn(async () => ({ outcome: "completed" as const }));
    const openAiRun = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return {};
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      runner: piRunner,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      fastTriggerBackend: "pi-agent",
      openAiSdk: { apiKey: "sk-test", run: openAiRun },
    });

    await settleFirstRoutine(workerHub, routineStore);

    expect(openAiRun).toHaveBeenCalledTimes(1);
    expect(piRunner).not.toHaveBeenCalled();
  });

  it("lets an explicit role slot override the default semantic backend", async () => {
    const arcHost = await makeArcHostWithSource("test", TRIGGER_JUDGE_SOURCE);
    const worker = vi.fn(async (task: Task) => answerAll(task, false));
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { [DEFAULT_WORKER_ROLE]: "in-process" } },
      workers: { [DEFAULT_WORKER_ROLE]: worker },
    });

    await collectAsync(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    expect(worker).toHaveBeenCalledOnce();
  });

  it("materializes task workspace paths before dispatch", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const root = await mkdtemp(
      join(tmpdir(), "arcade-worker-hub-materialize-"),
    );
    const workspacePath = join(root, "missing", "workspace");
    // The run names a workspace that does not exist yet.
    const getRunWorkspaceContext = arcHost.getRunWorkspaceContext.bind(arcHost);
    vi.spyOn(arcHost, "getRunWorkspaceContext").mockImplementation(
      async (arcRunId) => ({
        ...(await getRunWorkspaceContext(arcRunId)),
        workspacePath,
      }),
    );
    const worker = vi.fn(async (_task, context: RoutineContext) => {
      expect(context.workspacePath).toBe(workspacePath);
      expect((await stat(context.workspacePath)).isDirectory()).toBe(true);
      return { outcome: "completed" as const };
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });

    const { routine } = await settleFirstRoutine(workerHub, routineStore);

    expect(routine).toMatchObject({ status: "finished" });
    expect(routine.error).toBeUndefined();
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
    const artifactRoot = await mkdtemp(join(tmpdir(), "arcade-trigger-root-"));
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      artifactRoot,
    });
    await arcHost.registerArc(
      "watch",
      parse(`"arc";
function Watch() {
  this.trigger = () => judge(\`should this start?\`);
  this.hostParams = { workerRole: "researcher" };
}`),
    );
    const root = await mkdtemp(join(tmpdir(), "arcade-standard-trigger-"));
    let observedCwd: string | undefined;
    let suppliedWorkspace: string | undefined;
    const routineOptions = ({ context }: { context: RoutineContext }) => {
      suppliedWorkspace = context.workspacePath;
      return undefined;
    };
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: backend } },
      claudeSdk: {
        sessionCache: { maxPreparedStarts: 0 },
        cwd: override ? root : undefined,
        routineOptions,
        query: (params) => {
          observedCwd = params.options?.cwd;
          return claudeSemanticQuery(params);
        },
      },
      openAiSdk: {
        cwd: override ? root : undefined,
        routineOptions,
        apiKey: "sk-test",
        run: async (input) => {
          await callOpenAiTool(
            input.agent,
            "report",
            exampleSemanticReport(input.prompt ?? ""),
          );
          return { lastResponseId: "temporary-workspace-response" };
        },
        onResponseObserved: async ({ cwd }) => {
          observedCwd = cwd;
        },
      },
    });
    try {
      await submitActivation(workerHub, "start");
      const [routine] = await collectAsync(routineStore.listRoutines());
      expect(routine).toMatchObject({
        status: "finished",
        task: { kind: "semantic", stage: "trigger" },
      });
      expect(routine?.error).toBeUndefined();
      expect(observedCwd).toBeDefined();
      expect(suppliedWorkspace).toBeDefined();
      expect(suppliedWorkspace).toBe(process.cwd());
      expect(observedCwd).toBe(override ? root : suppliedWorkspace);
      expect((await stat(suppliedWorkspace!)).isDirectory()).toBe(true);
      expect((await stat(observedCwd!)).isDirectory()).toBe(true);
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
    const arcHost = await createTestArcHost({
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
    const arcHost = await makeArcHost();
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
    const time = makeControlledTime();
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      ...time,
    });
    // A caught timeout reissues the work into the context the superseded
    // routine still holds.
    await arcHost.registerArc(
      "watch",
      parse(`"arc";
import Time from "host:time";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  this.catchInterruption = () => true;
  Time.$addTimeout(25);
  $instruct(\`Watch for updates.\`);
}`),
    );
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let invocation = 0;
    const worker: RoleWorker = async (current) => {
      if (current.kind !== "instruction")
        throw new Error("expected instruction task");
      const label = ++invocation === 1 ? "first" : "second";
      order.push(`start:${label}`);
      if (label === "first") await firstGate;
      order.push(`end:${label}`);
      return { outcome: "completed" };
    };
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });

    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(() => order.length === 1);
    time.advanceTo(1025);
    time.fireDue();
    await waitFor(
      async () =>
        (await collectAsync(routineStore.listRoutines(arcRunId))).length === 2,
    );
    expect(order).toEqual(["start:first"]);
    releaseFirst();
    await waitFor(() => order.length === 4);

    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
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
          reactivationCount: 0,
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

/** A judged trigger on the default worker role, with no action work. */
const TRIGGER_JUDGE_SOURCE = `"arc";
function Watch() {
  this.trigger = () => judge(\`should this start?\`);
}`;

/** Answer every semantic request of a task with one value. */
function answerAll(task: Task, value = true): RoutineReport {
  if (task.kind !== "semantic") return { outcome: "completed" };
  return {
    outcome: "completed",
    semantic: {
      judgments: Object.fromEntries(
        task.requests
          .filter((request) => request.kind === "judgment")
          .map((request) => [request.briefId, value]),
      ),
      observations: Object.fromEntries(
        task.requests
          .filter((request) => request.kind === "observation")
          .map((request) => [request.briefId, { status: "resolved", value }]),
      ),
    },
  };
}

/** The Watch instruction an earlier routine of the run carried out. */
function persistedInstruction(arcRunId: string): InstructionTask {
  return {
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
}

/**
 * A streaming Claude query that answers each prompt with its semantic report
 * example, or completes instruction work.
 */
function claudeSemanticQuery(
  params: Parameters<ClaudeSdkQueryFn>[0],
): ReturnType<ClaudeSdkQueryFn> {
  const generator = (async function* () {
    const input = params.prompt as AsyncIterable<{
      message?: { content?: unknown };
    }>;
    for await (const message of input) {
      const prompt = String(message.message?.content ?? "");
      await callClaudeSdkTool(
        params,
        "report",
        prompt.includes('{"outcome":"completed","semantic":')
          ? (exampleSemanticReport(prompt) as Record<string, unknown>)
          : { outcome: "completed" },
      );
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "ok",
        session_id: "session-worker-hub-prepared",
      } as unknown;
    }
  })() as AsyncGenerator<unknown, void> & {
    setModel: (model?: string) => Promise<void>;
    close: () => void;
  };
  generator.setModel = async () => undefined;
  generator.close = () => undefined;
  return generator as ReturnType<ClaudeSdkQueryFn>;
}

it.each(["live", "reconstructed"] as const)(
  "dispatches retained semantic reentry after source deletion with %s state",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-deleted-reentry-"));
    const store = new JsonFileArcHostStore({ dir });
    let host = await createTestArcHost({ store });
    await host.registerArcs([
      {
        source: "retained",
        document: parse(
          '"arc"; import { Wait } from "imported"; function Main() { this.description = "Retained trigger description."; this.trigger = () => judge("Start?"); $enter(Wait); }',
        ),
        manifest: {
          workspaceScope: "run",
          contextIsolation: "role",
          bundle: { "guide/": "/tmp/retained-bundle" },
        },
      },
      {
        source: "imported",
        document: parse(
          '"arc"; function Wait() { this.guard = () => State.DEFLECTED; }',
        ),
        manifest: {
          workspaceScope: "run",
          contextIsolation: "role",
          bundle: { "guide/": "/tmp/imported-bundle" },
        },
      },
    ]);
    const dialog = {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user" as const, message: "start" }],
    };
    const projectDialog = async () => dialog;
    const [probe] = await host.begin({
      dialog,
      inbound: { content: "start" },
      principal: ALICE_OWNER,
      projectDialog,
    });
    if (probe?.kind !== "trigger") throw new Error("Expected semantic trigger");
    await expect(
      host.nodeInfoForRef(toNodeRef("retained", ["Absent"]), probe.arcRunId),
    ).rejects.toThrow("has no node");
    const [initial] = await host.advanceTrigger(probe.arcRunId, dialog, {
      projectDialog,
      instructionCoverage: {},
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: { [probe.frontier.briefs.judgments[0]!.id]: true },
          },
        },
      ],
    });
    if (initial?.kind !== "action") throw new Error("Expected deflected run");
    expect(await host.getRunView(initial.arcRunId)).toMatchObject({
      stage: "actioning",
      reactivationCount: 0,
      lifecycle: "deflected",
    });
    await host.registerArcs([
      { source: "retained", delete: true },
      { source: "imported", delete: true },
    ]);
    if (mode === "reconstructed") {
      await host.stop();
      host = await createTestArcHost({
        store: new JsonFileArcHostStore({ dir }),
      });
    }
    await expect(
      host.nodeInfoForRef(toNodeRef("retained", ["Main"])),
    ).rejects.toThrow();
    await expect(
      host.nodeInfoForRef(toNodeRef("retained", ["Main"]), "unknown-probe"),
    ).rejects.toThrow("Unknown Arc run");
    const worker = vi.fn<RoleWorker>(async (task) => {
      expect(
        (await host.getRunWorkspaceContext(task.arcRunId)).workspaceBundle,
      ).toEqual({ "guide/": "/tmp/retained-bundle" });
      return answerAll(task);
    });
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost: host,
      workers: { [DEFAULT_WORKER_ROLE]: worker },
    });
    try {
      const iterator = workerHub
        .submitInbound({
          content: "again",
          metadata: { principal: ALICE_OWNER },
        })
        [Symbol.asyncIterator]();
      const pending = await iterator.next();
      if (pending.done || pending.value.kind !== "handshake-required")
        throw new Error("Expected retained run choice");
      await expect(
        workerHub.handshake(pending.value.handshakeId, {
          runChoice: { action: "join", arcRunId: initial.arcRunId },
        }),
      ).resolves.toEqual({ status: "ok" });
      expect((await iterator.next()).value).toEqual({
        kind: "activated",
        reactivationCount: 1,
        arcRunId: initial.arcRunId,
      });
      expect((await iterator.next()).done).toBe(true);
      expect(worker).toHaveBeenCalledTimes(1);
      const routines = await collectAsync(routineStore.listRoutines());
      const trigger = routines.find(
        (routine) =>
          routine.task.kind === "semantic" && routine.task.stage === "trigger",
      )!;
      expect(await workerHub.listWorkEvents(trigger.arcRunId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "routine:started",
            nodeName: "Main",
            nodeDescription: "Retained trigger description.",
          }),
        ]),
      );
      expect(
        (await host.getRunWorkspaceContext(initial.arcRunId)).workspaceBundle,
      ).toEqual({ "guide/": "/tmp/retained-bundle" });
    } finally {
      await workerHub.stop();
    }
  },
);
