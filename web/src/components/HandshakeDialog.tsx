import { useCallback, useRef, useState } from "react";

import { formatDate, isAbsolutePathLike } from "../lib/format";
import type { EntryReceipt, HandshakeResolutionValues } from "../types";
import { useDialogFocus } from "./dialogFocus";

export type HandshakeState = EntryReceipt & {
  status: "handshake-required";
  handshakeId: string;
};

type HandshakeDialogProps = {
  handshake: HandshakeState;
  workingRoot: string;
  error?: string;
  busy: boolean;
  onCancel(): void;
  onResolve(values: HandshakeResolutionValues): void;
  onNeedRoot(kind: "fresh" | "workspace"): void;
};

export function HandshakeDialog({
  handshake,
  workingRoot,
  error,
  busy,
  onCancel,
  onResolve,
  onNeedRoot,
}: HandshakeDialogProps) {
  const [workspaceDraft, setWorkspaceDraft] = useState(workingRoot);
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onCancel(), [onCancel]);
  useDialogFocus(dialogRef, close, !busy);
  const candidates = handshake.handshakeRunCandidates ?? [];
  const freshAvailable = handshake.handshakeFreshAvailable ?? true;
  const hasAbsoluteWorkspace = isAbsolutePathLike(workspaceDraft);

  function resolveFresh() {
    if (!hasAbsoluteWorkspace) {
      onNeedRoot("fresh");
      return;
    }
    onResolve({
      runChoice: { action: "fresh" },
      workspace: workspaceDraft.trim(),
    });
  }

  function resolveWorkspace() {
    if (!hasAbsoluteWorkspace) {
      onNeedRoot("workspace");
      return;
    }
    onResolve({ workspace: workspaceDraft.trim() });
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal handshake-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handshake-title"
        tabIndex={-1}
      >
        <div>
          <h2 id="handshake-title">More information needed</h2>
          <p className="muted">
            {handshake.handshakePrompt ?? "Activation needs one more choice."}
          </p>
        </div>
        {error ? <p className="inline-note error">{error}</p> : null}
        {candidates.length > 0 ? (
          <div className="candidate-list">
            {candidates.map((candidate) => (
              <div className="candidate-row" key={candidate.arcRunId}>
                <div>
                  <h3>{candidate.arcRef}</h3>
                  <p>
                    {candidate.arcRunId} · {candidate.lifecycle} · updated{" "}
                    {formatDate(candidate.updatedAt)}
                  </p>
                  {candidate.workspacePath ? (
                    <p>{candidate.workspacePath}</p>
                  ) : null}
                </div>
                <button
                  className="btn primary sm"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onResolve({
                      runChoice: {
                        action: "join",
                        arcRunId: candidate.arcRunId,
                      },
                    })
                  }
                >
                  Join
                </button>
              </div>
            ))}
            {freshAvailable ? (
              <>
                <div className="workspace-inline">
                  <label htmlFor="fresh-workspace">
                    Workspace for fresh run
                  </label>
                  <input
                    id="fresh-workspace"
                    value={workspaceDraft}
                    onChange={(event) => setWorkspaceDraft(event.target.value)}
                    placeholder="/Users/d/Projects/example"
                  />
                </div>
                <button
                  className="btn"
                  type="button"
                  disabled={busy}
                  onClick={resolveFresh}
                >
                  Start fresh
                </button>
              </>
            ) : null}
          </div>
        ) : (
          <>
            <div className="workspace-inline">
              <label htmlFor="handshake-workspace">Workspace</label>
              <input
                id="handshake-workspace"
                value={workspaceDraft}
                onChange={(event) => setWorkspaceDraft(event.target.value)}
                placeholder="/Users/d/Projects/example"
              />
            </div>
            <button
              className="btn primary"
              type="button"
              disabled={busy}
              onClick={resolveWorkspace}
            >
              Continue
            </button>
          </>
        )}
        <div className="modal-actions">
          <button
            className="btn ghost"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
