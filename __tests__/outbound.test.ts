import { parse } from "@elem-app/arc/parser";
import { describe, expect, it, vi } from "vitest";

import {
  InMemoryArcHostStore,
  InMemoryHistoryStore,
  type OutboundMessage,
  type RoleWorker,
} from "../src/testing.js";
import { makeControlledTime } from "./controlled-time.js";
import {
  WATCH_SOURCE,
  deferred,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";
import { drainLifecycle, submitActivation } from "./worker-hub-helpers.js";

describe("Outbound situations and delivery", () => {
  it("stamps situation.role from the task and defaults audience to originator", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const emitted: OutboundMessage[] = [];
    const worker: RoleWorker = async (_task, _context, effects) => {
      // Worker tries to forge `role: "intruder"`; expect host to overwrite it.
      await effects.emit({
        situation: {
          role: "intruder",
          cause: "reply",
        } as unknown as { cause: "reply" },
        content: "Stamped.",
      });
      return { outcome: "completed" };
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "reply" },
      (message) => {
        emitted.push(message);
      },
    );

    await submitActivation(workerHub, "go");

    await waitFor(() => emitted.length === 1);
    expect(emitted[0]?.situation).toEqual({
      role: "researcher",
      audience: "originator",
      cause: "reply",
    });
  });

  it("preserves worker-supplied audience when stamping outbound situations", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const emitted: OutboundMessage[] = [];
    const worker: RoleWorker = async (_task, _context, effects) => {
      await effects.emit({
        situation: { audience: "supervisor", cause: "reply" },
        content: "Need sign-off.",
      });
      return { outcome: "completed" };
    };
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: { researcher: worker },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "supervisor", cause: "reply" },
      (message) => {
        emitted.push(message);
      },
    );

    await submitActivation(workerHub, "go");

    await waitFor(() => emitted.length === 1);
    expect(emitted[0]?.situation).toEqual({
      role: "researcher",
      audience: "supervisor",
      cause: "reply",
    });
  });

  it("lets role workers emit outbound messages without creating self replies", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const historyStore = new InMemoryHistoryStore();
    const emitted: OutboundMessage[] = [];
    const worker = vi.fn<RoleWorker>(async (_task, _context, effects) => {
      await effects.emit({
        situation: { cause: "reply" },
        content: "Research update.",
      });
      return { outcome: "completed" };
    });
    const { workerHub } = makeWorkerHub({
      arcHost,
      historyStore,
      workers: { researcher: worker },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "reply" },
      (message) => {
        emitted.push(message);
      },
    );

    const arcRunId = await submitActivation(workerHub, "watch this");

    await waitFor(() => emitted.length === 1);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual([
      {
        situation: {
          role: "researcher",
          audience: "originator",
          cause: "reply",
        },
        arcRunId,
        content: "Research update.",
      },
    ]);
    const entries = await historyStore.listEntries(arcRunId);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      from: { kind: "audience", name: "originator" },
      content: "watch this",
    });
    expect(entries[1]).toMatchObject({
      from: { kind: "role", id: "researcher" },
      to: { kind: "audience", name: "originator" },
      content: "Research update.",
    });
  });
});

describe("WorkerHubService outbound handler tree", () => {
  it("fires a fully-exact handler only on an exact situation match", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const handler = vi.fn();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.emit({
            situation: { audience: "supervisor", cause: "reply" },
            content: "go",
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "supervisor", cause: "reply" },
      handler,
    );

    await submitActivation(workerHub, "hi");

    await waitFor(() => handler.mock.calls.length === 1);
    expect(handler.mock.calls[0]![0]!.situation).toEqual({
      role: "researcher",
      audience: "supervisor",
      cause: "reply",
    });
  });

  it("fires a wildcard-audience handler regardless of the emitted audience", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const handler = vi.fn();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.emit({
            situation: { audience: "approver", cause: "reply" },
            content: "draft ready",
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "*", cause: "reply" },
      handler,
    );

    await submitActivation(workerHub, "hi");

    await waitFor(() => handler.mock.calls.length === 1);
    expect(handler.mock.calls[0]![0]!.situation.audience).toBe("approver");
  });

  it("fires both an exact-audience and a wildcard-audience handler when both match", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const exactHandler = vi.fn();
    const wildcardHandler = vi.fn();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.emit({
            situation: { audience: "originator", cause: "reply" },
            content: "done",
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "originator", cause: "reply" },
      exactHandler,
    );
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "*", cause: "reply" },
      wildcardHandler,
    );

    await submitActivation(workerHub, "hi");

    await waitFor(
      () =>
        exactHandler.mock.calls.length === 1 &&
        wildcardHandler.mock.calls.length === 1,
    );
  });

  it("does not let one rule mask another when both have wildcards on different dimensions", async () => {
    // Reproduces the case raised during design review:
    //   #1 (role:*,      audience:originator)
    //   #2 (role:writer, audience:*)
    // An emit with (role:writer, audience:approver) must hit #2, even though
    // it walks the role-wildcard branch first and finds only an
    // audience:originator child there.
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const everyRoleOriginator = vi.fn();
    const writerEveryAudience = vi.fn();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.emit({
            situation: { audience: "approver", cause: "reply" },
            content: "approve?",
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "*", audience: "originator", cause: "reply" },
      everyRoleOriginator,
    );
    workerHub.registerOutboundHandler(
      { role: "researcher", audience: "*", cause: "reply" },
      writerEveryAudience,
    );

    await submitActivation(workerHub, "hi");

    await waitFor(() => writerEveryAudience.mock.calls.length === 1);
    expect(everyRoleOriginator).not.toHaveBeenCalled();
  });

  it("dispatches nothing when no registered handler matches", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const handler = vi.fn();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.emit({
            situation: { audience: "originator", cause: "reply" },
            content: "x",
          });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(
      { role: "scribbler", audience: "*", cause: "*" },
      handler,
    );

    await submitActivation(workerHub, "hi");

    // Give the turn a chance to complete; handler should still not have fired.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops dispatching to a handler after its unregister function is called", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const handler = vi.fn();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects.emit({
            situation: { audience: "originator", cause: "reply" },
            content: "x",
          });
          return { outcome: "completed" };
        },
      },
    });
    const unregister = workerHub.registerOutboundHandler(
      { role: "*", audience: "*", cause: "*" },
      handler,
    );
    unregister();

    await submitActivation(workerHub, "hi");

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("WorkerHubService live ask listing", () => {
  const ALL = { role: "*", audience: "*", cause: "*" } as const;

  it("out.handler-settlement publishes both blocked asks after delivery acceptance and settles their answers independently", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const accepted = deferred();
    const delivered: OutboundMessage[] = [];
    const questionAnswered = vi.fn();
    const permissionAnswered = vi.fn();
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await Promise.all([
            effects
              .emit({
                situation: { audience: "supervisor", cause: "question" },
                content: "Approve the draft?",
              })
              .then(questionAnswered),
            effects
              .requestPermission({
                toolCallId: "tool:write",
                toolName: "Write",
                input: { file_path: "notes.txt" },
              })
              .then(permissionAnswered),
          ]);
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(ALL, async (message) => {
      delivered.push(message);
      await accepted.promise;
    });

    try {
      const arcRunId = await submitActivation(workerHub, "review the draft");
      await waitFor(() => delivered.length === 2);
      expect(workerHub.listAsks(arcRunId, ALL)).toEqual(delivered);
      expect(
        (await workerHub.listWorkEvents(arcRunId)).filter((event) =>
          event.kind.startsWith("blocked:"),
        ),
      ).toEqual([]);

      accepted.resolve();
      await waitFor(
        async () =>
          (await workerHub.listWorkEvents(arcRunId)).filter((event) =>
            event.kind.startsWith("blocked:"),
          ).length === 2,
      );
      const question = delivered.find(
        (message) => message.situation.cause === "question",
      )!;
      const permission = delivered.find(
        (message) => message.situation.cause === "permission-ask",
      )!;
      expect(question.metadata?.askId).not.toBe(permission.metadata?.askId);
      expect(await workerHub.listWorkEvents(arcRunId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "blocked:question",
            askId: question.metadata?.askId,
          }),
          expect.objectContaining({
            kind: "blocked:permission",
            askId: permission.metadata?.askId,
          }),
        ]),
      );
      expect(questionAnswered).not.toHaveBeenCalled();
      expect(permissionAnswered).not.toHaveBeenCalled();

      await expect(
        drainLifecycle(
          workerHub.submitInbound({
            arcRunId,
            content: "approved",
            metadata: { askId: question.metadata?.askId },
          }),
        ),
      ).resolves.toEqual([{ kind: "continued", arcRunId }]);
      await waitFor(() => questionAnswered.mock.calls.length === 1);
      expect(questionAnswered).toHaveBeenCalledWith("approved");
      expect(permissionAnswered).not.toHaveBeenCalled();
      expect(workerHub.listAsks(arcRunId, ALL)).toEqual([permission]);
      expect(await arcHost.getRunView(arcRunId)).toMatchObject({
        lifecycle: "active",
      });

      await expect(
        drainLifecycle(
          workerHub.submitInbound({
            arcRunId,
            content: "allow writing",
            metadata: { askId: permission.metadata?.askId, decision: "allow" },
          }),
        ),
      ).resolves.toEqual([{ kind: "continued", arcRunId }]);
      await waitFor(async () => {
        const view = await arcHost.getRunView(arcRunId);
        return view?.stage === "actioning" && view.lifecycle === "completed";
      });
      expect(permissionAnswered).toHaveBeenCalledWith({
        decision: "allow",
        message: "allow writing",
      });
      expect(workerHub.listAsks(arcRunId, ALL)).toEqual([]);
    } finally {
      accepted.resolve();
      await workerHub.stop();
      await arcHost.stop();
    }
  });

  /** A researcher run whose worker holds one question and one permission ask. */
  async function hubWithTwoAsks() {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    const dispatched: OutboundMessage[] = [];
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await Promise.all([
            effects.emit({
              situation: { cause: "question" },
              content: "Which source?",
            }),
            effects.requestPermission({
              toolCallId: "tool:write",
              toolName: "Write",
              input: { file_path: "notes.txt" },
            }),
          ]);
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(ALL, (message) => {
      dispatched.push(message);
    });
    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(() => dispatched.length === 2);
    return { workerHub, arcRunId, dispatched };
  }

  it("out.live-asks lists live questions and permission asks in registration order", async () => {
    const { workerHub, arcRunId, dispatched } = await hubWithTwoAsks();

    expect(workerHub.listAsks(arcRunId, ALL)).toEqual(dispatched);
    expect(
      workerHub.listAsks(arcRunId, ALL).map((ask) => ask.situation.cause),
    ).toEqual(["question", "permission-ask"]);
    expect(
      workerHub
        .listAsks(arcRunId, ALL)
        .every((ask) => typeof ask.metadata?.askId === "string"),
    ).toBe(true);
  });

  it("out.live-asks matches situations with the exact-or-wildcard rule", async () => {
    const { workerHub, arcRunId, dispatched } = await hubWithTwoAsks();
    const [question, permission] = dispatched;

    expect(
      workerHub.listAsks(arcRunId, {
        role: "researcher",
        audience: "originator",
        cause: "question",
      }),
    ).toEqual([question]);
    expect(
      workerHub.listAsks(arcRunId, {
        role: "*",
        audience: "permissionApprover",
        cause: "*",
      }),
    ).toEqual([permission]);
    expect(
      workerHub.listAsks(arcRunId, {
        role: "reviewer",
        audience: "*",
        cause: "*",
      }),
    ).toEqual([]);
  });

  it("out.live-asks omits other runs, settled asks, and asks disposed with their routine", async () => {
    const arcHost = await makeArcHostWithSource(
      "watch",
      `"arc";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  $instruct(\`Ask and wait.\`);
  $instruct(\`Ask and leave.\`);
}`,
    );
    const dispatched: OutboundMessage[] = [];
    let invocation = 0;
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          invocation += 1;
          const asked = effects.emit({
            situation: { cause: "question" },
            content: invocation === 1 ? "Wait for me?" : "Abandoned?",
          });
          if (invocation === 1) await asked;
          else void asked.catch(() => undefined);
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(ALL, (message) => {
      dispatched.push(message);
    });
    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(() => dispatched.length === 1);
    expect(workerHub.listAsks(arcRunId, ALL)).toHaveLength(1);
    expect(workerHub.listAsks("arc-run:other", ALL)).toEqual([]);

    // Settling the first ask removes it; the second routine's ask is disposed
    // when that routine ends without waiting for it.
    await drainLifecycle(
      workerHub.submitInbound({
        arcRunId,
        content: "yes",
        metadata: { askId: dispatched[0]!.metadata?.askId },
      }),
    );
    await waitFor(async () =>
      (await workerHub.listWorkEvents(arcRunId)).some(
        (event) => event.kind === "run:completed",
      ),
    );
    expect(dispatched).toHaveLength(2);
    expect(workerHub.listAsks(arcRunId, ALL)).toEqual([]);
  });

  it("out.live-asks omits asks released by supersession", async () => {
    const time = makeControlledTime();
    const arcHost = await createTestArcHost({
      store: new InMemoryArcHostStore(),
      ...time,
    });
    await arcHost.registerArc(
      "watch",
      parse(`"arc";
import Time from "host:time";
function Watch() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "researcher" };
  Time.$addTimeout(25);
  $instruct(\`Ask and wait.\`);
}`),
    );
    const dispatched: OutboundMessage[] = [];
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects
            .emit({ situation: { cause: "question" }, content: "Still there?" })
            .catch(() => undefined);
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(ALL, (message) => {
      dispatched.push(message);
    });
    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(() => dispatched.length === 1);
    expect(workerHub.listAsks(arcRunId, ALL)).toHaveLength(1);

    time.advanceTo(1025);
    time.fireDue();
    await waitFor(
      async () =>
        (await workerHub.getExecutionControlView(arcRunId)).status ===
        "uncaught-interruption",
    );
    expect(workerHub.listAsks(arcRunId, ALL)).toEqual([]);
  });

  it("out.handler-settlement rejects an ask whose handler rejects delivery", async () => {
    const arcHost = await makeArcHostWithSource("watch", WATCH_SOURCE);
    let rejection: string | undefined;
    let askId: unknown;
    const { workerHub } = makeWorkerHub({
      arcHost,
      workers: {
        researcher: async (_task, _context, effects) => {
          await effects
            .emit({ situation: { cause: "question" }, content: "Deliverable?" })
            .catch((error: unknown) => {
              rejection =
                error instanceof Error ? error.message : String(error);
            });
          return { outcome: "completed" };
        },
      },
    });
    workerHub.registerOutboundHandler(ALL, (message) => {
      askId = message.metadata?.askId;
      throw new Error("delivery failed");
    });

    const arcRunId = await submitActivation(workerHub, "start");
    await waitFor(() => rejection !== undefined);
    expect(rejection).toBe("delivery failed");
    expect(workerHub.listAsks(arcRunId, ALL)).toEqual([]);
    await expect(
      drainLifecycle(
        workerHub.submitInbound({
          arcRunId,
          content: "too late",
          metadata: { askId },
        }),
      ),
    ).resolves.toEqual([expect.objectContaining({ kind: "rejected" })]);
  });
});
