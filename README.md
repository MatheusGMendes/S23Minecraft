# S23 Minecraft

Tiny manager for a community-shared Minecraft server. Players control a few
gameplay knobs from a web UI; the host operator controls the rest from a
plain `docker-compose.yml` they write themselves.

- **40-day seasons** — settings are locked while the season is active.
  When it ends, the server **keeps running** and the day counter keeps going
  past 40. Anyone can either click **Extend** (add 5 days) or submit new
  settings, which starts a new season with a fresh world.
- **Per-season folders** — each new season writes to its own host folder
  (`<SERVERS_DIR>/season-NNN-YYYYMMDD`) so old seasons stay on disk as
  archives. Same for backups (`<BACKUPS_DIR>/season-NNN-YYYYMMDD`).
- **Automated backups** — `itzg/mc-backup` runs alongside the server, takes
  RCON-flushed snapshots every 12 h, prunes after 3 days, pauses when no
  players are online.
- **One-click restore** — `s23 restore` runs the `restore-tar-backup`
  service to roll back to the latest archive.
- **No magic** — the manager just edits a `.env` file and runs
  `docker compose up -d` against your file. You own the compose.

## Architecture

```
your host
├── /var/run/docker.sock
├── /srv/s23-minecraft/docker-compose.yml   ← YOU WRITE THIS
├── /srv/s23-minecraft/.env                 ← managed by the app
└── docker compose
    ├── s23-minecraft-manager (this image)  ← UI on :8092
    └── s23-minecraft         (itzg image)  ← MC on :25565
```

The manager has the Docker socket mounted plus your compose directory mounted
at `/mc`. When settings change, it writes a fresh `.env`, runs
`docker compose down -v` (wipes the world volume), then `docker compose up -d`.

## Setup

1. **Write your Minecraft compose.** Copy the template:

   ```bash
   mkdir -p /srv/s23-minecraft
   cp examples/minecraft.example.yml /srv/s23-minecraft/docker-compose.yml
   ```

   Edit it. Hardcode anything you want immutable (memory, max players, EULA,
   icon, ops, whitelist, etc.). Reference player-controlled vars as
   `${VAR:-default}` so compose works even before the manager has written `.env`.

2. **Update the manager's compose** so the volume mount points at the directory
   you just created. In `docker-compose.yml`:

   ```yaml
   volumes:
     - /srv/s23-minecraft:/mc
   ```

   Make sure `MC_CONTAINER` matches the `container_name` in your MC compose.

3. **Bring it up:**

   ```bash
   docker compose up -d
   ```

   Open `http://<host>:8092`. Click **Start server**.

## Player-editable settings

| Field | env var | Notes |
|---|---|---|
| Version | `VERSION` | Dropdown of every Minecraft release version (Mojang's manifest, cached 1h). `LATEST` always available. |
| Difficulty | `DIFFICULTY` | peaceful / easy / normal / hard |
| Game mode | `MODE` | survival / creative / adventure / spectator |
| Seed | `SEED` | blank = random |
| Online mode | `ONLINE_MODE` | true / false |
| MOTD | `MOTD` | server description shown in client list (write-only) |
| Ops | `OPS` | comma-separated usernames (write-only — `HIDDEN_OPS` always merged in) |
| Icon URL | `ICON` | server-list icon, must be 64×64 png |

These are written by the manager into `<compose-dir>/.env`. The form is
**locked** while a season is active and **unlocks** when the season expires.

## Host-controlled (locked from players)

These live in your compose file directly:

- `EULA: "TRUE"` — required by itzg
- `MEMORY: "10G"` — JVM heap, sized for your host
- `MAX_PLAYERS: "20"`
- `TYPE: "VANILLA"` — modded servers cause too many failure modes
- `PVP: "true"`
- Anything else: `OPS`, `WHITELIST`, `ICON`, `RESOURCE_PACK`, etc.

## CLI

Everything is also available via `docker exec`:

```bash
docker exec s23-minecraft-manager s23 <command>
```

| Command | Effect |
|---|---|
| `status` | print current state, settings, and expiry timestamps |
| `start` | `docker compose up -d` |
| `stop` | `docker compose stop` (does not remove anything) |
| `expire` | set `extension_days` so the season's deadline lands at-or-before now — settings unlock in the UI without touching `season_started` |
| `extend [days]` | add days to current season — default `5`, no last-day check |
| `expires-in <days>` | force the season to expire `<days>` from now (testing) |
| `renew` | bring the deadline back to `now + LIFETIME_DAYS` (lock for 40 more days) |
| `reset` | start a new season (new folder, fresh world); old season's data stays as an archive |
| `restore` | run `restore-tar-backup` against the current season's latest backup |
| `setup-end` | lock mod uploads/deletes/restart for the current season — same effect as the 24 h auto-lock or the **End setup** button |
| `setup-start` | re-open mod editing for the current season — admin override that prevents the 24 h auto-lock from re-firing |

Examples:

```bash
docker exec s23-minecraft-manager s23 expires-in 1   # last-day window for testing extend
docker exec s23-minecraft-manager s23 extend 30      # +30 days, override
docker exec s23-minecraft-manager s23 reset          # nuke everything, fresh season
docker exec s23-minecraft-manager s23 setup-start    # let players upload mods past day 1
docker exec s23-minecraft-manager s23 setup-end      # freeze the modset early
```

### Mod uploads (FORGE / FABRIC seasons)

When a non-vanilla season starts, the **Mods** card shows up in the Logs tab
for 24 hours. Players can drop `.jar` files in, see what's installed, and
hit **Restart server to load mods** to recreate the MC container. After the
window closes (or after `s23 setup-end`), the modset is frozen for the rest
of the season — uploads, deletes, and the restart button are all rejected
with a 403 until you start a new season or run `s23 setup-start`.

Files travel through the docker socket (`putArchive` to drop them into
`/data/mods`, `exec` for list/delete) — no shared bind mount required
between the manager and MC.

## Configuration

All knobs are env vars on the **manager container** in
`docker-compose.yml`:

| Env var | Default | Purpose |
|---|---|---|
| `MC_COMPOSE_DIR` | `/mc` | Path inside the manager where your MC compose lives |
| `MC_CONTAINER` | `s23-minecraft` | Must match `container_name` in your MC compose |
| `MC_HOST` | `host.docker.internal` | Hostname the manager pings for player count |
| `MC_PORT` | `25565` | Published MC port on the host |
| `LIFETIME_DAYS` | `40` | Length of a season |
| `EXTEND_DAYS` | `5` | How many days `/api/extend` adds |
| `HIDDEN_OPS` | empty | Comma-separated usernames always merged into the op list. Never shown in the UI. |
| `SERVERS_DIR` | `/srv/minecraft/seasons` | Host folder that holds one subfolder per season's world (`<SERVERS_DIR>/<season-name>`) |
| `BACKUPS_DIR` | `/srv/minecraft-backups` | Host folder that holds one subfolder per season's backups (`<BACKUPS_DIR>/<season-name>`) |

## Updating from main

Push commits → CI publishes a new image to GHCR
(`ghcr.io/matheusgmendes/s23minecraft:latest`). On the host:

```bash
docker compose pull
docker compose up -d
```

Manager state (DB) lives in the `manager-data` named volume; survives image
upgrades. World data lives in your MC compose's volume; only `s23 reset` /
settings change wipes it.
