---
id: db-21
title: SQL Syntax Primer
level: beginner
minutes: 95
xp: 100
summary: The grammar of SQL from zero — statements, keywords, quotes, NULL, comments, execution order, the four statement families and how to read PostgreSQL's error messages.
---

Before you can think in tables (that's the next lesson, **Thinking in Tables**) you need to be able
to *read and write the language* tables speak. This primer is the grammar lesson: no theory about
keys or joins yet, just how a SQL statement is put together, what the punctuation means, and how to
understand the database when it complains. If you have never written a line of SQL, start here.
If you have, skim the headings and do the exercises — the quote rules and NULL trip up people with
years of experience.

## What SQL is (and why it looks like English)

**SQL** (Structured Query Language, pronounced "S-Q-L" or "sequel") is the language you use to talk
to a **relational database** — a program such as PostgreSQL that stores data in **tables** (grids of
rows and columns) and answers questions about it.

A **table** looks like a spreadsheet tab. Each **column** has a name and a type (text, number,
date…); each **row** is one record. Here are a few rows of the `customers` table you'll query below:

```text
 id |     name      | country |  city
----+---------------+---------+--------
  1 | Ada Lovelace  | UK      | London
  7 | Klaus Wirth   | Germany | Berlin
 10 | Noah Becker   | Germany |          ← empty: the city is unknown (NULL)
```

SQL is **declarative**: you describe *what* you want, not *how* to get it. Compare:

```text
Imperative (JavaScript):  loop over every customer, if country is 'UK', push name into a list
Declarative (SQL):        give me the names of customers whose country is 'UK'
```

```sql
SELECT name FROM customers WHERE country = 'UK';
```

You never say "use an index" or "loop". The database has a component called the **planner** that
decides the fastest way to get the answer. That's why a query written in the 1990s still runs fine today on data a
thousand times larger: the *how* got better, the *what* stayed the same.

Every database (PostgreSQL, MySQL, SQL Server, SQLite, Oracle) speaks SQL, with small differences
called **dialects**. DevQuest uses **PostgreSQL 18**; the rules in this lesson are standard SQL unless
noted.

:::info title="Where your SQL runs here"
Every `:::sql` exercise below runs on a real PostgreSQL in your browser (PGlite) loaded with the
**shop** database: `customers`, `products`, `categories`, `orders`, `order_items` and `employees`.
Each run starts fresh, so you cannot break anything — experiment freely.
:::

## The shape of a statement

A **statement** is one complete instruction to the database — like a sentence. It is built from:

| Part | What it is | Example |
|---|---|---|
| **Keyword** | A word with a fixed meaning in SQL | `SELECT`, `FROM`, `WHERE`, `INSERT` |
| **Identifier** | A name someone chose when creating the table: a table or column name | `customers`, `name`, `price` |
| **Literal** | A fixed value written directly in the query | `'UK'`, `42`, `19.99`, `NULL` |
| **Operator** | A symbol that compares or computes | `=`, `<`, `>=`, `<>`, `+`, `*` |
| **Clause** | A keyword plus what follows it — one "part" of the sentence | `WHERE country = 'UK'` |
| **Semicolon** | Ends the statement | `;` |

Here is one statement, taken apart:

```sql
SELECT name, city          -- SELECT clause: which columns
FROM customers             -- FROM clause:   which table
WHERE country = 'UK';      -- WHERE clause:  which rows; ; ends the statement
```

- `SELECT`, `FROM`, `WHERE` are **keywords**.
- `name`, `city`, `customers`, `country` are **identifiers**.
- `'UK'` is a **string literal**, `=` an **operator**.
- The commas separate items in a list (`name, city`). There is **no comma after the last item**.

### Three relaxing rules

1. **Keywords are case-insensitive.** `SELECT`, `select` and `SeLeCt` are the same. Teams usually
   write keywords in UPPERCASE so they stand out from names — a convention, not a rule.
2. **Whitespace doesn't matter.** Spaces, tabs and newlines between words are all the same to SQL.
   One line or ten lines — identical statement. Use line breaks to make long queries readable.
3. **The semicolon ends a statement.** It's required when you send several statements in one go
   (or type into `psql` — PostgreSQL's command-line client, which you'll use in the lab — because
   it waits for `;` before running anything). Get in the habit of always
   writing it.

```sql
-- These three are the same statement:
SELECT name FROM customers;
select name from customers;
SELECT name
  FROM customers;
```

:::quiz id=db-21-q1 xp=10
Which of these statements are **identical** to PostgreSQL? (Select all that apply.)
- [x] `SELECT name FROM customers;`
- [x] `select   name   from   customers;`
- [x] `SELECT name` on one line, then `FROM customers;` on the next
- [ ] `SELECT name, FROM customers;`
> Keywords are case-insensitive and any amount of whitespace (including newlines) between words is
> treated the same, so the first three are the same statement. The fourth has a **trailing comma**
> after `name`: SQL then expects another column, finds the keyword `FROM`, and reports
> `syntax error at or near "FROM"`.
:::

## Identifiers vs string literals: the quote rule

This is the **#1 beginner error** in SQL, especially if you come from JavaScript or Python where
`'single'` and `"double"` quotes are interchangeable. In SQL they mean completely different things:

| You write | SQL reads it as | Example |
|---|---|---|
| `'single quotes'` | a **string literal** — a piece of text data | `WHERE country = 'UK'` |
| `"double quotes"` | an **identifier** — the name of a column or table | `SELECT "name" FROM "customers"` |
| no quotes | an identifier (or a keyword) | `SELECT name FROM customers` |

So `WHERE country = "UK"` does **not** compare with the text UK. It asks for a *column named UK*,
and PostgreSQL answers:

```text
ERROR:  column "UK" does not exist
```

If you ever see "column … does not exist" where the "column" is obviously a value — check your quotes.

:::sql id=db-21-sql1 db=shop xp=10
title: Your first SELECT
List every customer's `name` and `city` (two columns, one row per customer).

hint: Separate columns with a comma, no comma after the last one: `SELECT a, b FROM table;`

```sql starter
SELECT name FROM customers;
```

```sql solution
SELECT name, city FROM customers;
```
:::

:::sql id=db-21-sql2 db=shop xp=15
title: Fix the quotes
The query below was written by someone used to JavaScript and fails with
`column "Germany" does not exist`. Fix it so it returns the `name` of every customer in Germany.

hint: Text values use **single** quotes in SQL. Double quotes mean "this is a column name".

```sql starter
SELECT name FROM customers WHERE country = "Germany";
```

```sql solution
SELECT name FROM customers WHERE country = 'Germany';
```
:::

### Case: keywords and names fold, text values don't

Unquoted identifiers are **folded to lowercase** by PostgreSQL. `SELECT Name FROM Customers` works,
because it becomes `name` and `customers`. But `"Name"` in double quotes keeps its capital N, and
there is no column called `Name` — so that fails.

The text *inside* single quotes is **data**, and data is compared exactly, including case:
`'UK'`, `'uk'` and `'Uk'` are three different strings.

```sql
SELECT Name FROM Customers;              -- works: folded to name / customers
SELECT "Name" FROM customers;            -- ERROR: column "Name" does not exist
SELECT name FROM customers WHERE country = 'uk';   -- runs, but returns 0 rows
```

:::tip title="Name things in lowercase snake_case"
Because of folding, the Postgres convention is lowercase names with underscores: `order_items`,
`created_at`. If you create a table as `"OrderItems"` (with quotes, as some tools do), you must
write the quotes **every single time** forever after. Avoid it.
:::

:::sql id=db-21-sql3 db=shop xp=10
title: Case matters in values
This query runs without an error but returns **no rows**. Make it return the `name` of every
customer whose country is the USA (the data stores it as `USA`).

hint: Keyword case doesn't matter; the text inside quotes must match the data exactly.

```sql starter
select name from customers where country = 'usa';
```

```sql solution
select name from customers where country = 'USA';
```
:::

### Apostrophes inside text

What if the text itself contains a single quote, like *It's*? Write it **twice**: `'It''s'`. Two
single quotes inside a string mean "one literal quote character" — that's called **escaping**.

```sql
SELECT 'O''Brien';     -- the text O'Brien
```

:::sql id=db-21-sql4 db=shop xp=10
title: Escape the apostrophe
Return a single row with a single column whose value is the text `It's working` (exact case and
spacing; the column's name doesn't matter). You don't need a table — `SELECT` can return a literal
on its own. The starter fails with `column "It's working" does not exist`.

hint: Double quotes make it a column name. Use single quotes, and write the apostrophe as two single quotes: `''`.

```sql starter
SELECT "It's working";
```

```sql solution
SELECT 'It''s working';
```
:::

:::quiz id=db-21-q2 xp=10
In PostgreSQL, what is `"email"` (with double quotes)?
- [ ] The text value email
- [x] The name of a column (or table) called `email`
- [ ] A comment
- [ ] A syntax error — SQL only allows single quotes
> Double quotes always mean **identifier** in standard SQL: `SELECT "email" FROM customers` is the
> same as `SELECT email FROM customers`. Text values (string literals) use single quotes:
> `'email'`. Double quotes are legal, so there's no syntax error — just a very different meaning.
:::

## Numbers and other literals

Not every value is text. A **literal** is written according to its **type** (the kind of data):

| Type of value | How you write it | Example |
|---|---|---|
| Whole number (integer) | digits, no quotes | `42`, `-7`, `0` |
| Decimal number (numeric) | dot as the decimal separator | `19.99`, `0.5` |
| Text | single quotes | `'Berlin'` |
| Boolean (yes/no) | `true` / `false`, no quotes | `WHERE active = false` |
| Date | a quoted text in ISO format, read as a date | `'2025-01-31'` |
| "No value" | `NULL` | `WHERE city IS NULL` |

Two things beginners get wrong with numbers:

- Write `19.99`, never `19,99` — the comma *separates list items*, so `19,99` is two numbers.
- Don't put numbers in quotes "to be safe". Postgres often converts `'30'` for you, but `'thirty'`
  becomes an error because the column's type is a number:

```text
ERROR:  invalid input syntax for type integer: "thirty"
```

:::sql id=db-21-sql5 db=shop xp=10
title: Out of stock
Return the `name` of every product whose `stock` is zero. The starter fails with
`invalid input syntax for type integer` — `stock` is a number column.

hint: Compare a number column with a number literal: no quotes, digits only.

```sql starter
SELECT name FROM products WHERE stock = 'zero';
```

```sql solution
SELECT name FROM products WHERE stock = 0;
```
:::

:::quiz id=db-21-q9 xp=10
You want products that cost exactly nineteen euros ninety-nine. Which condition is written correctly?
- [ ] `WHERE price = 19,99`
- [x] `WHERE price = 19.99`
- [ ] `WHERE price = "19.99"`
- [ ] `WHERE price = nineteen.99`
> Numbers are written unquoted with a **dot** as the decimal separator: `19.99`. A comma separates
> list items, so `19,99` is two separate values and fails to parse here. `"19.99"` in double quotes
> is an identifier (a column name), and `nineteen.99` is not a number at all.
:::

## NULL: "we don't know"

`NULL` means **no value / unknown**. It is not `0`, not `''` (the empty string), and not the text
`'NULL'`. In the shop, Noah Becker's `city` is `NULL` — we just don't know where he lives.

Because NULL is "unknown", comparing anything with it gives *unknown* too — even `NULL = NULL`.
A `WHERE` keeps a row only when its condition is **true**, so `WHERE city = NULL` keeps nothing,
silently. To test for NULL you use special operators:

```sql
SELECT name FROM customers WHERE city IS NULL;       -- customers without a city
SELECT name FROM customers WHERE city IS NOT NULL;   -- customers with one
```

:::warn title="= NULL never errors — it just returns nothing"
`WHERE city = NULL` is valid SQL, so you get no error message, just an empty result. When a query
"obviously should" return rows but returns zero, look for `= NULL` or `<> NULL`.
**Expressions, Functions & NULL** goes deeper into this three-valued logic.
:::

:::sql id=db-21-sql6 db=shop xp=15
title: Who has no city?
Return the `name` of every customer whose `city` is unknown. The starter runs but finds nobody.

hint: You can't compare with NULL using `=`. There's a two-word operator for it.

```sql starter
SELECT name FROM customers WHERE city = NULL;
```

```sql solution
SELECT name FROM customers WHERE city IS NULL;
```
:::

:::quiz id=db-21-q3 xp=10
Suppose some rows in a table `items` have `stock` set to `NULL`. What does `SELECT name FROM items WHERE stock = NULL;` return?
- [ ] The rows whose stock is NULL
- [x] No rows at all, and no error
- [ ] An error: `= NULL` is not allowed
- [ ] Every row
> Any comparison with NULL — including `= NULL` — yields *unknown*, not true. `WHERE` keeps only rows
> where the condition is true, so every row is dropped. Postgres doesn't complain because the syntax
> is valid. Use `WHERE stock IS NULL`.
:::

## Comments

A **comment** is text the database ignores — notes for humans. SQL has two kinds:

```sql
-- A line comment: from two dashes to the end of the line.
SELECT name, price   -- can also follow code on the same line
FROM products;

/* A block comment:
   from slash-star to star-slash, across as many lines as you like. */
SELECT name /* even in the middle */ FROM products;
```

The classic accident: a `--` comment swallows the rest of its line, **including code** that comes
after it on that line.

:::sql id=db-21-sql7 db=shop xp=15
title: The comment ate my WHERE
The author wanted the `name` of **inactive** products only (`active = false`), but put everything on
one line — and the query returns every product. Fix it so only inactive products come back (you may
keep the comment, as long as it doesn't hide code).

hint: `--` comments out *everything* after it on the line. Move the `WHERE` before the comment, put the comment on its own line, or use `/* … */`.

```sql starter
SELECT name FROM products -- only the inactive ones WHERE active = false;
```

```sql solution
SELECT name FROM products WHERE active = false; -- only the inactive ones
```
:::

## The core query shape: SELECT … FROM … WHERE … ORDER BY

Almost every query you'll read starts with the same skeleton. The clauses must appear **in this
order** when you write them; every one except `SELECT` is optional.

```sql
SELECT   name, price          -- 1. which columns (or computed values) to return
FROM     products             -- 2. which table to read
WHERE    price < 50           -- 3. which rows to keep (a condition that must be true)
ORDER BY price DESC, name     -- 4. how to sort the result
LIMIT    3;                   -- 5. how many rows at most
```

- `SELECT *` means "all columns" — handy for exploring, avoided in application code (you'll learn why
  in **SELECT, WHERE & ORDER BY**).
- `WHERE` conditions use comparison operators: `=`, `<>` (not equal; `!=` also works), `<`, `<=`,
  `>`, `>=`, and combine with `AND`, `OR`, `NOT`.
- `ORDER BY col` sorts ascending (`ASC`, the default); add `DESC` for descending. List several
  columns to break ties.

:::warn title="Without ORDER BY, row order is not guaranteed"
A table is a *set* of rows, not a list. Without `ORDER BY`, Postgres returns rows in whatever order
is cheapest — which can change after an update or on a bigger table. If order matters, say so.
:::

:::sql id=db-21-sql8 db=shop xp=15 ordered=true
title: Most expensive first
Return `name` and `price` of every product, the most expensive first. If two products ever had the
same price, sort them by `id` so the order is always the same.

hint: `ORDER BY price DESC, id` — the second column only breaks ties.

```sql starter
SELECT name, price FROM products;
```

```sql solution
SELECT name, price FROM products ORDER BY price DESC, id;
```
:::

### Reading order vs execution order

You **write** a query top to bottom: `SELECT … FROM … WHERE … ORDER BY … LIMIT`. But the database
**runs** it in a different, logical order:

```text
written:   SELECT  →  FROM  →  WHERE  →  ORDER BY  →  LIMIT
executed:  FROM  →  WHERE  →  SELECT  →  ORDER BY  →  LIMIT
           (which table) (keep rows) (pick/compute columns) (sort) (cut)
```

It reads like English ("select names from customers where…"), but it *works* like a pipeline: first
get the table, then filter rows, then shape the columns. One very practical consequence: a column
alias created in `SELECT` with `AS` (a temporary name for a result column) **doesn't exist yet**
when `WHERE` runs — but it does exist by the time `ORDER BY` runs.

```sql
SELECT name, price * 2 AS doubled FROM products ORDER BY doubled;   -- OK
SELECT name, price * 2 AS doubled FROM products WHERE doubled > 100; -- ERROR: column "doubled" does not exist
```

:::sql id=db-21-sql9 db=shop xp=15
title: The alias doesn't exist yet
Return `name` and `price * 2` (call it `doubled`) for products whose doubled price is over 100.
The starter fails with `column "doubled" does not exist`.

hint: `WHERE` runs before `SELECT`, so it can't see the alias. Repeat the expression in `WHERE`.

```sql starter
SELECT name, price * 2 AS doubled FROM products WHERE doubled > 100;
```

```sql solution
SELECT name, price * 2 AS doubled FROM products WHERE price * 2 > 100;
```
:::

:::quiz id=db-21-q4 xp=10
In which **logical order** does PostgreSQL process these clauses?
- [ ] SELECT → FROM → WHERE → ORDER BY
- [x] FROM → WHERE → SELECT → ORDER BY
- [ ] WHERE → FROM → ORDER BY → SELECT
- [ ] FROM → SELECT → WHERE → ORDER BY
> The database first finds the table (`FROM`), keeps the matching rows (`WHERE`), then computes the
> output columns (`SELECT`), and finally sorts (`ORDER BY`). That's why a `SELECT` alias works in
> `ORDER BY` but not in `WHERE`. (The full list, with `GROUP BY` and `HAVING`, comes in
> **SELECT, WHERE & ORDER BY** and **Aggregates & GROUP BY**.)
:::

## The four statement families

SQL statements fall into four families. You'll hear these acronyms in docs, job ads and interviews.

| Family | Stands for | Purpose | Main keywords |
|---|---|---|---|
| **DQL** | Data Query Language | Read data | `SELECT` |
| **DML** | Data Manipulation Language | Change the rows | `INSERT`, `UPDATE`, `DELETE` |
| **DDL** | Data Definition Language | Change the structure (tables, columns) | `CREATE`, `ALTER`, `DROP` |
| **DCL** | Data Control Language | Change who may do what | `GRANT`, `REVOKE` |

One tiny example of each:

```sql
-- DQL: read
SELECT name FROM categories;

-- DML: add, change, remove rows
INSERT INTO categories (id, name) VALUES (6, 'Cables');
UPDATE products SET price = 27.99 WHERE id = 3;
DELETE FROM categories WHERE id = 6;

-- DDL: create / change / delete a table itself
-- (PRIMARY KEY = "this column uniquely identifies each row"; explained in the next lesson)
CREATE TABLE reviews (id integer PRIMARY KEY, product_id integer, stars integer);
ALTER TABLE reviews ADD COLUMN comment text;
DROP TABLE reviews;

-- DCL: permissions for a database user (a "role"; this assumes a role named reporting exists)
GRANT SELECT ON products TO reporting;
REVOKE SELECT ON products FROM reporting;
```

Notice the shapes: `INSERT INTO table (columns) VALUES (values)`, `UPDATE table SET column = value
WHERE …`, `DELETE FROM table WHERE …`. Each family gets its own lesson later: **INSERT, UPDATE,
DELETE & Upserts** (DML), **Tables, Types & Constraints** (DDL) and **Production PostgreSQL** (roles
and `GRANT`).

:::warn title="UPDATE and DELETE without WHERE hit every row"
`DELETE FROM customers;` is valid SQL and deletes **all** customers. Always write the `WHERE` first,
and run the same condition as a `SELECT` before you run it as an `UPDATE` or `DELETE`.
:::

:::sql id=db-21-sql10 db=shop xp=15
title: Add a category (DML)
Insert a new category with `id` 6 and `name` `Headsets`. The starter fails — read the error
message: it's our old friend.

hint: `column "Headsets" does not exist` means Postgres read `"Headsets"` as a column name.

```sql starter
INSERT INTO categories (id, name) VALUES (6, "Headsets");
```

```sql solution
INSERT INTO categories (id, name) VALUES (6, 'Headsets');
```

```sql check
SELECT id, name FROM categories;
```
:::

:::sql id=db-21-sql11 db=shop xp=15
title: Create a table (DDL)
Create a table `wishlist` with two columns, both of type `integer`: `customer_id` and `product_id`
(in that order). The starter is missing a keyword.

hint: The shape is `CREATE TABLE name (column type, column type);`

```sql starter
CREATE wishlist (customer_id integer, product_id integer);
```

```sql solution
CREATE TABLE wishlist (customer_id integer, product_id integer);
```

```sql check
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'wishlist';
```
:::

:::quiz id=db-21-q5 xp=10
Which statements are **DML** (they change rows, not structure or permissions)? (Select all that apply.)
- [x] `UPDATE products SET stock = 0 WHERE id = 6;`
- [x] `DELETE FROM orders WHERE id = 99;`
- [ ] `ALTER TABLE products ADD COLUMN color text;`
- [ ] `GRANT SELECT ON orders TO reporting;`
- [x] `INSERT INTO categories (id, name) VALUES (7, 'Webcams');`
> `INSERT`, `UPDATE` and `DELETE` change the **data** inside tables — that's DML. `ALTER TABLE`
> changes the table's **structure**, so it's DDL. `GRANT` changes **permissions**, so it's DCL.
> `SELECT` alone is DQL (some books lump it under DML — you'll see both).
:::

## Reading PostgreSQL error messages

Errors aren't the database being difficult — they are precise directions to the problem. A
PostgreSQL error has up to four parts:

```text
ERROR:  column "nam" does not exist                      ← 1. what went wrong
LINE 1: SELECT nam FROM pets;                            ← 2. the line it happened on
               ^                                         ← 3. a caret under the exact spot
HINT:  Perhaps you meant to reference the column "pets.name".   ← 4. sometimes, a suggestion
```

The ones you'll meet in week one:

| Message | Usually means | Fix |
|---|---|---|
| `column "x" does not exist` | Typo in a column name, **or** text in double quotes, **or** a `SELECT` alias used in `WHERE` | Check the spelling, use `'single quotes'` for text, repeat the expression |
| `relation "x" does not exist` | Typo in a table name ("relation" = a table, or a view — a saved query that acts like a table), or you're connected to the wrong database | Check the spelling; in psql, `\dt` lists the tables |
| `syntax error at or near "X"` | The grammar broke **just before** X: a missing/extra comma, missing keyword, unclosed parenthesis | Look at the word *before* the caret |
| `invalid input syntax for type integer: "abc"` | A value that can't be converted to the column's type | Use a value of the right type, unquoted for numbers |

"At or near" is the important phrase: Postgres reports the first word where the statement *stopped
making sense*. The real mistake is often one step earlier — like the trailing comma in
`SELECT name, FROM pets`, reported as `syntax error at or near "FROM"`.

:::warn title="Exact wording can vary"
The messages above are what PostgreSQL 18's `psql` prints. Other clients (GUI tools, ORMs, the
exercises on this site) may show the same message without the `LINE`/caret lines, and wording can
change slightly between versions. The first line — the message itself — is what to search for.
See the PostgreSQL docs, *Appendix A: PostgreSQL Error Codes*
(https://www.postgresql.org/docs/18/errcodes-appendix.html).
:::

:::sql id=db-21-sql12 db=shop xp=15
title: Read the error, fix the query
This query fails with `column "nam" does not exist` and a hint. Fix it so it returns `name` and
`price` of products priced above 100.

hint: The HINT line tells you what the column is really called.

```sql starter
SELECT nam, price FROM products WHERE price > 100;
```

```sql solution
SELECT name, price FROM products WHERE price > 100;
```
:::

:::quiz id=db-21-q6 xp=10
You run `SELECT * FROM customers WHERE country = "UK";` and get `ERROR: column "UK" does not exist`.
What's wrong?
- [ ] The `customers` table has no `country` column
- [ ] There are no UK customers
- [x] `"UK"` in double quotes is read as a column name; text values need single quotes `'UK'`
- [ ] `=` can't compare text; you need `LIKE`
> The error names `"UK"` as the missing column — that's the clue. Double quotes mark identifiers,
> so Postgres looked for a column called UK. With `'UK'` it becomes a text literal and the query
> works. (No matching rows would give an empty result, not an error.)
:::

:::quiz id=db-21-q7 xp=10
`SELECT name, price, FROM products;` fails with `syntax error at or near "FROM"`. Where is the actual mistake?
- [ ] `FROM` is misspelled
- [x] The comma after `price` — SQL expected another column and found `FROM`
- [ ] `products` doesn't exist
- [ ] A semicolon is missing
> "At or near" points at the first token that didn't fit. After a comma, the grammar expects
> another column, so the keyword `FROM` is where it gives up. The fix is to remove the trailing
> comma *before* the caret. Always look one step to the left of where the caret points.
:::

:::quiz id=db-21-q8 xp=10
What does PostgreSQL run for this input?

```sql
SELECT name -- , email
FROM customers;
```
- [x] `SELECT name FROM customers;` — one column
- [ ] `SELECT name, email FROM customers;` — two columns
- [ ] Nothing — a syntax error because of the comma
- [ ] Nothing — comments aren't allowed inside a statement
> `--` starts a comment that runs to the end of the line, so `, email` is ignored. The statement
> continues on the next line with `FROM customers;`. Commenting out a column like this is a common
> trick while debugging a query.
:::

:::job title="SQL on day one"
You'll read far more SQL than you write at first: queries in an ORM's logs, migration files,
dashboards. Being able to *parse* a statement — this is a keyword, that's a column, this is a text
value, this runs before that — is the skill. The second most valuable one is calmly reading an
error message and its caret instead of guessing. Paste the exact error into tickets and PRs.
:::

:::pro title="How seniors write SQL"
- Uppercase keywords, lowercase snake_case names, one clause per line — it makes diffs reviewable.
- Never build SQL by gluing user input into strings (`"... WHERE name = '" + input + "'"`). That's
  how **SQL injection** happens. Apps send values separately as **parameters** (`WHERE name = $1`);
  the Backend region shows how.
- Before a risky `UPDATE`/`DELETE`, they run the same `WHERE` as a `SELECT` and check the count.
:::

:::lab id=db-21-lab1 xp=30
title: Make (and read) every error on purpose
You'll start a real PostgreSQL 18 in Docker, create a tiny `pets` table, and trigger each common
error yourself so you recognise it at work. Needs Docker (or Podman) installed.

**1. Create a folder and this file, `primer.sql`:**

```bash
mkdir sql-primer && cd sql-primer
```

```sql
-- primer.sql: a tiny table to practise on
DROP TABLE IF EXISTS pets;

CREATE TABLE pets (
  id      integer PRIMARY KEY,
  name    text    NOT NULL,
  species text    NOT NULL,
  age     integer,          -- NULL = we don't know
  owner   text
);

INSERT INTO pets (id, name, species, age, owner) VALUES
  (1, 'Rex',      'dog',  4,    'Ana'),
  (2, 'Whiskers', 'cat',  2,    'Ben'),
  (3, 'Bubbles',  'fish', NULL, 'Ana'),
  (4, 'Luna',     'cat',  7,    NULL);
```

**2. Start Postgres with the folder mounted, wait until it's ready, and load the file:**

```bash
docker run --name sql-primer -e POSTGRES_PASSWORD=dev -v "$PWD:/work:ro" -d postgres:18
docker exec sql-primer pg_isready -h 127.0.0.1 -U postgres   # repeat until: accepting connections
docker exec sql-primer psql -U postgres -f /work/primer.sql
```

Expected output:

```text
psql:/work/primer.sql:2: NOTICE:  table "pets" does not exist, skipping
DROP TABLE
CREATE TABLE
INSERT 0 4
```

(`INSERT 0 4` means 4 rows inserted. The NOTICE is harmless and disappears if you run the file again.
`pg_isready` checks over TCP with `-h 127.0.0.1` because, on first start, the image runs a temporary
setup server that only listens on a local socket — the TCP check succeeds only once the real server is up.
If `psql` says `the database system is starting up` or `shutting down`, wait a second and rerun.)

:::tip
On Fedora or other SELinux systems, use `-v "$PWD:/work:ro,Z"` so the container may read the folder.
:::

**3. Open psql and run a working query:**

```bash
docker exec -it sql-primer psql -U postgres
```

```sql
SELECT name, age FROM pets WHERE species = 'cat' ORDER BY id;
```

```text
   name   | age
----------+-----
 Whiskers |   2
 Luna     |   7
(2 rows)
```

**4. Now break it, one mistake at a time.** Type each line and compare with the expected error:

```sql
SELECT nam FROM pets;
```

```text
ERROR:  column "nam" does not exist
LINE 1: SELECT nam FROM pets;
               ^
HINT:  Perhaps you meant to reference the column "pets.name".
```

```sql
SELECT name FROM pets WHERE species = "cat";
```

```text
ERROR:  column "cat" does not exist
LINE 1: SELECT name FROM pets WHERE species = "cat";
                                              ^
```

```sql
SELECT name, FROM pets;
```

```text
ERROR:  syntax error at or near "FROM"
LINE 1: SELECT name, FROM pets;
                     ^
```

```sql
SELECT name FROM pets WHERE age > 'old';
```

```text
ERROR:  invalid input syntax for type integer: "old"
LINE 1: SELECT name FROM pets WHERE age > 'old';
                                          ^
```

**5. The silent ones — no error, wrong answer:**

```sql
SELECT name FROM pets WHERE age = NULL;     -- (0 rows)
SELECT name FROM pets WHERE age IS NULL;    -- Bubbles
SELECT name FROM pets WHERE species = 'Cat';  -- (0 rows): 'Cat' is not 'cat'
```

Finally type `SELECT 'It's Rex';` and press Enter. Nothing runs and the prompt changes from
`postgres=#` to `postgres'#` — psql is telling you a **quote is still open**. Press `Ctrl+C` to
cancel, then run `SELECT 'It''s Rex';`. Leave psql with `\q`.

**6. Clean up:**

```bash
docker rm -f sql-primer
```

- [ ] `primer.sql` loads and prints `INSERT 0 4`
- [ ] The cat query returns Whiskers and Luna
- [ ] I triggered all four errors and can say what each caret points at
- [ ] `= NULL` returned 0 rows and `IS NULL` returned Bubbles
- [ ] I saw the `postgres'#` prompt and fixed the apostrophe with `''`
- [ ] I removed the container with `docker rm -f sql-primer`
:::

## Cheat sheet

| Concept | Syntax | Example |
|---|---|---|
| End a statement | `;` | `SELECT 1;` |
| Text value | `'single quotes'` | `WHERE city = 'Berlin'` |
| Apostrophe in text | double it: `''` | `'O''Brien'` |
| Column/table name | bare, or `"double quotes"` | `name`, `"order"` |
| Number | digits, `.` for decimals | `42`, `19.99` |
| Boolean | `true` / `false` | `WHERE active = true` |
| Unknown value | `NULL`, test with `IS [NOT] NULL` | `WHERE city IS NULL` |
| Not equal | `<>` (or `!=`) | `WHERE status <> 'cancelled'` |
| Combine conditions | `AND`, `OR`, `NOT` | `WHERE price < 50 AND active = true` |
| Line comment | `-- …` | `-- todo` |
| Block comment | `/* … */` | `/* several lines */` |
| All columns | `*` | `SELECT * FROM products` |
| Rename an output column | `AS` | `SELECT price * 2 AS doubled` |
| Sort | `ORDER BY col` + `ASC` or `DESC` | `ORDER BY price DESC, id` |
| At most N rows | `LIMIT n` | `LIMIT 10` |
| Query shape (written) | `SELECT … FROM … WHERE … ORDER BY … LIMIT` | |
| Query order (executed) | `FROM → WHERE → SELECT → ORDER BY → LIMIT` | |
| DQL / DML / DDL / DCL | read / change rows / change structure / permissions | `SELECT` / `INSERT` / `CREATE` / `GRANT` |

:::cards id=db-21-cards1 xp=15 title="SQL syntax basics"
Q: What do single quotes mean in SQL? Double quotes?
A: 'Single' = a text value (string literal). "Double" = an identifier: a column or table name.
Q: Are SQL keywords case-sensitive? Are text values?
A: Keywords no (SELECT = select). Unquoted names are folded to lowercase. Text values yes: 'UK' ≠ 'uk'.
Q: How do you write the text O'Brien?
A: 'O''Brien' — a single quote inside a string is written twice.
Q: How do you find rows where a column has no value?
A: WHERE col IS NULL. `= NULL` is never true, so it silently returns no rows.
Q: The two comment styles?
A: -- to the end of the line, and /* … */ for blocks (can span lines).
Q: Logical execution order of a simple query?
A: FROM → WHERE → SELECT → ORDER BY → LIMIT. So a SELECT alias works in ORDER BY but not in WHERE.
Q: DQL, DML, DDL, DCL?
A: Query (SELECT), Manipulation (INSERT/UPDATE/DELETE), Definition (CREATE/ALTER/DROP), Control (GRANT/REVOKE).
Q: `syntax error at or near "FROM"` — where do you look?
A: Just before FROM: usually a trailing comma or a missing keyword. The caret marks where parsing gave up.
Q: `column "UK" does not exist` when "UK" is clearly a value?
A: You used double quotes. Text needs single quotes: 'UK'.
:::

## Recap

- SQL is **declarative**: you say *what* you want; the planner decides *how*.
- A statement is keywords + identifiers + literals + operators, grouped in clauses, ended by `;`.
  Keywords are case-insensitive and whitespace is free.
- **`'single'` = text value, `"double"` = column/table name.** Unquoted names fold to lowercase;
  text values compare exactly. Escape an apostrophe as `''`.
- Numbers go unquoted with a `.` decimal point; `NULL` means unknown — test it with `IS NULL`.
- Comments: `--` to end of line, `/* … */` for blocks; a `--` can hide code on the same line.
- Written order `SELECT → FROM → WHERE → ORDER BY → LIMIT`; executed order
  `FROM → WHERE → SELECT → ORDER BY → LIMIT`. No `ORDER BY` = no guaranteed order.
- Four families: DQL (`SELECT`), DML (`INSERT`/`UPDATE`/`DELETE`), DDL (`CREATE`/`ALTER`/`DROP`),
  DCL (`GRANT`/`REVOKE`).
- Read errors carefully: the message, the line, the caret, the hint. "At or near" points at where
  parsing stopped — the mistake is often just before it.
