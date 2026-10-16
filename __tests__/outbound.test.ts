import { describe, expect, it, vi } from "vitest";

import {
  InMemoryHistoryStore,
  type OutboundMessage,
  type RoleWorker,
} from "../src/testing.js";
import {
  WATCH_SOURCE,
  makeArcHostWithSource,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";
import { submitActivation } from "./worker-hub-helpers.js";

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
