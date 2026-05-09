// Settings form (Settings tab). Manages the dynamic field grid, the
// version-list dependency on TYPE, the form-reset transition, and the
// Apply / start-new-server submit.

import { $ } from '../lib/format.js';
import { showModal } from '../lib/modal.js';
import { postJSON } from '../lib/api.js';
import { VERSION_LISTS } from '../lib/versions.js';

// Player-facing fields. `span: 'full'` makes the field span both grid columns.
const FIELDS = [
  { key: 'TYPE',        label: 'Server type',  type: 'select', options: ['VANILLA', 'FORGE', 'FABRIC'] },
  { key: 'VERSION',     label: 'Version',      type: 'select', options: ['LATEST'] },
  { key: 'DIFFICULTY',  label: 'Difficulty',   type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'MODE',        label: 'Game mode',    type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'SEED',        label: 'Seed',         type: 'text',   placeholder: '(random)' },
  { key: 'ONLINE_MODE', label: 'Online mode',  type: 'select', options: ['true', 'false'] },
  { key: 'MOTD',        label: 'MOTD',         type: 'text',   placeholder: 'Welcome to the server' },
  { key: 'OPS',         label: 'Ops',          type: 'text',   placeholder: 'name1,name2,name3' },
  { key: 'ICON',        label: 'Icon URL',     type: 'text',   placeholder: 'https://example.com/icon.png' },
  { key: 'DESCRIPTION', label: 'Description',  type: 'textarea', placeholder: 'Mod pack URL, server notes, anything you want visible on this page.', span: 'full' },
];

// Submitting blank preserves the current value (backend ignores omitted keys).
const WRITE_ONLY = new Set(['OPS', 'MOTD']);

// Defaults shown when the form unlocks for a new season — explicitly
// blank so the previous server's TYPE/VERSION/ICON don't leak into the
// next one. Mirrors backend/lib/config.js DEFAULT_SETTINGS.
const DEFAULT_FORM_VALUES = {
  TYPE: 'VANILLA',
  VERSION: 'LATEST',
  DIFFICULTY: 'normal',
  MODE: 'survival',
  SEED: '',
  ONLINE_MODE: 'true',
  MOTD: '',
  OPS: '',
  ICON: '',
  DESCRIPTION: '',
};

let lastEditable = null;
let onActionCb = () => {};

export function buildForm() {
  const grid = document.querySelector('#settings-form .grid');
  for (const f of FIELDS) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.innerHTML = `<span>${f.label}</span>`;

    let input;
    if (f.type === 'select') {
      input = document.createElement('select');
      for (const opt of f.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        input.appendChild(o);
      }
    } else if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 3;
      if (f.placeholder) input.placeholder = f.placeholder;
    } else {
      input = document.createElement('input');
      input.type = f.type;
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    input.name = f.key;
    input.dataset.key = f.key;
    wrap.appendChild(input);
    if (f.span === 'full') wrap.classList.add('field-full');
    grid.appendChild(wrap);
  }

  // Repopulate VERSION whenever TYPE changes — each loader has its own
  // list and forge/fabric must NOT show LATEST.
  document.querySelector('[data-key="TYPE"]').addEventListener('change', () => syncVersionOptions());
}

export function syncVersionOptions(preferredValue) {
  const typeEl = document.querySelector('[data-key="TYPE"]');
  const verEl = document.querySelector('[data-key="VERSION"]');
  if (!typeEl || !verEl) return;
  const type = typeEl.value || 'VANILLA';
  const list = VERSION_LISTS[type] && VERSION_LISTS[type].length
    ? VERSION_LISTS[type]
    : (type === 'VANILLA' ? ['LATEST'] : []);
  verEl.innerHTML = '';
  if (!list.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(loading…)';
    verEl.appendChild(o);
    return;
  }
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    verEl.appendChild(o);
  }
  if (preferredValue && list.includes(preferredValue)) verEl.value = preferredValue;
}

export function initSettingsForm({ onAction }) {
  if (typeof onAction === 'function') onActionCb = onAction;

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await showModal({
      title: 'Start new server',
      message: 'A new 40-day season starts with a fresh world. The current server is archived and will be reachable from the Seasons page (coming soon).',
      confirmLabel: 'Start new server',
    });
    if (!ok) return;

    const body = {};
    for (const f of FIELDS) {
      const el = document.querySelector(`[data-key="${f.key}"]`);
      if (!el) continue;
      // Write-only fields: blank = "don't change". Omit so the backend preserves them.
      if (WRITE_ONLY.has(f.key) && !el.value.trim()) continue;
      body[f.key] = el.value;
    }
    const btn = $('apply-btn');
    btn.disabled = true;
    btn.textContent = 'Applying…';
    try { await postJSON('/api/settings', body); }
    catch (err) {
      await showModal({ title: 'Apply failed', message: err.message, cancelLabel: '' });
    }
    btn.disabled = false;
    btn.textContent = 'Start new server';
    onActionCb();
  });
}

// Show / hide the Settings tab based on whether the form is editable
// (firstRun OR season expired). Reset the inputs to defaults the moment
// the form transitions from locked to editable so the previous season's
// values don't leak into the next.
export function renderSettingsForm(s) {
  const settingsEditable = s.firstRun || s.expired;
  const settingsTab = document.querySelector('.tab[data-tab="settings"]');
  const settingsPanel = document.querySelector('.tab-panel[data-tab="settings"]');
  const wasOnSettings = settingsTab.classList.contains('active');
  settingsTab.hidden = !settingsEditable;
  if (!settingsEditable && wasOnSettings) {
    document.querySelector('.tab[data-tab="logs"]').click();
  }
  if (!settingsEditable) settingsPanel.hidden = true;

  const justBecameEditable = settingsEditable && lastEditable !== true;
  if (justBecameEditable) {
    for (const f of FIELDS) {
      const el = document.querySelector(`[data-key="${f.key}"]`);
      if (!el) continue;
      if (f.key === 'VERSION') continue;  // handled below after TYPE is set
      el.value = DEFAULT_FORM_VALUES[f.key] ?? '';
    }
    syncVersionOptions(DEFAULT_FORM_VALUES.VERSION);
  }
  lastEditable = settingsEditable;
}
