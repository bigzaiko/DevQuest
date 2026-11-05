---
id: be-19
title: Resilience & Observability
level: expert
minutes: 65
xp: 200
summary: Liveness vs readiness health checks, OpenTelemetry traces/metrics/logs, correlation ids, rate limiting, resilient HttpClient with retries/circuit breakers/timeouts, and graceful degradation.
---

In production, everything fails sooner or later. The database restarts for a minor-version
upgrade, the billing service has a bad deploy, a customer's script hammers your API at 200
requests per second, and a single pod gets wedged with a full thread pool. A production backend
needs two qualities:

- **Observability**: when something goes wrong you can tell *what*, *where*, and *for whom*,
  from traces, metrics and logs, without SSH-ing into a box.
- **Resilience**: when a dependency misbehaves, your service bends instead of breaking. It retries
  what's transient, stops hammering what's down, protects itself from overload, and degrades
  gracefully.

This lesson wires both into the Projects API with the tools a .NET 10 team uses: ASP.NET Core
health checks, **OpenTelemetry**, the built-in **rate limiter**, and
**Microsoft.Extensions.Http.Resilience** (Polly v8 under the hood).

## Health checks: `/health/live` vs `/health/ready`

An orchestrator like Kubernetes can't look inside your process, so it asks over HTTP. A
**probe** is a request the kubelet (the Kubernetes agent on each node) sends to your pod on a
schedule; a `2xx`/`3xx` answer is a pass, anything else (or a timeout) is a failure. There are
different probes for different questions, and the orchestrator reacts to each failure
differently. Mixing them up causes outages.

| Probe | Question | On failure | Should check |
|---|---|---|---|
| **Liveness** `/health/live` | "Is this process alive, or wedged beyond repair?" | **Restart** the container | Almost nothing: the process can answer HTTP |
| **Readiness** `/health/ready` | "Can this instance serve traffic **right now**?" | **Remove from the load balancer** (no restart) | Critical dependencies: database, required caches |
| **Startup** | "Has it finished booting (migrations, warm-up)?" | Keep waiting, up to `failureThreshold × periodSeconds`. Then **restart** the container. Liveness and readiness probes don't run until it passes | Same as readiness, or a "started" flag |

The classic mistake is putting the database check in **liveness**. During a 30-second database
failover, every pod fails liveness, and Kubernetes **restarts all of them at the same time**.
They come back cold, all hit the database at once, and a blip turns into a full outage. Database
down means **not ready**, not *dead*.

```csharp
builder.Services.AddHealthChecks()
    .AddNpgSql(builder.Configuration.GetConnectionString("Projects")!,       // AspNetCore.HealthChecks.NpgSql
        name: "postgres", tags: ["ready"], timeout: TimeSpan.FromSeconds(3));
    // or, reusing EF Core's connection: .AddDbContextCheck<AppDbContext>(tags: ["ready"])
    //   (package Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore)

app.MapHealthChecks("/health/live",  new HealthCheckOptions { Predicate = _ => false });   // no checks
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });
```

```yaml
# Kubernetes deployment (excerpt)
livenessProbe:
  httpGet: { path: /health/live, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /health/ready, port: 8080 }
  periodSeconds: 5
  failureThreshold: 2
startupProbe:
  httpGet: { path: /health/ready, port: 8080 }
  periodSeconds: 2
  failureThreshold: 30        # up to 60 s to boot
```

Because a startup failure **restarts** the pod, pointing the startup probe at `/health/ready` means
a pod that boots during a long database outage is restarted every 60 s. Do that only if
restarting is the retry you want; otherwise point it at `/health/live` or a dedicated "started"
flag check, and let readiness keep traffic away until the database is back.

More details that matter in production:

- By default, `Healthy` and `Degraded` return **200** and `Unhealthy` returns **503**. Use
  `Degraded` for "works, but slowly / with a fallback" so you don't pull an instance out of
  rotation for a non-critical problem.
- Checks run **on every probe request**. Keep them cheap (`SELECT 1`, not a table scan) and give them
  timeouts. Several replicas × a probe every 5 s adds up.
- Don't put **non-critical** dependencies in readiness. If the avatar service is down and every
  instance reports "not ready", you've taken down the whole API for a missing profile picture.
- Health output names your dependencies. Don't expose details publicly: serve them on an internal
  port (`RequireHost("*:8081")`), behind auth, or only return the status code.
- For a background worker (be-16) that serves no HTTP, a common liveness pattern is a
  **heartbeat**: the worker loop records "last iteration at", and a check fails if it's older
  than N × the poll interval.

:::quiz id=be-19-q1 xp=15
The team adds the Postgres check to **both** `/health/live` and `/health/ready`. The managed
database fails over, which takes 40 seconds. What happens to the 6 API pods?

- [ ] They're removed from the load balancer and come back when the database does
- [x] Liveness fails on all 6, and Kubernetes restarts every pod simultaneously. They return cold and stampede the recovering database, which turns a 40 s blip into a longer outage
- [ ] Nothing, because health checks are cached for 5 minutes
- [ ] Only one pod restarts at a time, because Kubernetes staggers liveness restarts
> Liveness answers "should I be killed?", and a database outage isn't fixed by restarting your app. The first option is what you'd get with the check **only** in readiness: pods leave the load balancer and return when the database does. Once the same check is also in liveness, the restart wins. Kubernetes doesn't stagger liveness restarts across pods, and probe results aren't cached. Keep dependency checks in readiness, which removes pods from traffic without restarting them.
:::

## OpenTelemetry: traces, metrics, logs

**Telemetry** is the data your app emits about itself while it runs. **OpenTelemetry (OTel)** is
the vendor-neutral standard for producing and shipping it. You instrument once and export over
**OTLP** (the OpenTelemetry Protocol, gRPC on port 4317 or HTTP on 4318) to whatever backend the
company uses: Grafana (Tempo/Prometheus/Loki), Jaeger, Datadog, Honeycomb, Azure Monitor, or the
.NET Aspire dashboard locally. Switching vendors later means changing an endpoint, not your code.

Two terms first. A **span** is one timed operation: "handle `GET /projects/42`", "run this SQL",
"call billing". Each span records a start, a duration, a status and tags. Spans nest: the SQL span
is a *child* of the request span. A **trace** is the whole tree of spans for one request, linked
by a shared **trace id**, even when the spans come from different services. In .NET a span is
called an `Activity`.

| Signal | Answers | .NET API |
|---|---|---|
| **Traces** | "Where did *this* request spend its 1.8 s, across services?" | `ActivitySource` / `Activity` (a span) |
| **Metrics** | "What's the p99 latency / error rate / queue depth *over time*?" | `Meter`, `Counter<T>`, `Histogram<T>`, `ObservableGauge<T>` |
| **Logs** | "What exactly happened, with which values?" | `ILogger` (structured), exported via the OTel logging provider |

.NET has had these primitives built in (`System.Diagnostics`) for years, and OTel just collects
and exports them. ASP.NET Core, `HttpClient`, Npgsql and EF Core already emit spans and metrics,
so most of the work is turning them on:

```csharp
var otel = builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("projects-api"))          // service.name on every signal
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation(o => o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health"))
        .AddHttpClientInstrumentation()
        .AddNpgsql()                                                 // package Npgsql.OpenTelemetry
        .AddSource("Projects.Jobs"))                                 // your own ActivitySource
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()                              // http.server.request.duration …
        .AddHttpClientInstrumentation()
        .AddMeter("System.Runtime")                                  // GC, thread pool, exceptions (built into .NET 9+)
        .AddMeter("Projects.Api"));
builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.IncludeFormattedMessage = true; });

if (!string.IsNullOrEmpty(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
    otel.UseOtlpExporter();                                         // one exporter for all three signals
```

Two details in that block are easy to miss. The `Filter` drops spans for health probes, which
would otherwise be most of your traces. And `UseOtlpExporter()` runs only when an endpoint is
configured, so the app starts fine on a laptop with no collector.

Try it locally with the standalone Aspire dashboard:

```bash
docker run --rm -it -p 18888:18888 -p 4317:18889 mcr.microsoft.com/dotnet/aspire-dashboard:latest
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
dotnet run        # open http://localhost:18888 (login token is printed in the container log)
```

### Custom spans and metrics

```csharp
public class ExportJobHandler(ILogger<ExportJobHandler> log)
{
    private static readonly ActivitySource Source = new("Projects.Jobs");

    public async Task HandleAsync(ExportJob job, CancellationToken ct)
    {
        using var activity = Source.StartActivity("export-project");   // null if nobody listens: cheap
        activity?.SetTag("project.id", job.ProjectId);
        var pages = await ExportPagesAsync(job, ct);                   // the actual work
        log.LogInformation("Exported {ProjectId} in {Pages} pages", job.ProjectId, pages);
    }
}

public class ProjectsMetrics
{
    private readonly Counter<long> _quotaLookups;
    public ProjectsMetrics(IMeterFactory meterFactory)                 // DI-friendly and testable
    {
        var meter = meterFactory.Create("Projects.Api");
        _quotaLookups = meter.CreateCounter<long>("projects.quota.lookups", unit: "{lookup}");
    }
    public void QuotaLookup(string outcome) => _quotaLookups.Add(1, new KeyValuePair<string, object?>("outcome", outcome));
}
```

Rules that keep telemetry useful and affordable:

- **Metric tags must have low cardinality.** `outcome=ok|degraded`, `route=/projects/{id}` are
  fine. **Never** put a user id, project id or raw URL in a metric tag: every distinct value
  creates a new time series, and your metrics bill or Prometheus explodes. High-cardinality
  values belong on **spans** and in **logs**.
- Use **structured logging** with message templates (`{ProjectId}`), never string interpolation,
  so backends can filter by field.
- **Propagation is automatic** over HTTP. `HttpClient` sends the W3C `traceparent` header and
  ASP.NET Core continues the trace. For queues (be-16) nothing carries it for you: store
  `Activity.Current?.Id` (which *is* the traceparent string) in the job payload and start the
  consumer's activity with it as the parent, so a trace spans API → queue → worker:

  ```csharp
  // producer: job.TraceParent = Activity.Current?.Id;
  using var activity = Source.StartActivity("export-project", ActivityKind.Consumer, job.TraceParent);
  ```
- **Sample** traces in high-traffic production (e.g. `ParentBasedSampler(new TraceIdRatioBasedSampler(0.1))`)
  and keep metrics unsampled. Metrics are cheap aggregates.

:::quiz id=be-19-q2 xp=15
Which metric design will get you a stern message from the platform team?

- [ ] `http.server.request.duration` with tags `http.route="/projects/{id}"` and `http.response.status_code`
- [x] `projects.saves` counter with tag `project.id` set to the project's GUID
- [ ] `jobs.queue.depth` observable gauge with tag `queue="exports"`
- [ ] `projects.quota.lookups` counter with tag `outcome="ok" | "degraded"`
> Every unique tag combination is a separate time series. With 200k projects that's 200k series for one counter. The other three look similar but are bounded: `http.route` is the route **template** (a few dozen values, not one per id), status codes are a small set, and `queue` and `outcome` have a handful of values each. Put ids on spans and logs, and keep metric tags to small, bounded sets.
:::

## Correlation ids

You built a `CorrelationIdMiddleware` in be-09: accept `X-Correlation-Id` (or make one up), echo it
in the response, and put it in a logging scope. That's still the right shape. With OpenTelemetry in
place, it needs three upgrades.

A **trace id** (from `traceparent`) already correlates everything inside your OTel world. Teams keep
`X-Correlation-Id` anyway, because support staff, partner systems and frontends that don't speak OTel
need one id to quote in a ticket ("error ref abc-123"). So make the two **the same thing** where
possible:

1. When the caller sends no id, **default to the trace id** instead of a fresh GUID, so the id on a
   support ticket finds the trace directly.
2. **Tag the current span** with the correlation id, so a partner's id is searchable in your traces too.
3. **Tighten the input check.** be-09 capped the length. Also whitelist characters, because the value
   ends up in log lines.

ProblemDetails already carries `traceId` (be-09 showed how it's filled), so error responses need no
change. The upgraded `InvokeAsync`:

```csharp
public async Task InvokeAsync(HttpContext ctx)
{
    var id = ctx.Request.Headers["X-Correlation-Id"].ToString();
    if (string.IsNullOrWhiteSpace(id) || id.Length > 64            // never trust unbounded input
        || !id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))   // no newlines in your logs
        id = Activity.Current?.TraceId.ToString() ?? Guid.NewGuid().ToString("N");

    ctx.TraceIdentifier = id;                                       // as in be-09: ProblemDetails' traceId
    ctx.Response.OnStarting(() => { ctx.Response.Headers["X-Correlation-Id"] = id; return Task.CompletedTask; });
    Activity.Current?.SetTag("correlation.id", id);

    using (logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = id }))
        await next(ctx);
}
```

Why each line is there: the header comes from the caller, so it's **untrusted input**. A length
cap and a small character whitelist stop someone from writing megabytes or fake log lines
(`\n`) into your logs. `OnStarting` sets the response header just before the first byte is sent,
which works even when a later middleware writes the response. `BeginScope` attaches the id to
**every** log line written during the request, without each `LogInformation` call mentioning it.

## Rate limiting: protecting yourself

Rate limiting caps how many requests one client may make in a period. It protects your service
from one noisy client (a buggy script, a scraper, a retry loop) using up the capacity everyone
else needs. Rejected requests are cheap: they never reach your handler or your database.

ASP.NET Core ships a rate limiter middleware (`Microsoft.AspNetCore.RateLimiting`) with four
algorithms:

| Limiter | Behaviour | Typical use |
|---|---|---|
| Fixed window | N requests per window. The counter resets at window boundaries | Simple API quotas |
| Sliding window | Window split into segments, which smooths the boundary burst (below) | Fairer public API limits |
| Token bucket | Bucket refills at rate R, with capacity B for bursts | "10/s sustained, bursts of 50" |
| Concurrency | At most N **in flight** at once | Protecting an expensive endpoint (exports, AI calls) |

The **boundary burst** is the fixed window's weakness. With "100 per minute", a client can send
100 requests at 0:59 and another 100 at 1:00: 200 requests in two seconds, all allowed. A sliding
window counts the last minute in segments (say six 10-second slices), so that burst is
rejected. A token bucket allows bursts on purpose, but only up to its capacity.

```csharp
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("per-client", ctx => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: ctx.User.FindFirst("sub")?.Value                     // per user if authenticated
                      ?? ctx.Request.Headers["X-Api-Key"].FirstOrDefault()   // per API key
                      ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anonymous",
        factory: _ => new FixedWindowRateLimiterOptions
            { PermitLimit = 5, Window = TimeSpan.FromSeconds(10), QueueLimit = 0 }));
    o.OnRejected = (ctx, _) =>
    {
        if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            ctx.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString();
        return ValueTask.CompletedTask;
    };
});

app.UseAuthentication();
app.UseRateLimiter();                      // after auth if you partition by user (and after UseRouting if you call it)
app.MapGet("/projects/{ownerId}/quota", …).RequireRateLimiting("per-client");
```

Reading it: `AddPolicy` gives each **partition key** its own limiter, created on first use.
`QueueLimit = 0` rejects immediately instead of making excess requests wait. `OnRejected` copies
the limiter's "try again in N seconds" hint into the `Retry-After` header. Without the
`RejectionStatusCode` line, rejected requests get `503`, which clients read as "server broken"
rather than "slow down".

Things to know:

- **Partition** by user, API key or tenant. One global bucket lets a single noisy client starve
  everyone.
- Return **`429` with `Retry-After`** so well-behaved clients (and your own resilience handlers)
  back off correctly.
- The built-in limiter is **per instance**. With 4 replicas and "5 per 10 s", a client can get up
  to 20, depending on load-balancer distribution. For strict global limits, use a distributed
  limiter (Redis) or enforce at the API gateway, and keep the in-process limiter as a cheap
  safety net.
- Rate limiting (requests per time) isn't the same as **quotas** (projects per plan, be-18),
  which are business rules enforced in the database.

:::quiz id=be-19-q3 xp=10
Your policy is a fixed window of 100 requests per minute per API key, using the built-in
in-memory limiter. You run 5 replicas behind a round-robin load balancer. Roughly how many
requests per minute can one key get through?

- [ ] 100
- [ ] 20
- [x] Up to about 500, because each replica keeps its own counters
- [ ] Unlimited, because the limiter is disabled behind a load balancer
> In-process limiters don't coordinate: each replica has its own counter for the key, so the round-robin balancer spreads one client over five budgets of 100. "100" would be right only with a shared store. "20" is the per-replica share you'd get if you **divided** the limit by the replica count yourself. Either compensate by setting the per-replica limit to the global limit ÷ replica count (approximate, because balancing is never perfect and the replica count changes with autoscaling), or move strict limits to a shared store (Redis) or the API gateway.
:::

## Calling other services: HttpClientFactory + resilience

The first rule: **don't `new HttpClient()` per request.** Each instance owns a connection pool.
Creating and disposing them under load exhausts sockets (`TIME_WAIT`). A single static instance
fixes that but, by default, keeps its connections open forever and never sees DNS changes, which
is a problem in Kubernetes when a service moves. (A static client with
`new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(2) }` works too.)
`IHttpClientFactory` pools and recycles handlers correctly, and **typed clients** give you a
clean seam for configuration and tests. A typed client is a class that takes an `HttpClient` in
its constructor; DI hands it a correctly configured one:

```csharp
builder.Services.AddHttpClient<BillingClient>(c => c.BaseAddress = new Uri(builder.Configuration["Billing:BaseUrl"]!))
    .AddStandardResilienceHandler();       // package Microsoft.Extensions.Http.Resilience
```

Some vocabulary first. A **transient fault** is one that's likely to go away by itself: a
dropped connection, a `503` during a deploy, a `429`. Retrying those makes sense. A `400` or
`404` will fail the same way every time, so retrying only adds load. A **circuit breaker** is
named after the electrical one: after too many failures it "opens" and stops calls for a while,
then lets one trial call through ("half-open") to see whether the dependency has recovered.

`AddStandardResilienceHandler()` adds a pre-tuned Polly v8 pipeline. Each strategy wraps the
next, like middleware. Outer to inner:

| # | Strategy | Default | Why |
|---|---|---|---|
| 1 | Rate limiter | 1000 concurrent | Don't overload the dependency from this process |
| 2 | **Total timeout** | 30 s | Upper bound for the whole call **including retries** |
| 3 | **Retry** | 3 retries, exponential backoff + jitter, 2 s base | Ride out transient faults: 5xx, 408, 429, network errors, attempt timeouts |
| 4 | **Circuit breaker** | Opens at ≥10 % failures (min 100 calls in 30 s) for 5 s | Stop hammering a dependency that's down. Fail fast instead |
| 5 | **Attempt timeout** | 10 s | Bound each individual try |

Order matters. The attempt timeout sits **inside** the retry, so a hung attempt is cut off and
**retried**. The total timeout sits **outside**, so retries can't add up to minutes. The circuit
breaker sits inside the retry, so it counts every individual attempt. Once it's open, the call
fails immediately with `BrokenCircuitException` (the retry doesn't treat that as transient), and
no request leaves your process.

Tune it from configuration or code:

```csharp
.AddStandardResilienceHandler(o =>
{
    o.Retry.MaxRetryAttempts = 2;
    o.Retry.DisableForUnsafeHttpMethods();       // don't retry POST/PUT/PATCH/DELETE…
    o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(2);
    o.CircuitBreaker.BreakDuration = TimeSpan.FromSeconds(15);
});
```

…or build your own pipeline with `AddResilienceHandler("billing", b => b.AddTimeout(…).AddRetry(…).AddCircuitBreaker(…).AddTimeout(…))`.

:::warn title="Retries + POST = duplicates"
By default the standard handler retries **every** method. If `POST /charges` times out *after*
the billing service charged the card, a retry charges it again. Either disable retries for unsafe
methods, or send an **`Idempotency-Key`** (be-18) so the server can deduplicate. Payment and
messaging APIs require one for exactly this reason.
:::

**Retry storms.** If the API retries 3×, its gateway retries 3×, and the frontend retries 3×,
one user click can become 27 calls to a struggling service, at the moment it can least afford
them. Retry at **one** layer (usually the one closest to the failing call), use jitter so clients
don't retry in lockstep, and honour `Retry-After`.

:::quiz id=be-19-q4 xp=15
The billing service hangs: it accepts connections but never responds. You have the standard
resilience handler with defaults. Roughly how long does a call to `BillingClient` take before it
fails?

- [ ] It hangs forever, because timeouts must be added manually
- [ ] 10 s, because the attempt timeout fails the call
- [x] About 30 s. Each attempt is cut at 10 s and retried, and the **total** timeout of 30 s ends the whole operation
- [ ] 2 s, the base retry delay
> The timeline: attempt 1 is cut at 10 s, the retry waits about 2 s, attempt 2 is cut at about 22 s, the retry waits about 4 s, and attempt 3 is still running when the outer **total** timeout fires at 30 s with `TimeoutRejectedException`. "10 s" is tempting, but a timed-out attempt counts as transient, so the retry tries again instead of failing. If your endpoint's own SLO is 2 s, lower both timeouts. A user-facing request should never wait 30 s on a non-critical dependency.
:::

:::quiz id=be-19-q5 xp=10
What does an **open** circuit breaker do to the next call?

- [ ] Queues it until the dependency recovers
- [x] Fails it immediately with `BrokenCircuitException`, without sending a request. After the break duration, a trial call is let through (half-open)
- [ ] Sends it to a backup URL
- [ ] Retries it with a longer timeout
> Failing fast protects both sides: your threads and connections aren't tied up waiting, and the struggling dependency gets breathing room. A half-open trial decides whether to close the circuit again. A breaker never queues calls (that would hold resources, the opposite of its purpose), and switching to a backup URL is a separate *fallback* or *hedging* strategy you'd add yourself, not what "open" means.
:::

:::quiz id=be-19-q7 xp=15
`POST /charges` to the payment provider goes through the standard resilience handler with
default settings. The provider charges the card, but its response is lost when the connection
drops. What happens next, and what's the right protection?

- [ ] Nothing. `HttpClient` never retries `POST` requests
- [x] The connection error counts as transient, so the retry sends the `POST` again and the card may be charged twice. Send an `Idempotency-Key` header (the same value on every attempt), or disable retries for unsafe methods
- [ ] The circuit breaker opens immediately and blocks the retry
- [ ] The retry is safe, because the provider returns `409` for the duplicate
> The standard handler retries every HTTP method unless you call `DisableForUnsafeHttpMethods()`. From the client's side "no response" looks the same whether the charge happened or not, so only the server can tell a retry from a new request, and it needs an idempotency key to do that. A provider *may* detect duplicates, but only if you send that key. The breaker opens after many failures over a sampling window, not after one.
:::

:::challenge id=be-19-c1 lang=ts xp=60
title: A circuit breaker state machine
Implement `createBreaker({ failureThreshold, breakMs, now })`. It returns `{ call, state }`:

- **closed**: `call(fn)` runs `fn`. A success resets the consecutive-failure count. A failure
  increments it and re-throws. When it reaches `failureThreshold` the breaker becomes **open**
  (remember `now()`).
- **open**: while `now() - openedAt < breakMs`, `call` throws `Error('circuit open')` **without
  running `fn`**.
- After `breakMs`, `state()` reports `'half-open'`, and the **next** call is a trial. A trial
  success → **closed** (count reset). A trial failure → **open** again from `now()` (re-throw the
  error).
- Only **one** trial at a time. Calls made while the trial is in flight throw `'circuit open'`.
- `state()` returns `'closed' | 'open' | 'half-open'`.

hint: Store `mode`, `failures`, `openedAt` and a `trialInFlight` flag.
hint: `state()` can compute `'half-open'` as "mode is open and `now() - openedAt >= breakMs`".

```ts starter
type Opts = { failureThreshold: number; breakMs: number; now: () => number }

export function createBreaker(opts: Opts) {
  return {
    state: (): string => 'closed',
    call: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  }
}
```

```ts solution
type Opts = { failureThreshold: number; breakMs: number; now: () => number }

export function createBreaker(opts: Opts) {
  let mode: 'closed' | 'open' = 'closed'
  let failures = 0
  let openedAt = 0
  let trialInFlight = false

  const state = (): string => {
    if (mode === 'closed') return 'closed'
    return opts.now() - openedAt >= opts.breakMs ? 'half-open' : 'open'
  }

  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    const s = state()
    if (s === 'open') throw new Error('circuit open')
    if (s === 'half-open') {
      if (trialInFlight) throw new Error('circuit open')
      trialInFlight = true
      try {
        const r = await fn()
        mode = 'closed'
        failures = 0
        return r
      } catch (e) {
        openedAt = opts.now()
        throw e
      } finally {
        trialInFlight = false
      }
    }
    try {
      const r = await fn()
      failures = 0
      return r
    } catch (e) {
      failures++
      if (failures >= opts.failureThreshold) {
        mode = 'open'
        openedAt = opts.now()
      }
      throw e
    }
  }

  return { state, call }
}
```

```ts tests
const ok = () => Promise.resolve('ok')
const boom = () => Promise.reject(new Error('boom'))

function setup() {
  let t = 0
  const clock = { now: () => t, advance: (ms: number) => { t += ms } }
  const b = createBreaker({ failureThreshold: 3, breakMs: 1000, now: clock.now })
  return { b, clock }
}

test('opens after N consecutive failures and then fails fast', async () => {
  const { b } = setup()
  for (let i = 0; i < 3; i++) await expect(b.call(boom)).rejects.toThrow('boom')
  expect(b.state()).toBe('open')
  const spy = fn(ok)
  await expect(b.call(spy)).rejects.toThrow('circuit open')
  expect(spy).not.toHaveBeenCalled()
})

test('a success resets the consecutive failure count', async () => {
  const { b } = setup()
  await expect(b.call(boom)).rejects.toThrow('boom')
  await expect(b.call(boom)).rejects.toThrow('boom')
  await b.call(ok)
  await expect(b.call(boom)).rejects.toThrow('boom')
  expect(b.state()).toBe('closed')
})

test('half-open trial success closes the circuit', async () => {
  const { b, clock } = setup()
  for (let i = 0; i < 3; i++) await expect(b.call(boom)).rejects.toThrow()
  clock.advance(1000)
  expect(b.state()).toBe('half-open')
  expect(await b.call(ok)).toBe('ok')
  expect(b.state()).toBe('closed')
})

test('half-open trial failure re-opens for a full break', async () => {
  const { b, clock } = setup()
  for (let i = 0; i < 3; i++) await expect(b.call(boom)).rejects.toThrow()
  clock.advance(1000)
  await expect(b.call(boom)).rejects.toThrow('boom')
  expect(b.state()).toBe('open')
  clock.advance(999)
  expect(b.state()).toBe('open')
  clock.advance(1)
  expect(b.state()).toBe('half-open')
})

test('only one trial call at a time', async () => {
  const { b, clock } = setup()
  for (let i = 0; i < 3; i++) await expect(b.call(boom)).rejects.toThrow()
  clock.advance(1000)
  let release: (v: string) => void = () => {}
  const slow = () => new Promise<string>((r) => { release = r })
  const trial = b.call(slow)
  await expect(b.call(ok)).rejects.toThrow('circuit open')
  release('done')
  expect(await trial).toBe('done')
  expect(b.state()).toBe('closed')
})
```
:::

## Graceful degradation

Resilience policies decide *how hard to try*. Graceful degradation decides **what to do when
trying fails**. Sort every dependency into **critical** (without it the feature is meaningless:
the database for saving a document) and **non-critical** (quota display, avatars,
recommendations, analytics). For non-critical ones, have a planned fallback:

```csharp
try
{
    var quota = await billing.GetQuotaAsync(ownerId, ct);
    metrics.QuotaLookup("ok");
    return Results.Ok(quota);
}
catch (Exception ex) when (ex is HttpRequestException or BrokenCircuitException or TimeoutRejectedException)
{
    log.LogWarning(ex, "Billing unavailable for {OwnerId}; serving the free-tier default", ownerId);
    metrics.QuotaLookup("degraded");                         // so dashboards and alerts see it
    return Results.Ok(new Quota(ownerId, MaxProjects: 3, UsedProjects: 0, Degraded: true));
}
```

Common fallback patterns:

- **Serve stale**: return the last cached value (HybridCache, be-20) marked as possibly
  outdated.
- **Default**: as above. Choose a safe default. For a quota, pick the *restrictive* side for
  writes and the permissive side for reads.
- **Defer**: accept the request and put the work on a durable queue (be-16) instead of calling
  the dependency synchronously. `202 Accepted` plus a SignalR notification when it's done (be-17).
- **Feature off**: hide the widget. The UI shows "quota info temporarily unavailable".
- **Bulkhead**: give risky dependencies their own concurrency limit, so a slow one can't
  consume every thread and connection.

Always **measure degradation** (a metric with `outcome=degraded`) and alert on it. A fallback
that hides an outage for a week is a different kind of failure.

:::quiz id=be-19-q6 xp=15
**Which fix is right?** This endpoint returns `500` whenever the recommendation service is down,
which breaks the whole dashboard page.

```csharp
app.MapGet("/dashboard", async (ProjectsRepo repo, RecoClient reco, string userId, CancellationToken ct) =>
{
    var projects = await repo.ForUserAsync(userId, ct);
    var recos = await reco.GetAsync(userId, ct);   // throws HttpRequestException / BrokenCircuitException
    return Results.Ok(new { projects, recos });
});
```

- [ ] Wrap the whole handler in `catch (Exception) { return Results.Ok(); }`
- [ ] Increase `MaxRetryAttempts` to 10 so the call eventually succeeds
- [x] Give the reco call a short timeout and catch only its transient failures, then return the projects with `recos = []` and `degraded = true`, and count it in a metric
- [ ] Add the reco service to the readiness check so traffic stops when it's down
> Recommendations are non-critical, so degrade **that part** and keep the critical data. More retries make a down dependency worse, swallowing *all* exceptions hides real bugs, and putting a non-critical dependency in readiness takes the whole API out of rotation.
:::

:::pro title="Production checklist seniors look for"
- `/health/live` with no dependency checks and `/health/ready` with critical dependencies,
  served on an internal port or not publicly detailed.
- OTel resource attributes (`service.name`, `service.version`, `deployment.environment`) so
  dashboards can be filtered by deploy.
- Golden signals per endpoint (latency histogram, traffic, errors, saturation) come from
  `http.server.request.duration`. Alert on **SLOs** ("99 % of saves < 500 ms"), not on CPU.
- One retry layer, with jitter, idempotency for unsafe methods, timeouts everywhere, and
  circuit breakers on remote dependencies.
- Rate limits partitioned per tenant, returning 429 + `Retry-After`.
- Every fallback emits a metric and a warning log.
:::

:::job title="What you'll meet on day one"
You'll inherit an existing telemetry setup (often a shared `AddServiceDefaults()` extension like
the .NET Aspire template's) and dashboards in Grafana or Datadog. Early tasks look like: "add a
metric for X", "why is there no trace across the queue?", or "this endpoint times out when billing
is slow". Learn to start from a trace id in a ProblemDetails response and walk to the slow span.
That's the most-used debugging skill in a production backend team.
:::

:::lab id=be-19-lab1 xp=150
title: Health, rate limits, resilient HTTP and a degradation metric
You'll build an API with `/health/live` and `/health/ready` (a real Npgsql check), a correlation-id
middleware, a per-client rate limit, a billing `HttpClient` with the standard resilience handler
and a graceful fallback, plus OpenTelemetry. The tests simulate a down database and a flaky
billing service, **no Docker needed**, and they assert on a custom metric with `MetricCollector`.

**1. Create the solution**

```bash
mkdir -p ~/devquest/be-19-lab1 && cd ~/devquest/be-19-lab1
dotnet new sln -n Ops
dotnet new web -o Ops.Api
dotnet new xunit -o Ops.Tests
dotnet sln add Ops.Api Ops.Tests
dotnet add Ops.Api package AspNetCore.HealthChecks.NpgSql
dotnet add Ops.Api package Microsoft.Extensions.Http.Resilience
dotnet add Ops.Api package OpenTelemetry.Extensions.Hosting
dotnet add Ops.Api package OpenTelemetry.Instrumentation.AspNetCore
dotnet add Ops.Api package OpenTelemetry.Instrumentation.Http
dotnet add Ops.Api package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add Ops.Tests reference Ops.Api
dotnet add Ops.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet add Ops.Tests package Microsoft.Extensions.Diagnostics.Testing
rm Ops.Tests/UnitTest1.cs
```

**2. Settings.** Replace `Ops.Api/appsettings.json`. The resilience section binds straight onto
`HttpStandardResilienceOptions`.

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  },
  "AllowedHosts": "*",
  "ConnectionStrings": {
    "Projects": "Host=localhost;Port=5432;Database=projects;Username=postgres;Password=postgres"
  },
  "Billing": {
    "BaseUrl": "http://localhost:5999",
    "Resilience": {
      "Retry": { "MaxRetryAttempts": 3, "Delay": "00:00:00.200" },
      "AttemptTimeout": { "Timeout": "00:00:02" },
      "TotalRequestTimeout": { "Timeout": "00:00:10" }
    }
  }
}
```

**3. Billing client and metrics.** Create `Ops.Api/Billing.cs`:

```csharp
using System.Diagnostics.Metrics;

namespace Ops.Api;

public record Quota(string OwnerId, int MaxProjects, int UsedProjects, bool Degraded);

// Typed HttpClient for an external billing service (owner-billed quotas).
public class BillingClient(HttpClient http)
{
    public async Task<Quota> GetQuotaAsync(string ownerId, CancellationToken ct) =>
        (await http.GetFromJsonAsync<Quota>($"/quota/{Uri.EscapeDataString(ownerId)}", ct))!;
}

// Custom business metric. IMeterFactory makes it testable and DI-friendly.
public class ProjectsMetrics
{
    public const string MeterName = "Projects.Api";
    private readonly Counter<long> _quotaLookups;

    public ProjectsMetrics(IMeterFactory meterFactory)
    {
        var meter = meterFactory.Create(MeterName);
        _quotaLookups = meter.CreateCounter<long>("projects.quota.lookups", unit: "{lookup}",
            description: "Quota lookups against the billing service, by outcome.");
    }

    public void QuotaLookup(string outcome) =>
        _quotaLookups.Add(1, new KeyValuePair<string, object?>("outcome", outcome));
}
```

**4. Correlation ids.** Create `Ops.Api/CorrelationId.cs`:

```csharp
using System.Diagnostics;

namespace Ops.Api;

// Accepts X-Correlation-Id from the caller (or invents one), echoes it back,
// tags the current trace with it and puts it in every log line's scope.
public class CorrelationIdMiddleware(RequestDelegate next, ILogger<CorrelationIdMiddleware> logger)
{
    public const string Header = "X-Correlation-Id";

    public async Task InvokeAsync(HttpContext ctx)
    {
        var id = ctx.Request.Headers[Header].ToString();
        if (string.IsNullOrWhiteSpace(id) || id.Length > 64
            || !id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'))
            id = Activity.Current?.TraceId.ToString() ?? Guid.NewGuid().ToString("N");

        ctx.Response.OnStarting(() => { ctx.Response.Headers[Header] = id; return Task.CompletedTask; });
        Activity.Current?.SetTag("correlation.id", id);

        using (logger.BeginScope(new Dictionary<string, object> { ["CorrelationId"] = id }))
            await next(ctx);
    }
}
```

**5. Program.** Replace `Ops.Api/Program.cs`:

```csharp
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Http.Resilience;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Ops.Api;

var builder = WebApplication.CreateBuilder(args);

// ---------- Health checks ----------
builder.Services.AddHealthChecks()
    .AddNpgSql(builder.Configuration.GetConnectionString("Projects")!,
        name: "postgres", tags: ["ready"], timeout: TimeSpan.FromSeconds(3));

// ---------- OpenTelemetry: traces + metrics (+ logs) ----------
var otel = builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("projects-api"))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation(o => o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health"))
        .AddHttpClientInstrumentation())
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddMeter(ProjectsMetrics.MeterName));
builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.IncludeFormattedMessage = true; });
// Export only when a collector is configured (e.g. OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317).
if (!string.IsNullOrEmpty(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
    otel.UseOtlpExporter();
builder.Services.AddSingleton<ProjectsMetrics>();

// ---------- Rate limiting: 5 requests / 10 s per API key (or per IP) ----------
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy("per-client", ctx => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: ctx.Request.Headers["X-Api-Key"].FirstOrDefault()
                      ?? ctx.Connection.RemoteIpAddress?.ToString() ?? "anonymous",
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 5, Window = TimeSpan.FromSeconds(10), QueueLimit = 0,
        }));
    o.OnRejected = (ctx, _) =>
    {
        if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            ctx.HttpContext.Response.Headers.RetryAfter = ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString();
        return ValueTask.CompletedTask;
    };
});

// ---------- Resilient outbound HTTP ----------
builder.Services.AddHttpClient<BillingClient>(c =>
        c.BaseAddress = new Uri(builder.Configuration["Billing:BaseUrl"] ?? "http://localhost:5999"))
    .AddStandardResilienceHandler()   // rate limiter → total timeout → retry → circuit breaker → attempt timeout
    .Configure(builder.Configuration.GetSection("Billing:Resilience"));

var app = builder.Build();

app.UseMiddleware<CorrelationIdMiddleware>();
app.UseRateLimiter();

// Liveness: "is the process alive and not deadlocked?" — runs NO dependency checks.
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
// Readiness: "should the load balancer send me traffic?" — checks tagged "ready".
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = c => c.Tags.Contains("ready"),
    ResponseWriter = WriteJson,
});

app.MapGet("/projects/{ownerId}/quota", async (string ownerId, BillingClient billing,
    ProjectsMetrics metrics, ILogger<Program> log, CancellationToken ct) =>
{
    try
    {
        var quota = await billing.GetQuotaAsync(ownerId, ct);
        metrics.QuotaLookup("ok");
        return Results.Ok(quota);
    }
    catch (Exception ex) when (ex is HttpRequestException or TimeoutException
                                  or Polly.CircuitBreaker.BrokenCircuitException
                                  or Polly.Timeout.TimeoutRejectedException)
    {
        // Graceful degradation: billing is down, but reading the editor must still work.
        log.LogWarning(ex, "Billing unavailable for {OwnerId}; serving the free-tier default", ownerId);
        metrics.QuotaLookup("degraded");
        return Results.Ok(new Quota(ownerId, MaxProjects: 3, UsedProjects: 0, Degraded: true));
    }
}).RequireRateLimiting("per-client");

app.Run();

static Task WriteJson(HttpContext ctx, HealthReport report)
{
    ctx.Response.ContentType = "application/json";
    return ctx.Response.WriteAsync(JsonSerializer.Serialize(new
    {
        status = report.Status.ToString(),
        checks = report.Entries.ToDictionary(e => e.Key, e => new
        {
            status = e.Value.Status.ToString(),
            durationMs = e.Value.Duration.TotalMilliseconds,
            error = e.Value.Exception?.Message,
        }),
    }));
}

public partial class Program;
```

**6. Try it.** Nothing listens on the billing port and (probably) no database is running, which
is exactly what we want to see. Each quota call takes about a second, because the resilience
handler retries the refused connection three times (200 ms base delay, growing) before the
endpoint gives up and degrades:

```bash
dotnet run --project Ops.Api --urls http://localhost:5190
curl -i localhost:5190/health/live          # HTTP/1.1 200 OK  … Healthy
curl -i localhost:5190/health/ready         # HTTP/1.1 503 Service Unavailable … "postgres":{"status":"Unhealthy",…}
curl -s localhost:5190/projects/alice/quota # {"ownerId":"alice","maxProjects":3,"usedProjects":0,"degraded":true}
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code} " -H 'X-Api-Key: k' localhost:5190/projects/alice/quota; done
# 200 200 200 200 200 429
```

Start Postgres (`docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=projects postgres:18`)
and `/health/ready` turns `200` within one probe. Optionally start the Aspire dashboard as shown
earlier, run with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`, and look at the trace of a
degraded quota call. You'll see the retried outbound attempts as child spans.

**7. Test helpers.** Create `Ops.Tests/TestApp.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Ops.Api;

namespace Ops.Tests;

// Plays the billing service: returns the scripted status codes in order, then repeats the last one.
public class ScriptedBillingHandler(params HttpStatusCode[] script) : HttpMessageHandler
{
    private int _calls;
    public int Calls => _calls;

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        var i = Interlocked.Increment(ref _calls) - 1;
        var status = script[Math.Min(i, script.Length - 1)];
        var res = new HttpResponseMessage(status);
        if (status == HttpStatusCode.OK)
            res.Content = JsonContent.Create(new Quota("alice", MaxProjects: 50, UsedProjects: 7, Degraded: false));
        return Task.FromResult(res);
    }
}

public static class TestApp
{
    public static WebApplicationFactory<Program> Create(HttpMessageHandler billing) =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            // Port 1: nothing listens there → the database is "down".
            b.UseSetting("ConnectionStrings:Projects", "Host=127.0.0.1;Port=1;Database=x;Username=x;Password=x;Timeout=2");
            b.UseSetting("Billing:Resilience:Retry:Delay", "00:00:00.001");   // fast retries in tests
            b.ConfigureTestServices(s =>
                s.AddHttpClient<BillingClient>().ConfigurePrimaryHttpMessageHandler(() => billing));
        });
}
```

**8. Tests.** Create `Ops.Tests/OpsTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Diagnostics.Metrics.Testing;
using System.Diagnostics.Metrics;
using Ops.Api;

namespace Ops.Tests;

public class HealthTests
{
    [Fact]
    public async Task Live_is_healthy_even_when_the_database_is_down()
    {
        using var app = TestApp.Create(new ScriptedBillingHandler(HttpStatusCode.OK));

        var res = await app.CreateClient().GetAsync("/health/live");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Ready_is_503_and_names_the_failing_check_when_the_database_is_down()
    {
        using var app = TestApp.Create(new ScriptedBillingHandler(HttpStatusCode.OK));

        var res = await app.CreateClient().GetAsync("/health/ready");

        Assert.Equal(HttpStatusCode.ServiceUnavailable, res.StatusCode);
        using var body = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        Assert.Equal("Unhealthy", body.RootElement.GetProperty("checks").GetProperty("postgres").GetProperty("status").GetString());
    }
}

public class ResilienceTests
{
    [Fact]
    public async Task Transient_billing_failures_are_retried_transparently()
    {
        var billing = new ScriptedBillingHandler(HttpStatusCode.ServiceUnavailable, HttpStatusCode.InternalServerError, HttpStatusCode.OK);
        using var app = TestApp.Create(billing);

        var quota = await app.CreateClient().GetFromJsonAsync<Quota>("/projects/alice/quota");

        Assert.Equal(50, quota!.MaxProjects);
        Assert.False(quota.Degraded);
        Assert.Equal(3, billing.Calls);   // 1 attempt + 2 retries
    }

    [Fact]
    public async Task When_billing_stays_down_the_endpoint_degrades_instead_of_failing()
    {
        var billing = new ScriptedBillingHandler(HttpStatusCode.ServiceUnavailable);
        using var app = TestApp.Create(billing);
        using var lookups = new MetricCollector<long>(app.Services.GetRequiredService<IMeterFactory>(),
            ProjectsMetrics.MeterName, "projects.quota.lookups");

        var res = await app.CreateClient().GetAsync("/projects/alice/quota");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var quota = await res.Content.ReadFromJsonAsync<Quota>();
        Assert.True(quota!.Degraded);
        Assert.Equal(4, billing.Calls);   // 1 attempt + MaxRetryAttempts (3)
        var m = Assert.Single(lookups.GetMeasurementSnapshot());
        Assert.Equal("degraded", m.Tags["outcome"]);
    }

    [Fact]
    public async Task Client_errors_are_not_retried()
    {
        var billing = new ScriptedBillingHandler(HttpStatusCode.NotFound);
        using var app = TestApp.Create(billing);

        await app.CreateClient().GetAsync("/projects/alice/quota");

        Assert.Equal(1, billing.Calls);   // 404 is not transient — retrying would just hammer billing
    }
}

public class EdgeTests
{
    [Fact]
    public async Task Sixth_request_in_the_window_gets_429_with_Retry_After()
    {
        using var app = TestApp.Create(new ScriptedBillingHandler(HttpStatusCode.OK));
        var client = app.CreateClient();
        client.DefaultRequestHeaders.Add("X-Api-Key", "key-A");

        for (var i = 0; i < 5; i++)
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/projects/alice/quota")).StatusCode);
        var sixth = await client.GetAsync("/projects/alice/quota");

        Assert.Equal(HttpStatusCode.TooManyRequests, sixth.StatusCode);
        Assert.NotNull(sixth.Headers.RetryAfter);
    }

    [Fact]
    public async Task Rate_limits_are_per_client()
    {
        using var app = TestApp.Create(new ScriptedBillingHandler(HttpStatusCode.OK));
        var a = app.CreateClient();
        a.DefaultRequestHeaders.Add("X-Api-Key", "key-A");
        var b = app.CreateClient();
        b.DefaultRequestHeaders.Add("X-Api-Key", "key-B");

        for (var i = 0; i < 6; i++) await a.GetAsync("/projects/alice/quota");
        var res = await b.GetAsync("/projects/alice/quota");

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
    }

    [Fact]
    public async Task Correlation_id_is_echoed_or_generated()
    {
        using var app = TestApp.Create(new ScriptedBillingHandler(HttpStatusCode.OK));
        var client = app.CreateClient();
        var withId = new HttpRequestMessage(HttpMethod.Get, "/health/live");
        withId.Headers.Add("X-Correlation-Id", "abc-123");

        var echoed = await client.SendAsync(withId);
        var generated = await client.GetAsync("/health/live");

        Assert.Equal("abc-123", echoed.Headers.GetValues("X-Correlation-Id").Single());
        Assert.False(string.IsNullOrEmpty(generated.Headers.GetValues("X-Correlation-Id").Single()));
    }
}
```

**9. Run**

```bash
dotnet test
```

```text
Passed!  - Failed:     0, Passed:     8, Skipped:     0, Total:     8, Duration: 350 ms - Ops.Tests.dll (net10.0)
```

**10. Experiments.** Add the Postgres check to `/health/live` (remove the predicate) and watch
`Live_is_healthy_even_when_the_database_is_down` fail. That's the restart storm from quiz 1 in
test form. Then set `"MaxRetryAttempts": 1` in `appsettings.json`: the two retry tests fail.
With only one retry, the transient test degrades after two calls (`maxProjects` is 3, not 50),
and the stays-down test sees 2 billing calls instead of 4. The tests really pin down the retry
behaviour.
(Try `0` as well: **every** test fails at startup with `OptionsValidationException ... must be
between 1 and 2147483647`. The resilience options are validated when the app starts, which is
exactly what you want for a config typo in production. To turn retries off, remove the strategy
or build your own pipeline instead.) Put it back to `3`.

- [ ] All 8 tests pass with `dotnet test`
- [ ] `/health/live` is 200 and `/health/ready` is 503 with a JSON body naming `postgres` while the DB is down
- [ ] Two transient billing failures are retried transparently, and a 404 isn't retried
- [ ] When billing stays down, the quota endpoint degrades (`degraded: true`) and records `projects.quota.lookups{outcome=degraded}`
- [ ] The sixth request in a window gets `429` with `Retry-After`, and another API key isn't affected
- [ ] `X-Correlation-Id` is echoed when sent and generated when missing
:::

## Flashcards

:::cards id=be-19-cards1 xp=20 title="Resilience & observability"
Q: Liveness vs readiness?
A: Liveness: "kill and restart me?" Check (almost) nothing. Readiness: "send me traffic?" Check critical dependencies like the DB.
Q: Why not check the DB in liveness?
A: A DB blip fails every pod's liveness, and Kubernetes restarts them all at once, which turns a blip into an outage.
Q: Status codes for health results?
A: Healthy and Degraded return 200. Unhealthy returns 503.
Q: The three OpenTelemetry signals and their .NET APIs?
A: Traces: ActivitySource/Activity. Metrics: Meter (Counter, Histogram, gauges). Logs: ILogger with the OTel provider.
Q: What must never go into a metric tag?
A: High-cardinality values like user ids, project ids or raw URLs. Put them on spans and logs instead.
Q: How does a trace cross a queue?
A: Store the traceparent (`Activity.Current?.Id`) in the message and start the consumer's activity with it as the parent.
Q: The order of the standard resilience pipeline?
A: Rate limiter → total timeout → retry → circuit breaker → attempt timeout.
Q: Why is retrying POST dangerous, and what's the fix?
A: A timed-out POST may have succeeded, so a retry duplicates it. Disable retries for unsafe methods or send an Idempotency-Key.
Q: What does an open circuit breaker do?
A: It fails calls immediately (BrokenCircuitException), then lets a half-open trial through after the break duration.
Q: Why is the built-in rate limiter not a global limit?
A: Counters are per instance, so N replicas allow up to N× the limit. Use Redis or the gateway for strict limits.
Q: What should a rate-limited response include?
A: Status 429 and a Retry-After header.
Q: What's graceful degradation?
A: Planned fallbacks (stale, default, defer, hide) for non-critical dependencies, always measured with a metric.
:::

## Recap

- Liveness checks that the process is alive and nothing else. Readiness checks critical
  dependencies and removes the instance from traffic. Keep checks cheap and their details private.
- OpenTelemetry gives you traces, metrics and logs over OTLP. Turn on ASP.NET Core, HttpClient and
  Npgsql instrumentation, add your own `ActivitySource`/`Meter` via `IMeterFactory`, and keep
  metric tags low-cardinality.
- Correlation ids: default them to the trace id, echo them, log them in scopes, and propagate
  them across queues.
- Rate limit per client with a partitioned limiter, return `429` + `Retry-After`, and remember
  the limiter is per instance.
- Use `IHttpClientFactory` and typed clients with `AddStandardResilienceHandler()`: total timeout ›
  retry (jitter) › circuit breaker › attempt timeout. Retry at one layer only, and never blindly
  retry unsafe methods.
- Degrade non-critical features with explicit fallbacks, and measure every degradation.
