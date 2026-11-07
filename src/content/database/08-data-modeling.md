---
id: db-08
title: Data Modeling
level: intermediate
minutes: 85
xp: 180
summary: Design schemas that stay correct as the product grows — keys (identity vs uuidv7), normalization in plain words, junction tables, trees, CHECK vs enum vs lookup tables, naming, soft delete and audit columns, using a branching-video SaaS.
---

Writing SQL is half the job. The other half — the half that decides whether a codebase is a joy
or a swamp two years later — is **deciding which tables exist**. A good model makes the right
queries easy and the wrong data impossible. A bad one forces every feature to work around it.

In this lesson we'll learn the rules of thumb (normalization), the common shapes (junction
tables, trees), the conventions teams expect, and the trade-offs (denormalization, soft delete,
audit columns). Our running example is the **studio** dataset: a SaaS where users build
interactive, branching videos — like a "choose your own adventure" film.

## What we're modeling

You toured the studio's tables in the **Thinking in Tables** lesson and have queried them since. Now let's look at the
*product* behind them, because that's where a model starts. In plain words:

- **Users** sign up on a plan (`free`, `pro`, `team`).
- A user **owns** projects. Other users can be invited to a project as **editor** or **viewer**.
- A project is a **tree of clips**: an intro clip, then choices ("Go in the front" / "Climb the
  roof"), each leading to another clip with its own choices, until an ending.
- Exporting a project creates **render jobs** processed by workers.
- AI features cost **credits**, tracked in a ledger.

Turning sentences into tables is a skill: **nouns** usually become tables (user, project, clip,
render job), **"has many"** becomes a foreign key on the "many" side, **"many-to-many"** becomes
a junction table, and **adjectives with a fixed set of values** become a constrained column
(`plan`, `role`, `status`). The rarer **one-to-one** ("a user has at most one billing profile")
is a foreign key with a `UNIQUE` constraint, so each parent can be referenced only once.

Read the diagram below as "one user owns N (many) projects". The text in brackets is where the
relationship is stored: for 1:N it's a foreign-key column on the **"many" side** (a row can hold
one parent id, but not a list of child ids); for N:M it's a junction table.

```text
users 1 ─── N projects            (owner_id)
users N ─── M projects            (project_members: role)
projects 1 ─── N clips            (project_id)
clips 1 ─── N clips               (parent_clip_id — the tree)
projects 1 ─── N render_jobs
users 1 ─── N credit_ledger
```

## Keys: what identifies a row?

Every table needs a **primary key**: a column (or combination) that uniquely identifies each row
and never changes. There are two kinds of candidates:

- A **natural key** is a real-world fact that happens to be unique: an email address, an ISBN, a
  country code.
- A **surrogate key** is a meaningless value invented by the database: an identity number or a
  UUID.

Most teams use **surrogate keys** for entities, for a simple reason: real-world facts change. Users
change their email; if `email` were the primary key, every foreign key pointing at it would have
to change too. A surrogate `id` never changes, is small and fast to join on, and carries no
personal data into URLs and logs. The natural key still matters — protect it with a `UNIQUE`
constraint (`email text NOT NULL UNIQUE`), so you get both a stable id *and* no duplicates.

Natural keys are fine when the value truly never changes and is controlled by you: ISO country
codes (`'DE'`), currency codes, or the composite key of a junction table
(`PRIMARY KEY (project_id, user_id)`).

:::warn title="Common mistake: surrogate key, no natural constraint"
`id bigint PRIMARY KEY` alone doesn't stop the same customer being imported three times with ids
7, 8 and 9. A surrogate key identifies rows; it does **not** prevent duplicates. Always ask "what
makes this thing unique in the real world?" and add that `UNIQUE` constraint too.
:::

## Normalization in plain words

Normalization is a set of rules for avoiding **duplicated facts**. Every fact should be stored
**once**, in the one place it belongs. Duplicates drift apart: update the customer's email in
one row and forget the other three, and now the database disagrees with itself (an **update
anomaly**).

Here's a spreadsheet-style table that a new startup might start with:

| order_id | customer_email | customer_name | products | product_prices |
|---|---|---|---|---|
| 1 | ada@example.com | Ada Lovelace | Keyboard, Mouse | 89.90, 29.99 |
| 2 | ada@example.com | Ada L. | Desk Mat | 14.50 |

Every problem in it maps to a normal form:

**1NF — one value per cell, no repeating groups.** `products` holds a list. You can't index it,
join on it, or put a foreign key on it, and "how many keyboards did we sell?" becomes string
parsing. Fix: one row per order line (`order_items`).

**2NF — every column depends on the *whole* key.** In an `order_items(order_id, product_id,
product_name, quantity)` table with key `(order_id, product_id)`, `product_name` depends only on
`product_id` — half the key. It's repeated on every line that sells that product. Fix: move it to
`products`.

**3NF — no column depends on another non-key column.** `customer_name` depends on
`customer_email`, not on the order. That's why Ada is "Ada Lovelace" in one row and "Ada L." in
the next. Fix: a `customers` table, and orders store only `customer_id`.

The one-line summary (attributed to Bill Kent): every non-key column must depend on
*the key, the whole key, and nothing but the key*.

:::quiz id=db-08-q1 xp=15
A `clips` table has columns `id, project_id, project_title, title, duration_ms`. What's wrong?
- [ ] Nothing — it saves a join
- [x] `project_title` is a fact about the project, duplicated on every clip (3NF violation)
- [ ] `duration_ms` should be in a separate table
- [ ] `project_id` should be removed
> `project_title` depends on `project_id`, not on the clip. Rename the project and you must update
> every clip — miss one and the data contradicts itself. Store it once in `projects`. "It saves a
> join" is the tempting answer, but joins on an indexed key are cheap; inconsistent data is
> expensive. `project_id` is exactly the column that *should* be there (it's the foreign key), and
> `duration_ms` is a genuine fact about the clip.
:::

:::sql id=db-08-sql1 db=empty xp=45
title: Normalize the spreadsheet
A legacy import left us `orders_flat(order_id, customer_email, customer_name, product, qty)` —
customer data is repeated on every row. Create a proper `customers` table and fill it:
- `id` — `bigint`, identity primary key
- `email` — `text`, required, **unique**
- `name` — `text`, required

Then insert **one row per distinct customer** from `orders_flat` (email + name).

hint: `CREATE TABLE customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL);`
hint: `INSERT INTO customers (email, name) SELECT DISTINCT customer_email, customer_name FROM orders_flat;`

```sql setup
CREATE TABLE orders_flat (order_id integer, customer_email text, customer_name text, product text, qty integer);
INSERT INTO orders_flat VALUES
  (1, 'ada@example.com',   'Ada Lovelace',   'Keyboard', 1),
  (1, 'ada@example.com',   'Ada Lovelace',   'Mouse',    1),
  (2, 'linus@example.com', 'Linus Torvalds', 'Monitor',  1),
  (3, 'ada@example.com',   'Ada Lovelace',   'Desk Mat', 2),
  (4, 'grace@example.com', 'Grace Hopper',   'Keyboard', 1),
  (4, 'grace@example.com', 'Grace Hopper',   'USB Hub',  3);
```

```sql starter
CREATE TABLE customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text, name text);
INSERT INTO customers (email, name) SELECT customer_email, customer_name FROM orders_flat;
```

```sql solution
CREATE TABLE customers (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name  text NOT NULL
);
INSERT INTO customers (email, name)
SELECT DISTINCT customer_email, customer_name FROM orders_flat;
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  (SELECT string_agg(email || '=' || name, ', ' ORDER BY email) FROM customers) AS customers,
  pg_temp.ok($q$INSERT INTO customers (email, name) VALUES ('ada@example.com', 'Copy')$q$) AS duplicate_email,
  pg_temp.ok($q$INSERT INTO customers (email, name) VALUES ('x@example.com', NULL)$q$)     AS null_name;
SELECT * FROM _r;
```
:::

## When to denormalize

Normalization optimizes for **correct writes**. Sometimes reads matter more, and you deliberately
store a fact twice. That's fine — *if it's a decision, not an accident*:

- **Historical snapshots** aren't duplication at all: `order_items.unit_price` is the price *at
  the time of the order*. Today's `products.price` is a different fact. Same for an invoice's
  billing address.
- **Cached aggregates** — a `comment_count` on posts, a `balance` on accounts — save expensive
  queries on hot paths. You must keep them in sync (same transaction, a trigger, or a background
  job) and accept they can drift.
- **Documents** — the studio stores editor settings in `projects.doc` (`jsonb`): aspect ratio,
  fps, tags. Data that is always read and written together, never queried row-by-row, and owned
  by one aggregate is a good fit for `jsonb`. Data you filter, join or constrain belongs in
  columns.

Rule of thumb: start normalized (3NF), measure, and denormalize the specific read path that's
slow — with a comment explaining how it stays in sync.

:::quiz id=db-08-q2 xp=15
Which of these is a **good** reason to store a value in more than one table? (select all that apply)
- [x] `order_items.unit_price` copied from `products.price` when the order is placed
- [x] A `projects.clip_count` column updated in the same transaction as clip inserts/deletes, for a hot dashboard
- [ ] Copying `users.email` into every `project_members` row "to save a join"
- [ ] Storing a project's member ids as a comma-separated text column
> Strictly speaking the first isn't even a denormalization: it's a different fact (the price at
> order time), not a duplicate — the product price may change later, but the order must keep
> what the customer paid. The second is a deliberate cache with a sync strategy
> for a measured hot path. Copying a mutable fact like an email "to save a join" invites drift (the
> user changes their email, the copies don't), and a CSV list breaks 1NF — you can't put a foreign
> key on it or index it; use a junction table.
:::

## Many-to-many: the junction table

"Users can be members of many projects; projects have many members" — and the relationship
itself has data: the **role**. The junction table carries it:

```sql
CREATE TABLE project_members (
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id),
  role       text    NOT NULL CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);
```

The composite primary key prevents inviting the same user twice. Notice the **owner** is *not* a
member row: ownership is a 1:N relationship (`projects.owner_id`), with different rules (one
owner, can't be removed). Some teams instead put the owner in the junction table with
`role = 'owner'` and a partial unique index — both designs work; pick one and document it.

:::sql id=db-08-sql2 db=studio xp=30 ordered=true
title: Who works on The Heist?
Return the `display_name` and `role` of every **member** of the project titled `The Heist`
(not the owner). Order by `display_name`.

hint: `project_members` joins to `users` (for the name) and to `projects` (to filter by title).

```sql starter
SELECT pm.user_id, pm.role FROM project_members pm WHERE pm.project_id = 1 ORDER BY pm.user_id;
```

```sql solution
SELECT u.display_name, pm.role
FROM project_members pm
JOIN users u    ON u.id = pm.user_id
JOIN projects p ON p.id = pm.project_id
WHERE p.title = 'The Heist'
ORDER BY u.display_name;
```
:::

Because owners and members live in different places, "which projects can Jonas open?" combines
two queries — a job for `UNION ALL` from the **JOINs** lesson, which stacks the rows of two queries with the
same number of compatible columns. (`ALL`, because the two halves can never return the same row:
the first labels every row `'owner'`, the second `'editor'` or `'viewer'` — so there is nothing to
deduplicate, and no reason to pay for it.)

```sql
SELECT title, 'owner' AS role FROM projects WHERE owner_id = 2
UNION ALL
SELECT p.title, pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id
WHERE pm.user_id = 2;
```

:::sql id=db-08-sql3 db=studio xp=40 ordered=true
title: Ivy's project list
Return every project **Ivy** (user `3`) can open, as `title` and her `role` — `owner` for her own
projects, otherwise her member role. Order by `title`.

hint: Owned projects: `SELECT title, 'owner' FROM projects WHERE owner_id = 3`.
hint: `UNION ALL` the member projects from `project_members`.

```sql starter
SELECT title, 'owner' FROM projects WHERE owner_id = 3 ORDER BY title;
```

```sql solution
SELECT title, 'owner' AS role FROM projects WHERE owner_id = 3
UNION ALL
SELECT p.title, pm.role
FROM project_members pm JOIN projects p ON p.id = pm.project_id
WHERE pm.user_id = 3
ORDER BY title;
```
:::

## Trees: a table that references itself

A branching video is a **tree**: each clip (except the root) has one parent clip, and the
`choice_label` is the button the viewer clicks to get there.

```text
Intro (1)
├── "Go in the front" → Front door (2)
│   ├── "Bribe"       → Bribe the guard (4)
│   └── "Sneak"       → Sneak past (5)
│       └── "Open the vault" → The vault (7)
└── "Climb the roof"  → Rooftop (3)
    └── "Jump"        → Zipline (6)
```

The simplest model is an **adjacency list**: each row stores the id of its parent,
`parent_clip_id REFERENCES clips(id)` — a foreign key that points at its **own** table. The root
has `parent_clip_id = NULL`. One level up or down is a simple **self-join** (the same table joined
twice under two aliases, `parent` and `child`); the whole tree needs a recursive CTE
(`WITH RECURSIVE`, the **Subqueries, CTEs & Recursive Queries** lesson). Alternatives exist — Postgres's `ltree` paths, closure tables,
nested sets — but the adjacency list is the default for good reason: it's simple, moving a
subtree is a one-row update, and there's no redundant data that could disagree.

What the plain self-FK does **not** guarantee:

- **Same project.** `parent_clip_id = 7` is accepted even if clip 7 belongs to a *different*
  project. Fix it with a **composite foreign key**: make `(project_id, id)` unique and reference
  that pair, so the parent must have the same `project_id` as the child (see the last challenge
  below).
- **No cycles.** Nothing stops clip 2's parent being 5 and clip 5's parent being 2. Preventing
  that needs a trigger or app logic (or a design where clips can only be added below an existing
  clip and parents never change).

If the product later allows two choices to lead to the *same* clip (branches that merge), it's
no longer a tree but a **graph**, and you'd model the edges in their own table:
`clip_choices(from_clip_id, to_clip_id, label)`. Knowing which shape your data really has is the
heart of modeling.

:::sql id=db-08-sql4 db=studio xp=35 ordered=true
title: The choices after the intro
Return the `choice_label` and `title` of every clip whose **parent** is the clip titled `Intro`
(that's what the viewer can pick after the intro). Order by clip `id`.

hint: Self-join: `FROM clips child JOIN clips parent ON parent.id = child.parent_clip_id`.

```sql starter
SELECT choice_label, title FROM clips WHERE parent_clip_id IS NULL ORDER BY id;
```

```sql solution
SELECT child.choice_label, child.title
FROM clips child
JOIN clips parent ON parent.id = child.parent_clip_id
WHERE parent.title = 'Intro'
ORDER BY child.id;
```
:::

:::sql id=db-08-sql5 db=studio xp=45 ordered=true
title: Find the endings
An **ending** is a clip with no children. Return the `id` and `title` of every ending in
project `1`. Order by `id`.

hint: Anti-join on the same table: `LEFT JOIN clips child ON child.parent_clip_id = c.id … WHERE child.id IS NULL`.

```sql starter
SELECT id, title FROM clips WHERE project_id = 1 AND parent_clip_id IS NOT NULL ORDER BY id;
```

```sql solution
SELECT c.id, c.title
FROM clips c
LEFT JOIN clips child ON child.parent_clip_id = c.id
WHERE c.project_id = 1 AND child.id IS NULL
ORDER BY c.id;
```
:::

:::sql id=db-08-sql6 db=empty xp=50
title: Model the clip tree yourself
A `projects(id)` table exists. Create `clips` with:
- `id` — `integer`, primary key
- `project_id` — `integer`, required, FK to `projects(id)`, deleted with the project
- `parent_clip_id` — `integer`, optional, FK to `clips(id)`, deleted with its parent clip
- `title` — `text`, required
- `choice_label` — `text`; a **root clip** (no parent) must have **no** label, and every other
  clip **must** have one

hint: Self-reference: `parent_clip_id integer REFERENCES clips(id) ON DELETE CASCADE`
hint: One CHECK covers both rules: `CHECK ((parent_clip_id IS NULL) = (choice_label IS NULL))`

```sql setup
CREATE TABLE projects (id integer PRIMARY KEY, title text NOT NULL);
INSERT INTO projects VALUES (1, 'The Heist'), (2, 'Coffee');
```

```sql starter
CREATE TABLE clips (
  id integer PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(id),
  parent_clip_id integer,
  title text NOT NULL,
  choice_label text
);
```

```sql solution
CREATE TABLE clips (
  id             integer PRIMARY KEY,
  project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_clip_id integer REFERENCES clips(id) ON DELETE CASCADE,
  title          text    NOT NULL,
  choice_label   text,
  CHECK ((parent_clip_id IS NULL) = (choice_label IS NULL))
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label) VALUES (1, 1, NULL, 'Intro', NULL)$q$)            AS root,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label) VALUES (2, 1, 1, 'Front door', 'Go in')$q$)       AS child,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label) VALUES (3, 1, 2, 'Vault', 'Open')$q$)             AS grandchild,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label) VALUES (4, 1, 1, 'No label', NULL)$q$)            AS child_without_label,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label) VALUES (5, 1, NULL, 'Root with label', 'Hi')$q$)  AS root_with_label,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label) VALUES (6, 1, 99, 'Orphan', 'Lost')$q$)           AS unknown_parent,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title, choice_label) VALUES (7, 2, NULL, 'Welcome', NULL)$q$)          AS other_project,
  pg_temp.ok($q$DELETE FROM clips WHERE id = 2$q$)                                  AS delete_branch,
  pg_temp.ok($q$DELETE FROM projects WHERE id = 2$q$)                               AS delete_project;
SELECT _r.*, (SELECT string_agg(id::text, ',' ORDER BY id) FROM clips) AS remaining FROM _r;
```
:::

:::sql id=db-08-sql9 db=empty xp=55
title: Branches stay inside their project
The clip table from the previous challenge has a hole: a clip of project 2 can name a clip of
project 1 as its parent. Create `clips` again, this time so that **a parent clip must belong to
the same project** as its child:
- `id` — `integer`, primary key
- `project_id` — `integer`, required, FK to `projects(id)`, deleted with the project
- `parent_clip_id` — `integer`, optional (NULL for a root clip)
- `title` — `text`, required
- the pair (`project_id`, `id`) is **unique**, and the pair (`project_id`, `parent_clip_id`) is a
  foreign key to it; when a parent clip is deleted, its children are **deleted too**

hint: A composite FK must point at columns with a unique constraint: add `UNIQUE (project_id, id)`.
hint: `FOREIGN KEY (project_id, parent_clip_id) REFERENCES clips (project_id, id) ON DELETE CASCADE`
hint: Root clips still work: when `parent_clip_id` is NULL, the composite FK isn't checked.

```sql setup
CREATE TABLE projects (id integer PRIMARY KEY, title text NOT NULL);
INSERT INTO projects VALUES (1, 'The Heist'), (2, 'Coffee');
```

```sql starter
CREATE TABLE clips (
  id             integer PRIMARY KEY,
  project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_clip_id integer REFERENCES clips(id) ON DELETE CASCADE,
  title          text    NOT NULL
);
```

```sql solution
CREATE TABLE clips (
  id             integer PRIMARY KEY,
  project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_clip_id integer,
  title          text    NOT NULL,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, parent_clip_id) REFERENCES clips (project_id, id) ON DELETE CASCADE
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title) VALUES (1, 1, NULL, 'Intro')$q$)         AS root_project_1,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title) VALUES (2, 1, 1, 'Front door')$q$)       AS child_same_project,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title) VALUES (3, 2, NULL, 'Welcome')$q$)       AS root_project_2,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title) VALUES (4, 2, 1, 'Wrong tree')$q$)       AS parent_in_other_project,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title) VALUES (5, 2, 3, 'Espresso')$q$)         AS child_project_2,
  pg_temp.ok($q$INSERT INTO clips (id, project_id, parent_clip_id, title) VALUES (6, 1, 99, 'Orphan')$q$)          AS unknown_parent,
  pg_temp.ok($q$DELETE FROM clips WHERE id = 1$q$)                         AS delete_root,
  pg_temp.ok($q$DELETE FROM projects WHERE id = 2$q$)                      AS delete_project;
SELECT _r.*, (SELECT string_agg(id::text, ',' ORDER BY id) FROM clips) AS remaining FROM _r;
```
:::

## Choosing keys and value sets

Two decisions come up in almost every new table, and both are expensive to change once other
tables, APIs and URLs depend on them: **what type is the surrogate key?** and **how is a fixed set
of values enforced?** Let's take them in turn.

### Integer identity or uuidv7?

The studio uses small integers. A new project at a job will usually pick one of these two:

| | `bigint GENERATED ALWAYS AS IDENTITY` | `uuid DEFAULT uuidv7()` |
|---|---|---|
| Size | 8 bytes | 16 bytes — in the PK *and* every FK and index that references it |
| Who can generate it | only the database (one sequence) | anyone: the database, the API, an offline mobile client — before the row exists |
| Insert pattern | always appends to the end of the index | also time-ordered (random v4 UUIDs are not) |
| In a URL | `/projects/42` reveals your volume and invites trying `/projects/43` | not enumerable; v7 does reveal the creation time |
| Merging data from several databases / regions | ids collide | globally unique |
| Humans | easy to read out on a support call | long |

Rules of thumb:

- **Default to `bigint` identity** for internal tables. It's compact, fast, simple to debug.
- **Pick `uuid` when ids are generated outside the database** (clients that work offline, events
  that carry their own id, several services writing) or must be unique across systems. Prefer
  `uuidv7()` over `gen_random_uuid()` for big tables, because ordered inserts keep the index
  compact — unless the creation time itself is sensitive.
- **Public ids are a separate decision.** A popular hybrid: keep a `bigint` primary key for joins
  and add `public_id uuid NOT NULL UNIQUE DEFAULT uuidv7()` for URLs and APIs (or
  `gen_random_uuid()` if outsiders mustn't learn when a row was created). Either way, an
  unguessable id is *not* access control: the API must still check that the caller may see
  project X.

In EF Core, `Guid` maps to `uuid`. Since version 9 the Npgsql provider generates time-ordered v7
values for `Guid` keys by default; in your own code, `Guid.CreateVersion7()` (.NET 9+) does the
same.

:::sql id=db-08-sql11 db=studio xp=40
title: Public ids for projects
The studio's project URLs (`/projects/1`, `/projects/2` …) are enumerable. Add a column
`public_id` to `projects` that is a `uuid`, **required**, **unique**, and filled with a
**time-ordered (version 7)** UUID by default — existing projects must get one too.

hint: `ALTER TABLE projects ADD COLUMN public_id uuid NOT NULL DEFAULT uuidv7() UNIQUE;`
hint: A volatile default like `uuidv7()` is evaluated once per existing row, so every project gets its own value.

```sql starter
ALTER TABLE projects ADD COLUMN public_id uuid;
```

```sql solution
ALTER TABLE projects ADD COLUMN public_id uuid NOT NULL DEFAULT uuidv7() UNIQUE;
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  (SELECT count(*) FROM projects)                                AS projects,
  (SELECT count(DISTINCT public_id) FROM projects)               AS distinct_public_ids,
  (SELECT bool_and(uuid_extract_version(public_id) = 7) FROM projects) AS all_v7,
  pg_temp.ok($q$INSERT INTO projects (id, owner_id, title, created_at, updated_at)
               VALUES (7, 1, 'Defaulted', now(), now())$q$)       AS insert_gets_default,
  pg_temp.ok($q$UPDATE projects SET public_id = (SELECT public_id FROM projects WHERE id = 1) WHERE id = 2$q$) AS duplicate_allowed,
  pg_temp.ok($q$UPDATE projects SET public_id = NULL WHERE id = 3$q$) AS null_allowed;
SELECT _r.*, (SELECT uuid_extract_version(public_id) FROM projects WHERE id = 7) AS new_row_version FROM _r;
```
:::

### Fixed sets of values: CHECK, enum or lookup table?

`plan`, `role` and `status` can only take a few values. Postgres gives you three ways to enforce
that, each with a different cost of change:

| Option | Example | Adding a value | Good for |
|---|---|---|---|
| `CHECK` constraint | `status text CHECK (status IN ('queued','running','done'))` | `ALTER TABLE` to replace the CHECK | Small sets that change with code releases — the most common choice |
| Enum type | `CREATE TYPE job_status AS ENUM ('queued','running','done')` | `ALTER TYPE … ADD VALUE` (renaming works; **removing** a value isn't supported — you recreate the type) | Sets that almost never change |
| Lookup table | `plans(code PRIMARY KEY, name, monthly_price)` + FK | a plain `INSERT` | Values with their own data, or editable by admins |

What each one feels like in practice:

- **CHECK on `text`** (what the studio does for `plan`, `role`, `status`, `kind`) is readable in
  every query and tool. Changing the set is a migration that drops and re-adds the constraint.
- **An enum** is a real type: 4 bytes per value, one definition shared by every table that uses
  it, and it **sorts in declaration order**, so `ORDER BY status` gives queued → running → done
  rather than the alphabet. The costs: values can't be removed or reordered, and a value added
  with `ALTER TYPE … ADD VALUE` can't be *used* until that transaction commits — awkward with
  migration tools that wrap each migration in a transaction.
- **A lookup table** turns the value into a noun with attributes (a plan has a price and credit
  limits), lets admins add values without a deploy, and can retire a value with an `active`
  flag instead of deleting it. The join costs next to nothing.

Rule of thumb: if the value has **attributes of its own** (a plan has a price and limits), it's a
noun — give it a table. If it's a pure label, a CHECK on a `text` column is simple and readable;
reach for an enum when the set is stable and you want the type and the ordering.

:::info title="How EF Core maps each option"
A C# `enum JobStatus { Queued, Running, Done }` meets the database differently in each design:

- **No configuration:** EF Core stores the enum as an **integer** (`0`, `1`, `2`). Nobody can read
  that in SQL, and reordering the C# members silently changes what old rows mean. Avoid it.
- **CHECK on text:** `.HasConversion<string>()` stores the member **name** — `'Queued'`, with a
  capital Q — which a `CHECK (status IN ('queued', …))` rejects. Make the spellings match (a
  custom converter to lower case, or a CHECK on the exact names).
- **Postgres enum:** map it natively with `UseNpgsql(…, o => o.MapEnum<JobStatus>("job_status"))`;
  Npgsql translates member names to snake_case (`Queued` → `queued`) and EF migrations can create
  the type for you.
- **Lookup table:** it's simply another entity (`Plan`) with a navigation property — or keep the
  `string` code as the foreign key and load the plan only when you need its attributes.
:::

:::sql id=db-08-sql10 db=empty xp=45
title: A status enum
Create an enum type `job_status` with the values `queued`, `running`, `done`, `failed` — **in that
order** — and a table `jobs` with:
- `id` — `integer`, primary key
- `status` — `job_status`, required, defaulting to `queued`

hint: `CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed');`
hint: `status job_status NOT NULL DEFAULT 'queued'`

```sql starter
CREATE TABLE jobs (
  id     integer PRIMARY KEY,
  status text NOT NULL DEFAULT 'queued'
);
```

```sql solution
CREATE TYPE job_status AS ENUM ('queued', 'running', 'done', 'failed');
CREATE TABLE jobs (
  id     integer PRIMARY KEY,
  status job_status NOT NULL DEFAULT 'queued'
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO jobs (id) VALUES (1)$q$)                     AS default_status,
  pg_temp.ok($q$INSERT INTO jobs (id, status) VALUES (2, 'done')$q$)     AS done,
  pg_temp.ok($q$INSERT INTO jobs (id, status) VALUES (3, 'paused')$q$)   AS unknown_value,
  pg_temp.ok($q$INSERT INTO jobs (id, status) VALUES (4, NULL)$q$)       AS null_status,
  pg_temp.ok($q$INSERT INTO jobs (id, status) VALUES (5, 'running')$q$)  AS running;
SELECT _r.*,
  (SELECT string_agg(id || ':' || status::text, ',' ORDER BY status, id) FROM jobs) AS sorted_by_status,
  (SELECT format_type(atttypid, NULL) FROM pg_attribute
    WHERE attrelid = 'jobs'::regclass AND attname = 'status')             AS column_type,
  (SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder) FROM pg_enum
    WHERE enumtypid = 'job_status'::regtype)                              AS enum_values
FROM _r;
```
:::

:::quiz id=db-08-q7 xp=15
An EF Core entity has `public JobStatus Status { get; set; }` with
`enum JobStatus { Queued, Running, Done }`, configured with `.HasConversion<string>()`. The column
is `status text NOT NULL CHECK (status IN ('queued', 'running', 'done'))`. What happens when you
save a new job with `Status = JobStatus.Queued`?
- [ ] It works: EF Core lower-cases enum names for Postgres
- [ ] EF Core stores `0`, the enum's integer value
- [x] The INSERT fails with a check-constraint violation, because EF Core writes `'Queued'`
- [ ] EF Core creates a Postgres enum type `job_status` and uses it instead
> `HasConversion<string>()` writes the member name exactly as declared — `'Queued'` — and
> `'Queued'` is not in `('queued', …)`: comparisons on `text` are case-sensitive. Storing `0` is
> what happens *without* a conversion. Lower-casing only happens for a native Postgres enum
> mapped with `MapEnum` (Npgsql's snake_case translator), and EF never switches a `text` column to
> an enum type on its own. Fix it with a converter that matches the CHECK, or change the CHECK.
:::

## Naming conventions

Postgres folds unquoted identifiers to lower case — `CREATE TABLE UserAccounts` creates
`useraccounts`, and `"UserAccounts"` (quoted) must then be quoted forever. So Postgres teams use:

- **snake_case** everything: `project_members`, `created_at`, `parent_clip_id`.
- **Plural table names** (`users`, `projects`) — the most common convention; singular is also
  fine if *consistent*. Pick one per codebase.
- `id` for the primary key, `<singular>_id` for foreign keys: `project_id`, `owner_id` (a
  role-named FK is fine when it adds meaning).
- Booleans read as questions: `published`, `is_active`, `has_paid`.
- Timestamps end in `_at` (`created_at`, `finished_at`), dates in `_on` or `_date`.
- Name junction tables after both sides or after the relationship: `project_members`,
  `order_items`.

EF Core with Npgsql: use `UseSnakeCaseNamingConvention()` (EFCore.NamingConventions) so your
`ProjectMember.CreatedAt` maps to `project_members.created_at` instead of `"ProjectMembers"."CreatedAt"`.

## Audit columns

Almost every table in a real system gets:

```sql
created_at timestamptz NOT NULL DEFAULT now(),
updated_at timestamptz NOT NULL DEFAULT now()
```

`created_at` is free with a default. `updated_at` must be set on every update — by the ORM (EF
Core `SaveChanges` interceptor), or by a trigger so no code path can forget. Here is what that
looks like; treat it as a **preview** for now — PL/pgSQL functions and triggers get a proper
introduction in the Views, Functions & Triggers lesson:

```sql
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

Some systems add `created_by` / `updated_by` (user ids). For a full history ("who changed what,
when?"), use a separate **audit/history table** or an append-only **ledger** — the studio's
`credit_ledger` never updates a balance, it appends `+500` / `-40` rows, so the balance is always
`sum(delta)` and every change is explained.

The studio's `projects.version` column is another audit-ish tool: **optimistic concurrency**.
The problem it solves: Mara and Jonas both open version 14 of "The Heist". Mara saves; then Jonas
saves and silently overwrites Mara's changes (a **lost update**). With a version column, each save
says "update it *only if* it's still the version I loaded":

```sql
UPDATE projects SET doc = $1, version = version + 1
WHERE id = $2 AND version = $3;     -- $3 = the version the client loaded
```

If someone else saved first, the version no longer matches, **zero rows** change, and the app
shows "this project was modified — reload?". It's called *optimistic* because it takes no locks
and just detects the conflict afterwards. EF Core does exactly this when you mark a property as a
concurrency token (`.IsConcurrencyToken()`) and increment it on each save: it adds
`AND version = <loaded value>` to the `UPDATE` and throws `DbUpdateConcurrencyException` when zero
rows change. (With Npgsql you can instead map a `uint` property with `.IsRowVersion()` to
Postgres's built-in `xmin` system column, which changes on every update automatically.) This is
also a preview: the Transactions, Isolation & Locking lesson puts optimistic concurrency next to the other fixes for lost updates and
lets you write it.

## Soft delete

"Delete" in a product often means "hide": users want undo, support wants to restore, legal wants
history. **Soft delete** adds a column and filters on it:

```sql
ALTER TABLE projects ADD COLUMN deleted_at timestamptz;      -- NULL = not deleted
UPDATE projects SET deleted_at = now() WHERE id = 2;         -- "delete"
SELECT * FROM projects WHERE deleted_at IS NULL;             -- every normal query
```

The trade-offs are real:

| Pro | Con |
|---|---|
| Undo / restore is trivial | **Every** query must remember `WHERE deleted_at IS NULL` |
| History is kept | Unique constraints break: a deleted `email` still blocks re-signup |
| FKs from other tables stay valid | Data grows forever; GDPR "right to erasure" still needs a hard delete |

Mitigations: a **view** or an ORM global query filter (EF Core
`HasQueryFilter(p => p.DeletedAt == null)`), and **partial unique indexes** —
`CREATE UNIQUE INDEX ON users (email) WHERE deleted_at IS NULL` — so only live rows must be
unique. A **partial index** only contains the rows matching its `WHERE`, so deleted rows simply
aren't in it and can't collide. (Unlike a `UNIQUE` constraint, it can't be the target of a
foreign key.) Alternatively, move deleted rows into an archive table and keep the main table
clean.

A **view** is a saved `SELECT` with a name. After
`CREATE VIEW published_projects AS SELECT id, title FROM projects WHERE published;` you query
`published_projects` exactly like a table, and the filter can't be forgotten because it lives in
the view. That's all you need for the next challenge; the Views, Functions & Triggers lesson covers views, materialized views and
their trade-offs properly.

:::warn title="Views freeze SELECT *"
`CREATE VIEW active_projects AS SELECT * FROM projects …` expands `*` **when the view is
created**. A column added to `projects` later does not appear in the view until you recreate it
(`CREATE OR REPLACE VIEW …`). Migrations that add columns must update such views too.
:::

:::sql id=db-08-sql7 db=studio xp=45
title: Soft-delete a project
In the **studio** database:
1. add a nullable `deleted_at timestamptz` column to `projects`,
2. soft-delete the project titled `Onboarding Tour` by setting `deleted_at` to
   `2025-08-01 00:00:00+00`,
3. create a view `active_projects` that returns all columns of projects that are **not** deleted.

hint: `ALTER TABLE projects ADD COLUMN deleted_at timestamptz;`
hint: `CREATE VIEW active_projects AS SELECT * FROM projects WHERE deleted_at IS NULL;`

```sql starter
DELETE FROM render_jobs WHERE project_id = 2;
DELETE FROM projects WHERE title = 'Onboarding Tour';
CREATE VIEW active_projects AS SELECT * FROM projects;
```

```sql solution
ALTER TABLE projects ADD COLUMN deleted_at timestamptz;
UPDATE projects SET deleted_at = '2025-08-01 00:00:00+00' WHERE title = 'Onboarding Tour';
CREATE VIEW active_projects AS SELECT * FROM projects WHERE deleted_at IS NULL;
```

```sql check
SELECT
  (SELECT string_agg(id::text, ',' ORDER BY id) FROM active_projects) AS active,
  (SELECT string_agg(id || ':' || deleted_at, ',' ORDER BY id) FROM projects WHERE deleted_at IS NOT NULL) AS deleted,
  (SELECT count(*) FROM projects) AS total_rows_kept;
```
:::

:::sql id=db-08-sql8 db=empty xp=50
title: Unique among the living
A `users(id, email, deleted_at)` table uses soft delete. Ivy deleted her account (her row has a
`deleted_at`) and now wants to sign up again with the same email. Make emails unique **only
among non-deleted users**, then insert her new account: id `3`, email `ivy@studio.dev`.

hint: A partial unique index: `CREATE UNIQUE INDEX users_email_live ON users (email) WHERE deleted_at IS NULL;`
hint: A plain `UNIQUE (email)` would reject the re-signup.

```sql setup
CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL, deleted_at timestamptz);
INSERT INTO users VALUES
  (1, 'mara@studio.dev', NULL),
  (2, 'ivy@studio.dev', '2025-07-01 10:00:00+00');
```

```sql starter
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
INSERT INTO users (id, email) VALUES (3, 'ivy@studio.dev');
```

```sql solution
CREATE UNIQUE INDEX users_email_live ON users (email) WHERE deleted_at IS NULL;
INSERT INTO users (id, email) VALUES (3, 'ivy@studio.dev');
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO users (id, email) VALUES (4, 'mara@studio.dev')$q$)                    AS live_duplicate,
  pg_temp.ok($q$INSERT INTO users (id, email, deleted_at) VALUES (5, 'mara@studio.dev', now())$q$) AS deleted_duplicate,
  pg_temp.ok($q$INSERT INTO users (id, email) VALUES (6, 'ivy@studio.dev')$q$)                     AS ivy_twice;
SELECT _r.*, (SELECT string_agg(id || ':' || email, ' ' ORDER BY id) FROM users WHERE id <= 3) AS users FROM _r;
```
:::

:::quiz id=db-08-q3 xp=15
Your team adds soft delete (`deleted_at`) to `users`, which has `UNIQUE (email)`. What breaks
first?
- [ ] Foreign keys from `projects.owner_id` become invalid
- [x] A user who deleted their account can't sign up again with the same email
- [ ] `SELECT * FROM users` gets slower
- [ ] Nothing, soft delete is transparent
> The deleted row still holds the email, so the unique constraint rejects the new signup. Replace
> it with a partial unique index `WHERE deleted_at IS NULL`. (And remember every query now needs
> the filter.) Foreign keys stay valid — the row still exists, which is one of soft delete's
> selling points. `SELECT *` isn't slower just because a nullable column was added, and soft
> delete is anything but transparent.
:::

:::quiz id=db-08-q4 xp=10
Which naming is most idiomatic for a Postgres table linking users to the teams they belong to?
- [ ] `"UserTeam"` with columns `"UserId"`, `"TeamId"`
- [x] `team_members` with columns `team_id`, `user_id`
- [ ] `tblUserTeams` with columns `uid`, `tid`
> snake_case avoids quoting forever, the name describes the relationship, and FKs follow the
> `<singular>_id` pattern. Quoted PascalCase names like `"UserTeam"`/`"UserId"` are what EF Core
> produces *without* a snake-case naming convention — they work, but every hand-written query must
> quote every identifier. `tbl` prefixes
> and cryptic abbreviations like `uid` add noise and hide meaning.
:::

:::quiz id=db-08-q5 xp=15
You're designing `users`. Which primary key is the best choice?
- [ ] `email` — it's unique anyway, so no extra column is needed
- [x] A surrogate `id` (identity or UUID), plus `UNIQUE (email)`
- [ ] A surrogate `id` alone — the primary key already prevents duplicates
- [ ] `(email, display_name)` as a composite key
> Emails change, and a primary key should never change: every foreign key (`projects.owner_id`,
> `credit_ledger.user_id`, …) would have to be updated with it. A surrogate id is stable; the
> `UNIQUE (email)` constraint still prevents two accounts with the same email. "Surrogate id
> alone" is the classic trap: a fresh id per insert means the same person can be inserted twice.
> A composite of mutable columns has the problems of both.
:::

:::quiz id=db-08-q6 xp=15
`clips` has `project_id` and `parent_clip_id integer REFERENCES clips(id)`. Which bad data can
this schema still store? (select all that apply)
- [x] A clip whose parent belongs to a different project
- [x] Two clips that are each other's parent (a cycle)
- [ ] A clip whose `parent_clip_id` points to a non-existent clip
- [ ] A root clip with `parent_clip_id = NULL`
> The FK only checks that the parent *exists* — not that it's in the same project, and not that
> the chain ends. A composite FK `(project_id, parent_clip_id) REFERENCES clips (project_id, id)`
> closes the first hole; cycles need a trigger or app rules. A missing parent is exactly what the
> FK *does* prevent, and a NULL parent isn't bad data — it's how the root is marked.
:::

:::pro title="Model the business, not the screen"
Juniors often design tables after the UI ("the settings page has these 12 fields → a `settings`
table with 12 columns"). Seniors model the **domain**: what are the things, how do they relate,
what must always be true? Screens change every quarter; the domain changes slowly. Write the
invariants down ("a project has exactly one owner", "a clip's choice label is required unless
it's the root") and turn each one into a constraint.
:::

:::job title="Schema reviews are code reviews"
On a real team, a new table arrives as a migration in a pull request, and the review is often the
most important one of the feature: names, types, nullability, FKs and ON DELETE behavior, indexes
for the expected queries, and "how will we migrate this later?". Expect questions like "why is
this nullable?" and "what happens to these rows when the user is deleted?" — and ask them.
:::

:::cards id=db-08-cards1 xp=15 title="Data modeling"
Q: Goal of normalization?
A: Store each fact once, so it can't contradict itself (no update anomalies).
Q: 1NF?
A: One value per cell, no lists or repeating groups.
Q: 2NF?
A: Every non-key column depends on the whole (composite) key, not part of it.
Q: 3NF?
A: No non-key column depends on another non-key column. "The key, the whole key, nothing but the key."
Q: When is duplicating data OK?
A: Historical snapshots (order price), deliberate caches with a sync strategy, jsonb documents read/written as a unit.
Q: How to model many-to-many with a role?
A: A junction table with both FKs, a composite PK and the role column.
Q: Simplest way to store a tree?
A: Adjacency list: a nullable self-referencing parent_id FK.
Q: Postgres naming convention?
A: snake_case, plural tables, `id` PK, `<thing>_id` FKs, `_at` timestamps.
Q: Soft delete's biggest pitfalls?
A: Every query needs the filter; unique constraints must become partial unique indexes.
Q: How does a version column help?
A: Optimistic concurrency: `UPDATE … WHERE id = $1 AND version = $2` changes 0 rows if someone saved first.
Q: Natural vs surrogate key?
A: Natural = a real-world unique fact (email, ISBN); surrogate = a meaningless generated id. Use a surrogate PK plus a UNIQUE constraint on the natural key.
Q: How to keep a tree's parent in the same project?
A: `UNIQUE (project_id, id)` + `FOREIGN KEY (project_id, parent_clip_id) REFERENCES clips (project_id, id)`.
Q: CHECK vs enum vs lookup table for a fixed set?
A: CHECK for simple labels, enum for sets that never change, a lookup table when values have their own data.
Q: bigint identity vs uuidv7 primary key?
A: bigint: compact, simple, database-generated. uuidv7: generated anywhere, globally unique,
   time-ordered (index-friendly), but 16 bytes and leaks creation time.
Q: Hiding enumerable ids in URLs?
A: Keep the bigint PK and add `public_id uuid NOT NULL UNIQUE DEFAULT uuidv7()` — and still check
   authorization; an unguessable id isn't access control.
Q: Enum gotchas?
A: Can't remove or reorder values; a new value can't be used until its ALTER TYPE … ADD VALUE commits.
   It sorts in declaration order, not alphabetically.
Q: EF Core enum + `HasConversion<string>()` against `CHECK (status IN ('queued', …))`?
A: Fails: EF writes the member name `'Queued'`. Match the spelling, or map a Postgres enum with `MapEnum`.
:::

## Recap

- Turn the domain into tables: nouns → tables, "has many" → FK, many-to-many → junction table,
  fixed sets → CHECK-constrained columns, an enum type for stable sets, or a lookup table when
  values have data (and map C# enums to match).
- Surrogate primary keys (stable ids) plus `UNIQUE` on the natural key; `bigint` identity by
  default, `uuidv7()` when ids are generated outside the database, a separate `public_id` for URLs.
- Normalize to 3NF so each fact lives once; denormalize deliberately (snapshots, caches, jsonb
  documents) with a sync story.
- Trees are a self-referencing FK (adjacency list); a composite FK keeps parents in the same
  project; merging branches make it a graph with an edge table.
- Conventions: snake_case, plural tables, `id` / `<thing>_id`, `_at` timestamps.
- Audit columns (`created_at`, `updated_at`), ledgers and version columns explain and protect
  changes; soft delete trades safety for query discipline and partial unique indexes.
