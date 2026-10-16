import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RoutineDescriptor } from "../src/index.js";
import {
  ClaudeSdkTstWorker,
  DEFAULT_CLAUDE_SDK_TST_MODEL,
  createFileRoutineDiagnostics,
  noopRoutineEffects,
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

describe("ClaudeSdkTstWorker", () => {
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

  it("leaves task-aware completeness validation to worker hub", async () => {
    const backend = new ClaudeSdkTstWorker({
      query: queryReturning({
        report: {
          outcome: "completed",
          semantic: { judgments: {} },
        },
      }),
    });

    await expect(runSemantic(backend, judgmentTask())).resolves.toMatchObject({
      outcome: "completed",
      semantic: { judgments: {} },
    });
  });

  it("returns unrequested Claude TST semantic keys for worker hub validation", async () => {
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
    ).resolves.toMatchObject({
      outcome: "completed",
      semantic: {
        judgments: { "judge:1": true },
        observations: {
          "judge:1": { status: "resolved", value: "echoed" },
        },
      },
    });
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
    warmBackend(backend, "/first-hub-cwd");
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
    expect(query.mock.calls[0]![0].options?.cwd).toBe("/second-hub-cwd");
    expect(report.backendDetails).toMatchObject({
      cwd: "/second-hub-cwd",
      preparedStartUsed: false,
    });
    backend.stop();
  });

  it("starts a task-independent warm pool when fast trigger starts are enabled", async () => {
    const query = vi.fn();
    const startup = vi.fn(
      async (_params: Parameters<ClaudeSdkTstStartupFn>[0]) =>
        warmQueryReturning(),
    );
    const backend = new ClaudeSdkTstWorker({
      cwd: "/fixed-semantic-cwd",
      query: query as unknown as ClaudeSdkTstQueryFn,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 2 },
    });

    expect(startup).toHaveBeenCalledTimes(2);
    expect(startup.mock.calls[0]![0]).toMatchObject({
      initializeTimeoutMs: 30000,
      options: {
        cwd: "/fixed-semantic-cwd",
        model: DEFAULT_CLAUDE_SDK_TST_MODEL,
        maxTurns: 2,
        permissionMode: "dontAsk",
        persistSession: false,
        tools: [],
        skills: [],
      },
    });
    expect(
      String(startup.mock.calls[0]![0]?.options?.systemPrompt),
    ).not.toContain("Frontier:");
    expect(query).not.toHaveBeenCalled();
    backend.stop();
  });

  it("consumes a ready pooled fast trigger start and replenishes it", async () => {
    const query = vi.fn();
    const warmQuery = vi.fn((_prompt: string) => semanticMessages(true));
    const close = vi.fn();
    const startup = vi.fn(async () => ({ query: warmQuery, close }));
    const backend = new ClaudeSdkTstWorker({
      query: query as unknown as ClaudeSdkTstQueryFn,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    warmBackend(backend);
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
    expect(query).not.toHaveBeenCalled();
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
    warmBackend(backend);
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

    expect(query).toHaveBeenCalledTimes(1);
    expect(report.backendDetails).toMatchObject({
      backend: "claude-sdk-tst",
      preparedStartUsed: false,
    });
    backend.stop();
  });

  it("expires unused warm starts and refreshes the pool", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      const startup = vi.fn(async () => ({
        query: vi.fn((_prompt: string) => semanticMessages(true)),
        close,
      }));
      const backend = new ClaudeSdkTstWorker({
        query: vi.fn() as unknown as ClaudeSdkTstQueryFn,
        startup: startup as unknown as ClaudeSdkTstStartupFn,
        fastStarts: {
          enabled: true,
          maxPreparedStarts: 1,
          idleTtlMs: 1,
        },
      });
      warmBackend(backend);
      await flushMicrotasks();

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();

      expect(close).toHaveBeenCalledTimes(1);
      expect(startup).toHaveBeenCalledTimes(2);
      backend.stop();
    } finally {
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
      query: vi.fn() as unknown as ClaudeSdkTstQueryFn,
      startup: startup as unknown as ClaudeSdkTstStartupFn,
      fastStarts: { enabled: true, maxPreparedStarts: 1 },
    });
    warmBackend(backend);
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
    sdkMessages(JSON.stringify(value)),
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

function warmBackend(
  backend: ClaudeSdkTstWorker,
  workspacePath = context().workspacePath,
) {
  const task = judgmentTask();
  backend.warm({
    arcRunId: task.arcRunId,
    role: task.role,
    contextKey: "semantic-test",
    workspacePath,
  });
}
