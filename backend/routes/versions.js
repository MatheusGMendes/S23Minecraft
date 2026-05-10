// /api/versions, /api/versions/forge, /api/versions/fabric

const express = require('express');
const {
  getMojangVersions, getForgeVersions, getFabricVersions, getNeoforgeVersions,
} = require('../lib/versions');

const router = express.Router();

router.get('/api/versions',          async (_req, res) => res.json(await getMojangVersions()));
router.get('/api/versions/forge',    async (_req, res) => res.json(await getForgeVersions()));
router.get('/api/versions/fabric',   async (_req, res) => res.json(await getFabricVersions()));
router.get('/api/versions/neoforge', async (_req, res) => res.json(await getNeoforgeVersions()));

module.exports = router;
