import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";
import { createTestArcHost } from "./work-event-fixtures.js";

import {
  InMemoryArcHostStore,
  arcRunKey,
  type ClaudeSdkQueryFn,
  type ClaudeSdkTstQueryFn,
  type OpenAiSdkRunFn,
  type RoleWorker,
} from "../src/testing.js";
import { callOpenAiTool } from "./backend-helpers.js";
import {
  ALICE_OWNER,
  WATCH_SOURCE,
  collectAsync,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import {
  attachToActiveRun,
  claudeSemanticMessages,
  claudeStreamingQuery,
  claudeThrowingQuery,
  recordAdvanceInputs,
  semanticRequestIds,
  submitActivation,
} from "./worker-hub-helpers.js";

describe("Recoverable parks and execution control", () => {
  it("parks and resumes a claude-sdk api-rate-limit instruction", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc("watch", parse(WATCH_SOURCE));
    const advanceInputs = recordAdvanceInputs(arcHost);
    let calls = 0;
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      calls += 1;
      if (calls === 1) {
        return claudeThrowingQuery(
          Object.assign(new Error("rate_limit_error: requests too high"), {
            status: 429,
            type: "rate_limit_error",
          }),
        );
      }
      return claudeStreamingQuery(params);
    });
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "capacity-limited";
    });
    const blocked = await routineStore.getExecutionControl(arcRunId);
    expect(blocked).toMatchObject({
      status: "capacity-limited",
      capacityReason: {
        reason: "api rate limit",
        provider: "anthropic",
        backend: "claude-sdk",
      },
    });
    const [blockedRoutine] = await collectAsync(
      routineStore.listRoutines(arcRunId),
    );
    expect(blockedRoutine?.status).toBe("capacity-limited");
    const blockEvents = (
      await collectAsync(workEventStore.listEvents(arcRunId))
    ).filter((event) => event.kind === "routine:capacity-limited");
    expect(blockEvents).toHaveLength(1);
    expect(blockEvents[0]).toMatchObject({
      kind: "routine:capacity-limited",
      capacityReason: { reason: "api rate limit" },
    });
    expect(advanceInputs).toHaveLength(0);
    await expect(store.getState(arcRunKey(arcRunId))).resolves.toEqual(
      expect.objectContaining({
        lifecycle: expect.not.stringMatching(/poisoned/),
      }),
    );

    await attachToActiveRun(workerHub, arcRunId);
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual(
      blocked,
    );
    await expect(routineStore.getRoutine(blockedRoutine!.id)).resolves.toEqual(
      blockedRoutine,
    );
    expect(advanceInputs).toHaveLength(0);

    await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
    });
    await waitFor(() => advanceInputs.length === 1);
    expect(calls).toBe(2);
    expect(advanceInputs[0]).toMatchObject({
      instructionCoverage: {
        "instruction:[arc:watch:Watch]:[node:watch:Watch]:body/0": "applied",
      },
    });
  });

  it("parks and resumes an openai-sdk token-usage-limit instruction", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc("watch", parse(WATCH_SOURCE));
    const advanceInputs = recordAdvanceInputs(arcHost);
    const run = vi.fn<OpenAiSdkRunFn>(async (input) => {
      if (run.mock.calls.length === 1) {
        throw Object.assign(new Error("You exceeded your current quota."), {
          status: 429,
          code: "insufficient_quota",
        });
      }
      await callOpenAiTool(input.agent, "report", { outcome: "completed" });
      return { lastResponseId: "resp-resumed" };
    });
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "openai-sdk" } },
      openAiSdk: { apiKey: "sk-test", run },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "capacity-limited";
    });
    expect(await routineStore.getExecutionControl(arcRunId)).toMatchObject({
      status: "capacity-limited",
      capacityReason: {
        reason: "token usage limit",
        provider: "openai",
        backend: "openai-sdk",
      },
    });
    const blockEvents = (
      await collectAsync(workEventStore.listEvents(arcRunId))
    ).filter((event) => event.kind === "routine:capacity-limited");
    expect(blockEvents).toHaveLength(1);
    expect(advanceInputs).toHaveLength(0);
    await expect(store.getState(arcRunKey(arcRunId))).resolves.toEqual(
      expect.objectContaining({
        lifecycle: expect.not.stringMatching(/poisoned/),
      }),
    );

    await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
    });
    await waitFor(() => advanceInputs.length === 1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("blocks a fast-trigger capacity limit failure rather than producing a failed trigger", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "ready",
      parse(`
"arc";

function Ready() {
  this.hostParams = {
    workerRole: "responder",
  };
  this.trigger = () => {
    return judge(\`is the user ready\`);
  };
  $instruct(\`Welcome the user.\`);
}
`),
    );
    const advanceInputs = recordAdvanceInputs(arcHost);
    const query = vi.fn(() =>
      claudeThrowingQuery(
        Object.assign(new Error("rate_limit_error: requests too high"), {
          status: 429,
          type: "rate_limit_error",
        }),
      ),
    );
    const piRunner = vi.fn(async () => ({ outcome: "completed" as const }));
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      runner: piRunner,
      workerSlots: { default: "pi-agent" },
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTst: {
        query: query as unknown as ClaudeSdkTstQueryFn,
      },
    });

    // The submission parks during semantic trigger resolution — before any run
    // activates — so no lifecycle event carries its (volatile) trigger-turn id.
    // Discover it through the dispatched routine instead.
    void workerHub.submitInbound({
      content: "am I ready",
      metadata: { principal: ALICE_OWNER },
    });

    let arcRunId: string | undefined;
    await waitFor(async () => {
      const routines = await collectAsync(routineStore.listRoutines());
      arcRunId = routines[0]?.arcRunId;
      return arcRunId !== undefined;
    });
    if (arcRunId === undefined) {
      throw new Error("expected a dispatched trigger routine");
    }

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId!);
      return control?.status === "capacity-limited";
    });
    expect(await routineStore.getExecutionControl(arcRunId)).toMatchObject({
      status: "capacity-limited",
      capacityReason: { reason: "api rate limit", backend: "claude-sdk-tst" },
    });
    // The trigger semantic frontier parked; it never produced a failed report
    // and never advanced arc host, so the run is not poisoned.
    expect(advanceInputs).toHaveLength(0);
    const state = await store.getState(arcRunKey(arcRunId));
    expect(state?.lifecycle).not.toBe("poisoned");
  });

  it("settles a semantic trigger through the hub queue and activates via advanceTrigger", async () => {
    // The trigger stage advances through the hub the same way as the action
    // stage: the trigger semantic frontier's results route back as a
    // `task-results` event whose stage drives advanceTrigger (not advanceAction),
    // and the settled trigger fans out into an activated run. This exercises the
    // hub-level trigger→advanceTrigger→dispatch path the arc host round-trip unit
    // test cannot reach.
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc(
      "ready",
      parse(`
"arc";
function Ready() {
  this.hostParams = { workerRole: "responder" };
  this.trigger = () => { return judge(\`is the user ready\`); };
  $instruct(\`Welcome the user.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      { workspacePath: "/tmp/ready-ws" },
    );
    const advanceSpy = vi.spyOn(arcHost, "advanceTrigger");
    const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) =>
      claudeSemanticMessages({
        report: {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              semanticRequestIds(String(params.prompt)).map((id) => [id, true]),
            ),
          },
        },
      }),
    );
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { responder: worker },
      fastTriggerBackend: "claude-sdk-tst",
      claudeSdkTst: { query: query as unknown as ClaudeSdkTstQueryFn },
    });

    void workerHub.submitInbound({
      content: "am I ready",
      metadata: { principal: ALICE_OWNER },
    });

    // The settled trigger fans out and its instruction reaches the action worker.
    await waitFor(() => worker.mock.calls.length === 1);
    // The trigger advanced through advanceTrigger (its stage), not advanceAction.
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    const activationTask = worker.mock.calls[0]![0];
    expect(activationTask.kind).toBe("instruction");
  });

  it.each(["capacity-limited", "transport-lost"] as const)(
    "auto-resumes a trigger-stage %s park through advanceTrigger",
    async (park) => {
      // A capacity limit during SEMANTIC TRIGGER resolution parks in-process. Unlike
      // an activated run, a trigger-stage park has no published run view yet (state
      // is published at activation), so resume keys off the in-process continuation.
      // The scheduled backoff re-runs the trigger, which settles and fans out —
      // advancing through advanceTrigger (its stage).
      const store = new InMemoryArcHostStore();
      const arcHost = await createTestArcHost({ store });
      await arcHost.registerArc(
        "ready",
        parse(`
"arc";
function Ready() {
  this.hostParams = { workerRole: "responder" };
  this.trigger = () => { return judge(\`is the user ready\`); };
  $instruct(\`Welcome the user.\`);
}
`),
        { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
        { workspacePath: "/tmp/ready-ws" },
      );
      const advanceSpy = vi.spyOn(arcHost, "advanceTrigger");
      let calls = 0;
      const query = vi.fn((params: Parameters<ClaudeSdkTstQueryFn>[0]) => {
        calls += 1;
        if (calls === 1) {
          return claudeThrowingQuery(
            park === "capacity-limited"
              ? Object.assign(
                  new Error("rate_limit_error: requests too high"),
                  { status: 429, type: "rate_limit_error" },
                )
              : Object.assign(new Error("socket hang up"), {
                  code: "ECONNRESET",
                }),
          );
        }
        return claudeSemanticMessages({
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
        });
      });
      const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
      const scheduled: { callback: () => void; delayMs: number }[] = [];
      const { workerHub, routineStore } = makeWorkerHub({
        arcHost,
        workers: { responder: worker },
        fastTriggerBackend: "claude-sdk-tst",
        claudeSdkTst: { query: query as unknown as ClaudeSdkTstQueryFn },
        capacityRetry: {
          enabled: true,
          baseDelayMs: 50,
          schedule: (callback, delayMs) => {
            scheduled.push({ callback, delayMs });
            return () => {};
          },
        },
      });

      void workerHub.submitInbound({
        content: "am I ready",
        metadata: { principal: ALICE_OWNER },
      });

      let arcRunId: string | undefined;
      await waitFor(async () => {
        const routines = await collectAsync(routineStore.listRoutines());
        arcRunId = routines[0]?.arcRunId;
        return arcRunId !== undefined;
      });
      if (arcRunId === undefined) {
        throw new Error("expected a dispatched trigger routine");
      }
      await waitFor(async () => {
        const control = await routineStore.getExecutionControl(arcRunId!);
        return control?.status === park;
      });
      // Parked on the trigger judgment: it has not advanced yet, and a backoff is
      // scheduled even though no run view exists for the volatile trigger-turn id.
      expect(advanceSpy).not.toHaveBeenCalled();
      expect(scheduled).toHaveLength(1);
      expect(await store.getState(arcRunKey(arcRunId))).toBeUndefined();
      await expect(
        workerHub.getExecutionControlView(arcRunId),
      ).resolves.toMatchObject({ arcRunId, status: park });

      // Fire the backoff: the trigger re-runs, settles, and fans out to the worker.
      scheduled[0]!.callback();
      await waitFor(() => worker.mock.calls.length === 1);
      expect(advanceSpy).toHaveBeenCalledTimes(1);
      expect(calls).toBeGreaterThanOrEqual(2);
    },
  );

  it.each(["completed", "deflected", "poisoned"] as const)(
    "exec.control-inactive cancels automatic retry for %s with a captured park",
    async (lifecycle) => {
      const store = new InMemoryArcHostStore();
      const arcHost = await createTestArcHost({ store });
      await arcHost.registerArc("watch", parse(WATCH_SOURCE));
      const query = vi.fn(() =>
        claudeThrowingQuery(
          Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        ),
      );
      const cancel = vi.fn();
      const scheduled: (() => void)[] = [];
      const { workerHub, routineStore, workEventStore } = makeWorkerHub({
        arcHost,
        workerSlots: { roles: { researcher: "claude-sdk" } },
        claudeSdk: {
          query: query as unknown as ClaudeSdkQueryFn,
          sessionCache: { enabled: false },
        },
        capacityRetry: {
          enabled: true,
          schedule: (callback) => {
            scheduled.push(callback);
            return cancel;
          },
        },
      });
      try {
        const id = await submitActivation(workerHub, "watch this");
        await waitFor(() => scheduled.length === 1);
        const state = (await store.getState(arcRunKey(id)))!;
        await store.putState(arcRunKey(id), { ...state, lifecycle });
        const control = await routineStore.getExecutionControl(id);
        const events = await collectAsync(workEventStore.listEvents(id));
        const write = vi.spyOn(routineStore, "putExecutionControl");
        const begin = vi.spyOn(arcHost, "begin");
        scheduled[0]!();
        await waitFor(() => cancel.mock.calls.length === 1);
        await expect(workerHub.getExecutionControlView(id)).resolves.toEqual({
          status: "inactive",
          arcRunId: id,
        });
        expect(await routineStore.getExecutionControl(id)).toEqual(control);
        expect(await collectAsync(workEventStore.listEvents(id))).toEqual(
          events,
        );
        expect(write).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(query).toHaveBeenCalledTimes(1);
        expect(scheduled).toHaveLength(1);
        write.mockRestore();
        begin.mockRestore();
      } finally {
        await workerHub.stop();
        arcHost.stop();
      }
    },
  );

  it("auto-resumes a transient capacity block after the scheduled backoff", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const advanceInputs = recordAdvanceInputs(arcHost);
    let calls = 0;
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      calls += 1;
      if (calls === 1) {
        return claudeThrowingQuery(
          Object.assign(new Error("rate_limit_error: requests too high"), {
            status: 429,
            type: "rate_limit_error",
          }),
        );
      }
      return claudeStreamingQuery(params);
    });
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      capacityRetry: {
        enabled: true,
        baseDelayMs: 50,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => {};
        },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "capacity-limited";
    });
    // A transient block schedules one backoff using the exponential base (no
    // provider retry-after on this error), and nothing advanced yet.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(50);
    expect(advanceInputs).toHaveLength(0);
    // The control view surfaces the pending auto-retry for the banner.
    const view = await workerHub.getExecutionControlView(arcRunId);
    expect(view).toMatchObject({
      status: "capacity-limited",
      capacityReason: { reason: "api rate limit" },
      autoRetry: {
        pending: true,
        attempt: 1,
        maxAttempts: 6,
        nextAttemptAt: expect.any(String),
      },
    });

    // Fire the scheduled retry; the backend re-issues and the run advances.
    scheduled[0]!.callback();
    await waitFor(() => advanceInputs.length === 1);
    expect(calls).toBe(2);
    const resumed = await routineStore.getExecutionControl(arcRunId);
    expect(resumed?.status).toBe("running");
  });

  it("schedules a provider retry-after in place of the exponential base", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    recordAdvanceInputs(arcHost);
    const query = vi.fn(() =>
      claudeThrowingQuery(
        Object.assign(new Error("rate_limit_error: requests too high"), {
          status: 429,
          type: "rate_limit_error",
          headers: { "retry-after": "7" },
        }),
      ),
    );
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      capacityRetry: {
        enabled: true,
        baseDelayMs: 50,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => {};
        },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(() => scheduled.length === 1);
    // The provider asked for 7s, so the backoff base is not consulted at all.
    expect(await routineStore.getExecutionControl(arcRunId)).toMatchObject({
      status: "capacity-limited",
      capacityReason: { reason: "api rate limit", retryAfterMs: 7000 },
    });
    expect(scheduled[0]?.delayMs).toBe(7000);
  });

  it("clamps a long provider retry-after to the per-delay cap", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    recordAdvanceInputs(arcHost);
    const query = vi.fn(() =>
      claudeThrowingQuery(
        Object.assign(new Error("rate_limit_error: requests too high"), {
          status: 429,
          type: "rate_limit_error",
          headers: { "retry-after": "3600" },
        }),
      ),
    );
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      capacityRetry: {
        enabled: true,
        baseDelayMs: 50,
        maxDelayMs: 500,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => {};
        },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(() => scheduled.length === 1);
    // The classified block still reports the provider's full hour, but the
    // scheduled delay is clamped to the configured ceiling.
    expect(await routineStore.getExecutionControl(arcRunId)).toMatchObject({
      capacityReason: { retryAfterMs: 3_600_000 },
    });
    expect(scheduled[0]?.delayMs).toBe(500);
  });

  it("stops auto-resuming a transient block after the attempt cap", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    recordAdvanceInputs(arcHost);
    let calls = 0;
    const query = vi.fn(() => {
      calls += 1;
      return claudeThrowingQuery(
        Object.assign(new Error("rate_limit_error: requests too high"), {
          status: 429,
          type: "rate_limit_error",
        }),
      );
    });
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      capacityRetry: {
        enabled: true,
        maxAttempts: 2,
        baseDelayMs: 10,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => {};
        },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(() => scheduled.length === 1);
    // Each fired retry re-blocks and reschedules, with exponential backoff, until
    // the cap is hit; the third re-block exhausts the budget and schedules nothing.
    scheduled[0]!.callback();
    await waitFor(() => scheduled.length === 2);
    expect(scheduled[1]?.delayMs).toBe(20);
    scheduled[1]!.callback();
    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "capacity-limited" && calls === 3;
    });
    expect(scheduled).toHaveLength(2);
    const stuck = await routineStore.getExecutionControl(arcRunId);
    expect(stuck?.status).toBe("capacity-limited");
  });

  it("parks and resumes a claude-sdk transport loss", async () => {
    const store = new InMemoryArcHostStore();
    const arcHost = await createTestArcHost({ store });
    await arcHost.registerArc("watch", parse(WATCH_SOURCE));
    const advanceInputs = recordAdvanceInputs(arcHost);
    let calls = 0;
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      calls += 1;
      if (calls === 1) {
        return claudeThrowingQuery(
          Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        );
      }
      return claudeStreamingQuery(params);
    });
    const { workerHub, routineStore, workEventStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "transport-lost";
    });
    const parked = await routineStore.getExecutionControl(arcRunId);
    expect(parked).toMatchObject({
      status: "transport-lost",
      transportReason: { reason: "connection reset", backend: "claude-sdk" },
    });
    const [parkedRoutine] = await collectAsync(
      routineStore.listRoutines(arcRunId),
    );
    expect(parkedRoutine?.status).toBe("transport-lost");
    const parkEvents = (
      await collectAsync(workEventStore.listEvents(arcRunId))
    ).filter((event) => event.kind === "routine:transport-lost");
    expect(parkEvents).toHaveLength(1);
    expect(parkEvents[0]).toMatchObject({
      kind: "routine:transport-lost",
      transportReason: { reason: "connection reset" },
    });
    expect(advanceInputs).toHaveLength(0);
    await expect(store.getState(arcRunKey(arcRunId))).resolves.toEqual(
      expect.objectContaining({
        lifecycle: expect.not.stringMatching(/poisoned/),
      }),
    );

    await attachToActiveRun(workerHub, arcRunId);
    await expect(routineStore.getExecutionControl(arcRunId)).resolves.toEqual(
      parked,
    );
    await expect(routineStore.getRoutine(parkedRoutine!.id)).resolves.toEqual(
      parkedRoutine,
    );
    expect(advanceInputs).toHaveLength(0);

    await expect(workerHub.resume(arcRunId)).resolves.toMatchObject({
      outcome: "resumed",
    });
    await waitFor(() => advanceInputs.length === 1);
    expect(calls).toBe(2);
    expect(advanceInputs[0]).toMatchObject({
      instructionCoverage: {
        "instruction:[arc:watch:Watch]:[node:watch:Watch]:body/0": "applied",
      },
    });
  });

  it("classifies an SDK instruction timeout as a transport loss", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    recordAdvanceInputs(arcHost);
    const query = vi.fn(() =>
      claudeThrowingQuery(
        new Error("Claude SDK instruction timed out after 60000ms."),
      ),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      // Auto-retry disabled so the run stays parked for inspection.
      capacityRetry: { enabled: false },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "transport-lost";
    });
    expect(await routineStore.getExecutionControl(arcRunId)).toMatchObject({
      status: "transport-lost",
      transportReason: { reason: "sdk timeout", backend: "claude-sdk" },
    });
  });

  it("classifies a lost network round-trip as a transport loss", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    recordAdvanceInputs(arcHost);
    const query = vi.fn(() =>
      claudeThrowingQuery(
        Object.assign(new Error("fetch failed"), { code: "ETIMEDOUT" }),
      ),
    );
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      // Auto-retry disabled so the run stays parked for inspection.
      capacityRetry: { enabled: false },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "transport-lost";
    });
    expect(await routineStore.getExecutionControl(arcRunId)).toMatchObject({
      status: "transport-lost",
      transportReason: { reason: "network timeout", backend: "claude-sdk" },
    });
  });

  it("auto-resumes a transport loss after the scheduled backoff", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const advanceInputs = recordAdvanceInputs(arcHost);
    let calls = 0;
    const query = vi.fn((params: Parameters<ClaudeSdkQueryFn>[0]) => {
      calls += 1;
      if (calls === 1) {
        return claudeThrowingQuery(
          Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        );
      }
      return claudeStreamingQuery(params);
    });
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      capacityRetry: {
        enabled: true,
        baseDelayMs: 50,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => {};
        },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "transport-lost";
    });
    // A transport loss carries no retry-after, so backoff uses the exponential
    // base, and nothing advanced yet.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(50);
    expect(advanceInputs).toHaveLength(0);
    // The control view surfaces the pending auto-retry for the banner.
    const view = await workerHub.getExecutionControlView(arcRunId);
    expect(view).toMatchObject({
      status: "transport-lost",
      transportReason: { reason: "connection reset" },
      autoRetry: {
        pending: true,
        attempt: 1,
        maxAttempts: 6,
        nextAttemptAt: expect.any(String),
      },
    });

    // Fire the scheduled retry; the backend re-issues and the run advances.
    scheduled[0]!.callback();
    await waitFor(() => advanceInputs.length === 1);
    expect(calls).toBe(2);
    const resumed = await routineStore.getExecutionControl(arcRunId);
    expect(resumed?.status).toBe("running");
  });

  it("stops auto-resuming a transport loss after the attempt cap", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    recordAdvanceInputs(arcHost);
    let calls = 0;
    const query = vi.fn(() => {
      calls += 1;
      return claudeThrowingQuery(
        Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      );
    });
    const scheduled: { callback: () => void; delayMs: number }[] = [];
    const { workerHub, routineStore } = makeWorkerHub({
      arcHost,
      workerSlots: { roles: { researcher: "claude-sdk" } },
      claudeSdk: {
        query: query as unknown as ClaudeSdkQueryFn,
        sessionCache: { enabled: false },
      },
      capacityRetry: {
        enabled: true,
        maxAttempts: 2,
        baseDelayMs: 10,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return () => {};
        },
      },
    });

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(() => scheduled.length === 1);
    // Each fired retry re-parks and reschedules with exponential backoff until
    // the cap is hit; the third re-park exhausts the budget and schedules nothing.
    scheduled[0]!.callback();
    await waitFor(() => scheduled.length === 2);
    expect(scheduled[1]?.delayMs).toBe(20);
    scheduled[1]!.callback();
    await waitFor(async () => {
      const control = await routineStore.getExecutionControl(arcRunId);
      return control?.status === "transport-lost" && calls === 3;
    });
    expect(scheduled).toHaveLength(2);
    const stuck = await routineStore.getExecutionControl(arcRunId);
    expect(stuck?.status).toBe("transport-lost");
  });
});
