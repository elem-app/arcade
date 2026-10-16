import { tmpdir } from "node:os";

import { Agent, Runner, type Model } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeSdkWorker,
  createClaudeSdkBackendForTesting,
  type ClaudeSdkQueryFn,
} from "../src/backends/claude-sdk-backend.js";
import * as continuityModule from "../src/backends/continuity.js";
import { createContinuityController } from "../src/backends/continuity.js";
import {
  OpenAiSdkWorker,
  createOpenAiSdkBackendForTesting,
  type OpenAiRunState,
  type OpenAiSdkRunFn,
} from "../src/backends/openai-sdk-backend.js";
import {
  AgentRoutineReportSchema,
  RoutineReportSchema,
  type RoutineInput,
  type RoutineSignal,
  type WorkerHost,
} from "../src/index.js";
import { noopRoutineEffects } from "../src/testing.js";
import { noopDiagnostics, routine } from "./backend-helpers.js";
import { createCapturingLogger, firstTask } from "./helpers.js";

describe("Routine control contract", () => {
  it.each(["openai", "claude"] as const)(
    "delegates %s routine disposal through the factory and releases continuity after failure",
    async (provider) => {
      const original = continuityModule.createContinuityController;
      let disposedIdentity = vi.fn<(routineId: string) => void>();
      const controllerSpy = vi
        .spyOn(continuityModule, "createContinuityController")
        .mockImplementation((options) => {
          const controller = original(options);
          disposedIdentity = vi.fn(controller.disposeRoutine);
          controller.disposeRoutine = disposedIdentity;
          return controller;
        });
      const prototype =
        provider === "openai"
          ? OpenAiSdkWorker.prototype
          : ClaudeSdkWorker.prototype;
      const release = vi
        .spyOn(prototype, "disposeRoutine")
        .mockRejectedValueOnce(new Error("release failed"));
      const input = await routineInput();
      const backend =
        provider === "openai"
          ? createOpenAiSdkBackendForTesting({ apiKey: "test" })
          : createClaudeSdkBackendForTesting();
      const worker = await backend.createWorker(
        {
          logger: createCapturingLogger().logger,
          state: { get: async () => undefined, put: async () => {} },
        },
        { kind: "default", backend: `${provider}-sdk` },
      );
      try {
        await expect(worker.disposeRoutine(disposal(input))).rejects.toThrow(
          "release failed",
        );
        expect(release).toHaveBeenCalledWith(disposal(input));
        expect(disposedIdentity).toHaveBeenCalledWith(input.routine.id);
        await worker.disposeRoutine(disposal(input));
        expect(disposedIdentity).toHaveBeenCalledTimes(2);
      } finally {
        release.mockRestore();
        controllerSpy.mockRestore();
        await worker.stop?.();
      }
    },
  );

  it("disposes only the owning Claude routine retry state", async () => {
    const query = async function* () {
      yield { type: "system", subtype: "init", session_id: "retained-session" };
      throw Object.assign(new Error("Connection reset"), {
        code: "ECONNRESET",
      });
    } as unknown as ClaudeSdkQueryFn;
    const worker = new ClaudeSdkWorker({
      query,
      sessionCache: { enabled: false },
    });
    const first = await routineInput();
    const second = {
      ...first,
      routine: { ...first.routine, id: "other-routine" },
    };
    try {
      await expect(worker.run(first)).resolves.toMatchObject({
        suspension: "transport-lost",
      });
      await expect(worker.run(second)).resolves.toMatchObject({
        suspension: "transport-lost",
      });
      expect(worker.hasRetryState(first.routine.id)).toBe(true);
      expect(worker.hasRetryState(second.routine.id)).toBe(true);
      await worker.disposeRoutine(disposal(first));
      await worker.disposeRoutine(disposal(first));
      expect(worker.hasRetryState(first.routine.id)).toBe(false);
      expect(worker.hasRetryState(second.routine.id)).toBe(true);
    } finally {
      await worker.stop();
    }
  });
  it("accepts exactly one of the four worker report discriminators", () => {
    const reports = [
      { outcome: "completed" },
      { suspension: "paused" },
      { cancellation: "superseded" },
      { error: "failed", code: "failed", message: "failed" },
    ];
    for (const [index, report] of reports.entries()) {
      expect(RoutineReportSchema.safeParse(report).success).toBe(true);
      for (const other of reports.slice(index + 1)) {
        expect(
          RoutineReportSchema.safeParse({ ...report, ...other }).success,
        ).toBe(false);
      }
    }
    expect(RoutineReportSchema.safeParse({ interrupt: "paused" }).success).toBe(
      false,
    );
    expect(
      RoutineReportSchema.safeParse({
        cancellation: "superseded",
        semantic: {},
      }).success,
    ).toBe(false);
    for (const report of [
      { suspension: "paused" },
      { cancellation: "superseded" },
    ]) {
      expect(AgentRoutineReportSchema.safeParse(report).success).toBe(false);
    }
  });

  it("clears disposed routine continuity identity without erasing shared durable history", async () => {
    const input = await routineInput();
    const writes = vi.fn(async () => {});
    const host: WorkerHost = {
      logger: createCapturingLogger().logger,
      state: { get: async () => undefined, put: writes },
    };
    const clear = vi.fn();
    const continuity = createContinuityController({
      backend: "openai-sdk",
      host,
      slot: { kind: "role", backend: "openai-sdk", role: input.routine.role },
      continuityField: "responseId",
      seed: vi.fn(),
      clear,
      resolveIdentity: async () => ({
        schema: 1,
        provider: "openai",
        endpoint: "test",
        credentialScope: "test",
      }),
    });
    await continuity.prepareRun(input);
    continuity.finish(input.routine.id, true);
    clear.mockClear();
    continuity.disposeRoutine(input.routine.id);
    continuity.disposeRoutine(input.routine.id);
    await continuity.persistObserved(
      input.routine,
      input.routine.contextKey,
      "response-after-disposal",
      tmpdir(),
    );
    expect(writes).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("disposes only the owning OpenAI routine parked and retry states", async () => {
    const first = await routineInput();
    const second = {
      ...first,
      routine: { ...first.routine, id: "routine-second" },
    };
    const state = {} as OpenAiRunState;
    const run = vi.fn<OpenAiSdkRunFn>(async () => ({
      signal: { kind: "pause" },
      state,
    }));
    const worker = new OpenAiSdkWorker({ apiKey: "test", run });
    await expect(worker.run(first)).resolves.toMatchObject({
      suspension: "paused",
    });
    await expect(worker.run(second)).resolves.toMatchObject({
      suspension: "paused",
    });
    await worker.disposeRoutine(disposal(first));
    await expect(
      worker.run(second, { delivery: "native" }),
    ).resolves.toMatchObject({ suspension: "paused" });
    expect(run.mock.calls[2]![0].resumeState).toBe(state);
    await worker.disposeRoutine(disposal(second));
    await worker.disposeRoutine(disposal(second));
    await expect(worker.run(second, { delivery: "native" })).rejects.toThrow(
      "has no parked RunState",
    );
    run.mockImplementation(async () => ({
      failureReport: {
        suspension: "transport-lost",
        reason: { reason: "network timeout", message: "connection lost" },
      },
      state,
    }));
    await worker.run(first);
    expect(worker.hasRetryState(first.routine.id)).toBe(true);
    await worker.disposeRoutine(disposal(first));
    expect(worker.hasRetryState(first.routine.id)).toBe(false);
    await worker.stop();
  });

  it("preserves cancellation through the OpenAI SDK streaming abort", async () => {
    const input = await routineInput({ kind: "cancel" });
    const model: Model = {
      getResponse: async () => {
        throw new Error("Unexpected non-streaming request");
      },
      async *getStreamedResponse() {
        yield {
          type: "response_done",
          response: {
            id: "signal-response",
            usage: {
              requests: 1,
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
            output: [
              {
                type: "function_call",
                callId: "signal-tool",
                name: "emit_outbound",
                arguments: JSON.stringify({
                  audience: "originator",
                  content: "Finished tool",
                }),
              },
            ],
          },
        };
      },
    };
    const original = Runner.prototype.run;
    const spy = vi.spyOn(Runner.prototype, "run").mockImplementation(function (
      this: Runner,
      agent,
      value,
      options,
    ) {
      return original.call(
        this,
        new Agent({ name: agent.name, tools: agent.tools, model }),
        value,
        options,
      );
    });
    const worker = new OpenAiSdkWorker({ apiKey: "test" });
    try {
      await expect(worker.run(input)).resolves.toMatchObject({
        cancellation: "superseded",
      });
      expect(worker.hasRetryState(input.routine.id)).toBe(false);
      await expect(worker.run(input, { delivery: "native" })).rejects.toThrow(
        "has no parked RunState",
      );
    } finally {
      spy.mockRestore();
      await worker.stop();
    }
  });

  it("disposes only the owning Claude routine live session", async () => {
    const first = await routineInput({ kind: "pause" });
    const second = {
      ...first,
      routine: { ...first.routine, id: "routine-second" },
    };
    const { query, close } = signalQuery();
    const worker = new ClaudeSdkWorker({
      query,
      sessionCache: { enabled: true, maxPreparedStarts: 0 },
    });
    await expect(worker.run(first)).resolves.toMatchObject({
      suspension: "paused",
    });
    await expect(worker.run(second)).resolves.toMatchObject({
      suspension: "paused",
    });
    await worker.disposeRoutine(disposal(first));
    expect(close).not.toHaveBeenCalled();
    await worker.disposeRoutine(disposal(second));
    await worker.disposeRoutine(disposal(second));
    expect(close).toHaveBeenCalledTimes(1);
    await worker.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("preserves cancellation through the Claude SDK interrupt and closes its continuation", async () => {
    const input = await routineInput({ kind: "cancel" });
    const { query, close, interrupt } = signalQuery();
    const worker = new ClaudeSdkWorker({
      query,
      sessionCache: { enabled: true, maxPreparedStarts: 0 },
    });
    await expect(worker.run(input)).resolves.toMatchObject({
      cancellation: "superseded",
    });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(worker.hasRetryState(input.routine.id)).toBe(false);
    await worker.disposeRoutine(disposal(input));
    await worker.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

async function routineInput(signal?: RoutineSignal): Promise<RoutineInput> {
  return {
    routine: routine(await firstTask()),
    context: { workspacePath: tmpdir(), workspaceBundle: {} },
    effects: noopRoutineEffects({ checkSignal: async () => signal }),
    diagnostics: noopDiagnostics,
  };
}

function disposal(input: RoutineInput) {
  return { arcRunId: input.routine.arcRunId, routineId: input.routine.id };
}

function signalQuery() {
  const close = vi.fn();
  const interrupt = vi.fn(async () => {});
  const query = (({ prompt }: { prompt: AsyncIterable<unknown> }) => {
    async function* messages() {
      for await (const _ of prompt) {
        yield {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "signal-tool",
                content: "done",
              },
            ],
          },
        };
        yield {
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "stopped",
          session_id: "signal-session",
        };
      }
    }
    return Object.assign(messages(), {
      close,
      interrupt,
      setModel: vi.fn(async () => {}),
    });
  }) as unknown as ClaudeSdkQueryFn;
  return { query, close, interrupt };
}
