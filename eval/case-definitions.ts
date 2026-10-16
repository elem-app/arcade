import type { EvalCaseMetadata } from "./types.js";

function definition(
  id: string,
  title: string,
  smoke = false,
): EvalCaseMetadata {
  return {
    id,
    title,
    profile: smoke ? "smoke" : "extended",
  };
}

export const CASES = {
  sdkSessionContinuity: definition(
    "sdk-session-continuity",
    "preserves SDK session continuity and workspace cwd",
    true,
  ),
  contextVisibilityRole: definition(
    "context-visibility-role",
    "shares provider-private context between same-role nodes",
  ),
  contextVisibilityNode: definition(
    "context-visibility-node",
    "isolates provider-private context between node-owned sessions",
  ),
  replyToUser: definition("reply-to-user", "replies to the originator"),
  showUser: definition("show-user", "shows content to the originator"),
  notifySupervisor: definition(
    "notify-supervisor",
    "notifies a named supervisor audience",
  ),
  replyFromUserRequest: definition(
    "reply-from-user-request",
    "preserves inbound-only reply content",
    true,
  ),
  sendQuestionWithoutWaiting: definition(
    "send-question-without-waiting",
    "sends question-shaped content without waiting",
    true,
  ),
  replyWithoutParticipant: definition(
    "reply-without-participant",
    "keeps an unaudienced reply private",
  ),
  showWithoutParticipant: definition(
    "show-without-participant",
    "keeps unaudienced shown content private",
  ),
  notifyWithoutParticipant: definition(
    "notify-without-participant",
    "keeps an unaudienced notification private",
  ),
  analyzeUserWithoutCommunication: definition(
    "analyze-user-without-communication",
    "does not infer communication from analysis",
  ),
  audienceQuestion: definition(
    "audience-question",
    "asks the originator and a named audience",
    true,
  ),
  freeformQuestion: definition(
    "freeform-question",
    "waits for a freeform originator answer",
    true,
  ),
  promptlessDiscussion: definition(
    "promptless-discussion",
    "pauses for feedback established by prior outbound context",
    true,
  ),
  sdkPauseResume: definition(
    "sdk-pause-resume",
    "pauses and resumes the same SDK routine",
  ),
  userRequestFidelity: definition(
    "user-request-fidelity",
    "preserves realistic inbound-only request facts",
    true,
  ),
  distributedInformation: definition(
    "distributed-information",
    "combines inbound and Arc-authored facts",
  ),
  groupedObservation: definition(
    "grouped-observation",
    "commits grouped observation values",
  ),
  arrayObservation: definition(
    "array-observation",
    "commits ordered array observation values",
  ),
  groupedObserveOrAsk: definition(
    "grouped-observe-or-ask",
    "commits observed and asked values together",
    true,
  ),
  claudePreparedInstructionStart: definition(
    "claude-prepared-instruction-start",
    "uses a prepared Claude instruction start",
  ),
  claudeArtifactHandoff: definition(
    "claude-artifact-handoff",
    "passes an artifact between Claude workers",
    true,
  ),
  claudeFilesystemPermission: definition(
    "claude-filesystem-permission",
    "resolves a Claude filesystem permission ask",
  ),
  claudeFastTriggerPool: definition(
    "claude-fast-trigger-pool",
    "uses and replenishes the Claude trigger-stage pool",
    true,
  ),
  openaiFastTriggerResolution: definition(
    "openai-fast-trigger-resolution",
    "resolves a semantic trigger with OpenAI",
    true,
  ),
  mcpActiveRunChoice: definition(
    "mcp-active-run-choice",
    "selects an existing active run through MCP",
    true,
  ),
  mcpWorkspaceDesignation: definition(
    "mcp-workspace-designation",
    "resolves a workspace handshake through MCP",
    true,
  ),
  mcpDeflectedRunReentry: definition(
    "mcp-deflected-run-reentry",
    "re-enters a pinned deflected run through MCP",
  ),
  mcpMixedRunChoice: definition(
    "mcp-mixed-run-choice",
    "chooses deflected and fresh among mixed MCP candidates",
  ),
} as const;

export const COMMUNICATION_CASES = [
  CASES.replyToUser,
  CASES.showUser,
  CASES.notifySupervisor,
  CASES.replyFromUserRequest,
  CASES.sendQuestionWithoutWaiting,
  CASES.replyWithoutParticipant,
  CASES.showWithoutParticipant,
  CASES.notifyWithoutParticipant,
  CASES.analyzeUserWithoutCommunication,
] as const;

export const CONTEXT_CASES = [
  CASES.contextVisibilityRole,
  CASES.contextVisibilityNode,
] as const;

export const BEHAVIORAL_CASES = [
  CASES.userRequestFidelity,
  CASES.distributedInformation,
] as const;

export const OBSERVATION_CASES = [
  CASES.groupedObservation,
  CASES.arrayObservation,
  CASES.groupedObserveOrAsk,
] as const;
