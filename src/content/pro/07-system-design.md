---
id: pro-07
title: System Design for Full-Stack Developers
level: advanced
minutes: 80
xp: 240
summary: Clients, gateways, stateless APIs, caching, queues, Redis, autoscaling with HPA and KEDA, database scaling, consistency trade-offs and rate limiting — then design a small SaaS end-to-end.
---

System design sounds like something only architects do. In practice, every full-stack developer
makes design decisions every week: "Should this be a background job?", "Can we cache this?",
"What happens when we run three copies of the API?", "Why is the dashboard slow at 9 a.m.?".
This lesson gives you the vocabulary and the mental models so you can take part in those
conversations, and pass the system-design round of an interview.

The goal is not to memorise how Netflix works. It is to know the **building blocks**, what
problem each one solves, and what it **costs** you.

:::job title="What you'll actually meet"
Most companies run a fairly boring architecture: a React SPA on a CDN, one or a few API
services behind a load balancer, PostgreSQL (often managed: Azure Database, RDS, Cloud SQL),
Redis for caching and sessions, and a queue for background work. Kubernetes or a PaaS runs the
containers. You will spend far more time understanding *why* those pieces are there than
inventing new ones.
:::

:::info title="Where the building blocks are taught"
This lesson is where the pieces come **together**. Each section gives you enough to follow a
design discussion, but the hands-on depth lives in the **Cloud-Native Toolkit** track. If a
section feels fast, do the matching lesson first (or right after):

| Concept here | Cloud-Native Toolkit lesson |
|---|---|
| Redis data types, persistence, eviction | **Redis Fundamentals** |
| Cache-aside, HybridCache, stampedes, invalidation | **Caching with Redis in .NET** |
| Redis queues, pub/sub and the SignalR backplane, locks, shared rate limiters | **Redis as Queue, Bus and Lock** |
| Brokers (RabbitMQ, Kafka), the outbox pattern, MassTransit / Wolverine | **Message Brokers & the Outbox Pattern** |
| Scaling workers on queue depth, scale to zero | **KEDA: Autoscale Workers on Queue Depth** |
| Traces, metrics, logs, SLO alerts | **Observability: OpenTelemetry, Prometheus, Grafana, Loki** |
:::

## The big picture: a request's journey

Follow one request from a browser to the database and back:

```text
Browser (React SPA)
   │  1. DNS: app.example.com → CDN / load balancer IP
   ▼
CDN (static files: index.html, JS, CSS, images)   ← cached at the edge, close to the user
   │  2. API call: GET https://api.example.com/projects
   ▼
Load balancer / API gateway   ← TLS termination, routing, rate limiting, auth checks
   │  3. picks one healthy instance
   ▼
API instance #1   API instance #2   API instance #3   ← stateless ASP.NET Core containers
   │        │                │
   ├── Redis (cache, sessions, rate-limit counters, distributed locks)
   ├── PostgreSQL primary (writes) ──replication──▶ read replicas (reads)
   └── Message queue (RabbitMQ / Azure Service Bus / SQS) ──▶ worker processes
                                                              (emails, PDFs, imports)
```

Each box exists to solve a specific problem:

| Building block | Problem it solves | Price you pay |
|---|---|---|
| **CDN** | Static files served from far away are slow; your servers shouldn't serve JS bundles | Cache invalidation, deploy must use hashed file names |
| **Load balancer** | One server can't handle everything; servers die | Servers must be stateless (or use sticky sessions) |
| **API gateway** | Many services, one public entry point; cross-cutting concerns (auth, rate limits) | Another hop, another thing to configure and monitor |
| **Cache (Redis)** | The DB repeats the same expensive work | Stale data, invalidation bugs, another dependency |
| **Queue + workers** | Slow work blocks HTTP requests; spikes overwhelm downstream | Eventual consistency, retries, idempotency, monitoring |
| **Read replicas** | Too many reads for one DB | Replication lag: you may read old data |
| **Partitioning/sharding** | Too much data or too many writes for one DB | Cross-shard queries are hard, rebalancing is hard |

### Client, server and API gateway

The **client** (the React app) is untrusted. Anything it sends can be faked; every check that
matters (permissions, prices, limits) must happen on the server. The client's job is UX:
rendering, optimistic updates, caching responses (TanStack Query), and retrying sensibly.

An **API gateway** is a reverse proxy at the edge of your backend. In .NET land you'll meet
**YARP** (Yet Another Reverse Proxy), Azure API Management, or an ingress controller in
Kubernetes (NGINX, Traefik). Typical responsibilities:

- **Routing**: `/api/billing/*` → billing service, `/api/*` → main API.
- **TLS termination**: HTTPS ends here. Internal traffic *may* be plain HTTP inside the cluster,
  but many teams re-encrypt it with **mTLS** (a service mesh such as Istio or Linkerd does this
  for you), so a compromised pod can't simply read or forge traffic.
- **Authentication**: reject requests without a valid JWT at the edge, so garbage never reaches
  your services (services still check *authorization*).
- **Rate limiting**, request size limits, CORS, compression.
- **Backend for Frontend (BFF)**: a gateway tailored to one client, e.g. one that keeps the auth
  cookie server-side so the SPA never touches tokens.

:::warn title="Edge validation is a layer, not the only check"
"Validated at the gateway" must not mean "trusted everywhere behind it". If a route is
misconfigured, or something inside the network (a compromised pod, a forgotten debug port) calls a
service directly, the gateway's check never happened. So, as **defence in depth**, each service
still validates the token itself (`AddJwtBearer` is cheap: a signature check against cached keys,
no network call), *or* the cluster enforces mTLS plus mesh authorization policies, so only the gateway can reach the
service at all.
Ideally both. This is the same trust-boundary thinking as in **Web Security for Full-Stack Devs**.
:::

:::pro title="Monolith first"
Experienced teams usually start with a **modular monolith**: one deployable ASP.NET Core app,
cleanly split into modules (Projects, Billing, Users) with clear boundaries. Microservices solve
*organisational* scaling (many teams deploying independently) and cost you network calls,
distributed transactions, and far more operations work. "We have 4 developers and 11
microservices" is a classic pain story.
:::

## Scaling: vertical vs horizontal

**Vertical scaling** (scale *up*): give the machine more CPU/RAM. Simple, no code changes, but
there's a ceiling, it costs more per unit, and it's still a single point of failure.

**Horizontal scaling** (scale *out*): run more copies behind a load balancer. Nearly unlimited
and resilient (one dies, others continue), but only works if the copies are
**interchangeable**, which means **stateless**.

### Statelessness

A stateless API instance keeps nothing important in its own memory between requests. Any
instance can serve any request. Things that break this:

| Stateful habit | Why it breaks with 3 instances | Fix |
|---|---|---|
| In-memory session (`HttpContext.Session` with memory store) | User logs in on #1, next request hits #2: "who are you?" | JWT/cookie auth, or session in Redis |
| `IMemoryCache` as the source of truth | Each instance has a different copy | `IDistributedCache` (Redis) or accept per-instance caches for read-only data |
| Files saved to local disk (`/uploads`) | File is on #1 only; container restarts wipe it | Blob storage (S3, Azure Blob) |
| `static` counters / in-process locks | Each process counts separately | Redis `INCR`, DB constraints, distributed locks |
| SignalR connections | A message sent on #1 doesn't reach clients connected to #2 | SignalR Redis backplane (see **Redis as Queue, Bus and Lock**) / Azure SignalR Service |
| Background timers in the API | Run 3 times, once per instance | A dedicated worker, or a scheduler with leader election (Hangfire, Quartz with DB locks) |

:::warn title="The 'works on my machine' scaling bug"
Everything works locally because you run **one** instance. The bug appears in production with
`replicas: 3`. When you add state to an API process, ask: "what happens with three of these?"
:::

## Caching layers

Caching means keeping a copy of data closer to where it's needed. There are several layers,
from the user outward:

1. **Browser cache**: `Cache-Control: max-age=31536000, immutable` for hashed assets
   (`index-4f3a2b.js`). `index.html` itself should be `no-cache` so new deploys are picked up.
2. **Client data cache**: TanStack Query keeps API responses in memory, deduplicates requests,
   and refetches in the background (`staleTime`).
3. **CDN**: caches static files (and sometimes public API responses) at edge locations worldwide.
4. **Reverse proxy / output cache**: ASP.NET Core **Output Caching** middleware caches whole
   responses on the server.
5. **Application cache**: `IMemoryCache` (per instance, fastest) or **Redis** via
   `IDistributedCache` / **HybridCache** (.NET 9+: in-memory L1 + distributed L2, with
   stampede protection). **Caching with Redis in .NET** (Cloud-Native Toolkit) compares the three
   APIs and measures a real HybridCache setup.
6. **Database**: PostgreSQL's own buffer cache, plus materialized views for expensive reports.

### Cache patterns

- **Cache-aside (lazy loading)**: the most common. Read: check cache → on miss, load from DB and
  store with a TTL. Write: update DB, then **delete** the cache key. Why delete instead of
  writing the new value into the cache? Two concurrent updates can write their cache values in
  the opposite order to their DB commits, leaving the *older* value cached until the TTL runs
  out. Deleting means the next read loads whatever the DB actually holds.
- **Write-through**: every write goes to cache and DB together. Cache is always warm; writes are
  slower.
- **Write-behind**: write to cache, flush to DB later. Fast, but you can lose data. Rare in
  business apps.

```csharp
// Cache-aside with HybridCache (.NET 9+)
public async Task<ProjectDto?> GetProject(Guid id, CancellationToken ct) =>
    await cache.GetOrCreateAsync(
        $"project:{id}",
        async token => await db.Projects
            .Where(p => p.Id == id)
            .Select(p => new ProjectDto(p.Id, p.Name, p.UpdatedAt))
            .FirstOrDefaultAsync(token),
        new HybridCacheEntryOptions { Expiration = TimeSpan.FromMinutes(5) },
        cancellationToken: ct);

// On update: write the DB first, then invalidate.
await db.SaveChangesAsync(ct);
await cache.RemoveAsync($"project:{id}", ct);
```

The two hard problems:

- **Invalidation**: when the data changes, every cached copy must expire or be removed. Short
  TTLs are the safety net when you miss an invalidation path.
- **Cache stampede (thundering herd)**: a popular key expires, 500 requests miss at once, and all
  hit the DB. Fixes: request coalescing (HybridCache does this), a lock per key, or slightly
  randomised TTLs (jitter) so keys don't all expire together. You build a single-flight loader
  for exactly this in **Caching with Redis in .NET**.

:::pro title="Measure before caching"
A cache hides a slow query; it doesn't fix it. Check the query plan (`EXPLAIN ANALYZE`) and
indexes first. Add a cache when the data is read far more often than it changes and slightly
stale data is acceptable.
:::

:::quiz id=pro-07-q1 xp=15
Your API runs as 3 replicas. Users report they are randomly logged out. Login stores the user in
`HttpContext.Session` backed by the default in-memory store. What is the most likely cause?
- [ ] The JWT signing key is too short
- [x] Sessions live in one instance's memory; the load balancer sends later requests to other instances
- [ ] PostgreSQL connection pool exhaustion
- [ ] The CDN is caching the login page
> In-memory session state is per process. Use a distributed store (Redis) or stateless auth
> (cookies/JWT that any instance can validate with a shared key — remember Data Protection keys
> must also be shared between instances!). A too-short signing key would fail *every* request,
> not random ones. Pool exhaustion shows up as timeouts and 500s, not logouts. "Random" plus
> "3 replicas" almost always points at per-instance state.
:::

## Queues and asynchronous processing

Some work doesn't belong inside an HTTP request: sending email, generating a PDF, resizing
images, importing a 50 MB CSV, calling a slow third-party API. Doing it inline makes the request
slow and fragile (if the email provider is down, does the signup fail?).

Instead: **accept the request, put a message on a queue, return quickly** (often `202 Accepted`
with a job id), and let **workers** process messages in the background.

```text
POST /api/reports  ──▶  API: validate, INSERT report(status='pending'), publish "GenerateReport{id}"
                        return 202 { reportId }
Worker  ◀── queue ──   consume message → build PDF → upload to blob → UPDATE status='done'
Client: poll GET /api/reports/{id}, or get a SignalR/WebSocket push when it's done
```

What queues buy you:

- **Decoupling**: the producer doesn't care who consumes, or when.
- **Load levelling**: a spike of 10,000 messages is processed at the workers' own pace.
- **Resilience**: if the worker crashes, the message stays in the queue and is retried.
- **Independent scaling**: add workers when the queue grows (KEDA scales K8s pods on queue length).

What they cost you, and must design for:

- **At-least-once delivery**: most queues may deliver a message **twice** (worker processed it,
  crashed before acknowledging). Consumers must be **idempotent**: processing twice has the same
  effect as once. Store a processed message id, use `INSERT ... ON CONFLICT DO NOTHING`, or make
  operations naturally idempotent ("set status = paid" rather than "add 10 credits").
- **Poison messages**: a message that always fails. After N retries move it to a **dead-letter
  queue** (DLQ) and alert someone.
- **Ordering**: often not guaranteed. Don't assume "created" arrives before "updated".
- **The dual-write problem**: you save to the DB and publish a message. If the publish fails after
  the commit, the event is lost. The **outbox pattern** fixes this: write the message into an
  `outbox` table *in the same DB transaction*, and a background relay publishes rows from the
  outbox. (MassTransit and Wolverine in .NET have this built in.) **Message Brokers & the Outbox
  Pattern** (Cloud-Native Toolkit) builds an outbox relay and an idempotent consumer step by step.

| Tool | Typical use |
|---|---|
| RabbitMQ | Classic message broker, flexible routing, self-hosted |
| Azure Service Bus / AWS SQS | Managed queues, DLQs built in |
| Kafka | Event *log*: huge throughput, replayable streams, event sourcing/analytics |
| PostgreSQL as a queue | `SELECT ... FOR UPDATE SKIP LOCKED` — great for small/medium apps, one less dependency |
| Hangfire / Quartz.NET | Scheduled and background jobs in .NET, stored in your DB |

:::quiz id=pro-07-q2 xp=15
A worker charges a customer's card when it receives `OrderPlaced`. The queue guarantees
*at-least-once* delivery. Which design prevents double charges? (Select all that apply.)
- [x] Store processed message ids (or order ids) and skip duplicates
- [x] Pass an idempotency key (the order id) to the payment provider
- [ ] Increase the number of workers
- [ ] Set the message TTL to 1 second
> Duplicates are normal with at-least-once delivery, so the consumer must be idempotent. Payment
> APIs like Stripe accept an `Idempotency-Key` header for exactly this reason. More workers only
> process duplicates faster. A 1-second TTL throws away legitimate messages whenever the workers
> fall behind, and it still doesn't stop a redelivery that happens inside that second.
:::

:::quiz id=pro-07-q5 xp=15
What happens with this handler if the broker is unreachable for a moment?

```csharp
order.Status = OrderStatus.Placed;
await db.SaveChangesAsync(ct);                         // 1. commit
await bus.PublishAsync(new OrderPlaced(order.Id), ct); // 2. publish
```

- [ ] Nothing bad: the broker queues the publish and retries it automatically
- [ ] The database transaction is rolled back, so the order isn't saved
- [x] The order is saved but `OrderPlaced` is never published, so no confirmation email, invoice or stock update happens
- [ ] The message is published twice
> This is the **dual-write problem**. Step 1 is already committed when step 2 throws, so
> there's nothing to roll back, and the event is simply lost. Swapping the order doesn't help
> either: publish first, then crash before the commit, and consumers react to an order that
> doesn't exist. The **outbox pattern** fixes it. Insert the `OrderPlaced` row into an `outbox`
> table in the *same* transaction as the order, and a relay publishes it afterwards (at least
> once, so consumers stay idempotent).
:::

## Redis: the Swiss Army knife in most designs

You'll find Redis in almost every diagram above, so it's worth knowing exactly what it's good
at and where it bites. **Redis** is an in-memory data-structure server. You store keys whose
values are strings, hashes, lists, sets, sorted sets or streams, and every operation is a tiny
command over the network (`GET`, `INCR`, `ZADD`…). Two properties explain why designs lean on it:

- **It's fast**: data lives in RAM, so a round trip inside the datacenter takes well under a
  millisecond.
- **Each command is atomic**: commands run one at a time, so `INCR counter` from 50 API
  instances never loses an update. That makes Redis a good *shared* place for small, hot state
  that stateless instances can't keep in their own memory.

| Job in the design | Redis feature | Typical .NET usage |
|---|---|---|
| Distributed cache | Strings with a TTL (`SET key value EX 300`) | `IDistributedCache` / HybridCache L2 |
| Shared rate-limit counters | `INCR` + `EXPIRE` per user per window | Custom middleware or the gateway |
| Sessions | Keys with a sliding TTL | `AddStackExchangeRedisCache` + `AddSession` |
| Data Protection key ring | One list key with **no TTL** that must never be evicted (keep it out of an `allkeys-lru` cache instance, or persist the keys to the DB or blob storage instead) | `PersistKeysToStackExchangeRedis` |
| Real-time fan-out between instances | Pub/Sub | SignalR Redis backplane |
| Leaderboards, "top N", time-ordered sets | Sorted sets (`ZADD`, `ZRANGE`) | StackExchange.Redis |
| Lightweight job queue | Streams with consumer groups (`XADD`, `XREADGROUP`, `XACK`) | StackExchange.Redis, or a library on top |
| "Only one worker does this" | `SET lock:x <token> NX PX 30000` | A short lease, see the warning below |

Here's a shared fixed-window limiter. It does what ASP.NET Core's built-in limiter (see Rate
limiting below) can't: count across all instances.

```csharp
// 100 requests per user per minute, counted across ALL API instances
var window = DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 60;
var key = $"rl:{userId}:{window}";
long count = await redis.StringIncrementAsync(key);           // atomic, returns the new value
if (count == 1) await redis.KeyExpireAsync(key, TimeSpan.FromMinutes(2)); // old windows clean themselves up
if (count > 100) return Results.StatusCode(StatusCodes.Status429TooManyRequests);
```

`redis` here is an `IDatabase` from StackExchange.Redis's `ConnectionMultiplexer`. Create
**one** multiplexer and register it as a singleton, because it's designed to be shared and is
expensive to create. One subtle gap: if the process dies between `INCR` and `EXPIRE`, the key
never expires. Production code runs both in one Lua script (or a `MULTI` transaction) so they
happen together.

### The sharp edges

- **RAM is the limit.** When Redis hits `maxmemory`, the **eviction policy** decides what
  happens. A cache wants `allkeys-lru` (drop the least recently used keys). Anything you can't
  afford to lose (queues, locks) needs `noeviction`, so writes fail loudly instead of data
  silently disappearing. Mixing both kinds of data in one instance forces a bad compromise.
  Data Protection keys and locks belong with the `noeviction` data, not the cache: if the key
  ring is evicted, every auth cookie and antiforgery token becomes unreadable at once, which
  looks like a mass logout.
- **Persistence is optional and lossy.** RDB snapshots and the AOF log (`appendfsync everysec`)
  can lose up to the last second or the last snapshot in a crash. Treat Redis as rebuildable:
  the **source of truth stays in PostgreSQL**.
- **Pub/Sub is fire-and-forget.** A subscriber that is offline or reconnecting misses the
  message forever. That's acceptable for the SignalR backplane, because a missed real-time push
  is recoverable, as long as the UI also refetches on reconnect, on focus or periodically. Note
  that the browser's WebSocket to the API instance usually stays up while that instance's Redis
  subscription blips, so the client doesn't notice, and SignalR doesn't replay messages lost
  while Redis was unreachable. Not fine for "send the invoice". Use Streams or a real broker for
  work that must not be lost.
- **Distributed locks are leases, not guarantees.** A lock with a 30-second expiry can run out
  while its holder is stuck in a long GC pause or a slow network call. Then a second worker takes
  the lock and **both** think they own it. Use locks to avoid *duplicate work*. For
  *correctness*, let the database decide: a unique constraint, optimistic concurrency, or a
  fencing token (an increasing number the database checks).
- **Hot keys and big keys.** One key read 50,000 times per second, or one 200 MB hash, pins a
  single Redis thread or shard. Spread hot data (key per item, a short local L1 cache) and keep
  values small.
- **It's another dependency that can go down.** Decide up front what degrades. A cache miss
  falls back to the DB, while the rate limiter fails open or closed: pick one deliberately.

:::info title="Redis, Valkey and licences"
In 2024 Redis moved to source-available licences, and the Linux Foundation forked the last open
version as **Valkey**. Redis 8 (2025) added AGPLv3 as an option again. Valkey speaks the same
protocol, so StackExchange.Redis and `redis-cli` work unchanged, and several clouds now offer
Valkey as their managed "Redis". In a design discussion, "Redis" usually means "that kind of
store". For the commands, data types, persistence and eviction in depth, see the **Redis
Fundamentals** lesson in the Cloud-Native Toolkit track. Locks with fencing tokens, reliable
queues and Redis rate limiters (fixed and sliding window) are built hands-on in **Redis as
Queue, Bus and Lock** in the same track.
:::

:::quiz id=pro-07-q6 xp=15
Two report workers use `SET lock:report:42 <token> NX PX 30000` so only one generates report 42.
Worker A takes the lock, then hangs in a 40-second GC pause. What can happen?
- [ ] Nothing: Redis keeps the lock until worker A releases it
- [x] The lock expires after 30 s, worker B takes it, and both workers write report 42
- [ ] Worker B blocks until A finishes, because `NX` waits for the key
- [ ] Redis detects the pause and extends A's lock automatically
> `PX 30000` means the key *expires* after 30 s whether or not A is still working. That's how
> the lock survives crashed holders, and it's also why a paused holder can lose it without
> noticing. `NX` doesn't wait: it just fails if the key exists, and B retries later. Redis has
> no idea what A is doing. So treat Redis locks as an optimisation against duplicate work, and
> make the final write safe on its own (unique constraint, `WHERE version = @v`, or a fencing
> token).
:::

:::quiz id=pro-07-q7 xp=15
Which of these are sound uses of Redis in a typical SaaS? (Select all that apply.)
- [x] An L2 cache for project DTOs, with a TTL, under `allkeys-lru`
- [x] Per-user request counters shared by all API instances for rate limiting
- [ ] The only copy of customer invoices, because it's faster than PostgreSQL
- [x] The SignalR backplane so a message sent on instance 1 reaches clients connected to instance 3
- [ ] Pub/Sub as the transport for "charge the customer" commands
> Caches, counters and backplanes are all fine to lose or rebuild. Worst case, you get a cache
> miss, a briefly reset counter, or a client that refetches. Invoices are business records:
> eviction or a crash between snapshots could delete them, so they belong in the database.
> Pub/Sub drops messages for any subscriber that isn't connected at that moment, so payment
> commands need a durable queue (a Redis Stream, RabbitMQ, Service Bus) with acknowledgements
> and idempotent consumers.
:::

## Autoscaling: scale on the signal that matters

Horizontal scaling is only half the story. You also need something to decide **how many**
copies to run, minute by minute. In Kubernetes there are two tools you'll meet, and the design
question is always the same: *which metric actually tracks the load?*

**The HorizontalPodAutoscaler (HPA)** is built into Kubernetes. It watches a metric for a
Deployment and adjusts `replicas`, roughly `desired = ceil(current × currentMetric / target)`.
The classic metric is CPU utilisation relative to the pods' CPU **requests**. That works well for
an **API**, where more requests mean more CPU: 3 pods at 90 % CPU with a 60 % target becomes
`ceil(3 × 90 / 60) = 5` pods.

CPU is the wrong signal for a **queue worker**. A worker that sends emails or calls slow APIs
spends its time *waiting*. It can sit at 5 % CPU with 40,000 messages piling up, and the HPA
will never scale it. Also, an HPA normally keeps at least one replica, so an idle worker still
costs a pod around the clock.

**KEDA** (Kubernetes Event-Driven Autoscaling, a CNCF project) fills that gap. You describe *what
to watch* in a `ScaledObject`. KEDA asks the event source directly (queue length, Kafka consumer
lag, a Redis list or stream, a PostgreSQL query, a Prometheus metric, a cron schedule) and does
two jobs:

- **0 ↔ 1 (activation)**: KEDA itself starts the first pod when work appears, and scales back to
  **zero** after a quiet `cooldownPeriod`.
- **1 ↔ N**: KEDA creates and feeds a regular HPA with the external metric, so the normal HPA
  formula does the rest.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: report-worker
spec:
  scaleTargetRef:
    name: report-worker          # the worker Deployment
  minReplicaCount: 0             # scale to zero when the queue is empty
  maxReplicaCount: 20            # protect the database and downstream APIs
  cooldownPeriod: 300            # seconds of no work before going 1 → 0
  triggers:
    - type: rabbitmq
      metadata:
        queueName: generate-report
        mode: QueueLength
        value: "10"              # target ≈ 10 waiting messages per replica
      authenticationRef:
        name: rabbitmq-auth      # a TriggerAuthentication holding the connection string
```

With 45 messages waiting, the HPA that KEDA manages aims for `ceil(45 / 10) = 5` replicas.

### Design questions autoscaling forces on you

- **What's the ceiling downstream?** `maxReplicaCount: 20` workers × a Npgsql pool of 10 = up to
  200 Postgres connections. A typical `max_connections` is 100. Autoscaling can turn a backlog
  into a database outage. Cap replicas, keep pools small, or put PgBouncer in front. (Npgsql's
  default `Maximum Pool Size` is 100, so 20 workers that never set it could ask for 2,000
  connections. Set it explicitly in the connection string for autoscaled workers, e.g.
  `Maximum Pool Size=10`.)
- **Is a cold start acceptable?** Scale-from-zero means pulling the image and starting .NET:
  seconds, not milliseconds. That's fine for report generation. For a user-facing HTTP API, keep
  `minReplicas ≥ 2` and scale on CPU or request rate.
- **Can pods be killed mid-job?** Scaling *in* sends SIGTERM to busy workers. Acknowledge a
  message only **after** finishing it, stop taking new messages on shutdown, and keep handlers
  idempotent. A killed job then simply gets redelivered.
- **How many workers do you need?** Use **Little's law**: work in progress = arrival rate ×
  time per item. 50 messages/s × 0.2 s each = 10 messages in flight, so about 10 worker slots
  (replicas × concurrency per replica), plus headroom for peaks.

The **Cluster Autoscaler** (or Karpenter) sits one level below: when new pods don't fit on the
existing nodes, it adds machines. The hands-on version of all this (HPA formula, KEDA install,
scale-to-zero on a Postgres queue) is in the Containers & Kubernetes **Scaling** lesson, and the
Cloud-Native Toolkit's **KEDA: Autoscale Workers on Queue Depth** lesson goes deeper (cooldown,
stabilisation, and a .NET worker on a Redis list scaling 0 → N → 0).

:::quiz id=pro-07-q8 xp=15
An email worker Deployment has an HPA targeting 70 % CPU. During a newsletter send, the queue
holds 60,000 messages, the workers sit at 6 % CPU, and the HPA stays at 2 replicas. Best fix?
- [ ] Lower the HPA CPU target to 5 %
- [ ] Raise the workers' CPU limit so they can work faster
- [x] Scale on the backlog instead: a KEDA `ScaledObject` with a queue-length trigger and a sensible `maxReplicaCount`
- [ ] Switch the Deployment to a StatefulSet
> The workers are waiting on the email provider, not computing, so CPU doesn't reflect the
> backlog. Queue length does, and that's exactly what KEDA scales on (and it can drop to zero
> between sends). A 5 % CPU target is the tempting hack. It reacts to noise, scales the
> worker up and down at random, and still doesn't measure the backlog. More CPU won't speed up
> network waits. And StatefulSets are for stable identity and storage, not for scaling.
:::

:::quiz id=pro-07-q9 xp=15
Image thumbnails arrive at **30 per second** on average, and each takes **2 seconds** to
process. One worker pod handles one image at a time. Roughly how many pods do you need just to
keep up (before peak headroom)?
- [ ] 15
- [ ] 30
- [x] 60
- [ ] 2
> Little's law: items in progress = arrival rate × time per item = 30/s × 2 s = 60. With fewer
> than 60 busy workers, more images arrive than finish, so the queue grows without limit. The
> tempting "30" just reuses the arrival rate and forgets that each image ties up a worker for
> 2 seconds. With 4 parallel images per pod you'd need about 15 pods. Then add headroom for peaks
> and check that `maxReplicaCount` won't overload whatever the workers write to.
:::

## Database scaling

PostgreSQL on decent hardware handles a lot more than people think: thousands of simple queries
per second and hundreds of GB of data. Scale in this order, cheapest first:

1. **Fix queries**: indexes, avoid N+1 (EF Core `Include`/projection), `EXPLAIN ANALYZE`,
   pagination (keyset instead of big `OFFSET`).
2. **Connection pooling**: each Postgres connection is a process. Npgsql pools per app instance;
   with many instances put **PgBouncer** in front.
3. **Vertical scaling**: more RAM (more of the working set in cache) and faster disks.
4. **Caching** hot reads (see above).
5. **Read replicas**: the primary streams its WAL to replicas; send read-only queries there.
6. **Partitioning**: split one huge table into pieces *within one database*.
7. **Sharding**: split data across *multiple databases*. Last resort.

### Read replicas and replication lag

Replication is usually **asynchronous**: the replica is a few milliseconds (or seconds, under
load) behind. Classic bug: user saves their profile (write to primary), the page reloads and
reads from a replica, and shows the **old** name. Fixes:

- **Read-your-own-writes**: after a write, route that user's reads to the primary for a few
  seconds, or always read the user's own data from the primary.
- Use replicas for things that tolerate lag: reports, search, dashboards, public listings.

### Partitioning vs sharding

**Partitioning** (PostgreSQL declarative partitioning) splits a table by a key into child
tables, still one database:

```sql
CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_11 PARTITION OF events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
```

Queries filtered by `created_at` only touch relevant partitions (**partition pruning**), and
dropping last year's data is `DROP TABLE events_2025_11` (or `ALTER TABLE events DETACH
PARTITION … CONCURRENTLY` first) instead of a massive `DELETE`. One gotcha: a primary key or
unique constraint on a partitioned table **must include the partition key**, so here it would
be `PRIMARY KEY (id, created_at)`. Queries that don't filter on `created_at` have to scan every
partition, so partition by the column your hot queries actually filter on.

**Sharding** puts different rows on different database servers, chosen by a **shard key**
(e.g. `tenant_id`). Good shard keys spread load evenly and keep related data together (all of one
tenant's data on one shard, so most queries hit one shard). Costs: cross-shard joins and
transactions, rebalancing when a shard gets hot, and much more complex operations. Tools like
Citus make it easier for Postgres. Most SaaS products never need it.

:::pro title="Multi-tenant SaaS"
Three common tenancy models: **shared tables with a `tenant_id` column** (cheapest, most common;
enforce with EF Core global query filters or Postgres Row-Level Security), **schema per tenant**,
and **database per tenant** (strong isolation, expensive). Start with `tenant_id` + indexes that
lead with `tenant_id`.
:::

## Consistency trade-offs (CAP in plain words)

When data lives on more than one machine, the machines can lose contact with each other (a
**network partition**). The **CAP theorem** says that during a partition you must choose:

- **Consistency (C)**: every read sees the latest write, or gets an error. To guarantee that,
  some requests must be refused while nodes can't agree.
- **Availability (A)**: every request gets a (non-error) answer, even if it might be stale.

The "P" isn't optional: networks *do* fail. So the real question is "**when things break, do we
prefer a correct answer or any answer?**"

- Bank balance, inventory reservation, unique usernames → prefer **consistency** (refuse rather
  than double-spend).
- Like counts, view counters, "who's online", recommendations → prefer **availability**
  (a slightly wrong number is fine).

Even without failures there's a trade-off between **latency and consistency** (the PACELC
extension): synchronous replication to another region is consistent but slow.

**Eventual consistency** means: if no new writes happen, all copies will *eventually* agree.
Queues, read replicas and caches all make parts of your system eventually consistent. That is
fine, as long as the UI is honest about it ("Your export is being prepared…").

:::quiz id=pro-07-q3 xp=15
Which features are reasonable to make **eventually consistent**? (Select all that apply.)
- [x] The number of views on a blog post
- [x] A search index updated from database changes
- [ ] Preventing two users from registering the same username
- [x] An analytics dashboard refreshed every few minutes
> Uniqueness must be enforced strongly, ideally by a UNIQUE constraint in the primary database.
> If two registrations check "is `ana` free?" against a stale copy at the same moment, both
> succeed, and you can't undo that later. Counters, search indexes and dashboards tolerate a
> delay: a view count that is 30 seconds behind harms no one.
:::

## Rate limiting

Rate limiting protects your system from abuse (brute-force logins, scrapers), noisy neighbours
(one tenant hogging resources) and accidental loops (a buggy client retrying in a tight loop).

Common algorithms:

| Algorithm | How it works | Notes |
|---|---|---|
| **Fixed window** | Count requests per clock minute; reject after N | Simple; allows bursts of 2N at window edges |
| **Sliding window** | Weight the previous window's count to smooth the edge | Fairer, slightly more work |
| **Token bucket** | Bucket holds up to B tokens, refills at R/sec; each request takes one | Allows short bursts, enforces average rate. Very common |
| **Concurrency limit** | At most N requests *in flight* | Protects expensive endpoints |

ASP.NET Core has this built in:

```csharp
using System.Threading.RateLimiting;

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests; // the default is 503!
    o.OnRejected = (ctx, _) =>
    {
        // Tell well-behaved clients when to come back
        if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            ctx.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString();
        return ValueTask.CompletedTask;
    };
    o.AddPolicy("per-user", ctx =>
        RateLimitPartition.GetTokenBucketLimiter(
            ctx.User.Identity?.Name ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anon",
            _ => new TokenBucketRateLimiterOptions
            {
                TokenLimit = 20,                       // burst size
                TokensPerPeriod = 10,                  // refill
                ReplenishmentPeriod = TimeSpan.FromSeconds(1),
                QueueLimit = 0,
            }));
});

app.UseRateLimiter();
app.MapPost("/api/login", Login).RequireRateLimiting("per-user");
```

The **partition key** (the first argument) decides *who* shares a bucket. Here it's the
signed-in user, falling back to the client IP for anonymous calls like login. Respond with
**`429 Too Many Requests`** and a **`Retry-After`** header. Clients should back off with
**exponential backoff + jitter**.

Three mistakes you'll see in real code:

- **The limit is per instance.** The built-in limiter keeps its buckets in process memory, so
  "20 per user" across 3 replicas really means up to 60. For a global limit, use the gateway or a
  Redis counter (shown in the Redis section above).
- **Every user has the same IP.** Behind a load balancer or ingress, `RemoteIpAddress` is the
  *proxy's* address unless you enable the Forwarded Headers middleware (and trust only your own
  proxy). Without that, one noisy client gets the whole internet rate-limited.
- **Login is only limited per IP.** Attackers rotate IPs. Brute-force protection also needs a
  limit *per account* (keyed by the username being tried), plus lockout or CAPTCHA on repeated
  failures.

:::challenge id=pro-07-c1 lang=ts xp=40
title: A token bucket rate limiter
Implement `createTokenBucket(capacity, refillPerSecond)` returning an object with
`tryTake(nowMs: number): boolean`. The bucket starts **full**. Tokens refill continuously at
`refillPerSecond` (fractions allowed), never above `capacity`. `tryTake` returns `true` and
consumes one token if at least one whole token is available, otherwise `false`.

Time is passed in explicitly (`nowMs`) so it's testable: the first call defines the start time.

hint: Store `tokens` and `lastMs`. On each call add `(nowMs - lastMs) / 1000 * refillPerSecond`, cap at `capacity`, then update `lastMs`.
hint: Initialise `lastMs` lazily on the first call (e.g. `let lastMs: number | null = null`).

```ts starter
export function createTokenBucket(capacity: number, refillPerSecond: number) {
  return {
    tryTake(nowMs: number): boolean {
      return true
    },
  }
}
```

```ts solution
export function createTokenBucket(capacity: number, refillPerSecond: number) {
  let tokens = capacity
  let lastMs: number | null = null
  return {
    tryTake(nowMs: number): boolean {
      if (lastMs !== null) {
        tokens = Math.min(capacity, tokens + ((nowMs - lastMs) / 1000) * refillPerSecond)
      }
      lastMs = nowMs
      if (tokens >= 1) {
        tokens -= 1
        return true
      }
      return false
    },
  }
}
```

```ts tests
test('allows a burst up to capacity', () => {
  const b = createTokenBucket(3, 1)
  expect(b.tryTake(0)).toBe(true)
  expect(b.tryTake(0)).toBe(true)
  expect(b.tryTake(0)).toBe(true)
  expect(b.tryTake(0)).toBe(false)
})
test('refills over time', () => {
  const b = createTokenBucket(2, 1)
  b.tryTake(0); b.tryTake(0)
  expect(b.tryTake(500)).toBe(false)
  expect(b.tryTake(1000)).toBe(true)
  expect(b.tryTake(1000)).toBe(false)
})
test('never exceeds capacity', () => {
  const b = createTokenBucket(2, 10)
  b.tryTake(0)
  // a long idle time refills to at most 2
  expect(b.tryTake(60_000)).toBe(true)
  expect(b.tryTake(60_000)).toBe(true)
  expect(b.tryTake(60_000)).toBe(false)
})
test('fractional refill rates work', () => {
  const b = createTokenBucket(1, 0.5)
  expect(b.tryTake(0)).toBe(true)
  expect(b.tryTake(1000)).toBe(false)
  expect(b.tryTake(2000)).toBe(true)
})
```
:::

## Reliability patterns in one table

Distributed systems fail in partial, weird ways. These patterns come up constantly:

| Pattern | What it does | .NET tooling |
|---|---|---|
| **Timeouts** | Never wait forever on a dependency | `HttpClient.Timeout`, `CancellationToken` |
| **Retries with backoff + jitter** | Survive transient failures without hammering | Polly / `Microsoft.Extensions.Http.Resilience` (`AddStandardResilienceHandler`) |
| **Circuit breaker** | Stop calling a dependency that's clearly down; fail fast; try again later | Polly |
| **Bulkhead** | Isolate resources so one slow dependency can't eat all threads/connections | Polly, separate pools |
| **Health checks** | Liveness ("restart me") vs readiness ("don't send traffic yet") | `AddHealthChecks()`, K8s probes |
| **Graceful degradation** | Recommendations down? Show the page without them | Feature flags, fallbacks |
| **Idempotency keys** | Safe client retries of POSTs | `Idempotency-Key` header + stored results |

:::warn title="Retries can make outages worse"
If every layer retries 3 times, one user request can become 3 × 3 × 3 = 27 calls to a struggling
database. Retry at **one** layer, with backoff and a cap, and only for errors that are actually
transient (timeouts, 503) — never for `400 Bad Request`.
:::

## Back-of-the-envelope estimation

Interviewers and architects love quick numbers. You need rough orders of magnitude, not
precision.

- 1 day ≈ 86,400 s ≈ **10⁵ s**. 1 million requests/day ≈ **12 req/s** average. Peak is often
  **2–10×** the average.
- Memory read ~100 ns; SSD read ~100 µs; same-datacenter round trip ~0.5 ms; cross-continent
  round trip ~100–150 ms.
- A well-indexed Postgres primary key lookup: well under 1 ms on the server.
- Storage: 1 million rows × 1 KB = **1 GB**.

Example: a SaaS with 50,000 daily active users, each making ~200 API calls/day →
10 million requests/day ≈ 115 req/s average, maybe 500–1,000 req/s at peak. That's a few API
instances and one well-tuned Postgres with a replica. No sharding, no Kafka.

:::quiz id=pro-07-q4 xp=15
Roughly how many requests per second on average is **100 million requests per day**?
- [ ] ~12
- [ ] ~120
- [x] ~1,200
- [ ] ~12,000
> 100,000,000 / 86,400 ≈ 1,157. Use 10⁵ seconds per day as the shortcut: 10⁸ / 10⁵ = 10³.
> The usual slip is an order of magnitude: ~120 is 10 M/day, and ~12,000 would be about 1 billion/day.
> Remember this is the *average*: plan for a peak of 2–10× that.
:::

## Designing a small SaaS end-to-end

Let's apply everything to a realistic product: **"TaskFlow"**, a project-management SaaS. Teams
(tenants) have projects, tasks, comments and file attachments. Users get email notifications and
can export a project to PDF.

:::info title="You have built a smaller one already"
**BranchStory**, the Capstone app, has the same shape at a smaller scale: a React SPA, a stateless
ASP.NET Core API, PostgreSQL with versioned saves, SignalR for live editing, and a worker fed by a
Postgres job queue. While you read the TaskFlow design, ask at each step what BranchStory does
today and what it would need at 100x the users. That is the conversation a system-design round
wants to have.
:::

### 1. Clarify requirements

Always start here, in real life and in interviews.

- **Functional**: sign up/login, CRUD projects & tasks, comments, attachments, notifications,
  PDF export, real-time updates when a teammate changes a task.
- **Non-functional**: 2,000 tenants, 30,000 DAU, p95 API latency < 300 ms, 99.9% availability
  (~43 min downtime/month), data stays in the EU, GDPR deletion.
- **Out of scope** (for now): mobile apps, offline mode, public API.

### 2. Estimate

30,000 DAU × 300 calls/day ≈ 9 M requests/day ≈ 100 req/s average, ~500 at peak.
Attachments: 30,000 users × 5 files/month × 2 MB = 300 GB/month → blob storage, not the DB.

### 3. High-level design

```text
React SPA (Vite build) ── CDN (hashed assets, index.html no-cache)
     │ HTTPS + auth cookie (BFF) / JWT
     ▼
Ingress / gateway: TLS, rate limiting, routing
     ▼
TaskFlow API (ASP.NET Core, 3+ stateless replicas, HPA on CPU, minReplicas 3)
     ├── PostgreSQL primary (+1 replica for reports) — tenant_id on every table, RLS or EF filters
     ├── Redis — HybridCache L2, SignalR backplane, rate-limit counters
     ├── Blob storage — attachments via pre-signed upload URLs (browser uploads directly)
     └── Outbox table ─▶ queue ─▶ Worker service: emails, PDF export, webhooks
                                    (KEDA on queue length, 0 → 10 replicas)
SignalR hub — pushes "task updated" to clients in the same project group
Observability: OpenTelemetry traces + metrics, structured logs with correlation ids
```

That last line hides a lot of work: one trace that follows a request from React through the API,
the outbox and the queue into the worker, plus alerts that page on symptoms (error rate, latency
SLOs) rather than on CPU. **Observability: OpenTelemetry, Prometheus, Grafana, Loki**
(Cloud-Native Toolkit) wires that up for exactly this kind of system.

### 4. Data model (core)

```text
tenants(id, name, plan, created_at)
users(id, tenant_id, email UNIQUE, display_name)
projects(id, tenant_id, name, archived_at)
tasks(id, tenant_id, project_id, title, status, assignee_id, version, updated_at)
comments(id, tenant_id, task_id, author_id, body, created_at)
attachments(id, tenant_id, task_id, blob_key, size_bytes, content_type)
outbox(id, type, payload jsonb, created_at, processed_at)
-- indexes lead with tenant_id: (tenant_id, project_id, status)
```

### 5. Deep dives (where the interesting decisions are)

- **Concurrent edits**: two people edit the same task. Use optimistic concurrency (`version` /
  Postgres `xmin` as an EF Core concurrency token) and return `409 Conflict` so the UI can show
  "someone else changed this".
- **Attachments**: the API returns a short-lived pre-signed URL; the browser uploads straight to
  blob storage. The API never streams 50 MB files through its own memory.
- **PDF export**: `POST /exports` → 202 + job id → worker builds the PDF → SignalR notification
  with a download link. Idempotent by export id.
- **Notifications**: task assigned → outbox row in the same transaction → worker sends email.
  Batch into a digest so a bulk update doesn't send 200 emails.
- **Tenant isolation**: every query filtered by `tenant_id` from the authenticated user, never
  from the request body. Integration tests that prove tenant A can't read tenant B.
- **Failure modes**: Redis down → cache misses fall back to the DB, SignalR degrades to polling;
  email provider down → messages wait in the queue; DB primary down → managed failover to a
  standby (minutes of errors, alerts fire).

### 6. Evolve

Say what you'd do *later*, when numbers demand it: search via Postgres full-text → OpenSearch;
move audit events to partitioned tables; split the billing module into its own service when a
separate team owns it.

:::pro title="Interview structure that works"
Requirements (5 min) → estimates (2–3 min) → high-level diagram (10 min) → data model & API
(5–10 min) → deep dive on 1–2 hard parts (10 min) → bottlenecks, failures, trade-offs (5 min).
Talk out loud, state assumptions, and name the trade-off of every choice.
:::

:::lab id=pro-07-lab1 xp=100
title: Design "LinkShort", a URL shortener SaaS
Do this on paper, a whiteboard, or a tool like Excalidraw. Give yourself **45 minutes** like in
an interview. Requirements: users create short links (`sho.rt/abc123`) that redirect to long
URLs; links have click analytics; 10 M redirects/day, 100 k new links/day; free plan is
rate-limited; custom aliases must be unique.

Questions to answer in your write-up:

1. Estimates: redirects per second (average and peak), storage per year.
2. How do you generate short codes? (Counter + base62? Random + uniqueness check? Trade-offs?)
3. Which status code for the redirect, and why does it matter for analytics? (301 vs 302)
4. How do redirects stay fast? Where do you cache, and what is the invalidation story when a
   link is deleted?
5. How do you count clicks without slowing redirects down? (Hint: queue / batch writes.)
6. Where do you enforce rate limits for the free plan?
7. What happens when Redis is down? When the database primary is down?

:::tip
Reference points: base62 with 7 characters gives 62⁷ ≈ 3.5 trillion codes. A 302 (or 307) keeps
the browser coming back to you (good for analytics). Browsers may cache a 301 indefinitely
unless you send `Cache-Control`, so later clicks never reach you and can't be counted.
:::

:::info title="Check your estimates"
Compare after you've done your own. 10 M redirects/day ÷ 10⁵ s ≈ **100–120/s** average, so plan
for ~1,000/s at peak. 100 k links/day × 365 ≈ **36.5 M links/year**. At ~500 bytes per row
including indexes that's ~**18 GB/year**, which fits one Postgres comfortably. Click events are
the bigger table: 10 M/day × ~100 bytes ≈ 1 GB/day. That's a reason to aggregate them (counts
per link per hour) or partition them by month. Redirects are ~100:1 read-heavy, so a Redis cache
of `code → url` in front of the DB is the obvious win.
:::

- [ ] I wrote down functional and non-functional requirements and the estimates
- [ ] I drew a diagram with client, gateway, API, cache, database and a queue/worker
- [ ] I defined the `links` table (with a UNIQUE constraint on the code) and the main endpoints
- [ ] I explained my short-code strategy and the redirect status code
- [ ] I described click counting that doesn't block the redirect
- [ ] I listed at least three failure modes and how the system degrades
- [ ] I compared my estimates with the reference numbers and can explain any big difference
:::

:::cards id=pro-07-cards1 xp=20 title="System design building blocks"
Q: What does a CDN do for a React SPA?
A: Serves static assets (JS, CSS, images) from edge locations close to users, so they load fast and your servers don't serve them. Use hashed file names with long cache lifetimes; keep index.html no-cache.
Q: What is an API gateway responsible for?
A: Single entry point: routing to services, TLS termination, authentication, rate limiting, CORS, request limits, sometimes response aggregation (BFF).
Q: Vertical vs horizontal scaling?
A: Vertical = bigger machine (simple, has a ceiling, single point of failure). Horizontal = more machines behind a load balancer (resilient, needs stateless instances).
Q: What makes an API instance "stateless"?
A: It keeps no request-to-request state in its own memory or disk. Sessions, files, caches that must be shared and locks live in external stores (Redis, DB, blob storage).
Q: Cache-aside pattern?
A: Read: check cache, on miss load from DB and store with TTL. Write: update DB, then delete the cache key.
Q: What is a cache stampede and how do you prevent it?
A: A hot key expires and many requests hit the DB simultaneously. Prevent with request coalescing / per-key locks (HybridCache), TTL jitter, or refreshing before expiry.
Q: Why put slow work on a queue?
A: Keeps HTTP requests fast, levels load spikes, survives downstream outages via retries, and lets workers scale independently.
Q: What does at-least-once delivery imply for consumers?
A: Messages can arrive more than once, so consumers must be idempotent (dedupe by message id, upserts, idempotency keys).
Q: What is a dead-letter queue?
A: Where messages go after failing N times, so a poison message doesn't block the queue. Someone must monitor and replay/inspect it.
Q: What is the outbox pattern?
A: Write the event to an outbox table in the same DB transaction as the business change; a relay publishes outbox rows to the broker. Solves the dual-write problem.
Q: What is replication lag and the classic bug it causes?
A: Async replicas are behind the primary. A user saves data, then reads from a replica and sees the old value. Fix with read-your-own-writes routing to the primary.
Q: Partitioning vs sharding?
A: Partitioning splits a table into child tables inside one database (pruning, cheap data retention). Sharding spreads rows across multiple database servers by a shard key.
Q: CAP theorem in one sentence?
A: During a network partition, a distributed system must choose between consistency (refuse or error) and availability (answer, possibly stale).
Q: What is eventual consistency?
A: If writes stop, all replicas/copies will converge to the same value after some time. Reads in between may be stale.
Q: Token bucket rate limiting?
A: A bucket of B tokens refills at rate R; each request consumes one. Allows bursts up to B while enforcing an average rate R.
Q: What should a rate-limited response look like?
A: HTTP 429 Too Many Requests with a Retry-After header. Clients back off exponentially with jitter.
Q: Circuit breaker?
A: After repeated failures, stop calling the dependency for a cool-down period and fail fast; then let a trial request through (half-open) to see if it recovered.
Q: Liveness vs readiness probe?
A: Liveness: is the process stuck? Failing restarts it. Readiness: can it take traffic now? Failing removes it from the load balancer without restarting.
:::

:::cards id=pro-07-cards2 xp=20 title="Numbers, trade-offs and SaaS design"
Q: Seconds in a day, rounded for estimates?
A: ~86,400 ≈ 10⁵. So 1 M requests/day ≈ 12 req/s; 100 M/day ≈ 1,200 req/s.
Q: Rough latency: memory, SSD, same-datacenter network, cross-continent?
A: ~100 ns, ~100 µs, ~0.5 ms, ~100–150 ms.
Q: Why is the modular monolith a common starting point?
A: One deployment, in-process calls, simple transactions, while modules keep clean boundaries. Microservices mainly solve team-scaling problems and add operational cost.
Q: Three multi-tenancy models?
A: Shared tables with tenant_id (most common), schema per tenant, database per tenant (strongest isolation, highest cost).
Q: How do you enforce tenant isolation in EF Core / Postgres?
A: Take tenant_id from the authenticated user, never from the request; EF Core global query filters or Postgres Row-Level Security; tests proving cross-tenant reads fail.
Q: How should large file uploads work?
A: The API issues a short-lived pre-signed URL; the browser uploads directly to blob storage; the API stores only metadata.
Q: How do you handle two users editing the same record?
A: Optimistic concurrency: a version/xmin concurrency token; the losing update gets 409 Conflict and the UI offers to reload or merge.
Q: Why connection pooling / PgBouncer?
A: Each Postgres connection is a process with memory overhead; many app instances × pool size can exhaust max_connections. A pooler multiplexes them.
Q: What is the cheapest first step when the database is slow?
A: Find the slow queries (pg_stat_statements, EXPLAIN ANALYZE), add the right indexes and fix N+1 queries — before caches or replicas.
Q: 301 vs 302 redirect?
A: 301 is permanent and cached by browsers (they stop asking you). 302/307 is temporary, so every visit hits your server (useful for analytics or changeable targets).
Q: What does "p95 latency < 300 ms" mean?
A: 95% of requests complete in under 300 ms. Percentiles reveal tail latency that averages hide.
Q: What does 99.9% availability allow?
A: About 43 minutes of downtime per month (8.8 hours per year).
Q: When is Kafka a better choice than a classic queue?
A: When you need a durable, replayable event log with very high throughput and multiple independent consumers (analytics, event sourcing, streaming).
Q: Why "202 Accepted" for long-running operations?
A: It tells the client the work was queued, not done. Return a job id/location to poll, or push completion via SignalR/WebSocket.
Q: What's the danger of retries at every layer?
A: Retry amplification: retries multiply (3 × 3 × 3 = 27 calls) and can turn a small outage into a big one. Retry at one layer with backoff, jitter and a cap.
:::

:::cards id=pro-07-cards3 xp=15 title="Redis & autoscaling"
Q: Why is Redis a good place for shared counters?
A: Each command is atomic and runs in memory, so INCR from many API instances never loses an update and takes well under a millisecond.
Q: Which eviction policy for a cache, and which for queues/locks?
A: Cache: allkeys-lru (drop least recently used keys at maxmemory). Data you can't lose: noeviction, so writes fail loudly instead of keys vanishing. Ideally separate instances.
Q: Why isn't Redis your source of truth?
A: Persistence (RDB snapshots, AOF everysec) can lose recent writes, and eviction can delete keys. Keep business records in PostgreSQL; treat Redis as rebuildable.
Q: Redis Pub/Sub vs Streams?
A: Pub/Sub is fire-and-forget: offline subscribers miss messages (fine for a SignalR backplane). Streams persist entries and support consumer groups with acknowledgements (usable as a work queue).
Q: What's the catch with a Redis lock (SET NX PX)?
A: It's a lease: if the holder pauses longer than the TTL, another worker gets the lock and both run. Use it to avoid duplicate work; enforce correctness in the DB (unique constraint, optimistic concurrency, fencing token).
Q: HPA in one sentence?
A: Built-in Kubernetes controller that sets a Deployment's replicas from a metric: desired = ceil(current × currentMetric / target), usually CPU relative to requests.
Q: Why is CPU a bad scaling signal for queue workers?
A: I/O-bound workers wait on networks and APIs, so CPU stays low while the backlog grows. Scale on queue length or consumer lag instead.
Q: What does KEDA add on top of the HPA?
A: Event-source triggers (RabbitMQ, Service Bus, SQS, Kafka lag, Redis, Postgres query, Prometheus, cron) and scale to zero: KEDA handles 0 ↔ 1 itself and feeds an HPA for 1 ↔ N.
Q: What must you check before raising maxReplicaCount?
A: Downstream capacity: replicas × connection pool size vs Postgres max_connections, and rate limits of APIs the workers call.
Q: Little's law?
A: Items in progress = arrival rate × time per item. 50 jobs/s × 0.2 s = 10 concurrent workers needed just to keep up.
:::

## Recap

- Know the building blocks (CDN, load balancer/gateway, stateless API, cache, queue, DB
  replicas, partitioning) and **the cost of each**.
- Horizontal scaling needs **stateless** instances: sessions, files, locks and timers must move
  out of process.
- Cache with **cache-aside**, short TTLs and stampede protection — but fix slow queries first.
- Queues give decoupling and resilience; design for **at-least-once delivery** with idempotent
  consumers, DLQs and the outbox pattern.
- **Redis** is the shared fast state for stateless instances (cache, counters, backplane, short
  locks). It's bounded by RAM, lossy on crash and not your source of truth.
- Autoscale on the signal that tracks load: **HPA** on CPU for APIs, **KEDA** on queue length or
  lag for workers (down to zero). Always cap replicas by what the database can take.
- Scale Postgres in order: queries → pooling → bigger box → cache → replicas → partitioning →
  sharding.
- CAP in plain words: during failures choose correct-or-error vs answer-maybe-stale, per feature.
- Rate limit with token buckets, return `429` + `Retry-After`, and back off with jitter.
- In a design discussion: requirements → estimates → diagram → data model → deep dives →
  failures and trade-offs.
