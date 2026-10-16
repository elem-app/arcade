import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moduleHubFor } from "./work-event-fixtures.js";

import { parse } from "@elem-app/arc/parser";
import type {
  ArcTraversal,
  ArcTraversalSet,
  BriefId,
  ElementId,
  NodeRef,
  PinTape,
  SegKey,
} from "@elem-app/arc/types";
import { catchSegKey } from "@elem-app/arc/types";
import { describe, expect, it } from "vitest";

import {
  assertShapePreserved,
  createReplayIso,
  traversalsEqualModuloIso,
} from "../src/service/replay-verify.js";

import {
  arcRunKey,
  handoffCheckpoint,
  positionKey,
  type ArcHostStep,
  type ArcRef,
  type ArcRunId,
  type ReplayStep,
} from "../src/testing.js";
import {
  DEFLECTABLE_SOURCE,
  GREET_SOURCE,
  HOST_MODULE_DECLARATIONS,
  hostModule,
} from "./helpers.js";
import {
  makeReplayHost,
  REPLAY_OWNER,
  runAnsweringJudgments,
  runToCompletion,
  userDialog,
  type ReplayHost,
} from "./replay-helpers.js";

const GREET_ARC = "arc:greet:Greet" as ArcRef;

// A structurally identical arc under a distinct source name (distinct ArcRef).
const SAME_DISTINCT = `"arc";
function Greet() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  $instruct(\`Welcome the user warmly.\`);
}`;

// The same arc with the root renamed (distinct source).
const RENAMED = `"arc";
function GreetRenamed() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  $instruct(\`Welcome the user warmly.\`);
}`;

// A tail append: the original first instruction plus a new appended one.
const TAIL_APPEND = `"arc";
function Greet() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  $instruct(\`Welcome the user warmly.\`);
  $instruct(\`Now ask a follow-up question.\`);
}`;

// A mid-prefix insertion: a new instruction before the recorded first one.
const MID_INSERT = `"arc";
function Greet() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  $instruct(\`A brand new first step.\`);
  $instruct(\`Welcome the user warmly.\`);
}`;

// A candidate whose trigger never matches.
const NEVER_TRIGGERS = `"arc";
function Greet() {
  this.trigger = () => { return false; };
  this.hostParams = { workerRole: "greeter" };
  $instruct(\`Welcome the user warmly.\`);
}`;

// The recorded base for the cross-SEG-edit case: effect-capable, no effects.
const NO_EFFECTS_SOURCE = `"arc";
import Audit from "host:audit";
function Greet() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  $instruct(\`Welcome the user warmly.\`);
}`;

// The same arc with an added executable effects hook — a cross-SEG edit that
// leaves every body element id unchanged.
const EFFECTS_ADDED = `"arc";
import Audit from "host:audit";
function Greet() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  this.effects = () => {
    Audit.records.$append(\`covered\`);
  };
  $instruct(\`Welcome the user warmly.\`);
}`;

async function recordedGreetRun(): Promise<{
  env: ReplayHost;
  runId: ArcRunId;
}> {
  const env = makeReplayHost();
  await env.host.registerArc("greet", parse(GREET_SOURCE));
  const runId = await runToCompletion(env.host, "hi");
  return { env, runId };
}

describe("exact self-replay (determinism anchor)", () => {
  it("reproduces the recorded run byte-for-byte under identity iso", async () => {
    const { env, runId } = await recordedGreetRun();
    const alignment = await env.host.verifyReplay(runId, GREET_ARC);

    expect(alignment.status).toBe("compatible");
    if (alignment.status !== "compatible") return;
    expect(alignment.handoff).toBe("reproduced");
    expect(alignment.arcRef).toBe(GREET_ARC);
    // Identity iso: the root maps to itself.
    expect(alignment.iso.arcs.get(GREET_ARC)).toBe(GREET_ARC);

    const finalCheckpoint = (await env.replay.listCheckpoints(runId)).at(-1)!;
    expect(handoffCheckpoint(alignment.regenerated).traversals).toEqual(
      finalCheckpoint.traversals,
    );
  });
});

describe("rename replay (ref-blind matching)", () => {
  it("maps a renamed root through the iso and replays successfully", async () => {
    const { env, runId } = await recordedGreetRun();
    await env.host.registerArc("greet2", parse(RENAMED));
    const candidate = "arc:greet2:GreetRenamed" as ArcRef;

    const alignment = await env.host.verifyReplay(runId, candidate);
    expect(alignment.status).toBe("compatible");
    if (alignment.status !== "compatible") return;
    expect(alignment.iso.arcs.get(GREET_ARC)).toBe(candidate);
    expect(alignment.iso.nodes.get("node:greet:Greet")).toBe(
      "node:greet2:GreetRenamed",
    );
  });
});

describe("tail append → jump", () => {
  it("hands off at the appended frontier and forks a new run", async () => {
    const { env, runId } = await recordedGreetRun();
    const before = await env.host.getRunView(runId);
    await env.host.registerArc("greet2", parse(TAIL_APPEND));

    const result = await env.host.jump(runId, "arc:greet2:Greet" as ArcRef);
    expect(result.status).toBe("compatible");
    if (result.status === "incompatible") return;
    expect(result.handoff).toBe("diverged");

    // A new run was created with the candidate arcRef; the source is untouched.
    expect(result.arcRunId).not.toBe(runId);
    const fork = await env.host.getRunView(result.arcRunId);
    expect(fork?.arcRef).toBe("arc:greet2:Greet");
    expect(await env.host.getRunView(runId)).toEqual(before);
  });
});

// An arc whose root emits a host call before its instruction.
const EFFECT_SOURCE = `"arc";
import Audit from "host:audit";
function Greet() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  this.effects = () => {
    Audit.records.$append(\`covered\`);
  };
  $instruct(\`Welcome the user warmly.\`);
}`;

// The same effect-bearing arc with the root renamed (distinct source).
const EFFECT_RENAMED = `"arc";
import Audit from "host:audit";
function GreetRenamed() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  this.effects = () => {
    Audit.records.$append(\`covered\`);
  };
  $instruct(\`Welcome the user warmly.\`);
}`;

describe("host-call replay (id remapping)", () => {
  it("pairs recorded host calls and remaps their report ids under a renamed candidate", async () => {
    const env = makeReplayHost();
    const appliedIds: string[] = [];
    env.host.registerHostModule(
      "audit",
      hostModule(
        moduleHubFor(env.host),
        HOST_MODULE_DECLARATIONS.stringAppendEffect,
        async (effect) => {
          appliedIds.push(effect.hostCallId);
        },
      ),
    );
    await env.host.registerArc("effect", parse(EFFECT_SOURCE));
    const runId = await runToCompletion(env.host, "hi");
    expect(appliedIds).toHaveLength(1);

    await env.host.registerArc("effect2", parse(EFFECT_RENAMED));
    const candidate = "arc:effect2:GreetRenamed" as ArcRef;
    const alignment = await env.host.verifyReplay(runId, candidate);

    expect(alignment.status).toBe("compatible");
    if (alignment.status !== "compatible") return;
    // Reproduced end-to-end: the recorded host-call acknowledgement replayed
    // onto the candidate's regenerated effect id instead of failing as an
    // unknown id after iso remapping.
    expect(alignment.handoff).toBe("reproduced");
    const recorded = (await env.replay.listSteps(runId)).find(
      (step) =>
        step.kind === "action-report" &&
        step.moduleEffect?.hostCallId === appliedIds[0],
    );
    if (recorded?.kind !== "action-report")
      throw new Error("Missing recorded host resolution.");
    const runtimeCallId = Object.keys(recorded.report.hostCalls ?? {})[0]!;
    expect(alignment.iso.briefIds.get(runtimeCallId)).toBe(
      "host-call:[arc:effect2:GreetRenamed]:[node:effect2:GreetRenamed]:effects/0",
    );
    expect(alignment.iso.nodes.get("node:effect:Greet")).toBe(
      "node:effect2:GreetRenamed",
    );
  });
});

describe("cross-SEG edit (element-id stability boundary)", () => {
  it("replays the recorded body prefix past an added effects hook, diverging only when the new effect runs", async () => {
    const env = makeReplayHost();
    env.host.registerHostModule(
      "audit",
      hostModule(
        moduleHubFor(env.host),
        HOST_MODULE_DECLARATIONS.stringAppendEffect,
        async () => {},
      ),
    );
    await env.host.registerArc("noeffect", parse(NO_EFFECTS_SOURCE));
    const runId = await runToCompletion(env.host, "hi");

    await env.host.registerArc("effectful", parse(EFFECTS_ADDED));
    const candidate = "arc:effectful:Greet" as ArcRef;
    const alignment = await env.host.verifyReplay(runId, candidate);

    // The effects hook is a different SEG scope, so every body element id is
    // unchanged: the recorded instruction resolution replays onto the
    // candidate 1:1, and divergence appears exactly where the new effect
    // first emits — never as a spurious id-shift mismatch at activation.
    expect(alignment.status).toBe("compatible");
    if (alignment.status !== "compatible") return;
    expect(alignment.handoff).toBe("diverged");
    expect(
      alignment.iso.briefIds.get(
        "instruction:[arc:noeffect:Greet]:[node:noeffect:Greet]:body/0",
      ),
    ).toBe("instruction:[arc:effectful:Greet]:[node:effectful:Greet]:body/0");

    // The handoff checkpoint carries the replayed prefix: the recorded
    // instruction already settled before the walk parted at the effect.
    const handoff = handoffCheckpoint(alignment.regenerated);
    const root = handoff.traversals.find(
      (traversal) => traversal.ref === candidate,
    );
    const instructionState = root?.frame.actionStates["body/0" as ElementId];
    expect(instructionState?.status).toBe("resolved");
  });
});

describe("action divergence", () => {
  it("hands off at a mid-prefix insertion, forking with the diverged reason", async () => {
    const { env, runId } = await recordedGreetRun();
    await env.host.registerArc("greet2", parse(MID_INSERT));
    const before = await env.host.getRunView(runId);

    // The insertion makes the candidate's action brief 1 differ from the
    // recording. Activation still reproduces, so this is a handoff, not a
    // failure: a new run forks and live execution takes over from there.
    const result = await env.host.jump(runId, "arc:greet2:Greet" as ArcRef);
    expect(result.status).toBe("compatible");
    if (result.status === "incompatible") return;
    expect(result.handoff).toBe("diverged");
    expect(result.arcRunId).not.toBe(runId);

    // Source state is unchanged.
    expect(await env.host.getRunView(runId)).toEqual(before);
  });
});

describe("trigger replay selects the candidate", () => {
  it("rejects a candidate whose trigger never matches, at a trigger position", async () => {
    const { env, runId } = await recordedGreetRun();
    await env.host.registerArc("greet2", parse(NEVER_TRIGGERS));

    const alignment = await env.host.verifyReplay(
      runId,
      "arc:greet2:Greet" as ArcRef,
    );
    expect(alignment.status).toBe("incompatible");
    if (alignment.status === "incompatible") {
      expect(alignment.position.stage).toBe("trigger");
    }
  });
});

describe("distinct-source candidate flow", () => {
  it("forks onto the candidate while the source run stays runnable", async () => {
    const { env, runId } = await recordedGreetRun();
    await env.host.registerArc("greet2", parse(SAME_DISTINCT));

    const result = await env.host.jump(runId, "arc:greet2:Greet" as ArcRef);
    if (result.status === "incompatible") throw new Error("expected a fork");
    const fork = await env.host.getRunView(result.arcRunId);
    expect(fork?.arcRef).toBe("arc:greet2:Greet");

    // The source run's metadata still resolves and a fresh activation of the
    // original arc still works (no registration was mutated).
    expect((await env.host.getRunView(runId))?.arcRef).toBe(GREET_ARC);
    const freshSource = await runToCompletion(env.host, "again");
    expect((await env.host.getRunView(freshSource))?.arcRef).toBe(GREET_ARC);
  });
});

describe("rewind", () => {
  it("installs an earlier checkpoint as a new run with its own replay prefix", async () => {
    const { env, runId } = await recordedGreetRun();
    const checkpoint1 = await env.replay.getCheckpoint(runId, {
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });

    const { arcRunId } = await env.host.rewind(runId, {
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });
    expect(arcRunId).not.toBe(runId);

    const rewound = await env.replay.getCheckpoint(arcRunId, {
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });
    expect(rewound).toEqual(checkpoint1);

    // The rewound run carries the copied source prefix with the pre-report
    // boundary: a brief at the rewind position, but no report at it.
    const steps = await env.replay.listSteps(arcRunId);
    expect(hasStep(steps, "action-brief", 1)).toBe(true);
    expect(hasStep(steps, "action-report", 1)).toBe(false);
  });

  it("inherits context isolation into fork and rewind runs", async () => {
    const env = makeReplayHost();
    await env.host.registerArc("greet", parse(GREET_SOURCE), {
      workspaceScope: "run",
      bundle: {},
      contextIsolation: "node",
    });
    const runId = await runToCompletion(env.host, "hi");
    await env.host.registerArc("greet2", parse(SAME_DISTINCT));

    const forked = await env.host.jump(runId, "arc:greet2:Greet" as ArcRef);
    if (forked.status === "incompatible") {
      throw new Error("expected a fork");
    }
    const rewound = await env.host.rewind(runId, {
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });

    expect(
      (
        await Promise.all(
          [runId, forked.arcRunId, rewound.arcRunId].map((arcRunId) =>
            env.store.getState(arcRunKey(arcRunId)),
          ),
        )
      ).map((state) => state?.contextIsolation),
    ).toEqual(["node", "node", "node"]);
    expect(new Set([runId, forked.arcRunId, rewound.arcRunId]).size).toBe(3);
  });
});

describe("fork is itself replayable + prefix boundary", () => {
  it("writes the fork's own replay data with the pre-report boundary and stays jumpable", async () => {
    const { env, runId } = await recordedGreetRun();
    await env.host.registerArc("greet2", parse(SAME_DISTINCT));

    const result = await env.host.jump(runId, "arc:greet2:Greet" as ArcRef);
    if (result.status === "incompatible") throw new Error("expected a fork");
    const forkPoint = handoffCheckpoint(result.regenerated).position;

    const steps = await env.replay.listSteps(result.arcRunId);
    // A full trigger stream is present.
    expect(steps.some((step) => step.kind.startsWith("trigger"))).toBe(true);
    // The action output is present at the fork point, with no report after a
    // terminal output or at a pre-report progress boundary.
    expect(hasActionOutput(steps, forkPoint.index)).toBe(true);
    expect(hasStep(steps, "action-report", forkPoint.index)).toBe(false);

    // The fork has a trigger stream, so it can itself be rewound.
    const rewound = await env.host.rewind(result.arcRunId, {
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });
    expect(rewound.arcRunId).not.toBe(result.arcRunId);
  });
});

// A judging arc renamed onto a distinct source: the judgment's BriefId
// (`kind:[arc]:[nodeRef]:actionId`) shifts because the nodeRef changes.
const READY_RENAMED = `"arc";
function CheckReadyRenamed() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "judge-runner" };
  if (judge(\`is the user ready\`)) {
    $instruct(\`Welcome.\`);
  }
}`;

describe("rename reconciles a shifted BriefId through iso.briefIds", () => {
  it("rewrites a recorded report's judgment key onto the renamed candidate", async () => {
    const env = makeReplayHost();
    await env.host.registerArc("ready", parse(DEFLECTABLE_SOURCE));
    const { arcRunId, firstJudgmentIds } = await runAnsweringJudgments(
      env.host,
      "ready",
    );
    const oldJudgmentId = firstJudgmentIds[0]!;
    expect(oldJudgmentId).toBeDefined();

    // The recorded action report at position 1 is keyed by the source BriefId.
    const recordedReport = (await env.replay.listSteps(arcRunId)).find(
      (step) => step.kind === "action-report" && step.position.index === 1,
    );
    expect(recordedReport?.kind).toBe("action-report");
    if (recordedReport?.kind !== "action-report") return;
    expect(Object.keys(recordedReport.report.judgments ?? {})).toContain(
      oldJudgmentId,
    );

    // Rename onto a distinct source; the judgment's BriefId must shift.
    await env.host.registerArc("ready2", parse(READY_RENAMED));
    const candidate = "arc:ready2:CheckReadyRenamed" as ArcRef;
    const alignment = await env.host.verifyReplay(arcRunId, candidate);

    expect(alignment.status).toBe("compatible");
    if (alignment.status !== "compatible") return;

    const newJudgmentId = alignment.iso.briefIds.get(oldJudgmentId);
    expect(newJudgmentId).toBeDefined();
    expect(newJudgmentId).not.toBe(oldJudgmentId);

    // The regenerated report (candidate refs) is keyed by the shifted BriefId,
    // proving the recorded key was rewritten through iso.briefIds rather than
    // depending on id stability.
    const regenReport = alignment.regenerated.actionSteps.find(
      (step) => step.kind === "action-report" && step.position.index === 1,
    );
    if (regenReport?.kind !== "action-report") throw new Error("no report");
    expect(Object.keys(regenReport.report.judgments ?? {})).toEqual([
      newJudgmentId,
    ]);
  });
});

describe("handshake-activated runs are trigger-replayable", () => {
  it("flushes the buffered trigger stream when activation completes via a handshake", async () => {
    const env = makeReplayHost();
    // An `arc`-scoped arc with no registered workspace path stages a workspace
    // handshake on activation — deferring activation onto resolveHandshake.
    await env.host.registerArc("greet", parse(GREET_SOURCE), {
      workspaceScope: "arc",
      bundle: {},
      contextIsolation: "role",
    });

    const dialog = userDialog("hi");
    const begun = await env.host.begin({
      dialog,
      inbound: { content: "hi" },
      principal: REPLAY_OWNER,
      projectDialog: async () => dialog,
    });
    const handshakes = begun.filter((step) => step.kind === "handshake");
    expect(handshakes).toHaveLength(1);
    const [handshake] = handshakes;
    if (handshake?.kind !== "handshake") return;

    const workspace = await mkdtemp(join(tmpdir(), "arcade-replay-ws-"));
    const resolved = await env.host.resolveHandshake(
      handshake.handshakeId,
      { workspace },
      { projectDialog: async () => dialog },
    );
    expect(resolved.status).toBe("ok");
    if (resolved.status !== "ok") return;
    if (resolved.step.kind !== "action") return;

    // The trigger stream was buffered before the handshake and flushed under the
    // activated run id — so the run is trigger-replayable end-to-end.
    const steps = await env.replay.listSteps(resolved.step.arcRunId);
    expect(steps.some((step) => step.kind === "trigger-brief")).toBe(true);
    expect(hasStep(steps, "action-brief", 1)).toBe(true);

    // Self-replay reaches the action stage rather than failing at trigger:1.
    const alignment = await env.host.verifyReplay(
      resolved.step.arcRunId,
      GREET_ARC,
    );
    expect(alignment.status).toBe("compatible");
  });
});

// Two always-matching arcs with SEMANTIC triggers: the `judge(...)` trigger
// records a real trigger stream to replicate into each forked run, and leaves a
// rename replay recorded judgments to rewrite (a `() => true` trigger records none).
const ALPHA_SEM = `"arc";
function AlphaSem() {
  this.trigger = () => { return judge(\`match\`); };
  $instruct(\`Alpha step.\`);
}`;
const BETA_SEM = `"arc";
function BetaSem() {
  this.trigger = () => { return judge(\`match\`); };
  $instruct(\`Beta step.\`);
}`;
// Alpha renamed under a distinct source; structurally identical.
const ALPHA_SEM_RENAMED = `"arc";
function AlphaSemRenamed() {
  this.trigger = () => { return judge(\`match\`); };
  $instruct(\`Alpha step.\`);
}`;

describe("a semantic fan-out replicates its trigger stream and survives a rename", () => {
  it("gives each run the identical trigger prefix, then replays one across a rename", async () => {
    // One inbound forks both arcs into two runs, guarding two contracts:
    //  1. Each run carries a verbatim copy of the one shared trigger stream.
    //  2. A recorded semantic run replays compatibly after its arc is renamed —
    //     exercising trigger-stage iso rewrite, which a `() => true` fork skips.
    const env = makeReplayHost();
    await env.host.registerArc("alphasem", parse(ALPHA_SEM));
    await env.host.registerArc("betasem", parse(BETA_SEM));

    const dialog = userDialog("go");
    const begun = await env.host.begin({
      dialog,
      inbound: { content: "go" },
      principal: REPLAY_OWNER,
      activationPolicy: "all",
      projectDialog: async () => dialog,
    });
    const triggers = begun.filter((step) => step.kind === "trigger");
    expect(triggers).toHaveLength(1);
    const trig = triggers[0];
    if (trig?.kind !== "trigger") return;

    const advanced = await env.host.advanceTrigger(trig.arcRunId, dialog, {
      instructionCoverage: {},
      projectDialog: async () => dialog,
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              trig.frontier.briefs.judgments.map((judgment) => [
                judgment.id,
                true,
              ]),
            ),
          },
        },
      ],
    });

    const actions = advanced.flatMap((step) =>
      step.kind === "action" ? [step] : [],
    );
    expect(actions).toHaveLength(2);
    const runIds = actions.map((step) => step.arcRunId);
    expect(new Set(runIds).size).toBe(2);

    // Contract 1: steps carry no run id in their payload, so a verbatim copy is
    // structurally identical across runs.
    const triggerPrefix = async (runId: ArcRunId): Promise<ReplayStep[]> =>
      (await env.replay.listSteps(runId)).filter(
        (step) =>
          step.kind === "trigger-brief" || step.kind === "trigger-report",
      );
    const firstPrefix = await triggerPrefix(runIds[0]!);
    const secondPrefix = await triggerPrefix(runIds[1]!);
    expect(firstPrefix.length).toBeGreaterThan(0);
    expect(firstPrefix).toEqual(secondPrefix);

    // Contract 2: replay Alpha against a renamed, coexisting Alpha — a broken
    // trigger-stage rewrite would fail here before reaching the action stage.
    const alphaRun = actions.find(
      (step) => step.frontier.arcRef === "arc:alphasem:AlphaSem",
    );
    expect(alphaRun).toBeDefined();
    if (!alphaRun) return;
    await env.host.registerArc("alphasem2", parse(ALPHA_SEM_RENAMED));
    const renamed = await env.host.verifyReplay(
      alphaRun.arcRunId,
      "arc:alphasem2:AlphaSemRenamed" as ArcRef,
    );
    expect(renamed.status).toBe("compatible");

    // Each run still self-replays compatibly against its own arc.
    for (const step of actions) {
      if (!step.frontier.arcRef) continue;
      const alignment = await env.host.verifyReplay(
        step.arcRunId,
        step.frontier.arcRef,
      );
      expect(alignment.status).toBe("compatible");
    }
  });
});

// A fan-out arc with a two-brief body: a judge gate (brief 1) then an
// instruction (brief 2). The edit changes only the brief-2 instruction.
const ALPHA_SEM_GATED = `"arc";
function AlphaSem() {
  this.trigger = () => { return judge(\`match\`); };
  if (judge(\`ready\`)) {
    $instruct(\`Alpha step.\`);
  }
}`;
const ALPHA_SEM_GATED_EDITED = `"arc";
function AlphaSem() {
  this.trigger = () => { return judge(\`match\`); };
  if (judge(\`ready\`)) {
    $instruct(\`A different alpha step.\`);
  }
}`;

describe("a fanned-out run diverges mid-body against an edited arc", () => {
  it("reproduces the trigger prefix and action brief 1, then parts at brief 2", async () => {
    const env = makeReplayHost();
    await env.host.registerArc("alphagated", parse(ALPHA_SEM_GATED));
    await env.host.registerArc("betasem", parse(BETA_SEM));

    const dialog = userDialog("go");
    const begun = await env.host.begin({
      dialog,
      inbound: { content: "go" },
      principal: REPLAY_OWNER,
      activationPolicy: "all",
      projectDialog: async () => dialog,
    });
    const trig = begun.find((step) => step.kind === "trigger");
    if (trig?.kind !== "trigger") throw new Error("expected a trigger step");
    const advanced = await env.host.advanceTrigger(trig.arcRunId, dialog, {
      instructionCoverage: {},
      projectDialog: async () => dialog,
      reports: [
        {
          outcome: "completed",
          semantic: {
            judgments: Object.fromEntries(
              trig.frontier.briefs.judgments.map((j) => [j.id, true]),
            ),
          },
        },
      ],
    });
    const alphaRun = advanced.find(
      (step) =>
        step.kind === "action" &&
        step.frontier.arcRef === "arc:alphagated:AlphaSem",
    );
    if (alphaRun?.kind !== "action") throw new Error("expected the Alpha run");

    // Drive to completion so the recorded body spans both briefs.
    let step: ArcHostStep = alphaRun;
    for (let i = 0; i < 8; i += 1) {
      if (step.kind !== "action") break;
      const status = step.frontier.status;
      if (
        status === "completed" ||
        status === "poisoned" ||
        status === "idle"
      ) {
        break;
      }
      const judgments = step.frontier.briefs.judgments;
      step = await env.host.advanceAction(
        step.arcRunId,
        step.frontier.frontierId,
        {
          instructionCoverage: {},
          projectDialog: async () => dialog,
          reports: judgments.map((j) => ({
            outcome: "completed" as const,
            semantic: { judgments: { [j.id]: true } },
          })),
        },
      );
    }

    await env.host.registerArc("alphagated2", parse(ALPHA_SEM_GATED_EDITED));
    const alignment = await env.host.verifyReplay(
      alphaRun.arcRunId,
      "arc:alphagated2:AlphaSem" as ArcRef,
    );

    expect(alignment.status).toBe("compatible");
    if (alignment.status === "incompatible") return;
    // Handoff, not failure: brief 1 reproduces, brief 2 (the edit) is where it parts.
    expect(alignment.handoff).toBe("diverged");
    expect(handoffCheckpoint(alignment.regenerated).position).toEqual({
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });
    const steps = alignment.regenerated.actionSteps;
    expect(hasStep(steps, "action-brief", 1)).toBe(true);
    expect(hasStep(steps, "action-report", 1)).toBe(true);
    expect(hasStep(steps, "action-brief", 2)).toBe(false);
  });
});

describe("partial jump with untilPosition", () => {
  it("stops at the target action position with a pre-report prefix", async () => {
    const { env, runId } = await recordedGreetRun();
    await env.host.registerArc("greet2", parse(SAME_DISTINCT));

    const result = await env.host.jump(runId, "arc:greet2:Greet" as ArcRef, {
      untilPosition: { stage: "action", index: 1, reactivationCount: 0 },
    });
    if (result.status === "incompatible") throw new Error("expected a fork");
    expect(result.handoff).toBe("reproduced");
    expect(handoffCheckpoint(result.regenerated).position).toEqual({
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });

    // The fork's prefix is installed at action 1, pre-report: brief 1 and
    // checkpoints 0–1 present, but no report at 1 and no brief 2.
    const steps = await env.replay.listSteps(result.arcRunId);
    expect(hasStep(steps, "action-brief", 1)).toBe(true);
    expect(hasStep(steps, "action-report", 1)).toBe(false);
    expect(hasStep(steps, "action-brief", 2)).toBe(false);
    expect(
      (await env.replay.listCheckpoints(result.arcRunId)).map(
        (entry) => entry.position.index,
      ),
    ).toEqual([0, 1]);
  });
});

describe("candidate that omits a recorded item", () => {
  it("hands off with the diverged reason where the dropped item was answered", async () => {
    // The recorded run answered a judgment at action brief 1. A candidate that
    // drops that judgment leaves the recorded item with no counterpart, so the
    // action matcher diverges at that brief. Activation still reproduces, so
    // the result is a handoff (diverged), not a failure.
    const env = makeReplayHost();
    await env.host.registerArc("ready", parse(DEFLECTABLE_SOURCE));
    const { arcRunId } = await runAnsweringJudgments(env.host, "ready");

    const dropped = `"arc";
function CheckReady() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "judge-runner" };
  $instruct(\`Welcome.\`);
}`;
    await env.host.registerArc("ready2", parse(dropped));

    const alignment = await env.host.verifyReplay(
      arcRunId,
      "arc:ready2:CheckReady" as ArcRef,
    );
    expect(alignment.status).toBe("compatible");
    if (alignment.status === "incompatible") return;
    expect(alignment.handoff).toBe("diverged");
  });
});

// A two-brief arc (judge at index 1, instruct at index 2) whose instruction
// differs from the recording, so a candidate reproduces brief 1 and parts at
// brief 2.
const MID_DIVERGE = `"arc";
function CheckReady() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "judge-runner" };
  if (judge(\`is the user ready\`)) {
    $instruct(\`A different welcome.\`);
  }
}`;

describe("mid-stream action divergence", () => {
  it("reproduces the first action step, then diverges at the second", async () => {
    const env = makeReplayHost();
    await env.host.registerArc("ready", parse(DEFLECTABLE_SOURCE));
    const { arcRunId } = await runAnsweringJudgments(env.host, "ready");

    await env.host.registerArc("ready2", parse(MID_DIVERGE));
    const alignment = await env.host.verifyReplay(
      arcRunId,
      "arc:ready2:CheckReady" as ArcRef,
    );

    expect(alignment.status).toBe("compatible");
    if (alignment.status === "incompatible") return;
    expect(alignment.handoff).toBe("diverged");

    // The judge at brief 1 reproduces (brief + report regenerated); the changed
    // instruction at brief 2 is where the candidate parts, so the handoff
    // installs at checkpoint 1.
    expect(handoffCheckpoint(alignment.regenerated).position).toEqual({
      stage: "action",
      index: 1,
      reactivationCount: 0,
    });
    const steps = alignment.regenerated.actionSteps;
    expect(hasStep(steps, "action-brief", 1)).toBe(true);
    expect(hasStep(steps, "action-report", 1)).toBe(true);
    expect(hasStep(steps, "action-brief", 2)).toBe(false);
  });
});

describe("multi-brief self-replay", () => {
  it("reproduces a two-step run across the report boundary", async () => {
    const env = makeReplayHost();
    await env.host.registerArc("ready", parse(DEFLECTABLE_SOURCE));
    const { arcRunId } = await runAnsweringJudgments(env.host, "ready");

    const alignment = await env.host.verifyReplay(
      arcRunId,
      "arc:ready:CheckReady" as ArcRef,
    );

    expect(alignment.status).toBe("compatible");
    if (alignment.status === "incompatible") return;
    expect(alignment.handoff).toBe("reproduced");

    // Both action steps regenerate: the judge (brief 1) and the instruction
    // (brief 2), proving the walk advances across report 1 into brief 2.
    const steps = alignment.regenerated.actionSteps;
    expect(hasStep(steps, "action-brief", 1)).toBe(true);
    expect(hasStep(steps, "action-brief", 2)).toBe(true);
  });
});

// Same trigger surface as the recorded Greet, but a structurally different
// action body (a judge gate before the instruction).
const SAME_TRIGGER_DIFFERENT_BODY = `"arc";
function Greet() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "greeter" };
  if (judge(\`extra gate\`)) {
    $instruct(\`Welcome the user warmly.\`);
  }
}`;

// The activation seed is fixed by the trigger outcome — which arc, with which
// deps — so a different action body leaves checkpoint 0 intact. The body change
// surfaces at the first action brief, as a divergence rather than an
// activation failure. This documents that the checkpoint-0 incompatibility in
// `alignActionReplay` is a defensive guard: a trigger-matching candidate reaching
// a different checkpoint 0 could not be constructed through this vector.
describe("trigger matches but the body differs", () => {
  it("holds checkpoint 0 and treats the body change as a brief-1 divergence", async () => {
    const { env, runId } = await recordedGreetRun();
    await env.host.registerArc("greet2", parse(SAME_TRIGGER_DIFFERENT_BODY));

    const alignment = await env.host.verifyReplay(
      runId,
      "arc:greet2:Greet" as ArcRef,
    );

    expect(alignment.status).toBe("compatible");
    if (alignment.status === "incompatible") return;
    expect(alignment.handoff).toBe("diverged");
    expect(handoffCheckpoint(alignment.regenerated).position).toEqual({
      stage: "action",
      index: 0,
      reactivationCount: 0,
    });
  });
});

describe("idle trigger probe persists nothing", () => {
  it("drops the buffered trigger steps when a turn ends idle", async () => {
    const env = makeReplayHost();
    await env.host.registerArc(
      "never",
      parse(`"arc";
function Never() {
  this.trigger = () => { return false; };
  this.hostParams = { workerRole: "x" };
  $instruct(\`unreached\`);
}`),
    );

    const outcome = await env.host.begin({
      dialog: userDialog("nope"),
      inbound: { content: "nope" },
      principal: REPLAY_OWNER,
      projectDialog: async () => userDialog("nope"),
    });
    expect(outcome).toEqual([]);
    // No run was activated, so the in-memory trigger buffer was dropped: there
    // is no orphan replay data under any run id.
    expect(env.replay.runIds()).toEqual([]);
  });
});

function hasStep(
  steps: readonly ReplayStep[],
  kind: ReplayStep["kind"],
  index: number,
): boolean {
  return steps.some(
    (step) => step.kind === kind && step.position.index === index,
  );
}

function hasActionOutput(steps: readonly ReplayStep[], index: number): boolean {
  return (
    hasStep(steps, "action-brief", index) ||
    hasStep(steps, "terminal-brief", index)
  );
}

// `positionKey` is part of the public surface used by replay consumers.
describe("position key", () => {
  it("encodes reactivation count, stage, and index", () => {
    expect(
      positionKey({ stage: "action", index: 2, reactivationCount: 0 }),
    ).toBe("0:action:2");
    expect(
      positionKey({ stage: "trigger", index: 1, reactivationCount: 3 }),
    ).toBe("3:trigger:1");
  });
});

function arcTraversal(
  ref: ArcRef,
  over: Partial<ArcTraversal> = {},
): ArcTraversal {
  return {
    ref,
    enterCount: 1,
    guardCompleted: false,
    cells: {},
    frame: {
      actionStates: {},
      evaluatorActionStates: {},
      pinTapes: {},
    },
    ownedChildren: [],
    ephemeralChildren: [],
    refChildren: [],
    enterChannels: { args: {}, returns: {}, stagedReturns: {} },
    phase: "entered",
    ...over,
  };
}

describe("traversalsEqualModuloIso ref rewriting", () => {
  it("maps catch-SEG keys and embedded brief ids across a rename", () => {
    const iso = createReplayIso();
    iso.arcs.set("arc:v1:A" as ArcRef, "arc:v2:A" as ArcRef);
    iso.nodes.set("node:v1:A" as NodeRef, "node:v2:A" as NodeRef);
    iso.nodes.set("node:v1:B" as NodeRef, "node:v2:B" as NodeRef);

    const tape = (
      arcVer: string,
      nodeVer: string,
    ): Record<SegKey, PinTape> => ({
      [catchSegKey({
        origin: `node:${nodeVer}:A` as NodeRef,
        from: `node:${nodeVer}:B` as NodeRef,
      })]: {
        ["catch/0" as ElementId]: [
          {
            kind: "judgment",
            briefId:
              `judge:[arc:${arcVer}:A]:[node:${nodeVer}:A]:catch/0` as BriefId,
            resolved: true,
            value: true,
          },
        ],
      },
    });

    const recorded: ArcTraversalSet = [
      arcTraversal("arc:v1:A" as ArcRef, {
        frame: {
          actionStates: {},
          evaluatorActionStates: {},
          pinTapes: tape("v1", "v1"),
        },
      }),
    ];
    const generated: ArcTraversalSet = [
      arcTraversal("arc:v2:A" as ArcRef, {
        frame: {
          actionStates: {},
          evaluatorActionStates: {},
          pinTapes: tape("v2", "v2"),
        },
      }),
    ];

    // The catch key embeds origin/from node refs; without rewriting map keys
    // this false-diverges even though the state is isomorphic.
    expect(traversalsEqualModuloIso(recorded, generated, iso)).toBe(true);
  });

  it("leaves opaque cell payloads that look like refs untouched", () => {
    const iso = createReplayIso();
    iso.arcs.set("arc:v1:A" as ArcRef, "arc:v2:A" as ArcRef);
    iso.nodes.set("node:v1:A" as NodeRef, "node:v2:A" as NodeRef);

    // The same authored literal on both sides. A rename must not rewrite it on
    // the recorded side (it is payload, not a runtime ref) and then diverge.
    const recorded: ArcTraversalSet = [
      arcTraversal("arc:v1:A" as ArcRef, { cells: { saved: "node:v1:A" } }),
    ];
    const generated: ArcTraversalSet = [
      arcTraversal("arc:v2:A" as ArcRef, { cells: { saved: "node:v1:A" } }),
    ];
    expect(traversalsEqualModuloIso(recorded, generated, iso)).toBe(true);

    // A genuinely different cell payload still diverges.
    const changed: ArcTraversalSet = [
      arcTraversal("arc:v2:A" as ArcRef, { cells: { saved: "node:v9:Z" } }),
    ];
    expect(traversalsEqualModuloIso(recorded, changed, iso)).toBe(false);
  });

  it("remaps a catch key without partial-matching a prefix-sharing sibling", () => {
    // `node:v1:A` is renamed; its sibling `node:v1:AB` (a superstring) is not.
    // The catch key holds both; the brackets must delimit each ref so the
    // rename of `A` cannot bleed into `AB`.
    const iso = createReplayIso();
    iso.arcs.set("arc:v1:A" as ArcRef, "arc:v2:A" as ArcRef);
    iso.nodes.set("node:v1:A" as NodeRef, "node:v2:A" as NodeRef);

    const withOrigin = (origin: NodeRef): ArcTraversal["frame"] => ({
      actionStates: {},
      evaluatorActionStates: {
        [catchSegKey({ origin, from: "node:v1:AB" as NodeRef })]: {},
      },
      pinTapes: {},
    });

    const recorded: ArcTraversalSet = [
      arcTraversal("arc:v1:A" as ArcRef, {
        frame: withOrigin("node:v1:A" as NodeRef),
      }),
    ];
    const generated: ArcTraversalSet = [
      arcTraversal("arc:v2:A" as ArcRef, {
        frame: withOrigin("node:v2:A" as NodeRef),
      }),
    ];

    expect(traversalsEqualModuloIso(recorded, generated, iso)).toBe(true);
  });
});

describe("assertShapePreserved (rewrite guardrail)", () => {
  // A proper bijective iso cannot change the tree's shape, so the guard is a
  // tripwire for a future rewrite bug. These drive it directly to prove it
  // fires on the structural corruptions it exists to catch, and passes a
  // leaf-string-only difference (the legitimate ref substitution).
  it("passes when only leaf strings differ", () => {
    expect(() =>
      assertShapePreserved(
        { ref: "node:v1:A", tags: ["x", "y"], n: 1 },
        { ref: "node:v2:A", tags: ["x", "y"], n: 1 },
        "root",
      ),
    ).not.toThrow();
  });

  it("throws on a merged / dropped object key", () => {
    expect(() =>
      assertShapePreserved({ a: 1, b: 2 }, { a: 1 }, "root"),
    ).toThrow(/changed key count at root/);
  });

  it("throws on a changed array length", () => {
    expect(() =>
      assertShapePreserved({ xs: [1, 2, 3] }, { xs: [1, 2] }, "root"),
    ).toThrow(/changed array shape at root\.0/);
  });

  it("throws on a retyped value", () => {
    expect(() =>
      assertShapePreserved({ v: "node:v1:A" }, { v: 42 }, "root"),
    ).toThrow(/changed value type at root\.0/);
  });
});
