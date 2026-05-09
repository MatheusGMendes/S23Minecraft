// /api/mc/restart, /api/mods (GET/POST), /api/mods/staging DELETE,
// /api/mods/apply

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const {
  MOD_MAX_BYTES, MAX_MOD_FILES,
} = require('../lib/config');
const {
  db, getState, canUploadModsFor, isSetupModeFor, wipeWorldDefaultFor,
} = require('../lib/db');
const { compose } = require('../lib/docker');
const { writeEnvFile } = require('../lib/envfile');
const {
  safeModName, listJars,
  deleteModFiles, commitStagedMods, wipeWorldDirs,
} = require('../lib/mods');
const { seasonModsDir, seasonStagingDir } = require('../lib/seasons');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MOD_MAX_BYTES, files: MAX_MOD_FILES },
  fileFilter: (_req, file, cb) => {
    if (safeModName(file.originalname)) cb(null, true);
    else cb(new Error(`rejected: ${file.originalname} (only .jar allowed)`));
  },
});

// Restart the MC container after settings/mod changes. Body:
//   { wipeWorld?: boolean }   defaults to wipeWorldDefaultFor(state)
router.post('/api/mc/restart', async (req, res) => {
  try {
    const s = getState();
    if (s.firstRun) return res.status(400).json({ error: 'no season started yet' });
    if (!canUploadModsFor(s)) {
      return res.status(403).json({ error: 'mods are locked for this season' });
    }
    const wipeWorld = req.body?.wipeWorld === undefined
      ? wipeWorldDefaultFor(s)
      : !!req.body.wipeWorld;
    writeEnvFile(s.settings, s.seasonName, { setupMode: isSetupModeFor(s) });
    try { await compose(['stop', 'minecraft']); } catch (e) { console.warn('stop warn:', e.message); }
    if (wipeWorld) wipeWorldDirs(s.seasonName);
    await compose(['up', '-d', 'minecraft']);
    res.json({ ok: true, wipedWorld: wipeWorld });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List active mods + pending staged uploads. Staged uploads are flagged
// pending=true; matching active+staged names get willBeReplaced=true.
router.get('/api/mods', (_req, res) => {
  try {
    const s = getState();
    const canUpload = canUploadModsFor(s);
    const active = listJars(seasonModsDir(s.seasonName)).map(m => ({ ...m, pending: false }));
    const pending = listJars(seasonStagingDir(s.seasonName)).map(m => ({ ...m, pending: true }));
    const pendingNames = new Set(pending.map(m => m.name));
    for (const m of active) if (pendingNames.has(m.name)) m.willBeReplaced = true;
    res.json({ mods: [...active, ...pending], canUpload });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stage uploaded jars to .staging-mods/. They only become active when
// /api/mods/apply runs — no out-of-band MC restart can pick them up.
router.post('/api/mods', (req, res, next) => {
  upload.array('mods', MAX_MOD_FILES)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_COUNT'
          ? `too many files (max ${MAX_MOD_FILES})`
        : err.code === 'LIMIT_FILE_SIZE'
          ? `file too large (max ${MOD_MAX_BYTES / 1024 / 1024} MB per .jar)`
        : err.message || 'upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, (req, res) => {
  try {
    const s = getState();
    if (!canUploadModsFor(s)) {
      return res.status(403).json({ error: 'mods upload window is closed' });
    }
    const dir = seasonStagingDir(s.seasonName);
    if (!dir) return res.status(500).json({ error: 'no current season' });
    fs.mkdirSync(dir, { recursive: true });

    const files = (req.files || [])
      .map(f => ({ name: safeModName(f.originalname), buffer: f.buffer }))
      .filter(f => f.name);
    if (!files.length) return res.json({ ok: true, written: [] });

    for (const f of files) {
      fs.writeFileSync(path.join(dir, f.name), f.buffer);
    }
    res.json({ ok: true, written: files.map(f => f.name) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Discard all pending uploads (clear staging dir).
router.delete('/api/mods/staging', (_req, res) => {
  try {
    const s = getState();
    if (!canUploadModsFor(s)) {
      return res.status(403).json({ error: 'mods upload window is closed' });
    }
    const dir = seasonStagingDir(s.seasonName);
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Apply staged uploads + deletions, optionally wipe world, then restart MC.
// Body: { deletions?: string[], wipeWorld?: boolean }
router.post('/api/mods/apply', async (req, res) => {
  try {
    const s = getState();
    if (!canUploadModsFor(s)) {
      return res.status(403).json({ error: 'mods are locked for this season' });
    }
    const requested = Array.isArray(req.body?.deletions) ? req.body.deletions : [];
    const deletions = requested.map(safeModName).filter(Boolean);
    const wipeWorld = req.body?.wipeWorld === undefined
      ? wipeWorldDefaultFor(s)
      : !!req.body.wipeWorld;

    writeEnvFile(s.settings, s.seasonName, { setupMode: isSetupModeFor(s) });

    try { await compose(['stop', 'minecraft']); } catch (e) { console.warn('stop warn:', e.message); }
    if (deletions.length) deleteModFiles(s.seasonName, deletions);
    const committed = commitStagedMods(s.seasonName);
    if (wipeWorld) wipeWorldDirs(s.seasonName);
    await compose(['up', '-d', 'minecraft']);

    res.json({ ok: true, deleted: deletions, committed, wipedWorld: wipeWorld });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
