import { parse } from "@elem-app/arc/parser";
import type { ObservationMeta } from "@elem-app/arc/types";
import { expect, it } from "vitest";

import { generateDomain } from "../src/service/simulation-values.js";
import {
  SimulatorService,
  type SimulationContext,
  type SimulationLimits,
  type SimulationOptions,
} from "../src/testing.js";
import { dialog, fixture } from "./simulation-helpers.js";

const site = { sourceRef: "node:x:Y" as const, briefId: "q" };
const context: SimulationContext = {
  stage: "action",
  position: { stage: "action", index: 1, reactivationCount: 0 },
  sourceRef: site.sourceRef,
  previousDialog: dialog,
  choices: [],
  traversals: [],
};
const limits: SimulationLimits = {
  maxValuesPerInput: 32,
  maxArrayLength: 2,
  maxPaths: 10,
  maxTotalReports: 50,
  maxReportsPerPath: 10,
  maxPendingPrefixes: 10,
  maxCandidateCombinations: 100,
  maxRecordBytes: 100000,
};
const options: SimulationOptions = { arcRef: "arc:x:Y", dialog };
function domain(meta: ObservationMeta, cap = 32) {
  return generateDomain(
    {
      kind: "observation",
      cell: "a",
      site,
      mode: "observeOrAsk",
      question: "a",
      meta,
    },
    context,
    dialog,
    options,
    { ...limits, maxValuesPerInput: cap },
  );
}
it("sim.values counts finite and truncated domains honestly", () => {
  const small = domain({ type: "rangedInt", min: 0, max: 2 });
  expect(small.classification).toBe("finite-complete");
  expect(small.candidates.map((c) => c.answer)).toEqual(
    [0, 1, 2].map((value) => ({ status: "resolved", value })),
  );
  expect(domain({ type: "rangedInt", min: 0, max: 100 }, 4)).toMatchObject({
    classification: "sampled",
    truncated: true,
  });
  expect(domain({ type: "number" }).classification).toBe("sampled");
  expect(domain({ type: "number", min: 5, max: 5 }, 1)).toMatchObject({
    classification: "finite-complete",
    truncated: false,
    candidates: [{ answer: { status: "resolved", value: 5 } }],
  });
  expect(domain({ type: "number", min: 5, max: 6 }).classification).toBe(
    "sampled",
  );
});
it("sim.values enumerates heterogeneous compound cases", () => {
  const b = { question: "field", meta: { type: "boolean" as const } };
  expect(
    domain({ type: "struct", fields: { a: b, b: b } }).candidates,
  ).toHaveLength(4);
  const fields = Object.fromEntries(
    Array.from({ length: 6 }, (_, i) => ["f" + i, b]),
  );
  const large = domain({ type: "struct", fields });
  expect(large.candidates).toHaveLength(32);
  for (const field of Object.keys(fields))
    expect(
      large.candidates.some(
        (c) =>
          typeof c.answer === "object" &&
          c.answer.status === "resolved" &&
          (c.answer.value as Record<string, boolean>)[field],
      ),
    ).toBe(true);
  expect(domain({ type: "array", element: b.meta }).candidates).toHaveLength(7);
  expect(
    domain({ type: "union", members: [b.meta, b.meta] }).candidates,
  ).toHaveLength(2);
});
it("sim.providers record restrictions and reject invalid examples", async () => {
  const { run } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let n=RangedInt(0,20);$observeOrAsk(n);if(n>10){$instruct("High");}}`,
  );
  const provider = () => ({
    mode: "replace" as const,
    values: [9, 10, 11],
    label: "threshold",
  });
  const result = await run({
    exploration: "exhaustive",
    values: provider,
    accept: (c) =>
      typeof c.answer !== "boolean" && c.answer.value === 10
        ? { accept: false, reason: "omit ten" }
        : { accept: true },
  });
  expect(result.paths).toHaveLength(2);
  expect(result.completeness.domains).toBe("restricted");
  expect(result.exclusions).toMatchObject([{ reason: "omit ten", count: 1 }]);
  await expect(
    run({ values: () => ({ ...provider(), values: [30] }) }),
  ).rejects.toThrow(/Invalid example 0/);
});

it("sim.providers validates cursor examples against the handback Dialog", async () => {
  const document = parse(
    '"arc"; import Log from "host:log"; function Main(){this.trigger=()=>true;Log.$cursor();}',
  );
  const simulator = new SimulatorService({
    captureSnapshot: async () => ({
      documents: [{ source: "log-test", document }],
      hostModules: new Map([
        [
          "log",
          {
            kind: "namespace",
            members: {
              cursor: {
                kind: "operation",
                parameters: [],
                returns: { type: "dialogCursor" },
              },
            },
          },
        ],
      ]),
    }),
  });
  const handback = {
    lastTurns: [{ role: "user" as const, message: "Ready." }],
    cursor: { user: 1, self: 0 },
    view: "action",
  };
  const run = (user: number, view: string) =>
    simulator.simulate({
      arcRef: "arc:log-test:Main",
      dialog: (context) => (context.stage === "action" ? handback : dialog),
      values: (_input, context) => {
        expect(context.previousDialog).toEqual(dialog);
        return {
          mode: "replace",
          label: "cursor",
          values: [{ user, self: 0, view }],
        };
      },
    });
  const result = await run(1, "action");
  const path = await simulator.getPath(result.paths[0]!.id);
  const report = path.steps.find((s) => s.kind === "action-report");
  expect(report?.dialog).toEqual(handback);
  expect(Object.values(report!.report.hostCalls!)).toEqual([
    { status: "resolved", value: { user: 1, self: 0, view: "action" } },
  ]);
  await expect(run(2, "action")).rejects.toThrow(/Invalid example 0/);
  await expect(run(1, "other")).rejects.toThrow(/Invalid example 0/);
});

it("sim.providers rejects sparse array examples before truncation", async () => {
  const { run } = fixture(
    '"arc"; function Main(){this.trigger=()=>true;let xs=Array(Bool());$observeOrAsk(xs);}',
  );
  for (const maxValuesPerInput of [1, 2]) {
    await expect(
      run({
        limits: { maxValuesPerInput },
        values: () => ({
          mode: "replace",
          label: "examples",
          values: [[true], Array<boolean>(1)],
        }),
      }),
    ).rejects.toThrow(/Invalid example 1 for node:fixture:Main/);
  }
});

it("sim.providers validates array carriers before cloning supplied examples", async () => {
  const { run } = fixture(
    '"arc"; function Main(){this.trigger=()=>true;let xs=Array(Bool());$observeOrAsk(xs);}',
  );
  const accessed = [true];
  Object.defineProperty(accessed, "0", {
    get: () => {
      throw new Error("Invoked provider getter");
    },
    enumerable: true,
  });
  for (const invalid of [
    Object.assign([true], { unit: "flags" }),
    Object.defineProperty([true], Symbol("unit"), { value: "flags" }),
    Object.defineProperty([true], "0", { enumerable: false }),
    accessed,
    Object.setPrototypeOf([true], Object.create(Array.prototype)),
  ]) {
    await expect(
      run({
        limits: { maxValuesPerInput: 1 },
        values: () => ({
          mode: "replace",
          label: "flags",
          values: [[true], invalid],
        }),
      }),
    ).rejects.toThrow(/Invalid example 1 for node:fixture:Main/);
  }
});
