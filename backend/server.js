const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Docker = require('dockerode');
const Database = require('better-sqlite3');
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
// Server TYPE is locked to VANILLA in the user's compose file — running
// Forge/Paper/Fabric/etc. opens up too many failure modes (mod conflicts,
// jar resolution, etc.) for a community-driven config.
const SETTING_KEYS = [
  'VERSION', 'DIFFICULTY', 'MODE',
  'SEED', 'ONLINE_MODE', 'MOTD', 'OPS', 'ICON',
];

const DEFAULT_SETTINGS = {
  VERSION: 'LATEST',
  DIFFICULTY: 'normal',
  MODE: 'survival',
  SEED: '',
  ONLINE_MODE: 'true',
  MOTD: 'S23 Minecraft',
  OPS: '',
  ICON: '',
};

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
  const r = db.prepare('SELECT season_started, settings, extension_days, season_id FROM state WHERE id = 1').get();
  const seasonId = r.season_id || 0;
  return {
    seasonStarted: r.season_started,
    settings: JSON.parse(r.settings),
    extensionDays: r.extension_days || 0,
    seasonId,
    seasonName: seasonId === 0 ? '' : seasonNameFor(seasonId, r.season_started),
    firstRun: seasonId === 0,
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

function writeEnvFile(settings, seasonName) {
  const lines = SETTING_KEYS.map(k => {
    const value = k === 'OPS' ? mergeOps(settings[k]) : (settings[k] ?? '');
    return `${k}=${value}`;
  });
  lines.unshift(`SEASON_NAME=${seasonName}`);
  fs.writeFileSync(path.join(MC_COMPOSE_DIR, '.env'), lines.join('\n') + '\n');
}

async function findMc() {
  try {
    const list = await docker.listContainers({ all: true });
    const c = list.find(c => c.Names.some(n => n === '/' + MC_CONTAINER));
    return c ? docker.getContainer(c.Id) : null;
  } catch { return null; }
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
  await compose(['up', '-d']);
  if (s.firstRun) {
    db.prepare(`
      UPDATE state SET season_id = 1, season_started = ?, extension_days = 0
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

  // 3. Bring up the new season.
  await compose(['up', '-d']);

  // 4. Only commit the new state to the DB after compose succeeds.
  db.prepare(`
    UPDATE state
       SET settings = ?, season_started = ?, extension_days = 0, season_id = ?
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
app.use(express.json({ limit: '32kb' }));
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

app.listen(PORT, () => console.log(`s23-minecraft manager listening on :${PORT}, compose dir ${MC_COMPOSE_DIR}`));
