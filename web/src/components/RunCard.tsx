import { formatDate } from "../lib/format";
import type { RunSummary } from "../types";

type RunCardProps = {
  run: RunSummary;
  selected: boolean;
  onSelect(id: string): void;
};

export function RunCard({ run, selected, onSelect }: RunCardProps) {
  return (
    <button
      className={`run-card${selected ? " selected" : ""}`}
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(run.id)}
    >
      <span className="run-top">
        <span className="run-title">{run.title}</span>
      </span>
      <span className="run-id">arc-run · {run.id}</span>
      <span className="run-id subtle">
        updated ·{" "}
        {run.stage === "actioning" ? formatDate(run.updatedAt) : run.stage}
      </span>
      <span className="run-meta">
        <span className={`badge ${run.status} dot`}>
          {run.stage === "actioning" ? run.lifecycle : run.stage}
        </span>
        <span className="badge">{run.pendingActions} pending</span>
        {run.stage === "actioning" && (
          <span className="badge">
            {run.artifacts} {run.artifacts === 1 ? "artifact" : "artifacts"}
          </span>
        )}
      </span>
    </button>
  );
}
