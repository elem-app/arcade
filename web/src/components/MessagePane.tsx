import type { DetailStatus } from "../hooks/usePolling";
import type {
  ExecutionControlView,
  OutboundItem,
  RunSummary,
  WorkEvent,
} from "../types";
import { MessageList } from "./MessageList";

type MessagePaneProps = {
  selectedRun: RunSummary | undefined;
  selectedRunId: string | null;
  messages: OutboundItem[];
  workEvents: WorkEvent[];
  pause?: ExecutionControlView;
  detailStatus: DetailStatus;
  expandedAnswered: Set<string>;
  answerDrafts: Record<string, string>;
  busyMessageId?: string;
  busyRunId?: string;
  onToggleExpanded(id: string): void;
  onDraftChange(key: string, value: string): void;
  onAnswer(id: string, content: string): void;
  onPermission(id: string, decision: "allow" | "allow_this_run" | "deny"): void;
  onAck(id: string): void;
  onPauseRun(arcRunId: string): void;
  onContinueRun(arcRunId: string): void;
};

export function MessagePane({
  selectedRun,
  selectedRunId,
  messages,
  workEvents,
  pause,
  detailStatus,
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
}: MessagePaneProps) {
  const pendingCount = messages.filter(
    (item) => item.status === "pending",
  ).length;
  const title = selectedRun?.title ?? selectedRunId ?? "Messages";
  const subtitle = selectedRunId
    ? `${selectedRunId} · ${pendingCount} pending`
    : "";

  return (
    <div className="pane" aria-labelledby="messages-title">
      <div className="pane-head">
        <h2 id="messages-title">{title}</h2>
        <span className="count">{subtitle}</span>
      </div>
      <div className="pane-body messages-body">
        {detailStatus === "missing" && workEvents.length > 0 && (
          <p>Preparation has ended. Retained activity is shown below.</p>
        )}
        {selectedRun && selectedRun.stage !== "actioning" && (
          <p>
            {selectedRun.stage}
            {selectedRun.stage === "handshaking"
              ? ` · ${selectedRun.handshakeId}`
              : selectedRun.workspacePath
                ? ` · ${selectedRun.workspacePath}`
                : ""}
          </p>
        )}
        {detailStatus === "idle" ? (
          <div className="pane-empty">
            <span className="glyph-lg">✉</span>
            <p>Select a run on the left to see its messages.</p>
          </div>
        ) : detailStatus === "loading" ? (
          <div className="pane-empty quiet">
            <p>Loading...</p>
          </div>
        ) : detailStatus === "missing" && workEvents.length === 0 ? (
          <div className="pane-empty">
            <p>That run is no longer available.</p>
          </div>
        ) : messages.length === 0 && workEvents.length === 0 ? (
          <div className="pane-empty">
            <p>No messages yet.</p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            workEvents={workEvents}
            pause={pause}
            expandedAnswered={expandedAnswered}
            answerDrafts={answerDrafts}
            busyMessageId={busyMessageId}
            busyRunId={busyRunId}
            onToggleExpanded={onToggleExpanded}
            onDraftChange={onDraftChange}
            onAnswer={onAnswer}
            onPermission={onPermission}
            onAck={onAck}
            onPauseRun={onPauseRun}
            onContinueRun={onContinueRun}
          />
        )}
      </div>
    </div>
  );
}
