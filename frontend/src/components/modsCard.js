// Mods card: file picker, mods list (active + queued), wipe-world
// toggle, single Apply button, Discard, End-setup. All upload state is
// browser-side (lib/pending.js) until Apply runs.

import { $, fmtSize, fmtCountdown } from '../lib/format.js';
import { showModal } from '../lib/modal.js';
import { getJSON, postJSON, postFormData, delJSON } from '../lib/api.js';
import {
  pendingFiles, pendingDeletions, pendingRemove, clearPending,
} from '../lib/pending.js';

// Chunk larger selections so big modpacks upload in sequence with
// per-chunk progress feedback. The backend has no per-request file
// count limit anymore — this is purely UI cadence.
const MODS_UPLOAD_CHUNK = 20;
const PICK_LABEL_DEFAULT = 'Upload .jar files';

let onActionCb = () => {};
let wipeWorldUserOverridden = false;

function setPickLabel(text, busy = false) {
  const label = $('mods-pick-label');
  const wrap = label.closest('.mods-pick');
  label.textContent = text;
  if (wrap) wrap.classList.toggle('busy', busy);
}

export function initModsCard({ onAction }) {
  if (typeof onAction === 'function') onActionCb = onAction;

  // File picker just QUEUES files — nothing leaves the browser yet.
  document.getElementById('mods-input').addEventListener('change', async (e) => {
    const input = e.target;
    if (!input.files || !input.files.length) return;
    const incoming = Array.from(input.files).filter(f => /\.jar$/i.test(f.name));
    for (const f of incoming) {
      // Same-name dedup: replace earlier picks of the same jar.
      pendingRemove(f.name);
      pendingFiles.push(f);
    }
    input.value = '';
    onActionCb();
  });

  document.getElementById('mods-apply-btn').addEventListener('click', () => applyMods());
  document.getElementById('mods-wipe-toggle').addEventListener('change', () => {
    wipeWorldUserOverridden = true;
  });

  document.getElementById('mods-discard-btn').addEventListener('click', async () => {
    if (!await showModal({
      title: 'Discard uploads',
      message: 'Drop the queued mod files? Mods that are already loaded on the server stay.',
      confirmLabel: 'Discard',
      danger: true,
    })) return;
    pendingFiles.length = 0;
    onActionCb();
  });

  document.getElementById('mods-end-btn').addEventListener('click', async () => {
    if (!await showModal({
      title: 'End setup',
      message: 'End the setup window? Mods will be locked until next season, and the [SETUP] MOTD prefix will be dropped.',
      confirmLabel: 'End setup',
    })) return;
    const btn = $('mods-end-btn');
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Ending…';
    try { await postJSON('/api/setup/end'); }
    catch (e) { await showModal({ title: 'End setup failed', message: e.message, cancelLabel: '' }); }
    btn.disabled = false;
    btn.textContent = original;
    onActionCb();
  });
}

async function applyMods() {
  const wipeWorld = $('mods-wipe-toggle').checked;
  const deletions = [...pendingDeletions];
  const uploads = pendingFiles.slice();
  const worldNote = wipeWorld
    ? 'The world WILL be reset so new worldgen-affecting mods take effect.'
    : 'The existing world will be PRESERVED.';
  const summary = [];
  if (uploads.length)   summary.push(`Upload ${uploads.length} mod${uploads.length === 1 ? '' : 's'}.`);
  if (deletions.length) summary.push(`Delete ${deletions.length} mod${deletions.length === 1 ? '' : 's'}.`);
  summary.push('Restart the Minecraft server.');
  if (!await showModal({
    title: wipeWorld ? 'Apply changes & reset world' : 'Apply changes & restart',
    message: `${summary.join(' ')} ${worldNote}`,
    confirmLabel: wipeWorld ? 'Reset world & restart' : 'Apply & restart',
    danger: wipeWorld,
  })) return;

  const btn = $('mods-apply-btn');
  const original = btn.textContent;
  btn.disabled = true;
  const setBtn = (text) => { btn.textContent = text; };

  let ok = false;
  try {
    // Wipe any orphan staging from a previous run so this apply starts
    // from a clean slate.
    if (uploads.length) {
      await delJSON('/api/mods/staging').catch(() => {});
    }
    // Upload queued files in chunks. Each chunk lands in the staging dir.
    for (let i = 0; i < uploads.length; i += MODS_UPLOAD_CHUNK) {
      const chunk = uploads.slice(i, i + MODS_UPLOAD_CHUNK);
      setBtn(uploads.length > MODS_UPLOAD_CHUNK
        ? `Uploading ${Math.min(i + chunk.length, uploads.length)} / ${uploads.length}…`
        : `Uploading ${uploads.length}…`);
      const fd = new FormData();
      for (const f of chunk) fd.append('mods', f, f.name);
      await postFormData('/api/mods', fd);
    }
    // Commit: server moves staged jars into /mods/, applies any
    // deletions, optionally wipes the world, restarts MC.
    setBtn(deletions.length ? 'Stopping…' : 'Restarting…');
    await postJSON('/api/mods/apply', { deletions, wipeWorld });
    ok = true;
  } catch (e) {
    await showModal({ title: 'Apply failed', message: e.message, cancelLabel: '' });
  }
  if (ok) {
    clearPending();
    wipeWorldUserOverridden = false;
  }
  btn.disabled = false;
  btn.textContent = original;
  onActionCb();
}

// Top-level apply-row state: button label, hint, end-setup visibility,
// wipe-world checkbox reset, blurb countdown. Called from main.js's
// refresh after we have the freshest /api/state.
export function renderModsCard(s) {
  const card = $('mods-card');
  card.hidden = !s.modsAccessible;
  if (!s.modsAccessible) return;

  const uploadCount = pendingFiles.length;
  const deleteCount = pendingDeletions.size;
  const hasUploads = uploadCount > 0;
  const hasDeletions = deleteCount > 0;
  const showApply = hasUploads || hasDeletions;

  $('mods-apply-row').hidden = !showApply;
  // End setup doesn't save pending uploads or deletions — hide it while
  // there are pending changes so the operator commits via Apply first.
  $('mods-end-btn').hidden = showApply;
  $('mods-discard-btn').hidden = !hasUploads;

  if (showApply) {
    const verbs = [];
    if (hasUploads)   verbs.push(`upload ${uploadCount}`);
    if (hasDeletions) verbs.push(`delete ${deleteCount}`);
    const verb = verbs.join(' + ');
    const cap = verb.charAt(0).toUpperCase() + verb.slice(1);
    $('mods-apply-btn').textContent = `${cap} and restart`;
    $('mods-apply-hint').textContent = '';
  }
  if (!wipeWorldUserOverridden) {
    $('mods-wipe-toggle').checked = false;
  }

  // Minimal blurb: just the countdown.
  const left = Math.max(0, (s.modsWindowEndsAt || 0) - Date.now());
  $('mods-blurb').textContent = fmtCountdown(left);
}

// Mods list (separate from the apply-row state above so it can poll on
// its own cadence). Renders both server-side active mods and the
// browser-side queued uploads, with delete/undo and queue-remove buttons.
export async function refreshModsList({ canUpload = false } = {}) {
  const list = $('mods-list');
  if (!list) return;
  let data;
  try { data = await getJSON('/api/mods'); }
  catch { return; }
  list.innerHTML = '';

  // Active mods on disk (filter out any orphan server-side staging).
  const active = (data.mods || []).filter(m => !m.pending);

  // Forget any staged deletions whose target is no longer on disk.
  const present = new Set(active.map(m => m.name));
  for (const n of [...pendingDeletions]) if (!present.has(n)) pendingDeletions.delete(n);

  if (!active.length && !pendingFiles.length) {
    const li = document.createElement('li');
    li.className = 'mods-empty';
    li.textContent = 'No mods yet. Click "Upload .jar files" to queue some.';
    list.appendChild(li);
    return;
  }

  // 1. Active server-side mods.
  const queuedNames = new Set(pendingFiles.map(f => f.name));
  for (const m of active) {
    const li = document.createElement('li');
    li.className = 'mods-item';
    const stagedForDelete = pendingDeletions.has(m.name);
    if (stagedForDelete) li.classList.add('mods-item-pending');

    const name = document.createElement('span');
    name.className = 'mods-name';
    name.textContent = m.name;
    const meta = document.createElement('span');
    meta.className = 'mods-meta';
    if (queuedNames.has(m.name)) meta.textContent = `${fmtSize(m.size)} · will be replaced`;
    else meta.textContent = fmtSize(m.size);
    li.appendChild(name);
    li.appendChild(meta);
    if (canUpload) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mods-del';
      btn.textContent = stagedForDelete ? 'Undo' : 'Remove';
      btn.addEventListener('click', () => {
        if (pendingDeletions.has(m.name)) pendingDeletions.delete(m.name);
        else pendingDeletions.add(m.name);
        onActionCb();
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  }

  // 2. Browser-queued uploads — visually distinct, with a Remove button
  //    that pulls the File out of the queue.
  for (const f of pendingFiles) {
    const li = document.createElement('li');
    li.className = 'mods-item mods-item-upload';
    const name = document.createElement('span');
    name.className = 'mods-name';
    name.textContent = f.name;
    const meta = document.createElement('span');
    meta.className = 'mods-meta';
    meta.textContent = `${fmtSize(f.size)} · queued`;
    li.appendChild(name);
    li.appendChild(meta);
    if (canUpload) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mods-del';
      btn.textContent = 'Remove';
      btn.addEventListener('click', () => {
        pendingRemove(f.name);
        onActionCb();
      });
      li.appendChild(btn);
    }
    list.appendChild(li);
  }
}
