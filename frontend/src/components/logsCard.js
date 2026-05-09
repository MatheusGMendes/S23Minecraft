// Server logs polling. Auto-scrolls to bottom only when the user was
// already at the bottom AND the follow checkbox is on, so scrolling
// up-to-history isn't yanked back.

import { $ } from '../lib/format.js';
import { getText } from '../lib/api.js';

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
