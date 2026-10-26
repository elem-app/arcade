import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const pi = vi.hoisted(() => ({
  prompt: async (_prompt: string): Promise<string> => "",
}));
vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: class {
    state = { messages: [] as unknown[] };
    async prompt(prompt: string) {
      this.state.messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: await pi.prompt(prompt) }],
        },
      ];
    }
  },
}));

import { createPiAgentBackend } from "../src/backends/pi-agent-backend.js";
import type { RoutineInput, Worker } from "../src/index.js";
import {
  ClaudeSdkTstWorker,
  OpenAiSdkTstWorker,
  OpenAiSdkWorker,
  createArcadeLogger,
  noopRoutineEffects,
  type ClaudeSdkTstQueryFn,
} from "../src/testing.js";
import {
  callOpenAiTool,
  noopDiagnostics,
  routine,
  sdkTextMessages,
} from "./backend-helpers.js";
import { deferred, firstTask } from "./helpers.js";
import { openAiSemanticTask } from "./worker-hub-helpers.js";

describe("Stock worker concurrent invocation ownership", () => {
  it("keeps concurrent OpenAI tools diagnostics and provider pointers on their own routines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arcade-openai-overlap-"));
    const task = await firstTask();
    const entered = [deferred(), deferred()];
    const answer = [deferred<string>(), deferred<string>()];
    const observed: unknown[] = [];
    const diagnostics = [vi.fn(), vi.fn()];
    const controllers: AbortController[] = [];
    const worker = new OpenAiSdkWorker({
      apiKey: "test",
      run: async (input) => {
        const index = input.prompt?.includes("invocation:0") ? 0 : 1;
        controllers[index] = input.abortController;
        observed[index] = await callOpenAiTool(input.agent, "discuss", {
          audience: "originator",
          question: `question:${index}`,
        });
        expect(await input.checkSignal()).toBeUndefined();
        await callOpenAiTool(input.agent, "report", { outcome: "completed" });
        return { lastResponseId: `response:${index}` };
      },
    });
    const inputs: RoutineInput[] = [0, 1].map((index) => ({
      routine: routine(
        {
          ...task,
          arcRunId: `run:${index}`,
          texts: [
            [
              { kind: "text", value: `invocation:${index}: Discuss with ` },
              { kind: "entity", name: "user" },
            ],
          ],
        },
        { id: `routine:${index}`, contextKey: `context:${index}` },
      ),
      context: { workspacePath: directory, workspaceBundle: {} },
      effects: noopRoutineEffects({
        emit: async (message) => {
          expect(message.content).toBe(`question:${index}`);
          entered[index]!.resolve();
          return answer[index]!.promise;
        },
      }),
      diagnostics: {
        ...noopDiagnostics,
        writeJson: async (handle, value) => {
          diagnostics[index]!(handle, value);
        },
      },
    }));
    const pending = inputs.map((input) => worker.run(input));
    try {
      await Promise.all(entered.map((gate) => gate.promise));
      answer[1]!.resolve("answer:1");
      await expect(pending[1]).resolves.toMatchObject({
        outcome: "completed",
        backendDetails: { cwd: directory, responseId: "response:1" },
      });
      await worker.disposeRoutine({
        arcRunId: inputs[1]!.routine.arcRunId,
        routineId: inputs[1]!.routine.id,
      });
      expect(controllers[0]!.signal.aborted).toBe(false);
      expect(diagnostics[0]).not.toHaveBeenCalled();
      answer[0]!.resolve("answer:0");
      await expect(pending[0]).resolves.toMatchObject({
        outcome: "completed",
        backendDetails: { cwd: directory, responseId: "response:0" },
      });
      expect(observed).toEqual([
        { answer: "answer:0" },
        { answer: "answer:1" },
      ]);
      for (const index of [0, 1])
        expect(diagnostics[index]).toHaveBeenCalledWith(
          "sdk-result",
          expect.objectContaining({ lastResponseId: `response:${index}` }),
        );
    } finally {
      answer.forEach((gate) => gate.resolve("cleanup"));
      await Promise.allSettled(pending);
      await worker.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["openai", "claude"] as const)(
    "keeps overlapping %s trigger reports and diagnostics separate in a shared workspace",
    async (provider) => {
      const entered = [deferred(), deferred()];
      const release = [deferred(), deferred()];
      const writes = [vi.fn(), vi.fn()];
      let calls = 0;
      const report = (index: number) => ({
        outcome: "completed",
        semantic: { judgments: { [`judge:${index}`]: index === 0 } },
      });
      const worker: Worker =
        provider === "openai"
          ? new OpenAiSdkTstWorker({
              apiKey: "test",
              run: async ({ signal }) => {
                const index = calls++;
                entered[index]!.resolve();
                await release[index]!.promise;
                expect(signal.aborted).toBe(false);
                return {
                  finalOutput: JSON.stringify(report(index)),
                  lastResponseId: `response:${index}`,
                };
              },
            })
          : new ClaudeSdkTstWorker({
              fastStarts: { enabled: false },
              query: ((params) => {
                const index = calls++;
                expect(params.options?.cwd).toBe(process.cwd());
                return (async function* () {
                  entered[index]!.resolve();
                  await release[index]!.promise;
                  expect(params.options?.abortController?.signal.aborted).toBe(
                    false,
                  );
                  yield* sdkTextMessages(JSON.stringify(report(index)));
                })();
              }) as ClaudeSdkTstQueryFn,
            });
      const inputs: RoutineInput[] = [0, 1].map((index) => ({
        routine: routine(
          { ...openAiSemanticTask(), arcRunId: `run:${index}` },
          { id: `routine:${index}`, contextKey: `context:${index}` },
        ),
        context: { workspacePath: process.cwd(), workspaceBundle: {} },
        effects: noopRoutineEffects(),
        diagnostics: {
          ...noopDiagnostics,
          writeJson: async (handle, value) => {
            writes[index]!(handle, value);
          },
        },
      }));
      const pending = inputs.map((input) => worker.run(input));
      try {
        await Promise.all(entered.map((gate) => gate.promise));
        release[1]!.resolve();
        await expect(pending[1]).resolves.toMatchObject({
          ...report(1),
          backendDetails: { cwd: process.cwd() },
        });
        await worker.disposeRoutine({
          arcRunId: "run:1",
          routineId: "routine:1",
        });
        expect(writes[0]).not.toHaveBeenCalled();
        release[0]!.resolve();
        await expect(pending[0]).resolves.toMatchObject(report(0));
        expect(writes[0]).toHaveBeenCalled();
        expect(writes[1]).toHaveBeenCalled();
        expect(JSON.stringify(writes[0]!.mock.calls)).toContain("judge:0");
        expect(JSON.stringify(writes[0]!.mock.calls)).not.toContain("judge:1");
        expect(JSON.stringify(writes[1]!.mock.calls)).toContain("judge:1");
      } finally {
        release.forEach((gate) => gate.resolve());
        await Promise.allSettled(pending);
        await worker.stop?.();
      }
    },
  );

  it("keeps concurrent stock PI agents outbound handlers and diagnostics independent", async () => {
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const writes = [vi.fn(), vi.fn()];
    const emitted = [vi.fn(), vi.fn()];
    pi.prompt = async (prompt) => {
      const index = prompt.includes("invocation:0") ? 0 : 1;
      entered[index]!.resolve();
      await release[index]!.promise;
      return JSON.stringify({
        report: { outcome: "completed" },
        outbound: [
          { situation: { cause: "notice" }, content: `message:${index}` },
        ],
      });
    };
    const task = await firstTask();
    const worker = await createPiAgentBackend({
      agentOptions: {},
    }).createWorker(
      {
        logger: createArcadeLogger(),
        state: { get: async () => undefined, put: async () => {} },
      },
      { backend: "pi-agent", kind: "default" },
    );
    const inputs: RoutineInput[] = [0, 1].map((index) => ({
      routine: routine(
        {
          ...task,
          arcRunId: `run:${index}`,
          texts: [[{ kind: "text", value: `invocation:${index}` }]],
        },
        { id: `routine:${index}`, contextKey: `context:${index}` },
      ),
      context: { workspacePath: process.cwd(), workspaceBundle: {} },
      effects: noopRoutineEffects({
        emit: async (message) => {
          emitted[index]!(message);
        },
      }),
      diagnostics: {
        ...noopDiagnostics,
        writeJson: async (handle, value) => {
          writes[index]!(handle, value);
        },
      },
    }));
    const pending = inputs.map((input) => worker.run(input));
    try {
      await Promise.all(entered.map((gate) => gate.promise));
      release[1]!.resolve();
      await expect(pending[1]).resolves.toMatchObject({ outcome: "completed" });
      await worker.disposeRoutine({
        arcRunId: "run:1",
        routineId: "routine:1",
      });
      expect(emitted[0]).not.toHaveBeenCalled();
      release[0]!.resolve();
      await expect(pending[0]).resolves.toMatchObject({ outcome: "completed" });
      for (const index of [0, 1]) {
        expect(emitted[index]).toHaveBeenCalledExactlyOnceWith({
          situation: { audience: "originator", cause: "notice" },
          content: `message:${index}`,
        });
        expect(JSON.stringify(writes[index]!.mock.calls)).toContain(
          `message:${index}`,
        );
        expect(JSON.stringify(writes[index]!.mock.calls)).not.toContain(
          `message:${1 - index}`,
        );
      }
    } finally {
      release.forEach((gate) => gate.resolve());
      await Promise.allSettled(pending);
      await worker.stop?.();
    }
  });
});
