import {
  Runtime,
  toArcRefParts,
  toNodeRef,
  type ActionBrief,
  type ActionReport,
  type ArcRef,
  type Dialog,
  type NodeRef,
  type TerminalBrief,
  type TriggerBrief,
  type TriggerReport,
} from "@elem-app/arc/runtime";
import type {
  HostCallReport,
  ObservationGroupReport,
  ObservationReport,
  Traversal,
} from "@elem-app/arc/types";
import { setImmediate } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import {
  hostCallTraversal,
  type HostModuleEffect,
} from "../types/host-module.js";
import type { ResolvedDocumentSnapshot } from "../types/host.js";
import type {
  ActionReportStep,
  ReplayPosition,
  ReplayStep,
  TriggerReportStep,
} from "../types/replay.js";
import type {
  SimulationChoice,
  SimulationContext,
  SimulationCoverage,
  SimulationId,
  SimulationInput,
  SimulationLimits,
  SimulationOptions,
  SimulationOutcome,
  SimulationPathId,
  SimulationPreferenceDiagnostic,
  SimulationResult,
  SimulationWitnessAnswer,
} from "../types/simulation.js";
import { createDocumentRuntime } from "./document-runtime.js";
import {
  recordActionOutput,
  recordReport,
  recordTriggerOutput,
  recordTriggerStart,
} from "./replay-recording.js";
import {
  behaviorSignature,
  compareForks,
  sortComparisons,
} from "./simulation-comparisons.js";
import {
  captureState,
  emptyDialog,
  encodeLine,
  history,
  progressTape,
  recordBytes,
  restorePosition,
  type AnswerRecord,
  type Fork,
  type Prefix,
  type TapeState,
} from "./simulation-trace.js";
import {
  generateDomain,
  hostReturn,
  product,
  type Domain,
} from "./simulation-values.js";

type Brief = TriggerBrief | ActionBrief | TerminalBrief;
type Cursor = TapeState & {
  preferenceAnswers: readonly SimulationWitnessAnswer[];
  prefix: Prefix;
  work: readonly number[];
  dialog: Dialog;
  position: ReplayPosition;
};
type ChoiceDomain = Domain & {
  preferredIndex: number;
  key: string;
  siteKey: string;
  occurrence: number;
  base: number;
  uncaughtDeflectingAnswer?: boolean;
  exercised: Set<number>;
  coverage: SimulationCoverage["inputs"][number];
};
type Handback = {
  report: TriggerReport | ActionReport;
  origin: ActionReportStep["origin"] | TriggerReportStep["origin"];
  effect?: HostModuleEffect;
};
type Scenario = {
  trial?: boolean;
  leaf?: Prefix;
  reference?: Scenario;
  targets: Map<string, SimulationChoice["answer"]>;
};
type Task = {
  preferenceAnswers: readonly SimulationWitnessAnswer[];
  preferenceRank?: number;
  remaining?: bigint;
  /** Admission at this prefix, shared with simplification reruns. Null marks an excluded tuple. */
  examinedRows?: Map<string, AnswerRecord[] | null>;
  prefix: Prefix;
  position: ReplayPosition;
  work: readonly number[];
  rows: Generator<Proposal>;
  domains: ChoiceDomain[];
  dialog: Dialog;
  scenario: Scenario;
  pending?: Proposal;
  queuedAs?: "first-alternative" | "continuation";
  group?: Group;
};
type Group = {
  coverage: SimulationCoverage["groups"][number];
  pairs: Set<string>;
  shared: Set<string>;
  first: boolean;
};
type Proposal = {
  row: number[];
  target?: string;
  pair?: string;
  admitted?: AnswerRecord[];
};
type Limit = keyof SimulationLimits;
class BudgetReached {
  constructor(readonly limit: Limit) {}
}

function rootNode(arc: ArcRef) {
  const { source, identifier } = toArcRefParts(arc);
  return toNodeRef(source, [identifier]);
}

function resolvedObservation(
  input: SimulationInput,
  answer: SimulationChoice["answer"],
) {
  if (input.kind !== "observation") return;
  const observation = answer as ObservationReport;
  return observation.status === "resolved" ? observation.value : undefined;
}

function inputs(
  brief: TriggerBrief | ActionBrief,
  snapshot: ResolvedDocumentSnapshot,
): SimulationInput[] {
  if (brief.hostCalls.length) {
    const call = brief.hostCalls[0]!;
    return [
      {
        kind: "host-call",
        brief: call,
        site: { sourceRef: call.sourceRef, briefId: call.id },
        returns: hostReturn(
          snapshot.hostModules,
          call.module,
          call.target,
          call.operation,
        ),
      },
    ];
  }
  const result: SimulationInput[] = brief.judgments.map((item) => ({
    kind: "judgment",
    brief: item,
    site: { sourceRef: item.sourceRef, briefId: item.id },
  }));
  for (const item of brief.observations) {
    for (const field of item.kind === "observation" ? [item] : item.fields)
      result.push({
        kind: "observation",
        cell: field.cell,
        mode: item.mode,
        question: field.question,
        meta: field.meta,
        currentValue: field.currentValue,
        site: {
          sourceRef: item.sourceRef,
          briefId: item.id,
          ...(item.kind === "observation-group" && { field: field.cell }),
        },
      });
  }
  return result;
}

function identity(input: SimulationInput, position: ReplayPosition): string {
  const address =
    input.kind === "host-call"
      ? [
          input.brief.module,
          ...input.brief.target,
          input.brief.operation,
          input.brief.arguments,
        ]
      : input.kind === "judgment"
        ? input.site.briefId
        : [input.cell, input.site.field, input.question];
  return encodeLine({
    stage: position.stage,
    source: input.site.sourceRef,
    kind: input.kind,
    address,
  });
}

function handback(cursor: Cursor, records: AnswerRecord[]): Handback {
  const action = "canProgress" in cursor.brief;
  const report: ActionReport | TriggerReport = action
    ? { move: "proceed" }
    : {};
  for (const {
    choice: { input, answer },
  } of records) {
    const id = input.site.briefId;
    if (input.kind === "host-call") {
      const record = [...cursor.host.calls]
        .reverse()
        .find((item) => item.runtimeCallId === id);
      if (!record) throw new Error("Missing pending host invocation.");
      const resolved = answer as HostCallReport;
      report.hostCalls = { [id]: resolved };
      return {
        report,
        origin: "host-module",
        effect: {
          hostCallId: record.call.hostCallId,
          hostCallOutcome: { kind: "resolution", value: resolved.value },
        },
      };
    }
    if (input.kind === "judgment")
      (report.judgments ??= {})[id] = answer as boolean;
    else {
      const observations = (report.observations ??= {});
      if (input.site.field === undefined)
        observations[id] = answer as ObservationReport;
      else {
        const group = (observations[id] ??= {
          fields: {},
        }) as ObservationGroupReport;
        group.fields[input.site.field] = answer as ObservationReport;
      }
    }
  }
  return { report, origin: "worker" };
}

function automatic(
  brief: TriggerBrief | ActionBrief,
  arc: ArcRef,
): Handback | undefined {
  if (!("canProgress" in brief))
    return brief.matchableArcs.includes(arc)
      ? { report: { preferredMatch: arc }, origin: "host-preferred-match" }
      : undefined;
  if (brief.transition)
    return { report: { move: "proceed" }, origin: "host-transition" };
  if (brief.deflection && brief.allowedMoves.includes("deflect"))
    return { report: { move: "deflect" }, origin: "host-deflection" };
  const apply = brief.instructions.filter((item) => item.phase === "apply");
  if (apply.length)
    return {
      report: {
        move: "proceed",
        instructions: Object.fromEntries(
          apply.map((i) => [i.id, { status: "applied" }]),
        ),
      },
      origin: "worker",
    };
  if (
    !brief.hostCalls.length &&
    !brief.judgments.length &&
    !brief.observations.length &&
    brief.allowedMoves.includes("proceed")
  )
    return { report: { move: "proceed" }, origin: "host-proceed" };
}

/** Choose the baseline answer before varying individual inputs or grouped pairs. */
function preferredAnswer(
  domain: Domain,
  position: ReplayPosition,
  reference: SimulationChoice["answer"] | undefined,
  previous: AnswerRecord | undefined,
): number {
  const { input, candidates } = domain;
  const indexOf = (answer: SimulationChoice["answer"] | undefined) =>
    candidates.findIndex((candidate) =>
      isDeepStrictEqual(candidate.answer, answer),
    );
  const referenceIndex = indexOf(reference);
  if (referenceIndex >= 0) return referenceIndex;
  let base = 0;
  if (input.kind === "judgment" && position.stage === "trigger")
    base = Math.max(0, indexOf(true));
  else if (input.kind === "observation")
    base = Math.max(
      0,
      candidates.findIndex((c) => c.provenance !== "unknown"),
    );
  if (reference === undefined && previous) {
    const prior = indexOf(previous.choice.answer);
    if (input.kind === "judgment" && prior >= 0) return prior;
    if (input.kind !== "judgment" && prior === base) {
      const alternative = candidates.findIndex(
        (c, i) => i !== prior && c.provenance !== "unknown",
      );
      if (alternative >= 0) return alternative;
    }
  }
  return base;
}

function rowPairs(row: number[]) {
  const pairs: string[] = [];
  for (let i = 0; i < row.length; i++)
    for (let j = i + 1; j < row.length; j++)
      pairs.push(`${i}/${row[i]}/${j}/${row[j]}`);
  return pairs;
}

/** Drive isolated continuations through one captured runtime. */
export class SimulationDriver {
  readonly #preferred: ReadonlyMap<
    string,
    NonNullable<SimulationOptions["prefer"]>[number]["answer"]
  >;
  readonly #preferenceDiagnostics: ReadonlyMap<
    string,
    SimulationPreferenceDiagnostic
  >;
  /** Shared prefixes available for path lookup after exploration. */
  readonly prefixes = new Map<SimulationPathId, Prefix>();
  /** Path summaries, comparisons and coverage accumulated by this run. */
  readonly result: SimulationResult;
  /** Captured runtime that owns this recording and its checkpoint briefs. */
  readonly runtime: Runtime;
  readonly #declaresCatch = new Map<NodeRef, boolean>();
  readonly #queue: Task[] = [];
  readonly #scheduledSites = new Set<string>();
  readonly #workIds = new Map<string, number>();
  #preferNewSite = true;
  readonly #trialFrontiers = new Map<Prefix, Task>();
  readonly #targets = new Set<string>();
  readonly #groups = new Map<string, Set<string>>();
  readonly #nodes = new Map<string, SimulationCoverage["nodes"][number]>();
  #bytes = 0;
  #reviewReserve = 0;
  #totalReports = 0;
  #attempts = 0;
  #work = 0;
  #pairWork = 0;
  #stop?: Limit;
  /** Capture one run’s limits and initialize its independent runtime. */
  constructor(
    private readonly id: SimulationId,
    private readonly snapshot: ResolvedDocumentSnapshot,
    private readonly options: SimulationOptions,
    private readonly limits: SimulationLimits,
    private readonly signal: AbortSignal,
  ) {
    this.runtime = createDocumentRuntime(snapshot);
    const prefer = options.prefer ?? [];
    this.#preferred = new Map(prefer.map(({ cell, answer }) => [cell, answer]));
    const preferenceDiagnostics: SimulationPreferenceDiagnostic[] = prefer.map(
      ({ cell, answer }) => ({ cell, answer, status: "not-reached" }),
    );
    this.#preferenceDiagnostics = new Map(
      preferenceDiagnostics.map((diagnostic) => [diagnostic.cell, diagnostic]),
    );
    this.result = {
      id,
      preferenceDiagnostics,
      ...(options.expect && {
        expectation: {
          ...options.expect,
          prefer,
          status: "not-witnessed" as const,
          preferencesReached: !prefer.length,
        },
      }),
      paths: [],
      comparisons: [],
      coverage: { inputs: [], groups: [], nodes: [] },
      completeness: { domains: "finite-complete", exploration: "complete" },
      unexplored: [],
      exclusions: [],
      limits,
      model: {
        exploration: options.exploration ?? "comparisons",
        entry: "trigger",
        dialog: typeof options.dialog === "function" ? "provided" : "fixed",
        scheduling: "apply-before-checks",
        instructionApplication: "assumed",
        hostEffects: "returns-only",
        externalEvents: "excluded",
      },
    };
    this.#bytes = recordBytes({
      documents: snapshot.documents,
      hostModules: [...snapshot.hostModules],
      ...(prefer.length && { prefer }),
      preferenceDiagnostics,
      ...(options.expect && { expect: options.expect }),
    });
    if (this.#bytes >= limits.maxRecordBytes)
      throw new RangeError("Snapshot exceeds maxRecordBytes.");
  }

  #charge(value: object) {
    const size = recordBytes(value);
    if (this.#bytes + size > this.limits.maxRecordBytes - this.#reviewReserve)
      throw new BudgetReached("maxRecordBytes");
    this.#bytes += size;
  }

  /** Only the first resolved observation for a preferred cell identifies the scenario. */
  #preferenceAnswers(
    prior: readonly SimulationWitnessAnswer[],
    choices: readonly Pick<SimulationChoice, "input" | "answer">[],
    position: ReplayPosition,
  ) {
    let answers = prior;
    for (const { input, answer } of choices) {
      if (
        input.kind !== "observation" ||
        !this.#preferred.has(input.cell) ||
        answers.some((entry) => entry.cell === input.cell)
      )
        continue;
      const value = resolvedObservation(input, answer);
      if (value !== undefined)
        answers = [...answers, { cell: input.cell, answer: value, position }];
    }
    return answers;
  }

  #preferenceRank(answers: readonly SimulationWitnessAnswer[]) {
    const matches = answers.filter(({ cell, answer }) =>
      isDeepStrictEqual(this.#preferred.get(cell), answer),
    ).length;
    return matches === answers.length
      ? matches
      : matches - this.#preferred.size - 1;
  }

  #spendPairWork(units: number) {
    this.#pairWork += units;
    if (this.#pairWork > this.limits.maxCandidateCombinations * 32)
      throw new BudgetReached("maxCandidateCombinations");
  }

  #context(cursor?: Cursor): SimulationContext {
    const brief = cursor?.brief;
    return {
      stage: cursor?.position.stage ?? "trigger",
      position: cursor?.position ?? {
        stage: "trigger",
        index: 0,
        reactivationCount: 0,
      },
      sourceRef:
        brief && "active" in brief
          ? brief.active
          : rootNode(this.options.arcRef),
      previousDialog: cursor?.dialog ?? emptyDialog(),
      traversals: brief?.traversals ?? [],
      choices: cursor
        ? history(cursor.prefix).flatMap((p) => p.answers.map((a) => a.choice))
        : [],
    };
  }
  #dialog(context: SimulationContext) {
    return structuredClone(
      typeof this.options.dialog === "function"
        ? this.options.dialog(structuredClone(context))
        : this.options.dialog,
    );
  }

  /** Identify a route by its first visits to distinct instructions and host calls. */
  #workRoute(
    prior: readonly number[],
    brief: Brief,
    stage: ReplayPosition["stage"],
  ) {
    if (this.options.exploration === "exhaustive" || !("hostCalls" in brief))
      return prior;
    const applied =
      "instructions" in brief
        ? brief.instructions.filter((item) => item.phase === "apply")
        : [];
    let route = prior;
    for (const { id: _id, ...request } of [...applied, ...brief.hostCalls]) {
      const key = encodeLine({ stage, request });
      let id = this.#workIds.get(key);
      if (id === undefined) {
        this.#charge({ work: key });
        id = this.#workIds.size;
        this.#workIds.set(key, id);
      }
      if (!route.includes(id)) route = [...route, id];
    }
    return route;
  }

  #save(
    state: TapeState,
    dialog: Dialog,
    position: ReplayPosition,
    steps: ReplayStep[],
    parent?: Cursor,
    answers: AnswerRecord[] = [],
    report = false,
  ): Cursor {
    const { brief, host } = state;
    const priorAnswers = parent?.preferenceAnswers ?? [];
    const preferenceAnswers =
      parent && answers.length && priorAnswers.length < this.#preferred.size
        ? this.#preferenceAnswers(
            priorAnswers,
            answers.map((record) => record.choice),
            parent.position,
          )
        : priorAnswers;
    const work = this.#workRoute(parent?.work ?? [], brief, position.stage);
    const checkpoint = (position.index - 1) % 32 === 0 ? state : undefined;
    let hostCallIds: Record<string, string> | undefined;
    if ("canProgress" in brief && position.stage === "action") {
      steps.push(recordActionOutput(position, brief, dialog));
      if (brief.canProgress && brief.hostCalls.length) {
        const calls = [...host.calls].reverse();
        hostCallIds = Object.fromEntries(
          brief.hostCalls.map((item) => [
            item.id,
            calls.find((r) => r.runtimeCallId === item.id)!.call.hostCallId,
          ]),
        );
      }
    } else if (!("canProgress" in brief) && position.stage === "trigger")
      steps.push(recordTriggerOutput(position, brief, dialog, host));
    const nodeStates: Prefix["nodeStates"] = [];
    const seen = new Set<string>();
    const pending: Traversal[] = [...brief.traversals];
    while (pending.length) {
      const t = pending.pop()!;
      const ref = t.ref.startsWith("arc:")
        ? rootNode(t.ref as ArcRef)
        : (t.ref as SimulationContext["sourceRef"]);
      const key = `${t.state ?? ""}:${ref}`;
      if (!seen.has(key)) {
        seen.add(key);
        nodeStates.push([ref, t.state ?? null]);
      }
      pending.push(...t.ownedChildren, ...t.ephemeralChildren);
    }
    this.#charge({
      steps,
      ...(checkpoint && { checkpoint }),
      ...(hostCallIds && { hostCallIds }),
      nodeStates,
      answers,
      ...(preferenceAnswers !== priorAnswers && { preferenceAnswers }),
    });
    const prefix: Prefix = {
      parent: parent?.prefix,
      steps,
      checkpoint,
      hostCallIds,
      nodeStates,
      answers,
      depth: (parent?.prefix.depth ?? 0) + Number(report),
      id: `${this.id}/${this.prefixes.size}` as SimulationPathId,
      outcome: { kind: "prefix" },
    };
    this.prefixes.set(prefix.id, prefix);
    const expectation = this.result.expectation;
    if (
      expectation?.status === "not-witnessed" &&
      !expectation.preferencesReached &&
      preferenceAnswers.length === this.#preferred.size &&
      this.#preferenceRank(preferenceAnswers) === this.#preferred.size
    )
      expectation.preferencesReached = true;
    return { brief, dialog, position, host, prefix, work, preferenceAnswers };
  }

  #advance(
    cursor: Cursor,
    hand: Handback,
    dialog: Dialog,
    answers: AnswerRecord[],
  ) {
    if (this.#totalReports >= this.limits.maxTotalReports)
      throw new BudgetReached("maxTotalReports");
    this.#totalReports++;
    const { position, brief } = cursor;
    let step: ActionReportStep | TriggerReportStep;
    const effect = hand.effect;
    if (position.stage === "trigger" && !("canProgress" in brief)) {
      step = recordReport({
        kind: "trigger-report",
        position,
        dialog,
        origin: hand.origin as TriggerReportStep["origin"],
        report: hand.report,
        ...(effect && { moduleEffect: effect }),
      });
    } else if (
      position.stage === "action" &&
      "canProgress" in brief &&
      brief.canProgress &&
      "move" in hand.report
    ) {
      step = recordReport({
        kind: "action-report",
        position,
        dialog,
        origin: hand.origin as ActionReportStep["origin"],
        report: hand.report,
        ...(effect && { moduleEffect: effect }),
      });
    } else throw new Error("Report does not belong to the current frontier.");
    return this.#save(
      progressTape(this.runtime, this.options.arcRef, cursor, step),
      dialog,
      { ...position, index: position.index + 1 },
      [step],
      cursor,
      answers,
      true,
    );
  }

  #finish(cursor: Cursor, outcome: SimulationOutcome, scenario: Scenario) {
    const prefix = cursor.prefix;
    const expectation = this.result.expectation;
    if (
      outcome.kind === "covered" &&
      expectation?.status === "not-witnessed" &&
      this.#preferenceRank(cursor.preferenceAnswers) === this.#preferred.size
    ) {
      const root = cursor.brief.traversals.find(
        (item) => item.ref === this.options.arcRef,
      );
      const { cell, equals } = expectation.onCompletion;
      const actual =
        root && Object.hasOwn(root.cells, cell) ? root.cells[cell] : undefined;
      if (actual !== undefined && isDeepStrictEqual(actual, equals)) {
        this.result.expectation = {
          onCompletion: expectation.onCompletion,
          prefer: expectation.prefer,
          status: "witnessed",
          pathId: prefix.id,
          reports: prefix.depth,
          actual,
          answers: cursor.preferenceAnswers,
        };
      }
    }
    prefix.outcome = outcome;
    scenario.leaf = prefix;
    (this.result.paths as SimulationResult["paths"][number][]).push({
      id: prefix.id,
      outcome,
      reports: prefix.depth,
    });
    for (const node of history(prefix)) {
      for (const [ref, state] of node.nodeStates) {
        const record = this.#nodes.get(ref) ?? {
          ref,
          observedPaths: [],
          outcomes: [],
        };
        if (record.observedPaths.at(-1) !== prefix.id)
          (record.observedPaths as SimulationPathId[]).push(prefix.id);
        if (state && !record.outcomes.includes(state))
          (record.outcomes as (typeof state)[]).push(state);
        this.#nodes.set(ref, record);
      }
    }
  }

  #gap(prefix: Prefix, limit: Limit, remaining?: bigint) {
    this.result.completeness.exploration = "limited";
    if (
      !this.result.unexplored.some(
        (x) => x.prefixId === prefix.id && x.reason === limit,
      )
    )
      (this.result.unexplored as SimulationResult["unexplored"][number][]).push(
        {
          prefixId: prefix.id,
          reason: limit,
          ...(remaining !== undefined && {
            remainingAlternatives: String(remaining),
          }),
        },
      );
  }

  async #tick() {
    if (++this.#work % 32 === 0) await setImmediate();
    this.signal.throwIfAborted();
  }

  /** Follow actual entries, including imported arcs and anonymous copies. */
  #canCatch(brief: ActionBrief): boolean {
    let ref: NodeRef | undefined = brief.active;
    while (ref) {
      let catches = this.#declaresCatch.get(ref);
      if (catches === undefined) {
        catches = this.runtime.nodeForRef(ref)?.catchDeflection !== undefined;
        this.#declaresCatch.set(ref, catches);
      }
      if (catches) return true;
      ref = hostCallTraversal(brief.traversals, ref)?.enteredBy?.callerRef;
    }
    return false;
  }

  /** Let Arc evaluate the judgment in isolation from the instruction's other open checks. */
  #uncaughtDeflectingAnswer(
    cursor: Cursor,
    domain: Domain,
    dialog: Dialog,
  ): boolean | undefined {
    const { brief } = cursor;
    const { input } = domain;
    if (
      this.options.exploration === "exhaustive" ||
      input.kind !== "judgment" ||
      !domain.candidates.some((c) => c.provenance === "generated") ||
      !("canProgress" in brief) ||
      !brief.canProgress ||
      !brief.instructions.some((i) =>
        i.postcheck?.judgmentIds.includes(input.site.briefId),
      ) ||
      this.#canCatch(brief)
    )
      return;

    const segment = brief.traversals.find((t) => t.activeFrame)?.activeFrame
      ?.activeSeg;
    if (segment?.kind !== "resolveWhen" && segment?.kind !== "deflectWhen")
      return;
    const deflects = (answer: boolean) => {
      const next = this.runtime.progress(
        brief,
        {
          move: "proceed",
          judgments: { [input.site.briefId]: answer },
        },
        dialog,
      );
      if (!next.canProgress || next.deflection?.origin !== brief.active)
        return false;
      const owner = next.traversals.find((t) => t.activeFrame)?.activeFrame
        ?.activeSeg;
      return owner?.kind === segment.kind && owner.owner === segment.owner;
    };
    const onFalse = deflects(false);
    const onTrue = deflects(true);
    // A forced deflection is authored behavior even in a catchless node.
    return onFalse === onTrue ? undefined : onTrue;
  }

  #domains(
    cursor: Cursor,
    context: SimulationContext,
    dialog: Dialog,
    scenario: Scenario,
  ) {
    const prior = history(cursor.prefix).flatMap((p) => p.answers);
    return inputs(
      cursor.brief as ActionBrief | TriggerBrief,
      this.snapshot,
    ).map((input) => {
      const site = identity(input, cursor.position);
      const visits = prior.filter(
        (a) => identity(a.choice.input, a.position) === site,
      );
      const occurrence = visits.length + 1;
      const entry = hostCallTraversal(
        cursor.brief.traversals,
        input.site.sourceRef,
      );
      const frame = cursor.brief.traversals.find(
        (t) => t.activeFrame?.activeRef === input.site.sourceRef,
      )?.activeFrame;
      const key = encodeLine({
        site,
        occurrence,
        ...(input.kind === "judgment" && { question: input.brief.question }),
        entry: entry?.enterCount,
        caller: entry?.enteredBy,
        segment: frame?.activeSeg,
      });
      const domain = generateDomain(
        input,
        context,
        dialog,
        this.options,
        this.limits,
      );
      const preferred =
        input.kind === "observation" &&
        !cursor.preferenceAnswers.some((entry) => entry.cell === input.cell)
          ? this.#preferred.get(input.cell)
          : undefined;
      const preferredIndex =
        preferred === undefined
          ? -1
          : domain.candidates.findIndex((candidate) =>
              isDeepStrictEqual(
                resolvedObservation(input, candidate.answer),
                preferred,
              ),
            );
      const ranks = [
        "finite-complete",
        "sampled",
        "restricted",
        "missing",
      ] as const;
      const status = domain.missing ? "missing" : domain.classification;
      if (
        ranks.indexOf(status) > ranks.indexOf(this.result.completeness.domains)
      )
        this.result.completeness.domains = status;
      const coverage = {
        prefixId: cursor.prefix.id,
        site: input.site,
        occurrence,
        domain: domain.classification,
        generated: domain.candidates.length,
        exercised: 0,
        truncated: domain.truncated,
        gaps: domain.missing ? ["No concrete candidate."] : [],
      };
      this.#charge({
        coverage,
        domain,
        ...(this.#preferred.size && { preferredIndex }),
      });
      if (input.kind === "observation" && preferred !== undefined) {
        const diagnostic = this.#preferenceDiagnostics.get(input.cell)!;
        const status = preferredIndex >= 0 ? "available" : "unavailable";
        if (diagnostic.status !== "available" && diagnostic.status !== status) {
          const update = {
            status,
            evidence: {
              prefixId: cursor.prefix.id,
              position: cursor.position,
              site: input.site,
              truncated: domain.truncated,
            },
          };
          this.#charge(update);
          Object.assign(diagnostic, update);
        }
      }
      (this.result.coverage.inputs as (typeof coverage)[]).push(coverage);
      return {
        ...domain,
        siteKey: encodeLine({
          stage: cursor.position.stage,
          ...input.site,
          work: cursor.work,
        }),
        key,
        occurrence,
        preferredIndex,
        base:
          !scenario.trial && preferredIndex >= 0
            ? preferredIndex
            : preferredAnswer(
                domain,
                cursor.position,
                scenario.reference?.targets.get(key),
                visits.at(-1),
              ),
        uncaughtDeflectingAnswer: this.#uncaughtDeflectingAnswer(
          cursor,
          domain,
          dialog,
        ),
        coverage,
        exercised: new Set<number>(),
      };
    });
  }

  *#rows(
    domains: ChoiceDomain[],
    work: readonly number[],
    group?: Group,
  ): Generator<Proposal> {
    const sizes = domains.map((d) => d.candidates.length);
    if (this.options.exploration === "exhaustive") {
      for (const row of product(sizes)) {
        // Visit the preferred index first while retaining the original candidate indices.
        for (const [i, domain] of domains.entries()) {
          const preferred = domain.preferredIndex;
          if (preferred > 0 && row[i]! <= preferred)
            row[i] = row[i] === 0 ? preferred : row[i]! - 1;
        }
        yield { row };
      }
      return;
    }
    const base = domains.map((d) => d.base);
    yield { row: base };
    for (const [i, d] of domains.entries()) {
      // An unknown observation retains the current value. Try concrete changes first.
      const alternatives = d.candidates
        .map((_, index) => index)
        .sort(
          (a, b) =>
            Number(d.candidates[a]!.provenance === "unknown") -
            Number(d.candidates[b]!.provenance === "unknown"),
        );
      for (const j of alternatives) {
        if (j === base[i]) continue;
        const row = [...base];
        row[i] = j;
        const fixed = domains.flatMap((field, k) =>
          field.input.kind === "observation" &&
          [base[k], row[k]].some(
            (index) => field.candidates[index!]?.provenance === "unknown",
          )
            ? [[field.key, field.input.currentValue]]
            : [],
        );
        const target = encodeLine({
          key: d.key,
          work,
          base: d.candidates[base[i]!]!.answer,
          alt: d.candidates[j]!.answer,
          fixed,
        });
        if (!this.#targets.has(target)) yield { row, target };
      }
    }
    if (!group) return;
    if (!group.first && !this.options.accept) return;
    const witnessed = group.shared;
    for (let i = 0; i < sizes.length; i++)
      for (let j = i + 1; j < sizes.length; j++) {
        for (let a = 0; a < sizes[i]!; a++)
          for (let b = 0; b < sizes[j]!; b++) {
            this.#spendPairWork(1);
            const pair = `${i}/${a}/${j}/${b}`;
            if (witnessed.has(pair)) continue;
            const row = base.map(() => -1);
            row[i] = a;
            row[j] = b;
            for (let k = 0; k < row.length; k++)
              if (row[k] === -1) {
                let best = -1,
                  baseChoice = base[k]!;
                for (const v of [
                  base[k]!,
                  ...Array.from({ length: sizes[k]! }, (_, n) => n).filter(
                    (n) => n !== base[k],
                  ),
                ]) {
                  row[k] = v;
                  this.#spendPairWork(row.length);
                  const score = rowPairs(row).filter(
                    (p) =>
                      !p.includes("/-1") &&
                      !witnessed.has(p) &&
                      (p.startsWith(k + "/") || p.split("/")[2] === String(k)),
                  ).length;
                  if (score > best) {
                    best = score;
                    baseChoice = v;
                  }
                }
                row[k] = baseChoice;
              }
            yield { row, pair };
            if (this.options.accept && !witnessed.has(pair)) {
              const other = sizes.map((n, k) => (k === i || k === j ? 1 : n));
              for (const completion of product(other)) {
                completion[i] = a;
                completion[j] = b;
                if (!isDeepStrictEqual(row, completion))
                  yield { row: completion, pair };
                if (witnessed.has(pair)) break;
              }
            }
          }
      }
  }

  async #nextProposal(task: Task): Promise<Proposal | undefined> {
    for (;;) {
      const reserved = task.pending;
      const item = reserved
        ? { done: false, value: reserved }
        : task.rows.next();
      task.pending = undefined;
      if (item.done) break;
      await this.#tick();
      const proposal = item.value;
      if (proposal.target && this.#targets.has(proposal.target)) continue;
      if (proposal.pair && task.group?.shared.has(proposal.pair)) continue;
      const known = task.examinedRows?.get(proposal.row.join(","));
      if (known === null || (known && !reserved && !task.scenario.trial))
        continue;
      return proposal;
    }
    if (task.examinedRows && !task.scenario.trial) {
      const total = task.domains.reduce(
        (n, d) => n * BigInt(d.candidates.length),
        1n,
      );
      if (
        this.result.completeness.exploration === "complete" &&
        BigInt(task.examinedRows.size) < total
      )
        this.result.completeness.exploration = "sampled";
    }
  }

  async #take(
    task: Task,
    cursor: Cursor,
  ): Promise<{ records: AnswerRecord[]; proposal: Proposal } | undefined> {
    let context: SimulationContext | undefined;
    for (;;) {
      const proposal = await this.#nextProposal(task);
      if (!proposal) return;
      const rowKey = proposal.row.join(",");
      const previous = proposal.admitted ?? task.examinedRows?.get(rowKey);
      if (previous) return { records: previous, proposal };
      if (this.#attempts >= this.limits.maxCandidateCombinations)
        throw new BudgetReached("maxCandidateCombinations");
      this.#attempts++;
      const records: AnswerRecord[] = [];
      let rejected = false;
      for (const [i, index] of proposal.row.entries()) {
        const d = task.domains[i]!,
          candidate = d.candidates[index]!;
        const choice: SimulationChoice = {
          input: d.input,
          occurrence: d.occurrence,
          answer: candidate.answer,
        };
        let decision;
        if (this.options.accept) {
          context ??= this.#context(cursor);
          decision = this.options.accept(
            structuredClone(choice),
            structuredClone({
              ...context,
              choices: [...context.choices, ...records.map((a) => a.choice)],
            }),
          );
        }
        const reason =
          decision && !decision.accept
            ? decision.reason
            : candidate.provenance === "generated" &&
                candidate.answer === d.uncaughtDeflectingAnswer
              ? "Generated instruction deflection has no catch on the active caller chain."
              : undefined;
        if (reason !== undefined) {
          const exclusions = this.result
            .exclusions as SimulationResult["exclusions"][number][];
          const found = exclusions.find(
            (e) => e.prefixId === task.prefix.id && e.reason === reason,
          );
          if (found) found.count++;
          else {
            const exclusion = {
              prefixId: task.prefix.id,
              reason,
              count: 1,
            };
            this.#charge(exclusion);
            exclusions.push(exclusion);
          }
          rejected = true;
          break;
        }
        records.push({
          key: d.key,
          choice,
          position: task.position,
          site: d.input.site,
          occurrence: d.occurrence,
          candidateIndex: index,
          provenance: candidate.provenance,
          label: candidate.label,
        });
      }
      task.examinedRows?.set(rowKey, rejected ? null : records);
      if (!rejected) return { records, proposal };
    }
  }

  #restore(task: Task): Cursor {
    const state = restorePosition(
      this.runtime,
      this.options.arcRef,
      task.prefix,
    );
    return {
      ...state,
      prefix: task.prefix,
      position: task.position,
      work: task.work,
      preferenceAnswers: task.preferenceAnswers,
      dialog: task.prefix.steps.at(-1)!.dialog,
    };
  }

  async #branch(
    task: Task,
    scenario: Scenario,
    cursor: Cursor,
  ): Promise<Cursor | undefined> {
    const next = await this.#take(task, cursor);
    if (!next) return;
    return this.#submit(task, scenario, next, cursor);
  }

  #submit(
    task: Task,
    scenario: Scenario,
    selected: { records: AnswerRecord[]; proposal: Proposal },
    parent: Cursor,
  ) {
    const { records, proposal } = selected;
    const pairs = task.group ? rowPairs(proposal.row) : [];
    if (proposal.target) this.#charge({ target: proposal.target });
    for (const p of pairs)
      if (!task.group!.pairs.has(p))
        this.#charge({ pair: p, prefix: task.prefix.id });
    const cursor = this.#advance(
      parent,
      handback(parent, records),
      task.dialog,
      records,
    );
    if (task.remaining !== undefined) task.remaining--;
    if (proposal.target) this.#targets.add(proposal.target);
    for (const [i, record] of records.entries()) {
      scenario.targets.set(record.key, record.choice.answer);
      const d = task.domains[i]!;
      d.exercised.add(proposal.row[i]!);
      d.coverage.exercised = d.exercised.size;
    }
    if (task.group) {
      for (const p of pairs) {
        task.group.pairs.add(p);
        task.group.shared.add(p);
      }
      task.group.coverage.valuePairsExercised = task.group.pairs.size;
    }
    return cursor;
  }

  async #walk(start: Cursor, scenario: Scenario) {
    let cursor = start;
    let remaining: bigint | undefined;
    try {
      for (;;) {
        await this.#tick();
        const { brief, position } = cursor;
        if ("canProgress" in brief && !brief.canProgress) {
          if (brief.outcome === "interrupted")
            throw new Error("Unexpected interruption in simulation.");
          this.#finish(
            cursor,
            brief.outcome === "poisoned"
              ? { kind: "runtime-issue", issues: brief.issues }
              : brief.outcome === "covered"
                ? {
                    kind: "covered",
                    ...(brief.returns && { returns: brief.returns }),
                  }
                : { kind: "deflected" },
            scenario,
          );
          return;
        }
        if (
          !("canProgress" in brief) &&
          brief.matched === this.options.arcRef
        ) {
          const dialog = this.#dialog(this.#context(cursor));
          const next = this.runtime.start(brief.traversals, dialog);
          cursor = this.#save(
            captureState(this.options.arcRef, next, cursor.host),
            dialog,
            { stage: "action", reactivationCount: 0, index: 1 },
            [],
            cursor,
          );
          continue;
        }
        if (
          !("canProgress" in brief) &&
          !brief.matchableArcs.length &&
          !brief.hostCalls.length &&
          !brief.judgments.length &&
          !brief.observations.length
        ) {
          this.#finish(
            cursor,
            brief.issues.length
              ? { kind: "runtime-issue", issues: brief.issues }
              : { kind: "not-matched" },
            scenario,
          );
          return;
        }
        if (cursor.prefix.depth >= this.limits.maxReportsPerPath)
          throw new BudgetReached("maxReportsPerPath");
        const context = this.#context(cursor),
          dialog = this.#dialog(context);
        const auto = automatic(brief, this.options.arcRef);
        if (auto) {
          cursor = this.#advance(cursor, auto, dialog, []);
          continue;
        }
        const cached =
          scenario.trial && this.#trialFrontiers.get(cursor.prefix);
        const domains = cached
          ? cached.domains
          : this.#domains(cursor, context, dialog, scenario);
        if (!domains.length) {
          this.#finish(
            cursor,
            {
              kind: "stalled",
              position,
              reason: "No modeled advance for this frontier.",
            },
            scenario,
          );
          return;
        }
        const missing = domains.find((d) => !d.candidates.length);
        if (missing) {
          this.#finish(
            cursor,
            { kind: "missing-input", input: missing.input },
            scenario,
          );
          return;
        }
        if (this.options.exploration === "exhaustive" && !this.options.accept)
          remaining = domains.reduce(
            (n, d) => n * BigInt(d.candidates.length),
            1n,
          );
        let group: Group | undefined;
        if (domains.length > 1) {
          this.#spendPairWork((domains.length * (domains.length - 1)) / 2);
          const sizes = domains.map((d) => d.candidates.length);
          const coverage = {
            prefixId: cursor.prefix.id,
            position,
            fieldPairs: (sizes.length * (sizes.length - 1)) / 2,
            valuePairsInGeneratedDomains: sizes.reduce(
              (sum, n, i) =>
                sum + n * sizes.slice(i + 1).reduce((a, b) => a + b, 0),
              0,
            ),
            valuePairsExercised: 0,
          };
          const signature = encodeLine({
            work: cursor.work,
            domains: domains.map((d) => [
              d.key,
              d.base,
              d.candidates.map((c) => c.answer),
              d.input.kind === "observation" && d.input.mode === "observe"
                ? d.input.currentValue
                : undefined,
            ]),
          });
          const shared = this.#groups.get(signature) ?? new Set<string>();
          group = {
            coverage,
            pairs: new Set(),
            shared,
            first: !this.#groups.has(signature),
          };
          this.#groups.set(signature, shared);
          (this.result.coverage.groups as (typeof coverage)[]).push(coverage);
        }
        const rows = scenario.trial
          ? this.#trialRow(domains, scenario.targets)
          : this.#rows(domains, cursor.work, group);
        const task: Task = {
          prefix: cursor.prefix,
          preferenceAnswers: cursor.preferenceAnswers,
          work: cursor.work,
          position: cursor.position,
          scenario,
          domains,
          dialog,
          rows,
          group,
          remaining,
          examinedRows:
            this.options.exploration === "exhaustive"
              ? undefined
              : cached
                ? cached.examinedRows
                : new Map(),
        };
        if (
          this.options.exploration !== "exhaustive" &&
          this.#retainable(task, false)
        )
          this.#trialFrontiers.set(cursor.prefix, task);
        if (
          !scenario.trial &&
          this.options.exploration !== "exhaustive" &&
          this.#queue.length &&
          domains.every((domain) => domain.occurrence > 1) &&
          this.#retainable(task, true)
        ) {
          // Yield a revisited decision so a looping path cannot exhaust the budget alone.
          await this.#enqueue(task, cursor, true);
          return;
        }
        const child = await this.#branch(task, scenario, cursor);
        if (!child) return;
        remaining = task.remaining;
        if (!scenario.trial) await this.#enqueue(task, cursor);
        cursor = child;
        remaining = undefined;
      }
    } catch (error) {
      if (!(error instanceof BudgetReached)) throw error;
      this.#gap(cursor.prefix, error.limit, remaining);
      this.#finish(
        cursor,
        { kind: "limit", limit: error.limit, position: cursor.position },
        scenario,
      );
      if (error.limit !== "maxReportsPerPath") this.#stop = error.limit;
    }
  }

  #retainable(task: Task, prioritizeExploration: boolean) {
    const queued = new Set(this.#queue.map((t) => t.prefix));
    const held = new Set([...this.#trialFrontiers.keys(), ...queued]);
    if (held.has(task.prefix) || held.size < this.limits.maxPendingPrefixes)
      return true;
    if (prioritizeExploration)
      for (const prefix of this.#trialFrontiers.keys()) {
        if (!queued.has(prefix)) {
          this.#trialFrontiers.delete(prefix);
          return true;
        }
      }
    return false;
  }

  async #enqueue(task: Task, cursor: Cursor, continuation = false) {
    try {
      task.pending =
        this.options.exploration === "exhaustive"
          ? await this.#nextProposal(task)
          : (await this.#take(task, cursor))?.proposal;
      if (
        task.pending &&
        this.#preferred.size &&
        this.result.expectation?.status !== "witnessed"
      ) {
        const row = task.pending.row;
        const choices = task.domains.map((domain, i) => ({
          input: domain.input,
          answer: domain.candidates[row[i]!]!.answer,
        }));
        const preferenceRank = this.#preferenceRank(
          this.#preferenceAnswers(
            task.preferenceAnswers,
            choices,
            task.position,
          ),
        );
        if (task.preferenceRank === undefined) this.#charge({ preferenceRank });
        task.preferenceRank = preferenceRank;
      }
    } catch (error) {
      if (!(error instanceof BudgetReached) || continuation) throw error;
      // The child is already admitted. Only its pending sibling hit this limit.
      this.#gap(task.prefix, error.limit, task.remaining);
      return;
    }
    if (!task.pending) return;
    if (!this.#retainable(task, true)) {
      this.#gap(task.prefix, "maxPendingPrefixes", task.remaining);
      return;
    }
    task.queuedAs = continuation ? "continuation" : undefined;
    if (!continuation && this.options.exploration !== "exhaustive") {
      for (const [i, d] of task.domains.entries()) {
        if (
          task.pending.row[i] !== d.base &&
          !this.#scheduledSites.has(d.siteKey)
        ) {
          this.#scheduledSites.add(d.siteKey);
          task.queuedAs = "first-alternative";
        }
      }
    }
    this.#queue.push(task);
  }

  #dequeue(): Task {
    const ranked =
      this.#preferred.size > 0 &&
      this.result.expectation?.status !== "witnessed";
    const best = ranked
      ? this.#queue.reduce(
          (max, task) => Math.max(max, task.preferenceRank!),
          -Infinity,
        )
      : undefined;
    const eligible = (task: Task) => !ranked || task.preferenceRank === best;
    if (this.options.exploration === "exhaustive") {
      let index = this.#queue.length - 1;
      while (!eligible(this.#queue[index]!)) index--;
      return this.#queue.splice(index, 1)[0]!;
    }
    if (this.#preferNewSite) {
      // The latest newly reached decision gets one early turn, then the oldest task runs.
      let index = this.#queue.length - 1;
      while (
        index >= 0 &&
        (!eligible(this.#queue[index]!) ||
          this.#queue[index]!.queuedAs !== "first-alternative")
      )
        index--;
      if (index >= 0) {
        this.#preferNewSite = false;
        return this.#queue.splice(index, 1)[0]!;
      }
    }
    this.#preferNewSite = true;
    return this.#queue.splice(this.#queue.findIndex(eligible), 1)[0]!;
  }

  *#trialRow(
    domains: ChoiceDomain[],
    target: Map<string, SimulationChoice["answer"]>,
  ): Generator<Proposal> {
    yield {
      row: domains.map((d) => {
        const index = d.candidates.findIndex((c) =>
          isDeepStrictEqual(c.answer, target.get(d.key)),
        );
        return index < 0 ? d.base : index;
      }),
    };
  }

  /** Pair each retained sibling with the first leaf observed at its shared prefix. */
  #exploredForks(): Fork[] {
    const firstLeaf = new Map<Prefix, Prefix>();
    const forks: Fork[] = [];
    for (const path of this.result.paths) {
      const leaf = this.prefixes.get(path.id)!;
      for (
        let prefix: Prefix | undefined = leaf;
        prefix;
        prefix = prefix.parent
      ) {
        const left = firstLeaf.get(prefix);
        if (left) {
          forks.push({ prefix, left, right: leaf });
          break;
        }
        firstLeaf.set(prefix, leaf);
      }
    }
    return forks;
  }

  /** Restore one aligned answer and verify the resulting behavior in the runtime. */
  async #simplify(original: Fork) {
    let current = original;
    const first = compareForks([original])[0];
    if (!first || first.decisions.length < 2) return first;
    const wanted = behaviorSignature(first.right);
    if (behaviorSignature(first.left) === wanted) return first;
    let candidate = first;
    try {
      for (;;) {
        let restored = false;
        for (const change of candidate.decisions) {
          if (this.#stop) throw new BudgetReached(this.#stop);
          if (this.result.paths.length >= this.limits.maxPaths)
            throw new BudgetReached("maxPaths");
          const left = history(current.left)
            .flatMap((n) => n.answers)
            .find(
              (a) =>
                a.position.stage === change.left.position.stage &&
                a.position.index === change.left.position.index &&
                a.site.briefId === change.input.site.briefId &&
                a.site.field === change.input.site.field,
            );
          if (!left)
            throw new Error("Comparison is missing its recorded answer.");
          const nodes = history(current.right);
          const affected = nodes.find((n) =>
            n.answers.some(
              (a) =>
                a.key === left.key &&
                a.position.stage === change.right.position.stage &&
                a.position.index === change.right.position.index,
            ),
          );
          const owner =
            affected?.parent && this.#trialFrontiers.get(affected.parent);
          if (!owner) throw new BudgetReached("maxPendingPrefixes");
          const targets = new Map(
            nodes.flatMap((n) =>
              n.answers.map((a) => [a.key, a.choice.answer] as const),
            ),
          );
          targets.set(left.key, left.choice.answer);
          const scenario: Scenario = {
            trial: true,
            targets,
            reference: { targets },
          };
          const trial = {
            ...owner,
            scenario,
            pending: undefined,
            rows: this.#trialRow(owner.domains, targets),
          };
          const next = await this.#branch(
            trial,
            scenario,
            this.#restore(trial),
          );
          if (!next) continue;
          await this.#walk(next, scenario);
          if (scenario.leaf?.outcome.kind === "limit")
            throw new BudgetReached(scenario.leaf.outcome.limit);
          if (!scenario.leaf) continue;
          const fork = { ...original, right: scenario.leaf };
          const reduced = compareForks([fork])[0];
          if (
            reduced &&
            reduced.decisions.length < candidate.decisions.length &&
            behaviorSignature(reduced.right) === wanted
          ) {
            current = fork;
            candidate = reduced;
            restored = true;
            break;
          }
        }
        if (!restored || candidate.decisions.length === 1) return candidate;
      }
    } catch (error) {
      if (!(error instanceof BudgetReached)) throw error;
      this.#gap(original.prefix, error.limit);
      return { ...first, simplificationLimit: error.limit };
    }
  }

  /** Explore admitted continuations and publish their observed coverage and comparisons. */
  async run(): Promise<void> {
    const arc = this.options.arcRef,
      position = { stage: "trigger" as const, index: 0, reactivationCount: 0 };
    const dialog = this.#dialog(this.#context());
    const initial = this.runtime.startTrigger([], dialog, { arcRefs: [arc] });
    let cursor: Cursor;
    try {
      cursor = this.#save(
        captureState(arc, initial, { calls: [] }),
        dialog,
        { ...position, index: 1 },
        [recordTriggerStart(position, dialog, [arc])],
      );
    } catch (error) {
      if (error instanceof BudgetReached)
        throw new RangeError(
          "Snapshot and initial trigger brief exceed maxRecordBytes.",
        );
      throw error;
    }
    this.#reviewReserve = Math.min(
      512 * 1024,
      Math.floor((this.limits.maxRecordBytes - this.#bytes) / 8),
    );
    await this.#walk(cursor, { targets: new Map() });
    while (this.#queue.length && !this.#stop) {
      const task = this.#dequeue();
      const scenario: Scenario =
        task.queuedAs === "continuation"
          ? task.scenario
          : {
              targets: new Map(task.scenario.targets),
              reference: task.scenario,
            };
      try {
        const cursor = this.#restore(task);
        // Discard already-covered work before attributing a path limit.
        const pending = task.pending;
        const selected = await this.#take(task, cursor);
        if (!selected) continue;
        if (this.result.paths.length >= this.limits.maxPaths)
          throw new BudgetReached("maxPaths");
        // Coverage or admission can skip the ranked row. Schedule its replacement on its own merits.
        if (
          task.preferenceRank !== undefined &&
          this.result.expectation?.status !== "witnessed" &&
          selected.proposal !== pending
        ) {
          task.pending = selected.proposal;
          task.pending.admitted = selected.records;
          await this.#enqueue(task, cursor, task.queuedAs === "continuation");
          continue;
        }
        const next = this.#submit(task, scenario, selected, cursor);
        await this.#enqueue(task, cursor);
        await this.#walk(next, scenario);
      } catch (error) {
        if (!(error instanceof BudgetReached)) throw error;
        this.#stop = error.limit;
        this.#gap(task.prefix, error.limit, task.remaining);
      }
    }
    if (this.#stop)
      for (const task of this.#queue)
        this.#gap(task.prefix, this.#stop, task.remaining);
    this.#queue.length = 0;
    this.#reviewReserve = 0;
    const reviews = [];
    for (const fork of this.#exploredForks()) {
      await this.#tick();
      const review =
        this.options.exploration === "exhaustive"
          ? compareForks([fork])[0]
          : await this.#simplify(fork);
      if (review) {
        try {
          this.#charge(review);
          reviews.push(review);
        } catch (error) {
          if (!(error instanceof BudgetReached)) throw error;
          this.result.completeness.exploration = "limited";
          (
            this.result.unexplored as SimulationResult["unexplored"][number][]
          ).push({ prefixId: fork.prefix.id, reason: error.limit });
          break;
        }
      }
    }
    this.result.comparisons = sortComparisons(reviews);
    this.#trialFrontiers.clear();
    this.#workIds.clear();
    this.#scheduledSites.clear();
    this.#targets.clear();
    this.#groups.clear();
    (this.result.coverage as { nodes: SimulationCoverage["nodes"] }).nodes = [
      ...this.#nodes.values(),
    ];
  }
}
