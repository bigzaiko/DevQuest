---
id: db-15
title: Job Queues in PostgreSQL
level: expert
minutes: 45
xp: 250
summary: Build a durable background-job queue on Postgres — SKIP LOCKED claims, leases, retries with backoff, dead jobs, idempotency, transactional enqueue, LISTEN/NOTIFY and advisory locks.
---

When a studio user clicks **Render**, the API must not encode a 2-minute video inside the HTTP
request. It records *"encode project 6"* somewhere durable, answers `202 Accepted`, and a pool
of **workers** picks the job up, renders it, and reports back. That "somewhere" is a **job
queue**.

Many teams reach for Redis or RabbitMQ first. But if your data already lives in PostgreSQL, the
database can be an excellent queue: jobs are rows, claiming is an `UPDATE`, and — the killer
feature — **enqueueing is part of the same transaction as the business change**. Libraries like
**River** (Go), **Oban** (Elixir), **graphile-worker** and **pg-boss** (Node), **Solid Queue**
(Rails), **Procrastinate** (Python) and **Hangfire**'s PostgreSQL storage (.NET) are all built on
the techniques in this lesson.

A few words we'll use throughout:

- **Enqueue** — insert a job row (`status = 'queued'`).
- **Worker** — a background process (a .NET `BackgroundService`, a Node process, a K8s pod) that
  loops: find a job, do it, record the result.
- **Claim** — the moment a worker takes ownership of one job so that no other worker runs it.
- **Durable** — survives crashes and restarts, because it's committed to disk (unlike an
  in-memory `Channel<T>` or a `setTimeout`).

We'll use the studio `render_jobs` table and grow it into a production-grade queue.

## The jobs table

The studio dataset starts with a simple design:

```sql
CREATE TABLE render_jobs (
  id           integer PRIMARY KEY,
  project_id   integer     NOT NULL REFERENCES projects(id),
  kind         text        NOT NULL CHECK (kind IN ('encode','thumbnail','transition')),
  status       text        NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts     integer     NOT NULL DEFAULT 0,
  worker       text,
  created_at   timestamptz NOT NULL,
  started_at   timestamptz,
  finished_at  timestamptz
);
```

A production queue needs a few more columns. Several challenges below run on this **v2**
schema (added in their `setup`):

```sql
ALTER TABLE render_jobs
  ADD COLUMN run_at       timestamptz NOT NULL,   -- don't run before this (scheduling, backoff)
  ADD COLUMN locked_until timestamptz,            -- lease: the claim expires at this time
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN last_error   text;
-- status also allows 'dead': gave up after max_attempts
```

And the single most important index — a **partial index** containing only the rows workers
search for:

```sql
CREATE INDEX render_jobs_ready ON render_jobs (run_at, id) WHERE status = 'queued';
```

Done jobs pile up into millions of rows; the partial index stays tiny because it only holds
the queued ones, so finding the next job is a few page reads no matter how big the table gets.
The index only helps if the claim query **matches it**: the same `WHERE status = 'queued'`
predicate (so the planner can prove the partial index applies) and the same `ORDER BY run_at, id`
(so the first entries in the index *are* the next jobs, with no sort).

| Column | Why it exists |
|---|---|
| `status` | The job's state machine: `queued → running → done`, or `→ queued` again (retry), or `→ dead`. |
| `run_at` | Delayed jobs ("send the reminder in 24 h") and retry backoff. |
| `attempts` / `max_attempts` | Count tries; stop retrying poison jobs. |
| `worker`, `locked_until` | Who owns the job and until when (the **lease**). |
| `last_error` | Debugging and the dead-job dashboard. |

## The naive claim — and why it breaks

The obvious worker loop:

```sql
SELECT id FROM render_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1;  -- → 10
UPDATE render_jobs SET status = 'running', worker = 'worker-a' WHERE id = 10;
```

With one worker this works. With two:

| t | Worker A | Worker B |
|---|---|---|
| 1 | `SELECT … LIMIT 1` → **10** | |
| 2 | | `SELECT … LIMIT 1` → **10** (A hasn't updated yet) |
| 3 | `UPDATE … WHERE id = 10` ✅ | |
| 4 | | `UPDATE … WHERE id = 10` ✅ |
| 5 | renders project 4 | **also renders project 4** |

Both workers "won". The video is encoded twice, and the user may be charged twice. Adding
`AND status = 'queued'` to the `UPDATE` (a compare-and-swap) fixes the double processing — B's
update re-checks the row and affects 0 rows — but B then has to loop and try again, and with 20
workers they all stampede on the same oldest row.

:::quiz id=db-15-q1 xp=10
Workers run `SELECT id … WHERE status='queued' ORDER BY created_at LIMIT 1` and then
`UPDATE render_jobs SET status='running' WHERE id = $1` (no status condition), each in its own
autocommit statement. What can go wrong with several workers?

- [ ] Nothing — the `UPDATE` takes a row lock, so only one worker can claim the job
- [x] Two workers can read the same id and both run the job
- [ ] The second `UPDATE` fails with a unique violation
- [ ] Postgres serializes the two `SELECT`s, so they return different ids
> The row lock is taken only by the `UPDATE`, *after* both workers already decided which job to
> take. Plain `SELECT`s never block each other (MVCC). The check and the claim must be one
> atomic operation.
:::

:::sql id=db-15-sql1 db=studio xp=30
title: Which job is next?
Workers take jobs **first in, first out**. Return `id, project_id, kind` of the single queued
job that should run next: the oldest `created_at`, ties broken by the lower `id`.

hint: `WHERE status = 'queued' ORDER BY created_at, id LIMIT 1`

```sql starter
SELECT id, project_id, kind
FROM render_jobs
WHERE status = 'queued'
ORDER BY id
LIMIT 1;
```

```sql solution
SELECT id, project_id, kind
FROM render_jobs
WHERE status = 'queued'
ORDER BY created_at, id
LIMIT 1;
```
:::

## FOR UPDATE SKIP LOCKED

The fix is to **lock the row while choosing it**, and to let other workers **skip** rows that
are already locked instead of waiting:

```sql
UPDATE render_jobs
SET    status = 'running', attempts = attempts + 1, worker = $1, started_at = now()
WHERE  id = (
  SELECT id FROM render_jobs
  WHERE  status = 'queued'
  ORDER  BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT  1
)
RETURNING *;
```

- The subquery walks the queued rows in order and tries to lock each one.
- `FOR UPDATE` locks the chosen row for this transaction.
- `SKIP LOCKED` means: *if another transaction holds the lock, pretend the row isn't there* and
  move on to the next. No waiting, no stampede.
- The outer `UPDATE` flips the status, and `RETURNING *` hands the job to the worker in the same
  round trip.

| t | Worker A | Worker B |
|---|---|---|
| 1 | claim → subquery locks **10** | |
| 2 | | claim → 10 is locked → skipped → locks **7** |
| 3 | `UPDATE` 10 → running, `COMMIT` | `UPDATE` 7 → running, `COMMIT` |
| 4 | renders project 4 | renders project 6 |

Twenty workers claim twenty different jobs in parallel, each in about a millisecond.

Common mistakes with this query:

- **Forgetting `LIMIT`.** Without it the subquery locks *every* queued row it can, and the `=`
  comparison fails with *more than one row returned by a subquery*.
- **Forgetting `ORDER BY`.** It still works, but jobs come out in whatever order the plan
  produces — not FIFO, and starvation of old jobs becomes possible.
- **Using `SKIP LOCKED` without `FOR UPDATE`.** `SKIP LOCKED` is a modifier of a locking clause
  (`FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE`); on its own it's a syntax error.

:::info title="Two ways to hold a job"
1. **Lock for the whole job**: `BEGIN;` claim with `SKIP LOCKED`, do the work, mark done,
   `COMMIT`. If the worker dies, its connection drops, the transaction rolls back and the job
   is automatically available again. Simple — but a 5-minute render means a 5-minute open
   transaction (holding a connection and blocking vacuum), which doesn't scale.
2. **Claim and release** *(what most libraries do)*: claim + set `status='running'` and commit
   immediately; do the work outside any transaction; then mark done in a second short
   transaction. Scales well, but now a crashed worker leaves a job stuck in `running` — you
   need **leases** (next section).
:::

:::quiz id=db-15-q2 xp=15
Worker A has run the claim subquery inside an open transaction and holds the lock on job 10.
Worker B now runs the same `… FOR UPDATE SKIP LOCKED LIMIT 1` claim. What happens to B?

- [ ] B waits until A commits, then gets job 10
- [ ] B gets an error `could not obtain lock on row`
- [x] B immediately gets the next unlocked queued job (job 7)
- [ ] B gets 0 rows, because the first matching row is locked
> `SKIP LOCKED` skips rows locked by others and keeps scanning, so B claims the next job
> without waiting. Plain `FOR UPDATE` would make B wait for A; `FOR UPDATE NOWAIT` would raise
> an error instead. `SKIP LOCKED` gives an intentionally *inconsistent* view of the table —
> perfect for queues, wrong for almost everything else.
:::

:::sql id=db-15-sql2 db=studio xp=50
title: The claim query
You are `worker-d`. Claim the next job (oldest `created_at`, then `id`) with a single
`UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`: set `status = 'running'`,
increment `attempts`, set `worker = 'worker-d'` and `started_at = '2025-07-10 17:00+00'`.

Return `id, kind, status, attempts, worker` of the claimed job.

hint: The starter only *selects and locks* the job — wrap it in an `UPDATE`.
hint: `UPDATE render_jobs SET … WHERE id = (SELECT id FROM … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING …`

```sql starter
SELECT id, kind, status, attempts, worker
FROM render_jobs
WHERE status = 'queued'
ORDER BY created_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

```sql solution
UPDATE render_jobs
SET status = 'running',
    attempts = attempts + 1,
    worker = 'worker-d',
    started_at = '2025-07-10 17:00+00'
WHERE id = (
  SELECT id FROM render_jobs
  WHERE status = 'queued'
  ORDER BY created_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, kind, status, attempts, worker;
```
:::

## Batch claims and due jobs

Claiming one job per round trip caps a worker at a few thousand jobs per second. For small,
fast jobs (thumbnails, webhooks, emails) workers claim a **batch**:

```sql
UPDATE render_jobs
SET    status = 'running', attempts = attempts + 1, worker = $1,
       started_at = now(), locked_until = now() + interval '5 minutes'
WHERE  id IN (
  SELECT id FROM render_jobs
  WHERE  status = 'queued' AND run_at <= now()
  ORDER  BY run_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT  $2
)
RETURNING id, project_id, kind, attempts;
```

Two new ideas here:

- `run_at <= now()` — only **due** jobs. Delayed jobs and retries waiting out their backoff
  have a `run_at` in the future and stay invisible until then.
- `locked_until` — the claim is a **lease**: a promise "I'm working on it until 17:05". If the
  worker disappears, the lease runs out and the job can be reclaimed.

:::tip title="The CTE form of a batch claim"
Many libraries write the batch claim with the locking `SELECT` in a CTE and join against it:

```sql
WITH next AS (
  SELECT id FROM render_jobs
  WHERE  status = 'queued' AND run_at <= now()
  ORDER  BY run_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT  $2
)
UPDATE render_jobs j
SET    status = 'running', attempts = j.attempts + 1, worker = $1,
       started_at = now(), locked_until = now() + interval '5 minutes'
FROM   next
WHERE  j.id = next.id
RETURNING j.id, j.project_id, j.kind, j.attempts;
```

A CTE with `FOR UPDATE` is never inlined, so the locking `SELECT` is guaranteed to run exactly
once and the batch can never be bigger than `LIMIT`. With `IN (subquery)` the planner chooses how
to join; in rare plans a subquery is re-scanned, and with `SKIP LOCKED` a re-scan can return
*different* rows. Both forms are common in the wild; prefer the CTE in code you write.
:::

The challenges use a fixed clock — **assume `now()` is `'2025-07-10 17:00+00'`** — so the
results are deterministic.

:::sql id=db-15-sql3 db=studio ordered=true xp=60
title: Claim a batch of due jobs
On the v2 schema (see `setup`), `worker-d` claims **up to 4** jobs that are `queued` **and due**
(`run_at <= '2025-07-10 17:00+00'`), oldest `run_at` first (then `id`). For each claimed job set
`status = 'running'`, `attempts = attempts + 1`, `worker = 'worker-d'`,
`started_at = '2025-07-10 17:00+00'` and `locked_until = '2025-07-10 17:05+00'`.

The checker reads `id, status, attempts, worker, locked_until` of worker-d's jobs by id.

hint: Job 13 is a retry scheduled for 17:02 — it must not be claimed yet.
hint: `WHERE id IN (SELECT id … WHERE status = 'queued' AND run_at <= … ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 4)`

```sql setup
ALTER TABLE render_jobs
  ADD COLUMN run_at       timestamptz,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN last_error   text;
UPDATE render_jobs SET run_at = created_at;
ALTER TABLE render_jobs ALTER COLUMN run_at SET NOT NULL;
ALTER TABLE render_jobs DROP CONSTRAINT render_jobs_status_check;
ALTER TABLE render_jobs ADD CONSTRAINT render_jobs_status_check
  CHECK (status IN ('queued','running','done','failed','dead'));
UPDATE render_jobs SET locked_until = started_at + interval '5 minutes' WHERE status = 'running';
INSERT INTO render_jobs (id, project_id, kind, status, attempts, worker, created_at, started_at, run_at, locked_until) VALUES
  (13, 3, 'thumbnail', 'queued',  1, NULL,       '2025-07-10 16:50+00', NULL,                     '2025-07-10 17:02+00', NULL),
  (14, 1, 'encode',    'running', 1, 'worker-b', '2025-07-10 16:58+00', '2025-07-10 16:58:30+00', '2025-07-10 16:58+00', '2025-07-10 17:03:30+00'),
  (15, 5, 'encode',    'running', 3, 'worker-a', '2025-07-10 16:20+00', '2025-07-10 16:40+00',    '2025-07-10 16:20+00', '2025-07-10 16:45+00');
```

```sql starter
UPDATE render_jobs
SET status = 'running', attempts = attempts + 1, worker = 'worker-d',
    started_at = '2025-07-10 17:00+00', locked_until = '2025-07-10 17:05+00'
WHERE id IN (
  SELECT id FROM render_jobs
  WHERE status = 'queued'
  ORDER BY run_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 4
);
```

```sql solution
UPDATE render_jobs
SET status = 'running', attempts = attempts + 1, worker = 'worker-d',
    started_at = '2025-07-10 17:00+00', locked_until = '2025-07-10 17:05+00'
WHERE id IN (
  SELECT id FROM render_jobs
  WHERE status = 'queued' AND run_at <= '2025-07-10 17:00+00'
  ORDER BY run_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 4
);
```

```sql check
SELECT id, status, attempts, worker, locked_until
FROM render_jobs WHERE worker = 'worker-d' ORDER BY id;
```
:::

## Leases, heartbeats and the reaper

With claim-and-release, a job in `running` is just a row that says so. If the worker process is
OOM-killed, the pod is evicted, or the node loses power, nobody will ever mark it done.
**Leases** solve this:

1. **Claim** sets `locked_until = now() + lease` (say 5 minutes).
2. A long job sends **heartbeats**:
   `UPDATE render_jobs SET locked_until = now() + interval '5 minutes' WHERE id = $1 AND worker = $2`.
   If that returns 0 rows, the worker has *lost* the job (it was reclaimed) and should stop.
3. A **reaper** (a periodic query — run by every worker, or by one elected worker) finds
   expired leases and puts the jobs back in the queue, or buries them if they're out of
   attempts.

This is exactly SQS's *visibility timeout*: a received message becomes visible again if it
isn't deleted in time.

:::quiz id=db-15-q3 xp=15
`worker-c` claimed job 6 at 12:06 (claim-and-release, lease 5 minutes) and its pod was killed
at 12:07. There is **no** reaper. What is the state of job 6 a week later?

- [ ] `queued` — Postgres rolled back the claim when the connection dropped
- [x] `running`, forever: the claim was committed, and nothing ever moves it again
- [ ] `failed` — `statement_timeout` aborted it
- [ ] `done`, because the `UPDATE` committed
> The claim committed before the work started, so the connection dropping changes nothing —
> Postgres only rolls back *open* transactions, and this one was finished at 12:06. (`queued`
> would be right for the lock-for-the-whole-job style, where the claim is still uncommitted when
> the worker dies.) `statement_timeout` only limits a running statement, and no statement is
> running. That is the classic "stuck job" in a homegrown queue — look at job 6 in the studio
> data. Leases + a reaper (or the lock-for-the-whole-job style) are mandatory.
:::

:::sql id=db-15-sql4 db=studio xp=60
title: The reaper
Assume now is `'2025-07-10 17:00+00'`. On the v2 schema, handle every `running` job whose lease
has **expired** (`locked_until < now`):

- if `attempts >= max_attempts` → `status = 'dead'` (keep its `run_at`)
- otherwise → `status = 'queued'` and `run_at = now` (retry right away)
- in both cases: `worker = NULL`, `locked_until = NULL`, `last_error = 'lease expired'`

Jobs with a valid lease must not be touched. One or two statements are fine. The checker reads
`id, status, worker, locked_until, run_at, last_error` for jobs 6, 14 and 15.

hint: Job 6's lease ran out in July; job 14 is healthy until 17:03:30; job 15 is on its 3rd attempt.
hint: `SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END, run_at = CASE … END`

```sql setup
ALTER TABLE render_jobs
  ADD COLUMN run_at       timestamptz,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN last_error   text;
UPDATE render_jobs SET run_at = created_at;
ALTER TABLE render_jobs ALTER COLUMN run_at SET NOT NULL;
ALTER TABLE render_jobs DROP CONSTRAINT render_jobs_status_check;
ALTER TABLE render_jobs ADD CONSTRAINT render_jobs_status_check
  CHECK (status IN ('queued','running','done','failed','dead'));
UPDATE render_jobs SET locked_until = started_at + interval '5 minutes' WHERE status = 'running';
INSERT INTO render_jobs (id, project_id, kind, status, attempts, worker, created_at, started_at, run_at, locked_until) VALUES
  (13, 3, 'thumbnail', 'queued',  1, NULL,       '2025-07-10 16:50+00', NULL,                     '2025-07-10 17:02+00', NULL),
  (14, 1, 'encode',    'running', 1, 'worker-b', '2025-07-10 16:58+00', '2025-07-10 16:58:30+00', '2025-07-10 16:58+00', '2025-07-10 17:03:30+00'),
  (15, 5, 'encode',    'running', 3, 'worker-a', '2025-07-10 16:20+00', '2025-07-10 16:40+00',    '2025-07-10 16:20+00', '2025-07-10 16:45+00');
```

```sql starter
UPDATE render_jobs
SET status = 'queued', worker = NULL, locked_until = NULL
WHERE status = 'running';
```

```sql solution
UPDATE render_jobs
SET status       = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
    run_at       = CASE WHEN attempts >= max_attempts THEN run_at ELSE '2025-07-10 17:00+00' END,
    worker       = NULL,
    locked_until = NULL,
    last_error   = 'lease expired'
WHERE status = 'running'
  AND locked_until < '2025-07-10 17:00+00';
```

```sql check
SELECT id, status, worker, locked_until, run_at, last_error
FROM render_jobs WHERE id IN (6, 14, 15) ORDER BY id;
```
:::

## Retries, backoff and dead jobs

Jobs fail: ffmpeg crashes on a weird input, an upstream API returns 503, a deploy restarts the
worker. The worker catches the error and reports it:

```sql
-- success
UPDATE render_jobs SET status = 'done', finished_at = now(), locked_until = NULL
WHERE id = $1 AND worker = $2;

-- failure: retry later, or give up
UPDATE render_jobs
SET status     = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
    run_at     = CASE WHEN attempts >= max_attempts THEN run_at
                      ELSE now() + interval '30 seconds' * power(2, attempts) END,
    worker = NULL, locked_until = NULL, last_error = $3
WHERE id = $1 AND worker = $2;
```

- **Exponential backoff** gives a broken dependency time to recover instead of hammering it.
  The claim already incremented `attempts`, so the first failure (attempts = 1) waits
  30 s × 2¹ = 1 min, the second 2 min, the third 4 min, and so on. Production queues add **jitter** (a random ± few seconds) so
  a thousand jobs that failed together don't all retry in the same second.
- **Dead jobs** (a.k.a. dead-letter queue) are not deleted: they're kept with `last_error` so a
  human can inspect, fix the bug, and re-enqueue them with one `UPDATE`. Alert on their count.
- The `AND worker = $2` guard matters: if this worker's lease expired and someone else now owns
  the job, the late report must not overwrite the new owner's state.

:::quiz id=db-15-q7 xp=15
Spot the bug. Worker A claims job 30 with a 5-minute lease, but the render takes 8 minutes. At
minute 5 the reaper requeues the job and worker B claims it. At minute 8, worker A finishes and
runs:

```sql
UPDATE render_jobs SET status = 'done', finished_at = now(), locked_until = NULL
WHERE id = 30;
```

What goes wrong, and what's the fix?

- [ ] Nothing — the job really is done, so marking it done is correct
- [x] A marks the job `done` while B is still rendering it, and clears B's lease; add `AND worker = 'worker-a'` and treat "0 rows updated" as "I lost this job"
- [ ] The `UPDATE` blocks forever because B holds a row lock on job 30
- [ ] Postgres raises a serialization error because two workers touched the same row
> B's claim committed long ago, so there's no row lock to wait for and no error — A's update
> simply wins. The row now says `done` while B is still rendering: anything that reacts to
> "done" (the "your video is ready" email, the download link) fires while B may be overwriting
> the output file. "The job really is done" is the tempting answer, but A no longer *owns* it. Guard every completion, failure and heartbeat
> update with the owner, and send heartbeats so a long job's lease doesn't expire in the first
> place.
:::

:::sql id=db-15-sql5 db=studio xp=70
title: Report failures with backoff
Now is `'2025-07-10 17:00+00'`. Two workers report failures at once:

| job | error |
|---|---|
| 14 | `'ffmpeg exit 1'` |
| 15 | `'out of memory'` |

Write **one** `UPDATE … FROM (VALUES …)` that applies both reports:

- if `attempts >= max_attempts` → `status = 'dead'`, `run_at` unchanged
- otherwise → `status = 'queued'`, `run_at = now + 30 seconds × 2^attempts`
- always: `worker = NULL`, `locked_until = NULL`, `last_error` = the reported error

The checker reads `id, status, worker, run_at, last_error` for jobs 14 and 15.

hint: `UPDATE render_jobs j SET … FROM (VALUES (14, 'ffmpeg exit 1'), (15, 'out of memory')) AS f(id, err) WHERE j.id = f.id`
hint: `'2025-07-10 17:00+00'::timestamptz + interval '30 seconds' * power(2, j.attempts)`
hint: Inside `SET`, refer to the target's columns without the alias on the left side: `SET status = …`.

```sql setup
ALTER TABLE render_jobs
  ADD COLUMN run_at       timestamptz,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 3,
  ADD COLUMN last_error   text;
UPDATE render_jobs SET run_at = created_at;
ALTER TABLE render_jobs ALTER COLUMN run_at SET NOT NULL;
ALTER TABLE render_jobs DROP CONSTRAINT render_jobs_status_check;
ALTER TABLE render_jobs ADD CONSTRAINT render_jobs_status_check
  CHECK (status IN ('queued','running','done','failed','dead'));
UPDATE render_jobs SET locked_until = started_at + interval '5 minutes' WHERE status = 'running';
INSERT INTO render_jobs (id, project_id, kind, status, attempts, worker, created_at, started_at, run_at, locked_until) VALUES
  (13, 3, 'thumbnail', 'queued',  1, NULL,       '2025-07-10 16:50+00', NULL,                     '2025-07-10 17:02+00', NULL),
  (14, 1, 'encode',    'running', 1, 'worker-b', '2025-07-10 16:58+00', '2025-07-10 16:58:30+00', '2025-07-10 16:58+00', '2025-07-10 17:03:30+00'),
  (15, 5, 'encode',    'running', 3, 'worker-a', '2025-07-10 16:20+00', '2025-07-10 16:40+00',    '2025-07-10 16:20+00', '2025-07-10 16:45+00');
```

```sql starter
UPDATE render_jobs j
SET status = 'queued', worker = NULL, locked_until = NULL, last_error = f.err,
    run_at = '2025-07-10 17:00+00'
FROM (VALUES (14, 'ffmpeg exit 1'), (15, 'out of memory')) AS f(id, err)
WHERE j.id = f.id;
```

```sql solution
UPDATE render_jobs j
SET status       = CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END,
    run_at       = CASE WHEN j.attempts >= j.max_attempts THEN j.run_at
                        ELSE '2025-07-10 17:00+00'::timestamptz + interval '30 seconds' * power(2, j.attempts) END,
    worker       = NULL,
    locked_until = NULL,
    last_error   = f.err
FROM (VALUES (14, 'ffmpeg exit 1'), (15, 'out of memory')) AS f(id, err)
WHERE j.id = f.id;
```

```sql check
SELECT id, status, worker, run_at, last_error
FROM render_jobs WHERE id IN (14, 15) ORDER BY id;
```
:::

## At-least-once delivery and idempotency

Look closely at the failure modes: a worker can finish the render, upload the file, and then
crash *before* its `UPDATE … SET status = 'done'` commits. The lease expires, the reaper
requeues, and the job runs **again**. No queue — Postgres, SQS, RabbitMQ, Kafka — can promise
"exactly once" across a crash between *doing* and *recording*. What you get is
**at-least-once** delivery, and your job handlers must be **idempotent**: running them twice has
the same effect as running them once.

Typical techniques:

- Write outputs to a deterministic location (`renders/project-6/v9.mp4`) so a rerun overwrites
  instead of duplicating.
- Guard side effects with a unique key: `INSERT INTO credit_ledger … ON CONFLICT DO NOTHING`
  with a `UNIQUE (job_id)` column, so a job can charge at most once.
- Pass an **idempotency key** to external APIs (Stripe, email providers support this).

The same idea protects the **enqueue** side. A user double-clicks "Render" or the frontend
retries a timed-out request: you want *at most one active encode job per project*. A partial
unique index expresses that rule, and `ON CONFLICT DO NOTHING` turns the duplicate into a
no-op:

```sql
CREATE UNIQUE INDEX render_jobs_one_active
  ON render_jobs (project_id, kind) WHERE status IN ('queued', 'running');
```

:::quiz id=db-15-q4 xp=15
A thumbnail job uploads `thumb.jpg`, inserts a `-5` credit row into `credit_ledger`, and then
the worker is killed before marking the job `done`. The reaper requeues it and it runs again.
Which design keeps the user from being charged twice?

- [ ] Use `FOR UPDATE SKIP LOCKED` in the claim
- [ ] Set `max_attempts = 1`
- [x] Give the ledger a `job_id` column with a `UNIQUE` constraint and insert with `ON CONFLICT (job_id) DO NOTHING`
- [ ] Wrap the claim in `SERIALIZABLE`
> `SKIP LOCKED` prevents two workers running a job *concurrently*; it can't prevent a rerun after
> a crash. `max_attempts = 1` would lose the job instead. Making the side effect idempotent with
> a unique key is the fix — even better, insert the charge in the same transaction that marks
> the job done.
:::

:::sql id=db-15-sql6 db=studio xp=50
title: Idempotent enqueue
A unique partial index (see `setup`) allows only one `queued`/`running` job per
`(project_id, kind)`. The API receives "Render" for **project 2** and **project 6** (which
already has a queued encode job, id 7).

Enqueue an `encode` job for both in **one** `INSERT` that silently skips the duplicate: ids `20`
(project 2) and `21` (project 6), `status = 'queued'`, `attempts = 0`,
`created_at = '2025-07-10 17:00+00'`. The checker reads `id, project_id, kind, status` of jobs
with id ≥ 20.

hint: Plain `INSERT` raises a unique violation and the whole statement fails.
hint: `ON CONFLICT DO NOTHING` (optionally `ON CONFLICT (project_id, kind) WHERE status IN ('queued','running') DO NOTHING`)

```sql setup
CREATE UNIQUE INDEX render_jobs_one_active
  ON render_jobs (project_id, kind) WHERE status IN ('queued', 'running');
```

```sql starter
INSERT INTO render_jobs (id, project_id, kind, status, attempts, created_at) VALUES
  (20, 2, 'encode', 'queued', 0, '2025-07-10 17:00+00'),
  (21, 6, 'encode', 'queued', 0, '2025-07-10 17:00+00');
```

```sql solution
INSERT INTO render_jobs (id, project_id, kind, status, attempts, created_at) VALUES
  (20, 2, 'encode', 'queued', 0, '2025-07-10 17:00+00'),
  (21, 6, 'encode', 'queued', 0, '2025-07-10 17:00+00')
ON CONFLICT (project_id, kind) WHERE status IN ('queued', 'running') DO NOTHING;
```

```sql check
SELECT id, project_id, kind, status FROM render_jobs WHERE id >= 20 ORDER BY id;
```
:::

## Transactional enqueue: the reason to use Postgres

Here's the bug that a separate queue (Redis, RabbitMQ, SQS) makes easy to write:

```csharp
await db.SaveChangesAsync();                 // 1. project published (committed)
await queue.PublishAsync(new EncodeJob(6));  // 2. network blip → exception → job never sent
```

Swap the order and you get the opposite bug: the job is sent, then the database commit fails,
and a worker renders a project that was never published. There is no way to commit to two
systems atomically without distributed transactions.

With the queue *in* Postgres, the job row is just another insert in the same transaction:

```sql
BEGIN;
UPDATE projects SET published = true, version = version + 1 WHERE id = 6 AND version = 9;
INSERT INTO render_jobs (project_id, kind, status, created_at, run_at)   -- id from an identity column
VALUES (6, 'encode', 'queued', now(), now());
COMMIT;   -- both or neither
```

In EF Core this is simply adding the job entity to the same `DbContext` before the one
`SaveChangesAsync()` call — EF wraps all pending changes in a single transaction.

If you *must* use an external broker (Kafka for other teams, SQS for Lambda consumers), use
the **transactional outbox**: write the message to an `outbox` table in the same transaction,
and have a relay process (a Postgres-queue worker, or CDC like Debezium reading the WAL) publish
it and mark it sent. That's a job queue in Postgres feeding the broker — the same technique.

## Waking workers: LISTEN / NOTIFY

Polling every second is simple and robust, but it adds latency (up to 1 s) and a steady trickle
of queries. Postgres has a built-in pub/sub:

```sql
-- worker connection
LISTEN render_jobs;

-- in the enqueuing transaction (or an AFTER INSERT trigger)
SELECT pg_notify('render_jobs', '6');   -- payload is optional text (< 8 KB)
```

```csharp
await using var conn = await dataSource.OpenConnectionAsync();
conn.Notification += (_, e) => wakeUp.Release();      // SemaphoreSlim
await using (var cmd = new NpgsqlCommand("LISTEN render_jobs", conn)) await cmd.ExecuteNonQueryAsync();
while (!ct.IsCancellationRequested)
{
    await conn.WaitAsync(TimeSpan.FromSeconds(10), ct);  // returns on NOTIFY or timeout
    while (await TryClaimAndRunOne(ct)) { }              // drain the queue
}
```

Rules of thumb:

- Notifications are delivered **only on commit** (a rolled-back enqueue never wakes anyone), and
  only to sessions listening **at that moment** — they are *not* durable. Treat NOTIFY as a
  "check now" hint and keep a slow polling fallback (every 5–30 s) to catch anything missed.
- `LISTEN` needs a dedicated, long-lived connection. It does **not** work through PgBouncer in
  transaction-pooling mode.
- The payload is just a hint; the worker still claims with `SKIP LOCKED`.

:::quiz id=db-15-q5 xp=10
The API inserts a job and calls `pg_notify('render_jobs', …)` in the same transaction, but the
transaction rolls back. Meanwhile, worker B was restarting and wasn't listening for 3 seconds
during which 10 other jobs were enqueued and committed. Which statements are true?
(Select all that apply.)

- [x] Nobody receives the notification from the rolled-back transaction
- [ ] Worker B receives the 10 missed notifications when it reconnects
- [x] Worker B needs a polling fallback (or a claim loop at startup) to pick up those 10 jobs
- [ ] NOTIFY makes the job insert durable even if the transaction rolls back
> NOTIFY is transactional (sent at commit) but not durable: only current listeners get it, and
> there is no replay for a session that starts listening later — that's the tempting wrong
> answer. NOTIFY also never affects whether the insert commits. The
> jobs themselves are safe in the table, so a worker that drains the queue on startup and polls
> occasionally never loses work.
:::

## Singletons and cron: advisory locks

Some jobs must run on **exactly one** worker at a time: the nightly "expire free-plan renders"
sweep, the reaper itself, a sync with the billing provider. You could add a row to lock with
`FOR UPDATE`, but Postgres has a purpose-built tool: **advisory locks** — locks on an arbitrary
64-bit number that mean whatever your app decides.

```sql
-- session-level: held until unlocked or the connection closes
SELECT pg_try_advisory_lock(hashtext('nightly-cleanup'));   -- true = you're the leader
-- … do the work …
SELECT pg_advisory_unlock(hashtext('nightly-cleanup'));

-- transaction-level: released automatically at COMMIT/ROLLBACK (safer)
BEGIN;
SELECT pg_try_advisory_xact_lock(hashtext('nightly-cleanup'));
-- … work …
COMMIT;
```

- `pg_try_*` returns `false` immediately if another session holds the lock — the other workers
  just skip this run. `pg_advisory_lock` (no `try`) waits instead.
- The key is a `bigint` (or two `int`s). `hashtext()` is a handy way to turn a name into a
  number, but it's an undocumented internal function — many teams just keep a small table or enum
  of well-known lock ids instead.
- With the transaction-level variant, the work must happen **inside** that transaction: the lock
  is gone the moment you `COMMIT`.
- If the leader crashes, its connection closes and the lock is released automatically — no
  stale "lock rows" to clean up.
- Advisory locks are also handy to serialize per-entity work ("only one render per project at a
  time": `pg_try_advisory_xact_lock(project_id)`).

:::quiz id=db-15-q6 xp=15
Your app connects through **PgBouncer in transaction-pooling mode**. A cron worker runs
`SELECT pg_try_advisory_lock(42)`, then the cleanup statements, then `pg_advisory_unlock(42)`,
each as a separate autocommit statement. What's the risk?

- [ ] None — advisory locks are global
- [x] Each statement may run on a different server connection, so the lock can be taken on one connection and never released (or released on the wrong one)
- [ ] PgBouncer converts advisory locks into row locks
- [ ] `pg_try_advisory_lock` always returns false behind PgBouncer
> Advisory locks are shared by every session in the same database in *what* they lock, but a session-level lock is *owned* by one
> server connection — and transaction pooling hands you a different one per transaction. The
> lock can stay held by a connection PgBouncer gives to some other client, blocking every future
> run; the unlock on another connection just returns `false` with a warning. Use `pg_try_advisory_xact_lock` inside one explicit
> transaction, or a direct (non-pooled) connection for the leader.
:::

## Observability: is the queue healthy?

A queue you can't see is a queue that silently backs up. Every production queue has a
dashboard (Grafana, or the library's UI) built on queries like:

```sql
SELECT status, count(*) AS jobs,
       min(run_at) FILTER (WHERE status = 'queued') AS oldest_due
FROM render_jobs GROUP BY status;
```

The numbers to alert on: **queue depth** growing over time, **age of the oldest due job**
(latency users feel), **dead jobs** > 0, and **running jobs with expired leases** (workers dying).

:::sql id=db-15-sql7 db=studio ordered=true xp=50
title: A per-kind health board
Build one row per job `kind` with the columns `kind, queued, running, failed, done,
oldest_queued` — the four counts by status, and the earliest `created_at` among that kind's
queued jobs (NULL if none). Order by `kind`.

hint: `count(*) FILTER (WHERE status = 'queued') AS queued`
hint: `min(created_at) FILTER (WHERE status = 'queued')`

```sql starter
SELECT kind, status, count(*)
FROM render_jobs
GROUP BY kind, status
ORDER BY kind, status;
```

```sql solution
SELECT kind,
       count(*) FILTER (WHERE status = 'queued')  AS queued,
       count(*) FILTER (WHERE status = 'running') AS running,
       count(*) FILTER (WHERE status = 'failed')  AS failed,
       count(*) FILTER (WHERE status = 'done')    AS done,
       min(created_at) FILTER (WHERE status = 'queued') AS oldest_queued
FROM render_jobs
GROUP BY kind
ORDER BY kind;
```
:::

## Cleanup and archiving

A busy queue inserts and updates millions of rows a day. Every update leaves a dead tuple
(MVCC, from Transactions, Isolation & Locking), so a queue table is the **highest-churn table** you own:

- Delete or archive finished jobs regularly (keep, say, 7 days of `done` for debugging and the
  dead ones until handled). Huge tables make every sequential scan and vacuum slower.
- Make autovacuum aggressive on the queue table:
  `ALTER TABLE render_jobs SET (autovacuum_vacuum_scale_factor = 0.01);`
- At very high volume, partition by time (`PARTITION BY RANGE (created_at)`) and `DROP` old
  partitions instead of deleting rows — instant and bloat-free.
- Long-running transactions anywhere in the database stop vacuum from cleaning the queue (lesson
  12): one forgotten `BEGIN` in a psql session can make claim queries crawl.

Moving rows atomically is a perfect job for a **data-modifying CTE**: delete and insert in one
statement, so a row is never lost or duplicated.

:::sql id=db-15-sql8 db=studio xp=60
title: Archive finished jobs
Move every `done` job that finished **before** `'2025-06-15 00:00+00'` from `render_jobs` into
`render_jobs_archive` (same columns, see `setup`) in **one statement**: the rows must disappear
from `render_jobs` and appear in the archive.

The checker reads: the archived ids as a comma-separated string (by id), the number of rows left
in `render_jobs`, and the number of `done` jobs left.

hint: `WITH moved AS (DELETE FROM render_jobs WHERE … RETURNING *) INSERT INTO render_jobs_archive SELECT * FROM moved;`

```sql setup
CREATE TABLE render_jobs_archive (LIKE render_jobs INCLUDING DEFAULTS);
```

```sql starter
INSERT INTO render_jobs_archive
SELECT * FROM render_jobs
WHERE status = 'done' AND finished_at < '2025-06-15 00:00+00';
```

```sql solution
WITH moved AS (
  DELETE FROM render_jobs
  WHERE status = 'done' AND finished_at < '2025-06-15 00:00+00'
  RETURNING *
)
INSERT INTO render_jobs_archive SELECT * FROM moved;
```

```sql check
SELECT (SELECT string_agg(id::text, ',' ORDER BY id) FROM render_jobs_archive),
       (SELECT count(*) FROM render_jobs),
       (SELECT count(*) FROM render_jobs WHERE status = 'done');
```
:::

## Postgres queue vs a dedicated broker

| | Postgres queue | Redis (lists/streams, BullMQ, Sidekiq) | RabbitMQ / SQS | Kafka |
|---|---|---|---|---|
| Transactional enqueue with your data | **Yes** | No (needs outbox) | No (needs outbox) | No (needs outbox) |
| Throughput | Thousands–tens of thousands jobs/s with batching | Very high | High | Extremely high (log, not queue) |
| Durability | Same as your DB (WAL, backups, PITR) | Depends on persistence config | Durable | Durable, replayable |
| Querying jobs ("all failed encodes for project 6") | Plain SQL | Limited | No | No |
| Extra infrastructure | None | Another stateful service | Another service / AWS | A cluster |
| Weak spots | Table churn → vacuum tuning; DB load shared with the app | Memory-bound, weaker guarantees | Less flexible scheduling, no ad-hoc queries | Classically not a work queue: per-partition offsets, no per-message ack/retry (Kafka 4's *share groups* are adding queue semantics) |

The honest rule: **start with the Postgres queue** if Postgres is already your database — it
removes a whole class of consistency bugs and an entire piece of infrastructure. Move high-volume
streams (analytics events, logs) to Kafka or Redis when the numbers demand it, and keep
business-critical jobs next to the data they change.

:::job title="What you'll see at work"
In .NET shops, **Hangfire** (with `Hangfire.PostgreSql`) or **Quartz.NET** often run the
background jobs; Node teams use **pg-boss** or **graphile-worker**, Go teams **River**, Elixir
teams **Oban**. You'll rarely write the claim query yourself — but you *will* debug stuck jobs,
tune the queue table, write the dashboard queries and decide retry policies. Knowing that the
library does `FOR UPDATE SKIP LOCKED` under the hood is what lets you read its tables and fix
production at 2 a.m.
:::

:::pro title="Hardening checklist for a Postgres queue"
- Partial index on `(run_at, id) WHERE status = 'queued'` (and one for expired leases).
- Claim in batches; keep claim transactions tiny; never hold the claim transaction open across
  the work unless jobs are seconds long.
- Leases + heartbeats + reaper; `AND worker = $me` on every completion update.
- Exponential backoff with jitter, `max_attempts`, a dead state, and an alert on it.
- Idempotent handlers and unique keys on side effects; partial unique index for dedupe on enqueue.
- Enqueue inside the business transaction; NOTIFY for latency + polling as the safety net.
- Advisory xact locks for singleton/cron jobs.
- Archive or partition finished jobs; aggressive autovacuum on the queue table; watch for long
  transactions.
- Priorities and fairness: add a `priority` column to the `ORDER BY`, or a per-tenant cap, so one
  customer's 50 000-job import doesn't starve everyone else.
:::

:::cards id=db-15-cards1 xp=20 title="Postgres job queues"
Q: The canonical claim query?
A: UPDATE jobs SET status='running', attempts=attempts+1, worker=$1 WHERE id = (SELECT id FROM jobs
   WHERE status='queued' AND run_at <= now() ORDER BY run_at, id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *;
Q: What does SKIP LOCKED do?
A: Rows locked by other transactions are skipped instead of waited for, so concurrent workers claim different jobs.
Q: Why is SELECT-then-UPDATE unsafe for claiming?
A: Two workers can read the same id before either updates it; both run the job.
Q: What is a lease (visibility timeout)?
A: locked_until on the claimed job; if the worker doesn't finish or heartbeat in time, a reaper requeues it.
Q: Why add `AND worker = $me` to every completion / failure / heartbeat update?
A: If your lease expired and another worker reclaimed the job, your late update must not overwrite its state. 0 rows updated = you lost the job.
Q: How do retries avoid hammering a broken dependency?
A: Exponential backoff (run_at = now() + base × 2^attempts) plus jitter; after max_attempts → dead.
Q: Why must job handlers be idempotent?
A: Delivery is at-least-once: a crash between doing the work and marking it done causes a rerun.
Q: How do you dedupe enqueues ("only one active encode per project")?
A: A partial UNIQUE index on (project_id, kind) WHERE status IN ('queued','running') + ON CONFLICT DO NOTHING.
Q: The biggest advantage of a Postgres queue over Redis/RabbitMQ?
A: Transactional enqueue — the job row commits or rolls back together with the business change.
Q: What is the transactional outbox?
A: Write messages to an outbox table in the business transaction; a relay publishes them to the broker and marks them sent.
Q: LISTEN/NOTIFY guarantees?
A: Delivered on commit to current listeners only — not durable; use it as a wake-up hint with polling as fallback.
Q: How do you make sure a cron job runs on only one worker?
A: pg_try_advisory_xact_lock(key) in a transaction; others get false and skip. Released automatically.
Q: Why does a queue table need special maintenance?
A: Extreme update/delete churn creates dead tuples: archive/partition old jobs, tune autovacuum, avoid long transactions.
:::

## Recap

- A job queue is a table + a state machine: `queued → running → done`, with retries back to
  `queued` and a `dead` state for poison jobs.
- Claim atomically with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *`;
  index it with a partial index on queued rows.
- Claim-and-release needs **leases**, heartbeats and a **reaper**; retries use `run_at` with
  exponential backoff and `max_attempts`.
- Delivery is at-least-once: make handlers idempotent and dedupe with unique keys and
  `ON CONFLICT DO NOTHING`.
- The killer feature is **transactional enqueue**; the outbox pattern brings it to external brokers.
- LISTEN/NOTIFY lowers latency but isn't durable; advisory locks give you singleton/cron jobs.
- Monitor depth, oldest-due age, dead jobs and expired leases; archive finished jobs and tune
  vacuum for the churn.
