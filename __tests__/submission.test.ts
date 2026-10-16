import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";
import { createTestArcHost } from "./work-event-fixtures.js";

import {
  ArcHostService,
  DEFAULT_WORKER_ROLE,
  HandshakeStore,
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  projectDialog,
  type InboundLifecycleEvent,
  type OutboundMessage,
  type RoleWorker,
  type WorkerHubService,
} from "../src/testing.js";
import { HotAsyncQueue } from "../src/utils/hot-async-queue.js";
import {
  ALICE_OWNER,
  ARC_RUN_ID,
  BOB_OWNER,
  collectAsync,
  createCapturingLogger,
  firstActivation,
  GREET_SOURCE,
  makeArcHost,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
  WATCH_SOURCE,
} from "./helpers.js";
import {
  drainLifecycle,
  lifecycleReader,
  submitActivation,
} from "./worker-hub-helpers.js";

async function stageActiveRunChoice(workerHub: WorkerHubService): Promise<{
  arcRunId: string;
  handshakeId: string;
  channel: AsyncIterable<InboundLifecycleEvent>;
  reader: ReturnType<typeof lifecycleReader>;
}> {
  const firstReader = lifecycleReader(
    workerHub.submitInbound({
      content: "first request",
      metadata: { clientId: "client-1", principal: ALICE_OWNER },
    }),
  );
  const firstActivated = await firstReader.next();
  if (firstActivated.kind !== "activated") {
    throw new Error("expected first request to activate");
  }
  const channel = workerHub.submitInbound({
    content: "select the active run",
    metadata: { clientId: "client-1", principal: ALICE_OWNER },
  });
  const reader = lifecycleReader(channel);
  const gate = await reader.next();
  if (gate.kind !== "handshake-required") {
    throw new Error("expected active run-choice handshake");
  }
  return {
    arcRunId: firstActivated.arcRunId,
    handshakeId: gate.handshakeId,
    channel,
    reader,
  };
}

describe("Inbound submission and messaging", () => {
  it("fails trigger admission with the original worker error and retires the probe", async () => {
    for (const mode of ["missing", "failed", "throws"] as const) {
      const arcHost = await makeArcHostWithSource(
        "required-trigger",
        `"arc";
function Main() {
  this.trigger = () => judge(\`Start the requested work.\`);
  $instruct(\`Finish the work.\`);
}`,
      );
      const { workerHub, routineStore } = makeWorkerHub({
        arcHost,
        ...(mode === "missing"
          ? {}
          : {
              workerSlots: { default: "broken" },
              backends: {
                broken: {
                  supportedSlotKinds: new Set(["default"]),
                  createWorker: () => ({
                    disposeRoutine: async () => {},
                    run: async () => {
                      if (mode === "throws")
                        throw new Error("Provider crashed.");
                      return {
                        error: "failed" as const,
                        code: "provider-failed",
                        message: "Provider refused work.",
                      };
                    },
                  }),
                },
              },
            }),
      });
      const code =
        mode === "missing"
          ? "role-not-delegated"
          : mode === "throws"
            ? "backend-error"
            : "provider-failed";
      try {
        const iterator = workerHub
          .submitInbound({
            content: "start",
            metadata: { principal: ALICE_OWNER },
          })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.done).toBe(false);
        expect(first.value).toEqual({
          kind: "failed",
          routineId: expect.any(String),
          arcRunId: expect.any(String),
          reason:
            mode === "missing"
              ? `No configured worker is available for role "${DEFAULT_WORKER_ROLE}".`
              : mode === "throws"
                ? "Provider crashed."
                : "Provider refused work.",
        });
        await expect(iterator.next()).resolves.toEqual({
          done: true,
          value: undefined,
        });
        const routines = await collectAsync(routineStore.listRoutines());
        expect(routines).toHaveLength(1);
        expect(routines[0]).toMatchObject({
          arcRunId: first.value.arcRunId,
          status: "finished",
          error: { code },
        });
        const events = await workerHub.listWorkEvents(first.value.arcRunId);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "routine:failed",
              error: { code, message: first.value.reason },
            }),
          ]),
        );
        expect(events.some((event) => event.kind === "run:poisoned")).toBe(
          false,
        );
        await expect(arcHost.listRunViews()).resolves.toEqual([]);
      } finally {
        await workerHub.stop();
      }
    }
  });

  it("poisons activated work when its required instruction worker is missing", async () => {
    const arcHost = await makeArcHostWithSource(
      "missing-action-worker",
      WATCH_SOURCE,
    );
    const { workerHub, routineStore } = makeWorkerHub({ arcHost });
    try {
      const arcRunId = await submitActivation(workerHub, "start");
      await vi.waitFor(async () => {
        expect(await arcHost.getRunView(arcRunId)).toMatchObject({
          lifecycle: "poisoned",
        });
      });
      const routines = await collectAsync(routineStore.listRoutines(arcRunId));
      expect(routines).toEqual([
        expect.objectContaining({
          status: "finished",
          error: expect.objectContaining({ code: "role-not-delegated" }),
        }),
      ]);
      expect(await workerHub.listWorkEvents(arcRunId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "routine:failed" }),
          expect.objectContaining({ kind: "run:poisoned" }),
        ]),
      );
    } finally {
      await workerHub.stop();
    }
  });

  it("emits activation before draining action worker tasks", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let releaseHandler!: () => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const worker = vi.fn<RoleWorker>(
      async () =>
        new Promise((resolve) => {
          resolveStarted();
          releaseHandler = () => resolve({ outcome: "completed" });
        }),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });

    await submitActivation(workerHub, "research Lumentum");

    await started;
    expect(worker).toHaveBeenCalledTimes(1);
    releaseHandler();
  });

  it("resolves permission answers without waiting behind the active turn", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let askId: string | undefined;
    let resolveAsk!: () => void;
    const askSeen = new Promise<void>((resolve) => {
      resolveAsk = resolve;
    });
    let verdict: Promise<{ decision: "allow" | "deny" | "allow_this_run" }>;
    const worker = vi.fn<RoleWorker>(async (_task, _context, effects) => {
      verdict = effects.requestPermission({
        toolCallId: "provider-call:test",
        toolName: "Write",
        input: { file_path: "/tmp/example" },
      });
      await verdict;
      return { outcome: "completed" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });
    workerHub.registerOutboundHandler(
      {
        role: "researcher",
        audience: "permissionApprover",
        cause: "permission-ask",
      },
      (message) => {
        askId = message.metadata?.askId as string | undefined;
        resolveAsk();
      },
    );
    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "hi",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    await askSeen;
    if (askId === undefined)
      throw new Error("expected internal permission ask id");

    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId,
        content: "allow",
        metadata: { askId, decision: "allow" },
      }),
    );

    await expect(verdict!).resolves.toEqual(
      expect.objectContaining({ decision: "allow" }),
    );
  });

  it("records outbound answers in history without starting a new turn", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const begin = vi.spyOn(arcHost, "begin");
    const historyStore = new InMemoryHistoryStore();
    let answer: Promise<string | void>;
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: {
        researcher: async (_task, _context, effects) => {
          answer = effects.emit({
            situation: { audience: "supervisor", cause: "question" },
            content: "What is the answer?",
          });
          await answer;
          return { outcome: "completed" };
        },
      },
    });
    let askId: string | undefined;
    let resolveAsk!: () => void;
    const askSeen = new Promise<void>((resolve) => (resolveAsk = resolve));
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "supervisor", cause: "question" },
      (message) => {
        askId = message.metadata?.askId as string | undefined;
        resolveAsk();
      },
    );
    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    await askSeen;
    const beginCalls = begin.mock.calls.length;

    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId,
        audience: { name: "originator" },
        content: "42",
        metadata: { askId },
      }),
    );

    await expect(answer!).resolves.toBe("42");
    expect(begin).toHaveBeenCalledTimes(beginCalls);
    const entries = await historyStore.listEntries(arcRunId);
    expect(entries).toContainEqual(
      expect.objectContaining({
        from: { kind: "audience", name: "supervisor", ofRole: "researcher" },
        to: { kind: "role", id: "researcher" },
        content: "42",
      }),
    );
    expect(
      projectDialog(entries, { roleId: "researcher" }).lastTurns.at(-1),
    ).toEqual({ role: "self", message: "(forwarded from supervisor) 42" });
    expect(
      projectDialog(entries, { roleId: "archivist" }).lastTurns,
    ).not.toContainEqual({
      role: "self",
      message: "(forwarded from supervisor) 42",
    });
  });

  it("projects originator answers as user turns", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const begin = vi.spyOn(arcHost, "begin");
    const historyStore = new InMemoryHistoryStore();
    let answer: Promise<string | void>;
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: {
        researcher: async (_task, _context, effects) => {
          answer = effects.emit({
            situation: { audience: "originator", cause: "question" },
            content: "Proceed?",
          });
          await answer;
          return { outcome: "completed" };
        },
      },
    });
    let askId: string | undefined;
    let resolveAsk!: () => void;
    const askSeen = new Promise<void>((resolve) => (resolveAsk = resolve));
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "question" },
      (message) => {
        askId = message.metadata?.askId as string | undefined;
        resolveAsk();
      },
    );
    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    await askSeen;
    const beginCalls = begin.mock.calls.length;

    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId,
        audience: { name: "originator" },
        content: "yes, proceed",
        metadata: { askId },
      }),
    );

    await expect(answer!).resolves.toBe("yes, proceed");
    expect(begin).toHaveBeenCalledTimes(beginCalls);
    const entries = await historyStore.listEntries(arcRunId);
    expect(entries).toContainEqual(
      expect.objectContaining({
        from: { kind: "audience", name: "originator" },
        to: { kind: "role", id: "researcher" },
        content: "yes, proceed",
      }),
    );
    expect(
      projectDialog(entries, { roleId: "researcher" }).lastTurns.at(-1),
    ).toEqual({ role: "user", message: "yes, proceed" });
    // The originator's answer is private to the asker, not a run-level turn.
    expect(
      projectDialog(entries, { roleId: "archivist" }).lastTurns,
    ).not.toContainEqual({ role: "user", message: "yes, proceed" });
  });

  it("rejects stale ask-targeted inbound without starting a new turn", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const begin = vi.spyOn(arcHost, "begin");
    const historyStore = new InMemoryHistoryStore();
    const worker = vi.fn<RoleWorker>(async () => ({
      outcome: "completed",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });

    await expect(
      drainLifecycle(
        workerHub.submitInbound({
          arcRunId: ARC_RUN_ID,
          content: "stale",
          metadata: { askId: "ask:stale" },
        }),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "rejected",
        reason: expect.stringContaining("No live ask"),
      }),
    ]);

    expect(worker).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    await expect(historyStore.listEntries(ARC_RUN_ID)).resolves.toEqual([]);
  });

  it("records inbound history, advances Arc work, and dispatches instructions", async () => {
    const store = new InMemoryArcHostStore();
    const { logger, records } = createCapturingLogger("info");
    const arcHost = createTestArcHost({ store, logger });
    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    const historyStore = new InMemoryHistoryStore();
    const calls: string[] = [];
    const begin = vi
      .spyOn(arcHost, "begin")
      .mockImplementation(async (...args) => {
        calls.push("begin");
        return await ArcHostService.prototype.begin.apply(arcHost, args);
      });
    const worker = vi.fn<RoleWorker>(async () => ({
      outcome: "completed",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { greeter: worker },
    });

    const arcRunId = await submitActivation(workerHub, "hi");

    await waitFor(
      async () => (await historyStore.listEntries(arcRunId)).length >= 1,
    );
    await waitFor(async () => {
      return records.some(
        (record) =>
          record.event === "arc_host.run.committed" &&
          record.arcRunId === arcRunId,
      );
    });
    expect(calls).toEqual(["begin"]);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "instruction",
        role: "greeter",
        texts: ["Welcome the user warmly."],
      }),
      expect.objectContaining({
        workspacePath: expect.any(String),
        workspaceBundle: {},
      }),
      expect.objectContaining({
        emit: expect.any(Function),
        logToolEvent: expect.any(Function),
      }),
    );
    const entries = await historyStore.listEntries(arcRunId);
    expect(entries[0]).toMatchObject({
      from: { kind: "audience", name: "originator" },
      to: { kind: "arcade" },
      content: "hi",
    });
  });

  it("rejects generic run-targeted inbound before history or the arc host", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const historyStore = new InMemoryHistoryStore();
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });

    const arcRunId = await submitActivation(workerHub, "research Lumentum");

    await expect(
      drainLifecycle(
        workerHub.submitInbound({
          content: "and check the filings",
          arcRunId,
          metadata: { principal: ALICE_OWNER },
        }),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "rejected",
        reason: expect.stringContaining("metadata.askId"),
      }),
    ]);
    await expect(
      arcHost.listRunViews().then((views) => views.map((v) => v.arcRunId)),
    ).resolves.toEqual([arcRunId]);

    const entries = await historyStore.listEntries(arcRunId);
    expect(entries.map((entry) => entry.content)).toEqual([
      "research Lumentum",
    ]);
  });

  it("rejects free inbound carrying ask correlation before the arc host", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const begin = vi.spyOn(arcHost, "begin");
    const historyStore = new InMemoryHistoryStore();
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });

    for (const askId of ["ask:stale", "", 3]) {
      await expect(
        drainLifecycle(
          workerHub.submitInbound({
            content: "must not activate",
            metadata: { principal: ALICE_OWNER, askId },
          }),
        ),
      ).resolves.toEqual([
        expect.objectContaining({
          kind: "rejected",
          reason: expect.stringContaining("answer-correlation"),
        }),
      ]);
    }

    expect(begin).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    await expect(historyStore.listEntries(ARC_RUN_ID)).resolves.toEqual([]);
  });

  it("treats outboundMessageId as opaque free metadata and never as targeted correlation", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const begin = vi.spyOn(arcHost, "begin");
    const historyStore = new InMemoryHistoryStore();
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });

    const arcRunId = await firstActivation(
      workerHub.submitInbound({
        content: "activate with opaque connector metadata",
        metadata: {
          principal: ALICE_OWNER,
          outboundMessageId: "connector-local:item",
        },
      }),
    );
    const beginCalls = begin.mock.calls.length;

    await expect(
      drainLifecycle(
        workerHub.submitInbound({
          arcRunId,
          content: "not an answer",
          metadata: { outboundMessageId: "connector-local:item" },
        }),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "rejected",
        reason: expect.stringContaining("metadata.askId"),
      }),
    ]);

    expect(begin).toHaveBeenCalledTimes(beginCalls);
    await waitFor(
      async () => (await historyStore.listEntries(arcRunId)).length === 1,
    );
    expect(
      (await historyStore.listEntries(arcRunId)).map((entry) => entry.content),
    ).toEqual(["activate with opaque connector metadata"]);
  });

  it("attaches to an active run immediately without actioning or history mutation", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const begin = vi.spyOn(arcHost, "begin");
    const historyStore = new InMemoryHistoryStore();
    let releaseWorker!: () => void;
    let markWorkerStarted!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    const worker = vi.fn<RoleWorker>(
      async () =>
        new Promise((resolve) => {
          markWorkerStarted();
          releaseWorker = () => resolve({ outcome: "completed" });
        }),
    );
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });
    const outbound = vi.fn();
    workerHub.registerOutboundHandler(
      { role: "*", audience: "*", cause: "*" },
      outbound,
    );

    const staged = await stageActiveRunChoice(workerHub);
    await workerStarted;
    const beginCalls = begin.mock.calls.length;
    const historyBefore = await historyStore.listEntries(staged.arcRunId);
    const runBefore = await arcHost.getRunView(staged.arcRunId);

    await expect(
      workerHub.handshake(staged.handshakeId, {
        runChoice: { action: "join", arcRunId: staged.arcRunId },
      }),
    ).resolves.toEqual({ status: "ok" });
    await expect(staged.reader.next()).resolves.toMatchObject({
      kind: "joined",
      arcRunId: staged.arcRunId,
    });
    await expect(staged.reader.next()).rejects.toThrow(
      "submission channel closed before an expected event",
    );

    expect(begin).toHaveBeenCalledTimes(beginCalls);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(outbound).not.toHaveBeenCalled();
    await expect(historyStore.listEntries(staged.arcRunId)).resolves.toEqual(
      historyBefore,
    );
    await expect(arcHost.getRunView(staged.arcRunId)).resolves.toEqual(
      runBefore,
    );
    releaseWorker();
  });

  it("uses shared submission teardown when join lifecycle publication fails", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const begin = vi.spyOn(arcHost, "begin");
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: async () => ({ outcome: "completed" }) },
    });
    const staged = await stageActiveRunChoice(workerHub);
    const beginCalls = begin.mock.calls.length;
    if (!(staged.channel instanceof HotAsyncQueue)) {
      throw new Error("expected worker hub submission channel");
    }
    staged.channel.close();

    await expect(
      workerHub.handshake(staged.handshakeId, {
        runChoice: { action: "join", arcRunId: staged.arcRunId },
      }),
    ).rejects.toThrow("Cannot push to a closed channel.");
    await expect(staged.reader.next()).rejects.toThrow(
      "submission channel closed before an expected event",
    );
    expect(begin).toHaveBeenCalledTimes(beginCalls);
    await expect(
      workerHub.handshake(staged.handshakeId, {
        runChoice: { action: "join", arcRunId: staged.arcRunId },
      }),
    ).resolves.toEqual({ status: "missing" });
  });

  it("scopes concurrent run-choice handshakes to their originating submissions", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: async () => ({ outcome: "completed" }) },
    });
    const surfaceB = await stageActiveRunChoice(workerHub);
    const surfaceC = lifecycleReader(
      workerHub.submitInbound({
        content: "attach this other surface",
        metadata: { clientId: "client-2", principal: ALICE_OWNER },
      }),
    );
    const surfaceCGate = await surfaceC.next();
    if (surfaceCGate.kind !== "handshake-required") {
      throw new Error("expected a separate run-choice handshake");
    }
    expect(surfaceCGate.handshakeId).not.toBe(surfaceB.handshakeId);
    expect(surfaceCGate.arcRunId).not.toBe(surfaceB.arcRunId);
    expect(await arcHost.getRunView(surfaceCGate.arcRunId)).toMatchObject({
      stage: "handshaking",
      handshakeId: surfaceCGate.handshakeId,
    });

    await expect(
      workerHub.handshake(
        surfaceB.handshakeId,
        { runChoice: { action: "join", arcRunId: surfaceB.arcRunId } },
        "client-1",
      ),
    ).resolves.toEqual({ status: "ok" });
    await expect(surfaceB.reader.next()).resolves.toMatchObject({
      kind: "joined",
      arcRunId: surfaceB.arcRunId,
    });

    await expect(
      workerHub.handshake(
        surfaceCGate.handshakeId,
        { runChoice: { action: "join", arcRunId: surfaceB.arcRunId } },
        "client-2",
      ),
    ).resolves.toEqual({ status: "ok" });
    await expect(surfaceC.next()).resolves.toMatchObject({
      kind: "joined",
      arcRunId: surfaceB.arcRunId,
    });
    await expect(surfaceB.reader.next()).rejects.toThrow(
      "submission channel closed before an expected event",
    );
    await expect(surfaceC.next()).rejects.toThrow(
      "submission channel closed before an expected event",
    );
  });

  it("attaches while a worker waits on an ask without re-asking or invoking another worker", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const historyStore = new InMemoryHistoryStore();
    let askId: string | undefined;
    let markAskSeen!: () => void;
    const askSeen = new Promise<void>((resolve) => {
      markAskSeen = resolve;
    });
    let answer: string | void;
    const worker = vi.fn<RoleWorker>(async (_task, _context, effects) => {
      answer = await effects.emit({
        situation: { audience: "supervisor", cause: "question" },
        content: "Approve?",
      });
      return { outcome: "completed" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "supervisor", cause: "question" },
      (message) => {
        askId = message.metadata?.askId;
        markAskSeen();
      },
    );

    const staged = await stageActiveRunChoice(workerHub);
    await askSeen;
    if (!askId) throw new Error("expected ask id");
    await expect(
      workerHub.handshake(staged.handshakeId, {
        runChoice: { action: "join", arcRunId: staged.arcRunId },
      }),
    ).resolves.toEqual({ status: "ok" });
    await expect(staged.reader.next()).resolves.toMatchObject({
      kind: "joined",
      arcRunId: staged.arcRunId,
    });
    expect(worker).toHaveBeenCalledTimes(1);

    await expect(
      drainLifecycle(
        workerHub.submitInbound({
          arcRunId: staged.arcRunId,
          content: "approved",
          metadata: { askId },
        }),
      ),
    ).resolves.toEqual([{ kind: "continued", arcRunId: staged.arcRunId }]);
    await waitFor(() => answer === "approved");
    expect(worker).toHaveBeenCalledTimes(1);
    const entries = await historyStore.listEntries(staged.arcRunId);
    expect(entries.map((entry) => entry.content)).not.toContain(
      "select the active run",
    );
  });

  it("settles a join branch independently beside a fresh activation", async () => {
    const arcHost = await makeArcHostWithSource("greet", GREET_SOURCE);
    let releaseExisting!: () => void;
    let markExistingStarted!: () => void;
    const existingStarted = new Promise<void>((resolve) => {
      markExistingStarted = resolve;
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        greeter: async () => {
          markExistingStarted();
          await new Promise<void>((resolve) => {
            releaseExisting = resolve;
          });
          return { outcome: "completed" };
        },
        sibling: async () => ({ outcome: "completed" }),
      },
    });
    const existingRunId = await firstActivation(
      workerHub.submitInbound({
        content: "start existing",
        metadata: { principal: ALICE_OWNER, clientId: "client-a" },
      }),
    );
    await existingStarted;
    await arcHost.registerArc(
      "sibling",
      parse(`"arc";
function Sibling() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "sibling" };
  $instruct("Handle sibling.");
}`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );

    const reader = lifecycleReader(
      workerHub.submitInbound({
        content: "activate all",
        metadata: {
          activationPolicy: "all",
          clientId: "client-b",
          principal: ALICE_OWNER,
        },
      }),
    );
    const gates = [await reader.next(), await reader.next()];
    const runChoice = gates.find(
      (event) =>
        event.kind === "handshake-required" &&
        event.requirement.kind === "run-choice",
    );
    const workspace = gates.find(
      (event) =>
        event.kind === "handshake-required" &&
        event.requirement.kind === "workspace",
    );
    if (
      runChoice?.kind !== "handshake-required" ||
      workspace?.kind !== "handshake-required"
    ) {
      throw new Error("expected run-choice and workspace branches");
    }

    await expect(
      workerHub.handshake(
        runChoice.handshakeId,
        { runChoice: { action: "join", arcRunId: existingRunId } },
        "client-b",
      ),
    ).resolves.toEqual({ status: "ok" });
    await expect(reader.next()).resolves.toMatchObject({
      kind: "joined",
      arcRunId: existingRunId,
    });

    await expect(
      workerHub.handshake(
        workspace.handshakeId,
        { workspace: "/tmp/arcade-sibling-attachment-test" },
        "client-b",
      ),
    ).resolves.toEqual({ status: "ok" });
    const activated = await reader.next();
    expect(activated).toMatchObject({ kind: "activated" });
    if (activated.kind !== "activated") return;
    expect(activated.arcRunId).not.toBe(existingRunId);
    await expect(reader.next()).rejects.toThrow(
      "submission channel closed before an expected event",
    );
    releaseExisting();
  });

  it("keeps a submission open until clean and deflected trigger probes settle", async () => {
    const arcHost = await makeArcHostWithSource(
      "monitor",
      `"arc";
function Main() {
  this.trigger = () => judge(\`event matches monitor\`);
  $enter(Wait);
  function Wait() { this.guard = () => State.DEFLECTED; }
}`,
    );
    const worker: RoleWorker = async (task) => {
      if (task.kind !== "semantic") return { outcome: "completed" };
      return {
        outcome: "completed",
        semantic: {
          judgments: Object.fromEntries(
            task.requests
              .filter((request) => request.kind === "judgment")
              .map((request) => [request.briefId, true]),
          ),
        },
      };
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { [DEFAULT_WORKER_ROLE]: worker },
    });
    const firstRunId = await firstActivation(
      workerHub.submitInbound({
        content: "first event",
        metadata: { principal: ALICE_OWNER },
      }),
    );

    const reader = lifecycleReader(
      workerHub.submitInbound({
        content: "second event",
        metadata: { principal: ALICE_OWNER },
      }),
    );
    const gate = await reader.next();
    expect(gate.kind).toBe("handshake-required");
    if (gate.kind !== "handshake-required") return;
    expect(gate.requirement).toMatchObject({
      kind: "run-choice",
      candidates: [expect.objectContaining({ arcRunId: firstRunId })],
    });

    await expect(
      workerHub.handshake(gate.handshakeId, {
        runChoice: { action: "join", arcRunId: firstRunId },
      }),
    ).resolves.toEqual({ status: "ok" });
    await expect(reader.next()).resolves.toEqual({
      kind: "activated",
      arcRunId: firstRunId,
    });
  });

  it("converts missing and invalid handshakes to connector receipts", async () => {
    const arcHost = makeArcHost();
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const { workerHub } = makeWorkerHub({ arcHost });

    await expect(workerHub.handshake("handshake:missing", {})).resolves.toEqual(
      {
        status: "missing",
      },
    );

    const reader = lifecycleReader(
      workerHub.submitInbound({
        content: "first research request",
        metadata: { clientId: "client-1", principal: ALICE_OWNER },
      }),
    );
    const gate = await reader.next();
    expect(gate.kind).toBe("handshake-required");
    if (gate.kind !== "handshake-required") return;

    await expect(
      workerHub.handshake(gate.handshakeId, {}, "client-1"),
    ).resolves.toEqual({
      status: "invalid",
      reason: "Workspace must be an absolute path. Got undefined.",
    });
    await expect(
      workerHub.handshake(
        gate.handshakeId,
        { workspace: "/tmp/retryable-workspace" },
        "client-1",
      ),
    ).resolves.toEqual({ status: "ok" });
    await expect(reader.next()).resolves.toMatchObject({ kind: "activated" });
  });

  it("releases a pending hold when its correlated handshake expires", async () => {
    const arcHost = createTestArcHost({
      store: new InMemoryArcHostStore(),
      handshakes: new HandshakeStore({ ttlMs: 0 }),
    });
    await arcHost.registerArc("stock-research", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const { workerHub } = makeWorkerHub({ arcHost });
    const reader = lifecycleReader(
      workerHub.submitInbound({
        content: "expiring research request",
        metadata: { clientId: "client-1", principal: ALICE_OWNER },
      }),
    );
    const gate = await reader.next();
    expect(gate.kind).toBe("handshake-required");
    if (gate.kind !== "handshake-required") return;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(
      workerHub.handshake(
        gate.handshakeId,
        { workspace: "/tmp/expired-workspace" },
        "client-1",
      ),
    ).resolves.toEqual({ status: "missing" });
    await expect(reader.next()).rejects.toThrow(
      "submission channel closed before an expected event",
    );
    await expect(
      workerHub.handshake(
        gate.handshakeId,
        { workspace: "/tmp/expired-workspace" },
        "client-1",
      ),
    ).resolves.toEqual({ status: "missing" });
  });

  it("returns a workspace handshake after semantic trigger resolution selects a scoped arc", async () => {
    const arcHost = makeArcHost();
    await arcHost.registerArc(
      "scratchpad",
      parse(`
"arc";

function Scratchpad() {
  this.hostParams = {
    workerRole: "judge-runner",
  };
  this.trigger = () => {
    return judge(\`user wants scratchpad notes\`);
  };
  $instruct(\`Handle scratchpad notes.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    await arcHost.registerArc(
      "stock-research",
      parse(`
"arc";

function Stock() {
  this.hostParams = {
    workerRole: "judge-runner",
  };
  this.trigger = () => {
    return judge(\`user wants stock research\`);
  };
  $instruct(\`Handle stock research.\`);
}
`),
      { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
    );
    const worker = vi.fn<RoleWorker>(async (task) => {
      if (task.kind !== "semantic") return { suspension: "paused" };
      return {
        outcome: "completed",
        semantic: {
          judgments: Object.fromEntries(
            task.requests.map((request) => [
              request.briefId,
              "question" in request &&
                typeof request.question === "string" &&
                request.question.includes("stock research"),
            ]),
          ),
        },
      };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { "judge-runner": worker },
    });

    const reader = lifecycleReader(
      workerHub.submitInbound({
        content: "research stocks",
        metadata: { clientId: "client-1", principal: ALICE_OWNER },
      }),
    );
    const gate = await reader.next();
    expect(gate.kind).toBe("handshake-required");
    if (gate.kind !== "handshake-required") return;
    expect(gate.handshakeId).toEqual(expect.stringMatching(/^handshake:/));
    expect(worker).toHaveBeenCalledTimes(1);

    const resolved = await workerHub.handshake(
      gate.handshakeId,
      { workspace: "/tmp/arcade-stock-research" },
      "client-1",
    );
    expect(resolved).toEqual({ status: "ok" });
    const activated = await reader.next();
    expect(activated.kind).toBe("activated");
    if (activated.kind !== "activated") return;
    await waitFor(() => worker.mock.calls.length === 2);
    await expect(arcHost.getRunView(activated.arcRunId)).resolves.toEqual(
      expect.objectContaining({
        arcRef: "arc:stock-research:Stock",
        ownerPrincipal: ALICE_OWNER,
        workspacePath: "/tmp/arcade-stock-research",
      }),
    );
  });

  it("does not offer the pending semantic activation as a run-choice candidate", async () => {
    const arcHost = makeArcHost();
    await arcHost.registerArc(
      "semantic-eval",
      parse(`
"arc";

function Main() {
  this.hostParams = {
    workerRole: "responder",
  };
  this.trigger = () => {
    return judge(\`user wants this semantic eval\`);
  };
  $instruct(\`Reply to the user.\`);
}
`),
    );
    const worker = vi.fn<RoleWorker>(async (task) => {
      if (task.kind === "semantic") {
        return {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              task.requests.map((request) => [request.briefId, true]),
            ),
          },
        };
      }
      return { suspension: "paused" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { responder: worker },
    });

    await submitActivation(workerHub, "start semantic eval");
    await waitFor(() => worker.mock.calls.length === 2);
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it("rejects new run activation without a principal", async () => {
    const arcHost = await makeArcHostWithSource("greet", GREET_SOURCE);
    const { workerHub } = makeWorkerHub({ arcHost });

    const events = await drainLifecycle(
      workerHub.submitInbound({
        content: "hi",
        metadata: { clientId: "client-1" },
      }),
    );
    expect(events).toEqual([
      {
        kind: "rejected",
        reason: "Inbound activation requires metadata.principal.",
      },
    ]);
  });

  it("allows different Arc runs to dispatch handler work concurrently", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const starts: string[] = [];
    const releases = new Map<string, () => void>();
    let resolveBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      resolveBothStarted = resolve;
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      defaultConcurrency: 2,
      workers: {
        researcher: async (task) => {
          starts.push(task.arcRunId);
          if (starts.length === 2) resolveBothStarted();
          await new Promise<void>((resolve) => {
            releases.set(task.arcRunId, resolve);
          });
          return { outcome: "completed" };
        },
      },
    });

    const first = workerHub.submitInbound({
      content: "one",
      metadata: { principal: ALICE_OWNER },
    });
    const second = workerHub.submitInbound({
      content: "two",
      metadata: { principal: BOB_OWNER },
    });
    await bothStarted;
    for (const arcRunId of starts) releases.get(arcRunId)?.();
    const runIds = await Promise.all([
      firstActivation(first),
      firstActivation(second),
    ]);
    expect(runIds.sort()).toEqual([...starts].sort());
  });

  it("accepts inbound messages even when handler execution later fails or the handler queue is full", async () => {
    const failedArcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const failedWorkerHub = makeWorkerHub({
      arcHost: failedArcHost,
      workers: {
        researcher: async () => {
          throw new Error("model unavailable");
        },
      },
    }).workerHub;

    await expect(submitActivation(failedWorkerHub, "hi")).resolves.toEqual(
      expect.stringMatching(/^arc-run:/),
    );

    let releaseFirst!: () => void;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const queueArcHost = await makeArcHostWithSource(
      "watch-queue",
      WATCH_SOURCE,
    );
    const queueLimited = makeWorkerHub({
      arcHost: queueArcHost,
      defaultConcurrency: 1,
      maxQueueSize: 0,
      roleConcurrency: { researcher: 1 },
      workers: {
        researcher: async () => {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return { outcome: "completed" };
        },
      },
    }).workerHub;

    const first = submitActivation(queueLimited, "one", ALICE_OWNER);
    await started;
    const secondArcRunId = await submitActivation(
      queueLimited,
      "two",
      BOB_OWNER,
    );
    releaseFirst();
    await first;

    expect(secondArcRunId).toEqual(expect.stringMatching(/^arc-run:/));
  });

  it("continues background drains after the driver step budget yields", async () => {
    const childCount = 20;
    const arcHost = await makeArcHostWithSource(
      "many",
      `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };

  ${Array.from(
    { length: childCount },
    (_, index) => `$enter(Child${index});`,
  ).join("\n  ")}

  ${Array.from(
    { length: childCount },
    (_, index) => `
  function Child${index}() {
    this.hostParams = {
      workerRole: "greeter",
    };
    $instruct(\`Handle child ${index}.\`);
  }
`,
  ).join("\n")}
}
`,
    );
    const worker = vi.fn<RoleWorker>(async () => ({
      outcome: "completed",
    }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { greeter: worker },
    });

    await submitActivation(workerHub, "hi");

    await waitFor(() => worker.mock.calls.length === childCount);
  });

  it("records the inbound history entry and emits no outbound when no handler emits", async () => {
    const store = new InMemoryArcHostStore();
    const { logger, records } = createCapturingLogger("info");
    const arcHost = createTestArcHost({ store, logger });
    await arcHost.registerArc("greet", parse(GREET_SOURCE));
    const historyStore = new InMemoryHistoryStore();
    const emitted: OutboundMessage[] = [];
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: {
        greeter: async () => ({ outcome: "completed" }),
      },
    });
    workerHub.registerOutboundHandler(
      { role: "greeter", audience: "originator", cause: "reply" },
      (message) => {
        emitted.push(message);
      },
    );

    const arcRunId = await submitActivation(workerHub, "hi");
    await waitFor(
      async () => (await historyStore.listEntries(arcRunId)).length >= 1,
    );

    expect(await historyStore.listEntries(arcRunId)).toMatchObject([
      {
        from: { kind: "audience", name: "originator" },
        content: "hi",
      },
    ]);
    expect(emitted).toEqual([]);
    await waitFor(async () => {
      return records.some(
        (record) =>
          record.event === "arc_host.run.committed" &&
          record.arcRunId === arcRunId,
      );
    });
    expect(
      records
        .filter((record) => record.arcRunId === arcRunId)
        .map((record) => record.event),
    ).toEqual(["arc_host.run.begun", "arc_host.run.committed"]);
  });
});
