---
id: bc-07
title: Your First Weeks at a New Job
level: beginner
minutes: 45
xp: 100
summary: How to read an unfamiliar codebase, set up a painful local environment, ask good questions, ship a first ticket and keep a brag doc.
---

Nobody expects you to be productive on day one. What a good team *does* expect is that you get
productive **steadily**: environment running in the first days, a small change merged in the first
week or two, and growing independence after that. This lesson is a field guide for those weeks —
the part of the job no framework tutorial teaches.

## The first 90 days in rough shape

| When | Focus | A good outcome |
|---|---|---|
| **Week 1** | Access, local setup, meet people, read docs | App runs locally; you know who to ask for what |
| **Weeks 2–3** | First tickets, first reviews | 1–3 small PRs merged; you've reviewed others' PRs |
| **Month 2** | Medium features, one area in depth | You own a small feature end-to-end |
| **Month 3** | Independence, improve something | You fixed a pain point (docs, tests, scripts) others notice |

:::job title="What your manager actually watches"
Not raw speed. Managers look for: *Do they unblock themselves? Do they ask good questions early
instead of being stuck silently for two days? Do their PRs get easier to review over time?* Those
signals matter far more in the first month than story points.
:::

## Day one: the onboarding checklist

Most companies have an onboarding doc — and most of those docs are slightly out of date. Work
through it anyway, and **fix what's wrong** as you go (that's often your first PR!).

**Access & accounts**
- Laptop, SSO, password manager, MFA set up.
- GitHub/GitLab org access, the right teams, SSH key or `gh auth login`.
- Chat (Slack/Teams) channels: team, deploys, incidents, help channels.
- Ticket system (Jira/Linear/GitHub Projects) and the team board.
- Cloud console / Kubernetes read access, logs and dashboards (Grafana, Datadog, Application Insights, Seq…).
- Any VPN, package registry token (private npm / NuGet feed), database read replicas.

**People**
- 1:1 with your manager: expectations for 30/60/90 days, how performance is judged.
- Your **onboarding buddy**: who to bother with "dumb" questions (there are none).
- Who owns what: frontend, API, infra, product, design, QA.

**Rituals**
- When are standup, planning, refinement, retro? Which are optional?
- How do deploys happen and how often? Who is on call?

## Local environment pain (and how to beat it)

Getting an existing product running locally is often the hardest task of week one. Why? Because
the people who set it up did it years ago, on machines that have slowly accumulated the right
tools, versions and secrets. Nobody on the team notices the missing steps any more — you are the
first one in months to start from zero. Typical blockers: a missing environment variable, a private
package feed, a database that needs seed data, the wrong Node or .NET version, a Docker image only
built on CI, or a service that "everyone just points at staging".

A typical full-stack product is not one process but several. A usual local stack looks like this:

| Piece | Usually runs as | Why it's there |
|---|---|---|
| PostgreSQL | container from `compose.yaml` (older repos: `docker-compose.yml`) | the system of record |
| Redis | container | cache, sessions, rate limiting, sometimes a simple job queue |
| A message broker (RabbitMQ, Kafka, Azure Service Bus emulator…) | container, if used | events and background work between services |
| The API (ASP.NET Core) | `dotnet run` / IDE, on your machine | so you can debug it with breakpoints |
| The frontend (Vite dev server) | `npm run dev` | hot reload |

The usual split: **infrastructure in containers, the code you are changing on the host** (so the
debugger and hot reload work).

A systematic approach:

1. **Find the official path.** Look for `README.md`, `CONTRIBUTING.md`, `docs/`, `Makefile`,
   `justfile`, `package.json` scripts, `compose.yaml` / `docker-compose.yml`, `.devcontainer/`, `.tool-versions`,
   `.nvmrc`, `global.json` (pins the .NET SDK).
2. **Match versions exactly.** `node -v` vs `.nvmrc`, `dotnet --list-sdks` vs `global.json`.
   Version files exist precisely so that "works on my machine" means the same thing on every
   machine and on CI.
3. **Copy example config.** `.env.example` → `.env` (which must be git-ignored),
   `appsettings.Development.json`, and `dotnet user-secrets` — a .NET tool that stores secrets in
   a JSON file in your user profile, *outside* the repo, and is only loaded in the `Development`
   environment. Ask where real dev secrets live (usually a vault such as Azure Key Vault,
   1Password or HashiCorp Vault — never pasted in chat, never committed).
4. **Start dependencies first.** `docker compose up -d db redis` — then the API, then the
   frontend. (`db` and `redis` are the *service names* in the repo's `compose.yaml` — check the file,
   teams name them differently; bc-02 shows how Compose works.) An API that starts before its
   database is up fails with connection errors that look scarier than they are.
5. **Read the error, the whole error.** The first error line is often the real one; later ones are
   consequences.
6. **Time-box it.** Stuck 30–60 minutes on the same error? Ask (see below) — someone has seen it.
7. **Write down every fix** as you go, then update the README in a PR.

```bash
# A typical full-stack "bring it up" sequence you'll end up writing down
fnm install && fnm use           # reads .nvmrc (bc-02); nvm users: `nvm install && nvm use`
dotnet --version                 # prints the SDK chosen by global.json; errors if it's missing
cp .env.example .env
docker compose up -d db redis    # infrastructure first (service names from compose.yaml)
docker compose ps                # both should show "running" / "healthy"
dotnet tool restore              # installs repo-pinned tools such as dotnet-ef
dotnet ef database update --project src/Api   # apply EF Core migrations to the local DB
dotnet run --project src/Api     # API on http://localhost:5080 (set in Properties/launchSettings.json)
cd web && npm ci && npm run dev  # frontend; Vite's default port is 5173
```

Two details worth knowing: `npm ci` (not `npm install`) installs exactly what `package-lock.json`
says and never rewrites it — that's what CI does, so it reproduces CI's dependencies. And
`dotnet tool restore` reads `.config/dotnet-tools.json`, the repo's list of pinned .NET CLI tools.

### What `global.json` actually does

`global.json` tells the `dotnet` command *which SDK* to use in this folder:

```json
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

`version` is the minimum; `rollForward` says how far newer SDKs may stand in. With the default
(`latestPatch`) only a newer *patch* such as `10.0.102` is accepted; `latestFeature` also accepts
`10.0.2xx`; `latestMajor` accepts anything newer. If nothing installed qualifies, every `dotnet`
command fails with *"A compatible .NET SDK was not found"* — even `dotnet --version`.

:::pro title="Leave the campsite cleaner"
The best first PR a new hire can make is to the setup docs. You are the only person in the company
who currently sees the onboarding through fresh eyes. Seniors notice and remember this.
:::

:::quiz id=bc-07-q1 xp=10
`dotnet run` fails on your machine with *"A compatible .NET SDK was not found. Requested SDK
version: 10.0.100, global.json file: …/global.json"*. You have only the .NET 9 SDK installed.
What's the right fix?
- [ ] Delete `global.json` so your installed SDK is used
- [x] Install a .NET 10 SDK that satisfies the pinned version and its `rollForward` policy
- [ ] Change the projects' `TargetFramework` to `net9.0`
- [ ] Run `npm install`
> `global.json` pins the SDK so everyone — and CI — builds with the same toolchain; the fix is to
> install what it asks for. Deleting it is the tempting shortcut: it may even build, but now you
> compile with a different compiler than the team and CI, and you'd probably commit the deletion by
> accident. Retargeting to `net9.0` changes the product itself. `npm` has nothing to do with the
> .NET SDK.
:::

## Reading an unfamiliar codebase

You can't read 200,000 lines, and you don't need to. You need a **map** and **one path through it**.

### 1. Start with the docs written for you

- `README.md`, `CONTRIBUTING.md` — how to run, test, contribute.
- `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` — increasingly common: concise
  conventions written for AI assistants, which are also the best summary for humans.
- `docs/adr/` — **Architecture Decision Records**: short documents explaining *why* things are the
  way they are ("ADR-007: Use PostgreSQL over MongoDB"). Gold for understanding odd choices.
- CI config (`.github/workflows/*.yml`) — tells you exactly how the code is *really* built and tested.

### 2. Find the entry points

| Layer | Look for |
|---|---|
| React/Vite | `index.html` → `src/main.tsx` → router (`routes.tsx`, `App.tsx`) |
| ASP.NET Core | `Program.cs` (DI registrations, middleware, endpoint mapping) |
| Database | `Migrations/`, `DbContext`, schema SQL |
| Deployment | `Dockerfile`, `compose.yaml`, `k8s/`, Helm charts, `.github/workflows/deploy*.yml` |
| Background work | `BackgroundService` / hosted services, queue consumers, Redis or broker config |

`Program.cs` alone tells you the auth scheme, the database, the logging setup and which features
exist. Ten minutes there saves hours.

The deployment folder is worth a look even if you are "just a developer": it shows what actually
runs in production. For example, if you find a `kind: ScaledObject` (from **KEDA**, the Kubernetes
Event-Driven Autoscaler) pointing at a Redis list or a queue, you've just learned that some worker
scales with queue length — so "the job is slow" might really mean "the queue is backed up".

### 3. Run the tests

`npm test` and `dotnet test`. Green tests mean your environment is correct. The test names are a
specification of behaviour written by the team — read a few.

### 4. Trace one request end-to-end

Pick one feature you can see in the UI (e.g. "Save project") and follow it all the way down:

```text
Button onClick in ProjectForm.tsx
 → useSaveProject() hook → fetch PUT /api/projects/{id}
 → ProjectsEndpoints.cs  MapPut("/projects/{id}")
 → ProjectService.UpdateAsync() — validation, permission check
 → AppDbContext.Projects … SaveChangesAsync()
 → SQL UPDATE projects … (see it in the logs with EF logging on)
 ← 200 + JSON → TanStack Query cache update → UI re-renders
```

How to do it in practice: open the browser's **DevTools → Network tab**, click the button, and
look at the request (method, URL, payload, response). Then search the backend for the route, set
a breakpoint in the endpoint and step through. Turn on EF Core command logging (or watch the
Postgres logs) to see the SQL. After one full trace, the architecture stops being abstract —
and every other feature is "the same, but different".

:::tip title="Never used the debugger on a full stack?"
DevTools' Network and Console tabs, breakpoints in React and in ASP.NET Core, and reading a stack
trace from the top down are taught step by step in the Pro Skills lesson **Debugging Like a Pro**.
It's worth doing before (or during) your first week — tracing a request is ten times faster with a
debugger than with `console.log`.
:::

### 5. Use the tools

- **Search** (`Ctrl+Shift+F`, or ripgrep: `rg 'MapPut\("/projects'`), **Go to definition**,
  **Find all references**.
- `git log --oneline -- path/to/file` and `git blame` — who changed this and why (follow the PR
  link: the PR discussion usually explains far more than the commit message).
- `git log -S "SomeMethodName"` ("pickaxe") — finds the commits that added or removed a string,
  great for "when did this appear?".
- Draw a box diagram as you go. Your own sketch beats any official one for learning.

:::quiz id=bc-07-q2 xp=15
You joined a team with a large ASP.NET Core + React codebase. Which first steps give the best
understanding per hour? (Select all that apply.)
- [x] Read the README, ADRs and CI workflow files
- [x] Read `Program.cs` and the frontend router to find entry points
- [x] Trace one real user action from the button click to the SQL and back
- [ ] Read every file in alphabetical order
- [ ] Rewrite a module in your preferred style to learn it
> Docs + entry points + one end-to-end trace give you a map and a path. Reading everything is
> impossible, and rewriting code you don't understand yet is how new hires lose trust.
:::

## Asking good questions

Asking is not weakness — being stuck in silence for two days is. But *how* you ask matters. A good
question shows what you tried and makes it easy to answer:

```text
❌  "The API doesn't work, can someone help?"

✅  "Trying to run the API locally (main @ 3f2a1c). `dotnet run` fails with
    `Npgsql.PostgresException: 28P01 password authentication failed for user "app"`.
    I'm using the docker-compose Postgres and the connection string from .env.example.
    I tried resetting the container volume — same error.
    Is there a different dev password, or a secret I'm missing?"
```

The pattern: **context → what you expected → what happened (exact error) → what you tried →
specific question**.

More habits:

- **Ask in public channels**, not DMs, when possible: others learn, answers get searchable, and you
  don't depend on one person.
- **Time-box** before asking: ~30–60 min on the same setup error, a bit longer for logic
  problems — but never days. The time-box protects both sides: you don't waste a day, and you
  arrive with enough detail for a good question.
- **Batch small questions** for your buddy into one message or a daily 15-minute slot.
- **Write the answer down** (team wiki, README) so the next person doesn't have to ask.
- Ask **"why"** questions too: *"Why do we use a queue here instead of calling the service directly?"*
  — that's how you learn the system's history.

:::quiz id=bc-07-q3 xp=10
Which question is most likely to get a fast, useful answer?
- [ ] "Hey, quick question?" (then waiting for a reply before asking)
- [ ] "Login is broken."
- [x] "On staging, login returns 401 after the redirect from SSO; the cookie `.AspNetCore.Cookies` is set but has `SameSite=Strict`. I compared with prod config — same. Could the staging domain change have affected it?"
- [ ] A DM to the CTO
> Specific context, exact symptoms, what was checked, and a concrete hypothesis — anyone in the
> channel can answer it without a back-and-forth. "Hey, quick question?" feels polite but costs a
> full round-trip before the real question even arrives (see nohello.net). "Login is broken" forces
> the reader to ask "where? since when? what error?". A DM to the CTO skips the people who actually
> know and hides the answer from everyone else.
:::

:::quiz id=bc-07-q4 xp=10
It's day two. A teammate pastes the shared dev database password into a DM so you can finally run
the API. Where should it go?
- [ ] Into `appsettings.json`, so it works for everyone after you commit
- [x] Into `dotnet user-secrets` (or the git-ignored `.env`) on your machine — and suggest the team moves it to the vault
- [ ] Into `appsettings.Development.json`, because that file is only used in development
- [ ] Into the README, so the next new hire doesn't have to ask
> User secrets live in your user profile, outside the repository, so they can't be committed by
> accident. The tempting trap is `appsettings.Development.json`: "Development" describes *when it is
> loaded*, not *where it is stored* — it's a normal tracked file, so the password ends up in git
> history forever. `appsettings.json` and the README are committed too. A secret in git is leaked
> even after you delete it in a later commit.
:::

:::quiz id=bc-07-q5 xp=10
You've been stuck on the same `docker compose up` error for 50 minutes. You tried two fixes from
Stack Overflow. What's the best next step?
- [ ] Keep going — asking this early looks weak
- [ ] Silently try a completely different setup (e.g. install Postgres natively) and say nothing
- [x] Post in the team's help channel: what you ran, the exact error, what you tried, and a specific question
- [ ] DM your buddy "are you free?" and wait
> You've hit the time-box, so ask — in public, with the context → actual → tried → question shape.
> Someone has almost certainly seen this exact error. Going off-script with a native install is the
> tempting "I'll fix it myself" move, but it gives you a setup nobody else has, so the next bug will
> be yours alone. "Are you free?" adds a wait without giving them anything to answer.
:::

## Your first ticket

Your first tickets are about **learning the delivery pipeline**, not about impact. Good first
tickets are small and touch the full path: code → tests → PR → review → CI → deploy.

Strategy:

1. **Pick small** — a bug with clear reproduction, a copy change, a small validation rule. Tickets
   labelled `good first issue` or `onboarding` exist for this.
2. **Clarify before coding.** Restate the acceptance criteria in your own words in the ticket:
   *"So the export should respect the date filter, and an empty range should return headers only —
   correct?"*
3. **Find similar code.** The codebase already has a pattern for endpoints, validation, tests.
   Copy the pattern, don't invent a new one.
4. **Write or update a test** that fails before your fix.
5. **Open a draft PR early**, follow the PR template, ask for feedback on the approach.
6. **Watch it go to production.** Ask to see the deploy, the logs and the dashboard. Now you know
   the whole loop.

:::warn title="Common first-ticket mistakes"
- Fixing three unrelated things "while you're there" — the PR becomes hard to review.
- Reformatting whole files (different editor settings) — the diff explodes. Use the repo's
  Prettier/`.editorconfig`/`dotnet format` config.
- Introducing a new library for something the codebase already does another way.
- Going silent for days. Post a short update in the ticket even if it's "still investigating X".
:::

:::quiz id=bc-07-q6 xp=10
Your first ticket: "Export ignores the date filter." While fixing it you notice the file uses
inconsistent formatting, and an unrelated method has a typo in a log message. What goes into your PR?
- [ ] All three — fixing things you find is proactive
- [x] Only the date-filter fix plus a test that proves it; note the other things in a separate ticket or a follow-up PR
- [ ] The fix and a reformat of the whole file, since formatting is harmless
- [ ] Nothing yet — first rewrite the export module so it's easier to fix
> A reviewer must be able to see *exactly* what changed and why. A whole-file reformat buries a
> three-line fix in hundreds of changed lines, and an unrelated change makes the PR harder to review
> and harder to revert if something goes wrong. Fixing the typo is fine — in its own small PR. A
> rewrite before you understand the module is the riskiest option of all.
:::

## Keep a brag doc / work log

A **brag document** is a private running list of what you did, learned and influenced. It sounds
vain; it's actually practical:

- Performance reviews ask "what did you achieve this half?" — nobody remembers week 3.
- It shows patterns: where you spend time, what you keep getting stuck on.
- It makes promotions, CV updates and interviews much easier.

A simple weekly format:

```md
## Week of 2026-11-02
**Shipped**
- Fixed CSV export date filter (#42) — 9 support tickets/week → 0
- First on-call shadow shift; wrote runbook for "queue backlog" alert
**Learned**
- How our outbox pattern publishes events (ADR-012)
**Helped**
- Paired with Sam on EF Core migration conflict
**Stuck on / next**
- Don't understand tenant isolation in the auth middleware yet → ask Ana Thursday
```

Add numbers when you have them (latency, tickets, minutes saved). Five minutes on Friday is enough.

:::pro title="A work log also helps you today"
Many seniors keep a daily log file (`log/2026-11-05.md`) with commands they ran, errors they hit
and decisions made. When the same error reappears in three months, `grep` finds the fix in seconds.
:::

:::lab id=bc-07-lab1 xp=80
title: Map an unfamiliar codebase
Pick an open-source full-stack project you've never seen (for example a medium-size React + ASP.NET
or React + Node repo on GitHub), or your new employer's main repo if you already have access.
Create a file `onboarding-notes.md` (outside the repo, or in your private notes) and fill it in.

**Part 1 – Orientation (≈10 min)**
- Read the README, CONTRIBUTING and any `docs/adr` folder. Write 3 bullet points: what the product
  does, how it's run locally, one architectural decision and its reason.
- Open the CI workflow and note the exact build/test commands.

**Part 2 – Run it (≈15 min)**
- Get the app or at least the tests running. Log every problem and fix in your notes.

**Part 3 – Trace (≈15 min)**
- Pick one user action. Write the chain: UI component → API call → endpoint/controller →
  service → database, with file names.

**Part 4 – Reflect**
- Write one well-formed question (context, expected, actual, tried, question) you would ask a
  teammate about something you didn't understand.
- Start a brag doc with this week's entry.

A skeleton you can copy:

```md
# Onboarding notes – <project>
## What it is
- Product: …
- Run locally: …
- Decision (ADR-…): … because …
## CI commands
- build: …   test: …
## Setup log
- Problem: … → Fix: …
## Trace: <user action>
- UI: src/…/X.tsx → API: PUT /api/… → Endpoint: …cs → Service: …cs → Table: …
## My question
- Context / expected / actual / tried / question: …
```

- [ ] My notes summarise the product, how to run it and one ADR/decision
- [ ] I ran the tests (or the app) locally and logged every setup issue
- [ ] I traced one request from UI to database with concrete file names
- [ ] I wrote one well-formed question using the context → tried → question pattern
- [ ] I started a brag doc with a first weekly entry
:::

:::cards id=bc-07-cards1 xp=15 title="First weeks survival"
Q: First four things to read in an unknown repo?
A: README/CONTRIBUTING, AGENTS.md (if any), ADRs in docs/adr, and the CI workflow files.
Q: Where does an ASP.NET Core app reveal its architecture fastest?
A: `Program.cs` — DI registrations, middleware pipeline, auth, endpoint mapping.
Q: What is an ADR?
A: Architecture Decision Record — a short doc capturing a decision, its context and consequences.
Q: The shape of a good question?
A: Context → expected → actual (exact error) → what I tried → specific question.
Q: How long to stay stuck before asking?
A: Time-box: ~30–60 min on the same setup error. Never days.
Q: Where do local dev secrets go in .NET?
A: `dotnet user-secrets` (stored in your user profile, outside the repo) or a git-ignored `.env` — never a committed appsettings file.
Q: `npm ci` vs `npm install`?
A: `npm ci` installs exactly what the lockfile says and never changes it — reproducible, like CI.
Q: What makes a good first ticket?
A: Small, clear acceptance criteria, touches the full path from code to deploy.
Q: Best first PR for a new hire?
A: Fixing the onboarding/setup docs you just struggled through.
Q: Why keep a brag doc?
A: Reviews, promotions and CVs need evidence; you won't remember week 3 in month 6.
Q: Which files pin tool versions?
A: `.nvmrc` / `.node-version` / `package.json` engines for Node, `global.json` for the .NET SDK, `.tool-versions` for asdf/mise.
:::

## Recap

- Expect a ramp: environment in week 1, small PRs in weeks 2–3, owning features by month 2–3.
- Beat setup pain systematically: official path, exact versions (`.nvmrc`, `global.json`),
  example config, secrets outside git, infrastructure containers first, read the full error,
  time-box, document fixes.
- Read a codebase via **docs → entry points → tests → one end-to-end trace**.
- Ask **specific, public, well-formed** questions early; write the answers down.
- First tickets are about learning the pipeline: small, clarified, following existing patterns,
  one concern per PR.
- Keep a **brag doc / work log** — five minutes a week, huge payoff later.
