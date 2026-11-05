---
id: ops-07
title: Image Security and Runtime Hardening
level: advanced
minutes: 40
xp: 200
summary: Non-root users, minimal bases, digest pinning, BuildKit secrets, scanning, SBOM and provenance, read-only containers, healthchecks — and why PID 1 decides whether your app shuts down gracefully.
---

A container image is software you ship to production, and it contains far more than your code: an OS
userland, a runtime, dozens of libraries. Security work on images is about three questions:

1. **What's inside?** — vulnerable packages, leaked secrets, tools an attacker could use.
2. **Can I trust where it came from?** — is `node:24-alpine` today the same thing it was yesterday? Was
   *our* image really built by *our* CI from *our* commit?
3. **What can it do when it runs?** — as root? with a writable filesystem? with all Linux capabilities?

## Run as non-root

By default, a container's process runs as **UID 0 — root**. Namespaces hide the host from it, but UID 0
inside is UID 0 outside (unless you use rootless Docker or user-namespace remapping). Combine that with
one of these and root in the container becomes root on the host:

- a kernel or runtime vulnerability (container escapes happen every year or two),
- a bind mount of a host directory (`-v /:/host`, `-v /var/run/docker.sock:…`),
- a `--privileged` flag someone added "to make it work".

Running as an unprivileged user turns most of those into non-events.

```dockerfile
# .NET (8+): the user "app" already exists; $APP_UID expands to its UID, 1654
USER $APP_UID

# Node official images: the user "node" exists — reference it by its UID, 1000
USER 1000

# Alpine, your own user
RUN addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
USER 10001:10001

# Debian/Ubuntu
RUN groupadd -g 10001 app && useradd -u 10001 -g app -M -s /usr/sbin/nologin app
USER 10001:10001
```

Consequences to plan for:

- Traditionally, non-root processes can't bind ports **below 1024**. Docker (20.10+) and containerd 2.x
  relax that inside containers, but you can't count on it on every runtime or cluster — so the
  convention is to listen on **8080** (that's why .NET 8 switched its default from 80). For nginx, use
  `nginxinc/nginx-unprivileged`, which runs as UID 101 and listens on 8080 — the web image you built
  in lesson 4 already does. The published or Service port can still be 80/443.
- Files the app writes at runtime must be in directories it owns (`chown` them in the Dockerfile, or
  mount a volume/tmpfs there).
- `COPY` creates files owned by root — fine for *reading*. Use `COPY --chown=10001:10001` only where the
  app must write.

:::job title="Kubernetes will check"
Clusters with Pod Security Standards ("restricted") require `runAsNonRoot: true`. The kubelet can only
verify that if the image's `USER` is **numeric** — `USER app` (or `USER node`) fails with *"image has
non-numeric user, cannot verify user is non-root"*. That's why every Dockerfile in this track uses a
number: `USER $APP_UID` (expands to 1654) for .NET, `USER 1000` for Node, `USER 10001` for your own
user, and the nginx-unprivileged base already sets `USER 101`. The name still works for humans —
`whoami` prints `node` — because `/etc/passwd` maps the number back.
:::

## Minimal base images

Every package in the image is something a scanner will flag, something you have to patch, and something
an attacker can use (`curl` to download tools, `sh` to run them).

| Base | Packages | Shell | Notes |
|---|---|---|---|
| `ubuntu` / `debian` | ~100+ | yes | familiar, glibc, biggest CVE list |
| `*-alpine` | ~15 | yes (busybox) | small; **musl** libc — rare compatibility/perf surprises |
| `*-chiseled` (Ubuntu), `gcr.io/distroless/*` | only what the runtime needs | **no** | best default for production .NET / Java / Node |
| `scratch` | nothing at all | no | fully static binaries only (Go with `CGO_ENABLED=0`, Rust on musl) |

A typical scan of `aspnet:10.0` might list dozens of low/medium CVEs in OS packages your app never
touches; the chiseled equivalent typically lists close to none. Triage time is real money.

Two things to know about the shell-less bases. **Debugging changes:** you can't `docker exec … sh` into a
chiseled container; use `docker debug` (Docker Desktop) or `kubectl debug -it <pod> --image=busybox --target=<container>`
to attach a toolbox container. `--target` is what makes it share the app container's process
namespace, so you can see and inspect the app process. **.NET Native AOT** produces a single executable but it
still links against glibc, so it doesn't run on `scratch` — use
`mcr.microsoft.com/dotnet/runtime-deps:10.0-noble-chiseled` instead, which contains just libc, OpenSSL
and friends.

## Pin your base images

Tags move. `postgres:18` will point at the next minor release (18.x+1) next quarter; someone could even re-push a tag maliciously.
Two levels of pinning:

```dockerfile
# fully specified tag: fewer surprises
FROM node:24.<minor>-alpine3.<n>
# digest: exactly these bytes, forever
FROM node:24-alpine@sha256:<64-hex-digest>
```

With a digest, the tag part is only a comment for humans — Docker resolves by digest. Find the current
digest with `docker buildx imagetools inspect node:24-alpine` (the top-level `Digest:` line — the
multi-platform index).

What this track uses: in lessons 1–8 every image is pinned **at the version level where breaking
changes happen** — `node:24-alpine`, `postgres:18`, `redis:8-alpine` (major versions; their minors
and patches are compatible) and `nginxinc/nginx-unprivileged:1.30-alpine` (nginx has been 1.x
forever, so its *minor* is the meaningful level). Never a bare `nginx:alpine` or `:latest`, which
can jump a version under you. That's the minimum for a tutorial; in a real repo, go one step further
and add the digest.

The trade-off: a pinned digest never gets security patches by itself. Teams combine pinning with a bot —
**Renovate** or **Dependabot** — that opens a PR whenever the upstream tag moves to a new digest. You get
reproducible builds *and* timely patches, with CI checking each bump.

## Secrets: never in the image

Anything in an image is readable by everyone who can pull it — forever, in every layer.

| Approach | Leaks? |
|---|---|
| `COPY .npmrc .` then `RUN rm .npmrc` | **yes** — still in the COPY layer |
| `ENV NUGET_TOKEN=…` | **yes** — in the image config, `docker inspect` |
| `ARG NUGET_TOKEN` + `--build-arg` | **yes** — recorded in `docker history` for the RUN that uses it |
| `RUN --mount=type=secret,…` | **no** — mounted only for that one RUN, never written to a layer |

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# .npmrc with a private registry token, available only during this RUN
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc -t web .
# or from an environment variable (CI):
docker build --secret id=nuget_token,env=NUGET_TOKEN -t api .
```

By default the secret appears at `/run/secrets/<id>`; `target=` puts it elsewhere, and `env=` (in the
`--mount`) can expose it as an env var for that RUN. For private Git dependencies there's
`RUN --mount=type=ssh` with `docker build --ssh default`.

**Runtime secrets** (connection strings, API keys) don't belong in the image either: they come from the
platform at run time — env vars injected from a secret store, or files. Compose has a `secrets:` element
that mounts files under `/run/secrets/`; Kubernetes has Secrets mounted as files or env vars. ASP.NET
Core can read a directory of files as configuration with
`builder.Configuration.AddKeyPerFile("/run/secrets", optional: true)` — each file name is a key (`__` in
the name becomes `:`), its content the value. Files are slightly safer than env vars: env vars show up
in `docker inspect`, in crash dumps and in child processes.

:::quiz id=ops-07-q1 xp=15
Which of these Dockerfile snippets leak the token into the final image or its metadata? (select all that apply)
- [x] `ENV GITHUB_TOKEN=ghp_abc` followed by `RUN npm ci`
- [x] `COPY .npmrc .` then `RUN npm ci && rm .npmrc`
- [x] `ARG GITHUB_TOKEN` then `RUN echo "//npm.pkg.github.com/:_authToken=$GITHUB_TOKEN" > .npmrc && npm ci && rm .npmrc`
- [ ] `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci`
> `ENV` is stored in the image config (`docker inspect` shows it). `COPY` writes the file into a layer, and the later `rm` only adds a "whiteout" on top — anyone can extract the earlier layer from the pulled image. The `ARG` version is the tempting "safe" one because the file is deleted in the same `RUN`, but BuildKit records the build-arg values used by each `RUN` in the image history (`docker history --no-trunc`). Only the secret mount keeps the token out: it exists in a tmpfs for that one `RUN` and is never part of a layer. (BuildKit even warns about the ENV/ARG patterns: `SecretsUsedInArgOrEnv`.)
:::

## Scanning, SBOMs and provenance

**Vulnerability scanners** compare the packages in your image (OS packages *and* language packages like
NuGet and npm) against CVE databases:

```bash
trivy image --severity HIGH,CRITICAL --ignore-unfixed ghcr.io/acme/api:1.4.2
docker scout cves ghcr.io/acme/api:1.4.2        # Docker's scanner (needs a Docker login)
grype ghcr.io/acme/api:1.4.2                     # Anchore's scanner
```

In CI the usual gate is *"fail on HIGH/CRITICAL that have a fix available"* (`--ignore-unfixed
--exit-code 1`): unfixable findings are tracked, not blocking. And scan **continuously** — an image that
was clean at build time gets new CVEs next month; registries and tools (ECR, ACR with Defender, Docker
Hub with Scout, Harbor) can rescan stored images, or you schedule a nightly scan job in CI.

An **SBOM** (Software Bill of Materials, SPDX or CycloneDX format) is the ingredient list of the image:
every package and version. When the next Log4Shell-style vulnerability drops, you query SBOMs instead of
rebuilding everything to find out where you're exposed.

**Provenance** is a signed statement of *how* the image was built: which repo, which commit, which CI
workflow, which build args. Together with **signing** (Sigstore **cosign**, Notation), it lets a cluster
refuse to run images that weren't built by your pipeline (supply-chain levels, "SLSA").

```bash
docker buildx build --sbom=true --provenance=mode=max -t ghcr.io/acme/api:1.4.2 --push .
docker buildx imagetools inspect ghcr.io/acme/api:1.4.2 --format '{{ json .SBOM }}'
```

BuildKit attaches both as **attestations** next to the image in the registry (lesson 8 wires this into
GitHub Actions).

## Runtime hardening

The image is only half the story; how you *run* it matters as much:

```bash
docker run -d --name api \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --memory=512m --cpus=1 --pids-limit=200 \
  -p 127.0.0.1:8080:8080 \
  api:1.0-chiseled
```

| Flag | Effect |
|---|---|
| `--read-only` | Root filesystem is read-only: an attacker can't drop binaries or modify your app |
| `--tmpfs /tmp` | …but give the app a RAM-backed scratch dir |
| `--cap-drop=ALL` | Remove all Linux capabilities (add back only what's needed with `--cap-add`) |
| `--security-opt=no-new-privileges` | setuid binaries can't escalate privileges |
| `--memory`, `--cpus`, `--pids-limit` | A bug (or fork bomb) can't starve the host |
| never `--privileged` | It disables almost every isolation feature |

What are **capabilities**? Linux splits root's powers into ~40 separate privileges — `CHOWN`,
`NET_RAW` (craft raw packets, e.g. for ARP spoofing), `SYS_ADMIN` (mount filesystems, almost root),
`NET_BIND_SERVICE` (ports < 1024)… Docker already drops the dangerous ones, but still grants about 14 by
default. A typical web API needs **none** of them, so `--cap-drop=ALL` costs nothing and removes tools an
attacker would love. If something breaks, add back the single capability it needs, not `--privileged`.

A common mistake: `--read-only` and the app crashes with *"Read-only file system"* because it writes to
`/app/logs` or a cache folder. Don't drop `--read-only` — give that one path a `--tmpfs` or a volume, and
log to stdout instead of files anyway.

The same in Compose:

```yaml
services:
  api:
    image: api:1.0-chiseled
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    cpus: 1
    pids_limit: 200
```

In Kubernetes these become the pod's `securityContext` (`readOnlyRootFilesystem`, `capabilities.drop`,
`allowPrivilegeEscalation: false`, `runAsNonRoot`).

## The HEALTHCHECK instruction

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/health || exit 1
```

Docker runs the command inside the container periodically; `docker ps` shows `(healthy)` /
`(unhealthy)`, Compose can wait on it, and Swarm restarts unhealthy tasks. Three caveats:

- It needs a tool in the image (`wget`/`curl`) — which minimal images deliberately don't have. Options:
  a tiny static health binary, or skip it and let the orchestrator probe.
- **Kubernetes ignores `HEALTHCHECK`** entirely; it uses liveness/readiness/startup **probes** defined
  in the pod spec, performed by the kubelet from outside.
- Plain `docker run` (without Swarm) only *reports* unhealthy; it doesn't restart the container.

## Signals, PID 1 and graceful shutdown

When Docker (or Kubernetes) stops a container:

```text
 docker stop ──▶ SIGTERM to PID 1 ──▶ [grace period: 10 s Docker, 30 s Kubernetes] ──▶ SIGKILL
                        │
                        └─ app should: stop accepting requests, finish in-flight work,
                           flush logs, close DB connections, exit 0
```

Two Linux facts make PID 1 special:

1. **The kernel doesn't apply default signal actions to PID 1.** For a normal process, an unhandled
   SIGTERM kills it. For PID 1, an unhandled SIGTERM is **ignored**. So a process that doesn't install a
   handler can't be stopped politely — you wait out the grace period and it gets SIGKILLed mid-request
   (exit code 137).
2. **PID 1 must reap zombies.** Orphaned child processes are re-parented to PID 1; if it never calls
   `wait()`, they pile up as zombies.

How each stack fares:

| PID 1 | SIGTERM handled? | Fix |
|---|---|---|
| `dotnet Api.dll` (exec form) | **yes** — the Generic Host triggers graceful shutdown | Align timeouts (below) |
| `node server.js` | no JS handler → **ignored** (Node's built-in default re-raises the signal, which PID 1 ignores) | `process.on('SIGTERM', …)` that closes the server, or `--init` |
| `npm start` | npm is PID 1, extra layer between signal and app | run `node` directly in `CMD` |
| `/bin/sh -c "…"` (shell form) | the shell may not forward it | exec form, or `exec` in scripts |
| `sleep`, shell scripts, many CLIs | no | `docker run --init` / Compose `init: true` (tini as PID 1) |

`--init` puts a tiny init (**tini**) at PID 1, which forwards signals to your process and reaps
zombies. `STOPSIGNAL SIGINT` in the Dockerfile changes which signal is sent, for apps that expect
another one.

:::warn title=".NET shutdown timeout vs Docker's grace period"
The .NET Generic Host waits up to `HostOptions.ShutdownTimeout` (**30 s** by default since .NET 6) for
hosted services and in-flight requests. `docker stop` only waits **10 s** before SIGKILL. Either raise
the grace period (`docker stop -t 30`, Compose `stop_grace_period: 30s`) or lower the .NET timeout
(`builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(8));`). In
Kubernetes, set `terminationGracePeriodSeconds` to match.
:::

:::quiz id=ops-07-q2 xp=10
An image ends with `CMD ["node", "server.js"]` and the code has no signal handlers. `docker stop`
takes exactly 10 seconds and the container exits with 137. Why?
- [ ] Node always takes 10 seconds to shut down
- [x] As PID 1, node ignores the unhandled SIGTERM; after the grace period Docker sends SIGKILL
- [ ] The exec form blocks signals
- [ ] `docker stop` always sends SIGKILL
> The kernel gives PID 1 no default signal actions: a signal without a registered handler is simply dropped. Node only installs a JavaScript-level handler if *you* call `process.on('SIGTERM', …)`, so the SIGTERM from `docker stop` does nothing; after the 10 s grace period Docker sends SIGKILL, and 137 = 128 + 9 (SIGKILL). The exec form is the tempting wrong answer, but it's actually what you *want* — it makes `node` PID 1 directly so it receives the signal; the shell form would be worse. `docker stop` sends SIGTERM first, SIGKILL only after the timeout. Fix: add `process.on('SIGTERM', () => server.close(() => process.exit(0)))`, or run with `--init`.
:::

:::quiz id=ops-07-q3 xp=10
Your Pod has `runAsNonRoot: true`. The image's Dockerfile ends with `USER app` (a user created with
`adduser`). The pod fails to start. Why?
- [ ] `adduser` creates root users by default
- [x] The kubelet can't verify a non-numeric user is non-root; use a numeric UID in `USER`
- [ ] Kubernetes doesn't support the `USER` instruction
- [ ] `runAsNonRoot` requires a distroless image
> The kubelet only sees the `User` field from the image config — it doesn't look inside the image's `/etc/passwd`, so a name like `app` could map to UID 0 for all it knows, and it refuses to start the container ("image has non-numeric user … cannot verify user is non-root"). `adduser` creates a normal unprivileged user, and Kubernetes honours `USER` fine — the problem is purely that it's a name. Fix: `USER 10001` in the Dockerfile, or `runAsUser: 10001` in the pod's `securityContext`. Distroless isn't required.
:::

:::quiz id=ops-07-q4 xp=10
Which statement about `HEALTHCHECK` is true?
- [ ] Kubernetes uses it as the liveness probe
- [ ] `docker run` restarts a container automatically when it becomes unhealthy
- [x] Docker runs the check command inside the container and reports the status; Compose can wait on it
- [ ] It works in chiseled images because Docker supplies `curl`
> Docker executes the `HEALTHCHECK` command inside the container and records `healthy`/`unhealthy`, and Compose's `condition: service_healthy` waits on exactly that status. The tempting "Kubernetes liveness probe" answer is wrong: Kubernetes ignores `HEALTHCHECK` completely and only uses probes from the pod spec. Plain `docker run` just *reports* unhealthy — even `--restart=always` restarts only on exit, not on unhealthy (Swarm does act on it). And Docker supplies no tools: if the image has no `curl`/`wget`, the check fails.
:::

:::quiz id=ops-07-q5 xp=10
You harden the API with `--read-only --cap-drop=ALL`. It now crashes at startup with
`System.IO.IOException: Read-only file system : '/app/cache/index.bin'`. What's the best fix?
- [ ] Remove `--read-only`; it's incompatible with .NET
- [ ] Add `--cap-add=SYS_ADMIN` so the app may write again
- [x] Keep `--read-only` and mount a writable `--tmpfs /app/cache` (or a volume if the data must survive)
- [ ] Run the container with `--privileged`
> `--read-only` blocks writes to the image's filesystem; the fix is to make **only** the paths the app legitimately writes writable — a tmpfs for throwaway caches, a volume for data that must persist. .NET runs fine read-only (give it `/tmp` too). The capability answers are tempting but wrong: a read-only mount isn't a permission problem that a capability lifts, and `SYS_ADMIN` or `--privileged` would throw away most of your isolation to "fix" a one-folder issue.
:::

:::quiz id=ops-07-q6 xp=10
A Dockerfile says `FROM node:24-alpine@sha256:4f1c…` (a valid digest). Which statement is true?
- [ ] Docker uses the newest `node:24-alpine`, and the digest is only checked as a hint
- [x] Docker pulls exactly the image with that digest; the `24-alpine` part is just a label for humans
- [ ] The image automatically receives Alpine security patches as they're published
- [ ] Digest pinning only works for images you built yourself
> When a digest is present, Docker resolves **by digest** and ignores the tag for selection — you get the same bytes on every machine, forever. That is also its cost: no patch arrives unless someone changes the digest, which is why teams let Renovate or Dependabot open "bump digest" PRs. The tempting wrong answer is "the tag wins" — it doesn't. Any image in any registry has a content digest, so you can pin official images as well as your own.
:::

## Simulate it: a tiny Dockerfile linter

:::challenge id=ops-07-c1 lang=ts xp=60
title: Lint a Dockerfile for security smells
Write `lintDockerfile(src)` returning the codes of the problems found — each at most once, in this
order: `latest-tag`, `secret-in-env`, `shell-form-cmd`, `no-user`.

- **`latest-tag`**: a `FROM` image has no tag or uses `:latest`. A digest (`@sha256:`) is fine,
  `scratch` is fine, and `FROM <earlier stage name>` (declared with `AS name`) is fine. Skip flags
  such as `--platform=…`. Only a `:` in the last path segment is a tag, so the port in
  `localhost:5000/base` doesn't count (that image has no tag).
- **`secret-in-env`**: an `ENV` or `ARG` declares a key containing `PASSWORD`, `SECRET`, `TOKEN` or
  `API_KEY`/`APIKEY` (case-insensitive). `ENV` may be `ENV K=v K2=v2` or `ENV K v`.
- **`shell-form-cmd`**: a `CMD` or `ENTRYPOINT` whose argument doesn't start with `[`.
- **`no-user`**: the **final stage** (after the last `FROM`) has no `USER`, or its last `USER` is `root` or `0`
  (also `root:…`/`0:…`).

Instructions are case-insensitive. Ignore empty lines and `#` comments. Lines ending in `\` continue on
the next line.

hint: First join continuation lines, then split each line into `KEYWORD rest`.
hint: For `FROM`, skip `--platform=…` flags, remember `AS name` aliases, and look for `:` only in the last path segment.

```ts starter
export function lintDockerfile(src: string): string[] {
  const problems: string[] = []
  if (!src.includes('USER')) problems.push('no-user')
  return problems
}
```

```ts solution
export function lintDockerfile(src: string): string[] {
  const lines = src.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  const found = new Set<string>()
  const stages = new Set<string>()
  let lastUser: string | null = null

  for (const line of lines) {
    const m = /^(\S+)\s*(.*)$/.exec(line)
    if (!m) continue
    const kw = m[1].toUpperCase()
    const rest = m[2].trim()

    if (kw === 'FROM') {
      const tokens = rest.split(/\s+/).filter((t) => !t.startsWith('--'))
      const image = tokens[0] ?? ''
      const asIdx = tokens.findIndex((t) => t.toUpperCase() === 'AS')
      const isStage = stages.has(image.toLowerCase())
      if (asIdx !== -1 && tokens[asIdx + 1]) stages.add(tokens[asIdx + 1].toLowerCase())
      lastUser = null
      if (isStage || image === 'scratch' || image.includes('@')) continue
      const lastSeg = image.split('/').pop() ?? ''
      const colon = lastSeg.indexOf(':')
      const tag = colon === -1 ? null : lastSeg.slice(colon + 1)
      if (tag === null || tag === 'latest') found.add('latest-tag')
    } else if (kw === 'ENV' || kw === 'ARG') {
      const keys = rest.includes('=')
        ? rest.split(/\s+/).filter((t) => t.includes('=')).map((t) => t.split('=')[0])
        : [rest.split(/\s+/)[0]]
      if (keys.some((k) => /PASSWORD|SECRET|TOKEN|API_?KEY/i.test(k))) found.add('secret-in-env')
    } else if (kw === 'CMD' || kw === 'ENTRYPOINT') {
      if (!rest.startsWith('[')) found.add('shell-form-cmd')
    } else if (kw === 'USER') {
      lastUser = rest
    }
  }
  const u = lastUser?.split(':')[0]
  if (u === undefined || u === 'root' || u === '0') found.add('no-user')

  return ['latest-tag', 'secret-in-env', 'shell-form-cmd', 'no-user'].filter((c) => found.has(c))
}
```

```ts tests
test('a hardened multi-stage Dockerfile is clean', () => {
  const df = `# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish -o /out
FROM build AS test
RUN dotnet test
FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble-chiseled@sha256:abc
COPY --from=build /out /app
USER $APP_UID
ENTRYPOINT ["dotnet", "/app/Api.dll"]`
  expect(lintDockerfile(df)).toEqual([])
})
test('missing tag and :latest', () => {
  expect(lintDockerfile('FROM node\nUSER node\nCMD ["node","s.js"]')).toEqual(['latest-tag'])
  expect(lintDockerfile('FROM nginx:latest\nUSER 101\nCMD ["nginx"]')).toEqual(['latest-tag'])
})
test('registry port is not a tag', () => {
  expect(lintDockerfile('FROM localhost:5000/base\nUSER 1000\nCMD ["x"]')).toEqual(['latest-tag'])
  expect(lintDockerfile('FROM localhost:5000/base:1.2\nUSER 1000\nCMD ["x"]')).toEqual([])
})
test('secrets in ENV and ARG', () => {
  expect(lintDockerfile('FROM alpine:3\nENV DB_PASSWORD=hunter2\nUSER 1\nCMD ["sh"]')).toEqual(['secret-in-env'])
  expect(lintDockerfile('FROM alpine:3\nARG npm_token\nUSER 1\nCMD ["sh"]')).toEqual(['secret-in-env'])
  expect(lintDockerfile('FROM alpine:3\nENV MODE=prod STRIPE_API_KEY=sk\nUSER 1\nCMD ["sh"]')).toEqual(['secret-in-env'])
  expect(lintDockerfile('FROM alpine:3\nENV NODE_ENV production\nUSER 1\nCMD ["sh"]')).toEqual([])
})
test('shell-form CMD / ENTRYPOINT', () => {
  expect(lintDockerfile('FROM node:24-alpine\nUSER node\nCMD node server.js')).toEqual(['shell-form-cmd'])
  expect(lintDockerfile('from node:24-alpine\nuser node\nentrypoint npm start')).toEqual(['shell-form-cmd'])
})
test('USER only counts in the final stage, root does not count', () => {
  expect(lintDockerfile('FROM node:24 AS b\nUSER node\nFROM nginx:alpine\nCMD ["nginx"]')).toEqual(['no-user'])
  expect(lintDockerfile('FROM alpine:3\nUSER app\nUSER root\nCMD ["sh"]')).toEqual(['no-user'])
  expect(lintDockerfile('FROM alpine:3\nUSER 0:0\nCMD ["sh"]')).toEqual(['no-user'])
})
test('continuation lines and comments', () => {
  const df = `FROM alpine:3
# ENV FAKE_TOKEN=x  (commented out)
RUN apk add --no-cache \\
    curl
ENV A=1 \\
    GITHUB_TOKEN=abc
USER 10001
CMD ["sh"]`
  expect(lintDockerfile(df)).toEqual(['secret-in-env'])
})
test('everything wrong at once', () => {
  expect(lintDockerfile('FROM ubuntu\nENV API_TOKEN=1\nCMD ./run.sh')).toEqual(['latest-tag', 'secret-in-env', 'shell-form-cmd', 'no-user'])
})
```
:::

## Lab

:::lab id=ops-07-lab1 xp=180
title: Signals, secrets, scanning and a hardened run
Work in a new folder, e.g. `mkdir sec-lab && cd sec-lab`.

**1. PID 1 ignores SIGTERM.**

```bash
docker run -d --name sleepy alpine:3 sleep 1000
time docker stop sleepy                 # ≈ 10 s — SIGTERM ignored, then SIGKILL
docker inspect -f '{{.State.ExitCode}}' sleepy    # 137

docker run -d --init --name sleepy-init alpine:3 sleep 1000
time docker stop sleepy-init            # well under 1 s — tini forwarded SIGTERM
docker rm sleepy sleepy-init
```

**2. Leak a secret with ARG… then do it right.**

`Dockerfile.leaky`:

```dockerfile
FROM alpine:3
ARG API_TOKEN
RUN test -n "$API_TOKEN" && echo "pretending to download private packages"
```

```bash
docker build -f Dockerfile.leaky --build-arg API_TOKEN=supersecret123 -t leaky .
docker history --no-trunc leaky | grep -o 'API_TOKEN=[a-z0-9]*'
```

Expected: `API_TOKEN=supersecret123` — anyone who pulls this image can read it. (You probably also
saw a `SecretsUsedInArgOrEnv` warning during the build.)

`Dockerfile.safe`:

```dockerfile
# syntax=docker/dockerfile:1
FROM alpine:3
RUN --mount=type=secret,id=api_token \
    test -s /run/secrets/api_token && \
    echo "token has $(wc -c < /run/secrets/api_token) bytes; pretending to download"
```

```bash
printf 'supersecret123' > token.txt
docker build -f Dockerfile.safe --secret id=api_token,src=token.txt --progress=plain --no-cache -t safe . 2>&1 | grep 'token has'
docker history --no-trunc safe | grep -c supersecret      # 0
docker run --rm safe sh -c 'cat /run/secrets/api_token' 2>&1   # No such file or directory
rm token.txt
```

**3. Scan images and generate an SBOM.** Use the API images from lesson 4 (`api:1.0`,
`api:1.0-chiseled` — rebuild them from that lab if needed). Trivy runs fine as a container; we feed it a
`docker save` tarball, so it needs no access to the Docker socket:

```bash
docker save api:1.0 -o api.tar
docker save api:1.0-chiseled -o api-chiseled.tar

docker run --rm -v "$PWD":/work -v trivy-cache:/root/.cache aquasec/trivy \
  image --input /work/api.tar --severity HIGH,CRITICAL,MEDIUM --quiet | grep -B2 'Total:'
docker run --rm -v "$PWD":/work -v trivy-cache:/root/.cache aquasec/trivy \
  image --input /work/api-chiseled.tar --severity HIGH,CRITICAL,MEDIUM --quiet | grep -B2 'Total:'

docker run --rm -v "$PWD":/work -v trivy-cache:/root/.cache aquasec/trivy \
  image --input /work/api-chiseled.tar --format cyclonedx --output /work/sbom.cdx.json
grep -o '"name" *: *"[^"]*"' sbom.cdx.json | head -n 15
```

Compare the `Total:` lines: the chiseled image should have far fewer OS-package findings. The SBOM lists
every component, including NuGet packages from your app.

:::tip
In CI, pin the scanner image to a version tag (`aquasec/trivy:<version>`), add `--exit-code 1
--ignore-unfixed`, and let it fail the build. If you prefer Docker's tooling: `docker scout quickview
api:1.0` (requires `docker login`).
:::

**4. Run the API hardened.**

```bash
docker run -d --name api-hard -p 127.0.0.1:8080:8080 \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --memory=256m --pids-limit=200 \
  api:1.0-chiseled
curl -s localhost:8080/weatherforecast | head -c 120; echo
docker inspect -f 'user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} caps={{.HostConfig.CapDrop}}' api-hard
time docker stop api-hard               # fast — .NET handles SIGTERM gracefully
docker logs api-hard | tail -n 3        # "Application is shutting down..."
docker rm api-hard
```

:::tip
If your `api:1.0-chiseled` already contains the lesson 5 code (which requires a connection string), add
`-e ConnectionStrings__Default="Host=none"` and call `/api/health` instead.
:::

**5. The web image passes the same baseline.** Your React image from lesson 4 (`web:1.0`) is built
on `nginxinc/nginx-unprivileged`, so it should survive the same hardening. Check it against the
baseline instead of trusting it:

```bash
docker inspect -f '{{.Config.User}}' web:1.0          # 101 — numeric, non-root
docker run -d --name web-hard -p 127.0.0.1:8081:8080 \
  --read-only --tmpfs /tmp \
  --cap-drop=ALL --security-opt=no-new-privileges \
  web:1.0
curl -s -o /dev/null -w '%{http_code}\n' localhost:8081/      # 200
docker exec web-hard id                                  # uid=101(nginx)
docker rm -f web-hard
```

`--tmpfs /tmp` is all nginx-unprivileged needs: it keeps its pid file and temp files in `/tmp`.
(The image's entrypoint may log that it can't modify a config file on the read-only filesystem;
that's informational.) Try the same with the plain `nginx` image and it fails to start: its master
process wants to write `/var/run/nginx.pid` and `/var/cache/nginx`, and without capabilities its
root master can't even switch the workers to the `nginx` user (`setgid … Operation not permitted`).

**6. A HEALTHCHECK you can break.** `Dockerfile.health`:

```dockerfile
FROM nginxinc/nginx-unprivileged:1.30-alpine
HEALTHCHECK --interval=5s --timeout=2s --start-period=5s --retries=2 \
  CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
```

```bash
docker build -f Dockerfile.health -t web-hc .
docker run -d --name web-hc web-hc
sleep 8 && docker ps --filter name=web-hc --format '{{.Names}} {{.Status}}'   # … (healthy)
docker exec -u 0 web-hc rm /usr/share/nginx/html/index.html                  # now / returns 403
sleep 12 && docker ps --filter name=web-hc --format '{{.Names}} {{.Status}}'  # … (unhealthy)
docker inspect -f '{{json .State.Health.Log}}' web-hc | head -c 300; echo
docker rm -f web-hc
```

`-u 0` runs that one `exec` as root: the container itself runs as UID 101, which isn't allowed to
delete the root-owned files in the html folder. That's non-root doing its job; `exec -u 0` is how you
deliberately step around it while debugging.

- [ ] `docker stop` took ~10 s without `--init` and was instant with it
- [ ] I found the ARG secret in `docker history` and confirmed the secret mount left no trace
- [ ] Trivy showed fewer findings for the chiseled image, and I generated a CycloneDX SBOM
- [ ] The API ran with a read-only root filesystem and no capabilities, and stopped gracefully
- [ ] The `web:1.0` image ran as UID 101 with `--read-only --cap-drop=ALL` and still served the app
- [ ] I watched a container go from `(healthy)` to `(unhealthy)`
:::

:::pro title="A realistic image security baseline"
Minimal or chiseled base pinned by digest + Renovate; multi-stage; numeric non-root `USER`; no secrets in
layers (secret mounts); `.dockerignore`; scanner gate in CI on fixable HIGH/CRITICAL; SBOM + provenance
attestations pushed with the image; signatures verified at deploy time; read-only root filesystem and
dropped capabilities at runtime; graceful SIGTERM handling with aligned timeouts. You won't find all of
it everywhere — but you'll be asked about every item in a senior interview.
:::

:::cards id=ops-07-cards1 xp=20 title="Image security"
Q: Why run containers as non-root?
A: UID 0 inside is UID 0 on the host; with an escape bug or a bad mount, root in the container becomes root on the host.
Q: Why must `USER` be numeric for Kubernetes `runAsNonRoot`?
A: The kubelet can't resolve names from the image's /etc/passwd, so it can't verify a named user isn't root.
Q: How do you pass a secret to a build safely?
A: `RUN --mount=type=secret,id=x` + `docker build --secret id=x,src=file` (or `env=VAR`).
Q: Why not ARG for secrets?
A: ARG values used by RUN are recorded in the image history.
Q: Pinning by digest — benefit and cost?
A: Exactly the same bytes every build; but no automatic patches — pair it with Renovate/Dependabot.
Q: SBOM vs provenance?
A: SBOM = what's inside (packages/versions). Provenance = how/where/from what it was built.
Q: What does `--read-only --tmpfs /tmp` do?
A: Makes the root filesystem read-only while giving the app a writable RAM-backed /tmp.
Q: Why might PID 1 ignore SIGTERM?
A: The kernel applies no default signal actions to PID 1; without a handler, SIGTERM is ignored.
Q: What does `--init` add?
A: tini as PID 1: forwards signals to your process and reaps zombies.
Q: Docker vs .NET shutdown timeouts?
A: `docker stop` waits 10 s; the .NET host waits up to 30 s. Align them (stop_grace_period / ShutdownTimeout).
Q: Does Kubernetes use HEALTHCHECK?
A: No — it uses liveness/readiness/startup probes from the pod spec.
Q: What does `--cap-drop=ALL` remove, and does a web API miss it?
A: The ~14 Linux capabilities Docker grants by default (NET_RAW, CHOWN, SETUID…). A typical API on port 8080 needs none of them.
Q: App crashes under `--read-only` writing a cache folder — fix?
A: Keep read-only; mount a `--tmpfs` (or volume) on just that path.
Q: Can .NET Native AOT run on `scratch`?
A: No — it still needs glibc/OpenSSL; use `runtime-deps:10.0-noble-chiseled`.
:::

## Recap

- Run as a **numeric non-root user**; plan for ports ≥ 1024 and writable dirs.
- Prefer **minimal bases** (chiseled/distroless/alpine) and **pin by digest** with an update bot.
- Secrets never go into `ENV`, `ARG` or layers — use **BuildKit secret mounts** for builds and the
  platform's secret store at runtime.
- **Scan** in CI and continuously; publish **SBOM** and **provenance**, sign images.
- Harden at runtime: read-only root fs + tmpfs, `cap-drop ALL`, `no-new-privileges`, resource limits.
- `HEALTHCHECK` is for Docker/Compose; Kubernetes uses probes.
- PID 1 ignores unhandled SIGTERM: use exec form, handle signals (or `--init`), and align shutdown timeouts.
