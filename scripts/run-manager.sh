#!/usr/bin/env bash
# Run the manager as a native Node.js process on macOS, talking to the
# Lima VM's docker daemon via the SSH-forwarded unix socket. The manager
# itself doesn't need protection — it doesn't run untrusted code — so
# there's no point putting it in a container. MC stays inside Lima where
# the VM kernel boundary actually matters.
#
# Builds the frontend if needed, ensures backend deps are installed,
# then runs `node server.js` in the foreground. Ctrl-C to stop.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VM_NAME="${MC_VM_NAME:-mc-vm}"
SOCK="$HOME/.lima/$VM_NAME/sock/docker.sock"

if [ ! -S "$SOCK" ]; then
  echo "Lima docker socket missing at: $SOCK" >&2
  echo "Run:  bash $REPO/scripts/setup-mc-vm.sh" >&2
  exit 1
fi

# Build frontend → frontend/dist (Vite). Skipped if dist is newer than
# main.js — Vite's incremental rebuild is fast anyway, but no point
# wasting half a second on every restart.
if [ ! -f "$REPO/frontend/dist/index.html" ] || [ "$REPO/frontend/src/main.js" -nt "$REPO/frontend/dist/index.html" ]; then
  echo "→ building frontend"
  ( cd "$REPO/frontend" && npm install --silent && npm run build --silent )
fi

# Backend deps.
if [ ! -d "$REPO/backend/node_modules" ]; then
  echo "→ installing backend deps"
  ( cd "$REPO/backend" && npm install --silent )
fi

export PORT="${PORT:-8092}"
export DATA_DIR="${DATA_DIR:-$REPO/data}"
export MC_COMPOSE_DIR="${MC_COMPOSE_DIR:-$REPO/minecraft}"
export SERVERS_DIR="${SERVERS_DIR:-$REPO/minecraft/seasons}"
export BACKUPS_DIR="${BACKUPS_DIR:-$REPO/minecraft/backups}"
export MC_CONTAINER="${MC_CONTAINER:-s23-minecraft}"
export MC_HOST="${MC_HOST:-127.0.0.1}"
export MC_PORT="${MC_PORT:-25565}"
export LIFETIME_DAYS="${LIFETIME_DAYS:-40}"
export HIDDEN_OPS="${HIDDEN_OPS:-Mendes57}"
export PUBLIC_DIR="${PUBLIC_DIR:-$REPO/frontend/dist}"
export DOCKER_HOST="unix://$SOCK"

mkdir -p "$DATA_DIR"

echo "→ manager listening on http://localhost:$PORT (DOCKER_HOST=$DOCKER_HOST)"
exec node "$REPO/backend/server.js"
