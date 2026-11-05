---
id: cl-06
title: "KEDA: Autoscale Workers on Queue Depth"
level: expert
minutes: 180
xp: 100
summary: Scale queue workers 0 → N → 0 on the work actually waiting — KEDA's architecture, ScaledObject vs ScaledJob, triggers, activation and cooldown, secrets, node autoscaling, graceful shutdown and what it really saves.
---

In **ops-15** you met KEDA in one paragraph: "the HPA can't scale to zero and doesn't know your
queue, KEDA can". This lesson is the deep version — the one you need on the day the video
pipeline from the boss fight, **The Media Processing Pipeline**, falls 40 minutes behind, or the finance team asks why the worker pool
costs the same at 3 a.m. as at 3 p.m.

You will learn *why* CPU is the wrong signal for workers, how KEDA is wired into Kubernetes, how to
read every knob on a `ScaledObject` (and which knob does *not* do what its name suggests), how
scaling interacts with node autoscaling and with a worker that is halfway through a job, and you'll
finish by watching a .NET worker go **0 → 10 → 0** on a Redis list in a local kind cluster.

## Why CPU-based HPA is wrong for queue workers

The **HorizontalPodAutoscaler (HPA)** is the built-in Kubernetes controller that changes a
Deployment's `replicas` from a metric. Its default signal is CPU utilization **as a percentage of
the pods' CPU request**. For an **API** that's a decent proxy: more requests → more CPU. For a
**queue worker** it breaks down in three ways.

**1. Most workers are I/O-bound.** A thumbnail worker downloads from S3 (*Object Storage & Direct Uploads*), calls an image
service, uploads the result. It spends 90 % of its time *waiting*. CPU sits at 15 % while the
backlog grows from 200 to 20 000 jobs. The HPA sees "15 % of request, target 70 % → scale *down*".

**2. CPU measures effort, not debt.** Even a CPU-bound worker at 100 % tells you "I'm busy", not
"I'm 40 minutes behind". A queue with 10 jobs and a queue with 100 000 jobs both produce one pod
at 100 %. The thing your users feel — **latency until their job is done** — is a function of
**queue depth ÷ throughput**, so that is what you should scale on.

**3. Idle still costs one pod.** The HPA's `minReplicas` is at least 1 (`0` needs the
`HPAScaleToZero` feature gate, alpha for years and not offered by managed clusters — and even then the
HPA has no metric to wake up on, because a CPU metric needs a running pod). A worker that has nothing
to do for 20 hours a day still holds its requests on a node, and the node can't go away.

```text
              backlog (jobs waiting)                 CPU of the worker pods
 20 000 ┤                     ╭────╮          100 % ┤
        │                  ╭──╯    ╰─╮              │
 10 000 ┤              ╭───╯         ╰──╮      70 % ┤ - - - - - - - - - - - - - - - HPA target
        │          ╭───╯                ╰─╮         │
      0 ┼──────────╯                      ╰─   15 % ┤━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ (I/O wait)
        09:00     09:10     09:20     09:30         09:00     09:10     09:20     09:30
        users wait longer and longer…               …and the HPA never moves.
```

The fix is to scale on the **work itself**: "I want one worker per 25 waiting jobs, at most 30
workers, and zero workers when nothing is waiting." That sentence *is* a KEDA `ScaledObject`.

:::info title="Little's law, the one formula worth remembering"
`wait ≈ backlog ÷ throughput`. With 6 000 jobs waiting and each worker doing 2 jobs/s, one worker
means 50 minutes of wait; 20 workers mean 2.5 minutes. Pick a target per replica from the latency
you can tolerate: `target = acceptableWaitSeconds × jobsPerSecondPerWorker`.
:::

:::quiz id=cl-06-q1 xp=15
A PDF-export worker has an HPA on CPU (target 70 %). Each export mostly waits on a headless
browser over HTTP. During the Monday-morning spike the queue grows from 300 to 9 000 jobs while
the HPA stays at 2 replicas. What's going on?
- [ ] The HPA's 10 % tolerance is swallowing the change
- [x] The pods are I/O-bound, so CPU stays far below target; the HPA is correctly following a signal that doesn't reflect the backlog
- [ ] The HPA needs a higher `maxReplicas`
- [ ] CPU requests are missing, so the HPA shows `<unknown>`
> The HPA is doing exactly what it was told: CPU is low, so it doesn't add pods. The problem is
> the *signal*. Raising `maxReplicas` (the tempting answer) changes nothing because the HPA never
> asks for more than 2. The 10 % tolerance only ignores changes *near* the target — CPU far
> below 70 % is not "near". Missing requests would show `<unknown>/70%`, not a stable 2. Scale on
> queue depth instead.
:::

## KEDA architecture

KEDA (Kubernetes Event-Driven Autoscaling, a CNCF graduated project) does **not** replace the HPA.
It *feeds* it and covers the one thing the HPA can't do: going to and from zero.

```text
                        ┌──────────────────────── namespace: keda ─────────────────────────┐
  you apply             │                                                                    │
  ScaledObject ────────►│  keda-operator                                                     │
  (keda.sh/v1alpha1)    │   • watches ScaledObjects / ScaledJobs / TriggerAuthentications     │
                        │   • runs the SCALERS (redis, rabbitmq, postgresql, prometheus, …)  │
                        │     every pollingInterval ──► "is there work?" (activation)        │
                        │   • 0 ↔ 1: patches the Deployment's replicas ITSELF                │
                        │   • creates and owns an HPA "keda-hpa-<name>" for 1 ↔ N            │
                        │                ▲ gRPC                                              │
                        │  keda-operator-metrics-apiserver                                   │
                        │   • serves external.metrics.k8s.io  (s0-redis-dq-jobs-ready = 480) │
                        │                                                                    │
                        │  keda-admission-webhooks                                           │
                        │   • rejects broken specs, two ScaledObjects on one Deployment, …   │
                        └────────────────────────────────────────────────────────────────────┘
                                         ▲ every ~15 s
  HorizontalPodAutoscaler keda-hpa-worker ┘  desired = ceil(480 / 25) = 20 → clamp to max
                │
                ▼
  Deployment worker  replicas: 0 … maxReplicaCount
```

Two phases, two owners — this is the single most important mental model:

| Phase | Range | Who decides | Driven by |
|---|---|---|---|
| **Activation** | 0 ↔ 1 | KEDA operator | `pollingInterval`, activation threshold, `cooldownPeriod` |
| **Scaling** | 1 ↔ N | the HPA KEDA created | target value per replica, HPA `behavior`, `maxReplicaCount` |

* The HPA formula for KEDA's default metric type `AverageValue` boils down to
  `desired = ceil(metricValue ÷ target)` — 480 jobs at target 25 → 20 replicas — then the usual
  10 % tolerance, `behavior` rate limits and the `[minReplicaCount (≥1), maxReplicaCount]` clamp.
  `AverageValue` means "this much work **per replica**", which is exactly what a queue length
  needs. (A trigger can set `metricType: Value` instead; then the HPA computes
  `ceil(currentReplicas × metric ÷ target)` and tries to hold the *total* at the target. Keep the
  default for queue depth unless you know why you want the other.)
* The metrics adapter registers the cluster's **`external.metrics.k8s.io`** API. There can only be
  **one** provider of that API per cluster — if you already run prometheus-adapter for external
  metrics, they collide. (Custom metrics, `custom.metrics.k8s.io`, are a separate API and fine.)
* Because KEDA owns the HPA, **you don't write one** and you don't set `spec.replicas` in your
  Deployment manifest (GitOps would reset it on every sync — ops-15's "don't fight the HPA").

```bash
kubectl get scaledobject worker      # READY / ACTIVE / FALLBACK / PAUSED columns
kubectl get hpa keda-hpa-worker      # the HPA KEDA generated
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1/namespaces/keda-lab/s0-redis-dq-jobs-ready?labelSelector=scaledobject.keda.sh%2Fname%3Dworker"
# ↑ the raw number KEDA hands the HPA (namespace/metric match the lab at the end of this lesson)
```

:::warn title="Check the exact metric name"
KEDA names metrics `s<triggerIndex>-<scaler>-<suffix>` (e.g. `s0-redis-dq-jobs-ready` for the
lab's list `dq:jobs:ready`: KEDA turns `:`, `.`, `/` and `%` into `-`). The suffix differs
per scaler and has changed across releases. Read it from `kubectl get hpa keda-hpa-worker -o yaml`
instead of guessing.
:::

## ScaledObject, knob by knob

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
  namespace: media
spec:
  scaleTargetRef:
    name: worker                  # Deployment by default; StatefulSet or any /scale resource too
  minReplicaCount: 0              # default 0  → scale to zero allowed
  maxReplicaCount: 30             # default 100 → ALWAYS set it (see the incident below)
  pollingInterval: 15             # default 30 s — how often the operator asks the scalers
  cooldownPeriod: 300             # default 300 s — last active → 0 (ONLY the step to zero)
  initialCooldownPeriod: 60       # default 0 — grace after creation before the first scale to 0
  fallback:                       # scaler broken (Redis down, bad password)? hold N replicas
    failureThreshold: 3           # …after 3 failed polls in a row (not for cpu/memory triggers;
                                  #    many releases support AverageValue triggers only)
    replicas: 4
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:                   # 1 ↔ N speed: this is where "scale down faster" lives
        scaleDown:
          stabilizationWindowSeconds: 120
          policies:
            - type: Percent
              value: 50
              periodSeconds: 60
  triggers:
    - type: redis
      metadata:
        address: redis.media.svc.cluster.local:6379
        listName: thumbnails
        listLength: "25"          # target: 25 waiting items per replica
        activationListLength: "0" # wake from zero when there's > 0 items
      authenticationRef:
        name: redis-auth
```

:::warn title="Defaults and fields move between releases"
The defaults above are those of current KEDA 2.x (`keda.sh/v1alpha1` is still the only API
version). Newer fields such as `initialCooldownPeriod` or fallback options don't exist in older
releases — check the
[ScaledObject spec](https://keda.sh/docs/latest/reference/scaledobject-spec/) for the version you
actually run (`helm list -n keda`).
:::

### pollingInterval

How often the **operator** runs each trigger's scaler. At zero replicas it is your **wake-up
latency**: with `pollingInterval: 30` a job can wait up to 30 s before anyone notices it, plus pod
start time. Once at ≥ 1 replica, the HPA polls the metrics adapter on its own ~15 s cadence (by
default the adapter then asks the scaler on demand; `useCachedMetrics: true` on a trigger makes it
serve the value from the last poll instead — less load on Redis/Postgres, slightly staler data).

Shorter is not free: every poll is a query against your broker or database. A `postgresql` trigger
running `SELECT count(*)` over a 50-million-row table every 5 s is a self-inflicted outage.

### cooldownPeriod — the most misunderstood knob

`cooldownPeriod` is **only** the wait between "the last time any trigger was active" and "scale to
**zero**". It has **no effect** on scaling 10 → 3. That's the HPA's job, tuned with
`advanced.horizontalPodAutoscalerConfig.behavior` — whose default scale-down stabilization window
is **300 s**.

```text
 queue  ▁▅█▇▅▃▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁
 pods   0 1 5 10 10 10 10 … 3 … 1 1 1 0
          │ │               │     │   └ cooldownPeriod elapsed since last "active" → KEDA sets 0
          │ │               │     └ HPA floor is 1 (it can never go below)
          │ │               └ HPA scale-down, paced by behavior.scaleDown (stabilization window)
          │ └ HPA scale-up (default: double or +4 pods per 15 s, whichever is more: 1 → 5 → 10)
          └ KEDA activation: the operator itself sets replicas 0 → 1
```

### minReplicaCount, maxReplicaCount, idleReplicaCount

* `minReplicaCount: 0` enables scale-to-zero. `minReplicaCount: 1` keeps one warm worker — no cold
  start — and **disables activation entirely**: the HPA handles everything from 1 to N.
* `maxReplicaCount` is not just a cost cap, it's **protection for downstream systems**. Every
  worker opens database connections, hits a third-party API, writes to S3.
* `idleReplicaCount` (optional, must be below `minReplicaCount`; in practice only `0` is supported)
  gives you "0 when idle, but never below N once active".

:::warn title="Incident pattern: the thundering herd"
A team ships a ScaledObject without `maxReplicaCount`. A partner bulk-uploads 400 000 jobs.
KEDA's default max is **100**; 100 worker pods each open a pool of 20 Npgsql connections against a
Postgres with `max_connections = 200`. The API — same database — starts failing with
`53300: too many connections`. Scaling the workers took down the product. Size
`maxReplicaCount` from the **weakest downstream dependency**, not from the queue.
:::

### Activation thresholds

Every scaler has a *target* (`listLength`, `value`, `threshold`, …) and an **activation** value
(`activationListLength`, `activationValue`, …, default `0`). The trigger is **active when the
metric is strictly greater than the activation value**.

Two rules surprise people:

1. Activation only matters when `minReplicaCount` is `0`. At `minReplicaCount ≥ 1` the HPA is in
   charge and activation is ignored.
2. If activation and target disagree, **activation wins**. KEDA's docs give the example: target
   10, activation 50, metric 40 → the trigger is inactive and the workload goes to **zero**, even
   though the HPA "wants" 4.

Use activation to avoid waking a 2 GB worker for one stray job ("only start when ≥ 20 are
waiting"), and accept that those few jobs wait until more arrive or a cron trigger sweeps them.

:::quiz id=cl-06-q2 xp=15
Ops complains that after the nightly import the worker sits at 10 replicas for ~5 minutes before
shrinking. A teammate sets `cooldownPeriod: 30`. The next night nothing changes. Why?
- [ ] KEDA caches the old ScaledObject until the operator restarts
- [x] `cooldownPeriod` only controls the final step to zero; 10 → 1 is the HPA's scale-down, governed by its stabilization window (300 s by default) — set `advanced.horizontalPodAutoscalerConfig.behavior.scaleDown`
- [ ] `cooldownPeriod` must be smaller than `pollingInterval`
- [ ] The queue never really drains, so KEDA stays active
> The ~5 minutes is the HPA's default 300 s scale-down stabilization window. `cooldownPeriod`
> only delays 1 → 0. The fix lives in the `advanced.horizontalPodAutoscalerConfig.behavior` block
> KEDA copies into the HPA it generates. "The queue never drains" is tempting, but then the
> replicas would never shrink at all; a steady ~5-minute delay after every import is the
> stabilization window's fingerprint. KEDA picks up ScaledObject changes without a restart.
:::

:::quiz id=cl-06-q3 xp=15
A Redis trigger has `listLength: "10"`, `activationListLength: "50"`, and the ScaledObject has
`minReplicaCount: 0`, `maxReplicaCount: 20`. The list holds **40** items and the worker is at 0.
How many replicas run?
- [x] 0 — 40 is not above the activation value 50, and activation wins over the target
- [ ] 4 — `ceil(40 / 10)`
- [ ] 1 — KEDA always activates one pod when the list is non-empty
- [ ] 20 — the HPA scales to max when it can't decide
> The trigger is active only when the metric is *greater* than its activation value. 40 ≤ 50 →
> inactive → KEDA keeps (or scales) the workload at zero. `ceil(40/10) = 4` is what the HPA would
> compute *if* it were in charge — but with min 0, the 0 ↔ 1 decision belongs to activation.
:::

## Write the scaling rule yourself

Putting the rules together turns into a small, very testable function. This is exactly the kind of
logic you'll want in a capacity-planning spreadsheet or a load-test report.

:::challenge id=cl-06-c1 lang=ts xp=50
title: How many replicas does KEDA want?
Implement `desiredReplicas(queueLength, cfg)` with KEDA + HPA semantics (ignore the HPA's 10 %
tolerance and rate limits):

1. If `targetPerReplica <= 0` → throw an `Error` containing `"target"`.
2. If `minReplicaCount >= 1`: the HPA is in charge, activation is ignored →
   `ceil(queueLength / targetPerReplica)` clamped to `[minReplicaCount, maxReplicaCount]`.
3. If `minReplicaCount === 0`:
   * not active (`queueLength <= activationThreshold`) → `0`;
   * active → `ceil(queueLength / targetPerReplica)` clamped to `[1, maxReplicaCount]`.

```text
desiredReplicas(500, { targetPerReplica: 25, activationThreshold: 0, minReplicaCount: 0, maxReplicaCount: 10 }) → 10
desiredReplicas(40,  { targetPerReplica: 10, activationThreshold: 50, minReplicaCount: 0, maxReplicaCount: 20 }) → 0
```

hint: `Math.ceil` — 26 jobs at 25 per replica need 2 workers, not 1.
hint: Write a tiny `clamp(v, lo, hi)` helper: `Math.min(hi, Math.max(lo, v))`.
hint: Active means *strictly greater* than the activation threshold.

```ts starter
export interface ScaleConfig {
  targetPerReplica: number
  activationThreshold: number
  minReplicaCount: number
  maxReplicaCount: number
}

export function desiredReplicas(queueLength: number, cfg: ScaleConfig): number {
  // TODO: KEDA activation + HPA scaling
  return Math.round(queueLength / cfg.targetPerReplica)
}
```

```ts solution
export interface ScaleConfig {
  targetPerReplica: number
  activationThreshold: number
  minReplicaCount: number
  maxReplicaCount: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function desiredReplicas(queueLength: number, cfg: ScaleConfig): number {
  if (cfg.targetPerReplica <= 0) throw new Error('target per replica must be > 0')
  const wanted = Math.ceil(queueLength / cfg.targetPerReplica)
  if (cfg.minReplicaCount >= 1) return clamp(wanted, cfg.minReplicaCount, cfg.maxReplicaCount)
  const active = queueLength > cfg.activationThreshold
  if (!active) return 0
  return clamp(wanted, 1, cfg.maxReplicaCount)
}
```

```ts tests
const base = { targetPerReplica: 25, activationThreshold: 0, minReplicaCount: 0, maxReplicaCount: 10 }

test('empty queue with min 0 scales to zero', () => {
  expect(desiredReplicas(0, base)).toBe(0)
})
test('one job wakes one worker', () => {
  expect(desiredReplicas(1, base)).toBe(1)
})
test('rounds up: 26 jobs at 25/replica = 2', () => {
  expect(desiredReplicas(26, base)).toBe(2)
})
test('exactly on target: 100 jobs = 4', () => {
  expect(desiredReplicas(100, base)).toBe(4)
})
test('clamped to maxReplicaCount', () => {
  expect(desiredReplicas(500, base)).toBe(10)
})
test('activation wins over the target (KEDA docs example)', () => {
  expect(desiredReplicas(40, { targetPerReplica: 10, activationThreshold: 50, minReplicaCount: 0, maxReplicaCount: 20 })).toBe(0)
})
test('active is strictly greater than the activation threshold', () => {
  const cfg = { ...base, activationThreshold: 20 }
  expect(desiredReplicas(20, cfg)).toBe(0)
  expect(desiredReplicas(21, cfg)).toBe(1)
})
test('min >= 1 ignores activation and keeps the floor', () => {
  const cfg = { targetPerReplica: 2, activationThreshold: 10, minReplicaCount: 1, maxReplicaCount: 20 }
  expect(desiredReplicas(8, cfg)).toBe(4)
  expect(desiredReplicas(0, cfg)).toBe(1)
})
test('min 3 is respected for a small queue', () => {
  expect(desiredReplicas(10, { ...base, minReplicaCount: 3 })).toBe(3)
})
test('fractional metrics (e.g. Prometheus rates) still round up', () => {
  expect(desiredReplicas(0.4, { ...base, targetPerReplica: 1 })).toBe(1)
})
test('rejects a zero target', () => {
  expect(() => desiredReplicas(10, { ...base, targetPerReplica: 0 })).toThrow('target')
})
```
:::

Now the other side: a teammate wrote the function, and you are reviewing it. Good tests for
autoscaling rules focus on **boundaries** — exactly at activation, exactly on target, just above
max, `min = 0` vs `min ≥ 1`.

:::challenge id=cl-06-c2 lang=ts mode=tests xp=40
title: Catch the autoscaling bugs
Write tests for `desiredReplicas(queueLength, cfg)` (same rules as the previous challenge — the
correct implementation is shown below). Your tests must pass on it and fail on each of four hidden
buggy versions. Each bug breaks exactly one rule: the strict `>` activation comparison, the
`maxReplicaCount` clamp, "`minReplicaCount ≥ 1` ignores activation", or rounding *up*.

hint: Test `queueLength` exactly equal to `activationThreshold`.
hint: Test a value that needs rounding *up* by a small amount (e.g. 26 / 25).
hint: Test `minReplicaCount: 1` with a queue below the activation threshold.

```ts impl
export interface ScaleConfig { targetPerReplica: number; activationThreshold: number; minReplicaCount: number; maxReplicaCount: number }
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export function desiredReplicas(q: number, cfg: ScaleConfig): number {
  if (cfg.targetPerReplica <= 0) throw new Error('target per replica must be > 0')
  const wanted = Math.ceil(q / cfg.targetPerReplica)
  if (cfg.minReplicaCount >= 1) return clamp(wanted, cfg.minReplicaCount, cfg.maxReplicaCount)
  if (!(q > cfg.activationThreshold)) return 0
  return clamp(wanted, 1, cfg.maxReplicaCount)
}
```

```ts mutant
export interface ScaleConfig { targetPerReplica: number; activationThreshold: number; minReplicaCount: number; maxReplicaCount: number }
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export function desiredReplicas(q: number, cfg: ScaleConfig): number {
  if (cfg.targetPerReplica <= 0) throw new Error('target per replica must be > 0')
  const wanted = Math.ceil(q / cfg.targetPerReplica)
  if (cfg.minReplicaCount >= 1) return clamp(wanted, cfg.minReplicaCount, cfg.maxReplicaCount)
  if (!(q >= cfg.activationThreshold)) return 0
  return clamp(wanted, 1, cfg.maxReplicaCount)
}
```

```ts mutant
export interface ScaleConfig { targetPerReplica: number; activationThreshold: number; minReplicaCount: number; maxReplicaCount: number }
export function desiredReplicas(q: number, cfg: ScaleConfig): number {
  if (cfg.targetPerReplica <= 0) throw new Error('target per replica must be > 0')
  const wanted = Math.ceil(q / cfg.targetPerReplica)
  if (cfg.minReplicaCount >= 1) return Math.max(wanted, cfg.minReplicaCount)
  if (!(q > cfg.activationThreshold)) return 0
  return Math.max(wanted, 1)
}
```

```ts mutant
export interface ScaleConfig { targetPerReplica: number; activationThreshold: number; minReplicaCount: number; maxReplicaCount: number }
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export function desiredReplicas(q: number, cfg: ScaleConfig): number {
  if (cfg.targetPerReplica <= 0) throw new Error('target per replica must be > 0')
  const wanted = Math.ceil(q / cfg.targetPerReplica)
  if (!(q > cfg.activationThreshold)) return cfg.minReplicaCount
  return clamp(wanted, Math.max(1, cfg.minReplicaCount), cfg.maxReplicaCount)
}
```

```ts mutant
export interface ScaleConfig { targetPerReplica: number; activationThreshold: number; minReplicaCount: number; maxReplicaCount: number }
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export function desiredReplicas(q: number, cfg: ScaleConfig): number {
  if (cfg.targetPerReplica <= 0) throw new Error('target per replica must be > 0')
  const wanted = Math.round(q / cfg.targetPerReplica)
  if (cfg.minReplicaCount >= 1) return clamp(wanted, cfg.minReplicaCount, cfg.maxReplicaCount)
  if (!(q > cfg.activationThreshold)) return 0
  return clamp(wanted, 1, cfg.maxReplicaCount)
}
```

```ts starter
const cfg = { targetPerReplica: 25, activationThreshold: 0, minReplicaCount: 0, maxReplicaCount: 10 }

test('100 jobs at 25 per replica = 4', () => {
  expect(desiredReplicas(100, cfg)).toBe(4)
})
```

```ts solution
const cfg = { targetPerReplica: 25, activationThreshold: 0, minReplicaCount: 0, maxReplicaCount: 10 }

test('on target', () => expect(desiredReplicas(100, cfg)).toBe(4))
test('exactly at activation stays at zero', () => expect(desiredReplicas(0, cfg)).toBe(0))
test('rounds up', () => expect(desiredReplicas(26, cfg)).toBe(2))
test('clamped to max', () => expect(desiredReplicas(500, cfg)).toBe(10))
test('min >= 1 ignores activation', () => {
  expect(desiredReplicas(8, { targetPerReplica: 2, activationThreshold: 10, minReplicaCount: 1, maxReplicaCount: 20 })).toBe(4)
})
```
:::

## ScaledObject vs ScaledJob

A `ScaledObject` scales a **long-running Deployment** whose pods loop "take job, do job". When the
HPA scales down, Kubernetes picks *some* pod and sends it SIGTERM — possibly one that is 30
minutes into a 45-minute transcode.

A `ScaledJob` instead creates a **Kubernetes `Job` per unit of work** (or per batch). Each Job's pod
takes one item, processes it, and exits. Nothing is ever "scaled down" under a running job:
completion is the only way out.

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: transcode
spec:
  jobTargetRef:
    backoffLimit: 2
    activeDeadlineSeconds: 7200          # kill runaway jobs after 2 h
    template:
      spec:
        restartPolicy: Never
        containers:
          - name: transcode
            image: ghcr.io/acme/transcoder:1.8.0
            resources:
              requests: { cpu: "2", memory: 4Gi }
  pollingInterval: 10
  maxReplicaCount: 20                    # max Jobs running at once
  successfulJobsHistoryLimit: 5
  failedJobsHistoryLimit: 10
  scalingStrategy:
    strategy: accurate                   # default | custom | accurate | eager — see docs
  triggers:
    - type: rabbitmq
      metadata:
        queueName: transcode
        mode: QueueLength
        value: "1"                       # one message = one Job
      authenticationRef:
        name: rabbitmq-auth
```

| | ScaledObject | ScaledJob |
|---|---|---|
| Workload | Deployment / StatefulSet (long-running) | One K8s `Job` per item/batch |
| Scaling down | HPA kills *some* pod → graceful shutdown matters | Never interrupted; pod exits when done |
| Good for | Many short jobs (ms–seconds), high throughput | Long, heavy, spiky jobs (minutes–hours) |
| Startup cost | Paid once per pod, amortised over thousands of jobs | Paid **per job** (scheduling, image pull, .NET startup) |
| Per-job isolation | Shared process (memory leaks accumulate) | Fresh pod per job |
| Uses an HPA | Yes | No — KEDA creates Jobs directly |

:::warn title="ScaledJob strategies are subtle"
`scalingStrategy` decides how many *new* Jobs to create given queue length and Jobs already
running (`default` subtracts running Jobs, `accurate` assumes your consumer removes or locks the
message when it starts, `eager` fills up to max). The exact formulas changed between KEDA releases,
so read the ScaledJob page of the KEDA docs for your version before you rely on one.
:::

:::quiz id=cl-06-q4 xp=15
Your pipeline transcodes uploaded videos. A job takes 5–45 minutes and needs 2 CPUs; uploads
arrive in bursts. Which KEDA setup fits best?
- [ ] ScaledObject on a Deployment with `cooldownPeriod: 3600` so pods are never removed mid-job
- [x] ScaledJob with one message per Job — each transcode runs to completion in its own pod and is never scaled down under
- [ ] An HPA on CPU — transcoding is CPU-bound, so CPU is the right signal
- [ ] ScaledObject with `minReplicaCount: 20` to avoid cold starts
> With long jobs, any scale-down of a Deployment can hit a busy pod. `cooldownPeriod` only affects
> the step to zero — the HPA can still go 10 → 3 at any time and SIGTERM busy pods, so the
> tempting first option doesn't protect you. A ScaledJob ties a pod's life to one job, and the
> minute-long cold start is negligible next to a 5–45-minute job.
:::

## Triggers you'll actually use

One ScaledObject can have several triggers. The HPA computes a replica count for each and takes the
**maximum**; KEDA activates if **any** trigger is active.

| Trigger `type` | Measures | Key metadata (target / activation) | Watch out for |
|---|---|---|---|
| `redis` | `LLEN` of a list | `listName`, `listLength` / `activationListLength` | Counts only *waiting* items — not items a worker moved to a processing list |
| `redis-streams` | Pending entries of a consumer group (default), or stream length / lag | `stream`, `consumerGroup`, `pendingEntriesCount` (or `streamLength`, `lagCount`) | Pending = delivered but un-acked → includes in-flight *and* stuck entries |
| `rabbitmq` | Queue length or message rate | `queueName`, `mode: QueueLength\|MessageRate`, `value` / `activationValue` | Whether un-acked messages count depends on `protocol` (amqp vs http) |
| `postgresql` | Any query returning one number | `query`, `targetQueryValue` / `activationTargetQueryValue` | The query runs every poll — make it cheap (partial index on `status`) |
| `prometheus` | Any PromQL returning one number | `serverAddress`, `query`, `threshold` / `activationThreshold` | Great for "requests in flight" or lag you already export (*Observability* lesson) |
| `metrics-api` | A number from your own HTTP endpoint | `url`, `valueLocation`, `targetValue` / `activationTargetValue` | Your endpoint is now on the autoscaling path — keep it fast and up |
| `cron` | Time window | `timezone`, `start`, `end`, `desiredReplicas` | Pre-warm before a known daily spike |

```yaml
triggers:
  # Redis Streams (Redis as Queue, Bus and Lock): scale on entries delivered to the group but not yet XACKed
  - type: redis-streams
    metadata:
      address: redis.media.svc.cluster.local:6379
      stream: thumbnails
      consumerGroup: thumbnailers
      pendingEntriesCount: "20"
    authenticationRef: { name: redis-auth }

  # RabbitMQ 4 (Message Brokers lesson): queue length; host comes from the secret
  - type: rabbitmq
    metadata:
      protocol: amqp
      queueName: emails
      mode: QueueLength
      value: "50"
      activationValue: "0"
    authenticationRef: { name: rabbitmq-auth }

  # PostgreSQL as a queue (FOR UPDATE SKIP LOCKED)
  - type: postgresql
    metadata:
      query: "SELECT count(*) FROM jobs WHERE status = 'queued'"
      targetQueryValue: "10"
      activationTargetQueryValue: "0"
    authenticationRef: { name: jobs-db }

  # Prometheus (Observability lesson): consumer lag your app already exports
  - type: prometheus
    metadata:
      serverAddress: http://prometheus.monitoring.svc:9090
      query: sum(outbox_pending_messages{service="dispatcher"})
      threshold: "100"
      activationThreshold: "5"

  # metrics-api: your own endpoint returns {"backlog": {"total": 812}}
  - type: metrics-api
    metadata:
      url: http://jobs-api.media.svc/internal/backlog
      valueLocation: backlog.total
      targetValue: "40"
```

:::warn title="Verify scaler fields against your KEDA version"
Scaler metadata evolves: `redis-streams` gained `streamLength`/`lagCount` modes in later 2.x
releases (lag needs Redis 7+), and RabbitMQ's handling of un-acknowledged messages differs between
`amqp` and `http` (`excludeUnacknowledged` is http-only). Always check the scaler's page on
keda.sh for the release you run — the field names above are the common, stable ones.
:::

:::quiz id=cl-06-q5 xp=15
A worker uses the reliable-queue pattern: `LMOVE dq:jobs:ready → dq:jobs:processing:<pod>`, process for ~4
minutes, then `LREM`. The ScaledObject has a `redis` trigger on `listName: dq:jobs:ready`,
`minReplicaCount: 0`, `cooldownPeriod: 60`. Users report that long jobs randomly restart from
scratch, and the bill shows the same jobs processed 3–4 times. What's the root cause?
- [ ] Redis lists are not durable, so items are lost on restart
- [x] Once the last items are moved to processing lists, `LLEN dq:jobs:ready` is 0 — KEDA sees "no work", and after 60 s scales the busy workers to zero, killing jobs mid-flight
- [ ] `cooldownPeriod` must equal `pollingInterval`
- [ ] The HPA's tolerance causes oscillation between 0 and 1
> The `redis` scaler counts only *waiting* items. In-flight work is invisible to it, so "queue
> empty" looks like "idle". Fixes: count in-flight work too (e.g. a second trigger on a shared
> processing list, a `redis-streams` trigger on pending entries, or a `metrics-api`/`prometheus`
> trigger reporting `waiting + in_flight`), make `cooldownPeriod` exceed your longest job, and
> handle SIGTERM by returning the job — or switch to a ScaledJob.
:::

## Secrets: TriggerAuthentication

Scalers need credentials — the Redis password, the RabbitMQ URI, the Postgres connection string.
Never put them in trigger `metadata`; that ends up in Git and in `kubectl get scaledobject -o yaml`.
A `TriggerAuthentication` maps **scaler parameters** to secret sources:

```yaml
apiVersion: v1
kind: Secret
metadata: { name: redis-auth, namespace: media }
type: Opaque
stringData:
  password: s3cr3t                       # in real life: created by External Secrets / Sealed Secrets
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata: { name: redis-auth, namespace: media }   # SAME namespace as the ScaledObject
spec:
  secretTargetRef:
    - parameter: password                # the scaler's parameter name
      name: redis-auth                   # Secret name
      key: password                      # key inside the Secret
```

Other sources in the same spec: `env` (read an env var from the scale target's container),
`podIdentity` (cloud workload identity — Azure, AWS, GCP — no static secret at all),
`hashiCorpVault`, and cloud secret managers. For one credential shared by many namespaces use a
**`ClusterTriggerAuthentication`** (`authenticationRef: { name: …, kind: ClusterTriggerAuthentication }`);
its Secrets are read from the namespace KEDA itself runs in (`keda` by default).

:::quiz id=cl-06-q6 xp=15
The ScaledObject in namespace `workers` shows `READY False` with an event like
`error getting secret … not found`. The TriggerAuthentication and its Secret were created in
namespace `keda`, "next to KEDA". What's the fix?
- [ ] Restart the KEDA operator so it picks up the new Secret
- [x] Create the TriggerAuthentication and Secret in `workers` (it's namespaced and resolves Secrets in its own namespace), or switch to a ClusterTriggerAuthentication
- [ ] Put the password directly in the trigger metadata
- [ ] Give the worker's ServiceAccount permission to read Secrets in `keda`
> `authenticationRef` looks up a TriggerAuthentication in the ScaledObject's namespace, and that
> TriggerAuthentication reads Secrets from its own namespace. Restarting changes nothing. The
> ServiceAccount option is tempting but irrelevant: the KEDA operator reads the Secret, not your
> worker. A ClusterTriggerAuthentication is the cluster-wide variant.
:::

## When pods don't fit: KEDA meets the cluster autoscaler

KEDA scales **pods**. If the nodes are full, new pods are `Pending` — and that's where the
**cluster autoscaler** (or Karpenter) from ops-15 takes over:

```text
 t=0s    500 jobs land in the list
 t≈5s    KEDA poll → active → Deployment 0 → 1
 t≈20s   HPA: ceil(500/25)=20 → clamp to 30 → +4/+100 % per 15 s → 1 → 5 → 10 → 20
 t≈35s   12 pods Running, 8 Pending ("0/3 nodes are available: Insufficient cpu")
 t≈40s   cluster autoscaler sees unschedulable pods → asks the cloud for 2 nodes
 t≈2-3m  nodes Ready → image pulled → .NET starts → all 20 workers consuming
 …       queue drains → HPA scales down → KEDA → 0 after cooldownPeriod
 +10m    nodes under-utilised (~50 % of requests) for ~10 min → CA drains & deletes them
```

Consequences you need to design for:

* **Cold start is layered**: KEDA poll + pod scheduling + *possibly a new node* + image pull +
  runtime start. For a .NET worker on a fresh node that can be 2–4 minutes. Small images (chiseled
  or AOT, ops-07), pre-pulled images and a warm `minReplicaCount: 1` all help.
* **Requests decide everything.** The CA reasons about *requests*, not usage. A worker requesting
  `cpu: 6` on 4-vCPU nodes stays Pending forever (ops-15 q4).
* **Scale-down needs evictable pods.** Pods with `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`,
  local storage or a too-strict PDB keep a node (and its bill) alive.
* **Dedicated worker pools**: taint a node pool `workload=worker:NoSchedule`, give workers the
  toleration + nodeSelector, and let that pool scale to zero nodes. Spot/preemptible nodes are a
  great fit for idempotent workers — if shutdown is graceful (AWS gives a 2-minute notice, GCP ~30 s).

:::pro title="Headroom for spiky queues"
If the time-to-first-job matters, keep a low-priority **placeholder** Deployment of `pause` pods
in the worker pool (overprovisioning). Real workers preempt them instantly; the evicted
placeholders go Pending and make the CA add the next node in the background.
:::

## Graceful shutdown: finishing the current job

Every scale-down is a pod receiving SIGTERM. The contract:

```text
 HPA lowers replicas ─► ReplicaSet picks pods to delete (lowest pod-deletion-cost, newest, …)
   └► pod Terminating ─► preStop hook (if any) ─► SIGTERM to PID 1
        └► terminationGracePeriodSeconds (default 30 s) ─► SIGKILL, no questions asked
```

A well-behaved worker does three things on SIGTERM:

1. **Stop taking new jobs** immediately.
2. **Finish the current job** if it fits in the remaining budget.
3. Otherwise **hand the lease back**: return the item to the queue (Redis `LMOVE` back, RabbitMQ
   `nack`/requeue, Postgres: release the row lock / reset `locked_until`) so another worker picks it
   up now — not after a visibility timeout expires.

And because SIGKILL, OOM kills and node crashes skip all of that, processing must be **idempotent**
anyway (at-least-once delivery, *Message Brokers & the Outbox Pattern*).

In .NET the relevant clocks nest like this — each must be shorter than the next:

```text
 in-flight job budget (20 s)  <  HostOptions.ShutdownTimeout (25 s)  <  terminationGracePeriodSeconds (30 s)
```

```csharp
public sealed class Worker(IConnectionMultiplexer redis, ILogger<Worker> log) : BackgroundService
{
    private readonly CancellationTokenSource _hardStop = new();

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        // stoppingToken (below) is now cancelled → the loop takes no new jobs.
        // The in-flight job keeps running on _hardStop for up to 20 more seconds.
        _hardStop.CancelAfter(TimeSpan.FromSeconds(20));
        return base.StopAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            // take a job …
            // await ProcessAsync(job, _hardStop.Token);   ← NOT stoppingToken
            // on OperationCanceledException → return the job to the queue
        }
    }
}
```

The classic bug is passing `stoppingToken` into the job itself: every scale-down then cancels
every in-flight job instantly, they're all retried, and the more you autoscale the more work you
redo. The full version of this worker is in the lab.

:::pro title="Steering which pod dies"
For long jobs on a Deployment, a worker can annotate its own pod with
`controller.kubernetes.io/pod-deletion-cost` (higher = deleted later) when it picks up work and
reset it when idle, so the ReplicaSet prefers idle pods on scale-down. It costs an API call per job
and is best-effort — fine for minute-long jobs, overkill for millisecond ones (use a ScaledJob for
hour-long ones).
:::

:::job title="What you'll meet on day one"
Expect a Helm chart (or Kustomize overlay) per worker with a `ScaledObject`, a
`TriggerAuthentication` pointing at an External-Secrets-managed Secret, and a Grafana panel
"queue depth vs replicas" (the previous lesson, *Observability*). The first ticket is usually "the worker is slow to wake up" (raise
`pollingInterval` awareness, warm replica) or "jobs get processed twice" (graceful shutdown and
idempotency). Being able to explain activation vs HPA scaling in two sentences is a real interview
differentiator.
:::

:::quiz id=cl-06-q7 xp=15
A worker processes jobs that take ~50 s. The Deployment uses defaults
(`terminationGracePeriodSeconds: 30`) and the .NET code passes `stoppingToken` into the job.
Which changes belong in the fix? They are applied together. (Select all that apply.)
- [x] Run the in-flight job on its own token with a budget (e.g. 60 s), and return the job to the queue when the budget runs out
- [x] Raise `terminationGracePeriodSeconds` (e.g. 90) and `HostOptions.ShutdownTimeout` (e.g. 80) so a 50 s job can finish
- [x] Make processing idempotent, because SIGKILL and node failures still happen
- [ ] Set `cooldownPeriod: 3600` so pods are never removed
> Graceful shutdown needs all three: don't cancel the job on the first signal, give it enough
> time (job budget 60 s < shutdown timeout 80 s < grace period 90 s), and survive the cases where
> no signal arrives. Note that raising the timeouts *alone* does nothing while the job still runs
> on `stoppingToken` — it is cancelled the instant SIGTERM arrives, however long the grace period. `cooldownPeriod` only delays the final step to zero; the HPA still scales 10 → 2
> whenever the queue shrinks, so it protects nothing.
:::

## Simulating the timeline

Reasoning about "when will it scale down?" in your head is error-prone: two independent clocks
(KEDA's cooldown and the HPA's stabilization window) interact. A simulator with an **injected
clock** — the timestamps are just numbers in the input — makes it testable and repeatable.

:::challenge id=cl-06-c3 lang=ts xp=60
title: Simulate cooldown and stabilization
Implement `simulateScaling(samples, cfg)`. Each sample `{ t, queueLength }` is one poll (`t` in
seconds, increasing — this is your fake clock). Return the replica count **after** each sample.

State: `replicas` starts at `cfg.minReplicaCount`; `lastActive` starts as "never"; the HPA keeps a
history of `{ t, rec }` recommendations.

For each sample:

1. `active = queueLength > activationThreshold`; if active, `lastActive = t`.
2. If `minReplicaCount === 0` and **not** active:
   * if `replicas === 0` → stays `0`;
   * else if never active, or `t - lastActive >= cooldownPeriod` → `replicas = 0` and **clear** the
     HPA history.
   * In both of those cases output `0` and go to the next sample.
   * Otherwise (replicas > 0 and still cooling down) fall through to step 4 — the HPA keeps running.
3. If `minReplicaCount === 0`, active and `replicas === 0` (activation 0 → 1) → clear the history.
   (Simplification: we jump straight to the HPA's recommendation instead of 0 → 1 → N, and we
   ignore the HPA's scale-up rate limits and 10 % tolerance.)
4. HPA recommendation: `rec = clamp(ceil(queueLength / targetPerReplica), max(1, minReplicaCount), maxReplicaCount)`.
   Push `{ t, rec }`, drop entries where `t - entry.t >= scaleDownStabilization` (always keep the
   current one), and set `replicas` to the **highest** `rec` left (scale up is immediate, scale down
   waits for the window).

Example (`target 10, activation 0, min 0, max 5, cooldown 60, stabilization 30`):

```text
t:        0   15   30   45   60   75   90  105
queue:    0   45   30    0    0    0    0    0
replicas: 0    5    5    3    1    1    0    0
```

hint: Keep `lastActive` as `number | null`.
hint: Filter the history with `h => t - h.t < cfg.scaleDownStabilization || h.t === t`.
hint: Step 2 runs *before* the HPA step — while cooling down, the HPA still computes a recommendation (its floor is 1).

```ts starter
export interface Sample { t: number; queueLength: number }
export interface SimConfig {
  targetPerReplica: number
  activationThreshold: number
  minReplicaCount: number
  maxReplicaCount: number
  cooldownPeriod: number
  scaleDownStabilization: number
}

export function simulateScaling(samples: Sample[], cfg: SimConfig): number[] {
  // naive: no cooldown, no stabilization
  return samples.map((s) => Math.min(cfg.maxReplicaCount, Math.ceil(s.queueLength / cfg.targetPerReplica)))
}
```

```ts solution
export interface Sample { t: number; queueLength: number }
export interface SimConfig {
  targetPerReplica: number
  activationThreshold: number
  minReplicaCount: number
  maxReplicaCount: number
  cooldownPeriod: number
  scaleDownStabilization: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function simulateScaling(samples: Sample[], cfg: SimConfig): number[] {
  let replicas = cfg.minReplicaCount
  let lastActive: number | null = null
  let history: { t: number; rec: number }[] = []
  const out: number[] = []

  for (const { t, queueLength } of samples) {
    const active = queueLength > cfg.activationThreshold
    if (active) lastActive = t

    if (cfg.minReplicaCount === 0 && !active) {
      if (replicas !== 0 && (lastActive === null || t - lastActive >= cfg.cooldownPeriod)) {
        replicas = 0
        history = []
      }
      if (replicas === 0) {
        out.push(0)
        continue
      }
    }

    if (cfg.minReplicaCount === 0 && active && replicas === 0) history = []

    const rec = clamp(
      Math.ceil(queueLength / cfg.targetPerReplica),
      Math.max(1, cfg.minReplicaCount),
      cfg.maxReplicaCount,
    )
    history.push({ t, rec })
    history = history.filter((h) => t - h.t < cfg.scaleDownStabilization || h.t === t)
    replicas = Math.max(...history.map((h) => h.rec))
    out.push(replicas)
  }
  return out
}
```

```ts tests
const cfg = { targetPerReplica: 10, activationThreshold: 0, minReplicaCount: 0, maxReplicaCount: 5, cooldownPeriod: 60, scaleDownStabilization: 30 }
const at = (queues: number[], step = 15) => queues.map((q, i) => ({ t: i * step, queueLength: q }))

test('the example timeline from the task', () => {
  expect(simulateScaling(at([0, 45, 30, 0, 0, 0, 0, 0]), cfg)).toEqual([0, 5, 5, 3, 1, 1, 0, 0])
})
test('idle from the start stays at zero', () => {
  expect(simulateScaling(at([0, 0, 0]), cfg)).toEqual([0, 0, 0])
})
test('scale up is immediate, even from zero', () => {
  expect(simulateScaling(at([0, 12, 50]), cfg)).toEqual([0, 2, 5])
})
test('new work during cooldown resets the cooldown clock', () => {
  // active at t=15 and again at t=60; zero only once 60 s passed since t=60
  const r = simulateScaling(at([0, 10, 0, 0, 5, 0, 0, 0, 0, 0]), cfg)
  expect(r).toEqual([0, 1, 1, 1, 1, 1, 1, 1, 0, 0])
})
test('stabilization 0 means immediate scale down (but floor 1 until cooldown)', () => {
  const c = { ...cfg, scaleDownStabilization: 0 }
  expect(simulateScaling(at([50, 10, 0, 0, 0, 0]), c)).toEqual([5, 1, 1, 1, 1, 0])
})
test('minReplicaCount 1 never goes to zero and ignores activation', () => {
  const c = { ...cfg, minReplicaCount: 1, activationThreshold: 100 }
  expect(simulateScaling(at([0, 40, 0, 0, 0, 0, 0, 0, 0]), c)).toEqual([1, 4, 4, 1, 1, 1, 1, 1, 1])
})
test('activation threshold above the queue keeps it at zero', () => {
  const c = { ...cfg, activationThreshold: 20 }
  expect(simulateScaling(at([15, 18, 25, 18]), c)).toEqual([0, 0, 3, 3])
})
test('uses the injected timestamps, not sample count', () => {
  const samples = [
    { t: 0, queueLength: 30 },
    { t: 10, queueLength: 0 },
    { t: 59, queueLength: 0 },
    { t: 60, queueLength: 0 },
  ]
  expect(simulateScaling(samples, cfg)).toEqual([3, 3, 1, 0])
})
```
:::

## Cost: what scale-to-zero really saves

Scale-to-zero saves money **only when nodes go away**. Pods at zero on a node you still pay for
save nothing; the cluster autoscaler (or a serverless node offering) is what turns "fewer pods" into
"smaller bill".

Example: a thumbnail worker requests 1 vCPU / 2 GiB. The upload traffic is busy ~4 h/day.

| Setup | Worker pod-hours / month | Notes |
|---|---|---|
| Fixed 10 replicas | 10 × 24 × 30 = **7 200** | Sized for the peak, idle 20 h/day |
| CPU HPA, min 2 | ≈ 2 × 24 × 30 + small peaks ≈ **1 600** | Misses I/O-bound backlogs (see q1) |
| KEDA on queue depth, min 0 | ≈ 8 avg × 4 × 30 ≈ **960** + cold starts | Requires CA/Karpenter to remove the nodes |

Multiply by your provider's price for 1 vCPU + 2 GiB to get money — the *ratio* is the point.
Where the savings leak away:

* **Requests too high** → fewer pods per node → more nodes. Right-size with a VPA in `Off` mode.
* **Cooldowns and stabilization windows** — each scale-down delay is paid capacity. Tune them to
  your job length, not "as long as possible to be safe".
* **Node minimums** — a worker pool with `min: 1` node still costs a node all night.
* **Cold-start latency** is a cost to *users*. For user-facing jobs (an export someone is waiting
  for) a warm `minReplicaCount: 1` is often the right trade; for nightly batch, zero.

:::lab id=cl-06-lab1 xp=150
title: 0 → N → 0 — a .NET worker on a Redis list in kind
You need Docker, [kind](https://kind.sigs.k8s.io), `kubectl`, Helm 3 and the .NET 10 SDK.

**1. Cluster and KEDA**

```bash
kind create cluster --name keda-lab
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda --namespace keda --create-namespace --version 2.21.0
kubectl -n keda rollout status deploy/keda-operator
kubectl get crd | grep keda.sh
```

Expected (order may differ; recent releases also list `cloudeventsources.eventing.keda.sh` and
`clustercloudeventsources.eventing.keda.sh`):

```text
clustertriggerauthentications.keda.sh   …
scaledjobs.keda.sh                      …
scaledobjects.keda.sh                   …
triggerauthentications.keda.sh          …
```

**2. The worker** (a .NET 10 worker service with StackExchange.Redis)

```bash
dotnet new worker -n KedaWorker
cd KedaWorker
dotnet add package StackExchange.Redis
```

Replace `Program.cs`:

```csharp
using KedaWorker;
using StackExchange.Redis;

var builder = Host.CreateApplicationBuilder(args);

// Must be shorter than terminationGracePeriodSeconds (30 s) in k8s.yaml.
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(25));

var redisOptions = ConfigurationOptions.Parse(builder.Configuration["REDIS_HOST"] ?? "localhost:6379");
redisOptions.Password = builder.Configuration["REDIS_PASSWORD"];
redisOptions.AbortOnConnectFail = false;
builder.Services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redisOptions));

builder.Services.AddHostedService<Worker>();
builder.Build().Run();
```

Replace `Worker.cs`:

```csharp
using StackExchange.Redis;

namespace KedaWorker;

public sealed class Worker(IConnectionMultiplexer redis, IConfiguration config, ILogger<Worker> log)
    : BackgroundService
{
    private const string Queue = "dq:jobs:ready";
    private readonly string _processing = $"dq:jobs:processing:{config["POD_NAME"] ?? Environment.MachineName}";
    private readonly int _jobMs = int.TryParse(config["JOB_MS"], out var ms) ? ms : 1000;
    private readonly CancellationTokenSource _hardStop = new();

    public override Task StopAsync(CancellationToken cancellationToken)
    {
        log.LogInformation("SIGTERM: taking no new jobs, in-flight job gets 20 s");
        _hardStop.CancelAfter(TimeSpan.FromSeconds(20));
        return base.StopAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var db = redis.GetDatabase();
        log.LogInformation("Worker started, processing list {List}", _processing);

        while (!stoppingToken.IsCancellationRequested)
        {
            // Atomically take the oldest job and park it in this pod's processing list.
            // Lab shortcut: no lease key, no heartbeat, no reaper (see the warning below).
            RedisValue job = await db.ListMoveAsync(Queue, _processing, ListSide.Left, ListSide.Right);
            if (job.IsNull)
            {
                try { await Task.Delay(500, stoppingToken); } catch (OperationCanceledException) { }
                continue;
            }

            try
            {
                await Task.Delay(_jobMs, _hardStop.Token);   // "work" — on the HARD token, not stoppingToken

                var tx = db.CreateTransaction();             // ack + count atomically
                _ = tx.ListRemoveAsync(_processing, job, 1);
                _ = tx.StringIncrementAsync("dq:jobs:done");
                await tx.ExecuteAsync();
            }
            catch (OperationCanceledException)
            {
                // Out of time: hand the lease back to the FRONT of the queue for another worker.
                await db.ListMoveAsync(_processing, Queue, ListSide.Right, ListSide.Left);
                log.LogWarning("Returned job {Job} to the queue", job.ToString());
                return;
            }
        }
        log.LogInformation("Drained cleanly, exiting");
    }

    public override void Dispose()
    {
        _hardStop.Dispose();
        base.Dispose();
    }
}
```

:::warn title="This worker is not the reliable queue (on purpose)"
The per-pod processing list keeps the lab short, but it is **not** a lease in the sense of
**Redis as Queue, Bus and Lock**: there is no TTL key, no heartbeat and no reaper. It survives the
case this lesson is about, a graceful SIGTERM, because the catch block hands the job back. It does
**not** survive a SIGKILL, an OOM kill or a lost node: the job stays in
`dq:jobs:processing:worker-6d9f…` forever, because that pod name never comes back and nobody
scans the list. After the lab, `redis-cli --scan --pattern 'dq:jobs:processing:*'` shows any such
orphans. Production workers use one shared `dq:jobs:processing` list, a `dq:jobs:lease:<id>` key
with a TTL renewed by a heartbeat, and a reaper that requeues jobs whose lease has expired, exactly
as in that lesson (the boss fight builds it on top of KEDA). The tip at the end of step 6 shows
why the shared list also fixes KEDA's view of in-flight work.
:::

Add `Dockerfile` and `.dockerignore` next to the `.csproj`:

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY *.csproj ./
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/runtime:10.0
WORKDIR /app
COPY --from=build /app .
USER $APP_UID
ENTRYPOINT ["dotnet", "KedaWorker.dll"]
```

```text
bin/
obj/
```

```bash
docker build -t keda-worker:dev .
kind load docker-image keda-worker:dev --name keda-lab
cd ..
```

**3. Redis, the worker Deployment and the ScaledObject.** Save as `k8s.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: keda-lab
---
apiVersion: v1
kind: Secret
metadata:
  name: redis-auth
  namespace: keda-lab
type: Opaque
stringData:
  password: lab-only-password
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
  namespace: keda-lab
spec:
  selector:
    matchLabels: { app: redis }
  template:
    metadata:
      labels: { app: redis }
    spec:
      containers:
        - name: redis
          image: redis:8-alpine
          args: ["--requirepass", "$(REDIS_PASSWORD)", "--appendonly", "no"]
          env:
            - name: REDIS_PASSWORD
              valueFrom: { secretKeyRef: { name: redis-auth, key: password } }
          ports:
            - containerPort: 6379
          readinessProbe:
            tcpSocket: { port: 6379 }
---
apiVersion: v1
kind: Service
metadata:
  name: redis
  namespace: keda-lab
spec:
  selector: { app: redis }
  ports:
    - port: 6379
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: keda-lab
spec:
  # no "replicas:" — KEDA owns it and scales to minReplicaCount right after the ScaledObject is created
  selector:
    matchLabels: { app.kubernetes.io/name: worker }
  template:
    metadata:
      labels: { app.kubernetes.io/name: worker }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: worker
          image: keda-worker:dev
          imagePullPolicy: IfNotPresent
          env:
            - name: REDIS_HOST
              value: redis.keda-lab.svc.cluster.local:6379
            - name: REDIS_PASSWORD
              valueFrom: { secretKeyRef: { name: redis-auth, key: password } }
            - name: POD_NAME
              valueFrom: { fieldRef: { fieldPath: metadata.name } }
            - name: JOB_MS
              value: "1000"
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 192Mi }
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: redis-auth
  namespace: keda-lab
spec:
  secretTargetRef:
    - parameter: password
      name: redis-auth
      key: password
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
  namespace: keda-lab
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 0
  maxReplicaCount: 10
  pollingInterval: 5
  cooldownPeriod: 30
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 15
  triggers:
    - type: redis
      metadata:
        address: redis.keda-lab.svc.cluster.local:6379
        listName: dq:jobs:ready
        listLength: "25"
        activationListLength: "0"
      authenticationRef:
        name: redis-auth
```

```bash
kubectl apply -f k8s.yaml
kubectl -n keda-lab rollout status deploy/redis
kubectl -n keda-lab get scaledobject worker
kubectl -n keda-lab get deploy worker
```

Expected (columns trimmed):

```text
NAME     SCALETARGETKIND      SCALETARGETNAME   MIN   MAX   READY   ACTIVE   …
worker   apps/v1.Deployment   worker            0     10    True    False    …

NAME     READY   UP-TO-DATE   AVAILABLE   AGE
worker   0/0     0            0           20s
```

**4. Watch** — in a second terminal:

```bash
kubectl -n keda-lab get hpa,pods -w
```

While idle the HPA shows `REPLICAS 0` and an `<unknown>` target: that is normal. With the
Deployment at zero the HPA reports `ScalingActive False` ("the replica count of the target is
zero") and waits — only the KEDA operator can bring it back to 1.

**5. Push 500 jobs** (first terminal):

```bash
kubectl -n keda-lab exec deploy/redis -- sh -c \
  'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning RPUSH dq:jobs:ready $(seq 1 500)'
```

Expected: `500`. In the watch terminal you should see, within ~5 s, one worker pod created, then the
HPA climbing to 10 (`ceil(500/25) = 20`, clamped to max 10), something like:

```text
NAME                                                  REFERENCE           TARGETS                                MINPODS   MAXPODS   REPLICAS
horizontalpodautoscaler.autoscaling/keda-hpa-worker   Deployment/worker   s0-redis-dq-jobs-ready: 470/25 (avg)   1         10        1
horizontalpodautoscaler.autoscaling/keda-hpa-worker   Deployment/worker   s0-redis-dq-jobs-ready: 92/25 (avg)    1         10        5
horizontalpodautoscaler.autoscaling/keda-hpa-worker   Deployment/worker   s0-redis-dq-jobs-ready: 31/25 (avg)    1         10        10
pod/worker-6d9f7c8b5-2xkqp   1/1   Running   0   40s
…
```

(The `TARGETS` format differs between kubectl versions; the `(avg)` value is list length ÷ current
replicas.) With 10 workers at 1 job/s the list drains in roughly a minute. Then the HPA scales down
after its 15 s window, and ~30 s after the last poll that saw items, KEDA takes the Deployment to
**0**; the pods go `Terminating` → gone.

```bash
kubectl -n keda-lab exec deploy/redis -- sh -c \
  'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning GET dq:jobs:done'
kubectl -n keda-lab describe hpa keda-hpa-worker | tail -n 8
```

Expected: `500` (redis-cli prints raw values when there is no TTY; with `kubectl exec -it` you'd
see `"500"`, because Redis stores the counter as a string) and HPA events such as
`New size: 10; reason: external metric s0-redis-dq-jobs-ready(…) above target`.

**6. Break it on purpose — slow jobs vs graceful shutdown**

Wait until the worker is back at 0. Then make jobs slow (40 s each), make the trigger ask for one
worker per waiting job, and push just 10 jobs — fewer jobs than workers, so the list empties while
every worker is still busy:

```bash
kubectl -n keda-lab set env deploy/worker JOB_MS=40000
kubectl -n keda-lab patch scaledobject worker --type json \
  -p '[{"op":"replace","path":"/spec/triggers/0/metadata/listLength","value":"1"}]'
kubectl -n keda-lab exec deploy/redis -- sh -c \
  'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning RPUSH dq:jobs:ready $(seq 1 10)'
kubectl -n keda-lab logs -f -l app.kubernetes.io/name=worker --prefix --max-log-requests 20
```

(The `logs -f -l` selector only follows pods that exist when you run it — re-run it once the
pods are up.) The scaler only counts jobs still **waiting** in `dq:jobs:ready` — a job parked in a pod's
processing list is invisible to it — so the HPA never asks for more pods than that number. KEDA
wakes the Deployment to 1, and the HPA's default scale-up limit lets it climb 1 → 5 in one step.
Each new pod takes one job, and then you see **5 busy pods next to 5 waiting jobs**, because
desired = `ceil(5 ÷ 1)` = 5 = current. Nothing changes for ~40 s. Then the first pods finish and
take the remaining jobs; every job taken lowers `LLEN dq:jobs:ready`, so the HPA lowers its recommendation
(to the minimum of 1 once the list is empty) and, after the 15 s window, SIGTERMs pods that are
still busy. A 40 s job doesn't fit in the 20 s budget, so you'll see `Returned job … to the queue`.
That makes the list non-empty, which re-activates KEDA and scales up again — and once the list
stays empty for 30 s, KEDA takes the last busy pod to zero too. One blind spot, two symptoms:
because in-flight work is invisible, the HPA both **under-provisions** (5 pods for 10 jobs) and
**kills busy pods**. Count the `Returned job` lines: each one is 20+ s of work thrown away and
started again from scratch on another pod. That loop is the incident from q5, live.

:::tip title="Fix it (pick one, then re-run step 6)"
* Raise the budget: edit the code to a 60 s job budget and `ShutdownTimeout` 80 s, set
  `terminationGracePeriodSeconds: 90`, rebuild, `kind load` again and re-apply. Busy pods now
  finish their job before exiting — but they are still chosen at random, so you pay for idle wait.
* Make in-flight work visible: use one shared `dq:jobs:processing` list plus a lease key per job
  (*Redis as Queue, Bus and Lock*) and add a second `redis` trigger on it with `listLength: "1"`. The HPA takes the maximum
  of both triggers, so it never asks for fewer pods than jobs in flight and KEDA never goes to zero
  mid-job. It does not choose *which* pod dies when one job finishes — pair it with the grace
  budget (or pod-deletion-cost).
* Move long jobs to a `ScaledJob`: each job owns its pod, nothing is scaled down under it.

`kubectl apply -f k8s.yaml` puts `listLength: "25"` and `JOB_MS=1000` back when you are done.
:::

:::warn title="Cleanup"
`kind delete cluster --name keda-lab` removes everything, including KEDA.
:::

- [ ] `kubectl get scaledobject worker` shows `READY True` and the worker starts at 0 replicas
- [ ] After pushing 500 jobs I watched the worker go 0 → 10 and back to 0
- [ ] `GET dq:jobs:done` returned 500
- [ ] I can point at the moment the HPA (1 ↔ N) and the moment KEDA (0 ↔ 1) acted
- [ ] In step 6 I saw a terminating pod return its job, and I can explain why `LLEN dq:jobs:ready` hid the in-flight work
:::

:::cards id=cl-06-cards1 xp=15 title="KEDA essentials"
Q: Why is CPU a poor scaling signal for queue workers?
A: Workers are often I/O-bound and CPU measures effort, not backlog. Users feel wait time ≈ backlog ÷ throughput, so scale on queue depth.
Q: Who scales 0 ↔ 1 and who scales 1 ↔ N?
A: 0 ↔ 1: the KEDA operator (activation, polled every pollingInterval). 1 ↔ N: the HPA KEDA creates (keda-hpa-<name>), fed by KEDA's external metrics adapter.
Q: What does cooldownPeriod control?
A: Only the wait from "last trigger active" to scaling to zero. Scale-down between replicas is the HPA's behavior (default 300 s stabilization).
Q: Activation vs target — which wins?
A: Activation. Active only when metric > activation value; target 10, activation 50, metric 40 → zero replicas. Ignored when minReplicaCount ≥ 1.
Q: Default KEDA replica formula (AverageValue)?
A: desired = ceil(metric ÷ target), clamped to [max(1, min), maxReplicaCount], shaped by HPA tolerance and behavior.
Q: ScaledObject vs ScaledJob?
A: ScaledObject scales a long-running Deployment (short jobs, high throughput). ScaledJob creates a K8s Job per item — never scaled down mid-job, ideal for long jobs.
Q: Why always set maxReplicaCount?
A: Default is 100. It protects downstream systems (DB connections, third-party APIs) — size it from the weakest dependency.
Q: Where must a TriggerAuthentication live?
A: In the ScaledObject's namespace, reading Secrets from that namespace. ClusterTriggerAuthentication reads Secrets from KEDA's namespace.
Q: The three nested shutdown clocks in a .NET worker?
A: in-flight job budget < HostOptions.ShutdownTimeout < terminationGracePeriodSeconds. Never pass stoppingToken into the job itself.
Q: Why might the redis list scaler kill busy workers?
A: LLEN counts only waiting items; items moved to a processing list are invisible, so "empty" looks idle and cooldown scales to zero mid-job.
Q: When does scale-to-zero actually save money?
A: When nodes go away too — via the cluster autoscaler / Karpenter. Zero pods on a node you still pay for saves nothing.
:::

## Recap

- Scale workers on **work waiting** (queue depth, lag, pending entries), not CPU — wait time ≈
  backlog ÷ throughput.
- KEDA = operator (scalers, activation 0 ↔ 1, owns an HPA) + metrics adapter
  (`external.metrics.k8s.io`) + admission webhooks; the HPA does 1 ↔ N with
  `ceil(metric ÷ target)`.
- `pollingInterval` = wake-up latency and query load; `cooldownPeriod` = only the step to zero;
  scale-down speed lives in `advanced.horizontalPodAutoscalerConfig.behavior`.
- Activation is "strictly greater than", wins over the target, and is ignored when
  `minReplicaCount ≥ 1`. Always set `maxReplicaCount` from your weakest downstream.
- `ScaledObject` for short, high-throughput jobs; `ScaledJob` for long jobs that must never be
  interrupted. (The boss fight uses a `ScaledObject` because its simulated jobs take seconds, and
  says so; real multi-minute transcodes belong in a `ScaledJob`.)
- The lab's per-pod processing list is a shortcut, not a lease: production workers use the shared
  processing list, lease key and reaper from **Redis as Queue, Bus and Lock**, which also makes
  in-flight work visible to a second trigger.
- Secrets go through `TriggerAuthentication` (same namespace) or `ClusterTriggerAuthentication`.
- More pods → Pending → cluster autoscaler adds nodes (minutes); savings only appear when nodes are
  removed.
- Every scale-down is a SIGTERM: stop taking jobs, finish or hand back the lease within
  job budget < ShutdownTimeout < grace period, and keep processing idempotent.
- On a cloud provider KEDA is usually a managed add-on (AKS KEDA add-on, Azure Container Apps scale
  rules, EKS with the Helm chart), and the triggers point at Service Bus or SQS through workload
  identity instead of a password Secret. **The Managed Equivalents: Azure & AWS** shows the
  mapping.
