---
id: be-16
title: Background Jobs & Durable Queues
level: advanced
minutes: 90
xp: 150
summary: BackgroundService and Channels, then durable job queues that survive crashes — Postgres FOR UPDATE SKIP LOCKED and Redis LMOVE + leases, at-least-once delivery, idempotency, retries, dead letters, graceful shutdown.
---

Some work doesn't belong in an HTTP request. Sending the "you were invited" email, rendering a
PDF export, resizing an uploaded image, calling a slow partner webhook, recalculating a quota:
if the request waits for these, users wait, timeouts happen, and a flaky SMTP server turns into
a 500 on your "invite member" button.

So you hand the work to a **background job**. That sounds simple, until you ask the questions a
production system has to answer:

- What happens to queued work when the process **restarts** or is redeployed?
- What if the worker **crashes halfway** through a job?
- With **three instances** of the API, which one runs the job — and does it run three times?
- What if the job **fails**? How often do we retry, how fast, and when do we give up?
- How do we **shut down** without losing or corrupting in-flight work?

This lesson climbs from in-process tools (`BackgroundService`, `Channel<T>`) to durable queues in
PostgreSQL and Redis that answer every one of those questions.

## BackgroundService: long-running work in the host

ASP.NET Core and Worker Service apps run on the **Generic Host**: the object that owns DI,
configuration, logging and the app's lifetime (start, run, graceful stop). Kestrel itself is just
one service the host starts. Anything registered as an `IHostedService` is started with the host
and stopped when it shuts down:

```csharp
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

For a loop that runs for the app's lifetime, derive from **`BackgroundService`** and implement
`ExecuteAsync`. The `stoppingToken` is cancelled when the host begins shutting down:

```csharp
public sealed class QuotaRecalculator(IServiceScopeFactory scopes, TimeProvider time,
    ILogger<QuotaRecalculator> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5), time);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();           // fresh DbContext per run
                var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
                await RecalculateAsync(db, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Quota recalculation failed");          // log and keep looping
            }
        }
    }
}

builder.Services.AddSingleton(TimeProvider.System);   // not registered by default; fake it in tests
builder.Services.AddHostedService<QuotaRecalculator>();
```

Why `PeriodicTimer` rather than `while (true) { work; await Task.Delay(5 min); }`? The timer ticks on
a fixed schedule instead of drifting by however long the work took, ticks missed while you were
busy are coalesced into a single pending tick (so runs never overlap or pile up), and with an injected `TimeProvider`
a test can advance time with `FakeTimeProvider` instead of waiting five minutes.

Three rules hide in that snippet:

1. **Hosted services are singletons.** `AppDbContext` is scoped, so you can't inject it into the
   constructor. Inject `IServiceScopeFactory` and create a scope **per unit of work**, exactly
   like ASP.NET Core does per request.
2. **An unhandled exception in `ExecuteAsync` stops the whole host** (the default since .NET 6,
   `BackgroundServiceExceptionBehavior.StopHost`). That's deliberate — a silently dead worker is
   worse than a crash your orchestrator restarts — but it means a loop must catch per iteration.
3. **Honor the token.** Pass `stoppingToken` to every async call. When the host stops, it waits
   up to `HostOptions.ShutdownTimeout` (30 s by default) for `ExecuteAsync` to finish.

:::info title=".NET 10 detail"
Up to .NET 9, the synchronous part of `ExecuteAsync` (everything before the first real `await`)
ran on the startup thread and could delay app start. Since .NET 10, `BackgroundService` runs the
whole of `ExecuteAsync` as a background task, so a long synchronous prologue no longer blocks
startup — but don't rely on that to hide blocking code.
:::

:::quiz id=be-16-q1 xp=15
What happens when this worker hits a bad row on day 3?

```csharp
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        await ProcessNextBatchAsync(stoppingToken);   // throws FormatException on a bad row
        await Task.Delay(1000, stoppingToken);
    }
}
```
- [ ] The exception is logged and the loop continues with the next iteration
- [ ] Only this hosted service stops; the API keeps serving requests normally
- [x] The exception escapes `ExecuteAsync`, it is logged, and the host shuts down (the default `BackgroundServiceExceptionBehavior.StopHost`)
- [ ] Nothing — exceptions in background tasks are unobserved and silently ignored
> Since .NET 6 an unhandled exception in a `BackgroundService` stops the host, so the failure is loud (your orchestrator restarts the pod). "Only this service stops" was the behaviour **before** .NET 6 and is still available as `BackgroundServiceExceptionBehavior.Ignore`, but it's the worst outcome: a dead worker inside a pod whose health checks look fine. The loop also doesn't "continue", because nothing in this code catches the exception. Wrap each iteration in try/catch, log, and keep going, or decide deliberately that a failure should crash the process.
:::

:::quiz id=be-16-q2 xp=10
```csharp
public sealed class Cleanup(AppDbContext db) : BackgroundService { /* ... */ }
builder.Services.AddDbContext<AppDbContext>(...);
builder.Services.AddHostedService<Cleanup>();
```
What happens when you run this in the Development environment?
- [ ] It works; EF Core makes the context thread-safe for hosted services
- [x] Startup fails: a singleton (the hosted service) can't consume a scoped service; inject `IServiceScopeFactory` and create a scope per unit of work
- [ ] The DbContext is recreated automatically for every loop iteration
- [ ] It compiles but `db` is always `null`
> Scope validation (on by default in Development) throws `Cannot consume scoped service 'AppDbContext' from singleton`. EF Core never makes a `DbContext` thread-safe, and DI doesn't recreate constructor dependencies per loop iteration. Without validation (e.g. in Production) the app would start and you'd get a *captive dependency*: one DbContext living forever, growing its change tracker and failing when used concurrently.
:::

## Channels: an in-process queue with backpressure

`System.Threading.Channels` gives you a fast, async producer/consumer queue. A classic use: the
endpoint drops a message into a channel and returns immediately; a `BackgroundService` drains it.

```csharp
public sealed record ThumbnailRequest(Guid DocumentId);

// Program.cs
builder.Services.AddSingleton(Channel.CreateBounded<ThumbnailRequest>(new BoundedChannelOptions(500)
{
    FullMode = BoundedChannelFullMode.Wait,   // producers wait when full = backpressure
    SingleReader = true,
}));
builder.Services.AddHostedService<ThumbnailWorker>();

app.MapPost("/documents/{id:guid}/thumbnail", async (Guid id, Channel<ThumbnailRequest> ch, CancellationToken ct) =>
{
    await ch.Writer.WriteAsync(new ThumbnailRequest(id), ct);
    return Results.Accepted();
});

public sealed class ThumbnailWorker(Channel<ThumbnailRequest> ch, IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var req in ch.Reader.ReadAllAsync(stoppingToken))
        {
            await using var scope = scopes.CreateAsyncScope();
            // ... render and store the thumbnail; catch per item ...
        }
    }
}
```

**Bounded vs unbounded matters.** An unbounded channel under load grows until the process runs
out of memory. A bounded channel with `FullMode.Wait` pushes back: `WriteAsync` waits until
there's room, which slows producers down instead of killing the process. (`DropOldest`,
`DropNewest`, `DropWrite` exist for telemetry-style data you can afford to lose.)

The hard limit: **a channel lives in memory.** Deploy, crash or scale down and everything in it
is gone. Each API instance also has its *own* channel, so work isn't shared across instances.
Channels are great for buffering, batching and smoothing spikes of best-effort work. For
anything a user or the business would notice going missing, you need a **durable** queue.

:::quiz id=be-16-q3 xp=10
A bounded channel (capacity 100, `FullMode = Wait`) is full because the consumer is slow. What
does the 101st `await channel.Writer.WriteAsync(item, ct)` do?
- [ ] Throws `ChannelClosedException`
- [ ] Silently drops the item
- [x] Waits asynchronously until the consumer frees a slot (or `ct` is cancelled), slowing the producer down
- [ ] Grows the channel to 200 items
> That's backpressure: the queue's limit propagates back to the producer. Dropping only happens if you opt into a `Drop*` mode, `ChannelClosedException` only after someone calls `Writer.Complete()`, and a bounded channel never grows. In an HTTP endpoint you might combine `Wait` with a timeout (or use `TryWrite`) and return 503 rather than letting requests pile up.
:::

## Durable queues: the requirements

A durable job queue needs to guarantee:

1. **Persistence** — a job, once enqueued, survives process restarts.
2. **Exclusive claims** — with N workers, each job is handed to one worker at a time.
3. **Crash recovery** — if a worker dies mid-job, the job becomes available again. This is
   done with a **lease** (also called visibility timeout): a claim is valid until a deadline; an
   expired claim can be taken over.
4. **Retries with backoff** and a **dead-letter** state for jobs that keep failing.

Requirement 3 forces a fundamental trade-off. When a worker's lease expires, the queue can't tell
whether the worker died before or after doing the work. Either the job may run **twice**, or it may
run **zero** times. Production systems choose **at-least-once delivery**, and make the
**handlers idempotent** so running twice does no harm. "Exactly once" end-to-end is not something
a queue can give you; you build it from at-least-once plus idempotency.

## Option A: PostgreSQL as the queue — `FOR UPDATE SKIP LOCKED`

You already run Postgres. A table can be a perfectly good job queue for thousands of jobs per
second, with one superpower no external broker has: **you can enqueue in the same transaction as
your business change.** The "project created" row and the "send welcome email" job commit
together or not at all; there's no "saved but the message was lost" gap (the problem the
*transactional outbox* pattern solves for external brokers).

```sql
CREATE TABLE jobs (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type         text        NOT NULL,
    payload      jsonb       NOT NULL,
    status       text        NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'running', 'done', 'dead')),
    attempts     int         NOT NULL DEFAULT 0,
    max_attempts int         NOT NULL DEFAULT 5,
    run_after    timestamptz NOT NULL DEFAULT now(),
    locked_until timestamptz,          -- the lease deadline
    locked_by    text,                 -- which worker holds the lease
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claimable_idx ON jobs (run_after, id) WHERE status IN ('queued', 'running');
```

### The claim query

```sql
UPDATE jobs
   SET status = 'running',
       attempts = attempts + 1,
       locked_by = $1,                       -- worker id
       locked_until = now() + $2             -- lease, e.g. interval '30 seconds'
 WHERE id = (
       SELECT id FROM jobs
        WHERE (status = 'queued'  AND run_after <= now())
           OR (status = 'running' AND locked_until < now())   -- lease expired: worker died
        ORDER BY run_after, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
RETURNING id, type, payload::text, attempts, max_attempts;
```

Read it from the inside out:

- The subquery finds the oldest **claimable** job: queued and due, or "running" with an
  **expired lease**, which is how crashed workers' jobs come back.
- **`FOR UPDATE`** row-locks the candidate so two transactions can't both update it.
- **`SKIP LOCKED`** is the key: if another worker has already locked that row, *skip it and take
  the next one* instead of waiting. Without it, every worker would wait on whichever row the first
  one locked. In this lease design that wait is only as long as the claim statement, but it still
  serializes claims under load. In the hold-the-transaction variant below, the wait lasts the
  whole job, and N workers end up processing one job at a time (see the quiz).
- The whole statement is **one short transaction**. The lock is released at commit; from then on
  the **lease columns** (`locked_by`, `locked_until`) represent ownership, not a held lock.

Then completion and failure are **fenced** by the worker id:

```sql
-- complete: only the current lease holder may do this
UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL
 WHERE id = $1 AND locked_by = $2 AND status = 'running';

-- fail: retry later with backoff, or dead-letter when attempts are used up
UPDATE jobs
   SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
       run_after = now() + $3, last_error = $4, locked_by = NULL, locked_until = NULL
 WHERE id = $1 AND locked_by = $2 AND status = 'running';
```

The `locked_by = $2` condition handles the **zombie worker**: a worker that stalled (GC pause,
network partition) past its lease, while another worker reclaimed and finished the job. When the
zombie wakes up and tries to complete, zero rows match, it learns it lost the lease, and it
doesn't overwrite the newer state.

:::info title="Alternative: hold the transaction for the whole job"
A simpler variant claims with `SELECT ... FOR UPDATE SKIP LOCKED` and keeps the transaction open
while the job runs, committing the `done` update at the end. If the worker dies, Postgres aborts
the transaction and releases the lock automatically, so no lease columns are needed. The cost:
one open transaction and pooled connection per in-flight job, and long transactions hold back
`VACUUM`. Fine for short jobs and few workers; the lease approach scales better and lets jobs run
for minutes.
:::

:::quiz id=be-16-q4 xp=15
Four workers run this "hold the transaction" job loop concurrently, **without** `SKIP LOCKED`,
against a table with 100 queued jobs. What do you observe?

```sql
BEGIN;
SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1 FOR UPDATE;
-- process the job (~2 s) while holding the transaction, then:
UPDATE jobs SET status = 'done' WHERE id = ...;
COMMIT;
```
- [ ] Each worker gets a different job, just like with `SKIP LOCKED`
- [x] All four target the same oldest row; three block on its lock for the whole job, then move on to the next row and block behind each other again, so throughput collapses to roughly one worker
- [ ] PostgreSQL raises a deadlock error immediately
- [ ] Two workers process the same job at the same time
> `FOR UPDATE` alone means "wait for the lock". There's no deadlock (each worker waits for one row at a time, so there's no cycle) and no double processing (the lock does serialize them); the problem is pure throughput. When the first worker commits, the waiters re-check the row, see it's no longer `queued`, and go on to the next row, where they queue up behind whichever waiter got there first. `SKIP LOCKED` lets each worker skip rows others hold and grab the next free one, which is what turns a table into a concurrent queue.
:::

### Polling, LISTEN/NOTIFY and housekeeping

Workers poll (e.g. every second) when the queue is empty. To cut latency, the producer can run
`NOTIFY jobs_ready` after enqueueing, and idle workers `LISTEN jobs_ready` to wake up
immediately; keep the poll as a fallback because notifications aren't durable. Also plan for:

- **Cleanup** — delete or archive `done` rows after N days (a nightly job, or partition by month
  and drop old partitions). A queue table that grows forever slows the claim query.
- **Indexes** — the partial index on claimable rows keeps the claim fast no matter how many
  `done` rows exist.
- **Long jobs** — extend the lease with a heartbeat
  (`UPDATE jobs SET locked_until = now() + $2 WHERE id = $1 AND locked_by = $3`) every lease/3.

## Option B: Redis lists — LMOVE + lease keys

Redis is a common choice when jobs are high-volume and you already run it for caching or the
SignalR backplane. The naive version is broken:

```text
LPUSH jobs:queue <job>       # producer
RPOP  jobs:queue             # worker — job is now ONLY in the worker's memory
```

If the worker crashes after `RPOP`, the job is gone. The reliable-queue pattern instead **moves**
the job atomically into a processing list, so it always exists somewhere in Redis:

```text
LMOVE jobs:queue jobs:processing RIGHT LEFT       # atomic pop + push (RPOPLPUSH before Redis 6.2)
SET   jobs:lease:{id} <workerId> PX 30000          # lease with a TTL
... do the work ...
LREM  jobs:processing 1 <job>                      # done: remove from processing
DEL   jobs:lease:{id}
```

A **reaper** (any worker, every few seconds) scans `jobs:processing`. Any job whose lease key has
**expired** belonged to a dead worker and goes back on the queue. Doing the check-and-move in a
Lua script makes it atomic, so two reapers can't requeue the same job twice:

```csharp
// StackExchange.Redis
const string Claim = """
    local job = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
    if job then
      local id = cjson.decode(job)['id']
      redis.call('SET', 'jobs:lease:' .. id, ARGV[1], 'PX', ARGV[2])
    end
    return job
    """;

const string Requeue = """
    if redis.call('EXISTS', KEYS[3]) == 0 and redis.call('LREM', KEYS[2], 1, ARGV[1]) == 1 then
      redis.call('RPUSH', KEYS[1], ARGV[1])      -- back to the front of the line
      return 1
    end
    return 0
    """;

var job = await redis.ScriptEvaluateAsync(Claim,
    keys: ["jobs:queue", "jobs:processing"], values: [workerId, 30_000]);

// reaper, for each item in LRANGE jobs:processing 0 -1:
await redis.ScriptEvaluateAsync(Requeue,
    keys: ["jobs:queue", "jobs:processing", $"jobs:lease:{id}"], values: [item]);
```

Why a script for the claim? If the worker died between `LMOVE` and `SET`, the job would sit in
`processing` with no lease, and a reaper would requeue it at once, which is harmless but would
double-process a job that was actually fine. Doing both in one script removes the gap. (The claim
script builds the lease key name itself, which works on a single Redis node. Redis Cluster
requires every key a script touches to be passed in `KEYS` and to hash to the same slot, so there
you'd use a hash tag such as `{jobs}:queue` and keep leases in one `{jobs}:leases` sorted set
scored by expiry.)

Two practical notes:

- **StackExchange.Redis doesn't support blocking commands** (`BLMOVE`, `BRPOP`) because it
  multiplexes one connection for everything. Use the non-blocking command plus a short poll.
- **Redis Streams** (`XADD`, `XREADGROUP`, `XACK`, `XAUTOCLAIM`) build this pattern in: consumer
  groups, a pending-entries list per consumer, and claiming idle messages. For new Redis-based
  queues, Streams are often the better primitive.

:::quiz id=be-16-q5 xp=15
Why does the reliable Redis queue use `LMOVE jobs:queue jobs:processing` instead of `RPOP jobs:queue`?
- [ ] `LMOVE` is faster than `RPOP`
- [x] So the job is never only in a worker's memory: if the worker crashes, the job is still in `jobs:processing` and a reaper can requeue it once its lease expires
- [ ] `RPOP` can return the same job to two workers
- [ ] `RPOP` was removed in Redis 7
> `RPOP` is atomic too, so two workers never get the same item. The problem is durability: after the pop, the job exists only in process memory. Moving it to a processing list (plus a lease key with a TTL) keeps a record until the worker explicitly acknowledges it.
:::

### Postgres or Redis?

| | PostgreSQL `SKIP LOCKED` | Redis lists / streams |
|---|---|---|
| Enqueue atomically with business data | **Yes**, same transaction | No (needs an outbox) |
| Durability | WAL, backups, replicas | Depends on AOF/RDB config; failover can lose recent writes |
| Throughput | Thousands/s, fine for most SaaS | Much higher |
| Delayed jobs, retries, queries ("show failed jobs for project X") | Plain SQL | Extra structures (sorted sets) |
| Ops cost | Nothing new | Another critical component (if you don't run it already) |

A common recommendation: **start with Postgres**. Move to Redis/Streams, RabbitMQ, or a cloud
queue (SQS, Azure Service Bus) when you measure that you need it. Libraries such as
**Hangfire**, **Quartz.NET**, **MassTransit** or **Wolverine** package these patterns (dashboards,
cron schedules, sagas); building your own, as in the lab, is how you learn what they do for you.

:::info title="Jobs inside one service vs messages between services"
This lesson is about **one service** queueing work for itself. When *other* services need to react
("project created" → billing, search, email), you publish **messages** to a broker instead, and the
"saved, but the message was lost" gap comes back. The Cloud-Native Toolkit lesson
**Message Brokers & the Outbox Pattern** picks up exactly here: queues vs logs, RabbitMQ vs Kafka vs
Redis Streams vs a Postgres queue, the transactional outbox and its relay, idempotent consumers,
dead-letter queues and versioned message contracts. The idempotency and retry rules below carry over
unchanged.
:::

## At-least-once means idempotent handlers

A job *will* sometimes run twice: a lease expired during a GC pause, a worker crashed after
sending the email but before marking the job done, a deploy killed the pod mid-job. Design every
handler so the second run is harmless:

- **Naturally idempotent operations**: "set status to archived", upserts
  (`INSERT ... ON CONFLICT DO UPDATE`), "recalculate the quota from scratch". Running them twice
  gives the same result.
- **Dedup records**: insert a row into `processed_jobs(job_id)` (primary key) **in the same
  transaction** as the job's database effect. The second run hits the unique violation and stops.
- **External side effects** (emails, payments, webhooks): pass an **idempotency key** derived from
  the job (`job-{id}`) to the provider, or record "email sent for invite X" before/with the send
  and check it first. You can't roll back an email, so you reduce the duplicate window as far as
  possible and make duplicates detectable.

```csharp
public async Task HandleAsync(Job job, CancellationToken ct)
{
    var p = JsonSerializer.Deserialize<InviteEmailPayload>(job.Payload)!;
    var key = $"invite:{p.InviteId}";
    await using var tx = await db.Database.BeginTransactionAsync(ct);

    db.SentEmails.Add(new SentEmail { Key = key, SentAt = time.GetUtcNow() });   // Key = primary key
    try
    {
        await db.SaveChangesAsync(ct);
    }
    catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
    {
        return;   // a previous run already sent it: treat the duplicate as SUCCESS, not as a failure
    }

    // If this throws, the transaction rolls back and the dedup row disappears, so a retry can send.
    await email.SendAsync(p.To, "You're invited", body, idempotencyKey: key, ct);
    await tx.CommitAsync(ct);
}
```

Two details that are easy to get wrong:

- **A duplicate is a success.** If the second run lets the unique-violation exception escape, the
  worker records a *failure*, retries with backoff, and finally dead-letters a job that was done
  all along. Catch it and return normally so the job is completed.
- **The crash window doesn't fully close.** If the process dies after `SendAsync` but before
  `CommitAsync`, the dedup row is rolled back and the next run sends again. That's why the
  provider's idempotency key matters too. Keep this transaction short: it's held open during one
  outbound call, which is acceptable for a fast email API but not for a multi-second one.

:::quiz id=be-16-q6 xp=15
A worker sends a "you were invited" email and then crashes **before** `CompleteAsync`. The lease
expires and another worker runs the job again. Which change actually prevents a duplicate email
in the common case?
- [ ] Increase the lease from 30 s to 10 minutes so jobs are never reclaimed
- [ ] Set `max_attempts = 1` so failed jobs are never retried
- [x] Make the handler idempotent: record a dedup key for the invite (unique constraint) and pass it as an idempotency key to the email provider
- [ ] Switch from Postgres to Redis, which has exactly-once delivery
> Longer leases only delay recovery, and `max_attempts = 1` turns every transient failure into lost work. No queue provides exactly-once side effects; the handler must recognise "I already did this" (dedup row, idempotency key on the provider's API).
:::

## Retries, backoff and dead letters

When a job fails, retry it, but not immediately and not forever:

- **Exponential backoff**: wait `base × 2^(attempt−1)`, capped (1 s, 2 s, 4 s, … max 5 min). A
  downstream service that is struggling gets breathing room.
- **Jitter**: randomize the wait. Without it, 1,000 jobs that failed together during an outage
  retry together and cause a thundering herd. **Full jitter**, `random(0, min(cap, base × 2^(n−1)))`,
  spreads them evenly.
- **Max attempts → dead letter**: after N attempts, set `status = 'dead'`, keep `last_error`, and
  **alert**. A dead-letter queue (DLQ) nobody looks at is a black hole; give operators a way to
  inspect and replay (`UPDATE jobs SET status='queued', attempts=0 WHERE id=...`).
- **Don't retry permanent errors.** A 400 from a partner API, a payload that fails validation, or
  a missing project won't fix themselves. Dead-letter them immediately and retry only transient
  failures (timeouts, 5xx, 429, deadlocks, connection resets).

:::challenge id=be-16-c1 lang=ts xp=40
title: Full-jitter backoff
Implement `backoffDelay(attempt, baseMs, capMs, random)` using **full jitter**:

`delay = floor(random() * min(capMs, baseMs * 2^(attempt - 1)))`

- `attempt` starts at 1; throw an `Error` for `attempt < 1`.
- `random` is injected (returns a number in `[0, 1)`) so the function is testable.
- Large attempts must not overflow to `Infinity`/`NaN`: the cap must still apply.

hint: Compute the exponential ceiling first, then clamp with `Math.min`.
hint: `2 ** 2000` is `Infinity` in JS; `Math.min(capMs, Infinity)` is still `capMs`, but `0 * Infinity` is `NaN`, so clamp *before* multiplying by `random()`.

```ts starter
export function backoffDelay(attempt: number, baseMs: number, capMs: number, random: () => number): number {
  return baseMs * attempt
}
```

```ts solution
export function backoffDelay(attempt: number, baseMs: number, capMs: number, random: () => number): number {
  if (attempt < 1) throw new Error('attempt must be >= 1')
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1))
  return Math.floor(random() * ceiling)
}
```

```ts tests
test('max random gives the exponential ceiling', () => {
  const almostOne = () => 0.999999
  expect(backoffDelay(1, 1000, 60000, almostOne)).toBe(999)
  expect(backoffDelay(3, 1000, 60000, almostOne)).toBe(3999)
})
test('random 0 gives 0', () => {
  expect(backoffDelay(5, 1000, 60000, () => 0)).toBe(0)
})
test('half random is half the ceiling', () => {
  expect(backoffDelay(4, 100, 60000, () => 0.5)).toBe(400)
})
test('cap applies', () => {
  expect(backoffDelay(10, 1000, 30000, () => 0.5)).toBe(15000)
})
test('huge attempts do not overflow', () => {
  const d = backoffDelay(5000, 1000, 30000, () => 0.5)
  expect(Number.isFinite(d)).toBe(true)
  expect(d).toBe(15000)
})
test('rejects attempt 0', () => {
  expect(() => backoffDelay(0, 1000, 30000, () => 0.5)).toThrow()
})
```
:::

## Graceful shutdown

Kubernetes sends `SIGTERM`, waits `terminationGracePeriodSeconds` (30 s by default), then
`SIGKILL`s. .NET translates `SIGTERM` into host shutdown: `stoppingToken` is cancelled and
`StopAsync` waits up to `HostOptions.ShutdownTimeout` (30 s by default). A well-behaved worker:

1. **Stops claiming** new jobs as soon as the token is cancelled.
2. For the in-flight job, either **finishes** it (if it's short) or **releases** it immediately
   (set it back to `queued`), so another instance can pick it up without waiting for the lease
   to expire. A release is not a failure: don't count it as an attempt and don't apply backoff,
   or a deploy that happens during a job's last attempt dead-letters a perfectly healthy job.
3. Sets `ShutdownTimeout` **below** the pod's grace period, so .NET finishes cleanly before the
   `SIGKILL`.

```csharp
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(25));
```

And if the process is killed anyway (OOM, node failure)? That's what leases are for: the job
reappears after `locked_until` and runs again. Graceful shutdown makes recovery *faster*; leases
make it *correct*.

:::quiz id=be-16-q7 xp=15
A job takes ~2 minutes. The pod gets `SIGTERM` during a deploy, `ShutdownTimeout` is 25 s, and the
handler honors the cancellation token. The worker's catch block for cancellation **does not**
release the job. What happens to the job?
- [ ] It's lost, because the worker that claimed it is gone
- [ ] It's marked `done` because the host stopped gracefully
- [x] It stays `running` until its lease expires, then another worker reclaims it and runs it again from the start
- [ ] Kubernetes waits for the job to finish before killing the pod
> The lease guarantees recovery but costs latency: up to one lease duration. Kubernetes knows nothing about your jobs; it sends `SIGKILL` once the grace period is over, and a host that stopped "gracefully" only means `ExecuteAsync` returned, not that the job finished. Releasing the job on cancellation (status back to `queued`) lets a new pod pick it up immediately. Either way the job runs again, so the handler must be idempotent and, for long jobs, ideally resumable via checkpoints.
:::

## Scaling workers

- **Separate the worker from the API.** `dotnet new worker` creates a host without Kestrel. Deploy
  it as its own Deployment so a flood of jobs can't starve HTTP requests of CPU, and scale the two
  independently. The same image with a different entry point or flag works too.
- **Scale horizontally.** `SKIP LOCKED` and leases mean you can run 1 or 20 replicas with no
  coordination. Watch the database connection count: each worker holds pooled connections.
- **Scale on queue depth.** CPU is a poor signal for I/O-bound workers. **KEDA** (Kubernetes
  Event-Driven Autoscaling) scales a Deployment from a metric such as a PostgreSQL query
  (`SELECT count(*) FROM jobs WHERE status='queued' AND run_after <= now()`) or a Redis list's
  length, including **scale to zero** when the queue is empty.
- **Concurrency per worker.** Run several claim loops per process (`Parallel` workers or N
  `Task`s) for I/O-bound jobs; keep it at 1 for CPU-heavy ones and scale replicas instead.

:::job title="Background jobs on the job"
In a real codebase you'll meet a jobs table or a library like Hangfire/MassTransit, a separate
worker deployment, a dashboard or SQL query for failed jobs, and an on-call alert on "dead jobs >
0" or "oldest queued job older than 5 minutes". Expect code review questions like: *What happens
if this runs twice? What if it fails halfway? Is the enqueue in the same transaction as the
write?* Have an answer for each.
:::

:::pro title="Fairness and quotas"
In a multi-tenant SaaS, one customer enqueuing 100,000 exports can starve everyone else. Senior
teams add per-tenant fairness (claim round-robin across `owner_id`, or cap running jobs per
tenant with a `count(*) ... FILTER` in the claim query), charge jobs against the **project owner's**
quota at enqueue time, and give interactive work (an invite email) a higher priority than bulk work
(nightly reindex) via a `priority` column in the `ORDER BY`.
:::

## Challenge: simulate leases

:::challenge id=be-16-c2 lang=ts xp=60
title: A lease-based job queue
Implement an in-memory `LeaseQueue` that behaves like the Postgres/Redis queues above. Time is
passed in explicitly (`now`, in ms) so it's testable.

- `enqueue(id)` adds a job at the back.
- `claim(worker, now)` returns the id of the **oldest** job that is either unclaimed or whose
  lease has **expired** (`now >= leaseUntil`), gives `worker` a lease until `now + leaseMs`,
  increments that job's attempt count, and returns the id. Returns `null` if nothing is claimable.
  A claimed job stays in the queue until completed; it must not be handed to anyone else while
  its lease is valid.
- `complete(id, worker)` removes the job and returns `true` **only if** `worker` is the job's
  current owner (the last worker that claimed it, even if its lease has run out but nobody has
  reclaimed it yet, just like `WHERE locked_by = $2` in Postgres); otherwise it returns `false`
  (fencing: a zombie worker can't complete a job someone else reclaimed). Unknown or already
  completed ids also return `false`.
- `attempts(id)` returns how many times the job was claimed (0 if unknown).

hint: Store `{ id, owner, leaseUntil, attempts }` per job in an array (FIFO order).
hint: A job is claimable when `owner === null || now >= leaseUntil`.

```ts starter
export class LeaseQueue {
  private items: string[] = []
  constructor(private leaseMs: number) {}
  enqueue(id: string) { this.items.push(id) }
  claim(worker: string, now: number): string | null {
    return this.items.shift() ?? null // like RPOP: lost if the worker crashes!
  }
  complete(id: string, worker: string): boolean { return true }
  attempts(id: string): number { return 0 }
}
```

```ts solution
export class LeaseQueue {
  private jobs: { id: string; owner: string | null; leaseUntil: number; attempts: number }[] = []
  private leaseMs: number
  constructor(leaseMs: number) { this.leaseMs = leaseMs }
  enqueue(id: string) { this.jobs.push({ id, owner: null, leaseUntil: 0, attempts: 0 }) }
  claim(worker: string, now: number): string | null {
    const job = this.jobs.find((j) => j.owner === null || now >= j.leaseUntil)
    if (!job) return null
    job.owner = worker
    job.leaseUntil = now + this.leaseMs
    job.attempts++
    return job.id
  }
  complete(id: string, worker: string): boolean {
    const i = this.jobs.findIndex((j) => j.id === id)
    if (i < 0 || this.jobs[i].owner !== worker) return false
    this.jobs.splice(i, 1)
    return true
  }
  attempts(id: string): number {
    return this.jobs.find((j) => j.id === id)?.attempts ?? 0
  }
}
```

```ts tests
test('claims oldest first and never hands out a leased job twice', () => {
  const q = new LeaseQueue(1000)
  q.enqueue('a'); q.enqueue('b')
  expect(q.claim('w1', 0)).toBe('a')
  expect(q.claim('w2', 10)).toBe('b')
  expect(q.claim('w3', 20)).toBeNull()
})
test('an expired lease is reclaimed by another worker', () => {
  const q = new LeaseQueue(1000)
  q.enqueue('a')
  expect(q.claim('crashy', 0)).toBe('a')
  expect(q.claim('healthy', 999)).toBeNull()
  expect(q.claim('healthy', 1000)).toBe('a')
  expect(q.attempts('a')).toBe(2)
})
test('zombie worker cannot complete a reclaimed job', () => {
  const q = new LeaseQueue(1000)
  q.enqueue('a')
  q.claim('crashy', 0)
  q.claim('healthy', 5000)
  expect(q.complete('a', 'crashy')).toBe(false)
  expect(q.complete('a', 'healthy')).toBe(true)
  expect(q.claim('anyone', 99999)).toBeNull()
})
test('completed jobs are gone; unknown ids are rejected', () => {
  const q = new LeaseQueue(1000)
  q.enqueue('a'); q.enqueue('b')
  q.claim('w1', 0)
  expect(q.complete('a', 'w1')).toBe(true)
  expect(q.complete('a', 'w1')).toBe(false)
  expect(q.complete('nope', 'w1')).toBe(false)
  expect(q.claim('w1', 1)).toBe('b')
})
test('a crashed job is not lost', () => {
  const q = new LeaseQueue(500)
  q.enqueue('a')
  q.claim('w1', 0)          // w1 crashes, never completes
  expect(q.claim('w2', 600)).toBe('a')
})
test('attempts of unknown job is 0', () => {
  const q = new LeaseQueue(500)
  expect(q.attempts('x')).toBe(0)
})
```
:::

## Lab: a crash-proof Postgres job queue

:::lab id=be-16-lab1 xp=150
title: Build and prove a SKIP LOCKED job queue

You'll implement the Postgres queue from this lesson (claim with `FOR UPDATE SKIP LOCKED`,
leases, fenced completion, backoff, dead letters, release on shutdown), a `BackgroundService`
worker, and tests against **PostgreSQL 18 in Testcontainers** that prove: 8 concurrent workers
never double-claim, a crashed worker's job is recovered, zombies are fenced out, released jobs
come straight back, and failing jobs end up dead-lettered.

**Prerequisites:** .NET 10 SDK, Docker (or Podman with `DOCKER_HOST`, see be-15).

**1. Scaffold:**

```bash
mkdir -p ~/devquest/be-16-lab1 && cd ~/devquest/be-16-lab1
dotnet new sln -n Jobs
dotnet new classlib -o src/Jobs
dotnet new xunit -o tests/Jobs.Tests
dotnet sln add src/Jobs tests/Jobs.Tests
dotnet add tests/Jobs.Tests reference src/Jobs
dotnet add src/Jobs package Npgsql
dotnet add src/Jobs package Microsoft.Extensions.Hosting.Abstractions
dotnet add tests/Jobs.Tests package Testcontainers.PostgreSql
dotnet add tests/Jobs.Tests package Shouldly
rm src/Jobs/Class1.cs tests/Jobs.Tests/UnitTest1.cs
```

**2. Backoff with full jitter.**

`src/Jobs/Backoff.cs`

```csharp
namespace Jobs;

public static class Backoff
{
    /// "Full jitter": a random delay between 0 and min(cap, base * 2^(attempt-1)).
    /// Randomness spreads retries out so failed jobs don't all hit the database again at once.
    public static TimeSpan Compute(int attempt, TimeSpan baseDelay, TimeSpan cap, Random random)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(attempt, 1);
        var exp = baseDelay.TotalMilliseconds * Math.Pow(2, Math.Min(attempt - 1, 30));
        var ceiling = Math.Min(cap.TotalMilliseconds, exp);
        return TimeSpan.FromMilliseconds(random.NextDouble() * ceiling);
    }
}
```

**3. The queue.** Npgsql's `NpgsqlDataSource` owns the connection pool; `$1, $2…` are positional
parameters (never concatenate values into SQL). A `TimeSpan` parameter maps to a Postgres `interval`.

`src/Jobs/PgJobQueue.cs`

```csharp
using System.Text.Json;
using Npgsql;
using NpgsqlTypes;

namespace Jobs;

public sealed record Job(long Id, string Type, string Payload, int Attempts, int MaxAttempts);

public sealed class PgJobQueue(NpgsqlDataSource db)
{
    public async Task EnsureSchemaAsync(CancellationToken ct = default)
    {
        const string sql = """
            CREATE TABLE IF NOT EXISTS jobs (
                id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                type         text        NOT NULL,
                payload      jsonb       NOT NULL,
                status       text        NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued', 'running', 'done', 'dead')),
                attempts     int         NOT NULL DEFAULT 0,
                max_attempts int         NOT NULL DEFAULT 5,
                run_after    timestamptz NOT NULL DEFAULT now(),
                locked_until timestamptz,
                locked_by    text,
                last_error   text,
                created_at   timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS jobs_claimable_idx
                ON jobs (run_after, id) WHERE status IN ('queued', 'running');
            """;
        await using var cmd = db.CreateCommand(sql);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<long> EnqueueAsync<T>(string type, T payload, int maxAttempts = 5, CancellationToken ct = default)
    {
        await using var cmd = db.CreateCommand(
            "INSERT INTO jobs (type, payload, max_attempts) VALUES ($1, $2, $3) RETURNING id");
        cmd.Parameters.AddWithValue(type);
        cmd.Parameters.Add(new NpgsqlParameter { Value = JsonSerializer.Serialize(payload), NpgsqlDbType = NpgsqlDbType.Jsonb });
        cmd.Parameters.AddWithValue(maxAttempts);
        return (long)(await cmd.ExecuteScalarAsync(ct))!;
    }

    /// Atomically claims ONE ready job (or a job whose lease expired because its worker died).
    public async Task<Job?> ClaimAsync(string workerId, TimeSpan lease, CancellationToken ct = default)
    {
        const string sql = """
            UPDATE jobs
               SET status = 'running',
                   attempts = attempts + 1,
                   locked_by = $1,
                   locked_until = now() + $2
             WHERE id = (
                   SELECT id FROM jobs
                    WHERE (status = 'queued'  AND run_after <= now())
                       OR (status = 'running' AND locked_until < now())
                    ORDER BY run_after, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
            RETURNING id, type, payload::text, attempts, max_attempts
            """;
        await using var cmd = db.CreateCommand(sql);
        cmd.Parameters.AddWithValue(workerId);
        cmd.Parameters.AddWithValue(lease);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new Job(r.GetInt64(0), r.GetString(1), r.GetString(2), r.GetInt32(3), r.GetInt32(4));
    }

    /// Only the current lease holder may complete. Returns false if we lost the lease.
    public async Task<bool> CompleteAsync(Job job, string workerId, CancellationToken ct = default)
    {
        await using var cmd = db.CreateCommand("""
            UPDATE jobs SET status = 'done', locked_by = NULL, locked_until = NULL
             WHERE id = $1 AND locked_by = $2 AND status = 'running'
            """);
        cmd.Parameters.AddWithValue(job.Id);
        cmd.Parameters.AddWithValue(workerId);
        return await cmd.ExecuteNonQueryAsync(ct) == 1;
    }

    /// Schedules a retry after `retryIn`, or moves the job to 'dead' when attempts are used up.
    public async Task<bool> FailAsync(Job job, string workerId, string error, TimeSpan retryIn, CancellationToken ct = default)
    {
        await using var cmd = db.CreateCommand("""
            UPDATE jobs
               SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
                   run_after = now() + $3,
                   last_error = $4,
                   locked_by = NULL,
                   locked_until = NULL
             WHERE id = $1 AND locked_by = $2 AND status = 'running'
            """);
        cmd.Parameters.AddWithValue(job.Id);
        cmd.Parameters.AddWithValue(workerId);
        cmd.Parameters.AddWithValue(retryIn);
        cmd.Parameters.AddWithValue(error);
        return await cmd.ExecuteNonQueryAsync(ct) == 1;
    }

    /// Hands a job back on graceful shutdown: claimable right away, and the interrupted attempt
    /// doesn't count (otherwise a deploy during the last attempt would dead-letter a healthy job).
    public async Task<bool> ReleaseAsync(Job job, string workerId, CancellationToken ct = default)
    {
        await using var cmd = db.CreateCommand("""
            UPDATE jobs
               SET status = 'queued',
                   attempts = GREATEST(attempts - 1, 0),
                   run_after = now(),
                   locked_by = NULL,
                   locked_until = NULL
             WHERE id = $1 AND locked_by = $2 AND status = 'running'
            """);
        cmd.Parameters.AddWithValue(job.Id);
        cmd.Parameters.AddWithValue(workerId);
        return await cmd.ExecuteNonQueryAsync(ct) == 1;
    }

    public async Task<string?> GetStatusAsync(long id, CancellationToken ct = default)
    {
        await using var cmd = db.CreateCommand("SELECT status FROM jobs WHERE id = $1");
        cmd.Parameters.AddWithValue(id);
        return (string?)await cmd.ExecuteScalarAsync(ct);
    }
}
```

**4. The worker.** Note the `CancellationToken.None` on bookkeeping calls: when shutting down
we still want to record the outcome, even though `stoppingToken` is already cancelled.

`src/Jobs/JobWorker.cs`

```csharp
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jobs;

public interface IJobHandler
{
    string Type { get; }
    Task HandleAsync(Job job, CancellationToken ct);
}

public sealed class JobWorkerOptions
{
    public string WorkerId { get; set; } = $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid():N}";
    public TimeSpan Lease { get; set; } = TimeSpan.FromSeconds(30);
    public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(1);
    public TimeSpan RetryBase { get; set; } = TimeSpan.FromSeconds(2);
    public TimeSpan RetryCap { get; set; } = TimeSpan.FromMinutes(5);
}

public sealed class JobWorker(
    PgJobQueue queue, IEnumerable<IJobHandler> handlers, JobWorkerOptions options, ILogger<JobWorker> logger)
    : BackgroundService
{
    private readonly Dictionary<string, IJobHandler> _handlers = handlers.ToDictionary(h => h.Type);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Worker {WorkerId} started", options.WorkerId);
        while (!stoppingToken.IsCancellationRequested)
        {
            Job? job;
            try
            {
                job = await queue.ClaimAsync(options.WorkerId, options.Lease, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                logger.LogError(ex, "Claim failed; backing off");   // DB down? don't spin.
                await SafeDelay(options.PollInterval, stoppingToken);
                continue;
            }

            if (job is null)
            {
                await SafeDelay(options.PollInterval, stoppingToken);   // queue empty
                continue;
            }

            await ProcessAsync(job, stoppingToken);
        }
        logger.LogInformation("Worker {WorkerId} stopped", options.WorkerId);
    }

    private async Task ProcessAsync(Job job, CancellationToken stoppingToken)
    {
        if (job.Attempts > job.MaxAttempts)
        {
            // Poison pill: the job keeps killing workers (lease expiring) — stop retrying it.
            await queue.FailAsync(job, options.WorkerId, "lease expired too many times", TimeSpan.Zero, CancellationToken.None);
            return;
        }

        if (!_handlers.TryGetValue(job.Type, out var handler))
        {
            await queue.FailAsync(job, options.WorkerId, $"no handler for '{job.Type}'", TimeSpan.FromMinutes(1), CancellationToken.None);
            return;
        }

        try
        {
            await handler.HandleAsync(job, stoppingToken);
            if (!await queue.CompleteAsync(job, options.WorkerId, CancellationToken.None))
                logger.LogWarning("Lost lease on job {JobId} before completing it", job.Id);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down mid-job: hand it back immediately instead of waiting for the lease to expire.
            await queue.ReleaseAsync(job, options.WorkerId, CancellationToken.None);
        }
        catch (Exception ex)
        {
            var delay = Backoff.Compute(job.Attempts, options.RetryBase, options.RetryCap, Random.Shared);
            logger.LogWarning(ex, "Job {JobId} attempt {Attempt} failed; retry in {Delay}", job.Id, job.Attempts, delay);
            await queue.FailAsync(job, options.WorkerId, ex.Message, delay, CancellationToken.None);
        }
    }

    private static async Task SafeDelay(TimeSpan delay, CancellationToken ct)
    {
        try { await Task.Delay(delay, ct); } catch (OperationCanceledException) { }
    }
}
```

Why `job.Attempts > job.MaxAttempts`? Claims increment `attempts`. A job that crashes the whole
process (out-of-memory on a huge file, say) never reaches `FailAsync`; it just keeps coming back
via expired leases. This check stops such a **poison pill** from taking down workers forever.

**5. The tests.** One Postgres container for the run, the table truncated before each test.

`tests/Jobs.Tests/PostgresFixture.cs`

```csharp
using Npgsql;
using Testcontainers.PostgreSql;

namespace Jobs.Tests;

public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _container = new PostgreSqlBuilder("postgres:18").Build();
    public NpgsqlDataSource DataSource { get; private set; } = null!;
    public PgJobQueue Queue { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _container.StartAsync();
        DataSource = NpgsqlDataSource.Create(_container.GetConnectionString());
        Queue = new PgJobQueue(DataSource);
        await Queue.EnsureSchemaAsync();
    }

    public async Task ResetAsync()
    {
        await using var cmd = DataSource.CreateCommand("TRUNCATE jobs RESTART IDENTITY");
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task DisposeAsync()
    {
        await DataSource.DisposeAsync();
        await _container.DisposeAsync();
    }
}

[CollectionDefinition(Name)]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>
{
    public const string Name = "postgres";
}
```

`tests/Jobs.Tests/BackoffTests.cs`

```csharp
using Shouldly;

namespace Jobs.Tests;

public class BackoffTests
{
    private static readonly TimeSpan Base = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan Cap = TimeSpan.FromSeconds(30);

    [Theory]
    [InlineData(1, 1)]
    [InlineData(2, 2)]
    [InlineData(3, 4)]
    [InlineData(5, 16)]
    [InlineData(6, 30)]    // 32s would exceed the cap
    [InlineData(50, 30)]   // huge attempt numbers don't overflow
    public void Delay_never_exceeds_the_exponential_ceiling(int attempt, int ceilingSeconds)
    {
        var random = new Random(42);
        for (var i = 0; i < 1_000; i++)
        {
            var d = Backoff.Compute(attempt, Base, Cap, random);
            d.ShouldBeGreaterThanOrEqualTo(TimeSpan.Zero);
            d.ShouldBeLessThanOrEqualTo(TimeSpan.FromSeconds(ceilingSeconds));
        }
    }

    [Fact]
    public void Delays_are_jittered_not_identical()
    {
        var random = new Random(7);
        var delays = Enumerable.Range(0, 20).Select(_ => Backoff.Compute(4, Base, Cap, random)).Distinct();
        delays.Count().ShouldBeGreaterThan(15);
    }
}
```

`tests/Jobs.Tests/PgJobQueueTests.cs`

```csharp
using System.Collections.Concurrent;
using Shouldly;

namespace Jobs.Tests;

[Collection(PostgresCollection.Name)]
public sealed class PgJobQueueTests(PostgresFixture pg) : IAsyncLifetime
{
    private PgJobQueue Queue => pg.Queue;
    public Task InitializeAsync() => pg.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Claim_returns_the_job_and_marks_it_running()
    {
        var id = await Queue.EnqueueAsync("send-email", new { to = "bob@example.com" });

        var job = await Queue.ClaimAsync("w1", TimeSpan.FromSeconds(30));

        job.ShouldNotBeNull();
        job.Id.ShouldBe(id);
        job.Attempts.ShouldBe(1);
        job.Payload.ShouldContain("bob@example.com");
        (await Queue.GetStatusAsync(id)).ShouldBe("running");
        (await Queue.ClaimAsync("w2", TimeSpan.FromSeconds(30))).ShouldBeNull(); // nothing else to take
    }

    [Fact]
    public async Task Concurrent_workers_never_claim_the_same_job()
    {
        for (var i = 0; i < 200; i++) await Queue.EnqueueAsync("thumbnail", new { n = i });
        var processed = new ConcurrentBag<long>();

        var workers = Enumerable.Range(1, 8).Select(w => Task.Run(async () =>
        {
            while (await Queue.ClaimAsync($"w{w}", TimeSpan.FromSeconds(30)) is { } job)
            {
                processed.Add(job.Id);
                (await Queue.CompleteAsync(job, $"w{w}")).ShouldBeTrue();
            }
        }));
        await Task.WhenAll(workers);

        processed.Count.ShouldBe(200);
        processed.Distinct().Count().ShouldBe(200);   // no job was handed out twice
    }

    [Fact]
    public async Task Expired_lease_is_reclaimed_and_the_crashed_worker_is_fenced_out()
    {
        await Queue.EnqueueAsync("report", new { });
        var first = await Queue.ClaimAsync("crashy", TimeSpan.FromMilliseconds(200));
        first.ShouldNotBeNull();

        await Task.Delay(500);   // "crashy" died; its lease runs out

        var second = await Queue.ClaimAsync("healthy", TimeSpan.FromSeconds(30));
        second.ShouldNotBeNull();
        second.Id.ShouldBe(first.Id);
        second.Attempts.ShouldBe(2);

        (await Queue.CompleteAsync(first, "crashy")).ShouldBeFalse();   // zombie can't complete
        (await Queue.CompleteAsync(second, "healthy")).ShouldBeTrue();
        (await Queue.GetStatusAsync(first.Id)).ShouldBe("done");
    }

    [Fact]
    public async Task Failed_job_is_retried_later_then_dead_lettered()
    {
        var id = await Queue.EnqueueAsync("flaky", new { }, maxAttempts: 2);

        var a1 = await Queue.ClaimAsync("w1", TimeSpan.FromSeconds(30));
        (await Queue.FailAsync(a1!, "w1", "boom 1", TimeSpan.FromHours(1))).ShouldBeTrue();
        (await Queue.GetStatusAsync(id)).ShouldBe("queued");
        (await Queue.ClaimAsync("w1", TimeSpan.FromSeconds(30))).ShouldBeNull();   // not before run_after

        await using (var cmd = pg.DataSource.CreateCommand("UPDATE jobs SET run_after = now() WHERE id = $1"))
        {
            cmd.Parameters.AddWithValue(id);
            await cmd.ExecuteNonQueryAsync();    // fast-forward the retry delay
        }

        var a2 = await Queue.ClaimAsync("w1", TimeSpan.FromSeconds(30));
        a2!.Attempts.ShouldBe(2);
        await Queue.FailAsync(a2, "w1", "boom 2", TimeSpan.Zero);

        (await Queue.GetStatusAsync(id)).ShouldBe("dead");
        (await Queue.ClaimAsync("w1", TimeSpan.FromSeconds(30))).ShouldBeNull();
    }

    [Fact]
    public async Task Released_job_is_claimable_at_once_and_does_not_burn_an_attempt()
    {
        var id = await Queue.EnqueueAsync("export", new { }, maxAttempts: 1);
        var a1 = await Queue.ClaimAsync("w1", TimeSpan.FromMinutes(5));

        (await Queue.ReleaseAsync(a1!, "w1")).ShouldBeTrue();   // graceful shutdown mid-job

        (await Queue.GetStatusAsync(id)).ShouldBe("queued");    // not 'dead', even on the last attempt
        var a2 = await Queue.ClaimAsync("w2", TimeSpan.FromSeconds(30));   // no waiting for the 5-min lease
        a2.ShouldNotBeNull();
        a2.Attempts.ShouldBe(1);
    }
}
```

`tests/Jobs.Tests/JobWorkerTests.cs`

```csharp
using System.Collections.Concurrent;
using Microsoft.Extensions.Logging.Abstractions;
using Shouldly;

namespace Jobs.Tests;

[Collection(PostgresCollection.Name)]
public sealed class JobWorkerTests(PostgresFixture pg) : IAsyncLifetime
{
    public Task InitializeAsync() => pg.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    private sealed class RecordingHandler : IJobHandler
    {
        public string Type => "greet";
        public ConcurrentQueue<string> Seen { get; } = new();
        public Task HandleAsync(Job job, CancellationToken ct)
        {
            Seen.Enqueue(job.Payload);
            return Task.CompletedTask;
        }
    }

    private sealed class AlwaysFailsHandler : IJobHandler
    {
        public string Type => "explode";
        public Task HandleAsync(Job job, CancellationToken ct) => throw new InvalidOperationException("kaboom");
    }

    [Fact]
    public async Task Worker_processes_jobs_and_stops_gracefully()
    {
        var handler = new RecordingHandler();
        var options = new JobWorkerOptions { WorkerId = "test", PollInterval = TimeSpan.FromMilliseconds(50) };
        var worker = new JobWorker(pg.Queue, [handler], options, NullLogger<JobWorker>.Instance);
        var id = await pg.Queue.EnqueueAsync("greet", new { name = "Ada" });

        await worker.StartAsync(CancellationToken.None);
        await WaitUntil(async () => await pg.Queue.GetStatusAsync(id) == "done");
        await worker.StopAsync(CancellationToken.None);   // returns once ExecuteAsync exits

        handler.Seen.ShouldHaveSingleItem().ShouldContain("Ada");
    }

    [Fact]
    public async Task Failing_handler_ends_in_the_dead_letter_state()
    {
        var options = new JobWorkerOptions
        {
            WorkerId = "test",
            PollInterval = TimeSpan.FromMilliseconds(50),
            RetryBase = TimeSpan.FromMilliseconds(10),
            RetryCap = TimeSpan.FromMilliseconds(50),
        };
        var worker = new JobWorker(pg.Queue, [new AlwaysFailsHandler()], options, NullLogger<JobWorker>.Instance);
        var id = await pg.Queue.EnqueueAsync("explode", new { }, maxAttempts: 3);

        await worker.StartAsync(CancellationToken.None);
        await WaitUntil(async () => await pg.Queue.GetStatusAsync(id) == "dead");
        await worker.StopAsync(CancellationToken.None);

        await using var cmd = pg.DataSource.CreateCommand("SELECT attempts, last_error FROM jobs WHERE id = $1");
        cmd.Parameters.AddWithValue(id);
        await using var r = await cmd.ExecuteReaderAsync();
        await r.ReadAsync();
        r.GetInt32(0).ShouldBe(3);
        r.GetString(1).ShouldBe("kaboom");
    }

    // Waits for a REAL worker, so it measures real elapsed time. Stopwatch is monotonic (immune to
    // clock changes) and is not what's under test, so this isn't a TimeProvider case.
    private static async Task WaitUntil(Func<Task<bool>> condition, int timeoutMs = 10_000)
    {
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        while (!await condition())
        {
            if (elapsed.ElapsedMilliseconds > timeoutMs) throw new TimeoutException("condition not met in time");
            await Task.Delay(50);
        }
    }
}
```

**6. Run:**

```bash
dotnet test
```

Expected:

```text
Passed!  - Failed:     0, Passed:    14, Skipped:     0, Total:    14, Duration: 7 s - Jobs.Tests.dll (net10.0)
```

**7. Break it to understand it.** Make each change in `PgJobQueue.cs`, run `dotnet test`, undo:

1. Remove `SKIP LOCKED` (keep `FOR UPDATE`). The tests still pass, and the concurrency test is
   barely slower. Why? In the **lease** design the row lock is held only for the few
   microseconds of the claim `UPDATE`, so waiting for it is cheap. `SKIP LOCKED` becomes critical
   when locks are held for long (the hold-the-transaction variant, where a waiter would block for
   the whole job) or at very high claim rates. Restore it, because there's no reason to wait at all.
2. Remove the whole `FOR UPDATE SKIP LOCKED` line. Run
   `dotnet test --filter Concurrent` a few times: it **fails**, because jobs are handed out twice.
   Both transactions' subqueries pick the same id from their snapshot; the second `UPDATE` waits
   for the first one's row lock, then re-checks only `id = X`, which still matches, and claims the
   job again. The locking clause is what makes the subquery's choice exclusive. Restore it.
3. Remove `AND locked_by = $2` from `CompleteAsync`. The lease/zombie test fails: the crashed
   worker can now complete a job it no longer owns.

**8. Run it as a real worker (optional).** Add a Worker Service host:

```bash
dotnet new worker -o src/Jobs.Worker
dotnet sln add src/Jobs.Worker
dotnet add src/Jobs.Worker reference src/Jobs
rm src/Jobs.Worker/Worker.cs
docker run -d --name devquest-jobs-pg -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:18
```

`src/Jobs.Worker/Program.cs`

```csharp
using Jobs;
using Npgsql;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddSingleton(_ =>
    NpgsqlDataSource.Create(builder.Configuration.GetConnectionString("Db")!));
builder.Services.AddSingleton<PgJobQueue>();
builder.Services.AddSingleton(new JobWorkerOptions());
builder.Services.AddSingleton<IJobHandler, SendWelcomeEmailHandler>();
builder.Services.AddHostedService<JobWorker>();
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(25));

var host = builder.Build();

var queue = host.Services.GetRequiredService<PgJobQueue>();
await queue.EnsureSchemaAsync();
for (var i = 1; i <= 20; i++)
    await queue.EnqueueAsync("send-welcome-email", new { userId = $"user-{i}" });

await host.RunAsync();

sealed class SendWelcomeEmailHandler(ILogger<SendWelcomeEmailHandler> logger) : IJobHandler
{
    public string Type => "send-welcome-email";

    public async Task HandleAsync(Job job, CancellationToken ct)
    {
        await Task.Delay(TimeSpan.FromSeconds(1), ct);   // pretend to call an email API
        logger.LogInformation("Job {JobId} (attempt {Attempt}): sent welcome email {Payload}",
            job.Id, job.Attempts, job.Payload);
    }
}
```

`src/Jobs.Worker/appsettings.json`

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.Hosting.Lifetime": "Information"
    }
  },
  "ConnectionStrings": {
    "Db": "Host=localhost;Port=5433;Database=postgres;Username=postgres;Password=postgres"
  }
}
```

Run `dotnet run --project src/Jobs.Worker` once on its own first (this also creates the schema,
so two processes never race on `CREATE TABLE IF NOT EXISTS` against an empty database). You
should see a line per second like `Job 1 (attempt 1): sent welcome email {"userId": "user-1"}`,
twenty in total. Press `Ctrl+C` part-way through and watch `Application is shutting down...`
followed by `Worker ... stopped`; the job that was in flight is handed back with `ReleaseAsync`,
and the unfinished jobs wait in the table for the next run.
Now start the worker again, and while it's still working through its twenty jobs, start a
**second** terminal with the same command. You'll see the remaining jobs split between the two
processes (interleaved job ids in the two logs) with no job id appearing in both. Clean up with
`docker rm -f devquest-jobs-pg`.

- [ ] `dotnet test` passes all 14 tests against `postgres:18`
- [ ] Removing the locking clause makes the concurrency test fail, and I can explain why `SKIP LOCKED` alone barely changes timing here
- [ ] Removing the `locked_by` fence makes the zombie test fail (and I restored it)
- [ ] (Optional) Two worker processes split the jobs without processing any job twice
:::

## Flashcards

:::cards id=be-16-cards1 xp=20 title="Background jobs & queues"
Q: How do you use a scoped service (DbContext) from a BackgroundService?
A: Inject `IServiceScopeFactory` and create a scope per unit of work (`CreateAsyncScope()`); hosted services are singletons.
Q: What happens on an unhandled exception in `ExecuteAsync` (.NET 6+)?
A: The host stops (`BackgroundServiceExceptionBehavior.StopHost`). Catch per iteration if the loop should continue.
Q: Bounded channel with `FullMode.Wait` — what happens when full?
A: `WriteAsync` waits for space: backpressure on producers. Channels are in-memory, so their contents are lost on restart.
Q: What does `FOR UPDATE SKIP LOCKED` do in a claim query?
A: Locks the selected row and skips rows already locked by other transactions, so concurrent workers each grab a different job instead of waiting.
Q: What is a lease (visibility timeout)?
A: A claim valid until a deadline (`locked_until` / a Redis key TTL). If the worker dies, the lease expires and another worker can reclaim the job.
Q: What is fencing in a job queue?
A: Complete/fail only succeeds if the caller still holds the lease (`WHERE locked_by = @me`), so a zombie worker can't overwrite a reclaimed job's state.
Q: Reliable Redis list queue pattern?
A: `LMOVE queue processing` (formerly RPOPLPUSH) + lease key with TTL; on success `LREM` + `DEL`; a reaper requeues items whose lease expired (atomically via Lua). Or use Redis Streams + consumer groups.
Q: Why is delivery at-least-once, and what's the consequence?
A: The queue can't tell if a dead worker finished; it re-runs the job. Handlers must be idempotent (dedup keys, upserts, provider idempotency keys).
Q: Full jitter backoff formula?
A: `random(0, min(cap, base * 2^(attempt-1)))`: exponential growth, capped, randomized to avoid thundering herds.
Q: What's a dead-letter state and what must accompany it?
A: Where jobs go after max attempts or permanent errors; it needs alerting and a replay path, or it becomes a black hole.
Q: Graceful shutdown checklist for workers?
A: Stop claiming on cancellation, finish or release the in-flight job, `ShutdownTimeout` below the pod's termination grace period, and rely on leases for hard kills.
Q: Big advantage of a Postgres-table queue over an external broker?
A: Enqueue in the same transaction as the business write, with no lost or phantom messages and no outbox needed.
:::

## Recap

- `BackgroundService` runs loops in the host: scope per unit of work, catch per iteration,
  honor `stoppingToken`. `Channel<T>` (bounded!) is a great in-memory buffer, but it isn't durable.
- Durable queues need persistence, exclusive claims, **leases** for crash recovery, retries and
  dead letters.
- **Postgres**: claim with `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`,
  lease columns, fenced complete/fail. You can enqueue transactionally with your data.
- **Redis**: `LMOVE` to a processing list + lease key TTL + an atomic reaper (or Streams).
  StackExchange.Redis has no blocking commands.
- Delivery is **at-least-once**, so handlers must be **idempotent**.
- Retry transient errors with exponential backoff + **full jitter**; dead-letter permanent ones
  and alert.
- Shut down gracefully (stop claiming, release in-flight work, `ShutdownTimeout` < grace period);
  scale workers separately, on queue depth (KEDA).
