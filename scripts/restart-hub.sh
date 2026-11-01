#!/usr/bin/env bash
# Started by the Hub itself for a dashboard restart. Arguments: the old Hub's
# pid, whether the QQ channel was on, the Hub port, and the launchd label when
# launchd supervises the Hub.
set -uo pipefail
old_pid="$1"
qq_enabled="$2"
port="$3"
launchd_label="${4:-}"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir" || exit 1
log_dir="$project_dir/runtime/logs"
mkdir -p "$log_dir"
exec >> "$log_dir/chat-hub-restart.log" 2>&1

echo "[$(date '+%F %T')] waiting for Hub $old_pid to stop"
if [ -n "$launchd_label" ]; then
  launchctl kickstart -k "gui/$(id -u)/$launchd_label" || exit 1
else
  stopped=0
  for _ in $(seq 1 120); do
    kill -0 "$old_pid" 2>/dev/null || { stopped=1; break; }
    sleep 0.5
  done
  if [ "$stopped" != 1 ]; then
    echo "Hub $old_pid did not stop; leaving it running"
    exit 1
  fi
  (
    set -a
    # shellcheck disable=SC1091
    [ -f config/local.env ] && source config/local.env
    set +a
    nohup bash scripts/start-hub.sh >> "$log_dir/chat-hub.log" 2>> "$log_dir/chat-hub.err.log" &
    # start-astra.sh finds the Hub through this file.
    [ -f runtime/hub.pid ] && echo $! > runtime/hub.pid
  )
fi

up=0
for _ in $(seq 1 60); do
  curl -fsS -m 2 "http://127.0.0.1:$port/api/maintenance" >/dev/null 2>&1 && { up=1; break; }
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "Hub did not come back within a minute"
  exit 1
fi
echo "Hub is back"
# A restart always closes the QQ channel; loopback requests need no token.
if [ "$qq_enabled" = 1 ]; then
  curl -fsS -m 10 -X POST "http://127.0.0.1:$port/api/channel" \
    -H 'content-type: application/json' \
    -d '{"channel":"qq","enabled":true}' >/dev/null || echo "Could not reopen the QQ channel"
fi
