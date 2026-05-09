// Past seasons card: paginated list of archived seasons with version
// info + latest-backup download link.

import { $, fmtSize } from '../lib/format.js';
import { getJSON } from '../lib/api.js';

const SEASONS_PAGE = 5;
let seasonsShown = SEASONS_PAGE;
let seasonsCache = [];

export function initSeasonsCard() {
  document.getElementById('seasons-more-btn').addEventListener('click', () => {
    seasonsShown += SEASONS_PAGE;
    renderSeasons();
  });
}

export async function refreshSeasons() {
  const card = $('seasons-card');
  const list = $('seasons-list');
  if (!card || !list) return;
  let data;
  try { data = await getJSON('/api/seasons'); }
  catch { return; }
  seasonsCache = data.seasons || [];
  renderSeasons();
}

function renderSeasons() {
  const card = $('seasons-card');
  const list = $('seasons-list');
  const moreBtn = $('seasons-more-btn');
  if (!card || !list || !moreBtn) return;
  const seasons = seasonsCache;
  card.hidden = seasons.length === 0;
  list.innerHTML = '';

  const fmtDate = (ms) => ms ? new Date(ms).toISOString().slice(0, 10) : '?';
  const visible = seasons.slice(0, seasonsShown);
  for (const sn of visible) {
    const li = document.createElement('li');
    li.className = 'seasons-item';

    const head = document.createElement('div');
    head.className = 'seasons-head';
    const title = document.createElement('span');
    title.className = 'seasons-title';
    title.textContent = `Season #${sn.seasonId || '?'}`;
    const ver = document.createElement('span');
    ver.className = 'seasons-ver';
    if (sn.settings) {
      ver.textContent = `${sn.settings.TYPE || 'VANILLA'} · ${sn.settings.VERSION || 'LATEST'}`;
    } else {
      ver.textContent = 'unknown version';
      ver.classList.add('seasons-ver-muted');
    }
    head.appendChild(title);
    head.appendChild(ver);

    const meta = document.createElement('div');
    meta.className = 'seasons-meta';
    const start = fmtDate(sn.startedAt);
    const end = sn.endedAt ? fmtDate(sn.endedAt) : 'open';
    meta.textContent = `${sn.name} · ${start} → ${end}`;

    li.appendChild(head);
    li.appendChild(meta);

    if (sn.latestBackup) {
      const dl = document.createElement('a');
      dl.className = 'seasons-download';
      dl.href = `/api/seasons/${encodeURIComponent(sn.name)}/backup`;
      dl.textContent = `Download backup · ${fmtSize(sn.latestBackup.size)}`;
      dl.setAttribute('download', '');
      li.appendChild(dl);
    } else {
      const noBackup = document.createElement('span');
      noBackup.className = 'seasons-nobackup';
      noBackup.textContent = 'No backup available';
      li.appendChild(noBackup);
    }
    list.appendChild(li);
  }

  const remaining = seasons.length - visible.length;
  moreBtn.hidden = remaining <= 0;
  if (remaining > 0) {
    moreBtn.textContent = `Load ${Math.min(SEASONS_PAGE, remaining)} more`;
  }
}
