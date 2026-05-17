#!/usr/bin/env bash
set -euo pipefail

TMUX_SESSION="${TMUX_SESSION_NAME:-agent-connect}"
TMUX_WINDOW="${AGENT_CONNECT_RESTART_WINDOW:-__main__}"
TARGET="${TMUX_SESSION}:${TMUX_WINDOW}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MAX_WAIT="${AGENT_CONNECT_RESTART_MAX_WAIT:-10}"

if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "Error: tmux session '$TMUX_SESSION' does not exist"
  exit 1
fi

if ! tmux list-windows -t "$TMUX_SESSION" -F '#{window_name}' 2>/dev/null | grep -qx "$TMUX_WINDOW"; then
  echo "Error: window '$TMUX_WINDOW' not found in session '$TMUX_SESSION'"
  exit 1
fi

PANE_PID=$(tmux list-panes -t "$TARGET" -F '#{pane_pid}')

is_agent_connect_running() {
  pstree -a "$PANE_PID" 2>/dev/null | grep -Eq 'pnpm .*(@agent-connect/cli|--filter agent-connect|dev:bot|start)|node .*packages/cli/dist/src/index\.js|agc( |$)'
}

if is_agent_connect_running; then
  echo "Found running Agent Connect process, sending Ctrl-C..."
  tmux send-keys -t "$TARGET" C-c

  waited=0
  while is_agent_connect_running && [ "$waited" -lt "$MAX_WAIT" ]; do
    sleep 1
    waited=$((waited + 1))
    echo "  Waiting for process to exit... (${waited}s/${MAX_WAIT}s)"
  done

  if is_agent_connect_running; then
    echo "Process did not exit after ${MAX_WAIT}s"
    exit 1
  fi

  echo "Process stopped."
else
  echo "No Agent Connect process running in $TARGET"
fi

sleep 1

echo "Starting Agent Connect in $TARGET..."
tmux send-keys -t "$TARGET" "cd ${PROJECT_DIR} && pnpm dev:bot" Enter

sleep 3
if is_agent_connect_running; then
  echo "Agent Connect restarted successfully. Recent logs:"
  echo "----------------------------------------"
  tmux capture-pane -t "$TARGET" -p | tail -20
  echo "----------------------------------------"
else
  echo "Warning: Agent Connect may not have started. Pane output:"
  echo "----------------------------------------"
  tmux capture-pane -t "$TARGET" -p | tail -30
  echo "----------------------------------------"
  exit 1
fi
