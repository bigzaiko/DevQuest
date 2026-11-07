---
id: db-11
title: Indexes & EXPLAIN
level: advanced
minutes: 70
xp: 200
summary: How B-tree indexes really work, how to read EXPLAIN like a senior, and how to pick composite, partial, expression, BRIN and GiST indexes without slowing down your writes.
---

Every production team has the same story. A page that loaded in 40 ms in staging takes 4 seconds
in production, because staging has 500 rows and production has 5 million. Nobody changed the
code; the data grew. Nine times out of ten the fix is one well-chosen index, and the tenth time it
is *removing* an index or rewriting the query so an existing index can be used.

This lesson gives you the mental model to make those calls: what an index physically is, how the
PostgreSQL planner decides whether to use it, and how to read the `EXPLAIN` output that tells you
what actually happened.

## What an index is (and what it costs)

A table in PostgreSQL is stored as a **heap**: 8 KB pages with rows in whatever order they were
written. Finding `WHERE email = 'ivy@studio.dev'` in a heap means reading every page, a
**sequential scan**. That is fine for 6 users. With 6 million users it is a 2 GB read for every
login.

An **index** is a separate data structure, kept in sync with the table on every write, that maps
*values* to the physical location of rows (a **TID**: page number + slot in the page). Two
consequences follow, and the rest of this lesson builds on both:

1. Reads that match the index get **much** faster: they touch a handful of pages instead of all of them.
2. Every `INSERT`, every `DELETE`, and every `UPDATE` of an indexed column gets **slower**, because
   each index must be updated too. Indexes also take disk space and RAM in the buffer cache.

An index is a trade: you pay on every write so that some reads go faster. Senior engineers make
that trade on purpose, for queries they know the app runs.

## How a B-tree works

`CREATE INDEX` without `USING …` builds a **B-tree** (balanced tree). It is the right index for
about 95% of cases: equality, ranges, sorting, uniqueness.

```text
                         ┌─────────────────────────┐
  root page              │  ...   m   ...   t   ... │
                         └────┬────────┬────────┬───┘
               ┌──────────────┘        │        └──────────────┐
      ┌────────▼────────┐     ┌────────▼────────┐     ┌────────▼────────┐
inner │ a  ...  f  ... k│     │ m  ...  p  ... s│     │ t  ...  w  ... z│
      └──┬──────────────┘     └──┬──────────────┘     └──┬──────────────┘
         ▼                       ▼                       ▼
leaf  [ada→(0,1)][ali→(4,7)] ⇄ [mara→(0,3)][max→(9,2)] ⇄ [tom→(3,3)] ...   (sorted, doubly linked)
```

- **Leaf pages** hold `(key, TID)` entries, **sorted** by key and linked to their neighbors.
- **Inner pages** hold separator keys that say which child page covers which key range.
- Every leaf is at the same depth, so the tree is always *balanced*.

A page is 8 KB, so an inner page holds a few hundred separators. With a **fan-out** of ~300:
3 levels cover 300³ ≈ 27 million rows and 4 levels about 8 billion. Finding one key therefore
costs 3–4 page reads, and the top levels are almost always cached in RAM. That is why an indexed
lookup on a huge table still takes well under a millisecond.

Because the leaves are sorted and linked, a B-tree also gives you **ranges** for free: find the
first key `>= '2025-06-01'`, then walk right along the leaves until you pass the end of the range.
For the same reason it can return rows **already sorted**, so `ORDER BY created_at LIMIT 20` can
read 20 entries and stop without sorting anything.

### What a B-tree can and cannot answer

| Predicate on indexed column `c` | B-tree helps? | Why |
|---|---|---|
| `c = 42`, `c IN (1,2,3)`, `c = ANY($1)` | ✅ | descend to the key(s) |
| `c > x`, `c BETWEEN x AND y` | ✅ | descend, then walk the leaves |
| `ORDER BY c [DESC] LIMIT n` | ✅ | leaves are already sorted, in either direction |
| `c IS NULL` | ✅ | NULLs are stored in the index too |
| `c LIKE 'abc%'` | ⚠️ | only with `text_pattern_ops` or the `C` collation |
| `c LIKE '%abc'` | ❌ | no fixed prefix to descend to |
| `lower(c) = 'x'`, `c + 1 = 5`, `c::date = …` | ❌ | the index stores `c`, not `f(c)` |
| `c <> 42` | ❌ in practice | matches almost everything |

The "function on the column" row is the one you will hit most often in real code. Later in this
lesson you'll fix it two ways: with an expression index, and by rewriting the predicate.

:::warn title="Foreign keys are not indexed automatically"
`PRIMARY KEY` and `UNIQUE` constraints create an index. `REFERENCES` does **not**. In the studio
schema, `clips.project_id` has no index, so "all clips of project 5" is a sequential scan, and
so is the check Postgres runs on `DELETE FROM projects` (`ON DELETE CASCADE` has to find the child
rows). Index the FK columns you join or filter on. That covers almost all of them.
:::

:::sql id=db-11-sql1 db=studio xp=30
title: Index the foreign key
The editor loads every clip of a project with `SELECT … FROM clips WHERE project_id = $1`.
Create a B-tree index named **`clips_project_id_idx`** on `clips(project_id)`.

The grader checks the index definitions on `clips` after your SQL.

hint: `CREATE INDEX name ON table (column);`

```sql starter
-- Postgres did not create this index for the foreign key.

```

```sql solution
CREATE INDEX clips_project_id_idx ON clips (project_id);
```

```sql check
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'clips'
ORDER BY indexname;
```
:::

## Reading EXPLAIN

Before you add an index, find out what the planner is doing *now*. `EXPLAIN` shows the plan it
picked. `EXPLAIN ANALYZE` also **runs** the query and adds what actually happened.

Here is `EXPLAIN` on a 40 000-row `events` table, filtering on a column without an index:

```text
Seq Scan on events  (cost=0.00..795.00 rows=200 width=26)
  Filter: (tenant_id = 7)
```

| Part | Meaning |
|---|---|
| `Seq Scan on events` | the node type: read the whole heap |
| `cost=0.00..795.00` | estimated **startup** cost (before the first row comes out) .. **total** cost (all rows), in arbitrary units where 1 ≈ one sequential page read. A node's cost includes its children's. |
| `rows=200` | the planner's **estimate** of the rows this node returns |
| `width=26` | estimated average row size in bytes |
| `Filter:` | a condition checked on every row *after* reading it |

After `CREATE INDEX ON events (tenant_id)` the same query gives:

```text
Bitmap Heap Scan on events  (cost=5.84..287.46 rows=200 width=26)
  Recheck Cond: (tenant_id = 7)
  ->  Bitmap Index Scan on events_tenant_id_idx  (cost=0.00..5.79 rows=200 width=0)
        Index Cond: (tenant_id = 7)
```

Read plans **from the innermost (most indented) node outwards**. Each `->` is a child that feeds
rows to its parent. Here the Bitmap Index Scan runs first and its output feeds the Bitmap Heap
Scan. Total cost dropped from 795 to 287. `Index Cond` means the index did the filtering. A
`Filter` line means rows were read first and thrown away afterwards. (`Recheck Cond` is always
printed for bitmap scans. For a B-tree it only does work when the bitmap became *lossy*: too many
rows for `work_mem`, so it remembers whole pages instead of exact rows and must re-test each row.
Some index types, such as GIN on jsonb, always recheck, because the index itself can return false
positives.)

### The scan types you'll see

| Node | What it does | Typical when |
|---|---|---|
| **Seq Scan** | reads every page of the table | small tables, or the query needs a big fraction of rows |
| **Index Scan** | walks the index, fetches each matching row from the heap | few rows, or rows needed in index order (`ORDER BY … LIMIT`) |
| **Index Only Scan** | answers from the index alone, never touches the heap (if the visibility map says the page is all-visible) | every selected column is in the index |
| **Bitmap Index Scan + Bitmap Heap Scan** | collects matching TIDs into a bitmap sorted by page, then reads each needed page once | "medium" selectivity: too many rows for random index lookups, too few for a seq scan; also to combine indexes (`BitmapAnd` / `BitmapOr`) |

And for joins:

| Join node | How | Good when |
|---|---|---|
| **Nested Loop** | for each outer row, look up matching inner rows (ideally via an index) | outer side is small: `WHERE o.id = 5` then fetch its customer |
| **Hash Join** | build a hash table of the smaller side, probe it with the bigger side | large unsorted inputs, equality joins |
| **Merge Join** | walk two inputs that are both sorted on the join key | both sides already sorted (e.g. from indexes) or very large |

Here is a real pair from a `customers` (3 000) × `orders` (30 000) join. Joining *everything*
picks a hash join; asking for one order picks a nested loop with two index lookups:

```text
Hash Join                                   Nested Loop
  Hash Cond: (o.customer_id = c.id)           ->  Index Scan using orders_pkey on orders o
  ->  Seq Scan on orders o                          Index Cond: (id = 5)
  ->  Hash                                    ->  Index Scan using customers_pkey on customers c
        ->  Seq Scan on customers c                 Index Cond: (id = o.customer_id)
```

Neither plan is "bad". A seq scan plus a hash join is the fastest way to join two whole tables.

### EXPLAIN ANALYZE: estimates vs reality

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM events WHERE tenant_id = 7 AND created_at >= '2025-01-10' ORDER BY created_at;
```

```text
Sort (actual rows=135.00 loops=1)
  Sort Key: created_at
  Sort Method: quicksort  Memory: 23kB
  Buffers: shared hit=200 read=2
  ->  Bitmap Heap Scan on events (actual rows=135.00 loops=1)
        Recheck Cond: (tenant_id = 7)
        Filter: (created_at >= '2025-01-10 00:00:00'::timestamp without time zone)
        Rows Removed by Filter: 65
        Heap Blocks: exact=200
        Buffers: shared hit=200 read=2
        ->  Bitmap Index Scan on events_tenant_id_idx (actual rows=200.00 loops=1)
              Index Cond: (tenant_id = 7)
              Index Searches: 1
              Buffers: shared read=2
Execution Time: 0.247 ms
```

(Costs and per-node timings are trimmed here for readability; you'd normally see both
`cost=…` and `actual time=…` on every node. PostgreSQL 18 prints `actual rows` with two
decimals, because it's an average over `loops`.)

The things to look at, in order:

1. **Estimated vs actual rows** on each node. Within a factor of ~10 is fine. If the estimate is
   `rows=1` and the actual is `rows=48000`, the planner chose its strategy from a wrong picture,
   and that is the most common cause of a terrible plan. The usual fix is fresh statistics
   (`ANALYZE`), sometimes extended statistics (next lesson, Performance Tuning).
2. **`Rows Removed by Filter`**: work done and thrown away. Here 65 of 200 rows were read only to
   be discarded, because the index covers `tenant_id` but not `created_at`.
3. **`loops=N`**: the node ran N times (inner side of a nested loop). Multiply per-loop numbers by N.
4. **`Buffers: shared hit=… read=…`**: pages found in Postgres's cache (`hit`) vs fetched from
   the OS/disk (`read`). This is the most honest measure of work: timing changes with cache
   warmth, the total buffer count doesn't. Since PostgreSQL 18, `EXPLAIN ANALYZE` includes
   buffers automatically; on 17 and older you must ask for `BUFFERS` explicitly.
5. **`Sort Method: external merge  Disk: …`**: the sort spilled to disk because `work_mem` was too small.
6. **`Index Searches: N`** (new in PostgreSQL 18): how many times the index was descended. With the new
   B-tree *skip scan* it can be more than 1.

:::warn title="EXPLAIN ANALYZE executes the statement"
`EXPLAIN ANALYZE DELETE FROM users …` **really deletes**. To profile writes, wrap them:
`BEGIN; EXPLAIN ANALYZE UPDATE …; ROLLBACK;`
:::

:::tip title="Try it here"
Every SQL challenge on this site is a real PostgreSQL 18. Paste `EXPLAIN SELECT * FROM clips WHERE
project_id = 5;` into any studio challenge editor and run it. On tiny tables you'll mostly see Seq
Scans. That is correct: reading one 8 KB page beats walking an index.
:::

## When does Postgres use an index?

The planner is **cost-based**. For each possible plan it estimates the pages it would read
(sequential pages are cheap, `seq_page_cost = 1`; random pages cost more, `random_page_cost = 4`
by default, which teams on SSDs often lower to 1.1–1.5) plus CPU per row. Then it picks the
cheapest. Those estimates come from **statistics** gathered by `ANALYZE` (run automatically by
autovacuum): row count, fraction of NULLs, the most common values and their frequencies, and a
histogram of the rest.

So whether an index gets used depends mostly on **selectivity**, the fraction of rows that match:

| Matching rows | Likely plan |
|---|---|
| 1 row, or a few (PK, unique email) | Index Scan |
| ~0.1% – 5% | Bitmap Index/Heap Scan |
| more than ~5–20% | Seq Scan, because reading everything in order beats jumping around |

On the same `events` table, `WHERE tenant_id = 7` (0.5% of rows) used the index, but
`WHERE tenant_id < 150` (75% of rows) went straight back to a `Seq Scan`, *even though the index
exists*. That is not a bug. The planner did the math and the index would have been slower.

:::quiz id=db-11-q1 xp=15
`users.plan` has a B-tree index. 92% of 2 million users are on the `free` plan. Which plans do you
expect for these two queries?

```sql
SELECT * FROM users WHERE plan = 'free';   -- (A)
SELECT * FROM users WHERE plan = 'team';   -- (B)
```

- [ ] Both use the index; that's what it's for
- [x] (A) Seq Scan, (B) Index or Bitmap scan
- [ ] (A) Index Scan, (B) Seq Scan
- [ ] Both Seq Scan; indexes on low-cardinality columns are never used
> The statistics record that `'free'` covers 92% of rows, so reading the whole table in order is
> cheaper than visiting 1.8M rows through the index. `'team'` is rare, so the index wins. The same
> index can be used for one value and ignored for another. "Never used on low-cardinality
> columns" is a myth: what matters is the selectivity of the *value you ask for*, not how many
> distinct values the column has. (If you only ever query the rare value, a *partial index*
> `WHERE plan = 'team'` is even smaller, as you'll see below.)
:::

## Composite indexes: column order is everything

A multicolumn index `(a, b)` is sorted by `a`, and **within equal `a`** by `b`, like a phone book
sorted by last name, then first name. The phone book is great for "Smith, John" and for "all
Smiths". It is useless for "everyone named John", because the Johns are scattered across every
last name.

Take the studio analytics feed, which shows a tenant's recent events:

```sql
SELECT * FROM events
WHERE tenant_id = $1 AND created_at >= $2
ORDER BY created_at DESC
LIMIT 50;
```

With `(tenant_id, created_at)` all events of tenant 7 sit next to each other in the index, already
sorted by time. Postgres descends once to the **newest** entry of tenant 7, walks the leaves
backwards for 50 entries and stops. There is no `Sort` node and no `Filter` line:

```text
Limit (actual rows=50.00 loops=1)
  ->  Index Scan Backward using events_tenant_id_created_at_idx on events (actual rows=50.00 loops=1)
        Index Cond: ((tenant_id = 7) AND (created_at >= '2025-01-10 00:00:00'::timestamp without time zone))
        Index Searches: 1
```

`Index Scan Backward` is how a plain ascending index serves `ORDER BY … DESC`: same index, read
right-to-left. Note also that `Limit` stopped the scan early: of the 135 matching rows only 50
were ever read.

With the columns reversed, `(created_at, tenant_id)`, the index is sorted by time first, so the
events of tenant 7 are spread over the entire range and Postgres must scan every tenant's events
since `$2` and skip the others.

**Rules of thumb for column order:**

1. Columns compared with **equality** (`=`, `IN`) first.
2. Then **one** range or sort column (`>=`, `BETWEEN`, `ORDER BY`). After the first range column,
   later columns can only be checked as filters inside the index, not used to narrow the descent.
3. Among equality columns, order matters less. Choose the order that also serves your *other*
   queries, since `(a, b)` also serves `WHERE a = ?` alone.
4. `DESC` in the index rarely matters for single-column order (B-trees walk both directions). It
   matters for mixed directions like `ORDER BY a ASC, b DESC`.

:::info title="PostgreSQL 18: skip scan"
Since PG 18 a B-tree can do a **skip scan**: for `WHERE created_at >= $2` on an index
`(tenant_id, created_at)` it can jump through each distinct `tenant_id` and search inside it. It
helps when the leading column has *few* distinct values (a `status` or `region`). It does not
replace good column order. Look for `Index Searches: N` in `EXPLAIN ANALYZE`.
:::

:::quiz id=db-11-q2 xp=15
You have `CREATE INDEX ON events (tenant_id, created_at)`. Which queries can use it **efficiently**
(narrowing the descent, not scanning the whole index)? Select all that apply.

- [x] `WHERE tenant_id = 7`
- [x] `WHERE tenant_id = 7 AND created_at >= '2025-06-01'`
- [x] `WHERE tenant_id = 7 ORDER BY created_at DESC LIMIT 20`
- [ ] `WHERE created_at >= '2025-06-01'` (with 10 000 distinct tenants)
- [x] `WHERE tenant_id IN (7, 8) AND created_at < '2025-02-01'`
> The leading column must be constrained to narrow the descent. `IN` on the leading column is
> just several equality descents. Filtering only on `created_at` with thousands of tenants means
> the matching entries are spread across the whole index. Skip scan won't help with that many
> distinct leading values, so you'd want a separate index on `created_at`.
:::

:::sql id=db-11-sql2 db=empty xp=50
title: The activity-feed index
The `events` table (40 000 rows) serves this query on every dashboard load:

```sql
SELECT * FROM events
WHERE tenant_id = $1 AND created_at >= $2
ORDER BY created_at DESC LIMIT 50;
```

Create **one** B-tree index (any name) that lets Postgres answer it with a single index descent,
no sort and no filter. The starter has the columns in the wrong order. Fix it.

The grader compares the index's key columns (`DESC` is optional).

hint: Equality column first, then the range/sort column.

```sql setup
CREATE TABLE events (
  id         bigint PRIMARY KEY,
  tenant_id  int       NOT NULL,
  kind       text      NOT NULL,
  created_at timestamp NOT NULL
);
INSERT INTO events
SELECT g, g % 200, (ARRAY['view','click','choice','share'])[1 + g % 4],
       timestamp '2025-01-01' + g * interval '1 minute'
FROM generate_series(1, 40000) g;
ANALYZE events;
```

```sql starter
CREATE INDEX ON events (created_at, tenant_id);
```

```sql solution
CREATE INDEX events_tenant_created_idx ON events (tenant_id, created_at);
```

```sql check
SELECT regexp_replace(regexp_replace(indexdef, 'INDEX \S+ ON', 'INDEX ON'), ' DESC', '', 'g')
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'events' AND indexname <> 'events_pkey'
ORDER BY 1;
```
:::

## Covering indexes and Index Only Scans

Even a perfect Index Scan still visits the **heap** for every matching row, to fetch the columns
the index doesn't contain. If the index holds **every column the query needs**, Postgres can skip
the heap entirely: an **Index Only Scan**. Say the feed only needs `created_at` and `kind`:

```sql
SELECT created_at, kind FROM events
WHERE tenant_id = 7 AND created_at >= '2025-01-10';
```

With `(tenant_id, created_at)` that is a Bitmap Heap Scan (135 heap pages visited, because `kind`
lives only in the heap). Add `kind` as a **non-key "payload" column** with `INCLUDE`:

```sql
CREATE INDEX events_tenant_created_kind_idx
  ON events (tenant_id, created_at) INCLUDE (kind);
VACUUM events;  -- sets the visibility map (autovacuum would do this eventually)
```

After `VACUUM events` has set the visibility map, the plan becomes:

```text
Index Only Scan using events_tenant_created_kind_idx on events (actual rows=135.00 loops=1)
  Index Cond: ((tenant_id = 7) AND (created_at >= '2025-01-10 00:00:00'::timestamp without time zone))
  Heap Fetches: 0
  Index Searches: 1
```

Why `INCLUDE` rather than just a third key column `(tenant_id, created_at, kind)`? Included
columns are stored only in the leaf pages, aren't part of the sort order, and don't count for
`UNIQUE` — so you can have `UNIQUE (email) INCLUDE (display_name)` and uniqueness is still on
`email` alone.

The catch is **visibility**. An index entry doesn't know whether its row version is visible to
your transaction (that information is in the heap row). Postgres checks the **visibility map**,
one bit per heap page meaning "every row on this page is visible to everyone", which `VACUUM`
maintains. Pages with that bit set need no heap visit; the others do, and are counted as
`Heap Fetches`. On a table with lots of recent updates you can see an "Index Only Scan" with
`Heap Fetches` close to the row count — effectively a normal index scan. Healthy autovacuum keeps
index-only scans honest.

:::warn title="Don't INCLUDE everything"
Every included column makes the index bigger and must be written on every insert. Cover the
**one or two hot queries** that matter (a feed, a lookup on login), not `SELECT *`.
:::

:::quiz id=db-11-q6 xp=15
`EXPLAIN ANALYZE` shows `Index Only Scan … (actual rows=5000.00)` with `Heap Fetches: 4980` on a
table that receives thousands of updates per minute. What's going on?

- [ ] The index is corrupt; `REINDEX` it
- [ ] Postgres fell back to a Seq Scan but kept the node name
- [x] Most heap pages aren't marked all-visible, so Postgres had to check the heap for almost every row
- [ ] `Heap Fetches` counts index pages read, so this is normal and cheap
> An index-only scan can skip the heap only for pages the **visibility map** marks all-visible.
> Constant updates clear those bits faster than (auto)vacuum sets them, so nearly every row needs a
> heap visit — the scan works, it just isn't saving much. Tune autovacuum for that table (or
> accept a normal index scan). Nothing is corrupt, the node really is an index scan, and
> `Heap Fetches` counts **heap** visits, not index pages.
:::

## Partial indexes: index only the rows you query

The worker that processes the studio render queue asks one question, thousands of times a minute:

```sql
SELECT id FROM render_jobs
WHERE status = 'queued'
ORDER BY created_at
LIMIT 1;
```

In a mature system 99.9% of jobs are `done` and nobody queries those through this path. A full
index on `(status, created_at)` stores millions of `done` entries that are never read. A
**partial index** stores only the rows matching its `WHERE`:

```sql
CREATE INDEX render_jobs_queued_idx ON render_jobs (created_at) WHERE status = 'queued';
```

- It stays **tiny** (only the backlog), so it lives in RAM.
- Writes to rows outside the predicate (updating a `done` job) don't touch it.
- The planner uses it only when the query's `WHERE` **implies** the index predicate. `status =
  'queued'` matches. `status = $1` with a generic prepared plan does not, because the planner
  can't prove `$1 = 'queued'`.

Partial indexes are also the standard way to express **conditional uniqueness**:

```sql
-- one active subscription per user; cancelled ones may repeat
CREATE UNIQUE INDEX ON subscriptions (user_id) WHERE cancelled_at IS NULL;
-- soft delete: emails unique among non-deleted users only
CREATE UNIQUE INDEX ON users (lower(email)) WHERE deleted_at IS NULL;
```

:::sql id=db-11-sql3 db=studio xp=50
title: A partial index for the job queue
Create an index named **`render_jobs_queued_idx`** on `render_jobs` whose only key column is
`created_at`, and which contains **only rows with `status = 'queued'`**. You'll use exactly this
index in the job-queue lesson.

The grader compares the index definitions on `render_jobs`.

hint: `CREATE INDEX … ON … (…) WHERE …;`

```sql starter
CREATE INDEX render_jobs_queued_idx ON render_jobs (status, created_at);
```

```sql solution
CREATE INDEX render_jobs_queued_idx ON render_jobs (created_at) WHERE status = 'queued';
```

```sql check
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'render_jobs'
ORDER BY indexname;
```
:::

## Expression indexes: when the query wraps the column

Emails are case-insensitive for humans: `Ivy@Studio.dev` and `ivy@studio.dev` are the same
person. So the login query is

```sql
SELECT id FROM users WHERE lower(email) = lower($1);
```

The unique index on `email` is useless here. It stores `email`, the query asks about
`lower(email)`, and Postgres won't assume they agree. The fix is to index the **expression**:

```sql
CREATE INDEX users_lower_email_idx ON users (lower(email));
```

Rules:

- The query must use **the same expression** as the index (`lower(email)`, not `upper(email)` or
  `email ILIKE $1`).
- The function must be `IMMUTABLE`: same input, same output, always. `lower()` is. `now()`,
  `to_char(ts, …)` and `ts::date` on a `timestamptz` are not (they depend on the session time zone),
  and Postgres will refuse to build the index.
- Postgres keeps separate statistics for an expression index after `ANALYZE`, which improves
  estimates for that expression.
- An alternative to `lower()` everywhere is the `citext` extension or a case-insensitive
  collation. Many teams just store emails lower-cased and add a `CHECK (email = lower(email))`.

### Or rewrite the predicate instead

An expression index is not always the right fix. Often you can move the function **off the
column** and onto the constant, so the plain index works. The everyday example is "all events of
one day":

```sql
-- ❌ the index on created_at can't be used: it stores created_at, not created_at::date
SELECT * FROM events WHERE created_at::date = '2025-01-10';
-- Seq Scan on events  Filter: ((created_at)::date = '2025-01-10'::date)

-- ✅ same rows, as a half-open range on the raw column
SELECT * FROM events
WHERE created_at >= '2025-01-10' AND created_at < '2025-01-11';
-- Index Scan using events_created_at_idx  Index Cond: ((created_at >= …) AND (created_at < …))
```

A predicate the index can use directly is called **sargable** (from "Search ARGument ABLE").
Other common rewrites: `WHERE extract(year FROM d) = 2025` → `d >= '2025-01-01' AND d < '2026-01-01'`;
`WHERE price * 1.19 > 100` → `WHERE price > 100 / 1.19`. Use `>= … AND < next` rather than
`BETWEEN`, which includes the upper bound and silently grabs midnight of the next day.

:::quiz id=db-11-q5 xp=15
`orders(ordered_at timestamp)` has a B-tree index on `ordered_at`. The monthly report is slow.
Which `WHERE` clause returns the same rows (all of March 2025) **and** can use that index?

- [ ] `WHERE date_trunc('month', ordered_at) = '2025-03-01'`
- [ ] `WHERE to_char(ordered_at, 'YYYY-MM') = '2025-03'`
- [x] `WHERE ordered_at >= '2025-03-01' AND ordered_at < '2025-04-01'`
- [ ] `WHERE ordered_at BETWEEN '2025-03-01' AND '2025-04-01'`
> Only the half-open range compares the **raw column** with constants, so the planner can descend
> the B-tree to March 1st and walk until April 1st. `date_trunc(…)` and `to_char(…)` return the
> right rows but wrap the column in a function, so the index on `ordered_at` is useless for them
> (you'd need an expression index). `BETWEEN` can use the index, but it's inclusive at both ends,
> so it also returns orders placed at exactly `2025-04-01 00:00:00` — not the same rows.
:::

:::sql id=db-11-sql4 db=studio xp=50
title: Case-insensitive login, indexed
The login endpoint runs `SELECT id FROM users WHERE lower(email) = lower($1)`. Create an index that
this query can use. The starter's index looks right but can't be used.

The grader runs `EXPLAIN` on `… WHERE lower(email) = 'ivy@studio.dev'` (with seq scans disabled)
and checks that an index condition on `lower(email)` appears.

hint: Index the expression itself, in its own extra parentheses: `ON users ((…))`, or `ON users (lower(email))`.

```sql starter
CREATE INDEX users_email_plain_idx ON users (email);
```

```sql solution
CREATE INDEX users_lower_email_idx ON users (lower(email));
```

```sql check
CREATE OR REPLACE FUNCTION plan_of(q text) RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  FOR r IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP RETURN NEXT r; END LOOP;
END $$;
SET enable_seqscan = off;
SELECT bool_or(p LIKE '%Index Cond: (lower(email)%') AS uses_expression_index
FROM plan_of($q$SELECT id FROM users WHERE lower(email) = 'ivy@studio.dev'$q$) p;
```
:::

## GIN, in one paragraph

A B-tree stores one value per row. Some questions are about what a row *contains*: a tag inside
a project's jsonb `doc`, an element of a `text[]` array, a word in a title. For those Postgres
has **GIN** (Generalized Inverted iNdex). Like the index at the back of a book, it maps each
*element* to the list of rows that contain it. A GIN index is only useful once you know the
operators that ask "contains" questions (`@>`, `?`, `@@`), so the full treatment is in the
**jsonb, Arrays & Full-Text Search** lesson: operator classes, which queries GIN can and cannot
serve, its write cost, and two hands-on challenges. For now, two facts are enough. GIN serves
containment, not `doc->>'fps' = '25'`, and it is expensive to update.

## BRIN and GiST

B-trees cover most indexing work. Two other index types solve problems a B-tree handles badly,
and you'll meet both in real schemas.

### BRIN: a tiny index for huge append-only tables

The studio writes a row to a `job_events` log every time a render job changes state. Nobody
updates those rows, and `created_at` only ever grows, so rows written at the same time sit on
the same heap pages. After a year the table has a billion rows. A B-tree on `created_at` would
be tens of GB, and it would have to be updated on every insert.

A **BRIN** (Block Range INdex) stores much less. It keeps one small summary per **block range**
(by default 128 heap pages, about 1 MB), and for a timestamp that summary is just the minimum and
maximum value in those pages:

```text
pages    0–127   min 2025-01-01 00:00   max 2025-01-01 06:10
pages  128–255   min 2025-01-01 06:10   max 2025-01-01 12:25
pages  256–383   min 2025-01-01 12:25   max 2025-01-01 18:40
...
```

For `WHERE created_at >= '2025-06-01' AND created_at < '2025-06-02'` Postgres reads the summaries,
skips every range whose min/max can't contain matches, and scans only the remaining pages. The
index for a billion rows is a few MB instead of tens of GB.

```sql
CREATE INDEX job_events_created_brin ON job_events USING brin (created_at);
-- or with smaller ranges: more precise, slightly bigger index
-- CREATE INDEX job_events_created_brin ON job_events USING brin (created_at) WITH (pages_per_range = 32);
```

In `EXPLAIN ANALYZE` a BRIN shows up as a **Bitmap Index Scan** under a **Bitmap Heap Scan**. The
bitmap is always *lossy* (it names whole pages, not rows), so expect a `Recheck Cond` and a
`Rows Removed by Index Recheck` line. That's normal.

BRIN works only when the column's values **follow the physical order** of the table:

- ✅ append-only logs, events, metrics and audit rows keyed by an insert timestamp or an
  increasing id. `SELECT correlation FROM pg_stats WHERE tablename = 'job_events' AND attname =
  'created_at'` close to `1` (or `-1`) is the signal.
- ❌ columns in random order (`user_id`, `status`, `email`). Every range then spans almost all
  values, so nothing can be skipped.
- ❌ tables with many updates or late back-dated inserts. Rows move or arrive out of order, the
  ranges widen, and the index stops excluding anything. (The `minmax_multi` operator classes
  such as `timestamptz_minmax_multi_ops`, PG 14+, tolerate some outliers.)
- BRIN can't enforce `UNIQUE`, can't return rows in order for `ORDER BY … LIMIT`, and isn't for
  single-row lookups. It's a range filter only.

New page ranges are summarized by VACUUM, or by autovacuum as soon as a range fills if you
create the index `WITH (autosummarize = on)`. For very
large time-series tables, BRIN is often combined with monthly partitions. The **Multi-Tenancy,
Partitioning & Temporal Data** lesson covers partitioning.

:::sql id=db-11-sql8 db=empty xp=40
title: Swap a fat B-tree for a BRIN
`job_events` is an append-only log: rows are only ever inserted, in `created_at` order. A teammate
indexed `created_at` with a plain B-tree (`job_events_created_at_idx`, see the setup). The only
queries on that column are "events between two timestamps" for dashboards.

Replace it: **drop** the B-tree and create a **BRIN** index on `created_at` instead (any name).
Leave the primary key alone.

The grader lists the access method (`pg_am.amname`) and the key column of every non-primary-key
index on `job_events`.

hint: `DROP INDEX job_events_created_at_idx;`
hint: `CREATE INDEX … ON job_events USING brin (created_at);`

```sql setup
CREATE TABLE job_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id     int         NOT NULL,
  status     text        NOT NULL,
  created_at timestamptz NOT NULL
);
INSERT INTO job_events (job_id, status, created_at)
SELECT g / 3, (ARRAY['queued','running','done'])[1 + g % 3],
       timestamptz '2025-01-01 00:00+00' + g * interval '10 seconds'
FROM generate_series(1, 30000) g;
CREATE INDEX job_events_created_at_idx ON job_events (created_at);
ANALYZE job_events;
```

```sql starter
-- job_events_created_at_idx is a B-tree. Replace it with a BRIN index.

```

```sql solution
DROP INDEX job_events_created_at_idx;
CREATE INDEX job_events_created_brin ON job_events USING brin (created_at);
```

```sql check
SELECT a.amname, pg_get_indexdef(i.indexrelid, 1, true) AS key_column
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am a    ON a.oid = c.relam
WHERE i.indrelid = 'job_events'::regclass AND NOT i.indisprimary
ORDER BY 1, 2;
```
:::

### GiST: overlap, containment and "nearest"

A B-tree needs values that sort on a single line. Many useful questions aren't about order:

- *Do these two time ranges **overlap**?* (`tstzrange` columns, booking calendars, "which price
  was valid on 15 February")
- *Which shapes **contain** this point?* (geometry and PostGIS: delivery zones, map tiles)
- *What are the 10 **nearest** stores?* (`ORDER BY location <-> point '(52.5,13.4)' LIMIT 10`)

**GiST** (Generalized Search Tree) handles these. It is a balanced tree whose inner entries
describe a *bounding* region, such as "every range in this subtree lies inside 2025-03-01 to
2025-04-15", rather than a sorted separator. A search descends only into subtrees whose region
can overlap the query.

```sql
-- range column: answers && (overlaps), @> (contains), <@ (contained by)
CREATE INDEX bookings_during_gist ON bookings USING gist (during);
SELECT * FROM bookings WHERE during && tstzrange('2025-07-10 09:00+00', '2025-07-10 10:00+00');
```

GiST is also what makes **exclusion constraints** possible. `EXCLUDE USING gist (room_id WITH =,
during WITH &&)` means "no two rows for the same room may have overlapping time ranges", a
double-booking guard that the database enforces even under concurrency. The **Multi-Tenancy,
Partitioning & Temporal Data** lesson teaches range types and exclusion constraints hands-on,
including the `btree_gist` extension that the `room_id WITH =` part needs.

GiST is also one of the two index types for fuzzy text search with `pg_trgm` (GIN is the other).
That one is covered in the jsonb, Arrays & Full-Text Search lesson.

:::quiz id=db-11-q7 xp=15
Which index type fits each workload best? Pick the option where **all three** pairings are right.

1. `api_requests`: 3 billion rows, insert-only, every query filters `WHERE logged_at >= $1 AND logged_at < $2`.
2. `room_bookings`: must reject a booking whose `during` range overlaps an existing one for the same room.
3. `users`: login looks up exactly one row by `email`.

- [ ] 1 B-tree, 2 B-tree with a `UNIQUE (room_id, during)` constraint, 3 Hash
- [x] 1 BRIN, 2 GiST (an exclusion constraint), 3 B-tree
- [ ] 1 GIN, 2 BRIN, 3 B-tree
- [ ] 1 BRIN, 2 GiST, 3 BRIN
> An insert-only table filtered by its insert timestamp is the textbook BRIN case: a few MB of
> min/max summaries instead of a huge B-tree. "No overlapping ranges" can't be expressed as
> `UNIQUE`, because two different ranges are not *equal*, they *overlap*. That needs an exclusion
> constraint backed by GiST. A single-row lookup by `email` is a B-tree (unique) lookup. BRIN is
> useless there: emails aren't in physical order, and BRIN can't return one exact row.
:::

### All the index types, in one table

| Type | Good for | Example |
|---|---|---|
| **B-tree** (default) | `=`, ranges, sorting, uniqueness | `CREATE INDEX ON users (email)` |
| **GIN** | "contains element": jsonb, arrays, full-text, trigrams | `USING gin (doc jsonb_path_ops)` |
| **GiST** | overlap / containment / nearest-neighbor: ranges, geometry (PostGIS), exclusion constraints | `USING gist (during)` for "no overlapping bookings" |
| **BRIN** | huge, append-only tables where the column follows physical order (timestamps of logs) | `USING brin (created_at)`: a few MB for billions of rows, where a B-tree would need tens of GB |
| **Hash** | equality only; rarely better than a B-tree | `USING hash (token)` |
| **SP-GiST** | partitioned search spaces: IP ranges, quadtrees, text prefixes | `USING spgist (ip inet_ops)` |

## The cost side: indexes slow down writes

Every index is an extra structure that every write must update:

- `INSERT` adds one entry **per index**. A table with 9 indexes does 10 writes per row, plus WAL
  for each.
- `DELETE` doesn't remove index entries immediately. `VACUUM` cleans them later.
- `UPDATE` in PostgreSQL writes a **new row version** (MVCC). Normally every index then gets an
  entry pointing at the new version, *even indexes on columns that didn't change*.

The exception is the **HOT update** (Heap-Only Tuple). If **no indexed column changed** and the new
version fits **on the same page**, Postgres chains the new version from the old one and touches no
index at all. This is one reason not to index `updated_at` or `last_seen_at` casually: an index on
a column you update constantly turns every cheap HOT update into a full index update. Leaving free
space per page with `fillfactor` (e.g. `WITH (fillfactor = 90)`) makes HOT updates more likely on
update-heavy tables. (One exception since PostgreSQL 16: BRIN indexes are "summarizing" and
don't block HOT, so a BRIN on `updated_at` is cheap in this respect.)

```sql
-- How often do updates manage to be HOT? (on a real server)
SELECT relname, n_tup_upd, n_tup_hot_upd,
       round(100.0 * n_tup_hot_upd / nullif(n_tup_upd, 0), 1) AS hot_pct
FROM pg_stat_user_tables ORDER BY n_tup_upd DESC LIMIT 10;
```

:::quiz id=db-11-q3 xp=15
`projects` has indexes on `id` (PK), `owner_id`, `(published, updated_at)` and a GIN on `doc`. The
autosave endpoint runs `UPDATE projects SET doc = $1, version = version + 1, updated_at = now()
WHERE id = $2` many times per minute. What is true? Select all that apply.

- [ ] Every autosave is a HOT update because `id` didn't change
- [x] It can't be HOT, because `doc` and `updated_at` are indexed and they change
- [x] Each autosave adds entries to the GIN index, and GIN is expensive to update
- [ ] Indexes only cost something on `INSERT`, never on `UPDATE`
> HOT requires that **no indexed column** changes. Here two do (`doc` via the GIN index,
> `updated_at` via the composite index), so every index gets a new entry on every autosave. If
> nobody needs `(published, updated_at)` sorted by recency, drop it or index something more
> stable. Ask whether the GIN index is used enough to pay for itself.
:::

:::quiz id=db-11-q4 xp=15
An `EXPLAIN ANALYZE` shows a nested loop node with `rows=1` estimated but `actual rows=48000`,
and the query takes 12 seconds. The tables had 2 million rows imported an hour ago. What do you
try **first**?

- [ ] Add more indexes to the inner table
- [x] Run `ANALYZE` on the involved tables, then re-check the plan
- [ ] Rewrite the query with a CTE to force the join order
- [ ] Increase `work_mem` to 1 GB
> A 48 000× underestimate means the planner chose a nested loop for what it thought was a single
> row. Fresh bulk loads often haven't been analyzed yet (autovacuum's analyze runs on a delay),
> so the statistics still describe the old, small table. After `ANALYZE` the planner usually
> switches to a hash join by itself. Always fix the estimate before you fight the plan: more
> indexes give a misinformed planner more ways to be wrong, a CTE no longer forces join order
> since PG 12, and `work_mem` helps sorts and hashes, not a plan built on a wrong row count.
:::

## Index hygiene in production

Indexes accumulate. Every incident adds one and nobody removes any. A few queries every team
should run now and then (on a real server, since these counters don't move inside the browser
sandbox):

```sql
-- Indexes never used since stats were reset (excluding unique/PK, which enforce rules)
SELECT s.relname AS table, s.indexrelname AS index, s.idx_scan,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.idx_scan = 0 AND NOT i.indisunique
ORDER BY pg_relation_size(s.indexrelid) DESC;

-- Invalid indexes (left behind by a failed CREATE INDEX CONCURRENTLY)
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
```

Before dropping an "unused" index, check **every** replica (stats are per server, and reporting
queries often run only on a read replica) and how long ago the stats were reset.

**Redundant indexes** are the easy win. An index `(a)` is redundant next to `(a, b)`, because
`(a, b)` serves `WHERE a = ?` equally well. An exact duplicate under another name is pure waste.
`(b, a)` is **not** redundant with `(a, b)`.

In production you never run a plain `CREATE INDEX` on a busy table. It holds a lock that blocks
all writes for the whole build. Use:

```sql
CREATE INDEX CONCURRENTLY clips_project_id_idx ON clips (project_id);
DROP INDEX CONCURRENTLY IF EXISTS events_tenant_idx;
```

`CONCURRENTLY` takes longer and **cannot run inside a transaction block**, which is why it doesn't
work in the browser sandbox, where your whole script runs as one transaction. If it fails halfway
it leaves an `INVALID` index that you must drop and retry. Migration tools need a "no transaction"
flag for these steps (Production PostgreSQL covers this).

:::sql id=db-11-sql7 db=empty xp=60
title: Clean up redundant indexes
Over the years `events` collected six indexes (see the setup). Drop the **two** that are
redundant:

- the single-column index that a composite index already covers as its leading column, and
- the exact duplicate. Keep `events_tenant_created_idx`, drop its copy.

Keep everything else. The grader lists the remaining index names on `events`.

hint: `(a)` is covered by `(a, b)`. `(b, a)` is a different index.
hint: `DROP INDEX name1, name2;`

```sql setup
CREATE TABLE events (
  id         bigint PRIMARY KEY,
  tenant_id  int       NOT NULL,
  kind       text      NOT NULL,
  created_at timestamp NOT NULL
);
CREATE INDEX events_tenant_idx          ON events (tenant_id);
CREATE INDEX events_tenant_created_idx  ON events (tenant_id, created_at);
CREATE INDEX events_created_tenant_idx  ON events (created_at, tenant_id);
CREATE INDEX events_kind_idx            ON events (kind);
CREATE INDEX events_tc_copy             ON events (tenant_id, created_at);
```

```sql starter
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'events' ORDER BY indexname;
```

```sql solution
DROP INDEX events_tenant_idx, events_tc_copy;
```

```sql check
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'events'
ORDER BY indexname;
```
:::

:::job title="What you'll be asked to do"
"The dashboard is slow" tickets usually go like this: get the exact SQL (from the ORM log, APM
trace or `pg_stat_statements`), run `EXPLAIN (ANALYZE, BUFFERS)` against a production-sized
copy, find the node where the time or the estimate goes wrong, then fix it with an index, a
rewrite or `ANALYZE`. In the PR, paste the before and after plans, and use `CREATE INDEX
CONCURRENTLY` in the migration. Reviewers will ask for both.
:::

:::pro title="How seniors decide on an index"
- Start from the **queries**, not the columns: list the top queries by total time
  (`pg_stat_statements` sorted by `total_exec_time`), then index for those.
- Prefer **one composite index** that serves several queries over many single-column ones.
- Fit the index to the data: a partial index for hot subsets (queues, `deleted_at IS NULL`), an
  expression index for normalized lookups, GIN for documents.
- Count the write cost: on hot, update-heavy tables every index needs a strong case.
- Test with **production-like volume**. On 500 rows every plan is a Seq Scan and tells you nothing.
:::

:::cards id=db-11-cards1 xp=20 title="Indexes & EXPLAIN"
Q: What does a B-tree leaf page store?
A: Sorted `(key, TID)` entries (TID = heap page + slot), linked to neighbouring leaves, which makes range scans and ordered reads cheap.
Q: Why can a 3–4 level B-tree index billions of rows?
A: Fan-out: each 8 KB inner page points to hundreds of children, so the levels multiply (300³ ≈ 27M, 300⁴ ≈ 8B).
Q: Index Scan vs Bitmap Heap Scan?
A: Index Scan fetches heap rows one by one in index order (few rows, or ordering needed). Bitmap collects TIDs, sorts them by page and reads each page once (medium selectivity, or combining indexes).
Q: What makes an Index Only Scan possible?
A: All selected columns are in the index (key or INCLUDE), and the visibility map marks the pages all-visible (kept up by VACUUM).
Q: First thing to compare in EXPLAIN ANALYZE?
A: Estimated vs actual rows per node. Big mismatches mean bad statistics and usually a bad plan.
Q: Column order rule for composite indexes?
A: Equality columns first, then one range/sort column. `(a, b)` serves `a = ?` but not `b = ?` alone.
Q: When is a partial index used?
A: When the query's WHERE implies the index's WHERE, e.g. `status = 'queued'` for an index `… WHERE status = 'queued'`.
Q: Why doesn't `WHERE lower(email) = $1` use an index on `email`?
A: The index stores `email`, not `lower(email)`. Create an expression index on `(lower(email))`.
Q: When does a BRIN index beat a B-tree?
A: On huge, append-only tables where the column follows the physical row order (insert timestamps of logs). It stores min/max per block range, so it's tiny, but it only filters ranges: no uniqueness, no ORDER BY, no single-row lookups.
Q: What is GiST for?
A: Overlap, containment and nearest-neighbor questions: range types (`&&`), geometry/PostGIS, `ORDER BY … <-> … LIMIT n`, and the exclusion constraints that prevent overlapping bookings.
Q: What is a HOT update?
A: An UPDATE that changes no indexed column and fits on the same page, so no index is touched. Extra indexes on frequently updated columns prevent it.
Q: How do you add an index to a busy production table?
A: `CREATE INDEX CONCURRENTLY` (outside a transaction). If it fails, drop the INVALID index and retry.
Q: What does `INCLUDE (col)` add to a B-tree index?
A: A non-key payload column stored in the leaves, so more queries can be answered by an Index Only Scan. It isn't part of the sort order or the uniqueness check.
Q: What does `Heap Fetches` in an Index Only Scan mean?
A: Rows whose heap page wasn't all-visible in the visibility map, so Postgres had to check the heap anyway. VACUUM keeps it low.
Q: What makes a predicate "sargable"?
A: It compares the raw indexed column with a value (`created_at >= $1 AND created_at < $2`), instead of wrapping the column in a function (`created_at::date = $1`).
:::

## Recap

- An index is a sorted (B-tree), inverted (GIN), bounding-region (GiST) or summary (BRIN)
  structure pointing to heap rows. It speeds up matching reads and costs something on every write.
- B-trees serve `=`, ranges, `IN`, `IS NULL` and `ORDER BY … LIMIT`. They don't serve functions on
  the column, leading wildcards or a missing leading column.
- Read `EXPLAIN` inside-out, and compare estimated vs actual rows first. `Filter` and `Rows Removed`
  mean wasted work.
- The planner is cost-based: selectivity and statistics decide whether an index is worth it, and a
  Seq Scan is often correct.
- Composite indexes: equality first, then range/sort. `INCLUDE` columns enable Index Only Scans
  (if VACUUM keeps the visibility map fresh). Partial indexes for hot subsets and conditional
  uniqueness. Expression indexes for `lower()` and the like — or rewrite the predicate so it's
  sargable.
- BRIN for huge append-only tables filtered by an insert-ordered column, GiST for overlap,
  containment and nearest-neighbor. GIN for documents is covered with jsonb.
- Index FKs you join on, drop redundant and unused indexes, protect HOT updates, and build
  indexes `CONCURRENTLY` in production.
