// /api/settings + /api/setup/end + /api/setup/start

const express = require('express');
const { SETTING_KEYS, DEFAULT_SETTINGS } = require('../lib/config');
const {
  db, getState, expiresAtFor, isExpiredFor,
} = require('../lib/db');
const { writeEnvFile } = require('../lib/envfile');
const { compose } = require('../lib/docker');
const { applyNewSeason } = require('../lib/lifecycle');
const { validateIconUrl } = require('../lib/status');

const router = express.Router();

router.post('/api/settings', async (req, res) => {
  try {
    const s = getState();
    // Allowed when there's no season yet (firstRun) OR the season has expired.
    if (!s.firstRun && Date.now() < expiresAtFor(s)) {
      return res.status(403).json({ error: 'season is still active — settings are locked' });
    }
    // Start from CURRENT settings, not defaults — keys the frontend chose
    // to omit (e.g. blank OPS) keep their existing value.
    const newSettings = { ...DEFAULT_SETTINGS, ...s.settings };
    for (const k of SETTING_KEYS) {
      if (req.body[k] !== undefined) newSettings[k] = String(req.body[k]);
    }
    // Validate the icon URL BEFORE doing anything destructive — a bad
    // URL makes itzg crash on boot and the container would loop forever.
    const iconCheck = await validateIconUrl(newSettings.ICON);
    if (!iconCheck.ok) return res.status(400).json({ error: iconCheck.error });
    await applyNewSeason(newSettings);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// End the setup window: lock + restart MC so the whitelist drops and
// players can join. Same effect as the 24h auto-lock or `s23 setup-end`.
router.post('/api/setup/end', async (_req, res) => {
  try {
    const s = getState();
    if (s.firstRun) return res.status(400).json({ error: 'no season started yet' });
    db.prepare(`
      UPDATE state SET mods_locked = 1, mods_auto_locked = 1 WHERE id = 1
    `).run();
    const after = getState();
    writeEnvFile(after.settings, after.seasonName, { setupMode: false });
    try { await compose(['stop', 'minecraft']); } catch (e) { console.warn('stop warn:', e.message); }
    await compose(['up', '-d', 'minecraft']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Re-open the setup window (admin override). World stays — once players
// have played, blowing it away on every reload would be hostile.
router.post('/api/setup/start', async (_req, res) => {
  try {
    const s = getState();
    if (s.firstRun) return res.status(400).json({ error: 'no season started yet' });
    if (isExpiredFor(s)) return res.status(403).json({ error: 'season has expired' });
    if ((s.settings?.TYPE || 'VANILLA') === 'VANILLA') {
      return res.status(400).json({ error: 'vanilla seasons do not have a mod setup window' });
    }
    db.prepare('UPDATE state SET mods_locked = 0, mods_auto_locked = 1 WHERE id = 1').run();
    const after = getState();
    writeEnvFile(after.settings, after.seasonName, { setupMode: true });
    try { await compose(['stop', 'minecraft']); } catch (e) { console.warn('stop warn:', e.message); }
    await compose(['up', '-d', 'minecraft']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
