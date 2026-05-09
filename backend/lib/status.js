// MC server status (player count, MOTD, version) + icon URL validation.

const { status } = require('minecraft-server-util');
const { MC_HOST, MC_PORT } = require('./config');
const { findMc } = require('./docker');

async function getMcStatus() {
  const c = await findMc();
  if (!c) return { exists: false, running: false, online: false, players: 0, version: null, motd: null, playerNames: [] };
  const info = await c.inspect();
  const running = info.State.Running;
  let online = false, players = 0, version = null, motd = null, playerNames = [];
  if (running) {
    try {
      const s = await status(MC_HOST, MC_PORT, { timeout: 3000 });
      online = true;
      players = s.players.online;
      version = s.version.name;
      motd = s.motd?.clean ?? s.motd?.raw ?? null;
      playerNames = (s.players.sample || []).map(p => p.name).filter(Boolean);
    } catch { /* still booting */ }
  }
  return { exists: true, running, online, players, version, motd, playerNames };
}

// Validate that the icon URL is reachable and is actually an image.
// Some hosts reject HEAD; fall back to GET and abort right away.
// Done BEFORE applyNewSeason so a bad URL can't crash itzg on boot
// (where it would loop forever).
async function validateIconUrl(url) {
  if (!url || !url.trim()) return { ok: true };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try {
      res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    } catch {
      res = await fetch(url, { method: 'GET', signal: ctrl.signal });
      try { res.body && res.body.cancel && await res.body.cancel(); } catch {}
    }
    clearTimeout(t);
    if (!res.ok) return { ok: false, error: `icon URL returned ${res.status}` };
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (!ct.startsWith('image/')) return { ok: false, error: `icon URL is not an image (content-type: ${ct || 'unknown'})` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `icon URL not reachable: ${e.message}` };
  }
}

module.exports = { getMcStatus, validateIconUrl };
