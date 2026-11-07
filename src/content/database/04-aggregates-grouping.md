---
id: db-04
title: Aggregates & GROUP BY
level: beginner
minutes: 75
xp: 120
summary: Turn rows into answers — COUNT, SUM, AVG, MIN, MAX, GROUP BY, HAVING, FILTER and string_agg.
---

So far every query returned one output row per table row. But most business questions are about
*many* rows at once: "How many customers per country?", "What's the revenue of each order?",
"Which users are running out of credits?". **Aggregate functions** collapse many rows into one
value, and **GROUP BY** decides which rows get collapsed together.

This is where SQL starts to feel like a superpower: a dashboard that would take a loop, a
dictionary and twenty lines of C# is a three-line query — and the database does it next to the
data, without shipping every row over the network.

## Aggregate functions

| Function | Returns |
|---|---|
| `count(*)` | number of rows |
| `count(col)` | number of rows where `col` is **not NULL** |
| `count(DISTINCT col)` | number of distinct non-NULL values |
| `sum(col)` | total |
| `avg(col)` | arithmetic mean |
| `min(col)` / `max(col)` | smallest / largest (works for numbers, text, dates) |

Without `GROUP BY`, an aggregate treats the whole (filtered) table as **one group** and returns
one row:

```sql
SELECT count(*) AS products, min(price) AS cheapest, max(price) AS priciest
FROM products;
-- 12 | 14.50 | 329.00
```

### COUNT(*) vs COUNT(column)

This difference shows up in interviews and in bugs:

```sql
SELECT count(*), count(city), count(DISTINCT country) FROM customers;
-- 10 | 9 | 5
```

`count(*)` counts rows. `count(city)` skips Noah, whose city is NULL. `count(DISTINCT country)`
counts each country once (UK, Finland, USA, Denmark, Germany). In fact `count(col)`, `sum`, `avg`,
`min`, `max` and `string_agg` all ignore NULLs (only `count(*)` and `array_agg` see them): `avg(x)`
is the average of the *known* values, not "treat NULL as zero".
That's usually what you want ("average rating of the ratings we have"), but if a missing value
really means zero, say so explicitly: `avg(COALESCE(x, 0))`.

A typical mistake is to use `count(col)` when you mean "number of rows" — it silently gives a
smaller number as soon as the column has NULLs. Pick deliberately: `count(*)` for rows,
`count(col)` for "rows where col is known".

:::sql id=db-04-sql1 db=shop xp=20
title: Counting customers
Return one row with two columns: the **total number of customers**, and the **number of
customers whose city is known**.

hint: `count(*)` counts rows, `count(city)` skips NULLs.

```sql starter
SELECT count(*), count(*) FROM customers;
```

```sql solution
SELECT count(*), count(city) FROM customers;
```
:::

:::sql id=db-04-sql2 db=shop xp=20
title: Price overview
Return one row with the **cheapest price**, the **highest price** and the **average price
rounded to 2 decimals** of all **active** products.

hint: Filter first with `WHERE active`, then aggregate.
hint: `round(avg(price), 2)`

```sql starter
SELECT min(price), max(price), avg(price) FROM products;
```

```sql solution
SELECT min(price), max(price), round(avg(price), 2) FROM products WHERE active;
```
:::

## GROUP BY

`GROUP BY` splits the rows into groups that share the same value(s), then computes the
aggregates **per group** — one output row per group. Picture it as sorting the rows into
buckets:

```text
customers                 GROUP BY country          SELECT country, count(*)
Ada      UK        ┐
Sophie   UK        ┘ ──►  bucket "UK"     (2 rows) ──►  UK      | 2
Klaus    Germany   ┐
Mia      Germany   │
Noah     Germany   ┘ ──►  bucket "Germany" (3 rows) ──►  Germany | 3
…
```

It's the SQL version of LINQ's `GroupBy(c => c.Country).Select(g => new { g.Key, Count = g.Count() })`
or a JavaScript `reduce` into an object — but computed next to the data.

```sql
SELECT country, count(*) AS customers
FROM customers
GROUP BY country
ORDER BY customers DESC, country;
-- Germany 3 · USA 3 · UK 2 · Denmark 1 · Finland 1
```

The golden rule: every column in `SELECT` must either be **in the GROUP BY** or be **inside an
aggregate**. This fails:

```sql
SELECT country, city, count(*) FROM customers GROUP BY country;
-- ERROR: column "customers.city" must appear in the GROUP BY clause
--        or be used in an aggregate function
```

…because a country group contains several cities — which one should Postgres show? (MySQL
without `ONLY_FULL_GROUP_BY` silently shows the value from an arbitrary row of the group.
Postgres refuses, which is the correct behavior.) You can group by several columns
(`GROUP BY country, city` — one group per *combination*) or by an expression
(`GROUP BY date_trunc('month', ordered_at)`).

NULLs are grouped together: `GROUP BY city` produces one group for all customers with an
unknown city (here just Noah). Unlike `=`, grouping treats NULLs as "the same".

:::tip title="Grouping by the primary key"
If you `GROUP BY` a table's primary key, Postgres knows every other column of that table is
determined by it, so you may select them without listing them all:
`SELECT c.id, c.name, count(o.id) FROM customers c JOIN orders o … GROUP BY c.id`.
This only works for the primary key itself — grouping by `c.email` (unique, but not the PK) still
requires listing `c.name`.
:::

:::quiz id=db-04-q4 xp=10
Spot the bug. Which query fails in PostgreSQL?
- [ ] `SELECT country, count(*) FROM customers GROUP BY country`
- [x] `SELECT country, name, count(*) FROM customers GROUP BY country`
- [ ] `SELECT country, count(DISTINCT city) FROM customers GROUP BY country`
- [ ] `SELECT count(*), max(created_at) FROM customers`
> In the failing query `name` is neither grouped nor aggregated, and a country group holds
> several names — Postgres can't pick one, so it raises *column "customers.name" must appear in
> the GROUP BY clause*. `count(DISTINCT city)` is an aggregate, so it's fine; and a query with only
> aggregates and no `GROUP BY` is fine too — the whole table is one group.
:::

:::sql id=db-04-sql3 db=shop xp=25 ordered=true
title: Customers per country
Return `country` and the **number of customers** in it. Most customers first; tiebreaker
`country` alphabetically.

hint: `GROUP BY country`, then `ORDER BY count(*) DESC, country`.

```sql starter
SELECT country, count(*) FROM customers GROUP BY country ORDER BY country;
```

```sql solution
SELECT country, count(*) AS n FROM customers GROUP BY country ORDER BY n DESC, country;
```
:::

:::sql id=db-04-sql4 db=shop xp=30 ordered=true
title: Category stats
For each `category_id` return: `category_id`, number of products, cheapest price, highest
price, and the average price rounded to 2 decimals. Order by `category_id`.

hint: `count(*), min(price), max(price), round(avg(price), 2)` with `GROUP BY category_id`.

```sql starter
SELECT category_id, count(*) FROM products GROUP BY category_id ORDER BY category_id;
```

```sql solution
SELECT category_id, count(*), min(price), max(price), round(avg(price), 2)
FROM products GROUP BY category_id ORDER BY category_id;
```
:::

:::sql id=db-04-sql5 db=shop xp=30 ordered=true
title: Order totals
Each row of `order_items` is one line of an order. Return `order_id` and the **order total**
(sum of `quantity * unit_price`) for every order, ordered by `order_id`.

hint: You can aggregate an expression: `sum(quantity * unit_price)`.

```sql starter
SELECT order_id, sum(unit_price) FROM order_items GROUP BY order_id ORDER BY order_id;
```

```sql solution
SELECT order_id, sum(quantity * unit_price) AS total
FROM order_items GROUP BY order_id ORDER BY order_id;
```
:::

:::sql id=db-04-sql6 db=shop xp=30 ordered=true
title: Orders per month
Return the month and the number of orders placed in it, oldest month first. Compute the month
as `date_trunc('month', ordered_at)`.

hint: You can `GROUP BY` the same expression you select (or `GROUP BY 1`, the first column).

```sql starter
SELECT ordered_at, count(*) FROM orders GROUP BY ordered_at ORDER BY ordered_at;
```

```sql solution
SELECT date_trunc('month', ordered_at) AS month, count(*)
FROM orders GROUP BY month ORDER BY month;
```
:::

:::tip title="GROUP BY may use an alias — WHERE and HAVING may not"
Wait — the **SELECT, WHERE & ORDER BY** lesson's logical order says `GROUP BY` (step 3) runs *before* `SELECT` creates aliases
(step 5), yet the solution's `GROUP BY month` works. That's a deliberate **Postgres extension**: when a
`GROUP BY` name isn't an input column, Postgres looks it up in the SELECT list, and `GROUP BY 1`
means "the first output column". The logical order still holds everywhere else, so:

| Clause | `month` alias? |
|---|---|
| `GROUP BY month` / `GROUP BY 1` | ✅ Postgres extension |
| `ORDER BY month` | ✅ runs after SELECT |
| `WHERE month >= '2025-03-01'` | ❌ *column "month" does not exist* |
| `HAVING n > 1` (with `count(*) AS n`) | ❌ repeat the aggregate: `HAVING count(*) > 1` |

Two cautions: if a table column has the same name as the alias, `GROUP BY` picks the **table
column**, not your expression (so don't alias `date_trunc('month', ordered_at) AS ordered_at`). And
many teams prefer repeating the expression or `GROUP BY 1` in shared code, because aliases in
`GROUP BY` aren't portable to every database.
:::

## WHERE vs HAVING

Both filter, but at different moments. Remember the **logical order** from the **SELECT, WHERE & ORDER BY** lesson: SQL is
written `SELECT … FROM … WHERE … GROUP BY … HAVING …` but evaluated
**FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT**. So:

- **WHERE** filters **rows** *before* grouping. It can't see aggregates — they don't exist yet.
- **HAVING** filters **groups** *after* aggregating. It's where `count(*) > 1` goes.

This order also explains the alias rules: `ORDER BY total` works because `ORDER BY` runs after
`SELECT` created the alias, but `HAVING total > 100` fails (`column "total" does not exist`) —
repeat the expression instead: `HAVING sum(quantity * unit_price) > 100`. (`GROUP BY` accepting
an alias is the Postgres extension from the tip above — it doesn't extend to `WHERE` or
`HAVING`.)

```sql
-- Customers with at least 2 orders that weren't cancelled
SELECT customer_id, count(*) AS orders
FROM orders
WHERE status <> 'cancelled'      -- row filter: drop cancelled orders first
GROUP BY customer_id
HAVING count(*) >= 2             -- group filter: keep customers with 2+
ORDER BY customer_id;
```

`WHERE count(*) >= 2` would fail with *aggregate functions are not allowed in WHERE*. And putting
a plain row condition in `HAVING` (e.g. `HAVING status <> 'cancelled'`) also fails — `status`
isn't grouped. Rule of thumb: filter as early as possible (WHERE) — it's clearer and lets
Postgres throw rows away before doing the work of grouping.

:::quiz id=db-04-q1 xp=15
You want categories whose **average price is above 50**. Which query is correct?
- [ ] `SELECT category_id FROM products WHERE avg(price) > 50 GROUP BY category_id`
- [x] `SELECT category_id FROM products GROUP BY category_id HAVING avg(price) > 50`
- [ ] `SELECT category_id FROM products GROUP BY category_id WHERE avg(price) > 50`
- [ ] `SELECT category_id, avg(price) > 50 FROM products`
> Conditions on aggregates go in HAVING, which runs after GROUP BY. The first option is the
> tempting one, but WHERE runs before grouping, so `avg(price)` doesn't exist there yet
> (*aggregate functions are not allowed in WHERE*). The third has the clauses in the wrong order
> (syntax error). The fourth fails with *column "products.category_id" must appear in the GROUP BY
> clause*: without GROUP BY the whole table is one group, and `category_id` is neither grouped nor
> aggregated.
:::

:::sql id=db-04-sql7 db=shop xp=35 ordered=true
title: Big orders
Return `order_id` and order total for orders whose total is **greater than 100**. Biggest
first; tiebreaker `order_id`.

hint: Same as "Order totals", plus `HAVING sum(quantity * unit_price) > 100`.

```sql starter
SELECT order_id, sum(quantity * unit_price) AS total
FROM order_items WHERE unit_price > 100
GROUP BY order_id ORDER BY total DESC, order_id;
```

```sql solution
SELECT order_id, sum(quantity * unit_price) AS total
FROM order_items
GROUP BY order_id
HAVING sum(quantity * unit_price) > 100
ORDER BY total DESC, order_id;
```
:::

:::sql id=db-04-sql8 db=shop xp=35 ordered=true
title: Loyal customers
Return `customer_id` and the number of orders for customers with **at least 2 orders that were
not cancelled** (don't count cancelled orders at all). Order by `customer_id`.

hint: `WHERE status <> 'cancelled'` removes rows before grouping; `HAVING count(*) >= 2` removes groups after.

```sql starter
SELECT customer_id, count(*) FROM orders
GROUP BY customer_id HAVING count(*) >= 2 ORDER BY customer_id;
```

```sql solution
SELECT customer_id, count(*) FROM orders
WHERE status <> 'cancelled'
GROUP BY customer_id HAVING count(*) >= 2 ORDER BY customer_id;
```
:::

## FILTER: several counts in one pass

Dashboards often need "how many X, how many Y" side by side. You *could* run several queries, or
use `sum(CASE WHEN … THEN 1 ELSE 0 END)`. Postgres has a cleaner, standard syntax — the
**FILTER** clause on any aggregate:

```sql
SELECT customer_id,
       count(*)                                     AS all_orders,
       count(*) FILTER (WHERE status = 'shipped')   AS shipped,
       count(*) FILTER (WHERE status = 'cancelled') AS cancelled
FROM orders
GROUP BY customer_id
ORDER BY customer_id;
```

One scan of the table, three answers per customer. It works with every aggregate:
`sum(quantity * unit_price) FILTER (WHERE …)`.

:::sql id=db-04-sql9 db=shop xp=35 ordered=true
title: Order status board
For each `customer_id` return four columns: `customer_id`, total number of orders, number of
`shipped` orders, number of `cancelled` orders. Order by `customer_id`.

hint: `count(*) FILTER (WHERE status = 'shipped')`

```sql starter
SELECT customer_id, count(*), count(*), count(*)
FROM orders GROUP BY customer_id ORDER BY customer_id;
```

```sql solution
SELECT customer_id,
       count(*),
       count(*) FILTER (WHERE status = 'shipped'),
       count(*) FILTER (WHERE status = 'cancelled')
FROM orders GROUP BY customer_id ORDER BY customer_id;
```
:::

:::quiz id=db-04-q5 xp=15
What's the difference between these two queries?

```sql
-- A
SELECT customer_id, count(*) FROM orders
WHERE status = 'shipped' GROUP BY customer_id;
-- B
SELECT customer_id, count(*) FILTER (WHERE status = 'shipped') FROM orders
GROUP BY customer_id;
```

- [ ] None — they always return the same rows
- [x] B also lists customers with zero shipped orders (count `0`); A leaves them out
- [ ] A is an error, because `status` is not in the GROUP BY
- [ ] B counts all orders; `FILTER` only affects sorting
> `WHERE` removes rows **before** grouping, so a customer whose orders are all paid/pending has no
> rows left and no group — they vanish from A. In B every customer keeps their group, and `FILTER`
> only decides which rows *that aggregate* counts, so they show up with `0`. A is valid: `status`
> is used in `WHERE`, not selected. Choose based on whether "zero" customers should be in the
> report.
:::

## Rounding numerics

Money columns in the shop are `numeric(10,2)`: exact decimals. Sums of `numeric` stay exact,
but `avg` returns many decimals — `SELECT avg(price) FROM products` gives
`73.4400000000000000`. Round for display with `round(x, 2)` → `73.44`.

Watch the types:

- `avg(integer_col)` returns `numeric` — no truncation, good.
- `sum(integer_col)` returns `bigint` — no overflow for big totals.
- `round()` with a digits argument needs `numeric`: `round(avg(x)::numeric, 2)` if `x` is a
  `double precision` (float). Without the cast you get
  `function round(double precision, integer) does not exist`.
- Round **after** aggregating (`round(sum(x), 2)`), not inside (`sum(round(x, 2))`) — rounding
  every row first accumulates rounding errors.

## string_agg and array_agg

Sometimes you want the group's values *listed*, not counted:

```sql
SELECT category_id, string_agg(name, ', ' ORDER BY name) AS products
FROM products
GROUP BY category_id;
-- 1 | Low-profile Keyboard, Mechanical Keyboard
```

`string_agg(value, separator ORDER BY …)` joins text. `array_agg(value ORDER BY …)` builds a
Postgres array — your driver turns it into a JS array or C# `int[]`, which is handy for APIs.
Always put an `ORDER BY` inside, otherwise the order of the list is arbitrary.

:::sql id=db-04-sql10 db=shop xp=35 ordered=true
title: Products per category, as a list
For each `category_id` return the product names as **one comma-separated text**, sorted
alphabetically, separated by `', '` (comma + space). Order the rows by `category_id`.

hint: `string_agg(name, ', ' ORDER BY name)`

```sql starter
SELECT category_id, string_agg(name, ',') FROM products GROUP BY category_id ORDER BY category_id;
```

```sql solution
SELECT category_id, string_agg(name, ', ' ORDER BY name)
FROM products GROUP BY category_id ORDER BY category_id;
```
:::

:::sql id=db-04-sql11 db=studio xp=40 ordered=true
title: Credit balances
Switch to the **studio** database. `credit_ledger` records every credit movement as a positive or
negative `delta`. Return `user_id` and the current **balance** (sum of deltas) for every user
in the ledger. Highest balance first; tiebreaker `user_id`.

hint: A ledger balance is just `sum(delta)` per user.

```sql starter
SELECT user_id, sum(delta) FROM credit_ledger WHERE delta > 0
GROUP BY user_id ORDER BY 2 DESC, user_id;
```

```sql solution
SELECT user_id, sum(delta) AS balance
FROM credit_ledger GROUP BY user_id ORDER BY balance DESC, user_id;
```
:::

:::sql id=db-04-sql12 db=studio xp=45 ordered=true
title: Render queue health
In the **studio** database, return for each render job `status`: the status, the number of jobs,
the **total attempts**, and the number of jobs that needed **more than one attempt**. Only
include statuses with at least 2 jobs. Order by `status`.

hint: `count(*) FILTER (WHERE attempts > 1)`
hint: `HAVING count(*) >= 2`

```sql starter
SELECT status, count(*), sum(attempts), count(*)
FROM render_jobs GROUP BY status ORDER BY status;
```

```sql solution
SELECT status, count(*), sum(attempts), count(*) FILTER (WHERE attempts > 1)
FROM render_jobs
GROUP BY status
HAVING count(*) >= 2
ORDER BY status;
```
:::

:::quiz id=db-04-q2 xp=10
Table `scores(points)` has the values 10, NULL, 20. What does `SELECT avg(points), count(points),
count(*) FROM scores` return?
- [ ] `10 | 3 | 3`
- [x] `15 | 2 | 3`
- [ ] `NULL | 2 | 3`
- [ ] `10 | 2 | 2`
> Aggregates ignore NULLs: the average of 10 and 20 is 15, and `count(points)` counts 2 known
> values. Only `count(*)` counts every row. The tempting `10 | 3 | 3` is what you'd get if NULL
> were treated as zero (30 / 3) — SQL doesn't do that. If NULL should mean zero, say so:
> `avg(COALESCE(points, 0))`.
:::

:::quiz id=db-04-q3 xp=10
What does `SELECT count(*) FROM orders WHERE false` return?
- [x] One row containing `0`
- [ ] Zero rows
- [ ] One row containing NULL
> An aggregate without GROUP BY always returns exactly one row. `count` of nothing is 0 — but
> `sum`, `avg`, `min` and `max` of nothing are NULL (the tempting "one row with NULL" is what you'd
> get from `sum`). With a GROUP BY, an empty input gives zero rows — there are no groups to report.
:::

:::quiz id=db-04-q6 xp=15
In the shop, the three German customers live in Berlin, Munich and — for Noah — an unknown city
(NULL). What does this return for the Germany row?

```sql
SELECT country, count(*), count(city), count(DISTINCT city)
FROM customers GROUP BY country;
```

- [ ] `Germany | 3 | 3 | 3`
- [ ] `Germany | 3 | 3 | 2`
- [x] `Germany | 3 | 2 | 2`
- [ ] `Germany | 3 | 2 | 3`
> `count(*)` counts all 3 rows. `count(city)` skips Noah's NULL → 2. `count(DISTINCT city)` counts
> distinct **non-NULL** values (Berlin, Munich) → 2; NULL is not counted as "one more distinct
> value". The tempting `3 | 2 | 3` assumes DISTINCT counts NULL as its own value — it doesn't.
:::

:::quiz id=db-04-q7 xp=10
A teammate writes `HAVING revenue > 1000` where `revenue` is an alias defined in the SELECT list
as `sum(quantity * unit_price) AS revenue`. What happens in PostgreSQL?
- [ ] It works, just like `ORDER BY revenue`
- [x] Error: `column "revenue" does not exist` — repeat the expression in HAVING
- [ ] It silently filters on the first column instead
- [ ] It works only if you also `GROUP BY revenue`
> HAVING is evaluated **before** SELECT, so the alias doesn't exist yet. ORDER BY runs after
> SELECT, which is why aliases work there. Write `HAVING sum(quantity * unit_price) > 1000` (or
> compute the total in a subquery/CTE and filter outside — the **Subqueries, CTEs & Recursive Queries** lesson). Grouping by an aggregate
> isn't allowed at all.
:::

:::pro title="Let the database aggregate"
A classic junior anti-pattern: `SELECT * FROM orders` into the app, then loop to count per
status. With a million rows that's a million rows over the network and in memory. `GROUP BY`
returns four rows. Push aggregation to Postgres; it's what it's built for.

The same applies to ORMs: in EF Core, `context.Orders.GroupBy(o => o.Status).Select(g => new
{ g.Key, Count = g.Count() })` is translated to a SQL `GROUP BY`. Calling `.ToList()` *before*
`GroupBy` downloads every row and groups in memory instead.
:::

:::info title="Subtotals with ROLLUP"
Reports often want per-group rows **plus** a grand total. `GROUP BY ROLLUP (country)` adds an
extra row where `country` is NULL and the aggregates cover everything; `GROUPING SETS` and `CUBE`
generalize this. Good to recognize when you see it in a reporting query.
:::

:::job title="Every dashboard is a GROUP BY"
Product managers will ask "how many signups per week by plan?" Expect to write
`date_trunc('week', created_at)` + `GROUP BY` + `FILTER` queries for admin dashboards, metrics
endpoints and one-off Slack answers. Being fast at this makes you very popular.
:::

:::cards id=db-04-cards1 xp=15 title="Aggregates"
Q: `count(*)` vs `count(col)`?
A: `count(*)` counts rows; `count(col)` counts rows where col is not NULL.
Q: Do aggregates include NULLs?
A: No — count(col), sum, avg, min, max and string_agg skip NULLs; count(*) counts every row and array_agg keeps NULL elements.
Q: The GROUP BY rule?
A: Every selected column must be in GROUP BY or inside an aggregate (or be functionally dependent on a grouped PK).
Q: WHERE vs HAVING?
A: WHERE filters rows before grouping; HAVING filters groups after aggregating.
Q: Several conditional counts in one query?
A: `count(*) FILTER (WHERE …)` per column (or `sum(CASE WHEN … THEN 1 ELSE 0 END)`).
Q: Join group values into text?
A: `string_agg(col, ', ' ORDER BY col)`; `array_agg` builds an array.
Q: `sum` of zero rows?
A: NULL (count gives 0). Use `COALESCE(sum(x), 0)`.
Q: Round an average to 2 decimals?
A: `round(avg(x), 2)` — cast to numeric first if x is a float.
Q: Can HAVING use a SELECT alias?
A: No — HAVING runs before SELECT. Repeat the aggregate expression. (ORDER BY can use aliases.)
Q: Why does `GROUP BY month` work when `month` is a SELECT alias?
A: A Postgres extension: GROUP BY falls back to output-column names (and `GROUP BY 1` = first column).
   WHERE and HAVING get no such fallback; a same-named table column wins over the alias.
Q: `WHERE status = 'x'` vs `count(*) FILTER (WHERE status = 'x')`?
A: WHERE removes rows before grouping (groups with no matches disappear); FILTER keeps every group
   and only restricts that one aggregate (zero matches → 0).
Q: Does `count(DISTINCT col)` count NULL?
A: No — it counts distinct non-NULL values.
:::

## Recap

- Aggregates (`count`, `sum`, `avg`, `min`, `max`) collapse rows into a value; `count(col)`,
  `sum`, `avg`, `min`, `max` and `string_agg` ignore NULLs (`count(DISTINCT col)` too) — only
  `count(*)` and `array_agg` see them.
- `GROUP BY` makes one output row per group (NULLs form one group); selected columns must be
  grouped, aggregated, or depend on a grouped primary key.
- `WHERE` filters rows before grouping, `HAVING` filters groups after; HAVING can't use SELECT
  aliases (only `GROUP BY` and `ORDER BY` can, the former as a Postgres extension).
- `FILTER (WHERE …)` gives several conditional aggregates in one pass.
- Round `numeric` results with `round(x, 2)`; `string_agg`/`array_agg` list a group's values
  (always with an inner `ORDER BY`).
