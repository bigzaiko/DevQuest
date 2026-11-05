---
id: ops-13
title: Storage, StatefulSets, Postgres Operators & Jobs
level: advanced
minutes: 95
xp: 180
summary: Volumes, PV/PVC/StorageClass, StatefulSets with stable identity, why self-hosting Postgres is hard, CloudNativePG with WAL archiving and point-in-time recovery, and Jobs/CronJobs for backups.
---

Everything so far was **stateless**: kill an API pod, get a fresh one, nobody cares. Databases,
uploads and queues are different — the data must outlive every pod, node and deploy. This lesson
goes from "where do bytes live?" all the way to running a highly-available PostgreSQL cluster
with continuous backups — the way production SaaS teams on Kubernetes actually do it.

## Volumes: storage attached to a pod

A container's own filesystem is the image plus a thin writable layer — and that layer is thrown
away whenever the container restarts (crash, OOMKill, liveness failure). That's a feature for
stateless apps (every start is clean) and a disaster for anything that must remember. A
**volume** is a directory that is declared in the pod spec and mounted into one or more
containers at a path you choose. The volume *type* decides where the bytes really live and how
long they survive:

| Volume type | Lifetime | Use |
|---|---|---|
| `emptyDir` | As long as the **pod** (survives container restarts) | Scratch space, caches, sharing files between containers. `medium: Memory` = tmpfs |
| `configMap` / `secret` / `projected` | Pod | Config files, certificates, ServiceAccount tokens (ops-12) |
| `hostPath` | The **node** | Node agents only (log collectors). A security risk for apps — avoid |
| `persistentVolumeClaim` | **Independent** of the pod | Databases, uploads — anything you must keep |

```yaml
spec:
  containers:
    - name: api
      volumeMounts:
        - name: tmp
          mountPath: /tmp          # writable /tmp for a readOnlyRootFilesystem container
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 256Mi
```

:::quiz id=ops-13-q1 xp=10
A pod writes uploaded images to an `emptyDir` volume. The Deployment is rolled out to a new
version. What happens to the images?
- [ ] They're copied to the new pods
- [x] They're gone — an emptyDir lives and dies with its pod, and a rollout creates new pods
- [ ] They survive because emptyDir is stored on the node
- [ ] They survive until the node reboots
> emptyDir survives *container* restarts, not pod replacement. "It's stored on the node" is the
> tempting answer — it is, but the kubelet deletes the directory as soon as its pod is gone, and
> the new pods get new, empty emptyDirs (possibly on other nodes). User uploads belong in object
> storage (S3 or an S3-compatible store like SeaweedFS) — or at least a PVC — never in pod-local storage.
:::

## PersistentVolumes, Claims and StorageClasses

Why not just put "an EBS disk with ID vol-0abc" into the pod spec? Because then your manifest
only works on one cloud, in one zone, with one pre-created disk. Kubernetes instead separates
**asking for storage** (the developer's job: "I need 10 Gi, read-write") from **providing it**
(the cluster's job: which driver, which disk type). The same manifest then works on kind, K3s,
AWS or Hetzner:

```text
 Developer                     Cluster                          Infrastructure
 ─────────                     ───────                          ──────────────
 PersistentVolumeClaim  ──►  StorageClass "fast-ssd"  ──►  CSI driver creates a disk
 "10Gi, ReadWriteOnce"        (provisioner, params,         (EBS, Hetzner Volume, Longhorn,
                               reclaimPolicy)                Ceph, local-path…)
        │                                                          │
        └──────────── bound 1:1 ◄──── PersistentVolume ◄───────────┘
                                    (the actual disk, cluster-scoped)
```

* **PersistentVolumeClaim (PVC)** — namespaced request: size, access mode, class. Your pod mounts
  the *claim*.
* **PersistentVolume (PV)** — the actual piece of storage, cluster-scoped. With **dynamic
  provisioning** a PV is created on demand for each claim.
* **StorageClass** — a "catalog entry" that says how to provision: which CSI driver, disk type,
  `reclaimPolicy` (`Delete` the disk with the claim, or `Retain` it), `volumeBindingMode` and
  `allowVolumeExpansion`.

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: uploads
spec:
  accessModes: ["ReadWriteOnce"]
  storageClassName: standard        # kind's default (local-path); K3s calls it "local-path"
  resources:
    requests:
      storage: 5Gi
```

| Access mode | Meaning | Typical backend |
|---|---|---|
| `ReadWriteOnce` (RWO) | Mounted read-write by **one node** | Block disks (EBS, Hetzner, Longhorn) — databases |
| `ReadWriteOncePod` (RWOP) | Exactly one **pod** | Strict single-writer guarantees |
| `ReadOnlyMany` (ROX) | Many nodes, read-only | Shared static assets |
| `ReadWriteMany` (RWX) | Many nodes read-write | NFS, CephFS, EFS, Longhorn RWX — rarely what you really want |

**`volumeBindingMode: WaitForFirstConsumer`** delays creating the disk until a pod using the claim
is scheduled — so the disk is created in the **same zone/node** as the pod. (The alternative,
`Immediate`, may create a disk in zone A while the scheduler later wants the pod in zone B, where
it can never attach.) Until a pod exists the PVC shows `Pending`, which is normal.

**`reclaimPolicy`** decides what happens to the disk when its PVC is deleted. Dynamically
provisioned volumes inherit the class's policy, which is almost always **`Delete`** by default:
delete the PVC (or the namespace!) and the cloud disk is destroyed with it. For important data
use a class with `Retain` or patch the PV
(`kubectl patch pv <name> -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'`) — a retained
PV survives as `Released` and an admin can recover the disk.

:::warn title="local-path storage is node-local"
kind's `standard` and K3s's `local-path` classes create a directory **on one node**. The pod is
pinned to that node forever, and if the node dies, the data is gone. Perfect for labs; for
production use a replicated or network storage CSI driver (Longhorn, Ceph/Rook, Hetzner/EBS/Azure
disks) — or don't store state in the cluster at all.
:::

:::quiz id=ops-13-q2 xp=15
A Deployment with `replicas: 3` mounts one PVC with access mode `ReadWriteOnce`. The scheduler
spreads the pods across 3 nodes. What happens?
- [ ] All 3 pods share the disk safely
- [x] Only pods on the node that has the volume attached can start; the others hang in `ContainerCreating` with a Multi-Attach error (or get pinned to the same node)
- [ ] Kubernetes copies the volume to each node
- [ ] The PVC switches to ReadWriteMany automatically
> RWO = attached to one **node** at a time (several pods on that same node could share it). A
> block disk can't be attached to three machines, and Kubernetes never copies volumes or changes
> a PVC's access mode for you. Even with RWX storage, three Postgres processes writing the same
> data directory would corrupt it. Replicated stateful apps need **one volume per replica** —
> which is exactly what a StatefulSet's `volumeClaimTemplates` gives you.
:::

:::quiz id=ops-13-q8 xp=15
A developer cleans up with `kubectl delete namespace staging`. It contained a Postgres StatefulSet
whose PVCs were dynamically provisioned by a StorageClass with the default `reclaimPolicy`. What
happens to the database disks?
- [ ] They are kept, because StatefulSets never delete their PVCs
- [x] The PVCs are deleted with the namespace, and with `reclaimPolicy: Delete` the PVs and the underlying cloud disks are destroyed too
- [ ] They are kept as `Released` PVs, because PVs are cluster-scoped and survive namespaces
- [ ] Nothing — namespaces with PVCs can't be deleted
> Deleting a namespace deletes **everything in it**, PVCs included — the StatefulSet's "keep PVCs"
> rule only applies to scaling down or deleting the StatefulSet itself. PVs are cluster-scoped, but
> with `Delete` the provisioner removes the PV *and* the disk once the claim is gone. Only
> `Retain` would leave a `Released` PV behind. Protect real data with `Retain`, backups, and RBAC
> that stops people deleting prod namespaces.
:::

## StatefulSets: pets with name tags

A Deployment treats pods as interchangeable "cattle": any replica can serve any request, and a
replacement pod gets a new random name and no memory of the old one. That's wrong for a database
cluster: `pg-0` is the primary *with that particular disk*, and replicas must find it by a name
that never changes. A **StatefulSet** is like a Deployment, but each replica has a **stable
identity** — a fixed ordinal name, its own storage, and its own DNS name — that survives
rescheduling ("pets with name tags"):

| | Deployment | StatefulSet |
|---|---|---|
| Pod names | `api-7d9c4f6b85-xk2pq` (random) | `pg-0`, `pg-1`, `pg-2` (ordinal) |
| Storage | Shared claim or none | **One PVC per pod** from `volumeClaimTemplates` (`data-pg-0`…) — reattached to the same-named pod forever |
| Network identity | Via Service only | Per-pod DNS through a **headless** Service: `pg-0.pg.devquest.svc.cluster.local` |
| Order | All at once | Created 0 → 1 → 2, terminated in reverse (default `OrderedReady`) |
| Updates | Surge-based rolling | One pod at a time, highest ordinal first (`partition` for canaries) |

```yaml
apiVersion: v1
kind: Service
metadata:
  name: pg
spec:
  clusterIP: None              # headless: DNS returns pod IPs, enables pg-0.pg
  selector: { app: pg }
  ports:
    - port: 5432
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: pg
spec:
  serviceName: pg
  replicas: 1
  selector:
    matchLabels: { app: pg }
  template:
    metadata:
      labels: { app: pg }
    spec:
      containers:
        - name: postgres
          image: postgres:18-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom: { secretKeyRef: { name: pg-secret, key: password } }
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql   # postgres:18+ keeps PGDATA in /var/lib/postgresql/18/docker
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 10Gi
```

Three details that matter:

* **`serviceName: pg` + `clusterIP: None`.** A normal Service gives one virtual IP that
  load-balances; a **headless** Service (no cluster IP) makes DNS return the pod IPs directly and
  creates one record per pod, `pg-0.pg`. That is how replicas find "the pod called pg-0".
* **The PVC name** is `<template name>-<pod name>`: `data-pg-0`. Delete `pg-0` and its
  replacement mounts the very same claim.
* **The mount path.** Since the PostgreSQL 18 images, the data directory is
  `/var/lib/postgresql/18/docker` and the volume belongs at `/var/lib/postgresql` (the parent). That
  subdirectory also avoids the classic `initdb: directory exists but is not empty` error caused by
  the `lost+found` folder at the root of a fresh ext4 disk. Older guides (Postgres ≤ 17) mount at
  `/var/lib/postgresql/data` and set `PGDATA` to a subfolder for the same reason.

Scaling down **doesn't delete** the PVCs (data safety) unless you set
`persistentVolumeClaimRetentionPolicy` (`whenScaled` / `whenDeleted`: `Retain` or `Delete`).
Scale back up and `pg-1` finds `data-pg-1` again.

:::quiz id=ops-13-q3 xp=10
You delete pod `pg-1` of a StatefulSet. What comes back?
- [ ] A pod with a random name and a fresh empty volume
- [x] A new pod named `pg-1`, re-attached to the same PVC `data-pg-1`
- [ ] Nothing — StatefulSet pods are not recreated
- [ ] `pg-3`, because ordinals always increase
> Stable identity is the whole point: the StatefulSet controller notices ordinal 1 is missing and
> recreates exactly `pg-1`, with the same DNS record and the same claim `data-pg-1` (the PVC was
> never deleted, so the data is still there). Ordinals are slots `0…replicas-1`, not a counter, so
> there is never a `pg-3` with `replicas: 3`. A random name with an empty volume is what a
> Deployment would do.
:::

## Why running Postgres yourself is hard

That StatefulSet above *runs* Postgres. It is not a production database. Here is what's missing:

| Production need | What it really involves |
|---|---|
| **High availability** | Streaming replicas, detecting primary failure, promoting a replica, repointing clients — without **split brain** (two primaries accepting writes) |
| **Backups** | Consistent base backups *plus* continuous WAL archiving, retention, encryption, off-site copies |
| **Point-in-time recovery** | "Restore to 10:41:59, just before the bad migration" |
| **Upgrades** | Minor versions with a switchover (not a crash); major versions (17 → 18) with `pg_upgrade` or logical replication |
| **Connection pooling** | ASP.NET pods × pool size can exceed `max_connections` — PgBouncer |
| **Monitoring** | Replication lag, WAL archive failures, bloat, connections — alerting on all of it |
| **Storage** | Disk-full handling, volume expansion, I/O performance, node-local disk failure |
| **Fencing & failover tests** | Proving it works *before* the outage |

Your options: a **managed database** (RDS, Azure Flexible Server, Cloud SQL, Neon…) — often the
right answer — or an **operator** that encodes a DBA's runbook into a controller.

## Operators: CloudNativePG

Remember ops-09: *an operator is a CRD plus a controller that reconciles it.* **CloudNativePG
(CNPG)** is the CNCF operator for PostgreSQL. You describe a cluster; it manages pods, PVCs,
replication, services, failover, backups and rolling updates:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg
  namespace: devquest
spec:
  instances: 3                       # 1 primary + 2 streaming replicas
  # imageName: ghcr.io/cloudnative-pg/postgresql:18…   ← pin a version in production
  storage:
    size: 20Gi
    storageClass: fast-ssd
  walStorage:
    size: 5Gi                        # separate WAL volume: a WAL burst can't fill the data disk
  postgresql:
    parameters:
      max_connections: "200"
      shared_buffers: "512MB"
  bootstrap:
    initdb:
      database: app
      owner: app                     # → Secret "pg-app" with username/password/host/uri
  resources:
    requests: { cpu: "1", memory: 2Gi }
    limits: { memory: 2Gi }
  affinity:
    enablePodAntiAffinity: true      # spread instances over nodes
    topologyKey: kubernetes.io/hostname
```

What the operator creates and keeps reconciled:

```text
Cluster pg ──► Pods pg-1 (primary), pg-2, pg-3 (replicas)   + PVCs per instance
           ──► Services  pg-rw  → primary only     (writes: your ASP.NET connection string)
                         pg-ro  → replicas only    (read-only queries, reports)
                         pg-r   → any instance
           ──► Secrets   pg-app (app credentials + uri), CA/TLS certificates
           ──► Failover: primary dies → promote the most advanced replica, move pg-rw, fence the old one
```

Note CNPG manages **pods directly** (no StatefulSet) because it needs finer control over which
instance is primary during updates and failovers.

:::quiz id=ops-13-q4 xp=10
Your ASP.NET API writes and reads orders. Which CNPG Service goes into `ConnectionStrings__Default`?
- [x] `pg-rw` — always points to the current primary
- [ ] `pg-ro` — load-balances over replicas
- [ ] `pg-1` — the first pod
- [ ] `pg-r` — any instance
> Writes must go to the primary, and `pg-rw` follows it through failovers. `pg-1` is tempting
> because it is the primary *today* — but after the first failover the primary is `pg-2` or
> `pg-3` and your writes fail. `pg-ro` and `pg-r` include read-only replicas, which reject writes.
> Point read-heavy, lag-tolerant queries (reports) at `pg-ro` with a second connection string if
> you need to.
:::

### WAL archiving and point-in-time recovery (PITR)

Postgres writes every change to the **Write-Ahead Log (WAL)** before changing data files. Archive
every WAL segment somewhere safe, combine with periodic **base backups**, and you can replay the
database to **any moment** between them:

```text
 base backup Sun 02:00          base backup Mon 02:00
       │                               │
 ──────●───────WAL──WAL──WAL──WAL──────●────WAL──WAL──WAL──WAL──►  object storage (S3 / SeaweedFS / Azure / GCS)
                                                  ▲
                         "restore to Mon 10:41:59" = Mon base backup + replay WAL until 10:41:59
```

* **RPO** (how much data you can lose) ≈ time since the last archived WAL segment — seconds to a
  few minutes (`archive_timeout`).
* **RTO** (how long restore takes) ≈ restore base backup + replay WAL. Test it regularly!

In current CNPG, object-store backups go through the **Barman Cloud plugin** (the older in-tree
`spec.backup.barmanObjectStore` field is deprecated; you'll still see it in existing clusters).
The plugin is installed once per cluster (it needs cert-manager); then:

```yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: s3-backups
  namespace: devquest
spec:
  configuration:
    destinationPath: s3://acme-pg-backups/devquest
    s3Credentials:
      accessKeyId:     { name: s3-creds, key: ACCESS_KEY_ID }
      secretAccessKey: { name: s3-creds, key: ACCESS_SECRET_KEY }
    wal:
      compression: gzip
  retentionPolicy: "30d"
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg
  namespace: devquest
spec:
  instances: 3
  storage: { size: 20Gi }
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true              # continuous WAL archiving to the ObjectStore
      parameters:
        barmanObjectName: s3-backups
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: pg-nightly
  namespace: devquest
spec:
  schedule: "0 0 2 * * *"              # CNPG uses 6 fields: sec min hour dom month dow
  backupOwnerReference: self
  cluster:
    name: pg
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

**Restoring** is declarative too: create a *new* Cluster that bootstraps from the backups and stops
replaying at your target time:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg-restore
  namespace: devquest
spec:
  instances: 3
  storage: { size: 20Gi }
  bootstrap:
    recovery:
      source: origin
      recoveryTarget:
        targetTime: "2026-11-05 10:41:59+00"
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: s3-backups
          serverName: pg                 # the original cluster's name in the bucket
```

:::job title="The restore drill"
Backups you have never restored are a hope, not a plan. Mature teams run a **scheduled restore
drill** (e.g. monthly): bootstrap `pg-restore` from last night's backups in a scratch namespace,
run smoke queries, record how long it took (your real RTO), delete it.
:::

:::quiz id=ops-13-q5 xp=15
At 10:42 a bad migration drops the `invoices` table. You have nightly base backups (02:00) and
continuous WAL archiving. What's the CNPG way to get the data back?
- [ ] `kubectl rollout undo` the Postgres pods
- [ ] Promote a streaming replica — replicas still have the table
- [x] Bootstrap a new Cluster with `bootstrap.recovery` from the object store and `recoveryTarget.targetTime` just before 10:42
- [ ] Restore last night's `pg_dump` — PITR can't go past the last backup
> Replicas replay the DROP within milliseconds, so they lost the table too — replication is not a
> backup. `rollout undo` only changes the pod template (image, config), never the data on disk.
> And PITR *can* go past the last base backup: that is exactly what the archived WAL is for.
> PITR = 02:00 base backup + WAL replayed up to 10:41:59. Then copy the table back (or repoint
> the app) from the restored cluster.
:::

## Jobs and CronJobs

Not everything runs forever. A Deployment restarts a process that exits — even one that exited
successfully, because "exited" is never the goal of a web server. A **Job** is the opposite: it
runs pods **to completion** and considers exit code 0 a success; a failing pod is retried up to a
limit. A **CronJob** creates a new Job on a schedule.

The classic example on a .NET team is the **EF Core migration Job**: run the migrations once,
before the new API version rolls out, instead of letting every API replica race to migrate at
startup. Here the image contains a migration bundle built with `dotnet ef migrations bundle`:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate-1-4-2              # Jobs are immutable — one Job (name) per release
  namespace: devquest
spec:
  backoffLimit: 2                  # at most 3 attempts in total
  activeDeadlineSeconds: 600       # a migration that hangs for 10 min fails the Job
  ttlSecondsAfterFinished: 86400   # garbage-collect the Job and its pod after a day
  template:
    spec:
      restartPolicy: Never         # a failed attempt leaves its pod behind for `kubectl logs`
      containers:
        - name: migrate
          image: ghcr.io/acme/devquest-migrations:1.4.2
          command: ["./efbundle"]  # reads the connection string from config like the app (or pass --connection)
          envFrom:
            - secretRef:
                name: api-secrets  # provides ConnectionStrings__Default (ops-12)
```

```bash
kubectl apply -f migrate-job.yaml
kubectl wait --for=condition=complete job/migrate-1-4-2 --timeout=10m && echo "migrated"
kubectl logs job/migrate-1-4-2
```

| Job field | Meaning |
|---|---|
| `completions` / `parallelism` | How many successful pods are needed / may run at once |
| `backoffLimit` | Retries before the Job is marked failed (default 6) |
| `activeDeadlineSeconds` | Hard timeout for the whole Job |
| `ttlSecondsAfterFinished` | Auto-delete finished Jobs (and their pods) |
| `template.spec.restartPolicy` | Must be `OnFailure` or `Never` (not `Always`) |

| CronJob field | Meaning |
|---|---|
| `schedule` | Standard 5-field cron: `"0 3 * * *"` = 03:00 daily |
| `timeZone` | e.g. `"Europe/Berlin"` — otherwise the controller's zone (usually UTC) |
| `concurrencyPolicy` | `Allow` (default), `Forbid` (skip if previous still runs), `Replace` |
| `startingDeadlineSeconds` | How late a missed run may still start |
| `successfulJobsHistoryLimit` / `failedJobsHistoryLimit` | How many old Jobs to keep |

Typical SaaS Jobs: **EF Core migrations** before a rollout (a Job run by CI/Helm hook/Argo
PreSync), nightly reports, cleanup of expired sessions, and **logical backups** with `pg_dump`.

:::pro title="pg_dump and PITR are complementary"
PITR restores the **whole cluster** to a point in time. A `pg_dump` is a portable, logical copy
you can restore into any Postgres (a laptop, another version, a single table with
`pg_restore -t`). Many teams keep both: PITR for disasters, dumps for "give me last Tuesday's
`customers` table" and for long-term archives. Use a `pg_dump` whose major version is ≥ the
server's.
:::

:::quiz id=ops-13-q6 xp=10
A nightly `pg_dump` CronJob sometimes takes longer than 24 h on a huge DB, and then two dumps run
at once and overload the primary. Which setting fixes the overlap?
- [ ] `restartPolicy: Never`
- [x] `concurrencyPolicy: Forbid`
- [ ] `parallelism: 1`
- [ ] `successfulJobsHistoryLimit: 1`
> `Forbid` skips a scheduled run while the previous Job is still active. `parallelism: 1` is the
> tempting answer, but it limits pods *within* one Job — two separate Jobs would each still run
> one pod. `restartPolicy` only affects retries of a failed pod, and the history limit only
> controls how many *finished* Jobs are kept. (Also consider dumping from a replica via `pg-ro`.)
:::

:::lab id=ops-13-lab1 xp=80
title: PVCs and StatefulSet identity
In your kind cluster:

```bash
kubectl create namespace ops13
kubectl config set-context --current --namespace=ops13
kubectl get storageclass          # standard (default)   rancher.io/local-path   WaitForFirstConsumer
```

Save as `sts.yaml` — each pod appends a line to a file on *its own* volume every time it starts:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: diary
spec:
  clusterIP: None
  selector: { app: diary }
  ports:
    - port: 80
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: diary
spec:
  serviceName: diary
  replicas: 3
  selector:
    matchLabels: { app: diary }
  template:
    metadata:
      labels: { app: diary }
    spec:
      containers:
        - name: diary
          image: busybox:1.37
          command: ["sh", "-c", "echo \"$(hostname) started $(date -u +%T) on $NODE\" >> /data/diary.log; exec sleep 3600000"]
          env:
            - name: NODE
              valueFrom: { fieldRef: { fieldPath: spec.nodeName } }
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 100Mi
```

```bash
kubectl apply -f sts.yaml
kubectl get pods -w                       # diary-0, then diary-1, then diary-2 (ordered)
kubectl get pvc                           # data-diary-0, data-diary-1, data-diary-2 — Bound
kubectl get pv                            # the dynamically provisioned volumes

kubectl delete pod diary-1
kubectl rollout status statefulset diary  # wait for the replacement pod
kubectl get pods                          # diary-1 is back — same name
kubectl exec diary-1 -- cat /data/diary.log   # TWO lines: the data survived the pod

kubectl run dns -it --rm --image=busybox:1.37 --restart=Never -- nslookup diary-0.diary.ops13.svc.cluster.local
kubectl scale statefulset diary --replicas=1
kubectl get pods,pvc                      # pods diary-1/2 gone, PVCs data-diary-1/2 still Bound
kubectl scale statefulset diary --replicas=3
kubectl rollout status statefulset diary  # wait until diary-1 and diary-2 are back
kubectl exec diary-2 -- cat /data/diary.log   # history is back
```

Expected after the pod delete (times and node names differ):

```text
diary-1 started 09:14:02 on devquest-worker2
diary-1 started 09:16:40 on devquest-worker2      ← same node: local-path pinned the PV there
```

`nslookup` answers with one address for `diary-0.diary.ops13.svc.cluster.local` (we use the full
name because BusyBox's `nslookup` handles search domains unreliably; app containers resolve the
short `diary-0.diary` fine); after scaling
back up, `diary-2`'s log also has two lines.

- [ ] Pods started in order and each got its own PVC
- [ ] After deleting `diary-1`, the new pod had the same name and the old data
- [ ] `diary-0.diary` resolved via the headless Service
- [ ] Scaling down kept the PVCs; scaling up reattached them
:::

:::lab id=ops-13-lab2 xp=150
title: CloudNativePG cluster, failover and a pg_dump CronJob
**1. Install the operator** (Helm, as in ops-11; Helm itself is ops-14):

```bash
helm repo add cnpg https://cloudnative-pg.github.io/charts
helm repo update
helm upgrade --install cnpg cnpg/cloudnative-pg --namespace cnpg-system --create-namespace
kubectl -n cnpg-system rollout status deployment/cnpg-cloudnative-pg
kubectl get crd | grep cnpg               # clusters.postgresql.cnpg.io, backups…, scheduledbackups…
```

**2. Create a 3-instance cluster.** Save as `pg.yaml`:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg
  namespace: ops13
spec:
  instances: 3
  storage:
    size: 1Gi
  bootstrap:
    initdb:
      database: app
      owner: app
  resources:
    requests: { cpu: 100m, memory: 512Mi }
    limits: { memory: 512Mi }
```

```bash
kubectl apply -f pg.yaml
kubectl get cluster pg -w           # STATUS → "Cluster in healthy state", READY 3
kubectl get pods -L cnpg.io/instanceRole
kubectl get svc                     # pg-r, pg-ro, pg-rw
kubectl get secret pg-app -o jsonpath='{.data.uri}' | base64 -d; echo
```

**3. Write some data through `pg-rw`:**

```bash
kubectl run psql -it --rm --image=postgres:18-alpine --restart=Never \
  --env="PGPASSWORD=$(kubectl get secret pg-app -o jsonpath='{.data.password}' | base64 -d)" -- \
  psql -h pg-rw -U app -d app -c "CREATE TABLE notes(id serial primary key, body text); INSERT INTO notes(body) VALUES ('hello from k8s');"
```

**4. Kill the primary and watch the operator fail over:**

```bash
PRIMARY=$(kubectl get pods -l cnpg.io/instanceRole=primary -o jsonpath='{.items[0].metadata.name}')
echo "primary is $PRIMARY"
kubectl delete pod $PRIMARY
kubectl get cluster pg -w           # "Failing over" → new PRIMARY column → healthy again
kubectl get pods -L cnpg.io/instanceRole
```

Re-run the `psql` command with `-c "SELECT * FROM notes;"` — the row is there, served by the new
primary through the same `pg-rw` name.

**5. Logical backups with a CronJob.** Save as `pg-dump.yaml`:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pg-backups
  namespace: ops13
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: pg-dump
  namespace: ops13
spec:
  schedule: "0 3 * * *"
  timeZone: "Etc/UTC"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 600
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 3600
      ttlSecondsAfterFinished: 86400
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: dump
              image: postgres:18-alpine
              command: ["sh", "-c"]
              args:
                - |
                  set -eu
                  FILE=/backups/app-$(date -u +%Y%m%dT%H%M%SZ).dump
                  pg_dump --format=custom --no-owner --file="$FILE"
                  echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"
                  ls -1t /backups/*.dump | tail -n +8 | xargs -r rm --
              env:
                - name: PGHOST
                  value: pg-rw
                - name: PGDATABASE
                  valueFrom: { secretKeyRef: { name: pg-app, key: dbname } }
                - name: PGUSER
                  valueFrom: { secretKeyRef: { name: pg-app, key: username } }
                - name: PGPASSWORD
                  valueFrom: { secretKeyRef: { name: pg-app, key: password } }
              volumeMounts:
                - name: backups
                  mountPath: /backups
          volumes:
            - name: backups
              persistentVolumeClaim:
                claimName: pg-backups
```

```bash
kubectl apply -f pg-dump.yaml
kubectl create job --from=cronjob/pg-dump pg-dump-manual     # don't wait until 03:00
kubectl get jobs -w
kubectl logs job/pg-dump-manual                              # wrote /backups/app-…dump (… K)
```

:::tip title="Stretch goal: real WAL archiving"
Deploy SeaweedFS with its S3 gateway in the cluster (its Helm chart, or a single-pod `weed server -s3` Deployment), install the CNPG
Barman Cloud plugin (see the plugin's docs — it needs cert-manager from ops-11), create the
`ObjectStore` and add the `plugins:` block from this lesson to `pg`. Then `kubectl get backups`
after triggering `kubectl cnpg backup pg --method plugin --plugin-name barman-cloud.cloudnative-pg.io`
(with the `cnpg` kubectl plugin; its default `--method barmanObjectStore` fails on a plugin-based
cluster) and try a PITR restore into `pg-restore`.
:::

Keep this namespace if you like — or `kubectl delete namespace ops13` (CNPG stays installed for
later lessons).

- [ ] `kubectl get cluster pg` shows 3 ready instances and the `pg-rw/ro/r` Services exist
- [ ] I deleted the primary; a replica was promoted and my data was still readable via `pg-rw`
- [ ] The manual Job from the CronJob wrote a `.dump` file to the PVC
- [ ] I can explain why replicas are not backups and what PITR needs (base backup + WAL)
:::

## When the whole cluster is gone: cluster-level DR

PITR protects the **data inside Postgres**. A different question comes up in every architecture
review: *what if the cluster itself is lost?* A botched upgrade, a deleted cloud account, a region
outage, or `kubectl delete namespace devquest-prod` in the wrong context (from ops-14 on, each
environment gets its own namespace: `devquest-dev`, `devquest-prod`). Three layers need a
recovery story, and each has its own tool:

| Layer | What's in it | How you get it back |
|---|---|---|
| **Cluster objects** (Deployments, Services, Ingress, ConfigMaps, CRs) | etcd | **Git** first: with GitOps (ops-16) you point Argo CD at a fresh cluster and it re-applies everything. For self-managed control planes, also take **etcd snapshots** (`etcdctl snapshot save`, `k3s etcd-snapshot save`). Managed clusters (EKS/AKS/GKE) back up etcd for you; you can't and needn't touch it |
| **Volumes** (uploads on PVCs, anything not in a database) | Cloud disks behind PVs | **Velero**: backs up selected namespaces' objects *and* snapshots their PVs to object storage, on a schedule; restores into the same or a new cluster |
| **Databases** | Postgres | The database's **own** backups: CNPG base backups + WAL (above). A disk snapshot of a running Postgres is crash-consistent at best and has no PITR |

```bash
# Velero (already installed with a cloud plugin and an object-store bucket):
velero schedule create devquest-daily --schedule "0 3 * * *" \
  --include-namespaces devquest-prod --ttl 720h          # keep 30 days
velero backup get                                        # Completed / PartiallyFailed / Failed
velero restore create --from-backup devquest-daily-20261104030012 \
  --namespace-mappings devquest-prod:devquest-restore    # restore beside prod to inspect it
```

Two things separate teams that recover from teams that *think* they can:

* **Secrets aren't in Git**, so Git alone can't rebuild the cluster. With External Secrets
  (ops-16) the real values live in Vault or the cloud secret store, and a fresh cluster pulls them
  again. Otherwise Velero's backup of the Secret objects is your only copy, and the backup bucket
  becomes as sensitive as the secrets themselves.
* **A restore you haven't rehearsed is a hope, not a plan.** Write down the RPO (how much data you
  may lose: here, WAL archiving gives minutes) and the RTO (how long it may take), then do a game
  day: rebuild into a scratch cluster from Git + Velero + a CNPG recovery, and time it.

:::quiz id=ops-13-q9 xp=15
The `devquest-prod` namespace (API, worker, a CNPG cluster, an uploads PVC) is deleted by
accident. The team has GitOps for all manifests, ESO for secrets, CNPG with WAL archiving, and a
nightly Velero backup of the namespace including PV snapshots. What's the best recovery?
- [ ] Restore everything from last night's Velero backup, including the Postgres volumes
- [x] Let Argo CD re-create the manifests, recover Postgres with CNPG `bootstrap.recovery` from the object store, and restore only the uploads PVC from Velero
- [ ] Recreate the namespace by hand and re-run the EF Core migrations
- [ ] Nothing can be recovered: deleting a namespace deletes its PVs
> Each layer has its best tool. Git (via Argo CD) rebuilds the objects exactly as reviewed, and ESO
> refills the Secrets. CNPG's base backup + WAL restores Postgres to *minutes* before the
> deletion, while a nightly volume snapshot would lose up to a day and capture a database that
> was running mid-write. Velero is the right tool for the uploads PVC, which has no other backup.
> The PVs themselves are gone with `reclaimPolicy: Delete`, which is exactly why the backups live
> *outside* the cluster. Migrations only create an empty schema.
:::

## Code it: plan a point-in-time restore

:::challenge id=ops-13-c1 lang=ts xp=50
title: Which backup do I restore from?
Write `planRestore(backups, walArchivedUntil, target)`. Times are numbers (e.g. epoch minutes).

* `backups` is a list of `{ id, completedAt }` base backups (unsorted).
* WAL is archived continuously from the oldest backup up to `walArchivedUntil`.
* To restore to `target` you need the **latest** base backup with `completedAt <= target`, and WAL
  must cover the target (`target <= walArchivedUntil`).
* Return `{ backupId, replayMinutes }` where `replayMinutes = target - completedAt`, or `null` if
  the target can't be reached.

hint: Filter backups to those completed at or before the target, then pick the max `completedAt`.
hint: Don't forget the two `null` cases: no usable backup, or the target is beyond the archived WAL.

```ts starter
type Backup = { id: string; completedAt: number }

export function planRestore(backups: Backup[], walArchivedUntil: number, target: number) {
  const b = backups[backups.length - 1]
  return { backupId: b.id, replayMinutes: target - b.completedAt }
}
```

```ts solution
type Backup = { id: string; completedAt: number }

export function planRestore(backups: Backup[], walArchivedUntil: number, target: number) {
  if (target > walArchivedUntil) return null
  const usable = backups.filter((b) => b.completedAt <= target)
  if (usable.length === 0) return null
  const best = usable.reduce((a, b) => (b.completedAt > a.completedAt ? b : a))
  return { backupId: best.id, replayMinutes: target - best.completedAt }
}
```

```ts tests
const backups = [
  { id: 'mon', completedAt: 1440 },
  { id: 'sun', completedAt: 0 },
  { id: 'tue', completedAt: 2880 },
]
test('picks the latest backup before the target', () => {
  expect(planRestore(backups, 4000, 2000)).toEqual({ backupId: 'mon', replayMinutes: 560 })
})
test('target exactly at a backup needs no replay', () => {
  expect(planRestore(backups, 4000, 2880)).toEqual({ backupId: 'tue', replayMinutes: 0 })
})
test('works with unsorted input for the newest backup', () => {
  expect(planRestore(backups, 4000, 3999)).toEqual({ backupId: 'tue', replayMinutes: 1119 })
})
test('target before the first backup is impossible', () => {
  expect(planRestore(backups, 4000, -5)).toBeNull()
})
test('target beyond archived WAL is impossible', () => {
  expect(planRestore(backups, 3000, 3500)).toBeNull()
})
```
:::

:::quiz id=ops-13-q7 xp=15
A new CNPG Cluster's PVCs stay `Pending` and the pods stay `Pending` too.
`kubectl describe pvc` says: *no persistent volumes available for this claim and no storage
class is set*. Most likely cause?
- [ ] The operator isn't installed
- [x] The cluster has no **default** StorageClass and the Cluster spec doesn't name one, so nothing can provision the volumes
- [ ] `WaitForFirstConsumer` is broken
- [ ] PVCs only bind after the pod is Running
> Dynamic provisioning needs a StorageClass (`storage.storageClass` or a default class marked with
> `storageclass.kubernetes.io/is-default-class: "true"`). With WaitForFirstConsumer the *message*
> would instead say it's waiting for the first consumer — which is normal.
:::

:::cards id=ops-13-cards1 xp=15 title="Storage & stateful workloads"
Q: emptyDir lifetime?
A: The pod's lifetime — survives container restarts, gone when the pod is deleted/replaced.
Q: PVC vs PV vs StorageClass?
A: PVC = namespaced request; PV = the actual (cluster-scoped) volume; StorageClass = how to provision PVs dynamically.
Q: ReadWriteOnce means?
A: Mountable read-write by a single node at a time.
Q: What does WaitForFirstConsumer do?
A: Delays provisioning until a pod using the claim is scheduled, so the volume lands in the right zone/node.
Q: What does a StatefulSet guarantee?
A: Stable pod names (pg-0…), one PVC per pod from volumeClaimTemplates, per-pod DNS via a headless Service, ordered rollout.
Q: Why use an operator like CloudNativePG?
A: It automates replication, failover, backups, PITR, upgrades and services — a DBA runbook as a controller.
Q: CNPG Services?
A: pg-rw (primary, for writes), pg-ro (replicas), pg-r (any instance).
Q: What does PITR need?
A: A base backup taken before the target time plus continuous WAL archived up to the target.
Q: Are replicas backups?
A: No — they replicate mistakes (DROP TABLE) within milliseconds.
Q: CronJob setting to prevent overlapping runs?
A: concurrencyPolicy: Forbid
Q: How to run a CronJob now?
A: kubectl create job --from=cronjob/<name> <job-name>
Q: What does reclaimPolicy Delete mean?
A: Deleting the PVC also deletes the PV and the real disk. Retain keeps the disk as a Released PV.
Q: Why run EF Core migrations as a Job?
A: Exactly one run before the rollout, with retries, a timeout and logs, instead of every replica racing to migrate at startup.
:::

## Recap

- Container filesystems are ephemeral; **emptyDir** lives with the pod; **PVCs** outlive pods —
  but with `reclaimPolicy: Delete`, deleting the PVC (or its namespace) destroys the disk.
- **PVC → StorageClass → PV**: claims ask, classes provision (CSI), volumes bind. Know RWO vs RWX,
  reclaim policies and `WaitForFirstConsumer`. local-path is node-local — labs only.
- **StatefulSets** give stable names, per-pod PVCs and per-pod DNS via a headless Service.
- Self-hosting Postgres means HA, failover without split brain, backups, PITR, upgrades, pooling and
  monitoring. Use a managed DB or an **operator**.
- **CloudNativePG**: a `Cluster` CR → pods, `pg-rw/ro/r` Services, app Secret, automatic failover;
  Barman Cloud plugin for WAL archiving + base backups; `bootstrap.recovery` for PITR.
- **Jobs** run to completion (EF Core migrations, reports), **CronJobs** schedule them — `Forbid`
  overlaps; `pg_dump` CronJobs complement PITR.
- Cluster DR is layered: **Git** (+ etcd snapshots if you run the control plane) for objects,
  **Velero** for volumes, the database's **own** backups for Postgres. Rehearse restores; know RPO/RTO.
