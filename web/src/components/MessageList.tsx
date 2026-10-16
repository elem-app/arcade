import type {
  ExecutionControlView,
  OutboundItem,
  PermissionDecision,
  WorkEvent,
} from "../types";
import { MessageRow } from "./MessageRow";
import {
  formatWorkEventDetail,
  formatWorkEventOutcome,
  formatWorkEventScope,
  formatWorkEventText,
  isPauseableWorkEvent,
} from "./workEventStatus";

type MessageListProps = {
  messages: OutboundItem[];
  workEvents: WorkEvent[];
  pause?: ExecutionControlView;
  expandedAnswered: Set<string>;
  answerDrafts: Record<string, string>;
  busyMessageId?: string;
  busyRunId?: string;
  onToggleExpanded(id: string): void;
  onDraftChange(key: string, value: string): void;
  onAnswer(id: string, content: string): void;
  onPermission(id: string, decision: PermissionDecision): void;
  onAck(id: string): void;
  onPauseRun(arcRunId: string): void;
  onContinueRun(arcRunId: string): void;
};

export function MessageList({
  messages,
  workEvents,
  pause,
  expandedAnswered,
  answerDrafts,
  busyMessageId,
  busyRunId,
  onToggleExpanded,
  onDraftChange,
  onAnswer,
  onPermission,
  onAck,
  onPauseRun,
  onContinueRun,
}: MessageListProps) {
  const latestWorkEvent = latestWorkEventIn(workEvents);
  const ordered = [...messages].sort(compareMessagesChronological);

  return (
    <div className="msg-list">
      {latestWorkEvent ? (
        <WorkEventStatusBar
          event={latestWorkEvent}
          pause={pause}
          busy={busyRunId === latestWorkEvent.arcRunId}
          onPauseRun={onPauseRun}
          onContinueRun={onContinueRun}
        />
      ) : null}
      {ordered.map((item) => (
        <MessageRow
          key={`message:${item.id}`}
          item={item}
          expanded={expandedAnswered.has(item.id)}
          answerDrafts={answerDrafts}
          busy={busyMessageId === item.id}
          onToggleExpanded={onToggleExpanded}
          onDraftChange={onDraftChange}
          onAnswer={onAnswer}
          onPermission={onPermission}
          onAck={onAck}
        />
      ))}
    </div>
  );
}

function WorkEventStatusBar({
  event,
  pause,
  busy,
  onPauseRun,
  onContinueRun,
}: {
  event: WorkEvent;
  pause?: ExecutionControlView;
  busy: boolean;
  onPauseRun(arcRunId: string): void;
  onContinueRun(arcRunId: string): void;
}) {
  const pauseStatus = pause?.status ?? "running";
  const capacityLimited = pauseStatus === "capacity-limited";
  const transportLost = pauseStatus === "transport-lost";
  // Both sibling parks (capacity-limited and transport-lost) park the run and
  // recover the same way, so they share the Retry button and auto-retry banner.
  const parked = capacityLimited || transportLost;
  const canContinue = pauseStatus === "paused";
  const showPausing =
    pauseStatus === "pauseRequested" ||
    (pauseStatus !== "inactive" &&
      busy &&
      !canContinue &&
      !parked &&
      isPauseableWorkEvent(event));
  const canPause =
    pause !== undefined &&
    pauseStatus === "running" &&
    !showPausing &&
    isPauseableWorkEvent(event);
  // A parked run reuses the execution-control slot for a manual retry, which
  // resumes the parked routine (and resets the auto-retry budget). Narrow on the
  // view's discriminant so each park reads only its own reason.
  const parkReason =
    pause?.status === "capacity-limited"
      ? pause.capacityReason
      : pause?.status === "transport-lost"
        ? pause.transportReason
        : undefined;
  const autoRetry =
    pause?.status === "capacity-limited" || pause?.status === "transport-lost"
      ? pause.autoRetry
      : undefined;
  const retryIndicator = autoRetry
    ? autoRetry.pending
      ? `Auto-retrying… (try ${autoRetry.attempt} of ${autoRetry.maxAttempts})`
      : autoRetry.attempt >= autoRetry.maxAttempts
        ? "Auto-retry stopped — resume manually"
        : "Retrying…"
    : undefined;
  const routine = formatWorkEventScope(event);
  const eventText = formatWorkEventText(event);
  const detail = formatWorkEventDetail(event);
  const meta = [
    routine,
    formatWorkEventOutcome(event),
    new Date(event.createdAt).toLocaleTimeString(),
  ]
    .filter(Boolean)
    .join(" · ");
  const statusText = [eventText, detail].filter(Boolean).join(" - ");
  const tooltip = [statusText, meta].filter(Boolean).join("\n");

  return (
    <section
      className={`activity-status${
        parkReason ? " activity-status--capacity" : ""
      }`}
      aria-live="polite"
    >
      <div className="activity-status-copy" title={tooltip}>
        <span className="activity-status-kicker">{routine}</span>
        <span className="activity-status-text">{statusText}</span>
      </div>
      <time className="activity-status-time" dateTime={event.createdAt}>
        {new Date(event.createdAt).toLocaleTimeString()}
      </time>
      <div className="activity-status-actions">
        {parked ? (
          <button
            className="btn primary sm"
            type="button"
            disabled={busy}
            onClick={() => onContinueRun(event.arcRunId)}
            title="Resume now instead of waiting for the next automatic retry."
          >
            Retry
          </button>
        ) : null}
        {showPausing ? (
          <button
            className="btn sm"
            type="button"
            disabled
            title="Pause request accepted. Waiting for the run to reach a pause boundary."
          >
            Pausing
          </button>
        ) : null}
        {canPause ? (
          <button
            className="btn sm"
            type="button"
            disabled={busy}
            onClick={() => onPauseRun(event.arcRunId)}
          >
            Pause
          </button>
        ) : null}
        {canContinue ? (
          <button
            className="btn primary sm"
            type="button"
            disabled={busy}
            onClick={() => onContinueRun(event.arcRunId)}
          >
            Continue
          </button>
        ) : null}
      </div>
      {parkReason ? (
        <div className="activity-status-capacity" title={parkReason.message}>
          <span className="activity-status-capacity-reason">
            {parkReason.reason}
          </span>
          {parkReason.message ? (
            <span className="activity-status-capacity-message">
              {parkReason.message}
            </span>
          ) : null}
          {retryIndicator ? (
            <span className="activity-status-capacity-retry">
              {retryIndicator}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function latestWorkEventIn(
  workEvents: readonly WorkEvent[],
): WorkEvent | null {
  return workEvents.at(-1) ?? null;
}

function compareMessagesChronological(
  left: OutboundItem,
  right: OutboundItem,
): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}
