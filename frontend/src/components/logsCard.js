// Server logs polling. Auto-scrolls to bottom only when the user was
// already at the bottom AND the follow checkbox is on, so scrolling
// up-to-history isn't yanked back.

import { $ } from '../lib/format.js';
import { getJSON, getText } from '../lib/api.js';

export async function refreshLogs() {
  try {
    const text = await getText('/api/logs?tail=400');
    const pre = $('logs');
    const wasAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
    pre.textContent = text;
    if ($('logs-follow').checked && wasAtBottom) {
      pre.scrollTop = pre.scrollHeight;
    }
  } catch { /* manager unreachable — keep last view */ }
}

async function downloadLogs() {
  const btn = $('logs-download');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Preparing…';
  try {
    // tail=2000 is the API's max; gives a generous window without
    // streaming the entire container log buffer.
    const [s, text] = await Promise.all([
      getJSON('/api/state').catch(() => ({})),
      getText('/api/logs?tail=2000'),
    ]);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = `${s.seasonName || 'minecraft'}-${stamp}.log.txt`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('log download failed:', e);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

export function initLogsCard() {
  $('logs-download').addEventListener('click', downloadLogs);
}
