---
id: ops-09
title: Kubernetes — The Mental Model
level: beginner
minutes: 60
xp: 120
summary: Why orchestration exists, what the control plane actually does, desired state and reconciliation loops — then your first local cluster with kind.
---

In the Docker lessons you packaged the API, the Vite frontend and Postgres into images and ran them
with `docker compose`. That works beautifully on **one** machine. This lesson is about what happens
when "one machine" stops being enough — and about the single idea that makes Kubernetes click:
**you describe what you want, and a swarm of control loops keeps making it true.**

Get the mental model right here and every later topic (Deployments, Services, HPA, KEDA,
operators like CloudNativePG, GitOps) is just *"another controller watching another object"*.

## Why orchestration?

Picture your SaaS on a single VM with compose:

```text
          ┌──────────────── VM (8 GB) ────────────────┐
users ──► │ nginx (web) ─► api ─► postgres   worker   │
          └───────────────────────────────────────────┘
```

Now real life happens:

| Problem | With compose on one VM | What an orchestrator does |
|---|---|---|
| The VM dies at 3 a.m. | Everything is down until you wake up | Reschedules containers onto healthy nodes |
| Black Friday traffic | `docker compose up --scale api=5` by hand, on one box | Adds replicas (and even nodes) automatically |
| Deploying v2 | Stop old, start new → downtime | Rolling update: new pods become ready before old ones go |
| A container leaks memory and hangs | It stays hung | Health probes fail → container restarted |
| "Where is the API running?" | Fixed hostnames on one network | Stable Service names + DNS, wherever the pods land |
| 30 services, 10 machines | Spreadsheets of who runs where | The scheduler bin-packs by CPU/memory requests |
| Secrets & config | `.env` files copied around | ConfigMaps / Secrets injected by the platform |

An **orchestrator** runs containers across a *cluster* of machines and continuously heals, scales
and updates them. Kubernetes (K8s — "K", 8 letters, "s") won that race and is now the default
platform API of the industry.

:::info title="What Kubernetes is NOT"
It is not a PaaS that builds your code, not a database, and not magic. It will happily run a broken
image 500 times in a row. It gives you **building blocks** plus **automation loops**; you still
design the app to be restartable, stateless where possible, and observable.
:::

## Seven words you need first

The rest of this lesson (and the next ones) uses a small vocabulary. Each word gets its own deep
dive later; for now you only need a one-line picture of each.

| Term | One-line definition | Compose analogy |
|---|---|---|
| **Cluster** | A set of machines managed as one Kubernetes installation | — (compose has one host) |
| **Node** | One machine (VM, bare metal, or in our lab a Docker container) in the cluster that runs workloads | the Docker host |
| **Pod** | The smallest thing Kubernetes runs: one (sometimes a few) containers that share an IP and are always placed on the same node | one service's container |
| **Deployment** | "Keep N identical pods of this template running, and update them gradually" | `deploy.replicas` + `docker compose up` for one service |
| **Service** | A stable name + virtual IP that load-balances to whichever pods currently match | the service name on the compose network |
| **Namespace** | A named folder inside the cluster for grouping objects and attaching permissions | a compose *project* |
| **Object / resource** | Any record you store in Kubernetes (a Deployment, a Service, a Namespace…) | an entry in `compose.yaml` |

One more word that appears everywhere: a **watch**. Instead of polling, a component asks the API
server *"tell me whenever objects of this kind change"* and receives a stream of updates. Almost
every arrow in the diagrams below is a watch.

## The cluster: control plane and nodes

```text
                         ┌──────────────── CONTROL PLANE ────────────────┐
 kubectl / CI / Argo CD  │                                               │
 ───────── HTTPS ──────► │  kube-apiserver  ◄──────►  etcd (key-value)   │
                         │    ▲     ▲    ▲                               │
                         │    │     │    └─ kube-scheduler               │
                         │    │     └────── kube-controller-manager      │
                         │    │             (Deployment, ReplicaSet,     │
                         │    │              Node, Job, EndpointSlice…)  │
                         └────┼──────────────────────────────────────────┘
                              │ watch / report status
        ┌─────────────────────┼─────────────────────────────────┐
        │  NODE (worker)      │                                 │
        │   kubelet ──────────┘   container runtime (containerd)│
        │   kube-proxy / CNI      ┌─────┐ ┌─────┐ ┌─────┐       │
        │                         │ pod │ │ pod │ │ pod │       │
        └─────────────────────────┴─────┴─┴─────┴─┴─────┴───────┘
```

| Component | Lives on | Job |
|---|---|---|
| **kube-apiserver** | control plane | The **only** front door. Validates, authenticates, authorizes, stores objects in etcd, and serves *watches*. Every other component talks to it — never to each other directly. |
| **etcd** | control plane | Consistent, replicated key-value store. The cluster's **single source of truth**: every object lives here. Lose etcd without a backup = lose the cluster. |
| **kube-scheduler** | control plane | Watches for pods with no node assigned, picks the best node (resources, affinity, taints…) and writes `spec.nodeName`. It doesn't start anything. |
| **kube-controller-manager** | control plane | A binary bundling dozens of **controllers** (Deployment, ReplicaSet, Job, Node, Namespace, EndpointSlice…). Each one reconciles one kind of object. |
| **cloud-controller-manager** | control plane (cloud) | Talks to the cloud: creates load balancers, labels nodes with zones, removes deleted VMs. |
| **kubelet** | every node | The node agent. Watches for pods bound to *its* node, tells the runtime to start containers, runs probes, reports status back. |
| **container runtime** | every node | containerd / CRI-O pulls images and runs containers (the same OCI images you built with Docker). |
| **kube-proxy / CNI** | every node | Networking: pod IPs (CNI plugin like Flannel, Cilium, Calico) and Service virtual IPs (kube-proxy rules, or Cilium eBPF). |

:::pro title="The hub-and-spoke rule"
Components never call each other. The scheduler doesn't "tell" the kubelet to start a pod — it
writes a field through the API server, and the kubelet, which is *watching*, notices. This
decoupling is why you can replace the scheduler, add your own controllers (operators) and why the
whole system survives partial failures.
:::

:::job title="K3s in production"
Many SaaS teams (especially on Hetzner, bare metal or edge) run **K3s**: a CNCF-certified
Kubernetes distribution shipped as a single binary of well under 100 MB. It bundles containerd, Flannel, CoreDNS, **Traefik** as the
ingress controller, ServiceLB, a local-path storage provisioner and metrics-server. The control
plane can use embedded etcd for HA. Everything you learn here applies unchanged — K3s *is*
Kubernetes, just pre-assembled.
:::

## Desired state and reconciliation

This is the heart of Kubernetes. You never say *"start 3 containers"*. You say
*"there should be 3 replicas of this pod template"* and store that **desired state** in the API.
Controllers then run an endless loop:

```text
        ┌──────────────────────────────────────────────┐
        │                                              │
        ▼                                              │
   OBSERVE actual state ──► DIFF against desired ──► ACT (create / delete / update)
   (watch the API)          (spec vs status/world)    (write to the API)
```

A thermostat is the classic analogy: you set 21 °C (desired). The thermostat measures 19 °C
(actual) and turns the heating on (act). It doesn't remember *why* it's cold — door open, window
open, heater broken — it just keeps driving actual toward desired.

In pseudo-code, every controller looks like this:

```ts
// Pseudo-code of every Kubernetes controller
for (;;) {
  const desired = readSpec()          // what the user asked for
  const actual  = observeWorld()      // what really exists right now
  const actions = diff(desired, actual)
  for (const a of actions) apply(a)   // via the API server — never directly
  waitForNextEventOrResync()
}
```

Three properties make this robust:

1. **Level-triggered, not edge-triggered.** The controller reacts to *the current state*, not to
   "an event happened". If it misses an event (crash, network blip), the next loop still sees the
   gap and fixes it. Delete a pod by hand → the ReplicaSet controller sees 2 ≠ 3 → creates one.
2. **Idempotent.** Running the loop twice with no change does nothing. Applying the same YAML ten
   times is safe.
3. **Composable.** Controllers chain: a Deployment controller creates ReplicaSets; the ReplicaSet
   controller creates Pods; the scheduler binds Pods; the kubelet runs them. Each one only cares
   about its own object.

### `spec` vs `status`

Every object carries both halves of the loop:

```yaml
spec:            # DESIRED — written by you (or your tooling)
  replicas: 3
status:          # ACTUAL — written by controllers, never by you
  replicas: 3
  readyReplicas: 2
  conditions:
    - type: Available
      status: "True"
```

If `status` lags `spec`, a controller is working on it (or failing — and the `conditions` and
**events** tell you why).

## What really happens on `kubectl apply`

Let's trace `kubectl apply -f deployment.yaml` for a Deployment with 3 replicas, step by step. This
is a favourite interview question — and the best debugging map you'll ever have.

```text
 you ─ kubectl apply ─► API server ─► etcd
                          │  (1–3)
     Deployment ctrl ◄────┤ watch → creates ReplicaSet          (4)
     ReplicaSet ctrl ◄────┤ watch → creates 3 Pods (no node)    (5)
     Scheduler       ◄────┤ watch → binds each Pod to a node    (6)
     kubelet (node)  ◄────┤ watch → pulls image, starts         (7)
                          │         containers, runs probes
     kubelet ─────────────► reports Pod status Running/Ready    (8)
     EndpointSlice ctrl ◄─┘ adds ready Pod IPs to Services      (9)
```

1. **kubectl** reads the YAML, figures out the REST endpoint
   (`/apis/apps/v1/namespaces/default/deployments`) from `apiVersion` + `kind`, and sends it
   (client-side or server-side apply).
2. **API server** authenticates you (cert/token: *who are you?*), **authorizes** you (RBAC: *may
   you create deployments here?*), runs **mutating admission** (plugins and webhooks that may change
   the object, e.g. fill in defaults), validates the object against its schema, then runs
   **validating admission** (webhooks and policies such as Pod Security that may only accept or
   reject). Any of these can stop the request with an error — and then nothing is stored.
3. The object is **persisted to etcd**. `kubectl` returns `deployment.apps/web created`.
   *Nothing is running yet!* You only changed desired state.
4. The **Deployment controller** (watching Deployments) sees a new one with no ReplicaSet → creates
   a ReplicaSet with a hash of the pod template in its name.
5. The **ReplicaSet controller** sees desired 3, actual 0 → creates 3 Pod objects. They have no
   `nodeName` yet: they're `Pending`.
6. The **scheduler** sees unscheduled pods, filters nodes (enough free CPU/memory requests? taints?
   affinity?), scores the rest, and **binds** each pod to a node.
7. The **kubelet** on that node sees a pod bound to it → asks containerd to create the pod
   sandbox (network namespace set up by the CNI plugin → the pod gets its IP), pull the image,
   start the containers, and then begins running probes (health checks, lesson ops-12).
8. kubelet writes **status** back: `Running`, and once the readiness probe passes, `Ready=True`.
9. The **EndpointSlice controller** records the pod IPs (each with a `ready` flag) for every
   Service whose selector matches; kube-proxy on each node routes Service traffic only to the
   **ready** ones → traffic starts flowing (details in ops-11).

Every arrow is "write to API → someone watching reacts". When something is stuck, ask *which step
didn't happen?*

| Symptom | Step that didn't happen | Look at |
|---|---|---|
| `apply` printed an error | 2 (authz / admission / validation) | the error text itself |
| No ReplicaSet / no pods at all | 4–5 | `kubectl describe deploy` → Conditions, Events |
| Pods stuck `Pending` | 6 (scheduler found no node) | `kubectl describe pod` → `FailedScheduling` event |
| `ImagePullBackOff` / `ErrImagePull` | 7 (kubelet ↔ registry) | image name/tag, pull secrets |
| `Running` but no traffic | 8–9 (not Ready / not in endpoints) | readiness probe, Service selector |

:::quiz id=ops-09-q1 xp=10
You run `kubectl apply -f deploy.yaml` and the command prints `deployment.apps/api created`.
What is guaranteed to be true **at that moment**?
- [ ] Three containers are running on worker nodes
- [ ] The scheduler has picked nodes for the pods
- [x] The Deployment object is stored in etcd; controllers will now work toward it
- [ ] The image has been pulled on every node
> `apply` only records **desired state**: the API server validated the object and persisted it in
> etcd, then returned. The Deployment controller, ReplicaSet controller, scheduler and kubelets
> react afterwards, asynchronously — so "pods running", "nodes picked" and "image pulled" may all
> still be in the future (or may never happen, if the image doesn't exist). Use
> `kubectl rollout status deployment/api` to wait for the actual state to catch up.
:::

:::quiz id=ops-09-q2 xp=10
Which component decides **which node** a new pod runs on?
- [ ] kubelet
- [ ] kube-controller-manager
- [x] kube-scheduler
- [ ] etcd
> The scheduler watches for pods with an empty `spec.nodeName`, filters and scores nodes, then
> writes the binding through the API server. The kubelet is the tempting answer, but it only
> *runs* pods that were already assigned to its node; the controller-manager creates the Pod
> objects (via the ReplicaSet controller) without choosing a node; etcd just stores data.
:::

:::quiz id=ops-09-q3 xp=15
The API server of a small cluster crashes for 10 minutes. What happens to your **already running**
API pods during that time?
- [x] They keep running and serving traffic; nothing new can be scheduled or changed
- [ ] They are all killed because the kubelet can no longer reach the API server
- [ ] They are restarted on other nodes
- [ ] etcd takes over and keeps reconciling
> The kubelet keeps running what it already knows about, and containers don't need the API server
> to serve requests (kube-proxy's existing routing rules also stay in place). Nothing is killed or
> moved — moving would itself require the API server. But no *changes* can happen: a pod on a node
> that dies won't be replaced, deploys fail, and `kubectl` is unavailable. etcd is only storage;
> it never reconciles anything. That's why production control planes run 3 API servers and
> 3 etcd members.
:::

:::quiz id=ops-09-q4 xp=10
A teammate deletes one of the three pods of a Deployment with `kubectl delete pod api-7d9c-xk2p`.
Why does a new pod appear seconds later?
- [ ] kubectl recreates it automatically
- [x] The ReplicaSet controller observes 2 actual vs 3 desired and creates a replacement
- [ ] The kubelet restarts the deleted pod on the same node
- [ ] Kubernetes keeps a recycle bin of pods
> Level-triggered reconciliation: the controller doesn't care *why* a pod disappeared, it only sees
> "2 exist, 3 wanted". The replacement is a **new** pod (new name, new IP, possibly another node) —
> the kubelet does restart *crashed containers* in place, but it never resurrects a deleted pod.
> To really get rid of pods, change the desired state (`replicas: 0` or delete the Deployment).
:::

## Objects and YAML anatomy

Everything in Kubernetes is an **object** (also called a *resource*) with the same four-part shape:

```yaml
apiVersion: apps/v1          # API group "apps", version "v1" (core group objects use just "v1")
kind: Deployment             # the type
metadata:                    # identity + organisation
  name: api                  # unique per kind per namespace
  namespace: devquest
  labels:
    app.kubernetes.io/name: api
    app.kubernetes.io/part-of: devquest
  annotations:
    team: platform           # free-form, non-identifying metadata
spec:                        # desired state (shape depends on kind)
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/name: api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: api
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/devquest-api:1.4.2
          ports:
            - containerPort: 8080
# status: … filled in by the cluster
```

| `apiVersion` | Kinds you'll use |
|---|---|
| `v1` (core) | Pod, Service, ConfigMap, Secret, Namespace, PersistentVolumeClaim, ServiceAccount |
| `apps/v1` | Deployment, ReplicaSet, StatefulSet, DaemonSet |
| `batch/v1` | Job, CronJob |
| `networking.k8s.io/v1` | Ingress, NetworkPolicy, IngressClass |
| `autoscaling/v2` | HorizontalPodAutoscaler |
| `policy/v1` | PodDisruptionBudget |
| `rbac.authorization.k8s.io/v1` | Role, ClusterRole, RoleBinding, ClusterRoleBinding |
| CRDs | `keda.sh/v1alpha1` ScaledObject, `postgresql.cnpg.io/v1` Cluster, `cert-manager.io/v1` Certificate… |

The last row matters: **CustomResourceDefinitions (CRDs)** let anyone add new kinds. An **operator**
is just a CRD plus a controller that reconciles it — CloudNativePG reconciles `Cluster` objects
into Postgres pods, services, backups and failovers. Same loop, new domain.

:::tip title="Let the cluster teach you"
`kubectl explain deployment.spec.strategy --recursive` prints the schema with docs, straight from
your cluster's API. `kubectl api-resources` lists every kind, its short name (`deploy`, `svc`,
`po`, `cm`), API group, and whether it is namespaced.
:::

:::quiz id=ops-09-q5 xp=15
Which manifest fails when you `kubectl apply` it?

```yaml
# A
apiVersion: v1
kind: Deployment
metadata: { name: web }
spec: { replicas: 2 }
---
# B
apiVersion: apps/v1
kind: Deployment
metadata: { name: web }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers: [{ name: web, image: nginx:1.27-alpine }]
```
- [x] A — `Deployment` lives in the `apps/v1` group, not core `v1`
- [ ] B — it's missing a `status` section
- [ ] Both are fine
- [ ] B — inline `{ }` YAML is not allowed
> A fails with `no matches for kind "Deployment" in version "v1"`: `apiVersion` + `kind` together
> name the type, and the core `v1` group has no Deployment. (Even with the right group, A would
> fail for missing `selector` and `template`.) B is complete: you never write `status` — the
> cluster fills it in — and flow-style YAML (`{ }`, `[ ]`) is perfectly valid YAML, just less
> readable for big objects.
:::

## Namespaces

A **namespace** is a named scope inside one cluster: names must be unique per namespace, and
policies (RBAC, ResourceQuotas, NetworkPolicies, Pod Security labels) attach to it.

```text
cluster
├── kube-system      control-plane add-ons: CoreDNS, kube-proxy, metrics-server…
├── kube-public      readable by all; rarely used
├── kube-node-lease  node heartbeats
├── default          where things land if you forget -n  (avoid in real life)
├── devquest-dev     your app, dev environment
└── devquest-prod    your app, prod environment (or: a separate cluster!)
```

Not everything is namespaced. **Cluster-scoped** objects include `Node`, `Namespace`,
`PersistentVolume`, `StorageClass`, `ClusterRole`, `ClusterRoleBinding`, `IngressClass`,
and CRDs themselves.

:::warn title="A namespace is not a firewall"
By default, a pod in `devquest-dev` can reach a pod in `devquest-prod` over the network. Isolation
comes from **NetworkPolicies**, **RBAC** and **quotas** you add on top (lesson ops-16). Many teams
put prod in its own cluster entirely.
:::

:::quiz id=ops-09-q6 xp=15
Select **all** objects that are **cluster-scoped** (not inside a namespace).
- [x] Node
- [ ] Deployment
- [x] StorageClass
- [x] ClusterRole
- [ ] ConfigMap
- [x] PersistentVolume
> `kubectl api-resources --namespaced=false` lists them. Nodes, StorageClasses, ClusterRoles (the
> name says it) and PersistentVolumes describe the cluster as a whole. Deployments and ConfigMaps
> belong to one app in one namespace. The tricky pair: PersistentVolume*Claims* are namespaced,
> PersistentVolumes are not — the claim is your app's ticket, the volume is a cluster-wide resource.
:::

## Labels, selectors and annotations

**Labels** are key/value pairs used to *select* objects. They are how Kubernetes wires things
together loosely — no object holds a hard pointer to its pods:

```text
 Deployment  selector: app=api ─────┐
 Service     selector: app=api ─────┼──► matches every pod labelled app=api
 NetworkPolicy podSelector: app=api ┘    (wherever and whenever they exist)
```

```bash
kubectl get pods -l app.kubernetes.io/name=api                 # equality
kubectl get pods -l 'environment in (dev,test),tier!=frontend' # set-based
kubectl label pod api-abc123 debug=true                         # add a label
```

Why the indirection? Because pods are replaced all the time (new names, new IPs). If a Service
held a list of pod names it would be stale within minutes. A selector is a *query* — "whatever
currently carries `app=api`" — so new pods are picked up automatically and deleted ones drop out.

**Annotations** are also key/value, but *never* used for selection: build SHAs,
`kubectl.kubernetes.io/last-applied-configuration`, tool configuration
(`cert-manager.io/cluster-issuer`), owner contact. Rule of thumb: *if something should find the
object by it, it's a label; if it's a note for a tool or a human, it's an annotation.*

:::warn title="Common mistake: a typo in one label"
`app: api` on the pods and `app: Api` (or `app.kubernetes.io/name: api`) in the Service selector
do not match — keys and values are compared exactly. Nothing errors; the Service simply has no
endpoints. `kubectl get pods --show-labels` is the first check.
:::

:::pro title="Use the recommended labels"
`app.kubernetes.io/name`, `app.kubernetes.io/instance`, `app.kubernetes.io/version`,
`app.kubernetes.io/component` (`api`, `worker`, `web`), `app.kubernetes.io/part-of` (`devquest`),
`app.kubernetes.io/managed-by` (`Helm`, `kustomize`). Dashboards, Helm and Argo CD all understand
them. Keep selector labels **stable** — a Deployment's `spec.selector` is immutable.
:::

## kubeconfig and contexts

`kubectl` finds clusters through `~/.kube/config` (or `$KUBECONFIG`): a list of **clusters**
(API URL + CA), **users** (credentials) and **contexts** (cluster + user + default namespace).

```bash
kubectl config get-contexts                  # which clusters do I know?
kubectl config use-context kind-devquest     # switch
kubectl config set-context --current --namespace=devquest   # change default namespace
```

:::warn title="The most expensive typo in ops"
Always know which context you're on before `delete`. Put the current context in your shell prompt
(starship, kube-ps1) and give prod contexts an alarming name. Tools like `kubectx`/`kubens` and the
TUI **k9s** make this visible.
:::

## Local clusters: kind vs k3d

| Tool | What it is | Good for |
|---|---|---|
| **kind** | Kubernetes-in-Docker: each node is a Docker container running upstream K8s | Upstream behaviour, CI tests, this course |
| **k3d** | K3s-in-Docker | Mirrors a K3s production setup; ships Traefik + metrics-server out of the box |
| minikube / Docker Desktop K8s / Rancher Desktop | VM or built-in single node | Quick experiments |

This course uses **kind** with one control-plane node and two workers, plus port mappings so an
ingress controller can be reached at `localhost:8080`. A k3d equivalent is shown in the lab.

:::lab id=ops-09-lab1 xp=100
title: Install kubectl + kind and create the DevQuest cluster
You need Docker running (from the Docker lessons). Then:

**1. Install kubectl and kind**

```bash
# macOS
brew install kubectl kind

# Windows (PowerShell)
winget install -e --id Kubernetes.kubectl
winget install -e --id Kubernetes.kind

# Linux (x86_64; on ARM replace amd64/kind-linux-amd64 with arm64) — kubectl
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -m 0755 kubectl /usr/local/bin/kubectl

# Linux — kind (replace the version with the newest from github.com/kubernetes-sigs/kind/releases)
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.30.0/kind-linux-amd64
sudo install -m 0755 kind /usr/local/bin/kind
```

Verify:

```bash
kubectl version --client
kind version
```

**2. Create a cluster config.** Save as `kind-devquest.yaml` in a new folder `k8s-lab/`. We map host
ports 8080/8443 to NodePorts 30080/30443 — the ingress controller will use them in ops-11.
Port mappings can only be set at creation time, so we add them now.

```yaml
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: devquest
nodes:
  - role: control-plane
    extraPortMappings:
      - containerPort: 30080
        hostPort: 8080
        protocol: TCP
      - containerPort: 30443
        hostPort: 8443
        protocol: TCP
  - role: worker
  - role: worker
```

```bash
kind create cluster --config kind-devquest.yaml
```

Expected (abridged):

```text
Creating cluster "devquest" ...
 ✓ Ensuring node image (kindest/node:v1.3x.x) 🖼
 ✓ Preparing nodes 📦 📦 📦
 ✓ Starting control-plane 🕹️
 ✓ Joining worker nodes 🚜
Set kubectl context to "kind-devquest"
```

Two names, one cluster: the **cluster** is called `devquest` (that's what `kind` commands take,
e.g. `kind load … --name devquest`, `kind delete cluster --name devquest`), and kind writes a
kubeconfig **context** called `kind-devquest` (that's what `kubectl config use-context` takes).
The rest of the course says "the `devquest` cluster" and uses each name where its tool expects it.

**3. Explore the cluster**

```bash
kubectl cluster-info
kubectl get nodes -o wide
docker ps --format '{{.Names}}'          # each "node" is a container!
kubectl get pods -n kube-system -o wide   # etcd, apiserver, scheduler, controller-manager, coredns…
kubectl api-resources | head -20
kubectl explain pod.spec.containers.imagePullPolicy
```

`kubectl get nodes` should look like this (versions and ages will differ):

```text
NAME                     STATUS   ROLES           AGE   VERSION
devquest-control-plane   Ready    control-plane   2m    v1.3x.x
devquest-worker          Ready    <none>          2m    v1.3x.x
devquest-worker2         Ready    <none>          2m    v1.3x.x
```

So: `devquest-control-plane`, `devquest-worker`, `devquest-worker2` all `Ready`, and in
`kube-system` pods named `etcd-devquest-control-plane`, `kube-apiserver-…`, `kube-scheduler-…`,
`kube-controller-manager-…` — the control plane itself runs as (static) pods.

**4. Watch reconciliation with your own eyes.** First create a scratch namespace and make it
your default:

```bash
kubectl create namespace playground
kubectl config set-context --current --namespace=playground
```

Now open a second terminal and run `kubectl get pods -n playground -w`. A watch keeps the namespace
it started with, so start it *after* the namespace exists, and pass `-n` so it watches the right
place. Back in the first terminal:

```bash
kubectl create deployment hello --image=nginx:1.27-alpine --replicas=3
kubectl get pods -o wide                       # spread over the workers
kubectl delete "$(kubectl get pods -o name | head -1)"   # e.g. pod "hello-5d8f…-abcde" deleted
kubectl get pods                               # still 3 — one has a younger AGE and a new name
kubectl get events --sort-by=.lastTimestamp | tail -15
```

(`kubectl get pods -o name` prints `pod/<name>`, which `kubectl delete` accepts directly.)

In the events you'll read the chain from this lesson: `ScalingReplicaSet` → `SuccessfulCreate` →
`Scheduled` → `Pulling` → `Pulled` → `Created` → `Started`.

**5. Change desired state, not pods:**

```bash
kubectl scale deployment hello --replicas=0
kubectl get pods            # all gone, and they stay gone
kubectl delete namespace playground
kubectl config set-context --current --namespace=default
```

:::tip title="Prefer k3d / K3s?"
`k3d cluster create devquest --agents 2 -p "8080:80@loadbalancer" -p "8443:443@loadbalancer"` gives
you K3s with Traefik already listening on 8080/8443 and metrics-server installed. The rest of the
course works on both; where commands differ, it's called out.
:::

:::tip title="Quality of life"
`alias k=kubectl`, enable completion (`kubectl completion zsh`), and try **k9s** — a terminal UI
that shows pods, logs and events live.
:::

- [ ] `kubectl get nodes` shows 3 `Ready` nodes in the `kind-devquest` context (cluster `devquest`)
- [ ] I found etcd, kube-apiserver, kube-scheduler and kube-controller-manager pods in `kube-system`
- [ ] I deleted a pod and watched the ReplicaSet create a replacement
- [ ] I scaled to 0 and understood why the pods did not come back
:::

## Code it: a tiny reconcile loop

Controllers are just diff functions. Write the heart of a ReplicaSet controller.

:::challenge id=ops-09-c1 lang=ts xp=50
title: Reconcile replicas like a ReplicaSet
Write `reconcile(desired, pods)` returning `{ create, remove }`:

* **Active** pods are those whose `phase` is `Pending` or `Running` and that are not `deleting`.
  `Failed`/`Succeeded` pods and pods already `deleting` don't count.
* If there are fewer active pods than `desired`, `create` is the missing count and `remove` is `[]`.
* If there are more, `create` is `0` and `remove` lists the **names** of exactly
  `active - desired` pods to delete, **in deletion order** (first to delete first). The order is a
  simplified version of what Kubernetes does: `Pending` before `Running`, then among equal phases
  **not ready** before ready, then **newest** (largest `createdAt`) first.
* If equal: `{ create: 0, remove: [] }`.

Why this order? Removing a pod that isn't serving yet (pending / not ready) costs nothing, and the
newest pod has the least warmed-up caches and is the most likely to be the broken one.

hint: Filter active pods first, then compare `active.length` with `desired`.
hint: Sort a copy with a comparator: phase rank (Pending=0, Running=1), then `ready` (false first), then `createdAt` descending. Take the first `active.length - desired`.

```ts starter
type Pod = { name: string; phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed'; ready: boolean; createdAt: number; deleting?: boolean }

export function reconcile(desired: number, pods: Pod[]): { create: number; remove: string[] } {
  // observe → diff → act
  return { create: desired - pods.length, remove: [] }
}
```

```ts solution
type Pod = { name: string; phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed'; ready: boolean; createdAt: number; deleting?: boolean }

export function reconcile(desired: number, pods: Pod[]): { create: number; remove: string[] } {
  const active = pods.filter((p) => (p.phase === 'Pending' || p.phase === 'Running') && !p.deleting)
  if (active.length < desired) return { create: desired - active.length, remove: [] }
  if (active.length === desired) return { create: 0, remove: [] }
  const rank = (p: Pod) => (p.phase === 'Pending' ? 0 : 1)
  const sorted = [...active].sort(
    (a, b) => rank(a) - rank(b) || Number(a.ready) - Number(b.ready) || b.createdAt - a.createdAt,
  )
  return { create: 0, remove: sorted.slice(0, active.length - desired).map((p) => p.name) }
}
```

```ts tests
const P = (name: string, phase: any, ready: boolean, createdAt: number, deleting = false) => ({ name, phase, ready, createdAt, deleting })

test('creates missing pods', () => {
  expect(reconcile(3, [P('a', 'Running', true, 1)])).toEqual({ create: 2, remove: [] })
})
test('ignores failed, succeeded and deleting pods', () => {
  const pods = [P('a', 'Running', true, 1), P('b', 'Failed', false, 2), P('c', 'Succeeded', false, 3), P('d', 'Running', true, 4, true)]
  expect(reconcile(3, pods)).toEqual({ create: 2, remove: [] })
})
test('steady state does nothing', () => {
  expect(reconcile(2, [P('a', 'Running', true, 1), P('b', 'Pending', false, 2)])).toEqual({ create: 0, remove: [] })
})
test('scale down prefers pending, then not ready, then newest', () => {
  const pods = [
    P('old-ready', 'Running', true, 1),
    P('new-ready', 'Running', true, 9),
    P('not-ready', 'Running', false, 2),
    P('pending', 'Pending', false, 3),
  ]
  expect(reconcile(1, pods)).toEqual({ create: 0, remove: ['pending', 'not-ready', 'new-ready'] })
})
test('scale to zero removes everything active', () => {
  const r = reconcile(0, [P('a', 'Running', true, 1), P('b', 'Running', true, 2)])
  expect(r.create).toBe(0)
  expect(r.remove).toEqual(['b', 'a'])
})
```
:::

:::quiz id=ops-09-q7 xp=15
Your reconcile loop crashes and misses the "pod deleted" event. Why is this **not** a disaster in
Kubernetes' design?
- [ ] etcd replays all missed events in order
- [x] Controllers are level-triggered: on restart they compare current actual state to desired state and fix the gap
- [ ] kubectl retries the delete
- [ ] The kubelet buffers events until the controller is back
> On restart a controller re-lists the objects it cares about and compares them again (it also
> re-syncs periodically). It doesn't need a perfect event history — only the current spec and the
> current world. "etcd replays events" sounds plausible, but etcd keeps only a limited, compacted
> history and controllers deliberately don't depend on it; kubectl and the kubelet don't buffer
> events for controllers either.
:::

:::quiz id=ops-09-q8 xp=10
You want a Service to send traffic to your API pods. On the pod template you add
`team: payments` under `metadata.annotations`, and the Service uses `selector: { team: payments }`.
The Service gets no endpoints. Why?
- [ ] Selectors only work on objects in `kube-system`
- [x] Selectors match **labels**, not annotations — `team: payments` must go under `metadata.labels`
- [ ] Annotations need a `kubectl.kubernetes.io/` prefix to be selectable
- [ ] The Service must be created before the pods
> Labels are the identifying, selectable metadata; annotations are free-form notes for tools and
> humans and are **never** used by selectors, whatever their prefix. Creation order doesn't matter
> either: selectors are evaluated continuously (level-triggered), so pods created earlier or later
> are picked up as soon as their labels match.
:::

:::cards id=ops-09-cards1 xp=15 title="Kubernetes mental model"
Q: What is "desired state"?
A: The `spec` you store in the API (e.g. replicas: 3). Controllers continuously drive actual state toward it.
Q: What is a controller?
A: A loop that watches objects through the API server, diffs desired vs actual, and acts (via the API) to close the gap.
Q: Level-triggered means…
A: React to the current state, not to individual events — missed events don't matter, the next loop sees the gap.
Q: What is a "watch"?
A: A long-lived request to the API server that streams every change to objects of a kind — how controllers and kubelets notice work without polling.
Q: What does etcd store?
A: Every Kubernetes object — the cluster's single source of truth. Back it up.
Q: What does the scheduler actually do?
A: Picks a node for unscheduled pods and writes the binding (spec.nodeName). It starts nothing.
Q: What does the kubelet do?
A: Node agent: runs pods bound to its node via the container runtime, runs probes, reports status.
Q: The four top-level fields of most objects?
A: apiVersion, kind, metadata, spec (+ status, written by the cluster).
Q: Labels vs annotations?
A: Labels identify and are used by selectors. Annotations are non-identifying metadata for tools and humans.
Q: What is an operator?
A: A CRD (new object kind) plus a controller that reconciles it — e.g. CloudNativePG for Postgres.
Q: kind vs k3d?
A: kind = upstream Kubernetes in Docker containers; k3d = K3s in Docker (bundles Traefik, metrics-server).
:::

## Recap

- Orchestration = running containers across many machines with self-healing, scaling, rolling
  updates and service discovery.
- The **API server** is the only door; **etcd** stores everything; the **scheduler** binds pods to
  nodes; **controllers** reconcile; the **kubelet** runs pods on each node.
- You declare **desired state** (`spec`); controllers observe → diff → act until `status` matches.
  Level-triggered loops make the system self-healing.
- `kubectl apply` only writes to etcd — a chain of watchers then creates ReplicaSets, pods,
  bindings, containers and endpoints.
- Objects share `apiVersion/kind/metadata/spec/status`; CRDs + controllers = operators.
- Namespaces scope names and policies but are not network isolation. Labels + selectors are the
  glue between objects.
- You now have a 3-node **kind** cluster with ports 8080/8443 ready for ingress.
