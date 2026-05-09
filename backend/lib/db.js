// SQLite store + state predicates. Single-row table that holds the
// current season's status; getState() and the predicates below are the
// only place the rest of the app reads it.
//
// The auto-lock for the mods setup window lives here too — getState()
// detects the 24h boundary, flips the DB columns, and queues a background
// MC restart. The actual restart is in lib/lifecycle.js (lazily required
// to dodge a circular dep with envfile/lifecycle).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  DATA_DIR, LIFETIME_DAYS, MODS_UPLOAD_WINDOW_MS,
  SETTING_KEYS, DEFAULT_SETTINGS,
} = require('./config');

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

// Migrations: add new columns if missing.
const cols = db.prepare('PRAGMA table_info(state)').all().map(r => r.name);
if (!cols.includes('extension_days')) {
  db.exec('ALTER TABLE state ADD COLUMN extension_days INTEGER NOT NULL DEFAULT 0');
}
if (!cols.includes('season_id')) {
  db.exec('ALTER TABLE state ADD COLUMN season_id INTEGER NOT NULL DEFAULT 0');
}
if (!cols.includes('rcon_password')) {
  db.exec("ALTER TABLE state ADD COLUMN rcon_password TEXT NOT NULL DEFAULT ''");
}
if (!cols.includes('mods_locked')) {
  db.exec('ALTER TABLE state ADD COLUMN mods_locked INTEGER NOT NULL DEFAULT 1');
}
if (!cols.includes('mods_auto_locked')) {
  db.exec('ALTER TABLE state ADD COLUMN mods_auto_locked INTEGER NOT NULL DEFAULT 1');
}
if (!cols.includes('env_setup_mode')) {
  db.exec('ALTER TABLE state ADD COLUMN env_setup_mode INTEGER NOT NULL DEFAULT 0');
}

function seasonNameFor(seasonId, seasonStartedMs) {
  const d = new Date(seasonStartedMs);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `season-${String(seasonId).padStart(3, '0')}-${date}`;
}

// First-run seed: insert a row in firstRun mode (season_id = 0).
const existing = db.prepare('SELECT settings FROM state WHERE id = 1').get();
if (!existing) {
  db.prepare('INSERT INTO state (id, season_started, settings, season_id) VALUES (1, 0, ?, 0)')
    .run(JSON.stringify(DEFAULT_SETTINGS));
} else {
  // Backfill any new SETTING_KEYS missing from a stored settings blob.
  const stored = JSON.parse(existing.settings);
  let changed = false;
  for (const k of SETTING_KEYS) {
    if (stored[k] === undefined) { stored[k] = DEFAULT_SETTINGS[k]; changed = true; }
  }
  if (changed) {
    db.prepare('UPDATE state SET settings = ? WHERE id = 1').run(JSON.stringify(stored));
  }
}

// Concurrency guard: the auto-lock restart only runs once per process
// lifetime even if many getState() calls trip the boundary at the same
// time. The DB flag (mods_auto_locked) ensures it only fires once per
// season; this catches the within-process race.
let autoLockRestartFired = false;

function getState() {
  const r = db.prepare(`
    SELECT season_started, settings, extension_days, season_id,
           mods_locked, mods_auto_locked
      FROM state WHERE id = 1
  `).get();
  const seasonId = r.season_id || 0;

  let modsLocked = r.mods_locked ? 1 : 0;
  if (!r.mods_auto_locked && seasonId !== 0 &&
      Date.now() - r.season_started >= MODS_UPLOAD_WINDOW_MS) {
    db.prepare('UPDATE state SET mods_locked = 1, mods_auto_locked = 1 WHERE id = 1').run();
    modsLocked = 1;
    if (!autoLockRestartFired) {
      autoLockRestartFired = true;
      // Lazy-require avoids a load-time circular dep
      // (lifecycle requires db). require() is cached so this is cheap.
      setImmediate(() => {
        require('./lifecycle').applyAutoLockRestart()
          .catch(err => {
            console.error('auto-lock restart failed:', err.message);
            autoLockRestartFired = false;  // let retry happen
          });
      });
    }
  }

  return {
    seasonStarted: r.season_started,
    settings: JSON.parse(r.settings),
    extensionDays: r.extension_days || 0,
    seasonId,
    seasonName: seasonId === 0 ? '' : seasonNameFor(seasonId, r.season_started),
    firstRun: seasonId === 0,
    modsLocked,
    modsAutoLocked: r.mods_auto_locked ? 1 : 0,
  };
}

function setState(settings) {
  db.prepare('UPDATE state SET settings = ? WHERE id = 1').run(JSON.stringify(settings));
}

// ---- State predicates ----

function expiresAtFor(s) {
  return s.seasonStarted + (LIFETIME_DAYS + s.extensionDays) * 86400 * 1000;
}

function isExpiredFor(s) {
  return !s.firstRun && Date.now() >= expiresAtFor(s);
}

// modsAccessible — drives whether the Mods card is visible. Hidden once
// the season expires, on firstRun / vanilla servers, or once the
// operator has locked the modset.
function isModsAccessibleFor(s) {
  if (s.firstRun) return false;
  if ((s.settings?.TYPE || 'VANILLA') === 'VANILLA') return false;
  if (isExpiredFor(s)) return false;
  if (s.modsLocked) return false;
  return true;
}

const canUploadModsFor = (s) => isModsAccessibleFor(s);

// Setup mode = the season is currently in its mod-configuration window.
// While true the .env carries WHITELIST + WHITE_LIST + ENFORCE_WHITELIST
// so only the empty sentinel UUID matches (i.e. nobody can join).
const isSetupModeFor = (s) => isModsAccessibleFor(s);

// "wipe world on reload" default — true during the INITIAL 24h setup
// window (worldgen-affecting mods need a fresh world), false after a
// manual `s23 setup-start` re-opens uploads (preserve players' work).
const wipeWorldDefaultFor = (s) => isSetupModeFor(s) && !s.modsAutoLocked;

module.exports = {
  db, seasonNameFor, getState, setState,
  expiresAtFor, isExpiredFor, isModsAccessibleFor, canUploadModsFor,
  isSetupModeFor, wipeWorldDefaultFor,
};
