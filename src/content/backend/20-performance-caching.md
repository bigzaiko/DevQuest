---
id: be-20
title: Performance & Caching
level: expert
minutes: 85
xp: 200
summary: Measure before you optimize (BenchmarkDotNet, dotnet-counters, dotnet-trace), cut allocations, cache with IMemoryCache, HybridCache and output caching, paginate with keysets, stream big responses, and avoid async and connection-pool traps.
---

"The API is slow" is not a bug report. Slow where? For which requests? Since when? How slow
counts as too slow? Most performance work in a SaaS backend isn't clever code. It's making that
question precise, measuring, and then doing the boring fix: **don't do the work** (cache it),
**do less of it** (project, paginate, stream), or **stop waiting on the wrong thing** (async
pitfalls, connection pools).

This lesson goes in that order. Measure first, then allocations, caching at three levels,
pagination and streaming, and finally the async and pooling mistakes that take down production
APIs that are otherwise fine.

## Measure first

Intuition about performance is wrong often enough that you shouldn't act on it. The method:

1. **Define the target.** "p95 of `GET /projects` below 150 ms at 200 req/s" is a target. "Faster" isn't.
2. **Measure the system** under realistic load, then find where the time goes.
3. **Form one hypothesis**, change **one** thing, and measure again.
4. **Keep the proof**: a benchmark, a trace, or a dashboard screenshot in the PR.

Pick the tool by the question you're asking:

| Question | Tool | Notes |
|---|---|---|
| Which of these two implementations is faster or allocates less? | **BenchmarkDotNet** | Micro-benchmarks. Release build, many iterations, statistics. |
| What is the running process doing right now? | **dotnet-counters** | Live CPU, GC, allocation rate, thread pool queue, exceptions, request rate. |
| Where does the CPU time go? | **dotnet-trace** | Sampling profiler. Open the file as a flame graph (speedscope, PerfView, Visual Studio). |
| What fills the heap? | **dotnet-gcdump** / **dotnet-dump** | Heap snapshot by type, or a full dump for hangs. |
| How does the endpoint behave under load? | **k6**, **bombardier**, **NBomber** | Throughput and latency percentiles, not averages. |
| How does it behave in production? | **OpenTelemetry** metrics and traces | `http.server.request.duration` histograms, DB spans (lesson be-19). |

```bash
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-gcdump

dotnet-counters ps                                       # find the process id
dotnet-counters monitor -n Projects.Api --counters System.Runtime,Microsoft.AspNetCore.Hosting
dotnet-trace collect -n Projects.Api --format speedscope --duration 00:00:00:30
dotnet-gcdump collect -n Projects.Api
```

What to look for in `dotnet-counters`:

- **Allocation rate** (MB/s) and **GC collections** per generation. Lots of gen 2 collections, or a
  high share of time in GC, means you allocate too much or keep objects alive too long.
- **Thread pool queue length** that keeps growing while **CPU stays low** is the signature of
  **thread pool starvation**: threads are blocked waiting (usually sync-over-async), so queued
  work can't run. More on that below.
- **Exception count.** Exceptions are expensive. Thousands per second usually means exceptions
  are being used for control flow.

:::tip title="Percentiles, not averages"
An average of 40 ms can hide a p99 of 3 s, and that 1 % is your angriest users. Real latency
is a long-tail distribution, so always look at p50, p95 and p99. ASP.NET Core's built-in
`http.server.request.duration` metric is a histogram for exactly this reason.
:::

### BenchmarkDotNet in two minutes

BenchmarkDotNet runs your method thousands of times in a separate, optimized process. It warms
up the JIT, removes outliers and reports mean, error and allocations. The rules:

- Run in **Release** (`dotnet run -c Release`), without a debugger attached.
- **Return the result** of the work. Otherwise the JIT may remove the code as dead, and you'll
  "measure" an empty method.
- Add `[MemoryDiagnoser]`. The **Allocated** column often matters more than the time column,
  because allocations cost you again later, as GC pauses under load.
- Mark one method `Baseline = true` so you get ratios, and use `[Params]` to test several input sizes.
- Benchmark **CPU and memory work**, not I/O. A benchmark that calls Postgres measures your network.

You'll run one in the second lab.

:::quiz id=be-20-q1 xp=15
A teammate posts this benchmark to justify a refactor. It reports `0.0001 ns` for `New` and
`85 ns` for `Old`. What is the most likely problem?

```csharp
[MemoryDiagnoser]
public class SlugBench
{
    [Benchmark(Baseline = true)]
    public void Old() => Slugger.OldSlug("Hello World, Again!");

    [Benchmark]
    public void New() => Slugger.NewSlug("Hello World, Again!");
}
```

- [ ] BenchmarkDotNet can't benchmark static methods
- [x] The results are discarded, so the JIT can eliminate the work in `New` as dead code. Return the value from the benchmark method.
- [ ] `[MemoryDiagnoser]` makes timings unreliable
- [ ] The input string is too short to measure
> A time below a nanosecond means nothing ran: even one CPU instruction takes longer. If `NewSlug` is small enough to inline and its result is unused, the JIT can remove it. Benchmarks should `return` their result (BenchmarkDotNet consumes it). The other options are wrong: static methods benchmark fine, `[MemoryDiagnoser]` measures allocations in a separate pass and doesn't distort timings, and short inputs are measured reliably because BenchmarkDotNet runs millions of iterations. Also be wary when the input is a constant the JIT can fold; a field set in `[GlobalSetup]` avoids that.
:::

## Allocations and the GC

Why care about allocations in a managed language? Because every object you allocate on the heap
has to be found and freed later by the **garbage collector (GC)**, and while it works, it uses
CPU and can briefly pause your threads.

.NET's GC is **generational**, based on the observation that most objects die young (a DTO
lives for one request). **Gen 0** holds new objects. Its collections are cheap and frequent.
Objects that survive move to **gen 1** and then **gen 2**, which is collected rarely and expensively.
Objects of **85,000 bytes or more** go straight to the **Large Object Heap** (LOH). The LOH is
collected only with gen 2 and isn't compacted by default, so it fragments.

So allocation itself is cheap (bump a pointer), but **allocation rate** becomes **GC time**, and
GC time becomes latency spikes. On a hot path such as a request handler at 2,000 req/s, a 50 KB
allocation per request is about 100 MB/s of garbage.

Common hidden allocations:

| Pattern | Why it allocates | Better |
|---|---|---|
| `s += x` in a loop | A new string each time | `StringBuilder`, `string.Join`, `string.Create` |
| `str.Split(...)` just to count or check | An array plus one string per part | `ReadOnlySpan<char>` with `IndexOf` / `MemoryExtensions.Split` |
| LINQ on a hot path | Enumerator objects, closures, delegates | A plain `foreach`. LINQ is fine everywhere else. |
| Calling `ToList()` repeatedly | Copies the sequence each time | Materialize once and reuse |
| Boxing (`struct` → `object` / interface) | A heap copy of the value | Generics, typed collections |
| Reading a large body into a `string` | LOH allocations | Stream it (`System.Text.Json` + `Stream`) |
| Temporary buffers | A new array per call | `ArrayPool<T>.Shared.Rent` / `Return`, `stackalloc` for small sizes |
| Read-only lookup tables built once at startup | No allocation, but a general-purpose `Dictionary` reads slower than it could | `FrozenDictionary` / `FrozenSet` (.NET 8+): slower to build, faster to read |

:::warn title="Optimize the hot path, not the codebase"
Rewriting every LINQ query as span code makes the code worse and the app no faster. Measure
first. In a typical CRUD API, 90 % of the time is spent waiting on the database and the network.
That's where caching, projection and fewer round trips pay off. Micro-optimizations are for the
few code paths a profiler shows you.
:::

:::info title="Server GC and DATAS"
ASP.NET Core apps use **Server GC** by default, with one heap per core, tuned for throughput.
Since .NET 9, **DATAS** (Dynamic Adaptation To Application Sizes) is on by default with Server
GC. It grows and shrinks the number of heaps with the actual load, which matters in containers
with memory limits. If a pod's memory looks too high or too low, check `DOTNET_GCHeapHardLimit`,
the container limits and DATAS before changing code.
:::

:::quiz id=be-20-q2 xp=15
This export endpoint is called a few times per second for projects with about 5,000 documents.
`dotnet-counters` shows several GB/s of allocations and frequent gen 2 GCs. Which change helps most?

```csharp
app.MapGet("/projects/{id:guid}/export.csv", async (Guid id, AppDbContext db) =>
{
    var rows = await db.Documents.Where(d => d.ProjectId == id).ToListAsync();
    var csv = "";
    foreach (var r in rows)
        csv += $"{r.Id},{r.Title},{r.Version}\n";
    return Results.Text(csv, "text/csv");
});
```

- [ ] Add `ConfigureAwait(false)` to the `ToListAsync` call
- [ ] Switch to Workstation GC
- [x] Stop building a giant string with `+=` (each step copies the whole CSV so far, which is O(n²) bytes, and the result is on the LOH). Stream rows to the response with `AsAsyncEnumerable` and write each line.
- [ ] Use `Task.Run` so the string building happens on another thread
> String concatenation in a loop copies everything built so far on every iteration. For 5,000 rows that's around a gigabyte of garbage per request, and the final string is a large object. `ConfigureAwait(false)` changes nothing in ASP.NET Core (there's no context to return to), and Workstation GC would collect the same garbage with fewer heaps, usually worse. Streaming (`AsNoTracking().AsAsyncEnumerable()` and writing to `Response.Body`, or returning `IAsyncEnumerable`) keeps memory flat. `Task.Run` just moves the same garbage to another thread.
:::

## Caching: don't do the work twice

A cache trades **freshness** for **speed**. Before adding one, answer three questions:

1. **How stale may this be?** One second, one minute, or never (then don't cache)?
2. **Who may see it?** Public data, per-tenant, or per-user? The cache key must include
   everything that changes the answer, **including identity**, or you will leak data between users.
3. **How is it invalidated?** By time-to-live (TTL), explicit removal on write, a version in the
   key, or tags?

The layers in a typical SaaS backend, from the user inward:

| Layer | What is cached | Controlled by |
|---|---|---|
| Browser / CDN | HTTP responses | `Cache-Control`, `ETag` headers |
| **Output cache** | Whole HTTP responses, on the server | `AddOutputCache` + `.CacheOutput(...)` |
| **Data cache** | Results of expensive work (queries, API calls) | `IMemoryCache`, `IDistributedCache`, **`HybridCache`** |
| Database | Pages in shared buffers | Postgres |

### `IMemoryCache`: simple, per-process, no stampede protection

```csharp
var stats = await memoryCache.GetOrCreateAsync($"project-stats:{id}", entry =>
{
    entry.AbsoluteExpirationRelativeToNow = TimeSpan.FromMinutes(1);
    return statsService.ComputeAsync(id, ct);
});
```

Easy to use, with three catches:

- **Per process.** Five pods hold five separate caches. After a write you can invalidate only the
  pod that handled it, so the other four serve stale data until their TTL expires.
- **No stampede protection.** When a popular key expires, *every* concurrent request misses and
  runs the factory at the same time. 500 requests become 500 identical expensive queries just as
  the database is under load. This is the **cache stampede** (thundering herd). You'll prove it in the lab.
- **Unbounded by default.** Set `SizeLimit`, and then every entry must declare a `Size`.

### `IDistributedCache` (Redis): shared, but bytes only

`AddStackExchangeRedisCache` gives every pod the same cache, so an invalidation reaches all of
them. You serialize to `byte[]` yourself and pay a network hop on every read, and there's still
no stampede protection.

### `HybridCache`: the modern default

`HybridCache` (package `Microsoft.Extensions.Caching.Hybrid`, stable since 2025, works on .NET 8+)
combines both and fixes the stampede:

- **L1** is in-process memory (fast). **L2** is any registered `IDistributedCache`, such as Redis
  (shared). Without L2 it is a better `IMemoryCache`. On a read it tries L1, then L2, and only
  then runs your factory, writing the result to both.
- **Stampede protection.** Concurrent requests for the same missing key wait for **one** factory
  call. This works **per process**: with five pods, a cold key can still run the factory up to
  five times, once per pod, which is usually fine.
- **Serialization** is built in (System.Text.Json by default, pluggable).
- **Tags.** `RemoveByTagAsync("project:42")` invalidates a group of entries.

```csharp
builder.Services.AddHybridCache(o => o.DefaultEntryOptions = new HybridCacheEntryOptions
{
    Expiration = TimeSpan.FromMinutes(5),            // L2 lifetime
    LocalCacheExpiration = TimeSpan.FromMinutes(1),  // L1 lifetime (bounds per-pod staleness)
});
// optional L2: builder.Services.AddStackExchangeRedisCache(o => o.Configuration = "localhost:6379");

var stats = await cache.GetOrCreateAsync(
    $"project-stats:{id}",
    async token => await statsService.ComputeAsync(id, token),
    tags: [$"project:{id}"],
    cancellationToken: ct);

// on write:
await cache.RemoveByTagAsync($"project:{id}", ct);
```

Why two lifetimes? L1 lives in each pod, and an invalidation on pod A can't reach the memory of
pod B. `LocalCacheExpiration` is therefore the upper bound on how long another pod can serve a
stale value. Keep it short (seconds to a minute) for data that changes. The factory receives
its own `token`: pass that one, not the request's `ct`, because the result may be shared by
several waiting requests.

:::pro title="Versioned keys: invalidation for free"
In the Projects API every document has a `Version` that increases on each save (lesson be-18).
Cache derived data under `doc-render:{id}:v{version}`. A new save produces a new key, so stale
entries are never read again and just expire. There's no invalidation code and no race between
"write DB" and "delete cache". When you can't put a version in the key, prefer **delete on
write** over **update on write**. Two concurrent writers updating the cache can leave the older
value in it.
:::

:::quiz id=be-20-q3 xp=20
Spot the bug. This endpoint is behind authentication, and every project has its own members.

```csharp
app.MapGet("/projects/{id:guid}/documents", async (Guid id, ClaimsPrincipal user,
    HybridCache cache, AppDbContext db, CancellationToken ct) =>
{
    var docs = await cache.GetOrCreateAsync($"docs:{id}", async t =>
    {
        var me = user.FindFirstValue("sub")!;
        if (!await db.ProjectMembers.AnyAsync(m => m.ProjectId == id && m.UserId == me, t))
            return new List<DocumentDto>();
        return await db.Documents.Where(d => d.ProjectId == id)
            .Select(d => new DocumentDto(d.Id, d.Title)).ToListAsync(t);
    }, cancellationToken: ct);
    return Results.Ok(docs);
});
```

- [ ] Nothing. The membership check protects the data.
- [x] The authorization check is *inside* the cached factory. It runs only for the first caller. If a member fills the cache first, a non-member gets the cached list. If a non-member is first, members get an empty list for five minutes.
- [ ] `HybridCache` can't cache lists
- [ ] The key should use `id.ToString("N")`
> Authorization must run on **every** request, outside the cache. Cache only data that's the same for everyone who is allowed to see it, and check access before you read the cache. For per-user data, the user id must be part of the key, as in `docs:{id}:user:{me}`. The distractors are wrong: `HybridCache` serializes lists without trouble, and the key format doesn't matter as long as it's consistent. The membership check *looks* protective, which is why this bug survives code review.
:::

### Output caching: cache the whole response

Output caching (`Microsoft.AspNetCore.OutputCaching`, built in since .NET 7) stores complete
responses on the server. A hit skips model binding, the handler and serialization entirely.

```csharp
builder.Services.AddOutputCache(o =>
    o.AddPolicy("catalog", p => p.Expire(TimeSpan.FromSeconds(60)).Tag("catalog")));

app.UseOutputCache();                         // after UseRouting / UseCors if you call them explicitly

app.MapGet("/catalog", (CatalogService c) => c.GetAll()).CacheOutput("catalog");
app.MapGet("/search", Search).CacheOutput(p => p.SetVaryByQuery("q", "page"));

await outputCacheStore.EvictByTagAsync("catalog", ct);   // after publishing a change
```

The **default policy is deliberately conservative**. It caches only `GET`/`HEAD` requests that
return `200` (for 60 seconds unless you say otherwise), and it **doesn't cache authenticated
requests (an `Authorization` header or a signed-in user) or responses that set cookies**. This
protects you from caching one user's private response for everyone. The cache key is the full
URL by default; `SetVaryByQuery` restricts it to the query parameters that actually change the
answer, so `?utm_source=…` doesn't create a new entry per campaign.
Override it only for data that's identical for every caller. For several pods, store the cache
in Redis with `AddStackExchangeRedisOutputCache`, so evictions apply everywhere.

:::info title="Output caching vs. response caching"
The older **response caching** middleware (`UseResponseCaching`) follows HTTP cache headers, so
the *client* can bypass it with `Cache-Control: no-cache`. **Output caching** is controlled by
the *server*, supports tags and eviction, and is the one to use for API endpoints. Browser and
CDN caching via `Cache-Control` and `ETag` is a third, independent layer.
:::

### HTTP caching: let browsers and CDNs do the work

The cheapest request is the one that never reaches your API. `Cache-Control` tells browsers, CDNs and
proxies what they may keep, and for how long:

| Header value | Meaning | Typical use |
|---|---|---|
| `no-store` | Never store this anywhere | Anything personal or sensitive: `/me`, tokens, documents behind auth |
| `private, max-age=60` | Only the user's own browser may cache it, for 60 s | Per-user data that's fine to reuse briefly |
| `public, max-age=300` | Any cache (CDN included) may serve it for 5 minutes | Public catalogs, feature flags, public config |
| `no-cache` + `ETag` | Store it, but **revalidate** every time: `If-None-Match` → `304 Not Modified` with no body | Data that must be fresh but is often unchanged |
| `public, max-age=31536000, immutable` | Cache "forever" | Fingerprinted static files (`app.3f9a1c.js`) |

```csharp
app.MapGet("/catalog", (CatalogService c, HttpContext http) =>
{
    http.Response.GetTypedHeaders().CacheControl = new() { Public = true, MaxAge = TimeSpan.FromMinutes(5) };
    return c.GetAll();
});
```

ASP.NET Core sets **no** `Cache-Control` on API responses by default, and without one, caches may apply
their own heuristics. For authenticated APIs, send `no-store` (or `private`) explicitly, for example from a
small middleware or an endpoint filter on the authenticated route group. The worst caching bug is a CDN
serving one user's `/me` response to another user. `ETag`/`If-None-Match` is the read-side twin of the
`If-Match` concurrency check from be-18: the same version, used to save bandwidth instead of preventing
lost updates.

:::quiz id=be-20-q8 xp=10
`GET /me/projects` returns the signed-in user's projects. A CDN sits in front of the API. Which `Cache-Control` value is right?

- [ ] `public, max-age=300`, because it makes the dashboard fast
- [x] `no-store` (or at most `private, max-age=…`), so no shared cache ever keeps one user's response
- [ ] None. Leaving the header out is the safest option
- [ ] `immutable`, because a user's project list rarely changes
> `public` allows the CDN to serve Alice's projects to Bob for five minutes. That's a data leak, not a performance win. `private` limits caching to the user's own browser, and `no-store` forbids caching entirely. Leaving the header out isn't safe, because caches may then apply their own heuristics. `immutable` is for fingerprinted static files that never change at that URL.
:::

### Response compression

JSON compresses 5–10x. `AddResponseCompression` with Brotli and Gzip reduces bandwidth, but it
costs CPU on your API pods. In most deployments, the **reverse proxy, ingress or CDN compresses**
instead. That's cheaper and keeps the app simple. If you compress in Kestrel:

- Keep `Level = CompressionLevel.Fastest` (the default). "Optimal" Brotli can cost more CPU than
  the bandwidth it saves.
- Compressing over HTTPS (`EnableForHttps = true`) opens the door to **BREACH**-style attacks
  when a response contains a secret, such as a CSRF token, next to attacker-controlled input.
  Plain JSON API responses without secrets are usually fine. Know the trade-off.
- Don't compress already-compressed content (images, video, zip).

:::quiz id=be-20-q4 xp=15
After you add `.CacheOutput()` to `GET /me/projects`, a log line in the handler shows it still
runs on every request in production. Locally, testing with plain `curl` (no token), caching
works. Why?

- [ ] Output caching only works in Development
- [x] Production requests carry `Authorization: Bearer ...`, and the default output-cache policy never caches authenticated requests
- [ ] The response is too large to cache
- [ ] `UseOutputCache` must come before `UseAuthentication`
> That's the safe default doing its job. `/me/projects` differs per user, so it should **not** be output-cached under one key. If you really need it, write a policy that varies by the user id. Usually a per-user data cache entry (or nothing) is the better choice. Middleware order isn't the cause: the default policy looks at the request itself, and output caching works in every environment.
:::

:::challenge id=be-20-c1 lang=ts xp=50
title: Stampede protection (single-flight)
`HybridCache` guarantees that concurrent misses for the same key run the factory **once**. The
technique is called **single-flight**: keep a map of in-flight promises, and let every caller for
the same key await the same promise.

Implement `createSingleFlight()`, which returns `run(key, fn)`:

- Concurrent `run` calls with the same key call `fn` **once**, and all of them get its result.
- Different keys run independently.
- Once the promise settles (resolves **or** rejects), the key is forgotten, so a later call runs `fn` again.
- If `fn` rejects, every waiting caller gets the rejection. Errors must **not** be cached.

hint: `const inflight = new Map<string, Promise<unknown>>()`
hint: Store the promise *before* awaiting it, then remove it in `.finally(...)`.
hint: Only delete the entry if it's still the same promise you stored.

```ts starter
export function createSingleFlight() {
  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return fn()
  }
}
```

```ts solution
export function createSingleFlight() {
  const inflight = new Map<string, Promise<unknown>>()
  return function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key)
    if (existing) return existing as Promise<T>
    const p = fn().finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
    inflight.set(key, p)
    return p
  }
}
```

```ts tests
test('concurrent calls for one key run fn once', async () => {
  const run = createSingleFlight()
  let calls = 0
  const slow = async () => { calls++; await sleep(20); return 42 }
  const results = await Promise.all([run('a', slow), run('a', slow), run('a', slow), run('a', slow)])
  expect(results).toEqual([42, 42, 42, 42])
  expect(calls).toBe(1)
})
test('different keys run independently', async () => {
  const run = createSingleFlight()
  let calls = 0
  const f = async () => { calls++; await sleep(5); return calls }
  await Promise.all([run('a', f), run('b', f)])
  expect(calls).toBe(2)
})
test('after settling, the next call runs again', async () => {
  const run = createSingleFlight()
  let calls = 0
  const f = async () => { calls++; return calls }
  expect(await run('k', f)).toBe(1)
  expect(await run('k', f)).toBe(2)
})
test('rejections are shared and not cached', async () => {
  const run = createSingleFlight()
  let calls = 0
  const boom = async () => { calls++; await sleep(5); throw new Error('db down') }
  const a = run('k', boom)
  const b = run('k', boom)
  await expect(a).rejects.toThrow('db down')
  await expect(b).rejects.toThrow('db down')
  expect(calls).toBe(1)
  expect(await run('k', async () => 'recovered')).toBe('recovered')
})
```
:::

## Pagination: offset vs. keyset

Every list endpoint needs a limit. The question is how clients get page 2.

**Offset pagination** (`?page=500&size=20` → `ORDER BY created_at DESC OFFSET 9980 LIMIT 20`)
is easy and lets users jump to any page. But:

- **It gets slower the deeper you go.** Postgres still has to produce and throw away the 9,980
  rows before the ones you asked for. Page 1 takes 1 ms, page 5,000 takes 400 ms.
- **It's unstable under writes.** If a new row arrives between page 1 and page 2, every row
  shifts down by one, and the client sees the last item of page 1 again at the top of page 2.
  A deleted row makes the client miss one instead.

**Keyset (cursor) pagination** remembers *where you stopped* rather than *how many you skipped*:

```sql
-- page 1
SELECT id, title, created_at FROM documents
 WHERE project_id = $1
 ORDER BY created_at DESC, id DESC
 LIMIT 21;                               -- one extra row tells you whether there's a next page

-- next page: continue strictly after the last row (created_at, id) of the previous page
SELECT id, title, created_at FROM documents
 WHERE project_id = $1
   AND (created_at, id) < ($2, $3)       -- row-value comparison, uses the index
 ORDER BY created_at DESC, id DESC
 LIMIT 21;

CREATE INDEX ix_documents_project_created ON documents (project_id, created_at DESC, id DESC);
```

Every page costs the same: an index seek plus 21 rows. Inserts and deletes elsewhere don't
shift anything. The trade-off is that there's no "jump to page 37". That's fine for feeds,
infinite scroll, sync APIs and exports, which covers most API use.

The tie-breaker (`id`) matters. Without it, rows with the same `created_at` can appear on
two pages or on none. In EF Core with Npgsql:

```csharp
var q = db.Documents.AsNoTracking().Where(d => d.ProjectId == projectId);
if (cursor is { } c)
    q = q.Where(d => EF.Functions.LessThan(
        ValueTuple.Create(d.CreatedAt, d.Id), ValueTuple.Create(c.CreatedAt, c.Id)));
    // translates to: WHERE (d.created_at, d.id) < (@c, @cid)

var rows = await q.OrderByDescending(d => d.CreatedAt).ThenByDescending(d => d.Id)
    .Take(limit + 1)
    .Select(d => new DocumentListItem(d.Id, d.Title, d.CreatedAt))
    .ToListAsync(ct);

var hasMore = rows.Count > limit;
var page = rows.Take(limit).ToList();
string? next = hasMore ? Cursor.Encode(page[^1].CreatedAt, page[^1].Id) : null;
return new Page<DocumentListItem>(page, next);   // { "items": [...], "nextCursor": "MjAyNi0..." }
```

Make the cursor **opaque**, for example base64url of `createdAt|id`. Clients pass it back
without parsing it, and you can change its contents later. Avoid `COUNT(*)` totals on big
tables: an exact count is a full scan. Return `nextCursor` and, if the UI needs one, an
estimate (Postgres keeps one in `pg_class.reltuples`). With UUID v7 ids (`Guid.CreateVersion7()`
in .NET, `uuidv7()` in PostgreSQL 18), the id itself is time-ordered and unique, so
`ORDER BY id` alone is a valid keyset.

:::sql id=be-20-sql1 db=shop ordered=true xp=30
title: Keyset page 2, newest first
The orders list shows 5 orders per page, newest first (`ordered_at DESC, id DESC`). Page 1
ended at order **14** (`ordered_at = '2025-05-20 09:30:00'`). Since then, two **new** orders
arrived (the setup inserted them). The starter uses `OFFSET 5`, so the user sees orders from page 1
again.

Return page 2 (`id`, `ordered_at`) using **keyset pagination**: the 5 orders strictly after
`('2025-05-20 09:30:00', 14)` in the list order.

hint: `WHERE (ordered_at, id) < ('2025-05-20 09:30:00', 14)`
hint: Keep the same `ORDER BY ordered_at DESC, id DESC` and `LIMIT 5`.

```sql setup
INSERT INTO orders (id, customer_id, status, ordered_at) VALUES
  (19, 2, 'pending', '2025-07-05 10:00:00'),
  (20, 4, 'pending', '2025-07-06 11:30:00');
```

```sql starter
SELECT id, ordered_at
FROM orders
ORDER BY ordered_at DESC, id DESC
LIMIT 5 OFFSET 5;
```

```sql solution
SELECT id, ordered_at
FROM orders
WHERE (ordered_at, id) < ('2025-05-20 09:30:00', 14)
ORDER BY ordered_at DESC, id DESC
LIMIT 5;
```
:::

:::challenge id=be-20-c2 lang=ts xp=50
title: Cursor pagination that survives inserts
`page(all, cursor, limit)` returns one page of `items`, newest first (by `createdAt` descending,
then `id` descending), plus a `nextCursor` (or `null` on the last page). Clients call it again with
`nextCursor`.

The starter uses **offset** pagination hidden in the cursor. Its pages repeat items when new ones
arrive between calls. Rewrite it as **keyset** pagination:

- The cursor encodes the **last item** of the page, as `"<createdAt>|<id>"`.
- The next page has the items strictly **after** that position in the sort order (for a
  descending order, that means smaller `(createdAt, id)`).
- `nextCursor` is `null` when there are no more items.

`createdAt` values are ISO strings, so they compare correctly as strings.

hint: Sort a copy: `(a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id`
hint: "After" the cursor means `x.createdAt < c.createdAt || (x.createdAt === c.createdAt && x.id < c.id)`.
hint: Take `limit + 1` items to know whether there's a next page.

```ts starter
export type Item = { id: number; createdAt: string }

export function page(all: Item[], cursor: string | null, limit: number) {
  const sorted = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  const offset = cursor ? Number(cursor) : 0
  const items = sorted.slice(offset, offset + limit)
  const nextCursor = offset + limit < sorted.length ? String(offset + limit) : null
  return { items, nextCursor }
}
```

```ts solution
export type Item = { id: number; createdAt: string }

export function page(all: Item[], cursor: string | null, limit: number) {
  const sorted = [...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
  let rest = sorted
  if (cursor) {
    const sep = cursor.lastIndexOf('|')
    const cAt = cursor.slice(0, sep)
    const cId = Number(cursor.slice(sep + 1))
    rest = sorted.filter((x) => x.createdAt < cAt || (x.createdAt === cAt && x.id < cId))
  }
  const window = rest.slice(0, limit + 1)
  const items = window.slice(0, limit)
  const last = items[items.length - 1]
  const nextCursor = window.length > limit && last ? `${last.createdAt}|${last.id}` : null
  return { items, nextCursor }
}
```

```ts tests
const mk = (id: number, day: number) => ({ id, createdAt: `2026-01-${String(day).padStart(2, '0')}T10:00:00Z` })
const data = () => [mk(1, 1), mk(2, 2), mk(3, 3), mk(4, 3), mk(5, 4), mk(6, 5), mk(7, 6)]

test('walking all pages returns every item once, newest first', () => {
  const all = data()
  const seen: number[] = []
  let cursor: string | null = null
  let guard = 0
  do {
    const p = page(all, cursor, 3)
    seen.push(...p.items.map((i) => i.id))
    cursor = p.nextCursor
  } while (cursor && ++guard < 10)
  expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1])
})
test('the last page has nextCursor null', () => {
  const p = page(data(), null, 10)
  expect(p.items).toHaveLength(7)
  expect(p.nextCursor).toBeNull()
})
test('a new item arriving between pages causes no duplicates', () => {
  const all = data()
  const p1 = page(all, null, 3)
  all.push(mk(8, 9))                         // newer than everything
  const p2 = page(all, p1.nextCursor, 3)
  const ids1 = p1.items.map((i) => i.id)
  const ids2 = p2.items.map((i) => i.id)
  expect(ids1).toEqual([7, 6, 5])
  expect(ids2).toEqual([4, 3, 2])
})
test('ties on createdAt are split by id', () => {
  const p1 = page(data(), null, 4)
  expect(p1.items.map((i) => i.id)).toEqual([7, 6, 5, 4])
  const p2 = page(data(), p1.nextCursor, 4)
  expect(p2.items.map((i) => i.id)).toEqual([3, 2, 1])
})
```
:::

## Streaming large responses

`ToListAsync()` on 500,000 rows loads all of them, plus their serialized JSON, into memory
before the first byte goes out. That means huge LOH allocations and a slow time-to-first-byte,
and a few concurrent exports can take the pod down with an OOM kill.

Return an `IAsyncEnumerable<T>` instead. System.Text.Json writes the JSON array element by
element while EF Core reads rows from the socket:

```csharp
app.MapGet("/projects/{id:guid}/export", (Guid id, AppDbContext db) =>
    db.Documents.AsNoTracking()
        .Where(d => d.ProjectId == id)
        .OrderBy(d => d.Id)
        .Select(d => new ExportRow(d.Id, d.Title, d.Version))
        .AsAsyncEnumerable());                 // streamed, memory stays flat
```

For CSV or other formats, write to the response yourself:

```csharp
app.MapGet("/projects/{id:guid}/export.csv", async (Guid id, AppDbContext db, HttpResponse res,
    CancellationToken ct) =>
{
    res.ContentType = "text/csv";
    await using var writer = new StreamWriter(res.Body);
    await foreach (var d in db.Documents.AsNoTracking().Where(d => d.ProjectId == id)
                              .Select(d => new { d.Id, d.Title }).AsAsyncEnumerable().WithCancellation(ct))
        await writer.WriteLineAsync($"{d.Id},\"{d.Title.Replace("\"", "\"\"")}\"");
});
```

Know the costs:

- **The status code is sent with the first byte.** If the query fails halfway through, the client
  gets a truncated `200`, not a `500`. Validate and authorize *before* you start streaming.
- **The connection is held for the whole stream.** A 3-minute export keeps one pooled database
  connection busy for 3 minutes. For very large exports, run a background job that writes a file
  to object storage and gives the client a download link (lesson be-16).
- `AsNoTracking()` is essential. Tracking 500,000 entities defeats the purpose.

## Async pitfalls that hurt throughput

ASP.NET Core serves many requests with a small thread pool. Async code gives a thread back
while it waits for I/O. Anything that **blocks** a thread instead takes away capacity from
every other request.

**Sync-over-async** is the classic one: `.Result`, `.Wait()` or `.GetAwaiter().GetResult()` on
a task in request code. Each blocked request holds a thread doing nothing. Under load the pool
runs out, new work queues up, and the pool adds threads slowly (roughly one or two per second).
Latency explodes while the CPU sits idle. That's **thread pool starvation**, and the sign of it
in `dotnet-counters` is a growing thread pool queue length.

| Pitfall | What goes wrong | Fix |
|---|---|---|
| `.Result` / `.Wait()` | Thread pool starvation under load | `await` all the way up |
| `Task.Run(() => DoDbWork())` in a handler | Uses two threads instead of one, no gain | Just `await` the async API |
| `async void` methods | Exceptions crash the process, and nobody can await them | `async Task`. `async void` only for event handlers. |
| `Task.WhenAll` over the **same** `DbContext` | `InvalidOperationException: A second operation was started on this context instance...` | Run them in sequence, or use one context per parallel branch (`IDbContextFactory`) |
| Fire-and-forget `_ = SendEmailAsync(...)` using scoped services | `ObjectDisposedException` once the request ends, and lost work on shutdown | A durable job or `Channel` + `BackgroundService` (lesson be-16) |
| Not passing `CancellationToken` | Work continues after the client has gone | Accept `CancellationToken ct` in handlers and pass it everywhere |
| Awaiting a `ValueTask` twice | Undefined behaviour | Await once, or call `.AsTask()` |

`ConfigureAwait(false)` is **not** needed in ASP.NET Core application code, because there is no
`SynchronizationContext` to return to. It still makes sense in general-purpose libraries.

:::quiz id=be-20-q5 xp=15
Under a load test, p99 latency goes from 80 ms to 12 s, CPU stays at 15 %, and `dotnet-counters`
shows the thread pool queue length climbing into the thousands. Which line is the most likely cause?

- [ ] `await db.Projects.AsNoTracking().ToListAsync(ct);`
- [x] `var user = _userService.GetUserAsync(id).Result;`
- [ ] `await Task.Delay(10, ct);`
- [ ] `return TypedResults.Ok(dto);`
> Low CPU, high latency and a growing queue is textbook thread pool starvation. `.Result` blocks a pool thread for as long as the I/O takes. With hundreds of concurrent requests doing that, no threads are left to run the continuations that would unblock them. The fix is `await`. The other lines all `await` or return synchronously without waiting: `Task.Delay` frees the thread while it waits, so it can't starve the pool.
:::

:::quiz id=be-20-q6 xp=15
What happens here?

```csharp
app.MapGet("/projects/{id:guid}/dashboard", async (Guid id, AppDbContext db, CancellationToken ct) =>
{
    var docs    = db.Documents.CountAsync(d => d.ProjectId == id, ct);
    var members = db.ProjectMembers.CountAsync(m => m.ProjectId == id, ct);
    await Task.WhenAll(docs, members);
    return new { documents = docs.Result, members = members.Result };
});
```

- [ ] Both queries run in parallel on one connection, which is faster
- [ ] It works, but `.Result` causes thread pool starvation
- [x] It throws (or fails intermittently) with "A second operation was started on this context instance before a previous operation completed". A `DbContext` isn't thread-safe and supports one operation at a time.
- [ ] EF Core automatically batches the two counts into one round trip
> A `DbContext` wraps one connection and one change tracker, so concurrent operations on it are a bug. Await the queries one after the other (two fast queries are fine), combine them into one query, or create separate contexts with `IDbContextFactory<AppDbContext>` when you really need parallelism. (`.Result` after `WhenAll` doesn't block, because the tasks are already complete. That's not the bug.)
:::

## Connection pooling

Opening a real Postgres connection means a TCP and TLS handshake, authentication and a new
backend *process* on the server. That takes milliseconds and costs megabytes on the server. So
Npgsql keeps a **pool** per connection string. `OpenAsync` rents an open connection, and
`Dispose` returns it. Defaults: `Minimum Pool Size=0`, `Maximum Pool Size=100`.

The arithmetic people forget:

```text
pods × Maximum Pool Size  must stay below  Postgres max_connections (default 100) − reserved slots

10 pods × 100 = 1,000 possible connections  →  "sorry, too many clients already" (53300)
```

And when a pod's own pool is exhausted, requests wait for `Timeout` (15 s by default) and then
fail with *"The connection pool has been exhausted, either raise 'Max Pool Size' ... or 'Timeout'"*.
Raising the limit is rarely the fix. Find out why connections are held so long:

- **Long transactions**, or holding a connection across slow non-database work (an HTTP call
  inside a transaction).
- **Streaming responses** that keep a connection for minutes.
- **Leaked connections**: an `NpgsqlConnection` that isn't disposed.
- **Thread pool starvation**: the connection is free, but the code that should return it can't run.

Tools for scaling:

- **Size pools on purpose.** For example `Maximum Pool Size=20` per pod, chosen from measured
  concurrency, not the default.
- **PgBouncer** (or a managed pooler) multiplexes thousands of client connections onto a few
  server connections. In **transaction mode**, session state doesn't survive between
  transactions: no session `SET`, no session advisory locks, no `LISTEN`. Prepared statements
  need PgBouncer 1.21+ (`max_prepared_statements`). Use `No Reset On Close=true` in the Npgsql
  connection string.
- **`AddDbContextPool<AppDbContext>`** reuses *DbContext instances*, not connections. Connections
  are already pooled. It saves the allocation and setup cost of a context per request, which
  matters at high request rates. Don't keep per-request state in fields of a pooled context.
- **`NpgsqlDataSource`** (`builder.Services.AddNpgsqlDataSource(connString)` from
  `Npgsql.DependencyInjection`) is the modern way to configure the pool, logging and type
  mappings once for raw ADO.NET and EF Core (`UseNpgsql(dataSource)`).

:::info title="HttpClient has a pool too"
`new HttpClient()` per request exhausts sockets (TIME_WAIT). A single static `HttpClient` with
default settings never picks up DNS changes. `IHttpClientFactory` (lesson be-19) handles both: it
pools handlers and replaces them every `HandlerLifetime` (2 minutes by default).
:::

:::quiz id=be-20-q7 xp=20
Black Friday. Your API runs 4 pods with the default Npgsql pool. Postgres has `max_connections = 100`.
The autoscaler adds 6 more pods, and suddenly *new* pods fail health checks with
`53300: sorry, too many clients already` while old pods are fine. What's the root cause, and what's
the best fix? (Select all that apply.)

- [x] 10 pods × up to 100 pooled connections can far exceed `max_connections`. The pods that started first already hold the connection slots.
- [x] Set an explicit, smaller `Maximum Pool Size` per pod, sized so pods × pool stays under the limit, and/or put PgBouncer in front of Postgres
- [ ] Raise `max_connections` to 10,000
- [ ] Switch every query to `AsNoTracking()`
> Each Postgres connection is a backend process with its own memory, so thousands of them make the database slower, not faster. Budget connections across replicas (and remember the migration job, the workers and the admin tools) or multiplex with a pooler. `AsNoTracking()` saves memory and CPU in EF Core but uses exactly the same connection. Also check *why* pods need so many connections. Usually it's long transactions or slow requests holding them.
:::

## Labs

:::lab id=be-20-lab1 xp=150
title: Make the slow endpoints fast — HybridCache, output cache, streaming, compression

You'll build a small API with a deliberately slow statistics service, a public catalog and a
50,000-row export. Then you'll prove with tests that:

- stats are computed **once** even when 50 requests arrive at the same moment (stampede protection),
- invalidating by **tag** forces a recompute,
- the catalog is **output-cached**, evicted by tag, and **never** cached for authenticated requests,
- the export is **streamed** (rows reach the client while later rows are still being produced) and
  **compressed** with Brotli.

**1. Scaffold the solution**

```bash
mkdir -p ~/devquest/be-20-lab1 && cd ~/devquest/be-20-lab1
dotnet new sln -n Perf
dotnet new web -o src/Perf.Api
dotnet new xunit -o tests/Perf.Api.Tests
dotnet sln add src/Perf.Api tests/Perf.Api.Tests
dotnet add tests/Perf.Api.Tests reference src/Perf.Api

dotnet add src/Perf.Api package Microsoft.Extensions.Caching.Hybrid
dotnet add tests/Perf.Api.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet add tests/Perf.Api.Tests package Shouldly
rm tests/Perf.Api.Tests/UnitTest1.cs
```

**2. The slow services.** Create `src/Perf.Api/SlowServices.cs`:

```csharp
namespace Perf.Api;

public record ProjectStats(Guid ProjectId, int Documents, int Words, DateTimeOffset ComputedAt);
public record CatalogItem(int Id, string Name, decimal Price);
public record ExportRow(int Id, string Name, string Email);

/// Pretends to be an expensive aggregate query (think: COUNT + SUM over 2M rows).
public class ProjectStatsService(TimeProvider time)
{
    private int _calls;
    public int Calls => Volatile.Read(ref _calls);

    public async Task<ProjectStats> ComputeAsync(Guid projectId, CancellationToken ct)
    {
        Interlocked.Increment(ref _calls);
        await Task.Delay(200, ct);                       // the "slow query"
        return new ProjectStats(projectId, 42, 12_345, time.GetUtcNow());
    }
}

/// Public, identical-for-everyone data: perfect for output caching.
public class CatalogService
{
    private int _calls;
    public int Calls => Volatile.Read(ref _calls);

    public IReadOnlyList<CatalogItem> GetAll()
    {
        Interlocked.Increment(ref _calls);
        return [new(1, "Free", 0m), new(2, "Pro", 12m), new(3, "Team", 49m)];
    }
}

public static class ExportSource
{
    private static long _produced;
    /// Total rows produced so far (lets the tests see WHEN rows are produced).
    public static long Produced => Interlocked.Read(ref _produced);

    /// Rows arrive one by one, like EF Core's AsAsyncEnumerable() over a big table.
    public static async IAsyncEnumerable<ExportRow> ReadAllAsync(int count,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct = default)
    {
        for (var i = 1; i <= count; i++)
        {
            if (i % 500 == 0) await Task.Delay(1, ct);   // simulate waiting on the database
            Interlocked.Increment(ref _produced);
            yield return new ExportRow(i, $"User {i}", $"user{i}@example.com");
        }
    }
}
```

**3. The API.** Replace `src/Perf.Api/Program.cs`:

```csharp
using Microsoft.AspNetCore.OutputCaching;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.Extensions.Caching.Hybrid;
using Perf.Api;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<ProjectStatsService>();
builder.Services.AddSingleton<CatalogService>();

// L1 (in-process) cache with stampede protection. Add a Redis IDistributedCache and it becomes L2 too.
builder.Services.AddHybridCache(o =>
{
    o.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),          // L2 (distributed) lifetime
        LocalCacheExpiration = TimeSpan.FromMinutes(1) // L1 (this process) lifetime
    };
});

builder.Services.AddOutputCache(o =>
{
    o.AddPolicy("catalog", p => p.Expire(TimeSpan.FromSeconds(60)).Tag("catalog"));
});

builder.Services.AddResponseCompression(o =>
{
    o.EnableForHttps = true;   // OK here: no secrets reflected next to user input (BREACH)
    o.Providers.Add<BrotliCompressionProvider>();
    o.Providers.Add<GzipCompressionProvider>();
});

var app = builder.Build();

app.UseResponseCompression();
app.UseOutputCache();

// ── 1. Data cache: per-project stats ──
app.MapGet("/projects/{id:guid}/stats", async (Guid id, HybridCache cache, ProjectStatsService stats,
    CancellationToken ct) =>
{
    var result = await cache.GetOrCreateAsync(
        $"project-stats:{id}",                                   // key: unique per input
        async token => await stats.ComputeAsync(id, token),      // factory: runs ONCE per key on a miss
        tags: [$"project:{id}"],                                 // for group invalidation
        cancellationToken: ct);
    return TypedResults.Ok(result);
});

// Something changed in the project → drop everything cached for it.
app.MapPost("/projects/{id:guid}/changed", async (Guid id, HybridCache cache, CancellationToken ct) =>
{
    await cache.RemoveByTagAsync($"project:{id}", ct);
    return TypedResults.NoContent();
});

// ── 2. Output cache: the whole HTTP response for public data ──
app.MapGet("/catalog", (CatalogService catalog) => TypedResults.Ok(catalog.GetAll()))
   .CacheOutput("catalog");

app.MapPost("/catalog/publish", async (IOutputCacheStore store, CancellationToken ct) =>
{
    await store.EvictByTagAsync("catalog", ct);
    return TypedResults.NoContent();
});

// ── 3. Streaming: 50k rows without ever holding them all in memory ──
app.MapGet("/export", (CancellationToken ct) => ExportSource.ReadAllAsync(50_000, ct));

app.Run();
```

**4. Try it by hand**

```bash
dotnet run --project src/Perf.Api --urls http://localhost:5199
```

In a second terminal:

```bash
U=http://localhost:5199/projects/7d1c6f3e-0000-0000-0000-000000000001/stats
curl -s -o /dev/null -w "%{time_total}\n" $U      # first call: ~0.2 s (the slow service)
curl -s -o /dev/null -w "%{time_total}\n" $U      # second call: ~0.001 s (cache hit)
curl -s -D - -o /dev/null -H "Accept-Encoding: br" http://localhost:5199/export
curl -s -D - -o /dev/null http://localhost:5199/catalog | grep -i age   # first call: prints nothing
curl -s -D - -o /dev/null http://localhost:5199/catalog | grep -i age   # second call: Age: 0
```

Expected (timings and dates vary):

```text
0.283393
0.001476
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Date: Thu, 05 Nov 2026 15:48:53 GMT
Server: Kestrel
Content-Encoding: br
Transfer-Encoding: chunked
Vary: Accept-Encoding

Age: 0
```

The `/export` response is compressed (`Content-Encoding: br`) and sent with `Transfer-Encoding:
chunked`. Only the **second** `/catalog` response carries an `Age:` header (seconds since the
entry was stored), which means it came from the output cache.

A missing `Content-Length` alone doesn't prove streaming, because minimal APIs write any JSON
result chunked. The test proves it properly: it checks that the **first row reaches the client
while the server is still producing rows**. `ExportSource.Produced` counts the rows created so far.

**5. The tests.** Create `tests/Perf.Api.Tests/PerfTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Perf.Api;
using Shouldly;

namespace Perf.Api.Tests;

public class PerfTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private ProjectStatsService Stats => factory.Services.GetRequiredService<ProjectStatsService>();
    private CatalogService Catalog => factory.Services.GetRequiredService<CatalogService>();

    [Fact]
    public async Task A_cache_hit_does_not_call_the_slow_service()
    {
        var client = factory.CreateClient();
        var id = Guid.NewGuid();
        var before = Stats.Calls;

        var first = await client.GetFromJsonAsync<ProjectStats>($"/projects/{id}/stats");
        var second = await client.GetFromJsonAsync<ProjectStats>($"/projects/{id}/stats");

        (Stats.Calls - before).ShouldBe(1);
        second!.ComputedAt.ShouldBe(first!.ComputedAt);
    }

    [Fact]
    public async Task Fifty_concurrent_misses_compute_once_stampede_protection()
    {
        var client = factory.CreateClient();
        var id = Guid.NewGuid();
        var before = Stats.Calls;

        var responses = await Task.WhenAll(
            Enumerable.Range(0, 50).Select(_ => client.GetAsync($"/projects/{id}/stats")));

        responses.ShouldAllBe(r => r.StatusCode == HttpStatusCode.OK);
        (Stats.Calls - before).ShouldBe(1);
    }

    [Fact]
    public async Task Invalidating_by_tag_forces_a_recompute()
    {
        var client = factory.CreateClient();
        var id = Guid.NewGuid();
        var before = Stats.Calls;

        await client.GetAsync($"/projects/{id}/stats");
        (await client.PostAsync($"/projects/{id}/changed", null)).StatusCode.ShouldBe(HttpStatusCode.NoContent);
        await client.GetAsync($"/projects/{id}/stats");

        (Stats.Calls - before).ShouldBe(2);
    }

    [Fact]
    public async Task Output_cache_serves_repeat_requests_and_evicts_by_tag()
    {
        var client = factory.CreateClient();
        await client.PostAsync("/catalog/publish", null);           // start from an empty cache entry
        var before = Catalog.Calls;

        await client.GetAsync("/catalog");
        await client.GetAsync("/catalog");
        (Catalog.Calls - before).ShouldBe(1);

        await client.PostAsync("/catalog/publish", null);
        await client.GetAsync("/catalog");
        (Catalog.Calls - before).ShouldBe(2);
    }

    [Fact]
    public async Task Output_cache_never_caches_authenticated_requests_by_default()
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "anything");
        var before = Catalog.Calls;

        await client.GetAsync("/catalog");
        await client.GetAsync("/catalog");

        (Catalog.Calls - before).ShouldBe(2);
    }

    [Fact]
    public async Task Export_is_streamed_while_rows_are_still_being_produced()
    {
        var client = factory.CreateClient();
        var before = ExportSource.Produced;
        using var res = await client.GetAsync("/export", HttpCompletionOption.ResponseHeadersRead);
        await using var body = await res.Content.ReadAsStreamAsync();

        long producedWhenFirstRowArrived = -1;
        var count = 0;
        await foreach (var row in JsonSerializer.DeserializeAsyncEnumerable<ExportRow>(body, JsonSerializerOptions.Web))
        {
            if (count++ == 0) producedWhenFirstRowArrived = ExportSource.Produced - before;
        }

        count.ShouldBe(50_000);
        // Buffered (ToListAsync) would only send the first byte after ALL 50,000 rows exist.
        producedWhenFirstRowArrived.ShouldBeLessThan(50_000);
    }

    [Fact]
    public async Task Responses_are_compressed_when_the_client_asks()
    {
        var client = factory.CreateClient();
        var req = new HttpRequestMessage(HttpMethod.Get, "/export");
        req.Headers.AcceptEncoding.ParseAdd("br");

        using var res = await client.SendAsync(req);   // reads the whole (compressed) body

        res.Content.Headers.ContentEncoding.ShouldContain("br");
    }
}
```

```bash
dotnet test
```

Expected:

```text
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7
```

**6. Break it on purpose**, so you have seen each protection work:

1. Replace the `HybridCache` call in `/projects/{id}/stats` with
   `IMemoryCache.GetOrCreateAsync` (inject `IMemoryCache cache`, add
   `using Microsoft.Extensions.Caching.Memory;` for the extension method, and write
   `await cache.GetOrCreateAsync($"project-stats:{id}", _ => stats.ComputeAsync(id, ct))`).
   `AddHybridCache` already registers `IMemoryCache`. Run the tests:
   `Fifty_concurrent_misses_compute_once_stampede_protection` fails with **50** calls instead of 1,
   and the tag test fails because `IMemoryCache` has no tags. Undo.
2. Remove `.CacheOutput("catalog")`. The output-cache test fails. Undo.
3. Change `/export` to `async (CancellationToken ct) => await ExportSource.ReadAllAsync(50_000, ct).ToListAsync(ct)`
   (`System.Linq.AsyncEnumerable` is built into .NET 10). The streaming test fails with
   `50000`: the first row only reached the client after all rows were in memory. Undo.

:::tip title="Add Redis as L2 in one line"
`dotnet add src/Perf.Api package Microsoft.Extensions.Caching.StackExchangeRedis`, then
`builder.Services.AddStackExchangeRedisCache(o => o.Configuration = "localhost:6379");` before
`AddHybridCache`. HybridCache detects the `IDistributedCache` and uses it as L2. Start Redis with
`docker run -d -p 6379:6379 redis:8-alpine`, call `/stats`, restart the API and call it again:
the `computedAt` value is unchanged, because the new process found the entry in L2.
:::

- [ ] `dotnet test` shows 7 passing tests
- [ ] I saw the first stats call take ~200 ms and the second ~1 ms
- [ ] With `IMemoryCache` instead of `HybridCache`, the stampede test reported 50 calls
- [ ] I can explain why `/catalog` is never cached for requests with an `Authorization` header
- [ ] The `/export` response is chunked and Brotli-compressed
:::

:::lab id=be-20-lab2 xp=80
title: Measure, don't guess — BenchmarkDotNet

Four ways to count the words in a document. Which is fastest, and which allocates? Write down
your guess **before** you run it.

**1. Create the project**

```bash
mkdir -p ~/devquest/be-20-lab2 && cd ~/devquest/be-20-lab2
dotnet new console -o WordBench
cd WordBench
dotnet add package BenchmarkDotNet
```

**2. Replace `Program.cs`:**

```csharp
using System.Buffers;
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<WordCountBenchmarks>();

[MemoryDiagnoser]          // adds "Allocated" and GC columns — usually the most revealing ones
[ShortRunJob]              // fewer iterations: good enough for a lab, use the default job for real decisions
public class WordCountBenchmarks
{
    private string _text = "";

    [Params(100, 10_000)]  // words in the document
    public int Words;

    [GlobalSetup]
    public void Setup() =>
        _text = string.Join(' ', Enumerable.Range(0, Words).Select(i => $"word{i % 50}"));

    [Benchmark(Baseline = true)]
    public int Split() =>
        _text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;

    [Benchmark]
    public int Linq() =>
        _text.Split(' ').Where(w => w.Length > 0).Count();

    [Benchmark]
    public int Span()
    {
        var count = 0;
        var inWord = false;
        foreach (var c in _text.AsSpan())
        {
            if (char.IsWhiteSpace(c)) inWord = false;
            else if (!inWord) { inWord = true; count++; }
        }
        return count;
    }

    private static readonly SearchValues<char> Whitespace = SearchValues.Create(" \t\r\n");

    [Benchmark]
    public int SpanSearchValues()
    {
        var count = 0;
        var rest = _text.AsSpan();
        while (true)
        {
            rest = rest.TrimStart(" \t\r\n");
            if (rest.IsEmpty) return count;
            count++;
            var next = rest.IndexOfAny(Whitespace);
            if (next < 0) return count;
            rest = rest[next..];
        }
    }
}
```

**3. Run it in Release** (about a minute):

```bash
dotnet run -c Release
```

**4. Read the table.** One run on a Ryzen 7 with .NET 10 (your numbers will differ, but the
relationships should hold):

```text
| Method           | Words | Mean         | Ratio | Gen0    | Gen1    | Allocated | Alloc Ratio |
|----------------- |------ |-------------:|------:|--------:|--------:|----------:|------------:|
| Split            | 100   |   1,194.4 ns |  1.00 |  0.2785 |  0.0038 |    4664 B |        1.00 |
| Linq             | 100   |   1,015.1 ns |  0.85 |  0.2804 |  0.0038 |    4712 B |        1.01 |
| Span             | 100   |     263.2 ns |  0.22 |       - |       - |         - |        0.00 |
| SpanSearchValues | 100   |     559.0 ns |  0.47 |       - |       - |         - |        0.00 |
| Split            | 10000 | 124,662.0 ns |  1.00 | 27.5879 | 20.7520 |  464024 B |        1.00 |
| Linq             | 10000 | 102,929.7 ns |  0.83 | 27.7100 | 19.6533 |  464072 B |        1.00 |
| Span             | 10000 |  28,896.5 ns |  0.23 |       - |       - |         - |        0.00 |
| SpanSearchValues | 10000 |  56,004.1 ns |  0.45 |       - |       - |         - |        0.00 |
```

Things to notice:

- `Split` allocates **464 KB** for a 10,000-word document: a string per word plus the array.
  The span loop allocates **nothing** and is about 4x faster.
- The "clever" `SearchValues` version is **slower** than the simple loop here. Vectorized search
  pays off for long runs between matches, and these words are 5–6 characters long. This is
  exactly why you measure.
- At 10,000 words `Linq` (`Split(' ')`) usually beats `Split(null)`: splitting on one known
  character is cheaper than checking every char against all Unicode whitespace, even with LINQ
  on top. At 100 words the two can swap places between runs. Look at the **Error** and
  **StdDev** columns in your output (trimmed from the table above): with `[ShortRunJob]` they
  can be as large as the difference itself. A difference smaller than the error isn't a result.
- The **Gen1** column for 10,000 words means some of that garbage lived long enough to be
  promoted. On a busy server that turns into GC pauses.

**5. Your turn.** Add a `[Benchmark]` using `_text.AsSpan().Split(' ')` (the .NET 9+
`MemoryExtensions.Split` that yields `Range`s) and count the non-empty ranges: inside
`foreach (var r in span.Split(' '))`, `span[r]` is the word, so `if (!span[r].IsEmpty) count++`.
Predict where it lands (time **and** Allocated), then run it.

- [ ] The benchmark ran in Release and printed the summary table
- [ ] I wrote down my prediction before running, and compared it with the result
- [ ] I can explain why the `Allocated` column matters for a web server even if the time is small
- [ ] I added my own benchmark variant and measured it
:::

## Cheat sheet: the performance checklist

| Symptom | First things to check |
|---|---|
| One endpoint slow | Logged SQL (N+1? over-fetching? missing index?) → `EXPLAIN ANALYZE` (lesson db-17), then caching |
| Everything slow, CPU low | Thread pool starvation (sync-over-async), pool exhaustion, a slow dependency without a timeout |
| Everything slow, CPU high | `dotnet-trace` flame graph, allocation rate and GC time, exceptions per second |
| Memory grows until OOM kill | `dotnet-gcdump` diff of two snapshots, unbounded caches, buffering big responses, static lists |
| Slow only under load | Connection pools, locks and contention, cache stampedes, missing rate limits |
| Deep pages slow | Offset pagination → keyset |

:::job title="What you'll be asked to do"
"Make this endpoint faster" tickets usually come with a trace or a slow-query log. Teams expect
you to: reproduce it with numbers (before and after), fix the biggest cost first (almost always
a query or a missing cache), add a test or a benchmark so the problem can't quietly return, and
put the evidence in the PR. Being able to explain cache invalidation, keyset pagination and
thread pool starvation clearly is a common senior interview filter.
:::

## Flashcards

:::cards id=be-20-cards1 xp=20 title="Performance & caching"
Q: What does `[MemoryDiagnoser]` add to a BenchmarkDotNet run?
A: Allocated bytes per operation and GC collection counts (Gen0/1/2). Allocations become GC time under load.
Q: What's the signature of thread pool starvation?
A: Latency rises, CPU stays low, and the thread pool queue length grows. Usually caused by sync-over-async (`.Result`, `.Wait()`).
Q: What's a cache stampede?
A: A hot key expires and every concurrent request misses and recomputes it at once, overloading the database. HybridCache prevents it by running the factory once per key.
Q: HybridCache L1 vs L2?
A: L1 = in-process memory (fast, per pod). L2 = a registered IDistributedCache such as Redis (shared). `LocalCacheExpiration` limits how stale L1 can be.
Q: Why must authorization never run inside a cache factory?
A: The factory runs only on a miss. Later callers get the cached result without the check, which leaks data or wrongly denies it.
Q: What does the default output cache policy refuse to cache?
A: Non-GET/HEAD requests, non-200 responses, requests with an Authorization header, and responses that set cookies.
Q: Two problems with OFFSET pagination?
A: It gets slower the deeper the page (skipped rows are still read), and pages shift when rows are inserted or deleted (duplicates or gaps).
Q: Why does keyset pagination need a tie-breaker column?
A: Rows with equal sort values (same created_at) would otherwise be duplicated or skipped at page boundaries. Order by (created_at, id).
Q: Downside of streaming a response with IAsyncEnumerable?
A: The 200 status is already sent when an error happens mid-stream, and the DB connection is held for the whole stream.
Q: What does AddDbContextPool pool?
A: DbContext instances (saving setup and allocation cost). Database connections are pooled separately by Npgsql.
Q: The connection budget formula?
A: pods × Maximum Pool Size (+ workers, migration jobs, tools) must stay below Postgres max_connections. Otherwise use smaller pools or PgBouncer.
Q: Is ConfigureAwait(false) needed in ASP.NET Core app code?
A: No. There's no SynchronizationContext. It's still a good practice in reusable libraries.
:::

## Recap

- Define a target, **measure**, change one thing, and measure again. BenchmarkDotNet for
  micro-benchmarks, `dotnet-counters` for live health, `dotnet-trace` for CPU, `dotnet-gcdump` for memory.
- Allocation rate turns into GC time. Fix allocations on **hot paths** with spans, pooling and
  streaming, and leave the rest readable.
- Cache deliberately: decide freshness, audience and invalidation first. **HybridCache** gives L1 + L2,
  stampede protection and tags. Versioned keys make invalidation free. Authorization never goes
  inside a cache factory.
- **Output caching** stores whole responses, and by default never caches authenticated requests.
  Compression usually belongs in the proxy.
- **Keyset pagination** (`(created_at, id) < (...)`) is fast at any depth and stable under writes.
- **Stream** big responses with `IAsyncEnumerable`, and remember the status code and the held connection.
- Never block on async (`.Result`), never share a `DbContext` across concurrent operations, and
  budget database connections across all your pods.
