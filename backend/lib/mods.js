// Mod-related filesystem operations against the active season. Stages
// uploads, commits them on apply, deletes by name, wipes world dirs.
// All operations target SERVERS_DIR/<seasonName>/{mods,.staging-mods,…}
// directly — no docker / temp containers needed since the manager has
// the seasons dir mounted.

const fs = require('fs');
const path = require('path');
const { SERVERS_DIR } = require('./config');
const { seasonDataDir, seasonModsDir, seasonStagingDir } = require('./seasons');

// Modrinth/CurseForge often serve filenames URL-encoded (e.g. `%2B` for
// `+`). Decode first, then validate against the allowed-char set.
function safeModName(name) {
  let base = path.basename(String(name || ''));
  try {
    const decoded = decodeURIComponent(base);
    if (decoded) base = decoded;
  } catch { /* malformed % escapes — fall through */ }
  if (!/^[A-Za-z0-9._+\-() \[\]']+\.jar$/i.test(base)) return null;
  return base;
}

// Read .jar files from a dir, returning [{name, size}, …] sorted by name.
function listJars(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.jar'))
    .map(e => {
      try { return { name: e.name, size: fs.statSync(path.join(dir, e.name)).size }; }
      catch { return { name: e.name, size: 0 }; }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Best-effort delete by name. Logs warnings, never throws.
function deleteModFiles(seasonName, names) {
  const dir = seasonModsDir(seasonName);
  if (!dir || !names.length) return;
  for (const n of names) {
    try { fs.rmSync(path.join(dir, n), { force: true }); }
    catch (e) { console.warn(`mod delete ${n}:`, e.message); }
  }
}

// Move every staged .jar from .staging-mods/ into mods/, overwriting
// same-name files. Removes the staging dir afterwards. Returns the list
// of jar names that were moved.
function commitStagedMods(seasonName) {
  const stage = seasonStagingDir(seasonName);
  const live = seasonModsDir(seasonName);
  if (!stage || !live || !fs.existsSync(stage)) return [];
  fs.mkdirSync(live, { recursive: true });
  const moved = [];
  for (const e of fs.readdirSync(stage, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.jar')) continue;
    try {
      fs.renameSync(path.join(stage, e.name), path.join(live, e.name));
      moved.push(e.name);
    } catch (err) { console.warn(`commit ${e.name}:`, err.message); }
  }
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
  return moved;
}

// Drop every season's staging dir. Called once at manager startup so
// pending uploads from a previous process don't survive a manager
// reboot — matches the "leave the page → forget what was uploaded"
// semantic when the manager is restarted alongside.
function pruneAllStaging() {
  if (!SERVERS_DIR || !fs.existsSync(SERVERS_DIR)) return;
  for (const e of fs.readdirSync(SERVERS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const stage = path.join(SERVERS_DIR, e.name, '.staging-mods');
    if (fs.existsSync(stage)) {
      try {
        fs.rmSync(stage, { recursive: true, force: true });
        console.log(`pruned staging: ${stage}`);
      } catch (err) { console.warn(`prune ${stage}:`, err.message); }
    }
  }
}

// Wipe the world subdirs so the next MC boot regenerates terrain with
// whatever the freshly-loaded modset wants. Player-scoped files at
// /data root (whitelist/ops/banned-players, server.properties, mods/,
// config/) survive — only the world dirs are touched.
function wipeWorldDirs(seasonName) {
  const dir = seasonDataDir(seasonName);
  if (!dir) return;
  for (const sub of ['world', 'world_nether', 'world_the_end']) {
    try { fs.rmSync(path.join(dir, sub), { recursive: true, force: true }); }
    catch (e) { console.warn(`world wipe ${sub}:`, e.message); }
  }
}

module.exports = {
  safeModName, listJars,
  deleteModFiles, commitStagedMods, pruneAllStaging, wipeWorldDirs,
};
