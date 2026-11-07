---
id: cap-08
title: Background Jobs — Publish Without Blocking
level: expert
minutes: 330
xp: 250
summary: A Postgres-backed job queue with FOR UPDATE SKIP LOCKED, leases, retries with backoff, dead-lettering and an idempotent publish pipeline that streams its status to the editor.
---

Publishing a story is the first thing in BranchStory that is **too slow and too fragile for a
request**. It has to read the whole graph, validate it, strip drafts, sanitize media URLs, render
the player JSON and write it somewhere the public can read it. Today that takes 50 ms. The day you
add thumbnails, video transcoding or a CDN purge it takes a minute, and a user who closes the tab
mid-request must not end up with half a publish.

So the API does what every SaaS does: it **records the intent** (a row in `jobs`), answers
`202 Accepted` immediately, and a separate **worker** process does the work, survives crashes, and
reports progress back over SignalR.

```text
 Browser                 API (BranchStory.Api)                Postgres                 Worker (BranchStory.Worker)
 ───────                 ─────────────────────                ────────                 ───────────────────────────
 POST /publish  ───────▶ ProjectGate (Edit) + owner quota
 Idempotency-Key         INSERT jobs (status=queued) ───────▶ jobs
                ◀─────── 202 { jobId }                         │      ◀─── claim: UPDATE … FOR UPDATE SKIP LOCKED
                                                               │           lease: leased_until = now()+30s
                                                               │      ◀─── heartbeat: extend lease every 10 s
                                                               │           build player JSON
                                                               │      ◀─── UPSERT published_stories
                         LISTEN job_events ◀────── pg_notify ──┘      ◀─── status=succeeded + pg_notify
 JobUpdated     ◀─────── StoryHub group of the project
 GET /api/public/stories/{slug} ─▶ SELECT player_json FROM published_stories (anonymous, cacheable)
```

Two HTTP details carry this design:

- **`202 Accepted`** means "I have recorded your request, but it is not done yet". The response
  carries a `Location` header (`/api/jobs/42`) where the client can check on the result. Compare
  `200 OK` / `201 Created`, which promise the work is already finished.
- **Idempotent** means "doing it twice has the same effect as doing it once". It matters twice in
  this lesson: the *client* may send the same publish request twice (double click, retry after a
  timeout), and the *worker* may run the same job twice (crash, reclaim). Both must be harmless.

## Why a Postgres queue?

You will meet Hangfire, Quartz.NET, MassTransit over RabbitMQ, Azure Service Bus, SQS and Redis
lists in the wild. They are all fine. For BranchStory a table in the database you already run wins
for three reasons:

1. **Transactional enqueue.** The job row is written in the same database as the business change,
   so it can share a transaction. With an external broker you get the "dual write" problem: the DB
   commit succeeds and the publish to the broker fails (or the other way round), and now they disagree.
2. **One less moving part.** No broker to deploy, secure, back up and monitor. Your backups
   already include the queue.
3. **It is fast enough.** `FOR UPDATE SKIP LOCKED` lets many workers pull from one table without
   blocking each other. A single Postgres comfortably handles thousands of jobs per second, which is
   orders of magnitude more than "users clicking Publish".

:::pro title="When to graduate"
Move to a broker when you need fan-out to many consumers, cross-service events, very high
throughput (tens of thousands per second), or when the queue load starts to hurt your OLTP
traffic. Even then, teams usually keep the *transactional outbox* table and relay from it to the
broker, which is the same pattern you are building here.
:::

## The job lifecycle

```text
               claim (attempts+1, lease)             handler ok
   ┌────────┐ ─────────────────────────▶ ┌─────────┐ ──────────▶ ┌───────────┐
   │ queued │                            │ running │             │ succeeded │
   └────────┘ ◀───────────────────────── └─────────┘             └───────────┘
       ▲   transient error: run_after = now()+backoff │  │
       │                                              │  │ permanent error, or attempts = max_attempts,
       │   lease expired and attempts left: the next  │  │ or the lease expired on the last attempt
       └── claim takes it over ───────────────────────┘  ▼
                                                      ┌────────┐
                                                      │ failed │  (dead-letter: a human looks at it)
                                                      └────────┘
```

Four rules keep this correct:

- **Claim atomically.** One statement picks a due row, locks it, skips rows others locked, and
  marks it `running`. Two workers can never claim the same row at the same moment.
- **Lease, don't hold.** The worker does *not* keep a transaction open while it works. It writes
  `leased_until = now() + 30s` and keeps extending it (a heartbeat). If the worker dies, the lease
  simply expires and another worker reclaims the job.
- **Fence every write.** Every status change says `WHERE id = @id AND leased_by = @me`. A worker
  that lost its lease (long GC pause, network split) cannot overwrite the new owner's result.
- **Assume at-least-once.** Because of reclaims, a handler *can* run twice. Make it idempotent.

### Anatomy of the claim

This is cap-02's claim in the form the worker runs it in a loop (`JobStore.ClaimSql` in Lab 1,
which also sets `updated_at`). Read it inside out:

```sql
WITH next AS (
    SELECT id FROM jobs
    WHERE ((status = 'queued'  AND run_after <= now())      -- due work …
        OR (status = 'running' AND leased_until < now()))   -- … or work whose worker died
      AND attempts < max_attempts
    ORDER BY run_after, id                                  -- oldest first
    LIMIT 1
    FOR UPDATE SKIP LOCKED                                  -- lock it; skip rows others hold
)
UPDATE jobs AS j
SET status = 'running', leased_by = @worker,
    leased_until = now() + make_interval(secs => @lease_seconds),
    attempts = j.attempts + 1
FROM next
WHERE j.id = next.id
RETURNING j.id, j.kind, j.project_id, j.payload::text, j.attempts, j.max_attempts;
```

- `FOR UPDATE` takes a row lock on the row the CTE picked. Another transaction that wants the same
  row lock would normally **wait**.
- `SKIP LOCKED` changes "wait" into "pretend that row isn't there and take the next one".
- The `UPDATE` in the same statement marks the row `running` before the statement commits. Because
  the statement autocommits, the lock is held for milliseconds, not for the whole job.

Two workers polling at the same instant:

```text
time   worker A                                  worker B
t0     CTE: row 7 is first, lock it              CTE: row 7 is locked → skip, row 8 → lock it
t1     UPDATE row 7 → running, leased_by=A       UPDATE row 8 → running, leased_by=B
t2     COMMIT (lock released)                    COMMIT
t3     … works on job 7 for a minute …           … works on job 8 …
```

:::warn title="Common mistake: dropping the lock clause"
Without `FOR UPDATE SKIP LOCKED`, A and B can both select row 7 from their snapshots. The `UPDATE …
WHERE j.id = next.id` doesn't re-check the status, so both claim it and the job runs twice. That
happens under load, never on your laptop, which is why Lab 2 of cap-09 tests it with eight
concurrent claimers against real Postgres.
:::

## The contract with earlier lessons

This lesson plugs into what you already built. These are the seams it relies on:

| Seam | From | Used here as |
|---|---|---|
| `jobs` table | cap-02 | `run_after`, `leased_until`, `leased_by`, `attempts`/`max_attempts` (CHECK `attempts <= max_attempts`), `status` in `queued`/`running`/`succeeded`/`failed`, unique `idempotency_key` |
| `published_stories` | cap-02 | `project_id` (PK), `slug` (unique), `source_version`, `player_json` (jsonb) |
| Connection string | cap-02 | `ConnectionStrings:BranchStory` (env `ConnectionStrings__BranchStory`) |
| `ProjectGate`, `ProjectRequirements` | cap-03 | publishing needs **Edit**, reading a job needs **View** |
| `PlanLimits.For(owner plan).PublishesPerDay`, `QuotaProblems` | cap-04 | the publish quota, billed to the **owner** |
| `StoryHub : Hub<IStoryClient>`, `StoryHub.GroupName(id)`, `useStoryHub(projectId, { … })` | cap-07 | relays `JobUpdated` to the project group and into the editor |
| `apiFetch`, `Button`, the router | cap-05 | `web/src/lib/api.ts`, `web/src/modules/ui`, `web/src/app/router.tsx` |

`failed` is the dead-letter state: a job that will not be retried again. There is no extra result
column: the slug of a finished publish is read from `published_stories`.

## Warm-up: the rest of the state machine in SQL

In cap-02 you wrote the claim. Two more statements complete the queue: recording a failure (retry
later or give up), and the health report that on-call looks at.

:::sql id=cap-08-sql1 db=empty xp=40
title: Record a failure: retry with backoff, or dead-letter
Worker `w-1` just lost its connection to the CDN, so **every job it currently holds** (status
`running`, `leased_by = 'w-1'`) failed. Write **one** `UPDATE` that, for those rows only:

- sets `status = 'failed'` when `attempts >= max_attempts` (no attempts left) and leaves its
  `run_after` **unchanged** (a dead job is never scheduled again),
- otherwise sets `status = 'queued'` with `run_after = now() + 2^attempts seconds` (exponential
  backoff: 1 attempt → 2 s, 3 attempts → 8 s),
- clears `leased_by` and `leased_until` (sets them to `NULL`),
- sets `last_error = 'cdn timeout'`.

Rows leased by other workers must not change: that is the fence.

This is the **same policy** the C# worker uses in Lab 1, just without the randomness.
`Backoff.Compute` takes `exp = BackoffBase · 2^(attempt-1)`, and with the default
`BackoffBase = 2 s` that is exactly `2^attempts` seconds. The worker then adds *equal jitter*
(a random delay between `exp / 2` and `exp`) and caps it at `BackoffMax`; here you write the upper
bound so the result can be checked.

hint: `CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END` works inside `SET`, and so does a `CASE` for `run_after` that keeps the old value for failed rows.
hint: `make_interval(secs => power(2, attempts))` builds the delay.

```sql setup
CREATE TABLE jobs (
  id           bigint PRIMARY KEY,
  status       text        NOT NULL,
  attempts     int         NOT NULL,
  max_attempts int         NOT NULL DEFAULT 5,
  run_after    timestamptz NOT NULL,
  leased_by    text,
  leased_until timestamptz,
  last_error   text
);
INSERT INTO jobs (id, status, attempts, run_after, leased_by, leased_until) VALUES
  (1, 'running',   1, now() - interval '1 minute',  'w-1', now() + interval '20 seconds'),
  (2, 'running',   3, now() - interval '5 minutes', 'w-1', now() + interval '20 seconds'),
  (3, 'running',   5, now() - interval '9 minutes', 'w-1', now() + interval '20 seconds'),
  (4, 'running',   2, now() - interval '2 minutes', 'w-2', now() + interval '20 seconds'),
  (5, 'queued',    0, now() - interval '1 minute',  NULL,  NULL),
  (6, 'succeeded', 1, now() - interval '1 hour',    NULL,  NULL);
```

```sql starter
UPDATE jobs SET status = 'queued', last_error = 'cdn timeout' WHERE status = 'running';
```

```sql solution
UPDATE jobs
SET status       = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
    run_after    = CASE WHEN attempts >= max_attempts THEN run_after
                        ELSE now() + make_interval(secs => power(2, attempts)) END,
    leased_by    = NULL,
    leased_until = NULL,
    last_error   = 'cdn timeout'
WHERE status = 'running' AND leased_by = 'w-1';
```

```sql check
SELECT id, status, leased_by, leased_until IS NULL AS lease_cleared, last_error,
       run_after > now() + make_interval(secs => power(2, attempts) - 1) AS backed_off
FROM jobs ORDER BY id;
```
:::

The second query is what an operator (and later the KEDA autoscaler) asks: *how deep is the queue?*

:::sql id=cap-08-sql2 db=empty xp=30 ordered=true
title: Queue health report
For every `kind`, return: `kind`, `ready` (queued and due), `delayed` (queued, `run_after` in the
future, so waiting for a retry), `running` (running with a valid lease), `stuck` (running with an
expired lease) and `failed`. Order by `kind`.

hint: `count(*) FILTER (WHERE …)` gives you one counter per column in a single pass.

```sql setup
CREATE TABLE jobs (
  id           bigint PRIMARY KEY,
  kind         text        NOT NULL,
  status       text        NOT NULL,
  run_after    timestamptz NOT NULL,
  leased_until timestamptz
);
INSERT INTO jobs VALUES
  (1, 'publish',   'queued',    now() - interval '1 minute',  NULL),
  (2, 'publish',   'queued',    now() - interval '2 minutes', NULL),
  (3, 'publish',   'queued',    now() + interval '5 minutes', NULL),
  (4, 'publish',   'running',   now() - interval '3 minutes', now() + interval '20 seconds'),
  (5, 'publish',   'running',   now() - interval '9 minutes', now() - interval '2 minutes'),
  (6, 'publish',   'failed',    now() - interval '1 day',     NULL),
  (7, 'publish',   'succeeded', now() - interval '1 day',     NULL),
  (8, 'thumbnail', 'queued',    now() - interval '1 minute',  NULL),
  (9, 'thumbnail', 'failed',    now() - interval '1 hour',    NULL),
  (10,'thumbnail', 'failed',    now() - interval '2 hours',   NULL);
```

```sql starter
SELECT kind, count(*) FROM jobs GROUP BY kind ORDER BY kind;
```

```sql solution
SELECT kind,
       count(*) FILTER (WHERE status = 'queued'  AND run_after <= now())    AS ready,
       count(*) FILTER (WHERE status = 'queued'  AND run_after >  now())    AS delayed,
       count(*) FILTER (WHERE status = 'running' AND leased_until >= now()) AS running,
       count(*) FILTER (WHERE status = 'running' AND leased_until <  now()) AS stuck,
       count(*) FILTER (WHERE status = 'failed')                            AS failed
FROM jobs
GROUP BY kind
ORDER BY kind;
```
:::

:::quiz id=cap-08-q1 xp=15
(cap-02 covered what `FOR UPDATE` without `SKIP LOCKED` does. This one is about **order**.) The
claim sorts by `run_after, id` and uses `SKIP LOCKED`. Three workers pull from a queue that holds
jobs 1–6, all due. Which statement about the order the jobs run in is true?
- [ ] Strict FIFO: job N+1 never starts before job N has finished
- [x] Roughly FIFO: each claim takes the oldest row nobody else has locked, so jobs *start* close to queue order, but they finish in any order, and a failed attempt moves back by its backoff
- [ ] Random: `SKIP LOCKED` returns rows in their physical order on disk
- [ ] Newest first, because recent rows are still in the buffer cache
> `ORDER BY run_after, id` makes every worker *aim* for the oldest due job, and `SKIP LOCKED` makes it take the next one when that row is already locked. So jobs 1–3 start almost together and finish in whatever order their handlers do. A failed attempt gets a new `run_after` and lines up behind newer work. If order matters for one key, such as two publishes of the same project, don't rely on the queue for it. BranchStory doesn't: a second publish reuses a job that is still `queued`, and the upsert only moves `source_version` forward, so a slow older run can't overwrite a newer publish.
:::

## Lab 1: the worker service

:::lab id=cap-08-lab1 xp=150
title: BranchStory.Worker claims, leases, retries and dead-letters

You will build a separate process with a `BackgroundService` that runs N claim loops. It uses
**plain Npgsql** rather than EF Core: every statement here is about locking semantics, and you
want to read the exact SQL in code review, not reverse-engineer it from LINQ. It also keeps the
worker independent of the API's DbContext: the table *is* the contract.

The worker is a tiny ASP.NET Core app (Web SDK) and not a bare `dotnet new worker`, because it
needs HTTP endpoints for Kubernetes liveness and readiness probes in cap-10.

**1. Check the schema you are about to drive**

```bash
docker compose -f deploy/compose.yaml up -d db
docker compose -f deploy/compose.yaml exec db psql -U branchstory -c '\d jobs'
```

You should see `run_after`, `leased_until`, `leased_by`, the unique index on `idempotency_key`, the
`(status, run_after)` index, and the two CHECK constraints from cap-02. No migration is needed.

**2. Create the project**

```bash
dotnet new web -n BranchStory.Worker -o worker/BranchStory.Worker
dotnet add worker/BranchStory.Worker package Npgsql.DependencyInjection
dotnet sln add worker/BranchStory.Worker
mkdir -p worker/BranchStory.Worker/{Jobs,Health,Publishing,Demo}
```

**3. `worker/BranchStory.Worker/Jobs/JobContracts.cs`**

```csharp
namespace BranchStory.Worker.Jobs;

/// <summary>A job this worker currently holds a lease on. Attempts already includes this attempt.</summary>
public sealed record ClaimedJob(long Id, string Kind, Guid ProjectId, string Payload, int Attempts, int MaxAttempts);

/// <summary>One handler per job kind. The returned text is logged (a short summary of the outcome).</summary>
public interface IJobHandler
{
    string Kind { get; }
    Task<string?> HandleAsync(ClaimedJob job, CancellationToken ct);
}

/// <summary>Retrying cannot help (invalid input, deleted project): dead-letter immediately.</summary>
public sealed class PermanentJobException(string message) : Exception(message);

public sealed class WorkerOptions
{
    public string WorkerId { get; set; } = $"{Environment.MachineName}-{Environment.ProcessId}";
    public int Concurrency { get; set; } = 2;
    public TimeSpan Lease { get; set; } = TimeSpan.FromSeconds(30);
    public TimeSpan IdleDelay { get; set; } = TimeSpan.FromSeconds(1);
    public TimeSpan BackoffBase { get; set; } = TimeSpan.FromSeconds(2);
    public TimeSpan BackoffMax { get; set; } = TimeSpan.FromMinutes(5);
}
```

**4. `worker/BranchStory.Worker/Jobs/Backoff.cs`**

```csharp
namespace BranchStory.Worker.Jobs;

public static class Backoff
{
    /// <summary>
    /// Exponential backoff with "equal jitter": the delay doubles per attempt up to <paramref name="max"/>,
    /// and the second half of it is random so a burst of failures does not retry in lock-step.
    /// </summary>
    /// <param name="attempt">1-based number of the attempt that just failed.</param>
    /// <param name="jitter01">A random number in [0, 1). Injected so tests are deterministic.</param>
    public static TimeSpan Compute(int attempt, TimeSpan baseDelay, TimeSpan max, double jitter01)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(attempt, 1);
        var exp = Math.Min(max.TotalMilliseconds, baseDelay.TotalMilliseconds * Math.Pow(2, attempt - 1));
        return TimeSpan.FromMilliseconds(exp / 2 + exp / 2 * Math.Clamp(jitter01, 0, 1));
    }
}
```

**5. `worker/BranchStory.Worker/Jobs/JobStore.cs`**: every statement that touches `jobs`

```csharp
using Npgsql;
using NpgsqlTypes;

namespace BranchStory.Worker.Jobs;

/// <summary>All SQL for the jobs table lives here, one file to review for locking rules.</summary>
public sealed class JobStore(NpgsqlDataSource db)
{
    // The claim NOTIFYs too, so the editor sees "running" without waiting for its next poll.
    public const string ClaimSql = $"""
        WITH next AS (
            SELECT id FROM jobs
            WHERE ((status = 'queued'  AND run_after <= now())
                OR (status = 'running' AND leased_until < now()))
              AND attempts < max_attempts
            ORDER BY run_after, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        ), changed AS (
            UPDATE jobs AS j
            SET status       = 'running',
                leased_by    = @worker,
                leased_until = now() + make_interval(secs => @lease_seconds),
                attempts     = j.attempts + 1,
                updated_at   = now()
            FROM next
            WHERE j.id = next.id
            RETURNING j.id, j.kind, j.project_id, j.payload::text AS payload, j.attempts, j.max_attempts,
                      j.status, j.last_error
        ), notified AS (
            {NotifySelect}
        )
        -- A plain SELECT in a CTE only runs when it is referenced; the join makes the NOTIFY happen.
        SELECT c.id, c.kind, c.project_id, c.payload, c.attempts, c.max_attempts
        FROM changed c CROSS JOIN (SELECT count(*) FROM notified) AS n
        """;

    public async Task<ClaimedJob?> TryClaimAsync(string workerId, TimeSpan lease, CancellationToken ct)
    {
        await using var cmd = db.CreateCommand(ClaimSql);
        cmd.Parameters.AddWithValue("worker", workerId);
        cmd.Parameters.AddWithValue("lease_seconds", lease.TotalSeconds);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        return new ClaimedJob(r.GetInt64(0), r.GetString(1), r.GetGuid(2), r.GetString(3), r.GetInt32(4), r.GetInt32(5));
    }

    /// <summary>Heartbeat. Returns false when we no longer own the job (lease expired and someone reclaimed it).</summary>
    public async Task<bool> ExtendLeaseAsync(long jobId, string workerId, TimeSpan lease, CancellationToken ct)
    {
        await using var cmd = db.CreateCommand("""
            UPDATE jobs
            SET leased_until = now() + make_interval(secs => @lease_seconds), updated_at = now()
            WHERE id = @id AND status = 'running' AND leased_by = @worker
            """);
        cmd.Parameters.AddWithValue("id", jobId);
        cmd.Parameters.AddWithValue("worker", workerId);
        cmd.Parameters.AddWithValue("lease_seconds", lease.TotalSeconds);
        return await cmd.ExecuteNonQueryAsync(ct) == 1;
    }

    public Task<bool> CompleteAsync(ClaimedJob job, string workerId, CancellationToken ct) =>
        TransitionAsync("status = 'succeeded', last_error = NULL", job, workerId, ct);

    public Task<bool> RetryAsync(ClaimedJob job, string workerId, TimeSpan delay, string error, CancellationToken ct) =>
        TransitionAsync("status = 'queued', run_after = now() + make_interval(secs => @delay_seconds), last_error = @error",
            job, workerId, ct,
            new NpgsqlParameter("delay_seconds", NpgsqlDbType.Double) { Value = delay.TotalSeconds },
            new NpgsqlParameter("error", NpgsqlDbType.Text) { Value = Truncate(error) });

    /// <summary>Dead-letter: status 'failed', never claimed again.</summary>
    public Task<bool> FailAsync(ClaimedJob job, string workerId, string error, CancellationToken ct) =>
        TransitionAsync("status = 'failed', last_error = @error", job, workerId, ct,
            new NpgsqlParameter("error", NpgsqlDbType.Text) { Value = Truncate(error) });

    /// <summary>Graceful shutdown: give the job back without burning an attempt.</summary>
    public Task<bool> ReleaseAsync(ClaimedJob job, string workerId, CancellationToken ct) =>
        TransitionAsync("status = 'queued', run_after = now(), attempts = attempts - 1", job, workerId, ct);

    /// <summary>
    /// A lease that expired on the LAST attempt means the worker crashed every time (a poison job).
    /// The claim skips those rows (attempts &lt; max_attempts), so this sweep dead-letters them.
    /// </summary>
    public async Task<int> ReapExhaustedAsync(CancellationToken ct)
    {
        await using var cmd = db.CreateCommand($"""
            WITH changed AS (
                UPDATE jobs
                SET status = 'failed', last_error = 'lease expired on the final attempt (worker crash or timeout)',
                    leased_by = NULL, leased_until = NULL, updated_at = now()
                WHERE id IN (
                    SELECT id FROM jobs
                    WHERE status = 'running' AND leased_until < now() AND attempts >= max_attempts
                    FOR UPDATE SKIP LOCKED)
                RETURNING id, project_id, kind, status, attempts, last_error
            )
            {NotifySelect}
            """);
        var reaped = 0;
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct)) reaped++;
        return reaped;
    }

    // NOTIFY is transactional: listeners only hear about changes that committed.
    private const string NotifySelect = """
        SELECT pg_notify('job_events', json_build_object(
            'id', c.id, 'projectId', c.project_id, 'kind', c.kind, 'status', c.status,
            'attempts', c.attempts, 'error', c.last_error,
            -- like GET /api/jobs/{id}: a slug only for a finished job, never an old one for a failed run
            'slug', CASE WHEN c.status = 'succeeded'
                         THEN (SELECT ps.slug FROM published_stories ps WHERE ps.project_id = c.project_id) END)::text)
        FROM changed c
        """;

    // One statement per transition: the UPDATE is fenced by leased_by, and pg_notify runs only for
    // the row that actually changed. setClause is always a constant from this file, never user input.
    private async Task<bool> TransitionAsync(string setClause, ClaimedJob job, string workerId, CancellationToken ct,
        params NpgsqlParameter[] extra)
    {
        var sql = $"""
            WITH changed AS (
                UPDATE jobs
                SET {setClause}, leased_by = NULL, leased_until = NULL, updated_at = now()
                WHERE id = @id AND leased_by = @worker
                RETURNING id, project_id, kind, status, attempts, last_error
            )
            {NotifySelect}
            """;
        await using var cmd = db.CreateCommand(sql);
        cmd.Parameters.AddWithValue("id", job.Id);
        cmd.Parameters.AddWithValue("worker", workerId);
        cmd.Parameters.AddRange(extra);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        return await r.ReadAsync(ct);
    }

    private static string Truncate(string s) => s.Length <= 2000 ? s : s[..2000];
}
```

**6. `worker/BranchStory.Worker/Health/Health.cs`**

```csharp
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Npgsql;

namespace BranchStory.Worker.Health;

/// <summary>Liveness: the claim loops are still turning. A deadlocked worker gets restarted.</summary>
public sealed class WorkerHeartbeat(TimeProvider clock) : IHealthCheck
{
    private long _lastBeat = clock.GetUtcNow().ToUnixTimeMilliseconds();

    public void Beat() => Interlocked.Exchange(ref _lastBeat, clock.GetUtcNow().ToUnixTimeMilliseconds());

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        var age = clock.GetUtcNow().ToUnixTimeMilliseconds() - Interlocked.Read(ref _lastBeat);
        return Task.FromResult(age < 60_000
            ? HealthCheckResult.Healthy($"last beat {age} ms ago")
            : HealthCheckResult.Unhealthy($"no beat for {age} ms"));
    }
}

/// <summary>Readiness: we can reach Postgres.</summary>
public sealed class DatabaseHealthCheck(NpgsqlDataSource db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var cmd = db.CreateCommand("SELECT 1");
            await cmd.ExecuteScalarAsync(cancellationToken);
            return HealthCheckResult.Healthy();
        }
        catch (Exception ex)
        {
            return HealthCheckResult.Unhealthy("database unreachable", ex);
        }
    }
}
```

**7. `worker/BranchStory.Worker/Jobs/JobRunner.cs`**: the heart

```csharp
using BranchStory.Worker.Health;
using Microsoft.Extensions.Options;

namespace BranchStory.Worker.Jobs;

public sealed class JobRunner(
    JobStore store,
    IEnumerable<IJobHandler> handlers,
    WorkerHeartbeat heartbeat,
    IOptions<WorkerOptions> options,
    ILogger<JobRunner> log) : BackgroundService
{
    private readonly WorkerOptions _opt = options.Value;
    private readonly Dictionary<string, IJobHandler> _handlers = handlers.ToDictionary(h => h.Kind);

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        log.LogInformation("Worker {WorkerId} starting {Concurrency} loops for kinds {Kinds}",
            _opt.WorkerId, _opt.Concurrency, string.Join(",", _handlers.Keys));
        var loops = Enumerable.Range(0, _opt.Concurrency).Select(i => LoopAsync($"{_opt.WorkerId}#{i}", stoppingToken));
        return Task.WhenAll(loops.Append(ReaperAsync(stoppingToken)));
    }

    private async Task LoopAsync(string workerId, CancellationToken ct)
    {
        await Task.Yield(); // don't block host startup
        var idle = _opt.IdleDelay;
        while (!ct.IsCancellationRequested)
        {
            heartbeat.Beat();
            ClaimedJob? job;
            try
            {
                job = await store.TryClaimAsync(workerId, _opt.Lease, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Claim failed (database down?); backing off");
                await DelayAsync(_opt.IdleDelay * 5, ct);
                continue;
            }

            if (job is null)
            {
                await DelayAsync(idle, ct);
                // Idle loops slow down to at most 5x the idle delay: cheap when quiet, quick when busy.
                idle = TimeSpan.FromTicks(Math.Min(idle.Ticks * 2, _opt.IdleDelay.Ticks * 5));
                continue;
            }

            idle = _opt.IdleDelay;
            await RunOneAsync(job, workerId, ct);
        }
    }

    private async Task RunOneAsync(ClaimedJob job, string workerId, CancellationToken stoppingToken)
    {
        using var _ = log.BeginScope(new Dictionary<string, object>
        {
            ["JobId"] = job.Id, ["JobKind"] = job.Kind, ["ProjectId"] = job.ProjectId, ["Attempt"] = job.Attempts,
        });

        if (!_handlers.TryGetValue(job.Kind, out var handler))
        {
            await store.FailAsync(job, workerId, $"no handler for kind '{job.Kind}'", CancellationToken.None);
            log.LogError("Job dead-lettered: unknown kind");
            return;
        }

        using var jobCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var lease = KeepLeaseAsync(job, workerId, jobCts);
        var started = TimeProvider.System.GetTimestamp();
        try
        {
            var summary = await handler.HandleAsync(job, jobCts.Token);
            if (await store.CompleteAsync(job, workerId, CancellationToken.None))
                log.LogInformation("Job succeeded in {ElapsedMs} ms: {Summary}",
                    TimeProvider.System.GetElapsedTime(started).TotalMilliseconds, summary);
            else
                log.LogWarning("Job finished but our lease was gone; the new owner's run wins");
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            await store.ReleaseAsync(job, workerId, CancellationToken.None);
            log.LogInformation("Shutting down: job released back to the queue");
        }
        catch (PermanentJobException ex)
        {
            await store.FailAsync(job, workerId, ex.Message, CancellationToken.None);
            log.LogError("Job dead-lettered: {Reason}", ex.Message);
        }
        catch (Exception ex)
        {
            if (job.Attempts >= job.MaxAttempts)
            {
                await store.FailAsync(job, workerId, ex.Message, CancellationToken.None);
                log.LogError(ex, "Job dead-lettered after {Attempts} attempts", job.Attempts);
            }
            else
            {
                var delay = Backoff.Compute(job.Attempts, _opt.BackoffBase, _opt.BackoffMax, Random.Shared.NextDouble());
                await store.RetryAsync(job, workerId, delay, ex.Message, CancellationToken.None);
                log.LogWarning(ex, "Job failed; retry in {DelaySeconds:F1} s", delay.TotalSeconds);
            }
        }
        finally
        {
            await jobCts.CancelAsync();
            await lease;
        }
    }

    private async Task KeepLeaseAsync(ClaimedJob job, string workerId, CancellationTokenSource jobCts)
    {
        try
        {
            while (true)
            {
                await Task.Delay(_opt.Lease / 3, jobCts.Token);
                heartbeat.Beat();
                if (!await store.ExtendLeaseAsync(job.Id, workerId, _opt.Lease, jobCts.Token))
                {
                    log.LogWarning("Lost the lease on job {JobId}; cancelling the handler", job.Id);
                    await jobCts.CancelAsync();
                    return;
                }
            }
        }
        catch (OperationCanceledException) { /* job finished */ }
        catch (Exception ex) { log.LogWarning(ex, "Lease heartbeat failed; the lease may expire"); }
    }

    private async Task ReaperAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await DelayAsync(_opt.Lease, ct);
            try
            {
                var reaped = await store.ReapExhaustedAsync(ct);
                if (reaped > 0) log.LogError("Dead-lettered {Count} job(s) whose final attempt never finished", reaped);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
            catch (Exception ex) { log.LogWarning(ex, "Reaper sweep failed"); }
        }
    }

    private static async Task DelayAsync(TimeSpan delay, CancellationToken ct)
    {
        try { await Task.Delay(delay, ct); } catch (OperationCanceledException) { }
    }
}
```

**8. A demo handler to watch retries: `worker/BranchStory.Worker/Demo/DemoHandler.cs`**

```csharp
using System.Text.Json;
using BranchStory.Worker.Jobs;

namespace BranchStory.Worker.Demo;

public sealed record DemoPayload(int SleepMs = 2000, int FailTimes = 0);

/// <summary>Development only: sleeps, then fails the first FailTimes attempts.</summary>
public sealed class DemoHandler(ILogger<DemoHandler> log) : IJobHandler
{
    public string Kind => "demo";

    public async Task<string?> HandleAsync(ClaimedJob job, CancellationToken ct)
    {
        var p = JsonSerializer.Deserialize<DemoPayload>(job.Payload, JsonSerializerOptions.Web) ?? new DemoPayload();
        log.LogInformation("Demo job sleeping {SleepMs} ms", p.SleepMs);
        await Task.Delay(p.SleepMs, ct);
        if (job.Attempts <= p.FailTimes)
            throw new InvalidOperationException($"demo failure on attempt {job.Attempts} of {p.FailTimes} planned");
        return "demo ok";
    }
}
```

**9. `worker/BranchStory.Worker/Program.cs`**

The publish handler arrives in Lab 2; leave that line commented for now.

```csharp
using BranchStory.Worker.Demo;
using BranchStory.Worker.Health;
using BranchStory.Worker.Jobs;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("BranchStory")
    ?? throw new InvalidOperationException("ConnectionStrings:BranchStory is not configured");

builder.Services.AddNpgsqlDataSource(connectionString);
builder.Services.Configure<WorkerOptions>(builder.Configuration.GetSection("Worker"));
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(30));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<WorkerHeartbeat>();
builder.Services.AddSingleton<JobStore>();
// builder.Services.AddSingleton<IJobHandler, BranchStory.Worker.Publishing.PublishStoryHandler>(); // Lab 2
if (builder.Environment.IsDevelopment())
    builder.Services.AddSingleton<IJobHandler, DemoHandler>();
builder.Services.AddHostedService<JobRunner>();

builder.Services.AddHealthChecks()
    .AddCheck<WorkerHeartbeat>("runner", tags: ["live"])
    .AddCheck<DatabaseHealthCheck>("database", tags: ["ready"]);

var app = builder.Build();

app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = c => c.Tags.Contains("live") });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });

app.Run();
```

**10. Configuration**

`worker/BranchStory.Worker/appsettings.json` (Npgsql logs every command at `Information`, which would bury
the job log under a claim query every second, hence `Npgsql: Warning`):

```json
{
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning", "Npgsql": "Warning" } },
  "Worker": {
    "Concurrency": 2,
    "Lease": "00:00:30",
    "IdleDelay": "00:00:01",
    "BackoffBase": "00:00:02",
    "BackoffMax": "00:05:00"
  }
}
```

`worker/BranchStory.Worker/appsettings.Development.json`: a short lease so you can watch reclaims:

```json
{
  "ConnectionStrings": {
    "BranchStory": "Host=localhost;Port=5432;Database=branchstory;Username=branchstory;Password=branchstory;Keepalive=30"
  },
  "Worker": { "Lease": "00:00:09", "BackoffBase": "00:00:01" }
}
```

Replace `worker/BranchStory.Worker/Properties/launchSettings.json` to pin `dotnet run` to port 5081,
next to the API's 5080 (cap-03). Keep the port out of `appsettings.Development.json`: a `Urls`
setting there would also apply inside the cap-10 containers, which run as `Development` locally
and must listen on 8081 for their health checks.

```json
{
  "$schema": "https://json.schemastore.org/launchsettings.json",
  "profiles": {
    "http": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": false,
      "applicationUrl": "http://localhost:5081",
      "environmentVariables": {
        "ASPNETCORE_ENVIRONMENT": "Development"
      }
    }
  }
}
```

**11. Run it and feed it work**

```bash
dotnet run --project worker/BranchStory.Worker
```

In a second terminal, enqueue a demo job that fails twice and then succeeds (it borrows any
existing project for the foreign key, so create one in the app first):

```bash
docker compose -f deploy/compose.yaml exec -T db psql -U branchstory <<'SQL'
INSERT INTO jobs (kind, project_id, payload, status, attempts, max_attempts, run_after,
                  idempotency_key, created_at, updated_at)
SELECT 'demo', id, '{"sleepMs": 3000, "failTimes": 2}', 'queued', 0, 5, now(),
       'demo-' || gen_random_uuid(), now(), now()
FROM projects LIMIT 1
RETURNING id;
SQL
```

Watch the worker log: attempt 1 fails, retry after about 0.5 to 1 s, attempt 2 fails, retry after
about 1 to 2 s, attempt 3 succeeds. Then check the row:

```bash
docker compose -f deploy/compose.yaml exec -T db psql -U branchstory \
  -c "SELECT id, kind, status, attempts, last_error FROM jobs ORDER BY id DESC LIMIT 3;"
```

To save typing for the next experiments, wrap the insert in a shell function. It takes the payload
and `max_attempts`:

```bash
enqueue() {
  docker compose -f deploy/compose.yaml exec -T db psql -U branchstory -v ON_ERROR_STOP=1 \
    -c "INSERT INTO jobs (kind, project_id, payload, status, attempts, max_attempts, run_after,
                          idempotency_key, created_at, updated_at)
        SELECT 'demo', id, '$1', 'queued', 0, ${2:-5}, now(), 'demo-' || gen_random_uuid(), now(), now()
        FROM projects LIMIT 1 RETURNING id;"
}
```

(This is bash/zsh syntax. In fish, run `bash` first.)

**12. Dead-lettering after too many failures**

```bash
enqueue '{"sleepMs": 500, "failTimes": 9}' 5
```

The log shows five failures with growing delays (about 15 s in total with the development
backoff). Then the row is `failed`, with `attempts = 5`
and the last exception message in `last_error`. That last attempt is not retried, and no
further claim picks the row up.

**13. Chaos: kill the worker mid-job**

```bash
enqueue '{"sleepMs": 20000}' 5
```

When the worker log says "Demo job sleeping", kill the worker hard from the second terminal, so it
gets no chance to clean up. `dotnet run` starts the app as a child process, and that child is
the one to kill:

```bash
pkill -9 -f 'net10.0/BranchStory.Worker'
```

Run the `SELECT … FROM jobs` query from step 11. The job is still `running` with `leased_by` set,
because nobody told Postgres the worker died. Start the worker again (`dotnet run --project
worker/BranchStory.Worker`). Once the 9 s lease has expired, the next claim takes the job over.
About 20 s later the row is `succeeded` with `attempts = 2`: the crashed run counted as an attempt.

Now try the two other endings:

- **Graceful shutdown.** `enqueue '{"sleepMs": 20000}' 5`, then press **Ctrl+C** in the worker
  terminal while it sleeps. The host cancels `stoppingToken`, the log says "Shutting down: job
  released back to the queue", and the row is `queued` again with `attempts = 0`. No attempt was
  burned.
- **Poison job.** `enqueue '{"sleepMs": 20000}' 1` (only one attempt allowed). Kill the worker
  with `pkill -9` mid-job and start it again. The claim skips the row, because
  `attempts < max_attempts` is false. Within about one lease period the reaper moves it to
  `failed` with `last_error = 'lease expired on the final attempt …'`.

:::job title="What on-call asks first"
"Is the queue growing, and has anything failed?" Keep the health query from the SQL warm-up as a
saved query or a dashboard panel. A dead-lettered row is a bug report written by your system: it
should page someone (or at least open a ticket), never just sit there.
:::

- [ ] `GET http://localhost:5081/health/live` and `/health/ready` return `Healthy`
- [ ] A `demo` job with `failTimes: 2` ends `succeeded` with `attempts = 3`, and the log shows two growing retry delays
- [ ] A `demo` job with `failTimes: 9` ends `failed` after `max_attempts` with `last_error` filled
- [ ] After `kill -9` during a job, a restarted worker reclaims it once the lease expires
- [ ] Ctrl+C during a job puts it back to `queued` without increasing `attempts`
- [ ] A job whose final attempt never finishes is dead-lettered by the reaper
:::

## Retries are a design, not a loop

Backoff exists to protect the thing that is failing. If Postgres or a CDN is overloaded, 200
workers retrying every 100 ms turn a hiccup into an outage. Exponential growth spreads the load
over time; **jitter** spreads it across workers so they do not all wake up on the same tick (the
"thundering herd").

Classify failures before you retry them:

| Failure | Example | Do |
|---|---|---|
| Transient | timeout, 503, deadlock, connection reset | retry with backoff |
| Throttled | 429 with `Retry-After` | retry no sooner than the header says |
| Permanent | invalid document, project deleted, 400/404 | dead-letter now; retrying cannot help |
| Unknown | the worker crashed | lease expiry counts as an attempt, so a poison job dies eventually |

:::challenge id=cap-08-c1 lang=ts xp=60
title: Backoff and retries on a fake clock
Port the worker's retry policy to TypeScript (the web app can reuse it for its reconnect UI).
Implement:

- `computeBackoff(attempt, { baseMs, maxMs }, rand)`: `exp = min(maxMs, baseMs * 2^(attempt-1))`,
  return `exp / 2 + (exp / 2) * rand()` (equal jitter). `attempt` is 1-based.
- `runWithRetries(task, opts, clock, rand)`: call `task(attempt)` with attempt 1, 2, 3, …
  On success return `{ status: 'succeeded', value, attempts }`. On a `PermanentError` return
  `{ status: 'failed', error: message, attempts }` immediately. On any other error, if
  `attempt < opts.maxAttempts`, `await clock.sleep(computeBackoff(attempt, opts, rand))` and try
  again; otherwise return `failed` with the last error message. Never sleep after the final attempt.

hint: A `for (let attempt = 1; ; attempt++)` loop with `try { … } catch (e) { … }` keeps this flat.
hint: `e instanceof PermanentError` must be checked before deciding to sleep.
hint: The error message is `e instanceof Error ? e.message : String(e)`.

```ts setup
export class PermanentError extends Error {}
export interface RetryOptions { maxAttempts: number; baseMs: number; maxMs: number }
export interface Clock { sleep(ms: number): Promise<void> }
export type Outcome<T> =
  | { status: 'succeeded'; value: T; attempts: number }
  | { status: 'failed'; error: string; attempts: number }
```

```ts starter
export function computeBackoff(attempt: number, opts: { baseMs: number; maxMs: number }, rand: () => number): number {
  return opts.baseMs
}

export async function runWithRetries<T>(
  task: (attempt: number) => Promise<T>,
  opts: RetryOptions,
  clock: Clock,
  rand: () => number,
): Promise<Outcome<T>> {
  const value = await task(1)
  return { status: 'succeeded', value, attempts: 1 }
}
```

```ts solution
export function computeBackoff(attempt: number, opts: { baseMs: number; maxMs: number }, rand: () => number): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** (attempt - 1))
  return exp / 2 + (exp / 2) * rand()
}

export async function runWithRetries<T>(
  task: (attempt: number) => Promise<T>,
  opts: RetryOptions,
  clock: Clock,
  rand: () => number,
): Promise<Outcome<T>> {
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await task(attempt)
      return { status: 'succeeded', value, attempts: attempt }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (e instanceof PermanentError || attempt >= opts.maxAttempts) {
        return { status: 'failed', error, attempts: attempt }
      }
      await clock.sleep(computeBackoff(attempt, opts, rand))
    }
  }
}
```

```ts tests
const policy = { maxAttempts: 4, baseMs: 1000, maxMs: 60000 }
function fakeClock() {
  const slept: number[] = []
  return { slept, sleep: async (ms: number) => { slept.push(ms) } }
}
const zero = () => 0
const one = () => 1

test('first retry waits between base/2 and base', () => {
  expect(computeBackoff(1, policy, zero)).toBe(500)
  expect(computeBackoff(1, policy, one)).toBe(1000)
})
test('delay doubles per attempt', () => {
  expect(computeBackoff(3, policy, () => 0.5)).toBe(3000)
})
test('delay is capped at maxMs', () => {
  expect(computeBackoff(20, policy, zero)).toBe(30000)
  expect(computeBackoff(20, policy, one)).toBe(60000)
})
test('retries transient errors until success', async () => {
  const clock = fakeClock()
  const seen: number[] = []
  const out = await runWithRetries(async (n) => { seen.push(n); if (n < 3) throw new Error('timeout'); return 'ok' }, policy, clock, zero)
  expect(out).toEqual({ status: 'succeeded', value: 'ok', attempts: 3 })
  expect(seen).toEqual([1, 2, 3])
  expect(clock.slept).toEqual([500, 1000])
})
test('gives up after maxAttempts with the last error and no final sleep', async () => {
  const clock = fakeClock()
  const out = await runWithRetries(async (n) => { throw new Error(`boom ${n}`) }, policy, clock, zero)
  expect(out).toEqual({ status: 'failed', error: 'boom 4', attempts: 4 })
  expect(clock.slept).toEqual([500, 1000, 2000])
})
test('permanent errors are dead-lettered immediately', async () => {
  const clock = fakeClock()
  const out = await runWithRetries(async () => { throw new PermanentError('invalid story') }, policy, clock, zero)
  expect(out).toEqual({ status: 'failed', error: 'invalid story', attempts: 1 })
  expect(clock.slept).toEqual([])
})
```
:::

:::quiz id=cap-08-q2 xp=15
Why does the worker write a **lease** (`leased_until`) instead of simply keeping the claim
transaction (and its row lock) open until the job is done? Select all that apply.
- [ ] Row locks are not allowed on `jsonb` columns
- [x] A transaction held open for minutes pins a connection, blocks vacuum from cleaning up, and a crashed worker's lock is only released when the database notices the dead connection
- [x] With a lease, a dead worker's job becomes reclaimable after a known, bounded time, and progress can be observed from outside (status, `leased_by`)
- [ ] `SKIP LOCKED` only works with autocommit statements
> Long-running transactions are an anti-pattern in Postgres. They hold back the xmin horizon, so `VACUUM` cannot remove dead rows and tables bloat. They occupy a pool slot, and they hide state inside the transaction. A short claim statement plus a heartbeated lease gives the same exclusivity with explicit, observable state. The two distractors are made up: row locks work on any row whatever its column types, and `SKIP LOCKED` works in explicit transactions just as well as in autocommit statements.
:::

:::quiz id=cap-08-q3 xp=15
Worker A claims a publish job, renders it, and then freezes for 40 s (GC pause) before writing the
result. Meanwhile the 30 s lease expired and worker B reclaimed and finished the job. What keeps
the data correct?
- [ ] Nothing, this cannot happen because heartbeats prevent it
- [x] A's final `UPDATE … WHERE leased_by = 'A'` matches 0 rows (fencing), and the publish upsert is idempotent, so running the job twice yields the same published story
- [ ] Postgres aborts A's connection automatically when the lease expires
- [ ] B detects A and waits for it to finish
> Leases give **at-least-once** execution, never exactly-once. Correctness comes from two things together: fenced state transitions, and handlers whose side effects are idempotent (upserts keyed by project, deterministic output, slugs that never change). "Heartbeats prevent it" is the tempting wrong answer. A heartbeat is just more code running on the frozen worker, so during a 40 s pause it doesn't run either. Postgres knows nothing about your `leased_until` column, so it does not abort anything, and B has no way of knowing that A is still alive.
:::

## Lab 2: the publish pipeline, end to end on the server

:::lab id=cap-08-lab2 xp=150
title: PlayerBuilder, an idempotent publish handler, and the API side

**1. The player format: `worker/BranchStory.Worker/Publishing/PlayerModel.cs`**

The player JSON is a *different* shape from the editor doc on purpose: it is the public contract
(stable, versioned with `format`, minimal), while the editor doc may grow internal fields
(positions, comments, drafts) at any time. The worker reads the doc as a *tolerant reader*: its
own records, unknown fields ignored, so it does not depend on the API's DbContext.

```csharp
using System.Text.Json;

namespace BranchStory.Worker.Publishing;

// Editor document (input, as stored in projects.doc). Unknown fields such as x/y are ignored.
public sealed record StoryDoc(string? StartNodeId, List<StoryNode>? Nodes, List<StoryEdge>? Edges);
public sealed record StoryNode(string Id, string? Title, string? Text, string? MediaUrl);
public sealed record StoryEdge(string Id, string From, string To, string? Label);

// Player document (output, public contract).
public sealed record PlayerStory(int Format, string Title, int Version, string Start, Dictionary<string, PlayerScene> Scenes);
public sealed record PlayerScene(string Title, string Text, string? Media, IReadOnlyList<PlayerChoice> Choices, bool End);
public sealed record PlayerChoice(string Label, string To);

public static class PlayerJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}
```

**2. `worker/BranchStory.Worker/Publishing/PlayerBuilder.cs`**: pure, deterministic, unit-testable

```csharp
using System.Text.Json;
using BranchStory.Worker.Jobs;

namespace BranchStory.Worker.Publishing;

public static class PlayerBuilder
{
    public static PlayerStory Build(string title, int version, string docJson)
    {
        StoryDoc? doc;
        try { doc = JsonSerializer.Deserialize<StoryDoc>(docJson, PlayerJson.Options); }
        catch (JsonException ex) { throw new PermanentJobException($"story document is not valid JSON: {ex.Message}"); }

        if (doc?.Nodes is not { Count: > 0 } nodes) throw new PermanentJobException("story has no scenes");

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var n in nodes)
            if (string.IsNullOrWhiteSpace(n.Id) || !ids.Add(n.Id))
                throw new PermanentJobException($"scene id '{n.Id}' is empty or duplicated");

        if (doc.StartNodeId is not { } start || !ids.Contains(start))
            throw new PermanentJobException("story has no valid start scene");

        var edges = doc.Edges ?? [];
        foreach (var e in edges)
            if (!ids.Contains(e.From) || !ids.Contains(e.To))
                throw new PermanentJobException($"choice '{e.Id}' points at a missing scene");

        // Only scenes reachable from the start are shipped: unfinished drafts stay private.
        var reachable = Reachable(start, edges);
        var byFrom = edges.ToLookup(e => e.From, StringComparer.Ordinal);
        var scenes = new Dictionary<string, PlayerScene>(StringComparer.Ordinal);
        foreach (var n in nodes)
        {
            if (!reachable.Contains(n.Id)) continue;
            var choices = byFrom[n.Id]
                .Select((e, i) => new PlayerChoice(string.IsNullOrWhiteSpace(e.Label) ? $"Choice {i + 1}" : e.Label.Trim(), e.To))
                .ToList();
            scenes[n.Id] = new PlayerScene(
                Title: n.Title?.Trim() ?? "",
                Text: n.Text ?? "",
                Media: SafeMediaUrl(n.MediaUrl),
                Choices: choices,
                End: choices.Count == 0);
        }

        return new PlayerStory(Format: 1, Title: title, Version: version, Start: start, Scenes: scenes);
    }

    /// <summary>Only absolute http(s) URLs reach the public player: no javascript:, data: or relative paths.</summary>
    public static string? SafeMediaUrl(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp)
            ? u.AbsoluteUri
            : null;

    private static HashSet<string> Reachable(string start, IEnumerable<StoryEdge> edges)
    {
        var next = edges.ToLookup(e => e.From, e => e.To, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal) { start };
        var queue = new Queue<string>([start]);
        while (queue.TryDequeue(out var id))
            foreach (var to in next[id])
                if (seen.Add(to)) queue.Enqueue(to);
        return seen;
    }
}
```

**3. `worker/BranchStory.Worker/Publishing/Slug.cs`**

```csharp
using System.Globalization;
using System.Text;

namespace BranchStory.Worker.Publishing;

public static class Slug
{
    /// <summary>"Der Wald, Teil 2!" + project id → "der-wald-teil-2-3f2a9c1b". Unique because the id is.</summary>
    public static string For(string title, Guid projectId)
    {
        var sb = new StringBuilder();
        foreach (var ch in title.Normalize(NormalizationForm.FormD).ToLowerInvariant())
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue; // é → e
            if (char.IsAsciiLetterOrDigit(ch)) sb.Append(ch);
            else if (sb.Length > 0 && sb[^1] != '-') sb.Append('-');
            if (sb.Length >= 40) break;
        }
        var stem = sb.ToString().Trim('-');
        return $"{(stem.Length == 0 ? "story" : stem)}-{projectId.ToString("N")[..8]}";
    }
}
```

**4. `worker/BranchStory.Worker/Publishing/PublishStoryHandler.cs`**: idempotent by construction

```csharp
using System.Text.Json;
using BranchStory.Worker.Jobs;
using Npgsql;

namespace BranchStory.Worker.Publishing;

public sealed class PublishStoryHandler(NpgsqlDataSource db, ILogger<PublishStoryHandler> log) : IJobHandler
{
    public string Kind => "publish";

    public async Task<string?> HandleAsync(ClaimedJob job, CancellationToken ct)
    {
        await using var conn = await db.OpenConnectionAsync(ct);

        string title, docJson;
        int version;
        await using (var read = new NpgsqlCommand("SELECT title, doc::text, version FROM projects WHERE id = @id", conn))
        {
            read.Parameters.AddWithValue("id", job.ProjectId);
            await using var r = await read.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct)) throw new PermanentJobException($"project {job.ProjectId} no longer exists");
            (title, docJson, version) = (r.GetString(0), r.GetString(1), r.GetInt32(2));
        }

        var player = PlayerBuilder.Build(title, version, docJson);
        var playerJson = JsonSerializer.Serialize(player, PlayerJson.Options);

        // Upsert keyed by project: running this twice is harmless. The slug is set on first publish
        // and never updated, so renaming a story does not break links people already shared.
        // "source_version <=" keeps a slow, older run from overwriting a newer publish.
        await using (var upsert = new NpgsqlCommand("""
            INSERT INTO published_stories (project_id, slug, source_version, player_json, published_at)
            VALUES (@project, @slug, @version, @player::jsonb, now())
            ON CONFLICT (project_id) DO UPDATE
               SET source_version = EXCLUDED.source_version,
                   player_json    = EXCLUDED.player_json,
                   published_at   = now()
             WHERE published_stories.source_version <= EXCLUDED.source_version
            """, conn))
        {
            upsert.Parameters.AddWithValue("project", job.ProjectId);
            upsert.Parameters.AddWithValue("slug", Slug.For(title, job.ProjectId));
            upsert.Parameters.AddWithValue("version", version);
            upsert.Parameters.AddWithValue("player", playerJson);
            await upsert.ExecuteNonQueryAsync(ct);
        }

        log.LogInformation("Published project {ProjectId} v{Version} ({Scenes} scenes)", job.ProjectId, version, player.Scenes.Count);
        return $"v{version}, {player.Scenes.Count} scenes";
    }
}
```

Now enable it in the worker's `Program.cs` by uncommenting the registration line:

```csharp
builder.Services.AddSingleton<IJobHandler, BranchStory.Worker.Publishing.PublishStoryHandler>();
```

**5. API: the publishing feature: `api/BranchStory.Api/Features/Publishing/PublishingEndpoints.cs`**

The API side reuses everything you built: `ProjectGate` for authorization, `PlanLimits` and
`QuotaProblems` for the owner's quota, and EF Core entities for the insert. `PublishAsync` answers
in one of five ways, checked in this order:

1. **No or oversized `Idempotency-Key`** → `400`. The client must say which *intent* this is.
2. **`ProjectGate` (Edit)** → `404` for strangers, `403` for viewers. Only editors and owners get
   further, so a viewer replaying a known key is still refused.
3. **Key seen before** (double click, retry after a timeout) → `202` with the **original** job.
   The key is scoped to the user (`publish:<userId>:<key>`), so two users can't collide.
4. **A publish of this project is still `queued`** → `202` with *that* job. It hasn't started
   yet, so it will read the latest document anyway. A second job would only burn quota.
5. Otherwise, under a per-owner **advisory lock**: check the daily quota (`403` plan-limit if it is
   used up), insert the job, and return `202`. The unique index on `idempotency_key` catches the
   last race (two requests with the same key in the same millisecond).

`pg_advisory_xact_lock(n)` is a lock on a *number* rather than a row. Whoever holds it makes
everyone else asking for the same number wait until their transaction ends. Without it, two
concurrent publishes could both count "4 of 5 used" and both insert.

```csharp
using System.Text.Json;
using BranchStory.Api.Authorization;
using BranchStory.Api.Quotas;
using BranchStory.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace BranchStory.Api.Features.Publishing;

public sealed record PublishAccepted(long JobId, string Status);
public sealed record JobStatusDto(long Id, Guid ProjectId, string Kind, string Status, int Attempts, string? Error, string? Slug);

public static class PublishingEndpoints
{
    public static IServiceCollection AddPublishing(this IServiceCollection services) =>
        services.AddHostedService<JobEventsListener>();

    /// <summary>Call on the authenticated "/api" group.</summary>
    public static RouteGroupBuilder MapPublishingEndpoints(this RouteGroupBuilder api)
    {
        api.MapPost("/projects/{id:guid}/publish", PublishAsync).WithTags("Publishing").WithName("PublishProject");
        api.MapGet("/jobs/{jobId:long}", GetJobAsync).WithTags("Publishing").WithName("GetJob");
        api.MapGet("/public/stories/{slug}", GetPublicStoryAsync).AllowAnonymous().WithTags("Public").WithName("GetPublicStory");
        return api;
    }

    private static async Task<Results<Accepted<PublishAccepted>, ProblemHttpResult>> PublishAsync(
        Guid id,
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey,
        ProjectGate gate,
        BranchStoryDbContext db,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 100)
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "Idempotency-Key header required",
                detail: "Send one unique key (1-100 chars) per publish intent and resend the same key when retrying.");

        var check = await gate.CheckAsync(id, ProjectRequirements.Edit, ct);
        if (check.Problem is { } problem) return problem;
        var access = check.Access!;
        var key = $"publish:{access.UserId:N}:{idempotencyKey}";

        // Same intent again (double click, client retry after a timeout): answer with the original job.
        if (await FindJobIdAsync(db, key, ct) is long same) return Accepted(same);

        // A publish that has not started yet will read the latest doc anyway: coalesce instead of queueing twice.
        var queued = await db.Jobs
            .Where(j => j.ProjectId == id && j.Kind == JobKinds.Publish && j.Status == JobStatus.Queued)
            .OrderBy(j => j.Id).Select(j => (long?)j.Id).FirstOrDefaultAsync(ct);
        if (queued is long queuedId) return Accepted(queuedId);

        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // The quota is the OWNER's. The advisory lock serializes concurrent publishes of one owner,
        // so two requests can't both read "4 of 5" and both get in.
        await db.Database.ExecuteSqlAsync(
            $"SELECT pg_advisory_xact_lock(hashtextextended({access.OwnerId.ToString()}, 42))", ct);
        var limit = PlanLimits.For(access.OwnerPlan).PublishesPerDay;
        var since = DateTimeOffset.UtcNow.AddDays(-1);
        var usedToday = await db.Jobs.CountAsync(j =>
            j.Kind == JobKinds.Publish && j.CreatedAt > since &&
            db.Projects.Any(p => p.Id == j.ProjectId && p.OwnerId == access.OwnerId), ct);
        if (usedToday >= limit) return QuotaProblems.Exceeded("publishes per day", limit, access.OwnerPlan);

        var job = new Job
        {
            Kind = JobKinds.Publish,
            ProjectId = id,
            IdempotencyKey = key,
            Payload = JsonSerializer.Serialize(new { requestedBy = access.UserId }),
        };
        db.Jobs.Add(job);
        try
        {
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            // A concurrent request with the same key won the race: return its job.
            await tx.RollbackAsync(ct);
            db.ChangeTracker.Clear();
            return Accepted((await FindJobIdAsync(db, key, ct))!.Value);
        }
        return Accepted(job.Id);
    }

    private static async Task<Results<Ok<JobStatusDto>, ProblemHttpResult>> GetJobAsync(
        long jobId, ProjectGate gate, BranchStoryDbContext db, CancellationToken ct)
    {
        var job = await db.Jobs.AsNoTracking().Where(j => j.Id == jobId)
            .Select(j => new { j.Id, j.ProjectId, j.Kind, j.Status, j.Attempts, j.LastError })
            .SingleOrDefaultAsync(ct);
        if (job is null) return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Job not found");

        var check = await gate.CheckAsync(job.ProjectId, ProjectRequirements.View, ct);
        if (check.Problem is { } problem) return problem;

        var slug = job.Status == JobStatus.Succeeded
            ? await db.PublishedStories.Where(s => s.ProjectId == job.ProjectId).Select(s => s.Slug).SingleOrDefaultAsync(ct)
            : null;
        return TypedResults.Ok(new JobStatusDto(job.Id, job.ProjectId, job.Kind, job.Status, job.Attempts, job.LastError, slug));
    }

    private static async Task<Results<ContentHttpResult, NotFound>> GetPublicStoryAsync(
        string slug, BranchStoryDbContext db, HttpResponse response, CancellationToken ct)
    {
        var json = await db.PublishedStories.AsNoTracking()
            .Where(s => s.Slug == slug).Select(s => s.PlayerJson).SingleOrDefaultAsync(ct);
        if (json is null) return TypedResults.NotFound();
        response.Headers.CacheControl = "public, max-age=60";
        return TypedResults.Text(json, "application/json");
    }

    private static Task<long?> FindJobIdAsync(BranchStoryDbContext db, string key, CancellationToken ct) =>
        db.Jobs.Where(j => j.IdempotencyKey == key).Select(j => (long?)j.Id).SingleOrDefaultAsync(ct);

    private static Accepted<PublishAccepted> Accepted(long jobId) =>
        TypedResults.Accepted($"/api/jobs/{jobId}", new PublishAccepted(jobId, JobStatus.Queued));
}
```

:::info title="Why 403 and not 429 for the quota?"
cap-04 decided that every plan limit is a `403` ProblemDetails of type `…/problems/plan-limit`,
because waiting does not help a free owner who used up the day (and `429` invites automatic
retries). Reusing `QuotaProblems` keeps the API consistent: the frontend handles every plan limit
with one code path.
:::

**6. Push job status to the editor: `api/BranchStory.Api/Features/Publishing/JobEventsListener.cs`**

```csharp
using System.Text.Json;
using BranchStory.Api.Realtime;
using BranchStory.Data;
using Microsoft.AspNetCore.SignalR;
using Npgsql;

namespace BranchStory.Api.Features.Publishing;

/// <summary>
/// Holds one dedicated connection that LISTENs on job_events and relays every notification to the
/// project's SignalR group. Every API replica runs one, so every replica's clients hear every event
/// with no SignalR backplane needed for this path.
/// </summary>
public sealed class JobEventsListener(
    IConfiguration config,
    IHubContext<StoryHub, IStoryClient> hub,
    ILogger<JobEventsListener> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var connectionString = config.GetConnectionString(DataServiceExtensions.ConnectionStringName)
            ?? throw new InvalidOperationException("ConnectionStrings:BranchStory is not configured");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var conn = new NpgsqlConnection(connectionString);
                await conn.OpenAsync(stoppingToken);
                conn.Notification += OnNotification;
                await using (var listen = new NpgsqlCommand("LISTEN job_events", conn))
                    await listen.ExecuteNonQueryAsync(stoppingToken);
                log.LogInformation("Listening on job_events");
                while (!stoppingToken.IsCancellationRequested)
                    await conn.WaitAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "job_events listener dropped; reconnecting in 5 s");
                try { await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken); } catch (OperationCanceledException) { return; }
            }
        }
    }

    private void OnNotification(object sender, NpgsqlNotificationEventArgs e)
    {
        JobStatusDto? job;
        try { job = JsonSerializer.Deserialize<JobStatusDto>(e.Payload, JsonSerializerOptions.Web); }
        catch (JsonException ex) { log.LogWarning(ex, "Ignoring malformed job_events payload"); return; }
        if (job is not null) _ = BroadcastAsync(job);
    }

    private async Task BroadcastAsync(JobStatusDto job)
    {
        try { await hub.Clients.Group(StoryHub.GroupName(job.ProjectId)).JobUpdated(job); }
        catch (Exception ex) { log.LogWarning(ex, "Broadcasting job {JobId} failed", job.Id); }
    }
}
```

Add the new message to `IStoryClient` in `api/BranchStory.Api/Realtime/RealtimeContracts.cs` (cap-07), with
`using BranchStory.Api.Features.Publishing;` at the top of that file:

```csharp
public interface IStoryClient
{
    Task PresenceChanged(Guid projectId, IReadOnlyList<PresenceUser> users);
    Task PatchReceived(Guid projectId, string fromUserId, StoryPatchDto patch);
    Task DocSaved(Guid projectId, int version, string byUserId);
    Task AccessRevoked(Guid projectId);
    Task JobUpdated(JobStatusDto job);   // new: publish progress from the worker
}
```

Using `StoryHub.GroupName` here, exactly like the hub does when a client joins, matters: a
hand-typed group name that differs by one character makes broadcasts go to a group nobody is in,
and that bug fails *silently*.

**7. Wire it up in `api/BranchStory.Api/Program.cs`**

```csharp
using BranchStory.Api.Features.Publishing;

// … next to the other registrations
builder.Services.AddPublishing();

// … where the /api group is mapped
var api = app.MapGroup("/api").RequireAuthorization();
api.MapMe();
api.MapGroup("/projects").WithTags("Projects").MapProjectEndpoints();
api.MapGroup("/projects/{id:guid}/members").WithTags("Sharing").MapSharingEndpoints();
api.MapPublishingEndpoints();
```

**8. Try it with curl** (API on 5080, worker running)

```bash
TOKEN=$(curl -s -X POST localhost:5080/api/dev/token -H 'content-type: application/json' \
  -d '{"username":"ada"}' | jq -r .accessToken)
PROJECT=$(curl -s localhost:5080/api/projects -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')
KEY=$(uuidgen)

curl -si -X POST "localhost:5080/api/projects/$PROJECT/publish" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY"
# HTTP/1.1 202 Accepted   Location: /api/jobs/42   {"jobId":42,"status":"queued"}

# Same key again: same job id, no second row
curl -s -X POST "localhost:5080/api/projects/$PROJECT/publish" \
  -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $KEY"

curl -s -H "Authorization: Bearer $TOKEN" localhost:5080/api/jobs/42
# {"id":42,"projectId":"…","kind":"publish","status":"succeeded","attempts":1,"error":null,"slug":"opening-3f2a9c1b"}

curl -s localhost:5080/api/public/stories/opening-3f2a9c1b | jq .
```

:::warn title="LISTEN and connection poolers"
`LISTEN` needs a session that lives as long as the listener. PgBouncer in *transaction* pooling
mode silently breaks it. Point the listener at Postgres directly (or a session-mode pool), and add
`Keepalive=30` to the connection string so dead TCP connections are noticed and the loop
reconnects. Also remember NOTIFY is fire-and-forget: a client that was offline misses events,
which is why the UI also polls `GET /api/jobs/{id}` as a fallback.
:::

- [ ] Publishing a valid story produces one `published_stories` row whose `player_json` has only reachable scenes and `format: 1`
- [ ] Repeating the request with the same `Idempotency-Key` returns the same `jobId` and creates no new job row
- [ ] A viewer gets `403`, a stranger gets `404`, and a free owner's 6th publish within 24 h gets the plan-limit ProblemDetails, also when an editor on a Pro plan presses the button
- [ ] A story without a start scene ends as `failed` after **one** attempt with a readable `last_error`
- [ ] Renaming the project and publishing again keeps the slug and bumps `source_version`
- [ ] `GET /api/public/stories/{slug}` works without a token and sends `Cache-Control: public, max-age=60`
:::

## Lab 3: publish button, live status and the public player

:::lab id=cap-08-lab3 xp=120
title: PublishButton, JobUpdated over SignalR, and PlayerPage

**1. `web/src/modules/publish/api.ts`**

```ts
import { apiFetch } from '../../lib/api'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface JobStatusDto {
  id: number
  projectId: string
  kind: string
  status: JobStatus
  attempts: number
  error: string | null
  slug: string | null
}

export interface PublishAccepted { jobId: number; status: JobStatus }

export interface PlayerChoice { label: string; to: string }
export interface PlayerScene { title: string; text: string; media: string | null; choices: PlayerChoice[]; end: boolean }
export interface PlayerStory { format: number; title: string; version: number; start: string; scenes: Record<string, PlayerScene> }

export const jobKey = (id: number) => ['job', id] as const
export const isTerminal = (s: JobStatus) => s === 'succeeded' || s === 'failed'

export function publishProject(projectId: string, idempotencyKey: string) {
  return apiFetch<PublishAccepted>(`/api/projects/${encodeURIComponent(projectId)}/publish`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
  })
}

export function getJob(jobId: number) {
  return apiFetch<JobStatusDto>(`/api/jobs/${jobId}`)
}

/** Public and anonymous: plain fetch, no token. */
export async function getPublicStory(slug: string): Promise<PlayerStory> {
  const res = await fetch(`/api/public/stories/${encodeURIComponent(slug)}`)
  if (res.status === 404) throw new Error('not-found')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as PlayerStory
}
```

**2. `web/src/modules/publish/PublishButton.tsx`**

```tsx
import { useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Button } from '../ui'
import { getJob, isTerminal, jobKey, publishProject } from './api'

export function PublishButton({ projectId, disabled = false }: { projectId: string; disabled?: boolean }) {
  const [jobId, setJobId] = useState<number | null>(null)
  // One key per publish *intent*: a network retry reuses it, a new click after success gets a new one.
  const intentKey = useRef<string | null>(null)

  const publish = useMutation({
    mutationFn: () => {
      intentKey.current ??= crypto.randomUUID()
      return publishProject(projectId, intentKey.current)
    },
    onSuccess: (accepted) => {
      intentKey.current = null
      setJobId(accepted.jobId)
    },
  })

  // SignalR pushes updates into this cache entry (step 3); polling is only the safety net.
  const job = useQuery({
    queryKey: jobKey(jobId ?? 0),
    queryFn: () => getJob(jobId!),
    enabled: jobId !== null,
    refetchInterval: (q) => (q.state.data && isTerminal(q.state.data.status) ? false : 5000),
  })

  const data = job.data
  const busy = publish.isPending || (data !== undefined && !isTerminal(data.status))

  return (
    <div className="bs-publish">
      <Button variant="primary" onClick={() => publish.mutate()} disabled={disabled || busy} aria-describedby="publish-status">
        {busy ? 'Publishing…' : 'Publish'}
      </Button>
      <p id="publish-status" role="status" aria-live="polite" className="bs-muted">
        {publish.isError && `Could not start publishing: ${publish.error.message}`}
        {data?.status === 'queued' && (data.attempts > 0 ? `Retrying (attempt ${data.attempts + 1})…` : 'Queued…')}
        {data?.status === 'running' && 'Rendering the player…'}
        {data?.status === 'succeeded' && data.slug && (
          <>Published. <a href={`/play/${data.slug}`} target="_blank" rel="noreferrer">Open the player</a></>
        )}
        {data?.status === 'failed' && `Publishing failed: ${data.error ?? 'unknown error'}`}
      </p>
    </div>
  )
}
```

**3. Route `JobUpdated` into the query cache**

One hub connection per page serves presence, patches *and* job status. Extend cap-07's hook in
`web/src/modules/realtime/useStoryHub.ts` with an optional handler:

```ts
import type { JobStatusDto } from '../publish/api'

export interface StoryHubOptions {
  // … the existing fields from cap-07
  onJobUpdated?: (job: JobStatusDto) => void
}

// next to the other useEffectEvent callbacks
const onJob = useEffectEvent((job: JobStatusDto) => handlers.onJobUpdated?.(job))

// inside the connection effect, next to conn.on('DocSaved', …)
conn.on('JobUpdated', (job: JobStatusDto) => {
  if (isThis(job.projectId)) onJob(job)
})
```

Then, in `web/src/modules/editor/EditorPage.tsx`, pass the handler and render the button. The
inner `Editor` component from cap-07 already has `const qc = useQueryClient()`, so reuse it. A
second `import { useQueryClient }` would be a duplicate-identifier compile error.

```tsx
// add next to the other imports
import { jobKey } from '../publish/api'
import { PublishButton } from '../publish/PublishButton'

// inside Editor, extend the existing useStoryHub call
const hub = useStoryHub(project.id, {
  // … doc, baseVersion, canEdit and the handlers from cap-07
  onJobUpdated: (job) => qc.setQueryData(jobKey(job.id), job),
})

// in the toolbar JSX
<PublishButton projectId={project.id} disabled={readOnly} />
```

**4. `web/src/modules/player/PlayerPage.tsx`**: public, keyboard-first

```tsx
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { getPublicStory, type PlayerScene } from '../publish/api'

const isVideo = (url: string) => /\.(mp4|webm|ogg)(\?|$)/i.test(url)

function SceneMedia({ scene }: { scene: PlayerScene }) {
  if (!scene.media) return null
  return isVideo(scene.media)
    ? <video className="bs-player-media" src={scene.media} controls playsInline />
    : <img className="bs-player-media" src={scene.media} alt="" />
}

export function PlayerPage() {
  const { slug = '' } = useParams()
  const story = useQuery({ queryKey: ['public-story', slug], queryFn: () => getPublicStory(slug), retry: false })
  const [path, setPath] = useState<string[]>([])
  const heading = useRef<HTMLHeadingElement>(null)

  // Move focus to the new scene so keyboard and screen-reader users follow the story.
  useEffect(() => { if (path.length) heading.current?.focus() }, [path])

  if (story.isPending) return <main className="bs-player"><p role="status">Loading story…</p></main>
  if (story.isError) return <main className="bs-player"><h1>Story not found</h1><p>The link may be wrong or the story was unpublished.</p></main>

  const s = story.data
  const currentId = path.at(-1) ?? s.start
  const scene = s.scenes[currentId]

  return (
    <main className="bs-player">
      <h1>{s.title}</h1>
      <article aria-labelledby="scene-title" className="bs-card bs-stack">
        <h2 id="scene-title" ref={heading} tabIndex={-1}>{scene.title || 'Untitled scene'}</h2>
        <SceneMedia scene={scene} />
        <p>{scene.text}</p>
        {scene.end ? (
          <p><strong>The end.</strong></p>
        ) : (
          <nav aria-label="Choices">
            <ul className="bs-stack">
              {scene.choices.map((c) => (
                <li key={`${currentId}-${c.to}-${c.label}`}>
                  <button type="button" className="bs-btn bs-btn--secondary" onClick={() => setPath([...path, c.to])}>{c.label}</button>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </article>
      <div className="bs-row">
        <button type="button" className="bs-btn bs-btn--ghost" onClick={() => setPath(path.slice(0, -1))} disabled={path.length === 0}>Back</button>
        <button type="button" className="bs-btn bs-btn--ghost" onClick={() => setPath([])} disabled={path.length === 0}>Start over</button>
      </div>
    </main>
  )
}
```

**5. Register the route outside `RequireAuth`.** In `web/src/app/router.tsx`, next to `/login`:

```tsx
{
  path: '/play/:slug',
  lazy: async () => {
    const { PlayerPage } = await import('../modules/player/PlayerPage')
    return { Component: PlayerPage }
  },
},
```

**6. Watch it live.** Open the editor, press **Publish**, and watch the status line go
`Queued… → Rendering the player… → Published.` without a reload. Stop the worker, press Publish
again: the status stays at `Queued…` (nothing is lost). Start the worker: it finishes within a
second. Then break the story (delete the start scene) and publish: you see the dead-letter message.

:::pro title="Push for speed, poll for truth"
Real-time channels drop messages: reconnects, deploys, laptops going to sleep. Treat SignalR as a
latency optimization over a source of truth you can always re-read (`GET /api/jobs/{id}`).
The slow poll costs almost nothing and makes the UI self-healing.
:::

- [ ] Clicking **Publish** shows queued, then running, then a link to the player, updated by `JobUpdated` (check the WebSocket frames in DevTools)
- [ ] With the worker stopped the job stays `Queued…`; restarting the worker completes it without another click
- [ ] Double-clicking **Publish** creates exactly one job (button disabled plus idempotency key)
- [ ] `/play/{slug}` works in a private window (no login), choices are reachable with Tab/Enter, and focus moves to the new scene heading
- [ ] A broken story shows "Publishing failed: …" with the worker's reason
:::

:::quiz id=cap-08-q4 xp=15
The API now runs as **three replicas**. A user's browser is connected over SignalR to replica B.
The worker finishes their publish job. How does the browser hear about it?
- [ ] It doesn't, unless you add a Redis backplane
- [x] Every replica LISTENs on `job_events`, so replica B also receives the NOTIFY and sends `JobUpdated` to its own connections in the project group
- [ ] The worker connects to the SignalR hub as a client
- [ ] Postgres sends the notification only to the replica that created the job
> NOTIFY is delivered to every session that LISTENs on the channel. Each replica relays to the clients *it* holds, so together they cover everyone. Hub messages that start in a client (live patches from cap-07) are a different story: those need a backplane once you scale out (cap-10).
:::

:::quiz id=cap-08-q5 xp=15
An app using an external broker does this in an endpoint:

```csharp
await db.SaveChangesAsync(ct);                 // 1. the story is marked "publish requested"
await bus.SendAsync(new PublishStory(id), ct); // 2. tell the workers
```

The pod is killed between line 1 and line 2. What is the result?
- [ ] The broker rolls back the database commit
- [x] The database says a publish was requested, but no message exists, so nothing is ever published
- [ ] The message is delivered twice when the pod restarts
- [ ] Nothing bad happens, because both calls are awaited
> This is the **dual write** problem. Two systems can't be committed atomically without a
> distributed transaction, and awaiting both calls only fixes their order. The Postgres queue
> avoids the problem, because the job row lives in the same database, so it can be inserted in the
> **same transaction** as the business change: both happen or neither does. Teams with a broker use
> the *transactional outbox*. They write the message to an `outbox` table in the same transaction,
> and a relay process forwards it to the broker afterwards. The distractors don't work: a broker
> can't roll back another system's commit, and a message that was never sent can't arrive twice.
> (Duplicates are the *opposite* failure. They happen when the send succeeds but the caller
> doesn't learn it and retries, which is why consumers must be idempotent.)
:::

:::quiz id=cap-08-q6 xp=15
Leases mean a job can run twice. Which of these handler steps would produce a **wrong result**
on the second run? Select all that apply.
- [ ] `INSERT INTO published_stories … ON CONFLICT (project_id) DO UPDATE SET player_json = EXCLUDED.player_json …`
- [x] `UPDATE users SET publish_count = publish_count + 1 WHERE id = @owner`
- [x] Sending the "Your story is live!" email directly from the handler
- [ ] Building the slug with `Slug.For(title, projectId)`
> Upserts and pure functions of the input are idempotent: running them again writes the same
> row and computes the same slug. A `+ 1` counts every *run*, not every publish, so a reclaimed job
> is billed twice. Derive counts from rows instead (`count(*)` of jobs, as the quota does). An email
> is an external side effect that can't be undone, so a second run sends a second email. Typical
> fixes: pass the job id as the idempotency key to an email provider that supports one, or keep a
> `sent_emails` row with a unique key per job and skip the send when it already exists.
:::

:::cards id=cap-08-cards1 xp=20 title="Background jobs"
Q: What does `202 Accepted` promise?
A: Only that the request was recorded. The work happens later; the `Location` header points at a status resource (`/api/jobs/42`) to check.
Q: What is the dual-write problem?
A: Committing to the database and publishing to a broker are two separate operations; a crash between them leaves the two disagreeing. Same-database enqueue (or an outbox table) fixes it.
Q: What does `FOR UPDATE SKIP LOCKED` do in a claim query?
A: Locks the selected rows and silently skips rows another transaction has locked, so many workers take different jobs in parallel without blocking.
Q: What is a lease?
A: A `leased_until` timestamp the worker sets on claim and extends with a heartbeat. If the worker dies, the lease expires and another worker can reclaim the job.
Q: What is fencing?
A: Guarding every state change with `WHERE leased_by = @me`, so a worker that lost its lease cannot overwrite the new owner's result.
Q: Why must job handlers be idempotent?
A: Leases give at-least-once delivery: a crash or timeout can run the same job twice. Upserts and deterministic output make the second run harmless.
Q: Exponential backoff with jitter: why the jitter?
A: Without it, all workers that failed together retry together (thundering herd). Randomizing part of the delay spreads the retries out.
Q: Transient vs permanent failure?
A: Transient (timeout, 503, deadlock) gets a retry with backoff. Permanent (invalid input, 404, deleted project) is dead-lettered immediately.
Q: What is a dead-letter queue?
A: Where jobs go after they exhausted their attempts or failed permanently (here: status `failed`): kept for inspection and alerting instead of retrying forever.
Q: Why an Idempotency-Key header on POST /publish?
A: So a client can safely retry after a timeout: the server recognizes the key and returns the original job instead of enqueueing a duplicate.
Q: Why is LISTEN/NOTIFY not enough on its own for job status?
A: NOTIFY is fire-and-forget: disconnected listeners miss events. Keep a queryable source of truth and poll as a fallback.
:::

## Recap

- The API **records intent** in `jobs` and answers `202`; the worker does the slow part and
  survives crashes. Enqueueing happens in the same database, so it can be transactional.
- A single `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)` claims atomically; **leases** with
  heartbeats bound the impact of dead workers; **fencing** stops zombies from writing; a reaper
  dead-letters jobs whose final attempt never finished.
- Retries use exponential backoff with jitter, permanent errors are **dead-lettered** at once,
  and graceful shutdown releases work without burning an attempt.
- The publish handler is **idempotent** (upsert by project, stable slug, monotonic
  `source_version`) and the player JSON is a separate, sanitized public contract.
- Authorization (`ProjectGate`) and the owner-billed quota (`PlanLimits`) are reused, serialized
  per owner with an advisory lock; an `Idempotency-Key` makes client retries safe.
- `pg_notify` → `LISTEN` in every API replica → SignalR group pushes status live; a slow poll is
  the safety net.
