#!/usr/bin/env bash
# Stops and removes the Lima VM that hosts MC. Does NOT touch the world
# data on the host filesystem ($COMPOSE_DIR/seasons/...) — that survives
# VM teardown so a future setup-mc-vm.sh re-imports it.

set -euo pipefail

VM_NAME="${MC_VM_NAME:-mc-vm}"

if ! command -v limactl >/dev/null 2>&1; then
  echo "lima is not installed; nothing to tear down."
  exit 0
fi

status="$(limactl list --format '{{.Status}}' "$VM_NAME" 2>/dev/null || true)"
if [ -z "$status" ]; then
  echo "VM '$VM_NAME' does not exist."
  exit 0
fi

if [ "$status" = "Running" ]; then
  echo "Stopping VM '$VM_NAME'…"
  limactl stop "$VM_NAME"
fi

read -r -p "Delete VM '$VM_NAME'? Disk image will be removed. World data on the host stays. [y/N] " ans
case "$ans" in
  y|Y|yes|YES)
    limactl delete "$VM_NAME"
    echo "VM '$VM_NAME' removed."
    ;;
  *)
    echo "Skipped delete; VM is stopped."
    ;;
esac
