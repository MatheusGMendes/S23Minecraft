// MC version lists per server TYPE, fetched from the manager's cached
// proxies of Mojang/Forge/Fabric. Mutated in place by loadAllVersionLists().

import { getJSON } from './api.js';

export const VERSION_LISTS = {
  VANILLA:  ['LATEST'],
  FORGE:    [],
  FABRIC:   [],
  NEOFORGE: [],
};

async function safeList(url, fallback) {
  try {
    const j = await getJSON(url);
    return Array.isArray(j) ? j : fallback;
  } catch { return fallback; }
}

export async function loadAllVersionLists() {
  const [vanilla, forge, fabric, neoforge] = await Promise.all([
    safeList('/api/versions',          ['LATEST']),
    safeList('/api/versions/forge',    []),
    safeList('/api/versions/fabric',   []),
    safeList('/api/versions/neoforge', []),
  ]);
  VERSION_LISTS.VANILLA  = vanilla.length ? vanilla : ['LATEST'];
  VERSION_LISTS.FORGE    = forge;
  VERSION_LISTS.FABRIC   = fabric;
  VERSION_LISTS.NEOFORGE = neoforge;
}
