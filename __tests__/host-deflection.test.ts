import { parse } from "@elem-app/arc/parser";
import { toArcRef, toNodeRef } from "@elem-app/arc/runtime";
import { describe, expect, it } from "vitest";

import { arcRunKey } from "../src/testing.js";
import { beginActivatedDriver, projectorFor } from "./arc-host-helpers.js";
import { makeReplayHost, userDialog } from "./replay-helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";

function source(origin: "guard" | "policy"): string {
  return `"arc";
function Main() {
  this.trigger = () => true;
  $enter(Child);
  function Child() {
    ${origin === "guard" ? "this.guard = () => State.DEFLECTED;" : ""}
    this.catchDeflection = () => judge(\`catch the deflection\`);
    $instruct(\`work\`${origin === "policy" ? ", { deflectWhen: `defer work` }" : ""});
  }
}`;
}

describe("required deflection host acknowledgement", () => {
  it.each(["guard", "policy"] as const)(
    "persists and records a %s deflection before catch and resumes without another acknowledgement",
    async (origin) => {
      const { host, replay, store } = await makeReplayHost();
      await host.registerArc("deflection", parse(source(origin)));
      const dialog = userDialog("start");
      let acknowledgements = 0;
      const append = replay.appendStep.bind(replay);
      replay.appendStep = async (runId, step) => {
        if (
          step.kind === "action-report" &&
          step.origin === "host-deflection"
        ) {
          acknowledgements += 1;
          expect(step.report).toEqual({ move: "deflect" });
          const pending = await store.getState(arcRunKey(runId));
          expect(pending?.traversals[0]?.ownedChildren[0]?.control).toEqual({
            reason: "deflected",
            phase: "requested",
            deflection: { origin: toNodeRef("deflection", ["Main", "Child"]) },
          });
        }
        await append(runId, step);
      };

      let driver = await beginActivatedDriver(host, dialog);
      if (origin === "policy") {
        expect(acknowledgements).toBe(0);
        driver = (
          await driver.advance({
            dialog,
            input: {
              instructionCoverage: {},
              reports: [
                {
                  outcome: "completed",
                  semantic: {
                    judgments: {
                      [driver.frontier.briefs.judgments[0]!.id]: true,
                    },
                  },
                },
              ],
            },
          })
        ).driver;
      }
      expect(acknowledgements).toBe(1);
      expect(driver.frontier.briefs.judgments).toHaveLength(1);
      const steps = await replay.listSteps(driver.arcRunId);
      const pendingIndex = steps.findIndex(
        (step) =>
          step.kind === "action-brief" && step.brief.deflection !== undefined,
      );
      expect(pendingIndex).toBeGreaterThan(0);
      expect(steps[pendingIndex]).toMatchObject({
        kind: "action-brief",
        brief: {
          deflection: { origin: toNodeRef("deflection", ["Main", "Child"]) },
          allowedMoves: ["deflect"],
        },
      });
      expect(steps[pendingIndex + 1]).toMatchObject({
        kind: "action-report",
        origin: "host-deflection",
        report: { move: "deflect" },
      });
      expect(steps.slice(0, pendingIndex)).toContainEqual(
        expect.objectContaining({
          kind: "action-report",
          origin: "host-transition",
        }),
      );

      const restored = await createTestArcHost({ store, replayStore: replay });
      const [restoredStep] = await restored.begin({
        arcRunId: driver.arcRunId,
        projectDialog: projectorFor(dialog),
      });
      if (restoredStep?.kind !== "action")
        throw new Error("Expected action step.");
      const next = await restored.advanceAction(
        driver.arcRunId,
        restoredStep.frontier.frontierId,
        {
          instructionCoverage: {},
          projectDialog: projectorFor(dialog),
          reports: [
            {
              outcome: "completed",
              semantic: {
                judgments: { [driver.frontier.briefs.judgments[0]!.id]: true },
              },
            },
          ],
        },
      );
      expect(next.kind).toBe("action");
      if (next.kind !== "action") throw new Error("Expected action step.");
      expect(next.frontier.briefs.instructions).toHaveLength(1);
      expect(acknowledgements).toBe(1);
    },
  );

  it("verifies required deflection context through renamed replay and detects altered payloads", async () => {
    const { host, replay } = await makeReplayHost();
    const rootSource = `"arc"; function Main() {
      this.trigger = () => true;
      this.catchDeflection = () => judge(\`catch\`);
      $instruct(\`work\`, { deflectWhen: \`defer work\` });
    }`;
    await host.registerArc("deflection", parse(rootSource));
    const dialog = userDialog("start");
    const driver = await beginActivatedDriver(host, dialog);
    await driver.advance({
      dialog,
      input: {
        instructionCoverage: {},
        reports: [
          {
            outcome: "completed",
            semantic: {
              judgments: { [driver.frontier.briefs.judgments[0]!.id]: true },
            },
          },
        ],
      },
    });
    await host.registerArc("renamed", parse(rootSource));
    const alignment = await host.verifyReplay(
      driver.arcRunId,
      toArcRef("renamed", "Main"),
    );
    expect(alignment).toMatchObject({
      status: "compatible",
      handoff: "reproduced",
    });
    const steps = await replay.listSteps(driver.arcRunId);
    for (const deflection of [
      undefined,
      { origin: toNodeRef("deflection", ["Other"]) },
      {
        origin: toNodeRef("deflection", ["Main"]),
        from: toNodeRef("deflection", ["Main"]),
      },
    ]) {
      replay.listSteps = async () =>
        steps.map((step) =>
          step.kind === "action-brief" && step.brief.deflection
            ? { ...step, brief: { ...step.brief, deflection } }
            : step,
        );
      expect(
        await host.verifyReplay(
          driver.arcRunId,
          toArcRef("deflection", "Main"),
        ),
      ).toMatchObject({
        status: "compatible",
        handoff: "diverged",
      });
    }
  });
});
