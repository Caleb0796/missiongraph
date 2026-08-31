#!/bin/sh
# MissionGraph VM entrypoint: event-sourced server always; Codex bridge only when
# BRIDGE_ENABLED=1 and the flagship-mission variables are present.
set -eu

: "${PORT:=10000}"
: "${DB_PATH:=/data/missiongraph.sqlite}"
export DB_PATH

node server/dist/src/http.js &
SERVER_PID=$!

if [ "${BRIDGE_ENABLED:-0}" = "1" ]; then
  : "${MG_PROJECT_ID:?BRIDGE_ENABLED=1 requires MG_PROJECT_ID}"
  : "${MG_VISITOR_TOKEN:?BRIDGE_ENABLED=1 requires MG_VISITOR_TOKEN}"
  : "${MG_TARGET_REPO_URL:?BRIDGE_ENABLED=1 requires MG_TARGET_REPO_URL}"
  : "${OPENAI_API_KEY:?BRIDGE_ENABLED=1 requires OPENAI_API_KEY (never a ChatGPT login on the VM)}"

  tries=0
  until curl -fsS -H "x-mg-token: ${MG_VISITOR_TOKEN}" \
    "http://127.0.0.1:${PORT}/api/p/${MG_PROJECT_ID}/snapshot" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 120 ] || { echo "server never became ready" >&2; exit 1; }
    sleep 1
  done

  if [ ! -d /data/target-repo/.git ]; then
    git clone "${MG_TARGET_REPO_URL}" /data/target-repo
    git -C /data/target-repo config user.email "fleet@missiongraph.local"
    git -C /data/target-repo config user.name "MissionGraph Fleet"
  fi

  MG_SERVER_URL="http://127.0.0.1:${PORT}" \
  MG_REPORTER_CREDENTIAL="${REPORTER_TOKEN}" \
  MG_TARGET_REPO=/data/target-repo \
  MG_BRIDGE_STATE=/data/bridge-state.json \
  node bridge/dist/src/main.js &
fi

wait $SERVER_PID
