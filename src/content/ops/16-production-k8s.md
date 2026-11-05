---
id: ops-16
title: Production Kubernetes — Security, Secrets, Observability, GitOps & Troubleshooting
level: expert
minutes: 200
xp: 220
summary: What separates a cluster that runs from one you can trust — RBAC and ServiceAccounts, NetworkPolicies, Pod Security Standards, Vault and External Secrets, Kubernetes alerting with kube-state-metrics, GitOps with Argo CD, canary releases with safe migrations, upgrades, and a hop-by-hop troubleshooting playbook.
---

Your app runs, scales and survives node failures. Now the questions change: *Who* may change
what? Can a compromised pod reach the database? Where do the real passwords live? How do you know
something is wrong before customers tell you? How does code get from a merged PR into prod — and
back out? And when it breaks at 2 a.m., what do you type first?

```text
 ┌──────────────── a production-grade SaaS cluster ────────────────┐
 │ Access      RBAC · ServiceAccounts · OIDC for humans            │
 │ Isolation   NetworkPolicies · Pod Security · namespaces         │
 │ Secrets     Vault / cloud KMS ─► External Secrets ─► Secrets    │
 │ Signals     Prometheus · Grafana · Loki · OpenTelemetry · alerts│
 │ Delivery    CI builds images ─► Git ─► Argo CD / Flux reconcile │
 │ Lifecycle   upgrades · backups · restore drills · runbooks      │
 └─────────────────────────────────────────────────────────────────┘
```

This is the longest lesson in the track: plan it as two or three sittings (security and secrets;
observability and delivery; troubleshooting and the labs). Everything here works on any
conformant cluster, including your kind cluster. What changes on **EKS, AKS and GKE** (cloud load
balancers, CSI storage classes, node pools, and above all **workload identity**: pods getting cloud
credentials with no static keys) is the subject of the Managed Kubernetes lesson (ops-19).

## RBAC and ServiceAccounts

**Why:** everything in Kubernetes — deploying, reading logs, reading Secrets, deleting a namespace —
is an HTTP call to the API server. If your CI pipeline's credentials leak, or a pod gets
compromised, the damage is exactly what those credentials are *allowed* to do. **RBAC**
(Role-Based Access Control) is how you make that "allowed" as small as possible: the principle of
**least privilege**.

Every API request is made by a **subject** — a human `User`, a `Group`, or a **ServiceAccount**
(identity for pods and automation) — and RBAC decides whether it may do a **verb** on a
**resource**:

| Object | Scope | Says |
|---|---|---|
| `Role` | namespace | "may `get, list, watch` `pods` and `pods/log`" |
| `ClusterRole` | cluster | same, cluster-wide or for cluster-scoped kinds; also reusable templates |
| `RoleBinding` | namespace | grants a Role (or ClusterRole) to subjects **in that namespace** |
| `ClusterRoleBinding` | cluster | grants a ClusterRole everywhere — be very careful |

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ci-deployer
  namespace: devquest-prod
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: deployer
  namespace: devquest-prod
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch", "update"]
  - apiGroups: [""]                       # "" = core group
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ci-deployer
  namespace: devquest-prod
subjects:
  - kind: ServiceAccount
    name: ci-deployer
    namespace: devquest-prod
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: deployer
```

```bash
kubectl auth can-i patch deployments -n devquest-prod --as=system:serviceaccount:devquest-prod:ci-deployer   # yes
kubectl auth can-i get secrets      -n devquest-prod --as=system:serviceaccount:devquest-prod:ci-deployer   # no
kubectl auth can-i --list -n devquest-prod --as=system:serviceaccount:devquest-prod:ci-deployer
```

* RBAC is **additive only** — there is no "deny" rule. Access = union of all bindings.
* Pods get their ServiceAccount's token mounted (short-lived, auto-rotated). Your ASP.NET API almost
  never talks to the Kubernetes API, so set `automountServiceAccountToken: false`.
* `get`/`list` on **secrets** is effectively "read every password in the namespace". `create pods`
  is effectively "run anything as any ServiceAccount in the namespace". Treat both as admin.
* Humans authenticate via **OIDC** (Google/Entra/Keycloak groups → RoleBindings), not shared
  kubeconfigs. With GitOps, humans need mostly **read** access to prod.

### RBAC patterns you'll actually write

**Humans by group, not by name.** Your identity provider puts people in groups; the cluster binds
groups to the built-in ClusterRoles `view`, `edit` and `admin`. When someone joins or leaves, only
the IdP changes:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: devs-view
  namespace: devquest-prod
subjects:
  - kind: Group
    name: devquest-devs                   # the group claim from OIDC (Entra / Google / Keycloak)
    apiGroup: rbac.authorization.k8s.io
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view                              # read most things, but NOT Secrets
```

The same group gets `edit` in `devquest-dev`. Note that a **RoleBinding may point at a
ClusterRole**: the permissions are then granted only inside the RoleBinding's namespace. That is
the standard way to *define a role once* (as a ClusterRole, e.g. your own `app-deployer`) and
*grant it per namespace*.

**Name the objects when you can.** `resourceNames` narrows a rule to specific objects. Example:
the worker uses a `Lease` for leader election, so only one replica runs the nightly scheduler:

```yaml
rules:
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    resourceNames: ["devquest-scheduler"]
    verbs: ["get", "update"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["create"]                     # create can't be limited by name: the name isn't known yet
```

**Know the verbs that are secretly admin.** Reviewers look for `*`; attackers look for these:

| Permission | Why it's dangerous |
|---|---|
| `get`/`list`/`watch` **secrets** | Reads every password and token in the namespace. `list` returns the values too |
| `create` **pods** (or Deployments, Jobs…) | Run any image, mount any Secret, use any ServiceAccount of the namespace |
| `create` **pods/exec**, **pods/attach** | A shell inside running pods, with their tokens and env |
| `bind`, `escalate` on roles | Grant yourself permissions you don't have |
| `impersonate` users/groups/serviceaccounts | Act as anyone, including cluster admins |
| `create` **serviceaccounts/token** | Mint tokens for a more powerful ServiceAccount |
| `nodes/proxy` | Talk to the kubelet API directly, bypassing most checks |

```bash
kubectl auth whoami                                     # who does the cluster think I am?
kubectl auth can-i --list -n devquest-prod --as=system:serviceaccount:devquest-prod:ci-deployer
kubectl get rolebindings,clusterrolebindings -A -o wide | grep -i ci-deployer   # where is it bound?
```

For a full audit ("who can read Secrets in `devquest-prod`?") teams use plugins like
`kubectl who-can` or `rbac-tool`. Pod identities for **cloud** APIs (S3, Key Vault, Cloud SQL) are
a separate layer, bound to the ServiceAccount through workload identity; see the Managed
Kubernetes lesson (ops-19).

:::quiz id=ops-16-q9 xp=15
The `ci-deployer` ServiceAccount in `devquest-prod` has `create` on `pods` but **no** access to
`secrets`. Can a leaked `ci-deployer` token be used to read the database password in the `pg-app`
Secret?
- [ ] No: RBAC checks the `secrets` permission, which it doesn't have
- [x] Yes: it can create a pod that mounts `pg-app` (or loads it with `envFrom`) and print it from the pod's logs or env
- [ ] Only if the pod runs as root
- [ ] Only with `pods/exec`
> RBAC authorizes the *API call*: "create a pod" is allowed, and the pod spec may reference any
> Secret in the namespace, because the kubelet, not the caller, fetches Secrets for pods. Reading
> the pod's logs needs `pods/log` (which a CI deployer often has too), but even without it the attacker can
> make the pod send the value anywhere. Running as root isn't needed, and `pods/exec` is just
> another way in. That's why `create pods` (and every controller that creates pods: Deployments,
> Jobs, CronJobs) counts as "can read every Secret in the namespace". Keep such rights for
> GitOps controllers, not for CI tokens.
:::

:::quiz id=ops-16-q1 xp=10
A developer has a RoleBinding to the built-in `edit` ClusterRole in `devquest-prod`. You add a
second Role that "denies" deleting deployments. What happens?
- [ ] The deny wins — deletes are blocked
- [x] Nothing changes — RBAC has no deny rules; permissions are the union of all bindings
- [ ] The two bindings conflict and both are ignored
- [ ] The API server rejects the new Role
> To restrict, remove or narrow the broad binding. For "deny"-style guardrails use admission
> policies (ValidatingAdmissionPolicy, Kyverno, Gatekeeper). "The deny wins" is the tempting
> answer because firewalls and cloud IAM work that way — but an RBAC rule can only *grant*; there
> is no field to express "deny", so the new Role is accepted and simply adds nothing.
:::

## NetworkPolicies: a firewall between pods

By default every pod can talk to every pod in every namespace. That means one compromised pod — say
the frontend nginx with a vulnerable module — can open a connection straight to Postgres. A
**NetworkPolicy** selects pods and allow-lists traffic; once a pod is selected by any policy for a
direction (Ingress = incoming, Egress = outgoing), all other traffic in that direction is
**denied**. Policies are additive like RBAC: several policies selecting the same pod add up. Enforcement requires a CNI that supports it (Cilium,
Calico, K3s's built-in policy controller, kind's kindnet in recent versions) — otherwise policies
are **silently ignored**.

```text
 traefik ns ──► web :8080 ─┐
           └──► api :8080 ─┼──► pg (cnpg.io/cluster=pg) :5432
                 worker ───┘          ▲ operator ns (cnpg-system) → :8000/:5432
 everything ──► kube-dns :53                      everything else: DENIED
```

```yaml
# 1. Default deny everything in the namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: devquest-prod
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# 2. …but every pod may resolve DNS
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: devquest-prod
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
---
# 3. Traefik may reach the API; the API may reach Postgres
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api
  namespace: devquest-prod
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: api }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: traefik }
      ports:
        - port: 8080             # the POD port, not the Service port
  egress:
    - to:
        - podSelector:
            matchLabels: { cnpg.io/cluster: pg }
      ports:
        - port: 5432
```

Note the YAML subtlety: `namespaceSelector` and `podSelector` in the **same** `- to:` item mean
"pods matching X *in* namespaces matching Y" (AND); as two separate list items they mean OR.

:::warn title="Default-deny and operators"
With default-deny, Postgres pods also lose ingress from **each other** (replication) and from the
**CloudNativePG operator** (status checks on port 8000). Add explicit policies for them before
enabling default-deny on a database namespace — and test failover afterwards.
:::

:::quiz id=ops-16-q2 xp=15
You apply a `default-deny` policy (Ingress + Egress) to `devquest-prod` and an "allow API → Postgres on
5432" egress policy. Now the API logs `Name or service not known: pg-rw`. Why?
- [ ] Postgres is down
- [x] Egress to CoreDNS (port 53 in kube-system) is now denied, so name resolution fails
- [ ] NetworkPolicies block Service names; use pod IPs
- [ ] The API needs a ClusterRole to resolve DNS
> Default-deny egress blocks DNS too. Always ship an `allow-dns` policy with default-deny. Note
> the error is a *DNS* error, not a connection timeout — a useful clue: if Postgres were down (the
> tempting answer) the name would still resolve and you'd see "connection refused" or a timeout.
> Service names work fine with policies once DNS is allowed, and RBAC has nothing to do with
> network traffic.
:::

### The full DevQuest policy set

The three policies above are the start. A complete set for `devquest-prod` is one policy per
workload, and each answers two questions: *who may call me?* and *whom may I call?*

| Pod | Ingress from | Egress to |
|---|---|---|
| `web` (nginx) | `traefik` namespace → 8080 | nothing (static files) |
| `api` | `traefik` → 8080; `monitoring` → 8080 (`/metrics`) | `pg` 5432; external HTTPS (Stripe) |
| `worker` | `monitoring` → metrics port | `pg` 5432; the queue |
| `pg` (CNPG) | `api`, `worker` → 5432; other `pg` instances (replication); `cnpg-system` → 8000/5432; `monitoring` → 9187 | allowed (see below) |
| everyone | — | `kube-dns` 53 |

Two of these deserve YAML. External HTTPS without the cluster's own ranges and without the cloud
**metadata endpoint** (`169.254.169.254`, the classic credential-theft target from a compromised
pod):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-external-https, namespace: devquest-prod }
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: api }
  policyTypes: [Egress]
  egress:
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254/32]
      ports:
        - { protocol: TCP, port: 443 }
```

And the database, which needs more than "apps may connect":

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: pg, namespace: devquest-prod }
spec:
  podSelector:
    matchLabels: { cnpg.io/cluster: pg }
  policyTypes: [Ingress, Egress]
  ingress:
    - from:                                     # the apps
        - podSelector:
            matchExpressions:
              - { key: app.kubernetes.io/name, operator: In, values: [api, worker] }
      ports: [{ port: 5432 }]
    - from:                                     # the other instances: streaming replication
        - podSelector: { matchLabels: { cnpg.io/cluster: pg } }
      ports: [{ port: 5432 }, { port: 8000 }]
    - from:                                     # the operator: status checks, switchover
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: cnpg-system }
      ports: [{ port: 8000 }, { port: 5432 }]
    - from:                                     # Prometheus scraping the Postgres exporter
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: monitoring }
      ports: [{ port: 9187 }]
  egress:
    - {}                                        # one empty rule = allow all egress for DB pods
```

Why allow all egress for Postgres? The CNPG instance manager talks to the **Kubernetes API** and
to **object storage** for WAL archiving. Expressing "the API server" in a plain NetworkPolicy is
awkward: policies see the API server's real endpoint IP and port (often 6443), not
`kubernetes.default:443`, and that IP differs per cluster. Cilium and Calico have their own
policy CRDs with selectors like "the kube-apiserver entity" or **FQDN rules**
(`toFQDNs: api.stripe.com`), which the built-in NetworkPolicy can't express. Plain NetworkPolicy
is L3/L4 only: IPs, ports, pod and namespace labels.

**Test them like code.** After every policy change, run the "should work" and "should fail"
checks from a throwaway pod with the right labels, as in lab 1 below. Cilium's Hubble or
Calico's flow logs show *which* policy dropped a packet, so you're not guessing.

:::info title="When NetworkPolicies aren't enough: service mesh and mTLS"
NetworkPolicies trust **labels and IPs**. Some teams need more: every pod-to-pod connection
encrypted and **authenticated** (mTLS), rules like "only `worker` may `POST /internal/jobs`",
and per-route retries and metrics. That's a **service mesh**: Istio (its sidecar-less *ambient*
mode, GA since Istio 1.24, is a common choice for new installs), Linkerd, or Cilium's mesh features. A mesh is
real operational weight (another control plane, certificate rotation, upgrade coordination), so
most SaaS teams start with NetworkPolicies and adopt a mesh when compliance (mTLS everywhere) or
L7 authorization requires it.
:::

:::quiz id=ops-16-q10 xp=15
You roll out `default-deny`, `allow-dns` and the `api` policy from above (Traefik in, Postgres out)
in `devquest-prod`. The app works perfectly, but the next morning the API's Grafana dashboards are
empty from the moment of the rollout, and none of the API's own alerts fired. What happened?
- [ ] Default-deny blocks the API's OTel exporter from reaching Grafana
- [x] Prometheus in the `monitoring` namespace can no longer scrape the API's `/metrics` on 8080, because no ingress rule allows it
- [ ] NetworkPolicies delete ServiceMonitors
- [ ] The API needs egress to Prometheus to push metrics
> Prometheus **pulls**: it opens a connection *to* the pod, so the pod needs an **ingress** allow
> from the `monitoring` namespace (the `monitoring` → 8080 row in the full table). Grafana never
> talks to the API (it queries Prometheus), and
> with the pull model the API doesn't push anywhere. (If you push via OTLP, it's the opposite: an
> egress allow to the collector.) No alert fired because the alert's data vanished: rules over
> missing series evaluate to *nothing*, not to "bad". That's why kube-prometheus-stack ships a
> `TargetDown` alert, and why the policy rollout checklist includes "dashboards still have data".
:::

## Pod Security Standards

**Why:** a container is just a process on the node with some isolation. Run it as root, privileged,
with the host's network or a `hostPath` mount, and an attacker who breaks into your app is one step
from owning the node — and every other pod on it. The **Pod Security Standards** define three
levels of "how much may a pod ask for"; the built-in **Pod Security Admission** controller checks
every new pod against them, per namespace, through labels:

| Level | Allows |
|---|---|
| `privileged` | Anything (system namespaces, CNI, storage drivers) |
| `baseline` | Blocks known escalations: privileged containers, hostPath, hostNetwork, added capabilities… |
| `restricted` | Baseline **plus**: must run as non-root, `allowPrivilegeEscalation: false`, drop `ALL` capabilities, `seccompProfile: RuntimeDefault`, limited volume types |

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: devquest-prod
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

The three modes: `enforce` rejects violating pods, `warn` lets them in but prints a warning to
whoever applied them, `audit` records them in the API audit log. A safe rollout on an existing
namespace is `warn`/`audit` first, fix the offenders, then `enforce`.

A `restricted`-compliant ASP.NET container (Microsoft's .NET 8+ images include a non-root `app`
user, UID 1654, and ASP.NET Core listens on **8080** by default — traditionally a non-root process can't bind
ports below 1024 without `NET_BIND_SERVICE` (newer runtimes relax this), so 8080 keeps you
independent of runtime settings; chiseled images run as `app` by default). We set `runAsUser` explicitly because
`runAsNonRoot` can only be verified for **numeric** UIDs:

```yaml
spec:
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1654
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: api
      image: ghcr.io/acme/devquest-api:1.4.2
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true        # not required by "restricted", but do it
        capabilities: { drop: ["ALL"] }
      volumeMounts:
        - { name: tmp, mountPath: /tmp }
  volumes:
    - name: tmp
      emptyDir: {}
```

For the frontend use `nginxinc/nginx-unprivileged` (listens on 8080 as UID 101) — exactly why the
Docker lessons' hardened images matter here. For rules beyond PSS ("images only from ghcr.io/acme",
"every Deployment needs resources and a PDB") use **ValidatingAdmissionPolicy** (built-in, CEL),
**Kyverno** or **OPA Gatekeeper**.

:::quiz id=ops-16-q3 xp=15
A namespace enforces `restricted`. Which pod specs are **rejected**? (select all)
- [x] A container without `securityContext` using `nginx:1.29-alpine` (runs as root)
- [x] A container with `capabilities: { add: ["NET_ADMIN"] }`
- [ ] A container with `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`
- [x] A pod mounting a `hostPath` volume
> Admission rejects the *pod*: for a Deployment you'll see the ReplicaSet failing to create pods
> (`kubectl describe rs` / events: `violates PodSecurity "restricted:latest"`) while the
> Deployment itself was accepted. Use the `warn` label first to find offenders. The root nginx
> fails several checks (no `runAsNonRoot`, no `allowPrivilegeEscalation: false`, capabilities not
> dropped, no seccomp profile); adding `NET_ADMIN` and `hostPath` are blocked even at `baseline`.
> The third pod is the tempting "it looks like a lot of settings, surely something's missing" one
> — but those four settings are exactly what `restricted` requires, so it's admitted
> (`readOnlyRootFilesystem` is recommended, not required).
:::

## Secrets management for real

Kubernetes Secrets are a delivery mechanism, not a vault: their values are only base64-encoded
(an encoding, not encryption), they sit in etcd (encrypted at rest only if someone turned that
on), and anyone with `get secrets` in the namespace can read them. Worse, a Secret YAML committed to
Git is a password in your Git history forever. The source of truth should be a secret manager with
audit logs, rotation and access policies. Common patterns:

| Approach | How it works | Trade-offs |
|---|---|---|
| **External Secrets Operator (ESO)** | `ExternalSecret` CRs say "fetch `devquest/prod/stripe` from Vault / AWS Secrets Manager / Azure Key Vault / GCP / 1Password / Infisical every hour into Secret `api-secrets`" | Most popular; secret values never in Git; needs a store |
| **Vault** (HashiCorp / OpenBao) | Central store, dynamic DB credentials, PKI. Consumed via ESO, the Vault Secrets Operator, Agent injector or CSI driver | Powerful; you operate Vault (HA, unseal, backups) |
| **Sealed Secrets** | Encrypt with the in-cluster controller's public key → commit `SealedSecret` → controller decrypts into a Secret | Simple GitOps, no external store; rotation and multi-cluster are manual |
| **SOPS** (+ age/KMS) | Encrypt values in YAML files in Git; Flux (or Argo CD plugins) decrypt on apply | Git-native; key distribution is on you |

So the rule is not "no secrets in Git" but **"no plaintext secret values in Git"**. Sealed Secrets
and SOPS deliberately commit *ciphertext* (useless without a key that lives elsewhere); ESO and
Vault keep even that out and commit only *references*. A plain `Secret` manifest, base64 or
`stringData`, is plaintext.

```yaml
apiVersion: external-secrets.io/v1
kind: ClusterSecretStore
metadata:
  name: vault
spec:
  provider:
    vault:
      server: https://vault.internal.example.com
      path: kv
      version: v2
      auth:
        kubernetes:                       # Vault trusts the cluster's ServiceAccount tokens
          mountPath: kubernetes
          role: external-secrets
          serviceAccountRef:
            name: external-secrets
            namespace: external-secrets
---
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: api-secrets
  namespace: devquest-prod
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: vault
  target:
    name: api-secrets                     # the Kubernetes Secret ESO creates and keeps in sync
    creationPolicy: Owner
  data:
    - secretKey: Stripe__ApiKey
      remoteRef: { key: devquest/prod/stripe, property: api_key }
    - secretKey: Jwt__SigningKey
      remoteRef: { key: devquest/prod/jwt, property: signing_key }
```

When the secret rotates, ESO updates the Kubernetes Secret — but env vars don't refresh (ops-12).
Mount as files, or let a controller like **Reloader** roll the Deployment when its Secret changes.

Above, Vault trusts the cluster's ServiceAccount tokens. With a cloud secret store (AWS Secrets
Manager, Azure Key Vault, GCP Secret Manager) the same idea is called **workload identity**: ESO's
ServiceAccount is mapped to a cloud role, so there is no static access key anywhere to leak.
Setting that up per provider is in ops-19.

:::job title="What 'secrets in prod' looks like at most SaaS companies"
Developers never see prod values. Vault (or the cloud's secret manager) holds them; ESO syncs them;
RBAC limits who can read Kubernetes Secrets; etcd encryption is on; DB passwords for apps come from
the operator (CNPG's `pg-app` Secret) or Vault's dynamic database engine; and the Git repo contains
only `ExternalSecret` references — safe to show on a screen-share.
:::

:::quiz id=ops-16-q4 xp=10
With External Secrets Operator, what is stored in the GitOps repository?
- [ ] The base64-encoded Secret
- [x] `ExternalSecret` / `SecretStore` manifests that **reference** keys in the external store — no secret values
- [ ] The Vault root token
- [ ] Nothing — ESO is configured only through its UI
> Git holds pointers and policies; values live in Vault/KMS. That's what lets the whole cluster
> config be public-to-the-team and reviewable. The base64 Secret is the tempting answer because it
> "looks" encoded — but base64 is reversible by anyone (`base64 -d`), so that's a plaintext
> password in Git. A Vault root token in Git would be even worse, and ESO has no UI: it's
> configured entirely through CRDs.
:::

## Observability: metrics, logs, traces

**Why:** "Is it working?" has three different answers that need three different kinds of data.
**Metrics** are cheap numbers over time (requests/s, error %, queue length) — great for dashboards
and alerts, useless for *one* request. **Logs** are events with detail — great for "what happened",
expensive to search at scale. **Traces** follow one request across services (API → Postgres →
Stripe) with timings — the only way to answer "where did the time go?". Linking them through a
shared **trace id** is what turns three tools into one investigation.

| Signal | Stack | Answers |
|---|---|---|
| **Metrics** | Prometheus (+ Operator), Alertmanager, Grafana — usually via the **kube-prometheus-stack** Helm chart (includes node-exporter and kube-state-metrics) | "Is it healthy? How fast? Is the queue growing?" |
| **Logs** | **Loki** + Grafana **Alloy** (collector; replaces Promtail) as a DaemonSet reading container stdout | "What exactly happened in request X?" |
| **Traces** | **OpenTelemetry** SDK in the app → OTel Collector → Tempo / Jaeger | "Where did these 800 ms go — API, Postgres, Stripe?" |

Prometheus discovers what to scrape through CRDs:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: api
  namespace: devquest-prod
  labels:
    release: kube-prometheus-stack      # must match the Prometheus' selector
spec:
  selector:
    matchLabels: { app.kubernetes.io/name: api }
  endpoints:
    - port: http
      path: /metrics
      interval: 30s
```

In ASP.NET Core, OpenTelemetry instruments requests, HttpClient calls, the runtime and Npgsql:

```csharp
// NuGet: OpenTelemetry.Extensions.Hosting, OpenTelemetry.Instrumentation.AspNetCore,
// OpenTelemetry.Instrumentation.Http, OpenTelemetry.Instrumentation.Runtime,
// OpenTelemetry.Exporter.OpenTelemetryProtocol, Npgsql.OpenTelemetry,
// OpenTelemetry.Exporter.Prometheus.AspNetCore (still pre-release — see the tip below)
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("devquest-api"))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddPrometheusExporter())            // serves /metrics for the ServiceMonitor
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddNpgsql())
    .UseOtlpExporter();                      // OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability:4317

app.MapPrometheusScrapingEndpoint();
```

:::tip title="Pull or push?"
The Prometheus exporter makes Prometheus *pull* `/metrics` (that's what the ServiceMonitor
configures). The alternative many teams prefer: drop `AddPrometheusExporter`, let
`UseOtlpExporter()` *push* metrics too, and have the OTel Collector forward them to Prometheus
(remote write / OTLP receiver). One protocol, one endpoint, no pre-release package.
:::

Log **structured JSON to stdout** (`builder.Logging.AddJsonConsole()` or Serilog) with the trace
id, and Grafana can jump from a log line to its trace and back. Why stdout and not files? The
container runtime already captures stdout per container; the log collector (Alloy) reads it from
the node, so the app needs no log files, no rotation and no volume.

Alerts worth having on day one (most ship with kube-prometheus-stack, CNPG, cert-manager):

* pods crash-looping / not ready for > 10 min; Deployment replicas mismatched
* HPA at `maxReplicas` for 15 min (you're capacity-bound); KEDA queue **age** growing
* API **error rate** and **p95 latency** (RED: Rate, Errors, Duration) vs your SLO
* CNPG: **WAL archiving failing**, replication lag, backups older than 26 h
* certificate expiring in < 14 days; node disk / memory pressure; PVC > 80 % full

:::pro title="Alert on symptoms, page on user pain"
Senior teams split alerts in two: **pages** (wake someone up) only for things users feel *now* —
error rate or p95 latency burning through the SLO, the site down, backups/WAL archiving broken
(data loss risk). Everything else ("one pod restarted", "CPU at 85 %") is a **ticket** or a
dashboard. An on-call rotation that's paged for noise learns to ignore pages — and then misses the
real one. Every page should link to a runbook that says what to check first.
:::

### Kubernetes alerts as code: PrometheusRule

Two exporters turn the cluster itself into metrics, and both ship with kube-prometheus-stack:

* **kube-state-metrics** reads the *API objects* and exposes their state: desired vs available
  replicas, container waiting reasons (`CrashLoopBackOff`, `ImagePullBackOff`), restarts, HPA
  current vs max, Job failures, PVC phase. It answers "what does Kubernetes think?".
* **node-exporter** (a DaemonSet) and the kubelet's **cAdvisor** expose node and container usage:
  CPU, memory, throttling, disk, network. They answer "what is actually being used?".

Alert rules are Kubernetes objects too, so they live in Git next to the app and go through review
like any manifest:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: devquest-api
  namespace: devquest-prod
  labels:
    release: kube-prometheus-stack            # same selector rule as ServiceMonitors
spec:
  groups:
    - name: devquest-api
      rules:
        - alert: DevquestPodCrashLooping
          expr: max_over_time(kube_pod_container_status_waiting_reason{namespace="devquest-prod", reason="CrashLoopBackOff"}[5m]) >= 1
          for: 10m
          labels: { severity: ticket }
          annotations:
            summary: "{{ $labels.pod }} is crash-looping"
            runbook_url: https://wiki.example.com/runbooks/crashloop
        - alert: DevquestHpaMaxedOut
          expr: |
            kube_horizontalpodautoscaler_status_current_replicas{namespace="devquest-prod"}
              >= kube_horizontalpodautoscaler_spec_max_replicas{namespace="devquest-prod"}
          for: 15m
          labels: { severity: ticket }
          annotations:
            summary: "HPA {{ $labels.horizontalpodautoscaler }} has been at maxReplicas for 15 min"
        # SLO: 99.9 % of API requests succeed. Page when the error budget burns 14.4× too fast
        # (≈ 2 % of a 30-day budget in 1 h), confirmed by a short window so it also resolves fast.
        - alert: DevquestApiErrorBudgetBurn
          expr: |
            (
              sum(rate(http_server_request_duration_seconds_count{namespace="devquest-prod", service="api", http_response_status_code=~"5.."}[1h]))
              / sum(rate(http_server_request_duration_seconds_count{namespace="devquest-prod", service="api"}[1h]))
            ) > (14.4 * 0.001)
            and
            (
              sum(rate(http_server_request_duration_seconds_count{namespace="devquest-prod", service="api", http_response_status_code=~"5.."}[5m]))
              / sum(rate(http_server_request_duration_seconds_count{namespace="devquest-prod", service="api"}[5m]))
            ) > (14.4 * 0.001)
          for: 2m
          labels: { severity: page }
          annotations:
            summary: "API is burning its error budget 14× faster than allowed"
            runbook_url: https://wiki.example.com/runbooks/api-errors
```

Notice the `severity` labels: Alertmanager routes `page` to the on-call phone and `ticket` to a
channel or the issue tracker, exactly the split from the box above. The first two alerts are
*cause* alerts (useful, not urgent); only the SLO burn is a *symptom* that users feel right now.

:::info title="Where observability goes deeper"
This section covers the Kubernetes-specific half: what kube-state-metrics knows, ServiceMonitors,
alert rules as manifests. The cloud-native track's **cl-08** covers the rest in depth: RED/USE,
OpenTelemetry context propagation from React through the API to the worker, PromQL you'll write
weekly, SLOs and error budgets (where the 14.4 comes from), exemplars from a latency spike to the
trace, and Loki and Tempo hands-on.
:::

## GitOps: reconciliation, applied to Git

GitOps is the ops-09 mental model one level up: **Git holds the desired state**, and a controller
in the cluster (**Argo CD** or **Flux**) continuously pulls it and reconciles the cluster toward it.

**Why not just `kubectl apply` from CI?** Push-style deploys work, but CI then needs powerful
cluster credentials (a juicy target), nobody notices when someone `kubectl edit`s prod by hand, and
"what is running right now?" has no reliable answer. With GitOps the answer is always "whatever is
on `main` in the GitOps repo", and drift is detected and reverted automatically.

```text
 developer PR ──► app repo ──► CI: test, build, scan, push ghcr.io/acme/devquest-api:<sha>
                                        │
                                        └─► commit "api: <sha>" to the GitOps repo (overlays/dev)
                                                         │
 Argo CD (in cluster) ◄── watches ──────────────────────┘
      │ diff Git vs cluster → sync → rollout → health checks
      ▼
 dev ✔ ──► promotion PR (overlays/prod newTag: <sha>) ──► review/approve ──► Argo syncs prod
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: devquest-prod
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/acme/devquest-gitops.git
    targetRevision: main
    path: deploy/overlays/prod            # Kustomize detected automatically (Helm charts work too)
  destination:
    server: https://kubernetes.default.svc
    namespace: devquest-prod
  syncPolicy:
    automated:
      prune: true        # delete resources removed from Git
      selfHeal: true     # revert manual drift (kubectl edit) back to Git
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
```

Benefits: every change is a reviewed commit (audit trail), rollback = `git revert`, the cluster can
be rebuilt from Git, and CI no longer needs cluster-admin credentials (Argo pulls; CI only pushes
to Git). **ApplicationSets** generate one Application per environment/cluster; Flux expresses the
same with `GitRepository` + `Kustomization` CRs.

### Repos, environments and promotion

Most teams split **two kinds of repo**: the *app repo* (source code, Dockerfile, tests; CI builds
images) and the *GitOps repo* (the Kustomize bases and overlays from ops-14, plus `platform/` for
Traefik, CNPG, ESO, kube-prometheus-stack). Argo CD watches only the GitOps repo. Splitting them
keeps "a code change" and "a deploy" as separate, separately reviewed commits, and lets platform
people review infrastructure changes without wading through C#.

```text
devquest-gitops/
├── apps/                          # Argo CD objects ("app of apps")
│   └── devquest.yaml              # ApplicationSet: one Application per environment
├── deploy/
│   ├── base/
│   └── overlays/{dev,staging,prod}/
└── platform/{traefik,cnpg,external-secrets,kube-prometheus-stack}/
```

Instead of writing one Application per environment by hand, an **ApplicationSet** generates them:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: devquest
  namespace: argocd
spec:
  goTemplate: true
  generators:
    - list:
        elements:
          - { env: dev,     autoSync: true }
          - { env: staging, autoSync: true }
          - { env: prod,    autoSync: false }    # prod syncs after a human clicks (or a promotion PR merges)
  template:
    metadata:
      name: 'devquest-{{ .env }}'
    spec:
      project: devquest
      source:
        repoURL: https://github.com/acme/devquest-gitops.git
        targetRevision: main
        path: 'deploy/overlays/{{ .env }}'
      destination:
        server: https://kubernetes.default.svc
        namespace: 'devquest-{{ .env }}'
  templatePatch: |
    {{- if .autoSync }}
    spec:
      syncPolicy:
        automated: { prune: true, selfHeal: true }
    {{- end }}
```

**Promotion** is a Git change, never a rebuild: CI bumps `overlays/dev` (below), and once dev is
healthy, a PR copies the *same* SHA tag into `overlays/staging`, then `overlays/prod`. The image
that reaches prod is byte-for-byte the one that was tested. Teams automate the PRs with
Renovate, Argo CD Image Updater or Kargo, but the principle stays: **every environment's state is
a reviewed commit**. The `project: devquest` is an **AppProject**, Argo CD's own guardrail: it
limits which repos, clusters, namespaces and resource kinds this team's Applications may touch,
so a typo in an overlay can't deploy into `kube-system`.

### Ordering a sync: waves and hooks

Argo CD applies everything in an Application together by default. Some things must happen in
order: the Secret must exist before the pods that read it, and the schema migration must finish
before the new code starts. Two annotations handle that:

```yaml
# 1. ExternalSecret first (wave -1), so the Secret exists when the pods start
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: api-secrets
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
---
# 2. Migration Job as a PreSync hook: runs before ANY normal resource is applied
apiVersion: batch/v1
kind: Job
metadata:
  name: api-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation   # recreate on every sync
spec:
  backoffLimit: 1
  activeDeadlineSeconds: 600
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: ghcr.io/acme/devquest-migrations:1.4.2   # kustomize `images:` bumps this with the API
          envFrom: [{ secretRef: { name: api-secrets } }]
```

Within a sync, Argo CD runs `PreSync` hooks, then the resources wave by wave (lower first, waiting
for each wave to be **healthy**), then `PostSync` hooks (smoke tests, a Slack message). If the
PreSync migration fails, the sync fails and **the new Deployment is never applied**: the old
version keeps running on the old schema. That's the GitOps twin of the Helm `pre-upgrade` hook
from ops-14 and the Job pattern from ops-13. One gotcha: hooks run *before* wave −1, so a
first-ever sync of a new environment needs the `api-secrets` Secret to exist already (or the
ExternalSecret made a PreSync hook itself, ordered before the Job with a lower `sync-wave`), the
same trap as with Helm hooks.

**HPA and GitOps.** If an HPA owns `replicas`, remove `spec.replicas` from the Deployment in Git
(ops-15). When a chart insists on rendering it, tell Argo CD to ignore the field instead of
fighting the HPA on every sync:

```yaml
spec:
  ignoreDifferences:
    - group: apps
      kind: Deployment
      jsonPointers: [/spec/replicas]
  syncPolicy:
    syncOptions: [RespectIgnoreDifferences=true]
```

:::quiz id=ops-16-q11 xp=15
`devquest-prod` syncs a new commit: image tag `1.5.0` plus a PreSync migration Job. The migration
fails (a duplicate key prevents a new unique index). What state is prod in?
- [ ] Half-migrated: the new pods are running against the old schema
- [x] The sync is marked failed, the Deployment still runs `1.4.2`, and the Job's logs explain why; fix the data or the migration and push a new commit
- [ ] Argo CD rolls the database back automatically
- [ ] The old pods are deleted because `prune: true` removes resources that don't match Git
> PreSync hooks gate the whole sync: Argo CD never applied the new Deployment spec, so the
> running ReplicaSet still has `1.4.2` and keeps serving. No tool rolls back a database for you.
> That's why migrations should be transactional where possible (Postgres DDL is) and
> expand/contract-shaped, so a half-finished release never needs one. `prune` only deletes
> resources that are no longer *in Git*; the Deployment still is. Read the evidence with
> `kubectl -n devquest-prod logs job/api-migrate`.
:::

### The CI/CD deploy flow in practice

The last step of the app repo's GitHub Actions workflow, after the image
`ghcr.io/acme/devquest-api:${{ github.sha }}` was pushed:

```yaml
      - name: Bump the dev image tag in the GitOps repo
        env:
          # fine-grained PAT or GitHub App token: contents:write on devquest-gitops ONLY
          GITOPS_TOKEN: ${{ secrets.GITOPS_TOKEN }}
        run: |
          git clone "https://x-access-token:${GITOPS_TOKEN}@github.com/acme/devquest-gitops.git"
          cd devquest-gitops/deploy/overlays/dev
          kustomize edit set image ghcr.io/acme/devquest-api=ghcr.io/acme/devquest-api:${GITHUB_SHA}
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -am "dev: devquest-api ${GITHUB_SHA::7}"
          git pull --rebase && git push        # another service may have pushed in the meantime
```

Notice the CI token can write to *one Git repo* — it never holds a kubeconfig. Tag images with the
commit SHA (immutable, traceable), never `latest`, so the GitOps commit says exactly what runs.

* **Database migrations**: run as a Job before the rollout (Argo `PreSync` hook above, or Helm
  `pre-upgrade`), and write **expand/contract** migrations so old and new pods can run side by
  side during the rollout (details in the next section).
* **Manifest gates**: the PR to the GitOps repo runs the schema, lint and policy checks from
  ops-14, and Argo CD shows the diff before prod syncs.
* **Supply chain**: scan images (Trivy), sign them (cosign), generate SBOMs — and verify at
  admission with Kyverno.

:::quiz id=ops-16-q5 xp=10
Prod is managed by Argo CD with `selfHeal: true`. During an incident someone runs
`kubectl scale deploy api --replicas=10` (no HPA). A minute later replicas are back at 3. Why?
- [ ] The scheduler ran out of capacity
- [x] Argo CD detected drift from Git (which says 3) and reverted it
- [ ] kubectl changes expire after 60 s
- [ ] The ReplicaSet controller ignores manual scaling
> Self-heal is reconciliation: Git is desired state. For emergencies, pause auto-sync on that app
> (and say so in the incident channel) or — better — change Git. Long term: an HPA, with
> `spec.replicas` removed from Git (and Argo told to ignore the field). It's not a capacity
> problem (the pods would be `Pending`, not removed), kubectl changes don't "expire", and the
> ReplicaSet controller *did* honour your scale — until Argo wrote 3 back.
:::

## Progressive delivery: canary, blue-green and safe migrations

A rolling update (ops-10) protects you from pods that **don't start**: an unready pod stops the
rollout. It does nothing about pods that start fine and are **wrong**: a 5 % error rate on
checkout, a 3× slower report query. By the time a human looks at a dashboard, 100 % of traffic is
on the new version. Progressive delivery adds the missing step: **expose a little traffic, measure,
then decide automatically.**

| Strategy | How | Rollback | Costs |
|---|---|---|---|
| **Rolling** (default) | Replace pods gradually; gate = readiness | Another rollout | Nothing extra, but no metrics judgment and no traffic % |
| **Blue-green** | Run the full new version beside the old; switch the Service/route at once | Instant: switch back | 2× capacity during the release; both versions share the DB |
| **Canary** | Route 5–10 % of traffic to the new version, widen in steps while metrics stay good | Route 0 % back to it | Needs traffic splitting and good metrics |
| **Feature flags** | Ship the code dark; enable per tenant/user at runtime | Flip the flag | Flag debt in the code; needs a flag service |

You already wrote a manual canary in ops-11: an `HTTPRoute` with `weight: 90` / `weight: 10`.
**Argo Rollouts** (or Flagger) automates the steps and the decision. A `Rollout` can take over an
existing Deployment's pod template (`workloadRef`), move the route weights, and run an
**analysis** against Prometheus between steps:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: api
  namespace: devquest-prod
spec:
  replicas: 6
  selector:
    matchLabels: { app.kubernetes.io/name: api }
  workloadRef:                         # reuse the Deployment's pod template (Argo scales it down)
    apiVersion: apps/v1
    kind: Deployment
    name: api
    scaleDown: progressively
  strategy:
    canary:
      stableService: api               # Rollouts adjusts both Services' selectors
      canaryService: api-canary
      trafficRouting:
        plugins:
          argoproj-labs/gatewayAPI:    # moves the weights in the HTTPRoute from ops-11
            httpRoute: devquest
            namespace: devquest-prod
      steps:
        - setWeight: 10
        - analysis:
            templates: [{ templateName: api-success-rate }]
        - setWeight: 50
        - pause: { duration: 10m }
        - setWeight: 100
---
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: api-success-rate
  namespace: devquest-prod
spec:
  metrics:
    - name: success-rate
      interval: 1m
      count: 5                          # 5 measurements, one per minute
      failureLimit: 1                   # a second bad measurement aborts the rollout
      successCondition: result[0] >= 0.99
      provider:
        prometheus:
          address: http://kube-prometheus-stack-prometheus.monitoring:9090
          query: |
            sum(rate(http_server_request_duration_seconds_count{service="api-canary", http_response_status_code!~"5.."}[2m]))
            /
            sum(rate(http_server_request_duration_seconds_count{service="api-canary"}[2m]))
```

If the success rate drops below 99 %, Rollouts **aborts**: weight back to 0 %, canary scaled down,
stable untouched, and the Rollout shows `Degraded`. Nobody was paged; 10 % of users saw errors for
a few minutes instead of 100 % for half an hour. (The Git commit still says the new tag, so the
follow-up is the usual `git revert` or a fix.)

### Where migrations fit: expand / contract

Every strategy above has one thing in common: **old and new code run at the same time against the
same database**, for minutes (rolling), an hour (canary) or until you switch (blue-green). And a
rollback means the *old* code runs against the *new* schema. So a migration that renames or drops
something the old code uses breaks the old pods the moment the PreSync Job finishes, before the
canary gets its first request.

The rule: **the schema after release N must work with the code of release N−1.** Spread breaking
changes over several releases:

| Release | Migration (PreSync Job) | Code | Safe to roll back to the previous release? |
|---|---|---|---|
| N: **expand** | Add `display_name` (nullable) | Writes both `title` and `display_name`, reads `title` | Yes: old code ignores the new column |
| N+1: **migrate** | Backfill `display_name` from `title` | Still writes both, now reads `display_name` | Yes: N reads `title`, which N+1 keeps writing |
| N+2: **stop using the old column** | (none) | Reads and writes only `display_name` | Yes: N+1 reads `display_name` too |
| N+3: **contract** | Drop `title` | Unchanged | Yes: N+2 never touches `title` |

Only run the contract step once N+2 has been fully rolled out and you're past the point where
you would roll back to N+1 (which still writes `title`). That's slower than one big migration, and it is the price of
zero-downtime deploys with any of these strategies.

:::quiz id=ops-16-q12 xp=15
Release `1.6.0` ships a PreSync migration `ALTER TABLE courses RENAME COLUMN title TO name` and
an Argo Rollouts canary (10 % → analysis → 50 % → 100 %). What happens right after the sync starts?
- [ ] Nothing bad: only the 10 % canary uses the new column, and the analysis would catch errors
- [x] The 90 % stable pods (old code) start failing on every query that uses `title` as soon as the migration commits, before the canary takes traffic
- [ ] Argo Rollouts detects the schema change and pauses
- [ ] The canary fails its analysis and the migration is rolled back
> The migration runs **before** the rollout, against the shared database, so the old code, which
> still says `title`, breaks immediately for everyone. The canary only limits exposure to the new
> *code*, not to the new *schema*. Rollouts knows nothing about databases, and aborting the
> canary doesn't undo DDL. The expand/contract version: add `name`, write both, backfill, switch
> reads, and drop `title` releases later.
:::

## Upgrading clusters

Kubernetes ships ~3 minor releases a year; each is supported for ~14 months. Falling behind means
unpatched CVEs and a painful multi-version jump later.

1. **Read the changelog** for removed APIs; scan manifests and Helm releases (`pluto`, `kubent`) and
   check add-on compatibility (Traefik, cert-manager, CNPG, KEDA, CSI drivers).
2. **Back up**: etcd snapshot (`k3s etcd-snapshot save` on K3s), and verify DB backups.
3. **Control plane first**, one minor version at a time (1.34 → 1.35 → 1.36). Kubelets may lag the
   API server by up to three minors, never lead it — that's the **version skew policy**: a newer
   kubelet might use API features the older API server doesn't know yet.
4. **Nodes one by one**: `kubectl cordon` → `kubectl drain` (PDBs keep apps available) → upgrade →
   `uncordon`. Or replace nodes with new ones from an updated image. On K3s the
   **system-upgrade-controller** automates this with `Plan` CRs.
5. Watch dashboards and alerts between each step; upgrade dev → staging → prod.

On **managed** clusters the provider upgrades the control plane (on your click, or automatically
on a release channel) and rolls node pools for you, and etcd backups are its job. Steps 1, 4 and 5
are still yours: removed APIs, add-on compatibility, PDBs that let nodes drain, and watching the
rollout. Provider specifics are in ops-19.

:::quiz id=ops-16-q6 xp=10
Which upgrade order is correct?
- [ ] Upgrade kubelets on all nodes first, then the API server
- [x] Control plane first (one minor at a time), then nodes one by one with cordon + drain
- [ ] Jump the control plane straight from 1.33 to 1.36, then nodes
- [ ] All nodes and the control plane at the same time to minimise skew
> The API server must be the newest component; kubelets may be older (within the skew policy) but
> never newer — so kubelets-first is backwards. Minor versions can't be skipped on the control
> plane (the skew policy and tools like kubeadm only support one-minor steps, and each release
> assumes the previous one's changes — e.g. stored object versions — are already in place). "Everything
> at once" sounds tidy but removes your ability to stop halfway and turns one bad step into a full
> outage.
:::

## The troubleshooting playbook

Start every investigation with the same four commands, then follow the symptom:

```bash
kubectl get pods -n <ns> -o wide                  # STATUS, RESTARTS, READY, NODE
kubectl describe pod <pod> -n <ns>                # Events at the bottom tell you most of it
kubectl logs <pod> -n <ns> [-c <container>] --previous
kubectl get events -n <ns> --sort-by=.lastTimestamp | tail -20
```

| Symptom | Means | Typical causes → fix |
|---|---|---|
| **Pending** | Not scheduled | `Insufficient cpu/memory` (requests too big, cluster full → CA); untolerated **taint**; nodeSelector/affinity matches no node; PVC unbound (StorageClass, zone) |
| **ErrImagePull / ImagePullBackOff** | kubelet can't pull | Typo in name/tag; tag doesn't exist; private registry without `imagePullSecrets`; `Always` with a side-loaded image; wrong architecture (`exec format error` comes later, at start) |
| **CreateContainerConfigError** | Can't build the container config | Referenced **Secret/ConfigMap or key missing** (ESO not synced yet?) |
| **CrashLoopBackOff** | Starts, exits, repeat | Read `logs --previous`: missing config, can't reach DB at startup, migrations failing, bad command; liveness probe killing a slow starter (events: `Liveness probe failed`) |
| **OOMKilled** (exit 137) | Memory limit hit | Raise limit or fix leak; check .NET heap vs limit |
| **Running but 0/1 READY** | Readiness failing | Wrong probe path/port; dependency down; probe timeout too short under CPU throttling |
| **Service gives no response** | No endpoints | Selector ≠ pod labels; pods not Ready; `targetPort` ≠ container port |
| **Ingress 404** | No route matched | Host/path mismatch; wrong `ingressClassName`; prefix not stripped (app-level 404) |
| **Ingress 502/503/504** | Route OK, backend not | 503: no ready endpoints; 502: app closed connection/crashed; 504: app too slow |
| **DNS errors** | Name resolution fails | Wrong namespace in name; NetworkPolicy blocking port 53; CoreDNS crashing/throttled |
| **Stuck Terminating** | Finalizer not done | Controller that owns the finalizer is gone (uninstalled operator); inspect `metadata.finalizers` before removing anything |
| **Evicted** | Node pressure | Disk full (logs, emptyDir, images) or memory; BestEffort pods go first |

```bash
kubectl run tmp -it --rm --image=busybox:1.37 --restart=Never -- sh   # test DNS/HTTP from inside
kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container> # tcpdump, dig, curl in its netns
kubectl get endpointslices -l kubernetes.io/service-name=<svc>
kubectl describe node <node>                                            # allocated resources, taints, pressure
```

`kubectl debug` adds an **ephemeral container** to a running pod — the way to get `dig`/`curl`
next to a chiseled image that has no shell. In a `restricted` namespace the debug container must
comply too: add `--profile=restricted` (tools that need root or `NET_RAW`, like `tcpdump`, then
won't work — debug those on a dev cluster or via a node debug pod with `kubectl debug node/<node>`).

### Follow the request, hop by hop

"The site is down" is not a symptom table row. A request crosses six hops, and each one can be
tested on its own. Test from the **inside out**: once a hop works, everything below it is cleared.

```text
 browser ─► DNS/LB ─► Ingress controller ─► Service ─► EndpointSlice ─► Pod port ─► app
            (cloud)    (Traefik pods)        (ClusterIP) (ready pod IPs)  (targetPort) (route, auth)
```

| Hop | Test | A failure here looks like |
|---|---|---|
| App inside the pod | `kubectl port-forward pod/<pod> 8080:8080` then `curl localhost:8080/ready` | 500s, wrong route (`404` from Kestrel), slow responses |
| Pod port | `kubectl get pod <pod> -o jsonpath='{.spec.containers[*].ports}'` vs Service `targetPort` | Connection refused through the Service, fine via port-forward |
| EndpointSlice | `kubectl get endpointslices -l kubernetes.io/service-name=api` | Empty, or all `ready: false`: selector mismatch or readiness failing |
| Service | From a debug pod in a namespace that's *allowed* to call (e.g. `kubectl -n traefik run t -it --rm --image=busybox:1.37 --restart=Never -- wget -qO- http://api.devquest-prod/api/health`) | Works from an allowed namespace but times out from others: that's NetworkPolicy doing its job |
| Ingress controller | `kubectl -n traefik logs deploy/traefik`; `kubectl describe ingress devquest` | `404` (no route: host, path, `ingressClassName`), `502/503/504` (backend) |
| DNS / load balancer | `dig app.example.com`; `kubectl -n traefik get svc` (`EXTERNAL-IP`) | Name doesn't resolve, `<pending>` external IP, TLS errors (cert-manager `Certificate` not Ready) |

### When a rollout is stuck

```bash
kubectl -n devquest-prod rollout status deploy/api --timeout=30s   # "Waiting for … 1 old replicas are pending termination"
kubectl -n devquest-prod describe deploy api      # Conditions: Progressing=False / ProgressDeadlineExceeded?
kubectl -n devquest-prod describe rs -l app.kubernetes.io/name=api   # quota and Pod Security rejections show HERE
kubectl -n devquest-prod get pods -l app.kubernetes.io/name=api      # then the new pods' own status → symptom table
```

The ReplicaSet step is the one people skip: when pods are **rejected at admission** (ResourceQuota
from ops-12, Pod Security above, a Kyverno policy) they never exist, so `get pods` shows nothing
new and the only evidence is the ReplicaSet's events. With Argo CD, also check the Application's
sync status: a failed PreSync hook means the Deployment was never updated at all.

### Nodes

```bash
kubectl get nodes                                   # NotReady? SchedulingDisabled (cordoned)?
kubectl describe node <node>                        # Conditions: MemoryPressure, DiskPressure, PIDPressure; Allocated resources
kubectl top nodes                                   # real usage vs the requests the scheduler sees
kubectl debug node/<node> -it --image=busybox:1.37  # a pod in the node's namespaces; the host's filesystem is at /host
# inside: chroot /host journalctl -u kubelet --since "15 min ago" | tail -50   (works where the node image has journald)
```

A `NotReady` node's pods are marked for eviction after ~5 minutes (the default
`tolerationSeconds: 300` on the `node.kubernetes.io/not-ready` and `…/unreachable` taints). StatefulSet pods on it are
*not* replaced automatically until the node is confirmed gone, because two pods with the same
identity must never run at once (ops-13).

:::job title="Incident hygiene: what seniors do in the first ten minutes"
1. **Stop the bleeding before finding the cause.** If a deploy just happened, roll back first
   (`git revert` of the tag bump; or `kubectl rollout undo` with Argo CD auto-sync paused, and say
   so in the incident channel). Root cause can wait; customers can't.
2. **Capture evidence before you destroy it.** Deleting a crashing pod deletes its
   `logs --previous`. Save `kubectl describe`, `logs --previous` and `get events` to files first.
3. **One person types, everyone else reads.** Two people "fixing" prod in parallel create the
   second incident. Post every command and its result in the channel: that's your timeline.
4. **Afterwards, a blameless postmortem** with one question per hop: why didn't an alert, a
   canary analysis, a CI gate (ops-14) or a policy catch this earlier?
:::

:::quiz id=ops-16-q13 xp=15
From a debug pod in the `traefik` namespace (which the NetworkPolicies allow to reach the API),
`wget -qO- http://api.devquest-prod/api/health` returns `200`. Through
`https://app.example.com/api/health` you get a Traefik `404 page not found`. Which hop is broken?
- [ ] The pods: readiness must be failing
- [ ] A NetworkPolicy blocks Traefik from reaching the API
- [x] The ingress route: no rule matches this host/path (wrong `host`, path, or `ingressClassName`), so Traefik never picks a backend
- [ ] DNS: `app.example.com` resolves to the wrong IP
> The request from inside proves the app, the pod port, the EndpointSlice, the Service and the
> NetworkPolicy path from Traefik's namespace. Traefik answered, so DNS and the load balancer got
> you to Traefik (a wrong IP wouldn't produce a *Traefik* 404). A NetworkPolicy block or unready
> pods would show up as `502/503/504` (and the test above already ruled them out): Traefik found
> the route but couldn't reach a backend. A `404` from the controller means no route
> matched: compare `kubectl describe ingress` (host, paths, class) with the URL, and check
> Traefik's logs for an ignored Ingress.
:::

:::quiz id=ops-16-q7 xp=15
A new API version's pods show `CreateContainerConfigError`. `describe` says:
`Error: couldn't find key Stripe__ApiKey in Secret devquest-prod/api-secrets`. The previous
version is still running fine. What's going on, and what's the right move?
- [ ] The image is corrupt — rebuild it
- [x] The new pod spec references a key that the Secret doesn't have (yet) — add it to the secret store/ExternalSecret first, or mark the reference `optional: true`
- [ ] The node is out of memory
- [ ] RBAC prevents the kubelet from reading Secrets
> Config and code must be deployed in the right order: secret first, then the version that needs
> it. The rollout stalls because the new pods never become Ready; with `maxUnavailable: 0` no old
> pod is removed until a new one is Ready, so the old pods keep serving while you fix it. (With the
> default `maxUnavailable: 25%` a big Deployment would already have lost a quarter of its old
> pods.) A corrupt image would show `ErrImagePull` or a crash, not a config error; memory pressure
> shows as `Evicted`/`OOMKilled`; and the kubelet reads Secrets for pods via the node authorizer,
> not via your RBAC.
:::

:::quiz id=ops-16-q8 xp=15
Pods are `Pending` with: `0/4 nodes are available: 1 node(s) had untolerated taint
{node-role.kubernetes.io/control-plane: }, 3 node(s) didn't match Pod's node affinity/selector.`
What do you check first?
- [ ] The image tag
- [x] The pod's `nodeSelector`/affinity — no worker node carries the required label (e.g. `workload=worker` missing or misspelled)
- [ ] The Service selector
- [ ] The readiness probe
> The scheduler tells you exactly which filter failed for each node: 1 node is the control plane
> (tainted — expected), the other 3 "didn't match Pod's node affinity/selector". Compare
> `kubectl get nodes --show-labels` with the pod's `nodeSelector`. Image tag, Service selector and
> readiness probe only matter *after* a pod is scheduled — a `Pending` pod has not even reached a
> node yet.
:::

:::lab id=ops-16-lab1 xp=120
title: Lock it down — RBAC, Pod Security and NetworkPolicies
**1. A restricted namespace**

```bash
kubectl create namespace ops16
kubectl label namespace ops16 pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted
kubectl -n ops16 run rooty --image=nginx:1.29-alpine
# Error from server (Forbidden): … violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false, …
```

**2. Compliant workloads + policies.** Save as `secure.yaml`:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: ops16
spec:
  replicas: 1
  selector:
    matchLabels: { app.kubernetes.io/name: api }
  template:
    metadata:
      labels: { app.kubernetes.io/name: api }
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: api
          image: traefik/whoami:v1.10
          args: ["--port", "8080"]
          ports:
            - { name: http, containerPort: 8080 }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: ops16
spec:
  selector: { app.kubernetes.io/name: api }
  ports:
    - { name: http, port: 80, targetPort: http }
---
apiVersion: v1
kind: Pod
metadata:
  name: client
  namespace: ops16
  labels: { role: client }
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: sh
      image: busybox:1.37
      command: ["sleep", "3600000"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
---
apiVersion: v1
kind: Pod
metadata:
  name: intruder
  namespace: ops16
  labels: { role: intruder }
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: sh
      image: busybox:1.37
      command: ["sleep", "3600000"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: { drop: ["ALL"] }
```

```bash
kubectl apply -f secure.yaml
kubectl -n ops16 exec client   -- wget -qO- -T 3 http://api/ | head -2     # works
kubectl -n ops16 exec intruder -- wget -qO- -T 3 http://api/ | head -2     # works (no policies yet)
```

**3. Default deny + targeted allows.** Save as `netpol.yaml`:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny, namespace: ops16 }
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: allow-dns, namespace: ops16 }
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports:
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: api-from-client, namespace: ops16 }
spec:
  podSelector:
    matchLabels: { app.kubernetes.io/name: api }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { role: client } }
      ports:
        - port: 8080
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: client-to-api, namespace: ops16 }
spec:
  podSelector:
    matchLabels: { role: client }
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector: { matchLabels: { app.kubernetes.io/name: api } }
      ports:
        - port: 8080
```

```bash
kubectl apply -f netpol.yaml
kubectl -n ops16 exec client   -- wget -qO- -T 3 http://api/ | head -2     # still works
kubectl -n ops16 exec intruder -- wget -qO- -T 3 http://api/              # wget: download timed out
kubectl -n ops16 exec intruder -- nslookup api                              # DNS still works (allow-dns)
```

If the intruder still gets through, your CNI doesn't enforce policies (kind older than v0.24, or a
CNI like flannel without a policy controller) — note it and read on; current kind, K3s and
Cilium/Calico clusters enforce them.

**4. Least-privilege RBAC.** Copy the three RBAC objects (ServiceAccount, Role, RoleBinding) from the
RBAC section into `rbac.yaml`, then apply them with the namespace swapped and test:

```bash
sed 's/devquest-prod/ops16/g' rbac.yaml | kubectl apply -f -
# serviceaccount/ci-deployer created, role…/deployer created, rolebinding…/ci-deployer created
SA=system:serviceaccount:ops16:ci-deployer
kubectl auth can-i patch deployments -n ops16 --as=$SA     # yes
kubectl auth can-i get secrets -n ops16 --as=$SA           # no
kubectl auth can-i patch deployments -n default --as=$SA   # no
kubectl auth can-i --list -n ops16 --as=$SA
```

- [ ] A root nginx pod was rejected by Pod Security; my hardened pods were admitted
- [ ] After the policies, `client` reaches the API and `intruder` times out, while DNS still resolves
- [ ] `kubectl auth can-i` confirms `ci-deployer` can patch Deployments only in `ops16` and can't read Secrets
:::

:::lab id=ops-16-lab2 xp=150
title: The troubleshooting gauntlet
Apply this deliberately broken stack, then make **every pod Running and Ready** and
`http://web` respond — using only `get`, `describe`, `logs`, `events` and edits to the YAML (or a
`kubectl create secret`). Save as `gauntlet.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: gauntlet
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: gauntlet
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: nginx:1.29-alpinee
          ports:
            - { name: http, containerPort: 80 }
          readinessProbe:
            httpGet: { path: /, port: 8080 }
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: gauntlet
spec:
  selector: { app: frontend }
  ports:
    - { port: 80, targetPort: http }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: gauntlet
spec:
  replicas: 1
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: api
          image: traefik/whoami:v1.10
          envFrom:
            - secretRef: { name: api-secrets }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: gauntlet
spec:
  replicas: 1
  selector:
    matchLabels: { app: worker }
  template:
    metadata:
      labels: { app: worker }
    spec:
      containers:
        - name: worker
          image: busybox:1.37
          command: ["sh", "-c", "test -n \"$QUEUE_URL\" || { echo 'FATAL: QUEUE_URL is not set'; exit 1; }; echo consuming $QUEUE_URL; exec sleep 3600000"]
          resources:
            requests: { cpu: "48", memory: 64Mi }
```

```bash
kubectl apply -f gauntlet.yaml
kubectl -n gauntlet get pods
```

Work through it like an on-call engineer: for each pod, name the **status**, the **evidence**
(which command showed it) and the **fix**. Hints, if you need them:

* `web`: there are **three** independent problems between the image, the probe and the Service.
* `api`: read the status column carefully — the container was never created.
* `worker`: fix the reason it can't be *scheduled* first; then it will reveal a second problem
  (add an `env` entry `QUEUE_URL=amqp://rabbitmq:5672`).

Verify the end state:

```bash
kubectl -n gauntlet get pods                                         # all Running, READY 1/1
kubectl -n gauntlet get endpointslices -l kubernetes.io/service-name=web
kubectl -n gauntlet run t -i --rm --image=busybox:1.37 --restart=Never -- wget -qO- http://web | grep title   # <title>Welcome to nginx!</title>
```

:::tip title="Spoilers — only after you tried"
web: `ImagePullBackOff` (tag `1.29-alpinee`) → readiness on 8080 but nginx listens on 80 →
Service selector `frontend` ≠ `web`. api: `CreateContainerConfigError` — create the Secret
(`kubectl -n gauntlet create secret generic api-secrets --from-literal=FOO=bar`). worker:
`Pending` (`Insufficient cpu`, 48 cores) → lower to `50m` → `CrashLoopBackOff` (`logs --previous`:
QUEUE_URL not set) → add the env var.
:::

- [ ] I identified all six problems with evidence from `describe`, `logs --previous` or events
- [ ] Every pod in `gauntlet` is Running and Ready
- [ ] `wget http://web` from inside the cluster returns the nginx page
:::

:::lab id=ops-16-lab3 xp=120
title: GitOps with Argo CD
You need a **public** GitHub repo `devquest-gitops` containing the Kustomize `base/` and
`overlays/` folders from ops-14 lab 1.

**1. Install Argo CD**

```bash
kubectl create namespace argocd
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd rollout status deploy/argocd-server
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n argocd port-forward svc/argocd-server 8081:443     # https://localhost:8081, user admin
```

**2. Point it at your repo.** Delete the namespaces you created by hand in ops-14
(`kubectl delete ns devquest-dev`), then save as `app-dev.yaml` and apply it:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: devquest-dev
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/<your-user>/devquest-gitops.git
    targetRevision: main
    path: overlays/dev
  destination:
    server: https://kubernetes.default.svc
    namespace: devquest-dev
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
```

**3. Feel the loop**

* Watch the app become **Synced / Healthy** in the UI (resource tree: Deployment → ReplicaSet → Pods).
* Drift: `kubectl -n devquest-dev scale deploy web --replicas=5` → Argo reverts it within moments.
* Change through Git: edit `overlays/dev/kustomization.yaml` (add `replicas: [{ name: web, count: 2 }]`),
  commit, push → Argo syncs (default poll ≤ 3 min; click **Refresh** to hurry).
* Roll back: `git revert HEAD && git push` → back to 1 replica.

- [ ] Argo CD shows `devquest-dev` Synced and Healthy
- [ ] A manual `kubectl scale` was reverted by self-heal
**4. Clean up before the boss fight.** The auto-sync Application would otherwise keep
"healing" `devquest-dev` back to the ops-14 manifests while ops-17 deploys into the same
namespace: `kubectl -n argocd delete application devquest-dev`, then `kubectl delete ns devquest-dev`
(Argo CD itself can stay).

- [ ] A Git commit changed the cluster, and `git revert` rolled it back
- [ ] I deleted the `devquest-dev` Application and namespace
:::

:::lab id=ops-16-lab4 xp=100
title: Alert on a crash loop with kube-state-metrics
Install the monitoring stack (Grafana switched off to save memory; the rest still needs ~1.5 GB
RAM on kind):

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace --set grafana.enabled=false \
  --set prometheus-node-exporter.hostRootFsMount.enabled=false \
  --wait --timeout 10m          # the hostRootFs flag avoids a node-exporter crash on Docker Desktop
kubectl -n monitoring get pods          # prometheus-…, alertmanager-…, kube-state-metrics-…, node-exporter (one per node)
kubectl -n monitoring get svc           # note kube-prometheus-stack-prometheus and …-alertmanager
```

**1. Ask kube-state-metrics a question.** Port-forward Prometheus and open http://localhost:9090:

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-prometheus 9090:9090
```

Run these queries in the UI:
`kube_deployment_status_replicas_available` (every Deployment in the cluster, including Argo CD
and CNPG if installed), and `kube_node_status_condition{condition="Ready",status="true"}`
(should be 3 series with value 1).

**2. Write the rule.** Save as `crashloop-rule.yaml` and apply it:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: lab-crashloop
  namespace: monitoring
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: lab
      rules:
        - alert: LabPodCrashLooping
          expr: max_over_time(kube_pod_container_status_waiting_reason{namespace="ops16-alerts", reason="CrashLoopBackOff"}[5m]) >= 1
          for: 1m
          labels: { severity: ticket }
          annotations:
            summary: "{{ $labels.pod }} in {{ $labels.namespace }} is crash-looping"
```

Check **Status → Rule health** (or **Alerts**) in the UI: `LabPodCrashLooping` should be listed
and *inactive*. If it's missing, the `release` label doesn't match the Prometheus' rule
selector: compare with `kubectl -n monitoring get prometheus -o yaml | grep -A3 ruleSelector`.

**3. Break something** (a separate namespace without Pod Security labels, so a plain busybox pod
is admitted):

```bash
kubectl create namespace ops16-alerts
kubectl -n ops16-alerts run crashy --image=busybox:1.37 --restart=Always -- sh -c 'echo boom; exit 1'
```

Watch **Alerts**: within ~1–2 minutes the alert goes **Pending** (the condition is true, `for`
is counting), then **Firing**. Open Alertmanager to see it routed:

```bash
kubectl -n monitoring port-forward svc/kube-prometheus-stack-alertmanager 9093:9093   # http://localhost:9093
```

**4. Resolve it.** `kubectl delete namespace ops16-alerts`. The alert resolves within a few
minutes: the series disappears, and `max_over_time(...[5m])` stops returning it once the last
sample is older than 5 minutes.

Keep the stack if your machine has the memory, or remove it with
`helm -n monitoring uninstall kube-prometheus-stack && kubectl delete namespace monitoring`.

- [ ] I queried kube-state-metrics in Prometheus and saw my Deployments and 3 Ready nodes
- [ ] My PrometheusRule was picked up (visible under Rule health) thanks to the `release` label
- [ ] The alert went Pending → Firing for the crash-looping pod, and appeared in Alertmanager
- [ ] After deleting the namespace the alert resolved
:::

## Code it: an RBAC authorizer

:::challenge id=ops-16-c1 lang=ts xp=60
title: Would RBAC allow this request?
Write `isAllowed(rules, req)`. A request is allowed if **any** rule matches all of:

* `apiGroups` contains `req.apiGroup` or `'*'` (the core group is `''`)
* `resources` contains `req.resource` or `'*'` (subresources are written like `'pods/log'`)
* `verbs` contains `req.verb` or `'*'`
* if the rule has a non-empty `resourceNames`, `req.name` must be in it (a request without a name
  — e.g. `list` — doesn't match such a rule)

There are no deny rules.

hint: `const has = (list: string[], v: string) => list.includes('*') || list.includes(v)`
hint: `rules.some(r => …)`

```ts starter
type Rule = { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] }
type Req = { apiGroup: string; resource: string; verb: string; name?: string }

export function isAllowed(rules: Rule[], req: Req): boolean {
  return rules.some((r) => r.resources.includes(req.resource) && r.verbs.includes(req.verb))
}
```

```ts solution
type Rule = { apiGroups: string[]; resources: string[]; verbs: string[]; resourceNames?: string[] }
type Req = { apiGroup: string; resource: string; verb: string; name?: string }

export function isAllowed(rules: Rule[], req: Req): boolean {
  const has = (list: string[], v: string) => list.includes('*') || list.includes(v)
  return rules.some((r) => {
    if (!has(r.apiGroups, req.apiGroup) || !has(r.resources, req.resource) || !has(r.verbs, req.verb)) return false
    if (r.resourceNames && r.resourceNames.length > 0) return req.name !== undefined && r.resourceNames.includes(req.name)
    return true
  })
}
```

```ts tests
const deployer = [
  { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'patch'] },
  { apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list'] },
  { apiGroups: [''], resources: ['configmaps'], verbs: ['get'], resourceNames: ['api-config'] },
]
test('allows a matching verb on a resource', () => {
  expect(isAllowed(deployer, { apiGroup: 'apps', resource: 'deployments', verb: 'patch' })).toBe(true)
})
test('denies verbs that are not granted', () => {
  expect(isAllowed(deployer, { apiGroup: 'apps', resource: 'deployments', verb: 'delete' })).toBe(false)
})
test('the api group must match too', () => {
  expect(isAllowed(deployer, { apiGroup: 'apps', resource: 'pods', verb: 'get' })).toBe(false)
  expect(isAllowed(deployer, { apiGroup: '', resource: 'pods/log', verb: 'get' })).toBe(true)
})
test('secrets are not readable', () => {
  expect(isAllowed(deployer, { apiGroup: '', resource: 'secrets', verb: 'get' })).toBe(false)
})
test('resourceNames restrict to named objects', () => {
  expect(isAllowed(deployer, { apiGroup: '', resource: 'configmaps', verb: 'get', name: 'api-config' })).toBe(true)
  expect(isAllowed(deployer, { apiGroup: '', resource: 'configmaps', verb: 'get', name: 'other' })).toBe(false)
  expect(isAllowed(deployer, { apiGroup: '', resource: 'configmaps', verb: 'get' })).toBe(false)
})
test('wildcards', () => {
  const admin = [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }]
  expect(isAllowed(admin, { apiGroup: 'batch', resource: 'cronjobs', verb: 'delete' })).toBe(true)
})
```
:::

:::cards id=ops-16-cards1 xp=15 title="Production Kubernetes"
Q: Role vs ClusterRole vs RoleBinding?
A: Role = namespaced permissions; ClusterRole = cluster-wide or reusable; RoleBinding grants a (Cluster)Role to subjects within one namespace.
Q: Can RBAC deny?
A: No — it's additive only. Use admission policies for guardrails.
Q: How to test permissions?
A: kubectl auth can-i <verb> <resource> -n <ns> --as=system:serviceaccount:<ns>:<sa>
Q: What does a default-deny NetworkPolicy break that people forget?
A: DNS (egress to kube-dns on 53) — and for databases, replication/operator traffic.
Q: Pod Security levels?
A: privileged, baseline, restricted — enforced per namespace with pod-security.kubernetes.io/* labels.
Q: External Secrets Operator in one line?
A: Syncs values from Vault/cloud secret managers into Kubernetes Secrets based on ExternalSecret CRs in Git.
Q: Sealed Secrets vs SOPS?
A: Sealed Secrets: encrypted with an in-cluster controller key, decrypted by the controller. SOPS: values encrypted in files with age/KMS, decrypted by the deploy tool (Flux).
Q: The three observability signals and typical tools?
A: Metrics (Prometheus/Grafana), logs (Loki + Alloy), traces (OpenTelemetry → Tempo/Jaeger).
Q: GitOps in one sentence?
A: Git is the desired state; an in-cluster controller (Argo CD/Flux) pulls and continuously reconciles it, reverting drift.
Q: Upgrade order?
A: Control plane first, one minor at a time; then nodes one by one (cordon, drain, upgrade, uncordon).
Q: CreateContainerConfigError?
A: A referenced ConfigMap/Secret (or key) doesn't exist.
Q: Ingress 503 vs 502 vs 504?
A: 503 no ready endpoints; 502 backend broke the connection; 504 backend too slow.
Q: Which RBAC permissions are effectively admin in a namespace?
A: Read secrets; create pods (or anything that creates pods); pods/exec; bind/escalate; impersonate; serviceaccounts/token.
Q: Why does a default-deny policy set often break monitoring?
A: Prometheus pulls metrics: the pods need an ingress allow from the monitoring namespace.
Q: Secrets and Git — the precise rule?
A: No plaintext values in Git. Encrypted (Sealed Secrets, SOPS) is fine; references only (ESO) is better.
Q: kube-state-metrics vs node-exporter?
A: kube-state-metrics = state of API objects (replicas, waiting reasons, HPA). node-exporter/cAdvisor = actual resource usage.
Q: Argo CD sync waves and hooks?
A: PreSync hooks (e.g. migrations) first, then resources by sync-wave (lowest first, each wave healthy), then PostSync. A failed PreSync stops the sync.
Q: Canary vs blue-green?
A: Canary: small % of traffic, widen while metrics stay good. Blue-green: full second version, switch all at once, instant switch back.
Q: The expand/contract rule?
A: The schema after release N must work with the code of release N−1: add → backfill/switch reads → drop, across releases.
Q: Debugging order for "the site is down"?
A: Inside out: app (port-forward) → pod port → EndpointSlice → Service → Ingress route → DNS/LB.
:::

## Recap

- **RBAC**: least privilege per ServiceAccount, additive only, verify with `kubectl auth can-i`;
  disable token automount for apps; humans via OIDC groups bound to `view`/`edit`; treat
  `create pods`, `pods/exec` and secret reads as admin.
- **NetworkPolicies**: default-deny + one policy per workload (always DNS, monitoring scrapes,
  DB replication/operator; block the metadata IP); L3/L4 only; only enforced by capable CNIs. A
  service mesh adds mTLS and L7 rules when you need them.
- **Pod Security**: label namespaces `restricted`; run as non-root, drop capabilities, read-only FS.
- **Secrets**: source of truth in Vault/cloud KMS, delivered by External Secrets (or Sealed
  Secrets/SOPS for Git-native setups); never **plaintext** values in Git (encrypted with
  Sealed Secrets/SOPS is fine; references only, with ESO, is better).
- **Observability**: Prometheus + Grafana, Loki + Alloy, OpenTelemetry traces; kube-state-metrics
  for object state; alerts as `PrometheusRule`s in Git, paging only on SLO burn and data-loss
  risks (deep dive: cl-08).
- **GitOps**: app repo + GitOps repo; CI bumps tags in Git; ApplicationSets per environment;
  promotion = the same SHA in the next overlay; PreSync migrations and sync waves order a sync;
  rollback = `git revert`.
- **Progressive delivery**: canary with automated analysis (Argo Rollouts) or blue-green; works only
  with **expand/contract** migrations, because old and new code share the schema.
- **Upgrades**: control plane first, one minor at a time, drain nodes behind PDBs.
- **Troubleshooting**: `get → describe → logs --previous → events`, then the symptom table; for
  network issues go hop by hop from the inside out; for stuck rollouts read the ReplicaSet's
  events; stop the bleeding and save evidence before you fix.
