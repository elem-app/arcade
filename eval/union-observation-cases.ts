import type { ObservationCase } from "./observation-cases.js";

/** Union observations shared by action and trigger evals. */
export type UnionObservationCase = {
  name: "union-observation" | "union-container-observation";
  declaration: string;
  observe: string;
  condition: string;
  rendered: string;
  expectedText: string;
  inbound: string;
  observed: ObservationCase["observed"];
  negativeInbound: string;
  negativeObserved: ObservationCase["observed"];
};

const SCORE_MEMBERS = `[
    RangedInt(1, 5),
    Num({ observeAs: { kind: "number", min: 3, max: 10 } }),
    Enum(["no_preference"])
  ]`;

const HOUR_DECLARATION = `
  let hour = Union([Num(), Enum(["no_preference"])], {
    observing: \`the meeting hour requested by \${user}, or no_preference when they explicitly say they have no preference about the hour\`,
  });`;

export function unionValueCases(): UnionObservationCase[] {
  return [
    {
      name: "union-observation",
      declaration: `
  let first = Union(${SCORE_MEMBERS}, { observing: \`the first score supplied by \${user}, or their explicit lack of preference for it\` });
  let second = Union(${SCORE_MEMBERS}, { observing: \`the second score supplied by \${user}, or their explicit lack of preference for it\` });
  let waived = Union(${SCORE_MEMBERS}, { observing: \`the third score supplied by \${user}, or their explicit lack of preference for it\` });`,
      observe: "$observe({ first, second, waived });",
      condition:
        '!first.isUnset() && !second.isUnset() && !waived.isUnset() && first != "no_preference" && second != "no_preference" && first < second && waived == "no_preference"',
      rendered: "first=${first};second=${second};third=${waived}",
      expectedText: "first=4;second=7.5;third=no_preference",
      inbound:
        "My first score is 4 and my second score is 7.5. For the third score, I have no preference.",
      observed: { first: 4, second: 7.5, waived: "no_preference" },
      negativeInbound: "My first score is 4 and my second score is 7.5.",
      negativeObserved: { first: 4, second: 7.5, waived: undefined },
    },
    {
      name: "union-container-observation",
      declaration: `
  let request = Struct({
    scores: Array(Union(${SCORE_MEMBERS}, { observing: \`each requested score in order, or no_preference for an explicitly unspecified score\` })),
  }, { observing: \`the requested score list supplied by \${user}\` });
  let batches = Array(Struct({
    label: Str({ observing: \`the exact batch label\` }),
    score: Union(${SCORE_MEMBERS}, { observing: \`this batch's requested score, or no_preference for an explicit lack of preference\` }),
  }, { observing: \`the batches in the order supplied by \${user}\` }));`,
      observe: "$observe({ request, batches });",
      condition:
        '!request.isUnset() && !batches.isUnset() && request.scores.length == 3 && request.scores[0] < request.scores[1] && request.scores[2] == "no_preference" && batches.length == 2 && batches[0].score == "no_preference" && batches[1].score != "no_preference"',
      rendered:
        "scores=${request.scores};batches=${batches[0].label}:${batches[0].score},${batches[1].label}:${batches[1].score}",
      expectedText:
        "scores=4,7.5,no_preference;batches=gamma:no_preference,delta:4",
      inbound:
        "Requested scores, in order: 4, 7.5, and no preference for the third score. Batches, in order: gamma has no score preference; delta requests a score of 4.",
      observed: {
        request: { scores: [4, 7.5, "no_preference"] },
        batches: [
          { label: "gamma", score: "no_preference" },
          { label: "delta", score: 4 },
        ],
      },
      negativeInbound:
        "Requested scores, in order: 7.5, 4, and no preference for the third score. Batches, in order: gamma requests a score of 4; delta has no score preference.",
      negativeObserved: {
        request: { scores: [7.5, 4, "no_preference"] },
        batches: [
          { label: "gamma", score: 4 },
          { label: "delta", score: "no_preference" },
        ],
      },
    },
  ];
}

export function unionObservationCases(): ObservationCase[] {
  return [
    ...unionValueCases().map(
      (item): ObservationCase => ({
        name: item.name,
        inbound: item.inbound,
        observed: item.observed,
        artifact: "selected.md",
        requiredArtifactFacts: [item.expectedText],
        unselectedArtifact: "other.md",
        arcSource: actionSource(
          item.declaration,
          item.observe,
          item.condition,
          item.rendered,
        ),
      }),
    ),
    {
      name: "union-unknown-observation",
      inbound: "Please record this meeting request under project ORBIT-7.",
      observed: { hour: undefined },
      artifact: "selected.md",
      requiredArtifactFacts: ["hour=unknown"],
      unselectedArtifact: "other.md",
      arcSource: actionSource(
        HOUR_DECLARATION,
        "$observe(hour);",
        "hour.isUnset()",
        "hour=unknown",
      ),
    },
    {
      name: "union-observe-or-ask",
      inbound: "Please record this meeting request under project ORBIT-7.",
      observed: { hour: "no_preference" },
      withheld: [
        {
          cell: "hour",
          audience: "originator",
          answer: "I have no preference about the meeting hour.",
        },
      ],
      artifact: "selected.md",
      requiredArtifactFacts: ["hour=no_preference"],
      unselectedArtifact: "other.md",
      arcSource: actionSource(
        HOUR_DECLARATION,
        "$observeOrAsk(hour);",
        'hour == "no_preference"',
        "hour=${hour}",
      ),
    },
  ];
}

function actionSource(
  declaration: string,
  observe: string,
  condition: string,
  rendered: string,
): string {
  return `"arc";
function Main() {
  this.trigger = () => true;
  this.hostParams = { workerRole: "writer" };
${declaration}
  let selected = Artifact("selected.md");
  let other = Artifact("other.md");
  ${observe}
  if (${condition}) {
    $instruct(\`Create \${selected} whose entire content is exactly this one line: ${rendered}\`);
  } else {
    $instruct(\`Create \${other} whose entire content is exactly this one line: unexpected observation\`);
  }
}`;
}

export function unionTriggerSource(item: UnionObservationCase): string {
  return `"arc";
function Main() {
  this.hostParams = { workerRole: "triager" };
${item.declaration}
  this.trigger = () => {
    ${item.observe}
    return ${item.condition};
  };
}`;
}
