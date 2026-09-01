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

  # Codex does NOT read OPENAI_API_KEY from the environment: without this login it sends no
  # credential at all and every worker dies on "Missing bearer or basic authentication in header".
  # Piping from stdin keeps the key out of the process list. CODEX_HOME lives on the persistent
  # disk so the credential is written once per boot to a path the bridge's workers inherit.
  export CODEX_HOME="${CODEX_HOME:-/data/codex}"
  mkdir -p "$CODEX_HOME"
  chmod 700 "$CODEX_HOME"
  printf '%s' "${OPENAI_API_KEY}" | codex login --with-api-key >/dev/null 2>&1 || {
    echo "codex login with the provided OPENAI_API_KEY failed" >&2
    exit 1
  }

  # Fail fast on a key that cannot reach the configured model, rather than letting every judge's
  # task die one at a time after adoption.
  if ! codex exec -s read-only -c 'mcp_servers={}' \
      ${MG_CODEX_MODEL:+-m "$MG_CODEX_MODEL"} "reply with ok" </dev/null >/dev/null 2>&1; then
    echo "codex cannot run ${MG_CODEX_MODEL:-the default model} with this API key" >&2
    exit 1
  fi

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
