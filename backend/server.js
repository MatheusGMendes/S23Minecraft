const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Docker = require('dockerode');
const Database = require('better-sqlite3');
const multer = require('multer');
const tar = require('tar-stream');
const { status } = require('minecraft-server-util');

// ---- Config ---------------------------------------------------------------

const PORT             = process.env.PORT || 3000;
const DATA_DIR         = process.env.DATA_DIR || path.join(__dirname, 'data');
const MC_COMPOSE_DIR   = process.env.MC_COMPOSE_DIR || '/mc';
const MC_CONTAINER     = process.env.MC_CONTAINER   || 's23-minecraft';
const MC_HOST          = process.env.MC_HOST        || 'host.docker.internal';
const MC_PORT          = Number(process.env.MC_PORT || 25565);
const LIFETIME_DAYS    = Number(process.env.LIFETIME_DAYS || 40);
const EXTEND_DAYS      = Number(process.env.EXTEND_DAYS   || 5);
const HIDDEN_OPS       = process.env.HIDDEN_OPS || '';
const EXTEND_WINDOW_MS = 24 * 60 * 60 * 1000; // last 24h before expiry

// itzg env vars exposed to players. Keep in sync with frontend FIELDS.
// DESCRIPTION is manager-only — itzg ignores it; we just display it on the
// status page so the operator can post mod links / notes for visitors.
const SETTING_KEYS = [
  'TYPE', 'VERSION', 'DIFFICULTY', 'MODE',
  'SEED', 'ONLINE_MODE', 'MOTD', 'OPS', 'ICON', 'DESCRIPTION',
];

const SERVER_TYPES = ['VANILLA', 'FORGE', 'FABRIC'];

const DEFAULT_SETTINGS = {
  TYPE: 'VANILLA',
  VERSION: 'LATEST',
  DIFFICULTY: 'normal',
  MODE: 'survival',
  SEED: '',
  ONLINE_MODE: 'true',
  MOTD: 'S23 Minecraft',
  OPS: '',
  ICON: '',
  DESCRIPTION: '',
};

// Window after a season starts during which players can upload mods.
const MODS_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---- Storage --------------------------------------------------------------

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'state.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    season_started INTEGER NOT NULL,
    settings TEXT NOT NULL
  );
`);

// Migrate: add new columns if missing (for existing DBs).
const cols = db.prepare('PRAGMA table_info(state)').all().map(r => r.name);
if (!cols.includes('extension_days')) {
  db.exec('ALTER TABLE state ADD COLUMN extension_days INTEGER NOT NULL DEFAULT 0');
}
if (!cols.includes('season_id')) {
  // Default 0 means "no season started yet" — the first run hasn't kicked
  // off the world. Bumps to 1 the first time the user clicks Start or
  // submits settings. Until then the form is editable so the deployer can
  // configure version/MOTD/OPS before the season clock starts.
  db.exec('ALTER TABLE state ADD COLUMN season_id INTEGER NOT NULL DEFAULT 0');
}
if (!cols.includes('rcon_password')) {
  db.exec("ALTER TABLE state ADD COLUMN rcon_password TEXT NOT NULL DEFAULT ''");
}
// `mods_locked` is the single source of truth for whether mod uploads/deletes
// are allowed for the current season. It auto-flips to 1 once the upload
// window has elapsed (see getState), is reset to 0 on a new season, and can
// be toggled by the user (UI button) or admin (s23 setup-end / setup-start).
if (!cols.includes('mods_locked')) {
  db.exec('ALTER TABLE state ADD COLUMN mods_locked INTEGER NOT NULL DEFAULT 1');
}
// `mods_dirty` flips to 1 on any successful upload or delete and back to 0
// after the MC container is restarted — drives the "Restart server to load
// mods" button visibility.
if (!cols.includes('mods_dirty')) {
  db.exec('ALTER TABLE state ADD COLUMN mods_dirty INTEGER NOT NULL DEFAULT 0');
}
// `mods_auto_locked` is a one-shot flag: once the 24h auto-lock has fired
// for the current season, this stays 1 even if an admin re-opens the lock
// via setup-start. Otherwise the next getState() would just relock again
// because the time-based gate is past. Reset to 0 on a new season.
if (!cols.includes('mods_auto_locked')) {
  db.exec('ALTER TABLE state ADD COLUMN mods_auto_locked INTEGER NOT NULL DEFAULT 1');
}

function seasonNameFor(seasonId, seasonStartedMs) {
  const d = new Date(seasonStartedMs);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `season-${String(seasonId).padStart(3, '0')}-${date}`;
}

const existing = db.prepare('SELECT settings FROM state WHERE id = 1').get();
if (!existing) {
  // Fresh install — sit in firstRun mode (season_id = 0) until the user
  // actually starts the server.
  db.prepare('INSERT INTO state (id, season_started, settings, season_id) VALUES (1, 0, ?, 0)')
    .run(JSON.stringify(DEFAULT_SETTINGS));
} else {
  const stored = JSON.parse(existing.settings);
  let changed = false;
  for (const k of SETTING_KEYS) {
    if (stored[k] === undefined) { stored[k] = DEFAULT_SETTINGS[k]; changed = true; }
  }
  if (changed) {
    db.prepare('UPDATE state SET settings = ? WHERE id = 1').run(JSON.stringify(stored));
  }
}

const getState = () => {
  const r = db.prepare(`
    SELECT season_started, settings, extension_days, season_id,
           mods_locked, mods_dirty, mods_auto_locked
      FROM state WHERE id = 1
  `).get();
  const seasonId = r.season_id || 0;
  // Lazy auto-lock: once the upload window has elapsed AND the auto-lock
  // hasn't already fired this season, persist mods_locked=1. After it
  // fires, an admin override (s23 setup-start) sticks — we never auto-lock
  // again until a new season resets the flag.
  let modsLocked = r.mods_locked ? 1 : 0;
  if (!r.mods_auto_locked && seasonId !== 0 &&
      Date.now() - r.season_started >= MODS_UPLOAD_WINDOW_MS) {
    db.prepare('UPDATE state SET mods_locked = 1, mods_auto_locked = 1 WHERE id = 1').run();
    modsLocked = 1;
  }
  return {
    seasonStarted: r.season_started,
    settings: JSON.parse(r.settings),
    extensionDays: r.extension_days || 0,
    seasonId,
    seasonName: seasonId === 0 ? '' : seasonNameFor(seasonId, r.season_started),
    firstRun: seasonId === 0,
    modsLocked,
    modsDirty: r.mods_dirty ? 1 : 0,
  };
};

// startNewSeason: bumps season_id, resets timer + extension. World folder
// changes name so the existing world stays as an on-disk archive.
const startNewSeason = (settings) => {
  const now = Date.now();
  db.prepare(`
    UPDATE state
       SET settings = ?, season_started = ?, extension_days = 0, season_id = season_id + 1
     WHERE id = 1
  `).run(JSON.stringify(settings), now);
};

const setState = (settings) => {
  db.prepare('UPDATE state SET settings = ? WHERE id = 1').run(JSON.stringify(settings));
};

const expiresAtFor = (s) =>
  s.seasonStarted + (LIFETIME_DAYS + s.extensionDays) * 86400 * 1000;

// True when the season clock has run out. Computed from seasonStarted +
// LIFETIME + extension_days, same formula the /api/state route uses.
const isExpiredFor = (s) =>
  !s.firstRun && Date.now() >= expiresAtFor(s);

// modsAccessible — whether the Mods section should even be visible. Hidden
// once the season expires (only Settings should be reachable then), on
// firstRun / vanilla servers, AND once the operator has locked the modset
// (End setup / s23 setup-end / 24 h auto-lock). canUploadMods is just an
// alias since we no longer expose a read-only view.
const isModsAccessibleFor = (s) => {
  if (s.firstRun) return false;
  if ((s.settings?.TYPE || 'VANILLA') === 'VANILLA') return false;
  if (isExpiredFor(s)) return false;
  if (s.modsLocked) return false;
  return true;
};

const canUploadModsFor = (s) => isModsAccessibleFor(s);

// ---- Compose control ------------------------------------------------------

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

function compose(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['compose', ...args], { cwd: MC_COMPOSE_DIR }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });
}

function mergeOps(playerInput) {
  const all = [HIDDEN_OPS, playerInput]
    .flatMap(s => String(s || '').split(','))
    .map(s => s.trim())
    .filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const name of all) {
    const key = name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(name); }
  }
  return out.join(',');
}

// If the user's compose dir is empty (first run), drop in the bundled
// default MC compose so things work out of the box. Also auto-patch known
// stale lines on existing files — early bootstraps hardcoded `TYPE: "VANILLA"`,
// which silently overrode the TYPE the player picks in the UI. Rewrite it
// to the templated form so the .env value flows through.
function ensureMcComposeFile() {
  const composeFile = path.join(MC_COMPOSE_DIR, 'docker-compose.yml');
  if (!fs.existsSync(composeFile)) {
    const defaultPath = '/app/default-mc-compose.yml';
    if (!fs.existsSync(defaultPath)) return;
    fs.mkdirSync(MC_COMPOSE_DIR, { recursive: true });
    fs.copyFileSync(defaultPath, composeFile);
    console.log(`Initialized default MC compose at ${composeFile}`);
    return;
  }
  try {
    const original = fs.readFileSync(composeFile, 'utf8');
    const patched = original.replace(
      /^(\s*)TYPE:\s*"?VANILLA"?\s*$/m,
      '$1TYPE: ${TYPE:-VANILLA}',
    );
    if (patched !== original) {
      fs.writeFileSync(composeFile, patched);
      console.log(`Auto-patched hardcoded TYPE in ${composeFile}`);
    }
  } catch (e) { console.warn('compose auto-patch failed:', e.message); }
}

function ensureRconPassword() {
  const r = db.prepare('SELECT rcon_password FROM state WHERE id = 1').get();
  if (r?.rcon_password) return r.rcon_password;
  const pw = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE state SET rcon_password = ? WHERE id = 1').run(pw);
  return pw;
}

// Settings that exist for the manager UI only — never written to .env so
// itzg's compose substitution doesn't have to deal with multiline values
// or env-name reserved characters.
const MANAGER_ONLY_KEYS = new Set(['DESCRIPTION']);

function writeEnvFile(settings, seasonName) {
  ensureMcComposeFile();
  const rconPassword = ensureRconPassword();
  const lines = SETTING_KEYS
    .filter(k => !MANAGER_ONLY_KEYS.has(k))
    .map(k => {
      const value = k === 'OPS' ? mergeOps(settings[k]) : (settings[k] ?? '');
      return `${k}=${value}`;
    });
  lines.unshift(`SEASON_NAME=${seasonName}`);
  lines.push(`RCON_PASSWORD=${rconPassword}`);
  fs.writeFileSync(path.join(MC_COMPOSE_DIR, '.env'), lines.join('\n') + '\n');
}

async function findMc() {
  try {
    const list = await docker.listContainers({ all: true });
    const c = list.find(c => c.Names.some(n => n === '/' + MC_CONTAINER));
    return c ? docker.getContainer(c.Id) : null;
  } catch { return null; }
}

// Force-remove a container by its hardcoded name if it exists. Used as a
// safety net before `compose up` — if a previous run (or a manual command
// from a different cwd / project name) left a container with this name
// behind, our compose project can't see it but `up` would still hit a
// "container name already in use" daemon error. Wiping by name avoids that.
async function forceRemoveByName(name) {
  try {
    await docker.getContainer(name).remove({ force: true });
    console.log(`removed stale container ${name}`);
  } catch (e) {
    // 404 = not found, fine. Anything else is worth surfacing.
    if (e.statusCode !== 404) console.warn(`could not remove ${name}: ${e.message}`);
  }
}

async function startCompose() {
  const s = getState();
  const now = Date.now();
  // For firstRun, compute season-1 values in memory but DON'T commit to DB
  // until compose actually succeeds. Otherwise a misconfig (bad
  // MC_COMPOSE_DIR, missing folder, etc.) would bump the season counter
  // even though no server actually started.
  const seasonName = s.firstRun ? seasonNameFor(1, now) : s.seasonName;
  writeEnvFile(s.settings, seasonName);
  await forceRemoveByName(MC_CONTAINER);
  await forceRemoveByName(`${MC_CONTAINER}-backups`);
  await compose(['up', '-d']);
  if (s.firstRun) {
    db.prepare(`
      UPDATE state SET season_id = 1, season_started = ?, extension_days = 0,
                       mods_locked = 0, mods_dirty = 0, mods_auto_locked = 0
       WHERE id = 1
    `).run(now);
  }
}

async function validateIconUrl(url) {
  if (!url || !url.trim()) return { ok: true };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    } catch {
      // Some hosts reject HEAD — fall back to GET, abort right after first byte.
      res = await fetch(url, { method: 'GET', signal: ctrl.signal });
      try { res.body && res.body.cancel && await res.body.cancel(); } catch {}
    }
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `icon URL returned ${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return { ok: false, error: `icon URL is not an image (content-type: ${ct || 'unknown'})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `icon URL not reachable: ${e.message}` };
  }
}

async function applyNewSeason(newSettings) {
  const s = getState();
  const now = Date.now();
  const newSeasonId = (s.seasonId || 0) + 1;
  const seasonName = seasonNameFor(newSeasonId, now);

  // 1. Write the new .env first. If MC_COMPOSE_DIR is misconfigured this
  //    fails before we touch any running containers or the DB.
  writeEnvFile(newSettings, seasonName);

  // 2. Stop the old season's containers (compose down, no -v).
  try { await compose(['down']); } catch (e) { console.warn('down warn:', e.message); }

  // 2b. Compose only sees containers under its own project name. If a
  //     previous run left a container with the same name under a
  //     different project (e.g. someone ran `docker compose -f ...` from
  //     a different cwd), `up` would 409 with "container name already in
  //     use". Wipe by name to be safe.
  await forceRemoveByName(MC_CONTAINER);
  await forceRemoveByName(`${MC_CONTAINER}-backups`);

  // 3. Bring up the new season.
  await compose(['up', '-d']);

  // 4. Only commit the new state to the DB after compose succeeds. Reset
  //    mods_locked + mods_dirty + mods_auto_locked so the new season opens
  //    with a fresh upload window (auto-relocks 24h later via getState).
  db.prepare(`
    UPDATE state
       SET settings = ?, season_started = ?, extension_days = 0, season_id = ?,
           mods_locked = 0, mods_dirty = 0, mods_auto_locked = 0
     WHERE id = 1
  `).run(JSON.stringify(newSettings), now, newSeasonId);
}

// ---- Status ---------------------------------------------------------------

async function getMcStatus() {
  const c = await findMc();
  if (!c) return { exists: false, running: false, online: false, players: 0, version: null, motd: null, playerNames: [] };
  const info = await c.inspect();
  const running = info.State.Running;
  let online = false, players = 0, version = null, motd = null, playerNames = [];
  if (running) {
    try {
      const s = await status(MC_HOST, MC_PORT, { timeout: 3000 });
      online = true;
      players = s.players.online;
      version = s.version.name;
      motd = s.motd?.clean ?? s.motd?.raw ?? null;
      playerNames = (s.players.sample || []).map(p => p.name).filter(Boolean);
    } catch { /* still booting */ }
  }
  return { exists: true, running, online, players, version, motd, playerNames };
}

// ---- API ------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', async (_req, res) => {
  try {
    const s = getState();
    const mc = await getMcStatus();
    const expiresAt = expiresAtFor(s);
    const expired = !s.firstRun && Date.now() >= expiresAt;
    // Allow extending whenever we're either inside the last-day window OR
    // already expired — but never on firstRun (no clock to extend yet).
    const canExtend = !s.firstRun && (expired || (expiresAt - Date.now() <= EXTEND_WINDOW_MS));
    const canUploadMods = canUploadModsFor(s);
    const modsWindowEndsAt = s.firstRun ? null : s.seasonStarted + MODS_UPLOAD_WINDOW_MS;
    res.json({
      ...mc,
      seasonStarted: s.seasonStarted,
      expiresAt,
      expired,
      firstRun: s.firstRun,
      lifetimeDays: LIFETIME_DAYS,
      extensionDays: s.extensionDays,
      seasonId: s.seasonId,
      seasonName: s.seasonName,
      canExtend,
      extendBy: EXTEND_DAYS,
      canUploadMods,
      modsAccessible: isModsAccessibleFor(s),
      modsWindowEndsAt,
      modsLocked: !!s.modsLocked,
      modsDirty: !!s.modsDirty,
      serverTypes: SERVER_TYPES,
      settings: s.settings,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/extend', (_req, res) => {
  try {
    const s = getState();
    const expiresAt = expiresAtFor(s);
    const expired = Date.now() >= expiresAt;
    const inWindow = expiresAt - Date.now() <= EXTEND_WINDOW_MS;
    if (!expired && !inWindow) {
      return res.status(403).json({ error: 'extension only available on the last day or after expiry' });
    }
    db.prepare('UPDATE state SET extension_days = extension_days + ? WHERE id = 1')
      .run(EXTEND_DAYS);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/start', async (_req, res) => {
  try { await startCompose(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Restart the MC container — used after uploading mods so the new jars get
// loaded. Writes the .env first so any setting changes (TYPE/VERSION) also
// take effect on the restart. Gated by the mods lock so a frozen season
// cannot be bounced through this endpoint.
app.post('/api/mc/restart', async (_req, res) => {
  try {
    const s = getState();
    if (s.firstRun) return res.status(400).json({ error: 'no season started yet' });
    if (!canUploadModsFor(s)) {
      return res.status(403).json({ error: 'mods are locked for this season' });
    }
    writeEnvFile(s.settings, s.seasonName);
    await compose(['up', '-d', '--force-recreate', 'minecraft']);
    db.prepare('UPDATE state SET mods_dirty = 0 WHERE id = 1').run();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// End the setup window — locks mod uploads/deletes/restart for the rest of
// the season. Same effect as the 24h auto-lock or the s23 setup-end CLI.
app.post('/api/setup/end', (_req, res) => {
  try {
    const s = getState();
    if (s.firstRun) return res.status(400).json({ error: 'no season started yet' });
    db.prepare('UPDATE state SET mods_locked = 1 WHERE id = 1').run();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const s = getState();
    // Allowed when there's no season yet (firstRun) OR the season has expired.
    if (!s.firstRun && Date.now() < expiresAtFor(s)) {
      return res.status(403).json({ error: 'season is still active — settings are locked' });
    }
    // Start from CURRENT settings, not defaults — that way any keys the
    // frontend chose to omit (e.g. blank OPS) keep their existing value.
    const newSettings = { ...DEFAULT_SETTINGS, ...s.settings };
    for (const k of SETTING_KEYS) {
      if (req.body[k] !== undefined) newSettings[k] = String(req.body[k]);
    }
    // Validate the icon URL BEFORE doing anything destructive — a bad URL
    // makes itzg crash on boot and the container would loop forever.
    const iconCheck = await validateIconUrl(newSettings.ICON);
    if (!iconCheck.ok) return res.status(400).json({ error: iconCheck.error });
    await applyNewSeason(newSettings);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/check-icon', async (req, res) => {
  res.json(await validateIconUrl(req.body?.url || ''));
});

// ---- Versions (Mojang release manifest, cached 1h) ------------------------

const VERSIONS_TTL_MS = 60 * 60 * 1000;
let versionsCache = { ts: 0, data: ['LATEST'] };

app.get('/api/versions', async (_req, res) => {
  if (Date.now() - versionsCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const j = await r.json();
      const releases = j.versions.filter(v => v.type === 'release').map(v => v.id);
      versionsCache = { ts: Date.now(), data: ['LATEST', ...releases] };
    } catch (e) { console.warn('versions fetch failed:', e.message); }
  }
  res.json(versionsCache.data);
});

// Sort MC version strings like "1.21.4", "1.7.10", "1.20" newest-first.
function sortMcVersionsDesc(list) {
  return list.slice().sort((a, b) => {
    const pa = a.split('.').map(n => Number(n) || 0);
    const pb = b.split('.').map(n => Number(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const da = pa[i] || 0, db = pb[i] || 0;
      if (da !== db) return db - da;
    }
    return 0;
  });
}

let forgeCache = { ts: 0, data: [] };
app.get('/api/versions/forge', async (_req, res) => {
  if (Date.now() - forgeCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const j = await r.json();
      const set = new Set();
      for (const k of Object.keys(j.promos || {})) {
        const m = k.match(/^(.+)-(recommended|latest)$/);
        if (m) set.add(m[1]);
      }
      forgeCache = { ts: Date.now(), data: sortMcVersionsDesc([...set]) };
    } catch (e) { console.warn('forge versions fetch failed:', e.message); }
  }
  res.json(forgeCache.data);
});

let fabricCache = { ts: 0, data: [] };
app.get('/api/versions/fabric', async (_req, res) => {
  if (Date.now() - fabricCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://meta.fabricmc.net/v2/versions/game');
      const j = await r.json();
      const stable = j.filter(v => v.stable).map(v => v.version);
      fabricCache = { ts: Date.now(), data: sortMcVersionsDesc(stable) };
    } catch (e) { console.warn('fabric versions fetch failed:', e.message); }
  }
  res.json(fabricCache.data);
});

// ---- Mods upload (1-day window, non-vanilla only) -------------------------
//
// We talk to the running MC container directly via the docker socket
// instead of writing to a shared filesystem mount. Upload uses
// putArchive() to drop tar-streamed jars into /data/mods/; list and
// delete go through `exec`. This keeps docker-compose.yml minimal — no
// host-path coupling between manager and MC.

const MOD_MAX_BYTES = 300 * 1024 * 1024; // 300 MB per file
const MODS_DIR_IN_CONTAINER = '/data/mods';

// Modrinth/CurseForge often serve filenames URL-encoded (e.g. `%2B` for `+`),
// and the user may save them to disk with the encoding intact. Decode first,
// then validate against the allowed-char set, and write the decoded name.
function safeModName(name) {
  let base = path.basename(String(name || ''));
  try {
    const decoded = decodeURIComponent(base);
    if (decoded) base = decoded;
  } catch { /* malformed % escapes — fall through with original */ }
  if (!/^[A-Za-z0-9._+\-() \[\]']+\.jar$/i.test(base)) return null;
  return base;
}

// Per-request cap. Frontend chunks larger selections into multiple requests
// so the manager never holds more than this many .jars in memory at once.
const MAX_MOD_FILES = 20;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MOD_MAX_BYTES, files: MAX_MOD_FILES },
  fileFilter: (_req, file, cb) => {
    if (safeModName(file.originalname)) cb(null, true);
    else cb(new Error(`rejected: ${file.originalname} (only .jar allowed)`));
  },
});

// Build a minimal in-memory tar archive containing the given files at the
// archive root. Designed to feed dockerode's container.putArchive(), which
// extracts at the target path.
function tarArchive(files) {
  const blocks = [];
  for (const { name, buffer } of files) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');           // file name
    header.write('0000644', 100, 7, 'ascii');     // mode
    header.write('0000000', 108, 7, 'ascii');     // uid
    header.write('0000000', 116, 7, 'ascii');     // gid
    header.write(buffer.length.toString(8).padStart(11, '0'), 124, 11, 'ascii'); // size
    header.write('00000000000', 136, 11, 'ascii'); // mtime
    header.write('        ', 148, 8, 'ascii');    // chksum placeholder
    header.write('0', 156, 1, 'ascii');           // typeflag (regular file)
    header.write('ustar  ', 257, 8, 'ascii');     // ustar magic + version
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += header[i];
    header.write(chksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, buffer);
    const pad = (512 - (buffer.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // two empty 512-blocks marking the end
  return Buffer.concat(blocks);
}

async function execInMc(cmd) {
  const c = await findMc();
  if (!c) throw new Error('MC container is not running');
  const exec = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ Detach: false });
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', d => chunks.push(d));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const inspect = await exec.inspect();
  // Strip the 8-byte multiplexed header from each chunk.
  const out = demuxDockerLogs(Buffer.concat(chunks));
  return { code: inspect.ExitCode, output: out };
}

app.get('/api/mods', async (_req, res) => {
  try {
    const s = getState();
    const canUpload = canUploadModsFor(s);
    const c = await findMc();
    if (!c) return res.json({ mods: [], canUpload });
    // `find ... -printf` works on the busybox image used by itzg/minecraft.
    const r = await execInMc(['sh', '-c',
      `mkdir -p ${MODS_DIR_IN_CONTAINER} && cd ${MODS_DIR_IN_CONTAINER} && find . -maxdepth 1 -type f -name '*.jar' -printf '%f\\t%s\\n' 2>/dev/null || true`,
    ]);
    const mods = r.output.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [name, size] = line.split('\t');
        return { name, size: Number(size) || 0 };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ mods, canUpload });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/mods', (req, res, next) => {
  upload.array('mods', MAX_MOD_FILES)(req, res, (err) => {
    if (err) {
      // Multer signals oversize/over-count via err.code; fileFilter rejects
      // come through with our message. Surface them as 400 with a useful
      // body instead of a generic 500.
      const msg = err.code === 'LIMIT_FILE_COUNT'
          ? `too many files (max ${MAX_MOD_FILES})`
        : err.code === 'LIMIT_FILE_SIZE'
          ? `file too large (max ${MOD_MAX_BYTES / 1024 / 1024} MB per .jar)`
        : err.message || 'upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    const s = getState();
    if (!canUploadModsFor(s)) {
      return res.status(403).json({ error: 'mods upload window is closed' });
    }
    const c = await findMc();
    if (!c) return res.status(400).json({ error: 'MC container is not running' });
    // Make sure /data/mods exists — itzg's vanilla images don't ship it.
    await execInMc(['mkdir', '-p', MODS_DIR_IN_CONTAINER]);

    const files = (req.files || [])
      .map(f => ({ name: safeModName(f.originalname), buffer: f.buffer }))
      .filter(f => f.name);
    if (!files.length) return res.json({ ok: true, written: [] });

    const tar = tarArchive(files);
    await c.putArchive(tar, { path: MODS_DIR_IN_CONTAINER });
    db.prepare('UPDATE state SET mods_dirty = 1 WHERE id = 1').run();
    res.json({ ok: true, written: files.map(f => f.name) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Make sure a tiny utility image is available for the delete-via-temp-container
// flow. busybox is ~5 MB and ships rm/sh, fine for a one-shot.
async function ensureImage(image) {
  const list = await docker.listImages();
  if (list.some(i => (i.RepoTags || []).includes(image))) return;
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, e => (e ? reject(e) : resolve()));
    });
  });
}

// Delete the named jars from MC's /data/mods/ while MC is stopped, by
// spinning up a one-shot busybox container that mounts the same volumes.
async function deleteModsViaTempContainer(names) {
  if (!names.length) return;
  await ensureImage('busybox:latest');
  const targets = names.map(n => `${MODS_DIR_IN_CONTAINER}/${n}`);
  const c = await docker.createContainer({
    Image: 'busybox:latest',
    Cmd: ['rm', '-f', ...targets],
    HostConfig: {
      AutoRemove: false,
      VolumesFrom: [`${MC_CONTAINER}:rw`],
    },
  });
  try {
    await c.start();
    const result = await c.wait();
    if (result.StatusCode !== 0) {
      throw new Error(`mod deletion exited with code ${result.StatusCode}`);
    }
  } finally {
    try { await c.remove({ force: true }); } catch { /* already gone */ }
  }
}

// Apply batched mod changes: stop MC, delete the requested jars (using a
// temp container so the deletion happens on a fully-stopped server), then
// bring MC back up. Also handles the upload-only case (no deletions) by
// simply force-recreating MC so any newly-pushed jars get loaded.
app.post('/api/mods/apply', async (req, res) => {
  try {
    const s = getState();
    if (!canUploadModsFor(s)) {
      return res.status(403).json({ error: 'mods are locked for this season' });
    }
    const requested = Array.isArray(req.body?.deletions) ? req.body.deletions : [];
    const deletions = requested.map(safeModName).filter(Boolean);

    writeEnvFile(s.settings, s.seasonName);

    if (deletions.length) {
      // Down → delete files → up. Matches the user's "down, delete, up"
      // contract; deletions happen against a stopped server, no risk of
      // file-locking surprises.
      try { await compose(['stop', 'minecraft']); } catch (e) { console.warn('stop warn:', e.message); }
      await deleteModsViaTempContainer(deletions);
      await compose(['up', '-d', 'minecraft']);
    } else {
      // Upload-only flow: recreate so the new jars get loaded.
      await compose(['up', '-d', '--force-recreate', 'minecraft']);
    }

    db.prepare('UPDATE state SET mods_dirty = 0 WHERE id = 1').run();
    res.json({ ok: true, deleted: deletions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Docker multiplexes stdout/stderr into framed chunks when there's no TTY.
// Each frame: [stream_type, 0, 0, 0, size_be (4 bytes), payload (size bytes)].
function demuxDockerLogs(buf) {
  let i = 0;
  const out = [];
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out.push(buf.slice(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return out.join('');
}

app.get('/api/logs', async (req, res) => {
  const tail = Math.min(2000, Math.max(1, Number(req.query.tail) || 200));
  try {
    const c = await findMc();
    if (!c) return res.type('text/plain').send('(no container yet)');
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: false });
    res.type('text/plain').send(demuxDockerLogs(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)));
  } catch (e) {
    res.status(500).type('text/plain').send('error: ' + e.message);
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

ensureMcComposeFile();

app.listen(PORT, () => console.log(`s23-minecraft manager listening on :${PORT}, compose dir ${MC_COMPOSE_DIR}`));
