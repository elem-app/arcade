import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  ClaudeSdkTstQueryFn,
  OpenAiSdkTstRunFn,
  Task,
} from "../src/testing.js";
import { sdkTextMessages } from "./backend-helpers.js";
import {
  ARC_RUN_ID,
  createCapturingLogger,
  makeArcHostWithSource,
  makeWorkerHub,
} from "./helpers.js";

describe("Worker hub TST report validation", () => {
  it("records and removes Claude TST semantic drift at the worker hub boundary", async () => {
    const { workerHub, task, records } = await makeClaudeHubWithReport({
      outcome: "completed",
      semantic: {
        judgments: { "judge:required": true, "judge:extra": false },
      },
    });

    await expect(workerHub.handleTask(task, context())).resolves.toMatchObject({
      status: "finished",
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_hub.semantic_report_drift",
          backend: "claude-sdk-tst",
          unrequestedJudgments: ["judge:extra"],
        }),
      ]),
    );
  });

  it("records and removes OpenAI TST semantic drift at the worker hub boundary", async () => {
    const { workerHub, task, records } = await makeOpenAiHubWithReport({
      outcome: "completed",
      semantic: {
        judgments: { "judge:required": true, "judge:extra": false },
      },
    });

    await expect(workerHub.handleTask(task, context())).resolves.toMatchObject({
      status: "finished",
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
    });
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_hub.semantic_report_drift",
          backend: "openai-sdk-tst",
          unrequestedJudgments: ["judge:extra"],
        }),
      ]),
    );
  });

  it("writes no drift evidence for a complete TST report", async () => {
    const diagnosticsDir = await mkdtemp(
      join(tmpdir(), "arcade-tst-no-drift-"),
    );
    const { workerHub, task, records } = await makeClaudeHubWithReport(
      {
        outcome: "completed",
        semantic: { judgments: { "judge:required": true } },
      },
      diagnosticsDir,
    );

    await workerHub.handleTask(task, context());

    expect(
      records.some(
        (record) => record.event === "worker_hub.semantic_report_drift",
      ),
    ).toBe(false);
    const entries = await readdir(diagnosticsDir, { recursive: true });
    expect(entries.some((entry) => entry.endsWith("semantic-drift.json"))).toBe(
      false,
    );
  });

  it("rejects an incomplete TST semantic report at the worker hub boundary", async () => {
    const { workerHub, task } = await makeClaudeHubWithReport({
      outcome: "completed",
      semantic: { judgments: {} },
    });

    await expect(workerHub.handleTask(task, context())).resolves.toMatchObject({
      status: "finished",
      report: {
        error: "failed",
        code: "backend-error",
        message: expect.stringContaining("judge:required is required"),
      },
    });
  });
});

async function makeClaudeHubWithReport(
  report: unknown,
  routineDiagnosticsDir?: string,
) {
  const arcHost = await makeArcHostWithSource(
    "test",
    '"arc"; function Main() {}',
  );
  vi.spyOn(arcHost, "getRunWorkspaceContext").mockResolvedValue({
    ...context(),
    reactivationCount: 0,
  });
  const task = semanticTask();
  const query = vi.fn(() =>
    sdkTextMessages(JSON.stringify({ report })),
  ) as unknown as ClaudeSdkTstQueryFn;
  const { logger, records } = createCapturingLogger();
  const { workerHub } = makeWorkerHub({
    arcHost,
    logger,
    fastTriggerBackend: "claude-sdk-tst",
    claudeSdkTst: { query },
    routineDiagnosticsDir,
  });
  return { workerHub, task, records };
}

async function makeOpenAiHubWithReport(report: unknown) {
  const arcHost = await makeArcHostWithSource(
    "test",
    '"arc"; function Main() {}',
  );
  vi.spyOn(arcHost, "getRunWorkspaceContext").mockResolvedValue({
    ...context(),
    reactivationCount: 0,
  });
  const task = semanticTask();
  const run = vi.fn<OpenAiSdkTstRunFn>(async () => ({
    finalOutput: JSON.stringify({ report }),
    lastResponseId: "response:tst-validation",
  }));
  const { logger, records } = createCapturingLogger();
  const { workerHub } = makeWorkerHub({
    arcHost,
    logger,
    fastTriggerBackend: "openai-sdk-tst",
    openAiSdkTst: { apiKey: "sk-test", run },
  });
  return { workerHub, task, records };
}

function semanticTask(): Task {
  return {
    kind: "semantic",
    allowedDispositions: [],
    batchId: "semantic:tst-validation",
    role: "researcher",
    stage: "trigger",
    contextIsolation: "role",
    arcRunId: ARC_RUN_ID,
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    requests: [
      {
        kind: "judgment",
        briefId: "judge:required",
        role: "researcher",
        question: "Is it ready?",
        sourceRef: "node:test:Main",
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

function context() {
  return { workspacePath: process.cwd(), workspaceBundle: {} };
}
