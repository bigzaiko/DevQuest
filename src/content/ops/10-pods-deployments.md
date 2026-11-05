---
id: ops-10
title: Pods, ReplicaSets & Deployments
level: beginner
minutes: 65
xp: 120
summary: The workload trio — what a pod really is, how Deployments roll out and roll back via ReplicaSets, the kubectl moves you'll use daily, and running your own images in kind.
---

In ops-09 you learned that controllers chase desired state. Now we meet the three objects you will
touch every working day: the **Pod** (what runs), the **ReplicaSet** (how many), and the
**Deployment** (how to change it safely). By the end you will roll out a new version with zero
downtime, break it on purpose, roll it back, and run your own ASP.NET image in the cluster.

## The Pod: the atom of Kubernetes

Why doesn't Kubernetes just schedule containers? Because some helpers must live *right next to*
the app — a proxy that intercepts its traffic, a shipper that reads its log files. If they were
scheduled independently they might land on different machines. The pod is the wrapper that says
"these belong together".

A pod is **one or more containers that are scheduled together onto the same node** and share:

* one **network namespace** → one IP address; containers talk over `localhost`
* **volumes** declared in the pod (each container chooses where to mount them)
* a lifecycle: the pod is created, scheduled and deleted as one unit (individual containers can
  still crash and be restarted inside it)

```text
┌──────────────── Pod  api-7d9c4-xk2p   IP 10.244.1.17 ────────────────┐
│  init: wait-for-db (runs to completion first)                        │
│  ┌──────────────────┐   localhost:8080   ┌────────────────────────┐  │
│  │ api  (ASP.NET)   │ ◄────────────────► │ sidecar (log shipper)  │  │
│  └────────┬─────────┘                    └───────────┬────────────┘  │
│           └──────────── shared volume /var/log/app ──┘               │
└──────────────────────────────────────────────────────────────────────┘
```

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: hello
  labels:
    app.kubernetes.io/name: hello
spec:
  containers:
    - name: web
      image: nginx:1.27-alpine
      ports:
        - containerPort: 80
```

**One main process per container, one app per pod.** Don't put the API and Postgres in one pod —
they scale differently and would be rescheduled together. Multi-container pods are for tightly
coupled helpers:

| Pattern | Example |
|---|---|
| **Init container** | Wait for a dependency, fetch config or certificates, fix volume permissions — must finish before app containers start. **Not** for schema migrations (see below) |
| **Sidecar** (native: an init container with `restartPolicy: Always`, stable since Kubernetes 1.33) | Log shipper, service-mesh proxy, Cloud SQL proxy — starts before the app and runs alongside for the pod's whole life |

```yaml
spec:
  initContainers:
    - name: wait-for-db                  # runs to completion, then the next one starts
      image: busybox:1.37
      command: ["sh", "-c", "until nc -z pg-rw 5432; do echo waiting; sleep 2; done"]
    - name: log-shipper                  # native sidecar: keeps running next to the app
      image: fluent/fluent-bit:4.0
      restartPolicy: Always
  containers:
    - name: api
      image: ghcr.io/acme/devquest-api:1.4.2
```

:::warn title="Don't run migrations in an init container"
It is tempting to put `dotnet DevQuest.Api.dll --migrate-only` into an init container. But an init
container runs in **every** pod, on **every** start: with `replicas: 4` the same migration runs four
times in parallel during a rollout, and again whenever a pod is rescheduled or the HPA adds a
replica. Since EF Core 9, `Database.Migrate()` takes a database lock so concurrent runs don't
corrupt each other, but you still get pods stuck in `Init:0/1` behind the lock, a long migration
that blocks scale-out during an incident, and no single place to see whether the migration
succeeded. The pattern this course uses (and that ops-13, ops-14 and ops-16 build on) is one
Kubernetes **Job** that migrates **once, before the rollout**, run by CI, a Helm `pre-upgrade` hook
or an Argo CD `PreSync` hook, with migrations written expand/contract-style so old and new pods can
share the schema.
:::

### Pods are cattle, not pets

Pods are **ephemeral**. When a node dies, its pods are not "moved" — they are gone, and a
controller creates *new* pods (new name, new IP) elsewhere. So:

* never rely on a pod's IP or name — use Services (ops-11)
* never keep important data in the container filesystem — use volumes / a database (ops-13)
* never create bare pods for real workloads — nothing would replace them

### Pod lifecycle and restarts

| Pod `phase` | Meaning |
|---|---|
| `Pending` | Accepted, but not running yet: waiting for scheduling or pulling images |
| `Running` | Bound to a node, at least one container running (or starting / restarting) |
| `Succeeded` | All containers exited 0 and won't restart (Jobs) |
| `Failed` | All containers terminated, at least one with an error |
| `Unknown` | The node stopped reporting |

Containers inside have their own state: `Waiting` (with a reason like `ContainerCreating`,
`ImagePullBackOff`, `CrashLoopBackOff`), `Running`, `Terminated` (with exit code and reason like
`Completed`, `Error`, `OOMKilled`).

With `restartPolicy: Always` (the default for Deployments), the kubelet restarts a crashed
container **in place** with exponential back-off: 10 s, 20 s, 40 s … capped at 5 min. That waiting
is what `CrashLoopBackOff` means — *"it keeps crashing; I'm waiting before trying again"*.

:::quiz id=ops-10-q1 xp=10
Two containers run in the same pod. The `api` container listens on port 8080. How does the
`sidecar` container reach it?
- [x] `http://localhost:8080` — containers in a pod share one network namespace
- [ ] `http://api:8080` — container names are DNS names
- [ ] Only through a Service
- [ ] They can't; containers in a pod are isolated
> Same pod = same IP and same `localhost`. That's also why two containers in one pod can't both
> listen on the same port. Container names are *not* DNS names; Service names are.
:::

## ReplicaSet: keep N copies alive

A ReplicaSet has three things: a **selector**, a pod **template**, and a **replica count**. Its
controller makes sure exactly N pods matching the selector exist — the loop you coded in ops-09.
Pods it creates carry an `ownerReferences` entry pointing back to it (that's how
`kubectl delete rs` cascades to its pods).

You almost never write a ReplicaSet yourself, because it has one big gap: **it can't change the
pod template safely**. Edit the image in a ReplicaSet and *existing* pods keep the old image; only
new pods get the new one. Enter the Deployment.

## Deployment: versioned, rolling change

A Deployment manages **ReplicaSets**, one per version of the pod template:

```text
Deployment api  (replicas 4, image v2)
   │
   ├── ReplicaSet api-5f8d6c9b7d   ← template hash of v1   replicas 0 → kept for rollback
   │
   └── ReplicaSet api-7d9c4f6b85   ← template hash of v2   replicas 4
          ├── Pod api-7d9c4f6b85-xk2p
          ├── Pod api-7d9c4f6b85-7mzq
          ├── Pod api-7d9c4f6b85-b2lr
          └── Pod api-7d9c4f6b85-9tqv
```

When you change **anything inside `spec.template`** (image, env, resources, labels…), the
Deployment controller hashes the new template, creates a new ReplicaSet, and **gradually** scales
the new one up and the old one down. Changing `spec.replicas` only scales the current ReplicaSet —
no rollout.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app.kubernetes.io/name: api
spec:
  replicas: 4
  revisionHistoryLimit: 5          # old ReplicaSets kept for rollback
  progressDeadlineSeconds: 300     # mark rollout as failed after 5 min without progress
  minReadySeconds: 5               # a new pod must stay Ready 5 s before it counts as available
  selector:
    matchLabels:
      app.kubernetes.io/name: api  # must match the template labels; immutable after creation
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1                  # at most replicas + 1 pods during the rollout
      maxUnavailable: 0            # never go below 4 available pods
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
```

### Rolling update math

* `maxSurge` — how many pods **above** `replicas` may exist during the rollout. Percentages round
  **up**.
* `maxUnavailable` — how many pods **below** `replicas` may be unavailable. Percentages round
  **down**.
* Defaults: `25%` and `25%`. Writing both as a literal `0` is rejected by validation (the rollout
  could never move). If percentages both *round* to 0 (e.g. `maxSurge: 0%`, `maxUnavailable: 10%`
  with 1 replica), the controller uses `maxUnavailable = 1` so the rollout can make progress.

Worked example with the defaults and `replicas: 10`: surge = ⌈2.5⌉ = 3, unavailable = ⌊2.5⌋ = 2,
so during the rollout there are at most 13 pods and at least 8 available.

Rollout of 4 replicas with `maxSurge: 1, maxUnavailable: 0` (old = v1, new = v2):

| Step | v1 pods | v2 pods | Available | Total |
|---|---|---|---|---|
| start | 4 | 0 | 4 | 4 |
| surge one new pod | 4 | 1 (starting) | 4 | 5 |
| it becomes Ready → kill one old | 3 | 1 | 4 | 4 |
| surge again | 3 | 2 (starting) | 4 | 5 |
| … repeat … | 0 | 4 | 4 | 4 |

Capacity never drops — the price is one extra pod's worth of resources. With
`maxSurge: 0, maxUnavailable: 1` you need no spare capacity but run one pod short during the
rollout.

:::warn title="Readiness gates the rollout"
"Available" means **Ready** (for `minReadySeconds`). Without a readiness probe a pod is Ready the
moment its process starts — even if ASP.NET is still warming up or can't reach the database. The
rollout then happily replaces healthy pods with broken ones. Probes are ops-12; until then, know
that they are what makes rolling updates *safe*.
:::

**`Recreate`** strategy kills all old pods first, then starts new ones: downtime, but never two
versions at once. Use it when two versions must not overlap — e.g. a pod with a `ReadWriteOnce`
volume, or a schema migration the old version can't survive.

:::quiz id=ops-10-q2 xp=10
Deployment `api` runs 4 replicas. You run `kubectl scale deployment api --replicas=8`. What happens to ReplicaSets?
- [ ] A new ReplicaSet is created and a rolling update starts
- [x] The current ReplicaSet is scaled to 8; no new revision is created
- [ ] All pods are recreated
- [ ] Nothing until you run `kubectl rollout restart`
> Only changes to `spec.template` create a new ReplicaSet / revision. `replicas` lives *outside*
> the template, so the Deployment controller just raises the current ReplicaSet's count and the
> ReplicaSet controller adds 4 new pods; the existing 4 are untouched. `rollout restart` is a
> different thing: it stamps a timestamp annotation into the template on purpose to force a rollout.
:::

:::quiz id=ops-10-q3 xp=15
A Deployment with 4 replicas, `maxSurge: 1`, `maxUnavailable: 0` is updated to an image tag that
**doesn't exist**. What do users experience?
- [ ] Downtime: all 4 pods are replaced with failing ones
- [x] Nothing: 4 old pods keep serving; one new pod is stuck in `ImagePullBackOff` and the rollout stalls
- [ ] 3 pods serve traffic, one is broken
- [ ] Kubernetes automatically rolls back
> The surge pod never becomes Ready, so no old pod is ever removed (`maxUnavailable: 0`) — users
> keep hitting the 4 healthy v1 pods. "3 serve, one is broken" would be the outcome with
> `maxSurge: 0, maxUnavailable: 1`. After `progressDeadlineSeconds` the Deployment condition
> `Progressing` becomes `False` (`ProgressDeadlineExceeded`) — but Kubernetes does **not** roll back
> by itself. You (or your CD tool) run `kubectl rollout undo`.
:::

## Rollbacks and history

```bash
kubectl rollout status deployment/api          # wait for the rollout (great in CI)
kubectl rollout history deployment/api         # revisions
kubectl rollout history deployment/api --revision=3
kubectl rollout undo deployment/api            # back to the previous revision
kubectl rollout undo deployment/api --to-revision=2
kubectl rollout restart deployment/api         # new pods, same spec (e.g. to pick up a changed Secret)
kubectl rollout pause deployment/api           # batch several edits into one rollout…
kubectl rollout resume deployment/api          # …then release them together
```

A rollback is just *another rollout* — to the old template. The old ReplicaSet is scaled back up
and the current one down, using the same `maxSurge` / `maxUnavailable` rules, and the restored
revision gets a **new** revision number (revision 2 rolled back becomes revision 4). That only
works while the old ReplicaSet still exists, which is what `revisionHistoryLimit` controls.

Set the annotation `kubernetes.io/change-cause` on the Deployment (in the same apply as the
change) to make `history` readable — otherwise the `CHANGE-CAUSE` column shows `<none>`.

:::pro title="Rollback in a GitOps world"
In teams using Argo CD or Flux (ops-16), Git is the source of truth: `kubectl rollout undo` would be
reverted by the next sync. The real rollback is `git revert` of the image-tag bump. Use
`rollout undo` for emergencies, then fix Git.
:::

## Images and `imagePullPolicy`

| Policy | Behaviour |
|---|---|
| `IfNotPresent` | Pull only if the node doesn't have that image yet. **Default** for tagged images. |
| `Always` | Ask the registry every start (cheap if unchanged: only the digest is compared). **Default** if the tag is `:latest` or missing. |
| `Never` | Never pull; fail with `ErrImageNeverPull` if absent. |

:::warn title="Never deploy :latest"
`:latest` is not "the newest" — it's just a default tag name. Two nodes can run different
"latest"s, rollbacks become impossible (the previous spec also said `latest`), and changing the
image in the registry doesn't trigger a rollout because the spec didn't change. Use **immutable
tags** (`1.4.2`, the git SHA as you did in the Docker CI lesson) or even digests
(`image@sha256:…`).
:::

Private registries like GHCR need credentials:

```bash
kubectl create secret docker-registry ghcr \
  --docker-server=ghcr.io --docker-username=<github-user> --docker-password=<PAT with read:packages>
```

```yaml
spec:
  imagePullSecrets:
    - name: ghcr
  containers:
    - name: api
      image: ghcr.io/acme/devquest-api:1.4.2
```

(Or attach it to the namespace's `default` ServiceAccount so every pod gets it.)

Use a token that can **only read packages** (a classic PAT with just `read:packages`, or a
dedicated bot account), never your personal all-powerful token: anyone who can read Secrets in that
namespace can decode it. A password typed on the command line also lands in your shell history —
in real setups the secret is created by CI or an external-secrets operator (ops-16).

:::quiz id=ops-10-q4 xp=10
A container spec says `image: myapp` with no `imagePullPolicy`. What is the effective policy?
- [ ] `IfNotPresent`
- [x] `Always`, because no tag means `:latest`
- [ ] `Never`
- [ ] It's rejected by validation
> No tag = `:latest`, and `:latest` defaults to `Always`. `IfNotPresent` is the tempting answer
> because it's the default for *tagged* images — but "no tag" counts as `latest`. The spec is
> valid; the API server fills in the policy when the object is created. In kind, that means a
> locally loaded image is ignored and the node tries to pull `docker.io/library/myapp:latest` —
> usually `ErrImagePull`. Use a real tag.
:::

## kubectl: the daily moves

| Goal | Command |
|---|---|
| List with details | `kubectl get pods -o wide` · `-A` all namespaces · `-l app.kubernetes.io/name=api` |
| Full object | `kubectl get deploy api -o yaml` |
| Watch | `kubectl get pods -w` |
| **Why is it broken?** | `kubectl describe pod <pod>` → read **Events** at the bottom |
| Logs | `kubectl logs <pod>` · `-f` follow · `-c <container>` · `--previous` (the crashed run!) · `deploy/api` · `-l app=api --all-containers` |
| Shell inside | `kubectl exec -it <pod> -- sh` |
| No shell in image? | `kubectl debug -it <pod> --image=busybox:1.37 --target=api` (ephemeral debug container) |
| Talk to it locally | `kubectl port-forward deploy/api 5000:8080` |
| Apply / preview | `kubectl apply -f k8s/` · `kubectl diff -f k8s/` |
| Delete | `kubectl delete -f k8s/` · `kubectl delete pod <pod>` |
| Recent events | `kubectl get events --sort-by=.lastTimestamp` |
| Quick edit (not for prod) | `kubectl edit deploy api` · `kubectl set image deploy/api api=…:1.4.3` |

:::info title="Imperative vs declarative"
`kubectl create`, `scale`, `set image`, `edit` are **imperative**: handy for exploring, but the
change exists only in the cluster. `kubectl apply -f` with files in Git is **declarative** — the
files are the truth and can be reviewed, diffed and re-applied. Real teams are declarative (and
eventually let a GitOps controller do the applying). `kubectl apply --server-side` lets the API
server track which *manager* owns which field. Flux and Helm 4 use server-side apply by default;
Argo CD can opt in per app (`ServerSideApply=true`).
:::

:::job title="ASP.NET images often have no shell"
Microsoft's `chiseled` / distroless .NET images (which you used for small, secure images in the
Docker lessons) contain no `sh`, so `kubectl exec -- sh` fails with `executable file not found`.
That's a feature. Use `kubectl debug --target=<container>` to attach a toolbox container that
shares the process namespace.
:::

:::lab id=ops-10-lab1 xp=100
title: Roll out, break it, roll back
Use your `devquest` kind cluster from ops-09 (kubectl context `kind-devquest`).

```bash
kubectl create namespace ops10
kubectl config set-context --current --namespace=ops10
```

Save as `web-deploy.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app.kubernetes.io/name: web
  annotations:
    kubernetes.io/change-cause: "nginx 1.27"
spec:
  replicas: 4
  revisionHistoryLimit: 5
  progressDeadlineSeconds: 60
  selector:
    matchLabels:
      app.kubernetes.io/name: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app.kubernetes.io/name: web
    spec:
      containers:
        - name: nginx
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          readinessProbe:
            httpGet:
              path: /
              port: 80
            periodSeconds: 2
```

**1. Deploy and inspect the ownership chain**

```bash
kubectl apply -f web-deploy.yaml
kubectl rollout status deployment/web
kubectl get deploy,rs,pods -l app.kubernetes.io/name=web
kubectl get pod -l app.kubernetes.io/name=web -o jsonpath='{.items[0].metadata.ownerReferences[0].name}{"\n"}'
```

Expected (hashes and ages differ):

```text
NAME                  READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/web   4/4     4            4           20s

NAME                             DESIRED   CURRENT   READY   AGE
replicaset.apps/web-6c9f8d7b54   4         4         4       20s

NAME                       READY   STATUS    RESTARTS   AGE
pod/web-6c9f8d7b54-2xkqv   1/1     Running   0          20s
…three more…
web-6c9f8d7b54
```

The last line is the ReplicaSet name (`web-<pod-template-hash>`) — the pod's owner. Notice the
same hash is the middle part of every pod name.

**2. Roll out a new version.** In a second terminal: `kubectl get pods -w`. Then edit the file:
change the image to `nginx:1.28-alpine` and the change-cause to `"nginx 1.28"`, and apply:

```bash
kubectl apply -f web-deploy.yaml
kubectl rollout status deployment/web
kubectl get rs                     # two ReplicaSets: old at 0, new at 4
```

Watch the pod list: never fewer than 4 Ready, at most 5 pods total.

**3. Break it.** Set the image to `nginx:9.99-does-not-exist`, change-cause `"broken"`, apply:

```bash
kubectl apply -f web-deploy.yaml
kubectl rollout status deployment/web     # hangs, then: error: deployment "web" exceeded its progress deadline
kubectl get pods                          # 4 old Running + 1 ErrImagePull / ImagePullBackOff
kubectl describe pod <the-broken-pod>     # Events: Failed to pull image … not found
```

**4. Roll back**

```bash
kubectl rollout history deployment/web
kubectl rollout undo deployment/web
kubectl rollout status deployment/web
kubectl get deploy web -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'   # nginx:1.28-alpine
```

`rollout history` (before the undo) looks like:

```text
REVISION  CHANGE-CAUSE
1         nginx 1.27
2         nginx 1.28
3         broken
```

After the undo, run `kubectl rollout history deployment/web` again: revision 2 is gone and
reappears as revision **4** — the rollback was a new rollout of the old template. The stuck
broken pod is removed automatically.

Note that `web-deploy.yaml` still says the broken tag — the cluster and your file have **drifted**.
Fix the file back to `1.28` (this is exactly why GitOps teams roll back in Git).

**5. Crash on purpose**

```bash
kubectl run crashy --image=busybox:1.37 --restart=Always -- sh -c 'echo "boom: missing config"; exit 1'
kubectl get pod crashy -w          # Error → CrashLoopBackOff, RESTARTS climbing (Ctrl+C to stop)
kubectl logs crashy --previous     # boom: missing config
kubectl describe pod crashy | grep -A3 "Last State"
kubectl delete pod crashy
```

`kubectl run` creates a **bare pod** (fine for an experiment, never for real workloads). The
`describe` output shows the evidence you'd use on call:

```text
    Last State:     Terminated
      Reason:       Error
      Exit Code:    1
```

Watch the gaps between restarts grow (10 s, 20 s, 40 s…) — that's the back-off.

- [ ] I saw two ReplicaSets after the 1.28 rollout and the pods' ownerReference
- [ ] The broken rollout never took capacity below 4 Ready pods
- [ ] `rollout undo` restored `nginx:1.28-alpine` and I fixed the drift in my file
- [ ] I found the crash reason with `kubectl logs --previous`
:::

## Running your own images in kind

kind nodes are containers with their own containerd — they **can't see your local Docker images**.
Either push to a registry (GHCR, as in the Docker CI lesson) or side-load:

```bash
docker build -t devquest/api:1.0.0 ./backend
kind load docker-image devquest/api:1.0.0 --name devquest   # copies into every node
# k3d equivalent: k3d image import devquest/api:1.0.0 -c devquest
```

Then reference exactly that tag, with `IfNotPresent` (the default for non-latest tags).

:::tip title="If `kind load docker-image` fails"
With Docker's containerd image store (default in recent Docker Desktop) `kind load docker-image`
can fail with a "content digest … not found" error for multi-platform images. The reliable
fallback is to export to a tarball and load that:
`docker save devquest/api:1.0.0 -o api.tar && kind load image-archive api.tar --name devquest`.
:::

:::quiz id=ops-10-q5 xp=15
You loaded `devquest/api:1.0.0` into kind and deployed it, but the pod shows `ErrImagePull` with
*"pull access denied for devquest/api"*. The manifest has `image: devquest/api:1.0.0` and
`imagePullPolicy: Always`. Why?
- [ ] kind can't run .NET images
- [x] `Always` forces a registry pull, which ignores the side-loaded copy and fails because the image isn't in Docker Hub
- [ ] You must restart the kind cluster after loading
- [ ] The tag must be `latest` for local images
> `kind load` put the image into each node's containerd, but `Always` tells the kubelet to ask the
> registry first — and `docker.io/devquest/api` doesn't exist (or is private), so the pull fails
> before the local copy is considered. Restarting the cluster would actually *lose* the loaded
> image, and `latest` would make it worse (it implies `Always`). Side-loaded images only work with
> `IfNotPresent` (or `Never`): remove the `Always`.
:::

:::lab id=ops-10-lab2 xp=80
title: Run your ASP.NET API image in the cluster
Use the API image you built in the Docker lessons. Tag it for this course:

```bash
docker tag <your-api-image> devquest/api:1.0.0
kind load docker-image devquest/api:1.0.0 --name devquest
docker exec devquest-worker crictl images | grep devquest   # it's inside the node now
```

Expected: a line like `docker.io/devquest/api   1.0.0   3f2a…   95MB` — containerd shows the
fully qualified name, which is exactly what the kubelet will look for.

Save as `api-deploy.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app.kubernetes.io/name: api
    app.kubernetes.io/part-of: devquest
spec:
  replicas: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: api
        app.kubernetes.io/part-of: devquest
    spec:
      containers:
        - name: api
          image: devquest/api:1.0.0
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 8080   # .NET 8+ images listen on 8080 by default
          env:
            - name: ASPNETCORE_ENVIRONMENT
              value: Development
```

```bash
kubectl apply -f api-deploy.yaml
kubectl rollout status deployment/api
kubectl port-forward deployment/api 5000:8080
# other terminal:
curl -i http://localhost:5000/          # or any endpoint your API exposes
kubectl logs deployment/api -f          # ASP.NET's "Now listening on: http://[::]:8080"
```

:::tip title="CrashLoopBackOff? Good — practise!"
If your API connects to Postgres on startup, it will crash: there is no database in the cluster
yet. Read `kubectl logs deploy/api --previous`, confirm the cause, and move on — we add Postgres in
ops-13 and connection strings in ops-12. You can still tick the checklist once you've *diagnosed*
the crash.
:::

Clean up when done: `kubectl delete namespace ops10`.

- [ ] My image is visible in a kind node with `crictl images`
- [ ] The API pods are Running, or I diagnosed exactly why they crash from the logs
- [ ] I reached the API through `kubectl port-forward`
:::

## DaemonSets: one pod per node

A Deployment says *"N copies, anywhere"*. Some workloads need *"exactly one copy on every node"*
instead: a log collector reading each node's container logs, a metrics agent for node CPU and
disk, the CNI network plugin, a CSI storage driver. That is a **DaemonSet**. Its controller
watches **nodes**, not a replica count: when a node joins, it gets the pod; when a node leaves, its
pod goes with it.

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-logs
  namespace: observability
spec:
  selector:
    matchLabels: { app.kubernetes.io/name: node-logs }
  updateStrategy:
    type: RollingUpdate
    rollingUpdate: { maxUnavailable: 1 }   # replace one node's agent at a time
  template:
    metadata:
      labels: { app.kubernetes.io/name: node-logs }
    spec:
      tolerations:                         # also run on tainted nodes (ops-15), e.g. control plane
        - operator: Exists
      containers:
        - name: collector
          image: grafana/alloy:v1.10.0
          volumeMounts:
            - { name: varlog, mountPath: /var/log, readOnly: true }
      volumes:
        - name: varlog
          hostPath: { path: /var/log }     # the node's own log directory
```

You will rarely write a DaemonSet for an app: as an app developer you mostly **meet** them, because
the platform runs Alloy or Fluent Bit, node-exporter, kube-proxy and the CNI that way. Two places
they show up in daily work: `kubectl get ds -A` when "logs from node X are missing", and
`kubectl drain --ignore-daemonsets` when a node is taken down for maintenance (ops-15), since a
DaemonSet pod would be recreated on that same node anyway.

:::quiz id=ops-10-q9 xp=10
Your cluster grows from 3 to 5 nodes. A DaemonSet `node-logs` and a Deployment `api` with
`replicas: 3` both exist. What happens?
- [ ] Both get 2 more pods
- [x] `node-logs` gets a pod on each new node (5 total); `api` stays at 3 replicas
- [ ] `api` spreads to 5 replicas; `node-logs` stays at 3
- [ ] Nothing until you run `kubectl rollout restart`
> A DaemonSet's desired count *is* the number of eligible nodes, so its controller adds a pod as
> soon as each node joins. A Deployment's count is `spec.replicas`, which no node event changes;
> only you or an autoscaler (ops-15) changes it. No restart is needed. Both are controllers
> reconciling continuously.
:::

## Working day-to-day with a cluster

The commands above are the foundation. On a real team the **inner loop** (edit code, see it run in
the cluster) is usually wrapped in tools, because typing `docker build && kind load && kubectl
rollout restart` thirty times a day gets old fast:

| Tool | What it does | When teams use it |
|---|---|---|
| **k9s** | Terminal UI over your current context: browse pods, tail logs, `describe`, exec, port-forward, delete with a few keys | Almost everyone, every day. Mind which context is shown in its header |
| **Tilt** / **Skaffold** | Watch your source, rebuild the image, load or push it, re-apply the manifests, stream logs, set up port-forwards. Tilt adds a web dashboard and "live update" (sync changed files into a running container) | Developing a service that only makes sense *inside* the cluster (talks to other services, needs the real ingress) |
| **mirrord** / **Telepresence** | Run the process **on your laptop** (with your debugger attached) while it receives the cluster's traffic, env and DNS as if it were a pod | Debugging an issue that only reproduces against real dependencies in a shared dev cluster |
| **kubectx** / **kubens** | Fast context and namespace switching | Anyone with more than one cluster |
| **stern** | Tail logs from many pods at once by name pattern, colour-coded | Following a request across replicas |

A minimal `Tiltfile` for the DevQuest API:

```text
# Tiltfile (Starlark, a Python dialect)
docker_build('devquest/api', './backend')           # rebuilds on every change under ./backend
k8s_yaml(kustomize('k8s/overlays/dev'))             # same manifests as CI (ops-14)
k8s_resource('api', port_forwards='5000:8080')      # http://localhost:5000 while `tilt up` runs
```

`tilt up` then does the build, `kind load` (Tilt detects kind automatically) and apply on every
save. The point isn't the specific tool: it's that **the manifests your inner loop applies are the
same ones CI and prod use**, so "works on my machine" also covers the YAML.

:::job title="Day one with a team's cluster"
Expect to receive a kubeconfig (or a cloud CLI command that writes one, see the Managed Kubernetes
lesson ops-19), read-only access to prod, and write access to a dev namespace. Before your first
command, check `kubectl config current-context` (or the k9s header). Most "I deleted something in
prod" stories start with the wrong context. Many people colour their shell prompt by context for
this reason.
:::

## Code it: rolling-update fenceposts

:::challenge id=ops-10-c1 lang=ts xp=50
title: maxSurge / maxUnavailable math
Write `rolloutBounds(replicas, maxSurge, maxUnavailable)` returning `{ maxPods, minAvailable }`
the way the Deployment controller computes them.

* Each value is either an integer (`2`) or a percentage string (`'25%'`) of `replicas`.
* `maxSurge` percentages round **up**; `maxUnavailable` percentages round **down**.
* If both resolve to `0`, use `maxUnavailable = 1`.
* `maxPods = replicas + surge`, `minAvailable = replicas - unavailable` (never below 0).

hint: Parse with `typeof v === 'number'` vs `parseInt(v) * replicas / 100` (multiply before dividing, as Kubernetes does, to avoid float drift like `0.07 * 100 = 7.000000000000001`).
hint: `Math.ceil` for surge, `Math.floor` for unavailable — then apply the both-zero rule.

```ts starter
export function rolloutBounds(replicas: number, maxSurge: number | string, maxUnavailable: number | string) {
  const surge = typeof maxSurge === 'number' ? maxSurge : 1
  const unavailable = typeof maxUnavailable === 'number' ? maxUnavailable : 1
  return { maxPods: replicas + surge, minAvailable: replicas - unavailable }
}
```

```ts solution
export function rolloutBounds(replicas: number, maxSurge: number | string, maxUnavailable: number | string) {
  const resolve = (v: number | string, roundUp: boolean) => {
    if (typeof v === 'number') return v
    const raw = (parseInt(v, 10) * replicas) / 100
    return roundUp ? Math.ceil(raw) : Math.floor(raw)
  }
  const surge = resolve(maxSurge, true)
  let unavailable = resolve(maxUnavailable, false)
  if (surge === 0 && unavailable === 0) unavailable = 1
  return { maxPods: replicas + surge, minAvailable: Math.max(0, replicas - unavailable) }
}
```

```ts tests
test('defaults 25%/25% with 10 replicas', () => {
  expect(rolloutBounds(10, '25%', '25%')).toEqual({ maxPods: 13, minAvailable: 8 })
})
test('defaults with 4 replicas', () => {
  expect(rolloutBounds(4, '25%', '25%')).toEqual({ maxPods: 5, minAvailable: 3 })
})
test('integers: surge 2, no unavailability', () => {
  expect(rolloutBounds(3, 2, 0)).toEqual({ maxPods: 5, minAvailable: 3 })
})
test('a single replica with defaults surges first', () => {
  expect(rolloutBounds(1, '25%', '25%')).toEqual({ maxPods: 2, minAvailable: 1 })
})
test('both zero forces maxUnavailable = 1', () => {
  expect(rolloutBounds(1, '0%', '10%')).toEqual({ maxPods: 1, minAvailable: 0 })
})
test('mixed: 30% surge of 5 rounds up, 1 unavailable', () => {
  expect(rolloutBounds(5, '30%', 1)).toEqual({ maxPods: 7, minAvailable: 4 })
})
test('percent math has no float drift', () => {
  expect(rolloutBounds(100, '7%', '29%')).toEqual({ maxPods: 107, minAvailable: 71 })
})
```
:::

:::quiz id=ops-10-q6 xp=15
What happens when you `kubectl apply` a Deployment with this spec?

```yaml
spec:
  replicas: 2
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
        - name: api
          image: devquest/api:1.0.0
```
- [x] The API server rejects it: the selector `app: api` doesn't match the template label `app: backend`
- [ ] It is accepted but creates 0 pods
- [ ] It is accepted; the pods are created but orphaned
- [ ] It is accepted; Kubernetes rewrites the selector to `app: backend`
> Validation error: `selector does not match template labels`. The container name `api` is
> irrelevant — selectors only look at labels. "0 pods" or "orphaned pods" are what you might expect
> if it *were* allowed: the ReplicaSet would create pods it can never count as its own, see "still
> 0 of 2", create more — forever. Kubernetes never rewrites your selector. The selector must match
> the template labels, and it can't be changed after creation.
:::

:::quiz id=ops-10-q7 xp=15
A pod shows `RESTARTS 7` and status `CrashLoopBackOff`. `kubectl logs <pod>` prints nothing
useful. What's the best next step?
- [ ] Delete the Deployment and re-create it
- [x] `kubectl logs <pod> --previous` and `kubectl describe pod <pod>` (Last State: exit code, reason)
- [ ] Increase `replicas`
- [ ] Switch `imagePullPolicy` to `Always`
> The current container may have just restarted and logged nothing yet; `--previous` shows the
> crashed run. `describe` shows the exit code (1 = app error, 137 = SIGKILL, typically `OOMKilled`,
> 139 = segfault) and events. Re-creating the Deployment or adding replicas just produces more
> crashing copies of the same bug, and the pull policy has nothing to do with a container that
> starts and then exits.
:::

:::quiz id=ops-10-q8 xp=15
Starting from a healthy Deployment, which edits **start a new rollout** (new ReplicaSet)? Select
all that apply.
- [x] Changing the container image tag
- [x] Adding an environment variable to the container
- [ ] Changing `spec.replicas` from 4 to 6
- [x] Adding a label under `spec.template.metadata.labels`
- [ ] Changing the `kubernetes.io/change-cause` annotation in the Deployment's own `metadata`
> The rule: anything inside `spec.template` (the pod template) changes its hash → new ReplicaSet
> → rollout. Image, env and template labels are all in the template (you may *add* template labels
> as long as the selector still matches). `replicas` and the Deployment's own `metadata`
> (labels, annotations such as change-cause) live outside the template, so they never roll pods.
:::

:::cards id=ops-10-cards1 xp=15 title="Pods & Deployments"
Q: What do containers in one pod share?
A: Network namespace (one IP, localhost), volumes, and lifecycle/scheduling (same node).
Q: Why not create bare pods?
A: Nothing replaces them when they die or their node fails. Use a controller (Deployment, StatefulSet, Job).
Q: Deployment vs ReplicaSet?
A: A ReplicaSet keeps N identical pods. A Deployment manages ReplicaSets — one per template version — for rolling updates and rollbacks.
Q: What triggers a new rollout?
A: Any change to spec.template (image, env, resources, labels…). Not replicas.
Q: maxSurge / maxUnavailable defaults and rounding?
A: 25% / 25%. Surge rounds up, unavailable rounds down; both 0 → unavailable 1.
Q: What does CrashLoopBackOff mean?
A: The container keeps exiting; the kubelet waits with exponential back-off (up to 5 min) before restarting it again.
Q: Default imagePullPolicy?
A: IfNotPresent for tagged images; Always for :latest or no tag.
Q: How to use a local image in kind?
A: `kind load docker-image name:tag --name <cluster>` and a non-latest tag with IfNotPresent.
Q: Logs of the crashed container?
A: `kubectl logs <pod> --previous`
Q: Why not run EF Core migrations in an init container?
A: It runs in every pod on every start (N replicas race, scale-out waits behind the lock). Use one Job before the rollout.
Q: DaemonSet vs Deployment?
A: DaemonSet = one pod per eligible node (agents, CNI). Deployment = N replicas anywhere.
Q: Debug a pod without a shell?
A: `kubectl debug -it <pod> --image=busybox:1.37 --target=<container>` — an ephemeral debug container sharing the target's process namespace.
:::

## Recap

- A **pod** = co-scheduled containers sharing network and volumes. Ephemeral: new name, new IP
  every time. One app per pod; init containers and sidecars for helpers.
- A **ReplicaSet** keeps N pods matching a selector; a **Deployment** manages ReplicaSets so it
  can roll forward and back.
- Rolling updates are bounded by `maxSurge` (round up) and `maxUnavailable` (round down) and are
  only safe with readiness probes. `Recreate` for workloads that must not overlap.
- `rollout status / history / undo / restart` are your release controls; in GitOps, roll back in Git.
- Use immutable image tags; `:latest` implies `Always` and breaks rollbacks. Private registries need
  `imagePullSecrets`.
- `describe` → Events, `logs --previous`, `debug --target` are your first three debugging moves.
- kind nodes need `kind load docker-image` (or a registry) to see your images.
- Init containers prepare a pod; **schema migrations belong in a Job** that runs once before the
  rollout, not in every replica.
- **DaemonSets** run one pod per node (log and metrics agents, CNI); you mostly meet them, rarely write them.
- Inner-loop tools (k9s, Tilt/Skaffold, mirrord/Telepresence) speed up the edit-run cycle, but apply the
  same manifests CI uses. Always check your current context first.
