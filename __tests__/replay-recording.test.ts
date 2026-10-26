import { parse } from "@elem-app/arc/parser";
import { describe, expect, it } from "vitest";
import { createTestArcHost } from "./work-event-fixtures.js";

import {
  InMemoryArcHostStore,
  positionKey,
  type ActionReportStep,
  type ReplayStep,
} from "../src/testing.js";
import { beginActivatedDriver } from "./arc-host-helpers.js";
import { GREET_SOURCE } from "./helpers.js";
import { makeReplayHost, runToCompletion } from "./replay-helpers.js";

function summarize(steps: readonly ReplayStep[]): string[] {
  return steps.map((step) => {
    const base = `${step.kind}@${positionKey(step.position)}`;
    return step.kind.endsWith("report")
      ? `${base}(${(step as ActionReportStep).origin})`
      : base;
  });
}

describe("replay recording", () => {
  it("records a position-0 seed, action outputs from 1, and brief/report sharing a position", async () => {
    const { host, replay } = makeReplayHost();
    await host.registerArc("greet", parse(GREET_SOURCE));
    const runId = await runToCompletion(host, "hi");

    expect(summarize(await replay.listSteps(runId))).toEqual([
      "trigger-brief@0:trigger:1",
      "action-brief@0:action:1",
      "action-report@0:action:1(worker)",
      "terminal-brief@0:action:2",
    ]);
    // Action checkpoints begin at the activation seed (index 0) and there is one
    // checkpoint per action output; the report shares its brief's index.
    expect(
      (await replay.listCheckpoints(runId)).map(
        (entry) => entry.position.index,
      ),
    ).toEqual([0, 1, 2]);
  });

  it("tags worker-driven action reports with the worker origin", async () => {
    const { host, replay } = makeReplayHost();
    await host.registerArc("greet", parse(GREET_SOURCE));
    const runId = await runToCompletion(host, "hi");

    const reports = (await replay.listSteps(runId)).filter(
      (step): step is ActionReportStep => step.kind === "action-report",
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.origin).toBe("worker");
  });

  it("records a worker interrupt disposition with the worker origin", async () => {
    const { host, replay } = makeReplayHost();
    await host.registerArc("greet", parse(GREET_SOURCE));
    const dialog = { cursor: { user: 0, self: 0 }, lastTurns: [] };
    const driver = await beginActivatedDriver(host, dialog);
    await driver.advance({
      dialog,
      input: {
        reports: [
          {
            outcome: "disposition",
            interrupt: { id: "external", reason: "ping" },
          },
        ],
        instructionCoverage: {},
      },
    });

    const reports = (await replay.listSteps(driver.arcRunId)).filter(
      (step): step is ActionReportStep => step.kind === "action-report",
    );
    expect(reports).toEqual([
      expect.objectContaining({
        origin: "worker",
        report: {
          move: "interrupt",
          interruption: { id: "external", reason: "ping" },
        },
      }),
    ]);
  });

  it("records the trigger stream under the activated run id", async () => {
    const { host, replay } = makeReplayHost();
    await host.registerArc("greet", parse(GREET_SOURCE));
    const runId = await runToCompletion(host, "hi");

    const triggerSteps = (await replay.listSteps(runId)).filter((step) =>
      step.kind.startsWith("trigger"),
    );
    expect(triggerSteps).toHaveLength(1);
    expect(triggerSteps[0]!.kind).toBe("trigger-brief");
  });

  it("records and verifies terminal root identity, outcome, and returns", async () => {
    const { host, replay } = makeReplayHost();
    await host.registerArc(
      "operation",
      parse(`
"arc";
function Operation(returns = { output: Str() }) {
  this.trigger = () => true;
  $instruct(\`run operation\`);
  this.effects = () => {
    returns.output.$set("done");
  };
}
`),
    );
    const runId = await runToCompletion(host, "run");
    const terminalStep = (await replay.listSteps(runId)).find(
      (step) => step.kind === "terminal-brief",
    );

    expect(terminalStep?.kind).toBe("terminal-brief");
    if (terminalStep?.kind !== "terminal-brief") return;
    expect(terminalStep.brief).toEqual({
      canProgress: false,
      root: "arc:operation:Operation",
      outcome: "covered",
      returns: { output: "done" },
      issues: [],
    });

    const alignment = await host.verifyReplay(
      runId,
      "arc:operation:Operation" as never,
    );
    expect(alignment).toMatchObject({
      status: "compatible",
      handoff: "reproduced",
    });
  });

  it("records nothing and behaves identically when no replay store is configured", async () => {
    const host = createTestArcHost({ store: new InMemoryArcHostStore() });
    await host.registerArc("greet", parse(GREET_SOURCE));
    const runId = await runToCompletion(host, "hi");

    const view = await host.getRunView(runId);
    expect(view?.stage).toBe("actioning");
    if (view?.stage !== "actioning") throw new Error("Expected execution view");
    expect(view.lifecycle).toBe("completed");
    // Replay APIs require a configured store.
    await expect(
      host.verifyReplay(runId, "arc:greet:Greet" as never),
    ).rejects.toThrow(/replayStore/);
  });
});
