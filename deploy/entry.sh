#!/bin/sh
# MissionGraph VM entrypoint: event-sourced server always; Codex bridge only when
# BRIDGE_ENABLED=1 and the flagship-mission variables are present.
set -eu

: "${PORT:=10000}"
: "${DB_PATH:=/data/missiongraph.sqlite}"
export DB_PATH

node server/dist/src/http.js &
SERVER_PID=$!

# This script is PID 1. Without a trap, container shutdown SIGKILLs every child:
# the bridge never runs its graceful stop, so the state lock survives on the
# persistent disk and the NEXT instance (a different hostname) can never take it
# over. Forward TERM/INT so the bridge exits cleanly and releases the lock.
BRIDGE_LOOP_PID=""
on_term() {
  if [ -n "$BRIDGE_LOOP_PID" ]; then kill -TERM "$BRIDGE_LOOP_PID" 2>/dev/null || true; fi
  kill -TERM "$SERVER_PID" 2>/dev/null || true
}
trap on_term TERM INT

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
  elif ! probe_output=$(codex exec -s read-only -c 'mcp_servers={}' --skip-git-repo-check \
      ${MG_CODEX_MODEL:+-m "$MG_CODEX_MODEL"} "reply with ok" </dev/null 2>&1); then
    # Better one clear line here than a stream of adopted tasks dying after a judge confirmed them.
    # The tail of the probe output names the actual API error (quota, model access, auth) without
    # which the only fix path is a shell session; the API key itself never appears in that output.
    echo "BRIDGE DISABLED: codex cannot run ${MG_CODEX_MODEL:-the default model} with this API key" >&2
    echo "BRIDGE DISABLED detail: $(printf '%s' "$probe_output" | tail -c 400 | tr '\n' ' ')" >&2
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
      elif ! git -C /data/target-repo config user.email "fleet@missiongraph.local" ||
          ! git -C /data/target-repo config user.name "MissionGraph Fleet"; then
        echo "BRIDGE DISABLED: could not configure the cloned target repository" >&2
        bridge_project_ready=0
      fi
    fi
  fi

  if [ "$bridge_project_ready" = "1" ]; then
    # Zero-downtime deploys overlap the old and new instances on the same /data disk,
    # so the first bridge start typically loses the state lock to the outgoing
    # instance and exits. Retry on a bounded loop: the old bridge releases the lock
    # when its instance shuts down. After ten minutes, inspect the lock's heartbeat
    # lease on every remaining attempt. Only a lock untouched for more than five
    # minutes is moved aside (keeping the evidence). The server is never affected by
    # anything in this loop.
    (
      BRIDGE_PID=""
      # On shutdown, forward TERM to the bridge and wait for it: its graceful stop is
      # what deletes the state lock on the shared disk. Exiting without that wait
      # would let the container runtime SIGKILL the bridge mid-cleanup.
      trap 'if [ -n "$BRIDGE_PID" ]; then kill -TERM "$BRIDGE_PID" 2>/dev/null || true; wait "$BRIDGE_PID" 2>/dev/null || true; fi; exit 0' TERM INT
      attempt=0
      while [ "$attempt" -lt 30 ]; do
        attempt=$((attempt + 1))
        MG_SERVER_URL="http://127.0.0.1:${PORT}" \
        MG_REPORTER_CREDENTIAL="${REPORTER_TOKEN}" \
        MG_TARGET_REPO=/data/target-repo \
        MG_BRIDGE_STATE=/data/bridge-state.json \
        node bridge/dist/src/main.js &
        BRIDGE_PID=$!
        bridge_status=0
        wait "$BRIDGE_PID" || bridge_status=$?
        BRIDGE_PID=""
        if [ "$bridge_status" -eq 0 ]; then
          echo "[entry] bridge exited cleanly; not restarting" >&2
          break
        fi
        echo "[entry] bridge exited with status $bridge_status (attempt $attempt/30); retrying in 30s" >&2
        if [ "$attempt" -ge 20 ] && [ -f /data/bridge-state.json.lock ]; then
          if lock_mtime=$(stat -c %Y /data/bridge-state.json.lock 2>/dev/null) && lock_now=$(date +%s); then
            lock_cutoff=$((lock_now - 300))
            if [ "$lock_mtime" -lt "$lock_cutoff" ]; then
              echo "[entry] clearing an expired cross-host bridge lock lease (evidence kept)" >&2
              if mv /data/bridge-state.json.lock "/data/bridge-state.json.lock.cleared-${lock_now}" 2>/dev/null; then
                rm -f /data/bridge-state.json.lock.takeover 2>/dev/null || true
              fi
            elif [ "$attempt" -eq 20 ]; then
              echo "[entry] cross-host bridge lock lease is active; continuing retries" >&2
            fi
          elif [ "$attempt" -eq 20 ]; then
            echo "[entry] could not inspect the cross-host bridge lock lease; continuing retries" >&2
          fi
        fi
        sleep 30 &
        wait $! 2>/dev/null || true
      done
      if [ "$attempt" -ge 30 ]; then
        echo "[entry] bridge did not stay up after 30 attempts; the server keeps serving — check the lines above" >&2
      fi
    ) &
    BRIDGE_LOOP_PID=$!
  fi
fi

# The server is the container's lifeline: when it exits — crash or forwarded TERM —
# reap the bridge loop (TERM + wait, so the lock release finishes) and let PID 1 exit,
# which is what makes Render restart a crashed instance.
wait "$SERVER_PID" || true
if [ -n "$BRIDGE_LOOP_PID" ]; then
  kill -TERM "$BRIDGE_LOOP_PID" 2>/dev/null || true
  wait "$BRIDGE_LOOP_PID" 2>/dev/null || true
fi
