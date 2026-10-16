/**
 * Realistic behavioral scenarios shared by the OpenAI and Claude general SDK
 * evals. Each scenario carries every distinguishing fact in exactly one source
 * — the inbound user message, the Arc instruction, or an output artifact — and
 * forbids the worker from recovering a missing fact through a question.
 *
 * These inputs are sanitized, incident-inspired, and contain no production user
 * data. The evals that run them use real providers; the deterministic proof that
 * each source is rendered into the provider input lives in the always-on
 * context-propagation and task-renderer tests.
 */

/**
 * A required fact: a substring the worker must carry through, or a set of
 * accepted synonyms (any one satisfies it) for facts with a standard
 * abbreviation. Matching is on the essential token, not its decoration — the
 * fact is the identifier "2.4.0", not the stylistic "v2.4.0".
 */
export type RequiredFact = string | readonly string[];

/** One shared behavioral scenario. */
export type BehavioralScenario = {
  name: string;
  /** The exact message submitted to Arcade; the only place inbound-only facts live. */
  inbound: string;
  /** Arc source whose instruction refers to the latest request without repeating its facts. */
  arcSource: string;
  /** Facts the worker's reply to the originator must carry. */
  requiredReplyFacts?: readonly RequiredFact[];
  /** Maximum word count the reply must respect, when the request constrains length. */
  maxReplyWords?: number;
  /** Relative artifact path the case inspects, when the scenario produces one. */
  artifact?: string;
  /** Facts the produced artifact must carry. */
  requiredArtifactFacts?: readonly RequiredFact[];
};

/**
 * User-request fidelity: version, feature, compatibility warning, audience, and
 * length constraint exist only in the inbound. The Arc tells the worker to carry
 * out the latest request and reply; it repeats none of those facts.
 */
const USER_REQUEST_FIDELITY: BehavioralScenario = {
  name: "user-request-fidelity",
  inbound: [
    "Draft the release note for v2.4.0.",
    "It ships single sign-on, and it must warn that plugins below v2.0 are incompatible.",
    "Requirements: include the exact strings v2.4.0, single sign-on, and v2.0;",
    "begin with a line naming the intended audience — enterprise administrators;",
    "and keep the whole note under 70 words.",
    "Reply to me with the finished note.",
  ].join(" "),
  arcSource: `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  $instruct(\`Carry out the latest release-note request from \${user} and reply to \${user} with the finished release note. Follow every requirement stated in their latest message exactly.\`);
}
`,
  requiredReplyFacts: [
    "v2.4.0",
    "single sign-on",
    "v2.0",
    "enterprise administrators",
  ],
  maxReplyWords: 70,
};

/**
 * Distributed information: budget, deadline, and compliance requirement exist
 * only in the inbound; the decision format, output artifact, and approval
 * threshold are authored in the Arc instruction. The worker must combine all
 * sources without asking a recovery question.
 *
 * The approval threshold lives in the Arc instruction rather than a separate Arc
 * cell: rendering a resolved primitive cell into the prompt is proven by
 * the task-renderer unit test, so the eval keeps a single Arc-authored source.
 */
const DISTRIBUTED_INFORMATION: BehavioralScenario = {
  name: "distributed-information",
  inbound: [
    "Review this vendor request.",
    "The requested budget is $45,000, the decision deadline is March 14, and the vendor must satisfy SOC 2 compliance.",
  ].join(" "),
  arcSource: `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  let decision = Artifact("decision.md");
  $instruct(\`Record an approval decision in \${decision} using exactly this format:
Decision: <Approve or Reject>
Rationale: <one sentence>
Approve only when the budget requested in the latest user message is at or below the approval threshold of $50,000. In your rationale, copy the requested budget, decision deadline, and compliance requirement from the latest user message exactly as written, character for character.\`);
}
`,
  artifact: "decision.md",
  requiredArtifactFacts: [
    ["$45,000", "45,000"],
    "March 14",
    ["SOC 2", "SOC2"],
    "Decision:",
    "Approve",
  ],
};

/** The shared behavioral scenario corpus. */
export function behavioralScenarios(): BehavioralScenario[] {
  return [USER_REQUEST_FIDELITY, DISTRIBUTED_INFORMATION];
}

/** Count whitespace-delimited words in a reply for length-constraint checks. */
export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Case-insensitive containment for a required fact. Workers preserve a fact's
 * substance but vary its casing ("single sign-on" vs "Single Sign-On"), so facts
 * are matched without regard to case; a synonym set is satisfied by any member.
 */
export function containsFact(haystack: string, fact: RequiredFact): boolean {
  const options = typeof fact === "string" ? [fact] : fact;
  const lower = haystack.toLowerCase();
  return options.some((option) => lower.includes(option.toLowerCase()));
}
