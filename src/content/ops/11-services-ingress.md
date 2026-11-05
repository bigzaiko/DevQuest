---
id: ops-11
title: Services, DNS & Ingress
level: intermediate
minutes: 75
xp: 150
summary: Stable networking for ephemeral pods — Service types, selectors and EndpointSlices, cluster DNS, Ingress with Traefik routing /api and /, TLS with cert-manager, and a first look at the Gateway API.
---

Pods come and go with new IPs every time (ops-10). Your React frontend, the API, the worker and
Postgres all need to find each other anyway — and users need **one** URL from the internet. This
lesson builds the networking stack from the inside out:

```text
 browser ──► https://app.example.com
               │
        ┌──────▼───────┐   L7: host + path routing, TLS
        │   Ingress    │   (Traefik / Gateway API)
        └──┬────────┬──┘
     /api  │        │  /
     ┌─────▼──┐  ┌──▼─────┐   L4: stable virtual IP + DNS name,
     │Service │  │Service │       load-balances across ready pods
     │  api   │  │  web   │
     └─┬──┬───┘  └──┬──┬──┘
       ▼  ▼         ▼  ▼     Pods (ephemeral IPs)
      api api      web web
```

## Services: a stable front for moving pods

A **Service** gives a set of pods a **stable virtual IP** (the ClusterIP) and a **DNS name**, and
load-balances connections across the pods its **selector** matches.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: ClusterIP              # default
  selector:
    app.kubernetes.io/name: api   # ← which pods
  ports:
    - name: http
      port: 80                 # the Service's port (what clients use)
      targetPort: http         # the container port — by name or number (8080)
```

| Field | Meaning |
|---|---|
| `port` | Port on the Service's virtual IP: `http://api:80` |
| `targetPort` | Port on the pods. Using the **named** container port (`http`) lets you change the number in one place |
| `nodePort` | (NodePort/LoadBalancer only) Port opened on **every node**, 30000–32767 |

### How it actually works

There is no process listening on the ClusterIP. Instead:

1. The **EndpointSlice controller** continuously finds pods matching the selector and writes
   their IPs and ports into EndpointSlice objects, each address with a `ready` condition that
   mirrors the pod's readiness.
2. **kube-proxy** on every node watches Services + EndpointSlices and programs the kernel
   (iptables or nftables rules; the older IPVS mode is deprecated — or Cilium replaces kube-proxy
   with eBPF) so packets to `ClusterIP:port` are rewritten (DNAT) to one of the **ready** pod IPs.
   Not-ready addresses stay in the slice but receive no traffic.

```text
Service api (10.96.14.2:80) ──► EndpointSlice api-x7k2
                                  10.244.1.17:8080  ready ✔
                                  10.244.2.9:8080   ready ✔
                                  10.244.2.11:8080  ready ✘  (excluded from traffic)
```

```bash
kubectl get svc api
kubectl get endpointslices -l kubernetes.io/service-name=api
kubectl describe svc api        # "Endpoints:" line lists ready addresses — empty means NO traffic will flow
```

So a Service is not a proxy you could `exec` into — it's a *rule* replicated to every node. That's
why it scales so well, and why `ping <ClusterIP>` usually fails (only the Service's ports are
rewritten, ICMP is not) even when HTTP to it works fine.

:::warn title="Empty endpoints = the #1 Service bug"
A Service whose endpoints are empty silently drops/refuses connections. Two causes, every time:
1. the **selector doesn't match** the pod labels (typo, `app` vs `app.kubernetes.io/name`), or
2. pods match but **aren't Ready** (failing readiness probe).
Check with `kubectl get pods -l <the selector> --show-labels`.
:::

Because it's L4 connection balancing, a single long-lived connection (HTTP/2, gRPC, WebSockets,
a SignalR hub) sticks to one pod. That's fine for most apps; gRPC-heavy systems add L7 balancing.

### Service types

| Type | Reachable from | Typical use |
|---|---|---|
| **ClusterIP** (default) | Inside the cluster only | API ↔ Postgres, frontend ↔ API inside the cluster — almost everything |
| **NodePort** | `<any-node-IP>:30000–32767` | Bare-metal / local clusters (our kind setup), behind an external LB |
| **LoadBalancer** | An external IP from the cloud / ServiceLB / MetalLB | Exposing the **ingress controller** itself; rarely each app |
| **ExternalName** | DNS CNAME to an outside host | Pointing `db` to a managed database hostname |
| **Headless** (`clusterIP: None`) | DNS returns pod IPs directly, no virtual IP | StatefulSets (`pg-0.pg`), client-side balancing |

Headless is not a separate `type` — it's a ClusterIP Service with `clusterIP: None`. The first
three types build on each other: a NodePort Service also gets a ClusterIP, and a LoadBalancer
Service also gets a NodePort and a ClusterIP (the cloud LB forwards to the node ports).

Concrete example — the same Service exposed three ways:

```yaml
# inside only:  http://api.devquest:80
spec: { type: ClusterIP, selector: { app: api }, ports: [{ port: 80, targetPort: 8080 }] }
# + every node: http://<node-ip>:30081
spec: { type: NodePort,  selector: { app: api }, ports: [{ port: 80, targetPort: 8080, nodePort: 30081 }] }
# + a cloud IP: http://<external-ip>:80
spec: { type: LoadBalancer, selector: { app: api }, ports: [{ port: 80, targetPort: 8080 }] }
```

:::job title="One LoadBalancer, many apps"
Cloud load balancers cost money and IPs. Teams expose **one** LoadBalancer Service — the ingress
controller (Traefik on K3s, where ServiceLB/klipper-lb or a Hetzner LB fronts it) — and route every
app through Ingress rules. App Services stay `ClusterIP`. On EKS, AKS and GKE that one
LoadBalancer Service is where cloud-specific **annotations** decide public vs internal, the load
balancer type and health checks; the Managed Kubernetes lesson (ops-19) shows them per provider.
:::

:::quiz id=ops-11-q1 xp=10
Your ASP.NET API should be reachable by the frontend pods and the worker, **but not from outside
the cluster**. Which Service type?
- [x] ClusterIP
- [ ] NodePort
- [ ] LoadBalancer
- [ ] ExternalName
> ClusterIP is internal-only and the default. NodePort and LoadBalancer both *add* external
> reachability (a port on every node / a public IP) — the opposite of what's asked. ExternalName
> doesn't select pods at all; it's a DNS alias to a host *outside* the cluster. External traffic
> for the API, when you want it, enters through the ingress controller, which talks to the
> ClusterIP Service.
:::

:::quiz id=ops-11-q2 xp=15
`kubectl describe svc api` shows `Endpoints: <none>`, yet `kubectl get pods` shows three Running,
Ready API pods. Which manifest pair explains it?

```yaml
# Service
spec:
  selector:
    app: api
---
# Deployment pod template
metadata:
  labels:
    app.kubernetes.io/name: api
```
- [x] The Service selects `app=api`, but the pods only carry `app.kubernetes.io/name=api`
- [ ] Services need `type: LoadBalancer` to get endpoints
- [ ] The pods must be in the `kube-system` namespace
- [ ] Endpoints only appear after the first request
> Selectors match labels exactly — key and value — and `app` and `app.kubernetes.io/name` are two
> different keys. Fix the Service selector (preferred) or add the label. `kubectl get pods -l
> app=api` returning nothing proves it. The other options are myths: every Service type gets
> endpoints, pods live in your app's namespace (the Service must be in the *same* one), and
> endpoints are computed from labels and readiness, not from traffic.
:::

## Cluster DNS

CoreDNS (in `kube-system`) gives every Service a name:

```text
<service>.<namespace>.svc.cluster.local
   api   . devquest  .svc.cluster.local   →  10.96.14.2   (ClusterIP)
   pg-rw . devquest  .svc.cluster.local   →  primary Postgres (CloudNativePG, ops-13)
   pg-0.pg.devquest.svc.cluster.local     →  one StatefulSet pod via a headless Service
```

A ClusterIP is stable, but nobody wants `10.96.14.2` in a config file — and it changes if the
Service is deleted and re-created. A DNS name survives both, which is why apps always use names.

Each pod's `/etc/resolv.conf` has **search domains** — suffixes the resolver tries appending to
short names. For a pod in namespace `devquest` they are `devquest.svc.cluster.local
svc.cluster.local cluster.local`:

```text
lookup "api"           → tries api.devquest.svc.cluster.local           ✔ found
lookup "api.devquest"  → tries api.devquest.devquest.svc.cluster.local  ✘
                         then api.devquest.svc.cluster.local            ✔ found
```

So from the same namespace `http://api` works, and from another namespace `http://api.devquest`
works.

So in the cluster your ASP.NET connection string is simply `Host=pg-rw;Database=app;…` — no IPs.

:::pro title="ndots and DNS latency"
Pods default to `ndots:5`: a name with fewer than 5 dots is tried against every search domain
first. `api.stripe.com` becomes 3–4 failed lookups before the real one. High-traffic services
calling external APIs use fully-qualified names with a trailing dot (`api.stripe.com.`) or lower
`ndots` in `dnsConfig`. Also: "it's always DNS" — CoreDNS pods being throttled or crashing breaks
everything at once.
:::

:::quiz id=ops-11-q3 xp=10
A pod in namespace `jobs` must call the Service `api` in namespace `devquest` on port 80. Which
URL works?
- [ ] `http://api`
- [x] `http://api.devquest` (or the full `api.devquest.svc.cluster.local`)
- [ ] `http://devquest/api`
- [ ] `http://10.244.1.17` (a pod IP)
> The first search domain in the caller's `resolv.conf` is its *own* namespace, so a bare `api`
> becomes `api.jobs.svc.cluster.local` — which doesn't exist (or worse, is a different `api`).
> `api.devquest` matches the `svc.cluster.local` search domain and resolves. DNS names have no
> path-like `/namespace` syntax, and pod IPs change on every restart — never hard-code them.
:::

## Ingress: HTTP routing into the cluster

Why not just make every app a LoadBalancer Service? Because each one costs a public IP and a cloud
load balancer, and a Service only understands IPs and ports (L4). It can't say "`/api` goes here,
`/` goes there", terminate TLS for `app.example.com`, or redirect HTTP to HTTPS. Those are **L7**
(HTTP-level) decisions, so you want one smart reverse proxy at the edge — like the nginx in front
of your compose stack — configured by Kubernetes objects.

An **Ingress** object describes L7 rules: *"requests for host X and path Y go to Service Z"*, plus
TLS. By itself it does **nothing** — it needs an **ingress controller** (a reverse proxy running in
the cluster that watches Ingress objects and configures itself — another controller loop!).

| Controller | Notes |
|---|---|
| **Traefik** | Default in K3s. Watches Ingress, its own `IngressRoute` CRDs and Gateway API. Middlewares for redirects, auth, rate limits, prefix stripping |
| ingress-nginx | Was the most common one; the Kubernetes project **retired it in 2026** (no more fixes). You'll still meet it in older clusters — plan migrations to Traefik / Gateway API |
| HAProxy, Contour, Cilium, cloud LBs (AWS ALB, GKE) | Other common choices |

An **IngressClass** names the controller; `spec.ingressClassName` picks one.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: devquest
spec:
  ingressClassName: traefik
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /api              # /api, /api/, /api/tasks/42 …
            pathType: Prefix
            backend:
              service:
                name: api
                port:
                  name: http
          - path: /                 # everything else → the Vite SPA served by nginx
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  name: http
```

* `pathType: Prefix` matches by path *segments* (`/api` matches `/api` and `/api/x` but not
  `/apis`); `Exact` matches one path only (`/api` matches `/api`, not `/api/`);
  `ImplementationSpecific` is up to the controller — avoid it for portability.
* The **longest matching path wins**, so `/api` beats `/` regardless of the order you write them
  (on a tie, `Exact` beats `Prefix`).
* A rule without `host` applies to every hostname; with `host`, the request's `Host` header must
  match. That's why the lab's `curl` sets `-H "Host: …"`.

:::quiz id=ops-11-q8 xp=15
An Ingress has `path: /api`, `pathType: Prefix` → Service `api`, and `path: /` → Service `web`.
Which requests reach the **api** Service? Select all that apply.
- [x] `/api`
- [x] `/api/tasks/42`
- [ ] `/apis/health`
- [ ] `/apiv2/users`
- [x] `/api/`
> `Prefix` compares whole path **segments** split on `/`, not raw strings. `/api`, `/api/` and
> `/api/tasks/42` all start with the segment `api`. `/apis/health` and `/apiv2/users` start with
> different segments (`apis`, `apiv2`), so they fall through to the next-longest match, `/` → `web`.
> The tempting mistake is to think of it as a string `startsWith`, which would wrongly send
> `/apis` to the API.
:::

:::pro title="Same origin = no CORS"
Serving the React app and the API under **one host** (`/` and `/api`) means the browser sees a
single origin: no CORS preflights, cookies just work, and the Vite build can call `fetch('/api/…')`
in every environment. In dev, Vite's `server.proxy` imitates the same layout.
:::

### Path prefixes and your ASP.NET routes

The Ingress forwards the **full path**: `/api/tasks` arrives at the API as `/api/tasks`. Either map
your endpoints under `/api` (`app.MapGroup("/api")`) — simplest — or strip the prefix at the proxy.
With Traefik that's a Middleware CRD:

```yaml
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: strip-api
  namespace: devquest
spec:
  stripPrefix:
    prefixes: ["/api"]
---
# on the Ingress:
metadata:
  annotations:
    traefik.ingress.kubernetes.io/router.middlewares: devquest-strip-api@kubernetescrd
```

Also tell ASP.NET it's behind a proxy. TLS ends at Traefik, so the API sees plain `http` from a
cluster IP; Traefik passes the original scheme and client IP in `X-Forwarded-Proto` /
`X-Forwarded-For`. Without honouring them, redirects, `HttpContext.Request.Scheme`, OAuth callback
URLs and logged client IPs are all wrong.

```csharp
using Microsoft.AspNetCore.HttpOverrides;

builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // By default only loopback proxies are trusted — Traefik is another pod, so its headers
    // would be silently ignored. Empty lists = trust any sender (stricter alternative: add
    // only your pod CIDR, e.g. 10.244.0.0/16 on kind, to KnownIPNetworks):
    o.KnownIPNetworks.Clear();   // .NET 10 name (KnownNetworks in .NET 8/9)
    o.KnownProxies.Clear();
});

var app = builder.Build();
app.UseForwardedHeaders();      // first in the pipeline, before auth/redirect middleware
```

(Setting the env var `ASPNETCORE_FORWARDEDHEADERS_ENABLED=true` does the same.) Clearing the
lists means the API trusts these headers from *any* caller that can reach it. A `ClusterIP`
Service keeps the internet out, but by default every other pod in the cluster can still reach it
and send a forged `X-Forwarded-For` / `X-Forwarded-Proto`. In production, either add only the
ingress controller's pod CIDR to `KnownIPNetworks`, or add a NetworkPolicy (ops-16) that lets only
Traefik reach the API.

:::quiz id=ops-11-q4 xp=15
You applied an Ingress, but `curl` to the node returns *connection refused* and
`kubectl get ingress` shows an empty `ADDRESS`. The Services and pods are fine. Most likely?
- [ ] Ingress objects need a `LoadBalancer` Service per app
- [x] No ingress controller is running (or `ingressClassName` names a class no controller handles)
- [ ] The pods' readiness probes are failing
- [ ] DNS isn't configured inside the cluster
> An Ingress is just data. No controller watching that class = no proxy = nothing listening, and
> nobody fills in `ADDRESS` (the controller writes it into the Ingress status). Failing readiness
> would give a 503 from a running proxy, not *connection refused*; you never need a LoadBalancer per
> app; and DNS inside the cluster isn't involved when you curl a node. Check
> `kubectl get ingressclass` and the controller's pods (`kubectl get pods -A | grep -i traefik`).
:::

## TLS with cert-manager

**cert-manager** is an operator that obtains and renews certificates. You declare *where* certs
come from (an `Issuer`/`ClusterIssuer`: Let's Encrypt ACME, your own CA, Vault…), and it creates
`Certificate` objects → TLS Secrets → which the ingress controller serves.

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account
    solvers:
      - http01:
          ingress:
            ingressClassName: traefik
```

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: devquest
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod   # cert-manager watches this
spec:
  ingressClassName: traefik
  tls:
    - hosts: [app.example.com]
      secretName: devquest-tls        # cert-manager creates + renews this Secret
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: web, port: { name: http } }
```

The flow: annotation → cert-manager creates a `Certificate` → an ACME `Order` + `Challenge` →
Let's Encrypt fetches `http://app.example.com/.well-known/acme-challenge/…` (served via a temporary
solver Ingress) → certificate stored in `devquest-tls` → renewed automatically once two-thirds of
its lifetime has passed (≈30 days before expiry for today's 90-day Let's Encrypt certs; Let's
Encrypt is shortening lifetimes, which is one more reason never to renew by hand). Use the
**staging** ACME server (`https://acme-staging-v02.api.letsencrypt.org/directory`) while
experimenting — production has strict rate limits. Wildcards (`*.example.com`) need the
**DNS-01** solver, which proves control by creating a DNS TXT record via your DNS provider's API.

:::warn title="Debugging certs"
`kubectl get certificate,certificaterequest,order,challenge -A` walks the chain. A Challenge stuck
`pending` usually means Let's Encrypt can't reach port 80 on your hostname (DNS not pointing at the
LB, firewall, or HTTP→HTTPS redirect misconfigured).
:::

## Gateway API: the successor to Ingress

Ingress is small: anything beyond host/path (header matching, traffic splitting, timeouts) became
controller-specific annotations. The **Gateway API** (`gateway.networking.k8s.io/v1`, GA) is the
role-oriented replacement, supported by Traefik, Cilium, Envoy Gateway, Istio, cloud LBs:

| Object | Owned by | Says |
|---|---|---|
| `GatewayClass` | infrastructure provider | "Traefik implements gateways" |
| `Gateway` | platform / cluster operator | "listen on :443 for `*.example.com` with this cert; allow routes from these namespaces" |
| `HTTPRoute` | app team | "`/api` → Service `api`, 90 % to v1 and 10 % to v2" |

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: devquest
  namespace: devquest
spec:
  parentRefs:
    - name: public            # a Gateway owned by the platform team
      namespace: traefik
  hostnames: ["app.example.com"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /api }
      backendRefs:
        - name: api
          port: 80
          weight: 90
        - name: api-canary
          port: 80
          weight: 10
    - matches:
        - path: { type: PathPrefix, value: / }
      backendRefs:
        - name: web
          port: 80
```

The Ingress API itself is stable but **frozen** — it gets no new features; all new routing
features land in Gateway API. New projects increasingly start with Gateway API; Ingress isn't going
away soon and is what most existing clusters (and this course's labs) use.

:::quiz id=ops-11-q5 xp=10
In the Gateway API model, which object does an **application team** normally write?
- [ ] GatewayClass
- [ ] Gateway
- [x] HTTPRoute
- [ ] IngressClass
> App teams own routes; the platform team owns the Gateway (listeners, certificates, which
> namespaces may attach); the provider ships the GatewayClass. The Gateway is the tempting wrong
> answer because it "exposes the app" — but it is shared infrastructure for many apps, which is
> exactly why it's split from the routes. IngressClass belongs to the older Ingress API.
:::

:::lab id=ops-11-lab1 xp=120
title: Traefik on kind — route /api and / through one host
You need the `devquest` kind cluster from ops-09 (context `kind-devquest`) (with ports 8080/8443 mapped to NodePorts
30080/30443) and **Helm** (`brew install helm`, `winget install Helm.Helm`, or the script on
helm.sh — Helm itself is covered in ops-14).

**1. Install Traefik as a NodePort service**

```bash
helm repo add traefik https://traefik.github.io/charts
helm repo update
helm install traefik traefik/traefik --namespace traefik --create-namespace \
  --set service.type=NodePort \
  --set ports.web.nodePort=30080 \
  --set ports.websecure.nodePort=30443
kubectl -n traefik rollout status deployment/traefik
kubectl get ingressclass          # traefik   traefik.io/ingress-controller
```

(On k3d, Traefik is already installed and exposed on 8080/8443 — skip this step.)

**2. Deploy two apps and their Services.** `traefik/whoami` stands in for the API (it echoes the
request it receives); nginx stands in for the frontend. Save as `apps.yaml`:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: devquest
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: devquest
spec:
  replicas: 2
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
          ports:
            - name: http
              containerPort: 8080
          readinessProbe:
            httpGet: { path: /, port: http }
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: devquest
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
  namespace: devquest
spec:
  replicas: 2
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
          readinessProbe:
            httpGet: { path: /, port: http }
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: devquest
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
  namespace: devquest
spec:
  ingressClassName: traefik
  rules:
    - host: devquest.localhost
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api
                port: { name: http }
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port: { name: http }
```

```bash
kubectl apply -f apps.yaml
kubectl -n devquest get deploy,svc,ingress
kubectl -n devquest get endpointslices
```

**3. Test the routing.** Browsers resolve `*.localhost` to 127.0.0.1; for curl we set the Host
header explicitly:

```bash
curl -s -H "Host: devquest.localhost" http://127.0.0.1:8080/api/tasks | head -12
curl -s -H "Host: devquest.localhost" http://127.0.0.1:8080/ | grep -o "<title>.*</title>"
```

Expected: the first prints whoami's echo including `GET /api/tasks` and `Hostname: api-…`
(run it a few times — the hostname alternates between the two pods); the second prints
`<title>Welcome to nginx!</title>`. Open `http://devquest.localhost:8080/` in a browser too.

The path of one request: your machine `:8080` → kind's port mapping → NodePort `30080` on the
control-plane node → Traefik pod → (Traefik reads the EndpointSlices itself and picks a ready
`api` pod IP) → whoami. Most ingress controllers balance across pod IPs directly like this, rather
than going through the Service's ClusterIP.

**4. DNS and endpoints from inside**

```bash
kubectl -n devquest run dnsdebug -it --rm --image=busybox:1.37 --restart=Never -- sh
# inside the pod:
nslookup api.devquest.svc.cluster.local     # full name → the Service's ClusterIP
wget -qO- http://api/hello | head -3        # short name works thanks to the search domains
cat /etc/resolv.conf
exit
```

Expected: `nslookup` answers with `Address: 10.96.x.x` — the same IP as `CLUSTER-IP` in
`kubectl -n devquest get svc api`, **not** a pod IP. `wget` prints whoami's first lines
(`Hostname: api-…`, `IP: 127.0.0.1`, …), and `resolv.conf` shows
`search devquest.svc.cluster.local svc.cluster.local cluster.local` and `options ndots:5`.
(BusyBox's own `nslookup` doesn't always apply search domains, so `nslookup api` may fail even
though `wget http://api` works — the fully qualified name is the reliable test.)

**5. Watch endpoints follow readiness.** In one terminal:
`kubectl -n devquest get endpointslices -l kubernetes.io/service-name=api -w`. In another:

```bash
kubectl -n devquest scale deploy api --replicas=0   # endpoints empty → /api now fails
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: devquest.localhost" http://127.0.0.1:8080/api/tasks
kubectl -n devquest scale deploy api --replicas=3   # three addresses appear as pods become Ready
```

With zero endpoints the `curl` prints `503` (Traefik keeps the route but has no server to send to;
if your Traefik is configured to drop empty services you get a `404` from the `/` → nginx route
instead). Either way: no ready pods = no traffic, and nothing in the Ingress changed.

- [ ] `/api/...` reaches whoami and `/` reaches nginx through Traefik on port 8080
- [ ] `nslookup api.devquest.svc.cluster.local` inside the cluster resolves to the Service's ClusterIP
- [ ] I watched EndpointSlice addresses disappear and reappear while scaling
- [ ] I can explain why the request arrived at the API with the `/api` prefix intact
:::

:::lab id=ops-11-lab2 xp=80
title: Local HTTPS with cert-manager and your own CA
Continue in the same cluster.

**1. Install cert-manager**

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace \
  --set crds.enabled=true
kubectl -n cert-manager rollout status deploy/cert-manager-webhook
```

**2. Bootstrap a local CA** — a self-signed issuer signs a CA certificate, and a CA issuer then
signs app certificates. Save as `issuers.yaml`:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: selfsigned
spec:
  selfSigned: {}
---
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: devquest-ca
  namespace: cert-manager
spec:
  isCA: true
  commonName: devquest-local-ca
  secretName: devquest-ca
  privateKey:
    algorithm: ECDSA
    size: 256
  issuerRef:
    name: selfsigned
    kind: ClusterIssuer
    group: cert-manager.io
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: devquest-ca
spec:
  ca:
    secretName: devquest-ca
```

```bash
kubectl apply -f issuers.yaml
kubectl get clusterissuer        # both READY True
```

**3. Ask for a certificate via the Ingress.** Add to the `devquest` Ingress in `apps.yaml`:

```yaml
metadata:
  name: devquest
  namespace: devquest
  annotations:
    cert-manager.io/cluster-issuer: devquest-ca
spec:
  ingressClassName: traefik
  tls:
    - hosts: [devquest.localhost]
      secretName: devquest-tls
  # rules: unchanged
```

```bash
kubectl apply -f apps.yaml
kubectl -n devquest get certificate -w           # READY becomes True
kubectl -n devquest get secret devquest-tls
curl -sk --resolve devquest.localhost:8443:127.0.0.1 https://devquest.localhost:8443/api/x | head -5
curl -skv --resolve devquest.localhost:8443:127.0.0.1 -o /dev/null https://devquest.localhost:8443/ 2>&1 | grep -i "issuer"
```

The issuer line should show `CN=devquest-local-ca`. (`-k` skips trust because your OS doesn't trust
this CA. Without it the handshake fails before curl prints the certificate, so the grep finds
nothing. To verify properly instead, export the CA with
`kubectl -n cert-manager get secret devquest-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > ca.crt`
and replace `-k` with `--cacert ca.crt`.)

:::tip title="HTTP → HTTPS"
In production you redirect port 80 to 443 at the ingress controller (Traefik entrypoint
redirection in its Helm values) and add HSTS. Keep port 80 reachable for ACME HTTP-01 challenges.
:::

- [ ] Both ClusterIssuers are `READY True`
- [ ] The `devquest-tls` Certificate is `READY True` and its Secret exists
- [ ] `curl` over HTTPS on 8443 reaches the API and shows my local CA as issuer
:::

## Code it: label selectors

Selectors are everywhere — Deployments, Services, NetworkPolicies, PDBs, affinity. Deployments and
NetworkPolicies support set-based `matchExpressions`; Services only support plain equality.

:::challenge id=ops-11-c1 lang=ts xp=50
title: Selector matching and endpoints
Implement two functions:

1. `matches(selector, labels)` — `true` if **all** requirements hold:
   * every `matchLabels` entry equals the label value
   * `In`: label exists and its value is in `values`
   * `NotIn`: label is **missing** or its value is not in `values`
   * `Exists` / `DoesNotExist`: the key is / isn't present
   * an empty selector `{}` matches everything
2. `readyEndpoints(selector, pods)` — the `ip`s of pods that match **and** are `ready`, in input order.

hint: `Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels[k] === v)`
hint: Use `k in labels` (or `labels[k] !== undefined`) for presence checks.

```ts starter
type Req = { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }
type Selector = { matchLabels?: Record<string, string>; matchExpressions?: Req[] }
type Pod = { ip: string; ready: boolean; labels: Record<string, string> }

export function matches(selector: Selector, labels: Record<string, string>): boolean {
  return Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels[k] === v)
}

export function readyEndpoints(selector: Selector, pods: Pod[]): string[] {
  return pods.map((p) => p.ip)
}
```

```ts solution
type Req = { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }
type Selector = { matchLabels?: Record<string, string>; matchExpressions?: Req[] }
type Pod = { ip: string; ready: boolean; labels: Record<string, string> }

export function matches(selector: Selector, labels: Record<string, string>): boolean {
  const has = (k: string) => Object.prototype.hasOwnProperty.call(labels, k)
  const eq = Object.entries(selector.matchLabels ?? {}).every(([k, v]) => labels[k] === v)
  if (!eq) return false
  return (selector.matchExpressions ?? []).every((r) => {
    const vals = r.values ?? []
    switch (r.operator) {
      case 'In': return has(r.key) && vals.includes(labels[r.key])
      case 'NotIn': return !has(r.key) || !vals.includes(labels[r.key])
      case 'Exists': return has(r.key)
      case 'DoesNotExist': return !has(r.key)
    }
  })
}

export function readyEndpoints(selector: Selector, pods: Pod[]): string[] {
  return pods.filter((p) => p.ready && matches(selector, p.labels)).map((p) => p.ip)
}
```

```ts tests
const api = { app: 'api', env: 'prod', tier: 'backend' }
test('matchLabels equality', () => {
  expect(matches({ matchLabels: { app: 'api' } }, api)).toBe(true)
  expect(matches({ matchLabels: { app: 'web' } }, api)).toBe(false)
})
test('empty selector matches everything', () => {
  expect(matches({}, api)).toBe(true)
})
test('In / NotIn', () => {
  expect(matches({ matchExpressions: [{ key: 'env', operator: 'In', values: ['dev', 'prod'] }] }, api)).toBe(true)
  expect(matches({ matchExpressions: [{ key: 'env', operator: 'NotIn', values: ['prod'] }] }, api)).toBe(false)
  expect(matches({ matchExpressions: [{ key: 'zone', operator: 'NotIn', values: ['a'] }] }, api)).toBe(true)
  expect(matches({ matchExpressions: [{ key: 'zone', operator: 'In', values: ['a'] }] }, api)).toBe(false)
})
test('Exists / DoesNotExist', () => {
  expect(matches({ matchExpressions: [{ key: 'tier', operator: 'Exists' }] }, api)).toBe(true)
  expect(matches({ matchExpressions: [{ key: 'canary', operator: 'DoesNotExist' }] }, api)).toBe(true)
  expect(matches({ matchExpressions: [{ key: 'tier', operator: 'DoesNotExist' }] }, api)).toBe(false)
})
test('all requirements are ANDed', () => {
  const sel = { matchLabels: { app: 'api' }, matchExpressions: [{ key: 'env', operator: 'In' as const, values: ['dev'] }] }
  expect(matches(sel, api)).toBe(false)
})
test('readyEndpoints keeps only ready, matching pods', () => {
  const pods = [
    { ip: '10.0.0.1', ready: true, labels: { app: 'api' } },
    { ip: '10.0.0.2', ready: false, labels: { app: 'api' } },
    { ip: '10.0.0.3', ready: true, labels: { app: 'web' } },
    { ip: '10.0.0.4', ready: true, labels: { app: 'api', canary: 'true' } },
  ]
  expect(readyEndpoints({ matchLabels: { app: 'api' } }, pods)).toEqual(['10.0.0.1', '10.0.0.4'])
})
```
:::

:::quiz id=ops-11-q6 xp=15
The Service is `port: 80, targetPort: 80`, but the ASP.NET container listens on **8080**. Pods
are Running and Ready (the readiness probe correctly checks 8080). What do clients of
`http://api` see?
- [ ] It works — kube-proxy finds the right port automatically
- [x] Connection refused / timeouts: traffic is forwarded to pod port 80, where nothing listens
- [ ] A 404 from the Service
- [ ] The Service has no endpoints
> Endpoints exist (pods are Ready, because the probe checks the right port), but they point to
> `podIP:80` — kube-proxy forwards exactly to `targetPort` and never guesses. Nothing listens on 80
> in the pod, so the connection is refused. A Service is L4 and can't return HTTP 404s. Use named
> ports (`containerPort` named `http`, `targetPort: http`) so the mapping can't drift.
:::

:::quiz id=ops-11-q7 xp=15
Requests to `https://app.example.com/api/tasks` return **404 from the API** (ASP.NET's own
404 page), while `/` works. The API maps `app.MapGet("/tasks", …)`. The Ingress routes
`/api` (Prefix) to the API Service. Best fix?
- [ ] Change `pathType` to `Exact`
- [x] Map the API under `/api` (e.g. `app.MapGroup("/api")`) or strip the `/api` prefix with a Traefik Middleware
- [ ] Add a second Ingress for `/tasks`
- [ ] Switch the Service to NodePort
> Ingress forwards the full path, so the API receives `/api/tasks` and ASP.NET has no such route.
> The 404 comes *from the API*, so routing to the Service already works — changing `pathType`,
> adding Ingresses or changing the Service type can't fix a path mismatch inside the app. Either
> make the app expect the prefix or have the proxy strip it — pick one and keep dev (Vite proxy)
> consistent.
:::

:::cards id=ops-11-cards1 xp=15 title="Services & Ingress"
Q: What does a Service provide?
A: A stable virtual IP and DNS name that load-balances (L4) across the Ready pods matched by its selector.
Q: port vs targetPort vs nodePort?
A: port = Service port clients use; targetPort = container port on pods; nodePort = port on every node (30000–32767).
Q: Who fills a Service's endpoints?
A: The EndpointSlice controller lists every pod matching the selector, each with a ready flag; only Ready ones receive traffic.
Q: Service DNS name format?
A: <service>.<namespace>.svc.cluster.local — just <service> from the same namespace.
Q: Headless Service?
A: clusterIP: None — DNS returns pod IPs directly; used by StatefulSets for per-pod names like pg-0.pg.
Q: Ingress vs ingress controller?
A: Ingress = routing rules (data). The controller (Traefik, …) is the proxy that watches them and actually serves traffic.
Q: Which path wins in an Ingress?
A: The longest matching path (/api beats /).
Q: What does cert-manager do?
A: Operator that turns Issuers + Certificates (or Ingress annotations) into TLS Secrets and renews them automatically.
Q: Gateway API objects and owners?
A: GatewayClass (provider), Gateway (platform team: listeners/TLS), HTTPRoute (app team: routing).
Q: Why serve frontend and API on one host?
A: Same origin — no CORS, simple cookies, fetch('/api') works in every environment.
:::

## Recap

- **Services** give ephemeral pods a stable IP + DNS name; kube-proxy forwards to the **Ready**
  pods listed in EndpointSlices. Empty endpoints = selector mismatch or not Ready.
- Types: **ClusterIP** for almost everything, **NodePort** for local/bare metal, **LoadBalancer**
  for the ingress controller, **headless** for StatefulSets.
- CoreDNS: `<service>.<namespace>.svc.cluster.local` (e.g. `api.devquest.svc.cluster.local`); short names work inside the namespace.
- **Ingress** = L7 rules executed by an **ingress controller** (Traefik in K3s); longest path wins;
  the full path is forwarded — map `/api` in ASP.NET or strip it.
- **cert-manager** automates TLS from Let's Encrypt or your own CA.
- **Gateway API** is the role-oriented successor: GatewayClass → Gateway → HTTPRoute.
