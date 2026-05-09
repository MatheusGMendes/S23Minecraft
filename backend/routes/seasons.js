// /api/seasons + /api/seasons/:name/backup

const express = require('express');
const fs = require('fs');
const path = require('path');
const { SERVERS_DIR, BACKUPS_DIR } = require('../lib/config');
const { getState } = require('../lib/db');
const { readSeasonMeta, latestBackupFor } = require('../lib/seasons');

const router = express.Router();

router.get('/api/seasons', (_req, res) => {
  try {
    const s = getState();
    if (!SERVERS_DIR || !fs.existsSync(SERVERS_DIR)) return res.json({ seasons: [] });
    const seasons = [];
    for (const e of fs.readdirSync(SERVERS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      // Skip the active season — only PAST ones go in this list.
      if (!s.firstRun && e.name === s.seasonName) continue;

      const meta = readSeasonMeta(e.name);
      let info;
      if (meta) {
        info = { ...meta, name: e.name, hasMeta: true };
      } else {
        // Fallback: derive minimal info from the folder-name pattern
        // season-NNN-YYYYMMDD for legacy folders without meta files.
        const m = e.name.match(/^season-(\d+)-(\d{4})(\d{2})(\d{2})$/);
        if (!m) continue;
        info = {
          seasonId: Number(m[1]),
          seasonName: e.name,
          name: e.name,
          startedAt: Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4])),
          endedAt: null,
          settings: null,
          hasMeta: false,
        };
      }
      const latest = latestBackupFor(e.name);
      info.latestBackup = latest
        ? { name: latest.name, size: latest.size, mtime: latest.mtimeMs }
        : null;
      seasons.push(info);
    }
    seasons.sort((a, b) => (b.seasonId || 0) - (a.seasonId || 0));
    res.json({ seasons });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stream the latest backup for a season as a download. Strict whitelist
// on the season name prevents path traversal — only the canonical
// season-NNN-YYYYMMDD pattern is accepted.
router.get('/api/seasons/:name/backup', (req, res) => {
  try {
    const name = req.params.name || '';
    if (!/^season-\d+-\d{8}$/.test(name)) {
      return res.status(400).json({ error: 'invalid season name' });
    }
    if (!BACKUPS_DIR) return res.status(500).json({ error: 'BACKUPS_DIR not configured' });
    const latest = latestBackupFor(name);
    if (!latest) return res.status(404).json({ error: 'no backup for this season' });
    const full = path.join(BACKUPS_DIR, name, latest.name);
    res.download(full, `${name}-${latest.name}`);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
