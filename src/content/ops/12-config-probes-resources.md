---
id: ops-12
title: Config, Secrets, Probes & Resources
level: intermediate
minutes: 80
xp: 150
summary: Make pods production-shaped — ConfigMaps and Secrets (and why base64 is not encryption), env vs mounted files for ASP.NET, liveness/readiness/startup probes, requests/limits, QoS, OOMKilled and CPU throttling.
---

A pod that merely *runs* isn't ready for production. It must get its **configuration** from the
platform, tell Kubernetes **when it is healthy and ready**, shut down **gracefully**, and declare
**how much CPU and memory** it needs. Get these four right and rolling updates, autoscaling and
node failures become non-events. Get them wrong and you'll meet `CrashLoopBackOff`, `OOMKilled`,
`Pending` and "random" 502s.

## ConfigMaps: configuration as an object

The same image must run in dev, test and prod (build once, deploy many — as in the Docker CI
lesson). If you baked `appsettings.Production.json` into the image, changing one CORS origin
would mean a new build, a new tag and a new security scan — and dev would be running a different
artifact than prod. So everything that differs between environments lives **outside** the image.

A **ConfigMap** is a Kubernetes object that holds **non-secret** key/value data. Each value is a
string: either a short value (a flag, a URL) or the full contents of a file. Pods then consume it
as environment variables or as files (next sections). A ConfigMap is limited to **1 MiB** — it is
for configuration, not for data.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  ASPNETCORE_ENVIRONMENT: Production
  Logging__LogLevel__Default: Information
  Features__NewEditor: "true"          # values are always strings — quote booleans/numbers
  appsettings.Production.json: |       # a whole file as one key
    {
      "Cors": { "AllowedOrigins": ["https://app.example.com"] }
    }
```

```bash
kubectl create configmap api-config --from-literal=Features__NewEditor=true --from-file=appsettings.Production.json \
  --dry-run=client -o yaml > api-config.yaml      # generate YAML instead of applying imperatively
```

:::info title="ASP.NET Core reads Kubernetes config natively"
The default host reads **environment variables** with `__` as the section separator:
`ConnectionStrings__Default` → `ConnectionStrings:Default`, `Jwt__Issuer` → `Jwt:Issuer`. No code
needed — and environment variables override `appsettings.json`, so the image's defaults are
replaced only where you set something. For files, mount them and add them as a configuration
source (`AddJsonFile` or `AddKeyPerFile`) — see below.
:::

## Secrets — and why base64 is not encryption

A **Secret** is the object for sensitive values: passwords, connection strings, signing keys,
TLS certificates. Why a separate kind if it looks almost the same? Because Kubernetes can treat it
differently: RBAC rules can allow a team to read ConfigMaps but not Secrets, the API server can
encrypt Secrets in its database (etcd), and the kubelet mounts them on in-memory tmpfs instead of
the node's disk. In the manifest, the values under `data` are **base64-encoded**; `stringData`
lets you write plain text and the API server encodes it for you:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: api-secrets
type: Opaque
stringData:                              # write plain text; the API server encodes it
  ConnectionStrings__Default: "Host=pg-rw;Database=app;Username=app;Password=s3cr3t"
  Jwt__SigningKey: "change-me-in-real-life"
```

```bash
kubectl get secret api-secrets -o jsonpath='{.data.Jwt__SigningKey}' | base64 -d
# change-me-in-real-life      ← anyone who can read the Secret can read the value
```

**Base64 is an encoding, not encryption.** It exists so binary data (TLS keys, keystores) fits in
JSON. What actually protects Secrets:

| Protection | What it does |
|---|---|
| **RBAC** | Only specific ServiceAccounts/users may `get`/`list` secrets in a namespace (ops-16) |
| **Encryption at rest** | API server encrypts Secrets in etcd (`EncryptionConfiguration`, KMS). K3s: `--secrets-encryption` |
| **Don't commit them** | A Secret YAML in Git is a leaked password. Use External Secrets + Vault, Sealed Secrets or SOPS (ops-16) |
| **Mount, don't log** | Avoid printing config at startup; prefer mounted files over env (env leaks into crash dumps, `/proc`, child processes) |

Special types you'll meet: `kubernetes.io/tls` (cert-manager output), `kubernetes.io/dockerconfigjson`
(image pull secrets), `kubernetes.io/service-account-token`.

:::quiz id=ops-12-q1 xp=10
A teammate says: *"Our DB password is safe in Git because the Secret manifest is base64-encoded."*
What's the right response?
- [ ] Correct — base64 is a one-way hash
- [x] Wrong — base64 decodes instantly; anyone with repo access has the password. Use a secret manager or encrypt it (Sealed Secrets/SOPS)
- [ ] Correct, as long as the repo is private
- [ ] Wrong — Secrets must use `data`, never `stringData`
> `echo czNjcjN0 | base64 -d` prints `s3cr3t` — base64 is a reversible encoding, not a hash and
> not encryption. "The repo is private" is the tempting answer, but it still gives the password to
> every developer, CI job, fork and backup of that repo, forever (Git history). `data` vs
> `stringData` is just input format. Fix: rotate the password, purge it from history, and switch to
> External Secrets / Sealed Secrets / SOPS.
:::

## Consuming config: env vars vs mounted files

A pod can read a ConfigMap or Secret in two ways: as **environment variables** (set once, when
the container starts) or as **files** in a mounted volume (one file per key). Both are shown
below, plus the **Downward API**, which injects facts about the pod itself (its name, namespace,
node) — handy for logs and metrics.

```yaml
spec:
  containers:
    - name: api
      image: devquest/api:1.0.0
      envFrom:                                  # every key becomes an env var
        - configMapRef:
            name: api-config
      env:
        - name: ConnectionStrings__Default      # one key, renamed if you like
          valueFrom:
            secretKeyRef:
              name: api-secrets
              key: ConnectionStrings__Default
        - name: POD_NAME                        # the Downward API: facts about the pod itself
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
      volumeMounts:
        - name: secrets
          mountPath: /etc/devquest/secrets
          readOnly: true
        - name: config
          mountPath: /app/config
          readOnly: true
  volumes:
    - name: secrets
      secret:
        secretName: api-secrets                  # each key → one file
    - name: config
      configMap:
        name: api-config
        items:
          - key: appsettings.Production.json
            path: appsettings.Production.json
```

```csharp
// Program.cs — add mounted files as configuration sources
// AddKeyPerFile is part of the ASP.NET Core shared framework (a plain console/worker app
// needs the NuGet package Microsoft.Extensions.Configuration.KeyPerFile)
builder.Configuration
    .AddJsonFile("config/appsettings.Production.json", optional: true, reloadOnChange: true)
    .AddKeyPerFile("/etc/devquest/secrets", optional: true);   // file name = key, "__" = ":"
```

The relative path `config/…` resolves against the content root, which defaults to the process's
working directory: `/app`, from the `WORKDIR /app` in our Dockerfile (ops-04). That is why the
ConfigMap is mounted at `/app/config` (a different `WORKDIR` means a different mount path). Sources added later win, so these
files override the image's `appsettings.json`.

:::warn title="Common mistake: envFrom imports file keys too"
`envFrom` turns **every** key of the ConfigMap into an environment variable — including
`appsettings.Production.json`, whose whole JSON text becomes one odd env var. Harmless here, but
confusing. In real projects keep **two ConfigMaps**: one with flat keys for `envFrom`, one with
files for the volume.
:::

| | Env vars | Mounted files |
|---|---|---|
| Update when ConfigMap/Secret changes | **Never** — only on container restart | Yes, eventually (kubelet sync, ~1 min) — *except* with `subPath` |
| Visibility | `/proc/<pid>/environ`, crash dumps, child processes | File permissions; tmpfs for Secrets |
| Good for | Simple flags, connection strings | Certificates, JSON files, rotating credentials |

Why do files update but env doesn't? An environment is copied into a process once, at `exec` —
nobody can change it from outside afterwards. A mounted ConfigMap, on the other hand, is a
directory of symlinks that the kubelet atomically swaps to a new version when the object changes.
`subPath` mounts **one file** by bind-mounting it, bypassing the symlink swap — so a `subPath` file
never updates. And remember: even a file that updates only helps if the app **re-reads** it
(`reloadOnChange: true` plus `IOptionsMonitor<T>` in ASP.NET).

:::pro title="Roll pods when config changes"
Most teams don't rely on hot reload: they make config changes trigger a **rollout**. Kustomize's
`configMapGenerator` appends a content hash to the name (`api-config-7k2m9f`), so a change renames
the ConfigMap → the pod template changes → rolling update (ops-14). Helm charts do the same with a
`checksum/config` annotation. Bonus: rollback restores the old config too. Mark such ConfigMaps
`immutable: true` to reduce API-server load.
:::

:::quiz id=ops-12-q2 xp=10
You update the ConfigMap that feeds `envFrom` of a running Deployment. Ten minutes later, what do
the existing pods see?
- [ ] The new values — kubelet updates env vars every minute
- [x] The old values — env vars are set at container start; you need a rollout (e.g. `kubectl rollout restart`)
- [ ] The pods crash because their config changed
- [ ] The Deployment automatically performs a rolling update
> Environment variables are copied into the process when it starts and never change afterwards.
> The tempting "automatic rolling update" is wrong because the ConfigMap is a separate object: the
> Deployment's pod template only contains its *name*, which didn't change, so the Deployment
> controller sees nothing to roll out. Mounted files (without `subPath`) are refreshed; env never
> is. A hash-suffixed ConfigMap renames it on every change and so makes the update an automatic rollout.
:::

## Probes: telling Kubernetes the truth

Without probes, the kubelet (the agent on each node) only knows whether your process **exists**.
A process that is deadlocked, still loading, or unable to reach its database looks exactly like a
healthy one — so the Service sends it traffic and nobody restarts it. A **probe** is a periodic
check the kubelet runs against each container. There are three kinds, because there are three
different questions with three different correct reactions:

| Probe | Question | On failure | ASP.NET endpoint |
|---|---|---|---|
| **startupProbe** | "Has it finished starting?" | Keeps checking until `failureThreshold × periodSeconds`, then restarts. **Liveness and readiness don't run until it succeeds.** | `/live` (with a generous budget) |
| **livenessProbe** | "Is the process stuck beyond repair?" | **Restart** the container | `/live` — no dependency checks |
| **readinessProbe** | "Should it get traffic right now?" | **Remove from Service endpoints** (no restart) | `/ready` — warm-up done, *this instance* can serve (shared dependencies: see the caveat below) |

```text
container start
   │  startupProbe every 2 s … up to 30 × 2 s = 60 s budget
   ▼
 started ──► livenessProbe every 10 s   (3 failures → restart)
         └─► readinessProbe every 5 s   (fail → out of endpoints; pass → back in)
```

Probe mechanisms: `httpGet` (status 200–399 = success), `tcpSocket` (port accepts a connection),
`exec` (command exits 0), `grpc` (gRPC health protocol). Tunables: `initialDelaySeconds`,
`periodSeconds` (default 10 s), `timeoutSeconds` (default **1 s** — a GC pause or a throttled CPU
can exceed that!), `failureThreshold` (default 3 consecutive failures), `successThreshold`.

Rule of thumb for the time until action: roughly `failureThreshold × periodSeconds`. A liveness
probe with `periodSeconds: 10, failureThreshold: 3` restarts a hung container after ~30 s.

### Mapping to ASP.NET Core health checks

ASP.NET Core's health-check middleware lets you register checks, **tag** them, and expose
different subsets on different URLs. That maps perfectly onto probes: a cheap "am I alive?"
endpoint and a "can I serve requests?" endpoint.

```csharp
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
    .AddDbContextCheck<AppDbContext>("postgres", tags: ["ready"]);
    // ↑ package Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore

var app = builder.Build();

// Liveness: is the process able to answer at all? NO external dependencies here.
app.MapHealthChecks("/live", new HealthCheckOptions { Predicate = r => r.Tags.Contains("live") });

// Readiness: can this instance do useful work? Warm-up, caches, the DB (but see the caveat below)
app.MapHealthChecks("/ready", new HealthCheckOptions { Predicate = r => r.Tags.Contains("ready") });
```

```yaml
containers:
  - name: api
    image: devquest/api:1.0.0
    ports:
      - name: http
        containerPort: 8080
    startupProbe:
      httpGet: { path: /live, port: http }
      periodSeconds: 2
      failureThreshold: 30          # up to 60 s to start (JIT, cache warm-up)
    livenessProbe:
      httpGet: { path: /live, port: http }
      periodSeconds: 10
      timeoutSeconds: 2
      failureThreshold: 3
    readinessProbe:
      httpGet: { path: /ready, port: http }
      periodSeconds: 5
      timeoutSeconds: 2
      failureThreshold: 2
```

:::warn title="Never check the database in liveness"
If `/live` checks Postgres and Postgres has a 30-second failover, **every API pod fails liveness
and gets restarted at once** — turning a short blip into a full outage plus a thundering herd of
reconnecting cold starts. Dependencies belong in **readiness**: pods stop receiving traffic, stay
alive, and come back the instant the DB does.
:::

:::warn title="…but readiness on a shared dependency has its own trap"
Moving the database check into readiness fixes the restart storm, but look at what happens during
the same 30-second failover: **every** API replica checks the **same** Postgres, so every replica
turns unready at the same moment. The Service now has **zero ready endpoints**, and the ingress
answers `503` for *every* API route: the health page, cached reads and the endpoints that never touch the
database. A partial degradation has become a full outage, just without the restarts.

The question to ask for each readiness check: *if this check fails, would a different pod do
better?*

* **Yes**: this instance is still warming up, its connection pool is broken, its local cache
  isn't loaded. Fail readiness, so traffic moves to the healthy replicas.
* **No**: Postgres is down for everyone. Failing readiness only moves the error from "500 on DB
  endpoints" to "503 on everything". Let the app return fast, honest errors (and alert on them,
  ops-16), and keep the pod in rotation.

In ASP.NET you can keep the shared check *visible* without letting it pull the pod: register it
with `failureStatus: HealthStatus.Degraded`. The health-check middleware maps `Degraded` to HTTP
200 by default, so the probe passes, but the response body says `Degraded` and the health-check
logs and metrics still show the problem.

```csharp
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"])
    .AddCheck<WarmupCheck>("warmup", tags: ["ready"])  // your own IHealthCheck, per-instance: fails readiness
    .AddDbContextCheck<AppDbContext>("postgres",
        failureStatus: HealthStatus.Degraded, tags: ["ready"]);       // shared: reported, not fatal
```

Teams differ here. Some keep a hard DB check in readiness on purpose for an API that is useless
without the database. That is a valid choice, but make it **knowingly**: with a tolerant
`failureThreshold`, so a 5-second blip doesn't drain every replica. The ops-17 boss fight uses the
simple "`/ready` checks the DB" version so you can *see* readiness work; this box is the
production nuance.
:::

:::quiz id=ops-12-q9 xp=15
All 6 API replicas' `/ready` endpoints check the same Postgres primary with a hard failure. During
a 20-second CNPG failover, what do users see?
- [ ] Nothing: readiness only removes the broken replica, so the others keep serving
- [x] `503` on every route, including ones that don't use the DB, because all 6 replicas are unready at once and the Service has no endpoints
- [ ] The pods restart and come back after the failover
- [ ] Only requests that touch the database fail
> The "remove the broken one, keep the rest" model only works when the failure is **specific to
> one instance**. A shared dependency fails for all replicas together, so all of them leave the
> endpoints and the ingress has nowhere to send traffic. Readiness never restarts anything (that's
> liveness). "Only DB requests fail" is what you'd get if the pods *stayed* ready and returned
> errors for DB-backed endpoints, which is often the better behaviour. Use readiness for
> per-instance problems, report shared dependencies as `Degraded`, or at least give the check a
> tolerant `failureThreshold`.
:::

:::quiz id=ops-12-q3 xp=15
After a deploy, a pod's **readiness** probe starts failing (the API can't reach Redis), but
liveness passes. What does Kubernetes do?
- [ ] Restarts the container until readiness passes
- [x] Removes the pod from the Service's endpoints and keeps it running; it gets traffic again when readiness passes
- [ ] Deletes the pod and schedules a new one
- [ ] Nothing — readiness is informational only
> Readiness controls **traffic**, liveness controls **restarts** — they never do each other's job.
> "Restarts the container" is the tempting answer, but a restart would not fix Redis being down
> and would just add cold starts. During a rollout, a new pod that never becomes ready also stops
> the rollout from progressing (`maxUnavailable` keeps the old pods serving).
:::

:::quiz id=ops-12-q4 xp=15
A .NET API takes ~40 s to start on a busy node (migrations + warm-up). Its only probe is
`livenessProbe: httpGet /live, initialDelaySeconds: 10, periodSeconds: 5, failureThreshold: 3`.
What happens and what's the fix?
- [ ] Works fine — liveness waits for the app to listen
- [x] It's killed after roughly 20–25 s, before finishing startup, and loops in CrashLoopBackOff. Add a `startupProbe` with a large enough budget
- [ ] It's marked unready but never restarted
- [ ] Increase `replicas` so one survives
> The first probe runs at ~10 s and fails (nothing listens yet), then again at ~15 s and ~20 s:
> three failures → restart, long before the 40 s start finishes — every time, so it never comes
> up. Liveness does **not** wait for the app to listen; a refused connection is simply a failure.
> More replicas don't help because every replica hits the same deadline. A startupProbe
> (`failureThreshold: 30, periodSeconds: 2`) gives slow starts room without making liveness
> sluggish afterwards. (Raising `initialDelaySeconds` to 60 also "works", but then every start —
> even a fast one — waits a minute before liveness protects it.)
:::

### Graceful shutdown

Pods are deleted all the time — every rollout, scale-down and node drain. When a pod is marked
for deletion, two independent chains start **at the same moment**:

```text
pod marked Terminating (grace period clock starts, e.g. 30 s)
 ├─► EndpointSlice controller removes the pod → kube-proxy / Ingress on every node update
 │   their routing … this takes a moment (often 1–5 s)
 └─► kubelet runs the preStop hook (if any) → then sends SIGTERM → app drains and exits
                                              → still running at 30 s? SIGKILL
```

Without a preStop hook, SIGTERM arrives immediately; a fast app stops accepting connections while
some proxies are **still routing new requests to it** → connection refused / 502s on every deploy.
The fix is a short `preStop` sleep: the pod keeps serving normally for a few seconds while the
routing catches up, and only *then* gets SIGTERM.

```yaml
spec:
  terminationGracePeriodSeconds: 30     # preStop + shutdown must finish in 30 s, then SIGKILL
  containers:
    - name: api
      lifecycle:
        preStop:
          sleep:
            seconds: 5                  # native sleep action (K8s 1.30+) — works in shell-less chiseled images
```

ASP.NET Core handles SIGTERM: it stops accepting connections and drains in-flight requests for up
to `HostOptions.ShutdownTimeout` (30 s by default since .NET 8). The grace period **includes** the
preStop time, so keep `preStop + ShutdownTimeout < terminationGracePeriodSeconds` — with the
defaults above (5 s + 30 s vs 30 s) you'd set `ShutdownTimeout` to ~20 s or raise the grace period
to 45 s. Workers should finish (or re-queue) the current job when the `stoppingToken` passed to
`BackgroundService.ExecuteAsync` is cancelled.

```csharp
builder.Services.Configure<HostOptions>(o => o.ShutdownTimeout = TimeSpan.FromSeconds(20));
```

:::quiz id=ops-12-q8 xp=15
A pod has `terminationGracePeriodSeconds: 10` and a `preStop` sleep of 5 s. Some API requests
(report exports) take ~15 s. What happens to an export that started just before the pod was
deleted?
- [ ] It finishes — ASP.NET waits up to `ShutdownTimeout` (30 s) for in-flight requests
- [x] It is cut off: SIGTERM arrives at ~5 s, and at 10 s the kubelet sends SIGKILL no matter what the app is doing
- [ ] It finishes, because the preStop hook pauses the grace-period clock
- [ ] Kubernetes moves the request to another pod
> The grace period is a hard wall that **includes** the preStop hook: 5 s sleep, then SIGTERM, and
> SIGKILL at 10 s. ASP.NET's own 30 s `ShutdownTimeout` doesn't matter — the kernel kill wins.
> HTTP requests are never migrated between pods. Fix: raise `terminationGracePeriodSeconds` above
> preStop + your longest request (e.g. 30 s), or move long work to a background job.
:::

## Resources: requests and limits

A node is shared by many pods. Kubernetes needs two numbers from you per container: how much it
should **reserve** for you when choosing a node (the **request**), and the **maximum** you may
ever use on that node (the **limit**). CPU is measured in cores (`1` = one core, `250m` = a quarter
core); memory in bytes with suffixes.

```yaml
resources:
  requests:            # what the scheduler reserves for you
    cpu: 250m          # 250 millicores = 1/4 of a core
    memory: 256Mi      # Mi = mebibytes (2^20). "M" = 10^6 — don't mix them up
  limits:              # the hard ceiling enforced on the node
    memory: 512Mi
    # cpu limit omitted on purpose (see below)
```

| | **requests** | **limits** |
|---|---|---|
| Used by | the **scheduler** (does it fit on a node?) and CPU weighting under contention | the **kernel** (cgroups) on the node |
| CPU | Guaranteed share when the node is busy | **Throttled** (CFS quota): the process is paused for the rest of each 100 ms period |
| Memory | Reserved for scheduling | Exceed it → the kernel **OOM-kills** the container (`OOMKilled`, exit code 137) |

```text
Node allocatable: 4 CPU / 8 Gi
┌──────────────────────────────────────────────────────────────┐
│ api 250m/256Mi │ api 250m/256Mi │ worker 500m/1Gi │ pg 1/2Gi │  ← sum of REQUESTS
└──────────────────────────────────────────────────────────────┘
 A new pod requesting 3 CPU doesn't fit → Pending: "0/3 nodes are available: Insufficient cpu"
```

The scheduler only looks at **requests**, never at actual usage. Requests too high → wasted money
and `Pending` pods. Too low (or missing) → nodes get overcommitted and pods fight / get evicted.

### OOMKilled and CPU throttling

* **OOMKilled**: memory isn't compressible. Hit the limit → instant kill, restart, maybe
  `CrashLoopBackOff`. `kubectl describe pod` shows `Last State: Terminated, Reason: OOMKilled,
  Exit Code: 137`.
* **CPU throttling**: CPU *is* compressible — you're slowed, not killed. Symptoms: p99 latency
  spikes, slow startups, probe **timeouts** (→ liveness restarts!), even though average CPU looks
  fine. Metric: `container_cpu_cfs_throttled_periods_total`.

:::pro title="What many production teams do"
Set **memory request = memory limit** (predictable, no surprise OOM from neighbours) and set a CPU
**request** but **no CPU limit** for latency-sensitive services, so they can burst into idle CPU.
Enforce sane defaults per namespace with a `LimitRange` and caps with a `ResourceQuota`. Size
requests from real usage (Prometheus, or VPA recommendations — ops-15).
:::

:::job title=".NET in containers"
The .NET runtime is container-aware: the GC limits its heap to **75 % of the memory limit** by
default (`DOTNET_GCHeapHardLimitPercent` to tune) and `Environment.ProcessorCount` follows the CPU
**limit** (rounded up). Without a CPU limit it sees every core of the node — set
`DOTNET_PROCESSOR_COUNT` if thread-pool and GC sizing should follow your request instead. Since
.NET 9, Server GC (the ASP.NET default) uses **DATAS** by default, which adapts the number of heaps
to the load, so small services no longer grab a heap per core; you can still switch to workstation
GC (`DOTNET_gcServer=0`) for tiny sidecars. No memory limit at all means the GC sizes itself to
the whole **node** — and then gets OOM-killed or evicted when the node runs out.
:::

### QoS classes

From requests/limits Kubernetes derives a **Quality of Service** class, which decides who gets
evicted first when a node runs out of memory:

| QoS | Rule | Evicted |
|---|---|---|
| **Guaranteed** | *Every* container has CPU **and** memory limits, and requests equal limits | Last |
| **Burstable** | At least one container has a CPU or memory request/limit, but not Guaranteed | Middle (by usage above request) |
| **BestEffort** | No container has any CPU/memory request or limit | **First** |

`kubectl get pod api-xyz -o jsonpath='{.status.qosClass}'`

Precisely, the kubelet ranks pods for node-pressure eviction by *whether their usage exceeds their
requests*, then by priority, then by how far above the request they are. The QoS order falls out
of that: a BestEffort pod requests nothing, so any usage is "above request"; a Guaranteed pod can't
use more than its request (request = limit). The QoS class also sets the kernel's OOM-killer
preference (`oom_score_adj`) in the same order.

:::quiz id=ops-12-q5 xp=15
A pod's status shows `Last State: Terminated — Reason: OOMKilled — Exit Code: 137`, and it has
restarted 5 times. Which statements are true? (select all)
- [x] The container exceeded its **memory limit** and the kernel killed it
- [ ] The container exceeded its **CPU limit**
- [x] Fixes include raising the memory limit or reducing the app's memory use (e.g. leaks, unbounded caches, huge result sets)
- [ ] Setting a CPU limit would prevent it
- [x] Exit code 137 = 128 + 9 (SIGKILL)
> Exit code 137 = 128 + signal 9 (SIGKILL), and `OOMKilled` means the kernel did it because the
> cgroup hit its **memory limit**. CPU is compressible: over-use only throttles, so neither the CPU
> limit nor adding one has anything to do with this. Check the memory trend in Grafana before
> blindly doubling the limit — a leak will just take longer to hit the new one.
:::

## Namespace guardrails: LimitRange, ResourceQuota, PriorityClass

Requests and limits are set **per container**, by whoever writes the manifest. On a shared cluster
that isn't enough: one team forgets requests (BestEffort pods that get evicted first and starve
neighbours), another deploys 200 replicas by typo, and a batch job grabs the capacity the API
needed. Platform teams put three guardrails on every namespace. You will usually *receive* them,
but you need to read them, because they explain a whole class of "why won't my pod start?". The
examples use `devquest-dev`, the dev-environment namespace that ops-14 introduces.

**LimitRange: defaults and bounds per container.** Any container created in the namespace without
requests or limits gets the defaults filled in at admission; anything outside `min`/`max` is
rejected.

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: defaults
  namespace: devquest-dev
spec:
  limits:
    - type: Container
      defaultRequest: { cpu: 100m, memory: 128Mi }   # used when a container sets no request
      default:        { memory: 256Mi }              # used when it sets no limit
      max:            { memory: 2Gi }                # one container may never ask for more
```

**ResourceQuota: a budget for the whole namespace.** The sum over all pods may not exceed it.

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-budget
  namespace: devquest-dev
spec:
  hard:
    requests.cpu: "8"
    requests.memory: 16Gi
    limits.memory: 24Gi
    pods: "60"
    persistentvolumeclaims: "10"
    services.loadbalancers: "0"     # no cloud load balancers from this namespace (they cost money)
```

```bash
kubectl -n devquest-dev describe resourcequota team-budget   # Used vs Hard, per resource
```

Two behaviours surprise everyone once:

* With a quota on `requests.cpu` or `requests.memory`, a pod **without** requests is **rejected**
  (the quota can't count it). The LimitRange defaults above are what keep that from biting.
* Quota is checked when the **pod** is created, and the ReplicaSet controller creates pods, not
  you. So `kubectl apply` of the Deployment succeeds, and then simply *fewer pods appear*. The
  error is in the ReplicaSet's events: `kubectl describe rs <name>` → `exceeded quota: team-budget,
  requested: requests.cpu=500m, used: requests.cpu=7800m, limited: requests.cpu=8`.

**PriorityClass: who wins when the cluster is full.** A cluster-wide object with a number; pods
reference it by name. When a high-priority pod can't be scheduled, the scheduler may **preempt**
(evict) lower-priority pods to make room. The kubelet also uses priority when it must evict pods
under node pressure.

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: customer-facing
value: 100000
description: API and frontend. May preempt batch work.
---
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: batch
value: 1000
preemptionPolicy: Never           # waits for room; never evicts others
description: Exports, reports, re-indexing.
```

```yaml
# in the API's pod template
spec:
  priorityClassName: customer-facing
```

The DevQuest shape: API and web get `customer-facing`, the worker and CronJobs get `batch`. At 9:00,
when 40 000 exports arrive and the cluster is full, a new API replica from the HPA evicts a worker
pod instead of sitting `Pending` (the worker's job is re-queued, see graceful shutdown above). Don't
hand out high priorities freely: if everything is critical, nothing is. The built-in
`system-cluster-critical` and `system-node-critical` are reserved for the cluster's own components.

:::quiz id=ops-12-q10 xp=15
`devquest-dev` has a ResourceQuota with `requests.cpu: "4"`, currently `3800m` used. You
`kubectl apply` a Deployment change that adds 2 replicas of a pod requesting `500m`. What do you
observe?
- [ ] `kubectl apply` fails with a quota error
- [x] The apply succeeds, no new pods appear, and `kubectl describe rs` shows `exceeded quota` events
- [ ] Two new pods appear and stay `Pending` with "Insufficient cpu"
- [ ] The quota is raised automatically because the Deployment was accepted
> The Deployment object itself consumes no CPU quota, so the API server accepts it. Pods are
> created later by the ReplicaSet controller, and *that* create call is rejected at admission
> (3800m + 500m > 4). Rejected pods never exist, so they can't be `Pending`: that would be the
> scheduler failing to find a node, a different problem. Look for the quota message on the
> ReplicaSet (or `kubectl get events`), then ask the platform team to raise the quota or lower
> your requests.
:::

:::lab id=ops-12-lab1 xp=100
title: Config, Secrets and the base64 trap
Work in a fresh namespace in your kind cluster:

```bash
kubectl create namespace ops12
kubectl config set-context --current --namespace=ops12
```

Save as `config-demo.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  ASPNETCORE_ENVIRONMENT: Staging
  Features__NewEditor: "false"
  appsettings.Staging.json: |
    { "Cors": { "AllowedOrigins": ["https://staging.example.com"] } }
---
apiVersion: v1
kind: Secret
metadata:
  name: api-secrets
type: Opaque
stringData:
  ConnectionStrings__Default: "Host=pg-rw;Database=app;Username=app;Password=s3cr3t"
---
apiVersion: v1
kind: Pod
metadata:
  name: config-demo
spec:
  containers:
    - name: app
      image: busybox:1.37
      command: ["sh", "-c", "while true; do echo \"env NewEditor=$Features__NewEditor\"; cat /config/appsettings.Staging.json; sleep 10; done"]
      envFrom:
        - configMapRef:
            name: api-config
      env:
        - name: ConnectionStrings__Default
          valueFrom:
            secretKeyRef:
              name: api-secrets
              key: ConnectionStrings__Default
      volumeMounts:
        - name: config
          mountPath: /config
        - name: secrets
          mountPath: /etc/devquest/secrets
          readOnly: true
  volumes:
    - name: config
      configMap:
        name: api-config
    - name: secrets
      secret:
        secretName: api-secrets
```

```bash
kubectl apply -f config-demo.yaml
kubectl logs config-demo
kubectl exec config-demo -- env | grep -E "ASPNETCORE|Features|ConnectionStrings"
kubectl exec config-demo -- ls -l /etc/devquest/secrets/
kubectl exec config-demo -- mount | grep secrets       # tmpfs — Secrets never touch the node's disk
```

Expected (abridged): the log prints `env NewEditor=false` followed by the Staging JSON every 10 s;
`env` lists `ASPNETCORE_ENVIRONMENT=Staging`, `Features__NewEditor=false` and the connection
string; `ls` shows one file, `ConnectionStrings__Default` (a symlink into `..data/`); `mount`
shows a line like `tmpfs on /etc/devquest/secrets type tmpfs (ro,…)`.

**The base64 trap** — read the "secret" with nothing but read access:

```bash
kubectl get secret api-secrets -o yaml                # data: ConnectionStrings__Default: SG9zdD1…
kubectl get secret api-secrets -o jsonpath='{.data.ConnectionStrings__Default}' | base64 -d; echo
```

**Env vs files on update:**

```bash
kubectl patch configmap api-config --type merge -p '{"data":{"Features__NewEditor":"true","appsettings.Staging.json":"{ \"Cors\": { \"AllowedOrigins\": [\"https://new.example.com\"] } }"}}'
kubectl logs -f config-demo     # within ~1–2 min the FILE shows new.example.com, the ENV still says false
```

Press Ctrl+C. Now recreate the pod with the same spec (a pod's env can't be edited in place) —
don't re-apply `config-demo.yaml`, that would also reset the ConfigMap to `false`:

```bash
kubectl get pod config-demo -o yaml | kubectl replace --force -f -   # delete + recreate the pod
kubectl wait --for=condition=Ready pod/config-demo --timeout=60s
kubectl logs config-demo        # env NewEditor=true — the new process read the new ConfigMap
```

The delete part takes up to 30 s: the `sh` loop runs as PID 1 and ignores SIGTERM, so the kubelet
waits out the grace period and then sends SIGKILL. `kubectl wait` keeps `kubectl logs` from
failing with "container is waiting to start" while the new pod is still `ContainerCreating`.

- [ ] I saw ConfigMap keys as env vars and as files, and the Secret mounted on tmpfs
- [ ] I decoded the Secret with `base64 -d` and can explain why that is not a security problem *of base64* but of access control
- [ ] I observed the mounted file update while the env var stayed stale until the pod restarted
:::

:::lab id=ops-12-lab2 xp=120
title: Probes, OOMKilled and throttling — break things on purpose
Still in namespace `ops12`.

**1. Install metrics-server** (kind doesn't ship it; k3d/K3s does). The kubelet certificates in
kind are self-signed, hence the extra flag:

```bash
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
kubectl -n kube-system rollout status deployment/metrics-server
kubectl top nodes                     # may take ~60 s to show numbers
```

**2. Probes you can toggle.** Readiness checks a file in the web root, liveness checks a file in
`/tmp`. Save as `probes.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: probed
spec:
  replicas: 2
  selector:
    matchLabels: { app: probed }
  template:
    metadata:
      labels: { app: probed }
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          command: ["sh", "-c", "touch /tmp/alive && echo ok > /usr/share/nginx/html/ready && exec nginx -g 'daemon off;'"]
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet: { path: /ready, port: http }
            periodSeconds: 2
            failureThreshold: 1
          livenessProbe:
            exec:
              command: ["test", "-f", "/tmp/alive"]
            periodSeconds: 5
            failureThreshold: 2
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: probed
spec:
  selector: { app: probed }
  ports:
    - port: 80
      targetPort: http
```

```bash
kubectl apply -f probes.yaml && kubectl rollout status deploy/probed
POD=$(kubectl get pod -l app=probed -o jsonpath='{.items[0].metadata.name}')

# Readiness: remove the file → pod becomes 0/1 READY and its endpoint turns ready=false, but it is NOT restarted
kubectl exec $POD -- rm /usr/share/nginx/html/ready
kubectl get pods -l app=probed
kubectl get endpointslices -l kubernetes.io/service-name=probed \
  -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"  ready="}{.conditions.ready}{"\n"}{end}'
kubectl exec $POD -- sh -c 'echo ok > /usr/share/nginx/html/ready'   # back in

# Liveness: remove /tmp/alive → after ~10 s the container is restarted (RESTARTS +1)
kubectl exec $POD -- rm /tmp/alive
kubectl get pods -l app=probed -w
kubectl describe pod $POD | grep -E "Liveness probe failed|Killing" 
```

The unready pod does not disappear from the EndpointSlice: it stays listed with `ready=false`
(which is why the plain `kubectl get endpointslices` table still shows both IPs). kube-proxy and
Ingress controllers only route to endpoints marked ready, so traffic stops reaching it anyway.

**3. OOMKilled.** `tail /dev/zero` reads an endless line into memory:

```bash
kubectl run memhog --image=busybox:1.37 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"memhog","image":"busybox:1.37","command":["sh","-c","tail /dev/zero"],"resources":{"limits":{"memory":"64Mi"}}}]}}'
kubectl get pod memhog -w                         # OOMKilled
kubectl get pod memhog -o jsonpath='{.status.containerStatuses[0].state.terminated}{"\n"}'
```

**4. CPU throttling.** A busy loop limited to 100m:

```bash
kubectl run cpuhog --image=busybox:1.37 \
  --overrides='{"spec":{"containers":[{"name":"cpuhog","image":"busybox:1.37","command":["sh","-c","while true; do :; done"],"resources":{"requests":{"cpu":"100m"},"limits":{"cpu":"100m"}}}]}}'
sleep 60; kubectl top pod cpuhog                  # ~100m, never more — it is being throttled, not killed
kubectl get pod cpuhog -o jsonpath='{.status.qosClass}{"\n"}'     # Guaranteed? Burstable? Why?
kubectl get pod memhog -o jsonpath='{.status.qosClass}{"\n"}'
```

Expected: `memhog` shows `OOMKilled` within seconds and the jsonpath prints
`{"exitCode":137,…,"reason":"OOMKilled",…}`. `cpuhog` stays `Running` at ~100m. Both QoS lines
print `Burstable`: `cpuhog` has CPU request = limit but **no memory** values, and `memhog` has a
memory limit but **no CPU** values — Guaranteed needs both resources in every container.

**5. Apply it to your API (optional but recommended).** Add `/live` and `/ready` to your ASP.NET
app as shown above, rebuild the image as `devquest/api:1.1.0`, `kind load` it and add the three
probes + resources to your ops-10 Deployment.

Clean up: `kubectl delete namespace ops12`.

- [ ] metrics-server works (`kubectl top nodes` shows numbers)
- [ ] Failing readiness marked the pod's endpoint `ready=false` (no traffic) without restarting it
- [ ] Failing liveness restarted the container
- [ ] I produced an `OOMKilled` (exit 137) and saw throttling cap `cpuhog` at ~100m
- [ ] I can explain the QoS class of `cpuhog` and `memhog`
:::

## Code it: QoS classes

:::challenge id=ops-12-c1 lang=ts xp=50
title: Compute a pod's QoS class
Write `qosClass(containers)` returning `'Guaranteed' | 'Burstable' | 'BestEffort'`.

Each container has optional `requests` and `limits` with optional `cpu` / `memory` strings.

* **BestEffort** — no container sets any cpu/memory request or limit.
* **Guaranteed** — *every* container has both cpu and memory **limits**, and for each resource the
  request equals the limit. A missing request defaults to the limit (that's what Kubernetes does).
* Otherwise **Burstable**.

Compare values as plain strings (assume the same units are used).

hint: First check BestEffort: does any container have any of the four fields?
hint: For Guaranteed, every container must satisfy: `limits.cpu && limits.memory && (requests.cpu ?? limits.cpu) === limits.cpu && …`

```ts starter
type Res = { cpu?: string; memory?: string }
type Container = { name: string; requests?: Res; limits?: Res }

export function qosClass(containers: Container[]): 'Guaranteed' | 'Burstable' | 'BestEffort' {
  const anyLimits = containers.some((c) => c.limits)
  return anyLimits ? 'Guaranteed' : 'BestEffort'
}
```

```ts solution
type Res = { cpu?: string; memory?: string }
type Container = { name: string; requests?: Res; limits?: Res }

export function qosClass(containers: Container[]): 'Guaranteed' | 'Burstable' | 'BestEffort' {
  const keys = ['cpu', 'memory'] as const
  const anySet = containers.some((c) => keys.some((k) => c.requests?.[k] !== undefined || c.limits?.[k] !== undefined))
  if (!anySet) return 'BestEffort'
  const guaranteed = containers.every((c) =>
    keys.every((k) => {
      const limit = c.limits?.[k]
      if (limit === undefined) return false
      const request = c.requests?.[k] ?? limit
      return request === limit
    }),
  )
  return guaranteed ? 'Guaranteed' : 'Burstable'
}
```

```ts tests
test('nothing set is BestEffort', () => {
  expect(qosClass([{ name: 'a' }, { name: 'b', requests: {}, limits: {} }])).toBe('BestEffort')
})
test('requests equal limits is Guaranteed', () => {
  expect(qosClass([{ name: 'api', requests: { cpu: '500m', memory: '512Mi' }, limits: { cpu: '500m', memory: '512Mi' } }])).toBe('Guaranteed')
})
test('limits only → requests default to limits → Guaranteed', () => {
  expect(qosClass([{ name: 'api', limits: { cpu: '1', memory: '1Gi' } }])).toBe('Guaranteed')
})
test('no CPU limit is Burstable', () => {
  expect(qosClass([{ name: 'api', requests: { cpu: '250m', memory: '256Mi' }, limits: { memory: '256Mi' } }])).toBe('Burstable')
})
test('request lower than limit is Burstable', () => {
  expect(qosClass([{ name: 'api', requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '128Mi' } }])).toBe('Burstable')
})
test('one guaranteed + one empty container is Burstable', () => {
  expect(qosClass([
    { name: 'api', limits: { cpu: '1', memory: '1Gi' } },
    { name: 'sidecar' },
  ])).toBe('Burstable')
})
test('only a memory request is Burstable', () => {
  expect(qosClass([{ name: 'w', requests: { memory: '64Mi' } }])).toBe('Burstable')
})
```
:::

:::quiz id=ops-12-q6 xp=15
A new worker pod is stuck in `Pending`. `kubectl describe pod` says:
`0/3 nodes are available: 3 Insufficient memory.` The nodes have 8 Gi each and `kubectl top
nodes` shows only 30 % memory used. Why?
- [ ] metrics-server is wrong
- [x] Scheduling uses the sum of **requests**, not actual usage — the nodes' requested memory is nearly full, or the pod requests more than any node can offer
- [ ] The pod's memory **limit** is too low
- [ ] The image is too large
> The scheduler never looks at `kubectl top`; it adds up the **requests** of the pods already on
> each node. 30 % real usage with 95 % requested is common when requests are padded. Limits play
> no part in scheduling, so "limit too low" can't cause `Pending` (it causes OOMKilled later).
> Compare `kubectl describe node` → "Allocated resources" with the pod's requests. Fix
> over-sized requests (yours or your neighbours'), or add nodes — which is exactly what the
> cluster autoscaler does (ops-15).
:::

:::quiz id=ops-12-q7 xp=10
The node is under memory pressure and must evict a pod. Which goes first?
- [ ] A Guaranteed Postgres pod
- [ ] A Burstable API pod using less than its request
- [x] A BestEffort debug pod with no requests or limits
> The kubelet evicts pods whose usage exceeds their requests first. The BestEffort pod requested
> nothing, so all of its usage is "above request". The Burstable API is *below* its request, and
> the Guaranteed Postgres pod can never exceed its request — both are protected. Order: BestEffort,
> then Burstable pods furthest above their requests, Guaranteed last. Another reason to always set
> requests.
:::

:::cards id=ops-12-cards1 xp=15 title="Config, probes & resources"
Q: ConfigMap vs Secret?
A: Same shape; Secrets are base64-encoded, can be RBAC-restricted, encrypted at rest and mounted on tmpfs. Neither is encrypted by default.
Q: Is base64 encryption?
A: No — it's an encoding. Protection comes from RBAC, encryption at rest and keeping plaintext Secrets out of Git.
Q: How does ASP.NET map env vars to config sections?
A: `__` becomes `:` — ConnectionStrings__Default → ConnectionStrings:Default.
Q: Do env vars update when a ConfigMap changes?
A: No. Mounted files do (eventually, not with subPath). Env needs a restart/rollout.
Q: Liveness vs readiness?
A: Liveness fail → restart container. Readiness fail → removed from Service endpoints, no restart.
Q: What is a startupProbe for?
A: Slow starters: it holds off liveness/readiness until the app has started, with its own larger budget.
Q: Should liveness check the database?
A: No — a DB blip would restart every pod. Dependencies go in readiness (mind the shared-dependency trap).
Q: What's the risk of a hard shared-DB check in readiness?
A: Every replica goes unready at once → the Service has no endpoints → 503 on all routes. Prefer per-instance checks; report shared deps as Degraded or use a tolerant threshold.
Q: LimitRange vs ResourceQuota?
A: LimitRange = per-container defaults and min/max. ResourceQuota = budget for the sum of the whole namespace.
Q: Where does a quota rejection show up for a Deployment?
A: In the ReplicaSet's events (`kubectl describe rs`) — the pods are never created.
Q: What does a PriorityClass do?
A: Higher-priority pods may preempt lower ones when the cluster is full; also affects eviction order. `preemptionPolicy: Never` for batch.
Q: Requests vs limits?
A: Requests = scheduler reservation and CPU share. Limits = hard cap: CPU throttled, memory OOM-killed.
Q: OOMKilled exit code?
A: 137 (128 + SIGKILL 9).
Q: QoS classes?
A: Guaranteed (requests = limits for CPU and memory in every container), Burstable (something set), BestEffort (nothing set — evicted first).
Q: Why preStop sleep?
A: Endpoint removal and the shutdown sequence start at the same time; a short sleep before SIGTERM lets proxies stop sending traffic before the app stops accepting connections.
Q: Does terminationGracePeriodSeconds include the preStop hook?
A: Yes. preStop + app shutdown must fit inside it, or the container is SIGKILLed.
Q: Why can a pod be Pending while nodes show low usage?
A: The scheduler sums requests, not actual usage.
:::

## Recap

- Configuration lives in **ConfigMaps** and **Secrets**, injected as env vars (`__` = `:` for
  ASP.NET) or files. Env never updates in place; roll pods on config change (hash suffixes).
- **Base64 is not encryption.** Protect Secrets with RBAC, encryption at rest and external secret
  management; never commit them in plaintext (encrypted or referenced is fine, ops-16).
- **startup** = give slow starters time, **liveness** = restart if stuck (no dependency checks!),
  **readiness** = gate traffic for problems *specific to this pod*. A hard check on a shared DB
  drains every replica at once; report it as `Degraded` or make it tolerant. Map probes to ASP.NET
  `/live` and `/ready`.
- Graceful shutdown: preStop sleep (let routing catch up) → SIGTERM → ASP.NET draining, all
  inside `terminationGracePeriodSeconds`, which includes the preStop time.
- **Requests** drive scheduling; **limits** throttle CPU and OOM-kill memory (exit 137). QoS
  (Guaranteed/Burstable/BestEffort) decides eviction order.
- Namespaces get guardrails: **LimitRange** (defaults, min/max), **ResourceQuota** (namespace
  budget; rejections show on the ReplicaSet) and **PriorityClass** (API preempts batch when full).
