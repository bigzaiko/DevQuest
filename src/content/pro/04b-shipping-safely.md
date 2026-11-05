---
id: pro-09
title: "Shipping Safely: Continuous Delivery & Releases"
level: advanced
minutes: 85
xp: 150
summary: From green CI to production without fear — promote one artifact by digest, pick a deployment strategy, migrate the database with expand/contract, gate deploys on health, log in with OIDC, and measure it all with DORA.
---

In **CI with GitHub Actions** you made every change build and test itself. That answers "is this
commit good?". This lesson answers the next, scarier question: **"how does a good commit reach
users without breaking anything — and what happens when it does break anyway?"**

Two terms first, because people mix them up in interviews:

- **Continuous Delivery** — every green commit on `main` *could* go to production at the push of
  a button. The pipeline produces a releasable artifact and proves it in staging; a human (or a
  schedule) decides *when*.
- **Continuous Deployment** — every green commit *does* go to production, automatically, with no
  human step. It needs everything in this lesson to be in place, because there is nobody left to
  catch a mistake.

The goal of both is the same: make releases **small, boring and reversible**. A team that deploys
twenty small changes a day has fewer outages than a team that deploys one huge change a month —
not despite deploying more often, but *because* each deploy is small enough to understand, test
and undo.

## The pipeline as a promotion line

Picture a factory line. CI builds **one** container image, gives it an immutable identity (its
digest), and that exact object moves from station to station. Each station adds confidence; none
of them change the object.

```text
 commit ─► CI: build + test ─► image @sha256:9f2c… ─► dev ─► staging ─► production
                                       │                │         │            │
                                       └── same bytes ──┴─────────┴────────────┘
                                           only CONFIG differs per environment
```

| Station | What it proves | Typical gate |
|---|---|---|
| **CI** | It compiles, unit + integration tests pass | Required status checks on the PR |
| **dev / preview** | It starts, talks to real services | Automatic on merge |
| **staging** | It works with production-like data, migrations run cleanly, smoke + E2E tests pass | Automatic; health checks |
| **production** | Real users are fine | Approval and/or canary analysis |

**Build once, promote by digest.** A tag like `:1.4.0` or `:latest` is a movable label — someone
can push a different image under the same tag. A digest (`@sha256:…`) is the hash of the image
content and can never point at anything else. Promoting means "deploy *this digest* to the next
environment", never "rebuild for production". You saw the mechanics in
**Registries, Tags and CI Pipelines**; here is why it matters:

- If you rebuild for production, production runs bytes that **were never tested**. A new base
  image, a floating NuGet/npm version, or a different build machine can change behaviour.
- When something breaks you can say exactly what is running: `kubectl get pods -l app=api -o
  jsonpath='{..imageID}'` prints the resolved `@sha256:…` of every running container → a CI run →
  a commit.
- Rollback is "point back at the previous digest" — seconds, no build.

In GitHub Actions, the build job publishes the digest as a job output and every later job deploys
that exact value — nothing downstream ever builds or re-resolves a tag:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.push.outputs.digest }}      # e.g. sha256:9f2c…
    steps:
      - uses: actions/checkout@v5
      - id: push
        uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/shop-api:${{ github.sha }}   # a human-readable label
  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: kubectl set image deployment/api api=ghcr.io/acme/shop-api@${{ needs.build.outputs.digest }}
```

(Registry login and cluster credentials are left out here; the OIDC section below covers them.)
If you want a friendly `:prod` tag as well, *retag* the existing digest
(`docker buildx imagetools create --tag ghcr.io/acme/shop-api:prod ghcr.io/acme/shop-api@sha256:…`)
— that copies a label, not bytes.

What *does* differ between environments is **config**: connection strings, URLs, feature-flag
values, replica counts. That is injected at deploy time (env vars, ConfigMaps, Key Vault —
see **Configuration, Secrets & Feature Flags**), which is exactly why an image must never bake in
an environment name.

:::warn title="The frontend trap"
`VITE_*` variables are replaced at **build time** — a Vite bundle built with
`VITE_API_URL=https://staging-api…` will call staging forever. To promote one React build through
environments, either serve the SPA from the same origin as the API (relative `/api` URLs), or load
a small `/config.json` at startup that each environment serves differently.
:::

:::quiz id=pro-09-q1 xp=15
Staging passed all tests with image `shop-api:1.8.0` built from commit `a1b2c3d`. The production
deploy job runs `docker build -t shop-api:1.8.0 .` from the same commit and deploys the result.
Two hours later production fails with a TLS error that staging never showed. What is the most
likely root cause **of the process**?

- [ ] The tag `1.8.0` should have been `1.8.0-prod`
- [x] Production runs a freshly built image that was never tested — the rebuild picked up a different base image or dependency
- [ ] Staging and production must use separate commits
- [ ] TLS errors can only come from configuration, never from the image
> Same commit is not the same artifact. `FROM mcr.microsoft.com/dotnet/aspnet:10.0` is a floating tag, so the rebuild can pull a newer base image with different OpenSSL/CA certificates, and unpinned packages can resolve differently. Renaming the tag changes nothing — the bytes are still untested. The fix is to build once and promote the tested digest. Config *can* cause TLS errors, but the process flaw here is the untested rebuild.
:::

## Deploy is not release

The single most useful idea in this lesson:

- **Deploy** = new code is running on servers.
- **Release** = users experience the new behaviour.

When the two are the same moment, every deploy is a bet. When you separate them — with traffic
shifting or feature flags — you can deploy at 10:00 on a Tuesday, watch dashboards, and release
to 1 % of users at 11:00, to everyone at 15:00, and back to 0 % in one click if support tickets
start arriving.

## Deployment strategies

Every strategy answers three questions differently: *How much capacity do I need? How many users
see a bad version, and for how long? How fast can I undo it?*

### Recreate

Stop all old instances, then start the new ones (`strategy: type: Recreate` in a Kubernetes
Deployment). Simple, never two versions at once — and there **is downtime** between stop and start.
Use it when two versions *must not* run together (a single-instance job scheduler, a schema change
you can't make compatible) and a short outage is acceptable.

### Rolling update

Replace instances a few at a time (`maxSurge` / `maxUnavailable` — the math is in
**Pods, ReplicaSets & Deployments**). The Kubernetes default. No extra infrastructure, no downtime
if readiness probes are honest. But: **for the length of the rollout, old and new versions serve
traffic side by side**, and rollback is another rolling update in the other direction.

### Blue-green

Run the full new version ("green") next to the old one ("blue"), test green privately, then switch
**all** traffic at once — in Kubernetes by changing the Service selector from `version: blue` to
`version: green`. Rollback is the same switch back, which takes seconds because blue is still warm.
Costs double capacity during the switch, and every user moves at the same instant, so a bug hits
100 % of traffic — just very briefly if you watch closely.

### Canary

Send a small slice of real traffic (1–5 %) to the new version, **compare** its metrics against the
old version, and increase the slice in steps — 5 % → 25 % → 50 % → 100 % — only while it looks
healthy. Tools: Argo Rollouts or Flagger on Kubernetes, weighted routes in Traefik / NGINX / a
cloud load balancer. The blast radius of a bad release is small and the decision can be
**automated** (you will write that logic below). It needs good metrics and enough traffic to be
statistically meaningful — a canary on 3 requests a minute tells you nothing.

### Feature-flag dark launch

Deploy the code to 100 % of servers with the feature **off**, then turn it on for internal users,
then a percentage of customers. The code path is deployed, but released by config, not by
infrastructure. Finest control (per user, per tenant) and the fastest undo (flip a flag, no
deploy), but the flag is code you must test in both states and **delete** afterwards. The flag
mechanics are in **Configuration, Secrets & Feature Flags**.

| Strategy | Downtime | Extra capacity | Two versions live? | Blast radius of a bad release | Undo speed |
|---|---|---|---|---|---|
| Recreate | Yes | None | No | 100 % | A full redeploy |
| Rolling | No | `maxSurge` pods | **Yes**, during rollout | Grows as rollout proceeds | Another rollout |
| Blue-green | No | ~2× briefly | Briefly | 100 %, for a short time | Seconds (switch back) |
| Canary | No | A few pods | **Yes**, for minutes–hours | 1–5 % at first | Seconds (weight to 0) |
| Dark launch (flag) | No | None | Code yes, behaviour per user | As small as one user | Seconds (flag off) |

:::pro title="The hidden requirement of every zero-downtime strategy"
Look at the "two versions live?" column. Rolling, blue-green and canary all mean **version N and
N-1 run at the same time against the same database and the same clients**. That is why seniors
care so much about backwards compatibility: a zero-downtime strategy with a breaking schema or API
change is a downtime strategy with extra steps. The next two sections are how you stay compatible.
:::

:::quiz id=pro-09-q2 xp=15
Your team ships a rewritten pricing engine for a busy e-commerce API (≈2,000 requests/second).
You want the smallest possible number of customers to see a wrong price if the new engine has a
bug, and you want the decision to stop to be made by metrics, not by someone watching a dashboard.
Which strategy fits best?

- [ ] Recreate — no two versions ever disagree on prices
- [ ] Blue-green — the switch back takes seconds
- [x] Canary with automated analysis — a few percent of traffic first, promoted or aborted by comparing error rate and latency against the old version
- [ ] Rolling update with `maxUnavailable: 0`
> Canary limits the blast radius to a small slice *and* is built around automatic metric comparison; at 2,000 rps a 5 % canary gets plenty of data within minutes. Blue-green is tempting because rollback is instant, but it moves **100 %** of customers at once, so a bug hits everyone until someone notices. Rolling updates also expose a growing share of traffic and have no built-in analysis step. Recreate adds downtime and still exposes everyone. (For per-customer control, a feature flag on top would be even finer.)
:::

## Canary analysis: deciding with numbers

Automated canary analysis is not "is the error rate below 1 %?". A dependency outage can push
*both* versions to 3 %, and that's not the canary's fault. The question is **"is the canary
worse than the baseline running at the same time?"** — and only once there is enough data to say.

Rules real tools (Argo Rollouts `AnalysisTemplate`, Flagger, Kayenta) encode:

1. **Hard stop** — if the canary is obviously broken (say > 5 % errors) don't wait for a big
   sample; abort now.
2. **Minimum sample** — until the canary has seen enough requests, keep waiting.
3. **Relative regression** — compare against the baseline *in the same time window*.
4. **Noise floor** — 0.01 % vs 0.03 % is "3× worse" but meaningless; require a minimum absolute
   difference too.
5. **Latency counts** — a canary that is correct but 40 % slower is a regression.

:::challenge id=pro-09-c1 lang=ts xp=50
title: Promote, wait or roll back?
Write `canaryDecision(baseline, canary)` that returns `'promote'`, `'continue'` or `'rollback'`
for one analysis window. Each window has `requests`, `errors` and `p95Ms`. The error rate is
`errors / requests` (and **0** when `requests` is 0). Apply these rules **in this order**:

1. **Hard stop:** canary has at least **50** requests and its error rate is **greater than 0.05** → `'rollback'`.
2. **Not enough data:** canary has fewer than **500** requests → `'continue'`.
3. **Error regression:** canary rate **greater than** baseline rate × **1.5** **and** canary rate minus baseline rate **greater than 0.005** → `'rollback'`.
4. **Latency regression:** canary `p95Ms` **greater than** baseline `p95Ms` × **1.2** → `'rollback'`.
5. Otherwise → `'promote'`.

hint: Write a tiny `rate(w)` helper that handles `requests === 0` first.
hint: Rule 3 needs **both** conditions — the ratio catches real regressions, the absolute difference ignores noise like 0.01 % vs 0.03 %.
hint: "Greater than" is strict: a p95 of exactly 1.2× the baseline is still fine.

```ts starter
type Window = { requests: number; errors: number; p95Ms: number }
type Decision = 'promote' | 'continue' | 'rollback'

export function canaryDecision(baseline: Window, canary: Window): Decision {
  // compare canary against baseline
  return 'promote'
}
```

```ts solution
type Window = { requests: number; errors: number; p95Ms: number }
type Decision = 'promote' | 'continue' | 'rollback'

function rate(w: Window): number {
  return w.requests === 0 ? 0 : w.errors / w.requests
}

export function canaryDecision(baseline: Window, canary: Window): Decision {
  const c = rate(canary)
  const b = rate(baseline)
  if (canary.requests >= 50 && c > 0.05) return 'rollback'
  if (canary.requests < 500) return 'continue'
  if (c > b * 1.5 && c - b > 0.005) return 'rollback'
  if (canary.p95Ms > baseline.p95Ms * 1.2) return 'rollback'
  return 'promote'
}
```

```ts tests
const base = { requests: 10000, errors: 50, p95Ms: 200 } // 0.5 % errors

test('waits while the canary has too little traffic', () => {
  expect(canaryDecision(base, { requests: 200, errors: 0, p95Ms: 190 })).toBe('continue')
  expect(canaryDecision(base, { requests: 0, errors: 0, p95Ms: 0 })).toBe('continue')
})
test('hard stop: obviously broken canary is rolled back without waiting for 500 requests', () => {
  expect(canaryDecision(base, { requests: 100, errors: 10, p95Ms: 200 })).toBe('rollback')
})
test('hard stop needs at least 50 requests', () => {
  expect(canaryDecision(base, { requests: 49, errors: 10, p95Ms: 200 })).toBe('continue')
})
test('promotes a healthy canary', () => {
  expect(canaryDecision(base, { requests: 1000, errors: 6, p95Ms: 210 })).toBe('promote')
})
test('rolls back a clear error regression', () => {
  expect(canaryDecision(base, { requests: 1000, errors: 20, p95Ms: 200 })).toBe('rollback')
})
test('ignores a big ratio on tiny absolute numbers (noise floor)', () => {
  const quiet = { requests: 10000, errors: 1, p95Ms: 200 } // 0.01 %
  expect(canaryDecision(quiet, { requests: 1000, errors: 3, p95Ms: 200 })).toBe('promote')
})
test('baseline with zero errors still catches a real regression', () => {
  const perfect = { requests: 10000, errors: 0, p95Ms: 200 }
  expect(canaryDecision(perfect, { requests: 1000, errors: 10, p95Ms: 200 })).toBe('rollback')
  expect(canaryDecision(perfect, { requests: 1000, errors: 2, p95Ms: 200 })).toBe('promote')
})
test('both versions failing equally is not the canary\'s fault', () => {
  const outage = { requests: 10000, errors: 300, p95Ms: 400 } // 3 %
  expect(canaryDecision(outage, { requests: 1000, errors: 31, p95Ms: 410 })).toBe('promote')
})
test('rolls back a latency regression', () => {
  expect(canaryDecision(base, { requests: 1000, errors: 5, p95Ms: 250 })).toBe('rollback')
})
test('exactly 1.2x latency is still acceptable', () => {
  expect(canaryDecision(base, { requests: 1000, errors: 5, p95Ms: 240 })).toBe('promote')
})
```
:::

## Database migrations in the pipeline

Code is easy to roll back: point at the old digest. **Data is not.** Once a migration drops a
column, the old code that reads it is broken forever, and the data is gone. So the database is
where shipping safely is won or lost.

### Where migrations run

Run migrations as **their own pipeline step, before the new code rolls out** — a Kubernetes Job,
a CI step against the target database, or an EF Core **migration bundle**:

```bash
# CI: build a self-contained migrator next to the image
dotnet ef migrations bundle --project src/Shop.Api --self-contained -r linux-x64 -o efbundle

# Deploy step (staging, later production), with the environment's connection string
./efbundle --connection "$DB_CONNECTION"
```

Why not `db.Database.Migrate()` at app startup? Every replica tries to migrate at once (EF Core 9+
takes a lock, so they queue up instead of colliding, but startup becomes slow and fragile), the
app's database user needs DDL rights it shouldn't have in production, and a failing migration
becomes a crash-looping app instead of a clear red pipeline step. Prefer a separate step that runs
**once**, with a privileged migration user, and fails the deploy cleanly.

Because the migration runs **before** the rollout, the timeline of every deploy is:

```text
 old code on old schema  ─►  old code on NEW schema  ─►  old + new code on new schema  ─►  new code on new schema
                          (migration ran)              (rolling / canary in progress)
```

So the golden rule: **every migration must work with the code that is currently running *and*
the code about to be deployed.** And for rollback to be safe, the *previous* code must keep
working on the new schema too.

### Operations that look innocent

| Change | Why it breaks | Safe alternative |
|---|---|---|
| `RENAME COLUMN name TO display_name` | Old pods query `name` → `column does not exist` mid-rollout | Expand/contract (below) |
| `DROP COLUMN` in the same deploy that stops using it | Old pods still `SELECT` it during the rollout; EF Core selects every mapped column | Stop using it in deploy N, drop in deploy N+1 |
| `ADD COLUMN … NOT NULL` without default | Fails outright on a non-empty table; even on an empty one, old code's `INSERT`s don't set it → fail | Add nullable, backfill, then enforce (or add it with a constant `DEFAULT`, which is metadata-only since PostgreSQL 11) |
| `SET NOT NULL` on a big table | Full-table scan under an `ACCESS EXCLUSIVE` lock — all reads and writes wait | `CHECK (…) NOT VALID` → `VALIDATE` → `SET NOT NULL` |
| `CREATE INDEX` on a big table | Blocks writes for the whole build | `CREATE INDEX CONCURRENTLY` (outside a transaction) |
| Changing a column type | May rewrite the whole table under lock; old code sends the old type | New column + expand/contract |

:::warn title="Even a fast ALTER can cause an outage"
`ALTER TABLE users ADD COLUMN display_name text` is instant in PostgreSQL — but it needs a brief
`ACCESS EXCLUSIVE` lock. If a long-running report holds a lock on `users`, the `ALTER` waits, and
**every query that arrives after it queues behind the ALTER**. Your API stalls on a "metadata only"
change. Set `SET lock_timeout = '5s';` in migrations so they fail fast (and retry) instead of
freezing the table.
:::

### Expand/contract, fully worked

Task: rename `users.name` to `users.display_name` in a live system with rolling deploys, without
downtime and with every step individually reversible. The pattern is called **expand/contract**
(or "parallel change"): first **expand** the schema so both shapes exist, move code and data across
while both work, then **contract** by removing the old shape.

**Deploy 1 — expand + dual-write.** Migration (runs before the rollout):

```sql
SET lock_timeout = '5s';
ALTER TABLE users ADD COLUMN display_name text;   -- nullable: old INSERTs still work
```

Code: write **both** columns, keep **reading the old one**.

```csharp
public class User
{
    public int Id { get; set; }
    public string Name { get; set; } = "";          // still the source of truth
    public string? DisplayName { get; set; }        // new, being filled
}

// in the handler that creates or renames a user
user.Name = dto.DisplayName;
user.DisplayName = dto.DisplayName;                 // dual-write
```

During this rollout, old pods write only `name` — that's fine, nobody reads `display_name` yet.
Rollback to deploy 0: safe (old code ignores the extra column).

The failure mode here is a **forgotten write path**: the signup handler dual-writes, but the admin
"edit user" screen or a nightly import still sets only `name`. Those rows silently miss the new
value. Search for every place that writes the column (or temporarily add a database trigger that
copies `name` into `display_name`) before you call the dual-write done.

**Deploy 2 — backfill + switch reads.** This must be a *later* deploy than the dual-write: only
once **every** pod dual-writes can you be sure no new row is created without `display_name`.
Backfill in small batches so you never lock the table for long:

```sql
-- run repeatedly (a script or a Job) until it updates 0 rows
UPDATE users SET display_name = name
WHERE id IN (
  SELECT id FROM users
  WHERE display_name IS NULL AND name IS NOT NULL
  ORDER BY id
  LIMIT 5000
);
```

Then enforce the invariant without a long lock, and relax the old column so the *next* deploy is
allowed to stop writing it:

```sql
ALTER TABLE users ADD CONSTRAINT users_display_name_nn CHECK (display_name IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT users_display_name_nn;   -- scans, but allows reads/writes
ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;      -- uses the valid CHECK: no second scan
ALTER TABLE users DROP CONSTRAINT users_display_name_nn;

ALTER TABLE users ALTER COLUMN name DROP NOT NULL;             -- relaxing is always safe for old code
```

`NOT VALID` means "enforce for new and updated rows, but don't check existing rows yet";
`VALIDATE` then checks the old rows while holding only a lock that lets reads and writes continue.
Since PostgreSQL 12, `SET NOT NULL` skips its own full scan when a validated `CHECK` already proves
there are no NULLs. (PostgreSQL 18 can also add a `NOT NULL` constraint as `NOT VALID` directly; the
`CHECK` trick works on every supported version.)

Code: **read `DisplayName`**, still **write both**, and map `Name` as nullable (`string? Name`) —
it is still written, but this version must tolerate rows *without* a name. Rollback to deploy 1:
safe — deploy 1 reads `name`, which every row still has.

**Deploy 3 — stop writing the old column.** Code: remove `Name` from the entity entirely (EF Core
no longer reads or writes it). No schema change is needed, because deploy 2 already made `name`
nullable — without that `DROP NOT NULL`, this deploy's `INSERT`s would fail, the most common
expand/contract mistake. Rollback to deploy 2: safe — deploy 2 reads `display_name`, which every
row has, and its `string? Name` copes with the NULL names deploy 3 created. (Had deploy 2 mapped
`Name` as a non-nullable `string`, the rollback would crash on those rows with a "column is null"
error when EF Core materialises them.)

:::warn title="EF Core will try to drop the column for you"
When you delete the `Name` property and run `dotnet ef migrations add`, EF Core generates
`migrationBuilder.DropColumn("name", "users")` — in deploy 3, which is exactly the unsafe "drop in
the same deploy" from the table above. Delete that line from deploy 3's migration (keep the updated
model snapshot). In deploy 4, `dotnet ef migrations add DropUserName` produces an empty migration —
the model already has no `Name` — so write `migrationBuilder.DropColumn("name", "users")` into its
`Up()` by hand. Always read generated migrations before merging them.
:::

**Deploy 4 — contract.** No running code knows about `name` any more, so drop it:

```sql
ALTER TABLE users DROP COLUMN name;
```

This is the only irreversible step, and by now it is pure clean-up: nothing depends on it.

| Deploy | Migration (before rollout) | Code reads | Code writes | Safe to roll back to previous? |
|---|---|---|---|---|
| 1 | add `display_name` (nullable) | `name` | both | Yes — old code ignores the new column |
| 2 | backfill, enforce `display_name` NOT NULL, `name` DROP NOT NULL | `display_name` | both | Yes — `name` is still written |
| 3 | none | `display_name` | `display_name` | Yes — deploy 2 tolerates NULL `name` |
| 4 | DROP `name` | `display_name` | `display_name` | Yes (code is identical) |

Four deploys for a rename feels slow. With a pipeline that deploys several times a day it's an
afternoon, and you never once had a minute where a rollback was dangerous. That trade — more,
smaller, boring steps — is the whole philosophy of continuous delivery.

:::job title="What you'll see in a real codebase"
Teams encode this in review rules: "a migration PR may not also contain the code that depends on
it", "no `DropColumn` in the same release that removes the property", "big-table indexes use
`migrationBuilder.Sql(\"CREATE INDEX CONCURRENTLY …\", suppressTransaction: true)`". Many
also run the migration against a fresh copy of production-sized data in staging, timing how long
each statement holds locks. Expect a reviewer to ask "what happens if we roll back after this?"
on every migration PR — have the answer in the description.
:::

:::quiz id=pro-09-q3 xp=15
A PR contains one EF Core migration `RenameColumn("name", "display_name", "users")` and the code
change from `user.Name` to `user.DisplayName`. The pipeline runs migrations, then performs a
rolling update of 6 API pods. What happens?

- [ ] Nothing bad — EF Core renames the column atomically in a transaction
- [x] Between the migration and the end of the rollout, old pods query `name` and fail with "column does not exist"
- [ ] The new pods fail, because the migration runs after the rollout
- [ ] Only a rollback would fail; the deploy itself is fine
> The rename itself is atomic, but atomic isn't the problem — **timing** is. The migration runs first, so for the whole rollout the old pods (still mapping `Name` → `name`) hit a schema where `name` no longer exists. And a rollback would be just as broken, so the last option is half-right but misses the outage that's already happening. Use expand/contract: add the new column, dual-write, backfill, switch reads, then drop.
:::

### Code it: an expand/contract plan checker

:::challenge id=pro-09-c2 lang=ts xp=60
title: Reject unsafe migration orders
A migration plan is a list of steps, each `{ deploy, action }`, in the order they will happen.
`action` is one of, in this required order:

`'add-column'` → `'dual-write'` → `'backfill'` → `'switch-reads'` → `'stop-old-writes'` → `'drop-column'`

Write `checkPlan(steps)` that returns `null` for a safe plan, or a **string describing the first
problem**. The string must **start with the offending step's action followed by a colon**
(e.g. `"backfill: …"`); the rest of the text is up to you. Check the steps one by one, in list order:

1. A step whose `deploy` number is **smaller** than the previous step's is a problem (out of order).
2. An action that appeared **earlier in the list** is a problem (duplicate).
3. Every action except `'add-column'` needs the action **directly before it in the chain** to
   appear earlier in the list.
4. `'backfill'` must be in a **later deploy** than `'dual-write'` (old pods don't dual-write
   during the rollout). `'drop-column'` must be in a **later deploy** than `'stop-old-writes'`
   (old pods still use the column during the rollout). All other steps may share a deploy.

A plan may stop early (for example only `add-column`), and an empty plan is safe.

hint: Keep a `Map` from action to the deploy number it shipped in. "Appeared earlier" is `map.has(...)`.
hint: Because you check the direct predecessor for every step, the whole chain is enforced automatically.
hint: For rule 4, compare `map.get(predecessor) === step.deploy`.

```ts starter
type Action = 'add-column' | 'dual-write' | 'backfill' | 'switch-reads' | 'stop-old-writes' | 'drop-column'
type Step = { deploy: number; action: Action }

export function checkPlan(steps: Step[]): string | null {
  return null
}
```

```ts solution
type Action = 'add-column' | 'dual-write' | 'backfill' | 'switch-reads' | 'stop-old-writes' | 'drop-column'
type Step = { deploy: number; action: Action }

const CHAIN: Action[] = ['add-column', 'dual-write', 'backfill', 'switch-reads', 'stop-old-writes', 'drop-column']
const NEEDS_LATER_DEPLOY: Partial<Record<Action, Action>> = {
  backfill: 'dual-write',
  'drop-column': 'stop-old-writes',
}

export function checkPlan(steps: Step[]): string | null {
  const shipped = new Map<Action, number>()
  let lastDeploy = -Infinity
  for (const { deploy, action } of steps) {
    if (deploy < lastDeploy) return `${action}: deploy ${deploy} is listed after deploy ${lastDeploy}`
    lastDeploy = deploy
    if (shipped.has(action)) return `${action}: listed twice`
    const i = CHAIN.indexOf(action)
    const before = i > 0 ? CHAIN[i - 1] : undefined
    if (before && !shipped.has(before)) return `${action}: needs ${before} first`
    const wait = NEEDS_LATER_DEPLOY[action]
    if (wait && shipped.get(wait) === deploy) return `${action}: must ship in a later deploy than ${wait}`
    shipped.set(action, deploy)
  }
  return null
}
```

```ts tests
test('the four-deploy plan from the lesson is safe', () => {
  expect(checkPlan([
    { deploy: 1, action: 'add-column' },
    { deploy: 1, action: 'dual-write' },
    { deploy: 2, action: 'backfill' },
    { deploy: 2, action: 'switch-reads' },
    { deploy: 3, action: 'stop-old-writes' },
    { deploy: 4, action: 'drop-column' },
  ])).toBeNull()
})
test('one step per deploy is safe', () => {
  const names = ['add-column', 'dual-write', 'backfill', 'switch-reads', 'stop-old-writes', 'drop-column'] as const
  expect(checkPlan(names.map((action, i) => ({ deploy: i + 1, action })))).toBeNull()
})
test('empty and partial plans are safe', () => {
  expect(checkPlan([])).toBeNull()
  expect(checkPlan([{ deploy: 7, action: 'add-column' }])).toBeNull()
})
test('dual-write before the column exists is rejected', () => {
  expect(checkPlan([{ deploy: 1, action: 'dual-write' }])).toMatch(/^dual-write:/)
})
test('backfill in the same deploy as dual-write is rejected', () => {
  expect(checkPlan([
    { deploy: 1, action: 'add-column' },
    { deploy: 1, action: 'dual-write' },
    { deploy: 1, action: 'backfill' },
  ])).toMatch(/^backfill:/)
})
test('switching reads without a backfill is rejected', () => {
  expect(checkPlan([
    { deploy: 1, action: 'add-column' },
    { deploy: 1, action: 'dual-write' },
    { deploy: 2, action: 'switch-reads' },
  ])).toMatch(/^switch-reads:/)
})
test('dropping the column in the deploy that stops writing it is rejected', () => {
  expect(checkPlan([
    { deploy: 1, action: 'add-column' },
    { deploy: 1, action: 'dual-write' },
    { deploy: 2, action: 'backfill' },
    { deploy: 2, action: 'switch-reads' },
    { deploy: 3, action: 'stop-old-writes' },
    { deploy: 3, action: 'drop-column' },
  ])).toMatch(/^drop-column:/)
})
test('the "rename in one go" plan is rejected', () => {
  expect(checkPlan([
    { deploy: 1, action: 'add-column' },
    { deploy: 1, action: 'drop-column' },
  ])).toMatch(/^drop-column:/)
})
test('deploys listed out of order are rejected', () => {
  expect(checkPlan([
    { deploy: 2, action: 'add-column' },
    { deploy: 1, action: 'dual-write' },
  ])).toMatch(/^dual-write:/)
})
test('duplicates are rejected', () => {
  expect(checkPlan([
    { deploy: 1, action: 'add-column' },
    { deploy: 2, action: 'add-column' },
  ])).toMatch(/^add-column:/)
})
test('reports the FIRST problem', () => {
  expect(checkPlan([
    { deploy: 1, action: 'add-column' },
    { deploy: 1, action: 'switch-reads' },
    { deploy: 1, action: 'drop-column' },
  ])).toMatch(/^switch-reads:/)
})
```
:::

## Backwards-compatible API changes

The same "two versions at once" problem exists between your API and its clients — usually for
much longer than a rollout:

- A user's browser tab loaded the React bundle at 09:00 and keeps calling your API with that
  bundle's assumptions until they reload — maybe tomorrow.
- A mobile app version stays installed for **months**.
- Other teams' services call you on their own release schedule.

So treat every response and request shape as a contract. The rule of thumb: **adding is safe,
changing or removing is not.**

| Change | Safe? | Why |
|---|---|---|
| Add an optional response field | Yes | Old clients ignore unknown fields (if they're tolerant readers) |
| Add a new endpoint | Yes | Nobody calls it yet |
| Add an optional request field with a default | Yes | Old clients don't send it, the default applies |
| Add a new enum value in a response | **Careful** | A client with an exhaustive `switch` may crash or show nothing |
| Make an optional request field required | No | Old clients don't send it → 400 |
| Rename or remove a field | No | Old clients read `undefined` |
| Change a field's type or meaning (`price` in cents instead of euros) | No | Silent wrong data — the worst kind |

When you truly need to break the contract, use expand/contract again: add the new field next to the
old one, migrate clients, announce deprecation (the `Deprecation` and `Sunset` response headers are
standard for this), watch your logs until nobody uses the old field, then remove it. For big
changes, a new version (`/api/v2/orders`) runs side by side with v1.

On the client side, be a **tolerant reader**: ignore unknown fields, have a default branch for
unknown enum values, and don't fail validation on extra properties.

:::quiz id=pro-09-q4 xp=15
Which of these API changes can ship in a single deploy without breaking the React SPA bundles that
users already have open in their browsers? Select all that apply.

- [x] Adding `estimatedDelivery` (optional) to the `GET /orders/{id}` response
- [ ] Renaming `total` to `totalAmount` in the same response
- [x] Adding a new endpoint `GET /orders/{id}/invoice`
- [ ] Making the optional `couponCode` field of `POST /orders` required
- [ ] Changing `total` from euros (`12.5`) to cents (`1250`)
> Adding is safe: old bundles ignore the new field and never call the new endpoint. Renaming breaks old bundles that read `total`. Making a field required rejects requests from bundles that don't send it. The cents change is the most dangerous: nothing errors, old bundles simply show prices 100× too high — always add a new field (`totalCents`) instead of changing the meaning of an existing one.
:::

## Rollback vs roll-forward

When production breaks, you have three levers. Use the fastest safe one:

1. **Turn off the feature flag** — seconds, no deploy, only affects the new behaviour.
2. **Roll back** — redeploy the previous digest (`kubectl rollout undo`, or revert the GitOps
   commit, or shift canary weight to 0). Fast and well-tested — *if* the previous version still
   works with the current database and clients. Expand/contract is what makes this true.
3. **Roll forward** — fix the bug and push a new version through the pipeline. Necessary when
   rollback isn't safe (a migration already transformed data the old code can't read) or the
   bug is in data rather than code. Only as fast as your pipeline — one more reason to keep CI
   under 10 minutes.

:::warn title="Down migrations are rarely a real rollback"
EF Core generates `Down()` methods, and it's tempting to see them as an undo button. In production
they usually aren't: `Down()` for "add column" is "drop column", which deletes everything written
to it since the deploy. Plan for rollback of **code** on top of a **forward-only** schema; keep
`Down()` for local development.
:::

:::quiz id=pro-09-q5 xp=15
Deploy 57 split `customers.address` (one text field) into `street`, `city` and `zip`. Its migration
parsed every address into the new columns and **dropped** `address` in the same deploy. An hour
later you find that the new checkout page has a bug. What do you do?

- [ ] `kubectl rollout undo` — rollback is always the fastest fix
- [ ] Run the EF Core `Down()` migration, then roll back
- [x] Roll forward: fix the checkout bug and ship deploy 58 — the old code can't run on a schema without `address`
- [ ] Restore last night's database backup and roll back
> Rollback is fastest *only if the previous version works on today's schema*. Deploy 56 reads `address`, which no longer exists, so a rollback turns a checkout bug into a full outage. `Down()` would recreate an empty `address` column — the data is gone. Restoring a backup throws away an hour of real orders. Roll forward, and next time use expand/contract so the drop happens in a later deploy and rollback stays available.
:::

## Health-gated deploys and automatic rollback

A deploy should not be "done" when `kubectl apply` returns — that only means the API server
accepted the YAML. It's done when the new version has **proven** it's healthy. Gates, from cheap
to thorough:

1. **Readiness probes** — Kubernetes only sends traffic to pods that report ready, and a rolling
   update won't continue past pods that never become ready (see
   **Config, Secrets, Probes & Resources**). Make `/health/ready` check what the app really needs
   (database reachable, migrations applied), not just "process is alive".
2. **Rollout status with a deadline** — `kubectl rollout status deploy/api --timeout=120s`
   turns a stuck rollout (bad image tag, crash loop) into a failed pipeline step.
   `progressDeadlineSeconds` does the same inside the cluster.
3. **Smoke tests** — a handful of real requests against the deployed environment: `GET /health`,
   log in as a synthetic user, load one key page. Check the **version** endpoint returns the
   commit you just deployed — otherwise you might be testing the old pods.
4. **Metric analysis** — the canary rules above, over 5–30 minutes of real traffic.

If any gate fails, the pipeline **rolls back on its own** — nobody should need to wake up to
press a button the computer could have pressed.

```yaml
- name: Deploy
  id: deploy
  run: kubectl set image deployment/api api=ghcr.io/acme/shop-api@${{ needs.build.outputs.digest }}
- name: Wait for rollout (health gate)
  id: gate
  run: kubectl rollout status deployment/api --timeout=120s
- name: Smoke test
  id: smoke
  run: ./deploy/smoke.sh "${GITHUB_SHA::7}"
- name: Roll back on failure
  if: failure() && steps.deploy.outcome != 'skipped'
  run: |
    kubectl rollout undo deployment/api
    kubectl rollout status deployment/api --timeout=120s
```

Normally a step is skipped once an earlier step has failed; an `if:` containing `failure()`
overrides that, because `failure()` is true when any earlier step in the job failed. Steps that
never ran have `outcome == 'skipped'`, so checking `steps.deploy.outcome` avoids "rolling back"
when the job failed before it touched the cluster (say, the login step). Note the job **stays
red** after a successful rollback — that's correct: the deploy failed, and someone needs to know.

`kubectl rollout undo` goes back to the previous ReplicaSet revision of *that* Deployment. It does
not undo migrations, ConfigMap changes or anything else the job did — which is one more reason the
schema must stay compatible with the previous version.

:::pro title="GitOps changes the rollback mechanics"
With Argo CD or Flux, the cluster follows Git. A `kubectl rollout undo` is reverted by the next
sync, so roll back by reverting the commit that bumped the image digest — and let tools like Argo
Rollouts run the canary analysis and automatic abort inside the cluster.
:::

## OIDC: deploying without long-lived secrets

The classic way to let a pipeline deploy is to create a cloud access key and paste it into GitHub
secrets. That key never expires, works from anywhere, is often over-privileged, and when it leaks
(a debug `echo`, a compromised action, a former employee's laptop) it works for an attacker too.
Rotating it is manual, so it never happens.

**OpenID Connect (OIDC)** replaces the stored key with a trust relationship:

```text
 GitHub job ──(1) "give me an ID token"──► GitHub OIDC provider
            ◄──(2) signed JWT: iss=token.actions.githubusercontent.com
                                sub=repo:acme/shop:environment:production
                                aud=sts.amazonaws.com (or api://AzureADTokenExchange)
            ──(3) "here's my JWT, give me credentials"──► cloud (AWS STS / Entra ID)
                   cloud checks: signature, issuer, audience, and that `sub` matches the trust policy
            ◄──(4) short-lived credentials (≈1 hour), scoped to one role
```

Nothing secret is stored in GitHub. The token is minted per job, expires quickly, and the cloud
only accepts it if it comes from **this repo**, and (if you configure it) **this environment**.

```yaml
permissions:
  id-token: write        # allow the job to request the OIDC token
  contents: read

jobs:
  deploy:
    environment: production
    runs-on: ubuntu-latest
    steps:
      # Azure: a federated credential on an Entra app registration
      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}        # identifiers, not secrets
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}
      # …or AWS: an IAM role whose trust policy accepts GitHub's OIDC provider
      # - uses: aws-actions/configure-aws-credentials@v4
      #   with:
      #     role-to-assume: arn:aws:iam::123456789012:role/shop-deploy-prod
      #     aws-region: eu-central-1
```

The AWS trust policy condition that does the real work:

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:acme/shop:environment:production"
  }
}
```

The `sub` claim depends on the job: `repo:ORG/REPO:environment:NAME` when the job declares an
environment, `repo:ORG/REPO:ref:refs/heads/main` for a push to `main` without one,
`repo:ORG/REPO:pull_request` for PRs. Binding the production role to the **production
environment** means the cloud enforces your GitHub approval rules: no approval, no environment,
no credentials.

:::warn title="Check the exact claim format and action versions"
Organisations and repos can **customise the `sub` template** (for example to include
`job_workflow_ref` or numeric repo/owner IDs), and the cloud-side setup differs per provider
(AWS IAM OIDC provider + role trust policy; Entra ID federated credential with an "Entity type" of
Environment/Branch/PR; GCP Workload Identity Federation). Before writing a trust policy, read
GitHub's "About security hardening with OpenID Connect" and your cloud's guide, and decode a real
token from a test run rather than guessing. Action major versions (`azure/login@v2`,
`aws-actions/configure-aws-credentials@v4`, …) move on — check each action's README for the current one.
:::

:::warn title="The wildcard that gives your cloud away"
A trust condition like `repo:acme/*` or `StringLike … "repo:acme/shop:*"` lets **any branch,
any PR workflow, or any repo in the org** assume the production role. Scope `sub` exactly, use
separate roles per environment, and give the production role only the permissions a deploy needs.
:::

:::quiz id=pro-09-q6 xp=15
You moved the production deploy job to `environment: production` (to get approvals). Since then
`aws-actions/configure-aws-credentials` fails with "Not authorized to perform
sts:AssumeRoleWithWebIdentity". The role's trust policy requires
`sub = repo:acme/shop:ref:refs/heads/main`. What's wrong?

- [ ] The job lost the `id-token: write` permission when you added an environment
- [x] With an environment, the token's `sub` becomes `repo:acme/shop:environment:production`, which the trust policy doesn't accept
- [ ] OIDC doesn't work with environments that have required reviewers
- [ ] The OIDC token expired while waiting for approval
> When a job references an environment, GitHub puts the environment into `sub` instead of the ref. Update the trust policy to `repo:acme/shop:environment:production` — which is better anyway, because now only approved production jobs can assume the role. Adding an environment doesn't change `permissions`, environments and OIDC work together, and the token is only requested once the job actually starts (after approval).
:::

## Approvals and environments

GitHub **environments** (introduced in **CI with GitHub Actions**) are where the human side of
delivery lives. For `production`, configure in *Settings → Environments*:

- **Required reviewers** — the job pauses with "Waiting for review" until a listed person or team
  approves. Turn on **Prevent self-review** so the person who pushed can't approve their own deploy.
- **Deployment branches and tags** — only `main` (or `v*` tags) may deploy here, so a feature
  branch can't target production even if someone edits the workflow.
- **Wait timer** — e.g. 15 minutes after staging, giving dashboards time to show problems.
- **Environment secrets and variables** — production values are only exposed to jobs that passed
  the rules above.

Add a `concurrency` group so two deploys never race on the same environment:

```yaml
concurrency:
  group: deploy-production
  cancel-in-progress: false   # never kill a deploy halfway; queue the next one instead
```

One subtlety: a concurrency group holds at most **one running and one pending** run. If a third
run arrives, the older *pending* one is cancelled — fine for deploys (the newest commit contains
the older one's changes), surprising if you expected a full queue.

:::job title="Approvals are a safety net, not the safety"
On your first week you'll probably find a "Review deployments" button and a rota of who may press
it. Mature teams treat that click as a **business** decision ("ship before the marketing launch?"),
not a technical check — the technical checks are the automated gates. An approver who can't see
what's in the release just adds latency; that's what good release notes are for.
:::

## Versions, changelogs and release notes

**Semantic Versioning** (`MAJOR.MINOR.PATCH`) is a promise to the people who *depend* on you:

- **PATCH** `1.4.2 → 1.4.3` — bug fixes, no API change.
- **MINOR** `1.4.3 → 1.5.0` — new, backwards-compatible features.
- **MAJOR** `1.5.0 → 2.0.0` — a breaking change; consumers must act.
- Pre-release `2.0.0-rc.1` sorts before `2.0.0`; versions `0.x` promise nothing.

SemVer matters most for **libraries, SDKs, Helm charts and public APIs**. A web app that users only
reach through a browser often uses the commit SHA or a date (`2026.11.05.3`) — there is no one to
make a compatibility promise to, and the digest is the real identity anyway.

**Conventional Commits** (`feat: add invoice download`, `fix: round VAT per line`,
`feat!: remove v1 orders endpoint` or a `BREAKING CHANGE:` footer) make versions computable:
`fix` → PATCH, `feat` → MINOR, `!`/`BREAKING CHANGE` → MAJOR. **release-please** reads the commits
since the last release, picks the next version, updates `CHANGELOG.md` and opens a "release PR";
merging that PR creates the git tag and the GitHub Release. **semantic-release** does the same
from commits but publishes directly, without a PR. **Changesets** (popular in JS monorepos) takes
a different route: instead of parsing commit messages, each PR adds a small `.changeset/*.md` file
saying which packages bump and how, and a "Version Packages" PR collects them.

Two documents, two audiences:

| | Changelog | Release notes |
|---|---|---|
| Reader | Developers, integrators | Users, support, sales |
| Content | Every notable change, grouped Added/Changed/Fixed/Removed | What's new and why it matters, screenshots, what to do |
| Tone | Precise, technical | Benefit-focused, plain language |
| Example | `Fixed: VAT rounding on multi-line invoices (#412)` | "Invoices now match your accounting software to the cent." |

:::quiz id=pro-09-q7 xp=10
Your team publishes `@acme/shop-client` (an npm SDK) at `3.2.1`. The next release adds an optional
`locale` parameter to `getProducts()` **and** removes the deprecated `getProductsLegacy()`. What is
the correct next version?

- [ ] `3.2.2`
- [ ] `3.3.0`
- [x] `4.0.0`
- [ ] `3.3.0-breaking`
> The highest-impact change wins. Adding an optional parameter alone would be a MINOR bump (`3.3.0`), which is the tempting answer — but removing a public function breaks anyone who still calls it, and breaking changes require a MAJOR bump. Pre-release labels like `-breaking` don't signal compatibility; they mark unstable versions.
:::

## DORA metrics: is any of this working?

The **DORA** research program (DevOps Research and Assessment, now part of Google Cloud) studied
thousands of teams and found four metrics that predict both delivery performance and business
outcomes:

| Metric | Question | Strong teams (roughly) |
|---|---|---|
| **Deployment frequency** | How often do we deploy to production? | On demand, many times a day |
| **Lead time for changes** | Commit → running in production, how long? | Less than a day |
| **Change failure rate** | What % of deploys cause an incident, rollback or hotfix? | ~5 % or lower |
| **Failed deployment recovery time** | When a deploy breaks things, how fast are we back? | Less than an hour |

The first two measure **throughput**, the last two **stability**. DORA's headline finding is that
they are **not a trade-off**: the teams that deploy most often also fail least and recover fastest,
because small batches are easier to test, review and undo. (Recent DORA reports also track
**rework rate** — the share of deploys that are unplanned fixes.)

How the techniques in this lesson move them:

- Build once + automated gates → shorter **lead time**.
- Small PRs + feature flags + trunk-based development → higher **deployment frequency**.
- Expand/contract, canaries, compatible APIs → lower **change failure rate**.
- Automatic rollback, flags as kill switches → shorter **recovery time**.

:::warn title="Goodhart's law applies"
"When a measure becomes a target, it ceases to be a good measure." Rank teams by deployment
frequency and you'll get empty deploys; punish change failures and people stop reporting them.
Use DORA metrics for a team to see its own trend, not to compare teams or rate individuals.
:::

:::quiz id=pro-09-q8 xp=15
A team deploys once a month in a big, carefully tested release. Management wants fewer incidents
and proposes moving to one release per quarter "so there's more time to test". Based on DORA's
findings, what is the most likely outcome?

- [ ] Fewer incidents — more testing time always lowers the change failure rate
- [x] Bigger batches: each release contains more changes, so failures become more likely, harder to diagnose and slower to recover from
- [ ] No change — deployment frequency and stability are unrelated
- [ ] Faster lead time, because work is planned further ahead
> Stability and throughput move **together**. A quarterly release bundles three months of changes; when something fails, you must find which of hundreds of changes did it, and rollback discards all of them. Lead time gets worse (a change waits up to three months). The tempting "more testing time" ignores that the risk grows with the batch size faster than extra testing can catch it. The path to fewer incidents is smaller, more frequent, better-gated deploys.
:::

## Lab: a gated deploy with approval, smoke test and automatic rollback

:::lab id=pro-09-lab1 xp=100
title: Staging → approval → production, with a rollback that runs itself
You'll build a real GitHub Actions pipeline that deploys to two **environments**, pauses for your
approval before production, health-gates the rollout, smoke-tests the deployed version, and rolls
back automatically when you ship a broken release on purpose.

To keep it free and self-contained, each job creates a throw-away **kind** cluster on the runner as
a stand-in for the real one and first deploys a `baseline` version to play "what's live right now".
In a real pipeline, those two steps are replaced by an OIDC login (`azure/login`,
`aws-actions/configure-aws-credentials`) and `kubectl` against your actual cluster — everything
after them stays the same.

:::info title="You need"
A GitHub account, `git`, and the GitHub CLI (`gh auth login` done). The repository must be
**public**: required reviewers on environments are free for public repos, but for private repos
they need a paid plan (at the time of writing, GitHub Enterprise — check GitHub's "Managing
environments for deployment" docs for your plan).
:::

**1. Create the repo**

```bash
mkdir shipping-safely && cd shipping-safely
git init -b main
mkdir -p deploy .github/workflows
```

**2. The app manifest** — `deploy/app.yaml`. `http-echo` answers every request with the text we
give it, so the response tells us exactly which version is serving.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  revisionHistoryLimit: 5
  progressDeadlineSeconds: 60
  selector:
    matchLabels:
      app: web
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0        # never drop below 2 ready pods, even if the new version is broken
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: __IMAGE__
          args: ["-text=version=__VERSION__"]
          ports:
            - containerPort: 5678
          readinessProbe:
            httpGet:
              path: /
              port: 5678
            periodSeconds: 2
---
apiVersion: v1
kind: Service
metadata:
  name: web
spec:
  selector:
    app: web
  ports:
    - port: 80
      targetPort: 5678
```

**3. The deploy script** — `deploy/deploy.sh`

```bash
#!/usr/bin/env bash
# usage: deploy/deploy.sh <version> [image]
set -euo pipefail
VERSION="$1"
IMAGE="${2:-hashicorp/http-echo:1.0}"
sed -e "s|__VERSION__|${VERSION}|g" -e "s|__IMAGE__|${IMAGE}|g" deploy/app.yaml | kubectl apply -f -
kubectl annotate deployment/web kubernetes.io/change-cause="version ${VERSION} (${IMAGE})" --overwrite
echo "applied version=${VERSION} image=${IMAGE}"
```

**4. The smoke test** — `deploy/smoke.sh`. It checks that the service answers **and** that it
answers with the version we expect.

```bash
#!/usr/bin/env bash
# usage: deploy/smoke.sh <expected-version>
set -euo pipefail
EXPECTED="version=$1"
kubectl port-forward svc/web 8080:80 >/dev/null 2>&1 &
PF_PID=$!
trap 'kill $PF_PID 2>/dev/null || true' EXIT

body=""
for _ in $(seq 1 20); do
  body="$(curl -fsS http://localhost:8080/ 2>/dev/null || true)"
  [[ -n "$body" ]] && break
  sleep 1
done

if [[ "$body" == "$EXPECTED" ]]; then
  echo "smoke OK: $body"
else
  echo "smoke FAILED: expected '$EXPECTED', got '${body:-<no response>}'"
  exit 1
fi
```

```bash
chmod +x deploy/deploy.sh deploy/smoke.sh
```

**5. The workflow** — `.github/workflows/deploy.yml`

```yaml
name: deploy

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      break_prod:
        description: Ship a broken image to production (practise the rollback)
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  staging:
    runs-on: ubuntu-latest
    environment:
      name: staging
    steps:
      - uses: actions/checkout@v5
      - name: Create stand-in cluster
        uses: helm/kind-action@v1
      - name: Simulate what is already live
        run: |
          ./deploy/deploy.sh baseline
          kubectl rollout status deployment/web --timeout=90s
      - name: Deploy this commit
        id: deploy
        run: ./deploy/deploy.sh "${GITHUB_SHA::7}"
      - name: Wait for rollout (health gate)
        run: kubectl rollout status deployment/web --timeout=120s
      - name: Smoke test
        run: ./deploy/smoke.sh "${GITHUB_SHA::7}"
      - name: Roll back on failure
        if: failure() && steps.deploy.outcome != 'skipped'
        run: |
          kubectl rollout undo deployment/web
          kubectl rollout status deployment/web --timeout=90s
          ./deploy/smoke.sh baseline

  production:
    needs: staging
    runs-on: ubuntu-latest
    environment:
      name: production
    env:
      IMAGE: ${{ inputs.break_prod && 'hashicorp/http-echo:1.0-typo' || 'hashicorp/http-echo:1.0' }}
    steps:
      - uses: actions/checkout@v5
      - name: Create stand-in cluster
        uses: helm/kind-action@v1
      - name: Simulate what is already live
        run: |
          ./deploy/deploy.sh baseline
          kubectl rollout status deployment/web --timeout=90s
      - name: Deploy this commit
        id: deploy
        run: ./deploy/deploy.sh "${GITHUB_SHA::7}" "$IMAGE"
      - name: Wait for rollout (health gate)
        run: kubectl rollout status deployment/web --timeout=120s
      - name: Smoke test
        run: ./deploy/smoke.sh "${GITHUB_SHA::7}"
      - name: Roll back on failure
        if: failure() && steps.deploy.outcome != 'skipped'
        run: |
          kubectl rollout undo deployment/web
          kubectl rollout status deployment/web --timeout=90s
          ./deploy/smoke.sh baseline
          kubectl rollout history deployment/web
          echo "### Rolled back to baseline" >> "$GITHUB_STEP_SUMMARY"
```

**6. Push and set up the environments**

```bash
git add .
git commit -m "ci: gated deploy with smoke test and rollback"
gh repo create shipping-safely --public --source=. --push
```

The push starts a run right away; the first one may finish without a pause, because the
`production` environment is created on the fly without rules. (If you set up the rules below
quickly enough that this first run stops at "Waiting", approve or cancel it before step 7 — the
`concurrency` group keeps new runs pending behind it.) Now add the rules in the browser:
**Settings → Environments → production**:

- **Required reviewers**: add yourself. Leave *Prevent self-review* **off** (you're the only
  person; on a team you'd turn it on).
- **Deployment branches and tags**: *Selected branches and tags* → add `main`.

**7. A green deploy with approval**

```bash
gh workflow run deploy.yml
gh run watch
```

`staging` runs and passes; `production` shows **Waiting** — open the run in the browser
(`gh run view --web`), click **Review deployments**, tick *production*, **Approve and deploy**.
Expected in the production job's log:

```text
applied version=3f9c2ab image=hashicorp/http-echo:1.0
deployment "web" successfully rolled out
smoke OK: version=3f9c2ab
```

and *Roll back on failure* is shown as skipped.

**8. A broken production deploy that rolls itself back**

```bash
gh workflow run deploy.yml -f break_prod=true
gh run watch
```

Approve again. This time the health gate fails, because the image tag doesn't exist:

```text
applied version=3f9c2ab image=hashicorp/http-echo:1.0-typo
Waiting for deployment "web" rollout to finish: 1 out of 2 new replicas have been updated...
error: deployment "web" exceeded its progress deadline
```

The smoke test is skipped, and the rollback step runs:

```text
deployment.apps/web rolled back
deployment "web" successfully rolled out
smoke OK: version=baseline
```

The run ends **red** with "Rolled back to baseline" in the summary — the failed deploy is visible,
but users kept being served by the two baseline pods the whole time (`maxUnavailable: 0`).

**9. Think it through.** Change the production job so the image is fine but the smoke test expects
the wrong version (e.g. `./deploy/smoke.sh wrong`). Push, approve, and confirm the rollout passes,
the smoke test fails, and the rollback runs — the second gate catches what the first can't.
Revert the change afterwards.

:::tip title="Make it real later"
Swap the two stand-in steps for an OIDC login to a real cluster, replace `deploy.sh` with
`kubectl set image deployment/web web=ghcr.io/you/app@sha256:…` (the digest from your CI build),
and you have a production-grade pipeline.
:::

- [ ] The `production` job paused for my approval, and only ran after I clicked **Approve and deploy**
- [ ] A normal run logged `smoke OK: version=<my short SHA>` and skipped the rollback step
- [ ] With `break_prod=true` the health gate failed and the rollback ended with `smoke OK: version=baseline`
- [ ] The wrong-version experiment showed the smoke test catching a problem the rollout status missed
- [ ] I can explain why the rollback run still ends red
:::

:::cards id=pro-09-cards1 xp=15 title="Shipping safely"
Q: Continuous Delivery vs Continuous Deployment?
A: Delivery: every green commit *can* go to production (a human or schedule decides when).
   Deployment: every green commit *does* go to production automatically.
Q: Why promote by digest instead of rebuilding per environment?
A: The digest is the exact tested bytes. A rebuild can pull different base images or dependencies,
   so production would run something never tested. Rollback = previous digest.
Q: Deploy vs release?
A: Deploy = code is running on servers. Release = users experience it. Flags and traffic shifting separate them.
Q: Which strategies run two versions at the same time?
A: Rolling (during the rollout), blue-green (briefly), canary (minutes to hours), dark launch (code
   on, behaviour per user). Only Recreate never does — at the cost of downtime.
Q: The golden rule for a migration?
A: It must work with the code currently running AND the code being deployed — and the previous code
   must still work on it, so rollback stays safe.
Q: The expand/contract steps for a column rename?
A: Add the new column (nullable) → dual-write → backfill (in a later deploy) → switch reads →
   stop writing the old column (make it nullable first) → drop it in a later deploy.
Q: Safe API changes?
A: Additive ones: optional response fields, new endpoints, optional request fields with defaults.
   Renames, removals, new required fields and changed meanings break old clients.
Q: When must you roll forward instead of rolling back?
A: When the previous version can't run on the current schema or data (e.g. a column it reads was dropped).
Q: Name four deploy gates from cheap to thorough.
A: Readiness probes → `rollout status` with a timeout → smoke tests (incl. version check) → canary metric analysis.
Q: What does OIDC replace in a deploy pipeline, and what's in the `sub` claim?
A: Long-lived cloud keys. `sub` identifies the caller, e.g. `repo:acme/shop:environment:production`;
   the cloud's trust policy must match it exactly.
Q: SemVer bump for "new optional parameter + removed function"?
A: MAJOR — the breaking change wins.
Q: The four DORA metrics?
A: Deployment frequency, lead time for changes, change failure rate, failed deployment recovery time.
   Throughput and stability improve together.
:::

## Recap

- **Continuous Delivery** makes every green commit releasable; **Continuous Deployment** releases
  it automatically. Both aim for small, boring, reversible releases.
- **Build once, promote the same digest**; only config differs per environment. Watch out for
  build-time frontend variables.
- **Deploy ≠ release**: traffic shifting and feature flags let you deploy code before users see it.
- Strategies trade capacity, blast radius and undo speed: **recreate** (downtime), **rolling**
  (default), **blue-green** (instant switch, 100 % exposure), **canary** (small slice, metric-driven),
  **dark launch** (per-user flags). All zero-downtime strategies run **two versions at once**.
- **Canary analysis** compares against the baseline, waits for enough data, ignores noise, and
  includes latency.
- **Migrations** run once, before the rollout, and must be compatible with old and new code. Use
  **expand/contract**: add nullable → dual-write → backfill → switch reads → stop old writes →
  drop later. Use `lock_timeout`, batched backfills, `NOT VALID` constraints and concurrent indexes.
- **APIs**: additive changes are safe; renames, removals, new required fields and changed meanings
  are not. Be a tolerant reader on the client.
- Prefer **flag off → rollback → roll forward**; rollback is only safe if the schema stayed
  compatible. Down migrations are not a production undo.
- **Health-gate** every deploy (readiness, `rollout status --timeout`, smoke tests with a version
  check, metrics) and **roll back automatically**.
- **OIDC** replaces stored cloud keys with short-lived, scoped credentials; scope the `sub` claim
  to the environment.
- **Environments** add approvals, branch rules and scoped secrets; `concurrency` prevents racing deploys.
- **SemVer** is a promise to consumers; **Conventional Commits** automate versions and changelogs;
  release notes speak to users.
- **DORA**: deployment frequency, lead time, change failure rate, recovery time — speed and
  stability rise together with smaller batches.
