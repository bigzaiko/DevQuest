---
id: cl-10
title: "The Managed Equivalents: Azure & AWS"
level: advanced
minutes: 130
xp: 200
summary: Translate every tool in this region into what an Azure or AWS shop runs on day one — managed Redis, Service Bus and SQS, Blob SAS vs S3 presigned URLs, KEDA on AKS/EKS and Container Apps, Entra ID and Cognito, Azure Monitor and CloudWatch, Key Vault and managed identity — with what changes in .NET code, what stays the same, pricing traps and a fully local emulator lab.
---

Everything in this region so far ran on infrastructure **you** operate: Redis 8 in a container,
RabbitMQ and Kafka, SeaweedFS as S3, Keycloak with its own Postgres, KEDA in kind, and the
OpenTelemetry → Tempo/Prometheus/Loki stack. That's the best way to *learn* the concepts, because
nothing is hidden behind a portal.

Then you join a company, open the infrastructure repo, and see `azurerm_servicebus_namespace`,
`aws_sqs_queue`, `DefaultAzureCredential` and an IAM role ARN where you expected a password. None
of that is new *thinking*. It's the same patterns with a different operator, a different identity
model and a different bill. This lesson is the translation table, plus the places where the
translation leaks.

You'll leave able to:

- name the managed service an Azure or AWS team uses for each tool in this region, and **why** a
  team might still self-host;
- say exactly what changes in **.NET code** (packages, credentials, connection setup) and what
  doesn't (OpenTelemetry, the S3 API, idempotency, the outbox);
- spot the pricing traps before they show up on an invoice;
- run Azure Blob Storage and Azure Service Bus **locally and free** with Azurite and the Service Bus
  emulator, and talk to them from .NET with SAS uploads, duplicate detection and a dead-letter queue.

## The mental model: the contract stays, the operator changes

A managed service sells you three things: someone else **patches, backs up and fails over** the
thing; it is **wired into the cloud's identity system**; and you **pay per use** instead of per
server. Each of those changes a different layer of your system:

```text
 ┌─────────────────────────────────────────────────────────────────────────────────────────┐
 │ 1. Semantics & patterns      at-least-once, idempotency, outbox, leases, TTLs,          │  STAYS
 │                              presigned capabilities, RED/SLOs, OIDC code + PKCE           │
 ├─────────────────────────────────────────────────────────────────────────────────────────┤
 │ 2. Wire protocol / API       Redis RESP, S3 API, AMQP 1.0, Kafka protocol, OTLP, OIDC    │  MOSTLY STAYS
 │                              (but: Blob ≠ S3, Service Bus ≠ RabbitMQ AMQP 0-9-1)          │
 ├─────────────────────────────────────────────────────────────────────────────────────────┤
 │ 3. Identity & network        passwords/keys → managed identity / IAM roles,              │  CHANGES MOST
 │                              public ports → private endpoints / VPC endpoints             │
 ├─────────────────────────────────────────────────────────────────────────────────────────┤
 │ 4. Operations & money        you run it → they run it; per-server → per-request/GB/hour  │  CHANGES COMPLETELY
 └─────────────────────────────────────────────────────────────────────────────────────────┘
```

If you remember one thing: **layers 1 and 2 are portable skills, layer 3 is where day-one bugs
live, layer 4 is where day-thirty surprises live.** Most "it works locally but not in Azure"
tickets are a layer-3 problem: a missing role assignment, a credential picked from the wrong
source, or a private endpoint that DNS doesn't resolve.

## The map in one table

| This region (self-hosted) | Azure | AWS | Same API? |
|---|---|---|---|
| Redis 8 (*Redis Fundamentals*, *Caching*, *Queues & Locks*) | **Azure Managed Redis** (Azure Cache for Redis is being retired) | **ElastiCache** for Valkey / Redis OSS, **MemoryDB** (durable) | Yes, RESP. Cluster rules and auth differ |
| RabbitMQ (*Brokers & Outbox*) | **Service Bus** queues + topics/subscriptions | **SQS** (queues), **SNS** (fan-out), **EventBridge** (routing), Amazon MQ (actual RabbitMQ) | No (Service Bus is AMQP **1.0**, SQS is HTTP) |
| Kafka (*Brokers & Outbox*) | **Event Hubs** (Kafka-compatible endpoint) | **MSK** (actual Kafka), Kinesis | Kafka protocol: yes |
| Redis leased queue (*Queues & Locks*, *Boss*) | Service Bus queue (PeekLock) | SQS (visibility timeout) | No, but same semantics |
| SeaweedFS / S3 (*Object Storage*) | **Blob Storage** | **S3** | S3 → S3 yes. Blob: **no** |
| KEDA (*KEDA* lesson) | KEDA on **AKS** (managed add-on), **Container Apps** scale rules | KEDA on **EKS** (Helm), **Lambda** event source mapping, **ECS** auto scaling | KEDA YAML: yes |
| Keycloak (*Keycloak* lesson) | **Microsoft Entra ID** (staff), **Entra External ID** (customers) | **Cognito** user pools | OIDC: yes. Claims: no |
| OTel → Tempo/Prometheus/Loki (*Observability*) | **Azure Monitor / Application Insights**, managed Prometheus, Managed Grafana | **CloudWatch**, **X-Ray**, Managed Prometheus (AMP), Managed Grafana (AMG) | OTLP + PromQL: yes |
| Env vars / K8s Secrets | **Key Vault** | **Secrets Manager**, SSM Parameter Store | No |
| Passwords in connection strings | **Managed identity**, AKS Workload Identity | **IAM roles**: EKS Pod Identity / IRSA, ECS task role | No |

The rest of the lesson goes row by row: what you get, what changes in code, what stays, what it
costs, and how you develop against it on a laptop.

:::job title="What day one actually looks like"
You won't be asked "what is Service Bus?". You'll be asked to add a queue consumer to an existing
service, and the PR review will check: the queue is defined in Terraform/Bicep (not clicked in the
portal), the app authenticates with **managed identity** (no connection string with a key), the
role assignment is the **narrowest** one (`Azure Service Bus Data Receiver` on that queue, not
`Owner` on the subscription), dead-lettered messages are alerted on, and there's a local story
(emulator or a dev namespace). Know those five checks and you'll look like you've done it before.
:::

## Identity first: credentials disappear, roles appear

On your laptop, every lesson in this region used a **secret**: a Redis password, `devquest/devquest`
for RabbitMQ, an S3 access key for SeaweedFS, a Keycloak client secret. In a well-run cloud
account most of those secrets **don't exist**. The workload itself has an identity, and the
platform hands it short-lived tokens.

```text
 Azure                                                 AWS
 ─────                                                 ───
 Pod (service account "media-worker")                  Pod (service account "media-worker")
   │ projected K8s token                                 │ projected K8s token / Pod Identity agent
   ▼                                                     ▼
 Entra ID: federated credential trusts this SA  ──►    STS: role trusts this SA (IRSA) or the
   │ exchange → access token for                         │ Pod Identity association
   │ https://servicebus.azure.net (≈1 h)                 │ → temporary keys (≈1 h)
   ▼                                                     ▼
 Service Bus checks RBAC:                              SQS checks the IAM policy:
 "Azure Service Bus Data Receiver" on queue?           sqs:ReceiveMessage on this queue ARN?
```

### What changes in .NET code

**Azure** SDKs (`Azure.*` packages) all accept a `TokenCredential`. `DefaultAzureCredential` from
`Azure.Identity` tries a chain of sources until one works. First the **deployed** sources
(environment variables, workload identity, managed identity), then the **developer** ones (Visual
Studio, VS Code, Azure CLI, Azure PowerShell, `azd`). The point is that one line of code works on
your laptop *and* in the cluster. The cost is that it can silently pick the wrong source.
`AZURE_TOKEN_CREDENTIALS` narrows the chain without a code change: `dev` keeps only the developer
tools, `prod` keeps only environment/workload identity/managed identity, and a single credential
name such as `ManagedIdentityCredential` keeps just that one.

```csharp
// dotnet add package Azure.Identity Azure.Messaging.ServiceBus Azure.Storage.Blobs Microsoft.Extensions.Azure
using Azure.Identity;
using Microsoft.Extensions.Azure;

builder.Services.AddAzureClients(clients =>
{
    clients.AddServiceBusClientWithNamespace(builder.Configuration["ServiceBus:Namespace"]); // "<ns>.servicebus.windows.net"
    clients.AddBlobServiceClient(new Uri(builder.Configuration["Storage:BlobEndpoint"]!));   // "https://<acct>.blob.core.windows.net"
    clients.UseCredential(new DefaultAzureCredential());   // one credential for every client
});
```

**AWS** SDKs (`AWSSDK.*`, v4 for new code) resolve credentials through the **default credential
chain** when you don't pass any. It looks at explicit credentials first, then the "you are a
developer" sources (environment variables, the shared profile from `AWS_PROFILE` including IAM
Identity Center/SSO), then the "you are a workload" sources (web identity token for IRSA, container
credentials for the ECS task role and EKS Pod Identity) and finally EC2 instance metadata. Same
idea as Azure: no keys in code, and the environment decides which source wins.

:::warn title="Check the exact order for your SDK version"
The precise order of the AWS chain differs slightly between SDKs and major versions. When it
matters (for example a stray `AWS_ACCESS_KEY_ID` in a container overriding the task role), read
"Credential and profile resolution" in the AWS SDK for .NET developer guide. For Azure, the
"DefaultAzureCredential overview" page in the Azure.Identity docs lists the current chain.
:::

```csharp
// dotnet add package AWSSDK.Extensions.NETCore.Setup AWSSDK.SQS AWSSDK.S3
builder.Services.AddDefaultAWSOptions(builder.Configuration.GetAWSOptions()); // region, profile from config
builder.Services.AddAWSService<Amazon.SQS.IAmazonSQS>();
builder.Services.AddAWSService<Amazon.S3.IAmazonS3>();   // no keys anywhere: the chain finds the role
```

Your **handlers don't change**: they take a `ServiceBusClient` or `IAmazonSQS` from DI exactly as
they took an `IConnectionMultiplexer` or `IAmazonS3` pointed at SeaweedFS.

### The failure modes you will meet

| Symptom | Cause | Fix |
|---|---|---|
| `403 AuthorizationPermissionMismatch` on a blob, but you're **Owner** of the subscription | Azure splits **control plane** (manage the account) from **data plane** (read/write blobs). Owner grants the first only | Assign `Storage Blob Data Contributor` (or Reader) on the account or container |
| 403 for ~5–10 min right after `terraform apply`, then it works | RBAC role assignments take time to propagate | Retry with backoff at startup; don't "fix" it by granting more |
| Works on your laptop with the wrong data | `DefaultAzureCredential` used your **Azure CLI** login, signed into another tenant/subscription | `az account show`; or set `AZURE_TOKEN_CREDENTIALS=dev` / pin `AzureCliCredential` locally |
| Slow first request in production, odd timeouts | `DefaultAzureCredential` probing sources that don't exist there | In prod use `ManagedIdentityCredential` / `WorkloadIdentityCredential`, or set `AZURE_TOKEN_CREDENTIALS=prod` (plus `AZURE_CLIENT_ID` for a user-assigned identity) |
| Pods on EKS have the **node's** permissions | The SDK fell through to EC2 instance metadata (IMDS) because the pod had no role | Use Pod Identity/IRSA for every workload and block IMDS from pods (IMDSv2, hop limit 1) |
| `ExpiredToken` after exactly ~1 hour in a long job | You copied temporary credentials into a static object | Let the SDK client own the credential; it refreshes automatically |

:::warn title="Least privilege is per resource, not per service"
`Storage Blob Data Contributor` on the **whole storage account** lets the worker delete every
customer's uploads. Scope roles to the container (or queue, or topic subscription) the service
actually uses. In AWS, write the policy against one ARN (`arn:aws:s3:::media-prod/uploads/*`) and
not `"Resource": "*"`. The managed services make fine-grained scoping easy, and reviewers will
expect it.
:::

:::quiz id=cl-10-q1 xp=15
You deploy the media API to AKS with workload identity. The managed identity is **Owner** on the
resource group that holds the storage account. Uploading a blob fails with
`403 AuthorizationPermissionMismatch`. The same code works on your laptop. What's the most likely
cause?
- [ ] Workload identity doesn't work with Blob Storage; you need the account key
- [x] Owner is a control-plane role; the identity has no data-plane role such as `Storage Blob Data Contributor`
- [ ] The SAS token expired
- [ ] `DefaultAzureCredential` must be replaced by `StorageSharedKeyCredential` in production
> Azure RBAC separates managing a resource (control plane: create accounts, change settings) from
> using its data (data plane: read/write blobs, send messages). Owner covers the first only. On
> your laptop it worked because **you** probably hold a data role, and `DefaultAzureCredential`
> used your CLI login. Going back to account keys "fixes" it by throwing away the whole point of
> managed identity. There's no SAS in this call path at all.
:::

## Redis → Azure Managed Redis, ElastiCache, MemoryDB

### What you get

| | Azure Managed Redis | ElastiCache (Valkey / Redis OSS) | MemoryDB |
|---|---|---|---|
| Engine | Redis Enterprise based, current Redis versions and modules (JSON, search) | **Valkey** (default for new clusters) or Redis OSS | Valkey / Redis OSS |
| Shape | Clustered, sized by SKU family (Memory Optimized, Balanced, Compute Optimized, Flash Optimized) | Node-based clusters, or **Serverless** (pay per GB stored + compute units) | Node-based, multi-AZ |
| Durability | Optional persistence; still a cache | A cache: replicas + optional snapshots | **Durable**: every write goes to a multi-AZ transaction log. Can be a primary store |
| Auth | Access keys **or Entra ID** tokens | AUTH token, or **IAM auth** (short-lived tokens) | ACL users, IAM auth |

**Why Valkey keeps coming up:** in 2024 Redis moved from the BSD licence to source-available
licences, and the Linux Foundation forked the last BSD version as **Valkey**. Redis 8 added AGPLv3
as an open-source option again, but AWS (and Google) had already standardised on Valkey and
price it below Redis OSS. For your code it makes no difference: Valkey speaks the same RESP
protocol, and StackExchange.Redis, HybridCache's Redis L2 and the SignalR backplane work unchanged.

Microsoft has announced the retirement of **Azure Cache for Redis** (all its tiers) and points
new work to **Azure Managed Redis**. You'll still see `azurerm_redis_cache` in older
infrastructure; migrating it is a real ticket at many companies.

### What changes in code

```csharp
// Azure Managed Redis with Entra ID instead of an access key
// dotnet add package Microsoft.Azure.StackExchangeRedis
var options = ConfigurationOptions.Parse("media-cache.westeurope.redis.azure.net:10000"); // TLS port
await options.ConfigureForAzureWithTokenCredentialAsync(new DefaultAzureCredential());   // refreshes tokens for you
var mux = await ConnectionMultiplexer.ConnectAsync(options);
```

Four things differ from your local `localhost:6379`:

1. **TLS is the norm** (`ssl=true`). Azure Managed Redis listens on port `10000` with TLS by
   default; ElastiCache uses `6379` with in-transit encryption, which is required for IAM auth and
   always on for Serverless. Treat plaintext as a local-only thing.
2. **The password is a token.** Entra ID tokens and ElastiCache IAM tokens are short-lived, so the
   client must re-authenticate. The Microsoft extension does it for Azure; on AWS you generate a
   SigV4-signed token and reconnect (IAM-authenticated connections are also dropped after
   12 hours by design).
3. **It's (usually) a cluster.** Data is sharded by hash slot. A Lua script or `MULTI` that
   touches `jobs` and `processing` in different slots fails with `CROSSSLOT`. This is exactly why
   the boss put every key under the `{media}` hash tag. Code that followed that rule moves without
   changes. (Azure Managed Redis offers OSS and Enterprise cluster policies, and a non-clustered
   option on small SKUs; ElastiCache has cluster mode enabled or disabled. Write for the cluster
   case and every option works.)
4. **Commands may be renamed or blocked.** `KEYS`, `CONFIG`, `FLUSHALL` and `MONITOR` are often
   disabled or restricted. Use `SCAN` (you should anyway).

### Pricing and operational traps

- **You pay for provisioned memory 24/7.** A replica doubles it. Choose the smallest SKU that
  holds your working set plus headroom. A cache that's 5 % used is the most common waste.
- **Serverless isn't automatically cheaper.** ElastiCache Serverless bills data stored *and*
  compute units per request size. Large values (fat JSON blobs) and chatty `SCAN` loops burn
  compute units. Model it against a node price before you switch.
- **Eviction policy decides whether your queue survives.** Managed caches default to a
  `volatile-*` policy, which only evicts keys with a TTL. If someone changes it to `allkeys-lru`
  to "fix" memory pressure, the queue lists from *Redis as Queue, Bus and Lock* (no TTL) become eviction candidates. If Redis is a
  **queue**, alert on memory, and keep the policy at `noeviction` or `volatile-*`.
- **Cross-AZ traffic is billed on AWS.** A client in AZ a talking to a primary in AZ b pays per GB.
  Busy caches feel this.

:::pro title="Cache or database? Pick the product that matches the promise"
ElastiCache and Azure Managed Redis are caches: they can lose recent writes on failover. If
the data **must not be lost** (a session store you can't rebuild, a leaderboard that *is* the
source of truth), MemoryDB is the AWS answer, or keep the truth in Postgres as the boss lesson did and treat
Redis as a rebuildable copy. Teams that "just turn on persistence" on a cache and call it a
database learn the difference during their first failover.
:::

**Local dev:** keep running `redis:8` or `valkey/valkey:8` in Docker. To catch cluster bugs early,
run a cluster locally (or at least test your Lua scripts with all keys under one hash tag). There
is nothing to emulate: the protocol is the product.

:::quiz id=cl-10-q2 xp=15
You move the boss's worker from a single Redis 8 container to a clustered Azure Managed Redis.
The claim script now fails with `CROSSSLOT Keys in request don't hash to the same slot` for a
colleague's new `jobs:priority` list, while the original queue keeps working. Why?
- [ ] Azure Managed Redis doesn't support Lua
- [x] The original keys share the `{media}` hash tag and live in one slot; the new key has no hash tag, so it lands in a different slot
- [ ] Lists can't be used in a cluster
- [ ] The client needs `allowAdmin=true` to run scripts in a cluster
> In a cluster, a single command or script may only touch keys in one hash slot. The slot is
> computed from the part inside `{…}` if there is one. `{media}:jobs` and `{media}:processing` hash
> on `media`, so they share a slot. `jobs:priority` hashes on the whole name. Renaming it to
> `{media}:jobs:priority` fixes it. Lua and lists work fine in clusters, and `allowAdmin` only
> unlocks admin commands such as `FLUSHDB`.
:::

## Brokers → Service Bus, Event Hubs, SQS, SNS, EventBridge, MSK

*Message Brokers & the Outbox Pattern* gave you two mental models: a **queue** (work distribution, delete on ack) and a **log**
(retained, replayable, consumer offsets). The clouds sell both, plus a third shape that RabbitMQ
does with exchanges: **routing/fan-out**.

| Shape | Self-hosted | Azure | AWS |
|---|---|---|---|
| Queue (one consumer group does the work) | RabbitMQ quorum queue, Redis leased list | **Service Bus queue** | **SQS** (standard or FIFO) |
| Fan-out with filters (many subscribers) | RabbitMQ topic exchange | **Service Bus topic** + subscriptions with filter rules | **SNS** topic → SQS queues, or **EventBridge** rules |
| Integration events across teams/SaaS | — | Event Grid | **EventBridge** (schema registry, archive & replay) |
| Log / stream | Kafka, Redis Streams | **Event Hubs** (speaks the Kafka protocol on Standard and up) | **MSK** (real Kafka), MSK Serverless, Kinesis |

### Your *Redis as Queue, Bus and Lock* / boss concepts, already built in

The leased Redis queue you built by hand is what these services do internally:

| You built (*Queues & Locks*, *Boss*) | Service Bus | SQS |
|---|---|---|
| Lease key with TTL | **PeekLock**, `LockDuration` (max 5 min) | **Visibility timeout** (default 30 s, max 12 h) |
| Heartbeat (`PEXPIRE` while working) | `RenewMessageLockAsync` (the processor can auto-renew) | `ChangeMessageVisibility` |
| Reaper returns expired leases | built in: lock expires → message is visible again | built in: timeout expires → message is visible again |
| `attempts` counted at claim | `DeliveryCount` | `ApproximateReceiveCount` |
| DLQ after max attempts | `MaxDeliveryCount` → the queue's own `$DeadLetterQueue` | redrive policy `maxReceiveCount` → a separate DLQ queue |
| Delayed retry (ZSET `:delayed`) | scheduled messages, `ScheduledEnqueueTime` | `DelaySeconds` (max 15 min) |
| Ordering per entity | **sessions** (`SessionId`) | FIFO queue, `MessageGroupId` |
| Dedup on enqueue | **duplicate detection** on `MessageId` (window 20 s – 7 days) | FIFO only: `MessageDeduplicationId` (5-min window) |
| Fencing token for DB writes | — still yours | — still yours |

That last row matters. A Service Bus lock token or an SQS receipt handle tells the **broker** who
may complete the message. It doesn't stop a zombie worker whose lock expired from writing to
**your database** afterwards. The boss's rule "the attempt number is the fencing token" still
applies; `DeliveryCount` is a convenient source for it.

### What stays exactly the same

- **At-least-once.** Every one of these services redelivers. Duplicate detection narrows the window
  on the *send* side; it doesn't make your handler idempotent. Keep the **inbox** from *Message Brokers & the Outbox Pattern*.
- **The outbox.** A Service Bus or SQS send cannot join your Postgres or Azure SQL transaction.
  The dual-write problem is identical, so the transactional outbox is identical.
  (Service Bus transactions only group operations *within* Service Bus.)
- **Small messages, big blobs elsewhere.** Standard Service Bus allows 256 KB per message (Premium
  much more), SQS 1 MiB. Send the job **id**, keep the payload in Postgres or object storage
  ("claim check"), as the boss lesson already does.

### What changes in .NET code

```csharp
// Service Bus: the processor gives you concurrency, lock renewal and settle methods
await using var processor = client.CreateProcessor("media-jobs", new ServiceBusProcessorOptions
{
    MaxConcurrentCalls = 8,
    AutoCompleteMessages = false,                       // you settle explicitly, after the work
    MaxAutoLockRenewalDuration = TimeSpan.FromMinutes(15),
});
processor.ProcessMessageAsync += async args =>
{
    await handler.HandleAsync(args.Message.MessageId, args.Message.Body, args.CancellationToken);
    await args.CompleteMessageAsync(args.Message);      // = ack
};
processor.ProcessErrorAsync += args => { logger.LogError(args.Exception, "SB error"); return Task.CompletedTask; };
await processor.StartProcessingAsync();
```

```csharp
// SQS: you poll. Always long-poll, and delete only after success
var resp = await sqs.ReceiveMessageAsync(new ReceiveMessageRequest
{
    QueueUrl = queueUrl, MaxNumberOfMessages = 10, WaitTimeSeconds = 20,   // long polling
    MessageSystemAttributeNames = ["ApproximateReceiveCount"],
});
foreach (var m in resp.Messages ?? [])
{
    await handler.HandleAsync(m.MessageId, m.Body, ct);
    await sqs.DeleteMessageAsync(queueUrl, m.ReceiptHandle, ct);           // = ack
}
```

If the team uses **MassTransit** or **Wolverine**, the switch from RabbitMQ to Service Bus or SQS
is mostly a transport registration, and their outbox/inbox keep working. Check the framework's
current licensing terms, as *Message Brokers & the Outbox Pattern* said.

### Logs: Event Hubs and MSK keep your Kafka client

For the **log** shape the good news is bigger: your `Confluent.Kafka` producer and consumer from
*Message Brokers & the Outbox Pattern* keep working, because both services speak the Kafka protocol. What changes is, again, the
identity layer:

- **Event Hubs** exposes a Kafka endpoint at `<namespace>.servicebus.windows.net:9093` with
  `SASL_SSL`. Either SASL `PLAIN` with the username `$ConnectionString` and a connection string as
  the password (a shared key, so a secret), or `OAUTHBEARER` with an Entra token from your managed
  identity. An "event hub" is what Kafka calls a topic; namespaces are the cluster.
- **MSK** is real Apache Kafka, so all Kafka features are there. Authentication is usually **IAM**
  (SASL `OAUTHBEARER` with a SigV4-signed token; AWS publishes a signer library for .NET) or mTLS.
  MSK Serverless accepts IAM auth only.
- **What leaks:** Event Hubs is Kafka-*compatible*, not Kafka. Partition counts, retention limits,
  compaction and transaction support depend on the tier, and broker-side tooling (Kafka Connect
  inside the cluster, `kafka-configs` against brokers) doesn't apply. Check the Event Hubs
  "Apache Kafka feature support" page before you promise anything that relies on a niche Kafka
  feature.

### Pricing traps

- **SQS short polling bills empty receives.** A worker looping `ReceiveMessage` with
  `WaitTimeSeconds = 0` makes millions of billable, empty requests a month. Long polling (20 s)
  costs a fraction and reduces latency jitter.
- **Service Bus tiers are a cliff.** Basic has no topics; Standard is a small base fee plus
  per-operation charges and has no private networking; **Premium** (dedicated capacity, VNet/private endpoints, big messages) is
  billed per messaging unit per hour, used or not. Security requirements often force Premium, so
  budget for it early.
- **Event Hubs / MSK are capacity-priced.** Throughput units, processing units or brokers run
  24/7. Don't put a low-volume work queue on a log because "we already have Kafka".
- **Lambda + SQS retry storms.** A poison message retried by a function at full concurrency is
  billed per invocation. Always set `maxReceiveCount` and a DLQ.

**Local dev:** the **Service Bus emulator** (Docker, needs a SQL Server container) and the **Event
Hubs emulator** (Docker, uses Azurite) are free and are what the lab uses. For SQS, LocalStack
has been the classic choice, but its licensing and sign-in requirements have changed recently:
check the current terms before you standardise on it. ElasticMQ is a free, SQS-compatible
alternative for queue-only tests.

:::quiz id=cl-10-q3 xp=15
A worker on ECS reads from a **standard SQS queue** with the default 30-second visibility timeout.
Each job takes 3–8 minutes. The team sees many jobs processed two or three times, and the
`ApproximateReceiveCount` climbs even though nothing crashes. What's the right fix?
- [ ] Switch to a FIFO queue, which guarantees exactly-once processing
- [ ] Increase `maxReceiveCount` on the redrive policy
- [x] Extend the visibility while working (`ChangeMessageVisibility` as a heartbeat, or a timeout above the worst-case job time), and keep the handler idempotent
- [ ] Use short polling so the worker sees messages sooner
> The visibility timeout is SQS's **lease**. After 30 s the message becomes visible again and a
> second worker takes it, exactly like an expired `{media}:lease:*` key in the boss lesson. The fix is the same
> as there: renew the lease while working (or size it for the worst case) and stay idempotent for
> the duplicates you'll still get. FIFO deduplication only applies to *sends* within 5 minutes; it
> doesn't stop redelivery after a timeout. A higher `maxReceiveCount` only delays dead-lettering,
> and polling mode has nothing to do with it.
:::

:::quiz id=cl-10-q4 xp=15
You enable **duplicate detection** (10-minute window) on a Service Bus queue and set
`MessageId = uploadId`. Which statements are true? (Select all that apply.)
- [x] An outbox relay that re-sends the same message after a crash within 10 minutes won't create a second copy
- [ ] The consumer no longer needs an inbox or idempotent handler
- [x] A message whose lock expires mid-processing is still redelivered, so the handler can run twice
- [x] A resend 30 minutes later, after the window, is accepted as a new message
> Duplicate detection is a **send-side** filter: the broker remembers recent `MessageId`s and drops
> repeats inside the window. That's useful for outbox relays, which can't tell whether a send that
> timed out actually went through. It does nothing for **redelivery**: lock expiry, abandon and
> crashes still hand the same message to a consumer again. Resends after the window are new
> messages. So the inbox/idempotency from *Message Brokers & the Outbox Pattern* stays.
:::

## Object storage → Blob Storage and S3

### S3 to S3: change two lines

The code from *Object Storage & Direct Uploads (S3)* was written against the S3 API with **SeaweedFS** behind it. Moving to AWS S3 means
deleting the local overrides:

```csharp
// local (SeaweedFS)                               // AWS
new AmazonS3Client(                                // services.AddAWSService<IAmazonS3>();
    new BasicAWSCredentials(key, secret),          //   no keys: role via the credential chain
    new AmazonS3Config {                           //   region from config, virtual-hosted style URLs,
        ServiceURL = "http://localhost:8333",      //   https by default
        ForcePathStyle = true });
```

Presigned PUTs, multipart uploads with presigned parts, `HEAD` to verify on complete, CORS on
the bucket: all identical. What AWS adds on top of SeaweedFS is mostly **policy and money**:

- **Block Public Access** is on by default. Keep it; serve private reads with presigned GETs or
  CloudFront with origin access control.
- **Lifecycle rules** that you sketched in *Object Storage & Direct Uploads (S3)* become real money. The one every bucket needs:
  `AbortIncompleteMultipartUpload` after a day or so. Abandoned multipart uploads are **billed
  storage you can't see** in a normal listing.
- **Storage classes** (Standard, Intelligent-Tiering, Glacier…) have minimum storage durations and
  retrieval fees. Moving short-lived files to a cold class costs more, not less.
- **Event notifications** (to SQS or EventBridge) can replace the client's "complete" call for
  single-part uploads. The trade-off: you lose the synchronous "upload accepted" response and the
  place where you validated size and type, so most teams keep the explicit complete and use
  events as a safety net.

### S3 to Blob Storage: same idea, different API

Azure Blob Storage is **not** S3-compatible. The concepts map one to one, but the SDK, the URL
format and the signing scheme are different:

| S3 | Azure Blob | Notes |
|---|---|---|
| Bucket | Storage **account** → **container** | Account names are global (3–24 lowercase letters/digits); container names 3–63 chars, lowercase, digits, single hyphens, **no dots** |
| Object key | Blob name | `uploads/{id}/source` works the same; "folders" are prefixes (unless hierarchical namespace is on) |
| Multipart upload: `UploadPart` + `Complete` | Block blob: **`Put Block`** + **`Put Block List`** | Up to 50 000 blocks; uncommitted blocks are discarded automatically after a week |
| Presigned URL (SigV4 in query) | **SAS token** (`sv`, `sr`, `sp`, `se`, `sig` in query) | See the next table |
| Bucket policy / IAM | Azure RBAC + optional ACLs (ADLS) | Data-plane roles, see "Identity first" |
| Lifecycle rules | Lifecycle management policies | Hot / Cool / Cold / Archive tiers, with early-deletion fees on the cold ones |
| S3 event notifications | Event Grid `BlobCreated` events | Usually delivered into a Service Bus queue |
| Bucket CORS | CORS on the **storage account** (Blob service level) | Not per container |

**SAS tokens vs presigned URLs** is the comparison interviewers like, because it shows whether you
understand what a signature actually locks down:

| | S3 presigned PUT | Azure SAS for one blob |
|---|---|---|
| Signed with | the caller's secret key (or temporary STS keys) | the **account key** (service SAS) or a **user delegation key** from Entra ID (user delegation SAS) |
| Max lifetime | 7 days, and never longer than the signing credentials | user delegation SAS: 7 days; service SAS: unlimited (please don't) |
| Scope | one method + one key | resource type `sr` (`b` blob, `c` container) + permission letters `sp` (`r` read, `a` add, `c` create, `w` write, `d` delete, `l` list…) |
| Prevent overwrite | yes on AWS S3 (since 2024): sign `If-None-Match: *` (conditional write); not every S3-compatible store supports it | yes: `sp=c` (create only) fails if the blob exists |
| Lock the content type | yes: sign `Content-Type` as a header | **no** (`rsct` only overrides the *response* header on reads) |
| Limit the size | a presigned **POST** policy (`content-length-range`), or sign an exact `Content-Length` | **no** |
| Restrict IP / protocol | via bucket policy conditions | in the token: `sip` (IP range), `spr=https` |
| Revoke early | rotate/deactivate the signing key | rotate the account key (kills **every** service SAS), revoke user delegation keys, or use a stored access policy |
| Browser must send | `Content-Type` if signed | **`x-ms-blob-type: BlockBlob`** on every `Put Blob` |

The last row is the classic first bug: an upload component that worked against S3 gets
`400 MissingRequiredHeader` from Azure. And because SAS can't enforce type or size, the rule from *Object Storage & Direct Uploads (S3)*
becomes mandatory: **verify the blob on complete** (`GetPropertiesAsync` for size and content type,
magic-byte sniffing for type) before you queue any work.

:::pro title="Prefer user delegation SAS, and turn shared keys off"
A service SAS is signed with the **account key**, which can do anything to the account, never
expires and is shared by every app that uses it. A **user delegation SAS** is signed with a key
your API obtains from Entra ID using its managed identity. It's capped at 7 days and audited, and
no long-lived secret exists. Once every app works that way, set `allowSharedKeyAccess = false` on
the storage account, and leaked connection strings stop working. The lab code shows both paths:
account key locally (Azurite), user delegation key when it runs with managed identity.
:::

:::pro title="Keep the browser cloud-agnostic"
If the product might run on more than one cloud (or SeaweedFS on-prem), don't let the frontend
know which one. Have `POST /uploads` return an **upload ticket**:
`{ url, method: "PUT", headers: { "x-ms-blob-type": "BlockBlob" } }` for Azure, or
`{ url, method: "PUT", headers: { "Content-Type": "video/mp4" } }` for S3. The browser sends exactly
what the server tells it to. The cloud-specific part stays behind one `IUploadTicketIssuer` interface
on the server, with an S3 adapter and a Blob adapter.
:::

### Pricing traps for object storage

- **Egress.** Downloads to the internet are billed per GB on both clouds, and they're usually the
  biggest line for a media product. A CDN (CloudFront, Azure Front Door) helps through caching,
  not through a cheaper per-GB price.
- **NAT gateway processing.** Pods in private subnets reaching S3 through a NAT gateway pay NAT
  data processing on every GB, often more than the storage itself. An **S3 gateway VPC endpoint**
  is free and removes it. On Azure, use a private endpoint or service endpoint instead of routing
  through a firewall/NAT.
- **Requests.** Millions of tiny `PUT`s or `LIST`s (thumbnails, chunked logs) cost more in request
  fees than in storage. Batch, or pick bigger objects.
- **Cold tiers** charge for early deletion and retrieval. They suit data you'll keep for months and
  rarely read, not "last week's uploads".

**Local dev:** **Azurite** emulates Blob (plus Queue and Table) storage in one small container and
speaks the real REST API, so the Azure SDK, SAS tokens and Azure Storage Explorer all work against
it. For S3, keep **SeaweedFS** from *Object Storage & Direct Uploads (S3)*.

:::quiz id=cl-10-q5 xp=15
You port the React uploader from *Object Storage & Direct Uploads (S3)* to Azure. The API now returns a SAS URL with `sp=cw` and
the browser sends the same `PUT` it sent to S3, with `Content-Type: video/mp4`. Azure answers
**400**. A colleague also asks you to "make the SAS enforce mp4 and max 2 GB like the S3 policy".
What do you tell them?
- [ ] Add `rsct=video/mp4` to the SAS; it enforces the upload's content type
- [x] Add the `x-ms-blob-type: BlockBlob` header; SAS can't enforce type or size, so verify both on complete before queueing work
- [ ] Use `sp=r` so Azure validates the file before storing it
- [ ] Switch to an account SAS, which supports content-length conditions
> `Put Blob` requires `x-ms-blob-type`, so its absence is the 400 (`MissingRequiredHeader`). SAS has
> no equivalent of a presigned POST policy's `content-length-range` or a signed `Content-Type`.
> `rsct` only sets the `Content-Type` **response** header when someone *reads* the blob, and an
> account SAS is broader, not stricter. `sp=r` would forbid the upload entirely. The robust answer
> is the same on every cloud: treat the client as untrusted and verify size and type on complete.
:::

### Challenge: translate an upload policy into SAS parameters

Your team's upload service has an S3-style policy object. You're adding an Azure adapter. Write
the translation, including the parts that **don't** translate.

:::challenge id=cl-10-c1 lang=ts xp=60
title: Presigned policy → SAS parameters
Write `presignToSas(policy)` that returns `{ params, warnings }`.

**`params`** (all strings, exactly these keys and no others):

| Field | Value |
|---|---|
| `sv` | always `SAS_VERSION` (from the setup) |
| `sr` | `'b'` for `upload`, `download`, `delete`; `'c'` for `list` |
| `sp` | `upload` → `'c'` (create only), or `'cw'` if `allowOverwrite` is `true`; `download` → `'r'`; `delete` → `'d'`; `list` → `'l'` |
| `st` | `now` minus `clockSkewSeconds` (default `60`) |
| `se` | `now` plus `expiresInSeconds` |
| `spr` | `'https'`, or `'https,http'` if `httpsOnly` is `false` |
| `rsct` | **only** for `download` with a `contentType`: that content type |

Times are ISO 8601 in UTC **without milliseconds**: `2026-11-05T10:15:00Z`.

**`warnings`** (upload only, in this order): `'content-type not enforceable'` if a `contentType` is
given, then `'size not enforceable'` if `maxBytes` is given. Other actions always return `[]`,
even when they receive `contentType` or `maxBytes`.

**Validation** (throw an `Error` whose message contains the quoted word):
- `container` must be a valid Azure container name: 3–63 chars, only lowercase letters, digits and
  hyphens, starting and ending with a letter or digit, no `--` → `'container'`
- `expiresInSeconds` must be a positive integer → `'expiresInSeconds'`; more than 7 days
  (604 800 s) → `'7 days'` (the user delegation SAS limit)
- `key` is required (non-empty) for `upload`/`download`/`delete` → `'key'`; a non-empty `key` on
  `list` → `'list'`

Run the checks in that order (container, then lifetime, then key), before building any output.

hint: Format with `d.toISOString().replace(/\.\d{3}Z$/, 'Z')`. Build dates with `new Date(now.getTime() ± seconds * 1000)`.
hint: The container rule fits one regex: `/^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/`.
hint: Validate before building anything, so a bad policy never yields a token.

```ts setup
const SAS_VERSION = '2026-10-06'

type PresignPolicy = {
  action: 'upload' | 'download' | 'delete' | 'list'
  container: string
  key?: string
  expiresInSeconds: number
  now: Date
  allowOverwrite?: boolean
  contentType?: string
  maxBytes?: number
  httpsOnly?: boolean
  clockSkewSeconds?: number
}

type SasResult = { params: Record<string, string>; warnings: string[] }
```

```ts starter
export function presignToSas(policy: PresignPolicy): SasResult {
  // S3 thinking: a method and an expiry in seconds. Azure wants sr/sp/st/se/spr…
  return {
    params: { sv: SAS_VERSION, se: String(policy.expiresInSeconds) },
    warnings: [],
  }
}
```

```ts solution
export function presignToSas(policy: PresignPolicy): SasResult {
  const { action, container, key, expiresInSeconds, now } = policy

  if (!/^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/.test(container)) {
    throw new Error(`invalid container name: ${container}`)
  }
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error('expiresInSeconds must be a positive integer')
  }
  if (expiresInSeconds > 7 * 24 * 3600) throw new Error('a SAS may live at most 7 days')
  if (action === 'list') {
    if (key) throw new Error('list works on a container, not a key')
  } else if (!key) {
    throw new Error('key is required for blob actions')
  }

  const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const at = (seconds: number) => new Date(now.getTime() + seconds * 1000)

  const sp =
    action === 'upload' ? (policy.allowOverwrite ? 'cw' : 'c')
    : action === 'download' ? 'r'
    : action === 'delete' ? 'd'
    : 'l'

  const params: Record<string, string> = {
    sv: SAS_VERSION,
    sr: action === 'list' ? 'c' : 'b',
    sp,
    st: iso(at(-(policy.clockSkewSeconds ?? 60))),
    se: iso(at(expiresInSeconds)),
    spr: policy.httpsOnly === false ? 'https,http' : 'https',
  }
  if (action === 'download' && policy.contentType) params.rsct = policy.contentType

  const warnings: string[] = []
  if (action === 'upload') {
    if (policy.contentType) warnings.push('content-type not enforceable')
    if (policy.maxBytes !== undefined) warnings.push('size not enforceable')
  }
  return { params, warnings }
}
```

```ts tests
const NOW = new Date('2026-11-05T10:15:00.000Z')
const base = { container: 'media', key: 'uploads/42/source.mp4', expiresInSeconds: 300, now: NOW }

test('upload is create-only by default, with skewed start and https', () => {
  expect(presignToSas({ ...base, action: 'upload' })).toEqual({
    params: { sv: SAS_VERSION, sr: 'b', sp: 'c', st: '2026-11-05T10:14:00Z', se: '2026-11-05T10:20:00Z', spr: 'https' },
    warnings: [],
  })
})
test('allowOverwrite adds write, in canonical order', () => {
  expect(presignToSas({ ...base, action: 'upload', allowOverwrite: true }).params.sp).toBe('cw')
})
test('upload reports what SAS cannot enforce, in order', () => {
  const r = presignToSas({ ...base, action: 'upload', contentType: 'video/mp4', maxBytes: 2_000_000_000 })
  expect(r.warnings).toEqual(['content-type not enforceable', 'size not enforceable'])
  expect(r.params).not.toHaveProperty('rsct')
})
test('download maps to read and sets the response content type', () => {
  const r = presignToSas({ ...base, action: 'download', contentType: 'video/mp4', maxBytes: 10 })
  expect(r.params.sp).toBe('r')
  expect(r.params.sr).toBe('b')
  expect(r.params.rsct).toBe('video/mp4')
  expect(r.warnings).toEqual([])
})
test('delete and list', () => {
  expect(presignToSas({ ...base, action: 'delete' }).params.sp).toBe('d')
  const l = presignToSas({ container: 'media', action: 'list', expiresInSeconds: 60, now: NOW })
  expect(l.params.sr).toBe('c')
  expect(l.params.sp).toBe('l')
})
test('custom skew, http allowed', () => {
  const r = presignToSas({ ...base, action: 'download', clockSkewSeconds: 0, httpsOnly: false })
  expect(r.params.st).toBe('2026-11-05T10:15:00Z')
  expect(r.params.spr).toBe('https,http')
})
test('times have no milliseconds even when now has them', () => {
  const r = presignToSas({ ...base, action: 'upload', now: new Date('2026-11-05T10:15:00.789Z'), clockSkewSeconds: 0 })
  expect(r.params.st).toBe('2026-11-05T10:15:00Z')
  expect(r.params.se).toBe('2026-11-05T10:20:00Z')
})
test('rejects S3-style bucket names', () => {
  for (const c of ['Media', 'my.bucket', 'ab', 'a--b', '-media', 'media-', 'x'.repeat(64)]) {
    expect(() => presignToSas({ ...base, container: c, action: 'upload' })).toThrow('container')
  }
  expect(() => presignToSas({ ...base, container: 'media-uploads-2026', action: 'upload' })).not.toThrow()
})
test('rejects bad lifetimes', () => {
  expect(() => presignToSas({ ...base, action: 'upload', expiresInSeconds: 0 })).toThrow('expiresInSeconds')
  expect(() => presignToSas({ ...base, action: 'upload', expiresInSeconds: 1.5 })).toThrow('expiresInSeconds')
  expect(() => presignToSas({ ...base, action: 'upload', expiresInSeconds: 604_801 })).toThrow('7 days')
  expect(() => presignToSas({ ...base, action: 'upload', expiresInSeconds: 604_800 })).not.toThrow()
})
test('key rules', () => {
  expect(() => presignToSas({ ...base, key: '', action: 'upload' })).toThrow('key')
  expect(() => presignToSas({ container: 'media', expiresInSeconds: 60, now: NOW, action: 'download' })).toThrow('key')
  expect(() => presignToSas({ ...base, action: 'list' })).toThrow('list')
})
```
:::

## KEDA → AKS, EKS, Container Apps, Lambda, ECS

The KEDA lesson's idea, "scale on the work waiting, down to zero", is so useful that every cloud ships
it in some form. The question is how much of KEDA you still see.

| Platform | How queue-based scaling works | You still write |
|---|---|---|
| **AKS + KEDA add-on** | `az aks update --enable-keda`: Microsoft installs and upgrades KEDA | the same `ScaledObject` / `ScaledJob` YAML |
| **EKS** | install KEDA with Helm (or your GitOps tool) | the same YAML; you own KEDA upgrades |
| **Azure Container Apps** | built on KEDA; "scale rules" are KEDA scalers with the same metadata | a scale rule in Bicep/Terraform; no cluster |
| **AWS Lambda** | an SQS **event source mapping** polls and scales concurrency | batch size, max concurrency, partial batch failures |
| **ECS / Fargate** | Application Auto Scaling on a CloudWatch metric (e.g. backlog per task) | alarms and scaling policies |

On AKS or EKS, the KEDA lesson's `ScaledObject` only changes its trigger and its authentication. The
scaler authenticates with the **same workload identity** the app uses:

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata: { name: media-sb-auth }
spec:
  podIdentity:
    provider: azure-workload          # AWS: provider: aws (EKS Pod Identity / IRSA)
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: media-worker }
spec:
  scaleTargetRef: { name: media-worker }
  minReplicaCount: 0
  maxReplicaCount: 30
  cooldownPeriod: 300
  triggers:
    - type: azure-servicebus           # AWS: aws-sqs-queue with queueURL, queueLength, awsRegion
      metadata:
        namespace: media-prod          # the Service Bus namespace name
        queueName: media-jobs
        messageCount: "25"             # target per replica (like listLength in the KEDA lesson)
        activationMessageCount: "0"    # any message wakes the first pod
      authenticationRef: { name: media-sb-auth }
```

Everything you learned about **activation vs scaling**, `cooldownPeriod`, graceful shutdown and
the cluster autoscaler still applies. The node side has managed versions too: the AKS cluster
autoscaler or node auto-provisioning, and Karpenter or EKS Auto Mode on AWS.

### Trade-offs that decide the platform

- **The AKS add-on lags upstream.** Its KEDA version is tied to the AKS version, and you can't tune
  every operator flag. Teams that need a brand-new scaler install KEDA with Helm instead (not both).
- **Container Apps** removes the cluster entirely, scales to zero, and bills per vCPU-second and
  GiB-second while replicas run. It's a great fit for workers like the boss's. You give up
  DaemonSets, custom operators and fine-grained networking. **Container Apps jobs** with an event
  trigger are the managed `ScaledJob`.
- **Lambda** has a hard **15-minute** limit per invocation. A thumbnail fits; a 40-minute
  transcode doesn't. Use ECS/Fargate, Container Apps or AWS Batch for long jobs, or a dedicated
  service like MediaConvert. With SQS triggers, set the queue's visibility timeout to at least
  **six times** the function timeout (AWS's guidance) and enable `ReportBatchItemFailures` so one bad
  message doesn't retry the whole batch.
- **ECS** target tracking needs a running task to compute "backlog per task". Scaling from zero
  usually means a separate step-scaling alarm on queue depth. That's more moving parts than KEDA's
  activation phase.

:::quiz id=cl-10-q6 xp=15
The boss's video worker must move to AWS. Jobs take 5–45 minutes, traffic is bursty with quiet
nights, and the team has no Kubernetes experience. Which option fits best?
- [ ] Lambda with an SQS trigger, because it scales to zero for free
- [x] ECS on Fargate fed by SQS, scaled on queue depth, with the visibility timeout extended while a job runs
- [ ] EKS with KEDA, because it's the same YAML as the KEDA lesson
- [ ] ElastiCache as the queue with a Lambda poller
> Lambda's 15-minute invocation cap rules it out for 45-minute transcodes, however attractive its
> scale-to-zero is. EKS + KEDA works technically, but adopting a Kubernetes platform for one worker,
> on a team without that experience, is a lot of operational weight. ECS on Fargate runs long
> containers, scales on SQS depth and needs no cluster management (AWS Batch is a reasonable
> alternative for pure batch work). Using Redis as the queue would
> throw away SQS's built-in redelivery and DLQ, which you'd then rebuild by hand.
:::

## Keycloak → Entra ID, Entra External ID, Cognito

OIDC is a standard, so the **flows** from the Keycloak lesson carry over: authorization code + PKCE in the
browser, JWT bearer validation in ASP.NET Core, short-lived access tokens, audiences per API. What
changes is **where users live**, **how roles reach the token**, and a handful of claim quirks.

| | Keycloak (*Keycloak* lesson) | Microsoft Entra ID | Entra External ID | Amazon Cognito |
|---|---|---|---|---|
| For whom | anyone you configure | employees, B2B partners | customers (B2C); successor of Azure AD B2C | customers |
| Issuer | `…/realms/devquest` | `https://login.microsoftonline.com/{tenantId}/v2.0` | `https://{tenantId}.ciamlogin.com/{tenantId}/v2.0` | `https://cognito-idp.{region}.amazonaws.com/{poolId}` |
| API audience | client id / audience mapper | Application ID URI, e.g. `api://media-api` | same | **no `aud` in access tokens** (`client_id` instead) |
| Roles in token | `realm_access.roles` | `roles` (app roles), `groups` (object ids) | `roles` | `cognito:groups` |
| Scopes | client scopes | `api://media-api/media.write` → `scp` | same | resource server scopes in `scope` |
| .NET package | JwtBearer | **Microsoft.Identity.Web** (or JwtBearer) | Microsoft.Identity.Web | JwtBearer |
| SPA library | oidc-client-ts | **MSAL.js** (`@azure/msal-react`) | MSAL.js | Amplify, or oidc-client-ts |
| Cost model | your servers | included with Microsoft 365/Entra licences | free tier by monthly active users, then per MAU | tiers by feature, per MAU |

The Keycloak lesson's advice to **map provider claims to your own roles in one place** pays off here. If your
authorization policies check `permission:media.write` and one `IClaimsTransformation` builds that
from `realm_access`, `roles` or `cognito:groups`, switching providers touches one class.

```csharp
// Entra ID: Microsoft.Identity.Web reads Instance/TenantId/ClientId/Audience from "AzureAd"
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddMicrosoftIdentityWebApi(builder.Configuration.GetSection("AzureAd"));

// Cognito: plain JwtBearer, but the access token has no "aud", so check client_id yourself
builder.Services.AddAuthentication().AddJwtBearer(o =>
{
    o.Authority = $"https://cognito-idp.{region}.amazonaws.com/{poolId}";
    o.TokenValidationParameters.ValidateAudience = false;
    o.Events = new JwtBearerEvents
    {
        OnTokenValidated = ctx =>
        {
            var p = ctx.Principal!;
            if (p.FindFirst("token_use")?.Value != "access" || p.FindFirst("client_id")?.Value != appClientId)
                ctx.Fail("wrong token type or client");
            return Task.CompletedTask;
        },
    };
});
```

### Gotchas worth knowing before the ticket arrives

- **Entra v1 vs v2 tokens.** If the API's app registration leaves the accepted token version
  unset, Entra issues **v1** access tokens whose issuer is `https://sts.windows.net/{tenantId}/`,
  and validation configured for the v2 issuer fails with `IDX10205` (issuer invalid). Set it to
  `2` in the manifest: `api.requestedAccessTokenVersion` in the current (Microsoft Graph) manifest
  format, `accessTokenAcceptedVersion` in the older one you'll still see in blog posts and Terraform.
- **Groups overage.** A user in more than ~200 groups gets no `groups` claim, just a pointer to
  Microsoft Graph. Prefer **app roles** for authorization.
- **Cognito access tokens have no audience.** See the code above. ID tokens do have `aud`, which is
  why "it works with the ID token" is a common (wrong) fix. APIs should only accept access tokens.
- **Migrating users.** Password hashes usually can't be exported in a usable form, so teams
  migrate **lazily**: on first login the new provider calls a hook that checks the old one (Cognito
  has a user-migration Lambda trigger; Entra External ID supports custom authentication
  extensions), or users reset their password.

**Local dev:** there is no Entra or Cognito emulator. Teams either use a dedicated **dev tenant/user
pool**, or keep **Keycloak in docker compose** as a stand-in OIDC provider. That works well if the
claims mapping is isolated, as above, and you run an integration test against the real provider in CI.

:::quiz id=cl-10-q7 xp=15
After switching the API from Keycloak to Cognito, you set JwtBearer's `Audience` to the Cognito
**app client id**. Now every request fails with
`IDX10206: Unable to validate audience. The 'audiences' parameter is empty.`, even though the SPA
sends a valid **access token**. A teammate's fix makes the SPA send the **ID token** instead, and
it works. What's going on, and what's the right fix?
- [ ] Cognito tokens are signed with HS256; configure a symmetric key
- [x] Cognito access tokens carry `client_id` instead of `aud`; disable audience validation and check `token_use=access` and `client_id` yourself, and keep sending the access token
- [ ] The ID token fix is correct; APIs should validate ID tokens
- [ ] Set `MapInboundClaims = false` so the audience claim is read correctly
> Cognito's access tokens simply have no `aud` claim, so JwtBearer's audience check has nothing to
> compare: that's exactly what `IDX10206` says (a token with the *wrong* `aud` would give `IDX10214`
> instead). ID tokens have `aud` = your app client id, which is why the workaround "works". But ID tokens are meant
> for the client that signed the user in, not as API credentials. The proper fix keeps access tokens
> and replaces the audience check with `token_use` + `client_id` checks. Cognito signs with RS256 via
> JWKS, and claim mapping doesn't create a missing claim.
:::

## Observability → Azure Monitor, Application Insights, CloudWatch, X-Ray

This row is the best news in the table: **OpenTelemetry is the portable layer**. Your
`ActivitySource`, `Meter`, structured logs, W3C `traceparent` propagation through the queue, RED
metrics and SLO thinking from the Observability lesson move unchanged. You swap the **exporter**, and maybe the backend
where you write queries.

**Azure:** the Azure Monitor OpenTelemetry distro sends traces, metrics and logs to Application
Insights (backed by a Log Analytics workspace):

```csharp
// dotnet add package Azure.Monitor.OpenTelemetry.AspNetCore
builder.Services.AddOpenTelemetry()
    .UseAzureMonitor()                                   // reads APPLICATIONINSIGHTS_CONNECTION_STRING
    .WithTracing(t => t.AddSource("Media.Worker"))       // your own ActivitySources still need registering
    .WithMetrics(m => m.AddMeter("Media.Worker"));
```

You query with **KQL** instead of PromQL/LogQL/TraceQL, and the "Application Map" and transaction
search replace parts of Grafana + Tempo. If you'd rather keep PromQL, use **Azure Monitor managed
service for Prometheus** with **Azure Managed Grafana**, which is common on AKS.

**AWS:** use the **AWS Distro for OpenTelemetry (ADOT)** or the plain OTel SDK with an OTLP
exporter to an OTel Collector / CloudWatch agent. Traces go to **X-Ray** (now accessed through
CloudWatch, with Application Signals for RED-style service views), logs to **CloudWatch Logs**,
metrics to CloudWatch or **Amazon Managed Service for Prometheus**, dashboards in CloudWatch or
**Amazon Managed Grafana**. AWS steers new instrumentation to OpenTelemetry rather than the older
X-Ray SDKs. In .NET that means the code from the Observability lesson stays, with the plain OTLP exporter pointed at a
Collector (ADOT or the CloudWatch agent) running as a sidecar or DaemonSet:

```csharp
// dotnet add package OpenTelemetry.Extensions.Hosting OpenTelemetry.Exporter.OpenTelemetryProtocol
builder.Services.AddOpenTelemetry()
    .WithTracing(t => t.AddSource("Media.Worker"))
    .WithMetrics(m => m.AddMeter("Media.Worker"))
    .UseOtlpExporter();        // OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317 → the Collector
```

The Collector, not your app, holds the AWS-specific exporters and the IAM role that may write to
X-Ray and CloudWatch. Notice the symmetry with Azure: the only line that differs is the exporter.

:::warn title="Observability product names move fast"
Both clouds rename and regroup these features often (X-Ray living inside the CloudWatch console,
Application Signals, Azure Monitor's native OTLP ingestion, which was in preview at the time of
writing). The OpenTelemetry side is stable; the console names are not. Before you configure
anything, check the current "Azure Monitor OpenTelemetry" and "CloudWatch Application Signals /
AWS Distro for OpenTelemetry" docs.
:::

A team can also keep the **whole stack from the Observability lesson** (or Grafana Cloud, Datadog, Honeycomb) and only
change where the Collector exports. That's the strongest argument for instrumenting with OTel
instead of a vendor SDK.

### Pricing traps: you pay per byte and per series

| Trap | Why it hurts | Defence |
|---|---|---|
| Verbose logs | Log Analytics and CloudWatch Logs bill **per GB ingested**. `Information` logs on every request at scale cost more than the servers | `Warning` default in prod, sampling, cheaper log tiers (Basic/Auxiliary logs, CloudWatch Infrequent Access) for audit-type data |
| High-cardinality metrics | CloudWatch bills per custom metric (each dimension combination), Prometheus backends per active series | Never put user ids, job ids or URLs with ids in metric labels. Put them on spans |
| 100 % trace sampling | Every span is ingested and stored | Sampling in the distro or a tail-sampling Collector; keep errors and slow traces |
| No cap | One bad deploy logging in a loop | Daily cap / ingestion alerts on the workspace; budget alerts on the account |

:::quiz id=cl-10-q8 xp=15
After moving to Application Insights, the monthly bill for the media platform jumps 6×. The cause
is a worker metric named `media_job_duration_seconds` with labels `tenant`, `job_id` and
`status`, plus `Information`-level logs for every queue poll. Which changes fix the cost
**without** losing the ability to debug one specific job? (Select all that apply.)
- [x] Drop `job_id` from the metric labels and put it on the job's span (and log scope) instead
- [x] Raise the default log level to `Warning` and stop logging empty polls
- [ ] Switch off tracing entirely; metrics are enough
- [x] Sample traces, keeping errors and slow jobs
> A label like `job_id` creates one time series per job, the classic cardinality explosion. On a
> span the same id is a cheap, searchable attribute, and the trace is how you debug one job.
> Empty-poll logs are pure volume. Sampling (head- or tail-based) cuts span ingestion while keeping
> the interesting traces. Turning tracing off saves money by giving up the "debug one job" ability
> the question asked you to keep.
:::

## Secrets → Key Vault and Secrets Manager

The best secret is one that doesn't exist. With managed identity, the connection strings for Blob,
Service Bus, Event Hubs, Redis (Entra/IAM auth), Azure Database for PostgreSQL and RDS (with IAM
auth) need no password. What's left are **third-party** secrets: a payment provider's API key, an
SMTP password, a webhook signing secret.

```csharp
// Azure: Key Vault as a configuration source. Secret "ConnectionStrings--Billing" → ConnectionStrings:Billing
// dotnet add package Azure.Extensions.AspNetCore.Configuration.Secrets
builder.Configuration.AddAzureKeyVault(
    new Uri($"https://{builder.Configuration["KeyVaultName"]}.vault.azure.net/"),
    new DefaultAzureCredential());   // needs the "Key Vault Secrets User" role, not an access key
```

On AWS, **Secrets Manager** (rotation for RDS and others built in, priced per secret per month plus
API calls) and **SSM Parameter Store** (standard parameters free, no built-in rotation) are the
two options. Load at startup or through a caching client. The configuration-provider pattern is
the same as on Azure:

```csharp
// dotnet add package Amazon.Extensions.Configuration.SystemsManager
// Parameter "/media-api/ConnectionStrings/Billing" → ConnectionStrings:Billing, reloaded every 5 min.
// The task/pod role needs ssm:GetParametersByPath on that path (plus kms:Decrypt for SecureString).
builder.Configuration.AddSystemsManager("/media-api/", TimeSpan.FromMinutes(5));
```

Secrets Manager values can be read through the same provider (via the
`/aws/reference/secretsmanager/<name>` path) or with the `AWSSDK.SecretsManager.Caching` client. On Kubernetes, many teams use the
**Secrets Store CSI driver** (Azure and AWS providers) or **External Secrets Operator** to sync
cloud secrets into pods, so the app just reads files or env vars.

Failure modes to know:

- **Calling the vault per request.** Key Vault and Secrets Manager have request throttling limits
  and per-call prices. Load once, cache, refresh on an interval.
- **Rotation without reload.** The secret rotates, the app keeps the old value in memory, and
  calls fail at 03:00. Use a reload interval (`AzureKeyVaultConfigurationOptions.ReloadInterval`),
  or two valid secrets during the overlap.
- **One vault for everything.** Separate vaults (or prefixes with scoped policies) per environment
  and per app, so dev identities can't read prod secrets.

**Local dev:** `dotnet user-secrets` or a git-ignored `.env`. Code reads `IConfiguration` either
way, so it doesn't care where the value came from. That's the whole design.

## Migration notes: moving the region to a cloud

When a team moves the boss's pipeline from self-hosted to managed services, the order matters more
than the tools:

1. **Identity and networking first.** Workload identity, private endpoints/VPC endpoints, DNS. Every
   later step depends on it, and it's where most of the debugging time goes.
2. **Stateless pieces next.** The API and workers move as containers, still talking to the old
   Redis/SeaweedFS over a VPN or with dual configuration.
3. **Object storage with a dual-read window.** Write new objects to S3/Blob, read from new then
   old, and copy history in the background (`rclone` or AzCopy from SeaweedFS's S3 gateway,
   S3 Batch Operations on AWS). Cut reads over when the copy is verified by count and checksum.
4. **Queues by draining.** Point producers (the outbox relay) at the new broker, let workers drain
   the old queue to zero, then retire it. Idempotent consumers make the overlap safe.
5. **Cache last, and don't migrate it.** A cache is rebuildable by definition. Point at the new one
   and accept a cold start (warm the hottest keys if needed).
6. **Identity provider with lazy migration**, often months later, because it touches every user.

:::warn title="The bill is a design input, not an afterthought"
Before choosing a tier, write down the expected **requests, GB stored, GB egress, log GB and
active series** per month, and put them into the cloud's pricing calculator. Then set **budget
alerts** on day one. Every cost incident in this lesson (empty polls, NAT processing,
high-cardinality metrics, a Premium namespace nobody uses) is cheap to prevent and expensive to
discover.
:::

### What stays the same, whatever the cloud

| Invariant from this region | Why the cloud doesn't change it |
|---|---|
| Postgres (or Azure SQL/RDS) is the source of truth; queues and caches are rebuildable | Managed brokers and caches still fail over, expire and get misconfigured |
| At-least-once + idempotent handlers + inbox | Every managed broker redelivers |
| Transactional outbox | No broker joins your database transaction |
| Leases, heartbeats, fencing tokens | Locks and visibility timeouts are leases with different names |
| Presigned capabilities, verify on complete | SAS and presigned URLs both hand an untrusted client a limited right |
| OpenTelemetry instrumentation, W3C trace context | Every backend ingests OTLP |
| OIDC code + PKCE, short-lived access tokens, audiences | Every provider is an OIDC provider |
| Scale on work waiting, not CPU | KEDA, Container Apps, Lambda and ECS all scale on queue depth |

### The local dev story in one table

| Service | Free local option | Gaps to know |
|---|---|---|
| Azure Blob Storage | **Azurite** | no Entra ID auth by default, so SAS paths differ (account key vs user delegation); start with `--skipApiVersionCheck` when the SDK is newer |
| Azure Service Bus | **Service Bus emulator** (+ SQL Server container) | entities from a JSON file, limits such as a 5-minute max duplicate-detection window, no Premium features |
| Azure Event Hubs | **Event Hubs emulator** (+ Azurite) | fixed entity config |
| Azure Managed Redis / ElastiCache | `redis:8` or `valkey/valkey:8` | run a cluster to catch `CROSSSLOT` early |
| S3 | **SeaweedFS** (*Object Storage*) | no storage classes, IAM or event notifications |
| SQS / SNS | ElasticMQ (SQS API); LocalStack (check current licensing) | IAM is not enforced |
| Entra ID / Cognito | Keycloak as a stand-in OIDC provider, or a dev tenant/pool | claims differ: isolate mapping |
| Azure Monitor / CloudWatch | the *Observability* stack (`grafana/otel-lgtm`) | KQL/CloudWatch queries can't be tested locally |
| Key Vault / Secrets Manager | `dotnet user-secrets`, `.env` | none, if code only reads `IConfiguration` |

:::pro title="Aspire wires the emulators for you"
If the team uses **Aspire** for local orchestration, the Azure hosting integrations can start
the emulators and inject connection strings: `builder.AddAzureServiceBus("sb").RunAsEmulator()`
with `.AddServiceBusQueue("media-jobs")`, and `builder.AddAzureStorage("storage").RunAsEmulator()`
with `.AddBlobs("blobs")`. When deployed, the same app model points at real resources that use managed
identity. It's worth knowing even if you write the compose file yourself, as in the lab.
:::

:::quiz id=cl-10-q9 xp=15
Your API runs on Azure Container Apps with a user-assigned managed identity. Startup takes 20 s
longer than locally, and logs show credential probing timeouts before the first Service Bus call.
Locally everything is fast. What's the cleanest fix?
- [ ] Put the Service Bus connection string with its shared access key in an environment variable
- [x] Use `ManagedIdentityCredential` with the identity's client id in production (or set `AZURE_TOKEN_CREDENTIALS=prod` plus `AZURE_CLIENT_ID`), keep developer credentials for local runs
- [ ] Increase the Container Apps startup probe timeout
- [ ] Switch to `AzureCliCredential`, which is the fastest credential
> `DefaultAzureCredential` walks a chain of sources. In production that probing (and, with a
> **user-assigned** identity, not knowing which client id to use) can cost time and produce
> confusing errors. Being explicit in production, either with a specific credential or by limiting the chain with
> `AZURE_TOKEN_CREDENTIALS`, makes startup fast and failures readable. A user-assigned identity also
> needs its client id (`AZURE_CLIENT_ID`, or `ManagedIdentityId.FromUserAssignedClientId(...)` in
> code), or the platform doesn't know which identity you mean. A shared key undoes managed
> identity, a longer probe hides the problem, and the Azure CLI doesn't exist inside your container.
:::

## Lab: Azure Blob + Service Bus, fully local

:::lab id=cl-10-lab1 xp=150
title: SAS uploads, duplicate detection and a dead-letter queue on emulators
You'll run **Azurite** (Blob Storage) and the **Azure Service Bus emulator** in Docker Compose, then
write a .NET 10 console app that does what the boss's API and worker do, with Azure services:

1. the "API" issues a **SAS** for exactly one blob (create + write, 5 minutes);
2. the "browser" uploads with plain HTTP, and you prove what the SAS allows and refuses;
3. the job is enqueued **twice** with the same `MessageId`, and duplicate detection drops the copy;
4. the worker settles messages with **PeekLock**, and a poison message lands in the **dead-letter queue**
   after `MaxDeliveryCount` deliveries.

The code switches to `DefaultAzureCredential` and a user delegation SAS when you set
`BLOB_ENDPOINT` and `SERVICEBUS_NAMESPACE`, so the same program would run with managed identity in
Azure. Why two emulators instead of LocalStack? Both are free Microsoft images that speak the real
wire protocols (Blob REST, AMQP 1.0), so the official SDKs work unchanged and nothing needs an
account or a licence token.

**Prerequisites:** Docker with Compose v2, the .NET 10 SDK, ~3 GB of disk for the images (SQL
Server is the big one) and about 2 GB of free RAM. Everything is free and local. The SQL Server
password below is a throwaway value for this lab only.

**1. Compose file and emulator config.**

```bash
mkdir -p ~/devquest/cl-10-lab1 && cd ~/devquest/cl-10-lab1
```

```yaml
# compose.yaml: Azure Storage + Service Bus, fully local
services:
  azurite:
    image: mcr.microsoft.com/azure-storage/azurite:latest
    command: azurite-blob --blobHost 0.0.0.0 --blobPort 10000 --skipApiVersionCheck --loose
    ports:
      - "10000:10000"                 # Blob endpoint

  mssql:                              # the Service Bus emulator keeps its state in SQL Server
    image: mcr.microsoft.com/mssql/server:2022-latest
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD: "DevQuest_local_only_1"   # local throwaway password, never reuse
    healthcheck:
      test: ["CMD-SHELL", "/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P \"$$MSSQL_SA_PASSWORD\" -C -Q 'SELECT 1' -b -o /dev/null"]
      interval: 5s
      timeout: 5s
      retries: 30

  servicebus:
    image: mcr.microsoft.com/azure-messaging/servicebus-emulator:latest
    volumes:
      - ./servicebus-config.json:/ServiceBus_Emulator/ConfigFiles/Config.json:ro
    ports:
      - "5672:5672"                   # AMQP (what the SDK talks)
      - "5300:5300"                   # health + management
    environment:
      SQL_SERVER: mssql
      MSSQL_SA_PASSWORD: "DevQuest_local_only_1"
      ACCEPT_EULA: "Y"
    depends_on:
      mssql:
        condition: service_healthy
```

The emulator doesn't create entities through ARM or the portal. It reads them from a JSON file at
startup. Create `servicebus-config.json`:

```json
{
  "UserConfig": {
    "Namespaces": [
      {
        "Name": "sbemulatorns",
        "Queues": [
          {
            "Name": "media-jobs",
            "Properties": {
              "DeadLetteringOnMessageExpiration": true,
              "DefaultMessageTimeToLive": "PT1H",
              "DuplicateDetectionHistoryTimeWindow": "PT5M",
              "ForwardDeadLetteredMessagesTo": "",
              "ForwardTo": "",
              "LockDuration": "PT30S",
              "MaxDeliveryCount": 3,
              "RequiresDuplicateDetection": true,
              "RequiresSession": false
            }
          }
        ],
        "Topics": []
      }
    ],
    "Logging": { "Type": "Console" }
  }
}
```

Start it and wait for the emulator's health endpoint (the emulator needs a few seconds after SQL
Server is healthy):

```bash
docker compose up -d --wait
until curl -sf localhost:5300/health; do sleep 2; done; echo
```

Expected (the exact JSON may vary between emulator versions):

```text
{"status":"healthy","message":"Service is healthy."}
```

`docker compose logs servicebus` ends with
`Emulator Service is Successfully Up!` and prints the emulator's connection string.

:::warn title="If the servicebus container exits"
The emulator validates the config strictly and exits on the first violation. For example, a
`DuplicateDetectionHistoryTimeWindow` above the emulator's limit (5 minutes at the time of
writing; real Service Bus allows up to 7 days) stops it with an error naming that property. Read
`docker compose logs servicebus`, fix the JSON and run `docker compose up -d` again. The current
limits are on the "Azure Service Bus emulator overview" docs page. With **Podman**, use
`podman compose`, or `podman-compose` if `--wait` isn't supported. The SQL Server image is
x86-64 only; on Apple Silicon it runs under Rosetta emulation, which is slower to start.
:::

:::warn title="If the SAS upload returns 403 AuthenticationFailed in Azurite"
The SDK signs SAS tokens with its newest service version (`sv=…` in the URL). `--skipApiVersionCheck`
lets Azurite accept requests from a newer SDK, but if the signing format changed in that version,
an older Azurite can still reject the signature. Pull the current Azurite image first
(`docker compose pull azurite`). If that doesn't help, pin the SDK to an older service version:
`new BlobServiceClient(AzuriteConn, new BlobClientOptions(BlobClientOptions.ServiceVersion.V2025_01_05))`.
:::

**2. Create the app.**

```bash
dotnet new console -n AzureLocalDemo -f net10.0
cd AzureLocalDemo
dotnet add package Azure.Storage.Blobs
dotnet add package Azure.Messaging.ServiceBus
dotnet add package Azure.Identity
```

Replace `Program.cs` with:

```csharp
using System.Net.Http.Headers;
using System.Text;
using Azure.Identity;
using Azure.Messaging.ServiceBus;
using Azure.Storage.Blobs;
using Azure.Storage.Sas;

// ── Configuration: emulator connection strings locally, endpoints + DefaultAzureCredential in Azure ──
// Set BLOB_ENDPOINT ("https://<acct>.blob.core.windows.net") and SERVICEBUS_NAMESPACE
// ("<ns>.servicebus.windows.net") and the program uses identity instead of keys.
// Without them it talks to Azurite and the Service Bus emulator.
const string AzuriteConn =
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;" +
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;" +
    "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";
const string EmulatorConn =
    "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;" +
    "SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";
const string Container = "media";
const string Queue = "media-jobs";

var blobEndpoint = Env("BLOB_ENDPOINT");
var sbNamespace = Env("SERVICEBUS_NAMESPACE");
var credential = new DefaultAzureCredential();   // only used for the endpoint-based clients

var blobs = blobEndpoint is null
    ? new BlobServiceClient(AzuriteConn)
    : new BlobServiceClient(new Uri(blobEndpoint), credential);
await using var bus = sbNamespace is null
    ? new ServiceBusClient(EmulatorConn)
    : new ServiceBusClient(sbNamespace, credential);

var container = blobs.GetBlobContainerClient(Container);
// Fine for a lab. In Azure the container comes from Terraform/Bicep, and the app's role is
// scoped to that one container, so it couldn't (and shouldn't) create containers.
await container.CreateIfNotExistsAsync();          // private by default: no public access

switch (args.FirstOrDefault())
{
    case "upload": await Upload(); break;
    case "poison": await SendJob("poison", "poison"); break;
    case "consume": await Consume(); break;
    default: Console.WriteLine("usage: dotnet run -- upload | poison | consume"); break;
}

async Task Upload()
{
    var id = Guid.CreateVersion7().ToString();
    var blob = container.GetBlobClient($"uploads/{id}/source.txt");

    // 1. The API issues a SAS for exactly one blob: create + write, 5 minutes.
    var sasUri = await IssueUploadSas(blob, TimeSpan.FromMinutes(5));
    Console.WriteLine($"SAS: {Redact(sasUri)}");

    // 2. The "browser" uploads with plain HTTP. No SDK, no account key.
    using var http = new HttpClient();
    var body = Encoding.UTF8.GetBytes("pretend this is a video");

    var noHeader = await http.PutAsync(sasUri, Content(body));
    Console.WriteLine($"PUT without x-ms-blob-type -> {(int)noHeader.StatusCode}");

    var ok = await http.SendAsync(BlobPut(sasUri, body));
    Console.WriteLine($"PUT with x-ms-blob-type    -> {(int)ok.StatusCode}");

    // 3. The SAS is scoped: same token on another blob name, or used for reading, is refused.
    var other = new UriBuilder(sasUri) { Path = sasUri.AbsolutePath.Replace("source.txt", "evil.exe") }.Uri;
    var wrongBlob = await http.SendAsync(BlobPut(other, body));
    Console.WriteLine($"PUT to another blob name   -> {(int)wrongBlob.StatusCode}");
    var read = await http.GetAsync(sasUri);
    Console.WriteLine($"GET with the upload SAS    -> {(int)read.StatusCode}");

    // 4. "Complete": enqueue the job. Sent twice on purpose, like an outbox relay that
    //    crashed after sending but before marking the row as sent.
    await SendJob(id, id);
    await SendJob(id, id);
    Console.WriteLine($"job {id} sent twice (same MessageId)");
}

async Task<Uri> IssueUploadSas(BlobClient blob, TimeSpan ttl)
{
    var sas = new BlobSasBuilder
    {
        BlobContainerName = blob.BlobContainerName,
        BlobName = blob.Name,
        Resource = "b",                                 // b = one blob, c = whole container
        StartsOn = DateTimeOffset.UtcNow.AddMinutes(-1), // tolerate small clock skew
        ExpiresOn = DateTimeOffset.UtcNow.Add(ttl),
        Protocol = blob.Uri.Scheme == "https" ? SasProtocol.Https : SasProtocol.HttpsAndHttp,
    };
    sas.SetPermissions(BlobSasPermissions.Create | BlobSasPermissions.Write);

    if (blob.CanGenerateSasUri)                         // client holds the account key (local, Azurite)
        return blob.GenerateSasUri(sas);

    // Managed identity: no key, so sign with a short-lived user delegation key instead.
    // Needs the "Storage Blob Delegator" (or Data Contributor) role on the account.
    var key = await blobs.GetUserDelegationKeyAsync(
        new Azure.Storage.Blobs.Models.BlobGetUserDelegationKeyOptions(sas.ExpiresOn) { StartsOn = sas.StartsOn });
    return new BlobUriBuilder(blob.Uri)
    {
        Sas = sas.ToSasQueryParameters(key.Value, blobs.AccountName),
    }.ToUri();
}

async Task SendJob(string messageId, string body)
{
    await using var sender = bus.CreateSender(Queue);
    await sender.SendMessageAsync(new ServiceBusMessage(body)
    {
        MessageId = messageId,                          // duplicate detection keys on this
        ContentType = "text/plain",
        Subject = "media.uploaded",
    });
}

async Task Consume()
{
    await using var receiver = bus.CreateReceiver(Queue);   // PeekLock is the default mode
    while (true)
    {
        var batch = await receiver.ReceiveMessagesAsync(maxMessages: 10, maxWaitTime: TimeSpan.FromSeconds(3));
        if (batch.Count == 0) break;
        foreach (var msg in batch)
        {
            var body = msg.Body.ToString();
            if (body == "poison")
            {
                Console.WriteLine($"poison   delivery={msg.DeliveryCount} -> abandon");
                await receiver.AbandonMessageAsync(msg);     // lock released, DeliveryCount + 1
                continue;
            }
            var props = await container.GetBlobClient($"uploads/{body}/source.txt").GetPropertiesAsync();
            Console.WriteLine($"job {body[..8]}… delivery={msg.DeliveryCount} -> blob {props.Value.ContentLength} bytes, complete");
            await receiver.CompleteMessageAsync(msg);
        }
    }
    Console.WriteLine("queue empty");

    await using var dlq = bus.CreateReceiver(Queue, new ServiceBusReceiverOptions { SubQueue = SubQueue.DeadLetter });
    foreach (var msg in await dlq.ReceiveMessagesAsync(10, TimeSpan.FromSeconds(3)))
    {
        Console.WriteLine($"DLQ: {msg.Body} reason={msg.DeadLetterReason} deliveries={msg.DeliveryCount}");
        await dlq.CompleteMessageAsync(msg);                 // a human/redrive tool would decide here
    }
}

static HttpRequestMessage BlobPut(Uri uri, byte[] body)
{
    var req = new HttpRequestMessage(HttpMethod.Put, uri) { Content = Content(body) };
    req.Headers.Add("x-ms-blob-type", "BlockBlob");     // required by Put Blob; S3 has no such header
    return req;
}

static ByteArrayContent Content(byte[] body)
{
    var c = new ByteArrayContent(body);
    c.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
    return c;
}

static string Redact(Uri u) => System.Text.RegularExpressions.Regex.Replace(u.ToString(), "sig=[^&]+", "sig=…");
static string? Env(string name) =>
    Environment.GetEnvironmentVariable(name) is { Length: > 0 } v ? v : null;   // unset or empty = not set
```

The long `AccountKey` is **Azurite's published development key**, the same for every Azurite
install. It's not a secret, and it doesn't work anywhere else.

**3. Upload with a SAS and enqueue the job.**

```bash
dotnet run -- upload
```

Expected (your id, dates and API version will differ):

```text
SAS: http://127.0.0.1:10000/devstoreaccount1/media/uploads/01a1ac7f-3c8c-770d-a4e8-b22d7c025256/source.txt?sv=2026-10-06&spr=https,http&st=2026-11-05T16%3A15%3A22Z&se=2026-11-05T16%3A21%3A22Z&sr=b&sp=cw&sig=…
PUT without x-ms-blob-type -> 400
PUT with x-ms-blob-type    -> 201
PUT to another blob name   -> 403
GET with the upload SAS    -> 403
job 01a1ac7f-3c8c-770d-a4e8-b22d7c025256 sent twice (same MessageId)
```

Read the SAS: `sr=b` (one blob), `sp=cw` (create + write), `st`/`se` (validity window, with a
minute of clock-skew slack), and `sig` over all of it. Compare it with the `X-Amz-*` URL in *Object Storage & Direct Uploads (S3)*.
Each line maps to a row of the SAS vs presigned table. The 400 is the missing `x-ms-blob-type`. The
two 403s show that the signature covers the **blob name** and the **permissions**.

**4. Add a poison message and run the worker.**

```bash
dotnet run -- poison
dotnet run -- consume
```

Expected:

```text
job 01a1ac7f… delivery=1 -> blob 23 bytes, complete
poison   delivery=1 -> abandon
poison   delivery=2 -> abandon
poison   delivery=3 -> abandon
queue empty
DLQ: poison reason=MaxDeliveryCountExceeded deliveries=4
```

- The job was sent twice but delivered **once**: duplicate detection dropped the second send
  because it had the same `MessageId` inside the 5-minute window.
- The poison message was abandoned three times. With `MaxDeliveryCount: 3` the broker moved it to
  the dead-letter sub-queue, with reason `MaxDeliveryCountExceeded`. That's the reaper + attempt
  counter + DLQ you built by hand in the boss lesson, as a queue property. (`deliveries` may show 3 or 4
  depending on the emulator version, because reading from the DLQ counts as a delivery too.)

**5. Prove the duplicate window and the lock.**

1. Run `dotnet run -- upload` twice, then `dotnet run -- consume`: you get **two** jobs, because
   they have different ids. Duplicate detection protects against *resends*, not against two real uploads.
2. Temporarily comment out `await receiver.CompleteMessageAsync(msg);` and run `upload` then
   `consume`. The job is printed with `delivery=1` (the log line still says `complete`, but nothing
   was settled), and the program ends with the message still locked. Run `consume` again right
   away: `queue empty`, because a locked message is invisible to other receivers. Wait 30 seconds
   (the `LockDuration`), restore the line and run `consume` once more: the same job comes back with
   `delivery=2`. That's the redelivery your **idempotent** handler must absorb,
   with duplicate detection switched on.

**6. Clean up.**

```bash
cd .. && docker compose down -v
```

:::tip title="Stretch goals"
- Replace the receive loop with a `ServiceBusProcessor` (`MaxConcurrentCalls = 4`,
  `AutoCompleteMessages = false`) as in the lesson.
- Add a `redrive` command that receives from `SubQueue.DeadLetter` and sends a **new** message to
  `media-jobs` (new `MessageId`, so duplicate detection doesn't drop it), then completes the DLQ copy.
- Add a second queue `media-jobs-sessions` with `"RequiresSession": true` and send three messages
  per `SessionId`: watch them arrive in order per session.
- Write an `IUploadTicketIssuer` with a SeaweedFS (S3) and an Azurite (Blob) implementation that
  both return `{ url, method, headers }`.
:::

- [ ] `docker compose up -d --wait` starts Azurite, SQL Server and the Service Bus emulator, and `/health` on port 5300 reports `healthy`
- [ ] `dotnet run -- upload` prints 400 without the blob-type header, 201 with it, and 403 for another blob name and for a GET
- [ ] `dotnet run -- consume` processes the job once although it was sent twice
- [ ] The poison message is abandoned 3 times and shows up in the DLQ with reason `MaxDeliveryCountExceeded`
- [ ] With the complete call removed, the job came back with `delivery=2` after the 30-second lock expired
- [ ] I can explain which lines change (and which role assignments are needed) to run this program with managed identity in Azure
:::

:::quiz id=cl-10-q10 xp=10
In the lab, which change makes the **same program** run in Azure with managed identity and no
secrets at all?
- [ ] Replace Azurite's account key with the real storage account key from the portal
- [x] Set `BLOB_ENDPOINT` and `SERVICEBUS_NAMESPACE`, and grant the identity data-plane roles (Storage Blob Data Contributor, which can also get the delegation key, plus Service Bus Data Sender and Receiver)
- [ ] Add `UseDevelopmentEmulator=false` to the Service Bus connection string
- [ ] Nothing; `DefaultAzureCredential` reads the emulator connection strings automatically
> With the two endpoint variables set, the code builds clients from endpoints plus `DefaultAzureCredential`,
> and `IssueUploadSas` switches to a **user delegation SAS** because `CanGenerateSasUri` is false
> without an account key. What's left is RBAC: data-plane roles on the storage account/container and
> on the queue (the user delegation key is requested at account level, so that role needs
> account scope, or add `Storage Blob Delegator` on the account and keep the data role on the
> container). Copying the real account key works, but it brings back the long-lived secret that
> managed identity exists to remove. The emulator flag only changes the endpoint behaviour, and
> `DefaultAzureCredential` never reads connection strings.
:::

## Flashcards

:::cards id=cl-10-cards1 xp=20 title="Managed equivalents: Azure & AWS"
Q: What changes most when you move a self-hosted service to a managed one?
A: Identity and networking (keys → managed identity / IAM roles, public ports → private
   endpoints), then operations and pricing. Semantics and most protocols stay.
Q: Control plane vs data plane roles in Azure?
A: Control plane manages the resource (Owner, Contributor). Data plane uses its data
   (Storage Blob Data Contributor, Service Bus Data Receiver). Owner doesn't grant data access.
Q: How does `DefaultAzureCredential` behave, and what do you do in production?
A: It tries env vars, workload identity, managed identity, then dev tools. In production pin a
   specific credential (ManagedIdentityCredential) or set `AZURE_TOKEN_CREDENTIALS=prod`.
Q: Where does the AWS SDK get credentials in a pod on EKS?
A: From the default chain, ideally via EKS Pod Identity or IRSA (web identity token). Without them
   it can fall through to the node's instance role, so block IMDS from pods.
Q: ElastiCache vs MemoryDB?
A: ElastiCache is a cache (replicas, snapshots, can lose recent writes). MemoryDB writes to a
   multi-AZ transaction log and can be a durable primary store.
Q: Why does Valkey matter?
A: It's the Linux Foundation fork of BSD-licensed Redis, the default on ElastiCache, cheaper
   there, and protocol-compatible, so StackExchange.Redis works unchanged.
Q: Service Bus equivalents of lease, heartbeat and attempts?
A: PeekLock with LockDuration (max 5 min), lock renewal, DeliveryCount. MaxDeliveryCount moves the
   message to the built-in dead-letter sub-queue.
Q: SQS equivalents of lease, heartbeat and attempts?
A: Visibility timeout, ChangeMessageVisibility, ApproximateReceiveCount. A redrive policy with
   maxReceiveCount moves it to a separate DLQ.
Q: Does duplicate detection replace an idempotent consumer?
A: No. It drops repeated sends with the same MessageId inside a window. Redelivery after lock
   expiry, abandon or crashes still happens.
Q: Can your Kafka client talk to Event Hubs or MSK?
A: Yes. Event Hubs has a Kafka endpoint on port 9093 (SASL_SSL, connection string or Entra
   OAUTHBEARER); MSK is real Kafka, usually with IAM auth. Tier-dependent Kafka features still differ.
Q: Why do you still need an outbox with Service Bus or SQS?
A: The broker send can't join your database transaction, so the dual-write problem is unchanged.
Q: SAS vs presigned URL: what can SAS NOT enforce?
A: The uploaded content type and the size. Verify both on complete. SAS can enforce create-only
   (`sp=c`), IP range and HTTPS.
Q: Which header does Azure require on Put Blob?
A: `x-ms-blob-type: BlockBlob`. Without it you get 400 MissingRequiredHeader.
Q: Service SAS vs user delegation SAS?
A: Service SAS is signed with the account key. User delegation SAS is signed with a key from Entra ID
   (managed identity), is capped at 7 days, and lets you disable shared key access.
Q: Why can't the boss's transcoder run on Lambda?
A: Lambda invocations are capped at 15 minutes. Long jobs go to ECS/Fargate, Batch or Container Apps.
Q: Cognito access token audience quirk?
A: No `aud` claim. Validate `token_use=access` and `client_id` instead of the audience.
Q: Entra `IDX10205` issuer error after setup?
A: Probably v1 tokens (`sts.windows.net` issuer). Set `accessTokenAcceptedVersion` to 2.
Q: The biggest observability cost traps?
A: Log GB ingested, high-cardinality metric labels (ids), and unsampled traces. Put ids on spans.
Q: Free local stand-ins?
A: Azurite (Blob), Service Bus and Event Hubs emulators, SeaweedFS (S3), Redis/Valkey containers,
   Keycloak for OIDC, the otel-lgtm stack, user-secrets.
:::

## Recap

- **The contract stays, the operator changes.** Patterns (at-least-once, idempotency, outbox,
  leases, presigned capabilities, OTel, OIDC) and most protocols carry over. Identity, networking,
  operations and pricing change.
- **Identity first:** managed identity / IAM roles replace keys. `DefaultAzureCredential` and the AWS
  credential chain find them. Data-plane roles, scoped to one resource, are what grant access.
  Role propagation delays and wrong-source credentials are the day-one bugs.
- **Redis:** Azure Managed Redis or ElastiCache (Valkey) for caches, MemoryDB when it must be
  durable. Expect TLS, token auth and clustering, and hash tags keep scripts portable.
- **Brokers:** Service Bus / SQS give you leases, delivery counts and DLQs built in; SNS/EventBridge
  and Service Bus topics do fan-out; Event Hubs / MSK are logs. Duplicate detection doesn't replace
  the inbox, and nothing replaces the outbox.
- **Object storage:** S3 code moves from SeaweedFS by deleting overrides. Blob is a different API:
  SAS (`sr`, `sp`, `se`), `x-ms-blob-type`, user delegation SAS, and no size/type enforcement, so
  verify on complete.
- **Scaling:** KEDA YAML survives on AKS (add-on) and EKS (Helm); Container Apps is KEDA without a
  cluster; Lambda has a 15-minute cap; ECS needs alarms to wake from zero.
- **Identity providers:** Entra ID (staff), Entra External ID and Cognito (customers). Same OIDC
  flows, different claims. Map claims in one place.
- **Observability:** keep OpenTelemetry and swap the exporter. Watch log GB, metric cardinality and
  sampling.
- **Secrets:** most disappear with managed identity. The rest live in Key Vault / Secrets Manager,
  loaded and cached at startup, with rotation in mind.
- **Local dev is free:** Azurite, the Service Bus and Event Hubs emulators, SeaweedFS, Redis/Valkey,
  Keycloak and the stack from the Observability lesson cover almost everything. Set budget alerts before the first deploy.
