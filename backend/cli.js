#!/usr/bin/env node
// Admin CLI for the manager. Shares the same DB + helpers as the HTTP
// server (lib/*). Run via: docker exec s23-minecraft-manager s23 <cmd>

const { LIFETIME_DAYS, MC_COMPOSE_DIR } = require('./lib/config');
const {
  db, getState, isExpiredFor, isSetupModeFor,
} = require('./lib/db');
const { compose } = require('./lib/docker');
const { writeEnvFile } = require('./lib/envfile');
const {
  startCompose, applyNewSeason,
} = require('./lib/lifecycle');

const cmds = {
  async status() {
    const s = getState();
    const { findMc } = require('./lib/docker');
    const c = await findMc();
    let running = false;
    if (c) running = (await c.inspect()).State.Running;
    const expiresAt = new Date(s.seasonStarted + (LIFETIME_DAYS + s.extensionDays) * 86400 * 1000);
    console.log(`compose dir:    ${MC_COMPOSE_DIR}`);
    console.log(`season:         #${s.seasonId} (${s.seasonName})`);
    console.log(`container:      ${c ? (process.env.MC_CONTAINER || 's23-minecraft') : '(none)'}`);
    console.log(`running:        ${running}`);
    console.log(`season started: ${new Date(s.seasonStarted).toISOString()}`);
    console.log(`season expires: ${expiresAt.toISOString()}`);
    console.log(`expired:        ${isExpiredFor(s)}`);
    console.log(`settings:       ${JSON.stringify(s.settings, null, 2)}`);
  },

  async start() { await startCompose(); console.log('started'); },

  async stop() {
    try { console.log(await compose(['stop'])); }
    catch (e) { console.error(e.message); process.exit(1); }
  },

  async expire() {
    const s = getState();
    if (s.firstRun) { console.error('no season started yet'); process.exit(1); }

    // Flip expiry first: extension_days lands exactly on now (precise
    // fractional value, no Math.round drift).
    const targetExt = (Date.now() - s.seasonStarted) / 86400000 - LIFETIME_DAYS;
    db.prepare(`
      UPDATE state SET extension_days = ?, mods_locked = 1, mods_auto_locked = 1
       WHERE id = 1
    `).run(targetExt);

    // Reconcile: if the .env was in setup mode (mid-window or stale from
    // a previously-crashed auto-lock restart), rewrite without setup
    // mode and bounce MC. Otherwise leave MC running.
    const after = getState();
    const r = db.prepare('SELECT env_setup_mode FROM state WHERE id = 1').get();
    if (r.env_setup_mode) {
      console.log('reconciling: dropping setup-mode .env and restarting MC…');
      writeEnvFile(after.settings, after.seasonName, { setupMode: false });
      try { console.log(await compose(['stop', 'minecraft'])); } catch (e) { console.warn('stop warn:', e.message); }
      console.log(await compose(['up', '-d', 'minecraft']));
    }
    console.log('season expired — settings unlocked, players can join');
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
    const s = getState();
    if (s.firstRun) { console.error('no season started yet'); process.exit(1); }
    // Move the deadline to exactly (now + days). Stored as a fractional
    // value so the deadline is precise — rounding here produced up to
    // ±12h drift in the past.
    const elapsedDays = (Date.now() - s.seasonStarted) / 86400000;
    const targetExt = elapsedDays + days - LIFETIME_DAYS;
    db.prepare('UPDATE state SET extension_days = ? WHERE id = 1').run(targetExt);
    console.log(`forced state: season expires in ${days} day${days === 1 ? '' : 's'}`);
  },

  async renew() {
    const s = getState();
    if (s.firstRun) { console.error('no season started yet'); process.exit(1); }
    const elapsedDays = (Date.now() - s.seasonStarted) / 86400000;
    db.prepare('UPDATE state SET extension_days = ? WHERE id = 1').run(elapsedDays);
    console.log(`season renewed — locked for ${LIFETIME_DAYS} more days`);
  },

  async reset() {
    const s = getState();
    await applyNewSeason(s.settings);
    console.log('new season started.');
  },

  'setup-end': async () => {
    const s = getState();
    if (s.firstRun) { console.error('no season started yet'); process.exit(1); }
    db.prepare('UPDATE state SET mods_locked = 1, mods_auto_locked = 1 WHERE id = 1').run();
    const after = getState();
    writeEnvFile(after.settings, after.seasonName, { setupMode: false });
    try { console.log(await compose(['stop', 'minecraft'])); } catch (e) { console.warn('stop warn:', e.message); }
    console.log(await compose(['up', '-d', 'minecraft']));
    console.log('setup ended — mod uploads locked, whitelist dropped, players can join');
  },

  'setup-start': async () => {
    const s = getState();
    if (s.firstRun) { console.error('no season started yet'); process.exit(1); }
    if ((s.settings?.TYPE || 'VANILLA') === 'VANILLA') {
      console.error('vanilla seasons do not have a mod setup window'); process.exit(1);
    }
    db.prepare('UPDATE state SET mods_locked = 0, mods_auto_locked = 1 WHERE id = 1').run();
    const after = getState();
    writeEnvFile(after.settings, after.seasonName, { setupMode: true });
    try { console.log(await compose(['stop', 'minecraft'])); } catch (e) { console.warn('stop warn:', e.message); }
    console.log(await compose(['up', '-d', 'minecraft']));
    console.log('setup re-opened — mods are editable again, whitelist re-enabled');
    console.log('subsequent reloads PRESERVE the world by default');
  },

  async restore() {
    console.log('Running restore-tar-backup against the latest archive…');
    try { console.log(await compose(['stop', 'minecraft'])); } catch (e) { console.warn('stop minecraft warn:', e.message); }
    console.log(await compose(['--profile', 'manual', 'run', '--rm', 'restore-backup']));
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
  setup-end           lock mod uploads/deletes for the current season
  setup-start         unlock mod uploads/deletes for the current season
`;

(async () => {
  const cmd = process.argv[2];
  if (!cmd || !cmds[cmd]) { console.log(usage); process.exit(cmd ? 1 : 0); }
  try { await cmds[cmd](); } catch (e) { console.error(e.message); process.exit(1); }
})();
