---
id: ops-15
title: Scaling — HPA, KEDA, Cluster Autoscaler & Scheduling
level: advanced
minutes: 95
xp: 180
summary: Scale pods on CPU with the HPA (and its formula), workers 0→N on queue depth with KEDA, nodes with the cluster autoscaler — plus PDBs, affinity, topology spread, taints and tolerations for dedicated worker pools.
---

A real SaaS has uneven load: the API is busy during office hours, the worker has nothing to do at
night and then 40 000 PDF exports land at 9:00. You want to pay for capacity only when you need it
and never fall over when you do. Kubernetes scales on three levels — and they chain together:

```text
 load ↑ ──► HPA / KEDA add PODS ──► pods don't fit ──► Pending ──► Cluster Autoscaler adds NODES
 load ↓ ──► HPA / KEDA remove PODS ──► nodes underused ──► Cluster Autoscaler drains + removes NODES
                    ▲
          VPA right-sizes each pod's requests (which drive all of the above)
```

| Level | Tool | Scales on |
|---|---|---|
| Pods, horizontally | **HorizontalPodAutoscaler** (HPA) | CPU/memory, custom & external metrics |
| Pods, event-driven, incl. **to zero** | **KEDA** | Queue length, DB query, Kafka lag, Prometheus, cron… |
| Pods, vertically | **VerticalPodAutoscaler** (VPA) | Observed usage → requests |
| Nodes | **Cluster Autoscaler** / Karpenter | Pending pods / underused nodes |

## Where metrics come from

```text
kubelet (cAdvisor) ──► metrics-server ──► metrics.k8s.io           (CPU / memory: kubectl top, HPA)
Prometheus ─────────► Prometheus Adapter ─► custom.metrics.k8s.io   (e.g. requests/sec per pod)
RabbitMQ / Postgres / Kafka ──► KEDA ────► external.metrics.k8s.io (queue depth, lag…)
```

The HPA controller doesn't care which: it asks one of these APIs every 15 s. You installed
metrics-server in ops-12 (kind doesn't ship it; K3s/k3d do).

:::info title="Why requests are the currency of all scaling"
A container's **request** (`resources.requests.cpu/memory`, ops-12) is the amount the scheduler
*reserves* for it on a node. Every autoscaler in this lesson reasons in requests, not in real
usage: the HPA's "utilization" is usage ÷ request, the Cluster Autoscaler adds a node when pending
pods' *requests* don't fit, and the VPA's job is to choose the requests. Wrong requests make all
three make wrong decisions — that's why we start there.
:::

## The HorizontalPodAutoscaler

**Why:** a fixed `replicas: 3` is either too many at night (wasted money) or too few at 9:00
(timeouts). The **HorizontalPodAutoscaler** is a controller (the same reconcile loop as ops-09):
every 15 s it reads a metric for the pods of one Deployment, computes how many replicas would bring
the metric back to your target, and writes that number into the Deployment's `spec.replicas`. It
changes *how many* pods run — never how big each pod is.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 2
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70      # % of the pods' CPU **requests**
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0
      policies:
        - type: Percent
          value: 100                  # at most double…
          periodSeconds: 30           # …every 30 s
    scaleDown:
      stabilizationWindowSeconds: 300 # use the highest recommendation of the last 5 min (anti-flapping)
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60           # remove at most 2 pods per minute
```

Reading it top to bottom:

* `scaleTargetRef` — *what* to scale (a Deployment here; StatefulSets work too).
* `minReplicas` / `maxReplicas` — the hard floor (availability) and ceiling (cost, and protection
  for downstream systems such as Postgres connection limits).
* `metrics` — *what* to watch and the target. `Utilization` is a percentage of the request;
  `AverageValue` would be an absolute number per pod (e.g. `500m` CPU or `100` requests/s).
* `behavior` — *how fast* to move. The asymmetry is deliberate: **scale up fast** (a spike hurts
  users now; doubling every 30 s is fine) and **scale down slowly** (removing pods too eagerly
  and adding them back a minute later is called *flapping* and causes cold starts). If you omit
  `behavior`, the defaults are: scale up immediately (up to +100 % or +4 pods per 15 s), scale
  down only after a **300 s** stabilization window.

### The formula

```text
desiredReplicas = ceil( currentReplicas × currentMetricValue / targetMetricValue )
```

* 4 pods at 90 % CPU, target 70 % → `ceil(4 × 90/70) = ceil(5.14) = 6`. We **round up**
  because 5 pods would still be above target.
* Scale-in works the same way: 10 pods at 21 %, target 70 % → `ceil(10 × 21/70) = ceil(3.0) = 3`.
* If the ratio `current / target` is within the **tolerance** (default **10 %**, i.e. 0.9–1.1)
  → no change. 4 pods at 75 % vs 70 % is a ratio of 1.07 → stays at 4. This prevents constant
  ±1 jitter. (Newer clusters can override it per direction with `behavior.scaleUp.tolerance` /
  `behavior.scaleDown.tolerance` — the `HPAConfigurableTolerance` feature.)
* With **several metrics**, the HPA computes a proposal for each and takes the **maximum** — the
  safest choice: whichever resource is most stressed wins.
* The result is clamped to `[minReplicas, maxReplicas]`, then shaped by `behavior` (rate limits and
  the scale-down stabilization window: when scaling **down**, the HPA uses the *highest*
  recommendation of the window, so a single quiet minute doesn't remove pods).

:::warn title="Utilization is relative to requests"
`averageUtilization: 70` means 70 % of the **CPU request**, not of the node. A pod requesting
`100m` using `200m` is at 200 %. No request → the HPA can't compute utilization
(`FailedGetResourceMetric`, `<unknown>/70%`). Set requests on every container (sidecars too!).
:::

:::warn title="Don't fight the HPA"
Once an HPA manages a Deployment, **remove `spec.replicas` from your manifests** (or Kustomize
overlay / Helm values). Otherwise every `kubectl apply` or GitOps sync resets replicas to the
file's value and the HPA immediately scales back — a tug of war you'll see as flapping pods.
:::

:::quiz id=ops-15-q1 xp=15
An HPA targets 60 % CPU utilization. There are 5 pods averaging 84 %. Min 2, max 8. How many
replicas does it want?
- [ ] 6
- [x] 7
- [ ] 8
- [ ] 5 — within tolerance
> `5 × 84 / 60 = 7.0` → `ceil(7.0) = 7`. Ratio 1.4 is far outside the 10 % tolerance, and 7 is
> within [2, 8]. **8** is the tempting "round up to be safe / hit the max" answer, but `ceil` of an
> exact 7.0 is 7 and the HPA doesn't jump to `maxReplicas` unless the formula says so. "Within
> tolerance" would need a ratio between 0.9 and 1.1.
:::

:::quiz id=ops-15-q2 xp=10
`kubectl get hpa` shows `TARGETS: <unknown>/70%` for your API. metrics-server is healthy and
`kubectl top pods` works. Most likely cause?
- [ ] The HPA needs `maxReplicas` above 100
- [x] At least one container in the pods has no CPU **request**, so utilization can't be computed
- [ ] HPAs only work with StatefulSets
- [ ] The Deployment has too many replicas
> Utilization = usage ÷ request. A sidecar without requests is the classic culprit — the HPA
> needs requests for *all* containers in the pod for resource metrics. Since `kubectl top` works,
> the metrics pipeline itself is fine — so it's not "metrics-server is down". `maxReplicas` and
> the current replica count don't affect whether the metric can be *computed*, and HPAs work with
> Deployments, StatefulSets and anything else that has a `scale` subresource.
:::

:::quiz id=ops-15-q8 xp=10
An HPA with **no** `behavior` section runs the API at 8 replicas. At 10:00 traffic drops sharply
and stays low; the formula now says 3. Roughly when do pods start being removed?
- [ ] Immediately — the HPA acts on every 15 s sync
- [x] Around 10:05 — the default 300 s scale-down stabilization window uses the highest recommendation of the last 5 minutes
- [ ] Never — HPAs only scale up; you scale down by hand
- [ ] After `cooldownPeriod` (default 300 s) — the HPA's cooldown setting
> Scale-*up* has no stabilization by default, but scale-*down* waits until every recommendation in
> the last 300 s is ≤ the new value — anti-flapping. "Immediately" is how scale-up behaves, not
> scale-down. `cooldownPeriod` is a **KEDA** ScaledObject field (and only governs the step to
> zero), not an HPA setting.
:::

## VPA: right-sizing requests

**Why:** developers guess requests once ("256Mi sounds right") and never revisit them. Too high
and you pay for idle reserved capacity; too low and pods get OOM-killed, CPU-throttled, or packed
onto overloaded nodes. The **VerticalPodAutoscaler** (an add-on, not built in) watches real usage
over days and recommends — or applies — better requests. It changes *how big* each pod is, not how
many.

| Mode | What it does | When |
|---|---|---|
| `Off` | Only writes a recommendation into the VPA's status | The safe, popular choice — you copy values into Git |
| `Initial` | Sets requests when a pod is created; never touches running pods | Workloads that restart often anyway |
| `Recreate` | Evicts running pods whose requests are far off, so they come back resized | Tolerant, multi-replica workloads (the legacy `Auto` mode behaves like this) |
| `InPlaceOrRecreate` | Resizes running pods in place (in-place pod resize) when possible, evicts otherwise | Newer VPA versions on clusters with in-place resize |

```bash
kubectl describe vpa api     # Recommendation: Target cpu 180m memory 310Mi, Upper bound …
```

Don't let the VPA and an HPA both act on **the same** CPU/memory metric — they chase each other.
Common pattern: VPA in `Off` mode to choose requests, HPA (on CPU or a custom metric) to scale out.

## KEDA: event-driven scaling, down to zero

The HPA can't scale to zero (`minReplicas` ≥ 1, unless the alpha `HPAScaleToZero` feature gate is
on — managed clusters don't enable it) and doesn't know your queue. A background worker should
scale on **work waiting**, not CPU: a worker that spends most of its time waiting on Postgres or an
HTTP API uses little CPU, so when 2 000 jobs are queued CPU may still look idle while the queue —
and your customers' wait — grows.

**KEDA** (Kubernetes Event-Driven Autoscaling, CNCF) adds this:

```text
 ScaledObject (your CR) ──► KEDA operator ──┬─► creates/owns an HPA (1 ↔ N) fed by
                                            │   KEDA's external metrics server
                                            └─► handles 0 ↔ 1 itself ("activation")
 scalers: RabbitMQ, Azure Service Bus, SQS, Kafka, Redis, PostgreSQL query, Prometheus, cron, …
```

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
spec:
  scaleTargetRef:
    name: worker                   # a Deployment
  minReplicaCount: 0               # scale to zero when idle
  maxReplicaCount: 30
  pollingInterval: 15              # check the queue every 15 s
  cooldownPeriod: 120              # wait 120 s of "no work" before going to 0
  triggers:
    - type: rabbitmq
      metadata:
        queueName: pdf-exports
        mode: QueueLength
        value: "20"                # target: 20 messages per replica
      authenticationRef:
        name: rabbitmq-auth
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: rabbitmq-auth
spec:
  secretTargetRef:
    - parameter: host              # amqp://user:pass@rabbitmq:5672/
      name: rabbitmq-conn
      key: uri
```

Two objects, two jobs: the **ScaledObject** says *what* to scale and *on which signal*; the
**TriggerAuthentication** says *how KEDA logs in* to that signal. Keeping credentials in a separate
object (pointing at a normal Secret) means the ScaledObject can live in Git without passwords, and
several ScaledObjects can share one login.

How the numbers work (metric type `AverageValue`, the default):

```text
desiredReplicas = ceil( queueLength / value )         → 130 messages / 20 = 6.5 → 7 workers
queueLength ≤ activationValue (default 0) for cooldownPeriod → 0 workers
```

Note what each knob controls: `pollingInterval` is how often KEDA asks the queue;
`cooldownPeriod` applies **only to the last step, 1 → 0**; scaling between 1 and N follows the
HPA's rules (its default 300 s scale-down window — tune it under
`spec.advanced.horizontalPodAutoscalerConfig.behavior`).

:::warn title="Common KEDA mistakes"
* Keeping `spec.replicas: 3` in the worker's manifest in Git — same tug of war as with a plain HPA.
* Putting the connection string with the password straight into `metadata` instead of a
  TriggerAuthentication.
* Using a short Service name (`postgres`, `rabbitmq`) as the host: the scaler runs inside the
  **KEDA operator's** pod in namespace `keda`, so use the FQDN
  `<svc>.<namespace>.svc.cluster.local`.
:::

**Postgres as a queue** — many .NET SaaS apps keep jobs in a table (`SELECT … FOR UPDATE SKIP
LOCKED`). KEDA's `postgresql` scaler scales on any query:

```yaml
triggers:
  - type: postgresql
    metadata:
      query: "SELECT COUNT(*) FROM jobs WHERE status = 'queued'"
      targetQueryValue: "10"            # 10 queued jobs per worker
      activationTargetQueryValue: "0"   # wake from zero as soon as there's 1 job
    authenticationRef:
      name: jobs-db
```

:::pro title="Workers that scale well"
* **Idempotent, at-least-once** jobs: a scaled-down pod may die mid-job; the message must be
  re-delivered and processing it twice must be safe.
* Handle **SIGTERM**: stop taking new jobs, finish or release the current one within
  `terminationGracePeriodSeconds` (raise it for long jobs).
* Very long jobs (minutes–hours): consider KEDA **ScaledJob**, which starts a Kubernetes Job per
  batch of messages instead of scaling a Deployment that might be scaled down under a running job.
* Scale-to-zero means **cold starts**: the first job waits for scheduling + image pull + .NET
  startup. Keep `minReplicaCount: 1` where latency matters.
:::

:::info title="Where KEDA lives in this course"
This section is KEDA's **home**: what it is, how the ScaledObject → HPA hand-off works, the
activation step, and wiring the DevQuest worker to a queue. Everything here is at the level you
need to own a worker's scaling on a team. The cloud-native track's **cl-06** builds on it without
re-teaching the basics: every ScaledObject knob in detail (including the ones whose names
mislead), ScaledJob vs ScaledObject, writing the scaling rule yourself, graceful shutdown of
half-finished jobs, and what scale-to-zero really saves. Do cl-06 when you run a worker fleet in
production; the lab below is enough to get started.
:::

:::quiz id=ops-15-q3 xp=15
A KEDA ScaledObject has `minReplicaCount: 0`. The worker Deployment is at 0 replicas and a message
arrives. Who scales it to 1?
- [ ] The HPA KEDA created — it always handles every step
- [x] The KEDA operator itself (activation); the HPA then handles 1 → N
- [ ] The cluster autoscaler
- [ ] Nobody — HPAs can't scale from zero, so the message waits forever
> HPAs have `minReplicas ≥ 1`. KEDA polls the scaler, and when the metric is above the activation
> threshold it scales the target from 0 to 1 directly; above that, its HPA takes over. "The HPA
> handles every step" is the tempting answer because KEDA does create an HPA — but an HPA whose
> target sits at 0 replicas is disabled (`ScalingActive: False`). The cluster autoscaler adds
> *nodes*, never pods, and "waits forever" is exactly the gap KEDA's activation fills.
:::

## Cluster Autoscaler: adding and removing nodes

**Why:** the HPA and KEDA only create pods. If the nodes are full, the new pods have nowhere to run
and wait in `Pending`. Something has to buy more machines — and give them back when the rush is
over, because idle nodes are where cloud bills go to die.

When pods are `Pending` because no node has enough **requested** CPU/memory, the **Cluster
Autoscaler** (CA):

1. notices unschedulable pods,
2. simulates whether a new node from one of its **node groups** would fit them,
3. asks the cloud API for a node (AWS ASG, Azure VMSS, GCP MIG, **Hetzner** — popular for K3s),
4. the scheduler places the pods once the node joins.

Scale **down**: if the sum of a node's pods' **requests** stays below ~50 % of the node for ~10
minutes (defaults of `--scale-down-utilization-threshold` and `--scale-down-unneeded-time`) and
all its pods can be moved elsewhere, CA cordons and drains it, then deletes the VM. Pods block that
if they use local storage (depending on CA flags), have no controller (a bare Pod would just be
lost), are protected by a restrictive PDB, or carry the annotation
`cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`.

Notice that the CA looks at **requests, not real usage**: a node full of pods that request 2 CPUs
each but use 0.1 never looks "underused" to it. Over-generous requests silently cost you nodes.

| | Cluster Autoscaler | Karpenter |
|---|---|---|
| Model | Scales pre-defined node groups | Chooses instance types per pending pod |
| Where | All major clouds + Hetzner, etc. | AWS (and Azure) |

On a managed cluster, "node group" means the provider's **node pool** (EKS managed node groups,
AKS node pools, GKE node pools), and the provider often offers its own autoscaling mode on top
(EKS Auto Mode, AKS node auto-provisioning, GKE Autopilot). How those map to the concepts here,
plus spot nodes and the cost model, is covered in the Managed Kubernetes lesson (ops-19).

:::info title="Speed matters"
A new node takes ~1–3 minutes. If spikes are faster than that, keep headroom with
**overprovisioning**: a low-PriorityClass (ops-12) "placeholder" Deployment of pause pods that real pods
preempt instantly, triggering CA to add a node in the background.
:::

:::quiz id=ops-15-q4 xp=15
A KEDA-scaled worker requests `cpu: 6`, `memory: 4Gi`. The node group's instance type has 4 vCPU.
Under load the new worker pods stay `Pending` forever, even with the cluster autoscaler. Why?
- [ ] The CA only reacts to CPU utilization, not Pending pods
- [x] No node in any node group could ever fit a 6-CPU request, so the CA's simulation never adds a node
- [ ] KEDA pods can't trigger the CA
- [ ] Pending pods need a PodDisruptionBudget
> CA adds nodes only if a new node *would* fit the pod. Events show
> `pod didn't trigger scale-up: … Insufficient cpu`. Lower the request or add a bigger node group.
> The tempting "CA only reacts to CPU utilization" is backwards — Pending pods are precisely its
> trigger, and *who* created the pod (KEDA, an HPA, you) doesn't matter. PDBs only govern
> evictions, not scheduling.
:::

:::job title="Scaling on day one at a new job"
You'll rarely write an HPA from scratch — you'll inherit one. The first questions worth asking:
*Are requests realistic?* (compare `kubectl top pods` with the requests), *Is the HPA ever at
`maxReplicas`?* (then you're capacity-bound, and an alert should say so), *Is `spec.replicas`
still in Git?*, and *What does the worker scale on?* Expect a dashboard panel with "replicas vs
desired vs max" per workload, and a runbook entry for "HPA maxed out".
:::

## PodDisruptionBudgets

Not all pod deaths are crashes. **Voluntary disruptions** — `kubectl drain`, node upgrades, CA
scale-down — go through the **Eviction API**, which honours **PodDisruptionBudgets**:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api
spec:
  minAvailable: 2          # or maxUnavailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: api
```

A drain evicts API pods one by one only while ≥ 2 stay available: if evicting one more would drop
the count of **Ready** API pods below 2, the Eviction API answers *429 Too Many Requests* and
`kubectl drain` keeps retrying until a replacement pod elsewhere becomes Ready. PDBs don't protect
against node crashes or OOM kills (those are *involuntary* — nobody asks the Eviction API) — that's
what replicas and anti-affinity are for. And `kubectl delete pod` bypasses PDBs entirely.

Prefer `maxUnavailable: 1` over `minAvailable: N` for Deployments managed by an HPA: it keeps
meaning "one at a time" whether the HPA runs 3 pods or 30.

:::warn title="The PDB that blocks every upgrade"
`minAvailable: 3` on a Deployment with **3** replicas (or `maxUnavailable: 0`) means *no* pod may
ever be evicted: node drains hang forever, K3s/managed upgrades stall, and the CA can't remove
nodes. Always allow at least one disruption.
:::

## Placing pods: nodeSelector, affinity, spread, taints

**Why:** by default the scheduler puts a pod on *any* node with enough free requests. That's not
always what you want: all three API replicas on one node means one node failure takes the API down;
a CPU-hungry PDF worker next to the API steals its CPU; GPU or spot nodes should only run the pods
meant for them. These tools let you say *where* pods may, must, or should not go. Two directions
to keep apart: **pods choosing nodes** (nodeSelector, affinity, spread) and **nodes repelling
pods** (taints).

| Tool | Says | Example |
|---|---|---|
| `nodeSelector` | "Only on nodes with these labels" (hard) | `workload: worker` |
| Node **affinity** | Same, but expressive; `required…` (hard) or `preferred…` (soft) | prefer `topology.kubernetes.io/zone in (fsn1, nbg1)` |
| Pod **anti-affinity** | "Not on a node that already runs pods like me" | One Postgres instance per node |
| **topologySpreadConstraints** | "Spread evenly across zones/nodes, max skew N" | API across 3 zones |
| **Taints** (on nodes) + **tolerations** (on pods) | Node repels pods unless they tolerate it | GPU / worker-only / spot nodes |

```text
                      ┌─ node pool "general" ───────────┐   ┌─ node pool "workers" ──────────────────┐
                      │ labels: workload=general        │   │ labels: workload=worker                 │
                      │                                 │   │ taint:  workload=worker:NoSchedule      │
                      │  api  api  web  web  traefik    │   │  worker worker worker worker (KEDA 0→N) │
                      └─────────────────────────────────┘   └─────────────────────────────────────────┘
 api/web: no toleration → can't land on worker nodes.
 worker: toleration (allowed there) + nodeSelector (required there) → only on worker nodes.
```

```yaml
# worker Deployment — pod template spec
spec:
  nodeSelector:
    workload: worker
  tolerations:
    - key: workload
      operator: Equal
      value: worker
      effect: NoSchedule
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app.kubernetes.io/name: worker
```

```yaml
# API — never two replicas on the same node if avoidable
spec:
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            topologyKey: kubernetes.io/hostname
            labelSelector:
              matchLabels:
                app.kubernetes.io/name: api
```

**Topology spread** in plain words: `topologyKey` names a node label that groups nodes into
"domains" (`kubernetes.io/hostname` = each node is its own domain; `topology.kubernetes.io/zone` =
each zone). `maxSkew: 1` says "the busiest domain may have at most 1 more matching pod than the
emptiest". With 3 nodes and 4 workers that means 2/1/1, not 4/0/0 — guaranteed with
`DoNotSchedule`, best effort with `ScheduleAnyway`. `whenUnsatisfiable` decides
what happens if that's impossible: `DoNotSchedule` (hard — the pod stays Pending) or
`ScheduleAnyway` (soft — place it, but prefer balance). Soft rules are the usual choice for
autoscaled workloads, because a hard rule plus a full zone can block scale-out exactly when you
need it.

Taint effects: `NoSchedule` (don't place new pods), `PreferNoSchedule` (try not to), `NoExecute`
(also **evict** running pods without a toleration — used by the node controller for
`node.kubernetes.io/unreachable`).

:::warn title="Required vs preferred"
`requiredDuringScheduling…` anti-affinity on `kubernetes.io/hostname` with 3 nodes caps you at
**3 replicas** — the 4th stays Pending forever, even under an HPA asking for 10. Use `preferred…`
(as above) unless "never two on a node" is truly a hard requirement (e.g. Postgres instances).
:::

:::quiz id=ops-15-q5 xp=15
Worker nodes carry the taint `workload=worker:NoSchedule`. The worker Deployment has the matching
**toleration** but **no** nodeSelector/affinity. Where can worker pods land?
- [ ] Only on worker nodes
- [x] On worker nodes **and** on any untainted general node — a toleration permits, it doesn't attract
- [ ] Nowhere — they need a nodeSelector to be scheduled at all
- [ ] Only on the control plane
> Taints keep *other* pods out; tolerations let *these* pods in. To pin workers to the pool you
> also need `nodeSelector` (or required node affinity). Dedicated pools use both. "Only on worker
> nodes" is the tempting answer because the toleration *mentions* the worker taint — but a
> toleration is permission, not attraction; the scheduler is free to pick any untainted node too.
:::

:::quiz id=ops-15-q6 xp=10
Why should you avoid combining a VPA in `Recreate` mode and an HPA that both use CPU on the same
Deployment?
- [ ] VPAs and HPAs can't coexist in a cluster
- [x] They react to the same signal in conflicting ways: VPA raises requests (lowering utilization) while HPA changes replica count — they oscillate
- [ ] HPAs ignore pods created by a VPA
- [ ] It's fine; they coordinate automatically
> Example: CPU is high → HPA adds pods *and* VPA raises requests; with bigger requests the
> utilization percentage falls → HPA removes pods → per-pod usage rises → repeat. Use VPA in `Off`
> mode for recommendations, or scale the HPA on a different metric (RPS, queue depth) than the VPA
> manages. They *can* coexist in a cluster (and even on one Deployment, on different metrics) —
> the problem is two controllers steering with the same signal, and they do **not** coordinate.
:::

:::lab id=ops-15-lab1 xp=100
title: HPA under load
You need metrics-server from ops-12 (`kubectl top nodes` must work).

```bash
kubectl create namespace ops15
kubectl config set-context --current --namespace=ops15
```

Save as `hpa-demo.yaml` (the classic CPU-burning PHP demo app from the Kubernetes docs):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: php-apache
spec:
  selector:
    matchLabels: { app: php-apache }
  template:
    metadata:
      labels: { app: php-apache }
    spec:
      containers:
        - name: php-apache
          image: registry.k8s.io/hpa-example
          ports:
            - containerPort: 80
          resources:
            requests: { cpu: 200m }
            limits: { cpu: 500m }
---
apiVersion: v1
kind: Service
metadata:
  name: php-apache
spec:
  selector: { app: php-apache }
  ports:
    - port: 80
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: php-apache
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: php-apache
  minReplicas: 1
  maxReplicas: 8
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 50
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 60
```

:::tip title="Apple Silicon / ARM machines"
`registry.k8s.io/hpa-example` is amd64-only; on ARM its pod crash-loops with `exec format error`.
Use a stand-in that burns CPU by itself: delete the first document (the Deployment) from
`hpa-demo.yaml`, then run

```bash
kubectl create deployment php-apache --image=busybox:1.37 -- sh -c 'while true; do :; done'
kubectl set resources deploy php-apache --requests=cpu=100m --limits=cpu=200m
```

and continue with `kubectl apply -f hpa-demo.yaml`. Each pod sits at ~200 % of its request, so you
can skip the load generator — the HPA climbs to `maxReplicas` on its own. To watch scale-in, raise
the target instead of stopping load:
`kubectl patch hpa php-apache --type=merge -p '{"spec":{"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":400}}}]}}'`
(`ceil(8 × 200/400) = 4`, and so on down).
:::

```bash
kubectl apply -f hpa-demo.yaml
kubectl get hpa php-apache -w            # TARGETS cpu: 0%/50% after ~30 s (<unknown> before the first sample)
```

In a second terminal generate load:

```bash
kubectl run load -it --rm --image=busybox:1.37 --restart=Never -- \
  sh -c "while sleep 0.01; do wget -q -O- http://php-apache >/dev/null; done"
```

Watch the HPA terminal: utilization climbs to 200 %+ and replicas step up (typically 1 → 4 → 5–8,
depending on your machine). For one sample, check the formula by hand:
`ceil(currentReplicas × current% / 50)` — e.g. 1 pod at 250 % → `ceil(5.0) = 5`. Then stop the load
(Ctrl+C) and watch replicas fall back to 1 about 1–2 minutes later (metrics lag + the 60 s
stabilization window).

```bash
kubectl describe hpa php-apache
# Events: … New size: 4; reason: cpu resource utilization (percentage of request) above target
# Events: … New size: 1; reason: All metrics below target
```

- [ ] The HPA scaled out under load and I verified one decision with the formula
- [ ] It scaled back in after the stabilization window
- [ ] I can explain what `averageUtilization: 50` is a percentage of
:::

:::lab id=ops-15-lab2 xp=150
title: KEDA — scale a worker 0 → N on a Postgres job queue
**1. Install KEDA**

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm upgrade --install keda kedacore/keda --namespace keda --create-namespace
kubectl -n keda rollout status deploy/keda-operator
kubectl get crd | grep keda.sh           # scaledobjects, scaledjobs, triggerauthentications…
```

**2. A tiny Postgres with a jobs table** (lab-only Deployment — in real life the CNPG cluster from
ops-13). Save as `queue.yaml`:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: jobs-db
  namespace: ops15
type: Opaque
stringData:
  password: jobs
  connection: "host=postgres.ops15.svc.cluster.local port=5432 user=postgres password=jobs dbname=postgres sslmode=disable"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: ops15
spec:
  selector:
    matchLabels: { app: postgres }
  template:
    metadata:
      labels: { app: postgres }
    spec:
      containers:
        - name: postgres
          image: postgres:18-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: jobs-db, key: password } }
          ports:
            - containerPort: 5432
          readinessProbe:
            exec:                          # -h 127.0.0.1: check TCP, not the init-time Unix socket
              command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"]
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: ops15
spec:
  selector: { app: postgres }
  ports:
    - port: 5432
```

```bash
kubectl apply -f queue.yaml && kubectl rollout status deploy/postgres
kubectl exec deploy/postgres -- psql -U postgres -c \
  "CREATE TABLE jobs(id serial primary key, status text not null default 'queued');"
```

**3. The worker and its ScaledObject.** The worker is a placeholder that just sleeps — we are
testing the *scaling*, not the processing. (`replicas: 0` only sets the *starting* point on first
apply; in a GitOps repo you'd omit it, like with any autoscaled workload.) The `connection` string
in the Secret uses the **FQDN** `postgres.ops15.svc.cluster.local`, because KEDA's operator runs
the query from namespace `keda`. Save as `worker.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: ops15
spec:
  replicas: 0
  selector:
    matchLabels: { app.kubernetes.io/name: worker }
  template:
    metadata:
      labels: { app.kubernetes.io/name: worker }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: worker
          image: busybox:1.37
          command: ["sh", "-c", "echo worker $(hostname) ready; exec sleep 3600000"]
          resources:
            requests: { cpu: 10m, memory: 16Mi }
            limits: { memory: 32Mi }
---
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: jobs-db
  namespace: ops15
spec:
  secretTargetRef:
    - parameter: connection
      name: jobs-db
      key: connection
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker
  namespace: ops15
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 0
  maxReplicaCount: 10
  pollingInterval: 5
  cooldownPeriod: 30
  triggers:
    - type: postgresql
      metadata:
        query: "SELECT COUNT(*) FROM jobs WHERE status = 'queued'"
        targetQueryValue: "10"
        activationTargetQueryValue: "0"
      authenticationRef:
        name: jobs-db
```

```bash
kubectl apply -f worker.yaml
kubectl get scaledobject worker          # READY True, ACTIVE False
kubectl get hpa                          # keda-hpa-worker — created and owned by KEDA
kubectl get deploy worker -w             # 0/0
```

**4. Enqueue work** (second terminal):

```bash
kubectl exec deploy/postgres -- psql -U postgres -c "INSERT INTO jobs(status) SELECT 'queued' FROM generate_series(1,45);"
# watch: 0 → 1 (KEDA activation) → 5 (HPA: ceil(45/10))
kubectl exec deploy/postgres -- psql -U postgres -c "INSERT INTO jobs(status) SELECT 'queued' FROM generate_series(1,200);"
# → 10 (maxReplicaCount caps ceil(245/10)=25)
kubectl exec deploy/postgres -- psql -U postgres -c "UPDATE jobs SET status = 'done';"
# the query now returns 0 → the scaler is inactive; after cooldownPeriod (30 s) KEDA sets the
# Deployment straight to 0 — it doesn't wait for the HPA's slower step-by-step scale-down
kubectl get scaledobject worker          # ACTIVE False again
```

If the ScaledObject shows `READY False`, run `kubectl describe scaledobject worker` and
`kubectl -n keda logs deploy/keda-operator | tail` — a wrong host, password or SQL error shows up
there, not in your worker's logs.

- [ ] The worker went from 0 to 1 to 5 replicas as jobs were inserted
- [ ] `maxReplicaCount` capped the worker at 10
- [ ] After marking jobs done, the worker returned to 0
- [ ] I can explain which component did 0→1 and which did 1→N
:::

:::lab id=ops-15-lab3 xp=100
title: Worker node pool, taints, and a PDB-guarded drain
**1. Make `devquest-worker2` a dedicated worker node:**

```bash
kubectl label node devquest-worker2 workload=worker
kubectl taint node devquest-worker2 workload=worker:NoSchedule
```

**2. Deploy a pinned worker and an unpinned web app** (save as `placement.yaml`):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pool-worker
  namespace: ops15
spec:
  replicas: 3
  selector:
    matchLabels: { app.kubernetes.io/name: pool-worker }
  template:
    metadata:
      labels: { app.kubernetes.io/name: pool-worker }
    spec:
      nodeSelector:
        workload: worker
      tolerations:
        - key: workload
          operator: Equal
          value: worker
          effect: NoSchedule
      containers:
        - name: worker
          image: busybox:1.37
          command: ["sleep", "3600000"]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pdb-demo
  namespace: ops15
spec:
  replicas: 3
  selector:
    matchLabels: { app.kubernetes.io/name: pdb-demo }
  template:
    metadata:
      labels: { app.kubernetes.io/name: pdb-demo }
    spec:
      containers:
        - name: web
          image: nginx:1.29-alpine
          readinessProbe:
            httpGet: { path: /, port: 80 }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: pdb-demo
  namespace: ops15
spec:
  minAvailable: 3
  selector:
    matchLabels: { app.kubernetes.io/name: pdb-demo }
```

```bash
kubectl apply -f placement.yaml
kubectl get pods -o wide -l app.kubernetes.io/name=pool-worker   # all on devquest-worker2
kubectl get pods -o wide -l app.kubernetes.io/name=pdb-demo      # all on devquest-worker (taint keeps them off worker2)
```

**3. A PDB that blocks drains.** Only evict the demo pods (the selector keeps other lessons'
workloads untouched):

```bash
kubectl drain devquest-worker --ignore-daemonsets --delete-emptydir-data \
  --pod-selector=app.kubernetes.io/name=pdb-demo --timeout=30s
# error when evicting pods … "Cannot evict pod as it would violate the pod's disruption budget."
```

Two problems at once: `minAvailable: 3` of 3 forbids any eviction, **and** there's nowhere for the
pods to go (worker2 is tainted, the control plane too). Fix both:

```bash
kubectl patch pdb pdb-demo -p '{"spec":{"minAvailable":2}}'
kubectl taint node devquest-worker2 workload=worker:NoSchedule-     # remove the taint (note the "-")
kubectl drain devquest-worker --ignore-daemonsets --delete-emptydir-data \
  --pod-selector=app.kubernetes.io/name=pdb-demo --timeout=120s
kubectl get pods -o wide -l app.kubernetes.io/name=pdb-demo      # moved to worker2, one at a time
kubectl uncordon devquest-worker
```

Clean up: `kubectl delete namespace ops15` (keep KEDA and the `workload=worker` label for the boss
fight).

- [ ] Worker pods landed only on the tainted, labelled node
- [ ] The drain was blocked by the PDB and I understood both reasons
- [ ] After relaxing the PDB and removing the taint, the drain succeeded and I uncordoned the node
:::

## Code it: the autoscaler formulas

:::challenge id=ops-15-c1 lang=ts xp=50
title: HPA desired replicas
Write `hpaDesired(currentReplicas, metrics, minReplicas, maxReplicas, tolerance = 0.1)`.

* `metrics` is a list of `{ current, target }` (e.g. average CPU % vs target %).
* For each metric: `ratio = current / target`. If `|ratio - 1| <= tolerance` the proposal is
  `currentReplicas`; otherwise `ceil(currentReplicas * ratio)`.
* Take the **maximum** proposal over all metrics, then clamp to `[minReplicas, maxReplicas]`.

The default `tolerance` must be `0.1` (one test relies on it), and a custom one must be honoured.

hint: Map each metric to a proposal, then `Math.max(...proposals)`.
hint: Clamp with `Math.min(maxReplicas, Math.max(minReplicas, desired))`.
hint: Compute `Math.ceil(currentReplicas * current / target)` (multiply first) — it avoids tiny floating-point errors right on integer boundaries.

```ts starter
export function hpaDesired(currentReplicas: number, metrics: { current: number; target: number }[], minReplicas: number, maxReplicas: number, tolerance = 0.1): number {
  const m = metrics[0]
  return Math.ceil((currentReplicas * m.current) / m.target)
}
```

```ts solution
export function hpaDesired(currentReplicas: number, metrics: { current: number; target: number }[], minReplicas: number, maxReplicas: number, tolerance = 0.1): number {
  const proposals = metrics.map(({ current, target }) => {
    const ratio = current / target
    if (Math.abs(ratio - 1) <= tolerance) return currentReplicas
    return Math.ceil((currentReplicas * current) / target)
  })
  const desired = Math.max(...proposals)
  return Math.min(maxReplicas, Math.max(minReplicas, desired))
}
```

```ts tests
test('scales out on high CPU', () => {
  expect(hpaDesired(3, [{ current: 90, target: 60 }], 1, 10)).toBe(5)
})
test('within tolerance does nothing', () => {
  expect(hpaDesired(4, [{ current: 65, target: 60 }], 1, 10)).toBe(4)
})
test('multiple metrics take the max, then clamp to max', () => {
  expect(hpaDesired(4, [{ current: 30, target: 60 }, { current: 300, target: 100 }], 2, 10)).toBe(10)
})
test('scales in', () => {
  expect(hpaDesired(10, [{ current: 20, target: 60 }], 2, 20)).toBe(4)
})
test('never below minReplicas', () => {
  expect(hpaDesired(2, [{ current: 10, target: 60 }], 2, 20)).toBe(2)
})
test('custom tolerance', () => {
  expect(hpaDesired(10, [{ current: 75, target: 60 }], 1, 50, 0.3)).toBe(10)
})
```
:::

:::challenge id=ops-15-c2 lang=ts xp=40
title: KEDA replicas with scale-to-zero
Write `kedaReplicas(metric, target, activation, minReplicas, maxReplicas)`:

* If `metric <= activation`, the scaler is **inactive** → return `minReplicas` (which may be 0).
* Otherwise it's active → `ceil(metric / target)`, but at least `max(minReplicas, 1)` and at most
  `maxReplicas`.

hint: Active means strictly greater than the activation threshold.
hint: When active, clamp with `Math.min(maxReplicas, Math.max(minReplicas, 1, desired))`.

```ts starter
export function kedaReplicas(metric: number, target: number, activation: number, minReplicas: number, maxReplicas: number): number {
  return Math.ceil(metric / target)
}
```

```ts solution
export function kedaReplicas(metric: number, target: number, activation: number, minReplicas: number, maxReplicas: number): number {
  if (metric <= activation) return minReplicas
  const desired = Math.ceil(metric / target)
  return Math.min(maxReplicas, Math.max(minReplicas, 1, desired))
}
```

```ts tests
test('empty queue scales to zero', () => {
  expect(kedaReplicas(0, 10, 0, 0, 20)).toBe(0)
})
test('one job wakes one worker', () => {
  expect(kedaReplicas(1, 10, 0, 0, 20)).toBe(1)
})
test('95 jobs at 10 per worker', () => {
  expect(kedaReplicas(95, 10, 0, 0, 20)).toBe(10)
})
test('capped at maxReplicas', () => {
  expect(kedaReplicas(500, 10, 0, 0, 20)).toBe(20)
})
test('below the activation threshold stays at min', () => {
  expect(kedaReplicas(3, 10, 5, 0, 20)).toBe(0)
  expect(kedaReplicas(3, 10, 5, 2, 20)).toBe(2)
})
test('active but tiny load respects minReplicas', () => {
  expect(kedaReplicas(6, 10, 5, 3, 20)).toBe(3)
})
```
:::

:::quiz id=ops-15-q7 xp=15
During a node upgrade, `kubectl drain` hangs on the API pods with *"Cannot evict pod as it would
violate the pod's disruption budget"*. The API has 3 replicas and an HPA with `minReplicas: 3`.
The PDB says `minAvailable: 3`. What's the right fix?
- [ ] Use `kubectl delete pod --force` on each API pod
- [x] Change the PDB to allow one disruption (`maxUnavailable: 1` or `minAvailable: 2`) — evictions then proceed one at a time while replacements start elsewhere
- [ ] Delete the HPA
- [ ] Add a toleration for `node.kubernetes.io/unschedulable`
> A PDB that allows zero disruptions blocks every voluntary operation. `maxUnavailable: 1` scales
> naturally with the HPA. Force-deleting "works" — which makes it tempting at 2 a.m. — but it
> bypasses the Eviction API and the safety you built, and you'll be back next upgrade. Deleting the
> HPA doesn't change the PDB math, and the drain isn't blocked by scheduling (the
> `unschedulable` taint is on the node being drained — tolerating it would just let pods land back
> on it).
:::

:::cards id=ops-15-cards1 xp=15 title="Scaling & scheduling"
Q: HPA formula?
A: desired = ceil(currentReplicas × currentMetric / targetMetric), skipped within 10 % tolerance, max over metrics, clamped to [min, max].
Q: CPU utilization in an HPA is relative to…?
A: The pods' CPU requests.
Q: Why remove spec.replicas when using an HPA?
A: Otherwise every apply/GitOps sync resets the replica count and fights the HPA.
Q: Default HPA scale-down stabilization window?
A: 300 seconds — it uses the highest recommendation of the last 5 minutes.
Q: What does KEDA add beyond the HPA?
A: Event-source scalers (queues, DB queries, Kafka lag…), and scaling to/from zero (activation).
Q: KEDA desired replicas for a queue?
A: ceil(queueLength / target value), between max(min,1) and max when active; minReplicaCount (can be 0) when inactive.
Q: When does the cluster autoscaler add a node?
A: When pods are Pending as unschedulable and a node from a node group would fit them.
Q: What does a PDB protect against?
A: Voluntary disruptions via the Eviction API (drains, upgrades, CA scale-down) — not crashes.
Q: Taint vs toleration vs nodeSelector?
A: Taint repels pods from a node; toleration allows a pod onto it; nodeSelector/affinity requires a pod to go there.
Q: VPA modes?
A: Off (recommend), Initial, Recreate, InPlaceOrRecreate.
Q: What does KEDA's cooldownPeriod control?
A: Only the final 1 → 0 step: how long the scaler must be inactive before KEDA scales to zero. 1 ↔ N follows the HPA's behavior.
Q: topologySpreadConstraints maxSkew: 1?
A: The busiest topology domain (node/zone) may have at most one more matching pod than the emptiest.
:::

## Recap

- Scale **pods** with the HPA (`autoscaling/v2`): `ceil(current × metric / target)`, tolerance,
  max over metrics, `behavior` for rate limits. Requests must be set; drop `spec.replicas`.
- **KEDA** scales on real work — queue length, Postgres queries, Kafka lag — and down to zero. It
  owns an HPA for 1↔N and does 0↔1 itself. This lesson is its home; cl-06 is the production deep dive.
- **Requests** are the currency of every autoscaler: HPA utilization, CA scale-up/down and VPA
  all reason in requests, not real usage.
- **VPA** right-sizes requests (use `Off` for recommendations); don't fight the HPA on the same metric.
- The **cluster autoscaler** turns Pending pods into new nodes and removes underused ones;
  requests drive it, PDBs and local storage can block it.
- **PDBs** protect against voluntary disruptions — always allow at least one.
- Place pods with nodeSelector/affinity, spread them with anti-affinity and topology spread, and
  dedicate node pools with **taints + tolerations + nodeSelector**.
