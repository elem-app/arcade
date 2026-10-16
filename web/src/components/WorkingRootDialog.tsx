import { useCallback, useMemo, useRef } from "react";

import { isAbsolutePathLike } from "../lib/format";
import { useDialogFocus } from "./dialogFocus";

export type WorkingRootDialogState = {
  reason: "set" | "required";
};

type WorkingRootDialogProps = {
  state: WorkingRootDialogState;
  value: string;
  isPickingDir: boolean;
  inlineNote?: string;
  onChange(value: string): void;
  onBrowse(): void;
  onCancel(): void;
  onSave(value: string): void;
};

export function WorkingRootDialog({
  state,
  value,
  isPickingDir,
  inlineNote,
  onChange,
  onBrowse,
  onCancel,
  onSave,
}: WorkingRootDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onCancel(), [onCancel]);
  useDialogFocus(dialogRef, close, !isPickingDir);

  const trimmed = value.trim();
  const validation = useMemo(() => {
    if (!trimmed) return "Choose an absolute working root to run Arcade.";
    if (!isAbsolutePathLike(trimmed)) {
      return "Use an absolute path, such as /Users/d/Projects/example.";
    }
    return undefined;
  }, [trimmed]);
  const title =
    state.reason === "required" ? "Working root required" : "Working root";

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isPickingDir) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="working-root-title"
        tabIndex={-1}
      >
        <div>
          <h2 id="working-root-title">{title}</h2>
          <p className="muted">
            Arcade needs an absolute root so it can discover workspaces and
            Arcs.
          </p>
        </div>
        <div className="directory-field">
          <input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="/Users/d/Projects/example"
            aria-describedby="working-root-help"
          />
          <button
            className="btn"
            type="button"
            disabled={isPickingDir}
            onClick={onBrowse}
          >
            {isPickingDir ? "Browsing" : "Browse..."}
          </button>
        </div>
        <p id="working-root-help" className="inline-note">
          {inlineNote ?? validation ?? "Saved locally for future runs."}
        </p>
        <div className="modal-actions">
          <button
            className="btn ghost"
            type="button"
            disabled={isPickingDir}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={Boolean(validation) || isPickingDir}
            onClick={() => onSave(trimmed)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
