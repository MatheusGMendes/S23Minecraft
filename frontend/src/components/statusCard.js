// Top status card: status dot + text, players, MOTD, description,
// season progress bar, extend button.

import { $, fmtCountdown, fmtElapsed } from '../lib/format.js';
import { showModal } from '../lib/modal.js';
import { postJSON } from '../lib/api.js';

let onActionCb = () => {};

export function initStatusCard({ onAction }) {
  if (typeof onAction === 'function') onActionCb = onAction;

  document.getElementById('extend-btn').addEventListener('click', async () => {
    const btn = $('extend-btn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Extending…';
    try { await postJSON('/api/extend'); }
    catch (e) {
      await showModal({ title: 'Extend failed', message: e.message, cancelLabel: '' });
    }
    btn.disabled = false;
    btn.textContent = original;
    onActionCb();
  });
}

export function renderStatusCard(s) {
  // Status dot + text + subtitle
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

  // Description is manager-only; auto-link bare URLs.
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

  // Season progress bar — counter keeps growing past day 40 once expired.
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
}
