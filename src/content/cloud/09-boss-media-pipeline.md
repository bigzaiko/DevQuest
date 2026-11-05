---
id: cl-09
title: "Boss: The Media Processing Pipeline"
level: expert
minutes: 540
xp: 200
summary: Build a video pipeline end to end — presigned multipart uploads to SeaweedFS, a leased Redis queue, an idempotent .NET worker with retries and a DLQ, live status over SignalR, Keycloak auth, KEDA 0→N in kind and one OpenTelemetry trace across all of it — then survive ten incident phases.
---

Every region so far gave you one tool. This boss fight makes you use all of them together, the way
a real product does. The feature is ordinary: **a user uploads a video and watches it get
processed.** YouTube, Loom, every LMS and every "attach a recording" button work this way.
What makes it hard is that it crosses six systems, and any one of them can fail halfway through.

You'll build it, then break it on purpose. The lesson has **no new concepts**. It's about the
*seams* between the ones you know, which is where production incidents happen.

| You'll use | From |
|---|---|
| Redis data types, Lua, persistence | Redis Fundamentals |
| Presigned multipart uploads on SeaweedFS | Object Storage & Direct Uploads (S3) |
| Leased queues, locks, fencing | Redis as Queue, Bus and Lock |
| Dual writes, outbox thinking | Message Brokers & the Outbox Pattern |
| OIDC code + PKCE, audiences, JWT bearer | Identity with Keycloak (OIDC in Practice) |
| Traces, metrics, logs, PromQL | Observability: OpenTelemetry, Prometheus, Grafana, Loki |
| ScaledObject, activation, cooldown | KEDA: Autoscale Workers on Queue Depth |
| BackgroundService, SignalR, idempotency | be-16, be-17, be-18 |

## The architecture

```text
                    ┌────────────── Keycloak 26 · realm "media" ──────────────┐
                    │ OIDC code + PKCE → access token { sub, aud: media-api } │
                    └──────▲─────────────────────────────────┬────────────────┘
                   sign in │                                 │ JWKS (validate tokens)
┌──────────────────────────┴─────┐  ② start   ④ complete  ┌──▼──────────────────────────────┐
│ Browser · React 19 + Vite      │ ─────────────────────► │ Media.Api · ASP.NET Core 10     │
│ uploader + live status table   │ ◄── ⑨ JobUpdated ───── │ presign · complete · /hubs/media│
└──────────────┬─────────────────┘   SignalR (WebSocket)  └───┬─────────────┬────────▲───────┘
  ③ PUT parts  │ presigned URLs, straight to storage      ⑤ row │    ⑥ enqueue │        │ backplane
               ▼                                                ▼              ▼        │ pub/sub
┌──────────────────────────────┐    ┌─────────────────────────┐   ┌─────────────────────┴──────┐
│ SeaweedFS · S3 gateway :8333 │    │ PostgreSQL 18           │   │ Redis 8                    │
│ media/uploads/{id}/source    │    │ media_uploads = TRUTH   │   │ {media}:jobs  :processing  │
│ media/outputs/{id}/…         │    │ status · attempts       │   │ :lease:{id} :delayed :dlq  │
└──────────────▲───────────────┘    └────────────▲────────────┘   └──────▲───────────────▲─────┘
               │ ⑧ GET source, PUT output        │ ⑦ claim / finish      │ claim, renew  │ LLEN
          ┌────┴─────────────────────────────────┴───────────────────────┴──┐    ┌───────┴──────┐
          │ Media.Worker ×0…N · BackgroundService · in kind                 │◄───┤ KEDA 2.x     │
          │ lease + heartbeat · idempotent · backoff · DLQ · notify         │    │ ScaledObject │
          └─────────────────────────────────────────────────────────────────┘    └──────────────┘
 every process ──OTLP──► grafana/otel-lgtm  (Collector → Tempo · Prometheus · Loki → Grafana :3000)
```

1. The browser signs in with Keycloak (code + PKCE) and calls the API with a bearer token.
2. `POST /api/media/uploads`: the API inserts a row (`uploading`), starts an S3 **multipart
   upload** and returns one **presigned URL per part**.
3. The browser `PUT`s the parts **directly to SeaweedFS**, so the API never handles the gigabytes.
4. `POST …/complete`: the API completes the multipart upload, checks the object size, and
5. flips the row to `queued` (keeping the current `traceparent`), then
6. enqueues the job id in Redis.
7. A worker **claims** the job atomically (list move + lease key), counts the attempt in Postgres,
8. processes it (real `ffmpeg` or a fake transcoder) with a heartbeat on the lease, writes the
   output under a deterministic key and marks the row `ready`, or retries with backoff, or dead-letters it.
9. Each status change goes out through the **SignalR Redis backplane** to whichever API replica
   holds the user's WebSocket.

KEDA watches the Redis lists and scales workers **0 → N → 0**. One trace follows the job from
`complete` through the worker, and Grafana shows **queue depth, p95 job latency and error rate**.

:::info title="Why SeaweedFS and not MinIO?"
Everything here uses **SeaweedFS** with its S3 gateway for local and self-hosted object storage.
MinIO has stopped publishing community builds and put its open-source edition into maintenance
mode, so it's a poor base for new projects. Your code
only sees "an S3 endpoint". The same `AWSSDK.S3` calls work against AWS S3, Cloudflare R2 or
Hetzner Object Storage when you deploy.
:::

## The five rules that hold it together

Before any code, these are the invariants. Every boss phase at the end breaks one of them.

| # | Rule | Why |
|---|---|---|
| 1 | **Postgres is the source of truth.** Redis only *delivers* job ids and can be rebuilt from the table. | Redis can lose data (restart without AOF, eviction, a bad `FLUSHALL`). Rows can't be "lost from the queue" if the queue is just a cache of the table. |
| 2 | **At-least-once delivery, idempotent processing.** | Leases expire, pods die, networks split. You *will* process some jobs twice. Make that harmless instead of trying to prevent it. |
| 3 | **Attempts are counted at claim time.** | A `catch` block never runs for an OOMKill. If you only count failures, a poison file loops forever. |
| 4 | **The attempt number is the fencing token.** | The final `UPDATE … WHERE attempts = @mine` rejects a zombie worker whose lease was taken over. |
| 5 | **Context travels with the job.** | `traceparent` and `owner_sub` are stored on the row, so the worker can continue the trace and notify the right user. |

### Vocabulary for this fight

| Term | Meaning here | Concrete example |
|---|---|---|
| **Lease** | A time-limited claim on a job. If it isn't renewed, it expires and someone else may take the job. | `{media}:lease:0199…` = `"pod-7/ab12…"`, TTL 30 s |
| **Heartbeat** | The worker renewing its own lease while it works. | every 10 s: `PEXPIRE` if the value is still mine |
| **Reaper** | Housekeeping that returns jobs with an expired lease to the queue. | `MaintainLua`, every 5 s |
| **Janitor** | Housekeeping that rebuilds Redis from Postgres. | re-enqueue `queued` rows Redis forgot after a restart |
| **Fencing token** | A number that rises with every claim. Writes from an older number are refused. | `UPDATE … WHERE attempts = 2` ignores the zombie that holds attempt 1 |
| **Idempotent** | Doing it twice has the same effect as doing it once. | writing `outputs/{id}/result.json` again overwrites the same object |
| **DLQ / redrive** | Dead-letter queue: where jobs go after the last attempt. Redrive = a human sends one back. | `{media}:dlq`, `POST /api/media/{id}/redrive` |
| **Multipart upload** | An S3 upload split into numbered parts under one `UploadId`. Each part returns an `ETag` that "complete" needs. | 24 MiB file = 3 parts of 8 MiB |
| **Presigned URL** | A URL that carries a time-limited signature for one S3 request, so the browser needs no keys. | `PUT …/source?partNumber=2&uploadId=…&X-Amz-Expires=900&X-Amz-Signature=…` |
| **Backplane** | A shared channel (here Redis pub/sub) that lets any process send to a SignalR connection held by another. | the worker sends, the API replica holding alice's WebSocket delivers |
| **Activation** | KEDA's 0 ↔ 1 decision. The HPA handles 1 ↔ N. | `activationListLength: "0"` → any waiting job wakes a pod |

### The job state machine

```text
                complete (API)              claim (attempts + 1)
  uploading ──────────────────► queued ───────────────────────► processing ───success───► ready
      │                           ▲                               │ │  ▲ ▲
      │ abort                     │ redrive                       │ │  │ └── lease expired → re-claim (attempts + 1)
      ▼                           │ (attempts = 0)                │ │  │
   aborted                        │                               │ │  │ claim when due (attempts + 1)
                                  │      fail, attempts < max     │ ▼  │
                                  │      due = now + backoff ───► retrying
                                  │                               │
                                dead ◄── fail on the last attempt ┘
                                     ◄── claim with attempts + 1 > max (the crash loop ends here)
```

| From | Event | To | Notes |
|---|---|---|---|
| `uploading` | complete | `queued` | complete again = no-op (double-click) |
| `uploading` | abort | `aborted` | API also aborts the S3 multipart upload |
| `queued` / `retrying` (due) / `processing` (lease expired) | claim | `processing` | `attempts + 1`; if that exceeds the max → `dead` |
| `processing` | success | `ready` | only if `attempts` still equals mine (fencing) |
| `processing` | failure | `retrying` or `dead` | `retrying` gets `due = now + backoff(attempt)` |
| `dead` | redrive | `queued` | human decision, attempts reset |
| `ready` / `aborted` | anything | — | duplicates are acknowledged and ignored |

### The Redis layout

All keys share the hash tag `{media}`, so they land in one slot. Multi-key Lua scripts stay legal
if you move to Redis Cluster later. (The scripts also build `lease:` keys dynamically, which
strict Cluster rules discourage. With the shared hash tag it works, but *Redis as Queue, Bus and Lock* covers the purist
version.)

| Key | Type | Meaning |
|---|---|---|
| `{media}:jobs` | LIST | waiting job ids. API `LPUSH`es, workers take from the right (FIFO) |
| `{media}:processing` | LIST | claimed, in-flight ids |
| `{media}:lease:{id}` | STRING + TTL | `workerId`, expires unless the heartbeat renews it |
| `{media}:delayed` | ZSET | retries, score = due time (ms, Redis server clock) |
| `{media}:dlq` | LIST | dead-lettered ids (for humans) |
| `{media}:known` | SET | every id Redis currently tracks. Lets the janitor rebuild Redis from Postgres without duplicates |

These are the `app:queue:state` names from **Redis as Queue, Bus and Lock** (`dq:jobs:ready`,
`dq:jobs:processing`, `dq:jobs:lease:<id>`) with two deliberate changes. The app segment is a
**hash tag**, `{media}`, so every key hashes to the same Cluster slot. And because the media app
has exactly one queue, the queue segment is dropped: `{media}:jobs` is the waiting list and
`{media}:processing` the in-flight one. With a second queue you'd write `{media}:thumbs:ready`
and so on, or give each queue its own tag.

### One job, step by step

The Lua scripts below are dense, so here is what they do to one job `J` that fails once and then
succeeds. Read it as "what would I see with `redis-cli` and `psql` after each step". `w1`/`w2` are
worker ids.

| Step | Code that runs | `:jobs` | `:processing` | `:lease:J` | `:delayed` | `:known` | Postgres row |
|---|---|---|---|---|---|---|---|
| 1. enqueue | API: `MarkQueuedAsync`, then `EnqueueLua` | `[J]` | `[]` | none | none | `{J}` | `queued`, attempts 0 |
| 2. claim | worker: `ClaimLua`, then `TryStartAsync` | `[]` | `[J]` | `"w1"`, 30 s | none | `{J}` | `processing`, attempts 1 |
| 3. heartbeat | worker, every 10 s: `RenewLua` | `[]` | `[J]` | TTL back to 30 s | none | `{J}` | unchanged |
| 4. failure | worker: `RetryAsync`, then `RetryLua` | `[]` | `[]` | deleted | `J` due in ~2 s | `{J}` | `retrying`, attempts 1 |
| 5. due | anyone's maintenance: `MaintainLua` | `[J]` | `[]` | none | none | `{J}` | unchanged |
| 6. claim | worker: `ClaimLua`, then `TryStartAsync` | `[]` | `[J]` | `"w2"`, 30 s | none | `{J}` | `processing`, attempts 2 |
| 7. success | worker: `CompleteAsync`, then `AckLua` | `[]` | `[]` | deleted | none | `{}` | `ready`, attempts 2 |

The crash variant replaces steps 4–5: the worker dies, nobody renews `:lease:J`, Redis deletes it
when the TTL runs out, and the next `MaintainLua` pass sees "`J` is in `:processing` with no
lease" and puts it back at the front of `:jobs`. The row still says `processing`, which
`TryStartAsync` accepts, and the next claim counts attempt 2.

Notice the order for enqueue, retry and success: **Postgres first, Redis second**. If the process
dies between the two, the row is right and the janitor repairs Redis. The opposite order would
leave Redis holding a job the source of truth doesn't agree with. The claim is the one step that
goes Redis first, because the lease decides *who* may touch the row. If the worker dies right
after `ClaimLua`, the lease simply expires and the reaper hands the job to someone else.

Why **lists + lease keys** rather than Streams or a broker?

| Option | Redelivery of crashed work | KEDA scaler | Notes |
|---|---|---|---|
| Redis LIST + processing list + lease keys (this lab) | reaper moves expired leases back | `redis` (list length) | explicit and easy to inspect, but the reaping and fencing are your job |
| Redis Streams + consumer group | `XAUTOCLAIM` after min-idle-time | `redis-streams` (pending / lag) | built-in PEL and acknowledgements, more concepts |
| RabbitMQ 4 quorum queue | broker redelivers on channel close; delivery limit → DLX | `rabbitmq` | the "real" broker answer for cross-team messaging (*Message Brokers & the Outbox Pattern*) |
| Kafka (KRaft) | consumer offsets | `kafka` (lag) | event streams and replay, not per-job leasing |

:::pro title="Where seniors land"
For one team's background jobs on infrastructure you already run, a leased Redis list or Streams
is a fine choice. When several services consume the same events, you need routing, or you have
compliance requirements, move to RabbitMQ or Kafka with an outbox (*Message Brokers & the Outbox Pattern*). Whichever you pick,
rules 1–5 don't change. Brokers give you redelivery. None of them give you idempotency.
:::

:::warn title="No BLMOVE with StackExchange.Redis"
StackExchange.Redis **multiplexes** one connection for all callers, so it doesn't support
blocking commands like `BLPOP`/`BLMOVE`. A blocking call would stall everyone else on that
connection. The worker polls with a short, growing idle delay (200 ms → 2 s) instead. If you
need push-style wake-ups, add a pub/sub "new job" notification, or open a separate connection
that is used only for the blocking call (so it can't stall anyone else).
:::

## Failure matrix

| Failure | What happens | What saves you |
|---|---|---|
| Worker OOMKilled / `kill -9` mid-job | lease stops being renewed, expires after 30 s | reaper requeues; attempt counted at claim; DLQ after max |
| Worker gets SIGTERM (rollout, KEDA scale-down) | `stoppingToken` fires | job **released** to the front of the queue, attempt refunded |
| GC pause / network blip longer than the lease | a second worker claims the job | fencing on `attempts`; deterministic output key; heartbeat failure cancels the zombie |
| Redis restarts without data | lists and lease keys are gone | AOF, plus the janitor re-enqueues rows Redis doesn't know |
| API crashes between `UPDATE … queued` and `LPUSH` | row says queued, Redis has nothing | same janitor (the table doubles as an outbox) |
| Presigned URL expires mid-upload | `403` on later parts | client asks for fresh URLs for the same `UploadId` |
| Duplicate entry in the list | two copies of one id | claim uses `SET lease NX`, so the copy is dropped; DB claim ignores `ready` rows |
| All workers scaled to 0 | no reaper or promoter in workers | maintenance also runs in the always-on API |
| SignalR push lost (reconnect, deploy) | UI misses an update | client refetches `GET /api/media` on (re)connect |

:::job title="Day one on a team with a pipeline like this"
The first ticket is rarely "build it". It's *"job 0199… is stuck in processing, the customer is
angry."* Know the triage path: **row** (`status`, `attempts`, `updated_at`, `last_error`) → **Redis**
(`LPOS {media}:processing <id>`, `TTL {media}:lease:<id>`) → **trace** (search `media.id` in
Tempo) → **worker logs** in Loki for that trace id. Teams that write this down as a runbook resolve
incidents in minutes instead of hours.
:::

## Milestone plan

Don't build it all at once. Each milestone has a "done when" you can check before moving on, and
a rough time budget. Plan on **8–10 hours** in total, spread over several sessions. Stop at a
milestone boundary, commit, and write down which "done when" passed. Every milestone leaves a
working system, so the next session starts from something green.

| M | Goal | Done when | Budget |
|---|---|---|---|
| M0 | Infra up: Postgres 18, Redis 8, SeaweedFS, Keycloak 26, otel-lgtm | `docker compose ps` shows 5 running containers; Keycloak realm `media` exists | 30 min |
| M1 | Direct multipart upload | `scripts/smoke.sh` returns `queued`; object visible in the SeaweedFS filer UI | 1.5 h |
| M2 | Leased queue + worker | row goes `queued → processing → ready`; all `{media}` lists back to 0 | 1.5 h |
| M3 | Retries, backoff, DLQ | `flaky` ends `ready` on attempt 2; `broken` ends `dead` after 3; `poison` ends `dead` after crashes | 1 h |
| M4 | Live status via SignalR | browser table updates without a refresh | 45 min |
| M5 | Keycloak everywhere | API returns `401` without a token; hub rejects anonymous connections | 1 h |
| M6 | One trace + dashboard | Tempo shows `complete → media.enqueue → media.process`; 3 Grafana panels | 1 h |
| M7 | KEDA in kind | workers go 0 → N under a burst and back to 0 | 1.5 h |
| — | Incident phases | each phase's quiz answered *after* you reproduced it | 1–1.5 h |

:::lab id=cl-09-lab1 xp=300
title: Build the pipeline (M0–M6)
**Prerequisites:** Docker, .NET 10 SDK, Node 22+, `jq`, `curl`, GNU `split` (Linux has it; on
macOS `brew install coreutils` and use `gsplit` in `smoke.sh`). Ports used: 5432, 6379, 8333,
8888, 9333, 8180, 3000, 4317, 4318, 5080, 5173. Stop earlier lessons' containers if they clash.

### 0. Scaffold

```bash
mkdir media-boss && cd media-boss
mkdir -p infra/db infra/seaweedfs infra/keycloak scripts k8s
dotnet new sln -n MediaBoss                     # .NET 10 SDK creates MediaBoss.slnx (the XML format)
dotnet new classlib -n Media.Shared -o src/Media.Shared
dotnet new web      -n Media.Api    -o src/Media.Api
dotnet new worker   -n Media.Worker -o src/Media.Worker
rm src/Media.Shared/Class1.cs src/Media.Worker/Worker.cs
dotnet sln add src/Media.Shared src/Media.Api src/Media.Worker
dotnet add src/Media.Api    reference src/Media.Shared
dotnet add src/Media.Worker reference src/Media.Shared

dotnet add src/Media.Shared package StackExchange.Redis
dotnet add src/Media.Shared package Npgsql.DependencyInjection
dotnet add src/Media.Shared package AWSSDK.S3
dotnet add src/Media.Shared package Microsoft.AspNetCore.SignalR.StackExchangeRedis
for p in Media.Api Media.Worker; do
  dotnet add src/$p package OpenTelemetry.Extensions.Hosting
  dotnet add src/$p package OpenTelemetry.Exporter.OpenTelemetryProtocol
  dotnet add src/$p package OpenTelemetry.Instrumentation.Http
  dotnet add src/$p package Npgsql.OpenTelemetry
  dotnet add src/$p package OpenTelemetry.Instrumentation.StackExchangeRedis --prerelease
done
dotnet add src/Media.Api package OpenTelemetry.Instrumentation.AspNetCore
dotnet add src/Media.Api package Microsoft.AspNetCore.Authentication.JwtBearer
```

The shared library contains the hub type and a hosted service, so it needs the ASP.NET Core shared
framework. Add this inside `<Project>` in `src/Media.Shared/Media.Shared.csproj`. It flows to the
worker through the project reference, which is also why the worker image must be `aspnet`, not
`runtime`:

```xml
<ItemGroup>
  <FrameworkReference Include="Microsoft.AspNetCore.App" />
</ItemGroup>
```

### 1. Infrastructure (M0)

`compose.yaml`:

```yaml
name: media-boss
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: media
      POSTGRES_PASSWORD: media-dev-pw
      POSTGRES_DB: media
    ports: ["5432:5432"]
    volumes:
      - ./infra/db/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
      - pg:/var/lib/postgresql          # PG 18 images keep data under /var/lib/postgresql/18/…

  redis:
    image: redis:8
    command: ["redis-server", "--appendonly", "yes", "--appendfsync", "everysec"]
    ports: ["6379:6379"]
    volumes: [redis:/data]

  seaweedfs:
    image: chrislusf/seaweedfs:4.52     # newest in Nov 2026; pin the newest release tag
    command: ["server", "-dir=/data", "-s3", "-s3.config=/etc/seaweedfs/s3.json"]
    ports: ["8333:8333", "8888:8888", "9333:9333"]   # S3 gateway, filer UI, master UI
    volumes:
      - ./infra/seaweedfs/s3.json:/etc/seaweedfs/s3.json:ro
      - seaweed:/data

  keycloak:
    image: quay.io/keycloak/keycloak:26.8.2
    command: ["start-dev", "--import-realm", "--http-port=8180"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin-dev-pw
    ports: ["8180:8180"]
    volumes: [./infra/keycloak:/opt/keycloak/data/import:ro]

  lgtm:
    image: grafana/otel-lgtm:0.39.0     # Collector + Tempo + Prometheus + Loki + Grafana in one dev image
    ports: ["3000:3000", "4317:4317", "4318:4318"]

volumes: { pg: {}, redis: {}, seaweed: {} }
```

`infra/db/init.sql`:

```sql
CREATE TABLE media_uploads (
  id            uuid        PRIMARY KEY DEFAULT uuidv7(),   -- PostgreSQL 18 built-in
  owner_sub     text        NOT NULL,                       -- Keycloak "sub" of the uploader
  file_name     text        NOT NULL,
  content_type  text        NOT NULL,
  size_bytes    bigint      NOT NULL CHECK (size_bytes > 0),
  object_key    text        NOT NULL UNIQUE,                -- never derived from the file name
  s3_upload_id  text,
  status        text        NOT NULL DEFAULT 'uploading'
                CHECK (status IN ('uploading','queued','processing','retrying','ready','dead','aborted')),
  attempts      int         NOT NULL DEFAULT 0,
  last_error    text,
  trace_parent  text,                                       -- W3C traceparent captured at enqueue
  output_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  enqueued_at   timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON media_uploads (owner_sub, created_at DESC);
CREATE INDEX ON media_uploads (updated_at) WHERE status IN ('queued','retrying','processing');
```

`infra/seaweedfs/s3.json` (dev credentials for this lab only):

```json
{
  "identities": [
    {
      "name": "media-app",
      "credentials": [{ "accessKey": "media-dev-key", "secretKey": "media-dev-secret" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
```

`infra/keycloak/media-realm.json`, with a public SPA client (PKCE), a confidential `media-smoke`
client for scripts, an audience mapper and one test user:

```json
{
  "realm": "media",
  "enabled": true,
  "accessTokenLifespan": 300,
  "clients": [
    {
      "clientId": "media-spa",
      "publicClient": true,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": false,
      "redirectUris": ["http://localhost:5173/*"],
      "webOrigins": ["http://localhost:5173"],
      "attributes": { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": "http://localhost:5173/*" },
      "protocolMappers": [
        { "name": "aud-media-api", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
          "config": { "included.custom.audience": "media-api", "access.token.claim": "true", "id.token.claim": "false" } }
      ]
    },
    {
      "clientId": "media-smoke",
      "publicClient": false,
      "secret": "smoke-dev-secret",
      "serviceAccountsEnabled": true,
      "standardFlowEnabled": false,
      "protocolMappers": [
        { "name": "aud-media-api", "protocol": "openid-connect", "protocolMapper": "oidc-audience-mapper",
          "config": { "included.custom.audience": "media-api", "access.token.claim": "true", "id.token.claim": "false" } }
      ]
    }
  ],
  "users": [
    { "username": "alice", "enabled": true, "emailVerified": true, "email": "alice@example.test",
      "firstName": "Alice", "lastName": "Dev",
      "credentials": [{ "type": "password", "value": "alice-dev-pw", "temporary": false }] }
  ]
}
```

```bash
docker compose up -d
docker compose ps                                   # 5 services "running"
curl -s http://localhost:8180/realms/media/.well-known/openid-configuration | jq -r .issuer
# http://localhost:8180/realms/media      (Keycloak needs ~20 s on first start)
```

:::warn title="Check these against your versions"
SeaweedFS and Keycloak change flags between releases, so some keys above may differ for the tag
you pull. Check `docker compose run --rm seaweedfs server -h 2>&1 | grep s3` for the
`-s3.*` flags, and the SeaweedFS wiki page *"Amazon S3 API"* for the `s3.json` identity format and
CORS support. Keycloak ≥ 26 uses `KC_BOOTSTRAP_ADMIN_*`. The old `KEYCLOAK_ADMIN` variables are
deprecated. If a key is wrong, the container log usually says so in the first 20 lines.
:::

### 2. Shared library

`src/Media.Shared/JobQueue.cs` holds the leased queue. Every state change is **one atomic Lua script**:

```csharp
using System.Diagnostics.Metrics;
using StackExchange.Redis;

namespace Media.Shared;

public sealed class JobQueue(IConnectionMultiplexer redis)
{
    public const string Waiting = "{media}:jobs";
    public const string Processing = "{media}:processing";
    public const string Delayed = "{media}:delayed";
    public const string DeadLetter = "{media}:dlq";
    public const string Known = "{media}:known";
    public const string LeasePrefix = "{media}:lease:";

    IDatabase Db => redis.GetDatabase();

    // Enqueue only ids Redis doesn't already track → the janitor can re-enqueue blindly.
    const string EnqueueLua = """
        if redis.call('SADD', KEYS[2], ARGV[1]) == 1 then
          redis.call('LPUSH', KEYS[1], ARGV[1])
          return 1
        end
        return 0
        """;

    // Move + lease in ONE step: a job is never in "processing" without a lease.
    // SET NX: if someone already holds this id, the entry is a duplicate → drop it, return ''.
    const string ClaimLua = """
        local id = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
        if not id then return false end
        if redis.call('SET', ARGV[1] .. id, ARGV[2], 'NX', 'PX', ARGV[3]) then return id end
        redis.call('LREM', KEYS[2], 1, id)
        return ''
        """;

    const string RenewLua = """
        if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
        return 0
        """;

    // Ack / dead-letter: allowed if the lease is ours or already gone, refused if someone else holds it.
    const string AckLua = """
        local lease = ARGV[3] .. ARGV[1]
        local owner = redis.call('GET', lease)
        if owner and owner ~= ARGV[2] then return 0 end
        redis.call('LREM', KEYS[1], 1, ARGV[1])
        redis.call('DEL', lease)
        redis.call('SREM', KEYS[2], ARGV[1])
        if KEYS[3] then redis.call('LPUSH', KEYS[3], ARGV[1]) end
        return 1
        """;

    // Retry later: due time from the Redis server clock, so worker clock skew doesn't matter.
    const string RetryLua = """
        local lease = ARGV[3] .. ARGV[1]
        if redis.call('GET', lease) ~= ARGV[2] then return 0 end
        local t = redis.call('TIME')
        local due = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[4])
        redis.call('LREM', KEYS[1], 1, ARGV[1])
        redis.call('ZADD', KEYS[2], due, ARGV[1])
        redis.call('DEL', lease)
        return 1
        """;

    // Graceful shutdown: put the job back at the FRONT (consumers take from the right).
    const string ReleaseLua = """
        local lease = ARGV[3] .. ARGV[1]
        if redis.call('GET', lease) ~= ARGV[2] then return 0 end
        redis.call('LREM', KEYS[1], 1, ARGV[1])
        redis.call('RPUSH', KEYS[2], ARGV[1])
        redis.call('DEL', lease)
        return 1
        """;

    // Maintenance: promote due retries, reap in-flight jobs whose lease expired.
    const string MaintainLua = """
        local t = redis.call('TIME')
        local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
        local due = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, 100)
        for _, id in ipairs(due) do
          redis.call('ZREM', KEYS[3], id)
          redis.call('LPUSH', KEYS[1], id)
        end
        local reaped = 0
        for _, id in ipairs(redis.call('LRANGE', KEYS[2], 0, -1)) do
          if redis.call('EXISTS', ARGV[1] .. id) == 0 then
            redis.call('LREM', KEYS[2], 1, id)
            redis.call('RPUSH', KEYS[1], id)
            reaped = reaped + 1
          end
        end
        return { #due, reaped }
        """;

    const string RedriveLua = """
        redis.call('LREM', KEYS[1], 1, ARGV[1])
        if redis.call('SADD', KEYS[3], ARGV[1]) == 1 then redis.call('LPUSH', KEYS[2], ARGV[1]) end
        return 1
        """;

    public async Task<bool> EnqueueAsync(Guid id) =>
        (long)await Db.ScriptEvaluateAsync(EnqueueLua, new RedisKey[] { Waiting, Known }, new RedisValue[] { id.ToString() }) == 1;

    public async Task<Guid?> ClaimAsync(string worker, TimeSpan lease)
    {
        for (var i = 0; i < 10; i++)              // skip duplicate entries of jobs someone else holds
        {
            var r = await Db.ScriptEvaluateAsync(ClaimLua, new RedisKey[] { Waiting, Processing },
                new RedisValue[] { LeasePrefix, worker, (long)lease.TotalMilliseconds });
            if (r.IsNull) return null;
            var s = (string?)r;
            if (!string.IsNullOrEmpty(s)) return Guid.Parse(s);
        }
        return null;
    }

    public async Task<bool> RenewAsync(Guid id, string worker, TimeSpan lease) =>
        (long)await Db.ScriptEvaluateAsync(RenewLua, new RedisKey[] { LeasePrefix + id },
            new RedisValue[] { worker, (long)lease.TotalMilliseconds }) == 1;

    public async Task<bool> AckAsync(Guid id, string worker) =>
        (long)await Db.ScriptEvaluateAsync(AckLua, new RedisKey[] { Processing, Known },
            new RedisValue[] { id.ToString(), worker, LeasePrefix }) == 1;

    public async Task<bool> DeadLetterAsync(Guid id, string worker) =>
        (long)await Db.ScriptEvaluateAsync(AckLua, new RedisKey[] { Processing, Known, DeadLetter },
            new RedisValue[] { id.ToString(), worker, LeasePrefix }) == 1;

    public async Task<bool> RetryLaterAsync(Guid id, string worker, TimeSpan delay) =>
        (long)await Db.ScriptEvaluateAsync(RetryLua, new RedisKey[] { Processing, Delayed },
            new RedisValue[] { id.ToString(), worker, LeasePrefix, (long)delay.TotalMilliseconds }) == 1;

    public async Task<bool> ReleaseAsync(Guid id, string worker) =>
        (long)await Db.ScriptEvaluateAsync(ReleaseLua, new RedisKey[] { Processing, Waiting },
            new RedisValue[] { id.ToString(), worker, LeasePrefix }) == 1;

    public Task RedriveAsync(Guid id) =>
        Db.ScriptEvaluateAsync(RedriveLua, new RedisKey[] { DeadLetter, Waiting, Known }, new RedisValue[] { id.ToString() });

    public async Task<(int Promoted, int Reaped)> MaintainAsync()
    {
        var r = (RedisResult[])(await Db.ScriptEvaluateAsync(MaintainLua,
            new RedisKey[] { Waiting, Processing, Delayed }, new RedisValue[] { LeasePrefix }))!;
        return ((int)r[0], (int)r[1]);
    }

    // For an ObservableGauge (sync callback). Quick O(1) calls; returns nothing if Redis is down.
    public Measurement<long>[] DepthMeasurements()
    {
        try
        {
            var db = Db;
            return [M(db.ListLength(Waiting), "waiting"), M(db.ListLength(Processing), "processing"),
                    M(db.SortedSetLength(Delayed), "delayed"), M(db.ListLength(DeadLetter), "dead")];
        }
        catch (Exception) { return []; }

        static Measurement<long> M(long v, string queue) => new(v, new KeyValuePair<string, object?>("queue", queue));
    }
}
```

`src/Media.Shared/MediaStore.cs` holds all SQL in one place. Every worker write is **fenced** on the
attempt number:

```csharp
using Npgsql;

namespace Media.Shared;

public sealed record UploadRow(Guid Id, string OwnerSub, string FileName, string ContentType, long SizeBytes,
    string ObjectKey, string? S3UploadId, string Status, int Attempts, string? LastError, string? TraceParent,
    string? OutputKey, DateTimeOffset CreatedAt, DateTimeOffset? EnqueuedAt);

public sealed class MediaStore(NpgsqlDataSource db)
{
    const string Cols = "id, owner_sub, file_name, content_type, size_bytes, object_key, s3_upload_id, status, " +
                        "attempts, last_error, trace_parent, output_key, created_at, enqueued_at";

    // ── API side ──────────────────────────────────────────────────────────
    public Task CreateAsync(Guid id, string sub, string fileName, string contentType, long size, string key, string uploadId) =>
        Exec("""
            INSERT INTO media_uploads (id, owner_sub, file_name, content_type, size_bytes, object_key, s3_upload_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """, id, sub, fileName, contentType, size, key, uploadId);

    public async Task<UploadRow?> GetAsync(Guid id, string sub) =>
        (await Query($"SELECT {Cols} FROM media_uploads WHERE id = $1 AND owner_sub = $2", id, sub)).FirstOrDefault();

    public Task<List<UploadRow>> ListAsync(string sub) =>
        Query($"SELECT {Cols} FROM media_uploads WHERE owner_sub = $1 ORDER BY created_at DESC LIMIT 50", sub);

    public async Task<bool> MarkQueuedAsync(Guid id, string? traceParent) => await Exec("""
        UPDATE media_uploads SET status = 'queued', enqueued_at = now(), trace_parent = $2, updated_at = now()
         WHERE id = $1 AND status = 'uploading'
        """, id, traceParent) == 1;

    public async Task<bool> AbortAsync(Guid id, string sub) => await Exec("""
        UPDATE media_uploads SET status = 'aborted', updated_at = now()
         WHERE id = $1 AND owner_sub = $2 AND status = 'uploading'
        """, id, sub) == 1;

    public async Task<bool> RedriveAsync(Guid id, string sub) => await Exec("""
        UPDATE media_uploads SET status = 'queued', attempts = 0, last_error = NULL, updated_at = now()
         WHERE id = $1 AND owner_sub = $2 AND status = 'dead'
        """, id, sub) == 1;

    // ── worker side ───────────────────────────────────────────────────────
    // Rule 3: the attempt is counted HERE, at claim time. RETURNING gives the new values.
    // null = not runnable (ready / aborted / unknown) → a duplicate delivery to acknowledge.
    public async Task<UploadRow?> TryStartAsync(Guid id, int maxAttempts) => (await Query($"""
        UPDATE media_uploads
           SET attempts   = attempts + 1,
               status     = CASE WHEN attempts + 1 > $2 THEN 'dead' ELSE 'processing' END,
               last_error = CASE WHEN attempts + 1 > $2 THEN 'max attempts exceeded (worker crashed?)' ELSE last_error END,
               updated_at = now()
         WHERE id = $1 AND status IN ('queued', 'retrying', 'processing')
     RETURNING {Cols}
        """, id, maxAttempts)).FirstOrDefault();

    // Rule 4: "AND attempts = $2" is the fence — a zombie from an older attempt changes 0 rows.
    public async Task<bool> CompleteAsync(Guid id, int attempt, string outputKey) => await Exec("""
        UPDATE media_uploads SET status = 'ready', output_key = $3, last_error = NULL, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2
        """, id, attempt, outputKey) == 1;

    public async Task<bool> RetryAsync(Guid id, int attempt, string error) => await Exec("""
        UPDATE media_uploads SET status = 'retrying', last_error = $3, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2
        """, id, attempt, error) == 1;

    public async Task<bool> DeadAsync(Guid id, int attempt, string error) => await Exec("""
        UPDATE media_uploads SET status = 'dead', last_error = $3, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2
        """, id, attempt, error) == 1;

    // Graceful shutdown: hand the attempt back — being scaled down isn't the job's fault.
    public async Task<bool> ReleaseAsync(Guid id, int attempt) => await Exec("""
        UPDATE media_uploads SET status = 'queued', attempts = attempts - 1, updated_at = now()
         WHERE id = $1 AND status = 'processing' AND attempts = $2
        """, id, attempt) == 1;

    // Janitor input: rows that should be somewhere in Redis.
    public async Task<List<Guid>> StaleIdsAsync() => (await Query($"""
        SELECT {Cols} FROM media_uploads
         WHERE status IN ('queued', 'retrying', 'processing') AND updated_at < now() - interval '1 minute'
         ORDER BY updated_at LIMIT 500
        """)).Select(r => r.Id).ToList();

    // ── helpers ───────────────────────────────────────────────────────────
    NpgsqlCommand Cmd(string sql, object?[] args)
    {
        var cmd = db.CreateCommand(sql);
        foreach (var a in args) cmd.Parameters.Add(new NpgsqlParameter { Value = a ?? DBNull.Value });
        return cmd;
    }

    async Task<int> Exec(string sql, params object?[] args)
    {
        await using var cmd = Cmd(sql, args);
        return await cmd.ExecuteNonQueryAsync();
    }

    async Task<List<UploadRow>> Query(string sql, params object?[] args)
    {
        await using var cmd = Cmd(sql, args);
        await using var r = await cmd.ExecuteReaderAsync();
        var rows = new List<UploadRow>();
        while (await r.ReadAsync())
            rows.Add(new UploadRow(r.GetGuid(0), r.GetString(1), r.GetString(2), r.GetString(3), r.GetInt64(4),
                r.GetString(5), r.IsDBNull(6) ? null : r.GetString(6), r.GetString(7), r.GetInt32(8),
                r.IsDBNull(9) ? null : r.GetString(9), r.IsDBNull(10) ? null : r.GetString(10),
                r.IsDBNull(11) ? null : r.GetString(11), r.GetFieldValue<DateTimeOffset>(12),
                r.IsDBNull(13) ? null : r.GetFieldValue<DateTimeOffset>(13)));
        return rows;
    }
}
```

`src/Media.Shared/Pipeline.cs` holds the hub, the telemetry, S3, and maintenance that runs in **both** API and worker:

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Amazon.Runtime;
using Amazon.S3;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Media.Shared;

public sealed record JobUpdate(Guid Id, string Status, int Attempts, string? Error, string? OutputKey);

public interface IMediaClient { Task JobUpdated(JobUpdate update); }

// The API maps it at /hubs/media; the worker only uses IHubContext<MediaHub, IMediaClient>.
// Backplane channels are named after the hub's full type name + prefix, so BOTH must share this type.
[Authorize]
public sealed class MediaHub : Hub<IMediaClient>
{
    public const string ChannelPrefix = "media-signalr";
}

// Clients.User(x) targets the Keycloak "sub" claim (we turn off inbound claim mapping).
public sealed class SubUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) => connection.User?.FindFirst("sub")?.Value;
}

public static class MediaTelemetry
{
    public const string Name = "Media.Pipeline";
    public static readonly ActivitySource Source = new(Name);
    public static readonly Meter Meter = new(Name);
    public static readonly Histogram<double> JobLatency =
        Meter.CreateHistogram<double>("media.job.latency", unit: "s", description: "Enqueue → terminal state");
    public static readonly Counter<long> JobsProcessed =
        Meter.CreateCounter<long>("media.jobs.processed", unit: "{job}", description: "Finished attempts by outcome");
}

public static class S3Factory
{
    public static IAmazonS3 Create(IConfiguration s) => new AmazonS3Client(
        new BasicAWSCredentials(s["AccessKey"], s["SecretKey"]),
        new AmazonS3Config
        {
            ServiceURL = s["ServiceUrl"],          // http://localhost:8333 → SeaweedFS S3 gateway
            ForcePathStyle = true,                 // http://host/bucket/key (no bucket subdomains)
            AuthenticationRegion = "us-east-1",
            // Newer AWS SDKs add CRC checksums by default; some S3-compatible stores reject them.
            RequestChecksumCalculation = RequestChecksumCalculation.WHEN_REQUIRED,
            ResponseChecksumValidation = ResponseChecksumValidation.WHEN_REQUIRED,
        });
}

// Promote due retries + reap expired leases every 5 s; rebuild Redis from Postgres every minute.
// Runs in the API too: workers scale to zero, housekeeping must not.
public sealed class MaintenanceService(JobQueue queue, MediaStore store, ILogger<MaintenanceService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        var tick = 0;
        while (await timer.WaitForNextTickAsync(stopping))
        {
            try
            {
                var (_, reaped) = await queue.MaintainAsync();
                if (reaped > 0) log.LogWarning("Reaped {Count} job(s) whose lease expired", reaped);
                if (++tick % 12 != 0) continue;
                foreach (var id in await store.StaleIdsAsync())
                    if (await queue.EnqueueAsync(id))
                        log.LogWarning("Re-enqueued {Id}: Postgres has it, Redis didn't", id);
            }
            catch (Exception ex) { log.LogWarning(ex, "Maintenance pass failed; next tick retries"); }
        }
    }
}
```

:::warn title="AWS SDK details that vary by version"
`RequestChecksumCalculation`/`ResponseChecksumValidation` exist in recent `AWSSDK.S3` releases (the
default checksum change landed in early 2025). If they don't compile, your SDK is older and you can
delete those two lines. If presigned URLs come out with `Signature=` instead of `X-Amz-Signature=`,
an older SDK is presigning with SigV2. Set `AWSConfigsS3.UseSignatureVersion4 = true` at startup.
Check the AWS SDK for .NET developer guide for your major version.
:::

### 3. The API

`src/Media.Api/appsettings.Development.json`:

```json
{
  "ConnectionStrings": {
    "Postgres": "Host=localhost;Port=5432;Database=media;Username=media;Password=media-dev-pw",
    "Redis": "localhost:6379,abortConnect=false"
  },
  "Storage": {
    "ServiceUrl": "http://localhost:8333",
    "AccessKey": "media-dev-key",
    "SecretKey": "media-dev-secret",
    "Bucket": "media",
    "PresignSeconds": 900
  },
  "Auth": { "Authority": "http://localhost:8180/realms/media", "Audience": "media-api" },
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" } }
}
```

`src/Media.Api/Program.cs`:

```csharp
using System.Diagnostics;
using System.Security.Claims;
using Amazon.S3;
using Amazon.S3.Model;
using Media.Shared;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.SignalR;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);
var cfg = builder.Configuration;
var redisConn = cfg.GetConnectionString("Redis")!;
var bucket = cfg["Storage:Bucket"]!;
var presignTtl = TimeSpan.FromSeconds(cfg.GetValue("Storage:PresignSeconds", 900));
var serviceUrl = cfg["Storage:ServiceUrl"]!;
const long MinPartSize = 8 * 1024 * 1024;          // S3: every part but the last ≥ 5 MiB
const long MaxUpload = 5L * 1024 * 1024 * 1024;    // our product limit

builder.Services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redisConn));
builder.Services.AddNpgsqlDataSource(cfg.GetConnectionString("Postgres")!);
builder.Services.AddSingleton<JobQueue>();
builder.Services.AddSingleton<MediaStore>();
builder.Services.AddSingleton(_ => S3Factory.Create(cfg.GetSection("Storage")));
builder.Services.AddHostedService<MaintenanceService>();

builder.Services.AddSingleton<IUserIdProvider, SubUserIdProvider>();
builder.Services.AddSignalR().AddStackExchangeRedis(redisConn, o =>
    o.Configuration.ChannelPrefix = RedisChannel.Literal(MediaHub.ChannelPrefix));

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer(o =>
{
    o.Authority = cfg["Auth:Authority"];
    o.Audience = cfg["Auth:Audience"];
    o.RequireHttpsMetadata = !builder.Environment.IsDevelopment();   // Keycloak runs on http in dev
    o.MapInboundClaims = false;                                     // keep "sub" as "sub"
    o.Events = new JwtBearerEvents
    {
        // Browsers can't set headers on WebSockets → SignalR sends ?access_token=…
        OnMessageReceived = ctx =>
        {
            var token = ctx.Request.Query["access_token"].ToString();
            if (token.Length > 0 && ctx.HttpContext.Request.Path.StartsWithSegments("/hubs/media"))
                ctx.Token = token;
            return Task.CompletedTask;
        },
    };
});
builder.Services.AddAuthorization();

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("media-api"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation().AddHttpClientInstrumentation()
        .AddNpgsql().AddRedisInstrumentation().AddSource(MediaTelemetry.Name))
    .WithMetrics(m => m.AddAspNetCoreInstrumentation().AddMeter(MediaTelemetry.Name))
    .WithLogging()
    .UseOtlpExporter();                                             // OTEL_EXPORTER_OTLP_ENDPOINT, default localhost:4317

var app = builder.Build();

// The bucket must exist before the first presign.
var s3Client = app.Services.GetRequiredService<IAmazonS3>();
try { await s3Client.PutBucketAsync(bucket); }
catch (AmazonS3Exception e) when (e.ErrorCode is "BucketAlreadyOwnedByYou" or "BucketAlreadyExists") { }

// Queue depth is measured by the always-on API, not by workers that scale to zero.
var jobQueue = app.Services.GetRequiredService<JobQueue>();
MediaTelemetry.Meter.CreateObservableGauge<long>("media.queue.depth", () => jobQueue.DepthMeasurements(),
    unit: "{job}", description: "Jobs per Redis structure");

app.UseAuthentication();
app.UseAuthorization();
app.MapHub<MediaHub>("/hubs/media");

var media = app.MapGroup("/api/media").RequireAuthorization();
static string Sub(ClaimsPrincipal u) => u.FindFirst("sub")?.Value ?? throw new InvalidOperationException("token has no sub");

media.MapPost("/uploads", async (StartUpload req, ClaimsPrincipal user, MediaStore store, IAmazonS3 s3) =>
{
    if (req.SizeBytes is <= 0 or > MaxUpload) return Results.BadRequest("sizeBytes must be between 1 B and 5 GiB");
    if (!req.ContentType.StartsWith("video/", StringComparison.OrdinalIgnoreCase)) return Results.BadRequest("video/* only");

    var id = Guid.CreateVersion7();
    var key = $"uploads/{id}/source";                       // never trust the client's file name in a key
    var partSize = Math.Max(MinPartSize, (long)Math.Ceiling(req.SizeBytes / 10_000.0)); // ≤ 10 000 parts
    var partCount = (int)Math.Ceiling(req.SizeBytes / (double)partSize);

    var mpu = await s3.InitiateMultipartUploadAsync(new InitiateMultipartUploadRequest
        { BucketName = bucket, Key = key, ContentType = req.ContentType });
    await store.CreateAsync(id, Sub(user), req.FileName, req.ContentType, req.SizeBytes, key, mpu.UploadId);

    var parts = Enumerable.Range(1, partCount).Select(n => new PartUrl(n, Presign(s3, key, mpu.UploadId, n))).ToArray();
    return Results.Ok(new StartUploadResponse(id, partSize, parts));
});

// Fresh URLs for parts whose URL expired (laptop slept, slow Wi-Fi…). Same UploadId, nothing re-sent.
media.MapPost("/uploads/{id:guid}/parts", async (Guid id, RefreshParts req, ClaimsPrincipal user, MediaStore store, IAmazonS3 s3) =>
{
    var row = await store.GetAsync(id, Sub(user));
    if (row is null) return Results.NotFound();
    if (row.Status != "uploading") return Results.Conflict($"upload is {row.Status}");
    var parts = req.PartNumbers.Where(n => n is >= 1 and <= 10_000)
        .Select(n => new PartUrl(n, Presign(s3, row.ObjectKey, row.S3UploadId!, n))).ToArray();
    return Results.Ok(new { parts });
});

media.MapPost("/uploads/{id:guid}/complete", async (Guid id, CompleteUpload req, ClaimsPrincipal user,
    MediaStore store, IAmazonS3 s3, JobQueue queue, IHubContext<MediaHub, IMediaClient> hub) =>
{
    var sub = Sub(user);
    var row = await store.GetAsync(id, sub);
    if (row is null) return Results.NotFound();
    if (row.Status != "uploading") return Results.Accepted($"/api/media/{id}", new { id, status = row.Status }); // replay = no-op

    await s3.CompleteMultipartUploadAsync(new CompleteMultipartUploadRequest
    {
        BucketName = bucket, Key = row.ObjectKey, UploadId = row.S3UploadId,
        PartETags = req.Parts.OrderBy(p => p.PartNumber).Select(p => new PartETag(p.PartNumber, p.ETag)).ToList(),
    });
    var head = await s3.GetObjectMetadataAsync(bucket, row.ObjectKey);
    if (head.ContentLength != row.SizeBytes)
        return Results.BadRequest($"size mismatch: stored {head.ContentLength}, announced {row.SizeBytes}");

    using var span = MediaTelemetry.Source.StartActivity("media.enqueue", ActivityKind.Producer);
    span?.SetTag("media.id", id);
    if (await store.MarkQueuedAsync(id, Activity.Current?.Id))       // W3C traceparent of this span
    {
        await queue.EnqueueAsync(id);                                // crash right here? the janitor re-enqueues
        await hub.Clients.User(sub).JobUpdated(new JobUpdate(id, "queued", 0, null, null));
    }
    return Results.Accepted($"/api/media/{id}", new { id, status = "queued" });
});

media.MapPost("/uploads/{id:guid}/abort", async (Guid id, ClaimsPrincipal user, MediaStore store, IAmazonS3 s3) =>
{
    var row = await store.GetAsync(id, Sub(user));
    if (row is null || !await store.AbortAsync(id, Sub(user))) return Results.NotFound();
    await s3.AbortMultipartUploadAsync(bucket, row.ObjectKey, row.S3UploadId);
    return Results.NoContent();
});

media.MapGet("", async (ClaimsPrincipal user, MediaStore store) => Results.Ok(await store.ListAsync(Sub(user))));
media.MapGet("/{id:guid}", async (Guid id, ClaimsPrincipal user, MediaStore store) =>
    await store.GetAsync(id, Sub(user)) is { } row ? Results.Ok(row) : Results.NotFound());

media.MapPost("/{id:guid}/redrive", async (Guid id, ClaimsPrincipal user, MediaStore store, JobQueue queue) =>
{
    if (!await store.RedriveAsync(id, Sub(user))) return Results.Conflict("only dead jobs can be redriven");
    await queue.RedriveAsync(id);
    return Results.Accepted($"/api/media/{id}");
});

app.Run();

string Presign(IAmazonS3 s3, string key, string uploadId, int part) => s3.GetPreSignedURL(new GetPreSignedUrlRequest
{
    BucketName = bucket, Key = key, Verb = HttpVerb.PUT, UploadId = uploadId, PartNumber = part,
    Expires = DateTime.UtcNow.Add(presignTtl),
    Protocol = serviceUrl.StartsWith("https", StringComparison.OrdinalIgnoreCase) ? Protocol.HTTPS : Protocol.HTTP,
});

record StartUpload(string FileName, string ContentType, long SizeBytes);
record PartUrl(int PartNumber, string Url);
record StartUploadResponse(Guid Id, long PartSize, PartUrl[] Parts);
record CompletedPart(int PartNumber, string ETag);
record CompleteUpload(CompletedPart[] Parts);
record RefreshParts(int[] PartNumbers);
```

### 4. The worker

`src/Media.Worker/appsettings.json`:

```json
{
  "ConnectionStrings": {
    "Postgres": "Host=localhost;Port=5432;Database=media;Username=media;Password=media-dev-pw",
    "Redis": "localhost:6379,abortConnect=false"
  },
  "Storage": { "ServiceUrl": "http://localhost:8333", "AccessKey": "media-dev-key", "SecretKey": "media-dev-secret" },
  "Worker": { "Bucket": "media", "MaxAttempts": 3, "Lease": "00:00:30", "UseFfmpeg": false },
  "Logging": { "LogLevel": { "Default": "Information" } }
}
```

`src/Media.Worker/Program.cs`:

```csharp
using Media.Shared;
using Media.Worker;
using Npgsql;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using StackExchange.Redis;

var builder = Host.CreateApplicationBuilder(args);
var cfg = builder.Configuration;
var redisConn = cfg.GetConnectionString("Redis")!;

builder.Services.Configure<WorkerOptions>(cfg.GetSection("Worker"));
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(25)); // < pod grace period
builder.Services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redisConn));
builder.Services.AddNpgsqlDataSource(cfg.GetConnectionString("Postgres")!);
builder.Services.AddSingleton<JobQueue>();
builder.Services.AddSingleton<MediaStore>();
builder.Services.AddSingleton(_ => S3Factory.Create(cfg.GetSection("Storage")));
if (cfg.GetValue<bool>("Worker:UseFfmpeg")) builder.Services.AddSingleton<ITranscoder, FfmpegTranscoder>();
else builder.Services.AddSingleton<ITranscoder, FakeTranscoder>();

// No hub endpoint here, just the backplane, so IHubContext publishes to Redis
// and the API replica holding the user's connection delivers it.
builder.Services.AddSignalR().AddStackExchangeRedis(redisConn, o =>
    o.Configuration.ChannelPrefix = RedisChannel.Literal(MediaHub.ChannelPrefix));

builder.Services.AddHostedService<TranscodeWorker>();
builder.Services.AddHostedService<MaintenanceService>();

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("media-worker"))
    .WithTracing(t => t.AddSource(MediaTelemetry.Name).AddHttpClientInstrumentation().AddNpgsql().AddRedisInstrumentation())
    .WithMetrics(m => m.AddMeter(MediaTelemetry.Name).AddMeter("System.Runtime")
        // Default histogram buckets are made for milliseconds (0, 5, 10, 25 … 10 000). We record seconds.
        .AddView("media.job.latency", new ExplicitBucketHistogramConfiguration
            { Boundaries = [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600] }))
    .WithLogging()
    .UseOtlpExporter();

builder.Build().Run();
```

`src/Media.Worker/TranscodeWorker.cs` is the heart of the boss:

```csharp
using System.Diagnostics;
using Media.Shared;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;
using StackExchange.Redis;

namespace Media.Worker;

public sealed class WorkerOptions
{
    public string Bucket { get; set; } = "media";
    public int MaxAttempts { get; set; } = 3;
    public TimeSpan Lease { get; set; } = TimeSpan.FromSeconds(30);
    public bool UseFfmpeg { get; set; }
}

public sealed class TranscodeWorker(JobQueue queue, MediaStore store, ITranscoder transcoder,
    IHubContext<MediaHub, IMediaClient> hub, IOptions<WorkerOptions> options, ILogger<TranscodeWorker> log)
    : BackgroundService
{
    readonly WorkerOptions opt = options.Value;
    readonly string workerId = $"{Environment.MachineName}/{Guid.NewGuid():N}";

    protected override async Task ExecuteAsync(CancellationToken stopping)
    {
        log.LogInformation("Worker {WorkerId} started", workerId);
        var idle = TimeSpan.FromMilliseconds(200);
        while (!stopping.IsCancellationRequested)
        {
            Guid? id;
            try { id = await queue.ClaimAsync(workerId, opt.Lease); }
            catch (Exception ex) when (ex is RedisException or TimeoutException)
            {
                log.LogWarning(ex, "Redis unavailable, backing off");
                await Task.Delay(TimeSpan.FromSeconds(2), stopping);
                continue;
            }
            if (id is null)                                   // empty queue: poll with a growing delay
            {
                await Task.Delay(idle, stopping);
                idle = TimeSpan.FromMilliseconds(Math.Min(idle.TotalMilliseconds * 2, 2000));
                continue;
            }
            idle = TimeSpan.FromMilliseconds(200);
            try { await ProcessAsync(id.Value, stopping); }   // one job at a time per pod; scale with pods
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // e.g. Postgres down mid-job. Don't let one job kill the host (an unhandled exception in
                // ExecuteAsync stops the whole process). The lease expires and the reaper retries it.
                log.LogError(ex, "Job {Id} failed outside the retry path; the lease will expire", id);
                await Task.Delay(TimeSpan.FromSeconds(2), stopping);
            }
        }
    }

    async Task ProcessAsync(Guid id, CancellationToken stopping)
    {
        var job = await store.TryStartAsync(id, opt.MaxAttempts);
        if (job is null)                                      // ready / aborted / gone → duplicate delivery
        {
            await queue.AckAsync(id, workerId);
            MediaTelemetry.JobsProcessed.Add(1, new KeyValuePair<string, object?>("outcome", "duplicate"));
            return;
        }

        // Rule 5: continue the trace that the API started in "complete".
        ActivityContext.TryParse(job.TraceParent, null, out var parent);
        using var span = MediaTelemetry.Source.StartActivity("media.process", ActivityKind.Consumer, parent);
        span?.SetTag("media.id", id);
        span?.SetTag("media.attempt", job.Attempts);
        span?.SetTag("worker.id", workerId);

        if (job.Status == "dead")                             // claimed once too often: crashes never reach a catch
        {
            await queue.DeadLetterAsync(id, workerId);
            await Finish(job, "dead", job.LastError, null);
            return;
        }

        using var jobCts = CancellationTokenSource.CreateLinkedTokenSource(stopping);
        var leaseLost = false;
        var heartbeat = Task.Run(async () =>
        {
            using var timer = new PeriodicTimer(opt.Lease / 3);
            try
            {
                while (await timer.WaitForNextTickAsync(jobCts.Token))
                {
                    bool renewed;
                    try { renewed = await queue.RenewAsync(id, workerId, opt.Lease); }
                    catch (Exception ex) { log.LogWarning(ex, "Lease renew failed; retrying next tick"); continue; }
                    if (!renewed) { leaseLost = true; await jobCts.CancelAsync(); }   // someone else owns it now
                }
            }
            catch (OperationCanceledException) { }
        });

        try
        {
            await Notify(job, "processing", null, null);
            var output = await transcoder.RunAsync(job, jobCts.Token);
            if (await store.CompleteAsync(id, job.Attempts, output))
            {
                await queue.AckAsync(id, workerId);
                await Finish(job, "ready", null, output);
            }
            else log.LogWarning("Job {Id} attempt {Attempt} was fenced out — a newer attempt owns it", id, job.Attempts);
        }
        catch (OperationCanceledException) when (leaseLost)
        {
            log.LogWarning("Lost the lease on {Id}; abandoning attempt {Attempt}", id, job.Attempts);
        }
        catch (OperationCanceledException) when (stopping.IsCancellationRequested)
        {
            // SIGTERM (rollout, KEDA scale-down): hand the job back NOW, don't make it wait for the lease.
            await store.ReleaseAsync(id, job.Attempts);
            await queue.ReleaseAsync(id, workerId);
            log.LogInformation("Released {Id} on shutdown", id);
        }
        catch (Exception ex)
        {
            span?.AddException(ex);
            span?.SetStatus(ActivityStatusCode.Error, ex.Message);
            if (job.Attempts >= opt.MaxAttempts)
            {
                await store.DeadAsync(id, job.Attempts, ex.Message);
                await queue.DeadLetterAsync(id, workerId);
                await Finish(job, "dead", ex.Message, null);
            }
            else
            {
                var delay = Backoff(job.Attempts);
                await store.RetryAsync(id, job.Attempts, ex.Message);
                await queue.RetryLaterAsync(id, workerId, delay);
                MediaTelemetry.JobsProcessed.Add(1, new KeyValuePair<string, object?>("outcome", "retry"));
                log.LogWarning("Job {Id} attempt {Attempt} failed: {Error}; retry in {Delay}", id, job.Attempts, ex.Message, delay);
                await Notify(job, "retrying", ex.Message, null);
            }
        }
        finally
        {
            await jobCts.CancelAsync();
            await heartbeat;
        }
    }

    // 2 s, 4 s, 8 s … capped at 60 s, ±20 % jitter so a burst of failures doesn't retry in lockstep.
    static TimeSpan Backoff(int attempt) =>
        TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, attempt)) * (0.8 + Random.Shared.NextDouble() * 0.4));

    async Task Finish(UploadRow job, string status, string? error, string? output)
    {
        var latency = DateTimeOffset.UtcNow - (job.EnqueuedAt ?? job.CreatedAt);
        MediaTelemetry.JobLatency.Record(latency.TotalSeconds, new KeyValuePair<string, object?>("outcome", status));
        MediaTelemetry.JobsProcessed.Add(1, new KeyValuePair<string, object?>("outcome", status == "ready" ? "success" : status));
        log.LogInformation("Job {Id} attempt {Attempt} → {Status} after {Latency:F1} s", job.Id, job.Attempts, status, latency.TotalSeconds);
        await Notify(job, status, error, output);
    }

    // Best effort: a lost push is fixed by the client's refetch on reconnect.
    async Task Notify(UploadRow job, string status, string? error, string? output)
    {
        try { await hub.Clients.User(job.OwnerSub).JobUpdated(new JobUpdate(job.Id, status, job.Attempts, error, output)); }
        catch (Exception ex) { log.LogWarning(ex, "Status push failed for {Id}", job.Id); }
    }
}
```

`src/Media.Worker/Transcoders.cs`: a fake transcoder with failure modes you can trigger by
file name, and a real ffmpeg one:

```csharp
using System.Diagnostics;
using System.Text.Json;
using Amazon.S3;
using Amazon.S3.Model;
using Media.Shared;
using Microsoft.Extensions.Options;

namespace Media.Worker;

public interface ITranscoder { Task<string> RunAsync(UploadRow job, CancellationToken ct); }

public sealed class FakeTranscoder(IAmazonS3 s3, IOptions<WorkerOptions> opt) : ITranscoder
{
    public async Task<string> RunAsync(UploadRow job, CancellationToken ct)
    {
        using var span = MediaTelemetry.Source.StartActivity("media.transcode.fake");
        await s3.GetObjectMetadataAsync(opt.Value.Bucket, job.ObjectKey, ct);        // the source must exist
        var name = job.FileName.ToLowerInvariant();
        if (name.Contains("poison")) Environment.FailFast("simulated crash (think OOMKill) on a poison video");
        await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(job.SizeBytes / (4 * 1024 * 1024), 2, 60)), ct); // ~1 s / 4 MiB
        if (name.Contains("flaky") && job.Attempts == 1) throw new IOException("simulated transient error on attempt 1");
        if (name.Contains("broken")) throw new InvalidDataException("simulated: moov atom not found");

        var key = $"outputs/{job.Id}/result.json";            // deterministic → a re-run overwrites, never duplicates
        await s3.PutObjectAsync(new PutObjectRequest
        {
            BucketName = opt.Value.Bucket, Key = key, ContentType = "application/json",
            ContentBody = JsonSerializer.Serialize(new { job.Id, job.SizeBytes, job.Attempts, at = DateTimeOffset.UtcNow }),
        }, ct);
        return key;
    }
}

public sealed class FfmpegTranscoder(IAmazonS3 s3, IOptions<WorkerOptions> opt) : ITranscoder
{
    public async Task<string> RunAsync(UploadRow job, CancellationToken ct)
    {
        var dir = Directory.CreateTempSubdirectory("media-");
        try
        {
            var input = Path.Combine(dir.FullName, "source");
            var output = Path.Combine(dir.FullName, "720p.mp4");
            using (var obj = await s3.GetObjectAsync(opt.Value.Bucket, job.ObjectKey, ct))
                await obj.WriteResponseStreamToFileAsync(input, false, ct);   // stream to disk, never into RAM
            await Ffmpeg(["-y", "-i", input, "-vf", "scale=-2:720", "-c:v", "libx264", "-preset", "veryfast",
                          "-crf", "23", "-c:a", "aac", "-movflags", "+faststart", output], ct);
            var key = $"outputs/{job.Id}/720p.mp4";
            await s3.PutObjectAsync(new PutObjectRequest
                { BucketName = opt.Value.Bucket, Key = key, FilePath = output, ContentType = "video/mp4" }, ct);
            return key;
        }
        finally { dir.Delete(recursive: true); }
    }

    static async Task Ffmpeg(string[] args, CancellationToken ct)
    {
        using var span = MediaTelemetry.Source.StartActivity("ffmpeg");
        var psi = new ProcessStartInfo("ffmpeg") { RedirectStandardError = true };
        foreach (var a in args) psi.ArgumentList.Add(a);                    // no shell, no injection
        using var p = Process.Start(psi)!;
        using var kill = ct.Register(() => { try { p.Kill(entireProcessTree: true); } catch { } });
        var stderr = p.StandardError.ReadToEndAsync(CancellationToken.None);
        await p.WaitForExitAsync(ct);
        if (p.ExitCode != 0)
        {
            var err = await stderr;
            throw new InvalidOperationException($"ffmpeg exited {p.ExitCode}: {err[Math.Max(0, err.Length - 400)..]}");
        }
    }
}
```

```bash
dotnet build                                   # 0 errors
dotnet run --project src/Media.Api --urls http://localhost:5080
# info: Microsoft.Hosting.Lifetime[14] Now listening on: http://localhost:5080
dotnet run --project src/Media.Worker          # second terminal
# info: Media.Worker.TranscodeWorker[0] Worker <host>/<guid> started
```

### 5. Prove M1–M3 from the terminal

`scripts/smoke.sh` gets a token for the `media-smoke` service account, uploads a file in parts
straight to SeaweedFS and completes it:

```bash
#!/usr/bin/env bash
# usage: scripts/smoke.sh <file>     → prints {"id": "...", "status": "queued"}
set -euo pipefail
FILE=$1
API=${API:-http://localhost:5080}
TOKEN=$(curl -sf -d grant_type=client_credentials -d client_id=media-smoke -d client_secret=smoke-dev-secret \
  http://localhost:8180/realms/media/protocol/openid-connect/token | jq -r .access_token)
SIZE=$(wc -c < "$FILE" | tr -d ' ')
INIT=$(curl -sf -X POST "$API/api/media/uploads" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"fileName\":\"$(basename "$FILE")\",\"contentType\":\"video/mp4\",\"sizeBytes\":$SIZE}")
ID=$(jq -r .id <<<"$INIT"); PART_SIZE=$(jq -r .partSize <<<"$INIT")
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
split -b "$PART_SIZE" -d -a 4 "$FILE" "$WORK/part-"
PARTS='[]'; n=0
for f in "$WORK"/part-*; do
  n=$((n + 1))
  URL=$(jq -r ".parts[] | select(.partNumber == $n) | .url" <<<"$INIT")
  ETAG=$(curl -sf --upload-file "$f" -D - -o /dev/null "$URL" | tr -d '\r' | awk 'tolower($1) == "etag:" { print $2 }')
  PARTS=$(jq -c --argjson n "$n" --arg e "$ETAG" '. + [{partNumber: $n, eTag: $e}]' <<<"$PARTS")
done
curl -sf -X POST "$API/api/media/uploads/$ID/complete" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"parts\": $PARTS}"
echo
```

`scripts/depth.sh` shows all four Redis structures in one atomic read:

```bash
#!/usr/bin/env bash
docker compose exec -T redis redis-cli eval \
  "return {redis.call('LLEN',KEYS[1]), redis.call('LLEN',KEYS[2]), redis.call('ZCARD',KEYS[3]), redis.call('LLEN',KEYS[4])}" \
  4 '{media}:jobs' '{media}:processing' '{media}:delayed' '{media}:dlq' | paste -sd' ' | awk '{ print "waiting="$1" processing="$2" delayed="$3" dead="$4 }'
```

```bash
chmod +x scripts/*.sh
head -c 24M /dev/urandom > sample.mp4          # the fake transcoder doesn't care about content
cp sample.mp4 sample-flaky.mp4 && cp sample.mp4 sample-broken.mp4

scripts/smoke.sh sample.mp4
# {"id":"0199…","status":"queued"}
scripts/depth.sh                                 # run a few times while it works
# waiting=0 processing=1 delayed=0 dead=0   …then   waiting=0 processing=0 delayed=0 dead=0

scripts/smoke.sh sample-flaky.mp4 && scripts/smoke.sh sample-broken.mp4
sleep 45
docker compose exec postgres psql -U media -c \
  "SELECT file_name, status, attempts, last_error FROM media_uploads ORDER BY created_at"
```

Expected (ids and timings differ):

```text
     file_name     | status | attempts |           last_error
-------------------+--------+----------+--------------------------------
 sample.mp4        | ready  |        1 |
 sample-flaky.mp4  | ready  |        2 |
 sample-broken.mp4 | dead   |        3 | simulated: moov atom not found
```

Worker log for the flaky one: `attempt 1 failed: simulated transient error…; retry in 00:00:02.1`,
then `attempt 2 → ready`. Retries are promoted by the 5-second maintenance tick, so the real
delay is backoff rounded up to the next tick. Open `http://localhost:8888/buckets/media/` (filer UI)
to see `uploads/…/source` and `outputs/…/result.json`. The broken one is now in the DLQ:

```bash
scripts/depth.sh                                                   # waiting=0 processing=0 delayed=0 dead=1
docker compose exec redis redis-cli LRANGE '{media}:dlq' 0 -1      # the sample-broken id
```

**The poison drill.** This proves rule 3 (attempts counted at claim time):

```bash
cp sample.mp4 sample-poison.mp4 && scripts/smoke.sh sample-poison.mp4
```

The worker process dies with `simulated crash` (`Environment.FailFast`, which skips every `catch`
and `finally`, just like an OOMKill). Start it again with the same `dotnet run` command. About
30 s later the lease has expired and a maintenance loop (the API's, or the restarted worker's) logs
`Reaped 1 job(s)`. The worker claims the job as attempt 2 and dies again. Restart it each time it dies (three crashes in total). On the
**fourth** claim `TryStartAsync` sees `attempts + 1 > 3`, the row goes `dead` with
`max attempts exceeded (worker crashed?)`, the id lands in `{media}:dlq`, and the worker survives
because it never calls the transcoder for a dead job.

To practise a redrive, "ship a fix" (rename the file so the fake transcoder stops crashing) and
send the job back. The smoke script's service account owns the row, so use its token:

```bash
ID=$(docker compose exec -T postgres psql -U media -qtAc \
  "UPDATE media_uploads SET file_name = 'sample-fixed.mp4'
    WHERE id = (SELECT id FROM media_uploads
                 WHERE file_name = 'sample-poison.mp4' AND status = 'dead'
                 ORDER BY created_at DESC LIMIT 1)
   RETURNING id")                                                 # exactly one dead row
TOKEN=$(curl -sf -d grant_type=client_credentials -d client_id=media-smoke -d client_secret=smoke-dev-secret \
  http://localhost:8180/realms/media/protocol/openid-connect/token | jq -r .access_token)
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5080/api/media/$ID/redrive"                    # 202, and the row ends ready (attempts 1)
```

### 6. The React client (M4, M5)

```bash
npm create vite@latest web -- --template react-ts
cd web && npm install && npm install @microsoft/signalr oidc-client-ts react-oidc-context
```

If `create-vite` asks whether to install and start the dev server now, answer **No**. You'll
replace `src/main.tsx` and `src/App.tsx` first.

`web/vite.config.ts`. Everything is same-origin in dev: the API, the hub, **and** S3 through a
proxy. No CORS setup is needed, and the browser can read each part's `ETag`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:5080',
      '/hubs': { target: 'http://localhost:5080', ws: true },
      // changeOrigin → Host: localhost:8333, which is the host the URL was signed for
      '/s3': { target: 'http://localhost:8333', changeOrigin: true, rewrite: (p) => p.replace(/^\/s3/, '') },
    },
  },
})
```

`web/src/upload.ts`:

```ts
export type Api = (path: string, init?: RequestInit) => Promise<Response>
type PartUrl = { partNumber: number; url: string }
type StartResponse = { id: string; partSize: number; parts: PartUrl[] }

// Dev only: presigned URLs point at http://localhost:8333; send them through Vite's /s3 proxy.
const viaProxy = (url: string) => {
  const u = new URL(url)
  return `/s3${u.pathname}${u.search}`
}

export async function uploadVideo(file: File, api: Api, onProgress: (pct: number) => void, concurrency = 3): Promise<string> {
  const start = await api('/api/media/uploads', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType: file.type || 'video/mp4', sizeBytes: file.size }),
  })
  if (!start.ok) throw new Error(`start failed: ${start.status} ${await start.text()}`)
  const { id, partSize, parts }: StartResponse = await start.json()
  const urls = new Map(parts.map((p) => [p.partNumber, p.url]))
  const pending = parts.map((p) => p.partNumber)
  const done: { partNumber: number; eTag: string }[] = []

  async function presign(partNumber: number) {
    const r = await api(`/api/media/uploads/${id}/parts`, { method: 'POST', body: JSON.stringify({ partNumbers: [partNumber] }) })
    if (!r.ok) throw new Error(`re-presign failed: ${r.status}`)
    const body: { parts: PartUrl[] } = await r.json()
    urls.set(partNumber, body.parts[0].url)
  }

  async function sendPart(partNumber: number) {
    const from = (partNumber - 1) * partSize
    const blob = file.slice(from, Math.min(from + partSize, file.size))
    for (let attempt = 1; attempt <= 5; attempt++) {
      const res = await fetch(viaProxy(urls.get(partNumber)!), { method: 'PUT', body: blob }).catch(() => null)
      if (res?.ok) {
        const eTag = res.headers.get('ETag')
        if (!eTag) throw new Error('ETag not readable: cross-origin S3 needs CORS ExposeHeaders: ETag')
        done.push({ partNumber, eTag })
        onProgress(Math.round((done.length / parts.length) * 100))
        return
      }
      if (res?.status === 403) { await presign(partNumber); continue }   // expired URL → fresh one, same UploadId
      if (res && res.status < 500) throw new Error(`part ${partNumber}: HTTP ${res.status}`)
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))       // 5xx / network → back off
    }
    throw new Error(`part ${partNumber} failed after 5 attempts`)
  }

  // A small worker pool: at most `concurrency` PUTs in flight.
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    for (let n = pending.shift(); n !== undefined; n = pending.shift()) await sendPart(n)
  }))

  done.sort((a, b) => a.partNumber - b.partNumber)                    // S3 wants ascending part numbers
  const complete = await api(`/api/media/uploads/${id}/complete`, { method: 'POST', body: JSON.stringify({ parts: done }) })
  if (!complete.ok) throw new Error(`complete failed: ${complete.status}`)
  return id
}
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from 'react-oidc-context'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider
      authority="http://localhost:8180/realms/media"
      client_id="media-spa"
      redirect_uri="http://localhost:5173/"
      post_logout_redirect_uri="http://localhost:5173/"
      onSigninCallback={() => window.history.replaceState({}, '', '/')}
    >
      <App />
    </AuthProvider>
  </StrictMode>,
)
```

`web/src/App.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr'
import { uploadVideo, type Api } from './upload'

type Job = { id: string; fileName?: string; status: string; attempts: number; lastError?: string | null }
type JobUpdate = { id: string; status: string; attempts: number; error: string | null; outputKey: string | null }

// Pushes can arrive out of order (API sends "queued", worker sends "processing").
// Order by (attempt, stage) and ignore anything older than what we show.
// (A redrive resets attempts to 0, so refetch GET /api/media after redriving.)
const stage: Record<string, number> = { uploading: 0, queued: 1, processing: 2, retrying: 3, ready: 4, dead: 4, aborted: 4 }
const rank = (j: { status: string; attempts: number }) => j.attempts * 10 + (stage[j.status] ?? 0)

export function App() {
  const auth = useAuth()
  const token = auth.user?.access_token
  const [jobs, setJobs] = useState<Record<string, Job>>({})
  const [progress, setProgress] = useState<number | null>(null)

  const api: Api = useMemo(
    () => (path, init) => fetch(path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }),
    [token],
  )

  useEffect(() => {
    if (!token) return
    const refresh = async () => {
      const res = await api('/api/media')
      if (res.ok) setJobs(Object.fromEntries(((await res.json()) as Job[]).map((j) => [j.id, j])))
    }
    const conn = new HubConnectionBuilder()
      .withUrl('/hubs/media', { accessTokenFactory: () => auth.user?.access_token ?? '' })
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build()
    conn.on('JobUpdated', (u: JobUpdate) =>
      setJobs((prev) => {
        const cur = prev[u.id]
        if (cur && rank(u) < rank(cur)) return prev
        return { ...prev, [u.id]: { ...cur, id: u.id, status: u.status, attempts: u.attempts, lastError: u.error } }
      }),
    )
    conn.onreconnected(() => void refresh())            // pushes missed while offline → re-read the truth
    conn.start().then(refresh).catch(console.error)
    return () => void conn.stop()
  }, [token, api])

  async function onFile(file: File) {
    setProgress(0)
    try {
      const id = await uploadVideo(file, api, setProgress)
      setJobs((prev) => ({ ...prev, [id]: { attempts: 0, status: 'queued', ...prev[id], id, fileName: file.name } }))
    } catch (e) {
      alert(`Upload failed: ${(e as Error).message}`)
    } finally {
      setProgress(null)
    }
  }

  if (auth.isLoading) return <p>Loading…</p>
  if (!auth.isAuthenticated) return <button onClick={() => void auth.signinRedirect()}>Sign in with Keycloak</button>

  return (
    <main>
      <h1>Media pipeline</h1>
      <p>
        Signed in as {auth.user?.profile.preferred_username}{' '}
        <button onClick={() => void auth.signoutRedirect()}>Sign out</button>
      </p>
      <input type="file" accept="video/*" disabled={progress !== null}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f) }} />
      {progress !== null && <progress max={100} value={progress} aria-label="Upload progress" />}
      <table>
        <thead><tr><th>File</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
        <tbody>
          {Object.values(jobs).map((j) => (
            <tr key={j.id}><td>{j.fileName ?? j.id}</td><td>{j.status}</td><td>{j.attempts}</td><td>{j.lastError ?? ''}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
```

```bash
npm run dev                         # http://localhost:5173 → sign in as alice / alice-dev-pw
```

Upload `sample-flaky.mp4` in the browser. Without refreshing, the row should go `queued →
processing → retrying → processing → ready` (attempts 2). Then prove M5:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5080/api/media                    # 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST "http://localhost:5080/hubs/media/negotiate?negotiateVersion=1"  # 401
```

:::warn title="Production CORS for direct uploads"
The Vite proxy is a dev convenience. In production the browser `PUT`s cross-origin to your
storage host, so the bucket needs CORS allowing `PUT` from your app's origin **and**
`ExposeHeaders: ETag`, or `res.headers.get('ETag')` returns `null` and every upload fails at
"complete". SeaweedFS CORS support (a gateway flag vs per-bucket `PutBucketCors`) has changed
across versions, so check the SeaweedFS S3 docs for yours. Another option: let the API call
`ListParts` at completion and not trust client ETags at all.
:::

### 7. One trace and a dashboard (M6)

Open Grafana at `http://localhost:3000` (`admin`/`admin` if it asks). **Explore → Tempo → Search**,
service `media-api`, then open a `POST /api/media/uploads/{id}/complete` trace. You should see one tree:

```text
POST /api/media/uploads/{id}/complete         media-api
├─ POST, HEAD … localhost:8333 (S3 complete, object size check)
└─ media.enqueue  (Producer)                  media-api
   ├─ UPDATE media_uploads … (Npgsql)
   ├─ EVAL / EVALSHA (Redis enqueue)
   └─ media.process  (Consumer)               media-worker   ← same trace id, parent = trace_parent
      ├─ media.transcode.fake
      │  ├─ HEAD …/uploads/{id}/source
      │  └─ PUT  …/outputs/{id}/result.json
      ├─ UPDATE media_uploads … (complete, fenced)
      └─ EVAL / EVALSHA (Redis ack)
```

`media.process` sits **under** `media.enqueue` because the API stored the `traceparent` of the
`media.enqueue` span (`Activity.Current?.Id` at that moment). The worker's *claim* steps (the
Redis claim script and the `UPDATE … attempts + 1`) appear as small separate root traces in
`media-worker`. That's expected: the worker only learns the parent context by reading the row,
so the claim happens before it can join the trace. Expect a visible gap between the two halves.
That gap is the time the job spent waiting in the queue.

Build a dashboard *Media pipeline* with three panels (Prometheus data source), then **export the
JSON and commit it** next to your code:

| Panel | PromQL | Viz |
|---|---|---|
| Queue depth | `max by (queue) (media_queue_depth)` | time series, stacked off |
| Job latency p95 | `histogram_quantile(0.95, sum by (le) (rate(media_job_latency_seconds_bucket{outcome="ready"}[5m])))` | time series, unit seconds |
| Error rate | `sum(rate(media_jobs_processed_total{outcome=~"retry\|dead"}[5m])) / sum(rate(media_jobs_processed_total{outcome=~"success\|retry\|dead"}[5m]))` | stat, unit percent (0–1) |

`max by (queue)` and not `sum`: every API replica reports the same Redis lengths, so summing
would multiply them.

:::warn title="Metric names after OTLP → Prometheus"
OTel names `media.job.latency` (unit `s`) and `media.jobs.processed` usually become
`media_job_latency_seconds_bucket` and `media_jobs_processed_total`. Dots become underscores, units
and `_total` are appended, and `{job}`-style units are dropped. The exact translation depends on
the Prometheus/Collector version and its OTLP translation settings in the otel-lgtm image. Open
**Explore → Metrics** and search for `media` before you trust the queries above. Set
`OTEL_METRIC_EXPORT_INTERVAL=10000` (ms) on both apps if panels update too slowly.
:::

- [ ] `docker compose ps` shows Postgres, Redis, SeaweedFS, Keycloak and otel-lgtm running, and the `media` realm's issuer resolves
- [ ] `scripts/smoke.sh sample.mp4` returns `queued`, the row ends `ready` with 1 attempt, and `scripts/depth.sh` returns to all zeros
- [ ] `sample-flaky` ends `ready` on attempt 2, `sample-broken` ends `dead` after 3 attempts with its error in `last_error` and its id in `{media}:dlq`
- [ ] `sample-poison` crashed the worker repeatedly and ended `dead` with `max attempts exceeded` while the worker kept running afterwards
- [ ] In the browser (signed in as alice) a flaky upload's row changes status live without a refresh
- [ ] The API returns 401 for `/api/media` and the hub negotiate without a token
- [ ] Tempo shows `complete → media.enqueue → media.process` as ONE trace across `media-api` and `media-worker`
- [ ] My Grafana dashboard shows queue depth, p95 job latency and error rate, and its JSON is committed
:::

:::lab id=cl-09-lab2 xp=200
title: KEDA in kind and the chaos drills (M7)
Now the worker moves into Kubernetes and scales on the queue. Compose (Postgres, Redis, SeaweedFS,
Keycloak, otel-lgtm) and the API keep running on your host. **Stop the local worker** (`Ctrl+C`)
so only pods process jobs.

### 1. Cluster, KEDA, image

Use the kind cluster from ops-09 (named `devquest`), or create one with `kind create cluster --name devquest`.

```bash
helm repo add kedacore https://kedacore.github.io/charts && helm repo update
helm install keda kedacore/keda --namespace keda --create-namespace --version 2.21.0   # newest in Nov 2026; pin the newest
kubectl -n keda rollout status deploy/keda-operator

printf '**/bin\n**/obj\nweb/node_modules\n' > .dockerignore
```

`src/Media.Worker/Dockerfile`:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/Media.Shared/ Media.Shared/
COPY src/Media.Worker/ Media.Worker/
RUN dotnet publish Media.Worker/Media.Worker.csproj -c Release -o /app

# aspnet, not runtime: the worker uses the ASP.NET Core shared framework (SignalR backplane)
FROM mcr.microsoft.com/dotnet/aspnet:10.0
# Optional real transcoding: uncomment and set Worker__UseFfmpeg=true
# RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
USER $APP_UID
ENTRYPOINT ["dotnet", "Media.Worker.dll"]
```

```bash
docker build -f src/Media.Worker/Dockerfile -t media-worker:dev .
kind load docker-image media-worker:dev --name devquest

# Pods reach your host's published ports through the kind network's gateway (Linux).
HOST_IP=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9.]+$' | head -1)
echo "$HOST_IP"                     # e.g. 172.18.0.1
```

:::warn title="Reaching the host from kind"
On Linux the gateway IP works as long as your firewall (ufw/firewalld) allows traffic from the
`kind` bridge to the published ports. On Docker Desktop (macOS/Windows), use
`host.docker.internal` instead of `$HOST_IP`. Test with
`kubectl run nc --rm -it --image=busybox:1.37 --restart=Never -- nc -zv $HOST_IP 6379`.
:::

### 2. Manifests

`k8s/worker.yaml` (the `HOST_IP` placeholders are replaced at apply time):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: media
---
apiVersion: v1
kind: Secret
metadata:
  name: worker-env
  namespace: media
stringData:
  ConnectionStrings__Postgres: "Host=HOST_IP;Port=5432;Database=media;Username=media;Password=media-dev-pw"
  ConnectionStrings__Redis: "HOST_IP:6379,abortConnect=false"
  Storage__ServiceUrl: "http://HOST_IP:8333"
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://HOST_IP:4317"
  OTEL_METRIC_EXPORT_INTERVAL: "10000"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: media
  labels: { app.kubernetes.io/name: worker }
spec:
  # no "replicas": KEDA (and the HPA it creates) own that field
  selector:
    matchLabels: { app.kubernetes.io/name: worker }
  template:
    metadata:
      labels: { app.kubernetes.io/name: worker }
    spec:
      terminationGracePeriodSeconds: 40       # > HostOptions.ShutdownTimeout (25 s): release has time to finish
      containers:
        - name: worker
          image: media-worker:dev
          imagePullPolicy: IfNotPresent
          envFrom:
            - secretRef: { name: worker-env }
          env:
            - name: POD_NAME
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            - name: OTEL_RESOURCE_ATTRIBUTES  # after POD_NAME: $(VAR) only sees earlier entries
              value: "k8s.pod.name=$(POD_NAME)"
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { memory: 256Mi }
```

:::info title="Why a ScaledObject here, when the KEDA lesson says ScaledJob for long jobs"
**KEDA: Autoscale Workers on Queue Depth** recommends a `ScaledJob` for long jobs that must never
be interrupted, and real transcodes are exactly that. The boss uses a `ScaledObject` on purpose:
the simulated jobs take seconds, so they fit inside the grace period, and a Deployment lets you
practise the harder part, **releasing a job on SIGTERM**, plus the in-flight trigger on
`{media}:processing`. Both make the worker correct under any scale-down. Phase 5 shows where this
stops working (four-minute ffmpeg jobs), and *Beyond the boss* names the switch to a `ScaledJob`.
On a real video product, start there.
:::

`k8s/scaledobject.yaml`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
  namespace: media
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 0
  maxReplicaCount: 6
  pollingInterval: 5          # seconds between LLEN checks
  cooldownPeriod: 60          # idle this long → 1 → 0
  triggers:
    - type: redis             # waiting work: 3 jobs per replica
      metadata:
        address: "HOST_IP:6379"
        listName: "{media}:jobs"
        listLength: "3"
        activationListLength: "0"
    - type: redis             # running work: never fewer replicas than in-flight jobs
      metadata:
        address: "HOST_IP:6379"
        listName: "{media}:processing"
        listLength: "1"
        activationListLength: "0"
```

The HPA takes the **maximum** over triggers. Busy pods count as load, so finishing the waiting
list doesn't immediately scale away the pods still working on jobs.

```bash
for f in k8s/worker.yaml k8s/scaledobject.yaml; do sed "s/HOST_IP/$HOST_IP/g" "$f" | kubectl apply -f -; done
kubectl -n media get scaledobject worker          # READY True, ACTIVE False
kubectl -n media get deploy worker                # 0/0 (may show 1/1 for a few seconds until KEDA's first poll)
```

:::warn title="KEDA redis scaler keys"
`address`, `listName`, `listLength` and `activationListLength` match the KEDA 2.x *Redis Lists*
scaler docs (keda.sh → Scalers → Redis Lists). If `kubectl describe scaledobject` reports an
unknown or missing parameter, the docs for your KEDA version are authoritative.
Remember that the scaler runs **in the KEDA operator pod**, so the address must resolve from
namespace `keda`, not from your worker's namespace.
:::

:::pro title="Production Redis has a password: TriggerAuthentication"
The lab's Redis has no password. A real one does, and the password must not sit in the
ScaledObject in plain text. KEDA reads it from a Secret through a `TriggerAuthentication` in the
same namespace, and each trigger points at it with `authenticationRef`:

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: media
spec:
  secretTargetRef:
    - parameter: password        # the redis scaler's auth parameter
      name: redis-secret         # a Secret in namespace media
      key: password
---
# in each trigger of the ScaledObject:
#   - type: redis
#     authenticationRef: { name: redis-auth }
#     metadata: { address: "redis.media.svc:6379", listName: "{media}:jobs", listLength: "3" }
```

Managed Redis usually also needs TLS (`enableTLS: "true"` in the trigger metadata). Check the
scaler page for your KEDA version for the exact parameter names.
:::

### 3. Burst: 0 → N → 0

Terminal A: `kubectl -n media get pods -w`. Terminal B: `watch -n1 scripts/depth.sh`. Terminal C:

```bash
for i in $(seq 1 24); do scripts/smoke.sh sample.mp4 > /dev/null & done; wait; echo "24 enqueued"
kubectl -n media get hpa                          # keda-hpa-worker … TARGETS e.g. 7/3 (avg), REPLICAS 6
```

Expected: within ~10 s pods appear (`0 → 1` by KEDA activation, then `1 → 6` by the HPA). Waiting
drains, processing stays ≤ 6, and about 60–90 s after the last job all pods terminate. In
Grafana, queue depth spikes and falls, and p95 latency rises during the burst. That's the cost of
`maxReplicaCount: 6`, and it's a business decision.

### 4. Chaos drills

Start a burst again for the first two drills, and follow the busy pod's log in another terminal
(`kubectl -n media logs -f <busy-worker>`) so you still see its last lines after it's deleted.

| Drill | Do | Expect |
|---|---|---|
| Graceful scale-down | during a burst: `kubectl -n media delete pod <busy-worker>` | log `Released <id> on shutdown`; the job is back at the front of `{media}:jobs` immediately, attempts unchanged |
| Hard kill | SIGKILL the container from its kind node (commands below the table) | no `Released` line; the container restarts (`RESTARTS` + 1); ~30 s later a maintenance loop (the API's, or a surviving pod's) logs `Reaped 1 job(s)`; the next claim is attempt + 1 |
| Poison in the cluster | `scripts/smoke.sh sample-poison.mp4` | pod restarts (`Error`, `CrashLoopBackOff`), the job ends `dead` on its 4th claim and the pod recovers |
| Redis amnesia | `docker compose exec redis redis-cli FLUSHALL` while jobs are queued | in-flight workers log `Lost the lease …` (their lease keys are gone). Within 1–2 min (janitor every 60 s, rows idle ≥ 1 min) a maintenance loop (the API's, or a surviving pod's) logs `Re-enqueued … Redis didn't`, and every job finishes (the abandoned ones with attempts + 1) |
| Expired URLs | restart the API with `Storage__PresignSeconds=20`, upload a ~200 MB file in the browser with DevTools → Network → *Slow 4G* | later parts get `403`, the client re-presigns them, the upload completes |
| Retry while at zero | see the steps below the table | a delayed retry is promoted while **no** worker pod exists, then runs when KEDA resumes |

**Hard kill.** `kubectl delete pod --grace-period=0 --force` is *not* a SIGKILL: it removes the
Pod object from the API at once, but the kubelet still stops the container with SIGTERM and a
minimum 2 s grace, and the worker's release path finishes in milliseconds. So that command usually
just *releases* the job (attempts unchanged). For a real crash, kill the process from the node
that runs it. kind nodes are Docker containers named after the node:

```bash
POD=<busy-worker>
NODE=$(kubectl -n media get pod "$POD" -o jsonpath='{.spec.nodeName}')   # e.g. devquest-control-plane
CID=$(docker exec "$NODE" crictl ps --name worker -q | head -1)
docker exec "$NODE" crictl stop --timeout 0 "$CID"                       # SIGKILL, no SIGTERM first
kubectl -n media get pod "$POD"                                         # RESTARTS went up by 1
```

No `finally` runs, so the lease simply expires and the reaper does the recovery. (The poison drill
below is the other true hard-crash case: `Environment.FailFast` skips every `catch` and `finally`.)

:::info title="If the expired-URL drill passes without a 403"
S3 checks expiry when a request *starts*. Make sure some parts begin after the 20 s window (more
parts, slower throttling). If your SeaweedFS version doesn't enforce `X-Amz-Expires`, the client
logic is still exactly what AWS S3 and R2 need, and you have learned something about your
storage gateway.
:::

**Retry while at zero.** A plain flaky upload doesn't prove this one: during KEDA's 60 s cooldown
the pod is still alive, and its own `MaintenanceService` promotes the retry. So pause KEDA at zero
replicas and put a job into `{media}:delayed` by hand, exactly as `RetryLua` would:

```bash
kubectl -n media annotate scaledobject worker autoscaling.keda.sh/paused-replicas="0" --overwrite
kubectl -n media get pods                            # wait until no worker pods are left
ID=$(scripts/smoke.sh sample-flaky.mp4 | jq -r .id)  # row "queued", nobody can claim it
docker compose exec -T redis redis-cli eval \
  "redis.call('LREM', KEYS[1], 0, ARGV[1]); local t = redis.call('TIME'); return redis.call('ZADD', KEYS[2], tonumber(t[1]) * 1000 + 20000, ARGV[1])" \
  2 '{media}:jobs' '{media}:delayed' "$ID"           # due in 20 s on the Redis clock
scripts/depth.sh                                     # waiting=0 processing=0 delayed=1 dead=0
sleep 30; scripts/depth.sh                           # waiting=1 processing=0 delayed=0 dead=0
kubectl -n media annotate scaledobject worker autoscaling.keda.sh/paused-replicas-
```

The second `depth.sh` is the proof: the job moved from the ZSET to the list while zero workers
existed, so only the API's maintenance can have done it. Removing the annotation resumes KEDA,
which sees `waiting=1` and wakes a pod. Attempt 1 fails (flaky), attempt 2 ends `ready`.

- [ ] KEDA is installed, and the ScaledObject is `READY True` with the worker Deployment at 0 replicas when idle
- [ ] A burst of 24 uploads scaled the worker 0 → 6 and back to 0, with every row ending `ready`
- [ ] Deleting a busy pod released its job immediately (log line + unchanged attempts); a SIGKILL from the node (`crictl stop --timeout 0`) was recovered by the reaper with attempt + 1
- [ ] The poison job crash-looped a pod and ended in the DLQ without blocking other jobs
- [ ] After `FLUSHALL`, the janitor rebuilt the queue from Postgres and no job was lost
- [ ] I observed (or explained) the 403 → re-presign → resume path for expired part URLs
- [ ] With KEDA paused at 0 replicas, a delayed job was promoted to the waiting list (maintenance lives in the API), and it ran once KEDA resumed
:::

:::pro title="Beyond the boss"
* **Long jobs** (10+ minutes of ffmpeg): consider a KEDA `ScaledJob` (one Kubernetes Job per
  message) so scale-down never kills a running transcode, or annotate busy pods with
  `controller.kubernetes.io/pod-deletion-cost` so the HPA removes idle ones first.
* **Span links instead of parents** when one trace would get huge (batch jobs, fan-out). Each job
  gets its own trace with a *link* back to the request that caused it.
* **Resumable uploads across page reloads**: persist `{ id, partSize, done[] }` in IndexedDB and
  resume with `ListParts`. The tus protocol standardises this if you don't want to build it.
* **Abandoned multipart uploads** cost storage forever: add a lifecycle rule
  (`AbortIncompleteMultipartUpload` on AWS) or a scheduled job that lists and aborts stale ones.
* **Virus/format scanning** before `queued`: add an `uploaded → scanned` stage. The state machine
  makes the extra step a one-line change.
* **One command for the whole stack, and tests against real infrastructure.** In a 2026 .NET
  team you'd describe this compose file as a **.NET Aspire AppHost** (`AddPostgres`, `AddRedis`,
  `AddKeycloak`, a container resource for SeaweedFS, `WithReference(...)` to wire connection
  strings), which also gives you a local OTLP dashboard. Integration tests then start the same
  containers with **Testcontainers** (or Aspire's testing host): enqueue → claim → ack against a
  real Redis, a presigned PUT against a real SeaweedFS, a JWT issued by a real Keycloak realm.
  Mocks would have hidden every incident in the phases below.
* **Managed services instead of containers.** Every box in the architecture has a managed
  counterpart (Azure Managed Redis / ElastiCache, Blob Storage / S3, Entra ID / Cognito, Azure
  Monitor / CloudWatch, KEDA on AKS or Container Apps). The invariants and failure phases don't
  change; auth (workload identity instead of keys) and networking do. See **The Managed Equivalents: Azure & AWS**.
:::

## Boss phases

Each phase is an incident in a system shaped exactly like yours. Read the evidence, find the
broken rule.

:::quiz id=cl-09-q1 xp=20
**Phase 1 — The poison video.** A customer uploads a corrupt 4K file. Every worker that picks it
up spikes memory and is `OOMKilled` (exit 137). In your first draft, `attempts` is incremented in
the `catch` block before scheduling a retry. What happens?
- [ ] The catch block increments attempts, so after 3 crashes the job goes to the DLQ
- [x] The catch block never runs. The lease expires, the reaper requeues the job, and it crash-loops every worker forever. Count the attempt at **claim** time and dead-letter when a claim exceeds the max
- [ ] Kubernetes stops restarting the pod after 3 OOMKills, so the job stops on its own
- [ ] Raise the lease to 10 minutes so the job is never redelivered
> An OOMKill is a SIGKILL: no `catch`, no `finally`, no shutdown hook. Anything you only do "on
> failure" never happens for the worst failures, which is why the tempting first answer is wrong.
> Counting in the same `UPDATE` that sets `processing` makes every *start* count, so the
> (max+1)-th claim lands in the DLQ. CrashLoopBackOff only slows restarts and never gives up. A
> longer lease just makes the loop slower. (In .NET the managed heap respects the container limit
> and throws `OutOfMemoryException` first. Real OOMKills usually come from native memory, such as an
> `ffmpeg` child process in the same container.)
:::

:::quiz id=cl-09-q2 xp=20
**Phase 2 — Redis amnesia.** Redis ran without persistence and restarted during a node upgrade.
140 rows are `queued` in Postgres, `{media}:jobs` is empty, KEDA keeps workers at 0, and users stare
at spinners. Which design recovers with no human involved?
- [ ] SignalR's automatic reconnect re-sends the jobs
- [ ] KEDA notices the rows in Postgres and scales up
- [x] Postgres is the truth: a janitor periodically re-enqueues `queued/retrying/processing` rows that Redis doesn't know (`{media}:known`); duplicates are harmless because claims are idempotent. Also enable AOF so it's rare
- [ ] Make the API write to Redis first and Postgres second
> Treat the queue as a *delivery mechanism* you can rebuild, not as the record. Reconnect restores
> a WebSocket, not data. KEDA watches the Redis list, which is empty, so it correctly sees nothing
> to do. Flipping the write order only moves the dual-write gap: a job id in Redis whose row still says
> `uploading` is worse: `TryStartAsync` finds nothing runnable, the worker acks it as a duplicate,
> and the job is silently lost. And no write order helps when Redis itself forgets everything. The re-enqueue sweep is a small outbox. *Message Brokers & the Outbox Pattern* shows
> the full pattern.
:::

:::quiz id=cl-09-q3 xp=20
**Phase 3 — Two workers, one job.** Worker A stalls in a 40 s pause (lease 30 s). The reaper
requeues its job, worker B claims it as attempt 2, and then A wakes up and carries on. Which
properties of the lab's design protect you here? (select all that apply)
- [x] The output key is deterministic (`outputs/{id}/…`), so a second write overwrites instead of creating a duplicate
- [x] The final `UPDATE … WHERE status = 'processing' AND attempts = @mine` fences A out: its attempt is stale, 0 rows change, and A discards its result
- [x] A's next heartbeat fails (`GET lease ≠ A`), so A cancels its own work as soon as it notices
- [ ] Lua scripts give Redis exactly-once delivery
- [ ] A 5-minute lease makes duplicates impossible
> Leases give you *at-least-once*. Correctness comes from idempotent side effects plus a fencing
> token, and here the attempt number is the token: even if A finishes before it notices anything,
> its output lands on the same key and its final `UPDATE` changes 0 rows. The failed heartbeat is
> damage limitation on top: A stops wasting CPU as soon as it notices. Lua makes each *step*
> atomic, not the whole job exactly-once. A longer lease only makes duplicates rarer and crash
> recovery slower, and a long enough pause (GC, VM migration, network partition) beats any lease.
:::

:::quiz id=cl-09-q4 xp=20
**Phase 4 — Part 37 of 120.** A user uploads 1 GB on hotel Wi-Fi. Parts 1–36 succeed, then every
`PUT` returns `403 AccessDenied: Request has expired`. All URLs were presigned for 15 minutes at
the start. Best fix?
- [ ] Presign for 7 days so it never happens
- [ ] Restart the upload from part 1 with new URLs
- [x] Ask the API for fresh URLs for the remaining part numbers on the **same UploadId** and continue; uploaded parts stay in the multipart upload until complete or abort
- [ ] Give the browser the S3 secret so it can sign its own requests
> A multipart upload is resumable by design. The UploadId lives on the server, and URLs are just
> short-lived permissions per part. Expiry is checked when a request *starts*, so the parts queued
> behind slow ones are the ones that fail. Week-long URLs are a leaked-link liability (and SigV4
> caps them at 7 days). Restarting throws away 36 good parts. A secret in the browser is a secret
> for everyone. Also clean up abandoned uploads (lifecycle `AbortIncompleteMultipartUpload`, or a
> scheduled abort job).
:::

:::quiz id=cl-09-q5 xp=20
**Phase 5 — Scale-down mid-job.** Real ffmpeg jobs take about 4 minutes. The ScaledObject watches
only `{media}:jobs`. Once the backlog is claimed the list is empty, and after the cooldown KEDA
scales 5 → 0 while 5 jobs are running. Pods get SIGTERM, 30 s of grace, then SIGKILL. What do you
change? (select all)
- [x] Also scale on `{media}:processing` (1 per replica) so in-flight work counts as load
- [x] On SIGTERM stop claiming and **release** the job back to the front of the queue (attempt refunded) instead of waiting for its lease to expire
- [x] For jobs far longer than any sane grace period, use a KEDA `ScaledJob` (one Kubernetes Job per message)
- [ ] Set `cooldownPeriod: 0` so KEDA reacts faster
- [ ] Nothing: the lease requeues the jobs, so it already works
> Queue length measures *waiting* work, not *running* work. Counting in-flight jobs keeps busy
> pods alive. Graceful release makes unavoidable kills cheap (no lease wait, no burned attempt).
> ScaledJob avoids killing long jobs at all. A shorter cooldown makes things worse. "The lease
> requeues it" is true but expensive: four minutes of work redone per kill, and with enough kills a
> healthy video ends up in the DLQ.
:::

:::quiz id=cl-09-q6 xp=20
**Phase 6 — Echo, echo, echo.** With 3 API replicas, users see every status update **3 times**.
The worker publishes to a Redis channel `media:status`. Each API replica subscribes and calls
`hub.Clients.User(sub).JobUpdated(…)`, and the hub uses the Redis backplane. Why?
- [ ] The browser opened 3 connections; disable automatic reconnect
- [x] Each replica's `Clients.User(…)` is already fanned out to every replica by the backplane, so 3 relays × backplane = 3 deliveries. Publish once: let the worker send through `IHubContext` on the same backplane (same hub type and channel prefix), or relay from exactly one place
- [ ] The backplane is broken; enable sticky sessions instead
- [ ] SignalR is at-least-once and always delivers duplicates
> The backplane's whole job is "send from anywhere, deliver to whoever holds the connection".
> Adding your own relay on every node repeats that fan-out N times. Reconnects can't explain it
> either: one connection receives each send once. Sticky sessions matter for the negotiate →
> connect handshake (unless every client uses WebSockets only with `skipNegotiation`), but they
> don't change how many times a server-side send is delivered.
:::

:::quiz id=cl-09-q7 xp=20
**Phase 7 — REST works, the hub says 401.** After wiring Keycloak, `GET /api/media` works with
the bearer token, but the browser console shows
`WebSocket connection to 'ws://localhost:5173/hubs/media?id=…&access_token=eyJ…' failed`, and the
API logs a 401 for that request. Why?
- [ ] Keycloak tokens can't be used for WebSockets
- [x] Browsers can't set an `Authorization` header on WebSockets, so SignalR sends `access_token` in the query string, and JwtBearer ignores it unless `OnMessageReceived` copies it into `ctx.Token` for the hub path
- [ ] CORS blocks WebSockets
- [ ] Mark the hub `[AllowAnonymous]` and validate tokens by hand inside it
> The URL shows the token is there, so the server just isn't reading it. A CORS problem looks
> like a browser CORS error, not a 401 from your API (and with the Vite proxy it's same-origin
> anyway). Scope the query-string read to `/hubs/…`, and scrub `access_token` from access logs,
> because URLs get logged.
:::

:::quiz id=cl-09-q8 xp=20
**Phase 8 — The flattest p95 in history.** Jobs take 1–3 s. The panel
`histogram_quantile(0.95, sum by (le) (rate(media_job_latency_seconds_bucket[5m])))` shows
**4.75 s**, whatever happens. You record seconds into a `Histogram<double>` with the SDK's default
buckets. Why?
- [ ] Prometheus rounds quantiles to the nearest bucket edge
- [x] The default boundaries (0, 5, 10, 25 … 10 000) are meant for milliseconds, so every sample falls into (0, 5] and `histogram_quantile` interpolates 95 % of the way through it: 0 + 0.95 × 5 = 4.75. Configure second-scale boundaries with a View
- [ ] The worker's clock is skewed
- [ ] p95 needs `max by (le)` instead of `sum by (le)`
> A quantile from a histogram is a linear interpolation *inside one bucket*, so precision is
> whatever the buckets give you. A constant 4.75 is the fingerprint of "all samples in the first
> bucket". Prometheus doesn't round to edges, it interpolates, which is exactly why you get the
> odd 4.75 rather than 5. The lab's `AddView("media.job.latency", …)` sets 0.5 s to 600 s boundaries
> (on .NET 9+ you can also pass `InstrumentAdvice` when creating the histogram).
:::

:::quiz id=cl-09-q9 xp=20
**Phase 9 — The retry that never came.** At 02:00 three jobs fail and are scheduled in
`{media}:delayed`. The waiting list is empty, so KEDA scales workers to 0. At 09:00 they are still
`retrying`. In this version, only the worker ran the promote/reap loop. What happened?
- [x] Nothing running moved due items from the ZSET to the waiting list. The promoter scaled to zero with the workers, and KEDA only watches the list. Run maintenance in an always-on component (the lab runs it in the API too, and its atomic Lua makes N copies safe)
- [ ] Sorted-set members expire at midnight
- [ ] KEDA can't count sorted sets, so add a CronJob that restarts KEDA every hour
- [ ] The backoff was too long
> Scale-to-zero removes *everything* in the pod, including housekeeping you forgot was there.
> Backoff was seconds, not hours, and restarting KEDA changes nothing because the list really is
> empty. It's the same reason the queue-depth gauge lives in the API: schedulers and measurements
> must run somewhere that's always up.
:::

:::quiz id=cl-09-q10 xp=20
**Phase 10 — Two halves of a trace.** In Tempo the API trace ends at `media.enqueue`, and the
worker's spans appear as separate root traces. Both services export to the same collector, and
sampling is 100 %. Most likely cause?
- [ ] Tempo can't join spans from different services
- [x] Trace context doesn't travel through a Redis list by itself. Nothing carried `traceparent` from the API to the worker. Store it with the job (the lab uses `media_uploads.trace_parent`) and start the consumer span with it as parent or link
- [ ] The worker needs `AddAspNetCoreInstrumentation()`
- [ ] Sampling dropped the worker's parent span
> HTTP instrumentation propagates context in headers automatically. A list entry is just bytes.
> Brokers with message headers (RabbitMQ, Kafka) have instrumentation that injects context for
> you, but with a Redis list you do it yourself. ASP.NET instrumentation only covers incoming HTTP,
> and at 100 % sampling nothing was dropped. The spans were recorded, just under a new root.
:::

:::quiz id=cl-09-q11 xp=20
**Bonus phase — The two-step claim.** A teammate "simplifies" `ClaimLua` into two plain calls:

```csharp
var id = await db.ListMoveAsync(Waiting, Processing, ListSide.Right, ListSide.Left);
if (!id.IsNull) await db.StringSetAsync(LeasePrefix + id, workerId, lease, When.NotExists);
// …then processes the job
```

Under load, a few jobs now run on two workers at once, although no worker paused or crashed.
Why?
- [ ] `LMOVE` isn't atomic, so two workers can pop the same id
- [x] Between the two calls the id sits in `{media}:processing` with no lease. A maintenance pass that runs in that gap reads "no lease = dead worker", puts it back in the waiting list, and another worker claims it
- [ ] `When.NotExists` makes the `SET` fail every time, so no lease is ever written
- [ ] Redis reorders commands that arrive on different connections
> The reaper's rule is "in processing without a lease means its worker died". The two-step version
> briefly creates exactly that state for a healthy worker, so a reaper running in the gap hands the
> job to someone else (and the code ignores the `SET` result, so the worker whose `SET` lost doesn't notice until its
> first heartbeat finds someone else's lease, up to 10 s later; short jobs finish on both workers
> before that). `LMOVE`
> itself is atomic: one id goes to exactly one caller. `NX` only fails when a lease already exists.
> Redis executes commands one at a time, so it never reorders them in a way that breaks a single
> client. A Lua script closes the gap because nothing else runs between its move and its lease. The
> `attempts` fence still saves the final write, but you redo work and burn an attempt.
:::

## Final strikes

:::challenge id=cl-09-c1 lang=ts xp=80
title: The job state machine
Implement `backoffMs(attempt)` and `transition(job, event, now)` for the pipeline's state machine.
`now` is the current time in ms. Every real transition returns a **new** job object and never
mutates the input. A no-op (the duplicate cases below) may return the input as is. Anything not
allowed throws.

* `backoffMs(attempt)` = `1000 × 2^(attempt − 1)`, capped at `60 000`.
* `uploadCompleted`: `uploading → queued`. Already `queued` → return the job unchanged (double-click).
* `claimed`: allowed from `queued`, `retrying` and `processing` (lease expired → re-claim). A
  `retrying` job whose `nextRunAt` is in the future throws an error containing `not due`.
  Increments `attempts`; if the new count exceeds `maxAttempts` → `dead` with
  `lastError: 'max attempts exceeded'`, otherwise `processing` with `nextRunAt: null`.
* `succeeded`: `processing → ready` with `lastError: null`. Already `ready` → unchanged (duplicate delivery).
* `failed`: only from `processing`. If `attempts >= maxAttempts` → `dead` (`lastError` = the
  error, `nextRunAt: null`). Otherwise → `retrying` with `lastError` and
  `nextRunAt = now + backoffMs(attempts)`.
* `aborted`: `uploading → aborted`. Already `aborted` → unchanged.
* `redriven`: `dead → queued` with `attempts: 0`, `lastError: null`, `nextRunAt: null`.
* Anything else throws an error whose message contains `illegal`.

(The lab's worker uses `2^attempt` seconds with ±20 % jitter. Here the backoff is deterministic so
the tests can check exact times.)

hint: Start each case with the no-op check, then the legality check, then build `{ ...job, … }`.
hint: Crashes never send `failed`. The only thing that stops a crash loop is the attempt check inside `claimed`.
hint: `2 ** (attempt - 1)` and `Math.min(60_000, …)`.

```ts setup
type Status = 'uploading' | 'queued' | 'processing' | 'retrying' | 'ready' | 'dead' | 'aborted'
type Job = { id: string; status: Status; attempts: number; maxAttempts: number; nextRunAt: number | null; lastError: string | null }
type JobEvent =
  | { type: 'uploadCompleted' }
  | { type: 'claimed' }
  | { type: 'succeeded' }
  | { type: 'failed'; error: string }
  | { type: 'aborted' }
  | { type: 'redriven' }
```

```ts starter
export function backoffMs(attempt: number): number {
  return 1000
}

// Naive: trusts every event and mutates the job. Make it strict.
export function transition(job: Job, event: JobEvent, now: number): Job {
  const next: Record<JobEvent['type'], Status> = {
    uploadCompleted: 'queued', claimed: 'processing', succeeded: 'ready',
    failed: 'retrying', aborted: 'aborted', redriven: 'queued',
  }
  job.status = next[event.type]
  return job
}
```

```ts solution
export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** (attempt - 1))
}

export function transition(job: Job, event: JobEvent, now: number): Job {
  const illegal = (): never => {
    throw new Error(`illegal: ${job.status} --${event.type}-->`)
  }
  switch (event.type) {
    case 'uploadCompleted':
      if (job.status === 'queued') return job
      if (job.status !== 'uploading') return illegal()
      return { ...job, status: 'queued' }
    case 'claimed': {
      if (job.status !== 'queued' && job.status !== 'retrying' && job.status !== 'processing') return illegal()
      if (job.status === 'retrying' && job.nextRunAt !== null && now < job.nextRunAt) throw new Error('not due yet')
      const attempts = job.attempts + 1
      if (attempts > job.maxAttempts) return { ...job, attempts, status: 'dead', nextRunAt: null, lastError: 'max attempts exceeded' }
      return { ...job, attempts, status: 'processing', nextRunAt: null }
    }
    case 'succeeded':
      if (job.status === 'ready') return job
      if (job.status !== 'processing') return illegal()
      return { ...job, status: 'ready', lastError: null }
    case 'failed':
      if (job.status !== 'processing') return illegal()
      if (job.attempts >= job.maxAttempts) return { ...job, status: 'dead', lastError: event.error, nextRunAt: null }
      return { ...job, status: 'retrying', lastError: event.error, nextRunAt: now + backoffMs(job.attempts) }
    case 'aborted':
      if (job.status === 'aborted') return job
      if (job.status !== 'uploading') return illegal()
      return { ...job, status: 'aborted' }
    case 'redriven':
      if (job.status !== 'dead') return illegal()
      return { ...job, status: 'queued', attempts: 0, lastError: null, nextRunAt: null }
  }
  return illegal()
}
```

```ts tests
const mk = (over: Partial<Job> = {}): Job => ({ id: 'j1', status: 'uploading', attempts: 0, maxAttempts: 3, nextRunAt: null, lastError: null, ...over })

test('happy path: uploading → queued → processing → ready', () => {
  let j = transition(mk(), { type: 'uploadCompleted' }, 0)
  expect(j.status).toBe('queued')
  j = transition(j, { type: 'claimed' }, 0)
  expect(j).toMatchObject({ status: 'processing', attempts: 1, nextRunAt: null })
  j = transition(j, { type: 'succeeded' }, 0)
  expect(j).toMatchObject({ status: 'ready', lastError: null })
})
test('never mutates the input', () => {
  const j = mk()
  const copy = { ...j }
  transition(j, { type: 'uploadCompleted' }, 0)
  expect(j).toEqual(copy)
})
test('backoff doubles from 1 s and caps at 60 s', () => {
  expect(backoffMs(1)).toBe(1000)
  expect(backoffMs(3)).toBe(4000)
  expect(backoffMs(7)).toBe(60_000)
  expect(backoffMs(20)).toBe(60_000)
})
test('a failure schedules a retry that cannot be claimed early (fake clock)', () => {
  const r = transition(mk({ status: 'processing', attempts: 1 }), { type: 'failed', error: 'timeout' }, 10_000)
  expect(r).toMatchObject({ status: 'retrying', nextRunAt: 11_000, lastError: 'timeout' })
  expect(() => transition(r, { type: 'claimed' }, 10_999)).toThrow('not due')
  const again = transition(r, { type: 'claimed' }, 11_000)
  expect(again).toMatchObject({ status: 'processing', attempts: 2, nextRunAt: null })
  expect(transition(again, { type: 'failed', error: 'timeout' }, 20_000).nextRunAt).toBe(22_000)
})
test('failing the last attempt is terminal', () => {
  expect(transition(mk({ status: 'processing', attempts: 3 }), { type: 'failed', error: 'boom' }, 0))
    .toMatchObject({ status: 'dead', lastError: 'boom', nextRunAt: null })
})
test('a job that crashes every worker (only re-claims, never "failed") still ends dead', () => {
  let j = transition(mk({ status: 'queued' }), { type: 'claimed' }, 0)
  j = transition(j, { type: 'claimed' }, 0)
  j = transition(j, { type: 'claimed' }, 0)
  expect(j).toMatchObject({ status: 'processing', attempts: 3 })
  j = transition(j, { type: 'claimed' }, 0)
  expect(j).toMatchObject({ status: 'dead', attempts: 4, lastError: 'max attempts exceeded' })
})
test('duplicate deliveries of an already-reached state are no-ops', () => {
  const ready = mk({ status: 'ready', attempts: 1 })
  expect(transition(ready, { type: 'succeeded' }, 0)).toEqual(ready)
  const queued = mk({ status: 'queued' })
  expect(transition(queued, { type: 'uploadCompleted' }, 0)).toEqual(queued)
  const aborted = mk({ status: 'aborted' })
  expect(transition(aborted, { type: 'aborted' }, 0)).toEqual(aborted)
})
test('illegal transitions throw', () => {
  expect(() => transition(mk({ status: 'queued' }), { type: 'succeeded' }, 0)).toThrow('illegal')
  expect(() => transition(mk({ status: 'ready', attempts: 1 }), { type: 'claimed' }, 0)).toThrow('illegal')
  expect(() => transition(mk({ status: 'processing', attempts: 1 }), { type: 'uploadCompleted' }, 0)).toThrow('illegal')
  expect(() => transition(mk({ status: 'processing', attempts: 1 }), { type: 'aborted' }, 0)).toThrow('illegal')
  expect(() => transition(mk({ status: 'dead', attempts: 3 }), { type: 'failed', error: 'x' }, 0)).toThrow('illegal')
  expect(() => transition(mk({ status: 'ready', attempts: 1 }), { type: 'redriven' }, 0)).toThrow('illegal')
})
test('abort and redrive', () => {
  expect(transition(mk(), { type: 'aborted' }, 0).status).toBe('aborted')
  const dead = mk({ status: 'dead', attempts: 4, lastError: 'max attempts exceeded' })
  expect(transition(dead, { type: 'redriven' }, 0)).toMatchObject({ status: 'queued', attempts: 0, lastError: null, nextRunAt: null })
})
```
:::

:::challenge id=cl-09-c2 lang=ts xp=100
title: Leases, retries and a DLQ on a fake clock
Build the queue's semantics in memory, with time injected so tests can fast-forward. `new
LeaseQueue(clock, { leaseMs, maxAttempts, backoffMs })`, where `clock` is a function that returns
the current time in ms (the tests pass `fakeClock().now` from the setup and call `advance(ms)`).
Read the clock on every call, never cache it.

* `enqueue(id)` adds to the back of *waiting*. Returns `false` (and does nothing) if the id is
  already anywhere in the queue (waiting, in flight, delayed or dead). An id that was acked has left
  and may be enqueued again.
* `claim(workerId)` first runs **maintenance**: in-flight jobs whose lease has expired
  (`now >= expiresAt`) go back to the **front** of waiting (in claim order), then delayed jobs that
  are due (`now >= dueAt`) go to the **back** in due order. Then it takes from the front:
  `attempt` = previous attempts + 1. If that exceeds `maxAttempts` the id moves to *dead* and it
  tries the next one. Otherwise it returns `{ id, attempt, token }`, where `token` is a global counter
  starting at 1 that goes up by one per successful claim (it's the fencing token), and leases the
  job until `now + leaseMs`. Empty → `null`.
* `heartbeat(id, token)`: if the job is in flight with that token **and not yet expired**, extend
  the lease to `now + leaseMs` and return `true`. Otherwise `false`.
* `ack(id, token)`: if the job is in flight with that token, remove it from the queue (it's done)
  and return `true`. Otherwise `false`. A stale token is a zombie worker.
* `nack(id, token)`: if not the current owner → `false`. If `attempt >= maxAttempts` → move to dead,
  return `'dead'`. Otherwise delay it until `now + backoffMs(attempt)` and return `'retry'`.
* `depth()` runs maintenance and returns `{ waiting, inFlight, delayed, dead }`. `deadIds()` returns
  dead ids in the order they died.

hint: State: `waiting: string[]`, `inFlight: Map<id, { token, expiresAt, attempt }>`, `delayed: Map<id, dueAt>`, `attempts: Map<id, number>`, `dead: string[]`.
hint: Collect expired ids in Map order, then `unshift` them in **reverse** so they keep their order at the front.
hint: Attempts must survive a lease expiry (that's the crash case). Only `ack` forgets them.

```ts setup
type Claim = { id: string; attempt: number; token: number }
type Options = { leaseMs: number; maxAttempts: number; backoffMs: (attempt: number) => number }
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
```

```ts starter
export class LeaseQueue {
  private waiting: string[] = []
  private token = 0

  constructor(clock: () => number, opts: Options) {}

  enqueue(id: string): boolean {
    this.waiting.push(id)
    return true
  }
  claim(workerId: string): Claim | null {
    const id = this.waiting.shift()
    return id === undefined ? null : { id, attempt: 1, token: ++this.token }
  }
  heartbeat(id: string, token: number): boolean { return true }
  ack(id: string, token: number): boolean { return true }
  nack(id: string, token: number): 'retry' | 'dead' | false { return 'retry' }
  depth() { return { waiting: this.waiting.length, inFlight: 0, delayed: 0, dead: 0 } }
  deadIds(): string[] { return [] }
}
```

```ts solution
export class LeaseQueue {
  private clock: () => number
  private opts: Options
  private waiting: string[] = []
  private inFlight = new Map<string, { token: number; expiresAt: number; attempt: number }>()
  private delayed = new Map<string, number>()
  private attempts = new Map<string, number>()
  private dead: string[] = []
  private lastToken = 0

  constructor(clock: () => number, opts: Options) {
    this.clock = clock
    this.opts = opts
  }

  enqueue(id: string): boolean {
    if (this.waiting.includes(id) || this.inFlight.has(id) || this.delayed.has(id) || this.dead.includes(id)) return false
    this.waiting.push(id)
    return true
  }

  private maintain() {
    const now = this.clock()
    const expired = [...this.inFlight].filter(([, l]) => now >= l.expiresAt).map(([id]) => id)
    for (const id of expired.reverse()) {
      this.inFlight.delete(id)
      this.waiting.unshift(id)
    }
    const due = [...this.delayed].filter(([, at]) => now >= at).sort((a, b) => a[1] - b[1])
    for (const [id] of due) {
      this.delayed.delete(id)
      this.waiting.push(id)
    }
  }

  claim(workerId: string): Claim | null {
    this.maintain()
    while (this.waiting.length > 0) {
      const id = this.waiting.shift()!
      const attempt = (this.attempts.get(id) ?? 0) + 1
      this.attempts.set(id, attempt)
      if (attempt > this.opts.maxAttempts) {
        this.dead.push(id)
        continue
      }
      const token = ++this.lastToken
      this.inFlight.set(id, { token, expiresAt: this.clock() + this.opts.leaseMs, attempt })
      return { id, attempt, token }
    }
    return null
  }

  heartbeat(id: string, token: number): boolean {
    const lease = this.inFlight.get(id)
    if (!lease || lease.token !== token || this.clock() >= lease.expiresAt) return false
    lease.expiresAt = this.clock() + this.opts.leaseMs
    return true
  }

  ack(id: string, token: number): boolean {
    const lease = this.inFlight.get(id)
    if (!lease || lease.token !== token) return false
    this.inFlight.delete(id)
    this.attempts.delete(id)
    return true
  }

  nack(id: string, token: number): 'retry' | 'dead' | false {
    const lease = this.inFlight.get(id)
    if (!lease || lease.token !== token) return false
    this.inFlight.delete(id)
    if (lease.attempt >= this.opts.maxAttempts) {
      this.dead.push(id)
      return 'dead'
    }
    this.delayed.set(id, this.clock() + this.opts.backoffMs(lease.attempt))
    return 'retry'
  }

  depth() {
    this.maintain()
    return { waiting: this.waiting.length, inFlight: this.inFlight.size, delayed: this.delayed.size, dead: this.dead.length }
  }

  deadIds(): string[] {
    return [...this.dead]
  }
}
```

```ts tests
const qopts: Options = { leaseMs: 1000, maxAttempts: 3, backoffMs: (a) => 500 * 2 ** (a - 1) }
function make() {
  const clock = fakeClock()
  return { clock, q: new LeaseQueue(clock.now, qopts) }
}

test('FIFO claims with growing fencing tokens', () => {
  const { q } = make()
  q.enqueue('a'); q.enqueue('b')
  expect(q.claim('w1')).toEqual({ id: 'a', attempt: 1, token: 1 })
  expect(q.claim('w2')).toEqual({ id: 'b', attempt: 1, token: 2 })
  expect(q.claim('w3')).toBeNull()
})
test('duplicate enqueue is ignored while the job is in the system', () => {
  const { q } = make()
  expect(q.enqueue('a')).toBe(true)
  expect(q.enqueue('a')).toBe(false)
  const c = q.claim('w1')!
  expect(q.enqueue('a')).toBe(false)
  expect(q.ack('a', c.token)).toBe(true)
  expect(q.enqueue('a')).toBe(true)
})
test('expired lease → redelivered first, the zombie cannot ack', () => {
  const { q, clock } = make()
  q.enqueue('a'); q.enqueue('b')
  const first = q.claim('w1')!
  clock.advance(1000)
  const second = q.claim('w2')!
  expect(second).toMatchObject({ id: 'a', attempt: 2 })
  expect(second.token).not.toBe(first.token)
  expect(q.ack('a', first.token)).toBe(false)
  expect(q.ack('a', second.token)).toBe(true)
  expect(q.claim('w1')).toMatchObject({ id: 'b', attempt: 1 })
})
test('heartbeats keep a lease alive; an expired lease cannot be revived', () => {
  const { q, clock } = make()
  q.enqueue('a')
  const c = q.claim('w1')!
  clock.advance(900)
  expect(q.heartbeat('a', c.token)).toBe(true)
  clock.advance(900)
  expect(q.claim('w2')).toBeNull()
  clock.advance(100)
  expect(q.heartbeat('a', c.token)).toBe(false)
  expect(q.claim('w2')).toMatchObject({ id: 'a', attempt: 2 })
})
test('nack backs off exponentially, then dead-letters', () => {
  const { q, clock } = make()
  q.enqueue('a')
  let c = q.claim('w1')!
  expect(q.nack('a', c.token)).toBe('retry')
  expect(q.claim('w1')).toBeNull()
  expect(q.depth()).toEqual({ waiting: 0, inFlight: 0, delayed: 1, dead: 0 })
  clock.advance(499)
  expect(q.claim('w1')).toBeNull()
  clock.advance(1)
  c = q.claim('w1')!
  expect(c.attempt).toBe(2)
  expect(q.nack('a', c.token)).toBe('retry')
  clock.advance(999)
  expect(q.claim('w1')).toBeNull()
  clock.advance(1)
  c = q.claim('w1')!
  expect(c.attempt).toBe(3)
  expect(q.nack('a', c.token)).toBe('dead')
  expect(q.deadIds()).toEqual(['a'])
  expect(q.nack('a', c.token)).toBe(false)
})
test('a poison job that crashes every worker ends in the DLQ and does not block others', () => {
  const { q, clock } = make()
  q.enqueue('poison'); q.enqueue('ok')
  expect(q.claim('w1')).toMatchObject({ id: 'poison', attempt: 1 })
  clock.advance(1000)
  expect(q.claim('w2')).toMatchObject({ id: 'poison', attempt: 2 })
  clock.advance(1000)
  expect(q.claim('w3')).toMatchObject({ id: 'poison', attempt: 3 })
  clock.advance(1000)
  expect(q.claim('w4')).toMatchObject({ id: 'ok', attempt: 1 })
  expect(q.deadIds()).toEqual(['poison'])
  expect(q.depth()).toEqual({ waiting: 0, inFlight: 1, delayed: 0, dead: 1 })
})
test('depth sees every structure', () => {
  const { q } = make()
  q.enqueue('a'); q.enqueue('b'); q.enqueue('c')
  const a = q.claim('w1')!
  q.nack('a', a.token)
  q.claim('w2')
  expect(q.depth()).toEqual({ waiting: 1, inFlight: 1, delayed: 1, dead: 0 })
})
```
:::

:::challenge id=cl-09-c3 lang=ts xp=70
title: A multipart uploader that survives expired URLs
Write `uploadAllParts(partCount, deps, opts)`, the browser half of Phase 4. All I/O is injected.

1. Call `deps.presign([1 … partCount])` **once** to get the initial URLs.
2. Upload with at most `opts.concurrency` `deps.put(partNumber, url)` calls in flight, and use
   that many when there's enough work.
3. For each part, up to `opts.maxAttempts` attempts:
   * `2xx` with `etag` → done. `2xx` **without** `etag` → reject with an error containing `ETag`.
   * `403` → `deps.presign([partNumber])` for a fresh URL and retry **without waiting**.
   * other `4xx` → reject immediately with `part N failed: STATUS`.
   * `5xx` or a thrown error → `await deps.wait(200 × 2^(attempt−1))`, then retry.
   * Every response above counts as one attempt, including a `403`.
   * attempts used up → reject with `part N failed after M attempts`. Don't wait or re-presign
     after the final attempt, because nothing would use it (3 attempts of `500` → waits `[200, 400]`).
   * Once a part has rejected, the other loops stop taking new parts.
4. Resolve with `{ partNumber, eTag }[]` sorted by part number (S3 requires ascending order).

hint: A worker pool: start `Math.min(concurrency, partCount)` async loops that each `shift()` the next part number from a shared array.
hint: Check "other 4xx" before "attempts used up", or a 400 on the last attempt gets the wrong message.
hint: Keep URLs in a `Map<number, string>` so a refresh replaces just one entry.

```ts setup
type PartUrl = { partNumber: number; url: string }
type PutResult = { status: number; etag?: string }
type Deps = {
  presign: (partNumbers: number[]) => Promise<PartUrl[]>
  put: (partNumber: number, url: string) => Promise<PutResult>
  wait: (ms: number) => Promise<void>
}
type UploadOptions = { concurrency: number; maxAttempts: number }
```

```ts starter
export async function uploadAllParts(partCount: number, deps: Deps, opts: UploadOptions) {
  const urls = await deps.presign(Array.from({ length: partCount }, (_, i) => i + 1))
  const out: { partNumber: number; eTag: string }[] = []
  for (const p of urls) {
    const r = await deps.put(p.partNumber, p.url)
    out.push({ partNumber: p.partNumber, eTag: r.etag as string })
  }
  return out
}
```

```ts solution
export async function uploadAllParts(partCount: number, deps: Deps, opts: UploadOptions) {
  const numbers = Array.from({ length: partCount }, (_, i) => i + 1)
  const urls = new Map((await deps.presign(numbers)).map((p) => [p.partNumber, p.url]))
  const queue = [...numbers]
  const done: { partNumber: number; eTag: string }[] = []
  let failed = false

  async function send(n: number) {
    for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
      let res: PutResult | null
      try {
        res = await deps.put(n, urls.get(n)!)
      } catch {
        res = null
      }
      const status = res ? res.status : 0
      if (res && status >= 200 && status < 300) {
        if (!res.etag) throw new Error(`part ${n}: missing ETag`)
        done.push({ partNumber: n, eTag: res.etag })
        return
      }
      if (status >= 400 && status < 500 && status !== 403) throw new Error(`part ${n} failed: ${status}`)
      if (attempt === opts.maxAttempts) break
      if (status === 403) {
        const [fresh] = await deps.presign([n])
        urls.set(n, fresh.url)
        continue
      }
      await deps.wait(200 * 2 ** (attempt - 1))
    }
    throw new Error(`part ${n} failed after ${opts.maxAttempts} attempts`)
  }

  async function worker() {
    while (!failed && queue.length > 0) {
      const n = queue.shift()!
      try {
        await send(n)
      } catch (e) {
        failed = true
        throw e
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(opts.concurrency, partCount) }, () => worker()))
  return done.sort((a, b) => a.partNumber - b.partNumber)
}
```

```ts tests
const tick = async (n: number) => { for (let i = 0; i < n; i++) await Promise.resolve() }
const ok = (part: number): PutResult => ({ status: 200, etag: `"e${part}"` })

function fakeDeps(behaviour: (part: number, url: string, call: number) => PutResult | 'throw', delays: Record<number, number> = {}) {
  const calls: Record<number, number> = {}
  const presignCalls: number[][] = []
  const waits: number[] = []
  const state = { inFlight: 0, maxInFlight: 0, version: 0 }
  const deps: Deps = {
    presign: async (parts) => {
      presignCalls.push(parts)
      state.version++
      return parts.map((p) => ({ partNumber: p, url: `https://s3.test/p${p}?v=${state.version}` }))
    },
    put: async (part, url) => {
      calls[part] = (calls[part] ?? 0) + 1
      state.inFlight++
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      await tick(delays[part] ?? 1)
      state.inFlight--
      const r = behaviour(part, url, calls[part])
      if (r === 'throw') throw new TypeError('Failed to fetch')
      return r
    },
    wait: async (ms) => { waits.push(ms) },
  }
  return { deps, calls, presignCalls, waits, state }
}

test('uploads every part and returns them sorted, even when they finish out of order', async () => {
  const f = fakeDeps((p) => ok(p), { 1: 6, 2: 1, 3: 4, 4: 1, 5: 2 })
  const parts = await uploadAllParts(5, f.deps, { concurrency: 3, maxAttempts: 3 })
  expect(parts).toEqual([1, 2, 3, 4, 5].map((n) => ({ partNumber: n, eTag: `"e${n}"` })))
  expect(f.presignCalls).toEqual([[1, 2, 3, 4, 5]])
})
test('never more than `concurrency` PUTs in flight, and uses all of them', async () => {
  const f = fakeDeps((p) => ok(p), { 1: 3, 2: 2, 3: 5, 4: 1, 5: 2, 6: 3, 7: 1, 8: 2, 9: 1, 10: 2 })
  await uploadAllParts(10, f.deps, { concurrency: 3, maxAttempts: 3 })
  expect(f.state.maxInFlight).toBe(3)
})
test('403 → a fresh URL for that part only, retried without waiting', async () => {
  const f = fakeDeps((p, url) => (p === 2 && url.endsWith('v=1') ? { status: 403 } : ok(p)))
  const parts = await uploadAllParts(3, f.deps, { concurrency: 2, maxAttempts: 3 })
  expect(parts).toHaveLength(3)
  expect(f.presignCalls).toEqual([[1, 2, 3], [2]])
  expect(f.calls[2]).toBe(2)
  expect(f.waits).toEqual([])
})
test('5xx and network errors back off exponentially and retry', async () => {
  const f = fakeDeps((p, _url, call) => (p !== 1 ? ok(p) : call === 1 ? { status: 503 } : call === 2 ? 'throw' : ok(p)))
  const parts = await uploadAllParts(2, f.deps, { concurrency: 2, maxAttempts: 4 })
  expect(parts.map((x) => x.partNumber)).toEqual([1, 2])
  expect(f.calls[1]).toBe(3)
  expect(f.waits).toEqual([200, 400])
})
test('other 4xx errors fail fast', async () => {
  const f = fakeDeps((p) => (p === 3 ? { status: 400 } : ok(p)))
  await expect(uploadAllParts(3, f.deps, { concurrency: 1, maxAttempts: 3 })).rejects.toThrow('part 3 failed: 400')
  expect(f.calls[3]).toBe(1)
})
test('gives up after maxAttempts', async () => {
  const f = fakeDeps(() => ({ status: 500 }))
  await expect(uploadAllParts(1, f.deps, { concurrency: 1, maxAttempts: 3 })).rejects.toThrow('part 1 failed after 3 attempts')
  expect(f.calls[1]).toBe(3)
  expect(f.waits).toEqual([200, 400])
})
test('a 2xx without ETag is an error (think: CORS did not expose it)', async () => {
  const f = fakeDeps(() => ({ status: 200 }))
  await expect(uploadAllParts(1, f.deps, { concurrency: 1, maxAttempts: 3 })).rejects.toThrow('ETag')
})
```
:::

:::cards id=cl-09-cards1 xp=20 title="Media pipeline debrief"
Q: Where does a job's state really live?
A: In the Postgres row. Redis only delivers ids and can be rebuilt from the table (the janitor + `{media}:known`).
Q: Why is the claim one Lua script (LMOVE + SET lease NX)?
A: There's no window where a job is in processing without a lease (the reaper would steal it), and a duplicate entry can't overwrite another worker's lease.
Q: Why count attempts at claim time instead of on failure?
A: OOMKills and SIGKILLs never reach a catch block. Counting each start is the only way to bound a crash loop.
Q: What is the fencing token in this design?
A: The attempt number. Final writes require `attempts = @mine`, so a zombie from an older attempt changes 0 rows.
Q: Why doesn't the worker use BLMOVE?
A: StackExchange.Redis multiplexes one connection, so blocking commands would stall every caller. Poll with a growing delay, or use pub/sub wake-ups.
Q: A presigned part URL expired mid-upload. Now what?
A: Ask the API for fresh URLs for the remaining parts on the same UploadId and continue. Uploaded parts are kept until complete/abort.
Q: Why must the browser be able to read each part's ETag?
A: CompleteMultipartUpload needs them. Cross-origin, that requires CORS `ExposeHeaders: ETag` (or the API calls ListParts itself).
Q: What does KEDA's redis list trigger measure, and what's missing?
A: LLEN of one list, which is waiting work only. Add a trigger on the processing list so running work counts too.
Q: What should a worker do on SIGTERM?
A: Stop claiming, release the current job to the front of the queue, refund the attempt, and exit within the grace period.
Q: How does a status change in the worker reach the browser?
A: IHubContext → Redis backplane (same hub type and channel prefix) → the API replica holding the user's connection → WebSocket. Clients refetch on reconnect.
Q: How does the hub authenticate a WebSocket?
A: The token arrives as `access_token` in the query string. `JwtBearerEvents.OnMessageReceived` copies it into `ctx.Token` for `/hubs/...` paths.
Q: Why do the queue-depth gauge and maintenance loop run in the API?
A: Workers scale to zero. Anything that measures or schedules must live in an always-on component.
Q: How does one trace cover API and worker?
A: The API stores its span's `traceparent` on the row, and the worker starts its Consumer span with `ActivityContext.TryParse(...)` as the parent.
Q: The three golden panels for a job system?
A: Queue depth (`max by (queue)`), job latency p95 (`histogram_quantile` over well-chosen buckets), error rate (retry + dead over all outcomes).
:::

## Recap

- The feature crosses **browser → S3 → API → Postgres → Redis → worker → SignalR**, and every seam
  is a place where a job can be lost, duplicated or stuck. Design for each seam on purpose.
- **Postgres is the truth, Redis delivers.** A janitor rebuilds the queue from the table, which also
  closes the dual-write gap between `UPDATE … queued` and `LPUSH`.
- A **leased queue** (atomic claim, heartbeat, reaper) gives at-least-once delivery. **Idempotency**
  (deterministic output keys, conditional updates) and **fencing** (the attempt number) make that
  safe.
- **Count attempts at claim time** so crashes (OOMKill) end in the **DLQ**. Retry real failures with
  **exponential backoff + jitter** on the Redis server clock.
- Browsers upload **directly to SeaweedFS** with presigned **multipart** URLs. Expired URLs are
  re-presigned per part on the same UploadId, and production needs CORS that exposes `ETag`.
- **SignalR** pushes go out once through the **Redis backplane**. Clients order updates and
  refetch on reconnect. **Keycloak** protects REST and the hub (`access_token` for WebSockets).
- **KEDA** scales workers 0 → N on waiting **and** in-flight work. Workers **release jobs on
  SIGTERM**. Housekeeping and gauges live in the always-on API.
- **OpenTelemetry** joins the trace through the stored `traceparent`. The dashboard needs
  second-scale histogram buckets and `max`, not `sum`, for shared gauges.
- The same pipeline on a cloud provider keeps every rule above; **The Managed Equivalents: Azure & AWS** maps each container to its managed service and swaps keys for workload identity.
