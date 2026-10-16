import { parse } from "@elem-app/arc/parser";
import { Runtime, toArcRef } from "@elem-app/arc/runtime";
import type { Dialog } from "@elem-app/arc/types";
import { expect, it } from "vitest";
import { RecordingRuntime } from "../src/service/replay-recorder.js";
import {
  alignActionReplay,
  createReplayIso,
} from "../src/service/replay-verify.js";
import { InMemoryReplayStore } from "../src/storage/in-memory.js";
import type { ArcRunId } from "../src/types/core.js";
import type { HostModuleState } from "../src/types/host-module.js";

it.each(["interrupted", "poisoned", "covered"] as const)(
  "replay.recording captures %s host module snapshots without consuming or retiring effects",
  async (outcome) => {
    const hook =
      outcome === "poisoned"
        ? "let n = Num(); n.$set(1); this.catchInterruption = () => { n.$set(0 / 0); return true; };"
        : "";
    const runtime = new Runtime()
      .add(
        "passive",
        parse('"arc"; function Main() { ' + hook + " $instruct(`work`); }"),
      )
      .init();
    const root = runtime.newTraversal(toArcRef("passive", "Main"));
    root.phase = "entered";
    root.enterCount = 1;
    const store = new InMemoryReplayStore();
    const recorder = new RecordingRuntime(runtime, store, "passive-time", {
      reactivationCount: 0,
    });
    const hostModules: HostModuleState = {
      calls: [
        {
          call: {
            hostCallId: "registration",
            sourceRef: "node:passive:Main",
            module: "time",
            target: [],
            operation: "addTimeout",
            arguments: [100, "deadline"],
            hostParams: undefined,
            moduleData: { deadlineMillis: 100 },
          },
          context: { arcRunId: "passive-time" },
          acknowledged: true,
          effects: [],
        },
      ],
    };
    const initial = structuredClone(hostModules);
    recorder.setHostModuleState(hostModules);
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const brief = await recorder.start([root], dialog);
    if (!brief.canProgress) throw new Error("Expected pending work");
    const terminal = await recorder.progress(
      brief,
      outcome === "covered"
        ? {
            move: "proceed",
            instructions: {
              [brief.instructions[0]!.id]: { status: "applied" },
            },
          }
        : { move: "interrupt", interruption: { id: "deadline", reason: "" } },
      dialog,
      "host-interruption",
    );
    expect(terminal).toMatchObject({ canProgress: false, outcome });
    await recorder.captureHostModuleState(terminal);
    expect(hostModules).toEqual(initial);
    expect(
      (await store.listCheckpoints("passive-time")).at(-1)?.hostModules,
    ).toEqual(initial);
    hostModules.calls.length = 0;
    expect(
      (await store.listCheckpoints("passive-time")).at(-1)?.hostModules,
    ).toEqual(initial);
  },
);

it.each(["live", "reconstructed"] as const)(
  "replay.interruption preserves identity in reason-dependent catches with a %s recorder",
  async (mode) => {
    const document = parse(
      '"arc"; function Main() { this.catchInterruption = () => this.interruption.id != "network" || this.interruption.reason != "lost"; $instruct(`pending work`); }',
    );
    const runtime = new Runtime().add("interrupt", document).init();
    const root = runtime.newTraversal(toArcRef("interrupt", "Main"));
    root.phase = "entered";
    root.enterCount = 1;
    const dialog: Dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const store = new InMemoryReplayStore();
    const run = "interruption-replay" as ArcRunId;
    let recording = new RecordingRuntime(runtime, store, run, {
      reactivationCount: 0,
    });
    const brief = await recording.start([root], dialog);
    if (!brief.canProgress) throw new Error("Expected pending instruction");
    const stopped = await recording.progress(
      brief,
      { move: "interrupt", interruption: { id: "network", reason: "lost" } },
      dialog,
      "worker",
    );
    await recording.captureHostModuleState(stopped);
    expect(stopped).toMatchObject({
      canProgress: false,
      outcome: "interrupted",
    });
    const steps = await store.listSteps(run);
    expect(steps.map((step) => step.kind)).toEqual([
      "action-brief",
      "action-report",
      "terminal-brief",
    ]);
    expect(steps.find((step) => step.kind === "action-report")).toMatchObject({
      report: {
        move: "interrupt",
        interruption: { id: "network", reason: "lost" },
      },
    });
    const last = steps.at(-1);
    expect(last).toMatchObject({
      kind: "terminal-brief",
      brief: { root: root.ref, outcome: "interrupted" },
    });
    const candidate = () => new Runtime().add("interrupt", document).init();
    const verify = async () =>
      alignActionReplay({
        snapshotRuntime: candidate(),
        steps: await store.listSteps(run),
        checkpoints: await store.listCheckpoints(run),
        seedTraversals: [root],
        iso: createReplayIso(),
        reactivationCount: 0,
      });
    expect(await verify()).toMatchObject({
      status: "compatible",
      handoff: "reproduced",
    });
    if (mode === "reconstructed")
      recording = new RecordingRuntime(candidate(), store, run, {
        reactivationCount: 0,
      });
    let resumed = await recording.start(stopped.traversals, dialog);
    if (!resumed.canProgress) throw new Error("Expected continued instruction");
    expect(resumed.traversals[0]?.enterCount).toBe(1);
    expect(resumed.traversals[0]?.state).toBeUndefined();
    if (mode === "reconstructed") {
      recording = new RecordingRuntime(candidate(), store, run, {
        reactivationCount: 0,
      });
      resumed = await recording.start(
        structuredClone(resumed.traversals),
        dialog,
      );
      if (!resumed.canProgress)
        throw new Error("Expected reconstructed instruction");
    }
    const stoppedAgain = await recording.progress(
      resumed,
      { move: "interrupt", interruption: { id: "network", reason: "lost" } },
      dialog,
      "worker",
    );
    await recording.captureHostModuleState(stoppedAgain);
    expect(stoppedAgain).toMatchObject({ outcome: "interrupted" });
    expect(stoppedAgain.traversals).toEqual(stopped.traversals);
    if (mode === "reconstructed")
      recording = new RecordingRuntime(candidate(), store, run, {
        reactivationCount: 0,
      });
    resumed = await recording.start(
      structuredClone(stoppedAgain.traversals),
      dialog,
    );
    if (!resumed.canProgress)
      throw new Error("Expected second continued instruction");
    if (mode === "reconstructed") {
      recording = new RecordingRuntime(candidate(), store, run, {
        reactivationCount: 0,
      });
      resumed = await recording.start(
        structuredClone(resumed.traversals),
        dialog,
      );
      if (!resumed.canProgress)
        throw new Error("Expected second reconstructed instruction");
    }
    const done = await recording.progress(
      resumed,
      {
        move: "proceed",
        instructions: { [resumed.instructions[0]!.id]: { status: "applied" } },
      },
      dialog,
      "worker",
    );
    await recording.captureHostModuleState(done);
    expect(done).toMatchObject({ outcome: "covered" });
    const completeSteps = await store.listSteps(run);
    expect(completeSteps.map((step) => step.position.index)).toEqual([
      1, 1, 2, 3, 3, 4, 5, 5, 6,
    ]);
    expect(
      (await store.listCheckpoints(run)).map(
        (checkpoint) => checkpoint.position.index,
      ),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      completeSteps.every((step) => step.position.reactivationCount === 0),
    ).toBe(true);
    expect((await store.listSteps(run)).map((step) => step.kind)).toEqual([
      "action-brief",
      "action-report",
      "terminal-brief",
      "action-brief",
      "action-report",
      "terminal-brief",
      "action-brief",
      "action-report",
      "terminal-brief",
    ]);
    expect(await verify()).toMatchObject({
      status: "compatible",
      handoff: "reproduced",
    });
  },
);
