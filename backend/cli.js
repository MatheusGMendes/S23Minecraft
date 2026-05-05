#!/usr/bin/env node
// Admin CLI for the manager. Talks to the same compose dir and SQLite DB
// as server.js. Run via: docker exec s23-minecraft-manager s23 <command>

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const Docker = require('dockerode');
const Database = require('better-sqlite3');

const DATA_DIR       = process.env.DATA_DIR       || path.join(__dirname, 'data');
const MC_COMPOSE_DIR = process.env.MC_COMPOSE_DIR || '/mc';
const MC_CONTAINER   = process.env.MC_CONTAINER   || 's23-minecraft';
const LIFETIME_DAYS  = Number(process.env.LIFETIME_DAYS || 40);
const HIDDEN_OPS     = process.env.HIDDEN_OPS || '';

const SETTING_KEYS = [
  'VERSION', 'DIFFICULTY', 'MODE',
  'SEED', 'ONLINE_MODE', 'MOTD', 'OPS', 'ICON',
];

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const db = new Database(path.join(DATA_DIR, 'state.db'));

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

function seasonNameFor(seasonId, seasonStartedMs) {
  const d = new Date(seasonStartedMs);
  const date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `season-${String(seasonId).padStart(3, '0')}-${date}`;
}

function ensureMcComposeFile() {
  const composeFile = path.join(MC_COMPOSE_DIR, 'docker-compose.yml');
  if (fs.existsSync(composeFile)) return;
  const defaultPath = '/app/default-mc-compose.yml';
  if (!fs.existsSync(defaultPath)) return;
  fs.mkdirSync(MC_COMPOSE_DIR, { recursive: true });
  fs.copyFileSync(defaultPath, composeFile);
}

function ensureRconPassword() {
  const r = db.prepare('SELECT rcon_password FROM state WHERE id = 1').get();
  if (r?.rcon_password) return r.rcon_password;
  const pw = require('crypto').randomBytes(24).toString('hex');
  db.prepare('UPDATE state SET rcon_password = ? WHERE id = 1').run(pw);
  return pw;
}

function writeEnvFile(settings, seasonName) {
  ensureMcComposeFile();
  const lines = SETTING_KEYS.map(k => {
    const value = k === 'OPS' ? mergeOps(settings[k]) : (settings[k] ?? '');
    return `${k}=${value}`;
  });
  lines.unshift(`SEASON_NAME=${seasonName}`);
  lines.push(`RCON_PASSWORD=${ensureRconPassword()}`);
  fs.writeFileSync(path.join(MC_COMPOSE_DIR, '.env'), lines.join('\n') + '\n');
}

async function findMc() {
  const list = await docker.listContainers({ all: true });
  const c = list.find(c => c.Names.some(n => n === '/' + MC_CONTAINER));
  return c ? docker.getContainer(c.Id) : null;
}

const getState = () => {
  const r = db.prepare('SELECT season_started, settings, season_id FROM state WHERE id = 1').get();
  const seasonId = r.season_id || 0;
  return {
    seasonStarted: r.season_started,
    settings: JSON.parse(r.settings),
    seasonId,
    seasonName: seasonId === 0 ? '' : seasonNameFor(seasonId, r.season_started),
    firstRun: seasonId === 0,
  };
};

const cmds = {
  async status() {
    const s = getState();
    const c = await findMc();
    let running = false;
    if (c) running = (await c.inspect()).State.Running;
    const expiresAt = new Date(s.seasonStarted + 40 * 86400 * 1000);
    console.log(`compose dir:    ${MC_COMPOSE_DIR}`);
    console.log(`season:         #${s.seasonId} (${s.seasonName})`);
    console.log(`container:      ${c ? MC_CONTAINER : '(none)'}`);
    console.log(`running:        ${running}`);
    console.log(`season started: ${new Date(s.seasonStarted).toISOString()}`);
    console.log(`season expires: ${expiresAt.toISOString()}`);
    console.log(`expired:        ${Date.now() >= expiresAt.getTime()}`);
    console.log(`settings:       ${JSON.stringify(s.settings, null, 2)}`);
  },

  async start() {
    const s = getState();
    const now = Date.now();
    const seasonName = s.firstRun ? seasonNameFor(1, now) : s.seasonName;
    writeEnvFile(s.settings, seasonName);
    console.log(await compose(['up', '-d']));
    if (s.firstRun) {
      db.prepare(`
        UPDATE state SET season_id = 1, season_started = ?, extension_days = 0
         WHERE id = 1
      `).run(now);
      console.log(`first season started: ${seasonName}`);
    }
  },

  async stop() {
    try {
      console.log(await compose(['stop']));
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  },

  async expire() {
    const r = db.prepare('SELECT season_started, season_id FROM state WHERE id = 1').get();
    if (!r.season_id) { console.error('no season started yet'); process.exit(1); }
    const elapsedDays = (Date.now() - r.season_started) / 86400000;
    const targetExt = Math.round(elapsedDays - LIFETIME_DAYS);
    db.prepare('UPDATE state SET extension_days = ? WHERE id = 1').run(targetExt);
    console.log('season expired — settings are now unlocked in the UI');
  },

  async extend() {
    const days = Number(process.argv[3] || 5);
    if (!Number.isFinite(days)) { console.error('usage: s23 extend <days>'); process.exit(1); }
    db.prepare('UPDATE state SET extension_days = extension_days + ? WHERE id = 1').run(days);
    console.log(`extended season by ${days} days`);
  },

  'expires-in': async () => {
    const days = Number(process.argv[3]);
    if (!Number.isFinite(days)) { console.error('usage: s23 expires-in <days>'); process.exit(1); }

    // Move the deadline to (now + X days) by adjusting extension_days only.
    // The day counter (elapsed = now - season_started) never changes.
    // extension_days can go negative (= season effectively shorter than 40 days).
    const r = db.prepare('SELECT season_started, season_id FROM state WHERE id = 1').get();
    if (!r.season_id) { console.error('no season started yet'); process.exit(1); }
    const elapsedDays = (Date.now() - r.season_started) / 86400000;
    const targetExt = Math.round(elapsedDays + days - LIFETIME_DAYS);
    db.prepare('UPDATE state SET extension_days = ? WHERE id = 1').run(targetExt);
    console.log(`forced state: season expires in ${days} day${days === 1 ? '' : 's'}`);
  },

  async renew() {
    const r = db.prepare('SELECT season_started, season_id FROM state WHERE id = 1').get();
    if (!r.season_id) { console.error('no season started yet'); process.exit(1); }
    // Set extension_days so that expiresAt = now + LIFETIME_DAYS.
    // expiresAt = season_started + (LIFETIME_DAYS + ext) * 86400000
    // => ext = elapsedDays (brings deadline to exactly LIFETIME_DAYS from now)
    const elapsedDays = (Date.now() - r.season_started) / 86400000;
    db.prepare('UPDATE state SET extension_days = ? WHERE id = 1').run(Math.round(elapsedDays));
    console.log(`season renewed — locked for ${LIFETIME_DAYS} more days`);
  },

  async reset() {
    const s = getState();
    const now = Date.now();
    const newSeasonId = (s.seasonId || 0) + 1;
    const seasonName = seasonNameFor(newSeasonId, now);
    // Write env first, then down + up. Only commit DB after compose succeeds.
    writeEnvFile(s.settings, seasonName);
    try { console.log(await compose(['down'])); } catch (e) { console.warn('down warn:', e.message); }
    console.log(await compose(['up', '-d']));
    db.prepare(`
      UPDATE state
         SET season_started = ?, extension_days = 0, season_id = ?
       WHERE id = 1
    `).run(now, newSeasonId);
    console.log(`new season started: #${newSeasonId} (${seasonName}). Old data preserved on disk.`);
  },

  async restore() {
    console.log('Running restore-tar-backup against the latest archive…');
    try {
      console.log(await compose(['stop', 'minecraft']));
    } catch (e) { console.warn('stop minecraft warn:', e.message); }
    console.log(await compose(['run', '--rm', 'restore-backup']));
    console.log(await compose(['up', '-d']));
    console.log('Restore complete.');
  },
};

const usage = `usage: s23 <command>

  status              show current state, current season name, and expiry
  start               docker compose up -d
  stop                docker compose stop
  expire              backdate season so settings unlock in the UI
  extend [days]       add days to current season (default 5)
  expires-in <days>   force season to expire in N days from now
  renew               set season_started = now (lock for ${LIFETIME_DAYS} days)
  reset               start a new season — new folder, fresh world, old archived
  restore             restore the latest backup into the current season's world
`;

(async () => {
  const cmd = process.argv[2];
  if (!cmd || !cmds[cmd]) { console.log(usage); process.exit(cmd ? 1 : 0); }
  try { await cmds[cmd](); } catch (e) { console.error(e.message); process.exit(1); }
})();
