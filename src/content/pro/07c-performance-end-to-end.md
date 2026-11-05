---
id: pro-12
title: "Making It Fast: Performance End to End"
level: advanced
minutes: 100
xp: 150
summary: A systematic way to make a React + ASP.NET Core + PostgreSQL app fast — measure first, set budgets (Core Web Vitals, API p95), trace the bottleneck from browser to database, load test with k6 and stop regressions in CI.
---

"The app is slow" is the most common performance ticket you'll ever get, and the least useful. Slow
*where*? For whom? Since when? Compared to what? The developers who are good at performance aren't
the ones who know the most tricks. They're the ones with a **method**: they measure before they
touch anything, they know which layer to suspect for which symptom, and they prove that the fix
worked.

The deep-dive lessons cover each layer in detail: **React Performance** (re-renders, memo, code
splitting, the Profiler), **Performance & Caching** (.NET allocations, HybridCache, output caching,
async traps), **Indexes & EXPLAIN** and **Performance Tuning** (query plans, keyset pagination,
N+1 in SQL). This lesson is the map that connects them. You'll follow one request from the browser
to the database and back, learn what "fast" means as a number, and then do what real teams do:
put the API under load with **k6**, find the bottleneck, fix it, and stop it from coming back.

## The method: a loop, not a bag of tricks

```text
   ┌──────────────► 1. MEASURE   real numbers from real users (or a repeatable lab run)
   │                    │
   │                2. BUDGET    "p95 of GET /orders < 200 ms", "LCP < 2.5 s at p75"
   │                    │
   │                3. LOCATE    which layer? browser → network → API → database
   │                    │
   │                4. FIX ONE   the biggest bottleneck only — one change at a time
   │                    │
   │                5. VERIFY    same measurement, same conditions: did the number move?
   │                    │
   └──────────────── 6. GUARD    a CI check that fails when it regresses
```

Why so formal? Because intuition about performance is **wrong most of the time**. Developers
reliably guess that the slow part is the clever code they wrote last week. In practice it is usually
something boring: a 2 MB image, a missing index, fifty queries where one would do, or a request that
waits for another request. If you optimise without measuring, you spend a day making the
20 ms part 10 ms faster while the 1,800 ms part stays as it was.

Two rules follow from this:

- **Fix the biggest thing first.** If a request spends 1,650 ms in the database and 40 ms in C#,
  no amount of C# tuning will save it. Amdahl's law in one sentence: speeding up a part only helps
  as much as that part's share of the total.
- **Change one thing at a time.** If you add an index, a cache and a bigger pod at the same time
  and latency drops, you don't know which one helped, and you have taken on the cost of all
  three.

## Numbers that matter: percentiles, not averages

Latency is not one number. It's a **distribution**: most requests are quick, a few are slow, and
those few are the ones users remember and complain about. An average mixes them together and hides
the tail:

```text
 98 requests × 10 ms   +   2 requests × 5,000 ms

 average = 109.8 ms     ← "looks fine-ish", describes nobody
 p50     =  10 ms       ← the typical request
 p95     =  10 ms
 p99     = 5,000 ms     ← 1 in 50 users waits 5 seconds
```

**pXX** means "XX % of requests were at least this fast". p95 = 300 ms means 95 % finished within
300 ms and 5 % took longer. Teams usually set budgets on **p95** (the experience of nearly everyone)
and watch **p99** (the tail, where timeouts, GC pauses, lock waits and cold caches live).

The tail matters more than it looks, because pages **fan out**. If a dashboard makes 10 API calls
and each has a 1 % chance of hitting its p99, the chance that the page load hits at least one slow
call is `1 − 0.99¹⁰ ≈ 9.6 %`. For a microservice that fans out to 100 back-end calls, it's 63 %.
For those users, the slow tail is the normal case.

:::warn title="Percentiles don't add up and can't be averaged"
The p95 of a page is **not** the sum of the p95s of its parts, and the p95 across five pods is
**not** the average of each pod's p95. To combine percentiles you need the raw samples or a
histogram (which is what Prometheus `histogram_quantile` uses). Averaging percentiles in a
dashboard is a classic way to produce a number that looks precise and is meaningless.
:::

:::quiz id=pro-12-q1 xp=15
Your API's `GET /search` has an **average** latency of 120 ms. Product asks for a performance
budget that protects the user experience. Which budget is best?

- [ ] "Average latency below 150 ms"
- [x] "p95 below 300 ms and p99 below 1 s, measured over 5-minute windows, plus error rate below 1 %"
- [ ] "Maximum latency below 500 ms"
- [ ] "Median below 100 ms"
> A percentile budget states what nearly every user gets (p95) and caps the tail (p99). The time
> window and the error rate make it measurable and stop you from "passing" by failing requests
> fast. An average is the tempting choice, but 2 % of requests could take 5 s and the average would
> still look fine. The maximum is a single outlier (one GC pause or one cold start), so the budget
> would fail all the time. The median ignores the slowest half of requests entirely.
:::

Now compute them yourself. This is exactly what k6, Prometheus and every APM tool do under the hood.

:::challenge id=pro-12-c1 lang=ts xp=40
title: p50, p95, p99 from raw samples
Implement `percentile(samples, p)` using the **nearest-rank** method:

1. Sort a **copy** of the samples in ascending **numeric** order. Never mutate the caller's array.
2. `rank = ceil(p / 100 × n)`, but at least 1.
3. Return `sorted[rank − 1]`.

Throw an `Error` if `samples` is empty. `p` is between 0 and 100 inclusive, so `p = 0` returns the
smallest sample and `p = 100` the largest. `summarize(samples)` (already written) uses your
function, so once `percentile` is right, it works too.

Why nearest-rank? It always returns a value that was actually observed, which is easy to reason
about ("one real request took this long"). Other tools interpolate between neighbours, so for small
sample sizes their p95 can differ from yours by one position. Both are correct; just don't compare
percentiles computed by different methods.

hint: `[...samples].sort((a, b) => a - b)`: without the comparator, `sort` compares as strings, so `100` comes before `9`.
hint: For 1…100 and p = 95: `ceil(0.95 × 100) = 95`, so the answer is `sorted[94]` = 95. The starter's `floor` returns the item one place too high.
hint: For p = 0 the rank would be 0, so clamp it with `Math.max(1, …)`.

```ts starter
export function percentile(samples: number[], p: number): number {
  const sorted = samples.sort()
  return sorted[Math.floor((p / 100) * sorted.length)]
}

export function summarize(samples: number[]) {
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length
  return {
    count: samples.length,
    mean,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: percentile(samples, 100),
  }
}
```

```ts solution
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error('no samples')
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

export function summarize(samples: number[]) {
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length
  return {
    count: samples.length,
    mean,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: percentile(samples, 100),
  }
}
```

```ts tests
const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1)

test('p95 of 1..100 is 95', () => {
  expect(percentile(oneToHundred, 95)).toBe(95)
})
test('p50 and p99 of 1..100', () => {
  expect(percentile(oneToHundred, 50)).toBe(50)
  expect(percentile(oneToHundred, 99)).toBe(99)
})
test('p100 is the max, p0 is the min', () => {
  expect(percentile(oneToHundred, 100)).toBe(100)
  expect(percentile(oneToHundred, 0)).toBe(1)
})
test('sorts numerically, not as strings', () => {
  expect(percentile([100, 9, 20], 50)).toBe(20)
})
test('works on unsorted input and does not mutate it', () => {
  const input = [30, 10, 20]
  expect(percentile(input, 50)).toBe(20)
  expect(input).toEqual([30, 10, 20])
})
test('a single sample is every percentile', () => {
  expect(percentile([42], 1)).toBe(42)
  expect(percentile([42], 99)).toBe(42)
})
test('empty input throws', () => {
  expect(() => percentile([], 95)).toThrow()
})
test('the average hides the tail; p99 shows it', () => {
  const samples = [...Array(98).fill(10), 5000, 5000]
  const s = summarize(samples)
  expect(s.mean).toBeCloseTo(109.8)
  expect(s.p50).toBe(10)
  expect(s.p95).toBe(10)
  expect(s.p99).toBe(5000)
  expect(s.max).toBe(5000)
})
```
:::

## Budgets: what "fast enough" means

A budget turns "make it faster" into a yes/no question that a machine can check. Without one,
performance work never finishes, and nobody notices when it gets worse. Set budgets per layer, so
each team can see when *its* layer is the problem.

| Layer | Budget (typical starting point) | Measured with |
|---|---|---|
| **Page load: LCP** (Largest Contentful Paint) | ≤ 2.5 s at p75 of real visits | `web-vitals` in production (field), Lighthouse (lab) |
| **Responsiveness: INP** (Interaction to Next Paint) | ≤ 200 ms at p75 | `web-vitals` (field only: a lab run has no real clicks) |
| **Visual stability: CLS** (Cumulative Layout Shift) | ≤ 0.1 at p75 | `web-vitals`, Lighthouse |
| **JavaScript shipped** | e.g. ≤ 200 KB gzipped for the first route | Vite build output, `size-limit`, Lighthouse CI |
| **API read endpoints** | p95 ≤ 200–300 ms, p99 ≤ 1 s, errors < 1 % | Server metrics (OpenTelemetry), k6 |
| **API write endpoints** | p95 ≤ 500 ms | Same |
| **Database queries** | the hot queries ≤ 10–50 ms; nothing in the hot path does a full scan of a big table | `pg_stat_statements`, `EXPLAIN ANALYZE` |

Two kinds of measurement, and you need both:

- **Field data (RUM, real user monitoring)** is what real users on real phones and networks
  experience. It's the truth, but it's noisy and delayed: you find out after you ship. Google uses
  the **p75** of field data for Core Web Vitals.
- **Lab data** (Lighthouse, a k6 run, a benchmark) is repeatable and available **before** you
  ship, so it's what CI can check. But it's a simulation: a fast laptop on office Wi-Fi is not a
  three-year-old Android phone on a train.

Collect field data with a few lines of code (see **React Performance** for what each metric means
and how to fix it in React):

```ts
// src/vitals.ts: imported once from main.tsx (npm install web-vitals)
import { onCLS, onINP, onLCP, type Metric } from 'web-vitals'

function send(metric: Metric) {
  const body = JSON.stringify({
    id: metric.id,              // unique per page load: CLS and INP can be reported more than once, keep the last
    name: metric.name,          // 'LCP' | 'INP' | 'CLS'
    value: metric.value,        // ms (LCP, INP) or unitless (CLS)
    rating: metric.rating,      // 'good' | 'needs-improvement' | 'poor'
    page: location.pathname,    // group by route, never by full URL with ids or tokens
  })
  // sendBeacon survives the tab being closed. A string body arrives as text/plain,
  // so the endpoint must read the raw body rather than expect application/json.
  navigator.sendBeacon('/api/vitals', body)
}

onLCP(send)
onINP(send)
onCLS(send)
```

:::job title="Where the budgets come from at a real job"
You rarely invent budgets from scratch. They come from an **SLO** ("99 % of checkout requests under
500 ms over 28 days", see **Teamwork, Agile & Code Review**), from a customer contract, or from
"don't get worse than today". A very common first task is: *"measure where we are, then set the
budget slightly better than today and fail CI when we go above it."* That alone stops the slow
drift that makes most apps sluggish: nobody made it slow on purpose, it got 3 % slower with every
sprint.
:::

## Following one request: where does the time go?

Before you fix anything, find out **which layer** owns the time. Here is one page load of an
order list, broken down:

```text
 Browser                      Network                  API (.NET)              PostgreSQL
 ───────                      ───────                  ──────────              ──────────
 HTML parse ── JS download ─► DNS/TCP/TLS ──────────► routing, auth
 (blocked by 800 KB JS?)      (CDN? HTTP/2?)           model binding
                                                       your code ────────────► query 1
                              TTFB = time until        (allocations? locks?)   query 2 … 51 (N+1?)
 React render ◄── JSON ◄───── the first byte comes ◄── serialize JSON ◄─────── (index? pool wait?)
 (re-renders? long tasks?)    back (compression?)
 image download (2 MB hero?)
 LCP ✓  then the user clicks → INP
```

The fastest way to see which layer is slow is the **Network panel** in Chrome DevTools (you met it
in **Debugging Like a Pro**). Click a request and open the **Timing** tab:

| What dominates | What it means | Where to look next |
|---|---|---|
| **Queueing / Stalled** | The browser is waiting for a free connection, or the request was started late | Too many parallel requests on HTTP/1.1, or a **waterfall** (see below) |
| **Waiting for server response (TTFB)** | The server is slow to produce the first byte | Backend and database |
| **Content download** | The response is large or the network is slow | Compression, pagination, fewer fields in the response |
| Nothing is slow, but the page still is | The time is spent in the browser | Performance panel: long tasks, re-renders, layout |

To see **inside** a slow TTFB without opening a profiler, have the server report its own timings
with the standard `Server-Timing` header. DevTools shows it in that same Timing tab:

```csharp
// Program.cs: a tiny Server-Timing middleware (add it early in the pipeline)
using System.Diagnostics;

app.Use(async (context, next) =>
{
    var total = Stopwatch.StartNew();
    context.Response.OnStarting(() =>
    {
        var db = context.Items["db-ms"] as double? ?? 0;      // set by your data layer
        context.Response.Headers.Append("Server-Timing",
            $"db;dur={db:F1}, app;dur={total.Elapsed.TotalMilliseconds - db:F1}");
        return Task.CompletedTask;
    });
    await next();
});
```

:::warn title="Server-Timing is visible to everyone"
Anything in a response header can be read by any user. Timings are usually harmless, but don't
put query text, table names or internal host names in them, and consider turning the header on
only for internal users or non-production environments. In production, your **traces** (see
**Observability: OpenTelemetry, Prometheus, Grafana, Loki**) give the same breakdown for every
request, without exposing anything.
:::

:::quiz id=pro-12-q2 xp=15
Users say the order history page is slow. In DevTools the `GET /api/orders` request shows
**Waiting for server response: 1.8 s** and **Content download: 4 ms**. The response has
`Server-Timing: db;dur=1650, app;dur=140`. Where do you look first?

- [ ] The React bundle: it's probably too big and delays the request
- [ ] Put the API behind a CDN so the response travels a shorter distance
- [x] The database: find the query (or queries) behind this endpoint and run `EXPLAIN ANALYZE`
- [ ] Enable Brotli compression for the JSON response
> TTFB is 1.8 s, and the server itself says 1,650 ms of that is spent in the database. That's
> about 90 % of the total, so that's where the win is. The bundle can delay *when* the request
> starts, but it doesn't change how long the server takes to answer it. A CDN and compression help
> with distance and size, and the download took only 4 ms, so the network isn't the problem.
> Fixing those would leave 1.65 s of database time untouched.
:::

## Frontend: ship less, show the important part first

The browser has to download, parse and run your JavaScript before a client-rendered React app can
show anything. So for a SPA, **the size of the JavaScript is the size of the problem**. The high-value
checks, in order (details in **React Performance** and **Rendering Strategies: CSR, SSR, SSG &
Server Components**):

1. **Look at the bundle.** `vite build` prints the chunk sizes; `rollup-plugin-visualizer` shows a
   treemap of what's inside. Typical finds: a whole icon pack, a date library, a chart library on
   the login page, two versions of the same package.
2. **Split by route.** `lazy(() => import('./pages/Reports'))` means users who never open Reports
   never download it. Heavy widgets (editors, charts, maps) are the next candidates.
3. **Fix the LCP element.** It's usually the hero image or the main heading. Serve the image at
   the size it's displayed, in **AVIF/WebP**, with `width` and `height` set, and tell the browser
   it's important. Never lazy-load it.
4. **Reserve space** for anything that loads late (images, ads, banners, async lists) so content
   doesn't jump. That's CLS.
5. **Find slow interactions** with the React DevTools **Profiler** ("why did this render?") and
   the Chrome **Performance** panel (long tasks over 50 ms block the next paint). That's INP.

```html
<!-- The LCP image: right size, modern format, high priority, space reserved -->
<img
  src="/img/hero-1200.avif"
  srcset="/img/hero-600.avif 600w, /img/hero-1200.avif 1200w"
  sizes="(max-width: 700px) 100vw, 1200px"
  width="1200" height="600"
  fetchpriority="high"
  alt="Team planning board" />

<!-- Images further down the page: let the browser wait until they're needed -->
<img src="/img/feature-1.avif" width="600" height="400" loading="lazy" decoding="async" alt="…" />
```

:::quiz id=pro-12-q3 xp=15
A marketing page has an LCP of 4.2 s on mobile. The LCP element is a hero image: a 1.8 MB, 3000 px
wide JPEG shown at 400 px. A teammate has added `loading="lazy"` to every `<img>` "for
performance". What's the best fix?

- [ ] Keep `loading="lazy"` on the hero and add a loading spinner
- [x] Serve a properly sized AVIF/WebP via `srcset`, remove `loading="lazy"` from the hero, add `fetchpriority="high"` and `width`/`height`
- [ ] Inline the image as base64 inside the HTML so it doesn't need its own request
- [ ] Move the image to a CDN and change nothing else
> The image is about 7× wider than it's displayed and in an old format, so the phone downloads
> megabytes it never shows. The right size in AVIF is often 30–80 KB. `loading="lazy"` on the LCP
> element is the tempting mistake: it tells the browser to wait until layout confirms the image is
> in view, which *delays* the most important paint. Base64 makes the HTML bigger and the image
> uncacheable on its own. A CDN shortens the distance but still sends 1.8 MB.
:::

## Network: don't send it twice, don't send it in series

The fastest request is the one you don't make. After that, the next fastest is a small response
from a cache close to the user. Four tools do most of the work here.

**1. HTTP caching headers.** Vite puts a content hash in every asset file name
(`index-3f9a1c.js`). When the content changes, the name changes too, so those files can be cached
"forever". `index.html` is the one file that must *not* be cached that way, because it's what
points at the new hashes.

| Resource | `Cache-Control` | Why |
|---|---|---|
| `/assets/index-3f9a1c.js`, `.css`, fonts, hashed images | `public, max-age=31536000, immutable` | The name changes when the content changes, so a cached copy is never stale |
| `index.html` | `no-cache` | "Store it, but ask the server (ETag) before using it": a cheap `304 Not Modified` most of the time, the new version right after a deploy |
| Public API data (catalog, plans) | `public, max-age=60, stale-while-revalidate=300` | Shared caches and the CDN can answer; slightly stale is acceptable |
| Personal API data (`/api/me`, orders) | `private, no-cache` or `no-store` | Must never be stored by a shared cache or CDN and served to another user |

**2. Compression.** Text (HTML, JS, CSS, JSON) shrinks 70–90 % with **Brotli** or gzip. Usually the
CDN or reverse proxy does it; ASP.NET Core can do it with `AddResponseCompression` (see
**Performance & Caching**). Don't compress images or video: they're already compressed.

**3. A CDN** serves static files from a location near the user and takes that load off your
servers. A user 8,000 km from your data centre pays around 150 ms per round trip, and loading a page
takes several round trips.

**4. Kill the waterfall.** A waterfall is a chain of requests where each one can only start after
the previous one finishes. In React apps it's usually nested components that each fetch in an
effect:

```text
 GET /api/me            ████
 GET /api/projects           ████              ← starts only after <Projects> rendered
 GET /api/projects/7/tasks        ████         ← starts only after <TaskList> rendered
 GET /api/users/12                     █       ← one per task row: the frontend N+1
 GET /api/users/15                     █
 GET /api/users/19                     █  …
```

Each step adds a full round trip, and the per-row requests are an **N+1 from the frontend**. The
fixes: start independent requests in parallel (route loaders, `Promise.all`, prefetching with
TanStack Query, see **Server State with TanStack Query**), and give the API an endpoint that
returns what the screen needs, including the assignee names, in **one** response.

:::quiz id=pro-12-q4 xp=15
After a deploy, some users keep seeing the old UI and get errors because the old JS calls an API
that has changed. Which caching setup prevents this **and** keeps repeat visits fast? (Select all
that apply.)

- [x] `index.html` served with `Cache-Control: no-cache`, so the browser revalidates it on every visit
- [x] Hashed files under `/assets/` served with `public, max-age=31536000, immutable`
- [ ] `index.html` served with `max-age=86400` so it loads instantly for a day
- [ ] Every file served with `no-store`, so nothing is ever cached
> The HTML is the "pointer" to the current hashed bundles. If it's revalidated every time, users
> pick up a deploy right away, and it costs only a tiny `304` when nothing changed. Hashed assets
> can be cached forever because a new build gives them new names. Caching `index.html` for a day is
> exactly what causes the bug: browsers keep pointing at yesterday's bundle. `no-store` on
> everything "fixes" staleness by throwing away all caching, so every visit downloads the full
> app again.
:::

## Backend: is the API working, or waiting?

When TTFB is the problem and the database isn't obviously to blame, first answer one question:
**is the process busy, or is it waiting?** `dotnet-counters` answers it in about ten seconds
against a running app, with no code changes (full tour in **Performance & Caching**):

```bash
dotnet tool install --global dotnet-counters
dotnet tool install --global dotnet-trace

dotnet-counters monitor -n OrdersApi --counters System.Runtime,Microsoft.AspNetCore.Hosting
```

`-n` is the process name (`dotnet-counters ps` lists them). On .NET 9 and later the runtime
publishes these as OpenTelemetry-style metrics, so the names you'll see are, for example,
`dotnet.process.cpu.time` (CPU seconds used per second: 2.0 means two cores fully busy),
`dotnet.gc.heap.total_allocated`, `dotnet.gc.pause.time`, `dotnet.thread_pool.queue.length`,
`dotnet.thread_pool.thread.count`, `http.server.active_requests` and
`http.server.request.duration` (with p50/p95/p99 per route). Older articles show the .NET 8 names
(`cpu-usage`, `threadpool-queue-length`); they mean the same things.

| What you see under load | Diagnosis | Next step |
|---|---|---|
| CPU near 100 %, latency grows with load | **Busy**: your code (or serialization, or regex, or LINQ) burns CPU | `dotnet-trace collect -n OrdersApi --format Speedscope`, open the file in speedscope.app and look for the widest frames |
| Allocation rate in the GB/s, frequent gen 2 GCs, GC pause time high | **Busy with garbage**: allocations (big strings, `ToList()` of huge sets, buffering whole files) | Allocation profiling, streaming, pooling: see **Performance & Caching** |
| CPU low, thread pool **queue length** growing, thread count climbing slowly | **Starved**: something blocks threads (`.Result`, `.Wait()`, `Thread.Sleep`, sync I/O) | Find the sync-over-async call; make it `await` all the way down (see **Async/Await Done Right**) |
| CPU low, thread pool fine, active requests high, latency high | **Waiting** on something outside the process: database, connection pool, lock, slow downstream HTTP call | Traces with per-span timings, database metrics, connection pool settings |

The last row is the most common one in business apps, and it's the one people misread. They see
low CPU, conclude "the API is fine", or add more pods. But if every request is waiting for one of
ten database connections, ten more pods just means more requests waiting for the same database.

The third row ("starved") deserves an example, because the code looks harmless and works fine in a
quick manual test:

```csharp
// Blocks a thread-pool thread for the whole HTTP call. At 5 requests/s nobody notices.
// At 500 requests/s every pool thread is blocked, new requests queue, and the pool adds
// only a thread or two per second: latency explodes while CPU stays near zero.
var rates = http.GetFromJsonAsync<Rates>("https://rates.internal/today").Result;

// Frees the thread while the network does the work: the same thread serves other requests meanwhile.
var rates = await http.GetFromJsonAsync<Rates>("https://rates.internal/today", ct);
```

Two backend fixes come up again and again:

- **Don't do the same work twice.** If 500 users per second ask for the same project stats,
  compute them once and cache them. In .NET 10, `HybridCache` (NuGet package
  `Microsoft.Extensions.Caching.Hybrid`) is the default choice: it keeps an in-memory copy, can use
  Redis as a second level, and protects against **stampedes** (100 simultaneous misses run the
  factory once, not 100 times). See **Performance & Caching** and **Caching with Redis in .NET**.

  ```csharp
  builder.Services.AddHybridCache();   // in-memory; add a Redis IDistributedCache for level 2

  app.MapGet("/projects/{id:int}/stats", async (int id, HybridCache cache, CancellationToken ct) =>
      await cache.GetOrCreateAsync(
          $"project-stats:{id}",                              // the key: everything the result depends on
          async cancel => await ComputeStatsAsync(id, cancel), // runs only on a miss, once per key
          new HybridCacheEntryOptions { Expiration = TimeSpan.FromSeconds(30) },
          cancellationToken: ct));
  ```

  The failure mode to watch: a cache hides a slow query instead of fixing it. When the cache is
  cold (after a deploy, or when the key changes), every user pays the full cost again. Fix the
  query first, then cache what is still expensive.
- **Do less per request.** Return a page of 50, not 50,000 (keyset pagination). Project to a DTO in
  SQL instead of loading whole entity graphs, and stream large exports instead of buffering them in
  memory.

## Database: plans, indexes, round trips and pools

Most slow APIs are slow because of the database, and there are almost always one of four reasons.

**1. A bad plan: the query reads far more rows than it returns.** Ask Postgres what it actually did:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, total, placed_at FROM orders
WHERE customer_id = 4217
ORDER BY placed_at DESC
LIMIT 20;
```

```text
-- trimmed: costs omitted; on a real 2-million-row table you may also see Gather / Parallel Seq Scan
Limit  (actual time=212.4..212.4 rows=20 loops=1)
  ->  Sort  (actual time=212.4..212.4 rows=20 loops=1)
        ->  Seq Scan on orders  (actual time=0.03..211.9 rows=48 loops=1)
              Filter: (customer_id = 4217)
              Rows Removed by Filter: 1999952
              Buffers: shared hit=2112 read=14590
```

How to read it: `rows=48` is what the scan *returned*, `Rows Removed by Filter` is what it read
and threw away, and `Buffers: read=14590` means about 114 MB (14,590 pages of 8 KB) came from disk
rather than from memory. Postgres read all two million rows to find 48. That's the signature of a
missing index:
`CREATE INDEX CONCURRENTLY ix_orders_customer_placed ON orders (customer_id, placed_at DESC);`
turns it into an index scan that reads about 20 rows, in well under a millisecond. Reading plans
fluently is the subject of **Indexes & EXPLAIN**. To find *which* queries to look at,
`pg_stat_statements` ranks queries by total time spent: often the culprit is a 3 ms query that
runs 40 million times a day, not the 2 s report that runs once.

**2. Too many round trips: N+1.** Each query is fast, but there are 51 of them per request,
usually from an ORM that loads related data in a loop:

```csharp
// N+1: 1 query for orders + 1 per order for the customer
var orders = await db.Orders.OrderByDescending(o => o.PlacedAt).Take(50).ToListAsync(ct);
foreach (var o in orders)
{
    var customer = await db.Customers.FindAsync([o.CustomerId], ct);   // a query per row
    views.Add(new OrderView(o.Id, customer!.Name, o.Total, o.PlacedAt));
}

// One query: project in SQL; EF Core generates a JOIN
var views = await db.Orders
    .OrderByDescending(o => o.PlacedAt).Take(50)
    .Select(o => new OrderView(o.Id, o.Customer.Name, o.Total, o.PlacedAt))
    .ToListAsync(ct);
```

You can't see N+1 by reading one query, only by **counting** them per request. Turn on EF Core's
SQL logging in development (`LogTo(Console.WriteLine, LogLevel.Information)`) or look at a trace,
which shows 51 identical database spans under one request. More patterns, including
`AsSplitQuery` and lazy-loading traps, are in **EF Core Querying Like a Pro**.

**3. Waiting for a connection: pool exhaustion.** Opening a PostgreSQL connection is expensive (a
new server process per connection), so Npgsql keeps a **pool** per connection string, with a
default `Maximum Pool Size` of 100. When every connection is in use, the next query **waits** for
one, and after `Timeout` (15 s) it fails with *"The connection pool has been exhausted"*. The
symptoms are low CPU everywhere, latency that jumps under load, and then a wall of timeouts.
Common causes: slow queries holding connections longer, N+1 holding them more often, and
connections that are never disposed.

**4. Fighting over rows: locks.** Long transactions that update hot rows make everyone else queue
behind them. See **Transactions, Isolation & Locking**.

:::quiz id=pro-12-q5 xp=15
A request log shows that `GET /orders/recent` runs **51 queries per request**. 50 of them are
`SELECT id, name FROM customers WHERE id = $1`, each taking about 0.4 ms. Under load the endpoint's
p95 is 900 ms. What's the right fix?

- [ ] Add an index on `customers(id)` to make each query faster
- [ ] Scale the API from 3 to 10 pods
- [x] Load the customers in one query (a JOIN via projection, or `WHERE id = ANY($1)`), so the endpoint needs 1–2 queries
- [ ] Increase `Maximum Pool Size` to 500
> The queries are already fast (`id` is the primary key, so it already has an index). The cost is
> 51 round trips, and each one holds a pooled connection, so under load requests queue for
> connections. Adding an index changes nothing here. More pods and a bigger pool send *more*
> concurrent queries to the same database, and Postgres has a hard `max_connections` limit. Fewer
> round trips fixes the cause: each request holds connections about 25× less, so the same pool
> serves about 25× the traffic. You'll prove exactly this in the lab.
:::

:::quiz id=pro-12-q6 xp=15
The API runs as 12 pods, each with Npgsql's default pool (`Maximum Pool Size=100`). PostgreSQL has
`max_connections = 200`. During a traffic spike, some requests fail with `53300: sorry, too many
clients already` while others time out with *"The connection pool has been exhausted"*. What is
the most sensible direction?

- [ ] Raise `Maximum Pool Size` to 300 on every pod
- [ ] Raise `max_connections` to 5000
- [x] Make the totals fit: (pods × pool size) must stay below `max_connections`, so lower the per-pod pool (or put PgBouncer in transaction mode in front), and shorten how long each request holds a connection
- [ ] Open a new `NpgsqlConnection` without pooling for each query so connections are never shared
> 12 × 100 = 1,200 possible connections against a server that accepts 200. The pools promise
> capacity the database doesn't have. Every Postgres connection is a process with its own memory,
> so 5,000 of them would make the database slower for everyone. Raising pool sizes makes the
> mismatch worse. The fix is to budget connections: here 12 pods × 15 = 180 leaves about 20
> connections for migrations, admin tools and superuser access. A pod rarely needs more, because
> each connection serves hundreds of short queries per second. When you have many pods (or
> autoscaling), put a pooler such as PgBouncer in front, and make queries faster so each connection
> is freed sooner. Turning pooling off adds connection setup (a new Postgres process, several
> milliseconds) to every query, and still doesn't stop you from exceeding `max_connections`.
:::

### Your turn: percentiles in SQL

Your request log is often just a table (or a log index you can query like one). Postgres computes
percentiles natively with ordered-set aggregates: `percentile_disc(0.95) WITHIN GROUP (ORDER BY
duration_ms)` returns an actually observed value (nearest rank, like your TypeScript function),
while `percentile_cont` interpolates between neighbours.

:::sql id=pro-12-sql1 db=empty xp=30 ordered=true
title: Which route breaks the budget?
The `request_log` table has one row per request: `route`, `status`, `duration_ms`. For every route
with **at least 50 requests** (three samples don't make a percentile), return:

- `route`
- `requests`: the number of requests
- `avg_ms`: the average duration, rounded to a whole number
- `p95_ms`: the 95th percentile using `percentile_disc`

Order by `p95_ms` descending. Compare `avg_ms` and `p95_ms` for each route: which one would have
fooled you?

hint: `percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)` is an aggregate, like `count(*)`.
hint: Filter on an aggregate with `HAVING count(*) >= 50`, after `GROUP BY route`.

```sql setup
CREATE TABLE request_log (
  id          serial PRIMARY KEY,
  route       text NOT NULL,
  status      int  NOT NULL,
  duration_ms int  NOT NULL
);
-- /orders/recent: 10 % of requests are very slow (an N+1 under load)
INSERT INTO request_log (route, status, duration_ms)
SELECT '/orders/recent', 200, CASE WHEN g % 10 = 0 THEN 600 + g ELSE 30 + g % 20 END
FROM generate_series(1, 400) g;
-- /products: consistently quick
INSERT INTO request_log (route, status, duration_ms)
SELECT '/products', 200, 15 + g % 30 FROM generate_series(1, 600) g;
-- /me: almost always 8-12 ms, but 2 % hit a 2 s timeout to an identity provider
INSERT INTO request_log (route, status, duration_ms)
SELECT '/me', CASE WHEN g % 50 = 0 THEN 504 ELSE 200 END,
       CASE WHEN g % 50 = 0 THEN 2000 ELSE 8 + g % 5 END
FROM generate_series(1, 300) g;
-- /admin/export: three huge requests
INSERT INTO request_log (route, status, duration_ms)
VALUES ('/admin/export', 200, 5000), ('/admin/export', 200, 7000), ('/admin/export', 200, 9000);
```

```sql starter
SELECT route, count(*) AS requests
FROM request_log
GROUP BY route;
```

```sql solution
SELECT route,
       count(*)                                                   AS requests,
       round(avg(duration_ms))                                    AS avg_ms,
       percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)  AS p95_ms
FROM request_log
GROUP BY route
HAVING count(*) >= 50
ORDER BY p95_ms DESC;
```
:::

The answer is worth thinking about. `/orders/recent` has a p95 of 800 ms that its average of
117 ms only hints at: one request in ten is slow, and the average spreads that pain thinly over
everyone. `/me` is the opposite: an average of 50 ms that looks worse than its p95 of 12 ms. Its
real problem is the 2 % of requests that time out, and only **p99** (or the error rate) shows
those. No single number tells the whole story. That's why budgets combine p95, p99 and the error
rate.

### Your turn: find the N+1 in a log

Counting queries per request is how you find N+1 problems in a log, a trace export or a
test. The trick is to compare queries by their **shape**, not their text: `WHERE id = 12` and
`WHERE id = 15` are the same query with different values.

:::challenge id=pro-12-c2 lang=ts xp=50
title: An N+1 detector
Write two functions:

**`normalizeSql(sql)`** returns the query's shape:

1. Replace every single-quoted string literal (`'…'`, no escaped quotes inside) with `?`.
2. Then replace every standalone number (integers and decimals like `42` or `9.99`) with `?`.
   Digits that are part of a name (`orders_2024`, `t1`) must stay.
3. Collapse every run of whitespace into one space and trim both ends.

**`findNPlusOne(log, minRepeats = 5)`** takes `{ requestId, sql }[]` entries and returns one
object `{ requestId, query, count }` (exactly these three properties, `query` being the
**normalized** SQL) for every (request, normalized query) pair that occurs at least `minRepeats`
times **within the same request**. The same shape spread across different requests is not an N+1
and must not be reported. Sort by `count` descending, then by `requestId` ascending. Return `[]`
when nothing qualifies.

hint: A regex with word boundaries matches standalone numbers: `/\b\d+(\.\d+)?\b/g`. In `orders_2024` there's no boundary between `_` and `2`, because both are word characters.
hint: Strings: `/'[^']*'/g` turns the whole literal, including any digits inside it like `'room 101'`, into one `?`.
hint: Group with a `Map` keyed by `requestId + '\u0000' + normalized`, then filter, map to objects and sort.

```ts starter
export function normalizeSql(sql: string): string {
  return sql
}

export function findNPlusOne(
  log: { requestId: string; sql: string }[],
  minRepeats = 5,
): { requestId: string; query: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of log) {
    counts.set(entry.sql, (counts.get(entry.sql) ?? 0) + 1)
  }
  return [...counts]
    .filter(([, count]) => count >= minRepeats)
    .map(([query, count]) => ({ requestId: '?', query, count }))
}
```

```ts solution
export function normalizeSql(sql: string): string {
  return sql
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
}

export function findNPlusOne(
  log: { requestId: string; sql: string }[],
  minRepeats = 5,
): { requestId: string; query: string; count: number }[] {
  const groups = new Map<string, { requestId: string; query: string; count: number }>()
  for (const entry of log) {
    const query = normalizeSql(entry.sql)
    const key = entry.requestId + '\u0000' + query
    const group = groups.get(key)
    if (group) group.count++
    else groups.set(key, { requestId: entry.requestId, query, count: 1 })
  }
  return [...groups.values()]
    .filter((g) => g.count >= minRepeats)
    .sort((a, b) => b.count - a.count || a.requestId.localeCompare(b.requestId))
}
```

```ts tests
const customerLookups = (requestId: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ requestId, sql: `SELECT id, name FROM customers WHERE id = ${i + 10}` }))

test('numbers become ?', () => {
  expect(normalizeSql('SELECT * FROM orders WHERE id = 42')).toBe('SELECT * FROM orders WHERE id = ?')
})
test('strings and decimals become ?', () => {
  expect(normalizeSql("SELECT * FROM users WHERE email = 'ada@example.com' AND total > 9.99"))
    .toBe('SELECT * FROM users WHERE email = ? AND total > ?')
})
test('a string literal containing digits becomes a single ?', () => {
  expect(normalizeSql("SELECT * FROM rooms WHERE name = 'room 101'")).toBe('SELECT * FROM rooms WHERE name = ?')
})
test('digits inside identifiers are kept', () => {
  expect(normalizeSql('SELECT t1.id FROM orders_2024 t1 WHERE t1.total > 100'))
    .toBe('SELECT t1.id FROM orders_2024 t1 WHERE t1.total > ?')
})
test('whitespace is collapsed and trimmed', () => {
  expect(normalizeSql('  SELECT  *\n   FROM t\tWHERE id = 1  ')).toBe('SELECT * FROM t WHERE id = ?')
})
test('finds the N+1 inside one request', () => {
  const log = [
    { requestId: 'r1', sql: 'SELECT * FROM orders ORDER BY placed_at DESC LIMIT 50' },
    ...customerLookups('r1', 6),
  ]
  expect(findNPlusOne(log)).toEqual([
    { requestId: 'r1', query: 'SELECT id, name FROM customers WHERE id = ?', count: 6 },
  ])
})
test('repeats below the threshold are not reported', () => {
  expect(findNPlusOne(customerLookups('r2', 4))).toEqual([])
  expect(findNPlusOne(customerLookups('r2', 4), 3)).toHaveLength(1)
})
test('counts per request, not across requests', () => {
  const log = [...customerLookups('a', 3), ...customerLookups('b', 3)]
  expect(findNPlusOne(log, 4)).toEqual([])
})
test('sorted by count desc, then requestId', () => {
  const log = [...customerLookups('b', 5), ...customerLookups('c', 9), ...customerLookups('a', 5)]
  expect(findNPlusOne(log).map((r) => `${r.requestId}:${r.count}`)).toEqual(['c:9', 'a:5', 'b:5'])
})
```
:::

:::pro title="Make N+1 a failing test, not a production incident"
Teams that have been burned by N+1 add a **query-count assertion** to their integration tests: an
EF Core `DbCommandInterceptor` (or a Npgsql logging hook) counts the commands sent while one test
request runs, and the test asserts `queries <= 3`. It costs ten lines and catches the regression
in the PR that introduces it, long before a load test or a customer would. The lab's
`X-Db-Queries` header is the same idea, made visible.
:::

## Load testing with k6

Everything so far measures one request at a time. Many problems only show up under
**concurrency**: pools run dry, locks queue up, caches stampede, and the thread pool starves. A load
test makes that happen deliberately, on your schedule, instead of during a launch.

**k6** (by Grafana Labs) is the standard tool for this: tests are JavaScript files, it runs as one
binary, and it fits in CI. A test is a default function (what one virtual user does) plus
`options` (how much load, and what counts as a pass):

```js
import http from 'k6/http'
import { check } from 'k6'

export const options = {
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',   // open model: start N iterations per second, whatever happens
      rate: 100, timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 20, maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],                    // < 1 % errors
    http_req_duration: ['p(95)<200', 'p(99)<500'],     // the API budget, in ms
  },
}

export default function () {
  const res = http.get('http://localhost:5080/orders/recent')
  check(res, { 'status is 200': (r) => r.status === 200 })
}
```

**Thresholds are the important part.** They turn a load test from "some charts to look at" into a
pass/fail result: if any threshold fails, k6 exits with code **99**, which fails a CI step. Checks
are per-request assertions (`status is 200`); on their own they don't fail the run, so add a
`checks: ['rate>0.99']` threshold if they should.

### Open vs closed model: the most common load-testing mistake

There are two ways to generate load, and only one of them behaves like real users:

- **Closed model** (`constant-vus`, `ramping-vus`): N virtual users each loop "request, wait for
  response, repeat". If the server slows down, each user sends **fewer** requests, so the load
  drops exactly when the system is struggling. The test is politely backing off, and the results
  look better than reality. This effect is called *coordinated omission*.
- **Open model** (`constant-arrival-rate`, `ramping-arrival-rate`): k6 **starts** a new iteration
  at a fixed rate, whether or not earlier ones have finished. Real users behave like this: a
  thousand people don't wait for each other's checkout to finish. If the server can't keep up,
  k6 needs more VUs, and when it hits `maxVUs` it reports `dropped_iterations`. That's a clear
  sign you went past capacity.

Use the open model for "can we handle X requests per second?". Use the closed model for "N users
clicking through a flow with think time" (add `sleep(1)` between steps).

### Kinds of load test

| Test | Shape | Answers |
|---|---|---|
| **Smoke** | 1–5 VUs, 30 s | Does the script work, and is the system basically OK? (Run on every PR.) |
| **Load** | Expected peak traffic, 5–30 min | Do we meet the budget at normal peak? |
| **Stress** | Ramp up past peak until it breaks | Where's the ceiling, and what breaks first? |
| **Spike** | Sudden jump (10× in seconds) | Do autoscaling, pools and caches cope with a burst? |
| **Soak** | Normal load for hours | Leaks: memory, connections, file handles, growing queues |

### Reading the results: Little's Law

k6 breaks `http_req_duration` into `http_req_waiting` (time to first byte: the server's share),
`http_req_receiving`, `http_req_connecting` and `http_req_blocked`. If *waiting* is most of the
duration, the time is spent on the server, not on the network.

One formula explains most load-test results. **Little's Law**: *concurrency = throughput ×
latency*. If each request holds a database connection for 100 ms in total, then 10 connections can
serve at most 10 / 0.1 s = **100 requests per second**. Send 120 per second and the extra
20 per second can't be served. They queue, and the queue grows until something gives: latency
climbs, k6 hits `maxVUs`, and requests time out. You'll see this exact curve in the lab, and you
can predict the result before you run it.

:::quiz id=pro-12-q7 xp=15
You load test with `constant-vus` (50 VUs looping requests). As the API slows from 50 ms to 2 s per
request, the k6 report shows throughput dropping from 1,000 req/s to 25 req/s, and the p95 still
looks "acceptable" for the requests that ran. Why is this test misleading?

- [ ] k6 can't measure latencies above 1 s accurately
- [x] In a closed model each VU waits for its response, so a slower server automatically gets less load. Use `constant-arrival-rate` to keep sending the real traffic rate and see the queue form
- [ ] 50 VUs is too few; with 5,000 VUs the closed model would be accurate
- [ ] Throughput always drops under load; that's expected and not a problem
> Each VU in a closed model is "one request in flight". When the server slows down, the offered
> load drops 40×, so the test never reproduces the traffic that hurts. Real users keep arriving,
> which is what an arrival-rate executor does. Then the backlog shows up as rising latency and
> `dropped_iterations`. More VUs in a closed model just moves the problem around. And a throughput
> drop under constant demand is the bug you're looking for, not normal behaviour.
:::

:::warn title="Load test something you own, somewhere safe"
Never load test production or a shared staging environment without telling the people who run it.
A stress test looks exactly like a denial-of-service attack, it can trigger autoscaling bills and
rate limits at your cloud provider, and it can break other teams' tests. Never point a load test at
third-party APIs (payment providers, identity providers, email services) either: stub them. Also
test a **Release** build with production-like settings: a Debug build with verbose logging is
easily 2–5× slower, and the numbers mean nothing.
:::

## Guarding against regressions in CI

Performance gets worse a little at a time: a new dependency here, an extra query there. The only
defence that works is a check that **fails the build** when a budget is exceeded, so the PR author
deals with it while the change is small and fresh in their mind. (Pipeline basics are in **CI with
GitHub Actions**.)

**Frontend: Lighthouse CI** builds the app, runs Lighthouse several times against it and asserts
on the metrics:

```json
{
  "ci": {
    "collect": {
      "startServerCommand": "npx vite preview --port 4173 --strictPort",
      "startServerReadyPattern": "Local",
      "url": ["http://localhost:4173/"],
      "numberOfRuns": 3
    },
    "assert": {
      "assertions": {
        "largest-contentful-paint": ["error", { "maxNumericValue": 2500, "aggregationMethod": "median-run" }],
        "cumulative-layout-shift": ["error", { "maxNumericValue": 0.1 }],
        "total-blocking-time": ["warn", { "maxNumericValue": 200 }],
        "resource-summary:script:size": ["error", { "maxNumericValue": 250000 }]
      }
    },
    "upload": { "target": "filesystem", "outputDir": ".lighthouseci" }
  }
}
```

Save that as `lighthouserc.json`, then run `npx @lhci/cli autorun` in a CI job after `npm run
build` (pin the CLI version once it works). `startServerReadyPattern` is the text Lighthouse CI
waits for in the server's output before it starts measuring: `vite preview` prints a `Local:` line
when it's listening. Lab runs have no real user interactions, so **Total Blocking Time** stands in
for INP. Keep watching the real INP in your field data.

:::warn title="Check the assertion names against your LHCI version"
Audit ids such as `largest-contentful-paint` and `resource-summary:script:size` come from
Lighthouse itself and occasionally change between major versions. If an assertion silently never
fails, run `npx @lhci/cli autorun` once locally and look at the audit ids in the generated report,
and see the Lighthouse CI docs (`docs/configuration.md` and `docs/assertions.md` in the
GoogleChrome/lighthouse-ci repository) for the current options.
:::

**Backend: k6 thresholds.** A short smoke-level load test against the API, started in the CI job
(for example with a Postgres service container), and the thresholds do the gatekeeping. Build
first and start with `--no-build`, so the health-check loop only waits for startup, not for a
compile:

```yaml
  perf-smoke:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with: { dotnet-version: '10.0.x' }
      - run: dotnet build -c Release src/OrdersApi
      # '&' keeps the API running in the background for the next steps of this job
      - run: dotnet run -c Release --no-build --project src/OrdersApi --no-launch-profile -- --urls http://localhost:5080 &
      - run: curl --retry 30 --retry-delay 1 --retry-all-errors -sf http://localhost:5080/health
      - uses: grafana/setup-k6-action@v1
      - run: k6 run load/smoke.js        # exit code 99 when a threshold fails → the job fails
```

:::quiz id=pro-12-q8 xp=15
Your new Lighthouse CI check fails randomly: the same commit scores LCP 2.1 s on one run and 2.9 s
on the next, so developers have started re-running the job until it goes green. Which changes make
the gate trustworthy? (Select all that apply.)

- [x] Run Lighthouse 3–5 times and assert on the median run
- [x] Assert on specific metrics with some headroom (LCP, CLS, script size) instead of the overall performance score
- [x] Treat deterministic budgets like bundle size as hard errors, and the timing metrics on shared CI runners as warnings until they're stable
- [ ] Delete the check: performance can only be measured in production
> Timing metrics on shared CI machines vary from run to run. A median of several runs smooths that
> out, and asserting on individual metrics tells the author *what* got worse, while the overall
> score blends everything together. Byte sizes are deterministic, so they can be strict from day
> one. Deleting the check is tempting after the tenth false alarm, but field data only shows you
> the regression after users already have it. A noisy gate needs fixing, not removing, because
> once people learn to re-run it until green, it protects nothing.
:::

:::job title="What you'll actually be asked to do"
In a full-stack job you'll rarely run a week-long performance project. You'll get tickets like
*"the orders page got slow after last release"*, *"can the API handle the Black Friday launch
(3× normal traffic)?"* or *"add a performance check to the pipeline"*. The answer that impresses
is always the same shape: *"Here's the number before (p95 = 900 ms at 100 req/s), here's the
cause (51 queries per request, pool saturated), here's the fix (one JOIN), here's the number after
(p95 = 6 ms), and here's the CI check that stops it from coming back."* Put those four numbers in
your PR description.
:::

## Lab: load test, find the bottleneck, fix it

:::lab id=pro-12-lab1 xp=120
title: k6 against a small API, with thresholds and one real bottleneck

You'll build a small orders API whose "database" behaves like PostgreSQL behind a 10-connection
pool. Each query borrows a connection for about 2 ms. The `GET /orders/recent` endpoint has an
N+1. You'll prove with k6 that it breaks the budget, explain why with Little's Law, fix it, and
watch the same test pass.

:::info title="You need"
- .NET 10 SDK (`dotnet --version` → `10.0.x`)
- k6 v1 or v2: `brew install k6` (macOS), `winget install k6 --source winget` (Windows), the
  package from grafana.com/docs/k6 (Linux), or Docker/Podman (`grafana/k6` image, see step 5)
- Optional, for step 6: `dotnet tool install --global dotnet-counters`
- About 20 minutes. The test runs on your laptop; nothing leaves your machine.
:::

**1. Create the project**

```bash
mkdir -p ~/devquest/pro-12-lab1 && cd ~/devquest/pro-12-lab1
dotnet new web -o OrdersApi
cd OrdersApi
```

**2. The fake database.** Create `OrdersApi/Db.cs`. `FakeDatabase` is a singleton that holds the
pool (a `SemaphoreSlim` with 10 slots, like `Maximum Pool Size=10`). `Db` is scoped (one per
request) and counts the queries that request sends.

```csharp
namespace OrdersApi;

public record Customer(int Id, string Name);
public record Order(int Id, int CustomerId, decimal Total, DateTime PlacedAt);
public record OrderView(int Id, string Customer, decimal Total, DateTime PlacedAt);

/// <summary>
/// Stands in for PostgreSQL behind a connection pool. Every query borrows one of
/// 10 "connections" for ~2 ms of database work - exactly like Npgsql with
/// Max Pool Size=10. When all 10 are busy, the next query WAITS for one.
/// </summary>
public sealed class FakeDatabase
{
    private readonly SemaphoreSlim _pool = new(10, 10);
    private readonly Customer[] _customers;
    private readonly Order[] _orders;

    public FakeDatabase()
    {
        _customers = Enumerable.Range(1, 2_000)
            .Select(i => new Customer(i, $"Customer {i}")).ToArray();
        var start = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        _orders = Enumerable.Range(1, 20_000)
            .Select(i => new Order(i, (i * 7919) % 2_000 + 1, i % 500 + 9.99m, start.AddMinutes(i)))
            .ToArray();
    }

    public async Task<T> QueryAsync<T>(Func<T> query, CancellationToken ct)
    {
        await _pool.WaitAsync(ct);          // borrow a connection (or queue for one)
        try
        {
            await Task.Delay(2, ct);        // network round trip + execution
            return query();
        }
        finally
        {
            _pool.Release();                // give the connection back
        }
    }

    public Order[] LatestOrders(int take) => _orders[^take..].Reverse().ToArray();
    public Customer CustomerById(int id) => _customers[id - 1];
    public Customer[] CustomersByIds(IEnumerable<int> ids) =>
        ids.Distinct().Select(id => _customers[id - 1]).ToArray();
}

/// <summary>One per request: counts how many queries this request sent.</summary>
public sealed class Db(FakeDatabase database)
{
    public int Queries { get; private set; }

    // SELECT ... FROM orders ORDER BY placed_at DESC LIMIT @take
    public Task<Order[]> GetLatestOrdersAsync(int take, CancellationToken ct)
    {
        Queries++;
        return database.QueryAsync(() => database.LatestOrders(take), ct);
    }

    // SELECT id, name FROM customers WHERE id = @id
    public Task<Customer> GetCustomerAsync(int id, CancellationToken ct)
    {
        Queries++;
        return database.QueryAsync(() => database.CustomerById(id), ct);
    }

    // SELECT id, name FROM customers WHERE id = ANY(@ids)
    public Task<Customer[]> GetCustomersAsync(IEnumerable<int> ids, CancellationToken ct)
    {
        Queries++;
        return database.QueryAsync(() => database.CustomersByIds(ids), ct);
    }
}
```

**3. The API with the bottleneck.** Replace `OrdersApi/Program.cs`:

```csharp
using OrdersApi;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<FakeDatabase>();
builder.Services.AddScoped<Db>();

var app = builder.Build();

// Report how many queries each request needed - your N+1 detector.
app.Use(async (context, next) =>
{
    var db = context.RequestServices.GetRequiredService<Db>();
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Db-Queries"] = db.Queries.ToString();
        return Task.CompletedTask;
    });
    await next();
});

app.MapGet("/health", () => "ok");

// The slow endpoint: 1 query for the orders + 1 query PER order for its customer.
app.MapGet("/orders/recent", async (Db db, CancellationToken ct, int take = 50) =>
{
    var orders = await db.GetLatestOrdersAsync(take, ct);
    var result = new List<OrderView>(orders.Length);
    foreach (var o in orders)
    {
        var customer = await db.GetCustomerAsync(o.CustomerId, ct);   // N+1 lives here
        result.Add(new OrderView(o.Id, customer.Name, o.Total, o.PlacedAt));
    }
    return result;
});

app.Run();
```

**4. Run it in Release and smoke test it.** Always load test a Release build. Keep this terminal
open.

```bash
dotnet run -c Release --no-launch-profile -- --urls http://localhost:5080
```

In a second terminal:

```bash
curl -i "http://localhost:5080/orders/recent?take=2"
```

Expected (`Date`, `Server` and `Transfer-Encoding` headers left out; the JSON is one line):

```text
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Db-Queries: 3

[{"id":20000,"customer":"Customer 1","total":9.99,"placedAt":"2026-01-14T21:20:00Z"},{"id":19999,"customer":"Customer 82","total":508.99,"placedAt":"2026-01-14T21:19:00Z"}]
```

With the default `take=50`, the header says `X-Db-Queries: 51`.

**5. The load test.** Create `~/devquest/pro-12-lab1/load.js`. It sends 100 requests per second
for 30 seconds (open model) and encodes the budget as thresholds. One threshold says no request
may need more than 3 queries.

```js
import http from 'k6/http'
import { check } from 'k6'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5080'

export const options = {
  scenarios: {
    recent_orders: {
      executor: 'constant-arrival-rate',
      rate: 100,                 // 100 new requests every second…
      timeUnit: '1s',
      duration: '30s',           // …for 30 seconds
      preAllocatedVUs: 20,
      maxVUs: 100,               // at most 100 requests in flight
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<200', 'p(99)<400'],
    checks: ['rate>0.99'],
    dropped_iterations: ['count<1'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
}

export default function () {
  const res = http.get(`${BASE_URL}/orders/recent?take=50`)
  check(res, {
    'status is 200': (r) => r.status === 200,
    'at most 3 queries': (r) => Number(r.headers['X-Db-Queries']) <= 3,
  })
}
```

Run it from `~/devquest/pro-12-lab1`:

```bash
k6 run load.js
echo "exit code: $?"

# or with Docker on Linux (podman works the same way):
docker run --rm -i --network host grafana/k6 run - < load.js
# or with Docker Desktop on macOS / Windows:
docker run --rm -i -e BASE_URL=http://host.docker.internal:5080 grafana/k6 run - < load.js
```

Expected: the test **fails**. The exact numbers depend on your machine, but the shape looks like
this (k6 v1/v2 end-of-test summary, trimmed; measured on Linux with .NET 10):

```text
  █ THRESHOLDS

    checks
    ✗ 'rate>0.99' rate=50.00%

    dropped_iterations
    ✗ 'count<1' count=124

    http_req_duration
    ✗ 'p(95)<200' p(95)=1.05s
    ✗ 'p(99)<400' p(99)=1.05s

    http_req_failed
    ✓ 'rate<0.01' rate=0.00%

ERRO[0031] thresholds on metrics 'checks, dropped_iterations, http_req_duration' have been crossed
exit code: 99
```

No request failed, yet the endpoint is unusable: the median is around 0.8 s, throughput topped out
at about 94 requests per second, and k6 had to drop iterations because 100 requests were already
in flight. (In a container or a CI log the error line is printed as
`level=error msg="thresholds on metrics ... have been crossed"`; it's the same message.) Further
up, the summary also shows `✗ at most 3 queries ↳ 0%`: every single request broke the query
budget, which points straight at the cause.

**6. Explain it before you fix it.** Use Little's Law with the numbers you have:

- Each request runs 51 queries in sequence, each holding a connection for about 2.2 ms, so a
  request uses about **112 ms of connection time**.
- The pool has 10 connections, so the maximum throughput is 10 / 0.112 s ≈ **89 requests per
  second**.
- You're sending 100 per second, more than the system can serve. The queue grows until k6 hits
  `maxVUs = 100` requests in flight, and then latency = in flight / throughput = 100 / 89 ≈
  **1.1 s**. That's the p95 k6 reported (1.05 s, with a measured ceiling of about 94 req/s
  because each fake query actually takes a little under 2.2 ms on Linux).

Note what is *not* the problem: CPU. Run `dotnet-counters monitor -n OrdersApi --counters
System.Runtime,Microsoft.AspNetCore.Hosting` in a third terminal while the test runs:
`dotnet.process.cpu.time` stays around 0.2 (a fifth of *one* core), `dotnet.gc.pause.time` is 0,
and `http.server.active_requests` climbs towards 100 as the backlog builds. The API is waiting for connections, not working.
That's the "waiting" row of the backend table.

:::tip title="On Windows the numbers are worse"
`Task.Delay(2)` waits for the OS timer, which ticks every ~15.6 ms on Windows. Each "query" then
takes about 15 ms, the N+1 is far slower, and the failure is even clearer. The fixed version still
passes comfortably.
:::

**7. Fix the bottleneck.** Replace the `/orders/recent` endpoint in `Program.cs` with a version
that loads all customers in **one** query (in EF Core this would be the projection with a JOIN you
saw earlier):

```csharp
// Fixed: 1 query for the orders + 1 query for ALL their customers.
app.MapGet("/orders/recent", async (Db db, CancellationToken ct, int take = 50) =>
{
    var orders = await db.GetLatestOrdersAsync(take, ct);
    var customers = (await db.GetCustomersAsync(orders.Select(o => o.CustomerId), ct))
        .ToDictionary(c => c.Id);
    return orders
        .Select(o => new OrderView(o.Id, customers[o.CustomerId].Name, o.Total, o.PlacedAt))
        .ToList();
});
```

Stop the API (`Ctrl+C`), start it again with the same `dotnet run -c Release …` command, and check
that `curl -i "http://localhost:5080/orders/recent"` now returns `X-Db-Queries: 2`.

**8. Verify with the same test.** Run `k6 run load.js` again, with no changes to the script:

```text
  █ THRESHOLDS

    checks
    ✓ 'rate>0.99' rate=100.00%

    dropped_iterations
    ✓ 'count<1' count=0

    http_req_duration
    ✓ 'p(95)<200' p(95)=4.8ms
    ✓ 'p(99)<400' p(99)=5.6ms

    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
exit code: 0
```

That's about 200× better at p95, from removing round trips. The application code got no faster at
all. Little's Law predicts the new ceiling: about 4.5 ms of connection time per request → about
2,200 requests per second.

**9. Stretch goals**

- Find the new ceiling: change `rate` to 1000, then 3000. Which threshold fails first, and does
  the result match your Little's Law estimate?
- Add a second scenario `stress` with `executor: 'ramping-arrival-rate'` and stages from 50 to
  3000 requests per second, so one run shows where it breaks.
- Write a GitHub Actions job (like the one in the lesson) that runs a 10-second version of
  `load.js` on every PR.

- [ ] The slow version returns `X-Db-Queries: 51` and the first `k6 run` fails its thresholds with exit code 99
- [ ] I can explain the ~1 s p95 with Little's Law (10 connections ÷ ~112 ms per request ≈ 89 req/s < 100 req/s offered)
- [ ] After the fix the endpoint returns `X-Db-Queries: 2`
- [ ] The second `k6 run` with the unchanged script passes every threshold (exit code 0) with a p95 in single-digit milliseconds
- [ ] I stopped the API and noted the before/after numbers as I would in a PR description
:::

## Which tool for which symptom

| Symptom | First tool | Usual fix |
|---|---|---|
| LCP slow, big hero image | DevTools Network / Lighthouse | Right-sized AVIF/WebP, `fetchpriority="high"`, no lazy-loading |
| LCP slow, big JS | Vite build output, bundle visualizer | Route-level `lazy()`, drop or replace heavy dependencies |
| Content jumps (CLS) | Lighthouse, Performance panel "Layout shifts" | `width`/`height`, reserved space, skeletons of the right size |
| Clicks feel laggy (INP) | React Profiler, Performance panel long tasks | Less rendering work, `memo`/compiler, `useTransition`, virtualization |
| Many requests in a staircase | Network panel waterfall | Parallel fetching, one endpoint per screen, prefetching |
| Every visit downloads everything | Response headers | `immutable` on hashed assets, `no-cache` on HTML, CDN |
| High TTFB, server CPU high | `dotnet-counters`, `dotnet-trace` | Remove hot-path work, fewer allocations, caching |
| High TTFB, server CPU low | Traces, `Server-Timing`, query counts | N+1 → JOIN, pool sizing, sync-over-async → `await` |
| One query slow | `EXPLAIN (ANALYZE, BUFFERS)`, `pg_stat_statements` | Index, sargable predicate, keyset pagination |
| Fine alone, slow under load | k6 with an arrival-rate executor | Whatever saturates first: pool, locks, thread pool, CPU |

:::cards id=pro-12-cards1 xp=15 title="Performance end to end"
Q: Why budget on p95/p99 instead of the average?
A: Latency is a skewed distribution. The average blends a fast majority with a slow tail and describes nobody. p95 is what nearly every user gets, and p99 shows the tail where timeouts and pool waits live.
Q: What are the Core Web Vitals and their "good" thresholds?
A: LCP ≤ 2.5 s (main content loaded), INP ≤ 200 ms (responsiveness to input), CLS ≤ 0.1 (visual stability). Each is judged at the p75 of real visits.
Q: Field data vs lab data?
A: Field (RUM, web-vitals) is what real users experience: true, but noisy and only after release. Lab (Lighthouse, k6) is repeatable and available before release, so it's what CI checks. You need both.
Q: What `Cache-Control` for Vite's hashed assets and for `index.html`?
A: Hashed assets: `public, max-age=31536000, immutable`. `index.html`: `no-cache` (revalidate every time), so a deploy is picked up immediately.
Q: The API is slow, but CPU is low. What does that suggest?
A: It's waiting, not working: database queries, connection pool, locks, a slow downstream call, or thread pool starvation from blocking calls. Look at traces, query counts and the thread pool queue.
Q: How do you spot an N+1?
A: Count queries per request: the same query shape repeated N times (with different ids) under one request, in EF Core logs, a trace, or a query-count test assertion.
Q: What does `Rows Removed by Filter: 1999952` in EXPLAIN ANALYZE tell you?
A: Postgres scanned far more rows than it returned. That usually means a missing or unusable index for that predicate.
Q: Open vs closed load model?
A: Closed (constant-vus): each VU waits for its response, so a slow server gets less load (coordinated omission). Open (constant-arrival-rate): requests keep arriving at the real rate, so queues and dropped iterations become visible.
Q: State Little's Law and use it.
A: Concurrency = throughput × latency. 10 connections, each request holding one for 100 ms in total → at most 100 req/s. Above that, requests queue and latency climbs.
Q: How do k6 thresholds fail a CI job?
A: When any threshold is crossed, k6 exits with code 99, so the step fails. Checks alone don't fail the run unless you add a `checks` threshold.
Q: How do you make Lighthouse CI a gate people trust?
A: Several runs with the median, assertions on specific metrics with headroom, hard limits on deterministic budgets (bundle size), and warnings for noisy timing metrics until they're stable.
:::

## Recap

- Performance work is a loop: **measure → budget → locate the layer → fix one thing → verify →
  guard in CI**. Guessing first usually means optimising the wrong part.
- Budget on **percentiles** (p95, p99) plus the error rate. Averages hide the tail, and pages that
  fan out to many calls hit the tail often. You can't average percentiles or add them up.
- Frontend budgets are the **Core Web Vitals** at p75 (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1) and
  the size of the JavaScript. Collect field data with `web-vitals`, and use Lighthouse for lab runs.
- Use the DevTools **Timing** tab and `Server-Timing` to decide quickly between browser, network,
  server and database.
- Frontend fixes: smaller bundles and route splitting, right-sized modern images for the LCP
  element, reserved space against CLS, and less rendering work for INP.
- Network fixes: `immutable` caching for hashed assets with `no-cache` HTML, compression, a CDN,
  and no request waterfalls or per-row requests.
- Backend: check whether the process is **busy or waiting** (`dotnet-counters`), profile CPU with
  `dotnet-trace`, and cache repeated work with `HybridCache`.
- Database: `EXPLAIN (ANALYZE, BUFFERS)` and indexes for bad plans, query **counts** for N+1,
  connection budgets (pods × pool < `max_connections`) for pool exhaustion.
- Load test with **k6** using an **open model** (arrival rate) and thresholds. Use Little's Law to
  predict and explain the results.
- Stop regressions with **Lighthouse CI** and **k6 thresholds** in the pipeline, and put
  before/after numbers in your PR descriptions.
