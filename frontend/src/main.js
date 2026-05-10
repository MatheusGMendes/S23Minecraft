// Entry: import everything, wire up tabs, kick off the refresh loops.
// Side effects on import:
//   - lib/modal.js wires global keydown/click listeners
//   - lib/pending.js exports installUnloadGuard() (called below)

import './style.css';

import { $ } from './lib/format.js';
import { getJSON } from './lib/api.js';
import { installUnloadGuard } from './lib/pending.js';
import { loadAllVersionLists } from './lib/versions.js';

import { initTabs } from './components/tabs.js';
import { initStatusCard, renderStatusCard } from './components/statusCard.js';
import {
  buildForm, initSettingsForm, renderSettingsForm,
} from './components/settingsForm.js';
import {
  initModsCard, renderModsCard, refreshModsList,
} from './components/modsCard.js';
import { initLogsCard, refreshLogs } from './components/logsCard.js';
import { initSeasonsCard, refreshSeasons } from './components/seasonsCard.js';

// Single refresh: pull the freshest /api/state, then fan it out to every
// component that cares. Components keep their own local state (lists,
// counters, transition memory) — this is just the periodic-render path.
async function refresh() {
  let s;
  try { s = await getJSON('/api/state'); }
  catch {
    $('subtitle').textContent = 'manager unreachable';
    return;
  }
  renderStatusCard(s);
  renderSettingsForm(s);
  renderModsCard(s);
  if (s.modsAccessible) refreshModsList({ canUpload: true }).catch(() => {});
}

(async () => {
  installUnloadGuard();
  initTabs((target) => { if (target === 'logs') refreshLogs(); });
  initStatusCard({ onAction: refresh });
  initSettingsForm({ onAction: refresh });
  initModsCard({ onAction: refresh });
  initSeasonsCard();
  initLogsCard();

  await loadAllVersionLists();
  buildForm();

  await refresh();
  await refreshSeasons();

  setInterval(refresh,        10_000);
  setInterval(refreshLogs,     5_000);
  setInterval(refreshSeasons, 30_000);
})();
