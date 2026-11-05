---
id: cl-03
title: Redis as Queue, Bus and Lock
level: advanced
minutes: 220
xp: 100
summary: Use Redis for work queues that survive crashes (LMOVE + leases + a reaper), Streams with consumer groups, pub/sub and the SignalR backplane, distributed locks with fencing tokens, and rate limiting, and know which delivery guarantee each one gives you.
---

Once Redis runs next to your API for caching (*Redis Fundamentals*, *Caching with Redis in .NET*), people start using it for other
jobs: "let's push the thumbnail jobs into a Redis list", "let's use a Redis lock so the nightly
report runs only once", "let's rate-limit login attempts in Redis". Each of these is a good idea,
and each has a well-known way to lose data, run work twice or let two processes into a critical
section.

This lesson is about the **guarantees**. Before you use a Redis primitive for coordination,
ask two questions:

1. **What happens if the process holding the data dies right now?** (crash, `kill -9`, OOM kill,
   node drained, pod scaled down)
2. **What happens if the message arrives twice?**

The answers have standard names, and you'll meet them in every broker's documentation:

- **At-most-once**: each message is handled zero or one times. Nothing ever runs twice, but a crash
  at the wrong moment loses the message for good. Fine for "nice to have" signals, never for money.
- **At-least-once**: each message is handled one or more times. Nothing is lost, because anything
  unconfirmed is retried, but the retry means the same job can run twice. The handler must then be
  **idempotent**: running it a second time has the same effect as running it once (setting
  `status = 'paid'` is idempotent; adding 10 to a balance is not).
- **Exactly-once**: what everyone wants. Over a network you can't guarantee it for delivery itself.
  In practice it means at-least-once delivery plus an idempotent handler, so duplicates do no harm
  (*Message Brokers & the Outbox Pattern*, the next lesson, covers this in depth).

Two more terms the lesson relies on. A **lease** is a claim with an expiry: "worker-7 owns job 42
for the next 30 seconds". If the worker dies, the lease simply runs out and someone else may take
over. A **TTL** (time to live) is how Redis implements that: a key with a TTL deletes itself when
the time is up, without anyone running code.

| Primitive | Typical use | Delivery guarantee | If the consumer is offline |
|---|---|---|---|
| List + `BRPOP` | Naive work queue | **At-most-once** (lost on crash) | Waits in the list |
| List + `LMOVE` + lease + reaper | Reliable work queue | **At-least-once** | Waits in the list |
| Stream + consumer group | Work queue / event log with replay | **At-least-once**, with history | Waits in the stream (until trimmed) |
| Pub/Sub | Notifications, SignalR backplane, cache invalidation | **At-most-once**, fire-and-forget | **Lost** |
| `SET NX PX` lock | "Only one of us does this" | Mutual exclusion **while the TTL holds** | n/a |
| `INCR` / sorted set | Rate limiting | Approximate counters | n/a |

:::warn title="Redis is fast because it trusts memory"
Three server settings decide whether your "queue" is a queue at all. Check them before you put
jobs in Redis:

- **Eviction.** `maxmemory-policy` must be `noeviction` on an instance that holds queues or locks.
  With `allkeys-lru`, a busy cache can evict your job list. With `volatile-lru`, it evicts keys
  that have a TTL, which means your **lease keys**, so running jobs get requeued and run twice.
  Teams often run one Redis for cache (evicting) and a separate one for queues (`noeviction`).
- **Persistence.** With `appendonly yes` and the default `appendfsync everysec`, a crash of the
  Redis server can lose up to about one second of writes. Without AOF (RDB snapshots only) you can
  lose minutes.
- **Replication is asynchronous.** A primary can acknowledge `LPUSH`, die, and a replica that
  never got the write gets promoted. `WAIT` reduces this window but doesn't close it.

If a job must never be lost once your API returned `202 Accepted`, the record of truth belongs in
PostgreSQL (be-16's `SKIP LOCKED` queue, or the outbox from the next lesson, *Message Brokers & the Outbox Pattern*). Redis then carries the job,
but it is not the only place the job exists.
:::

:::info title="Redis 8, Valkey, and versions"
Everything here works on Redis 6.2+ (`LMOVE`, `XAUTOCLAIM`) and so on Redis 8 and on
**Valkey**, the Linux Foundation fork many clouds now offer. Redis 8 is again available under an
open-source license (AGPLv3 is one of its options). For the commands in this lesson, Redis and
Valkey behave the same.
:::

## Lists as queues: `LPUSH` / `BRPOP`

A Redis list is a doubly linked list of strings with O(1) push and pop at both ends. Push on the
left, pop on the right, and you have a FIFO queue:

```bash
# producer (the API)
LPUSH dq:jobs:ready "thumb:42"
LPUSH dq:jobs:ready "thumb:43"

# consumer (a worker) – blocks up to 5 s waiting for an item
BRPOP dq:jobs:ready 5
# 1) "dq:jobs:ready"
# 2) "thumb:42"
```

```text
 LPUSH ──►  [ thumb:44 | thumb:43 | thumb:42 ]  ──► BRPOP
           left (newest)          right (oldest)
```

`BRPOP` is atomic: two workers never get the same item. It's also fast, simple and very
popular. It is also the cause of a very common incident report.

### The lost-message problem

```text
 t=0   worker-7:  BRPOP dq:jobs:ready      → "invoice:9001"   (Redis no longer has it)
 t=1   worker-7:  render PDF … 400 MB …
 t=2   kubelet:   worker-7 exceeded memory limit → OOMKilled (SIGKILL, no cleanup code runs)
 t=3   Redis:     dq:jobs:ready = [ … ]  invoice:9001 is nowhere
```

After the pop, the job exists **only in the worker's memory**. Anything that kills the process
before it finishes loses the job without a trace: an OOM kill, `kill -9`, a node going away, a
deploy that doesn't wait, or KEDA scaling the worker Deployment from 5 to 1 (*KEDA: Autoscale Workers on Queue Depth*, later in this region). Retry logic
can't help, because nothing records that the job ever existed. A customer asks why their invoice
never came, and the logs show nothing.

:::quiz id=cl-03-q1 xp=10
Your worker does `BRPOP dq:jobs:ready`, processes the job and catches **every** exception, putting
failed jobs back with `LPUSH`. During a deploy, a job is still running when the pod's 30-second
termination grace period runs out, so the kubelet sends `SIGKILL`. What happens to that job?
- [ ] It is retried, because the catch block puts it back on the queue
- [x] It is lost: after `BRPOP` the job existed only in process memory, and a killed process runs no catch block
- [ ] Redis puts it back on the queue automatically after a timeout
- [ ] Another worker received a copy too, so it's processed anyway
> A catch block only runs while the process is alive. `SIGKILL` (after the grace period, or an OOM kill) ends the process immediately, so no `catch` or `finally` runs, and Redis forgot the job when it handed it out. (Had the worker reacted to the earlier `SIGTERM` by cancelling and re-pushing the job, it would have survived. That is the graceful path, and it doesn't help with OOM kills or lost nodes.) Redis lists have no visibility timeout (that's an SQS feature: a received message is only hidden, and reappears if it isn't deleted in time), and `BRPOP` gives each item to exactly one consumer, so no copy exists anywhere.
:::

## The reliable queue: `LMOVE` + leases + a reaper

The fix: **never let the job exist only in a worker's memory**. Move it atomically into a
second list, the processing list, and let the worker take a **lease**: a key with a TTL that
says "worker-7 is working on job 42, for the next 30 seconds".

```text
                 LPUSH id                LMOVE … RIGHT LEFT        (+ SET dq:jobs:lease:<id> PX 30000)
  API ──────────────────► dq:jobs:ready ──────────────────────► dq:jobs:processing ──► worker
                               ▲                                        │
                               │  reaper: lease key gone?               │ ack: LREM processing
                               └──── LREM processing + RPUSH ready ◄────┘      DEL  lease
                                                                               HDEL data
  dq:jobs:data        HASH    id → payload JSON
  dq:jobs:lease:<id>  STRING  worker id, TTL = lease  (renewed by a heartbeat while the job runs)
```

The keys:

| Key | Type | Purpose |
|---|---|---|
| `dq:jobs:ready` | list of ids | Waiting jobs. `LPUSH` adds at the left; workers take from the right |
| `dq:jobs:processing` | list of ids | Jobs some worker has claimed and not yet acked |
| `dq:jobs:lease:<id>` | string with TTL | Proof that the worker is alive. Expires if the worker dies |
| `dq:jobs:data` | hash | `id → payload`. Lists hold only short ids, so `LREM` is cheap and exact |
| `dq:jobs:attempts` | hash | `id → how many times it was claimed`, for retry limits |

The names follow the `app:entity:id[:purpose]` convention from **Redis Fundamentals**, read here
as `app:queue:state`: `dq` is the app, `jobs` is the queue, the last segment is the state (plus
the job id for per-job keys such as the lease). A second queue in the same app gets its own
family (`dq:emails:ready`, `dq:emails:processing`, …), and `SCAN 0 MATCH dq:jobs:*` shows one
queue's whole state during an incident. The boss lesson makes one deliberate upgrade: it wraps
the app segment in a Cluster **hash tag** (`{media}:…`) so every key of the queue lands in the same
slot and the multi-key Lua scripts keep working on Redis Cluster.

Each step:

1. **Claim**, in one atomic Lua script: `LMOVE dq:jobs:ready dq:jobs:processing RIGHT LEFT`, then
   `SET dq:jobs:lease:<id> <workerId> PX 30000`, then `HINCRBY dq:jobs:attempts <id> 1`. `LMOVE`
   replaces `RPOPLPUSH`, deprecated since Redis 6.2.
2. **Heartbeat.** While the job runs, extend the lease every `lease/3`, but only if the lease
   still holds *your* worker id (compare-and-`PEXPIRE` in Lua). If the extension fails, you lost
   the job: stop working on it.
3. **Ack**, again in one script: `LREM dq:jobs:processing 1 <id>`, then `DEL` the lease and `HDEL` the
   data and attempt count. After this the job is gone for good.
4. **Reap.** Every few seconds, any worker scans `dq:jobs:processing`. An entry whose lease key has
   **expired** belonged to a dead worker: `LREM` it and `RPUSH` it back onto the **right** (front)
   of `dq:jobs:ready`, so it's the next job claimed.

Why does each piece exist?

- **Why atomic claim?** If `LMOVE` and `SET lease` were two round trips and the worker died
  between them, the job would sit in `processing` with no lease. The reaper would requeue it
  right away. That's safe but hides a bug. One script removes the gap.
- **Why a TTL and not "the worker deletes its lease on shutdown"?** The failures you care about
  (`SIGKILL`, OOM, a vanished node) run no code. A TTL needs no code: it expires on its own, and
  that is how a dead worker tells the rest of the system it died.
- **Why a reaper that scans, rather than listening for "key expired" events?** Keyspace
  notifications are pub/sub (fire-and-forget, see below), and Redis emits `expired` events when
  it actually deletes the key, which can be later than the TTL. A scan is boring and always
  correct. The processing list is short anyway: at most workers × concurrency.
- **Why can't two reapers requeue the same job twice?** The check ("lease missing?") and the move
  (`LREM` + `RPUSH`) run in **one Lua script**. Redis runs a script to completion before running
  any other command, so it's atomic.

```lua
-- claim.lua  KEYS: ready, processing, attempts   ARGV: workerId, leaseMs, leasePrefix
local id = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
if not id then return false end
redis.call('SET', ARGV[3] .. id, ARGV[1], 'PX', ARGV[2])
local attempt = redis.call('HINCRBY', KEYS[3], id, 1)
return { id, attempt }
```

```lua
-- reap.lua  KEYS: ready, processing   ARGV: leasePrefix
local ids = redis.call('LRANGE', KEYS[2], 0, -1)
local n = 0
for _, id in ipairs(ids) do
  if redis.call('EXISTS', ARGV[1] .. id) == 0 then
    redis.call('LREM', KEYS[2], 1, id)
    redis.call('RPUSH', KEYS[1], id)      -- right = front of the line
    n = n + 1
  end
end
return n
```

:::warn title="Lua scripts are atomic, not transactional"
If a script raises an error halfway, the writes it already made **stay**. There is no rollback.
Keep scripts small, validate inputs in C# before calling them, and keep risky parsing such as
`cjson.decode` of user data out of the claim path. This is one reason the lists above hold plain
ids and the JSON payload lives in a hash.
:::

:::warn title="Redis Cluster"
The scripts build lease key names (`ARGV[1] .. id`) inside Lua. That works on a single node,
including with replicas and Sentinel. **Redis Cluster** requires every key a script touches to be
declared in `KEYS` and to hash to the same slot. There you'd put all queue keys under one hash tag
(`{jobs}:ready`, `{jobs}:processing`) and replace the per-job lease keys with one sorted set
`{jobs}:leases` scored by expiry time. The reaper then becomes
`ZRANGEBYSCORE {jobs}:leases -inf <now>`.
:::

### What survives what

| Event | What happens to the in-flight job |
|---|---|
| Handler throws | Your code decides: ack and dead-letter it, or leave it so the lease expires and it is retried |
| `SIGTERM` (deploy, scale-down) | Graceful worker: stop claiming, finish or **abandon** (requeue now) within the grace period |
| `SIGKILL` / OOM kill / node lost | Lease expires → reaper requeues → another worker runs it. **Delay ≈ lease length** |
| Worker is alive but stalls longer than the lease (GC, CPU throttling) | Heartbeat fails → another worker gets the job → it may run **twice** |
| Redis primary fails over | Writes not yet replicated are lost. This is why the source of truth belongs in Postgres |

The lease length is a trade-off. A short lease (10 s) gives fast recovery but a higher chance that
a slow-but-alive worker loses its job. A long lease (10 min) means a crashed job waits 10 minutes.
With a heartbeat you can keep the lease short (10–30 s) whatever the job duration, because a
live worker keeps renewing it.

:::quiz id=cl-03-q2 xp=15
Thumbnail jobs usually take 20 s. You use the reliable queue with a **fixed 15 s lease and no
heartbeat**. What do you observe?
- [ ] Nothing: the lease only matters when a worker crashes
- [x] Healthy jobs get reaped after 15 s and claimed by a second worker, so most thumbnails are rendered twice and the queue does about double the work
- [ ] The worker's ack fails, so jobs pile up in `dq:jobs:processing` forever
- [ ] Redis extends the lease automatically while the client stays connected
> To the reaper, an expired lease means "this worker is dead". It can't tell a slow worker from a crashed one. With jobs longer than the lease, every healthy job gets requeued and runs again. The ack doesn't leave jobs stuck: the first worker to finish removes the id. Redis never extends TTLs because a connection is open, which is the point of a TTL. The fix is a heartbeat that renews the lease every `lease/3`, or a lease longer than the slowest job.
:::

:::quiz id=cl-03-q9 xp=10
Your team shares one Redis for the product cache and the job queue. It runs with
`maxmemory-policy volatile-lru`, and every cache entry has a TTL. During a traffic spike Redis hits
`maxmemory`. Running jobs use the lease design from this lesson (a lease key with a TTL per job).
What is the most likely queue symptom?
- [ ] None: `volatile-lru` only evicts cache entries, because they are the least recently used
- [x] Lease keys (which have TTLs) get evicted, so the reaper treats live jobs as dead and requeues them: jobs run twice
- [ ] Redis rejects new `LPUSH` commands with an OOM error, so enqueueing fails but nothing runs twice
- [ ] The `dq:jobs:ready` list is evicted first, because lists are larger than strings
> `volatile-*` policies pick victims among **all keys that have a TTL**, and Redis doesn't know which of them are "cache" and which are "lease". A lease touched only by a heartbeat every few seconds can easily look "less recently used" than a hot cache entry. To the reaper, a missing lease means "dead worker", so it requeues jobs that are still running. The OOM-error option describes `noeviction`, which is the policy you *want* on a queue instance. The job lists have no TTL, so `volatile-lru` never evicts them (`allkeys-lru` could). The fix: `noeviction` on a separate queue/lock Redis.
:::

:::pro title="Don't build this from scratch in production (but do build it once)"
Libraries package this pattern with dashboards, retries, delayed jobs and cron: **Hangfire**
(with a Redis or Postgres storage), **MassTransit** and **Wolverine** (over RabbitMQ, Azure
Service Bus, SQS…). You should still know the mechanics, because their failure modes are the ones
described here: "visibility timeout", "lock duration" and "lease" are the same idea. When a
Service Bus message is "delivered twice", the lock expired while your handler was still running.
:::

### Challenge: a reliable queue you can crash

:::challenge id=cl-03-c1 lang=ts xp=60
title: Reliable queue with leases and a reaper
Implement `ReliableQueue`, an in-memory model of the Redis design above. Time comes from an
injected clock (`FakeClock` is in the setup), so the tests can "crash" a worker and jump forward.

- `push(job)` appends a job to the back of the ready queue.
- `claim(worker)` takes the job at the **front**, records it as processing with
  `owner = worker` and `leaseUntil = now + leaseMs`, and returns it (or `null` if nothing is ready).
- `extend(id, worker)` is the heartbeat. If the job is processing, `worker` is its owner and the
  lease has **not** expired (`now < leaseUntil`), set `leaseUntil = now + leaseMs` and return
  `true`. Otherwise return `false`.
- `ack(id)` removes a processing job and returns `true`. It returns `false` if the job isn't in
  processing (unknown, already acked, or already requeued).
- `reap()` moves every processing job whose lease has expired (`now >= leaseUntil`) back to the
  **front** of the ready queue, oldest claim first, and returns how many it moved.
- `stats()` returns `{ ready, processing }` counts.

The starter behaves like `BRPOP`: once claimed, the job only lives in the caller's hands.

hint: Keep `ready: Job[]` and a `Map<string, { job, owner, leaseUntil }>` for processing. A `Map` iterates in insertion (claim) order.
hint: In `reap`, collect the expired jobs first, delete them from the map, then `this.ready.unshift(...expired)`.

```ts setup
interface Clock { now(): number }
type Job = { id: string; payload: string }
class FakeClock {
  t = 0
  now(): number { return this.t }
  advance(ms: number): void { this.t += ms }
}
```

```ts starter
export class ReliableQueue {
  private ready: Job[] = []
  private clock: Clock
  private leaseMs: number
  constructor(clock: Clock, leaseMs: number) {
    this.clock = clock
    this.leaseMs = leaseMs
  }
  push(job: Job): void { this.ready.push(job) }
  claim(worker: string): Job | null {
    return this.ready.shift() ?? null // like BRPOP: if the worker dies now, the job is gone
  }
  extend(id: string, worker: string): boolean { return true }
  ack(id: string): boolean { return true }
  reap(): number { return 0 }
  stats(): { ready: number; processing: number } {
    return { ready: this.ready.length, processing: 0 }
  }
}
```

```ts solution
export class ReliableQueue {
  private ready: Job[] = []
  private processing = new Map<string, { job: Job; owner: string; leaseUntil: number }>()
  private clock: Clock
  private leaseMs: number
  constructor(clock: Clock, leaseMs: number) {
    this.clock = clock
    this.leaseMs = leaseMs
  }
  push(job: Job): void { this.ready.push(job) }
  claim(worker: string): Job | null {
    const job = this.ready.shift()
    if (!job) return null
    this.processing.set(job.id, { job, owner: worker, leaseUntil: this.clock.now() + this.leaseMs })
    return job
  }
  extend(id: string, worker: string): boolean {
    const p = this.processing.get(id)
    const now = this.clock.now()
    if (!p || p.owner !== worker || now >= p.leaseUntil) return false
    p.leaseUntil = now + this.leaseMs
    return true
  }
  ack(id: string): boolean {
    return this.processing.delete(id)
  }
  reap(): number {
    const now = this.clock.now()
    const expired: Job[] = []
    for (const [id, p] of this.processing) {
      if (now >= p.leaseUntil) {
        expired.push(p.job)
        this.processing.delete(id)
      }
    }
    this.ready.unshift(...expired)
    return expired.length
  }
  stats(): { ready: number; processing: number } {
    return { ready: this.ready.length, processing: this.processing.size }
  }
}
```

```ts tests
const mk = (id: string): Job => ({ id, payload: `render ${id}` })

test('FIFO: jobs are claimed in push order', () => {
  const q = new ReliableQueue(new FakeClock(), 30_000)
  q.push(mk('a')); q.push(mk('b'))
  expect(q.claim('w1')?.id).toBe('a')
  expect(q.claim('w2')?.id).toBe('b')
  expect(q.claim('w3')).toBeNull()
})
test('a claimed job is tracked as processing and hidden while leased', () => {
  const clock = new FakeClock()
  const q = new ReliableQueue(clock, 30_000)
  q.push(mk('a'))
  q.claim('w1')
  expect(q.stats()).toEqual({ ready: 0, processing: 1 })
  clock.advance(29_999)
  expect(q.reap()).toBe(0)
  expect(q.claim('w2')).toBeNull()
})
test('crash mid-job: the job reappears after the lease expires', () => {
  const clock = new FakeClock()
  const q = new ReliableQueue(clock, 30_000)
  q.push(mk('a'))
  expect(q.claim('crashy')?.id).toBe('a')   // crashy is OOM-killed: never acks, never extends
  clock.advance(30_000)
  expect(q.reap()).toBe(1)
  expect(q.stats()).toEqual({ ready: 1, processing: 0 })
  const again = q.claim('healthy')
  expect(again).toEqual({ id: 'a', payload: 'render a' })
})
test('an acked job never reappears', () => {
  const clock = new FakeClock()
  const q = new ReliableQueue(clock, 30_000)
  q.push(mk('a'))
  q.claim('w1')
  clock.advance(1_000)
  expect(q.ack('a')).toBe(true)
  clock.advance(10_000_000)
  expect(q.reap()).toBe(0)
  expect(q.claim('w2')).toBeNull()
  expect(q.stats()).toEqual({ ready: 0, processing: 0 })
})
test('ack is idempotent and rejects unknown ids', () => {
  const q = new ReliableQueue(new FakeClock(), 30_000)
  q.push(mk('a'))
  q.claim('w1')
  expect(q.ack('a')).toBe(true)
  expect(q.ack('a')).toBe(false)
  expect(q.ack('nope')).toBe(false)
})
test('requeued jobs go to the front, oldest claim first', () => {
  const clock = new FakeClock()
  const q = new ReliableQueue(clock, 1_000)
  q.push(mk('a')); q.push(mk('b')); q.push(mk('c'))
  q.claim('w1') // a
  q.claim('w2') // b
  clock.advance(1_000)
  expect(q.reap()).toBe(2)
  expect(q.claim('w3')?.id).toBe('a')
  expect(q.claim('w3')?.id).toBe('b')
  expect(q.claim('w3')?.id).toBe('c')
})
test('heartbeats keep a long job alive; only the live owner can extend', () => {
  const clock = new FakeClock()
  const q = new ReliableQueue(clock, 30_000)
  q.push(mk('a'))
  q.claim('w1')
  clock.advance(20_000)
  expect(q.extend('a', 'w1')).toBe(true)  // lease now until 50 000
  expect(q.extend('a', 'w2')).toBe(false) // not the owner
  clock.advance(20_000)                   // t = 40 000
  expect(q.reap()).toBe(0)
  clock.advance(10_000)                   // t = 50 000: expired
  expect(q.extend('a', 'w1')).toBe(false) // too late, the lease is gone
  expect(q.reap()).toBe(1)
})
test('a late ack after the job was requeued returns false (it will run again)', () => {
  const clock = new FakeClock()
  const q = new ReliableQueue(clock, 1_000)
  q.push(mk('a'))
  q.claim('slow')
  clock.advance(5_000)
  q.reap()
  expect(q.ack('a')).toBe(false)
  expect(q.claim('other')?.id).toBe('a')
})
```
:::

## At-least-once means idempotent handlers

The reliable queue doesn't give you "exactly once". It gives you **at-least-once**: every job runs
one or more times. The last test above shows a way a job runs twice even without a crash, and
there are others:

- The worker finished the work, then crashed **before** the ack.
- The worker stalled (stop-the-world GC, CPU throttling at its limit) past the lease, someone else
  claimed the job, then the first worker woke up and finished too.
- Redis failed over and lost the ack, but not the earlier claim.

So **design every handler so the second run is harmless**. be-16 covers the techniques in depth.
In short:

| Technique | Example |
|---|---|
| Naturally idempotent effect | `UPDATE … SET status = 'archived'`, upserts, "recompute the thumbnail and overwrite `thumbs/42.webp`" |
| Dedup record in the **same DB transaction** as the effect | `INSERT INTO processed_jobs(job_id)` with a primary key; the duplicate hits a unique violation |
| Idempotency key for external calls | Pass `job-42` as the provider's idempotency key for payments and emails |

```csharp
// Tempting, and only half right: a Redis dedup marker.
if (!await db.StringSetAsync($"done:{job.Id}", 1, TimeSpan.FromDays(7), When.NotExists))
    return; // someone already did it… or is doing it right now
await ChargeCustomerAsync(job);
```

This marker is written **before** the work, outside your database transaction. If the worker
crashes after setting it, the job is marked done and never actually runs. Set it **after** the
work instead, and two concurrent runs both pass the check. Redis markers are fine to *reduce*
duplicate work, such as skipping a re-render. For correctness, put the dedup record in the same
transaction as the effect (Postgres) or use the provider's idempotency key.

:::job title="What you'll hear on day one"
"Our queue is at-least-once, handlers must be idempotent." It's a standard line in code review.
When you write a new job handler, expect the question "what happens if this runs twice?". Answer
it in the PR description, ideally with a test that runs the handler twice and checks the result.
:::

:::quiz id=cl-03-q3 xp=15
A job sends a "your export is ready" email, then acks. Which design **prevents a duplicate email
in the common failure cases**?
- [ ] Before sending, `SET sent:<jobId> 1 NX`; if it returns false, skip
- [ ] Make the lease 1 hour long so the job is never reclaimed while running
- [x] Record `email_sent(job_id)` with a unique constraint and pass `job-<id>` as the idempotency key to the email provider
- [ ] Use Redis Streams instead of lists, which deliver each message exactly once
> The dedup record plus the provider's idempotency key make a second run detectably harmless, whichever failure caused it. The Redis `SET NX` marker is the tempting answer, but it is written before the email: if the worker crashes between the marker and the send, the email is never sent and the job looks done. A 1-hour lease only delays crash recovery by an hour and doesn't stop a stalled worker from finishing late. Streams are at-least-once too: a message stays pending until `XACK`, and crashed consumers' messages are redelivered.
:::

## Redis Streams with consumer groups

Lists plus leases work, but you built the bookkeeping yourself. **Redis Streams** (since 5.0)
have it built in. A stream is an **append-only log** of entries with time-based ids. A
**consumer group** is a named cursor over that log, shared by several consumers, with a
**Pending Entries List (PEL)**: every message delivered to a consumer and not yet acknowledged.

```text
 stream "orders":  1730…001-0  1730…002-0  1730…003-0  1730…004-0  1730…005-0  ──►  (XADD appends)
                                                        ▲
 group "billing":  last-delivered-id ───────────────────┘
                   PEL: 1730…002-0 → consumer c1, idle 63 s, delivered 1×    ← c1 crashed?
                        1730…003-0 → consumer c2, idle  1 s, delivered 1×
 group "emails":   (its own cursor and PEL over the SAME entries; each group gets every message)
```

The PEL replaces the processing list, the idle time replaces the lease, and `XAUTOCLAIM`
replaces the reaper.

```bash
# Producer: append (* = let Redis generate the id). Cap the length approximately.
XADD orders MAXLEN ~ 100000 * orderId 42 total 19.99

# Once: create the group. $ = only new entries; 0 = start from the beginning. MKSTREAM creates the key.
XGROUP CREATE orders billing $ MKSTREAM

# Consumer c1: read up to 10 NEW messages for this group (">"), block up to 5 s.
XREADGROUP GROUP billing c1 COUNT 10 BLOCK 5000 STREAMS orders >

# After processing:
XACK orders billing 1730000000002-0

# Ops: what's pending?  (summary, then details incl. idle ms and delivery count)
XPENDING orders billing
XPENDING orders billing - + 10

# Recovery: take over messages idle > 60 s from ANY consumer in the group.
XAUTOCLAIM orders billing c2 60000 0-0 COUNT 10
# 1) next cursor   2) the claimed entries   3) (Redis 7+) ids that were deleted (trimmed) meanwhile
```

A .NET consumer with StackExchange.Redis:

```csharp
const string Stream = "orders", Group = "billing";
var consumer = Environment.MachineName;   // e.g. the pod name

try { await db.StreamCreateConsumerGroupAsync(Stream, Group, StreamPosition.NewMessages, createStream: true); }
catch (RedisServerException ex) when (ex.Message.Contains("BUSYGROUP")) { /* already exists */ }

while (!ct.IsCancellationRequested)
{
    // 1) Adopt messages that a dead consumer left behind (idle > 60 s).
    var claimed = await db.StreamAutoClaimAsync(Stream, Group, consumer,
        minIdleTimeInMs: 60_000, startAtId: "0-0", count: 10);

    // 2) Then read new ones.
    var fresh = await db.StreamReadGroupAsync(Stream, Group, consumer, StreamPosition.NewMessages, count: 10);

    var batch = claimed.ClaimedEntries.Concat(fresh).ToArray();
    if (batch.Length == 0) { await Task.Delay(500, ct); continue; }   // no BLOCK in SE.Redis, so poll

    foreach (var entry in batch)
    {
        await HandleAsync(entry, ct);                       // must be idempotent
        await db.StreamAcknowledgeAsync(Stream, Group, entry.Id);
    }
}
```

:::warn title="StackExchange.Redis does not do blocking commands"
StackExchange.Redis multiplexes all callers over one connection, so a command that blocks
(`BRPOP`, `BLMOVE`, `XREADGROUP … BLOCK`) would stall everyone. It doesn't support them. Poll
with a short delay and back off when idle, or publish a small "wake up" message on a pub/sub
channel when you enqueue. The consumer above compiles against StackExchange.Redis 3.x. Overloads
have shifted between major versions, so check IntelliSense or the StackExchange.Redis docs if
yours doesn't compile. (The loop restarts `XAUTOCLAIM` at `0-0` each time for simplicity. With a
large PEL, keep the returned `NextStartId` and continue from it.)
:::

Things the stream design gives you, and things to watch:

- **Poison messages.** `XPENDING … - + 10` shows each message's **delivery count**. If it passes
  5, `XADD` the entry to `orders:dead` and `XACK` it, so it stops cycling forever.
- **Trimming can delete unprocessed work.** `MAXLEN ~ 100000` trims the oldest entries whether or
  not every group has acknowledged them. If consumers fall far behind, entries disappear from the
  stream while still sitting in a PEL (`XAUTOCLAIM` then reports them as deleted ids). Size
  `MAXLEN` for your worst backlog, or trim by id (`MINID`) based on age. Redis 8.2 added options
  for trimming that consider consumer-group references. If you need them, check the `XADD` and
  `XTRIM` docs for your version.
- **Stable consumer names.** On restart, a consumer with the same name can re-read its own pending
  messages (`XREADGROUP … STREAMS orders 0`). With Kubernetes, pod names change on every deploy,
  so `XAUTOCLAIM` is your safety net. Remove old consumers with `XGROUP DELCONSUMER`.
- **Fan-out and replay.** Two groups (billing, emails) each get every message, and you can create
  a new group from `0` to reprocess history. Lists can't do either.
- **Read and reclaim in one call.** Recent Redis releases (8.4 and later) add a `CLAIM
  <min-idle-ms>` option to `XREADGROUP` that returns idle pending entries from other consumers
  together with new ones, and StackExchange.Redis 3.x exposes it as a `claimMinIdleTime` parameter.
  On older servers and on Valkey, keep the two-step loop above. Check the `XREADGROUP` docs for
  your server version.
- **Autoscaling.** KEDA has Redis lists and Redis Streams scalers (list length, pending entries,
  lag). The KEDA lesson later in this region uses them.

| | List + lease | Stream + group | RabbitMQ 4 / Kafka (next lesson) |
|---|---|---|---|
| Crash recovery | Your reaper | `XAUTOCLAIM` | Broker redelivers (unacked) / consumer offset |
| Multiple independent consumers of the same event | No | Yes (groups) | Yes |
| Replay history | No | Yes, until trimmed | Kafka yes, RabbitMQ streams yes |
| Routing, DLQ, delayed delivery | DIY | DIY | Built in (RabbitMQ) |
| Durability | Redis AOF + async replica | Same | Quorum queues / replicated log |
| When | Small, simple job queues | Event fan-out at moderate scale, Redis already in place | Business events that must not be lost, many teams/services |

:::quiz id=cl-03-q4 xp=15
A Stream consumer `worker-abc` is OOM-killed after reading 3 messages with `XREADGROUP … >` and
before `XACK`. Its pod gets a new name, `worker-xyz`. What happens to the 3 messages?
- [ ] They're lost, like with `BRPOP`
- [ ] `worker-xyz` gets them automatically with its next `XREADGROUP … >`
- [x] They stay in the group's PEL, owned by `worker-abc`, until a consumer takes them over with `XAUTOCLAIM` (or `XCLAIM`) once they've been idle long enough
- [ ] Redis redelivers them to the group after the default 30 s visibility timeout
> Delivered but unacked messages are recorded in the PEL, so nothing is lost. `>` only returns messages never delivered to any consumer, so a new consumer doesn't see them, and Redis has no automatic visibility timeout like SQS. Someone has to claim idle messages explicitly. That's why consumer loops call `XAUTOCLAIM` with a minimum idle time.
:::

## Pub/Sub: fire-and-forget

`PUBLISH channel message` delivers the message to **whoever is subscribed right now**, then
forgets it. There's no storage, no ack and no replay. `PUBLISH` returns the number of
subscribers that received the message, and that number can be 0.

```csharp
var sub = mux.GetSubscriber();
await sub.SubscribeAsync(RedisChannel.Literal("cache:invalidate"), (_, key) =>
    localCache.Remove(key.ToString()));   // runs on every API pod. ToString(): IMemoryCache keys
                                          // are objects, and a boxed RedisValue never equals a string key

// after an update, on whichever pod handled it:
long receivers = await sub.PublishAsync(RedisChannel.Literal("cache:invalidate"), "product:42");
```

This is exactly right when a lost message is acceptable or can be repaired:

- **Invalidating local in-memory caches** on N pods (*Caching with Redis in .NET*). A missed message means stale data
  until the TTL, so keep a TTL as the backstop.
- **The SignalR Redis backplane** (be-17): `AddSignalR().AddStackExchangeRedis(...)` publishes
  every hub message to Redis so that each server instance delivers it to its own connections.
  If Redis blips, live updates are dropped. Clients must **refetch on reconnect**, never assume
  they saw every event.
- **"Wake up, there's work"** nudges for pollers, where the queue itself holds the truth.

It's wrong for anything that must arrive: jobs, payments, "user registered" events that trigger
onboarding. Use a list, stream or broker for those.

:::warn title="Slow subscribers get disconnected"
Redis buffers outgoing pub/sub messages per client. The default
`client-output-buffer-limit pubsub 32mb 8mb 60` disconnects a subscriber that is more than 32 MB
behind, or more than 8 MB behind for 60 s. During the disconnect it misses everything. In Redis
Cluster, classic `PUBLISH` goes to every node. Sharded pub/sub (`SPUBLISH` / `SSUBSCRIBE`, Redis
7+) keeps a channel's traffic on its shard.
:::

:::quiz id=cl-03-q5 xp=10
An API pod restarts and is unsubscribed for 4 seconds. During those seconds, 30 `PUBLISH` calls
go to `cache:invalidate`. What does the pod receive after it subscribes again?
- [ ] All 30 messages, in order
- [ ] The latest message only
- [x] None of them. Pub/sub doesn't store messages, so the pod's local cache may be stale until its entries expire
- [ ] All 30, as long as the pod reconnects within the `timeout` setting
> Pub/sub delivers only to clients subscribed at the moment of `PUBLISH`. There's no buffer for absent subscribers, which is the tempting assumption. In this case it doesn't matter much, because a fresh pod starts with an empty local cache. A pod that stayed up but lost its subscription is the dangerous case. That's why local caches keep a short TTL as a backstop, and why anything that must arrive goes through a stream or broker.
:::

## Distributed locks

Sometimes you need "only one of N replicas does this": the nightly report, a database migration
at startup, a call to a partner API that breaks under concurrent requests, refreshing an expensive
cache entry (stampede protection, *Caching with Redis in .NET*). A Redis lock is the usual first tool.

### `SET NX PX` + a token

```bash
SET lock:nightly-report 7f3a…c1 NX PX 300000
# OK   → you hold it for 5 minutes
# (nil) → someone else does
```

- `NX`: only set it if it doesn't exist. That's the mutual exclusion.
- `PX 300000`: auto-release after 5 min, so a crashed holder can't block everyone forever.
- The value is a **random token unique to this acquisition**, not just `1`.

Why the token? Release is where the classic bug hides:

```text
 t=0    A: SET lock NX PX 30000  → OK (token A)
 t=1    A: … GC pause / slow query / CPU throttled … 35 s …
 t=30   lock expires
 t=31   B: SET lock NX PX 30000  → OK (token B)      B is now in the critical section
 t=36   A wakes up, finishes, runs  DEL lock         ← deletes B's lock!
 t=37   C: SET lock NX PX 30000  → OK                B and C are both inside
```

Release must be **compare-and-delete**: delete only if the value is still my token. `GET` then
`DEL` from C# isn't atomic (the lock can change hands in between), so it's done in Lua:

```lua
-- release.lua   KEYS[1] = lock key   ARGV[1] = my token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
```

StackExchange.Redis ships this pattern as `LockTakeAsync` / `LockExtendAsync` /
`LockReleaseAsync`, which all check the token:

```csharp
var key = "lock:nightly-report";
var token = Guid.NewGuid().ToString("N");

if (!await db.LockTakeAsync(key, token, TimeSpan.FromMinutes(5)))
    return;                                   // another replica is running it

try
{
    await RunReportAsync(ct);                 // if it can run long: LockExtendAsync from a timer
}
finally
{
    await db.LockReleaseAsync(key, token);    // only deletes it if it's still ours
}
```

:::info title="Newer Redis versions"
Redis 8.4 added native compare-and-delete and compare-and-set for strings (`DELEX key IFEQ <token>`,
`SET … IFEQ <old>`), and StackExchange.Redis 3.x exposes them as
`StringDeleteAsync(key, ValueCondition.Equal(token))`. They can replace the Lua release script on
servers that support them. Valkey and older Redis versions don't have `DELEX`, so check the
command reference for your server version before relying on it. The Lua script works on every
Redis and Valkey version.
:::

### The token isn't enough: fencing tokens

The token stops A from *releasing* B's lock. It doesn't stop A from *doing the work* after its
lock expired. In the timeline above, A wakes up at t=36 and **writes its report** while B writes
too. No lock with a TTL can prevent this, because A doesn't know it was paused. This is the core
of Martin Kleppmann's 2016 analysis of distributed locking.

The fix lives in the **resource you're protecting**: a **fencing token**, a number that increases
with every acquisition. The resource rejects writes carrying a token lower than one it has
already seen.

```lua
-- acquire.lua   KEYS[1] = lock, KEYS[2] = fence counter   ARGV[1] = token, ARGV[2] = ttl ms
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return redis.call('INCR', KEYS[2])     -- 1, 2, 3, … the fencing token
end
return 0
```

```sql
-- The protected resource checks the fence (here: a Postgres row).
UPDATE report_runs
SET    file_key = @fileKey, fence = @fence
WHERE  report = 'nightly' AND fence <= @fence;   -- A (fence 33) loses against B (fence 34)
```

```text
 A acquires → fence 33 … pause …         B acquires → fence 34, writes (fence := 34)
 A wakes, writes with fence 33  →  WHERE fence <= 33 matches 0 rows → rejected
```

### Redlock and its caveats

A single Redis primary with a replica has a gap: A gets the lock, the primary dies before
replicating it, the replica is promoted **without** the lock, and B gets it too. **Redlock**
acquires the lock on a majority of N (usually 5) independent Redis primaries within a time
budget. It survives a node failure, but its safety still assumes bounded network delays, process
pauses and clock drift. Kleppmann's critique and antirez's (the Redis author's) reply are both
worth reading. The working conclusion most teams use:

| You need the lock for… | Use |
|---|---|
| **Efficiency**: avoid doing the same work twice; a rare double run is OK | Single-instance `SET NX PX` + token. Redlock adds little |
| **Correctness**: a double run corrupts data or double-charges | A lock plus **fencing tokens checked by the resource**, or no lock at all: let the database enforce it |

:::pro title="Often the best distributed lock is your database"
If the critical section writes to Postgres, let Postgres arbitrate. A unique constraint
(`one row per (report, date)`), optimistic concurrency (`WHERE version = @v`, be-18), `SELECT …
FOR UPDATE`, or `pg_try_advisory_lock(42)` for "only one migrator". These are transactional and
tied to the connection, so a crashed holder releases automatically, with no TTL guessing.
Reach for a Redis lock when the resource isn't a database you control, such as a partner API or a
file in object storage, and then think about fencing.
:::

:::quiz id=cl-03-q6 xp=15
Your release code is `if (await db.StringGetAsync(key) == token) await db.KeyDeleteAsync(key);`.
What's wrong with it?
- [ ] Nothing: it checks the token before deleting
- [x] The check and the delete are two separate commands: the lock can expire and be taken by someone else between them, and then you delete their lock
- [ ] `KeyDeleteAsync` can't delete keys that have a TTL
- [ ] Tokens should be compared case-insensitively
> It checks the right thing at the wrong time. Between the `GET` reply and the `DEL`, the TTL can run out and another process can `SET NX` the key, so your `DEL` removes their lock. That's the same bug as a plain `DEL`, with a smaller window. Making it a single atomic step on the server (a Lua compare-and-delete, or `LockReleaseAsync`, which does the compare and the delete as one server-side operation) closes the gap. A TTL can't fire in the middle of an atomic operation.
:::

:::quiz id=cl-03-q7 xp=15
Worker A holds a Redis lock (TTL 30 s) for uploading `report.pdf` to object storage. A stalls for
40 s in a GC pause; B acquires the lock and uploads. Then A resumes and uploads its older version
over B's. Which change actually prevents A's stale write?
- [ ] Release with a Lua compare-and-delete script
- [ ] Switch to Redlock with 5 Redis nodes
- [ ] Make the TTL 5 minutes
- [x] Issue an increasing fencing token on every acquisition and have the write path reject tokens lower than the highest one already accepted
> Only the resource can reject a stale holder, because A has no way of knowing it was paused. Compare-and-delete is the tempting answer, but it only protects the *release*, not A's write. Redlock and longer TTLs make the pause less likely to matter, but any pause longer than the TTL produces the same race. With fencing, B's token (34) is recorded at write time and A's (33) is refused. Storage that can't check a token (plain S3 PUT) needs a different design, for example a unique object key per run plus a pointer row in Postgres guarded by the fence.
:::

### Challenge: a lock a stale owner can't break

:::challenge id=cl-03-c2 lang=ts xp=50
title: Token locks with fencing
Model `SET NX PX` + compare-and-delete + fencing with an injected clock.

`LockService(clock)`:
- `acquire(resource, ttlMs)`: if the resource is free or its lock has expired (`now >= expiresAt`),
  take it: return `{ token, fence }`, where `token` is a **unique string** per acquisition and
  `fence` is a **per-resource counter** that goes 1, 2, 3… with every successful acquisition.
  If someone else holds a valid lock, return `null`.
- `release(resource, token)`: delete the lock and return `true` only if it's still held (not
  expired) **by this token**; otherwise `false` and nothing changes.
- `extend(resource, token, ttlMs)`: same check; on success `expiresAt = now + ttlMs`, return `true`.

`FencedStore` (the protected resource):
- `write(fence, value)`: accept (set `value`, return `true`) only if `fence` is **≥** the highest
  fence accepted so far; otherwise return `false`.
- `value` starts as `null`.

hint: Store `{ token, expiresAt }` per resource and a separate `Map<string, number>` for fences; fences must survive expiry and release.
hint: A token like `` `${resource}:${fence}:${Math.random().toString(36).slice(2)}` `` is unique per acquisition.

```ts setup
interface Clock { now(): number }
class FakeClock {
  t = 0
  now(): number { return this.t }
  advance(ms: number): void { this.t += ms }
}
```

```ts starter
export class LockService {
  private locks = new Map<string, { token: string; expiresAt: number }>()
  private clock: Clock
  constructor(clock: Clock) { this.clock = clock }
  acquire(resource: string, ttlMs: number): { token: string; fence: number } | null {
    const cur = this.locks.get(resource)
    if (cur && this.clock.now() < cur.expiresAt) return null
    const token = Math.random().toString(36).slice(2)
    this.locks.set(resource, { token, expiresAt: this.clock.now() + ttlMs })
    return { token, fence: 0 }
  }
  release(resource: string, token: string): boolean {
    return this.locks.delete(resource) // plain DEL: removes whoever holds it!
  }
  extend(resource: string, token: string, ttlMs: number): boolean { return true }
}

export class FencedStore {
  value: string | null = null
  write(fence: number, value: string): boolean {
    this.value = value
    return true
  }
}
```

```ts solution
export class LockService {
  private locks = new Map<string, { token: string; expiresAt: number }>()
  private fences = new Map<string, number>()
  private clock: Clock
  constructor(clock: Clock) { this.clock = clock }
  private held(resource: string, token: string) {
    const cur = this.locks.get(resource)
    return cur !== undefined && cur.token === token && this.clock.now() < cur.expiresAt ? cur : null
  }
  acquire(resource: string, ttlMs: number): { token: string; fence: number } | null {
    const now = this.clock.now()
    const cur = this.locks.get(resource)
    if (cur && now < cur.expiresAt) return null
    const fence = (this.fences.get(resource) ?? 0) + 1
    this.fences.set(resource, fence)
    const token = `${resource}:${fence}:${Math.random().toString(36).slice(2)}`
    this.locks.set(resource, { token, expiresAt: now + ttlMs })
    return { token, fence }
  }
  release(resource: string, token: string): boolean {
    if (!this.held(resource, token)) return false
    this.locks.delete(resource)
    return true
  }
  extend(resource: string, token: string, ttlMs: number): boolean {
    const cur = this.held(resource, token)
    if (!cur) return false
    cur.expiresAt = this.clock.now() + ttlMs
    return true
  }
}

export class FencedStore {
  value: string | null = null
  private highest = -Infinity
  write(fence: number, value: string): boolean {
    if (fence < this.highest) return false
    this.highest = fence
    this.value = value
    return true
  }
}
```

```ts tests
test('only one holder at a time, per resource', () => {
  const locks = new LockService(new FakeClock())
  expect(locks.acquire('report', 10_000)).not.toBeNull()
  expect(locks.acquire('report', 10_000)).toBeNull()
  expect(locks.acquire('other', 10_000)).not.toBeNull()
})
test('the lock expires after its TTL', () => {
  const clock = new FakeClock()
  const locks = new LockService(clock)
  locks.acquire('report', 10_000)
  clock.advance(9_999)
  expect(locks.acquire('report', 10_000)).toBeNull()
  clock.advance(1)
  expect(locks.acquire('report', 10_000)).not.toBeNull()
})
test("a stale owner cannot release the new owner's lock", () => {
  const clock = new FakeClock()
  const locks = new LockService(clock)
  const a = locks.acquire('report', 10_000)!
  clock.advance(10_000)                        // A paused past its TTL
  const b = locks.acquire('report', 10_000)!
  expect(locks.release('report', a.token)).toBe(false)
  expect(locks.acquire('report', 10_000)).toBeNull()   // B still holds it
  expect(locks.release('report', b.token)).toBe(true)
  expect(locks.acquire('report', 10_000)).not.toBeNull()
})
test('release is not repeatable, and an expired lock is no longer yours', () => {
  const clock = new FakeClock()
  const locks = new LockService(clock)
  const a = locks.acquire('x', 1_000)!
  expect(locks.release('x', a.token)).toBe(true)
  expect(locks.release('x', a.token)).toBe(false)
  const b = locks.acquire('x', 1_000)!
  clock.advance(1_000)
  expect(locks.release('x', b.token)).toBe(false)
})
test('extend works only for the current holder before expiry', () => {
  const clock = new FakeClock()
  const locks = new LockService(clock)
  const a = locks.acquire('x', 1_000)!
  clock.advance(900)
  expect(locks.extend('x', a.token, 1_000)).toBe(true)   // now until 1 900
  expect(locks.extend('x', 'forged', 1_000)).toBe(false)
  clock.advance(900)                                       // t = 1 800
  expect(locks.acquire('x', 1_000)).toBeNull()
  clock.advance(100)                                       // t = 1 900: expired
  expect(locks.extend('x', a.token, 1_000)).toBe(false)
})
test('tokens are unique and fences increase on every acquisition', () => {
  const clock = new FakeClock()
  const locks = new LockService(clock)
  const a = locks.acquire('report', 1_000)!
  locks.release('report', a.token)
  const b = locks.acquire('report', 1_000)!
  clock.advance(1_000)
  const c = locks.acquire('report', 1_000)!
  expect(new Set([a.token, b.token, c.token]).size).toBe(3)
  expect([a.fence, b.fence, c.fence]).toEqual([1, 2, 3])
  expect(locks.acquire('other', 1_000)!.fence).toBe(1)
})
test('the fenced store rejects the zombie write', () => {
  const clock = new FakeClock()
  const locks = new LockService(clock)
  const store = new FencedStore()
  const a = locks.acquire('report', 10_000)!
  clock.advance(15_000)                                  // A stalls
  const b = locks.acquire('report', 10_000)!
  expect(store.write(b.fence, 'report by B')).toBe(true)
  expect(store.write(a.fence, 'stale report by A')).toBe(false)
  expect(store.value).toBe('report by B')
  expect(store.write(b.fence, 'report by B, v2')).toBe(true)
  expect(store.value).toBe('report by B, v2')
})
```
:::

## Rate limiting

"5 login attempts per minute per IP", "1 000 API calls per hour per API key". With several API
replicas, an in-process counter allows N × the limit. ASP.NET Core's built-in rate limiter
(`AddRateLimiter` / `UseRateLimiter`) keeps its counters **in memory per instance**, so with 4
pods a "100/min" policy really means up to 400/min. A shared counter in Redis fixes that.

### Fixed window: `INCR` + `EXPIRE`

Split time into fixed windows (for example whole minutes) and count hits in a key named after the
current window, such as `rl:api:203.0.113.7:1793955600000` (client IP plus the window's start in
Unix milliseconds). The first hit in a window creates the counter and gives it a TTL of one window,
so old counters clean themselves up:

```lua
-- fixed_window.lua   KEYS[1] = counter key   ARGV[1] = window ms
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
```

```csharp
// db: IDatabase, time: TimeProvider (TimeProvider.System, or a fake in tests),
// FixedWindowScript: the Lua above as a string
app.Use(async (ctx, next) =>
{
    const int limit = 100;
    const long windowMs = 60_000;
    var now = time.GetUtcNow().ToUnixTimeMilliseconds();
    var windowStart = now / windowMs * windowMs;
    var key = $"rl:api:{ctx.Connection.RemoteIpAddress}:{windowStart}";

    var count = (long)await db.ScriptEvaluateAsync(FixedWindowScript, [key], [windowMs]);
    if (count > limit)
    {
        ctx.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        ctx.Response.Headers.RetryAfter = ((windowStart + windowMs - now + 999) / 1000).ToString();
        return;
    }
    await next();
});
```

:::warn title="The immortal counter"
A common incident: the code runs `INCR` and then, in a **separate** call, `EXPIRE`. One day the
process dies, or the `EXPIRE` times out, between the two. The key now has no TTL, and with a key
that doesn't include the window number, that user is **rate-limited forever**. Do both in one
script (as above), or in a `MULTI` transaction of `INCR key` plus `PEXPIRE key <ms> NX` (the `NX`
flag needs Redis 7+, and `EXPIRE` takes seconds, `PEXPIRE` milliseconds), so the TTL is set only once. Including the window start in the key name also limits the damage.
:::

Fixed windows are cheap (one integer per client per window) but have a known flaw, the
**boundary burst**: 100 requests at 12:00:59.9 and 100 more at 12:01:00.1 are both allowed, so you
get 200 requests in 200 ms with a "100/min" limit.

### Sliding window log: a sorted set

Keep a timestamp per request in a sorted set, scored by time. To decide on a hit: drop everything
older than one window, count what's left, allow and record if under the limit.

```lua
-- sliding_log.lua  KEYS[1] = zset  ARGV: now ms, window ms, limit, unique member
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[2])
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])   -- member must be unique: "<now>-<random>"
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
```

It's exact, with no boundary burst, but costs memory proportional to the limit (100 entries for
100/min) per client. Common alternatives:

| Algorithm | Memory per client | Accuracy | Notes |
|---|---|---|---|
| Fixed window (`INCR`) | 1 counter | Allows up to 2× at boundaries | Simplest; fine for coarse limits |
| Sliding window log (ZSET) | 1 entry per allowed request | Exact | Login throttling, small limits |
| Sliding window counter | 2 counters | Approximation (weights the previous window) | Popular at CDN/API-gateway scale |
| Token bucket / GCRA | 1–2 values | Smooth, allows controlled bursts | What most API gateways use |

:::pro title="Where limits live in a real system"
Coarse, per-IP limits usually sit at the edge (ingress controller, API gateway, CDN), before
traffic reaches your pods. Business limits ("free plan: 1 000 exports per month", "5 password
resets per account per hour") live in the application, keyed by user or tenant, often in Redis.
Return `429` with `Retry-After` so well-behaved clients back off. Decide what happens when Redis
is down: **fail open** (allow; the usual choice for API quotas) or **fail closed** (deny; for login
brute-force protection). Pass `now` from one clock, or use `redis.call('TIME')` inside the script,
so app servers with skewed clocks don't disagree about the window.
:::

:::quiz id=cl-03-q8 xp=10
Login is limited to **5 attempts per minute** with a fixed window (`INCR` on `rl:login:<ip>:<minute>`).
What is the most attempts an attacker can make within **2 seconds**?
- [ ] 5
- [ ] 6
- [x] 10
- [ ] Unlimited, because `INCR` isn't atomic
> 5 attempts in the last second of one window and 5 more in the first second of the next both pass, because each window counts on its own. The tempting answer, 5, is what a sliding window gives you, and it's the reason sliding logs or token buckets are used for sensitive limits. `INCR` is atomic; the weakness is the window boundary, not concurrency.
:::

### Challenges: two limiters

:::challenge id=cl-03-c3 lang=ts xp=40
title: Fixed-window rate limiter
Implement `FixedWindowLimiter(clock, limit, windowMs)` the way the Redis version works.

- Windows are aligned to the clock: `windowStart = Math.floor(now / windowMs) * windowMs`. The
  counter key is `` `${key}:${windowStart}` `` and it "expires" at `windowStart + windowMs`.
- `hit(key)` increments that counter (rejected hits count too, as with `INCR`) and returns
  `{ allowed, remaining, retryAfterMs }`:
  - `allowed`: `count <= limit`
  - `remaining`: `Math.max(0, limit - count)`
  - `retryAfterMs`: `0` when allowed, otherwise `windowStart + windowMs - now`
- `activeKeys()` returns how many counters have **not** expired yet (`expiresAt > now`). Expired
  counters must be dropped, like keys with a TTL, so memory doesn't grow forever.

hint: Keep a `Map<string, { count: number; expiresAt: number }>`. Purge expired entries at the start of `hit` and `activeKeys`.

```ts setup
interface Clock { now(): number }
class FakeClock {
  t = 0
  now(): number { return this.t }
  advance(ms: number): void { this.t += ms }
}
```

```ts starter
export class FixedWindowLimiter {
  private counts = new Map<string, number>()
  private clock: Clock
  private limit: number
  private windowMs: number
  constructor(clock: Clock, limit: number, windowMs: number) {
    this.clock = clock
    this.limit = limit
    this.windowMs = windowMs
  }
  hit(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const count = (this.counts.get(key) ?? 0) + 1   // never resets: the "immortal counter"
    this.counts.set(key, count)
    return { allowed: count <= this.limit, remaining: Math.max(0, this.limit - count), retryAfterMs: 0 }
  }
  activeKeys(): number { return this.counts.size }
}
```

```ts solution
export class FixedWindowLimiter {
  private counters = new Map<string, { count: number; expiresAt: number }>()
  private clock: Clock
  private limit: number
  private windowMs: number
  constructor(clock: Clock, limit: number, windowMs: number) {
    this.clock = clock
    this.limit = limit
    this.windowMs = windowMs
  }
  private purge(now: number) {
    for (const [k, c] of this.counters) if (c.expiresAt <= now) this.counters.delete(k)
  }
  hit(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = this.clock.now()
    this.purge(now)
    const windowStart = Math.floor(now / this.windowMs) * this.windowMs
    const k = `${key}:${windowStart}`
    const c = this.counters.get(k) ?? { count: 0, expiresAt: windowStart + this.windowMs }
    c.count++
    this.counters.set(k, c)
    const allowed = c.count <= this.limit
    return {
      allowed,
      remaining: Math.max(0, this.limit - c.count),
      retryAfterMs: allowed ? 0 : windowStart + this.windowMs - now,
    }
  }
  activeKeys(): number {
    this.purge(this.clock.now())
    return this.counters.size
  }
}
```

```ts tests
test('allows up to the limit, then blocks with Retry-After', () => {
  const clock = new FakeClock()
  clock.t = 250
  const rl = new FixedWindowLimiter(clock, 3, 1_000)
  expect(rl.hit('ip1')).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 })
  expect(rl.hit('ip1')).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 })
  expect(rl.hit('ip1')).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 })
  expect(rl.hit('ip1')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 750 })
})
test('the next window starts fresh', () => {
  const clock = new FakeClock()
  const rl = new FixedWindowLimiter(clock, 2, 1_000)
  rl.hit('ip1'); rl.hit('ip1'); rl.hit('ip1')
  clock.advance(1_000)
  expect(rl.hit('ip1')).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 })
})
test('keys are independent', () => {
  const rl = new FixedWindowLimiter(new FakeClock(), 1, 1_000)
  expect(rl.hit('a').allowed).toBe(true)
  expect(rl.hit('a').allowed).toBe(false)
  expect(rl.hit('b').allowed).toBe(true)
})
test('windows are aligned to the clock, not to the first hit', () => {
  const clock = new FakeClock()
  clock.t = 900
  const rl = new FixedWindowLimiter(clock, 1, 1_000)
  expect(rl.hit('a').allowed).toBe(true)
  clock.t = 999
  expect(rl.hit('a')).toEqual({ allowed: false, remaining: 0, retryAfterMs: 1 })
  clock.t = 1_000
  expect(rl.hit('a').allowed).toBe(true)
})
test('known weakness: up to 2x the limit across a boundary', () => {
  const clock = new FakeClock()
  const rl = new FixedWindowLimiter(clock, 3, 1_000)
  clock.t = 999
  const before = [rl.hit('x'), rl.hit('x'), rl.hit('x')].filter((r) => r.allowed).length
  clock.t = 1_000
  const after = [rl.hit('x'), rl.hit('x'), rl.hit('x')].filter((r) => r.allowed).length
  expect(before + after).toBe(6)
})
test('expired counters are dropped', () => {
  const clock = new FakeClock()
  const rl = new FixedWindowLimiter(clock, 5, 1_000)
  rl.hit('a'); clock.t = 1_000; rl.hit('a'); clock.t = 2_000; rl.hit('a'); rl.hit('b')
  expect(rl.activeKeys()).toBe(2)
  clock.t = 3_000
  expect(rl.activeKeys()).toBe(0)
})
```
:::

:::challenge id=cl-03-c4 lang=ts xp=40
title: Sliding-window log limiter
Implement `SlidingWindowLimiter(clock, limit, windowMs)` with `hit(key): boolean`, modelling the
sorted-set script:

1. Drop the key's timestamps that are `<= now - windowMs` (`ZREMRANGEBYSCORE -inf now-window`).
2. If fewer than `limit` remain, record `now` and return `true`.
3. Otherwise return `false` and **don't** record the rejected hit.

So in **any** window of `windowMs`, at most `limit` hits are allowed, with no boundary burst. The
starter is a fixed-window limiter. Make it slide.

hint: `Map<string, number[]>`; `list.filter((t) => t > now - windowMs)`.

```ts setup
interface Clock { now(): number }
class FakeClock {
  t = 0
  now(): number { return this.t }
  advance(ms: number): void { this.t += ms }
}
```

```ts starter
export class SlidingWindowLimiter {
  private counts = new Map<string, number>()
  private clock: Clock
  private limit: number
  private windowMs: number
  constructor(clock: Clock, limit: number, windowMs: number) {
    this.clock = clock
    this.limit = limit
    this.windowMs = windowMs
  }
  hit(key: string): boolean {
    const k = `${key}:${Math.floor(this.clock.now() / this.windowMs)}`
    const n = (this.counts.get(k) ?? 0) + 1
    this.counts.set(k, n)
    return n <= this.limit
  }
}
```

```ts solution
export class SlidingWindowLimiter {
  private logs = new Map<string, number[]>()
  private clock: Clock
  private limit: number
  private windowMs: number
  constructor(clock: Clock, limit: number, windowMs: number) {
    this.clock = clock
    this.limit = limit
    this.windowMs = windowMs
  }
  hit(key: string): boolean {
    const now = this.clock.now()
    const log = (this.logs.get(key) ?? []).filter((t) => t > now - this.windowMs)
    const allowed = log.length < this.limit
    if (allowed) log.push(now)
    if (log.length) this.logs.set(key, log)
    else this.logs.delete(key)
    return allowed
  }
}
```

```ts tests
test('allows up to the limit inside one window', () => {
  const rl = new SlidingWindowLimiter(new FakeClock(), 3, 1_000)
  expect([rl.hit('a'), rl.hit('a'), rl.hit('a'), rl.hit('a')]).toEqual([true, true, true, false])
  expect(rl.hit('b')).toBe(true)
})
test('no boundary burst', () => {
  const clock = new FakeClock()
  const rl = new SlidingWindowLimiter(clock, 3, 1_000)
  clock.t = 999
  rl.hit('x'); rl.hit('x'); rl.hit('x')
  clock.t = 1_000
  expect(rl.hit('x')).toBe(false)
  clock.t = 1_998
  expect(rl.hit('x')).toBe(false)
  clock.t = 1_999
  expect(rl.hit('x')).toBe(true)
})
test('slots free up one by one as old hits slide out', () => {
  const clock = new FakeClock()
  const rl = new SlidingWindowLimiter(clock, 2, 1_000)
  clock.t = 0; rl.hit('k')
  clock.t = 500; rl.hit('k')
  clock.t = 999
  expect(rl.hit('k')).toBe(false)
  clock.t = 1_000
  expect(rl.hit('k')).toBe(true)   // the hit at 0 slid out
  expect(rl.hit('k')).toBe(false)  // 500 and 1000 are still inside
  clock.t = 1_500
  expect(rl.hit('k')).toBe(true)
})
test('rejected hits are not recorded', () => {
  const clock = new FakeClock()
  const rl = new SlidingWindowLimiter(clock, 1, 1_000)
  expect(rl.hit('k')).toBe(true)          // t = 0
  clock.t = 600
  for (let i = 0; i < 5; i++) expect(rl.hit('k')).toBe(false)
  clock.t = 1_000
  expect(rl.hit('k')).toBe(true)          // only the hit at 0 counted
})
```
:::

## Running it for real: replicas, failover and what your client sees

Everything so far assumed one Redis server. In production you run a **primary with replicas**, and
something promotes a replica when the primary dies: **Sentinel** for a self-hosted primary/replica
set, the cluster bus for **Redis Cluster** (every shard is its own primary + replicas), or the cloud
provider for **Azure Managed Redis** or **ElastiCache / MemoryDB**. All of them fail over the same
way, and all of them can lose the last writes, because replication is asynchronous.

```text
 t=0.0 s   primary P dies (node lost). Replica R is ~20 ms behind: the last LPUSH + SET lease never arrived
 t=0–5 s   clients: timeouts, "No connection is active/available", in-flight commands fail
 t=5 s     Sentinels agree P is down (down-after-milliseconds = 5000, quorum reached)
 t=6 s     R is promoted (REPLICAOF NO ONE); other replicas re-point to it
 t=6–10 s  clients reconnect to R. A client still talking to the old P (if it comes back as a
           replica) gets "READONLY You can't write against a read only replica"
 Cluster:  the same, plus MOVED/ASK redirects and CLUSTERDOWN while the slot has no primary
```

Managed services quote failover in the range of **seconds to about a minute**. Your code has to
survive that window, and the writes lost in it. Walk through the patterns in this lesson:

| Pattern | What a lost write does | What already protects you |
|---|---|---|
| Reliable queue | The `LPUSH` of a new job is gone | Postgres is the truth, and a janitor re-enqueues rows Redis doesn't know (the boss builds this) |
| Lease key | The last heartbeat's `PEXPIRE` is lost, or the lease simply runs out while the worker can't reach Redis to renew it, so the reaper requeues a job that is still running | Idempotent handlers: the second run does no harm |
| Lock | The lock key is gone, so a second process acquires it while the first still works | **Fencing tokens** checked by the resource, or the database as the lock |
| Dedup marker / rate limit | A duplicate slips through, a counter restarts | Dedup inside the DB transaction; limits are approximate anyway |

Notice that nothing new is needed. Every row is one of the two questions from the start of the
lesson (*what if it dies now? what if it arrives twice?*), and failover is just one more way of
asking them.

**Client settings that matter (StackExchange.Redis):**

- Give the client the whole topology, not one host: all endpoints, or the Sentinel endpoints plus
  `serviceName=mymaster`, or the single cluster/managed endpoint the provider hands you.
- `abortConnect=false` so the app starts (and keeps running) while Redis is unreachable, and short
  `connectTimeout` / `syncTimeout` so a dead primary costs seconds, not minutes.
- **Retry operations that are safe to repeat** (ack, renew, reads) with a short backoff. A command
  that timed out *may or may not* have run on the old primary, which is one more reason handlers are
  idempotent. A retried **claim** is not idempotent: if the first attempt did run, a second job is
  claimed too. That is survivable only because the orphaned claim's lease expires and the reaper
  requeues it.
- Don't cache "who is primary" yourself. The client library tracks role changes.

`WAIT 1 100` after an important write blocks until one replica has it (or 100 ms pass), and
`min-replicas-to-write 1` makes the primary refuse writes when no replica is connected. Both shrink
the loss window. Neither turns Redis into a database.

:::pro title="Run a failover drill before production does it for you"
Teams that trust their Redis setup have watched it fail over. In staging, trigger one on purpose
(`SENTINEL FAILOVER mymaster`, Redis Cluster's `CLUSTER FAILOVER` on a replica, *Reboot / test
failover* in the Azure portal, or ElastiCache's `TestFailover` API) while a load test runs. Then
check three graphs: the error rate (did the retries hide it?), queue depth (did anything go
missing?) and duplicate side effects (did idempotency hold?). Write down how long the error spike
lasted. That number belongs in the runbook.
:::

:::quiz id=cl-03-q10 xp=15
A worker holds `SET dq:lock:report <token> NX PX 30000`. The primary acknowledged the write and
died 10 ms later, before replicating it. A replica is promoted. What happens next, and what keeps the
report correct?
- [ ] Nothing: the client library replays acknowledged writes on the new primary
- [ ] The new primary rejects new `SET NX` calls until the old lock's TTL has passed
- [x] The lock key doesn't exist on the new primary, so a second worker can acquire it while the first is still running; only a fencing token checked by the resource (or the DB as the lock) prevents a double effect
- [ ] Sentinel copies the missing keys from the dead primary's AOF during promotion
> Replication is asynchronous: the promoted replica never saw the `SET`, so to everyone else the
> lock is free, and `SET NX` succeeds for the second worker. Clients don't keep a log of
> acknowledged writes, and Sentinel promotes the replica's data as it is. Nothing is read from a
> dead node. This is why the lesson says a Redis lock gives *efficiency* (usually only one runs),
> and correctness needs **fencing**: the resource rejects writes carrying an older token, so the
> first worker's late write fails. Redlock across several masters narrows the window but has the
> same weakness under clock and pause problems.
:::

## Lab: a crash-proof Redis worker

:::lab id=cl-03-lab1 xp=150
title: BackgroundService on a reliable Redis queue, then kill -9 it
You'll run Redis 8 and **two replicas** of a .NET 10 worker in Docker Compose, enqueue jobs, and
kill a worker with `SIGKILL` in the middle of a job. The other replica's reaper should requeue the
job once the 10-second lease expires. You need the .NET 10 SDK and Docker with Compose v2.

**1. Create the project**

```bash
mkdir cl03-lab && cd cl03-lab
dotnet new worker -n QueueWorker -f net10.0
cd QueueWorker
dotnet add package StackExchange.Redis
rm Worker.cs
cd ..
```

**2. `QueueWorker/ReliableQueue.cs`**

```csharp
using StackExchange.Redis;

namespace QueueWorker;

public sealed record Job(string Id, string Payload, long Attempt);

public sealed class ReliableQueue(IConnectionMultiplexer redis, IConfiguration config)
{
    public const string Ready = "dq:jobs:ready";
    public const string Processing = "dq:jobs:processing";
    public const string Data = "dq:jobs:data";
    public const string Attempts = "dq:jobs:attempts";
    public const string Dead = "dq:jobs:dead";
    public const string LeasePrefix = "dq:jobs:lease:";

    public TimeSpan Lease { get; } = TimeSpan.FromSeconds(config.GetValue("Queue:LeaseSeconds", 10));
    public string WorkerId { get; } = $"{Environment.MachineName}-{Random.Shared.Next(1000, 9999)}";

    private IDatabase Db => redis.GetDatabase();
    private long LeaseMs => (long)Lease.TotalMilliseconds;

    // Atomically: oldest id → processing, take the lease, count the attempt, return id/attempt/payload.
    private const string ClaimScript = """
        local id = redis.call('LMOVE', KEYS[1], KEYS[2], 'RIGHT', 'LEFT')
        if not id then return false end
        redis.call('SET', ARGV[3] .. id, ARGV[1], 'PX', ARGV[2])
        local attempt = redis.call('HINCRBY', KEYS[3], id, 1)
        local payload = redis.call('HGET', KEYS[4], id) or ''
        return { id, attempt, payload }
        """;

    // Heartbeat: renew only if the lease is still ours.
    private const string ExtendScript = """
        if redis.call('GET', KEYS[1]) == ARGV[1] then
          return redis.call('PEXPIRE', KEYS[1], ARGV[2])
        end
        return 0
        """;

    // Done: anyone who finished the job may ack it. Removing it is what makes it never come back.
    private const string AckScript = """
        local removed = redis.call('LREM', KEYS[1], 1, ARGV[1])
        if removed == 1 then
          redis.call('DEL', KEYS[2])
          redis.call('HDEL', KEYS[3], ARGV[1])
          redis.call('HDEL', KEYS[4], ARGV[1])
        end
        return removed
        """;

    // Graceful shutdown: give the job back right away instead of waiting for the lease to expire.
    private const string AbandonScript = """
        if redis.call('GET', KEYS[2]) == ARGV[2] and redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
          redis.call('DEL', KEYS[2])
          redis.call('RPUSH', KEYS[3], ARGV[1])
          return 1
        end
        return 0
        """;

    // Too many attempts: park it in dq:jobs:dead for a human (payload stays in dq:jobs:data).
    private const string DeadLetterScript = """
        if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
          redis.call('DEL', KEYS[2])
          redis.call('LPUSH', KEYS[3], ARGV[1])
          return 1
        end
        return 0
        """;

    // Any processing id without a lease belonged to a dead worker: back to the FRONT of ready.
    private const string ReapScript = """
        local ids = redis.call('LRANGE', KEYS[2], 0, -1)
        local n = 0
        for _, id in ipairs(ids) do
          if redis.call('EXISTS', ARGV[1] .. id) == 0 then
            redis.call('LREM', KEYS[2], 1, id)
            redis.call('RPUSH', KEYS[1], id)
            n = n + 1
          end
        end
        return n
        """;

    public async Task<Job?> ClaimAsync()
    {
        var r = await Db.ScriptEvaluateAsync(ClaimScript,
            [Ready, Processing, Attempts, Data], [WorkerId, LeaseMs, LeasePrefix]);
        if (r.IsNull) return null;
        var parts = (RedisResult[])r!;
        return new Job((string?)parts[0] ?? "", (string?)parts[2] ?? "", (long)parts[1]);
    }

    public async Task<bool> ExtendAsync(Job job) =>
        (long)await Db.ScriptEvaluateAsync(ExtendScript, [LeasePrefix + job.Id], [WorkerId, LeaseMs]) == 1;

    public async Task<bool> AckAsync(Job job) =>
        (long)await Db.ScriptEvaluateAsync(AckScript,
            [Processing, LeasePrefix + job.Id, Attempts, Data], [job.Id]) == 1;

    public async Task<bool> AbandonAsync(Job job) =>
        (long)await Db.ScriptEvaluateAsync(AbandonScript,
            [Processing, LeasePrefix + job.Id, Ready], [job.Id, WorkerId]) == 1;

    public async Task<bool> DeadLetterAsync(Job job) =>
        (long)await Db.ScriptEvaluateAsync(DeadLetterScript,
            [Processing, LeasePrefix + job.Id, Dead], [job.Id]) == 1;

    public async Task<long> ReapAsync() =>
        (long)await Db.ScriptEvaluateAsync(ReapScript, [Ready, Processing], [LeasePrefix]);
}
```

**3. `QueueWorker/JobWorker.cs`**

```csharp
using System.Text.Json;
using StackExchange.Redis;

namespace QueueWorker;

public sealed class JobWorker(ReliableQueue queue, ILogger<JobWorker> log) : BackgroundService
{
    private const int MaxAttempts = 3;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        log.LogInformation("worker {Worker} started, lease {Lease}s", queue.WorkerId, queue.Lease.TotalSeconds);
        var idle = 100;
        while (!stoppingToken.IsCancellationRequested)
        {
            Job? job;
            try { job = await queue.ClaimAsync(); }
            catch (RedisException ex)
            {
                log.LogError(ex, "redis unavailable, retrying");
                await Task.Delay(1000, stoppingToken);
                continue;
            }

            if (job is null)
            {
                // StackExchange.Redis has no blocking pops: poll, backing off 100 ms → 1 s when idle.
                await Task.Delay(idle, stoppingToken);
                idle = Math.Min(idle * 2, 1000);
                continue;
            }
            idle = 100;

            if (job.Attempt > MaxAttempts)
            {
                await queue.DeadLetterAsync(job);
                log.LogError("{Id} failed {Count} times, moved to {Dead}", job.Id, job.Attempt - 1, ReliableQueue.Dead);
                continue;
            }
            await RunAsync(job, stoppingToken);
        }
    }

    private async Task RunAsync(Job job, CancellationToken stoppingToken)
    {
        var (seconds, fail) = Parse(job.Payload);
        log.LogInformation("claimed {Id} (attempt {Attempt}) for {Seconds}s", job.Id, job.Attempt, seconds);

        using var leaseLost = new CancellationTokenSource();
        using var stopHeartbeat = new CancellationTokenSource();
        using var work = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken, leaseLost.Token);
        var heartbeat = HeartbeatAsync(job, leaseLost, stopHeartbeat.Token);
        try
        {
            for (var i = 1; i <= seconds; i++)
            {
                await Task.Delay(1000, work.Token);
                if (fail && i == 2) throw new InvalidOperationException("simulated bug");
                log.LogInformation("{Id} progress {I}/{Total}", job.Id, i, seconds);
            }
            if (await queue.AckAsync(job)) log.LogInformation("{Id} done, acked", job.Id);
            else log.LogWarning("{Id} done, but it was already acked or requeued (it ran twice)", job.Id);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            var back = await queue.AbandonAsync(job);
            log.LogWarning("shutting down: {Id} {Result}", job.Id, back ? "requeued for another worker" : "was not ours anymore");
        }
        catch (OperationCanceledException) when (leaseLost.IsCancellationRequested)
        {
            log.LogWarning("lost the lease on {Id}, stopping (another worker will run it)", job.Id);
        }
        catch (Exception ex)
        {
            log.LogError("{Id} failed: {Message}. The lease will expire and the reaper retries it", job.Id, ex.Message);
        }
        finally
        {
            stopHeartbeat.Cancel();
            await heartbeat;
        }
    }

    private async Task HeartbeatAsync(Job job, CancellationTokenSource leaseLost, CancellationToken stop)
    {
        try
        {
            using var timer = new PeriodicTimer(queue.Lease / 3);
            while (await timer.WaitForNextTickAsync(stop))
                if (!await queue.ExtendAsync(job)) { leaseLost.Cancel(); return; }
        }
        catch (OperationCanceledException) { }
        catch (RedisException) { leaseLost.Cancel(); }
    }

    private static (int Seconds, bool Fail) Parse(string payload)
    {
        try
        {
            using var doc = JsonDocument.Parse(payload);
            var root = doc.RootElement;
            var seconds = root.TryGetProperty("seconds", out var s) ? s.GetInt32() : 1;
            var fail = root.TryGetProperty("fail", out var f) && f.GetBoolean();
            return (seconds, fail);
        }
        catch (Exception) { return (1, true); }   // unreadable payload: treat as failing
    }
}
```

**4. `QueueWorker/Reaper.cs`**

```csharp
using StackExchange.Redis;

namespace QueueWorker;

public sealed class Reaper(ReliableQueue queue, ILogger<Reaper> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(2));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                var n = await queue.ReapAsync();
                if (n > 0) log.LogWarning("reaper requeued {Count} job(s) with expired leases", n);
            }
            catch (RedisException ex) { log.LogError(ex, "reap failed"); }
        }
    }
}
```

**5. Replace `QueueWorker/Program.cs`**

```csharp
using QueueWorker;
using StackExchange.Redis;

var builder = Host.CreateApplicationBuilder(args);
builder.Logging.AddSimpleConsole(o => { o.SingleLine = true; o.TimestampFormat = "HH:mm:ss "; });

var redis = builder.Configuration["Redis:ConnectionString"] ?? "localhost:6379,abortConnect=false";
builder.Services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redis));
builder.Services.AddSingleton<ReliableQueue>();
builder.Services.AddHostedService<JobWorker>();
builder.Services.AddHostedService<Reaper>();
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(8));

builder.Build().Run();
```

Check it compiles:

```bash
dotnet build QueueWorker
# Build succeeded.
```

**6. `QueueWorker/Dockerfile` and `QueueWorker/.dockerignore`**

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY QueueWorker.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/runtime:10.0
WORKDIR /app
COPY --from=build /app ./
USER $APP_UID
ENTRYPOINT ["dotnet", "QueueWorker.dll"]
```

```text
bin/
obj/
```

**7. `compose.yaml` (in `cl03-lab/`)**

```yaml
name: cl03lab
services:
  redis:
    image: redis:8
    command: ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 15

  worker:
    build: ./QueueWorker
    environment:
      Redis__ConnectionString: "redis:6379,abortConnect=false"
      Queue__LeaseSeconds: "10"
    depends_on:
      redis:
        condition: service_healthy
    deploy:
      replicas: 2
```

**8. `enqueue.sh`**, which stores the payload and queues the id in one atomic script

```bash
#!/usr/bin/env bash
# usage: ./enqueue.sh <id> '<json payload>'
set -euo pipefail
docker compose exec -T redis redis-cli EVAL \
  "redis.call('HSET', KEYS[2], ARGV[1], ARGV[2]) return redis.call('LPUSH', KEYS[1], ARGV[1])" \
  2 dq:jobs:ready dq:jobs:data "$1" "$2"
```

```bash
chmod +x enqueue.sh
docker compose up --build -d
docker compose logs -f worker
# worker-1  | 10:00:01 info: QueueWorker.JobWorker[0] worker 3f2a9c1b7d4e-4821 started, lease 10s
# worker-2  | 10:00:01 info: QueueWorker.JobWorker[0] worker 9b8e7d6c5a4f-1377 started, lease 10s
```

**9. The happy path.** In a second terminal (same folder):

```bash
./enqueue.sh j1 '{"seconds":5}'
# 1
```

Expected logs: one worker claims it, counts to 5 and acks. Then confirm nothing is left:

```text
worker-2  | 10:00:12 info: QueueWorker.JobWorker[0] claimed j1 (attempt 1) for 5s
worker-2  | 10:00:13 info: QueueWorker.JobWorker[0] j1 progress 1/5
...
worker-2  | 10:00:17 info: QueueWorker.JobWorker[0] j1 done, acked
```

```bash
docker compose exec redis redis-cli LLEN dq:jobs:ready        # (integer) 0
docker compose exec redis redis-cli LLEN dq:jobs:processing   # (integer) 0
```

**10. Kill -9 mid-job.** Enqueue a long job and note which replica claims it:

```bash
./enqueue.sh j2 '{"seconds":30}'
```

When you see `worker-N … j2 progress 3/30`, kill **that** container without any chance to clean up
(replace `1` with the replica that took it):

```bash
docker kill --signal KILL cl03lab-worker-1
docker compose exec redis redis-cli LRANGE dq:jobs:processing 0 -1   # 1) "j2"  (still recorded!)
docker compose exec redis redis-cli PTTL dq:jobs:lease:j2            # e.g. (integer) 6120, counting down
```

Within about 10–12 s of the kill, the surviving replica's reaper finds the expired lease:

```text
worker-2  | 10:01:20 warn: QueueWorker.Reaper[0] reaper requeued 1 job(s) with expired leases
worker-2  | 10:01:20 info: QueueWorker.JobWorker[0] claimed j2 (attempt 2) for 30s
...
worker-2  | 10:01:50 info: QueueWorker.JobWorker[0] j2 done, acked
```

Note that j2 **starts over from 1/30**. The first run's work is lost and redone, which is
at-least-once in practice. Bring the killed replica back with `docker compose up -d`.

**11. Graceful shutdown vs kill.** Enqueue `./enqueue.sh j3 '{"seconds":30}'`, then **stop**
(SIGTERM, not KILL) the replica that claimed it:

```bash
docker stop cl03lab-worker-2      # use the replica that has j3
```

```text
worker-2  | 10:03:05 warn: QueueWorker.JobWorker[0] shutting down: j3 requeued for another worker
worker-1  | 10:03:05 info: QueueWorker.JobWorker[0] claimed j3 (attempt 2) for 30s
```

There's no 10-second wait this time: the worker gave the job back itself. This is what happens
on every deploy and KEDA scale-down. `kill -9` and OOM kills take the slower lease path.

**12. A poison job.** `docker compose up -d`, then `./enqueue.sh j4 '{"seconds":5,"fail":true}'`.
Watch it fail, get reaped after each lease expiry, and land in the dead-letter list after 3 attempts:

```bash
docker compose exec redis redis-cli LRANGE dq:jobs:dead 0 -1     # 1) "j4"
docker compose exec redis redis-cli HGET dq:jobs:data j4         # the payload, kept for debugging
```

:::tip title="Explore further"
- Set `Queue__LeaseSeconds: "3"` and enqueue `{"seconds":20}`. The heartbeat (every 1 s) still
  keeps the job alive. Then replace `var heartbeat = HeartbeatAsync(...)` with
  `var heartbeat = Task.CompletedTask;`, rebuild, and watch the reaper requeue the job every few
  seconds while it is still running, so several replicas run it at once.
- `docker compose exec redis redis-cli MONITOR` shows every command, including the `EVALSHA`/`EVAL`
  calls. Don't do this on a production Redis.
- Clean up with `docker compose down -v`.
:::

- [ ] Both replicas start and log `started, lease 10s`
- [ ] A short job is claimed, acked, and afterwards `dq:jobs:ready` and `dq:jobs:processing` are both empty
- [ ] After `docker kill --signal KILL`, the job stays in `dq:jobs:processing` and its lease TTL counts down
- [ ] The surviving replica requeues the job and runs it as `attempt 2` within about 12 s
- [ ] `docker stop` (SIGTERM) requeues the in-flight job immediately via `AbandonAsync`
- [ ] The failing job ends up in `dq:jobs:dead` after 3 attempts
- [ ] I can explain why j2 ran twice and what that means for the handler's design
:::

## Flashcards

:::cards id=cl-03-cards1 xp=15 title="Redis queues, bus and locks"
Q: Why does `BRPOP` lose jobs?
A: After the pop, the job exists only in the worker's memory. A crash, `kill -9` or OOM kill before it finishes loses it without a trace.
Q: The reliable list queue, in four steps?
A: Claim (`LMOVE ready → processing` + lease key with TTL, atomically in Lua), heartbeat (renew the lease if it's still ours), ack (`LREM processing` + `DEL lease`), reap (requeue processing ids whose lease expired).
Q: What replaced `RPOPLPUSH`?
A: `LMOVE` (and `BLMOVE`), since Redis 6.2.
Q: Why must a Redis instance holding queues and locks use `noeviction`?
A: Under memory pressure an evicting policy can delete job lists or lease keys (`volatile-*` evicts keys with a TTL, so leases go first), which loses jobs or makes them run twice.
Q: What delivery guarantee does a reliable queue give, and what does it demand from handlers?
A: At-least-once. Handlers must be idempotent: a dedup record in the same DB transaction as the effect, or idempotency keys for external calls.
Q: Streams: what are the PEL and `XAUTOCLAIM`?
A: The Pending Entries List holds delivered but unacked messages per consumer. `XAUTOCLAIM` transfers entries idle longer than a threshold to another consumer, which is how you recover from a crashed consumer.
Q: Does `XREADGROUP … >` return a crashed consumer's pending messages?
A: No. `>` returns only never-delivered messages. Pending ones need `XAUTOCLAIM` / `XCLAIM`, or the same consumer re-reading with id `0`.
Q: What happens to a pub/sub message when nobody is subscribed?
A: It's dropped. `PUBLISH` returns 0 receivers. Pub/sub is at-most-once, with no storage or replay.
Q: Why does the SignalR Redis backplane tolerate pub/sub's guarantees?
A: Live UI updates are best-effort. Clients refetch state on reconnect, so a dropped message only means a briefly stale screen.
Q: How do you acquire and release a Redis lock correctly?
A: `SET key <random token> NX PX <ttl>`. Release with an atomic compare-and-delete (Lua: `if GET == token then DEL`) or `LockReleaseAsync`.
Q: What is a fencing token?
A: A number that increases with every lock acquisition (`INCR`). The protected resource rejects writes with a lower token than it has seen, which stops a paused, expired holder from writing.
Q: Redlock's main caveat?
A: Its safety depends on timing assumptions (bounded pauses, network delay, clock drift) and it has no fencing. Use it for efficiency; for correctness, add fencing or let the database enforce it.
Q: Fixed-window rate limiting: implementation and weakness?
A: `INCR` a per-window key and set the TTL on the first hit, atomically. It allows up to 2× the limit across a window boundary.
Q: Sliding window log in Redis?
A: A sorted set of request timestamps: `ZREMRANGEBYSCORE` to drop old ones, `ZCARD` to count, `ZADD` if under the limit, all in one script. Exact, but one entry per request.
Q: Why isn't ASP.NET Core's built-in rate limiter enough with 4 replicas?
A: Its counters are in memory per instance, so each pod allows the full limit (4× overall). Use a shared store such as Redis, or limit at the gateway.
:::

## Recap

- Ask two questions of every Redis coordination pattern: *what if the holder dies now?* and *what
  if it arrives twice?*
- `BRPOP` is **at-most-once**: a killed worker loses the job. The reliable queue (`LMOVE` into a
  processing list, a lease key with TTL plus heartbeat, ack via `LREM`, a reaper that requeues
  expired leases) is **at-least-once** and survives crashes, OOM kills and scale-down.
- At-least-once requires **idempotent handlers**. Redis dedup markers reduce duplicates but don't
  make side effects correct. Put dedup records in the same transaction as the effect.
- **Streams + consumer groups** give you the processing-list bookkeeping built in (PEL, `XACK`,
  `XPENDING`, `XAUTOCLAIM`), plus fan-out to several groups and replay. Watch trimming and poison
  messages.
- **Pub/sub** is fire-and-forget. It's right for cache invalidation, wake-up nudges and the SignalR
  backplane, and wrong for anything that must arrive.
- **Locks**: `SET NX PX` with a random token, an atomic compare-and-delete release, and a TTL longer
  than the work (or a renewal). For correctness, add **fencing tokens** checked by the resource, or
  let the database be the lock.
- **Rate limiting**: fixed window (`INCR` + TTL, set atomically) is cheap but bursts at boundaries.
  A sorted-set sliding log is exact. Per-instance limiters multiply by your replica count.
- Run queue/lock Redis with `noeviction` and AOF, and remember that replication is async. Data
  that must never be lost has its source of truth in PostgreSQL (be-16, *Message Brokers & the Outbox Pattern*).
- **Failover** loses the last writes. Give the client the whole topology, retry idempotent
  commands, and run a failover drill in staging. Fencing and Postgres-as-truth cover what's lost.
- On Azure or AWS, the queue half of this lesson is often a managed broker with the lease built in
  (Service Bus peek-lock, SQS visibility timeout). **The Managed Equivalents: Azure & AWS** maps
  each pattern to its managed service.
