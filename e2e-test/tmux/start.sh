#!/usr/bin/env bash
set -euo pipefail

SESSION="${ARCADE_E2E_TMUX_SESSION:-arcade-e2e-test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENDPOINT="${ARCADE_E2E_MCP_URL:-http://127.0.0.1:3177/mcp}"

cd "$ROOT"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach -t "$SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" -n arcade
tmux send-keys -t "$SESSION:0.0" "cd '$ROOT' && ARCADE_E2E_MCP_URL='$ENDPOINT' pnpm exec tsx e2e-test/server.ts" C-m

tmux split-window -h -t "$SESSION:0.0"
tmux send-keys -t "$SESSION:0.1" "cd '$ROOT' && node e2e-test/tmux/wait-for-endpoint.mjs '$ENDPOINT' && ARCADE_E2E_MCP_URL='$ENDPOINT' pnpm exec tsx e2e-test/client.ts e2e-test/fixtures/clients/alice.json" C-m

tmux split-window -v -t "$SESSION:0.1"
tmux send-keys -t "$SESSION:0.2" "cd '$ROOT' && node e2e-test/tmux/wait-for-endpoint.mjs '$ENDPOINT' && ARCADE_E2E_MCP_URL='$ENDPOINT' pnpm exec tsx e2e-test/client.ts e2e-test/fixtures/clients/reviewer-1.json" C-m

tmux select-pane -t "$SESSION:0.1"
tmux attach -t "$SESSION"
