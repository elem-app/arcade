import type {
  AnswerKind,
  OutboundItem,
  PermissionDecision,
  QuestionFormContent,
  RunStatus,
} from "../types";

export function formatDate(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function displayContent(content: OutboundItem["content"]): string {
  return typeof content === "string"
    ? content
    : JSON.stringify(content, null, 2);
}

export function snippetForContent(content: OutboundItem["content"]): string {
  const firstLine = isQuestionFormContent(content)
    ? snippetForQuestionForm(content)
    : (displayContent(content).split(/\r?\n/, 1)[0] ?? "");
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

export function labelForCause(cause: string): string {
  switch (cause) {
    case "question":
      return "Question";
    case "permission-ask":
      return "Permission request";
    case "reply":
      return "Reply";
    default:
      return "Message";
  }
}

export function causeToKind(cause: string): AnswerKind {
  if (cause === "question") return "question";
  if (cause === "permission-ask") return "permission";
  return "ack-only";
}

export function kindLabel(kind: AnswerKind): string {
  switch (kind) {
    case "question":
      return "question";
    case "permission":
      return "permission";
    case "ack-only":
      return "message";
  }
}

export function glyphForKind(kind: AnswerKind): string {
  return kind === "ack-only" ? "○" : "✓";
}

export function statusBadge(
  status: RunStatus | OutboundItem["status"],
): string {
  switch (status) {
    case "answered":
      return "answered";
    case "acknowledged":
      return "acknowledged";
    default:
      return status;
  }
}

export function permissionDecisionLabel(
  value: string | undefined,
): string | undefined {
  switch (value as PermissionDecision | undefined) {
    case "allow":
      return "Allowed once";
    case "allow_this_run":
      return "Allowed for this run";
    case "deny":
      return "Denied";
    default:
      return undefined;
  }
}

export function resolutionText(item: OutboundItem): string {
  if (item.status === "failed") return "Failed";
  const kind = causeToKind(item.situation.cause);
  if (kind === "ack-only") {
    return item.status === "acknowledged" ? "Acknowledged" : "";
  }
  if (kind === "permission") {
    return permissionDecisionLabel(item.answer?.content) ?? "Resolved";
  }
  return item.answer?.content
    ? `Answered · "${item.answer.content}"`
    : "Answered";
}

export function isQuestionFormContent(
  content: OutboundItem["content"],
): content is QuestionFormContent {
  return (
    typeof content === "object" &&
    content !== null &&
    "kind" in content &&
    content.kind === "question-form" &&
    "questions" in content &&
    Array.isArray(content.questions)
  );
}

function snippetForQuestionForm(content: QuestionFormContent): string {
  const labels = content.questions
    .map((question) => question.header || question.question)
    .filter((value) => value.trim().length > 0);
  if (labels.length === 0) return "Structured question";
  if (labels.length === 1) return labels[0] ?? "Structured question";
  return `${labels[0]} (+${labels.length - 1} more)`;
}

export function isAbsolutePathLike(path: string): boolean {
  const value = path.trim();
  return (
    value.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value)
  );
}
