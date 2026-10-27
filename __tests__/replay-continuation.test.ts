import { parse } from "@elem-app/arc/parser";
import { Runtime, toNodeRef } from "@elem-app/arc/runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import {
  arcRunKey,
  handoffCheckpoint,
  InMemoryArcHostStore,
  InMemoryReplayStore,
  JsonFileArcHostStore,
  JsonFileReplayStore,
  type CompatibleReplay,
  type FailedReplay,
  type ReplayStep,
} from "../src/testing.js";
import {
  beginActivatedDriver,
  beginDriver,
  expectSoleHandshake,
  observeSnapshotReads,
  projectorFor,
  type StepDriver,
} from "./arc-host-helpers.js";
import { makeReplayHost, REPLAY_OWNER, userDialog } from "./replay-helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";

const source = (body: string) =>
  parse(`"arc"; function Main() { this.trigger = () => true; ${body} }`);
const dialog = userDialog("first");
const position = (index: number, reactivationCount = 0) => ({
  stage: "action" as const,
  index,
  reactivationCount,
});
function compatible(result: CompatibleReplay | FailedReplay): CompatibleReplay {
  if (result.status !== "compatible") throw new Error(result.reason);
  return result;
}
async function complete(
  driver: StepDriver,
  view = dialog,
): Promise<StepDriver> {
  return (
    await driver.advance({
      dialog: view,
      input: {
        reports: [],
        instructionCoverage: Object.fromEntries(
          driver.frontier.briefs.instructions.map((item) => [
            item.id,
            "applied" as const,
          ]),
        ),
      },
    })
  ).driver;
}

it.each([
  { edit: "instruction", body: '$instruct("C");', kind: "action-brief" },
  { edit: "terminal", body: "", kind: "terminal-brief" },
])(
  "replay.verify retains completed A before a divergent $edit output",
  async ({ body, kind }) => {
    const { host, replay, store } = await makeReplayHost();
    try {
      await host.registerArc(
        "source",
        source('$instruct("A"); $instruct("B");'),
      );
      const pending = await complete(await beginActivatedDriver(host, dialog));
      const before = await store.getState(arcRunKey(pending.arcRunId));
      const beforeSteps = await replay.listSteps(pending.arcRunId);
      await host.registerArc("candidate", source(`$instruct("A"); ${body}`));
      const result = compatible(
        await host.verifyReplay(pending.arcRunId, "arc:candidate:Main"),
      );
      expect(result.handoff).toBe("diverged");
      expect(handoffCheckpoint(result.regenerated).position).toEqual(
        position(2),
      );
      expect(
        result.regenerated.actionSteps.map((step) => [
          step.kind,
          step.position.index,
        ]),
      ).toEqual([
        ["action-brief", 1],
        ["action-report", 1],
        [kind, 2],
      ]);
      expect(await store.getState(arcRunKey(pending.arcRunId))).toEqual(before);
      expect(await replay.listSteps(pending.arcRunId)).toEqual(beforeSteps);
    } finally {
      await host.stop();
    }
  },
);

it.each(["memory", "json"] as const)(
  "replay.jump reconstructs and repeatedly replays its divergent continuation in %s storage",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "arc-replay-continuation-"));
    const store =
      kind === "memory"
        ? new InMemoryArcHostStore()
        : new JsonFileArcHostStore({ dir: join(dir, "host") });
    const replay =
      kind === "memory"
        ? new InMemoryReplayStore()
        : new JsonFileReplayStore({ dir: join(dir, "replay") });
    let host = await createTestArcHost({ store, replayStore: replay });
    try {
      await host.registerArc(
        "source",
        source('$instruct("A"); $instruct("B");'),
      );
      const afterA = userDialog("A is done", 2);
      const pending = await complete(
        await beginActivatedDriver(host, dialog),
        afterA,
      );
      await host.registerArc(
        "candidate",
        source('$instruct("A"); $instruct("C");'),
      );
      const jumped = await host.jump(pending.arcRunId, "arc:candidate:Main");
      if (jumped.status !== "compatible") throw new Error(jumped.reason);
      const finalOutput = jumped.regenerated.actionSteps.at(-1)!;
      expect(finalOutput.dialog).toEqual(afterA);
      expect(
        compatible(
          await host.verifyReplay(jumped.arcRunId, "arc:candidate:Main"),
        ).handoff,
      ).toBe("reproduced");
      const again = await host.jump(jumped.arcRunId, "arc:candidate:Main");
      expect(handoffCheckpoint(compatible(again).regenerated).position).toEqual(
        position(2),
      );
      const rewound = await host.rewind(jumped.arcRunId, position(2));
      const rewindReplay = compatible(
        await host.verifyReplay(rewound.arcRunId, "arc:candidate:Main"),
      );
      expect(handoffCheckpoint(rewindReplay.regenerated).position).toEqual(
        position(2),
      );
      const rewindDriver = await beginDriver(host, rewound.arcRunId, afterA);
      expect(
        rewindDriver.frontier.briefs.instructions.map((item) => item.text),
      ).toEqual(["C"]);
      expect((await complete(rewindDriver, afterA)).frontier.status).toBe(
        "completed",
      );
      await host.stop();
      host = await createTestArcHost({ store, replayStore: replay });
      const continued = await beginDriver(host, jumped.arcRunId, afterA);
      expect(
        continued.frontier.briefs.instructions.map((item) => item.text),
      ).toEqual(["C"]);
      expect(
        (await replay.listSteps(jumped.arcRunId)).filter(
          (step) => step.kind === "action-report",
        ),
      ).toHaveLength(1);
      await complete(continued, afterA);
      // Registering current candidate material enables verification after the service restart.
      await host.registerArc(
        "candidate",
        source('$instruct("A"); $instruct("C");'),
      );
      const verified = compatible(
        await host.verifyReplay(jumped.arcRunId, "arc:candidate:Main"),
      );
      expect(verified.handoff).toBe("reproduced");
      expect(handoffCheckpoint(verified.regenerated).position).toEqual(
        position(3),
      );
      expect(verified.regenerated.actionSteps.at(-1)).toMatchObject({
        kind: "terminal-brief",
        brief: { outcome: "covered" },
      });
    } finally {
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("replay.iso discards tentative pairings when a later item in the frontier differs", async () => {
  const { host } = await makeReplayHost();
  try {
    await host.registerArc(
      "source",
      source('$instructLoop("old", { resolveWhen: () => judge("same") });'),
    );
    const run = await beginActivatedDriver(host, dialog);
    await host.registerArc(
      "candidate",
      source('$instructLoop("new", { resolveWhen: () => judge("same") });'),
    );
    const result = compatible(
      await host.verifyReplay(run.arcRunId, "arc:candidate:Main"),
    );
    expect(result.handoff).toBe("diverged");
    expect(result.iso.nodes.get("node:source:Main")).toBeUndefined();
    expect(run.frontier.briefs.judgments).toHaveLength(1);
    for (const judgment of run.frontier.briefs.judgments)
      expect(result.iso.briefIds.get(judgment.id)).toBeUndefined();
    expect(handoffCheckpoint(result.regenerated).position).toEqual(position(1));
  } finally {
    await host.stop();
  }
});

it("replay.verify validates targets against the selected prefix and preserves earlier divergence", async () => {
  const { host } = await makeReplayHost();
  try {
    await host.registerArc("source", source('$instruct("A"); $instruct("B");'));
    const first = await beginActivatedDriver(host, dialog);
    await complete(await complete(first));
    await host.registerArc(
      "candidate",
      source('$instruct("A"); $instruct("C");'),
    );
    const seed = compatible(
      await host.verifyReplay(first.arcRunId, "arc:candidate:Main", {
        untilPosition: position(0),
      }),
    );
    expect(handoffCheckpoint(seed.regenerated).position).toEqual(position(0));
    expect(seed.regenerated.actionSteps).toEqual([]);
    const seedJump = await host.jump(first.arcRunId, "arc:candidate:Main", {
      untilPosition: position(0),
    });
    if (seedJump.status !== "compatible") throw new Error(seedJump.reason);
    expect(
      (
        await beginDriver(host, seedJump.arcRunId, dialog)
      ).frontier.briefs.instructions.map((item) => item.text),
    ).toEqual(["A"]);
    const early = compatible(
      await host.verifyReplay(first.arcRunId, "arc:candidate:Main", {
        untilPosition: position(1),
      }),
    );
    expect(early.handoff).toBe("reproduced");
    expect(early.regenerated.actionSteps).toHaveLength(1);
    for (const target of [position(2), position(3)]) {
      const divergent = compatible(
        await host.verifyReplay(first.arcRunId, "arc:candidate:Main", {
          untilPosition: target,
        }),
      );
      expect(divergent.handoff).toBe("diverged");
      expect(handoffCheckpoint(divergent.regenerated).position).toEqual(
        position(2),
      );
    }
    for (const target of [
      position(-1),
      position(1.5),
      position(4),
      position(1, 1),
    ]) {
      await expect(
        host.verifyReplay(first.arcRunId, "arc:candidate:Main", {
          untilPosition: target,
        }),
      ).rejects.toThrow();
      await expect(host.rewind(first.arcRunId, target)).rejects.toThrow();
    }
  } finally {
    await host.stop();
  }
});

it("replay.verify bounds source reads by saved state and selects the latest equivalent checkpoint", async () => {
  const { host, replay } = await makeReplayHost();
  try {
    await host.registerArc("source", source('$instruct("A"); $instruct("B");'));
    const first = await beginActivatedDriver(host, dialog);
    // An accepted empty report creates a second position with identical state.
    await first.advance({
      dialog,
      input: { reports: [], instructionCoverage: {} },
    });
    const savedSteps = await replay.listSteps(first.arcRunId);
    const savedCheckpoints = await replay.listCheckpoints(first.arcRunId);
    expect(savedCheckpoints[1]!.traversals).toEqual(
      savedCheckpoints[2]!.traversals,
    );
    const latest = compatible(
      await host.verifyReplay(first.arcRunId, "arc:source:Main"),
    );
    expect(handoffCheckpoint(latest.regenerated).position).toEqual(position(2));
    // Add tails beyond the selected action output and reactivation count.
    const tail: ReplayStep = {
      kind: "action-report",
      position: position(2),
      dialog,
      report: { move: "proceed" },
      origin: "worker",
    };
    await replay.appendStep(first.arcRunId, tail);
    await replay.appendStep(first.arcRunId, {
      kind: "trigger-report",
      position: { stage: "trigger", index: 1, reactivationCount: 1 },
      dialog,
      report: {},
      origin: "worker",
    });
    const writes = vi.spyOn(replay, "truncateAfterCheckpoint");
    const result = compatible(
      await host.verifyReplay(first.arcRunId, "arc:source:Main"),
    );
    expect(result.regenerated.actionSteps).toEqual(
      savedSteps.filter((step) => step.position.stage === "action"),
    );
    expect(result.regenerated.checkpoints).toEqual(savedCheckpoints);
    expect(writes).not.toHaveBeenCalled();
    expect(await replay.listSteps(first.arcRunId)).toHaveLength(
      savedSteps.length + 2,
    );
  } finally {
    await host.stop();
    vi.restoreAllMocks();
  }
});

it("replay.verify rejects malformed selected history before candidate divergence", async () => {
  const { host, replay } = await makeReplayHost();
  try {
    await host.registerArc("source", source('$instruct("A"); $instruct("B");'));
    const pending = await complete(await beginActivatedDriver(host, dialog));
    await host.registerArc("candidate", source('$instruct("different");'));
    const checkpoints = await replay.listCheckpoints(pending.arcRunId);
    vi.spyOn(replay, "listCheckpoints").mockResolvedValue(
      checkpoints.filter((cp) => cp.position.index !== 1),
    );
    await expect(
      host.verifyReplay(pending.arcRunId, "arc:candidate:Main"),
    ).rejects.toThrow("Missing replay output or checkpoint");
  } finally {
    await host.stop();
    vi.restoreAllMocks();
  }
});

it("replay.verify waits for an in-flight run commit before capturing the source", async () => {
  const { host, replay, store } = await makeReplayHost();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await host.registerArc("source", source('$instruct("A"); $instruct("B");'));
    const first = await beginActivatedDriver(host, dialog);
    const put = store.putState.bind(store);
    vi.spyOn(store, "putState").mockImplementationOnce(async (key, state) => {
      entered();
      await gate;
      await put(key, state);
    });
    const advancing = complete(first);
    await saving;
    const reads = vi.spyOn(replay, "listSteps");
    const verification = host.verifyReplay(first.arcRunId, "arc:source:Main");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reads).not.toHaveBeenCalled();
    release();
    await advancing;
    const result = compatible(await verification);
    expect(handoffCheckpoint(result.regenerated).position).toEqual(position(2));
    expect(result.regenerated.actionSteps.at(-1)).toMatchObject({
      brief: { instructions: [expect.objectContaining({ text: "B" })] },
    });
  } finally {
    release();
    await host.stop();
    vi.restoreAllMocks();
  }
});

it("replay.verify propagates an unexpected runtime failure after matching the frontier", async () => {
  const { host } = await makeReplayHost();
  try {
    await host.registerArc("source", source('$instruct("A"); $instruct("B");'));
    const pending = await complete(await beginActivatedDriver(host, dialog));
    const failure = new Error("unexpected runtime failure");
    vi.spyOn(Runtime.prototype, "progress").mockImplementationOnce(() => {
      throw failure;
    });
    await expect(
      host.verifyReplay(pending.arcRunId, "arc:source:Main"),
    ).rejects.toBe(failure);
  } finally {
    await host.stop();
    vi.restoreAllMocks();
  }
});

it.each([
  "first-action",
  "later-action",
  "later-trigger",
  "unchanged",
] as const)(
  "replay.verify composes reactivations through %s admission",
  async (edit) => {
    const { host, replay } = await makeReplayHost();
    const arc = (first: string, second: string, trigger = "true") =>
      parse(`"arc";
    function Main() {
      this.trigger = () => ${trigger};
      this.forgetfulEntry = true;
      if (Dialog.lastUserMessage == "first") $instruct("${first}");
      else $instruct("${second}");
      $enter(Wait);
      function Wait() { this.guard = () => State.DEFLECTED; }
    }`);
    try {
      await host.registerArc("source", arc("A", "B"));
      const first = await beginActivatedDriver(host, dialog, {
        principal: REPLAY_OWNER,
      });
      await complete(first);
      const firstBoundary = (await replay.listCheckpoints(first.arcRunId)).at(
        -1,
      )!;
      const secondDialog = userDialog("second", 2);
      const handshake = expectSoleHandshake(
        await host.begin({
          dialog: secondDialog,
          inbound: { content: "second" },
          principal: REPLAY_OWNER,
          projectDialog: projectorFor(secondDialog),
        }),
      );
      const reentry = await host.resolveHandshake(
        handshake.handshakeId,
        { runChoice: { action: "join", arcRunId: first.arcRunId } },
        { projectDialog: projectorFor(secondDialog) },
      );
      expect(reentry.status).toBe("ok");
      await host.registerArc(
        "source",
        arc(
          edit === "first-action" ? "changed" : "A",
          edit === "later-action" ? "C" : "B",
          edit === "later-trigger"
            ? 'Dialog.lastUserMessage == "first"'
            : "true",
        ),
        undefined,
        { replace: true },
      );
      const result = compatible(
        await host.verifyReplay(first.arcRunId, "arc:source:Main"),
      );
      const count = edit === "first-action" || edit === "later-trigger" ? 0 : 1;
      expect(
        handoffCheckpoint(result.regenerated).position.reactivationCount,
      ).toBe(count);
      expect(result.handoff).toBe(
        edit === "unchanged" ? "reproduced" : "diverged",
      );
      expect(
        result.regenerated.triggerSteps.every(
          (step) => step.position.reactivationCount <= count,
        ),
      ).toBe(true);
      if (edit === "later-trigger") {
        expect(handoffCheckpoint(result.regenerated).traversals).toEqual(
          firstBoundary.traversals,
        );
        const jumped = await host.jump(first.arcRunId, "arc:source:Main");
        if (jumped.status !== "compatible") throw new Error(jumped.reason);
        expect(await host.getRunView(jumped.arcRunId)).toMatchObject({
          lifecycle: "deflected",
        });
      }
      if (edit === "later-action")
        expect(result.regenerated.actionSteps.at(-1)).toMatchObject({
          brief: { instructions: [expect.objectContaining({ text: "C" })] },
        });
    } finally {
      await host.stop();
    }
  },
);

it("replay.verify retains completed A before a changed semantic frontier across a node transition", async () => {
  const { host, replay } = await makeReplayHost();
  const arc = (question: string) =>
    source(
      `$instruct("A"); $enter(Next); function Next() { if (judge("${question}")) $instruct("after"); }`,
    );
  try {
    await host.registerArc("source", arc("old?"));
    const pending = await complete(await beginActivatedDriver(host, dialog));
    expect(pending.frontier.briefs.judgments).toHaveLength(1);
    const final = (await replay.listCheckpoints(pending.arcRunId)).at(-1)!;
    const reports = (await replay.listSteps(pending.arcRunId)).filter(
      (step) => step.kind === "action-report",
    );
    await host.registerArc("source", arc("new?"), undefined, { replace: true });
    const result = compatible(
      await host.verifyReplay(pending.arcRunId, "arc:source:Main"),
    );
    expect(handoffCheckpoint(result.regenerated).position).toEqual(
      final.position,
    );
    expect(result.regenerated.actionSteps.at(-1)).toMatchObject({
      brief: { judgments: [expect.objectContaining({ question: "new?" })] },
    });
    expect(
      result.regenerated.actionSteps.filter(
        (step) => step.kind === "action-report",
      ),
    ).toHaveLength(reports.length);
  } finally {
    await host.stop();
  }
});

it("replay.jump keeps the captured candidate snapshot stable through materialization", async () => {
  const { host, store } = await makeReplayHost();
  try {
    await host.registerArc("source", source('$instruct("A"); $instruct("B");'));
    const pending = await complete(await beginActivatedDriver(host, dialog));
    await host.registerArc(
      "candidate",
      source('$instruct("A"); $instruct("C");'),
    );
    const put = store.putArcDocumentSnapshot.bind(store);
    vi.spyOn(store, "putArcDocumentSnapshot").mockImplementationOnce(
      async (snapshot) => {
        await host.registerArc(
          "candidate",
          source('$instruct("A"); $instruct("D");'),
          undefined,
          { replace: true },
        );
        await put(snapshot);
      },
    );
    const jumped = await host.jump(pending.arcRunId, "arc:candidate:Main");
    if (jumped.status !== "compatible") throw new Error(jumped.reason);
    expect(jumped.regenerated.actionSteps.at(-1)).toMatchObject({
      brief: { instructions: [expect.objectContaining({ text: "C" })] },
    });
    const continued = await beginDriver(host, jumped.arcRunId, dialog);
    expect(
      continued.frontier.briefs.instructions.map((item) => item.text),
    ).toEqual(["C"]);
  } finally {
    await host.stop();
    vi.restoreAllMocks();
  }
});

it("pins rewind and jump bundle mappings independently of later registrations", async () => {
  const { host, store, replay } = await makeReplayHost();
  const policy = (path: string) => ({
    workspaceScope: "run" as const,
    contextIsolation: "role" as const,
    bundle: { "guide/": path },
  });
  const document = source(
    'this.description = "Original label"; $instruct("Pending work");',
  );
  await host.registerArc("source", document, policy("/tmp/rewind-original"));
  const driver = await beginActivatedDriver(host, dialog);
  await host.registerArc(
    "candidate",
    source('this.description = "Candidate label"; $instruct("Pending work");'),
    policy("/tmp/jump-candidate"),
  );
  const jumped = await host.jump(driver.arcRunId, "arc:candidate:Main");
  if (jumped.status !== "compatible") throw new Error(jumped.reason);
  await host.getRunWorkspaceContext(driver.arcRunId);
  await host.getRunWorkspaceContext(jumped.arcRunId);
  await host.nodeInfoForRef(toNodeRef("source", ["Main"]), driver.arcRunId);
  await host.nodeInfoForRef(toNodeRef("candidate", ["Main"]), jumped.arcRunId);
  await host.registerArc(
    "candidate",
    document,
    policy("/tmp/later-candidate"),
    { replace: true },
  );
  const rewound = await host.rewind(driver.arcRunId, position(1));
  await host.registerArcs([
    { source: "source", delete: true },
    { source: "candidate", delete: true },
  ]);
  const reads = observeSnapshotReads(store);
  expect(
    (await host.getRunWorkspaceContext(jumped.arcRunId)).workspaceBundle,
  ).toEqual(policy("/tmp/jump-candidate").bundle);
  expect(
    (await host.getRunWorkspaceContext(rewound.arcRunId)).workspaceBundle,
  ).toEqual(policy("/tmp/rewind-original").bundle);
  expect(
    (await host.nodeInfoForRef(toNodeRef("source", ["Main"]), rewound.arcRunId))
      .description,
  ).toBe("Original label");
  expect(
    (
      await host.nodeInfoForRef(
        toNodeRef("candidate", ["Main"]),
        jumped.arcRunId,
      )
    ).description,
  ).toBe("Candidate label");
  expect(reads.snapshot).not.toHaveBeenCalled();
  expect(reads.record).not.toHaveBeenCalled();
  await host.stop();
  const restarted = await createTestArcHost({ store, replayStore: replay });
  for (const [id, path, sourceName, label] of [
    [jumped.arcRunId, "/tmp/jump-candidate", "candidate", "Candidate label"],
    [rewound.arcRunId, "/tmp/rewind-original", "source", "Original label"],
  ] as const) {
    await beginDriver(restarted, id, dialog);
    expect(
      (await restarted.getRunWorkspaceContext(id)).workspaceBundle,
    ).toEqual(policy(path).bundle);
    reads.reset();
    expect(
      (await restarted.nodeInfoForRef(toNodeRef(sourceName, ["Main"]), id))
        .description,
    ).toBe(label);
    await restarted.getRunWorkspaceContext(id);
    expect(reads.counts()).toEqual({ state: 0, snapshot: 0, record: 0 });
  }
  await restarted.stop();
});
