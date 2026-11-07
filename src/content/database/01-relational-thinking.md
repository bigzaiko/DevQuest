---
id: db-01
title: Thinking in Tables
level: beginner
minutes: 65
xp: 100
summary: Tables, rows, keys and relationships — how a relational database models the world, how your app talks to PostgreSQL, and a tour of the shop and studio databases.
---

Almost every product you will work on — a web shop, a SaaS dashboard, a banking app — keeps its
important data in a **relational database**. The frontend shows data, the backend applies rules,
but the database is where the truth lives. If the database is wrong, everything above it is wrong.

This lesson builds the mental model you need before writing serious SQL: what a table really is,
what keys are for, how tables relate to each other, and how your C# or Node backend actually
talks to PostgreSQL. Then we tour the two practice databases this track uses: the **shop** and
the **studio**.

:::tip title="Never written SQL before?"
Start with the **SQL Syntax Primer** (the first lesson of this region). It covers the grammar
this lesson takes for granted: statements and semicolons, the single-quote vs double-quote rule,
`NULL`, comments, and how to read a PostgreSQL error message. Then come back here.
:::

## Tables, rows and columns

A **table** stores one kind of thing: customers, products, orders. Think of a spreadsheet with
strict rules:

- Every **column** has a name and a **type** (`integer`, `text`, `date`, `numeric` …). Postgres
  refuses a value that doesn't fit: you can't put `'hello'` in an `integer` column.
- Every **row** is one instance of the thing: one customer, one product.
- Rows have **no inherent order**. If you want them sorted, you must ask (`ORDER BY`). This
  surprises people coming from spreadsheets — a table is a *set* of rows, not a list.

Here is the `customers` table from the shop dataset (first few rows):

| id | name | email | country | city | created_at |
|---|---|---|---|---|---|
| 1 | Ada Lovelace | ada@example.com | UK | London | 2024-01-15 |
| 2 | Linus Torvalds | linus@example.com | Finland | Helsinki | 2024-02-03 |
| 3 | Grace Hopper | grace@example.com | USA | New York | 2024-02-20 |
| … | | | | | |
| 10 | Noah Becker | noah@example.com | Germany | *NULL* | 2024-11-30 |

Notice Noah's `city`: it is **NULL** — "unknown / not provided". NULL is not an empty string and
not zero; it's the absence of a value. It has its own (sometimes surprising) rules that we'll
study in the **Expressions, Functions & NULL** lesson.

The table was created with DDL (data definition language) like this:

```sql
CREATE TABLE customers (
  id          integer PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  country     text        NOT NULL,
  city        text,                 -- nullable: may be NULL
  created_at  date        NOT NULL
);
```

Each line is a promise the database enforces for you: `NOT NULL` (a value is required),
`UNIQUE` (no two customers share an email), `PRIMARY KEY` (more on that next). The shop's
`products` table adds a fourth kind, **`CHECK`**, which accepts a row only if a condition holds:
`price numeric(10,2) NOT NULL CHECK (price >= 0)` makes a negative price impossible. These rules
are called **constraints**, and they are the reason a database is more than a file of JSON: a
JSON file accepts anything you write into it; a constrained table rejects the bad write with an
error, *before* the bad data exists.

## Primary keys: how to point at exactly one row

A **primary key (PK)** is a column (or set of columns) whose value identifies exactly one row.
It is automatically `NOT NULL` and `UNIQUE`, and Postgres automatically builds an **index** for
it — a sorted lookup structure, like the index at the back of a book, so finding "customer 3" is
instant instead of scanning every row. In `customers`, `id` is the primary key — customer `3` is
Grace Hopper, forever.

Why does every table need one? Because without a reliable way to say "*this* row", you can't
safely update or delete one row, and other tables can't point at it.

Why not use the email or the name?

- Names are not unique (two "Maria Garcia"s will sign up).
- Emails change. If other tables pointed to customers by email, a change would have to ripple
  through the entire database.
- A short integer (or a UUID) is cheap to index and compare.

A key with no business meaning, like an auto-generated `id`, is called a **surrogate key**. A key
made of real-world data (an ISBN, a country code) is a **natural key**. Most application tables
use surrogate keys and add a `UNIQUE` constraint on the natural identifier (like `email`).

The practice datasets (shop and studio) insert their ids by hand, and so do some challenges
(the **INSERT, UPDATE, DELETE & Upserts** lesson adds ledger rows with ids `15` and `16`). That's deliberate: fixed ids keep results
predictable, so the grader can compare your answer row by row. In a real application you
almost never pick ids yourself — you let the database generate them:

```sql
CREATE TABLE customers (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- 1, 2, 3 … generated by Postgres
  email text NOT NULL UNIQUE
  -- …
);
-- or a UUID surrogate key; PostgreSQL 18 has a built-in, time-ordered uuidv7():
--   id uuid PRIMARY KEY DEFAULT uuidv7()
```

You'll still see the older `serial` in many codebases; it does the same job. The **Tables, Types & Constraints** lesson compares
the options.

Some tables use a **composite primary key** — several columns together. `order_items` has
`PRIMARY KEY (order_id, product_id)`: a product can appear in many orders and an order has many
products, but each *pair* appears only once.

## Foreign keys: how tables point at each other

A **foreign key (FK)** is a column that stores the primary key of a row in *another* (or the
same) table:

```sql
CREATE TABLE orders (
  id           integer PRIMARY KEY,
  customer_id  integer NOT NULL REFERENCES customers(id),
  status       text    NOT NULL,
  ordered_at   timestamp NOT NULL   -- legacy smell: should be timestamptz (see "Expressions, Functions & NULL")
);
```

`customer_id REFERENCES customers(id)` means: every order's `customer_id` must match an existing
customer. Try to insert an order for customer `999` and Postgres rejects it:

```text
ERROR:  insert or update on table "orders" violates foreign key constraint "orders_customer_id_fkey"
DETAIL:  Key (customer_id)=(999) is not present in table "customers".
```
 Try to delete a customer who still has orders and Postgres rejects that
too (unless you declared `ON DELETE CASCADE` or similar — the **Tables, Types & Constraints** lesson). This is called
**referential integrity**: no dangling pointers, ever.

Note the direction: the FK lives on the side that *points*. An order points at its customer,
so `orders` has `customer_id`; `customers` has no list of order ids. "Which orders does Ada
have?" is answered by searching `orders` for `customer_id = 1`.

:::info title="The database is the last line of defence"
Your API validates input, your frontend validates forms — but bugs, scripts, migrations and
second services will all write to the same database one day. Constraints in the database hold
no matter who writes. Validate in the app *for good error messages*, constrain in the database
*for correctness*.
:::

## Relationships: 1:1, 1:N and N:M

Keys let us describe how things relate. There are three shapes:

**One-to-many (1:N)** — the most common. One customer has many orders; each order belongs to
one customer. Modeled with a foreign key on the "many" side (`orders.customer_id`). Likewise
one category has many products (`products.category_id`).

**Many-to-many (N:M)** — an order contains many products, and a product appears in many
orders. You **cannot** model this with one foreign key. You need a third table — a **junction
table** (also called join table, link table, associative table) — with a foreign key to each
side. In the shop that table is `order_items`, and it even carries its own data: `quantity` and
`unit_price` (the price *at the time of the order*, which may differ from today's price).

```text
customers 1 ──── N orders 1 ──── N order_items N ──── 1 products N ──── 1 categories
```

**One-to-one (1:1)** — one row on each side, at most. Example: `users` and `user_settings`, or a
`customers` row and a `customer_tax_details` row. Modeled with a foreign key that is *also*
`UNIQUE` (often the FK *is* the primary key of the second table). Use it to split rarely-used or
sensitive columns into their own table. It's the rarest shape.

There's also a **self-referencing** relationship: `employees.manager_id REFERENCES employees(id)`.
Each employee points to another employee — that's how an org chart (a tree) is stored. The
studio dataset uses the same trick for branching video clips (`clips.parent_clip_id`).

:::quiz id=db-01-q1 xp=10
In the shop, one product can be in many orders and one order can contain many products. How is
that modeled?
- [ ] A `product_id` column on `orders`
- [ ] An `order_id` column on `products`
- [x] A junction table (`order_items`) with a foreign key to each side
- [ ] A text column on `orders` listing product ids, like `"1,3,7"`
> Many-to-many always needs a third table. A `product_id` on `orders` (or an `order_id` on
> `products`) holds only one value, so it can model one side of the relationship but never both —
> an order could contain only one product. The comma-separated list is the tempting hack: it
> "works" until you need to join on it, index it, or stop someone storing `"1,3,banana"` — no
> foreign key can protect the values inside a string.
:::

:::quiz id=db-01-q2 xp=10
Which statements about a **primary key** are true? (select all that apply)
- [x] It uniquely identifies a row
- [x] It can never be NULL
- [ ] It must be a single column
- [ ] It defines the order rows are returned in
> A PK is unique and NOT NULL. It can span several columns (`order_items` uses
> `(order_id, product_id)`). The tempting wrong answer is the last one: results *often* come back in
> PK order on a small table, but that's an accident of how the data was stored and how the query
> ran. Row order is never guaranteed without `ORDER BY` — not even by the PK.
:::

:::quiz id=db-01-q5 xp=10
`orders.customer_id` is declared `REFERENCES customers(id)`, with no `ON DELETE` option. What
happens when you run `DELETE FROM customers WHERE id = 1` while Ada still has orders?
- [ ] Ada is deleted and her orders are deleted with her
- [ ] Ada is deleted and her orders' `customer_id` becomes NULL
- [x] The DELETE fails with a foreign key violation; nothing is deleted
- [ ] Ada is deleted and her orders keep `customer_id = 1`
> The default behavior (`NO ACTION`) refuses any change that would leave an order pointing at a
> customer that no longer exists. Deleting the orders too is what `ON DELETE CASCADE` would do and
> setting NULL is `ON DELETE SET NULL` — both must be declared explicitly (and `SET NULL` would
> fail here anyway, because `customer_id` is `NOT NULL`). Keeping a dangling `1` is exactly what
> referential integrity exists to prevent.
:::

:::quiz id=db-01-q6 xp=10
Where does the foreign key go in a one-to-many relationship such as "one category has many
products"?
- [x] On the "many" side: `products.category_id`
- [ ] On the "one" side: `categories.product_ids`
- [ ] In a junction table `category_products`
- [ ] On both tables, pointing at each other
> Each product belongs to exactly one category, so each product row can store that one value.
> A `product_ids` column on `categories` would need to hold a list — the same anti-pattern as the
> comma-separated string. A junction table is the tool for *many-to-many*; using it here would
> allow a product in several categories, which the model doesn't want.
:::

## Why PostgreSQL?

There are many relational databases (SQL Server, MySQL/MariaDB, Oracle, SQLite). PostgreSQL has
become the default choice for new projects because it is:

- **Free and open source**, with no "enterprise edition" paywall for core features.
- **Standards-compliant and strict** — it rejects bad data instead of silently guessing.
- **Feature-rich** — `jsonb` for document data, arrays, full-text search, window functions,
  CTEs, partial indexes, row-level security, `LISTEN/NOTIFY`, extensions like PostGIS and pgvector.
- **Everywhere** — every cloud has a managed version (AWS RDS/Aurora, Azure Database for
  PostgreSQL, Google Cloud SQL, Neon, Supabase), and it runs in a container in seconds.

The SQL you learn here is ~90% portable. We'll point out the Postgres-specific parts
(`ILIKE`, `::` casts, `RETURNING`, `ON CONFLICT`, `jsonb`) as we meet them.

:::tip title="This track runs real Postgres"
Every SQL challenge here runs on **PostgreSQL 18** compiled to WebAssembly (PGlite), right in
your browser. Each run starts from a fresh copy of the dataset, so you can't break anything —
experiment freely, even with `DELETE`.
:::

## How an application talks to the database

Your backend doesn't open the database file. PostgreSQL is a **server** process (default port
`5432`). Your app is a **client**:

1. A **driver** speaks the Postgres wire protocol: `Npgsql` in .NET, `pg` / `postgres` in
   Node.js, `psycopg` in Python. You give it a **connection string**:
   `Host=localhost;Port=5432;Database=shop;Username=app;Password=…`
   (or a URL: `postgres://app:…@localhost:5432/shop`).
2. Opening a connection is expensive (TCP + TLS + authentication + a backend process on the
   server). So drivers keep a **connection pool**: a set of open connections that requests borrow
   and return. Npgsql pools by default; in Node you create a `Pool`. In production you often add
   **PgBouncer** in front of Postgres so hundreds of app instances share a few connections.
3. You send SQL **with parameters**, never by gluing strings together:

```ts
// Node.js with 'pg' — $1 is a parameter, sent separately from the SQL text
const { rows } = await pool.query(
  'SELECT id, name FROM customers WHERE country = $1',
  [country],
)
```

```csharp
// C# with Npgsql (Dapper and EF Core sit on top of it).
// Once, at startup: the data source owns the pool and lives for the whole app.
// In ASP.NET Core: builder.Services.AddNpgsqlDataSource(connectionString);
// Don't put `using` on it or create it per request, or you rebuild the pool every call.
var dataSource = NpgsqlDataSource.Create(connectionString);

// Per request: short-lived command/reader; the connection goes back to the pool.
await using var cmd = dataSource.CreateCommand(
    "SELECT id, name FROM customers WHERE country = $1");
cmd.Parameters.AddWithValue(country);                 // positional parameter $1
await using var reader = await cmd.ExecuteReaderAsync();
while (await reader.ReadAsync())
    Console.WriteLine($"{reader.GetInt32(0)} {reader.GetString(1)}");
```

Why do parameters matter so much? With string concatenation, the user's input becomes part of
the SQL *text*, so the database can't tell your code from their input. Parameters are sent to
the server **separately** from the SQL text, so the server parses the query first and only then
plugs in the value. If `country` contains `'; DROP TABLE customers; --`, it is just a strange
country name that matches no rows — it is never executed. That attack is called **SQL
injection**.

:::warn title="Never build SQL with string concatenation"
`"... WHERE name = '" + input + "'"` is the classic SQL-injection hole and still one of the most
common security bugs. Always use parameters (`$1`, `@name`) or an ORM that does it for you.
:::

### ORM or plain SQL?

An **ORM** (Object-Relational Mapper) such as **Entity Framework Core** (.NET), Prisma or
Drizzle (TypeScript) maps tables to classes and writes SQL for you:

```csharp
var germans = await db.Customers.Where(c => c.Country == "Germany").ToListAsync();
```

- **ORM pros:** less boilerplate, type safety, migrations, change tracking. Great for CRUD.
- **ORM cons:** it's easy to generate slow queries (the famous *N+1 problem*), and complex
  reports are awkward to express.
- **Plain SQL / micro-ORM (Dapper, `pg`):** full control and performance, more code to write.

Real teams usually mix: an ORM for everyday CRUD, hand-written SQL for reports and hot paths.
Either way **you must understand SQL** — when the ORM's query is slow, you read the SQL it
generated and fix it.

:::job title="What you'll meet on day one"
Expect a `docker compose up` that starts Postgres locally, a migrations folder (EF Core
migrations, Flyway, or plain `.sql` files), and a GUI like **DBeaver**, **DataGrip**, **pgAdmin**
or the VS Code / Rider database tools. You will also be expected to get around in `psql`.
:::

## psql in two minutes

`psql` is Postgres's command-line client. It's on every server and in every Postgres container:

```bash
docker run --name pg -e POSTGRES_PASSWORD=dev -p 5432:5432 -d postgres:18
docker exec -it pg psql -U postgres
```

Inside `psql`, SQL statements end with `;`. Backslash commands are psql's own helpers:

| Command | What it does |
|---|---|
| `\l` | list databases |
| `\c shop` | connect to database `shop` |
| `\dt` | list tables |
| `\d customers` | describe a table: columns, types, keys, indexes |
| `\x` | toggle expanded display (one column per line — great for wide rows) |
| `\timing` | show how long each query takes |
| `\q` | quit |

## A tour of the shop database

The shop has six tables:

- `customers` — 10 customers in five countries (one has no city).
- `categories` — Keyboards, Mice, Monitors, Books, Accessories.
- `products` — 12 products, each in one category (`category_id`), with `price`, `stock` and an
  `active` flag.
- `orders` — 18 orders; each has a `customer_id`, a `status` (`pending`, `paid`, `shipped`,
  `cancelled`) and an `ordered_at` timestamp. That column is a plain `timestamp` (no time zone),
  which is a **legacy smell** we kept on purpose: you'll meet it in real codebases, the **Expressions, Functions & NULL** lesson
  shows what goes wrong with it and the **Tables, Types & Constraints** lesson shows how to migrate it to `timestamptz`.
- `order_items` — the lines of each order: `order_id`, `product_id`, `quantity`, `unit_price`.
- `employees` — the shop's staff, with `manager_id` pointing at another employee.

The simplest query reads columns from one table:

```sql
SELECT name, price FROM products;
```

`SELECT` lists the columns you want, `FROM` names the table. `SELECT *` means "all columns" —
handy for exploring, but in application code list the columns explicitly so a new column doesn't
silently change your result. To narrow down rows, add `WHERE`:

```sql
SELECT name, price FROM products WHERE category_id = 4;
-- Clean Code 32.00, Designing Data-Intensive Applications 45.00, The Pragmatic Programmer 38.50
```

Your turn. Each challenge tells you exactly which columns to return — the grader compares values
row by row.

:::sql id=db-01-sql1 db=shop xp=15
title: Meet the categories
Return the `id` and `name` of every category.

hint: `SELECT id, name FROM …`

```sql starter
SELECT name FROM categories;
```

```sql solution
SELECT id, name FROM categories;
```
:::

:::sql id=db-01-sql2 db=shop xp=20
title: Contact list
Return `name` and `email` of every customer.

hint: Two columns, separated by a comma, from the `customers` table.

```sql starter
SELECT * FROM customers;
```

```sql solution
SELECT name, email FROM customers;
```
:::

:::sql id=db-01-sql3 db=shop xp=20
title: Follow a foreign key
Monitors have category id `3`. Return `name`, `price` and `stock` of every product whose
`category_id` is 3.

hint: `WHERE category_id = 3`

```sql starter
SELECT name, price, stock FROM products;
```

```sql solution
SELECT name, price, stock FROM products WHERE category_id = 3;
```
:::

:::sql id=db-01-sql4 db=shop xp=25
title: One customer, many orders
Ada Lovelace is customer `1`. Return the `id`, `status` and `ordered_at` of all her orders.
This is the "many" side of the customers → orders relationship.

hint: The foreign key column on `orders` is `customer_id`.

```sql starter
SELECT id, status, ordered_at FROM orders WHERE id = 1;
```

```sql solution
SELECT id, status, ordered_at FROM orders WHERE customer_id = 1;
```
:::

:::sql id=db-01-sql5 db=shop xp=25
title: The lines of an order
Order `6` contains several products. Using the junction table, return `product_id`, `quantity`
and `unit_price` for every line of order 6.

hint: The junction table is `order_items`.

```sql starter
SELECT product_id, quantity, unit_price FROM order_items;
```

```sql solution
SELECT product_id, quantity, unit_price FROM order_items WHERE order_id = 6;
```
:::

Ids are useful, but humans want names. A **join** follows the foreign key and glues matching
rows from two tables together. We'll study joins properly in the **JOINs** lesson — here's a preview:

```sql
SELECT p.name, oi.quantity
FROM order_items oi
JOIN products p ON p.id = oi.product_id   -- follow the FK to products
WHERE oi.order_id = 6;
-- Mechanical Keyboard 2, Gaming Mouse 1
```

:::sql id=db-01-sql6 db=shop xp=30
title: Preview — names instead of ids
Return each product's `name` together with its **category name**, as two columns: product name,
category name. The starter already has the join; fix the column list.

hint: Use the aliases: `p.name` is the product, `c.name` is the category.

```sql starter
SELECT p.name, p.category_id
FROM products p
JOIN categories c ON c.id = p.category_id;
```

```sql solution
SELECT p.name, c.name
FROM products p
JOIN categories c ON c.id = p.category_id;
```
:::

:::sql id=db-01-sql7 db=shop xp=30
title: A table that points at itself
Tom Tech (employee `2`) is the CTO. Return the `name` and `title` of every employee who reports
directly to him — i.e. whose `manager_id` is 2.

hint: `manager_id` is a foreign key into the same `employees` table.

```sql starter
SELECT name, title FROM employees WHERE id = 2;
```

```sql solution
SELECT name, title FROM employees WHERE manager_id = 2;
```
:::

:::quiz id=db-01-q3 xp=10
Why do applications use a **connection pool**?
- [ ] To run several SQL statements in one network round-trip
- [x] Opening a connection is expensive, so open connections are reused across requests
- [ ] To encrypt traffic between the app and the database
- [ ] To cache query results in memory
> A new Postgres connection costs a TCP/TLS handshake, authentication and a new server-side
> process. A pool keeps connections open and lends them out, so each request skips that cost.
> A pool doesn't batch statements, encrypt anything (TLS does that) or cache results — the query
> still runs on the server every time.
:::

:::quiz id=db-01-q4 xp=10
Your API runs `"SELECT * FROM users WHERE email = '" + email + "'"`. What's the main problem?
- [ ] `SELECT *` is slower than listing columns
- [x] It's open to SQL injection — use a parameter (`$1`) instead
- [ ] Emails must be compared with `LIKE`
- [ ] Nothing, as long as the frontend validates the email
> Concatenating input into SQL lets an attacker change the query itself (try the email
> `x' OR '1'='1`). Parameters send the value separately, so it can never be interpreted as SQL.
> "The frontend validates it" is the tempting wrong answer: anyone can call your API directly with
> `curl`, skipping the frontend entirely. `SELECT *` is a style issue, not the main problem.
:::

:::pro title="Read the SQL your ORM writes"
Turn on SQL logging in development (EF Core: `LogTo(Console.WriteLine)` or the
`Microsoft.EntityFrameworkCore.Database.Command` log category; Prisma: `log: ['query']`). Seniors
catch N+1 queries and accidental full-table loads by *looking* at the generated SQL during
code review, not after production slows down.
:::

## A tour of the studio database

Some challenges — one just below, and many from the **Expressions, Functions & NULL** lesson on — use a second dataset, the
**studio** (the editor shows `db: studio`). It's a small SaaS for **interactive, branching videos** — think "choose your own
adventure" films — and it looks much more like the product you'll work on at a job than the shop
does: users, permissions, background jobs and billing. The **Data Modeling** lesson explains *why* it's designed this
way; for now, just learn your way around.

```text
users 1 ──── N projects 1 ──── N clips (each clip → its parent clip: a tree)
  │               │  1
  │               ├──── N render_jobs
  │               N
  └── N:M ── project_members (role)
users 1 ──── N credit_ledger
```

- `users` — 6 accounts (Mara, Jonas, Ivy, Omar, Lena, Kai), each on a `plan`: `free`, `pro` or
  `team` (a `CHECK` constraint allows only those three).
- `projects` — 6 video projects. `owner_id` points at the user who owns it; `published` is a
  boolean; `version` counts saves; `doc` is a `jsonb` document with editor settings (aspect
  ratio, fps, tags — the jsonb, Arrays & Full-Text Search lesson).
- `project_members` — the **junction table** for "users are invited to other people's projects".
  Its primary key is `(project_id, user_id)` and each row has a `role`: `editor` or `viewer`. The
  owner is *not* in this table; ownership is `projects.owner_id`.
- `clips` — 19 video clips. `project_id` says which project a clip belongs to, and
  `parent_clip_id` points at the clip that leads to it — the same self-reference trick as
  `employees.manager_id`, so each project is a **tree** of clips. `choice_label` is the button the
  viewer clicks to get there (NULL for the first clip), `duration_ms` its length in milliseconds.
- `render_jobs` — 12 background jobs (`kind`: `encode`, `thumbnail`, `transition`) with a
  `status` (`queued`, `running`, `done`, `failed`), the number of `attempts`, the `worker` that
  picked it up, and three timestamps: `created_at`, `started_at`, `finished_at` (NULL until it
  happens).
- `credit_ledger` — every credit movement as a row with a positive or negative `delta`
  (`+500` for a monthly plan, `-40` for an AI transition). A user's balance is never stored; it is
  the sum of their rows.

Two details to notice early. First, every point in time in the studio is a **`timestamptz`** — an
absolute instant — unlike the shop's `ordered_at`; the **Expressions, Functions & NULL** lesson explains why that's the better
choice. Second, the studio also uses hand-picked ids, for the same predictability reason as the
shop.

:::sql id=db-01-sql8 db=studio xp=25
title: What's waiting in the render queue?
Switch to the **studio** database. Return the `id`, `project_id` and `kind` of every render job
whose `status` is `queued`.

hint: Text values go in single quotes: `WHERE status = 'queued'`.

```sql starter
SELECT id, project_id, kind FROM render_jobs;
```

```sql solution
SELECT id, project_id, kind FROM render_jobs WHERE status = 'queued';
```
:::

:::quiz id=db-01-q7 xp=10
In the studio, Jonas (user `2`) was invited to edit Mara's project "The Heist" (project `1`).
Where is that fact stored?
- [ ] In `projects.owner_id` of project 1
- [x] In a `project_members` row `(project_id 1, user_id 2, role 'editor')`
- [ ] In `users.plan` of Jonas
- [ ] In a list of member ids inside `projects.doc`
> "Users are invited to many projects, projects have many members" is a many-to-many
> relationship, so it lives in the junction table, one row per pair, with the role as the
> relationship's own data. `owner_id` holds exactly one user, the owner (Mara), so it can't also
> list editors. `plan` describes Jonas's subscription, not his projects. A member list inside a
> JSON document is the comma-separated-ids anti-pattern again: no foreign key can check it.
:::

:::cards id=db-01-cards1 xp=15 title="Relational basics"
Q: What is a primary key?
A: A column (or columns) that uniquely identifies each row. Always UNIQUE and NOT NULL.
Q: What is a foreign key?
A: A column that references the primary key of another (or the same) table. The database
   guarantees the referenced row exists (referential integrity).
Q: How do you model a many-to-many relationship?
A: With a junction table holding a foreign key to each side, e.g. `order_items(order_id, product_id)`.
Q: Where does the FK go in a one-to-many relationship?
A: On the "many" side — `orders.customer_id`, `products.category_id`.
Q: Default behavior when deleting a row that other rows still reference?
A: The DELETE fails with a foreign key violation (unless ON DELETE CASCADE / SET NULL was declared).
Q: How do you model one-to-one?
A: A foreign key that is also UNIQUE (often it is the second table's primary key).
Q: Surrogate vs natural key?
A: Surrogate: generated, meaningless id (integer, UUID). Natural: real-world identifier (ISBN, email).
Q: Do rows in a table have an order?
A: No. A table is a set; only ORDER BY guarantees an order.
Q: Why a connection pool?
A: Opening connections is expensive; a pool reuses open connections across requests.
Q: How do you prevent SQL injection?
A: Send values as parameters ($1, @name), never concatenate them into the SQL string.
Q: psql: describe a table?
A: `\d table_name` (and `\dt` lists tables).
:::

## Recap

- A **table** stores one kind of thing; columns are typed; rows are an unordered set.
- A **primary key** identifies a row; a **foreign key** points to a row in another table and the
  database enforces that it exists.
- Relationships: **1:N** = FK on the many side; **N:M** = junction table; **1:1** = unique FK;
  self-references model trees (org charts, branching clips).
- Constraints (`NOT NULL`, `UNIQUE`, `CHECK`, FKs) keep data correct no matter who writes it.
- Apps talk to Postgres through a **driver** and a **connection pool**, always with
  **parameters**; ORMs help with CRUD but you still need to read and write SQL.
- `psql` essentials: `\dt`, `\d table`, `\x`, `\timing`, `\q`.
- Two practice datasets: the **shop** (customers, products, orders) and the **studio** (users,
  projects, a clip tree, render jobs, a credit ledger). Both use hand-picked ids so results are
  predictable; real tables generate them.
