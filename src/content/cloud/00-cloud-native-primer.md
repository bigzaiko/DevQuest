---
id: cl-11
title: "Cloud-Native Primer: The Big Picture"
level: beginner
minutes: 75
xp: 100
summary: What "cloud-native" means, the eight boxes of a typical SaaS backend and why each one exists, one request's journey through them, the vocabulary the rest of this region uses, and the three command-line tools you will type all the time.
---

The lessons in this region each zoom in on one tool: Redis, object storage, message brokers,
Keycloak, OpenTelemetry, KEDA. Each of them makes sense on its own, but they make much *more* sense
once you have seen the whole system they live in. This lesson is the map before the hike. There is
no new technology to install beyond Docker, and nothing here is deep. The goal is that when a later
lesson says *"the worker takes a lease on the job and the presigned URL expires after its TTL"*, every
word in that sentence is already familiar.

## What "cloud-native" actually means

**Why the word exists.** Twenty years ago an application usually ran on *one* big server that the
company owned. If it needed to handle more traffic, someone bought a bigger server ("scaling up").
If that server died, the app was down until someone fixed it. Files were saved to its disk, user
sessions lived in its memory, and background jobs ran from a cron table on that same machine.

Cloud platforms changed the economics: you can rent a small machine for minutes, start fifty copies
of your app when traffic spikes and delete them an hour later. But the old design breaks the moment
there is more than one copy. If session data lives in the memory of copy #1, a user whose next
request lands on copy #2 is suddenly logged out. If uploads go to copy #1's disk, copy #2 cannot
find them.

**Cloud-native** is the name for designing software so that it *expects* this world:

| Idea | Plain meaning | Tiny example |
|---|---|---|
| Many small, identical copies | Run 3, 10 or 0 instances of a service, not one precious server | 3 API pods behind a load balancer |
| Copies can die at any time | A crash or redeploy must not lose data | A job is retried by another worker |
| State lives outside the app | Memory and local disk are scratch space only | Sessions in Redis, files in S3, rows in Postgres |
| Managed building blocks | Rent a database, a queue, an identity provider instead of writing one | Keycloak handles passwords and logins |
| Automated everything | Deploys, scaling and recovery happen without a human clicking | An autoscaler adds workers when the queue grows |
| Observable from outside | You can see what's happening without SSH-ing into a box | A dashboard shows p95 latency per endpoint |

The Containers & Kubernetes region gave you the *platform* side of this (images, pods,
deployments). This region gives you the *building blocks* that cloud-native apps lean on.

:::info title="Cloud-native does not mean 'on AWS'"
Everything in this region runs on your laptop with Docker. "Cloud-native" describes the **design**,
not where it runs. The lesson *The Managed Equivalents: Azure & AWS* at the end of the region maps
every tool here onto what the big clouds sell, and you'll see the concepts transfer one-to-one.
:::

:::quiz id=cl-11-q1 xp=10
Your API runs as **three identical copies** behind a load balancer. It stores the logged-in user's
shopping cart in a variable inside the API process. What goes wrong?
- [ ] Nothing, the load balancer keeps every user on one copy forever
- [x] The next request may hit a different copy, which has no cart for that user
- [ ] The cart is saved three times, so the user is charged three times
- [ ] The database rejects the second copy's connection
> Each copy has its own memory, and the load balancer is free to send consecutive requests to
> different copies. A cart stored in copy #1's memory is invisible to copy #2. ("Sticky sessions" can
> pin a user to a copy, but that copy can still be killed during a deploy, so the cart vanishes
> anyway.) The cloud-native fix is to keep state *outside* the process: a database row or a Redis key.
:::

## The pieces of a typical SaaS backend

Here is the shape you'll find behind most web products, from a todo app to a video platform. Read
the boxes first; each one gets a short "why" below.

```text
                 ┌──────────────────┐
  browser / app  │ Identity provider│  (Keycloak, Entra ID, Cognito)
     │   ▲       └──────────────────┘
     │   │ token        ▲ checks token signature (public keys)
     ▼   │              │
 ┌──────────────┐   ┌───┴──────────┐   ┌────────────┐
 │ Load balancer├──►│  API  (x N)  ├──►│  Database  │  PostgreSQL: the source of truth
 └──────────────┘   └──┬───┬────┬──┘   └────────────┘
                       │   │    │
              ┌────────┘   │    └──────────┐
              ▼            ▼               ▼
         ┌────────┐  ┌───────────┐  ┌────────────────┐
         │ Cache  │  │ Queue /   │  │ Object storage │  S3, Blob, SeaweedFS
         │ Redis  │  │ broker    │  └────────────────┘
         └────────┘  └─────┬─────┘          ▲
                           ▼                │
                     ┌───────────┐          │
                     │ Workers   ├──────────┘
                     │  (x 0..N) │◄── Autoscaler (KEDA) watches queue depth
                     └───────────┘

   Everything above sends logs, metrics and traces ──► Observability (OTel → Grafana)
```

### API

**What:** the program that receives HTTP requests and returns responses, for example
`GET /api/orders/42` → JSON. In this academy it is ASP.NET Core.
**Why it exists:** it is the one place that enforces the rules: who may see order 42, what a valid
order looks like, which other systems to tell. Browsers are never trusted to do this themselves.
**Cloud-native twist:** the API is **stateless** (defined below), so you can run any number of copies.
In front of those copies sits a **load balancer**: a small server (or cloud service) that receives
every incoming request and forwards it to one of the healthy API copies, spreading the work. The
browser only ever knows one address; it never knows which copy answered.

### Database

**What:** durable, queryable storage for your core data (users, orders, invoices). Here: PostgreSQL.
**Why:** it is the **source of truth**. If the database says the order is paid, it is paid. It
gives you transactions, constraints and the guarantee that a committed row survives a power cut.
**Tiny example:** `INSERT INTO orders (id, total) VALUES (42, 19.90);`

### Cache

**What:** a fast, temporary copy of data that is expensive to compute or fetch. Here: Redis.
**Why:** reading from RAM over the network takes well under a millisecond; a complex SQL query can
take 50 ms or more. If 10 000 users load the same product page, you want to run that query once,
not 10 000 times. A cache is allowed to forget things: losing it makes the app slower, not wrong.
**Tiny example:** `SET product:42 '{"name":"Mug"}' EX 300` stores a copy for 300 seconds.

### Queue / message broker

**What:** a place to put "please do this later" messages, which another process picks up.
Examples: RabbitMQ, Kafka, Redis lists/streams, Azure Service Bus, SQS.
**Why:** some work is slow (resize a video, send an email, call a flaky partner API). Doing it inside
the HTTP request makes the user wait, and if the process dies halfway the work is lost. Instead the
API writes a message and answers *"202 Accepted, we're on it"*; a worker does the work at its own
pace, and the broker keeps the message until the work is confirmed done. That confirmation is
called an **ack** (acknowledgement): the worker tells the broker "done, you can delete it".
**Tiny example:** the API publishes `{"type":"SendWelcomeEmail","userId":7}`; the email worker consumes it.

### Workers

**What:** background processes with no HTTP endpoint for users. They read from the queue and do the
work. **Why:** they can be scaled, deployed and crash independently of the API. A slow video encode
never blocks a login.

### Object storage

**What:** a service for storing **files** ("objects") by name ("key") in a "bucket", accessed over
HTTP. Amazon S3 defined the API; Azure Blob, Google Cloud Storage, MinIO and SeaweedFS do the same job.
**Why:** files are big and the API copies have no shared disk. Databases are bad at storing gigabytes
of video. Object storage is cheap, nearly infinite and serves files directly to browsers.
**Tiny example:** key `avatars/user-7.png` in bucket `app-uploads`.

### Identity provider (IdP)

**What:** a dedicated service that handles login: passwords, two-factor, "Sign in with Google",
password reset, and issuing **tokens**. Here: Keycloak.
**Why:** storing passwords safely and implementing login protocols correctly is hard and
security-critical. With an IdP, your API never sees a password; it only checks a signed token that
says *"this is user 7, with role admin, valid until 14:05"*.

### Observability

**What:** the tooling that tells you what the system is doing from the outside: **logs**,
**metrics** and **traces** (defined in the glossary), collected with OpenTelemetry and viewed in
Grafana.
**Why:** with 10 copies of the API, 5 workers and 4 external services, "SSH in and look" is not an
option. When a user says "checkout was slow at 14:02", you need to find *which* part was slow.

### Autoscaler

**What:** a controller that changes how many copies of a service run, based on a signal. Kubernetes'
HPA (Horizontal Pod Autoscaler) usually scales on CPU or memory use and normally keeps at least one
copy; **KEDA** scales on event sources such as queue length, and can go all the way down to zero.
**Why:** traffic is uneven. Paying for 20 workers at 3 a.m. when the queue is empty wastes money;
having 2 workers at 9 a.m. when 5 000 jobs arrive makes users wait.
**Tiny example:** "one worker per 10 waiting messages, minimum 0, maximum 20".

:::tip title="The one-sentence version of each box"
API = enforces rules. Database = remembers forever. Cache = remembers briefly, fast. Queue = remembers
work to do. Workers = do slow work. Object storage = holds files. IdP = proves who you are.
Observability = shows what happened. Autoscaler = picks how many copies run.
:::

:::quiz id=cl-11-q2 xp=10
Users upload profile photos (up to 10 MB). Where should the image bytes be stored?
- [ ] In a `bytea` column in PostgreSQL next to the user row
- [ ] On the local disk of whichever API copy received the upload
- [x] In object storage, with the database storing only the object key
- [ ] In Redis with no TTL, because it is fast
> Object storage is built for large files: cheap, durable and able to serve them straight to browsers.
> The local disk of one API copy disappears on redeploy and is invisible to the other copies. Big
> blobs bloat PostgreSQL's backups and memory. Redis keeps everything in RAM, which is the most
> expensive place to store photos, and it is not meant to be the only copy of anything. The database
> keeps the small, queryable part: `avatar_key = 'avatars/user-7.png'`.
:::

:::quiz id=cl-11-q3 xp=10
After signup the app must send a welcome email through a provider that sometimes takes 8 seconds to
answer. What is the cloud-native design?
- [ ] Call the email provider inside the signup request and make the user wait
- [ ] Fire the call in a background thread of the API process and return immediately
- [x] Save the user, put a "send welcome email" message on a queue, return; a worker sends it
- [ ] Put the email in the cache with a TTL so it gets sent when it expires
> A queue decouples the user's request from slow or flaky work and *keeps* the message until a worker
> confirms it was handled, so a crash means a retry, not a lost email. A background thread looks
> similar, but if that API copy is killed during a deploy, the in-memory work is gone with it. A cache
> expiry is not a delivery mechanism: nothing "happens" when a key expires that you can rely on.
:::

## Glossary: the words the rest of the region assumes

Each term has a plain definition and a tiny example. Come back here whenever a later lesson uses one.

### Latency

The time **one** operation takes, from asking to getting the answer. Measured in milliseconds (ms)
or microseconds (µs; 1 ms = 1000 µs).
*Example:* a Redis `GET` takes ~0.3 ms over the network; a Postgres query 5 ms; a call to a payment
provider 300 ms. Teams usually talk about **p95** or **p99** latency: "95 % of requests were faster
than this". Averages hide the slow requests that users actually complain about.

### Throughput

How **many** operations complete per unit of time, e.g. *requests per second (RPS)* or *jobs per
minute*.
*Example:* one worker handles 2 videos/minute; 10 workers handle 20 videos/minute. Throughput and
latency are different: adding workers raises throughput but does not make one video encode faster.

### Stateless

A service is **stateless** when it keeps nothing between requests that another copy would need.
Everything that must survive lives in the database, cache or object storage.
*Example:* an API that reads the user from the token on every request and loads the cart from Redis
is stateless; any copy can answer any request. That is what lets the autoscaler add or remove copies
freely.

### Idempotent

An operation is **idempotent** when doing it twice has the same effect as doing it once.
*Example:* `SET balance 100` is idempotent (run it five times, balance is 100). `INCRBY balance 10`
is **not** (five runs add 50). In messaging, "mark order 42 as paid" is idempotent; "charge the card
19.90" is not, unless you remember which charges you already made (for example with an
*idempotency key*, a unique id sent with the request so the receiver can say "already done").

### At-least-once delivery

A promise from a queue or broker: every message will be delivered **one or more times**. Never
zero, but sometimes twice.
*Why twice?* A worker finishes the job and crashes a millisecond before telling the broker "done".
The broker can't know the job was done, so it gives the message to another worker. This is why
handlers must be **idempotent**. (The alternatives are *at-most-once*, which can lose messages, and
"exactly-once", which in practice means at-least-once plus deduplication.)

### TTL (time to live)

How long a piece of data is allowed to exist before it is deleted automatically.
*Example:* `SET session:abc '…' EX 1800` keeps a session for 30 minutes. Caches, presigned URLs,
tokens and leases all have TTLs. TTLs are a safety net: even if your code forgets to clean up,
the data eventually goes away.

### Lease

A **time-limited claim** on something. Whoever holds the lease may work on the item; if they don't
renew it before it expires, it is assumed they died and someone else may take over.
*Example:* a worker takes job 17 with a 60-second lease. If it crashes, after 60 s the job becomes
visible again and another worker picks it up. Think of a library book: you have it for two weeks,
then it goes back on the shelf unless you renew. Distributed locks are leases too.

### Backplane

A shared channel that lets several copies of a service **broadcast to each other**.
*Example:* user A is connected over WebSocket to API copy #1, user B to copy #2. When A sends a chat
message, copy #1 publishes it on a Redis pub/sub channel (the backplane); copy #2 receives it and
pushes it to B. Without a backplane, real-time features only work for users on the same copy.
SignalR's Redis backplane is the classic .NET example.

### Presigned URL

A normal-looking URL to an object in storage that carries a **signature and an expiry**, giving
whoever holds it permission to do *one* thing (upload or download *that* object) for a short time.
*Example:* the API returns
`https://s3.example.com/app-uploads/videos/9.mp4?X-Amz-Expires=600&X-Amz-Signature=3f9a…`, and the
browser `PUT`s the file straight to storage for the next 10 minutes. The big file never passes
through your API, and the storage password never leaves your server.

### Token

A small, signed piece of data that proves **who someone is** and **what they may do**, without a
database lookup. In OpenID Connect (OIDC, the standard login protocol that Keycloak, Entra ID and
Google all speak) these are usually **JWTs** (JSON Web Tokens): three base64url-encoded parts
separated by dots, `header.payload.signature`. Encoded is not encrypted: anyone can decode and read
the payload, they just can't change it without breaking the signature.
*Example payload:* `{"sub":"7","roles":["admin"],"exp":1767225600}`. The API checks the signature
with the IdP's public key; if anyone changed `roles`, the signature no longer matches. An **access
token** is sent with each API call (`Authorization: Bearer eyJ…`) and lives minutes; a **refresh
token** lives longer and is used to get new access tokens.

### Log, metric, span (the three signals)

| Signal | What it is | Tiny example | Answers |
|---|---|---|---|
| **Log** | A timestamped text/JSON record of one event | `{"level":"error","msg":"payment declined","orderId":42}` | *What exactly happened here?* |
| **Metric** | A number tracked over time, cheap to store | `http_requests_total{route="/orders",status="500"} 37` | *How much / how often / is it getting worse?* |
| **Span** | One timed step in a request; spans nest into a **trace** | `POST /orders` 340 ms → `INSERT orders` 12 ms → `call payments` 300 ms | *Where did the time go?* |

A **trace** is the tree of all spans for one request, linked by a shared **trace id**, even across
the API, the queue and the worker.

:::quiz id=cl-11-q4 xp=10
Which of these message handlers is **idempotent**?
- [ ] `balance = balance + 10` for a "top up 10" message
- [x] `UPDATE orders SET status = 'paid' WHERE id = 42`
- [ ] `INSERT INTO emails_sent (user_id) VALUES (7)` with no unique constraint
- [ ] "Send a push notification to user 7"
> Setting a status to a fixed value gives the same end state no matter how many times it runs. Adding
> 10 each time, inserting a new row each time, or sending a notification each time all multiply the
> effect when an at-least-once broker redelivers the message. The usual fix is to record a message id
> and skip ids you have already processed.
:::

:::quiz id=cl-11-q5 xp=10
Pair the term with the example. Which statements are correct? (Select all that apply.)
- [x] A worker holds job 17 for 60 s and must renew or lose it: that is a **lease**
- [x] `SET cache:home '…' EX 300`: the `300` is a **TTL**
- [ ] "We process 400 requests per second" describes **latency**
- [x] A URL that allows uploading one file for 10 minutes without a password is a **presigned URL**
- [ ] Redis pub/sub used so API copies can push chat messages to each other's clients is a **token**
> 400 requests per second is **throughput** (how many), not latency (how long one takes). The Redis
> pub/sub channel between API copies is a **backplane**; a token proves identity. The other three
> pairings are exactly the definitions above.
:::

:::quiz id=cl-11-q6 xp=10
Checkout is slow for some users. You want to know whether the time is spent in the database, in the
payment provider or in your own code, *for one specific slow request*. Which signal answers that best?
- [ ] A metric, such as the average request duration
- [x] A trace, whose spans show each step's duration
- [ ] A log line saying "checkout finished"
- [ ] The autoscaler's replica count
> A trace breaks one request into timed spans (`INSERT orders` 12 ms, `call payments` 1800 ms…), so
> the slow step is visible at a glance. Metrics tell you *that* checkout got slower across many
> requests, which is how you notice, but not where one request spent its time. A single log line has
> no breakdown. Replica count is about capacity, not about one request.
:::

:::warn title="Cache and queue are not the source of truth"
A very common beginner mistake is to store something *only* in Redis or *only* in a queue message
("the order exists in the queue, it'll get to the database eventually"). Caches are allowed to
forget, and brokers are configured with limits and expiry. Anything you can't afford to lose
goes into the database first; the cache and the queue hold copies and to-do notes.
:::

## The journey of one request

Let's follow a single, realistic action: **a logged-in user uploads a video and waits for it to
be processed.** This is the scenario of the region's boss fight, *Boss: The Media Processing
Pipeline*, so you'll see it again in full detail.

```text
 1. Browser ──login──► Keycloak                      → gets an access token (JWT, ~5 min TTL)
 2. Browser ──POST /api/videos  (Bearer token)──► API
       API: validate token signature, check role, INSERT videos(id=9, status='uploading')
       API: create a presigned PUT URL for videos/9.mp4 (TTL 10 min)  ──► returns it
 3. Browser ──PUT videos/9.mp4 (300 MB)──► Object storage      (API not involved)
 4. Browser ──POST /api/videos/9/complete──► API
       API: UPDATE videos SET status='queued'; publish {"videoId":9} to the queue
       API ──202 Accepted──► browser
 5. Autoscaler sees queue depth 1 → starts a worker (0 → 1)
 6. Worker takes the message with a lease, downloads 9.mp4, transcodes, uploads 9-720p.mp4
       Worker: UPDATE videos SET status='ready'  (idempotent: safe if redelivered)
       Worker: ack the message; publish "video 9 ready" on the backplane
 7. API copy holding the user's WebSocket ──"ready"──► browser
 8. Browser ──GET /api/videos/9──► API ──cache hit──► Redis   (fast path next time)

 Every step above emits spans with the same trace id → one trace in Grafana/Tempo.
```

Notice what each box contributed, and what would break without it:

* No **IdP** → the API would have to store and check passwords itself.
* No **object storage** → 300 MB would stream through the API, tying up a copy for minutes.
* No **queue** → the transcode would run inside an HTTP request and die with the process.
* No **lease** → a crashed worker would leave video 9 stuck in `queued` forever.
* No **backplane** → the "ready" event could reach an API copy the user isn't connected to.
* No **traces** → "processing was slow" would be a guessing game.

## Practice: think in boxes

:::challenge id=cl-11-c1 lang=ts xp=25
title: Which box does this job?
Write `pickComponent(need)` that returns which part of the system should handle each need. The
possible needs and answers are the string unions below. Use a `switch` (or an object lookup).

| need | answer |
|---|---|
| `'store-orders-permanently'` | `'database'` |
| `'speed-up-repeated-reads'` | `'cache'` |
| `'run-slow-work-later'` | `'queue'` |
| `'store-large-files'` | `'object-storage'` |
| `'log-users-in'` | `'identity-provider'` |
| `'find-slow-requests'` | `'observability'` |
| `'add-workers-when-busy'` | `'autoscaler'` |
| `'enforce-business-rules'` | `'api'` |

hint: A `switch (need) { case 'store-orders-permanently': return 'database' … }` covers it, one `case` per row.
hint: Or build a lookup object: `const map: Record<Need, Component> = { ... }` and `return map[need]`.

```ts starter
type Need =
  | 'store-orders-permanently' | 'speed-up-repeated-reads' | 'run-slow-work-later'
  | 'store-large-files' | 'log-users-in' | 'find-slow-requests'
  | 'add-workers-when-busy' | 'enforce-business-rules'

type Component =
  | 'api' | 'database' | 'cache' | 'queue' | 'object-storage'
  | 'identity-provider' | 'observability' | 'autoscaler'

export function pickComponent(need: Need): Component {
  // Everything goes to the API for now. Is that right?
  return 'api'
}
```

```ts solution
type Need =
  | 'store-orders-permanently' | 'speed-up-repeated-reads' | 'run-slow-work-later'
  | 'store-large-files' | 'log-users-in' | 'find-slow-requests'
  | 'add-workers-when-busy' | 'enforce-business-rules'

type Component =
  | 'api' | 'database' | 'cache' | 'queue' | 'object-storage'
  | 'identity-provider' | 'observability' | 'autoscaler'

const MAP: Record<Need, Component> = {
  'store-orders-permanently': 'database',
  'speed-up-repeated-reads': 'cache',
  'run-slow-work-later': 'queue',
  'store-large-files': 'object-storage',
  'log-users-in': 'identity-provider',
  'find-slow-requests': 'observability',
  'add-workers-when-busy': 'autoscaler',
  'enforce-business-rules': 'api',
}

export function pickComponent(need: Need): Component {
  return MAP[need]
}
```

```ts tests
test('durable data goes to the database', () => {
  expect(pickComponent('store-orders-permanently')).toBe('database')
})
test('repeated reads go to the cache', () => {
  expect(pickComponent('speed-up-repeated-reads')).toBe('cache')
})
test('slow work goes to the queue', () => {
  expect(pickComponent('run-slow-work-later')).toBe('queue')
})
test('large files go to object storage', () => {
  expect(pickComponent('store-large-files')).toBe('object-storage')
})
test('login goes to the identity provider', () => {
  expect(pickComponent('log-users-in')).toBe('identity-provider')
})
test('finding slow requests is observability', () => {
  expect(pickComponent('find-slow-requests')).toBe('observability')
})
test('adding workers is the autoscaler', () => {
  expect(pickComponent('add-workers-when-busy')).toBe('autoscaler')
})
test('business rules stay in the API', () => {
  expect(pickComponent('enforce-business-rules')).toBe('api')
})
```
:::

### Adding up latency

Latency along a request path follows two simple rules:

* Steps done **one after another** (sequentially) **add up**: 2 ms + 5 ms + 30 ms = 37 ms.
* Steps done **at the same time** (in parallel, e.g. `await Promise.all([...])`) cost only as
  much as the **slowest** of them: in parallel, 20 ms and 45 ms take 45 ms, not 65 ms.

```ts
// sequential: 5 + 30 = 35 ms
const user = await db.getUser(id)          // 5 ms
const orders = await payments.list(id)     // 30 ms

// parallel: max(5, 30) = 30 ms
const [u, o] = await Promise.all([db.getUser(id), payments.list(id)])
```

This is why the first optimisation in many slow endpoints is simply "do the independent calls in
parallel", and why one slow external call dominates everything else.

:::challenge id=cl-11-c2 lang=ts xp=30
title: How long does this request take?
Write `pathLatency(steps)`. Each element of `steps` is either:

* a **number**: a sequential step taking that many ms, or
* an **array of numbers**: a group of calls that run **in parallel**; the group costs its largest value
  (an empty group costs 0).

Return the total latency in ms. Example: `pathLatency([2, [20, 45], 5])` is `2 + 45 + 5 = 52`.

hint: Loop over the steps: `typeof step === 'number'` tells a single step from a group (`Array.isArray(step)` works too).
hint: For a group, `Math.max(0, ...group)` gives the slowest call, and 0 for an empty group.

```ts starter
type Step = number | number[]

export function pathLatency(steps: Step[]): number {
  let total = 0
  // add each step's cost to total
  return total
}
```

```ts solution
type Step = number | number[]

export function pathLatency(steps: Step[]): number {
  let total = 0
  for (const step of steps) {
    total += typeof step === 'number' ? step : Math.max(0, ...step)
  }
  return total
}
```

```ts tests
test('empty path is 0 ms', () => {
  expect(pathLatency([])).toBe(0)
})
test('sequential steps add up', () => {
  expect(pathLatency([2, 5, 30])).toBe(37)
})
test('a parallel group costs its slowest call', () => {
  expect(pathLatency([[20, 45, 10]])).toBe(45)
})
test('mixed path from the example', () => {
  expect(pathLatency([2, [20, 45], 5])).toBe(52)
})
test('an empty parallel group costs nothing', () => {
  expect(pathLatency([3, [], 4])).toBe(7)
})
```
:::

:::quiz id=cl-11-q7 xp=10
An endpoint does a 1 ms cache lookup, then (on a miss) a 40 ms database query and a 250 ms call to a
partner API **one after the other**. The two calls don't depend on each other. What is the biggest
quick win?
- [ ] Move the cache to a faster server to save part of the 1 ms
- [x] Run the database query and the partner call in parallel: ~1 + 250 ms instead of 1 + 40 + 250 ms
- [ ] Add more API copies
- [ ] Shorten the cache TTL
> Independent calls in parallel cost only the slowest one, saving the full 40 ms here. Optimising the
> 1 ms cache is pointless next to a 250 ms call. More API copies raise **throughput** but do not make
> one request faster. A shorter TTL would cause *more* misses, making things slower. (A bigger win
> still: cache or pre-fetch the partner response if it allows that.)
:::

## How this region's lessons map to the picture

| Box in the diagram | Lesson(s) | What you'll be able to do |
|---|---|---|
| Cache | *Redis Fundamentals*, *Caching with Redis in .NET* | Run Redis, pick data types, cache-aside with TTLs, avoid stampedes |
| Object storage | *Object Storage & Direct Uploads (S3)* | Presigned uploads from the browser, multipart, CORS, private reads |
| Queue (Redis) + backplane | *Redis as Queue, Bus and Lock* | Leased queues with a reaper, Streams, pub/sub, locks, rate limits |
| Queue (broker) | *Message Brokers & the Outbox Pattern* | RabbitMQ vs Kafka, outbox, idempotent consumers, dead letters |
| Identity provider | *Identity with Keycloak (OIDC in Practice)* | Run Keycloak, validate its tokens in ASP.NET Core, PKCE login in React |
| Observability | *Observability: OpenTelemetry, Prometheus, Grafana, Loki* | Traces, metrics and logs end to end, dashboards, SLO alerts |
| Autoscaler | *KEDA: Autoscale Workers on Queue Depth* | Scale workers 0 → N → 0 on queue length |
| All of it together | *Boss: The Media Processing Pipeline* | Build the request journey above, then survive incidents |
| The cloud versions | *The Managed Equivalents: Azure & AWS* | Map every box to Azure/AWS services |

The API and database boxes come from the Backend and Database regions; the platform they all run on
comes from Containers & Kubernetes.

:::job title="Day one at a new job"
Ask for (or draw) the architecture diagram in your first week and label every box with the
questions from this lesson: *what is the source of truth? what is a cache? where do files go? which
queue, and is delivery at-least-once? who issues tokens? where are the dashboards?* You'll
understand the codebase much faster, and the people answering will remember that you asked
the right questions.
:::

:::pro title="Seniors add boxes reluctantly"
Every box is something to run, secure, monitor, upgrade and pay for. Experienced engineers start
with API + Postgres and add a cache when a measurement shows a slow read, a queue when work is
genuinely slow or must survive crashes, and so on. Postgres alone can act as a decent queue and even
a cache for a long time. "We might need Kafka" is not a reason to run Kafka.
:::

## The command-line tools you'll use

Three tools appear in almost every lab in this region. Here is the minimum syntax to read them.

### `docker compose`: start a whole stack from one file

A `compose.yaml` file lists **services** (containers), their images, ports and environment.
One command starts them all on a shared network where they find each other **by service name**.

```bash
docker compose up -d          # start everything in the background (-d = detached)
docker compose ps             # list services and their status
docker compose logs -f redis  # follow one service's logs (Ctrl+C to stop following)
docker compose exec redis sh  # open a shell *inside* the running redis container
docker compose down           # stop and remove containers (add -v to delete volumes = data too)
```

### `redis-cli`: talk to Redis

`redis-cli` sends commands to a Redis server and prints the replies. Inside the Redis container it is
already installed, so you rarely need it on your machine.

```bash
redis-cli PING                  # → PONG   (is the server alive?)
redis-cli SET greeting hello EX 60   # store a key with a 60 s TTL → OK
redis-cli GET greeting          # → "hello"
redis-cli TTL greeting          # → seconds left, e.g. (integer) 57
redis-cli                       # no command = interactive prompt: 127.0.0.1:6379>
```

### `curl`: make HTTP requests from the terminal

`curl` is how you test an API without a browser. The flags you'll see most:

```bash
curl http://localhost:8080/                       # GET, print the body
curl -i http://localhost:8080/                    # -i: include status line + response headers
curl -X POST http://localhost:8080/api/videos \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer eyJ...' \
  -d '{"title":"Demo"}'                            # -X method, -H header, -d request body
curl -s http://localhost:8080/ | head              # -s: silent (no progress bar), good for pipes
```

:::tip title="Reading curl -i output"
The first line is the **status line**, e.g. `HTTP/1.1 200 OK`. Then come the headers (`Content-Type:`,
`Content-Length:` …), then an empty line, then the body. 2xx = success, 4xx = your request was wrong
(401 = no/invalid token, 403 = token fine but not allowed, 404 = not found), 5xx = the server failed.
:::

:::lab id=cl-11-lab1 xp=40
title: A two-service stack in five minutes
You'll start Redis and a tiny HTTP service with Docker Compose, then poke both with `redis-cli` and
`curl`. You need Docker with the Compose plugin: `docker compose version` should print a version
(v2 or newer; current releases are v5.x). Podman with `podman compose` works the same way.

**1. Create a folder and the compose file.**

```bash
mkdir -p ~/devquest-primer && cd ~/devquest-primer
```

Save this as `compose.yaml`:

```yaml
services:
  redis:
    image: redis:8
    ports:
      - "6379:6379"
  web:
    image: traefik/whoami:v1.10
    ports:
      - "8080:80"
```

`traefik/whoami` is a tiny web server that replies with details about the request it received,
which makes it perfect for practising `curl`.

**2. Start the stack.**

```bash
docker compose up -d
docker compose ps
```

Expected: two services, `redis` and `web`, both with status `Up` (the exact names are prefixed
with the folder name, e.g. `devquest-primer-redis-1`).

**3. Talk to Redis.** Run `redis-cli` inside the container:

```bash
docker compose exec redis redis-cli PING
docker compose exec redis redis-cli SET session:demo ada EX 120
docker compose exec redis redis-cli GET session:demo
docker compose exec redis redis-cli TTL session:demo
```

Expected output:

```text
PONG
OK
"ada"
(integer) 118
```

(the TTL is any number up to 120 that counts down each time you run it; `(integer)` and the quotes
around `"ada"` are just how `redis-cli` labels the reply type). Wait out the TTL, or run
`docker compose exec redis redis-cli EXPIRE session:demo 1`, then `GET` again: the reply is `(nil)`.
That is a TTL doing its job.

**4. Talk to the web service.**

```bash
curl -i http://localhost:8080/
```

Expected (shortened; dates, ids and IP addresses differ, and you may see extra `IP:` lines for IPv6):

```text
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
...

Hostname: 3c1f0b2a9d7e
IP: 127.0.0.1
IP: 172.18.0.3
RemoteAddr: 172.18.0.1:51234
GET / HTTP/1.1
Host: localhost:8080
User-Agent: curl/8.x
Accept: */*
```

Now send a header and see it echoed back:

```bash
curl -s -H 'Authorization: Bearer test-token' http://localhost:8080/ | grep Authorization
```

Expected: `Authorization: Bearer test-token`. This is exactly how a token travels to an API.

**5. Service names are hostnames.** Inside the Compose network, services are reachable by
name. Ask Redis to reach itself by its service name:

```bash
docker compose exec redis redis-cli -h redis PING
```

Expected: `PONG`. In later labs your API connects to `redis:6379`, not `localhost:6379`, for this reason.

**6. Clean up.**

```bash
docker compose down -v
cd ~ && rm -rf ~/devquest-primer
```

`-v` also deletes the volume the Redis image creates for its `/data` folder, so nothing is left behind.

- [ ] `docker compose ps` showed both services `Up`
- [ ] `redis-cli GET session:demo` returned `"ada"`, and `(nil)` after the TTL expired
- [ ] `curl -i` showed `HTTP/1.1 200 OK` and the echoed `Authorization` header
- [ ] `redis-cli -h redis PING` answered `PONG` (service name as hostname)
- [ ] I ran `docker compose down -v` and removed the folder
:::

:::quiz id=cl-11-q8 xp=10
In a Compose stack your API container tries to connect to Redis at `localhost:6379` and gets
"connection refused", even though `docker compose ps` shows Redis running. Why?
- [ ] Redis needs a password by default
- [x] Inside a container, `localhost` is that container itself; Redis is reachable at `redis:6379`
- [ ] Port 6379 is only open after `docker compose restart`
- [ ] Compose services can't talk to each other without Kubernetes
> Each container has its own network namespace, so `localhost` inside the API container means "this
> API container", where nothing listens on 6379. Compose puts all services on one network with DNS
> names equal to the service names, so the API should use `redis:6379`. Your *laptop* reaches it at
> `localhost:6379` only because of the `ports:` mapping.
:::

:::cards id=cl-11-cards1 xp=15 title="Cloud-native vocabulary"
Q: What does "cloud-native" mean in one sentence?
A: Designing apps as many disposable, stateless copies that keep state in managed services and are deployed, scaled and observed automatically.
Q: Stateless service?
A: Keeps nothing between requests that another copy would need; any copy can answer any request.
Q: Latency vs throughput?
A: Latency = how long one operation takes (ms). Throughput = how many operations per second.
Q: Idempotent?
A: Doing it twice has the same effect as once. `SET x 5` yes, `INCR x` no.
Q: At-least-once delivery?
A: Every message is delivered one or more times; duplicates are possible, so handlers must be idempotent.
Q: TTL?
A: Time to live: how long data exists before automatic deletion (cache entries, tokens, presigned URLs, leases).
Q: Lease?
A: A time-limited claim; if the holder doesn't renew it before it expires, someone else may take over.
Q: Backplane?
A: A shared channel (e.g. Redis pub/sub) that lets API copies broadcast real-time messages to each other's clients.
Q: Presigned URL?
A: A URL with a signature and expiry that allows one upload or download of one object, so files bypass the API.
Q: Access token?
A: A short-lived signed token (usually a JWT) the client sends as `Authorization: Bearer …`; the API verifies its signature.
Q: Log, metric, span?
A: Log = one event record. Metric = a number over time. Span = one timed step of a request; spans form a trace.
Q: Sequential vs parallel latency?
A: Sequential steps add up; parallel calls cost only the slowest one.
:::

## Recap

- **Cloud-native** = many disposable, **stateless** copies; state lives in the database, cache and
  object storage; scaling, deploys and recovery are automated; the system is observable from outside.
- The eight boxes: **API** enforces rules, **database** is the source of truth, **cache** is a fast
  temporary copy, **queue/broker** holds work for **workers**, **object storage** holds files,
  the **identity provider** issues tokens, **observability** shows what happened, the **autoscaler**
  picks how many copies run.
- Key words: latency vs throughput, idempotent, at-least-once, TTL, lease, backplane, presigned URL,
  token, and logs / metrics / spans.
- Sequential steps add latency; independent calls in parallel cost only the slowest one.
- Tools: `docker compose up -d / ps / logs / exec / down`, `redis-cli PING / SET / GET / TTL`,
  `curl -i -X -H -d -s`. Inside Compose, services reach each other by **service name**.
- Next stop: *Redis Fundamentals*, the first box in close-up.
