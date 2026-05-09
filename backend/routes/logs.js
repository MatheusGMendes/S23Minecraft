// /api/logs

const express = require('express');
const { findMc, demuxDockerLogs } = require('../lib/docker');

const router = express.Router();

router.get('/api/logs', async (req, res) => {
  const tail = Math.min(2000, Math.max(1, Number(req.query.tail) || 200));
  try {
    const c = await findMc();
    if (!c) return res.type('text/plain').send('(no container yet)');
    const buf = await c.logs({ stdout: true, stderr: true, tail, timestamps: false });
    res.type('text/plain').send(demuxDockerLogs(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)));
  } catch (e) {
    res.status(500).type('text/plain').send('error: ' + e.message);
  }
});

module.exports = router;
