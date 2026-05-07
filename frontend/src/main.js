import './style.css';

// Fields exposed to players when settings unlock.
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

// Minecraft version lists per server TYPE. The first list also includes LATEST
// for vanilla; forge & fabric require an explicit MC version (no LATEST).
const VERSION_LISTS = {
  VANILLA: ['LATEST'],
  FORGE:   [],
  FABRIC:  [],
};

const $ = (id) => document.getElementById(id);

// Fields that never display the stored value — only the placeholder.
// Submitting blank preserves the current value (backend ignores omitted keys).
const WRITE_ONLY = new Set(['OPS', 'MOTD']);

let firstRefresh = true;

// Mods staged for deletion in the UI but not yet committed to the server.
// Cleared after a successful Apply (which also stops/starts MC).
const pendingDeletions = new Set();

function buildForm() {
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
      if (f.min !== undefined) input.min = f.min;
      if (f.max !== undefined) input.max = f.max;
    }
    input.name = f.key;
    input.dataset.key = f.key;
    wrap.appendChild(input);
    if (f.span === 'full') wrap.classList.add('field-full');
    grid.appendChild(wrap);
  }

  // Repopulate VERSION whenever TYPE changes — each loader has its own list
  // and forge/fabric must NOT show LATEST.
  document.querySelector('[data-key="TYPE"]').addEventListener('change', () => {
    syncVersionOptions();
  });
}

function syncVersionOptions(preferredValue) {
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

function fmtCountdown(ms) {
  if (ms <= 0) return 'expired';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  if (d > 0) return `${d}d ${h}h left`;
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m left`;
}

function fmtElapsed(ms) {
  if (ms < 0) ms = 0;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${d}d ${h}h ${m}m`;
}

async function refresh() {
  let s;
  try {
    const res = await fetch('/api/state');
    s = await res.json();
  } catch {
    $('subtitle').textContent = 'manager unreachable';
    return;
  }

  // Status dot + text
  let dot = 'gray', text = 'Stopped', subtitle = '';
  if (!s.exists) {
    text = 'Not created yet';
    subtitle = 'No container exists. Start to create one.';
  } else if (s.online) {
    dot = 'green';
    text = `Online · ${s.version || ''}`.trim();
    subtitle = 'Connect using the address below.';
  } else if (s.running) {
    dot = 'yellow';
    text = 'Booting…';
    subtitle = 'Server is starting up.';
  } else {
    text = 'Stopped';
    subtitle = 'Click Start to launch the server.';
  }
  $('status-dot').className = `status-dot ${dot}`;
  $('status-text').textContent = text;
  $('subtitle').textContent = subtitle;
  $('players-text').textContent = s.online ? `${s.players} player${s.players === 1 ? '' : 's'}` : '';
  const names = s.playerNames || [];
  $('players-list').textContent = names.join(', ');
  $('players-list').hidden = names.length === 0;
  $('connect-line').textContent = s.online ? 's23ultra.com' : '';

  // MOTD — prefer live one from the server-list ping, fall back to stored.
  const motd = s.motd || s.settings?.MOTD || '';
  $('motd-line').textContent = motd;
  $('motd-line').hidden = !motd;

  // Description is manager-only; auto-link bare URLs so mod-pack links are
  // clickable. Only used for display, never sent to itzg.
  const desc = (s.settings?.DESCRIPTION || '').trim();
  const descEl = $('description-line');
  descEl.hidden = !desc;
  if (desc) {
    descEl.innerHTML = '';
    const parts = desc.split(/(https?:\/\/[^\s<>"']+)/g);
    for (const p of parts) {
      if (/^https?:\/\//.test(p)) {
        const a = document.createElement('a');
        a.href = p;
        a.textContent = p;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        descEl.appendChild(a);
      } else if (p) {
        descEl.appendChild(document.createTextNode(p));
      }
    }
  }

  // Start button: only show when the server isn't running.
  $('start-actions').hidden = s.running;
  $('start-btn').textContent = 'Start server';
  $('start-btn').disabled = false;

  // Season — counter keeps growing past day 40 once expired.
  $('season-label').textContent = s.firstRun ? 'Season' : `Season #${s.seasonId}`;
  if (s.firstRun) {
    $('season-bar').style.width = '0%';
    $('season-bar').className = '';
    $('season-info').textContent = 'No season yet — configure settings then click Start';
  } else {
    const totalDays = s.lifetimeDays + (s.extensionDays || 0);
    const total = totalDays * 86400000;
    const elapsedMs = Date.now() - s.seasonStarted;
    const pct = Math.max(0, Math.min(100, (elapsedMs / total) * 100));
    $('season-bar').style.width = pct + '%';
    $('season-bar').className = s.expired ? 'expired' : '';
    $('season-info').textContent = s.expired
      ? `${fmtElapsed(elapsedMs)} · expired`
      : `${fmtElapsed(elapsedMs)} · ${fmtCountdown(s.expiresAt - Date.now())}`;
  }
  $('extend-btn').hidden = !s.canExtend;
  $('extend-btn').textContent = `Extend season by ${s.extendBy || 5} days`;

  // The Settings tab is only available once the season has expired.
  // Hide both the tab button and the panel; bounce the user to Logs if
  // they were on Settings and it just got hidden.
  const settingsTab = document.querySelector('.tab[data-tab="settings"]');
  const settingsPanel = document.querySelector('.tab-panel[data-tab="settings"]');
  const wasOnSettings = settingsTab.classList.contains('active');
  settingsTab.hidden = !s.expired;
  if (!s.expired && wasOnSettings) {
    document.querySelector('.tab[data-tab="logs"]').click();
  }
  if (!s.expired) settingsPanel.hidden = true;

  // Only sync inputs from the server when the form is LOCKED, or on the
  // very first refresh. Otherwise the periodic refresh would clobber the
  // user's in-flight edits.
  const shouldSyncInputs = firstRefresh || !s.expired;
  if (shouldSyncInputs) {
    for (const f of FIELDS) {
      const el = document.querySelector(`[data-key="${f.key}"]`);
      if (!el) continue;
      if (f.key === 'VERSION') continue; // handled below after TYPE is set
      if (WRITE_ONLY.has(f.key)) { el.value = ''; continue; }
      if (s.settings[f.key] !== undefined) el.value = s.settings[f.key];
    }
    syncVersionOptions(s.settings?.VERSION);
  }
  firstRefresh = false;

  // Mods card lives inside the Logs panel. Hidden once the season expires —
  // at that point the only thing the operator should do is start a new
  // season from the Settings tab.
  const modsCard = $('mods-card');
  // Mods card is gated by modsAccessible — which on the backend is now
  // false whenever the lock is on, so clicking "End setup & lock mods"
  // hides the whole card on the next refresh.
  modsCard.hidden = !s.modsAccessible;
  if (s.modsAccessible) {
    // Apply button shows when there are pending changes — either uploads
    // waiting for a restart, or staged deletions waiting to be committed.
    const hasUploads = !!s.modsDirty;
    const hasDeletions = pendingDeletions.size > 0;
    const applyBtn = $('mods-apply-btn');
    applyBtn.hidden = !(hasUploads || hasDeletions);
    if (!applyBtn.hidden) {
      applyBtn.textContent = hasDeletions
        ? `Apply (delete ${pendingDeletions.size}, restart server)`
        : 'Restart server to load mods';
    }
    const left = Math.max(0, (s.modsWindowEndsAt || 0) - Date.now());
    $('mods-blurb').textContent =
      `Upload .jar mods for the active season. Setup window closes in ${fmtCountdown(left)}.`;
    refreshMods({ canUpload: true });
  }
}

document.getElementById('extend-btn').addEventListener('click', async () => {
  const btn = $('extend-btn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Extending…';
  try {
    const res = await fetch('/api/extend', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Failed to extend');
    }
  } catch (e) { alert(e.message); }
  btn.disabled = false;
  btn.textContent = original;
  refresh();
});

document.getElementById('start-btn').addEventListener('click', async () => {
  const btn = $('start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try { await fetch('/api/start', { method: 'POST' }); } catch {}
  btn.disabled = false;
  btn.textContent = 'Start server';
  refresh();
});

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!confirm('This will wipe the world and start a new 40-day season. Continue?')) return;
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
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Failed to apply settings');
    }
  } catch (e) { alert(e.message); }
  btn.disabled = false;
  btn.textContent = 'Apply & start new season';
  refresh();
});

async function loadVersions() {
  try {
    const r = await fetch('/api/versions');
    const list = await r.json();
    return Array.isArray(list) && list.length ? list : ['LATEST'];
  } catch { return ['LATEST']; }
}

async function loadJson(url, fallback) {
  try {
    const r = await fetch(url);
    const j = await r.json();
    return Array.isArray(j) ? j : fallback;
  } catch { return fallback; }
}

async function loadAllVersionLists() {
  const [vanilla, forge, fabric] = await Promise.all([
    loadVersions(),
    loadJson('/api/versions/forge', []),
    loadJson('/api/versions/fabric', []),
  ]);
  VERSION_LISTS.VANILLA = vanilla;
  VERSION_LISTS.FORGE   = forge;
  VERSION_LISTS.FABRIC  = fabric;
}

function setupTabs() {
  const buttons = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-panel');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      buttons.forEach(b => b.classList.toggle('active', b.dataset.tab === target));
      panels.forEach(p => { p.hidden = p.dataset.tab !== target; });
      if (target === 'logs') refreshLogs();
    });
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function refreshMods({ canUpload = false } = {}) {
  const list = $('mods-list');
  if (!list) return;
  let data;
  try {
    const r = await fetch('/api/mods');
    data = await r.json();
  } catch { return; }
  list.innerHTML = '';
  // Forget any staged deletions whose target is no longer on disk (e.g.
  // because Apply already ran). Otherwise the count would lie.
  const present = new Set((data.mods || []).map(m => m.name));
  for (const n of [...pendingDeletions]) if (!present.has(n)) pendingDeletions.delete(n);

  if (!data.mods || !data.mods.length) {
    const li = document.createElement('li');
    li.className = 'mods-empty';
    li.textContent = 'No mods uploaded yet.';
    list.appendChild(li);
    return;
  }
  for (const m of data.mods) {
    const li = document.createElement('li');
    li.className = 'mods-item';
    const staged = pendingDeletions.has(m.name);
    if (staged) li.classList.add('mods-item-pending');

    const name = document.createElement('span');
    name.className = 'mods-name';
    name.textContent = m.name;
    const meta = document.createElement('span');
    meta.className = 'mods-meta';
    meta.textContent = fmtSize(m.size);
    li.appendChild(name);
    li.appendChild(meta);
    if (canUpload) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mods-del';
      btn.textContent = staged ? 'Undo' : 'Remove';
      btn.addEventListener('click', () => {
        if (pendingDeletions.has(m.name)) pendingDeletions.delete(m.name);
        else pendingDeletions.add(m.name);
        // Re-render through the parent refresh so the apply-button state
        // and the per-row strikethrough both update together.
        refresh();
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}

document.getElementById('mods-apply-btn').addEventListener('click', async () => {
  const deletions = [...pendingDeletions];
  const msg = deletions.length
    ? `This will stop the server, permanently delete ${deletions.length} mod${deletions.length === 1 ? '' : 's'}, then start it back up. Continue?`
    : 'Restart the Minecraft server so the uploaded mods get loaded?';
  if (!confirm(msg)) return;
  const btn = $('mods-apply-btn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = deletions.length ? 'Stopping…' : 'Restarting…';
  try {
    const r = await fetch('/api/mods/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deletions }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(err.error || 'Apply failed');
    } else {
      pendingDeletions.clear();
    }
  } catch (e) { alert(e.message); }
  btn.disabled = false;
  btn.textContent = original;
  refresh();
});

document.getElementById('mods-end-btn').addEventListener('click', async () => {
  if (!confirm('End the setup window? Mods will be locked until next season.')) return;
  const btn = $('mods-end-btn');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Ending…';
  try {
    const r = await fetch('/api/setup/end', { method: 'POST' });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      alert(err.error || 'Failed to end setup');
    }
  } catch (e) { alert(e.message); }
  btn.disabled = false;
  btn.textContent = original;
  refresh();
});

function updateModsPickLabel() {
  const input = $('mods-input');
  const label = $('mods-pick-label');
  const btn = $('mods-upload-btn');
  const n = input.files ? input.files.length : 0;
  if (!n) {
    label.textContent = 'Choose .jar files';
    btn.disabled = true;
  } else if (n === 1) {
    label.textContent = input.files[0].name;
    btn.disabled = false;
  } else {
    label.textContent = `${n} files selected`;
    btn.disabled = false;
  }
}

document.getElementById('mods-input').addEventListener('change', updateModsPickLabel);

// Backend caps each request at 20 jars. Chunk larger selections so big
// modpacks (Forge/Fabric ones easily run 50+ files) upload in sequence
// instead of failing the batch.
const MODS_UPLOAD_CHUNK = 20;
const MODS_UPLOAD_MAX = 200;

document.getElementById('mods-upload-btn').addEventListener('click', async () => {
  const input = $('mods-input');
  const btn = $('mods-upload-btn');
  if (!input.files || !input.files.length) return;
  if (input.files.length > MODS_UPLOAD_MAX) {
    alert(`Too many files selected (${input.files.length}). Max ${MODS_UPLOAD_MAX} per upload.`);
    return;
  }
  const all = Array.from(input.files);
  const total = all.length;
  btn.disabled = true;
  let cleared = false;
  try {
    for (let i = 0; i < total; i += MODS_UPLOAD_CHUNK) {
      const chunk = all.slice(i, i + MODS_UPLOAD_CHUNK);
      btn.textContent = total > MODS_UPLOAD_CHUNK
        ? `Uploading ${Math.min(i + chunk.length, total)}/${total}…`
        : 'Uploading…';
      const fd = new FormData();
      for (const f of chunk) fd.append('mods', f, f.name);
      const r = await fetch('/api/mods', { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        const done = i;
        alert((err.error || 'Upload failed') +
          (done ? ` — ${done}/${total} uploaded before this error` : ''));
        break;
      }
      if (i + chunk.length >= total) cleared = true;
    }
    if (cleared) input.value = '';
  } catch (e) { alert(e.message); }
  btn.textContent = 'Upload';
  // updateModsPickLabel sets disabled to match the (possibly cleared) file
  // selection. Don't re-enable unconditionally — that overrides this and
  // leaves the orange button clickable with no files queued.
  updateModsPickLabel();
  refresh();
});

async function refreshLogs() {
  try {
    const r = await fetch('/api/logs?tail=400');
    const text = await r.text();
    const pre = $('logs');
    const wasAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    pre.textContent = text;
    if ($('logs-follow').checked && wasAtBottom) {
      pre.scrollTop = pre.scrollHeight;
    }
  } catch {}
}

(async () => {
  setupTabs();
  await loadAllVersionLists();
  buildForm();
  await refresh();
  setInterval(refresh, 10_000);
  setInterval(refreshLogs, 5_000);
})();
