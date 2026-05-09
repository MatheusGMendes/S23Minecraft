// Browser-side pending state shared across the mods card and the
// before-unload guard. Files queued for upload live here as File objects
// until the user clicks Apply; deletions are tracked by mod name.

export const pendingFiles = [];
export const pendingDeletions = new Set();

export function pendingHas(name) {
  return pendingFiles.some(f => f.name === name);
}

export function pendingRemove(name) {
  const i = pendingFiles.findIndex(f => f.name === name);
  if (i >= 0) pendingFiles.splice(i, 1);
}

export function clearPending() {
  pendingFiles.length = 0;
  pendingDeletions.clear();
}

// Warn before unload when there are unsaved staged changes. Modern
// browsers ignore the custom message text and show their own canned
// "Leave site?" prompt — setting returnValue is what triggers it.
export function installUnloadGuard() {
  window.addEventListener('beforeunload', (e) => {
    if (pendingFiles.length > 0 || pendingDeletions.size > 0) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}
