import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromJSONSchema } from "zod/v4";
import { createContinuityPreparation } from "../src/backends/continuity.js";

import { Agent, Runner, type Model } from "@openai/agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiSdkBackendForTesting } from "../src/backends/openai-sdk-backend.js";
import type { JsonValue, RoutineInput, WorkerHost } from "../src/index.js";
import {
  OpenAiSdkWorker,
  noopRoutineEffects,
  probeRetention,
  workerContextKey,
  type InstructionTask,
  type OpenAiRunState,
  type OpenAiSdkRunFn,
  type OutboundMessage,
  type RoutineContext,
  type Task,
} from "../src/testing.js";
import {
  noopDiagnostics,
  outbound,
  participantObservationTask,
  routine,
  runBackend,
} from "./backend-helpers.js";
import {
  ARC_RUN_ID,
  createCapturingLogger,
  deferred,
  firstTask,
  waitFor,
} from "./helpers.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((workspace) => rm(workspace, { recursive: true, force: true })),
  );
});

describe("OpenAiSdkWorker", () => {
  it.each(["paused", "transport-lost"] as const)(
    "preserves a %s OpenAI continuation across repeated credential failures before provider entry",
    async (initialSuspension) => {
      const task = await firstTask();
      const state = {} as OpenAiRunState;
      const failure = Object.assign(new Error("Connection reset"), {
        code: "ECONNRESET",
      });
      const getSecret = vi
        .fn(async () => "test-key")
        .mockResolvedValueOnce("test-key")
        .mockRejectedValueOnce(failure)
        .mockRejectedValueOnce(failure);
      const host: WorkerHost = {
        logger: createCapturingLogger().logger,
        state: {
          get: vi.fn(async () => undefined),
          put: vi.fn(async () => {}),
        },
      };
      const resolveContinuityIdentity = vi.fn(async () =>
        openAiIdentity("test", "test"),
      );
      const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
        if (run.mock.calls.length === 1)
          return initialSuspension === "paused"
            ? { signal: { kind: "pause" }, state }
            : {
                failureReport: {
                  suspension: "transport-lost",
                  reason: {
                    reason: "connection reset",
                    message: "Connection reset",
                  },
                },
                state,
              };
        expect(input.resumeState).toBe(state);
        expect(input.prompt).toBeUndefined();
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
        return { lastResponseId: "response-after-setup-retry" };
      });
      const backend = createOpenAiSdkBackendForTesting({
        apiKeySecret: "test-ref",
        secretResolver: { getSecret },
        resolveContinuityIdentity,
        run,
      });
      const worker = await backend.createWorker(host, {
        kind: "default",
        backend: "openai-sdk",
      });
      const input: RoutineInput = {
        routine: routine(task),
        context: context(),
        effects: noopRoutineEffects(),
        diagnostics: noopDiagnostics,
      };
      try {
        await expect(worker.run(input)).resolves.toMatchObject({
          suspension: initialSuspension,
        });
        await expect(
          worker.run({
            ...input,
            context: {
              ...input.context,
              ...(initialSuspension === "paused"
                ? { routineResume: { delivery: "continue" as const } }
                : {}),
            },
          }),
        ).resolves.toMatchObject({ suspension: "transport-lost" });
        // The hub retries transport-lost work without routineResume, including
        // work that originally reached this state through a manual pause.
        await expect(worker.run(input)).resolves.toMatchObject({
          suspension: "transport-lost",
        });
        expect(run).toHaveBeenCalledTimes(1);
        await expect(worker.run(input)).resolves.toMatchObject({
          outcome: "completed",
        });
        expect(run).toHaveBeenCalledTimes(2);
        expect(resolveContinuityIdentity).toHaveBeenCalledTimes(1);
        expect(host.state.get).toHaveBeenCalledTimes(1);
        expect(host.state.put).toHaveBeenCalledWith(
          task.arcRunId,
          input.routine.contextKey,
          expect.objectContaining({
            responseId: "response-after-setup-retry",
          }),
        );
      } finally {
        await worker.disposeRoutine({
          arcRunId: task.arcRunId,
          routineId: input.routine.id,
        });
        await worker.stop?.();
      }
    },
  );

  it("routes current OpenAI observation participants through waiting input tools across session reuse", async () => {
    const instruction = await firstTask();
    const recipients = ["supervisor", "reviewer"];
    const emitted: OutboundMessage[] = [];
    const gates = Array.from({ length: 4 }, () => deferred<string>());
    const exercise = async (
      call: (name: string, input: Record<string, unknown>) => Promise<unknown>,
      index: number,
    ) => {
      const audience = recipients[index]!;
      await call("emit_outbound", { audience, content: "Must stay private." });
      expect(emitted).toHaveLength(index * 2);
      for (const unavailable of [
        "outsider",
        ...(index === 1 ? ["supervisor"] : []),
      ]) {
        for (const name of ["discuss", "ask_audience"]) {
          const args =
            name === "discuss"
              ? { audience: unavailable, question: "Missing?" }
              : {
                  audience: unavailable,
                  questions: [structuredQuestionFixture()],
                };
          expect(String(await call(name, args))).toContain("current task");
        }
      }
      const values: string[] = [];
      for (const [offset, name] of ["discuss", "ask_audience"].entries()) {
        let settled = false;
        const pending = call(
          name,
          name === "discuss"
            ? {
                audience: `<audience:${audience}>`,
                question: "What is the answer?",
              }
            : { audience, questions: [structuredQuestionFixture()] },
        ).finally(() => {
          settled = true;
        });
        const position = index * 2 + offset;
        await waitFor(() => emitted.length === position + 1);
        expect(settled).toBe(false);
        expect(emitted[position]!.situation).toMatchObject({
          audience,
          cause: "question",
        });
        gates[position]!.resolve(offset === 0 ? "One" : "Two");
        const result = (await pending) as {
          answer?: string;
          answers?: Record<string, string>;
        };
        values.push(
          name === "discuss" ? result.answer! : result.answers!["Choose one?"]!,
        );
      }
      return {
        outcome: "completed" as const,
        semantic: {
          observations: {
            "observe:answer": {
              status: "resolved" as const,
              value: values.join("/"),
            },
          },
        },
      };
    };
    let invocation = 0;
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const index = invocation++;
      const report = await exercise(async (name, args) => {
        const raw = await callOpenAiToolRaw(input.agent, name, args);
        if (typeof raw !== "string") return raw;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return raw;
        }
      }, index);
      await callOpenAiTool(input.agent, "report", report);
      return { lastResponseId: `participant-${index}` };
    });
    const backend = durableOpenAiWorker({ apiKey: "sk-test", run });
    try {
      for (const [index, audience] of recipients.entries()) {
        const task = participantObservationTask(instruction, audience);
        const report = await runBackend(
          backend,
          routine(task, { id: `observation-${index}` }),
          context(),
          noopRoutineEffects({
            emit: async (message) => {
              emitted.push(outbound(message));
              return gates[emitted.length - 1]!.promise;
            },
          }),
          noopDiagnostics,
        );
        expect(report).toMatchObject({
          outcome: "completed",
          semantic: {
            observations: {
              "observe:answer": { status: "resolved", value: "One/Two" },
            },
          },
        });
      }
      expect(run.mock.calls[1]![0].previousResponseId).toBe("participant-0");
      for (const [index, audience] of recipients.entries()) {
        const prompt = run.mock.calls[index]![0].prompt!;
        expect(prompt).not.toContain("<active-instruction>");
        expect(prompt).toContain(`<audience:${audience}> -> ${audience}`);
        expect(prompt).toContain("participant identified by each question");
        expect(prompt).toContain("Structured audience input: ask_audience");
      }
    } finally {
      gates.forEach((gate) => gate.resolve("Two"));
      await backend.stop();
    }
  });

  it("releases OpenAI bundle copies with their last routine across worker slots", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-bundle-ownership-"));
    workspaces.push(root);
    const bundle = join(root, "source");
    await mkdir(bundle);
    await writeFile(join(bundle, "data.txt"), "owned copy");
    const task = await firstTask();
    const workers = [0, 1].map(
      () =>
        new OpenAiSdkWorker({
          apiKey: "mock",
          run: async (input) => {
            await callOpenAiTool(input.agent, "report", {
              outcome: "completed",
            });
            return { lastResponseId: "response" };
          },
        }),
    );
    try {
      for (let index = 0; index < 20; index++) {
        const cwd = join(root, `workspace-${index}`);
        await mkdir(cwd);
        const ctx = {
          workspacePath: cwd,
          workspaceBundle: { library: bundle },
        };
        const inputs = workers.map((_, slot) => ({
          routine: routine(task, {
            id: `bundle-routine-${slot}-${index}`,
            contextKey: `bundle-context-${slot}-${index}`,
          }),
          context: ctx,
          effects: noopRoutineEffects(),
          diagnostics: noopDiagnostics,
        }));
        for (const [slot, worker] of workers.entries())
          await worker.run(inputs[slot]!);
        const copy = join(cwd, ".arcade-bundles", "library", "data.txt");
        await workers[0]!.disposeRoutine({
          arcRunId: task.arcRunId,
          routineId: inputs[0]!.routine.id,
        });
        expect(await readFile(copy, "utf8")).toBe("owned copy");
        await workers[1]!.disposeRoutine({
          arcRunId: task.arcRunId,
          routineId: inputs[1]!.routine.id,
        });
        await expect(readFile(copy, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        for (const worker of workers)
          expect(probeRetention(worker).bundleRoutines).toBe(0);
        expect(await readFile(join(bundle, "data.txt"), "utf8")).toBe(
          "owned copy",
        );
      }
    } finally {
      for (const worker of workers) await worker.stop();
    }
  });

  it("reuses openai approvals within their deadline and asks again after expiry", async () => {
    const task = await firstTask();
    let asks = 0;
    let sequence = 0;
    const worker = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run: async (input) => {
        expect(
          (
            await input.resolveApproval({
              toolName: "WebFetch",
              input: { url: "https://example.com", prompt: "Read" },
              callId: "grant-test",
            })
          ).decision,
        ).not.toBe("deny");
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
        return { lastResponseId: "grant-response" };
      },
    });
    const invoke = async (arcRunId: string, contextKey: string) => {
      const input = {
        routine: routine(
          { ...task, arcRunId },
          { id: `grant-routine:${++sequence}`, contextKey },
        ),
        context: context(),
        effects: noopRoutineEffects({
          requestPermission: async () => {
            asks++;
            return { decision: "allow_this_run" };
          },
        }),
        diagnostics: noopDiagnostics,
      };
      expect(await worker.run(input)).toMatchObject({ outcome: "completed" });
      await worker.disposeRoutine({ arcRunId, routineId: input.routine.id });
    };
    vi.useFakeTimers();
    try {
      await invoke("run:a", "context");
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await invoke("run:a", "context");
      expect(asks).toBe(1);
      await invoke("run:b", "context");
      expect(asks).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probeRetention(worker)).toMatchObject({
        grantContexts: 1,
        grants: 1,
      });
      await invoke("run:b", "context");
      expect(asks).toBe(2);
      await invoke("run:a", "context");
      expect(asks).toBe(3);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(probeRetention(worker)).toMatchObject({
        grantContexts: 0,
        grants: 0,
      });
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it("resumes the SDK after connection loss without repeating a delivered notification", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text", value: "Notify " },
          { kind: "entity", name: "user" },
          { kind: "text", value: " with Notification." },
        ],
      ],
    };
    let requests = 0;
    const emit = vi.fn(async () => undefined);
    const model: Model = {
      getResponse: async () => {
        throw new Error("Unexpected non-streaming request");
      },
      async *getStreamedResponse(request) {
        requests++;
        if (requests === 2)
          throw Object.assign(new Error("Connection error."), {
            code: "ECONNRESET",
          });
        if (requests === 3) {
          expect(JSON.stringify(request.input)).toContain(
            "function_call_result",
          );
          expect(JSON.stringify(request.input)).toContain("ok");
        }
        const output =
          requests === 1
            ? [
                {
                  type: "function_call" as const,
                  callId: "notify-once",
                  name: "emit_outbound",
                  arguments: JSON.stringify({
                    audience: "originator",
                    content: "Notification",
                  }),
                },
              ]
            : requests === 3
              ? [
                  {
                    type: "function_call" as const,
                    callId: "finish",
                    name: "report",
                    arguments: '{"report":{"outcome":"completed"}}',
                  },
                ]
              : [
                  {
                    type: "message" as const,
                    role: "assistant" as const,
                    status: "completed" as const,
                    content: [{ type: "output_text" as const, text: "" }],
                  },
                ];
        yield {
          type: "response_done",
          response: {
            output,
            usage: {
              requests: 1,
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
            id: `response-${requests}`,
          },
        };
      },
    };
    const originalRun = Runner.prototype.run;
    const spy = vi.spyOn(Runner.prototype, "run").mockImplementation(function (
      this: Runner,
      agent,
      input,
      options,
    ) {
      const executionAgent = new Agent({
        name: agent.name,
        tools: agent.tools,
        model,
      });
      if (
        typeof input === "object" &&
        input !== null &&
        "_currentAgent" in input
      ) {
        expect(input._currentAgent).toBe(agent);
        input._currentAgent = executionAgent;
      }
      return originalRun.call(this, executionAgent, input, options);
    });
    const host = openAiContinuityHost();
    const backend = createOpenAiSdkBackendForTesting({
      apiKey: "test",
      resolveContinuityIdentity: async () =>
        openAiIdentity("https://api.openai.com", "test"),
    });
    const worker = await backend.createWorker(host, {
      backend: "openai-sdk",
      kind: "role",
      role: task.role,
    });
    const input = {
      routine: routine(task),
      context: context(),
      effects: noopRoutineEffects({ emit }),
      diagnostics: noopDiagnostics,
    };
    try {
      await expect(worker.run(input)).resolves.toMatchObject({
        suspension: "transport-lost",
      });
      expect(emit).toHaveBeenCalledTimes(1);
      await expect(worker.run(input)).resolves.toMatchObject({
        outcome: "completed",
      });
      expect(emit).toHaveBeenCalledTimes(1);
      await expect(
        host.state.get(task.arcRunId, input.routine.contextKey),
      ).resolves.toMatchObject({ responseId: "response-4" });
    } finally {
      spy.mockRestore();
      await worker.stop?.();
    }
  });
  it("passes cwd, model, timeout signal, tools, and sandbox config", async () => {
    const workspace = await tempWorkspace("arcade-openai-sdk-workspace-basic");
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 1 },
        lastTurns: [
          { role: "user", message: "Please watch AAPL earnings." },
          { role: "self", message: "I will use the Watch arc." },
        ],
      },
      texts: [
        [
          { kind: "text" as const, value: "Reply to " },
          { kind: "entity" as const, name: "user" },
          { kind: "text" as const, value: " after creating " },
          { kind: "artifact" as const, path: "example.txt" },
          { kind: "text" as const, value: "." },
        ] as const,
      ] as const,
    };
    task.guidance = [
      [
        { kind: "text", value: "Follow " },
        { kind: "artifact", path: "policy.md" },
        { kind: "text", value: "." },
      ],
    ];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-basic", rawResponses: [] };
    });
    const backend = new OpenAiSdkWorker({
      model: "gpt-test",
      timeoutMs: 1234,
      apiKey: "sk-test",
      run,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context({
          workspacePath: workspace,
        }),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });

    const call = run.mock.calls[0]![0];
    expect(call.prompt).toContain('You are working as the "researcher" role.');
    expect(call.prompt).not.toContain("managed workflow");
    expect(call.prompt).toContain("<prior-turns>");
    expect(call.prompt).toContain(
      '<msg by="user" idx="0">Please watch AAPL earnings.</msg>',
    );
    expect(call.prompt).toContain(
      '<msg by="self" idx="1">I will use the Watch arc.</msg>',
    );
    expect(call.prompt).toContain("</prior-turns>");
    expect(call.prompt).toContain(
      "Reply to user after creating /workspace/example.txt.",
    );
    expect(call.prompt).toContain("- user -> originator");
    expect(call.prompt).not.toContain(join(workspace, "example.txt"));
    expect(call.prompt).toContain(
      "<guidance>\nFollow /workspace/policy.md.\n</guidance>",
    );
    expect(call.prompt).toContain("Execute only the current assigned task.");
    expect(call.prompt).toContain(
      "After creating or editing a file, verify that it exists and contains the expected content before reporting completion.",
    );
    expect(call.prompt).not.toContain("current Arc instruction task");
    expect(call.prompt).toContain("Do not create, edit, delete, or move");
    expect(call.prompt).toContain(
      "without applying document changes unless the same instruction explicitly asks",
    );
    expect(call.prompt).toContain(
      "When the instruction requires delivery to an audience listed above",
    );
    expect(call.prompt).toContain(
      "Plain assistant text does not deliver that content.",
    );
    expect(call.prompt).toContain(
      "Do not copy an audience marker into delivered content or question text.",
    );
    expect(call.prompt).not.toContain("Do not report completed");
    expect(call.prompt).not.toContain("deflected");
    expect(call.apiKey).toBe("sk-test");
    expect(call.baseUrl).toBeUndefined();
    expect(call.abortController.signal).toBeDefined();
    expect(call.maxTurns).toBe(24);
    expect(call.previousResponseId).toBeUndefined();
    expect(call.agent.model).toBe("gpt-test");
    const systemInstructions = String((call.agent as any).instructions);
    expect(systemInstructions).toContain("Apply standing guidance");
    expect(systemInstructions).toContain(
      "Treat <instruction>, when present, as the complete authority",
    );
    expect(systemInstructions).toContain(
      "Treat <rules> as the execution contract",
    );
    expect(systemInstructions).toContain(
      "No audience input is required: use emit_outbound",
    );
    expect(systemInstructions).toContain(
      "Input must be captured and validated structurally",
    );
    expect(systemInstructions).toContain(
      "Input is required without structural constraints: use discuss",
    );
    expect(systemInstructions).toContain(
      "Delivery and input collection are separate obligations",
    );
    expect(systemInstructions).toContain(
      "Audience-input tools return the audience's answer as their tool result",
    );
    expect(systemInstructions).toContain(
      'call report with outcome "completed"',
    );
    expect(systemInstructions).not.toContain("deflected");
    expect(systemInstructions).not.toMatch(/\broutine\b/i);
    expect(call.agent.tools.map((tool) => tool.name).sort()).toEqual([
      "ask_audience",
      "discuss",
      "emit_outbound",
      "report",
    ]);
    const managedToolDescriptions = Object.fromEntries(
      call.agent.tools.map((tool) => [
        tool.name,
        (tool as { description?: string }).description ?? "",
      ]),
    );
    expect(managedToolDescriptions.emit_outbound).toContain(
      'returns {"ok":true} immediately',
    );
    expect(managedToolDescriptions.discuss).toContain(
      "optional question adds a discussion prompt",
    );
    expect(managedToolDescriptions.discuss).toContain(
      'returns {"answer":"..."}',
    );
    expect(managedToolDescriptions.ask_audience).toContain(
      'returns {"answers":{...}}',
    );
    expect(managedToolDescriptions.report).toContain("assigned task");
    expect(managedToolDescriptions.report).not.toContain("deflected");
    expect(Object.values(managedToolDescriptions).join(" ")).not.toMatch(
      /\broutine\b/i,
    );
    expect(call.sandboxClient.backendId).toBe("unix_local");
    expect((call.agent as any).defaultManifest).toBeUndefined();
  });

  it("advertises only canonical OpenAI report variants", async () => {
    const task = await firstTask();
    let parameters: unknown;
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const reportTool = input.agent.tools.find(
        (candidate) => candidate.name === "report",
      );
      parameters = (reportTool as { parameters?: unknown } | undefined)
        ?.parameters;
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-report-schema" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

    await expect(
      runBackend(
        backend,
        routine(task),
        context(),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });

    const schema = fromJSONSchema(parameters as Record<string, unknown>);
    expect(schema.safeParse({ report: { outcome: "completed" } }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({
        report: { error: "failed", code: "failed", message: "failed" },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ report: { outcome: "completed", semantic: {} } })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ report: { outcome: "deflected" } }).success).toBe(
      false,
    );
  });

  it("preserves an authored interaction prohibition in the OpenAI prompt", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        "Do not ask the originator any questions. Complete autonomously.",
      ],
    };
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-authored-prohibition" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(run.mock.calls[0]![0].prompt).toContain(
      "Do not ask the originator any questions. Complete autonomously.",
    );
    expect(String((run.mock.calls[0]![0].agent as any).instructions)).toContain(
      "Follow every explicit requirement or prohibition in <instruction>",
    );
  });

  it("keeps discretionary originator access in an open OpenAI prompt", async () => {
    const task = await firstTask();
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-open-interaction" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(String((run.mock.calls[0]![0].agent as any).instructions)).toContain(
      "For each audience interaction, determine what input the current task requires",
    );
    expect(run.mock.calls[0]![0].prompt).not.toContain("Audience references:");
    expect(run.mock.calls[0]![0].prompt).toContain(
      "No audience references are available for this task. Keep one-way output private.",
    );
  });

  it("primes the dialog only on the first prompt into a threaded session", async () => {
    const workspace = await tempWorkspace("arcade-openai-dialog-prime");
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 1 },
        lastTurns: [
          { role: "user", message: "Please watch AAPL earnings." },
          { role: "self", message: "I will use the Watch arc." },
        ],
      },
    };
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-thread", rawResponses: [] };
    });
    const backend = durableOpenAiWorker({
      model: "gpt-test",
      apiKey: "sk-test",
      run,
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

    expect(run.mock.calls[0]![0].previousResponseId).toBeUndefined();
    expect(run.mock.calls[0]![0].prompt).toContain("<prior-turns>");
    expect(run.mock.calls[1]![0].previousResponseId).toBe("resp-thread");
    expect(run.mock.calls[1]![0].prompt).not.toContain("<prior-turns>");
  });

  it("gives node-isolated instructions independent response chains", async () => {
    const workspace = await tempWorkspace("arcade-openai-node-isolation");
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
    let responseOrdinal = 0;
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      responseOrdinal += 1;
      return {
        lastResponseId: `resp-${responseOrdinal}`,
        rawResponses: [],
      };
    });
    const backend = durableOpenAiWorker({
      apiKey: "sk-test",
      run,
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

    expect(run.mock.calls.map(([call]) => call.previousResponseId)).toEqual([
      undefined,
      undefined,
      "resp-1",
    ]);
    expect(run.mock.calls[0]![0].prompt).toContain("<prior-turns>");
    expect(run.mock.calls[1]![0].prompt).toContain("<prior-turns>");
    expect(run.mock.calls[2]![0].prompt).not.toContain("<prior-turns>");
    expect(first.role).toBe(sibling.role);
  });

  it("passes baseUrl to the OpenAI run function", async () => {
    const workspace = await tempWorkspace("arcade-openai-sdk-base-url");
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-base-url" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      baseUrl: "https://openai-compatible.example.com/v1",
      run,
    });

    await expect(
      runBackend(
        backend,
        routine(await firstTask()),
        context({ workspacePath: workspace }),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });

    expect(run.mock.calls[0]![0].baseUrl).toBe(
      "https://openai-compatible.example.com/v1",
    );
  });

  it("roots the sandbox session at the workspace without leaking the host path", async () => {
    const workspace = await tempWorkspace("arcade-openai-sdk-workspace-root");
    const task = await firstTask();
    const pwdOutputs: string[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const session = await input.sandboxClient.create!();
      try {
        // The workspace is the sandbox root named /workspace, so pwd must mask to
        // /workspace — never the host path — even when a workdir is passed (the
        // leak channel), and the masked path round-trips as a workdir.
        const pwd = await session.exec!({ cmd: "pwd", workdir: "/workspace" });
        pwdOutputs.push(pwd.stdout.trim());
        await session.exec!({
          cmd: "printf mounted > /workspace/openai-sdk.txt",
        });
      } finally {
        await session.close!();
      }
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-mount" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
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
    // Writes under /workspace persist into the real workspace dir.
    await expect(
      readFile(join(workspace, "openai-sdk.txt"), "utf8"),
    ).resolves.toBe("mounted");
    expect(pwdOutputs).toEqual(["/workspace"]);
    expect(pwdOutputs[0]).not.toContain(workspace);
  });

  it("roots the sandbox session at the resolved workspace from RoutineContext", async () => {
    const task = await firstTask();
    const workspacePath = await tempWorkspace("arcade-openai-sdk-context-root");
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const session = await input.sandboxClient.create!();
      try {
        await session.exec!({
          cmd: "printf rooted > /workspace/context-root.txt",
        });
      } finally {
        await session.close!();
      }
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-routine" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
    });

    await runBackend(
      backend,
      routine(task),
      context({ workspacePath }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    // A root write lands in the RoutineContext workspace dir.
    await expect(
      readFile(join(workspacePath, "context-root.txt"), "utf8"),
    ).resolves.toBe("rooted");
  });

  it("renders active instruction cells in semantic prompts", async () => {
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:cells",
      role: "researcher",
      stage: "action",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "Judge the LITE scope." }],
      },
      requests: [
        {
          kind: "judgment",
          briefId: "judge:1",
          role: "researcher",
          question: "Does the active instruction satisfy the ticker scope?",
          sourceRef: "node:test:Action",
          tool: {
            type: "function",
            name: "arc_judgment_1",
            description: "Resolve judgment.",
            parameters: { type: "object" },
            strict: true,
          },
        },
      ],
      activeInstruction: {
        kind: "instruction",
        allowedDispositions: [],
        briefIds: ["instruction:active"],
        role: "researcher",
        texts: [
          [
            { kind: "text", value: "Research the scoped company and tell " },
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
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      });
      return { lastResponseId: "resp-semantic-cells" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context(),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });

    const call = run.mock.calls[0]![0];
    expect(call.prompt).toContain("<prior-turns>");
    expect(call.prompt).toContain(
      '<msg by="user" idx="0">Judge the LITE scope.</msg>',
    );
    expect(call.prompt).not.toContain("<instruction>");
    const activeInstruction = JSON.parse(
      call.prompt!.match(
        /<active-instruction>\n([\s\S]*?)\n<\/active-instruction>/,
      )![1]!,
    );
    expect(activeInstruction).toMatchObject({
      phase: "postcheck",
      text: expect.stringContaining("tell user the result"),
      audienceReferences: [{ marker: "user", audience: "originator" }],
    });
    expect(call.agent.instructions).toContain(
      "Treat <active-instruction> as reference context for <semantic-requests>",
    );
    expect(call.agent.instructions).toContain(
      "without repeating its work or audience interactions",
    );
    expect(call.agent.instructions).toContain(
      "For each audience interaction, determine what input the current task requires",
    );
    expect(call.agent.instructions).toContain(
      "An input obligation is satisfied when that result is received",
    );
    expect(call.prompt).toContain(
      "For observeOrAsk, collect missing information from the participant identified by each question",
    );
    expect(call.prompt).toContain(
      'For observe, use "unknown" when the value cannot be determined, without asking a participant',
    );
    expect(call.prompt).toContain('"cells"');
    expect(call.prompt).toContain('"ticker": "LITE"');
  });

  it("resumes only when the stored cwd matches the new cwd", async () => {
    const task = await firstTask();
    const firstWorkspace = await tempWorkspace("arcade-openai-sdk-resume-1");
    const secondWorkspace = await tempWorkspace("arcade-openai-sdk-resume-2");
    let runCount = 0;
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      runCount += 1;
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: `resp-${runCount}` };
    });
    const backend = durableOpenAiWorker({
      apiKey: "sk-test",
      run,
    });

    await runBackend(
      backend,
      routine(task, { id: "routine-1" }),
      context({ workspacePath: firstWorkspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(task, { id: "routine-2" }),
      context({ workspacePath: firstWorkspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(task, { id: "routine-3" }),
      context({ workspacePath: secondWorkspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(run.mock.calls[0]![0].previousResponseId).toBeUndefined();
    expect(run.mock.calls[1]![0].previousResponseId).toBe("resp-1");
    expect(run.mock.calls[2]![0].previousResponseId).toBeUndefined();
  });

  it("starts a fresh OpenAI response chain when deflected re-entry advances the context epoch", async () => {
    const workspace = await tempWorkspace(
      "arcade-openai-sdk-deflected-reentry-epoch",
    );
    const task: InstructionTask = {
      ...(await firstTask()),
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "Re-enter with this history." }],
      },
    };
    let ordinal = 0;
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      ordinal += 1;
      return { lastResponseId: `response-${ordinal}` };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

    await runBackend(
      backend,
      routine(task, { contextKey: workerContextKey(task, 0) }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    await runBackend(
      backend,
      routine(task, { contextKey: workerContextKey(task, 1) }),
      context({ workspacePath: workspace }),
      noopRoutineEffects(),
      noopDiagnostics,
    );

    expect(run.mock.calls[1]![0].previousResponseId).toBeUndefined();
    expect(run.mock.calls[1]![0].prompt).toContain("<prior-turns>");
    expect(run.mock.calls[1]![0].prompt).toContain(
      "Re-enter with this history.",
    );
  });

  it("parks a paused streamed run and resumes with native RunState", async () => {
    const workspace = await tempWorkspace("arcade-openai-sdk-workspace-park");
    const task = await firstTask();
    const parkedState = {
      _currentTurnInProgress: false,
    } as OpenAiRunState;
    let paused = false;
    const effects = noopRoutineEffects({
      checkSignal: async () => (paused ? { kind: "pause" } : undefined),
    });
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      if (run.mock.calls.length === 1) {
        expect(await input.checkSignal()).toBeUndefined();
        paused = true;
        expect(await input.checkSignal()).toEqual({ kind: "pause" });
        input.abortController.abort();
        return {
          signal: { kind: "pause" },
          cancelled: true,
          state: parkedState,
        };
      }
      expect(input.resumeState).toBe(parkedState);
      expect(input.prompt).toBeUndefined();
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-native-resume", state: parkedState };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
    });

    await expect(
      runBackend(
        backend,
        routine(task),
        context({ workspacePath: workspace }),
        effects,
        noopDiagnostics,
      ),
    ).resolves.toMatchObject({ suspension: "paused" });

    await expect(
      backend.run(
        {
          routine: routine(task),
          context: context({ workspacePath: workspace }),
          effects: noopRoutineEffects(),
          diagnostics: noopDiagnostics,
        },
        { delivery: "native" },
      ),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("attempts one recovery turn when report is missing", async () => {
    const task = await firstTask();
    const emit = vi.fn(async () => "unused");
    const { logger, records } = createCapturingLogger("info");
    let runCount = 0;
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      runCount += 1;
      if (runCount === 2) {
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      }
      return { lastResponseId: `resp-${runCount}` };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
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
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].prompt).toContain("required report tool");
    expect(run.mock.calls[1]![0].prompt).toContain(
      "If every obligation is complete, call report.",
    );
    expect(run.mock.calls[1]![0].prompt).toContain(
      'call report with error "failed"',
    );
    expect(run.mock.calls[1]![0].prompt).toContain("private worker memory");
    expect(run.mock.calls[1]![0].prompt).toContain(
      "Use the report tool schema for this assignment.",
    );
    expect(run.mock.calls[1]![0].prompt).toContain(
      'Do not include code or message with outcome "completed"',
    );
    expect(run.mock.calls[1]![0].prompt).toContain(
      "follow the shared audience-interaction policy",
    );
    expect(run.mock.calls[1]![0].prompt).toContain(
      "interaction tool returns its result",
    );
    expect(run.mock.calls[1]![0].prompt).toContain(
      "Continue the same assigned work",
    );
    expect(run.mock.calls[1]![0].previousResponseId).toBe("resp-1");
    expect(emit).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "backend.openai_sdk.missing_report_recovery",
        attempt: 1,
      }),
    );
  });

  it("can ask a question during OpenAI missing-report recovery", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    let runCount = 0;
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      runCount += 1;
      if (runCount === 2) {
        await expect(
          callOpenAiTool(input.agent, "discuss", {
            question: "Should recovery continue?",
          }),
        ).resolves.toEqual({ answer: "Continue" });
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      }
      return { lastResponseId: `resp-recovery-question-${runCount}` };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

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

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0].previousResponseId).toBe(
      "resp-recovery-question-1",
    );
    expect(emitted).toEqual([
      expect.objectContaining({
        content: "Should recovery continue?",
        situation: expect.objectContaining({ cause: "question" }),
      }),
    ]);
  });

  it("logs terminal OpenAI missing-report recovery failure", async () => {
    const task = await firstTask();
    const emit = vi.fn(async () => "unused");
    const { logger, records } = createCapturingLogger("info");
    const run = vi.fn<OpenAiSdkRunFn>(async () => ({
      lastResponseId: "resp-missing-report",
    }));
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
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

    expect(run).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalled();
    expect(records).toContainEqual(
      expect.objectContaining({
        event: "backend.openai_sdk.missing_report_failed",
        attempts: 1,
      }),
    );
  });

  it("routes emit_outbound and audience questions through RoutineContext", async () => {
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
    const workEvents: Array<Record<string, unknown>> = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "emit_outbound", {
        audience: "supervisor",
        content: "Status update",
      });
      await callOpenAiTool(input.agent, "emit_outbound", {
        audience: "supervisor",
        content: "Second update",
      });
      const answer = await callOpenAiTool(input.agent, "ask_audience", {
        audience: "supervisor",
        questions: [
          {
            question: "Approve this plan?",
            header: "Approval",
            options: [
              { label: "Approve", description: "Approve the plan." },
              { label: "Reject", description: "Reject the plan." },
            ],
            multiSelect: false,
          },
          {
            question: "Which scopes?",
            header: "Scopes",
            options: [
              { label: "Config", description: "Config only." },
              { label: "Backend", description: "Backend only." },
            ],
            multiSelect: true,
          },
        ],
      });
      expect(answer).toEqual({
        answers: {
          "Approve this plan?": "Approve",
          "Which scopes?": ["Config", "Backend"],
        },
      });
      await callOpenAiTool(input.agent, "report", {
        outcome: "completed",
      });
      return { lastResponseId: "resp-tools" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return JSON.stringify({
            Approval: "Approve",
            "Which scopes?": ["Config", "Backend"],
          });
        },
        logToolEvent: async (event) => {
          workEvents.push(event);
          return {
            id: `work-event:${workEvents.length}`,
            arcRunId: ARC_RUN_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            routineId: "routine-1",
            role: "researcher",
            backend: "openai-sdk",
            nodeName: "Watch",
            ...event,
          } as any;
        },
      }),
      noopDiagnostics,
    );

    expect(emitted).toHaveLength(3);
    expect(emitted[0]).toMatchObject({
      situation: { audience: "supervisor", cause: "reply" },
      content: "Status update",
    });
    expect(emitted[1]).toMatchObject({
      situation: { audience: "supervisor", cause: "reply" },
      content: "Second update",
    });
    expect(emitted[2]).toMatchObject({
      situation: { audience: "supervisor", cause: "question" },
      metadata: { toolCallId: expect.any(String) },
      content: {
        kind: "question-form",
        questions: [
          expect.objectContaining({
            question: "Approve this plan?",
            takesOtherAnswer: true,
          }),
          expect.objectContaining({
            question: "Which scopes?",
            takesOtherAnswer: true,
          }),
        ],
      },
    });
    expect(workEvents).toEqual([
      expect.objectContaining({
        kind: "tool:started",
        toolName: "emit_outbound",
        toolCallId: expect.any(String),
      }),
      expect.objectContaining({
        kind: "tool:finished",
        toolName: "emit_outbound",
        toolCallId: expect.any(String),
        outcome: "sent",
      }),
      expect.objectContaining({
        kind: "tool:started",
        toolName: "emit_outbound",
        toolCallId: expect.any(String),
      }),
      expect.objectContaining({
        kind: "tool:finished",
        toolName: "emit_outbound",
        toolCallId: expect.any(String),
        outcome: "sent",
      }),
      expect.objectContaining({
        kind: "tool:started",
        toolName: "ask_audience",
        toolCallId: expect.any(String),
      }),
      expect.objectContaining({
        kind: "tool:finished",
        toolName: "ask_audience",
        toolCallId: expect.any(String),
        outcome: "answered",
      }),
    ]);
    const toolCallIds = workEvents.map((event) => event.toolCallId);
    expect(toolCallIds[0]).toBe(toolCallIds[1]);
    expect(toolCallIds[2]).toBe(toolCallIds[3]);
    expect(toolCallIds[4]).toBe(toolCallIds[5]);
    expect(new Set([toolCallIds[0], toolCallIds[2], toolCallIds[4]]).size).toBe(
      3,
    );
    expect(emitted[2]?.metadata).toMatchObject({
      toolCallId: toolCallIds[4],
    });
  });

  it("routes a freeform OpenAI question and returns its exact answer", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await expect(
        callOpenAiTool(input.agent, "discuss", {
          question: "  What should change?  ",
        }),
      ).resolves.toEqual({
        answer: "Change the API",
      });
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-freeform-question" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

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

  it("routes a promptless OpenAI discussion and waits for feedback on existing audience-visible context", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await expect(callOpenAiTool(input.agent, "discuss", {})).resolves.toEqual(
        {
          answer: "Continue",
        },
      );
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-promptless-discussion" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

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
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "question",
        },
        content: "",
        metadata: { toolCallId: expect.any(String) },
      }),
    ]);
  });

  it("routes an authorized non-originator freeform OpenAI question", async () => {
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
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await expect(
        callOpenAiTool(input.agent, "discuss", {
          audience: "supervisor",
          question: "What should change?",
        }),
      ).resolves.toEqual({ answer: "Change the API" });
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-freeform-supervisor" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

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

  it("rejects invalid OpenAI discussion and audience inputs", async () => {
    const task = await firstTask();
    const emitted: OutboundMessage[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      for (const invalid of [{ question: "" }, { question: "   " }]) {
        const failure = await callOpenAiToolRaw(
          input.agent,
          "discuss",
          invalid,
        );
        expect(String(failure)).toContain("discuss input");
      }
      const audienceFailure = await callOpenAiToolRaw(
        input.agent,
        "ask_audience",
        {},
      );
      expect(String(audienceFailure)).toContain("ask_audience input");
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-invalid-question-variants" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

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

  it("normalizes the user audience marker to originator for ask_audience", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text" as const, value: "Ask " },
          { kind: "entity" as const, name: "user" },
          { kind: "text" as const, value: " for a token." },
        ] as const,
      ],
    };
    const emitted: OutboundMessage[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const answer = await callOpenAiTool(input.agent, "ask_audience", {
        audience: "user",
        questions: [
          {
            question: "What token should I record?",
            header: "Question",
            options: [
              { label: "Provide token", description: "Provide the token." },
              { label: "No token", description: "No token is available." },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(answer).toMatchObject({
        answers: { "What token should I record?": "token-123" },
      });
      await callOpenAiTool(input.agent, "report", {
        outcome: "completed",
      });
      return { lastResponseId: "resp-question-user" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async (message) => {
          emitted.push(outbound(message));
          return "token-123";
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
      }),
    ]);
  });

  it("rejects ask_audience to an audience the instruction did not name", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: ["Answer the user privately."],
    };
    const emitted: OutboundMessage[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const failure = await callOpenAiToolRaw(input.agent, "ask_audience", {
        audience: "supervisor",
        questions: [
          {
            question: "Approve this plan?",
            header: "Approval",
            options: [
              { label: "Approve", description: "Approve the proposed plan." },
              { label: "Reject", description: "Reject the proposed plan." },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(String(failure)).toContain(
        'Question audience "supervisor" is not named by the current task',
      );
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-rejected-question" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

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

    expect(emitted).toEqual([]);
  });

  it("defaults an OpenAI structured question to originator", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: ["Answer the user privately."],
    };
    const emitted: OutboundMessage[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const answer = await callOpenAiTool(input.agent, "ask_audience", {
        questions: [
          {
            question: "Approve this plan?",
            header: "Approval",
            options: [
              { label: "Approve", description: "Approve the proposed plan." },
              { label: "Reject", description: "Reject the proposed plan." },
            ],
            multiSelect: false,
          },
        ],
      });
      expect(answer).toMatchObject({
        answers: { "Approve this plan?": "Approve" },
      });
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-originator-question" };
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

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
          audience: "originator",
          cause: "question",
        }),
      }),
    ]);
  });

  it("ignores emit_outbound when the instruction has no named audience", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: ["Show exactly this private update."],
    };
    const emitted: OutboundMessage[] = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const result = await callOpenAiTool(input.agent, "emit_outbound", {
        audience: "originator",
        content: "Private update",
      });
      expect(result).toEqual({ ok: true });
      await callOpenAiTool(input.agent, "report", {
        outcome: "completed",
      });
      return { lastResponseId: "resp-ignored-outbound" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
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

    expect(emitted).toEqual([]);
  });

  it("logs surface-failed when emit_outbound cannot be surfaced", async () => {
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
          { kind: "text" as const, value: "." },
        ] as const,
      ],
    };
    const workEvents: Array<Record<string, unknown>> = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const failure = await callOpenAiToolRaw(input.agent, "emit_outbound", {
        audience: "supervisor",
        content: "Status update",
      });
      expect(String(failure)).toContain(
        "Failed to surface outbound message: transport down",
      );
      await callOpenAiTool(input.agent, "report", {
        outcome: "completed",
      });
      return { lastResponseId: "resp-surface-failed" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async () => {
          throw new Error("transport down");
        },
        logToolEvent: async (event) => {
          workEvents.push(event);
          return {
            id: `work-event:${workEvents.length}`,
            arcRunId: ARC_RUN_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            routineId: "routine-1",
            role: "researcher",
            backend: "openai-sdk",
            nodeName: "Watch",
            ...event,
          } as any;
        },
      }),
      noopDiagnostics,
    );

    expect(workEvents).toEqual([
      expect.objectContaining({
        kind: "tool:started",
        toolName: "emit_outbound",
        toolCallId: expect.any(String),
      }),
      expect.objectContaining({
        kind: "tool:failed",
        toolName: "emit_outbound",
        toolCallId: expect.any(String),
        error: expect.objectContaining({ code: "surface-failed" }),
      }),
    ]);
    expect(workEvents[0]?.toolCallId).toBe(workEvents[1]?.toolCallId);
  });

  it("logs result-invalid for malformed multi-question answers", async () => {
    const task: InstructionTask = {
      ...(await firstTask()),
      texts: [
        [
          { kind: "text" as const, value: "Ask " },
          {
            kind: "hostVar" as const,
            module: "audience",
            path: ["supervisor"],
          },
          { kind: "text" as const, value: " two questions." },
        ] as const,
      ],
    };
    const workEvents: Array<Record<string, unknown>> = [];
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      const failure = await callOpenAiToolRaw(input.agent, "ask_audience", {
        audience: "supervisor",
        questions: [
          {
            question: "Approve this plan?",
            header: "Approval",
            options: [
              { label: "Approve", description: "Approve the plan." },
              { label: "Reject", description: "Reject the plan." },
            ],
            multiSelect: false,
          },
          {
            question: "Which scopes?",
            header: "Scopes",
            options: [
              { label: "Config", description: "Config only." },
              { label: "Backend", description: "Backend only." },
            ],
            multiSelect: true,
          },
        ],
      });
      expect(String(failure)).toContain(
        "Multiple-question answers must be a JSON object",
      );
      await callOpenAiTool(input.agent, "report", {
        outcome: "completed",
      });
      return { lastResponseId: "resp-invalid-answer" };
    });
    const backend = new OpenAiSdkWorker({
      apiKey: "sk-test",
      run,
    });

    await runBackend(
      backend,
      routine(task),
      context(),
      noopRoutineEffects({
        emit: async () => "unstructured answer",
        logToolEvent: async (event) => {
          workEvents.push(event);
          return {
            id: `work-event:${workEvents.length}`,
            arcRunId: ARC_RUN_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            routineId: "routine-1",
            role: "researcher",
            backend: "openai-sdk",
            nodeName: "Watch",
            ...event,
          } as any;
        },
      }),
      noopDiagnostics,
    );

    expect(workEvents).toEqual([
      expect.objectContaining({
        kind: "tool:started",
        toolName: "ask_audience",
        toolCallId: expect.any(String),
      }),
      expect.objectContaining({
        kind: "tool:failed",
        toolName: "ask_audience",
        toolCallId: expect.any(String),
        error: expect.objectContaining({ code: "result-invalid" }),
      }),
    ]);
    expect(workEvents[0]?.toolCallId).toBe(workEvents[1]?.toolCallId);
  });

  it("rethrows backend failures unwrapped even after observing usage", async () => {
    // Regression guard: usage capture reports through `effects.recordTokenUsage`
    // and must never wrap thrown errors. Here the primary run yields usage and the
    // recovery run throws, so wrapping would be tempting — the original error
    // identity must still survive.
    const task = await firstTask();
    const recoveryFailure = new Error("recovery failed");
    const run = vi.fn<OpenAiSdkRunFn>(async () => {
      if (run.mock.calls.length === 1) {
        return {
          lastResponseId: "resp-usage",
          runContext: {
            usage: {
              requests: 1,
              inputTokens: 9,
              outputTokens: 3,
              totalTokens: 12,
            },
          },
        };
      }
      throw recoveryFailure;
    });
    const backend = new OpenAiSdkWorker({ apiKey: "sk-test", run });

    await expect(
      runBackend(
        backend,
        routine(task),
        context(),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).rejects.toBe(recoveryFailure);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("OpenAI SDK worker adapter continuity", () => {
  it("resumes OpenAI from role-slot worker state only when cwd and continuity identity match", async () => {
    const host = openAiContinuityHost();
    const task = await firstTask();
    await runOpenAiWorker(
      host,
      task,
      vi.fn<OpenAiSdkRunFn>(async (input) => {
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
        return { lastResponseId: "response-durable" };
      }),
      async () => openAiIdentity("https://api.openai.com", "scope-a"),
      "routine:first",
    );
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "response-next" };
    });

    await runOpenAiWorker(
      host,
      task,
      run,
      async () => openAiIdentity("https://api.openai.com", "scope-a"),
      "routine:second",
    );

    expect(run.mock.calls[0]?.[0].previousResponseId).toBe("response-durable");
  });

  it("keeps OpenAI continuity readable after a later worker exception", async () => {
    const host = openAiContinuityHost();
    const task = await firstTask();
    const failure = new Error("recovery failed after response observation");
    const run = vi.fn<OpenAiSdkRunFn>(async () => {
      if (run.mock.calls.length === 1) {
        return { lastResponseId: "response-before-exception" };
      }
      throw failure;
    });

    await expect(
      runOpenAiWorker(
        host,
        task,
        run,
        async () => openAiIdentity("https://api.openai.com", "scope-a"),
        "routine:exception",
      ),
    ).rejects.toBe(failure);
    await expect(
      host.state.get(task.arcRunId, workerContextKey(task, 0)),
    ).resolves.toMatchObject({
      schema: 1,
      responseId: "response-before-exception",
      identity: openAiIdentity("https://api.openai.com", "scope-a"),
    });
  });

  it("starts OpenAI fresh when its endpoint or credential scope identity changes", async () => {
    const task = await firstTask();
    for (const changed of [
      openAiIdentity("https://other.openai.test", "scope-a"),
      openAiIdentity("https://api.openai.com", "scope-b"),
    ]) {
      const host = openAiContinuityHost();
      await runOpenAiWorker(
        host,
        task,
        vi.fn<OpenAiSdkRunFn>(async (input) => {
          await callOpenAiTool(input.agent, "report", {
            outcome: "completed",
          });
          return { lastResponseId: "response-old-identity" };
        }),
        async () => openAiIdentity("https://api.openai.com", "scope-a"),
        "routine:first",
      );
      const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
        return { lastResponseId: "response-fresh" };
      });

      await runOpenAiWorker(
        host,
        task,
        run,
        async () => changed,
        "routine:second",
      );

      expect(run.mock.calls[0]?.[0].previousResponseId).toBeUndefined();
    }
  });
});

async function runOpenAiWorker(
  host: WorkerHost,
  task: InstructionTask,
  run: OpenAiSdkRunFn,
  resolveContinuityIdentity: () => Promise<{
    schema: 1;
    provider: string;
    endpoint: string;
    credentialScope: string;
  }>,
  routineId: string,
): Promise<void> {
  const backend = createOpenAiSdkBackendForTesting({
    apiKey: "sk-not-persisted",
    run,
    resolveContinuityIdentity,
  });
  const worker = await backend.createWorker(host, {
    backend: "openai-sdk",
    kind: "role",
    role: task.role,
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
  await worker.run(input);
}

function openAiContinuityHost(): WorkerHost {
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

function openAiIdentity(endpoint: string, credentialScope: string) {
  return {
    schema: 1 as const,
    provider: "openai",
    endpoint,
    credentialScope,
  };
}

async function callOpenAiTool(
  agent: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<any> {
  const result = await callOpenAiToolRaw(agent, name, input);
  return typeof result === "string" ? JSON.parse(result) : result;
}

async function callOpenAiToolRaw(
  agent: unknown,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tools = (agent as { tools: { name: string; invoke: Function }[] })
    .tools;
  const fn = tools.find((tool) => tool.name === name);
  if (!fn) throw new Error(`tool not found: ${name}`);
  return await fn.invoke(
    {} as any,
    JSON.stringify(name === "report" ? { report: input } : input),
    {},
  );
}

/**
 * Kept local rather than shared: the Claude SDK suite's `context` defaults to
 * its own temp directory, and merging the two would make both suites write into
 * the same workspace.
 */
/** Create a unique workspace directory that is removed after the test. */
async function tempWorkspace(prefix: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `${prefix}-`));
  workspaces.push(workspace);
  return workspace;
}

function context(
  opts: {
    workspacePath?: string;
    workspaceBundle?: Record<string, string>;
    routineResume?: RoutineContext["routineResume"];
  } = {},
): RoutineContext {
  return {
    workspacePath:
      opts.workspacePath ?? join(tmpdir(), "arcade-openai-sdk-context"),
    workspaceBundle: opts.workspaceBundle ?? {},
    routineResume: opts.routineResume,
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

function durableOpenAiWorker(
  options: ConstructorParameters<typeof OpenAiSdkWorker>[0],
) {
  return new OpenAiSdkWorker(
    options,
    createContinuityPreparation({
      backend: "openai-sdk",
      host: openAiContinuityHost(),
      slot: { kind: "default", backend: "openai-sdk" },
      configuredCwd: options.cwd,
      continuityField: "responseId",
      resolveIdentity: async () => openAiIdentity("test", "test"),
    }),
  );
}
