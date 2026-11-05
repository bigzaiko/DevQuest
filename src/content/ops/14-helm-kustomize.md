---
id: ops-14
title: Kustomize & Helm — One App, Many Environments
level: intermediate
minutes: 90
xp: 160
summary: Stop copy-pasting YAML. Kustomize bases and overlays for dev/test/prod, Helm charts with templates, values and releases (install/upgrade/rollback), when to use which, and installing third-party charts safely.
---

By now your app is a dozen manifests: Deployments, Services, Ingress, ConfigMaps, probes,
resources, a CronJob. Now you need **dev**, **test** and **prod** — with different replica counts,
image tags, hostnames, resources and config. Copy-pasting three folders works for a week, then
they drift and nobody knows which difference is intentional.

Two tools dominate, with opposite philosophies:

| | **Kustomize** | **Helm** |
|---|---|---|
| Idea | Plain YAML + **patches** layered on top | **Templates** rendered from **values** |
| Built in | Yes: `kubectl apply -k` | Separate CLI |
| Packaging / versioning | No (it's just folders) | Yes: versioned **charts**, repos, OCI registries |
| Release tracking | No (kubectl/GitOps tracks it) | Yes: **releases** with revision history and `rollback` |
| Logic (if/loops) | None — by design | Go templates: conditionals, loops, functions |
| Sweet spot | **Your own apps** across environments | **Distributing** software: Traefik, cert-manager, CNPG, KEDA, Prometheus… |

## Kustomize: bases and overlays

Kustomize reads a `kustomization.yaml`, loads the listed resources, applies **transformations**,
and prints the final YAML. No templates — every file in the base is valid YAML you could apply on
its own.

```text
k8s/
├── base/                      # what every environment shares
│   ├── kustomization.yaml
│   ├── api.yaml               # Deployment + Service
│   ├── web.yaml
│   └── ingress.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml # namespace devquest-dev, 1 replica, dev host, debug logging
    │   └── namespace.yaml
    ├── test/
    │   └── kustomization.yaml
    └── prod/
        ├── kustomization.yaml # namespace devquest-prod, 3 replicas, bigger resources, prod host
        ├── namespace.yaml
        └── resources-patch.yaml
```

Notice the namespaces. Until now the app lived in one namespace called `devquest` (ops-09 to
ops-13). From this lesson on, **each environment gets its own namespace**, set by its overlay:
`devquest-dev`, `devquest-test`, `devquest-prod`. ops-16 and the ops-17 boss fight use the same
names. On real teams prod usually also gets its own *cluster*, but the overlay pattern is identical.

```yaml
# k8s/base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
labels:
  - pairs:
      app.kubernetes.io/part-of: devquest
    includeSelectors: false        # don't touch immutable selectors
resources:
  - api.yaml
  - web.yaml
  - ingress.yaml
configMapGenerator:
  - name: api-config
    literals:
      - ASPNETCORE_ENVIRONMENT=Production
      - Logging__LogLevel__Default=Information
```

```yaml
# k8s/overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: devquest-prod           # set on every resource
resources:
  - ../../base
  - namespace.yaml
images:                            # change tags without touching the base
  - name: ghcr.io/acme/devquest-api
    newTag: "1.4.2"
replicas:
  - name: api
    count: 3
configMapGenerator:
  - name: api-config
    behavior: merge                # merge into the base's generator
    literals:
      - Features__NewEditor=false
patches:
  - path: resources-patch.yaml     # strategic merge patch (looks like a partial object)
  - target:                        # JSON 6902 patch for precise edits
      kind: Ingress
      name: devquest
    patch: |-
      - op: replace
        path: /spec/rules/0/host
        value: app.example.com
```

```yaml
# k8s/overlays/prod/resources-patch.yaml — matched by kind + name, merged into the base Deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api                # list items are merged by "name"
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits: { memory: 512Mi }
```

```bash
kubectl kustomize k8s/overlays/prod          # render only — read it, diff it, review it
kubectl diff -k k8s/overlays/prod            # what would change in the cluster
kubectl apply -k k8s/overlays/prod
```

### Two kinds of patch

* A **strategic merge patch** (SMP) is a partial copy of the object: Kustomize finds the target by
  `kind` + `metadata.name` and merges your fields in. For known lists such as `containers`,
  `env` or `ports` it merges **by a key** (the container's `name`, the env var's `name`) instead of
  replacing the whole list. Use it for "add/change these fields" — it reads like the YAML you know.
* A **JSON 6902 patch** is a list of operations (`add`, `replace`, `remove`, …) on exact paths like
  `/spec/rules/0/host`. Use it where SMP can't express the change — list items addressed by index,
  removing a field, or custom resources whose lists have no merge key.

:::warn title="Common mistake: a typo in the merge key"
If your SMP says `containers: - name: app` but the base container is called `api`, Kustomize
doesn't fail — it **adds a second container** named `app` with only `resources` and no image.
The API server then rejects the Deployment (`spec.template.spec.containers[1].image: Required
value`). Always render (`kubectl kustomize`) and read the result.
:::

:::quiz id=ops-14-q6 xp=15
The base Deployment `api` has one container named `api` with 3 env vars. A prod overlay applies
this strategic merge patch. What is in the rendered Deployment?

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - name: Features__NewEditor
              value: "true"
```

- [ ] One container whose env list is replaced by just `Features__NewEditor`
- [x] One container `api` with its 3 original env vars plus `Features__NewEditor`
- [ ] Two containers named `api`
- [ ] An error, because the patch doesn't repeat the image
> Strategic merge knows that `containers` is keyed by `name` and `env` is keyed by `name`, so it
> finds the existing `api` container and merges a fourth env var into its list (an existing var
> with the same name would be overwritten). Replacing whole lists is what a plain JSON merge
> would do, and fields you don't mention — like `image` — are simply kept from the base.
:::

### Generators and the hash suffix

`configMapGenerator` / `secretGenerator` produce ConfigMaps named like `api-config-g4hk9h2m5t`,
and **rewrite every reference** to them. Change a value → new hash → new name → the Deployment's
pod template changes → automatic **rolling update** (the trick from ops-12). Rollback restores the
old ConfigMap reference too.

:::warn title="Deprecated fields you'll still see"
`commonLabels` (it also rewrote selectors — breaking immutable Deployments), `patchesStrategicMerge`
and `patchesJson6902` are deprecated. Use `labels` and `patches`. `kustomize edit fix` migrates old
files.
:::

:::tip title="Components: optional features without if-statements"
Kustomize has no `if`. When some environments need an optional piece (say, a debug sidecar or
extra network policies) put it in a **component** — a folder with `kind: Component` — and list it
under `components:` in the overlays that want it. That's Kustomize's answer to a Helm
`{{ if .Values.debug.enabled }}`.
:::

:::quiz id=ops-14-q1 xp=10
In a Kustomize overlay you change one literal in a `configMapGenerator`. What happens when you
`kubectl apply -k` it?
- [ ] The existing ConfigMap is updated in place; pods keep old env values
- [x] A new ConfigMap with a different hash suffix is created, the Deployment references it, and a rolling update starts
- [ ] Nothing until you run `kubectl rollout restart`
- [ ] Kustomize refuses because ConfigMaps are immutable
> The generator hashes the ConfigMap's content into its name and rewrites the Deployment's
> reference, so the name changes → the pod template changes → rollout. The "updated in place,
> pods keep old values" answer describes a hand-written ConfigMap without a hash (ops-12), and
> `rollout restart` is exactly the manual step the hash makes unnecessary. Old ConfigMaps linger
> until pruned (GitOps tools prune them for you).
:::

:::quiz id=ops-14-q2 xp=15
Which overlay `kustomization.yaml` is **broken**?

```yaml
# A
resources:
  - ../../base
images:
  - name: ghcr.io/acme/devquest-api
    newTag: "1.4.2"
---
# B
resources:
  - ../../base
patches:
  - target:
      kind: Deployment
      name: api
    patch: |-
      - op: add
        path: /spec/replicas
        value: 3
---
# C
resources:
  - ../../base/api.yaml
  - ../../base/web.yaml
namespace: devquest-test
```
- [ ] A
- [ ] B
- [x] C — overlays should reference the base **directory** (a kustomization), not individual files outside their own folder
- [ ] All are fine
> Kustomize's load restrictions forbid pulling individual files from outside the kustomization's
> directory tree (`security; file … is not in or below …`). A *directory* that contains its own
> `kustomization.yaml` may be referenced from anywhere — so use `../../base`, which also keeps the
> base's generators and labels. A is the standard `images` transformer. B is tempting to flag
> because it looks low-level, but it is a valid JSON 6902 patch (`add` sets the field whether or not
> the base has one; `replace` would fail if the base omitted `replicas`).
:::

## Helm: charts, values, releases

Kustomize assumes *you* own the YAML. But who writes cert-manager's 40 manifests for your
cluster? Its authors — and they can't know your namespace, replica count or resource budget. They
need a package with **parameters**, and users need to install, upgrade and uninstall it as a
unit. That's Helm: a **package manager** for Kubernetes, like NuGet or npm for cluster software.
A **chart** is a folder (or `.tgz` / OCI artifact):

```text
devquest-api/
├── Chart.yaml            # name, version (of the chart), appVersion (of the app)
├── values.yaml           # default configuration
├── templates/
│   ├── _helpers.tpl      # reusable named templates (names, labels)
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── configmap.yaml
│   └── NOTES.txt         # printed after install
└── charts/               # dependencies (subcharts)
```

Templates are Go templates that render to YAML:

```yaml
# templates/deployment.yaml (excerpt)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "devquest-api.fullname" . }}
  labels:
    {{- include "devquest-api.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          {{- with .Values.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
```

* `{{ … }}` is a template action and `.` is the **current context** — at the top level it holds
  `.Values` (merged configuration), `.Release.Name`, `.Release.Namespace`, `.Chart.Version`.
  Inside `with` or `range`, `.` changes to the current item (that's why the `toYaml .` above
  prints `.Values.resources`); `$` always means the top level.
* `{{-` / `-}}` trim whitespace; `nindent N` adds a newline + indentation — **indentation bugs are
  the #1 Helm error**, so always `helm template` before you ship.
* `include` calls named templates from `_helpers.tpl`; `toYaml`, `quote`, `default`, `required`,
  `sha256sum` are the everyday functions.

A **release** is one installed instance of a chart (`helm install demo ./devquest-api` → release
`demo`). Each install/upgrade/rollback creates a numbered **revision**, stored as a Secret
(`sh.helm.release.v1.demo.v3`) in the release's namespace.

```bash
helm install demo ./devquest-api -n devquest-prod --create-namespace -f values-prod.yaml
helm upgrade --install demo ./devquest-api -n devquest-prod -f values-prod.yaml --set image.tag=1.4.3
helm list -n devquest-prod
helm history demo -n devquest-prod
helm rollback demo 2 -n devquest-prod       # creates a NEW revision with revision 2's manifests
helm get values demo -n devquest-prod --all # what was actually used
helm template demo ./devquest-api -f values-prod.yaml   # render locally, no cluster
helm lint ./devquest-api
helm uninstall demo -n devquest-prod
```

### Values precedence

```text
lowest ─► chart's values.yaml
          parent chart's values (for subcharts)
          -f values-a.yaml  -f values-b.yaml   (later files win)
highest ─► --set / --set-string / --set-file
```

Maps merge **deeply**; lists and scalars are **replaced**; setting a key to `null` removes a
default.

:::warn title="--reuse-values surprises"
`helm upgrade --reuse-values` re-uses the *previous release's* values and ignores new defaults
from an upgraded chart — a common source of "the new chart version didn't change anything". Keep
your values in Git files and pass them explicitly with `-f` on every upgrade.
:::

:::quiz id=ops-14-q3 xp=10
A chart's `values.yaml` has `replicaCount: 1`. You run
`helm upgrade --install api ./chart -f prod.yaml --set replicaCount=5`, and `prod.yaml` says
`replicaCount: 3`. How many replicas?
- [ ] 1
- [ ] 3
- [x] 5
- [ ] Helm errors on conflicting values
> `--set` beats `-f` files, which beat the chart defaults. Conflicting values are normal, not an
> error — overriding defaults is the whole point of layers. In CI prefer files (reviewable) and
> keep `--set` for the one thing that changes per build: the image tag.
:::

:::quiz id=ops-14-q4 xp=10
Your release is at revision 7. You run `helm rollback api 5`. What does `helm history api` show
afterwards?
- [ ] The current revision is 5; revisions 6 and 7 are deleted
- [x] A new revision 8 whose manifests equal revision 5
- [ ] Revision 7 marked as failed, nothing else
- [ ] It depends on `--force`
> Like `kubectl rollout undo`, a Helm rollback is a roll *forward* to old content: revision 8 is
> created with revision 5's manifests and values, and revisions 6 and 7 stay in the history so you
> can still see (and return to) them. History is append-only, trimmed only by `--history-max`
> (default 10 on `helm upgrade`).
:::

### Hooks, dependencies and OCI

**Hooks** (`helm.sh/hook: pre-upgrade`) run chart resources at lifecycle points — the classic is an EF
Core **migration Job** before the new API version rolls out. Helm waits for a hook Job to
succeed; if it fails, the upgrade fails and the new Deployment is never applied:

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ include "devquest-api.fullname" . }}-migrate
  annotations:
    helm.sh/hook: pre-install,pre-upgrade
    helm.sh/hook-weight: "0"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: "{{ .Values.image.repository }}-migrations:{{ .Values.image.tag }}"
          envFrom:
            - secretRef: { name: api-secrets }   # must already exist — see below
```

Gotcha: hooks run **before** the chart's normal resources are created, so a ConfigMap/Secret
that is itself part of the chart doesn't exist yet on the first install. Reference
pre-existing Secrets (or make them hooks with a lower weight). `before-hook-creation` deletes
the previous run's Job so the fixed name can be reused.

Two more features you'll meet:

* **Dependencies** in `Chart.yaml` pull in subcharts (`helm dependency update`).
* Charts are published to **OCI registries** just like images:
  `helm package ./devquest-api && helm push devquest-api-0.3.0.tgz oci://ghcr.io/acme/charts`,
  and installed with `helm install api oci://ghcr.io/acme/charts/devquest-api --version 0.3.0`.

:::info title="Helm 3 → Helm 4"
Helm 4 (released November 2025) modernised internals (server-side apply, a new plugin system,
OCI improvements) but the everyday commands in this lesson — `install`, `upgrade --install`,
`rollback`, `template`, `-f`, `--set` — work the same in Helm 3 and 4, and release state is
stored the same way. A few flags were renamed (e.g. `--atomic` → `--rollback-on-failure`); the old
spellings are deprecated, so check the warnings when you upgrade CI scripts.
:::

:::quiz id=ops-14-q7 xp=10
A brand-new CI pipeline deploys to a fresh cluster with `helm upgrade api ./chart -n devquest-prod -f prod.yaml`.
What happens on the very first run?
- [ ] Helm installs the release, because `upgrade` creates it if missing
- [x] It fails with `Error: UPGRADE FAILED: "api" has no deployed releases` — use `helm upgrade --install`
- [ ] It installs the chart into the `default` namespace
- [ ] It succeeds but stores no release history
> Plain `upgrade` requires an existing release. `upgrade --install` is idempotent — it installs the
> first time and upgrades afterwards — which is why every pipeline uses it (often with
> `--create-namespace` and `--wait`). `-n` is honoured either way; the problem is the missing release.
:::

## Installing third-party charts like a professional

You already installed Traefik, cert-manager and CloudNativePG with Helm. In production:

```bash
helm repo add kedacore https://kedacore.github.io/charts
helm search repo kedacore/keda --versions | head -5       # pick a version deliberately
helm show values kedacore/keda --version <x.y.z> > keda-defaults.yaml   # read what you can configure
helm upgrade --install keda kedacore/keda --version <x.y.z> \
  -n keda --create-namespace -f platform/keda/values.yaml   # your overrides live in Git
```

* **Pin `--version`.** "Latest" in a pipeline means surprise upgrades.
* Keep a small **values file per chart in Git** containing only your overrides.
* Review upgrades with the `helm diff` plugin (`helm diff upgrade …`) or let Argo CD / Flux show
  the diff (ops-16).
* **CRDs**: Helm installs CRDs from a chart's `crds/` folder on first install but **never upgrades
  or deletes them**. Charts like cert-manager offer `crds.enabled=true` to manage them as templates;
  read the upgrade notes.

## When to use which

| Situation | Choose |
|---|---|
| Your own API/web/worker across dev/test/prod | **Kustomize** (simple, plain YAML, reviewable diffs) |
| Software you install from others | **Helm** charts (it's how they're distributed) |
| Your app is deployed by many teams/customers with many options | **Helm** chart (you're now a distributor) |
| You want a Helm chart but patch one thing the chart doesn't expose | Kustomize on top of `helm template` output (or Kustomize's `helmCharts` field, rendered with `kubectl kustomize --enable-helm`), or a GitOps tool that post-renders |

:::job title="What you'll find on day one"
A typical SaaS repo: `deploy/base` + `deploy/overlays/{dev,staging,prod}` for the company's own
services, and a `platform/` folder with pinned Helm values for Traefik, cert-manager, CNPG, KEDA,
External Secrets and kube-prometheus-stack — all applied by Argo CD or Flux, not by humans.
:::

:::quiz id=ops-14-q5 xp=15
Which statements are true? (select all)
- [x] `kubectl kustomize` / `helm template` let you review the exact YAML before it reaches the cluster
- [x] Helm keeps release history in Secrets in the release's namespace
- [ ] Kustomize supports `if` conditions in YAML
- [x] Kustomize is built into `kubectl` (`apply -k`)
- [ ] Helm automatically upgrades CRDs from a chart's `crds/` folder
> Kustomize has no logic by design — use overlays and components instead. Helm never upgrades
> `crds/`-folder CRDs; that's a manual (or chart-specific) step.
:::

## Validate before you apply: quality gates in CI

Rendering locally and reading the output is the habit. On a team, the **pipeline** does it on
every pull request, so a typo in an overlay fails a check in review instead of a sync at 2 a.m.
The manifests your CI checks must be the **rendered** ones (what `kubectl kustomize` or
`helm template` prints), because that is what reaches the cluster. Four gates, from cheap to
thorough:

| Gate | Catches | Tools |
|---|---|---|
| **1. Schema** | `replica:` instead of `replicas:`, a string where an int belongs, an API version the target Kubernetes no longer serves | **kubeconform** (with CRD schemas for Traefik, CNPG, KEDA…), `helm lint --strict` for charts |
| **2. Lint / best practice** | No resources, no probes, `:latest`, running as root, missing PDB, selectors that match nothing | **kube-linter**, Polaris, kube-score |
| **3. Policy** | *Your* rules: "every Deployment in `devquest-prod` has a memory limit", "images only from `ghcr.io/acme`", "no `LoadBalancer` Services" | **conftest** (OPA/Rego), `kyverno apply` (Kyverno policies as a CLI) |
| **4. Diff / dry-run against the cluster** | What *actually* changes, admission rejections (Pod Security, quotas, webhooks), immutable-field errors | `kubectl diff --server-side`, `kubectl apply --dry-run=server`, `helm diff`, Argo CD's diff in the PR |

Gates 1–3 need no cluster and run in seconds. Gate 4 needs read access to the target cluster, so
many teams let Argo CD (ops-16) post the diff to the PR instead of handing CI credentials.

```yaml
# .github/workflows/manifests.yml (tool install steps omitted: each is one binary or action)
name: manifests
on: pull_request
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: Render every environment
        run: |
          mkdir -p out
          for env in dev test prod; do kubectl kustomize k8s/overlays/$env > out/$env.yaml; done
      - name: 1 · Schemas (incl. CRDs)
        run: |
          kubeconform -strict -summary -kubernetes-version 1.34.0 \
            -schema-location default \
            -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
            out/*.yaml
      - name: 2 · Lint
        run: kube-linter lint out/
      - name: 3 · Team policy
        run: conftest test out/ --policy policy/
```

A conftest policy is a few lines of Rego. Each `deny` rule that matches produces a failure
message for the PR:

```text
# policy/workloads.rego
package main

deny contains msg if {
  input.kind == "Deployment"
  some c in input.spec.template.spec.containers
  not c.resources.limits.memory
  msg := sprintf("Deployment/%s: container %q has no memory limit", [input.metadata.name, c.name])
}

deny contains msg if {
  input.kind == "Deployment"
  some c in input.spec.template.spec.containers
  not startswith(c.image, "ghcr.io/acme/")
  msg := sprintf("Deployment/%s: image %q is not from ghcr.io/acme", [input.metadata.name, c.image])
}
```

`kubectl diff` exits `0` when nothing changes, `1` when there are differences and `>1` on an
error, so a pipeline can post the diff as a PR comment without failing on a normal change.

:::pro title="Same rules in CI and in the cluster"
CI gates can be skipped (a hotfix with `kubectl apply`, a tool that doesn't run them). The cluster
is the last line: Pod Security admission (ops-16), plus a policy engine (**Kyverno**, OPA
**Gatekeeper**, or the built-in **ValidatingAdmissionPolicy** with CEL rules) enforcing the same
rules at admission. Mature teams keep one policy set and run it in both places: in CI for fast
feedback, in the cluster for enforcement.
:::

:::quiz id=ops-14-q8 xp=15
Your PR's rendered prod overlay passes kubeconform, kube-linter and conftest. After merge, Argo CD
syncs, but no new API pods appear, and the ReplicaSet's events say
`pods "api-…" is forbidden: violates PodSecurity "restricted:latest"`. Which gate would have
caught it before merge?
- [ ] A stricter kubeconform run with `-strict`
- [x] A server-side dry run or diff against the cluster (`kubectl apply --dry-run=server` / `kubectl diff --server-side`), which runs admission
- [ ] `helm lint --strict`
- [ ] None: admission errors can only be seen after a real apply
> Schema and lint tools only see the YAML. Pod Security is enforced by an **admission controller**
> using the **namespace's labels**, which live in the cluster, so only a check that talks to the
> API server can see it. A server-side dry run sends the object through authentication, admission
> and validation without persisting it. One nuance: Pod Security is checked against the *pod*. A
> dry-run of a Deployment shows a warning, and the hard rejection happens when the ReplicaSet
> creates pods, so read the warnings, not only the exit code. kube-linter's `run-as-non-root`
> check would also have flagged this specific case.
:::

:::challenge id=ops-14-c2 lang=ts xp=60
title: A mini manifest linter
Write `lintManifests(docs)` that checks rendered manifests (already parsed from YAML) and returns
a list of violation messages, the way kube-linter or a conftest policy would.

Only workloads are checked; every other kind is ignored. The pod spec lives at:

* `Deployment`, `StatefulSet`, `DaemonSet` → `spec.template.spec`
* `CronJob` → `spec.jobTemplate.spec.template.spec`

For each entry in the pod spec's `containers` (not `initContainers`), in this order:

1. **Mutable image**: no tag, or the tag `latest`. An image pinned by digest (`@sha256:`) is fine.
   Careful: in `localhost:5000/devquest/api` the `:5000` is a registry port, not a tag.
2. **No memory request**: `resources.requests.memory` missing.
3. **No memory limit**: `resources.limits.memory` missing.
4. **No readiness probe**: only for `Deployment`.

Message format: `` `${kind}/${name} ${container}: ${problem}` `` with the problems
`mutable image tag`, `no memory request`, `no memory limit`, `no readiness probe`. Messages are
ordered by document, then container, then the rule order above.

hint: A lookup table `{ Deployment: (spec) => spec?.template?.spec, … }` handles the different paths and the "ignore other kinds" rule at once.
hint: For the tag, only look at the part after the last `/`; a `:` there separates name and tag.
hint: Optional chaining (`c.resources?.limits?.memory`) keeps a missing `resources` from throwing.

```ts starter
type Doc = { kind: string; metadata: { name: string }; spec?: any }

export function lintManifests(docs: Doc[]): string[] {
  const out: string[] = []
  // check every workload's containers
  return out
}
```

```ts solution
type Doc = { kind: string; metadata: { name: string }; spec?: any }

const podSpecOf: Record<string, (spec: any) => any> = {
  Deployment: (s) => s?.template?.spec,
  StatefulSet: (s) => s?.template?.spec,
  DaemonSet: (s) => s?.template?.spec,
  CronJob: (s) => s?.jobTemplate?.spec?.template?.spec,
}

function isMutable(image: string): boolean {
  if (image.includes('@sha256:')) return false
  const last = image.slice(image.lastIndexOf('/') + 1)
  const i = last.indexOf(':')
  return i === -1 || last.slice(i + 1) === 'latest'
}

export function lintManifests(docs: Doc[]): string[] {
  const out: string[] = []
  for (const d of docs) {
    const get = podSpecOf[d.kind]
    if (!get) continue
    for (const c of get(d.spec)?.containers ?? []) {
      const where = `${d.kind}/${d.metadata.name} ${c.name}`
      if (isMutable(c.image)) out.push(`${where}: mutable image tag`)
      if (!c.resources?.requests?.memory) out.push(`${where}: no memory request`)
      if (!c.resources?.limits?.memory) out.push(`${where}: no memory limit`)
      if (d.kind === 'Deployment' && !c.readinessProbe) out.push(`${where}: no readiness probe`)
    }
  }
  return out
}
```

```ts tests
const good = (image = 'ghcr.io/acme/devquest-api:1.4.2') => ({
  name: 'api',
  image,
  resources: { requests: { memory: '256Mi' }, limits: { memory: '256Mi' } },
  readinessProbe: { httpGet: { path: '/ready', port: 8080 } },
})
const deploy = (name: string, containers: any[]) => ({
  kind: 'Deployment', metadata: { name }, spec: { template: { spec: { containers } } },
})

test('a clean Deployment has no violations', () => {
  expect(lintManifests([deploy('api', [good()])])).toEqual([])
})
test('non-workload kinds are ignored', () => {
  expect(lintManifests([
    { kind: 'Service', metadata: { name: 'api' }, spec: { selector: {} } },
    { kind: 'ConfigMap', metadata: { name: 'cfg' } },
  ])).toEqual([])
})
test(':latest and a missing tag are mutable', () => {
  expect(lintManifests([deploy('api', [good('nginx:latest'), { ...good('busybox'), name: 'tools' }])])).toEqual([
    'Deployment/api api: mutable image tag',
    'Deployment/api tools: mutable image tag',
  ])
})
test('a registry port is not a tag, a digest is fine', () => {
  expect(lintManifests([deploy('api', [
    good('localhost:5000/devquest/api'),
    { ...good('localhost:5000/devquest/api:1.0.0'), name: 'b' },
    { ...good('ghcr.io/acme/devquest-api@sha256:3f2a9c'), name: 'c' },
  ])])).toEqual(['Deployment/api api: mutable image tag'])
})
test('missing resources and probe, in rule order', () => {
  expect(lintManifests([deploy('web', [{ name: 'nginx', image: 'nginx:1.29-alpine' }])])).toEqual([
    'Deployment/web nginx: no memory request',
    'Deployment/web nginx: no memory limit',
    'Deployment/web nginx: no readiness probe',
  ])
})
test('CronJob pod spec path; no readiness rule outside Deployments', () => {
  const cron = {
    kind: 'CronJob', metadata: { name: 'backup' },
    spec: { jobTemplate: { spec: { template: { spec: { containers: [
      { name: 'dump', image: 'postgres:18', resources: { requests: { memory: '128Mi' } } },
    ] } } } } },
  }
  expect(lintManifests([cron])).toEqual(['CronJob/backup dump: no memory limit'])
})
test('StatefulSet and DaemonSet are checked; initContainers are not', () => {
  const sts = { kind: 'StatefulSet', metadata: { name: 'pg' }, spec: { template: { spec: {
    initContainers: [{ name: 'init', image: 'busybox' }],
    containers: [{ ...good('postgres:18'), name: 'postgres', readinessProbe: undefined }],
  } } } }
  const ds = { kind: 'DaemonSet', metadata: { name: 'logs' }, spec: { template: { spec: {
    containers: [{ name: 'alloy', image: 'grafana/alloy:latest', resources: {} }],
  } } } }
  expect(lintManifests([sts, ds])).toEqual([
    'DaemonSet/logs alloy: mutable image tag',
    'DaemonSet/logs alloy: no memory request',
    'DaemonSet/logs alloy: no memory limit',
  ])
})
test('documents keep their order', () => {
  const out = lintManifests([deploy('b', [good('x')]), deploy('a', [good('y')])])
  expect(out).toEqual(['Deployment/b api: mutable image tag', 'Deployment/a api: mutable image tag'])
})
```
:::

:::lab id=ops-14-lab1 xp=120
title: Kustomize — dev and prod overlays on one cluster
Create this tree (any folder, e.g. `k8s-lab/kustomize/`):

```text
base/kustomization.yaml   base/app.yaml
overlays/dev/kustomization.yaml   overlays/prod/kustomization.yaml   overlays/prod/resources-patch.yaml
```

`base/app.yaml` — whoami as "api", nginx as "web", Services and an Ingress:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 1
  selector:
    matchLabels: { app.kubernetes.io/name: api }
  template:
    metadata:
      labels: { app.kubernetes.io/name: api }
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.10
          args: ["--port", "8080"]
          envFrom:
            - configMapRef:
                name: api-config
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests: { cpu: 25m, memory: 32Mi }
            limits: { memory: 64Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector: { app.kubernetes.io/name: api }
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
  selector:
    matchLabels: { app.kubernetes.io/name: web }
  template:
    metadata:
      labels: { app.kubernetes.io/name: web }
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          ports:
            - name: http
              containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector: { app.kubernetes.io/name: web }
  ports:
    - name: http
      port: 80
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: devquest
spec:
  ingressClassName: traefik
  rules:
    - host: base.devquest.localhost
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

`base/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
labels:
  - pairs:
      app.kubernetes.io/part-of: devquest
    includeSelectors: false
resources:
  - app.yaml
configMapGenerator:
  - name: api-config
    literals:
      - ASPNETCORE_ENVIRONMENT=Production
```

`overlays/dev/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: devquest-dev
resources:
  - ../../base
configMapGenerator:
  - name: api-config
    behavior: merge
    literals:
      - ASPNETCORE_ENVIRONMENT=Development
patches:
  - target: { kind: Ingress, name: devquest }
    patch: |-
      - op: replace
        path: /spec/rules/0/host
        value: dev.devquest.localhost
```

`overlays/prod/kustomization.yaml` and `overlays/prod/resources-patch.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: devquest-prod
resources:
  - ../../base
images:
  - name: nginx
    newTag: 1.28-alpine
replicas:
  - name: api
    count: 3
  - name: web
    count: 2
patches:
  - path: resources-patch.yaml
  - target: { kind: Ingress, name: devquest }
    patch: |-
      - op: replace
        path: /spec/rules/0/host
        value: prod.devquest.localhost
```

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          resources:
            requests: { cpu: 100m, memory: 64Mi }
            limits: { memory: 64Mi }
```

Render, compare, apply (the namespaces don't exist yet, so create them first):

```bash
kubectl kustomize overlays/dev  | less
diff <(kubectl kustomize overlays/dev) <(kubectl kustomize overlays/prod)
kubectl create namespace devquest-dev; kubectl create namespace devquest-prod
kubectl apply -k overlays/dev
kubectl apply -k overlays/prod
kubectl get deploy -n devquest-dev; kubectl get deploy -n devquest-prod
curl -s -H "Host: dev.devquest.localhost"  http://127.0.0.1:8080/api/ | grep -i hostname
curl -s -H "Host: prod.devquest.localhost" http://127.0.0.1:8080/api/ | grep -i hostname
```

Expected: `kubectl get deploy` shows `api 1/1` and `web 1/1` in dev, `api 3/3` and `web 2/2` in
prod; each `curl` prints a line like `Hostname: api-6d8f7c9b5d-q2x7k` — run the prod one a few
times and the hostname changes between the three replicas. (`kubectl create namespace` complains
`AlreadyExists` on a second run — harmless.)

Now watch the hash-suffix rollout: add `- Features__NewEditor=true` to the dev overlay's
literals, then:

```bash
kubectl get cm -n devquest-dev
kubectl apply -k overlays/dev
kubectl get cm -n devquest-dev                 # a second api-config-<newhash>
kubectl -n devquest-dev rollout history deploy/api   # a new revision appeared
```

- [ ] `diff` shows only the intended differences (namespace, replicas, tag, resources, host, config)
- [ ] Both environments answer on their own host through Traefik
- [ ] Changing a generator literal created a new hashed ConfigMap and triggered a rollout
:::

:::lab id=ops-14-lab2 xp=120
title: Write, install, upgrade and roll back a Helm chart
Create the chart skeleton by hand (so you understand every line) in `devquest-api/`:

`Chart.yaml`:

```yaml
apiVersion: v2
name: devquest-api
description: DevQuest ASP.NET Core API
type: application
version: 0.1.0
appVersion: "1.0.0"
```

`values.yaml` (defaults use whoami so it runs anywhere; point it at `devquest/api` later):

```yaml
replicaCount: 2
image:
  repository: traefik/whoami
  tag: v1.10
  pullPolicy: IfNotPresent
args: ["--port", "8080"]
containerPort: 8080
probes:
  livenessPath: /live
  readinessPath: /ready
env:
  ASPNETCORE_ENVIRONMENT: Production
resources:
  requests: { cpu: 25m, memory: 32Mi }
  limits: { memory: 64Mi }
```

`templates/_helpers.tpl`:

```text
{{- define "devquest-api.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "devquest-api.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "devquest-api.labels" -}}
{{ include "devquest-api.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
```

`templates/configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "devquest-api.fullname" . }}
  labels:
    {{- include "devquest-api.labels" . | nindent 4 }}
data:
  {{- range $key, $value := .Values.env }}
  {{ $key }}: {{ $value | quote }}
  {{- end }}
```

`templates/deployment.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "devquest-api.fullname" . }}
  labels:
    {{- include "devquest-api.labels" . | nindent 4 }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      {{- include "devquest-api.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "devquest-api.selectorLabels" . | nindent 8 }}
      annotations:
        checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    spec:
      containers:
        - name: api
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          {{- with .Values.args }}
          args:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPort }}
          envFrom:
            - configMapRef:
                name: {{ include "devquest-api.fullname" . }}
          readinessProbe:
            httpGet: { path: {{ .Values.probes.readinessPath }}, port: http }
          livenessProbe:
            httpGet: { path: {{ .Values.probes.livenessPath }}, port: http }
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

`templates/service.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "devquest-api.fullname" . }}
  labels:
    {{- include "devquest-api.labels" . | nindent 4 }}
spec:
  selector:
    {{- include "devquest-api.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: 80
      targetPort: http
```

Now drive it:

```bash
helm lint ./devquest-api
helm template demo ./devquest-api | less           # read the rendered YAML
helm install demo ./devquest-api -n ops14 --create-namespace
kubectl -n ops14 get deploy,svc,cm
kubectl -n ops14 get secret -l owner=helm           # sh.helm.release.v1.demo.v1

helm upgrade demo ./devquest-api -n ops14 --set replicaCount=3 --set env.Features__NewEditor=true
kubectl -n ops14 get pods                           # config checksum changed → new pods
helm history demo -n ops14
helm rollback demo 1 -n ops14
helm history demo -n ops14                          # revision 3 = copy of revision 1
helm get values demo -n ops14 --all
```

Expected `helm history` after the rollback (dates trimmed):

```text
REVISION  STATUS      CHART               APP VERSION  DESCRIPTION
1         superseded  devquest-api-0.1.0  1.0.0        Install complete
2         superseded  devquest-api-0.1.0  1.0.0        Upgrade complete
3         deployed    devquest-api-0.1.0  1.0.0        Rollback to 1
```

and `kubectl -n ops14 get deploy` is back at `2/2`.

**Your own API:** create `values-devquest.yaml` with `image.repository: devquest/api`,
`image.tag: "1.1.0"` (from ops-12, with `/live` + `/ready`) and `args: []`, then
`helm upgrade demo ./devquest-api -n ops14 -f values-devquest.yaml`.

Finish with `helm uninstall demo -n ops14`.

- [ ] `helm lint` passes and `helm template` renders valid YAML
- [ ] The upgrade changed replicas and config, and the checksum annotation rolled the pods
- [ ] `helm rollback` created a new revision with the old manifests
- [ ] I can point at where Helm stores release state
:::

## Code it: Helm-style values merging

:::challenge id=ops-14-c1 lang=ts xp=50
title: Merge values layers like Helm
Write `mergeValues(...layers)` that merges plain-object layers from lowest to highest priority
(chart defaults, then `-f` files, then `--set`):

* Plain objects merge **recursively**.
* Arrays and scalars from a higher layer **replace** the lower value.
* A `null` in a higher layer **removes** the key.
* Inputs must not be mutated.

hint: Write `merge(a, b)` for two layers and `reduce` over the list.
hint: `const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)`

```ts starter
export function mergeValues(...layers: Record<string, any>[]): Record<string, any> {
  return Object.assign({}, ...layers)
}
```

```ts solution
const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)

function merge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete out[k]
    else if (isObj(v) && isObj(out[k])) out[k] = merge(out[k], v)
    else if (isObj(v)) out[k] = merge({}, v)
    else out[k] = v
  }
  return out
}

export function mergeValues(...layers: Record<string, any>[]): Record<string, any> {
  return layers.reduce((acc, layer) => merge(acc, layer), {})
}
```

```ts tests
const defaults = {
  replicaCount: 1,
  image: { repository: 'devquest/api', tag: '1.0.0', pullPolicy: 'IfNotPresent' },
  args: ['--verbose'],
  resources: { limits: { memory: '256Mi' } },
}
test('nested maps merge deeply', () => {
  const r = mergeValues(defaults, { image: { tag: '1.4.2' } })
  expect(r.image).toEqual({ repository: 'devquest/api', tag: '1.4.2', pullPolicy: 'IfNotPresent' })
})
test('later layers win (--set beats -f)', () => {
  expect(mergeValues(defaults, { replicaCount: 3 }, { replicaCount: 5 }).replicaCount).toBe(5)
})
test('arrays are replaced, not concatenated', () => {
  expect(mergeValues(defaults, { args: [] }).args).toEqual([])
})
test('null removes a default', () => {
  const r = mergeValues(defaults, { resources: { limits: null } })
  expect(r.resources).toEqual({})
})
test('inputs are not mutated', () => {
  mergeValues(defaults, { image: { tag: 'x' } })
  expect(defaults.image.tag).toBe('1.0.0')
})
```
:::

:::cards id=ops-14-cards1 xp=15 title="Kustomize & Helm"
Q: Kustomize in one sentence?
A: Template-free customisation: a base of plain YAML plus overlays that patch and transform it per environment.
Q: How do you render / apply a Kustomize overlay?
A: kubectl kustomize <dir> to render; kubectl apply -k <dir> to apply; kubectl diff -k to preview.
Q: Why does configMapGenerator add a hash suffix?
A: Content change → new name → pod template change → automatic rolling update (and clean rollbacks).
Q: Strategic merge patch vs JSON 6902 patch?
A: SMP looks like a partial object and merges lists by key (e.g. container name); JSON 6902 is a list of precise op/path/value operations.
Q: Helm chart vs release?
A: Chart = the package (templates + values). Release = one installed instance with numbered revisions.
Q: Helm values precedence?
A: chart values.yaml < -f files (left to right) < --set.
Q: Where does Helm 3/4 store release state?
A: Secrets in the release's namespace (sh.helm.release.v1.<name>.v<rev>).
Q: What does helm rollback do?
A: Creates a new revision with the manifests of the chosen old revision.
Q: Golden rules for third-party charts?
A: Pin --version, read helm show values, keep overrides in Git, diff before upgrading, read CRD upgrade notes.
Q: When Kustomize, when Helm?
A: Kustomize for your own apps across environments; Helm for distributing/installing packaged software.
Q: Why `helm upgrade --install` in CI?
A: It is idempotent: installs the release the first time, upgrades it afterwards. Plain upgrade fails if no release exists.
Q: What is a Helm hook typically used for?
A: Running a Job (e.g. EF Core migrations) at pre-install/pre-upgrade; a failed hook fails the upgrade.
Q: The four CI gates for manifests?
A: Schema (kubeconform), lint (kube-linter/Polaris), policy (conftest/Kyverno CLI), and a server-side diff/dry-run against the cluster — all on the rendered YAML.
Q: Why does kubeconform miss a Pod Security violation?
A: It only checks YAML against schemas. Admission rules (PSS, quotas, webhooks) need the API server: `kubectl apply --dry-run=server` or `kubectl diff --server-side`.
Q: Kustomize's alternative to an `if` in a template?
A: Components (kind: Component) included only by the overlays that need them.
:::

## Recap

- Environments differ in a few dimensions — encode **only the differences**, never copies.
- **Kustomize**: base + overlays; `namespace`, `images`, `replicas`, `patches` (strategic merge
  by key, or JSON 6902 by path), `labels`, components, generators with hash suffixes; built into
  `kubectl`. Always render and read the output.
- **Helm**: charts (templates + values) → releases with revisions; `upgrade --install`,
  `rollback` (a new revision), `template`, `lint`, hooks for migrations; values precedence
  defaults < `-f` < `--set`.
- Pin chart versions, keep values in Git, render and diff before applying; mind CRD upgrades.
- Gate every PR on the **rendered** YAML: schema (kubeconform), lint (kube-linter), policy
  (conftest), and a server-side diff/dry-run; enforce the same rules in-cluster with admission policies.
- Typical split: Kustomize for your services, Helm for platform components — both applied by GitOps.
