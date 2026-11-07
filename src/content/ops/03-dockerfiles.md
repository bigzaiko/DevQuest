---
id: ops-03
title: Writing Dockerfiles
level: beginner
minutes: 50
xp: 120
summary: Every core instruction, exec vs shell form, CMD vs ENTRYPOINT, the layer cache and how to order a Dockerfile so rebuilds take seconds.
---

A **Dockerfile** is a recipe that turns a *build context* (a folder of files) into an image. Each
instruction is executed in order by **BuildKit** (the build engine behind `docker build`), and most
instructions produce a new layer or a new bit of image metadata.

```text
  your folder (build context)          Dockerfile                      image
  ┌─────────────────────┐     ┌──────────────────────────┐     ┌──────────────────┐
  │ package.json        │     │ FROM node:24-alpine      │ ──▶ │ base layers      │
  │ package-lock.json   │ ──▶ │ WORKDIR /app             │ ──▶ │ (dir metadata)   │
  │ server.js           │     │ COPY package*.json ./    │ ──▶ │ layer: 2 files   │
  │ node_modules/  ✗    │     │ RUN npm ci               │ ──▶ │ layer: deps      │
  │ .git/          ✗    │     │ COPY . .                 │ ──▶ │ layer: your code │
  └─────────────────────┘     │ CMD ["node","server.js"] │ ──▶ │ config: cmd      │
     ✗ = excluded by           └──────────────────────────┘     └──────────────────┘
       .dockerignore
```

## The instructions you need

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
# the image's "node" user, referenced by its UID
USER 1000
CMD ["node", "server.js"]
```

| Instruction | What it does | Layer? |
|---|---|---|
| `# syntax=docker/dockerfile:1` | Parser directive: use the latest stable Dockerfile frontend (heredocs, `--mount`, …) | — |
| `FROM image` | Start from a base image. Everything else stacks on top. | base layers |
| `WORKDIR /app` | `cd` for all following instructions *and* the container's start dir. Creates it if missing. | tiny |
| `COPY src dest` | Copy files from the **build context** into the image | **yes** |
| `RUN cmd` | Execute a command at **build time**, snapshot the filesystem changes | **yes** |
| `ENV K=v` | Set an env var for later build steps **and** for the running container | metadata |
| `ARG K=v` | A **build-time-only** variable (`--build-arg K=…`) | metadata |
| `EXPOSE 3000` | *Documents* the port the app listens on. Publishes nothing. | metadata |
| `USER 1000` | Run following steps and the container as this user (a name like `node` works too, but a numeric UID is what Kubernetes can verify — lesson 7) | metadata |
| `CMD [...]` | Default command (or default args to `ENTRYPOINT`) | metadata |
| `ENTRYPOINT [...]` | The executable the container always runs | metadata |

A few more you'll see: `ADD` (like `COPY` but can fetch URLs and auto-extract local tarballs — prefer
`COPY` unless you need that), `LABEL` (metadata like `org.opencontainers.image.source`), `HEALTHCHECK`
and `STOPSIGNAL` (lesson 7), `SHELL`, `VOLUME`, `ONBUILD`.

:::tip title="RUN happens at build time, CMD at run time"
`RUN npm ci` executes once, when the image is built, and its result is frozen into a layer. `CMD`
is only stored in the image config and executes every time a container starts. Mixing these up is the
#1 beginner mistake ("why does my migration run during `docker build`?").
:::

## Exec form vs shell form

`RUN`, `CMD` and `ENTRYPOINT` accept two syntaxes:

```dockerfile
CMD ["node", "server.js"]        # exec form: JSON array, executed directly
CMD node server.js               # shell form: wrapped as /bin/sh -c "node server.js"
```

| | Exec form `["a","b"]` | Shell form `a b` |
|---|---|---|
| Who is PID 1 | your process | `/bin/sh` (your app is its child, unless the shell happens to `exec` it) |
| Does `docker stop`'s SIGTERM reach your app? | yes, directly — but your app must still *handle* it (see the box below) | not guaranteed — may wait 10 s and get SIGKILLed |
| `$VAR` expansion, pipes, `&&` | no (no shell!) | yes |
| Needs `/bin/sh` in the image | no (works on distroless) | yes |

Why does "who is PID 1" matter? `docker stop` (and Kubernetes, when it scales down or rolls out a new
version) sends **SIGTERM to PID 1 only**, as a polite "please shut down". A shell like `/bin/sh`
doesn't forward that signal to its child, so your app never hears it, Docker waits out the 10-second
grace period and then SIGKILLs everything — open requests are cut off and the container exits with
137 instead of shutting down cleanly.

Exec form solves *delivery*, not *handling*: the signal now reaches your app, and what happens next
is up to the app. That's the next box, and lesson 7 covers graceful shutdown end to end.

**Rule of thumb:** shell form is fine and convenient for `RUN` (you want `&&` and `$VAR` there).
Use **exec form for `CMD` and `ENTRYPOINT`**, always. If you need shell features at startup, write an
entrypoint script that ends with `exec "$@"` (or `exec node server.js`) so your app *replaces* the
shell as PID 1.

:::info title="PID 1 is special, even in exec form"
The Linux kernel doesn't apply default signal actions to PID 1: a signal the process hasn't installed
a handler for is simply ignored. ASP.NET Core handles SIGTERM out of the box. A plain Node script
does **not** — `node server.js` as PID 1 ignores `docker stop` until the SIGKILL. Either handle it
(`process.on('SIGTERM', () => server.close())`) or start the container with `docker run --init`, which
puts a tiny init process (tini) in front of your app as PID 1 to forward signals.
:::

:::warn title="JSON means double quotes"
`CMD ['node', 'server.js']` with single quotes is *not* valid JSON, so Docker treats the whole line as
**shell form** — the build succeeds (BuildKit at most prints a lint warning), and only at container
start does `sh` try to run a command literally named `['node',`. Always double quotes.
:::

## CMD vs ENTRYPOINT

Think of it as **ENTRYPOINT = the program, CMD = its default arguments**.

```dockerfile
ENTRYPOINT ["dotnet", "Api.dll"]
CMD ["--urls", "http://+:8080"]
```

| You run | Final command |
|---|---|
| `docker run api` | `dotnet Api.dll --urls http://+:8080` |
| `docker run api --help` | `dotnet Api.dll --help` (args after the image **replace CMD**) |
| `docker run --entrypoint sh -it api` | `sh` (override the entrypoint explicitly) |

The full interaction table (from the Docker docs) boils down to:

| | No ENTRYPOINT | `ENTRYPOINT ["ep","x"]` | `ENTRYPOINT ep x` (shell) |
|---|---|---|---|
| No CMD | error / base image's | `ep x` | `/bin/sh -c "ep x"` |
| `CMD ["c","y"]` | `c y` | `ep x c y` | `/bin/sh -c "ep x"` — **CMD ignored** |
| `CMD c y` (shell) | `/bin/sh -c "c y"` | `ep x /bin/sh -c "c y"` | `/bin/sh -c "ep x"` |

Typical usage: app images use only `CMD` (easy to override for debugging) **or** `ENTRYPOINT` for the
binary + `CMD` for default flags. .NET images commonly use `ENTRYPOINT ["dotnet", "Api.dll"]`.

:::quiz id=ops-03-q1 xp=10
An image has `ENTRYPOINT ["python", "app.py"]` and `CMD ["--port", "80"]`. What runs with
`docker run myimg --port 9000`?
- [ ] `--port 9000`
- [x] `python app.py --port 9000`
- [ ] `python app.py --port 80 --port 9000`
- [ ] `python app.py --port 80`
> `CMD` only supplies *default* arguments that get appended to `ENTRYPOINT`. Arguments after the image name **replace** `CMD` completely (they are not added to it), so the result is `python app.py --port 9000`. `--port 80 --port 9000` is the tempting answer if you think of it as "appending"; `--port 9000` alone would only happen if you overrode the entrypoint too.
:::

:::quiz id=ops-03-q2 xp=10
Which line is **wrong**?

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm ci
CMD ['node', 'server.js']
```

- [ ] `WORKDIR /app` — it must be created with `RUN mkdir` first
- [ ] `RUN npm ci` — RUN can't run npm
- [x] `CMD ['node', 'server.js']` — single quotes aren't JSON, so it becomes shell form and breaks
- [ ] `COPY . .` — the destination can't be `.`
> With single quotes the exec-form (JSON) parse fails and Docker falls back to shell form, running `/bin/sh -c "['node', 'server.js']"` — the build succeeds, the container fails at start with "not found". `WORKDIR` creates the directory itself, no `mkdir` needed; `RUN` can run any program in the image, npm included; and `COPY . .` (copy the context into the current `WORKDIR`) is perfectly valid. Copying everything *before* `npm ci` is a *performance* problem — see the next section — but not an error.
:::

:::quiz id=ops-03-q6 xp=10
An image `FROM node:24-bookworm-slim` ends with `CMD node migrate.js && node server.js` (shell
form). The API handles SIGTERM correctly. What do you observe on `docker stop api`?
- [ ] The API shuts down gracefully within a second
- [x] It takes about 10 seconds and the container exits with code 137
- [ ] `docker stop` fails because the shell is PID 1
- [ ] The migration runs again before shutdown
> Shell form wraps the line as `/bin/sh -c "node migrate.js && node server.js"`. Debian's `/bin/sh` (dash) stays alive as PID 1 and runs `node server.js` as its child. SIGTERM goes to the shell, which doesn't forward it, so after the 10-second grace period Docker sends SIGKILL → 137 (128 + 9). Your SIGTERM handler is tempting to rely on, but it never runs — the signal never reaches the app. Fix: an entrypoint script that runs the migration and then `exec node server.js` (or, better, run migrations as a separate job). (BusyBox `sh` on Alpine happens to `exec` the last command of the string, so on `node:24-alpine` this exact line may stop cleanly. That is a shell implementation detail you should not rely on: add `|| echo crashed` and every shell has to stay PID 1.)
:::

## The layer cache — the most important performance concept

When you rebuild, BuildKit walks the instructions top to bottom and asks for each: *"Do I already have
a layer produced by exactly this instruction on exactly this parent?"*

- For `RUN`, the cache key is the **instruction text** (+ the parent layer). BuildKit does *not* know
  that `apt-get update` would fetch something new today.
- For `COPY` / `ADD`, the key also includes a **checksum of the copied files' contents** (and
  metadata). Change one byte in one copied file and the step misses.
- **Once one step misses the cache, every step after it is rebuilt.** Layers are built on top of their
  parent; a new parent means new children.

```text
Bad order                                Good order
──────────────────────────────────       ──────────────────────────────────
FROM node:24-alpine         CACHED       FROM node:24-alpine         CACHED
WORKDIR /app                CACHED       WORKDIR /app                CACHED
COPY . .                    ✗ MISS       COPY package*.json ./       CACHED  (deps unchanged)
RUN npm ci       (60 s)     rebuilt      RUN npm ci       (60 s)     CACHED
CMD [...]                   rebuilt      COPY . .                    ✗ MISS  (server.js changed)
                                         CMD [...]                   rebuilt
→ every code change reinstalls deps      → code changes rebuild in ~1 s
```

**Order instructions from least to most frequently changing.** Base image → system packages →
dependency manifests → dependency install → source code → build. This "copy the manifest first"
trick works for every ecosystem:

| Stack | Copy first | Then run |
|---|---|---|
| Node | `package.json`, `package-lock.json` | `npm ci` |
| .NET | `*.csproj`, `*.sln`, `Directory.Packages.props`, `NuGet.config` | `dotnet restore` |
| Python | `requirements.txt` / `pyproject.toml` + lock | `pip install` / `uv sync` |

:::warn title="The stale apt cache trap"
```dockerfile
RUN apt-get update
RUN apt-get install -y curl
```
Months later you add a package to the second line. The first line is still **cached** (same text), so
`install` runs against an ancient package index and fails with 404s. Always combine them:
`RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*`.
:::

:::quiz id=ops-03-q3 xp=15
With the **good order** above, which of these changes cause `RUN npm ci` to run again? (select all that apply)
- [ ] Editing `server.js`
- [x] Adding a dependency (changes `package.json` and `package-lock.json`)
- [x] Changing `FROM node:24-alpine` to `FROM node:22-alpine`
- [ ] Editing `README.md`
- [x] Editing the `RUN npm ci` line to `RUN npm ci --omit=dev`
> `npm ci` reruns if its own text changes or any step *before* it misses (the base image, or the copied manifests). Source files are copied *after* it, so they can't affect it.
:::

## `.dockerignore` and the build context

```bash
docker build -t myapp:1.0 .
#                         ^ the build context: this folder
```

The last argument is the **build context** — the files BuildKit is *allowed* to `COPY`. `COPY` source
paths are resolved inside it, and you can't escape it: `COPY ../secrets .` does not reach the parent
folder, it fails with "not found". `-f` lets the Dockerfile live elsewhere:
`docker build -f docker/api.Dockerfile ./src` uses `./src` as the context.

A **`.dockerignore`** file in the root of the context excludes files, with `.gitignore`-like syntax:

```text
# .dockerignore
node_modules
dist
.git
.env
.env.*
!.env.example
*.log
**/bin
**/obj
.vscode
.idea
Dockerfile*
compose*.yaml
```

Why it matters — three separate reasons:

1. **Correctness.** Your host's `node_modules` (built for macOS, maybe) or .NET `bin/obj` folders would
   be copied over the ones built inside the image and break things in confusing ways.
2. **Cache hits.** Without ignoring `.git`, every commit changes `.git/` and busts `COPY . .`.
3. **Security.** `.env` files and keys copied into an image are readable by anyone who pulls it.

:::quiz id=ops-03-q4 xp=10
Your Dockerfile does `COPY . .` near the end, and there is **no** `.dockerignore`. You run
`git commit` (no file changes, just the commit) and rebuild. What happens?
- [ ] Everything is cached
- [x] `COPY . .` misses the cache, because files inside `.git/` changed
- [ ] The build fails because `.git` can't be copied
- [ ] Only the `FROM` step reruns
> `COPY . .` checksums every file in the context, including `.git/`. A commit writes new objects and moves `HEAD` there → cache miss → everything after it rebuilds, even though no source file changed. "Everything is cached" is the tempting answer if you only think about *your* files. Copying `.git` doesn't fail — it just works, which is worse: your full git history is now inside the image.
:::

## ARG vs ENV

```dockerfile
ARG NODE_VERSION=24
# ARG before FROM: only usable in FROM lines
FROM node:${NODE_VERSION}-alpine

# must be (re)declared after FROM to be used below
ARG APP_VERSION=dev
# bake it into the image as an env var
ENV APP_VERSION=${APP_VERSION}
RUN echo "building ${APP_VERSION}"
```

```bash
docker build --build-arg APP_VERSION=1.4.2 -t myapp:1.4.2 .
```

| | `ARG` | `ENV` |
|---|---|---|
| Available during build | yes (after it's declared) | yes |
| Available in the running container | **no** | **yes** |
| Set from the command line | `--build-arg` | `docker run -e` (at run time) |
| Scope | until the end of the current stage | inherited by everything built `FROM` this image |

BuildKit also predefines platform ARGs (`TARGETPLATFORM`, `TARGETARCH`, `BUILDPLATFORM`…) — you'll
use them for multi-arch builds in lesson 8.

:::warn title="Neither ARG nor ENV is for secrets"
ENV values are stored in the image config (`docker inspect` shows them), and ARG values used in a
`RUN` are recorded in `docker history`. Build secrets go through `RUN --mount=type=secret` (lesson 7).
:::

:::quiz id=ops-03-q7 xp=10
Spot the bug. The build runs with `--build-arg APP_VERSION=2.0.0`, but the log prints `building v`.

```dockerfile
ARG APP_VERSION=dev
FROM node:24-alpine
RUN echo "building v${APP_VERSION}"
```

- [ ] `--build-arg` only works for args that have no default value
- [x] An `ARG` declared before `FROM` is only in scope for `FROM` lines; it must be redeclared (`ARG APP_VERSION`) after `FROM` to be used in `RUN`
- [ ] `RUN` needs exec form to expand variables
- [ ] Build args are only available in `ENV`, never in `RUN`
> Each `FROM` starts a new build stage, and args declared before the first `FROM` live *outside* every stage. A bare `ARG APP_VERSION` after `FROM` pulls the value (or its default) into the stage. Defaults are fine with `--build-arg` — the command line simply overrides them. And it's the other way round with exec form: shell-form `RUN` is the one that expands `${VAR}` via `/bin/sh`.
:::

## Tagging

`-t name:tag` names the result. You can pass several:

```bash
docker build -t myapp:1.4.2 -t myapp:1.4 -t myapp:latest .
docker tag myapp:1.4.2 ghcr.io/acme/myapp:1.4.2    # add a registry name for pushing
docker images myapp
```

Tags are just pointers to an image ID; all of the above point at the same bytes. Leaving out the tag
means `:latest`, which is just a *name*, not "the newest" — more about tag strategies in lesson 8.

## Simulate it: which steps get rebuilt?

:::challenge id=ops-03-c1 lang=ts xp=60
title: Predict the cache
Write `rebuiltSteps(steps, changed, opts)` that returns the **indices** of the steps BuildKit has to
rebuild.

- `steps[i].instruction` is the Dockerfile line, e.g. `"RUN npm ci"` or `"COPY package.json ./"`.
- `steps[i].sources` (only for `COPY`/`ADD`) lists source paths: a file (`"server.js"`), a directory
  (`"src"` or `"src/"`, matching everything below it) or `"."` (everything).
- `changed` lists files (relative paths) that changed in the build context since the last build.
- `opts.edited` (optional) lists step indices whose **instruction text** changed.
- `opts.ignore` (optional) are `.dockerignore` entries, matched with the same rules as `sources`.
  Ignored files never count as changes.

A step misses when it was edited, or it's a `COPY`/`ADD` whose sources match a (non-ignored) changed
file. After the first miss, **all later steps** are rebuilt too. Return `[]` when everything is cached.

hint: Write a helper `matches(path, pattern)`: `"."` matches all; otherwise strip a trailing `/` and check `path === p || path.startsWith(p + '/')`.
hint: Find the first missing index, then return every index from there to the end.

```ts starter
export interface Step { instruction: string; sources?: string[] }

export function rebuiltSteps(
  steps: Step[],
  changed: string[],
  opts: { edited?: number[]; ignore?: string[] } = {},
): number[] {
  // Forgets that a miss invalidates every later step
  return steps
    .map((s, i) => (s.sources?.some((src) => changed.includes(src)) ? i : -1))
    .filter((i) => i !== -1)
}
```

```ts solution
export interface Step { instruction: string; sources?: string[] }

function matches(path: string, pattern: string): boolean {
  if (pattern === '.' || pattern === './') return true
  const p = pattern.replace(/\/+$/, '')
  return path === p || path.startsWith(p + '/')
}

export function rebuiltSteps(
  steps: Step[],
  changed: string[],
  opts: { edited?: number[]; ignore?: string[] } = {},
): number[] {
  const edited = opts.edited ?? []
  const ignore = opts.ignore ?? []
  const relevant = changed.filter((f) => !ignore.some((pat) => matches(f, pat)))
  const first = steps.findIndex((s, i) => {
    if (edited.includes(i)) return true
    const isCopy = /^(COPY|ADD)\b/i.test(s.instruction.trim())
    return isCopy && (s.sources ?? []).some((src) => relevant.some((f) => matches(f, src)))
  })
  if (first === -1) return []
  return steps.map((_, i) => i).filter((i) => i >= first)
}
```

```ts tests
const good: Step[] = [
  { instruction: 'FROM node:24-alpine' },
  { instruction: 'WORKDIR /app' },
  { instruction: 'COPY package.json package-lock.json ./', sources: ['package.json', 'package-lock.json'] },
  { instruction: 'RUN npm ci' },
  { instruction: 'COPY . .', sources: ['.'] },
  { instruction: 'CMD ["node","server.js"]' },
]
const bad: Step[] = [
  { instruction: 'FROM node:24-alpine' },
  { instruction: 'WORKDIR /app' },
  { instruction: 'COPY . .', sources: ['.'] },
  { instruction: 'RUN npm ci' },
  { instruction: 'CMD ["node","server.js"]' },
]
test('nothing changed → all cached', () => {
  expect(rebuiltSteps(good, [])).toEqual([])
})
test('code change with good order keeps npm ci cached', () => {
  expect(rebuiltSteps(good, ['server.js'])).toEqual([4, 5])
})
test('dependency change reruns npm ci and everything after', () => {
  expect(rebuiltSteps(good, ['package-lock.json'])).toEqual([2, 3, 4, 5])
})
test('code change with bad order reinstalls deps', () => {
  expect(rebuiltSteps(bad, ['server.js'])).toEqual([2, 3, 4])
})
test('editing the base image rebuilds everything', () => {
  expect(rebuiltSteps(good, [], { edited: [0] })).toEqual([0, 1, 2, 3, 4, 5])
})
test('.dockerignore entries never bust the cache', () => {
  expect(rebuiltSteps(bad, ['.git/index', 'README.md'], { ignore: ['.git', 'README.md'] })).toEqual([])
})
test('a directory source matches files below it', () => {
  const steps: Step[] = [
    { instruction: 'FROM mcr.microsoft.com/dotnet/sdk:10.0' },
    { instruction: 'COPY src/Api/Api.csproj src/Api/', sources: ['src/Api/Api.csproj'] },
    { instruction: 'RUN dotnet restore src/Api' },
    { instruction: 'COPY src/ src/', sources: ['src/'] },
    { instruction: 'RUN dotnet publish src/Api -o /out' },
  ]
  expect(rebuiltSteps(steps, ['src/Api/Program.cs'])).toEqual([3, 4])
  expect(rebuiltSteps(steps, ['docs/readme.md'])).toEqual([])
})
```
:::

## Lab: build, break and fix the cache

:::lab id=ops-03-lab1 xp=100
title: Your first image — and a 1-second rebuild
You need Docker and Node.js (any recent LTS) on your machine.

**1. Create a tiny Express app.**

```bash
mkdir hello-docker && cd hello-docker
npm init -y
npm install express@5
```

Create `server.js`:

```js
const express = require('express')

const app = express()
const port = Number(process.env.PORT ?? 3000)

app.get('/', (req, res) => {
  res.json({ message: process.env.GREETING ?? 'hello', version: process.env.APP_VERSION })
})

const server = app.listen(port, '0.0.0.0', () => console.log(`listening on ${port}`))

// Exec form delivers SIGTERM to us as PID 1 — but PID 1 ignores signals it has no handler for.
// Handle it: stop accepting connections, let in-flight requests finish, then exit 0.
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down')
  server.close(() => process.exit(0))
})
```

Note the `'0.0.0.0'`: from lesson 2 you know a server bound to `127.0.0.1` would be unreachable
through `-p`.

**2. Write a deliberately badly ordered `Dockerfile`:**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
COPY . .
RUN npm ci --omit=dev
CMD ["node", "server.js"]
```

Build it twice — the second time everything is `CACHED`:

```bash
docker build -t hello:bad .
docker build -t hello:bad .
```

Now change the message in `server.js` (e.g. `'hello'` → `'hi'`) and build again. Watch the output:
`COPY . .` is no longer cached, so `RUN npm ci` runs again. Also notice that your host's
`node_modules` was copied into the context — check the line
`transferring context: …` and its size.

**3. Fix it.** Add `.dockerignore`:

```text
node_modules
npm-debug.log
.git
.env
Dockerfile
.dockerignore
```

And reorder the `Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

EXPOSE 3000
USER 1000
CMD ["node", "server.js"]
```

```bash
docker build -t hello:1.0 --build-arg APP_VERSION=1.0.0 .
```

Change `server.js` again and rebuild. Expected: the `npm ci` line now says **`CACHED`** and the
build finishes in about a second.

```text
 => CACHED [3/5] COPY package.json package-lock.json ./
 => CACHED [4/5] RUN npm ci --omit=dev
 => [5/5] COPY . .
```

**4. Run it and override things.**

```bash
docker run -d --name hello -p 127.0.0.1:3000:3000 -e GREETING=moin hello:1.0
curl -s localhost:3000            # {"message":"moin","version":"1.0.0"}
docker exec hello whoami          # node   (UID 1000 is called "node" in the image's /etc/passwd)
docker run --rm hello:1.0 node -e 'console.log(process.version)'   # args replace CMD → v24.x.x
time docker stop hello            # well under a second, thanks to the SIGTERM handler
docker logs hello | tail -n 1     # SIGTERM received, shutting down
docker rm hello
```

**5. Look at what you built.**

```bash
docker history hello:1.0
docker image inspect hello:1.0 -f '{{.Config.Cmd}} {{.Config.User}} {{.Config.Env}}'
docker images hello
```

The history shows one row per instruction; `COPY` and `RUN` rows have sizes, `ENV`/`CMD`/`USER` are
`0B` metadata. Compare the sizes of `hello:bad` and `hello:1.0`.

Expected: `hello:bad` is a few MB larger. Its `COPY . .` layer still contains your host
`node_modules`. `npm ci` deletes that folder in the next layer, but a later layer can only *hide*
files, not remove them from the image. Find that `COPY` row's size in `docker history hello:bad`.

:::tip
If `npm ci` fails with "package-lock.json not found", you skipped `npm install` in step 1 — `npm ci`
requires a lock file. That's intentional: reproducible builds.
:::

- [ ] I saw a code change re-run `npm ci` with the bad ordering
- [ ] After adding `.dockerignore` and reordering, a code change rebuilt in ~1 second with `npm ci` CACHED
- [ ] `curl localhost:3000` returned my `GREETING` and `APP_VERSION`
- [ ] `docker exec hello whoami` printed `node`
- [ ] `docker stop hello` returned in well under 10 seconds, and the log shows the SIGTERM handler ran
- [ ] I can explain why `ENV` shows up in `docker image inspect` but `ARG` alone would not
:::

:::pro title="Pin, lint and update — automatically"
Seniors pin base images more precisely than `node:24-alpine` — e.g. `node:24.11-alpine3.22`, or even
by digest (`node:24-alpine@sha256:…`), so the same Dockerfile builds the same image next month. Pinning
alone means you stop getting security patches, so pair it with **Renovate** or **Dependabot** opening
PRs when a new base image is published. Add `docker build --check .` (BuildKit's built-in Dockerfile
checks: shell-form `CMD`, undefined `ARG`s, casing mistakes …) or **hadolint** to CI, and most of the
review comments below never need to be written by a human.
:::

:::job title="What code review will flag in your Dockerfile"
Unpinned or `:latest` base images; `COPY . .` before dependency install; no `.dockerignore`; `apt-get
update` in its own `RUN`; shell-form `CMD`; running as root; secrets in `ENV`/`ARG`; and `ADD` where
`COPY` would do. Teams often run **hadolint** (a Dockerfile linter) in CI to catch these automatically.
:::

:::quiz id=ops-03-q5 xp=10
What does `EXPOSE 8080` in a Dockerfile do?
- [ ] Publishes port 8080 on the host
- [ ] Makes the app listen on 8080
- [x] Records in the image metadata that the app is expected to listen on 8080
- [ ] Opens port 8080 in the host firewall
> It's documentation for humans and tools (it's also used by `docker run -P`, which publishes all exposed ports to random host ports). The tempting "publishes port 8080" is wrong: only `-p`/`-P` at `docker run` time publish anything. And the *app* decides where it listens — `EXPOSE 8080` on an app that listens on 3000 is just a wrong label.
:::

:::cards id=ops-03-cards1 xp=15 title="Dockerfile essentials"
Q: RUN vs CMD?
A: RUN executes at build time and creates a layer. CMD is stored metadata, executed when a container starts.
Q: Exec form vs shell form?
A: Exec `["a","b"]` runs the binary directly as PID 1, so signals reach it (it must still handle them), no shell needed. Shell form wraps in `/bin/sh -c`.
Q: ENTRYPOINT + CMD?
A: ENTRYPOINT is the program; CMD supplies default arguments. Args after the image name replace CMD.
Q: How is a COPY step's cache key computed?
A: Instruction + parent layer + checksums of the copied files.
Q: What happens after the first cache miss?
A: Every following step is rebuilt.
Q: Why copy package.json / *.csproj before the source?
A: So the slow dependency install stays cached when only source code changes.
Q: Three reasons for .dockerignore?
A: Correctness (no host node_modules/bin/obj), cache hits (.git changes), security (.env, keys).
Q: ARG vs ENV?
A: ARG exists only at build time (--build-arg); ENV is baked into the image and visible at run time.
Q: Why `apt-get update && apt-get install` in one RUN?
A: A separate cached `update` layer goes stale; installs then fail or get old packages.
Q: What does EXPOSE do?
A: Documents the listening port in image metadata. It doesn't publish anything.
Q: Why does shell-form `CMD` make `docker stop` slow?
A: Usually `/bin/sh` stays PID 1 (Debian's dash even for a single command; any shell once the line needs to do something after your app, e.g. `|| echo`) and doesn't forward SIGTERM, so Docker SIGKILLs it after 10 s (exit 137). Exec form removes the guesswork.
Q: An `ARG` declared before `FROM` is empty in a `RUN`. Why?
A: Pre-`FROM` args are only in scope for `FROM` lines; redeclare `ARG NAME` inside the stage.
:::

## Recap

- A Dockerfile turns a **build context** into layers; `RUN`/`COPY` add layers, `ENV`/`CMD`/`USER`/`EXPOSE`
  add metadata.
- Use **exec form** for `CMD`/`ENTRYPOINT` so your app is PID 1 and SIGTERM reaches it — then *handle*
  it (ASP.NET Core does; plain Node needs `process.on('SIGTERM')`). ENTRYPOINT = program, CMD = default
  args, and args after the image name replace CMD.
- `USER` with a **numeric UID** (`USER 1000` for the Node images' `node` user) runs the app as non-root.
- Cache keys: instruction text (+ file checksums for `COPY`). After one miss, everything below rebuilds —
  so order from rarely to frequently changing, and copy dependency manifests first.
- `.dockerignore` protects correctness, cache and secrets.
- `ARG` = build time only, `ENV` = baked in. Neither is for secrets.
