// Season filesystem layout helpers + per-season metadata file. Pure fs
// utilities — no docker, no DB. Used by the mod ops (mods.js), backup
// listing (latestBackupFor), and the seasons/listing route.

const fs = require('fs');
const path = require('path');
const { SERVERS_DIR, BACKUPS_DIR, MC_COMPOSE_FILE } = require('./config');

// Per-season directory tree — all paths live under SERVERS_DIR.
//   <seasonName>/                ← seasonDataDir
//     mods/                      ← seasonModsDir (active modset)
//     .staging-mods/             ← seasonStagingDir (pending uploads)
//     .s23-meta.json             ← seasonMetaFile (manager-managed metadata)
//     world/, world_nether/, world_the_end/  (created by MC)

function seasonDataDir(seasonName) {
  if (!SERVERS_DIR || !seasonName) return null;
  return path.join(SERVERS_DIR, seasonName);
}
function seasonModsDir(seasonName) {
  const d = seasonDataDir(seasonName);
  return d ? path.join(d, 'mods') : null;
}
function seasonStagingDir(seasonName) {
  const d = seasonDataDir(seasonName);
  return d ? path.join(d, '.staging-mods') : null;
}
function seasonMetaFile(seasonName) {
  const d = seasonDataDir(seasonName);
  return d ? path.join(d, '.s23-meta.json') : null;
}

function readSeasonMeta(seasonName) {
  const f = seasonMetaFile(seasonName);
  if (!f || !fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch { return null; }
}

// Patch-merge meta. Reads → spreads patch → writes.
function writeSeasonMeta(seasonName, patch) {
  const f = seasonMetaFile(seasonName);
  if (!f) return;
  const dir = seasonDataDir(seasonName);
  fs.mkdirSync(dir, { recursive: true });
  const prev = readSeasonMeta(seasonName) || {};
  const next = { ...prev, ...patch };
  fs.writeFileSync(f, JSON.stringify(next, null, 2));
}

// Snapshot the current MC compose into the season folder so the exact
// yml that ran this season is preserved next to its world data — useful
// when reading old seasons back without the manager around.
function snapshotMcCompose(seasonName) {
  const dir = seasonDataDir(seasonName);
  if (!dir || !fs.existsSync(MC_COMPOSE_FILE)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(MC_COMPOSE_FILE, path.join(dir, path.basename(MC_COMPOSE_FILE)));
}

// Find the most recent .tgz / .tar.gz / .zip in a season's backups dir.
// Returns { name, size, mtimeMs } or null.
function latestBackupFor(seasonName) {
  if (!BACKUPS_DIR || !seasonName) return null;
  const dir = path.join(BACKUPS_DIR, seasonName);
  if (!fs.existsSync(dir)) return null;
  let best = null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    if (!/\.(tgz|tar\.gz|zip)$/i.test(e.name)) continue;
    try {
      const st = fs.statSync(path.join(dir, e.name));
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { name: e.name, size: st.size, mtimeMs: st.mtimeMs };
      }
    } catch { /* skip unreadable entry */ }
  }
  return best;
}

module.exports = {
  seasonDataDir, seasonModsDir, seasonStagingDir, seasonMetaFile,
  readSeasonMeta, writeSeasonMeta, snapshotMcCompose, latestBackupFor,
};
