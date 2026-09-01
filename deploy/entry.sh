#!/bin/sh
# MissionGraph VM entrypoint: event-sourced server always; Codex bridge only when
# BRIDGE_ENABLED=1 and the flagship-mission variables are present.
set -eu

: "${PORT:=10000}"
: "${DB_PATH:=/data/missiongraph.sqlite}"
export DB_PATH

node server/dist/src/http.js &
SERVER_PID=$!

# Nothing below may take the site down. The server is already serving by this point, so a
# misconfigured or unauthenticated bridge disables the bridge and logs why — it never exits,
# because exiting here would crash-loop the container and take the public demo offline with it.
codex_ready=0

if [ "${BRIDGE_ENABLED:-0}" = "1" ]; then
  missing=""
  for required in MG_PROJECT_ID MG_VISITOR_TOKEN MG_TARGET_REPO_URL OPENAI_API_KEY; do
    eval "value=\${$required:-}"
    [ -n "$value" ] || missing="$missing $required"
  done
  if [ -n "$missing" ]; then
    echo "BRIDGE DISABLED: BRIDGE_ENABLED=1 but missing:$missing (OPENAI_API_KEY must be an API key, never a ChatGPT login on the VM)" >&2
    BRIDGE_ENABLED=0
  fi
fi

if [ "${BRIDGE_ENABLED:-0}" = "1" ]; then
  # Codex does NOT read OPENAI_API_KEY from the environment: without this login it sends no
  # credential at all and every worker dies on "Missing bearer or basic authentication in header".
  # Piping from stdin keeps the key out of the process list. CODEX_HOME lives on the persistent
  # disk so the credential is written once per boot to a path the bridge's workers inherit.
  #
  # A credential problem must never take the site down: the server is already serving, so on
  # failure we log loudly and skip the bridge rather than exiting and crash-looping the container.
  export CODEX_HOME="${CODEX_HOME:-/data/codex}"
  mkdir -p "$CODEX_HOME" 2>/dev/null || true
  chmod 700 "$CODEX_HOME" 2>/dev/null || true
  if ! printf '%s' "${OPENAI_API_KEY}" | codex login --with-api-key >/dev/null 2>&1; then
    echo "BRIDGE DISABLED: codex login with the provided OPENAI_API_KEY failed" >&2
  elif ! codex exec -s read-only -c 'mcp_servers={}' \
      ${MG_CODEX_MODEL:+-m "$MG_CODEX_MODEL"} "reply with ok" </dev/null >/dev/null 2>&1; then
    # Better one clear line here than a stream of adopted tasks dying after a judge confirmed them.
    echo "BRIDGE DISABLED: codex cannot run ${MG_CODEX_MODEL:-the default model} with this API key" >&2
  else
    codex_ready=1
  fi
fi

if [ "${BRIDGE_ENABLED:-0}" = "1" ] && [ "${codex_ready:-0}" = "1" ]; then
  tries=0
  bridge_project_ready=1
  until curl -fsS -H "x-mg-token: ${MG_VISITOR_TOKEN}" \
    "http://127.0.0.1:${PORT}/api/p/${MG_PROJECT_ID}/snapshot" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge 120 ]; then
      echo "BRIDGE DISABLED: could not read MG_PROJECT_ID from the local server — check MG_PROJECT_ID and MG_VISITOR_TOKEN" >&2
      bridge_project_ready=0
      break
    fi
    sleep 1
  done

  if [ "$bridge_project_ready" = "1" ]; then
    if [ ! -d /data/target-repo/.git ]; then
      if ! git clone "${MG_TARGET_REPO_URL}" /data/target-repo 2>&1; then
        echo "BRIDGE DISABLED: could not clone MG_TARGET_REPO_URL" >&2
        bridge_project_ready=0
      else
        git -C /data/target-repo config user.email "fleet@missiongraph.local"
        git -C /data/target-repo config user.name "MissionGraph Fleet"
      fi
    fi
  fi

  if [ "$bridge_project_ready" = "1" ]; then
    MG_SERVER_URL="http://127.0.0.1:${PORT}" \
    MG_REPORTER_CREDENTIAL="${REPORTER_TOKEN}" \
    MG_TARGET_REPO=/data/target-repo \
    MG_BRIDGE_STATE=/data/bridge-state.json \
    node bridge/dist/src/main.js &
  fi
fi

wait $SERVER_PID
