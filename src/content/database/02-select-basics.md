---
id: db-02
title: SELECT, WHERE & ORDER BY
level: beginner
minutes: 65
xp: 120
summary: Read exactly the rows and columns you need — filtering, pattern matching, NULL checks, sorting, paging and DISTINCT.
---

`SELECT` is the statement you'll write most in your career. Dashboards, API endpoints, reports,
debugging a production bug at 2 a.m. — all start with "show me the rows where…". This lesson
covers the core of every query: choosing columns, filtering rows, sorting and paging — and the
**logical order** in which Postgres evaluates them, which explains most beginner errors.

## Choosing columns

```sql
SELECT name, price FROM products;
```

You can compute columns and rename them with **aliases** (`AS`):

```sql
SELECT name AS product, price, price * 2 AS double_price
FROM products;
```

`AS` is optional (`price * 2 double_price` works) but writing it is clearer. Postgres folds
unquoted names to lowercase — `AS UnitPrice` becomes the column `unitprice`. If an alias needs
spaces or capitals, quote it with **double quotes**: `AS "Unit Price"`. In SQL:

- `'single quotes'` are **string values**: `'Germany'`.
- `"double quotes"` are **identifiers** (names of columns, tables, aliases).

Mixing them up is the #1 typo, especially coming from C# or JavaScript where both quote styles
mean "string": `WHERE country = "Germany"` means "compare with a *column* called Germany" →
`ERROR: column "Germany" does not exist`.

Tables can have aliases too, which you'll use constantly once you join tables:

```sql
SELECT p.name, p.price FROM products AS p;
```

## Filtering rows with WHERE

`WHERE` is a test applied to each row: the row is kept only if the condition is **true**. (A
condition can also be *false* or *unknown* — the latter happens with NULL, see below. Both are
thrown away.)

```sql
SELECT name, price FROM products WHERE price < 30;
-- Wireless Mouse 29.99, USB-C Hub 24.90, Laptop Stand 19.99, Desk Mat 14.50
```

A boolean column is already a condition, so `WHERE active` means "where active is true" and
`WHERE NOT active` means the opposite.

Comparison operators: `=`, `<>` (or `!=`), `<`, `<=`, `>`, `>=`. Combine conditions with `AND`,
`OR` and `NOT`. `AND` binds tighter than `OR`, exactly like `*` before `+` — so use parentheses:

```sql
-- Products in category 1 or 2 that cost less than 50
SELECT name, price FROM products
WHERE (category_id = 1 OR category_id = 2) AND price < 50;
```

Without the parentheses, it would mean "category 1 (any price), or category 2 under 50" —
a classic silent bug.

### IN, BETWEEN

```sql
WHERE category_id IN (1, 2)            -- same as category_id = 1 OR category_id = 2
WHERE status NOT IN ('cancelled', 'pending')
WHERE price BETWEEN 20 AND 50          -- inclusive: 20 <= price AND price <= 50
```

`IN` is shorter and safer than a chain of `OR`s — there's no precedence to get wrong. One trap to
remember for later: if the list given to `NOT IN` contains a NULL, it matches *no rows at all*
(the **Expressions, Functions & NULL** lesson explains why).

:::warn title="BETWEEN and timestamps"
`BETWEEN` includes both ends. For times that's usually wrong:
`ordered_at BETWEEN '2025-01-01' AND '2025-01-31'` **misses** everything on Jan 31 after
00:00:00. Use a half-open range instead:
`ordered_at >= '2025-01-01' AND ordered_at < '2025-02-01'`.
:::

### Pattern matching: LIKE and ILIKE

`LIKE` matches text patterns: `%` = any sequence of characters (including none), `_` = exactly
one character.

```sql
WHERE name LIKE 'Mech%'     -- starts with "Mech"
WHERE name LIKE '%Mouse'    -- ends with "Mouse"
WHERE email LIKE '_da@%'    -- one char, then "da@", then anything
```

`LIKE` must match the **whole** value: `name LIKE 'Mouse'` only matches a name that is exactly
"Mouse". To mean "contains", put `%` on both sides: `'%Mouse%'`.

`LIKE` is case-sensitive. Postgres adds **`ILIKE`**, the case-insensitive version — perfect for
search boxes: `WHERE name ILIKE '%mouse%'` finds "Wireless Mouse" and "Gaming Mouse".

:::tip title="Searching for a literal % or _"
If the user's search text itself contains `%` or `_`, escape it with a backslash:
`name LIKE '100\%%'` finds names starting with "100%". In application code, escape these
characters before building the pattern — and still pass the pattern as a parameter.
:::

### Checking for NULL

`NULL` means "unknown". Comparing anything to unknown gives… unknown. Think of it as asking "is
Noah's city equal to *some city we don't know*?" — the honest answer is "don't know", not "yes".
So `city = NULL` is never true, not even for rows where city *is* NULL, and since `WHERE` keeps
only **true** rows, the row disappears. Use the special operators:

```sql
SELECT name FROM customers WHERE city IS NULL;       -- Noah Becker
SELECT name FROM customers WHERE city IS NOT NULL;   -- everyone else
```

:::quiz id=db-02-q1 xp=10
Noah Becker's `city` is NULL. Which query returns his row?
- [ ] `SELECT * FROM customers WHERE city = NULL`
- [x] `SELECT * FROM customers WHERE city IS NULL`
- [ ] `SELECT * FROM customers WHERE city = ''`
- [ ] `SELECT * FROM customers WHERE city <> 'Berlin'`
> `city = NULL` evaluates to NULL (unknown), and WHERE only keeps **true** rows. An empty string
> is a real value, not NULL. The sneaky one is `city <> 'Berlin'`: it feels like it must include
> Noah ("his city isn't Berlin"), but `NULL <> 'Berlin'` is also unknown — so it skips Noah too!
> Only `IS NULL` works.
:::

:::sql id=db-02-sql1 db=shop xp=20
title: German customers
Return `name` and `city` of every customer whose `country` is `Germany`.

hint: String values use single quotes: `'Germany'`.

```sql starter
SELECT name, city FROM customers;
```

```sql solution
SELECT name, city FROM customers WHERE country = 'Germany';
```
:::

:::sql id=db-02-sql2 db=shop xp=25
title: Mid-range and in stock
Return `name`, `price` and `stock` of products that cost **between 20 and 50 (inclusive)** and
have **more than 20** items in stock.

hint: `price BETWEEN 20 AND 50 AND stock > 20`

```sql starter
SELECT name, price, stock FROM products WHERE price BETWEEN 20 AND 50;
```

```sql solution
SELECT name, price, stock FROM products
WHERE price BETWEEN 20 AND 50 AND stock > 20;
```
:::

:::sql id=db-02-sql3 db=shop xp=25
title: Search box
A user types `mouse` into the search box. Return the `id` and `name` of every product whose name
contains that text, **ignoring case**.

hint: `LIKE 'mouse'` matches only a name that is exactly "mouse". You need "contains".
hint: `ILIKE` with `%` on both sides.

```sql starter
SELECT id, name FROM products WHERE name LIKE 'mouse';
```

```sql solution
SELECT id, name FROM products WHERE name ILIKE '%mouse%';
```
:::

:::sql id=db-02-sql4 db=shop xp=25
title: Open orders
Return `id`, `customer_id` and `status` of every order whose status is `pending` **or** `paid`.
Use `IN`.

hint: `WHERE status IN ('pending', 'paid')`

```sql starter
SELECT id, customer_id, status FROM orders WHERE status = 'pending';
```

```sql solution
SELECT id, customer_id, status FROM orders WHERE status IN ('pending', 'paid');
```
:::

## Sorting with ORDER BY

Without `ORDER BY`, Postgres returns rows in whatever order is cheapest — it may change after an
update, a `VACUUM`, or a different query plan. **If order matters, say so.**

```sql
SELECT name, price FROM products ORDER BY price;             -- ascending (ASC is the default)
SELECT name, price FROM products ORDER BY price DESC;        -- most expensive first
SELECT name, country FROM customers ORDER BY country, name;  -- by country, then name within it
```

Each sort key gets its own direction: `ORDER BY country DESC, name` sorts country descending but
name *ascending* — `DESC` does not carry over to the next column.

When rows tie on the sort key, their relative order is **undefined**. For anything a user sees
(and especially for paging) add a **tiebreaker** — usually the primary key — so the order is
*total* (every row has exactly one position): `ORDER BY price DESC, id`. Without it, two
products with the same price can swap places between page 1 and page 2 — one appears twice, the
other never.

### Where do NULLs go?

In Postgres, NULL sorts as if it were **larger than every value**: last in `ASC`, first in
`DESC`. Override it with `NULLS FIRST` / `NULLS LAST`:

```sql
SELECT name, city FROM customers ORDER BY city DESC NULLS LAST;
```

(Other databases differ — SQL Server and MySQL treat NULL as the *smallest* value. Another reason
to be explicit.)

## LIMIT and OFFSET

`LIMIT n` returns at most *n* rows; `OFFSET k` skips the first *k*. Together they give simple
paging:

```sql
-- page 3 with 10 rows per page: skip (3 - 1) * 10 = 20 rows
SELECT id, name FROM products ORDER BY id LIMIT 10 OFFSET 20;
```

The general formula is `LIMIT size OFFSET (page - 1) * size`. In an API, both values come from
the request — so pass them as parameters, and cap `size` (e.g. at 100) so nobody can ask for a
million rows.

`LIMIT` without `ORDER BY` is almost always a bug: "give me any 10 rows".

:::pro title="OFFSET gets slow; keyset pagination doesn't"
`OFFSET 100000` makes Postgres produce and throw away 100 000 rows. For big tables and infinite
scroll, use **keyset (cursor) pagination**: remember the last id you showed and ask for
`WHERE id > $1 ORDER BY id LIMIT 20` (with `$1` = the last id). With an index on `id` this is
instant on any page. When sorting by a non-unique column, compare the sort key *and* the
tiebreaker together with a row comparison: `WHERE (price, id) > ($1, $2) ORDER BY price, id`.
:::

## DISTINCT

`SELECT DISTINCT` removes duplicate rows from the result:

```sql
SELECT DISTINCT country FROM customers ORDER BY country;
-- Denmark, Finland, Germany, UK, USA
```

`DISTINCT` applies to the **whole row** you select: `SELECT DISTINCT country, city` returns each
unique *pair*. Postgres also has `DISTINCT ON (expr)` — "the first row per group" — which we'll
meet later.

:::sql id=db-02-sql5 db=shop xp=30 ordered=true
title: Most expensive first
Return `name` and `price` of all **active** products, most expensive first. If two products cost
the same, order them by `name`.

hint: `active` is a boolean: `WHERE active` (or `WHERE active = true`).
hint: `ORDER BY price DESC, name`

```sql starter
SELECT name, price FROM products ORDER BY price;
```

```sql solution
SELECT name, price FROM products WHERE active ORDER BY price DESC, name;
```
:::

:::sql id=db-02-sql6 db=shop xp=30 ordered=true
title: Top 3
Return `name` and `price` of the **three cheapest** products, cheapest first (tiebreaker: `id`).

hint: `ORDER BY price, id LIMIT 3`

```sql starter
SELECT name, price FROM products LIMIT 3;
```

```sql solution
SELECT name, price FROM products ORDER BY price, id LIMIT 3;
```
:::

:::sql id=db-02-sql7 db=shop xp=30 ordered=true
title: Page two
The product list shows **5 products per page**, sorted by `id`. Return `id` and `name` for
**page 2**.

hint: Page 2 skips the first 5 rows: `OFFSET 5`.

```sql starter
SELECT id, name FROM products ORDER BY id LIMIT 5;
```

```sql solution
SELECT id, name FROM products ORDER BY id LIMIT 5 OFFSET 5;
```
:::

:::sql id=db-02-sql8 db=shop xp=30 ordered=true
title: Where are our customers?
Return each distinct `country` **once**, alphabetically.

hint: `SELECT DISTINCT country …`

```sql starter
SELECT country FROM customers ORDER BY country;
```

```sql solution
SELECT DISTINCT country FROM customers ORDER BY country;
```
:::

:::sql id=db-02-sql9 db=shop xp=40 ordered=true
title: Q2 open orders
Return `id`, `status` and `ordered_at` of orders that are `pending` or `paid` **and** were placed
in the second quarter of 2025 (April 1 up to, but not including, July 1). Oldest first.

hint: Use a half-open range: `ordered_at >= '2025-04-01' AND ordered_at < '2025-07-01'`.
hint: Watch the parentheses if you use `OR` for the status.

```sql starter
SELECT id, status, ordered_at FROM orders
WHERE status = 'pending' OR status = 'paid' AND ordered_at >= '2025-04-01'
ORDER BY ordered_at;
```

```sql solution
SELECT id, status, ordered_at FROM orders
WHERE status IN ('pending', 'paid')
  AND ordered_at >= '2025-04-01' AND ordered_at < '2025-07-01'
ORDER BY ordered_at, id;
```
:::

:::sql id=db-02-sql10 db=shop xp=35 ordered=true
title: NULLs last
List every customer's `name` and `city`, sorted by `city` **descending**, but with customers
whose city is unknown at the **end**. Tiebreaker: `name`.

hint: In `DESC` order Postgres puts NULLs first by default. `NULLS LAST` fixes that.

```sql starter
SELECT name, city FROM customers ORDER BY city DESC, name;
```

```sql solution
SELECT name, city FROM customers ORDER BY city DESC NULLS LAST, name;
```
:::

## The logical order of a query

You *write* a query in this order:

```sql
SELECT … FROM … WHERE … GROUP BY … HAVING … ORDER BY … LIMIT …
```

But Postgres *evaluates* it (logically) in a different order:

| Step | Clause | What happens |
|---|---|---|
| 1 | `FROM` / `JOIN` | pick the source rows |
| 2 | `WHERE` | throw away rows that don't match |
| 3 | `GROUP BY` | collapse rows into groups |
| 4 | `HAVING` | throw away groups that don't match |
| 5 | `SELECT` | compute the output columns (and aliases) |
| 6 | `DISTINCT` | remove duplicates |
| 7 | `ORDER BY` | sort |
| 8 | `LIMIT` / `OFFSET` | cut |

This explains a classic error:

```sql
SELECT name, price * 1.19 AS gross FROM products WHERE gross > 50;
-- ERROR: column "gross" does not exist
```

`WHERE` runs (step 2) before `SELECT` creates the alias (step 5). Repeat the expression in
`WHERE` instead. But `ORDER BY gross` **does** work, because `ORDER BY` runs after `SELECT`.
(`HAVING` runs before `SELECT` too, so it can't see aliases either. `GROUP BY` is the one
exception: Postgres lets it use an output alias as a convenience — the **Aggregates & GROUP BY** lesson explains.)

One Postgres quirk: `ORDER BY` accepts an alias only **on its own**. `ORDER BY gross DESC` works,
but `ORDER BY gross + 1` fails with the same "does not exist" error, because inside an expression
Postgres looks only at the input columns. Repeat the expression there too.

The order also explains why `LIMIT` without `ORDER BY` is a bug: the cut (step 8) happens on
whatever order the rows happen to have.

:::quiz id=db-02-q2 xp=15
Which of these queries fails with *column "gross" does not exist*?
- [x] `SELECT price * 1.19 AS gross FROM products WHERE gross > 50`
- [ ] `SELECT price * 1.19 AS gross FROM products ORDER BY gross`
- [ ] `SELECT price * 1.19 AS gross FROM products WHERE price * 1.19 > 50`
- [ ] `SELECT price * 1.19 AS gross FROM products ORDER BY gross DESC LIMIT 1`
> WHERE is evaluated before SELECT, so the alias doesn't exist yet. ORDER BY runs after SELECT
> and can use a bare alias — with or without `DESC` and `LIMIT`. The third query is the standard
> fix: repeat the expression in WHERE.
:::

:::quiz id=db-02-q3 xp=10
What does `WHERE category_id = 1 OR category_id = 2 AND price < 50` mean?
- [ ] (category 1 or 2) and price under 50
- [x] category 1 (any price), or category 2 with price under 50
- [ ] It's a syntax error without parentheses
> `AND` binds tighter than `OR` (like `*` before `+`), so it reads
> `category_id = 1 OR (category_id = 2 AND price < 50)`. The first option is what the author
> probably *meant*, which is exactly why this bug is silent: the query runs and returns plausible
> rows. It's not a syntax error. When you mix AND and OR, always add parentheses.
:::

:::quiz id=db-02-q4 xp=10
`SELECT id, name FROM products LIMIT 5` — which rows do you get?
- [ ] The five with the lowest ids
- [ ] The five most recently inserted
- [x] Any five rows — the order is not defined without ORDER BY
> It *often* looks like the lowest ids or insertion order on a small fresh table, which is why
> this bug survives testing. After updates, deletes, `VACUUM` or a different query plan, the
> "natural" order changes and the query silently returns different rows. If you mean "lowest ids",
> write `ORDER BY id LIMIT 5`.
:::

:::quiz id=db-02-q5 xp=10
Which condition returns **every** order placed in January 2025? (`ordered_at` is a `timestamp`.)
- [ ] `ordered_at BETWEEN '2025-01-01' AND '2025-01-31'`
- [x] `ordered_at >= '2025-01-01' AND ordered_at < '2025-02-01'`
- [ ] `ordered_at > '2025-01-01' AND ordered_at < '2025-01-31'`
- [ ] `ordered_at LIKE '2025-01%'`
> The half-open range starts at midnight on Jan 1 and stops just before midnight on Feb 1, so it
> includes all of Jan 31. The tempting `BETWEEN` compares with `'2025-01-31 00:00:00'` and misses
> every order later on the 31st. The third option misses both midnight on Jan 1 and all of Jan 31.
> `LIKE` works on text, not timestamps — Postgres rejects it with an operator error.
:::

:::quiz id=db-02-q6 xp=10
Spot the bug. This query fails with `ERROR: column "Germany" does not exist`:

```sql
SELECT name FROM customers WHERE country = "Germany";
```

- [ ] `country` must be written in capitals
- [x] `"Germany"` is an identifier (a column name); string values need single quotes: `'Germany'`
- [ ] `=` can't compare text; use `LIKE`
- [ ] The `customers` table has no `country` column
> In SQL, double quotes name things (columns, tables, aliases) and single quotes are values. So
> Postgres looks for a column called `Germany`. The error message itself is the clue: the missing
> "column" is `Germany`, not `country`. `=` compares text perfectly well — `LIKE` is only needed for
> patterns.
:::

:::job title="Reading production data safely"
On a real team you'll run ad-hoc queries against staging or a read replica. Habits that keep
you out of trouble: always add a `LIMIT` while exploring big tables, select only the columns you
need (PII!), and prefer a read-only role so a typo can't change data.
:::

:::cards id=db-02-cards1 xp=15 title="SELECT basics"
Q: Single vs double quotes in SQL?
A: 'single' = string value, "double" = identifier (column/table/alias name).
Q: Is BETWEEN inclusive?
A: Yes, on both ends. For timestamps prefer `>= start AND < end`.
Q: Does DESC apply to every column in ORDER BY a DESC, b?
A: No. Each key has its own direction; b is still ascending.
Q: Formula for LIMIT/OFFSET paging?
A: `LIMIT size OFFSET (page - 1) * size` — with an ORDER BY that has a tiebreaker.
Q: LIKE wildcards?
A: `%` any sequence (also empty), `_` exactly one character. ILIKE = case-insensitive.
Q: How do you test for NULL?
A: `IS NULL` / `IS NOT NULL`. `= NULL` is never true.
Q: Where do NULLs sort in Postgres?
A: As the largest value: last in ASC, first in DESC. Override with NULLS FIRST / NULLS LAST.
Q: Logical evaluation order?
A: FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT.
Q: Why can't WHERE use a SELECT alias?
A: WHERE is evaluated before SELECT computes the alias. ORDER BY can use it.
Q: Why add a tiebreaker to ORDER BY?
A: Ties have undefined order; paging would repeat or skip rows. Add the PK to make it total.
Q: Problem with large OFFSET?
A: The skipped rows are still produced and discarded. Use keyset pagination (`WHERE id > $last`).
:::

## Recap

- `SELECT` columns (with `AS` aliases) `FROM` a table; `'strings'` vs `"identifiers"`.
- `WHERE` keeps rows where the condition is **true**: comparisons, `AND`/`OR`/`NOT` (use
  parentheses), `IN`, `BETWEEN` (inclusive), `LIKE`/`ILIKE`, `IS [NOT] NULL`.
- No `ORDER BY` = no guaranteed order. Make sort orders total with a tiebreaker; control NULLs
  with `NULLS FIRST/LAST`.
- `LIMIT`/`OFFSET` for paging (keyset pagination for big tables), `DISTINCT` for unique rows.
- Logical order: FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT.
