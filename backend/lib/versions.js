// MC / Forge / Fabric version-list fetchers, cached in-memory for an
// hour each. The /api/versions* routes hit these.

const VERSIONS_TTL_MS = 60 * 60 * 1000;

let mojangCache = { ts: 0, data: ['LATEST'] };
let forgeCache  = { ts: 0, data: [] };
let fabricCache = { ts: 0, data: [] };

// Sort MC version strings like "1.21.4", "1.7.10", "1.20" newest-first.
function sortMcVersionsDesc(list) {
  return list.slice().sort((a, b) => {
    const pa = a.split('.').map(n => Number(n) || 0);
    const pb = b.split('.').map(n => Number(n) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const da = pa[i] || 0, db = pb[i] || 0;
      if (da !== db) return db - da;
    }
    return 0;
  });
}

async function getMojangVersions() {
  if (Date.now() - mojangCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const j = await r.json();
      const releases = j.versions.filter(v => v.type === 'release').map(v => v.id);
      mojangCache = { ts: Date.now(), data: ['LATEST', ...releases] };
    } catch (e) { console.warn('versions fetch failed:', e.message); }
  }
  return mojangCache.data;
}

async function getForgeVersions() {
  if (Date.now() - forgeCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const j = await r.json();
      const set = new Set();
      for (const k of Object.keys(j.promos || {})) {
        const m = k.match(/^(.+)-(recommended|latest)$/);
        if (m) set.add(m[1]);
      }
      forgeCache = { ts: Date.now(), data: sortMcVersionsDesc([...set]) };
    } catch (e) { console.warn('forge versions fetch failed:', e.message); }
  }
  return forgeCache.data;
}

async function getFabricVersions() {
  if (Date.now() - fabricCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://meta.fabricmc.net/v2/versions/game');
      const j = await r.json();
      const stable = j.filter(v => v.stable).map(v => v.version);
      fabricCache = { ts: Date.now(), data: sortMcVersionsDesc(stable) };
    } catch (e) { console.warn('fabric versions fetch failed:', e.message); }
  }
  return fabricCache.data;
}

module.exports = { getMojangVersions, getForgeVersions, getFabricVersions };
