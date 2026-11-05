---
id: db-07
title: Tables, Types & Constraints
level: intermediate
minutes: 45
xp: 150
summary: Design tables that protect their own data — Postgres types, identity and generated columns, NOT NULL, UNIQUE, CHECK, foreign keys with ON DELETE, ALTER TABLE and DROP.
---

The queries you write are only as trustworthy as the data underneath. A table with the right
**types** and **constraints** makes whole classes of bugs impossible: negative prices, orders for
customers that don't exist, two accounts with the same email, a status of `'shiped'`. This lesson
is about **DDL** (data definition language): `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE` — and the
choices a senior engineer makes when writing them.

:::tip title="How these challenges are graded"
You start with an **empty** database (sometimes with a helper table). After your DDL runs, a
hidden check inspects the catalog (`information_schema`) and **tries inserting good and bad
rows**. The result shows `true` for each insert that succeeded and `false` for each that was
rejected — compare yours with the expected row to see which rule is missing.
:::

## CREATE TABLE

```sql
CREATE TABLE tags (
  id    integer PRIMARY KEY,
  name  text    NOT NULL UNIQUE
);
```

Each column is `name type [constraints]`. **Column constraints** like `NOT NULL UNIQUE` sit right
after the type and apply to that one column. **Table constraints** span several columns and go
after the column list, separated by commas: `PRIMARY KEY (order_id, product_id)`,
`UNIQUE (project_id, title)`. `UNIQUE (project_id, title)` means "the *combination* must be
unique" — two projects may each have a clip called "Intro", but one project may not have two.

`CREATE TABLE IF NOT EXISTS tags (…)` skips silently when the table exists — handy in scripts, but
note it does **not** compare definitions: an old, different `tags` table stays as it is.

## Choosing types (Postgres edition)

| Need | Use | Avoid / notes |
|---|---|---|
| Whole numbers | `integer` (±2.1 billion), `bigint` (±9.2 × 10¹⁸) for ids and counters that can grow | `smallint` saves little |
| **Money**, exact decimals | `numeric(12,2)` — exact (12 digits in total, 2 after the point) | `real` / `double precision` (floats): `0.1 + 0.2 = 0.30000000000000004` |
| Measurements, science | `double precision` | — |
| Text | `text` | `varchar(n)` only if the limit is a real business rule; `char(n)` pads with spaces |
| Points in time | `timestamptz` | `timestamp` (without time zone) — it can't tell 09:00 Berlin from 09:00 New York |
| Calendar dates | `date` | — |
| Durations | `interval` | storing seconds in an int is fine too |
| Yes/no | `boolean` | `'Y'/'N'` text, `0/1` ints |
| Opaque ids | `uuid` — random v4 via `gen_random_uuid()`, or time-ordered v7 via `uuidv7()` (Postgres 18) | text ids |
| Flexible documents | `jsonb` | `json` (stores the raw text incl. whitespace and duplicate keys, re-parsed on every query, no GIN indexing) |

A few Postgres-specific notes worth knowing:

- In Postgres, `text` and `varchar` have **identical performance**. `varchar(255)` is a habit from
  other databases, not a Postgres optimisation.
- `timestamptz` does *not* store a time zone. It stores an absolute instant (UTC internally) and
  converts to the session's time zone for display. That's exactly what you want for
  `created_at`, `paid_at`, `finished_at`. Npgsql maps it to a UTC `DateTime` / `DateTimeOffset`
  in .NET; plain `timestamp` is for "wall-clock" values with no zone, like "the shop opens at
  09:00 local time".
- Why `uuidv7()`? A v7 UUID starts with a timestamp, so new ids are roughly **sorted by creation
  time**. Inserts then land at the "end" of the primary-key index instead of at random places,
  which keeps big indexes compact and fast. Random v4 ids are fine for small tables and are
  unguessable — v7 leaks the creation time, so don't use it where that matters.
- Numeric overflow is an error, not a wrap-around: inserting 3 billion into an `integer` column
  fails with *integer out of range*. Teams that start ids as `integer` sometimes face a painful
  migration years later — `bigint` costs only 4 extra bytes.

:::quiz id=db-07-q1 xp=15
Which type should store an order's **total amount in euros**?
- [ ] `double precision`
- [ ] `real`
- [x] `numeric(12,2)`
- [ ] `text`
> Floating-point types (`real`, `double precision`) store binary fractions, so most decimal
> amounts like `0.10` are approximations and sums drift by tiny amounts — unacceptable for money.
> `double precision` is tempting because it's "more precise", but more digits of an approximation
> is still an approximation. `numeric` is exact. `text` can't be summed or constrained as a number.
> (Storing integer **cents** in a `bigint` is also a valid, popular choice.)
:::

## Generated ids: identity vs serial

You rarely want to pick ids by hand. The modern, SQL-standard way:

```sql
CREATE TABLE notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO notes (body) VALUES ('first') RETURNING id;   -- 1
```

- `GENERATED ALWAYS AS IDENTITY`: Postgres always generates the value; an explicit id is an
  error (unless you say `OVERRIDING SYSTEM VALUE`). Safest.
- `GENERATED BY DEFAULT AS IDENTITY`: generates one unless you supply your own — handy for
  importing data.
- `serial` / `bigserial` is the **old** way: a shortcut that creates a sequence and a default.
  It still works and you'll see it in older schemas, but identity columns are SQL-standard, tie
  the sequence cleanly to the column (permissions, `DROP`, copying the table) and can forbid
  manual ids. EF Core's Npgsql provider creates `GENERATED BY DEFAULT AS IDENTITY` columns for
  integer keys by default.

Under the hood an identity column uses a **sequence**: a counter that hands out the next number.
Two facts surprise people:

- **Gaps are normal.** A rolled-back insert or a failed upsert still consumed its number. Never
  use ids as "row count" or for invoice numbers that must be gapless.
- **Manual ids don't move the counter.** With `BY DEFAULT`, if you import rows with ids 1–100
  yourself, the sequence still starts at 1, and the next normal insert fails with *duplicate key
  value violates unique constraint*. After such an import, resync it:
  `ALTER TABLE notes ALTER COLUMN id RESTART WITH 101;`.

`DEFAULT` gives a column a value when the insert doesn't mention it: `DEFAULT now()`,
`DEFAULT false`, `DEFAULT 0`, `DEFAULT '{}'::jsonb`, `DEFAULT gen_random_uuid()`.

:::warn title="Our practice datasets break two of these rules"
You may have noticed that the shop and studio don't follow this lesson's advice:

- **Hand-picked `integer` ids.** Both datasets declare `id integer PRIMARY KEY` with no
  generation, and earlier challenges inserted explicit ids. That's a fixture convention: fixed ids
  make every expected result predictable. A real schema would use
  `bigint GENERATED ALWAYS AS IDENTITY` (or `BY DEFAULT`, if it must accept imported ids).
- **`shop.orders.ordered_at` is a `timestamp`.** That's the legacy smell lesson 3 warned about: it
  can't say which zone `10:12` was in. The studio uses `timestamptz` throughout. Once you know the
  zone the old values were written in (say UTC), the fix is a one-line migration:

  ```sql
  ALTER TABLE orders
    ALTER COLUMN ordered_at TYPE timestamptz USING ordered_at AT TIME ZONE 'UTC';
  ```

  It rewrites the whole table under an exclusive lock, so on a big production table you'd plan
  it like any other heavy migration (the Production PostgreSQL lesson).

Treat the datasets as the "inherited codebase" you'll meet at a job: readable, mostly sound, with
a few things you'd do differently today.
:::

:::sql id=db-07-sql1 db=empty xp=30
title: A tags table
Create a table `tags` with:
- `id` — `integer`, primary key
- `name` — `text`, required, and no two tags may have the same name

hint: `name text NOT NULL UNIQUE`

```sql starter
CREATE TABLE tags (
  id integer PRIMARY KEY,
  name text
);
```

```sql solution
CREATE TABLE tags (
  id   integer PRIMARY KEY,
  name text    NOT NULL UNIQUE
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
SELECT
  (SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable, ', ' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_name = 'tags') AS columns,
  pg_temp.ok($q$INSERT INTO tags (id, name) VALUES (1, 'sql')$q$)      AS good_row,
  pg_temp.ok($q$INSERT INTO tags (id, name) VALUES (2, 'sql')$q$)      AS duplicate_name,
  pg_temp.ok($q$INSERT INTO tags (id, name) VALUES (3, NULL)$q$)       AS null_name,
  pg_temp.ok($q$INSERT INTO tags (id, name) VALUES (1, 'react')$q$)    AS duplicate_id;
```
:::

:::sql id=db-07-sql2 db=empty xp=35
title: Auto-numbered notes
Create a table `notes` with:
- `id` — `bigint`, primary key, **always** generated by the database (identity)
- `body` — `text`, required
- `created_at` — `timestamptz`, required, defaulting to the current time

Inserting `INSERT INTO notes (body) VALUES ('hi')` must work; inserting an explicit `id` must be
rejected.

hint: `id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`
hint: `created_at timestamptz NOT NULL DEFAULT now()`

```sql starter
CREATE TABLE notes (
  id serial PRIMARY KEY,
  body text NOT NULL,
  created_at timestamp
);
```

```sql solution
CREATE TABLE notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO notes (body) VALUES ('hi')$q$)                  AS insert_without_id,
  pg_temp.ok($q$INSERT INTO notes (id, body) VALUES (99, 'manual id')$q$)   AS insert_with_id,
  pg_temp.ok($q$INSERT INTO notes (body) VALUES (NULL)$q$)                  AS null_body;
SELECT
  (SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable || ' ' || is_identity
                     || ' ' || coalesce(identity_generation, '-'), ', ' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_name = 'notes') AS columns,
  _r.*,
  (SELECT count(*) FROM notes WHERE created_at IS NOT NULL) AS rows_with_created_at
FROM _r;
```
:::

## Constraints: rules the database enforces

"Our API already validates prices, why also in the database?" Because the API is not the only
writer: there are admin scripts, migrations, a second service, a teammate in `psql` — and
concurrency. An app-level check like "SELECT to see if the email is taken, then INSERT" has a race
window where two requests both pass. A constraint is checked **inside the database, for every
write, atomically**. Validate in the app for friendly messages; constrain in the database for
guarantees.

| Constraint | Guarantees |
|---|---|
| `NOT NULL` | a value is always present |
| `UNIQUE` | no duplicates (NULLs don't collide with each other, unless `UNIQUE NULLS NOT DISTINCT`) |
| `PRIMARY KEY` | `UNIQUE` + `NOT NULL`, one per table |
| `CHECK (expr)` | the expression is never false for any row |
| `REFERENCES other(col)` | a foreign key: the referenced row exists |
| `DEFAULT expr` | not a constraint, but a value when none is given |

Give important constraints a **name** so errors are readable and you can drop them later:

```sql
CREATE TABLE products (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name   text          NOT NULL,
  price  numeric(10,2) NOT NULL CONSTRAINT price_not_negative CHECK (price >= 0),
  status text          NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'active', 'archived'))
);
```

`price_not_negative` is a named column constraint; the `status` CHECK gets an auto-generated name
(`products_status_check`). A CHECK can only look at **the row being written** — it can't query
other rows or tables ("at most 5 projects per free user" needs a trigger or app logic).

Your API receives the constraint name and a standard **SQLSTATE** code in the error. With EF
Core it arrives as a `DbUpdateException` whose `InnerException` is Npgsql's `PostgresException`,
with `.SqlState` and `.ConstraintName`:

| SQLSTATE | Meaning | Typical HTTP response |
|---|---|---|
| `23505` | unique_violation | 409 Conflict ("email already registered") |
| `23503` | foreign_key_violation | 400/409 ("customer does not exist" / "still has orders") |
| `23514` | check_violation | 400 Bad Request |
| `23502` | not_null_violation | 400 Bad Request |

(Npgsql also has constants for them: `PostgresErrorCodes.UniqueViolation`.)

:::sql id=db-07-sql3 db=empty xp=40
title: A product table that guards itself
Create `products` with:
- `id` — `integer`, primary key
- `name` — `text`, required
- `price` — exact decimal with **2 decimal places** (`numeric(10,2)`), required, never negative
- `stock` — `integer`, required, **default 0**, never negative

hint: `price numeric(10,2) NOT NULL CHECK (price >= 0)`
hint: `stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0)`

```sql starter
CREATE TABLE products (
  id integer PRIMARY KEY,
  name text NOT NULL,
  price real,
  stock integer
);
```

```sql solution
CREATE TABLE products (
  id    integer       PRIMARY KEY,
  name  text          NOT NULL,
  price numeric(10,2) NOT NULL CHECK (price >= 0),
  stock integer       NOT NULL DEFAULT 0 CHECK (stock >= 0)
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO products (id, name, price) VALUES (1, 'Mouse', 19.999)$q$) AS good_row,
  pg_temp.ok($q$INSERT INTO products (id, name, price) VALUES (2, 'Free', 0)$q$)       AS zero_price,
  pg_temp.ok($q$INSERT INTO products (id, name, price) VALUES (3, 'Bad', -1)$q$)       AS negative_price,
  pg_temp.ok($q$INSERT INTO products (id, name) VALUES (4, 'No price')$q$)             AS missing_price,
  pg_temp.ok($q$INSERT INTO products (id, name, price, stock) VALUES (5, 'X', 1, -3)$q$) AS negative_stock;
SELECT
  (SELECT string_agg(column_name || ' ' || data_type || coalesce('(' || numeric_precision || ',' || numeric_scale || ')', ''),
                     ', ' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_name = 'products' AND data_type = 'numeric') AS money_columns,
  _r.*,
  (SELECT string_agg(price::text || '/' || stock, ' ' ORDER BY id) FROM products) AS stored
FROM _r;
```
:::

## Foreign keys and ON DELETE

```sql
CREATE TABLE comments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id    bigint NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  body       text   NOT NULL
);
```

A **foreign key** says "the value in this column must exist in that column over there". Terms:
the table with `REFERENCES` is the **child** (`comments`), the referenced one is the **parent**
(`posts`). The parent column must be a primary key or have a `UNIQUE` constraint. A NULL in the
FK column is allowed (unless you add `NOT NULL`) and means "no parent" — that's how
`author_id` can be optional above.

The FK is checked on both sides: inserting a comment for a missing post fails, and so does
deleting a post that still has comments — unless you say what should happen instead. What happens
to children when the parent row is deleted?

| Option | Effect | Typical use |
|---|---|---|
| *(default)* `NO ACTION` / `RESTRICT` | the delete **fails** while children exist | orders → customers: never lose orders silently |
| `CASCADE` | children are deleted too | comments of a post, clips of a project, members of a project |
| `SET NULL` | the FK column becomes NULL | `author_id` when a user is deleted, keep the comment |
| `SET DEFAULT` | the FK column gets its default | rare |

(`NO ACTION` and `RESTRICT` differ only in timing: `NO ACTION` checks at the end of the
statement — or at commit, if the constraint is declared `DEFERRABLE` — while `RESTRICT` checks
immediately. For everyday use they behave the same.) There is also `ON UPDATE …` with the same
options, for when the parent's key changes — rarely needed, because ids are usually meaningless
numbers that never change (lesson 8 explains why).

Choose deliberately. `CASCADE` is convenient and dangerous: one `DELETE FROM projects WHERE id = 1`
can remove thousands of rows, and cascades chain (deleting a user could cascade to projects, which
cascade to clips…). The studio dataset cascades `clips` and `project_members` from `projects`
(they're meaningless without the project) but **not** `render_jobs` (billing history).

:::tip title="Index your foreign keys"
Postgres automatically indexes primary keys and unique constraints — but **not** foreign key
columns. Without an index on `comments.post_id`, every "comments of post 42" query and every
cascading delete scans the whole table. Add `CREATE INDEX ON comments (post_id);`.
:::

:::sql id=db-07-sql4 db=empty xp=40
title: Books cascade with their author
A table `authors(id, name)` exists. Create `books` with:
- `id` — `integer`, primary key
- `author_id` — `integer`, required, a foreign key to `authors(id)`; when an author is
  deleted, their books are **deleted too**
- `title` — `text`, required

hint: `author_id integer NOT NULL REFERENCES authors(id) ON DELETE CASCADE`

```sql setup
CREATE TABLE authors (id integer PRIMARY KEY, name text NOT NULL);
INSERT INTO authors (id, name) VALUES (1, 'Martin Kleppmann'), (2, 'Robert C. Martin');
```

```sql starter
CREATE TABLE books (
  id integer PRIMARY KEY,
  author_id integer NOT NULL,
  title text NOT NULL
);
```

```sql solution
CREATE TABLE books (
  id        integer PRIMARY KEY,
  author_id integer NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  title     text    NOT NULL
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO books (id, author_id, title) VALUES (1, 1, 'Designing Data-Intensive Applications')$q$) AS valid_book,
  pg_temp.ok($q$INSERT INTO books (id, author_id, title) VALUES (2, 2, 'Clean Code')$q$)                            AS second_book,
  pg_temp.ok($q$INSERT INTO books (id, author_id, title) VALUES (3, 99, 'Ghost Book')$q$)                           AS unknown_author,
  pg_temp.ok($q$DELETE FROM authors WHERE id = 1$q$)                                         AS delete_author;
SELECT _r.*, (SELECT string_agg(id::text, ',' ORDER BY id) FROM books) AS remaining_books FROM _r;
```
:::

:::quiz id=db-07-q2 xp=15
`orders.customer_id REFERENCES customers(id)` was declared **without** an `ON DELETE` option.
What happens on `DELETE FROM customers WHERE id = 1` if customer 1 has orders?
- [ ] The orders are deleted too
- [ ] The orders' `customer_id` becomes NULL
- [x] The DELETE fails with a foreign key violation
- [ ] The customer is deleted and the orders keep pointing at id 1
> The default (`NO ACTION`) refuses to create orphans. You must delete or reassign the orders first
> — or declare `ON DELETE CASCADE` / `SET NULL` if that's really the business rule. Cascading or
> nulling never happens unless you asked for it, and Postgres never leaves a dangling reference —
> that's the whole point of a foreign key.
:::

:::quiz id=db-07-q4 xp=15
A table has `email text UNIQUE` (nullable). How many rows with `email = NULL` can you insert?
- [ ] One — the second NULL is a duplicate
- [x] As many as you like — NULLs are not considered equal to each other
- [ ] None — UNIQUE implies NOT NULL
> In SQL, `NULL = NULL` is unknown, not true, so a plain UNIQUE constraint never sees two NULLs as
> duplicates. Only `PRIMARY KEY` implies NOT NULL. If you want "at most one NULL", declare
> `UNIQUE NULLS NOT DISTINCT` (Postgres 15+); if the value is required, add `NOT NULL`.
:::

## Junction tables and composite keys

A many-to-many table usually needs a **composite primary key** — it both identifies the row and
prevents duplicate links:

```sql
CREATE TABLE project_members (
  project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    integer NOT NULL REFERENCES users(id),
  role       text    NOT NULL CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);
```

The order of columns in a composite key matters for its index: the index on
`(project_id, user_id)` also speeds up "members of project 5" (it starts with `project_id`), but
**not** "projects of user 2". Add `CREATE INDEX ON project_members (user_id);` for the other
direction.

:::sql id=db-07-sql5 db=empty xp=45
title: Enrollments
Tables `students(id)` and `courses(id)` exist. Create the junction table `enrollments` with:
- `student_id` — `integer`, required, FK to `students(id)`, deleted along with the student
- `course_id` — `integer`, required, FK to `courses(id)` (default behaviour: block deleting a
  course that has enrollments)
- `grade` — `integer`, optional, but if present between `1` and `6` (inclusive)
- primary key on (`student_id`, `course_id`) so a student can't enroll twice

hint: `PRIMARY KEY (student_id, course_id)` goes after the column list.
hint: `CHECK (grade BETWEEN 1 AND 6)` — a CHECK passes when the expression is NULL, so optional values are fine.

```sql setup
CREATE TABLE students (id integer PRIMARY KEY, name text NOT NULL);
CREATE TABLE courses  (id integer PRIMARY KEY, title text NOT NULL);
INSERT INTO students VALUES (1, 'Ada'), (2, 'Linus');
INSERT INTO courses VALUES (10, 'SQL'), (20, 'React');
```

```sql starter
CREATE TABLE enrollments (
  student_id integer REFERENCES students(id),
  course_id integer REFERENCES courses(id),
  grade integer
);
```

```sql solution
CREATE TABLE enrollments (
  student_id integer NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  course_id  integer NOT NULL REFERENCES courses(id),
  grade      integer CHECK (grade BETWEEN 1 AND 6),
  PRIMARY KEY (student_id, course_id)
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO enrollments (student_id, course_id, grade) VALUES (1, 10, NULL)$q$) AS no_grade_yet,
  pg_temp.ok($q$INSERT INTO enrollments (student_id, course_id, grade) VALUES (2, 10, 2)$q$)    AS with_grade,
  pg_temp.ok($q$INSERT INTO enrollments (student_id, course_id, grade) VALUES (2, 20, 1)$q$)    AS second_course,
  pg_temp.ok($q$INSERT INTO enrollments (student_id, course_id, grade) VALUES (1, 10, 3)$q$)    AS enroll_twice,
  pg_temp.ok($q$INSERT INTO enrollments (student_id, course_id, grade) VALUES (1, 20, 7)$q$)    AS grade_7,
  pg_temp.ok($q$INSERT INTO enrollments (student_id, course_id, grade) VALUES (3, 10, 1)$q$)    AS unknown_student,
  pg_temp.ok($q$DELETE FROM courses WHERE id = 20$q$)            AS delete_used_course,
  pg_temp.ok($q$DELETE FROM students WHERE id = 2$q$)            AS delete_student;
SELECT _r.*, (SELECT count(*) FROM enrollments) AS enrollments_left FROM _r;
```
:::

## ALTER TABLE: changing a live schema

Schemas evolve. `ALTER TABLE` changes a table in place, keeping its data:

```sql
ALTER TABLE customers ADD COLUMN phone text;
ALTER TABLE customers ADD COLUMN vip boolean NOT NULL DEFAULT false;  -- existing rows get false
ALTER TABLE customers RENAME COLUMN phone TO phone_number;
ALTER TABLE customers ALTER COLUMN city SET NOT NULL;                 -- fails if any city is NULL
ALTER TABLE customers ALTER COLUMN city DROP NOT NULL;
ALTER TABLE products  ALTER COLUMN price TYPE numeric(12,2);
ALTER TABLE customers ADD CONSTRAINT email_has_at CHECK (email LIKE '%@%');
ALTER TABLE customers DROP CONSTRAINT email_has_at;
ALTER TABLE customers DROP COLUMN phone_number;
```

Adding a constraint makes Postgres **check every existing row** first. Adding NOT NULL to a
column that has NULLs fails with *column "city" … contains null values* — the classic migration
pattern is **backfill first, then constrain**: `UPDATE … SET col = … WHERE col IS NULL;` followed
by `ALTER … SET NOT NULL`. The same goes for `ADD UNIQUE` on a column with duplicates and
`ADD CHECK` with violating rows: clean up the data, then add the rule.

Changing a type with `ALTER COLUMN … TYPE` works when Postgres knows how to convert (`real` →
`numeric`, `integer` → `bigint`). If not (say `text` → `integer`), tell it how with
`USING`: `ALTER TABLE t ALTER COLUMN qty TYPE integer USING qty::integer;`.

:::sql id=db-07-sql6 db=empty xp=40
title: Plans for users
A `users(id, email)` table already holds data. Change it so that:
- there is a new column `plan` — `text`, required, defaulting to `'free'` for existing and new
  users, and only `'free'`, `'pro'` or `'team'` are allowed
- `email` becomes **unique**

hint: `ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team'));`
hint: `ALTER TABLE users ADD UNIQUE (email);`

```sql setup
CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL);
INSERT INTO users VALUES (1, 'mara@studio.dev'), (2, 'jonas@studio.dev');
```

```sql starter
ALTER TABLE users ADD COLUMN plan text;
```

```sql solution
ALTER TABLE users ADD COLUMN plan text NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free', 'pro', 'team'));
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO users (id, email) VALUES (3, 'ivy@studio.dev')$q$)              AS new_user,
  pg_temp.ok($q$INSERT INTO users (id, email, plan) VALUES (4, 'omar@studio.dev', 'pro')$q$) AS pro_user,
  pg_temp.ok($q$INSERT INTO users (id, email, plan) VALUES (5, 'x@studio.dev', 'gold')$q$)   AS gold_plan,
  pg_temp.ok($q$INSERT INTO users (id, email) VALUES (6, 'mara@studio.dev')$q$)              AS duplicate_email,
  pg_temp.ok($q$INSERT INTO users (id, email, plan) VALUES (7, 'y@studio.dev', NULL)$q$)     AS null_plan;
SELECT _r.*, (SELECT string_agg(id || ':' || plan, ' ' ORDER BY id) FROM users) AS plans FROM _r;
```
:::

:::sql id=db-07-sql7 db=shop xp=45
title: Backfill, then constrain
In the **shop**, every customer must have a `city` from now on. Noah Becker (id `10`) has none.
Set his city to `Unknown`, then make `customers.city` **NOT NULL**. The starter fails — why?

hint: `UPDATE customers SET city = 'Unknown' WHERE city IS NULL;`
hint: then `ALTER TABLE customers ALTER COLUMN city SET NOT NULL;`

```sql starter
ALTER TABLE customers ALTER COLUMN city SET NOT NULL;
```

```sql solution
UPDATE customers SET city = 'Unknown' WHERE city IS NULL;
ALTER TABLE customers ALTER COLUMN city SET NOT NULL;
```

```sql check
SELECT
  (SELECT is_nullable FROM information_schema.columns
    WHERE table_name = 'customers' AND column_name = 'city') AS city_nullable,
  (SELECT string_agg(id || ':' || city, ', ' ORDER BY id) FROM customers) AS cities;
```
:::

:::sql id=db-07-sql8 db=empty xp=40
title: Fix the money column
A previous developer stored invoice amounts as `real` (a float). Change `invoices.amount` to
`numeric(12,2)`, keeping the data. Then make the column reject negative amounts with a
constraint named `amount_not_negative`.

hint: `ALTER TABLE invoices ALTER COLUMN amount TYPE numeric(12,2);` (Postgres converts the values.)
hint: `ALTER TABLE invoices ADD CONSTRAINT amount_not_negative CHECK (amount >= 0);`

```sql setup
CREATE TABLE invoices (id integer PRIMARY KEY, amount real NOT NULL);
INSERT INTO invoices VALUES (1, 19.99), (2, 0.10), (3, 1250.50);
```

```sql starter
ALTER TABLE invoices ADD CONSTRAINT amount_not_negative CHECK (amount >= 0);
```

```sql solution
ALTER TABLE invoices ALTER COLUMN amount TYPE numeric(12,2);
ALTER TABLE invoices ADD CONSTRAINT amount_not_negative CHECK (amount >= 0);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO invoices VALUES (4, -5)$q$) AS negative_amount;
SELECT
  (SELECT data_type || '(' || numeric_precision || ',' || numeric_scale || ')'
     FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'amount') AS amount_type,
  (SELECT count(*) FROM pg_constraint WHERE conname = 'amount_not_negative') AS named_constraint,
  _r.negative_amount,
  (SELECT sum(amount)::text FROM invoices) AS total
FROM _r;
```
:::

## Generated columns: computed by the database

Some columns are pure functions of other columns in the same row — a line total, a lower-cased
email for lookups. Storing them by hand invites drift (someone updates `qty` and forgets
`line_total`). A **generated column** is computed by Postgres and can't be written directly:

```sql
CREATE TABLE order_lines (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quantity    integer       NOT NULL CHECK (quantity > 0),
  unit_price  numeric(10,2) NOT NULL,
  line_total  numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price) VIRTUAL
);
```

- `VIRTUAL` computes the value when you read it (no storage). It's the **default in Postgres 18**
  if you write neither keyword.
- `STORED` computes it on write and saves it on disk — needed if you want to index it (in
  Postgres 18 only stored generated columns can be indexed).
- The expression may only use columns of the same row and *immutable* functions — no `now()`, no
  subqueries. Inserting a value into `line_total` yourself is an error.

Don't confuse this with `GENERATED … AS IDENTITY`: identity hands out *new* numbers, a generated
column *derives* a value from the row.

:::sql id=db-07-sql10 db=empty xp=40
title: Line totals that can't drift
Create `order_lines` with:
- `id` — `integer`, primary key
- `quantity` — `integer`, required, greater than 0
- `unit_price` — `numeric(10,2)`, required
- `line_total` — `numeric(12,2)`, a **generated** column always equal to `quantity * unit_price`
  (virtual or stored, your choice)

Writing `line_total` directly must be rejected.

hint: `line_total numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price)`
hint: The starter's plain column accepts any value — that's the bug.

```sql starter
CREATE TABLE order_lines (
  id integer PRIMARY KEY,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL,
  line_total numeric(12,2)
);
```

```sql solution
CREATE TABLE order_lines (
  id         integer       PRIMARY KEY,
  quantity   integer       NOT NULL CHECK (quantity > 0),
  unit_price numeric(10,2) NOT NULL,
  line_total numeric(12,2) GENERATED ALWAYS AS (quantity * unit_price) VIRTUAL
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO order_lines (id, quantity, unit_price) VALUES (1, 3, 9.99)$q$)                 AS normal_insert,
  pg_temp.ok($q$INSERT INTO order_lines (id, quantity, unit_price, line_total) VALUES (2, 1, 5, 999)$q$)  AS write_total,
  pg_temp.ok($q$INSERT INTO order_lines (id, quantity, unit_price) VALUES (3, 0, 5)$q$)                   AS zero_quantity,
  pg_temp.ok($q$UPDATE order_lines SET quantity = 4 WHERE id = 1$q$)                                      AS change_quantity;
SELECT
  (SELECT is_generated FROM information_schema.columns
    WHERE table_name = 'order_lines' AND column_name = 'line_total') AS generated,
  _r.*,
  (SELECT string_agg(id || ':' || line_total, ' ' ORDER BY id) FROM order_lines) AS totals
FROM _r;
```
:::

## DROP

```sql
DROP TABLE tags;                  -- error if it doesn't exist
DROP TABLE IF EXISTS tags;        -- no error
DROP TABLE categories CASCADE;    -- also drops dependent views and the FK *constraints* on other tables
```

Note what `CASCADE` means here: `products` keeps its rows and its `category_id` column, but loses
the foreign key that pointed at `categories` — so nothing protects that column any more. Without
`CASCADE`, Postgres refuses and lists the dependent objects, which is usually what you want to
read first.

`DROP TABLE` deletes the table **and all its data**, instantly, with no undo outside a
transaction. In Postgres, DDL is **transactional** — `BEGIN; DROP TABLE x; ROLLBACK;` really
brings it back, which is wonderful for migrations (MySQL and Oracle can't do this).

:::sql id=db-07-sql9 db=empty xp=45
title: A modern events table
Create an `events` table for an audit log:
- `id` — `uuid`, primary key, defaulting to a random UUID (`gen_random_uuid()`)
- `name` — `text`, required
- `payload` — `jsonb`, required, defaulting to an empty object `'{}'`
- `processed` — `boolean`, required, default `false`
- `occurred_at` — `timestamptz`, required, default `now()`

After your DDL, `INSERT INTO events (name) VALUES ('signup')` must work.

hint: `payload jsonb NOT NULL DEFAULT '{}'::jsonb`
hint: `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`

```sql starter
CREATE TABLE events (
  id text PRIMARY KEY,
  name text NOT NULL,
  payload json,
  processed text,
  occurred_at timestamp
);
```

```sql solution
CREATE TABLE events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  processed   boolean     NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
```

```sql check
CREATE FUNCTION pg_temp.ok(q text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN EXECUTE q; RETURN true; EXCEPTION WHEN others THEN RETURN false; END $$;
CREATE TEMP TABLE _r AS SELECT
  pg_temp.ok($q$INSERT INTO events (name) VALUES ('signup')$q$)               AS minimal_insert,
  pg_temp.ok($q$INSERT INTO events (name, processed) VALUES ('x', NULL)$q$)   AS null_processed;
SELECT
  (SELECT string_agg(column_name || ' ' || data_type || ' ' || is_nullable, ', ' ORDER BY ordinal_position)
     FROM information_schema.columns WHERE table_name = 'events') AS columns,
  _r.*,
  (SELECT string_agg(name || ' ' || payload::text || ' ' || processed, '; ') FROM events) AS stored
FROM _r;
```
:::

:::quiz id=db-07-q3 xp=10
`CHECK (grade BETWEEN 1 AND 6)` is on a nullable column. What happens when you insert a row with
`grade = NULL`?
- [x] It's accepted — a CHECK only rejects rows where the expression is **false**
- [ ] It's rejected because NULL is not between 1 and 6
- [ ] It's stored as 1
> `NULL BETWEEN 1 AND 6` is unknown, and CHECK constraints only fail on false. The tempting
> answer "rejected" applies SQL's `WHERE` logic (which drops unknown rows) — CHECK deliberately
> does the opposite so optional columns work. Nothing is ever replaced by a default value. If the
> value must be present, add `NOT NULL` as well.
:::

:::quiz id=db-07-q5 xp=15
`notes.id` is `GENERATED BY DEFAULT AS IDENTITY`. A data import inserted rows with explicit ids
1–50. What happens on the next `INSERT INTO notes (body) VALUES ('new')`?
- [ ] It gets id 51 — Postgres continues after the highest id
- [x] It fails with a duplicate-key error, because the sequence still hands out 1
- [ ] It fails because `BY DEFAULT` forbids omitting the id
- [ ] It gets a random free id
> The sequence behind an identity column only advances when *it* generates a value; explicit ids
> bypass it. So it hands out 1, which already exists. Postgres never looks at `max(id)` — that would
> be slow and racy. Fix it after imports with `ALTER TABLE notes ALTER COLUMN id RESTART WITH 51;`
> (or use `GENERATED ALWAYS` so manual ids aren't possible by accident).
:::

:::quiz id=db-07-q6 xp=15
Spot the problem. A developer wants "at most 3 projects per free user" and writes:

```sql
ALTER TABLE projects ADD CONSTRAINT max_three
  CHECK ((SELECT count(*) FROM projects p WHERE p.owner_id = owner_id) <= 3);
```

- [ ] It works, but only for new rows
- [x] Postgres rejects it: a CHECK can't contain a subquery or look at other rows
- [ ] It works, but needs `NOT VALID`
- [ ] It needs a `UNIQUE` constraint on `owner_id` first
> A CHECK constraint sees only the row being written (the error is *cannot use subquery in check
> constraint*). Rules across rows or tables need a trigger, an app-level check inside a transaction,
> or a different design (e.g. a counter column with its own CHECK). `NOT VALID` only skips checking
> *existing* rows — it doesn't make subqueries legal.
:::

:::pro title="Migrations, not hand-typed DDL"
Real teams never type `ALTER TABLE` into production. Schema changes live in version-controlled
**migrations** (EF Core migrations, Flyway, Liquibase, sqitch, or plain numbered `.sql` files)
that run in CI and on deploy. On big tables, mind the locks: most `ALTER TABLE` forms take a lock
that blocks reads and writes while they run. Adding a column with a constant default is instant
(Postgres 11+), but changing a column's type usually rewrites the whole table, and adding a
constraint scans every row. Seniors split risky changes into small steps: add the column nullable
→ backfill in batches → add the constraint as `NOT VALID` (enforced for new rows only, instant) →
`ALTER TABLE … VALIDATE CONSTRAINT …` (checks old rows without blocking writes). Since Postgres 18
this works for NOT NULL too: `ALTER TABLE customers ADD CONSTRAINT city_nn NOT NULL city NOT VALID;`.
:::

:::job title="Naming constraints pays off"
When an insert fails, your logs say `violates check constraint "price_not_negative"` instead of
`"products_price_check1"`. Teams with good constraint names map them straight to API error codes.
:::

:::cards id=db-07-cards1 xp=15 title="DDL & constraints"
Q: Type for money?
A: `numeric(p,s)` (exact) — or integer cents in a `bigint`. Never float.
Q: `text` vs `varchar(n)` in Postgres?
A: Same performance; use `text` unless the length limit is a real rule.
Q: Type for "when it happened"?
A: `timestamptz` — an absolute instant.
Q: Modern auto-increment id?
A: `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` (serial is the legacy way).
Q: Does a CHECK reject NULL?
A: No — CHECK fails only on false. Add NOT NULL if required.
Q: ON DELETE options?
A: NO ACTION/RESTRICT (block, default), CASCADE (delete children), SET NULL, SET DEFAULT.
Q: Are FK columns indexed automatically?
A: No — only PK and UNIQUE get indexes. Index FK columns yourself.
Q: Add NOT NULL to a column with NULLs?
A: Backfill the NULLs with UPDATE first, then `ALTER COLUMN … SET NOT NULL`.
Q: Is DDL transactional in Postgres?
A: Yes — CREATE/ALTER/DROP can be rolled back.
Q: UNIQUE on a nullable column — can there be several NULLs?
A: Yes, NULLs don't collide. Use `UNIQUE NULLS NOT DISTINCT` (PG 15+) to allow only one.
Q: Can a CHECK constraint look at other rows or tables?
A: No — only the row being written. Use a trigger or app logic for cross-row rules.
Q: Generated column vs identity column?
A: Generated derives a value from the row (`GENERATED ALWAYS AS (expr)`, virtual by default in PG 18); identity hands out new numbers.
Q: SQLSTATE for a unique violation?
A: `23505` (FK: `23503`, CHECK: `23514`, NOT NULL: `23502`).
:::

## Recap

- Pick types deliberately: `bigint` ids, `numeric` for money, `text`, `timestamptz` for instants,
  `boolean`, `uuid`, `jsonb`.
- Use identity columns (`GENERATED ALWAYS AS IDENTITY`) instead of `serial`; `DEFAULT` for
  sensible values.
- Constraints — `NOT NULL`, `UNIQUE`, `PRIMARY KEY`, `CHECK`, `REFERENCES … ON DELETE …` — make
  invalid data impossible. Name the important ones; index FK columns; map SQLSTATE codes to API
  errors.
- Generated columns compute values from the row so they can't drift.
- `ALTER TABLE` evolves a schema in place (backfill, then constrain); `DROP` removes it — and in
  Postgres both are transactional.
