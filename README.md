# S23 Minecraft

Tiny manager for a community-shared Minecraft server. Players control a few
gameplay knobs from a web UI; the host operator owns a plain
`<project>.yml` for MC and the manager just edits `.env` and bounces
`docker compose` against it.

## What it does

- **40-day seasons.** Settings are locked while a season is active. When
  it expires, anyone can click **Extend** (+5 days) or fill the form to
  start a new season — fresh world, new folder. Past seasons stay on
  disk as archives.
- **Per-season folders.** Each season writes to its own host folder
  (`<SERVERS_DIR>/season-NNN-YYYYMMDD/`). Same for backups
  (`<BACKUPS_DIR>/season-NNN-YYYYMMDD/`). Nothing is ever wiped
  silently — only an explicit "Reset world" toggle on reload, or the
  next season's start, replaces world data.
- **Automated backups.** `itzg/mc-backup` runs alongside the server
  inside the MC stack. RCON-flushed `tar /data` every 12 h, prunes
  after 3 days, pauses while no players are online. Plus a one-shot
  `backup-now` that fires on every season transition before the old
  server stops.
- **Past seasons UI.** The Server tab lists archived seasons with their
  TYPE / VERSION and a **Download backup** link that streams the most
  recent tar from `<BACKUPS_DIR>/<season>/`.
- **Mod-setup window** (FORGE / FABRIC seasons). For the first 24 h
  after a non-vanilla season starts, the manager runs MC behind an
  empty whitelist (`[SETUP]` MOTD prefix) so players can't join.
  Operator queues `.jar` uploads in the browser, picks each file's
  fate, then hits Apply — that uploads, optionally wipes world for
  worldgen-affecting mods, and restarts MC. Window closes after 24 h
  or `s23 setup-end`.
- **Restore.** `s23 restore` runs `restore-tar-backup` against the
  current season's latest archive.
- **No magic.** The manager just writes `<project>.env`, runs
  `docker compose up -d` against `<project>.yml`, and exposes a small
  HTTP/JSON API. You own the compose.

## Architecture

```
host docker daemon
├── s23-minecraft-manager      ← UI on :3002, this image
│      reads/writes <project>/<project>.env
│      mounts /var/run/docker.sock to control the MC stack
│
└── MC stack (separate compose project, lives in <project>/)
   ├── s23-minecraft           ← itzg/minecraft-server
   ├── s23-minecraft-backups   ← itzg/mc-backup, periodic + on-demand
   └── (restore-backup, backup-now: manual, profiles=["manual"])
```

The manager and the MC stack are two separate `docker compose` projects
on the same daemon. The manager controls MC by `cd`-ing into the MC
compose dir and shelling out `docker compose up -d -f <project>.yml`.

The on-disk layout the manager expects (host paths bind-mount into
fixed container paths — see `docker-compose.yml`):

```
MINESMFOLDER → /minesm           ← manager-owned root
  <project>.yml                  ← MC compose, named after the folder
  <project>.env                  ← written by the manager every season change
  compose.override.yml           ← optional, auto-loaded if present
  state.db                       ← manager DB
  season-NNN-YYYYMMDD/
    .s23-meta.json               ← season metadata for the past-seasons UI
    <project>.yml                ← snapshot of the MC compose at season start
    .staging-mods/               ← pending uploads, only during apply
    mods/                        ← active modset
    world/  world_nether/  world_the_end/
BKPFOLDER → /backups (ro)        ← per-season backup tars
  season-NNN-YYYYMMDD/
    <timestamp>.tar.gz
```

`<project>` (and the project name OMV / `docker compose ls` shows) is
just `basename(MC_COMPOSE_DIR)` — `minesm` by default, so the files
become `minesm.yml` + `minesm.env`. Override via `MC_COMPOSE_NAME` env
if you want a different filename.

## Setup

[`docker-compose.yml`](docker-compose.yml) is the example — two
placeholder paths to fill in (`MINESMFOLDER`, `BKPFOLDER`), no env
vars to set, defaults handle the rest.

```bash
# edit docker-compose.yml, replace MINESMFOLDER / BKPFOLDER
docker compose pull        # latest manager image from GHCR
docker compose up -d
```

OMV will display two stacks: `s23minecraft` (the manager) and the MC
project named after `basename(MINESMFOLDER)`.

## Player-editable settings

| Field | env var | Notes |
|---|---|---|
| Server type | `TYPE` | VANILLA / FORGE / FABRIC |
| Version | `VERSION` | Mojang / Forge / Fabric version lists, cached 1 h. `LATEST` for vanilla only. |
| Difficulty | `DIFFICULTY` | peaceful / easy / normal / hard |
| Game mode | `MODE` | survival / creative / adventure / spectator |
| Seed | `SEED` | blank = random |
| Online mode | `ONLINE_MODE` | true / false |
| MOTD | `MOTD` | server-list description (write-only — blank submit preserves prior) |
| Ops | `OPS` | comma-separated usernames (write-only — `HIDDEN_OPS` always merged in) |
| Icon URL | `ICON` | server-list icon, validated as image before save |
| Description | `DESCRIPTION` | manager-only, shown on the status page (mod-pack URLs etc.) |

The form is **locked** while a season is active and **unlocks** on
expiry / firstRun. When it unlocks, fields reset to defaults — the
previous season's TYPE / VERSION / ICON do not leak into the next.

## Host-controlled (live in `<project>.yml`, never in the UI)

```yaml
EULA:        "TRUE"
MEMORY:      "10G"
MAX_PLAYERS: "20"
PVP:         "true"
```

Plus the hardening (already in `examples/minecraft.example.yml`):
`cap_drop: ALL`, `no-new-privileges:true`, `pids_limit`, `mem_limit`,
`tmpfs /tmp`.

## CLI

```bash
docker exec s23-minecraft-manager s23 <command>
```

| Command | Effect |
|---|---|
| `status` | current state, season name, expiry, settings |
| `start` | `docker compose up -d` |
| `stop` | `docker compose stop` |
| `expire` | flip extension_days so expiry lands on now; also drops `[SETUP]` whitelist + restarts MC if it was active |
| `extend [days]` | add days to the current season (default 5) |
| `expires-in <days>` | force expiry to land in N days |
| `renew` | re-lock for `LIFETIME_DAYS` from now |
| `reset` | start a new season (full transition: backup-now → meta close → new .env → compose down → compose up) |
| `restore` | restore latest backup into the current season's world |
| `setup-end` | end the mod-setup window early (locks mods, drops whitelist, restarts MC) |
| `setup-start` | re-open the mod-setup window mid-season (admin override) |

## Mod-setup window

For non-vanilla seasons, the first 24 h are the **setup window**. The
manager:

1. Writes `<project>.env` with `WHITELIST=00000000-0000-0000-0000-000000000000`
   (sentinel UUID, blocks everyone), `WHITE_LIST=TRUE`,
   `ENFORCE_WHITELIST=TRUE`, and prepends `[SETUP] …` to MOTD.
2. Shows a **Mods** card on the Server tab.
3. Operator picks `.jar` files in the browser — they're queued
   client-side, not uploaded yet. Each can be removed individually.
4. **Reset world** checkbox decides whether `world / world_nether /
   world_the_end` get wiped on apply (needed for biome / dimension /
   structure mods).
5. **Apply** uploads the queue to `.staging-mods/`, then atomically:
   stop MC → apply staged deletions → move staged jars into `mods/` →
   optionally wipe world → start MC.
6. **Discard** drops the browser queue without touching the server.
7. After 24 h or `s23 setup-end`, mods are locked, the whitelist is
   dropped, and MC restarts so players can join.

Closing the tab loses the queue — there's a `beforeunload` warning.
Restarting the manager also prunes any leftover `.staging-mods/` so
out-of-band MC restarts can never accidentally load unapplied mods.

## Configuration

All env vars on the **manager container**:

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | manager HTTP port (inside the container) |
| `MC_COMPOSE_DIR` | `/minesm` | container-side path of the manager-owned root (compose, state.db, season folders) |
| `DATA_DIR` | `MC_COMPOSE_DIR` | manager SQLite location (state.db sits at `${DATA_DIR}/state.db`) |
| `MC_COMPOSE_NAME` | `basename(MC_COMPOSE_DIR)` | base name for `<name>.yml` and `<name>.env`; also the compose project name (`-p`) |
| `MC_CONTAINER` | `s23-minecraft` | must match `container_name` in MC compose |
| `MC_HOST` | `host.docker.internal` | host the manager pings for player count |
| `MC_PORT` | `25565` | published MC port |
| `LIFETIME_DAYS` | `40` | season length |
| `EXTEND_DAYS` | `5` | how many days `/api/extend` adds |
| `HIDDEN_OPS` | empty | always-on operator list, never visible in the UI |
| `SERVERS_DIR` | `DATA_DIR` | container-side per-season dir (state.db + season folders share this root) |
| `BACKUPS_DIR` | `/backups` | container-side per-season backups dir |

The manager auto-translates container-side `SERVERS_DIR`/`BACKUPS_DIR`
to host-side paths by inspecting its own bind mounts before invoking
`docker compose` for MC — so the same container paths Just Work
regardless of where the host folders live.

## Updating

Push to `main` → CI publishes `ghcr.io/matheusgmendes/s23minecraft:latest`.
On the server:

```bash
docker compose pull
docker compose up -d
```

Manager state (DB) lives at `${DATA_DIR}/state.db` — survives image
upgrades. World data lives in `${SERVERS_DIR}/<season>/world/`. Only an
explicit "Reset world" reload, `s23 reset`, or the next season's
"Apply" wipes any of it.
