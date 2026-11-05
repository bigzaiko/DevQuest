---
id: ops-05
title: Docker Compose for the Full Stack
level: intermediate
minutes: 50
xp: 150
summary: One compose.yaml for Postgres + Redis + ASP.NET Core API + React frontend — healthchecks, depends_on conditions, env files, profiles, overrides and watch mode.
---

By now you can run Postgres, build an API image and build a web image. Starting them by hand means
three long `docker run` commands, a network, a volume, the right order, and the right env vars —
every morning, on every developer's machine. **Docker Compose** turns that into a file checked into
the repo and one command:

```bash
docker compose up -d
```

Compose is a *declarative* description of a multi-container application: you describe the desired
state (these services, from these images, with these ports, volumes, networks and dependencies), and
`docker compose up` makes reality match it — creating, recreating or leaving containers alone as
needed.

## Anatomy of `compose.yaml`

```yaml
name: shop                          # project name (default: the folder name)

services:                           # each service = one container (or N replicas) from one image
  db:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: devpass
    volumes:
      - pgdata:/var/lib/postgresql
    ports:
      - "127.0.0.1:5432:5432"

  api:
    build: ./api                    # build from ./api/Dockerfile instead of pulling
    environment:
      ConnectionStrings__Default: "Host=db;Database=postgres;Username=postgres;Password=devpass"
    ports:
      - "127.0.0.1:8080:8080"
    depends_on:
      - db

volumes:                            # named volumes managed by Compose
  pgdata:
```

Things Compose does for you that you'd otherwise do by hand:

- Creates a **network** `shop_default` and attaches every service to it, so `api` can reach the
  database at hostname **`db`** — the service name (DNS details in lesson 6).
- Creates the **volume** `shop_pgdata`.
- Names containers predictably: `shop-db-1`, `shop-api-1`.
- Starts services in **dependency order** and builds images that have a `build:` section.
- On the next `up`, only **recreates** containers whose configuration or image changed.

A few lines deserve a closer look:

:::info title="Networking and volumes: the rules now, the theory in lesson 6"
This lesson leans on three facts that the next-but-one lesson, **Networks and Volumes** (lesson 6),
takes apart properly: containers find each other **by service name** through Docker's DNS, a
**named volume** outlives the container, and **`ports:` is only for reaching a container from your
host**, never needed between containers. Take them as rules for now; lesson 6 shows *why* they hold
(bridge networks, the embedded DNS server at `127.0.0.11`, volume vs bind mount) and how to debug
them when they don't.
:::

- **`postgres:18` mounts its volume at `/var/lib/postgresql`**, not `/var/lib/postgresql/data` as in
  older tutorials. From 18 on, the image keeps its data in a version-specific subfolder
  (`/var/lib/postgresql/18/docker`), so you mount the parent. If you copy an old snippet that mounts
  at `/var/lib/postgresql/data`, the 18 image refuses to start and prints an error explaining the new
  layout, even when the volume is empty. Mount the parent `/var/lib/postgresql` instead.
- **`"127.0.0.1:5432:5432"`** publishes the port on your laptop's loopback only. Without the
  `127.0.0.1:` prefix Docker listens on **all** interfaces (`0.0.0.0`), and on Linux its iptables rules
  even bypass `ufw` — so a dev database with password `devpass` would be reachable from the café Wi-Fi.
- **`Host=db`** in the connection string is the *service name*. Inside a container, `localhost` would
  mean the API container itself (more in lesson 6).

:::warn title="No `version:` line"
Old files start with `version: "3.8"`. The current **Compose Specification** doesn't use it; Compose
v2 ignores it and prints a warning. The preferred filename is **`compose.yaml`**
(`docker-compose.yml` still works).
:::

## The commands you'll use daily

| Command | What it does |
|---|---|
| `docker compose up -d` | Create/start everything in the background |
| `docker compose up -d --build` | …rebuilding images first |
| `docker compose ps` | Status of this project's containers (incl. health) |
| `docker compose logs -f api` | Follow one service's logs (omit the name for all, colour-coded) |
| `docker compose exec db psql -U postgres` | Run a command in a running service container |
| `docker compose run --rm api dotnet --info` | One-off container from a service's config |
| `docker compose restart api` | Restart the same container — does **not** apply edits to `compose.yaml` (use `up -d` for that) |
| `docker compose stop` | Stop containers, keep them |
| `docker compose down` | Stop and **remove** containers and networks (volumes stay) |
| `docker compose down -v` | …and remove the named volumes too — **wipes the database** |
| `docker compose config` | Print the fully resolved file (variables substituted, overrides merged) |
| `docker compose pull` / `build` | Refresh images |

All of them operate on the project in the current folder (or `-f file`, `-p name`).

## Startup order and healthchecks

`depends_on: [db]` in its short form only guarantees that the **db container has been started**
before api is started. "Started" means the process was launched — *not* that Postgres finished
initializing and accepts connections. On a fresh volume, Postgres needs a few seconds to run `initdb`,
so an API that migrates the database on startup crashes with *"connection refused"*.

The fix is to declare **what healthy means** and wait for it:

```yaml
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: devpass
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  api:
    build: ./api
    depends_on:
      db:
        condition: service_healthy   # wait until the healthcheck passes
        restart: true                # restart api when a Compose command restarts/recreates db
```

`restart: true` only reacts to restarts *Compose* performs (`docker compose restart db`, or `up`
recreating db after a config change). A crash restarted by Docker's restart policy doesn't trigger it —
another reason for the resilience advice below.

How it works under the hood: Docker runs the `test` command **inside the db container** every
`interval`. Exit code 0 = healthy, 1 = unhealthy. A new container starts in status `starting`; during
`start_period`, failures don't count against it. After `retries` consecutive failures, the status becomes
`unhealthy`. `docker compose ps` shows `Up 12 seconds (healthy)`.

`pg_isready` asks the *Postgres server* itself whether it accepts connections, which beats a bare
"is port 5432 open?" check. One catch: during first-time init the image runs a temporary server that
listens only on the Unix socket. A plain `pg_isready` (which uses that socket) can report ready before
the init scripts finish, so add `-h 127.0.0.1` to check over TCP, which only opens once init is done. Every
dependency has a similar native check, e.g. `redis-cli ping` for Redis or a `/health` endpoint for an
HTTP service.

With the healthcheck in place, `docker compose up` prints something like:

```text
 ✔ Container shop-db-1   Healthy     6.3s
 ✔ Container shop-api-1  Started     6.5s
```

Compose *creates* both containers immediately but only *starts* `api` once `db` reports healthy.

| `condition` | Waits until the dependency… | Use for |
|---|---|---|
| `service_started` (default) | …container is running | Things that retry on their own |
| `service_healthy` | …healthcheck reports healthy | Databases, message brokers |
| `service_completed_successfully` | …ran to completion with exit code 0 | Migrations, seed jobs |

:::tip title="Why `$$` in the healthcheck?"
Compose itself substitutes `${VAR}` in the YAML from your shell / `.env` **before** creating containers.
`$${POSTGRES_USER}` escapes that, so the literal `${POSTGRES_USER}` reaches the container's shell,
which expands it from the container's own environment.
:::

:::pro title="Still make your app resilient"
`depends_on` only exists in Compose. In Kubernetes there is no startup ordering — your API *will*
start before the database is ready sometimes, and the database *will* restart while the API runs.
Use retries (Npgsql + EF Core's `EnableRetryOnFailure`, Polly) and readiness probes. Healthchecks in
Compose are a convenience for development, not a substitute for resilience.
:::

:::quiz id=ops-05-q1 xp=10
`api` has `depends_on: [db]` (short syntax). On a fresh volume, the API logs
`Npgsql.NpgsqlException: Failed to connect … Connection refused` and exits. Why?
- [ ] The two services are on different networks
- [x] Short `depends_on` only waits for the db container to start, not for Postgres to accept connections
- [ ] `depends_on` doesn't do anything in Compose v2
- [ ] Postgres needs `ports:` for other containers to reach it
> "Started" only means the db *process* was launched; on a fresh volume Postgres is still running `initdb` for a few seconds, so the first connection is refused. The fix is a `healthcheck` on db plus `condition: service_healthy` on api. The `ports:` option is tempting but wrong: containers on the same Compose network talk to each other directly on the container port, and `ports:` only opens access from the host. And `depends_on` very much works in Compose v2 — the short form just promises less than people assume.
:::

:::quiz id=ops-05-q2 xp=10
What does this db service's healthcheck actually run, and where?

```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER}"]
```

- [ ] `pg_isready` on your host, with your shell's `$POSTGRES_USER`
- [x] `/bin/sh -c 'pg_isready -U ${POSTGRES_USER}'` inside the db container, expanded from the container's env
- [ ] `pg_isready -U $${POSTGRES_USER}` literally, which fails
- [ ] Compose connects to port 5432 from the outside and runs `SELECT 1`
> `CMD-SHELL` means "run this string with the container's shell (`/bin/sh -c`)", and Docker always runs healthchecks *inside* the container. `$$` is Compose's escape for a literal `$`, so after interpolation the container's shell sees `${POSTGRES_USER}` and expands it from the container's environment. The "literally `$$`" option is the tempting trap: the doubling is consumed by Compose and never reaches the container. Nothing runs on your host, and Docker doesn't open a network connection for you.
:::

## Configuration: `.env`, `environment`, `env_file`

There are **two different things** called "env" in Compose, and mixing them up is very common:

```text
  .env (next to compose.yaml)           env_file: / environment:
  ─────────────────────────────         ──────────────────────────────────
  read by COMPOSE                       read by the CONTAINER
  used to fill ${VARS} in the YAML      become environment variables of the process
  NOT automatically passed to apps      what your ASP.NET Core app actually sees
```

```text
# .env  — interpolation values for compose.yaml (don't commit real secrets)
POSTGRES_PASSWORD=devpass
API_TAG=dev
```

```yaml
services:
  api:
    image: ghcr.io/acme/api:${API_TAG:-dev}          # default if unset: your local dev build
    env_file:
      - ./api/api.env                               # KEY=value lines, injected into the container
    environment:
      ConnectionStrings__Default: "Host=db;Database=app;Username=app;Password=${POSTGRES_PASSWORD}"
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}   # fail fast if missing
```

Why `:-dev` and not `:-latest`? The default decides what runs when someone forgets to set the
variable. With `latest` that is "whatever was pushed last", which might be another branch's build,
and nothing in `docker compose ps` tells you which commit you're testing. `dev` is a name only local
builds use, so a missing `API_TAG` can't silently pull an unknown image. CI and deployments set
`API_TAG` to the commit's tag (`API_TAG=sha-1a2b3c4 docker compose up -d`) — lesson 8 explains that
tagging scheme.

Interpolation syntax: `${VAR}`, `${VAR:-default}` (use `default` if unset **or empty**), `${VAR-default}`
(only if unset), `${VAR:?message}` (abort with `message` if unset or empty). Values come from your shell
first, then from `.env` — so an `export POSTGRES_PASSWORD=…` in your terminal silently wins over the
file. `docker compose config` shows the result — the first thing to run when "the variable doesn't work".

Precedence inside the container (highest first): `docker compose run -e` → `environment:` →
`env_file:` → the image's `ENV`.

Why `ConnectionStrings__Default`? ASP.NET Core's configuration maps environment variables onto its
hierarchical keys by replacing `__` (double underscore) with `:`. So this variable becomes
`ConnectionStrings:Default`, which is exactly what `builder.Configuration.GetConnectionString("Default")`
reads — the same key you'd put in `appsettings.json`.

:::job title="Typical repo convention"
`.env.example` is committed with dummy values and comments; `.env` is in `.gitignore` and each developer
copies the example once. Secrets for real environments never live in compose files — they come from the
CI/CD system or a secret store.
:::

:::quiz id=ops-05-q3 xp=10
Your `.env` file next to `compose.yaml` contains `FEATURE_X=true`. The `api` service has neither
`environment:` nor `env_file:`. What does `Environment.GetEnvironmentVariable("FEATURE_X")` return in the API?
- [ ] `"true"` — Compose loads `.env` into every container
- [x] `null` — `.env` is only used to interpolate `${…}` in the compose file
- [ ] `"true"`, but only after `docker compose restart`
- [ ] It throws, because `.env` must be listed in `env_file`
> The project `.env` is read by **Compose** to fill `${…}` placeholders in the YAML; it is never injected into containers on its own. Since nothing in the file references `${FEATURE_X}`, the API sees no such variable and gets `null`. The tempting "`true`" answer confuses `.env` with `env_file:`. To pass it, write `environment: { FEATURE_X: ${FEATURE_X} }` or list a file under `env_file:`. Restarting changes nothing, and no error is raised — which is exactly why this bug is sneaky.
:::

## Profiles: optional services

Not everyone needs a database GUI running all the time. Services with `profiles:` start **only** when
that profile is enabled:

```yaml
services:
  adminer:
    image: adminer:5
    profiles: [tools]
    ports: ["127.0.0.1:8082:8080"]
```

```bash
docker compose up -d                          # db, redis, api, web only
docker compose --profile tools up -d          # + adminer
COMPOSE_PROFILES=tools docker compose up -d    # same, via env var (comma-separate several)
```

Services *without* `profiles` are always enabled. Running `docker compose up adminer` explicitly also
starts it (and its dependencies).

A common mistake: an always-on service that `depends_on` a profiled one. Say someone moves `redis`
(next section) behind `profiles: [cache]` "to save memory" while `api` still depends on it: with the
profile off, Compose refuses to start, with an error saying `redis` "is not enabled by the active
profiles". Either keep the profile off `redis`, or mark the dependency optional with
`required: false` under `depends_on.redis` and make the app cope without a cache.

## A second backing service: Redis

Almost every real .NET backend has a second stateful dependency next to the database, and the most
common one is **Redis**: a distributed cache (`IDistributedCache`, or HybridCache on top of it), a
store for rate-limit counters, a place for data-protection keys or SignalR backplane messages. Why
not just `IMemoryCache`? Because as soon as you run two API replicas, each has its own memory: one
replica's cache hit is the other's miss, and a rate limit of "100 requests per minute" becomes "100
per minute *per replica*". A shared Redis gives every replica the same view.

```yaml
services:
  redis:
    image: redis:8-alpine
    # A pure cache: no snapshots, no append-only file (see "Persist it or not?")
    command: ["redis-server", "--save", "", "--appendonly", "no",
              "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]     # prints PONG, exit 0, once Redis accepts commands
      interval: 5s
      timeout: 3s
      retries: 5
    # no ports: — only the API talks to Redis, over the project network

  api:
    environment:
      ConnectionStrings__Redis: "redis:6379"   # service name + container port
    depends_on:
      db:
        condition: service_healthy
        restart: true
      redis:
        condition: service_healthy             # no restart: true — a cache restart shouldn't bounce the API
```

(`CMD` = exec form: the arguments run directly, no shell. Use `CMD-SHELL` only when you need shell
features like `$VAR` expansion or `||`.)

The pieces, and why:

- **`redis-cli ping`** is Redis's native readiness check, the counterpart of `pg_isready`. Until the
  server accepts connections, `redis-cli` exits non-zero and the container stays `starting`.
- **`service_healthy`** for the same reason as with Postgres: an API that warms its cache or opens its
  Redis connection on startup shouldn't race the server.
- **No `ports:`.** The API reaches `redis:6379` over the Compose network. Publishing 6379 on the host
  would only add a password-less Redis your laptop's network could talk to. Need to poke at it? Use
  `docker compose exec redis redis-cli`.
- **`--maxmemory` + `allkeys-lru`** make it behave like a cache: when full, it evicts the least recently
  used keys instead of refusing writes.

### Persist it or not?

Redis keeps everything in memory and has two optional ways to survive a restart: **RDB** snapshots
(the whole dataset written to `dump.rdb` every so often, and on shutdown) and the **AOF**
(append-only file: every write is logged, and replayed on start). Started without a config file,
the image snapshots by default into `/data`.

Ask one question: **can this data be rebuilt from somewhere else?**

| Redis is used as… | If it loses everything | Persistence |
|---|---|---|
| A cache in front of Postgres | Slower for a minute (cold cache), nothing lost | **Off** (`--save ""`, `--appendonly no`), no volume |
| Rate-limit counters | Limits reset early; usually acceptable | Off |
| Sessions, queues, anything that exists *only* in Redis | Users logged out, jobs lost | **AOF on** (`--appendonly yes`) + a named volume on `/data` |

For a cache, persistence costs disk I/O and gives you something worse than nothing: after a restart
you'd serve possibly stale entries that were snapshotted minutes ago. An empty cache is *correct*, just
slower. Lesson 6 comes back to this from the volume side ("should a cache get a volume?").

:::job title="Redis or Valkey?"
Redis 8 is licensed under the AGPLv3 (alongside its source-available licences). Some companies
prefer **Valkey**, the BSD-licensed fork run by the Linux Foundation. It speaks the same protocol, so
`image: valkey/valkey:8-alpine` with `valkey-cli ping` is a drop-in swap and your .NET code doesn't
change. Use whichever your team's platform offers (Azure Managed Redis, ElastiCache…).
:::

:::quiz id=ops-05-q6 xp=10
Your Compose stack uses Redis only as an `IDistributedCache` in front of Postgres. A teammate adds
`--appendonly yes` and a named volume on `/data` "so we don't lose the cache". What's the best review
comment?
- [ ] Good idea: without AOF, a Redis restart corrupts the Postgres data behind it
- [x] Not needed: cache entries can be rebuilt from Postgres, so an empty cache after a restart is correct, just slower; persistence only adds I/O and can bring back stale entries
- [ ] Required: `condition: service_healthy` only works when Redis has a volume
- [ ] Use `ports: ["6379:6379"]` instead, so the data is stored on the host
> Persist what you can't rebuild. A cache is a *copy* of data whose source of truth is Postgres, so losing it costs a cold start, never data. AOF plus a volume is right when Redis holds the only copy (sessions, queues). Redis never touches Postgres, so it can't corrupt it; the healthcheck runs `redis-cli ping` and has nothing to do with volumes; and `ports:` publishes a network port, it stores nothing anywhere.
:::

## Override files and multiple environments

Compose merges several files, later ones overriding earlier ones:

- **`compose.override.yaml`** is picked up **automatically** if it exists next to `compose.yaml`.
  Convention: `compose.yaml` = the shared base, `compose.override.yaml` = local-dev tweaks.
- `-f` lists files explicitly (then the override isn't auto-loaded):
  `docker compose -f compose.yaml -f compose.ci.yaml up`.
- Merging rules: single values (`image`, `command`, `entrypoint`) are **replaced**; maps like
  `environment` and `labels` are **merged by key** (the later file wins per key); `ports` are
  **appended**, and `volumes` are merged **by container path** (a later mount for the same target
  replaces the earlier one). Ports are appended (identical entries are de-duplicated), so a plain
  override can't remove a port from the base file. You'd need the `!reset` tag (`ports: !reset []`,
  Compose 2.24+), or keep the port out of the base, as the example below does by adding the DB port
  only in the dev override.

```yaml
# compose.override.yaml — dev only
services:
  api:
    environment:
      ASPNETCORE_ENVIRONMENT: Development
      Logging__LogLevel__Default: Debug
  db:
    ports: ["127.0.0.1:5432:5432"]   # expose the DB to local GUI tools only in dev
```

There's also `include:` (pull another compose file in as a sub-project) and `extends:` (inherit one
service's config) for bigger setups.

:::quiz id=ops-05-q4 xp=15
The folder contains `compose.yaml` (services `db`, `api`, and `adminer` with `profiles: [tools]`) and a
`compose.override.yaml` that sets `ASPNETCORE_ENVIRONMENT: Development` on `api`. Which statements are
true? (select all that apply)
- [x] `docker compose up -d` starts `db` and `api` in Development mode, but not `adminer`
- [ ] `docker compose up -d` ignores the override file unless you pass `-f compose.override.yaml`
- [x] `docker compose -f compose.yaml up -d` starts `api` **without** the Development setting
- [x] `docker compose --profile tools up -d` also starts `adminer`
- [ ] `docker compose down -v` keeps the database volume
> `compose.override.yaml` is auto-merged **only** when you don't pass `-f` — so plain `up -d` gets Development mode, while `-f compose.yaml` alone skips the override. The tempting wrong answer ("ignored unless you pass `-f compose.override.yaml`") has it backwards. `adminer` stays off until its profile is enabled (or it's named on the command line). And `down -v` is the one command that *deletes* named volumes — the database is gone.
:::

:::quiz id=ops-05-q5 xp=10
Spot the bug. The API works when you run it from Rider, but in Compose it crashes with
*"Connection refused"* even though `db` is `(healthy)`:

```yaml
services:
  db:
    image: postgres:18
    ports: ["127.0.0.1:5432:5432"]
    # healthcheck … (works)
  api:
    build: ./api
    environment:
      ConnectionStrings__Default: "Host=localhost;Port=5432;Database=app;Username=app;Password=devpass"
    depends_on:
      db: { condition: service_healthy }
```

- [ ] The port mapping should be `5432:5432` without `127.0.0.1`
- [x] `Host=localhost` points at the API container itself; it must be `Host=db`
- [ ] `condition: service_healthy` must be replaced by `service_started`
- [ ] Environment variable names can't contain `__`
> Each container has its own network namespace, so `localhost` inside `api` is the API container, where nothing listens on 5432. From Rider it worked because Rider runs on your host, where the *published* port exists. The tempting fix — changing the `ports:` binding — doesn't help: published ports are for the host, and containers reach each other by service name (`db:5432`). `__` is exactly how ASP.NET Core spells `:` in env var names.
:::

:::info title="Compose in production?"
Compose is great for local development, CI integration tests (see the next lesson) and small
single-host deployments. For
multi-host production with rolling updates, autoscaling and self-healing, teams use Kubernetes (or ECS,
Container Apps…). You'll still keep the compose file for development — it's the fastest way to get a new
teammate running.
:::

## Watch mode: edit code, see it running

`docker compose watch` (or `docker compose up --watch`) watches files on your host and reacts according to
a `develop.watch` section:

```yaml
services:
  api:
    build: ./api
    develop:
      watch:
        - action: rebuild          # rebuild the image and recreate the container
          path: ./api
          ignore: [bin/, obj/]

  web-dev:
    build:
      context: ./web
      target: dev                  # a dev stage running the Vite dev server
    develop:
      watch:
        - action: sync             # copy changed files into the running container
          path: ./web/src
          target: /app/src
        - action: rebuild          # new dependencies → new image
          path: ./web/package.json
```

| Action | What happens | Good for |
|---|---|---|
| `sync` | Changed files are copied into the container | Dev servers with hot reload (Vite, `dotnet watch`) |
| `sync+restart` | Copy, then restart the container | Config files read at startup (nginx.conf) |
| `rebuild` | `docker compose build` + recreate | Compiled apps, dependency changes |

Pick the cheapest action that is still correct: `sync` takes a fraction of a second but only helps if
something *inside* the container notices the new files (Vite's HMR does; a compiled `dotnet Api.dll`
doesn't). `rebuild` always works but costs a full image build. A common mistake is `sync` on a compiled
API — the files change, the running process never sees them.

Why not just bind-mount the source folder (`./web:/app`)? You can, and many teams do. Watch avoids the
classic bind-mount pain: slow file sharing on macOS/Windows, the host's `node_modules` shadowing the
container's, and file-ownership problems on Linux (lesson 6).

## Simulate it: Compose startup order

:::challenge id=ops-05-c1 lang=ts xp=50
title: Start services in dependency waves
Compose starts services whose dependencies are satisfied in parallel. Write `startWaves(deps)` where
`deps` maps each service to the services it `depends_on`. Return the start order as **waves**:
wave 0 = services with no dependencies, wave 1 = services whose dependencies are all in earlier
waves, and so on. Sort names alphabetically inside each wave. An empty map returns `[]`.

- Throw an `Error` whose message contains `undefined service` if a dependency isn't a key of `deps`.
- Throw an `Error` whose message contains `cycle` if the dependencies form a cycle.

hint: Repeatedly take every not-yet-started service whose dependencies are all started.
hint: If a round adds nobody but services remain, you've found a cycle.

```ts starter
export function startWaves(deps: Record<string, string[]>): string[][] {
  // Starts everything at once
  return [Object.keys(deps).sort()]
}
```

```ts solution
export function startWaves(deps: Record<string, string[]>): string[][] {
  const names = Object.keys(deps)
  for (const n of names) {
    for (const d of deps[n]) {
      if (!(d in deps)) throw new Error(`service "${n}" depends on undefined service "${d}"`)
    }
  }
  const started = new Set<string>()
  const waves: string[][] = []
  while (started.size < names.length) {
    const wave = names
      .filter((n) => !started.has(n) && deps[n].every((d) => started.has(d)))
      .sort()
    if (wave.length === 0) throw new Error('dependency cycle detected')
    wave.forEach((n) => started.add(n))
    waves.push(wave)
  }
  return waves
}
```

```ts tests
test('classic full stack', () => {
  expect(startWaves({ web: ['api'], api: ['db'], db: [] })).toEqual([['db'], ['api'], ['web']])
})
test('independent services start together, sorted', () => {
  expect(startWaves({ redis: [], db: [], api: ['db', 'redis'], adminer: ['db'] })).toEqual([
    ['db', 'redis'],
    ['adminer', 'api'],
  ])
})
test('migration job pattern', () => {
  expect(startWaves({ db: [], migrate: ['db'], api: ['migrate', 'db'], web: ['api'] })).toEqual([
    ['db'], ['migrate'], ['api'], ['web'],
  ])
})
test('no services', () => {
  expect(startWaves({})).toEqual([])
})
test('unknown dependency', () => {
  expect(() => startWaves({ api: ['database'] })).toThrow('undefined service')
})
test('cycle', () => {
  expect(() => startWaves({ a: ['b'], b: ['c'], c: ['a'], d: [] })).toThrow('cycle')
})
```
:::

## Lab: the whole stack with one command

:::lab id=ops-05-lab1 xp=150
title: Postgres + Redis + ASP.NET Core API + React in one compose.yaml
This builds on the `api/` and `web/` projects from the lesson 4 lab. Put them in one folder:

```text
stack/
├── compose.yaml
├── .env
├── db/init.sql
├── api/        (ASP.NET Core project + Dockerfile from lesson 4)
└── web/        (Vite project + Dockerfile + nginx.conf from lesson 4)
```

:::warn
Stop anything still using ports 5432, 8080, 8081, 8082 or 5173 from earlier labs
(`docker rm -f devpg api web`).
:::

**1. Database init script** — `db/init.sql`. Files in `/docker-entrypoint-initdb.d/` run once, on an
empty data directory:

```sql
CREATE TABLE IF NOT EXISTS visits (
    id  serial PRIMARY KEY,
    at  timestamptz NOT NULL DEFAULT now()
);
```

**2. Make the API talk to Postgres.** In `api/`:

```bash
dotnet add package Npgsql
dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
```

Replace `api/Program.cs`:

```csharp
using Microsoft.Extensions.Caching.Distributed;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Default")
    ?? throw new InvalidOperationException("ConnectionStrings:Default is not configured");
builder.Services.AddSingleton(NpgsqlDataSource.Create(connectionString));

// IDistributedCache backed by Redis — "redis:6379" comes from compose.yaml
builder.Services.AddStackExchangeRedisCache(o =>
{
    o.Configuration = builder.Configuration.GetConnectionString("Redis")
        ?? throw new InvalidOperationException("ConnectionStrings:Redis is not configured");
    o.InstanceName = "stack:";   // key prefix, so several apps can share one Redis
});

var app = builder.Build();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

// Cache-aside: try Redis first, fall back to Postgres and remember the answer for 60 s
app.MapGet("/api/db", async (NpgsqlDataSource db, IDistributedCache cache) =>
{
    var hit = await cache.GetStringAsync("pg-version");
    if (hit is not null) return Results.Ok(new { version = hit, cached = true });

    await using var cmd = db.CreateCommand("SELECT version()");
    var version = (string)(await cmd.ExecuteScalarAsync())!;
    await cache.SetStringAsync("pg-version", version,
        new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60) });
    return Results.Ok(new { version, cached = false });
});

app.MapGet("/api/visits", async (NpgsqlDataSource db) =>
{
    await using (var insert = db.CreateCommand("INSERT INTO visits DEFAULT VALUES"))
        await insert.ExecuteNonQueryAsync();
    await using var count = db.CreateCommand("SELECT count(*) FROM visits");
    return Results.Ok(new { visits = (long)(await count.ExecuteScalarAsync())! });
});

app.Run();
```

**3. Let nginx proxy `/api` to the API.** Add this block inside `server { … }` in `web/nginx.conf`,
*above* `location /`:

```nginx
location /api/ {
    proxy_pass http://api:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`api` is the Compose service name — resolved by Docker's DNS on the project network.

Replace `web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react'

export default function App() {
  const [visits, setVisits] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/visits')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { visits: number }) => setVisits(d.visits))
      .catch((e: Error) => setError(e.message))
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui', padding: 32 }}>
      <h1>Full stack in Compose</h1>
      {error ? <p>API error: {error}</p> : <p>Visits: {visits ?? '…'}</p>}
    </main>
  )
}
```

**4. `.env`** (in `stack/`):

```text
POSTGRES_PASSWORD=devpass
```

**5. `compose.yaml`:**

```yaml
name: stack

services:
  db:
    image: postgres:18
    environment:
      POSTGRES_DB: app
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    volumes:
      - pgdata:/var/lib/postgresql
      - ./db/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s

  redis:
    image: redis:8-alpine
    command: ["redis-server", "--save", "", "--appendonly", "no",
              "--maxmemory", "128mb", "--maxmemory-policy", "allkeys-lru"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  api:
    build: ./api
    environment:
      ConnectionStrings__Default: "Host=db;Port=5432;Database=app;Username=app;Password=${POSTGRES_PASSWORD}"
      ConnectionStrings__Redis: "redis:6379"
    depends_on:
      db:
        condition: service_healthy
        restart: true
      redis:
        condition: service_healthy
    ports:
      - "127.0.0.1:8080:8080"
    develop:
      watch:
        - action: rebuild
          path: ./api
          ignore: [bin/, obj/]

  web:
    build: ./web                  # nginx-unprivileged from lesson 4: UID 101, listens on 8080
    depends_on:
      - api
    ports:
      - "127.0.0.1:8081:8080"     # host 8081 → container 8080 (not 80: non-root nginx)

  adminer:
    image: adminer:5
    profiles: [tools]
    depends_on:
      - db
    ports:
      - "127.0.0.1:8082:8080"

volumes:
  pgdata:
```

**6. Up!**

```bash
docker compose config --quiet && echo "compose file OK"
docker compose up -d --build
docker compose ps
```

Expected: `stack-db-1 … Up … (healthy)`, `stack-redis-1 … Up … (healthy)`, `stack-api-1 … Up`,
`stack-web-1 … Up`. In the `up` output you saw `stack-db-1` and `stack-redis-1` go `Waiting` →
`Healthy` before `stack-api-1 Started`: the API was only **started** after *both* dependencies turned
healthy, so `docker compose logs api` shows no connection errors.

```bash
curl -s localhost:8080/api/db          # {"version":"PostgreSQL 18.x …","cached":false}
curl -s localhost:8080/api/db          # …"cached":true  — this time from Redis
curl -s localhost:8081/api/visits      # through nginx → api → db: {"visits":1}
curl -s localhost:8081/api/visits      # {"visits":2}
```

Open <http://localhost:8081> in the browser — the counter goes up on every reload.

**7. Look around.**

```bash
docker compose logs -f api                                  # Ctrl+C to stop following
docker compose exec db psql -U app -d app -c 'SELECT count(*) FROM visits;'
docker compose exec redis redis-cli --scan                   # stack:pg-version
docker compose exec redis redis-cli ttl stack:pg-version     # seconds left of the 60 s, e.g. 41
docker network ls | grep stack                               # stack_default
docker volume ls | grep stack                                # stack_pgdata — no named volume for redis
docker compose --profile tools up -d                         # adminer on http://localhost:8082
docker compose exec web id                                   # uid=101(nginx): the web tier isn't root
```

Now restart the cache and watch it come back **empty**, which is exactly what a cache may do:

```bash
docker compose restart redis
sleep 3                                # give the API's Redis client a moment to reconnect
curl -s localhost:8080/api/db          # "cached":false — cold cache, but no data lost
```

(Remove `--save ""` from the `command`, `docker compose up -d`, fill the cache and restart again:
now the entry survives, because Redis snapshots `dump.rdb` on shutdown. For a cache that's usually
not what you want — see "Persist it or not?".)

In Adminer, log in with System *PostgreSQL*, Server **`db`**, user `app`, password `devpass`,
database `app` — Adminer runs in a container too, so it uses the service name, not localhost.

**8. Watch mode.** Run `docker compose watch` in a second terminal. Change the `status = "ok"` text in
`Program.cs` and save; watch rebuilds the API image and recreates the container. Then:

```bash
curl -s localhost:8080/api/health
```

:::tip title="502 from nginx after the API was recreated?"
nginx resolves `api` **once, at startup**, and caches the IP. A recreated API container can get a new
IP, and nginx keeps proxying to the old one. `docker compose restart web` fixes it; in production
configs you add `resolver 127.0.0.11 valid=10s;` (Docker's embedded DNS) and put the upstream in a
variable so nginx re-resolves.
:::

**9. Tear down — and see what survives.**

```bash
docker compose --profile tools down       # containers + network gone, volume stays
docker compose up -d
curl -s localhost:8081/api/visits         # the count continues
docker compose down -v                    # now the volume is gone too
```

- [ ] `docker compose ps` showed db and redis as `(healthy)` and the API started without connection errors
- [ ] `curl localhost:8080/api/db` answered `"cached":false` and then `"cached":true` from Redis
- [ ] After `docker compose restart redis` the cache was empty again, and I can explain why that's fine for a cache
- [ ] `curl localhost:8081/api/visits` went through nginx (port 8080 in the container) → API → Postgres and counted up
- [ ] I connected Adminer to the `db` host using the `tools` profile
- [ ] Watch mode rebuilt the API after I edited `Program.cs`
- [ ] The visit count survived `down` + `up`, and was reset after `down -v`
:::

:::pro title="Migrations as a one-shot service"
Instead of letting every API replica run EF Core migrations on startup (racy with several replicas),
many teams add a `migrate` service that runs the migration bundle once and exits, with
`api.depends_on.migrate.condition: service_completed_successfully`. In Kubernetes the same idea becomes a
Job or an init container.
:::

:::pro title="A cache outage should make you slower, not down"
In the lab, `/api/db` returns 500 while Redis restarts, because `GetStringAsync` throws. In
production, treat the cache as optional: catch `RedisConnectionException` and fall through to
Postgres, or use **HybridCache** (`builder.Services.AddHybridCache()`), which layers an in-process
L1 cache over the Redis `IDistributedCache` L2, protects against stampedes (one database call per
key, not one per request) and keeps serving from L1 when L2 hiccups. Your readiness probe
(lesson 12) should usually *not* fail just because the cache is down.
:::

:::info title="Compose isn't the only way to run this stack locally"
The next lesson, **Containers in Dev and Test**, picks up from this `compose.yaml`: running the same
Postgres and Redis from your integration tests with **Testcontainers**, `docker compose run --rm
tests` as a CI step, **Dev Containers** (`devcontainer.json`), and **.NET Aspire**'s AppHost, which
many .NET teams now use *instead of* a hand-written compose file for local development, and when a
team picks which.
:::

:::cards id=ops-05-cards1 xp=20 title="Docker Compose"
Q: Short `depends_on: [db]` waits for…?
A: Only for the db container to be started — not for the database to be ready.
Q: The three `depends_on` conditions?
A: `service_started`, `service_healthy`, `service_completed_successfully`.
Q: Project `.env` vs `env_file:`?
A: `.env` fills `${VAR}` in the compose file; `env_file:` injects variables into the container.
Q: `${VAR:-x}` vs `${VAR:?msg}`?
A: Use default `x` if unset or empty · abort with `msg` if unset or empty.
Q: Why `$$` in a compose file?
A: Escapes Compose interpolation so `$` reaches the container literally.
Q: `down` vs `down -v`?
A: `down` removes containers and networks; `-v` also deletes named volumes (your data).
Q: How do you enable a profile?
A: `docker compose --profile tools up` or `COMPOSE_PROFILES=tools`.
Q: Which file is merged automatically on top of compose.yaml?
A: `compose.override.yaml` (unless you pass `-f` explicitly).
Q: How do you see the final merged config?
A: `docker compose config`.
Q: Watch actions?
A: `sync` (copy files in), `sync+restart`, `rebuild` (build image + recreate).
Q: How do you healthcheck Redis in Compose?
A: `test: ["CMD", "redis-cli", "ping"]`, and `condition: service_healthy` on the services that need it.
Q: Should a Redis that is only a cache persist its data?
A: No: turn off RDB/AOF and skip the volume. Cache entries can be rebuilt from the source of truth; persist (AOF + volume) only data that exists only in Redis.
Q: Why `${API_TAG:-dev}` instead of `${API_TAG:-latest}`?
A: A forgotten variable should fall back to a local-only name, not silently pull whatever was last pushed as `latest`. CI sets the commit SHA.
Q: How does the api container reach Postgres?
A: By service name: `Host=db` — Compose's network gives every service a DNS name. `localhost` would be the api container itself.
Q: Why write `ConnectionStrings__Default` as an env var?
A: ASP.NET Core maps `__` to `:`, so it becomes the config key `ConnectionStrings:Default`.
Q: Why `"127.0.0.1:5432:5432"` instead of `"5432:5432"`?
A: Without the IP, Docker publishes on all interfaces (and bypasses ufw on Linux) — the DB would be reachable from your network.
:::

## Recap

- `compose.yaml` declares services, networks and volumes; `docker compose up -d` converges to it,
  recreating only what changed. No `version:` line.
- Services reach each other **by service name** on the project network; `ports:` is only for the host.
- Use **healthchecks + `condition: service_healthy`** for real readiness, `service_completed_successfully`
  for one-shot jobs — and still make apps retry.
- A second backing service follows the same pattern: Redis with a `redis-cli ping` healthcheck,
  `service_healthy`, no published port, and no persistence when it's only a cache.
- `.env` = interpolation for Compose; `environment` / `env_file` = what the container sees. Default image
  tags to `dev` or a SHA, never `latest`.
- Profiles for optional tools, `compose.override.yaml` for local tweaks, `docker compose config` to debug.
- `docker compose watch` syncs or rebuilds on file changes; `down -v` deletes data.
