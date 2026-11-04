import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod/v4";

import { describe, expect, it, vi } from "vitest";

import type { RoutineDescriptor } from "../src/index.js";
import {
  DEFAULT_OPENAI_SDK_TST_MODEL,
  OpenAiSdkTstWorker,
  createFileRoutineDiagnostics,
  noopRoutineEffects,
  routinePathSegment,
  type InstructionTask,
  type OpenAiSdkTstRunFn,
  type SemanticTask,
  type Task,
} from "../src/testing.js";
import {
  cwdContext as context,
  noopDiagnostics,
  runBackend,
} from "./backend-helpers.js";

describe("OpenAiSdkTstWorker", () => {
  it("binds OpenAI trigger structured output to the current brief and nested value schema", async () => {
    const task = observationTask();
    const request = task.requests[0]!;
    if (request.kind !== "observation") throw new Error("expected observation");
    request.meta = {
      type: "struct",
      fields: {
        ready: { question: "ready?", meta: { type: "boolean" } },
        checks: {
          question: "checks?",
          meta: {
            type: "array",
            element: {
              type: "struct",
              fields: {
                label: { question: "label?", meta: { type: "string" } },
              },
            },
          },
        },
      },
    };
    const value = { ready: true, checks: [{ label: "complete" }] };
    const report = {
      outcome: "completed",
      semantic: {
        observations: { "observe:1": { status: "resolved", value } },
      },
    };
    const run = vi.fn<OpenAiSdkTstRunFn>(async (input) => {
      const schema = input.agent.outputType as ZodType;
      expect(schema.safeParse({ report }).success).toBe(true);
      expect(
        schema.safeParse({
          report: {
            ...report,
            semantic: {
              observations: { "observe:wrong": { status: "resolved", value } },
            },
          },
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          report: {
            ...report,
            semantic: {
              observations: {
                "observe:1": {
                  status: "resolved",
                  value: { ready: true, checks: [{}] },
                },
              },
            },
          },
        }).success,
      ).toBe(false);
      return { finalOutput: { report } };
    });
    const backend = new OpenAiSdkTstWorker({ apiKey: "test", run });
    await expect(runSemantic(backend, task)).resolves.toMatchObject(report);
    expect(run).toHaveBeenCalledOnce();
    await backend.stop();
  });

  it("aborts active OpenAI TST execution on stop and fences later provider entry", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = vi.fn(async (input: Parameters<OpenAiSdkTstRunFn>[0]) => {
      await new Promise<void>((resolve, reject) => {
        input.signal.addEventListener(
          "abort",
          () => reject(new Error("run aborted")),
          { once: true },
        );
        entered();
      });
      return {};
    });
    const worker = new OpenAiSdkTstWorker({ apiKey: "mock", run });
    const running = runSemantic(worker, judgmentTask());
    const rejected = expect(running).resolves.toMatchObject({
      cancellation: "superseded",
    });
    await started;
    await worker.stop();
    await rejected;
    await expect(runSemantic(worker, judgmentTask())).rejects.toThrow(
      "stopped",
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("resolves judgment-only semantic reports through the OpenAI tst backend", async () => {
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run: runReturning({
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      }),
    });

    await expect(runSemantic(backend, judgmentTask())).resolves.toMatchObject({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });
  });

  it("records the hub-supplied workspace in OpenAI TST diagnostics", async () => {
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run: runReturning({
        outcome: "completed",
        semantic: { judgments: { "judge:1": true } },
      }),
    });
    const task = judgmentTask();
    const report = await runBackend(
      backend,
      semanticRoutine(task),
      { ...context(), workspacePath: "/hub-supplied-cwd" },
      noopRoutineEffects(),
      noopDiagnostics,
    );
    expect(report.backendDetails).toMatchObject({ cwd: "/hub-supplied-cwd" });
  });

  it("resolves observation-only semantic reports through the OpenAI tst backend", async () => {
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run: runReturning({
        outcome: "completed",
        semantic: {
          observations: { "observe:1": { status: "resolved", value: "yes" } },
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

  it("resolves complete judgment observation and mixed semantic reports through OpenAI", async () => {
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run: runReturning({
        outcome: "completed",
        semantic: {
          judgments: { "judge:1": false },
          observations: { "observe:1": { status: "unknown" } },
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

  it("rejects unrequested OpenAI TST semantic keys against the bound schema", async () => {
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run: runReturning({
        outcome: "completed",
        semantic: {
          judgments: { "judge:1": true, "judge:extra": false },
        },
      }),
    });

    await expect(runSemantic(backend, judgmentTask())).rejects.toThrow(
      "judge:extra",
    );
  });

  it("rejects non-semantic routines clearly in the OpenAI tst backend", async () => {
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run: runReturning({ outcome: "completed", semantic: {} }),
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

  it("uses default and explicit model values", async () => {
    const run = runReturning({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run,
    });

    await runSemantic(backend, judgmentTask());
    expect(run.mock.calls[0]![0].agent.model).toBe(
      DEFAULT_OPENAI_SDK_TST_MODEL,
    );

    const overrideRun = runReturning({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });
    const override = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      model: "gpt-semantic-test",
      run: overrideRun,
    });
    await runSemantic(override, judgmentTask());
    expect(overrideRun.mock.calls[0]![0].agent.model).toBe("gpt-semantic-test");
  });

  it("renders the held-inbound dialog and judgment request into the OpenAI tst semantic prompt", async () => {
    const run = runReturning({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });
    const backend = new OpenAiSdkTstWorker({ apiKey: "sk-test", run });
    const base = judgmentTask();
    const request = {
      ...base.requests[0]!,
      question: "trigger-question-openai-marker",
      guidance: "trigger-guidance-openai-marker",
    };
    const task: SemanticTask = {
      ...base,
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "held-inbound-openai-marker" }],
      },
      requests: [request],
    };

    await runSemantic(backend, task);

    const prompt = run.mock.calls[0]![0].prompt;
    expect(prompt).toContain("held-inbound-openai-marker");
    expect(prompt).toContain("trigger-question-openai-marker");
    expect(prompt).not.toContain("trigger-guidance-openai-marker");
    expect(prompt).not.toContain('"guidance"');
    expect(run.mock.calls[0]![0].agent.instructions).not.toContain(
      "Apply each request's standing guidance",
    );
  });

  it("writes semantic prompt and SDK result diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "arcade-openai-semantic-diag-"));
    const run = runReturning({
      outcome: "completed",
      semantic: { judgments: { "judge:1": true } },
    });
    const backend = new OpenAiSdkTstWorker({
      apiKey: "sk-test",
      run,
    });
    const task = judgmentTask();
    const diagnostics = createFileRoutineDiagnostics({
      root,
      arcRunId: task.arcRunId,
      role: task.role,
      routineId: "routine-semantic",
    });
    const diagnosticsDir = join(
      root,
      routinePathSegment(task.arcRunId),
      routinePathSegment(task.role),
      routinePathSegment("routine-semantic"),
    );

    await expect(
      runBackend(
        backend,
        semanticRoutine(task),
        context(),
        noopRoutineEffects(),
        diagnostics,
      ),
    ).resolves.toMatchObject({ outcome: "completed" });

    await expect(
      readFile(join(diagnosticsDir, "prompt.txt"), "utf8"),
    ).resolves.toContain("<semantic-requests>");
    const result = JSON.parse(
      await readFile(join(diagnosticsDir, "sdk-result.json"), "utf8"),
    ) as { lastResponseId?: string };
    expect(result.lastResponseId).toBe("resp-semantic");
  });
});

function runReturning(value: unknown) {
  return vi.fn<OpenAiSdkTstRunFn>(async () => ({
    finalOutput: JSON.stringify({ report: value }),
    lastResponseId: "resp-semantic",
  }));
}

function runSemantic(backend: OpenAiSdkTstWorker, task: SemanticTask) {
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
    id: "routine-semantic",
    role: task.role,
    arcRunId: task.arcRunId,
    contextKey: "semantic-test",
    task,
  };
}

function judgmentTask(): SemanticTask {
  return {
    kind: "semantic",
    allowedDispositions: [],
    batchId: "semantic:1",
    role: "researcher",
    stage: "trigger",
    contextIsolation: "role",
    arcRunId: "run:test",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    requests: [
      {
        kind: "judgment",
        briefId: "judge:1",
        role: "researcher",
        question: "Is this true?",
        sourceRef: "node:test:Main",
        tool: {
          type: "function",
          name: "judge",
          description: "Return a boolean judgment.",
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

function observationTask(): SemanticTask {
  return {
    ...judgmentTask(),
    batchId: "semantic:observe",
    requests: [
      {
        kind: "observation",
        briefId: "observe:1",
        role: "researcher",
        cell: "answer",
        mode: "observe",
        question: "What is the answer?",
        meta: { type: "string" },
        sourceRef: "node:test:Main",
        tool: {
          type: "function",
          name: "observe",
          description: "Return an observation.",
          strict: true,
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      },
    ],
  };
}

function mixedTask(): SemanticTask {
  return {
    ...judgmentTask(),
    batchId: "semantic:mixed",
    requests: [judgmentTask().requests[0]!, observationTask().requests[0]!],
  };
}

function instructionTask(): InstructionTask {
  return {
    kind: "instruction",
    allowedDispositions: [],
    briefIds: ["instruction:1"],
    role: "researcher",
    texts: ["Do work."],
    tools: [],
    cells: {},
    arcRunId: "run:test",
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    sourceRef: "node:test:Main",
    contextIsolation: "role",
    phase: "apply",
  };
}
