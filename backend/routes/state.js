// /api/state, /api/extend, /api/start, /api/check-icon, /healthz

const express = require('express');
const {
  EXTEND_WINDOW_MS, EXTEND_DAYS, LIFETIME_DAYS, MODS_UPLOAD_WINDOW_MS, SERVER_TYPES,
} = require('../lib/config');
const {
  db, getState, expiresAtFor,
  isModsAccessibleFor, canUploadModsFor, isSetupModeFor, wipeWorldDefaultFor,
} = require('../lib/db');
const { getMcStatus, validateIconUrl } = require('../lib/status');
const { startCompose } = require('../lib/lifecycle');
const { listJars } = require('../lib/mods');
const { seasonStagingDir } = require('../lib/seasons');

const router = express.Router();

router.get('/api/state', async (_req, res) => {
  try {
    const s = getState();
    const mc = await getMcStatus();
    const expiresAt = expiresAtFor(s);
    const expired = !s.firstRun && Date.now() >= expiresAt;
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
      wipeWorldDefault: wipeWorldDefaultFor(s),
      setupMode: isSetupModeFor(s),
      pendingUploads: listJars(seasonStagingDir(s.seasonName)).length,
      serverTypes: SERVER_TYPES,
      settings: s.settings,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/extend', (_req, res) => {
  try {
    const s = getState();
    const expiresAt = expiresAtFor(s);
    const expired = Date.now() >= expiresAt;
    const inWindow = expiresAt - Date.now() <= EXTEND_WINDOW_MS;
    if (!expired && !inWindow) {
      return res.status(403).json({ error: 'extension only available on the last day or after expiry' });
    }
    db.prepare('UPDATE state SET extension_days = extension_days + ? WHERE id = 1').run(EXTEND_DAYS);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/start', async (_req, res) => {
  try { await startCompose(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/check-icon', async (req, res) => {
  res.json(await validateIconUrl(req.body?.url || ''));
});

router.get('/healthz', (_req, res) => res.json({ ok: true }));

module.exports = router;
