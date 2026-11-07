---
id: ops-06
title: Networks and Volumes
level: intermediate
minutes: 45
xp: 150
summary: How containers find each other (bridge networks, embedded DNS), the localhost trap, reaching the host, and where data really lives — volumes, bind mounts, backups and UIDs.
---

Two questions cause most "it works locally but not in Docker" tickets: *"why can't my API reach the
database?"* and *"where did my data go?"*. Both have precise, mechanical answers once you know what
Docker builds under the hood.

## Part 1 — Networking

### What a bridge network is

Remember: every container has its **own network namespace** — its own `lo`, its own `eth0`, its own
IP and port table. Docker connects those namespaces with plain Linux networking:

```text
 host network namespace
 ┌──────────────────────────────────────────────────────────────────────┐
 │  eth0 (192.168.1.20) ◀── NAT (masquerade) for outbound traffic         │
 │      ▲                                                                │
 │      │ DNAT: host:8080 → 172.18.0.3:8080 (published ports)            │
 │  ┌───┴──────────────────── br-3f2a (Linux bridge, 172.18.0.1) ──────┐  │
 │  │         veth pair                     veth pair                  │  │
 │  └────────────┬─────────────────────────────┬──────────────────────┘  │
 └───────────────┼─────────────────────────────┼──────────────────────────┘
        ┌────────┴────────┐           ┌────────┴────────┐
        │ eth0 172.18.0.2 │           │ eth0 172.18.0.3 │
        │ container "db"  │           │ container "api" │
        └─────────────────┘           └─────────────────┘
```

- A **bridge** is a virtual switch on the host. Each container gets a **veth pair** — a virtual cable
  with one end in the container (`eth0`) and one end plugged into the bridge.
- Containers on the same bridge talk to each other **directly**, on any port — no publishing needed.
- Outbound traffic (to the internet) is NAT-ed through the host's IP.
- **Published** ports (`-p`) add a DNAT rule from a host port to a container IP:port.

Two consequences people learn the hard way:

- `-p 8080:8080` publishes on **all** host interfaces (`0.0.0.0`). Docker's NAT rules sit in front of
  Linux firewalls like `ufw`, so "my firewall blocks 8080" is not a defence. For anything only *you*
  should reach (dev databases, admin UIs), bind to loopback: `-p 127.0.0.1:8080:8080`.
- Publishing is only needed **from the host into a container**. Container-to-container traffic on the
  same network never touches it.

### Network drivers

| Driver | What it is | When |
|---|---|---|
| `bridge` | Private virtual switch on one host (default) | 99% of local dev and Compose |
| `host` | No network namespace — the container uses the host's stack directly | Max performance / special tools on Linux; no port mapping |
| `none` | Only `lo` | Batch jobs that must not talk to anything |
| `overlay` | Spans multiple hosts (Swarm) | Rare today; Kubernetes uses its own CNI plugins |
| `macvlan` / `ipvlan` | Container gets an address on your physical LAN | Home labs, legacy appliances |

### DNS: the default bridge vs user-defined networks

There's a historical quirk you need to know:

| | Default `bridge` network (`docker0`) | User-defined bridge (`docker network create`, every Compose project) |
|---|---|---|
| Containers find each other by **name** | **No** (only by IP; legacy `--link`) | **Yes** — via Docker's embedded DNS |
| Isolation from other projects | everything is on it | only containers you attach |
| Used when | plain `docker run` without `--network` | `--network mynet`, Compose |

On user-defined networks, Docker runs an **embedded DNS server at `127.0.0.11`** inside every
container's namespace (`/etc/resolv.conf` points there). It answers container names, Compose service
names and aliases, and forwards everything else to your normal DNS.

```bash
docker network create labnet
docker run -d --name pg --network labnet -e POSTGRES_PASSWORD=x postgres:18
docker run --rm --network labnet alpine:3 ping -c1 pg        # works: pg → 172.x.x.x
docker run --rm alpine:3 ping -c1 pg                          # ping: bad address 'pg'
```

In Compose, each service is reachable by its **service name** (and the container name). With
`deploy.replicas: 3`, the service name resolves to all three IPs (round-robin DNS).

Why does Docker bother with names at all? Because container IPs are **not stable**: every time a
container is recreated (new image, changed config) it may get a different address. Names are the only
thing you can safely put in a connection string.

### Segmenting with several networks

A container can join several networks. Classic three-tier setup — the web tier can't even *see* the
database:

```yaml
services:
  web:
    networks: [frontend]
  api:
    networks: [frontend, backend]
  db:
    networks: [backend]

networks:
  frontend:
  backend:
    internal: true      # no outbound internet access from this network
```

`web` and `db` share no network, so `db` doesn't even resolve from `web` — a compromised web container
can't scan or attack the database directly. `internal: true` goes further: containers attached *only*
to `backend` have no route to the internet, and ports published from them aren't reachable from the
host either. That's why `api` sits on both networks — it is the one bridge between the tiers.

### The localhost trap

Inside a container, **`localhost` means the container itself** — its own network namespace. Not your
laptop, not the database container. This one table saves hours:

| From | To | Use |
|---|---|---|
| Your host (browser, Rider, DBeaver) | a container | `localhost:<published host port>` |
| Container | another container (same network) | `<service-name>:<container port>` — e.g. `db:5432` |
| Container | a process on your host | `host.docker.internal:<port>` |
| Container | itself | `localhost:<port>` |

Two variants of the same mistake:

- `ConnectionStrings__Default=Host=localhost;…` in the API container → connects to the API container's
  own loopback, where nothing listens → *connection refused*.
- Compose maps the db as `"5433:5432"` and the API uses `db:5433` → wrong: container-to-container
  traffic doesn't go through the published port. It's `db:5432`.

### Reaching the host: `host.docker.internal`

Sometimes the container must reach something on your machine — an API you're debugging in Rider, a
local LLM, a mock server.

- **Docker Desktop** (macOS/Windows/Linux Desktop) provides `host.docker.internal` automatically.
- **Docker Engine on Linux** doesn't, but has a magic value: map the name to the bridge gateway.

```bash
docker run --rm --add-host=host.docker.internal:host-gateway alpine:3 ping -c1 host.docker.internal
```

```yaml
services:
  api:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

The host-side process must listen on an address the bridge can reach (`0.0.0.0`, not `127.0.0.1`),
and your host firewall must allow it.

:::quiz id=ops-06-q1 xp=10
Compose file: `db` has `ports: ["5433:5432"]`. Which connection string should the **api service** use?
- [ ] `Host=localhost;Port=5433;…`
- [ ] `Host=localhost;Port=5432;…`
- [ ] `Host=db;Port=5433;…`
- [x] `Host=db;Port=5432;…`
> Containers on the same network talk directly to the **container** port (5432); the `5433` mapping is a NAT rule on the host and only applies to traffic arriving *at the host*. That makes `db:5433` the tempting wrong answer — it mixes the container's name with the host's port. Both `localhost` options fail because `localhost` inside the api container is the api container itself, where no Postgres runs.
:::

:::quiz id=ops-06-q2 xp=10
You started two containers with plain `docker run -d --name a …` and `docker run -d --name b …` (no
`--network`). From `a`, `ping b` says `bad address 'b'`. Why?
- [ ] Containers can never reach each other without `-p`
- [x] They're on the default bridge network, which has no name-based DNS
- [ ] The names must be fully qualified, like `b.docker.internal`
- [ ] Alpine images don't include DNS support
> Without `--network`, containers join the legacy default `bridge` network, and Docker's embedded DNS (`127.0.0.11`) only serves **user-defined** networks. The containers *can* reach each other by IP — so "never without `-p`" is wrong (publishing is for the host). There's no special DNS suffix, and Alpine's resolver works fine. Fix: `docker network create n` and start both with `--network n`, or use Compose, which creates a network for you.
:::

:::quiz id=ops-06-q3 xp=10
Your API runs in Compose. You want it to call a mock service you're running on your **Linux** laptop
with `npx json-server db.json --host 0.0.0.0 --port 4000`. What works?
- [ ] `http://localhost:4000`
- [ ] `http://127.0.0.1:4000`
- [x] `http://host.docker.internal:4000` with `extra_hosts: ["host.docker.internal:host-gateway"]`
- [ ] `http://json-server:4000`
> On Docker Engine for Linux, `host-gateway` is a special value that Docker replaces with the host's bridge gateway IP, and `extra_hosts` writes that mapping into the container's `/etc/hosts`. Docker Desktop adds the name automatically. `localhost` and `127.0.0.1` are the container's own loopback, not your laptop's. `json-server:4000` would only work if json-server were a Compose *service* — a host process has no Docker DNS name.
:::

## Part 2 — Storage

### Three kinds of mounts

The container's writable layer dies with the container and is slow for heavy writes (copy-on-write
through overlayfs). For anything that matters, you mount storage *into* the container:

```text
                    container filesystem view
 /var/lib/postgresql ──▶ named volume "pgdata"   (Docker-managed: /var/lib/docker/volumes/pgdata/_data)
 /app/src            ──▶ bind mount ./src        (a host folder you chose)
 /tmp                ──▶ tmpfs                   (RAM only, gone on stop)
 everything else     ──▶ image layers + writable layer
```

| | Named volume | Bind mount | tmpfs |
|---|---|---|---|
| Syntax | `-v pgdata:/var/lib/postgresql` | `-v ./src:/app/src` (path!) | `--tmpfs /tmp` |
| Managed by | Docker (`docker volume ls`) | You (it's just a host folder) | kernel, RAM |
| Lives at | `/var/lib/docker/volumes/<name>/_data` (inside the VM on Desktop) | wherever you point it | memory |
| Survives `docker rm` | **yes** | yes (it's your folder) | no |
| Pre-filled from image | **yes**, if the volume is empty | no — it *hides* the image's files | no |
| Performance on macOS/Windows | native (inside VM) | slower (file sharing across the VM boundary) | fastest |
| Typical use | Databases, uploads, caches | Source code in dev, config files | Secrets, scratch space with `--read-only` |

`-v` decides by the left side: a **name** → named volume, a **path** (`./`, `/`, `~`) → bind mount. That
makes typos dangerous: `-v pgdat:/var/lib/postgresql` silently creates a *new, empty* volume `pgdat`,
and `-v ./sorce:/app/src` silently creates an empty, root-owned host folder. The longer `--mount` syntax
(`--mount type=volume,src=pgdata,dst=/var/lib/postgresql`, `--mount type=bind,src=./src,dst=/app/src`)
spells out the type and **errors** if a bind-mount source doesn't exist — preferred in scripts.

:::warn title="Anonymous volumes pile up"
Images can declare `VOLUME /some/path` in their Dockerfile — `postgres` does. If you don't mount
anything there, Docker creates an **anonymous volume** with a random 64-hex-char name, *every time*.
`docker rm` (without `-v`) leaves it behind. That's where those dozens of mystery volumes come from.
`docker rm -v` or `--rm` removes anonymous volumes; `docker volume prune` cleans the rest.
:::

### How volumes get their initial content and ownership

When a **new, empty named volume** is mounted on a path that has files in the image, Docker **copies
the image's files — and their ownership and permissions — into the volume** first. This is why this
pattern works for non-root containers:

```dockerfile
RUN mkdir -p /data && chown 10001:10001 /data
# numeric, so Kubernetes' runAsNonRoot can verify it (lesson 7)
USER 10001
VOLUME /data
```

A fresh named volume at `/data` starts out owned by UID 10001. A **bind mount** does no such thing: the host
directory simply covers the path, with whatever ownership it has on the host.

### Persisting Postgres data properly

```yaml
services:
  db:
    image: postgres:18
    volumes:
      - pgdata:/var/lib/postgresql        # 18+: mount the parent, data is in 18/docker
volumes:
  pgdata:
```

What survives what:

| Action | Data |
|---|---|
| `docker compose restart` / `stop` / `start` | kept |
| `docker compose down` | kept (volume isn't removed) |
| `docker compose up --build` / new image version | kept |
| `docker compose down -v` / `docker volume rm` / `docker volume prune -a` | **gone** |
| Postgres **major** upgrade (18 → 19) | the files are kept, but 19 can't read them without `pg_upgrade` or dump/restore |

### Should a cache get a volume?

Postgres gets a named volume because it holds the **source of truth**. The Redis in lesson 5's stack
is the opposite: a cache, every entry of which can be recomputed from Postgres. Giving it a volume
buys you nothing useful: after a restart you'd load entries that were snapshotted minutes ago (maybe
stale), pay disk I/O for every snapshot, and keep one more volume to back up and clean up. An empty
cache is *correct*, just slower for a minute. So for a cache: persistence off (`--save ""`,
`--appendonly no`) and **no volume**.

One catch: the `redis` image declares `VOLUME /data`, so even without a `volumes:` entry Docker
attaches an **anonymous volume** there (see the warning above). With persistence off nothing is
written to it, so it's harmless, but it shows up in `docker volume ls` and `docker compose down -v`
(or `docker rm -v`) is what removes it.

Give Redis a named volume on `/data` **plus** `--appendonly yes` only when it holds data that exists
nowhere else: sessions you can't afford to drop, a job queue, a leaderboard. The rule is the same for
every service: **persist what you can't rebuild.**

:::quiz id=ops-06-q7 xp=10
Which services in a typical stack deserve a **named volume**? (select all that apply)
- [x] Postgres, holding the application's tables
- [ ] Redis, used only as `IDistributedCache` in front of Postgres
- [x] Redis, used as the job queue for background workers (with AOF on)
- [ ] The nginx container serving the built React app
- [x] A file-upload folder the API writes user documents to
> Volumes are for data whose only copy lives in the container: database tables, queued jobs, uploaded files. A cache is a derived copy of Postgres data, so an empty cache after a restart is fine. The nginx image already *contains* the built app; anything it serves is rebuilt with the image, and writing to it at run time would be a bug.
:::

### Backups

**Logical backups (preferred for databases)** — let Postgres write a consistent dump while running:

```bash
# backup (custom format, compressed)
docker compose exec -T db pg_dump -U app -d app -Fc > app-$(date +%F).dump

# restore into an existing database
docker compose exec -T db pg_restore -U app -d app --clean --if-exists < app-2026-11-05.dump
```

`-T` disables the pseudo-TTY. `docker compose exec` allocates a TTY **by default** (plain `docker exec`
doesn't — it needs `-it` to get one). A TTY is meant for humans: it translates line endings and merges
stderr into stdout, so a binary dump piped through it gets corrupted and error messages end up *inside*
the dump file. Whenever you redirect input or output, use `-T`.

**Volume (file-level) backups** — tar up the volume from a throwaway container. For a database, **stop
it first**, or the copy can be inconsistent:

```bash
docker compose stop db
docker run --rm -v stack_pgdata:/volume:ro -v "$PWD":/backup alpine:3 \
  tar czf /backup/pgdata.tgz -C /volume .
docker compose start db

# restore into a (new, empty) volume
docker run --rm -v stack_pgdata:/volume -v "$PWD":/backup alpine:3 \
  sh -c 'cd /volume && tar xzf /backup/pgdata.tgz'
```

This "mount the volume into an alpine container" trick works for any volume, any data.

### File permissions and UIDs

The kernel doesn't know user *names*, only numeric **UIDs**. A file in a bind mount is owned by a number,
and that number means the same thing inside and outside the container (unless user namespaces remap it).

```text
  inside the container           host
  ─────────────────────          ──────────────────
  root    = UID 0          ═══▶  root (UID 0)
  node    = UID 1000       ═══▶  whoever is UID 1000 on the host — maybe you
  app     = UID 1654       ═══▶  nobody you know
  postgres= UID 999        ═══▶  maybe "systemd-coredump"…
```

Consequences on **Linux** with bind mounts:

- A container running as root creates root-owned *directories* in your project folder (classic:
  `node_modules`, `bin/`, `obj/`) whose contents **you can't delete** as yourself. You need `sudo` or a
  root container (`docker run --rm -v "$PWD":/w alpine rm -rf /w/bin`).
- A container running as UID 1654 can't write into a bind-mounted folder owned by your UID 1000 →
  *permission denied*.

Fixes, in order of preference:

1. Use **named volumes** for data the container owns (Docker handles initial ownership as above).
2. Run dev containers as your own user: `docker run --user "$(id -u):$(id -g)" …`
   (Compose: `user: "${UID}:${GID}"` — export them first, since bash doesn't export `UID` by default).
3. `chown` the directory in the Dockerfile to the app's UID (for image paths, not bind mounts).
4. Rootless Docker / Podman, where container root maps to your own user.

:::info title="macOS and Windows behave differently"
Docker Desktop's file sharing translates ownership, so files created through bind mounts usually show
up as *your* user on the Mac. Your Linux colleagues (and CI) won't be that lucky — test your setup there.
On Fedora/RHEL with SELinux, bind mounts may additionally need the `:z` suffix (`-v ./src:/app/src:z`).
:::

:::quiz id=ops-06-q4 xp=10
You bind-mount `./uploads:/app/uploads` into an ASP.NET Core container that runs as `USER $APP_UID`
(1654). On a Linux host, uploads fail with `UnauthorizedAccessException`. Most likely cause?
- [ ] Bind mounts are read-only by default
- [x] `./uploads` is owned by your host user (e.g. UID 1000), and UID 1654 has no write permission
- [ ] ASP.NET Core can't write files in containers
- [ ] Bind mounts only work with Docker Desktop
> The kernel checks permissions by **numeric** UID: the folder belongs to UID 1000 (you), the process runs as UID 1654, so writing is denied. Bind mounts are read-write unless you add `:ro`, so the "read-only by default" option is wrong, and they work fine on plain Docker Engine. Fixes: use a named volume (Docker copies ownership from the image on first use), run the container with `--user "$(id -u):$(id -g)"` for dev, or give UID 1654 write access to the host folder.
:::

:::quiz id=ops-06-q5 xp=15
Which statements about mounts are true? (select all that apply)
- [x] A new, empty named volume is pre-filled with the image's files at that path
- [ ] A bind mount merges the host folder with the image's files at that path
- [x] `docker run --rm` removes anonymous volumes created for that container
- [x] `docker compose down` keeps named volumes
- [ ] `docker volume prune` (without `-a`) deletes your unused named database volume
> A fresh named volume is seeded from the image, `--rm` also removes the container's anonymous volumes, and `down` (without `-v`) leaves named volumes alone. The tempting wrong one is "bind mounts merge": they don't — the host folder completely **hides** whatever the image had at that path. And since Docker 23, plain `docker volume prune` only removes unused *anonymous* volumes; you need `-a` to delete named ones like your database.
:::

:::quiz id=ops-06-q6 xp=10
Your API image publishes the app to `/app` (`COPY --from=build /out /app`, `ENTRYPOINT ["dotnet", "Api.dll"]`).
To "see config changes live", a colleague adds this to the Compose file:

```yaml
  api:
    volumes:
      - ./api:/app
```

The container now exits immediately with *"The application to execute does not exist: '/app/Api.dll'"*.
What happened?
- [ ] Compose can't bind-mount into a path that has a `WORKDIR`
- [x] The bind mount hides the image's `/app`; the container now sees your source folder, which has no compiled `Api.dll`
- [ ] Bind mounts are copied into the image at build time, so a rebuild is needed
- [ ] The container lacks permission to read bind mounts until you add `:z`
> A bind mount *replaces* the view of that path — the published output baked into the image is still in the image, but invisible. `./api` contains `.cs` files and maybe a `bin/Debug` folder, not `/app/Api.dll`. Bind mounts are resolved at **run** time, never at build time, and `WORKDIR` doesn't matter. `:z` is only about SELinux labels and would give a permission error, not "does not exist". Mount a single config file instead (`./api/appsettings.Development.json:/app/appsettings.Development.json:ro`) or use a dev image that runs `dotnet watch` on the source.
:::

:::pro title="The node_modules bind-mount trick"
If you bind-mount your whole project for development (`./web:/app`), your host's `node_modules` (maybe
built for macOS) hides the container's Linux build. The standard workaround is an extra **anonymous
volume** on that path: `volumes: ["./web:/app", "/app/node_modules"]` — the more specific mount wins, so
the container keeps its own `node_modules`. Compose watch (lesson 5) avoids the problem altogether.
:::

## Lab

:::lab id=ops-06-lab1 xp=150
title: DNS, the localhost trap, persistence, backups and UIDs
Everything here uses throwaway names (`labnet`, `lab-*`), so it doesn't touch earlier labs.

**1. DNS on the default bridge vs a user-defined network.**

```bash
docker network create labnet
docker run -d --name lab-pg --network labnet -e POSTGRES_PASSWORD=labpass postgres:18
docker run --rm --network labnet alpine:3 ping -c1 lab-pg     # resolves to 172.x.x.x
docker run --rm alpine:3 ping -c1 lab-pg                       # ping: bad address 'lab-pg'
docker run --rm --network labnet alpine:3 cat /etc/resolv.conf # nameserver 127.0.0.11
```

**2. The localhost trap.** `pg_isready` checks if a server accepts connections:

```bash
sleep 3
docker run --rm --network labnet postgres:18 pg_isready -h lab-pg       # lab-pg:5432 - accepting connections
docker run --rm --network labnet postgres:18 pg_isready -h localhost    # localhost:5432 - no response
```

The second container *is* `localhost` from its own point of view — and no Postgres runs in it.

**3. Reaching the host.** Start a tiny server on your host (any free port):

```bash
python3 -m http.server 9000 --bind 0.0.0.0 &
sleep 1                                   # give the server a moment to start
docker run --rm --add-host=host.docker.internal:host-gateway alpine:3 \
  wget -qO- http://host.docker.internal:9000 | head -n 3
kill %1
```

You'll see the start of a directory listing. (If it hangs on Linux, your host firewall is blocking
traffic from the Docker bridge — that's a real-world finding too.)

**4. Anonymous volumes appear.**

```bash
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{"\n"}}{{end}}' lab-pg
docker rm -f lab-pg
docker volume ls          # the long hex-named volume is still there
docker volume prune -f    # removes unused anonymous volumes
```

**5. Persistence with a named volume + a logical backup.**

```bash
docker run -d --name lab-pg --network labnet -e POSTGRES_PASSWORD=labpass \
  -v lab-pgdata:/var/lib/postgresql postgres:18
until docker exec lab-pg pg_isready -h 127.0.0.1 -q; do sleep 1; done   # TCP opens only after init
docker exec lab-pg psql -U postgres -c "CREATE TABLE pets(name text); INSERT INTO pets VALUES ('Rex'),('Mia');"

docker exec lab-pg pg_dump -U postgres -Fc postgres > pets.dump
ls -lh pets.dump

docker exec lab-pg psql -U postgres -c "DROP TABLE pets;"          # disaster!
docker exec -i lab-pg pg_restore -U postgres -d postgres < pets.dump
docker exec lab-pg psql -U postgres -c "SELECT * FROM pets;"       # Rex, Mia are back
```

Plain `docker exec` has no TTY unless you pass `-t`, so no `-T` is needed here; the restore needs `-i`
to forward your stdin (the dump file) into the container.

**6. File-level volume backup.**

```bash
docker stop lab-pg
docker run --rm -v lab-pgdata:/volume:ro -v "$PWD":/backup alpine:3 tar czf /backup/lab-pgdata.tgz -C /volume .
docker start lab-pg
tar tzf lab-pgdata.tgz | head -n 5     # ./18/docker/… — the PG 18 layout
```

**7. UIDs and bind mounts** (most interesting on Linux):

```bash
mkdir -p out
docker run --rm -v "$PWD/out":/out alpine:3 sh -c 'mkdir /out/as-root && touch /out/as-root/file.txt'
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/out":/out alpine:3 touch /out/as-me.txt
ls -ln out
rm -rf out/as-root        # Linux: rm: cannot remove 'out/as-root/file.txt': Permission denied
```

Expected on Linux (your UID/GID instead of 1000):

```text
drwxr-xr-x 2    0    0 4096 … as-root
-rw-r--r-- 1 1000 1000    0 … as-me.txt
```

The directory `as-root` belongs to UID 0, so you can't delete files inside it — exactly what happens with
`bin/`, `obj/` or `node_modules/` created by a root container. (A file directly in `out/` would be
deletable, because deleting needs write permission on the *parent* directory, which is yours.) On Docker
Desktop both entries typically show as your user.

You don't need `sudo` to clean up — let a container (which is root) do it:

```bash
docker run --rm -v "$PWD/out":/out alpine:3 rm -rf /out/as-root
```

**8. Clean up.**

```bash
docker rm -f lab-pg
docker volume rm lab-pgdata
docker network rm labnet
rm -rf out pets.dump lab-pgdata.tgz
```

- [ ] Name resolution worked on `labnet` and failed on the default bridge
- [ ] `pg_isready -h localhost` failed from a second container, and I can explain why
- [ ] A container reached a server on my host via `host.docker.internal`
- [ ] I restored a dropped table from a `pg_dump` file
- [ ] I saw root-owned vs my-UID-owned files from bind mounts, and removed the root-owned folder with a container
:::

:::job title="Day-one questions you can now answer"
"Why does the API work in Rider but not in Compose?" (localhost in the connection string). "Why is
`docker volume ls` full of hashes?" (anonymous volumes from `VOLUME`). "Why can't I delete `bin/` after
running the container?" (root-owned files from a bind mount). "How do I get a copy of the dev database
for a colleague?" (`pg_dump` via `exec -T`).
:::

:::cards id=ops-06-cards1 xp=20 title="Networks & volumes"
Q: What does `localhost` mean inside a container?
A: The container itself (its own network namespace).
Q: How does one Compose service reach another?
A: By service name on the project network, using the container port: `db:5432`.
Q: Where is Docker's embedded DNS?
A: `127.0.0.11` inside containers on user-defined networks (not on the default bridge).
Q: How does a container reach a process on the host?
A: `host.docker.internal` — automatic on Docker Desktop; on Linux add `host.docker.internal:host-gateway`.
Q: Named volume vs bind mount?
A: Named: Docker-managed, pre-filled from the image, best for data. Bind: a host path that hides the image's files, best for dev source/config.
Q: Where do anonymous volumes come from?
A: `VOLUME` in an image's Dockerfile when you don't mount that path. Remove with `docker rm -v` / `--rm`.
Q: Best way to back up a Postgres container?
A: `docker compose exec -T db pg_dump -Fc … > file.dump`; restore with `pg_restore`.
Q: Why `-T` with `docker compose exec` when redirecting?
A: Compose exec allocates a TTY by default; a TTY translates line endings and merges stderr, corrupting piped/binary data. Plain `docker exec` has no TTY unless `-t`.
Q: Why use names, not IPs, between containers?
A: Container IPs change when containers are recreated; DNS names stay the same.
Q: Why `-p 127.0.0.1:5432:5432` for a dev database?
A: Plain `-p 5432:5432` listens on all interfaces, and Docker's NAT rules bypass ufw — anyone on your network could connect.
Q: Why "permission denied" with a bind mount on Linux?
A: UIDs are numeric and shared: the container user's UID doesn't own the host folder.
Q: What does `internal: true` on a network do?
A: Blocks outbound/external access from that network.
:::

## Recap

- Bridge networks are virtual switches with veth cables; containers on the same network talk directly on
  container ports; published ports are only for the host — bind them to `127.0.0.1` unless others must
  reach them.
- Name-based DNS (`127.0.0.11`) works on **user-defined** networks (and Compose), not the default bridge.
- `localhost` in a container is the container. Use service names for containers, `host.docker.internal`
  (+ `host-gateway` on Linux) for the host.
- Named volumes for data (pre-filled with image content and ownership), bind mounts for dev source and
  config, tmpfs for scratch. Watch out for anonymous volumes.
- Back up databases with `pg_dump` (`exec -T`); tar volumes from a throwaway container when stopped.
- Ownership is numeric UIDs: run as your UID, use named volumes, or chown in the image.
