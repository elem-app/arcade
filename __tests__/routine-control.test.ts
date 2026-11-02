import { tmpdir } from "node:os";

import { Agent, Runner, type Model } from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import {
  ClaudeSdkWorker,
  createClaudeSdkBackendForTesting,
  type ClaudeSdkQueryFn,
} from "../src/backends/claude-sdk-backend.js";
import { createContinuityPreparation } from "../src/backends/continuity.js";
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
import { noopRoutineEffects, probeRetention } from "../src/testing.js";
import { noopDiagnostics, routine } from "./backend-helpers.js";
import { createCapturingLogger, firstTask } from "./helpers.js";

describe("Routine control contract", () => {
  it.each(["routine", "worker"] as const)(
    "releases Claude live ownership and sibling resources after a %s transport close failure",
    async (boundary) => {
      const input = await routineInput({ kind: "pause" });
      const queries: ReturnType<typeof signalQuery>[] = [];
      const worker = new ClaudeSdkWorker({
        sessionCache: { maxPreparedStarts: 0 },
        query: ((params) => {
          const state = signalQuery();
          queries.push(state);
          if (queries.length === 1)
            state.close.mockImplementation(() => {
              throw new Error("transport close failed");
            });
          return state.query(params);
        }) as ClaudeSdkQueryFn,
      });
      const inputs = [0, 1].map((index) => ({
        ...input,
        routine: {
          ...input.routine,
          id: `cleanup-routine-${index}`,
          contextKey: `cleanup-context-${index}`,
        },
      }));
      await Promise.all(inputs.map((item) => worker.run(item)));
      expect(probeRetention(worker).liveRoutines).toBe(2);
      if (boundary === "routine") {
        await expect(
          worker.disposeRoutine(disposal(inputs[0]!)),
        ).rejects.toThrow("Claude routine cleanup failed");
        expect(probeRetention(worker).liveRoutines).toBe(1);
        await worker.stop();
      } else
        await expect(worker.stop()).rejects.toThrow(
          "Claude worker cleanup failed",
        );
      expect(probeRetention(worker)).toMatchObject({
        liveRoutines: 0,
        retryRoutines: 0,
        grantContexts: 0,
        preparedStarts: 0,
      });
      for (const query of queries) expect(query.close).toHaveBeenCalledTimes(1);
      await worker.stop();
    },
  );

  it.each(["openai", "claude"] as const)(
    "delegates %s routine disposal through the factory and preserves cleanup failure",
    async (provider) => {
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
        await worker.disposeRoutine(disposal(input));
        expect(release).toHaveBeenCalledTimes(2);
      } finally {
        release.mockRestore();
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
    const continuity = createContinuityPreparation({
      backend: "openai-sdk",
      host,
      slot: { kind: "role", backend: "openai-sdk", role: input.routine.role },
      continuityField: "responseId",
      resolveIdentity: async () => ({
        schema: 1,
        provider: "openai",
        endpoint: "test",
        credentialScope: "test",
      }),
    });
    const preparation = await continuity(input);
    await preparation.observe("accepted");
    await preparation.close();
    await preparation.close();
    await preparation.observe("response-after-disposal");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith(
      input.routine.arcRunId,
      input.routine.contextKey,
      expect.objectContaining({ responseId: "accepted" }),
    );
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
    input.effects.checkSignal = vi
      .fn<() => Promise<RoutineSignal | undefined>>()
      .mockResolvedValue({ kind: "cancel" })
      .mockResolvedValueOnce(undefined);
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
      input.effects.checkSignal = async () => undefined;
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
    expect(close).toHaveBeenCalledTimes(1);
    await worker.disposeRoutine(disposal(second));
    await worker.disposeRoutine(disposal(second));
    expect(close).toHaveBeenCalledTimes(2);
    await worker.stop();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation through the Claude SDK interrupt and closes its continuation", async () => {
    const input = await routineInput({ kind: "cancel" });
    input.effects.checkSignal = vi
      .fn<() => Promise<RoutineSignal | undefined>>()
      .mockResolvedValue({ kind: "cancel" })
      .mockResolvedValueOnce(undefined);
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

  it("retains nineteen paused Claude continuations beyond prepared-start expiry", async () => {
    const input = await routineInput({ kind: "pause" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const queries: ReturnType<typeof signalQuery>[] = [];
    const worker = new ClaudeSdkWorker({
      sessionCache: { maxPreparedStarts: 0, idleTtlMs: 10 },
      query: ((params) => {
        const state = signalQuery();
        queries.push(state);
        return state.query(params);
      }) as ClaudeSdkQueryFn,
    });
    const inputs = Array.from({ length: 19 }, (_, index) => ({
      ...input,
      routine: {
        ...input.routine,
        id: `routine:${index}`,
        arcRunId: `run:${index}`,
        contextKey: `context:${index}`,
      },
    }));
    try {
      const reports = await Promise.all(
        inputs.slice(0, 18).map((item) => worker.run(item)),
      );
      expect(reports.every((report) => report.suspension === "paused")).toBe(
        true,
      );
      clock.mockReturnValue(1000000);
      await expect(worker.run(inputs[18]!)).resolves.toMatchObject({
        suspension: "paused",
      });
      expect(queries).toHaveLength(19);
      for (const query of queries) expect(query.close).not.toHaveBeenCalled();
      await worker.disposeRoutine(disposal(inputs[7]!));
      expect(queries[7]!.close).toHaveBeenCalledTimes(1);
      for (const [index, query] of queries.entries())
        if (index !== 7) expect(query.close).not.toHaveBeenCalled();
      await expect(worker.run(inputs[0]!)).resolves.toMatchObject({
        suspension: "paused",
        backendDetails: { liveSessionReused: true },
      });
      expect(queries).toHaveLength(19);
    } finally {
      await worker.stop();
      clock.mockRestore();
    }
    for (const query of queries) expect(query.close).toHaveBeenCalledTimes(1);
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

describe("Invocation continuity ownership", () => {
  it("orders accepted continuity writes and awaits them while fencing callbacks after disposal", async () => {
    const input = await routineInput();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const put = vi.fn(async (_run: string, _key: string, value: unknown) => {
      started.push((value as { responseId: string }).responseId);
      if (started.length === 1) await held;
    });
    const prepare = createContinuityPreparation({
      backend: "openai-sdk",
      host: {
        logger: createCapturingLogger().logger,
        state: { get: async () => undefined, put },
      },
      slot: { backend: "openai-sdk", kind: "default" },
      continuityField: "responseId",
      resolveIdentity: async () => ({
        schema: 1,
        provider: "openai",
        endpoint: "test",
        credentialScope: "scope",
      }),
    });
    const preparation = await prepare(input);
    const first = preparation.observe("first");
    const second = preparation.observe("second");
    let closed = false;
    const closing = preparation.close().then(() => {
      closed = true;
    });
    await preparation.observe("late");
    expect(started).toEqual(["first"]);
    expect(closed).toBe(false);
    release();
    await Promise.all([first, second, closing]);
    expect(started).toEqual(["first", "second"]);
    expect(closed).toBe(true);
    await preparation.observe("after-close");
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("preserves continuity write failures through invocation disposal without accepting later writes", async () => {
    const input = await routineInput();
    const failure = new Error("state unavailable");
    const put = vi.fn(async () => {
      throw failure;
    });
    const prepare = createContinuityPreparation({
      backend: "claude-sdk",
      host: {
        logger: createCapturingLogger().logger,
        state: { get: async () => undefined, put },
      },
      slot: { backend: "claude-sdk", kind: "default" },
      continuityField: "sessionId",
      resolveIdentity: async () => ({
        schema: 1,
        provider: "claude",
        endpoint: "test",
        credentialScope: "scope",
      }),
    });
    const preparation = await prepare(input);
    await expect(preparation.observe("first")).rejects.toBe(failure);
    await expect(preparation.close()).rejects.toBe(failure);
    await preparation.observe("late");
    expect(put).toHaveBeenCalledTimes(1);
  });

  it.each(["openai", "claude"] as const)(
    "fences %s provider admission when stop overlaps durable continuity preparation",
    async (provider) => {
      const input = await routineInput();
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entering = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const host: WorkerHost = {
        logger: createCapturingLogger().logger,
        state: {
          get: async () => {
            entered();
            await held;
            return undefined;
          },
          put: vi.fn(),
        },
      };
      const resolveContinuityIdentity = async () => ({
        schema: 1 as const,
        provider,
        endpoint: "test",
        credentialScope: "scope",
      });
      const run = vi.fn();
      const query = vi.fn();
      const backend =
        provider === "openai"
          ? createOpenAiSdkBackendForTesting({
              run,
              apiKey: "test",
              resolveContinuityIdentity,
            })
          : createClaudeSdkBackendForTesting({
              query: query as unknown as ClaudeSdkQueryFn,
              sessionCache: { enabled: false },
              resolveContinuityIdentity,
            });
      const worker = await backend.createWorker(host, {
        backend: `${provider}-sdk`,
        kind: "default",
      });
      const running = worker.run(input);
      await entering;
      await worker.stop?.();
      release();
      await expect(running).resolves.toEqual({ cancellation: "superseded" });
      expect(run).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(host.state.put).not.toHaveBeenCalled();
    },
  );
});
