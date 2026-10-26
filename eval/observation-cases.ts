/**
 * Behavioral scenarios for grouped observations, array observations, and the
 * grouped ask path, shared by the OpenAI and Claude general SDK evals.
 *
 * Each case is decided by Arc control flow over observed cell values: the Arc
 * branches on the observed enum, on an observed array's length, or on an
 * observed string, and each branch writes a different artifact. The worker sees
 * only the instruction of the branch the runtime selected, so the artifact that
 * exists — and the one that does not — reports whether the observed values
 * reached Arc state with their declared types. Artifact facts additionally
 * report the values themselves, rendered from those cells.
 *
 * These inputs are sanitized, incident-inspired, and contain no production user
 * data. The evals that run them use real providers; the deterministic proof that
 * each brief is emitted, resolved, and committed lives in
 * `__tests__/observation-cases.test.ts`.
 */

/** One shared observation scenario. */
export type ObservationCase = {
  name: string;
  /** The exact message submitted to Arcade. */
  inbound: string;
  /** Arc source whose branch is decided by the observed cell values. */
  arcSource: string;
  /** Observed values the Arc must hold, keyed by cell name. */
  observed: Record<string, string | string[]>;
  /** Relative artifact path the selected branch writes. */
  artifact: string;
  /** Substrings the produced artifact must carry. */
  requiredArtifactFacts: readonly string[];
  /** Relative artifact path an unselected branch would have written. */
  unselectedArtifact: string;
  /**
   * The cell whose fact the inbound withholds, with the fixed answer supplied
   * when the worker asks for it. Cases without it forbid questions.
   */
  withheld?: { cell: string; answer: string };
};

/**
 * Grouped observation: one `$observe({ severity, service })` settles an enum and
 * a string together. The enum decides which branch instructs the worker, and the
 * string is rendered into that branch's artifact content.
 */
const GROUPED_OBSERVATION: ObservationCase = {
  name: "grouped-observation",
  inbound: [
    "Our checkout-api has been returning 503s to every customer since 02:10.",
    "Payments are completely blocked, so this is a high severity incident.",
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

  let severity = Enum(["low", "medium", "high"], {
    observing: \`the severity level \${user} reported for this incident\`,
  });
  let service = Str({
    observing: \`the exact name of the failing service \${user} reported\`,
  });
  let escalation = Artifact("escalation.md");
  let standard = Artifact("standard.md");

  $observe({ severity, service });

  if (severity >= "high") {
    $instruct(\`Create \${escalation} whose entire content is exactly this one line: service=\${service}\`);
  } else {
    $instruct(\`Create \${standard} whose entire content is exactly this one line: service=\${service}\`);
  }
}
`,
  observed: { severity: "high", service: "checkout-api" },
  artifact: "escalation.md",
  requiredArtifactFacts: ["service=checkout-api"],
  unselectedArtifact: "standard.md",
};

/**
 * Array observation: one `$observe(regions)` settles an ordered list of region
 * codes. Its length decides the branch, and the whole list renders into the
 * artifact, so the case reports both the element values and their order.
 */
const ARRAY_OBSERVATION: ObservationCase = {
  name: "array-observation",
  inbound: [
    "The outage is spreading across our regions.",
    "It started in us-east-1, then eu-west-2, and now ap-southeast-1 is affected too.",
    "No other region has reported problems.",
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

  let regions = Array(Str({
    observing: \`one region code \${user} reported as affected, in the order they reported them\`,
  }));
  let wide = Artifact("wide.md");
  let narrow = Artifact("narrow.md");

  $observe(regions);

  if (regions.length >= 3) {
    $instruct(\`Create \${wide} whose entire content is exactly this one line: regions=\${regions}\`);
  } else {
    $instruct(\`Create \${narrow} whose entire content is exactly this one line: regions=\${regions}\`);
  }
}
`,
  observed: { regions: ["us-east-1", "eu-west-2", "ap-southeast-1"] },
  artifact: "wide.md",
  requiredArtifactFacts: ["regions=us-east-1,eu-west-2,ap-southeast-1"],
  unselectedArtifact: "narrow.md",
};

/**
 * Grouped ask: the inbound names the owner but not the maintenance window, so
 * the group cannot settle from conversation alone. The worker asks the user for
 * the missing field, and the group commits both fields together — the branch
 * proves the observed owner landed, and the artifact content proves the answered
 * window landed in the same commit.
 */
const GROUPED_ASK: ObservationCase = {
  name: "grouped-observe-or-ask",
  inbound: [
    "Filing the follow-up for last night's outage.",
    "Owner: payments-platform.",
    "Please schedule the remediation work.",
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

  let owner = Str({
    observing: \`the exact team identifier \${user} named as the incident owner\`,
  });
  let maintenanceWindow = Str({
    observing: \`the maintenance window \${user} wants for the remediation work; ask \${user} for it when they have not stated one\`,
  });
  let plan = Artifact("plan.md");
  let unowned = Artifact("unowned.md");

  $observeOrAsk({ owner, maintenanceWindow });

  if (owner == "payments-platform") {
    $instruct(\`Create \${plan} whose entire content is exactly this one line: window=\${maintenanceWindow}\`);
  } else {
    $instruct(\`Create \${unowned} whose entire content is exactly this one line: window=\${maintenanceWindow}\`);
  }
}
`,
  observed: {
    owner: "payments-platform",
    maintenanceWindow: "Saturday 02:00-04:00 UTC",
  },
  artifact: "plan.md",
  requiredArtifactFacts: ["window=Saturday 02:00-04:00 UTC"],
  unselectedArtifact: "unowned.md",
  withheld: {
    cell: "maintenanceWindow",
    answer: "Saturday 02:00-04:00 UTC",
  },
};

/** The shared observation scenario corpus. */
export function observationCases(): ObservationCase[] {
  return [
    GROUPED_OBSERVATION,
    ARRAY_OBSERVATION,
    GROUPED_ASK,
    GUIDED_OBSERVATION,
  ];
}

const GUIDED_OBSERVATION: ObservationCase = {
  name: "standing-guidance-observation",
  inbound:
    "Current record: service=checkout-api, severity=high. Archived record: service=ledger-api, severity=low. Prepare the selected incident record.",
  arcSource: `
"arc";
function Main() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "writer" };
  this.guidance = \`For this workflow, selected always means the archived record. Extract both fields from that record, even when the current record describes a more severe incident.\`;
  let severity = Enum(["low", "high"], { observing: \`the selected incident severity\` });
  let service = Str({ observing: \`the selected service name\` });
  let selected = Artifact("selected.md");
  let other = Artifact("other.md");
  $observe({ severity, service });
  if (severity == "low") {
    $instruct(\`Create \${selected} with exactly this one line: service=\${service};severity=\${severity}\`);
  } else {
    $instruct(\`Create \${other} with exactly this one line: service=\${service};severity=\${severity}\`);
  }
}
`,
  observed: { severity: "low", service: "ledger-api" },
  artifact: "selected.md",
  requiredArtifactFacts: ["service=ledger-api;severity=low"],
  unselectedArtifact: "other.md",
};
