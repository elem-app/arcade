import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ObservationMeta } from "@elem-app/arc/runtime";
import { describe, expect, it, vi } from "vitest";
import { fromJSONSchema } from "zod/v4";

import type { RoutineDescriptor } from "../src/index.js";
import {
  ClaudeSdkTstWorker,
  DEFAULT_CLAUDE_SDK_TST_MODEL,
  createFileRoutineDiagnostics,
  noopRoutineEffects,
  probeRetention,
  routinePathSegment,
  type ClaudeSdkTstQueryFn,
  type ClaudeSdkTstStartupFn,
  type InstructionTask,
  type SemanticTask,
  type Task,
} from "../src/testing.js";
import {
  cwdContext as context,
  noopDiagnostics,
  runBackend,
  sdkTextMessages as sdkMessages,
  semanticTool,
} from "./backend-helpers.js";
import { deferred } from "./helpers.js";

describe("ClaudeSdkTstWorker", () => {
  it("admits composite and grouped observations through the Claude trigger output schema", async () => {
    const meta: ObservationMeta = {
      type: "struct",
      fields: {
        destination: { question: "where to?", meta: { type: "string" } },
        stops: {
          question: "which stops?",
          meta: {
            type: "array",
            element: {
              type: "struct",
              fields: {
                nights: { question: "how long?", meta: { type: "number" } },
              },
            },
          },
        },
      },
    };
    const value = { destination: "Kyoto", stops: [{ nights: 2 }] };
    const task = observationTask();
    task.requests = [
      {
        ...task.requests[0]!,
        kind: "observation",
        cell: "trip",
        mode: "observe",
        question: "the trip",
        meta,
      },
      {
        kind: "observation-group",
        briefId: "observe:group",
        role: "default",
        mode: "observe",
        tool: semanticTool(),
        sourceRef: "node:test:Main",
        fields: [
          {
            cell: "trips",
            question: "the trips",
            meta: { type: "array", element: meta },
          },
          {
            cell: "tags",
            question: "the tags",
            meta: { type: "array", element: { type: "string" } },
          },
          { cell: "missing", question: "unknown?", meta: { type: "string" } },
        ],
      },
    ];
    const report = {
      outcome: "completed",
      semantic: {
        observations: {
          "observe:1": { status: "resolved", value },
          "observe:group": {
            fields: {
              trips: { status: "resolved", value: [value] },
              tags: { status: "resolved", value: ["holiday"] },
              missing: { status: "unknown" },
            },
          },
        },
      },
    };
    const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) => {
      const format = params.options?.outputFormat;
      if (format?.type !== "json_schema")
        throw new Error("expected output schema");
      const schema = fromJSONSchema(format.schema);
      expect(schema.safeParse({ report }).success).toBe(true);
      const withObservation = (outcome: unknown) => ({
        report: {
          outcome: "completed",
          semantic: {
            observations: {
              ...report.semantic.observations,
              "observe:1": outcome,
            },
          },
        },
      });
      expect(
        schema.safeParse(withObservation({ status: "unknown" })).success,
      ).toBe(true);
      for (const outcome of [
        { status: "resolved" },
        { status: "unknown", value },
        { status: "needs-user", value },
      ]) {
        expect(schema.safeParse(withObservation(outcome)).success).toBe(false);
      }
      return sdkMessages(JSON.stringify({ report }));
    });
    const backend = new ClaudeSdkTstWorker({
      fastStarts: { enabled: false },
      query: query as unknown as ClaudeSdkTstQueryFn,
    });
    await expect(runSemantic(backend, task)).resolves.toMatchObject(report);
    expect(query).toHaveBeenCalledOnce();
    await backend.stop();
  });

  it("retires prepared Claude trigger starts when the requested report schema changes", async () => {
    const starts: Array<{ close: ReturnType<typeof vi.fn>; schema: unknown }> =
      [];
    const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) => {
      const observation = String(params.prompt).includes('"observe:1"');
      return sdkMessages(
        JSON.stringify({
          report: {
            outcome: "completed",
            semantic: observation
              ? {
                  observations: {
                    "observe:1": { status: "resolved", value: "yes" },
                  },
                }
              : { judgments: { "judge:1": true } },
          },
        }),
      );
    });
    const startup = vi.fn(
      async (input: Parameters<ClaudeSdkTstStartupFn>[0]) => {
        const start = { close: vi.fn(), schema: input?.options?.outputFormat };
        starts.push(start);
        return {
          close: start.close,
          query: vi.fn(() => semanticMessages(true)),
        };
      },
    );
    const worker = new ClaudeSdkTstWorker({
      query: query as unknown as ClaudeSdkTstQueryFn,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    try {
      await runSemantic(worker, judgmentTask());
      await flushMicrotasks();
      await runSemantic(worker, observationTask());
      await flushMicrotasks();
      expect(query).toHaveBeenCalledTimes(2);
      expect(starts[0]!.close).toHaveBeenCalledOnce();
      expect(starts[0]!.schema).not.toEqual(starts[1]!.schema);
    } finally {
      await worker.stop();
    }
  });

  it("aborts an active Claude TST query on stop and closes its transport", async () => {
    const entered = deferred();
    const close = vi.fn();
    const worker = new ClaudeSdkTstWorker({
      fastStarts: { enabled: false },
      query: ((params: Parameters<ClaudeSdkTstQueryFn>[0]) => {
        const stream = (async function* () {
          await new Promise<void>((resolve, reject) => {
            params.options!.abortController!.signal.addEventListener(
              "abort",
              () => reject(new Error("query aborted")),
              { once: true },
            );
            entered.resolve();
          });
        })();
        return Object.assign(stream, { close });
      }) as unknown as ClaudeSdkTstQueryFn,
    });
    const running = runSemantic(worker, judgmentTask());
    const rejected = expect(running).resolves.toMatchObject({
      cancellation: "superseded",
    });
    await entered.promise;
    await worker.stop();
    await rejected;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh Claude TST controller after a prepared query throws and closes consumed resources", async () => {
    const close = vi.fn();
    const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) => {
      expect(params.options?.abortController?.signal.aborted).toBe(false);
      return semanticMessages(true);
    });
    const worker = new ClaudeSdkTstWorker({
      query: query as unknown as ClaudeSdkTstQueryFn,
      startup: (async () => ({
        close,
        query: () => {
          throw new Error("prepared query failed");
        },
      })) as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    await primePoolByRunning(worker);
    await flushMicrotasks();
    await expect(runSemantic(worker, judgmentTask())).resolves.toMatchObject({
      outcome: "completed",
      backendDetails: { preparedStartUsed: false },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    await worker.stop();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("fences Claude TST provider entry and releases consumed starts when diagnostics fail or stop overlaps setup", async () => {
    const entered = deferred();
    const release = deferred();
    const query = queryReturning({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });
    const close = vi.fn();
    const worker = new ClaudeSdkTstWorker({
      query,
      startup: (async () => ({
        close,
        query: () => semanticMessages(true),
      })) as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    await primePoolByRunning(worker);
    await flushMicrotasks();
    const running = runBackend(
      worker,
      semanticRoutine(judgmentTask()),
      context(),
      noopRoutineEffects(),
      {
        ...noopDiagnostics,
        writeText: async () => {
          entered.resolve();
          await release.promise;
          throw new Error("diagnostics failed");
        },
      },
    );
    const rejected = expect(running).resolves.toMatchObject({
      cancellation: "superseded",
    });
    await entered.promise;
    await worker.stop();
    release.resolve();
    await rejected;
    expect(query).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves a consumed Claude trigger start across pool replenishment and expiry", async () => {
    const entered = deferred();
    const release = deferred();
    const closes: ReturnType<typeof vi.fn>[] = [];
    const completed = new Set<number>();
    const startup = vi.fn(
      async (params: Parameters<ClaudeSdkTstStartupFn>[0]) => {
        const index = closes.length;
        const close = vi.fn();
        closes.push(close);
        return {
          close,
          query: (_prompt: string) =>
            (async function* () {
              try {
                if (index === 0) {
                  entered.resolve();
                  await release.promise;
                  expect(params?.options?.abortController?.signal.aborted).toBe(
                    false,
                  );
                }
                yield* semanticMessages(true);
              } finally {
                completed.add(index);
              }
            })(),
        };
      },
    );
    vi.useFakeTimers();
    const worker = new ClaudeSdkTstWorker({
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      query: queryReturning({
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      }),
      fastStarts: { enabled: true, maxPreparedStarts: 1, idleTtlMs: 10 },
    });
    let pending: ReturnType<typeof runSemantic> | undefined;
    try {
      await primePoolByRunning(worker);
      expect(startup).toHaveBeenCalledTimes(1);
      await flushMicrotasks();
      pending = runSemantic(worker, judgmentTask());
      await entered.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(closes.length).toBe(2);
      expect(closes[0]).not.toHaveBeenCalled();
      expect(
        closes.slice(1).some((close) => close.mock.calls.length === 1),
      ).toBe(true);
      await expect(
        runBackend(
          worker,
          {
            ...semanticRoutine(judgmentTask()),
            id: "other-trigger",
            contextKey: "other-context",
          },
          context(),
          noopRoutineEffects(),
          noopDiagnostics,
        ),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(closes[0]).not.toHaveBeenCalled();
      release.resolve();
      await expect(pending).resolves.toMatchObject({
        outcome: "completed",
        backendDetails: { preparedStartUsed: true },
      });
      expect(completed.has(0)).toBe(true);
      expect(closes[0]).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending;
      worker.stop();
      vi.useRealTimers();
    }
  });

  it("resolves judgment-only semantic reports through the Claude tst backend", async () => {
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: { judgments: { "judge:1": true } },
        },
      }),
    });

    await expect(runSemantic(backend, judgmentTask())).resolves.toMatchObject({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });
  });

  it("resolves observation-only semantic reports through the Claude tst backend", async () => {
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: {
            observations: { "observe:1": { status: "resolved", value: "yes" } },
          },
        },
      }),
    });

    await expect(
      runSemantic(backend, observationTask()),
    ).resolves.toMatchObject({
      outcome: "completed",
      semantic: {
        observations: { "observe:1": { status: "resolved", value: "yes" } },
      },
    });
  });

  it("resolves complete judgment observation and mixed semantic reports", async () => {
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: {
            judgments: { "judge:1": false },
            observations: { "observe:1": { status: "unknown" } },
          },
        },
      }),
    });

    await expect(runSemantic(backend, mixedTask())).resolves.toMatchObject({
      outcome: "completed",
      semantic: {
        judgments: { "judge:1": false },
        observations: { "observe:1": { status: "unknown" } },
      },
    });
  });

  it("rejects missing Claude TST answers against the bound schema", async () => {
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: { judgments: {} },
        },
      }),
    });

    await expect(runSemantic(backend, judgmentTask())).rejects.toThrow(
      "judge:1",
    );
  });

  it("rejects unrequested Claude TST semantic keys against the bound schema", async () => {
    const logger = {
      level: "info" as const,
      format: "json" as const,
      info: vi.fn(),
      debug: vi.fn(),
    };
    // The worker answers the requested judgment, then over-answers by echoing
    // the same brief under observations — the exact shape that used to fail the
    // whole run.
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: {
            judgments: { "judge:1": true },
            observations: {
              "judge:1": { status: "resolved", value: "echoed" },
            },
          },
        },
      }),
      logger,
    });
    const diagnostics = { ...noopDiagnostics, writeJson: vi.fn() };

    await expect(
      runBackend(
        backend,
        semanticRoutine(judgmentTask()),
        context(),
        noopRoutineEffects(),
        diagnostics,
      ),
    ).rejects.toThrow("observations");
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("semantic_drift"),
      expect.anything(),
    );
    expect(diagnostics.writeJson).not.toHaveBeenCalledWith(
      "semantic-drift",
      expect.anything(),
    );
  });

  it("fails clearly on malformed semantic output", async () => {
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({ report: { outcome: "completed", semantic: 3 } }),
    });

    await expect(runSemantic(backend, judgmentTask())).rejects.toThrow(
      /semantic/i,
    );
  });

  it("renders the held-inbound dialog and judgment request into the Claude tst semantic prompt", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const backend = new ClaudeSdkTstWorker({ query });
    const base = judgmentTask();
    const request = {
      ...base.requests[0]!,
      question: "trigger-question-claude-marker",
      guidance: "trigger-guidance-claude-marker",
    };
    const task: SemanticTask = {
      ...base,
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "held-inbound-claude-marker" }],
      },
      requests: [request],
    };

    await runSemantic(backend, task);

    const prompt = String(query.mock.calls[0]![0].prompt);
    expect(prompt).toContain("held-inbound-claude-marker");
    expect(prompt).toContain("trigger-question-claude-marker");
    expect(prompt).not.toContain("trigger-guidance-claude-marker");
    expect(prompt).not.toContain('"guidance"');
    expect(query.mock.calls[0]![0].options?.systemPrompt).not.toContain(
      "Apply each request's standing guidance",
    );
  });

  it("rejects non-semantic routines clearly in the Claude tst backend", async () => {
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: { outcome: "completed", semantic: {} },
      }),
    });

    await expect(
      runBackend(
        backend,
        routineForTask(instructionTask()),
        context(),
        noopRoutineEffects(),
        noopDiagnostics,
      ),
    ).rejects.toThrow(/only run semantic tasks/);
  });

  it("uses the default model when no model is configured", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const backend = new ClaudeSdkTstWorker({ query });

    await runSemantic(backend, judgmentTask());

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          model: DEFAULT_CLAUDE_SDK_TST_MODEL,
          maxTurns: 2,
          tools: [],
          permissionMode: "dontAsk",
          persistSession: false,
        }),
      }),
    );
  });

  it("uses a generic system prompt and puts routine context in the user prompt", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const backend = new ClaudeSdkTstWorker({
      cwd: "/fixed-semantic-cwd",
      query,
    });

    await runSemantic(backend, judgmentTask());

    const call = query.mock.calls[0]![0];
    expect(call.options?.cwd).toBe("/fixed-semantic-cwd");
    expect(String(call.options?.systemPrompt)).not.toContain("Frontier:");
    expect(String(call.options?.systemPrompt)).not.toContain("Role:");
    expect(String(call.prompt)).toContain("<semantic-context>");
    expect(String(call.prompt)).toContain("</semantic-context>");
    expect(String(call.prompt)).toContain("<latest-conversation>");
    expect(String(call.prompt)).toContain("</latest-conversation>");
    expect(String(call.prompt)).toContain("<semantic-requests>");
    expect(String(call.prompt)).toContain("</semantic-requests>");
    expect(String(call.prompt)).toContain('"stage": "trigger"');
    expect(String(call.prompt)).toContain('"role": "default"');
  });

  it("passes explicit model overrides to the SDK", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const backend = new ClaudeSdkTstWorker({
      model: "claude-sonnet-4-6",
      query,
    });

    await runSemantic(backend, judgmentTask());

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: "claude-sonnet-4-6" }),
      }),
    );
  });

  it("logs tst backend lifecycle events", async () => {
    const logger = {
      level: "info" as const,
      format: "json" as const,
      info: vi.fn(),
      debug: vi.fn(),
    };
    const backend = new ClaudeSdkTstWorker({
      model: "claude-haiku-4-5",
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: { judgments: { "judge:1": true } },
        },
      }),
      logger,
    });
    const task = judgmentTask();

    await runSemantic(backend, task);

    expect(logger.info).toHaveBeenCalledWith(
      "backend.claude_sdk_tst.started",
      expect.objectContaining({
        arcRunId: "run:test",
        role: task.role,
        model: "claude-haiku-4-5",
        stage: "trigger",
        requestCount: 1,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "backend.claude_sdk_tst.finished",
      expect.objectContaining({
        arcRunId: "run:test",
        role: task.role,
        model: "claude-haiku-4-5",
        outputKind: "text",
        reportKind: "completed",
      }),
    );
  });

  it("writes semantic routine diagnostics under the derived routine directory", async () => {
    const routineDiagnosticsDir = join(
      tmpdir(),
      "arcade-claude-sdk-semantic-diagnostics",
    );
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: { judgments: { "judge:1": true } },
        },
      }),
    });
    const task = judgmentTask();
    const routine = semanticRoutine(task);
    const diagnostics = createFileRoutineDiagnostics({
      root: routineDiagnosticsDir,
      arcRunId: routine.arcRunId!,
      role: routine.role!,
      routineId: routine.id!,
    });
    const diagnosticsDir = join(
      routineDiagnosticsDir,
      routinePathSegment(routine.arcRunId!),
      routinePathSegment(routine.role!),
      routinePathSegment(routine.id!),
    );

    const report = await runBackend(
      backend,
      routine,
      context(),
      noopRoutineEffects(),
      diagnostics,
    );
    expect(report).toMatchObject({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });

    expect(report.backendDetails).toMatchObject({
      backend: "claude-sdk-tst",
      preparedStartUsed: false,
    });
    const prompt = await readFile(join(diagnosticsDir, "prompt.txt"), "utf8");
    expect(prompt).toContain("<semantic-requests>");
    const transcript = JSON.parse(
      await readFile(join(diagnosticsDir, "sdk-messages.json"), "utf8"),
    ) as unknown[];
    expect(transcript).toHaveLength(2);
  });

  it("retains partial Claude TST messages when the provider stream fails", async () => {
    const backend = new ClaudeSdkTstWorker({
      fastStarts: { enabled: false },
      query: (() =>
        (async function* () {
          for await (const message of sdkMessages("partial semantic output")) {
            yield message;
            break;
          }
          throw new Error("Reached maximum number of turns (2)");
        })()) as unknown as ClaudeSdkTstQueryFn,
    });
    const diagnostics = { ...noopDiagnostics, writeJson: vi.fn() };
    await expect(
      runBackend(
        backend,
        semanticRoutine(judgmentTask()),
        context(),
        noopRoutineEffects(),
        diagnostics,
      ),
    ).rejects.toThrow("Reached maximum number of turns (2)");
    expect(diagnostics.writeJson).toHaveBeenCalledWith("sdk-messages", [
      expect.objectContaining({
        type: "assistant",
        message: expect.objectContaining({
          content: [{ type: "text", text: "partial semantic output" }],
        }),
      }),
    ]);
    await backend.stop();
  });

  it("uses the supplied workspace for Claude TST cold queries", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const backend = new ClaudeSdkTstWorker({ query });
    const task = judgmentTask();
    const report = await runBackend(
      backend,
      semanticRoutine(task),
      { ...context(), workspacePath: "/hub-supplied-cwd" },
      noopRoutineEffects(),
      noopDiagnostics,
    );
    expect(query.mock.calls[0]![0].options?.cwd).toBe("/hub-supplied-cwd");
    expect(report.backendDetails).toMatchObject({ cwd: "/hub-supplied-cwd" });
    backend.stop();
  });

  it("waits for a supplied workspace and replaces Claude TST starts when it changes", async () => {
    const close = vi.fn();
    const startup = vi.fn(
      async (_input: Parameters<ClaudeSdkTstStartupFn>[0]) => ({
        query: vi.fn(() => semanticMessages(true)),
        close,
      }),
    );
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const backend = new ClaudeSdkTstWorker({
      query,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    expect(startup).not.toHaveBeenCalled();
    await primePoolByRunning(backend, "/first-hub-cwd");
    await flushMicrotasks();
    expect(startup.mock.calls[0]![0]?.options?.cwd).toBe("/first-hub-cwd");
    const task = judgmentTask();
    const report = await runBackend(
      backend,
      semanticRoutine(task),
      { ...context(), workspacePath: "/second-hub-cwd" },
      noopRoutineEffects(),
      noopDiagnostics,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(startup.mock.calls[1]![0]?.options?.cwd).toBe("/second-hub-cwd");
    expect(query.mock.calls[1]![0].options?.cwd).toBe("/second-hub-cwd");
    expect(report.backendDetails).toMatchObject({
      cwd: "/second-hub-cwd",
      preparedStartUsed: false,
    });
    backend.stop();
  });

  it("starts a schema-bound fast-trigger pool from invocation admission", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const startup = vi.fn(
      async (_params: Parameters<ClaudeSdkTstStartupFn>[0]) =>
        warmQueryReturning(),
    );
    const backend = new ClaudeSdkTstWorker({
      cwd: "/fixed-semantic-cwd",
      query,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 2 },
    });
    expect(startup).not.toHaveBeenCalled();
    await runSemantic(backend, judgmentTask());
    expect(startup).toHaveBeenCalledTimes(2);
    expect(startup.mock.calls[0]![0]).toMatchObject({
      options: {
        cwd: "/fixed-semantic-cwd",
        persistSession: false,
        tools: [],
        skills: [],
      },
    });
    expect(
      String(startup.mock.calls[0]![0]?.options?.systemPrompt),
    ).not.toContain("Frontier:");
    await backend.stop();
  });

  it("consumes a ready pooled fast trigger start and replenishes it", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const warmQuery = vi.fn((_prompt: string) => semanticMessages(true));
    const close = vi.fn();
    const startup = vi.fn(async () => ({ query: warmQuery, close }));
    const backend = new ClaudeSdkTstWorker({
      query: query as unknown as ClaudeSdkTstQueryFn,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    await primePoolByRunning(backend);
    await flushMicrotasks();
    const task = judgmentTask();
    const ctx = context();
    const routine = semanticRoutine(task);

    const report = await runBackend(
      backend,
      routine,
      ctx,
      noopRoutineEffects(),
      noopDiagnostics,
    );
    expect(report).toMatchObject({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });

    expect(startup.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(warmQuery).toHaveBeenCalledTimes(1);
    expect(warmQuery.mock.calls[0]![0]).toContain("<semantic-requests>");
    expect(query).toHaveBeenCalledTimes(1);
    expect(report.backendDetails).toMatchObject({
      backend: "claude-sdk-tst",
      preparedStartUsed: true,
    });
    await delay(0);
    expect(startup.mock.calls.length).toBeGreaterThanOrEqual(2);
    backend.stop();
  });

  it("falls back to cold query when warm starts are only in flight", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    let resolveStartup!: (value: ReturnType<typeof warmQueryReturning>) => void;
    const startup = vi.fn(
      () =>
        new Promise<ReturnType<typeof warmQueryReturning>>((resolve) => {
          resolveStartup = resolve;
        }),
    );
    const backend = new ClaudeSdkTstWorker({
      query,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 2 },
    });
    const task = judgmentTask();
    const ctx = context();
    const routine = semanticRoutine(task);

    const report = await runBackend(
      backend,
      routine,
      ctx,
      noopRoutineEffects(),
      noopDiagnostics,
    );
    expect(report).toMatchObject({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });

    expect(startup).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
    expect(report.backendDetails).toMatchObject({
      backend: "claude-sdk-tst",
      preparedStartUsed: false,
    });
    resolveStartup(warmQueryReturning());
    await flushMicrotasks();
    backend.stop();
  });

  it("falls back to cold query when warm startup fails", async () => {
    const query = queryReturning({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      },
    });
    const startup = vi.fn(async () => {
      throw new Error("startup failed");
    });
    const backend = new ClaudeSdkTstWorker({
      query,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    await primePoolByRunning(backend);
    await flushMicrotasks();
    const task = judgmentTask();
    const routine = semanticRoutine(task);

    const report = await runBackend(
      backend,
      routine,
      context(),
      noopRoutineEffects(),
      noopDiagnostics,
    );
    expect(report).toMatchObject({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(report.backendDetails).toMatchObject({
      backend: "claude-sdk-tst",
      preparedStartUsed: false,
    });
    backend.stop();
  });

  it("expires unused fast-trigger starts without refreshing an idle pool", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const startup = vi.fn(async () => ({
      query: () => semanticMessages(true),
      close,
    }));
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: { judgments: { "judge:1": true } },
        },
      }),
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1, idleTtlMs: 10 },
    });
    try {
      await runSemantic(backend, judgmentTask());
      await vi.advanceTimersByTimeAsync(100);
      expect(close).toHaveBeenCalledTimes(1);
      expect(startup).toHaveBeenCalledTimes(1);
      expect(probeRetention(backend).reserved).toBe(0);
    } finally {
      await backend.stop();
      vi.useRealTimers();
    }
  });

  it("closes unused warm starts and prevents replenishment on stop", async () => {
    const close = vi.fn();
    const startup = vi.fn(async () => ({
      query: vi.fn((_prompt: string) => semanticMessages(true)),
      close,
    }));
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: { judgments: { "judge:1": true } },
        },
      }),
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    await primePoolByRunning(backend);
    await flushMicrotasks();

    backend.stop();
    await delay(0);

    expect(close).toHaveBeenCalledTimes(1);
    expect(startup).toHaveBeenCalledTimes(1);
  });
});

function queryReturning(
  value: unknown,
): ClaudeSdkTstQueryFn & ReturnType<typeof vi.fn> {
  return vi.fn((_params: Parameters<ClaudeSdkTstQueryFn>[0]) =>
    sdkMessages(
      JSON.stringify(
        typeof value === "object" && value !== null && "report" in value
          ? value
          : { report: value },
      ),
    ),
  ) as unknown as ClaudeSdkTstQueryFn & ReturnType<typeof vi.fn>;
}

function runSemantic(backend: ClaudeSdkTstWorker, task: SemanticTask) {
  return runBackend(
    backend,
    semanticRoutine(task),
    context(),
    noopRoutineEffects(),
    noopDiagnostics,
  );
}

function semanticRoutine(task: SemanticTask): RoutineDescriptor {
  return routineForTask(task);
}

function routineForTask(task: Task): RoutineDescriptor {
  return {
    id: "routine:semantic-test",
    role: task.role,
    arcRunId: task.arcRunId,
    contextKey: "semantic-test",
    task,
  };
}

function semanticMessages(judgment: boolean) {
  return sdkMessages(
    JSON.stringify({
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:1": judgment } },
      },
    }),
  );
}

function warmQueryReturning() {
  return {
    query: vi.fn((_prompt: string) => semanticMessages(true)),
    close: vi.fn(),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function judgmentTask(): SemanticTask {
  return {
    kind: "semantic",
    allowedDispositions: [],
    batchId: "semantic:test",
    role: "default",
    stage: "trigger",
    contextIsolation: "role",
    arcRunId: "run:test",
    dialog: { cursor: { user: 1, self: 0 }, lastTurns: [] },
    requests: [
      {
        kind: "judgment",
        briefId: "judge:1",
        role: "default",
        question: "Is this true?",
        tool: semanticTool(),
        sourceRef: "node:test:Main",
      },
    ],
  };
}

function observationTask(): SemanticTask {
  return {
    ...judgmentTask(),
    requests: [
      {
        kind: "observation",
        briefId: "observe:1",
        role: "default",
        cell: "answer",
        mode: "observe",
        question: "Extract the answer.",
        meta: { type: "string" },
        tool: semanticTool(),
        sourceRef: "node:test:Main",
      },
    ],
  };
}

function mixedTask(): SemanticTask {
  return {
    ...judgmentTask(),
    requests: [...judgmentTask().requests, ...observationTask().requests],
  };
}

function instructionTask(): InstructionTask {
  return {
    kind: "instruction",
    allowedDispositions: [],
    briefIds: ["instruction:test"],
    role: "default",
    texts: ["Do the thing."],
    tools: [],
    cells: {},
    arcRunId: "run:test",
    dialog: { cursor: { user: 1, self: 0 }, lastTurns: [] },
    sourceRef: "node:test:Main",
    contextIsolation: "role",
    phase: "apply",
  };
}

async function primePoolByRunning(
  backend: ClaudeSdkTstWorker,
  workspacePath = context().workspacePath,
) {
  const task = judgmentTask();
  await runBackend(
    backend,
    semanticRoutine(task),
    { ...context(), workspacePath },
    noopRoutineEffects(),
    noopDiagnostics,
  );
}
