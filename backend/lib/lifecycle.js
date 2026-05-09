// Long-running ops that combine env-write + compose + DB updates +
// (optionally) backup-now. The routes call into these; they're the
// only things that own the .env / docker.compose state machine.

const {
  MC_CONTAINER,
} = require('./config');
const { db, getState, seasonNameFor, isSetupModeFor } = require('./db');
const { compose, forceRemoveByName } = require('./docker');
const { writeEnvFile } = require('./envfile');
const { writeSeasonMeta, snapshotMcCompose } = require('./seasons');

// First-run / vanilla restart. Brings up the WHOLE compose stack (MC +
// backups). For firstRun, computes season-1 in memory and only commits
// to DB after compose succeeds — so a misconfig doesn't bump the season
// counter past a server that never started.
async function startCompose() {
  const s = getState();
  const now = Date.now();
  const seasonName = s.firstRun ? seasonNameFor(1, now) : s.seasonName;
  const setupMode = s.firstRun
    ? (s.settings?.TYPE || 'VANILLA') !== 'VANILLA'
    : isSetupModeFor(s);
  writeEnvFile(s.settings, seasonName, { setupMode });
  await forceRemoveByName(MC_CONTAINER);
  await forceRemoveByName(`${MC_CONTAINER}-backups`);
  await compose(['up', '-d']);
  if (s.firstRun) {
    db.prepare(`
      UPDATE state SET season_id = 1, season_started = ?, extension_days = 0,
                       mods_locked = 0, mods_auto_locked = 0
       WHERE id = 1
    `).run(now);
    writeSeasonMeta(seasonName, {
      seasonId: 1, seasonName,
      startedAt: now, endedAt: null,
      settings: s.settings,
    });
    snapshotMcCompose(seasonName);
  }
}

// Season transition: snapshot the OLD season via backup-now (best-effort,
// uses the still-active .env), close out its meta, write a new .env with
// the new SEASON_NAME, compose down + up, write the new meta, commit DB.
async function applyNewSeason(newSettings) {
  const s = getState();
  const now = Date.now();
  const newSeasonId = (s.seasonId || 0) + 1;
  const seasonName = seasonNameFor(newSeasonId, now);

  // 0. Backup the OLD season while its .env is still in place.
  if (!s.firstRun) {
    try {
      console.log('backup-now: snapshotting old season before transition…');
      await compose(['--profile', 'manual', 'run', '--rm', 'backup-now']);
    } catch (e) { console.warn('backup-now warn:', e.message); }
    writeSeasonMeta(s.seasonName, {
      seasonId: s.seasonId, seasonName: s.seasonName,
      startedAt: s.seasonStarted, endedAt: now,
      settings: s.settings,
    });
  }

  // 1. New .env first — fails before touching containers if MC_COMPOSE_DIR
  //    is misconfigured. New seasons open mods unlocked, so non-vanilla
  //    types start in setup mode.
  const setupMode = (newSettings.TYPE || 'VANILLA') !== 'VANILLA';
  writeEnvFile(newSettings, seasonName, { setupMode });

  // 2. Stop the old season's containers.
  try { await compose(['down']); } catch (e) { console.warn('down warn:', e.message); }

  // 2b. Belt-and-suspenders: wipe by name in case a different compose
  //     project left orphan containers under the same name.
  await forceRemoveByName(MC_CONTAINER);
  await forceRemoveByName(`${MC_CONTAINER}-backups`);

  // 3. Bring up the new season.
  await compose(['up', '-d']);

  // 3b. Meta for the NEW season — listed in past-seasons once it ends.
  writeSeasonMeta(seasonName, {
    seasonId: newSeasonId, seasonName,
    startedAt: now, endedAt: null,
    settings: newSettings,
  });
  snapshotMcCompose(seasonName);

  // 4. Commit DB after compose succeeds. Reset the mod flags so the new
  //    season opens with a fresh upload window (auto-relocks 24h later).
  db.prepare(`
    UPDATE state
       SET settings = ?, season_started = ?, extension_days = 0, season_id = ?,
           mods_locked = 0, mods_auto_locked = 0
     WHERE id = 1
  `).run(JSON.stringify(newSettings), now, newSeasonId);
}

// Background task: rewrite .env without setup-mode and bounce MC. Fired
// from db.getState()'s lazy auto-lock transition so the whitelist
// actually gets lifted at the 24h mark instead of waiting for the next
// reload.
async function applyAutoLockRestart() {
  const s = getState();
  if (s.firstRun) return;
  console.log('mods auto-lock fired — restarting MC to drop the setup whitelist');
  writeEnvFile(s.settings, s.seasonName, { setupMode: false });
  try { await compose(['stop', 'minecraft']); } catch (e) { console.warn('stop warn:', e.message); }
  await compose(['up', '-d', 'minecraft']);
}

// Self-healing: env_setup_mode column tells us what writeEnvFile() last
// committed. If it disagrees with isSetupModeFor() today (e.g. auto-lock
// flipped the flag but the MC restart never landed), rewrite .env and
// bounce MC so the running server matches what the DB says.
async function reconcileSetupMode() {
  const s = getState();
  if (s.firstRun) return;
  const r = db.prepare('SELECT env_setup_mode FROM state WHERE id = 1').get();
  const envHas = !!r.env_setup_mode;
  const expected = isSetupModeFor(s);
  if (envHas === expected) return;
  console.log(`reconcile setup mode: env=${envHas} expected=${expected} — rewriting .env + restarting MC`);
  writeEnvFile(s.settings, s.seasonName, { setupMode: expected });
  try { await compose(['stop', 'minecraft']); } catch (e) { console.warn('stop warn:', e.message); }
  try { await compose(['up', '-d', 'minecraft']); } catch (e) { console.warn('up warn:', e.message); }
}

module.exports = {
  startCompose, applyNewSeason, applyAutoLockRestart, reconcileSetupMode,
};
