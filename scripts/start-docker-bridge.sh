#!/usr/bin/env bash
# Bridges Lima's SSH-forwarded docker socket to TCP 127.0.0.1:2375 on the
# macOS host so the manager container (running on OrbStack) can reach it
# via host-gateway. OrbStack containers can't connect through bind-mounted
# unix sockets that live on the macOS host filesystem — that's why we
# bridge to TCP.
#
# Idempotent: if the bridge is already running, exits 0. The socat
# process runs in the background; kill it with:
#   pkill -f 'socat.*2375.*lima'

set -euo pipefail

VM_NAME="${MC_VM_NAME:-mc-vm}"
SOCK="$HOME/.lima/$VM_NAME/sock/docker.sock"
PORT="${DOCKER_BRIDGE_PORT:-2375}"

if [ ! -S "$SOCK" ]; then
  echo "Lima socket missing at: $SOCK" >&2
  echo "Run:  bash $(dirname "$0")/setup-mc-vm.sh" >&2
  exit 1
fi

if ! command -v socat >/dev/null 2>&1; then
  echo "socat not installed."
  echo "Install with:  brew install socat"
  exit 1
fi

# Kill any existing bridge for the same port + socket pairing so a
# re-run picks up new VM state without leaving zombies.
pkill -f "socat.*TCP-LISTEN:$PORT.*$SOCK" 2>/dev/null || true
sleep 0.3

nohup socat \
  "TCP-LISTEN:$PORT,bind=127.0.0.1,reuseaddr,fork" \
  "UNIX-CONNECT:$SOCK" \
  > /tmp/s23-docker-bridge.log 2>&1 &
disown

# Brief wait so the listener is up before we check / before the caller
# tries to use it.
for _ in 1 2 3 4 5; do
  if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep 0.3
done

if curl -sf --max-time 3 "http://127.0.0.1:$PORT/version" >/dev/null; then
  echo "docker bridge: tcp://127.0.0.1:$PORT  →  $SOCK"
else
  echo "bridge started but not responding — see /tmp/s23-docker-bridge.log" >&2
  exit 1
fi
