import { expect, it } from "vitest";

import { encodeLine, recordBytes } from "../src/service/simulation-trace.js";
import { formatSimulationReport, SimulatorService } from "../src/testing.js";
import { dialog, fixture } from "./simulation-helpers.js";

it("sim.checkout records the five declaration-only paths", async () => {
  const { run, simulator } =
    fixture(`"arc"; import Inventory from "host:inventory";
    function Checkout() {
      this.trigger = () => true;
      let quantity = RangedInt(0, 2);
      $observeOrAsk(quantity);
      if(quantity == 0) { $instruct("Empty."); }
      else { if(Inventory.available(quantity)) { $instruct("Confirm."); } else { $instruct("Shortage."); } }
    }`);
  const result = await run({
    exploration: "exhaustive",
    limits: { maxPaths: 5 },
  });
  expect(result.paths.map((p) => p.outcome.kind)).toEqual(
    Array(5).fill("covered"),
  );
  expect(result.completeness).toEqual({
    domains: "finite-complete",
    exploration: "complete",
  });
  const traces = await Promise.all(
    result.paths.map(async (p) => {
      const path = await simulator.getPath(p.id);
      const rows = path.traceJsonl
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.at(-1).kind).toBe("simulation-end");
      expect(
        rows
          .filter((r) => r.brief)
          .every((r) => Array.isArray(r.brief.traversals)),
      ).toBe(true);
      const quantity = rows.flatMap((r) =>
        Object.values(r.report?.observations ?? {}),
      )[0] as { value: number };
      const call = rows.find((r) => r.brief?.hostCalls?.length);
      const reply = rows.find((r) => r.report?.hostCalls);
      if (call)
        expect(call.brief.hostCalls[0].arguments).toEqual([quantity.value]);
      expect(
        path.checkpoints.at(-1)!.hostModules.calls.map((r) => r.effects.length),
      ).toEqual(call ? [1] : []);
      const instruction = rows.find((r) => r.brief?.instructions?.length);
      return [
        quantity.value,
        reply &&
          Object.values<{ value: boolean }>(reply.report.hostCalls)[0]!.value,
        instruction.brief.instructions[0].text,
      ].join("/");
    }),
  );
  expect(traces.sort()).toEqual([
    "0//Empty.",
    "1/false/Shortage.",
    "1/true/Confirm.",
    "2/false/Shortage.",
    "2/true/Confirm.",
  ]);
});

it("sim.frontiers isolate divergent siblings", async () => {
  const { run, simulator } = fixture(
    `"arc"; import { Child } from "dep";
  function Main(){this.trigger=()=>judge("enter");$enter(newcopy(Child));}`,
    {
      dep: `"arc"; import Inventory from "host:inventory";
  function Child(){let a=Bool();let b=Bool();$observeOrAsk({a,b});if(a && b && Inventory.available(1)){$instruct("Ship.");}else{$instruct("Hold.");}}`,
    },
  );
  const result = await run({ exploration: "exhaustive" });
  expect(
    result.paths.filter((p) => p.outcome.kind === "not-matched"),
  ).toHaveLength(1);
  const covered = result.paths.filter((p) => p.outcome.kind === "covered");
  expect(covered).toHaveLength(5);
  const paths = await Promise.all(covered.map((p) => simulator.getPath(p.id)));
  expect(
    paths.filter((p) =>
      p.steps.some(
        (s) =>
          s.kind === "action-brief" &&
          s.brief.instructions.some((i) => i.text === "Ship."),
      ),
    ),
  ).toHaveLength(1);
  const hosts = paths.filter(
    (p) => p.checkpoints.at(-1)!.hostModules.calls.length,
  );
  expect(
    hosts.map(
      (p) =>
        p.checkpoints.at(-1)!.hostModules.calls[0]!.effects[0]!.hostCallOutcome,
    ),
  ).toEqual(
    expect.arrayContaining([
      { kind: "resolution", value: true },
      { kind: "resolution", value: false },
    ]),
  );
});

it("sim.comparisons pairs surviving siblings when the base path is pruned", async () => {
  const { run } = fixture(`"arc"; function Main() {
    this.trigger = () => true;
    let n = RangedInt(0, 2);
    let blocked = Bool();
    $observeOrAsk(n);
    if (n == 0) { $observeOrAsk(blocked); }
    else if (n == 1) {
      if (judge("Ready?")) { $instruct("Pack."); }
      else { $observeOrAsk(blocked); }
    } else { $instruct("Ship."); }
  }`);
  for (const exploration of ["comparisons", "exhaustive"] as const) {
    const result = await run({
      exploration,
      accept: ({ input }) =>
        input.kind === "observation" && input.cell === "blocked"
          ? { accept: false, reason: "Unavailable" }
          : { accept: true },
    });
    expect(result.paths.map((p) => p.outcome.kind)).toEqual([
      "covered",
      "covered",
    ]);
    expect(result.comparisons).toHaveLength(1);
    const [pair] = result.comparisons;
    expect(pair!.sharedPrefixId).toBe(result.coverage.inputs[0]!.prefixId);
    expect(pair!.decisions.map((d) => d.input)).toMatchObject([{ cell: "n" }]);
    expect(
      [pair!.left, pair!.right].map((side) => side.work[0]?.excerpt).sort(),
    ).toEqual(["Pack.", "Ship."]);
  }
});

it("sim.comparisons bounds variations across sequential questions", async () => {
  const actions = Array.from(
    { length: 20 },
    (_, i) => `if(judge("question ${i}")){}`,
  ).join("\n");
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;${actions}$instruct("Done.");}`,
  );
  const result = await run();
  expect(result.paths).toHaveLength(21);
  expect(result.completeness.exploration).toBe("sampled");
  const rows = await Promise.all(
    result.paths.map(async (p) =>
      (await simulator.getPath(p.id)).steps.flatMap((s) =>
        s.kind === "action-report"
          ? Object.values(s.report.judgments ?? {})
          : [],
      ),
    ),
  );
  expect(new Set(rows.map((row) => JSON.stringify(row))).size).toBe(21);
  expect(
    rows
      .filter((row) => row.some(Boolean))
      .every((row) => row.filter(Boolean).length === 1),
  ).toBe(true);
});

it("sim.comparisons varies each judgment site that asks the same question", async () => {
  const { run } = fixture(`"arc"; function Main(){
    this.trigger=()=>true;
    let premium=Bool(); $observeOrAsk(premium);
    if(premium){
      if(judge("Approved?")){$instruct("Premium approved");}else{$instruct("Premium rejected");}
    }else{
      if(judge("Approved?")){$instruct("Basic approved");}else{$instruct("Basic rejected");}
    }
  }`);
  const result = await run();
  const approvals = result.comparisons.filter(
    (c) =>
      c.decisions.length === 1 && c.decisions[0]!.input.kind === "judgment",
  );
  expect(
    approvals
      .map((c) => [c.left.work[0]?.excerpt, c.right.work[0]?.excerpt])
      .sort(),
  ).toEqual([
    ["Basic rejected", "Basic approved"],
    ["Premium rejected", "Premium approved"],
  ]);
  expect(approvals.map((c) => c.decisions[0]!.occurrence)).toEqual([1, 1]);
  expect(
    new Set(approvals.map((c) => c.decisions[0]!.input.site.briefId)).size,
  ).toBe(2);
});

it("sim.comparisons tries a shared decision on both routes after different work", async () => {
  const { run, simulator } = fixture(`"arc"; function Main(){
    this.trigger=()=>true;
    if(judge("Amend an existing draft?")){$instruct("Amend.");}else{$instruct("Create.");}
    $instruct("Validate.");
    if(judge("Valid?")){$instruct("Review.");}else{$instruct("Repair.");}
  }`);
  const result = await run({ limits: { maxPaths: 4 } });
  const routes = [];
  for (const leaf of result.paths) {
    const path = await simulator.getPath(leaf.id);
    routes.push(
      path.steps
        .flatMap((step) =>
          step.kind === "action-brief"
            ? step.brief.instructions
                .filter((i) => i.phase === "apply")
                .map((i) => i.text)
            : [],
        )
        .join(" "),
    );
  }
  expect(routes.sort()).toEqual([
    "Amend. Validate. Repair.",
    "Amend. Validate. Review.",
    "Create. Validate. Repair.",
    "Create. Validate. Review.",
  ]);
});

it("sim.comparisons distinguishes host arguments before a shared decision", async () => {
  const { run } =
    fixture(`"arc"; import Inventory from "host:inventory"; function Main(){
    this.trigger=()=>true;
    let item=RangedInt(1,2); $observeOrAsk(item);
    Inventory.$available(item);
    if(judge("Dispatch?")){$instruct("Send.");}else{$instruct("Hold.");}
  }`);
  const result = await run({
    limits: { maxPaths: 4 },
    values: (input) =>
      input.kind === "host-call"
        ? { mode: "replace", label: "available", values: [true] }
        : undefined,
  });
  const dispatches = result.comparisons.filter((pair) =>
    pair.decisions.some(
      ({ input }) =>
        input.kind === "judgment" && input.brief.question === "Dispatch?",
    ),
  );
  expect(
    dispatches
      .map(
        (pair) =>
          pair.context.find((event) =>
            event.excerpt.startsWith("inventory.available("),
          )?.excerpt,
      )
      .sort(),
  ).toEqual(["inventory.available(1)", "inventory.available(2)"]);
});

it("sim.comparisons exercises a new decision and an older alternative within the path budget", async () => {
  for (const pass of [true, false]) {
    const { run, simulator } = fixture(`"arc"; function Main(){
      this.trigger=()=>true;
      if(judge("Earlier decision?")){$instruct("Earlier alternative.");}
      if(judge("Another decision?")){}
      if(judge("Another pending decision?")){}
      let ready=Bool(); $observe(ready);
      if(ready == ${pass}){$instruct("Later stage.");}else{$instruct("Retry.");}
    }`);
    const result = await run({ limits: { maxPaths: 3 } });
    const work = new Set<string>();
    const answers = new Set<boolean>();
    for (const path of result.paths) {
      for (const step of (await simulator.getPath(path.id)).steps) {
        if (step.kind === "action-brief")
          for (const instruction of step.brief.instructions)
            if (typeof instruction.text === "string")
              work.add(instruction.text);
        if (step.kind === "action-report") {
          for (const answer of Object.values(step.report.observations ?? {}))
            if ("value" in answer && typeof answer.value === "boolean")
              answers.add(answer.value);
        }
      }
    }
    expect(answers).toEqual(new Set([true, false]));
    expect(work).toEqual(
      new Set(["Later stage.", "Retry.", "Earlier alternative."]),
    );
  }
});

it("sim.comparisons lets pending alternatives advance while a path repeats a decision", async () => {
  const { run, simulator } = fixture(`"arc"; function Main(){
    this.trigger=()=>true;
    if(judge("Use the other route?")){$instruct("Other route.");}
    else{$instructLoop("Try.", {resolveWhen:()=>judge("Done?")});}
  }`);
  const result = await run({
    limits: { maxTotalReports: 16, maxReportsPerPath: 200 },
  });
  const paths = await Promise.all(
    result.paths
      .filter((p) => p.outcome.kind === "covered")
      .map((p) => simulator.getPath(p.id)),
  );
  const work = paths.map((p) =>
    p.steps.flatMap((s) =>
      s.kind === "action-brief" ? s.brief.instructions.map((i) => i.text) : [],
    ),
  );
  expect(work.some((path) => path.includes("Other route."))).toBe(true);
  expect(work.some((path) => path.includes("Try."))).toBe(true);
});

it("sim.comparisons keeps a recurring judgment stable and explores its alternative", async () => {
  const { run, simulator } = fixture(`"arc"; function Main(){
    this.trigger=()=>true;
    let count=Num(); count.$set(0);
    $enterLoop(newcopy(Step),{resolveWhen:()=>count == 2});
    function Step(){
      $instruct("Work.",{deflectWhen:()=>judge("Cancel?")});
      count.$set(count+1);
    }
  }`);
  const secondAnswers: boolean[] = [];
  const result = await run({
    accept: (choice) => {
      if (typeof choice.answer === "boolean" && choice.occurrence === 2)
        secondAnswers.push(choice.answer);
      return { accept: true };
    },
  });
  expect(secondAnswers[0]).toBe(false);
  const outcomes = new Map<string, string>();
  for (const leaf of result.paths) {
    const path = await simulator.getPath(leaf.id);
    const answers = path.steps.flatMap((step) =>
      step.kind === "action-report"
        ? Object.values(step.report.judgments ?? {})
        : [],
    );
    outcomes.set(answers.join(","), leaf.outcome.kind);
  }
  expect(outcomes.get("false,false")).toBe("covered");
  expect(outcomes.get("false,true")).toBe("deflected");
});

it("sim.comparisons surfaces the second verification decision", async () => {
  const { run } = fixture(`"arc"; function Research() {
    this.trigger = () => true;
    let formatValid = Bool();
    $enter(VerifyGate);
    if (formatValid != true) {
      $instruct("Rewrite the report.");
      $enter(forgetful(VerifyGate));
    }
    $instruct("Report complete.");

    function VerifyGate() {
      $instruct("Verify the report format.");
      this.effects = () => { $observe(formatValid); };
    }
  }`);
  const result = await run();
  const pair = result.comparisons.find((c) =>
    c.decisions.some(
      (d) =>
        d.input.kind === "observation" &&
        d.input.cell === "formatValid" &&
        d.occurrence === 2 &&
        new Set([
          d.left.excerpt.split(" → ").at(-1),
          d.right.excerpt.split(" → ").at(-1),
        ]).has("true") &&
        [d.left.excerpt, d.right.excerpt].some((e) => e.endsWith(" → false")),
    ),
  );
  expect(pair).toBeDefined();
  for (const side of [pair!.left, pair!.right]) {
    expect(side.outcome.kind).toBe("covered");
    expect(side.work.map((e) => e.excerpt).join(" ")).toMatch(/complete/i);
  }
  expect(pair!.context.some((e) => /revis|rewrite/i.test(e.excerpt))).toBe(
    true,
  );
  const text = formatSimulationReport(result, "Research", 4096);
  expect(text).toContain(pair!.left.pathId);
  expect(text).toContain(pair!.right.pathId);
  expect(text).toContain("occurrence 2");
  expect(text).toMatch(/complete/i);
}, 30_000);

it("sim.loop retains continued and resolved paths at the bound", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;$instructLoop("Apply.",{resolveWhen:()=>judge("done?")});}`,
  );
  const result = await run({
    exploration: "exhaustive",
    limits: { maxReportsPerPath: 3 },
  });
  expect(result.paths.map((p) => [p.outcome.kind, p.reports])).toEqual(
    expect.arrayContaining([
      ["covered", 2],
      ["limit", 3],
    ]),
  );
  expect(result.paths).toHaveLength(2);
  const limited = await simulator.getPath(
    result.paths.find((p) => p.outcome.kind === "limit")!.id,
  );
  expect(
    limited.steps.filter(
      (s) => s.kind === "action-report" && s.report.instructions,
    ),
  ).toHaveLength(2);
});

it("sim.deflection records acknowledgement catch and effects", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true; let done=Bool();this.effects=()=>{done.$set(this.pendingState==State.COVERED);};this.catchDeflection=()=>judge("catch?");$instruct("Apply.",{deflectWhen:()=>judge("leave?")});}`,
  );
  const result = await run({ exploration: "exhaustive" });
  expect(result.paths.map((p) => p.outcome.kind).sort()).toEqual([
    "covered",
    "covered",
    "deflected",
  ]);
  const paths = await Promise.all(
    result.paths.map((p) => simulator.getPath(p.id)),
  );
  expect(
    paths.filter((p) =>
      p.steps.some(
        (s) => s.kind === "action-report" && s.report.move === "deflect",
      ),
    ),
  ).toHaveLength(2);
  for (const path of paths)
    expect(Object.values(path.finalTraversals[0]!.cells)).toContain(
      path.outcome.kind === "covered",
    );
});

it("sim.comparisons revisits unknown when the prior value changes", async () => {
  const { run } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let prior=Bool();let approved=Bool();$observeOrAsk(prior);approved.$set(prior);$observe(approved);if(approved){$instruct("Ship");}else{$instruct("Hold");}}`,
  );
  const result = await run();
  const pairs = result.comparisons.filter((c) =>
    c.decisions.some(
      (d) =>
        d.input.kind === "observation" &&
        d.input.cell === "approved" &&
        d.right.excerpt.includes("unknown"),
    ),
  );
  expect(pairs.map((p) => p.right.work[0]?.excerpt).sort()).toEqual([
    "Hold",
    "Ship",
  ]);
});

function group(n: number) {
  const controls = Array.from({ length: n }, (_, i) =>
    Array.from({ length: 7 }, (_, j) => `v${i}_${j}`),
  );
  return fixture(
    `"arc";function Main(){this.trigger=()=>true;${controls
      .flat()
      .map((v) => "let " + v + "=Bool();")
      .join(
        "",
      )}${controls.map((names) => "$observe({" + names.join(",") + "});").join("")}$instruct("Done.");}`,
  );
}

it("sim.comparisons shares pair targets across sequential groups", async () => {
  const control = await group(1).run({ limits: { maxPaths: 128 } });
  expect(control.coverage.groups[0]!.valuePairsExercised).toBe(189);
  const result = await group(2).run({ limits: { maxPaths: 128 } });
  expect(result.paths.length).toBeLessThanOrEqual(2 * control.paths.length - 1);
  expect(result.coverage.groups.some((g) => g.valuePairsExercised === 21)).toBe(
    true,
  );
  expect(result.completeness.exploration).toBe("sampled");
});

it("sim.comparisons bounds grouped interaction sampling", async () => {
  const { run, simulator } = group(1);
  const result = await run({ limits: { maxPaths: 128 } });
  expect(result.paths.length).toBeLessThan(128);
  expect(result.coverage.groups[0]).toMatchObject({
    fieldPairs: 21,
    valuePairsExercised: 189,
    valuePairsInGeneratedDomains: 189,
  });
  const pairs = new Set<string>();
  for (const p of result.paths) {
    const path = await simulator.getPath(p.id);
    const row = path.steps.find(
      (s) => s.kind === "action-report" && s.report.observations,
    );
    if (row?.kind !== "action-report") throw new Error("No group report");
    const report = Object.values(row.report.observations!)[0]!;
    if (!("fields" in report)) throw new Error("Incomplete group report");
    const fields = Object.entries(report.fields);
    for (const [i, a] of fields.entries())
      for (const b of fields.slice(i + 1)) pairs.add(JSON.stringify([a, b]));
  }
  expect(pairs.size).toBe(189);
  const partial = await run({ limits: { maxPaths: 2 } });
  expect(partial.coverage.groups[0]!.valuePairsExercised).toBeLessThan(189);
  expect(partial.unexplored.length).toBeGreaterThan(0);
});

it("sim.coverage reports complete exploration when comparisons examine every generated tuple", async () => {
  const { run } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let a=Bool();let b=Bool();let c=Bool();$observeOrAsk({a,b,c});}',
  );
  const restricted = await run({
    values: (input) =>
      input.kind === "observation" && input.cell === "c"
        ? { mode: "replace", values: [true], label: "fixed" }
        : undefined,
  });
  expect(restricted.paths).toHaveLength(4);
  expect(restricted.completeness).toEqual({
    domains: "restricted",
    exploration: "complete",
  });
  const full = await run();
  expect(full.coverage.groups[0]).toMatchObject({
    valuePairsExercised: 12,
    valuePairsInGeneratedDomains: 12,
  });
  expect(full.paths.length).toBeLessThan(8);
  expect(full.completeness.exploration).toBe("sampled");
});

it("sim.comparisons revisits a group when unknown retains a different value", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let seed=Bool();let a=Bool();let b=Bool();let c=Bool();$observeOrAsk(seed);a.$set(seed);$observe({a,b,c});}`,
  );
  const result = await run();
  const seen = new Set<boolean>();
  for (const p of result.paths) {
    const reports = (await simulator.getPath(p.id)).steps.flatMap((s) =>
      s.kind === "action-report"
        ? Object.values(s.report.observations ?? {})
        : [],
    );
    const [seed, group] = reports;
    if (
      group &&
      "fields" in group &&
      group.fields.a?.status === "unknown" &&
      group.fields.b?.status === "resolved" &&
      group.fields.b.value === true &&
      seed &&
      "status" in seed &&
      seed.status === "resolved" &&
      typeof seed.value === "boolean"
    )
      seen.add(seed.value);
  }
  expect([...seen].sort()).toEqual([false, true]);
});

it("sim.dialog records caller-controlled progression", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let answer=Bool();$observeOrAsk(answer);$instruct("Finish.");}`,
  );
  const result = await run({
    dialog: (c) => ({
      lastTurns: [],
      cursor: { user: c.choices.length, self: 0 },
      view: c.choices.length
        ? JSON.stringify(c.choices.at(-1)!.answer)
        : "start",
    }),
  });
  const p = await simulator.getPath(result.paths[0]!.id);
  expect(p.steps[0]!.dialog.view).toBe("start");
  expect(
    result.comparisons[0]?.additionalDifferences.some((e) =>
      e.excerpt.includes("Dialog"),
    ),
  ).toBe(true);
});

it("sim.comparisons separates isolated and mixed changes", async () => {
  const { run } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let note=Bool();let approved=Bool();let paid=Bool();$observeOrAsk({note,approved,paid});if(approved&&paid){$instruct("Ship");}else{$instruct("Hold");}}`,
  );
  const r = await run();
  expect(
    r.comparisons.some(
      (c) =>
        c.left.work[0]?.excerpt === "Hold" &&
        c.right.work[0]?.excerpt === "Ship" &&
        c.decisions.length === 2 &&
        c.decisions.every(
          (d) => d.input.kind === "observation" && d.input.cell !== "note",
        ),
    ),
  ).toBe(true);
  const follow = fixture(
    `"arc";function Main(){this.trigger=()=>true;let approved=Bool();let paid=Bool();$observeOrAsk({approved,paid});if(approved&&paid){if(judge("pack?")){}$instruct("Ship");}else{$instruct("Hold");}}`,
  );
  const withFollow = await follow.run();
  expect(
    withFollow.comparisons.some((c) =>
      c.additionalDifferences.some((e) => e.excerpt.includes("pack?")),
    ),
  ).toBe(true);
});

it("sim.comparisons preserves effective instruction host parameters when simplifying", async () => {
  const { run, simulator } = fixture(`"arc"; function Main(){
    this.trigger=()=>true; this.hostParams={workerRole:"operator"};
    let a=Bool(); let b=Bool(); $observeOrAsk({a,b});
    if(a && b){$instruct("Deliver",{hostParams:{tools:["publish"]}});}
    else if(a){$instruct("Deliver",{hostParams:{tools:["review"]}});}
    else{$instruct("Hold");}
  }`);
  const result = await run();
  const mixed = result.comparisons.find(
    (c) => c.decisions.length === 2 && c.right.work[0]?.excerpt === "Deliver",
  );
  expect(mixed).toBeDefined();
  const path = await simulator.getPath(mixed!.right.pathId);
  const delivered = path.steps.flatMap((s) =>
    s.kind === "action-brief" ? s.brief.instructions : [],
  );
  expect(delivered.map((i) => i.hostParams)).toEqual([
    { workerRole: "operator", tools: ["publish"] },
  ]);
  expect(mixed!.right.work[0]!.instruction).toMatchObject({
    text: "Deliver",
    hostParams: delivered[0]!.hostParams,
  });
  const report = formatSimulationReport(result, "Delivery", 4096);
  expect(report).toContain("publish");
  expect(report).toContain("review");
});

it("sim.comparisons retains the original pair at a simplification limit", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let note=Bool();let approved=Bool();let paid=Bool();$observeOrAsk({note,approved,paid});if(approved&&paid){$instruct("Ship");}else{$instruct("Hold");}}`,
  );
  for (const cap of [10, 12]) {
    const limited = await run({ limits: { maxTotalReports: cap } });
    const pair = limited.comparisons.find(
      (c) =>
        c.simplificationLimit === "maxTotalReports" && c.decisions.length === 3,
    )!;
    expect(limited.completeness.exploration).toBe("limited");
    expect([pair.left.work[0]?.excerpt, pair.right.work[0]?.excerpt]).toEqual([
      "Hold",
      "Ship",
    ]);
    const text = formatSimulationReport(limited, "Shipping", 16000);
    for (const side of [pair.left, pair.right]) {
      expect(text).toContain(side.pathId);
      expect((await simulator.getPath(side.pathId)).outcome.kind).toBe(
        "covered",
      );
    }
    expect(text).toContain("Simplification stopped at maxTotalReports");
  }
});

it("sim.instruct does not promise its requested outcome", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;$instruct("Make it ready");let ready=Bool();$observeOrAsk(ready);if(ready){$instruct("Ship");}else{$instruct("Hold");}}`,
  );
  const result = await run({ exploration: "exhaustive" });
  expect(result.paths).toHaveLength(2);
  for (const leaf of result.paths) {
    const path = await simulator.getPath(leaf.id);
    const apply = path.steps.findIndex(
      (s) => s.kind === "action-report" && !!s.report.instructions,
    );
    const observation = path.steps.findIndex(
      (s) => s.kind === "action-report" && !!s.report.observations,
    );
    expect(apply).toBeGreaterThan(0);
    expect(observation).toBeGreaterThan(apply);
  }
});

it("sim.group preserves complete atomic report alternatives", async () => {
  for (const [operation, paths] of [
    ["$observe", 9],
    ["$observeOrAsk", 4],
  ] as const) {
    const { run, simulator } = fixture(
      `"arc";function Main(){this.trigger=()=>true;let a=Bool();let b=Bool();${operation}({a,b});}`,
    );
    const result = await run({ exploration: "exhaustive" });
    expect(result.paths).toHaveLength(paths);
    for (const p of result.paths) {
      const reports = (await simulator.getPath(p.id)).steps.filter(
        (s) => s.kind === "action-report",
      );
      expect(reports).toHaveLength(1);
      expect(Object.values(reports[0]!.report.observations!)[0]).toMatchObject({
        fields: { a: expect.anything(), b: expect.anything() },
      });
    }
  }
});

it("sim.comparisons counts work that remains pending across briefs", async () => {
  const { run, simulator } = fixture(
    `"arc";import Inventory from "host:inventory";function Main(){this.trigger=()=>true; $instructLoop("Apply", {deflectWhen:()=>Inventory.available(1),resolveWhen:()=>Inventory.available(2)});if(Inventory.available(2)){} }`,
  );
  const result = await run({ limits: { maxReportsPerPath: 8 } });
  const paths = await Promise.all(
    result.paths.map((p) => simulator.getPath(p.id)),
  );
  const path = paths.find(
    (p) =>
      p.outcome.kind === "covered" &&
      p.steps.some(
        (s) => s.kind === "action-brief" && s.brief.hostCalls.length === 2,
      ),
  );
  expect(path).toBeDefined();
  const calls = path!.checkpoints.at(-1)!.hostModules.calls;
  expect(calls.filter((c) => c.call.arguments[0] === 2)).toHaveLength(2);
  const appearances = path!.steps.filter(
    (s) =>
      s.kind === "action-brief" &&
      s.brief.hostCalls.some((c) => c.arguments[0] === 2),
  );
  expect(appearances.length).toBeGreaterThan(2);
  const pair = result.comparisons.find(
    (c) => c.left.pathId === path!.id || c.right.pathId === path!.id,
  )!;
  const side = pair.left.pathId === path!.id ? pair.left : pair.right;
  expect(
    [...pair.context, ...side.work].filter(
      (e) => e.excerpt === "inventory.available(2)",
    ),
  ).toHaveLength(2);
});

it("sim.comparisons renders each host invocation once in a single-path report", async () => {
  const { run, simulator } = fixture(
    '"arc";import Inventory from "host:inventory";function Main(){this.trigger=()=>true;$instructLoop("Apply", {deflectWhen:()=>Inventory.available(1),resolveWhen:()=>Inventory.available(2)});if(Inventory.available(2)){} }',
  );
  const result = await run({
    values: (input) =>
      input.kind === "host-call"
        ? {
            mode: "replace",
            label: "outcome",
            values: [input.brief.arguments[0] === 2],
          }
        : undefined,
  });
  expect(result.paths).toHaveLength(1);
  const path = await simulator.getPath(result.paths[0]!.id);
  const report = formatSimulationReport(result, "Host actions", 4096, path);
  expect(report.match(/inventory\.available\([^)]*\)/g)).toEqual([
    "inventory.available(1)",
    "inventory.available(2)",
    "inventory.available(2)",
  ]);
});

it("sim.comparisons distinguishes string payloads from Boolean answers in reports", async () => {
  const { run } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let result=Union([Bool(),Str()]);$observeOrAsk(result);if(result==true){$instruct("Boolean");}else{$instruct("String");}}',
  );
  const result = await run({
    values: () => ({ mode: "replace", label: "typed", values: [true, "true"] }),
  });
  const report = formatSimulationReport(result, "Typed answers", 4096);
  expect(report).toContain("observe result → true");
  expect(report).toContain('observe result → "true"');
});

it("sim.lifecycle releases identifiers and captured definitions", async () => {
  const { run, simulator } = fixture(
    '"arc";function Main(){this.trigger=()=>true;}',
  );
  const first = await run(),
    second = await run();
  await simulator.release(first.id);
  await expect(simulator.getPath(first.paths[0]!.id)).rejects.toThrow();
  expect((await simulator.getPath(second.paths[0]!.id)).outcome.kind).toBe(
    "covered",
  );
  await simulator.stop();
  await expect(run()).rejects.toThrow(/stopped/i);
});

it("sim.limits preserve unexplored prefixes", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let a=Bool();let b=Bool();$observeOrAsk({a,b});$instruct("Done");}`,
  );
  const result = await run({
    exploration: "exhaustive",
    limits: { maxPaths: 2 },
  });
  expect(result.completeness.exploration).toBe("limited");
  expect(result.paths).toHaveLength(2);
  expect(result.unexplored[0]?.remainingAlternatives).toBe("2");
  const prefix = await simulator.getPath(result.unexplored[0]!.prefixId);
  expect(prefix.outcome.kind).toBe("prefix");
  const rejected = await run({
    exploration: "exhaustive",
    accept: () => ({ accept: false, reason: "unavailable" }),
    limits: { maxCandidateCombinations: 2 },
  });
  expect(rejected.exclusions[0]?.count).toBe(2);
  expect(rejected.unexplored[0]?.reason).toBe("maxCandidateCombinations");
  const { run: nested } = fixture(
    `"arc";function Main(){this.trigger=()=>true;if(judge("a")){}if(judge("b")){}if(judge("c")){}}`,
  );
  const queue = await nested({
    exploration: "exhaustive",
    limits: { maxPendingPrefixes: 1 },
  });
  expect(queue.unexplored.some((p) => p.reason === "maxPendingPrefixes")).toBe(
    true,
  );
  const bytes = await nested({ limits: { maxRecordBytes: 6000 } });
  expect(bytes.unexplored.some((p) => p.reason === "maxRecordBytes")).toBe(
    true,
  );
});

it("sim.limits counts exact UTF-8 bytes for nested unset fields and authored keys", () => {
  const fields = {
    unsetPaths: "authored",
    "10": undefined,
    "1": null,
    "💡": [undefined, , null],
    '"\\': "é\n",
  };
  const reversed = Object.fromEntries(Object.entries(fields).reverse());
  for (const record of [
    { fields },
    { fields: reversed },
    {},
    { unsetPaths: fields },
    { data: [null, {}, []] },
  ]) {
    expect(recordBytes(record)).toBe(Buffer.byteLength(encodeLine(record)));
  }
  expect(encodeLine({ fields })).toBe(encodeLine({ fields: reversed }));
  expect(Object.hasOwn(fields, "10")).toBe(true);
  expect(fields["10"]).toBeUndefined();
});

it("sim.limits accounts for distinct exclusion reasons within the record budget", async () => {
  const { run, simulator } = fixture(
    '"arc"; function Main(){this.trigger=()=>judge("Start?");}',
  );
  const maxRecordBytes = 16 * 1024;
  const reject = (reason: string) =>
    run({
      exploration: "exhaustive",
      limits: { maxRecordBytes },
      accept: () => ({ accept: false, reason }),
    });
  const reason = "x".repeat(9 * 1024);
  const repeated = await reject(reason);
  expect(repeated.exclusions).toMatchObject([{ reason, count: 2 }]);
  expect(repeated.unexplored).toEqual([]);

  const limited = await reject("x".repeat(100_000));
  expect(limited.exclusions).toEqual([]);
  expect(limited.completeness.exploration).toBe("limited");
  const prefixId = limited.coverage.inputs[0]!.prefixId;
  expect(limited.unexplored).toEqual([{ prefixId, reason: "maxRecordBytes" }]);
  expect((await simulator.getPath(prefixId)).outcome.kind).toBe("limit");
});

it("sim.limits charges each constrained tuple once at its frontier", async () => {
  const { run } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let a=Bool();let b=Bool();$observeOrAsk({a,b});}',
  );
  const attempted: boolean[][] = [];
  const result = await run({
    limits: { maxCandidateCombinations: 4 },
    accept: (choice, context) => {
      if (choice.input.kind !== "observation" || choice.input.cell !== "b")
        return { accept: true };
      const values = [context.choices.at(-1)!, choice].map(
        (c) => typeof c.answer === "object" && c.answer.value === true,
      );
      attempted.push(values);
      return values.every(Boolean)
        ? { accept: true }
        : { accept: false, reason: "requires both" };
    },
  });
  expect(attempted).toEqual([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]);
  expect(result.exclusions).toMatchObject([
    { reason: "requires both", count: 3 },
  ]);
  expect(result.paths.map((p) => p.outcome.kind)).toEqual(["covered"]);
  expect(result.completeness.exploration).toBe("complete");
  expect(result.unexplored).toEqual([]);
});

it("sim.limits reuses tuple admission when rerunning a comparison", async () => {
  const { run } = fixture(
    '"arc";function Main(){this.trigger=()=>true;let a=Bool();let b=Bool();$observeOrAsk({a,b});if(a){$instruct("Deliver");}else{$instruct("Hold");}}',
  );
  for (const requireEqual of [true, false]) {
    const examined: string[] = [];
    const result = await run({
      limits: { maxCandidateCombinations: 4 },
      accept: (choice, context) => {
        if (choice.input.kind !== "observation" || choice.input.cell !== "b")
          return { accept: true };
        const [a, b] = [context.choices.at(-1)!, choice].map(
          (c) => typeof c.answer === "object" && c.answer.value === true,
        );
        examined.push(`${a}/${b}`);
        return !requireEqual || a === b
          ? { accept: true }
          : { accept: false, reason: "unequal" };
      },
    });
    expect(examined).toHaveLength(4);
    expect(new Set(examined).size).toBe(4);
    expect(result.exclusions.map((e) => e.count)).toEqual(
      requireEqual ? [2] : [],
    );
    expect(result.completeness.exploration).toBe("complete");
    const delivery = result.comparisons.filter(
      (c) => c.right.work[0]?.excerpt === "Deliver",
    );
    expect(delivery.length).toBeGreaterThan(0);
    expect(
      delivery.every((c) => c.decisions.length === (requireEqual ? 2 : 1)),
    ).toBe(true);
  }
});

it("sim.limits counts unsubmitted alternatives at the active exhaustive frontier", async () => {
  const { run } = fixture(
    '"arc"; function Main(){this.trigger=()=>true;if(judge("First?")){}if(judge("Second?")){}}',
  );
  for (const limit of [
    "maxTotalReports",
    "maxCandidateCombinations",
  ] as const) {
    const result = await run({
      exploration: "exhaustive",
      limits: { [limit]: 1 },
    });
    const [first, second] = result.coverage.inputs;
    expect(result.unexplored).toEqual(
      expect.arrayContaining([
        {
          prefixId: first!.prefixId,
          reason: limit,
          remainingAlternatives: "1",
        },
        {
          prefixId: second!.prefixId,
          reason: limit,
          remainingAlternatives: "2",
        },
      ]),
    );
  }
});

it("sim.host enumerates declared returns when ignored", async () => {
  const { run, simulator } = fixture(
    `"arc";import Inventory from "host:inventory";function Main(){this.trigger=()=>true;Inventory.$available(1);$instruct("Finish");}`,
  );
  const r = await run({ exploration: "exhaustive" });
  expect(r.paths.map((p) => p.outcome.kind)).toEqual(["covered", "covered"]);
  const values = await Promise.all(
    r.paths.map(
      async (p) =>
        (await simulator.getPath(p.id)).checkpoints.at(-1)!.hostModules
          .calls[0]!.effects[0]!.hostCallOutcome,
    ),
  );
  expect(values).toEqual([
    { kind: "resolution", value: false },
    { kind: "resolution", value: true },
  ]);
});

it("sim.audit exposes paths without invoking replay", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;$instruct("First\\nline");let answer=Bool();$observeOrAsk(answer);}`,
  );
  const r = await run({ exploration: "exhaustive" });
  const original = await simulator.getPath(r.paths[0]!.id);
  const lines = original.traceJsonl
    .trimEnd()
    .split("\n")
    .map((s) => JSON.parse(s));
  expect(
    lines.filter((l) => l.kind === "action-report").map((l) => l.report),
  ).toEqual([
    expect.objectContaining({
      instructions: expect.any(Object),
      move: "proceed",
    }),
    expect.objectContaining({
      observations: expect.any(Object),
      move: "proceed",
    }),
  ]);
  expect(
    lines.find((l) => l.brief?.instructions?.length).brief.instructions[0].text,
  ).toBe("First\nline");
  expect(lines.findIndex((l) => l.report?.instructions)).toBeLessThan(
    lines.findIndex((l) => l.report?.observations),
  );
  const last = lines.at(-1);
  expect(last).toMatchObject({
    kind: "simulation-end",
    outcome: { kind: "covered" },
  });
  expect(original.checkpoints.slice(0, 2).map((c) => c.position.index)).toEqual(
    [0, 1],
  );
  const firstAction = original.steps.find((s) => s.kind === "action-brief")!;
  const checkpoint = original.checkpoints.find(
    (c) => c.position.index === firstAction.position.index,
  )!;
  expect(original.traceJsonl.split("\n")).toContain(
    encodeLine({
      kind: firstAction.kind,
      position: firstAction.position,
      dialog: firstAction.dialog,
      brief: { ...firstAction.brief, traversals: checkpoint.traversals },
    }),
  );
  original.finalTraversals.length = 0;
  original.checkpoints[0]!.traversals.length = 0;
  const reread = await simulator.getPath(original.id);
  expect(reread.finalTraversals.length).toBeGreaterThan(0);
  expect(reread.checkpoints[0]!.traversals).toStrictEqual(
    (await simulator.getPath(r.paths[1]!.id)).checkpoints[0]!.traversals,
  );
  expect(reread.checkpoints[0]!.traversals.length).toBeGreaterThan(0);
  original.steps[0]!.dialog.lastTurns.push({
    role: "self",
    message: "outside",
  });
  expect(r.paths).toHaveLength(2);
  for (const path of r.paths) {
    const retained = await simulator.getPath(path.id);
    expect(retained.steps[0]!.dialog.lastTurns).toEqual([]);
    expect(
      JSON.parse(retained.traceJsonl.split("\n")[0]!).dialog.lastTurns,
    ).toEqual([]);
  }
});

it("sim.host captures independent successful outcomes", async () => {
  const text = `"arc";import Inventory from "host:inventory";function Main(){this.trigger=()=>true;Inventory.$write();if(Inventory.available(1)){$instruct("yes");}}`;
  const { run, simulator } = fixture(text);
  const r = await run({ exploration: "exhaustive" });
  expect(r.paths).toHaveLength(2);
  for (const p of r.paths) {
    const path = await simulator.getPath(p.id);
    expect(
      path.checkpoints
        .at(-1)!
        .hostModules.calls.map((c) => [
          c.call.operation,
          c.acknowledged,
          c.effects.length,
        ]),
    ).toEqual([
      ["write", true, 1],
      ["available", true, 1],
    ]);
  }
});

it("sim.comparisons preserves a missing gate and work order", async () => {
  const { run } = fixture(
    `"arc";import Inventory from "host:inventory";function Main(){this.trigger=()=>true;let paid=Bool();let approved=Bool();let blocked=Bool();$observeOrAsk({paid,approved,blocked});if(paid&&!blocked){$instruct("Ship");Inventory.$available(1);$instruct("Confirm");}else{if(blocked){$instruct("Confirm");Inventory.$available(2);$instruct("Ship");}}}`,
  );
  const paid = await run({
    values: (input) =>
      input.kind === "observation" && input.cell === "paid"
        ? { mode: "replace", label: "paid", values: [true] }
        : undefined,
  });
  const missing = paid.comparisons.find(
    (c) =>
      c.decisions.length === 1 &&
      c.decisions[0]!.input.kind === "observation" &&
      c.decisions[0]!.input.cell === "approved",
  )!;
  const order = (events: typeof missing.left.work) =>
    events.map((e) => e.excerpt);
  expect(order(missing.left.work)).toEqual([
    "Ship",
    "inventory.available(1)",
    "Confirm",
  ]);
  expect(order(missing.right.work)).toEqual(order(missing.left.work));
  const changed = paid.comparisons.find((c) =>
    c.decisions.some(
      (d) => d.input.kind === "observation" && d.input.cell === "blocked",
    ),
  )!;
  expect(order(changed.right.work)).toEqual([
    "Confirm",
    "inventory.available(2)",
    "Ship",
  ]);
  expect(changed.right.outcome.kind).toBe("covered");
  expect(changed.right.work.map((e) => e.position.index)).toEqual(
    [...changed.right.work.map((e) => e.position.index)].sort((a, b) => a - b),
  );
});

it("sim.entry records trigger match and no-match paths", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>judge("start?");$instruct("Apply");}`,
  );
  const result = await run();
  for (const leaf of result.paths) {
    const path = await simulator.getPath(leaf.id);
    if (leaf.outcome.kind === "not-matched")
      expect(path.checkpoints).toHaveLength(0);
    else
      expect(path.checkpoints[0]?.position).toMatchObject({
        stage: "action",
        index: 0,
      });
  }
});

it("sim.coverage counts submitted alternatives per frontier", async () => {
  const { run, simulator } = fixture(
    `"arc";function Main(){this.trigger=()=>true;let a=Bool();let b=Bool();$observeOrAsk({a,b});if(a){$observeOrAsk(b);}}`,
  );
  const result = await run({ exploration: "exhaustive" });
  const [group] = result.coverage.groups;
  expect(group).toMatchObject({
    valuePairsExercised: 4,
    valuePairsInGeneratedDomains: 4,
  });
  expect(
    result.coverage.inputs
      .filter((d) => d.prefixId === group!.prefixId)
      .map((d) => d.exercised),
  ).toEqual([2, 2]);
  for (const domain of result.coverage.inputs)
    expect((await simulator.getPath(domain.prefixId)).outcome.kind).toBe(
      "prefix",
    );
  expect(
    result.coverage.nodes.some(
      (n) => n.observedPaths.length === result.paths.length,
    ),
  ).toBe(true);
});

it("sim.lifecycle reserves capacity during capture and drains on stop", async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const service = new SimulatorService({
    maxRetainedSimulations: 1,
    captureSnapshot: async () => {
      await gate;
      return { documents: [], hostModules: new Map() };
    },
  });
  const options = { arcRef: "arc:fixture:Main" as const, dialog };
  const first = service.simulate(options);
  await expect(service.simulate(options)).rejects.toThrow(/capacity/i);
  const stopping = service.stop();
  unblock();
  await expect(first).rejects.toThrow(/stopped/i);
  await stopping;
});
