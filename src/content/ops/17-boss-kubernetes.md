---
id: ops-17
title: "BOSS FIGHT: Ship DevQuest to Kubernetes"
level: expert
minutes: 210
xp: 300
summary: Deploy the full stack — CloudNativePG Postgres, ASP.NET API, Vite/nginx frontend and a worker — to kind with Traefik ingress, config and secrets, probes, HPA, a backup CronJob and dev/prod Kustomize overlays. Then survive seven troubleshooting phases.
---

Everything from ops-09 to ops-16 comes together here. You'll deploy the **whole DevQuest stack**
the way a production SaaS team would — declaratively, with environments as overlays — then fight
through troubleshooting phases drawn from real incidents. There are no new concepts in this lesson:
only the ones you've learned, combined under pressure.

Budget an afternoon, or two evenings: roughly 90 minutes to get the stack green, an hour for the
seven boss phases, and the rest for the triage challenge and the bonus rounds.

```text
                         http://devquest.localhost:8080
                                     │
                        ┌────────────▼─────────────┐
                        │ Traefik (ingress, ops-11)│
                        └──────┬─────────────┬─────┘
                        /api   │             │  /
                   ┌───────────▼──┐      ┌───▼──────────┐
 HPA 1–6 (ops-15) ►│ api  ×N      │      │ web ×1–2     │  nginx-unprivileged serving the Vite build
 probes (ops-12)   │ ASP.NET :8080│      │ :8080        │
                   └──────┬───────┘      └──────────────┘
                          │ Host=pg-rw
 worker (KEDA bonus) ─────┤
                   ┌──────▼──────────────────┐     ┌──────────────────────────┐
                   │ CNPG Cluster "pg"       │◄────│ CronJob pg-dump (ops-13) │──► PVC pg-backups
                   │ pg-rw / pg-ro / pg-app  │     └──────────────────────────┘
                   └─────────────────────────┘
 config: ConfigMap api-config (hash-suffixed) · Secret api-secrets · Secret pg-app (from CNPG)
 environments: overlays/dev (applied to kind) · overlays/prod (rendered + reviewed)
```

## Pre-flight check

| Requirement | From | Check |
|---|---|---|
| `devquest` kind cluster (context `kind-devquest`) with ports 8080/8443 | ops-09 | `kubectl config current-context` → `kind-devquest`; `kubectl get nodes` → 3 Ready |
| Traefik as ingress controller | ops-11 | `kubectl get ingressclass` → `traefik` |
| metrics-server | ops-12 | `kubectl top nodes` shows numbers |
| CloudNativePG operator | ops-13 | `kubectl get crd clusters.postgresql.cnpg.io` |
| KEDA (bonus only) | ops-15 | `kubectl get crd scaledobjects.keda.sh` |
| No Argo CD Application targets `devquest-dev` | ops-16 | `kubectl -n argocd get applications` (delete `devquest-dev` if listed) |
| Your images | Docker lessons | see below |

**Images.** The manifests expect three images, all tagged `1.0.0`:

* `devquest/api` — ASP.NET Core 10, listens on **8080**, non-root (UID 1654), serves `/live` and
  `/ready` (ops-12), reads `ConnectionStrings__Default`, and maps its endpoints **under `/api`**
  (e.g. `var api = app.MapGroup("/api");`) — the Ingress below forwards the path unchanged. If
  your routes have no prefix, add the strip-prefix Middleware from ops-11 instead.
* `devquest/web` — the Vite build served by **nginx-unprivileged** on **8080** with SPA fallback.
* `devquest/worker` — your background worker (or the API image with a worker entrypoint).

```bash
docker tag <your-api-image>    devquest/api:1.0.0
docker tag <your-web-image>    devquest/web:1.0.0
docker tag <your-worker-image> devquest/worker:1.0.0
kind load docker-image devquest/api:1.0.0 devquest/web:1.0.0 devquest/worker:1.0.0 --name devquest
```

No images of your own yet? The lab includes a **stand-ins** Kustomize component that swaps in
`traefik/whoami`, `nginx-unprivileged` and `busybox` so you can still beat the boss — and swap
your real images in later.

:::job title="This is what a deploy repo looks like on day one"
At most SaaS companies you'll find almost exactly this layout — `base/`, `overlays/<env>/`,
sometimes `components/` — in a separate "deploy" or "gitops" repo. Your first tasks are usually
small diffs against it: add an env var to the ConfigMap generator, bump a resource request, add a
new key to the ExternalSecret *before* the code that reads it ships. Reviewers will expect the
rendered diff (`kubectl kustomize` or Argo CD's diff view) in your PR description, not just the
patch.
:::

:::lab id=ops-17-lab1 xp=400
title: Deploy the full DevQuest stack with Kustomize
Create this layout in a folder `devquest-k8s/` (ideally a Git repo — you'll point Argo CD at it in
the bonus round):

```text
devquest-k8s/
├── base/
│   ├── kustomization.yaml
│   ├── postgres.yaml
│   ├── api.yaml
│   ├── worker.yaml
│   ├── web.yaml
│   ├── ingress.yaml
│   ├── hpa.yaml
│   └── backup.yaml
├── components/
│   └── stand-ins/kustomization.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── namespace.yaml
    └── prod/
        ├── kustomization.yaml
        ├── namespace.yaml
        ├── external-secret.yaml
        └── pg-backup.yaml
```

### Base

`base/postgres.yaml` — a CNPG cluster; the operator creates `pg-rw` and the `pg-app` Secret:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: pg
spec:
  instances: 1
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

`base/api.yaml` — note: **no `replicas`** (the HPA owns it), env var **order** (`DB_USER` and
`DB_PASSWORD` must come before the connection string that references them — Kubernetes expands
`$(VAR)` only for variables defined earlier in the list), three probes (startup gives .NET time to
boot, liveness restarts a hung process, readiness gates traffic), a `preStop` sleep so in-flight
requests finish during rollouts, hardening and a PDB:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  labels:
    app.kubernetes.io/name: api
    app.kubernetes.io/component: api
spec:
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app.kubernetes.io/name: api
  template:
    metadata:
      labels:
        app.kubernetes.io/name: api
        app.kubernetes.io/component: api
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1654
        seccompProfile: { type: RuntimeDefault }
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                topologyKey: kubernetes.io/hostname
                labelSelector:
                  matchLabels: { app.kubernetes.io/name: api }
      containers:
        - name: api
          image: devquest/api
          ports:
            - name: http
              containerPort: 8080
          envFrom:
            - configMapRef: { name: api-config }
            - secretRef: { name: api-secrets }
          env:
            - name: DB_USER
              valueFrom: { secretKeyRef: { name: pg-app, key: username } }
            - name: DB_PASSWORD
              valueFrom: { secretKeyRef: { name: pg-app, key: password } }
            - name: ConnectionStrings__Default     # rename to the key your app reads
              value: "Host=pg-rw;Port=5432;Database=app;Username=$(DB_USER);Password=$(DB_PASSWORD)"
          startupProbe:
            httpGet: { path: /live, port: http }
            periodSeconds: 2
            failureThreshold: 30
          livenessProbe:
            httpGet: { path: /live, port: http }
            periodSeconds: 10
            timeoutSeconds: 2
          readinessProbe:
            httpGet: { path: /ready, port: http }
            periodSeconds: 5
            timeoutSeconds: 2
            failureThreshold: 2
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits: { memory: 256Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector: { app.kubernetes.io/name: api }
  ports:
    - { name: http, port: 80, targetPort: http }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: api
spec:
  maxUnavailable: 1
  selector:
    matchLabels: { app.kubernetes.io/name: api }
```

`base/worker.yaml` — same DB wiring, no Service; *prefers* the worker node you labelled in ops-15:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  labels:
    app.kubernetes.io/name: worker
    app.kubernetes.io/component: worker
spec:
  replicas: 1
  selector:
    matchLabels: { app.kubernetes.io/name: worker }
  template:
    metadata:
      labels:
        app.kubernetes.io/name: worker
        app.kubernetes.io/component: worker
    spec:
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 60          # let the current job finish
      securityContext:
        runAsNonRoot: true
        runAsUser: 1654
        seccompProfile: { type: RuntimeDefault }
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 50
              preference:
                matchExpressions:
                  - { key: workload, operator: In, values: [worker] }
      containers:
        - name: worker
          image: devquest/worker
          envFrom:
            - configMapRef: { name: api-config }
            - secretRef: { name: api-secrets }
          env:
            - name: DB_USER
              valueFrom: { secretKeyRef: { name: pg-app, key: username } }
            - name: DB_PASSWORD
              valueFrom: { secretKeyRef: { name: pg-app, key: password } }
            - name: ConnectionStrings__Default
              value: "Host=pg-rw;Port=5432;Database=app;Username=$(DB_USER);Password=$(DB_PASSWORD)"
          resources:
            requests: { cpu: 50m, memory: 128Mi }
            limits: { memory: 256Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: {}
```

`base/web.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  labels:
    app.kubernetes.io/name: web
    app.kubernetes.io/component: web
spec:
  replicas: 2
  selector:
    matchLabels: { app.kubernetes.io/name: web }
  template:
    metadata:
      labels:
        app.kubernetes.io/name: web
        app.kubernetes.io/component: web
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: web
          image: devquest/web
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /, port: http }
            periodSeconds: 15
          lifecycle:
            preStop:
              sleep: { seconds: 5 }
          resources:
            requests: { cpu: 20m, memory: 32Mi }
            limits: { memory: 64Mi }
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: ["ALL"] }
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app.kubernetes.io/name: web }
  ports:
    - { name: http, port: 80, targetPort: http }
```

`base/ingress.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: devquest
spec:
  ingressClassName: traefik
  rules:
    - host: devquest.localhost
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service: { name: api, port: { name: http } }
          - path: /
            pathType: Prefix
            backend:
              service: { name: web, port: { name: http } }
```

`base/hpa.yaml`:

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
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 120
```

`base/backup.yaml` — nightly logical backup. Two traps are designed out here: `pg_dump`'s major
version must be **≥ the server's** (hence `postgres:18-alpine` for a PostgreSQL 18 cluster), and
the pod is hardened like the others, because the prod namespace enforces `restricted` and would
otherwise silently refuse to create the Job's pod at 3 a.m.:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pg-backups
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
          automountServiceAccountToken: false
          securityContext:                   # prod enforces "restricted" — Jobs are pods too
            runAsNonRoot: true
            runAsUser: 70                    # the "postgres" user in the alpine image
            runAsGroup: 70
            fsGroup: 70
            seccompProfile: { type: RuntimeDefault }
          containers:
            - name: dump
              image: postgres:18-alpine
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities: { drop: ["ALL"] }
              command: ["sh", "-c"]
              args:
                - |
                  set -eu
                  FILE=/backups/app-$(date -u +%Y%m%dT%H%M%SZ).dump
                  pg_dump --format=custom --no-owner --file="$FILE"
                  echo "wrote $FILE ($(du -h "$FILE" | cut -f1))"
                  ls -1t /backups/*.dump | tail -n +8 | xargs -r rm --
              env:
                - { name: PGHOST, value: pg-rw }
                - name: PGDATABASE
                  valueFrom: { secretKeyRef: { name: pg-app, key: dbname } }
                - name: PGUSER
                  valueFrom: { secretKeyRef: { name: pg-app, key: username } }
                - name: PGPASSWORD
                  valueFrom: { secretKeyRef: { name: pg-app, key: password } }
              volumeMounts:
                - { name: backups, mountPath: /backups }
          volumes:
            - name: backups
              persistentVolumeClaim:
                claimName: pg-backups
```

`base/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
labels:
  - pairs:
      app.kubernetes.io/part-of: devquest
    includeSelectors: false
resources:
  - postgres.yaml
  - api.yaml
  - worker.yaml
  - web.yaml
  - ingress.yaml
  - hpa.yaml
  - backup.yaml
configMapGenerator:
  - name: api-config
    literals:
      - ASPNETCORE_ENVIRONMENT=Production
      - Logging__LogLevel__Default=Information
```

### Stand-ins component (only if you lack images)

`components/stand-ins/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
images:
  - { name: devquest/api, newName: traefik/whoami, newTag: v1.10 }
  - { name: devquest/web, newName: nginxinc/nginx-unprivileged, newTag: 1.29-alpine }
  - { name: devquest/worker, newName: busybox, newTag: "1.37" }
patches:
  - target: { kind: Deployment, name: api }
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/args
        value: ["--port", "8080"]
  - target: { kind: Deployment, name: worker }
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/command
        value: ["sh", "-c", "echo worker up; exec sleep 3600000"]
```

### Dev overlay (applied to kind)

`overlays/dev/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: devquest-dev
  labels:
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/warn: restricted
```

`overlays/dev/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: devquest-dev
resources:
  - namespace.yaml
  - ../../base
# components:
#   - ../../components/stand-ins      # uncomment if you don't have your own images yet
images:
  - { name: devquest/api, newTag: "1.0.0" }
  - { name: devquest/web, newTag: "1.0.0" }
  - { name: devquest/worker, newTag: "1.0.0" }
configMapGenerator:
  - name: api-config
    behavior: merge
    literals:
      - ASPNETCORE_ENVIRONMENT=Development
      - Logging__LogLevel__Default=Debug
secretGenerator:
  - name: api-secrets                  # dev-only value; prod uses External Secrets
    literals:
      - Jwt__SigningKey=dev-only-signing-key-not-for-production-0123456789
patches:
  - target: { kind: HorizontalPodAutoscaler, name: api }
    patch: |-
      - op: replace
        path: /spec/minReplicas
        value: 1
  - target: { kind: Deployment, name: web }
    patch: |-
      - op: replace
        path: /spec/replicas
        value: 1
```

### Prod overlay (rendered and reviewed, not applied locally)

`overlays/prod/namespace.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: devquest-prod
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
```

`overlays/prod/external-secret.yaml`:

```yaml
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: api-secrets
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: ClusterSecretStore, name: vault }
  target: { name: api-secrets, creationPolicy: Owner }
  data:
    - secretKey: Jwt__SigningKey
      remoteRef: { key: devquest/prod/jwt, property: signing_key }
```

`overlays/prod/pg-backup.yaml` — PITR via the Barman Cloud plugin (ops-13):

```yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: s3-backups
spec:
  configuration:
    destinationPath: s3://acme-pg-backups/devquest-prod
    s3Credentials:
      accessKeyId: { name: s3-creds, key: ACCESS_KEY_ID }
      secretAccessKey: { name: s3-creds, key: ACCESS_SECRET_KEY }
    wal:
      compression: gzip
  retentionPolicy: "30d"
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: pg-nightly
spec:
  schedule: "0 0 2 * * *"
  backupOwnerReference: self
  cluster:
    name: pg
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

`overlays/prod/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: devquest-prod
resources:
  - namespace.yaml
  - ../../base
  - external-secret.yaml
  - pg-backup.yaml
images:
  - { name: devquest/api, newName: ghcr.io/acme/devquest-api, newTag: "1.4.2" }
  - { name: devquest/web, newName: ghcr.io/acme/devquest-web, newTag: "1.4.2" }
  - { name: devquest/worker, newName: ghcr.io/acme/devquest-worker, newTag: "1.4.2" }
patches:
  - target: { kind: Cluster, name: pg }
    patch: |-
      - op: replace
        path: /spec/instances
        value: 3
      - op: replace
        path: /spec/storage/size
        value: 20Gi
      - op: add
        path: /spec/plugins
        value:
          - name: barman-cloud.cloudnative-pg.io
            isWALArchiver: true
            parameters:
              barmanObjectName: s3-backups
  - target: { kind: HorizontalPodAutoscaler, name: api }
    patch: |-
      - op: replace
        path: /spec/minReplicas
        value: 3
      - op: replace
        path: /spec/maxReplicas
        value: 20
  - target: { kind: Deployment, name: api }
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/resources
        value:
          requests: { cpu: 500m, memory: 512Mi }
          limits: { memory: 512Mi }
  - target: { kind: Ingress, name: devquest }
    patch: |-
      - op: replace
        path: /spec/rules/0/host
        value: app.example.com
      - op: add
        path: /spec/tls
        value:
          - hosts: [app.example.com]
            secretName: devquest-tls
      - op: add
        path: /metadata/annotations
        value:
          cert-manager.io/cluster-issuer: letsencrypt-prod
```

Read the prod overlay as a list of *differences*, each with a reason: more Postgres instances (a
primary plus two replicas for failover), WAL archiving (point-in-time recovery, not just nightly
dumps), a higher HPA floor (survive a node loss without a cold start), bigger requests (real
traffic), TLS and a real host, External Secrets instead of a generated dev secret, and
`restricted` Pod Security. Anything that differs between environments *without* a reason is
configuration drift waiting to bite.

:::pro title="Things seniors check before the first prod sync"
* **ASP.NET Core Data Protection.** With several API replicas and a read-only filesystem, each pod
  generates its own in-memory key ring — cookies, antiforgery tokens and anything protected by one
  pod can't be read by another, and all of it breaks on every restart. Persist the keys to a shared
  store (`PersistKeysToDbContext`, Redis, or Azure Blob/AWS) if you use those features.
* **Connection limits.** HPA max 20 × Npgsql's default pool of 100 = 2 000 possible connections
  against Postgres' default `max_connections` of 100. Cap `Maximum Pool Size` or put PgBouncer
  (CNPG's `Pooler`) in front.
* **Migrations** run once, as a Job or Argo `PreSync` hook — not in `Program.cs` of every replica
  racing each other at startup.
:::

### Fight!

**1. Render and review both environments**

```bash
cd devquest-k8s
kubectl kustomize overlays/dev | less
kubectl kustomize overlays/prod > rendered-prod.yaml && echo "prod renders"
diff <(kubectl kustomize overlays/dev) <(kubectl kustomize overlays/prod) | less
```

**2. Deploy dev**

```bash
kubectl apply -k overlays/dev
kubectl -n devquest-dev get cluster pg -w          # wait for "Cluster in healthy state"
kubectl -n devquest-dev get pods -w                 # api/web/worker become Ready once pg-app exists
kubectl -n devquest-dev get deploy,svc,ingress,hpa,cronjob,pvc
```

If pods sit in `CreateContainerConfigError` for a minute, that's expected: `pg-app` only exists
once CNPG has bootstrapped the database. They recover on their own — reconciliation at work.

**3. Prove the routing and wiring**

```bash
curl -s -H "Host: devquest.localhost" http://127.0.0.1:8080/ | head -5         # your SPA's index.html (<!doctype html>…)
curl -s -H "Host: devquest.localhost" http://127.0.0.1:8080/api/<an-endpoint>  # JSON from your API
# stand-ins: whoami answers any path with "Hostname: api-…", "GET /api/… HTTP/1.1", headers
kubectl -n devquest-dev set env deploy/api --list --resolve | grep -E "ASPNETCORE|Jwt|ConnectionStrings"
kubectl -n devquest-dev logs deploy/api | head -20
```

Open `http://devquest.localhost:8080/` in a browser and use a feature that hits the database.

**4. Resilience: readiness vs liveness.** Terminal A:
`kubectl -n devquest-dev get pods -l app.kubernetes.io/name=api -w`. Terminal B:

```bash
kubectl -n devquest-dev delete pod pg-1
```

With your real API, the API pods go `0/1` READY (`/ready` checks the DB) and come back when CNPG
has restarted the instance — with **RESTARTS still 0**. (Stand-ins don't check the DB, so they stay
Ready; that's exactly the difference a real `/ready` makes.)

While they are unready, every `/api/…` route fails at Traefik (a `503` with the Helm chart's
defaults), not only the ones that use the database: all API replicas left the endpoints at once.
That is the shared-dependency trap from ops-12. Here, with a single dev database, it's the point
of the exercise; in production you'd decide knowingly (per-instance readiness checks, the DB
reported as `Degraded`, or a tolerant `failureThreshold`).

**5. Zero-downtime rollout.** Start a request loop, then roll out (a new tag of your API, or
simply `kubectl rollout restart`):

```bash
for i in $(seq 1 300); do curl -s -o /dev/null -w "%{http_code}\n" -H "Host: devquest.localhost" http://127.0.0.1:8080/api/<an-endpoint>; sleep 0.1; done | sort | uniq -c &
kubectl -n devquest-dev rollout restart deploy/api
kubectl -n devquest-dev rollout status deploy/api
wait     # prints e.g. "300 200" — no 502/503
```

**6. Autoscaling**

```bash
kubectl -n devquest-dev get hpa api                       # TARGETS cpu: 3%/70%, not <unknown>
kubectl -n devquest-dev patch hpa api --type=merge -p '{"spec":{"metrics":[{"type":"Resource","resource":{"name":"cpu","target":{"type":"Utilization","averageUtilization":5}}}]}}'
kubectl -n devquest-dev run load -it --rm --image=busybox:1.37 --restart=Never -- \
  sh -c "while true; do wget -q -O /dev/null http://api/<an-endpoint>; done"
# other terminal: kubectl -n devquest-dev get hpa api -w   → replicas climb toward 6
```

Afterwards re-apply `kubectl apply -k overlays/dev` — your files are the truth, so the target goes
back to 70 %.

**7. Backup**

```bash
kubectl -n devquest-dev create job --from=cronjob/pg-dump pg-dump-now
kubectl -n devquest-dev logs -f job/pg-dump-now      # wrote /backups/app-…dump
```

### Bonus rounds (extra glory, same XP)

* **KEDA worker**: add a `ScaledObject` (postgresql trigger on your jobs table) for `worker` in the
  dev overlay and remove its `replicas`. The KEDA operator runs in namespace `keda`, so use the
  FQDN `pg-rw.devquest-dev.svc.cluster.local` as `host`, plus `port: "5432"`, `userName: app`,
  `dbName: app`, `sslmode: require`, and a TriggerAuthentication mapping `password` from `pg-app`.
* **NetworkPolicies**: default-deny + allow-dns + Traefik → web/api (pod port **8080**) + api/worker
  → `cnpg.io/cluster: pg` on 5432 + CNPG operator → pg (8000, 5432) + pg ↔ pg. Prove the backup Job
  still works (it needs egress to pg too!).
* **GitOps**: push `devquest-k8s` to GitHub and create an Argo CD Application for `overlays/dev`
  (ops-16 lab 3). Then roll out by commit only.
* **Alerting**: if you kept kube-prometheus-stack from ops-16 lab 4, add the crash-loop
  `PrometheusRule` for `devquest-dev` (label `release: kube-prometheus-stack`) and re-run phase 1's
  bug on purpose: the alert should fire before you'd have noticed. With the NetworkPolicies bonus,
  remember the ingress allow from `monitoring` for anything Prometheus scrapes.
* **CI gates**: run `kubectl kustomize overlays/prod | kubeconform -strict -summary` (with the CRD
  schema location from ops-14) and fix whatever it finds in the CNPG and ExternalSecret objects.

- [ ] `kubectl kustomize` renders both `overlays/dev` and `overlays/prod` without errors, and I reviewed the diff
- [ ] Every pod in `devquest-dev` is Running and Ready, and `kubectl get cluster pg` is healthy
- [ ] `/` serves the frontend and `/api/...` reaches the API through Traefik on `devquest.localhost:8080`
- [ ] The API reads config from the hash-suffixed ConfigMap, the JWT key from `api-secrets` and DB credentials from CNPG's `pg-app`
- [ ] Deleting the Postgres pod made the API unready without restarting it (or I can explain why stand-ins behave differently)
- [ ] A rollout under a request loop produced no 5xx responses
- [ ] The HPA shows a real CPU percentage and scaled the API under load
- [ ] A manual run of the `pg-dump` CronJob wrote a dump to the `pg-backups` PVC
:::

## Boss phases

Each phase is an incident from a cluster just like yours. Read the evidence like an on-call engineer.

:::quiz id=ops-17-q1 xp=20
**Phase 1 — The password that wasn't.** API pods crash-loop. `kubectl logs --previous` shows:
`Npgsql.PostgresException: 28P01: password authentication failed for user "$(DB_USER)"`.
The Deployment's env list is: `ConnectionStrings__Default` (value uses `$(DB_USER)` and
`$(DB_PASSWORD)`), then `DB_USER` and `DB_PASSWORD` from `pg-app`. What's wrong?
- [ ] The `pg-app` Secret has the wrong password
- [x] `$(VAR)` references are only expanded for variables defined **earlier** in the `env` list — move `DB_USER`/`DB_PASSWORD` above the connection string
- [ ] Kubernetes never expands variables inside `value`
- [ ] Npgsql doesn't support environment variables
> The literal text `$(DB_USER)` reached Postgres. Kubernetes expands dependent env vars in list
> order; undefined references are left as-is. That's why `base/api.yaml` puts them first. "Wrong
> password in `pg-app`" is tempting because the error says *password authentication failed* — but
> look at the user name in the message: it's the unexpanded placeholder, so the Secret's values never
> made it into the connection string (the variables exist, but were defined too late in the list
> to be substituted). Kubernetes *does* expand `$(VAR)` in `value` (just in order), and Npgsql never
> sees variables at all — it receives the final string.
:::

:::quiz id=ops-17-q2 xp=20
**Phase 2 — JSON wanted, HTML received.** `GET /api/tasks` through the Ingress returns
**200 with your SPA's `index.html`** instead of JSON. The API pods are healthy and
`kubectl port-forward` to the API returns JSON. The Ingress has `/` (Prefix) → web and
`/api` (**Exact**) → api. Why?
- [ ] Traefik caches the frontend
- [x] `/api/tasks` doesn't match the Exact path `/api`, so it falls through to `/` → nginx's SPA fallback serves `index.html` with 200
- [ ] The API Service has no endpoints
- [ ] The browser rewrote the URL
> SPA fallbacks hide routing bugs behind a 200. Use `pathType: Prefix` for `/api`, and consider
> making nginx return 404 for `/api/*` so a misroute fails loudly. "No endpoints" is the tempting
> answer, but a request routed to an API Service without endpoints gets a **503**, not a 200 with
> HTML — and port-forward proves the API is fine. The 200 + `index.html` tells you the request
> reached *web*. Neither Traefik nor the browser rewrites `/api/tasks` to `/`.
:::

:::quiz id=ops-17-q3 xp=20
**Phase 3 — The tug of war.** In dev, the HPA scales the API to 4 under load, then every few
minutes it drops to 1 and climbs again; `kubectl describe hpa` looks normal. Argo CD syncs
`overlays/dev`, which contains `replicas: [{ name: api, count: 1 }]`. Explain.
- [ ] metrics-server restarts every few minutes
- [x] Each sync re-applies `replicas: 1` from Git, overriding the HPA's choice; the HPA then scales up again. Remove the replica count for HPA-managed Deployments (and/or have Argo ignore `/spec/replicas`)
- [ ] The scale-down stabilization window is too short
- [ ] The PDB evicts pods
> Two controllers writing the same field = flapping. One owner per field: the HPA owns
> `replicas`. (Our base deliberately has no `replicas` for `api`.) A too-short stabilization
> window would make the HPA drop *gradually* as load falls — not snap to exactly 1 while load is
> still high and then climb again. The regular period (every Argo sync) and the exact value (the
> one in Git) are the giveaways.
:::

:::quiz id=ops-17-q4 xp=20
**Phase 4 — Every deploy, a few 502s.** Probes are correct and `maxUnavailable: 0`, yet each
rollout produces ~1 s of 502s from Traefik. The API image is chiseled (no shell) and the pods have
no `lifecycle` section. Best fix?
- [ ] Increase `maxSurge` to 100 %
- [x] Add a `preStop` **sleep** (the native `sleep` action — an `exec` hook running `sleep` won't work in an image that has no `sleep` binary) so the pod keeps serving while endpoints and Traefik catch up, and keep graceful shutdown within `terminationGracePeriodSeconds`
- [ ] Switch to the `Recreate` strategy
- [ ] Add a liveness probe
> SIGTERM and endpoint removal happen concurrently; without a short delay the app stops before
> the proxy has noticed. A rollout that's correct on paper still drops requests. More surge
> (tempting: "more capacity!") only adds new pods faster — the old pods are still killed with the
> same race. `Recreate` makes it worse (a full outage), and a liveness probe restarts hung pods; it
> does nothing for shutdown. The `lifecycle.preStop.sleep` action is built into the kubelet
> (stable since Kubernetes 1.34), so it works in images with no `sleep` binary.
:::

:::quiz id=ops-17-q5 xp=20
**Phase 5 — The backup that never was.** The `pg-dump` Job fails every night:
`pg_dump: error: aborting because of server version mismatch — server version: 18.1; pg_dump version: 16.4`.
Nobody noticed for three weeks. Which changes fix the bug **and** the process? (select all)
- [x] Use a `postgres` image whose major version is ≥ the server's (e.g. `postgres:18-alpine`)
- [x] Alert on failed Jobs and on backups older than ~26 h (kube-state-metrics + Alertmanager)
- [ ] Set `concurrencyPolicy: Allow` so more attempts run
- [x] Schedule a restore drill so "a backup file exists" becomes "a restore worked"
- [ ] Increase `backoffLimit` to 100
> Retrying a deterministic failure changes nothing — that's why `concurrencyPolicy: Allow` and a
> huge `backoffLimit` are wrong even though they *sound* like "try harder": the 100th attempt with
> the same pg_dump 16 binary fails exactly like the first. The real lesson: backups without
> alerting and restore tests are hopes.
:::

:::quiz id=ops-17-q6 xp=20
**Phase 6 — Locked out.** After adding NetworkPolicies (default-deny, allow-dns, and "allow from
namespace `traefik` to `app.kubernetes.io/name: api` on **port 80**"), `/api` returns **504** via
Traefik. DNS works, and the API pods are Ready. What's wrong?
- [ ] NetworkPolicies can't select pods by `app.kubernetes.io/name`
- [x] Policies match the **pod's** port after Service translation — the API container listens on 8080, so allowing port 80 lets nothing through
- [ ] Traefik needs a ClusterRole to reach pods
- [ ] The API Service must be NodePort
> Service port 80 → targetPort 8080; the packet arriving at the pod is on 8080. Use `port: 8080`
> (or the named port `http`). 504 = Traefik never got a connection before its timeout (dropped
> packets look like silence, not a refusal). Selecting by any label works, Traefik reaches pods over
> the network (RBAC only governs API calls), and the Service type is irrelevant — Traefik talks to
> pod endpoints directly.
:::

:::quiz id=ops-17-q7 xp=20
**Phase 7 — The worker that wouldn't wake.** 500 jobs are queued but the worker stays at 0.
`kubectl get scaledobject worker` shows `READY False`, and its events say
`dial tcp: lookup pg-rw on 10.96.0.10:53: no such host`.
The worker pods themselves connect fine using `Host=pg-rw`. Why?
- [ ] The worker's image is wrong
- [x] The query runs in the **KEDA operator** (namespace `keda`), where `pg-rw` resolves as `pg-rw.keda.svc…` — use the FQDN `pg-rw.devquest-dev.svc.cluster.local`
- [ ] KEDA can't scale from zero
- [ ] The jobs table needs an index
> Scalers run in KEDA's pods, not yours. Short Service names only work inside their own
> namespace. (With default-deny NetworkPolicies, also allow KEDA → pg on 5432.) "KEDA can't scale
> from zero" is the tempting answer since the worker is stuck at 0 — but scaling from zero is
> KEDA's whole point; `READY False` means it can't even *read* the metric. The DNS error in the
> events rules out the image and the index.
:::

## Final strike: automate the triage

:::challenge id=ops-17-c1 lang=ts xp=80
title: Triage a pod like an on-call engineer
Write `triage(pod)` returning the **most specific** diagnosis, checking in this order:

1. `!pod.scheduled` → `'Unschedulable'`
2. any container `waiting` is `'ErrImagePull'` or `'ImagePullBackOff'` → `'ImagePull'`
3. any container `waiting` is `'CreateContainerConfigError'` → `'ConfigMissing'`
4. any container's `lastTerminated.reason` is `'OOMKilled'` → `'OOMKilled'` (even while it's in CrashLoopBackOff)
5. any container `waiting` is `'CrashLoopBackOff'` → `'CrashLoop'`
6. `phase === 'Running'` and any container is not `ready` → `'NotReady'`
7. otherwise `'Healthy'`

hint: Write a helper `const waiting = (r: string) => pod.containers.some((c) => c.waiting === r)`.
hint: Order matters — return as soon as one rule matches.

```ts starter
type Container = { name: string; ready: boolean; restartCount: number; waiting?: string; lastTerminated?: { reason: string; exitCode: number } }
type Pod = { phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed'; scheduled: boolean; containers: Container[] }
type Diagnosis = 'Unschedulable' | 'ImagePull' | 'ConfigMissing' | 'OOMKilled' | 'CrashLoop' | 'NotReady' | 'Healthy'

export function triage(pod: Pod): Diagnosis {
  if (pod.containers.some((c) => c.waiting === 'CrashLoopBackOff')) return 'CrashLoop'
  return 'Healthy'
}
```

```ts solution
type Container = { name: string; ready: boolean; restartCount: number; waiting?: string; lastTerminated?: { reason: string; exitCode: number } }
type Pod = { phase: 'Pending' | 'Running' | 'Succeeded' | 'Failed'; scheduled: boolean; containers: Container[] }
type Diagnosis = 'Unschedulable' | 'ImagePull' | 'ConfigMissing' | 'OOMKilled' | 'CrashLoop' | 'NotReady' | 'Healthy'

export function triage(pod: Pod): Diagnosis {
  const waiting = (...reasons: string[]) => pod.containers.some((c) => c.waiting !== undefined && reasons.includes(c.waiting))
  if (!pod.scheduled) return 'Unschedulable'
  if (waiting('ErrImagePull', 'ImagePullBackOff')) return 'ImagePull'
  if (waiting('CreateContainerConfigError')) return 'ConfigMissing'
  if (pod.containers.some((c) => c.lastTerminated?.reason === 'OOMKilled')) return 'OOMKilled'
  if (waiting('CrashLoopBackOff')) return 'CrashLoop'
  if (pod.phase === 'Running' && pod.containers.some((c) => !c.ready)) return 'NotReady'
  return 'Healthy'
}
```

```ts tests
const c = (over: Record<string, unknown> = {}) => ({ name: 'api', ready: true, restartCount: 0, ...over }) as any
test('pending and unscheduled', () => {
  expect(triage({ phase: 'Pending', scheduled: false, containers: [] })).toBe('Unschedulable')
})
test('image pull problems', () => {
  expect(triage({ phase: 'Pending', scheduled: true, containers: [c({ ready: false, waiting: 'ImagePullBackOff' })] })).toBe('ImagePull')
  expect(triage({ phase: 'Pending', scheduled: true, containers: [c({ ready: false, waiting: 'ErrImagePull' })] })).toBe('ImagePull')
})
test('missing config', () => {
  expect(triage({ phase: 'Pending', scheduled: true, containers: [c({ ready: false, waiting: 'CreateContainerConfigError' })] })).toBe('ConfigMissing')
})
test('OOMKilled beats CrashLoopBackOff', () => {
  const pod = { phase: 'Running' as const, scheduled: true, containers: [c({ ready: false, restartCount: 4, waiting: 'CrashLoopBackOff', lastTerminated: { reason: 'OOMKilled', exitCode: 137 } })] }
  expect(triage(pod)).toBe('OOMKilled')
})
test('plain crash loop', () => {
  const pod = { phase: 'Running' as const, scheduled: true, containers: [c({ ready: false, restartCount: 7, waiting: 'CrashLoopBackOff', lastTerminated: { reason: 'Error', exitCode: 1 } })] }
  expect(triage(pod)).toBe('CrashLoop')
})
test('running but not ready (sidecar fine, app not)', () => {
  expect(triage({ phase: 'Running', scheduled: true, containers: [c({ ready: false }), c({ name: 'sidecar' })] })).toBe('NotReady')
})
test('healthy', () => {
  expect(triage({ phase: 'Running', scheduled: true, containers: [c(), c({ name: 'sidecar' })] })).toBe('Healthy')
})
```
:::

:::cards id=ops-17-cards1 xp=20 title="Boss fight debrief"
Q: Why does base/api.yaml have no replicas field?
A: The HPA owns replicas; a value in Git would fight it on every apply/sync.
Q: Why must DB_USER come before ConnectionStrings__Default in env?
A: $(VAR) expansion only sees variables defined earlier in the list.
Q: Which Service name goes in the API's connection string?
A: pg-rw — CNPG keeps it pointed at the current primary.
Q: Why might pods briefly show CreateContainerConfigError right after the first apply?
A: They reference the pg-app Secret, which CNPG creates only after bootstrapping; reconciliation recovers them automatically.
Q: What makes a rollout truly zero-downtime?
A: maxUnavailable 0 + correct readiness + preStop sleep + graceful shutdown within the grace period.
Q: What does /ready check, and what does /live check?
A: /ready: dependencies like Postgres (gates traffic). /live: only that the process responds (gates restarts).
Q: Where do prod secrets come from in this design?
A: An ExternalSecret syncing from Vault into api-secrets; CNPG generates pg-app.
Q: Why use the FQDN for Postgres in a KEDA trigger?
A: The scaler runs in the keda namespace; short names resolve relative to the caller's namespace.
Q: What does the prod overlay change?
A: Namespace + restricted PSS, image names/tags, 3 Postgres instances with WAL archiving and scheduled backups, HPA 3–20, bigger requests, TLS host.
Q: Your triage order?
A: Unschedulable → ImagePull → ConfigMissing → OOMKilled → CrashLoop → NotReady → Healthy.
:::

## Recap

- You deployed a complete SaaS stack declaratively: CNPG Postgres, ASP.NET API, Vite/nginx web,
  worker, Traefik routing, config + secrets, probes, PDB, HPA and a backup CronJob.
- **Kustomize** captured environments as differences: dev (kind, generated dev secret, small) vs
  prod (restricted PSS, External Secrets, 3 Postgres instances with WAL archiving, HPA 3–20, TLS).
- The phases were real incident patterns: env ordering, path types and SPA fallbacks, controllers
  fighting over a field, shutdown races, untested backups, NetworkPolicy ports, and
  namespace-relative DNS for operators.
- Next stop for real jobs: the same stack on **EKS, AKS or GKE**: cloud load balancers, CSI storage,
  node pools and workload identity instead of static keys (Managed Kubernetes lesson ops-19).
- The meta-lesson of the whole region: **everything is desired state plus a controller** — your
  Deployments, CNPG, KEDA, cert-manager, Argo CD. When something's wrong, find which loop isn't
  converging and read what it's telling you.
