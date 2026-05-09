// Manager entrypoint. Mounts the route modules, runs the startup tasks,
// and listens. All of the logic lives in lib/* and routes/*.

const express = require('express');
const { PORT, MC_COMPOSE_DIR, PUBLIC_DIR } = require('./lib/config');
const { ensureMcComposeFile } = require('./lib/envfile');
const { pingDockerDaemon } = require('./lib/docker');
const { pruneAllStaging } = require('./lib/mods');
const { reconcileSetupMode } = require('./lib/lifecycle');

const app = express();
app.use(express.json({ limit: '128kb' }));
app.use(express.static(PUBLIC_DIR));

// Mount routes. Order doesn't matter — they all use absolute /api paths.
app.use(require('./routes/state'));
app.use(require('./routes/seasons'));
app.use(require('./routes/settings'));
app.use(require('./routes/mods'));
app.use(require('./routes/logs'));
app.use(require('./routes/versions'));

// Startup chores: bootstrap the MC compose file if missing, prune stale
// staging dirs from a prior process, and ping the docker daemon. The
// reconcile task fires only once the daemon is reachable — needs the
// compose CLI to bounce MC if it has to.
ensureMcComposeFile();
pruneAllStaging();
(async () => {
  if (await pingDockerDaemon()) {
    reconcileSetupMode().catch(e => console.warn('reconcile failed:', e.message));
  }
})();

app.listen(PORT, () => console.log(`s23-minecraft manager listening on :${PORT}, compose dir ${MC_COMPOSE_DIR}`));
