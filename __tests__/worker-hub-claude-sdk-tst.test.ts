import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WORKER_ROLE,
  type ClaudeSdkQueryFn,
  type ClaudeSdkTstQueryFn,
  type RoutineReport,
  type Task,
} from "../src/testing.js";
import {
  callSdkReport,
  sdkTextMessages as sdkMessages,
  semanticTool,
} from "./backend-helpers.js";
import {
  ARC_RUN_ID,
  firstTaskWithArcHost,
  makeArcHostWithSource,
  makeWorkerHub,
} from "./helpers.js";

describe("WorkerHubService Claude SDK semantic routing", () => {
  it("routes fast trigger work through the Claude SDK tst backend", async () => {
    const arcHost = await makeArcHostWithSource(
      "test",
      `"arc"; function Main() {}`,
    );
    vi.spyOn(arcHost, "getRunWorkspaceContext").mockResolvedValue({
      workspacePath: process.cwd(),
      workspaceBundle: {},
      reactivationCount: 0,
    });
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:claude-sdk",
      role: DEFAULT_WORKER_ROLE,
      stage: "trigger",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: { cursor: { user: 1, self: 0 }, lastTurns: [] },
      requests: [
        {
          kind: "judgment",
          briefId: "judge:fast",
          role: DEFAULT_WORKER_ROLE,
          question: "Is the user asking for help?",
          tool: semanticTool(),
          sourceRef: "node:test:Main",
        },
      ],
    };
    const query = vi.fn((_params: Parameters<ClaudeSdkTstQueryFn>[0]) =>
      sdkMessages(
        JSON.stringify({
          report: {
            outcome: "completed",
            semantic: { judgments: { "judge:fast": true } },
          },
        }),
      ),
    ) as unknown as ClaudeSdkTstQueryFn;
    const piRunner = vi.fn(async () => ({ outcome: "completed" as const }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      runner: piRunner,
      workerSlots: { default: "pi-agent" },
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTst: { query },
    });

    await expect(
      workerHub.handleTask(task, {
        workspacePath: process.cwd(),
        workspaceBundle: {},
      }),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        outcome: "completed",
        semantic: { judgments: { "judge:fast": true } },
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(piRunner).not.toHaveBeenCalled();
  });

  it("routes action semantic work through the default Claude SDK backend when fast trigger is configured", async () => {
    const workspace = join(tmpdir(), "arcade-worker-hub-action-semantic-sdk");
    await mkdir(workspace, { recursive: true });
    const { arcHost } = await firstTaskWithArcHost();
    const task: Task = {
      kind: "semantic",
      allowedDispositions: [],
      batchId: "semantic:action-sdk",
      role: DEFAULT_WORKER_ROLE,
      stage: "action",
      contextIsolation: "role",
      arcRunId: ARC_RUN_ID,
      dialog: {
        cursor: { user: 1, self: 0 },
        lastTurns: [{ role: "user", message: "research Lumentum" }],
      },
      requests: [
        {
          kind: "observation",
          briefId: "observe:isNew",
          role: DEFAULT_WORKER_ROLE,
          cell: "isNew",
          mode: "observe",
          question:
            "is Lumentum new in /Users/d/Projects/everynote/04_Investments/The Longlist.md?",
          currentValue: undefined,
          meta: { type: "boolean" },
          tool: observationTool(),
          sourceRef: "node:watch:Watch",
        },
      ],
    };
    const fastQuery = vi.fn(() => {
      throw new Error("action semantic should not use fast trigger");
    }) as unknown as ClaudeSdkTstQueryFn;
    const defaultPrompts: string[] = [];
    const defaultQueryMock = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkWorkerMessages(
        params,
        "session-action-semantic",
        {
          outcome: "completed",
          semantic: {
            observations: {
              "observe:isNew": { status: "resolved", value: true },
            },
          },
        },
        defaultPrompts,
      ),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      workerSlots: { default: "claude-sdk" },
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTst: { query: fastQuery },
      claudeSdk: {
        sessionCache: { enabled: false },
        query: defaultQueryMock as unknown as ClaudeSdkQueryFn,
      },
    });

    await expect(
      workerHub.handleTask(task, {
        workspacePath: workspace,
        workspaceBundle: {},
      }),
    ).resolves.toMatchObject({
      status: "finished",
      report: {
        outcome: "completed",
        semantic: {
          observations: {
            "observe:isNew": { status: "resolved", value: true },
          },
        },
      },
    });

    expect(fastQuery).not.toHaveBeenCalled();
    expect(defaultQueryMock).toHaveBeenCalledTimes(1);
    const call = defaultQueryMock.mock.calls[0]![0];
    expect(call.options?.cwd).toBe(workspace);
    expect(call.options?.tools).toEqual({
      type: "preset",
      preset: "claude_code",
    });
    const prompt = defaultPrompts[0]!;
    expect(prompt).toContain("<semantic-requests>");
    expect(prompt).toContain("</semantic-requests>");
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
  });
});

function observationTool() {
  return {
    type: "function" as const,
    name: "arc_observation_1",
    description: "Resolve observation.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["resolved", "unknown"] },
        value: { type: "boolean" },
      },
      required: ["status"],
      additionalProperties: false,
    },
    strict: true as const,
  };
}

async function* sdkWorkerMessages(
  params: Parameters<ClaudeSdkQueryFn>[0],
  sessionId: string,
  report: RoutineReport,
  prompts: string[],
) {
  const input = params.prompt as AsyncIterable<{
    message?: { content?: unknown };
  }>;
  const first = await input[Symbol.asyncIterator]().next();
  prompts.push(String(first.value?.message?.content ?? ""));
  await callSdkReport(params, report);
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
