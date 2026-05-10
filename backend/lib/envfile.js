// .env writing for the MC compose, plus the small helpers that keep the
// compose project bootstrapped (default-compose seeding, RCON password
// generation, ops merging).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  MC_COMPOSE_DIR, MC_COMPOSE_FILE, MC_ENV_FILE,
  HIDDEN_OPS, SETTING_KEYS, MANAGER_ONLY_KEYS,
  SETUP_MODE_MOTD_PREFIX,
} = require('./config');
const { db } = require('./db');

// If the user's compose dir is empty (first run), drop in the bundled
// default MC compose so things work out of the box. Also auto-patches
// the historical hardcoded `TYPE: "VANILLA"` line into the templated
// form so the manager's TYPE selection actually flows through.
//
// Looks first for the OMV-style <name>.yml (matching MC_COMPOSE_NAME),
// then falls back to the legacy docker-compose.yml — and if it finds
// the legacy form, renames it to the new convention so OMV groups
// it under the project name.
function ensureMcComposeFile() {
  const legacyFile = path.join(MC_COMPOSE_DIR, 'docker-compose.yml');
  let composeFile = MC_COMPOSE_FILE;

  if (!fs.existsSync(composeFile) && fs.existsSync(legacyFile)) {
    fs.renameSync(legacyFile, composeFile);
    console.log(`Renamed legacy ${legacyFile} → ${composeFile}`);
  }

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

// HIDDEN_OPS (manager-side env) is always merged with the player's input
// before going to .env. Dedupe case-insensitively.
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

// Single source of truth for the .env file. opts.setupMode toggles the
// MOTD prefix only; players are NEVER blocked by whitelist anymore —
// the [SETUP] MOTD is the only signal that mods are still being staged.
// The env_setup_mode DB column mirrors what we wrote so
// reconcileSetupMode() can detect drift on a missed MC restart.
function writeEnvFile(settings, seasonName, opts = {}) {
  ensureMcComposeFile();
  const rconPassword = ensureRconPassword();
  const setupMode = !!opts.setupMode;
  const ops = mergeOps(settings.OPS);
  const motd = setupMode
    ? SETUP_MODE_MOTD_PREFIX + (settings.MOTD || '')
    : (settings.MOTD || '');

  const lines = SETTING_KEYS
    .filter(k => !MANAGER_ONLY_KEYS.has(k))
    .map(k => {
      if (k === 'OPS')  return `OPS=${ops}`;
      if (k === 'MOTD') return `MOTD=${motd}`;
      return `${k}=${settings[k] ?? ''}`;
    });
  lines.unshift(`SEASON_NAME=${seasonName}`);
  lines.push(`RCON_PASSWORD=${rconPassword}`);
  lines.push('WHITE_LIST=FALSE');
  lines.push('ENFORCE_WHITELIST=FALSE');

  fs.writeFileSync(MC_ENV_FILE, lines.join('\n') + '\n');
  // Track what we just wrote so reconcileSetupMode() can detect drift
  // if the followup MC restart never lands.
  db.prepare('UPDATE state SET env_setup_mode = ? WHERE id = 1').run(setupMode ? 1 : 0);
}

module.exports = {
  ensureMcComposeFile, ensureRconPassword, mergeOps, writeEnvFile,
};
