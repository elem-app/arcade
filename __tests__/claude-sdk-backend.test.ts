import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import {
  createClaudeSdkBackend,
  createClaudeSdkBackendForTesting,
} from "../src/backends/claude-sdk-backend.js";
import type { JsonValue, RoutineInput, WorkerHost } from "../src/index.js";
import {
  ClaudeSdkWorker,
  noopRoutineEffects,
  workerContextKey,
  type ClaudeSdkQueryFn,
  type ClaudeSdkStartupFn,
  type InstructionTask,
  type OutboundMessage,
  type RoutineContext,
  type RoutineReport,
  type Task,
} from "../src/testing.js";
import {
  callSdkReport,
  noopDiagnostics,
  outbound,
  routine,
  runBackend,
} from "./backend-helpers.js";
import {
  ARC_RUN_ID,
  collectAsync,
  createCapturingLogger,
  deferred,
  firstTask,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import {
  drainLifecycle,
  settleFirstRoutine,
  submitActivation,
} from "./worker-hub-helpers.js";

const execFileAsync = promisify(execFile);

describe("ClaudeSdkWorker", () => {
  it("times out only the captured Claude query while another context completes", async () => {
    const task = await firstTask();
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const closed = [vi.fn(), vi.fn()];
    let queries = 0;
    const query = ((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      const index = queries++;
      const signal = params.options!.abortController!.signal;
      const messages = (async function* () {
        for await (const _ of params.prompt as AsyncIterable<unknown>) {
          entered[index]!.resolve();
          await Promise.race([
            release[index]!.promise,
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("query aborted")),
                { once: true },
              );
            }),
          ]);
          await callSdkReport(params, { outcome: "completed" });
          yield {
            type: "result",
            subtype: "success",
            session_id: `session:${index}`,
            is_error: false,
          };
        }
      })();
      return Object.assign(messages, {
        close: closed[index],
        setModel: async () => {},
      });
    }) as unknown as ClaudeSdkQueryFn;
    vi.useFakeTimers();
    const worker = new ClaudeSdkWorker({
      query,
      timeoutMs: 1000,
      sessionCache: { maxPreparedStarts: 0 },
    });
    const inputs = [0, 1].map((index) => ({
      routine: routine(
        { ...task, arcRunId: `run:${index}` },
        { id: `routine:${index}`, contextKey: `context:${index}` },
      ),
      context: context(),
      effects: noopRoutineEffects(),
      diagnostics: noopDiagnostics,
    }));
    const pending = [worker.run(inputs[0]!)];
    try {
      await entered[0]!.promise;
      await vi.advanceTimersByTimeAsync(500);
      pending.push(worker.run(inputs[1]!));
      await entered[1]!.promise;
      await vi.advanceTimersByTimeAsync(500);
      await expect(pending[0]).resolves.toMatchObject({
        suspension: "transport-lost",
        reason: { reason: "sdk timeout" },
      });
      expect(closed[0]).toHaveBeenCalledTimes(1);
      expect(closed[1]).not.toHaveBeenCalled();
      release[1]!.resolve();
      await expect(pending[1]).resolves.toMatchObject({ outcome: "completed" });
      await worker.disposeRoutine({
        arcRunId: "run:0",
        routineId: "routine:0",
      });
      expect(closed[1]).not.toHaveBeenCalled();
      await worker.disposeRoutine({
        arcRunId: "run:1",
        routineId: "routine:1",
      });
      expect(closed[1]).toHaveBeenCalledTimes(1);
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.allSettled(pending);
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("disposes completed production Claude queries while preserving the next routine conversation", async () => {
    const arcHost = await makeArcHostWithSource(
      "owned-conversation",
      `"arc";
      function Main() {
        this.trigger = () => true;
        this.hostParams = { workerRole: "researcher" };
        $instruct("First work.");
        $instruct("Second work.");
      }`,
    );
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "claude-sdk" },
      claudeSdk: {
        query,
        sessionCache: { maxPreparedStarts: 0 },
        resolveContinuityIdentity: async () => identity("test"),
      },
    });
    try {
      const run = await submitActivation(workerHub, "start");
      await expect
        .poll(
          async () =>
            (await workerHub.listWorkEvents(run)).filter(
              (event) => event.kind === "routine:finished",
            ).length,
        )
        .toBe(2);
      await expect
        .poll(
          () =>
            states.filter((state) => state.close.mock.calls.length === 1)
              .length,
        )
        .toBe(2);
      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[0]![0].options.resume).toBeUndefined();
      expect(query.mock.calls[1]![0].options.resume).toBe("session-live-0");
      expect(states[0]!.prompts[0]).toContain("First work.");
      expect(states[1]!.prompts[0]).toContain("Second work.");
      expect(states[1]!.prompts).toHaveLength(1);
    } finally {
      await workerHub.stop();
    }
  });

  it("keeps consumed Claude starts alive while unused starts expire or exceed capacity", async () => {
    const task = await firstTask();
    const descriptor = routine(task);
    const entered = deferred();
    const release = deferred<string>();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { query, states } = streamingQueryReturning(
      [{ outcome: "completed" }],
      async (params) => {
        await callSdkDiscuss(params, { question: "Continue?" });
      },
    );
    const unusedClose: ReturnType<typeof vi.fn>[] = [];
    const startup = vi.fn(async (params: Parameters<ClaudeSdkStartupFn>[0]) => {
      const close = vi.fn();
      unusedClose.push(close);
      return {
        query: (prompt: Parameters<ClaudeSdkQueryFn>[0]["prompt"]) =>
          query({ prompt, options: params?.options }),
        close,
      };
    });
    const worker = new ClaudeSdkWorker({
      query,
      startup: startup as unknown as ClaudeSdkStartupFn,
      sessionCache: { maxPreparedStarts: 1, idleTtlMs: 10 },
    });
    const warm = (contextKey: string) =>
      worker.prepareWarmStart({
        arcRunId: task.arcRunId,
        role: task.role,
        contextKey,
        workspacePath: context().workspacePath,
      });
    await warm(descriptor.contextKey);
    const pending = runBackend(
      worker,
      descriptor,
      context(),
      noopRoutineEffects({
        emit: async () => {
          entered.resolve();
          return release.promise;
        },
      }),
      noopDiagnostics,
    );
    try {
      await entered.promise;
      await warm("unused:1");
      await warm("unused:2");
      expect(unusedClose[1]).toHaveBeenCalledTimes(1);
      expect(unusedClose[0]).not.toHaveBeenCalled();
      expect(states[0]!.close).not.toHaveBeenCalled();
      clock.mockReturnValue(2000);
      await warm("unused:3");
      expect(unusedClose[2]).toHaveBeenCalledTimes(1);
      expect(states[0]!.close).not.toHaveBeenCalled();
      release.resolve("yes");
      await expect(pending).resolves.toMatchObject({
        outcome: "completed",
        backendDetails: { preparedStartUsed: true },
      });
      await worker.disposeRoutine({
        arcRunId: descriptor.arcRunId,
        routineId: descriptor.id,
      });
      expect(states[0]!.close).toHaveBeenCalledTimes(1);
      expect(unusedClose[3]).not.toHaveBeenCalled();
    } finally {
      release.resolve("cleanup");
      await pending;
      await worker.stop();
      clock.mockRestore();
    }
    expect(unusedClose[3]).toHaveBeenCalledTimes(1);
  });

  it("falls back to a cold Claude execution after its prepared start rejects", async () => {
    const task = await firstTask();
    const descriptor = routine(task);
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const worker = new ClaudeSdkWorker({
      query,
      startup: async () => {
        throw new Error("preparation failed");
      },
    });
    try {
      await expect(
        worker.prepareWarmStart({
          arcRunId: task.arcRunId,
          role: task.role,
          contextKey: descriptor.contextKey,
          workspacePath: context().workspacePath,
        }),
      ).rejects.toThrow("preparation failed");
      await expect(
        runBackend(
          worker,
          descriptor,
          context(),
          noopRoutineEffects(),
          noopDiagnostics,
        ),
      ).resolves.toMatchObject({
        outcome: "completed",
        backendDetails: { preparedStartUsed: false },
      });
      expect(query).toHaveBeenCalledTimes(1);
      await worker.disposeRoutine({
        arcRunId: task.arcRunId,
        routineId: descriptor.id,
      });
      expect(states[0]!.close).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
    }
  });

  it.each([
    ["keeps eighteen Claude question invocations alive on one worker", 18, 0],
    [
      "keeps a waiting Claude query alive beyond prepared-start expiry",
      2,
      300001,
    ],
  ] as const)("%s", async (_name, count, elapsed) => {
    const task = await firstTask();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const entered = Array.from({ length: count }, () => deferred());
    const answers = Array.from({ length: count }, () => deferred<string>());
    const observed: unknown[] = [];
    const { query, states } = streamingQueryReturning(
      [{ outcome: "completed" }],
      async (params) => {
        observed.push(await callSdkDiscuss(params, { question: "Continue?" }));
      },
    );
    const worker = new ClaudeSdkWorker({
      query,
      timeoutMs: 600000,
      sessionCache: { maxPreparedStarts: 0 },
    });
    const pending: Promise<RoutineReport>[] = [];
    const routines = Array.from({ length: count }, (_, index) =>
      routine(
        { ...task, arcRunId: `claude-concurrent-${index}` },
        {
          id: `routine-concurrent-${index}`,
          contextKey: `context-concurrent-${index}`,
        },
      ),
    );
    try {
      for (const [index, descriptor] of routines.entries()) {
        if (index > 0) clock.mockReturnValue(now + elapsed);
        pending.push(
          runBackend(
            worker,
            descriptor,
            context(),
            noopRoutineEffects({
              emit: async () => {
                entered[index]!.resolve();
                return answers[index]!.promise;
              },
            }),
            noopDiagnostics,
          ),
        );
        await entered[index]!.promise;
      }
      expect(states).toHaveLength(count);
      for (const state of states) expect(state.close).not.toHaveBeenCalled();
      for (let index = count - 1; index >= 0; index--) {
        answers[index]!.resolve(`answer-${index}`);
        await expect(pending[index]).resolves.toMatchObject({
          outcome: "completed",
        });
        await worker.disposeRoutine({
          arcRunId: routines[index]!.arcRunId,
          routineId: routines[index]!.id,
        });
        expect(states[index]!.close).toHaveBeenCalledTimes(1);
        for (const sibling of states.slice(0, index))
          expect(sibling.close).not.toHaveBeenCalled();
      }
      expect(observed).toEqual(
        Array.from({ length: count }, (_, index) => ({
          answer: `answer-${count - index - 1}`,
        })),
      );
      expect(
        query.mock.calls.every(
          ([params]) => params.options?.cwd === context().workspacePath,
        ),
      ).toBe(true);
    } finally {
      answers.forEach((answer, index) => answer.resolve(`answer-${index}`));
      await Promise.allSettled(pending);
      await worker.stop();
      clock.mockRestore();
    }
  });

  it("resumes the recorded Claude session after delivery and connection loss", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text", value: "Notify " },
          { kind: "entity", name: "user" },
          { kind: "text", value: " with the update." },
        ],
      ],
    };
    const prompts: string[] = [];
    const emit = vi.fn(async () => undefined);
    const host = continuityHost();
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      (async function* () {
        const input = params.prompt as AsyncIterable<{
          message: { content: string };
        }>;
        for await (const message of input) {
          prompts.push(message.message.content);
          yield {
            type: "system",
            subtype: "init",
            session_id: "session-interrupted",
            cwd: params.options?.cwd,
          };
          if (prompts.length === 1) {
            await callSdkTool(params, "emit_outbound", {
              audience: "user",
              content: "The update.",
            });
            throw Object.assign(new Error("Connection reset"), {
              code: "ECONNRESET",
            });
          }
          expect(params.options?.resume).toBe("session-interrupted");
          expect(message.message.content).toContain(
            "Continue the interrupted assigned task",
          );
          expect(message.message.content).not.toContain("<instruction>");
          await callSdkReport(params, { outcome: "completed" });
          yield {
            type: "result",
            subtype: "success",
            session_id: "session-interrupted",
            result: "",
            is_error: false,
          };
          return;
        }
      })(),
    );
    const backend = createClaudeSdkBackendForTesting({
      query: query as unknown as ClaudeSdkQueryFn,
      sessionCache: { enabled: false },
      resolveContinuityIdentity: async () => identity("test"),
    });
    const worker = await backend.createWorker(host, {
      backend: "claude-sdk",
      kind: "role",
      role: task.role,
    });
    const input: RoutineInput = {
      routine: routine(task),
      context: context(),
      effects: noopRoutineEffects({ emit }),
      diagnostics: noopDiagnostics,
    };
    try {
      await expect(worker.run(input)).resolves.toMatchObject({
        suspension: "transport-lost",
      });
      await expect(
        host.state.get(task.arcRunId, input.routine.contextKey),
      ).resolves.toMatchObject({ sessionId: "session-interrupted" });
      expect(emit).toHaveBeenCalledTimes(1);
      await expect(worker.run(input)).resolves.toMatchObject({
        outcome: "completed",
      });
      expect(emit).toHaveBeenCalledTimes(1);
      expect(query).toHaveBeenCalledTimes(2);
    } finally {
      await worker.stop?.();
    }
  });

  it("reports missing Claude continuation on retry without replaying the task", async () => {
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      (async function* () {
        await callSdkTool(params, "emit_outbound", {
          audience: "user",
          content: "Update",
        });
        throw Object.assign(new Error("Connection reset"), {
          code: "ECONNRESET",
        });
      })(),
    );
    const worker = new ClaudeSdkWorker({
      query: query as unknown as ClaudeSdkQueryFn,
      sessionCache: { enabled: false },
    });
    const input: RoutineInput = {
      routine: routine(await firstTask()),
      context: context(),
      effects: noopRoutineEffects(),
      diagnostics: noopDiagnostics,
    };
    try {
      await expect(worker.run(input)).resolves.toMatchObject({
        suspension: "transport-lost",
      });
      await expect(worker.run(input)).resolves.toMatchObject({
        error: "failed",
        code: "claude-continuation-unavailable",
      });
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
    }
  });

  it("runs an instruction routine through SDK tools and requires report", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-workspace-basic");
    await mkdir(workspace, { recursive: true });
    const task = await firstTask();
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-basic", { outcome: "completed" }),
    );
    const backend = new ClaudeSdkWorker({
      model: "claude-sonnet-4-6",
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context({ workspacePath: workspace }),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });

    const options = query.mock.calls[0]![0].options!;
    expect(options.cwd).toBe(workspace);
    expect(options.model).toBe("claude-sonnet-4-6");
    expect(options.resume).toBeUndefined();
    expect(options.abortController).toBeDefined();
    expect(options.tools).toEqual({
      type: "preset",
      preset: "claude_code",
    });
    expect(options.thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    });
    expect(options.toolAliases).toBeUndefined();
    expect(options.systemPrompt).toMatchObject({
      type: "preset",
      preset: "claude_code",
      append: expect.stringContaining("discuss"),
    });
    expect((options.systemPrompt as { append: string }).append).toContain(
      "Treat <instruction>, when present, as the complete authority",
    );
    expect((options.systemPrompt as { append: string }).append).toContain(
      "Treat <rules> as the execution contract",
    );
    expect((options.systemPrompt as { append: string }).append).toContain(
      "No audience input is required: use emit_outbound",
    );
    expect((options.systemPrompt as { append: string }).append).toContain(
      "Input must be captured and validated structurally",
    );
    expect((options.systemPrompt as { append: string }).append).toContain(
      "Input is required without structural constraints: use discuss",
    );
    expect((options.systemPrompt as { append: string }).append).toContain(
      "Delivery and input collection are separate obligations",
    );
    expect((options.systemPrompt as { append: string }).append).not.toMatch(
      /\broutine\b/i,
    );
    expect((options.systemPrompt as { append: string }).append).toContain(
      "Audience-input tools return the audience's answer as their tool result",
    );
    expect((options.systemPrompt as { append: string }).append).toContain(
      'call report with outcome "completed"',
    );
    expect((options.systemPrompt as { append: string }).append).not.toContain(
      "deflected",
    );
    expect(options.settingSources).toBeUndefined();
    expect(options.mcpServers?.arcade_internal).toMatchObject({
      type: "sdk",
      name: "arcade_internal",
    });
    const managedTools = (
      options.mcpServers?.arcade_internal as unknown as {
        instance: {
          _registeredTools: Record<string, { description?: string }>;
        };
      }
    ).instance._registeredTools;
    expect(managedTools.emit_outbound?.description).toContain(
      'returns {"ok":true} immediately',
    );
    expect(managedTools.discuss?.description).toContain(
      "optional question adds a discussion prompt",
    );
    expect(managedTools.discuss?.description).toContain(
      'returns {"answer":"..."}',
    );
    expect(managedTools.ask_audience?.description).toContain(
      'returns {"answers":{...}}',
    );
    expect(managedTools.report?.description).toContain("assigned task");
    expect(managedTools.report?.description).not.toContain("deflected");
    expect(
      Object.values(managedTools)
        .map((tool) => tool.description ?? "")
        .join(" "),
    ).not.toMatch(/\broutine\b/i);
  });

  it("routes native AskUserQuestion through Arcade questions", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-question",
        { outcome: "completed" },
        async () => {
          const result = await callNativeAskUserQuestion(params, {
            questions: [
              {
                question: "Which test runner should we use?",
                header: "Test runner",
                options: [
                  {
                    label: "Vitest",
                    description: "Use the repository's existing Vitest setup.",
                  },
                  {
                    label: "Jest",
                    description: "Use Jest for this work.",
                  },
                ],
                multiSelect: false,
              },
              {
                question: "Which scopes?",
                header: "Scopes",
                options: [
                  {
                    label: "Config",
                    description: "Config only.",
                  },
                  {
                    label: "Backend",
                    description: "Backend only.",
                  },
                ],
                multiSelect: true,
              },
            ],
          });
          expect(result).toEqual({
            questions: [
              {
                question: "Which test runner should we use?",
                header: "Test runner",
                options: [
                  {
                    label: "Vitest",
                    description: "Use the repository's existing Vitest setup.",
                  },
                  {
                    label: "Jest",
                    description: "Use Jest for this work.",
                  },
                ],
                multiSelect: false,
              },
              {
                question: "Which scopes?",
                header: "Scopes",
                options: [
                  {
                    label: "Config",
                    description: "Config only.",
                  },
                  {
                    label: "Backend",
                    description: "Backend only.",
                  },
                ],
                multiSelect: true,
              },
            ],
            answers: {
              "Which test runner should we use?": "Vitest",
              "Which scopes?": "Config, Backend",
            },
          });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return JSON.stringify({
            "Test runner": "Vitest",
            Scopes: ["Config", "Backend"],
          });
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      situation: {
        role: "researcher",
        audience: "originator",
        cause: "question",
      },
      metadata: {
        toolCallId: expect.any(String),
      },
      content: {
        kind: "question-form",
        questions: [
          expect.objectContaining({
            question: "Which test runner should we use?",
            header: "Test runner",
            takesOtherAnswer: true,
          }),
          expect.objectContaining({
            question: "Which scopes?",
            header: "Scopes",
            multiSelect: true,
            takesOtherAnswer: true,
          }),
        ],
      },
    });
    expect(emitted[0]!.content).toMatchObject({
      kind: "question-form",
      questions: [
        expect.objectContaining({
          question: "Which test runner should we use?",
          header: "Test runner",
          takesOtherAnswer: true,
        }),
        expect.objectContaining({
          question: "Which scopes?",
          header: "Scopes",
          multiSelect: true,
          takesOtherAnswer: true,
        }),
      ],
    });
  });

  it("routes a freeform Claude question and returns its exact answer", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-freeform-question",
        { outcome: "completed" },
        async () => {
          await expect(
            callSdkDiscuss(params, {
              question: "  What should change?  ",
            }),
          ).resolves.toEqual({
            answer: "Change the API",
          });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return "Change the API";
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toEqual([
      expect.objectContaining({
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "question",
        },
        content: "What should change?",
        metadata: { toolCallId: expect.any(String) },
      }),
    ]);
  });

  it("routes a promptless Claude discussion and waits for feedback on existing audience-visible context", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-promptless-discussion",
        { outcome: "completed" },
        async () => {
          await expect(callSdkDiscuss(params, {})).resolves.toEqual({
            answer: "Continue",
          });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return "Continue";
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toEqual([
      expect.objectContaining({
        situation: expect.objectContaining({
          audience: "originator",
          cause: "question",
        }),
        content: "",
        metadata: { toolCallId: expect.any(String) },
      }),
    ]);
  });

  it("routes an authorized non-originator freeform Claude question", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text" as const, value: "Discuss the draft with " },
          {
            kind: "hostVar" as const,
            module: "audience",
            path: ["supervisor"],
          },
          { kind: "text" as const, value: "." },
        ] as const,
      ],
    };
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-freeform-supervisor",
        { outcome: "completed" },
        async () => {
          await expect(
            callSdkDiscuss(params, {
              audience: "supervisor",
              question: "What should change?",
            }),
          ).resolves.toEqual({ answer: "Change the API" });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return "Change the API";
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toEqual([
      expect.objectContaining({
        situation: expect.objectContaining({
          audience: "supervisor",
          cause: "question",
        }),
        content: "What should change?",
      }),
    ]);
  });

  it("rejects invalid Claude discussion and audience inputs", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-invalid-question-variants",
        { outcome: "completed" },
        async () => {
          await expect(
            callSdkTool(params, "discuss", { question: "" }),
          ).rejects.toThrow();
          await expect(
            callSdkTool(params, "discuss", { question: "   " }),
          ).rejects.toThrow();
          await expect(
            callSdkTool(params, "ask_audience", {}),
          ).rejects.toThrow();
          await expect(
            callSdkTool(params, "ask_audience", {
              audience: "originator",
              questions: [structuredQuestionFixture()],
            }),
          ).rejects.toThrow();
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return "unexpected";
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toEqual([]);
  });

  it("routes explicit audience questions to that audience", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text" as const, value: "Send a status update to " },
          {
            kind: "hostVar" as const,
            module: "audience",
            path: ["supervisor"],
          },
          { kind: "text" as const, value: " and ask for approval." },
        ] as const,
      ],
    };
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-audience-question",
        { outcome: "completed" },
        async () => {
          const result = await callSdkAskAudience(params, {
            audience: "supervisor",
            questions: [
              {
                question: "Approve this plan?",
                header: "Approval",
                options: [
                  {
                    label: "Approve",
                    description: "Approve the proposed plan.",
                  },
                  {
                    label: "Reject",
                    description: "Reject the proposed plan.",
                  },
                ],
                multiSelect: false,
              },
            ],
          });
          expect(result).toEqual({
            answers: {
              "Approve this plan?": "Approve",
            },
          });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return "Approve";
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toEqual([
      expect.objectContaining({
        situation: expect.objectContaining({
          audience: "supervisor",
          cause: "question",
        }),
        content: expect.objectContaining({ kind: "question-form" }),
        metadata: expect.objectContaining({ toolCallId: expect.any(String) }),
      }),
    ]);
  });

  it("stamps SDK emit_outbound messages as replies", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text" as const, value: "Reply to " },
          { kind: "entity" as const, name: "user" },
          { kind: "text" as const, value: " with the update." },
        ] as const,
      ],
    };
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-reply-outbound",
        { outcome: "completed" },
        async () => {
          const result = await callSdkTool(params, "emit_outbound", {
            audience: "user",
            content: "Here is the update.",
          });
          expect(result).toEqual({
            content: [{ type: "text", text: '{"ok":true}' }],
          });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toEqual([
      expect.objectContaining({
        situation: expect.objectContaining({
          audience: "originator",
          cause: "reply",
        }),
        content: "Here is the update.",
      }),
    ]);
  });

  it("uses the resolved workspace root from RoutineContext", async () => {
    const task = await firstTask();
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-routine-dir", { outcome: "completed" }),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    const ctx = context();
    await runBackend(
      backend,
      routine(task),
      ctx,
      noopRoutineEffects(),
      noopDiagnostics,
    );

    const cwd = query.mock.calls[0]![0].options?.cwd;
    expect(cwd).toBe(ctx.workspacePath);
  });

  it("renders instruction prompts without raw task dumps or permission prose", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 1 },
        lastTurns: [
          { role: "user", message: "Please prepare the Q4 launch plan." },
          { role: "self", message: "I will route this to the researcher." },
        ],
      },
      texts: [
        [
          { kind: "text" as const, value: "Reply to " },
          { kind: "entity" as const, name: "user" },
          {
            kind: "text" as const,
            value: ".\nAsk ",
          },
          {
            kind: "hostVar" as const,
            module: "audience",
            path: ["supervisor"],
          },
          {
            kind: "text" as const,
            value: " whether the plan is acceptable.\nThen write ",
          },
          { kind: "artifact" as const, path: "plans/q4.md" },
          {
            kind: "text" as const,
            value: ".\nThen notify ",
          },
          {
            kind: "hostVar" as const,
            module: "audience",
            path: ["approval", "finance"],
          },
          {
            kind: "text" as const,
            value: " if it is approved.",
          },
        ] as const,
      ] as const,
      cells: { planName: "Q4 launch" },
    };
    task.guidance = [
      [
        { kind: "text", value: "Follow " },
        { kind: "artifact", path: "policy.md" },
        { kind: "text", value: "." },
      ],
    ];
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    const ctx = context();
    await runBackend(
      backend,
      routine(task),
      ctx,
      noopRoutineEffects(),
      noopDiagnostics,
    );

    const prompt = states[0]!.prompts[0]!;
    expect(prompt).toContain(`as the "${task.role}" role`);
    expect(prompt).toContain("<prior-turns>");
    expect(prompt).toContain(
      '<msg by="user" idx="0">Please prepare the Q4 launch plan.</msg>',
    );
    expect(prompt).toContain(
      '<msg by="self" idx="1">I will route this to the researcher.</msg>',
    );
    expect(prompt).toContain("</prior-turns>");
    expect(prompt).toContain("<instruction>");
    expect(prompt).toContain("</instruction>");
    expect(prompt).toContain(
      `<guidance>\nFollow ${join(ctx.workspacePath, "policy.md")}.\n</guidance>`,
    );
    expect(query.mock.calls[0]![0].options?.systemPrompt).toMatchObject({
      append: expect.stringContaining("Apply standing guidance"),
    });
    expect(prompt).toContain("<cells>");
    expect(prompt).toContain("</cells>");
    expect(prompt).toContain("<rules>");
    expect(prompt).toContain("</rules>");
    expect(prompt).toContain(
      "Ask <audience:supervisor> whether the plan is acceptable.",
    );
    expect(prompt).toContain(join(ctx.workspacePath, "plans", "q4.md"));
    expect(prompt).toContain("- user -> originator");
    expect(prompt).toContain("- <audience:supervisor> -> supervisor");
    expect(prompt).toContain(
      "- <audience:approval.finance> -> approval.finance",
    );
    expect(prompt).toContain("mcp__arcade_internal__discuss");
    expect(prompt).toContain("mcp__arcade_internal__ask_audience");
    expect(prompt).toContain("Structured originator input: AskUserQuestion");
    expect(prompt).toContain("Execute only the current assigned task.");
    expect(prompt).not.toContain("current Arc instruction task");
    expect(prompt).toContain("Do not create, edit, delete, or move");
    expect(prompt).toContain(
      "without applying document changes unless the same instruction explicitly asks",
    );
    expect(prompt).toContain(
      "When the instruction requires delivery to an audience listed above",
    );
    expect(prompt).toContain(
      "Plain assistant text does not deliver that content.",
    );
    expect(prompt).toContain(
      "Do not copy an audience marker into delivered content or question text.",
    );
    expect(prompt).toContain("Claude tool routing:");
    expect(prompt).toContain("- Structured originator input: AskUserQuestion");
    expect(prompt).toContain(
      "- Final task report: mcp__arcade_internal__report",
    );
    expect(prompt).not.toContain("Do not report completed");
    expect(prompt).not.toContain("deflected");
    expect(prompt).toContain('"planName": "Q4 launch"');
    expect(prompt).not.toContain("Instruction:");
    expect(prompt).not.toContain("Task:");
    expect(prompt).not.toContain("Dialog:");
    expect(prompt).not.toContain("--permission-prompt-tool");
    expect(prompt).not.toContain("request_permission");
  });

  it("preserves an authored interaction prohibition in the Claude prompt", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        "Do not ask the originator any questions. Complete autonomously.",
      ],
    };
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(states[0]!.prompts[0]).toContain(
      "Do not ask the originator any questions. Complete autonomously.",
    );
    const options = query.mock.calls[0]![0].options!;
    expect((options.systemPrompt as { append: string }).append).toContain(
      "Follow every explicit requirement or prohibition in <instruction>",
    );
  });

  it("keeps discretionary originator access in an open Claude prompt", async () => {
    const task = await firstTask();
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    const options = query.mock.calls[0]![0].options!;
    expect((options.systemPrompt as { append: string }).append).toContain(
      "For each audience interaction, determine what input <instruction> requires",
    );
    expect(states[0]!.prompts[0]).not.toContain("Audience references:");
    expect(states[0]!.prompts[0]).toContain(
      "No audience references are available for this task. Keep one-way output private.",
    );
  });

  it("uses a message-only prompt when resuming a session-backed routine", async () => {
    const task = await firstTask();
    const prompts: string[] = [];
    const close = vi.fn();
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      async function* messages() {
        const input = params.prompt as AsyncIterable<{
          message?: { content?: unknown };
        }>;
        for await (const message of input) {
          prompts.push(String(message.message?.content ?? ""));
          yield {
            type: "system",
            subtype: "init",
            session_id: "session-live",
            cwd: params.options?.cwd ?? "",
          } as unknown;
          if (prompts.length === 1) {
            // A tool result is a pause boundary; the routine pauses here.
            yield {
              type: "user",
              parent_tool_use_id: null,
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool:pause",
                    content: "done",
                  },
                ],
              },
            } as unknown;
          } else await callSdkReport(params, { outcome: "completed" });
          yield {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            result: "ok",
            session_id: "session-live",
          } as unknown;
        }
      }
      const generator = messages() as AsyncGenerator<unknown, void> & {
        setModel: ReturnType<typeof vi.fn>;
        interrupt: ReturnType<typeof vi.fn>;
        close: typeof close;
      };
      generator.setModel = vi.fn(async () => undefined);
      generator.interrupt = vi.fn(async () => undefined);
      generator.close = close;
      return generator;
    });
    const backend = createClaudeSdkBackendForTesting({
      query: query as unknown as ClaudeSdkQueryFn,
      sessionCache: { enabled: true, maxPreparedStarts: 0 },
      resolveContinuityIdentity: async () => identity("test"),
    });
    const worker = await backend.createWorker(continuityHost(), {
      backend: "claude-sdk",
      kind: "role",
      role: task.role,
    });
    const input: RoutineInput = {
      routine: routine(task),
      context: context(),
      effects: noopRoutineEffects({
        checkSignal: async () => ({ kind: "pause" }),
      }),
      diagnostics: noopDiagnostics,
    };

    await expect(worker.run(input)).resolves.toMatchObject({
      suspension: "paused",
    });
    // `continue` delivery carries no text; the backend supplies its own turn.
    await expect(
      worker.run({
        ...input,
        context: context({ routineResume: { delivery: "continue" } }),
        effects: noopRoutineEffects(),
      }),
    ).resolves.toMatchObject({ outcome: "completed" });

    expect(query).toHaveBeenCalledTimes(1);
    expect(prompts[1]).toBe("Continue");
    await worker.stop?.();
  });

  it("uses canUseTool with workspace fast-path permission grants", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-workspace-fast");
    await mkdir(workspace, { recursive: true });
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-fast",
        { outcome: "completed" },
        async () => {
          const verdict = await params.options!.canUseTool!(
            "Write",
            {
              file_path: join(workspace, "scratch.txt"),
              content: "hi",
            },
            canUseOptions("write-1"),
          );
          expect(verdict).toMatchObject({
            behavior: "allow",
            updatedInput: {
              file_path: join(workspace, "scratch.txt"),
              content: "hi",
            },
          });
          const relativeVerdict = await params.options!.canUseTool!(
            "Write",
            {
              file_path: "relative-scratch.txt",
              content: "hi",
            },
            canUseOptions("write-relative"),
          );
          expect(relativeVerdict).toMatchObject({
            behavior: "allow",
            updatedInput: {
              file_path: "relative-scratch.txt",
              content: "hi",
            },
          });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context({
        workspacePath: workspace,
        workspaceBundle: {},
      }),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
        },
      }),
      noopDiagnostics,
    );

    expect(emitted.some((m) => m.situation.cause === "permission-ask")).toBe(
      false,
    );
  });

  it("does not fast-path relative paths that resolve outside the workspace", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-outside",
        { outcome: "completed" },
        async () => {
          const verdict = await params.options!.canUseTool!(
            "Write",
            {
              file_path: "../outside.txt",
              content: "no",
            },
            canUseOptions("write-outside"),
          );
          expect(verdict.behavior).toBe("deny");
        },
      ),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        sessionCache: { enabled: false },
        query: query as unknown as ClaudeSdkQueryFn,
      },
    });
    workerHub.registerOutboundHandler(
      {
        role: "researcher",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      async (message) => {
        emitted.push(message);
        const askId = message.metadata?.askId;
        if (typeof askId === "string") {
          await expect(
            drainLifecycle(
              workerHub.submitInbound({
                arcRunId: message.arcRunId,
                content: "deny",
                metadata: { askId, decision: "deny" },
              }),
            ),
          ).resolves.toEqual([
            { kind: "continued", arcRunId: message.arcRunId },
          ]);
        }
      },
    );

    const { arcRunId } = await settleFirstRoutine(workerHub, routineStore);

    expect(
      emitted.filter((m) => m.situation.cause === "permission-ask"),
    ).toHaveLength(1);
    const workEvents = await workerHub.listWorkEvents(arcRunId);
    expect(
      workEvents.filter(
        (event) =>
          (event.kind === "tool:started" ||
            event.kind === "tool:finished" ||
            event.kind === "tool:failed") &&
          event.toolCallId === "write-outside",
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "tool:started",
        toolName: "Write",
        toolCallId: "write-outside",
      }),
      expect.objectContaining({
        kind: "tool:finished",
        toolName: "Write",
        toolCallId: "write-outside",
        outcome: "deny",
      }),
    ]);
    expect(workEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "blocked:permission",
          askId: expect.any(String),
          toolCallId: "write-outside",
        }),
      ]),
    );
  });

  it("auto-allows SDK tools outside the controlled permission surface", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-auto-allow",
        { outcome: "completed" },
        async () => {
          await expect(
            params.options!.canUseTool!(
              "mcp__arcade_internal__report",
              { outcome: "completed" },
              canUseOptions("internal-report-1"),
            ),
          ).resolves.toMatchObject({
            behavior: "allow",
            updatedInput: { outcome: "completed" },
          });
        },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
        },
      }),
      noopDiagnostics,
    );

    expect(emitted.some((m) => m.situation.cause === "permission-ask")).toBe(
      false,
    );
  });

  it("routes Bash through permission ask before running from the SDK workspace", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const emitted: OutboundMessage[] = [];
    let observedStdout = "";
    let observedCwd: string | undefined;
    const command =
      "printf arcade-bash-ok > bash-output.txt && cat bash-output.txt";
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        "session-bash-command",
        { outcome: "completed" },
        async () => {
          const verdict = await params.options!.canUseTool!(
            "Bash",
            { command },
            canUseOptions("bash-command-1"),
          );
          expect(verdict).toMatchObject({
            behavior: "allow",
            updatedInput: { command },
          });

          const cwd = params.options!.cwd;
          observedCwd = cwd;
          const { stdout } = await execFileAsync("bash", ["-lc", command], {
            cwd,
            encoding: "utf8",
          });
          observedStdout = String(stdout);
        },
      ),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        sessionCache: { enabled: false },
        query: query as unknown as ClaudeSdkQueryFn,
      },
    });

    workerHub.registerOutboundHandler(
      {
        role: "researcher",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      async (message) => {
        emitted.push(message);
        const askId = message.metadata?.askId;
        if (typeof askId === "string") {
          await expect(
            drainLifecycle(
              workerHub.submitInbound({
                arcRunId: message.arcRunId,
                content: "allow",
                metadata: { askId, decision: "allow" },
              }),
            ),
          ).resolves.toEqual([
            { kind: "continued", arcRunId: message.arcRunId },
          ]);
        }
      },
    );

    const { arcRunId } = await settleFirstRoutine(workerHub, routineStore);

    expect(observedCwd).toBe(
      (await arcHost.getRunWorkspaceContext(arcRunId)).workspacePath,
    );
    expect(observedStdout).toBe("arcade-bash-ok");
    expect(
      emitted.filter((m) => m.situation.cause === "permission-ask"),
    ).toHaveLength(1);
    const ask = emitted.find((m) => m.situation.cause === "permission-ask");
    expect(ask).toMatchObject({
      situation: {
        role: "researcher",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      content: expect.stringContaining("Bash"),
      metadata: {
        askId: expect.any(String),
        toolCallId: "bash-command-1",
        permissionAsk: {
          toolName: "Bash",
          input: { command },
        },
      },
    });
  });

  it("persists SDK session ids and resumes only when cwd is stable", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-workspace-resume");
    const otherWorkspace = join(tmpdir(), "arcade-sdk-workspace-resume-other");
    await mkdir(workspace, { recursive: true });
    await mkdir(otherWorkspace, { recursive: true });
    const task = await firstTask();
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        query.mock.calls.length === 1 ? "session-one" : "session-two",
        { outcome: "completed" },
      ),
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task, { id: "routine-1" }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(
        { ...task, briefIds: [`${task.briefIds[0]}:2`] as const },
        { id: "routine-2" },
      ),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(
        { ...task, briefIds: [`${task.briefIds[0]}:3`] as const },
        { id: "routine-3" },
      ),
      context({ workspacePath: otherWorkspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(query.mock.calls[0]![0].options?.resume).toBeUndefined();
    expect(query.mock.calls[1]![0].options?.resume).toBe("session-one");
    expect(query.mock.calls[2]![0].options?.resume).toBeUndefined();
  });

  it("returns a paused suspension directly after retaining the Claude live session", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-live-session-paused");
    await mkdir(workspace, { recursive: true });
    const task = await firstTask();
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn();
    const query = vi.fn(() => {
      async function* messages() {
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool:pause",
                content: "done",
              },
            ],
          },
        } as unknown;
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "interrupted",
          session_id: "session-paused",
        } as unknown;
      }
      const generator = messages() as AsyncGenerator<unknown, void> & {
        setModel: ReturnType<typeof vi.fn>;
        interrupt: typeof interrupt;
        close: typeof close;
      };
      generator.setModel = vi.fn(async () => undefined);
      generator.interrupt = interrupt;
      generator.close = close;
      return generator;
    });
    const backend = new ClaudeSdkWorker({
      query: query as unknown as ClaudeSdkQueryFn,
      sessionCache: { enabled: true, maxPreparedStarts: 0 },
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context({ workspacePath: workspace }),
        noopRoutineEffects({ checkSignal: async () => ({ kind: "pause" }) }),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({ suspension: "paused" });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("reuses live instruction sessions and switches model per routine", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-live-session");
    await mkdir(workspace, { recursive: true });
    const task = await firstTask();
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      model: "claude-sonnet-4-6",
      query: query as unknown as ClaudeSdkQueryFn,
      routineOptions: ({ routine }) =>
        routine.id === "routine-2" ? { model: "claude-opus-4-7" } : undefined,
    });

    const firstRoutine = routine(task, { id: "routine-1" });
    const secondRoutine = routine(
      { ...task, briefIds: [`${task.briefIds[0]}:2`] as const },
      { id: "routine-2" },
    );
    const firstReport = await runBackend(
      backend,
      firstRoutine,
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    const secondReport = await runBackend(
      backend,
      secondRoutine,
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(isAsyncIterable(query.mock.calls[0]![0].prompt)).toBe(true);
    expect(states[0]!.prompts).toHaveLength(2);
    expect(states[0]!.setModel).toHaveBeenCalledWith("claude-opus-4-7");
    expect(query.mock.calls[0]![0].options?.cwd).toBe(workspace);
    expect(firstReport.backendDetails).toMatchObject({
      sessionCacheEnabled: true,
      liveSessionReused: false,
      preparedStartUsed: false,
    });
    expect(secondReport.backendDetails).toMatchObject({
      sessionCacheEnabled: true,
      liveSessionReused: true,
      preparedStartUsed: false,
    });
  });

  it("primes the dialog only on the first prompt into a reused session", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-dialog-prime");
    await mkdir(workspace, { recursive: true });
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 1 },
        lastTurns: [
          { role: "user", message: "Please prepare the Q4 launch plan." },
          { role: "self", message: "I will route this to the researcher." },
        ],
      },
    };
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task, { id: "routine-1" }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(
        { ...task, briefIds: [`${task.briefIds[0]}:2`] as const },
        { id: "routine-2" },
      ),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(states[0]!.prompts).toHaveLength(2);
    expect(states[0]!.prompts[0]).toContain("<prior-turns>");
    expect(states[0]!.prompts[0]).toContain(
      '<msg by="user" idx="0">Please prepare the Q4 launch plan.</msg>',
    );
    expect(states[0]!.prompts[1]).not.toContain("<prior-turns>");
  });

  it("gives node-isolated instructions independent live sessions", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-node-isolation");
    await mkdir(workspace, { recursive: true });
    const first: InstructionTask = {
      ...(await firstTask()),
      contextIsolation: "node",
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "Shared role history." }],
      },
    };
    const sibling: InstructionTask = {
      ...first,
      briefIds: [`${first.briefIds[0]}:sibling`],
      sourceRef: "node:watch:Sibling",
    };
    const returning: InstructionTask = {
      ...first,
      briefIds: [`${first.briefIds[0]}:returning`],
    };
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
      { outcome: "completed" },
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(first, {
        id: "routine-node-first",
        contextKey: workerContextKey(first, 0),
      }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(sibling, {
        id: "routine-node-sibling",
        contextKey: workerContextKey(sibling, 0),
      }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(returning, {
        id: "routine-node-returning",
        contextKey: workerContextKey(returning, 0),
      }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(states[0]!.prompts).toHaveLength(2);
    expect(states[1]!.prompts).toHaveLength(1);
    expect(states[0]!.prompts[0]).toContain("<prior-turns>");
    expect(states[1]!.prompts[0]).toContain("<prior-turns>");
    expect(states[0]!.prompts[1]).not.toContain("<prior-turns>");
    expect(first.role).toBe(sibling.role);
  });

  it("does not prime the dialog into a seeded server-side session", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-dialog-seeded");
    await mkdir(workspace, { recursive: true });
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "Continue the Q4 plan." }],
      },
    };
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });
    backend.seedSession(workerContextKey(task, 0), "session-prev", workspace);

    // A normal new task (no resume delivery) into an already-threaded session
    // must not re-render the dialog the server session already holds.
    await runBackend(
      backend,
      routine(task, { contextKey: workerContextKey(task, 0) }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(query.mock.calls[0]![0].options?.resume).toBe("session-prev");
    expect(states[0]!.prompts[0]).not.toContain("<prior-turns>");
  });

  it("starts a fresh Claude session when deflected re-entry advances the context epoch", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-deflected-reentry-epoch");
    await mkdir(workspace, { recursive: true });
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "Re-enter with this history." }],
      },
    };
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });
    backend.seedSession(
      workerContextKey(task, 0),
      "session-before-reentry",
      workspace,
    );

    await runBackend(
      backend,
      routine(task, { contextKey: workerContextKey(task, 1) }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(query.mock.calls[0]![0].options?.resume).toBeUndefined();
    expect(states[0]!.prompts[0]).toContain("<prior-turns>");
    expect(states[0]!.prompts[0]).toContain("Re-enter with this history.");
  });

  it("primes the dialog when a fresh-start resume reruns from scratch", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-dialog-fresh-start");
    await mkdir(workspace, { recursive: true });
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "Kick off the Q4 plan." }],
      },
    };
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task),
      context({
        workspacePath: workspace,
        routineResume: { delivery: "fresh-start" },
      }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(states[0]!.prompts[0]).toContain("<prior-turns>");
    expect(states[0]!.prompts[0]).toContain(
      '<msg by="user" idx="0">Kick off the Q4 plan.</msg>',
    );
  });

  it("evicts cached instruction sessions when cwd changes", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-live-cwd");
    const otherWorkspace = join(tmpdir(), "arcade-sdk-live-cwd-other");
    await mkdir(workspace, { recursive: true });
    await mkdir(otherWorkspace, { recursive: true });
    const task = await firstTask();
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task, { id: "routine-1" }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(
        { ...task, briefIds: [`${task.briefIds[0]}:2`] as const },
        { id: "routine-2" },
      ),
      context({ workspacePath: otherWorkspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(states[0]!.close).toHaveBeenCalled();
    expect(query.mock.calls[1]![0].options?.cwd).toBe(otherWorkspace);
  });

  it("consumes prepared instruction starts for the first live session", async () => {
    const task = await firstTask();
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    let startupOptions: NonNullable<
      Parameters<ClaudeSdkStartupFn>[0]
    >["options"];
    const warmQuery = vi.fn(
      (prompt: Parameters<ClaudeSdkQueryFn>[0]["prompt"]) =>
        query({
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
    const coldQuery = vi.fn();
    const backend = new ClaudeSdkWorker({
      query: coldQuery as unknown as ClaudeSdkQueryFn,
      startup: startup as unknown as ClaudeSdkStartupFn,
    });
    const ctx = context();

    backend.prepareWarmStart({
      arcRunId: task.arcRunId,
      role: task.role,
      contextKey: workerContextKey(task, 0),
      workspacePath: ctx.workspacePath,
    });
    const preparedRoutine = routine(task, {
      contextKey: workerContextKey(task, 0),
    });
    const report = await runBackend(
      backend,
      preparedRoutine,
      ctx,
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(startup).toHaveBeenCalledTimes(1);
    expect(warmQuery).toHaveBeenCalledTimes(1);
    expect(isAsyncIterable(warmQuery.mock.calls[0]![0])).toBe(true);
    expect(coldQuery).not.toHaveBeenCalled();
    expect(states[0]!.prompts).toHaveLength(1);
    expect(report.backendDetails).toMatchObject({
      sessionCacheEnabled: true,
      liveSessionReused: false,
      preparedStartUsed: true,
    });
  });

  it("routes cached session tools through the active routine context", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text" as const, value: "Reply to " },
          { kind: "entity" as const, name: "user" },
          { kind: "text" as const, value: " with the cached message." },
        ] as const,
      ],
    };
    const firstEmitted: OutboundMessage[] = [];
    const secondEmitted: OutboundMessage[] = [];
    const { query } = streamingQueryReturning(
      [{ outcome: "completed" }, { outcome: "completed" }],
      async (params, index) => {
        await callSdkTool(params, "emit_outbound", {
          audience: "originator",
          content: `message-${index}`,
        });
      },
    );
    const backend = new ClaudeSdkWorker({
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await runBackend(
      backend,
      routine(task, { id: "routine-1" }),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          firstEmitted.push(outbound(message));
        },
      }),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(
        { ...task, briefIds: [`${task.briefIds[0]}:2`] as const },
        { id: "routine-2" },
      ),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          secondEmitted.push(outbound(message));
        },
      }),
      noopDiagnostics,
    );

    expect(firstEmitted).toEqual([
      expect.objectContaining({ content: "message-0" }),
    ]);
    expect(secondEmitted).toEqual([
      expect.objectContaining({ content: "message-1" }),
    ]);
  });

  it("runs missing-report recovery through the same live instruction session", async () => {
    const task = await firstTask();
    const { query, states } = streamingQueryReturning([
      undefined,
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      query: query as unknown as ClaudeSdkQueryFn,
    });
    const routineState = routine(task);

    const report = await runBackend(
      backend,
      routineState,
      context(),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    expect(report).toMatchObject({
      outcome: "completed",
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(states[0]!.prompts).toHaveLength(2);
    expect(states[0]!.prompts[1]).toContain(
      "ended without calling the required",
    );
    expect(report.backendDetails).toMatchObject({
      sessionCacheEnabled: true,
      liveSessionReused: false,
      preparedStartUsed: false,
    });
  });

  it("asks the SDK worker for a report when the first turn omits one", async () => {
    const task = await firstTask();
    const emit = vi.fn(async () => "unused");
    const { logger, records } = createCapturingLogger("info");
    const { query, states } = streamingQueryReturning([
      undefined,
      { outcome: "completed" },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
      logger,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context(),
        noopRoutineEffects({ emit }),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({
      outcome: "completed",
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(states[0]!.prompts[1]).toContain(
      "ended without calling the required",
    );
    expect(states[0]!.prompts[1]).toContain("private worker memory");
    expect(states[0]!.prompts[1]).toContain(
      'pass exactly {"outcome":"completed"}',
    );
    expect(states[0]!.prompts[1]).toContain(
      'Do not include code or message with outcome "completed"',
    );
    expect(states[0]!.prompts[1]).toContain(
      "follow the shared audience-interaction policy",
    );
    expect(states[0]!.prompts[1]).toContain(
      "interaction tool returns its result",
    );
    expect(states[0]!.prompts[1]).toContain("Continue the same assigned work");
    expect(states[0]!.prompts[1]).toContain("mcp__arcade_internal__report");
    expect(emit).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "backend.claude_sdk.missing_report_recovery",
        attempt: 1,
      }),
    );
  });

  it("can ask a question during Claude missing-report recovery", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const { query, states } = streamingQueryReturning(
      [undefined, { outcome: "completed" }],
      async (params, index) => {
        if (index !== 1) return;
        await expect(
          callSdkDiscuss(params, {
            question: "Should recovery continue?",
          }),
        ).resolves.toEqual({ answer: "Continue" });
      },
    );
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context(),
        noopRoutineEffects({
          emit: async (message) => {
            emitted.push(outbound(message));
            return "Continue";
          },
        }),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });

    expect(query).toHaveBeenCalledTimes(1);
    expect(states[0]!.prompts).toHaveLength(2);
    expect(emitted).toEqual([
      expect.objectContaining({
        content: "Should recovery continue?",
        situation: expect.objectContaining({ cause: "question" }),
      }),
    ]);
  });

  it("fails clearly when the SDK worker still omits report after recovery", async () => {
    const task = await firstTask();
    const emit = vi.fn(async () => "unused");
    const { logger, records } = createCapturingLogger("info");
    const { query } = streamingQueryReturning([undefined, undefined]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
      logger,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context(),
        noopRoutineEffects({ emit }),
        noopDiagnostics,
      ),
    ).rejects.toThrow(/did not call.*report/);
    expect(query).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "backend.claude_sdk.missing_report_failed",
        attempts: 1,
      }),
    );
  });

  it("runs action semantic routines through SDK tools", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-action-semantic");
    await mkdir(workspace, { recursive: true });
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:action",
      role: "researcher",
      stage: "action",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "Resolve the LITE observation." }],
      },
      requests: [
        {
          kind: "observation",
          briefId: "observe:isNew",
          role: "researcher",
          cell: "isNew",
          mode: "observe",
          question: "is Lumentum new in the workspace longlist?",
          meta: { type: "boolean" },
          tool: {
            type: "function",
            name: "arc_observation_1",
            description: "Resolve observation.",
            parameters: { type: "object" },
            strict: true,
          },
          sourceRef: "node:test:Action",
        },
      ],
      activeInstruction: {
        kind: "instruction",
        allowedDispositions: [],
        briefIds: ["instruction:active"],
        role: "researcher",
        texts: [
          [
            { kind: "text", value: "Research {{ticker}} and tell " },
            { kind: "entity", name: "user" },
            { kind: "text", value: " the result." },
          ],
        ],
        tools: [],
        cells: { ticker: "LITE" },
        arcRunId: ARC_RUN_ID,
        dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
        sourceRef: "node:test:Action",
        contextIsolation: "role",
        phase: "postcheck",
      },
    };
    const { query, states } = streamingQueryReturning([
      {
        outcome: "completed",
        semantic: {
          observations: {
            "observe:isNew": { status: "resolved", value: true },
          },
        },
      },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context({ workspacePath: workspace }),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({
      outcome: "completed",
      semantic: {
        observations: {
          "observe:isNew": { status: "resolved", value: true },
        },
      },
    });

    const prompt = states[0]!.prompts[0]!;
    expect(prompt).toContain("<prior-turns>");
    expect(prompt).toContain(
      '<msg by="user" idx="0">Resolve the LITE observation.</msg>',
    );
    expect(prompt).toContain("<semantic-requests>");
    expect(prompt).toContain("</semantic-requests>");
    expect(prompt).not.toContain("<instruction>");
    const activeInstruction = JSON.parse(
      prompt.match(
        /<active-instruction>\n([\s\S]*?)\n<\/active-instruction>/,
      )![1]!,
    );
    expect(activeInstruction).toMatchObject({
      phase: "postcheck",
      text: expect.stringContaining("tell user the result"),
      audienceReferences: [{ marker: "user", audience: "originator" }],
    });
    expect(prompt).toContain('"cells"');
    expect(prompt).toContain('"ticker": "LITE"');
    expect(prompt).toContain("<rules>");
    expect(prompt).toContain("</rules>");
    expect(prompt).toContain("Resolve this action semantic work.");
    expect(prompt).toContain("Semantic report:");
    expect(prompt).toContain(
      'Do not call report with bare {"outcome":"completed"} for semantic work.',
    );
    expect(prompt).toContain(
      '"observe:isNew":{"status":"resolved","value":true}',
    );
    expect(prompt).not.toContain("Dialog:");
    const call = query.mock.calls[0]![0];
    expect(call.options?.cwd).toBe(workspace);
    expect(call.options?.systemPrompt).toMatchObject({
      append: expect.stringContaining(
        "Treat <active-instruction> as reference context for <semantic-requests>",
      ),
    });
    expect(call.options?.systemPrompt).toMatchObject({
      append: expect.stringContaining(
        "without repeating its work or audience interactions",
      ),
    });
    expect(call.options?.tools).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("carries array and grouped observation values through a complete semantic report", async () => {
    const workspace = join(tmpdir(), "arcade-sdk-array-group-semantic");
    await mkdir(workspace, { recursive: true });
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:array-group",
      role: "researcher",
      stage: "action",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [
          {
            role: "user",
            message: "us-east-1 and eu-west-2 are down; severity is high.",
          },
        ],
      },
      requests: [
        {
          kind: "observation",
          briefId: "observe:regions",
          role: "researcher",
          cell: "regions",
          mode: "observe",
          question: "which regions are affected?",
          meta: { type: "array", element: { type: "string" } },
          tool: {
            type: "function",
            name: "arc_observation_1",
            description: "Resolve observation.",
            parameters: { type: "object" },
            strict: true,
          },
          sourceRef: "node:test:Action",
        },
        {
          kind: "observation-group",
          briefId: "observe:group",
          role: "researcher",
          mode: "observe",
          fields: [
            {
              cell: "severity",
              question: "how severe is it?",
              meta: { type: "enum", values: ["low", "high"] },
            },
            {
              cell: "owners",
              question: "which owners were named?",
              meta: { type: "array", element: { type: "string" } },
            },
          ],
          tool: {
            type: "function",
            name: "arc_observation_group_2",
            description: "Resolve observation group.",
            parameters: { type: "object" },
            strict: true,
          },
          sourceRef: "node:test:Action",
        },
      ],
    };
    const { query } = streamingQueryReturning([
      {
        outcome: "completed",
        semantic: {
          observations: {
            "observe:regions": {
              status: "resolved",
              value: ["us-east-1", "eu-west-2"],
            },
            "observe:group": {
              fields: {
                severity: { status: "resolved", value: "high" },
                owners: { status: "resolved", value: ["platform", "network"] },
              },
            },
          },
        },
      },
    ]);
    const backend = new ClaudeSdkWorker({
      sessionCache: { enabled: false },
      query: query as unknown as ClaudeSdkQueryFn,
    });

    // An array observation reports an ordered primitive list, and a grouped
    // observation reports one outcome per cell. Both must survive report
    // ingest intact; dropping either leaves the brief unresolved and re-emitted.
    await expect(
      runBackend(
        backend,
        routine(task),
        context({ workspacePath: workspace }),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({
      outcome: "completed",
      semantic: {
        observations: {
          "observe:regions": {
            status: "resolved",
            value: ["us-east-1", "eu-west-2"],
          },
          "observe:group": {
            fields: {
              severity: { status: "resolved", value: "high" },
              owners: { status: "resolved", value: ["platform", "network"] },
            },
          },
        },
      },
    });
  });

  it("routes instruction tasks through the default worker slot", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-default-policy", { outcome: "completed" }),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "claude-sdk" },
      claudeSdk: {
        sessionCache: { enabled: false },
        query: query as unknown as ClaudeSdkQueryFn,
      },
    });

    const { routine } = await settleFirstRoutine(workerHub, routineStore);
    expect(routine.status).toBe("finished");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("routes controlled permission asks through worker hub with fresh unidentified sessions", async () => {
    // Two node-isolated routines on one node, then one on a sibling node.
    const arcHost = await makeArcHostWithSource(
      "watch",
      `"arc";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher", contextIsolation: "node" };
  $instruct(\`Watch for updates.\`);
  $instruct(\`Watch again.\`);
  $enter(Sibling);
  function Sibling() {
    this.hostParams = { workerRole: "researcher", contextIsolation: "node" };
    $instruct(\`Sibling work.\`);
  }
}`,
    );
    const emitted: OutboundMessage[] = [];
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        `session-${query.mock.calls.length}`,
        {
          outcome: "completed",
        },
        async () => {
          const verdict = await params.options!.canUseTool!(
            "WebFetch",
            { url: "https://example.com", prompt: "Summarize this page." },
            canUseOptions(`web-fetch-${query.mock.calls.length}`),
          );
          expect(verdict.behavior).toBe("allow");
        },
      ),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        sessionCache: { enabled: false },
        query: query as unknown as ClaudeSdkQueryFn,
      },
    });

    workerHub.registerOutboundHandler(
      {
        role: "researcher",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      async (message) => {
        emitted.push(message);
        const askId = message.metadata?.askId;
        if (typeof askId === "string") {
          await expect(
            drainLifecycle(
              workerHub.submitInbound({
                arcRunId: message.arcRunId,
                content: "allow_this_run",
                metadata: { askId, decision: "allow_this_run" },
              }),
            ),
          ).resolves.toEqual([
            { kind: "continued", arcRunId: message.arcRunId },
          ]);
        }
      },
    );

    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(
      async () =>
        (await collectAsync(routineStore.listRoutines(arcRunId))).filter(
          (routine) => routine.status === "finished",
        ).length === 3,
    );

    expect(
      emitted.filter((m) => m.situation.cause === "permission-ask"),
    ).toHaveLength(3);
  });

  it("keeps Bash per-command by not persisting an SDK-level grant", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    type CanUseTool = NonNullable<
      NonNullable<Parameters<ClaudeSdkQueryFn>[0]["options"]>["canUseTool"]
    >;
    type Suggestions = NonNullable<Parameters<CanUseTool>[2]["suggestions"]>;
    const suggestions: Suggestions = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash" }],
        behavior: "allow",
        destination: "session",
      },
    ];
    let bashVerdict: Awaited<ReturnType<CanUseTool>> | undefined;
    let webVerdict: Awaited<ReturnType<CanUseTool>> | undefined;
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(
        params,
        `session-${query.mock.calls.length}`,
        { outcome: "completed" },
        async () => {
          bashVerdict = await params.options!.canUseTool!(
            "Bash",
            {
              command: "ls",
            },
            {
              signal: new AbortController().signal,
              toolUseID: "bash-1",
              suggestions,
            },
          );
          webVerdict = await params.options!.canUseTool!(
            "WebFetch",
            { url: "https://example.com", prompt: "Summarize this page." },
            {
              signal: new AbortController().signal,
              toolUseID: "web-1",
              suggestions,
            },
          );
        },
      ),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        sessionCache: { enabled: false },
        query: query as unknown as ClaudeSdkQueryFn,
      },
    });
    workerHub.registerOutboundHandler(
      {
        role: "researcher",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      async (message) => {
        const askId = message.metadata?.askId;
        if (typeof askId === "string") {
          await expect(
            drainLifecycle(
              workerHub.submitInbound({
                arcRunId: message.arcRunId,
                content: "allow_this_run",
                metadata: { askId, decision: "allow_this_run" },
              }),
            ),
          ).resolves.toEqual([
            { kind: "continued", arcRunId: message.arcRunId },
          ]);
        }
      },
    );

    await settleFirstRoutine(workerHub, routineStore);

    // Bash: Arcade granted allow_this_run, but the SDK is told only allow-once
    // so it re-asks each command and Arcade's per-command grant stays in charge.
    expect(bashVerdict?.behavior).toBe("allow");
    if (bashVerdict?.behavior === "allow") {
      expect(bashVerdict.decisionClassification).toBe("user_temporary");
      expect(bashVerdict.updatedPermissions).toBeUndefined();
    }
    // A non-command tool keeps the SDK-level "remember" suggestions.
    expect(webVerdict?.behavior).toBe("allow");
    if (webVerdict?.behavior === "allow") {
      expect(webVerdict.decisionClassification).toBe("user_permanent");
      expect(webVerdict.updatedPermissions).toEqual(suggestions);
    }
  });
});

describe("Claude SDK worker adapter continuity", () => {
  it("captures Claude session cache config in the created worker", async () => {
    const host = continuityHost();
    const task = await firstTask();
    const report = await runClaudeWorker(
      host,
      task,
      vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
        sdkMessages(params, "session-config", { outcome: "completed" }),
      ),
      async () => identity("scope-a"),
      "routine:config",
      { sessionCache: { enabled: true, maxPreparedStarts: 0 } },
    );

    expect(report.backendDetails).toMatchObject({ sessionCacheEnabled: true });
  });

  it("uses Claude model config from the selected role slot", async () => {
    const host = continuityHost();
    const task = await firstTask();
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-model", { outcome: "completed" }),
    );

    await runClaudeWorker(
      host,
      task,
      query,
      async () => identity("scope-a"),
      "routine:model",
      { model: "claude-slot-model" },
    );

    expect(query.mock.calls[0]?.[0].options?.model).toBe("claude-slot-model");
  });

  it("loads matching continuity inside the worker warm hint", async () => {
    const values = new Map<string, JsonValue>();
    const get = vi.fn(async (arcRunId: string, key: string) =>
      values.get(`${arcRunId}:${key}`),
    );
    const host: WorkerHost = {
      logger: {
        level: "silent",
        format: "json",
        info: () => undefined,
        debug: () => undefined,
      },
      state: {
        get,
        put: async (arcRunId, key, value) => {
          values.set(`${arcRunId}:${key}`, value);
        },
      },
    };
    const task = await firstTask();
    const contextKey = workerContextKey(task, 0);
    values.set(`${task.arcRunId}:${contextKey}`, {
      schema: 1,
      sessionId: "session-warm",
      cwd: context().workspacePath,
      identity: identity("scope-a"),
    });
    const backend = createClaudeSdkBackend({
      sessionCache: { enabled: false },
      resolveContinuityIdentity: async () => identity("scope-a"),
    });
    const worker = await backend.createWorker(host, {
      backend: "claude-sdk",
      kind: "role",
      role: task.role,
    });

    worker.warm?.({
      arcRunId: task.arcRunId,
      role: task.role,
      contextKey,
      workspacePath: context().workspacePath,
    });

    await waitFor(() => get.mock.calls.length === 1);
    expect(get).toHaveBeenCalledWith(task.arcRunId, contextKey);
  });

  it("creates a prepared Claude start from the worker warm hint", async () => {
    const host = continuityHost();
    const task = await firstTask();
    const ctx = context();
    const contextKey = workerContextKey(task, 0);
    const { query, states } = streamingQueryReturning([
      { outcome: "completed" },
    ]);
    let startupOptions: NonNullable<
      Parameters<ClaudeSdkStartupFn>[0]
    >["options"];
    const warmQuery = vi.fn(
      (prompt: Parameters<ClaudeSdkQueryFn>[0]["prompt"]) =>
        query({ prompt, options: startupOptions }),
    );
    const startup = vi.fn(async (params: Parameters<ClaudeSdkStartupFn>[0]) => {
      startupOptions = params?.options;
      return { query: warmQuery, close: vi.fn() };
    });
    const coldQuery = vi.fn();
    const backend = createClaudeSdkBackendForTesting({
      query: coldQuery as unknown as ClaudeSdkQueryFn,
      startup: startup as unknown as ClaudeSdkStartupFn,
      resolveContinuityIdentity: async () => identity("scope-a"),
    });
    const worker = await backend.createWorker(host, {
      backend: "claude-sdk",
      kind: "role",
      role: task.role,
    });
    const input: RoutineInput = {
      routine: {
        id: "routine:warmed-worker",
        arcRunId: task.arcRunId,
        role: task.role,
        contextKey,
        task,
      },
      context: ctx,
      effects: noopRoutineEffects(),
      diagnostics: noopDiagnostics,
    };

    worker.warm?.({
      arcRunId: task.arcRunId,
      role: task.role,
      contextKey,
      workspacePath: ctx.workspacePath,
    });
    const report = await worker.run(input);

    expect(startup).toHaveBeenCalledTimes(1);
    expect(warmQuery).toHaveBeenCalledTimes(1);
    expect(coldQuery).not.toHaveBeenCalled();
    expect(states[0]!.prompts).toHaveLength(1);
    expect(report.backendDetails).toMatchObject({ preparedStartUsed: true });
  });

  it("persists continuity identity without provider credentials", async () => {
    const host = continuityHost();
    const task = await firstTask();
    await runClaudeWorker(
      host,
      task,
      vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
        sdkMessages(params, "session-safe", { outcome: "completed" }),
      ),
      async () => identity("credential-scope-digest"),
      "routine:safe-continuity",
    );

    const stored = await host.state.get(
      task.arcRunId,
      workerContextKey(task, 0),
    );
    expect(stored).toMatchObject({
      schema: 1,
      sessionId: "session-safe",
      identity: identity("credential-scope-digest"),
    });
    expect(JSON.stringify(stored)).not.toContain("apiKey");
  });

  it("keeps Claude continuity readable after a returned failure", async () => {
    const host = continuityHost();
    const task = await firstTask();
    const report = await runClaudeWorker(
      host,
      task,
      vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
        sdkMessages(params, "session-before-failure", {
          error: "failed",
          code: "provider-rejected",
          message: "The provider rejected the task.",
        }),
      ),
      async () => identity("scope-a"),
      "routine:returned-failure",
    );

    expect(report).toMatchObject({
      error: "failed",
      code: "provider-rejected",
    });
    await expect(
      host.state.get(task.arcRunId, workerContextKey(task, 0)),
    ).resolves.toMatchObject({
      schema: 1,
      sessionId: "session-before-failure",
      identity: identity("scope-a"),
    });
  });

  it("resolves Claude continuity identity before constructing a resumed query", async () => {
    const order: string[] = [];
    const host = continuityHost();
    const task = await firstTask();
    const firstQuery = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-durable", { outcome: "completed" }),
    );
    await runClaudeWorker(
      host,
      task,
      firstQuery,
      async () => identity("scope-a"),
      "routine:first",
    );
    const resumedQuery = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      order.push("query");
      return sdkMessages(params, "session-resumed", { outcome: "completed" });
    });

    await runClaudeWorker(
      host,
      task,
      resumedQuery,
      async () => {
        order.push("identity");
        return identity("scope-a");
      },
      "routine:second",
    );

    expect(order).toEqual(["identity", "query"]);
    expect(resumedQuery.mock.calls[0]?.[0].options?.resume).toBe(
      "session-durable",
    );
  });

  it("resumes Claude from role-slot worker state only when cwd and continuity identity match", async () => {
    const host = continuityHost();
    const task = await firstTask();
    await runClaudeWorker(
      host,
      task,
      vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
        sdkMessages(params, "session-match", { outcome: "completed" }),
      ),
      async () => identity("scope-a"),
      "routine:first",
    );
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-next", { outcome: "completed" }),
    );

    await runClaudeWorker(
      host,
      task,
      query,
      async () => identity("scope-a"),
      "routine:second",
    );

    expect(query.mock.calls[0]?.[0].options?.resume).toBe("session-match");
  });

  it("starts Claude fresh when its credential scope identity changes", async () => {
    const host = continuityHost();
    const task = await firstTask();
    await runClaudeWorker(
      host,
      task,
      vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
        sdkMessages(params, "session-old-scope", { outcome: "completed" }),
      ),
      async () => identity("scope-a"),
      "routine:first",
    );
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-new-scope", { outcome: "completed" }),
    );

    await runClaudeWorker(
      host,
      task,
      query,
      async () => identity("scope-b"),
      "routine:second",
    );

    expect(query.mock.calls[0]?.[0].options?.resume).toBeUndefined();
  });

  it("starts Claude fresh when pre-resume continuity identity is unavailable", async () => {
    const host = continuityHost();
    const task = await firstTask();
    await runClaudeWorker(
      host,
      task,
      vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
        sdkMessages(params, "session-identity-unavailable", {
          outcome: "completed",
        }),
      ),
      async () => identity("scope-a"),
      "routine:first",
    );
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-fresh", { outcome: "completed" }),
    );

    await runClaudeWorker(
      host,
      task,
      query,
      async () => undefined,
      "routine:second",
    );

    expect(query.mock.calls[0]?.[0].options?.resume).toBeUndefined();
  });
});

async function runClaudeWorker(
  host: WorkerHost,
  task: InstructionTask,
  query: (params: Parameters<ClaudeSdkQueryFn>[0]) => AsyncIterable<unknown>,
  resolveContinuityIdentity: () => Promise<
    | {
        schema: 1;
        provider: string;
        endpoint: string;
        credentialScope: string;
      }
    | undefined
  >,
  routineId: string,
  slotConfig: Record<string, JsonValue> = {},
): Promise<RoutineReport> {
  const backend = createClaudeSdkBackendForTesting({
    query: query as unknown as ClaudeSdkQueryFn,
    sessionCache: { enabled: false },
    resolveContinuityIdentity,
  });
  const worker = await backend.createWorker(host, {
    backend: "claude-sdk",
    kind: "role",
    role: task.role,
    ...slotConfig,
  });
  const input: RoutineInput = {
    routine: {
      id: routineId,
      arcRunId: task.arcRunId,
      role: task.role,
      contextKey: workerContextKey(task, 0),
      task,
    },
    context: context(),
    effects: noopRoutineEffects(),
    diagnostics: noopDiagnostics,
  };
  return worker.run(input);
}

function continuityHost(): WorkerHost {
  const values = new Map<string, JsonValue>();
  return {
    logger: {
      level: "silent",
      format: "json",
      info: () => undefined,
      debug: () => undefined,
    },
    state: {
      get: async (arcRunId, key) => values.get(`${arcRunId}:${key}`),
      put: async (arcRunId, key, value) => {
        values.set(`${arcRunId}:${key}`, value);
      },
    },
  };
}

function identity(credentialScope: string) {
  return {
    schema: 1 as const,
    provider: "anthropic",
    endpoint: "https://api.anthropic.com",
    credentialScope,
  };
}

async function* sdkMessages(
  params: Parameters<ClaudeSdkQueryFn>[0],
  sessionId: string,
  report?: RoutineReport,
  beforeResult?: () => Promise<void>,
) {
  if (beforeResult) await beforeResult();
  if (report) await callSdkReport(params, report);
  yield {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd: params.options?.cwd ?? "",
  } as unknown;
  yield {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "ok",
    session_id: sessionId,
  } as unknown;
}

type StreamingQueryState = {
  prompts: string[];
  setModel: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function streamingQueryReturning(
  reports: Array<RoutineReport | undefined>,
  beforeReport?: (
    params: Parameters<ClaudeSdkQueryFn>[0],
    index: number,
  ) => Promise<void>,
): {
  query: ClaudeSdkQueryFn & ReturnType<typeof vi.fn>;
  states: StreamingQueryState[];
} {
  const states: StreamingQueryState[] = [];
  const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
    const state: StreamingQueryState = {
      prompts: [],
      setModel: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    states.push(state);
    const generator = streamingSdkMessages(
      params,
      state,
      reports,
      beforeReport,
    ) as AsyncGenerator<unknown, void> & {
      setModel: StreamingQueryState["setModel"];
      close: StreamingQueryState["close"];
    };
    generator.setModel = state.setModel;
    generator.close = state.close;
    return generator;
  }) as unknown as ClaudeSdkQueryFn & ReturnType<typeof vi.fn>;
  return { query, states };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" && value !== null && Symbol.asyncIterator in value
  );
}

async function* streamingSdkMessages(
  params: Parameters<ClaudeSdkQueryFn>[0],
  state: StreamingQueryState,
  reports: Array<RoutineReport | undefined>,
  beforeReport?: (
    params: Parameters<ClaudeSdkQueryFn>[0],
    index: number,
  ) => Promise<void>,
) {
  const input = params.prompt as AsyncIterable<{
    message?: { content?: unknown };
  }>;
  let index = 0;
  for await (const message of input) {
    state.prompts.push(String(message.message?.content ?? ""));
    await beforeReport?.(params, index);
    const report =
      index < reports.length ? reports[index] : reports[reports.length - 1];
    if (report) await callSdkReport(params, report);
    yield {
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "ok",
      session_id: `session-live-${index}`,
    } as unknown;
    index += 1;
  }
}

async function callSdkDiscuss(
  params: Parameters<ClaudeSdkQueryFn>[0],
  input: Record<string, unknown>,
): Promise<unknown> {
  return await callSdkQuestionTool(params, "discuss", input);
}

async function callSdkAskAudience(
  params: Parameters<ClaudeSdkQueryFn>[0],
  input: Record<string, unknown>,
): Promise<unknown> {
  return await callSdkQuestionTool(params, "ask_audience", input);
}

async function callSdkQuestionTool(
  params: Parameters<ClaudeSdkQueryFn>[0],
  name: "discuss" | "ask_audience",
  input: Record<string, unknown>,
): Promise<unknown> {
  const result = await callSdkTool(params, name, input);
  const content = (result as { content?: { text?: string }[] }).content;
  const text = content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : undefined;
}

async function callNativeAskUserQuestion(
  params: Parameters<ClaudeSdkQueryFn>[0],
  input: Record<string, unknown>,
): Promise<unknown> {
  const canUseTool = params.options?.canUseTool;
  if (!canUseTool) throw new Error("Expected canUseTool callback.");
  const result = await canUseTool("AskUserQuestion", input, {
    signal: new AbortController().signal,
    toolUseID: `native-question-${Math.random()}`,
  });
  if (result.behavior !== "allow") throw new Error(result.message);
  return result.updatedInput;
}

async function callSdkTool(
  params: Parameters<ClaudeSdkQueryFn>[0],
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const server = params.options?.mcpServers?.arcade_internal as unknown as {
    instance: {
      _registeredTools: Record<
        string,
        {
          handler: (
            args: Record<string, unknown>,
            extra: unknown,
          ) => Promise<unknown>;
        }
      >;
    };
  };
  return await server.instance._registeredTools[name]!.handler(input, {});
}

/**
 * Kept local rather than shared: the OpenAI SDK suite's `context` defaults to
 * its own temp directory, and merging the two would make both suites write into
 * the same workspace.
 */
function context(
  opts: {
    workspacePath?: string;
    workspaceBundle?: Record<string, string>;
    routineResume?: RoutineContext["routineResume"];
  } = {},
): RoutineContext {
  return {
    workspacePath:
      opts.workspacePath ?? join(tmpdir(), "arcade-claude-sdk-context"),
    workspaceBundle: opts.workspaceBundle ?? {},
    routineResume: opts.routineResume,
  };
}

function canUseOptions(toolUseID: string) {
  return {
    signal: new AbortController().signal,
    toolUseID,
  };
}

function structuredQuestionFixture() {
  return {
    question: "Choose one?",
    header: "Choice",
    options: [
      { label: "One", description: "Choose one." },
      { label: "Two", description: "Choose two." },
    ],
    multiSelect: false,
  };
}

describe("Claude invocation continuity boundary", () => {
  it("keeps Claude invocation open until its observed session write settles", async () => {
    const host = continuityHost();
    const task = await firstTask();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writing = false;
    const put = host.state.put;
    host.state.put = async (...args) => {
      writing = true;
      await writeGate;
      await put(...args);
    };
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkMessages(params, "session-held-write", { outcome: "completed" }),
    );
    const backend = createClaudeSdkBackendForTesting({
      query: query as unknown as ClaudeSdkQueryFn,
      sessionCache: { enabled: false },
      resolveContinuityIdentity: async () => identity("scope-a"),
    });
    const worker = await backend.createWorker(host, {
      backend: "claude-sdk",
      kind: "role",
      role: task.role,
    });
    const contextKey = workerContextKey(task, 0);
    let completed = false;
    const pending = worker
      .run({
        routine: {
          id: "held-write",
          arcRunId: task.arcRunId,
          role: task.role,
          contextKey,
          task,
        },
        context: context(),
        effects: noopRoutineEffects(),
        diagnostics: noopDiagnostics,
      })
      .finally(() => {
        completed = true;
      });
    try {
      await waitFor(() => writing);
      expect(completed).toBe(false);
      expect(await host.state.get(task.arcRunId, contextKey)).toBeUndefined();
      releaseWrite();
      await expect(pending).resolves.toMatchObject({ outcome: "completed" });
      expect(await host.state.get(task.arcRunId, contextKey)).toMatchObject({
        sessionId: "session-held-write",
      });
    } finally {
      releaseWrite();
      await pending;
      await worker.stop?.();
    }
  });
});
