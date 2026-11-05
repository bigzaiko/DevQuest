---
id: cl-08
title: "Observability: OpenTelemetry, Prometheus, Grafana, Loki"
level: advanced
minutes: 210
xp: 100
summary: Instrument a .NET 10 API with OpenTelemetry, ship traces, metrics and logs through a Collector to Tempo, Prometheus and Loki, then build RED dashboards and SLO burn-rate alerts that page on symptoms, not noise.
---

It is 02:14 and the pager goes off: *"Checkout p95 latency above 2 s"*. The questions come in a
fixed order. **Is it real?** (how many users are hit). **Where is it?** (API, database, payment
provider, the worker?). **Why?** (a deploy, a slow query, a full connection pool, a noisy
neighbour). If your system can't answer those three questions in about ten minutes, every outage
turns into a long call where people guess, `kubectl logs | grep` and restart pods hoping it helps.

**Observability** means you can answer *new* questions about a running system from the
telemetry it already sends, without shipping new code to find out. Monitoring tells you *that*
something is wrong. Observability lets you work out *what* and *why*.

```text
   React SPA ──traceparent──► ASP.NET API ──► PostgreSQL
       │                         │   └──traceparent stored with job──► Redis queue ──► Worker
       │ OTLP/HTTP               │ OTLP                                                 │ OTLP
       ▼                         ▼                                                      ▼
  ┌──────────────────────── OpenTelemetry Collector ──────────────────────────────────────┐
  │ receivers (otlp) ─► processors (memory_limiter, batch, …) ─► exporters               │
  └──────┬─────────────────────────────┬────────────────────────────────┬─────────────────┘
         ▼ traces                      ▼ metrics                        ▼ logs
       Tempo                       Prometheus                          Loki
         └──────────────────────────── Grafana (one UI, linked by trace_id) ────────────┘
```

This lesson builds exactly this picture. The worker path is the one from **Redis as Queue, Bus
and Lock** and the boss fight: the API stores the `traceparent` with the job, a Redis queue
delivers the id, and the worker continues the same trace. With a broker from **Message Brokers &
the Outbox Pattern** the only difference is that `traceparent` travels in a message header. The
next lesson, **KEDA: Autoscale Workers on Queue Depth**, scales workers on the same kind of queue
and Prometheus metrics you create here, so the dashboards from this lab are what you'll watch
while it scales.

## Three signals, three different questions

| Signal | What it is | Answers | Cost driver | Weak at |
|---|---|---|---|---|
| **Metrics** | Numbers aggregated over time (`requests_total`, latency histograms) | *Is something wrong, and how bad?* Trends, alerts, capacity | Number of **series** (label combinations) | Explaining one specific request |
| **Traces** | A tree of **spans** (timed operations) for one request across services | *Where did the time go / where did it fail?* | Number of spans (so sampling matters) | Totals, "how many users?" |
| **Logs** | Timestamped events with context, ideally structured | *What exactly happened?* Error details, business events | Bytes ingested and indexed | Aggregation and causality across services |

A good incident flow uses all three, in this order:

```text
 ALERT (metric: error-budget burn) ──► DASHBOARD (metric: which route? since when?)
   ──► EXEMPLAR / trace search (trace: which span is slow?) ──► LOGS for that trace_id (why?)
```

The thing that makes this work is **correlation**. Every log line carries the `trace_id`, every
latency histogram can carry **exemplars** (a sample `trace_id` attached to a bucket), and every
signal carries the same **resource attributes** (`service.name`, `service.version`,
`deployment.environment.name`). Without shared IDs you have three separate tools. With them you
can click from a graph to the trace to the logs.

:::info title="Profiles are the fourth signal"
OpenTelemetry also has **profiles** (continuous CPU/memory profiling, e.g. Grafana Pyroscope).
It's newer and less settled than the other three. Learn the three first.
:::

:::quiz id=cl-08-q1 xp=10
Users report that *some* checkouts take 8 seconds. The p95 latency graph has been flat at 300 ms
all day. Which signal is most likely to show you **why those particular requests** are slow?
- [ ] A higher-resolution latency metric (1 s scrape interval)
- [x] Traces of slow checkout requests (e.g. TraceQL `{ duration > 5s && resource.service.name = "checkout-api" }`)
- [ ] `kubectl logs` of all pods, searching for "slow"
- [ ] CPU usage of the nodes
> A trace breaks **one** request into spans, so you can see which hop (a DB query, a retry against
> the payment provider, a lock wait) took the 8 s. A finer-grained metric is the tempting answer,
> but it is still an aggregate. If only 1 % of requests are slow, the p95 can't show them at all.
> You'd want a p99 or max. Neither tells you *where* the time went.
:::

## RED and USE: what to measure

Rather than "measure everything", two methods cover nearly every component:

| Method | For | Measure |
|---|---|---|
| **RED** (Tom Wilkie) | Anything that **serves requests**: APIs, gRPC services, queue consumers | **R**ate (req/s), **E**rrors (failed req/s or ratio), **D**uration (latency distribution) |
| **USE** (Brendan Gregg) | **Resources**: CPU, memory, disks, connection pools, thread pools, queues | **U**tilization (% busy), **S**aturation (work waiting), **E**rrors |

Google's **four golden signals** (latency, traffic, errors, saturation) are roughly RED plus USE's
saturation. Some real examples:

* **API**: RED per route, using `http.server.request.duration` (a histogram gives you all three).
* **Npgsql connection pool**: USE. Utilization = busy ÷ max connections. Saturation = requests
  **waiting** for a connection. That number is usually the first sign of a "the database is
  slow" incident.
* **RabbitMQ queue / worker**: RED for the consumer (messages/s, failed/s, processing time). USE
  for the queue: saturation is **queue depth** and **age of the oldest message**. This is the
  metric KEDA scales on.

:::pro title="Saturation shows up first"
Errors and latency tell you users are already in pain. Saturation (pool wait queue, consumer lag,
thread-pool queue length) often climbs **minutes before** that. Put it on the dashboard next to
RED, but don't page on it. You'll see why in the alerting section.
:::

:::quiz id=cl-08-q2 xp=10
Which method fits the **Npgsql connection pool** of your API best, and what is its *saturation*?
- [ ] RED, and saturation is the error rate of SQL commands
- [x] USE, and saturation is the number of callers waiting for a free connection
- [ ] USE, and saturation is the total number of connections ever opened
- [ ] RED, and saturation is query duration
> A pool is a **resource** with a fixed capacity, so USE applies. Utilization is busy ÷ max. Once
> utilization hits 100 %, new callers queue, and that wait queue is saturation. Query duration
> (the RED-flavoured answer) is the tempting one, but it measures the database's work, not the
> pool's capacity. Queries can be fast while requests still wait 2 s for a connection.
:::

## OpenTelemetry in one page

**OpenTelemetry (OTel)** is the CNCF standard for *producing and moving* telemetry. It does not
store anything. It replaced a mix of vendor agents (each with its own SDK) with one set of APIs,
one wire protocol and one pipeline.

| Piece | What it is |
|---|---|
| **API** | What your code calls to create spans and metrics. In .NET it's the BCL itself: `System.Diagnostics.ActivitySource` (spans = `Activity`) and `System.Diagnostics.Metrics.Meter`. |
| **SDK** | Collects what the API produces, samples, batches and exports it. In .NET: the `OpenTelemetry.*` NuGet packages. |
| **Instrumentation** | Ready-made spans and metrics for libraries: ASP.NET Core, HttpClient, Npgsql, EF Core, gRPC, Redis… |
| **OTLP** | The OpenTelemetry Protocol (protobuf). Ports **4317** (gRPC) and **4318** (HTTP, paths `/v1/traces`, `/v1/metrics`, `/v1/logs`). |
| **Collector** | A standalone service that receives, processes and exports telemetry. The "router" between apps and backends. |
| **Semantic conventions** | Standard attribute names (`http.request.method`, `http.route`, `db.system.name`, `messaging.destination.name`), so dashboards work across languages. |
| **Resource** | Attributes describing *who* emits the data: `service.name`, `service.version`, `service.instance.id`, `deployment.environment.name`, `k8s.pod.name`… attached to every signal. |

### The Collector: receivers → processors → exporters

```yaml
receivers:            # how data gets IN (otlp, prometheus scrape, filelog, kafka, hostmetrics…)
  otlp:
    protocols:
      grpc: { endpoint: 0.0.0.0:4317 }
      http: { endpoint: 0.0.0.0:4318 }

processors:           # what happens IN BETWEEN, in the order listed in the pipeline
  memory_limiter:     # first: refuse data before the Collector OOMs
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  batch: {}           # group data into bigger, cheaper export requests

exporters:            # where data goes OUT
  otlp_grpc/tempo:    # "type/name": several exporters of the same type need a name
    endpoint: tempo:4317
    tls: { insecure: true }
  prometheus:         # exposes a /metrics endpoint for Prometheus to scrape
    endpoint: 0.0.0.0:8889

service:
  pipelines:          # nothing is active until it's wired into a pipeline
    traces:  { receivers: [otlp], processors: [memory_limiter, batch], exporters: [otlp_grpc/tempo] }
    metrics: { receivers: [otlp], processors: [memory_limiter, batch], exporters: [prometheus] }
```

:::info title="`otlp` or `otlp_grpc`?"
Recent Collector releases renamed the OTLP **exporters** to `otlp_grpc` and `otlp_http`. The old
names `otlp` and `otlphttp` still work as deprecated aliases, so most configs, blog posts and Helm
charts you'll meet at work still use them. The OTLP **receiver** is still called `otlp`.
:::

Why put a Collector in the middle instead of exporting straight from the app?

* **Decoupling.** Apps speak OTLP to `otel-collector:4317`. Switching Jaeger to Tempo, or adding
  a vendor, is a Collector config change, not a redeploy of 40 services.
* **Processing in one place.** Drop health-check spans, scrub PII (`attributes`/`transform`
  processors), add `k8s.*` metadata (`k8sattributes`), and do **tail sampling** (keep 100 % of
  error traces and 5 % of the rest, which you can only decide after the trace has finished).
* **Reliability.** Retries, queues and back-pressure live in the Collector, not inside the API.

Common deployment patterns: an **agent** Collector per node (DaemonSet), or a sidecar, that
forwards to a **gateway** Collector Deployment, which then exports to the backends. Tail sampling
must run where all spans of a trace meet. That's the gateway, behind a
`loadbalancing` exporter that routes by trace ID.

:::warn title="Collector receivers bind to localhost by default"
Since Collector v0.104 the OTLP receiver defaults to `localhost:4317`, which in a container means
"unreachable from other containers". Always write `endpoint: 0.0.0.0:4317` in compose/K8s. If
your app logs `connection refused` against the Collector, check this first.
:::

:::quiz id=cl-08-q3 xp=10
In a Collector traces pipeline you list `processors: [batch, memory_limiter]`. What's wrong?
- [ ] Nothing, processors run in parallel so order doesn't matter
- [x] `memory_limiter` should come **first**, so it can refuse data before batching and other work allocate memory
- [ ] `batch` must never be used for traces
- [ ] Processors must be listed alphabetically
> Processors run **in the order listed**. The memory limiter guards the Collector, so it has to
> see data as early as possible and push back (the receiver returns a retryable error) before
> memory grows. `batch` is normally last, just before the exporters, because exporters benefit
> from large batches. "Order doesn't matter" is tempting because `receivers` and `exporters`
> really are sets. Processors are a chain.
:::

## Context propagation: one trace across React → API → queue → worker

A trace is only useful if every hop joins the **same** trace. That's **context propagation**: the
caller sends its current span context, and the callee makes its first span a *child* of it. The
standard carrier is the **W3C Trace Context** header:

```http
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                │
             │  trace-id: 16 bytes = 32 hex     parent-id: 8 bytes │  trace-flags: 01 = sampled
             version (00)                        = the CALLER's span id
tracestate: vendor1=opaque,vendor2=opaque      (optional, vendor data)
baggage: tenant.id=acme,plan=pro               (optional, key/values you choose; NOT a security boundary)
```

Rules worth knowing by heart:

* Lowercase hex only. All-zero trace-id or parent-id is **invalid**. Version `ff` is invalid.
* When you receive a valid `traceparent`, keep the **trace-id** and **flags** and create a new
  **span-id** for your server span. The incoming parent-id becomes that span's parent.
* When you call the next hop, send `traceparent` with **your** span id as parent-id.
* Invalid or missing header: start a **new trace** (new trace-id).
* `sampled` (flag bit `0x01`) means the caller is recording this trace. A parent-based sampler
  follows it, so you never get half a trace.

How each hop does it:

```text
 Browser  ──fetch + traceparent──►  ASP.NET Core      (extracted automatically by the framework)
 API      ──HttpClient──────────►  other API          (injected automatically by HttpClient instrumentation)
 API      ──publish─────────────►  RabbitMQ / Redis   (YOU inject into message headers)
 Worker   ◄─consume──────────────  queue              (YOU extract and start a Consumer span)
```

**Browser side.** With the OTel web SDK, `FetchInstrumentation` adds the header. Cross-origin
APIs only get it if you opt in:

```ts
// telemetry.ts (OpenTelemetry JS 2.x packages)
import { WebTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-web'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { ZoneContextManager } from '@opentelemetry/context-zone'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'

const provider = new WebTracerProvider({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'shop-web' }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: '/otel/v1/traces' }))],
})
provider.register({ contextManager: new ZoneContextManager() })

registerInstrumentations({
  instrumentations: [
    new FetchInstrumentation({
      propagateTraceHeaderCorsUrls: [/^https:\/\/api\.shop\.example/], // send traceparent cross-origin
    }),
  ],
})
```

…and the API must allow the header in CORS, or the browser's preflight fails:

```csharp
builder.Services.AddCors(o => o.AddPolicy("spa", p => p
    .WithOrigins("https://shop.example")
    .WithHeaders("content-type", "authorization", "traceparent", "tracestate")
    .WithMethods("GET", "POST", "PUT", "DELETE")));
```

:::warn title="OTel JS APIs moved in 2.x"
OpenTelemetry JS 2.x removed `provider.addSpanProcessor()` (span processors go into the
constructor) and replaced `new Resource()` with `resourceFromAttributes()`. Browser
instrumentation is still marked **experimental** in places. Check the package READMEs for the
version you install, and don't trust older blog posts.
:::

**Queue side (.NET).** Brokers don't know about HTTP headers, so you copy the context into
message headers yourself (some client libraries now do it for you, see the warning below):

```csharp
using System.Diagnostics;
using System.Text;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;

static readonly TextMapPropagator Propagator = Propagators.DefaultTextMapPropagator;

// Producer (inside the API request, so Activity.Current is the request span)
using (var activity = Telemetry.Source.StartActivity("orders publish", ActivityKind.Producer))
{
    var props = new BasicProperties { Headers = new Dictionary<string, object?>() };
    // activity is null when nobody listens to the source: fall back to the request span,
    // otherwise the worker would silently start a brand-new trace
    var ctx = activity?.Context ?? Activity.Current?.Context ?? default;
    Propagator.Inject(new PropagationContext(ctx, Baggage.Current),
        props.Headers, (headers, key, value) => headers[key] = value);
    activity?.SetTag("messaging.system", "rabbitmq");
    activity?.SetTag("messaging.destination.name", "orders");
    await channel.BasicPublishAsync("", "orders", mandatory: false, props, body);
}

// Consumer (worker)
var parent = Propagator.Extract(default, ea.BasicProperties.Headers, (headers, key) =>
    headers is not null && headers.TryGetValue(key, out var v) && v is byte[] bytes
        ? [Encoding.UTF8.GetString(bytes)]
        : []);
Baggage.Current = parent.Baggage;
using var span = Telemetry.Source.StartActivity("orders process", ActivityKind.Consumer, parent.ActivityContext);
```

Now the trace in Tempo reads `POST /checkout → orders publish → orders process → INSERT invoices`,
even though the worker ran 40 s later on another node. With the **outbox pattern** (Message
Brokers & the Outbox Pattern) you store the `traceparent` in the outbox row too, so the relay
can restore it when it publishes. A plain Redis list (the diagram above, and the boss fight) has
no headers at all: the API writes `traceparent` into the job's row or payload, and the worker
calls `Propagator.Extract` on that stored string instead of on message headers. Same carrier
idea, different storage.

:::warn title="Check your client library first"
RabbitMQ.Client 7, Confluent.Kafka add-ons, MassTransit and Wolverine ship their own
OpenTelemetry/ActivitySource support with their own source names, and some inject `traceparent`
automatically. Look at your library's docs before hand-rolling the code above, or you'll get
duplicate spans. Long-running batch consumers sometimes use **span links** (to many producers)
instead of a single parent. That's also valid.
:::

:::pro title="Don't blindly trust traceparent from the internet"
A public API that accepts any incoming `traceparent` lets clients choose your trace IDs and force
sampling (`-01`). Many teams start a fresh trace at the edge (or link to the client's trace
instead of parenting it) and trust the header only from their own SPA or internal callers. For
the same reason, **never** put secrets or authorization data in `baggage`. It is forwarded to
every downstream, including third parties.
:::

:::challenge id=cl-08-c1 lang=ts xp=40
title: Parse and propagate a W3C traceparent
Your API gateway is written in TypeScript and has to join traces correctly. Implement:

* `parseTraceparent(header)`: returns `{ version, traceId, parentId, flags, sampled }` or `null`.
  Rules: trim whitespace. Fields separated by `-`. Every field is **lowercase** hex of exact
  length (version 2, trace-id 32, parent-id 16, flags 2). Version `ff` is invalid. All-zero
  trace-id or parent-id is invalid. Version `00` must have **exactly** 4 fields. Higher versions
  may carry extra fields after the 4th (ignore them). `sampled` = flags bit `0x01`.
* `childTraceparent(incoming, randomHex)`: the header to send downstream. If `incoming` is valid,
  keep its trace-id and flags and use a fresh span id `randomHex(8)`. Otherwise start a new
  sampled trace: `00-${randomHex(16)}-${randomHex(8)}-01`, calling `randomHex(16)` (trace-id)
  **before** `randomHex(8)` (span-id). Always emit version `00`, even when the incoming header
  had a higher version. `randomHex(bytes)` is **injected** (it returns `bytes * 2` hex chars), so
  tests stay deterministic: the tests' fake hands out its values in call order and throws if you
  ask for the wrong length.

hint: `/^[0-9a-f]+$/` plus a length check per field. `/^0+$/` detects all zeros.
hint: `parseInt(flags, 16) & 1` gives the sampled bit.
hint: `childTraceparent` can reuse `parseTraceparent`: one `if (!parent)` branch for the new trace, one template string for the child.

```ts starter
export interface TraceContext {
  version: string
  traceId: string
  parentId: string
  flags: string
  sampled: boolean
}

export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  // TODO
  return null
}

export function childTraceparent(
  incoming: string | null | undefined,
  randomHex: (bytes: number) => string,
): string {
  // TODO
  return ''
}
```

```ts solution
export interface TraceContext {
  version: string
  traceId: string
  parentId: string
  flags: string
  sampled: boolean
}

const HEX = /^[0-9a-f]+$/
const field = (s: string | undefined, len: number) => s !== undefined && s.length === len && HEX.test(s)
const allZero = (s: string) => /^0+$/.test(s)

export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null
  const parts = header.trim().split('-')
  if (parts.length < 4) return null
  const [version, traceId, parentId, flags] = parts
  if (!field(version, 2) || version === 'ff') return null
  if (version === '00' && parts.length !== 4) return null
  if (!field(traceId, 32) || allZero(traceId)) return null
  if (!field(parentId, 16) || allZero(parentId)) return null
  if (!field(flags, 2)) return null
  return { version, traceId, parentId, flags, sampled: (parseInt(flags, 16) & 1) === 1 }
}

export function childTraceparent(
  incoming: string | null | undefined,
  randomHex: (bytes: number) => string,
): string {
  const parent = parseTraceparent(incoming)
  if (!parent) {
    const traceId = randomHex(16)
    const spanId = randomHex(8)
    return `00-${traceId}-${spanId}-01`
  }
  return `00-${parent.traceId}-${randomHex(8)}-${parent.flags}`
}
```

```ts tests
const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

function fakeRandom(...values: string[]) {
  let i = 0
  return (bytes: number) => {
    const v = values[i++]
    if (v === undefined || v.length !== bytes * 2) throw new Error(`fake asked for ${bytes} bytes, has "${v}"`)
    return v
  }
}

test('parses a valid sampled header', () => {
  expect(parseTraceparent(VALID)).toEqual({
    version: '00',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    parentId: '00f067aa0ba902b7',
    flags: '01',
    sampled: true,
  })
})
test('flags 00 means not sampled; whitespace is trimmed', () => {
  const ctx = parseTraceparent('  00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00 ')
  expect(ctx?.sampled).toBe(false)
  expect(ctx?.flags).toBe('00')
})
test('sampled is bit 0x01, other bits do not matter', () => {
  expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03')?.sampled).toBe(true)
  expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-02')?.sampled).toBe(false)
})
test('rejects malformed headers', () => {
  expect(parseTraceparent(undefined)).toBeNull()
  expect(parseTraceparent('')).toBeNull()
  expect(parseTraceparent('garbage')).toBeNull()
  expect(parseTraceparent('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01')).toBeNull() // uppercase
  expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01')).toBeNull()  // short trace id
  expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01')).toBeNull()   // short span id
  expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-1')).toBeNull()   // short flags
  expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902bz-01')).toBeNull()  // not hex
})
test('rejects all-zero ids and version ff', () => {
  expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull()
  expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull()
  expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull()
})
test('version 00 must have exactly 4 fields, future versions may have more', () => {
  expect(parseTraceparent(VALID + '-extra')).toBeNull()
  const future = parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-whatever')
  expect(future?.version).toBe('01')
  expect(future?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
})
test('child keeps trace id + flags and gets a new span id', () => {
  const rnd = fakeRandom('b7ad6b7169203331')
  expect(childTraceparent(VALID, rnd)).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01')
  const unsampled = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00'
  expect(childTraceparent(unsampled, fakeRandom('1111111111111111'))).toBe(
    '00-4bf92f3577b34da6a3ce929d0e0e4736-1111111111111111-00',
  )
})
test('child of a future version is emitted as version 00', () => {
  const out = childTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-x', fakeRandom('2222222222222222'))
  expect(out).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-2222222222222222-01')
})
test('missing or invalid header starts a new sampled trace', () => {
  const rnd = fakeRandom('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')
  expect(childTraceparent(undefined, rnd)).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
  const rnd2 = fakeRandom('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb')
  expect(childTraceparent('00-zzz-yyy-01', rnd2)).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01')
})
```
:::

:::quiz id=cl-08-q4 xp=10
Traces from your React app and your API show up as **two separate traces** for each click. The
SPA runs on `https://app.shop.example` and calls `https://api.shop.example`. What is the most
likely cause?
- [ ] The API uses a different `service.name` than the SPA
- [x] The fetch instrumentation doesn't send `traceparent` to that cross-origin URL (`propagateTraceHeaderCorsUrls`), or the API's CORS policy doesn't allow the `traceparent` header
- [ ] Tempo can't store traces from browsers
- [ ] The two services must export to the same Collector port
> Browsers only add custom headers to cross-origin requests when the code opts in, and the
> preflight must list `traceparent` in `Access-Control-Allow-Headers`. Without the header, ASP.NET
> Core sees no parent and starts a new trace. Different `service.name`s are *expected*: one trace
> normally spans many services, and that's the point of tracing.
:::

## .NET 10: wiring up OpenTelemetry

.NET doesn't need an OTel API package. `Activity`/`ActivitySource` and `Meter` are part of the
runtime, and ASP.NET Core, HttpClient, Npgsql and others already emit to them. The OTel SDK
*subscribes* by name and exports.

```bash
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
dotnet add package OpenTelemetry.Instrumentation.Runtime
dotnet add package Npgsql.OpenTelemetry            # SQL spans from Npgsql (works under EF Core too)
```

```csharp
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(serviceName: "orders-api", serviceVersion: "1.4.2")
        .AddAttributes(new Dictionary<string, object>
        {
            ["deployment.environment.name"] = builder.Environment.EnvironmentName,
        }))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation(o =>
            o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/healthz")) // no probe spam
        .AddHttpClientInstrumentation()
        .AddNpgsql()                         // spans per SQL command (SQL text in db.statement / db.query.text)
        .AddSource(Telemetry.Name))          // YOUR ActivitySource(s)
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()      // http.server.request.duration, kestrel.*, …
        .AddHttpClientInstrumentation()      // http.client.request.duration
        .AddRuntimeInstrumentation()         // GC, thread pool queue length, exceptions
        .AddMeter("Npgsql")                  // pool usage / pending requests (USE for the pool)
        .AddMeter(Telemetry.Name))           // YOUR Meter(s)
    .WithLogging()                           // ILogger → OTLP logs, with TraceId/SpanId attached
    .UseOtlpExporter();                      // one exporter for all three signals
```

Configuration comes from standard environment variables, which also makes it easy to configure
in Kubernetes:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317   # gRPC is the .NET exporter's default
OTEL_EXPORTER_OTLP_PROTOCOL=grpc                         # or http/protobuf (then port 4318)
OTEL_RESOURCE_ATTRIBUTES=service.namespace=shop,k8s.pod.name=$(POD_NAME)   # $(POD_NAME) = K8s env-var reference (Downward API), not shell
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1                              # keep 10 % of new root traces
```

:::warn title="Check API names against your package versions"
`UseOtlpExporter()` (configure OTLP for all signals at once) and `WithLogging()` are in the
stable 1.x packages of recent years. You can't combine `UseOtlpExporter()` with per-signal
`AddOtlpExporter()` calls. EF Core has its own instrumentation package
(`OpenTelemetry.Instrumentation.EntityFrameworkCore`), but it has been **prerelease** for a long
time. With PostgreSQL, `AddNpgsql()` already gives you the SQL spans underneath EF Core. The
`"Npgsql"` meter name is from the Npgsql docs. Check the metrics page for your Npgsql version
before you build dashboards on it.

Runtime metrics: since .NET 9 the runtime publishes its own `System.Runtime` meter
(`dotnet.gc.collections`, `dotnet.thread_pool.queue.length`, …). On .NET 9+ you can replace
`AddRuntimeInstrumentation()` with `.AddMeter("System.Runtime")`. The two produce **different
metric names** (the older package uses `process.runtime.dotnet.*`), so dashboards copied from
the internet may not match. Look at what `/metrics` actually shows.
:::

### Your own spans and metrics

Auto-instrumentation shows *HTTP* and *SQL*. Business steps ("charge card", "render PDF",
"reserve stock") need your own spans, and business outcomes need your own metrics:

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;

public static class Telemetry
{
    public const string Name = "Shop.Orders";
    public static readonly ActivitySource Source = new(Name);
    private static readonly Meter Meter = new(Name);

    public static readonly Counter<long> OrdersPlaced =
        Meter.CreateCounter<long>("shop.orders.placed", unit: "{order}", description: "Orders placed");
    public static readonly Histogram<double> PaymentDuration =
        Meter.CreateHistogram<double>("shop.payment.duration", unit: "s", description: "Payment provider call");
}

// in a handler
using var activity = Telemetry.Source.StartActivity("payment.charge");   // null if nobody listens / not sampled
activity?.SetTag("payment.provider", "stripe");
activity?.SetTag("shop.order.id", order.Id);        // fine on a SPAN (high cardinality is OK here)
var sw = Stopwatch.StartNew();
try
{
    await payments.ChargeAsync(order);
    Telemetry.OrdersPlaced.Add(1, new KeyValuePair<string, object?>("shop.payment.method", "card"));
}
catch (Exception ex)
{
    activity?.SetStatus(ActivityStatusCode.Error, ex.Message);
    activity?.AddException(ex);                     // records an "exception" span event (.NET 9+)
    throw;
}
finally
{
    Telemetry.PaymentDuration.Record(sw.Elapsed.TotalSeconds,
        new KeyValuePair<string, object?>("payment.provider", "stripe"));  // LOW-cardinality tags only
}
```

Rules that keep this cheap and useful:

* **Spans may have high-cardinality attributes** (order id, user id, SQL text), because each span
  is stored once. **Metric attributes must be low-cardinality** (method, route template, status
  code, provider), because each unique combination becomes a separate time series that lives
  forever.
* Use **route templates** (`/orders/{id}`), never raw paths (`/orders/81723`), on metrics.
* Pick **histogram buckets that match the unit**. The SDK's default buckets
  (`0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, …`) assume milliseconds. For a
  histogram in **seconds**, almost everything lands in the first bucket. ASP.NET Core provides
  seconds-friendly bucket advice for its own metrics. For yours, add a view:
  `.AddView("shop.payment.duration", new ExplicitBucketHistogramConfiguration { Boundaries = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] })`.
  (Since .NET 9 the instrument itself can carry the advice, via the `advice:` parameter of
  `CreateHistogram` with `InstrumentAdvice<double> { HistogramBucketBoundaries = […] }`. Recent
  OTel SDKs honour it. A view in the SDK config always wins.)
* In DI-heavy code, prefer `IMeterFactory` (`meterFactory.Create("Shop.Orders")`) over a static
  `Meter`. It makes metrics testable with `MetricCollector<T>`.

:::job title="What day one usually looks like"
Most teams already have this wired up in a shared `AddServiceDefaults()`-style extension (that's
what .NET Aspire's ServiceDefaults project is). Your job is to add **spans and metrics for your
feature**, follow the naming conventions in the repo, and check your dashboards after deploying.
In code review, people will ask "how will we know this works in production?" Have an answer:
a metric, a span name, a log event.
:::

### Logs: structured, correlated, boring

```csharp
log.LogWarning("Payment for order {OrderId} declined by {Provider}", order.Id, "stripe");
```

With message templates, `OrderId` and `Provider` become **attributes**, not just text. With
`WithLogging()` every record carries `TraceId`/`SpanId` from `Activity.Current`, which gives you
the link from a span to its logs. Never interpolate (`$"…{order.Id}"`): you lose the structure
and allocate on every call. Hot paths use `[LoggerMessage]` source-generated methods.

One surprise when the logs land in Loki: by default the OTel .NET SDK sends the **template**
(`Payment for order {OrderId} declined by {Provider}`) as the log body and the values as
attributes. That is great for grouping ("how often does *this* message happen?") but awkward to
read. Set `OpenTelemetryLoggerOptions.IncludeFormattedMessage = true` (the lab does) to send the
rendered text as the body, while the attributes stay filterable.

## Prometheus: pull, store, query

Prometheus **scrapes** (pulls) a plain-text `/metrics` endpoint every `scrape_interval`, stores
samples in its time-series database (TSDB), evaluates rules, and answers **PromQL** queries.

```text
# HELP http_server_request_duration_seconds Duration of HTTP server requests.
# TYPE http_server_request_duration_seconds histogram
http_server_request_duration_seconds_bucket{http_route="/orders/{id}",http_response_status_code="200",le="0.1"} 812
http_server_request_duration_seconds_bucket{http_route="/orders/{id}",http_response_status_code="200",le="0.25"} 990
http_server_request_duration_seconds_bucket{http_route="/orders/{id}",http_response_status_code="200",le="+Inf"} 1002
http_server_request_duration_seconds_sum{http_route="/orders/{id}",http_response_status_code="200"} 61.3
http_server_request_duration_seconds_count{http_route="/orders/{id}",http_response_status_code="200"} 1002
```

| Type | Meaning | Query it with |
|---|---|---|
| **Counter** (`_total`) | Only goes up (resets to 0 on restart) | `rate()` / `increase()`, never the raw value |
| **Gauge** | Goes up and down (queue depth, pool in use) | Raw value, `max_over_time`, `avg` |
| **Histogram** (`_bucket{le}`, `_sum`, `_count`) | Cumulative counts per upper bound `le` | `histogram_quantile()` over `rate(_bucket)` |
| **Summary** | Quantiles computed in the client | Avoid for services. You **can't aggregate** quantiles across pods |

OTel metric names are translated for Prometheus: dots → underscores, unit and type suffixes
added. `http.server.request.duration` (unit `s`) becomes
`http_server_request_duration_seconds_*`, and `shop.orders.placed` (a counter, unit `{order}`)
becomes `shop_orders_placed_total`. The resource's `service.name` becomes the `job` label, and
`service.instance.id` becomes `instance`. Watch out: if you also set `service.namespace`, the job
becomes `namespace/name` (e.g. `job="shop/orders-api"`), and every `{job="orders-api"}` query
silently returns nothing. Other resource attributes don't become labels on each series. The
Collector's `prometheus` exporter puts them on a separate `target_info` series, which you join
when you need them.

:::warn title="Name translation depends on versions and settings"
Prometheus 3 can also receive OTLP natively (`--web.enable-otlp-receiver`) and has settings that
keep UTF-8 dotted names unchanged. The Collector's `prometheus` exporter has translation options
too. The names above are the classic default. Open **Prometheus → Query → metrics explorer** and
use what your setup actually produces.
:::

### PromQL you'll write every week

```text
# R: requests per second per route (5-minute window)
sum by (http_route) (rate(http_server_request_duration_seconds_count{job="orders-api"}[5m]))

# E: error ratio (0..1) of 5xx responses
  sum(rate(http_server_request_duration_seconds_count{job="orders-api", http_response_status_code=~"5.."}[5m]))
/ sum(rate(http_server_request_duration_seconds_count{job="orders-api"}[5m]))

# D: p95 latency per route. Aggregate BUCKETS first (keep "le"), then take the quantile
histogram_quantile(0.95,
  sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{job="orders-api"}[5m])))

# Saturation: requests waiting for a DB connection (name depends on Npgsql version)
max by (job) (db_client_connection_pending_requests)
```

The rules behind these:

* **`rate()` first, then `sum`.** `rate` handles counter resets (pod restarts) per series. If you
  sum raw counters first, a restarted pod looks like a huge negative drop.
* The range (`[5m]`) should cover **at least 4 scrape intervals**. In Grafana use
  `$__rate_interval`, which does this for you.
* **Never average percentiles.** `avg(p95 per pod)` is mathematically meaningless. Sum the
  buckets by `le` across pods, then compute the quantile once.
* `histogram_quantile` **interpolates linearly inside a bucket**. Its precision is the width of
  your buckets: if they are `0.25` and `0.5`, any p95 between them is an estimate.

:::quiz id=cl-08-q5 xp=15
You run 6 API pods and want the overall p95. Which query is correct?
- [ ] `avg(histogram_quantile(0.95, rate(http_server_request_duration_seconds_bucket[5m])))`
- [x] `histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket[5m])))`
- [ ] `histogram_quantile(0.95, rate(sum(http_server_request_duration_seconds_bucket)[5m]))`
- [ ] `quantile(0.95, http_server_request_duration_seconds_sum)`
> Buckets are counts, and counts can be added across pods. Quantiles can't. So you `rate` each
> bucket series, `sum by (le)` to merge all pods into one histogram, then estimate the quantile.
> Averaging per-pod p95s is the tempting answer and is wrong: a quiet pod at 50 ms and a busy pod
> at 900 ms average to 475 ms, whatever the real traffic mix was. Option 3 sums before `rate`,
> which breaks counter-reset handling (and isn't valid syntax as written).
:::

:::challenge id=cl-08-c2 lang=ts xp=50
title: p95 from buckets, the histogram_quantile way
Re-implement what Prometheus does for classic histograms. You'll trust (and doubt) your
dashboards more once you've done it.

`Bucket = { le: number, count: number }`. Counts are **cumulative** (everything ≤ `le`), and the
`+Inf` bucket is `le: Infinity`.

1. `sumByLe(series)`: merge the buckets of several pods (an array of bucket arrays) by adding
   counts with equal `le`. Return them sorted by `le`. This is `sum by (le)`.
2. `histogramQuantile(q, buckets)`:
   * `q < 0` → `-Infinity`, `q > 1` → `Infinity`.
   * Sort by `le`. Fewer than 2 buckets, no `+Inf` bucket, or a total (`+Inf` count) of 0 → `NaN`.
   * `rank = q * total`. Find the **first** bucket whose count is `>= rank`.
   * If that's the `+Inf` bucket, return the **largest finite** upper bound (Prometheus can't
     interpolate to infinity).
   * Otherwise interpolate linearly: the bucket spans `(prevLe, le]` (with `prevLe = 0` for the
     first bucket) and holds `count - prevCount` observations:
     `prevLe + (le - prevLe) * (rank - prevCount) / (count - prevCount)`.

```text
le:     0.1   0.25   0.5    1    +Inf
count:   50    80     95    99   100      p90 → rank 90 → bucket (0.25, 0.5] holds 15, we need the 10th
                                          → 0.25 + 0.25 × 10/15 ≈ 0.4167
```

hint: `[...buckets].sort((a, b) => a.le - b.le)`. Don't mutate the input.
hint: For `sumByLe`, a `Map<number, number>` keyed by `le` works (`Infinity` is a fine key).

```ts starter
export interface Bucket {
  le: number
  count: number
}

export function sumByLe(series: Bucket[][]): Bucket[] {
  return []
}

export function histogramQuantile(q: number, buckets: Bucket[]): number {
  return 0
}
```

```ts solution
export interface Bucket {
  le: number
  count: number
}

export function sumByLe(series: Bucket[][]): Bucket[] {
  const acc = new Map<number, number>()
  for (const s of series) for (const b of s) acc.set(b.le, (acc.get(b.le) ?? 0) + b.count)
  return [...acc.entries()].map(([le, count]) => ({ le, count })).sort((a, b) => a.le - b.le)
}

export function histogramQuantile(q: number, buckets: Bucket[]): number {
  if (Number.isNaN(q)) return NaN
  if (q < 0) return -Infinity
  if (q > 1) return Infinity
  const b = [...buckets].sort((x, y) => x.le - y.le)
  if (b.length < 2 || b[b.length - 1].le !== Infinity) return NaN
  const total = b[b.length - 1].count
  if (total === 0) return NaN
  const rank = q * total
  let i = 0
  while (i < b.length - 1 && b[i].count < rank) i++
  if (i === b.length - 1) return b[b.length - 2].le
  const prevLe = i === 0 ? 0 : b[i - 1].le
  const prevCount = i === 0 ? 0 : b[i - 1].count
  return prevLe + (b[i].le - prevLe) * ((rank - prevCount) / (b[i].count - prevCount))
}
```

```ts tests
const H = [
  { le: 0.1, count: 50 },
  { le: 0.25, count: 80 },
  { le: 0.5, count: 95 },
  { le: 1, count: 99 },
  { le: Infinity, count: 100 },
]

test('p95 lands exactly on a bucket boundary', () => {
  expect(histogramQuantile(0.95, H)).toBeCloseTo(0.5, 6)
})
test('p90 interpolates inside (0.25, 0.5]', () => {
  expect(histogramQuantile(0.9, H)).toBeCloseTo(0.25 + 0.25 * (10 / 15), 6)
})
test('median and p25 inside the first bucket start from 0', () => {
  expect(histogramQuantile(0.5, H)).toBeCloseTo(0.1, 6)
  expect(histogramQuantile(0.25, H)).toBeCloseTo(0.05, 6)
})
test('a rank inside +Inf returns the largest finite bound', () => {
  expect(histogramQuantile(0.995, H)).toBe(1)
  expect(histogramQuantile(1, H)).toBe(1)
})
test('input order does not matter and is not mutated', () => {
  const shuffled = [H[3], H[0], H[4], H[2], H[1]]
  expect(histogramQuantile(0.9, shuffled)).toBeCloseTo(0.4166667, 6)
  expect(shuffled[0]).toBe(H[3])
})
test('edge cases', () => {
  expect(histogramQuantile(-0.1, H)).toBe(-Infinity)
  expect(histogramQuantile(1.5, H)).toBe(Infinity)
  expect(histogramQuantile(0.5, [{ le: 0.1, count: 3 }, { le: 1, count: 5 }])).toBeNaN()      // no +Inf
  expect(histogramQuantile(0.5, [{ le: 0.1, count: 0 }, { le: Infinity, count: 0 }])).toBeNaN() // no data
  expect(histogramQuantile(0.5, [{ le: Infinity, count: 9 }])).toBeNaN()                        // one bucket
})
test('sumByLe merges pods, then the quantile is taken once', () => {
  const podA = [
    { le: 0.25, count: 60 }, { le: 0.1, count: 40 }, { le: 0.5, count: 70 },
    { le: 1, count: 74 }, { le: Infinity, count: 75 },
  ]
  const podB = [
    { le: 0.1, count: 10 }, { le: 0.25, count: 20 }, { le: 0.5, count: 25 },
    { le: 1, count: 25 }, { le: Infinity, count: 25 },
  ]
  const merged = sumByLe([podA, podB])
  expect(merged).toEqual(H)
  expect(histogramQuantile(0.9, merged)).toBeCloseTo(0.4166667, 6)
})
```
:::

## Alerting: page on symptoms, with SLOs and error budgets

The classic mistake is to page on **causes**: CPU > 80 %, pod restarted, queue > 1000. Those
fire at 3 a.m. while users are fine (the HPA was handling it), and they stay silent during a real
outage that has a cause nobody thought of. Page on **symptoms users feel**: errors and latency,
measured against an objective. Show causes on dashboards and send them to ticket queues.

* **SLI** (indicator): `good events / valid events`, e.g. requests that return non-5xx within
  500 ms.
* **SLO** (objective): the target over a window, e.g. **99.9 % over 30 days**.
* **Error budget**: `1 − SLO` = 0.1 % of requests may fail. At 10 M requests/month that's 10 000
  failures. You can *spend* the budget on risky deploys. When it's gone, you freeze features and
  fix reliability.
* **Burn rate**: how fast you're spending the budget, relative to "exactly on budget".
  `burn = observed error ratio ÷ (1 − SLO)`. A burn rate of 1 uses up the budget exactly at the
  end of the 30 days. A burn rate of 14.4 uses it up in about 2 days.

A threshold on the raw error ratio ("> 1 % for 5 min") either pages on short blips or reacts too
late. The **multi-window, multi-burn-rate** alert (Google SRE Workbook) solves this:
`threshold = budget fraction spent × SLO period ÷ alert window`.

| Severity | Long window | Short window | Burn rate | Budget spent when it fires |
|---|---|---|---|---|
| **Page** | 1 h | 5 m | **14.4** | 2 % of 30 days in 1 hour |
| **Page** | 6 h | 30 m | **6** | 5 % in 6 hours |
| **Ticket** | 3 d | 6 h | **1** | 10 % in 3 days |

The **long** window proves the problem is significant. The **short** window (about 1/12 of the
long one) proves it's **still happening**, so the alert stops soon after you fix the issue
instead of firing for another hour.

```yaml
# rules.yml (Prometheus)
groups:
  - name: orders-api-slo
    rules:
      - record: job:slo_errors_per_request:ratio_rate5m
        expr: |
          sum by (job) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))
          / sum by (job) (rate(http_server_request_duration_seconds_count[5m]))
      - record: job:slo_errors_per_request:ratio_rate1h
        expr: |
          sum by (job) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[1h]))
          / sum by (job) (rate(http_server_request_duration_seconds_count[1h]))
      - alert: ErrorBudgetBurnFast
        expr: |
          job:slo_errors_per_request:ratio_rate1h{job="orders-api"} > (14.4 * 0.001)
          and
          job:slo_errors_per_request:ratio_rate5m{job="orders-api"} > (14.4 * 0.001)
        for: 2m
        labels: { severity: page }
        annotations:
          summary: "{{ $labels.job }} is burning its 30-day error budget >14x too fast"
          runbook_url: https://wiki.example/runbooks/orders-api-errors
      # Slow burn: same pattern with 6h / 30m recording rules (written like the two above)
      - alert: ErrorBudgetBurnSlow
        expr: |
          job:slo_errors_per_request:ratio_rate6h{job="orders-api"} > (6 * 0.001)
          and
          job:slo_errors_per_request:ratio_rate30m{job="orders-api"} > (6 * 0.001)
        for: 15m
        labels: { severity: page }
        annotations:
          summary: "{{ $labels.job }} is burning its 30-day error budget >6x too fast"
          runbook_url: https://wiki.example/runbooks/orders-api-errors
```

The naming `level:metric:operations` (`job:slo_errors_per_request:ratio_rate5m`) is the
Prometheus convention for **recording rules**: precomputed queries that the alert reads, so
the alert stays cheap and every panel uses the same definition.

:::tip title="Latency SLOs use the same maths"
"99 % of requests faster than 500 ms" is also a ratio of good to valid events. A histogram
already counts the good ones: the bucket `le="0.5"` holds every request ≤ 500 ms.

```text
  sum(rate(http_server_request_duration_seconds_bucket{job="orders-api", le="0.5"}[5m]))
/ sum(rate(http_server_request_duration_seconds_count{job="orders-api"}[5m]))
```

`1 −` that is the "bad" ratio you feed into the burn-rate formula. This only works if `0.5` is
an actual bucket boundary (it is in ASP.NET Core's default buckets). Choose your SLO thresholds
and your buckets together.
:::

Prometheus evaluates the rule and sends firing alerts to **Alertmanager**, which groups,
deduplicates, silences and routes them (`severity=page` → PagerDuty/Opsgenie, `ticket` → Slack or
a Jira queue). Grafana can also run alert rules itself. Pick one place per team and keep the
rules in Git.

:::quiz id=cl-08-q6 xp=15
Your SLO is 99.9 % availability over 30 days. Over the last hour 1.8 % of requests failed, and
over the last 5 minutes 2.1 % failed. With the fast-burn rule above (burn rate 14.4 on 1 h **and**
5 m), what happens?
- [ ] Nothing, 1.8 % is below the 5 % rule of thumb
- [x] It pages: burn rates are 18 (1 h) and 21 (5 m), both above 14.4
- [ ] It pages only if CPU is also high
- [ ] It opens a ticket, because the 1 h burn rate is below 1
> Burn = error ratio ÷ budget = 0.018 / 0.001 = 18 and 0.021 / 0.001 = 21. Both windows exceed
> 14.4, so you'd use 2 % of a month's budget within the hour. That's worth waking someone for.
> "1.8 % sounds small" is the tempting trap: against a 0.1 % budget it's 18 times faster than
> sustainable.
:::

:::challenge id=cl-08-c3 lang=ts xp=50
title: Burn-rate alert with an injected clock
Implement the logic of a multi-window burn-rate alert over raw request events. Time is
**injected** (`now`, in ms), so tests never touch the real clock.

* `errorRatio(events, now, windowMs)`: of the events with `now - windowMs < t <= now`, the
  fraction where `ok === false`. No events in the window → `0`.
* `burnRate(ratio, slo)`: `ratio / (1 - slo)`.
* `burnThreshold(budgetSpent, windowHours, periodHours = 720)`: the burn rate at which
  `budgetSpent` (e.g. `0.02`) of the budget is gone within `windowHours`.
* `shouldPage(events, now, slo)`: `true` if **either**
  * burn > 14.4 over **1 h AND** over **5 min**, or
  * burn > 6 over **6 h AND** over **30 min**.

hint: `burnThreshold` is `budgetSpent * periodHours / windowHours`, e.g. `0.02 * 720 / 1 = 14.4`.
hint: Both windows of a pair must exceed the threshold. That's how the alert resolves quickly once the errors stop.

```ts starter
export interface Req {
  t: number // epoch ms
  ok: boolean
}

export function errorRatio(events: Req[], now: number, windowMs: number): number {
  return 0
}

export function burnRate(ratio: number, slo: number): number {
  return 0
}

export function burnThreshold(budgetSpent: number, windowHours: number, periodHours = 720): number {
  return 0
}

export function shouldPage(events: Req[], now: number, slo: number): boolean {
  return false
}
```

```ts solution
export interface Req {
  t: number // epoch ms
  ok: boolean
}

const MIN = 60_000
const HOUR = 60 * MIN

export function errorRatio(events: Req[], now: number, windowMs: number): number {
  let total = 0
  let bad = 0
  for (const e of events) {
    if (e.t > now - windowMs && e.t <= now) {
      total++
      if (!e.ok) bad++
    }
  }
  return total === 0 ? 0 : bad / total
}

export function burnRate(ratio: number, slo: number): number {
  return ratio / (1 - slo)
}

export function burnThreshold(budgetSpent: number, windowHours: number, periodHours = 720): number {
  return (budgetSpent * periodHours) / windowHours
}

export function shouldPage(events: Req[], now: number, slo: number): boolean {
  const burn = (w: number) => burnRate(errorRatio(events, now, w), slo)
  const fast = burn(HOUR) > 14.4 && burn(5 * MIN) > 14.4
  const slow = burn(6 * HOUR) > 6 && burn(30 * MIN) > 6
  return fast || slow
}
```

```ts tests
const MINUTE = 60_000
const HOURS = 60 * MINUTE
const NOW = Date.UTC(2026, 10, 5, 2, 14) // the 02:14 page, but fixed: an injected clock

// one request per second in (from, to]; every `errorEvery`-th request fails (0 = never)
function makeTraffic(from: number, to: number, errorEvery: number): { t: number; ok: boolean }[] {
  const out: { t: number; ok: boolean }[] = []
  let i = 0
  for (let t = from + 1000; t <= to; t += 1000) {
    i++
    out.push({ t, ok: !(errorEvery > 0 && i % errorEvery === 0) })
  }
  return out
}

test('errorRatio respects the (now - window, now] boundaries', () => {
  const ev = [
    { t: 1000, ok: false }, // exactly now - window: excluded
    { t: 1001, ok: false },
    { t: 1500, ok: true },
    { t: 2000, ok: true },  // exactly now: included
    { t: 2001, ok: false }, // in the future: excluded
  ]
  expect(errorRatio(ev, 2000, 1000)).toBeCloseTo(1 / 3, 6)
  expect(errorRatio([], 2000, 1000)).toBe(0)
})
test('burnRate is error ratio over budget', () => {
  expect(burnRate(0.001, 0.999)).toBeCloseTo(1, 6)
  expect(burnRate(0.018, 0.999)).toBeCloseTo(18, 6)
  expect(burnRate(0.05, 0.99)).toBeCloseTo(5, 6)
})
test('burnThreshold reproduces the SRE workbook table', () => {
  expect(burnThreshold(0.02, 1)).toBeCloseTo(14.4, 6)
  expect(burnThreshold(0.05, 6)).toBeCloseTo(6, 6)
  expect(burnThreshold(0.1, 72)).toBeCloseTo(1, 6)
  expect(burnThreshold(0.02, 1, 168)).toBeCloseTo(3.36, 6) // 7-day SLO window
})
test('healthy service (0.05 % errors) does not page', () => {
  const ev = makeTraffic(NOW - 6 * HOURS, NOW, 2000)
  expect(shouldPage(ev, NOW, 0.999)).toBe(false)
})
test('an ongoing 50 % outage pages through the fast-burn pair', () => {
  const ev = [
    ...makeTraffic(NOW - 6 * HOURS, NOW - 10 * MINUTE, 0),
    ...makeTraffic(NOW - 10 * MINUTE, NOW, 2),
  ]
  expect(shouldPage(ev, NOW, 0.999)).toBe(true)
})
test('a steady 1 % error rate (burn 10) pages through the slow-burn pair', () => {
  const ev = makeTraffic(NOW - 6 * HOURS, NOW, 100)
  expect(burnRate(errorRatio(ev, NOW, HOURS), 0.999)).toBeCloseTo(10, 6)
  expect(shouldPage(ev, NOW, 0.999)).toBe(true)
})
test('an incident that ended 40 minutes ago no longer pages (short windows are clean)', () => {
  const ev = [
    ...makeTraffic(NOW - 6 * HOURS, NOW - 50 * MINUTE, 0),
    ...makeTraffic(NOW - 50 * MINUTE, NOW - 40 * MINUTE, 2),
    ...makeTraffic(NOW - 40 * MINUTE, NOW, 0),
  ]
  expect(burnRate(errorRatio(ev, NOW, HOURS), 0.999)).toBeGreaterThan(14.4) // the long window still remembers it
  expect(shouldPage(ev, NOW, 0.999)).toBe(false)
})
test('the same events evaluated at an earlier injected "now" still page', () => {
  const ev = [
    ...makeTraffic(NOW - 6 * HOURS, NOW - 50 * MINUTE, 0),
    ...makeTraffic(NOW - 50 * MINUTE, NOW - 40 * MINUTE, 2),
    ...makeTraffic(NOW - 40 * MINUTE, NOW, 0),
  ]
  expect(shouldPage(ev, NOW - 41 * MINUTE, 0.999)).toBe(true)
})
```
:::

:::quiz id=cl-08-q7 xp=10
Which of these should **page** an on-call engineer at night? (Select all that apply.)
- [x] Checkout's 1 h and 5 m error-budget burn rates are both above 14.4
- [ ] A node's CPU has been above 85 % for 10 minutes
- [x] The p99 latency SLO for search is burning at 8x over both 6 h and 30 m
- [ ] One API pod was OOM-killed and restarted
> Page on **symptoms** measured against SLOs: users are getting errors or slow responses, and the
> budget is draining fast enough to need a human now. High CPU and a single restart are
> **causes**. They're often harmless (autoscaling and restarts exist for this), so they belong on
> dashboards or in a ticket. The restart one is tempting, but if users don't notice, nobody needs
> to wake up.
:::

## Grafana: dashboards that answer questions

Grafana stores nothing itself. It queries **data sources** (Prometheus, Loki, Tempo, Postgres…)
and links them. A good service dashboard reads top to bottom like the incident flow:

```text
┌ orders-api · env=$env · route=$route ─────────────────────────────────────────────┐
│ SLO: 99.93 % (30d)   Error budget left: 61 %   Burn (1h): 0.4                   │  ← are we OK?
├─────────────────────────┬─────────────────────────┬────────────────────────────────┤
│ Rate (req/s by route)   │ Errors (% 5xx by route) │ Duration p50/p95/p99 + exemplars│  ← RED
├─────────────────────────┴─────────────────────────┴────────────────────────────────┤
│ Saturation: DB pool pending · thread-pool queue · queue depth & oldest message age │  ← USE
├────────────────────────────────────────────────────────────────────────────────────┤
│ Logs: {service_name="orders-api"} |= "error"   (click trace_id → Tempo)            │  ← why
└────────────────────────────────────────────────────────────────────────────────────┘
```

* Use **template variables** (`$env`, `$job`, `$route`) instead of copying dashboards per
  service.
* Use `$__rate_interval` in `rate()`, so the window adapts to the zoom level and scrape interval.
* Put **deploy annotations** on the graphs (CI posts to Grafana's annotation API). Half of all
  incidents start with "what changed?"
* Keep dashboards **in Git** (provisioned JSON, or code via the Grafana Foundation SDK /
  Grafonnet). Dashboards clicked together in the UI drift and get lost.

### Exemplars: from a spike to the trace that caused it

An **exemplar** is one sample observation with its `trace_id`, attached to a histogram bucket.
Grafana draws them as dots on the latency graph. Click the dot at 4.8 s and you open that
request's trace in Tempo. You need all four parts of the chain: the SDK records exemplars for
sampled spans, the Collector's `prometheus` exporter exposes OpenMetrics, Prometheus runs with
`--enable-feature=exemplar-storage`, and the Grafana Prometheus data source maps the
`trace_id` label to Tempo.

## Logs with Loki (and Alloy)

**Loki** is "Prometheus for logs": it indexes only a small set of **labels** per stream and
stores the log lines compressed in chunks (in production, on S3-compatible object storage). It
doesn't build a full-text index. Queries select streams by label, then filter lines:

```text
# stream selector {labels}, then a line filter, then parse a JSON stdout line and filter a field
{service_name="nginx", namespace="shop"} |= "payment" | json | status >= 500

# OTLP-ingested logs: trace_id/OrderId live in structured metadata, filter them directly
{service_name="orders-api"} | trace_id="4bf92f3577b34da6a3ce929d0e0e4736"

# logs → metric: OOM lines per service per second
sum by (service_name) (rate({service_name=~".+"} |= "OutOfMemory" [5m]))
```

The `{…}` part must match at least one label with a non-empty value. Loki uses it to pick the
streams to read, so it should be as narrow as your labels allow. Everything after it (`|=`,
`| json`, `| key="value"`) scans the lines of those streams.

**Label discipline is the whole game.** Every unique label combination is a separate **stream**
with its own chunks and index entries. High-cardinality labels (`user_id`, `trace_id`,
`order_id`, request path, pod IP) explode the stream count, slow ingestion down and blow up the
index. Loki enforces stream limits and starts rejecting pushes.

| Make it a label (few values, used to *select*) | Keep it in the line or structured metadata (filter on it) |
|---|---|
| `service_name`, `namespace`, `deployment_environment`, `cluster`, `level` | `trace_id`, `span_id`, `user_id`, `order_id`, `http_route`, request body |

Loki 3 has **structured metadata**: per-line key/values that aren't indexed but can be filtered
(`| trace_id="4bf9…"`). With OTLP ingestion (`/otlp` endpoint), Loki promotes a few resource
attributes (like `service.name` → `service_name`) to labels by default and stores the rest,
including `trace_id`, as structured metadata. That's usually the right split.

**Getting logs in:**

* **App → OTLP → Collector → Loki** (this lesson's lab): logs leave the app already structured and
  correlated.
* **Grafana Alloy** for everything that only writes to stdout (nginx, third-party images, the
  Kubernetes nodes). Alloy is Grafana's OpenTelemetry Collector distribution with its own config
  language. It replaced the Grafana Agent and **Promtail**, both of which are deprecated. In
  Kubernetes it runs as a DaemonSet that tails `/var/log/pods`. Locally it can read the Docker
  socket:

```text
// config.alloy
discovery.docker "containers" {
  host = "unix:///var/run/docker.sock"
}

loki.source.docker "containers" {
  host       = "unix:///var/run/docker.sock"
  targets    = discovery.docker.containers.targets
  forward_to = [loki.write.local.receiver]
}

loki.write "local" {
  endpoint {
    url = "http://loki:3100/loki/api/v1/push"
  }
}
```

:::warn title="Alloy component names change between releases"
The Alloy snippet shows the shape (discover → source → write, connected with `forward_to`).
Component arguments do change between Alloy releases. Copy from the Alloy docs for your version,
and use `alloy fmt` to validate the file.
:::

:::quiz id=cl-08-q8 xp=15
Which of these are good **Loki labels**? (Select all that apply.)
- [x] `service_name`
- [x] `level` (debug/info/warn/error)
- [ ] `trace_id`
- [ ] `user_id`
> Labels define **streams**. They should have few values and be what you *select by*.
> `service_name` and `level` have a handful of values each. `trace_id` is tempting because you
> search for it all the time, but it's unique per request: millions of streams, each with one
> line. Put it in **structured metadata** (or the JSON line) and filter with
> `{service_name="orders-api"} | trace_id="…"`. The service label narrows the search, and the
> filter does the rest quickly. (`level` is fine as a label because it has ~5 values. Loki 3 can
> also detect it per line and store it as `detected_level` structured metadata, so some teams
> skip the label. Both are valid. A label with millions of values never is.)
:::

## Traces: Tempo or Jaeger

| | **Grafana Tempo** | **Jaeger (v2)** |
|---|---|---|
| Ingest | OTLP (also Jaeger/Zipkin) | OTLP. v2 is built on the OTel Collector core |
| Storage | Object storage only (S3/GCS/Azure, Parquet blocks). Cheap at scale | Cassandra, Elasticsearch/OpenSearch, Badger, memory… |
| Query | **TraceQL**: `{ resource.service.name="orders-api" && span.http.response.status_code >= 500 }` | Search by service/operation/tags, plus a mature UI |
| Fits | The Grafana stack (links to Loki/Prometheus, exemplars, span metrics) | Standalone tracing, teams already on Elasticsearch |

Both store what the SDK and Collector send, so the instrumentation is the same. Tempo can also
generate **span metrics** (RED metrics derived from spans) and **service graphs** with its
metrics-generator, or the Collector can do it with the `spanmetrics` connector.

:::info title="Object storage in production and locally"
Tempo, Loki and Mimir (scalable Prometheus) all keep their data in an S3 bucket in production.
For a realistic local or self-hosted setup, point them at the **SeaweedFS** S3 gateway from
**Object Storage & Direct Uploads (S3)**, not MinIO (its community edition no longer gets
releases or images). The lab below uses local disk to keep it small. To switch Tempo and Loki to
the SeaweedFS service from that lesson (`seaweedfs:8333`, same `s3.json` credentials), create
the buckets first (`aws --endpoint-url http://localhost:8333 s3 mb s3://tempo`, and the same
for `loki`), because neither creates them:

```yaml
# tempo.yaml
storage:
  trace:
    backend: s3
    s3:
      endpoint: seaweedfs:8333     # host:port, no scheme
      bucket: tempo
      region: us-east-1
      access_key: devquest
      secret_key: devquest-local-secret
      insecure: true               # plain HTTP locally
      forcepathstyle: true         # http://host/bucket/key: SeaweedFS has no per-bucket DNS
    wal:
      path: /tmp/tempo/wal
```

```yaml
# loki.yaml: replace common.storage.filesystem, and set object_store: s3 in schema_config
common:
  storage:
    s3:
      endpoint: seaweedfs:8333
      bucketnames: loki
      region: us-east-1
      access_key_id: devquest
      secret_access_key: devquest-local-secret
      insecure: true
      s3forcepathstyle: true
```

Path-style addressing is the same idea as `ForcePathStyle = true` in the AWS SDK for .NET.
Without it the client asks for `tempo.seaweedfs:8333`, a host that doesn't exist.
:::

:::warn title="Storage keys differ per backend and release"
Tempo calls the flag `forcepathstyle`, Loki calls it `s3forcepathstyle`, and both have renamed
storage keys before (Loki 3 also has a newer "thanos" object-store client with different
names). Check the storage configuration page for your exact Tempo and Loki versions, and use
real secrets (env vars or a mounted file), not literals, outside a laptop.
:::

:::pro title="Sampling is a budget decision"
Tracing 100 % of a busy API costs more than the API itself. Common setup: SDK
`parentbased_traceidratio` at 10–25 % for root spans, plus **tail sampling** in a gateway
Collector that keeps *all* traces with errors or `duration > 2s`. Metrics stay 100 % accurate,
because they are counted before sampling. That's why alerts come from metrics, never from
sampled traces.
:::

## Lab: the whole stack in Docker Compose

:::lab id=cl-08-lab1 xp=120
title: OTel Collector + Prometheus + Grafana + Loki + Tempo + a .NET API, and a RED dashboard
You'll run the full observability stack locally, point a .NET 10 API at it, generate traffic,
and build a RED dashboard with a burn-rate alert. You need Docker (Compose v2), the .NET 10 SDK,
`curl` and `jq`.

:::warn title="Image tags: pin them, and pin the newest"
The tags below were the newest stable releases when this lesson was last updated (November 2026):
Collector contrib 0.164.0, Prometheus 3.16.0, Loki 3.7.9, Tempo 2.10.10 and Grafana 13.3.0. Never
use `latest` in a compose file you share: the stack changes under you on the next `pull`, and
"it worked yesterday" becomes impossible to debug. Instead, **check each project's releases page
when you start, pin the newest stable tag, and bump deliberately** (Renovate or Dependabot can
open the PRs). Watch three things when you bump:

* **Collector** components get renamed (the `otlp_grpc`/`otlp_http` exporters above) and the
  old name lives on only as a deprecated alias. `docker compose logs otel-collector` lists
  deprecation warnings at startup. Fix them before the alias is removed.
* **Tempo 3.0** is a major release with a new ingest architecture and breaking config changes
  (it ships `tempo-cli migrate config` to help), and **Loki 4.0** is in release candidates. This
  lab stays on the newest Tempo 2.x and Loki 3.x releases on purpose, because the single-binary
  configs below are written for them. Move to a new major with its migration guide, not by
  editing the tag.
* Tempo and Loki have renamed storage and limits keys even between minor versions. If a
  container exits after a bump, run `docker compose logs <service>` and compare with that
  release's docs.
:::

**1. Project layout**

```bash
mkdir -p obs-lab && cd obs-lab
dotnet new web -n OrdersApi -o OrdersApi
cd OrdersApi
dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
dotnet add package OpenTelemetry.Instrumentation.Runtime
cd ..
```

**2. `docker-compose.yml`**

```yaml
services:
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.164.0
    command: ["--config=/etc/otelcol/config.yaml"]
    volumes:
      - ./otel-collector.yaml:/etc/otelcol/config.yaml:ro
    ports:
      - "4317:4317"   # OTLP gRPC (the API on your host sends here)
      - "4318:4318"   # OTLP HTTP
      - "8889:8889"   # Prometheus scrape endpoint exposed by the collector
    depends_on: [tempo, loki]

  prometheus:
    image: prom/prometheus:v3.16.0
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --enable-feature=exemplar-storage
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./rules.yml:/etc/prometheus/rules.yml:ro
    ports: ["9090:9090"]

  loki:
    image: grafana/loki:3.7.9
    command: ["-config.file=/etc/loki/config.yaml"]
    volumes:
      - ./loki.yaml:/etc/loki/config.yaml:ro
    ports: ["3100:3100"]

  tempo:
    image: grafana/tempo:2.10.10
    command: ["-config.file=/etc/tempo/config.yaml"]
    volumes:
      - ./tempo.yaml:/etc/tempo/config.yaml:ro
    ports: ["3200:3200"]

  grafana:
    image: grafana/grafana:13.3.0
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"     # local lab only: no login
      GF_AUTH_ANONYMOUS_ORG_ROLE: Admin
      GF_AUTH_DISABLE_LOGIN_FORM: "true"
    volumes:
      - ./grafana-datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml:ro
    ports: ["3000:3000"]
    depends_on: [prometheus, loki, tempo]
```

**3. `otel-collector.yaml`**

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 80
    spike_limit_percentage: 25
  batch: {}

exporters:
  otlp_grpc/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  prometheus:
    endpoint: 0.0.0.0:8889
    enable_open_metrics: true      # needed to expose exemplars
  otlp_http/loki:
    endpoint: http://loki:3100/otlp
  debug:
    verbosity: basic

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_grpc/tempo, debug]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheus]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [otlp_http/loki]
```

**4. `prometheus.yml` and `rules.yml`**

```yaml
# prometheus.yml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
rule_files:
  - /etc/prometheus/rules.yml
scrape_configs:
  - job_name: otel-collector
    honor_labels: true             # keep job="orders-api" from the data, don't overwrite with "otel-collector"
    static_configs:
      - targets: ["otel-collector:8889"]
```

```yaml
# rules.yml
groups:
  - name: orders-api-slo
    rules:
      - record: job:slo_errors_per_request:ratio_rate5m
        expr: |
          sum by (job) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))
          / sum by (job) (rate(http_server_request_duration_seconds_count[5m]))
      - record: job:slo_errors_per_request:ratio_rate1h
        expr: |
          sum by (job) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[1h]))
          / sum by (job) (rate(http_server_request_duration_seconds_count[1h]))
      - alert: ErrorBudgetBurnFast
        expr: |
          job:slo_errors_per_request:ratio_rate1h{job="orders-api"} > (14.4 * 0.001)
          and
          job:slo_errors_per_request:ratio_rate5m{job="orders-api"} > (14.4 * 0.001)
        for: 2m
        labels:
          severity: page
        annotations:
          summary: "{{ $labels.job }} burns its 99.9% error budget >14x too fast"
```

**5. `loki.yaml` and `tempo.yaml`** (single-binary, local disk under `/tmp`, so the non-root
container users can write)

```yaml
# loki.yaml
auth_enabled: false
server:
  http_listen_port: 3100
common:
  instance_addr: 127.0.0.1
  path_prefix: /tmp/loki
  storage:
    filesystem:
      chunks_directory: /tmp/loki/chunks
      rules_directory: /tmp/loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory
schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
limits_config:
  allow_structured_metadata: true   # required for OTLP ingestion
```

```yaml
# tempo.yaml
stream_over_http_enabled: true
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
storage:
  trace:
    backend: local
    local:
      path: /tmp/tempo/blocks
    wal:
      path: /tmp/tempo/wal
```

**6. `grafana-datasources.yaml`**

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    uid: prometheus
    url: http://prometheus:9090
    isDefault: true
    jsonData:
      exemplarTraceIdDestinations:
        - name: trace_id
          datasourceUid: tempo
  - name: Tempo
    type: tempo
    uid: tempo
    url: http://tempo:3200
    jsonData:
      tracesToLogsV2:
        datasourceUid: loki
        spanStartTimeShift: "-5m"
        spanEndTimeShift: "5m"
        # trace_id is structured metadata (not text in the line), so filter on it explicitly.
        # "$$" escapes Grafana's env-var expansion in provisioning files.
        customQuery: true
        query: '{service_name="orders-api"} | trace_id="$${__trace.traceId}"'
  - name: Loki
    type: loki
    uid: loki
    url: http://loki:3100
```

**7. `OrdersApi/Program.cs`** (replace the file)

```csharp
using System.Diagnostics;
using System.Diagnostics.Metrics;
using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(serviceName: "orders-api", serviceVersion: "1.0.0")
        .AddAttributes(new Dictionary<string, object> { ["deployment.environment.name"] = "local" }))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource(Telemetry.Name))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter(Telemetry.Name)
        .AddView("shop.payment.duration",
            new ExplicitBucketHistogramConfiguration { Boundaries = [0.05, 0.1, 0.25, 0.5, 1, 2.5] }))
    .WithLogging(
        logging => { },
        options => options.IncludeFormattedMessage = true)  // Loki line = rendered text, not the template
    .UseOtlpExporter();   // reads OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4317 (gRPC)

builder.Services.AddHttpClient("payments", c => c.BaseAddress = new Uri("http://localhost:5080"));

var app = builder.Build();
var rng = Random.Shared;

app.MapGet("/orders/{id:int}", async (int id, ILogger<Program> log) =>
{
    await Task.Delay(rng.Next(5, 120));
    if (rng.NextDouble() < 0.05)
    {
        log.LogError("Order {OrderId} lookup failed: storage timeout", id);
        return Results.Problem("storage timeout", statusCode: 503);
    }
    log.LogInformation("Order {OrderId} served", id);
    return Results.Ok(new { id, status = "shipped" });
});

app.MapPost("/checkout", async (IHttpClientFactory http, ILogger<Program> log) =>
{
    using var activity = Telemetry.Source.StartActivity("checkout.place-order");
    var orderId = rng.Next(1000, 9999);
    activity?.SetTag("shop.order.id", orderId);

    var res = await http.CreateClient("payments").PostAsync("/payments", null);
    if (!res.IsSuccessStatusCode)
    {
        activity?.SetStatus(ActivityStatusCode.Error, "payment failed");
        log.LogWarning("Payment for order {OrderId} failed with {StatusCode}", orderId, (int)res.StatusCode);
        return Results.Problem("payment failed", statusCode: 502);
    }

    Telemetry.OrdersPlaced.Add(1, new KeyValuePair<string, object?>("shop.payment.method", "card"));
    log.LogInformation("Order {OrderId} placed", orderId);
    return Results.Ok(new { orderId });
});

app.MapPost("/payments", async () =>
{
    var sw = Stopwatch.StartNew();
    await Task.Delay(rng.Next(50, 400));
    var ok = rng.NextDouble() > 0.1;
    Telemetry.PaymentDuration.Record(sw.Elapsed.TotalSeconds,
        new KeyValuePair<string, object?>("shop.payment.outcome", ok ? "ok" : "declined"));
    return ok ? Results.Ok() : Results.StatusCode(500);
});

app.Run();

static class Telemetry
{
    public const string Name = "Shop.Orders";
    public static readonly ActivitySource Source = new(Name);
    private static readonly Meter Meter = new(Name);
    public static readonly Counter<long> OrdersPlaced =
        Meter.CreateCounter<long>("shop.orders.placed", unit: "{order}");
    public static readonly Histogram<double> PaymentDuration =
        Meter.CreateHistogram<double>("shop.payment.duration", unit: "s");
}
```

**8. Start everything and generate traffic**

```bash
docker compose up -d
docker compose ps                  # all five services "running"

# terminal 1: the API
cd OrdersApi
OTEL_METRIC_EXPORT_INTERVAL=5000 dotnet run --urls http://localhost:5080

# terminal 2: load
while true; do
  curl -s -o /dev/null "http://localhost:5080/orders/$((RANDOM % 100))"
  curl -s -o /dev/null -X POST http://localhost:5080/checkout
  sleep 0.2
done
```

**9. Verify each signal from the command line** (wait about 30 s after starting the load)

```bash
# metrics reached the collector's scrape endpoint
curl -s localhost:8889/metrics | grep '^http_server_request_duration_seconds_count' | head -3
```

Expected (labels vary a bit by version):

```text
http_server_request_duration_seconds_count{http_request_method="GET",http_response_status_code="200",http_route="/orders/{id:int}",instance="…",job="orders-api",…} 143
http_server_request_duration_seconds_count{http_request_method="POST",http_response_status_code="200",http_route="/checkout",instance="…",job="orders-api",…} 127
http_server_request_duration_seconds_count{http_request_method="POST",http_response_status_code="502",http_route="/checkout",instance="…",job="orders-api",…} 14
```

```bash
# Prometheus can query it (job label preserved thanks to honor_labels)
curl -s localhost:9090/api/v1/query \
  --data-urlencode 'query=sum by (http_route) (rate(http_server_request_duration_seconds_count{job="orders-api"}[1m]))' \
  | jq -r '.data.result[] | "\(.metric.http_route)  \(.value[1])"'
```

```text
/orders/{id:int}  2.31
/checkout  2.29
/payments  2.29
```

```bash
# Loki has the logs, with service_name as a label
curl -s localhost:3100/loki/api/v1/labels | jq -c .data
curl -sG localhost:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="orders-api"} |= "failed"' --data-urlencode limit=2 \
  | jq -r '.data.result[].values[][1]'

# Tempo has traces (TraceQL search)
curl -sG localhost:3200/api/search \
  --data-urlencode 'q={resource.service.name="orders-api" && name="POST /checkout"}' \
  --data-urlencode limit=3 | jq -r '.traces[] | "\(.traceID) \(.rootTraceName) \(.durationMs)ms"'
```

Expected: the labels list contains `"service_name"`, you see lines like
`Payment for order 4821 failed with 500`, and three trace IDs with `POST /checkout`.

:::tip title="Nothing arrives?"
`docker compose logs otel-collector` shows the `debug` exporter printing a line per trace batch.
No lines means the API isn't reaching `localhost:4317`, so check that the collector's port is
published. Lines but no Prometheus data: open `http://localhost:9090/targets`, the
`otel-collector` target must be **UP**.
:::

**10. Build the RED dashboard** at `http://localhost:3000` → Dashboards → New → Add
visualization → Prometheus. Create these panels (Code mode):

| Panel | Query | Unit / setting |
|---|---|---|
| Rate | `sum by (http_route) (rate(http_server_request_duration_seconds_count{job="orders-api"}[$__rate_interval]))` | requests/sec |
| Errors | `sum by (http_route) (rate(http_server_request_duration_seconds_count{job="orders-api",http_response_status_code=~"5.."}[$__rate_interval])) / sum by (http_route) (rate(http_server_request_duration_seconds_count{job="orders-api"}[$__rate_interval]))` | Percent (0.0-1.0) |
| Duration p95 | `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket{job="orders-api"}[$__rate_interval])))` | seconds. Add p50 and p99 as extra queries |
| Payments p95 | `histogram_quantile(0.95, sum by (le, shop_payment_outcome) (rate(shop_payment_duration_seconds_bucket{job="orders-api"}[$__rate_interval])))` | seconds |
| Orders/min | `sum(rate(shop_orders_placed_total{job="orders-api"}[$__rate_interval])) * 60` | Stat panel |
| Logs | Loki: `{service_name="orders-api"} \|= "failed"` | Logs visualization |

Save it as **orders-api RED**. Then open **Explore → Tempo**, search
`{resource.service.name="orders-api" && status=error}` and open a trace: you should see
`POST /checkout` → `checkout.place-order` → `POST` (HttpClient) → `POST /payments`.
Use **Logs for this span** to jump to Loki. If that opens Loki with an empty result, look at the
generated query: a `trace_id=""` means the `$$` escape in `grafana-datasources.yaml` was lost,
and a plain line filter `|= "<trace id>"` means the custom query isn't active. Grafana's
trace-to-logs options have changed across versions, so compare with the Tempo data source docs
for your Grafana release.

**11. Watch the alert.** `http://localhost:9090/alerts`: with about 5 % failing `/orders` and
10 % failing payments, the error ratio is far above 1.44 %. `ErrorBudgetBurnFast` goes
**Pending**, then **Firing** after `for: 2m`. Stop the load loop and watch it resolve within a few
minutes. That's the 5 m window doing its job.

**Bonus: exemplars.** Add `.SetExemplarFilter(ExemplarFilterType.TraceBased)` to the
`WithMetrics(...)` chain, restart the API, and turn on **Exemplars** in the Duration panel's
query options. Dots appear on the graph, and clicking one opens the trace in Tempo.

:::warn title="Exemplar plumbing is version-sensitive"
The exemplar filter API was experimental in older OpenTelemetry .NET releases, and some versions
default to `AlwaysOff`. You can also try the environment variable
`OTEL_METRICS_EXEMPLAR_FILTER=trace_based`. If no dots appear, check each link of the chain:
`curl -H 'Accept: application/openmetrics-text' localhost:8889/metrics | grep '# {'` should
show exemplars. If it does, the problem is in Prometheus or Grafana.
:::

When you're done: `docker compose down` (add `-v` only if you created named volumes and want them
deleted).

- [ ] `docker compose ps` shows collector, Prometheus, Loki, Tempo and Grafana running, and `/targets` shows the collector **UP**
- [ ] The Prometheus query returns a per-route request rate with `job="orders-api"`
- [ ] Loki returns `orders-api` log lines, and Tempo search returns `POST /checkout` traces
- [ ] A trace shows `checkout.place-order` with the HttpClient call and `POST /payments` as children
- [ ] The **orders-api RED** dashboard shows Rate, Errors and p95 Duration per route, plus a logs panel
- [ ] `ErrorBudgetBurnFast` went Pending → Firing under load and resolved after the load stopped
:::

:::job title="Observability in a real team"
Expect a platform team to run the Collector, Prometheus/Mimir, Loki and Tempo (or a vendor like
Grafana Cloud, Datadog or Honeycomb; with OTLP your code stays the same). Product teams own their
**service dashboards, SLOs and alert rules**, usually as code in the service repo. On-call
rotations come with runbooks linked from each alert. If an alert has no runbook and no clear
action, expect someone to ask you to delete it.
:::

:::pro title="Kubernetes notes"
In K8s, the **OpenTelemetry Operator** can inject auto-instrumentation and manage Collectors
(`OpenTelemetryCollector` CRD). **kube-prometheus-stack** (Helm) installs Prometheus, Alertmanager
and Grafana and discovers scrape targets through `ServiceMonitor`/`PodMonitor` resources. KEDA's
`prometheus` trigger can scale your worker on the exact PromQL you wrote for the dashboard (see
**KEDA: Autoscale Workers on Queue Depth**). Watch your cardinality budget: every pod name label
multiplies the series count.
:::

:::quiz id=cl-08-q9 xp=10
In the lab, Prometheus scrapes the Collector. Without `honor_labels: true`, what would you see?
- [ ] No metrics at all
- [x] Every series gets `job="otel-collector"` from the scrape config, and the app's job moves to `exported_job="orders-api"`, so `{job="orders-api"}` queries return nothing
- [ ] Duplicate series for every metric
- [ ] Exemplars are dropped but everything else works
> On conflicts Prometheus normally lets **its own** target labels (`job`, `instance`) win and
> renames the scraped ones to `exported_*`. When you scrape an aggregator like the Collector (or
> a Pushgateway), the scraped labels are the real ones, so `honor_labels: true` keeps them.
> "No metrics" is tempting, but the data is there under a different label, which is why your
> dashboard looks empty.
:::

:::cards id=cl-08-cards1 xp=15 title="Observability stack"
Q: Metrics vs traces vs logs, in one line each?
A: Metrics: is it wrong and how bad (cheap aggregates, alerts). Traces: where in the request path. Logs: what exactly happened.
Q: RED vs USE?
A: RED (Rate, Errors, Duration) for request-serving things. USE (Utilization, Saturation, Errors) for resources like pools, CPU and queues.
Q: The W3C traceparent format?
A: `version-traceid-parentid-flags`, e.g. `00-<32 hex>-<16 hex>-01`. Flag 01 = sampled. All-zero ids are invalid.
Q: Collector pipeline building blocks?
A: Receivers → processors (memory_limiter first, batch last) → exporters, wired per signal under `service.pipelines`.
Q: How do .NET apps create spans and metrics?
A: With the BCL: `ActivitySource.StartActivity()` and `Meter.CreateCounter/CreateHistogram`. The OTel SDK subscribes via `AddSource()` / `AddMeter()`.
Q: Why `sum by (le)` before `histogram_quantile`?
A: Bucket counts can be added across pods, quantiles can't. Merge buckets, then estimate the quantile once.
Q: Why rate() before sum()?
A: rate() handles counter resets per series. Summing raw counters first turns pod restarts into bogus drops.
Q: Burn rate formula?
A: Error ratio ÷ (1 − SLO). Page at 14.4 over 1 h and 5 m, or 6 over 6 h and 30 m, for a 30-day SLO.
Q: Good vs bad Loki labels?
A: Good: service_name, namespace, env, level. Bad: trace_id, user_id, order_id, paths. Put those in structured metadata.
Q: What is an exemplar?
A: A sample observation with its trace_id attached to a histogram bucket. It links a latency spike to a concrete trace.
Q: Grafana Alloy?
A: Grafana's OTel Collector distribution (replaces Grafana Agent and Promtail). Tails container logs and forwards to Loki/OTLP.
Q: Metric vs span attribute cardinality?
A: Spans can carry high-cardinality ids. Metric labels must stay low-cardinality, because each combination is a time series.
:::

## Recap

- **Metrics** detect and alert, **traces** locate, **logs** explain. Shared `trace_id` and
  resource attributes are what let you click from one to the next.
- Use **RED** for anything that serves requests and **USE** for resources. Saturation (pool waits,
  queue age) usually moves first.
- **OpenTelemetry** = API + SDK + OTLP + Collector. The Collector runs receivers → processors
  (`memory_limiter` first, `batch` last) → exporters per pipeline. Bind to `0.0.0.0` in
  containers.
- **Context propagation** uses `traceparent` (`00-traceid-spanid-flags`). Frameworks handle HTTP,
  but you inject and extract it yourself in message headers and outbox rows, and you allow it in
  CORS for the SPA.
- In **.NET 10**, `AddOpenTelemetry()` with ASP.NET Core, HttpClient, Npgsql and runtime
  instrumentation, your own `ActivitySource`/`Meter`, `WithLogging()` and `UseOtlpExporter()`.
  Keep metric tags low-cardinality, and give histograms buckets in the right unit.
- **PromQL**: `rate` before `sum`, `sum by (le)` before `histogram_quantile`, never average
  percentiles, and use `$__rate_interval` in Grafana.
- **Alert on symptoms** with SLO burn rates (14.4x over 1 h and 5 m, 6x over 6 h and 30 m). Put
  causes on dashboards.
- **Loki** labels stay low-cardinality and `trace_id` goes in structured metadata. **Alloy**
  collects stdout logs. **Tempo** stores traces cheaply in object storage (SeaweedFS locally).
- **Pin the newest stable image tags** and bump them on purpose; Collector component names and
  Tempo/Loki config keys change between releases.
- With OTLP, moving to **Azure Monitor / Application Insights** or **CloudWatch / X-Ray** (or their
  managed Prometheus and Grafana) is an exporter change, not new instrumentation. **The Managed Equivalents: Azure & AWS** shows the mapping.
