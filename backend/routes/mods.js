// /api/mc/restart, /api/mods (GET/POST), /api/mods/staging DELETE,
// /api/mods/apply

const express = require('express');
const fs = require('fs');
const multer = require('multer');
const { MOD_MAX_BYTES } = require('../lib/config');
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

// Stream uploads straight into the season's staging dir so 2 GB jars
// don't have to sit in node's heap for the duration of the request.
// Multer creates the file with the safe name as soon as the part starts;
// route handler only verifies / lists what landed.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        const s = getState();
        if (!canUploadModsFor(s)) return cb(new Error('mods upload window is closed'));
        const dir = seasonStagingDir(s.seasonName);
        if (!dir) return cb(new Error('no current season'));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (e) { cb(e); }
    },
    filename: (_req, file, cb) => {
      const safe = safeModName(file.originalname);
      if (!safe) return cb(new Error(`rejected: ${file.originalname} (only .jar allowed)`));
      cb(null, safe);
    },
  }),
  limits: { fileSize: MOD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    cb(null, !!safeModName(file.originalname));
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
  upload.array('mods')(req, res, (err) => {
    if (err) {
      const gb = (MOD_MAX_BYTES / 1024 / 1024 / 1024).toFixed(0);
      const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `file too large (max ${gb} GB per .jar)`
        : err.message || 'upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}, (req, res) => {
  res.json({ ok: true, written: (req.files || []).map(f => f.filename) });
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
