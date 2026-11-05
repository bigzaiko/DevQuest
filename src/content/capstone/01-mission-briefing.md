---
id: cap-01
title: "Mission Briefing: BranchStory"
level: advanced
minutes: 150
xp: 150
summary: The final boss. Meet BranchStory, a collaborative editor for branching stories, then read its architecture, monorepo layout, tech choices and milestone plan, and scaffold the repository you'll build on for ten more lessons.
---

You've learned React, ASP.NET Core, PostgreSQL, Docker and Kubernetes one at a time. A real
product needs all of them **at once**, along with the problems that only show up when they meet:
two people saving the same document, a job that crashes halfway, a WebSocket that outlives its
token, a quota a collaborator can get around.

For the next eleven lessons you'll build **BranchStory** step by step: a small but production-shaped
SaaS for writing **branching interactive stories**. It's the kind of app you'd find behind an
interactive-video editor or a choose-your-own-adventure platform. It isn't a toy to-do list: every
lesson adds a piece that real teams ship, test and run.

## The product brief

**BranchStory lets authors write stories as a graph.** Each **node** is a *scene* (a title, some
text and an optional media URL). Each **edge** is a *choice* ("Open the door", "Run"). Readers
start at the *start scene* and pick choices until they reach an ending.

| Persona | Wants to… |
|---|---|
| **Author (owner)** | create stories, edit the graph, invite people, publish a public link |
| **Collaborator (editor)** | edit a shared story *at the same time* as the author without losing work |
| **Reviewer (viewer)** | watch the story change live and read it, but not edit it |
| **Reader (anonymous)** | open the public link and play the story, on any device and with a keyboard only |

**User stories for v1**

1. I sign in (a dev token locally, Keycloak / OIDC in a real deployment) and see **my stories** and
   the ones **shared with me**, each with my role.
2. I create a story. A free plan allows a few stories, and the limit is checked on the server.
3. In the editor I add scenes, connect them with choices, set the start scene, and see problems
   such as "unreachable scene" or "no start scene" as I type.
4. My work **autosaves**. If someone else saved first, I am **told**: I can reload their version,
   overwrite it with mine, or merge. My work is never silently overwritten.
5. I share a story with someone by email as **editor** or **viewer**. Sharing counts against
   **my** plan, never theirs.
6. While we both have the story open, I see **who is here** and their edits appear **live**.
7. I press **Publish**. A background worker renders a compact player file, and the editor shows
   *queued → running → published* without me refreshing the page.
8. Anyone with the link can **play** the published story. Re-publishing keeps the same link.

**Non-goals for v1** (say them out loud; scope creep kills capstones): media upload and transcoding
(scenes link to a media URL), billing integration (plans are a column), mobile/desktop apps,
comments, version history browsing.

:::job title="This is what a first ticket looks like"
At a real job, nobody hands you "build a SaaS". You get a brief like the one above, an existing
architecture, and a milestone. Practise reading the whole brief **before** writing code, and write
down the non-goals so you can point at them when someone asks "can it also…?" in sprint three.
:::

## Architecture

```text
                         ┌──────────────────────────── browser ────────────────────────────┐
                         │  React 19 SPA (Vite)                                            │
                         │  modules/auth · projects · editor · realtime · publish · player │
                         └───────┬───────────────────────────────┬─────────────────────────┘
                     REST /api/* │ JSON + ProblemDetails         │ WebSocket /hubs/story
                     Bearer JWT  │ If-Match / 409 / ETag         │ (SignalR, ?access_token=)
                                 ▼                               ▼
          ┌──────────────────────────────────────────────────────────────────────────┐
          │  BranchStory.Api  (ASP.NET Core 10 minimal API, one process)             │
          │  Auth (JWT: dev issuer | Keycloak)   ProjectGate (owner/editor/viewer)   │
          │  Features/Projects · Sharing · Publishing      Realtime/StoryHub         │
          │  Quotas (billed to the OWNER)  Health (/health/live, /health/ready)      │
          │  JobEventsListener ◄─── LISTEN job_events ────────────────┐              │
          └───────────────┬───────────────────────────────────────────┼──────────────┘
                          │ EF Core 10 / Npgsql                       │
                          ▼                                           │ NOTIFY
          ┌──────────────────────────────────────┐                    │
          │  PostgreSQL 18                       │                    │
          │  users · projects (doc jsonb,        │◄──────────┐        │
          │  version) · project_members · jobs · │  claim    │        │
          │  published_stories                   │  SKIP     │        │
          └──────────────────────────────────────┘  LOCKED   │        │
                                                  ┌──────────┴────────┴──────┐
                                                  │  BranchStory.Worker      │
                                                  │  JobRunner (leases,      │
                                                  │  retries, backoff) →     │
                                                  │  PlayerBuilder → upsert  │
                                                  └──────────────────────────┘
```

Read it as **one API, one worker, one database**. This is a *modular monolith*: features are
separate folders with clear seams, but they deploy as a single process because one team of one
does not need a network hop between "projects" and "sharing".

### Terms you'll meet in every lesson

The diagram packs in a lot of vocabulary. Here is each term in one or two sentences, with the
problem it solves. Every one of them gets a full lesson later; for now you only need the idea.

| Term | What it is | Why BranchStory needs it |
|---|---|---|
| **Optimistic concurrency** | Don't lock the document while someone edits. Instead, every save says "I edited version 6", and the database refuses it if the row is no longer at version 6. | Autosave fires every few seconds from several people; locking would block them, and saving blindly would lose work. |
| **`ETag` / `If-Match`** | HTTP's built-in version of the same idea: `GET` returns `ETag: "6"`, and a later `PUT` sends `If-Match: "6"`. A mismatch gets **412 Precondition Failed**. | Lets standard HTTP clients and caches use the version without reading the JSON body. |
| **ProblemDetails** | The standard JSON error format (RFC 9457): `{ type, title, status, detail, … }` with `content-type: application/problem+json`. | The frontend writes one error parser, and can read extensions such as `currentVersion` from a 409. |
| **JWT bearer token** | A signed JSON token the browser sends as `Authorization: Bearer …`. The API checks the signature and expiry; it never sees passwords. | Swapping a dev issuer for Keycloak is configuration, not code. |
| **SignalR hub / group** | ASP.NET Core's real-time layer over WebSockets. A *group* is a named set of connections, here one per project. | "Send `DocSaved` to everyone who has this story open" is one call. |
| **Job queue, lease** | A `jobs` table workers poll. A worker that claims a job also writes `leased_until`; if it crashes, the lease expires and another worker may take the job. | Publishing is slow and can fail; the job must survive a crash. |
| **`FOR UPDATE SKIP LOCKED`** | A Postgres row lock that *skips* rows another transaction already locked, instead of waiting for them. | Several workers can claim jobs at the same time without getting the same one. |
| **`LISTEN` / `NOTIFY`** | Postgres' built-in pub/sub: one connection `LISTEN`s on a channel, any session can `NOTIFY` it. | The worker tells the API "job 42 finished" without the API polling the table. |
| **Idempotency key** | A unique key the client sends with a request (`Idempotency-Key: 3f2a…`). The server stores it, so a retried request returns the first result instead of doing the work twice. | A double-click or a network retry on **Publish** must not queue two jobs. |

### The two flows that shape everything

**Saving with optimistic concurrency.** The whole graph is one JSON document with a version number.
Ada and Grace both opened the story at version 6. Ada saves first and wins; Grace's save still
claims "based on version 6", so the `WHERE` matches nothing and she gets a conflict instead of
silently erasing Ada's edit. The important detail: the version check is **inside** the `UPDATE`
statement, not a separate `SELECT` before it, so there is no gap for a third save to slip through.

```text
 Ada (v6)                     API                              Postgres
   │ PUT /doc {doc, expectedVersion: 6}                            │
   │──────────────────────────►│ UPDATE projects SET doc=…, version=version+1
   │                           │ WHERE id=… AND version=6 ────────►│ 1 row → v7
   │◄──── 200 {version: 7} ────│                                   │
   │                           │── SignalR DocSaved(v7) to the project group
 Grace (still on v6)           │                                   │
   │ PUT /doc {expectedVersion: 6}                                 │
   │──────────────────────────►│ … WHERE version=6 ───────────────►│ 0 rows
   │◄── 409 ProblemDetails {currentVersion: 7} ── conflict dialog: reload / overwrite / merge
```

**Publishing through a job queue.** Slow work never happens inside an HTTP request. The API only
*records* that a publish was requested (one row in `jobs`) and answers **202 Accepted** at once,
meaning "I've taken this on, it isn't finished yet". A separate worker process does the rendering
and reports back through the database.

```text
 POST /publish (Idempotency-Key) → INSERT jobs(status=queued) → 202 {jobId}
 worker: UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) → status=running, lease
         build player JSON → UPSERT published_stories (slug kept) → status=succeeded
         pg_notify('job_events', …) → API LISTENs → hub JobUpdated → the editor shows "Published"
 crash?  lease expires → another worker reclaims it.   error? retry with backoff, then failed.
```

## The monorepo

One repository, one solution, one CI pipeline. You create the skeleton in the lab below, and each
lesson fills in its folders.

```text
branchstory/
├── BranchStory.slnx                  # .NET solution (XML format, .NET 10 default)
├── global.json  .editorconfig  .gitignore  README.md
├── .config/dotnet-tools.json         # dotnet-ef pinned per repo
├── api/
│   ├── BranchStory.Api/              # minimal API: Auth/, Authorization/, Features/{Projects,Sharing,Publishing}/,
│   │                                 #   Quotas/, Realtime/, Health/, Security/, Program.cs (cap-03 … cap-10)
│   ├── BranchStory.Data/             # EF Core: entities, BranchStoryDbContext, Configurations/, Migrations/ (cap-02)
│   ├── BranchStory.ServiceDefaults/  # OpenTelemetry + logging shared by api and worker   (cap-10)
│   └── Dockerfile                                                                         (cap-10)
├── worker/
│   └── BranchStory.Worker/           # Jobs/ (JobRunner, JobStore, Backoff), Publishing/ (PlayerBuilder) (cap-08)
├── web/                              # Vite + React 19 + TypeScript                         (cap-05 … cap-08)
│   └── src/
│       ├── app/                      # router, layout
│       ├── lib/                      # api.ts (typed fetch), session.ts, config.ts, types.ts, telemetry.ts
│       └── modules/                  # auth/ projects/ editor/ realtime/ publish/ player/ ui/
├── tests/
│   ├── BranchStory.Api.Tests/        # WebApplicationFactory + Testcontainers                (cap-03, cap-04, cap-07)
│   ├── BranchStory.UnitTests/        # pure logic: PlayerBuilder, backoff, slugs             (cap-09)
│   ├── BranchStory.Worker.IntegrationTests/  # SKIP LOCKED under concurrency               (cap-09)
│   ├── e2e/                          # Playwright + axe accessibility gate                    (cap-09)
│   └── load/                         # k6 smoke test with p95 thresholds                      (cap-10)
├── deploy/
│   ├── compose.yaml                  # Postgres now (cap-02), the whole stack later (cap-10)
│   ├── nginx/  kind/  ci/            # web container config, local cluster, deploy + smoke scripts (cap-10)
│   └── k8s/base, k8s/overlays/kind   # kustomize                                            (cap-10)
└── .github/workflows/                # ci.yml: build + API tests from day one (cap-03), every level (cap-09)
                                      # cd.yml: SHA-tagged images → staging smoke → production (cap-10)
```

**Why feature folders?** `web/src/modules/editor` holds the editor's reducer, hooks, components
*and* tests. Deleting a feature means deleting one folder; a reviewer can see a feature's whole
surface in one place. The same idea on the server is `Features/Projects`, `Features/Sharing` and
`Features/Publishing`, each with its own endpoints and DTOs.

## Tech choices and why

| Concern | Choice | Why this, and what we rejected |
|---|---|---|
| UI | **React 19 + Vite 8 + TypeScript** | Fast dev server, typed end to end. A meta-framework (Next.js) adds SSR we don't need: the editor is behind a sign-in. |
| Server state | **TanStack Query v5** | Caching, refetch on reconnect and mutations with rollback. Writing that by hand in `useEffect` is where bugs live. |
| Routing | **React Router** (`react-router`) | Nested layouts plus a public `/play/:slug` route outside the sign-in wall. |
| Editor state | **`useReducer` + pure functions** | A pure reducer is testable without a browser, and it makes undo/redo and remote patches simple. |
| API | **ASP.NET Core 10 minimal APIs** | Route groups per feature, built-in validation, ProblemDetails and OpenAPI. Controllers would work too; minimal APIs keep each feature in one small file. |
| Data | **PostgreSQL 18 + EF Core 10 (Npgsql)** | `jsonb` stores the story document, the `version` column gives optimistic concurrency, and `SKIP LOCKED` gives a job queue: one database does three jobs. |
| Story storage | **One `jsonb` document + integer `version`** | Saves are atomic, one row with one check. Normalized `nodes`/`edges` tables would need multi-row transactions for every keystroke-sized change. |
| Queue | **Postgres `jobs` table** | Enqueue in the same transaction as the change, and no extra infrastructure. Redis/RabbitMQ come later when throughput needs them (it won't for "publish"). |
| Real time | **SignalR** | WebSockets with fallbacks, groups, reconnects and a typed hub. A Redis backplane scales it out later. |
| Auth | **JWT bearer**: a dev issuer locally, **Keycloak (OIDC)** in real deployments | The API only validates tokens. Swapping the issuer is configuration, not code. |
| Tests | **xUnit v3 + Testcontainers**, **Vitest**, **Playwright + axe** | Real Postgres in integration tests (an in-memory provider would lie about `jsonb` and locking), and real browsers in e2e. |
| Ship | **Docker multi-stage**, **Compose**, **kind + kustomize + Traefik**, **GitHub Actions** | The same images run on a laptop, in CI and in the cluster. |

:::pro title="Choose boring technology, then spend your innovation tokens on purpose"
Every row above is mainstream and well documented. The *interesting* parts of BranchStory are
design decisions (document + version, owner-billed quotas, a Postgres queue, live patches), not
exotic tools. Senior engineers justify each new piece of infrastructure with a problem it solves
**today**. That's why Redis, Kafka and microservices are on the "what next" list, not in v1.
:::

:::warn title="Where the classic SaaS bugs hide"
- **Authorization in the UI only.** Hiding the "Delete" button is UX; the server must still refuse.
- **Quotas checked against the caller.** If an editor's plan is checked instead of the owner's,
  a free owner can get around limits by inviting a Pro friend.
- **Last write wins.** Without a version check, the slower of two autosaves deletes the other
  person's work, with no error and no trace.
- **Work inside the request.** A publish that renders in the HTTP handler times out, retries, and
  runs twice.
:::

## The API surface (your reference card)

These names come back in every lesson. Bookmark this table.

| What | Where |
|---|---|
| Dev sign-in (Development only) | `POST /api/dev/token {username, displayName?}` → `{accessToken, expiresAt}` |
| Current user | `GET /api/me` → `{id, email, displayName, plan}` |
| Projects | `GET /api/projects` (optional `?limit=&after=` keyset paging with a `Link` header, cap-10) · `POST /api/projects {title}` · `GET /api/projects/{id}` (sends `ETag`) · `DELETE /api/projects/{id}` (owner) |
| Save the graph | `PUT /api/projects/{id}/doc {doc, expectedVersion}` → `{version, updatedAt}`, or **409** `{currentVersion}` (stale version), **412** (stale `If-Match`), **428** (no version sent) |
| Sharing | `GET /api/projects/{id}/members` · `PUT /api/projects/{id}/members {email, role}` (owner) · `DELETE …/members/{userId}` (owner, or the member leaving) |
| Publishing | `POST /api/projects/{id}/publish` + `Idempotency-Key` → **202** `{jobId}` · `GET /api/jobs/{jobId}` · `GET /api/public/stories/{slug}` (anonymous) |
| Real time | hub `/hubs/story`: `JoinProject`, `LeaveProject`, `SendPatch` → events `PresenceChanged`, `PatchReceived`, `DocSaved`, `AccessRevoked`, `JobUpdated` |
| Health | `/health/live` (process is up) · `/health/ready` (can reach Postgres) |
| Plans | free: 3 stories, 50 scenes, 2 collaborators, 5 publishes/day · pro: 100 / 1000 / 25 / 100 |
| Local ports | API `5080` · Vite `5173` · Postgres `5432` · compose stack `8080` · kind `8088` |
| Config | `ConnectionStrings:BranchStory`, `Database:MigrateOnStartup`, `Auth:DevSigningKey`, `Auth:Authority`, `Worker:*` (cap-08), `RateLimits:*` (cap-10) |

:::quiz id=cap-01-q1 xp=15
Why is the whole story graph stored as **one `jsonb` document with a `version`** instead of
`nodes` and `edges` tables?
- [ ] Postgres cannot index normalized tables of that size
- [x] Every save is a single-row update guarded by a single version check, so a save is atomic and conflicts are easy to detect
- [ ] `jsonb` is faster than tables for every kind of query
- [ ] EF Core cannot map one-to-many relationships
> The editor always loads and saves the *whole* graph. One row and one version number make "did someone else save first?" a single `WHERE version = @expected`. We give up foreign keys *inside* the graph (the API validates it instead) and cheap cross-story queries on scenes, which v1 doesn't need.
:::

:::quiz id=cap-01-q2 xp=15
Grace (Pro plan) is an **editor** on Ada's story. Ada is on the **free** plan and has used up
today's publishes. Grace presses **Publish**. What should happen?
- [ ] The publish succeeds, because Grace's Pro plan has publishes left
- [x] It is refused with a plan-limit error, because quotas are billed to the project's owner
- [ ] It succeeds and the publish is billed to Grace from now on
- [ ] The server lets the UI decide, since it hides the button anyway
> Every project-scoped quota is read from the **owner's** plan, because the owner is the one being billed for the project. The tempting answer, "Grace has publishes left", is exactly the loophole: if the caller's plan counted, a free owner could invite one Pro friend and get unlimited publishing for free. Billing Grace instead isn't right either: she never agreed to pay for Ada's project. And the check lives on the server; the UI only mirrors it.
:::

:::quiz id=cap-01-q3 xp=15
Which statements explain why publishing is a **background job** rather than work done inside
`POST /publish`? (Select all that apply.)
- [x] A slow render would hold an HTTP request open, and proxies or clients may time out and retry it
- [x] A durable job row survives a crash; a lease lets another worker pick it up
- [x] The API can answer `202 Accepted` at once and push progress to the editor over SignalR
- [ ] Background jobs never fail, so no error handling is needed
> The first three are the real reasons: a request that runs for many seconds invites timeouts and duplicate retries, a row in `jobs` outlives any single process, and `202 Accepted` plus live updates keeps the UI responsive. The last one is false: jobs *do* fail. That's why the worker has retries with backoff, idempotent handlers and a `failed` dead-letter state. The point is that failure is *recorded and retried*, not lost with a dropped connection.
:::

:::quiz id=cap-01-q4 xp=15
BranchStory deploys **one API process and one worker**, with features in separate folders. What is
this style called, and why is it right for v1?
- [ ] Microservices: each feature can scale on its own
- [x] A modular monolith: clear seams between features, without the operational cost of a network between them
- [ ] A serverless architecture: no servers to run
- [ ] A big ball of mud: it's fast to write
> The worker *is* split out, because it has a different scaling and failure profile (CPU-bound and retryable). Projects, sharing and publishing endpoints share a database and a deployment. Clear module boundaries let you split them later if a real reason appears. "Microservices" is the tempting wrong answer: independent scaling is real, but it costs network calls, distributed failures and separate deployments, which a one-team v1 has no problem to justify. A "big ball of mud" is a monolith *without* the seams.
:::

:::quiz id=cap-01-q5 xp=15
**Spot the bug.** A teammate proposes this save handler. Ada and Grace both start from version 6
and their autosaves arrive a few milliseconds apart. What goes wrong?

```csharp
var project = await db.Projects.AsNoTracking().SingleAsync(p => p.Id == id);
if (project.Version != req.ExpectedVersion)
    return TypedResults.Conflict();

await db.Database.ExecuteSqlAsync(
    $"UPDATE projects SET doc = {json}::jsonb, version = version + 1 WHERE id = {id}");
```

- [ ] Nothing: the `if` already rejects stale versions
- [x] Both requests can read version 6 and pass the check before either one writes, so both updates run and the second silently overwrites the first
- [ ] `ExecuteSqlAsync` is vulnerable to SQL injection here
- [ ] The second `UPDATE` fails with a unique-constraint error
> This is the classic **check-then-act race**. Between the `SELECT` and the `UPDATE` there is a gap, and another request can pass the same check inside it. The fix is to move the check into the write itself: `… WHERE id = {id} AND version = {expected}`, then return 409 when zero rows were updated. The injection option is a trap: `ExecuteSqlAsync` with an interpolated string turns every `{…}` into a SQL **parameter**, so this code is safe from injection. It is just not safe under concurrency.
:::

:::quiz id=cap-01-q6 xp=15
Ada clicks **Publish**, the network drops before the `202` arrives, and the browser retries the
same request with the **same `Idempotency-Key`**. What should the API do?
- [ ] Queue a second job, because it's a new HTTP request
- [x] Recognise the key, create nothing new, and return the `jobId` of the job the first request queued
- [ ] Reject the retry with `409 Conflict` so the user has to click again
- [ ] Ignore the header; the worker removes duplicates later
> An idempotency key turns "at least once" delivery into "effectively once": the server stores the key with the job (a unique index makes a duplicate insert impossible), so a retry finds the existing job and returns it. Queueing a second job is what happens *without* the key, and it can double-count the publish quota. Rejecting the retry with 409 would punish the user for a network problem, and deduplicating in the worker is too late, since the quota was already spent.
:::

## Milestone plan

Every lesson ends with something you can **demo**. Don't start the next one until the demo works
and is committed.

| # | Lesson | You can demo… |
|---|---|---|
| cap-01 | Mission briefing (this) | an empty monorepo that builds, with ADRs for the big decisions |
| cap-02 | Database model | Postgres in Compose, the EF Core model and migration, the key SQL queries |
| cap-03 | API foundation | dev sign-in, `/api/me`, project CRUD with roles, OpenAPI, health, integration tests |
| cap-04 | Concurrency & sharing | a stale save gets 409, `If-Match`/ETag, invites, owner-billed quotas, tests for each |
| cap-05 | Frontend shell | sign-in, the project list, create and share dialogs, a typed API client |
| cap-06 | The editor | the graph editor with validation, autosave, undo/redo and the conflict dialog |
| cap-07 | Real time | two browsers: presence avatars and live edits that never clobber local work |
| cap-08 | Background jobs | Publish → worker → live status → a public player link |
| cap-09 | Quality gates | unit, integration and e2e + axe tests, all green in GitHub Actions |
| cap-10 | Ship it | the full stack in Compose and on a kind cluster, with probes, backups, telemetry, rate limits, a CD pipeline with a rehearsed rollback, and a load test |
| cap-11 | v2 Without Downtime | a schema and document change shipped as expand → deploy → contract while the app stays up |

## Definition of done

A feature is **done** when all of these are true, not just "it works on my machine":

- **Correct under concurrency:** two tabs, two users, a crashed worker: still correct.
- **Authorized on the server:** every endpoint and hub method checks the caller's role on *that*
  project; strangers get `404`, under-privileged members `403`.
- **Errors are ProblemDetails:** a machine-readable `type`, a human `title`, and extensions such
  as `currentVersion` that the UI acts on.
- **Tested at the right level:** pure logic with unit tests, HTTP + SQL with integration tests
  against real Postgres, the critical user journeys with e2e tests.
- **Accessible:** keyboard-operable, labelled controls, zero serious/critical axe findings.
- **Observable:** structured logs with a request or job id, plus health endpoints that mean
  something.
- **Shippable:** it runs from the same container image locally, in CI and in the cluster.

:::job title="Work like a team, even when you are the only one on it"
The habits that make a team repository pleasant are cheap to start on day one:

- **Short-lived branches and a pull request per step**, merged into `main` within a day or two.
  A PR that touches 40 files gets skimmed, not reviewed.
- **CI from the first real test** (cap-03 adds it). A required green check on `main` and at least
  one review in a team.
- **A PR description that answers three questions:** what changed, why, and how you tested it
  (the command you ran, a screenshot for UI changes).
- **`CODEOWNERS`** for the risky paths, such as `api/BranchStory.Data/Migrations/` and `deploy/`, so
  a second pair of eyes sees every schema and infrastructure change.
- **Contracts change in one place.** A PR that changes a route or a field updates the API reference
  card above, the typed client and the tests together, plus an ADR if the change is expensive
  to reverse.
- **Squash merges with a conventional title** (`feat(editor): …`, `fix(api): …`), so `git log main`
  reads like a changelog.
:::

:::lab id=cap-01-lab1 xp=120
title: Scaffold the BranchStory monorepo

You'll create the repository skeleton that every later lesson builds on. Nothing clever yet, but
every name here is used by later lessons, so keep them **exactly** as written.

**1. Check your tools.** You need the .NET 10 SDK, a Node.js LTS release (24 or newer), Docker (or
Podman with a Docker-compatible socket) and git.

```bash
dotnet --version        # 10.0.x
node --version          # v24.x or newer LTS
npm --version
docker version --format '{{.Server.Version}}'
git --version
```

**2. Create the repository and the repo-wide files.**

```bash
mkdir branchstory && cd branchstory
git init -b main
dotnet new globaljson --sdk-version 10.0.100 --roll-forward latestFeature
dotnet new gitignore
dotnet new editorconfig
mkdir -p deploy docs/adr
```

`global.json` pins the SDK *band* (any 10.0.x feature release) so CI and every laptop build the
same way. Append the Node, test and deploy artifacts to the generated `.gitignore`:

```bash
cat >> .gitignore <<'EOF'

# ── BranchStory: web, tests, deploy ──
node_modules/
web/dist/
coverage/
playwright-report/
test-results/
blob-report/
.env.local
deploy/k8s/overlays/kind/secrets.env
EOF
```

**3. The solution and the .NET projects.** The worker and the extra test projects are created in
cap-08 and cap-09, once you need them.

```bash
dotnet new sln -n BranchStory --format slnx
dotnet new web      -n BranchStory.Api       -o api/BranchStory.Api
dotnet new classlib -n BranchStory.Data      -o api/BranchStory.Data
dotnet new xunit    -n BranchStory.Api.Tests -o tests/BranchStory.Api.Tests
rm api/BranchStory.Data/Class1.cs

dotnet sln add api/BranchStory.Api api/BranchStory.Data tests/BranchStory.Api.Tests
dotnet add api/BranchStory.Api reference api/BranchStory.Data
dotnet add tests/BranchStory.Api.Tests reference api/BranchStory.Api
```

The reference graph is one-directional on purpose: **Api → Data**, **Tests → Api**. Data never
references the API, so the worker can use it in cap-08 without dragging in HTTP code. (If you ever
add the reverse reference by mistake, the build fails with a circular-dependency error, which is a
useful guard rail.)

`dotnet new sln --format slnx` writes the newer XML solution format. It is already the default on
.NET 10; spelling it out documents the intent (SDK 9.0.200 and later understand the flag, while older
SDKs only create the classic `.sln`).

**4. Pin `dotnet-ef` to the repository.** A local tool manifest means `dotnet tool restore` gives
everyone (and CI) the same EF Core CLI:

```bash
dotnet new tool-manifest
dotnet tool install dotnet-ef
dotnet tool list            # dotnet-ef 10.x, manifest .config/dotnet-tools.json
```

**5. Build the backend.**

```bash
dotnet build
dotnet test                 # the template's single empty test passes
```

In an interactive terminal the end of the output looks roughly like this (timings differ):

```text
Build succeeded in 4.2s
...
Test summary: total: 1, failed: 0, succeeded: 1, skipped: 0, duration: 1.3s
```

In CI, or with output redirected, you get the classic form instead:
`Passed!  - Failed: 0, Passed: 1, Skipped: 0, Total: 1`. Either way, **0 failed** is what counts.

The `xunit` template gives you a working test project today. In cap-03 you replace its `.csproj`
with an **xUnit v3** one (assembly fixtures, `TestContext.Current.CancellationToken`), so don't
spend time on `UnitTest1.cs`.

**6. The web app.** Use the official Vite template (React + TypeScript). If the tool asks whether
to install and start now, answer **No**: you install explicitly in the next command.

```bash
npm create vite@latest web -- --template react-ts
cd web
npm install
npm run build               # type-checks and bundles to web/dist
cd ..
```

**7. A README that tells the next person how to start.** Create `README.md`:

```markdown
# BranchStory

A collaborative editor for branching interactive stories: scenes are nodes, choices are edges.

## Layout

- `api/BranchStory.Api` – ASP.NET Core 10 minimal API (http://localhost:5080)
- `api/BranchStory.Data` – EF Core 10 model and migrations (PostgreSQL 18)
- `worker/` – background job runner (publishing)
- `web/` – Vite + React 19 + TypeScript (http://localhost:5173)
- `tests/` – xUnit (unit + integration), Playwright e2e
- `deploy/` – Docker Compose, Kubernetes (kind + kustomize)
- `docs/adr/` – architecture decision records

## Getting started

    dotnet tool restore
    docker compose -f deploy/compose.yaml up -d   # Postgres (from cap-02)
    dotnet run --project api/BranchStory.Api
    cd web && npm install && npm run dev
```

**8. First commit.**

```bash
git add -A
git status                  # no bin/, obj/ or node_modules/ in the list
git commit -m "chore: scaffold BranchStory monorepo"
```

:::tip title="Commit per milestone"
Tag the end of every lesson (`git tag cap-01`). When something breaks in cap-07, `git diff cap-06`
shows exactly what changed, and you can always get back to a working demo.
:::

- [ ] `dotnet --version` prints 10.0.x and `node --version` prints an LTS release (24+)
- [ ] `BranchStory.slnx` lists `BranchStory.Api`, `BranchStory.Data` and `BranchStory.Api.Tests`
- [ ] `dotnet build` and `dotnet test` succeed from the repository root
- [ ] `dotnet tool list` shows `dotnet-ef` from `.config/dotnet-tools.json`
- [ ] `npm run build` in `web/` succeeds
- [ ] `git status` is clean after the first commit, and `bin/`, `obj/` and `node_modules/` are not tracked
:::

## Architecture decision records

Decisions you don't write down get re-argued every month. An **ADR** is a short Markdown file:
the context, the decision, and the consequences, *including the bad ones*. It's cheap to write,
and six months later it explains *why* the code looks the way it does.

:::lab id=cap-01-lab2 xp=60
title: Write the first three ADRs

Create three files in `docs/adr/`. Use the first one as written, then write the other two yourself
in the same shape, using the tech-choices table and the quizzes above as material.

**1. `docs/adr/0001-story-graph-as-a-versioned-document.md`**

```markdown
# 1. Store the story graph as one versioned jsonb document

- Status: accepted
- Date: (today)

## Context

The editor loads and saves the whole graph (scenes + choices) at once. Several people may edit the
same story, and autosave fires every few seconds. A save must never half-apply, and a slower save
must never silently overwrite a faster one.

## Decision

`projects.doc` is a `jsonb` column holding `{ startNodeId, nodes[], edges[] }`, and
`projects.version` is an integer. Every save sends the version it was based on; the API runs
`UPDATE … WHERE id = @id AND version = @expected` and answers 409 with the current version when
zero rows match.

## Consequences

- Good: atomic saves, one-statement conflict detection, a trivial ETag (`"7"`).
- Good: the client and the worker share one JSON contract.
- Bad: no foreign keys inside the graph, so the API must validate structure (edges point at
  existing scenes, the start scene exists).
- Bad: searching scenes across stories needs a GIN index or a read model later.
```

**2. `docs/adr/0002-postgres-as-the-job-queue.md`**: decide on a `jobs` table claimed with
`FOR UPDATE SKIP LOCKED` instead of Redis or RabbitMQ. Mention transactional enqueue, leases for
crash recovery, and when you would revisit the decision (sustained throughput, fan-out to many
consumers).

**3. `docs/adr/0003-quotas-are-billed-to-the-owner.md`**: decide that every project-scoped limit
(collaborators, scenes, publishes) is read from the **owner's** plan, and is re-checked on the
server for every request.

Commit them: `git add docs/adr && git commit -m "docs: first ADRs"`.

:::pro title="ADRs in real teams"
Many teams keep ADRs next to the code and require one in the pull request for any change that adds
infrastructure or changes a contract. "Superseded by ADR 0009" is a perfectly good status: the
history of *why* is the valuable part.
:::

- [ ] `docs/adr/0001-story-graph-as-a-versioned-document.md` exists with context, decision and consequences
- [ ] ADR 0002 names at least one condition under which you'd move to a dedicated queue
- [ ] ADR 0003 explains how billing the collaborator instead of the owner could be abused
- [ ] All three ADRs are committed
:::

:::cards id=cap-01-cards1 xp=15 title="BranchStory architecture"
Q: What are nodes and edges in BranchStory?
A: Nodes are scenes (title, text, optional media URL, position). Edges are choices with a label, from one scene to another.
Q: How is a stale save detected?
A: The client sends `expectedVersion`; the API updates `WHERE version = expected`. Zero rows updated → 409 with `currentVersion`.
Q: Whose plan limits apply when an editor publishes?
A: The project owner's. Every project-scoped quota is billed to the owner.
Q: What does `FOR UPDATE SKIP LOCKED` give the worker?
A: Many workers can claim jobs at once: each locks one free row and skips rows another worker already locked, so no job is handed out twice.
Q: How does job progress reach the browser?
A: Worker → `pg_notify('job_events')` → the API LISTENs → SignalR `JobUpdated` to the project's group.
Q: Strangers vs under-privileged members: which status codes?
A: Strangers get 404 (don't reveal the project exists); members acting above their role get 403.
Q: What is a modular monolith?
A: One deployable with strict internal module boundaries (feature folders). You split it only when a module has a different scaling or failure profile, like the worker.
Q: What is an ADR?
A: An Architecture Decision Record: a short file with context, decision and consequences, kept in the repo.
Q: What does an `Idempotency-Key` protect against?
A: Duplicate work from retries and double-clicks: the server stores the key, so a repeated request returns the first result instead of queueing a second job.
Q: Why is "read the version, compare, then UPDATE" wrong?
A: Two requests can both pass the check before either writes. The version check must be part of the `UPDATE … WHERE version = @expected` itself.
:::

## Recap

- **BranchStory** is a collaborative editor for branching stories, with owners, editors and viewers,
  live co-editing, background publishing and a public player.
- The architecture is **one API + one worker + one Postgres**: REST + SignalR in front, `jsonb` +
  `version` for documents, a `SKIP LOCKED` job queue, and LISTEN/NOTIFY for job status.
- The repo is a **monorepo** with feature modules on both sides: `api/`, `worker/`, `web/`, `tests/`,
  `deploy/`.
- Tech choices are deliberately **boring**; the interesting parts are the design decisions, and the
  ADRs record them.
- Every milestone ends in a **demo**. "Done" means correct under concurrency, authorized on the
  server, tested, accessible, observable and shippable.
