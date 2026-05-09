// /api/versions, /api/versions/forge, /api/versions/fabric

const express = require('express');
const {
  getMojangVersions, getForgeVersions, getFabricVersions,
} = require('../lib/versions');

const router = express.Router();

router.get('/api/versions',        async (_req, res) => res.json(await getMojangVersions()));
router.get('/api/versions/forge',  async (_req, res) => res.json(await getForgeVersions()));
router.get('/api/versions/fabric', async (_req, res) => res.json(await getFabricVersions()));

module.exports = router;
