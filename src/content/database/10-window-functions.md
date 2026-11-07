---
id: db-10
title: Window Functions
level: intermediate
minutes: 60
xp: 150
summary: OVER and PARTITION BY — running credit balances, rankings, top-N per group, LAG/LEAD, moving averages and window frames, without collapsing your rows.
---

`GROUP BY` answers questions like *"what is each user's credit balance?"* — but it **collapses**
rows: one output row per group. Very often you want the detail rows **and** a calculation over
their neighbors:

- Show every ledger entry **and** the balance after it (a bank statement).
- Show every clip **and** its share of the project's total runtime.
- Rank projects, keep the **top 2 per owner**.
- Compare each render job with the **previous** one.

That's what **window functions** do. They compute a value for each row by looking at a *window*
of related rows, and they never remove rows. They are one of the most useful features in SQL
and a favorite interview topic — and they turn many "load everything into C# and loop" jobs into
one query.

Four words you'll see throughout this lesson:

| Term | Meaning |
|---|---|
| **window** | the set of rows a function looks at when computing the value for the current row |
| **partition** | a group of rows that share the `PARTITION BY` values; windows never cross partitions |
| **peers** | rows that are *equal* on the window's `ORDER BY` (ties) |
| **frame** | the slice of the partition an aggregate actually sees for the current row (e.g. "start → here") |

Window functions are only allowed in the `SELECT` list and in the final `ORDER BY` — not in
`WHERE`, `GROUP BY` or `HAVING`. You'll see why when we get to top-N queries.

## OVER(): aggregates that keep the rows

Any aggregate becomes a window function when you add `OVER (…)`:

```sql
SELECT id, title, duration_ms,
       sum(duration_ms) OVER ()   AS all_clips_ms,
       avg(duration_ms) OVER ()   AS avg_clip_ms
FROM clips;
```

`OVER ()` with nothing inside means "the window is the entire result". Each of the 19 clips is
still there; each row just gains two columns holding the grand total and the average. Compare:

| Query | Rows out |
|---|---|
| `SELECT sum(duration_ms) FROM clips` | 1 |
| `SELECT project_id, sum(duration_ms) FROM clips GROUP BY project_id` | 5 (one per project) |
| `SELECT id, sum(duration_ms) OVER (PARTITION BY project_id) FROM clips` | 19 (every clip) |

## PARTITION BY: a window per group

`PARTITION BY` splits the rows into groups, and the function only sees the rows of the current
row's group — like `GROUP BY`, but without collapsing:

```sql
SELECT project_id, title, duration_ms,
       sum(duration_ms) OVER (PARTITION BY project_id) AS project_ms
FROM clips
ORDER BY project_id, id;
```

| project_id | title | duration_ms | project_ms |
|---|---|---|---|
| 1 | Intro | 12000 | 63000 |
| 1 | Front door | 8000 | 63000 |
| … | | | |
| 3 | Welcome | 4000 | 13000 |

Now "each clip's share of its project" is plain arithmetic on the same row.

:::sql id=db-10-sql1 db=studio ordered=true xp=30
title: Share of the story
For every clip, return `project_id`, `title`, `duration_ms`, `project_ms` (total duration of
all clips in the same project) and `pct` — the clip's share of `project_ms` in percent, rounded to
1 decimal. Sort by `project_id`, then clip `id`.

hint: `sum(duration_ms) OVER (PARTITION BY project_id)`
hint: `round(100.0 * duration_ms / sum(duration_ms) OVER (PARTITION BY project_id), 1)`

```sql starter
SELECT project_id, title, duration_ms,
       sum(duration_ms) OVER () AS project_ms
FROM clips
ORDER BY project_id, id;
```

```sql solution
SELECT project_id, title, duration_ms,
       sum(duration_ms) OVER (PARTITION BY project_id) AS project_ms,
       round(100.0 * duration_ms / sum(duration_ms) OVER (PARTITION BY project_id), 1) AS pct
FROM clips
ORDER BY project_id, id;
```
:::

:::quiz id=db-10-q1 xp=10
`render_jobs` has 12 rows in 6 projects. How many rows does this return?

```sql
SELECT project_id, count(*) OVER (PARTITION BY project_id)
FROM render_jobs;
```

- [ ] 6
- [x] 12
- [ ] 1
- [ ] It's an error — `count(*)` needs a `GROUP BY`
> Window functions never remove rows: you get all 12 jobs, each annotated with how many jobs its
> project has. "6" is what `GROUP BY project_id` would return — the classic confusion. And
> `count(*)` doesn't need `GROUP BY` here, because `OVER (…)` turns it into a window function.
> Add `DISTINCT` or use `GROUP BY` if you want one row per project.
:::

### Windows over grouped results

Because window functions run **after** `GROUP BY`, you can window over the groups themselves.
The classic use is "share of the total" — the inner `count(*)` is the normal per-group
aggregate, and `sum(…) OVER ()` adds those group counts up across all groups:

```sql
SELECT status,
       count(*) AS jobs,
       round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct
FROM render_jobs
GROUP BY status
ORDER BY jobs DESC, status;
```

| status | jobs | pct |
|---|---|---|
| done | 6 | 50.0 |
| queued | 3 | 25.0 |
| failed | 2 | 16.7 |
| running | 1 | 8.3 |

`sum(count(*)) OVER ()` looks odd the first time, but read it inside-out: `count(*)` is
evaluated per group, then the window sums those 4 values.

:::quiz id=db-10-q5 xp=10
`render_jobs` has 12 rows with 4 distinct statuses. What does the `n` column show?

```sql
SELECT status, count(*) OVER () AS n
FROM render_jobs
GROUP BY status;
```

- [ ] 12 on every row — the number of jobs
- [x] 4 on every row — the number of groups
- [ ] The number of jobs with that status
- [ ] An error — you can't mix `GROUP BY` and `OVER`
> The window runs **after** `GROUP BY`, so it sees the 4 grouped rows, not the 12 original jobs —
> `count(*) OVER ()` counts those 4. "12" assumes the window sees the raw table; for that you'd
> need `sum(count(*)) OVER ()`. The per-status count is plain `count(*)` without `OVER`. Mixing
> the two is legal and common.
:::

## ORDER BY inside OVER: running totals

Add `ORDER BY` inside the window and aggregates become **cumulative**: for each row, the
function sees the rows of its partition **from the start up to the current row** (plus any
peers of the current row — more on that under *Frames*). That's a running total — and for a
ledger, a running total *is* the balance.

```sql
SELECT user_id, created_at, delta, reason,
       sum(delta) OVER (PARTITION BY user_id ORDER BY created_at, id) AS balance
FROM credit_ledger
WHERE user_id = 2
ORDER BY created_at, id;
```

| created_at | delta | reason | balance |
|---|---|---|---|
| 2025-05-01 00:00 | 200 | plan:pro monthly | 200 |
| 2025-05-20 18:35 | −25 | ai transition | 175 |
| 2025-05-20 18:40 | 25 | refund: failed job 4 | 200 |
| 2025-05-20 18:45 | −10 | publish | 190 |

This is why fintech-style systems store an **append-only ledger** instead of a mutable
`balance` column: the history is the source of truth, and any balance at any point in time is
one window function away. (Many systems *also* cache the current balance for speed — but the
ledger is what auditors and support look at.)

:::sql id=db-10-sql2 db=studio ordered=true xp=40
title: The credit statement
Build a statement for **all users**: return `user_id`, ledger `id`, `delta` and `balance` — the
user's balance after that entry (running sum of `delta` in `created_at` order, ties broken by
`id`). Sort by `user_id`, then `created_at`, then `id`.

hint: `sum(delta) OVER (PARTITION BY user_id ORDER BY created_at, id)`

```sql starter
SELECT user_id, id, delta,
       sum(delta) OVER (PARTITION BY user_id) AS balance
FROM credit_ledger
ORDER BY user_id, created_at, id;
```

```sql solution
SELECT user_id, id, delta,
       sum(delta) OVER (PARTITION BY user_id ORDER BY created_at, id) AS balance
FROM credit_ledger
ORDER BY user_id, created_at, id;
```
:::

:::warn title="Put the tiebreaker in the window, too"
The window's `ORDER BY` and the query's final `ORDER BY` are **independent**. The window decides
*how the running total accumulates*; the final one decides *how rows are printed*. If the window
orders only by `created_at` and two entries share a timestamp, the result is surprising (see
frames below) — always make the window's ordering unique with a tiebreaker like `id`.
:::

## Ranking: ROW_NUMBER, RANK, DENSE_RANK

Ranking functions take no argument; they number rows in the window's order:

| Function | Ties | Example for values 3, 2, 1, 1, 0 |
|---|---|---|
| `row_number()` | Unique numbers; order among ties is arbitrary | 1, 2, 3, 4, 5 |
| `rank()` | Ties share a rank, then **gaps** (like sports) | 1, 2, 3, 3, 5 |
| `dense_rank()` | Ties share a rank, **no gaps** | 1, 2, 3, 3, 4 |

`row_number()` on ties is non-deterministic unless the `ORDER BY` is unique — add a tiebreaker.
Other handy ones: `ntile(4)` (quartiles), `percent_rank()` and `cume_dist()` (percentiles).

:::sql id=db-10-sql3 db=studio ordered=true xp=40
title: Most retried jobs
Rank all render jobs by `attempts`, highest first. Return `id`, `attempts`, `rn`
(`row_number`, ties broken by `id` ascending), `rnk` (`rank`) and `drnk` (`dense_rank`). Sort by
`attempts` descending, then `id`.

hint: `rank() OVER (ORDER BY attempts DESC)` — no tiebreaker for rank/dense_rank, they *should* tie.
hint: `row_number() OVER (ORDER BY attempts DESC, id)`

```sql starter
SELECT id, attempts,
       row_number() OVER (ORDER BY attempts DESC, id) AS rn,
       row_number() OVER (ORDER BY attempts DESC, id) AS rnk,
       row_number() OVER (ORDER BY attempts DESC, id) AS drnk
FROM render_jobs
ORDER BY attempts DESC, id;
```

```sql solution
SELECT id, attempts,
       row_number() OVER (ORDER BY attempts DESC, id) AS rn,
       rank()       OVER (ORDER BY attempts DESC)     AS rnk,
       dense_rank() OVER (ORDER BY attempts DESC)     AS drnk
FROM render_jobs
ORDER BY attempts DESC, id;
```
:::

:::quiz id=db-10-q2 xp=10
Scores are 90, 80, 80, 70. What does `rank()` (highest first) give the 70?

- [ ] 3
- [x] 4
- [ ] 2
- [ ] 5
> `rank()` counts how many rows come strictly before this one, plus 1: three rows beat the 70,
> so it gets **4** (1, 2, 2, 4). "3" is the tempting answer, but that's `dense_rank()`, which
> doesn't leave gaps. `row_number()` would also give the 70 a 4, but it would give the two 80s
> different numbers (2 and 3).
:::

## Top-N per group

"The 2 longest clips of each project", "the latest order per customer", "the best-selling product
per category": the top-N-per-group question comes up constantly. The pattern:

1. Number rows **within each group** with `row_number() OVER (PARTITION BY group ORDER BY …)`.
2. Filter on that number **in an outer query**.

```sql
WITH ranked AS (
  SELECT c.*,
         row_number() OVER (PARTITION BY project_id ORDER BY duration_ms DESC, id) AS rn
  FROM clips c
)
SELECT project_id, title, duration_ms
FROM ranked
WHERE rn <= 2;
```

Why the CTE? Because of the **logical order** of a query: `FROM → WHERE → GROUP BY → HAVING →
window functions → SELECT → DISTINCT → ORDER BY → LIMIT`. Window functions are computed *after*
`WHERE`, so `WHERE row_number() OVER (…) <= 2` is not allowed — the number doesn't exist yet when
`WHERE` runs. Compute it in a subquery or CTE, then filter outside.

:::tip title="DISTINCT ON — the Postgres shortcut for top-1"
For exactly **one** row per group, Postgres has `DISTINCT ON`:

```sql
SELECT DISTINCT ON (project_id) project_id, title, duration_ms
FROM clips
ORDER BY project_id, duration_ms DESC, id;   -- first row per project_id wins
```

The `ORDER BY` must start with the `DISTINCT ON` columns. It's concise but Postgres-only; the
`row_number()` version works everywhere and handles top-N.
:::

:::sql id=db-10-sql4 db=studio ordered=true xp=50
title: Two longest clips per project
For each project, return its **two longest clips**: `project_id`, `title`, `duration_ms`. If two
clips have the same duration, the one with the lower `id` wins. Sort by `project_id`, then
`duration_ms` descending, then `title`.

hint: `row_number() OVER (PARTITION BY project_id ORDER BY duration_ms DESC, id) AS rn` in a CTE.
hint: Then `WHERE rn <= 2` in the outer query.

```sql starter
SELECT project_id, title, duration_ms
FROM clips
ORDER BY project_id, duration_ms DESC, title
LIMIT 2;
```

```sql solution
WITH ranked AS (
  SELECT project_id, title, duration_ms,
         row_number() OVER (PARTITION BY project_id ORDER BY duration_ms DESC, id) AS rn
  FROM clips
)
SELECT project_id, title, duration_ms
FROM ranked
WHERE rn <= 2
ORDER BY project_id, duration_ms DESC, title;
```
:::

:::quiz id=db-10-q3 xp=10
Why does this fail?

```sql
SELECT id, title, row_number() OVER (ORDER BY duration_ms DESC) AS rn
FROM clips
WHERE rn <= 3;
```

- [ ] `row_number()` requires `PARTITION BY`
- [x] `WHERE` runs before window functions (and before `SELECT` aliases exist), so `rn` isn't known there
- [ ] You can't use `ORDER BY` inside `OVER`
- [ ] It doesn't fail; it returns the 3 longest clips
> Logical order: FROM → WHERE → GROUP BY → HAVING → window → SELECT → ORDER BY → LIMIT. Postgres
> reports *column "rn" does not exist*: the alias is created later, in `SELECT`. Writing the
> function itself into `WHERE` doesn't help either — that gives *window functions are not allowed
> in WHERE*. `PARTITION BY` is optional (without it, the whole result is one partition), and
> `ORDER BY` inside `OVER` is exactly what ranking needs. Wrap the query in a CTE or subquery and
> filter `rn` outside. (For a global top 3, plain `ORDER BY … LIMIT 3` is simpler.)
:::

## LAG and LEAD: the previous and next row

`lag(expr)` returns `expr` from the **previous** row in the window's order; `lead(expr)` from the
**next** one. Both return `NULL` when there is no such row, and accept an offset and a default:
`lag(expr, 2, 0)`.

They're the tool for "change since last time":

```sql
-- What happened before and after each ledger entry?
SELECT user_id, created_at, delta,
       lag(reason)  OVER w AS previous_reason,
       lead(reason) OVER w AS next_reason
FROM credit_ledger
WINDOW w AS (PARTITION BY user_id ORDER BY created_at, id)
ORDER BY user_id, created_at, id;
```

The `WINDOW w AS (…)` clause names a window definition so you don't repeat it — use it whenever
two or more functions share the same window.

Typical uses: time between events (session gaps, time between deploys), day-over-day growth,
detecting status changes (`status <> lag(status)`), or validating that a sequence has no gaps.

`lag` and `lead` look at the previous/next row of the **partition**, in window order — they
ignore frames. So the one thing you must get right is `PARTITION BY`: without it, the "previous
row" of a user's first entry is the *last entry of the previous user*.

:::quiz id=db-10-q6 xp=15
Spot the bug. This should show, for each render job, the status of the **previous job of the same
project**:

```sql
SELECT project_id, id, status,
       lag(status) OVER (ORDER BY project_id, created_at, id) AS prev_status
FROM render_jobs;
```

What does job 9 (the only job of project 2) show as `prev_status`?

- [ ] `NULL`, because it's the first job of its project
- [x] `done` — the status of project 1's last job
- [ ] `failed` — its own status
- [ ] Nothing: the query fails without `PARTITION BY`
> With no `PARTITION BY`, the whole table is one window, so `lag` happily reaches back into
> project 1. Ordering by `project_id` first makes the output *look* grouped, but it doesn't
> create partitions. `NULL` is what you'd get with
> `OVER (PARTITION BY project_id ORDER BY created_at, id)` — the fix. `PARTITION BY` is optional
> syntax, so there's no error.
:::

:::sql id=db-10-sql5 db=studio ordered=true xp=50
title: Time since the previous job
For every render job, return `project_id`, `id`, `kind` and `gap_s` — the number of seconds
between this job's `created_at` and the **previous job of the same project** (`NULL` for the
first job of a project). Jobs are ordered by `created_at`, ties broken by `id`. Sort the output
the same way: `project_id`, `created_at`, `id`.

hint: `lag(created_at) OVER (PARTITION BY project_id ORDER BY created_at, id)`
hint: Subtracting two timestamps gives an interval; `extract(epoch FROM interval)` turns it into seconds.

```sql starter
SELECT project_id, id, kind,
       extract(epoch FROM created_at - lag(created_at) OVER (ORDER BY created_at, id)) AS gap_s
FROM render_jobs
ORDER BY project_id, created_at, id;
```

```sql solution
SELECT project_id, id, kind,
       extract(epoch FROM created_at
         - lag(created_at) OVER (PARTITION BY project_id ORDER BY created_at, id)) AS gap_s
FROM render_jobs
ORDER BY project_id, created_at, id;
```
:::

## Frames: which rows the window sees

Every aggregate used as a window function (and `first_value`, `last_value`, `nth_value`) only
sees its **frame**: a subset of the partition defined relative to the current row. Without
`ORDER BY` in the window the frame is the whole partition; with `ORDER BY` it is, by default,
"start of the partition up to the current row". Ranking functions and `lag`/`lead` ignore the
frame. You can spell the frame out:

```sql
sum(x) OVER (ORDER BY day ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)
```

| Frame | Meaning |
|---|---|
| `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | Start of partition → this row (running total) |
| `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW` | This row and the 6 before it (7-row moving window) |
| `ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING` | Previous, current, next (smoothing) |
| `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` | The whole partition |
| `RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW` | All rows whose *value* is at most 6 days before this row's: a 7-calendar-day window that handles missing days correctly |

Three frame modes:

- **`ROWS`** counts physical rows.
- **`RANGE`** works on the *value* of the `ORDER BY` column: rows with equal values ("peers")
  are always in or out together, and offsets like `INTERVAL '7 days'` are measured in value.
- **`GROUPS`** counts groups of peers: `GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW` means "my
  tie-group and the one before it".

`RANGE` with an offset (`INTERVAL '7 days' PRECEDING`) needs exactly one `ORDER BY` column of a
type you can subtract from (numbers, dates, timestamps).

### The default frame (and its two classic traps)

When you write `ORDER BY` without a frame, the default is
**`RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`**. Two consequences:

1. **Ties are summed together.** If two ledger rows share a `created_at` and the window orders
   only by `created_at`, both rows are peers, so *both* show the balance including *both* deltas.
   A tiebreaker in the window's `ORDER BY` (or `ROWS`) fixes it.
2. **`last_value()` looks broken.** `last_value(x) OVER (ORDER BY …)` returns the *current* row's
   value (or its last peer's), because the frame ends at the current row. For the true last value
   of the partition use `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` — or, simpler,
   `first_value(x) OVER (… ORDER BY … DESC)`.

:::quiz id=db-10-q4 xp=15
A ledger has two rows for the same user with the **same** `created_at`: `+100` and `−30`, and no
other rows. What does this show on both rows?

```sql
SELECT delta, sum(delta) OVER (ORDER BY created_at) AS balance
FROM ledger;
```

- [ ] 100 and 70
- [x] 70 and 70
- [ ] 100 and −30
- [ ] It depends on the physical order of the rows
> The default frame is `RANGE … CURRENT ROW`, and rows with equal `created_at` are peers that are
> included together. Both rows see the full sum, 70 — deterministically, so "it depends on the
> physical order" is wrong (that *would* be true with a `ROWS` frame and no tiebreaker). "100 and
> 70" is the statement you *wanted*; `ORDER BY created_at, id` gives it to you reliably (with the
> +100 entry having the lower `id`).
:::

### Moving averages

Dashboards love smoothing: a 7-day moving average hides weekday noise. With a frame, it's one
line:

```sql
SELECT day, renders,
       round(avg(renders) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 1) AS avg_7d
FROM daily_renders;
```

Note the first rows: the frame just has fewer rows (day 1 averages 1 day, day 2 averages 2),
which is usually what you want. If days can be missing, `ROWS` silently averages over more than
7 calendar days — use `RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW` on a date or
timestamp column, or generate the missing days with `generate_series` first.

:::sql id=db-10-sql6 db=empty ordered=true xp=40
title: Smoothing the render chart
The table `daily_renders(day date, renders int)` has one row per day for two weeks. Return `day`,
`renders` and `avg_3d` — the average of the **current and the two previous days**, rounded to 2
decimals. Sort by `day`.

hint: `avg(renders) OVER (ORDER BY day ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)`
hint: `round(…, 2)` around the whole window expression.

```sql setup
CREATE TABLE daily_renders (day date PRIMARY KEY, renders int NOT NULL);
INSERT INTO daily_renders VALUES
  ('2025-07-01', 12), ('2025-07-02', 15), ('2025-07-03',  9), ('2025-07-04', 20),
  ('2025-07-05', 18), ('2025-07-06',  0), ('2025-07-07',  3), ('2025-07-08', 25),
  ('2025-07-09', 30), ('2025-07-10', 22), ('2025-07-11',  0), ('2025-07-12',  0),
  ('2025-07-13', 14), ('2025-07-14', 16);
```

```sql starter
SELECT day, renders,
       round(avg(renders) OVER (ORDER BY day), 2) AS avg_3d
FROM daily_renders
ORDER BY day;
```

```sql solution
SELECT day, renders,
       round(avg(renders) OVER (ORDER BY day ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 2) AS avg_3d
FROM daily_renders
ORDER BY day;
```
:::

## Gaps and islands: a classic interview pattern (advanced, optional)

:::info title="Optional: an advanced pattern"
This section is a step up from the rest of the lesson. It combines window functions with
grouping in a way that interviewers love and that you'll need only now and then at work. Skip it
on a first pass if you like and come back once `row_number()` and `GROUP BY` over a CTE feel
routine. Nothing later in the region depends on it.
:::

*"Find each streak of consecutive active days."* The trick: in a run of consecutive dates,
`day - row_number()` is **constant**. When there is a gap, the date jumps by more than the row
number, so the difference changes:

| day | row_number | day − row_number |
|---|---|---|
| 07-01 | 1 | 06-30 |
| 07-02 | 2 | 06-30 |
| 07-03 | 3 | 06-30 |
| 07-05 | 4 | 07-01 |
| 07-06 | 5 | 07-01 |

Group by that difference and every group is one *island* (streak). The same idea finds
consecutive failed jobs, uninterrupted subscriptions, or sessions separated by >30 min idle
(with `lag()` to flag "new session starts here" and a running `sum()` of those flags to number
the sessions).

:::sql id=db-10-sql7 db=empty ordered=true xp=60
title: Render streaks (advanced, optional)
`active_days(day date)` holds the days on which a studio rendered at least one video. Find every
streak of **consecutive** days. Return `start_day`, `end_day` and `days` (length of the streak).
Sort by `start_day`.

hint: `day - (row_number() OVER (ORDER BY day))::int AS grp` — a date minus an integer is a date.
hint: Then `GROUP BY grp` with `min(day)`, `max(day)` and `count(*)`.

```sql setup
CREATE TABLE active_days (day date PRIMARY KEY);
INSERT INTO active_days VALUES
  ('2025-07-01'), ('2025-07-02'), ('2025-07-03'),
  ('2025-07-05'), ('2025-07-06'),
  ('2025-07-09'), ('2025-07-10'), ('2025-07-11'), ('2025-07-12'), ('2025-07-13'),
  ('2025-07-20');
```

```sql starter
SELECT min(day) AS start_day, max(day) AS end_day, count(*) AS days
FROM active_days;
```

```sql solution
WITH g AS (
  SELECT day, day - (row_number() OVER (ORDER BY day))::int AS grp
  FROM active_days
)
SELECT min(day) AS start_day, max(day) AS end_day, count(*) AS days
FROM g
GROUP BY grp
ORDER BY start_day;
```
:::

:::job title="Where window functions show up at work"
Analytics endpoints ("usage over time", "rank my projects"), billing statements, admin
dashboards and data-quality checks are full of them. EF Core generates `ROW_NUMBER() OVER
(PARTITION BY …)` by itself for a few LINQ shapes (e.g. `GroupBy(…).Select(g => g.OrderBy(…).First())`),
but LINQ has no way to say "running total", `LAG` or a frame. For those you write SQL: map a
database **view** to a keyless entity, or call `context.Database.SqlQuery<StatementRow>($"…")`
(an interpolated string, so values become parameters, never string-concatenated SQL). Being the
person who can replace a 200-line C# loop with a 10-line window query is a quick way to earn
trust on a new team.
:::

:::pro title="Performance notes"
Each distinct window (`PARTITION BY` + `ORDER BY`) needs the rows sorted that way; the plan shows
a `WindowAgg` above a `Sort`. An index matching the window's order (e.g.
`credit_ledger (user_id, created_at, id)`) can remove the sort. Reuse one named `WINDOW` for
several functions so Postgres sorts once. And filter **before** windowing when you can (in
`WHERE`), so fewer rows get sorted — but remember that filtering changes what the window sees.
:::

:::cards id=db-10-cards1 xp=20 title="Window functions"
Q: Difference between GROUP BY and a window function?
A: GROUP BY collapses each group to one row; a window function adds a computed value to every row and keeps them all.
Q: What does `PARTITION BY` do?
A: Splits rows into groups; the window function only sees rows of the current row's partition.
Q: What does `ORDER BY` inside `OVER` change for an aggregate like sum()?
A: It becomes cumulative: by default it sums from the start of the partition up to the current row (and its peers).
Q: The default frame when the window has ORDER BY?
A: `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` — peers (ties) are included together.
Q: row_number vs rank vs dense_rank on ties?
A: row_number: unique numbers (1,2,3,4). rank: shared rank then gap (1,2,2,4). dense_rank: shared, no gap (1,2,2,3).
Q: Why can't you filter `WHERE row_number() OVER (…) <= 3`?
A: Window functions run after WHERE. Compute in a CTE/subquery, filter outside.
Q: What do lag() and lead() return?
A: The value from the previous / next row in the window order (NULL, or a given default, if none).
Q: How do you write a 7-row moving average?
A: `avg(x) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)`.
Q: Why does `last_value(x) OVER (ORDER BY …)` return the current row's value?
A: The default frame ends at the current row. Use `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`, or first_value with DESC.
Q: The gaps-and-islands trick for consecutive dates?
A: `day - row_number() OVER (ORDER BY day)` is constant within a streak; GROUP BY it.
Q: What is the WINDOW clause for?
A: Naming a window definition (`WINDOW w AS (…)`) and reusing it with `OVER w` in several functions.
Q: How do you compute each group's share of the total after GROUP BY?
A: `100.0 * count(*) / sum(count(*)) OVER ()` — the window runs after grouping and sums the per-group counts.
Q: Where are window functions allowed?
A: Only in the SELECT list and the final ORDER BY — not in WHERE, GROUP BY or HAVING.
Q: Do lag()/lead() respect the window frame?
A: No. They step through the partition in window order; only aggregates and first/last/nth_value use the frame.
:::

## Recap

- `OVER (…)` turns an aggregate into a **window function**: a value per row, no rows removed.
- `PARTITION BY` = per-group windows; `ORDER BY` in the window = cumulative (running totals, balances from a ledger).
- Windows run after `WHERE`/`GROUP BY`/`HAVING`: filter on them in an outer query, and window over grouped rows with `sum(count(*)) OVER ()`.
- `row_number`, `rank`, `dense_rank` differ only on ties; make orderings unique with tiebreakers.
- **Top-N per group**: `row_number() OVER (PARTITION BY … ORDER BY …)` in a CTE, filter `rn <= N` outside (or `DISTINCT ON` for top-1).
- `lag` / `lead` compare a row with its neighbors — gaps, deltas, status changes.
- **Frames** (`ROWS` / `RANGE` / `GROUPS`) control which rows are seen; know the default and its tie and `last_value` traps.
- Gaps-and-islands: `value - row_number()` groups consecutive runs.
