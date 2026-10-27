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
  deferred,
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
  it.each(["join", "workspace", "decline"] as const)(
    "preserves the winning submission under concurrent %s handshake resolutions",
    async (kind) => {
      const arcHost = await makeArcHost();
      await arcHost.registerArc(
        "serialized-submission",
        parse(WATCH_SOURCE),
        kind === "join"
          ? undefined
          : { workspaceScope: "arc", bundle: {}, contextIsolation: "role" },
      );
      const release = deferred();
      const { workerHub } = makeWorkerHub({
        arcHost,
        workers: {
          researcher: async () => {
            await release.promise;
            return { outcome: "completed" };
          },
        },
      });
      try {
        const staged =
          kind === "join" ? await stageActiveRunChoice(workerHub) : undefined;
        const iterator =
          staged?.channel[Symbol.asyncIterator]() ??
          workerHub
            .submitInbound({
              content: "start",
              metadata: { principal: ALICE_OWNER },
            })
            [Symbol.asyncIterator]();
        const gate = staged ?? (await iterator.next()).value;
        if (!gate || !("handshakeId" in gate))
          throw new Error("Expected handshake");
        const values =
          kind === "join"
            ? {
                runChoice: {
                  action: "join" as const,
                  arcRunId: staged!.arcRunId,
                },
              }
            : kind === "workspace"
              ? { workspace: "/tmp/serialized-submission" }
              : { decline: true as const };
        await expect(
          Promise.all([
            workerHub.handshake(gate.handshakeId, values),
            workerHub.handshake(gate.handshakeId, values),
          ]),
        ).resolves.toEqual([{ status: "ok" }, { status: "missing" }]);
        expect((await iterator.next()).value).toMatchObject({
          kind:
            kind === "join"
              ? "joined"
              : kind === "workspace"
                ? "activated"
                : "rejected",
          ...(kind === "decline" ? {} : { reactivationCount: 0 }),
        });
        await expect(iterator.next()).resolves.toEqual({
          done: true,
          value: undefined,
        });
      } finally {
        release.resolve();
        await workerHub.stop();
        await arcHost.stop();
      }
    },
  );

  it("accepts decline on the original submission and closes its only pending branch once", async () => {
    const arcHost = await makeArcHost();
    await arcHost.registerArc("decline-only", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    const { workerHub } = makeWorkerHub({ arcHost });
    try {
      const channel = workerHub.submitInbound({
        content: "start",
        metadata: { principal: ALICE_OWNER },
      });
      const iterator = channel[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.kind !== "handshake-required")
        throw new Error("Expected handshake");
      const gate = first.value;
      await expect(
        workerHub.handshake(gate.handshakeId, { decline: true }),
      ).resolves.toEqual({ status: "ok" });
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: {
          kind: "rejected",
          arcRef: gate.arcRef,
          reason: "Arc activation declined by client.",
        },
      });
      await expect(iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      await expect(
        workerHub.handshake(gate.handshakeId, { decline: true }),
      ).resolves.toEqual({ status: "missing" });
      await expect(iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      expect(await arcHost.listRunViews()).toEqual([]);
      expect(
        (await workerHub.listWorkEvents(gate.arcRunId)).filter(
          (event) => event.kind === "run:handshake-resolved",
        ),
      ).toEqual([
        expect.objectContaining({
          handshakeId: gate.handshakeId,
          outcome: { kind: "declined" },
        }),
      ]);
    } finally {
      await workerHub.stop();
    }
  });

  it("settles a declined branch while activated work and a pending sibling continue", async () => {
    const arcHost = await makeArcHost();
    const source = `"arc"; function Main() { this.hostParams = { workerRole: "researcher" }; this.trigger = () => true; $instruct("Work"); }`;
    for (const name of ["running", "declined", "pending"]) {
      await arcHost.registerArc(name, parse(source), {
        workspaceScope: name === "running" ? "run" : "arc",
        bundle: {},
        contextIsolation: "role",
      });
    }
    let release!: () => void;
    const work = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = vi.fn<RoleWorker>(async () => {
      await work;
      return { outcome: "completed" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });
    try {
      const iterator = workerHub
        .submitInbound({
          content: "start all",
          metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
        })
        [Symbol.asyncIterator]();
      const initial: InboundLifecycleEvent[] = [];
      for (let index = 0; index < 3; index++) {
        const item = await iterator.next();
        if (item.done) throw new Error("Submission closed before all branches");
        initial.push(item.value);
      }
      const activated = initial.find((event) => event.kind === "activated");
      const declined = initial.find(
        (event) =>
          event.kind === "handshake-required" &&
          event.arcRef === "arc:declined:Main",
      );
      const pending = initial.find(
        (event) =>
          event.kind === "handshake-required" &&
          event.arcRef === "arc:pending:Main",
      );
      if (
        activated?.kind !== "activated" ||
        declined?.kind !== "handshake-required" ||
        pending?.kind !== "handshake-required"
      )
        throw new Error("Expected activation and two gated siblings");
      await waitFor(() => worker.mock.calls.length === 1);
      const runningBefore = await arcHost.getRunView(activated.arcRunId);
      await expect(
        workerHub.handshake(declined.handshakeId, { decline: true }),
      ).resolves.toEqual({ status: "ok" });
      await expect(iterator.next()).resolves.toMatchObject({
        done: false,
        value: { kind: "rejected", arcRef: declined.arcRef },
      });
      expect(await arcHost.getRunView(activated.arcRunId)).toEqual(
        runningBefore,
      );
      expect(await arcHost.getRunView(pending.arcRunId)).toMatchObject({
        stage: "handshaking",
      });
      const next = iterator.next();
      await expect(
        workerHub.handshake(pending.handshakeId, {
          workspace: "/tmp/decline-sibling",
        }),
      ).resolves.toEqual({ status: "ok" });
      await expect(next).resolves.toMatchObject({
        done: false,
        value: { kind: "activated" },
      });
      await expect(iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      release();
      await waitFor(async () => {
        const view = await arcHost.getRunView(activated.arcRunId);
        return view?.stage === "actioning" && view.lifecycle === "completed";
      });
    } finally {
      release();
      await workerHub.stop();
    }
  });

  it("activates each workspace-gated fan-out branch once and closes the submission after the last resolution", async () => {
    const arcHost = await makeArcHost();
    for (const source of ["first", "second"]) {
      await arcHost.registerArc(source, parse(WATCH_SOURCE), {
        workspaceScope: "arc",
        bundle: {},
        contextIsolation: "role",
      });
    }
    const release = deferred();
    const worker = vi.fn<RoleWorker>(async () => {
      await release.promise;
      return { outcome: "completed" };
    });
    const { workerHub, historyStore } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });

    try {
      const iterator = workerHub
        .submitInbound({
          content: "start both workspace branches",
          metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
        })
        [Symbol.asyncIterator]();
      const gates = [
        (await iterator.next()).value,
        (await iterator.next()).value,
      ];
      for (const gate of gates) {
        expect(gate).toMatchObject({
          kind: "handshake-required",
          requirement: { kind: "workspace" },
        });
      }
      expect(worker).not.toHaveBeenCalled();
      const runIds = new Set<string>();
      for (const [index, gate] of gates.entries()) {
        if (gate?.kind !== "handshake-required")
          throw new Error("Expected workspace handshake");
        const workspace = `/tmp/arcade-fanout-workspace-${index}`;
        await expect(
          workerHub.handshake(gate.handshakeId, { workspace }),
        ).resolves.toEqual({ status: "ok" });
        const next = await iterator.next();
        if (next.done || next.value.kind !== "activated")
          throw new Error("Expected branch activation");
        const { arcRunId } = next.value;
        runIds.add(arcRunId);
        expect(await arcHost.getRunView(arcRunId)).toMatchObject({
          arcRef: gate.arcRef,
          ownerPrincipal: ALICE_OWNER,
          workspacePath: workspace,
        });
        expect(await historyStore.listEntries(arcRunId)).toEqual([
          expect.objectContaining({ content: "start both workspace branches" }),
        ]);
        await expect(
          workerHub.handshake(gate.handshakeId, { workspace }),
        ).resolves.toEqual({ status: "missing" });
        await waitFor(() => worker.mock.calls.length === index + 1);
        if (index === 0) {
          const pending = gates[1];
          if (pending?.kind !== "handshake-required")
            throw new Error("Expected pending sibling");
          expect(await arcHost.getRunView(pending.arcRunId)).toMatchObject({
            stage: "handshaking",
          });
        }
      }
      expect(runIds.size).toBe(2);
      await expect(iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      expect(worker).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  it.each(["committed", "failed"] as const)(
    "retains sibling handshake outcomes through a %s activation history write",
    async (outcome) => {
      const arcHost = await makeArcHost();
      for (const source of ["first", "second"]) {
        await arcHost.registerArc(source, parse(WATCH_SOURCE), {
          workspaceScope: "arc",
          bundle: {},
          contextIsolation: "role",
        });
      }
      const historyStore = new InMemoryHistoryStore();
      const historyEntered = deferred();
      const releaseHistory = deferred();
      const cleanupEntered = deferred();
      const releaseCleanup = deferred();
      const releaseWorkers = deferred();
      const failure = new Error("Activation history unavailable.");
      let firstRunId: string | undefined;
      const append = historyStore.appendEntry.bind(historyStore);
      vi.spyOn(historyStore, "appendEntry").mockImplementationOnce(
        async (arcRunId, entry) => {
          firstRunId = arcRunId;
          historyEntered.resolve();
          await releaseHistory.promise;
          if (outcome === "failed") throw failure;
          return append(arcRunId, entry);
        },
      );
      const releaseAction = arcHost.releaseAction.bind(arcHost);
      vi.spyOn(arcHost, "releaseAction").mockImplementation(async (...args) => {
        if (outcome === "failed" && args[0] === firstRunId) {
          cleanupEntered.resolve();
          await releaseCleanup.promise;
        }
        return releaseAction(...args);
      });
      const worker = vi.fn<RoleWorker>(async () => {
        await releaseWorkers.promise;
        return { outcome: "completed" };
      });
      const { workerHub } = makeWorkerHub({
        arcHost,
        historyStore,
        workers: { researcher: worker },
      });
      let first: Promise<unknown> | undefined;
      try {
        const iterator = workerHub
          .submitInbound({
            content: "resolve both branches",
            metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
          })
          [Symbol.asyncIterator]();
        const firstGate = (await iterator.next()).value;
        const secondGate = (await iterator.next()).value;
        if (
          firstGate?.kind !== "handshake-required" ||
          secondGate?.kind !== "handshake-required"
        )
          throw new Error("Expected sibling workspace handshakes");
        first = workerHub
          .handshake(firstGate.handshakeId, {
            workspace: "/tmp/arcade-sibling-first",
          })
          .then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
        await historyEntered.promise;
        await expect(
          workerHub.handshake(secondGate.handshakeId, {
            workspace: "/tmp/arcade-sibling-second",
          }),
        ).resolves.toEqual({ status: "ok" });
        const second = (await iterator.next()).value;
        if (second?.kind !== "activated")
          throw new Error("Expected independent sibling activation");
        expect(second.arcRunId).not.toBe(firstRunId);
        const remaining = iterator.next().then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        releaseHistory.resolve();
        if (outcome === "failed") {
          await cleanupEntered.promise;
          // The authoritative error is visible while host cleanup is held.
          await expect(remaining).resolves.toEqual({ error: failure });
          releaseCleanup.resolve();
          await expect(first).resolves.toEqual({ error: failure });
          await expect(iterator.next()).rejects.toBe(failure);
        } else {
          await expect(first).resolves.toEqual({ value: { status: "ok" } });
          await expect(remaining).resolves.toEqual({
            value: {
              done: false,
              value: {
                kind: "activated",
                arcRunId: firstRunId,
                reactivationCount: 0,
              },
            },
          });
          await expect(iterator.next()).resolves.toEqual({
            done: true,
            value: undefined,
          });
        }
        await waitFor(
          () => worker.mock.calls.length === (outcome === "failed" ? 1 : 2),
        );
        expect(await arcHost.getRunView(second.arcRunId)).toMatchObject({
          stage: "actioning",
          lifecycle: "active",
        });
      } finally {
        releaseHistory.resolve();
        releaseCleanup.resolve();
        releaseWorkers.resolve();
        await first;
        await workerHub.stop();
        await arcHost.stop();
      }
    },
  );

  it("retains initial fan-out activation while an earlier handshake settles", async () => {
    const arcHost = await makeArcHost();
    await arcHost.registerArc("first", parse(WATCH_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });
    await arcHost.registerArc("second", parse(WATCH_SOURCE));
    const historyStore = new InMemoryHistoryStore();
    const historyEntered = deferred();
    const releaseHistory = deferred();
    const append = historyStore.appendEntry.bind(historyStore);
    vi.spyOn(historyStore, "appendEntry").mockImplementationOnce(
      async (...args) => {
        historyEntered.resolve();
        await releaseHistory.promise;
        return append(...args);
      },
    );
    const worker = vi.fn<RoleWorker>(async () => ({ outcome: "completed" }));
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });
    try {
      const iterator = workerHub
        .submitInbound({
          content: "start both branches",
          metadata: { principal: ALICE_OWNER, activationPolicy: "all" },
        })
        [Symbol.asyncIterator]();
      const gate = (await iterator.next()).value;
      if (gate?.kind !== "handshake-required")
        throw new Error("Expected the first branch's workspace handshake");
      await historyEntered.promise;
      await expect(
        workerHub.handshake(gate.handshakeId, { decline: true }),
      ).resolves.toEqual({ status: "ok" });
      expect((await iterator.next()).value).toMatchObject({
        kind: "rejected",
        arcRef: gate.arcRef,
      });
      releaseHistory.resolve();
      const activated = (await iterator.next()).value;
      if (activated?.kind !== "activated")
        throw new Error("Expected the initial fork's remaining activation");
      expect(activated.reactivationCount).toBe(0);
      await expect(iterator.next()).resolves.toEqual({
        done: true,
        value: undefined,
      });
      await waitFor(async () => {
        const view = await arcHost.getRunView(activated.arcRunId);
        return view?.stage === "actioning" && view.lifecycle === "completed";
      });
      expect(worker).toHaveBeenCalledTimes(1);
    } finally {
      releaseHistory.resolve();
      await workerHub.stop();
      await arcHost.stop();
    }
  });

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
    const arcHost = await createTestArcHost({ store, logger });
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
      reactivationCount: 1,
      arcRunId: firstRunId,
    });
  });

  it("converts missing and invalid handshakes to connector receipts", async () => {
    const arcHost = await makeArcHost();
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
    const arcHost = await createTestArcHost({
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
    const arcHost = await makeArcHost();
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
    const arcHost = await makeArcHost();
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

  it("accepts inbound messages even when handler execution later fails", async () => {
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
    const arcHost = await createTestArcHost({ store, logger });
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

describe("source deletion during admission", () => {
  const source = parse(
    '"arc"; function Main() { this.trigger = () => true; $instruct("Work"); }',
  );
  const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };

  it.each(["workspace", "arc-choice", "run-choice"] as const)(
    "retires a deleted %s fresh selection without reviving it on re-registration",
    async (kind) => {
      const host = await makeArcHost();
      await host.registerArc("removed", source, {
        workspaceScope: kind === "workspace" ? "arc" : "run",
        contextIsolation: "role",
        bundle: {},
      });
      if (kind === "run-choice")
        await host.begin({
          dialog,
          inbound: { content: "start" },
          principal: ALICE_OWNER,
          projectDialog: async () => dialog,
        });
      if (kind === "arc-choice") await host.registerArc("sibling", source);
      const { workerHub } = makeWorkerHub({ arcHost: host });
      try {
        const iterator = workerHub
          .submitInbound({
            content: "start",
            metadata: {
              principal: ALICE_OWNER,
              activationPolicy: kind === "arc-choice" ? "choose" : "first",
            },
          })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        if (first.done || first.value.kind !== "handshake-required")
          throw new Error("Expected handshake");
        const gate = first.value;
        let sibling:
          | Extract<InboundLifecycleEvent, { kind: "handshake-required" }>
          | undefined;
        if (kind === "arc-choice") {
          const next = await iterator.next();
          if (next.done || next.value.kind !== "handshake-required")
            throw new Error("Expected sibling handshake");
          sibling = next.value;
        }
        await host.registerArcs([{ source: "removed", delete: true }]);
        await host.registerArc("removed", source);
        const answer =
          kind === "workspace"
            ? { workspace: "/tmp/deleted-workspace" }
            : kind === "run-choice"
              ? { runChoice: { action: "fresh" as const } }
              : { arcChoice: { activate: true } };
        await expect(
          workerHub.handshake(gate.handshakeId, answer),
        ).resolves.toEqual({ status: "missing" });
        await expect(
          workerHub.handshake(gate.handshakeId, answer),
        ).resolves.toEqual({ status: "missing" });
        if (sibling) {
          await expect(
            workerHub.handshake(sibling.handshakeId, { decline: true }),
          ).resolves.toEqual({ status: "ok" });
          expect((await iterator.next()).value).toMatchObject({
            kind: "rejected",
            arcRef: sibling.arcRef,
          });
        }
        expect((await iterator.next()).done).toBe(true);
        expect(
          (await host.listRunViews()).filter(
            (view) => view.stage !== "actioning",
          ),
        ).toEqual([]);
      } finally {
        await workerHub.stop();
      }
    },
  );

  it("keeps an existing-run join usable when deletion invalidates a sibling fresh choice", async () => {
    const host = await makeArcHost();
    await host.registerArc("removed", source);
    const [started] = await host.begin({
      dialog,
      inbound: { content: "start" },
      principal: ALICE_OWNER,
      projectDialog: async () => dialog,
    });
    if (started?.kind !== "action") throw new Error("Expected action");
    const { workerHub } = makeWorkerHub({ arcHost: host });
    try {
      const first = lifecycleReader(
        workerHub.submitInbound({
          content: "fresh",
          metadata: { principal: ALICE_OWNER },
        }),
      );
      const second = lifecycleReader(
        workerHub.submitInbound({
          content: "join",
          metadata: { principal: ALICE_OWNER },
        }),
      );
      const fresh = await first.next();
      const join = await second.next();
      if (
        fresh.kind !== "handshake-required" ||
        join.kind !== "handshake-required"
      )
        throw new Error("Expected run choices");
      await host.registerArcs([{ source: "removed", delete: true }]);
      await expect(
        workerHub.handshake(fresh.handshakeId, {
          runChoice: { action: "fresh" },
        }),
      ).resolves.toEqual({ status: "missing" });
      await expect(
        workerHub.handshake(join.handshakeId, {
          runChoice: { action: "join", arcRunId: started.arcRunId },
        }),
      ).resolves.toEqual({ status: "ok" });
      expect(await second.next()).toEqual({
        kind: "joined",
        reactivationCount: 0,
        arcRef: "arc:removed:Main",
        arcRunId: started.arcRunId,
      });
      expect(await host.getRunView(started.arcRunId)).toMatchObject({
        stage: "actioning",
        lifecycle: "active",
      });
    } finally {
      await workerHub.stop();
    }
  });

  it("settles deletion during consumed handshake resolution as missing", async () => {
    const hostStore = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store: hostStore });
    await host.registerArc("removed", source, {
      workspaceScope: "arc",
      contextIsolation: "role",
      bundle: {},
    });
    const { workerHub } = makeWorkerHub({ arcHost: host });
    const consumed = deferred();
    const release = deferred();
    const runStore = hostStore;
    const getState = runStore.getState.bind(runStore);
    let holdActivation = false;
    vi.spyOn(runStore, "getState").mockImplementation(async (key) => {
      if (holdActivation) {
        holdActivation = false;
        consumed.resolve();
        await release.promise;
      }
      return getState(key);
    });
    try {
      const iterator = workerHub
        .submitInbound({
          content: "start",
          metadata: { principal: ALICE_OWNER },
        })
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.kind !== "handshake-required")
        throw new Error("Expected handshake");
      holdActivation = true;
      const resolving = workerHub.handshake(first.value.handshakeId, {
        workspace: "/tmp/removed-during-resolve",
      });
      await consumed.promise;
      await host.registerArcs([{ source: "removed", delete: true }]);
      release.resolve();
      await expect(resolving).resolves.toEqual({ status: "missing" });
      expect((await iterator.next()).done).toBe(true);
      expect(await host.listRunViews()).toEqual([]);
    } finally {
      release.resolve();
      await workerHub.stop();
    }
  });

  it.each(["workspace", "run-choice"] as const)(
    "settles source deletion after staging a follow-up %s handshake",
    async (kind) => {
      const handshakes = new HandshakeStore();
      const host = await createTestArcHost({
        store: new InMemoryArcHostStore(),
        handshakes,
      });
      await host.registerArc("removed", source, {
        workspaceScope: kind === "workspace" ? "arc" : "run",
        contextIsolation: "role",
        bundle: {},
      });
      const existing =
        kind === "run-choice"
          ? (
              await host.begin({
                dialog,
                principal: ALICE_OWNER,
                inbound: { content: "start" },
                projectDialog: async () => dialog,
              })
            )[0]
          : undefined;
      await host.registerArc("sibling", source);
      const { workerHub } = makeWorkerHub({ arcHost: host });
      try {
        const iterator = workerHub
          .submitInbound({
            content: "choose",
            metadata: { principal: ALICE_OWNER, activationPolicy: "choose" },
          })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        const second = await iterator.next();
        if (
          first.done ||
          first.value.kind !== "handshake-required" ||
          second.done ||
          second.value.kind !== "handshake-required"
        )
          throw new Error("Expected arc choices");
        await expect(
          workerHub.handshake(first.value.handshakeId, {
            arcChoice: { activate: true },
          }),
        ).resolves.toEqual({ status: "ok" });
        const followup = await iterator.next();
        if (followup.done || followup.value.kind !== "handshake-required")
          throw new Error("Expected follow-up handshake");
        await host.registerArcs([{ source: "removed", delete: true }]);
        if (kind === "run-choice") {
          if (existing?.kind !== "action")
            throw new Error("Expected existing run");
          await expect(
            workerHub.handshake(followup.value.handshakeId, {
              runChoice: { action: "join", arcRunId: existing.arcRunId },
            }),
          ).resolves.toEqual({ status: "ok" });
          expect((await iterator.next()).value).toMatchObject({
            kind: "joined",
            arcRunId: existing.arcRunId,
          });
        } else {
          await expect(
            workerHub.handshake(followup.value.handshakeId, {
              workspace: "/tmp/removed-followup-workspace",
            }),
          ).resolves.toEqual({ status: "missing" });
        }
        await workerHub.handshake(second.value.handshakeId, { decline: true });
        expect((await iterator.next()).value).toMatchObject({
          kind: "rejected",
          arcRef: second.value.arcRef,
        });
        expect((await iterator.next()).done).toBe(true);
        expect(handshakes.listPending()).toEqual([]);
      } finally {
        await workerHub.stop();
      }
    },
  );

  it("orders source deletion after an in-flight first durable run commit", async () => {
    const store = new InMemoryArcHostStore();
    const host = await createTestArcHost({ store });
    await host.registerArc("removed", source, {
      workspaceScope: "arc",
      contextIsolation: "role",
      bundle: {},
    });
    const { workerHub } = makeWorkerHub({ arcHost: host });
    const entered = deferred();
    const release = deferred();
    const put = store.putState.bind(store);
    vi.spyOn(store, "putState").mockImplementationOnce(async (key, state) => {
      entered.resolve();
      await release.promise;
      return put(key, state);
    });
    try {
      const iterator = workerHub
        .submitInbound({
          content: "start",
          metadata: { principal: ALICE_OWNER },
        })
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.kind !== "handshake-required")
        throw new Error("Expected workspace handshake");
      const resolving = workerHub.handshake(first.value.handshakeId, {
        workspace: "/tmp/committed-before-deletion",
      });
      await entered.promise;
      let deleted = false;
      const deleting = host
        .registerArcs([{ source: "removed", delete: true }])
        .then(() => {
          deleted = true;
        });
      await Promise.resolve();
      expect(deleted).toBe(false);
      release.resolve();
      await expect(resolving).resolves.toEqual({ status: "ok" });
      await deleting;
      const activated = await iterator.next();
      if (activated.done || activated.value.kind !== "activated")
        throw new Error("Expected committed run");
      expect(await host.getRunView(activated.value.arcRunId)).toMatchObject({
        stage: "actioning",
        lifecycle: "active",
      });
      expect(
        (await host.getRunWorkspaceContext(activated.value.arcRunId))
          .workspacePath,
      ).toBe("/tmp/committed-before-deletion");
    } finally {
      release.resolve();
      await workerHub.stop();
    }
  });
});
