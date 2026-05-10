// MC / Forge / Fabric version-list fetchers, cached in-memory for an
// hour each. The /api/versions* routes hit these.
//
// Each list is filtered to MC versions the LOCAL itzg image is likely
// to support: any release dated AFTER the cached itzg image's build
// date is dropped (mc-image-helper inside an old image won't know how
// to provision a Mojang release that didn't exist when the image was
// built). The image gets pulled fresh on every season start, so the
// cutoff slides forward as soon as the user starts a new season.

const { docker } = require('./docker');

const VERSIONS_TTL_MS = 60 * 60 * 1000;

let mojangCache   = { ts: 0, data: ['LATEST'], releaseDates: {} };
let forgeCache    = { ts: 0, data: [] };
let fabricCache   = { ts: 0, data: [] };
let neoforgeCache = { ts: 0, data: [] };
let itzgCache     = { ts: 0, ms: null };

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

// Build date of the locally-cached itzg/minecraft-server:latest image,
// in epoch ms. Null if the image isn't pulled yet or docker is
// unreachable — callers treat null as "no filter, return everything."
async function getItzgImageDateMs() {
  if (Date.now() - itzgCache.ts < VERSIONS_TTL_MS) return itzgCache.ms;
  try {
    const info = await docker.getImage('itzg/minecraft-server:latest').inspect();
    itzgCache = { ts: Date.now(), ms: new Date(info.Created).getTime() };
  } catch (e) {
    itzgCache = { ts: Date.now(), ms: null };
  }
  return itzgCache.ms;
}

async function getMojangVersions() {
  if (Date.now() - mojangCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
      const j = await r.json();
      const itzgMs = await getItzgImageDateMs();
      const releaseDates = {};
      const releases = [];
      for (const v of j.versions) {
        if (v.type !== 'release') continue;
        const t = new Date(v.releaseTime).getTime();
        releaseDates[v.id] = t;
        if (!itzgMs || t <= itzgMs) releases.push(v.id);
      }
      mojangCache = { ts: Date.now(), data: ['LATEST', ...releases], releaseDates };
    } catch (e) { console.warn('versions fetch failed:', e.message); }
  }
  return mojangCache.data;
}

// Drop MC versions whose Mojang release predates none-of-the-above —
// keep entries we can't date (avoid hiding versions just because Mojang
// hasn't been fetched yet).
function filterByItzgDate(mcVersions, releaseDates, itzgMs) {
  if (!itzgMs) return mcVersions;
  return mcVersions.filter(v => {
    const t = releaseDates[v];
    return !t || t <= itzgMs;
  });
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
      // Reuse Mojang's release-date map so the itzg cutoff applies here too.
      await getMojangVersions();
      const itzgMs = await getItzgImageDateMs();
      const filtered = filterByItzgDate([...set], mojangCache.releaseDates, itzgMs);
      forgeCache = { ts: Date.now(), data: sortMcVersionsDesc(filtered) };
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
      await getMojangVersions();
      const itzgMs = await getItzgImageDateMs();
      const filtered = filterByItzgDate(stable, mojangCache.releaseDates, itzgMs);
      fabricCache = { ts: Date.now(), data: sortMcVersionsDesc(filtered) };
    } catch (e) { console.warn('fabric versions fetch failed:', e.message); }
  }
  return fabricCache.data;
}

// NeoForge versions encode the MC base in the version string itself.
// Two layouts in the wild:
//   3-part legacy:  "21.4.155"        → MC "1.21.4"  (1.<major>.<minor>)
//   4-part new:     "26.1.2.41-beta"  → MC "26.1.2"  (post-Mojang rename)
function neoforgeToMcVersion(rawVersion) {
  const clean = String(rawVersion).replace(/-(beta|alpha|rc[^-]*)$/i, '');
  const parts = clean.split('.');
  if (parts.length === 4) return parts.slice(0, 3).join('.');
  if (parts.length === 3) return `1.${parts[0]}.${parts[1]}`;
  return null;
}

async function getNeoforgeVersions() {
  if (Date.now() - neoforgeCache.ts > VERSIONS_TTL_MS) {
    try {
      const r = await fetch('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
      const j = await r.json();
      const set = new Set();
      for (const v of j.versions || []) {
        const mc = neoforgeToMcVersion(v);
        if (mc) set.add(mc);
      }
      await getMojangVersions();
      const itzgMs = await getItzgImageDateMs();
      const filtered = filterByItzgDate([...set], mojangCache.releaseDates, itzgMs);
      neoforgeCache = { ts: Date.now(), data: sortMcVersionsDesc(filtered) };
    } catch (e) { console.warn('neoforge versions fetch failed:', e.message); }
  }
  return neoforgeCache.data;
}

module.exports = { getMojangVersions, getForgeVersions, getFabricVersions, getNeoforgeVersions };
