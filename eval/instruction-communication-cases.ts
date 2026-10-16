import { randomUUID } from "node:crypto";

export type CommunicationDecisionCase = {
  name: string;
  /** The exact message submitted to Arcade for this case. */
  inbound: string;
  source: string;
  expected?: { audience: string; content: string };
  /**
   * Fail the case if the worker asks any question. Set only where the reply
   * content lives solely in the inbound, so a question would be an attempt to
   * recover it. Other cases tolerate a clarifying question (a worker may
   * reasonably ask who to address when an instruction names no participant).
   */
  forbidQuestions?: boolean;
};

export function communicationDecisionCases(
  _prefix: string,
): CommunicationDecisionCase[] {
  const replyToUser = `The reply marker is ${randomUUID()}.`;
  const showUser = `The shown marker is ${randomUUID()}.`;
  const notifySupervisor = `The supervisor marker is ${randomUUID()}.`;
  const replyWithoutParticipant = `The private reply marker is ${randomUUID()}.`;
  const showWithoutParticipant = `The private show marker is ${randomUUID()}.`;
  const notifyWithoutParticipant = `The private notice marker is ${randomUUID()}.`;
  const optionalFeedbackQuestion = `What optional comments do you have on draft ${randomUUID()}?`;
  const analyzeUser = `the analysis marker ${randomUUID()}`;
  // The reply content for this case lives ONLY in the inbound message; the Arc
  // instruction never repeats it.
  const replyFromUserRequest = `release the hold on order ${randomUUID()}`;
  const caseInbound = (name: string): string =>
    `Run the ${name} communication case.`;
  return [
    {
      name: "reply-to-user",
      inbound: caseInbound("reply-to-user"),
      source: communicationDecisionEvalArc(
        oneWayCommunicationInstruction("Reply to", "${user}", replyToUser),
      ),
      expected: { audience: "originator", content: replyToUser },
    },
    {
      name: "show-user",
      inbound: caseInbound("show-user"),
      source: communicationDecisionEvalArc(
        oneWayCommunicationInstruction("Show", "${user}", showUser),
      ),
      expected: { audience: "originator", content: showUser },
    },
    {
      name: "notify-supervisor",
      inbound: caseInbound("notify-supervisor"),
      source: communicationDecisionEvalArc(
        oneWayCommunicationInstruction(
          "Notify",
          "${Audience.supervisor}",
          notifySupervisor,
        ),
        { audienceImport: true },
      ),
      expected: { audience: "supervisor", content: notifySupervisor },
    },
    {
      name: "reply-from-user-request",
      inbound: `Reply to me with exactly this text and nothing else: ${replyFromUserRequest}`,
      source: communicationDecisionEvalArc(
        `Reply to \${user} with exactly the message they asked you to send in their latest message, and no other text.`,
      ),
      expected: { audience: "originator", content: replyFromUserRequest },
      forbidQuestions: true,
    },
    {
      name: "send-question-without-waiting",
      inbound: caseInbound("send-question-without-waiting"),
      source: communicationDecisionEvalArc(
        `Send \${user} exactly this one-way message: "${optionalFeedbackQuestion}"
Continue immediately without waiting for or using an answer.`,
      ),
      expected: {
        audience: "originator",
        content: optionalFeedbackQuestion,
      },
      forbidQuestions: true,
    },
    {
      name: "reply-without-participant",
      inbound: caseInbound("reply-without-participant"),
      source: communicationDecisionEvalArc(
        `Reply with exactly: ${replyWithoutParticipant}`,
      ),
    },
    {
      name: "show-without-participant",
      inbound: caseInbound("show-without-participant"),
      source: communicationDecisionEvalArc(
        `Show exactly: ${showWithoutParticipant}`,
      ),
    },
    {
      name: "notify-without-participant",
      inbound: caseInbound("notify-without-participant"),
      source: communicationDecisionEvalArc(
        `Notify with exactly: ${notifyWithoutParticipant}`,
      ),
    },
    {
      name: "analyze-user-without-communication",
      inbound: caseInbound("analyze-user-without-communication"),
      source: communicationDecisionEvalArc(
        `Analyze whether \${user} mentioned ${analyzeUser}; no written analysis is required.`,
      ),
    },
  ];
}

function oneWayCommunicationInstruction(
  verb: string,
  audience: string,
  content: string,
): string {
  return `${verb} ${audience} with exactly the text inside <message> below and no other text:
<message>${content}</message>`;
}

function communicationDecisionEvalArc(
  instruction: string,
  options: { audienceImport?: boolean } = {},
): string {
  return `
"arc";

${options.audienceImport ? 'import Audience from "host:audience";' : ""}

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  $instruct(\`${instruction}\`);
}
`;
}

export function audienceQuestionEvalArc(outputArtifact: string): string {
  return `
"arc";

import Audience from "host:audience";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  let output = Artifact("${outputArtifact}");
  $instruct(\`Ask \${user} exactly: "What user token should I record?"
Ask \${Audience.supervisor} exactly: "What supervisor token should I record?"
Wait for both answers before continuing.
Create or overwrite \${output} with exactly these two lines, replacing each placeholder with the answer you received:
user=<answer from user>
supervisor=<answer from supervisor>
Do not include any extra text.\`);
}
`;
}

export function freeformQuestionEvalArc(
  outputArtifact: string,
  draftMarker: string,
): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  let output = Artifact("${outputArtifact}");
  $instruct(\`Ask \${user} exactly: "What unconstrained feedback do you have on draft ${draftMarker}?"
Do not offer predefined options.
Wait for the answer before continuing.
The participant will answer with one opaque token. Treat the returned token as their complete answer.
Create or overwrite \${output} with exactly that token and no extra text.\`);
}
`;
}

export function promptlessDiscussionEvalArc(message: string): string {
  return `
"arc";

function Main() {
  this.trigger = () => {
    return true;
  };
  this.hostParams = {
    workerRole: "writer",
  };
  $instruct(\`Send \${user} exactly the text inside <message> below and no other text:
<message>${message}</message>
Then pause here and hear their reply before finishing.\`);
}
`;
}
