---
id: cap-10
title: Ship It — Containers, Kubernetes and Launch
level: expert
minutes: 450
xp: 300
summary: Multi-stage images, the whole stack in one compose file, a kind cluster deployed with kustomize (probes, Traefik, secrets, backups), observability, a hardened edge, SHA-tagged continuous delivery with a rehearsed rollback, a k6 load test with an incident drill, and a launch checklist.
---

Everything works on your machine. This final lesson makes it work **anywhere**: reproducible
images, one command for the full stack, a real Kubernetes deployment with health-gated rollouts and
backups, and enough telemetry to answer "what is it doing right now?" at 3 a.m.

```text
                       http://localhost:8088 (kind)  /  http://localhost:8080 (compose)
                                         │
                              ┌──────────▼──────────┐
                              │  Traefik (Ingress)  │  /api, /hubs → api    / → web
                              └───┬─────────────┬───┘
                     ┌────────────▼───┐   ┌─────▼──────────┐
                     │ web (nginx)    │   │ api ×N         │◀── initContainer: migrator (EF bundle)
                     │ SPA + fallback │   │ REST + SignalR │
                     └────────────────┘   └──────┬─────────┘
                                                 │ SQL, LISTEN job_events
                     ┌────────────────┐   ┌──────▼─────────┐     ┌─────────────────────────┐
                     │ worker ×N      │──▶│ postgres       │◀────│ CronJob pg_dump → PVC   │
                     │ SKIP LOCKED    │   │ StatefulSet    │     └─────────────────────────┘
                     └────────────────┘   └────────────────┘
```

## Probes: what Kubernetes does with your health endpoints

cap-03 built `/health/live` and `/health/ready` and explained why the database check belongs only
in readiness. This section adds the other half: what Kubernetes *does* with each answer, a third
probe for slow starts, and the timing knobs that decide how fast it reacts.

| Probe | Question | BranchStory answer | On failure |
|---|---|---|---|
| **startup** | Have you finished booting? | `/health/live` responds | keep waiting up to `failureThreshold × periodSeconds`, then **restart**; liveness and readiness don't run until it has succeeded once |
| **liveness** | Are you stuck beyond repair? | the process answers; the worker's claim loop has beaten in the last 60 s | **restart** the container |
| **readiness** | Should I send you traffic right now? | can reach Postgres | remove from Service endpoints, **no restart** |

Kubernetes acts only after `failureThreshold` *consecutive* failures, one every `periodSeconds`.
With `periodSeconds: 10` and `failureThreshold: 3`, a pod is restarted about 30 s after it got
stuck. Each probe call also has a `timeoutSeconds` (default **1 s**). A health endpoint that waits
3 s for a slow database counts as a failure even if it would eventually say "Healthy".

Recall cap-03's classic mistake, putting the database check into **liveness**, and now add the
timing. Say Postgres fails over and is unreachable for 20 seconds. Every API pod fails liveness at
the same moment, Kubernetes restarts all of them, and a database blip turns into a full outage
with every pod cold-starting at once. A
dependency outage should make you *unready*, not *dead*. "Would restarting this container fix the
problem?" is the test: for a deadlock, yes; for a database outage, no.

ASP.NET Core supports this split with **tags** and **predicates** (cap-03 set this up; here is the
code again, unchanged). Each health check gets tags when you register it, and each endpoint only
runs the checks its `Predicate` accepts:

```csharp
builder.Services.AddHealthChecks()
    .AddCheck<PostgresHealthCheck>("postgres", tags: ["ready"]);

// Liveness runs no checks at all: if the process can answer HTTP, it is alive.
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });
```

The worker (cap-08) has something worth checking for liveness: its `WorkerHeartbeat` check is
tagged `"live"` and its live endpoint uses `Predicate = c => c.Tags.Contains("live")`, so a
deadlocked claim loop gets the container restarted.

:::challenge id=cap-10-c1 lang=ts xp=40
title: Answer a probe
Implement `probeResponse(checks, probe)` the way ASP.NET Core's health middleware does it with tag
predicates. Only checks whose `tags` include the probe name (`'live'` or `'ready'`) count. The
overall status is the **worst** of them (`Unhealthy` beats `Degraded`, which beats `Healthy`);
with no matching checks it is `Healthy`. `http` is `503` for `Unhealthy` and `200` otherwise
(Degraded still serves traffic). `failing` lists the names of matching checks that are not
`Healthy`, sorted alphabetically.

hint: Give the statuses a rank: `{ Healthy: 0, Degraded: 1, Unhealthy: 2 }`, then take the max.
hint: Filter by tag first; everything else is computed from that filtered list.

```ts setup
export type HealthStatus = 'Healthy' | 'Degraded' | 'Unhealthy'
export interface HealthCheck { name: string; tags: string[]; status: HealthStatus }
export interface ProbeResult { status: HealthStatus; http: number; failing: string[] }
```

```ts starter
export function probeResponse(checks: HealthCheck[], probe: 'live' | 'ready'): ProbeResult {
  return { status: 'Healthy', http: 200, failing: [] }
}
```

```ts solution
const rank: Record<HealthStatus, number> = { Healthy: 0, Degraded: 1, Unhealthy: 2 }

export function probeResponse(checks: HealthCheck[], probe: 'live' | 'ready'): ProbeResult {
  const relevant = checks.filter((c) => c.tags.includes(probe))
  const status = relevant.reduce<HealthStatus>((worst, c) => (rank[c.status] > rank[worst] ? c.status : worst), 'Healthy')
  const failing = relevant.filter((c) => c.status !== 'Healthy').map((c) => c.name).sort()
  return { status, http: status === 'Unhealthy' ? 503 : 200, failing }
}
```

```ts tests
const checks: HealthCheck[] = [
  { name: 'runner', tags: ['live'], status: 'Healthy' },
  { name: 'database', tags: ['ready'], status: 'Unhealthy' },
  { name: 'disk', tags: ['ready'], status: 'Degraded' },
]

test('a database outage does not fail liveness', () => {
  expect(probeResponse(checks, 'live')).toEqual({ status: 'Healthy', http: 200, failing: [] })
})
test('readiness reports the worst status with 503', () => {
  expect(probeResponse(checks, 'ready')).toEqual({ status: 'Unhealthy', http: 503, failing: ['database', 'disk'] })
})
test('degraded still serves traffic', () => {
  const r = probeResponse([{ name: 'cache', tags: ['ready'], status: 'Degraded' }], 'ready')
  expect(r).toEqual({ status: 'Degraded', http: 200, failing: ['cache'] })
})
test('no matching checks means healthy', () => {
  expect(probeResponse([], 'ready')).toEqual({ status: 'Healthy', http: 200, failing: [] })
})
test('a stalled runner fails liveness', () => {
  const r = probeResponse([{ name: 'runner', tags: ['live'], status: 'Unhealthy' }, ...checks.slice(1)], 'live')
  expect(r.http).toBe(503)
  expect(r.failing).toEqual(['runner'])
})
```
:::

:::quiz id=cap-10-q1 xp=15
Your API's **liveness** probe (`periodSeconds: 5`, `failureThreshold: 3`) calls `/health/ready`,
which checks Postgres. A planned database failover makes Postgres unreachable for 25 s. What happens?
- [ ] Nothing, probes ignore short outages
- [x] All API pods fail liveness together and are restarted, turning a 25 s database blip into a full outage plus a cold-start stampede
- [ ] Only the pod that lost its connection is restarted
- [ ] Kubernetes pauses the probes while the database is down
> After 3 failures × 5 s = 15 s every pod has failed liveness, and the outage lasts 25 s, so the
> kubelet restarts all of them. Liveness should only detect states a restart can fix (a deadlock,
> a stalled loop). "Only the pod that lost its connection" is the tempting answer, but every pod
> checks the same database, so they all fail together. Kubernetes never pauses probes on its own.
> Put the database check in readiness instead: the pods leave the Service endpoints, keep running,
> and come back on their own when the database does.
:::

## Lab 1: production images

:::lab id=cap-10-lab1 xp=120
title: Multi-stage Dockerfiles for api, migrator, worker and web

Goals for every image: **small** (no SDK at runtime), **cache-friendly** (restore before copying
sources), **non-root**, and **one process per container**.

Two Docker ideas make those goals possible:

* **Multi-stage builds.** One Dockerfile has several `FROM` stages. The `build` stage has the full
  .NET SDK or Node toolchain (hundreds of MB, plus compilers an attacker would love). The final stage
  starts from a small runtime image and copies in only the published output with
  `COPY --from=build`. Everything else from the build stage is left behind.
* **Layer caching.** Each instruction produces a layer, and Docker reuses a cached layer as long
  as that instruction and every file it copied are unchanged. Once one layer changes, every layer
  after it is rebuilt. So copy the files that rarely change (`*.csproj`, `package-lock.json`)
  first, restore, and only then copy the source code. A typical commit only touches `.cs` or `.tsx`
  files, so the slow restore layer stays cached. Copy everything first and every commit pays for a
  full `dotnet restore` or `npm ci`.

The .NET 8+ images ship a non-root user named `app` (uid 1654) and expose its id as the
`$APP_UID` environment variable, so `USER $APP_UID` is all it takes. Kubernetes'
`runAsNonRoot: true` (Lab 4) checks for a **numeric** uid, so use `$APP_UID` rather than the name
`app`.

**1. `.dockerignore`** at the repository root (all builds use the root as context)

```text
**/bin/
**/obj/
**/node_modules/
**/dist/
**/.vs/
**/.vscode/
**/*.user
.git/
coverage/
test-results/
tests/e2e/playwright-report/
tests/e2e/test-results/
deploy/k8s/overlays/*/secrets.env
```

**2. `api/Dockerfile`**: four stages, two of them are shipping images

```dockerfile
# syntax=docker/dockerfile:1.7
ARG DOTNET_VERSION=10.0

# ── build: restore (cached until a csproj changes), then publish ──
FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
WORKDIR /src
COPY api/BranchStory.Api/BranchStory.Api.csproj api/BranchStory.Api/
COPY api/BranchStory.Data/BranchStory.Data.csproj api/BranchStory.Data/
COPY api/BranchStory.ServiceDefaults/BranchStory.ServiceDefaults.csproj api/BranchStory.ServiceDefaults/
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore api/BranchStory.Api/BranchStory.Api.csproj
COPY api/ api/
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet publish api/BranchStory.Api/BranchStory.Api.csproj -c Release -o /out/api --no-restore -p:UseAppHost=false

# ── bundle: EF Core migrations as one self-contained executable ──
FROM build AS bundle
ARG TARGETARCH
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet tool install --global dotnet-ef --version "10.*" \
 && export PATH="$PATH:/root/.dotnet/tools" \
 && RID="linux-$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64)" \
 && dotnet ef migrations bundle \
      --project api/BranchStory.Data \
      --configuration Release --self-contained -r "$RID" -o /out/efbundle --force

# ── migrator image: runs once per deploy, then exits ──
FROM mcr.microsoft.com/dotnet/runtime-deps:${DOTNET_VERSION} AS migrator
WORKDIR /app
COPY --from=bundle /out/efbundle ./efbundle
ENV DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp
USER $APP_UID
ENTRYPOINT ["/app/efbundle"]

# ── runtime image (default target, keep it last) ──
FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_VERSION} AS runtime
WORKDIR /app
COPY --from=build /out/api ./
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "BranchStory.Api.dll"]
```

The bundle is built from `BranchStory.Data` alone: cap-02's `DesignTimeDbContextFactory` means it
never has to boot the API (and so never needs JWT keys or other runtime configuration). At run
time it gets its connection string from `--connection`. If your repository has
`Directory.Build.props` or `Directory.Packages.props` at the root, `COPY` them next to the csproj
files before `dotnet restore`, or the restore layer will not see them.

**3. `worker/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
ARG DOTNET_VERSION=10.0

FROM mcr.microsoft.com/dotnet/sdk:${DOTNET_VERSION} AS build
WORKDIR /src
COPY worker/BranchStory.Worker/BranchStory.Worker.csproj worker/BranchStory.Worker/
COPY api/BranchStory.ServiceDefaults/BranchStory.ServiceDefaults.csproj api/BranchStory.ServiceDefaults/
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet restore worker/BranchStory.Worker/BranchStory.Worker.csproj
COPY worker/ worker/
COPY api/BranchStory.ServiceDefaults/ api/BranchStory.ServiceDefaults/
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    dotnet publish worker/BranchStory.Worker/BranchStory.Worker.csproj -c Release -o /out --no-restore -p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:${DOTNET_VERSION} AS runtime
WORKDIR /app
COPY --from=build /out ./
ENV ASPNETCORE_HTTP_PORTS=8081
EXPOSE 8081
USER $APP_UID
ENTRYPOINT ["dotnet", "BranchStory.Worker.dll"]
```

(The worker references `BranchStory.ServiceDefaults` from Lab 3. Until then, delete the two
ServiceDefaults `COPY` lines, or do Lab 3 first.)

**4. `deploy/nginx/default.conf`**: SPA fallback, long-cached assets, API and WebSocket proxy

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
    server_tokens off;

    location = /healthz { access_log off; return 200 "ok\n"; }

    # Vite puts content-hashed files in /assets: cache them "forever".
    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location /api/ {
        proxy_pass http://api:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SignalR: WebSocket upgrade, long-lived, unbuffered.
    location /hubs/ {
        proxy_pass http://api:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1h;
        proxy_buffering off;
    }

    # Client-side routes (/projects/…, /play/…) all serve index.html, which must never be cached.
    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
        add_header X-Content-Type-Options "nosniff";
        add_header Referrer-Policy "strict-origin-when-cross-origin";
    }
}
```

**5. `web/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/ ./
RUN npm run build

FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
```

:::warn title="VITE_ variables are baked in at build time"
`import.meta.env.VITE_*` is replaced with literal strings during `npm run build`. An image built
with a staging OIDC authority will talk to staging forever. Either pass them as `--build-arg` and
build one image per environment, or (the usual choice for "build once, deploy everywhere") have
the SPA fetch a small `/config.json` at startup that nginx or the API serves per environment.
:::

**6. Build and inspect**

```bash
docker build -f api/Dockerfile --target runtime  -t branchstory/api:dev .
docker build -f api/Dockerfile --target migrator -t branchstory/migrator:dev .
docker build -f worker/Dockerfile -t branchstory/worker:dev .
docker build -f web/Dockerfile    -t branchstory/web:dev .
docker images 'branchstory/*'
docker run --rm --entrypoint id branchstory/api:dev       # uid=1654(app), not root
```

Touch a `.cs` file and rebuild the API: the restore layer comes from cache and only publish runs.

- [ ] Four images build from the repository root; none contains the .NET SDK or `node_modules`
- [ ] `id` inside the api and worker images reports a non-root user
- [ ] A source-only change rebuilds without re-running `dotnet restore` or `npm ci`
- [ ] `docker run --rm branchstory/migrator:dev --help` prints the EF bundle's usage
:::

## Lab 2: the whole stack in one command

:::lab id=cap-10-lab2 xp=100
title: deploy/compose.yaml with health-gated startup

Replace the Postgres-only compose file from cap-02 with the full stack. The `db` service, the
database name and the `dbdata` volume stay the same, so your existing data survives.

**1. `deploy/compose.yaml`**

```yaml
name: branchstory

x-dotnet-env: &dotnet-env
  ConnectionStrings__BranchStory: Host=db;Port=5432;Database=branchstory;Username=branchstory;Password=${POSTGRES_PASSWORD:-branchstory};Keepalive=30
  # Development enables the cap-03 dev token issuer. Use Production once Auth points at a real issuer.
  ASPNETCORE_ENVIRONMENT: ${APP_ENVIRONMENT:-Development}
  ASPNETCORE_FORWARDEDHEADERS_ENABLED: "true"
  OTEL_EXPORTER_OTLP_ENDPOINT: ${OTEL_EXPORTER_OTLP_ENDPOINT:-}

services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: branchstory
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-branchstory}
      POSTGRES_DB: branchstory
    ports: ["127.0.0.1:5432:5432"]          # for dotnet run / psql on the host; drop it in shared environments
    volumes:
      - dbdata:/var/lib/postgresql           # PG 18 images: mount the parent, not …/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U branchstory -d branchstory"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  migrate:
    build: { context: .., dockerfile: api/Dockerfile, target: migrator }
    image: branchstory/migrator:dev
    command: ["--connection", "Host=db;Port=5432;Database=branchstory;Username=branchstory;Password=${POSTGRES_PASSWORD:-branchstory}"]
    depends_on:
      db: { condition: service_healthy }
    restart: "no"

  api:
    build: { context: .., dockerfile: api/Dockerfile, target: runtime }
    image: branchstory/api:dev
    environment:
      <<: *dotnet-env
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      # No curl in the runtime image on purpose: bash's /dev/tcp is enough for an HTTP/1.0 probe.
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /health/ready HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && grep -q ' 200 ' <&3"]
      interval: 5s
      timeout: 3s
      retries: 3                             # 3 misses x 5 s: unhealthy ~15 s after the DB goes away
      start_period: 60s                      # boot time: failures here don't count, the first pass marks it healthy
    restart: unless-stopped

  worker:
    build: { context: .., dockerfile: worker/Dockerfile }
    image: branchstory/worker:dev
    environment:
      <<: *dotnet-env
      Worker__Concurrency: "2"
    depends_on:
      migrate: { condition: service_completed_successfully }
    healthcheck:
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8081 && printf 'GET /health/live HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3 && grep -q ' 200 ' <&3"]
      interval: 10s
      timeout: 3s
      retries: 6
      start_period: 10s
    stop_grace_period: 40s                   # > HostOptions.ShutdownTimeout (30 s): jobs get released, not killed
    restart: unless-stopped

  web:
    build: { context: .., dockerfile: web/Dockerfile }
    image: branchstory/web:dev
    ports: ["127.0.0.1:8080:8080"]            # localhost only; a real server sits behind a TLS proxy
    depends_on:
      api: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/healthz"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped

  # docker compose --profile observability up -d   (then open http://localhost:3000)
  lgtm:
    image: grafana/otel-lgtm:latest
    profiles: [observability]
    ports: ["127.0.0.1:3000:3000", "127.0.0.1:4317:4317", "127.0.0.1:4318:4318"]

volumes:
  dbdata:
```

**2. Bring it up and watch the order**

```bash
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml logs migrate     # "Applying migration …" then "Done."
```

`db` becomes healthy → `migrate` runs and exits 0 → `api` and `worker` start → `api` becomes
healthy → `web` starts. Open http://localhost:8080, sign in, edit, publish, play.

Each part of the file has a job:

* **`depends_on` with a `condition`** waits for the dependency's *state*, not just its start.
  `service_healthy` waits until the dependency's `healthcheck` passes. `service_completed_successfully`
  waits until a one-shot container has **exited with code 0**. A plain `depends_on: [db]` only
  waits until the `db` container has *started*, and Postgres needs a few seconds after that before
  it accepts connections. That gap is where "works on the second `up`" bugs come from.
* **`x-dotnet-env: &dotnet-env`** is a YAML anchor. Compose ignores top-level keys that start
  with `x-`, and `<<: *dotnet-env` pastes the block into each service, so api and worker can't drift
  apart.
* **Healthchecks only report.** In plain Docker Compose, an `unhealthy` container is **not**
  restarted (`restart:` only reacts to the process exiting). Health status gates `depends_on` and
  shows up in `ps`. That is why stopping the database below leaves the API running and unhealthy,
  just like a failing readiness probe in Kubernetes. "Unhealthy" is not instant: Docker needs
  `retries` consecutive failures, one every `interval`, so the api flips after about 3 x 5 s = 15 s.
  `start_period` is the grace window for boot: failures inside it don't count, which is why the
  api can use a small `retries` without being marked unhealthy while it starts.

**3. Break it on purpose**

```bash
docker compose -f deploy/compose.yaml stop db
sleep 20                                            # unhealthy needs 3 failed checks in a row (retries x interval = ~15 s)
docker compose -f deploy/compose.yaml ps            # api now "unhealthy" (readiness), still running
docker compose -f deploy/compose.yaml logs worker   # "Claim failed … backing off", no crash loop
docker compose -f deploy/compose.yaml start db      # both recover on their own
```

Then publish a story and immediately `docker compose -f deploy/compose.yaml restart worker`: the
log shows the job being released on shutdown and finished after the restart.

:::warn title="PostgreSQL 18 changed the volume path"
The `postgres:18` images keep data under `/var/lib/postgresql/18/docker` and declare the volume
at `/var/lib/postgresql`, so major upgrades can live side by side. Mounting a volume at the old
`/var/lib/postgresql/data` path makes the container refuse to start. A volume created by a 17.x
image is **not** upgraded automatically: dump and restore (or `pg_upgrade`) when you bump majors.
:::

- [ ] `docker compose up -d --build` starts everything in dependency order and `ps` shows all long-running services healthy
- [ ] The full flow (sign in, edit, publish, open the player) works through http://localhost:8080 only, including the live SignalR status
- [ ] Stopping Postgres makes the API unhealthy but not restarting, and both api and worker recover when it returns
- [ ] Restarting the worker during a publish releases and then completes the job
:::

## Lab 3: observability basics

:::lab id=cap-10-lab3 xp=80
title: Structured logs, traces and metrics with OpenTelemetry

Three signals, three questions: **logs** (what happened to *this* job?), **metrics** (is the queue
growing? are publishes slower than yesterday?), **traces** (where did these 900 ms go: SQL,
SignalR, the CDN?). OpenTelemetry gives you all three with one vendor-neutral setup.

**1. A shared defaults project**

```bash
dotnet new classlib -n BranchStory.ServiceDefaults -o api/BranchStory.ServiceDefaults
rm api/BranchStory.ServiceDefaults/Class1.cs
cd api/BranchStory.ServiceDefaults
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
dotnet add package OpenTelemetry.Instrumentation.Runtime
cd ../..
dotnet sln add api/BranchStory.ServiceDefaults
dotnet add api/BranchStory.Api reference api/BranchStory.ServiceDefaults
dotnet add worker/BranchStory.Worker reference api/BranchStory.ServiceDefaults
```

Add the ASP.NET Core shared framework to `BranchStory.ServiceDefaults.csproj`, inside `<Project>`:

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

**2. `api/BranchStory.ServiceDefaults/Observability.cs`**

```csharp
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace BranchStory.ServiceDefaults;

public static class Observability
{
    public static TBuilder AddObservability<TBuilder>(this TBuilder builder, string serviceName)
        where TBuilder : IHostApplicationBuilder
    {
        // One JSON object per line: readable with jq locally, parseable by Loki/Elastic/CloudWatch.
        builder.Logging.ClearProviders();
        builder.Logging.AddJsonConsole(o =>
        {
            o.IncludeScopes = true;                       // carries JobId / ProjectId from BeginScope
            o.UseUtcTimestamp = true;
            o.TimestampFormat = "yyyy-MM-ddTHH:mm:ss.fffZ";
        });
        builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.IncludeFormattedMessage = true; });

        var otel = builder.Services.AddOpenTelemetry()
            .ConfigureResource(r => r.AddService(serviceName))
            .WithTracing(t => t
                .AddAspNetCoreInstrumentation(o => o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health"))
                .AddHttpClientInstrumentation()
                .AddSource("Npgsql")
                .AddSource("BranchStory.*"))
            .WithMetrics(m => m
                .AddAspNetCoreInstrumentation()
                .AddHttpClientInstrumentation()
                .AddRuntimeInstrumentation()
                .AddMeter("Npgsql")
                .AddMeter("BranchStory.*"));

        // Export only when a collector is configured: compose profile, or the cluster's collector.
        if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
            otel.UseOtlpExporter();

        return builder;
    }
}
```

**3. Business metrics in the worker: `worker/BranchStory.Worker/Jobs/WorkerTelemetry.cs`**

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;

namespace BranchStory.Worker.Jobs;

public sealed class WorkerTelemetry
{
    public static readonly ActivitySource Source = new("BranchStory.Worker");
    private static readonly Meter Meter = new("BranchStory.Worker");

    private readonly Counter<long> _finished = Meter.CreateCounter<long>(
        "branchstory.jobs.finished", description: "Job attempts by kind and outcome (succeeded, retry, failed, released)");
    private readonly Histogram<double> _duration = Meter.CreateHistogram<double>(
        "branchstory.jobs.duration", unit: "s", description: "Handler run time per attempt");

    public void Record(string kind, string outcome, TimeSpan elapsed)
    {
        var tags = new TagList { { "job.kind", kind }, { "job.outcome", outcome } };
        _finished.Add(1, tags);
        _duration.Record(elapsed.TotalSeconds, tags);
    }
}
```

Wire it into the cap-08 `JobRunner`:

```csharp
// constructor: add one parameter
public sealed class JobRunner(
    JobStore store, IEnumerable<IJobHandler> handlers, WorkerHeartbeat heartbeat,
    IOptions<WorkerOptions> options, ILogger<JobRunner> log, WorkerTelemetry telemetry) : BackgroundService

// top of RunOneAsync, after BeginScope: one span per attempt (cap-08 already records 'started' just before the try; reuse it)
using var activity = WorkerTelemetry.Source.StartActivity($"job {job.Kind}");
activity?.SetTag("job.id", job.Id);
activity?.SetTag("job.attempt", job.Attempts);

// in each branch, next to the existing log line:
telemetry.Record(job.Kind, "succeeded", TimeProvider.System.GetElapsedTime(started));   // success
telemetry.Record(job.Kind, "released",  TimeProvider.System.GetElapsedTime(started));   // shutdown
telemetry.Record(job.Kind, "failed",    TimeProvider.System.GetElapsedTime(started));   // PermanentJobException / last attempt
telemetry.Record(job.Kind, "retry",     TimeProvider.System.GetElapsedTime(started));   // retry branch
```

**4. Call it from both `Program.cs` files**, right after `CreateBuilder`:

```csharp
using BranchStory.ServiceDefaults;

builder.AddObservability("branchstory-api");      // in the API
builder.AddObservability("branchstory-worker");   // in the worker, plus:
builder.Services.AddSingleton<WorkerTelemetry>();
```

The API should already expose `/health/live` (no dependencies) and `/health/ready` (database
check) from cap-03. If your paths differ, keep them and adjust the probes in Lab 4 instead of
mapping a second set.

**5. Look at it**

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4317 docker compose -f deploy/compose.yaml --profile observability up -d --build
docker compose -f deploy/compose.yaml logs worker --no-log-prefix | jq -c 'select(.Category == "BranchStory.Worker.Jobs.JobRunner") | {LogLevel, Message, Scopes}'
```

Publish a few stories, then open Grafana at http://localhost:3000 (admin/admin): **Explore →
Tempo** shows a `POST /api/projects/{projectId}/publish` trace with its SQL spans and separate
`job publish` traces from the worker; **Explore → Prometheus** has
`branchstory_jobs_finished_total` and `http_server_request_duration_seconds`.

:::pro title="Alert on symptoms, not causes"
Page a human for what users feel: publish success rate below 99 % over 15 minutes, p95 API latency
above 1 s, oldest ready job older than 2 minutes, any new dead-letter. CPU at 80 % is a dashboard
graph, not a 3 a.m. page.
:::

- [ ] API and worker logs are one JSON object per line, and worker lines carry `JobId` and `ProjectId` in `Scopes`
- [ ] With the observability profile, a publish shows up as an API trace with SQL spans and a worker `job publish` trace
- [ ] `branchstory_jobs_finished_total` is visible in Grafana with `job_outcome` labels
- [ ] Health-check requests do not appear as traces
:::

:::sql id=cap-10-sql1 db=empty xp=30
title: The number an autoscaler needs
KEDA can scale the worker Deployment on the result of a SQL query. Write the query that returns a
**single number**: how many `publish` jobs are waiting for a worker right now. That is jobs that
are `queued` and due (`run_after <= now()`) plus jobs that are `running` with an **expired** lease
(they will be reclaimed; the reaper takes care of the ones without attempts left, so you can
ignore `attempts` here). Jobs waiting for a retry in the future, healthy running jobs and finished
jobs don't count, and neither do other kinds.

hint: One `SELECT count(*) FROM jobs WHERE kind = 'publish' AND (… OR …)`.
hint: Parentheses matter: `AND` binds tighter than `OR`.

```sql setup
CREATE TABLE jobs (
  id bigint PRIMARY KEY, kind text NOT NULL, status text NOT NULL,
  run_after timestamptz NOT NULL, leased_until timestamptz
);
INSERT INTO jobs VALUES
  (1, 'publish',   'queued',    now() - interval '10 seconds', NULL),
  (2, 'publish',   'queued',    now() - interval '3 minutes',  NULL),
  (3, 'publish',   'queued',    now() + interval '2 minutes',  NULL),
  (4, 'publish',   'running',   now() - interval '1 minute',   now() + interval '20 seconds'),
  (5, 'publish',   'running',   now() - interval '5 minutes',  now() - interval '30 seconds'),
  (6, 'publish',   'succeeded', now() - interval '1 hour',     NULL),
  (7, 'publish',   'failed',    now() - interval '1 hour',     NULL),
  (8, 'thumbnail', 'queued',    now() - interval '1 minute',   NULL);
```

```sql starter
SELECT count(*) FROM jobs WHERE status = 'queued';
```

```sql solution
SELECT count(*) FROM jobs
WHERE kind = 'publish'
  AND ((status = 'queued' AND run_after <= now())
    OR (status = 'running' AND leased_until < now()));
```
:::

## Lab 4: Kubernetes on kind with kustomize

:::lab id=cap-10-lab4 xp=150
title: Deploy BranchStory to a local kind cluster behind Traefik

:::info title="Why Traefik and not ingress-nginx?"
The community `ingress-nginx` controller was retired by Kubernetes SIG Network (maintenance ended
in March 2026), so new clusters should not start on it. Traefik implements both the classic
`Ingress` API used here and the newer **Gateway API**, which is where the ecosystem is heading.
The manifests below only need `ingressClassName` changed to run on any other controller.
:::

Prerequisites: `kind`, `kubectl`, `helm` and Docker (or Podman with
`KIND_EXPERIMENTAL_PROVIDER=podman`).

The tools, briefly:

* **kind** ("Kubernetes in Docker") runs a whole cluster inside one Docker container per node.
  It is disposable and free, and its API is the same one a cloud cluster has.
* **kustomize** (built into `kubectl` as `kubectl apply -k`) builds the final manifests from a
  **base** (what every environment shares) plus an **overlay** per environment (kind, staging,
  prod) that patches image tags, config values and secrets. Plain YAML, no templating language.
  Its **generators** create ConfigMaps and Secrets with a hash of their content in the name
  (`branchstory-config-7g2k9m`), so changing a value changes the name the pods reference and
  triggers a rollout.
* **Traefik** is the Ingress controller: the pod that receives HTTP from outside the cluster and
  routes `/api` and `/hubs` to the api Service and everything else to web, based on the `Ingress`
  object in step 9.

**1. Layout**

```text
deploy/
  kind/cluster.yaml
  kind/up.sh
  k8s/base/        kustomization.yaml namespace.yaml postgres.yaml api.yaml worker.yaml web.yaml ingress.yaml backup.yaml
  k8s/overlays/kind/  kustomization.yaml secrets.env.example  (secrets.env is git-ignored)
```

**2. `deploy/kind/cluster.yaml`**: host port 8088 → Traefik's NodePort

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: branchstory
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080
        hostPort: 8088
        protocol: TCP
```

**3. `deploy/k8s/base/kustomization.yaml`**

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: branchstory
labels:
  - pairs:
      app.kubernetes.io/part-of: branchstory
resources:
  - namespace.yaml
  - postgres.yaml
  - api.yaml
  - worker.yaml
  - web.yaml
  - ingress.yaml
  - backup.yaml
# Generated with a content hash in the name: changing a value rolls the pods automatically.
configMapGenerator:
  - name: branchstory-config
    literals:
      - ASPNETCORE_ENVIRONMENT=Production
      - ASPNETCORE_FORWARDEDHEADERS_ENABLED=true
      - Worker__Concurrency=2
      - Logging__LogLevel__Default=Information
      - OTEL_EXPORTER_OTLP_ENDPOINT=
```

Only *operational* knobs live here. The plan limits (5 or 100 publishes a day, cap-04's
`PlanLimits`) are deliberately **not** configuration: they are product rules billed to the owner,
they belong in code with tests, and a per-cluster override would mean two environments sell
different plans.

**4. `deploy/k8s/base/namespace.yaml`**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: branchstory
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: restricted
```

**5. `deploy/k8s/base/postgres.yaml`**: fine for kind; see "what next" for production

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
spec:
  selector: { app: postgres }
  ports: [{ name: pg, port: 5432, targetPort: pg }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
spec:
  serviceName: postgres
  replicas: 1
  selector: { matchLabels: { app: postgres } }
  template:
    metadata: { labels: { app: postgres } }
    spec:
      containers:
        - name: postgres
          image: postgres:18
          ports: [{ name: pg, containerPort: 5432 }]
          env:
            - { name: POSTGRES_USER, value: branchstory }
            - { name: POSTGRES_DB, value: branchstory }
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: branchstory-secrets, key: POSTGRES_PASSWORD } }
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "branchstory", "-d", "branchstory"] }
            periodSeconds: 5
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 1Gi }
          volumeMounts:
            - { name: data, mountPath: /var/lib/postgresql }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 2Gi } }
```

**6. `deploy/k8s/base/api.yaml`**: migrations as an init container, three probes, hardened

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
  annotations:
    # SignalR negotiates over HTTP, then upgrades: with >1 replica both must hit the same pod.
    traefik.ingress.kubernetes.io/service.sticky.cookie: "true"
    traefik.ingress.kubernetes.io/service.sticky.cookie.name: bs_affinity
spec:
  selector: { app: api }
  ports: [{ name: http, port: 8080, targetPort: http }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 1
  selector: { matchLabels: { app: api } }
  strategy:
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }
  template:
    metadata: { labels: { app: api } }
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      initContainers:
        - name: migrate
          image: branchstory/migrator
          imagePullPolicy: IfNotPresent
          # EF Core 9+ takes a database lock while migrating, so concurrent replicas are safe.
          args: ["--connection", "$(ConnectionStrings__BranchStory)"]
          env:
            - name: ConnectionStrings__BranchStory
              valueFrom: { secretKeyRef: { name: branchstory-secrets, key: ConnectionStrings__BranchStory } }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      containers:
        - name: api
          image: branchstory/api
          imagePullPolicy: IfNotPresent
          ports: [{ name: http, containerPort: 8080 }]
          envFrom: [{ configMapRef: { name: branchstory-config } }]
          env:
            - name: ConnectionStrings__BranchStory
              valueFrom: { secretKeyRef: { name: branchstory-secrets, key: ConnectionStrings__BranchStory } }
          startupProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 2
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /health/live, port: http }
            periodSeconds: 10
            failureThreshold: 3
          readinessProbe:
            httpGet: { path: /health/ready, port: http }
            periodSeconds: 5
            failureThreshold: 2
          resources:
            requests: { cpu: 100m, memory: 192Mi }
            limits: { memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes:
        - { name: tmp, emptyDir: {} }
```

**7. `deploy/k8s/base/worker.yaml`**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
spec:
  replicas: 2
  selector: { matchLabels: { app: worker } }
  template:
    metadata: { labels: { app: worker } }
    spec:
      terminationGracePeriodSeconds: 45     # > 30 s ShutdownTimeout: in-flight jobs are released cleanly
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: worker
          image: branchstory/worker
          imagePullPolicy: IfNotPresent
          ports: [{ name: http, containerPort: 8081 }]
          envFrom: [{ configMapRef: { name: branchstory-config } }]
          env:
            - name: ConnectionStrings__BranchStory
              valueFrom: { secretKeyRef: { name: branchstory-secrets, key: ConnectionStrings__BranchStory } }
            - name: Worker__WorkerId
              valueFrom: { fieldRef: { fieldPath: metadata.name } }   # pod name shows up in locked_by
          livenessProbe:
            httpGet: { path: /health/live, port: http }
            initialDelaySeconds: 10
            periodSeconds: 15
            failureThreshold: 4
          readinessProbe:
            httpGet: { path: /health/ready, port: http }
            periodSeconds: 10
          resources:
            requests: { cpu: 100m, memory: 160Mi }
            limits: { memory: 512Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes:
        - { name: tmp, emptyDir: {} }
```

**8. `deploy/k8s/base/web.yaml`**

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app: web }
  ports: [{ name: http, port: 80, targetPort: http }]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: web
          image: branchstory/web
          imagePullPolicy: IfNotPresent
          ports: [{ name: http, containerPort: 8080 }]
          readinessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /healthz, port: http }
            periodSeconds: 15
          resources:
            requests: { cpu: 20m, memory: 32Mi }
            limits: { memory: 128Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: [ALL] }
          volumeMounts: [{ name: tmp, mountPath: /tmp }]
      volumes:
        - { name: tmp, emptyDir: {} }
```

**9. `deploy/k8s/base/ingress.yaml`**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: branchstory
spec:
  ingressClassName: traefik
  rules:
    - http:
        paths:
          - path: /api
            pathType: Prefix
            backend: { service: { name: api, port: { number: 8080 } } }
          - path: /hubs
            pathType: Prefix
            backend: { service: { name: api, port: { number: 8080 } } }
          - path: /
            pathType: Prefix
            backend: { service: { name: web, port: { number: 80 } } }
```

**10. `deploy/k8s/base/backup.yaml`**: a 6-hourly `pg_dump` with 7-day retention

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pg-backups
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 2Gi } }
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pg-backup
spec:
  schedule: "0 */6 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: pg-dump
              image: postgres:18
              env:
                - { name: PGHOST, value: postgres }
                - { name: PGUSER, value: branchstory }
                - { name: PGDATABASE, value: branchstory }
                - name: PGPASSWORD
                  valueFrom: { secretKeyRef: { name: branchstory-secrets, key: POSTGRES_PASSWORD } }
              command: ["/bin/sh", "-c"]
              args:
                - |
                  set -eu
                  f="/backups/branchstory-$$(date -u +%Y%m%dT%H%M%SZ).dump"
                  pg_dump --format=custom --no-owner --file="$f.partial"
                  mv "$f.partial" "$f"
                  find /backups -name 'branchstory-*.dump' -mtime +7 -delete
                  ls -lh /backups
              volumeMounts: [{ name: backups, mountPath: /backups }]
          volumes:
            - name: backups
              persistentVolumeClaim: { claimName: pg-backups }
```

(`$$(` is how you write a literal `$(` in Kubernetes args, which would otherwise try to expand it
as a variable reference.)

**11. `deploy/k8s/overlays/kind/kustomization.yaml`** and its secrets

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: branchstory
resources:
  - ../../base
images:
  - { name: branchstory/api, newTag: dev }
  - { name: branchstory/migrator, newTag: dev }
  - { name: branchstory/worker, newTag: dev }
  - { name: branchstory/web, newTag: dev }
configMapGenerator:
  - name: branchstory-config
    behavior: merge
    literals:
      - ASPNETCORE_ENVIRONMENT=Development   # local cluster: dev token issuer on
secretGenerator:
  - name: branchstory-secrets
    envs: [secrets.env]
```

`deploy/k8s/overlays/kind/secrets.env.example` (commit this; copy it to `secrets.env`, which is in
`.gitignore` and `.dockerignore`):

```text
POSTGRES_PASSWORD=change-me-locally
ConnectionStrings__BranchStory=Host=postgres;Port=5432;Database=branchstory;Username=branchstory;Password=change-me-locally;Keepalive=30
```

**12. `deploy/kind/up.sh`**: one command, idempotent

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
CLUSTER=branchstory

kind get clusters | grep -qx "$CLUSTER" || kind create cluster --config deploy/kind/cluster.yaml

helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
helm repo update traefik >/dev/null
helm upgrade --install traefik traefik/traefik -n traefik --create-namespace \
  --set service.type=NodePort --set ports.web.nodePort=30080 --wait

docker build -f api/Dockerfile --target runtime  -t branchstory/api:dev .
docker build -f api/Dockerfile --target migrator -t branchstory/migrator:dev .
docker build -f worker/Dockerfile -t branchstory/worker:dev .
docker build -f web/Dockerfile    -t branchstory/web:dev .
kind load docker-image --name "$CLUSTER" branchstory/api:dev branchstory/migrator:dev branchstory/worker:dev branchstory/web:dev

test -f deploy/k8s/overlays/kind/secrets.env || { echo "copy secrets.env.example to secrets.env first" >&2; exit 1; }
kubectl apply -k deploy/k8s/overlays/kind
# Same :dev tag, new image content: restart so pods pick it up.
kubectl -n branchstory rollout restart deployment/api deployment/worker deployment/web
for r in statefulset/postgres deployment/api deployment/worker deployment/web; do
  kubectl -n branchstory rollout status "$r" --timeout=300s
done
echo "BranchStory is up at http://localhost:8088"
```

```bash
chmod +x deploy/kind/up.sh
cp deploy/k8s/overlays/kind/secrets.env.example deploy/k8s/overlays/kind/secrets.env
kubectl kustomize deploy/k8s/overlays/kind | less     # read what you are about to apply
./deploy/kind/up.sh
```

**13. Operate it**

```bash
kubectl -n branchstory get pods,svc,ingress
kubectl -n branchstory logs deploy/api -c migrate              # the migrations that ran
kubectl -n branchstory logs -l app=worker -f --max-log-requests 5 | jq -c '{LogLevel, Message}'

# Backups: run one now instead of waiting for the schedule, then look at it
kubectl -n branchstory create job --from=cronjob/pg-backup pg-backup-now
kubectl -n branchstory logs job/pg-backup-now

# Kill a worker mid-publish: its lease expires and the other replica takes the job
kubectl -n branchstory delete pod -l app=worker --wait=false
```

:::pro title="Restore drills or it didn't happen"
A backup you never restored is a hope, not a backup. Once a month: `pg_restore --create` the
newest dump into a scratch database (or a throwaway cluster), run a smoke query
(`SELECT count(*) FROM projects`), and write down how long it took. That number is your real RTO.
:::

:::job title="Tags in real pipelines"
Local `:dev` tags plus `rollout restart` are fine on kind. CI pipelines tag images with the git SHA
(`kustomize edit set image branchstory/api=ghcr.io/acme/branchstory-api:$GITHUB_SHA`), so every
deploy is traceable and a rollback is "apply the previous SHA". Never deploy `:latest`. Lab 6
builds exactly that pipeline.
:::

- [ ] `./deploy/kind/up.sh` brings up the cluster and all pods become Ready; the migrate init container log shows the applied migrations
- [ ] http://localhost:8088 serves the app; sign-in, editing with live presence, publishing and the public player work through Traefik
- [ ] Adding `Logging__LogLevel__Default=Debug` to the kind overlay's `configMapGenerator` literals and re-applying rolls the api and worker pods (new ConfigMap hash), and their logs get chattier
- [ ] `kubectl create job --from=cronjob/pg-backup` writes a `.dump` file, and `pg_restore --list` can read it
- [ ] Deleting a worker pod during a publish does not lose the job
- [ ] `secrets.env` is not tracked by git and not in any image
:::

:::quiz id=cap-10-q2 xp=15
You scale the API Deployment to **3 replicas**. Which changes does SignalR collaboration need?
Select all that apply.
- [x] Sticky sessions at the ingress (or clients that skip negotiation and use WebSockets only), because the negotiate request and the WebSocket must reach the same pod
- [x] A backplane (Redis or Azure SignalR Service), so a patch sent by a client connected to pod A reaches group members connected to pods B and C
- [ ] Nothing: Kubernetes Services load-balance WebSockets automatically
- [ ] A separate database per replica
> A SignalR connection starts with an HTTP `negotiate` request that creates connection state on
> one pod. The WebSocket that follows must land on that same pod, or the server answers "No
> Connection with that ID". "Nothing" is the tempting answer because a WebSocket, once open, does
> stay on one pod, but the *negotiate* request and the upgrade are separate requests that the load
> balancer is free to spread. Job status already works across replicas because every pod LISTENs on
> Postgres. Client-originated hub messages (presence, live patches) only reach connections on the
> same pod unless a backplane relays them. A database per replica would split your data, not fix
> messaging.
:::

:::quiz id=cap-10-q3 xp=15
Why are migrations run by a dedicated **migrator** (init container or Job) instead of
`db.Database.Migrate()` in the API's `Program.cs`?
- [ ] EF Core cannot migrate from inside a web application
- [x] Schema changes become an explicit, logged deploy step with its own privileges; the app's runtime user need not own the schema, and a failed migration stops the rollout before any new code serves traffic
- [ ] Init containers run faster than application code
- [ ] It is required for PostgreSQL 18
> Startup migrations are fine in development. In production you want the schema change visible,
> ordered before the new pods, and runnable by a more privileged role than the app's day-to-day
> connection. EF Core *can* migrate from inside the app (`Database.Migrate()` works), so the first
> option is wrong. That is exactly why the habit spreads from development into production. Init
> containers are not faster, and PostgreSQL 18 has no such requirement.
:::

:::quiz id=cap-10-q4 xp=15
A teammate deletes both `configMapGenerator` entries (base and kind overlay) and adds a
hand-written `ConfigMap` named `branchstory-config` to the base, then changes `Worker__Concurrency`
from 2 to 4 and runs `kubectl apply -k`. The worker pods read their config through `envFrom`. What
do the **running** pods see?
- [x] Still 2: environment variables are read when a container starts, and nothing in the pod template changed, so no rollout happens
- [ ] 4 within a minute, because the kubelet syncs ConfigMaps into running pods
- [ ] 4 immediately, because `kubectl apply` restarts every pod that references the ConfigMap
- [ ] The apply fails because a ConfigMap can't be changed while pods use it
> Environment variables are copied into the process once, at container start. The tempting answer
> is the kubelet sync, which is real, but it only updates ConfigMaps **mounted as files** (after a
> delay), never env vars. `kubectl apply` doesn't restart anything unless the pod template changes.
> The generator's content hash in the name does exactly that, which is why the lesson uses it.
> Without it you'd need a manual `kubectl rollout restart`.
:::

:::quiz id=cap-10-q5 xp=15
The web image is built once in CI with `VITE_API_URL=https://staging.branchstory.dev` and then
promoted unchanged to production, where the container gets `-e VITE_API_URL=https://branchstory.dev`.
Which API does the production SPA call?
- [ ] `https://branchstory.dev`, because the container's environment wins at runtime
- [x] `https://staging.branchstory.dev`, because Vite replaced `import.meta.env.VITE_API_URL` with that string at build time
- [ ] Neither: nginx strips unknown environment variables, so the value is `undefined`
- [ ] It depends on whether the browser cached the old `index.html`
> The SPA is static JavaScript running in the user's browser. It has no access to the container's
> environment. `npm run build` pasted the staging URL into the bundle as a literal string. Setting
> `-e` on the nginx container is the tempting fix because that is how the .NET images are
> configured, but it only changes nginx's own environment. For "build once, deploy everywhere",
> load a per-environment `/config.json` at startup, or use relative URLs (`/api/...`) behind the
> same Ingress, which BranchStory does.
:::

## Lab 5: harden the edge

Everything so far assumed well-behaved clients. The internet isn't one. Before 1.0, look at what
an anonymous stranger or a buggy script can reach:

| Surface | Who can call it | What goes wrong without a limit |
|---|---|---|
| `POST /api/dev/token` | anyone, in Development (compose and the kind overlay) | a script mints thousands of users |
| `GET /api/public/stories/{slug}` | anyone | slug guessing, scraping, a traffic spike that starves the editor |
| `POST /api/projects/{id}/publish` | editors and owners | a client stuck in a retry loop fills the queue (each job costs worker CPU) |
| `PUT /api/projects/{id}/doc` | editors and owners | a 200 MB body ties up a request thread and memory |
| the SPA document | anyone | an injected `<script>` (via a dependency or a missed escape) runs with the user's token |

**Rate limits are not quotas.** cap-04's quotas are *product rules*: per owner, per day, billed,
answered with `403` and a plan-limit `type`, because waiting doesn't help. Rate limits protect the
*system*: per caller, per second or minute, answered with **`429 Too Many Requests`** and a
`Retry-After` header, because waiting is exactly what helps. A request can pass one and fail the
other.

:::lab id=cap-10-lab6 xp=120
title: Rate limits, body limits, security headers and a vulnerability gate

**1. Rate-limit policies**: `api/BranchStory.Api/Security/RateLimits.cs`. ASP.NET Core's rate
limiter is part of the shared framework, so there is no package to add. Limits are *operational*
knobs, so unlike the plan limits they come from configuration.

```csharp
using System.Globalization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace BranchStory.Api.Security;

public sealed class EdgeLimits
{
    public int AnonymousPerMinute { get; set; } = 60;          // per client IP: dev token, public player
    public int PublishesPerMinute { get; set; } = 10;          // per user: abuse protection, not the daily quota
    public int UserRequestsPer10Seconds { get; set; } = 100;   // per user: the ceiling for everything
}

public static class RateLimits
{
    public const string Anonymous = "anonymous";
    public const string Publish = "publish";

    public static IServiceCollection AddBranchStoryRateLimits(this IServiceCollection services, IConfiguration config)
    {
        var limits = config.GetSection("RateLimits").Get<EdgeLimits>() ?? new EdgeLimits();

        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.OnRejected = async (ctx, ct) =>
            {
                if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                    ctx.HttpContext.Response.Headers.RetryAfter =
                        ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(CultureInfo.InvariantCulture);
                var problems = ctx.HttpContext.RequestServices.GetRequiredService<IProblemDetailsService>();
                await problems.WriteAsync(new ProblemDetailsContext
                {
                    HttpContext = ctx.HttpContext,
                    ProblemDetails =
                    {
                        Status = StatusCodes.Status429TooManyRequests,
                        Title = "Too many requests",
                        Detail = "Slow down and retry after the Retry-After delay.",
                    },
                });
            };

            // Every signed-in user gets a generous token bucket for all endpoints together. It catches
            // runaway clients without bothering humans. Anonymous requests are limited per endpoint below.
            o.GlobalLimiter = PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
                ctx.User.FindFirst("sub")?.Value is { } sub
                    ? RateLimitPartition.GetTokenBucketLimiter($"user:{sub}", _ => new TokenBucketRateLimiterOptions
                    {
                        TokenLimit = limits.UserRequestsPer10Seconds * 3,   // allows a short burst
                        TokensPerPeriod = limits.UserRequestsPer10Seconds,
                        ReplenishmentPeriod = TimeSpan.FromSeconds(10),
                        QueueLimit = 0,
                    })
                    : RateLimitPartition.GetNoLimiter("anonymous"));

            o.AddPolicy(Anonymous, ctx => RateLimitPartition.GetFixedWindowLimiter(
                $"ip:{ctx.Connection.RemoteIpAddress}",
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = limits.AnonymousPerMinute, Window = TimeSpan.FromMinutes(1), QueueLimit = 0,
                }));

            o.AddPolicy(Publish, ctx => RateLimitPartition.GetSlidingWindowLimiter(
                ctx.User.FindFirst("sub")?.Value ?? $"ip:{ctx.Connection.RemoteIpAddress}",
                _ => new SlidingWindowRateLimiterOptions
                {
                    PermitLimit = limits.PublishesPerMinute, Window = TimeSpan.FromMinutes(1),
                    SegmentsPerWindow = 6, QueueLimit = 0,
                }));
        });
        return services;
    }
}
```

The partition key is `"sub"` because cap-03 set `MapInboundClaims = false`. The client IP is the
real one only because `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` (compose and the ConfigMap)
makes the API read `X-Forwarded-For` from nginx or Traefik. That switch trusts **any** proxy. In
production, configure `ForwardedHeadersOptions.KnownIPNetworks` (the .NET 10 name; `KnownNetworks`
before) with your ingress range instead, or a client can send a fake `X-Forwarded-For` and get a
fresh rate-limit bucket on every request.

**2. Attach the policies** to the three endpoints that need them:

```csharp
// AuthEndpoints.MapDevAuth (cap-03)
app.MapPost("/api/dev/token", …).AllowAnonymous().RequireRateLimiting(RateLimits.Anonymous)
    .WithTags("Auth").WithName("CreateDevToken");

// PublishingEndpoints.MapPublishingEndpoints (cap-08)
api.MapPost("/projects/{id:guid}/publish", PublishAsync).RequireRateLimiting(RateLimits.Publish)
    .WithTags("Publishing").WithName("PublishProject");
api.MapGet("/public/stories/{slug}", GetPublicStoryAsync).AllowAnonymous().RequireRateLimiting(RateLimits.Anonymous)
    .WithTags("Public").WithName("GetPublicStory");
```

(Add `using BranchStory.Api.Security;` to both files.)

**3. Body limits, API headers and the middleware order**: in `api/BranchStory.Api/Program.cs`:

```csharp
using BranchStory.Api.Security;

// … registrations
builder.Services.AddBranchStoryRateLimits(builder.Configuration);
// Kestrel's default is ~28.6 MB. The largest real story (1000 scenes on Pro) is far below 4 MB.
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 4 * 1024 * 1024);

var app = builder.Build();
await app.MigrateIfConfiguredAsync();

app.UseExceptionHandler();
app.UseStatusCodePages();
// The API only ever returns JSON: tell browsers never to sniff, render or frame it.
app.Use(async (ctx, next) =>
{
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    ctx.Response.Headers.ContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";
    await next();
});
app.UseAuthentication();
app.UseRateLimiter();       // after authentication, so per-user partitions can see ctx.User
app.UseAuthorization();
```

Health endpoints must never be throttled, or a busy pod fails its probes and gets restarted. Add
`.DisableRateLimiting()` to both `MapHealthChecks(...)` calls. SignalR is covered at connect time
(negotiate and the WebSocket upgrade are HTTP requests). Messages on an open socket bypass
middleware, which is why cap-07 caps `MaximumReceiveMessageSize` and the operations per patch.

**4. Security headers for the SPA**: `deploy/nginx/security-headers.conf`

```nginx
# Only our own scripts and styles. Scene media may come from any https host (the player shows it).
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
```

nginx has a trap here: `add_header` in a `location` **replaces** every `add_header` inherited from
`server`, so headers declared once at the top silently vanish wherever a location adds its own
(both of ours do). Include the file in each location instead. In `deploy/nginx/default.conf`:

```nginx
    # inside server {}, next to server_tokens: nginx's default is 1 MB, the API allows 4 MB
    client_max_body_size 4m;

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
        include /etc/nginx/snippets/security-headers.conf;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache";
        include /etc/nginx/snippets/security-headers.conf;   # replaces the two add_header lines from Lab 1
    }
```

and copy the snippet into the image (`web/Dockerfile`, next to the other `COPY`):

```dockerfile
COPY deploy/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
```

`connect-src 'self'` covers `/api` and the same-origin WebSocket on `/hubs`. Adding Keycloak
(the token endpoint) or an error tracker (cap-05's `reportError`) means adding their origins
here. Roll a new CSP out as `Content-Security-Policy-Report-Only` first, click through every
screen with DevTools open, and switch to enforcing once the console is quiet. In kind, Traefik
sends `/api` and `/hubs` straight to the API, so the API's own headers from step 3 are the ones
those responses carry.

**5. Vulnerabilities fail the build.** NuGet audits packages during restore. Make high and
critical findings errors with a `Directory.Build.props` at the repository root (Lab 1's
Dockerfiles already explain how to copy it):

```xml
<Project>
  <PropertyGroup>
    <NuGetAudit>true</NuGetAudit>
    <NuGetAuditMode>all</NuGetAuditMode>      <!-- transitive packages too -->
    <NuGetAuditLevel>high</NuGetAuditLevel>
    <WarningsAsErrors>$(WarningsAsErrors);NU1903;NU1904</WarningsAsErrors>
  </PropertyGroup>
</Project>
```

Add `- run: npm audit --audit-level=high --omit=dev` after `npm ci` in the `web` job of cap-09's
`ci.yml`, and let Dependabot open the upgrade PRs, `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - { package-ecosystem: nuget,          directory: "/",    schedule: { interval: weekly } }
  - { package-ecosystem: npm,            directory: "/web", schedule: { interval: weekly } }
  - { package-ecosystem: github-actions, directory: "/",    schedule: { interval: weekly } }
  - { package-ecosystem: docker,         directories: ["/api", "/worker", "/web"], schedule: { interval: weekly } }
```

The base images get scanned too: Lab 6's delivery pipeline runs Trivy on every image before it
is pushed.

**6. Prove it** (compose stack from Lab 2, rebuilt):

```bash
docker compose -f deploy/compose.yaml up -d --build
# a token for the body-limit test, before the loop below uses up the dev-token budget
TOKEN=$(curl -s -X POST localhost:8080/api/dev/token -H 'content-type: application/json' \
  -d '{"username":"ada"}' | jq -r .accessToken)
PROJECT=$(curl -s localhost:8080/api/projects -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

for i in $(seq 1 70); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8080/api/dev/token \
    -H 'content-type: application/json' -d '{"username":"ada"}'
done | sort | uniq -c                     # about 59 × 200, the rest 429 (the token above used one permit)
curl -si -X POST localhost:8080/api/dev/token -H 'content-type: application/json' -d '{"username":"ada"}' | grep -i retry-after
curl -sI localhost:8080/ | grep -i content-security-policy
head -c 5000000 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -X PUT "localhost:8080/api/projects/$PROJECT/doc" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary @-   # 413
```

:::pro title="Where limits live in real systems"
The limiter above is in memory, so with three API replicas a user effectively gets three times the
budget. That is usually fine for abuse protection. When it isn't, use a shared store (Redis) or
enforce the coarse limits one hop earlier: Traefik's `RateLimit` middleware, a cloud WAF, or a CDN
in front of `/api/public/*` (the player's `Cache-Control` from Lab 7 lets the CDN answer most reads
without reaching you). Keep per-user limits in the app, because only the app knows who the user is.
:::

- [ ] The 61st dev-token request within a minute gets `429` with a `Retry-After` header and a ProblemDetails body
- [ ] An 11th publish within a minute from the same user gets `429`, while a free owner's 6th publish of the day still gets cap-04's `403` plan-limit problem
- [ ] `/health/live` and `/health/ready` are never throttled
- [ ] A 5 MB `PUT …/doc` is refused with `413` through both nginx (compose) and Traefik (kind)
- [ ] `index.html` and `/assets/*` responses carry the CSP and the other headers, the browser console shows no CSP violations while you edit, publish and play a story, and API responses carry `nosniff`
- [ ] A build with a known-vulnerable package version (try an old `System.Text.Json`) fails restore, and `npm audit` runs in CI
:::

:::quiz id=cap-10-q6 xp=15
Grace (Pro) has a script that publishes her story 200 times a minute. Ada (free) has used today's
5 publishes and clicks **Publish** once more. Which responses do they get?
- [ ] Both get `429`, because every limit is a rate limit
- [x] Grace gets `429` with `Retry-After` from the publish rate-limit policy; Ada gets cap-04's `403` plan-limit problem
- [ ] Both get `403` with the plan-limit `type`, so the frontend needs only one code path
- [ ] Grace gets nothing: Pro plans are exempt from limits
> They hit two different mechanisms. Grace is within her plan but is hammering the system, and waiting a few seconds genuinely helps, so the answer is `429` plus `Retry-After` (well-behaved clients back off on their own). Ada isn't hurting anything: she has used up a product allowance that her owner plan pays for, and retrying in a minute changes nothing, so the answer is the plan-limit `403` the UI turns into "upgrade or wait until tomorrow". Answering `429` there would invite automatic retries all day. The plan does not exempt anyone from rate limits: a Pro token in a buggy loop costs worker CPU just the same.
:::

## Lab 6: continuous delivery with a rehearsed rollback

So far "deploy" meant `./deploy/kind/up.sh` from your laptop: images built locally, tagged `:dev`,
and no record of which commit is running. Real delivery has four properties:

1. **Build once.** CI builds each image once per commit, tags it with the **git SHA** and pushes it
   to a registry. Every environment runs those exact bytes; nothing is rebuilt for production.
2. **Promote, don't rebuild.** The same SHA moves from staging to production after its smoke test
   passes, optionally behind a human approval.
3. **Deploy is one script.** The same script deploys a new SHA and rolls back to an old one, so
   the rollback path is exercised on every deploy instead of being discovered during an incident.
4. **Rollbacks are rehearsed.** You know how long one takes, because you've timed it.

:::lab id=cap-10-lab7 xp=120
title: Push SHA-tagged images to GHCR, smoke-test them in a throwaway cluster, roll back on purpose

**1. One deploy script for every environment**: `deploy/ci/deploy.sh`

```bash
#!/usr/bin/env bash
# Usage: REGISTRY=ghcr.io/<owner> deploy/ci/deploy.sh <overlay-dir> <git-sha>
# Points the overlay at that commit's images and applies it. Deploys and rollbacks both use it.
set -euo pipefail
OVERLAY=$1; SHA=$2
: "${REGISTRY:?set REGISTRY, for example ghcr.io/acme}"

( cd "$OVERLAY"
  for name in api migrator worker web; do
    kustomize edit set image "branchstory/$name=$REGISTRY/branchstory-$name:$SHA"
  done )
kubectl apply -k "$OVERLAY"
for r in deployment/api deployment/worker deployment/web; do
  kubectl -n branchstory rollout status "$r" --timeout=300s
done
echo "deployed $SHA"
```

`kustomize edit set image` rewrites the overlay's `images:` entries (Lab 4 set them to `:dev`), so
the image tag ends up in a file you can diff, commit or review. Install the `kustomize` CLI
locally; GitHub's Ubuntu runners already have it.

**2. A smoke test that walks the critical path**: `deploy/ci/smoke.sh`

```bash
#!/usr/bin/env bash
# Usage: deploy/ci/smoke.sh <base-url>. Needs the dev token issuer (kind overlay / staging).
set -euo pipefail
BASE=$1
RUN="smoke-$(date +%s)-$RANDOM"

curl -fsS "$BASE/" > /dev/null                                     # the SPA is served
TOKEN=$(curl -fsS -X POST "$BASE/api/dev/token" -H 'content-type: application/json' \
  -d "{\"username\":\"$RUN\"}" | jq -r .accessToken)
AUTH=(-H "Authorization: Bearer $TOKEN")
PROJECT=$(curl -fsS "${AUTH[@]}" -X POST "$BASE/api/projects" -H 'content-type: application/json' \
  -d '{"title":"Smoke test"}' | jq -r .id)
JOB=$(curl -fsS "${AUTH[@]}" -X POST "$BASE/api/projects/$PROJECT/publish" -H "Idempotency-Key: $RUN" | jq -r .jobId)

for _ in $(seq 1 60); do
  STATUS=$(curl -fsS "${AUTH[@]}" "$BASE/api/jobs/$JOB" | jq -r .status)
  [ "$STATUS" = succeeded ] && break
  [ "$STATUS" = failed ] && { echo "publish failed" >&2; exit 1; }
  sleep 2
done
[ "$STATUS" = succeeded ] || { echo "publish did not finish in 2 minutes" >&2; exit 1; }
SLUG=$(curl -fsS "${AUTH[@]}" "$BASE/api/jobs/$JOB" | jq -r .slug)
curl -fsS "$BASE/api/public/stories/$SLUG" | jq -e '.' > /dev/null
echo "smoke ok: /play/$SLUG"
```

`chmod +x deploy/ci/*.sh`, then run it against your kind cluster: `deploy/ci/smoke.sh http://localhost:8088`.

**3. The delivery workflow**: `.github/workflows/cd.yml`

```yaml
name: cd

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: cd-main
  cancel-in-progress: false        # never cancel a deploy halfway; queue the next one

jobs:
  images:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write              # push to GHCR with the workflow's own token, no PAT
    strategy:
      matrix:
        include:
          - { name: api,      file: api/Dockerfile,    target: runtime }
          - { name: migrator, file: api/Dockerfile,    target: migrator }
          - { name: worker,   file: worker/Dockerfile, target: runtime }
          - { name: web,      file: web/Dockerfile,    target: runtime }
    steps:
      - uses: actions/checkout@v6
      - run: echo "IMAGE=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/branchstory-${{ matrix.name }}:${GITHUB_SHA}" >> "$GITHUB_ENV"
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.file }}
          target: ${{ matrix.target }}
          load: true                 # into the runner's Docker, so it can be scanned before pushing
          tags: ${{ env.IMAGE }}
          cache-from: type=gha,scope=${{ matrix.name }}
          cache-to: type=gha,mode=max,scope=${{ matrix.name }}
      - name: Scan (fail on fixable HIGH/CRITICAL)
        run: >-
          docker run --rm -v /var/run/docker.sock:/var/run/docker.sock
          aquasec/trivy:latest image --exit-code 1 --severity HIGH,CRITICAL --ignore-unfixed "$IMAGE"
      - run: docker push "$IMAGE"

  staging:
    needs: images
    runs-on: ubuntu-latest
    timeout-minutes: 25
    environment: staging
    permissions:
      contents: read
      packages: read
    steps:
      - uses: actions/checkout@v6
      - run: echo "REGISTRY=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}" >> "$GITHUB_ENV"
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: helm/kind-action@v1
        with:
          cluster_name: branchstory
          config: deploy/kind/cluster.yaml
      - name: Traefik
        run: |
          helm repo add traefik https://traefik.github.io/charts
          helm upgrade --install traefik traefik/traefik -n traefik --create-namespace \
            --set service.type=NodePort --set ports.web.nodePort=30080 --wait
      - name: Load this commit's images (private packages: pull with our token, then side-load)
        run: |
          for name in api migrator worker web; do
            docker pull "$REGISTRY/branchstory-$name:$GITHUB_SHA"
            kind load docker-image --name branchstory "$REGISTRY/branchstory-$name:$GITHUB_SHA"
          done
      - run: cp deploy/k8s/overlays/kind/secrets.env.example deploy/k8s/overlays/kind/secrets.env
      - run: deploy/ci/deploy.sh deploy/k8s/overlays/kind "$GITHUB_SHA"
      - run: deploy/ci/smoke.sh http://localhost:8088
      - if: failure()
        run: kubectl -n branchstory logs deploy/api --all-containers --tail=200

  production:
    needs: staging
    if: vars.PRODUCTION_ENABLED == 'true'   # off until you have a real cluster
    runs-on: ubuntu-latest
    environment: production                # add required reviewers in Settings → Environments
    steps:
      - uses: actions/checkout@v6
      - run: echo "REGISTRY=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}" >> "$GITHUB_ENV"
      - name: Kubeconfig from the environment's secret
        env:
          KUBECONFIG_DATA: ${{ secrets.KUBECONFIG }}   # via env, never pasted into the script text
        run: |
          mkdir -p ~/.kube
          printf '%s' "$KUBECONFIG_DATA" > ~/.kube/config
          chmod 600 ~/.kube/config
      - run: deploy/ci/deploy.sh deploy/k8s/overlays/production "$GITHUB_SHA"
      - run: curl -fsS "${{ vars.PRODUCTION_URL }}/" > /dev/null
```

How to read it:

- **`images`** builds all four images in parallel, scans them, and pushes only clean ones. The tag
  is the commit SHA, so `kubectl get deploy api -o yaml | grep image:` tells you exactly which
  commit is live. Pin `aquasec/trivy` to a version in a real repo, and let Dependabot's `docker`
  entry bump it.
- **`staging`** is a throwaway kind cluster inside the runner: the *same overlay* as your laptop,
  but with the pushed images, followed by the smoke test. It catches broken manifests, failing
  migrations and a crashing image before any long-lived environment sees them.
- **`production`** promotes the same SHA. A GitHub *environment* with required reviewers turns it
  into "a human clicks Approve". `overlays/production` is yours to write when you have a cluster:
  `ASPNETCORE_ENVIRONMENT=Production`, a real `Auth__Authority`, secrets from a vault, more
  replicas, and an `imagePullSecret` for GHCR (or public packages). Production has no dev token
  issuer, so its smoke test stays shallow. A real one signs in as a dedicated synthetic user from
  your IdP.

**4. Rehearse a rollback.** Merge two commits to `main` so CD pushes two image sets: a good one,
and one with a visible "bug" (rename the **Publish** button). Then, on your kind cluster:

```bash
export REGISTRY=ghcr.io/<your-github-user>
GOOD=$(git rev-parse HEAD~1); BAD=$(git rev-parse HEAD)
docker login ghcr.io -u <your-github-user>     # password: a personal access token with read:packages
for sha in "$GOOD" "$BAD"; do for name in api migrator worker web; do
  docker pull "$REGISTRY/branchstory-$name:$sha"
  kind load docker-image --name branchstory "$REGISTRY/branchstory-$name:$sha"
done; done

deploy/ci/deploy.sh deploy/k8s/overlays/kind "$BAD"       # the "incident"
time deploy/ci/deploy.sh deploy/k8s/overlays/kind "$GOOD" # the rollback: the same path as a deploy
deploy/ci/smoke.sh http://localhost:8088
git checkout deploy/k8s/overlays/kind/kustomization.yaml   # keep :dev in git for up.sh
```

Write the `time` result down. Then compare it with `kubectl -n branchstory rollout undo
deployment/web`: that is faster in a panic, but it only undoes one Deployment, and afterwards the
cluster no longer matches any commit. Use it to stop the bleeding, then deploy a SHA.

:::warn title="Rolling back code does not roll back the schema"
The migrator init container of the bad release already ran its migrations, and the good release
now runs against that newer schema. That only works if every migration that ships with a release
is **backward compatible** with the previous release's code: add a nullable column, add a table,
add an index; never rename or drop in the same release. The next lesson, **v2 Without Downtime**,
turns this into a routine: expand → deploy → contract.
:::

:::pro title="Push or pull?"
This pipeline *pushes* (`kubectl apply` from CI with a kubeconfig secret). GitOps tools such as
Argo CD or Flux *pull* instead: the pipeline only commits the new image tag to the overlay
(`kustomize edit set image … && git commit`), and the controller in the cluster applies whatever
`main` says. Then a rollback is `git revert`, the cluster needs no inbound credentials, and drift
gets corrected automatically. Most teams end up there once they have more than one cluster.
:::

- [ ] A push to `main` produces four `ghcr.io/<owner>/branchstory-*:<sha>` packages, and a deliberately old base image with known CVEs makes the scan step fail
- [ ] The `staging` job deploys those exact images to a throwaway kind cluster and the smoke test publishes and plays a story
- [ ] `kubectl -n branchstory get deploy -o wide` on your cluster shows SHA tags, not `:dev`, after a `deploy.sh` run
- [ ] You rolled back from the bad SHA to the good one with `deploy.sh`, timed it, and the smoke test passed afterwards
:::

## Lab 7: prove p95, then run an incident drill

"It feels fast on my machine" is not a performance requirement. Write down a target, measure it
under load, and keep measuring it: that's how you notice the day someone makes it slower.
BranchStory's targets for 1.0:

| Path | Target | Why |
|---|---|---|
| Editor API (`GET /api/projects`, `GET`/`PUT` a project) | p95 < 300 ms at 20 concurrent editors | autosave must feel instant |
| Public player (`GET /api/public/stories/{slug}`) | p95 < 50 ms at 50 requests/s | readers arrive in spikes when a link is shared |
| Errors | < 1 % of requests | |

:::lab id=cap-10-lab8 xp=150
title: Cache the player, paginate the list, load-test both, then find a seeded regression

**1. Let caches answer the player.** cap-08 already sends `Cache-Control: public, max-age=60`.
Add an `ETag`, so a browser or CDN whose copy is older than 60 s can *revalidate* it with
`If-None-Match` and get an empty `304 Not Modified` back instead of the whole story. Replace
`GetPublicStoryAsync` in `PublishingEndpoints.cs`:

```csharp
private static async Task<Results<ContentHttpResult, NotFound, StatusCodeHttpResult>> GetPublicStoryAsync(
    string slug, BranchStoryDbContext db, HttpRequest request, HttpResponse response, CancellationToken ct)
{
    // Cheap first: the version stamp. The (possibly large) player JSON is read only when needed.
    var stamp = await db.PublishedStories.AsNoTracking()
        .Where(s => s.Slug == slug)
        .Select(s => new { s.SourceVersion, s.PublishedAt })
        .SingleOrDefaultAsync(ct);
    if (stamp is null) return TypedResults.NotFound();

    // A republish of the same version (new PlayerBuilder) changes PublishedAt, so it changes the ETag.
    var etag = $"\"{stamp.SourceVersion}-{stamp.PublishedAt.ToUnixTimeMilliseconds()}\"";
    response.Headers.ETag = etag;
    response.Headers.CacheControl = "public, max-age=60, stale-while-revalidate=300";

    var ifNoneMatch = request.Headers.IfNoneMatch.ToString()
        .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
    if (ifNoneMatch.Contains(etag) || ifNoneMatch.Contains("*"))
        return TypedResults.StatusCode(StatusCodes.Status304NotModified);

    var json = await db.PublishedStories.AsNoTracking()
        .Where(s => s.Slug == slug).Select(s => s.PlayerJson).SingleAsync(ct);
    return TypedResults.Text(json, "application/json");
}
```

```bash
curl -si localhost:8080/api/public/stories/<slug> | grep -i etag            # ETag: "3-17305…"
curl -si localhost:8080/api/public/stories/<slug> -H 'If-None-Match: "3-17305…"' | head -1   # HTTP/1.1 304
```

**2. Paginate the project list without breaking old clients.** `GET /api/projects` returns every
project, and a Pro user with 100 stories plus shared ones gets all of them on every visit. Add
*optional* keyset pagination: `?limit=50` returns the first page and, if there is more, a
`Link: <…?limit=50&after=…>; rel="next"` header. Without `limit` the endpoint behaves exactly as
before, so cap-05's client keeps working unchanged. Additive, opt-in changes like this are how a
live API evolves (much more on that in **v2 Without Downtime**).

`api/BranchStory.Api/Features/Projects/ProjectCursor.cs`:

```csharp
namespace BranchStory.Api.Features.Projects;

/// <summary>An opaque "continue after this row" token: the last row's (UpdatedAt, Id).</summary>
public static class ProjectCursor
{
    public static string Format(DateTimeOffset updatedAt, Guid id) => $"{updatedAt.UtcTicks}.{id:N}";

    public static bool TryParse(string value, out DateTimeOffset updatedAt, out Guid id)
    {
        updatedAt = default;
        id = default;
        var parts = value.Split('.');
        if (parts.Length != 2 || !long.TryParse(parts[0], out var ticks) || !Guid.TryParseExact(parts[1], "N", out id))
            return false;
        if (ticks < DateTimeOffset.MinValue.UtcTicks || ticks > DateTimeOffset.MaxValue.UtcTicks) return false;
        updatedAt = new DateTimeOffset(ticks, TimeSpan.Zero);
        return true;
    }
}
```

Replace `ListProjects` in `ProjectEndpoints.cs` (the `MapGet` line stays the same):

```csharp
static async Task<Results<Ok<List<ProjectSummary>>, ProblemHttpResult>> ListProjects(
    int? limit, string? after, CurrentUser currentUser, BranchStoryDbContext db, HttpResponse response, CancellationToken ct)
{
    if (limit is < 1 or > 100)
        return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "limit must be between 1 and 100");

    var me = await currentUser.GetAsync(ct);
    var query = db.Projects.Where(p => p.OwnerId == me.Id || p.Members.Any(m => m.UserId == me.Id));

    if (after is not null)
    {
        if (!ProjectCursor.TryParse(after, out var afterUpdatedAt, out var afterId))
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Invalid cursor");
        // A row-value comparison, (updated_at, id) < (@u, @id): "everything after the last row",
        // which an index can seek to directly. OFFSET would re-read every skipped row.
        query = query.Where(p => EF.Functions.LessThan(
            ValueTuple.Create(p.UpdatedAt, p.Id), ValueTuple.Create(afterUpdatedAt, afterId)));
    }

    IQueryable<Project> page = query.OrderByDescending(p => p.UpdatedAt).ThenByDescending(p => p.Id);
    if (limit is int n) page = page.Take(n + 1);          // one extra row tells us whether there is a next page

    var items = await page
        .Select(p => new ProjectSummary(
            p.Id,
            p.Title,
            p.OwnerId == me.Id ? "owner" : p.Members.Where(m => m.UserId == me.Id).Select(m => m.Role).First(),
            p.Owner.DisplayName,
            p.Version,
            p.UpdatedAt))
        .ToListAsync(ct);

    if (limit is int max && items.Count > max)
    {
        items.RemoveAt(max);
        var last = items[^1];
        response.Headers.Link =
            $"</api/projects?limit={max}&after={ProjectCursor.Format(last.UpdatedAt, last.Id)}>; rel=\"next\"";
    }
    return TypedResults.Ok(items);
}
```

`EF.Functions.LessThan` on value tuples is Npgsql's row-value comparison. The tie-breaker on `Id`
matters: two projects saved in the same microsecond would otherwise be skipped or repeated at a
page boundary. Back it with an index that matches the sort, in `ProjectConfig` (cap-02):

```csharp
b.HasIndex(p => new { p.OwnerId, p.UpdatedAt, p.Id }).IsDescending(false, true, true);
```

Then `dotnet ef migrations add ProjectListIndex --project api/BranchStory.Data`. Adding an index is
an *expand* change, so the previous release runs fine against it, and the rollback from Lab 6
stays safe. On a big production table you'd create it `CONCURRENTLY` so writes aren't blocked.
Extend the API tests with one case: three projects, `limit=2`, follow the `Link`, and you get the
third project and no `Link` header.

**3. A load test with thresholds**: `tests/load/smoke.js` for [k6](https://k6.io)

```js
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.BASE_URL || 'http://localhost:8080'
const JSON_HEADERS = { 'content-type': 'application/json' }

export const options = {
  scenarios: {
    editors: { executor: 'constant-vus', exec: 'editor', vus: 20, duration: '1m' },
    readers: { executor: 'constant-arrival-rate', exec: 'reader', rate: 50, timeUnit: '1s', duration: '1m', preAllocatedVUs: 20, maxVUs: 100 },
  },
  // The run fails (exit code 99) when a target is missed, so it can gate a pipeline.
  setupTimeout: '90s',
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:editors}': ['p(95)<300'],
    'http_req_duration{scenario:readers}': ['p(95)<50'],
  },
}

function signIn(username) {
  const res = http.post(`${BASE}/api/dev/token`, JSON.stringify({ username }), { headers: JSON_HEADERS })
  return { headers: { ...JSON_HEADERS, authorization: `Bearer ${res.json('accessToken')}` } }
}

// Runs once before the scenarios: one author publishes the story the readers will read.
export function setup() {
  const auth = signIn(`load-author-${Date.now()}`)
  const project = http.post(`${BASE}/api/projects`, JSON.stringify({ title: 'Load test' }), auth).json()
  const job = http.post(`${BASE}/api/projects/${project.id}/publish`, null,
    { headers: { ...auth.headers, 'idempotency-key': `load-${Date.now()}` } }).json()
  for (let i = 0; i < 60; i++) {
    const status = http.get(`${BASE}/api/jobs/${job.jobId}`, auth).json()
    if (status.status === 'succeeded') return { slug: status.slug }
    sleep(1)
  }
  throw new Error('the setup publish did not finish')
}

let auth      // per virtual user: each editor is its own signed-in user with one project
let projectId

export function editor() {
  if (!auth) {
    auth = signIn(`load-editor-${__VU}-${Date.now()}`)
    projectId = http.post(`${BASE}/api/projects`, JSON.stringify({ title: `VU ${__VU}` }), auth).json('id')
  }
  check(http.get(`${BASE}/api/projects`, auth), { 'list 200': (r) => r.status === 200 })
  const current = http.get(`${BASE}/api/projects/${projectId}`, auth).json()
  const saved = http.put(`${BASE}/api/projects/${projectId}/doc`,
    JSON.stringify({ doc: current.doc, expectedVersion: current.version }), auth)
  check(saved, { 'save 200': (r) => r.status === 200 })
  sleep(1)      // think time: a real editor autosaves every few seconds, not in a tight loop
}

export function reader(data) {
  check(http.get(`${BASE}/api/public/stories/${data.slug}`), { 'player 200': (r) => r.status === 200 })
}
```

A load generator on one machine looks like **one** client to Lab 5's per-IP limit, so raise it for
the test. Add `RateLimits__AnonymousPerMinute: ${RATE_LIMIT_ANON_PER_MIN:-60}` to the
`x-dotnet-env` block of `deploy/compose.yaml`, then:

```bash
RATE_LIMIT_ANON_PER_MIN=1000000 OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4317 \
  docker compose -f deploy/compose.yaml --profile observability up -d --build
docker run --rm -i --network host grafana/k6 run - < tests/load/smoke.js      # Linux
# macOS/Windows: docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 grafana/k6 run - < tests/load/smoke.js
```

Read the summary: the `http_req_duration` lines per scenario and a ✓ or ✗ next to each
threshold. Write the p95 values down: they're your **baseline**. Run it once more with the default
limit (`RATE_LIMIT_ANON_PER_MIN` unset) and watch `http_req_failed` fill up with 429s. Your rate
limiter works, and it would also stop a real traffic spike from a single network.

**4. The incident drill.** Pair up if you can: one person plants the bug, the other finds it with
only the tools on-call would have. Working alone, plant it, wait a day, then hunt.

*The setup.* Production has many stories. Give the database a realistic size:

```bash
docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -d branchstory <<'SQL'
INSERT INTO users (id, subject, email, display_name, plan, created_at)
VALUES ('00000000-0000-7000-8000-000000000001', 'seed|bulk', 'bulk@seed.test', 'Bulk', 'pro', now())
ON CONFLICT DO NOTHING;
INSERT INTO projects (id, owner_id, title, doc, version, created_at, updated_at)
SELECT gen_random_uuid(), '00000000-0000-7000-8000-000000000001'::uuid, 'Seed ' || g,
       '{"startNodeId":"start","nodes":[],"edges":[]}'::jsonb, 1, now(), now()
FROM generate_series(1, 300000) g;
INSERT INTO published_stories (project_id, slug, source_version, player_json, published_at)
SELECT id, 'seed-' || substr(md5(id::text), 1, 16), 1, '{"scenes":[]}'::jsonb, now()
FROM projects WHERE owner_id = '00000000-0000-7000-8000-000000000001';
ANALYZE;
SQL
```

Re-run k6. The readers' p95 should still match the baseline with 300 000 published stories,
because the unique index on `slug` makes the lookup a single index probe. (The editors' list may
get a little slower: its `owner_id = … OR EXISTS (membership)` filter can't be answered by one
index, so `EXPLAIN` shows a scan of `projects`. Note it as a finding for later.) This is the new
baseline the hunt compares against.

*The regression.* A support ticket says "`/play/Night-Train-4f2a` is a 404 when I type capitals".
The planted fix, in a branch with a reasonable-sounding PR description, changes both lookups in
`GetPublicStoryAsync` to:

```csharp
.Where(s => s.Slug.ToLower() == slug.ToLower())
```

Deploy it (`docker compose … up -d --build api`) and run k6 again.

*The hunt*, using only what on-call has:

1. **The symptom.** k6's `readers` threshold fails (✗), and p95 is far above your baseline. In
   production this would be your "p95 above target" alert from Lab 3.
2. **Where the time goes.** In Grafana → Explore → Tempo, search for traces of
   `GET /api/public/stories/{slug}` and sort by duration. Nearly the whole span is one **Npgsql**
   child span, and its query text contains `WHERE lower(p.slug) = @…` (EF Core lowercases the
   parameter in .NET before sending it, but the column side has to be computed for every row).
3. **Why it is slow.** Run that query with `EXPLAIN ANALYZE` in psql. Instead of an `Index Scan`
   on the slug index, you get a `Seq Scan` on `published_stories` that reads all 300 000 rows: an
   index on `slug` cannot answer a question about `lower(slug)`.
4. **The fix, through a reviewed PR.** Slugs are generated lowercase (cap-08's `Slug`), so
   normalize the *input* and keep the indexed comparison: `var key = slug.ToLowerInvariant();`
   and `.Where(s => s.Slug == key)`. The PR adds an API test for the original feature (mixed-case
   slug → 200) and links the trace. If stored values could really differ in case, the fix would
   be an expression index (`CREATE INDEX … ON published_stories (lower(slug))`) or a `citext`
   column instead.
5. **Verify.** Deploy, re-run k6: back to baseline.

**5. Write the postmortem**: `docs/postmortems/2026-xx-player-latency.md`. It is **blameless**:
it describes what the *system* allowed, not who typed what.

```markdown
# Player p95 regression after case-insensitive slug lookup

## Summary            one paragraph: what users saw, for how long
## Impact             e.g. player p95 3 ms → 180 ms for 25 min; no errors, no data loss
## Timeline (UTC)     deploy → alert → first trace looked at → fix merged → recovered
## Root cause         lower(slug) defeated the unique index; the seq scan grows with the table
## Detection          what told us (k6 threshold / p95 alert) and how long it took
## What went well     traces pointed at the SQL in minutes
## What went poorly   the PR passed review and CI; nothing measured query plans or p95
## Action items       owner + due date each, e.g. run k6 nightly against staging with thresholds;
                      review checklist item "does this change a WHERE on a hot path?"
```

- [ ] `GET /api/public/stories/{slug}` returns an `ETag`, and a request with that `If-None-Match` gets `304` with an empty body
- [ ] `GET /api/projects` without `limit` returns the same array as before; `?limit=2` returns two items plus a `Link` header that leads to the rest, and the new API test passes
- [ ] k6 runs against compose with all thresholds green, and your baseline p95 values are written down
- [ ] With the planted regression, the trace shows the slow Npgsql span and `EXPLAIN ANALYZE` shows the seq scan
- [ ] The fix is merged through a PR with a test; k6 is back to baseline; a blameless postmortem with owned action items is committed
:::

## Data you must be able to delete, and a trail of who did what

Two questions come up soon after launch, usually from a user or a lawyer, and both are much
cheaper to answer if the schema is ready for them.

**"Delete my account."** Privacy laws such as the GDPR give users a right to erasure, and you must
be able to show how you honour it. In BranchStory that means: delete every project the user
**owns** (`project_members`, `jobs` and `published_stories` cascade, as the launch checklist below
checks), delete their member rows on other people's projects, then delete the `users` row. The
order matters because `projects.owner_id` is `Restrict` (cap-02). Run it as a job on the existing
queue (`kind = 'delete-account'`), so it is retried, observable and idempotent like a publish.
Two places are easy to forget: **logs** (keep ids in them, not emails or story text, and give them
a retention period) and **backups** (a deleted user lives on in last week's dump until it
expires; write that retention period into your privacy policy).

**"Who shared my story with that person?"** An append-only `audit_events` table answers it:

```sql
CREATE TABLE audit_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_id   uuid,                    -- NULL for system actions; keep the id, not the email
  project_id uuid,
  action     text NOT NULL,           -- 'member.added', 'member.removed', 'project.deleted', 'publish.requested'
  details    jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON audit_events (project_id, at DESC);
```

Write each event **in the same transaction** as the change it describes (the transactional
enqueue trick from cap-08 again), so the trail can't miss a change or record one that was rolled
back. Give the app's database role `INSERT` and `SELECT` on it but no `UPDATE` or `DELETE`, so a
bug can't rewrite history.

## Lab 8: the launch checklist

:::lab id=cap-10-lab5 xp=80
title: Go / no-go for BranchStory 1.0

Real launches are run from a checklist. Walk through each item, fix what is missing, and tick it
only when you have *seen* it work (not when you believe it does).

**Security**

Secrets only in Secret objects or a vault, nothing in git or images. JWT validation checks
issuer, audience, lifetime and signing key. Every project route runs the owner/editor/viewer
check (try them all as a viewer and as a stranger). The dev token issuer is impossible to enable
outside Development. Public endpoints (`/api/public/*`, `/api/dev/*`) are rate-limited or absent,
request bodies are capped, and the SPA ships a CSP (Lab 5). CI fails on high or critical
vulnerabilities in packages and images. Media URLs are sanitized before they reach the player.

**Data**

Backups run, and one has been restored. Migrations are forward-only, every migration in this
release is backward compatible with the previous release's code (expand now, contract later: see
**v2 Without Downtime**), and they were tested against a copy of real-sized data. The quota counts
against the owner. Deleting a project cascades to members, jobs and the published story, and you
know how you would delete a whole account.

**Operations**

Liveness vs readiness are separate and correct. Resource requests are set (no CPU limits for the
API, memory limits everywhere). Logs are structured, include correlation ids, and contain no tokens
or personal data. You have one dashboard (traffic, errors, latency, queue depth, dead letters) and
alerts on symptoms.

**Quality**

CI is green and required on `main`. The e2e journey and the axe gate pass on the deployed build.
The k6 smoke test meets its p95 thresholds (Lab 7). A manual keyboard-only and screen-reader pass
of the editor and player has been done.

- [ ] Security items verified, including a viewer and a stranger trying every write endpoint
- [ ] A backup has been restored into a scratch database and smoke-tested
- [ ] Probes, resource requests and graceful shutdown behave as designed under a pod kill
- [ ] A dashboard shows request rate, error rate, p95 latency, queue depth and dead letters
- [ ] The full CI pipeline is green on the commit you deploy, its SHA-tagged images passed the staging smoke test, and a rollback to the previous SHA was rehearsed and timed (Lab 6)
:::

## What next

You have built a production-shaped system. Here is where the real ones go after 1.0, roughly in
the order you will need it:

- **Change it while it runs.** 1.0 is the last release you ship to an empty database. From now on
  every change lands on live data and on clients that are still running the old code. The next
  lesson, **v2 Without Downtime**, adds a field to the story document and ships it as
  expand → deploy → contract, with old documents migrated on read and by a backfill job.
- **SignalR backplane.** `dotnet add package Microsoft.AspNetCore.SignalR.StackExchangeRedis`,
  then `builder.Services.AddSignalR().AddStackExchangeRedis(redisConnectionString)`. Keep sticky
  sessions, or go WebSockets-only (`skipNegotiation: true` with `HttpTransportType.WebSockets`).
- **Autoscale workers on queue depth with KEDA.** Your `cap-10-sql1` query *is* the metric:

  ```yaml
  apiVersion: keda.sh/v1alpha1
  kind: ScaledObject
  metadata: { name: worker, namespace: branchstory }
  spec:
    scaleTargetRef: { name: worker }
    minReplicaCount: 0
    maxReplicaCount: 10
    triggers:
      - type: postgresql
        metadata:
          query: >-
            SELECT count(*) FROM jobs WHERE kind = 'publish'
            AND ((status = 'queued' AND run_after <= now()) OR (status = 'running' AND leased_until < now()))
          targetQueryValue: "5"
        authenticationRef: { name: keda-postgres }
  ```

  Scale-down kills pods mid-job; that is exactly what graceful release and leases are for.
- **A real Postgres operator.** Replace the StatefulSet with **CloudNativePG**: replicas with
  automatic failover, continuous WAL archiving to object storage, point-in-time recovery, and
  scheduled base backups as Kubernetes resources.

  ```yaml
  apiVersion: postgresql.cnpg.io/v1
  kind: Cluster
  metadata: { name: branchstory-db }
  spec:
    instances: 3
    imageName: ghcr.io/cloudnative-pg/postgresql:18
    storage: { size: 10Gi }
    bootstrap: { initdb: { database: branchstory, owner: branchstory } }
  ```
- **Real identity.** Keycloak (or your company's IdP) with OIDC + PKCE in the SPA, refresh
  tokens, and passkeys; drop the dev issuer from every non-local build.
- **Media pipeline.** Direct-to-object-storage uploads with pre-signed URLs, a `transcode` job kind
  on the same queue, and a CDN in front of the published player JSON and media.
- **Gateway API and GitOps.** Move from `Ingress` to `HTTPRoute`, and let Argo CD or Flux pull the
  kustomize overlays from git instead of Lab 6's push-based `kubectl apply` from CI.
- **More clients.** The API is already the contract: generate a typed client from the OpenAPI
  document, use the .NET SignalR client, and the same backend serves a desktop editor built with
  **Avalonia** or a mobile player in **.NET MAUI**. The future DevQuest XAML tracks pick up there.

:::cards id=cap-10-cards1 xp=20 title="Shipping"
Q: Why multi-stage Dockerfiles?
A: The SDK and build tools stay in the build stage; the runtime image only has the published output, so it is smaller and has less attack surface.
Q: Why copy the csproj / package-lock files before the sources?
A: The restore layer is then cached until dependencies change, so source edits rebuild in seconds.
Q: Liveness vs readiness?
A: Liveness: "am I broken beyond repair?" (restart me). Readiness: "can I take traffic now?" (remove me from the Service). Dependency checks belong in readiness.
Q: What does `depends_on: condition: service_completed_successfully` give you in compose?
A: Ordering on a one-shot task, here the migrator, so api and worker start only after the schema is up to date.
Q: Why configMapGenerator / secretGenerator?
A: They add a content hash to the name, so changing a value changes the reference in the pod template and triggers a rolling update.
Q: Why sticky sessions for SignalR behind a load balancer?
A: The negotiate request and the following WebSocket (or long-polling requests) must reach the same server that holds the connection state.
Q: PostgreSQL 18 Docker volume gotcha?
A: Mount the volume at `/var/lib/postgresql`, not `/var/lib/postgresql/data`; data lives in a version-specific subdirectory.
Q: How do you scale workers on demand?
A: KEDA with a postgresql trigger running the "ready plus expired lease" count query, from 0 to N replicas.
Q: What makes a backup real?
A: A tested restore, with the time it took written down.
Q: Does a running pod see a changed ConfigMap value it reads through env vars?
A: No. Env vars are read at container start. Only a pod template change (generator hash) or a rollout restart applies it.
Q: Rate limit or quota: what is the difference?
A: A rate limit protects the system per caller per second or minute and answers 429 with Retry-After (waiting helps). A quota is a product rule per owner per day and answers 403 plan-limit (waiting doesn't help).
Q: Why does nginx need the security headers in every location?
A: An `add_header` inside a location replaces all inherited `add_header` lines, so a server-level header silently disappears wherever a location adds its own. Include one snippet per location.
Q: Why tag images with the git SHA?
A: Every environment runs the exact bytes CI built and scanned, you can see which commit is live, and a rollback is "deploy the previous SHA" through the same script.
Q: Why can rolling back the code be unsafe?
A: The newer release's migrations stay applied. A rollback only works if every migration in a release is backward compatible with the previous code (expand → deploy → contract).
Q: Keyset vs OFFSET pagination?
A: Keyset continues after the last row's (updated_at, id), which an index can seek to directly. OFFSET reads and discards every skipped row, and rows shift when data changes between pages.
Q: Why can't you configure a built SPA with container env vars?
A: Vite replaces import.meta.env.VITE_* with literal strings at build time; the browser never sees the container's environment. Use a runtime /config.json or relative URLs.
:::

## Recap

- Multi-stage images keep the SDK out of production, restore layers are cached, every container
  runs as non-root, and migrations ship as their own **EF bundle** image.
- One compose file runs the whole stack with **health-gated** startup: Postgres healthy →
  migrator completed → api and worker → web.
- **Liveness** detects what a restart fixes, **readiness** reflects dependencies; graceful
  shutdown plus leases make pod kills harmless for jobs.
- Config read from env vars changes only on a rollout (generated ConfigMap names do that for
  you), and `VITE_*` values are frozen into the SPA at build time.
- On kind, **kustomize** base + overlay deploy Deployments, Services, a Traefik Ingress (with
  sticky sessions for SignalR), generated ConfigMap/Secret, an init-container migration and a
  `pg_dump` CronJob.
- JSON logs, OpenTelemetry traces and business metrics answer what the system is doing; alert on
  symptoms.
- The edge is hardened: per-IP and per-user **rate limits** (429, unlike the 403 quota), a request
  body cap, a CSP and security headers on the SPA, and vulnerability gates on packages and images.
- **Continuous delivery** builds SHA-tagged images once, smoke-tests them in a throwaway cluster,
  promotes the same SHA, and rolls back through the same script, which only works because
  migrations are backward compatible.
- Performance is a number: an `ETag`/304 on the player, keyset pagination on the list, k6
  thresholds as the baseline, and an incident drill that finds a regression through traces and
  ends in a blameless postmortem.
- Plan for account deletion and an append-only audit trail before the first request for them.
- Next: **v2 Without Downtime**, then a Redis backplane, KEDA on queue depth, CloudNativePG, real
  identity, GitOps, and native Avalonia/MAUI clients on the same API.
