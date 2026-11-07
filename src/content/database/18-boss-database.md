---
id: db-18
title: "Boss Fight: The Studio Database"
level: expert
minutes: 95
xp: 400
summary: Eight escalating phases on the studio dataset — wallets, the longest story branch, a queue health dashboard, API-shaped jsonb, an analytics report, a zero-downtime migration, a transactional job claim and a fast, tenant-safe feed.
---

You've reached the end of the Database region. The studio team has a list of tickets nobody else
wants, and they've landed on your desk. Each ticket is a **phase** of this boss fight. They get
harder as you go, and each one combines several things you've learned: CTEs, recursive queries,
window functions, `FILTER`, jsonb building, migrations, the job-queue claim, and finally
indexing, keyset pagination and row-level security.

How to fight:

- **Read the whole ticket first.** The column list, the column *order* and the sort order are
  part of the spec. The grader compares your last result's values position by position (column
  names don't matter, but a missing or extra column fails), like a contract test on an API.
- **Build in steps.** Write the first CTE, run it, look at the output, then add the next one.
  Whenever you're unsure, temporarily replace the final `SELECT` with `SELECT * FROM my_cte`.
- **Check the edge rows.** Every ticket hides at least one awkward row: a user with no ledger
  entries, a tie, a kind with nothing queued, a project with no members. Those are where most
  wrong answers come from, in the game and in production.
- **Hints are there for a reason**, but try for a few minutes without them first.

| Phase | Main tools | Refresher |
|---|---|---|
| 1 Wallets | CTE, `LEFT JOIN`, `FILTER`, `dense_rank()` | Aggregates, JOINs, Window Functions |
| 2 Longest branch | recursive CTE, top-1-per-group | CTEs, Window Functions |
| 3 Queue dashboard | `GROUP BY` + `FILTER`, `nullif`, intervals | Expressions, Aggregates |
| 4 API payload | `jsonb_build_object`, ordered `jsonb_agg` | jsonb |
| 5 Analytics | recursive CTE + jsonb + `rank()` | CTEs, Window Functions, jsonb |
| 6 Migration | `ALTER TABLE`, `CHECK`, partial index | Tables & Constraints, Indexes, Production |
| 7 Final claim | `SKIP LOCKED`, data-modifying CTE | CTEs, Job Queues |
| 8 Tenant-safe feed | keyset pagination, composite index, RLS policy | Indexes, Performance Tuning, Production |

As a reminder, here's the studio schema:

```text
users          (id, email, display_name, plan, created_at)
projects       (id, owner_id → users, title, doc jsonb, version, published, created_at, updated_at)
project_members(project_id → projects, user_id → users, role 'editor'|'viewer')
clips          (id, project_id → projects, parent_clip_id → clips, title, choice_label, duration_ms)
render_jobs    (id, project_id → projects, kind, status, attempts, worker, created_at, started_at, finished_at)
credit_ledger  (id, user_id → users, delta, reason, created_at)
```

:::info title="The fixed clock"
Some tickets talk about "now". Real code would use `now()`, but graded results must be
deterministic, so whenever a ticket says *now*, use the literal
`timestamptz '2025-07-10 17:00+00'`.
:::

## Phase 1 — The wallets

> **Ticket STU-311:** *Support needs a wallet overview for every user — including users who
> never spent anything and brand-new sign-ups who have no ledger entries at all. Rank them by
> balance so we can spot whales and empty wallets.*

A wallet isn't stored anywhere: `credit_ledger` is an append-only list of `+` and `-` movements,
and the balance is their sum. That's the standard design for money-like data (you can always
explain *why* a balance is what it is). So the plan is:

1. **Aggregate the ledger per user** in a CTE: `sum(delta)` for the balance, a `FILTER`ed sum
   for the spending, `max(created_at)` for the last activity.
2. **`LEFT JOIN` that CTE to `users`.** The ticket is "every user", so `users` drives the query.
   An inner `JOIN` would silently drop anyone without ledger rows — exactly the new sign-ups
   support cares about.
3. **Rank on top.** Window functions are evaluated **after** `FROM`/`WHERE`/`GROUP BY`, so they
   can see aggregated values. That's how you rank by a sum.

Why `dense_rank()` and not `rank()` or `row_number()`? With balances 500, 450, 450, 190:
`row_number()` gives 1, 2, 3, 4 (ties broken arbitrarily), `rank()` gives 1, 2, 2, 4 (a gap after
the tie), and `dense_rank()` gives 1, 2, 2, 3 (no gaps). Support wants "the 3rd-richest
*level*", so it's `dense_rank()`.

**Common traps:** `sum()` over zero rows is `NULL`, not 0, so the joined-in columns need
`coalesce(…, 0)`. And rank on the *coalesced* balance too, or the `NULL` balances sort first
in a `DESC` order (Postgres sorts NULLs as larger than any value).

:::sql id=db-18-sql1 db=studio ordered=true xp=60
title: Phase 1 — Wallets
A new user, **Noa** (`id = 7`, plan `free`), signed up yesterday and has **no ledger entries
yet** (the playground adds her for this phase). Return one row per user, Noa included, with:

1. `display_name`
2. `plan`
3. `balance` — sum of all their `credit_ledger.delta` (`0` if they have no entries)
4. `spent` — the total of their **negative** deltas as a positive number (`0` if none)
5. `last_activity` — the **date** (`::date`) of their latest ledger entry (`NULL` if they have no entries)
6. `wealth_rank` — `dense_rank()` by `balance` (the coalesced one), highest first

Sort by `wealth_rank`, then `display_name`.

hint: Group the ledger in a CTE (`GROUP BY user_id`), then `LEFT JOIN` it to `users` so Noa survives.
hint: `coalesce(sum(-delta) FILTER (WHERE delta < 0), 0)` gives the spent amount.
hint: `dense_rank() OVER (ORDER BY coalesce(b.balance, 0) DESC)` — a window over the joined result.

```sql setup
INSERT INTO users (id, email, display_name, plan, created_at)
VALUES (7, 'noa@studio.dev', 'Noa', 'free', '2025-07-09 10:00+00');
```

```sql starter
SELECT u.display_name, u.plan, sum(l.delta) AS balance
FROM users u
JOIN credit_ledger l ON l.user_id = u.id
GROUP BY u.id, u.display_name, u.plan
ORDER BY balance DESC;
```

```sql solution
WITH bal AS (
  SELECT user_id,
         sum(delta) AS balance,
         coalesce(sum(-delta) FILTER (WHERE delta < 0), 0) AS spent,
         max(created_at)::date AS last_activity
  FROM credit_ledger
  GROUP BY user_id
)
SELECT u.display_name,
       u.plan,
       coalesce(b.balance, 0) AS balance,
       coalesce(b.spent, 0)   AS spent,
       b.last_activity,
       dense_rank() OVER (ORDER BY coalesce(b.balance, 0) DESC) AS wealth_rank
FROM users u
LEFT JOIN bal b ON b.user_id = u.id
ORDER BY wealth_rank, u.display_name;
```
:::

:::quiz id=db-18-q4 xp=15
Suppose Jonas gets a top-up so that Mara and Jonas both have a balance of `450`, behind Kai's
`500`. Omar is next with `130`. With `dense_rank()`, what `wealth_rank` does **Omar** get — and
what would `rank()` have given him?

- [ ] `dense_rank()` 4, `rank()` 3
- [x] `dense_rank()` 3, `rank()` 4
- [ ] Both give 3
- [ ] Both give 4
> The ranks are Kai 1, Mara 2, Jonas 2. `dense_rank()` continues with the next integer, so Omar
> is **3**. `rank()` counts how many rows are ahead of you (three) and adds one, so it leaves a
> gap and Omar is **4**. Both functions give tied rows the same rank; only `row_number()` would
> split the tie (and arbitrarily, unless you add a tie-breaker to its `ORDER BY`).
:::

## Phase 2 — The longest branch

> **Ticket STU-327:** *Creators want to know the "director's cut" of every story: the single
> longest route from the first clip to an ending. Show it on the project card.*

Each project's clips form a **tree**: one root clip (`parent_clip_id IS NULL`), and every other
clip points to the clip before it. A *route* is a walk from the root down to an **ending**, a
clip that no other clip points to. SQL can't follow an unknown number of parent links with plain
joins, which is why this needs a **recursive CTE**:

- The **anchor** part selects the roots and starts the running values: `depth = 0`,
  `path = title`, `total_ms = duration_ms`.
- The **recursive** part joins `clips` to the rows found so far (`c.parent_clip_id = t.id`) and
  extends them: `depth + 1`, `path || ' > ' || title`, `total_ms + duration_ms`. Postgres repeats
  it until a step adds no rows.

The result has one row per *clip*, each carrying the route that leads to it. Keep only the
endings (`NOT EXISTS` a child), then do a **top-1-per-group**: number each project's endings
with `row_number() OVER (PARTITION BY project_id ORDER BY total_ms DESC, path)` and keep row 1.

Be careful with ties: *Safety Training 2025* has two endings of exactly the same length. Without
the `path` tie-breaker in the window's `ORDER BY`, Postgres may return either one, and may pick
a different one tomorrow. A deterministic tie-breaker is what makes the result testable.

:::tip title="Why walking from the roots always terminates"
Each clip has exactly one parent, so a clip that sits in a cycle (A → B → A) has all its
ancestors inside that cycle too, and it can never be reached from a root. Starting the
recursion at `parent_clip_id IS NULL` therefore can't loop forever on bad data. If you ever walk
a graph *without* that guarantee (many-to-many links, or starting from an arbitrary node), add
PostgreSQL's `CYCLE id SET is_cycle USING route` clause (PG 14+) or a depth limit.
:::

:::sql id=db-18-sql2 db=studio ordered=true xp=80
title: Phase 2 — Director's cut
For each project that has clips, return its **longest root-to-ending route**:

1. `title` — the project title
2. `path` — clip titles from root to ending, joined with `' > '`
3. `depth` — number of steps from the root (root alone = 0)
4. `total_ms` — sum of `duration_ms` along the route

If two routes of a project are equally long, choose the one whose `path` sorts first. Sort the
output by project `id`.

hint: Recursive CTE from `WHERE parent_clip_id IS NULL`, carrying `project_id`, `depth`, `path`, `total_ms`.
hint: Ending = `NOT EXISTS (SELECT 1 FROM clips k WHERE k.parent_clip_id = tree.id)`.
hint: `row_number() OVER (PARTITION BY project_id ORDER BY total_ms DESC, path)` and keep `rn = 1` (or use `DISTINCT ON`).

```sql starter
WITH RECURSIVE tree AS (
  SELECT id, project_id, 0 AS depth, title::text AS path, duration_ms AS total_ms
  FROM clips
  WHERE parent_clip_id IS NULL
)
SELECT p.title, t.path, t.depth, t.total_ms
FROM tree t
JOIN projects p ON p.id = t.project_id
ORDER BY p.id;
```

```sql solution
WITH RECURSIVE tree AS (
  SELECT id, project_id, 0 AS depth, title::text AS path, duration_ms AS total_ms
  FROM clips
  WHERE parent_clip_id IS NULL
  UNION ALL
  SELECT c.id, c.project_id, t.depth + 1, t.path || ' > ' || c.title, t.total_ms + c.duration_ms
  FROM clips c
  JOIN tree t ON c.parent_clip_id = t.id
),
endings AS (
  SELECT t.*,
         row_number() OVER (PARTITION BY project_id ORDER BY total_ms DESC, path) AS rn
  FROM tree t
  WHERE NOT EXISTS (SELECT 1 FROM clips k WHERE k.parent_clip_id = t.id)
)
SELECT p.title, e.path, e.depth, e.total_ms
FROM endings e
JOIN projects p ON p.id = e.project_id
WHERE e.rn = 1
ORDER BY p.id;
```
:::

:::quiz id=db-18-q1 xp=15
A teammate "simplifies" phase 2 by finding endings with
`WHERE id NOT IN (SELECT parent_clip_id FROM clips)`. What happens?

- [ ] Same result, slightly slower
- [x] No rows at all, because root clips put NULLs into the subquery
- [ ] An error: NOT IN can't be used inside a recursive CTE
- [ ] Only the root clips are returned
> The NOT IN + NULL trap from the **Subqueries, CTEs & Recursive Queries** lesson. The subquery returns every `parent_clip_id`, and root
> clips contribute `NULL`. `id NOT IN (1, 2, …, NULL)` expands to `id <> 1 AND id <> 2 AND … AND
> id <> NULL`; the last comparison is `NULL` (unknown), so the whole condition is never `TRUE`
> and **no** row passes. There's no error and no warning, just an empty result, which is why this
> is dangerous. It isn't "the same, but slower", and roots aren't special-cased either. `NOT EXISTS`
> is NULL-safe, or filter the subquery with `WHERE parent_clip_id IS NOT NULL`.
:::

## Phase 3 — The queue health dashboard

> **Ticket OPS-88:** *On-call wants one query behind the "Render queue" Grafana panel: per job
> kind, how much is waiting, running, done and failed, how long successful jobs take, how often
> we fail, and how long the oldest queued job has been waiting.*

A dashboard row is several metrics over **different subsets** of the same rows: "count the
queued ones", "average the done ones", "the oldest queued one". The naive approach is one query
(or one self-join) per metric. The efficient approach is **one pass**: `GROUP BY kind`, and give
each aggregate its own subset with `FILTER (WHERE …)`. Postgres reads the table once and feeds
each row only into the aggregates whose filter it matches.

Three details decide whether the numbers are right:

- **Empty subsets.** `count(*)` over zero rows is `0`, but `avg`, `min`, `sum` over zero rows are
  `NULL`. That's what the ticket wants: "no queued jobs" should show as *no value*, not as "0
  minutes old", which on-call would read as "healthy".
- **Integer division.** `count(*)` returns `bigint`, and `1 / 4` in integer arithmetic is `0`.
  Start the expression with `100.0 *` so it becomes `numeric` *before* the division.
- **Division by zero.** A kind with no finished jobs has a denominator of 0, which is an error.
  `nullif(x, 0)` turns 0 into `NULL`, and anything divided by `NULL` is `NULL`.

For durations, subtracting two `timestamptz` values gives an `interval`;
`extract(epoch FROM interval)` turns it into seconds. Since PostgreSQL 14, `extract` returns
`numeric`, so `round(…, 1)` works directly. (The older `date_part()` returns `double precision`,
and `round(double precision, 1)` doesn't exist, so you'd need a `::numeric` cast.)

:::sql id=db-18-sql3 db=studio ordered=true xp=80
title: Phase 3 — Queue health
Return one row per `kind` with:

1. `kind`
2. `queued`, 3. `running`, 4. `done`, 5. `failed` — job counts per status
6. `avg_done_s` — average of `finished_at - started_at` in **seconds** over `done` jobs, rounded to 1 decimal
7. `failure_pct` — `100 × failed / (done + failed)`, rounded to 1 decimal (`NULL` if there are no finished jobs)
8. `oldest_queued_min` — whole minutes (round **down**) between *now* (`timestamptz '2025-07-10 17:00+00'`) and the `created_at` of the oldest **queued** job of that kind (`NULL` if none is queued)

Sort by `kind`.

The playground has cleared the finished `thumbnail` jobs for this phase (an archiving run),
so `thumbnail` has only its queued job left and **no finished jobs**: its `avg_done_s` and
`failure_pct` must be `NULL`, not `0` and not a division-by-zero error.

hint: `count(*) FILTER (WHERE status = 'queued')` — and the same pattern for the others.
hint: `round(avg(extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'done'), 1)`
hint: `floor(extract(epoch FROM timestamptz '2025-07-10 17:00+00' - min(created_at) FILTER (WHERE status = 'queued')) / 60)`

```sql setup
DELETE FROM render_jobs WHERE kind = 'thumbnail' AND status = 'done';
```

```sql starter
SELECT kind,
       count(*) FILTER (WHERE status = 'queued')  AS queued,
       count(*) FILTER (WHERE status = 'running') AS running,
       count(*) FILTER (WHERE status = 'done')    AS done,
       count(*) FILTER (WHERE status = 'failed')  AS failed
FROM render_jobs
GROUP BY kind
ORDER BY kind;
```

```sql solution
SELECT kind,
       count(*) FILTER (WHERE status = 'queued')  AS queued,
       count(*) FILTER (WHERE status = 'running') AS running,
       count(*) FILTER (WHERE status = 'done')    AS done,
       count(*) FILTER (WHERE status = 'failed')  AS failed,
       round(avg(extract(epoch FROM finished_at - started_at)) FILTER (WHERE status = 'done'), 1) AS avg_done_s,
       round(100.0 * count(*) FILTER (WHERE status = 'failed')
             / nullif(count(*) FILTER (WHERE status IN ('done', 'failed')), 0), 1) AS failure_pct,
       floor(extract(epoch FROM timestamptz '2025-07-10 17:00+00'
             - min(created_at) FILTER (WHERE status = 'queued')) / 60) AS oldest_queued_min
FROM render_jobs
GROUP BY kind
ORDER BY kind;
```
:::

:::quiz id=db-18-q5 xp=15
A teammate writes the failure rate as

```sql
round(count(*) FILTER (WHERE status = 'failed')
      / nullif(count(*) FILTER (WHERE status IN ('done', 'failed')), 0) * 100, 1) AS failure_pct
```

In the base studio data (before the phase 3 cleanup), `encode` has 1 failed and 3 done jobs,
`transition` has 1 failed and 1 done, `thumbnail` 0 failed and 2 done.
What does the panel show?

- [ ] `25.0` for encode and `50.0` for transition — the same as the solution
- [x] `0.0` for every kind
- [ ] `NULL` for every kind, because of `nullif`
- [ ] An error: `round()` doesn't accept a `bigint`
> Both counts are `bigint`, so `1 / 4` and `1 / 2` are **integer** divisions that truncate to
> `0`, and `0 * 100` is still `0`. No error, just a dashboard that says "nothing ever fails".
> `nullif` only produces `NULL` when the denominator is 0, which isn't the case here, and
> `round()` happily accepts the integer (it's cast to `numeric`). Fix: make the arithmetic
> numeric *first*, `100.0 * failed / nullif(finished, 0)`.
:::

:::pro title="Dashboards in production"
On a real queue table with millions of finished jobs, this query would scan everything. Teams
either restrict the *finished* metrics to a recent window, keep the hot queue small by archiving
finished jobs (Job Queues), or pre-aggregate into a metrics table / materialized view refreshed
every minute. Careful with the window: a plain `WHERE created_at > now() - interval '24 hours'`
would hide exactly the job that matters most, the one stuck in the queue since March. Use
something like `WHERE status IN ('queued', 'running') OR finished_at > now() - interval '24 hours'`.
The "oldest queued job age" is the single most useful queue alert: if it keeps growing, workers
are down or saturated.
:::

## Phase 4 — The API payload

> **Ticket WEB-140:** *The public gallery page calls `GET /api/gallery`. Instead of three
> queries and mapping in C#, have Postgres return each published project as the exact JSON the
> frontend wants.*

The frontend contract for each published project:

```json
{
  "title":   "The Heist",
  "owner":   "Mara",
  "tags":    ["thriller", "interactive"],
  "clips":   7,
  "members": [ { "name": "Ivy", "role": "viewer" }, { "name": "Jonas", "role": "editor" }, { "name": "Kai", "role": "editor" } ]
}
```

Why do this in the database at all? The C# version is typically: load the projects, then load
clips and members (often one query *per project*, the N+1 problem), then map everything into
DTOs. Postgres can return the finished JSON in one round trip. The tools:

- **`jsonb_build_object('key', value, …)`** builds one object from alternating keys and values.
- **`jsonb_agg(expr ORDER BY …)`** is an aggregate that collects many rows into **one** JSON
  array, in the order you specify. Without the `ORDER BY` inside the call, the array order is
  whatever order the rows happened to arrive in.
- **Correlated subqueries** (a subquery that references the outer row, `WHERE c.project_id =
  p.id`) compute each child value separately, once per project.

Why not just `LEFT JOIN clips` and `LEFT JOIN project_members` and `GROUP BY`? Because two
one-to-many joins **multiply**: *The Heist* has 7 clips and 3 members, so the join produces
7 × 3 = 21 rows, and `count(c.id)` says 21 clips (the row-multiplication trap from the **JOINs** lesson).
Each correlated subquery only sees its own child table, so nothing multiplies.

**Common trap:** an aggregate over zero rows returns `NULL`, so a project without members gets
`"members": null`. The frontend does `members.map(…)` and crashes. Wrap the subquery in
`coalesce(…, '[]'::jsonb)`. (`count(*)` is the exception: it returns `0`, never `NULL`.)

:::sql id=db-18-sql4 db=studio ordered=true xp=80
title: Phase 4 — Gallery JSON
Marketing has just published **Onboarding Tour** (project `2`) as well (the playground applies
that for this phase). It has no clips and no members yet, so it must still appear with
`"clips": 0` and `"members": []`.

For each **published** project return `id` and `payload` (a `jsonb` object) with exactly these
keys:

- `title` — project title
- `owner` — owner's `display_name`
- `tags` — the project's `doc -> 'tags'` array, as-is
- `clips` — number of clips in the project
- `members` — array of `{"name": <display_name>, "role": <role>}` for the project's members,
  ordered by `name`; `[]` if the project has no members

Sort by `id`. (Key order inside the object doesn't matter, because `jsonb` doesn't preserve key
order anyway; array order does.)

hint: `jsonb_build_object('title', p.title, 'owner', u.display_name, …)`
hint: `(SELECT count(*) FROM clips c WHERE c.project_id = p.id)` for the clip count.
hint: `coalesce((SELECT jsonb_agg(jsonb_build_object('name', mu.display_name, 'role', m.role) ORDER BY mu.display_name) FROM project_members m JOIN users mu ON mu.id = m.user_id WHERE m.project_id = p.id), '[]'::jsonb)`

```sql setup
UPDATE projects SET published = true WHERE id = 2;
```

```sql starter
SELECT p.id,
       jsonb_build_object('title', p.title, 'owner', u.display_name) AS payload
FROM projects p
JOIN users u ON u.id = p.owner_id
WHERE p.published
ORDER BY p.id;
```

```sql solution
SELECT p.id,
       jsonb_build_object(
         'title',   p.title,
         'owner',   u.display_name,
         'tags',    p.doc -> 'tags',
         'clips',   (SELECT count(*) FROM clips c WHERE c.project_id = p.id),
         'members', coalesce((
             SELECT jsonb_agg(jsonb_build_object('name', mu.display_name, 'role', m.role)
                              ORDER BY mu.display_name)
             FROM project_members m
             JOIN users mu ON mu.id = m.user_id
             WHERE m.project_id = p.id
           ), '[]'::jsonb)
       ) AS payload
FROM projects p
JOIN users u ON u.id = p.owner_id
WHERE p.published
ORDER BY p.id;
```
:::

:::quiz id=db-18-q6 xp=15
Spot the bug. A teammate builds the members array with joins instead of a subquery:

```sql
SELECT p.id,
       jsonb_agg(jsonb_build_object('name', u.display_name, 'role', m.role)
                 ORDER BY u.display_name) AS members
FROM projects p
LEFT JOIN project_members m ON m.project_id = p.id
LEFT JOIN users u ON u.id = m.user_id
WHERE p.published
GROUP BY p.id;
```

What does *Onboarding Tour* (published, as in the phase 4 setup, and with no members) get?

- [ ] `[]`
- [ ] `null`
- [x] `[{"name": null, "role": null}]`
- [ ] No row at all, because the `LEFT JOIN` finds no match
> A `LEFT JOIN` keeps the project and fills the missing member columns with `NULL`, so the group
> for project 2 contains **one** row. `jsonb_agg` aggregates that row, and
> `jsonb_build_object` happily builds an object of nulls: a one-element array that the frontend
> renders as a nameless member. It isn't `null` (that would need zero input rows) and it isn't
> `[]`. Fixes: the correlated subquery from the solution, or
> `coalesce(jsonb_agg(…) FILTER (WHERE m.user_id IS NOT NULL), '[]'::jsonb)`. And adding a second
> `LEFT JOIN` for clips would then multiply the rows, too.
:::

:::job title="JSON from the database: when it's worth it"
Building API responses in SQL removes N+1 queries and mapping code, and it's very fast for
read-heavy endpoints (galleries, feeds, exports). For the whole page, wrap the query as
`SELECT coalesce(jsonb_agg(payload ORDER BY id), '[]'::jsonb) FROM (…) g` to get a single array. On the C# side you read
that `jsonb` as a plain `string` (Npgsql, or Dapper's `QuerySingleAsync<string>`) and return it
untouched, e.g. a minimal API `Results.Text(json, "application/json")`, instead of deserializing
and re-serializing it. The
trade-off: the shape of your API now lives in SQL, so keep these queries in one place (a view or
a repository method with an integration test), and don't do it for endpoints with heavy business
logic. Many teams use it selectively for the 2–3 hottest read endpoints.
:::

## Phase 5 — The analytics report

> **Ticket BIZ-19:** *For the quarterly investor deck we need a "story complexity" table: for
> each story, how deep it goes, how many endings it has, how many tags it carries, whether it's a
> thriller, and how it ranks by its longest route.*

This one combines all three big tools: a **recursive CTE** for depth, endings and the longest
route; **jsonb** operators for the tags; and a **window function** for the rank. The order of
operations is the whole trick:

1. **Walk the trees** (like phase 2, but you don't need `path` this time): one row per clip with
   its `depth` and the `total_ms` of the route leading to it.
2. **Aggregate per project**: `max(depth)`, `max(total_ms)`, and a `count` of the endings. You
   don't need to filter to endings before taking `max(total_ms)`: durations are positive, so
   extending a route always makes it longer, and the longest route must end at an ending.
3. **Join the project row** and read its tags with jsonb operators:
   `jsonb_array_length(doc -> 'tags')` counts elements, and `jsonb ? 'text'` is true if an array
   contains that string (or an object has that key).
4. **Rank the aggregated rows.** Here it's `rank()` (ties share a rank, then a gap), because
   it's a leaderboard: two stories tied for 4th mean the next one is 6th.

**Common trap:** ranking *inside* the tree CTE or before grouping ranks clips, not projects.
Windows see whatever rows exist at their level of the query, so aggregate first.

:::sql id=db-18-sql5 db=studio ordered=true xp=100
title: Phase 5 — Story complexity
For each project **that has clips**, return:

1. `title`
2. `max_depth` — the deepest level in its clip tree (root = 0)
3. `endings` — number of ending clips (clips without children)
4. `tags` — number of elements in `doc -> 'tags'`
5. `thriller` — `true` if `doc -> 'tags'` contains the string `"thriller"`, else `false`
6. `route_rank` — `rank()` of the project by its **longest** root-to-ending route (`total_ms`), longest first (ties share a rank)

Sort by `route_rank`, then `title`.

hint: Recursive CTE carrying `project_id`, `depth` and `total_ms`; then `GROUP BY project_id` with `max(depth)`, `max(total_ms)` and `count(*) FILTER (WHERE NOT EXISTS (…))`.
hint: The longest route always ends at an ending, so `max(total_ms)` over all tree rows is the longest route.
hint: `jsonb_array_length(doc -> 'tags')` and `doc -> 'tags' ? 'thriller'`.

```sql starter
SELECT p.title,
       jsonb_array_length(p.doc -> 'tags') AS tags
FROM projects p
ORDER BY p.title;
```

```sql solution
WITH RECURSIVE tree AS (
  SELECT id, project_id, 0 AS depth, duration_ms AS total_ms
  FROM clips
  WHERE parent_clip_id IS NULL
  UNION ALL
  SELECT c.id, c.project_id, t.depth + 1, t.total_ms + c.duration_ms
  FROM clips c
  JOIN tree t ON c.parent_clip_id = t.id
),
per_project AS (
  SELECT project_id,
         max(depth)    AS max_depth,
         count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM clips k WHERE k.parent_clip_id = tree.id)) AS endings,
         max(total_ms) AS longest_ms
  FROM tree
  GROUP BY project_id
)
SELECT p.title,
       pp.max_depth,
       pp.endings,
       jsonb_array_length(p.doc -> 'tags') AS tags,
       (p.doc -> 'tags') ? 'thriller'      AS thriller,
       rank() OVER (ORDER BY pp.longest_ms DESC) AS route_rank
FROM per_project pp
JOIN projects p ON p.id = pp.project_id
ORDER BY route_rank, p.title;
```
:::

## Phase 6 — The migration

> **Ticket STU-402:** *Paying customers complain that their encodes wait behind free users'
> thumbnails. Add job priorities: every job gets a `priority` from 0 to 100, existing jobs get a
> priority based on their kind, and workers need an index to pick the most urgent queued job
> fast.*

This is a schema change on a table that workers hit constantly — a real production migration.
The SQL is short; the hard part is knowing what each step **locks** and for **how long**
(Production PostgreSQL):

| Step | What Postgres does | Production-safe version |
|---|---|---|
| `ADD COLUMN priority integer NOT NULL DEFAULT 0` | Since PG 11, a constant default is stored in the catalog — **no table rewrite**. Needs an `ACCESS EXCLUSIVE` lock, but only for a moment | Fine, with a short `lock_timeout` |
| `UPDATE … SET priority = CASE …` | Writes a **new row version** for every row (MVCC), row-locking each one until commit | On big tables: **in batches** of a few thousand ids, each its own transaction |
| `ADD CONSTRAINT … CHECK (…)` | Scans the whole table to check existing rows, holding `ACCESS EXCLUSIVE` the whole time (no reads, no writes) | `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT` |
| `CREATE INDEX …` | Holds a `SHARE` lock while building: reads work, **writes block** | `CREATE INDEX CONCURRENTLY` (can't run inside a transaction block) |

Why `lock_timeout` even for the "cheap" `ADD COLUMN`? Locks are granted in a queue. If a long
report is reading `render_jobs`, your `ACCESS EXCLUSIVE` request waits for it, and **every query
that arrives after you waits behind you**, even plain `SELECT`s. With `SET lock_timeout = '3s'`
the migration gives up quickly and you retry, instead of freezing the app.

The index is **partial** (`WHERE status = 'queued'`): only queued jobs are in it, so it stays
tiny even when the table holds millions of finished jobs, and its column order matches the
worker's `ORDER BY priority DESC, created_at, id` exactly, so Postgres can read the first entry
and stop.

In the playground, everything runs in one transaction on a tiny table, so you can write the
simple forms. The grader checks the **final state** of the database: the column's type,
nullability and default, every job's priority, the index definition, and that the constraint
accepts 0 and 100 but rejects -1 and 101.

:::sql id=db-18-sql6 db=studio xp=100
title: Phase 6 — Add priorities
Write a migration so that, afterwards:

1. `render_jobs.priority` exists: `integer`, `NOT NULL`, default `0`.
2. Every existing job is backfilled by kind: `encode` → `50`, `transition` → `30`,
   `thumbnail` → `10`.
3. A `CHECK` constraint rejects priorities below `0` or above `100` (both `0` and `100` are allowed).
4. A **partial** B-tree index exists on `render_jobs (priority DESC, created_at, id)` covering
   only rows `WHERE status = 'queued'` (any index name).

hint: `ALTER TABLE render_jobs ADD COLUMN priority integer NOT NULL DEFAULT 0;`
hint: `UPDATE render_jobs SET priority = CASE kind WHEN 'encode' THEN 50 WHEN 'transition' THEN 30 ELSE 10 END;`
hint: `CREATE INDEX … ON render_jobs (priority DESC, created_at, id) WHERE status = 'queued';`

```sql starter
ALTER TABLE render_jobs ADD COLUMN priority integer;
```

```sql solution
ALTER TABLE render_jobs ADD COLUMN priority integer NOT NULL DEFAULT 0;

UPDATE render_jobs
SET priority = CASE kind WHEN 'encode' THEN 50 WHEN 'transition' THEN 30 ELSE 10 END;

ALTER TABLE render_jobs
  ADD CONSTRAINT render_jobs_priority_range CHECK (priority BETWEEN 0 AND 100);

CREATE INDEX render_jobs_queue_idx
  ON render_jobs (priority DESC, created_at, id)
  WHERE status = 'queued';
```

```sql check
CREATE FUNCTION pg_temp.try_priority(p int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO render_jobs (id, project_id, kind, status, created_at, priority)
  VALUES (999, 1, 'encode', 'queued', '2025-07-10 17:00+00', p);
  DELETE FROM render_jobs WHERE id = 999;
  RETURN 'accepted';
EXCEPTION WHEN check_violation THEN
  RETURN 'rejected';
END $$;
SELECT 'column' AS what,
       data_type || ' ' || is_nullable || ' default ' || coalesce(column_default, 'none') AS detail
FROM information_schema.columns
WHERE table_name = 'render_jobs' AND column_name = 'priority'
UNION ALL
SELECT 'backfill', string_agg(id || '=' || priority, ',' ORDER BY id) FROM render_jobs WHERE id < 999
UNION ALL
SELECT 'index', regexp_replace(indexdef, 'INDEX \S+ ON', 'INDEX ON')
FROM pg_indexes
WHERE tablename = 'render_jobs' AND indexname <> 'render_jobs_pkey'
UNION ALL SELECT 'priority 101', pg_temp.try_priority(101)
UNION ALL SELECT 'priority -1',  pg_temp.try_priority(-1)
UNION ALL SELECT 'priority 0',   pg_temp.try_priority(0)
UNION ALL SELECT 'priority 100', pg_temp.try_priority(100);
```
:::

:::quiz id=db-18-q2 xp=15
You ship phase 6 to production as written (plain `CREATE INDEX`, one transaction) on a
`render_jobs` table with 40 million rows. What is the most likely incident?

- [ ] None — Postgres builds indexes in the background
- [x] The transaction holds strong locks for minutes (backfill + validation + index build), so every worker's `UPDATE` on `render_jobs` queues behind it and the render queue stalls
- [ ] The `ADD COLUMN … DEFAULT 0` rewrites the whole table, but everything else is instant
- [ ] Postgres refuses to run DDL on a table that has active connections
> Locks taken inside a transaction are held **until `COMMIT`**. The very first statement,
> `ALTER TABLE … ADD COLUMN`, takes an `ACCESS EXCLUSIVE` lock, and the transaction then keeps
> it through the 40-million-row `UPDATE`, the validating `CHECK` scan and the index build. For
> minutes, nothing can even *read* `render_jobs`, so workers and the API pile up behind it.
> The `ADD COLUMN` itself is cheap since PG 11 (no rewrite for a constant default), so the "rewrites the whole
> table" option has it backwards. Postgres doesn't refuse DDL on busy tables, and a plain
> `CREATE INDEX` is not a background operation. Production version: add the column on its own
> with a `lock_timeout`, backfill in batches in separate transactions,
> `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT`, and `CREATE INDEX CONCURRENTLY` on
> its own.
:::

:::quiz id=db-18-q7 xp=15
In the production plan you run
`ALTER TABLE render_jobs ADD CONSTRAINT render_jobs_priority_range CHECK (priority BETWEEN 0 AND 100) NOT VALID;`
and, later, `ALTER TABLE render_jobs VALIDATE CONSTRAINT render_jobs_priority_range;`.
What does the `NOT VALID` step do?

- [ ] It adds the constraint but disables it until `VALIDATE` runs, so new bad rows can still slip in
- [x] It enforces the rule for every new or updated row immediately, but skips checking the existing rows, so it only needs a brief lock
- [ ] It checks the existing rows in the background without any lock
- [ ] Nothing until `VALIDATE`; it only reserves the constraint name
> `NOT VALID` means "the existing rows haven't been checked yet", not "the constraint is off":
> from that moment every `INSERT` and `UPDATE` must satisfy it. Because Postgres skips the scan
> of the existing rows, the `ACCESS EXCLUSIVE` lock is held only for a moment. `VALIDATE CONSTRAINT` then scans the old rows under a much weaker lock
> (`SHARE UPDATE EXCLUSIVE`) that lets normal reads and writes continue. The tempting "disabled until
> `VALIDATE`" option describes a switched-off constraint, which isn't what `NOT VALID` means. If
> `VALIDATE` finds a bad old row, it fails and the constraint stays `NOT VALID` until you fix the
> data and retry.
:::

## Phase 7 — The final claim

> **Ticket STU-403:** *Now make the workers use priorities. When a worker claims a job, it must
> also charge the project owner 15 credits — atomically. If the claim happens, the charge
> happens; if not, neither does.*

The migration from phase 6 has already been applied for you. The final boss combines two
patterns:

- **The `SKIP LOCKED` claim** (Job Queues). The subquery picks the best queued job and locks it
  with `FOR UPDATE`. `SKIP LOCKED` tells *other* workers running the same query at the same moment
  to pretend locked rows don't exist and take the next candidate, so they neither wait nor
  collide. Without any `FOR UPDATE`, two workers can both read "job 10 is queued" from their
  snapshots and both claim it.
- **A data-modifying CTE** (the **Subqueries, CTEs & Recursive Queries** lesson). `WITH claimed AS (UPDATE … RETURNING …)` makes the
  updated rows available to the rest of the statement, so an `INSERT … SELECT … FROM claimed`
  can charge the owner of exactly the job that was claimed. If nothing was claimed, `claimed`
  is empty and nothing is inserted.

Why one statement? A single statement is atomic on its own: it fully succeeds or fully rolls
back, and a worker crash can't land "between" the claim and the charge because there is no
between. Two statements inside `BEGIN … COMMIT` would be atomic too, but you'd need two round
trips and someone has to remember the transaction. One statement makes the mistake impossible.

**Common traps:** forgetting `attempts = attempts + 1` (retry limits from the Job Queues lesson depend on
it), ordering by `created_at DESC` (that's the *newest* job, a stack, not a queue), and putting
the priority in the wrong direction (`ORDER BY priority` picks the *least* urgent job).

:::sql id=db-18-sql7 db=studio xp=120
title: Phase 7 — Claim and charge
Worker `boss-1` claims the next job, at *now* = `'2025-07-10 17:00+00'`. In a **single
statement**:

1. Claim the queued job with the **highest `priority`**; ties go to the oldest `created_at`,
   then the lowest `id`. Use `FOR UPDATE SKIP LOCKED` so concurrent workers never pick the same
   job.
2. Set its `status = 'running'`, `worker = 'boss-1'`, `started_at` = now, and increment
   `attempts`.
3. Insert a ledger row for the **owner of the job's project**: `id = 15`, `delta = -15`,
   `reason = 'render: <kind> job <job id>'` (e.g. `render: encode job 42`), `created_at` = now.
   (The literal `id = 15` is only there so the result is gradable; in production the ledger `id`
   would be an identity column.)

Only that one job and that one ledger row may change.

hint: `WITH claimed AS (UPDATE render_jobs SET … WHERE id = (SELECT id FROM render_jobs WHERE status = 'queued' ORDER BY priority DESC, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, project_id, kind)`
hint: Then `INSERT INTO credit_ledger (id, user_id, delta, reason, created_at) SELECT 15, p.owner_id, -15, 'render: ' || c.kind || ' job ' || c.id, '2025-07-10 17:00+00' FROM claimed c JOIN projects p ON p.id = c.project_id;`
hint: Which job wins? Encodes have priority 50 — and job 10 has been waiting since March.

```sql setup
ALTER TABLE render_jobs ADD COLUMN priority integer NOT NULL DEFAULT 0;
UPDATE render_jobs SET priority = CASE kind WHEN 'encode' THEN 50 WHEN 'transition' THEN 30 ELSE 10 END;
ALTER TABLE render_jobs ADD CONSTRAINT render_jobs_priority_range CHECK (priority BETWEEN 0 AND 100);
CREATE INDEX render_jobs_queue_idx ON render_jobs (priority DESC, created_at, id) WHERE status = 'queued';
```

```sql starter
UPDATE render_jobs
SET status = 'running', worker = 'boss-1'
WHERE id = (SELECT id FROM render_jobs WHERE status = 'queued' ORDER BY created_at DESC LIMIT 1)
RETURNING id, kind;
```

```sql solution
WITH claimed AS (
  UPDATE render_jobs
  SET status     = 'running',
      worker     = 'boss-1',
      started_at = '2025-07-10 17:00+00',
      attempts   = attempts + 1
  WHERE id = (
    SELECT id
    FROM render_jobs
    WHERE status = 'queued'
    ORDER BY priority DESC, created_at, id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING id, project_id, kind
)
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
SELECT 15, p.owner_id, -15, 'render: ' || c.kind || ' job ' || c.id, '2025-07-10 17:00+00'
FROM claimed c
JOIN projects p ON p.id = c.project_id
RETURNING *;
```

```sql check
SELECT 'job ' || id || ' ' || status || ' attempts=' || attempts
       || ' worker=' || coalesce(worker, '-')
       || ' started=' || coalesce(to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-') AS state
FROM render_jobs
UNION ALL
SELECT 'ledger ' || id || ' user=' || user_id || ' delta=' || delta || ' ' || reason
       || ' at ' || to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
FROM credit_ledger
WHERE id >= 15
UNION ALL
SELECT 'balance of user 3 = ' || sum(delta) FROM credit_ledger WHERE user_id = 3;
```
:::

:::quiz id=db-18-q3 xp=15
Two workers run the phase 7 claim at the same moment (as in production, the ledger `id` comes
from an identity column, not the literal `15`). What happens with `SKIP LOCKED` in place?

- [ ] Both claim job 10 and Ivy is charged twice
- [ ] The second worker waits until the first commits, then claims job 10 again
- [x] The second worker skips the locked job 10 and claims the next one (job 7); Ivy is charged once for job 10 and Kai once for job 7
- [ ] The second statement fails with a deadlock error
> The first worker's subquery locks job 10. The second worker's subquery reaches job 10, sees
> it's locked, skips it and locks the next candidate: job 7, the other queued encode (project 6,
> owned by Kai). Because each charge is in the same statement as its claim, each claim produces
> exactly one ledger row for the right owner. "Both claim job 10" is the bug you get with **no**
> `FOR UPDATE` at all. "Waits, then claims job 10 again" can't happen either: plain `FOR UPDATE`
> (without `SKIP LOCKED`) would make the second worker wait, but after the first commits, job 10
> is no longer `queued`. And there's no deadlock: each worker only ever waits on (or skips) one
> row. Bonus: with the literal `id = 15` from the exercise, the second worker's `INSERT` would hit
> a primary-key violation and its whole statement, claim included, would roll back. Atomicity
> doing its job.
:::

## Phase 8 — The tenant-safe feed

> **Ticket STU-404:** *The new "Render history" panel pages through a project's render jobs,
> newest first, with "Load more". It must stay fast when a project has a million jobs, and a
> user must never see jobs of a project they don't belong to, even if an endpoint forgets its
> `WHERE`.*

The last phase checks the advanced core of the region in one ticket:

- **Keyset pagination** (Performance Tuning). The client sends the sort key of the last row it
  saw, and the next page is "the rows after that", `WHERE (created_at, id) < ($2, $3)`. `OFFSET`
  would get slower with every page and would repeat or skip rows while new jobs arrive. The `id`
  tiebreaker matters here: jobs 5 and 12 were created in the same second.
- **The right composite index** (Indexes & EXPLAIN). Equality column first, then the sort
  columns in the order of the `ORDER BY`: `(project_id, created_at, id)`. The planner then walks
  one slice of the index backwards and stops after `LIMIT` rows, with no Sort node. A B-tree can
  be read in either direction, so `(project_id, created_at DESC, id DESC)` works too.
- **Row-level security** (Production PostgreSQL). The policy is the safety net under the app's
  own filter: the API connects as a non-owner role and sets `app.user_id` per transaction, and
  Postgres hides every row the policy doesn't allow.

This phase is graded by a `check` script, as the migration was: the grader calls your function,
runs `EXPLAIN` on the page query, and then queries as the app role.

:::sql id=db-18-sql8 db=studio xp=100
title: Phase 8a — Fast, stable pages
Create **both** of these:

1. A SQL function `job_page(p_project int, p_created timestamptz, p_id int, p_limit int)` that
   returns `TABLE (id int, kind text, created_at timestamptz)`: the jobs of project `p_project`
   that come **after** the cursor `(p_created, p_id)` in the order `created_at DESC, id DESC`, in
   that order, at most `p_limit` rows.
2. **One** index on `render_jobs` that lets the page query run as an index scan with **no Sort**
   node.

The grader calls `job_page(5, '2025-07-02 12:00+00', 12, 10)` (job 5 shares job 12's timestamp
and must be returned) and `job_page(1, '2025-06-01 09:03+00', 11, 10)`. Then it runs `EXPLAIN` on
the page query with sequential scans disabled and checks that there's no Sort.

hint: `CREATE FUNCTION job_page(…) RETURNS TABLE (id int, kind text, created_at timestamptz) LANGUAGE sql STABLE AS $$ SELECT … $$;`
hint: Inside the function, qualify the columns (`r.id`, `r.created_at`): the output column names are also variables there.
hint: `WHERE r.project_id = p_project AND (r.created_at, r.id) < (p_created, p_id) ORDER BY r.created_at DESC, r.id DESC LIMIT p_limit`
hint: `CREATE INDEX … ON render_jobs (project_id, created_at, id);`

```sql starter
CREATE FUNCTION job_page(p_project int, p_created timestamptz, p_id int, p_limit int)
RETURNS TABLE (id int, kind text, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT r.id, r.kind, r.created_at
  FROM render_jobs r
  WHERE r.project_id = p_project AND r.created_at < p_created
  ORDER BY r.created_at DESC
  LIMIT p_limit
$$;
```

```sql solution
CREATE INDEX render_jobs_project_feed_idx ON render_jobs (project_id, created_at, id);

CREATE FUNCTION job_page(p_project int, p_created timestamptz, p_id int, p_limit int)
RETURNS TABLE (id int, kind text, created_at timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT r.id, r.kind, r.created_at
  FROM render_jobs r
  WHERE r.project_id = p_project
    AND (r.created_at, r.id) < (p_created, p_id)
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT p_limit
$$;
```

```sql check
CREATE OR REPLACE FUNCTION plan_of(q text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP RETURN NEXT r; END LOOP;
END $$;
SET enable_seqscan = off;
SET enable_bitmapscan = off;
SELECT 'page A: ' || coalesce((SELECT string_agg(id || ' ' || kind, ', ' ORDER BY n)
         FROM (SELECT *, row_number() OVER () AS n
               FROM job_page(5, '2025-07-02 12:00+00', 12, 10)) a), '(none)') AS result
UNION ALL
SELECT 'page B: ' || coalesce((SELECT string_agg(id || ' ' || kind, ', ' ORDER BY n)
         FROM (SELECT *, row_number() OVER () AS n
               FROM job_page(1, '2025-06-01 09:03+00', 11, 10)) b), '(none)')
UNION ALL
SELECT 'no sort: ' || NOT bool_or(p LIKE '%Sort%')
FROM plan_of($q$SELECT id, kind, created_at FROM render_jobs
               WHERE project_id = 5 AND (created_at, id) < ('2025-07-02 12:00+00', 12)
               ORDER BY created_at DESC, id DESC LIMIT 10$q$) p;
```
:::

:::sql id=db-18-sql9 db=studio xp=100
title: Phase 8b — The safety net
The API connects as the role `boss_app` (already created and granted `SELECT` on the studio
tables) and runs `SELECT set_config('app.user_id', '<id>', true)` at the start of every
transaction.

Turn on row-level security for `render_jobs` with a policy so that `boss_app` sees a job only if
the current user **owns** the job's project **or is a member** of it (any role). With no user
set, or an empty setting, it must see **nothing**, without an error.

The grader queries `render_jobs` as `boss_app` with no user, as Jonas (user 2), as Lena (user 5)
and as Ivy (user 3), and lists the visible job ids.

hint: `ALTER TABLE render_jobs ENABLE ROW LEVEL SECURITY;`
hint: `CREATE POLICY … ON render_jobs FOR SELECT USING (EXISTS (SELECT 1 FROM projects p WHERE p.id = render_jobs.project_id AND p.owner_id = …) OR EXISTS (… project_members …));`
hint: `nullif(current_setting('app.user_id', true), '')::int` is NULL when nothing is set, and NULL never matches.

```sql setup
DO $$ BEGIN CREATE ROLE boss_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT SELECT ON users, projects, project_members, clips, render_jobs, credit_ledger TO boss_app;
```

```sql starter
ALTER TABLE render_jobs ENABLE ROW LEVEL SECURITY;
```

```sql solution
ALTER TABLE render_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY render_jobs_visible ON render_jobs
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM projects p
            WHERE p.id = render_jobs.project_id
              AND p.owner_id = nullif(current_setting('app.user_id', true), '')::int)
    OR EXISTS (SELECT 1 FROM project_members m
               WHERE m.project_id = render_jobs.project_id
                 AND m.user_id = nullif(current_setting('app.user_id', true), '')::int)
  );
```

```sql check
CREATE TEMP TABLE seen (step int, who text, visible text);
GRANT INSERT, SELECT ON seen TO boss_app;
SET ROLE boss_app;
SELECT set_config('app.user_id', '', false);
INSERT INTO seen SELECT 1, 'nobody', coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM render_jobs), '(none)');
SELECT set_config('app.user_id', '2', false);
INSERT INTO seen SELECT 2, 'jonas', coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM render_jobs), '(none)');
SELECT set_config('app.user_id', '5', false);
INSERT INTO seen SELECT 3, 'lena', coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM render_jobs), '(none)');
SELECT set_config('app.user_id', '3', false);
INSERT INTO seen SELECT 4, 'ivy', coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM render_jobs), '(none)');
RESET ROLE;
SELECT step, who, visible FROM seen ORDER BY step;
```
:::

:::quiz id=db-18-q8 xp=15
Phase 8 is live. A teammate proposes four follow-ups. Which ones are **correct**? Select all
that apply.

- [x] Keep `WHERE project_id = $1` in the endpoint's query even though RLS filters too: it is what makes the planner use `(project_id, created_at, id)`, and it documents the intent in code review
- [ ] Add "Jump to page 37" by computing `OFFSET 36 * 20` alongside the keyset cursor, since the index makes OFFSET as cheap as keyset
- [x] Connect the API as `boss_app`, not as the role that owns `render_jobs` and runs migrations, because the table owner bypasses RLS unless the table has `FORCE ROW LEVEL SECURITY`
- [ ] Set the user with plain `SET app.user_id = '2'` once per pooled connection, so it isn't repeated in every transaction
> The policy filters rows, but it doesn't tell the planner which slice of the index to read. The
> explicit `project_id = $1` does that, and it keeps the query understandable. `OFFSET` still
> produces and throws away every skipped row, index or not. Table owners (and superusers) skip RLS
> silently, so the app needs its own non-owner role. A session-level `SET` survives on a pooled
> connection and leaks one user's identity into the next request (and behind PgBouncer in
> transaction mode, the next transaction may run on a different server connection entirely). Use
> `set_config(…, true)` inside each transaction.
:::

## Victory

If all eight phases are green, you have written — on real PostgreSQL — the kind of SQL that
sits behind a production SaaS: billing views, tree analytics, an on-call dashboard, an API
endpoint, a migration plan, a concurrency-safe worker and a paged feed that stays fast and
tenant-safe. That's the Database region cleared.

:::pro title="What would come next in a real team"
Every query from this fight would get: a **test** (seed a database in CI with Testcontainers
and assert on the result), an **`EXPLAIN (ANALYZE, BUFFERS)`** review on production-sized data,
the right **indexes** (e.g. `clips (parent_clip_id)` for the recursive walk,
`credit_ledger (user_id, created_at, id)` for statements), and for the migration a reviewed
**expand/contract** plan with `lock_timeout` and a rollback strategy.
:::

:::cards id=db-18-cards1 xp=20 title="Boss loot: patterns worth remembering"
Q: How do you rank by an aggregate?
A: Group first (CTE or GROUP BY), then apply a window function like `dense_rank() OVER (ORDER BY sum(...) DESC)` — windows run after grouping.
Q: `row_number()` vs `rank()` vs `dense_rank()` for 500, 450, 450, 190?
A: 1,2,3,4 vs 1,2,2,4 vs 1,2,2,3. Only `row_number()` splits ties; only `rank()` leaves gaps.
Q: Longest root-to-leaf path per tree?
A: Recursive CTE carrying path/total, keep leaves via NOT EXISTS, then `row_number() OVER (PARTITION BY tree ORDER BY total DESC, path)` = 1.
Q: The one-pass dashboard pattern?
A: `GROUP BY` the dimension, one `count(*) FILTER (WHERE …)` per metric; `nullif(denominator, 0)` for ratios.
Q: Why `100.0 * failed / total` and not `failed / total * 100`?
A: Counts are `bigint`, so `failed / total` is integer division and truncates to 0. Make it numeric before dividing.
Q: Ordered JSON array per parent row, never null?
A: `coalesce((SELECT jsonb_agg(x ORDER BY …) FROM … WHERE parent = p.id), '[]'::jsonb)`.
Q: What does `jsonb_agg` over a `LEFT JOIN` give a parent with no children?
A: `[{"name": null, …}]`: one object of nulls, because the LEFT JOIN supplies one all-NULL row. Use a correlated subquery or `FILTER (WHERE child.id IS NOT NULL)`.
Q: Why use correlated subqueries for several counts in one row?
A: Joining several child tables multiplies rows; independent subqueries (or pre-grouped CTEs) keep each count correct.
Q: Is `ADD COLUMN … NOT NULL DEFAULT 0` expensive?
A: Not since PG 11 for a constant default — no rewrite. Backfills, validating constraints and non-concurrent index builds are the expensive parts.
Q: What does `ADD CONSTRAINT … NOT VALID` mean?
A: Enforced for new and updated rows right away; existing rows are checked later by `VALIDATE CONSTRAINT`, under a lock that doesn't block reads or writes.
Q: Why does a long migration transaction stall even reads?
A: `ALTER TABLE` takes `ACCESS EXCLUSIVE`, and locks are held until `COMMIT`. Keep DDL transactions short and set `lock_timeout`.
Q: How do you test a CHECK constraint in a check script?
A: A plpgsql function that tries the INSERT and catches `check_violation`.
Q: Claim a job and charge credits atomically?
A: One statement: `WITH claimed AS (UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING …) INSERT INTO ledger SELECT … FROM claimed`.
Q: Which index serves a priority queue claim?
A: A partial index matching the ORDER BY: `(priority DESC, created_at, id) WHERE status = 'queued'`.
:::

## Recap

- Real tickets are **compositions**: CTE → aggregate → window → shape the output. Build and run them step by step.
- "Every user" means the parent table drives the query: **`LEFT JOIN`** the aggregated children and `coalesce` the gaps.
- Windows run **after** grouping, so you can rank aggregates; pick `row_number` / `rank` / `dense_rank` by how ties should behave, and always give tie-breakers.
- **Recursive CTEs + window functions** answer tree questions like "longest branch per project".
- **`FILTER` + `GROUP BY`** builds a whole dashboard row in one scan; make ratios numeric before dividing and guard them with `nullif`.
- **`jsonb_build_object` + ordered `jsonb_agg` + `coalesce(…, '[]')`**, with correlated subqueries per child table, produce API-ready JSON straight from Postgres without row multiplication.
- Migrations are graded by **final state** here, but in production every step's **lock and rewrite cost** matters: short transactions, `lock_timeout`, batched backfills, `NOT VALID` + `VALIDATE`, `CREATE INDEX CONCURRENTLY`.
- A **data-modifying CTE** around a `SKIP LOCKED` claim makes "claim + side effect" one atomic statement.
- A fast feed is **keyset pagination** on a total order plus the composite index that matches it (equality column first, then the sort columns), with **RLS** as the safety net under the app's own `WHERE`.
