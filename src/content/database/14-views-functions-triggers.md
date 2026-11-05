---
id: db-14
title: Views, Functions & Triggers
level: advanced
minutes: 40
xp: 200
summary: Name your queries with views, cache them with materialized views, put rules next to the data with SQL and PL/pgSQL functions, and automate updated_at, versions and audit logs with triggers.
---

So far every query has been something you type and run. Real systems give names to the queries
they use all the time, keep some rules right next to the data, and react automatically when rows
change. PostgreSQL offers a family of tools for that:

| Tool | What it is | Typical use |
|---|---|---|
| **View** | a stored, named `SELECT` | hide join complexity, a stable read model, permissions |
| **Materialized view** | a view whose result is stored on disk | expensive dashboards and reports |
| **Function** | named SQL or PL/pgSQL code, callable from queries | reusable calculations, atomic business operations |
| **Trigger** | a function run automatically on INSERT/UPDATE/DELETE | `updated_at`, version bumps, audit logs, keeping derived data in sync |
| **Generated column** | a column computed from other columns | derived values without triggers |

They are powerful — and easy to overuse. We'll learn each one on the **studio** dataset, and end
with the question every team argues about: *does this logic belong in the database or in the app?*

## Views: a name for a query

A **view** is a saved `SELECT`. It stores no data; every time you query it, Postgres expands the
view's definition into your query and plans the whole thing together (so filters you add on the
outside are pushed down into it).

```sql
CREATE VIEW project_overview AS
SELECT p.id,
       p.title,
       u.display_name AS owner,
       p.published,
       (SELECT count(*) FROM clips c WHERE c.project_id = p.id) AS clip_count
FROM projects p
JOIN users u ON u.id = p.owner_id;

SELECT * FROM project_overview WHERE published ORDER BY id;
```

Why bother?

- **One definition of a concept.** "Active subscriber" or "project clip count" is written once
  and every report agrees.
- **A stable interface.** You can refactor the tables underneath and keep the view's columns the
  same for the BI tool or the legacy service that reads it.
- **Security.** Grant a reporting role `SELECT` on a view that leaves out `users.email`, and no
  access to the base table. This works because, by default, a view reads its base tables with the
  *view owner's* privileges. If you instead want the *caller's* privileges and row-level security
  policies checked (PG 15+), create it `WITH (security_invoker = true)`.

Changing a view later has rules:

- `CREATE OR REPLACE VIEW` can **add** columns at the end, but can't drop columns, reorder them or
  change their types — for that you `DROP VIEW` and recreate it (in a migration). Renaming a column
  is `ALTER VIEW … RENAME COLUMN`.
- **`SELECT *` is frozen at creation time.** Postgres expands the `*` into a fixed column list when
  the view is created, so a column added to the table later does *not* appear in the view until you
  recreate it. Spell out the columns in views; it makes this explicit.

Simple views are even **updatable**: if a view selects from exactly **one** table with no
`GROUP BY`, `DISTINCT`, aggregates or window functions, Postgres maps `INSERT`/`UPDATE`/`DELETE` on
the view back to that table:

```sql
CREATE VIEW published_projects AS
SELECT id, title, published FROM projects WHERE published
WITH CHECK OPTION;                 -- reject writes that would fall outside the view

UPDATE published_projects SET title = 'The Heist (4K)' WHERE id = 1;    -- updates projects
UPDATE published_projects SET published = false WHERE id = 1;           -- ERROR: violates check option
```

`project_overview` above is **not** auto-updatable — it joins two tables and has a subquery
column, so Postgres can't know which row an `UPDATE` should change.

:::sql id=db-14-sql1 db=studio xp=40
title: A stats view
Create a view `project_stats` with the columns `project_id`, `title`, `clip_count` and
`total_duration_ms` (sum of clip durations). **Every** project must appear — projects without
clips get `0` for both numbers.

We check `SELECT * FROM project_stats ORDER BY project_id`.

hint: `LEFT JOIN clips` and `count(c.id)` (count of a column ignores NULLs).
hint: `coalesce(sum(c.duration_ms), 0)` — `sum` over no rows is NULL.

```sql starter
CREATE VIEW project_stats AS
SELECT p.id AS project_id, p.title, count(*) AS clip_count, sum(c.duration_ms) AS total_duration_ms
FROM projects p
JOIN clips c ON c.project_id = p.id
GROUP BY p.id, p.title;
```

```sql solution
CREATE VIEW project_stats AS
SELECT p.id AS project_id,
       p.title,
       count(c.id) AS clip_count,
       coalesce(sum(c.duration_ms), 0) AS total_duration_ms
FROM projects p
LEFT JOIN clips c ON c.project_id = p.id
GROUP BY p.id, p.title;
```

```sql check
SELECT * FROM project_stats ORDER BY project_id;
```
:::

:::quiz id=db-14-q6 xp=10
A view was created months ago as `CREATE VIEW user_list AS SELECT * FROM users;`. Today a
migration runs `ALTER TABLE users ADD COLUMN locale text;`. What does `SELECT * FROM user_list`
return now?

- [ ] All columns including `locale` — a view is just a saved query, re-expanded every time
- [x] The original columns only — the `*` was expanded into a fixed column list when the view was created
- [ ] An error, because the view's definition no longer matches the table
- [ ] All columns, but `locale` is always `NULL` in the view
> The view's query *is* re-run every time, but its column list is fixed when it's created:
> Postgres stores `SELECT users.id, users.email, …`, not `*`. New table columns stay invisible
> until you `CREATE OR REPLACE VIEW` (adding a column at the end is allowed). That's also why
> dropping a column that a view uses fails — the view depends on it explicitly.
:::

## Materialized views: cache the answer

A normal view runs its query every time. When that query is expensive — a dashboard aggregating
millions of ledger rows — you can **materialize** it: run once, store the result like a table.

```sql
CREATE MATERIALIZED VIEW tag_usage AS
SELECT t.tag, count(*) AS projects
FROM projects p, jsonb_array_elements_text(p.doc -> 'tags') AS t(tag)
GROUP BY t.tag;

CREATE UNIQUE INDEX ON tag_usage (tag);      -- you can index it like a table

REFRESH MATERIALIZED VIEW tag_usage;                 -- recompute; blocks readers while it runs
REFRESH MATERIALIZED VIEW CONCURRENTLY tag_usage;    -- no read blocking; needs a UNIQUE index
```

The catch: the data is **stale** until you refresh. Nothing refreshes it automatically — you
schedule it (a cron job, a background worker, `pg_cron`) or trigger it after relevant writes.

| | View | Materialized view | Summary table maintained by your code / triggers |
|---|---|---|---|
| Freshness | always current | as of last refresh | current (if maintained correctly) |
| Read cost | full query each time | a table scan / index lookup | a table read |
| Write cost | none | refresh cost (whole query) | per write |
| Good for | abstraction, security | dashboards, nightly reports | counters that must be live |

:::sql id=db-14-sql2 db=studio xp=40
title: The stale dashboard
The admin dashboard reads `project_clip_counts`, a materialized view created yesterday. Since
then, two clips were added to projects 2 and 4, but the dashboard still shows the old numbers.
Fix the materialized view so it's current, then return `project_id` and `clips` from it,
ordered by `project_id`.

hint: Materialized views don't update themselves.
hint: `REFRESH MATERIALIZED VIEW project_clip_counts;`

```sql setup
CREATE MATERIALIZED VIEW project_clip_counts AS
SELECT p.id AS project_id, count(c.id) AS clips
FROM projects p LEFT JOIN clips c ON c.project_id = p.id
GROUP BY p.id;
INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label, duration_ms) VALUES
  (20, 2, NULL, 'Welcome aboard', NULL, 5000),
  (21, 4, 12, 'Goodbye world', 'Leave', 3000);
```

```sql starter
SELECT project_id, clips FROM project_clip_counts ORDER BY project_id;
```

```sql solution
REFRESH MATERIALIZED VIEW project_clip_counts;
SELECT project_id, clips FROM project_clip_counts ORDER BY project_id;
```

```sql check
SELECT project_id, clips FROM project_clip_counts ORDER BY project_id;
```
:::

:::quiz id=db-14-q1 xp=10
You need `REFRESH MATERIALIZED VIEW CONCURRENTLY sales_summary`. What must exist first?
- [ ] A trigger on the base tables
- [x] A `UNIQUE` index on the materialized view
- [ ] `security_invoker = true`
- [ ] Nothing — `CONCURRENTLY` always works
> A concurrent refresh computes the new result and diffs it against the old one row by row, so it
> needs a unique index (on plain columns, covering all rows — no `WHERE`) to match old and new rows.
> In exchange, readers aren't blocked while it runs. A trigger is the tempting wrong answer: no
> trigger is involved — materialized views are only ever refreshed when you ask.
:::

## SQL functions

A function gives a name and parameters to a piece of logic so queries can call it. The simplest
kind is written in **plain SQL**:

```sql
CREATE OR REPLACE FUNCTION clip_count(p_project_id int)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT count(*) FROM clips WHERE project_id = p_project_id;
$$;

SELECT id, title, clip_count(id) FROM projects;
```

Anatomy:

- **`$$ … $$`** is dollar quoting — a string literal that doesn't need escaped quotes inside.
- **`RETURNS`** a scalar, a row type, `SETOF something` or `TABLE (col type, …)` for many rows.
- **Volatility** tells the planner what the function may do:

| Category | Promise | Example |
|---|---|---|
| `IMMUTABLE` | same inputs → same output, forever; no table reads | `lower(text)`, a price formatter |
| `STABLE` | same output within one statement; may read tables | lookups like `clip_count` |
| `VOLATILE` (default) | anything goes, may modify data | `random()`, functions that INSERT |

Only `IMMUTABLE` functions are allowed in index expressions and generated columns. Lying (marking
a table-reading function `IMMUTABLE`) gives wrong results from caching and indexes — don't.

Some `LANGUAGE sql` functions are **inlined** — the planner pastes the body into your query as if
you'd written it there, so there's no per-call overhead. That happens for a scalar function whose
body is a single expression with no `FROM` (e.g. `SELECT $1 * 2`), and for a `STABLE`/`IMMUTABLE`
set-returning function (`RETURNS TABLE …`) whose body is one `SELECT`. `clip_count` above is
**not** inlined (its body has a `FROM`): `SELECT id, clip_count(id) FROM projects` runs the count
once per project row. That's fine for a handful of rows, but over 100k rows it is an N+1 inside the
database — a `LEFT JOIN … GROUP BY` would do it in one pass. Check with `EXPLAIN VERBOSE`: an inlined
function disappears from the plan's `Output:` line.

:::quiz id=db-14-q4 xp=15
`clip_count(int)` is declared `STABLE` and reads the `clips` table. What happens on
`CREATE INDEX ON projects (clip_count(id));`?

- [ ] The index is built and refreshed whenever `clips` changes
- [x] It fails: functions in index expressions must be marked `IMMUTABLE`
- [ ] It works, but only for queries in the same statement
- [ ] It works once you re-declare `clip_count` as `IMMUTABLE`, and stays correct
> An index stores the function's result at write time of the **`projects`** row. A function that
> reads another table can change its answer without the `projects` row changing, so the index would
> go stale — that's why Postgres demands `IMMUTABLE`. Re-declaring it `IMMUTABLE` makes the
> `CREATE INDEX` succeed, which is exactly the trap: the index then returns wrong counts after new
> clips are added. For "count per project" use a view, a maintained column, or a materialized view.
:::

:::sql id=db-14-sql3 db=studio ordered=true xp=50
title: A balance function
Write `user_balance(p_user_id int)` returning the user's credit balance (sum of `delta` in
`credit_ledger`) as a `bigint`. A user with no ledger rows (or an unknown id) has balance `0`, not `NULL`.

We check `SELECT id, user_balance(id) FROM users ORDER BY id` plus `user_balance(999)`.

hint: `RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT … $$`
hint: `coalesce(sum(delta), 0)`

```sql starter
CREATE FUNCTION user_balance(p_user_id int) RETURNS bigint LANGUAGE sql AS $$
  SELECT sum(delta) FROM credit_ledger WHERE user_id = p_user_id;
$$;
```

```sql solution
CREATE FUNCTION user_balance(p_user_id int) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(delta), 0) FROM credit_ledger WHERE user_id = p_user_id;
$$;
```

```sql check
SELECT id, user_balance(id) FROM users
UNION ALL
SELECT 999, user_balance(999)
ORDER BY 1;
```
:::

## PL/pgSQL: procedural code in the database

When you need variables, `IF`, loops or errors, use **PL/pgSQL**, Postgres's procedural language:

```sql
CREATE OR REPLACE FUNCTION publish_project(p_project_id int)
RETURNS integer           -- the new version
LANGUAGE plpgsql
AS $$
DECLARE
  v_clips int;
  v_version int;
BEGIN
  SELECT count(*) INTO v_clips FROM clips WHERE project_id = p_project_id;
  IF v_clips = 0 THEN
    RAISE EXCEPTION 'project % has no clips', p_project_id
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE projects
     SET published = true, version = version + 1
   WHERE id = p_project_id
  RETURNING version INTO v_version;

  RETURN v_version;
END;
$$;
```

Key pieces:

- `DECLARE` variables; `SELECT … INTO var` and `… RETURNING … INTO var` fill them.
- `IF / ELSIF / ELSE`, `FOR row IN SELECT … LOOP`, `FOREACH x IN ARRAY …`.
- **`RAISE EXCEPTION`** aborts the statement *and* everything the function did — the function runs
  inside the caller's transaction, so it's all-or-nothing for free. `RAISE NOTICE` just logs.
- `EXCEPTION WHEN unique_violation THEN …` catches errors (it uses a savepoint internally — useful,
  but not free; don't wrap every statement).
- **Functions vs procedures:** a `FUNCTION` is called inside a query (`SELECT f()`) and can't commit.
  A `PROCEDURE` is called with `CALL p()` and may `COMMIT` between steps — handy for batch jobs that
  process a big table in chunks. (That only works when the `CALL` is not itself inside an explicit
  `BEGIN … COMMIT` block.)

:::warn title="SECURITY DEFINER needs a pinned search_path"
`SECURITY DEFINER` makes a function run with its **owner's** privileges — useful to let a restricted
role do one specific privileged thing. But it then resolves unqualified names like `clips` through
the *caller's* `search_path`, so a caller who can create objects could plant their own `clips` table
or function and hijack it. Always add `SET search_path = pg_catalog, pg_temp` (or a trusted schema,
e.g. `app, pg_temp`) and schema-qualify your own objects (`public.clips`). Put `pg_temp` **last**
explicitly: if it isn't listed, Postgres searches the caller's temporary schema *first* for tables
and views, so any caller could `CREATE TEMP TABLE clips (…)` and the function would use it. Never
include a schema that untrusted roles can create objects in (before PG 15, everyone could create in
`public` by default). And grant `EXECUTE` only to the roles that need it.
:::

:::warn title="Concurrency still applies inside functions"
"Read the balance, check it, insert a debit" has a race: two concurrent calls can both read 20
credits and both spend 15. A function doesn't make code atomic against *other transactions*. Lock
something first — e.g. `SELECT … FROM users WHERE id = p_user_id FOR UPDATE` — so concurrent spends
for the same user queue up (see the transactions & locking lesson).
:::

:::sql id=db-14-sql4 db=studio xp=70
title: Spend credits safely
Write a PL/pgSQL function `spend_credits(p_user_id int, p_amount int, p_reason text)` that
**returns the new balance** (integer). It must:

1. lock the user's row (`FOR UPDATE`) so concurrent spends queue up,
2. compute the current balance from `credit_ledger`,
3. `RAISE EXCEPTION` if the balance is lower than `p_amount`,
4. otherwise insert a ledger row with `delta = -p_amount` and the given reason
   (new `id` = current max id + 1; `created_at` = `'2025-08-01 12:00+00'`),
5. return the new balance.

We test it on Ivy (user 3, balance 20): spending 15 must return `5`, then spending 10 must raise an
error (any error message works) and leave the ledger unchanged.

(`max(id) + 1` is only there because this table has no identity column. In real code use
`GENERATED ALWAYS AS IDENTITY` — two concurrent spends for *different* users could compute the
same `max(id) + 1`, and the user lock wouldn't prevent that.)

hint: `PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;`
hint: `SELECT coalesce(sum(delta), 0) INTO v_balance FROM credit_ledger WHERE user_id = p_user_id;`
hint: `IF v_balance < p_amount THEN RAISE EXCEPTION 'insufficient credits'; END IF;`

```sql starter
CREATE FUNCTION spend_credits(p_user_id int, p_amount int, p_reason text)
RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
  SELECT max(id) + 1, p_user_id, -p_amount, p_reason, '2025-08-01 12:00+00' FROM credit_ledger;
  RETURN 0;
END;
$$;
```

```sql solution
CREATE FUNCTION spend_credits(p_user_id int, p_amount int, p_reason text)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_balance integer;
BEGIN
  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;

  SELECT coalesce(sum(delta), 0) INTO v_balance
  FROM credit_ledger WHERE user_id = p_user_id;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'insufficient credits: balance %, needed %', v_balance, p_amount;
  END IF;

  INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
  SELECT max(id) + 1, p_user_id, -p_amount, p_reason, '2025-08-01 12:00+00' FROM credit_ledger;

  RETURN v_balance - p_amount;
END;
$$;
```

```sql check
CREATE FUNCTION try_spend(u int, a int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN 'ok, balance ' || spend_credits(u, a, 'export');
EXCEPTION WHEN OTHERS THEN
  RETURN 'rejected';
END $$;
CREATE TEMP TABLE results AS SELECT 1 AS step, try_spend(3, 15) AS outcome;
INSERT INTO results SELECT 2, try_spend(3, 10);
SELECT step, outcome,
       (SELECT sum(delta) FROM credit_ledger WHERE user_id = 3) AS balance,
       (SELECT count(*) FROM credit_ledger WHERE user_id = 3) AS ledger_rows
FROM results ORDER BY step;
```
:::

## Triggers

A **trigger** runs a function automatically when rows change. Two parts: a trigger function
(`RETURNS trigger`) and the `CREATE TRIGGER` that attaches it to a table.

```sql
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER projects_updated_at
BEFORE UPDATE ON projects
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
```

Inside a row trigger you get special variables:

| Variable | Meaning |
|---|---|
| `NEW` | the row being written (INSERT/UPDATE) — a `BEFORE` trigger may modify it |
| `OLD` | the row before the change (UPDATE/DELETE) |
| `TG_OP` | `'INSERT'`, `'UPDATE'`, `'DELETE'` or `'TRUNCATE'` |
| `TG_TABLE_NAME` | the table that fired |

Timing and level:

| | `BEFORE` | `AFTER` |
|---|---|---|
| Can change the row | **yes** (modify `NEW`, return it) | no — the row is already written |
| Can cancel the row | yes (`RETURN NULL` skips it) | only by raising an error |
| Typical use | defaults, normalisation, `updated_at`, `version` | audit logs, notifications, syncing other tables |

`FOR EACH ROW` fires once per row; `FOR EACH STATEMENT` once per statement (with *transition
tables* `REFERENCING NEW TABLE AS new_rows` you can still see all affected rows — great for bulk
audit). The return value of an `AFTER … FOR EACH ROW` trigger is ignored, so `RETURN NULL` is fine
there — but in a `BEFORE` row trigger, `RETURN NULL` means "skip this row", so forgetting
`RETURN NEW` silently drops writes. Add `WHEN (OLD.* IS DISTINCT FROM NEW.*)` to skip no-op updates.

Two more details that surprise people:

- Several triggers with the same timing and event on one table fire in **alphabetical order of
  their names** — teams prefix names (`t10_set_updated_at`, `t20_audit`) when order matters
  (identifiers can't start with a digit unless quoted).
- `now()` is the **start time of the transaction**, not of the statement: every row updated in one
  transaction gets the same `updated_at`. Use `clock_timestamp()` if you really need wall-clock time.

:::quiz id=db-14-q5 xp=15
Spot the bug. After this migration, the app's `INSERT INTO clips …` calls report success but no new
clips ever show up. Why?

```sql
CREATE FUNCTION normalise_clip() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.title := trim(NEW.title);
  RETURN NULL;
END $$;

CREATE TRIGGER clips_normalise BEFORE INSERT ON clips
FOR EACH ROW EXECUTE FUNCTION normalise_clip();
```

- [ ] `trim()` is not allowed in a trigger function
- [x] A `BEFORE` row trigger that returns `NULL` cancels the row, so every insert is skipped (`INSERT 0 0`)
- [ ] The trigger should be `AFTER INSERT` to modify `NEW`
- [ ] `NEW` is read-only, so the assignment raises an error that the app ignores
> In a `BEFORE` row trigger the returned row is what gets written; `NULL` means "don't write this
> row", and it does so without any error — the statement just reports 0 rows. The fix is
> `RETURN NEW;`. Moving the logic to `AFTER` would not work either: by then the row is stored and
> changes to `NEW` are ignored. (`RETURN NULL` is only harmless in `AFTER` triggers.)
:::

:::quiz id=db-14-q2 xp=15
You want every `UPDATE` on `projects` to set `updated_at` automatically. Which trigger works?
- [x] `BEFORE UPDATE … FOR EACH ROW` that sets `NEW.updated_at := now()` and `RETURN NEW`
- [ ] `AFTER UPDATE … FOR EACH ROW` that sets `NEW.updated_at := now()` and `RETURN NEW`
- [ ] `BEFORE UPDATE … FOR EACH STATEMENT` that sets `NEW.updated_at := now()`
- [ ] `AFTER UPDATE … FOR EACH ROW` that runs `UPDATE projects SET updated_at = now()`
> Only a BEFORE row trigger can change the row on its way in. In an AFTER trigger the row is already
> stored, and statement triggers have no `NEW`. Running another UPDATE from an AFTER UPDATE trigger
> on the same table fires the trigger again — infinite recursion.
:::

:::sql id=db-14-sql5 db=studio xp=60
title: updated_at and version, automatically
Developers keep forgetting to bump `version` and `updated_at` when they update projects. Make the
database do it: create a trigger function and a `BEFORE UPDATE` row trigger on `projects` that sets
`updated_at` to `now()` and `version` to the **old** version + 1 — regardless of what the
`UPDATE` statement itself set.

We run two updates on project 2 (version 3) and one on project 6 (version 9) and then check every
project's `id`, `version` and whether `updated_at` is recent.

hint: `NEW.version := OLD.version + 1;`
hint: `CREATE TRIGGER … BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION …;`

```sql starter
CREATE FUNCTION bump_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
```

```sql solution
CREATE FUNCTION bump_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$;

CREATE TRIGGER projects_bump
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION bump_project();
```

```sql check
UPDATE projects SET title = 'Onboarding Tour v2' WHERE id = 2;
UPDATE projects SET published = true, version = 1 WHERE id = 2;
UPDATE projects SET doc = doc || '{"fps": 25}' WHERE id = 6;
SELECT id, version, updated_at > '2025-12-31' AS touched FROM projects ORDER BY id;
```
:::

### The audit log trigger

Regulated customers (and your future self debugging a production incident) want to know *who
changed what, when*. A generic audit trigger stores the before/after image of every row as jsonb:

```sql
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name  text  NOT NULL,
  action      text  NOT NULL,
  old_data    jsonb,
  new_data    jsonb,
  changed_by  text  DEFAULT nullif(current_setting('app.user_id', true), ''),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
```

How does the database know *which app user* made the change? All requests connect as the same
database role (`app`), so `current_user` is useless here. Instead the app stores the user id in a
custom setting at the start of each transaction:

```sql
BEGIN;
SELECT set_config('app.user_id', $1, true);   -- true = local: reset automatically at COMMIT/ROLLBACK
UPDATE project_members SET role = 'editor' WHERE project_id = 2 AND user_id = 5;
COMMIT;
```

- `set_config(…, true)` is the parameterised form of `SET LOCAL app.user_id = '42'` (`SET` can't
  take a bind parameter, so building it as a string invites SQL injection).
- **Local** matters with connection pooling: a session-level `SET` would leak the user id into the
  next request that reuses the same connection.
- `current_setting('app.user_id', true)` returns `NULL` instead of an error when the setting was
  never set (`true` = "missing is OK"); after an earlier local setting ended it can return `''`,
  hence the `nullif`. If you would rather **refuse** unattributed writes, make the column
  `NOT NULL` — then a forgotten `set_config` fails loudly instead of logging `NULL`.

`to_jsonb(OLD)` turns a whole row into a document — the audit table keeps working when columns are
added later.

:::sql id=db-14-sql6 db=studio xp=70
title: Audit project membership
Sharing a project (`project_members`) is security-relevant. Write an `AFTER INSERT OR UPDATE OR
DELETE` row trigger on `project_members` that writes one row into the provided `audit_log` table
per change: `table_name` = the table's name, `action` = `TG_OP`, `old_data` = the old row as jsonb
(NULL for inserts), `new_data` = the new row as jsonb (NULL for deletes).

We then add Lena to project 2 as viewer, promote her to editor, remove her, and check
`action, old_data, new_data` in order.

hint: `to_jsonb(OLD)` / `to_jsonb(NEW)` — but `OLD` is NULL on INSERT and `NEW` is NULL on DELETE, which is exactly what you want.
hint: `CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END` is the explicit version.
hint: `CREATE TRIGGER … AFTER INSERT OR UPDATE OR DELETE ON project_members FOR EACH ROW EXECUTE FUNCTION …;`

```sql setup
CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name text NOT NULL,
  action     text NOT NULL,
  old_data   jsonb,
  new_data   jsonb
);
```

```sql starter
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (table_name, action, new_data) VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER project_members_audit AFTER INSERT ON project_members
FOR EACH ROW EXECUTE FUNCTION audit_row();
```

```sql solution
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit_log (table_name, action, old_data, new_data)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END
  );
  RETURN NULL;  -- ignored for AFTER triggers
END $$;

CREATE TRIGGER project_members_audit
AFTER INSERT OR UPDATE OR DELETE ON project_members
FOR EACH ROW EXECUTE FUNCTION audit_row();
```

```sql check
INSERT INTO project_members (project_id, user_id, role) VALUES (2, 5, 'viewer');
UPDATE project_members SET role = 'editor' WHERE project_id = 2 AND user_id = 5;
DELETE FROM project_members WHERE project_id = 2 AND user_id = 5;
SELECT table_name, action, old_data, new_data FROM audit_log ORDER BY id;
```
:::

:::warn title="Trigger pitfalls"
- **Invisible logic.** A new developer runs `UPDATE` and is surprised by side effects. Name
  triggers clearly, keep them small, and document them in the migration.
- **Performance.** A row trigger runs per row: a bulk `UPDATE` of a million rows runs it a million
  times. Statement-level triggers with transition tables scale better.
- **Cascades.** Triggers that update other tables that have triggers … become hard to reason about.
- **Bulk loads.** `COPY` fires triggers too; for data migrations teams sometimes temporarily
  `ALTER TABLE … DISABLE TRIGGER` (carefully, inside the migration).
:::

## Generated columns

Many triggers exist only to compute one column from others. Since PostgreSQL 12, a **generated
column** does that declaratively:

```sql
ALTER TABLE clips
  ADD COLUMN duration_s numeric GENERATED ALWAYS AS (duration_ms / 1000.0) STORED;
```

- **`STORED`** — computed on write and saved on disk; can be indexed.
- **`VIRTUAL`** — new in **PostgreSQL 18** and the default when you write neither: computed on read,
  takes no space, but can't be indexed (yet) and may only use built-in functions and types. So if
  you want an index — or are on PG 17 or older — write `STORED` explicitly.
- The expression may only use **immutable** functions and columns of the same row — no
  subqueries, no other tables, no `now()`.
- You can't write to it: `INSERT … (duration_s) VALUES (…)` fails. That's the point — it can never
  disagree with its source.

Typical uses: a `tsvector` for search (the jsonb, Arrays & Full-Text Search lesson), a normalised `lower(email)`, a `total_cents =
quantity * unit_price_cents`, or **promoting a jsonb key** to a real, indexable column:
`aspect text GENERATED ALWAYS AS (doc ->> 'aspect') STORED`.

:::sql id=db-14-sql7 db=studio xp=50
title: Promote a jsonb key
The gallery filters projects by frame rate constantly, and `(doc ->> 'fps')::int` is everywhere.
Add a **stored generated** column `fps integer` to `projects`, computed from the document, so it
can never drift from `doc`.

We check that `fps` is a generated column and read back `id, fps` — also after changing project
3's document to 50 fps.

hint: `ALTER TABLE projects ADD COLUMN fps integer GENERATED ALWAYS AS (…) STORED;`
hint: The expression: `((doc ->> 'fps')::int)`

```sql starter
ALTER TABLE projects ADD COLUMN fps integer;
UPDATE projects SET fps = (doc ->> 'fps')::int;
```

```sql solution
ALTER TABLE projects
  ADD COLUMN fps integer GENERATED ALWAYS AS ((doc ->> 'fps')::int) STORED;
```

```sql check
UPDATE projects SET doc = jsonb_set(doc, '{fps}', '50') WHERE id = 3;
SELECT p.id, p.fps,
       (SELECT is_generated FROM information_schema.columns
         WHERE table_name = 'projects' AND column_name = 'fps') AS generated
FROM projects p ORDER BY p.id;
```
:::

## Logic in the database or in the app?

There's no universal answer, but there is a useful rule: **the database guards invariants; the app
implements workflows.**

| Put it in the database | Keep it in the app |
|---|---|
| Rules that must hold no matter who writes: `NOT NULL`, `CHECK`, FKs, `UNIQUE` | Business workflows that change often (pricing rules, onboarding steps) |
| Audit trails that must not be bypassable | Calls to other systems (email, Stripe, S3) — never from a trigger |
| Derived data that must be consistent: generated columns, `updated_at`, `version` | Anything needing unit tests, feature flags, logging, tracing |
| Set-based operations close to the data (one SQL instead of 1,000 round trips) | Complex validation with user-facing error messages |
| Multi-tenant isolation (row-level security, in Production PostgreSQL) | Logic you may want to move to another datastore |

Arguments for the database: one source of truth for every client (API, admin scripts, the data
team's notebooks), fewer round trips, atomic with the data. Arguments against: harder to test,
debug and deploy (functions live in migrations), PL/pgSQL is not a language most teams know well,
and hidden triggers surprise people.

:::job title="What teams actually do"
Most .NET/Node teams keep business logic in the application (services + EF Core / an ORM) and use
the database for **constraints, `updated_at`/`version` triggers, audit triggers, views for
reporting and the occasional performance-critical function**. Functions and triggers are created
and changed through **migrations** like any other schema object — never by hand on production.
Expect code review comments like "can this be a CHECK constraint instead of app validation?"
:::

:::pro title="Test database code like code"
Seniors put database logic under tests: integration tests (Testcontainers + a real Postgres) that
call the function or perform the UPDATE and assert on the trigger's effect — exactly what the
`check` blocks in this lesson do. pgTAP exists for pure-SQL unit tests. Untested triggers are where
production surprises live.
:::

:::quiz id=db-14-q3 xp=15
Which are good candidates for a trigger? (Select all that apply.)
- [x] Writing an audit row for every change to `project_members`
- [x] Setting `updated_at` and incrementing `version` on every update
- [ ] Sending a "you were added to a project" email via an HTTP call
- [ ] Applying this month's promotional discount rules to new orders
> Triggers suit small, stable, data-centric rules that must never be bypassed. External calls
> don't belong inside a transaction (they can't roll back, and they slow every write) — write an
> outbox row or a job instead. Promotion rules change often and belong in tested app code.
:::

:::cards id=db-14-cards1 xp=20 title="Views, functions & triggers"
Q: Does a view store data?
A: No. It's a named SELECT, expanded into your query each time it's used.
Q: Materialized view trade-off?
A: Fast reads of a stored result, but stale until `REFRESH MATERIALIZED VIEW`.
Q: What does `REFRESH … CONCURRENTLY` need and give you?
A: A UNIQUE index on the MV; readers aren't blocked during the refresh.
Q: IMMUTABLE vs STABLE vs VOLATILE?
A: IMMUTABLE: same output forever, no table reads (indexable). STABLE: constant within a statement, may read. VOLATILE: anything, may write.
Q: Function vs procedure?
A: Functions are called in queries and can't COMMIT. Procedures are `CALL`ed and may COMMIT between steps.
Q: What happens to a function's changes when it raises an exception?
A: They roll back with the statement — it runs inside the caller's transaction.
Q: BEFORE vs AFTER row trigger?
A: BEFORE can modify NEW or skip the row; AFTER sees the final row — use it for audit/side tables.
Q: OLD and NEW on INSERT / DELETE?
A: INSERT has only NEW; DELETE has only OLD.
Q: STORED vs VIRTUAL generated column (PG 18)?
A: STORED is computed on write and indexable. VIRTUAL (the PG 18 default) is computed on read and takes no space.
Q: Why not call an HTTP API from a trigger?
A: It can't be rolled back, it slows every write, and failures break the transaction. Write an outbox/job row instead.
Q: Rule of thumb: DB or app?
A: The database guards invariants (constraints, audit, version); the app implements workflows.
:::

## Recap

- **Views** name a query: one definition, a stable interface, a security boundary.
- **Materialized views** cache expensive results; you decide when to `REFRESH` (CONCURRENTLY with a unique index).
- **SQL functions** are simple and often inlined; **PL/pgSQL** adds variables, `IF`, loops and
  `RAISE EXCEPTION` — all inside the caller's transaction, but still subject to concurrency races.
- Mark volatility honestly; only `IMMUTABLE` functions go into indexes and generated columns.
- **BEFORE row triggers** adjust the row (`updated_at`, `version`); **AFTER triggers** write side
  tables (audit logs with `to_jsonb(OLD/NEW)`).
- **Generated columns** replace many triggers; PG 18 adds `VIRTUAL` as the default.
- Database for invariants, app for workflows — and everything goes through migrations and tests.
