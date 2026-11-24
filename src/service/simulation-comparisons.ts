import type { HostCallBrief, SemanticText } from "@elem-app/arc/types";
import { isDeepStrictEqual } from "node:util";

import {
  positionKey,
  type ReplayCheckpoint,
  type ReplayStep,
} from "../types/replay.js";
import type {
  ComparisonEvidence,
  SimulationComparison,
  SimulationComparisonSide,
  SimulationInput,
  SimulationPath,
  SimulationPathId,
  SimulationResult,
} from "../types/simulation.js";
import {
  encodeLine,
  history,
  type AnswerRecord,
  type Fork,
  type Prefix,
} from "./simulation-trace.js";

function render(text: SemanticText): string {
  return typeof text === "string"
    ? text
    : text
        .map((part) =>
          part.kind === "text"
            ? part.value
            : part.kind === "entity"
              ? part.name
              : part.kind === "artifact"
                ? part.path
                : [part.module, ...part.path].join("."),
        )
        .join("");
}
function renderCall(call: HostCallBrief): string {
  return `${[call.module, ...call.target, call.operation].join(".")}(${call.arguments.map((value) => JSON.stringify(value)).join(", ")})`;
}
function question(input: SimulationInput) {
  return input.kind === "judgment"
    ? render(input.brief.question)
    : input.kind === "observation"
      ? render(input.question)
      : renderCall(input.brief);
}
function answer(record: AnswerRecord, leaf: Prefix): ComparisonEvidence {
  const {
    choice: { input, answer },
  } = record;
  const rendered =
    typeof answer === "boolean"
      ? String(answer)
      : answer.status === "resolved"
        ? (JSON.stringify(answer.value) ?? "void")
        : `unknown (kept ${input.kind === "observation" && input.currentValue !== undefined ? JSON.stringify(input.currentValue) : "unset"})`;
  return {
    pathId: leaf.id,
    position: record.position,
    sourceRef: input.site.sourceRef,
    excerpt: `${question(input)} → ${rendered}`,
  };
}

function work(
  records: readonly {
    steps: readonly ReplayStep[];
    checkpoints?: readonly Pick<ReplayCheckpoint, "position" | "hostModules">[];
    hostCallIds?: Readonly<Record<string, string>>;
  }[],
  pathId: SimulationPathId,
): ComparisonEvidence[] {
  const evidence: ComparisonEvidence[] = [];
  const calls = new Set<string>(),
    pending = new Map<string, ComparisonEvidence>();
  for (const { steps, checkpoints, hostCallIds } of records) {
    const hosts = new Map(
      checkpoints?.map((c) => [positionKey(c.position), c.hostModules]),
    );
    for (const step of steps) {
      if (step.kind === "action-report") {
        for (const id of Object.keys(step.report.instructions ?? {})) {
          const request = pending.get(id);
          if (request) request.application = "applied";
          pending.delete(id);
        }
      }
      if (!("brief" in step)) continue;
      const brief = step.brief;
      if ("instructions" in brief)
        for (const item of brief.instructions) {
          if (item.phase !== "apply" || pending.has(item.id)) continue;
          const request: ComparisonEvidence = {
            pathId,
            position: step.position,
            sourceRef: item.sourceRef,
            excerpt: render(item.text),
            instruction: {
              text: item.text,
              mode: item.mode,
              guidance: item.guidance,
              hostParams: item.hostParams,
            },
            application: "requested",
          };
          pending.set(item.id, request);
          evidence.push(request);
        }
      if ("hostCalls" in brief) {
        const host =
          step.kind === "trigger-brief"
            ? step.hostModules
            : hosts.get(positionKey(step.position));
        for (const item of brief.hostCalls) {
          const record = host?.calls
            .slice()
            .reverse()
            .find((r) => r.runtimeCallId === item.id);
          const id = hostCallIds?.[item.id] ?? record?.call.hostCallId;
          if (!id || calls.has(id)) continue;
          calls.add(id);
          evidence.push({
            pathId,
            position: step.position,
            sourceRef: item.sourceRef,
            excerpt: renderCall(item),
          });
        }
      }
    }
  }
  return evidence;
}

/** Compare only evidence captured on each side of an actual fork. */
export function compareForks(forks: Fork[]): SimulationComparison[] {
  const comparisons: SimulationComparison[] = [];
  for (const { prefix, left, right } of forks) {
    const before = history(prefix);
    const sides = [left, right].map((leaf) =>
      history(leaf).slice(before.length),
    );
    const [ls, rs] = sides as [Prefix[], Prefix[]];
    const l = ls.flatMap((n) => n.answers),
      r = rs.flatMap((n) => n.answers);
    const decisions: SimulationComparison["decisions"][number][] = [];
    const additional: ComparisonEvidence[] = [];
    const used = new Set<AnswerRecord>();
    for (const a of l) {
      const b = r.find((b) => b.key === a.key && !used.has(b));
      if (!b) {
        additional.push(answer(a, left));
        continue;
      }
      used.add(b);
      if (!isDeepStrictEqual(a.choice.answer, b.choice.answer))
        decisions.push({
          input: a.choice.input,
          occurrence: a.occurrence,
          left: answer(a, left),
          right: answer(b, right),
        });
    }
    for (const b of r) if (!used.has(b)) additional.push(answer(b, right));
    for (const node of ls) {
      const step = node.steps.at(-1);
      const matching = rs
        .map((n) => n.steps.at(-1))
        .find(
          (s) =>
            s?.position.stage === step?.position.stage &&
            s?.position.index === step?.position.index,
        );
      if (
        step &&
        matching &&
        !isDeepStrictEqual(step.dialog, matching.dialog)
      ) {
        additional.push(
          ...(
            [
              [step, left],
              [matching, right],
            ] as const
          ).map(([s, leaf]) => ({
            pathId: leaf.id,
            position: s.position,
            excerpt: `Dialog ${JSON.stringify(s.dialog)}`,
          })),
        );
        break;
      }
    }
    if (!decisions.length) continue;
    const commonWork = work(before, left.id);
    const context = before.flatMap((node) => [
      ...node.answers.map((a) => answer(a, left)),
      ...commonWork.filter((e) =>
        node.steps.some(
          (s) =>
            "brief" in s &&
            s.position.stage === e.position.stage &&
            s.position.index === e.position.index,
        ),
      ),
    ]);
    const after = (leaf: Prefix, nodes: Prefix[]) => {
      const all = work([...before, ...nodes], leaf.id);
      const changed = all
        .slice(0, commonWork.length)
        .filter(
          (event, index) =>
            event.application !== commonWork[index]!.application,
        );
      return {
        pathId: leaf.id,
        work: [...changed, ...all.slice(commonWork.length)],
        outcome: leaf.outcome,
        lastPosition: leaf.steps.at(-1)!.position,
      };
    };
    comparisons.push({
      sharedPrefixId: prefix.id,
      context,
      decisions,
      left: after(left, ls),
      right: after(right, rs),
      additionalDifferences: additional,
    });
  }
  return comparisons;
}

function workFields(event: ComparisonEvidence) {
  return {
    sourceRef: event.sourceRef,
    request: event.instruction ?? event.excerpt,
    application: event.application,
  };
}

/** Compare recorded work, its batching and the endpoint across simplification trials. */
export function behaviorSignature(side: SimulationComparisonSide): string {
  return encodeLine({
    work: side.work.map((event, index, events) => ({
      ...workFields(event),
      sameBriefAsPrevious:
        index > 0 &&
        positionKey(event.position) ===
          positionKey(events[index - 1]!.position),
    })),
    outcome: side.outcome,
  });
}

/** Rank recorded contrasts for review, giving distinct patterns a turn in a bounded report. */
export function sortComparisons(comparisons: SimulationComparison[]) {
  const consultation = (change: SimulationComparison["decisions"][number]) =>
    JSON.stringify([
      change.left.position.stage,
      change.input.site.sourceRef,
      change.input.kind,
      change.input.kind === "observation"
        ? change.input.cell
        : change.input.kind === "judgment"
          ? change.input.site.briefId
          : undefined,
      question(change.input),
    ]);
  const occurrences = new Map<string, number>();
  const entries = comparisons.map((comparison) => {
    const describe = (events: readonly ComparisonEvidence[]) =>
      events.map((e) => encodeLine(workFields(e)));
    const left = describe(comparison.left.work);
    const right = describe(comparison.right.work);
    let pattern: string;
    if (isDeepStrictEqual(left, right)) pattern = "same";
    else if (left.length !== right.length)
      pattern = left.length < right.length ? "added" : "removed";
    else if (isDeepStrictEqual([...left].sort(), [...right].sort()))
      pattern = "reordered";
    else pattern = "changed";
    if (pattern !== "same") {
      for (const d of comparison.decisions) {
        const key = consultation(d);
        occurrences.set(
          key,
          Math.min(d.occurrence, occurrences.get(key) ?? Infinity),
        );
      }
    }
    return { comparison, pattern };
  });
  const ranked = entries
    .map(({ comparison: c, pattern }) => {
      const repeated =
        pattern === "same" &&
        c.left.work.length > 0 &&
        c.decisions.some(
          (d) => (occurrences.get(consultation(d)) ?? Infinity) < d.occurrence,
        );
      const concreteBoolean = c.decisions.some(
        (d) =>
          (d.input.kind === "judgment" ||
            (d.input.kind === "observation" &&
              d.input.meta.type === "boolean")) &&
          [d.left, d.right].every((side) =>
            / → (true|false)$/.test(side.excerpt),
          ),
      );
      return {
        comparison: c,
        pattern: repeated ? "repeat" : pattern,
        rank: [
          Number(!repeated),
          c.decisions.length + c.additionalDifferences.length,
          Number(
            c.left.outcome.kind === "limit" || c.right.outcome.kind === "limit",
          ),
          Number(repeated && !concreteBoolean),
          c.left.work.length + c.right.work.length,
        ],
      };
    })
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++)
        if (a.rank[i] !== b.rank[i]) return a.rank[i]! - b.rank[i]!;
      return 0;
    });
  const seen = new Set<string>();
  const first: SimulationComparison[] = [],
    rest: SimulationComparison[] = [];
  for (const entry of ranked) {
    (seen.has(entry.pattern) ? rest : first).push(entry.comparison);
    seen.add(entry.pattern);
  }
  return [...first, ...rest];
}

/** Bounded, self-contained report for a draft reviewer. */
export function formatSimulationReport(
  result: SimulationResult,
  source: string,
  maxBytes: number,
  example?: SimulationPath,
): string {
  const { coverage, completeness, unexplored } = result;
  const exercised = coverage.inputs.reduce(
    (sum, input) => sum + input.exercised,
    0,
  );
  const generated = coverage.inputs.reduce(
    (sum, input) => sum + input.generated,
    0,
  );
  const limits =
    [...new Set(unexplored.map((u) => u.reason))].join(", ") || "none";
  const summary = `Domains ${completeness.domains}. Exploration ${completeness.exploration}. ${result.paths.length} paths. Submitted ${exercised}/${generated} generated answers at reached inputs. Exclusions: ${result.exclusions.reduce((sum, e) => sum + e.count, 0)}. Limits: ${limits}.`;
  let omitted = result.comparisons.length;
  const diagnosticDetails = result.preferenceDiagnostics
    .filter((d) => d.status !== "available")
    .sort(
      (a, b) =>
        Number(a.status === "not-reached") - Number(b.status === "not-reached"),
    );
  let omittedDiagnostics = diagnosticDetails.length;
  const diagnosticSummary = result.preferenceDiagnostics.length
    ? `Preference availability: ${["available", "unavailable", "not-reached"].map((status) => `${result.preferenceDiagnostics.filter((d) => d.status === status).length} ${status}`).join(", ")}.`
    : undefined;
  const chunks = [
    source,
    `Dialog ${result.model.dialog}. Instruction application assumed. Host calls use modeled returns.`,
  ];
  const expectation = result.expectation;
  if (expectation) {
    const { cell, equals } = expectation.onCompletion;
    const expected = `${cell} = ${JSON.stringify(equals)}`;
    if (expectation.status === "witnessed") {
      const answers = expectation.answers.map(
        (a) =>
          `${a.cell} = ${JSON.stringify(a.answer)} [${a.position.stage} ${a.position.index}]`,
      );
      chunks.push(
        [
          `Expected outcome witnessed. Path ${expectation.pathId} covered in ${expectation.reports} reports.`,
          ...answers,
          `Terminal root ${cell} = ${JSON.stringify(expectation.actual)} (expected ${JSON.stringify(equals)}).`,
        ].join("\n"),
      );
    } else {
      const choices = expectation.prefer
        .map((p) => `${p.cell} = ${JSON.stringify(p.answer)}`)
        .join(", ");
      const reached = choices
        ? ` Preferred answers ${expectation.preferencesReached ? "reached" : "not reached"} together: ${choices}.`
        : "";
      chunks.push(
        `Expected outcome not witnessed. Expected terminal root ${expected}.${reached}`,
      );
    }
  }
  const tail = () =>
    [
      summary,
      ...(diagnosticSummary
        ? [
            diagnosticSummary,
            `${omittedDiagnostics} preference diagnostics omitted.`,
          ]
        : []),
      `${omitted} comparisons omitted.`,
    ].join("\n");
  let used = Buffer.byteLength([...chunks, tail()].join("\n\n"));
  if (used > maxBytes)
    throw new RangeError("Report budget cannot hold the simulation summary.");
  const add = (text: string) => {
    const n = Buffer.byteLength(text) + 2;
    if (used + n > maxBytes) return false;
    chunks.push(text);
    used += n;
    return true;
  };
  const display = (e: ComparisonEvidence) => {
    const params = e.instruction?.hostParams;
    return `[${e.position.stage} ${e.position.index}] ${e.excerpt}${params === undefined ? "" : " hostParams=" + JSON.stringify(params)}${e.application ? " (" + e.application + ")" : ""}`;
  };
  for (const diagnostic of diagnosticDetails) {
    const answer = `${diagnostic.cell} = ${JSON.stringify(diagnostic.answer)}`;
    const evidence = diagnostic.evidence;
    const detail =
      diagnostic.status === "not-reached"
        ? `Preferred observation not reached: ${answer}. Inspect the trigger, preceding decisions and exploration limits.`
        : `Preferred answer unavailable: ${answer}. It was absent from every eligible candidate domain inspected. Check the observation type and supply concrete examples through values.${evidence ? ` [${evidence.position.stage} ${evidence.position.index}] ${evidence.site.sourceRef}; prefix ${evidence.prefixId}. Candidate generation ${evidence.truncated ? "was truncated" : "was not truncated"} at this input.` : ""}`;
    if (add(detail)) omittedDiagnostics--;
  }
  for (const c of result.comparisons) {
    const earlier = c.decisions.flatMap((d) => {
      const prompt = question(d.input) + " → ";
      for (let i = c.context.length - 1; i >= 0; i--) {
        const event = c.context[i]!;
        if (
          event.sourceRef === d.input.site.sourceRef &&
          event.excerpt.startsWith(prompt)
        )
          return [i];
      }
      return [];
    });
    const context = earlier.length
      ? c.context.slice(Math.min(...earlier))
      : c.context.slice(-2);
    const lines = [
      ...context.map(display),
      ...c.decisions.map(
        (d) =>
          `${d.input.site.sourceRef} (occurrence ${d.occurrence}): ${display(d.left)} / ${display(d.right)}`,
      ),
      ...[c.left, c.right].map(
        (side) =>
          `${side.pathId}: ${side.work.map(display).join(" → ")} [${side.outcome.kind}${side.outcome.kind === "limit" ? " " + side.outcome.limit : ""} at ${side.lastPosition.stage} ${side.lastPosition.index}]`,
      ),
      ...c.additionalDifferences.map(display),
      ...(c.simplificationLimit
        ? [
            `Simplification stopped at ${c.simplificationLimit}. This contrast includes all the listed changes.`,
          ]
        : []),
    ];
    if (add(lines.join("\n"))) omitted--;
  }
  if (!result.comparisons.length) {
    const path = example ?? result.paths[0];
    if (path)
      add(
        `No comparable pair. Path ${path.id} ended ${path.outcome.kind}${path.outcome.kind === "limit" ? " at " + path.outcome.limit : ""}.`,
      );
    else add("No admitted path completed.");
    if (example)
      for (const event of work([example], example.id)) add(display(event));
    if (!result.paths.length && unexplored.length)
      add(`Stopped at ${unexplored[0]!.prefixId}: ${unexplored[0]!.reason}.`);
  }
  for (const e of result.exclusions)
    if (!add(`Excluded at ${e.prefixId}: ${e.reason} (${e.count}).`)) break;
  return [...chunks, tail()].join("\n\n");
}
