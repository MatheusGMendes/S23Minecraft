// Docker-related helpers: dockerode instance, the `docker compose` CLI
// shim, container-by-name lookup, and the multiplexed-log decoder.

const Docker = require('dockerode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const {
  MC_COMPOSE_DIR, MC_COMPOSE_NAME, MC_COMPOSE_FILE, MC_ENV_FILE, MC_CONTAINER,
  SERVERS_DIR, BACKUPS_DIR,
} = require('./config');

// Honor DOCKER_HOST so we can run against:
//   - the local docker socket (default in-container behavior)
//   - a Lima SSH-forwarded unix socket (DOCKER_HOST=unix:///path/sock)
//   - a TCP-bridged Lima daemon (DOCKER_HOST=tcp://host.docker.internal:2375)
function dockerOpts() {
  const h = process.env.DOCKER_HOST || '';
  if (h.startsWith('unix://')) return { socketPath: h.slice('unix://'.length) };
  if (h.startsWith('tcp://') || h.startsWith('http://')) {
    const u = new URL(h);
    return { host: u.hostname, port: Number(u.port) || 2375, protocol: 'http' };
  }
  return { socketPath: '/var/run/docker.sock' };
}

const docker = new Docker(dockerOpts());

// Discover our own bind mounts from the docker daemon and translate
// container-side paths into the host-side paths the daemon sees. Used
// in compose() below so MC's ${SERVERS_DIR} / ${BACKUPS_DIR} substitute
// to bind sources the daemon can resolve — without needing HOST_*
// duplicate env vars.
let ownMounts = null;

async function loadOwnMounts() {
  if (ownMounts !== null) return;
  try {
    const id = process.env.HOSTNAME;
    if (!id) { ownMounts = []; return; }
    const info = await docker.getContainer(id).inspect();
    // Sort longest destination first so nested mounts win over their
    // parent when translating (irrelevant with the current flat layout,
    // but keeps the algorithm robust if a nested mount ever returns).
    ownMounts = (info.Mounts || [])
      .filter(m => m.Type === 'bind')
      .sort((a, b) => b.Destination.length - a.Destination.length);
  } catch (e) {
    console.warn('could not load own mounts (path translation disabled):', e.message);
    ownMounts = [];
  }
}

function containerToHost(p) {
  if (!p || !ownMounts || !ownMounts.length) return p;
  for (const m of ownMounts) {
    if (p === m.Destination) return m.Source;
    if (p.startsWith(m.Destination + '/')) {
      return m.Source + p.slice(m.Destination.length);
    }
  }
  return p; // not under any bind mount — fall back to the path as-is
}

// Build the global flags `docker compose` needs given OMV-style file
// naming (`<name>.yml` + `<name>.env`). Project name is forced via -p
// so it stays consistent regardless of cwd. compose.override.yml gets
// auto-included when it exists alongside the main file (docker compose
// only auto-loads override files for default-named compose files).
function composeFlags() {
  const flags = ['-p', MC_COMPOSE_NAME, '-f', MC_COMPOSE_FILE];
  const override = path.join(MC_COMPOSE_DIR, 'compose.override.yml');
  if (fs.existsSync(override)) flags.push('-f', override);
  if (fs.existsSync(MC_ENV_FILE)) flags.push('--env-file', MC_ENV_FILE);
  return flags;
}

// Run `docker compose <args>` in the MC compose dir. Translates the
// container-side SERVERS_DIR / BACKUPS_DIR into host-side paths via
// the bind-mount config from our own container — so MC's compose
// substitutions point at dirs the daemon can actually mount.
async function compose(args) {
  await loadOwnMounts();
  const env = {
    ...process.env,
    SERVERS_DIR: containerToHost(SERVERS_DIR),
    BACKUPS_DIR: containerToHost(BACKUPS_DIR),
  };
  const fullArgs = ['compose', ...composeFlags(), ...args];
  return new Promise((resolve, reject) => {
    execFile('docker', fullArgs, { cwd: MC_COMPOSE_DIR, env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr.trim() || err.message));
      resolve(stdout);
    });
  });
}

async function findMc() {
  try {
    const list = await docker.listContainers({ all: true });
    const c = list.find(c => c.Names.some(n => n === '/' + MC_CONTAINER));
    return c ? docker.getContainer(c.Id) : null;
  } catch { return null; }
}

// Force-remove a container by hardcoded name. Safety net before
// `compose up` — wipes any stale leftover from a prior run that compose
// can't see (different project name, etc.).
async function forceRemoveByName(name) {
  try {
    await docker.getContainer(name).remove({ force: true });
    console.log(`removed stale container ${name}`);
  } catch (e) {
    if (e.statusCode !== 404) console.warn(`could not remove ${name}: ${e.message}`);
  }
}

// Docker multiplexes stdout/stderr into framed chunks when there's no
// TTY. Each frame: [stream_type, 0, 0, 0, size_be, payload].
function demuxDockerLogs(buf) {
  let i = 0;
  const out = [];
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i + 4);
    out.push(buf.slice(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return out.join('');
}

// Sanity-ping the daemon at startup. Logs cleanly on success; on failure
// prints a multi-line hint at the most common fixes (Lima down, bridge
// missing, etc.) so the cause is obvious from container logs.
async function pingDockerDaemon() {
  try {
    await docker.ping();
    const v = await docker.version().catch(() => null);
    console.log(
      `docker daemon reachable${v ? ` (server ${v.Version}, kernel ${v.KernelVersion || '?'})` : ''}`,
    );
    return true;
  } catch (e) {
    console.error('---------------------------------------------------------------');
    console.error(`Cannot reach the docker daemon (DOCKER_HOST=${process.env.DOCKER_HOST || '/var/run/docker.sock'}).`);
    console.error('If the Lima VM isn\'t provisioned, run:  bash scripts/setup-mc-vm.sh');
    console.error('If it exists but is stopped:             limactl start mc-vm');
    console.error('If the host-side TCP bridge is missing:  bash scripts/start-docker-bridge.sh');
    console.error(`Underlying error: ${e.message}`);
    console.error('---------------------------------------------------------------');
    return false;
  }
}

module.exports = {
  docker, compose, findMc, forceRemoveByName, demuxDockerLogs, pingDockerDaemon,
  loadOwnMounts, containerToHost,
};
