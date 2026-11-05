---
id: db-19
title: Multi-Tenancy, Partitioning & Temporal Data
level: expert
minutes: 110
xp: 150
summary: The schema designs every SaaS grows into — tenancy models, tenant-safe keys, polymorphic links done safely, history and "as of" queries, no-overlap bookings, and monthly partitions you can drop in milliseconds.
---

Most tutorials model one shop with one set of customers. Real products look different after a year:
hundreds of **tenants** (customer companies) share one schema, an auditor asks "what did this price
look like on 15 February?", the booking page double-books a meeting room, and the `events` table
has grown to 900 GB, so nightly `DELETE … WHERE created_at < …` runs for hours.

This lesson covers the designs teams use for exactly these problems. It builds on four earlier
lessons: **Data Modeling** (keys, audit columns, soft delete), **Views, Functions & Triggers** (the
jsonb audit-log trigger), **Production PostgreSQL** (row-level security) and **Indexes & EXPLAIN**
(composite indexes, reading plans). If any of those are hazy, skim them first.

## Three ways to host many customers

A **tenant** is one paying customer organisation: "Acme Ltd" with its 40 users, projects and
invoices. Multi-tenancy is the question *where do Acme's rows live, and what stops Globex from
seeing them?* There are three basic answers. Think of them as housing:

- **Shared tables (pool)**: an apartment block. Every table has a `tenant_id` column, and all
  tenants' rows sit side by side. Isolation comes from `WHERE tenant_id = …` plus row-level
  security.
- **Schema per tenant (bridge)**: terraced houses. One database, one schema per tenant
  (`tenant_acme.invoices`, `tenant_globex.invoices`) with identical tables. The connection's
  `search_path` picks the tenant.
- **Database per tenant (silo)**: detached houses. Each tenant gets its own database, and often its
  own server. A small **catalog** database maps `tenant → connection string`.

| | Shared tables + `tenant_id` | Schema per tenant | Database per tenant |
|---|---|---|---|
| Isolation | Logical (RLS, app filters). A missing filter leaks data | Better: a wrong `search_path` still leaks | Strongest: separate files, roles, maybe servers |
| Cost per tenant | Near zero | Low | High (memory, connections, backups per DB) |
| Onboarding a tenant | `INSERT INTO tenants` | `CREATE SCHEMA` + run all migrations | Provision a DB + migrations + secrets |
| Migrations | Once | Once **per schema** (1 000 schemas = 1 000 runs) | Once per database, fleet-wide orchestration |
| Cross-tenant reporting | One `GROUP BY tenant_id` | `UNION ALL` over schemas | ETL into a warehouse |
| Noisy neighbour | One big tenant slows everyone | Same server, same problem | Isolated |
| Per-tenant backup / restore / delete | Hard (row-level surgery) | `pg_dump -n tenant_x`, `DROP SCHEMA` | Trivial |
| Scales to | Millions of tenants | Hundreds to low thousands (catalog bloat) | Tens to hundreds per ops team |

**Why most products start shared.** Signing up must be instant and nearly free. Migrations must run
once. And the support team will eventually want "all tenants that use feature X", which is one
query when everything is in one table. The price is that isolation becomes *your* job, in every
query.

**Why schema-per-tenant is less attractive than it looks.** It sounds like a good middle ground, but
every schema multiplies the system catalog: 2 000 tenants × 80 tables × indexes is hundreds of
thousands of catalog entries. `pg_dump` slows down, migrations take hours and can fail halfway
(tenant 1 312 is on v41, the rest on v42), and a pooled connection whose `search_path` was not
reset (use `SET LOCAL`) serves the wrong tenant.

**Why the silo exists anyway.** Enterprise contracts ask for things a shared table cannot give:
"our data stays in the EU region", "our own encryption keys", "restore only *our* data to
yesterday", "delete everything 30 days after we churn". So mature products end up **hybrid**: the
long tail of small tenants shares tables, and a handful of big or regulated tenants get a dedicated
database with *the same schema*.

### Migration paths: design so tenants can move

You rarely choose once and forever. These habits keep the exits open:

1. **Put `tenant_id` in every tenant-owned table, even in a database-per-tenant setup.** It looks
   redundant there, but it makes merging two silos, moving a tenant back into the pool, or loading
   all tenants into a warehouse a copy job instead of a rewrite.
2. **Route through a tenant catalog** (`tenants(id, slug, db_shard, region)`) from day one. Your API
   resolves `tenant → connection` per request. Moving a tenant is then: copy its rows, flip one
   catalog row, and drain.
3. **Pool → silo** (a whale tenant outgrows the shared DB): copy its rows with
   `COPY (SELECT … WHERE tenant_id = 42)`, or use logical replication with a row filter
   (`CREATE PUBLICATION p FOR TABLE invoices WHERE (tenant_id = 42)`, PostgreSQL 15+) to keep the
   new DB in sync. Then put the tenant in read-only mode for a few seconds, flip the catalog and
   delete the old rows in batches.
4. **Schema-per-tenant → pool**: add `tenant_id` to each table, then
   `INSERT INTO public.invoices SELECT <id>, * FROM tenant_x.invoices` for every schema. This is
   only painless if the ids don't collide, which is one reason to use `uuidv7()` or
   `(tenant_id, id)` keys rather than per-schema sequences that all start at 1.

:::job title="What you'll find on day one"
At most B2B SaaS jobs it's shared tables with a `tenant_id` (or `org_id`, `account_id`,
`workspace_id`) on nearly every table. Tenant resolution happens in middleware from the JWT claim
or the subdomain. EF Core global query filters (`HasQueryFilter(x => x.TenantId == _tenant.Id)`)
add the `WHERE`, and RLS may sit underneath as a safety net. Your first review comments will
probably be "this query is missing the tenant filter" and "this unique index needs `tenant_id`".
:::

:::quiz id=db-19-q1 xp=10
Your B2B product has 3 000 small tenants on shared tables. A bank wants to sign, but its contract
requires that its data lives in a separate database it can have restored on its own, with its own
encryption key. What do most teams do?
- [ ] Move all 3 000 tenants to schema-per-tenant, so the bank gets its own schema like everyone else
- [x] Keep the long tail on shared tables and give the bank a dedicated database with the same schema, chosen per request via a tenant catalog
- [ ] Tell the bank RLS is equivalent to a separate database
- [ ] Give the bank its own `tenant_id` range so its rows are physically grouped
> A **hybrid** tenancy model is the standard answer. The shared pool stays cheap for small tenants,
> and the regulated tenant gets a silo (own DB, own backups and keys) running the same migrations.
> A tenant catalog routes each request to the right connection. Schema-per-tenant is the tempting
> wrong answer: a schema shares the database's files, WAL, backups and encryption, so it meets none
> of the bank's requirements, and it costs you 3 000× the migration runs. RLS is logical isolation
> only, and an id range changes nothing physical.
:::

## Shared tables done right

In the shared model the database has to help you, because one forgotten filter is a data breach.
Row-level security (see **Production PostgreSQL**) enforces the filter. The design rules below make
the filter **fast** and make cross-tenant references **impossible**.

### `tenant_id` first: keys and indexes

Almost every query in a SaaS app starts with "within this tenant…":

```sql
SELECT * FROM invoices
WHERE tenant_id = $1 AND status = 'open'
ORDER BY created_at DESC
LIMIT 50;
```

A B-tree on `(tenant_id, status, created_at)` jumps straight to *this tenant's open invoices*,
already sorted. With `tenant_id` first, each tenant's entries sit together in the index like a
chapter in a book. Put it last, and every lookup has to read slices from all over the index. The
same goes for **uniqueness**. Uniqueness is almost always *per tenant*:

```sql
-- ✗ Globex can't create user "ada@example.com" because Acme already has one,
--   and the error message tells Globex that the address exists somewhere.
CREATE UNIQUE INDEX ON users (email);

-- ✓ unique within a tenant
CREATE UNIQUE INDEX users_tenant_email_uq ON users (tenant_id, lower(email));

-- ✓ invoice numbers restart per tenant: INV-0001 for everyone
ALTER TABLE invoices ADD CONSTRAINT invoices_number_uq UNIQUE (tenant_id, number);
```

:::quiz id=db-19-q2 xp=10
The hottest query in your app is
`WHERE tenant_id = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT 50`. Which index serves
it best?
- [ ] `(created_at, tenant_id)`
- [x] `(tenant_id, created_at)`
- [ ] Two separate indexes, `(tenant_id)` and `(created_at)`
- [ ] `(tenant_id)` alone, since it's the most selective filter
> With the **equality column first**, the B-tree goes straight to this tenant's entries, which are
> already sorted by `created_at`. Postgres reads the range backwards and stops after 50 rows, with
> no sort step. `(created_at, tenant_id)` is the tempting wrong answer because it "contains both
> columns". But it orders entries by time across *all* tenants, so the scan wades through
> everyone's recent rows to find this tenant's. Two separate indexes need a bitmap combination
> plus a sort. `(tenant_id)` alone finds the tenant's rows but still has to sort them.
:::

### Tenant-safe foreign keys

Here's a bug that RLS doesn't catch. Acme's API receives `POST /tasks { projectId: 20 }`, and
project 20 belongs to **Globex**. A plain `project_id REFERENCES projects(id)` is satisfied (the
project exists), so Acme now has a task inside Globex's project. RLS checks the *task's*
`tenant_id`, which is correctly Acme's, so it passes too. And a policy on `projects` doesn't help
either: foreign-key checks deliberately **bypass row-level security** (the database must see every
row to guarantee integrity), so the FK happily finds Globex's project even though Acme can't
`SELECT` it.

The fix is to make the foreign key carry the tenant. Then "the project exists" becomes "the project
exists **in my tenant**":

```sql
ALTER TABLE projects ADD CONSTRAINT projects_tenant_id_uq UNIQUE (tenant_id, id);

CREATE TABLE tasks (
  id         int  PRIMARY KEY,
  tenant_id  int  NOT NULL REFERENCES tenants,
  project_id int  NOT NULL,
  title      text NOT NULL,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);
```

A composite FK must reference a unique key with the same columns, which is why `projects` needs
`UNIQUE (tenant_id, id)` even though `id` alone is already unique. As a bonus, the FK's columns
start with `tenant_id`, so the supporting index on `tasks (tenant_id, project_id)` helps the
tenant's queries too.

:::sql id=db-19-sql1 db=empty xp=50
title: A foreign key that can't cross tenants
`projects` belongs to tenants. Create `tasks` with the columns `id int PRIMARY KEY`,
`tenant_id int NOT NULL`, `project_id int NOT NULL` and `title text NOT NULL`, so that a task can
only point at a project **of the same tenant**. Add whatever `projects` needs for that.

We then insert a task for tenant 1 → project 10 (Acme's own), one for tenant 1 → project 20
(Globex's), and one for tenant 2 → project 20, and check which inserts are accepted.

hint: A composite `FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)`.
hint: The referenced columns must be covered by a unique constraint: `ALTER TABLE projects ADD UNIQUE (tenant_id, id);`

```sql setup
CREATE TABLE tenants (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE projects (
  id        int PRIMARY KEY,
  tenant_id int NOT NULL REFERENCES tenants,
  name      text NOT NULL
);
INSERT INTO tenants VALUES (1, 'Acme'), (2, 'Globex');
INSERT INTO projects VALUES (10, 1, 'Acme website'), (20, 2, 'Globex payroll');
```

```sql starter
CREATE TABLE tasks (
  id         int PRIMARY KEY,
  tenant_id  int NOT NULL REFERENCES tenants,
  project_id int NOT NULL REFERENCES projects (id),
  title      text NOT NULL
);
```

```sql solution
ALTER TABLE projects ADD CONSTRAINT projects_tenant_id_uq UNIQUE (tenant_id, id);

CREATE TABLE tasks (
  id         int  PRIMARY KEY,
  tenant_id  int  NOT NULL REFERENCES tenants,
  project_id int  NOT NULL,
  title      text NOT NULL,
  FOREIGN KEY (tenant_id, project_id) REFERENCES projects (tenant_id, id)
);
```

```sql check
CREATE FUNCTION try_task(i int, t int, p int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO tasks (id, tenant_id, project_id, title) VALUES (i, t, p, 'task ' || i);
  RETURN 'ok';
EXCEPTION WHEN foreign_key_violation THEN
  RETURN 'blocked';
END $$;
SELECT try_task(1, 1, 10) AS acme_own_project,
       try_task(2, 1, 20) AS acme_into_globex,
       try_task(3, 2, 20) AS globex_own_project;
```
:::

:::warn title="Global lookups still exist"
Not everything is tenant-scoped. Login (`email → which tenants?`), billing webhooks
(`stripe_customer_id → tenant`) and the tenant catalog itself are **global** tables, and the app
reads them *before* it knows the tenant. Keep them few, keep them in a clearly named place
(a `platform` schema, say), and don't put RLS policies on them that depend on `app.tenant_id`.
:::

## Polymorphic associations

Comments can belong to a post **or** a photo. Rails, Laravel and many hand-rolled .NET schemas
solve this with a *polymorphic association*: two columns that together point at "some row in some
table".

```sql
CREATE TABLE comments (
  id               int  PRIMARY KEY,
  commentable_type text NOT NULL,   -- 'Post' or 'Photo'
  commentable_id   int  NOT NULL,   -- an id in posts OR photos
  body             text NOT NULL
);
```

It's attractive because one table and one code path serve every "commentable" thing. But look at
what the database can no longer do:

- **No foreign key.** A FK references exactly one table, so `commentable_id` can't be checked.
  Delete a post and its comments stay behind as orphans. A typo like `'Pots'` is accepted. Nothing
  cascades.
- **No honest join.** Every query needs `CASE`/`UNION` over the possible types, and the planner
  can't use FK knowledge.
- **Ambiguous ids.** `commentable_id = 1` means two different things depending on a string column.
  That makes it easy to join the wrong table and show the wrong data.
- **Typed by strings.** Rename the `Photo` class and you have to migrate data, not just code.

:::sql id=db-19-sql2 db=empty ordered=true xp=40
title: Hunt the orphans
This `comments` table uses a polymorphic association, and after years in production it contains
**orphans**: comments whose target doesn't exist. The cause can be a deleted parent, a typo in
`commentable_type`, or an id that was never valid. Return `id, commentable_type, commentable_id` of
every orphaned comment, ordered by `id`.

hint: A comment is fine if a post exists **and** the type is `'Post'`, or a photo exists **and** the type is `'Photo'`.
hint: Two `NOT EXISTS (SELECT 1 FROM posts p WHERE c.commentable_type = 'Post' AND p.id = c.commentable_id)` checks, one per parent table.

```sql setup
CREATE TABLE posts  (id int PRIMARY KEY, title text NOT NULL);
CREATE TABLE photos (id int PRIMARY KEY, caption text NOT NULL);
CREATE TABLE comments (
  id               int  PRIMARY KEY,
  commentable_type text NOT NULL,
  commentable_id   int  NOT NULL,
  body             text NOT NULL
);
INSERT INTO posts  VALUES (1, 'Launch day'), (2, 'Q3 roadmap');
INSERT INTO photos VALUES (1, 'Team offsite'), (3, 'New office');
INSERT INTO comments VALUES
  (1, 'Post',  1,  'Congrats!'),
  (2, 'Photo', 1,  'Great shot'),
  (3, 'Post',  99, 'Was this deleted?'),
  (4, 'Pots',  2,  'Typo in the type'),
  (5, 'Photo', 2,  'Photo 2 never existed'),
  (6, 'Post',  2,  'When is Q4?'),
  (7, 'Photo', 3,  'Nice view'),
  (8, 'Post',  3,  'There is a photo 3, but no post 3');
```

```sql starter
SELECT id, commentable_type, commentable_id
FROM comments
WHERE commentable_type NOT IN ('Post', 'Photo')
ORDER BY id;
```

```sql solution
SELECT c.id, c.commentable_type, c.commentable_id
FROM comments c
WHERE NOT EXISTS (SELECT 1 FROM posts p  WHERE c.commentable_type = 'Post'  AND p.id  = c.commentable_id)
  AND NOT EXISTS (SELECT 1 FROM photos f WHERE c.commentable_type = 'Photo' AND f.id = c.commentable_id)
ORDER BY c.id;
```
:::

### Safer alternatives

| Design | Shape | Integrity | Good when |
|---|---|---|---|
| **Exclusive arc** | `comments(post_id NULL FK, photo_id NULL FK, CHECK exactly one)` | Real FKs, cascades work | A handful of parent types that rarely change |
| **Separate tables** | `post_comments`, `photo_comments` | Real FKs, no NULLs | Parents behave differently anyway |
| **Shared parent ("thread")** | `comment_threads(id)`; `posts.thread_id`, `photos.thread_id` FK to it; `comments.thread_id` FK | Real FKs, any number of types | Many commentable types, or new ones added often |

The **exclusive arc** is the most common way out of a polymorphic table. You get one nullable FK
column per parent, and a `CHECK` that exactly one of them is set:

```sql
CHECK (num_nonnulls(post_id, photo_id) = 1)
```

`num_nonnulls(…)` counts the non-NULL arguments, so the check reads like the rule it enforces.
With only two columns, `(post_id IS NULL) <> (photo_id IS NULL)` also works. In EF Core this maps
to two optional navigations (`Post? Post`, `Photo? Photo`) plus a check constraint in the
migration (`ToTable(t => t.HasCheckConstraint(…))`).

:::sql id=db-19-sql3 db=empty xp=60
title: Migrate to an exclusive arc
Replace the polymorphic pair on `comments` with real foreign keys:

1. add `post_id int` referencing `posts` and `photo_id int` referencing `photos` (both nullable),
2. backfill them from `commentable_type` / `commentable_id`,
3. add a check constraint so that **exactly one** of them is set,
4. drop `commentable_type` and `commentable_id`.

(This data has no orphans. In real life you would run the previous query first.) We check the
backfilled ids and then try to insert comments with no parent, with both parents, with a missing
post, and with a valid photo.

hint: `ALTER TABLE comments ADD COLUMN post_id int REFERENCES posts, ADD COLUMN photo_id int REFERENCES photos;`
hint: Two updates: `UPDATE comments SET post_id = commentable_id WHERE commentable_type = 'Post';` and the same for photos.
hint: `CHECK (num_nonnulls(post_id, photo_id) = 1)`, then `DROP COLUMN …` twice.

```sql setup
CREATE TABLE posts  (id int PRIMARY KEY, title text NOT NULL);
CREATE TABLE photos (id int PRIMARY KEY, caption text NOT NULL);
CREATE TABLE comments (
  id               int  PRIMARY KEY,
  commentable_type text NOT NULL,
  commentable_id   int  NOT NULL,
  body             text NOT NULL
);
INSERT INTO posts  VALUES (1, 'Launch day'), (2, 'Q3 roadmap');
INSERT INTO photos VALUES (1, 'Team offsite'), (2, 'New office');
INSERT INTO comments VALUES
  (1, 'Post', 1, 'Congrats!'), (2, 'Photo', 1, 'Great shot'),
  (3, 'Post', 2, 'When is Q4?'), (4, 'Photo', 2, 'Nice view');
```

```sql starter
ALTER TABLE comments
  ADD COLUMN post_id  int REFERENCES posts,
  ADD COLUMN photo_id int REFERENCES photos;
```

```sql solution
-- 1. expand
ALTER TABLE comments
  ADD COLUMN post_id  int REFERENCES posts,
  ADD COLUMN photo_id int REFERENCES photos;

-- 2. backfill
UPDATE comments SET post_id  = commentable_id WHERE commentable_type = 'Post';
UPDATE comments SET photo_id = commentable_id WHERE commentable_type = 'Photo';

-- 3. enforce the arc
ALTER TABLE comments
  ADD CONSTRAINT comments_one_parent CHECK (num_nonnulls(post_id, photo_id) = 1);

-- 4. contract
ALTER TABLE comments
  DROP COLUMN commentable_type,
  DROP COLUMN commentable_id;
```

```sql check
CREATE FUNCTION try_comment(i int, p int, f int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO comments (id, post_id, photo_id, body) VALUES (i, p, f, 'test');
  RETURN 'ok';
EXCEPTION
  WHEN check_violation       THEN RETURN 'check_violation';
  WHEN foreign_key_violation THEN RETURN 'fk_violation';
  WHEN others                THEN RETURN 'error ' || SQLSTATE;
END $$;
SELECT 'backfilled' AS what,
       (SELECT string_agg(id || ':' || coalesce(post_id::text, '-') || '/' || coalesce(photo_id::text, '-'), ' ' ORDER BY id)
        FROM comments WHERE id < 100) AS result
UNION ALL
SELECT 'old columns left',
       (SELECT count(*)::text FROM information_schema.columns
        WHERE table_name = 'comments' AND column_name LIKE 'commentable%')
UNION ALL SELECT 'no parent',    try_comment(101, NULL, NULL)
UNION ALL SELECT 'both parents', try_comment(102, 1, 1)
UNION ALL SELECT 'missing post', try_comment(103, 99, NULL)
UNION ALL SELECT 'valid photo',  try_comment(104, NULL, 2);
```
:::

:::quiz id=db-19-q3 xp=10
Why can't PostgreSQL enforce referential integrity for `(commentable_type, commentable_id)`?
- [ ] It can, with `REFERENCES posts(id) OR photos(id)`
- [ ] It could, but only if `commentable_id` were a `uuid`
- [x] A foreign key always references one specific table. Here the target table depends on a value in each row, so there's nothing to declare
- [ ] Because `commentable_type` is `text`. An enum type would make the FK possible
> A foreign key is a fixed edge in the schema, `this column → that table's key`. When the target
> table varies per row, no such edge exists, and Postgres has no `OR` syntax for FKs. The `uuid`
> option is tempting because globally unique ids prevent *ambiguity*: id 1 can no longer mean two
> things. But the database still can't check that the uuid exists in *some* table. An enum would
> stop typos in the type column and nothing more. The fix is to give each parent its own FK
> column: an exclusive arc, separate tables, or a shared parent table.
:::

## Temporal data: remembering the past

An ordinary table only knows **now**: `UPDATE prices SET price = 12.99` destroys the old value.
Business questions come in two flavours, and they need different tools:

- **"Who changed what, and when?"** This is *auditing*. The jsonb audit-log trigger from
  **Views, Functions & Triggers** answers it: one generic table, before/after images, written for
  compliance and debugging, rarely queried.
- **"What was true at time T?"** This is *history*, or *versioning*. What did an order cost when it
  was placed? Which plan was the tenant on in March? Which tax rate applied on the invoice date?
  These are everyday product queries, so the history must be typed, indexed and easy to join.

For history we store, per version, the **period during which it was valid**. Postgres has a
built-in type for that: **ranges**.

### Range types in two minutes

```sql
SELECT tstzrange('2026-01-01', '2026-02-01');          -- ["2026-01-01 00:00:00+00","2026-02-01 00:00:00+00")
SELECT daterange('2026-06-01', '2026-06-04', '[]');    -- inclusive end: [2026-06-01,2026-06-05)
SELECT tstzrange('2026-03-15', NULL);                  -- unbounded upper end: "valid until further notice"
```

| Expression | Meaning |
|---|---|
| `r @> ts` | range **contains** the point |
| `a && b` | ranges **overlap** (share at least one point) |
| `lower(r)`, `upper(r)` | the bounds (`NULL` = unbounded) |
| `isempty(r)` | the empty range, e.g. `[10:00,10:00)` |

There is also an **adjacency** operator, `-|-`: `a -|- b` is true when one range ends exactly where
the other starts.

The default bound style is **`[)`, half-open**: it includes the start and excludes the end. This is
the right model for time. `[09:00, 10:00)` and `[10:00, 11:00)` share no instant, so back-to-back
meetings don't "overlap", and every instant belongs to exactly one version. Inclusive ends
(`BETWEEN`, `valid_to = '2026-01-31 23:59:59'`) leave gaps of a fraction of a second, or produce
double matches on the boundary.

:::quiz id=db-19-q4 xp=10
What does this return?

```sql
SELECT tstzrange('2026-06-01 09:00+00', '2026-06-01 10:00+00')
    && tstzrange('2026-06-01 10:00+00', '2026-06-01 11:00+00');
```
- [ ] `true`, because both ranges contain 10:00
- [x] `false`. With the default `[)` bounds the first range ends just *before* 10:00, so they're adjacent, not overlapping
- [ ] `NULL`, because the ranges touch
- [ ] An error: `&&` only works on arrays
> `tstzrange(a, b)` is `[a, b)` by default: the upper bound is excluded. The ranges meet at 10:00
> without sharing it, so `&&` is `false` and `-|-` (adjacent) is `true`. That's exactly what you
> want for bookings: a 09–10 meeting followed by a 10–11 meeting in the same room is fine. The
> "both contain 10:00" intuition comes from inclusive `BETWEEN`, the habit half-open ranges
> exist to break. `&&` is defined for ranges as well as arrays.
:::

### History tables via triggers

A simple design that works well: the current table stays as it is (so every existing query keeps
working), and a trigger copies each **replaced** version into a history table along with the
period it was valid:

```sql
CREATE TABLE prices (
  product_id int PRIMARY KEY,
  price      numeric(10,2) NOT NULL,
  valid_from timestamptz   NOT NULL        -- when this version became true
);
CREATE TABLE prices_history (
  product_id int           NOT NULL,
  price      numeric(10,2) NOT NULL,
  valid      tstzrange     NOT NULL        -- [old valid_from, new valid_from)
);
CREATE INDEX ON prices_history (product_id);  -- a few versions per product: this is enough
```

Two things trip people up:

- **Whose clock?** `now()` is the *transaction's* start time, which is when the row was written.
  The time when a change *became true* in the business can differ: a price can be scheduled for
  Monday, or a correction backdated. Keeping these two clocks apart is what **bitemporal**
  modelling is about (*valid time* vs *transaction/system time*). The pragmatic version: let the
  application set `valid_from`, and keep `now()` in a separate `recorded_at` column if auditors
  need it.
- **No-op updates.** ORMs often write every column even when nothing changed. Use
  `WHEN (OLD.price IS DISTINCT FROM NEW.price)` on the trigger so no-op updates don't create
  history rows.
- **Time going backwards.** `tstzrange(a, b)` raises *range lower bound must be less than or equal
  to range upper bound* when `b < a`, and `a = b` gives the `empty` range. So an `UPDATE` that
  forgets to set `valid_from` (or sets it to an older value) either fails or writes a useless
  history row. Guard against it with a `CHECK`-style test in a `BEFORE UPDATE` trigger, or let that
  `BEFORE` trigger set `NEW.valid_from := now()` when the caller didn't move it forward. (Only a
  `BEFORE` trigger can change `NEW`; the `AFTER` trigger that writes history sees the final row.)
- **Deletes.** An `UPDATE` trigger doesn't see `DELETE`, so deleting a product silently loses its
  current version. Add `AFTER DELETE` to the trigger (closing the period at `now()`), or forbid hard
  deletes on history-tracked tables and soft-delete instead.

:::sql id=db-19-sql4 db=empty xp=60
title: Keep a price history
Make every `UPDATE` on `prices` that **changes the price** copy the old version into
`prices_history`, with `valid` = `[OLD.valid_from, NEW.valid_from)`. Updates that don't change the
price must not write anything. (The application sets `valid_from` in the same `UPDATE`.)

We change product 1's price twice, run an update on product 2 that changes nothing, and check
`prices_history`.

hint: `INSERT INTO prices_history VALUES (OLD.product_id, OLD.price, tstzrange(OLD.valid_from, NEW.valid_from));`
hint: Filter on the trigger itself: `CREATE TRIGGER … AFTER UPDATE ON prices FOR EACH ROW WHEN (OLD.price IS DISTINCT FROM NEW.price) EXECUTE FUNCTION …;`

```sql setup
CREATE TABLE prices (
  product_id int PRIMARY KEY,
  price      numeric(10,2) NOT NULL,
  valid_from timestamptz   NOT NULL
);
CREATE TABLE prices_history (
  product_id int           NOT NULL,
  price      numeric(10,2) NOT NULL,
  valid      tstzrange     NOT NULL
);
INSERT INTO prices VALUES (1, 9.99, '2026-01-01 00:00+00'), (2, 25.00, '2026-01-01 00:00+00');
```

```sql starter
CREATE FUNCTION prices_keep_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- TODO: copy the OLD version into prices_history
  RETURN NULL;
END $$;

CREATE TRIGGER prices_history_trg
AFTER UPDATE ON prices
FOR EACH ROW EXECUTE FUNCTION prices_keep_history();
```

```sql solution
CREATE FUNCTION prices_keep_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO prices_history (product_id, price, valid)
  VALUES (OLD.product_id, OLD.price, tstzrange(OLD.valid_from, NEW.valid_from));
  RETURN NULL;  -- ignored for AFTER triggers
END $$;

CREATE TRIGGER prices_history_trg
AFTER UPDATE ON prices
FOR EACH ROW
WHEN (OLD.price IS DISTINCT FROM NEW.price)
EXECUTE FUNCTION prices_keep_history();
```

```sql check
UPDATE prices SET price = 11.49, valid_from = '2026-02-01 00:00+00' WHERE product_id = 1;
UPDATE prices SET price = 12.99, valid_from = '2026-03-15 00:00+00' WHERE product_id = 1;
UPDATE prices SET price = price WHERE product_id = 2;
SELECT product_id, price, lower(valid) AS valid_from, upper(valid) AS valid_to,
       lower_inc(valid) AS from_incl, upper_inc(valid) AS to_incl
FROM prices_history
ORDER BY product_id, lower(valid);
```
:::

### "As of" queries

With a current table plus a history table, "what was true at T" means treating the current row as
an open-ended version (`[valid_from, ∞)`), stacking it on top of the history, and picking the
version that **contains** T:

```sql
WITH versions AS (
  SELECT product_id, price, tstzrange(valid_from, NULL) AS valid FROM prices
  UNION ALL
  SELECT product_id, price, valid FROM prices_history
)
SELECT price FROM versions
WHERE product_id = 1 AND valid @> timestamptz '2026-02-15 12:00+00';
```

An alternative layout keeps **all** versions in one table with `valid_from`/`valid_to`, where
`valid_to IS NULL` marks the current one, plus a partial unique index
`ON (product_id) WHERE valid_to IS NULL` so there is only ever one current version. That makes
"as of" queries trivial, but every "current" query needs `WHERE valid_to IS NULL`, and every change
becomes an `UPDATE` plus an `INSERT`. Both layouts are fine. Pick one per table and stick to it.

:::sql id=db-19-sql5 db=empty ordered=true xp=50
title: Prices as of 15 February, noon
Finance wants the price list **as it was** at `2026-02-15 12:00+00`. Return `name, price` for
**every** product, ordered by `name`. Products that had no price yet at that moment get `NULL`.
Watch the boundary: a price that became valid at exactly that instant is the one that applies.

hint: Build all versions: the current row as `tstzrange(valid_from, NULL)` `UNION ALL` the history rows.
hint: `LEFT JOIN versions v ON v.product_id = p.id AND v.valid @> timestamptz '2026-02-15 12:00+00'`
hint: `@>` on a half-open range takes care of the boundary. A hand-written `<=` on both ends would match two versions.

```sql setup
CREATE TABLE products (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE prices (
  product_id int PRIMARY KEY REFERENCES products,
  price      numeric(10,2) NOT NULL,
  valid_from timestamptz   NOT NULL
);
CREATE TABLE prices_history (
  product_id int           NOT NULL REFERENCES products,
  price      numeric(10,2) NOT NULL,
  valid      tstzrange     NOT NULL
);
INSERT INTO products VALUES (1, 'Coffee beans'), (2, 'Grinder'), (3, 'Kettle'), (4, 'Mug');
INSERT INTO prices VALUES
  (1, 12.99, '2026-03-15 00:00+00'),
  (2, 89.00, '2026-01-01 00:00+00'),
  (3, 45.00, '2026-02-15 12:00+00'),
  (4,  7.50, '2026-04-01 00:00+00');
INSERT INTO prices_history VALUES
  (1,  9.99, '[2026-01-01 00:00+00, 2026-02-01 00:00+00)'),
  (1, 11.49, '[2026-02-01 00:00+00, 2026-03-15 00:00+00)'),
  (3, 39.00, '[2026-01-01 00:00+00, 2026-02-15 12:00+00)');
```

```sql starter
SELECT p.name, pr.price
FROM products p
JOIN prices pr ON pr.product_id = p.id
ORDER BY p.name;
```

```sql solution
WITH versions AS (
  SELECT product_id, price, tstzrange(valid_from, NULL) AS valid FROM prices
  UNION ALL
  SELECT product_id, price, valid FROM prices_history
)
SELECT p.name, v.price
FROM products p
LEFT JOIN versions v
  ON v.product_id = p.id
 AND v.valid @> timestamptz '2026-02-15 12:00+00'
ORDER BY p.name;
```
:::

:::info title="System-versioned tables in other databases"
SQL Server (`SYSTEM_VERSIONING = ON`, `FOR SYSTEM_TIME AS OF`) and MariaDB build this into the
engine. PostgreSQL doesn't, but PostgreSQL 18 added the first piece of SQL:2011 temporal support:
`PRIMARY KEY (id, valid WITHOUT OVERLAPS)` and temporal foreign keys with `PERIOD`. Until the rest
arrives, the trigger plus range-column pattern above is what teams use. EF Core's temporal-table
support is SQL Server only, so on Npgsql you write the history table yourself.
:::

### No double bookings: exclusion constraints

The classic bug looks like this. The booking endpoint checks
`SELECT 1 FROM bookings WHERE room_id = $1 AND during && $2`, finds nothing, and inserts. Two users
click at the same moment. Both checks run before either insert commits, both see a free room, and
both insert. As **Transactions, Isolation & Locking** showed, check-then-write in the application
is racy unless you lock or run at `SERIALIZABLE`.

An **exclusion constraint** generalises `UNIQUE`. A unique constraint says "no two rows are
*equal* on these columns". An exclusion constraint says "no two rows satisfy *these operators*
against each other", for example "same room **and** overlapping time". Like a unique index, it's
enforced inside the index, so concurrent inserts block each other and the second one fails:

```sql
CREATE EXTENSION btree_gist;   -- lets plain scalar columns (room_id) take part in a GiST index

ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (room_id WITH =, during WITH &&);
```

Read it as: *reject a new row if any existing row has `room_id =` the new one **and** `during &&`
the new one.* Since PostgreSQL 18 the same rule can be written as a temporal primary key:
`PRIMARY KEY (room_id, during WITHOUT OVERLAPS)`, which also needs `btree_gist`.

:::warn title="Where btree_gist isn't available"
`btree_gist` ships with PostgreSQL and is allowed on all major clouds, but some sandboxes, PGlite
here among them, don't include it. A range-only trick works everywhere: turn the scalar into a
one-value range, so equal ids become overlapping ranges:
`EXCLUDE USING gist (int4range(room_id, room_id, '[]') WITH &&, during WITH &&)`.
Also watch out for **empty ranges**: `[10:00, 10:00)` overlaps nothing, so it slips past any
`&&` rule. Add `CHECK (NOT isempty(during))`.
:::

:::sql id=db-19-sql6 db=empty xp=60
title: Make double bookings impossible
Add constraints to `bookings` so that:

- the **same room** can't have two bookings whose `during` ranges overlap (name it
  `bookings_no_overlap`),
- back-to-back bookings (one ends at 10:00, the next starts at 10:00) are allowed,
- **different rooms** may be booked at the same time,
- empty ranges are rejected.

`btree_gist` isn't available in this sandbox, so use the range trick from the warning above.

We try five inserts and check which ones are accepted.

hint: `ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (…);`
hint: `int4range(room_id, room_id, '[]') WITH &&` stands in for `room_id WITH =`.
hint: `ADD CONSTRAINT bookings_not_empty CHECK (NOT isempty(during))`

```sql setup
CREATE TABLE rooms (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE bookings (
  id        int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  room_id   int       NOT NULL REFERENCES rooms,
  booked_by text      NOT NULL,
  during    tstzrange NOT NULL
);
INSERT INTO rooms VALUES (1, 'Fjord'), (2, 'Glacier');
INSERT INTO bookings (room_id, booked_by, during) VALUES
  (1, 'Ada',   '[2026-06-01 09:00+00, 2026-06-01 10:00+00)'),
  (1, 'Linus', '[2026-06-01 13:00+00, 2026-06-01 14:30+00)'),
  (2, 'Grace', '[2026-06-01 09:30+00, 2026-06-01 11:00+00)');
```

```sql starter
CREATE INDEX bookings_during_idx ON bookings USING gist (during);
```

```sql solution
ALTER TABLE bookings
  ADD CONSTRAINT bookings_not_empty CHECK (NOT isempty(during)),
  ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (int4range(room_id, room_id, '[]') WITH &&, during WITH &&);
```

```sql check
CREATE FUNCTION try_book(r int, who text, s text, e text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO bookings (room_id, booked_by, during) VALUES (r, who, tstzrange(s::timestamptz, e::timestamptz));
  RETURN 'ok';
EXCEPTION
  WHEN exclusion_violation THEN RETURN 'overlap';
  WHEN check_violation     THEN RETURN 'empty';
END $$;
SELECT 'overlaps Ada'        AS attempt, try_book(1, 'Mallory', '2026-06-01 09:30+00', '2026-06-01 10:30+00') AS outcome
UNION ALL SELECT 'right after Ada',      try_book(1, 'Edsger',  '2026-06-01 10:00+00', '2026-06-01 11:00+00')
UNION ALL SELECT 'other room, same time', try_book(2, 'Barbara', '2026-06-01 13:30+00', '2026-06-01 14:00+00')
UNION ALL SELECT 'tail of Linus',         try_book(1, 'Ken',     '2026-06-01 14:00+00', '2026-06-01 15:00+00')
UNION ALL SELECT 'zero length',           try_book(1, 'Niklaus', '2026-06-01 12:00+00', '2026-06-01 12:00+00');
```
:::

:::pro title="Bookings in the API layer"
Keep the exclusion constraint as the source of truth, and translate its error into an HTTP status.
In Npgsql that's `PostgresException { SqlState: "23P01" }` (`PostgresErrorCodes.ExclusionViolation`).
Return **409 Conflict** with a friendly "that slot was just taken". The pre-check `SELECT` is still
useful for showing availability in the UI, but it's only a hint, never the guard. The same goes for
any rule "the database can enforce better than my `if`": unique emails per tenant, one current
version per product, non-overlapping subscription periods.
:::

## Declarative partitioning

A **partitioned table** is one logical table stored as many physical tables. You query and insert
into `events` as usual. Postgres routes each row to the right **partition** (`events_2026_03`) by
the **partition key** and, when a query's `WHERE` limits the key, it skips partitions that can't
contain matching rows.

Picture a filing cabinet with one drawer per month. You still say "file this invoice" and "find
March's invoices", but nobody searches the other eleven drawers, and throwing away 2024 means
taking out drawers instead of shredding one sheet at a time.

### Why partition? (Mostly: lifecycle)

1. **Retention becomes `DROP TABLE`.** Deleting a month of a huge table with `DELETE` writes WAL
   for every row, leaves millions of dead tuples for VACUUM, bloats indexes, and can take hours.
   Detaching and dropping a partition is a catalog change that takes milliseconds and leaves
   nothing behind.
2. **Partition pruning.** Time-bounded scans ("last 7 days", "March's report") touch only the
   relevant partitions, which matters a lot for queries that scan rather than seek.
3. **Smaller, per-partition maintenance.** VACUUM, `REINDEX`, `ANALYZE` and index builds work on one
   manageable chunk. Old partitions stop changing, so they stay frozen and cheap to keep.
4. **Bulk loads.** Load a month into a standalone table, index it, then `ATTACH` it.

### RANGE, LIST, HASH

```sql
-- RANGE: time series (the 90 % case). Bounds are FROM (inclusive) TO (exclusive)
CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id  int         NOT NULL,
  created_at timestamptz NOT NULL,
  kind       text        NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_01 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE events_default PARTITION OF events DEFAULT;   -- rows that fit nowhere else

-- LIST: discrete values. The hybrid-tenancy trick: whales get their own partition
CREATE TABLE orders (tenant_id int NOT NULL, id bigint NOT NULL, total numeric,
                     PRIMARY KEY (tenant_id, id)) PARTITION BY LIST (tenant_id);
CREATE TABLE orders_acme PARTITION OF orders FOR VALUES IN (1);
CREATE TABLE orders_rest PARTITION OF orders DEFAULT;

-- HASH: spread rows evenly when no natural range exists (e.g. by tenant_id)
CREATE TABLE audit (tenant_id int NOT NULL, at timestamptz NOT NULL, data jsonb)
  PARTITION BY HASH (tenant_id);
CREATE TABLE audit_p0 PARTITION OF audit FOR VALUES WITH (MODULUS 4, REMAINDER 0);
-- … p1, p2, p3
```

The rules you will hit:

- **Primary keys and unique constraints must include the partition key.** Each partition enforces
  uniqueness in its own index, and there are no global indexes. So `PRIMARY KEY (id)` on a table
  partitioned by `created_at` is rejected. Use `PRIMARY KEY (id, created_at)`. This also means
  `id` alone is no longer guaranteed unique by the database. With an identity or `uuidv7()`
  generator that's fine in practice.
- **An index created on the parent is created on every partition**, including future ones. The
  catch on a big live table: `CREATE INDEX CONCURRENTLY` is rejected on a partitioned table
  (*cannot create index on partitioned table "events" concurrently*, still true in PostgreSQL 18).
  The production recipe is `CREATE INDEX … ON ONLY events (…)` (creates an *invalid* parent index
  and touches no partition), then `CREATE INDEX CONCURRENTLY` on each partition, then
  `ALTER INDEX parent_idx ATTACH PARTITION partition_idx` for each. Once every partition's index is
  attached, the parent index becomes valid.
- **The `DEFAULT` partition is a convenience with costs.** Attaching a new partition has to scan
  the default to prove none of its rows belong in the new range, and `DETACH … CONCURRENTLY`
  refuses to run while a default exists. Many teams leave the default out and instead create
  partitions ahead of time (a cron job or `pg_partman`), so a missing partition fails loudly.
- **Updating the key moves the row** to another partition (internally a delete plus an insert).
- **Each partition is a real table**: `SELECT tableoid::regclass, *` shows where a row lives.

:::sql id=db-19-sql7 db=empty xp=60
title: A monthly-partitioned events table
Create `events` with the columns `id bigint GENERATED ALWAYS AS IDENTITY`,
`tenant_id int NOT NULL`, `created_at timestamptz NOT NULL` and `kind text NOT NULL`,
**range-partitioned by `created_at`**, with a primary key that Postgres accepts. Add:

- partitions `events_2026_01`, `events_2026_02`, `events_2026_03` for those calendar months,
- a default partition `events_default`,
- an index on `(tenant_id, created_at)` that exists on every partition.

We insert five events and check which partition each landed in, and how many partitions have the
tenant index.

hint: `… PRIMARY KEY (id, created_at)) PARTITION BY RANGE (created_at);`
hint: `CREATE TABLE events_2026_01 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');`
hint: Create the index on the **parent** (`CREATE INDEX ON events (tenant_id, created_at)`) and Postgres creates it on every partition.

```sql starter
CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  int         NOT NULL,
  created_at timestamptz NOT NULL,
  kind       text        NOT NULL
);
CREATE INDEX ON events (tenant_id, created_at);
```

```sql solution
CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id  int         NOT NULL,
  created_at timestamptz NOT NULL,
  kind       text        NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE events_2026_01 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE events_2026_03 PARTITION OF events FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE events_default PARTITION OF events DEFAULT;

CREATE INDEX events_tenant_created_idx ON events (tenant_id, created_at);
```

```sql check
INSERT INTO events (tenant_id, created_at, kind) VALUES
  (1, '2026-01-10 08:00+00', 'login'),
  (2, '2026-01-20 12:00+00', 'click'),
  (1, '2026-02-14 09:00+00', 'purchase'),
  (3, '2026-03-03 18:00+00', 'login'),
  (2, '2025-12-24 20:00+00', 'login');
SELECT tableoid::regclass::text AS partition, count(*) AS n
FROM events GROUP BY 1
UNION ALL
SELECT 'partitions with tenant index', count(DISTINCT tablename)
FROM pg_indexes
WHERE tablename LIKE 'events\_%' AND indexdef LIKE '%(tenant_id, created_at)%';
```
:::

:::quiz id=db-19-q5 xp=10
This fails. Why?

```sql
CREATE TABLE payments (
  id         bigint PRIMARY KEY,
  paid_at    timestamptz NOT NULL,
  amount     numeric NOT NULL
) PARTITION BY RANGE (paid_at);
```
- [ ] Identity or `serial` is required for primary keys on partitioned tables
- [ ] Partitioned tables can't have primary keys at all
- [x] A unique constraint on a partitioned table must include the partition key, because each partition enforces uniqueness only within itself
- [ ] `timestamptz` can't be a partition key; use `date`
> There are no global indexes: every partition has its own B-tree. Postgres can only guarantee
> uniqueness across partitions if the key decides the partition. Then two rows with equal keys
> always land in the same partition, where its index catches them. So the key must contain
> `paid_at`: `PRIMARY KEY (id, paid_at)`. "No primary keys at all" is the tempting wrong answer
> (that was true before PostgreSQL 11). Any type with ordering, `timestamptz` included, works as a
> range key.
:::

### Partition pruning: which queries skip partitions

Pruning works like an index on the partition bounds. It needs a predicate the planner can compare
with those bounds, which means the **partition key itself** compared to a value:

| Predicate | Prunes? |
|---|---|
| `created_at >= '2026-03-01' AND created_at < '2026-04-01'` | ✓ at plan time |
| `created_at >= $1 AND created_at < $2` (prepared / generic plan) | ✓ at execution start ("Subplans Removed: N") |
| `created_at >= now() - interval '7 days'` | ✓ at execution start (`now()` is stable, not a constant) |
| `date_trunc('month', created_at) = '2026-03-01'` | ✗ scans every partition |
| `created_at::date = '2026-03-01'`, `extract(month FROM created_at) = 3` | ✗ |
| `tenant_id = 42` (no condition on `created_at`) | ✗ scans every partition |

It's the **sargability** rule from **Performance Tuning**: keep the key naked and move the
arithmetic to the other side. A `date_trunc` on the column hides the key from the planner, just as
it hides a column from a B-tree.

:::sql id=db-19-sql8 db=empty xp=60
title: Make the report prunable
The `january_report` view returns the right numbers but scans **every** partition, because it
wraps the partition key in `date_trunc`. Replace the view so that it returns exactly the same rows
(January 2026, `kind` and count `n`) and the plan touches **only** `events_2026_01`.

We look at the view's plan (`EXPLAIN`) to see which partitions it scans, and compare its rows.

hint: `CREATE OR REPLACE VIEW january_report AS SELECT kind, count(*) AS n FROM events WHERE … GROUP BY kind;`
hint: A half-open range on the naked key: `created_at >= '2026-01-01' AND created_at < '2026-02-01'`.

```sql setup
CREATE TABLE events (
  id         bigint      NOT NULL,
  created_at timestamptz NOT NULL,
  kind       text        NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE events_2026_01 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE events_2026_03 PARTITION OF events FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
INSERT INTO events VALUES
  (1, '2026-01-03 10:00+00', 'login'),
  (2, '2026-01-15 11:00+00', 'click'),
  (3, '2026-01-28 09:00+00', 'login'),
  (4, '2026-02-01 00:00+00', 'login'),
  (5, '2026-02-10 14:00+00', 'purchase'),
  (6, '2026-03-05 16:00+00', 'click');
CREATE VIEW january_report AS
SELECT kind, count(*) AS n
FROM events
WHERE date_trunc('month', created_at) = '2026-01-01'
GROUP BY kind;
```

```sql starter
CREATE OR REPLACE VIEW january_report AS
SELECT kind, count(*) AS n
FROM events
WHERE date_trunc('month', created_at) = '2026-01-01'
GROUP BY kind;
```

```sql solution
CREATE OR REPLACE VIEW january_report AS
SELECT kind, count(*) AS n
FROM events
WHERE created_at >= '2026-01-01' AND created_at < '2026-02-01'
GROUP BY kind;
```

```sql check
CREATE FUNCTION scanned_partitions(q text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  line  text;
  parts text[] := '{}';
BEGIN
  FOR line IN EXECUTE 'EXPLAIN (COSTS OFF) ' || q LOOP
    IF line ~ ' on events_' THEN
      parts := parts || substring(line from ' on (events_[0-9a-z_]+)');
    END IF;
  END LOOP;
  RETURN array_to_string(ARRAY(SELECT DISTINCT unnest(parts) ORDER BY 1), ', ');
END $$;
SELECT 'scans' AS what, scanned_partitions('SELECT * FROM january_report') AS value
UNION ALL
SELECT kind, n::text FROM january_report;
```
:::

:::quiz id=db-19-q6 xp=10
`events` is partitioned by month on `created_at`. Which of these queries can skip partitions?
Select all that apply.
- [x] `WHERE created_at >= now() - interval '7 days'`
- [ ] `WHERE created_at::date = '2026-03-10'`
- [x] `WHERE created_at >= $1 AND created_at < $2` in a prepared statement with a generic plan
- [ ] `WHERE tenant_id = 42 ORDER BY created_at DESC LIMIT 50`
> Pruning needs the **naked partition key compared to a value**. If the value is known when
> planning, Postgres prunes then. If it's only known when execution starts (a parameter, or the
> stable function `now()`), it prunes at executor startup, and `EXPLAIN` shows
> `Subplans Removed: N`. The cast `created_at::date` is the tempting wrong one. It looks harmless,
> but the condition is now on an *expression*, not the key, so every partition is scanned. The
> tenant query has no `created_at` bound at all, so each partition's index is probed (with the
> `LIMIT` that's at least cheap per partition, but nothing is skipped).
:::

### Retention: detach, archive, drop

Retention is the job partitioning does best. Every month:

```sql
-- 1. create next month ahead of time (never let inserts hit a missing partition)
CREATE TABLE events_2026_04 PARTITION OF events FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

-- 2. retire the oldest month
ALTER TABLE events DETACH PARTITION events_2025_04 CONCURRENTLY;  -- PG 14+, no default partition
-- … pg_dump -t events_2025_04 to S3, or keep it as a plain archive table …
DROP TABLE events_2025_04;
```

:::warn title="Milliseconds, once it gets the lock"
`DETACH PARTITION` (without `CONCURRENTLY`), `DROP TABLE` on a partition and
`CREATE TABLE … PARTITION OF` all need an **exclusive lock on the parent**. A single long-running
report on `events` makes them wait, and while they wait every new query on `events` queues behind
them, which looks like an outage. Run retention jobs with `SET lock_timeout = '2s'` and retry on
failure. `ATTACH PARTITION` takes a weaker lock on the parent (`SHARE UPDATE EXCLUSIVE`, which
doesn't block reads or writes), and `DETACH … CONCURRENTLY` avoids the exclusive lock as well, two
more reasons to prefer "create standalone, then attach" and to skip the default partition. Lock
details are in the PostgreSQL docs for
[`ALTER TABLE`](https://www.postgresql.org/docs/current/sql-altertable.html).
:::

To **bulk-load** a month, build it as a standalone table, add a `CHECK` constraint that matches
the partition bounds, and attach it. Postgres sees from the constraint that every row fits, so it
skips the validation scan under lock:

```sql
CREATE TABLE events_2026_05 (LIKE events INCLUDING DEFAULTS);
-- … COPY the data in, CREATE INDEX …
ALTER TABLE events_2026_05 ADD CONSTRAINT bounds
  CHECK (created_at >= '2026-05-01' AND created_at < '2026-06-01');
ALTER TABLE events ATTACH PARTITION events_2026_05 FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
ALTER TABLE events_2026_05 DROP CONSTRAINT bounds;   -- redundant now
```

:::sql id=db-19-sql9 db=empty xp=60
title: Monthly retention run
It's the start of March, and the retention policy keeps **three** months. Do this month's run:

1. remove December 2025 from `events`: detach `events_2025_12`, then drop it (pretend it has been
   archived),
2. attach the standalone, already-loaded table `events_2026_03` as the March partition, after
   first adding a `CHECK` constraint matching its bounds so the attach needs no validation scan.

(Use a plain `DETACH PARTITION` here. Your script runs as one multi-statement batch, which is an
implicit transaction, and `DETACH … CONCURRENTLY` refuses to run inside a transaction block.)
We list the partitions, count the rows through the parent, check whether the December table still
exists, and insert a new March event to see where it lands. The grader can't observe whether the
attach scanned the table, so step 2's `CHECK` isn't graded (keep it or drop it afterwards), but add
it anyway: it's the habit that keeps a production attach fast.

hint: `ALTER TABLE events DETACH PARTITION events_2025_12;` then `DROP TABLE events_2025_12;`
hint: `ALTER TABLE events_2026_03 ADD CONSTRAINT events_2026_03_bounds CHECK (created_at >= '2026-03-01' AND created_at < '2026-04-01');`
hint: `ALTER TABLE events ATTACH PARTITION events_2026_03 FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');`

```sql setup
CREATE TABLE events (
  id         bigint      NOT NULL,
  created_at timestamptz NOT NULL,
  kind       text        NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE events_2025_12 PARTITION OF events FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE events_2026_01 PARTITION OF events FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE events_2026_02 PARTITION OF events FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
INSERT INTO events VALUES
  (1, '2025-12-05 10:00+00', 'login'),
  (2, '2025-12-20 10:00+00', 'click'),
  (3, '2026-01-10 10:00+00', 'login'),
  (4, '2026-02-02 10:00+00', 'purchase');
-- March was bulk-loaded into a standalone table, outside the partitioned table
CREATE TABLE events_2026_03 (LIKE events INCLUDING DEFAULTS);
INSERT INTO events_2026_03 VALUES
  (5, '2026-03-01 08:00+00', 'login'),
  (6, '2026-03-30 22:00+00', 'click');
```

```sql starter
DELETE FROM events WHERE created_at < '2026-01-01';
```

```sql solution
-- 1. retire December
ALTER TABLE events DETACH PARTITION events_2025_12;
DROP TABLE events_2025_12;

-- 2. attach March without a validation scan
ALTER TABLE events_2026_03 ADD CONSTRAINT events_2026_03_bounds
  CHECK (created_at >= '2026-03-01' AND created_at < '2026-04-01');
ALTER TABLE events ATTACH PARTITION events_2026_03
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
```

```sql check
CREATE TEMP TABLE landed AS
WITH ins AS (
  INSERT INTO events VALUES (7, '2026-03-15 12:00+00', 'view') RETURNING tableoid::regclass::text AS p
) SELECT p FROM ins;
SELECT 'partitions' AS what,
       (SELECT string_agg(inhrelid::regclass::text, ', ' ORDER BY inhrelid::regclass::text)
        FROM pg_inherits WHERE inhparent = 'events'::regclass) AS value
UNION ALL SELECT 'rows via parent', (SELECT count(*)::text FROM events)
UNION ALL SELECT 'december table exists', (to_regclass('events_2025_12') IS NOT NULL)::text
UNION ALL SELECT 'new march row landed in', (SELECT p FROM landed);
```
:::

:::quiz id=db-19-q7 xp=10
You must delete one month (≈ 40 million rows) from a 900 GB events table every month. Why is
`DROP TABLE` on a monthly partition so much better than `DELETE … WHERE created_at < …`?
- [ ] `DELETE` doesn't actually remove rows in PostgreSQL. Only `DROP` does
- [x] `DROP` removes the partition's files in one catalog operation, while `DELETE` marks 40 M rows dead one by one, writes WAL for each, and leaves VACUUM and index bloat to clean up
- [ ] `DROP` is faster only because it skips foreign key checks
- [ ] They cost the same. The benefit of partitioning is only faster `SELECT`s
> A partition is a real table with its own files, so dropping it is a metadata change plus unlinking
> files: milliseconds, almost no WAL, no dead tuples. `DELETE` goes through MVCC. Every row gets a
> deletion marker that is WAL-logged and replicated, and then autovacuum has to visit all those
> pages and the indexes. That can take hours and slows everything else down. The first option is
> tempting because it's half true: `DELETE` does remove rows *logically*, but the space is only
> reclaimed by VACUUM later. Faster `SELECT`s through pruning are a benefit, but cheap retention is
> usually the main reason to partition.
:::

### When partitioning does NOT help

Partitioning is a lifecycle tool, not a general speed button. Leave it out, or reconsider, when:

- **The table is small.** Below a few tens of GB, with indexes that fit in memory, a B-tree finds a
  row in 3–4 page reads anyway. The lab shows an indexed tenant query on a partitioned and on a
  plain table reading the same number of buffers.
- **Queries don't filter on the key.** `WHERE customer_id = 7` on a table partitioned by month
  probes *every* partition's index. With 36 partitions that's 36 index lookups instead of one.
- **You'd need many partitions.** Planning time and lock count grow with the partitions a query
  touches. Hundreds of partitions are fine, tens of thousands (say, one per tenant per day) are not.
- **You need global uniqueness on a non-key column.** Unique email across a table partitioned by
  date isn't enforceable without the key.
- **You actually need more machines.** Partitions live on the same server, using the same CPU, RAM
  and disk. Spreading data over nodes is **sharding** (Citus, or application-level shards via the
  tenant catalog).

:::quiz id=db-19-q8 xp=10
A 6 GB `orders` table is "slow". The hot queries are `WHERE id = $1` and
`WHERE tenant_id = $1 AND status = 'open'`. A teammate proposes partitioning it by month. What's
the best response?
- [ ] Good idea: smaller partitions are always faster to search
- [ ] Good idea, but use 365 daily partitions for even more pruning
- [x] Look at the plans first. Neither query filters on the month, so every partition would be probed, and a proper index like `(tenant_id, status)` is the likely fix
- [ ] Partition by `id` with HASH to make `WHERE id = $1` prune
> Partitioning speeds up queries only when they **prune**, and neither hot query mentions a date.
> A month-partitioned table would turn each lookup into one probe per partition. Six GB is small:
> `EXPLAIN (ANALYZE, BUFFERS)` and the right composite index (see **Indexes & EXPLAIN**) almost
> always fix this. "Smaller partitions are faster to search" is the tempting myth. B-tree depth
> grows logarithmically, so a 12× smaller index is maybe one page read shallower, and you pay that
> back many times over in extra probes. HASH on `id` would prune for `id` lookups, but they were
> never the problem, and it would make the tenant query probe every partition.
:::

:::pro title="Automate the calendar: pg_partman"
Real teams don't create partitions by hand. **`pg_partman`** creates partitions in advance
(`premake`), detaches or drops expired ones according to a retention setting, and runs from
`pg_cron` or a Kubernetes CronJob. It's available on most managed Postgres services. Whatever tool
you use, add an alert for "no partition exists for next month", and if you skip the default
partition, test that inserts beyond the last partition fail in staging rather than in production
at midnight on the 1st.
:::

## Hands-on: partitions at scale

:::lab id=db-19-lab1 xp=80
title: Two million events, pruning, retention and a temporal primary key
You'll run PostgreSQL 18 in Docker, load two million events into a monthly-partitioned table and
a plain copy, read the plans, retire a month both ways, and try a PostgreSQL 18 temporal primary
key with `btree_gist`, the parts PGlite can't do.

**1. Start PostgreSQL 18** (Podman users: replace `docker` with `podman`).

```bash
docker run --name dq19-lab -e POSTGRES_PASSWORD=devquest -d postgres:18
until docker exec dq19-lab pg_isready -U postgres; do sleep 1; done
mkdir dq19-lab && cd dq19-lab
```

The container runs in UTC, so `'2026-03-01'` means midnight UTC.

**2. Create `01-partitions.sql`.** It creates a table partitioned by month for 2026 plus a default
partition, an index on the parent, two million rows from 500 tenants, and an identical
unpartitioned copy:

```sql
DROP TABLE IF EXISTS events, events_flat;

CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id  int         NOT NULL,
  created_at timestamptz NOT NULL,
  kind       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}',
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

DO $$
DECLARE m date;
BEGIN
  FOR m IN SELECT generate_series(date '2026-01-01', date '2026-12-01', interval '1 month')::date LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
      'events_' || to_char(m, 'YYYY_MM'), m, (m + interval '1 month')::date);
  END LOOP;
END $$;
CREATE TABLE events_default PARTITION OF events DEFAULT;

-- one index on the parent = one index on every partition
CREATE INDEX events_tenant_created_idx ON events (tenant_id, created_at);

-- two million rows spread over the year, 500 tenants
INSERT INTO events (tenant_id, created_at, kind)
SELECT 1 + (g % 500),
       timestamptz '2026-01-01 00:00+00' + (g * interval '15.7 seconds'),
       (ARRAY['login','view','click','purchase'])[1 + g % 4]
FROM generate_series(1, 2000000) AS g;

-- the same data in an ordinary table, for comparison
CREATE TABLE events_flat AS SELECT * FROM events;
CREATE INDEX ON events_flat (tenant_id, created_at);
ANALYZE events, events_flat;

SELECT tableoid::regclass AS partition, count(*) AS rows
FROM events GROUP BY 1 ORDER BY 1 LIMIT 4;
```

```bash
docker exec -i dq19-lab psql -U postgres -v ON_ERROR_STOP=1 < 01-partitions.sql
```

Expected (after about 10 seconds):

```text
   partition    |  rows
----------------+--------
 events_2026_01 | 170598
 events_2026_02 | 154089
 events_2026_03 | 170599
 events_2026_04 | 165096
(4 rows)
```

**3. Create `02-pruning.sql`** and read the four plans:

```sql
-- A. Plan-time pruning: the bounds are constants
EXPLAIN (COSTS OFF)
SELECT count(*) FROM events
WHERE created_at >= '2026-03-01' AND created_at < '2026-04-01';

-- B. No pruning: the partition key is wrapped in a function
EXPLAIN (COSTS OFF)
SELECT count(*) FROM events
WHERE date_trunc('month', created_at) = '2026-03-01';

-- C. Run-time pruning: a generic plan with a parameter (like a prepared statement from Npgsql)
PREPARE month_count(timestamptz) AS
  SELECT count(*) FROM events WHERE created_at >= $1 AND created_at < $1 + interval '1 month';
SET plan_cache_mode = force_generic_plan;
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF, BUFFERS OFF) EXECUTE month_count('2026-03-01');
RESET plan_cache_mode;

-- D. An indexed tenant lookup: partitioned vs. ordinary table
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM events
WHERE tenant_id = 42 AND created_at >= '2026-03-01' AND created_at < '2026-04-01';
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM events_flat
WHERE tenant_id = 42 AND created_at >= '2026-03-01' AND created_at < '2026-04-01';
```

```bash
docker exec -i dq19-lab psql -U postgres < 02-pruning.sql
```

What to look for (worker counts and buffer numbers vary):

```text
A:  ->  Parallel Seq Scan on events_2026_03 events          ← one partition only
B:  ->  Parallel Append
          ->  Parallel Seq Scan on events_2026_03 events_3
          ->  Parallel Seq Scan on events_2026_07 events_7
          … all 13 partitions, each with Filter: (date_trunc('month'::text, created_at) = …)
C:  ->  Append (actual rows=170599.00 loops=1)
          Subplans Removed: 12                               ← pruned at executor start
          ->  Bitmap Heap Scan on events_2026_03 events_1
D:  events:       Bitmap Heap Scan on events_2026_03 …  Buffers: shared hit=345
    events_flat:  Bitmap Heap Scan on events_flat …     Buffers: shared read=346
```

Plan D is the "partitioning doesn't speed up indexed lookups" lesson: both read about 345 pages.
The B-tree was already doing the narrowing.

**4. Retire January both ways.** Run these one by one:

```bash
docker exec dq19-lab psql -U postgres -c '\timing on' -c "DELETE FROM events_flat WHERE created_at < '2026-02-01'"
docker exec dq19-lab psql -U postgres -c "ALTER TABLE events DETACH PARTITION events_2026_01 CONCURRENTLY"
docker exec dq19-lab psql -U postgres -c '\timing on' -c "ALTER TABLE events DETACH PARTITION events_2026_01"
docker exec dq19-lab pg_dump -U postgres -t events_2026_01 -Fc -f /tmp/events_2026_01.dump
docker exec dq19-lab ls -lh /tmp/events_2026_01.dump
docker exec dq19-lab psql -U postgres -c '\timing on' -c "DROP TABLE events_2026_01"
docker exec dq19-lab psql -U postgres -c "SELECT relname, n_live_tup, n_dead_tup FROM pg_stat_user_tables WHERE relname IN ('events_flat', 'events_2026_02') ORDER BY relname"
```

Expected (timings vary):

```text
DELETE 170598
Time: 72.355 ms
ERROR:  cannot detach partitions concurrently when a default partition exists
ALTER TABLE
Time: 4.217 ms
-rw-r--r-- 1 root root 1.2M … /tmp/events_2026_01.dump
DROP TABLE
Time: 9.540 ms
    relname     | n_live_tup | n_dead_tup
----------------+------------+------------
 events_2026_02 |     154089 |          0
 events_flat    |    1829402 |     170598
(2 rows)
```

The `DELETE` left 170 598 dead tuples for autovacuum, and at 900 GB that's hours of work. The
partition went away in milliseconds without a trace, and the archive dump is still on disk. Note
the `CONCURRENTLY` error: this is the default partition's hidden cost.

**5. Create `03-attach.sql`.** It prepares next January off to the side, then attaches it:

```sql
CREATE TABLE events_2027_01 (LIKE events INCLUDING DEFAULTS);
ALTER TABLE events_2027_01 ADD CONSTRAINT events_2027_01_bounds
  CHECK (created_at >= '2027-01-01' AND created_at < '2027-02-01');
ALTER TABLE events ATTACH PARTITION events_2027_01
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
ALTER TABLE events_2027_01 DROP CONSTRAINT events_2027_01_bounds;

INSERT INTO events (tenant_id, created_at, kind) VALUES (7, '2027-01-15 09:00+00', 'login')
RETURNING id, tableoid::regclass AS landed_in;

SELECT relname AS partition, pg_get_expr(relpartbound, oid) AS bounds
FROM pg_class
WHERE relispartition AND relkind = 'r' AND relname LIKE 'events_%'
ORDER BY relname DESC LIMIT 3;
```

```bash
docker exec -i dq19-lab psql -U postgres -v ON_ERROR_STOP=1 < 03-attach.sql
```

Expected:

```text
   id    |   landed_in
---------+----------------
 2000001 | events_2027_01
(1 row)

INSERT 0 1
   partition    |                                  bounds
----------------+--------------------------------------------------------------------------
 events_default | DEFAULT
 events_2027_01 | FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00')
 events_2026_12 | FOR VALUES FROM ('2026-12-01 00:00:00+00') TO ('2027-01-01 00:00:00+00')
(3 rows)
```

**6. Create `04-bookings.sql`.** It's a PostgreSQL 18 temporal primary key, with the real
`btree_gist`:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
DROP TABLE IF EXISTS bookings;
CREATE TABLE bookings (
  room_id int       NOT NULL,
  guest   text      NOT NULL,
  during  tstzrange NOT NULL,
  PRIMARY KEY (room_id, during WITHOUT OVERLAPS)
);
INSERT INTO bookings VALUES (101, 'Ada',     '[2026-06-01 14:00+00, 2026-06-04 10:00+00)');
INSERT INTO bookings VALUES (101, 'Linus',   '[2026-06-04 10:00+00, 2026-06-06 10:00+00)');  -- back-to-back
INSERT INTO bookings VALUES (102, 'Grace',   '[2026-06-02 14:00+00, 2026-06-03 10:00+00)');  -- other room
INSERT INTO bookings VALUES (101, 'Mallory', '[2026-06-03 14:00+00, 2026-06-05 10:00+00)');  -- overlaps
```

```bash
docker exec -i dq19-lab psql -U postgres < 04-bookings.sql
```

Expected: three `INSERT 0 1` lines, then

```text
ERROR:  conflicting key value violates exclusion constraint "bookings_pkey"
DETAIL:  Key (room_id, during)=(101, ["2026-06-03 14:00:00+00","2026-06-05 10:00:00+00")) conflicts with existing key (room_id, during)=(101, ["2026-06-01 14:00:00+00","2026-06-04 10:00:00+00")).
```

**7. Clean up**: `docker rm -f dq19-lab`

:::tip
Try this variation: drop `events_default` (`DROP TABLE events_default;`) and run the
`DETACH … CONCURRENTLY` command on `events_2026_02`. It now works, which is why many teams
pre-create partitions instead of relying on a default.
:::

- [ ] `01-partitions.sql` loaded 2 000 000 rows and the first partitions show ~150–170 k rows each
- [ ] Plan A scans only `events_2026_03`, plan B scans every partition, and plan C shows `Subplans Removed: 12`
- [ ] Plan D reads about the same number of buffers on `events` and `events_flat`
- [ ] The `DELETE` left ~170 k dead tuples, while the detached partition was dumped and dropped in milliseconds
- [ ] `DETACH … CONCURRENTLY` failed with the default-partition error, and I can explain why
- [ ] The attached `events_2027_01` partition received the new row
- [ ] The overlapping booking was rejected by the `WITHOUT OVERLAPS` primary key
:::

:::cards id=db-19-cards1 xp=15 title="Tenancy, partitioning & temporal data"
Q: Name the three multi-tenancy models and one weakness of each.
A: Shared tables + tenant_id (one missing filter leaks data; noisy neighbours). Schema per tenant (migrations × N, catalog bloat, search_path leaks). Database per tenant (cost and ops per tenant, cross-tenant reporting needs ETL).
Q: Why should composite indexes in a SaaS app usually start with tenant_id?
A: Almost every query has `tenant_id = ?`. An equality column first lets the B-tree jump to that tenant's slice, already sorted by the next column.
Q: How do you stop a task from referencing another tenant's project?
A: A composite FK `(tenant_id, project_id) REFERENCES projects (tenant_id, id)`, backed by `UNIQUE (tenant_id, id)` on projects.
Q: What's wrong with a polymorphic association (type + id columns)?
A: No foreign key is possible: orphans, typos, no cascades, ambiguous ids. Use an exclusive arc (one FK per parent + CHECK num_nonnulls(…) = 1), separate tables, or a shared parent table.
Q: Why are half-open ranges `[)` the right default for time?
A: Every instant belongs to exactly one range. Back-to-back periods are adjacent, not overlapping, and there are no gaps like with `23:59:59`.
Q: How do you guarantee no overlapping bookings per room?
A: `EXCLUDE USING gist (room_id WITH =, during WITH &&)` (needs btree_gist), or PG 18's `PRIMARY KEY (room_id, during WITHOUT OVERLAPS)`. An app-side check-then-insert is racy.
Q: How does an "as of" query work with a current table + history table?
A: Treat the current row as `[valid_from, ∞)`, UNION ALL the history, and keep the version whose range `@>` the timestamp.
Q: Why must a partitioned table's primary key include the partition key?
A: There are no global indexes. Each partition enforces uniqueness only within itself, so the key must decide the partition.
Q: Which predicates allow partition pruning?
A: The naked key compared to constants (plan time), parameters or stable functions like now() (executor start). Wrapping the key in date_trunc/casts/extract disables pruning.
Q: Why is dropping a partition better than DELETE for retention?
A: It's a catalog operation: no per-row WAL, no dead tuples, no vacuum or bloat. DELETE marks every row dead and leaves the cleanup to autovacuum.
Q: When does partitioning NOT help?
A: Small tables, queries that don't filter on the key, too many partitions (planning/lock overhead), needing global uniqueness on other columns, or needing more machines (that's sharding).
Q: What are the costs of a DEFAULT partition?
A: Attaching a new partition must scan the default, and DETACH … CONCURRENTLY isn't allowed while one exists. Pre-creating partitions is often the better choice.
Q: Why can a "millisecond" partition drop still cause an outage?
A: DETACH (non-concurrent), DROP and CREATE … PARTITION OF need an exclusive lock on the parent. Behind one long query they wait, and every new query queues behind them. Use lock_timeout + retry; prefer ATTACH (weaker lock) and DETACH … CONCURRENTLY.
:::

## Recap

- **Tenancy models** trade isolation for cost. Shared tables with `tenant_id` + RLS are cheap and
  simple, schema-per-tenant multiplies migrations and catalog size, and database-per-tenant isolates
  fully but costs the most. Mature SaaS goes **hybrid**, routed through a tenant catalog.
- Put **`tenant_id` first** in composite indexes and unique constraints, and make foreign keys
  **tenant-safe** with `(tenant_id, x_id) REFERENCES parent (tenant_id, id)`.
- **Polymorphic associations** can't have foreign keys. Prefer an **exclusive arc** with
  `CHECK (num_nonnulls(…) = 1)`, separate tables, or a shared parent table.
- Keep **audit** (who changed what) separate from **history** (what was true when). History tables
  filled by triggers with **half-open `tstzrange`** periods make "as of" queries a simple `@>`.
- **Exclusion constraints** (`EXCLUDE USING gist (room_id WITH =, during WITH &&)`, or PG 18's
  `WITHOUT OVERLAPS`) are the only race-free way to prevent overlaps. Reject empty ranges too.
- **Declarative partitioning** (RANGE / LIST / HASH) is mainly a **lifecycle** tool. Retention
  becomes detach + drop, and bulk loads become attach with a matching `CHECK`.
- **Pruning** needs the naked partition key compared to a value. Unique keys must include the
  partition key, and the default partition has hidden costs.
- Partitioning does **not** fix small tables, queries that don't filter on the key, or a server
  that's out of capacity. Read the plan first.
