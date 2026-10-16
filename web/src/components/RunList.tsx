import type { RunSummary } from "../types";
import { RunCard } from "./RunCard";

type RunListProps = {
  runs: RunSummary[];
  selectedRunId: string | null;
  onSelectRun(id: string): void;
};

export function RunList({ runs, selectedRunId, onSelectRun }: RunListProps) {
  return (
    <div className="pane" aria-labelledby="runs-title">
      <div className="pane-head">
        <h2 id="runs-title">Runs</h2>
        <span className="count">{runs.length} total</span>
      </div>
      <div className="pane-body">
        {runs.length === 0 ? (
          <div className="empty-copy">No runs yet.</div>
        ) : (
          runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              selected={selectedRunId === run.id}
              onSelect={onSelectRun}
            />
          ))
        )}
      </div>
    </div>
  );
}
