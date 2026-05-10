// Centralized configuration: env vars + compile-time constants.
// Required by every other module — no other deps so it can be loaded first.

const path = require('path');

const PORT             = process.env.PORT || 3000;
// Container layout (defaults match the bind mounts in docker-compose.yml):
//   /minesm   ← manager-owned root: MC compose, state.db, season-NNN
//               dirs all live here (MINESMFOLDER on host).
//   /backups  ← per-season backup tars, read-only (BKPFOLDER on host).
const MC_COMPOSE_DIR   = process.env.MC_COMPOSE_DIR || '/minesm';
const DATA_DIR         = process.env.DATA_DIR || MC_COMPOSE_DIR;
// OMV-style naming convention: a project in folder `minesm/` has its
// compose at `minesm.yml` and its env at `minesm.env`. Default the name
// to the folder's basename so OMV groups them under one project name.
const MC_COMPOSE_NAME  = process.env.MC_COMPOSE_NAME
  || path.basename(MC_COMPOSE_DIR.replace(/\/+$/, '')) || 'docker-compose';
const MC_COMPOSE_FILE  = path.join(MC_COMPOSE_DIR, `${MC_COMPOSE_NAME}.yml`);
const MC_ENV_FILE      = path.join(MC_COMPOSE_DIR, `${MC_COMPOSE_NAME}.env`);
const MC_CONTAINER     = process.env.MC_CONTAINER   || 's23-minecraft';
const MC_HOST          = process.env.MC_HOST        || 'host.docker.internal';
const MC_PORT          = Number(process.env.MC_PORT || 25565);
const LIFETIME_DAYS    = Number(process.env.LIFETIME_DAYS || 40);
const EXTEND_DAYS      = Number(process.env.EXTEND_DAYS   || 5);
const HIDDEN_OPS       = process.env.HIDDEN_OPS || '';
const PUBLIC_DIR       = process.env.PUBLIC_DIR     || path.join(__dirname, '..', 'public');

// SERVERS_DIR / BACKUPS_DIR — container-side paths the MANAGER uses
// for its own fs ops (mod uploads, backup listing). Seasons live one
// level deeper than state.db so the manager-owned root stays tidy:
//   /minesm/state.db
//   /minesm/seasons/season-NNN-YYYYMMDD/...
const SERVERS_DIR = process.env.SERVERS_DIR || path.join(DATA_DIR, 'seasons');
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/backups';


const EXTEND_WINDOW_MS = 24 * 60 * 60 * 1000;       // last 24h before expiry
const MODS_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;  // setup window after season start

// itzg env vars exposed to players. Keep in sync with frontend FIELDS.
// DESCRIPTION is manager-only — itzg ignores it.
const SETTING_KEYS = [
  'TYPE', 'VERSION', 'DIFFICULTY', 'MODE',
  'SEED', 'ONLINE_MODE', 'MOTD', 'OPS', 'ICON', 'DESCRIPTION',
];

// Settings that exist for the manager UI only — never written to .env.
const MANAGER_ONLY_KEYS = new Set(['DESCRIPTION']);

const SERVER_TYPES = ['VANILLA', 'FORGE', 'FABRIC', 'NEOFORGE'];

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

// Mod upload cap. Per-file size only — there's no cap on the number of
// jars in a single request.
const MOD_MAX_BYTES  = 2 * 1024 * 1024 * 1024;  // 2 GB per .jar

// Setup-mode MOTD prefix — shown in the server-list ping while the mod
// upload window is open so players can tell mods may still change.
// The window no longer blocks joining; this is purely informational.
const SETUP_MODE_MOTD_PREFIX =
  '[SETUP] Mods may still change — server is in the staging window. ';

module.exports = {
  PORT, DATA_DIR, MC_COMPOSE_DIR, MC_COMPOSE_NAME, MC_COMPOSE_FILE, MC_ENV_FILE,
  MC_CONTAINER, MC_HOST, MC_PORT,
  LIFETIME_DAYS, EXTEND_DAYS, HIDDEN_OPS, PUBLIC_DIR,
  SERVERS_DIR, BACKUPS_DIR,
  EXTEND_WINDOW_MS, MODS_UPLOAD_WINDOW_MS,
  SETTING_KEYS, MANAGER_ONLY_KEYS, SERVER_TYPES, DEFAULT_SETTINGS,
  MOD_MAX_BYTES,
  SETUP_MODE_MOTD_PREFIX,
};
