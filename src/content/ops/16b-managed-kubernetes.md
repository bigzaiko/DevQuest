---
id: ops-19
title: "Managed Kubernetes: EKS, AKS, GKE & Workload Identity"
level: expert
minutes: 120
xp: 150
summary: Move from kind to a real managed cluster — what the provider runs versus what stays yours, EKS vs AKS vs GKE, clusters as code, cloud networking, load balancers and storage, workload identity without static keys, private registries, autoscaling and cost, upgrades and a multi-environment layout.
---

Everything in this region so far ran on **kind**: a cluster that lives in Docker on your laptop,
costs nothing and forgives everything. At work the cluster runs on **EKS** (AWS), **AKS** (Azure)
or **GKE** (Google Cloud), and its YAML looks almost the same as before. What changes is everything
*around* the YAML:

- someone else runs the control plane, and you pay for it by the hour;
- a `Service` of type `LoadBalancer` creates a real cloud load balancer with a real bill and a
  public IP;
- a `PersistentVolumeClaim` creates a real disk that lives in **one availability zone**;
- pods call cloud APIs (S3, Key Vault, Cloud Storage), and the question "where do the credentials
  come from?" needs a better answer than "a Secret with an access key in it";
- every node is a VM on an invoice, so `resources.requests` turns into money.

This lesson is the bridge between **Production Kubernetes — Security, Secrets, Observability,
GitOps & Troubleshooting** and the boss fight. It assumes you know Services and Ingress, storage,
and scaling from the earlier lessons. Here we look at what a cloud provider changes about them.

## What the provider manages, and what stays yours

A managed Kubernetes service takes over the hardest and most boring part of running a cluster:
the **control plane**. The API server, etcd, the scheduler and the controller manager run on the
provider's machines, across availability zones, with backups, patching and certificate rotation
done for you. You never SSH into them and you never see them as nodes: `kubectl get nodes` shows
only *your* worker nodes.

Everything that runs **on** the cluster is still yours. A useful mental model is a shared
responsibility line:

| Layer | Provider | You |
|---|---|---|
| API server, etcd, scheduler, controllers | Runs, scales, backs up, patches | Choose the version, trigger or schedule upgrades |
| Worker nodes (VMs) | Provides node images and managed node groups / node pools | Pick sizes and counts, roll node-image updates, set autoscaling |
| Core add-ons (CNI, CoreDNS, kube-proxy, CSI drivers) | Ships them as managed add-ons | Keep their versions compatible on upgrades (fully automatic only in "auto" modes) |
| Networking (VPC/VNet, subnets, NAT, firewalls) | Provides the primitives | Design the address space, private vs public endpoints |
| Identity (who can call the API, what pods may do in the cloud) | Integrates the cloud IAM | Write the roles, bindings and trust policies |
| Your workloads | Nothing | Everything: manifests, requests, PDBs, probes, secrets, backups of your data |

Providers sell several levels of "managed":

- **Managed control plane + managed node groups / node pools.** EKS *managed node groups*, AKS
  *node pools*, GKE *Standard* node pools. The provider creates the VMs from an image it maintains
  and can roll them for you, but you decide machine types, counts and when to upgrade. This is
  still the most common setup at companies.
- **Managed nodes too.** **GKE Autopilot**, **EKS Auto Mode** and **AKS Automatic** also run node
  provisioning, the core add-ons and most upgrades. You submit pods and the platform finds capacity
  for them. GKE Autopilot even bills per pod request instead of per VM. In exchange you get less
  control: no privileged DaemonSets of your choosing, and fewer node-level tweaks.
- **Serverless pods.** EKS on **Fargate** and AKS **virtual nodes** (Azure Container Instances) run
  each pod in its own micro-VM. That works well for bursty batch jobs, but it is awkward for
  DaemonSets and persistent volumes.

:::quiz id=ops-19-q1 xp=15
Your company runs EKS with **managed node groups**. Which of these are still **your team's** job?
(Select all that apply.)
- [x] Starting the control plane upgrade and then upgrading the node groups and add-ons to match
- [x] Setting realistic `requests` and PodDisruptionBudgets so node rollouts don't cause outages
- [ ] Taking etcd snapshots and restoring them if the control plane loses data
- [x] Writing the IAM roles that pods use to reach S3 or Secrets Manager
> On standard EKS, AWS runs and backs up the control plane, etcd included. You can't even reach
> etcd, so etcd snapshots are the tempting wrong answer: they were your job on K3s or kubeadm and
> they aren't anymore. You still decide *when* to upgrade, and you upgrade node groups and add-ons
> (VPC CNI, CoreDNS, kube-proxy) yourself. A managed node group drains nodes during a rollout, but
> without PDBs and honest requests that drain can still take your app down. IAM for workloads is
> always yours, because the provider can't guess what your pods are allowed to do.
:::

## Choosing EKS, AKS or GKE

The honest answer at most companies is **"the cloud we already use"**. Identity, networking,
billing, the managed database and the security team's tooling all live there, and a cluster in a
different cloud would turn every one of those into cross-cloud plumbing. Still, the three services
differ in ways you will feel:

| | **EKS** (AWS) | **AKS** (Azure) | **GKE** (Google Cloud) |
|---|---|---|---|
| Control-plane fee | Per cluster-hour; extended-support versions cost roughly 6× more | Free tier (no SLA); Standard tier with SLA; Premium adds long-term support | Per cluster-hour, with a monthly credit that covers one small cluster per billing account |
| "Hands-off" mode | EKS Auto Mode (Karpenter, LB controller and EBS CSI run for you) | AKS Automatic | **Autopilot**: the most mature, billed per pod request |
| Default pod networking | **VPC CNI**: every pod gets a real VPC IP | **Azure CNI Overlay**: pods use a private overlay range (Cilium dataplane optional) | **VPC-native** (alias IP ranges); Dataplane V2 = Cilium |
| Pod → cloud identity | **EKS Pod Identity** (newer) or **IRSA** | **Microsoft Entra Workload ID** | **Workload Identity Federation for GKE** |
| Node autoscaling | Cluster Autoscaler or **Karpenter** | Cluster autoscaler or **Node Auto Provisioning** (Karpenter-based) | Cluster autoscaler + node auto-provisioning (built in) |
| Native Gateway API | AWS Load Balancer Controller (ALB/NLB) or VPC Lattice controller | Application Gateway for Containers | GKE Gateway controller (Google Cloud Load Balancing) |
| Who can call the API | IAM principals mapped via **access entries** | Entra ID users/groups + Azure RBAC or Kubernetes RBAC | Google IAM + Kubernetes RBAC |
| Personality | Lego kit: most choices, most add-ons to wire yourself | Deep Entra ID / Azure integration | Most "batteries included", fastest upgrades |

Prices and feature names change often, so check the provider's pricing page before quoting a
number in a design document. The *shape* stays stable, though: the control plane is a small fixed
cost per cluster, and the real money goes to **nodes, load balancers, NAT gateways, disks and
cross-zone traffic**.

:::job title="Your first week on a managed cluster"
You get cloud access through SSO and run one command that writes a kubeconfig entry:
`aws eks update-kubeconfig --name prod-eu`, `az aks get-credentials -g rg-prod -n aks-prod`
or `gcloud container clusters get-credentials prod --region europe-west3`. That kubeconfig holds
no password. It calls an **exec plugin** (`aws eks get-token`, `kubelogin`,
`gke-gcloud-auth-plugin`) that turns your SSO session into a short-lived token. When
`kubectl` suddenly says `Unauthorized` after lunch, your cloud session has expired: log in again
(`aws sso login`, `az login`, `gcloud auth login`). Expect read-only access to prod and write
access to dev at first.
:::

## Creating the cluster as code

You *can* click a cluster together in the portal, and that is fine for learning. For anything
that matters, the cluster is **code**. Click-built clusters can't be reviewed, can't be rebuilt
identically for a second environment, and nobody remembers which box was ticked. The common tools:

- **Terraform** or **OpenTofu**. OpenTofu is the open-source fork under the Linux Foundation,
  created after HashiCorp switched Terraform to a source-available licence. The language (HCL) and
  providers are compatible, and `tofu plan` reads like `terraform plan`. This is the industry
  default for cloud infrastructure.
- **eksctl** (EKS), **az aks** (AKS) and **gcloud container** (GKE): official CLIs. They are great
  for labs and quick experiments, and eksctl also accepts a YAML config file you can commit.
- **Pulumi** (infrastructure in TypeScript/C#), **Bicep** (Azure), **AWS CDK**, and
  **Crossplane** (cloud resources as Kubernetes CRDs).

Here is a realistic, compact OpenTofu/Terraform setup for an AKS environment. Read it as a list of
decisions: every argument is one you would otherwise make by clicking.

```text
infra/
├── modules/
│   └── aks-cluster/          # reusable: cluster, node pools, registry, workload identities
│       ├── main.tf
│       ├── variables.tf
│       └── outputs.tf
└── envs/
    ├── dev/main.tf           # calls the module with small sizes, Free tier, spot pool
    └── prod/main.tf          # calls it with zones, Standard tier, bigger pools
```

```hcl
# modules/aks-cluster/main.tf  (azurerm provider ~> 4.0)
terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}

resource "azurerm_resource_group" "this" {
  name     = "rg-devquest-${var.env}"
  location = var.location
}

resource "azurerm_kubernetes_cluster" "this" {
  name                = "aks-devquest-${var.env}"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  dns_prefix          = "devquest-${var.env}"
  kubernetes_version  = var.kubernetes_version   # e.g. "1.35" — pin it, upgrade on purpose
  sku_tier            = var.env == "prod" ? "Standard" : "Free"   # Standard = financially backed SLA

  # Workload identity: publish an OIDC issuer and run the mutating webhook
  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  # Humans log in with Entra ID; no shared admin certificate
  local_account_disabled = true
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled = true
  }

  automatic_upgrade_channel = "patch"       # auto-apply patch releases (1.35.x)
  node_os_upgrade_channel   = "NodeImage"   # weekly node images with OS security fixes
  maintenance_window_auto_upgrade {
    frequency   = "Weekly"
    interval    = 1
    duration    = 4
    day_of_week = "Sunday"
    start_time  = "02:00"
    utc_offset  = "+00:00"
  }

  default_node_pool {                       # the "system" pool: CoreDNS, metrics-server, CSI...
    name                         = "system"
    vm_size                      = "Standard_D4ds_v5"
    zones                        = var.zones   # ["1", "2", "3"] in prod
    auto_scaling_enabled         = true
    min_count                    = 2
    max_count                    = 3
    only_critical_addons_enabled = true        # taint: app pods go elsewhere
    temporary_name_for_rotation  = "systemtmp" # lets you change vm_size without recreating the cluster
    upgrade_settings {
      max_surge = "33%"                        # add new nodes before draining old ones
    }
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"   # pods get IPs from a private overlay, not from the VNet
    network_data_plane  = "cilium"    # eBPF dataplane, also enforces NetworkPolicies
    network_policy      = "cilium"
    load_balancer_sku   = "standard"
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "apps" {
  name                  = "apps"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.apps_vm_size
  zones                 = var.zones
  auto_scaling_enabled  = true
  min_count             = var.apps_min
  max_count             = var.apps_max
}

resource "azurerm_kubernetes_cluster_node_pool" "spot" {   # cheap, interruptible capacity for workers
  count                 = var.enable_spot ? 1 : 0
  name                  = "spot"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  vm_size               = var.apps_vm_size
  priority              = "Spot"
  eviction_policy       = "Delete"
  spot_max_price        = -1          # pay up to the on-demand price, never be evicted for price
  auto_scaling_enabled  = true
  min_count             = 0
  max_count             = 10
  # AKS adds this label and taint to every Spot pool by itself; declaring them here keeps
  # Terraform's plan in sync with what Azure reports, so it doesn't try to "fix" the pool.
  node_labels           = { "kubernetes.azure.com/scalesetpriority" = "spot" }
  node_taints           = ["kubernetes.azure.com/scalesetpriority=spot:NoSchedule"]
}

# Private registry + permission for the nodes (kubelet identity) to pull from it
resource "azurerm_container_registry" "this" {
  name                = "acrdevquest${var.env}"   # globally unique, letters and digits only
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
  sku                 = "Standard"
  admin_enabled       = false                     # no shared username/password
}

resource "azurerm_role_assignment" "aks_pull" {
  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_kubernetes_cluster.this.kubelet_identity[0].object_id
}

# One cloud identity per workload, trusted only for ONE Kubernetes ServiceAccount
resource "azurerm_user_assigned_identity" "api" {
  name                = "id-devquest-api-${var.env}"
  resource_group_name = azurerm_resource_group.this.name
  location            = azurerm_resource_group.this.location
}

resource "azurerm_federated_identity_credential" "api" {
  name                = "aks-devquest-api"
  resource_group_name = azurerm_resource_group.this.name
  parent_id           = azurerm_user_assigned_identity.api.id
  issuer              = azurerm_kubernetes_cluster.this.oidc_issuer_url
  subject             = "system:serviceaccount:devquest:api"   # namespace:serviceaccount — exact match
  audience            = ["api://AzureADTokenExchange"]
}

resource "azurerm_role_assignment" "api_secrets" {
  scope                = var.key_vault_id
  role_definition_name = "Key Vault Secrets User"   # read secrets, nothing else
  principal_id         = azurerm_user_assigned_identity.api.principal_id
}

output "api_client_id" { value = azurerm_user_assigned_identity.api.client_id }
output "oidc_issuer"   { value = azurerm_kubernetes_cluster.this.oidc_issuer_url }
```

Each environment folder configures **remote state** (an Azure Storage container, an S3 bucket or a
GCS bucket, with locking) and calls the module:

```hcl
# envs/prod/main.tf
terraform {
  backend "azurerm" {
    resource_group_name  = "rg-tfstate"
    storage_account_name = "sttfstatedevquest"
    container_name       = "tfstate"
    key                  = "prod/aks.tfstate"   # one state file per environment
    use_azuread_auth     = true
  }
}

provider "azurerm" {
  features {}
  subscription_id = "00000000-0000-0000-0000-000000000000"   # the prod subscription
}

module "aks" {
  source             = "../../modules/aks-cluster"
  env                = "prod"
  location           = "westeurope"
  kubernetes_version = "1.35"
  zones              = ["1", "2", "3"]
  apps_vm_size       = "Standard_D8ds_v5"
  apps_min           = 3
  apps_max           = 12
  enable_spot        = true
  key_vault_id       = "/subscriptions/.../providers/Microsoft.KeyVault/vaults/kv-devquest-prod"
}
```

The workflow is the same as for code: a pull request shows the `tofu plan` (or `terraform plan`)
output, a reviewer reads it, and CI applies it after the merge, using OIDC federation from GitHub
Actions with no stored cloud keys (see **Shipping Safely: Continuous Delivery & Releases**).

The same cluster on the other two clouds, in the tool most teams reach for first:

```yaml
# eksctl create cluster -f cluster.yaml
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: devquest-dev
  region: eu-central-1
  version: "1.35"
iam:
  withOIDC: true                    # needed for IRSA; Pod Identity uses the agent add-on below
addons:
  - name: vpc-cni
  - name: coredns
  - name: kube-proxy
  - name: aws-ebs-csi-driver
  - name: eks-pod-identity-agent
managedNodeGroups:
  - name: apps
    instanceTypes: ["m7i.large", "m6i.large"]
    minSize: 2
    maxSize: 6
    desiredCapacity: 2
    privateNetworking: true          # nodes in private subnets, egress via NAT
```

```bash
# GKE Autopilot: no node pools to define at all; workload identity is on by default
gcloud container clusters create-auto devquest-dev \
  --region europe-west3 --release-channel regular
```

:::pro title="Draw the line between Terraform and GitOps"
Mature teams use **Terraform/OpenTofu for cloud resources** (VPC, cluster, node pools, registry,
identities, DNS zones, the managed Postgres) and **GitOps (Argo CD / Flux) for everything inside
the cluster** (apps, ingress controllers, cert-manager, ESO). Terraform's job ends with installing
Argo CD and pointing it at the GitOps repo. Managing app Helm releases through Terraform's
`helm` provider looks convenient at first and turns into slow, fragile applies with state drift
once the cluster is busy.
:::

:::warn title="Attribute names move between provider versions"
Cloud providers for Terraform/OpenTofu rename arguments across major versions. For example,
azurerm v4 renamed `enable_auto_scaling` to `auto_scaling_enabled`. Pin the provider
(`~> 4.0`), keep a lock file (`.terraform.lock.hcl`) in Git, and run `tofu validate` in CI.
Copying a blog post written for an older provider version is the classic way to lose an afternoon.
:::

## Networking: CNI, load balancers and Gateways

### Pod IPs: whose address space?

On kind, pod IPs come from a private range nobody else sees. In the cloud the CNI plugin decides
whether pods are **first-class citizens of your virtual network**:

- **EKS VPC CNI** gives every pod a real IP from the subnet, attached to the node's network
  interfaces (ENIs). Other VPC resources, peered networks and security groups see pod IPs
  directly, which makes network debugging simple. The catch is that **pods consume subnet
  addresses**, and the number of pods per node is limited by how many ENIs and IPs the instance
  type supports (an `m5.large` fits 29 pods by default). Large clusters in small subnets run out
  of IPs. The fixes are **prefix delegation** (a /28 per ENI slot instead of one IP), larger or
  secondary CIDR ranges, or custom networking.
- **AKS Azure CNI Overlay** (the current default) gives nodes VNet IPs and pods IPs from a
  separate private overlay range, so the VNet isn't exhausted. Traffic leaving the cluster is
  NATed to the node IP. The older *kubenet* mode is being retired.
- **GKE VPC-native** uses *alias IP ranges*: a secondary range on the subnet is reserved for pods,
  so you must size that range up front.

:::quiz id=ops-19-q2 xp=15
On EKS, a Deployment scales from 40 to 120 pods. Many new pods hang in `ContainerCreating` with
events like `failed to assign an IP address to container`. Nodes still have plenty of free CPU and
memory. What is the most likely cause?
- [ ] The cluster autoscaler is too slow to add nodes
- [x] The VPC CNI has run out of pod IPs: the subnets are too small or the instance type's ENI/IP limit is reached, so prefix delegation or larger subnets are needed
- [ ] The pods' memory limits are lower than their requests
- [ ] CoreDNS can't resolve the new pod names
> With the VPC CNI every pod takes a real VPC IP, and a node can only hold as many as its ENIs
> allow. The error comes from the CNI during sandbox creation, *after* scheduling succeeded, so
> CPU and memory aren't the bottleneck. The autoscaler is the tempting answer, but the pods are
> already scheduled (they aren't `Pending`), so a new node wouldn't help if the subnet itself is
> out of addresses. Limits lower than requests are rejected by the API server at create time, and
> DNS has nothing to do with assigning IPs.
:::

### `Service type: LoadBalancer` becomes a real cloud load balancer

Every managed cluster runs a **cloud controller manager**. When it sees a `Service` of type
`LoadBalancer`, it calls the cloud API and creates an L4 load balancer (an AWS NLB, an Azure
Standard Load Balancer rule, a Google passthrough Network LB) that forwards to your nodes or
directly to pod IPs. Behaviour is tuned with **annotations**, which are provider-specific:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: traefik
  namespace: traefik
  annotations:
    # AWS (with the AWS Load Balancer Controller): NLB that targets pod IPs directly
    service.beta.kubernetes.io/aws-load-balancer-type: external
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
    service.beta.kubernetes.io/aws-load-balancer-scheme: internet-facing
    # Azure: an internal load balancer in the VNet instead of a public IP
    # service.beta.kubernetes.io/azure-load-balancer-internal: "true"
    # GKE: an internal passthrough load balancer
    # networking.gke.io/load-balancer-type: "Internal"
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local   # keep the client's source IP; only nodes with a ready pod receive traffic
  selector:
    app.kubernetes.io/name: traefik
  ports:
    - { name: https, port: 443, targetPort: 8443 }
```

Each `LoadBalancer` Service is **one more cloud load balancer**: an hourly fee, a public IP and
another thing to secure. The standard pattern is **one** entry point per cluster (or per trust
zone), with HTTP routing behind it. You can do that in two ways:

1. **An in-cluster proxy behind one L4 LB.** Traefik, Envoy Gateway, Istio or Cilium implement
   Ingress and/or the Gateway API (see **Services, DNS & Ingress**). This works the same on
   every cloud and on kind. Note that the community *ingress-nginx* controller was retired in
   March 2026, so new setups pick a Gateway API implementation.
2. **A cloud L7 load balancer driven by Kubernetes objects.** The **GKE Gateway controller**
   (GatewayClass `gke-l7-global-external-managed`), the **AWS Load Balancer Controller** (Ingress
   → ALB, plus Gateway API support), and Azure **Application Gateway for Containers**. TLS, WAF
   and global anycast live in the cloud product, and your `HTTPRoute` stays portable.

```yaml
# On GKE: the platform team owns the Gateway, app teams attach HTTPRoutes (same HTTPRoute as on kind)
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: public
  namespace: infra
spec:
  gatewayClassName: gke-l7-global-external-managed
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.devquest.example.com"
      tls:
        certificateRefs: [{ name: wildcard-devquest }]
      allowedRoutes:
        namespaces: { from: All }
```

:::quiz id=ops-19-q3 xp=10
A team moves from kind to AKS and gives each of its 14 microservices `type: LoadBalancer` "so they
are reachable". What is the main problem?
- [ ] AKS doesn't support `LoadBalancer` Services
- [ ] It works, but pods lose their DNS names
- [x] Each Service gets its own public cloud load balancer rule and IP, so cost and attack surface grow with every service; one ingress or Gateway entry point with routes (and `ClusterIP` for internal services) is the norm
- [ ] The Services will only be reachable from inside the VNet
> On kind a `LoadBalancer` Service was harmless (it stayed pending or got a fake IP). In the cloud
> the controller provisions a public IP and load-balancing rule for each one. Internal callers
> should use `ClusterIP` and cluster DNS, and external traffic should come in through one Gateway or
> Ingress that routes by host and path. AKS supports `LoadBalancer` fine, and the "only from the
> VNet" option is the opposite of what happens by default: you need the `azure-load-balancer-internal`
> annotation to get an internal one.
:::

:::warn title="The NAT gateway bill"
Nodes in private subnets reach the internet (image pulls, external APIs) through a NAT gateway,
which charges per hour **and per GB processed**. A chatty log shipper sending to a SaaS endpoint, or
images pulled from Docker Hub on every scale-up, can quietly cost more than the nodes. Use
VPC/private endpoints for the cloud's own services (S3 gateway endpoint, Private Link,
Private Google Access), use a registry in the same region, and watch cross-zone traffic, which is
also billed on AWS and GCP.
:::

## Storage classes: real disks, real zones

`PersistentVolumeClaim`s work as in **Storage, StatefulSets, Postgres Operators & Jobs**: the CSI
driver creates a cloud disk on demand. What is new is that block disks are **zonal**. A disk created
in zone `eu-central-1a` can only attach to nodes in `eu-central-1a`.

| Cloud | Block (ReadWriteOnce) | Built-in class | Shared file (ReadWriteMany) |
|---|---|---|---|
| AWS | EBS **gp3** (zonal) via the EBS CSI driver add-on | none by default on new clusters, so define one | EFS |
| Azure | Azure Disk (zonal; ZRS SKUs replicate across zones) | `managed-csi` (default), `managed-csi-premium` | Azure Files (`azurefile-csi`) |
| GCP | Persistent Disk / Hyperdisk (zonal; *regional PD* spans two zones) | `standard-rwo` (default, balanced PD), `premium-rwo` | Filestore |

A good default StorageClass on EKS:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3                     # cheaper and faster baseline than gp2
  encrypted: "true"
volumeBindingMode: WaitForFirstConsumer   # create the disk in the zone where the pod is scheduled
allowVolumeExpansion: true
reclaimPolicy: Delete           # use a separate "Retain" class for data you must never lose by accident
```

`WaitForFirstConsumer` matters here. With `Immediate`, the disk is created in some zone *before*
the scheduler has picked a node, and the pod may end up unschedulable in a different zone.

:::quiz id=ops-19-q4 xp=15
A StatefulSet pod on a regional GKE cluster was running on the only node in zone `europe-west3-a`.
That node is drained during a node-pool upgrade, and the pod is now `Pending` with
`volume node affinity conflict`. Nodes in zones `b` and `c` have plenty of capacity. Why?
- [ ] The PVC was deleted together with the pod
- [ ] GKE disks can only attach to the node that created them
- [x] Its PersistentVolume is a zonal disk in zone `a`, so the pod can only run on a node in zone `a`; there's none available right now
- [ ] `WaitForFirstConsumer` prevents the pod from starting until the PVC is recreated
> A PersistentVolume for a zonal disk carries node affinity for its zone, and the scheduler honours
> it, so capacity in other zones is useless. The disk *can* move between nodes, just not between
> zones, which is why "only the node that created it" is too strict. Fixes include keeping capacity
> in every zone (surge upgrades, at least one node per zone), regional PD / ZRS disks for critical
> volumes, or (for Postgres) replicas in each zone via an operator so a different instance takes
> over. `WaitForFirstConsumer` only affects where a **new** disk is created; it is the setting that
> *prevents* this problem for new volumes, not its cause.
:::

## Workload identity: cloud access without static keys

Your API needs to read secrets from Key Vault, put files into S3 or publish to Pub/Sub. The old way
was to create a cloud user, generate an **access key**, put it in a Kubernetes Secret and mount it.
That key never expires, works from any laptop on earth if it leaks, appears in `kubectl get secret
-o yaml` for anyone with read access, and has to be rotated by hand. **Configuration, Secrets &
Feature Flags** named the goal: **workload identity**. Here is how it works.

### The mental model: the cluster is an identity provider

Kubernetes already gives every pod an identity, its **ServiceAccount**, and can mint a signed JWT
for it. Workload identity uses that token the same way "Sign in with Google" uses an ID token:

```text
 pod "api" (ServiceAccount devquest/api)
   │ the kubelet mounts a projected ServiceAccount token (a signed JWT) as a file:
   │      iss = https://oidc.eks.eu-central-1.amazonaws.com/id/ABC   ← the cluster's OIDC issuer
   │      sub = system:serviceaccount:devquest:api                   ← namespace + SA name
   │      aud = sts.amazonaws.com        (Azure: api://AzureADTokenExchange)
   │      exp = at most ~1 hour, and bound to this one pod
   ▼
 cloud token service (AWS STS / Microsoft Entra ID / Google STS)
   │ fetches the issuer's public keys (/.well-known/openid-configuration → JWKS)
   │ verifies the signature, then checks iss, sub, aud and exp against the trust YOU registered
   ▼
 short-lived cloud credentials (about an hour), refreshed automatically by the SDK
   │ the SDK calls S3 / Key Vault / Cloud Storage with them
   ▼
 the cloud API checks what that role / identity may do (least privilege still applies)
```

1. The cluster publishes an **OIDC issuer**: a public URL with `/.well-known/openid-configuration`
   and its signing keys (JWKS). Managed clusters host this for you.
2. You register a **trust** in the cloud: "tokens from *this* issuer, for *this* ServiceAccount
   subject, with *this* audience, may become *this* cloud role or identity".
3. The pod gets a **projected ServiceAccount token** as a file. "Projected" means the kubelet
   requests the token from the API server's TokenRequest API with a specific audience and lifetime
   and writes it into a volume. Unlike the old, never-expiring token Secrets, it is bound to the pod
   (invalid as soon as the pod is deleted), expires within an hour and is refreshed by the kubelet.
4. The cloud SDK in your code exchanges that token for **short-lived cloud credentials** (STS on
   AWS, Entra ID on Azure, Google STS) and refreshes them automatically.

Nothing long-lived exists anywhere. A stolen token expires within the hour, is only valid for the
configured audience, and only maps to the role trusted for that one ServiceAccount.

### Three clouds, four implementations

| | **AWS: EKS Pod Identity** | **AWS: IRSA** | **Azure: AKS Workload Identity** | **GCP: GKE Workload Identity Federation** |
|---|---|---|---|---|
| Trust lives in | A *pod identity association* (cluster + namespace + SA → role) | The IAM role's trust policy (OIDC provider + `sub`/`aud` conditions) | A **federated identity credential** on a user-assigned managed identity | IAM bindings on the principal `…/subject/ns/NS/sa/KSA` |
| Kubernetes side | Nothing on the SA; the agent DaemonSet serves credentials | SA annotation `eks.amazonaws.com/role-arn` | SA annotation `azure.workload.identity/client-id` **+ pod label** `azure.workload.identity/use: "true"` | Nothing required for direct binding (optionally `iam.gke.io/gcp-service-account`) |
| What the pod sees | `AWS_CONTAINER_CREDENTIALS_FULL_URI` (the agent's link-local endpoint) and `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` | `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE` | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_AUTHORITY_HOST` | The GKE metadata server answers credential requests |
| .NET code | AWS SDK default credential chain | AWS SDK default credential chain | `WorkloadIdentityCredential` (Azure.Identity) | Application Default Credentials |

**EKS Pod Identity** is the newer, simpler AWS option, and it works slightly differently from
the other three. There is no public OIDC trust per cluster: the Pod Identity Agent (a DaemonSet
on every node) takes the pod's projected token, hands it to the **EKS Auth API**
(`AssumeRoleForPodIdentity`), and EKS itself checks it against the pod identity association. So
the IAM role trusts one AWS service principal, `pods.eks.amazonaws.com`, and the same role can be
reused by many clusters without editing its trust policy. Pod Identity only works on EKS (EC2
nodes; not Fargate), so IRSA stays relevant for Fargate, self-managed clusters and older setups.

```bash
aws eks create-addon --cluster-name devquest-prod --addon-name eks-pod-identity-agent
aws iam create-role --role-name devquest-api-prod --assume-role-policy-document file://pod-identity-trust.json
aws iam attach-role-policy --role-name devquest-api-prod --policy-arn arn:aws:iam::111122223333:policy/devquest-uploads-rw
aws eks create-pod-identity-association --cluster-name devquest-prod \
  --namespace devquest --service-account api \
  --role-arn arn:aws:iam::111122223333:role/devquest-api-prod
```

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "pods.eks.amazonaws.com" },
    "Action": ["sts:AssumeRole", "sts:TagSession"]
  }]
}
```

**IRSA** (IAM Roles for Service Accounts) is older but everywhere, also outside EKS: anything with
a public OIDC issuer can use it. The trust policy is where the security lives:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::111122223333:oidc-provider/oidc.eks.eu-central-1.amazonaws.com/id/5C3A1F0E9B2D"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "oidc.eks.eu-central-1.amazonaws.com/id/5C3A1F0E9B2D:sub": "system:serviceaccount:devquest:api",
        "oidc.eks.eu-central-1.amazonaws.com/id/5C3A1F0E9B2D:aud": "sts.amazonaws.com"
      }
    }
  }]
}
```

**GKE** lets you grant IAM roles directly to a Kubernetes ServiceAccount, written as a principal in
the project's workload identity pool:

```bash
gcloud storage buckets add-iam-policy-binding gs://devquest-uploads-prod \
  --role=roles/storage.objectUser \
  --member="principal://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/devquest-prod.svc.id.goog/subject/ns/devquest/sa/api"
```

**AKS** is what the lab builds: a managed identity, a federated credential for
`system:serviceaccount:<ns>:<sa>`, an annotated ServiceAccount and a labelled pod template:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api
  namespace: devquest
  annotations:
    azure.workload.identity/client-id: 3f6c2a9e-1b7d-4c55-9e1a-0d2f8b6a7c41   # the managed identity's clientId
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: devquest
spec:
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels:
        app: api
        azure.workload.identity/use: "true"   # on the POD template, or the webhook skips the pod
    spec:
      serviceAccountName: api
      containers:
        - name: api
          image: acrdevquestprod.azurecr.io/devquest-api@sha256:4b1e0c...   # promote by digest
```

On the .NET side there is nothing cloud-specific to configure in Kubernetes. The SDK reads the
injected environment:

```csharp
// Azure: WorkloadIdentityCredential reads AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_FEDERATED_TOKEN_FILE
builder.Services.AddSingleton(_ => new SecretClient(
    new Uri(builder.Configuration["KeyVault:Url"]!), new WorkloadIdentityCredential()));

// AWS: no credentials argument at all. The default chain finds Pod Identity or IRSA.
builder.Services.AddSingleton<IAmazonS3>(_ => new AmazonS3Client(RegionEndpoint.EUCentral1));
```

:::quiz id=ops-19-q5 xp=15
What actually proves a pod's identity to the cloud in IRSA, AKS Workload Identity and GKE Workload
Identity Federation?
- [ ] A cloud access key stored in a Kubernetes Secret that the webhook rotates daily
- [x] A short-lived ServiceAccount JWT signed by the cluster's OIDC issuer; the cloud verifies it against the issuer's public keys and checks `iss`, `sub` and `aud` before handing out short-lived credentials
- [ ] The node's IP address, which is allow-listed in the cloud IAM policy
- [ ] The pod's container image digest, signed by the registry
> All three are OIDC federation: the cluster acts as an identity provider, and the cloud trusts tokens
> from its issuer for specific subjects (`system:serviceaccount:<ns>:<name>`) and audiences. The
> "rotated key in a Secret" option is tempting because it sounds secure, but it is exactly the static
> credential workload identity removes. A rotated key is still a key that can be copied and used
> from anywhere until the next rotation. Node IPs identify the *node*, not the workload, so every pod on it
> would share the permission. (That is precisely the weakness of giving the **node role** S3 access.)
> Image signatures prove what code runs, not who is calling.
:::

:::quiz id=ops-19-q6 xp=15
A colleague "simplified" an IRSA trust policy: the `StringEquals` block is replaced with
`"StringLike": { "oidc.eks...:sub": "system:serviceaccount:*" }`. Pods in `devquest` still work.
What did this change?
- [ ] Nothing, because AWS ignores the `sub` condition for web identity roles
- [ ] Only pods in namespaces called `*` can assume the role now
- [x] Any ServiceAccount in any namespace of that cluster can now assume the role, including a compromised pod or a developer's debug pod in a sandbox namespace
- [ ] It breaks tokens with an `aud` array
> The `sub` condition is the *only* thing that ties the role to one workload. `StringLike` treats `*`
> as a wildcard, so every `system:serviceaccount:<anything>:<anything>` matches. It's tempting to
> think AWS checks the subject anyway, but without a `sub` condition (or with a wildcard) the role
> is open to the whole cluster. The `aud` condition is gone too, so tokens for other audiences pass as well.
> Keep `StringEquals` on both `sub` and `aud`, one role per workload. On Azure the federated
> credential's subject is always an exact match, and Pod Identity associations name the namespace and SA.
:::

:::quiz id=ops-19-q7 xp=10
On AKS, the SA is annotated with the right `client-id`, the federated credential matches
`system:serviceaccount:devquest:api`, and the role assignment exists. The pod logs
`WorkloadIdentityCredential authentication unavailable. The workload options are not fully
configured`, and `AZURE_FEDERATED_TOKEN_FILE` isn't set in the container. What's missing?
- [ ] The Key Vault firewall blocks the pod
- [x] The pod template lacks the label `azure.workload.identity/use: "true"`, so the mutating webhook never injected the env vars and token volume
- [ ] The federated credential needs the audience `sts.amazonaws.com`
- [ ] The managed identity needs the `AcrPull` role
> The AKS webhook only mutates pods carrying that label, and it must be on the **pod template**,
> not on the Deployment's own metadata or the ServiceAccount. No injection means no env vars, so the
> credential can't even start. A firewall or missing role would produce a 403 *after* a successful
> token exchange, which looks different. `sts.amazonaws.com` is AWS's audience (Azure's is
> `api://AzureADTokenExchange`), and `AcrPull` is about pulling images, not reading secrets. The
> label is checked when the pod is created, so roll the Deployment after fixing it.
:::

## Pulling images from a private registry

On kind you loaded images with `kind load docker-image`. In the cloud, nodes pull from a registry,
and **the node** (the kubelet), not your pod, needs permission to do so:

| Registry | How nodes authenticate |
|---|---|
| **Amazon ECR** | The node IAM role has a pull policy: `AmazonEC2ContainerRegistryReadOnly`, or the narrower `AmazonEC2ContainerRegistryPullOnly` (eksctl and the EKS docs attach one to managed node groups); cross-account pulls also need a repository policy |
| **Azure Container Registry** | `az aks update --attach-acr <name>` (or the Terraform `AcrPull` assignment above) grants the cluster's **kubelet identity** pull rights |
| **Google Artifact Registry** | The node service account needs `roles/artifactregistry.reader`. The default Compute Engine SA often has it through the broad Editor role; with a least-privilege custom node SA (recommended), grant it explicitly |
| **GHCR / Docker Hub / others** | An `imagePullSecrets` entry: a `docker-registry` Secret with a read-only token, attached to the pod or its ServiceAccount |

```bash
# Only for registries outside your cloud. Use a read-only, expiring token, never a personal password.
kubectl -n devquest create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=devquest-bot --docker-password="$GHCR_READ_TOKEN"
kubectl -n devquest patch serviceaccount api -p '{"imagePullSecrets":[{"name":"ghcr-pull"}]}'
```

Keep the registry in the same region as the cluster (faster, no NAT/egress cost) and deploy by
**digest** promoted through environments (**Registries, Tags and CI Pipelines**). Pull-through
caches (ECR, ACR, Artifact Registry remote repositories) also protect you from Docker Hub rate limits.
`ErrImagePull` with `401 Unauthorized` almost always means the *node* identity lacks pull rights.
A `manifest unknown` error means the tag or digest doesn't exist in that registry.

## Node autoscaling: Cluster Autoscaler vs Karpenter

You met the Cluster Autoscaler (CA) in **Scaling — HPA, KEDA, Cluster Autoscaler & Scheduling**: it
watches `Pending` pods and grows **pre-defined node groups** (an AWS Auto Scaling group, an Azure
VM scale set, a GCP managed instance group). It works, but every node group has one fixed instance
type, so you end up with many groups ("small", "large", "spot-large", "arm"…) and the CA picks
between them.

**Karpenter** (AWS-born, now also behind AKS Node Auto Provisioning and EKS Auto Mode) skips node
groups. It looks at the pending pods' requirements (CPU, memory, arch, zone, spot or on-demand,
tolerations) and **launches whatever instance type fits them best**, straight from the cloud API,
usually in under a minute. It also **consolidates**: it replaces several half-empty nodes with
one cheaper node, or swaps on-demand for spot when that's allowed.

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: general
spec:
  template:
    spec:
      nodeClassRef:
        group: karpenter.k8s.aws
        kind: EC2NodeClass
        name: default               # AMI family, subnets, security groups
      requirements:
        - key: karpenter.sh/capacity-type
          operator: In
          values: ["spot", "on-demand"]   # prefers spot when it's cheaper and available
        - key: kubernetes.io/arch
          operator: In
          values: ["amd64", "arm64"]      # needs multi-arch images (ops-08)
        - key: karpenter.k8s.aws/instance-category
          operator: In
          values: ["c", "m", "r"]
      expireAfter: 720h               # replace nodes monthly so they pick up new images
  limits:
    cpu: "200"                        # hard ceiling: a runaway HPA can't buy 1000 vCPUs
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 5m
```

| | Cluster Autoscaler | Karpenter / NAP / EKS Auto Mode | GKE Autopilot |
|---|---|---|---|
| Unit | Node groups you define | Individual instances it chooses | You don't see nodes |
| Instance choice | One type per group | Any type matching requirements | Google picks |
| Bin-packing | Limited to group shapes | Good, plus active consolidation | Billed per pod request anyway |
| Available on | Every cloud (and Hetzner etc.) | AWS, Azure | GCP |

Both look at **requests, not usage**: they buy nodes for what pods *ask for*. Consolidation also
means pods get evicted more often, so PDBs and graceful shutdown (**Scaling — HPA, KEDA, Cluster
Autoscaler & Scheduling** and **Config, Secrets, Probes & Resources**) stop being optional.

## Cost: requests are the bill

A mental model that will save you from many awkward budget meetings: **the cluster's cost is the sum
of the requests you schedule, rounded up to whole nodes, plus fixed overhead**. A pod requesting 2
CPUs and using 0.1 still occupies 2 CPUs of a VM you pay for. The levers, roughly in the order teams
pull them:

| Lever | What it does | Watch out for |
|---|---|---|
| **Rightsize requests** | Compare `kubectl top` / Prometheus usage with requests; VPA in recommendation mode or Goldilocks suggest values | Set memory requests near real peak usage (OOM risk below it); CPU can be tighter |
| **Visibility** | OpenCost / Kubecost, or the provider's cost views, break the bill down by namespace and label | Without `team` / `app` labels nobody owns the cost |
| **Spot / preemptible nodes** | 60–90 % cheaper spare capacity: AWS Spot (2-minute notice), Azure Spot and GCP Spot VMs (about 30 seconds) | Only for workloads that tolerate interruption: stateless replicas, queue workers, CI runners. Diversify instance types |
| **Commitments** | Savings Plans / reserved instances / committed-use discounts for the always-on baseline | Commit to the floor, not the peak |
| **ARM nodes** | Graviton / Ampere / Axion instances are often cheaper per unit of performance | Multi-arch images required |
| **Scale non-prod down** | Dev clusters at 0–1 nodes overnight and at weekends; KEDA to zero for workers | Someone always "needs dev at 22:00", so publish the schedule |
| **Fewer clusters / LBs / NATs** | Every cluster has a control-plane fee, add-ons and a baseline of system pods | Too few clusters breaks isolation; see below |

A spot-friendly worker looks like this. It tolerates the spot taint, prefers spot nodes, can be
interrupted at any time and finishes or re-queues its job on `SIGTERM`:

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 25          # stay under the ~30 s notice on Azure/GCP
      tolerations:
        - key: kubernetes.azure.com/scalesetpriority
          operator: Equal
          value: spot
          effect: NoSchedule
      affinity:
        nodeAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:   # prefer, don't require: fall back to on-demand
            - weight: 100
              preference:
                matchExpressions:
                  - { key: kubernetes.azure.com/scalesetpriority, operator: In, values: [spot] }
```

:::quiz id=ops-19-q8 xp=10
Which workloads are good candidates for **spot** nodes? (Select all that apply.)
- [x] Queue workers that ack a message only after finishing and re-process it if killed
- [x] Extra API replicas above the on-demand baseline, behind a PDB, spread across zones
- [ ] The single-instance PostgreSQL primary that the whole product depends on
- [x] CI build runners and nightly batch reports that can retry
> Spot capacity can disappear with 30 seconds to 2 minutes of warning. That's fine for work that is
> idempotent and retryable (workers with at-least-once delivery, CI jobs, batch) and for **extra**
> stateless replicas when the baseline runs on on-demand nodes. A single stateful primary is the
> classic mistake: every eviction becomes a failover or an outage, and the zonal disk may not
> reattach quickly. Put databases on on-demand nodes or, better, a managed database service.
:::

## Code it: does this token get the role?

In IRSA, the trust policy is all that stands between a pod's token and your production S3 bucket.
Implement the part of IAM's evaluation that matters here, then check the tests for the cases
that bite teams in real life.

:::challenge id=ops-19-c1 lang=ts xp=50
title: Evaluate an IRSA trust policy
Write `canAssumeRole(policy, token, accountId)` that returns `true` if a pod presenting `token`
may call `sts:AssumeRoleWithWebIdentity` on a role with this trust `policy`.

- The OIDC provider path is `token.iss` without the leading `https://`
  (e.g. `oidc.eks.eu-central-1.amazonaws.com/id/ABC`).
- A statement **applies** when all of these hold:
  - `Principal.Federated` equals `arn:aws:iam::<accountId>:oidc-provider/<providerPath>`;
  - `Action` (a string or an array) includes `sts:AssumeRoleWithWebIdentity`;
  - every condition passes. Condition keys look like `<providerPath>:sub` or `<providerPath>:aud`.
    A key with a different prefix, or for any other claim, can't be satisfied, so the statement
    doesn't apply. A statement with **no** `Condition` has nothing to fail, so it applies to every
    token from that provider (which is exactly the classic hole).
  - Statements with a `Principal.Service` (Pod Identity) and no matching `Federated` never apply.
- `StringEquals`: the claim equals **one of** the expected values (a value may be a string or an
  array). `StringLike`: the same, but `*` matches any run of characters (including none) and
  `?` exactly one. Other characters are literal.
- `aud` may be a string or an array in the token. The condition passes if **any** audience matches.
- An applying statement with `Effect: "Deny"` wins over every `Allow`. With no applying `Allow`,
  the answer is `false`.

hint: Normalise first: `const list = (v: string | string[]) => Array.isArray(v) ? v : [v]`.
hint: Build a RegExp for `StringLike`: escape regex characters, then turn `*` into `.*` and `?` into `.`, anchored with `^…$`.
hint: Collect the statements that apply, then `if (applying.some(s => s.Effect === 'Deny')) return false`.

```ts starter
type Block = Record<string, string | string[]>
type Statement = {
  Effect: 'Allow' | 'Deny'
  Principal: { Federated?: string; Service?: string }
  Action: string | string[]
  Condition?: { StringEquals?: Block; StringLike?: Block }
}
type TrustPolicy = { Version: string; Statement: Statement[] }
type TokenClaims = { iss: string; sub: string; aud: string | string[] }

export function canAssumeRole(policy: TrustPolicy, token: TokenClaims, accountId: string): boolean {
  // your code
  return false
}
```

```ts solution
type Block = Record<string, string | string[]>
type Statement = {
  Effect: 'Allow' | 'Deny'
  Principal: { Federated?: string; Service?: string }
  Action: string | string[]
  Condition?: { StringEquals?: Block; StringLike?: Block }
}
type TrustPolicy = { Version: string; Statement: Statement[] }
type TokenClaims = { iss: string; sub: string; aud: string | string[] }

const list = (v: string | string[]) => (Array.isArray(v) ? v : [v])

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp('^' + escaped + '$')
}

export function canAssumeRole(policy: TrustPolicy, token: TokenClaims, accountId: string): boolean {
  const provider = token.iss.replace(/^https:\/\//, '')
  const federated = `arn:aws:iam::${accountId}:oidc-provider/${provider}`

  const claimValues = (claim: string): string[] | null =>
    claim === 'sub' ? [token.sub] : claim === 'aud' ? list(token.aud) : null

  const conditionsPass = (cond: Statement['Condition']): boolean => {
    for (const [op, block] of Object.entries(cond ?? {})) {
      for (const [key, expected] of Object.entries(block ?? {})) {
        if (!key.startsWith(provider + ':')) return false
        const values = claimValues(key.slice(provider.length + 1))
        if (!values) return false
        const ok = values.some((v) =>
          list(expected).some((e) => (op === 'StringLike' ? globToRegExp(e).test(v) : v === e)),
        )
        if (!ok) return false
      }
    }
    return true
  }

  const applying = policy.Statement.filter(
    (s) =>
      s.Principal.Federated === federated &&
      list(s.Action).includes('sts:AssumeRoleWithWebIdentity') &&
      conditionsPass(s.Condition),
  )
  if (applying.some((s) => s.Effect === 'Deny')) return false
  return applying.some((s) => s.Effect === 'Allow')
}
```

```ts tests
const ISS = 'https://oidc.eks.eu-central-1.amazonaws.com/id/ABC'
const P = 'oidc.eks.eu-central-1.amazonaws.com/id/ABC'
const ACCOUNT = '111122223333'
const FED = `arn:aws:iam::${ACCOUNT}:oidc-provider/${P}`
const api = { iss: ISS, sub: 'system:serviceaccount:devquest:api', aud: 'sts.amazonaws.com' }
const strict = (extra: Record<string, unknown> = {}) => ({
  Version: '2012-10-17',
  Statement: [{
    Effect: 'Allow' as const,
    Principal: { Federated: FED },
    Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: { StringEquals: { [`${P}:sub`]: 'system:serviceaccount:devquest:api', [`${P}:aud`]: 'sts.amazonaws.com' } },
    ...extra,
  }],
})

test('the right ServiceAccount with the right audience may assume the role', () => {
  expect(canAssumeRole(strict(), api, ACCOUNT)).toBe(true)
})
test('another ServiceAccount in the same cluster is rejected', () => {
  expect(canAssumeRole(strict(), { ...api, sub: 'system:serviceaccount:devquest:worker' }, ACCOUNT)).toBe(false)
})
test('a token minted for another audience is rejected', () => {
  expect(canAssumeRole(strict(), { ...api, aud: 'api://AzureADTokenExchange' }, ACCOUNT)).toBe(false)
})
test('an aud array passes if any entry matches', () => {
  expect(canAssumeRole(strict(), { ...api, aud: ['vault', 'sts.amazonaws.com'] }, ACCOUNT)).toBe(true)
})
test('the same SA name in a different cluster (other issuer) is rejected', () => {
  expect(canAssumeRole(strict(), { ...api, iss: 'https://oidc.eks.eu-central-1.amazonaws.com/id/XYZ' }, ACCOUNT)).toBe(false)
})
test('the OIDC provider must belong to the given account', () => {
  expect(canAssumeRole(strict(), api, '999999999999')).toBe(false)
})
test('Action may be an array; other actions do not count', () => {
  expect(canAssumeRole(strict({ Action: ['sts:TagSession', 'sts:AssumeRoleWithWebIdentity'] }), api, ACCOUNT)).toBe(true)
  expect(canAssumeRole(strict({ Action: 'sts:AssumeRole' }), api, ACCOUNT)).toBe(false)
})
test('StringLike wildcards: * matches a run, ? exactly one character', () => {
  const like = (sub: string) => strict({ Condition: { StringLike: { [`${P}:sub`]: sub } } })
  expect(canAssumeRole(like('system:serviceaccount:devquest:*'), { ...api, sub: 'system:serviceaccount:devquest:worker' }, ACCOUNT)).toBe(true)
  expect(canAssumeRole(like('system:serviceaccount:devquest:*'), { ...api, sub: 'system:serviceaccount:devquest-sandbox:api' }, ACCOUNT)).toBe(false)
  expect(canAssumeRole(like('system:serviceaccount:devquest:ap?'), api, ACCOUNT)).toBe(true)
  expect(canAssumeRole(like('system:serviceaccount:devquest:a?'), api, ACCOUNT)).toBe(false)
})
test('regex characters in StringLike are literal', () => {
  const p = strict({ Condition: { StringLike: { [`${P}:sub`]: 'system:serviceaccount:devquest:api.v2' } } })
  expect(canAssumeRole(p, { ...api, sub: 'system:serviceaccount:devquest:apiXv2' }, ACCOUNT)).toBe(false)
  expect(canAssumeRole(p, { ...api, sub: 'system:serviceaccount:devquest:api.v2' }, ACCOUNT)).toBe(true)
})
test('StringEquals accepts a list of allowed values', () => {
  const p = strict({ Condition: { StringEquals: { [`${P}:sub`]: ['system:serviceaccount:devquest:api', 'system:serviceaccount:devquest:worker'] } } })
  expect(canAssumeRole(p, { ...api, sub: 'system:serviceaccount:devquest:worker' }, ACCOUNT)).toBe(true)
})
test('a condition for another provider or an unknown claim can never pass', () => {
  expect(canAssumeRole(strict({ Condition: { StringEquals: { 'oidc.eks.eu-central-1.amazonaws.com/id/XYZ:sub': api.sub } } }), api, ACCOUNT)).toBe(false)
  expect(canAssumeRole(strict({ Condition: { StringEquals: { [`${P}:amr`]: 'x' } } }), api, ACCOUNT)).toBe(false)
})
test('no conditions at all: every ServiceAccount in the cluster gets the role (the classic hole)', () => {
  expect(canAssumeRole(strict({ Condition: undefined }), { ...api, sub: 'system:serviceaccount:kube-system:anything' }, ACCOUNT)).toBe(true)
})
test('an applying Deny wins over Allow', () => {
  const p = strict()
  p.Statement.push({
    Effect: 'Deny' as never, Principal: { Federated: FED }, Action: 'sts:AssumeRoleWithWebIdentity',
    Condition: { StringLike: { [`${P}:sub`]: 'system:serviceaccount:devquest:*' } } as never,
  } as never)
  expect(canAssumeRole(p, api, ACCOUNT)).toBe(false)
})
test('an empty policy allows nothing', () => {
  expect(canAssumeRole({ Version: '2012-10-17', Statement: [] }, api, ACCOUNT)).toBe(false)
})
```
:::

## Code it: how many nodes will this cost?

Before a launch, someone asks "how big must the prod node pool be, and what will it cost?". The
honest first answer is a requests-based simulation per node type, much like the one the Cluster
Autoscaler runs before it buys a node. Dividing total requests by node size is not enough, because
pods don't split across nodes. Five pods requesting 5 GiB each add up to 25 GiB, which looks like
four nodes with ~6.7 GiB free, but only one such pod fits per node, so you need five. Packing pod by
pod catches that.

:::challenge id=ops-19-c2 lang=ts xp=50
title: Plan a node pool from pod requests
Implement `planFor(workloads, nodeType, perNode, minNodes = 1)` and
`cheapestPlan(workloads, nodeTypes, perNode, minNodes = 1)`.

**Per node of a type:**
- allocatable CPU (millicores) = `vcpu * 1000 - 100` (kube/system reserved);
- allocatable memory (MiB) = `memGiB * 1024 - 1024`;
- `perNode` (DaemonSets: log shipper, CNI, CSI…) uses `perNode.cpuMilli`, `perNode.memMiB` and
  `perNode.pods` on **every** node, so the room left for workloads is allocatable minus `perNode`,
  and pod slots are `maxPods - perNode.pods`.

**`planFor`** returns `null` if there is no room at all after `perNode` (pod slots, CPU or memory
`<= 0`), or if any single workload pod (`replicas > 0`) can't fit on an empty node (its CPU or
memory is larger than the room left; equal fits). Workloads with `replicas: 0` are ignored. Otherwise it packs the pods
**first-fit decreasing**:

1. expand every workload into `replicas` individual pods;
2. sort them by CPU request, largest first (ties: larger memory first; otherwise keep input order);
3. put each pod on the **first** already-opened node that still has enough CPU, memory and a free pod
   slot; if none has, open a new node for it.

It returns `{ nodeType, nodes, monthlyUsd }` with `nodes = max(minNodes, nodes opened)` and
`monthlyUsd = nodes × hourlyUsd × 730` (730 hours per month), rounded to cents.

**`cheapestPlan`** calls `planFor` for each type and returns the feasible plan with the lowest
(rounded) `monthlyUsd`. On a tie, the type listed first wins. If no type is feasible, it returns `null`.

hint: Track each opened node as `{ cpu, mem, slots }` remaining, and use `find` for "first node that fits".
hint: Pod slots also limit you: with the VPC CNI an instance type has a hard `maxPods`.
hint: Round with `Math.round(x * 100) / 100` before comparing prices, so 280.32 equals 280.32.

```ts starter
type Workload = { name: string; replicas: number; cpuMilli: number; memMiB: number }
type NodeType = { name: string; vcpu: number; memGiB: number; hourlyUsd: number; maxPods: number }
type PerNode = { cpuMilli: number; memMiB: number; pods: number }
type Plan = { nodeType: string; nodes: number; monthlyUsd: number }

export function planFor(workloads: Workload[], type: NodeType, perNode: PerNode, minNodes = 1): Plan | null {
  return null
}

export function cheapestPlan(workloads: Workload[], types: NodeType[], perNode: PerNode, minNodes = 1): Plan | null {
  return null
}
```

```ts solution
type Workload = { name: string; replicas: number; cpuMilli: number; memMiB: number }
type NodeType = { name: string; vcpu: number; memGiB: number; hourlyUsd: number; maxPods: number }
type PerNode = { cpuMilli: number; memMiB: number; pods: number }
type Plan = { nodeType: string; nodes: number; monthlyUsd: number }

export function planFor(workloads: Workload[], type: NodeType, perNode: PerNode, minNodes = 1): Plan | null {
  const roomCpu = type.vcpu * 1000 - 100 - perNode.cpuMilli
  const roomMem = type.memGiB * 1024 - 1024 - perNode.memMiB
  const slots = type.maxPods - perNode.pods
  if (slots <= 0 || roomCpu <= 0 || roomMem <= 0) return null

  const active = workloads.filter((w) => w.replicas > 0)
  if (active.some((w) => w.cpuMilli > roomCpu || w.memMiB > roomMem)) return null

  const pods = active
    .flatMap((w) => Array.from({ length: w.replicas }, () => ({ cpu: w.cpuMilli, mem: w.memMiB })))
    .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)

  const open: { cpu: number; mem: number; slots: number }[] = []
  for (const pod of pods) {
    let node = open.find((n) => n.cpu >= pod.cpu && n.mem >= pod.mem && n.slots > 0)
    if (!node) {
      node = { cpu: roomCpu, mem: roomMem, slots }
      open.push(node)
    }
    node.cpu -= pod.cpu
    node.mem -= pod.mem
    node.slots -= 1
  }

  const nodes = Math.max(minNodes, open.length)
  const monthlyUsd = Math.round(nodes * type.hourlyUsd * 730 * 100) / 100
  return { nodeType: type.name, nodes, monthlyUsd }
}

export function cheapestPlan(workloads: Workload[], types: NodeType[], perNode: PerNode, minNodes = 1): Plan | null {
  let best: Plan | null = null
  for (const t of types) {
    const p = planFor(workloads, t, perNode, minNodes)
    if (p && (!best || p.monthlyUsd < best.monthlyUsd)) best = p
  }
  return best
}
```

```ts tests
const ds = { cpuMilli: 200, memMiB: 300, pods: 3 }
const app = [
  { name: 'api', replicas: 6, cpuMilli: 500, memMiB: 512 },
  { name: 'worker', replicas: 4, cpuMilli: 1000, memMiB: 1536 },
  { name: 'web', replicas: 3, cpuMilli: 100, memMiB: 128 },
]
const small = { name: 'small', vcpu: 2, memGiB: 8, hourlyUsd: 0.096, maxPods: 29 }
const large = { name: 'large', vcpu: 4, memGiB: 16, hourlyUsd: 0.192, maxPods: 58 }
const xlarge = { name: 'xlarge', vcpu: 8, memGiB: 32, hourlyUsd: 0.384, maxPods: 58 }
const burst = { name: 'burst', vcpu: 2, memGiB: 4, hourlyUsd: 0.0416, maxPods: 4 }

test('small nodes are CPU-bound: 7300m over 1700m of room = 5 nodes', () => {
  const p = planFor(app, small, ds)!
  expect(p.nodes).toBe(5)
  expect(p.nodeType).toBe('small')
  expect(p.monthlyUsd).toBeCloseTo(350.4, 2)
})
test('large nodes need 2', () => {
  const p = planFor(app, large, ds)!
  expect(p.nodes).toBe(2)
  expect(p.monthlyUsd).toBeCloseTo(280.32, 2)
})
test('minNodes raises the count (e.g. one node per zone)', () => {
  expect(planFor(app, large, ds, 3)!.nodes).toBe(3)
  expect(planFor(app, xlarge, ds)!.nodes).toBe(1)
  expect(planFor(app, xlarge, ds, 2)!.nodes).toBe(2)
})
test('the pod limit can dominate: 1 free slot per node means 13 nodes', () => {
  const p = planFor(app, burst, ds)!
  expect(p.nodes).toBe(13)
  expect(p.monthlyUsd).toBeCloseTo(394.78, 2)
})
test('pods do not split: one 5000 MiB pod per small node, even though the memory sum suggests 4', () => {
  const memHeavy = [{ name: 'cache', replicas: 5, cpuMilli: 100, memMiB: 5000 }]
  expect(planFor(memHeavy, small, ds)!.nodes).toBe(5)
  expect(planFor(memHeavy, large, ds)!.nodes).toBe(2)
})
test('a pod that fits on no node of that type makes it infeasible', () => {
  const big = [...app, { name: 'ml', replicas: 1, cpuMilli: 4000, memMiB: 2048 }]
  expect(planFor(big, small, ds)).toBeNull()
  expect(planFor(big, large, ds)).toBeNull()
  expect(planFor(big, xlarge, ds)).not.toBeNull()
})
test('workloads scaled to 0 are ignored', () => {
  const p = planFor([...app, { name: 'ml', replicas: 0, cpuMilli: 64000, memMiB: 1 }], large, ds)
  expect(p).not.toBeNull()
  expect(p!.nodes).toBe(2)
})
test('no pod slots left after DaemonSets is infeasible', () => {
  expect(planFor(app, { ...small, maxPods: 3 }, ds)).toBeNull()
})
test('cheapestPlan picks the lowest monthly cost', () => {
  const best = cheapestPlan(app, [small, burst, large, xlarge], ds, 2)!
  expect(best.nodeType).toBe('large')
  expect(best.nodes).toBe(2)
  expect(best.monthlyUsd).toBeCloseTo(280.32, 2)
})
test('ties go to the type listed first', () => {
  expect(cheapestPlan(app, [xlarge, large], ds)!.nodeType).toBe('xlarge')
  expect(cheapestPlan(app, [large, xlarge], ds)!.nodeType).toBe('large')
})
test('null when nothing fits', () => {
  expect(cheapestPlan([{ name: 'huge', replicas: 1, cpuMilli: 100000, memMiB: 1 }], [small, large], ds)).toBeNull()
})
```
:::

:::info title="From estimate to reality"
Allocatable reservations differ per provider and node size. Look at the real numbers with
`kubectl describe node <name>` under **Allocatable**. A "4 vCPU / 16 GiB" node usually leaves
around 3.8 CPU and 13–14 GiB for pods. Add 20–30 % headroom for rolling updates (surge pods),
fragmentation and the next zone outage. Then let the autoscaler handle the peaks.
:::

## Upgrades and version skew on a managed cluster

Upstream Kubernetes ships about three minor versions a year. Providers support each one for roughly
a year and then **force the issue**: GKE auto-upgrades clusters through their release channel; AKS
drops clusters on an unsupported version to limited "platform support" (paid Long-Term Support
exists on the Premium tier); and EKS moves them into paid **extended support** (about 6× the
control-plane fee) and upgrades them automatically when that ends too. On EKS you can set the
cluster's *upgrade policy* to `STANDARD` so it is auto-upgraded at the end of standard support
instead of quietly becoming six times more expensive. Falling behind is never free. The managed upgrade flow keeps the rules from **Production Kubernetes**
(control plane first, one minor at a time, kubelets never newer than the API server and at most
three minors older), and the provider does the heavy lifting:

1. **Check before you click.** Look for removed APIs in your manifests and Helm releases (`kubent`,
   `pluto`, EKS *upgrade insights*, AKS/GKE deprecation reports). Check that your add-ons and
   controllers (Traefik/Gateway, cert-manager, CNPG, KEDA, ESO) support the target version.
2. **Upgrade dev, then staging, then prod**, with a few days of soak in between. Release channels
   (GKE Rapid/Regular/Stable, AKS auto-upgrade channels) automate this ordering if dev uses a faster
   channel than prod.
3. **Control plane.** One API call. The provider replaces control-plane instances behind a
   stable endpoint, so `kubectl` keeps working.
4. **Add-ons.** On standard EKS, update VPC CNI, CoreDNS, kube-proxy and the EBS CSI driver to
   versions matching the new minor. On AKS and GKE (and EKS Auto Mode) this is automatic.
5. **Nodes.** A **surge upgrade** adds new nodes on the new version (`max_surge`), cordons and drains
   old ones while respecting PDBs, then deletes them. Karpenter does the same through drift
   detection. A PDB that allows zero disruptions (or a single-replica app with `minAvailable: 1`)
   blocks this step and the upgrade stalls or times out.
6. **Maintenance windows** keep automatic patch and node-image updates out of business hours.

For risky jumps (a CNI change, a huge version gap, a new cluster design) many teams prefer
**blue/green clusters**: build a new cluster with Terraform, deploy everything through GitOps,
shift traffic at the DNS or Gateway level, and delete the old one. Clusters-as-code is what makes
that routine instead of heroic.

:::quiz id=ops-19-q9 xp=10
Your AKS control plane is on 1.35, and the `apps` node pool is still on 1.33 because its upgrade
kept failing. You want to go to 1.36 next week. What should you do first?
- [ ] Upgrade the control plane to 1.36 now; node pools may lag forever
- [ ] Delete the PDBs permanently so node upgrades never block again
- [x] Find out why the node pool upgrade fails (usually a PDB that allows no disruption or a pod that can't be rescheduled), fix it and bring the pool to 1.35, then upgrade control plane and pools to 1.36
- [ ] Skip to 1.37 to get ahead of the support window
> Kubelets may be at most three minors older than the API server, and providers only let you move
> one minor at a time. More importantly, a node pool that can't upgrade is a symptom. The usual cause
> is a PodDisruptionBudget that permits zero evictions (for example `minAvailable: 1` with one
> replica) or a pod with no controller, and that blocks *every* future rollout. "Upgrade the control
> plane now" is tempting because the skew policy technically allows 1.36 vs 1.33, but you'd be
> stacking a second upgrade on top of a broken one with no margin left. Deleting PDBs trades the
> stuck upgrade for outages during the next drain.
:::

## A multi-environment layout that scales

Where should dev, staging and prod live? Two rules cover most companies:

- **Separate prod from everything else at the account level**: its own AWS account, Azure
  subscription or GCP project. IAM, quotas, billing and blast radius are scoped per account, so a
  dev mistake (or a dev credential leak) can't touch prod.
- **Separate clusters per environment for prod, namespaces for small non-prod needs.** Preview
  environments per pull request work well as namespaces in a shared dev cluster, but staging should
  look like prod: same Kubernetes version (one minor ahead at most, while testing an upgrade), same
  add-ons, same Terraform module with smaller numbers.

```text
cloud accounts / subscriptions / projects
├── devquest-shared      # registry (images promoted by digest), DNS zones, Terraform state
├── devquest-nonprod     # cluster: dev (+ PR preview namespaces), cluster: staging
└── devquest-prod        # cluster: prod-eu (zones 1-3), maybe prod-us later

repos
├── infra/               # OpenTofu: modules/aks-cluster + envs/{dev,staging,prod}, one state per env
└── gitops/              # Argo CD: clusters/{dev,staging,prod} → apps/<app>/overlays/<env> (Kustomize)
```

The path for a change stays the same everywhere. An image is built once and pushed to the shared
registry. A PR bumps its digest in `overlays/dev`, then staging, then prod. Infrastructure changes
follow the same PR → plan → apply ladder through the environments.

:::quiz id=ops-19-q10 xp=10
A startup with one product wants "proper environments" on EKS without a huge bill. Which layout is
the most sensible starting point?
- [ ] One cluster in one AWS account with `dev`, `staging` and `prod` namespaces, where everyone has cluster-admin
- [x] A prod cluster in its own AWS account; a non-prod account with one cluster for dev/staging namespaces (and PR previews); all built from the same Terraform module
- [ ] A separate cluster per microservice, so teams never affect each other
- [ ] Prod on EKS, staging on kind on a developer laptop to save money
> Prod needs a hard boundary (account, IAM, quotas, blast radius), and the cheapest place to draw it
> is a separate account and cluster. Non-prod can share one cluster, which saves control-plane fees
> and baseline system pods. The single-cluster option is tempting because it is cheapest, but a bad
> dev deploy, a noisy neighbour or one over-privileged credential then reaches production. A cluster
> per microservice multiplies fixed costs and upgrade work. A laptop "staging" shares none of prod's
> networking, identity or storage, so it can't catch exactly the problems this lesson is about.
:::

## Lab: a managed cluster where pods read secrets with no keys

:::lab id=ops-19-lab1 xp=100
title: AKS + Workload Identity reading Key Vault (and a free kind path)

You'll build the identity chain end to end: an OIDC issuer, a federated trust, a ServiceAccount, a
.NET 10 app using `WorkloadIdentityCredential` and a Key Vault secret. **Path A** does it for real on
AKS. **Path B** is free: it runs on kind and shows the exact token the cloud would receive.

:::warn title="Path A costs real money"
Path A creates an AKS cluster (Free tier control plane, one `Standard_D2s_v5` node), a load
balancer, a disk, a Basic container registry and a Key Vault. Expect roughly **US$0.15–0.30 per
hour** while it runs; prices vary by region. Set a **budget alert** on the subscription first, run
everything in one sitting, and **do the teardown step** at the end. If you only want the concepts,
do Path B.
:::

**Path A: AKS (Azure CLI 2.60+, bash, kubectl)**

:::info title="If a command or flag has moved"
Every command below was checked against the Azure CLI and the .NET 10 SDK current in late 2026,
but cloud CLIs evolve. If something is rejected, compare with the official walkthrough
"Deploy and configure workload identity on an AKS cluster" (learn.microsoft.com, AKS docs) and
`az aks create --help`. The NuGet versions (`Azure.Identity` 1.21.0, `Azure.Security.KeyVault.Secrets`
4.12.0) were the latest stable at writing time; newer minor versions work the same way.
:::

1. Sign in and set names. Use bash (`$RANDOM` makes the globally unique names).

```bash
az login
az account set --subscription "<your subscription>"
az provider register --namespace Microsoft.ContainerService   # once per subscription

export LOCATION=westeurope
export RG=rg-devquest-wi-lab
export CLUSTER=aks-devquest-wi-lab
export ACR=acrdevquest$RANDOM
export KV=kv-devquest-$RANDOM
export NS=demo
export SA=secret-reader
```

2. Create the cluster with the OIDC issuer and the workload identity webhook (5–10 minutes).

```bash
az group create -n $RG -l $LOCATION
az aks create -g $RG -n $CLUSTER --tier free \
  --node-count 1 --node-vm-size Standard_D2s_v5 \
  --enable-oidc-issuer --enable-workload-identity \
  --generate-ssh-keys
az aks get-credentials -g $RG -n $CLUSTER
kubectl get nodes
export OIDC_ISSUER=$(az aks show -g $RG -n $CLUSTER --query oidcIssuerProfile.issuerUrl -o tsv)
echo $OIDC_ISSUER
```

Expected: one node `Ready`, and an issuer URL like
`https://westeurope.oic.prod-aks.azure.com/<tenant-id>/<guid>/`. That URL is public, which is how
Entra ID can fetch the cluster's signing keys. If `az aks create` fails with a quota error, pick
another region or VM size.

3. Create a Key Vault (Azure RBAC mode) and a secret. You need the *Secrets Officer* role on it to
   write. Role assignments can take a minute to take effect, so retry the `secret set` if it
   returns `Forbidden`.

```bash
az keyvault create -g $RG -n $KV -l $LOCATION --enable-rbac-authorization true   # RBAC, not access policies
export KV_ID=$(az keyvault show -n $KV --query id -o tsv)
az role assignment create --role "Key Vault Secrets Officer" --scope $KV_ID \
  --assignee-object-id $(az ad signed-in-user show --query id -o tsv) --assignee-principal-type User
az keyvault secret set --vault-name $KV -n greeting --value "hello from key vault" --query name -o tsv
```

4. Create the workload's identity, give it read-only access to secrets, and **trust exactly one
   ServiceAccount**.

```bash
az identity create -g $RG -n id-secret-reader
export CLIENT_ID=$(az identity show -g $RG -n id-secret-reader --query clientId -o tsv)
export PRINCIPAL_ID=$(az identity show -g $RG -n id-secret-reader --query principalId -o tsv)

az role assignment create --role "Key Vault Secrets User" --scope $KV_ID \
  --assignee-object-id $PRINCIPAL_ID --assignee-principal-type ServicePrincipal

az identity federated-credential create -g $RG --identity-name id-secret-reader \
  --name aks-$NS-$SA \
  --issuer "$OIDC_ISSUER" \
  --subject "system:serviceaccount:$NS:$SA" \
  --audiences api://AzureADTokenExchange
```

5. Create a private registry, let the cluster's nodes pull from it, and build the app **in the
   cloud** (no local Docker needed). Make a folder `kvreader` with these four files:

`kvreader/KvReader.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <!-- chiseled images ship without ICU -->
    <InvariantGlobalization>true</InvariantGlobalization>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Azure.Identity" Version="1.21.0" />
    <PackageReference Include="Azure.Security.KeyVault.Secrets" Version="4.12.0" />
  </ItemGroup>

</Project>
```

`kvreader/Program.cs`

```csharp
using Azure.Core;
using Azure.Identity;
using Azure.Security.KeyVault.Secrets;

var vaultUrl = Environment.GetEnvironmentVariable("KEYVAULT_URL")
    ?? throw new InvalidOperationException("Set KEYVAULT_URL, e.g. https://kv-devquest-123.vault.azure.net/");
var secretName = Environment.GetEnvironmentVariable("SECRET_NAME") ?? "greeting";

// In an AKS pod with workload identity, the webhook injects AZURE_CLIENT_ID, AZURE_TENANT_ID,
// AZURE_AUTHORITY_HOST and AZURE_FEDERATED_TOKEN_FILE. Outside the cluster we fall back to `az login`.
// Being explicit (instead of DefaultAzureCredential) means no surprise fallback in production.
TokenCredential credential = Environment.GetEnvironmentVariable("AZURE_FEDERATED_TOKEN_FILE") is not null
    ? new WorkloadIdentityCredential()
    : new AzureCliCredential();

var client = new SecretClient(new Uri(vaultUrl), credential);
KeyVaultSecret secret = await client.GetSecretAsync(secretName);

Console.WriteLine($"Read secret '{secret.Name}' = '{secret.Value}' via {credential.GetType().Name}");
```

`kvreader/Dockerfile`

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY KvReader.csproj .
RUN dotnet restore
COPY . .
RUN dotnet publish -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/runtime:10.0-noble-chiseled
WORKDIR /app
COPY --from=build /app .
ENTRYPOINT ["dotnet", "KvReader.dll"]
```

`kvreader/.dockerignore`

```text
bin/
obj/
```

Optionally try it locally first: `cd kvreader && KEYVAULT_URL=https://$KV.vault.azure.net/ dotnet run`
prints `... via AzureCliCredential`, because *you* hold the Secrets Officer role. Then build and
push it:

```bash
az acr create -g $RG -n $ACR --sku Basic
az aks update -g $RG -n $CLUSTER --attach-acr $ACR     # grants AcrPull to the kubelet identity
az acr build -r $ACR -t kvreader:1.0 ./kvreader
```

Expected: the build log ends with `Run ID: ... was successful after ...`.

If `az acr build` is refused (ACR Tasks are not available on some free-credit or restricted
subscriptions), build locally and push instead. `az acr login` stores a short-lived token for your
local Docker or Podman:

```bash
az acr login -n $ACR
docker build -t $ACR.azurecr.io/kvreader:1.0 ./kvreader
docker push $ACR.azurecr.io/kvreader:1.0

# Podman instead of Docker: fetch the token and log in yourself (the user name is a fixed all-zero GUID)
az acr login -n $ACR --expose-token --query accessToken -o tsv \
  | podman login $ACR.azurecr.io -u 00000000-0000-0000-0000-000000000000 --password-stdin
```

On an ARM laptop (Apple Silicon) add `--platform linux/amd64` to the build, because the lab node is
an x86 VM. Otherwise the pod fails with `exec format error`.

6. Deploy the ServiceAccount and a Job. The heredoc fills in your variables.

```bash
kubectl create namespace $NS
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $SA
  namespace: $NS
  annotations:
    azure.workload.identity/client-id: $CLIENT_ID
---
apiVersion: batch/v1
kind: Job
metadata:
  name: kv-reader
  namespace: $NS
spec:
  backoffLimit: 2
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: $SA
      restartPolicy: Never
      containers:
        - name: kv-reader
          image: $ACR.azurecr.io/kvreader:1.0
          env:
            - { name: KEYVAULT_URL, value: "https://$KV.vault.azure.net/" }
            - { name: SECRET_NAME, value: greeting }
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 128Mi }
EOF
kubectl -n $NS wait --for=condition=complete job/kv-reader --timeout=180s
kubectl -n $NS logs job/kv-reader
```

Expected:

```text
job.batch/kv-reader condition met
Read secret 'greeting' = 'hello from key vault' via WorkloadIdentityCredential
```

7. Look at what the webhook injected. These names are the whole "magic":

```bash
kubectl -n $NS get pod -l job-name=kv-reader \
  -o jsonpath='{range .items[0].spec.containers[0].env[*]}{.name}{"\n"}{end}'
```

You should see `KEYVAULT_URL`, `SECRET_NAME`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_FEDERATED_TOKEN_FILE` and `AZURE_AUTHORITY_HOST`. There is no secret value among them.

8. **Break it on purpose.** Run the same Job as a different ServiceAccount with the *same*
   client-id annotation. The annotation isn't a password: the trust is bound to the subject.

```bash
kubectl -n $NS create serviceaccount impostor
kubectl -n $NS annotate serviceaccount impostor azure.workload.identity/client-id=$CLIENT_ID
cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: kv-impostor
  namespace: $NS
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: impostor
      restartPolicy: Never
      containers:
        - name: kv-reader
          image: $ACR.azurecr.io/kvreader:1.0
          env:
            - { name: KEYVAULT_URL, value: "https://$KV.vault.azure.net/" }
EOF
kubectl -n $NS wait --for=condition=failed job/kv-impostor --timeout=180s
kubectl -n $NS logs job/kv-impostor | grep -m1 AADSTS
```

Expected: an error containing `AADSTS700213` and
`No matching federated identity record found for presented assertion subject 'system:serviceaccount:demo:impostor'`.

9. **Teardown (do not skip).** Deleting the resource group removes the cluster, its node resource
   group (`MC_...`), the registry, the identity and the vault.

```bash
az group delete -n $RG --yes --no-wait
kubectl config delete-context $CLUSTER
kubectl config delete-cluster $CLUSTER
# a few minutes later:
az group exists -n $RG
```

Expected: `false`. The Key Vault stays in a soft-deleted state (free) for its retention period.
Remove it for good with `az keyvault purge -n $KV` if you want to reuse the name.

**Path B: free, on kind (kubectl, node, jq)**

1. Create a throwaway cluster and the same ServiceAccount.

```bash
kind create cluster --name wi-lab
kubectl create namespace demo
kubectl -n demo create serviceaccount secret-reader
```

2. Ask the API server for a token exactly like the one the AKS webhook mounts, and decode it:

```bash
TOKEN=$(kubectl -n demo create token secret-reader --audience api://AzureADTokenExchange --duration 1h)
node -e 'console.log(JSON.stringify(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url")), null, 2))' "$TOKEN"
```

Expected (ids and times differ):

```json
{
  "aud": [
    "api://AzureADTokenExchange"
  ],
  "exp": 1793898850,
  "iat": 1793895250,
  "iss": "https://kubernetes.default.svc.cluster.local",
  "jti": "afb04721-f010-4f7e-beea-fc27c6a157a2",
  "kubernetes.io": {
    "namespace": "demo",
    "serviceaccount": {
      "name": "secret-reader",
      "uid": "71f6a5ad-31c5-4fdd-ba69-164b981c543b"
    }
  },
  "nbf": 1793895250,
  "sub": "system:serviceaccount:demo:secret-reader"
}
```

`sub` is what the federated credential (or IRSA's `:sub` condition) matches, and `aud` is what
`--audiences` matches. `exp - iat` is 3600: one hour.

3. Look at the cluster's OIDC discovery document. This is what a cloud fetches to verify the signature:

```bash
kubectl get --raw /.well-known/openid-configuration | jq '{issuer, jwks_uri}'
kubectl get --raw /openid/v1/jwks | jq '.keys[0] | {kty, alg, kid}'
```

On kind the issuer is `https://kubernetes.default.svc.cluster.local`, which isn't reachable from the
internet. That's exactly why a cloud can't trust a kind cluster, and why managed clusters host the
issuer at a public URL (`--enable-oidc-issuer`, `withOIDC`).

4. Mount the token the way the webhook does (a projected volume), then read it from inside the pod:

```bash
cat <<'EOF' | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: token-demo
  namespace: demo
spec:
  serviceAccountName: secret-reader
  containers:
    - name: shell
      image: busybox:1.37
      command: ["sleep", "3600"]
      volumeMounts:
        - { name: azure-identity-token, mountPath: /var/run/secrets/azure/tokens, readOnly: true }
  volumes:
    - name: azure-identity-token
      projected:
        sources:
          - serviceAccountToken:
              path: azure-identity-token
              audience: api://AzureADTokenExchange
              expirationSeconds: 3600
EOF
kubectl -n demo wait --for=condition=Ready pod/token-demo --timeout=90s
POD_TOKEN=$(kubectl -n demo exec token-demo -- cat /var/run/secrets/azure/tokens/azure-identity-token)
node -e 'const p=JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64url"));console.log(p.sub, p.aud, p["kubernetes.io"].pod.name)' "$POD_TOKEN"
```

Expected: `system:serviceaccount:demo:secret-reader [ 'api://AzureADTokenExchange' ] token-demo`.
The token is **bound to the pod**: delete the pod and the API server rejects the token, even before
it expires. The kubelet rotates the file automatically, and SDKs re-read it.

5. Paste the token's `iss`, `sub` and `aud` into the `canAssumeRole` tests from the challenge above
   (with a matching trust policy) and convince yourself which tweaks to `sub` would be rejected.

6. Teardown: `kind delete cluster --name wi-lab`.

:::pro title="Production habits for workload identity"
One identity per workload per environment (`id-api-prod`, `id-worker-prod`), least-privilege roles
scoped to one vault, bucket or queue, and both identity and trust created by Terraform next to the
cluster. Use the explicit credential type in code (`WorkloadIdentityCredential`, or set
`AZURE_TOKEN_CREDENTIALS` to restrict `DefaultAzureCredential`) so a misconfigured pod fails loudly
instead of silently trying other credential sources. Delete the leftover access keys in the cloud
console: an unused key that still works is still a risk.
:::

- [ ] I can explain, from a decoded token, which claims a cloud checks (`iss`, `sub`, `aud`, `exp`) and where the matching trust is configured
- [ ] Path A: the Job log shows the secret read `via WorkloadIdentityCredential`, and the impostor ServiceAccount fails with `AADSTS700213`. Path B: the pod's projected token shows `sub` `system:serviceaccount:demo:secret-reader`, `aud` `api://AzureADTokenExchange` and the pod's name
- [ ] I found the OIDC issuer URL of my cluster and know why it must be publicly reachable for cloud federation
- [ ] Teardown is done: `az group exists -n $RG` prints `false` (Path A) and/or `kind get clusters` no longer lists `wi-lab` (Path B)
:::

:::cards id=ops-19-cards1 xp=20 title="Managed Kubernetes"
Q: What does a managed Kubernetes service run for you, and what stays yours?
A: The provider runs the control plane (API server, etcd, scheduler, controllers) with HA, backups and patches. You own versions and upgrade timing, nodes (sizes, pools, rollouts), add-on compatibility, networking design, IAM for workloads and everything you deploy.
Q: GKE Autopilot / EKS Auto Mode / AKS Automatic in one sentence?
A: The provider also manages nodes, core add-ons and upgrades. You submit pods and it finds capacity (Autopilot bills per pod request).
Q: Why do EKS pods sometimes fail with "failed to assign an IP address"?
A: The VPC CNI gives every pod a real VPC IP. Small subnets or the instance type's ENI/IP limit run out, so use prefix delegation, bigger or secondary CIDRs, or custom networking.
Q: What happens when you create a Service of type LoadBalancer on a managed cluster?
A: The cloud controller manager provisions a real cloud L4 load balancer and IP, which costs money and adds attack surface. Use one Gateway/Ingress entry point and ClusterIP for internal services.
Q: Why use volumeBindingMode WaitForFirstConsumer?
A: Block disks are zonal. Waiting creates the disk in the zone where the pod is actually scheduled, so the pod never ends up unschedulable in another zone.
Q: Name the three workload identity systems.
A: AWS: EKS Pod Identity (or IRSA). Azure: Microsoft Entra Workload ID on AKS (federated identity credential + SA annotation + pod label). GCP: Workload Identity Federation for GKE (IAM principal for ns/KSA, served by the metadata server).
Q: What is the subject of a Kubernetes ServiceAccount token?
A: system:serviceaccount:<namespace>:<serviceaccount-name>. Federated credentials and IRSA trust policies must match it exactly.
Q: What is the biggest mistake in an IRSA trust policy?
A: No sub condition, or a wildcard like system:serviceaccount:*, which lets every ServiceAccount in the cluster assume the role.
Q: Who needs permission to pull from a private registry: the pod or the node?
A: The node (the kubelet's identity): ECR read-only on the node role, AcrPull via --attach-acr, Artifact Registry reader on the node SA. Use imagePullSecrets only for outside registries.
Q: Cluster Autoscaler vs Karpenter?
A: The CA grows predefined node groups with one instance type each. Karpenter picks instance types per pending pod straight from the cloud API and consolidates underused nodes. Both size by requests, not usage.
Q: What actually drives the bill of a Kubernetes cluster?
A: Requests rounded up to whole nodes, plus load balancers, NAT gateway traffic, disks, cross-zone traffic and logs. Rightsize requests, use spot for interruptible work, commit to the baseline, scale non-prod down.
Q: Managed upgrade order?
A: Check removed APIs and add-ons, go dev → staging → prod, control plane one minor at a time, then add-ons, then node pools via surge/drain (PDBs must allow it), all inside maintenance windows.
Q: How should environments be separated?
A: Prod in its own account/subscription/project and cluster. Non-prod can share a cluster with namespaces. Everything comes from the same Terraform module and promotes the same image digest via GitOps.
:::

## Recap

- A managed service runs the **control plane**. You still own versions, nodes, add-on
  compatibility, networking, workload IAM and your apps. Autopilot / Auto Mode / Automatic take
  over nodes too, in exchange for control.
- Pick the cloud your company already uses. The real differences are CNI and IP planning,
  identity, autoscaling and how much the platform does for you.
- Clusters are **code** (OpenTofu/Terraform, eksctl, Bicep…): reviewed plans, one module and one
  state per environment. Terraform builds the cloud resources and GitOps runs what's inside the cluster.
- `LoadBalancer` Services create real, billed cloud LBs. Use one Gateway/Ingress entry point, and keep
  an eye on NAT and cross-zone traffic.
- Block storage is **zonal**: use `WaitForFirstConsumer`, keep capacity in every zone, and prefer
  managed databases.
- **Workload identity** swaps static keys for the cluster's short-lived, pod-bound SA token,
  trusted by the cloud for an exact `sub` and `aud`. Never wildcard the subject.
- The **node** identity pulls images. Keep the registry close and promote by digest.
- **Requests are the bill**: rightsize, use spot for interruptible work, let the CA/Karpenter add and
  remove nodes, and watch PDBs so consolidation and upgrades can drain nodes.
- Upgrade dev → staging → prod, one minor at a time, before the provider forces it (or bills
  extended support).
