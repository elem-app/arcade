import type {
  ArcRef,
  ArcTraversalSet,
  BriefId,
  CellValue,
  ChannelSpec,
  Dialog,
  HostCallBrief,
  HostCallReport,
  InstructionBrief,
  JudgmentBrief,
  NodeRef,
  NodeState,
  ObservationMeta,
  ObservationReport,
  ObservedValue,
  PayloadValue,
  RuntimeIssue,
  SemanticText,
} from "@elem-app/arc/types";

import type { ResolvedDocumentSnapshot } from "./host.js";
import type { ReplayPosition, ReplayRecording } from "./replay.js";

/** Definition capture and retention capacity for one simulator service. */
export type SimulatorServiceOptions = {
  /** Capture the requested roots, their transitive imports and the host declarations those documents use. */
  captureSnapshot: (
    roots: readonly ArcRef[],
  ) => Promise<ResolvedDocumentSnapshot>;
  /** Maximum number of simultaneous active and retained simulations. Defaults to eight. */
  maxRetainedSimulations?: number;
};

/** Identifies one retained simulation within its owning service. */
export type SimulationId = string & { readonly __simulationId: unique symbol };
/** Identifies one leaf or shared prefix within a retained simulation. */
export type SimulationPathId = string & {
  readonly __simulationPathId: unique symbol;
};

/** Root, modeled inputs, exploration strategy and budgets for one simulation. */
export type SimulationOptions = {
  arcRef: ArcRef;
  /** Defaults to `"comparisons"`. Use `"exhaustive"` to try every allowed combination of generated answers within the limits. */
  exploration?: "comparisons" | "exhaustive";
  /** Supply a fixed Dialog or compute the next one from committed path history. */
  dialog: Dialog | ((context: SimulationContext) => Dialog);
  /** Extend or replace the generated examples for the current input. Return `undefined` to use the defaults. */
  values?: (
    input: SimulationInput,
    context: SimulationContext,
  ) => SimulationValues | undefined;
  /** Accept a proposed choice or exclude it with a reason recorded in `result.exclusions`. */
  accept?: (
    choice: SimulationChoice,
    context: SimulationContext,
  ) => { accept: true } | { accept: false; reason: string };
  /** Override individual ceilings in {@link SimulationLimits}. Omitted fields use their defaults. */
  limits?: Partial<SimulationLimits>;
};

/** Named, ordered examples that extend or replace the generated input domain. */
export type SimulationValues = {
  mode: "replace" | "extend";
  label: string;
  values: readonly PayloadValue[];
};

/** Runtime work item and optional grouped field that requested an answer. */
export type SimulationSite = {
  sourceRef: NodeRef;
  briefId: BriefId;
  field?: string; // Field name within a grouped observation.
};

/** A reached judgment, observation or host call for which the simulator supplies an answer. */
export type SimulationInput =
  | {
      kind: "judgment";
      site: SimulationSite;
      brief: JudgmentBrief;
    }
  | {
      kind: "observation";
      site: SimulationSite;
      cell: string;
      mode: "observe" | "observeOrAsk";
      question: SemanticText;
      meta: ObservationMeta;
      currentValue?: ObservedValue;
    }
  | {
      kind: "host-call";
      site: SimulationSite;
      brief: HostCallBrief;
      returns?: ChannelSpec;
    };

/** One modeled answer at a particular occurrence of a consultation. */
export type SimulationChoice = {
  input: SimulationInput;
  occurrence: number;
  answer: boolean | ObservationReport | HostCallReport;
};

/** Previously committed choices, traversal state and Dialog available at a frontier. */
export type SimulationContext = {
  stage: "trigger" | "action";
  position: ReplayPosition;
  sourceRef: NodeRef;
  previousDialog: Dialog;
  traversals: ArcTraversalSet;
  choices: readonly SimulationChoice[];
};

/** The recorded stopping condition for a path or an inspectable unfinished prefix. */
export type SimulationOutcome =
  | { kind: "prefix" }
  | { kind: "covered"; returns?: Readonly<Record<string, CellValue>> }
  | { kind: "deflected" }
  | { kind: "not-matched" }
  | { kind: "runtime-issue"; issues: readonly RuntimeIssue[] }
  | { kind: "missing-input"; input: SimulationInput }
  | { kind: "stalled"; position: ReplayPosition; reason: string }
  | { kind: "limit"; limit: keyof SimulationLimits; position?: ReplayPosition };

/** A retained path identifier, its stopping condition and submitted report count. */
export type SimulationPathSummary = {
  id: SimulationPathId;
  outcome: SimulationOutcome;
  reports: number;
};

/** Counts of submitted answers, grouped field pairs and observed node states at reached frontiers. */
export type SimulationCoverage = {
  inputs: readonly {
    prefixId: SimulationPathId;
    site: SimulationSite;
    occurrence: number;
    domain: "finite-complete" | "sampled" | "restricted";
    generated: number;
    exercised: number;
    truncated: boolean;
    gaps: readonly string[];
  }[];
  groups: readonly {
    prefixId: SimulationPathId;
    position: ReplayPosition;
    fieldPairs: number;
    valuePairsExercised: number;
    valuePairsInGeneratedDomains: number;
  }[];
  nodes: readonly {
    ref: NodeRef;
    observedPaths: readonly SimulationPathId[];
    outcomes: readonly NodeState[];
  }[];
};

/** Location, occurrence and provenance of a modeled answer in the replay recording. */
export type SimulationPathChoice = {
  position: ReplayPosition;
  site: SimulationSite;
  occurrence: number;
  candidateIndex: number;
  provenance: "generated" | "current" | "provided" | "unknown";
  label?: string;
};

/** A replay recording with the outcome, modeled choices and ordered JSONL used for author review. */
export type SimulationPath = SimulationPathSummary &
  ReplayRecording & {
    simulationId: SimulationId;
    finalTraversals: ArcTraversalSet;
    traceJsonl: string; // Ordered audit trace, materialized by getPath.
    choices: readonly SimulationPathChoice[];
  };

/** An excerpt linked to its position and path in the recorded execution. */
export type ComparisonEvidence = {
  pathId: SimulationPathId;
  position: ReplayPosition;
  sourceRef?: NodeRef;
  excerpt: string; // From the recorded question, report, instruction or call.
  /** The emitted instruction fields that determine the requested work. */
  instruction?: Pick<
    InstructionBrief,
    "text" | "mode" | "guidance" | "hostParams"
  >;
  application?: "requested" | "applied";
};

/** Work and stopping evidence recorded on one side of a branch. */
export type SimulationComparisonSide = {
  pathId: SimulationPathId;
  work: readonly ComparisonEvidence[];
  lastPosition: ReplayPosition;
  outcome: SimulationOutcome;
};

/** Two recorded continuations from the same prefix with aligned decisions and any other observed differences. */
export type SimulationComparison = {
  sharedPrefixId: SimulationPathId;
  context: readonly ComparisonEvidence[];
  decisions: readonly {
    input: SimulationInput;
    occurrence: number;
    left: ComparisonEvidence;
    right: ComparisonEvidence;
  }[];
  left: SimulationComparisonSide;
  right: SimulationComparisonSide;
  additionalDifferences: readonly ComparisonEvidence[]; // Includes unmatched inputs and changed Dialog.
  simplificationLimit?: keyof SimulationLimits; // The returned pair is the original when this is set.
};

/** Path summaries, comparisons, coverage and unexplored work for one completed simulation. */
export type SimulationResult = {
  id: SimulationId;
  paths: readonly SimulationPathSummary[];
  comparisons: readonly SimulationComparison[];
  coverage: SimulationCoverage;
  completeness: {
    /** Whether the generated examples cover all possible answers at the inputs reached. */
    domains: "finite-complete" | "sampled" | "restricted" | "missing";
    /** Whether exploration covered all allowed combinations of those examples. */
    exploration: "complete" | "sampled" | "limited";
  };
  unexplored: readonly {
    prefixId: SimulationPathId;
    reason: string;
    remainingAlternatives?: string;
  }[];
  exclusions: readonly {
    prefixId: SimulationPathId;
    reason: string;
    count: number;
  }[];
  limits: SimulationLimits;
  model: {
    exploration: "comparisons" | "exhaustive";
    entry: "trigger";
    dialog: "fixed" | "provided";
    scheduling: "apply-before-checks";
    instructionApplication: "assumed";
    hostEffects: "returns-only";
    externalEvents: "excluded";
  };
};

/**
 * Per-run ceilings for exploration, candidate generation and retained evidence.
 * The recording budget includes checkpoint buffers. Materializing a path as JSONL can produce a larger trace.
 */
export type SimulationLimits = {
  maxPaths: number; // 1_000 finished paths.
  maxReportsPerPath: number; // 200, including deterministic handbacks.
  maxTotalReports: number; // 50_000 across the operation.
  maxCandidateCombinations: number; // 100_000, including rejected tuples.
  maxValuesPerInput: number; // 32 concrete values; unknown is additional.
  maxArrayLength: number; // 3.
  maxPendingPrefixes: number; // 2_048 retained frontiers and pending variations.
  maxRecordBytes: number; // 64 * 1024 * 1024 serialized-data bytes.
};
