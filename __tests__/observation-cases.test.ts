import { parse } from "@elem-app/arc/parser";
import { describe, expect, it } from "vitest";
import { renderSemanticRequestForPrompt } from "../src/service/task-renderer.js";
import { arcRunKey } from "../src/storage/base.js";
import {
  InMemoryArcHostStore,
  renderInstructionTaskText,
} from "../src/testing.js";
import { outbound } from "./backend-helpers.js";
import { createTestArcHost } from "./work-event-fixtures.js";

import type { ObservationReport } from "@elem-app/arc/runtime";

import "../eval/cases/index.js";

import { listEvalCases } from "../eval/case-registry.js";
import type { ObservationCase } from "../eval/observation-cases.js";
import {
  observationCases,
  trackObservationAnswers,
} from "../eval/observation-cases.js";
import {
  structObservationCases,
  structTriggerSource,
} from "../eval/struct-observation-cases.js";
import {
  unionTriggerSource,
  unionValueCases,
} from "../eval/union-observation-cases.js";
import type {
  RoutineContext,
  SemanticRequest,
  SemanticTask,
  Task,
} from "../src/testing.js";
import {
  ALICE_OWNER,
  firstActivation,
  makeArcHost,
  makeWorkerHub,
  waitFor,
} from "./helpers.js";

/**
 * Deterministic counterpart to the observation evals: every case runs against a
 * real Arc host and worker hub with a scripted worker that reports exactly the
 * case's observed values. It owns the input-integrity half — that each case's
 * Arc source emits the brief the case is about, that the reported values commit,
 * and that the branch they select is the one the eval asserts on — so the live
 * evals only have to show a real provider producing those values.
 */
describe("observation eval cases", () => {
  it("emits the case's brief and selects its branch from the reported values", async () => {
    const cases = observationCases();
    expect(cases.map((item) => item.name)).toEqual([
      "grouped-observation",
      "array-observation",
      "grouped-observe-or-ask",
      "participant-observe-or-ask",
      "grouped-participant-observe-or-ask",
      "standing-guidance-observation",
      "union-observation",
      "union-container-observation",
      "union-unknown-observation",
      "union-observe-or-ask",
      "struct-observation",
      "struct-array-observation",
    ]);
    const registry = new Map(listEvalCases().map((item) => [item.id, item]));
    for (const item of cases) {
      expect(
        Object.keys(registry.get(item.name)?.executions ?? {}).sort(),
        item.name,
      ).toEqual(["claude-sdk", "openai-sdk"]);
    }
    expect(registry.get("grouped-observe-or-ask")?.profile).toBe("smoke");

    for (const item of cases) {
      const store = new InMemoryArcHostStore();
      const arcHost = await createTestArcHost({ store });
      await arcHost.registerArc(
        `observation-case-${item.name}`,
        parse(item.arcSource),
      );
      const requests: SemanticRequest[] = [];
      const taskKinds: Task["kind"][] = [];
      const instructions: string[] = [];
      let semanticCalls = 0;
      const { workerHub } = makeWorkerHub({
        arcHost,
        workers: {
          writer: async (task, context) => {
            taskKinds.push(task.kind);
            if (task.kind === "instruction") {
              instructions.push(
                renderInstructionTaskText(task, context as RoutineContext, {
                  kind: "host",
                }),
              );
              return { outcome: "completed" };
            }
            if (task.kind !== "semantic") return { outcome: "completed" };
            requests.push(...task.requests);
            semanticCalls += 1;
            if (item.name.includes("participant")) {
              for (const request of task.requests) {
                const rendered = renderSemanticRequestForPrompt(
                  request,
                  context as RoutineContext,
                  { kind: "host" },
                  task.stage,
                );
                expect(rendered).toMatchObject({
                  audienceReferences: item.withheld!.map((entry) => ({
                    marker: `<audience:${entry.audience}>`,
                    audience: entry.audience,
                  })),
                });
                if (request.kind === "observation-group") {
                  expect(
                    request.fields.every(
                      (field) => field.currentValue === undefined,
                    ),
                  ).toBe(true);
                }
              }
            }
            // Leave each withheld field pending in turn to prove the group
            // writes nothing even when its other field reports a value.
            return semanticReport(
              task,
              item,
              item.withheld?.[semanticCalls - 1]?.cell,
            );
          },
        },
      });

      const arcRunId = await firstActivation(
        workerHub.submitInbound({
          content: item.inbound,
          metadata: { principal: ALICE_OWNER },
        }),
      );
      await waitFor(() => instructions.length === 1);

      // The case's brief carries the shape the case is about: a group brief
      // lists a field per grouped cell, an array brief carries its element shape.
      const observationRequests = requests.filter(
        (request) => request.kind !== "judgment",
      );
      expect(observationRequests.length, item.name).toBeGreaterThan(0);
      if (item.name === "array-observation") {
        expect(observationRequests[0], item.name).toMatchObject({
          kind: "observation",
          cell: "regions",
          meta: { type: "array", element: { type: "string" } },
        });
      } else if (item.name === "struct-observation") {
        expect(observationRequests[0], item.name).toMatchObject({
          kind: "observation",
          cell: "incident",
          meta: {
            type: "struct",
            fields: {
              routing: { meta: { type: "struct" } },
              checks: { meta: { type: "array", element: { type: "struct" } } },
            },
          },
        });
      } else if (item.name === "struct-array-observation") {
        expect(observationRequests[0], item.name).toMatchObject({
          kind: "observation",
          cell: "targets",
          meta: {
            type: "array",
            element: {
              type: "struct",
              fields: {
                rollout: { meta: { type: "struct" } },
              },
            },
          },
        });
      } else if (item.name === "participant-observe-or-ask") {
        expect(observationRequests[0]).toMatchObject({
          kind: "observation",
          cell: "budget",
          mode: "observeOrAsk",
        });
      } else if (
        item.name === "union-unknown-observation" ||
        item.name === "union-observe-or-ask"
      ) {
        expect(observationRequests[0], item.name).toMatchObject({
          kind: "observation",
          cell: "hour",
          mode: item.withheld ? "observeOrAsk" : "observe",
          meta: { type: "union" },
        });
      } else {
        expect(observationRequests[0], item.name).toMatchObject({
          kind: "observation-group",
          fields: Object.keys(item.observed).map((cell) =>
            expect.objectContaining({ cell }),
          ),
        });
      }

      // A withheld field re-emits the whole group and writes nothing, so the
      // branch instruction only follows the pass that resolves every field.
      expect(taskKinds, item.name).toEqual(
        item.withheld
          ? [...item.withheld.map(() => "semantic"), "semantic", "instruction"]
          : ["semantic", "instruction"],
      );

      const state = await store.getState(arcRunKey(arcRunId));
      const cells = state?.traversals.find(
        (traversal) => traversal.ref === state.arcRef,
      )?.cells;
      expect(
        Object.fromEntries(
          Object.keys(item.observed).map((cell) => [cell, cells?.[cell]]),
        ),
        item.name,
      ).toEqual(item.observed);
      const rendered = instructions[0]!;
      expect(rendered, item.name).toContain(item.artifact);
      expect(rendered, item.name).not.toContain(item.unselectedArtifact);
      for (const fact of item.requiredArtifactFacts) {
        expect(rendered, `${item.name}:${fact}`).toContain(fact);
      }
    }
  });

  it("admits Struct trigger eval values and rejects the nonmatching nested values", async () => {
    for (const item of structObservationCases()) {
      for (const matches of [false, true]) {
        const arcHost = await makeArcHost();
        const source = `trigger-${item.name}`;
        await arcHost.registerArc(source, parse(structTriggerSource(item)));
        const requests: SemanticRequest[] = [];
        const { workerHub } = makeWorkerHub({
          arcHost,
          workers: {
            triager: async (task) => {
              if (task.kind !== "semantic" || task.stage !== "trigger")
                throw new Error("expected a trigger semantic task");
              requests.push(...task.requests);
              return semanticReport(
                task,
                {
                  name: item.name,
                  observed: {
                    [item.cell]: matches ? item.value : item.negativeValue,
                  },
                },
                undefined,
              );
            },
          },
        });
        const events = [];
        for await (const event of workerHub.submitInbound({
          content: matches ? item.inbound : item.negativeInbound,
          metadata: { principal: ALICE_OWNER },
        }))
          events.push(event);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          kind: "observation",
          cell: item.cell,
          meta: {
            type: item.name === "struct-observation" ? "struct" : "array",
          },
        });
        expect(
          events.map((event) => event.kind),
          `${item.name}:${matches}`,
        ).toEqual(matches ? ["activated"] : []);
      }
    }
  });

  it("union eval triggers require explicit answers and preserve nested union values", async () => {
    const registry = new Map(listEvalCases().map((item) => [item.id, item]));
    for (const item of unionValueCases()) {
      const caseId = item.name.replace("-observation", "-trigger-observation");
      expect(
        Object.keys(registry.get(caseId)?.executions ?? {}).sort(),
      ).toEqual(["claude-sdk-tst", "openai-sdk-tst"]);
      for (const matches of [false, true]) {
        const arcHost = await makeArcHost();
        await arcHost.registerArc(caseId, parse(unionTriggerSource(item)));
        const requests: SemanticRequest[] = [];
        const { workerHub } = makeWorkerHub({
          arcHost,
          workers: {
            triager: async (task) => {
              if (task.kind !== "semantic" || task.stage !== "trigger")
                throw new Error("expected a trigger semantic task");
              requests.push(...task.requests);
              return semanticReport(
                task,
                {
                  name: item.name,
                  observed: matches ? item.observed : item.negativeObserved,
                },
                undefined,
              );
            },
          },
        });
        const events = [];
        for await (const event of workerHub.submitInbound({
          content: matches ? item.inbound : item.negativeInbound,
          metadata: { principal: ALICE_OWNER },
        }))
          events.push(event);
        expect(requests).toHaveLength(1);
        expect(requests[0]).toMatchObject({
          kind: "observation-group",
          fields: Object.keys(item.observed).map((cell) =>
            expect.objectContaining({ cell }),
          ),
        });
        expect(
          events.map((event) => event.kind),
          `${caseId}:${matches}`,
        ).toEqual(matches ? ["activated"] : []);
      }
    }
  });
});

/** Report every request of a semantic task from the case's observed values. */
function semanticReport(
  task: SemanticTask,
  item: Pick<ObservationCase, "name" | "observed">,
  parkedCell: string | undefined,
) {
  const observations: Record<
    string,
    ObservationReport | { fields: Record<string, ObservationReport> }
  > = {};
  for (const request of task.requests) {
    if (request.kind === "observation") {
      observations[request.briefId] = outcome(item, request.cell, parkedCell);
    } else if (request.kind === "observation-group") {
      observations[request.briefId] = {
        fields: Object.fromEntries(
          request.fields.map((field) => [
            field.cell,
            outcome(item, field.cell, parkedCell),
          ]),
        ),
      };
    }
  }
  return { outcome: "completed" as const, semantic: { observations } };
}

function outcome(
  item: Pick<ObservationCase, "name" | "observed">,
  cell: string,
  parkedCell: string | undefined,
): ObservationReport {
  if (cell === parkedCell) return { status: "needs-user" };
  if (!Object.hasOwn(item.observed, cell)) {
    throw new Error(`Case ${item.name} has no observed value for ${cell}.`);
  }
  const value = item.observed[cell];
  return value === undefined
    ? { status: "unknown" }
    : { status: "resolved", value };
}

it("keeps unexpected observation recipients failed after successful answer recovery", async () => {
  const item = observationCases().find(
    (item) => item.name === "grouped-participant-observe-or-ask",
  )!;
  const tracker = trackObservationAnswers(item);
  const delivered: string[] = [];
  const ask = (audience: string) =>
    tracker.answer(
      outbound({
        situation: { audience, cause: "question" },
        content: "Value?",
        metadata: { askId: `ask-${audience}` },
      }),
      async (answer) => {
        delivered.push(answer);
      },
    );
  await expect(ask("originator")).rejects.toThrow(
    "unexpected question recipient",
  );
  expect(delivered).toEqual([]);
  await ask("supervisor");
  await ask("reviewer");
  expect(delivered).toEqual(["4700", "12"]);
  expect(tracker.attempts).toHaveLength(3);
  expect(tracker.answered).toHaveLength(2);
  expect(() => tracker.assertComplete()).toThrow(
    "unexpected question recipients",
  );
});

it("requires every observation participant to supply a correlated answer", async () => {
  const item = observationCases().find(
    (item) => item.name === "grouped-participant-observe-or-ask",
  )!;
  const tracker = trackObservationAnswers(item);
  const message = (audience: string) =>
    outbound({
      situation: { audience, cause: "question" },
      content: "Value?",
      metadata: { askId: `ask-${audience}` },
    });
  expect(() => tracker.assertComplete()).toThrow(
    "correlated answer for budget",
  );
  await tracker.answer(message("supervisor"), async () => {});
  expect(() => tracker.assertComplete()).toThrow(
    "correlated answer for leadDays",
  );
  await expect(
    tracker.answer(message("reviewer"), async () => {
      throw new Error("answer rejected");
    }),
  ).rejects.toThrow("answer rejected");
  expect(() => tracker.assertComplete()).toThrow(
    "correlated answer for leadDays",
  );
  await tracker.answer(message("reviewer"), async () => {});
  expect(() => tracker.assertComplete()).not.toThrow();
});
