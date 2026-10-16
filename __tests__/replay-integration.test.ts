import { parse } from "@elem-app/arc/parser";
import { describe, expect, it } from "vitest";
import { workEventsFor } from "./work-event-fixtures.js";

import {
  ArcHostService,
  DEFAULT_WORKER_ROLE,
  handoffCheckpoint,
  InMemoryReplayStore,
  type ArcRef,
  type ArcRunId,
  type ReplayStep,
} from "../src/testing.js";
import { firstActivation, makeWorkerHub, waitFor } from "./helpers.js";
import {
  answeringWorker,
  makeReplayHost,
  REPLAY_OWNER,
  TestingOperatorConnector,
} from "./replay-helpers.js";

// v1: a judging arc that instructs once the user opts into onboarding.
const ONBOARD_V1 = `"arc";
function Onboard() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "concierge" };
  if (judge(\`does the user want onboarding\`)) {
    $instruct(\`Walk the user through setup.\`);
  }
}`;

// v2 (distinct source): the same prefix, with a step appended to the tail.
const ONBOARD_V2 = `"arc";
function Onboard() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "concierge" };
  if (judge(\`does the user want onboarding\`)) {
    $instruct(\`Walk the user through setup.\`);
    $instruct(\`Then confirm their goals.\`);
  }
}`;

// A candidate that changes the recorded judgment's question — the recorded
// item can no longer pair (a changed item, not an insertion), so replay is
// incompatible at that action brief.
const ONBOARD_CHANGED = `"arc";
function Onboard() {
  this.trigger = () => { return true; };
  this.hostParams = { workerRole: "concierge" };
  if (judge(\`is the user a returning customer\`)) {
    $instruct(\`Walk the user through setup.\`);
  }
}`;

const V1_ARC = "arc:onboard:Onboard" as ArcRef;
const V2_ARC = "arc:onboard2:Onboard" as ArcRef;

type RecordedRun = {
  host: ArcHostService;
  replay: InMemoryReplayStore;
  operator: TestingOperatorConnector;
  runId: ArcRunId;
};

/**
 * Drive a real activation through the worker hub with in-process workers,
 * recording a v1 run to completion, then run `body` against it. The hub and
 * operator connector lifecycles are started and stopped consistently, and
 * cleanup runs even when an assertion throws.
 */
async function withRecordedRun(
  body: (ctx: RecordedRun) => Promise<void>,
): Promise<void> {
  const { host, replay } = makeReplayHost();
  await host.registerArc("onboard", parse(ONBOARD_V1));
  const { workerHub } = makeWorkerHub({
    arcHost: host,
    workers: {
      concierge: answeringWorker,
      [DEFAULT_WORKER_ROLE]: answeringWorker,
    },
  });
  const operator = new TestingOperatorConnector(host);
  await operator.start();
  try {
    const runId = await firstActivation(
      workerHub.submitInbound({
        content: "I'd like to get started.",
        metadata: { principal: REPLAY_OWNER },
      }),
    );
    await waitFor(
      async () =>
        (await host.listRunViews())
          .filter((view) => view.stage === "actioning")
          .find((view) => view.arcRunId === runId)?.lifecycle === "completed",
    );
    await body({ host, replay, operator, runId });
  } finally {
    await operator.stop();
    await workerHub.stop();
  }
}

function workerActionReports(
  steps: readonly ReplayStep[],
): Extract<ReplayStep, { kind: "action-report" }>[] {
  return steps.filter(
    (step): step is Extract<ReplayStep, { kind: "action-report" }> =>
      step.kind === "action-report" && step.origin === "worker",
  );
}

describe("replay end-to-end via the hub + a testing operator connector", () => {
  it("records a trigger stream before the action stream, with a seed checkpoint", () =>
    withRecordedRun(async ({ replay, runId }) => {
      const steps = await replay.listSteps(runId);
      const triggerIdx = steps.flatMap((step, i) =>
        step.kind.startsWith("trigger") ? [i] : [],
      );
      const actionIdx = steps.flatMap((step, i) =>
        step.position.stage === "action" ? [i] : [],
      );
      expect(triggerIdx.length).toBeGreaterThan(0);
      expect(actionIdx.length).toBeGreaterThan(0);
      // Every trigger step precedes every action step.
      expect(Math.max(...triggerIdx)).toBeLessThan(Math.min(...actionIdx));

      // The action stream is seeded at checkpoint 0 (the activation seed).
      const checkpoints = await replay.listCheckpoints(runId);
      expect(checkpoints[0]?.position).toEqual({
        stage: "action",
        index: 0,
        reactivationCount: 0,
      });

      // The first worker-answered action report is the judgment at position 1.
      const reports = workerActionReports(steps);
      expect(reports.length).toBeGreaterThan(0);
      expect(reports[0]!.position).toEqual({
        stage: "action",
        index: 1,
        reactivationCount: 0,
      });
    }));

  it("jumps an in-flight run onto an appended candidate, leaving a replayable fork", () =>
    withRecordedRun(async ({ host, replay, operator, runId }) => {
      const candidate = await operator.registerCandidate(
        "onboard2",
        parse(ONBOARD_V2),
      );
      expect(candidate).toBe(V2_ARC);

      const before = await host.getRunView(runId);
      const jumped = await operator.jump(runId, candidate);
      if (jumped.status === "incompatible") {
        throw new Error("expected a fork from jump");
      }
      // The appended tail parts from the recorded run, so the fork diverges.
      expect(jumped.handoff).toBe("diverged");
      const forkPoint = handoffCheckpoint(jumped.regenerated).position;

      const fork = await host.getRunView(jumped.arcRunId);
      expect(fork?.arcRef).toBe(candidate);
      expect(jumped.arcRunId).not.toBe(runId);
      // The source run is untouched by the fork.
      expect(await host.getRunView(runId)).toEqual(before);

      // The fork is itself replayable: a full trigger stream, an action seed
      // checkpoint, and the pre-report boundary at the fork point (no report).
      const forkSteps = await replay.listSteps(jumped.arcRunId);
      expect(forkSteps.some((step) => step.kind === "trigger-brief")).toBe(
        true,
      );
      expect(
        await replay.getCheckpoint(jumped.arcRunId, {
          stage: "action",
          index: 0,
          reactivationCount: 0,
        }),
      ).toBeDefined();
      expect(
        forkSteps.some(
          (step) =>
            step.kind === "action-report" &&
            step.position.index === forkPoint.index,
        ),
      ).toBe(false);
    }));

  it("rewinds the original run to an earlier checkpoint as a new run", () =>
    withRecordedRun(async ({ host, replay, operator, runId }) => {
      const rewound = await operator.rewind(runId, {
        stage: "action",
        index: 1,
        reactivationCount: 0,
      });
      expect(rewound.arcRunId).not.toBe(runId);
      expect((await host.getRunView(rewound.arcRunId))?.arcRef).toBe(V1_ARC);

      const sourceCheckpoint = await replay.getCheckpoint(runId, {
        stage: "action",
        index: 1,
        reactivationCount: 0,
      });
      const rewoundCheckpoint = await replay.getCheckpoint(rewound.arcRunId, {
        stage: "action",
        index: 1,
        reactivationCount: 0,
      });
      expect(rewoundCheckpoint).toEqual(sourceCheckpoint);

      // The rewound run copies the source prefix with the pre-report boundary.
      const steps = await replay.listSteps(rewound.arcRunId);
      expect(
        steps.some(
          (step) => step.kind === "action-brief" && step.position.index === 1,
        ),
      ).toBe(true);
      expect(
        steps.some(
          (step) => step.kind === "action-report" && step.position.index === 1,
        ),
      ).toBe(false);
    }));

  it("hands off a changed-judgment candidate at the action position, forking a new run", () =>
    withRecordedRun(async ({ host, operator, runId }) => {
      const candidate = await operator.registerCandidate(
        "onboard2",
        parse(ONBOARD_CHANGED),
      );
      const sourceBefore = await host.getRunView(runId);

      // The changed judgment makes action brief 1 differ. Activation still
      // reproduces, so the candidate is committed to: the jump hands off
      // (diverged) and forks a new run at the activation handoff.
      const jumped = await operator.jump(runId, candidate);
      expect(jumped.status).toBe("compatible");
      if (jumped.status === "incompatible") return;
      expect(jumped.handoff).toBe("diverged");

      const fork = await host.getRunView(jumped.arcRunId);
      expect(fork?.arcRef).toBe(candidate);
      // The source run is untouched.
      expect(jumped.arcRunId).not.toBe(runId);
      expect(await host.getRunView(runId)).toEqual(sourceBefore);
    }));
});

describe("replay lifecycle publication", () => {
  it("publishes terminal successor starts before outcomes for rewind and jump without changing source history", async () => {
    await withRecordedRun(async ({ host, replay, runId }) => {
      const history = await workEventsFor(host).list(runId);
      const steps = await replay.listSteps(runId);
      const terminal = steps.find((step) => step.kind === "terminal-brief");
      if (!terminal) throw new Error("Expected terminal replay output");
      const observed: string[] = [];
      workEventsFor(host).registerWorkEventHandler(async (event) => {
        if (event.kind === "run:started") {
          expect(await host.getRunView(event.arcRunId)).toMatchObject({
            stage: "actioning",
          });
          observed.push(event.arcRunId);
        }
      });
      const rewind = await host.rewind(runId, terminal.position);
      expect(
        (await workEventsFor(host).list(rewind.arcRunId)).map(
          (event) => event.kind,
        ),
      ).toEqual(["run:started", "run:completed"]);
      const jump = await host.jump(runId, V1_ARC);
      if (jump.status === "incompatible")
        throw new Error("Expected compatible jump");
      expect((await workEventsFor(host).list(jump.arcRunId))[0]).toMatchObject({
        kind: "run:started",
        route: "jump",
      });
      expect(observed).toEqual([rewind.arcRunId, jump.arcRunId]);
      expect(await workEventsFor(host).list(runId)).toEqual(history);
    });
  });
});
