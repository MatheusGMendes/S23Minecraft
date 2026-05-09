// Single modal component. One function, four params:
//   title         heading (omit for no heading)
//   message       body text
//   confirmLabel  primary button label (defaults to "OK")
//   cancelLabel   secondary button label; set to '' to hide it (alert-only)
//   danger        if true, primary button is red (destructive action)
// Returns Promise<boolean>: true on confirm, false on cancel/Esc/outside-click.

let activeResolver = null;

const modalRoot = () => document.getElementById('modal');

// Always-on dismiss path — wired once at module load. Esc and clicks
// outside the dialog ALWAYS close any visible modal, even if showModal
// somehow left state inconsistent. Safety net so users can never get
// stuck looking at a frozen overlay.
function dismissModal(value = false) {
  const root = modalRoot();
  if (!root || root.hidden) return;
  root.hidden = true;
  document.getElementById('modal-actions').innerHTML = '';
  document.getElementById('modal-title').textContent = '';
  document.getElementById('modal-body').textContent = '';
  if (activeResolver) { const r = activeResolver; activeResolver = null; r(value); }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalRoot().hidden) dismissModal(false);
  else if (e.key === 'Enter' && !modalRoot().hidden) {
    const def = document.querySelector('#modal-actions .modal-btn-primary, #modal-actions .modal-btn-danger');
    if (def) def.click();
  }
});

document.addEventListener('click', (e) => {
  const root = modalRoot();
  if (!root || root.hidden) return;
  // Click on the modal root or the backdrop (anywhere outside the
  // dialog) dismisses. Clicks on the dialog itself are ignored so users
  // can select text without losing the modal.
  if (e.target === root || e.target.classList.contains('modal-backdrop')) {
    dismissModal(false);
  }
});

export function showModal({ title = '', message = '', confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  // Replace any in-flight modal — its promise resolves false.
  if (activeResolver) { const r = activeResolver; activeResolver = null; r(false); }

  return new Promise((resolve) => {
    activeResolver = resolve;

    const titleEl = document.getElementById('modal-title');
    const bodyEl = document.getElementById('modal-body');
    const actionsEl = document.getElementById('modal-actions');
    titleEl.textContent = title;
    bodyEl.textContent = message;
    actionsEl.innerHTML = '';

    if (cancelLabel) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = cancelLabel;
      b.addEventListener('click', () => dismissModal(false));
      actionsEl.appendChild(b);
    }
    // Confirm button is ALWAYS rendered — fall back to "OK" if the
    // caller passed an empty string, so the modal can never appear
    // without at least one dismissable button.
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = confirmLabel || 'OK';
    confirmBtn.classList.add(danger ? 'modal-btn-danger' : 'modal-btn-primary');
    confirmBtn.addEventListener('click', () => dismissModal(true));
    actionsEl.appendChild(confirmBtn);

    modalRoot().hidden = false;
    setTimeout(() => confirmBtn.focus(), 0);
  });
}
