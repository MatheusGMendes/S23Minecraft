import './style.css';

// Fields exposed to players when settings unlock.
const FIELDS = [
  { key: 'VERSION',     label: 'Version',      type: 'select', options: ['LATEST'] },
  { key: 'DIFFICULTY',  label: 'Difficulty',   type: 'select', options: ['peaceful', 'easy', 'normal', 'hard'] },
  { key: 'MODE',        label: 'Game mode',    type: 'select', options: ['survival', 'creative', 'adventure', 'spectator'] },
  { key: 'SEED',        label: 'Seed',         type: 'text',   placeholder: '(random)' },
  { key: 'ONLINE_MODE', label: 'Online mode',  type: 'select', options: ['true', 'false'] },
  { key: 'MOTD',        label: 'MOTD',         type: 'text',   placeholder: 'Welcome to the server' },
  { key: 'OPS',         label: 'Ops',          type: 'text',   placeholder: 'name1,name2,name3' },
  { key: 'ICON',        label: 'Icon URL',     type: 'text',   placeholder: 'https://example.com/icon.png' },
];

const $ = (id) => document.getElementById(id);

// Fields that never display the stored value — only the placeholder.
// Submitting blank preserves the current value (backend ignores omitted keys).
const WRITE_ONLY = new Set(['OPS', 'MOTD']);

let firstRefresh = true;

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
    grid.appendChild(wrap);
  }
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

  // Start button: only show when the server isn't running.
  $('start-actions').hidden = s.running;
  $('start-btn').textContent = 'Start server';
  $('start-btn').disabled = false;

  // Season — counter keeps growing past day 40 once expired.
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
      if (WRITE_ONLY.has(f.key)) { el.value = ''; continue; }
      if (s.settings[f.key] !== undefined) el.value = s.settings[f.key];
    }
  }
  firstRefresh = false;
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
  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Starting…';
  try { await fetch('/api/start', { method: 'POST' }); } catch {}
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
  $('apply-btn').disabled = true;
  $('apply-btn').textContent = 'Applying…';
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
  $('apply-btn').textContent = 'Apply & start new season';
  refresh();
});

async function loadVersions() {
  try {
    const r = await fetch('/api/versions');
    const list = await r.json();
    return Array.isArray(list) && list.length ? list : ['LATEST'];
  } catch { return ['LATEST']; }
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
  const versionField = FIELDS.find(f => f.key === 'VERSION');
  versionField.options = await loadVersions();
  buildForm();
  await refresh();
  setInterval(refresh, 10_000);
  setInterval(refreshLogs, 5_000);
})();
