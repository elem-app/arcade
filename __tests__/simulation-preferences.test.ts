import { expect, it } from "vitest";
import {
  formatSimulationReport,
  type SimulationOptions,
} from "../src/testing.js";
import { fixture } from "./simulation-helpers.js";

const registered = { onCompletion: { cell: "outcome", equals: "Registered" } };
const edit = [{ cell: "mode", answer: "Edit" }];

it("sim.preferences revisits the preferred scenario and reports its terminal evidence", async () => {
  const { run, simulator } = fixture(`"arc";function Main(){
    this.trigger=()=>true; let mode=Enum(["New","Edit"]); let ready=Bool(); let extra=Bool(); let outcome=Str();
    $observeOrAsk(mode); $observeOrAsk(ready); $observeOrAsk(extra);
    if(extra){$instruct("Extra work.");}
    if(mode=="Edit" && ready){outcome.$set("Registered");}
  }`);
  const result = await run({
    prefer: edit,
    expect: registered,
    limits: { maxPaths: 3 },
  });
  const verdict = result.expectation;
  expect(verdict?.status).toBe("witnessed");
  if (verdict?.status !== "witnessed") throw new Error("Missing witness");
  const path = await simulator.getPath(verdict.pathId);
  expect(path.finalTraversals[0]!.cells).toMatchObject({
    mode: "Edit",
    ready: true,
    outcome: "Registered",
  });
  expect(verdict.reports).toBe(path.reports);
  const answer = verdict.answers[0]!;
  const step = path.steps.find(
    (step) =>
      step.kind === "action-report" &&
      step.position.index === answer.position.index,
  );
  if (step?.kind !== "action-report") throw new Error("Missing witness report");
  expect(Object.values(step.report.observations ?? {})).toContainEqual({
    status: "resolved",
    value: "Edit",
  });
  const report = formatSimulationReport(result, "fixture", 580);
  expect(report).toContain(
    `Path ${path.id} covered in ${path.reports} reports`,
  );
  expect(report).toContain('Terminal root outcome = "Registered"');
  expect(report).toMatch(/[1-9]\d* comparisons omitted/);
});

it("sim.preferences requires the requested answers and terminal value on one covered path", async () => {
  const { run, simulator } =
    fixture(`"arc";function Main(){this.trigger=()=>true;let mode=Enum(["New","Edit"]);let outcome=Str();
    $observeOrAsk(mode);if(mode=="New"){outcome.$set("Registered");}else{outcome.$set("Local");}}`);
  const result = await run({ prefer: edit, expect: registered });
  expect(result.expectation).toMatchObject({
    status: "not-witnessed",
    preferencesReached: true,
  });
  expect((await run({ expect: registered })).expectation).toMatchObject({
    status: "witnessed",
    actual: "Registered",
    answers: [],
  });
  for (const prefer of [
    [{ cell: "mode", answer: "Missing" }],
    [{ cell: "missing", answer: "Edit" }],
  ]) {
    expect(
      (await run({ prefer, expect: registered })).expectation,
    ).toMatchObject({ status: "not-witnessed", preferencesReached: false });
  }
  const restricted = await run({
    prefer: edit,
    expect: registered,
    accept: (c) =>
      typeof c.answer === "object" && c.answer.value === "Edit"
        ? { accept: false, reason: "excluded" }
        : { accept: true },
  });
  expect(restricted.expectation).toMatchObject({
    status: "not-witnessed",
    preferencesReached: false,
  });
  expect(restricted.preferenceDiagnostics).toMatchObject([
    { cell: "mode", status: "available" },
  ]);
  const pathModes = await Promise.all(
    restricted.paths.map(
      async ({ id }) =>
        (await simulator.getPath(id)).finalTraversals[0]!.cells.mode,
    ),
  );
  expect(pathModes).toContain("New");
  expect(pathModes).not.toContain("Edit");
});

it("sim.preferences distinguishes absent candidates from unreached observations", async () => {
  const { run, simulator } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let x=Str();$observeOrAsk(x);}',
  );
  const result = await run({
    exploration: "exhaustive",
    prefer: [
      { cell: "x", answer: "target" },
      { cell: "missing", answer: "target" },
    ],
    values: () => ({ mode: "replace", label: "only other", values: ["other"] }),
  });
  expect(result.preferenceDiagnostics).toMatchObject([
    {
      cell: "x",
      answer: "target",
      status: "unavailable",
      evidence: { truncated: false },
    },
    { cell: "missing", answer: "target", status: "not-reached" },
  ]);
  expect(result.preferenceDiagnostics[1]).not.toHaveProperty("evidence");
  const evidence = result.preferenceDiagnostics[0]!.evidence!;
  const prefix = await simulator.getPath(evidence.prefixId);
  expect(prefix.outcome.kind).toBe("prefix");
  expect(result.coverage.inputs).toContainEqual(
    expect.objectContaining({
      prefixId: evidence.prefixId,
      site: evidence.site,
    }),
  );
  const report = formatSimulationReport(result, "availability", 4096);
  expect(report).toContain('Preferred answer unavailable: x = "target"');
  expect(report).toContain(
    'Preferred observation not reached: missing = "target"',
  );
  expect(report).toContain(evidence.prefixId);
});

it("sim.preferences ignores candidate availability after the first resolved answer", async () => {
  const { run, simulator } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let x=Bool();$observeOrAsk(x);$observeOrAsk(x);}',
  );
  const result = await run({
    exploration: "exhaustive",
    prefer: [{ cell: "x", answer: true }],
    expect: { onCompletion: { cell: "x", equals: true } },
    values: (_, context) => ({
      mode: "replace",
      label: "first false, then true",
      values: [context.choices.some((c) => c.input.kind === "observation")],
    }),
  });
  expect(result.paths).toHaveLength(1);
  const path = await simulator.getPath(result.paths[0]!.id);
  expect(path.finalTraversals[0]!.cells.x).toBe(true);
  expect(result.expectation).toMatchObject({
    status: "not-witnessed",
    preferencesReached: false,
  });
  expect(result.preferenceDiagnostics[0]).toMatchObject({
    status: "unavailable",
    evidence: { position: { stage: "action", index: 1 } },
  });
});

it("sim.preferences keeps unknown observations eligible for candidate diagnostics", async () => {
  const { run, simulator } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let x=Bool();$observe(x);$observe(x);}',
  );
  const result = await run({
    exploration: "exhaustive",
    prefer: [{ cell: "x", answer: true }],
    expect: { onCompletion: { cell: "x", equals: true } },
    values: (_, context) => ({
      mode: "replace",
      label: "unknown, then true",
      values: context.choices.some((c) => c.input.kind === "observation")
        ? [true]
        : [],
    }),
    accept: (choice, context) =>
      typeof choice.answer === "object" &&
      choice.answer.status === "unknown" &&
      context.choices.some((c) => c.input.kind === "observation")
        ? { accept: false, reason: "second answer is resolved" }
        : { accept: true },
  });
  expect(result.paths).toHaveLength(1);
  expect(result.expectation).toMatchObject({
    status: "witnessed",
    actual: true,
  });
  expect(result.preferenceDiagnostics[0]).toMatchObject({
    status: "available",
    evidence: { position: { stage: "action", index: 2 } },
  });
  const path = await simulator.getPath(result.paths[0]!.id);
  const answers = path.steps.flatMap((step) =>
    step.kind === "action-report"
      ? Object.values(step.report.observations ?? {})
      : [],
  );
  expect(answers).toEqual([
    { status: "unknown" },
    { status: "resolved", value: true },
  ]);
});

it("sim.preferences upgrades availability with evidence from the eligible branch", async () => {
  const { run, simulator } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let branch=Bool();let x=Str();$observeOrAsk(branch);$observeOrAsk(x);}',
  );
  const result = await run({
    exploration: "exhaustive",
    prefer: [{ cell: "x", answer: "target" }],
    expect: { onCompletion: { cell: "x", equals: "target" } },
    values: (input, context) => {
      if (input.kind !== "observation") return undefined;
      const branch = context.choices.find(
        (c) => c.input.kind === "observation" && c.input.cell === "branch",
      );
      return {
        mode: "replace",
        label: "branch-dependent example",
        values:
          input.cell === "branch"
            ? [false, true]
            : [
                typeof branch?.answer === "object" &&
                branch.answer.value === true
                  ? "target"
                  : "other",
              ],
      };
    },
  });
  expect(result.expectation).toMatchObject({
    status: "witnessed",
    actual: "target",
  });
  const diagnostic = result.preferenceDiagnostics[0]!;
  expect(diagnostic.status).toBe("available");
  const prefix = await simulator.getPath(diagnostic.evidence!.prefixId);
  expect(prefix.finalTraversals[0]!.cells.branch).toBe(true);
  expect(prefix.steps.at(-1)).toMatchObject({
    kind: "action-brief",
    position: diagnostic.evidence!.position,
    brief: { observations: [expect.objectContaining({ cell: "x" })] },
  });
});

it("sim.preferences diagnoses preferences removed by candidate truncation", async () => {
  const { run, simulator } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let x=Str();$observeOrAsk(x);}',
  );
  const result = await run({
    prefer: [{ cell: "x", answer: "target" }],
    expect: { onCompletion: { cell: "x", equals: "target" } },
    values: () => ({
      mode: "replace",
      label: "ordered examples",
      values: ["a", "target"],
    }),
    limits: { maxValuesPerInput: 1 },
  });
  expect(result.preferenceDiagnostics[0]).toMatchObject({
    status: "unavailable",
    evidence: { truncated: true },
  });
  expect(result.expectation).toMatchObject({
    status: "not-witnessed",
    preferencesReached: false,
  });
  expect(result.paths).toHaveLength(1);
  const path = await simulator.getPath(result.paths[0]!.id);
  expect(path.finalTraversals[0]!.cells.x).toBe("a");
  expect(
    path.steps.flatMap((step) =>
      step.kind === "action-report"
        ? Object.values(step.report.observations ?? {})
        : [],
    ),
  ).toEqual([{ status: "resolved", value: "a" }]);
  const report = formatSimulationReport(result, "truncated candidates", 4096);
  expect(report).toContain("Candidate generation was truncated");
});

it("sim.preferences retains diagnostic counts and omissions within the report budget", async () => {
  const cells = Array.from({ length: 12 }, (_, i) => `x${i}`);
  const { run } = fixture(`"arc";function Main(){this.trigger=()=>true;
    let ready=Enum(["ready"]);${cells.map((cell) => `let ${cell}=Str();`).join("")}
    $observeOrAsk(ready);${cells.map((cell) => `$observeOrAsk(${cell});`).join("")}}`);
  const result = await run({
    exploration: "exhaustive",
    prefer: [
      { cell: "ready", answer: "ready" },
      ...cells.map((cell) => ({ cell, answer: "target-" + "x".repeat(200) })),
      { cell: "missing", answer: "target" },
    ],
    values: (input) =>
      input.kind === "observation"
        ? {
            mode: "replace",
            label: "single candidate",
            values: [input.cell === "ready" ? "ready" : "other"],
          }
        : undefined,
  });
  const compact = formatSimulationReport(result, "diagnostic budget", 1100);
  expect(Buffer.byteLength(compact)).toBeLessThanOrEqual(1100);
  expect(compact).toContain(
    "Preference availability: 1 available, 12 unavailable, 1 not-reached.",
  );
  expect(compact).toMatch(/[1-9]\d* preference diagnostics omitted/);
  const full = formatSimulationReport(result, "diagnostic budget", 16000);
  expect(full).toContain("0 preference diagnostics omitted.");
  for (const diagnostic of result.preferenceDiagnostics) {
    if (diagnostic.status !== "unavailable") continue;
    const evidence = diagnostic.evidence!;
    const detail = full
      .split("\n")
      .find((line) =>
        line.startsWith(`Preferred answer unavailable: ${diagnostic.cell} =`),
      );
    expect(detail).toContain(evidence.prefixId);
    expect(detail).toContain(evidence.site.sourceRef);
    expect(detail).toContain(
      `[${evidence.position.stage} ${evidence.position.index}]`,
    );
  }
  expect(full).toContain("Preferred observation not reached: missing =");
});

it("sim.preferences keeps the first resolved observation across repeated questions", async () => {
  const { run } =
    fixture(`"arc";function Main(){this.trigger=()=>true;let x=Bool();
    $observe(x);$observe(x);$observe(x);}`);
  const result = await run({
    prefer: [{ cell: "x", answer: true }],
    expect: { onCompletion: { cell: "x", equals: false } },
    accept: (choice, context) => {
      const submitted = context.choices.filter(
        (c) => c.input.kind === "observation",
      ).length;
      const answer = choice.answer;
      const allowed =
        typeof answer === "object" &&
        (submitted === 0
          ? answer.status === "unknown"
          : answer.value === (submitted === 1));
      return allowed
        ? { accept: true }
        : { accept: false, reason: "scenario fixture" };
    },
  });
  expect(result.expectation).toMatchObject({
    status: "witnessed",
    answers: [{ cell: "x", answer: true }],
    actual: false,
  });
});

it("sim.preferences counts grouped answers at a limit and preserves exhaustive alternatives", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let x=Bool();let y=Bool();$observeOrAsk({x,y});$instruct("Finish.");}`,
  );
  const prefer = [
    { cell: "x", answer: true },
    { cell: "y", answer: true },
  ];
  const options = {
    exploration: "exhaustive" as const,
    prefer,
    expect: { onCompletion: { cell: "x", equals: true } },
  };
  const first = await run({ ...options, limits: { maxPaths: 1 } });
  expect(first.expectation).toMatchObject({
    status: "witnessed",
    pathId: first.paths[0]!.id,
  });
  const path = await simulator.getPath(first.paths[0]!.id);
  const reports = path.steps.filter(
    (step) => step.kind === "action-report" || step.kind === "trigger-report",
  );
  const afterGroup =
    reports.findIndex((step) => !!step.report.observations) + 1;
  const limited = await run({
    ...options,
    limits: { maxTotalReports: afterGroup },
  });
  expect(limited.expectation).toMatchObject({
    status: "not-witnessed",
    preferencesReached: true,
  });
  expect(
    limited.unexplored.some((gap) => gap.reason === "maxTotalReports"),
  ).toBe(true);
  for (const prefs of [prefer, []]) {
    const r = await run({ exploration: "exhaustive", prefer: prefs });
    expect(r.expectation).toBeUndefined();
    const pairs = await Promise.all(
      r.paths.map(async (p) => {
        const { x, y } = (await simulator.getPath(p.id)).finalTraversals[0]!
          .cells;
        return [x, y];
      }),
    );
    expect(pairs.sort()).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ]);
  }
});

it("sim.preferences validates and captures inspector inputs at admission", async () => {
  const { run } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let flags=Array(Bool());$observeOrAsk(flags);}`,
  );
  class DerivedArray extends Array<string> {}
  for (const prefer of [
    [...edit, ...edit],
    [{ cell: "  ", answer: true }],
    [{ cell: "mode", answer: [null] }],
    [{ cell: "mode", answer: { nested: new DerivedArray("Edit") } }],
    [{ cell: "mode", answer: "Edit", extra: true }],
  ]) {
    await expect(
      run({ prefer: prefer as SimulationOptions["prefer"] }),
    ).rejects.toThrow();
  }
  await expect(
    run({ expect: { onCompletion: { cell: "mode", equals: Infinity } } }),
  ).rejects.toThrow();
  const prefer = [{ cell: "flags", answer: [true, false] }];
  const expectCell = { onCompletion: { cell: "flags", equals: [true, false] } };
  const pending = run({ prefer, expect: expectCell, limits: { maxPaths: 1 } });
  prefer[0]!.answer.reverse();
  expectCell.onCompletion.equals.pop();
  expect((await pending).expectation).toMatchObject({
    status: "witnessed",
    actual: [true, false],
    answers: [{ cell: "flags", answer: [true, false] }],
  });
});
