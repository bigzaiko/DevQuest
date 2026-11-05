---
id: ops-02
title: The Docker CLI, Hands-On
level: beginner
minutes: 35
xp: 100
summary: run, ps, logs, exec, inspect, port publishing, env vars, cleanup — and a Postgres 18 dev database in one command.
---

You'll use a dozen Docker commands every single day. This lesson goes through them with the mental
model from lesson 1 in mind: every command is either about **images** (templates), **containers**
(instances), or the **plumbing** around them (networks, volumes).

## Is Docker working?

```bash
docker version          # client AND server versions — if "server" errors, the daemon is down
docker info             # storage driver, cgroup version, number of containers/images, …
docker compose version  # Compose v2 is a CLI plugin: "docker compose", with a space
```

:::warn title="docker-compose (with a dash) is dead"
`docker-compose` was the old Python v1 tool, end-of-life since 2023. Use `docker compose` (v2, built
in). If a tutorial writes `version: "3.8"` at the top of a compose file, it's from that era too.
:::

On Linux, if you get `permission denied while trying to connect to the Docker daemon socket`, either
prefix with `sudo` or add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log
out and in) — remembering from lesson 1 that this group is effectively root.

## The life of a container

```text
             docker create              docker start
   image ──────────────────▶ created ──────────────────▶ running
                                                         │     ▲
            process exits on its own, docker stop, or    │     │  docker start
            docker kill                                  ▼     │  (or docker restart)
                                                        exited ┘
                                                         │
                                                         │ docker rm
                                                         ▼
                                                       (gone)

   docker run     = pull (if missing) + create + start (+ attach to its output)
   docker stop    = send SIGTERM, wait 10 s, then SIGKILL
```

Three states matter in practice: **created** (configured, never started), **running**, and
**exited** (stopped, but still on disk with its config and writable layer until you `docker rm` it).

The key insight: **a container lives exactly as long as its main process.** That process is
**PID 1** — the first process in the container's own process namespace. When PID 1 exits, the
container stops, no matter what else is running inside it. That explains a classic beginner
puzzle: `docker run ubuntu` "does nothing". The image's default command is `bash`; without `-i`
there is no stdin to read from, so bash immediately reads end-of-file, exits — and the container
exits with it. Servers like nginx or Postgres stay up because their main process keeps running.

## `docker run` — the command with a hundred flags

```bash
docker run [OPTIONS] IMAGE [COMMAND] [ARGS...]
```

Everything after the image name *replaces the image's default command* (`CMD`, which you'll write
yourself in lesson 3). Options go **before** the image name — `docker run alpine:3 --rm echo hi`
passes `--rm` to the container as a command, not to Docker. If the image isn't on your machine yet,
`docker run` pulls it first.

```bash
docker run alpine:3 echo "hello"            # runs echo instead of the default sh
docker run -it alpine:3 sh                  # interactive shell
docker run -d --name web nginx:1.30-alpine  # background server with a name
docker run --rm alpine:3 cat /etc/os-release  # throwaway: deleted when it exits
```

The flags you'll use constantly:

| Flag | Meaning | Why |
|---|---|---|
| `-d` | **detached**: run in background, print the container ID | Servers, databases |
| `-i` | keep **stdin** open | So you can type into it |
| `-t` | allocate a **pseudo-TTY** | Prompt, colours, Ctrl+C behave like a terminal |
| `-it` | both — the "give me a shell" combo | `docker run -it ubuntu bash` |
| `--rm` | delete the container when it exits | One-off commands, no garbage left |
| `--name api` | human name instead of `angry_wozniak` | So you can `docker logs api` |
| `-p 8080:80` | **publish** host port 8080 → container port 80 | Reach it from your browser |
| `-e KEY=value` | set an environment variable | Configuration (12-factor style) |
| `--env-file .env` | load many env vars from a file | Keep the command short |
| `-v name:/path` | mount a volume (lesson 6) | Persist data |
| `--restart unless-stopped` | restart whenever it exits (crash *or* normal exit) and when the Docker daemon starts, unless you stopped it yourself (`on-failure` restarts only on non-zero exit codes) | Dev services that should survive a reboot |

:::tip title="Ctrl+C, Ctrl+P Ctrl+Q"
In a container started with `-it`, **Ctrl+C** sends SIGINT to the process (usually stopping it).
**Ctrl+P then Ctrl+Q** *detaches* and leaves it running. Reattach with `docker attach <name>`.
:::

## Port publishing

Remember: each container has its **own network namespace**. A server listening on port 80 *inside* a
container is unreachable from your host until you publish it:

```text
  browser ──▶ host 0.0.0.0:8080 ──(docker-proxy / iptables NAT)──▶ container 172.17.0.2:80 ──▶ nginx
```

| `-p` value | Host side | Container side |
|---|---|---|
| `8080:80` | port 8080 on **all** host interfaces | 80/tcp |
| `127.0.0.1:5432:5432` | port 5432 on **localhost only** | 5432/tcp |
| `80` | a **random** free host port | 80/tcp |
| `127.0.0.1::80` | random port, localhost only | 80/tcp |
| `5353:53/udp` | 5353/udp | 53/udp |

The order is always **HOST:CONTAINER** — "outside:inside". `docker port <name>` shows what's mapped.
Two containers can both listen on port 80 *inside* (separate namespaces), but only one of them can
own a given *host* port — the second `docker run -p 8080:…` fails with "port is already allocated".

:::warn title="Docker bypasses your firewall"
On Linux, Docker publishes ports by writing its own iptables/nftables rules, which are evaluated
*before* tools like `ufw`. `-p 5432:5432` on a cloud VM makes your database reachable from the
internet even if `ufw` says port 5432 is closed. For dev databases, **always bind to 127.0.0.1**:
`-p 127.0.0.1:5432:5432`.
:::

The other classic port mistake is inside the container: if your app listens on `127.0.0.1:3000`,
it only accepts connections from *inside its own network namespace* — the published port can't reach
it. Servers in containers must listen on **`0.0.0.0`** (all interfaces). That's why the Vite dev
server needs `--host` in a container, and why Microsoft's ASP.NET Core images set
`ASPNETCORE_HTTP_PORTS=8080`, which makes Kestrel listen on port 8080 on *all* interfaces.

:::quiz id=ops-02-q1 xp=10
`docker run -d -p 3000:8080 my-api` — which URL reaches the API from your browser?
- [ ] `http://localhost:8080`
- [x] `http://localhost:3000`
- [ ] `http://my-api:3000`
- [ ] It's unreachable until you also add `EXPOSE 3000`
> `-p HOST:CONTAINER`: host port 3000 forwards to port 8080 inside the container. `localhost:8080` is the tempting answer, but 8080 exists only *inside* the container's network namespace — nothing listens on your host's 8080. `my-api` is an image name, not a hostname your browser can resolve, and `EXPOSE` is only documentation; it never publishes anything.
:::

:::quiz id=ops-02-q2 xp=10
A Node server in a container logs `listening on 127.0.0.1:3000`. You ran it with `-p 3000:3000`, but
`curl localhost:3000` on your host gets `connection reset`. Why?
- [ ] Port 3000 is reserved by Docker
- [x] Inside the container, 127.0.0.1 is the container's own loopback; traffic arriving on eth0 isn't accepted
- [ ] You need `-p 127.0.0.1:3000:3000` instead
- [ ] curl doesn't support containers
> The forwarded traffic arrives on the container's `eth0` interface, not on its loopback, so a server bound to `127.0.0.1` never sees it. Fix it in the app: listen on `0.0.0.0` inside the container. `-p 127.0.0.1:3000:3000` is tempting but changes the *host* side only (who on your machine/network may connect); the container side would still refuse the traffic.
:::

## Watching and poking containers

```bash
docker ps                         # running containers
docker ps -a                      # include stopped ones
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

docker logs web                   # everything the process wrote to stdout/stderr
docker logs -f --tail 50 web      # follow, starting from the last 50 lines
docker logs --since 10m web

docker exec -it web sh            # open a shell in a RUNNING container
docker exec web nginx -t          # run one command in it

docker inspect web                # the full JSON truth about the container
docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' web
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' web

docker stats                      # live CPU / memory per container
docker top web                    # processes inside it
docker cp web:/etc/nginx/nginx.conf ./nginx.conf   # copy files out (or in)
```

Two distinctions that trip people up:

- **`docker run` vs `docker exec`** — `run` creates a *new* container from an image. `exec` runs an
  *extra* process inside an *existing, running* container (same namespaces). Exiting an `exec` shell
  doesn't stop the container.
- **Logs are stdout/stderr.** Docker captures what PID 1 writes to stdout/stderr. If your app writes
  to `/var/log/app.log` instead, `docker logs` shows nothing. Containerized apps log to the console
  (ASP.NET Core does by default) and let the platform collect it.

:::job title="The first three commands when something is broken"
`docker ps -a` (is it running? what's the exit code?), `docker logs <name>` (what did it say before
dying?), `docker inspect <name>` (what config did it actually get — env, mounts, ports?). Exit codes:
**0** = finished normally, **1** = app error, **137** = SIGKILL (often OOM — check
`.State.OOMKilled`), **143** = SIGTERM, **125/126/127** = Docker couldn't run the command.
:::

## Stop, start, remove

```bash
docker stop web        # SIGTERM, then SIGKILL after 10 s (-t to change)
docker kill web        # SIGKILL immediately
docker start web       # start a stopped container again (same writable layer, same config)
docker restart web
docker rm web          # delete a stopped container
docker rm -f web       # stop + delete
```

A stopped container keeps its writable layer and its configuration. You cannot change the ports or
env vars of an existing container — you **remove and re-run** it. That's normal: containers are
cattle, not pets.

## Environment variables

Containers are configured through environment variables, following the
[twelve-factor](https://12factor.net/config) idea: same image in every environment, different config.

```bash
docker run --rm -e GREETING=hi -e APP_ENV=dev alpine:3 sh -c 'echo $GREETING from $APP_ENV'
# → hi from dev
docker run --rm --env-file ./dev.env alpine:3 env
```

Note the **single quotes** in the first command. With double quotes, *your host shell* would expand
`$GREETING` before Docker ever sees it (to an empty string, most likely). Single quotes pass the
literal text `$GREETING` into the container, where the container's `sh` expands it.

An env file is one `KEY=value` per line, no `export`, no quotes needed:

```text
# dev.env
APP_ENV=dev
GREETING=hello
```

ASP.NET Core maps env vars onto its configuration tree with **double underscores**:
`ConnectionStrings__Default=...` becomes `ConnectionStrings:Default`, `Logging__LogLevel__Default=Debug`
becomes `Logging:LogLevel:Default`.

:::warn
Environment variables are visible to anyone who can run `docker inspect` on the container. Fine for
local dev passwords; for production secrets, use your platform's secret store (lesson 7).
:::

## Images: list, pull, remove

```bash
docker images                      # or: docker image ls
docker pull postgres:18
docker image rm nginx:1.30-alpine  # or: docker rmi
docker image inspect postgres:18 -f '{{.Config.Env}}'
docker tag nginx:1.30-alpine my-nginx:dev  # a second name for the same image ID
```

## Cleaning up

Docker never deletes anything on its own; disks fill up silently. Know where the space goes:

```bash
docker system df                   # images / containers / volumes / build cache sizes
```

| Command | Removes |
|---|---|
| `docker container prune` | all **stopped** containers |
| `docker image prune` | **dangling** images (untagged `<none>:<none>` leftovers from rebuilds) |
| `docker image prune -a` | every image not used by a container |
| `docker volume prune` | unused **anonymous** volumes (add `-a` for unused *named* volumes too) |
| `docker builder prune` | BuildKit build cache |
| `docker system prune` | stopped containers + unused networks + dangling images + unused build cache |
| `docker system prune -a --volumes` | ... plus all unused images and unused **anonymous** volumes. Close to nuclear. |

A **dangling** image is one that has lost its name: you rebuilt `myapp:dev`, the tag moved to the
new image, and the old one is left as `<none>:<none>`. An **anonymous** volume is one Docker created
with a random hex name because the image declares a `VOLUME` and you didn't mount anything there;
a **named** volume is one you created by name, like `-v devpg-data:/…`. "Unused" means no container
— running *or stopped* — references it.

:::warn title="Volumes are your data"
`docker volume prune -a` deletes every named volume that no container currently references — so if
you `docker rm`'d your dev database container, its data volume goes too. And if you ever started
Postgres **without** `-v`, its data sits in an anonymous volume that even a plain `docker volume prune`
or `docker system prune --volumes` removes. (Before Docker Engine 23, `volume prune` removed named
volumes as well — old blog posts may describe that behaviour.) Read the confirmation prompt.
:::

:::quiz id=ops-02-q3 xp=10
You started a container with `docker run -d --name pg -e POSTGRES_PASSWORD=x postgres:18`. Now you
want to publish port 5432. What do you do?
- [ ] `docker update -p 5432:5432 pg`
- [ ] `docker restart -p 5432:5432 pg`
- [x] `docker rm -f pg`, then `docker run` again with `-p`
- [ ] `docker exec pg expose 5432`
> Port mappings, env vars and mounts are fixed when the container is created, so you recreate it. `docker update` is the tempting option because it really exists — but it only changes resource limits (CPU, memory) and the restart policy, not ports. `restart` reuses the existing config, and there is no `expose` command. (The container's data survives recreation only if it's in a volume — which is why the lab below uses one.)
:::

:::quiz id=ops-02-q4 xp=10
`docker ps -a` shows your API with status `Exited (137) 3 seconds ago`. What is the most likely cause?
- [ ] The app called `Environment.Exit(137)` on purpose
- [x] The process was killed with SIGKILL — often the out-of-memory killer or a `docker kill`
- [ ] The image is corrupted
- [ ] The port was already in use
> Exit codes above 128 mean "killed by signal (code − 128)": 137 = 128 + 9, and signal 9 is SIGKILL. Check `docker inspect -f '{{.State.OOMKilled}}' api` to see whether the kernel's out-of-memory killer did it. An app *could* call `Environment.Exit(137)`, but nobody does that — the signal is the realistic cause. A port conflict never produces an exit code: it fails at `docker run` time with "port is already allocated", before the process starts.
:::

:::quiz id=ops-02-q5 xp=10
Which commands run something **inside an already running** container named `api`? (select all that apply)
- [x] `docker exec -it api sh`
- [ ] `docker run -it api sh`
- [x] `docker exec api env`
- [ ] `docker start -it api sh`
> `exec` starts an extra process inside an existing container's namespaces — both `exec` lines qualify. `docker run api …` looks tempting, but it creates a *new* container from an *image* called `api` (and fails if there's no such image). `docker start` only restarts a stopped container with its original command; it accepts no command of its own (and has no `-t` flag).
:::

:::quiz id=ops-02-q6 xp=10
Your dev Postgres has been running for weeks on the named volume `devpg-data`. You change
`-e POSTGRES_PASSWORD=devpass` to `-e POSTGRES_PASSWORD=newpass`, recreate the container on the
same volume, and try to log in with `newpass`. What happens?
- [ ] It works — the image updates the password on every start
- [x] Login fails: `POSTGRES_PASSWORD` is only applied when the data directory is empty, so the old password is still stored in the volume
- [ ] The container refuses to start because the password changed
- [ ] Postgres wipes the volume and re-initialises with the new password
> The image's entrypoint runs `initdb` (and applies `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB`) only when it finds an **empty** data directory. On an existing volume it skips initialisation entirely, so the password stored inside the database is still `devpass`. "It updates on every start" is the intuitive but wrong assumption. To really change it, run `ALTER USER postgres PASSWORD 'newpass';` via `psql` — or delete the volume if the data is disposable.
:::

## Postgres 18 in a container — your dev database

This is the single most useful Docker trick for a full-stack developer: no installer, no service
running all the time, a version per project, and `docker rm` resets it.

```bash
docker run -d \
  --name devpg \
  -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=app \
  -p 127.0.0.1:5432:5432 \
  -v devpg-data:/var/lib/postgresql \
  postgres:18
```

What each piece does:

- `POSTGRES_PASSWORD` is **required** — the image refuses to start without it (or an explicit opt-out).
- `POSTGRES_DB=app` creates the `app` database on **first** start. (`POSTGRES_USER` defaults to `postgres`.)
- `-p 127.0.0.1:5432:5432` makes it reachable from your host (your API, DBeaver, Rider…) but not from the network.
- `-v devpg-data:/var/lib/postgresql` stores the data in a **named volume**, so it survives
  `docker rm devpg`.

:::warn title="PostgreSQL 18 changed the data directory"
Up to `postgres:17` the image stored data in `/var/lib/postgresql/data`, and every tutorial mounts
that path. From **`postgres:18`** the data lives in a versioned subdirectory
(`/var/lib/postgresql/18/docker`) and the volume should be mounted at **`/var/lib/postgresql`** — this
makes future `pg_upgrade` between major versions possible. Copying an old `-v …:/var/lib/postgresql/data`
line onto an 18 image will not do what you want.
:::

Init-time env vars (`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`) only apply when the data
directory is **empty**. Changing the password env var later does nothing to an existing volume — a
classic "why can't I log in" afternoon.

From your ASP.NET Core app on the host, the connection string is:

```text
Host=localhost;Port=5432;Database=app;Username=postgres;Password=devpass
```

## Simulate it: resolve a `-p` mapping

:::challenge id=ops-02-c1 lang=ts xp=40
title: Parse a port publishing spec
Write `parsePort(spec)` for the `-p` values from the table above. Return
`{ hostIp, hostPort, containerPort, protocol }`:

- `hostIp` defaults to `"0.0.0.0"`, `protocol` to `"tcp"`.
- `hostPort` is `null` when Docker should pick a random port (`"80"` or `"127.0.0.1::80"`).
- Ports are numbers. Ignore IPv6 addresses (no brackets in the tests).
- Formats: `C`, `H:C`, `IP:H:C`, `IP::C`, each optionally followed by `/udp` or `/tcp`.

hint: Split off `/proto` first, then split the rest on `:` and switch on the number of parts.
hint: An empty string between two colons means "random host port".

```ts starter
export interface PortMapping {
  hostIp: string
  hostPort: number | null
  containerPort: number
  protocol: 'tcp' | 'udp'
}

export function parsePort(spec: string): PortMapping {
  // Bug: treats the first number as the container port
  const [a, b] = spec.split(':')
  return { hostIp: '0.0.0.0', hostPort: Number(b), containerPort: Number(a), protocol: 'tcp' }
}
```

```ts solution
export interface PortMapping {
  hostIp: string
  hostPort: number | null
  containerPort: number
  protocol: 'tcp' | 'udp'
}

export function parsePort(spec: string): PortMapping {
  let protocol: 'tcp' | 'udp' = 'tcp'
  let rest = spec
  const slash = spec.indexOf('/')
  if (slash !== -1) {
    protocol = spec.slice(slash + 1) === 'udp' ? 'udp' : 'tcp'
    rest = spec.slice(0, slash)
  }
  const parts = rest.split(':')
  let hostIp = '0.0.0.0'
  let host = ''
  let container: string
  if (parts.length === 1) {
    container = parts[0]
  } else if (parts.length === 2) {
    host = parts[0]
    container = parts[1]
  } else {
    hostIp = parts[0]
    host = parts[1]
    container = parts[2]
  }
  return {
    hostIp,
    hostPort: host === '' ? null : Number(host),
    containerPort: Number(container),
    protocol,
  }
}
```

```ts tests
test('host:container', () => {
  expect(parsePort('8080:80')).toEqual({ hostIp: '0.0.0.0', hostPort: 8080, containerPort: 80, protocol: 'tcp' })
})
test('bound to localhost', () => {
  expect(parsePort('127.0.0.1:5432:5432')).toEqual({ hostIp: '127.0.0.1', hostPort: 5432, containerPort: 5432, protocol: 'tcp' })
})
test('container port only → random host port', () => {
  expect(parsePort('80')).toEqual({ hostIp: '0.0.0.0', hostPort: null, containerPort: 80, protocol: 'tcp' })
})
test('localhost with random port', () => {
  expect(parsePort('127.0.0.1::3000')).toEqual({ hostIp: '127.0.0.1', hostPort: null, containerPort: 3000, protocol: 'tcp' })
})
test('udp', () => {
  expect(parsePort('5353:53/udp')).toEqual({ hostIp: '0.0.0.0', hostPort: 5353, containerPort: 53, protocol: 'udp' })
})
test('explicit tcp', () => {
  expect(parsePort('3000:8080/tcp')).toEqual({ hostIp: '0.0.0.0', hostPort: 3000, containerPort: 8080, protocol: 'tcp' })
})
```
:::

## Lab

:::lab id=ops-02-lab1 xp=100
title: A disposable Postgres 18 and an nginx you can poke
**Part A — nginx.**

```bash
docker run -d --name web -p 127.0.0.1:8080:80 nginx:1.30-alpine
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -s localhost:8080 | head -n 4
```

Expected: a row `web  Up … 127.0.0.1:8080->80/tcp` and the start of the "Welcome to nginx!" HTML.
(`1.30-alpine` pins the nginx version, so this lab behaves the same next month. Here we use the
official image, which runs as root on port 80, because poking around inside it is the point. The
images you *ship* from lesson 4 on use the non-root `nginxinc/nginx-unprivileged` variant on port
8080.)
Now change the page from *inside* the container and read the access log:

```bash
docker exec web sh -c 'echo "<h1>Hello from a container</h1>" > /usr/share/nginx/html/index.html'
curl -s localhost:8080
docker logs --tail 3 web
```

The access log lines appear in `docker logs` because the nginx image symlinks its log files to
`/dev/stdout` and `/dev/stderr`. Now prove the change lives only in that container:

```bash
docker rm -f web
docker run -d --name web -p 127.0.0.1:8080:80 nginx:1.30-alpine
curl -s localhost:8080 | grep -o '<title>.*</title>'   # <title>Welcome to nginx!</title> again
docker rm -f web
```

**Part B — Postgres 18 for development.**

:::warn
If you already run a Postgres on your machine, port 5432 is taken ("port is already allocated" or
"address already in use"). Use `-p 127.0.0.1:5433:5432` and port 5433 below.
:::

```bash
docker run -d --name devpg \
  -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=app \
  -p 127.0.0.1:5432:5432 \
  -v devpg-data:/var/lib/postgresql \
  postgres:18

docker logs -f devpg     # watch the first start, then Ctrl+C (stops following, not the container)
```

On the **first** start the image initialises the database: you'll see "database system is ready to
accept connections" *twice* — once for a temporary server used to create the `app` database, and
again after `PostgreSQL init process complete; ready for start up.` Wait for that second one.

Run SQL with the `psql` that ships *inside* the image — no client install needed:

```bash
docker exec -it devpg psql -U postgres -d app -c 'SELECT version();'
docker exec -it devpg psql -U postgres -d app \
  -c 'CREATE TABLE notes(id serial PRIMARY KEY, body text);' \
  -c "INSERT INTO notes(body) VALUES ('survives container removal');"
```

Now destroy the container and create a brand-new one on the same volume:

```bash
docker rm -f devpg
docker run -d --name devpg \
  -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=app \
  -p 127.0.0.1:5432:5432 \
  -v devpg-data:/var/lib/postgresql \
  postgres:18
until docker exec devpg pg_isready -U postgres -q; do sleep 1; done   # wait until it accepts connections
docker exec -it devpg psql -U postgres -d app -c 'SELECT * FROM notes;'
```

This time the logs show no init process: the entrypoint found an existing data directory and simply
started the server on it.

Expected:

```text
 id |            body
----+----------------------------
  1 | survives container removal
(1 row)
```

Inspect what Docker knows, then look at disk usage:

```bash
docker inspect -f '{{range .Mounts}}{{.Type}} {{.Name}} -> {{.Destination}}{{end}}' devpg
docker exec devpg sh -c 'echo $PGDATA'
docker system df
```

Expected: the mount is `volume devpg-data -> /var/lib/postgresql` and `PGDATA` is
`/var/lib/postgresql/18/docker`. In `docker system df`, the **Local Volumes** line now includes the
Postgres data.

**Optional:** connect from your favourite GUI (DBeaver, DataGrip, Rider) or your ASP.NET Core app with
`Host=localhost;Port=5432;Database=app;Username=postgres;Password=devpass`.

**Clean up** (keep the volume if you want to reuse the database):

```bash
docker rm -f devpg
docker volume ls
# docker volume rm devpg-data   # only when you really want to wipe the data
```

- [ ] I reached nginx on `localhost:8080` and saw its access log with `docker logs`
- [ ] I saw that the edited page was gone after recreating the container
- [ ] `psql` inside the container printed PostgreSQL 18
- [ ] My `notes` row survived `docker rm -f devpg` thanks to the named volume
- [ ] `docker inspect` showed the volume mounted at `/var/lib/postgresql`
- [ ] I know which `docker system df` line would grow if I forgot to clean up
:::

:::pro title="How teams actually run dev databases"
Hand-typed `docker run` commands get copy-pasted wrong. Within a week, most teams move this into a
`compose.yaml` checked into the repo (lesson 5), so `docker compose up -d db` gives every developer the
same Postgres version, extensions, and init scripts.
:::

:::cards id=ops-02-cards1 xp=15 title="Docker CLI"
Q: `-d`, `-it`, `--rm`?
A: Detached (background) · interactive + TTY (shell) · delete the container when it exits.
Q: Order of `-p 8080:80`?
A: HOST:CONTAINER — host port 8080 forwards to container port 80.
Q: Why bind dev databases to 127.0.0.1?
A: Docker's port rules bypass host firewalls like ufw; `-p 5432:5432` exposes the port on all interfaces.
Q: `docker run` vs `docker exec`?
A: `run` creates a new container from an image; `exec` runs an extra process in an existing running container.
Q: Where does `docker logs` get its output?
A: From the stdout/stderr of the container's main process.
Q: Exit code 137?
A: SIGKILL (128+9) — often the OOM killer; check `.State.OOMKilled`.
Q: What does `docker stop` do?
A: Sends SIGTERM, waits 10 seconds (default), then SIGKILL.
Q: How do you change the env vars of an existing container?
A: You can't — remove it and `docker run` again. Keep data in volumes so that's painless.
Q: Where does postgres:18 want its volume?
A: `/var/lib/postgresql` (data in `/var/lib/postgresql/18/docker`). ≤17 used `/var/lib/postgresql/data`.
Q: `docker volume prune` vs `docker volume prune -a`?
A: Without `-a` only unused anonymous volumes; with `-a` also unused named volumes (your data!).
Q: You changed `POSTGRES_PASSWORD` but the old password still works. Why?
A: Init env vars only apply when the data directory is empty; an existing volume keeps its users and passwords.
:::

## Recap

- A container lives as long as its PID 1. `run` = create + start; `stop` = SIGTERM → wait → SIGKILL.
- Publish ports with `-p HOST:CONTAINER`; apps inside must listen on `0.0.0.0`; bind dev services to
  `127.0.0.1` on the host side.
- Debug with `ps -a`, `logs`, `inspect`, `exec`. Exit code 137 = killed.
- Configuration goes in env vars (`__` for nested ASP.NET Core keys). You recreate containers to change it.
- `docker system df` and the `prune` family keep your disk alive — but volumes are data.
- `postgres:18` + named volume at `/var/lib/postgresql` = a dev database in one command. Its
  `POSTGRES_*` init variables only take effect on an empty volume.
