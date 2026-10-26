import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ClaudeSdkTstQueryFn, OpenAiSdkTstRunFn } from "../src/testing.js";
import { sdkTextMessages } from "./backend-helpers.js";
import {
  ALICE_OWNER,
  collectAsync,
  createCapturingLogger,
  makeArcHostWithSource,
  makeWorkerHub,
} from "./helpers.js";
import {
  recordAdvanceInputs,
  semanticRequestIds,
  submitActivation,
} from "./worker-hub-helpers.js";

describe("Worker hub TST report validation", () => {
  it("records and removes Claude TST semantic drift at the worker hub boundary", async () => {
    const { workerHub, advanceInputs, records } = await makeClaudeHubWithReport(
      (id) => ({
        outcome: "completed",
        semantic: { judgments: { [id]: true, "judge:extra": false } },
      }),
    );

    await submitActivation(workerHub, "Is it ready?");
    expect(advanceInputs).toEqual([
      expect.objectContaining({
        reports: [
          expect.objectContaining({
            outcome: "completed",
            semantic: { judgments: { [onlyJudgmentId(advanceInputs)]: true } },
          }),
        ],
      }),
    ]);
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
    const { workerHub, advanceInputs, records } = await makeOpenAiHubWithReport(
      (id) => ({
        outcome: "completed",
        semantic: { judgments: { [id]: true, "judge:extra": false } },
      }),
    );

    await submitActivation(workerHub, "Is it ready?");
    expect(advanceInputs).toEqual([
      expect.objectContaining({
        reports: [
          expect.objectContaining({
            outcome: "completed",
            semantic: { judgments: { [onlyJudgmentId(advanceInputs)]: true } },
          }),
        ],
      }),
    ]);
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
    const { workerHub, records } = await makeClaudeHubWithReport(
      (id) => ({
        outcome: "completed",
        semantic: { judgments: { [id]: true } },
      }),
      diagnosticsDir,
    );

    await submitActivation(workerHub, "Is it ready?");

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
    const { workerHub } = await makeClaudeHubWithReport(() => ({
      outcome: "completed",
      semantic: { judgments: {} },
    }));

    const events = await collectAsync(
      workerHub.submitInbound({
        content: "Is it ready?",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    expect(events).toEqual([
      expect.objectContaining({
        kind: "failed",
        reason: expect.stringContaining("is required"),
      }),
    ]);
  });
});

const TRIGGER_SOURCE =
  '"arc"; function Main() { this.trigger = () => judge("Is it ready?"); }';

/** The single judgment id the recorded trigger report answered. */
function onlyJudgmentId(advanceInputs: unknown[]): string {
  const input = advanceInputs[0] as {
    reports: [{ semantic: { judgments: Record<string, boolean> } }];
  };
  const ids = Object.keys(input.reports[0].semantic.judgments);
  expect(ids).toHaveLength(1);
  return ids[0]!;
}

async function makeClaudeHubWithReport(
  report: (judgmentId: string) => unknown,
  routineDiagnosticsDir?: string,
) {
  const arcHost = await makeArcHostWithSource("test", TRIGGER_SOURCE);
  const advanceInputs = recordAdvanceInputs(arcHost);
  const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) =>
    sdkTextMessages(
      JSON.stringify({
        report: report(semanticRequestIds(String(params.prompt))[0]!),
      }),
    ),
  ) as unknown as ClaudeSdkTstQueryFn;
  const { logger, records } = createCapturingLogger();
  const { workerHub } = makeWorkerHub({
    arcHost,
    logger,
    fastTriggerBackend: "claude-sdk-tst",
    claudeSdkTst: { query },
    routineDiagnosticsDir,
  });
  return { workerHub, advanceInputs, records };
}

async function makeOpenAiHubWithReport(
  report: (judgmentId: string) => unknown,
) {
  const arcHost = await makeArcHostWithSource("test", TRIGGER_SOURCE);
  const advanceInputs = recordAdvanceInputs(arcHost);
  const run = vi.fn<OpenAiSdkTstRunFn>(async ({ prompt }) => ({
    finalOutput: JSON.stringify({
      report: report(semanticRequestIds(prompt)[0]!),
    }),
    lastResponseId: "response:tst-validation",
  }));
  const { logger, records } = createCapturingLogger();
  const { workerHub } = makeWorkerHub({
    arcHost,
    logger,
    fastTriggerBackend: "openai-sdk-tst",
    openAiSdkTst: { apiKey: "sk-test", run },
  });
  return { workerHub, advanceInputs, records };
}
