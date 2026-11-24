import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  arcRunKey,
  InMemoryReplayStore,
  JsonFileReplayStore,
  positionKey,
  type ArcRunId,
  type ReplayCheckpoint,
  type ReplayStep,
  type ReplayStore,
} from "../src/testing.js";

const RUN: ArcRunId = "arc-run:replay-store-test";

function actionBriefStep(
  index: number,
  active: `node:${string}` = "node:s:A",
  reactivationCount = 0,
): ReplayStep {
  return {
    kind: "action-brief",
    position: { stage: "action", index, reactivationCount },
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    brief: {
      active,
      canProgress: true,
      issues: [],
      hostCalls: [],
      judgments: [],
      observations: [],
      instructions: [],
      allowedMoves: ["proceed"],
    },
  };
}

function triggerBriefStep(index: number): ReplayStep {
  return {
    kind: "trigger-brief",
    hostModules: { calls: [] },
    position: { stage: "trigger", index, reactivationCount: 0 },
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    brief: {
      deps: [],
      issues: [],
      judgments: [],
      observations: [],
      hostCalls: [],
      matchableArcs: [],
    },
  };
}

function terminalBriefStep(index: number): ReplayStep {
  return {
    kind: "terminal-brief",
    position: { stage: "action", index, reactivationCount: 0 },
    dialog: { cursor: { user: 0, self: 0 }, lastTurns: [] },
    brief: {
      canProgress: false,
      root: "arc:s:A",
      outcome: "covered",
      issues: [],
    },
  };
}

function checkpoint(index: number, reactivationCount = 0): ReplayCheckpoint {
  return {
    position: { stage: "action", index, reactivationCount },
    traversals: [],
    hostModules: { calls: [] },
  };
}

async function exercise(store: ReplayStore): Promise<void> {
  const start: ReplayStep = {
    kind: "trigger-start",
    position: { stage: "trigger", index: 0, reactivationCount: 0 },
    dialog: {
      cursor: { user: 1, self: 0 },
      lastTurns: [{ role: "user", message: "start" }],
    },
    arcRefs: ["arc:s:A"],
  };
  await store.appendStep(RUN, start);
  await store.appendStep(RUN, triggerBriefStep(1));
  await store.appendStep(RUN, actionBriefStep(1));
  await store.appendStep(RUN, actionBriefStep(2));

  const steps = await store.listSteps(RUN);
  expect(steps[0]).toEqual(start);
  expect(
    steps.map((step) => `${step.kind}:${positionKey(step.position)}`),
  ).toEqual([
    "trigger-start:0:trigger:0",
    "trigger-brief:0:trigger:1",
    "action-brief:0:action:1",
    "action-brief:0:action:2",
  ]);

  await store.putCheckpoint(RUN, checkpoint(0));
  await store.putCheckpoint(RUN, checkpoint(2));
  await store.putCheckpoint(RUN, checkpoint(1));
  expect(
    (await store.listCheckpoints(RUN)).map((entry) => entry.position.index),
  ).toEqual([0, 1, 2]);
  expect(
    await store.getCheckpoint(RUN, {
      stage: "action",
      index: 1,
      reactivationCount: 0,
    }),
  ).toEqual([]);
  expect(
    await store.getCheckpoint(RUN, {
      stage: "action",
      index: 9,
      reactivationCount: 0,
    }),
  ).toBeUndefined();

  const retainedSteps = await store.listSteps(RUN);
  const retainedCheckpoints = await store.listCheckpoints(RUN);
  await store.appendStep(RUN, actionBriefStep(1, "node:s:LATER", 1));
  await store.putCheckpoint(RUN, checkpoint(0, 1));
  await store.truncateAfterReactivationCount(RUN, 0);
  expect(await store.listSteps(RUN)).toEqual(retainedSteps);
  expect(await store.listCheckpoints(RUN)).toEqual(retainedCheckpoints);
}

describe("ReplayStore implementations", () => {
  it("namespaces every replay position by reactivation count", () => {
    expect(
      positionKey({ stage: "action", index: 2, reactivationCount: 0 }),
    ).toBe("0:action:2");
    expect(
      positionKey({ stage: "action", index: 2, reactivationCount: 3 }),
    ).toBe("3:action:2");
  });

  it("InMemoryReplayStore round-trips steps and checkpoints in order", async () => {
    await exercise(new InMemoryReplayStore());
  });

  it("JsonFileReplayStore round-trips steps and checkpoints in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-replay-store-"));
    try {
      const store = new JsonFileReplayStore({ dir });
      await exercise(store);
      const reopened = new JsonFileReplayStore({ dir });
      expect(await reopened.listSteps(RUN)).toEqual(await store.listSteps(RUN));
      expect(await reopened.listCheckpoints(RUN)).toEqual(
        await store.listCheckpoints(RUN),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keys stage-aware: trigger and action at the same index do not collide", async () => {
    const store = new InMemoryReplayStore();
    await store.appendStep(RUN, triggerBriefStep(1));
    await store.appendStep(RUN, actionBriefStep(1));
    const steps = await store.listSteps(RUN);
    expect(steps).toHaveLength(2);
  });

  it("JsonFileReplayStore writes stable positionKey checkpoint files under one run dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-replay-store-"));
    const store = new JsonFileReplayStore({ dir });
    await store.appendStep(RUN, actionBriefStep(1));
    await store.putCheckpoint(RUN, checkpoint(0));

    const runDirName = encodeURIComponent(arcRunKey(RUN));
    const runDir = join(dir, runDirName);
    expect((await stat(runDir)).isDirectory()).toBe(true);
    const checkpointFiles = await readdir(join(runDir, "checkpoints"));
    expect(checkpointFiles).toEqual(["0:action:0.json"]);
    expect(checkpointFiles).not.toContain("[object Object].json");
    // Exactly one run directory under the replay root.
    expect(await readdir(dir)).toEqual([runDirName]);
  });

  it("idempotency: equal re-append is ignored, differing one throws", async () => {
    const store = new InMemoryReplayStore();
    await store.appendStep(RUN, actionBriefStep(1));
    await store.appendStep(RUN, actionBriefStep(1));
    expect(await store.listSteps(RUN)).toHaveLength(1);
    await expect(
      store.appendStep(RUN, actionBriefStep(1, "node:s:DIFFERENT")),
    ).rejects.toThrow(/conflict/);

    await store.putCheckpoint(RUN, checkpoint(0));
    await store.putCheckpoint(RUN, checkpoint(0));
    expect(await store.listCheckpoints(RUN)).toHaveLength(1);
    await expect(
      store.putCheckpoint(RUN, {
        position: { stage: "action", index: 0, reactivationCount: 0 },
        hostModules: { calls: [] },
        traversals: [
          { ref: "arc:s:A" },
        ] as unknown as ReplayCheckpoint["traversals"],
      }),
    ).rejects.toThrow(/conflict/);
  });

  it("allows only one action output at a replay position", async () => {
    const store = new InMemoryReplayStore();
    await store.appendStep(RUN, actionBriefStep(1));
    await expect(store.appendStep(RUN, terminalBriefStep(1))).rejects.toThrow(
      /conflict/,
    );
  });
});

it.each(["memory", "json"] as const)(
  "replay.position-keys updates only checkpoint host module state in %s storage",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "arcade-checkpoint-module-"));
    const store =
      kind === "memory"
        ? new InMemoryReplayStore()
        : new JsonFileReplayStore({ dir });
    try {
      const entry = checkpoint(1);
      await store.putCheckpoint(RUN, entry);
      const hostModules: ReplayCheckpoint["hostModules"] = {
        calls: [
          {
            call: {
              hostCallId: "call",
              sourceRef: "node:s:A",
              module: "time",
              target: [],
              operation: "sleep",
              arguments: [1000],
              hostParams: undefined,
              moduleData: { deadlineMillis: 1000 },
            },
            context: { arcRunId: RUN },
            acknowledged: true,
            effects: [],
          },
        ],
      };
      await store.updateCheckpointHostModules(RUN, entry.position, hostModules);
      hostModules.calls[0]!.call.moduleData = { deadlineMillis: 2000 };
      const saved = (await store.listCheckpoints(RUN))[0]!;
      expect(saved.traversals).toEqual(entry.traversals);
      expect(saved.hostModules.calls[0]!.call.moduleData).toEqual({
        deadlineMillis: 1000,
      });
      expect(saved.position).toEqual(entry.position);
      await expect(store.putCheckpoint(RUN, entry)).rejects.toThrow(/conflict/);
      await expect(
        store.updateCheckpointHostModules(
          RUN,
          checkpoint(99).position,
          hostModules,
        ),
      ).rejects.toThrow(/missing/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
