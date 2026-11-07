---
id: cl-01
title: Redis Fundamentals
level: beginner
minutes: 150
xp: 100
summary: What Redis really is, why it is so fast (one thread, all in RAM), its core data types, keys and TTLs, atomic INCR, persistence and eviction — and why it is never your primary database.
---

Open the architecture diagram of almost any SaaS product and next to PostgreSQL you will find a
small red box labelled **Redis**. It holds the things that must be *fast* and are allowed to be
*temporary*: cached API responses, login sessions, rate-limit counters, "who is online" sets,
leaderboards, job queues, distributed locks. This lesson builds the mental model you need before
using it from .NET in **Caching with Redis in .NET** and as a queue/lock in **Redis as Queue, Bus and Lock**.
If you haven't yet seen where Redis sits next to the broker, object storage, identity and
observability boxes, skim **Cloud-Native Primer: The Big Picture** first.

## What Redis actually is

Redis is an **in-memory data structure server**. Three words, three ideas:

* **In-memory** — the whole dataset lives in RAM. Reading a key does not touch a disk, so a
  typical command finishes in **microseconds**; the network round trip (~0.1–1 ms) is usually the
  slowest part.
* **Data structure** — values are not just blobs. A value can be a string, a hash, a list, a set,
  a sorted set, a stream… and the server runs operations *on* those structures ("add 10 points to
  Ada's score and tell me her new rank"). You don't download, modify and re-upload.
* **Server** — it is a network service (TCP port **6379**) shared by all instances of your API.
  That is the point: an in-process `Dictionary` cache is per pod; Redis is one shared memory for
  the whole fleet.

```text
            ┌────────── Kubernetes ───────────┐
 browser ─► │ api pod 1 ─┐                     │
 browser ─► │ api pod 2 ─┼──► Redis  (RAM, µs) │   sessions, cache, counters, queues
 browser ─► │ api pod 3 ─┘      │              │
            │ worker pod ───────┘              │
            │        └──────────► PostgreSQL   │   the source of truth (disk, ms)
            └──────────────────────────────────┘
```

| Use case | Why Redis fits | Lesson |
|---|---|---|
| Cache in front of Postgres | µs reads, TTL built in | Caching with Redis in .NET |
| Sessions / tokens | shared across pods, expire automatically | this lesson |
| Rate limiting | atomic `INCR` + `EXPIRE` | this lesson |
| Leaderboards, "top N" | sorted sets keep order for you | this lesson |
| Job queues, pub/sub, locks | lists, streams, `SET NX` | Redis as Queue, Bus and Lock |

:::info title="Redis, Valkey and licences"
In 2024 Redis moved from the BSD licence to source-available licences (RSALv2/SSPL); the Linux
Foundation forked the last BSD version as **Valkey**, which many cloud providers now offer.
**Redis 8** (2025) added AGPLv3 as an open-source option and folded the former "Redis Stack"
modules (JSON, Query Engine, time series, probabilistic types) into the core. For everything in this
lesson Redis 8 and Valkey behave the same and speak the same protocol — StackExchange.Redis talks to both.
:::

## Why it is fast: one thread, one command at a time

Redis executes commands on **a single main thread** using an **event loop**: one loop that asks the
operating system "which of my thousands of sockets have data?" (`epoll` on Linux, `kqueue` on
macOS/BSD), reads the complete commands that arrived, runs them, writes the replies, and goes round
again. No thread per client, no context switches, no locks. Many clients connect, but their
commands run **strictly one after another**:

```text
 client A: INCR views ─┐
 client B: GET user:1 ─┼──►  [ event loop ]  ──► INCR views   (done, 2 µs)
 client C: INCR views ─┘     one at a time       GET user:1   (done, 1 µs)
                                                 INCR views   (done, 2 µs)
```

Two consequences you must internalise:

1. **Every single command is atomic.** No other command can run "in the middle" of an `INCR`.
   There are no locks inside Redis, because there is nothing to race with. This is why `INCR` is
   the right way to count, and `GET` + `SET` from your code is not (see below).
2. **One slow command blocks everybody.** `KEYS *` on 20 million keys, `SMEMBERS` on a set with a
   million members, a heavy Lua script — while it runs, *every* other client waits. Latency is a
   shared resource.

The Redis docs list a **time complexity** for every command, and it is worth reading. **O(1)**
means constant work no matter how big the data is (`GET`, `SET`, `INCR`). **O(log N)** grows
very slowly: a sorted set with a million members needs about 20 steps (`ZADD`, `ZRANK`).
**O(N)** means the work grows with the number of elements N, so it is fine on 100 keys and
freezes the server on 20 million (`KEYS`, `SMEMBERS`, `HGETALL` on a huge hash).

Modern Redis does use extra threads — for socket I/O (`io-threads`), freeing big values in the
background (`UNLINK`), and fsync — but **command execution stays single-threaded**. To use more
cores you run more Redis processes (replicas for reads, Redis Cluster for sharding).

:::warn title="KEYS is not a query language"
`KEYS pattern` scans the entire keyspace in one go — O(N) — and freezes the server while it does.
It is the classic "someone ran it in prod and every API request timed out" incident. Use the
cursor-based `SCAN 0 MATCH app:user:* COUNT 100`, which returns a small batch plus a cursor and
lets other commands run in between. Many teams disable `KEYS` entirely with ACLs or `rename-command`.
:::

### The lost update that INCR prevents

```text
  pod 1                       Redis (views = 41)         pod 2
  GET views  ───────────────►  "41"
                               "41"  ◄───────────────── GET views
  SET views 42 ─────────────►  42
                               42    ◄───────────────── SET views 42     ✗ one view lost
```

Both pods read 41 and both write 42. With `INCR views` the read-modify-write happens *inside*
Redis, in one command, and the result is 43. The same idea gives you rate limiters, ID
generators and inventory counters (`DECRBY stock:sku-9 1`).

:::quiz id=cl-01-q1 xp=10
Ten API pods each run `INCR dq:article:7:views` at the same moment. The key started at `100`.
What is its value afterwards?

- [ ] Somewhere between 101 and 110 — the increments race
- [x] Exactly 110
- [ ] 101 — Redis collapses identical concurrent commands
- [ ] It depends on how many I/O threads are configured
> Redis executes commands one at a time on its main thread, so each `INCR` is an atomic
> read-modify-write: ten commands, ten increments, 110. The tempting "they race" answer is true
> for `GET` followed by `SET` from application code — two separate commands with a gap between
> them — but not for a single `INCR`. I/O threads only read and write sockets; they never execute
> commands in parallel.
:::

## The core data types

A Redis database is one big map **key → value**, and each value has a type. Pick the type by the
**operation** you need, not by the shape of the data.

| Type | Think of it as | Key commands | Typical use |
|---|---|---|---|
| **String** | a byte blob (≤ 512 MB), or a number | `SET` `GET` `INCR` `INCRBY` `MGET` | cached JSON, counters, flags, tokens |
| **Hash** | a small object / `Dictionary<string,string>` | `HSET` `HGET` `HGETALL` `HINCRBY` | user profile, session fields |
| **List** | a linked list / deque | `LPUSH` `RPUSH` `LPOP` `BRPOP` `LRANGE` | simple queues, "last 50 events" |
| **Set** | unordered unique members | `SADD` `SISMEMBER` `SCARD` `SINTER` | tags, "who liked this", online users |
| **Sorted set** | unique members **ordered by a score** | `ZADD` `ZINCRBY` `ZRANGE … REV` `ZRANK` | leaderboards, priority, time windows |
| **Stream** | an append-only log with consumer groups | `XADD` `XREADGROUP` `XACK` | event log, reliable work queue |

Redis 8 also ships JSON documents, vector sets, time series, Bloom filters and a query engine —
useful, but the six above are what you will meet first.

**Streams in one paragraph.** A list is a queue where `LPOP` *removes* the item: if the worker
crashes right after popping, the job is gone. A stream is an append-only log: `XADD` appends an
entry with a time-based ID, entries stay until you trim them (`MAXLEN`), and a **consumer group**
(`XREADGROUP`) hands each entry to one worker and remembers it as *pending* until that worker
confirms with `XACK`. Crashed workers' entries can be reclaimed (`XAUTOCLAIM`). That makes streams
the reliable work queue and event log of Redis — covered properly in **Redis as Queue, Bus and Lock**.

```bash
# strings
SET dq:feature:dark-mode on
INCR dq:article:7:views                 # → (integer) 1 (missing key counts as 0)

# hash = one object, many fields
HSET dq:user:42 name Ada plan pro       # → (integer) 2
HINCRBY dq:user:42 logins 1             # → (integer) 1

# list = queue
RPUSH dq:jobs:email a b c               # → (integer) 3
LPOP dq:jobs:email                      # → "a"

# set = unique members
SADD dq:online:2026-11-05T16:22 u1 u2 u1   # → (integer) 2   (u1 only once)

# sorted set = ranking
ZADD dq:lb:weekly 1200 ada 950 linus 1800 grace
ZRANGE dq:lb:weekly 0 2 REV WITHSCORES  # top 3, highest first

# stream = log with IDs
XADD dq:events * type signup user 42    # → "1793895720000-0" (ms timestamp - sequence)
```

:::tip title="ZREVRANGE vs ZRANGE … REV"
Since Redis 6.2 `ZRANGE` takes `REV`, `BYSCORE` and `LIMIT`, and the docs mark `ZREVRANGE` as
deprecated (it still works and you will see it in older code). Same result, one command to remember.
:::

Under the hood small values use compact encodings (`listpack`, `intset`, `int`) and switch to
real hash tables / skip lists when they grow. You can peek with `OBJECT ENCODING key` — it is the
reason a million tiny hashes are much cheaper than a million separate string keys.

### Sorted sets in one picture

A sorted set keeps every member next to a score, always ordered, with O(log N) inserts and rank
lookups (a skip list plus a hash table):

```text
 ZADD dq:lb:weekly 1800 grace 1200 ada 950 linus
 ┌───────┬───────┬──────────────┐
 │ rank  │ score │ member       │   ZRANGE … 0 0 REV  → grace
 ├───────┼───────┼──────────────┤   ZREVRANK … ada    → 1
 │ 0     │ 1800  │ grace        │   ZINCRBY … 700 ada → 1900 (ada is now rank 0)
 │ 1     │ 1200  │ ada          │
 │ 2     │  950  │ linus        │   equal scores → ordered by member (lexicographically;
 │       │       │              │   REV / ZREVRANGE reverse that too)
 └───────┴───────┴──────────────┘
```

:::quiz id=cl-01-q2 xp=10
You need a weekly leaderboard: add points after every game, show the top 10 with scores, and
show "you are #4,213" to each player. Which type fits best?

- [ ] A list — `RPUSH` each result and `LRANGE 0 9`
- [ ] A hash `player → points`, sorted in the API
- [x] A sorted set — `ZINCRBY` for points, `ZRANGE 0 9 REV WITHSCORES`, `ZREVRANK` for the position
- [ ] A set of `player:points` strings
> A sorted set keeps members ordered by score on every write, so top-N and rank are O(log N)
> server-side operations. The hash is tempting because it stores the data fine — but every request
> would have to download *all* players and sort them in C#, which collapses at a few hundred
> thousand players. A list keeps insertion order, not score order, and stores every game as a
> separate entry instead of a running total. A set of `player:points` strings has no order at all,
> and updating a score means removing the old string and adding a new one.
:::

## Keys: naming, TTL and expiry

### Naming conventions

Redis has no tables or schemas — just one flat keyspace per database. Teams impose structure with
a naming convention, almost always colon-separated, **general to specific**:

```text
 <app>:<entity>:<id>[:<field-or-purpose>]

 dq:user:42                     hash with the profile
 dq:user:42:sessions            set of session ids
 dq:session:9f2c…               session payload (TTL 30 min)
 dq:cache:article:7:v3          cached JSON, version 3 of the shape
 dq:ratelimit:ip:203.0.113.9:202611051622   counter for one minute
```

* The **app prefix** lets several services share one instance without collisions and lets you
  `SCAN MATCH dq:cache:*` when you need to find (or purge) a family of keys. GUI tools such as
  Redis Insight render colons as folders.
* A **version segment** (`:v3`) means a deploy that changes the cached shape simply reads new keys;
  the old ones age out with their TTL instead of crashing the new code.
* Keep keys readable but not huge — every key costs memory, and you will read them in incidents.
* In **Redis Cluster** a `{hash tag}` such as `dq:{user:42}:cart` forces related keys onto the same
  shard so multi-key commands work. You won't need it on a single instance.

### TTL and EXPIRE

Any key can carry an expiry. Redis deletes it for you — the reason Redis is so good for things
that should not live forever.

```bash
SET dq:session:abc '{"userId":42}' EX 1800   # value + 30 min TTL in one atomic command
TTL dq:session:abc        # → (integer) 1800   seconds left
EXPIRE dq:session:abc 60  # → (integer) 1      reset TTL (sliding session)
PERSIST dq:session:abc    # → (integer) 1      remove the TTL
TTL dq:session:abc        # → (integer) -1     exists, no expiry
TTL dq:nope               # → (integer) -2     does not exist
SET dq:lock:job:9 7f3c9a1e NX EX 30   # only if Not eXists → the basis of locks
```

The value of a lock key is a **random token** unique to this holder (a GUID in real code), not a
fixed string like `me`. Releasing the lock must check that the key still holds *your* token before
deleting it, otherwise a slow worker can delete a lock that has already expired and been taken by
someone else. **Redis as Queue, Bus and Lock** builds the full pattern: token, compare-and-delete
in Lua, and fencing.

| `TTL` returns | Meaning |
|---|---|
| `n ≥ 0` | seconds left (`PTTL` gives milliseconds) |
| `-1` | key exists, never expires |
| `-2` | key does not exist (or already expired) |

Rules that bite people:

* A plain `SET` **overwrites the TTL** — the key becomes permanent unless you pass `EX`/`PX` again
  or `KEEPTTL`. "Our cache never expires" is very often this.
* `INCR`, `HSET`, `RPUSH` etc. **keep** an existing TTL; they don't set one. A rate-limit key
  created by `INCR` has *no* TTL until you `EXPIRE` it.
* `EXPIRE key 0` (or negative) deletes the key immediately.
* Expiry is **lazy + active**: a key is removed when someone touches it after its deadline, and a
  background cycle samples keys with TTLs and deletes expired ones. Expired keys may sit in memory
  briefly, but you will never *read* one.
* Since Redis 7.4 individual **hash fields** can expire too (`HEXPIRE`), handy for per-field caches.

:::quiz id=cl-01-q3 xp=10
```bash
SET dq:cache:article:7 '{"v":1}' EX 300
SET dq:cache:article:7 '{"v":2}'
TTL dq:cache:article:7
```
What does the last line return?

- [ ] About `300` — the TTL belongs to the key, not the value
- [x] `-1`
- [ ] `-2`
- [ ] An error, because the key already has a TTL
> A plain `SET` replaces the value *and* discards the old TTL, so the key now exists without an
> expiry: `-1`. The tempting "about 300" is how many people assume it works — and that assumption
> produces caches that silently never expire. Pass `EX` on every write (or `KEEPTTL` if you really
> want to keep the old deadline). `-2` would mean the key doesn't exist.
:::

### A rate limiter in three commands

```text
 INCR   dq:ratelimit:ip:203.0.113.9:202611051622   → 1, 2, 3 …
 EXPIRE dq:ratelimit:ip:203.0.113.9:202611051622 60   (only when INCR returned 1)
 if count > 100 → HTTP 429
```

The minute is part of the key, so every minute starts fresh and the TTL cleans up behind you. (Two
separate commands means a crash between them could leave a key without TTL — in production you
wrap both in `MULTI`/`EXEC` or a Lua script; **Redis as Queue, Bus and Lock** covers that. ASP.NET
Core's built-in rate limiter is in-memory per pod — Redis is how you make it fleet-wide.)

### From C# with StackExchange.Redis

StackExchange.Redis is the standard .NET client. Its `ConnectionMultiplexer` is expensive to create,
thread-safe and **multiplexes** all your concurrent calls over one connection — register it **once**
as a singleton.

```csharp
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    ConnectionMultiplexer.Connect(builder.Configuration.GetConnectionString("Redis") ?? "localhost:6379,abortConnect=false"));

var app = builder.Build();

app.MapPost("/articles/{id:int}/views", async (int id, IConnectionMultiplexer redis) =>
{
    IDatabase db = redis.GetDatabase();
    long views = await db.StringIncrementAsync($"dq:article:{id}:views");   // INCR
    return Results.Ok(new { id, views });
});

app.MapPost("/games/{player}/score/{points:int}", async (string player, int points, IConnectionMultiplexer redis) =>
{
    IDatabase db = redis.GetDatabase();
    double total = await db.SortedSetIncrementAsync("dq:lb:weekly", player, points);          // ZINCRBY
    long? rank = await db.SortedSetRankAsync("dq:lb:weekly", player, Order.Descending);       // ZREVRANK
    SortedSetEntry[] top = await db.SortedSetRangeByRankWithScoresAsync("dq:lb:weekly", 0, 9, Order.Descending);
    return Results.Ok(new { player, total, rank = rank + 1, top = top.Select(e => new { member = e.Element.ToString(), e.Score }) });
});

app.Run();
```

:::warn title="Don't connect per request"
`ConnectionMultiplexer.Connect(...)` inside a handler opens a new TCP connection (and handshake)
on every request and leaks sockets under load. One multiplexer per process, injected everywhere, is
the documented pattern. `GetDatabase()` is cheap — call it whenever you like.

Also add `abortConnect=false` to production connection strings
(`redis:6379,abortConnect=false`). With the default (`true`), `Connect` **throws**
`RedisConnectionException` if Redis is unreachable at that moment. With the lazy singleton above
(the factory runs the first time a handler asks for `IConnectionMultiplexer`), the first request
that needs Redis fails, and because DI doesn't cache a factory that threw, every later request
retries a slow, blocking `Connect` until Redis is back. If you resolve it eagerly at startup, the
app crashes instead. With `false` the multiplexer is created anyway and reconnects in the
background; commands fail fast while Redis is down and work again once it returns.
:::

## Persistence: RDB, AOF — and why Redis is not your primary DB

RAM vanishes when the process dies, so Redis can optionally write to disk:

| | **RDB snapshot** | **AOF (append-only file)** |
|---|---|---|
| What | a compact point-in-time dump of the whole dataset | a log of every write command, replayed on start |
| How | `fork()` a child process; it writes the snapshot while the parent keeps serving (copy-on-write) | each write appended; fsync per `appendfsync` setting |
| Config | `save 300 100` = snapshot if ≥100 changes in 300 s | `appendonly yes`, `appendfsync everysec` |
| You lose on crash | everything since the last snapshot (minutes) | `everysec`: about the last second; `always`: ~nothing, but much slower |
| Restart speed | fast (load one file) | slower (replay), mitigated by rewrite with an RDB preamble |

Out of the box, with no config file, Redis 7+ has RDB snapshots **on**
(`save 3600 1 300 100 60 10000`: after an hour if at least 1 key changed, after 5 minutes if 100
changed, after a minute if 10 000 changed) and AOF **off**. So a default container loses up to
several minutes of writes on a crash. And because the official image declares `VOLUME /data`,
Docker puts `/data` on an **anonymous** volume: the dump survives `docker restart`, but when you
remove the container its data stays behind in an orphaned anonymous volume that the next container
won't use, unless `/data` is on a **named** volume (`-v redisdata:/data`).

Modern Redis (7+) stores AOF as a directory (`appendonlydir/` with a base RDB file, incremental AOF
files and a manifest) and compacts it automatically. Many production setups run **AOF everysec**,
or both. Pure caches often run **no persistence at all** (`--save "" --appendonly no`): a cold
cache is slow, not wrong.

:::warn title="fork() and memory"
An RDB snapshot or AOF rewrite forks the process. Pages that change during the snapshot get
copied, so a write-heavy instance can briefly need much more RAM than its dataset. In Kubernetes,
set `maxmemory` well **below** the container memory limit (a common rule of thumb is ~60–75%) or the
kernel OOM-kills Redis in the middle of saving.
:::

Even with AOF, Redis should not be the **source of truth** for business data:

* **Everything must fit in RAM.** RAM costs many times more per GB than SSD; your orders table grows forever.
* **Weaker durability.** `everysec` can lose acknowledged writes; replication to replicas is
  asynchronous, so a failover can lose writes the client was told succeeded.
* **No relational model.** No joins, foreign keys, constraints, ad-hoc `WHERE` queries, migrations
  or multi-key transactions with rollback. Every access path is a key you designed up front.
* **Eviction.** With an eviction policy configured, Redis is *allowed* to throw data away (next section).

The rule real teams use: **if Redis is wiped, the product must keep working** — slower, users
re-login, counters restart — but no business data is gone, because it lives in PostgreSQL.

:::job title="What you'll hear in week one"
"Is it in Postgres or just in Redis?" is a real code-review question. Caches, sessions, rate limits,
presence and leaderboards that can be rebuilt are fine in Redis. Orders, payments, user accounts
and anything a customer would call support about belong in the database. Redis in production is
usually a managed service (Azure Managed Redis / Azure Cache for Redis, AWS ElastiCache or
MemoryDB, Google Memorystore) or an operator/Helm chart in the cluster — you get a connection
string and a key prefix, and you are expected to set TTLs on everything you write.
:::

:::quiz id=cl-01-q4 xp=10
Your team runs Redis with `appendonly yes` and `appendfsync everysec`. A product manager suggests
storing completed orders only in Redis "because it's persistent now". What is the best objection?

- [ ] AOF is only read for debugging; Redis never reloads it on restart
- [x] Durability is still weaker than Postgres (up to ~1 s of acknowledged writes can be lost, async replication can lose more on failover), the data must fit in RAM, and there are no constraints or queries
- [ ] With AOF enabled Redis becomes single-threaded and too slow
- [ ] AOF files are encrypted and can't be backed up
> AOF really is replayed on startup, so "persistent" isn't false — that's what makes the
> suggestion tempting. But `everysec` fsyncs once per second, replication is asynchronous, the whole
> dataset lives in expensive RAM, and you lose SQL, constraints and transactions. Redis was already
> single-threaded for commands regardless of AOF, and AOF files are plain files you can back up.
:::

## Memory limits and eviction

By default Redis on 64-bit has **no memory limit** (`maxmemory 0`) and the policy is
`noeviction`. In a container that means "grow until the OOM killer arrives". Always set both:

```bash
redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
```

When used memory reaches `maxmemory`, the **policy** decides what happens on the next write:

| Policy | Evicts from | Picks | Use when |
|---|---|---|---|
| `noeviction` (default) | nothing | — writes fail with `OOM command not allowed…` | data you must not lose silently (queues, locks) |
| `allkeys-lru` | all keys | least recently used | **pure cache** — the usual choice |
| `allkeys-lfu` | all keys | least frequently used | cache with stable "hot" keys |
| `allkeys-random` | all keys | random | uniform access patterns |
| `volatile-lru` / `volatile-lfu` | only keys **with a TTL** | LRU / LFU | mixed instance: cache keys have TTLs, others must stay |
| `volatile-random` | only keys with a TTL | random | rarely |
| `volatile-ttl` | only keys with a TTL | shortest remaining TTL first | "soonest to die anyway" |

LRU/LFU are **approximated**: Redis samples a few keys (`maxmemory-samples`, default 5) and evicts
the best candidate among them, which is cheap and close enough.

:::warn title="volatile-* with no TTLs = noeviction"
If you choose `volatile-lru` but most keys have no TTL, Redis has almost nothing it is allowed to
evict and starts rejecting writes just like `noeviction`. Newer Redis 8 releases also accept
`allkeys-lrm` / `volatile-lrm` (least recently *modified*), and the list may keep growing; check
`CONFIG GET maxmemory-policy` and the
[eviction docs](https://redis.io/docs/latest/develop/reference/eviction/) for the exact list your
version supports.
:::

:::pro title="One Redis per purpose"
Seniors avoid mixing a cache (wants `allkeys-lru`, no persistence) with a job queue or locks (want
`noeviction` and AOF) in the same instance — the right settings contradict each other, and an
eviction storm in the cache would silently delete jobs. Two small instances (or databases in a
managed tier that supports different policies) are cheaper than that incident. Also watch
`evicted_keys` and `used_memory` in `INFO`: a cache that evicts constantly is too small.
:::

:::quiz id=cl-01-q5 xp=10
A Redis instance is used **only** as a cache for rendered API responses, and you write some
entries without a TTL. Memory is full. Which policy keeps it healthy?

- [x] `allkeys-lru`
- [ ] `volatile-lru`
- [ ] `noeviction`
- [ ] `volatile-ttl`
> For a pure cache every key is disposable, so the server should evict from *all* keys, least
> recently used first. `volatile-lru` sounds similar and is the tempting pick, but it only considers
> keys with a TTL — the entries without one can never be evicted, so memory fills and writes start
> failing. `noeviction` rejects writes outright, and `volatile-ttl` has the same TTL-only limitation.
:::

:::quiz id=cl-01-q6 xp=10
Production latency spikes to seconds every few minutes. `SLOWLOG GET 10` shows the same entry
again and again. Which command is the most likely culprit?

- [ ] `GET dq:session:abc`
- [ ] `INCR dq:article:7:views`
- [x] `KEYS dq:cache:*` from an admin dashboard
- [ ] `EXPIRE dq:session:abc 1800`
> `KEYS` walks the entire keyspace in one O(N) command, and because commands run one at a time on
> the main thread, every other client waits until it finishes. The other three are O(1). Replace
> it with `SCAN … MATCH … COUNT`, which does the same work in small, interleaved steps.
:::

:::quiz id=cl-01-q7 xp=15
Select **all** statements that are true about Redis.

- [x] A single command such as `INCR` or `ZADD` is atomic
- [ ] `SET key value` keeps a TTL that was set earlier
- [x] With `maxmemory` unset in a container, Redis can grow until the container is OOM-killed
- [x] Redis contents should be reconstructible from the primary database (or acceptable to lose)
- [ ] I/O threads let Redis execute several commands in parallel
> Commands run one at a time, so each is atomic. A plain `SET` *discards* the TTL. `maxmemory 0`
> means no limit, so the kernel/cgroup limit is what stops it — badly. Redis is a fast, temporary
> layer next to Postgres, not instead of it. I/O threads only handle socket reading/writing and
> protocol parsing; command execution stays on the main thread.
:::

## redis-cli basics

`redis-cli` is the REPL you will use in every incident. The most useful commands:

| Command | What it tells you |
|---|---|
| `PING` | `PONG` = alive |
| `INFO server` / `INFO memory` / `INFO stats` / `INFO keyspace` | version, `used_memory_human`, `evicted_keys`, key counts |
| `DBSIZE` | number of keys in the current database |
| `TYPE key`, `OBJECT ENCODING key`, `MEMORY USAGE key` | what a key is and what it costs |
| `SCAN 0 MATCH dq:* COUNT 100` | iterate keys safely |
| `SLOWLOG GET 10` | the slowest recent commands |
| `MONITOR` | stream **every** command live — debugging only, it is expensive |
| `CONFIG GET maxmemory*` | current memory settings |
| `redis-cli --latency` / `--bigkeys` / `--memkeys` | latency sampling, find the largest keys |

:::warn title="Never expose 6379"
Thousands of Redis servers reachable from the internet without a password have been taken over
(attackers abuse `CONFIG SET` to write files, or just wipe and ransom the data), and Redis has had
serious vulnerabilities in its Lua scripting engine. Bind to localhost or a private network, set a
password / ACL users (`requirepass`, `ACL SETUSER`), enable TLS on managed services, and keep the
image patched. In Docker publish it as `-p 127.0.0.1:6379:6379`, not `-p 6379:6379`.
:::

## Practice: build the semantics yourself

Implementing a tiny Redis is the fastest way to make the TTL and `INCR` rules stick. The store
uses an **injected clock** so the tests can move time forward without waiting.

:::challenge id=cl-01-c1 lang=ts xp=50
title: A tiny Redis with TTLs
Write `createStore(clock)` returning `{ set, get, incr, expire, ttl }` with Redis semantics.
Time comes **only** from `clock.now()` (milliseconds) — the `fakeClock()` helper is provided.

* `set(key, value, opts?)` stores a string and returns `'OK'`. `opts.ex` = TTL in **seconds**.
  Without `ex`, any previous TTL is **removed** (just like Redis).
* `get(key)` returns the value or `null`. A key whose deadline is reached (`now >= expiresAt`) is
  treated as missing — and should be deleted (lazy expiry).
* `incr(key)` adds 1 and returns the new number. A missing (or expired) key counts as `0`. If the
  current value is not an integer string (optional `-`, then digits only — so `'1.5'` and `'ada'`
  fail), throw `new Error('ERR value is not an integer or out of range')`.
  `incr` **keeps** an existing TTL; a key that `incr` creates from nothing has **no** TTL (`ttl` → `-1`).
  Store the result as a string (`get` returns `'2'`).
* `expire(key, seconds)` returns `0` if the key is missing, otherwise sets the deadline to
  `now + seconds` (replacing any old one) and returns `1`. `seconds <= 0` deletes the key (and returns `1`).
* `ttl(key)` returns `-2` if missing, `-1` if it has no TTL, else the remaining seconds rounded to
  the nearest whole second (`Math.round`).

hint: Store `{ value, expiresAt }` where `expiresAt` is `null` or an absolute `clock.now() + seconds * 1000`.
hint: Write one helper `live(key)` that returns the entry or deletes it when expired — and use it in *every* method.
hint: An integer string matches `/^-?\d+$/`.

```ts setup
export interface Clock { now(): number }
export function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
```

```ts starter
export function createStore(clock: Clock) {
  const data = new Map<string, string>()
  return {
    set(key: string, value: string, opts?: { ex?: number }): 'OK' {
      data.set(key, value)
      return 'OK'
    },
    get(key: string): string | null {
      return data.get(key) ?? null
    },
    incr(key: string): number {
      // TODO: missing = 0, keep TTL, reject non-integers
      return 0
    },
    expire(key: string, seconds: number): 0 | 1 {
      // TODO
      return 0
    },
    ttl(key: string): number {
      // TODO: -2 missing, -1 no TTL, else seconds left
      return -1
    },
  }
}
```

```ts solution
export function createStore(clock: Clock) {
  const data = new Map<string, { value: string; expiresAt: number | null }>()

  function live(key: string) {
    const e = data.get(key)
    if (!e) return undefined
    if (e.expiresAt !== null && clock.now() >= e.expiresAt) {
      data.delete(key) // lazy (passive) expiry, like Redis
      return undefined
    }
    return e
  }

  return {
    set(key: string, value: string, opts?: { ex?: number }): 'OK' {
      const expiresAt = opts?.ex !== undefined ? clock.now() + opts.ex * 1000 : null
      data.set(key, { value, expiresAt })
      return 'OK'
    },
    get(key: string): string | null {
      return live(key)?.value ?? null
    },
    incr(key: string): number {
      const e = live(key)
      const current = e ? e.value : '0'
      if (!/^-?\d+$/.test(current)) throw new Error('ERR value is not an integer or out of range')
      const next = Number(current) + 1
      data.set(key, { value: String(next), expiresAt: e ? e.expiresAt : null })
      return next
    },
    expire(key: string, seconds: number): 0 | 1 {
      const e = live(key)
      if (!e) return 0
      if (seconds <= 0) {
        data.delete(key)
        return 1
      }
      e.expiresAt = clock.now() + seconds * 1000
      return 1
    },
    ttl(key: string): number {
      const e = live(key)
      if (!e) return -2
      if (e.expiresAt === null) return -1
      return Math.round((e.expiresAt - clock.now()) / 1000)
    },
  }
}
```

```ts tests
test('set / get / missing', () => {
  const s = createStore(fakeClock())
  expect(s.set('a', '1')).toBe('OK')
  expect(s.get('a')).toBe('1')
  expect(s.get('nope')).toBeNull()
})
test('EX expires exactly at the deadline', () => {
  const c = fakeClock(1000)
  const s = createStore(c)
  s.set('session', 'ada', { ex: 10 })
  c.advance(9999)
  expect(s.get('session')).toBe('ada')
  c.advance(1)
  expect(s.get('session')).toBeNull()
})
test('ttl: -2 missing, -1 no expiry, seconds left', () => {
  const c = fakeClock()
  const s = createStore(c)
  expect(s.ttl('nope')).toBe(-2)
  s.set('forever', 'x')
  expect(s.ttl('forever')).toBe(-1)
  s.set('temp', 'x', { ex: 10 })
  expect(s.ttl('temp')).toBe(10)
  c.advance(2300)
  expect(s.ttl('temp')).toBe(8)
  c.advance(7700)
  expect(s.ttl('temp')).toBe(-2)
})
test('plain set removes an existing TTL', () => {
  const c = fakeClock()
  const s = createStore(c)
  s.set('k', 'v1', { ex: 5 })
  s.set('k', 'v2')
  expect(s.ttl('k')).toBe(-1)
  c.advance(60_000)
  expect(s.get('k')).toBe('v2')
})
test('incr starts at 0 and stores a string', () => {
  const s = createStore(fakeClock())
  expect(s.incr('views')).toBe(1)
  expect(s.incr('views')).toBe(2)
  expect(s.get('views')).toBe('2')
  s.set('neg', '-5')
  expect(s.incr('neg')).toBe(-4)
})
test('incr rejects non-integers', () => {
  const s = createStore(fakeClock())
  s.set('name', 'ada')
  expect(() => s.incr('name')).toThrow('ERR value is not an integer or out of range')
  s.set('price', '1.5')
  expect(() => s.incr('price')).toThrow('not an integer')
})
test('incr keeps the TTL; after expiry it starts over', () => {
  const c = fakeClock()
  const s = createStore(c)
  s.incr('rl')
  expect(s.expire('rl', 60)).toBe(1)
  c.advance(30_000)
  expect(s.incr('rl')).toBe(2)
  expect(s.ttl('rl')).toBe(30)
  c.advance(30_000)
  expect(s.get('rl')).toBeNull()
  expect(s.incr('rl')).toBe(1)
  expect(s.ttl('rl')).toBe(-1)
})
test('expire: missing key, reset deadline, zero deletes', () => {
  const c = fakeClock()
  const s = createStore(c)
  expect(s.expire('nope', 10)).toBe(0)
  s.set('k', 'v', { ex: 5 })
  c.advance(4000)
  expect(s.expire('k', 10)).toBe(1)
  c.advance(9000)
  expect(s.get('k')).toBe('v')
  expect(s.expire('k', 0)).toBe(1)
  expect(s.get('k')).toBeNull()
  expect(s.ttl('k')).toBe(-2)
})
test('a fixed-window rate limiter works on top of it', () => {
  const c = fakeClock()
  const s = createStore(c)
  const hit = () => {
    const n = s.incr('rl:ip:1')
    if (n === 1) s.expire('rl:ip:1', 60)
    return n <= 3
  }
  expect([hit(), hit(), hit(), hit()]).toEqual([true, true, true, false])
  c.advance(60_000)
  expect(hit()).toBe(true)
})
```
:::

:::challenge id=cl-01-c2 lang=ts xp=50
title: A sorted-set leaderboard
Write `createLeaderboard()` that mimics the sorted-set commands of a single key:

* `zadd(member, score)` sets the score; returns `1` if the member is new, `0` if it was updated.
* `zincrby(member, delta)` adds `delta` (a missing member starts at `0`) and returns the new score.
* `zscore(member)` returns the score or `null`.
* `zrevrange(start, stop)` returns `{ member, score }[]` ordered **highest score first**, from
  rank `start` to `stop` **inclusive**. Negative indexes count from the end (`-1` = last). Indexes
  out of range are clamped; if `start > stop` after that, return `[]`.
  **Ties:** like Redis' `ZREVRANGE`, members with equal scores are in **descending** lexicographic order.
* `zrevrank(member)` returns the 0-based rank (highest score = 0) or `null` if missing.

hint: Keep a `Map<string, number>` and sort a copy when you read: `b.score - a.score`, then compare members.
hint: Compare members with `<` / `>` (byte-like order), not `localeCompare` — Redis doesn't know about locales.
hint: Convert negatives first: `const s = start < 0 ? n + start : start`, then clamp to `[0, n - 1]`.

```ts starter
export function createLeaderboard() {
  const scores = new Map<string, number>()
  return {
    zadd(member: string, score: number): 0 | 1 {
      scores.set(member, score)
      return 1
    },
    zincrby(member: string, delta: number): number {
      return 0
    },
    zscore(member: string): number | null {
      return scores.get(member) ?? null
    },
    zrevrange(start: number, stop: number): { member: string; score: number }[] {
      return []
    },
    zrevrank(member: string): number | null {
      return null
    },
  }
}
```

```ts solution
export function createLeaderboard() {
  const scores = new Map<string, number>()

  function sortedDesc() {
    return [...scores]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => b.score - a.score || (a.member < b.member ? 1 : a.member > b.member ? -1 : 0))
  }

  return {
    zadd(member: string, score: number): 0 | 1 {
      const isNew = !scores.has(member)
      scores.set(member, score)
      return isNew ? 1 : 0
    },
    zincrby(member: string, delta: number): number {
      const next = (scores.get(member) ?? 0) + delta
      scores.set(member, next)
      return next
    },
    zscore(member: string): number | null {
      return scores.get(member) ?? null
    },
    zrevrange(start: number, stop: number): { member: string; score: number }[] {
      const all = sortedDesc()
      const n = all.length
      let s = start < 0 ? n + start : start
      let e = stop < 0 ? n + stop : stop
      if (s < 0) s = 0
      if (e >= n) e = n - 1
      if (s > e) return []
      return all.slice(s, e + 1)
    },
    zrevrank(member: string): number | null {
      if (!scores.has(member)) return null
      return sortedDesc().findIndex((x) => x.member === member)
    },
  }
}
```

```ts tests
function seeded() {
  const lb = createLeaderboard()
  lb.zadd('ada', 1200)
  lb.zadd('linus', 950)
  lb.zadd('grace', 1800)
  lb.zadd('ken', 400)
  return lb
}
test('zadd returns 1 for new, 0 for update', () => {
  const lb = createLeaderboard()
  expect(lb.zadd('ada', 10)).toBe(1)
  expect(lb.zadd('ada', 20)).toBe(0)
  expect(lb.zscore('ada')).toBe(20)
  expect(lb.zscore('nobody')).toBeNull()
})
test('top 3, highest first', () => {
  expect(seeded().zrevrange(0, 2)).toEqual([
    { member: 'grace', score: 1800 },
    { member: 'ada', score: 1200 },
    { member: 'linus', score: 950 },
  ])
})
test('negative indexes', () => {
  const lb = seeded()
  expect(lb.zrevrange(0, -1).map((x) => x.member)).toEqual(['grace', 'ada', 'linus', 'ken'])
  expect(lb.zrevrange(-2, -1).map((x) => x.member)).toEqual(['linus', 'ken'])
})
test('out of range is clamped or empty', () => {
  const lb = seeded()
  expect(lb.zrevrange(0, 100)).toHaveLength(4)
  expect(lb.zrevrange(-100, 0).map((x) => x.member)).toEqual(['grace'])
  expect(lb.zrevrange(5, 10)).toEqual([])
  expect(lb.zrevrange(2, 1)).toEqual([])
  expect(createLeaderboard().zrevrange(0, -1)).toEqual([])
})
test('ties use descending member order', () => {
  const lb = createLeaderboard()
  lb.zadd('alice', 100)
  lb.zadd('carol', 50)
  lb.zadd('bob', 100)
  expect(lb.zrevrange(0, -1).map((x) => x.member)).toEqual(['bob', 'alice', 'carol'])
})
test('zincrby updates the order', () => {
  const lb = seeded()
  expect(lb.zincrby('ada', 700)).toBe(1900)
  expect(lb.zincrby('newbie', 5)).toBe(5)
  expect(lb.zrevrange(0, 0)).toEqual([{ member: 'ada', score: 1900 }])
  expect(lb.zrevrank('newbie')).toBe(4)
})
test('zrevrank', () => {
  const lb = seeded()
  expect(lb.zrevrank('grace')).toBe(0)
  expect(lb.zrevrank('ken')).toBe(3)
  expect(lb.zrevrank('nobody')).toBeNull()
})
```
:::

## Lab: Redis 8 in Docker

:::lab id=cl-01-lab1 xp=80
title: Redis 8 in Docker — a redis-cli tour, persistence and eviction
You need Docker (see the Containers & Kubernetes region). Optional last step needs the .NET 10 SDK.
Exact numbers (memory, IDs, timings) will differ on your machine — the *shape* of the output is what matters.

**1. Start Redis 8** (published on localhost only):

```bash
docker run -d --name redis -p 127.0.0.1:6379:6379 redis:8
docker exec -it redis redis-cli
```

```text
127.0.0.1:6379> PING
PONG
127.0.0.1:6379> INFO server
# Server
redis_version:8.x.x
...
```

**2. Strings, counters and TTLs**

```text
127.0.0.1:6379> SET dq:greeting "hello"
OK
127.0.0.1:6379> INCR dq:article:7:views
(integer) 1
127.0.0.1:6379> INCR dq:greeting
(error) ERR value is not an integer or out of range
127.0.0.1:6379> SET dq:session:abc '{"userId":42}' EX 60
OK
127.0.0.1:6379> TTL dq:session:abc
(integer) 60
127.0.0.1:6379> SET dq:session:abc '{"userId":42,"v":2}'
OK
127.0.0.1:6379> TTL dq:session:abc
(integer) -1
127.0.0.1:6379> SET dq:short x EX 5
OK
```

Wait five seconds, then:

```text
127.0.0.1:6379> GET dq:short
(nil)
127.0.0.1:6379> TTL dq:short
(integer) -2
```

**3. Hashes, sets, sorted sets, streams**

```text
127.0.0.1:6379> HSET dq:user:42 name Ada plan pro
(integer) 2
127.0.0.1:6379> HGETALL dq:user:42
1) "name"
2) "Ada"
3) "plan"
4) "pro"
127.0.0.1:6379> OBJECT ENCODING dq:user:42
"listpack"
127.0.0.1:6379> SADD dq:online u1 u2 u1
(integer) 2
127.0.0.1:6379> ZADD dq:lb:weekly 1200 ada 950 linus 1800 grace
(integer) 3
127.0.0.1:6379> ZINCRBY dq:lb:weekly 700 ada
"1900"
127.0.0.1:6379> ZRANGE dq:lb:weekly 0 -1 REV WITHSCORES
1) "ada"
2) "1900"
3) "grace"
4) "1800"
5) "linus"
6) "950"
127.0.0.1:6379> ZREVRANK dq:lb:weekly linus
(integer) 2
127.0.0.1:6379> XADD dq:events * type signup user 42
"1793895720000-0"
127.0.0.1:6379> SCAN 0 MATCH dq:* COUNT 100
1) "0"
2) 1) "dq:user:42"
   2) "dq:lb:weekly"
   ...
```

(`SCAN` returns keys in no particular order; cursor `"0"` means the iteration is complete.)
Type `exit` to leave `redis-cli`.

**4. Eviction — watch Redis protect itself.** Fill it with ~30 000 keys of 200 bytes using the
bundled benchmark tool, then shrink the memory limit:

```bash
docker exec redis redis-benchmark -q -t set -n 50000 -r 50000 -d 200
docker exec -it redis redis-cli
```

```text
127.0.0.1:6379> DBSIZE
(integer) 31xxx
127.0.0.1:6379> INFO memory
used_memory_human:9.xxM
...
127.0.0.1:6379> CONFIG SET maxmemory 5mb
OK
127.0.0.1:6379> CONFIG GET maxmemory-policy
1) "maxmemory-policy"
2) "noeviction"
127.0.0.1:6379> SET one-more x
(error) OOM command not allowed when used memory > 'maxmemory'.
127.0.0.1:6379> CONFIG SET maxmemory-policy allkeys-lru
OK
127.0.0.1:6379> SET one-more x
OK
127.0.0.1:6379> DBSIZE
(integer) 12xxx
127.0.0.1:6379> INFO stats
...
evicted_keys:18xxx
...
```

(`-n 50000 -r 50000` sends 50 000 `SET`s to key names picked at random from 50 000 possibilities,
so many names repeat and `DBSIZE` lands around 31 600, about 63%, not 50 000.) With `noeviction` your
API would now be throwing on every write; with `allkeys-lru` Redis silently dropped well over half
the keys to get back under 5 MB — perfect for a cache, a disaster for a job queue.

:::warn title="Containers vs this exact output"
If `CONFIG SET maxmemory 5mb` does not immediately make `SET` fail, your instance may have been
under 5 MB already — run the benchmark again with a larger `-n` or `-d`. If the `redis:8` image
on your machine is configured differently from upstream defaults, check `CONFIG GET maxmemory*` first.
:::

**5. Persistence with Compose.** Remove the throwaway container (it had no named volume, so its
data is gone for good) and save this as `compose.yaml`:

```bash
docker rm -f redis
```

```yaml
services:
  redis:
    image: redis:8
    command:
      - redis-server
      - --appendonly
      - "yes"
      - --appendfsync
      - everysec
      - --maxmemory
      - 256mb
      - --maxmemory-policy
      - noeviction
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  redis-data:
```

```bash
docker compose up -d
docker compose exec redis redis-cli SET dq:durable "still here"
docker compose exec redis redis-cli CONFIG GET appendonly
docker compose restart redis
docker compose exec redis redis-cli GET dq:durable
docker compose exec redis ls /data/appendonlydir
```

Expected:

```text
OK
1) "appendonly"
2) "yes"
 ✔ Container ...-redis-1  Started
"still here"
appendonly.aof.1.base.rdb  appendonly.aof.1.incr.aof  appendonly.aof.manifest
```

Now `docker compose down` (keeps the volume) and `docker compose up -d` again — the key survives.
`docker compose down -v` deletes the volume, and with it the data.

**6. (Optional) The lost update, for real.** With Redis from step 5 running:

```bash
dotnet new console -n RedisRace
cd RedisRace
dotnet add package StackExchange.Redis
```

Replace `Program.cs`:

```csharp
using StackExchange.Redis;

var mux = await ConnectionMultiplexer.ConnectAsync("localhost:6379");
var db = mux.GetDatabase();
await db.KeyDeleteAsync(new RedisKey[] { "lab:naive", "lab:atomic" });

// 1000 concurrent "read, add one, write back" — two commands with a gap in between
await Task.WhenAll(Enumerable.Range(0, 1000).Select(async _ =>
{
    long current = (long?)await db.StringGetAsync("lab:naive") ?? 0;
    await db.StringSetAsync("lab:naive", current + 1);
}));

// 1000 concurrent INCRs — one atomic command each
await Task.WhenAll(Enumerable.Range(0, 1000).Select(_ => db.StringIncrementAsync("lab:atomic")));

Console.WriteLine($"naive : {await db.StringGetAsync("lab:naive")}");
Console.WriteLine($"atomic: {await db.StringGetAsync("lab:atomic")}");
```

```bash
dotnet run
```

```text
naive : 37
atomic: 1000
```

The naive number varies from run to run but is (almost) always far below 1000; the atomic one is
always exactly 1000.

- [ ] `PING` returns `PONG` and `INFO server` shows `redis_version:8.`
- [ ] I saw `TTL` return a positive number, `-1` after a plain `SET`, and `-2` after expiry
- [ ] `ZRANGE … REV WITHSCORES` showed my leaderboard highest-first
- [ ] I triggered `OOM command not allowed` with `noeviction` and saw `evicted_keys` grow with `allkeys-lru`
- [ ] A key survived `docker compose restart` thanks to AOF on a named volume, and I saw the `appendonlydir` files
- [ ] (Optional) The .NET race printed `atomic: 1000` and a smaller naive number
:::

:::cards id=cl-01-cards1 xp=15 title="Redis fundamentals"
Q: What is Redis in one sentence?
A: An in-memory data structure server: a shared, networked map of keys to typed values (strings, hashes, lists, sets, sorted sets, streams) with µs-level operations.
Q: Why is a single Redis command atomic?
A: Commands execute one at a time on a single main thread, so nothing can interleave with an INCR or ZADD.
Q: What is the cost of that single thread?
A: One slow O(N) command (KEYS *, huge SMEMBERS, heavy Lua) blocks every other client. Use SCAN.
Q: TTL returns -1 / -2?
A: -1 = key exists without expiry. -2 = key does not exist (or has expired).
Q: Does SET keep an existing TTL?
A: No — a plain SET discards it. Pass EX/PX again, or KEEPTTL.
Q: RDB vs AOF?
A: RDB = periodic forked snapshot (lose minutes, fast restart). AOF = log of writes (everysec: lose ~1 s). Can combine.
Q: Default maxmemory and policy?
A: maxmemory 0 (unlimited on 64-bit) and noeviction — always set both explicitly in containers.
Q: Best eviction policy for a pure cache?
A: allkeys-lru (or allkeys-lfu). volatile-* only evicts keys that have a TTL.
Q: Key naming convention?
A: Colon-separated, general → specific: app:entity:id[:purpose], e.g. dq:user:42:sessions. Add a version segment for cached shapes.
Q: StackExchange.Redis connection rule?
A: One ConnectionMultiplexer per process (singleton); GetDatabase() is cheap and can be called per use.
Q: Why isn't Redis your primary database?
A: Data must fit in RAM, durability and replication are weaker, eviction may delete data, and there are no relations, constraints or ad-hoc queries.
Q: Safe way to expose Redis from Docker locally?
A: -p 127.0.0.1:6379:6379 plus a password/ACLs; never publish 6379 to the internet.
:::

## Recap

- Redis is an **in-memory data structure server** shared by all your pods: µs operations on
  strings, hashes, lists, sets, sorted sets and streams.
- Commands run **one at a time** on a single thread: every command is atomic (`INCR` beats
  `GET`+`SET`), and one slow command (`KEYS *`) blocks everyone — use `SCAN`.
- Name keys `app:entity:id[:purpose]`; put a **TTL on everything** temporary; remember a plain
  `SET` drops the TTL and `TTL` returns `-1` (no expiry) / `-2` (missing).
- Persistence is optional: **RDB** snapshots (lose minutes) and **AOF** (`everysec`, lose ~1 s).
  Still, Redis holds data you can rebuild or afford to lose — **Postgres is the source of truth**.
- Set `maxmemory` (below the container limit) and a deliberate **eviction policy**: `allkeys-lru`
  for caches, `noeviction` for queues and locks — ideally on separate instances.
- `docker run -p 127.0.0.1:6379:6379 redis:8` + `redis-cli` (`PING`, `INFO`, `SCAN`, `SLOWLOG`,
  `TTL`, `OBJECT ENCODING`) is your everyday toolbox; next up: **Caching with Redis in .NET**.
- At work, Redis is often a managed service (Azure Managed Redis, Amazon ElastiCache / MemoryDB).
  The commands are the same; the differences in auth, networking and failover are covered in
  **The Managed Equivalents: Azure & AWS**.
