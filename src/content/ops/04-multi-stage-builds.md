---
id: ops-04
title: Multi-Stage Builds for .NET and React
level: intermediate
minutes: 40
xp: 150
summary: Build with the SDK, ship only the runtime — production Dockerfiles for ASP.NET Core 10 and a Vite React SPA on nginx, plus chiseled and distroless images.
---

To *build* an ASP.NET Core app you need the .NET SDK: compilers, MSBuild, NuGet, ~900 MB. To *run*
it you need the ASP.NET Core runtime: ~200 MB. To *build* a React app you need Node, npm and
`node_modules` (often 300 MB+). To *serve* it you need… a web server and a folder of static files.

If your production image contains the build tools, you pay three times: **size** (slower pulls, slower
autoscaling), **attack surface** (every extra binary is a CVE waiting to be reported against your
image), and **leaked stuff** (source code, `.npmrc`, test fixtures). **Multi-stage builds** fix this by
letting one Dockerfile use several `FROM`s and copy only the *results* forward.

## How multi-stage works

```dockerfile
# syntax=docker/dockerfile:1
# stage 1, named "build"
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build         # produces /app/dist

# stage 2 — starts from a FRESH filesystem
FROM nginxinc/nginx-unprivileged:1.30-alpine
COPY --from=build /app/dist /usr/share/nginx/html
```

```text
 stage "build" (node:24-alpine, ~400 MB with node_modules)      final stage (nginx-unprivileged, ~50 MB)
 ┌──────────────────────────────────────────┐                  ┌────────────────────────────┐
 │ /app/node_modules   /app/src   /app/dist │ ──COPY --from──▶ │ /usr/share/nginx/html/…    │
 └──────────────────────────────────────────┘    only dist/    └────────────────────────────┘
          thrown away (stays in build cache)                       this is the image you ship
```

Under the hood:

- Every `FROM` starts a new **stage** with a fresh filesystem. `AS build` gives it a name so later
  stages can refer to it (you can also use its index, `--from=0`, but names survive reordering).
- **Only the last stage becomes the image** (unless you pick another with `--target`). Earlier stages'
  layers are not part of it — they're just kept in the local build cache.
- `COPY --from=build <src> <dest>` copies files out of another stage's filesystem. Apart from
  starting a stage `FROM` an earlier one (e.g. `FROM build AS test`, which inherits everything),
  this is the only way anything crosses a stage boundary. A stage that starts from a fresh base
  image gets **none** of the build stage's environment variables, `WORKDIR`, `USER` or installed
  tools.
- BuildKit builds a **dependency graph** of stages: stages the target doesn't depend on (via `FROM` or
  `COPY --from`) are **skipped**, and independent stages run **in parallel**.
- `COPY --from=` can also take an *image* name. A common real example is grabbing a single static
  binary: `COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/` (pin a version in real projects).
- `docker build --target build -t app:build .` stops at a named stage — handy for running tests in CI
  or for a dev image.

## ASP.NET Core 10: the production Dockerfile

Assume a typical repo layout:

```text
backend/
├── Directory.Build.props
├── Directory.Packages.props       # central package management (optional)
├── Api.slnx
├── src/
│   ├── Api/Api.csproj             # the web app
│   └── Domain/Domain.csproj       # a class library referenced by Api
└── tests/…
```

```dockerfile
# syntax=docker/dockerfile:1

############ build stage: full SDK ############
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# 1) Restore — only project files, so this layer stays cached until dependencies change
COPY Directory.Build.props Directory.Packages.props ./
COPY src/Api/Api.csproj src/Api/
COPY src/Domain/Domain.csproj src/Domain/
RUN dotnet restore src/Api/Api.csproj

# 2) Everything else, then publish (no restore: it's done)
COPY src/ src/
RUN dotnet publish src/Api/Api.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

############ runtime stage: just the ASP.NET Core runtime ############
FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS final
WORKDIR /app
COPY --from=build /app/publish .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Api.dll"]
```

Why each piece:

- **csproj first, `restore` second** — exactly the `package.json` trick from lesson 3. NuGet restore is
  the slowest step; it only reruns when a project file or the central package versions change.
  Copy the files into the **same relative folders**, because `ProjectReference` paths like
  `..\Domain\Domain.csproj` must still resolve. Copy only the root files your repo actually has
  (`COPY` fails on a missing file) — and include `NuGet.config` if you use a private feed.
- **`--no-restore`** — publish reuses the restored `obj/project.assets.json` instead of hitting NuGet again.
- **`/p:UseAppHost=false`** — skips generating the native `Api` launcher executable; we start with
  `dotnet Api.dll` anyway.
- **`USER $APP_UID`** — since .NET 8, Microsoft's images include a non-root user `app` and the env var
  `APP_UID` (1654). Running as non-root is the default you want (lesson 7).
- **Port 8080** — .NET 8+ images set `ASPNETCORE_HTTP_PORTS=8080`, so Kestrel listens on
  `http://+:8080`. Traditionally only root may bind ports below 1024; Docker relaxes that inside
  containers, but not every runtime or cluster policy does, so Microsoft moved to 8080 to make
  non-root work everywhere. Publish it as whatever you like on the host (`-p 5000:8080`).
- **No HTTPS in the container** — TLS is terminated by the reverse proxy / ingress / load balancer in
  front of it. Don't bake dev certificates into images.

:::warn title="bin/ and obj/ from your host"
Without a `.dockerignore`, `COPY src/ src/` copies your local `obj/project.assets.json` (with *your*
machine's paths, maybe from Windows) on top of the one restore just created, and the build fails with
baffling errors like *"Unable to find fallback package folder 'C:\Program Files\…'"*. Always ignore
`**/bin` and `**/obj`.
:::

### Faster restores with a cache mount

The layer cache is all-or-nothing: when you add one package to `Api.csproj`, the restore layer misses
and NuGet downloads *every* package again from scratch. BuildKit can mount a **persistent cache
directory** into a `RUN` step. It's not part of any layer (so it doesn't bloat the image), and it
survives between builds even when the layer cache misses. `/root/.nuget/packages` is where NuGet
keeps its downloaded packages when running as root, which the SDK image does:

```dockerfile
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore src/Api/Api.csproj
COPY src/ src/
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet publish src/Api/Api.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false
```

Now adding one package downloads one package, not all 80. Note that **both** steps need the mount:
the packages live only in the cache, not in the restore layer, and publish needs them.

### Which runtime base image?

Microsoft publishes several flavours of the runtime image. For .NET 10 the default tags are based on
**Ubuntu 24.04 "Noble"** (.NET 8/9 defaulted to Debian).

| Tag | What's inside | Shell? | Rough size* |
|---|---|---|---|
| `sdk:10.0` | Full SDK, for building only | yes | ~900 MB |
| `aspnet:10.0` | Ubuntu + ASP.NET Core runtime | yes | ~230 MB |
| `aspnet:10.0-alpine` | Alpine (musl) + runtime | yes | ~120 MB |
| `aspnet:10.0-noble-chiseled` | Only the files .NET needs, non-root by default, no package manager | **no** | ~110 MB |
| `aspnet:10.0-noble-chiseled-extra` | Chiseled + ICU and tzdata (for globalization / time zones) | **no** | ~150 MB |
| `runtime-deps:10.0-noble-chiseled` | Only native deps — for self-contained or Native AOT apps | **no** | ~20 MB + your app |

\* Uncompressed, approximate; check with `docker images` — numbers move with every patch release.

**Chiseled** images are Canonical's take on *distroless*: Ubuntu packages cut down to only the files
actually needed ("slices"). No shell, no `apt`, no `curl` — so most CVE scanners report a tiny fraction
of the findings of a full OS image, and an attacker who gets code execution has no tools to work with.

:::warn title="Chiseled gotchas"
The plain chiseled images run in **globalization-invariant mode** (no ICU culture data) — if you format
dates/currency for specific cultures or use time-zone IDs, use the `-extra` variant. And without a
shell, `docker exec -it api sh` fails and a `HEALTHCHECK CMD curl …` can't work. Debug by attaching a
separate debug container that shares the target's namespaces (Docker Desktop's `docker debug`, or
`kubectl debug` in Kubernetes).
:::

:::quiz id=ops-04-q1 xp=10
In this ASP.NET Core Dockerfile, a developer only edited `Program.cs`. Which steps re-run?

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/Api/Api.csproj src/Api/
RUN dotnet restore src/Api/Api.csproj
COPY src/ src/
RUN dotnet publish src/Api/Api.csproj -c Release -o /app/publish --no-restore
FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Api.dll"]
```

- [ ] Everything, because the SDK stage changed
- [ ] Only `RUN dotnet restore`
- [x] `COPY src/ src/`, `dotnet publish`, and the final `COPY --from=build`
- [ ] Only the final stage
> `Api.csproj` didn't change, so the `COPY` of it and restore stay cached. `COPY src/ src/` sees a new checksum and misses; publish rebuilds; the published `Api.dll` differs, so the final `COPY --from` misses too. "Everything" is tempting, but the SDK stage's *base* didn't change — a cache miss only invalidates steps *after* it. And the final stage's `FROM` and `WORKDIR` don't depend on the build stage at all, so they remain cached.
:::

:::quiz id=ops-04-q2 xp=10
Which statement about the **final image** of a multi-stage build is true?
- [ ] It contains all layers of all stages, but only the last stage's files are visible
- [x] It contains only the layers of the last stage (its base image + what it adds, including the `COPY --from` result)
- [ ] It's always smaller than 50 MB
- [ ] It still contains the SDK, but it's compressed
> Earlier stages exist only in the build cache. Nothing from them ships except the files you explicitly `COPY --from`. The first option describes how *layers within one stage* work (a deleted file still sits in a lower layer) — but separate stages are separate filesystems, so the build stage's layers aren't in the final image at all. Size depends on the base you choose; nothing guarantees 50 MB.
:::

:::quiz id=ops-04-q5 xp=10
A Dockerfile has three stages: `build`, `test` (`FROM build AS test`, runs `dotnet test`) and `final`
(`FROM aspnet:10.0`, does `COPY --from=build /app/publish .`). What does a plain `docker build -t api .`
do with the `test` stage?
- [ ] Runs it, because every stage in the file is always built in order
- [x] Skips it: the last stage (`final`) depends only on `build`, so BuildKit never needs `test`
- [ ] Fails, because a Dockerfile may only have one stage that starts `FROM` another stage
- [ ] Runs it in parallel with `final` and includes the test results in the image
> BuildKit starts from the target (by default the last stage) and walks backwards through its dependencies — `FROM` and `COPY --from`. `test` is not among them, so it's skipped. "Every stage runs in order" was true for the *legacy* builder, which is why old answers on the internet say so. To run the tests, build that stage explicitly: `docker build --target test .`.
:::

## Vite + React: build with Node, serve with nginx

A Vite build produces a folder of static files (`dist/`: `index.html` + hashed JS/CSS in
`dist/assets/`). Serving static files is nginx's day job, so the runtime image needs **no Node at all**.

```dockerfile
# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build

# Non-root nginx (UID 101) that listens on 8080 — see "Why not plain nginx?" below
FROM nginxinc/nginx-unprivileged:1.30-alpine AS final
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

Note: here we need *all* dependencies (`npm ci` without `--omit=dev`) because Vite and TypeScript are
dev dependencies — and that's fine, they stay in the build stage. The `ARG`/`ENV` pair lets CI pass
`--build-arg VITE_API_URL=…`; Vite reads `VITE_*` variables from the environment during the build.

### The SPA fallback

React Router (or TanStack Router…) handles URLs like `/projects/42` **in the browser**. But when a user
refreshes on that URL, the browser asks the *server* for `/projects/42` — a file that doesn't exist. By
default nginx answers **404**. The fix is to fall back to `index.html` for unknown paths:

```nginx
# nginx.conf
server {
    listen 8080;          # non-root can't rely on ports < 1024 — see the tip below
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Hashed assets (index-4f9a1c.js) can be cached forever
    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files $uri =404;
    }

    # index.html must never be cached, or users keep loading old asset names
    location = /index.html {
        add_header Cache-Control "no-cache";
    }

    # Everything else: serve the file if it exists, otherwise the SPA shell
    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;
}
```

`try_files $uri $uri/ /index.html` reads as: *"serve the exact file; else the directory; else
internally serve `/index.html`"* — with status 200, so the router takes over in the browser.
Because that fallback is an *internal redirect* to `/index.html`, it lands in the
`location = /index.html` block and gets the `no-cache` header too.

:::tip title="Why not plain nginx? Non-root from day one"
The official `nginx` image starts its master process as **root** (so it can bind port 80 and write
`/var/run/nginx.pid`) and only drops its *worker* processes to the `nginx` user. That works with
`docker run`, but it breaks every "no root containers" rule you'll meet: lesson 7's hardening
baseline, and Kubernetes' `runAsNonRoot: true` (lessons 9+), which refuses to start it.
`nginxinc/nginx-unprivileged` is the same nginx, maintained by the nginx team, built to run as
**UID 101** (a *numeric* `USER`, so Kubernetes can verify it), with the pid file in `/tmp` and
**port 8080** as the default. That's why our `nginx.conf` says `listen 8080;` and the Dockerfile
`EXPOSE 8080`. The *published* port can still be anything (`-p 8081:8080`, or 80/443 on a load
balancer).

We pin `1.30-alpine` (nginx's current **stable** branch + Alpine; odd minors like 1.31 are the
mainline branch) everywhere in lessons 1–8, like we pin `node:24-alpine` and `postgres:18`: the tag
still receives patch releases, but a rebuild next month can't silently jump a minor version. Stable
branches get patches for about a year, until the next even minor ships. Bump it deliberately — or let Renovate/Dependabot open the PR
(lesson 7).
:::

:::warn title="VITE_ variables are baked in at build time"
`import.meta.env.VITE_API_URL` is replaced by a **string literal** during `npm run build`. Setting
`-e VITE_API_URL=…` on `docker run` does nothing — the value is already in the JS bundle. Options:
build one image per environment (meh — breaks "build once, deploy everywhere"), use a **relative URL**
like `/api` and let nginx/ingress route it (simplest — used in lesson 5), or serve a small
`/config.js` generated at container start that the app reads at runtime.
:::

:::quiz id=ops-04-q3 xp=10
Your React app is served by nginx from the image above **without** the `location /` fallback. A user
bookmarks `https://app.example.com/settings/profile` and opens it. What happens?
- [ ] React Router loads and shows the profile page
- [x] nginx returns 404, because there is no file `settings/profile` in the html root
- [ ] nginx redirects to `/`
- [ ] The browser loads the cached `index.html` from the service worker, always
> The request reaches the server first. Without `try_files … /index.html`, nginx looks for a real file and returns 404. Client-side routing only works once `index.html` and the JS are loaded.
:::

:::quiz id=ops-04-q4 xp=15
Which of these are good reasons to choose `aspnet:10.0-noble-chiseled` over `aspnet:10.0`? (select all that apply)
- [x] Far fewer OS packages, so far fewer CVEs to triage
- [x] It runs as a non-root user by default
- [ ] You can `docker exec -it` into it with bash to debug production
- [x] Smaller image → faster pulls and scale-out
- [ ] It's required for running on Kubernetes
> Fewer packages, non-root by default and a smaller download are exactly what chiseled images are designed for. "Exec in with bash" is the opposite of true: having **no shell** is the point (and the trade-off) — you debug with a separate debug container instead. And Kubernetes runs any OCI image; chiseled is a choice, not a requirement.
:::

:::quiz id=ops-04-q6 xp=10
Your React image was built with `VITE_API_URL=/api`. In staging you run it with
`docker run -e VITE_API_URL=https://staging.example.com/api web:1.0`. Which URL does the app call?
- [x] `/api` — the value was inlined into the JS bundle during `npm run build`
- [ ] `https://staging.example.com/api` — runtime env vars override build-time ones
- [ ] Neither — the app crashes because two values conflict
- [ ] `https://staging.example.com/api`, but only after nginx is reloaded
> Vite replaces `import.meta.env.VITE_API_URL` with a string literal at build time; the browser runs that JS and never sees the container's environment (nginx doesn't pass it on either — it just serves files). The "runtime overrides" intuition comes from server apps like ASP.NET Core, which read env vars on every start. For per-environment values, use a relative URL or a runtime `config.js`.
:::

## Size comparison: why it matters

| Image | Typical size | What a pull costs on a fresh node |
|---|---|---|
| API built single-stage on `sdk:10.0` | ~950 MB | tens of seconds, lots of CVEs |
| API multi-stage on `aspnet:10.0` | ~240 MB | a few seconds |
| API multi-stage on `aspnet:10.0-noble-chiseled` | ~120 MB | fast, minimal surface |
| React app on `node:24-alpine` running `vite preview` | ~400 MB | wrong tool for production anyway |
| React app on `nginx-unprivileged:1.30-alpine` | ~50–60 MB | fast |

Size is mostly about **time**: when Kubernetes schedules a new pod on a node that doesn't have the
image, it pulls before it starts. Under a traffic spike, 950 MB vs 120 MB is the difference between
scaling out in 5 seconds or in 60.

## Lab

:::lab id=ops-04-lab1 xp=150
title: Production images for an ASP.NET Core 10 API and a Vite React app
You need Docker, the .NET 10 SDK and Node.js locally (only to generate the projects).

### Part A — the API

```bash
mkdir multistage && cd multistage
dotnet new webapi -n Api -o api
cd api
```

Create `.dockerignore`:

```text
**/bin
**/obj
**/.vs
**/.vscode
**/*.user
Dockerfile*
.dockerignore
```

First the **naive** single-stage image, so you have something to compare against. Save as
`Dockerfile.naive`:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0
WORKDIR /src
COPY . .
RUN dotnet publish -c Release -o /app/publish
WORKDIR /app/publish
ENTRYPOINT ["dotnet", "Api.dll"]
```

Now the real one, `Dockerfile`. The `RUNTIME_TAG` arg lets you switch runtime flavours without
editing the file:

```dockerfile
# syntax=docker/dockerfile:1
ARG RUNTIME_TAG=10.0

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY Api.csproj ./
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore Api.csproj
COPY . .
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet publish Api.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:${RUNTIME_TAG} AS final
WORKDIR /app
COPY --from=build /app/publish .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "Api.dll"]
```

Build all three variants:

```bash
docker build -f Dockerfile.naive -t api:naive .
docker build -t api:1.0 .
docker build --build-arg RUNTIME_TAG=10.0-noble-chiseled -t api:1.0-chiseled .
docker images api
```

Run one and call it:

```bash
docker run -d --name api -p 127.0.0.1:8080:8080 api:1.0-chiseled
curl -s localhost:8080/weatherforecast | head -c 200; echo
docker logs api | head -n 5          # "Now listening on: http://[::]:8080"
docker exec api sh                   # fails: no shell in a chiseled image — expected!
docker exec api id 2>&1 | head -n 1  # also fails: no `id` binary either
docker inspect -f '{{.Config.User}}' api:1.0-chiseled   # 1654  ($APP_UID, expanded at build time)
docker rm -f api
```

The two `exec` attempts fail with an OCI runtime error along the lines of
`exec: "sh": executable file not found in $PATH` — there is simply no such file in the image.

:::tip
A warning like *"Failed to determine the https port for redirect"* comes from the template's
`app.UseHttpsRedirection()`. In a container behind a proxy that terminates TLS, remove that line.
:::

Now edit `Program.cs` (change a summary word) and rebuild with `docker build -t api:1.0 .`. Expected:

```text
 => CACHED [build 3/6] COPY Api.csproj ./
 => CACHED [build 4/6] RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages dotnet restore Api.csproj
 => [build 5/6] COPY . .
 => [build 6/6] RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages dotnet publish ...
```

(Step numbers may differ slightly between Docker versions; what matters is `CACHED` on restore.)

### Part B — the React app

```bash
cd ..
npm create vite@latest web -- --template react-ts   # answer "No" if it offers to install & start
cd web
npm install
```

Create `.dockerignore`:

```text
node_modules
dist
.git
.env*
Dockerfile*
.dockerignore
```

Create `nginx.conf` with the server block from the lesson above (SPA fallback + cache headers), then
`Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30-alpine AS final
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

```bash
docker build -t web:1.0 .
docker run -d --name web -p 127.0.0.1:8081:8080 web:1.0
curl -s -o /dev/null -w '%{http_code}\n' localhost:8081/                    # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:8081/some/deep/link      # 200 (SPA fallback)
curl -sI localhost:8081/ | grep -i cache-control                            # no-cache
docker exec web ls /usr/share/nginx/html/assets                         # hashed files
docker exec web id                                                      # uid=101(nginx) — not root
docker inspect -f '{{.Config.User}}' web:1.0                            # 101 (numeric, from the base image)
docker rm -f web
```

Then prove the fallback matters: comment out the three lines of the `location / { … }` block in
`nginx.conf` (prefix each with `#`), then:

```bash
docker build -t web:nofallback .
docker run -d --name web-nf -p 127.0.0.1:8082:8080 web:nofallback
curl -s -o /dev/null -w '%{http_code}\n' localhost:8082/                    # 200 (index still works)
curl -s -o /dev/null -w '%{http_code}\n' localhost:8082/some/deep/link      # 404
docker rm -f web-nf
```

Restore the block afterwards — the `web:1.0` image is the one you'd ship.

### Part C — compare

```bash
docker images --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E '^(api|web):'
```

Write down the sizes. Expect roughly: naive ≈ 900 MB+, `api:1.0` ≈ 230–250 MB, chiseled ≈ 120 MB,
`web:1.0` ≈ 50–60 MB.

- [ ] `curl localhost:8080/weatherforecast` returned JSON from the chiseled image
- [ ] `docker exec api sh` failed, and I understand why
- [ ] After editing `Program.cs`, `dotnet restore` was CACHED
- [ ] The React app returned 200 for a deep link and 404 once I removed the fallback
- [ ] `docker exec web id` showed UID 101: the web image runs as non-root on port 8080
- [ ] I recorded the sizes of naive vs multi-stage vs chiseled
:::

:::job title="What you'll find in a real repo"
Usually one Dockerfile per deployable, next to the project (`backend/src/Api/Dockerfile`,
`frontend/Dockerfile`), built in CI with the repo or the solution folder as context. Many .NET teams
also use the SDK's built-in container support — `dotnet publish /t:PublishContainer` builds an OCI
image without a Dockerfile — but most still keep a Dockerfile because it's explicit and works with all
Docker tooling.
:::

:::pro title="Test stage in the same Dockerfile"
Add a stage `FROM build AS test` with `RUN dotnet test --no-restore`, and in CI run
`docker build --target test .` before building `final`. Tests then run in exactly the environment the
artifact is built in. Because `final` doesn't copy from `test`, a normal build skips it.
:::

:::cards id=ops-04-cards1 xp=20 title="Multi-stage builds"
Q: What ends up in the final image of a multi-stage build?
A: Only the last (or `--target`) stage: its base + what it adds, including files copied with `COPY --from`.
Q: How do you build only up to a stage?
A: `docker build --target <stage-name> .`
Q: Why copy *.csproj before the source?
A: So `dotnet restore` (slow) stays cached until project files/dependencies change.
Q: What's `--no-restore` for in `dotnet publish`?
A: Reuse the restore done in the earlier cached layer instead of restoring again.
Q: Which port does an ASP.NET Core 8+ container listen on by default?
A: 8080 (`ASPNETCORE_HTTP_PORTS=8080`), so it can run as non-root.
Q: What's `$APP_UID`?
A: The UID (1654) of the non-root `app` user in Microsoft's .NET images; use `USER $APP_UID`.
Q: Why `nginxinc/nginx-unprivileged` instead of `nginx`?
A: The official image's master process runs as root; the unprivileged one runs as numeric UID 101 on port 8080, so it passes `runAsNonRoot` and non-root policies.
Q: What does `try_files $uri $uri/ /index.html` do?
A: Serve the file or directory if it exists, otherwise index.html — the SPA fallback for client-side routes.
Q: Why can't you change VITE_API_URL with `docker run -e`?
A: Vite inlines `import.meta.env.VITE_*` at build time; the bundle already contains the value.
Q: What is a chiseled image?
A: A distroless-style Ubuntu image with only required files: no shell, no package manager, non-root by default.
Q: Why does a BuildKit cache mount need to be on both restore and publish?
A: The packages live only in the cache mount, not in a layer; publish needs them too.
Q: Does a plain `docker build .` run a `test` stage that `final` doesn't copy from?
A: No — BuildKit only builds the stages the target depends on. Use `--target test` to run it.
:::

## Recap

- Multi-stage = build with heavy tools, `COPY --from` only the output into a small runtime image.
  Unused stages are skipped, independent ones run in parallel.
- ASP.NET Core: copy `*.csproj` → `restore` → copy source → `publish --no-restore` → `aspnet:10.0`
  runtime, `USER $APP_UID`, port 8080. Ignore `bin/` and `obj/`.
- Chiseled / distroless images: much smaller and safer, but no shell — debug from the outside.
- Vite: `node` stage runs `npm ci && npm run build`, `nginxinc/nginx-unprivileged:1.30-alpine` (UID 101,
  port 8080) serves `dist/` with an SPA fallback and proper cache headers. `VITE_*` values are baked in at
  build time.
- Image size is time: pulls dominate scale-out speed.
