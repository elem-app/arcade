import { useEffect, useMemo, useState } from "react";

import {
  ackOutbound,
  answerPermission,
  answerQuestion,
  chooseDirectory,
  requestPause,
  resolveHandshake,
  resumeRun,
  submitEntry,
} from "./api/client";
import { Composer } from "./components/Composer";
import { Footer } from "./components/Footer";
import {
  HandshakeDialog,
  type HandshakeState,
} from "./components/HandshakeDialog";
import { MessagePane } from "./components/MessagePane";
import { RunList } from "./components/RunList";
import { Toast, type ToastState } from "./components/Toast";
import {
  WorkingRootDialog,
  type WorkingRootDialogState,
} from "./components/WorkingRootDialog";
import {
  fixtureDetails,
  fixtureHandshakeActivity,
  fixtureHealth,
  fixtureRuns,
  fixturesEnabled,
} from "./debug/fixtures";
import { usePolling } from "./hooks/usePolling";
import { isAbsolutePathLike } from "./lib/format";
import type {
  HandshakeResolutionValues,
  OutboundItem,
  PermissionDecision,
  RunDetail,
  RunSummary,
} from "./types";

const WORKING_ROOT_STORAGE_KEY = "arcade.web.workingRoot";
const HANDSHAKE_EXPIRED_MESSAGE =
  "Those options are no longer available. Send your original request again.";
const SUBMISSION_CHANNEL_FAILED_MESSAGE =
  "Arcade could not finish handling that request. Check your runs before trying again.";
const SUBMISSION_REJECTED_MESSAGE =
  "Arcade did not start a run for that request.";

function userFacingRequestError(error: string): string {
  return error === "internal-server-error"
    ? SUBMISSION_CHANNEL_FAILED_MESSAGE
    : error;
}

export default function App() {
  const fixtureMode = fixturesEnabled();
  const [fixtureRunsState, setFixtureRunsState] =
    useState<RunSummary[]>(fixtureRuns);
  const [fixtureDetailsState, setFixtureDetailsState] =
    useState<Record<string, RunDetail>>(fixtureDetails);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(() =>
    fixtureMode ? (fixtureRuns[0]?.id ?? null) : null,
  );
  const [composerText, setComposerText] = useState("");
  const [workingRoot, setWorkingRoot] = useState(
    () => localStorage.getItem(WORKING_ROOT_STORAGE_KEY) ?? "",
  );
  const [workingRootDraft, setWorkingRootDraft] = useState(workingRoot);
  const [workingRootDialog, setWorkingRootDialog] =
    useState<WorkingRootDialogState | null>(null);
  const [pendingHandshakeRoot, setPendingHandshakeRoot] = useState<
    "fresh" | "workspace" | null
  >(null);
  const [workingRootNote, setWorkingRootNote] = useState<string | undefined>();
  const [isPickingDir, setIsPickingDir] = useState(false);
  const [expandedAnswered, setExpandedAnswered] = useState<Set<string>>(
    () => new Set(),
  );
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [busyMessageId, setBusyMessageId] = useState<string | undefined>();
  const [busyRunId, setBusyRunId] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [handshake, setHandshake] = useState<HandshakeState | null>(null);
  const [handshakeError, setHandshakeError] = useState<string | undefined>();
  const [toast, setToast] = useState<ToastState | null>(null);
  const polling = usePolling(selectedRunId, { disabled: fixtureMode });
  const fixtureDetail = selectedRunId
    ? fixtureDetailsState[selectedRunId]
    : undefined;
  const runs = fixtureMode ? fixtureRunsState : polling.state.runs;
  const health = fixtureMode ? fixtureHealth : polling.state.health;
  const detail = fixtureMode ? fixtureDetail : polling.state.detail;
  const detailStatus = fixtureMode
    ? selectedRunId
      ? fixtureDetail
        ? "loaded"
        : "missing"
      : "idle"
    : polling.state.detailStatus;

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId),
    [runs, selectedRunId],
  );
  const messages = detail?.outbound ?? [];
  const workEvents =
    detail?.workEvents ??
    (selectedRunId ? (polling.state.histories[selectedRunId] ?? []) : []);

  useEffect(() => {
    if (detailStatus === "missing") setSelectedRunId(null);
  }, [detailStatus]);

  function openWorkingRootDialog(reason: WorkingRootDialogState["reason"]) {
    setWorkingRootDraft(workingRoot);
    setWorkingRootNote(undefined);
    setWorkingRootDialog({ reason });
  }

  function saveWorkingRoot(value: string) {
    setWorkingRoot(value);
    setWorkingRootDraft(value);
    localStorage.setItem(WORKING_ROOT_STORAGE_KEY, value);
    setWorkingRootDialog(null);
    setWorkingRootNote(undefined);
    if (pendingHandshakeRoot && handshake) {
      const nextValues: HandshakeResolutionValues =
        pendingHandshakeRoot === "fresh"
          ? { runChoice: { action: "fresh" }, workspace: value }
          : { workspace: value };
      setPendingHandshakeRoot(null);
      void resolveCurrentHandshake(nextValues);
    }
  }

  async function browseWorkingRoot() {
    setIsPickingDir(true);
    setWorkingRootNote(undefined);
    try {
      const result = await chooseDirectory();
      if (!result.ok) {
        setWorkingRootNote(result.error);
        return;
      }
      if (result.data.status === "selected") {
        setWorkingRootDraft(result.data.path);
      } else if (result.data.status === "unavailable") {
        setWorkingRootNote(
          result.data.message ??
            "Directory picker is unavailable. Enter a path manually.",
        );
      }
    } finally {
      setIsPickingDir(false);
    }
  }

  async function submitComposer() {
    const content = composerText.trim();
    if (!content || isSubmitting) return;
    if (fixtureMode) {
      setToast({
        tone: "info",
        text: "Fixture mode uses static runs. Select a fixture run to inspect messages.",
      });
      return;
    }
    if (!isAbsolutePathLike(workingRoot)) {
      openWorkingRootDialog("required");
      return;
    }

    polling.invalidate();
    setIsSubmitting(true);
    setToast(null);
    try {
      const entryResponse = await submitEntry(content, workingRoot);
      if (!entryResponse.ok) {
        if (entryResponse.error === "absolute-working-root-required") {
          openWorkingRootDialog("required");
        }
        setToast({
          tone: "error",
          text: userFacingRequestError(entryResponse.error),
        });
        return;
      }

      polling.setRuns(entryResponse.data.runs);
      setComposerText("");
      const { receipt } = entryResponse.data;
      polling.registerHandshake(receipt);
      if (
        (receipt.status === "activated" || receipt.status === "joined") &&
        receipt.arcRunId
      ) {
        setHandshake(null);
        setSelectedRunId(receipt.arcRunId);
      } else if (
        receipt.status === "handshake-required" &&
        receipt.handshakeId
      ) {
        setHandshake({
          ...receipt,
          status: "handshake-required",
          handshakeId: receipt.handshakeId,
        });
        setHandshakeError(undefined);
      } else if (receipt.status === "idle") {
        setToast({ tone: "info", text: "No workflow matched that request." });
      } else if (receipt.status === "rejected") {
        setToast({
          tone: "error",
          text: receipt.rejectionMessage ?? SUBMISSION_REJECTED_MESSAGE,
        });
      }
      if ("failures" in receipt && receipt.failures?.length) {
        setToast({
          tone: "error",
          text: receipt.failures.map((failure) => failure.reason).join("\n"),
        });
      }
      polling.refreshNow();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resolveCurrentHandshake(values: HandshakeResolutionValues) {
    if (!handshake) return;
    polling.invalidate();
    setBusyMessageId(handshake.handshakeId);
    setHandshakeError(undefined);
    try {
      const handshakeResponse = await resolveHandshake(
        handshake.handshakeId,
        values,
      );
      if (!handshakeResponse.ok) {
        setToast({
          tone: "error",
          text:
            handshakeResponse.status === 400
              ? "Handshake resolution payload was invalid."
              : userFacingRequestError(handshakeResponse.error),
        });
        return;
      }

      polling.setRuns(handshakeResponse.data.runs);
      const { receipt } = handshakeResponse.data;
      if ("id" in receipt) polling.registerHandshake(receipt);
      if (receipt.status === "invalid") {
        // Values were rejected; the same handshake stays open for a retry.
        setHandshakeError(receipt.message);
      } else if (receipt.status === "missing") {
        setHandshake(null);
        setToast({
          tone: "error",
          text: HANDSHAKE_EXPIRED_MESSAGE,
        });
      } else if (
        receipt.status === "handshake-required" &&
        receipt.handshakeId
      ) {
        // Resolving surfaced a follow-on handshake; chain to it.
        setHandshake({
          ...receipt,
          status: "handshake-required",
          handshakeId: receipt.handshakeId,
        });
        setHandshakeError(undefined);
      } else if (
        receipt.status === "activated" ||
        receipt.status === "joined"
      ) {
        setHandshake(null);
        if (receipt.arcRunId) setSelectedRunId(receipt.arcRunId);
      } else if (receipt.status === "idle") {
        setHandshake(null);
        setToast({ tone: "info", text: "No workflow matched that request." });
      } else if (receipt.status === "failed") {
        setHandshake(null);
      } else if (receipt.status === "rejected") {
        setHandshake(null);
        setToast({
          tone: "error",
          text: receipt.rejectionMessage ?? SUBMISSION_REJECTED_MESSAGE,
        });
      }
      if ("failures" in receipt && receipt.failures?.length) {
        setToast({
          tone: "error",
          text: receipt.failures.map((failure) => failure.reason).join("\n"),
        });
      }
      polling.refreshNow();
    } finally {
      setBusyMessageId(undefined);
    }
  }

  function needRootForHandshake(kind: "fresh" | "workspace") {
    setPendingHandshakeRoot(kind);
    openWorkingRootDialog("required");
    setHandshakeError(
      "Choose an absolute working root, then retry this choice.",
    );
  }

  function toggleExpanded(id: string) {
    setExpandedAnswered((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function updateDraft(key: string, value: string) {
    setAnswerDrafts((current) => ({ ...current, [key]: value }));
  }

  async function answer(id: string, content: string) {
    if (fixtureMode) {
      const item = updateFixtureItem(id, {
        kind: "question",
        content: content.trim() || "Fixture answer",
      });
      if (item)
        setAnswerDrafts((current) => clearDraftsForMessage(current, id));
      return;
    }
    await mutateMessage(
      id,
      () => answerQuestion(id, content),
      (item) => {
        setAnswerDrafts((current) => clearDraftsForMessage(current, item.id));
      },
    );
  }

  async function permission(id: string, decision: PermissionDecision) {
    if (fixtureMode) {
      updateFixtureItem(id, { kind: "permission", decision });
      return;
    }
    await mutateMessage(id, () => answerPermission(id, decision));
  }

  async function acknowledge(id: string) {
    if (fixtureMode) {
      updateFixtureItem(id, { kind: "ack" });
      return;
    }
    await mutateMessage(id, () => ackOutbound(id));
  }

  async function continueWork(arcRunId: string) {
    if (fixtureMode) {
      setToast({ tone: "info", text: "Fixture mode cannot resume runs." });
      return;
    }
    setBusyRunId(arcRunId);
    setToast(null);
    try {
      const result = await resumeRun(arcRunId);
      if (!result.ok) {
        setToast({ tone: "error", text: result.error });
      }
      polling.refreshNow();
    } finally {
      setBusyRunId(undefined);
    }
  }

  async function pauseWork(arcRunId: string) {
    if (fixtureMode) {
      setToast({ tone: "info", text: "Fixture mode cannot pause runs." });
      return;
    }
    setBusyRunId(arcRunId);
    setToast(null);
    try {
      const result = await requestPause(arcRunId);
      if (!result.ok) {
        setToast({ tone: "error", text: result.error });
      }
      polling.refreshNow();
    } finally {
      setBusyRunId(undefined);
    }
  }

  async function mutateMessage(
    id: string,
    call: () => ReturnType<typeof answerQuestion>,
    onSuccess?: (item: OutboundItem) => void,
  ) {
    polling.invalidate();
    setBusyMessageId(id);
    try {
      const actionResponse = await call();
      if (!actionResponse.ok) {
        if (
          actionResponse.status === 409 &&
          actionResponse.error === "outbound-message-closed"
        ) {
          polling.refreshNow();
          return;
        }
        setToast({ tone: "error", text: actionResponse.error });
        return;
      }
      polling.setRuns(actionResponse.data.runs);
      polling.applyItem(actionResponse.data.item);
      onSuccess?.(actionResponse.data.item);
      polling.refreshNow();
    } finally {
      setBusyMessageId(undefined);
    }
  }

  function updateFixtureItem(
    id: string,
    action: FixtureAction,
  ): OutboundItem | undefined {
    const selectedDetail = selectedRunId
      ? fixtureDetailsState[selectedRunId]
      : undefined;
    const current = selectedDetail?.outbound.find((item) => item.id === id);
    if (!selectedDetail || !current || current.status !== "pending") {
      return undefined;
    }

    const updated = fixtureUpdatedItem(current, action);
    setFixtureDetailsState((details) => ({
      ...details,
      [selectedDetail.id]: {
        ...selectedDetail,
        outbound: selectedDetail.outbound.map((item) =>
          item.id === id ? updated : item,
        ),
      },
    }));
    setFixtureRunsState((currentRuns) =>
      currentRuns.map((run) =>
        run.id === selectedDetail.id
          ? {
              ...run,
              pendingActions: selectedDetail.outbound.filter((item) =>
                item.id === id
                  ? updated.status === "pending"
                  : item.status === "pending",
              ).length,
              updatedAt: updated.updatedAt,
            }
          : run,
      ),
    );
    return updated;
  }

  return (
    <main className="shell">
      <Composer
        value={composerText}
        isSubmitting={isSubmitting}
        onChange={setComposerText}
        onSubmit={() => void submitComposer()}
      />
      <section className="clientarea">
        <RunList
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
        />
        <MessagePane
          selectedRun={selectedRun}
          selectedRunId={selectedRunId}
          messages={messages}
          workEvents={workEvents}
          pause={detail?.stage === "actioning" ? detail.pause : undefined}
          detailStatus={selectedRunId ? detailStatus : "idle"}
          expandedAnswered={expandedAnswered}
          answerDrafts={answerDrafts}
          busyMessageId={busyMessageId}
          busyRunId={busyRunId}
          onToggleExpanded={toggleExpanded}
          onDraftChange={updateDraft}
          onAnswer={(id, content) => void answer(id, content)}
          onPermission={(id, decision) => void permission(id, decision)}
          onAck={(id) => void acknowledge(id)}
          onPauseRun={(arcRunId) => void pauseWork(arcRunId)}
          onContinueRun={(arcRunId) => void continueWork(arcRunId)}
        />
      </section>
      {Object.values(
        fixtureMode ? fixtureHandshakeActivity : polling.state.handshakes,
      ).length > 0 && (
        <section aria-label="Handshake activity">
          {Object.values(
            fixtureMode ? fixtureHandshakeActivity : polling.state.handshakes,
          ).map((activity) => (
            <article key={activity.id}>
              <strong>{activity.prompt ?? activity.id}</strong>
              <span>
                {" "}
                · {activity.status}
                {activity.outcome ? ` · ${activity.outcome.kind}` : ""}
              </span>
              {activity.outcome && "arcRunId" in activity.outcome && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedRunId(
                      "arcRunId" in activity.outcome!
                        ? activity.outcome.arcRunId
                        : null,
                    )
                  }
                >
                  View selected run
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      <Footer
        connected={health?.ok === true}
        workingRoot={workingRoot}
        onChangeRoot={() => openWorkingRootDialog("set")}
      />
      {handshake ? (
        <HandshakeDialog
          handshake={handshake}
          workingRoot={workingRoot}
          error={handshakeError}
          busy={busyMessageId === handshake.handshakeId}
          onCancel={() => setHandshake(null)}
          onResolve={(values) => void resolveCurrentHandshake(values)}
          onNeedRoot={needRootForHandshake}
        />
      ) : null}
      {workingRootDialog ? (
        <WorkingRootDialog
          state={workingRootDialog}
          value={workingRootDraft}
          isPickingDir={isPickingDir}
          inlineNote={workingRootNote}
          onChange={setWorkingRootDraft}
          onBrowse={() => void browseWorkingRoot()}
          onCancel={() => {
            setPendingHandshakeRoot(null);
            setWorkingRootDialog(null);
          }}
          onSave={saveWorkingRoot}
        />
      ) : null}
      {toast ? <Toast toast={toast} onDismiss={() => setToast(null)} /> : null}
    </main>
  );
}

type FixtureAction =
  | { kind: "question"; content: string }
  | { kind: "permission"; decision: PermissionDecision }
  | { kind: "ack" };

function fixtureUpdatedItem(
  item: OutboundItem,
  action: FixtureAction,
): OutboundItem {
  const now = new Date().toISOString();
  if (action.kind === "permission") {
    return {
      ...item,
      status: "answered",
      updatedAt: now,
      answer: { content: action.decision, answeredAt: now },
    };
  }
  if (action.kind === "question") {
    return {
      ...item,
      status: "answered",
      updatedAt: now,
      answer: { content: action.content, answeredAt: now },
    };
  }
  return { ...item, status: "acknowledged", updatedAt: now };
}

function clearDraftsForMessage(
  current: Record<string, string>,
  id: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => key !== id && !key.startsWith(`${id}:`),
    ),
  );
}
