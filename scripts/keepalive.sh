#!/usr/bin/env bash
# Keep the watcher and the rescue bot alive. Idempotent: starts only what is down.
set -u

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-$HOME/.hermes/logs}"
mkdir -p "$LOG_DIR"

if [ -f "$REPO_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_DIR/.env"
  set +a
fi

if [ -z "$(pgrep -f "sol_rescue.js auto" | head -1)" ]; then
  cd "$REPO_DIR" || exit 1
  setsid nohup node scripts/sol_rescue.js auto >> "$LOG_DIR/sol_rescue.log" 2>&1 < /dev/null &
  echo "$(date -u +%FT%TZ) restarted sol_rescue" >> "$LOG_DIR/keepalive.log"
fi

if [ -z "$(pgrep -f "watch_swept_wallet.py" | head -1)" ]; then
  setsid nohup python3 "$REPO_DIR/scripts/watch_swept_wallet.py" \
    --address "$VICTIM" >> "$LOG_DIR/watch_swept_wallet.log" 2>&1 < /dev/null &
  echo "$(date -u +%FT%TZ) restarted watch_swept_wallet" >> "$LOG_DIR/keepalive.log"
fi
