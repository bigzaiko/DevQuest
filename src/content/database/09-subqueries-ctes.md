---
id: db-09
title: Subqueries, CTEs & Recursive Queries
level: intermediate
minutes: 45
xp: 150
summary: Queries inside queries — scalar, IN and EXISTS subqueries, the NOT IN + NULL trap, readable CTEs, recursive CTEs that walk a branching video tree, and LATERAL joins.
---

So far each query has been one `SELECT` over one or more joined tables. Real questions are
often two-step: *"which clips are longer than **the average** clip?"* — first you need the
average, then you need the clips. *"Which users have **never** created a project?"* — you need
to look up something that is *absent*. And in the **studio** dataset, a branching video story
is a **tree** of clips: to list every possible ending you have to follow `parent_clip_id`
links an unknown number of levels deep.

This lesson gives you the tools for all three:

- **Subqueries** — a `SELECT` nested inside another statement.
- **CTEs** (`WITH`) — named, readable steps, like variables for queries.
- **Recursive CTEs** — loops in SQL, for trees and graphs.
- **`LATERAL`** — "for each row on the left, run this query".

Most examples use the **studio** dataset — a small branching-video SaaS:

| Table | What it holds |
|---|---|
| `users` | id, email, display_name, plan (`free`/`pro`/`team`) |
| `projects` | owner_id → users, title, `doc` (jsonb), `version`, `published` |
| `clips` | project_id, **`parent_clip_id` → clips** (the branching tree), title, choice_label, duration_ms |
| `render_jobs` | project_id, kind, status, attempts, worker, timestamps |
| `credit_ledger` | user_id, delta (+ top-up / − spend), reason, created_at |

Project 1, *The Heist*, looks like this:

```text
1 Intro (12s)
├── 2 Front door (8s)          "Go in the front"
│   ├── 4 Bribe the guard (6s) "Bribe"
│   └── 5 Sneak past (7s)      "Sneak"
│       └── 7 The vault (15s)  "Open the vault"
└── 3 Rooftop (9.5s)           "Climb the roof"
    └── 6 Zipline (5.5s)       "Jump"
```

Root clips have `parent_clip_id IS NULL`. Clips without children are **endings**.

## Scalar subqueries: one value

A subquery in parentheses that returns **exactly one row with one column** can be used
anywhere a single value is allowed — in `WHERE`, in the `SELECT` list, in arithmetic:

```sql
-- How does each clip compare to the average clip?
SELECT title,
       duration_ms,
       duration_ms - (SELECT avg(duration_ms) FROM clips) AS diff_from_avg
FROM clips;
```

The inner query does not mention any column of the outer query, so Postgres runs it **once**
(in `EXPLAIN` you'll see it as an `InitPlan`), gets a number, and uses it like a constant. Two
rules:

- If a scalar subquery returns **zero rows**, its value is `NULL` (not an error).
- If it returns **more than one row**, you get
  `ERROR: more than one row returned by a subquery used as an expression`. That error in
  production usually means the data has a duplicate you assumed was impossible — add a
  `UNIQUE` constraint, or decide which row you actually want (`ORDER BY … LIMIT 1`).

You cannot write `WHERE duration_ms > avg(duration_ms)` — aggregates aren't allowed in `WHERE`
because `WHERE` filters rows *before* any grouping happens. The subquery is the fix.

:::sql id=db-09-sql1 db=studio ordered=true xp=30
title: Longer than average
Return `title` and `duration_ms` of every clip that is **longer than the average duration of
all clips**. Longest first; for equal durations, sort by `title`.

hint: The average is `(SELECT avg(duration_ms) FROM clips)`.
hint: `ORDER BY duration_ms DESC, title`

```sql starter
SELECT title, duration_ms
FROM clips
ORDER BY duration_ms DESC, title;
```

```sql solution
SELECT title, duration_ms
FROM clips
WHERE duration_ms > (SELECT avg(duration_ms) FROM clips)
ORDER BY duration_ms DESC, title;
```
:::

## IN: is the value in this list?

`x IN (subquery)` is true if the subquery (one column, any number of rows) contains `x`. It's
the natural way to filter by membership in another table:

```sql
-- Projects that have at least one failed render job
SELECT id, title
FROM projects
WHERE id IN (SELECT project_id FROM render_jobs WHERE status = 'failed');
```

You could write the same with a `JOIN`, but a join returns a project **once per matching
job** — two failed jobs, two rows — and you'd need `DISTINCT`. `IN` is a **semi-join**: a join
that only asks "is there *at least one* match?" and returns each left row at most once, without
adding any columns from the right side. The planner knows this and often executes `IN` with the
same join algorithms (hash, merge, nested loop), so it's not slower.

Two details that trip people up:

- The subquery must return **exactly one column**. `WHERE id IN (SELECT project_id, status …)`
  is an error ("subquery has too many columns").
- If the list contains a `NULL`, plain `IN` still works: a real match is still `TRUE`, and a
  non-match becomes `NULL` instead of `FALSE`, which `WHERE` treats the same way (row dropped).
  The danger is only in `NOT IN` — coming up shortly.

:::sql id=db-09-sql2 db=studio xp=30
title: Publishers
Return the `display_name` of every user who owns **at least one published project**
(`projects.published = true`). Each user once.

hint: `WHERE id IN (SELECT owner_id FROM projects WHERE …)`

```sql starter
SELECT u.display_name
FROM users u
JOIN projects p ON p.owner_id = u.id;
```

```sql solution
SELECT display_name
FROM users
WHERE id IN (SELECT owner_id FROM projects WHERE published);
```
:::

## EXISTS and NOT EXISTS

`EXISTS (subquery)` is true if the subquery returns **at least one row**. What the subquery
selects doesn't matter — by convention people write `SELECT 1`. `EXISTS` shines when the
subquery refers to the **outer** row:

```sql
-- Users who have at least one render job on one of their projects
SELECT u.display_name
FROM users u
WHERE EXISTS (
  SELECT 1
  FROM projects p
  JOIN render_jobs r ON r.project_id = p.id
  WHERE p.owner_id = u.id          -- ← refers to the outer query
);
```

A subquery that references the outer query is **correlated**. Conceptually it runs once per
outer row ("for this user, is there a job?"). In practice the planner turns `EXISTS` into a
**semi-join** and `NOT EXISTS` into an **anti-join** — the mirror image: "keep the left row only
if there is **no** match". Both are just as fast as a hand-written join, and both can stop
looking at the first match for each outer row.

`NOT EXISTS` is the cleanest way to ask for something that is **absent**:

```sql
-- Users who own no project at all
SELECT display_name
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.owner_id = u.id);
-- → Lena
```

:::job title="What the ORM writes"
When you write `db.Users.Where(u => u.Projects.Any())` in EF Core, or
`.Where(u => !u.Projects.Any())`, the SQL it generates is `WHERE EXISTS (SELECT 1 …)` /
`WHERE NOT EXISTS (…)`. Recognising this in logs (and in `EXPLAIN` as `Semi Join` / `Anti
Join`) is a day-one skill when you're chasing a slow endpoint.
:::

## The NOT IN + NULL trap

Here is a bug that has shipped to production in thousands of codebases. Let's find the
**endings** — clips that are nobody's parent:

```sql
SELECT count(*)
FROM clips
WHERE id NOT IN (SELECT parent_clip_id FROM clips);
-- → 0   (?!)
```

Zero endings? The Heist alone has three. The problem: **root clips have
`parent_clip_id = NULL`**, so the subquery's list contains a `NULL`.

`x NOT IN (a, b, NULL)` means `x <> a AND x <> b AND x <> NULL`. And `x <> NULL` is not true or
false — it's **unknown** (`NULL`). `TRUE AND TRUE AND NULL` is `NULL`, and `WHERE` only keeps
rows where the condition is `TRUE`. So **a single NULL in the list makes `NOT IN` return
nothing at all.**

| Expression | Result |
|---|---|
| `4 NOT IN (1, 2)` | `true` |
| `4 NOT IN (1, 2, NULL)` | `NULL` → row dropped |
| `1 NOT IN (1, 2, NULL)` | `false` |
| `NOT EXISTS (… WHERE parent_clip_id = 4)` | `true` — NULLs never match `=`, so they're simply ignored |

`IN` doesn't have this problem (a match is a match), only `NOT IN`. You *could* patch it with
`WHERE parent_clip_id IS NOT NULL` inside the subquery, but that's easy to forget the next time
someone makes a column nullable. There's also a performance reason to avoid `NOT IN`: because of
these NULL semantics the planner generally **can't turn it into an anti-join**, so on big tables
it runs as a per-row (or hashed) `SubPlan` instead. The robust fix is `NOT EXISTS`, which only
asks "is there a matching row?":

:::sql id=db-09-sql3 db=studio ordered=true xp=40
title: Every ending
Return `project_id`, `id` and `title` of every **ending** clip — a clip that no other clip has
as its parent. Sort by `project_id`, then `id`.

The starter is the broken `NOT IN` version. Fix it.

hint: `WHERE NOT EXISTS (SELECT 1 FROM clips child WHERE child.parent_clip_id = c.id)`
hint: Give the outer table an alias (`clips c`) so the inner query can refer to it.

```sql starter
SELECT project_id, id, title
FROM clips
WHERE id NOT IN (SELECT parent_clip_id FROM clips)
ORDER BY project_id, id;
```

```sql solution
SELECT c.project_id, c.id, c.title
FROM clips c
WHERE NOT EXISTS (
  SELECT 1 FROM clips child WHERE child.parent_clip_id = c.id
)
ORDER BY c.project_id, c.id;
```
:::

:::quiz id=db-09-q1 xp=15
`render_jobs.worker` is `NULL` for queued jobs. What does this return?

```sql
SELECT count(*)
FROM users
WHERE display_name NOT IN (SELECT worker FROM render_jobs);
```

- [ ] 6 — no user is called like a worker
- [x] 0 — the subquery contains NULLs, so `NOT IN` is never true
- [ ] An error — you can't compare text with NULL
- [ ] 3 — only the rows with a non-NULL worker are compared
> Queued jobs have `worker = NULL`, so the list contains NULL and every `NOT IN` test evaluates
> to NULL (unknown) — `WHERE` drops all six users, so the count is 0. "6" is what you'd *expect*
> intuitively, and "3" assumes Postgres skips the NULLs; it doesn't. Comparing with NULL is not an
> error either, it just yields NULL. Use `NOT EXISTS`, or filter the subquery with
> `WHERE worker IS NOT NULL`.
:::

:::quiz id=db-09-q4 xp=10
Project 1 has three render jobs. What happens when you run this?

```sql
SELECT p.title,
       (SELECT r.id FROM render_jobs r WHERE r.project_id = p.id) AS job_id
FROM projects p;
```

- [ ] One row per project, showing the first job's id
- [ ] One row per **job**, like a join
- [ ] One row per project; projects with several jobs get `NULL`
- [x] An error: more than one row returned by a subquery used as an expression
> A subquery in the `SELECT` list is a **scalar** subquery: it must produce at most one row. Zero
> rows would be fine (NULL), but project 1 produces three, so the whole statement fails. Postgres
> never silently picks a "first" row — there is no defined order. Decide what you want: one value
> (`max(r.id)`, `count(*)`), one specific row (`ORDER BY r.created_at DESC LIMIT 1`), or all rows
> (a `JOIN` or `LATERAL`).
:::

## Correlated subqueries in SELECT and WHERE

A correlated subquery can compute a per-row value. "For each user, how many projects?":

```sql
SELECT u.display_name,
       (SELECT count(*) FROM projects p WHERE p.owner_id = u.id) AS projects
FROM users u
ORDER BY u.id;
```

| display_name | projects |
|---|---|
| Mara | 2 |
| Jonas | 1 |
| Ivy | 1 |
| Omar | 1 |
| Lena | 0 |
| Kai | 1 |

Notice Lena gets `0`, not a missing row — a `count(*)` subquery always returns a row. (With a
`JOIN … GROUP BY` you'd need a `LEFT JOIN` to keep her.)

Correlated subqueries are also how you compare a row with **its own group**: "clips longer than
the average of *their* project" needs a different average per project.

```sql
WHERE c.duration_ms > (SELECT avg(c2.duration_ms)
                       FROM clips c2
                       WHERE c2.project_id = c.project_id)
```

:::warn title="Correlated ≠ free"
A correlated subquery in the `SELECT` list may really execute once per outer row (the plan shows
`SubPlan`). For 6 users that's nothing; for 600 000 rows it's 600 000 little queries. If it
gets slow, rewrite it as a `JOIN` to a grouped subquery, or as a window function (next lesson).
:::

:::sql id=db-09-sql4 db=studio ordered=true xp=40
title: Above the project's average
Return `project_id`, `title` and `duration_ms` of every clip that is longer than the **average
duration of clips in the same project**. Sort by `project_id`, then `duration_ms` descending,
then `title`.

hint: Alias the outer table (`clips c`) and the inner one (`clips c2`), and correlate on `project_id`.

```sql starter
SELECT project_id, title, duration_ms
FROM clips
WHERE duration_ms > (SELECT avg(duration_ms) FROM clips)
ORDER BY project_id, duration_ms DESC, title;
```

```sql solution
SELECT c.project_id, c.title, c.duration_ms
FROM clips c
WHERE c.duration_ms > (
  SELECT avg(c2.duration_ms) FROM clips c2 WHERE c2.project_id = c.project_id
)
ORDER BY c.project_id, c.duration_ms DESC, c.title;
```
:::

## Subqueries in FROM (derived tables)

A subquery in `FROM` is a temporary table that exists for this query only. It must have an
alias. Use it to aggregate first and then join or filter the result:

```sql
SELECT p.title, j.failed
FROM projects p
JOIN (
  SELECT project_id, count(*) AS failed
  FROM render_jobs
  WHERE status = 'failed'
  GROUP BY project_id
) j ON j.project_id = p.id;
```

This works, but nest two or three of these and the query reads inside-out. That's what CTEs
fix.

## CTEs: WITH, for readable steps

A **common table expression** names a subquery up front:

```sql
WITH failed_jobs AS (
  SELECT project_id, count(*) AS failed
  FROM render_jobs
  WHERE status = 'failed'
  GROUP BY project_id
)
SELECT p.title, f.failed
FROM projects p
JOIN failed_jobs f ON f.project_id = p.id;
```

You read it top to bottom like a recipe: *first compute failed jobs per project, then join*.
You can define several CTEs separated by commas, and later ones can use earlier ones:

```sql
WITH balances AS (
  SELECT user_id, sum(delta) AS balance FROM credit_ledger GROUP BY user_id
),
rich AS (
  SELECT user_id FROM balances WHERE balance > 100
)
SELECT u.display_name
FROM users u
JOIN rich r ON r.user_id = u.id;
```

Why teams like CTEs:

- **Readability in code review.** Each step has a name that explains its intent.
- **Debuggability.** Replace the final `SELECT` with `SELECT * FROM balances` to inspect a step.
- **Reuse.** A CTE referenced twice is written once.

:::pro title="Are CTEs an optimisation fence?"
Before PostgreSQL 12, every CTE was computed separately and stored ("materialised"), which
blocked the planner from pushing filters into it — old blog posts warn about this. Since PG 12,
a non-recursive CTE that is referenced **once** and has no side effects is **inlined** like a
subquery, so it costs nothing. (A CTE referenced twice or more is still materialised by default.) You can still force either behaviour: `WITH x AS MATERIALIZED (…)` (compute once,
useful when it's expensive and referenced many times) or `AS NOT MATERIALIZED`. The Performance
Tuning lesson, which comes right after Indexes & EXPLAIN, shows when that matters.
:::

:::quiz id=db-09-q6 xp=10
On PostgreSQL 18, `render_jobs` has an index on `project_id`. What does the planner do with this
query?

```sql
WITH recent AS (
  SELECT * FROM render_jobs WHERE created_at > now() - interval '7 days'
)
SELECT * FROM recent WHERE project_id = 5;
```

- [ ] Computes all recent jobs into a temporary result first, then filters for project 5
- [x] Inlines the CTE like a subquery, so both conditions are applied together and the `project_id` index can be used
- [ ] Rejects it — you can't add a `WHERE` to a CTE you've already filtered
- [ ] Writes the CTE result to a temporary table on disk, because CTEs are always materialised
> `recent` is referenced once, isn't recursive and has no side effects, so since PG 12 it is
> folded into the main query: the planner sees `created_at > … AND project_id = 5` on
> `render_jobs` and can pick the index. The first answer describes the **pre-12** behaviour that
> old blog posts warn about (or what you get today with `AS MATERIALIZED`); the last one
> overstates even that — a materialised CTE is kept in memory and only spills to disk if it's
> large. Filtering a CTE's output is completely normal SQL.
:::

:::sql id=db-09-sql5 db=studio ordered=true xp=50
title: The account overview
Build an account overview with CTEs. Return one row per user with:

1. `display_name`
2. `balance` — the sum of the user's `credit_ledger.delta` (0 if they have no ledger rows)
3. `projects` — how many projects they own (0 if none)

Sort by `balance` descending, then `display_name`.

hint: One CTE `balances` grouped by `user_id`, one CTE `owned` grouped by `owner_id`.
hint: `LEFT JOIN` both to `users`, and wrap with `coalesce(…, 0)`.

```sql starter
WITH balances AS (
  SELECT user_id, sum(delta) AS balance FROM credit_ledger GROUP BY user_id
)
SELECT u.display_name, b.balance
FROM users u
JOIN balances b ON b.user_id = u.id
ORDER BY b.balance DESC;
```

```sql solution
WITH balances AS (
  SELECT user_id, sum(delta) AS balance FROM credit_ledger GROUP BY user_id
),
owned AS (
  SELECT owner_id, count(*) AS projects FROM projects GROUP BY owner_id
)
SELECT u.display_name,
       coalesce(b.balance, 0)  AS balance,
       coalesce(o.projects, 0) AS projects
FROM users u
LEFT JOIN balances b ON b.user_id = u.id
LEFT JOIN owned o    ON o.owner_id = u.id
ORDER BY balance DESC, u.display_name;
```
:::

### Data-modifying CTEs

A CTE can also contain `INSERT`, `UPDATE` or `DELETE … RETURNING`, and the next step can use the
returned rows. That lets you move rows atomically in one statement:

```sql
-- Archive finished jobs: delete them and insert them elsewhere, in one statement
-- (assumes a table render_jobs_archive with the same columns — not part of the dataset)
WITH moved AS (
  DELETE FROM render_jobs
  WHERE status = 'done'
  RETURNING *
)
INSERT INTO render_jobs_archive
SELECT * FROM moved;
```

All parts of the statement run against the **same snapshot** and succeed or fail together —
there is no moment where a job is deleted but not yet archived. One consequence surprises
people: the sub-statements can't see each other's changes to the table. If the main query read
`render_jobs` directly, it would still see the "deleted" rows; the only way to pass data between
the steps is through `RETURNING`. You'll use this pattern for job-queue cleanup in the Job Queues lesson.

## Recursive CTEs: walking a tree

Now the fun part. How do you list **every clip under *Intro*, at any depth**? A join gives you
one level. Two joins give two levels. But a story can be 3 or 30 levels deep. You need a loop —
and SQL's loop is `WITH RECURSIVE`.

```sql
WITH RECURSIVE tree AS (
  -- 1. anchor: where to start
  SELECT id, title, 0 AS depth
  FROM clips
  WHERE id = 1

  UNION ALL

  -- 2. recursive step: children of the rows found so far
  SELECT c.id, c.title, t.depth + 1
  FROM clips c
  JOIN tree t ON c.parent_clip_id = t.id
)
SELECT * FROM tree;
```

How Postgres evaluates it:

1. Run the **anchor** query. Its rows (`Intro`, depth 0) form the first *working set* and go to
   the output.
2. Run the **recursive** query, where `tree` means *only the working set from the previous
   step*. That finds the children of Intro (depth 1). They go to the output and become the new
   working set.
3. Repeat until a step returns **no rows**. Then stop.

| Iteration | Working set (`tree` inside the recursive part) | New rows |
|---|---|---|
| anchor | — | Intro (0) |
| 1 | Intro | Front door (1), Rooftop (1) |
| 2 | Front door, Rooftop | Bribe (2), Sneak (2), Zipline (2) |
| 3 | Bribe, Sneak, Zipline | The vault (3) |
| 4 | The vault | *(none — stop)* |

Three things to notice:

- **Both pieces of syntax are required.** Forget `RECURSIVE` and Postgres reports
  *relation "tree" does not exist* (a plain CTE can't see itself). Forget the anchor or the
  `UNION [ALL]` and you get *recursive query "tree" does not have the form non-recursive-term
  UNION [ALL] recursive-term*.
- **The recursive part may reference `tree` only once**, not inside a subquery (so no
  `EXISTS (… FROM tree …)`), and it may not use aggregates. It's a loop over the working set,
  not a free-form query — aggregate in the final `SELECT` instead.
- **The anchor fixes the column types.** The recursive part's columns must match it in number
  and type. That's why `depth` is `0` in the anchor and `t.depth + 1` below. Types bite with
  text: if `title` were `varchar(50)`, the anchor's `title AS path` would be `varchar(50)` but
  `t.path || ' > ' || c.title` is plain `text`, and Postgres refuses with *recursive query "tree"
  column 4 has type character varying(50) in non-recursive term but type character varying
  overall*. Casting the anchor (`title::text AS path`) avoids that. In the studio schema `title`
  is already `text`, so the cast is just a good habit.

### Building a path

Carrying state down the recursion is the trick that makes recursive CTEs useful. Concatenate the
titles to build a breadcrumb, and sum the durations to know how long each route takes to watch:

```sql
WITH RECURSIVE tree AS (
  SELECT id, title, 0 AS depth,
         title::text AS path,
         duration_ms AS total_ms
  FROM clips
  WHERE parent_clip_id IS NULL          -- every root, every project
  UNION ALL
  SELECT c.id, c.title, t.depth + 1,
         t.path || ' > ' || c.title,
         t.total_ms + c.duration_ms
  FROM clips c
  JOIN tree t ON c.parent_clip_id = t.id
)
SELECT path, depth, total_ms FROM tree ORDER BY path;
```

Sorting by `path` gives you a depth-first, tree-shaped listing for free (here are the Heist
rows; the other projects' trees appear in the same result, sorted in among them by title):

```text
Intro                                         0  12000
Intro > Front door                            1  20000
Intro > Front door > Bribe the guard          2  26000
Intro > Front door > Sneak past               2  27000
Intro > Front door > Sneak past > The vault   3  42000
Intro > Rooftop                               1  21500
Intro > Rooftop > Zipline                     2  27000
```

Sorting by a text path is a handy trick, but it depends on the collation and on titles never
containing your separator. When the order really matters, Postgres 14+ has a dedicated clause
that computes a proper depth-first (or breadth-first) sort key for you:

```sql
WITH RECURSIVE tree AS (…same as above…)
  SEARCH DEPTH FIRST BY id SET ord      -- or: SEARCH BREADTH FIRST BY id SET ord
SELECT path, depth FROM tree ORDER BY ord;
```

:::sql id=db-09-sql6 db=studio ordered=true xp=50
title: The Heist, as a tree
Walk the clip tree of **project 1** starting at its root clip. Return `id`, `title`, `depth`
(root = 0) and `path` (titles joined with `' > '`, e.g. `Intro > Front door`). Sort by `path`.

hint: Anchor: `WHERE project_id = 1 AND parent_clip_id IS NULL`.
hint: Recursive part: `JOIN tree t ON c.parent_clip_id = t.id`, `t.depth + 1`, `t.path || ' > ' || c.title`.
hint: Cast the anchor's path with `title::text` so both parts have the same type.

```sql starter
WITH RECURSIVE tree AS (
  SELECT id, title, 0 AS depth, title::text AS path
  FROM clips
  WHERE project_id = 1 AND parent_clip_id IS NULL
)
SELECT id, title, depth, path FROM tree ORDER BY path;
```

```sql solution
WITH RECURSIVE tree AS (
  SELECT id, title, 0 AS depth, title::text AS path
  FROM clips
  WHERE project_id = 1 AND parent_clip_id IS NULL
  UNION ALL
  SELECT c.id, c.title, t.depth + 1, t.path || ' > ' || c.title
  FROM clips c
  JOIN tree t ON c.parent_clip_id = t.id
)
SELECT id, title, depth, path FROM tree ORDER BY path;
```
:::

### Every ending, with its full route

A viewer of an interactive video experiences one **root-to-leaf path**. Product wants to know:
*how many endings does each story have, and how long is each route?* Combine the recursive walk
with the "no children" test from earlier — filter the final result, not the recursion:

:::sql id=db-09-sql7 db=studio ordered=true xp=60
title: All the endings
For **every project**, list each ending (a clip with no children) with the full route that leads
to it. Return `project_id`, `path` (root to ending, titles joined with `' > '`) and `total_ms`
(sum of `duration_ms` along the path, including root and ending).

Sort by `project_id`, then `total_ms` descending, then `path`.

hint: Start at all roots (`parent_clip_id IS NULL`) and carry `project_id`, `path` and `total_ms` down.
hint: In the final SELECT: `WHERE NOT EXISTS (SELECT 1 FROM clips k WHERE k.parent_clip_id = tree.id)`.

```sql starter
WITH RECURSIVE tree AS (
  SELECT id, project_id, title::text AS path, duration_ms AS total_ms
  FROM clips
  WHERE parent_clip_id IS NULL
  UNION ALL
  SELECT c.id, c.project_id, t.path || ' > ' || c.title, t.total_ms + c.duration_ms
  FROM clips c
  JOIN tree t ON c.parent_clip_id = t.id
)
SELECT project_id, path, total_ms
FROM tree
ORDER BY project_id, total_ms DESC, path;
```

```sql solution
WITH RECURSIVE tree AS (
  SELECT id, project_id, title::text AS path, duration_ms AS total_ms
  FROM clips
  WHERE parent_clip_id IS NULL
  UNION ALL
  SELECT c.id, c.project_id, t.path || ' > ' || c.title, t.total_ms + c.duration_ms
  FROM clips c
  JOIN tree t ON c.parent_clip_id = t.id
)
SELECT project_id, path, total_ms
FROM tree
WHERE NOT EXISTS (SELECT 1 FROM clips k WHERE k.parent_clip_id = tree.id)
ORDER BY project_id, total_ms DESC, path;
```
:::

### Walking up: breadcrumbs

Recursion works in both directions. To show a breadcrumb for clip 11 (*Oat milk*), start at the
clip and follow `parent_clip_id` **upwards**:

```sql
WITH RECURSIVE up AS (
  SELECT id, parent_clip_id, title, 0 AS hops
  FROM clips WHERE id = 11
  UNION ALL
  SELECT c.id, c.parent_clip_id, c.title, u.hops + 1
  FROM clips c
  JOIN up u ON c.id = u.parent_clip_id      -- the parent of the current row
)
SELECT title FROM up ORDER BY hops DESC;
-- Welcome, Latte, Oat milk
```

The only change is the join direction: `c.id = u.parent_clip_id` instead of
`c.parent_clip_id = u.id`. The same shape walks an **org chart** (`employees.manager_id` in the
shop dataset), category trees, comment threads and folder hierarchies.

:::quiz id=db-09-q5 xp=15
Spot the bug. This is meant to print the breadcrumb for clip 7 (*The vault*):
`Intro, Front door, Sneak past, The vault`. What does it actually return?

```sql
WITH RECURSIVE up AS (
  SELECT id, parent_clip_id, title FROM clips WHERE id = 7
  UNION ALL
  SELECT c.id, c.parent_clip_id, c.title
  FROM clips c
  JOIN up u ON c.parent_clip_id = u.id
)
SELECT title FROM up;
```

- [x] Just `The vault` — the join walks **down** to children, and clip 7 has none
- [ ] The four titles, but in the wrong order (no `ORDER BY`)
- [ ] It never stops, because there's no depth limit
- [ ] An error: a recursive CTE needs a `depth` column
> `c.parent_clip_id = u.id` means "rows whose parent is the current row" — children. The vault is
> an ending, so the first recursive step finds nothing and the recursion stops after the anchor.
> Walking **up** needs `c.id = u.parent_clip_id` ("the row that is my parent"). There's no
> infinite loop (a tree always runs out of rows), and `depth` is optional — it's only there if you
> want to order or limit by it.
:::

### Infinite loops and how to prevent them

A tree can't loop — but data isn't always a tree. If someone sets clip 1's parent to clip 7,
the recursion never runs out of rows and the query spins until it hits `statement_timeout` (or
memory). Defences, from simplest to best:

1. **Depth limit:** add `WHERE t.depth < 50` to the recursive part.
2. **Track visited ids** in an array and refuse to revisit:

   ```sql
   SELECT c.id, t.visited || c.id
   FROM clips c JOIN tree t ON c.parent_clip_id = t.id
   WHERE c.id <> ALL (t.visited)
   ```

3. **The `CYCLE` clause** (PG 14+) does exactly that for you:

   ```sql
   WITH RECURSIVE tree AS (…)
     CYCLE id SET is_cycle USING visited
   SELECT * FROM tree WHERE NOT is_cycle;
   ```

4. **Prevent cycles in the data** — e.g. a trigger or application rule that rejects a parent
   which is a descendant of the clip.

Also note `UNION ALL` vs `UNION`: `UNION` removes duplicate rows at every step, which can stop
some cycles (an exact repeat is discarded) but costs a de-duplication each iteration and won't
help once a path column makes every row unique. Use `UNION ALL` plus an explicit guard.

:::quiz id=db-09-q2 xp=15
A recursive CTE walks a graph of **follows** between users, and the data contains
`A → B → A`. The recursive part carries `depth` and `path` columns and uses `UNION ALL`, with no
other guard. What happens?

- [ ] Postgres detects the cycle and stops automatically
- [ ] It returns each user once, because `UNION ALL` removes duplicates
- [x] It keeps producing rows forever (until a timeout or out of memory), because every step finds new rows
- [ ] It raises an error at parse time
> Postgres stops only when a step returns no rows. With a cycle, every step returns rows, and
> because `depth`/`path` differ each time, even `UNION` wouldn't see duplicates. `UNION ALL`
> never removes duplicates — that's the whole difference from `UNION`. Postgres doesn't detect
> cycles for you unless you ask with the `CYCLE` clause, and the query is perfectly valid, so
> there's no parse error. Add a depth limit, a visited-array check, or `CYCLE`.
:::

:::pro title="Trees in production"
`parent_id` + recursive CTE (an *adjacency list*) is the default and handles trees of thousands
of nodes easily with an index on `parent_clip_id`. For huge, read-heavy hierarchies teams use
alternatives: a **materialized path** (`'1/2/5/7'`, or the `ltree` extension) that makes
"all descendants" a prefix search, or a **closure table** storing every ancestor–descendant
pair. Each trades write complexity for read speed. Start with the adjacency list.
:::

## LATERAL: a subquery per row

A normal subquery in `FROM` can't see the other tables in the same `FROM` — write
`JOIN (SELECT … WHERE r.project_id = p.id …) j ON true` and Postgres answers *invalid reference
to FROM-clause entry for table "p"*. That's a problem for "the latest job **of this project**",
because `LIMIT 1` must apply per project, not to the whole table. `LATERAL` lifts that
restriction: the subquery runs **for each row** of the tables to its left and can reference
their columns. It's the SQL version of a `foreach` loop with a nested query — and the cleanest
way to write **"top N per group"**:

```sql
-- The most recent render job of each project
SELECT p.title, j.kind, j.status, j.created_at
FROM projects p
CROSS JOIN LATERAL (
  SELECT r.kind, r.status, r.created_at
  FROM render_jobs r
  WHERE r.project_id = p.id          -- ← uses p from the left side
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 1
) j;
```

- `CROSS JOIN LATERAL` drops left rows for which the subquery returns nothing (like an inner
  join).
- `LEFT JOIN LATERAL (…) j ON true` keeps them with NULLs (like a left join).

With an index on `render_jobs (project_id, created_at)`, each lateral lookup is a tiny index
probe — which makes this pattern fast even for millions of jobs. Next lesson you'll meet the
other classic solution, `ROW_NUMBER()`.

`LATERAL` is also how you call **set-returning functions** per row, e.g.
`FROM projects p, LATERAL jsonb_array_elements_text(p.doc->'tags') AS tag` — you'll use that in
the jsonb lesson. (For function calls, the `LATERAL` keyword is implied and usually omitted.)

:::sql id=db-09-sql8 db=studio ordered=true xp=50
title: Two latest jobs per project
For each project, show its **two most recent** render jobs. Return `title` (project), `kind` and
`created_at` (job). Sort by project `id`, then job `created_at` descending; when two jobs have
the same `created_at`, the higher job `id` comes first (and counts as more recent).

hint: `CROSS JOIN LATERAL (SELECT … FROM render_jobs r WHERE r.project_id = p.id ORDER BY … LIMIT 2) j`
hint: You need `j.id` for the final ORDER BY, so select it inside the lateral subquery too.

```sql starter
SELECT p.title, r.kind, r.created_at
FROM projects p
JOIN render_jobs r ON r.project_id = p.id
ORDER BY p.id, r.created_at DESC, r.id DESC;
```

```sql solution
SELECT p.title, j.kind, j.created_at
FROM projects p
CROSS JOIN LATERAL (
  SELECT r.id, r.kind, r.created_at
  FROM render_jobs r
  WHERE r.project_id = p.id
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 2
) j
ORDER BY p.id, j.created_at DESC, j.id DESC;
```
:::

## Choosing the right tool

| You want… | Reach for |
|---|---|
| Compare with one computed value | Scalar subquery |
| "Has at least one …" | `EXISTS` (or `IN`) |
| "Has no …" | `NOT EXISTS` — never `NOT IN` on a nullable column |
| Aggregate, then join | CTE (or derived table) |
| Several readable steps | Several CTEs |
| Trees, graphs, "all descendants" | `WITH RECURSIVE` |
| Top N per group, per-row function calls | `LATERAL` (or window functions) |

:::quiz id=db-09-q3 xp=10
You need each user's display name and their **number of projects**, including users with zero
projects. Which queries return 6 rows with correct counts? (Select all that apply.)

- [x] `SELECT u.display_name, (SELECT count(*) FROM projects p WHERE p.owner_id = u.id) FROM users u`
- [ ] `SELECT u.display_name, count(*) FROM users u JOIN projects p ON p.owner_id = u.id GROUP BY u.id, u.display_name`
- [x] `SELECT u.display_name, count(p.id) FROM users u LEFT JOIN projects p ON p.owner_id = u.id GROUP BY u.id, u.display_name`
- [ ] `SELECT u.display_name, count(*) FROM users u LEFT JOIN projects p ON p.owner_id = u.id GROUP BY u.id, u.display_name`
> The inner join drops Lena entirely. `LEFT JOIN … count(*)` counts her NULL row as 1. The
> correlated subquery and `LEFT JOIN … count(p.id)` (which ignores NULLs) both give Lena 0.
:::

:::cards id=db-09-cards1 xp=20 title="Subqueries & CTEs"
Q: What does a scalar subquery return when it finds no rows?
A: NULL. With more than one row it raises an error.
Q: Why does `x NOT IN (SELECT col …)` return nothing when `col` contains a NULL?
A: `x <> NULL` is unknown, so the whole `AND` chain is never TRUE. Use `NOT EXISTS`.
Q: What is a correlated subquery?
A: A subquery that references a column of the outer query, so (conceptually) it is evaluated per outer row.
Q: How does the planner usually execute EXISTS / NOT EXISTS?
A: As a semi-join / anti-join, which stops at the first match.
Q: Since which version are single-use CTEs inlined, and how do you force materialisation?
A: PostgreSQL 12. Write `WITH x AS MATERIALIZED (…)` (or `NOT MATERIALIZED` to force inlining).
Q: The two parts of a recursive CTE?
A: An anchor query (starting rows) UNION ALL a recursive query that references the CTE — which, there, means only the rows found in the previous iteration.
Q: When does a recursive CTE stop?
A: When an iteration returns no new rows.
Q: Three ways to guard against cycles?
A: A depth limit, an array of visited ids (`id <> ALL(visited)`), or the `CYCLE … SET … USING …` clause (PG 14+).
Q: Walk down vs up a parent_id tree — what changes?
A: The join: down is `child.parent_id = tree.id`, up is `parent.id = tree.parent_id`.
Q: What does LATERAL allow?
A: A subquery in FROM that references columns of tables to its left — run once per left row. Ideal for top-N per group.
Q: CROSS JOIN LATERAL vs LEFT JOIN LATERAL … ON true?
A: CROSS drops left rows where the subquery returns nothing; LEFT keeps them with NULLs.
Q: Semi-join vs anti-join?
A: Semi-join (`IN`, `EXISTS`): keep each left row once if at least one match exists. Anti-join (`NOT EXISTS`): keep the left row only if no match exists.
Q: How do you get a reliable depth-first order out of a recursive CTE?
A: `SEARCH DEPTH FIRST BY id SET ord` (PG 14+), then `ORDER BY ord`. Sorting by a text path works for simple cases but depends on collation and separators.
Q: In a data-modifying CTE, how does the next step see the changed rows?
A: Only through `RETURNING`. All sub-statements share one snapshot, so reading the table directly still shows the old rows.
:::

## Recap

- A **scalar subquery** returns one value (NULL if no row); use it where aggregates can't go, like `WHERE`.
- `IN` and `EXISTS` are **semi-joins**: each outer row at most once, no duplicates from multiple matches.
- **Never use `NOT IN` against a nullable column** — one NULL empties the result. Use `NOT EXISTS`.
- **Correlated subqueries** compare a row with its own group; watch for per-row `SubPlan`s at scale.
- **CTEs** turn nested queries into named, readable steps; since PG 12 a non-recursive, side-effect-free CTE referenced once is inlined (use `MATERIALIZED` / `NOT MATERIALIZED` to override).
- **Recursive CTEs** = anchor + `UNION ALL` + recursive step; carry `depth`, `path` and running totals down the tree; guard against cycles.
- **`LATERAL`** runs a subquery per left row — the go-to for "latest N per parent".
