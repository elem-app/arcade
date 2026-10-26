import type { WorkEvent } from "../types";

const DEFAULT_WORKER_ROLE = "$default-worker";

export function isPauseableWorkEvent(event: WorkEvent): boolean {
  switch (event.kind) {
    case "routine:started":
    case "tool:started":
    case "blocked:question":
    case "blocked:permission":
      return true;
    case "asks:invalidated":
    case "run:handshake-pending":
    case "run:handshake-resolved":
    case "run:deflection-occurred":
    case "run:interruption-occurred":
    case "run:started":
    case "run:completed":
    case "run:deflected":
    case "run:poisoned":
      return false;
    case "routine:finished":
    case "routine:failed":
    case "routine:skipped":
    case "routine:capacity-limited":
    case "routine:transport-lost":
    case "routine:usage":
    case "tool:finished":
    case "tool:failed":
    case "control:pause-requested":
    case "control:paused":
    case "control:resume-requested":
    case "control:resumed":
    case "node:entered":
    case "node:exited":
      return false;
    default:
      return assertNever(event);
  }
}

export function formatWorkEventScope(event: WorkEvent): string {
  switch (event.kind) {
    case "asks:invalidated":
    case "run:handshake-pending":
    case "run:handshake-resolved":
    case "run:deflection-occurred":
    case "run:interruption-occurred":
    case "run:started":
    case "run:completed":
    case "run:deflected":
    case "run:poisoned":
    case "control:pause-requested":
    case "control:paused":
    case "control:resume-requested":
    case "control:resumed":
      return "Run";
  }
  return event.role === DEFAULT_WORKER_ROLE
    ? event.nodeName
    : `${event.nodeName} <${event.role}>`;
}

export function formatWorkEventText(event: WorkEvent): string {
  switch (event.kind) {
    case "asks:invalidated":
      return "Pending asks invalidated";
    case "run:handshake-pending":
      return "Handshake pending";
    case "run:handshake-resolved":
      return `Handshake resolved: ${event.outcome.kind}`;
    case "run:started":
      return `Run started: ${event.route}`;
    case "run:completed":
      return "Run completed";
    case "run:deflection-occurred":
      return "Deflection occurred";
    case "run:interruption-occurred":
      return "Interruption occurred";
    case "run:deflected":
      return "Run deflected";
    case "run:poisoned":
      return "Run poisoned";
    case "routine:started":
      return "Routine started";
    case "routine:finished":
      return event.disposition === "deflect"
        ? "Routine deflected"
        : event.disposition === "interrupt"
          ? "Routine interrupted"
          : "Routine completed";
    case "routine:failed":
      return "Routine failed";
    case "routine:skipped":
      return "Routine skipped";
    case "routine:capacity-limited":
      return `Capacity-limited: ${event.capacityReason.reason}`;
    case "routine:transport-lost":
      return `Transport lost: ${event.transportReason.reason}`;
    case "routine:usage":
      return "Usage recorded";
    case "tool:started":
    case "tool:finished":
    case "tool:failed":
      return formatToolEventText(event);
    case "blocked:question":
      return "Waiting for answer";
    case "blocked:permission":
      return "Waiting for permission";
    case "control:pause-requested":
      return "Pause requested";
    case "control:paused":
      return "Paused";
    case "control:resume-requested":
      return "Resume requested";
    case "control:resumed":
      return "Resumed";
    case "node:entered":
      return "Entered node";
    case "node:exited":
      return "Exited node";
    default:
      return assertNever(event);
  }
}

export function formatWorkEventDetail(event: WorkEvent): string | undefined {
  switch (event.kind) {
    case "asks:invalidated":
      return event.askIds.join(", ");
    case "run:handshake-pending":
      return event.handshakeId;
    case "run:handshake-resolved":
      return `${event.handshakeId}${"arcRunId" in event.outcome ? ` → ${event.outcome.arcRunId}` : ""}`;
    case "run:deflection-occurred":
      return event.origin;
    case "run:interruption-occurred":
      return event.interruption.reason || event.interruption.id;
    case "run:started":
      return event.route;
    case "run:completed":
    case "run:deflected":
      return undefined;
    case "run:poisoned":
      return (
        [...event.issues, ...event.instructionIssues]
          .map((issue) => JSON.stringify(issue))
          .join("; ") || undefined
      );
    case "routine:started":
    case "routine:finished":
    case "routine:failed":
    case "routine:skipped":
    case "tool:started":
    case "tool:finished":
    case "tool:failed":
      return event.error?.message;
    case "routine:capacity-limited":
      return event.capacityReason.message;
    case "routine:transport-lost":
      return event.transportReason.message;
    case "routine:usage":
      return formatRoutineUsage(event.tokenUsage);
    case "blocked:question":
    case "blocked:permission":
      return event.audience;
    case "control:pause-requested":
    case "control:paused":
    case "control:resume-requested":
    case "control:resumed":
      return event.routineId;
    case "node:entered":
    case "node:exited":
      return event.nodeDescription;
    default:
      return assertNever(event);
  }
}

export function formatWorkEventOutcome(event: WorkEvent): string | undefined {
  switch (event.kind) {
    case "asks:invalidated":
      return "superseded";
    case "run:handshake-pending":
      return "pending";
    case "run:handshake-resolved":
      return event.outcome.kind;
    case "run:deflection-occurred":
    case "run:interruption-occurred":
      return undefined;
    case "run:started":
      return event.route;
    case "run:completed":
      return "completed";
    case "run:deflected":
      return "deflected";
    case "run:poisoned":
      return "poisoned";
    case "routine:started":
    case "routine:finished":
    case "routine:failed":
    case "routine:skipped":
      return event.disposition ?? event.outcome ?? event.error?.code;
    case "routine:capacity-limited":
      return event.capacityReason.reason;
    case "routine:transport-lost":
      return event.transportReason.reason;
    case "routine:usage":
      return undefined;
    case "tool:started":
    case "tool:finished":
    case "tool:failed":
      return event.outcome ?? event.error?.code;
    case "blocked:question":
      return "question";
    case "blocked:permission":
      return "permission";
    case "control:pause-requested":
    case "control:paused":
    case "control:resume-requested":
    case "control:resumed":
      return undefined;
    case "node:entered":
    case "node:exited":
      return undefined;
    default:
      return assertNever(event);
  }
}

function formatToolEventText(
  event: Extract<WorkEvent, { kind: `tool:${string}` }>,
): string {
  if (event.kind === "tool:started") {
    return `Using ${formatToolName(event.toolName)}`;
  }
  if (event.kind === "tool:failed") {
    return `${formatToolName(event.toolName)} failed`;
  }
  switch (event.outcome) {
    case "sent":
      return "Sent message";
    case "answered":
      return "Received answer";
    case "allow":
      return "Permission allowed";
    case "deny":
      return "Permission denied";
    case "allow_this_run":
      return "Permission allowed for this run";
    case "ignored":
      return "Tool ignored";
    default:
      return `${formatToolName(event.toolName)} finished`;
  }
}

function formatRoutineUsage(
  tokenUsage: Extract<WorkEvent, { kind: "routine:usage" }>["tokenUsage"],
): string | undefined {
  const parts = [
    formatOptionalCount(tokenUsage.requests, "request"),
    formatTokenCount(tokenUsage),
    formatCost(tokenUsage.costUsd),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function formatTokenCount(
  tokenUsage: Extract<WorkEvent, { kind: "routine:usage" }>["tokenUsage"],
): string | undefined {
  if (tokenUsage.totalTokens !== undefined) {
    return `${formatInteger(tokenUsage.totalTokens)} tokens`;
  }
  const input = formatOptionalCount(tokenUsage.inputTokens, "input token");
  const output = formatOptionalCount(tokenUsage.outputTokens, "output token");
  return [input, output].filter(Boolean).join(", ") || undefined;
}

function formatCost(costUsd: number | undefined): string | undefined {
  if (costUsd === undefined) return undefined;
  const precision = costUsd > 0 && costUsd < 0.01 ? 4 : 2;
  return `$${costUsd.toFixed(precision)}`;
}

function formatOptionalCount(
  value: number | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  return `${formatInteger(value)} ${value === 1 ? label : `${label}s`}`;
}

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatToolName(toolName: string): string {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function assertNever(value: never): never {
  throw new Error(`Unhandled work event: ${JSON.stringify(value)}`);
}
