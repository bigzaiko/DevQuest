---
id: db-17
title: Performance Tuning
level: expert
minutes: 45
xp: 250
summary: Keyset pagination, covering indexes, sargable predicates, killing ORM N+1s, planner statistics, CTE materialization and batch writes, the everyday toolkit for a fast SaaS database.
---

Slow databases rarely come from exotic problems. In a typical SaaS codebase the same handful of
mistakes cause most of the latency: `OFFSET 50000`, a function wrapped around an indexed column,
an ORM issuing 200 queries for one page, a planner working from bad statistics, and 10 000
single-row `INSERT`s in a loop. This lesson works through each of them in the order you'll meet
them on the job, and shows the fix at the SQL level, because that's where it has to be fixed
whatever ORM sits on top.

## Measure first

Never tune by guessing. In production the starting point is **`pg_stat_statements`**, an
extension (preinstalled or one setting away on RDS, Azure, Cloud SQL and CloudNativePG; on your own
server add it to `shared_preload_libraries` and run `CREATE EXTENSION pg_stat_statements`). It
aggregates every **normalized** query — literals replaced by `$1`, `$2` — so
`WHERE id = 5` and `WHERE id = 7` count as one statement:

```sql
SELECT calls,
       round(total_exec_time)        AS total_ms,
       round(mean_exec_time, 2)      AS mean_ms,
       rows,
       left(query, 80)               AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

Sort by **total** time, not mean time. A 2 ms query called 5 million times a day costs more than
a 3-second report run twice. Then take the worst offender, run `EXPLAIN (ANALYZE, BUFFERS)` on a
production-sized copy (lesson 11), fix it, and measure again.

:::info title="In the browser sandbox"
PGlite has no `pg_stat_statements`, and its statistics counters don't move during a run. The
challenges below grade **plans and estimates** instead (via `EXPLAIN` inside the grader), using
deterministic generated data that is large enough for the planner to care.
:::

## Pagination: OFFSET vs keyset

The obvious way to page through a list:

```sql
SELECT id, title, created_at FROM clips
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 40000;   -- page 2001
```

The database can't jump to row 40 000. It has to **produce and discard** 40 000 rows first, so
page 2001 is 2000× more work than page 1. Latency grows linearly with the page number, and bots
crawling `?page=` URLs can bring a server down. There is a correctness problem too: if a new row
is inserted while the user moves from page 1 to page 2, every row shifts by one and the user
**sees an item twice**. If a row is deleted, they **miss one**.

**Keyset pagination** (also called the *seek method* or *cursor pagination*) remembers where the
last page ended and asks for "the next 20 after that":

```sql
-- the last row of the previous page was (created_at = '2025-07-02 12:00:00+00', id = 12)
SELECT id, kind, created_at FROM render_jobs
WHERE (created_at, id) < ('2025-07-02 12:00:00+00', 12)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

- The **tiebreaker** `id` makes the order total. Without it, rows sharing a `created_at` could be
  skipped or repeated at page boundaries.
- The **row-value comparison** `(a, b) < (x, y)` means `a < x OR (a = x AND b < y)`, and Postgres
  can use it directly as an index range on `(created_at, id)`.
- With an index on `(created_at DESC, id DESC)` (or the same columns ascending, since B-trees walk
  backwards fine) every page is one index descent plus 20 entries. Page 2001 costs the same as
  page 1.
- **Common mistake: mixed directions.** The row comparison only works when every sort column goes
  the same way. For `ORDER BY created_at DESC, id ASC` you'd need
  `created_at < $1 OR (created_at = $1 AND id > $2)` spelled out — simpler to make the tiebreaker
  follow the main column's direction.
- **Common mistake: nullable sort columns.** `(a, b) < (x, y)` is NULL when `a` is NULL, so rows
  with a NULL sort key silently vanish. Keyset columns should be `NOT NULL`.

| | OFFSET | Keyset |
|---|---|---|
| Cost of page N | grows with N | constant |
| Stable under inserts/deletes | no (duplicates, gaps) | yes |
| "Jump to page 37" | yes | no, only next/previous |
| Total page count | needs a `count(*)` (also slow) | usually not shown ("Load more") |

The API returns an **opaque cursor**, typically base64 of the last row's sort key, e.g.
`{"items":[…],"next":"eyJjIjoiMjAyNS0wNy0wMlQxMjowMDowMFoiLCJpIjoxMn0="}`. The client sends it
back as `?after=…`. Infinite scroll, activity feeds and public APIs (Stripe, GitHub, Slack) all
work this way.

:::sql id=db-17-sql1 db=studio ordered=true xp=40
title: The next page, keyset style
The job history UI shows `render_jobs` newest first (`created_at DESC, id DESC`), 4 per page. The
client sent the cursor of the last row it saw: `created_at = '2025-07-02 12:00:00+00'`, `id = 12`.

Return the **next 4 jobs**: columns `id`, `kind`, `created_at`, in display order. Watch out: job 5
has the same `created_at` as job 12 and belongs on this page.

hint: `WHERE (created_at, id) < (…, …)`
hint: The ORDER BY must match the cursor columns, including the tiebreaker.

```sql starter
SELECT id, kind, created_at
FROM render_jobs
WHERE created_at < '2025-07-02 12:00:00+00'
ORDER BY created_at DESC
LIMIT 4;
```

```sql solution
SELECT id, kind, created_at
FROM render_jobs
WHERE (created_at, id) < ('2025-07-02 12:00:00+00', 12)
ORDER BY created_at DESC, id DESC
LIMIT 4;
```
:::

:::quiz id=db-17-q1 xp=15
A mobile app uses `LIMIT 20 OFFSET 20 * page` on a feed that gets new posts every few seconds.
Users report seeing the same post twice when scrolling. Why, and what's the fix?

- [ ] OFFSET is non-deterministic in PostgreSQL; add `FOR UPDATE`
- [x] New rows inserted at the top shift every row down, so the next OFFSET page re-reads rows already shown. Switch to keyset pagination on `(created_at, id)`.
- [ ] The query lacks an index; adding one fixes the duplicates
- [ ] Postgres caches pages; disable the query cache
> OFFSET counts positions, and positions change when rows are added or removed. Keyset pagination
> remembers a **value** (the last row's sort key), so new rows above it don't matter. An index makes
> OFFSET faster but not correct.
:::

## Covering indexes and index-only scans

An **Index Only Scan** answers a query entirely from the index without visiting the table heap.
This requires that **every column the query needs is in the index**. You could add all of them as
key columns, but key columns make the index sort by them, which costs B-tree space and for
`UNIQUE` indexes changes the meaning. `INCLUDE` adds **payload columns** to the leaf entries only:

```sql
-- "order history" page: filter + sort on the key, show status and total
CREATE INDEX orders_customer_history_idx
  ON orders (customer_id, created_at) INCLUDE (status, total);

SELECT created_at, status, total
FROM orders
WHERE customer_id = $1
ORDER BY created_at DESC
LIMIT 20;
```

```text
Limit
  ->  Index Only Scan Backward using orders_customer_history_idx on orders
        Index Cond: (customer_id = 42)
```

There's no Sort node (the key order provides it) and no heap access. Two caveats:

- An index-only scan still checks the **visibility map** for each page. If a page isn't marked
  all-visible (recently modified, not yet vacuumed) Postgres must check the heap anyway. In
  `EXPLAIN ANALYZE` look at `Heap Fetches: N`. A large number means autovacuum isn't keeping up
  on that table.
- Covering indexes are **bigger**, and including a frequently updated column blocks HOT updates
  (lesson 11). Include stable, small columns that hot queries really read.

A classic use is `UNIQUE (email) INCLUDE (id, display_name)`: uniqueness on `email` alone, while
the login lookup gets `id` and `display_name` without touching the table.

:::quiz id=db-17-q5 xp=15
After adding a covering index, `EXPLAIN (ANALYZE, BUFFERS)` of the order-history query on a busy
`orders` table shows:

```text
Index Only Scan Backward using orders_customer_history_idx on orders
  Index Cond: (customer_id = 42)
  Heap Fetches: 19
  (actual rows=20 …)
```

What does `Heap Fetches: 19` tell you?

- [ ] The index is missing `status` or `total`, so Postgres read 19 rows from the table to get them
- [x] 19 of the 20 rows sat on heap pages not yet marked all-visible, so Postgres had to check the table to see if they're visible; vacuum isn't keeping up with this table
- [ ] The planner ignored the index for 19 rows and did a sequential scan
- [ ] 19 rows were deleted and skipped
> An Index Only Scan with a missing column wouldn't be chosen at all — Postgres would use a plain
> Index Scan. `Heap Fetches` counts visibility checks: MVCC visibility isn't stored in the index, so
> for pages the **visibility map** doesn't mark all-visible, Postgres must visit the heap. On a
> hot, recently modified table that's normal in small amounts; if it's close to the row count,
> tune autovacuum for that table (lesson 16) so pages get marked all-visible sooner.
:::

:::sql id=db-17-sql2 db=empty xp=50
title: Cover the order-history query
This query runs on every customer's order-history page:

```sql
SELECT created_at, status, total FROM orders
WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 20;
```

Create **one** index so Postgres can answer it with an **Index Only Scan** and **no Sort**. Key on
what you filter and sort by, and add `status` and `total` with `INCLUDE`.

The grader runs `EXPLAIN` on the query (with seq and bitmap scans disabled) and checks for an
Index Only Scan, no Sort node, and that your index uses `INCLUDE`.

hint: `CREATE INDEX … ON orders (<filter col>, <sort col>) INCLUDE (…);`

```sql setup
CREATE TABLE orders (
  id          bigint PRIMARY KEY,
  customer_id int           NOT NULL,
  status      text          NOT NULL,
  total       numeric(10,2) NOT NULL,
  created_at  timestamp     NOT NULL
);
INSERT INTO orders
SELECT g, g % 3000, (ARRAY['paid','shipped','cancelled'])[1 + g % 3],
       (g % 500) + 0.99, timestamp '2025-01-01' + g * interval '7 minutes'
FROM generate_series(1, 30000) g;
ANALYZE orders;
```

```sql starter
CREATE INDEX orders_customer_idx ON orders (customer_id);
```

```sql solution
CREATE INDEX orders_customer_history_idx
  ON orders (customer_id, created_at) INCLUDE (status, total);
```

```sql check
CREATE OR REPLACE FUNCTION plan_of(q text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP RETURN NEXT r; END LOOP;
END $$;
SET enable_seqscan = off;
SET enable_bitmapscan = off;
SELECT bool_or(p LIKE '%Index Only Scan%')  AS index_only,
       NOT bool_or(p LIKE '%Sort%')        AS no_sort,
       (SELECT bool_or(indexdef LIKE '%INCLUDE%') FROM pg_indexes WHERE tablename = 'orders') AS uses_include
FROM plan_of($q$SELECT created_at, status, total FROM orders
               WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 20$q$) p;
```
:::

## Sargability: keep the indexed column naked

A predicate is **sargable** (Search ARGument ABLE) when the database can turn it into an index
range. The rule is simple: **the indexed column must stand alone on one side of the comparison**.
Any function, cast or arithmetic applied *to the column* hides it from a B-tree.

| Non-sargable | Sargable rewrite |
|---|---|
| `WHERE created_at::date = '2025-06-01'` | `WHERE created_at >= '2025-06-01' AND created_at < '2025-06-02'` |
| `WHERE date_trunc('month', created_at) = '2025-06-01'` | `WHERE created_at >= '2025-06-01' AND created_at < '2025-07-01'` |
| `WHERE created_at + interval '7 days' > now()` | `WHERE created_at > now() - interval '7 days'` |
| `WHERE extract(year FROM created_at) = 2025` | `WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01'` |
| `WHERE coalesce(deleted_at, 'infinity') > now()` | `WHERE deleted_at IS NULL OR deleted_at > now()` (or a partial index) |
| `WHERE id::text = $1` | `WHERE id = $1::bigint` (cast the **parameter**) |
| `WHERE lower(email) = $1` | store normalized, or add an expression index on `lower(email)` |
| `WHERE title LIKE '%heist%'` | full-text search or trigram index, since a B-tree can't help |

Use **half-open ranges** (`>= start AND < next_start`). They are exact for timestamps with
microseconds, where `BETWEEN '…00:00' AND '…23:59:59'` silently misses `23:59:59.5`.

Watch for **hidden casts**, too. When a parameter's type doesn't match the column, Postgres picks
an operator for the two types, and if there is no index-compatible one it casts the *column*. The
classic case: a C# `decimal` (sent as `numeric`) compared with a `bigint` id. There's no
`bigint = numeric` operator in the B-tree's operator family, so the column becomes `id::numeric`
and in `EXPLAIN` you'll see `Filter: ((id)::numeric = 42.0)` on a Seq Scan instead of an
`Index Cond`. (Not every mismatch hurts: `int` vs `bigint`, or `text` vs `varchar`, still use the
index, because those types share an operator family.) EF Core with Npgsql types parameters from the
mapped property and usually gets this right; hand-written Dapper or ADO.NET code that passes the
"wrong" .NET type is where it bites.

:::sql id=db-17-sql3 db=empty xp=50
title: Make the daily report sargable
A teammate created the view `jobs_2025_06_01` for a daily report. `jobs.created_at` has an index,
but the view casts the column to `date`, so every report does a full scan of 40 000 rows.

Replace the view (same name, same columns `id`, `kind`, `created_at`, same rows) with a
predicate the index can use.

The grader checks the view's row count and that `EXPLAIN SELECT * FROM jobs_2025_06_01` uses an
index condition.

hint: `CREATE OR REPLACE VIEW … AS SELECT … WHERE created_at >= … AND created_at < …;`
hint: Getting 481 rows? `BETWEEN` includes both ends, so it also matches exactly midnight of June 2. Use a half-open range.

```sql setup
CREATE TABLE jobs (
  id         bigint PRIMARY KEY,
  kind       text      NOT NULL,
  created_at timestamp NOT NULL
);
INSERT INTO jobs
SELECT g, (ARRAY['encode','thumbnail','transition'])[1 + g % 3],
       timestamp '2025-05-01' + g * interval '3 minutes'
FROM generate_series(1, 40000) g;
CREATE INDEX jobs_created_at_idx ON jobs (created_at);
ANALYZE jobs;
CREATE VIEW jobs_2025_06_01 AS
  SELECT id, kind, created_at FROM jobs WHERE created_at::date = '2025-06-01';
```

```sql starter
SELECT count(*) FROM jobs_2025_06_01;
```

```sql solution
CREATE OR REPLACE VIEW jobs_2025_06_01 AS
  SELECT id, kind, created_at FROM jobs
  WHERE created_at >= '2025-06-01' AND created_at < '2025-06-02';
```

```sql check
CREATE OR REPLACE FUNCTION plan_of(q text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP RETURN NEXT r; END LOOP;
END $$;
SELECT (SELECT count(*) FROM jobs_2025_06_01) AS row_count,
       bool_or(p LIKE '%Index Cond%')         AS uses_index
FROM plan_of('SELECT * FROM jobs_2025_06_01') p;
```
:::

:::quiz id=db-17-q4 xp=15
Spot the bug. `users` has `id bigint PRIMARY KEY` and a B-tree index on `email`. Which of these
lookups **cannot** use an index condition on those indexes? Select all that apply.

- [ ] `WHERE id = 42::int`
- [x] `WHERE id = 42.0::numeric` (a C# `decimal` parameter)
- [x] `WHERE lower(email) = 'ada@example.com'`
- [ ] `WHERE email = 'ada@example.com'::varchar`
- [x] `WHERE id::text = '42'`
> `int` vs `bigint` and `varchar` vs `text` are in the same operator family, so the B-tree still
> applies — those two look suspicious but are fine. A `numeric` parameter has no `bigint = numeric`
> index operator, so Postgres casts the column (`id::numeric`). `lower(email)` and `id::text` wrap
> the column in a function/cast; only an expression index on exactly that expression would help.
> The fix in each case: cast the **parameter** to the column's type, or store data normalized.
:::

## N+1: seeing the ORM in SQL

The most common performance bug in ORM code doesn't show up in the C# at all. This EF Core code
looks innocent:

```csharp
var projects = await db.Projects.Where(p => p.Published).ToListAsync();
foreach (var p in projects)
{
    var clipCount = await db.Clips.CountAsync(c => c.ProjectId == p.Id);   // 1 query per project
    dto.Add(new(p.Id, p.Title, p.Owner.DisplayName, clipCount));            // + lazy load per owner
}
```

Turn on SQL logging (`optionsBuilder.LogTo(Console.WriteLine)`, or watch the APM trace) and the
problem is obvious:

```text
SELECT … FROM projects WHERE published                         -- 1
SELECT count(*) FROM clips WHERE project_id = 1                -- N
SELECT … FROM users WHERE id = 1                               -- N (lazy loading)
SELECT count(*) FROM clips WHERE project_id = 3
SELECT … FROM users WHERE id = 2
…
```

That's **1 + 2N round trips**. Each one is fast (0.3 ms of execution) but costs a network round
trip, connection-pool time and parsing. With 100 projects and 1 ms of latency to the database,
the endpoint spends 200 ms waiting on the network for trivial queries. The fixes:

- **Project in one query**: let the ORM translate a `Select` into a JOIN plus aggregate:
  `db.Projects.Select(p => new { p.Id, p.Title, Owner = p.Owner.DisplayName, Clips = p.Clips.Count() })`.
  EF Core turns this into a single SQL statement (which you'll write below).
- **Eager loading** with `Include(p => p.Clips)`. Beware the **cartesian explosion** when you
  include two collections: rows = clips × members per project. `AsSplitQuery()` makes EF Core
  issue one query per collection instead (3 queries instead of 1 huge one or N small ones).
- **Batch by key**: when you already have a list of ids, fetch all children in one round trip
  with an array parameter:

```sql
SELECT pm.project_id, u.display_name, pm.role
FROM project_members pm JOIN users u ON u.id = pm.user_id
WHERE pm.project_id = ANY($1);          -- $1 = int[] {1,3,5}, one round trip
```

`= ANY($1)` with a single array parameter is better than building `IN ($1, $2, …, $97)`: there's
one statement shape for any list length, so prepared statements and `pg_stat_statements` group it
properly. GraphQL servers do the same thing with *DataLoader*.

:::sql id=db-17-sql4 db=studio ordered=true xp=50
title: Replace the N+1 with one query
Write the single query the project list endpoint should send. For **every** project return:
`id`, `title`, the owner's `display_name`, and `clip_count` (number of clips, `0` if none),
ordered by project `id`.

hint: JOIN users for the owner, LEFT JOIN clips, GROUP BY the project.
hint: `count(c.id)` counts only matched clips; `count(*)` would count 1 for a project without clips.

```sql starter
SELECT p.id, p.title, u.display_name, count(*) AS clip_count
FROM projects p
JOIN users u ON u.id = p.owner_id
JOIN clips c ON c.project_id = p.id
GROUP BY p.id, p.title, u.display_name
ORDER BY p.id;
```

```sql solution
SELECT p.id, p.title, u.display_name, count(c.id) AS clip_count
FROM projects p
JOIN users u ON u.id = p.owner_id
LEFT JOIN clips c ON c.project_id = p.id
GROUP BY p.id, p.title, u.display_name
ORDER BY p.id;
```
:::

:::job title="N+1 in code review"
You'll spot N+1s in PRs by looking for `await` inside a `foreach` over query results, and for
navigation properties accessed in a loop with lazy loading on. Many teams turn lazy loading off
entirely and add a test or middleware that fails when a request issues more than N queries.
"How many queries does this endpoint run?" is a very common senior-review question.
:::

:::quiz id=db-17-q6 xp=15
An endpoint loads 50 projects and, in a `foreach`, awaits `db.Clips.CountAsync(c => c.ProjectId == p.Id)`
and reads `p.Owner.DisplayName` (lazy loading on; the 50 projects have 50 different owners, none
loaded yet). Each query executes in
0.2 ms; the database is 1 ms away. Roughly how long does the endpoint wait on the database, and
what's the best fix?

- [ ] ~10 ms — the queries are fast, so there's nothing to fix
- [ ] ~100 ms — add an index on `clips.project_id`
- [x] ~120 ms for 101 round trips — replace the loop with one projected query (`Select` with `p.Owner.DisplayName` and `p.Clips.Count()`)
- [ ] ~120 ms — add `Include(p => p.Clips)` so the counts are cached
> 1 + 2 × 50 = 101 round trips × (1 ms network + 0.2 ms execution) ≈ 120 ms, almost all of it
> network latency. An index makes each tiny query a bit faster but keeps all 101 round trips.
> `Include(p => p.Clips)` would remove the count queries but download **every clip row** just to
> count them (and still lazy-load owners unless you also include `Owner`). A projection lets EF
> Core send one JOIN + `count` query that returns exactly the 50 rows you need.
:::

## Statistics: how the planner guesses

Every plan decision (index or not, hash or nested loop) depends on **row-count estimates**, and
those come from statistics that `ANALYZE` collects (autovacuum runs it after enough rows change).
You can read them:

```sql
SELECT attname, null_frac, n_distinct, most_common_vals, most_common_freqs
FROM pg_stats WHERE tablename = 'render_jobs';
```

- `n_distinct`: number of distinct values. Negative means a fraction of the row count
  (`-1` = unique).
- `most_common_vals` / `most_common_freqs`: the MCV list, e.g. `{done, queued}` with `{0.93, 0.04}`.
- `histogram_bounds`: equal-population buckets for the remaining values (used for ranges).
- The detail level is `default_statistics_target` (100). For a skewed, important column you can
  raise it: `ALTER TABLE events ALTER COLUMN tenant_id SET STATISTICS 1000; ANALYZE events;`

Three situations make estimates go badly wrong:

1. **Stale stats** after a bulk load or a big delete. Run `ANALYZE table` as the last step of any
   import job or migration that moves a lot of data.
2. **Correlated columns.** The planner assumes conditions are *independent* and multiplies their
   selectivities. Say 2% of addresses are in Munich and 0.1% have zip `80331`:
   `city = 'Munich' AND zip = '80331'` is estimated at 2% × 0.1% = 0.002%. But every 80331 *is* in
   Munich, so the real answer is the full 0.1% — a 50× underestimate. Thinking "only a handful of
   rows", the planner picks a nested loop that then runs 50× more often than planned.
3. **Opaque expressions**: `WHERE (doc->>'fps')::int > 30` has no statistics at all unless an
   expression index (or extended statistics on the expression) exists. The planner then falls
   back to hard-coded guesses: 0.5% of rows for `=`, a third of the rows for `<`/`>`.

**Extended statistics** fix the correlation case:

```sql
CREATE STATISTICS addr_city_zip (dependencies, mcv) ON city, zip FROM addresses;
ANALYZE addresses;   -- extended stats are only filled by ANALYZE
```

| Kind | Teaches the planner | Helps |
|---|---|---|
| `ndistinct` | the number of distinct *combinations* | `GROUP BY city, zip` estimates |
| `dependencies` | "zip determines city" (functional dependency) | `WHERE city = ? AND zip = ?` |
| `mcv` | most common *combinations* and their frequencies | skewed multi-column filters, also `<`/`>` |

:::sql id=db-17-sql5 db=empty xp=60
title: Teach the planner about correlated columns
In `addresses`, `zip` determines `city`. For `WHERE city = 'city7' AND zip = 'zip7-1'` the real
answer is 67 rows, but the planner multiplies the two selectivities and estimates **1 row**. With
estimates like that, joins against this table get planned as nested loops.

Fix the estimate: create **extended statistics** on `(city, zip)` (any name, `dependencies` and/or
`mcv`) and make sure the planner actually has them.

The grader reads the estimated `rows=` from `EXPLAIN` and checks that it's between 30 and 150.

hint: `CREATE STATISTICS name (dependencies) ON col1, col2 FROM table;`
hint: Extended statistics are empty until the next `ANALYZE`.

```sql setup
CREATE TABLE addresses (id int PRIMARY KEY, city text NOT NULL, zip text NOT NULL);
INSERT INTO addresses
SELECT g, 'city' || (g % 100), 'zip' || (g % 100) || '-' || (g % 3)
FROM generate_series(1, 20000) g;
ANALYZE addresses;
```

```sql starter
EXPLAIN SELECT * FROM addresses WHERE city = 'city7' AND zip = 'zip7-1';
```

```sql solution
CREATE STATISTICS addr_city_zip (dependencies) ON city, zip FROM addresses;
ANALYZE addresses;
```

```sql check
CREATE OR REPLACE FUNCTION est_rows(q text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  EXECUTE 'EXPLAIN ' || q INTO r;   -- first line of the plan
  RETURN substring(r FROM 'rows=(\d+)')::int;
END $$;
SELECT est_rows($q$SELECT * FROM addresses WHERE city = 'city7' AND zip = 'zip7-1'$q$)
       BETWEEN 30 AND 150 AS estimate_ok;
```
:::

:::quiz id=db-17-q2 xp=15
A nightly job loads 3 million rows into `staging_events` with `COPY`, then immediately runs a
report joining it to `users`. The report takes 40 minutes on some nights and 30 seconds on
others. What's the most likely cause and fix?

- [ ] COPY bypasses indexes; rebuild them with REINDEX
- [x] The report sometimes runs before autovacuum has analyzed the new data, so the planner uses stale or empty statistics. Run `ANALYZE staging_events` right after the load.
- [ ] `work_mem` is randomly assigned; set it per session
- [ ] COPY leaves the table locked until VACUUM FULL
> Freshly loaded tables look tiny or empty to the planner until `ANALYZE` runs. Autovacuum's
> analyze happens on its own schedule, so some nights it wins the race and some nights it loses.
> Putting `ANALYZE` in the load script makes the plan deterministic. `COPY` does maintain the
> indexes (so REINDEX is pointless), takes only a `ROW EXCLUSIVE` lock, and `work_mem` isn't random —
> the 40-minute nights are a different *plan*, not a slower machine.
:::

## CTEs: inlined or materialized?

Before PostgreSQL 12, every CTE (`WITH x AS (…)`) was an **optimization fence**: it ran first and
was stored, and filters from the outer query couldn't be pushed into it. A lot of old blog
advice ("CTEs are slow", "use CTEs to force a plan") comes from that era.

Since PG 12, a CTE that is **side-effect free and referenced once** is **inlined**, treated like a
subquery, so outer filters reach the base tables and indexes. You control it explicitly:

```sql
-- Inlined (default here): WHERE user_id = 42 is pushed down to an index on credit_ledger
WITH balances AS (
  SELECT user_id, sum(delta) AS balance FROM credit_ledger GROUP BY user_id
)
SELECT * FROM balances WHERE user_id = 42;

-- Force it to be computed once and stored, e.g. an expensive CTE referenced several times
WITH expensive AS MATERIALIZED (
  SELECT project_id, count(*) AS n FROM render_jobs WHERE status = 'failed' GROUP BY project_id
)
SELECT … FROM expensive a JOIN expensive b ON …;

-- Force inlining even though it's referenced twice
WITH recent AS NOT MATERIALIZED (SELECT * FROM events WHERE created_at > now() - interval '1 day')
SELECT …;
```

A CTE is **always materialized** when it's referenced more than once (unless you say `NOT
MATERIALIZED`), when it's `RECURSIVE`, when it modifies data (`WITH moved AS (DELETE … RETURNING
…)`), or when it contains volatile functions (`random()`, `nextval()`) or a locking clause
(`FOR UPDATE`) — inlining those could change how often they run. Materializing pays off when the CTE is expensive and reused, or small and selective. It hurts
when the outer query would have filtered most of the rows away.

:::quiz id=db-17-q3 xp=15
On PostgreSQL 18, which of these CTEs will be **materialized** (computed once, outer filters not
pushed in)? Select all that apply.

- [ ] `WITH a AS (SELECT …) SELECT * FROM a WHERE id = 5`, with `a` referenced once
- [x] `WITH a AS (SELECT …) SELECT … FROM a x JOIN a y ON …`, with `a` referenced twice
- [x] `WITH a AS MATERIALIZED (SELECT …) SELECT * FROM a WHERE id = 5`
- [x] `WITH moved AS (DELETE FROM jobs WHERE … RETURNING *) INSERT INTO jobs_archive SELECT * FROM moved`
- [ ] `WITH a AS NOT MATERIALIZED (SELECT …) SELECT … FROM a x JOIN a y ON …`
> Inlining is the default for a single, side-effect-free reference. Multiple references, the
> explicit `MATERIALIZED` keyword and data-modifying CTEs are materialized. `NOT MATERIALIZED`
> forces inlining even with two references, so the subquery is simply evaluated twice.
:::

## Batch writes

Row-by-row writes are the N+1 of the write path. 10 000 single `INSERT`s at 1 ms round trip each
take 10 seconds, and in autocommit mode each one is also its own transaction with its own WAL
flush. The same 10 000 rows sent as one statement take well under 100 ms.

From slowest to fastest:

```sql
-- 1. Many statements in ONE transaction (at least one commit / WAL flush instead of 10 000)
BEGIN; INSERT …; INSERT …; …; COMMIT;

-- 2. Multi-row VALUES (watch the 65 535 bind-parameter limit; chunk at ~1 000 rows)
INSERT INTO clips (id, project_id, parent_clip_id, title, duration_ms)
VALUES (20, 4, 12, 'Left', 3000), (21, 4, 12, 'Right', 3200);

-- 3. Arrays + unnest: one statement, a fixed number of parameters regardless of row count
INSERT INTO clips (id, project_id, parent_clip_id, title, duration_ms)
SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::text[], $5::int[]);

-- 4. COPY: the bulk-load protocol; fastest by far for big imports
COPY clips (id, project_id, parent_clip_id, title, duration_ms) FROM STDIN (FORMAT binary);
```

```csharp
// Npgsql binary COPY: hundreds of thousands of rows per second
await using var writer = await conn.BeginBinaryImportAsync(
    "COPY clips (id, project_id, title, duration_ms) FROM STDIN (FORMAT binary)");
foreach (var c in clips)
{
    await writer.StartRowAsync();
    await writer.WriteAsync(c.Id); await writer.WriteAsync(c.ProjectId);
    await writer.WriteAsync(c.Title); await writer.WriteAsync(c.DurationMs);
}
await writer.CompleteAsync();
```

The `unnest` trick works for **updates** too. Send parallel arrays and join against them:

```sql
UPDATE clips AS c
SET duration_ms = v.ms
FROM unnest($1::int[], $2::int[]) AS v(id, ms)
WHERE c.id = v.id;
```

EF Core 7+ has `ExecuteUpdateAsync` / `ExecuteDeleteAsync` for set-based changes without loading
entities, and EF Core sends all INSERT/UPDATE/DELETE statements of one `SaveChanges` to Postgres as a
single batch (one round trip), not one round trip per entity. For
real bulk work, drop to Npgsql `COPY`.

:::sql id=db-17-sql6 db=studio xp=50
title: One UPDATE for many rows
The editor's "auto-trim" feature sends new durations for several clips at once. Clip ids and
durations arrive as two parallel arrays: ids `{2,4,6}` with durations `{8200,6100,5400}`.

Apply all three changes with **one** `UPDATE` that joins against `unnest` of the two arrays.

The grader checks `id, duration_ms` of all clips.

hint: `UPDATE clips c SET … FROM unnest(ARRAY[…], ARRAY[…]) AS v(id, ms) WHERE c.id = v.id;`

```sql starter
UPDATE clips SET duration_ms = 8200 WHERE id = 2;
```

```sql solution
UPDATE clips AS c
SET duration_ms = v.ms
FROM unnest(ARRAY[2, 4, 6], ARRAY[8200, 6100, 5400]) AS v(id, ms)
WHERE c.id = v.id;
```

```sql check
SELECT id, duration_ms FROM clips ORDER BY id;
```
:::

### Big deletes and updates: do them in chunks

The opposite problem: `DELETE FROM audit_log WHERE created_at < '2024-01-01'` on 80 million rows
runs as **one huge transaction**. While it runs it holds row locks on everything it touched,
produces gigabytes of WAL at once (read replicas fall behind), leaves 80 million dead tuples for
VACUUM, and if it fails at 95% everything rolls back. Production teams process it **in chunks**,
committing between batches:

```sql
-- run in a loop (app code, a job, or a procedure with COMMIT) until it deletes 0 rows
DELETE FROM audit_log
WHERE id IN (
  SELECT id FROM audit_log
  WHERE created_at < '2024-01-01'
  ORDER BY id
  LIMIT 5000
);
```

Each batch is short, locks little and can be throttled (`pg_sleep(0.1)` between batches). The
same pattern backfills new columns in zero-downtime migrations (lesson 16). For data you
regularly drop by age, **partitioning** by month turns the whole thing into `DROP TABLE
audit_log_2023_12`, which is instant.

:::sql id=db-17-sql7 db=empty xp=50
title: One batch of a chunked cleanup
`audit_log` has 10 000 rows. Retention says everything before `2025-01-05` must go, but you
delete in batches of **1 000**, oldest first (by `id`), so no single transaction gets big.

Write the statement for **one batch**: delete the 1 000 lowest-`id` rows that are older than
`2025-01-05`. Nothing else may be deleted.

The grader checks `count(*)`, `min(id)` and `max(id)` of what's left.

hint: `DELETE … WHERE id IN (SELECT id … WHERE … ORDER BY id LIMIT 1000)`

```sql setup
CREATE TABLE audit_log (
  id         bigint PRIMARY KEY,
  action     text      NOT NULL,
  created_at timestamp NOT NULL
);
INSERT INTO audit_log
SELECT g, (ARRAY['login','publish','delete','invite'])[1 + g % 4],
       timestamp '2025-01-01' + g * interval '1 minute'
FROM generate_series(1, 10000) g;
```

```sql starter
DELETE FROM audit_log WHERE created_at < '2025-01-05';
```

```sql solution
DELETE FROM audit_log
WHERE id IN (
  SELECT id FROM audit_log
  WHERE created_at < '2025-01-05'
  ORDER BY id
  LIMIT 1000
);
```

```sql check
SELECT count(*), min(id), max(id) FROM audit_log;
```
:::

:::pro title="A senior's tuning checklist"
1. Find the expensive queries by **total** time (`pg_stat_statements`), not by gut feeling.
2. `EXPLAIN (ANALYZE, BUFFERS)` on production-sized data. Fix bad **estimates** before bad plans.
3. Make predicates sargable, then add the composite, partial or covering index that fits.
4. Count queries per request and kill N+1s with JOINs, `Include`/`AsSplitQuery` or `= ANY($1)`.
5. Page with keyset cursors, write in batches (`unnest`, `COPY`), delete and backfill in chunks.
6. Only then touch server settings (`work_mem`, `random_page_cost`, `shared_buffers`), and change
   one thing at a time with before/after measurements.
:::

:::cards id=db-17-cards1 xp=20 title="Performance tuning"
Q: Why does `OFFSET 50000` get slow?
A: Postgres must produce and discard 50 000 rows before returning the page, so cost grows linearly with the page number.
Q: What does keyset pagination need?
A: A total order with a unique tiebreaker (`created_at, id`), a row comparison `(created_at, id) < ($1, $2)`, and a matching index.
Q: What does `INCLUDE` do in an index?
A: Adds payload columns to the leaf entries, not to the key, so more queries can be Index Only Scans without changing sort order or uniqueness.
Q: What does `Heap Fetches` in an Index Only Scan tell you?
A: How many rows still had to be checked in the heap because their page wasn't all-visible. High numbers mean VACUUM is behind.
Q: What makes a predicate sargable?
A: The indexed column stands alone on one side (`col >= $1`). Functions, casts or arithmetic on the column hide it from the index.
Q: Why can a C# `decimal` parameter make `WHERE id = $1` on a `bigint` column slow?
A: It's sent as `numeric`; there's no `bigint = numeric` index operator, so Postgres casts the column (`id::numeric`) and can't use the index. Match the parameter type to the column.
Q: Rewrite `WHERE created_at::date = '2025-06-01'`
A: `WHERE created_at >= '2025-06-01' AND created_at < '2025-06-02'` (half-open range).
Q: Three fixes for an ORM N+1
A: Project into one query (JOIN + aggregate), eager-load (`Include`, `AsSplitQuery` for several collections), or batch by key with `= ANY($1)`.
Q: Why do correlated columns break estimates, and what fixes it?
A: The planner multiplies selectivities as if the columns were independent. `CREATE STATISTICS … (dependencies, mcv)` plus `ANALYZE` fixes it.
Q: When is a CTE materialized in PG 12+?
A: When it's referenced more than once, recursive, data-modifying, contains volatile functions or `FOR UPDATE`, or is marked `MATERIALIZED`. Otherwise it's inlined.
Q: Fastest way to bulk-load rows from C#?
A: Npgsql binary `COPY` (`BeginBinaryImportAsync`). Next best is one INSERT with `unnest` arrays.
Q: Why delete old rows in chunks?
A: Short transactions keep locks small, spread out WAL so replicas keep up, make failures cheap to retry, and let VACUUM keep pace.
:::

## Recap

- Measure first: `pg_stat_statements` by total time, then `EXPLAIN (ANALYZE, BUFFERS)`.
- Replace `OFFSET` with keyset pagination on a unique, indexed sort key.
- Covering indexes (`INCLUDE`) turn hot reads into Index Only Scans. Keep the visibility map
  fresh with VACUUM.
- Keep indexed columns naked: use ranges instead of casts and functions on the column, and cast
  the parameter instead of the column.
- N+1 is the top ORM bug. Look at the SQL log, then JOIN, eager-load or batch with `ANY`.
- Estimates drive plans: `ANALYZE` after bulk loads, extended statistics for correlated columns.
- CTEs are inlined unless reused, recursive, writing, volatile/locking, or `MATERIALIZED`.
- Write in batches (`unnest`, `COPY`), and delete or backfill big tables in chunks.
