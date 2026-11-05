---
id: cl-02
title: Caching with Redis in .NET
level: intermediate
minutes: 180
xp: 100
summary: Cache the right things the right way — cache-aside and friends, TTLs with jitter, invalidation that actually works, stampede protection, and IMemoryCache vs IDistributedCache vs HybridCache (L1 + Redis L2, tags) plus Redis-backed output caching in ASP.NET Core 10.
---

Your API is slow, the database is at 80 % CPU, and someone in standup says *"just put Redis in
front of it"*. That sentence has caused as many outages as it has fixed. A cache is the cheapest
performance win you will ever ship **and** the easiest way to serve wrong data to thousands of
users at once.

This lesson is about doing it on purpose: *what* to cache, *which pattern* to use, *how long* to keep
it, *how to throw it away*, and how to stop a cache from turning one slow query into a thousand.
Then we map all of it onto the three caching APIs in .NET 10 and run a two-instance API against Redis 8.

You should know the Redis basics from **Redis Fundamentals**: strings, `EX`/TTL, `INCR`.

## Why cache at all?

Because reading a copy that is already close to you is orders of magnitude cheaper than
recomputing it. Rough orders of magnitude (your numbers will differ, the *ratios* won't):

| Where the data comes from | Typical latency | Notes |
|---|---|---|
| In-process memory (`IMemoryCache`) | ~0.0001 ms (100 ns) | No network, no serialization |
| Redis in the same data centre | ~0.2 – 1 ms | One network round-trip + deserialize |
| Simple indexed PostgreSQL query | ~1 – 5 ms | Plus connection-pool wait under load |
| Heavy query / aggregation | 50 ms – seconds | Burns DB CPU that every other request needs |
| Third-party HTTP API | 100 ms – seconds | Also rate limits and costs money |

The latency win is nice, but the real reason teams cache is **protecting the thing that is hardest
to scale**. You can add ten API pods in a minute; you can't add ten primary databases. A 95 % hit
ratio means the database sees one request in twenty.

### The mental model: a cache is a copy with an expiry date

```text
                    ┌──────────── source of truth (PostgreSQL) ─────────────┐
 write ───────────► │  price = 20                                           │
                    └───────────────────────────────────────────────────────┘
                                     ▲ copy made at 09:00
                    ┌──────────── cache (Redis) ───────┴────────────────────┐
 read  ◄─────────── │  price = 20   (expires 09:10)                         │
                    └───────────────────────────────────────────────────────┘
```

The moment you copy data you have **two versions of the truth**. Every caching decision is
really one question: *how stale may this copy be, and what happens when it is?* If you can't
answer that for a piece of data, you're not ready to cache it.

### What to cache — and what not to

| Good candidates | Bad candidates |
|---|---|
| Read-heavy, rarely-changing data (catalog, settings, feature flags) | Data used to **make decisions** that must be exact: balances, stock reservations, permissions after revocation |
| Expensive aggregates (dashboards, counts, "top 10") | Data that changes on nearly every read (hit ratio ≈ 0, pure overhead) |
| Third-party API responses (exchange rates, geocoding) | Huge blobs (videos, big files — that's object storage, the next lesson) |
| Rendered fragments / whole public responses | Per-user data in a **shared** cache key without the user in the key |
| "Not found" results (negative caching, short TTL) | Anything you'd be fined for showing to the wrong person |

:::warn title="Cache reads, not decisions"
It's fine to *display* a cached balance ("about €1 240"). It's not fine to *authorize a withdrawal*
from it. Decisions read the source of truth, inside a transaction (see the transactions lessons in
the Database region). The cache is for showing, not for deciding.
:::

:::quiz id=cl-02-q1 xp=10
Which of these are **bad** candidates for a shared Redis cache with a 5-minute TTL? (select all that apply)
- [ ] The product catalog shown on the shop's home page
- [x] A customer's remaining credit, checked before approving a purchase
- [x] "Can user 42 delete project 7?" — right after user 42 was removed from the team
- [ ] Today's EUR→USD exchange rate, used for display prices
- [ ] The rendered HTML of a public blog post
> Credit checks and permission checks are **decisions**: a 5-minute-old "yes" means overspending
> or a fired employee deleting data for five more minutes. They must hit the source of truth, or
> be invalidated synchronously on change. The catalog, display exchange rates and public HTML are
> the textbook case: read often, changed rarely, and briefly stale is harmless. The tempting wrong
> pick is the exchange rate — "money!" — but it's only *displayed*; the actual charge is computed
> at checkout from fresh data.
:::

## Caching patterns

There are four classic patterns (plus *refresh-ahead*, a variation that appears in the table).
They differ in **who** talks to the database and **when** the cache gets written.

```text
 CACHE-ASIDE (lazy loading) — the app does everything            ← 90 % of real code
   app ──GET key──► cache ──miss──► app ──SELECT──► DB
   app ──SET key (TTL)──► cache              app ──return──► caller

 READ-THROUGH — the cache library loads on a miss
   app ──GetOrCreate(key, loader)──► cache ──miss──► loader ──► DB
   (HybridCache.GetOrCreateAsync is read-through from your code's point of view)

 WRITE-THROUGH — every write goes to cache AND DB synchronously
   app ──write──► DB  and  cache.Set(new value)         (cache always warm, writes slower)

 WRITE-BEHIND (write-back) — write to cache now, flush to DB later
   app ──write──► cache ──(async, batched)──► DB         (fast writes, can LOSE data)
```

| Pattern | Reads | Writes | Risk | Use when |
|---|---|---|---|---|
| Cache-aside | First read is a miss, then fast | Write DB, **delete** key | Stale-set races (below) | Default for almost everything |
| Read-through | Same as cache-aside, less code | Same | Same | You have a library that does it (HybridCache) |
| Write-through | Always warm | Slower (two writes) | Caches data nobody reads; dual-write inconsistency | Small, hot, read-after-write data |
| Write-behind | Always warm | Very fast | **Data loss** if the cache dies before flushing | Counters, analytics, view counts — data you can lose |
| Refresh-ahead | Never cold for hot keys | — | Refreshes keys nobody needs any more | A handful of very hot keys (home page, config) |

:::info title="Write-behind is a queue in disguise"
If you write to Redis and a background worker flushes to Postgres, you've built a message queue
with weaker guarantees. When the data matters, use a real one — **Redis as Queue, Bus and Lock**
and **Message Brokers & the Outbox Pattern**, later in this region, cover how to do that safely.
:::

### Cache-aside in raw StackExchange.Redis

Before any abstractions, here is the pattern with nothing hidden. `IConnectionMultiplexer` is
registered **once** as a singleton — it's thread-safe and multiplexes all commands over a few
sockets. Creating one per request is a classic way to exhaust sockets and add 50 ms to every call.

```csharp
// Program.cs
builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    ConnectionMultiplexer.Connect("localhost:6379,abortConnect=false"));
```

```csharp
using System.Text.Json;
using StackExchange.Redis;

public sealed class ProductCache(IConnectionMultiplexer mux, ProductRepo repo)
{
    private readonly IDatabase _db = mux.GetDatabase();

    public async Task<Product> GetProductAsync(int id, CancellationToken ct)
    {
        var key = $"shop:v1:product:{id}";                       // app:schema-version:entity:id

        RedisValue cached = await _db.StringGetAsync(key);         // 1. try the cache
        if (cached.HasValue)
            return JsonSerializer.Deserialize<Product>(cached.ToString())!;

        var product = await repo.LoadAsync(id, ct);                // 2. miss → source of truth

        var ttl = TimeSpan.FromMinutes(10)                          // 3. store with TTL (+ jitter)
                + TimeSpan.FromSeconds(Random.Shared.Next(0, 60));
        await _db.StringSetAsync(key, JsonSerializer.Serialize(product), ttl);
        return product;
    }

    public Task InvalidateAsync(int id) => _db.KeyDeleteAsync($"shop:v1:product:{id}");
}
```

Three things in that code are worth stealing for every cache you write: a **namespaced key with a
schema version** (`shop:v1:…`), a **TTL on every key**, and **jitter** on that TTL. The next
sections explain why.

:::quiz id=cl-02-q2 xp=10
An API **updates a product's price**. The product is cached with cache-aside. What's the safest
default order of operations?
- [ ] Update the cache with the new price, then update the database
- [ ] Update the database, then `SET` the new price into the cache
- [x] Update the database, then `DELETE` the cache key
- [ ] `DELETE` the cache key, then update the database
> Commit to the source of truth first, then delete; the next reader re-loads the fresh value.
> The tempting option is "update DB, then SET the new value" — it looks more efficient, but two
> concurrent writers can finish in the wrong order (A writes 10, B writes 20, B sets 20, A sets 10)
> and the cache holds 10 while the DB holds 20 until the TTL runs out. Deleting *before* the DB
> write leaves a window where a reader re-caches the old value before your commit lands. And
> cache-first means the cache can show a price the DB never accepted if the DB write fails.
:::

## TTLs: how long, and why jitter

### Picking a TTL

Don't start from "what's a nice number". Start from the business: **how stale can this be before
someone notices or it costs money?**

| Data | Staleness tolerated | TTL | Plus |
|---|---|---|---|
| Feature flags / config | seconds–minutes | 30 – 60 s | Invalidate on change |
| Product catalog | minutes | 5 – 15 min | Delete-on-write |
| Exchange rates from a provider | provider refresh interval | = refresh interval | |
| User profile shown in header | minutes | 5 min | Delete on profile update |
| "Not found" (negative cache) | seconds | 30 – 60 s | Stops ID-enumeration from hammering the DB |
| Permissions | ~0 | don't, or very short + invalidate | |

The TTL is your **safety net**, not your invalidation strategy. Even with perfect delete-on-write,
bugs and races happen — the TTL is the upper bound on how long a mistake lives. **Every key gets a
TTL.** A key without one is a memory leak with a lottery ticket attached.

### Synchronized expiry and jitter

Imagine a deploy at 09:00 warms 200 000 product keys, all with `TTL = 1 h`. At exactly 10:00 they
**all expire in the same second**, and the database receives the whole warm-up load again — a
self-inflicted spike every hour, often mis-diagnosed as "something runs at the top of the hour".

**Jitter** spreads expiry out: instead of exactly `base`, use a random value in
`[base × (1 − r), base × (1 + r)]`.

```text
 without jitter          with ±10 % jitter (base 60 min)
 expiries                expiries
   │                       │
   │ █                     │      ▂▃▅▆▇█▇▆▅▃▂
   │ █                     │    ▁▂███████████▂▁
   └─┴───────── time       └──┴──────────────┴─── time
   10:00                   09:54           10:06
```

:::challenge id=cl-02-c1 lang=ts xp=40
title: Cache-aside with TTL (and a fake clock)
Build a tiny in-memory cache-aside cache. Time comes from an **injected clock** `now()` (ms) so
tests can move time without waiting — the same trick you'd use with `TimeProvider` in .NET.

1. `jitteredTtl(baseMs, ratio, random)` returns `Math.round(baseMs * (1 + ratio * (2 * random() - 1)))`
   — so `random() = 0` gives the minimum, `1` the maximum, `0.5` exactly `baseMs`.
2. `createCache(now)` returns `{ get, set, delete, getOrSet }`:
   * `set(key, value, ttlMs)` stores the value until `now() + ttlMs`. An entry is **expired when
     `now() >= expiresAt`**.
   * `get(key)` returns the value, or `undefined` if missing/expired.
   * `getOrSet(key, ttlMs, loader)` — on a hit return the cached value **without calling the
     loader**; on a miss `await loader()`, store the result, return it.
   * `null` is a legitimate value (negative caching): cache it like anything else.
   * If the loader **throws**, don't cache anything — the error propagates and the next call retries.

The `fakeClock()` helper is provided.

hint: Store `{ value, expiresAt }` in a `Map`. Check presence with the entry object, not with `if (value)` — `null` and `0` are falsy.
hint: Write one private `lookup(key)` that returns the entry or `undefined` (and deletes expired entries); use it in both `get` and `getOrSet`.
hint: If `await loader()` throws, the line that stores the entry never runs — that's exactly "errors are not cached".

```ts setup
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
```

```ts starter
export type Clock = () => number

export function jitteredTtl(baseMs: number, ratio: number, random: () => number = Math.random): number {
  return baseMs // TODO: add jitter
}

export function createCache<T>(now: Clock) {
  const entries = new Map<string, { value: T; expiresAt: number }>()
  return {
    get(key: string): T | undefined {
      return entries.get(key)?.value // TODO: respect expiry
    },
    set(key: string, value: T, ttlMs: number): void {
      entries.set(key, { value, expiresAt: Infinity }) // TODO: use the clock
    },
    delete(key: string): void {
      entries.delete(key)
    },
    async getOrSet(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
      return loader() // TODO: cache-aside
    },
  }
}
```

```ts solution
export type Clock = () => number

export function jitteredTtl(baseMs: number, ratio: number, random: () => number = Math.random): number {
  return Math.round(baseMs * (1 + ratio * (2 * random() - 1)))
}

export function createCache<T>(now: Clock) {
  const entries = new Map<string, { value: T; expiresAt: number }>()

  function lookup(key: string) {
    const e = entries.get(key)
    if (!e) return undefined
    if (now() >= e.expiresAt) {
      entries.delete(key)
      return undefined
    }
    return e
  }

  return {
    get(key: string): T | undefined {
      return lookup(key)?.value
    },
    set(key: string, value: T, ttlMs: number): void {
      entries.set(key, { value, expiresAt: now() + ttlMs })
    },
    delete(key: string): void {
      entries.delete(key)
    },
    async getOrSet(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
      const hit = lookup(key)
      if (hit) return hit.value
      const value = await loader()
      entries.set(key, { value, expiresAt: now() + ttlMs })
      return value
    },
  }
}
```

```ts tests
test('jitter: min, max and middle', () => {
  expect(jitteredTtl(60000, 0.1, () => 0)).toBe(54000)
  expect(jitteredTtl(60000, 0.1, () => 1)).toBe(66000)
  expect(jitteredTtl(60000, 0.1, () => 0.5)).toBe(60000)
})
test('miss calls the loader, hit does not', async () => {
  const c = fakeClock()
  const cache = createCache<string>(c.now)
  const loader = fn(async () => 'Ada')
  expect(await cache.getOrSet('user:1', 1000, loader)).toBe('Ada')
  expect(await cache.getOrSet('user:1', 1000, loader)).toBe('Ada')
  expect(loader).toHaveBeenCalledTimes(1)
  expect(cache.get('user:1')).toBe('Ada')
})
test('entry expires exactly at the TTL', async () => {
  const c = fakeClock(5000)
  const cache = createCache<number>(c.now)
  const loader = fn(async () => 42)
  await cache.getOrSet('k', 1000, loader)
  c.advance(999)
  expect(cache.get('k')).toBe(42)
  await cache.getOrSet('k', 1000, loader)
  expect(loader).toHaveBeenCalledTimes(1)
  c.advance(1)
  expect(cache.get('k')).toBeUndefined()
  await cache.getOrSet('k', 1000, loader)
  expect(loader).toHaveBeenCalledTimes(2)
})
test('set() uses the clock too', () => {
  const c = fakeClock()
  const cache = createCache<string>(c.now)
  cache.set('a', 'x', 100)
  c.advance(100)
  expect(cache.get('a')).toBeUndefined()
})
test('null is cached (negative caching)', async () => {
  const c = fakeClock()
  const cache = createCache<string | null>(c.now)
  const loader = fn(async () => null)
  expect(await cache.getOrSet('user:404', 1000, loader)).toBeNull()
  expect(await cache.getOrSet('user:404', 1000, loader)).toBeNull()
  expect(loader).toHaveBeenCalledTimes(1)
})
test('failed loads are not cached', async () => {
  const c = fakeClock()
  const cache = createCache<string>(c.now)
  let calls = 0
  const loader = async () => {
    calls++
    if (calls === 1) throw new Error('db down')
    return 'ok'
  }
  await expect(cache.getOrSet('k', 1000, loader)).rejects.toThrow('db down')
  await expect(cache.getOrSet('k', 1000, loader)).resolves.toBe('ok')
  await expect(cache.getOrSet('k', 1000, loader)).resolves.toBe('ok')
  expect(calls).toBe(2)
})
test('delete forces a reload', async () => {
  const c = fakeClock()
  const cache = createCache<string>(c.now)
  const loader = fn(async () => 'v')
  await cache.getOrSet('k', 1000, loader)
  cache.delete('k')
  await cache.getOrSet('k', 1000, loader)
  expect(loader).toHaveBeenCalledTimes(2)
})
```
:::

### When memory runs out: eviction

A quick refresher from **Redis Fundamentals**, because it decides how your cache behaves
when it is full. TTL removes keys that are *old*; **eviction** removes keys when Redis hits
`maxmemory`. The two are independent. Redis's default policy is `noeviction`: when full, **writes fail** with
`OOM command not allowed when used memory > 'maxmemory'`. That's right for a queue or a session
store (you don't want data silently dropped) and wrong for a pure cache.

| `maxmemory-policy` | Evicts | Fits |
|---|---|---|
| `noeviction` (default) | nothing — writes fail | Queues, locks, data you must not lose |
| `allkeys-lru` | least recently used key, any key | **Pure cache** (most common choice) |
| `allkeys-lfu` | least *frequently* used | Pure cache with a stable hot set |
| `volatile-lru` / `volatile-ttl` | only keys **with** a TTL | Mixed instance: cache keys have TTL, others don't |

:::pro title="One Redis per job"
Mature teams run **separate Redis instances** for cache vs queues/locks/sessions. A cache wants
`allkeys-lru` and can be flushed at any time; a queue wants `noeviction` and must never be
flushed. Numbered databases (`SELECT 1`) are *not* a substitute: `maxmemory` and
`maxmemory-policy` are **per instance**, so an `allkeys-lru` cache in db 0 will happily evict
your queue in db 1, `FLUSHALL` wipes every database, and Redis Cluster only supports db 0 anyway.
Mixing them means one `FLUSHALL` during an incident wipes your job queue too.
:::

:::quiz id=cl-02-q3 xp=10
Your Redis is used **only as a cache**. Under load it reaches `maxmemory` and writes start failing
with `OOM command not allowed`. What should you set?
- [ ] `maxmemory 0` — remove the limit so Redis never runs out
- [ ] `maxmemory-policy volatile-ttl`
- [x] `maxmemory-policy allkeys-lru` (or `allkeys-lfu`)
- [ ] Keep `noeviction` and add more RAM
> For a pure cache any key may be dropped, so `allkeys-lru`/`allkeys-lfu` lets Redis evict the
> coldest keys instead of failing writes. `volatile-ttl` is the tempting pick: it only evicts keys
> that *have* a TTL, so a single code path that forgets a TTL brings the OOM errors back.
> `maxmemory 0` just moves the failure to the OS (the container gets OOM-killed), and more RAM
> postpones the problem without changing the behaviour.
:::

## Invalidation: throwing the copy away

You have four tools. Real systems combine them.

### 1. TTL only

Simplest. Data is stale for at most the TTL. Perfect for third-party data and for anything where
"up to 5 minutes old" is acceptable. Zero code on the write path.

### 2. Delete-on-write

On every change, after the commit: `DEL key`. The next read repopulates. You saw in the quiz why
it's **delete**, not **set**. But cache-aside with delete still has one famous race:

```text
 time   reader R                              writer W
  t1    GET product:1        → miss
  t2    SELECT price         → 20 (old)
  t3                                          UPDATE price = 25; COMMIT
  t4                                          DEL product:1        (nothing to delete)
  t5    SET product:1 = 20   ← stale value written AFTER the delete
        → cache says 20 until the TTL expires
```

It needs a slow reader and a writer landing in a tiny window, so it's rare — but at scale "rare"
means "daily". Mitigations, in order of effort:

* **Short-enough TTL** — bounds the damage. Usually sufficient.
* **Delayed double delete** — delete, and delete again ~1 s later (via a background job or a
  message). Cheap and surprisingly effective.
* **Versioned values** — store `{ version, data }` and only `SET` if your version is newer (a Lua
  script or `WATCH`/`MULTI` in Redis).
* **Leases** — Facebook's memcache paper (*Scaling Memcache at Facebook*, NSDI 2013) hands a token
  to the first missing reader and rejects sets with stale tokens; it fixes this race *and* the
  stampede below.

### 3. Versioned keys (namespace generations)

Sometimes you need to invalidate **a whole group**: "all product keys", "everything for tenant 17"
after an import. Redis has no cheap "delete by prefix": `KEYS` blocks the server while it walks
every key, and `SCAN` + `DEL` doesn't block but walks the whole keyspace in many round-trips.
Instead, put a **generation number** in the key:

```text
 GET ver:products            → 3
 key = products:v3:42        → read/write normally

 bulk import finished:
 INCR ver:products           → 4       ← one atomic command
 key = products:v4:42        → every old key is now unreachable; TTL + LRU clean them up
```

Invalidating is **O(1)** no matter how many keys there are. The cost: one extra `GET` per lookup
(cache the version itself for a second or two in memory if that matters), and old entries linger
until they expire. The version must live in the **shared** store — if each pod keeps its own
counter, pods disagree about which generation is current.

Failure mode to know: the version key itself must **not** expire or be evicted. Give it no TTL,
and remember that under `allkeys-lru` even a TTL-less key can be evicted. If `ver:products`
disappears, `GET` returns nothing, the generation falls back to 0, and any still-living
`products:v0:*` entries come back from the dead. On a mixed instance, `volatile-lru` (only keys
*with* a TTL are evicted) protects it; on a dedicated cache instance, a fallback that treats a
missing version as "invalidate now" (e.g. re-seed it from a timestamp) is safer than 0.

### 4. Tags

A tag is a named group the library tracks for you: "this entry belongs to `products` and
`tenant:17`". `HybridCache.RemoveByTagAsync("products")` and output caching's
`EvictByTagAsync("catalog")` do this — you'll use both in the lab. Under the hood it's the same idea
as versioned keys: the library records "tag X invalidated at time T" and treats older entries as
misses.

:::pro title="Schema changes are invalidation too"
During a rolling deploy, old and new pods run side by side and **read each other's cache
entries**. If v2 renamed a property, v1 pods deserialize v2 JSON (or vice versa) and get nulls or
exceptions. Put a schema version in the key prefix (`shop:v2:product:42`) and bump it when the
cached shape changes — old and new pods then use separate keys until the old ones expire.
:::

:::quiz id=cl-02-q4 xp=10
After a nightly import that touches **all 2 million** cached product entries, you need every one of
them invalidated. Which approach scales best?
- [ ] `KEYS products:*` and delete the results
- [ ] `SCAN` through all keys and `DEL` each `products:*` key
- [x] Store a generation in `ver:products`, build keys as `products:v{gen}:{id}`, and `INCR` the generation
- [ ] `FLUSHALL` and let everything reload
> `INCR` is one atomic O(1) command, and every old key becomes unreachable at once; TTLs and LRU
> remove the leftovers. `SCAN` + `DEL` is the tempting "correct" answer — it doesn't block like
> `KEYS`, but it's millions of round-trips during which some readers see new data and some old.
> `KEYS` blocks the single-threaded Redis for seconds, and `FLUSHALL` throws away unrelated keys
> (and sends a cold-cache stampede to the DB).
:::

:::challenge id=cl-02-c2 lang=ts mode=tests xp=50
title: Test the versioned-key helper
Here's a helper for **namespace generations**. `store` stands in for Redis (a `Map`; `ver:<ns>`
holds the generation, missing = 0, exactly like `GET` on a missing key followed by `INCR`).
Several pods create their own `createKeyspace(store)` over the **same** store.

**Your job: write the tests.** They must pass against this implementation and catch every buggy
version we hide (a key that ignores the generation, a single generation shared by all namespaces,
a `SET 1` where an `INCR` belongs, and a pod that only remembers the bump in its own memory).

```ts impl
export function createKeyspace(store: Map<string, number>) {
  const verKey = (ns: string) => `ver:${ns}`
  const gen = (ns: string) => store.get(verKey(ns)) ?? 0
  return {
    key(ns: string, id: string | number): string {
      return `${ns}:v${gen(ns)}:${id}`
    },
    invalidate(ns: string): void {
      store.set(verKey(ns), gen(ns) + 1)
    },
  }
}
```

```ts mutant
export function createKeyspace(store: Map<string, number>) {
  const verKey = (ns: string) => `ver:${ns}`
  const gen = (ns: string) => store.get(verKey(ns)) ?? 0
  return {
    key(ns: string, id: string | number): string {
      return `${ns}:${id}`
    },
    invalidate(ns: string): void {
      store.set(verKey(ns), gen(ns) + 1)
    },
  }
}
```

```ts mutant
export function createKeyspace(store: Map<string, number>) {
  const verKey = (_ns: string) => 'ver'
  const gen = (ns: string) => store.get(verKey(ns)) ?? 0
  return {
    key(ns: string, id: string | number): string {
      return `${ns}:v${gen(ns)}:${id}`
    },
    invalidate(ns: string): void {
      store.set(verKey(ns), gen(ns) + 1)
    },
  }
}
```

```ts mutant
export function createKeyspace(store: Map<string, number>) {
  const verKey = (ns: string) => `ver:${ns}`
  const gen = (ns: string) => store.get(verKey(ns)) ?? 0
  return {
    key(ns: string, id: string | number): string {
      return `${ns}:v${gen(ns)}:${id}`
    },
    invalidate(ns: string): void {
      store.set(verKey(ns), 1)
    },
  }
}
```

```ts mutant
export function createKeyspace(store: Map<string, number>) {
  const local = new Map<string, number>()
  const gen = (ns: string) => local.get(ns) ?? store.get(`ver:${ns}`) ?? 0
  return {
    key(ns: string, id: string | number): string {
      return `${ns}:v${gen(ns)}:${id}`
    },
    invalidate(ns: string): void {
      local.set(ns, gen(ns) + 1)
    },
  }
}
```

hint: Start with the exact format: a fresh store gives `products:v0:42`.
hint: Invalidate twice — the key must change **both** times.
hint: Invalidate `products` and check that `users` keys did not move.
hint: Create two keyspaces over the same `Map` (pod A and pod B), invalidate on A, look at B.

```ts starter
test('fresh store starts at generation 0', () => {
  const ks = createKeyspace(new Map())
  expect(ks.key('products', 42)).toBe('products:v0:42')
})
```

```ts solution
test('fresh store starts at generation 0', () => {
  const ks = createKeyspace(new Map())
  expect(ks.key('products', 42)).toBe('products:v0:42')
})
test('invalidate moves every key of the namespace', () => {
  const ks = createKeyspace(new Map())
  ks.invalidate('products')
  expect(ks.key('products', 42)).toBe('products:v1:42')
})
test('every invalidation is a new generation', () => {
  const ks = createKeyspace(new Map())
  ks.invalidate('products')
  ks.invalidate('products')
  expect(ks.key('products', 42)).toBe('products:v2:42')
})
test('other namespaces are untouched', () => {
  const ks = createKeyspace(new Map())
  ks.invalidate('products')
  expect(ks.key('users', 7)).toBe('users:v0:7')
})
test('pods sharing a store agree', () => {
  const store = new Map<string, number>()
  const podA = createKeyspace(store)
  const podB = createKeyspace(store)
  podA.invalidate('products')
  expect(podB.key('products', 1)).toBe('products:v1:1')
  expect(podB.key('products', 1)).toBe(podA.key('products', 1))
})
```
:::

## Cache stampede (thundering herd)

A hot key — the home page catalog, read 2 000 times a second — expires. In the ~200 ms it takes
to rebuild it, **400 requests miss at once**, and every one of them runs the same expensive query.
The database slows down, so the rebuild takes longer, so even more requests miss… Caches are
supposed to *protect* the database; at the moment of expiry they do the opposite.

```text
            key expires
                 │
 requests ──────►│ miss miss miss miss miss miss miss …   400 identical SELECTs
                 │   │    │    │    │    │    │
                 ▼   ▼    ▼    ▼    ▼    ▼    ▼
               ┌──────────────────────────────┐
               │ PostgreSQL  CPU 100 %        │  → queries slow → more misses pile up
               └──────────────────────────────┘
```

:::info title="Real incident: Facebook, September 2010"
Facebook was down for roughly 2.5 hours after an automated system that "fixed" invalid
configuration values met one bad value in the persistent store. Every client saw the invalid
cached value, treated it as an error, and went to the database to fix it — hundreds of thousands
of queries per second at one cluster. The overload caused more errors, which caused more queries.
They had to stop all traffic to the cluster to break the loop. The fix ideas — coalescing,
backing off, not letting every client rebuild — are exactly the stampede defences below.
:::

### The defences

| Technique | Idea | Scope |
|---|---|---|
| **Single-flight / request coalescing** | Only the first miss runs the loader; concurrent misses for the same key await the same promise/task | Per process |
| **Distributed lock** | First miss takes `SET shop:lock:<key> <random token> NX PX 5000`; others wait/poll or serve stale | Cluster-wide (*Redis as Queue, Bus and Lock*) |
| **Stale-while-revalidate** | Keep serving the expired value while one caller refreshes in the background | Per process or cluster |
| **Probabilistic early refresh (XFetch)** | Each reader refreshes *a bit early* with rising probability as expiry nears, so one random request rebuilds it before it expires | Cluster-wide, lock-free |
| **Jitter** | Different keys don't expire together | Many keys |
| **Warm-up / refresh-ahead** | Rebuild hot keys on a schedule; they never expire under load | A few known keys |

XFetch (Vattani et al., *Optimal Probabilistic Cache Stampede Prevention*, VLDB 2015) is one line:

```text
 refresh early if:   now − Δ · β · ln(random())  ≥  expiry
   Δ = how long the last recompute took,  β ≥ 1 (1 is a good default),  random() ∈ (0, 1]
```

`ln(random())` is negative, so the left side is "now plus a random head start" — usually small,
occasionally large. Expensive keys (big Δ) start refreshing earlier.

Single-flight is the one you'll implement yourself, and the one `HybridCache` gives you for free.

:::challenge id=cl-02-c3 lang=ts xp=50
title: Single-flight — coalesce concurrent loads
Write `createSingleFlight<T>()` returning:

* `run(key, fn)` — if a call for `key` is already in flight, return **the same promise**
  without calling `fn`. Otherwise call `fn()` **right away** (synchronously, so the call count is
  visible immediately), remember the promise, and forget it once it settles.
* `inFlight()` — how many keys are currently loading.

Rules:

* Different keys load independently.
* It's **not a cache**: once a load settles, the next `run` for that key calls `fn` again.
* If the load fails, **every** waiter gets the error, and the key is forgotten so the next call retries.

A `deferred()` helper is provided — the tests use it to keep a load "in flight" while more calls
arrive.

hint: `const pending = new Map<string, Promise<T>>()` — check it first, and return what's there.
hint: `const p = fn().finally(() => pending.delete(key))` — `finally` runs on success *and* failure and passes the result/error through.
hint: Set the map entry **before** anybody can await, i.e. in the same synchronous call to `run`.

```ts setup
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
```

```ts starter
export function createSingleFlight<T>() {
  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      return fn() // TODO: share in-flight loads
    },
    inFlight(): number {
      return 0
    },
  }
}
```

```ts solution
export function createSingleFlight<T>() {
  const pending = new Map<string, Promise<T>>()
  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = pending.get(key)
      if (existing) return existing
      let started: Promise<T>
      try {
        started = fn()
      } catch (e) {
        started = Promise.reject(e)
      }
      const shared = started.finally(() => {
        if (pending.get(key) === shared) pending.delete(key)
      })
      pending.set(key, shared)
      return shared
    },
    inFlight(): number {
      return pending.size
    },
  }
}
```

```ts tests
test('10 concurrent calls for one key → 1 load', async () => {
  const sf = createSingleFlight<string>()
  const d = deferred<string>()
  const loader = fn(() => d.promise)
  const calls = Array.from({ length: 10 }, () => sf.run('user:1', loader))
  expect(loader).toHaveBeenCalledTimes(1)
  expect(sf.inFlight()).toBe(1)
  d.resolve('Ada')
  const results = await Promise.all(calls)
  expect(results).toEqual(Array(10).fill('Ada'))
  expect(loader).toHaveBeenCalledTimes(1)
})
test('different keys load independently', async () => {
  const sf = createSingleFlight<string>()
  const a = deferred<string>()
  const b = deferred<string>()
  const loadA = fn(() => a.promise)
  const loadB = fn(() => b.promise)
  const pa = sf.run('a', loadA)
  const pb = sf.run('b', loadB)
  sf.run('a', loadA)
  expect(sf.inFlight()).toBe(2)
  a.resolve('A')
  b.resolve('B')
  expect(await pa).toBe('A')
  expect(await pb).toBe('B')
  expect(loadA).toHaveBeenCalledTimes(1)
  expect(loadB).toHaveBeenCalledTimes(1)
})
test('it is not a cache: after settling, the next call loads again', async () => {
  const sf = createSingleFlight<number>()
  let n = 0
  const loader = fn(async () => ++n)
  expect(await sf.run('k', loader)).toBe(1)
  expect(sf.inFlight()).toBe(0)
  expect(await sf.run('k', loader)).toBe(2)
  expect(loader).toHaveBeenCalledTimes(2)
})
test('a failure reaches every waiter and is forgotten', async () => {
  const sf = createSingleFlight<string>()
  const d = deferred<string>()
  const loader = fn(() => d.promise)
  const first = sf.run('k', loader)
  const second = sf.run('k', loader)
  expect(loader).toHaveBeenCalledTimes(1)
  d.reject(new Error('timeout'))
  await expect(first).rejects.toThrow('timeout')
  await expect(second).rejects.toThrow('timeout')
  expect(sf.inFlight()).toBe(0)
  await expect(sf.run('k', async () => 'fresh')).resolves.toBe('fresh')
})
```
:::

:::warn title="Single-flight is per process"
Your single-flight map lives in one process. With 12 pods, a cold hot key can still cause **12**
loads — one per pod. That's usually fine (12 is not 4 000). If even that is too much — a
40-second report, a rate-limited partner API — add a distributed lock or stale-while-revalidate
on top. **Redis as Queue, Bus and Lock** shows a correct Redis lock.
:::

## The three caching APIs in .NET

.NET gives you three abstractions. They're not competitors so much as layers.

```text
 ┌──────────────────────── HybridCache (.NET 8+ package) ───────────────────┐
 │  GetOrCreateAsync(key, factory, options, tags)                           │
 │  ▸ stampede protection (per process)  ▸ serialization  ▸ tags            │
 │                                                                          │
 │   L1: in-process memory  ───miss───►  L2: IDistributedCache  ───miss───► │ factory → DB
 │       (IMemoryCache)                     (Redis via StackExchange.Redis) │
 └──────────────────────────────────────────────────────────────────────────┘
```

| | `IMemoryCache` | `IDistributedCache` | `HybridCache` |
|---|---|---|---|
| Where data lives | This process's heap | External store (Redis, SQL Server, Postgres…) | L1 memory **+** optional L2 distributed |
| Shared across pods | No | Yes | L2 yes, L1 no |
| Survives a restart/deploy | No | Yes | L2 yes |
| Values | Any object, **by reference** | `byte[]` — you serialize | Any `T` — it serializes (System.Text.Json by default) |
| Get-or-create | `GetOrCreateAsync` (no stampede protection) | No — write it yourself | `GetOrCreateAsync` **with** stampede protection |
| Tags / group invalidation | No | No | `RemoveByTagAsync` |
| Package | in the shared framework | `Microsoft.Extensions.Caching.StackExchangeRedis` for Redis | `Microsoft.Extensions.Caching.Hybrid` |

### IMemoryCache — fast, local, by reference

```csharp
builder.Services.AddMemoryCache(o => o.SizeLimit = 10_000);   // with SizeLimit, every entry MUST set Size

public sealed class CatalogService(IMemoryCache cache, ProductRepo repo)
{
    public async Task<Product?> GetAsync(int id, CancellationToken ct) =>
        await cache.GetOrCreateAsync($"product:{id}", async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5);
            entry.Size = 1;
            return await repo.LoadAsync(id, ct);
        });
}
```

Great for small, hot, per-process data (config, lookup tables). Two traps: concurrent misses
**all** run the factory (no single-flight), and you get back **the same object instance** every
time — mutate it and you've mutated the cache for everybody.

:::quiz id=cl-02-q5 xp=10
A handler reads a `List<Product>` from `IMemoryCache` and, for anonymous users, calls
`products.RemoveAll(p => p.IsHidden)` before returning it. An hour later admins report hidden
products have vanished from **their** view too. Why?
- [ ] `IMemoryCache` evicted the hidden products under memory pressure
- [x] `IMemoryCache` stores the object reference, so `RemoveAll` mutated the cached list itself
- [ ] The admin and anonymous requests used different cache keys
- [ ] `IMemoryCache` serializes lists and drops fields it can't serialize
> `IMemoryCache` keeps the object on the heap and hands everyone the same instance; filtering it
> in place changed the cached copy for every later reader. Fix: treat cached objects as immutable
> (return `IReadOnlyList<T>`, filter into a new list). The tempting answer is eviction — but
> eviction removes the *whole entry*, it never edits a list's contents. `HybridCache`, by
> contrast, deserializes a fresh instance per call by default, which is slower but makes this
> bug impossible.
:::

### IDistributedCache — shared, bytes only

```csharp
builder.Services.AddStackExchangeRedisCache(o =>
{
    o.Configuration = builder.Configuration.GetConnectionString("redis");   // "localhost:6379"
    o.InstanceName  = "shop:";                                               // key prefix
});

public sealed class ProductReader(IDistributedCache cache, ProductRepo repo)
{
    public async Task<Product> GetAsync(int id, CancellationToken ct)
    {
        var key = $"product:{id}";
        byte[]? bytes = await cache.GetAsync(key, ct);
        if (bytes is not null) return JsonSerializer.Deserialize<Product>(bytes)!;

        var p = await repo.LoadAsync(id, ct);
        await cache.SetAsync(key, JsonSerializer.SerializeToUtf8Bytes(p),
            new DistributedCacheEntryOptions { AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(5) }, ct);
        return p;
    }
}
```

Every read is a network hop plus deserialization; no stampede protection; you write the
cache-aside dance by hand. This was "the way" until .NET 9. You'll still meet it everywhere — and
it's what `HybridCache` uses as its L2.

### HybridCache — the default for new code

`HybridCache` is an abstract class (in `Microsoft.Extensions.Caching.Abstractions`) with a default
implementation in the `Microsoft.Extensions.Caching.Hybrid` NuGet package. It went GA in 2025,
alongside the .NET 9 wave, but the package targets **.NET 8 and later** (and even .NET Standard 2.0),
so it is not a reason to upgrade the runtime. It's the recommended caching API for new code on
.NET 8, 9 and 10; you add the package yourself, it isn't part of the shared framework. Register it, and if an `IDistributedCache` is also registered it
becomes L2 **automatically**:

```csharp
builder.Services.AddStackExchangeRedisCache(o =>          // L2 (optional, but that's the point)
{
    o.Configuration = builder.Configuration.GetConnectionString("redis");
    o.InstanceName  = "shop:";
});

builder.Services.AddHybridCache(o =>
{
    o.MaximumPayloadBytes = 1024 * 1024;                   // bigger values aren't cached (default 1 MB)
    o.MaximumKeyLength    = 1024;                          // longer keys bypass the cache (default 1024)
    o.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration           = TimeSpan.FromMinutes(5),    // L2 TTL
        LocalCacheExpiration = TimeSpan.FromSeconds(30),   // L1 TTL — keep it SHORT (see below)
    };
});
```

Using it is a single call — it's read-through, with single-flight built in:

```csharp
public sealed class ProductService(HybridCache cache, ProductRepo repo)
{
    public ValueTask<Product> GetAsync(int id, CancellationToken ct) =>
        cache.GetOrCreateAsync(
            $"product:{id}",
            (repo, id),                                                    // state → no closure allocation
            static async (s, token) => await s.repo.LoadAsync(s.id, token),
            tags: ["products", $"tenant:{TenantId}"],
            cancellationToken: ct);

    public async Task UpdatePriceAsync(int id, decimal price, CancellationToken ct)
    {
        await repo.SetPriceAsync(id, price, ct);                          // 1. source of truth
        await cache.RemoveAsync($"product:{id}", ct);                     // 2. delete-on-write
    }

    public ValueTask AfterImportAsync(CancellationToken ct) =>
        cache.RemoveByTagAsync("products", ct);                           // group invalidation

    private const string TenantId = "17";
}
```

Per-entry overrides go in a `HybridCacheEntryOptions` passed to `GetOrCreateAsync`, including
`Flags` such as `HybridCacheEntryFlags.DisableLocalCache` (L2 only — for data that must be the same
on every pod) or `DisableDistributedCache` (L1 only).

**Serialization.** `string` and `byte[]` are stored as-is; everything else goes through
System.Text.Json unless you register a serializer with
`AddHybridCache().AddSerializer<T, TSerializer>()` (an `IHybridCacheSerializer<T>`) or a
serializer factory — that's how teams plug in MessagePack or protobuf for smaller payloads. By
default every call returns a **freshly deserialized instance** (safe to mutate). If your type is
`sealed` and marked `[ImmutableObject(true)]`, HybridCache may hand out the same L1 instance
instead — faster, and safe *because* you promised not to mutate it.

:::warn title="L1 is per pod — and nothing tells the other pods"
`RemoveAsync` on pod A deletes the Redis (L2) entry and A's own memory (L1) entry. **Pod B's L1
copy is untouched** and keeps serving the old value until its `LocalCacheExpiration` runs out.
You'll see this with your own eyes in the lab. Tag invalidation is similar: it's recorded in L2,
but an L1 hit on another pod doesn't go and check. As of .NET 10 the built-in HybridCache has no
**backplane** (a pub/sub channel that tells every pod to drop its L1 entry). Your options: keep
`LocalCacheExpiration` short (seconds), use `DisableLocalCache` for data that must be consistent,
or use a library with a Redis backplane (FusionCache implements the HybridCache abstraction and
has one). This area is evolving — check the current HybridCache docs on learn.microsoft.com before
relying on cross-node behaviour.
:::

:::warn title="When Redis is down"
In the lab you'll see that stopping Redis doesn't break the API: HybridCache logs the L2 failure
and calls the factory. But each miss first waits for StackExchange.Redis's **default 5-second
timeout** (`syncTimeout`/`asyncTimeout` default to 5000 ms). A
cache that makes every request 5 s slower during an outage is worse than no cache. Set short
timeouts in the connection string, e.g.
`localhost:6379,abortConnect=false,connectTimeout=2000,syncTimeout=1000,asyncTimeout=1000`
(see the StackExchange.Redis *Configuration* docs for the full list), and test the outage on
purpose.
:::

:::quiz id=cl-02-q6 xp=15
12 API pods use `HybridCache` with Redis as L2. A hot key has just expired in **both** L1 (on all
pods) and L2. 3 000 requests for it arrive within 100 ms, spread evenly across the pods. How many
times does the factory (the DB query) run, roughly?
- [ ] Exactly 1 — HybridCache coordinates through Redis
- [x] Up to 12 — one per pod
- [ ] About 3 000 — HybridCache has no stampede protection
- [ ] 0 — HybridCache serves the expired value
> HybridCache's stampede protection coalesces concurrent calls for the same key **inside one
> process**, so each pod runs the factory once: ≤ 12 loads instead of 3 000. The tempting answer
> is "exactly 1" — but nothing in HybridCache takes a cluster-wide lock in Redis; for that you'd
> add a distributed lock (*Redis as Queue, Bus and Lock*). "3 000" would be true for plain `IDistributedCache` or
> `IMemoryCache.GetOrCreateAsync`, which don't coalesce. And HybridCache doesn't serve expired
> data (no built-in stale-while-revalidate).
:::

:::quiz id=cl-02-q7 xp=10
Pod A updates a price and calls `cache.RemoveAsync("product:1")`. For the next ~30 seconds pod B
still returns the **old** price; after that it's correct. What explains it?
- [ ] `RemoveAsync` is fire-and-forget, so the Redis delete happens ~30 s later
- [ ] Redis replication lag between primary and replica
- [x] Pod B served its own in-memory L1 copy until `LocalCacheExpiration` (30 s) ran out
- [ ] HybridCache caches values forever until the process restarts
> `RemoveAsync` removes the Redis entry and A's local copy right away — but B's L1 lives in B's
> process, and nothing notifies B. Once B's L1 entry expires, B misses L1, goes to Redis, and gets
> the fresh value. Replication lag is the tempting answer, but it's milliseconds, not a neat
> 30 seconds that happens to equal your L1 setting. Shorter L1 TTLs, `DisableLocalCache`, or a
> backplane fix it.
:::

:::job title="What you'll meet on day one"
Most existing .NET codebases use `IDistributedCache` + `AddStackExchangeRedisCache` with
hand-written cache-aside helpers, often called `GetOrSetAsync` in a `CacheExtensions` class —
read it carefully, it's where the bugs live (no TTL, swallowed errors, `if (value == null)` treating
cached nulls as misses). New services increasingly use `HybridCache`. In code review, expect
questions like *"what's the TTL and why?"*, *"what invalidates this?"* and *"is the user/tenant in
the key?"* — and in interviews: *"how do you prevent a cache stampede?"*
:::

## Output caching with Redis

Everything so far caches **data**. Output caching caches the **whole HTTP response** — status,
headers, body — so the endpoint doesn't even run. ASP.NET Core's output cache (not the older
*response caching* middleware, which just honours `Cache-Control` headers) stores in memory by
default; the `Microsoft.AspNetCore.OutputCaching.StackExchangeRedis` package makes the store
Redis, so every pod shares one cache.

```csharp
builder.Services.AddStackExchangeRedisOutputCache(o =>
{
    o.Configuration = builder.Configuration.GetConnectionString("redis");
    o.InstanceName  = "shop-oc:";
});
builder.Services.AddOutputCache(o =>
{
    o.AddBasePolicy(p => p.Expire(TimeSpan.FromSeconds(30)));
    o.AddPolicy("catalog", p => p
        .Expire(TimeSpan.FromMinutes(5))
        .SetVaryByQuery("page", "sort")      // only these query params vary the key; others are ignored
        .Tag("catalog"));
});

var app = builder.Build();
app.UseOutputCache();                        // after UseCors/UseRouting, if you use them

app.MapGet("/catalog", GetCatalog).CacheOutput("catalog");

app.MapPost("/admin/catalog/publish", async (IOutputCacheStore store, CancellationToken ct) =>
{
    await store.EvictByTagAsync("catalog", ct);   // invalidate every cached catalog page
    return Results.NoContent();
});
```

The **default** policy is deliberately conservative. It only caches:

* `GET` and `HEAD` requests,
* `200 OK` responses,
* requests that are **not authenticated** (no `Authorization` header / authenticated user),
* responses that **don't set cookies**.

:::warn title="Real incident: Steam, Christmas Day 2015"
During a DDoS, Valve changed its caching configuration and for a while cached pages included
account pages — so users saw **other people's** account details (Valve estimated around 34 000
users were affected). Whole-response caching plus personal data is the most dangerous combination
in this lesson. Keep the defaults (no caching for authenticated requests), and if you override
them, vary the cache by user/tenant explicitly and write a test that proves two users get
different responses.
:::

:::quiz id=cl-02-q8 xp=10
With ASP.NET Core output caching and the **default** policy, which responses get cached? (select all that apply)
- [x] `GET /products` → `200 OK`, anonymous request
- [x] `HEAD /products` → `200 OK`, anonymous request
- [ ] `GET /me` → `200 OK`, request with an `Authorization: Bearer …` header
- [ ] `POST /orders` → `200 OK`
- [ ] `GET /products` → `200 OK`, but the response sets a cookie
> The default policy caches only anonymous `GET`/`HEAD` requests answered with `200` and no
> `Set-Cookie`. The tempting wrong pick is `GET /me` — it's a GET with a 200, but it's
> authenticated, and caching it would serve one user's profile to the next caller (see the Steam
> incident). `POST` changes state and must always run; a `Set-Cookie` response is usually
> per-user.
:::

## Measuring: is the cache actually helping?

A cache you don't measure is a superstition. Track at least:

* **Hit ratio** = hits ÷ (hits + misses), per cache "area" (products, sessions…). Under ~80 % for
  hot read paths, ask why: TTL too short? Key includes something unique (timestamp, request id)?
* **Latency of hits vs misses** — if hits aren't much faster, the cache adds complexity for nothing.
* **Loader calls per second** — the load you're actually sending to the database.
* **Redis**: `INFO stats` (`keyspace_hits`, `keyspace_misses`, `evicted_keys`), memory, and
  `redis-cli --bigkeys` / `--hotkeys` to find outliers (`--hotkeys` needs an LFU policy such as
  `allkeys-lfu`, because it reads the access-frequency counters only LFU maintains).

**Observability: OpenTelemetry, Prometheus, Grafana, Loki** shows how to turn these into
dashboards and alerts.

:::pro title="Design for the cache being empty"
Your system must be **correct** with an empty cache and **survive** with a cold one. Test it:
flush Redis in staging during load and watch the database. If a cold cache takes the site down,
you don't have a cache — you have an undocumented dependency. Add stampede protection, rate-limit
rebuilds, and warm the few critical keys on startup.
:::

:::lab id=cl-02-lab1 xp=120
title: HybridCache + Redis — two API instances, measured
You'll build an ASP.NET Core 10 minimal API with `HybridCache` (L1 memory + L2 Redis 8) and
Redis output caching, run **two instances** against one Redis, and *measure* hits, misses,
L2 sharing, stampede protection and stale L1 copies. Needs the .NET 10 SDK, Docker (or Podman)
and `curl`. On Windows, run the shell commands in Git Bash or WSL.

**1. Redis via Compose.** Make a folder `cache-lab`, and in it `compose.yaml`:

```yaml
services:
  redis:
    image: redis:8
    command: ["redis-server", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
    ports:
      - "127.0.0.1:6379:6379"     # localhost only, as in Redis Fundamentals
```

```bash
docker compose up -d
docker compose exec redis redis-cli PING
docker compose exec redis redis-cli CONFIG GET maxmemory-policy
```

Expected:

```text
PONG
1) "maxmemory-policy"
2) "allkeys-lru"
```

:::tip title="Podman"
Podman refuses short image names without a registries config. Use `image: docker.io/library/redis:8`.
:::

**2. The project.**

```bash
dotnet new web -n CacheLab -f net10.0
cd CacheLab
dotnet add package Microsoft.Extensions.Caching.Hybrid
dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
dotnet add package Microsoft.AspNetCore.OutputCaching.StackExchangeRedis
```

**3. Replace `Program.cs`** with the following. The "database" is a `prices.json` file so both
instances share one source of truth; `LoadAsync` sleeps 500 ms like a slow query and counts its
calls, so **every load is a miss** and you can compute the hit ratio.

```csharp
using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.Extensions.Caching.Hybrid;

var builder = WebApplication.CreateBuilder(args);
var redis = builder.Configuration.GetConnectionString("redis") ?? "localhost:6379";

// L2: any IDistributedCache registered in DI is picked up by HybridCache automatically.
builder.Services.AddStackExchangeRedisCache(o =>
{
    o.Configuration = redis;
    o.InstanceName = "cachelab:";
});

// L1 (in-process memory) + L2 (Redis) + stampede protection + tags.
builder.Services.AddHybridCache(o =>
{
    o.MaximumPayloadBytes = 1024 * 1024;   // 1 MB — bigger entries are not cached
    o.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(2),           // L2 (Redis) TTL
        LocalCacheExpiration = TimeSpan.FromSeconds(30) // L1 (memory) TTL
    };
});

// Output cache (whole HTTP responses) stored in Redis, shared by all instances.
builder.Services.AddStackExchangeRedisOutputCache(o =>
{
    o.Configuration = redis;
    o.InstanceName = "cachelab-oc:";
});
builder.Services.AddOutputCache(o =>
    o.AddPolicy("catalog", p => p.Expire(TimeSpan.FromSeconds(60)).Tag("catalog")));

builder.Services.AddSingleton<ProductRepo>();

var app = builder.Build();
app.UseOutputCache();

app.MapGet("/products/{id:int}", async (int id, HybridCache cache, ProductRepo repo, CancellationToken ct) =>
{
    repo.CountRequest();
    var sw = Stopwatch.StartNew();
    var product = await cache.GetOrCreateAsync(
        $"product:{id}",
        (repo, id),
        static async (state, token) => await state.repo.LoadAsync(state.id, token),
        tags: ["products"],
        cancellationToken: ct);
    return Results.Ok(new { product, ms = sw.ElapsedMilliseconds, pid = Environment.ProcessId });
});

app.MapPut("/products/{id:int}/price/{price:decimal}", async (int id, decimal price, HybridCache cache, ProductRepo repo, CancellationToken ct) =>
{
    await repo.SetPriceAsync(id, price, ct);           // 1. write the source of truth
    await cache.RemoveAsync($"product:{id}", ct);       // 2. then delete the cache entry
    return Results.NoContent();
});

app.MapDelete("/cache/products", async (HybridCache cache, CancellationToken ct) =>
{
    await cache.RemoveByTagAsync("products", ct);
    return Results.NoContent();
});

app.MapGet("/catalog", async (CancellationToken ct) =>
{
    await Task.Delay(300, ct); // pretend this is an expensive query + render
    return Results.Ok(new { generatedAt = DateTime.UtcNow.ToString("HH:mm:ss.fff"), pid = Environment.ProcessId });
}).CacheOutput("catalog");

app.MapPost("/catalog/evict", async (IOutputCacheStore store, CancellationToken ct) =>
{
    await store.EvictByTagAsync("catalog", ct);
    return Results.NoContent();
});

app.MapGet("/stats", (ProductRepo repo) => repo.Stats());

app.Run();

public sealed record Product(int Id, string Name, decimal Price);

// A fake "database": prices live in prices.json so that two API instances share one source of truth.
public sealed class ProductRepo
{
    private static readonly SemaphoreSlim FileLock = new(1, 1);
    private const string DbFile = "prices.json";
    private int _requests, _loads;

    public void CountRequest() => Interlocked.Increment(ref _requests);

    public async Task<Product> LoadAsync(int id, CancellationToken ct)
    {
        Interlocked.Increment(ref _loads);       // every call here = a cache MISS
        await Task.Delay(500, ct);                // pretend: slow SQL query
        var prices = await ReadAsync(ct);
        var price = prices.TryGetValue(id, out var p) ? p : 10m + id;
        return new Product(id, $"Product {id}", price);
    }

    public async Task SetPriceAsync(int id, decimal price, CancellationToken ct)
    {
        await FileLock.WaitAsync(ct);
        try
        {
            var prices = await ReadAsync(ct);
            prices[id] = price;
            await File.WriteAllTextAsync(DbFile, JsonSerializer.Serialize(prices), ct);
        }
        finally { FileLock.Release(); }
    }

    private static async Task<Dictionary<int, decimal>> ReadAsync(CancellationToken ct) =>
        File.Exists(DbFile)
            ? JsonSerializer.Deserialize<Dictionary<int, decimal>>(await File.ReadAllTextAsync(DbFile, ct)) ?? []
            : [];

    public object Stats()
    {
        int r = Volatile.Read(ref _requests), l = Volatile.Read(ref _loads);
        return new { requests = r, loads = l, hits = r - l, hitRatio = r == 0 ? 0 : Math.Round((double)(r - l) / r, 3) };
    }
}
```

**4. Run two instances** ("pod A" and "pod B") in two terminals, both inside `CacheLab`. Build
**once** first. Two `dotnet run`s that build at the same time fight over `obj/` and `bin/`:

```bash
dotnet build
dotnet run --no-build --no-launch-profile -- --urls http://localhost:5080    # terminal 1: pod A
dotnet run --no-build --no-launch-profile -- --urls http://localhost:5081    # terminal 2: pod B
```

:::info title="The clock is running"
L1 entries live 30 s and L2 entries 2 min. Several steps below first **warm** the entry they
need, so a slow coffee break doesn't spoil the result. If an output looks "wrong", check whether
an entry simply expired since the previous step.
:::

**5. Miss, L1 hit, L2 hit.** In a third terminal:

```bash
curl -s localhost:5080/products/1; echo     # A: cold
curl -s localhost:5080/products/1; echo     # A: again
curl -s localhost:5081/products/1; echo     # B: never seen it
curl -s localhost:5080/stats; echo
curl -s localhost:5081/stats; echo
```

Expected (your `pid`s and small timings will differ):

```text
{"product":{"id":1,"name":"Product 1","price":11},"ms":544,"pid":1115632}   ← miss: loader ran
{"product":{"id":1,"name":"Product 1","price":11},"ms":0,"pid":1115632}     ← L1 hit
{"product":{"id":1,"name":"Product 1","price":11},"ms":40,"pid":1115633}    ← L2 (Redis) hit, no load on B
{"requests":2,"loads":1,"hits":1,"hitRatio":0.5}
{"requests":1,"loads":0,"hits":1,"hitRatio":1}
```

B's first call includes connecting to Redis; repeat it and it drops to ~0–1 ms (now an L1 hit).

**6. Stampede.** Fire 50 concurrent requests at B for a product nobody has loaded yet:

```bash
seq 1 50 | xargs -P 50 -I{} curl -s -o /dev/null localhost:5081/products/7
curl -s localhost:5081/stats; echo
```

`requests` goes up by 50, `loads` by exactly **1** — HybridCache coalesced the 49 others onto the
first load. (Try it with `IDistributedCache` and hand-written cache-aside if you want to see 50.)

**7. Look inside Redis.**

```bash
docker compose exec redis redis-cli --scan --pattern 'cachelab:*'
docker compose exec redis redis-cli TTL cachelab:product:7
docker compose exec redis redis-cli TYPE cachelab:product:7
```

Expected: `cachelab:product:7` (and `cachelab:product:1` if fewer than 2 minutes have passed since
step 5); a TTL of at most `120` seconds, counting down (the 2-minute `Expiration`; `-2` means the
key has already expired, so redo step 6); type `hash`, because the Redis `IDistributedCache` stores
the payload plus expiry metadata in hash fields. The payload is HybridCache's own binary-framed
format, so don't read or write these keys from other code.

**8. Delete-on-write and the stale L1.** Run these four commands **back to back** (paste them
as one block). The first one puts product 1 into B's L1 *now*, because B's copy from step 5 has
almost certainly expired by this point:

```bash
curl -s localhost:5081/products/1; echo     # B: warm B's L1 (its 30 s clock starts now)
curl -s -X PUT -o /dev/null -w "%{http_code}\n" localhost:5080/products/1/price/99.5
curl -s localhost:5080/products/1; echo     # A
curl -s localhost:5081/products/1; echo     # B — immediately
```

Expected (the first line may show a load on B if the step-5 entry also left Redis, which is fine):

```text
{"product":{"id":1,"name":"Product 1","price":11},"ms":1,"pid":1115633}      ← B: warm
204
{"product":{"id":1,"name":"Product 1","price":99.5},"ms":502,"pid":1115632}  ← A: L1+L2 removed → reload
{"product":{"id":1,"name":"Product 1","price":11},"ms":0,"pid":1115633}      ← B: STALE, from its own L1
```

Wait ~30 seconds (B's `LocalCacheExpiration`) and request B again: now `99.5`, and B's `loads` in
`/stats` doesn't move. B missed L1 and hit the fresh entry A wrote to Redis.

**9. Tag invalidation.**

First make sure product 7 is cached on A (the second call must show `ms` ≈ 0), then invalidate
the tag and read it again:

```bash
curl -s localhost:5080/products/7; echo     # warm (L2 hit, or a load if it expired meanwhile)
curl -s localhost:5080/products/7; echo     # ms ≈ 0: definitely cached now
curl -s -X DELETE -o /dev/null -w "%{http_code}\n" localhost:5080/cache/products
docker compose exec redis redis-cli --scan --pattern 'cachelab:*'
curl -s localhost:5080/products/7; echo     # ms ≈ 500: reloaded
```

The product keys are **still in Redis**, plus a new key like `cachelab:__MSFT_HCT__products`
that holds the tag's invalidation timestamp. Tag removal is *logical*: entries tagged `products`
that were created before that timestamp are treated as misses, so A reloads product 7 although
both its L1 entry and the Redis key still exist. The exact internal key name is an implementation
detail and may change between versions.

**10. Output cache shared through Redis.**

```bash
curl -s localhost:5080/catalog; echo
curl -s localhost:5080/catalog; echo        # same generatedAt → served from cache
curl -s localhost:5081/catalog; echo
docker compose exec redis redis-cli --scan --pattern 'cachelab-oc:*'
curl -s -X POST -o /dev/null -w "%{http_code}\n" localhost:5080/catalog/evict
curl -s localhost:5080/catalog; echo        # new generatedAt
```

Note the keys: the output-cache key includes the **host and port** (`…LOCALHOST:5080/CATALOG…`),
so A and B cache separately here. Behind a real load balancer all pods see the same `Host`, so
they share entries. One `EvictByTagAsync` cleared both.

**11. Break Redis on purpose.**

```bash
docker compose stop redis
curl -s -o /dev/null -w "%{time_total}s\n" localhost:5080/products/55
curl -s -o /dev/null -w "%{time_total}s\n" localhost:5080/products/55
docker compose start redis
```

The first call still returns `200` but takes **roughly 5–6 s**: StackExchange.Redis queues the
L2 read until its default 5 s timeout, HybridCache logs the failure and runs the 500 ms load. The
second call is an L1 hit. Exact timings depend on the client version and on when it notices the
connection is gone, so treat these as orders of magnitude.

The block's last line already restarted Redis. Now stop pod A (`Ctrl+C`) and restart it with
short timeouts in the connection string:

```bash
dotnet run --no-build --no-launch-profile -- --urls http://localhost:5080 \
  --ConnectionStrings:redis="localhost:6379,abortConnect=false,connectTimeout=2000,syncTimeout=1000,asyncTimeout=1000"
```

Request any product once (so A connects while Redis is up), stop Redis, and repeat the two
timed `curl`s with a new id (e.g. `/products/56`). The outage penalty shrinks to about a second.

:::tip title="Clean up"
`Ctrl+C` both instances, then `docker compose down` in `cache-lab`.
:::

- [ ] Step 5: the first request took ~500 ms, the second ~0 ms, and pod B served product 1 with `loads: 0`
- [ ] Step 6: 50 concurrent requests caused exactly one additional load
- [ ] Step 7: I found the keys in Redis and their TTL counts down from at most 120 s
- [ ] Step 8: I saw pod B serve the stale price, then the new one after ~30 s, and can explain why
- [ ] Step 9: tag invalidation forced a reload although the keys were still in Redis
- [ ] Step 10: the output cache returned the same `generatedAt` until I evicted the `catalog` tag
- [ ] Step 11: I measured the Redis-down penalty before and after setting short timeouts
:::

## Choosing, in one table

| Situation | Reach for |
|---|---|
| New service, read-heavy data, several pods | `HybridCache` + Redis L2, short L1 |
| Must be identical on all pods immediately | `HybridCache` with `DisableLocalCache`, or no cache |
| Tiny, hot, per-process lookup data | `IMemoryCache` (or HybridCache without L2) |
| Existing code on `IDistributedCache` | Keep it; migrate hot paths to `HybridCache` when you touch them |
| Whole public GET responses | Output caching with the Redis store, tags for eviction |
| Group invalidation of millions of keys | Versioned keys (`INCR ver:ns`) or tags |
| One very expensive key, many pods | Single-flight + distributed lock (*Redis as Queue, Bus and Lock*) or stale-while-revalidate |

:::cards id=cl-02-cards1 xp=15 title="Caching with Redis in .NET"
Q: What is cache-aside?
A: The app checks the cache; on a miss it loads from the DB, stores the result with a TTL, and returns it. Writes go to the DB and then delete the key.
Q: Why delete the key on write instead of setting the new value?
A: Concurrent writers can SET in the wrong order and leave the cache disagreeing with the DB until the TTL. Delete lets the next reader load the committed value.
Q: Why add jitter to TTLs?
A: Keys created together expire together; jitter (e.g. ±10 %) spreads expiry so the DB doesn't get a synchronized reload spike.
Q: What is a cache stampede?
A: A hot key expires and many concurrent requests miss at once, all running the same expensive load against the DB.
Q: What does single-flight do?
A: Concurrent requests for the same key share one in-flight load instead of each running their own. Per process.
Q: What is a versioned (generation) key?
A: A namespace counter in the key (products:v4:42). INCR the counter to invalidate the whole group in O(1).
Q: IMemoryCache vs IDistributedCache?
A: IMemoryCache: per process, object references, fastest. IDistributedCache: shared external store (Redis), byte[] values, network hop.
Q: What does HybridCache add?
A: L1 memory + L2 distributed, GetOrCreateAsync with stampede protection, serialization, tags (RemoveByTagAsync). A NuGet package that runs on .NET 8+ (GA in 2025).
Q: Why keep HybridCache's LocalCacheExpiration short?
A: L1 lives in each pod; removing a key on one pod doesn't clear other pods' L1, which stay stale until their L1 TTL expires.
Q: Which Redis maxmemory-policy for a pure cache?
A: allkeys-lru (or allkeys-lfu). The default noeviction makes writes fail when memory is full.
Q: What does the default output-cache policy cache?
A: Only anonymous GET/HEAD requests with 200 responses that don't set cookies.
Q: What is negative caching?
A: Caching "not found" results with a short TTL so repeated lookups for missing IDs don't hit the DB.
:::

## Recap

- A cache is a **copy with an expiry date**. Decide how stale each piece of data may be; never
  make exact decisions (money, permissions) from a cache.
- **Cache-aside** is the default: read cache → miss → load → store with TTL. Writes go to the DB
  first, then **delete** the key.
- **Every key gets a TTL**, chosen from business tolerance, with **jitter** so keys don't expire together.
- Invalidate with TTLs, delete-on-write, **versioned keys** (`INCR` a generation) and **tags**; put
  a schema version in key prefixes for rolling deploys.
- Stop **stampedes** with single-flight (per process), plus locks, stale-while-revalidate or
  probabilistic early refresh when needed.
- In .NET 10, use **HybridCache** (L1 memory + Redis L2, stampede protection, tags) for new code;
  keep L1 short because other pods aren't told about removals.
- **Output caching** with the Redis store caches whole responses across pods — keep the safe
  defaults for authenticated requests.
- Configure Redis as a cache (`allkeys-lru`), set short client timeouts, and **measure** hit ratio
  and loader calls.
- On Azure or AWS the L2 is usually **Azure Managed Redis** or **ElastiCache**. The HybridCache code
  doesn't change; the connection does (TLS, Entra ID or IAM auth instead of a password, private
  endpoints). **The Managed Equivalents: Azure & AWS** covers that switch.
