#!/usr/bin/env bash
# Provisions the Lima VM that runs the Minecraft server with kernel-level
# isolation. Idempotent: safe to re-run after a failed start, or to bring
# the VM back up after a reboot.
#
# After this completes:
#   - $HOME/.lima/mc-vm/sock/docker.sock is a working docker daemon socket
#   - The manager's docker-compose.yml mounts that socket as
#     /var/run/docker.sock inside the manager container
#   - All MC containers (and the temp containers for mod/world wipe) run
#     inside the VM, sharing only its kernel — not the host's

set -euo pipefail

VM_NAME="${MC_VM_NAME:-mc-vm}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$HERE/../lima/mc-vm.yaml"

if ! command -v limactl >/dev/null 2>&1; then
  echo "lima is not installed."
  echo "Install with:  brew install lima"
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "VM template not found at $TEMPLATE" >&2
  exit 1
fi

# limactl list returns a single-word status: Running / Stopped / (empty if
# the VM doesn't exist yet).
status="$(limactl list --format '{{.Status}}' "$VM_NAME" 2>/dev/null || true)"
case "$status" in
  Running)
    echo "VM '$VM_NAME' is already running."
    ;;
  Stopped)
    echo "Starting existing VM '$VM_NAME'…"
    limactl start "$VM_NAME"
    ;;
  *)
    echo "Creating VM '$VM_NAME' from $TEMPLATE…"
    echo "(first boot will download the Ubuntu cloud image — a few minutes)"
    # First boot: limactl start often fails because the docker probe runs
    # under an SSH session that was opened BEFORE the provision script
    # added the user to the docker group. Tolerate that exit; we restart
    # right after to get a fresh session that sees the group, and that's
    # what makes the probe pass.
    limactl start --name="$VM_NAME" --tty=false "$TEMPLATE" || true
    if ! limactl shell "$VM_NAME" -- bash -c 'docker info >/dev/null 2>&1'; then
      echo "Restarting VM so the SSH session picks up the docker group…"
      limactl stop "$VM_NAME" >/dev/null 2>&1 || true
      limactl start "$VM_NAME"
    fi
    ;;
esac

SOCK="$HOME/.lima/$VM_NAME/sock/docker.sock"
echo -n "Waiting for docker socket at $SOCK"
for _ in $(seq 1 60); do
  if [ -S "$SOCK" ]; then
    echo
    break
  fi
  echo -n "."
  sleep 1
done
if [ ! -S "$SOCK" ]; then
  echo
  echo "docker socket did not appear at $SOCK after 60s." >&2
  echo "Check VM logs:  limactl shell $VM_NAME sudo journalctl -u docker --no-pager | tail -50" >&2
  exit 1
fi

# Sanity check: client can reach the daemon and the daemon is healthy.
if ! DOCKER_HOST="unix://$SOCK" docker version >/dev/null 2>&1; then
  echo "docker socket exists but the daemon is not responding." >&2
  echo "Check VM logs:  limactl shell $VM_NAME sudo journalctl -u docker --no-pager | tail -50" >&2
  exit 1
fi

echo
echo "VM '$VM_NAME' is up."
DOCKER_HOST="unix://$SOCK" docker version --format '  client: {{.Client.Version}}   server: {{.Server.Version}}'
echo "  socket: $SOCK"
echo
echo "Next:  docker compose up -d   (the manager will pick up the VM socket automatically)"
