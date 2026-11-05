---
id: be-04
title: Async/Await Done Right
level: intermediate
minutes: 50
xp: 140
summary: Task and async/await, why .Result and .Wait() starve servers, running work concurrently with Task.WhenAll, CancellationToken plumbing, async void, ValueTask and IAsyncEnumerable.
---

A web server spends most of its time **waiting**: for PostgreSQL, for an HTTP API, for a file, for
Redis. Async/await lets a thread go serve someone else while it waits. Get it right and one small
container handles thousands of concurrent requests. Get it wrong — one `.Result` in the wrong place —
and the same server freezes at 50 requests per second while the CPU sits at 5 %.

The syntax will look familiar from JavaScript. The runtime underneath is different, and that's where
the bugs live.

A few terms we'll use throughout:

- **I/O-bound** work spends its time waiting on something outside the CPU — a database, the network,
  the disk. **CPU-bound** work keeps a core busy computing (hashing, resizing images, parsing a huge
  file in memory). Async/await is built for the first kind.
- A **thread** is the unit the OS schedules on a CPU core. Creating one is expensive (~1 MB of stack,
  kernel bookkeeping), so .NET reuses a shared set of them: the **thread pool**.
- **Blocking** a thread means it sits idle, holding on to its stack, until something finishes.
- A **continuation** is "the rest of the method after an `await`" — the code that runs once the
  awaited operation completes.

## Threads, the thread pool and why async exists

JavaScript has **one** thread and an event loop. .NET has **many** threads, managed by the **thread
pool**. ASP.NET Core takes each incoming request and runs your endpoint on a thread-pool thread.

Now imagine the endpoint calls the database **synchronously**:

```text
Thread #7: [ parse request ][ ......... waiting 80 ms for PostgreSQL ......... ][ write response ]
```

For those 80 ms, thread #7 is **blocked** — it can't do anything else. Under load, every pool thread
ends up blocked, new requests queue, and the pool slowly injects more threads (roughly one or two per
second — it deliberately grows slowly so it doesn't over-subscribe the CPU). Latency explodes even
though the CPU is idle. That's **thread pool starvation**.

With async I/O:

```text
Thread #7: [ parse request ][ start query → return to pool ]      (serves other requests)
Thread #3:                                       [ query done → continue → write response ]
```

While the query runs, **no thread is waiting** — the OS notifies .NET when the data arrives, and any
free pool thread picks up where the method left off.

:::info title="Async is about scalability, not speed"
An async database call isn't faster than a sync one — the query takes 80 ms either way. Async lets the
**server** handle far more concurrent requests with the same threads. For CPU-bound work (resizing an
image, hashing a password) async doesn't help; it needs real CPU time on some thread.
:::

## `Task`, `async` and `await`

A `Task` represents an operation that will complete in the future — like a JS `Promise`:

| JavaScript | C# |
|---|---|
| `Promise<void>` | `Task` |
| `Promise<T>` | `Task<T>` |
| `async function f(): Promise<number>` | `async Task<int> FAsync()` |
| `await p` | `await t` |
| `Promise.all([a, b])` | `Task.WhenAll(a, b)` |
| `Promise.race([a, b])` | `Task.WhenAny(a, b)` |
| `AbortController` / `AbortSignal` | `CancellationTokenSource` / `CancellationToken` |
| `for await (const x of stream)` | `await foreach (var x in stream)` |

```csharp
public async Task<decimal> GetOrderTotalAsync(int orderId, CancellationToken ct)
{
    var order = await db.Orders.FindAsync([orderId], ct);       // pauses here, frees the thread
    if (order is null) return 0m;

    var rate = await exchangeRates.GetRateAsync(order.Currency, ct);
    return order.Total * rate;
}
```

What the compiler does: it rewrites the method into a **state machine** — a hidden class that
stores your local variables (`order`, `rate`) in fields and remembers "which `await` am I at?". Each
`await` is a point where the method can suspend:

- If the awaited task is **already finished** (say, the row was cached), execution simply continues
  synchronously — no suspension, no thread switch.
- Otherwise the method **returns an incomplete `Task` to its caller** right there, and registers the
  rest of the method as a continuation. When the I/O completes, a pool thread runs that continuation
  with the locals restored from the state machine.

That's why `await` doesn't block: the method *returns* instead of waiting.

Two small rules:

- `async` is only needed if the method body uses `await`. A method that just passes a task through
  can return it directly: `public Task<int> CountAsync(CancellationToken ct) => db.Orders.CountAsync(ct);`
- Naming convention: async methods end in `Async` and return `Task`/`Task<T>`/`ValueTask<T>`. (Endpoint
  lambdas are the usual exception — nobody calls them by name.)

### Execution order

The code **before** the first `await` runs synchronously on the caller's thread — just like in JS:

```csharp
Console.WriteLine("A");
var task = DoWorkAsync();     // runs until its first await, then returns
Console.WriteLine("C");
await task;
Console.WriteLine("E");

static async Task DoWorkAsync()
{
    Console.WriteLine("B");
    await Task.Delay(100);
    Console.WriteLine("D");
}
// A B C D E
```

### Exceptions

An exception thrown in an async method is **stored in the Task** and rethrown when you `await` it.
That's why you must always await (or otherwise observe) tasks — an un-awaited failing task loses its
exception silently (at most it shows up much later in `TaskScheduler.UnobservedTaskException`, which
almost nobody listens to).

`await` rethrows the **original** exception, so a normal `catch (HttpRequestException)` works. Blocking
with `.Result` / `.Wait()` instead wraps it in an `AggregateException` — one more reason not to block.

```csharp
try
{
    await paymentClient.ChargeAsync(order, ct);
}
catch (HttpRequestException ex)
{
    logger.LogError(ex, "Charge failed for {OrderId}", order.Id);
}
```

## Never block on async code: `.Result`, `.Wait()`, `.GetAwaiter().GetResult()`

```csharp
// ❌ All of these BLOCK the current thread until the task finishes
var user = userService.GetUserAsync(id).Result;
userService.SaveAsync(user).Wait();
var x = client.GetStringAsync(url).GetAwaiter().GetResult();
```

This is called **sync-over-async**, and it causes two different disasters:

1. **Thread pool starvation (ASP.NET Core, workers, everywhere).** The blocked thread is waiting for
   a continuation that needs *another* pool thread to run. Under load, all threads block waiting for
   continuations that have no thread to run on. The app "hangs" with low CPU, health checks time out,
   Kubernetes restarts the pod, and the cycle repeats.

2. **Classic deadlock (UI apps — WPF, WinForms, MAUI — and old ASP.NET on .NET Framework).** Those
   environments have a `SynchronizationContext` that forces continuations back onto the original
   thread. `.Result` blocks that thread, the continuation waits for the thread, the thread waits for
   the continuation → deadlock, instantly, even with one user.

ASP.NET Core has no `SynchronizationContext`, so you usually get (1) instead of (2) — which is worse in
a way, because it passes every test and only shows up under production load. (Since .NET 6 the pool
notices threads blocked in `.Wait()`/`.Result` and adds threads a bit faster. That softens the cliff;
it doesn't remove it.)

**The rule: async all the way.** If a method awaits something, it becomes async, and so does its caller,
up to the endpoint. ASP.NET Core endpoints, middleware, hosted services, xUnit tests and `Main` (via
top-level `await`) all support async natively — there's no place where you *need* to block.

The one place people get stuck is a **constructor**, which can't be `async`. Don't call `.Result` in
it: load the data in an async factory method (`static async Task<Foo> CreateAsync()`), in the first
async method that needs it, or at startup in a hosted service.

:::pro title="ConfigureAwait(false)"
In **library** code that might be used from UI apps, you'll see `await x.ConfigureAwait(false)` — it
says "don't capture the synchronization context". In ASP.NET Core application code it has no effect
(there's no context), and most teams don't bother with it there. Don't treat it as a fix for
`.Result` deadlocks — the fix is to stop blocking.
:::

### Don't fake async with `Task.Run`

```csharp
// ❌ In an ASP.NET Core endpoint
app.MapGet("/report", async () => await Task.Run(() => BuildReportSynchronously()));
```

This takes one pool thread off the request and puts the work on… another pool thread. Nothing is
gained, and you pay for the hop. `Task.Run` is for pushing **CPU-bound** work off a **UI** thread, or
for deliberately running something in parallel. In a web request, call real async APIs
(`ToListAsync`, `GetAsync`, `ReadAsync`) instead.

## Sequential vs concurrent awaits

`await` waits **right now**. Awaiting in sequence makes calls sequential:

```csharp
// ~300 ms + ~300 ms = ~600 ms
var user = await usersApi.GetAsync(id, ct);
var orders = await ordersApi.GetForUserAsync(id, ct);
```

If the calls are **independent**, start them all, then await them together:

```csharp
// ~300 ms total — both requests are in flight at the same time
var userTask = usersApi.GetAsync(id, ct);
var ordersTask = ordersApi.GetForUserAsync(id, ct);
await Task.WhenAll(userTask, ordersTask);

var user = userTask.Result;      // ✅ fine here: the task is already completed, nothing blocks
var orders = await ordersTask;   // equally fine and more common: awaiting a finished task is instant
```

With a list:

```csharp
var tasks = skus.Select(sku => priceApi.GetPriceAsync(sku, ct));
decimal[] prices = await Task.WhenAll(tasks);     // results in the same order as the input
```

Things to know about `Task.WhenAll`:

- It waits for **all** tasks, even after one has failed. If several fail, `await` rethrows **one** of
  the exceptions (the first); the full list is in `whenAllTask.Exception.InnerExceptions` — keep a
  reference to the `WhenAll` task if you need it.
- The tasks are already running **before** `WhenAll` is called — `WhenAll` doesn't start anything, it
  just gives you one task that completes when they all have. The concurrency comes from calling the
  methods without awaiting each one.
- It doesn't limit concurrency: 10 000 SKUs = 10 000 simultaneous HTTP calls, which can exhaust
  sockets or get you rate-limited. For big batches cap the parallelism:

```csharp
var prices = new ConcurrentDictionary<string, decimal>();   // the bodies run in parallel: a plain Dictionary would corrupt
await Parallel.ForEachAsync(skus, new ParallelOptions { MaxDegreeOfParallelism = 8, CancellationToken = ct },
    async (sku, token) => prices[sku] = await priceApi.GetPriceAsync(sku, token));   // at most 8 in flight
```

:::warn title="EF Core's DbContext is not thread-safe"
```csharp
// ❌ InvalidOperationException: A second operation was started on this context instance…
var a = db.Orders.CountAsync(ct);
var b = db.Customers.CountAsync(ct);
await Task.WhenAll(a, b);
```
One `DbContext` = one connection = one query at a time. Await queries on the same context
sequentially (they're fast), or use separate contexts via `IDbContextFactory<T>` if you truly need
parallel queries.
:::

## CancellationToken: stop work nobody is waiting for

A user closes the browser tab. Their request was running a 5-second report query. Without
cancellation, the server keeps working for a response nobody will read. Multiply by a traffic spike
and you're doing lots of wasted work.

`CancellationToken` is .NET's cooperative cancellation signal (like `AbortSignal`). The pattern:
**accept a token, pass it to everything you call.**

```csharp
// Minimal API: ASP.NET Core binds CancellationToken to HttpContext.RequestAborted automatically
app.MapGet("/reports/{id:int}", async (int id, ReportService reports, CancellationToken ct) =>
    await reports.BuildAsync(id, ct));

public sealed class ReportService(AppDbContext db, HttpClient http)
{
    public async Task<Report> BuildAsync(int id, CancellationToken ct)
    {
        var rows = await db.Sales.Where(s => s.ReportId == id).ToListAsync(ct);     // ✅ passed down
        var fx = await http.GetFromJsonAsync<Rates>("/rates", ct);                 // ✅ passed down

        foreach (var row in rows)
        {
            ct.ThrowIfCancellationRequested();     // for long CPU loops: check periodically
            // … crunch …
        }
        return new Report(/* … */);
    }
}
```

"Cooperative" means nothing is forcibly stopped: the token is just a flag that code checks. The
framework APIs you pass it to (`ToListAsync`, `GetAsync`, `Task.Delay`) check it for you; your own
loops check it with `ThrowIfCancellationRequested()`. If you don't pass the token on, cancelling it
does nothing.

When the token is cancelled, awaiting cancellable operations throws `OperationCanceledException`
(or its subclass `TaskCanceledException`). ASP.NET Core recognises it for aborted requests, so you
usually **don't catch it** in endpoints. If you *do* catch exceptions broadly (`catch (Exception)`),
let cancellation through — otherwise you'll log a "failure" for every user who closed a tab.

Timeouts are cancellation too:

```csharp
using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);  // cancelled if the caller cancels…
cts.CancelAfter(TimeSpan.FromSeconds(2));                              // …or after 2 seconds
var price = await supplier.GetPriceAsync(sku, cts.Token);
```

Always dispose `CancellationTokenSource` (`using`) — it may hold a timer.

:::job title="Review comment you'll see: 'pass the token'"
A method that takes a `CancellationToken` but calls `ToListAsync()` without it is a very common review
finding. Make it a habit: every async method in the call chain gets `CancellationToken ct` (often as
the last parameter, `= default` in library APIs), and every call passes it on. Analyzer **CA2016**
flags missed tokens — many teams turn it into an error.
:::

## `async void`: the one to avoid

```csharp
// ❌ async void
public async void SendWelcomeEmail(User user)
{
    await emailSender.SendAsync(user.Email, "Welcome!", "…");
}
```

An `async void` method returns nothing awaitable, so:

- the caller **can't await it** — it can't know when it finished or whether it failed;
- an exception inside it **can't be caught** by the caller. It's raised on the thread pool and, in
  .NET, an unhandled exception there **crashes the process**;
- in ASP.NET Core, it can keep running after the request ended, using a disposed `DbContext`.

`async void` exists only for **event handlers** (`button.Click += async (s, e) => …` in UI apps).
Everywhere else, return `Task`.

Watch out for the **hidden** version: a lambda passed to a parameter of type `Action` becomes async
void. `list.ForEach(async x => await SaveAsync(x));` fires all saves and returns immediately. Use a
normal `foreach` with `await`.

### Fire-and-forget

Not awaiting a task on purpose ("send the email in the background") is just as dangerous in a web
request: the request scope (and its `DbContext`) is disposed when the response is sent. The robust
patterns are a **background queue** (`Channel<T>` + `BackgroundService`) or a real job system
(Hangfire, Quartz, a message broker). Inside an `async` method the compiler warns about un-awaited
calls (CS4014) — treat that warning as an error; in a non-async method there is no warning at all,
so review for it.

## `ValueTask<T>` (briefly)

`ValueTask<T>` is a struct that avoids allocating a `Task` when the result is often available
synchronously (a cache hit, a buffered read):

```csharp
public ValueTask<Product?> GetAsync(int id, CancellationToken ct) =>
    _cache.TryGetValue(id, out var p)
        ? ValueTask.FromResult<Product?>(p)          // no allocation
        : new ValueTask<Product?>(LoadAsync(id, ct)); // fall back to a real Task
```

Rules: await a `ValueTask` **exactly once**, don't await it concurrently, and don't call `.Result`
on it before it's completed. If in doubt, use `Task` — `ValueTask` is a performance optimisation for
hot paths, and you'll mostly meet it as the return type of framework APIs (`IExceptionHandler`,
`DisposeAsync`).

## `IAsyncEnumerable<T>`: async streams

`IAsyncEnumerable<T>` is an `IEnumerable<T>` whose items arrive asynchronously — a paged API, rows from
a database, lines of a large file:

```csharp
public async IAsyncEnumerable<Order> StreamOrdersAsync([EnumeratorCancellation] CancellationToken ct = default)
{
    var page = 1;
    while (true)
    {
        var batch = await api.GetOrdersPageAsync(page++, ct);
        if (batch.Count == 0) yield break;
        foreach (var order in batch) yield return order;
    }
}

await foreach (var order in StreamOrdersAsync(ct))
{
    await ProcessAsync(order, ct);
}
```

- `[EnumeratorCancellation]` lets callers pass a token via `.WithCancellation(ct)` too.
- EF Core queries can be streamed with `AsAsyncEnumerable()`.
- ASP.NET Core can return an `IAsyncEnumerable<T>` from an endpoint and `System.Text.Json` streams
  it to the client as a JSON array — without buffering everything in memory.

## Check yourself

:::quiz id=be-04-q1
What does this print?

```csharp
Console.WriteLine("1");
var task = LoadAsync();
Console.WriteLine("3");
await task;
Console.WriteLine("5");

static async Task LoadAsync()
{
    Console.WriteLine("2");
    await Task.Delay(100);
    Console.WriteLine("4");
}
```

- [ ] `1 3 2 4 5`
- [x] `1 2 3 4 5`
- [ ] `1 3 5 2 4`
- [ ] `1 2 4 3 5`
> An async method runs **synchronously until its first incomplete `await`**. So `2` prints during the call to `LoadAsync()`, then control returns to the caller (`3`), and the rest (`4`) runs when the delay finishes, before `await task` completes (`5`). The tempting `1 3 2 4 5` assumes calling an async method "schedules it for later" — it doesn't: the call itself starts running the body immediately (exactly like an `async function` in JavaScript).
:::

:::quiz id=be-04-q2
Each call takes about 500 ms and they don't depend on each other. Roughly how long does this endpoint take?

```csharp
var profile = await profileApi.GetAsync(id, ct);
var orders = await ordersApi.GetAsync(id, ct);
var recommendations = await recoApi.GetAsync(id, ct);
```

- [ ] ~500 ms — `await` runs them in parallel
- [x] ~1500 ms — each `await` waits before the next call starts
- [ ] ~0 ms — the calls are async
> `await` pauses the method until that task completes, and the next line — which *starts* the next call — only runs afterwards, so the calls run one after another. "Async" means the thread is free while waiting, not that the calls overlap; that's why ~500 ms is wrong. Start all three first (`var p = profileApi.GetAsync(id, ct);` …) and then `await Task.WhenAll(p, o, r)` for ~500 ms total.
:::

:::quiz id=be-04-q3
An ASP.NET Core endpoint does `var user = repo.GetUserAsync(id).Result;`. It works fine in development. What typically happens in production under load?

- [ ] An instant deadlock on the first request
- [ ] Nothing — ASP.NET Core has no synchronization context, so `.Result` is safe
- [x] Thread pool starvation: threads block waiting, requests queue up, latency spikes while CPU stays low
- [ ] A compile error in Release mode
> ASP.NET Core has no `SynchronizationContext`, so you don't get the classic UI-style instant deadlock (that's WPF/WinForms/old ASP.NET). But "no deadlock" doesn't mean safe: each `.Result` **blocks** a pool thread for the whole I/O wait. Under concurrency, the pool runs out of threads and grows only slowly. The compiler doesn't complain either. The fix is `await` all the way up.
:::

:::quiz id=be-04-q4
Which method signature is the **dangerous** one?

- [ ] `public async Task SendAsync(Email email, CancellationToken ct)`
- [ ] `public Task<int> CountAsync(CancellationToken ct)`
- [x] `public async void SendAsync(Email email)`
- [ ] `public async ValueTask<User?> FindAsync(int id)`
> `async void` can't be awaited, the caller can't catch its exceptions, and an unhandled exception in it crashes the process. Only use it for UI event handlers. The others are fine: `Task<int> CountAsync` without `async` just returns a task directly (legal and common), and a `ValueTask` return without a `CancellationToken` is a missed opportunity, not a danger.
:::

:::quiz id=be-04-q5
Spot the bug.

```csharp
app.MapGet("/search", async (string q, AppDbContext db, CancellationToken ct) =>
{
    var products = await db.Products
        .Where(p => p.Name.Contains(q))
        .Take(50)
        .ToListAsync();
    return Results.Ok(products);
});
```

- [ ] `CancellationToken` can't be injected into a minimal API
- [x] `ct` is accepted but never passed to `ToListAsync`, so the query keeps running if the client disconnects
- [ ] `Take(50)` must come before `Where`
- [ ] `ToListAsync` must be `ToList`
> Accepting a token does nothing unless you pass it on: `ToListAsync(ct)`. Analyzer CA2016 ("forward the CancellationToken parameter") catches exactly this. Injecting `CancellationToken` into a minimal API is fully supported (it's bound to `HttpContext.RequestAborted`), and `Where(...).Take(50)` is the correct order — filter first, then limit.
:::

:::quiz id=be-04-q6
What's wrong with this code?

```csharp
foreach (var user in users)
{
    _ = emailSender.SendAsync(user.Email, "News", body);   // "faster: don't wait"
}
return Results.Ok();
```

- [ ] Nothing, it sends emails in parallel
- [x] Failures are never observed, nothing limits concurrency, and the work may outlive the request scope
- [ ] It doesn't compile: you must await
- [ ] It sends every email twice
> Discarding the task (`_ =`) is fire-and-forget: exceptions vanish, 50 000 users means 50 000 simultaneous sends, and any scoped services used by `SendAsync` may be disposed after the response. It **does** compile — inside an async method the `_ =` discard is exactly what silences warning CS4014, and in a non-async handler there's no warning in the first place, which is why this bug slips through. Use `await Task.WhenAll(...)` with a concurrency limit, or enqueue a background job.
:::

:::quiz id=be-04-q7
Which statements about `CancellationToken` are true? (select all)

- [x] In a minimal API, a `CancellationToken` parameter is bound to the request-aborted token automatically
- [x] Cancellation is cooperative: code must pass the token on or check it
- [ ] Cancelling a token forcibly kills the thread running the task
- [x] `CancellationTokenSource.CancelAfter` is a common way to implement a timeout
> .NET never aborts threads (`Thread.Abort` isn't even supported on modern .NET), so the "forcibly kills" option is false. Cancellation is a signal; APIs that accept the token throw `OperationCanceledException` when it fires, and long loops call `ct.ThrowIfCancellationRequested()`. In minimal APIs the token parameter is bound to `HttpContext.RequestAborted`, and `CancelAfter` turns a token source into a timeout.
:::

:::quiz id=be-04-q8
Two tasks run on the **same** EF Core `DbContext` with `Task.WhenAll`. What happens?

```csharp
var count = db.Orders.CountAsync(ct);
var latest = db.Orders.OrderByDescending(o => o.Id).FirstOrDefaultAsync(ct);
await Task.WhenAll(count, latest);
```

- [ ] Both queries run in parallel on one connection — faster
- [x] `InvalidOperationException`: a second operation started on this context before the previous one completed
- [ ] EF Core queues them automatically
- [ ] Deadlock
> A `DbContext` wraps a single database connection and isn't thread-safe, so it supports one operation at a time. EF Core detects the overlap and throws rather than queuing or silently running both. Await them sequentially (two fast queries cost a few ms more), or create separate contexts with `IDbContextFactory<T>`.
:::

:::quiz id=be-04-q9
Spot the bug. The endpoint returns `200 OK` immediately, and some orders are never saved.

```csharp
app.MapPost("/orders/import", (List<Order> orders, OrderService service) =>
{
    orders.ForEach(async o => await service.SaveAsync(o));
    return Results.Ok();
});
```

- [ ] `List<Order>` can't be bound from the JSON body
- [x] `List<T>.ForEach` takes an `Action<T>`, so the async lambda becomes `async void`: nothing awaits the saves, and failures can't be caught
- [ ] `ForEach` runs the saves sequentially, which is merely slow
- [ ] The handler must return `Task<IResult>` explicitly
> `ForEach(Action<T>)` has no way to wait for a `Task`, so the compiler turns `async o => …` into an `async void` lambda. Each call starts a save and returns at its first `await`; the endpoint responds before the saves finish, the scoped services they use get disposed, and an exception can crash the process. It's not "sequential but slow" — nothing waits at all. Use `foreach (var o in orders) await service.SaveAsync(o);` (or `Task.WhenAll` if the service is safe for concurrent use).
:::

:::quiz id=be-04-q10
An ASP.NET Core endpoint wraps an EF Core query like this. What does `Task.Run` buy you here?

```csharp
app.MapGet("/orders", async (AppDbContext db) =>
    await Task.Run(() => db.Orders.ToList()));
```

- [ ] It makes the query non-blocking, so the server scales better
- [ ] It runs the query faster on a background thread
- [x] Nothing useful: the synchronous `ToList()` still blocks a pool thread — just a different one — and you pay for an extra thread hop
- [ ] It prevents the `DbContext` from being disposed early
> In a web app there is no "UI thread" to protect: every request already runs on a pool thread. `Task.Run` moves the blocking `ToList()` to *another* pool thread, so one thread is still blocked for the whole query — the scalability problem is unchanged, and the query isn't faster. The fix is a truly async API — add a `CancellationToken ct` parameter and use `await db.Orders.ToListAsync(ct)`.
:::

## Lab: a concurrent price aggregator

:::lab id=be-04-lab1 xp=100
title: WhenAll, timeouts, cancellation and async streams

You'll build a `PriceAggregator` that asks several suppliers for a price **in parallel**, gives each
one a time budget, skips failures, respects the caller's cancellation, and can stream results as they
arrive. Fake suppliers with `Task.Delay` make the tests deterministic.

(New to `dotnet new`, `dotnet test` and `[Fact]`? The box at the start of the be-01 lab covers the minimum; be-05 and be-14 explain the CLI and xUnit in full.)

**1. Create the projects**

```bash
mkdir AsyncLab && cd AsyncLab
dotnet new sln -n AsyncLab
dotnet new classlib -o src/AsyncLab
dotnet new xunit -o tests/AsyncLab.Tests
dotnet sln add src/AsyncLab tests/AsyncLab.Tests
dotnet add tests/AsyncLab.Tests reference src/AsyncLab
rm src/AsyncLab/Class1.cs tests/AsyncLab.Tests/UnitTest1.cs
```

**2. The tests first: `tests/AsyncLab.Tests/PriceAggregatorTests.cs`**

Read them — they're the spec.

```csharp
using System.Diagnostics;
using AsyncLab;

namespace AsyncLab.Tests;

public class PriceAggregatorTests
{
    private sealed class FakeSource(string name, decimal price, int delayMs, bool fails = false) : IPriceSource
    {
        public string Name => name;
        public async Task<decimal> GetPriceAsync(string sku, CancellationToken ct)
        {
            await Task.Delay(delayMs, ct);           // honours cancellation
            if (fails) throw new HttpRequestException($"{name} is down");
            return price;
        }
    }

    [Fact]
    public async Task Returns_the_cheapest_quote()
    {
        var aggregator = new PriceAggregator(
            [new FakeSource("A", 10m, 50), new FakeSource("B", 8m, 80), new FakeSource("C", 12m, 10)],
            TimeSpan.FromSeconds(2));

        var best = await aggregator.GetBestQuoteAsync("SKU-1");

        Assert.Equal(new Quote("B", 8m), best);
    }

    [Fact]
    public async Task Calls_sources_in_parallel_not_one_after_another()
    {
        var aggregator = new PriceAggregator(
            [new FakeSource("A", 1m, 300), new FakeSource("B", 2m, 300), new FakeSource("C", 3m, 300)],
            TimeSpan.FromSeconds(2));

        var sw = Stopwatch.StartNew();
        await aggregator.GetBestQuoteAsync("SKU-1");
        sw.Stop();

        Assert.True(sw.ElapsedMilliseconds < 800, $"took {sw.ElapsedMilliseconds} ms - are you awaiting in a loop?");
    }

    [Fact]
    public async Task Slow_and_failing_sources_are_skipped()
    {
        var aggregator = new PriceAggregator(
            [new FakeSource("Slow", 1m, 5_000), new FakeSource("Broken", 2m, 10, fails: true), new FakeSource("Ok", 9m, 10)],
            TimeSpan.FromMilliseconds(200));

        var best = await aggregator.GetBestQuoteAsync("SKU-1");

        Assert.Equal(new Quote("Ok", 9m), best);
    }

    [Fact]
    public async Task Returns_null_when_nobody_answers()
    {
        var aggregator = new PriceAggregator([new FakeSource("Broken", 2m, 10, fails: true)], TimeSpan.FromSeconds(1));

        Assert.Null(await aggregator.GetBestQuoteAsync("SKU-1"));
    }

    [Fact]
    public async Task Caller_cancellation_is_propagated_not_swallowed()
    {
        var aggregator = new PriceAggregator([new FakeSource("Slow", 1m, 5_000)], TimeSpan.FromSeconds(10));
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => aggregator.GetBestQuoteAsync("SKU-1", cts.Token));
    }

    [Fact]
    public async Task Streams_quotes_fastest_first()
    {
        var aggregator = new PriceAggregator(
            [new FakeSource("Slow", 1m, 300), new FakeSource("Fast", 2m, 10), new FakeSource("Mid", 3m, 100)],
            TimeSpan.FromSeconds(2));

        var names = new List<string>();
        await foreach (var quote in aggregator.StreamQuotesAsync("SKU-1"))
            names.Add(quote.Source);

        Assert.Equal(["Fast", "Mid", "Slow"], names);
    }
}
```

**3. Your turn: `src/AsyncLab/PriceAggregator.cs`.** Start from this skeleton and make the tests pass.

```csharp
using System.Runtime.CompilerServices;

namespace AsyncLab;

public interface IPriceSource
{
    string Name { get; }
    Task<decimal> GetPriceAsync(string sku, CancellationToken ct);
}

public record Quote(string Source, decimal Price);

public sealed class PriceAggregator(IEnumerable<IPriceSource> sources, TimeSpan perCallTimeout)
{
    private readonly IReadOnlyList<IPriceSource> _sources = sources.ToList();

    public Task<Quote?> GetBestQuoteAsync(string sku, CancellationToken ct = default) =>
        throw new NotImplementedException();

    public IAsyncEnumerable<Quote> StreamQuotesAsync(string sku, CancellationToken ct = default) =>
        throw new NotImplementedException();
}
```

Hints: write a private `TryGetQuoteAsync(source, sku, ct)` that returns `Quote?` (null on timeout or
failure). Use `CancellationTokenSource.CreateLinkedTokenSource(ct)` + `CancelAfter`. Distinguish *our*
timeout from the *caller's* cancellation with an exception filter: `catch (OperationCanceledException) when (!ct.IsCancellationRequested)`.
For streaming, `Task.WhenAny` in a loop returns whichever task finishes next.

:::tip title="Reference solution (try first!)"
```csharp
using System.Runtime.CompilerServices;

namespace AsyncLab;

public interface IPriceSource
{
    string Name { get; }
    Task<decimal> GetPriceAsync(string sku, CancellationToken ct);
}

public record Quote(string Source, decimal Price);

public sealed class PriceAggregator(IEnumerable<IPriceSource> sources, TimeSpan perCallTimeout)
{
    private readonly IReadOnlyList<IPriceSource> _sources = sources.ToList();

    /// Ask every source IN PARALLEL. Sources that fail or exceed the timeout are skipped.
    public async Task<Quote?> GetBestQuoteAsync(string sku, CancellationToken ct = default)
    {
        var tasks = _sources.Select(source => TryGetQuoteAsync(source, sku, ct));
        var quotes = await Task.WhenAll(tasks);

        ct.ThrowIfCancellationRequested();   // the CALLER cancelling is not "no quotes" - it's cancellation
        return quotes.OfType<Quote>().MinBy(q => q.Price);
    }

    private async Task<Quote?> TryGetQuoteAsync(IPriceSource source, string sku, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(perCallTimeout);
        try
        {
            var price = await source.GetPriceAsync(sku, timeout.Token);
            return new Quote(source.Name, price);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return null;   // our per-call timeout fired: skip this source
        }
        catch (HttpRequestException)
        {
            return null;   // source is down: skip it
        }
    }

    /// Stream quotes as each source answers (fastest first).
    public async IAsyncEnumerable<Quote> StreamQuotesAsync(string sku, [EnumeratorCancellation] CancellationToken ct = default)
    {
        var pending = _sources.Select(s => TryGetQuoteAsync(s, sku, ct)).ToList();
        while (pending.Count > 0)
        {
            var finished = await Task.WhenAny(pending);
            pending.Remove(finished);
            if (await finished is { } quote) yield return quote;
        }
    }
}
```
Note `.ToList()` in `StreamQuotesAsync`: it starts every call **once** and keeps the tasks. If you kept
the lazy `Select` and passed it to `Task.WhenAny` repeatedly, every enumeration would start a **new**
round of calls — deferred execution from be-03, biting in async code.
:::

**4. Run `dotnet test`** from the `AsyncLab` folder. Expected (the timing will vary a little):

```text
Passed!  - Failed:     0, Passed:     6, Skipped:     0, Total:     6, Duration: 1 s - AsyncLab.Tests.dll (net10.0)
```

The whole suite should take about a second; if it takes 3+ seconds, something is sequential. Before
you implement anything, the skeleton fails all 6 tests with `NotImplementedException` — that's your
starting point.

**5. Break it to learn:**

Undo each change before trying the next one.

- Replace `Task.WhenAll` with a `foreach` that awaits each source in turn. Which test fails?
  (Expect `Calls_sources_in_parallel_not_one_after_another`: three 300 ms calls now take ~900 ms.)
- Remove the `when (!ct.IsCancellationRequested)` filter. Surprise: everything still passes — the
  `ct.ThrowIfCancellationRequested()` line in `GetBestQuoteAsync` is a second safety net. Now remove
  that line too. `Caller_cancellation_is_propagated_not_swallowed` fails: the caller's cancellation is
  swallowed and turned into "no quote" (`null`). Why is that the wrong behaviour for the caller?
- In `TryGetQuoteAsync`, pass `ct` straight to `GetPriceAsync` instead of `timeout.Token`. Which test
  fails, and how long does the run take now? (Expect `Slow_and_failing_sources_are_skipped`, after
  ~5 s: nothing stops the slow source, and its price of 1 wins.)

- [ ] All 6 tests pass in about a second
- [ ] I saw `Calls_sources_in_parallel_not_one_after_another` fail with sequential awaits
- [ ] I can explain the difference between our timeout and the caller's cancellation
- [ ] I know why `async void` and `.Result` appear nowhere in this code
:::

## Flashcards

:::cards id=be-04-cards1 title="Async/await"
Q: What problem does async/await solve on a server?
A: Threads don't sit blocked during I/O waits, so the same thread pool serves many more concurrent requests. It's scalability, not raw speed.
Q: What is thread pool starvation?
A: All pool threads are blocked (e.g. on `.Result`), new work queues up and the pool grows slowly — high latency with low CPU.
Q: Why does `.Result` deadlock in WPF but "only" starve in ASP.NET Core?
A: WPF has a SynchronizationContext that sends continuations back to the blocked UI thread. ASP.NET Core has none, so it blocks pool threads instead.
Q: How do you run two independent async calls concurrently?
A: Start both (store the tasks), then `await Task.WhenAll(t1, t2)`.
Q: What happens to an exception in an un-awaited task?
A: It's stored in the task and never observed — silently lost.
Q: Why is `async void` dangerous?
A: It can't be awaited, its exceptions can't be caught by the caller and can crash the process. Only for event handlers.
Q: How does a minimal API get a CancellationToken?
A: Add a `CancellationToken` parameter; it's bound to `HttpContext.RequestAborted`.
Q: How do you add a timeout to an async call?
A: `using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct); cts.CancelAfter(timeout);` and pass `cts.Token`.
Q: Why prefer `await` over `.Result` for getting an exception?
A: `await` rethrows the original exception; `.Result`/`.Wait()` wrap it in an `AggregateException` — and block a thread.
Q: How do you cap concurrency for a big batch of async calls?
A: `Parallel.ForEachAsync` with `MaxDegreeOfParallelism` (or a `SemaphoreSlim`). `Task.WhenAll` alone starts everything at once.
Q: `ValueTask` rules?
A: Await exactly once, never concurrently; use it only for hot paths that often complete synchronously.
Q: What is `IAsyncEnumerable<T>`?
A: An async stream consumed with `await foreach`; items arrive over time (paged APIs, DB rows, file lines).
:::

## Recap

- Async frees threads during I/O; that's what lets ASP.NET Core scale. It doesn't speed up CPU work.
- An async method runs synchronously until its first incomplete `await`; exceptions live in the Task.
- **Never block** on tasks (`.Result`, `.Wait()`, `GetAwaiter().GetResult()`): starvation on servers,
  deadlocks in UI apps. Async all the way.
- Sequential `await`s are sequential. Use `Task.WhenAll` for independent work — cap big batches with
  `Parallel.ForEachAsync`, and respect the one-operation-per-`DbContext` rule.
- Accept a `CancellationToken` and **pass it on**; use linked sources + `CancelAfter` for timeouts.
- No `async void` (except UI events — and watch for `List.ForEach(async …)`), no fire-and-forget in
  requests, no `Task.Run` to fake async.
- `ValueTask` = allocation optimisation; `IAsyncEnumerable` + `await foreach` = async streams.
