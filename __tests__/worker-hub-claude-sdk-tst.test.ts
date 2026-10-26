import { describe, expect, it, vi } from "vitest";

import {
  type ClaudeSdkQueryFn,
  type ClaudeSdkTstQueryFn,
  type RoutineReport,
} from "../src/testing.js";
import {
  callSdkReport,
  sdkTextMessages as sdkMessages,
} from "./backend-helpers.js";
import { makeArcHostWithSource, makeWorkerHub } from "./helpers.js";
import { executionControlFor } from "./work-event-fixtures.js";
import {
  exampleSemanticReport,
  semanticRequestIds,
  settleFirstRoutine,
  submitActivation,
} from "./worker-hub-helpers.js";

describe("WorkerHubService Claude SDK semantic routing", () => {
  it("routes fast trigger work through the Claude SDK tst backend", async () => {
    const arcHost = await makeArcHostWithSource(
      "test",
      `"arc"; function Main() { this.trigger = () => judge(\`Is the user asking for help?\`); }`,
    );
    const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) =>
      sdkMessages(
        JSON.stringify({
          report: {
            outcome: "completed",
            semantic: {
              judgments: Object.fromEntries(
                semanticRequestIds(String(params.prompt)).map((id) => [
                  id,
                  true,
                ]),
              ),
            },
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

    await submitActivation(workerHub, "Can you help me?");
    expect(query).toHaveBeenCalledTimes(1);
    expect(piRunner).not.toHaveBeenCalled();
  });

  it("routes action semantic work through the default Claude SDK backend when fast trigger is configured", async () => {
    const arcHost = await makeArcHostWithSource(
      "watch",
      `"arc";
function Watch() {
  this.trigger = () => true;
  let isNew = Bool({
    observing: \`is Lumentum new in /Users/d/Projects/everynote/04_Investments/The Longlist.md?\`,
  });
  $observe(isNew);
}`,
    );
    const routineStore = executionControlFor(arcHost);
    const fastQuery = vi.fn(() => {
      throw new Error("action semantic should not use fast trigger");
    }) as unknown as ClaudeSdkTstQueryFn;
    const defaultPrompts: string[] = [];
    const defaultQueryMock = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) =>
      sdkWorkerMessages(
        params,
        "session-action-semantic",
        exampleSemanticReport,
        defaultPrompts,
      ),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      routineStore,
      workerSlots: { default: "claude-sdk" },
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTst: { query: fastQuery },
      claudeSdk: {
        sessionCache: { enabled: false },
        query: defaultQueryMock as unknown as ClaudeSdkQueryFn,
      },
    });

    const { arcRunId, routine } = await settleFirstRoutine(
      workerHub,
      routineStore,
      "research Lumentum",
    );
    expect(routine.status).toBe("finished");
    expect(fastQuery).not.toHaveBeenCalled();
    expect(defaultQueryMock).toHaveBeenCalledTimes(1);
    const call = defaultQueryMock.mock.calls[0]![0];
    expect(call.options?.cwd).toBe(
      (await arcHost.getRunWorkspaceContext(arcRunId)).workspacePath,
    );
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
    expect(prompt).toContain('{"status":"resolved","value":true}');
  });
});

async function* sdkWorkerMessages(
  params: Parameters<ClaudeSdkQueryFn>[0],
  sessionId: string,
  report: (prompt: string) => RoutineReport,
  prompts: string[],
) {
  const input = params.prompt as AsyncIterable<{
    message?: { content?: unknown };
  }>;
  const first = await input[Symbol.asyncIterator]().next();
  const prompt = String(first.value?.message?.content ?? "");
  prompts.push(prompt);
  await callSdkReport(params, report(prompt));
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
