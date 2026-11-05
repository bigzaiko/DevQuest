---
id: db-05
title: JOINs
level: intermediate
minutes: 55
xp: 170
summary: Combine tables — INNER, LEFT, RIGHT, FULL, CROSS and self-joins, multi-table joins, anti-joins, UNION/INTERSECT/EXCEPT, and the row-multiplication trap.
---

A well-designed database spreads information across tables: the order knows its `customer_id`,
not the customer's name. That's good design (lesson 8 explains why) — but it means almost every
useful query has to put the pieces back together. That's what **joins** do.

Joins are also the #1 source of wrong numbers in reports. A join that silently drops rows, or
silently *duplicates* them, still returns a nice-looking result. This lesson teaches you to
predict exactly how many rows a join produces.

## The mental model

A join takes two tables and produces combinations of their rows. Conceptually:

1. Pair **every** row of the left table with **every** row of the right table (the Cartesian
   product — 10 customers × 18 orders = 180 pairs).
2. Keep only the pairs where the **ON condition** is true.
3. Depending on the join type, add back the rows that found **no partner**.

A tiny example. Two customers and three orders:

```text
customers          orders                       JOIN … ON o.customer_id = c.id
id | name          id | customer_id             c.name | o.id
 1 | Ada            1 | 1                        Ada    | 1
 2 | Linus          2 | 1             ──►         Ada    | 2
                    3 | 2                        Linus  | 3
```

Step 1 makes 2 × 3 = 6 pairs; step 2 keeps the 3 where the ids line up. Notice that Ada appears
**twice** — a join repeats a row once per partner. Keep this in mind; it's the root of the trap at
the end of the lesson.

Postgres doesn't actually build all the pairs (it uses hash joins, merge joins and indexes), but
the result is always *as if* it did. Keep this model in mind and every join type is easy.

## INNER JOIN

```sql
SELECT o.id, c.name, o.status
FROM orders o
JOIN customers c ON c.id = o.customer_id
ORDER BY o.id;
```

`JOIN` means `INNER JOIN`: keep only pairs that match. Each order has exactly one customer (the
`customer_id` foreign key is `NOT NULL`), so we get exactly 18 rows — one per order.

The **table aliases** (`orders o`, `customers c`) are short names for the tables. Once two tables
share a column name — both have `id`, and `customers` and `products` both have `name` — an
unqualified `id` is ambiguous (`ERROR: column reference "id" is ambiguous`), so you must write
`o.id` or `c.id`. Qualifying *every* column in a join query is a good habit: the reader never
has to guess which table a column comes from.

:::tip title="Write ON with the foreign key"
The ON condition almost always follows a foreign key: `c.id = o.customer_id`,
`p.id = oi.product_id`. If you're joining on anything else, double-check that it's what you
mean. `USING (col)` is a shortcut when **both** tables have a column with exactly that name,
e.g. `JOIN b USING (order_id)` when both a and b have `order_id`. In our shop the foreign keys
(`customer_id`, `order_id`) point to columns called `id`, so you need `ON` here. Avoid `NATURAL JOIN`: it joins on *every* column with
the same name — `id`, `name`, `created_at` … — and breaks silently when someone adds a column.
:::

:::warn title="NULL never matches"
A join condition is an ordinary comparison, so three-valued logic applies: a row whose join
column is NULL **never** finds a partner, not even another NULL (`NULL = NULL` is unknown). With
an inner join such rows simply disappear. In `employees`, the CEO's `manager_id` is NULL — you'll
see the consequence in the self-join section.
:::

:::info title="The old comma syntax"
In older code you'll see `FROM orders o, customers c WHERE c.id = o.customer_id`. That is an
inner join written as a cross join plus a WHERE filter. It works, but forget the WHERE line and
you silently get every order × every customer. Prefer explicit `JOIN … ON`.
:::

:::sql id=db-05-sql1 db=shop xp=20 ordered=true
title: Who ordered what?
Return the order `id`, the **customer's name**, and the order `status` for every order, ordered
by order `id`.

hint: `JOIN customers c ON c.id = o.customer_id`

```sql starter
SELECT o.id, o.customer_id, o.status FROM orders o ORDER BY o.id;
```

```sql solution
SELECT o.id, c.name, o.status
FROM orders o
JOIN customers c ON c.id = o.customer_id
ORDER BY o.id;
```
:::

:::sql id=db-05-sql2 db=shop xp=25 ordered=true
title: Catalogue with categories
Return the **category name**, the product name and the price of every product. Order by category
name, then product name.

hint: Both tables have a `name` column — use `c.name` and `p.name`.

```sql starter
SELECT p.category_id, p.name, p.price FROM products p ORDER BY p.category_id, p.name;
```

```sql solution
SELECT c.name, p.name, p.price
FROM products p
JOIN categories c ON c.id = p.category_id
ORDER BY c.name, p.name;
```
:::

## Joining many tables

Joins chain. Each `JOIN` adds one table, linked by its foreign key:

```sql
-- every order line with customer and product names
SELECT o.id AS order_id, c.name AS customer, p.name AS product, oi.quantity
FROM orders o
JOIN customers   c  ON c.id  = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
JOIN products    p  ON p.id  = oi.product_id
ORDER BY o.id, p.name;
```

Read it as a path through the schema: orders → customers, orders → order_items → products.
Every `ON` may refer to any table joined *before* it, but not to one joined later. Note the
**grain** (what one result row means) changed: one row per order *line*, not per order — order
1 with two items now appears twice.

:::quiz id=db-05-q4 xp=10
`orders` has 18 rows and `order_items` has 30 rows; every line belongs to an existing order and
every order has at least one line. How many rows does
`orders o JOIN order_items oi ON oi.order_id = o.id` return?
- [ ] 18 — one per order
- [x] 30 — one per order line
- [ ] 540 — every order with every line
- [ ] 48 — both tables together
> Every order line finds exactly one order, so the result has one row per **line**: 30. Each order
> is repeated once per line it has. 18 would require collapsing the lines (e.g. `GROUP BY o.id`),
> 540 is the CROSS JOIN without the ON filter, and 48 (adding the row counts) is never what a
> join produces — joins pair rows, they don't stack them.
:::

:::sql id=db-05-sql3 db=shop xp=30 ordered=true
title: The receipt
Return the lines of order `6` as: product name, `quantity`, `unit_price`, and the line total
(`quantity * unit_price`). Order by product name.

hint: `order_items` joined to `products`, filtered on `oi.order_id = 6`.

```sql starter
SELECT oi.product_id, oi.quantity, oi.unit_price, oi.quantity * oi.unit_price
FROM order_items oi WHERE oi.order_id = 6 ORDER BY oi.product_id;
```

```sql solution
SELECT p.name, oi.quantity, oi.unit_price, oi.quantity * oi.unit_price AS line_total
FROM order_items oi
JOIN products p ON p.id = oi.product_id
WHERE oi.order_id = 6
ORDER BY p.name;
```
:::

:::sql id=db-05-sql4 db=shop xp=40 ordered=true
title: Revenue per customer
Return the customer's `name` and their total revenue from **shipped** orders only (sum of
`quantity * unit_price`). Biggest spender first; tiebreaker `name`. Customers without shipped
orders don't appear.

hint: Three tables: customers → orders → order_items.
hint: `WHERE o.status = 'shipped'`, then `GROUP BY c.id, c.name`.

```sql starter
SELECT c.name, sum(oi.quantity * oi.unit_price) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id = o.id
GROUP BY c.id, c.name
ORDER BY revenue DESC, c.name;
```

```sql solution
SELECT c.name, sum(oi.quantity * oi.unit_price) AS revenue
FROM customers c
JOIN orders o ON o.customer_id = c.id
JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'shipped'
GROUP BY c.id, c.name
ORDER BY revenue DESC, c.name;
```
:::

## LEFT JOIN: keep everything on the left

An INNER JOIN drops rows without a partner. Noah Becker has no orders, so he never shows up in
"customers with their orders". Often that's exactly the bug: a report of "orders per customer"
that forgets customers with zero orders.

`LEFT JOIN` keeps **every row of the left table**; where there's no match, the right table's
columns are **NULL**:

```sql
SELECT c.name, o.id AS order_id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
ORDER BY c.name;
-- … Noah Becker | NULL
```

Counting with a LEFT JOIN: use `count(o.id)`, **not** `count(*)`. Noah's row exists (with NULLs),
so `count(*)` would say 1; `count(o.id)` ignores NULLs and says 0.

### The anti-join: rows with no match

"Customers who never ordered", "products never sold", "users who never logged in" — the pattern
is LEFT JOIN + `WHERE right.id IS NULL`:

```sql
SELECT c.name
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL;
```

Why `o.id` and not some other column? Test a column that **can't be NULL in a real match** —
the right table's primary key (or the join column). If you tested a column that may be NULL in real
rows (imagine an `orders.shipped_at`), you'd also get customers whose orders simply haven't
shipped yet.

(`WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id)` does the same thing and
is often clearer — you'll see subqueries in the next lessons.)

:::warn title="A LEFT JOIN followed by an INNER JOIN"
Chains need care: once a table is optional, everything joined *to it* must be optional too.

```sql
SELECT c.name, oi.quantity
FROM customers c
LEFT JOIN orders o       ON o.customer_id = c.id
JOIN      order_items oi ON oi.order_id = o.id;   -- Noah is gone again!
```

Noah's row has `o.id = NULL`, so the inner join to `order_items` finds no partner and drops
him — the LEFT JOIN was wasted. Make the second join a `LEFT JOIN` too.
:::

:::sql id=db-05-sql5 db=shop xp=30 ordered=true
title: Orders per customer — including zero
Return every customer's `name` and their **number of orders**. Customers without orders must
appear with `0`. Order by `name`.

hint: `LEFT JOIN orders o ON o.customer_id = c.id`
hint: `count(o.id)`, not `count(*)` — the NULL row of a customer with no orders must count as 0.

```sql starter
SELECT c.name, count(*)
FROM customers c
JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name
ORDER BY c.name;
```

```sql solution
SELECT c.name, count(o.id)
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id, c.name
ORDER BY c.name;
```
:::

:::sql id=db-05-sql6 db=shop xp=30
title: Never ordered
Return the `name` and `email` of customers who have **never placed an order**.

hint: LEFT JOIN orders, then keep rows where the order side is NULL: `WHERE o.id IS NULL`.

```sql starter
SELECT c.name, c.email
FROM customers c
JOIN orders o ON o.customer_id = c.id;
```

```sql solution
SELECT c.name, c.email
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL;
```
:::

### ON vs WHERE in a LEFT JOIN

With an INNER JOIN, a condition in `ON` or in `WHERE` gives the same result. With a LEFT JOIN
they mean different things:

- A condition in **ON** decides *which right rows count as a match*. Left rows are kept anyway.
- A condition in **WHERE** runs *after* the join and filters the final rows — including the
  left rows you wanted to keep.

```sql
-- How many products over 100 does each category have? (want ALL categories)
SELECT c.name, count(p.id)
FROM categories c
LEFT JOIN products p ON p.category_id = c.id AND p.price > 100   -- in ON: keeps all categories
GROUP BY c.id, c.name
ORDER BY c.name;
-- Accessories 0 · Books 0 · Keyboards 0 · Mice 0 · Monitors 2

-- Moving "p.price > 100" to WHERE removes the NULL rows → only Monitors is left.
-- The LEFT JOIN has silently become an INNER JOIN.
```

Why? For Books, no product passes `p.price > 100`, so the LEFT JOIN produces one Books row with
`p.price = NULL`. In `WHERE`, `NULL > 100` is unknown and the row is thrown away. The rule:
**conditions on the optional (right) side go in `ON`; conditions on the preserved (left) side
go in `WHERE`** (e.g. `WHERE c.name <> 'Books'` is fine there).

:::quiz id=db-05-q1 xp=15
You want **all** customers, with their *shipped* orders if they have any. Which query is right?
- [ ] `… FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.status = 'shipped'`
- [x] `… FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status = 'shipped'`
- [ ] `… FROM customers c JOIN orders o ON o.customer_id = c.id AND o.status = 'shipped'`
> The WHERE version drops every customer without a shipped order (their `o.status` is NULL or
> another status), turning the LEFT JOIN into an INNER JOIN. The plain `JOIN` version is an inner
> join from the start — it also loses those customers. Filters on the *optional* side of a LEFT
> JOIN belong in ON.
:::

:::quiz id=db-05-q5 xp=15
Every customer has a row in `customers`; Noah has no orders. This query should list **all**
customers with their order lines. Why is Noah missing?

```sql
SELECT c.name, oi.product_id
FROM customers c
LEFT JOIN orders o       ON o.customer_id = c.id
JOIN      order_items oi ON oi.order_id = o.id;
```

- [ ] `LEFT JOIN` only keeps unmatched rows when there is an `ORDER BY`
- [x] The second, inner join needs `o.id` to match; Noah's `o.id` is NULL, so his row is dropped
- [ ] `order_items` has no `customer_id`, so the query is invalid
- [ ] Noah is missing because his `city` is NULL
> The LEFT JOIN does keep Noah (with NULL order columns), but the next join is an INNER JOIN, and
> `oi.order_id = NULL` is never true — so the row is removed again. Use `LEFT JOIN order_items`
> too. Joining `order_items` via `orders` is perfectly valid; it doesn't need a `customer_id`.
:::

:::sql id=db-05-sql7 db=shop xp=40 ordered=true
title: Expensive products per category
Return **every** category's `name` and how many of its products cost **more than 50**.
Categories with no such product must show `0`. Order by category name.

hint: Put the price condition in the `ON` clause of the LEFT JOIN, not in WHERE.

```sql starter
SELECT c.name, count(p.id)
FROM categories c
LEFT JOIN products p ON p.category_id = c.id
WHERE p.price > 50
GROUP BY c.id, c.name
ORDER BY c.name;
```

```sql solution
SELECT c.name, count(p.id)
FROM categories c
LEFT JOIN products p ON p.category_id = c.id AND p.price > 50
GROUP BY c.id, c.name
ORDER BY c.name;
```
:::

## RIGHT and FULL OUTER JOIN

`RIGHT JOIN` is a LEFT JOIN with the tables swapped — keep every row of the *right* table. Teams
usually rewrite it as a LEFT JOIN so queries read in one direction.

`FULL [OUTER] JOIN` keeps unmatched rows from **both** sides. It's the tool for
**reconciliation**: comparing two lists that should match (your orders vs. the payment
provider's charges, the catalogue vs. the warehouse) and showing what's missing on either side.

```text
catalog            warehouse          catalog c FULL JOIN warehouse w ON w.sku = c.sku
KB-1 Keyboard      KB-1 10            c.sku | c.name   | w.sku | w.qty
MS-1 Mouse         MN-1  0            KB-1  | Keyboard | KB-1  | 10      ← in both
MN-1 Monitor       HB-1  5            MN-1  | Monitor  | MN-1  | 0       ← in both
                                      MS-1  | Mouse    | NULL  | NULL    ← only in catalogue
                                      NULL  | NULL     | HB-1  | 5       ← only in warehouse
```

Because either side can be missing, **neither** `c.sku` nor `w.sku` is always filled in — the
usual trick is `COALESCE(c.sku, w.sku)` to get "the key" for every row. Add
`WHERE c.sku IS NULL OR w.sku IS NULL` to show only the mismatches.

:::sql id=db-05-sql8 db=empty xp=40 ordered=true
title: Reconcile catalogue and warehouse
Two systems list SKUs: `catalog(sku, name)` and `warehouse(sku, qty)`. Some SKUs exist in only
one of them. Return **every SKU from either table** with three columns: the sku, the catalogue
`name` (NULL if missing) and the warehouse `qty` (NULL if missing). Order by sku.

hint: `FULL JOIN warehouse w ON w.sku = c.sku`
hint: The sku itself can be NULL on one side — use `COALESCE(c.sku, w.sku)`.

```sql setup
CREATE TABLE catalog (sku text PRIMARY KEY, name text NOT NULL);
CREATE TABLE warehouse (sku text PRIMARY KEY, qty integer NOT NULL);
INSERT INTO catalog VALUES ('KB-1', 'Keyboard'), ('MS-1', 'Mouse'), ('MN-1', 'Monitor');
INSERT INTO warehouse VALUES ('KB-1', 10), ('MN-1', 0), ('HB-1', 5);
```

```sql starter
SELECT c.sku, c.name, w.qty
FROM catalog c
LEFT JOIN warehouse w ON w.sku = c.sku
ORDER BY c.sku;
```

```sql solution
SELECT COALESCE(c.sku, w.sku) AS sku, c.name, w.qty
FROM catalog c
FULL JOIN warehouse w ON w.sku = c.sku
ORDER BY 1;
```
:::

## CROSS JOIN

`CROSS JOIN` is the Cartesian product with no condition: every row with every row. It's rarely
what you want on big tables (10 000 × 10 000 = 100 million rows), but it's perfect for
generating combinations — sizes × colours, users × feature flags, every day × every store.

```sql
SELECT s.size, c.color FROM sizes s CROSS JOIN colors c;
-- 4 sizes × 3 colours = 12 rows
```

There is no `ON`: the row count is always *left rows × right rows*. That's also why a forgotten
join condition is so dangerous — it quietly turns a join into a cross join.

:::quiz id=db-05-q6 xp=10
`sizes` has 4 rows and `colors` has 3. A fifth colour is added. How many rows does
`sizes CROSS JOIN colors` return now?
- [ ] 9 (4 + 5)
- [x] 20 (4 × 5)
- [ ] 5 — one per colour
- [ ] 16 (4 × 4)
> A cross join pairs every row with every row, so the result is the **product** of the row counts:
> 4 × 5 = 20. Adding rows to either side multiplies the output, which is why an accidental cross
> join on two big tables can produce billions of rows. Sums (9) describe `UNION ALL`, not a join.
:::

:::sql id=db-05-sql9 db=empty xp=30 ordered=true
title: T-shirt variants
The shop sells a T-shirt in every combination of `sizes(size)` and `colors(color)`. Return one
column: the variant label `color-size` (e.g. `black-M`) for **every** combination. Order by
color, then the size's `sort_order`.

hint: `FROM colors c CROSS JOIN sizes s`
hint: `c.color || '-' || s.size`

```sql setup
CREATE TABLE sizes (size text PRIMARY KEY, sort_order integer NOT NULL);
CREATE TABLE colors (color text PRIMARY KEY);
INSERT INTO sizes VALUES ('S', 1), ('M', 2), ('L', 3), ('XL', 4);
INSERT INTO colors VALUES ('black'), ('white'), ('navy');
```

```sql starter
SELECT c.color FROM colors c ORDER BY c.color;
```

```sql solution
SELECT c.color || '-' || s.size
FROM colors c CROSS JOIN sizes s
ORDER BY c.color, s.sort_order;
```
:::

A related trick: `generate_series(start, stop, step)` is a function that creates rows out of thin
air — one per step. Use it as the **left** side of a LEFT JOIN and it fills the gaps in a time
series, so a chart shows "0 orders in August" instead of skipping August:

```sql
SELECT m FROM generate_series(timestamp '2025-01-01', timestamp '2025-03-01', interval '1 month') AS m;
-- 2025-01-01 00:00:00 · 2025-02-01 00:00:00 · 2025-03-01 00:00:00
```

Each generated month is matched with the orders whose `date_trunc('month', ordered_at)` equals
it; a month with no orders keeps one row with NULL order columns, and `count(o.id)` turns that
into `0`. Generate the same type as the column you compare with (`ordered_at` is a `timestamp`)
so no time-zone conversion sneaks into the comparison.

:::sql id=db-05-sql10 db=shop xp=45 ordered=true
title: A gap-free monthly chart
Return one row for **every month of 2025** (January to December): the month as text `YYYY-MM`
and the number of orders placed in that month (`0` if none). Oldest month first.

hint: `FROM generate_series(timestamp '2025-01-01', timestamp '2025-12-01', interval '1 month') AS m`
hint: `LEFT JOIN orders o ON date_trunc('month', o.ordered_at) = m`, then `count(o.id)`.
hint: `to_char(m, 'YYYY-MM')` formats the month; group and order by `m`.

```sql starter
SELECT to_char(date_trunc('month', ordered_at), 'YYYY-MM') AS month, count(*)
FROM orders GROUP BY 1 ORDER BY 1;
```

```sql solution
SELECT to_char(m, 'YYYY-MM') AS month, count(o.id)
FROM generate_series(timestamp '2025-01-01', timestamp '2025-12-01', interval '1 month') AS m
LEFT JOIN orders o ON date_trunc('month', o.ordered_at) = m
GROUP BY m
ORDER BY m;
```
:::

## Self-joins

A table can join **itself** — you just give it two different aliases. The classic case is a
hierarchy: `employees.manager_id` points to another row in `employees`.

```sql
SELECT e.name AS employee, m.name AS manager
FROM employees e
JOIN employees m ON m.id = e.manager_id;
```

Think of it as two copies of the table: `e` (the employee) and `m` (the manager). Read the ON
as "the manager row is the one whose `id` is my `manager_id`". The aliases aren't optional here:
`FROM employees JOIN employees` fails with *table name "employees" specified more than once*. Each
copy needs its own name so you can say which one you mean (`e.name` vs `m.name`).

With a plain JOIN the CEO disappears — her `manager_id` is NULL, and NULL never matches. Use
LEFT JOIN to keep her (with a NULL manager name). Self-joins are also how you compare a row with
a related row of the same table: "employees who earn more than their manager" is just a `WHERE`
comparing `e.salary` with `m.salary`.

:::sql id=db-05-sql11 db=shop xp=35 ordered=true
title: Who's the boss?
Return each employee's `name`, their `title`, and their **manager's name** (NULL for the CEO).
Order by the employee's `id`.

hint: `FROM employees e LEFT JOIN employees m ON m.id = e.manager_id`

```sql starter
SELECT e.name, e.title, e.manager_id FROM employees e ORDER BY e.id;
```

```sql solution
SELECT e.name, e.title, m.name
FROM employees e
LEFT JOIN employees m ON m.id = e.manager_id
ORDER BY e.id;
```
:::

:::sql id=db-05-sql12 db=shop xp=40 ordered=true
title: Close to the boss's salary
Return the `name` and `salary` of each employee together with their manager's `name` and
`salary` (4 columns), but only where the employee earns **at least 60%** of their manager's
salary. Order by employee name.

hint: Self-join, then `WHERE e.salary >= 0.6 * m.salary`.

```sql starter
SELECT e.name, e.salary, m.name, m.salary
FROM employees e
JOIN employees m ON m.id = e.manager_id
ORDER BY e.name;
```

```sql solution
SELECT e.name, e.salary, m.name, m.salary
FROM employees e
JOIN employees m ON m.id = e.manager_id
WHERE e.salary >= 0.6 * m.salary
ORDER BY e.name;
```
:::

## The row-multiplication trap

Here's the bug that has shipped wrong numbers to more CEOs than any other. Joining a row to a
"many" table **repeats** that row once per match. Joining it to **two** independent "many"
tables multiplies: each member is paired with each clip.

```sql
-- studio: project 1 has 3 members and 7 clips
SELECT p.title, count(pm.user_id) AS members, count(c.id) AS clips
FROM projects p
LEFT JOIN project_members pm ON pm.project_id = p.id
LEFT JOIN clips c            ON c.project_id  = p.id
GROUP BY p.id, p.title;
-- The Heist | 21 | 21      ← 3 members × 7 clips = 21 rows before grouping!
```

The same happens with `sum`: join orders → order_items and then `sum` an *order-level* amount
(like a shipping fee), and every order's fee is counted once per line item.

Fixes, in order of preference:

1. **Aggregate first, then join**: compute per-project counts in subqueries (or CTEs) and join
   the small results — each one is already one row per project, so nothing can multiply.
2. Use `count(DISTINCT …)` — correct for counts, but **not** for sums (two different lines can
   have the same amount).
3. Sanity-check: before trusting a report, run `count(*)` on the join and ask "should this be
   the number of orders, or the number of lines?"

Fix 1 looks like this:

```sql
SELECT p.title, COALESCE(m.n, 0) AS members, COALESCE(c.n, 0) AS clips
FROM projects p
LEFT JOIN (SELECT project_id, count(*) AS n FROM project_members GROUP BY project_id) m
       ON m.project_id = p.id
LEFT JOIN (SELECT project_id, count(*) AS n FROM clips GROUP BY project_id) c
       ON c.project_id = p.id
ORDER BY p.id;
-- The Heist | 3 | 7   (COALESCE because a project with no members has no row in m)
```

:::sql id=db-05-sql13 db=studio xp=50 ordered=true
title: Fix the multiplied counts
In the **studio** database, return every project's `title`, its **number of members** and its
**number of clips** (0 when there are none). The starter has the multiplication bug — fix it.
Order by project `id`.

hint: Counting distinct ids removes the duplicates: `count(DISTINCT pm.user_id)`.
hint: Or aggregate members and clips separately in subqueries and join the results.

```sql starter
SELECT p.title, count(pm.user_id), count(c.id)
FROM projects p
LEFT JOIN project_members pm ON pm.project_id = p.id
LEFT JOIN clips c ON c.project_id = p.id
GROUP BY p.id, p.title
ORDER BY p.id;
```

```sql solution
SELECT p.title, count(DISTINCT pm.user_id), count(DISTINCT c.id)
FROM projects p
LEFT JOIN project_members pm ON pm.project_id = p.id
LEFT JOIN clips c ON c.project_id = p.id
GROUP BY p.id, p.title
ORDER BY p.id;
```
:::

:::quiz id=db-05-q2 xp=15
`customers` has 10 rows, `orders` has 18; every order has a valid customer and one customer has
no orders. How many rows does `customers c LEFT JOIN orders o ON o.customer_id = c.id` return?
- [ ] 10
- [ ] 18
- [x] 19
- [ ] 180
> Each of the 18 orders matches one customer (18 rows), and the customer without orders is kept
> once with NULLs (+1). 10 is the tempting answer if you think "LEFT JOIN returns the left table"
> — but customers with several orders appear once **per order**. 18 is the INNER JOIN result
> (Noah missing), and 180 would be a CROSS JOIN.
:::

:::quiz id=db-05-q3 xp=15
Suppose `orders` had a `shipping_fee` column. An order with a fee of 5 has 3 line items. You join
`orders` to `order_items`, `GROUP BY o.id` and compute `sum(o.shipping_fee)`. What do you get for
that order?
- [ ] 5
- [x] 15
- [ ] 3
- [ ] An error: shipping_fee must be grouped
> The order row is repeated once per line item, so its fee is summed 3 times: 15. There's no
> error — `sum(…)` is an aggregate, so the column doesn't have to be grouped, which is exactly why
> this bug ships to production. Aggregate the order-level value without joining to the lines, or
> aggregate the lines first and join the result.
:::

:::pro title="Check the grain"
Before writing a report query, say out loud what **one row** of the result means ("one row per
customer per month"). Then check after every join whether the grain changed. Senior engineers do
this instinctively — it's how they catch multiplication bugs in code review.
:::

:::job title="ORMs join too"
EF Core's `.Include(p => p.Members).Include(p => p.Clips)` generates exactly this kind of
multi-join (it de-duplicates in memory, but the database still returns 21 rows for project 1).
EF Core even logs a warning about this "cartesian explosion". That's why it offers
`AsSplitQuery()` (one SQL query per included collection, configurable globally with
`UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery)`) — and why you need to understand
joins even if you never hand-write one. Expect reviewers to ask for `.Select(…)` projections
instead of deep `Include` chains on list endpoints.
:::

## Stacking and diffing results: UNION, INTERSECT, EXCEPT

A join puts rows **side by side**: the result gets more columns. Sometimes you want the opposite —
put two results **on top of each other**, or compare them: "everyone we should invite (customers
*and* staff)", "products in the catalogue but never shipped", "rows that differ between the old
and the new table after a migration". That's what the **set operations** do. They take two
complete queries and combine their *rows*:

| Operator | Returns | Duplicates |
|---|---|---|
| `A UNION ALL B` | every row of A, then every row of B | kept — no extra work |
| `A UNION B` | rows that are in A **or** B | removed (costs a sort or hash) |
| `A INTERSECT B` | rows that are in A **and** B | removed (`INTERSECT ALL` keeps them) |
| `A EXCEPT B` | rows of A that are **not** in B | removed (`EXCEPT ALL` keeps them) |

```sql
-- the summer-party guest list: customers and staff, with a label
SELECT name, 'customer' AS kind FROM customers
UNION ALL
SELECT name, 'employee' FROM employees
ORDER BY kind, name;
```

The rules:

- Both queries need the **same number of columns** with **compatible types**, matched by
  **position**, not by name. The result's column names come from the first query.
- `ORDER BY` and `LIMIT` go at the very end and apply to the **combined** result. To sort or
  limit one branch on its own, put that branch in parentheses.
- Rows are compared **as whole rows**, and here NULL counts as equal to NULL (unlike `=` and
  join conditions). Two rows that both have a NULL `city` count as duplicates for `UNION`.
- `INTERSECT` binds tighter than `UNION` and `EXCEPT`, which are evaluated left to right. When you
  mix operators, **use parentheses** — `A EXCEPT B UNION ALL C EXCEPT D` means
  `((A EXCEPT B) UNION ALL C) EXCEPT D`, which is almost never what you meant.

Prefer `UNION ALL` whenever duplicates are impossible (the branches are disjoint) or wanted. Plain
`UNION` silently deduplicates, which is extra work at best and a wrong count at worst: two
different customers named "Maria Garcia" collapse into one row.

### EXCEPT as an anti-join, and as a migration check

`EXCEPT` answers "what's in this list but not in that one?" — the same question as the anti-join
above, written as two independent queries:

```sql
SELECT id FROM products
EXCEPT
SELECT product_id FROM order_items;    -- products never ordered (none, in our shop)
```

Use the anti-join (or `NOT EXISTS`) when you need other columns of the left table; use `EXCEPT`
when you compare whole rows. Its killer use case is **checking data before and after a
migration**, a backfill or a rewrite of a report query: run the old and the new version and diff
them in both directions.

```sql
(SELECT id, email FROM customers_old EXCEPT SELECT id, email FROM customers_new)  -- lost or changed
UNION ALL
(SELECT id, email FROM customers_new EXCEPT SELECT id, email FROM customers_old); -- new or changed
-- zero rows = identical (as sets — compare count(*) too, or use EXCEPT ALL, if duplicates matter)
```

:::quiz id=db-05-q7 xp=15
`customers` has 10 rows in 5 different countries, 3 of them in Germany. How many rows does this
return?

```sql
SELECT country FROM customers
UNION
SELECT country FROM customers WHERE country = 'Germany';
```

- [ ] 13
- [ ] 10
- [x] 5
- [ ] 1
> `UNION` removes duplicate rows from the **whole** result, not just between the two branches —
> the first branch alone already repeats countries, and those repeats go too. What's left is each
> distinct country once: 5. 13 is `UNION ALL` (10 + 3 rows, nothing removed). 10 assumes only
> cross-branch duplicates are removed; 1 confuses it with `INTERSECT`.
:::

:::sql id=db-05-sql14 db=shop xp=35
title: Never shipped
Return the `id` and `name` of every product that has **never been part of a shipped order**
(order `status = 'shipped'`). Try it with `EXCEPT`.

hint: All products: `SELECT id, name FROM products`.
hint: `EXCEPT` the products that appear in shipped orders — join `order_items` to `orders` and filter on the status.

```sql starter
SELECT id, name FROM products
EXCEPT
SELECT p.id, p.name
FROM products p
JOIN order_items oi ON oi.product_id = p.id;
```

```sql solution
SELECT id, name FROM products
EXCEPT
SELECT p.id, p.name
FROM products p
JOIN order_items oi ON oi.product_id = p.id
JOIN orders o       ON o.id = oi.order_id
WHERE o.status = 'shipped';
```
:::

:::sql id=db-05-sql15 db=studio xp=35
title: Publishing editors
In the **studio** database, return the `id` and `display_name` of users who **both** own at least
one **published** project **and** are an `editor` on some project.

hint: Two lists of `(id, display_name)`: owners of published projects, and users with an editor membership.
hint: Rows in both lists: `INTERSECT`. (`UNION` would give everyone in either list.)

```sql starter
SELECT u.id, u.display_name
FROM users u JOIN projects p ON p.owner_id = u.id
WHERE p.published
UNION
SELECT u.id, u.display_name
FROM users u JOIN project_members pm ON pm.user_id = u.id
WHERE pm.role = 'editor';
```

```sql solution
SELECT u.id, u.display_name
FROM users u JOIN projects p ON p.owner_id = u.id
WHERE p.published
INTERSECT
SELECT u.id, u.display_name
FROM users u JOIN project_members pm ON pm.user_id = u.id
WHERE pm.role = 'editor';
```
:::

:::sql id=db-05-sql16 db=empty xp=45 ordered=true
title: Diff a migration
A migration copied `customers_old(id, email)` into `customers_new(id, email)`, and a teammate
suspects it lost or changed rows. Return every difference as three columns: `side`
(`'only_old'` or `'only_new'`), `id` and `email`. A row that changed shows up twice — once per
side. Order by `id`, then `side`.

hint: `SELECT id, email FROM customers_old EXCEPT SELECT id, email FROM customers_new` finds the lost/changed rows.
hint: Do the same in the other direction and stack both with `UNION ALL` — put each `EXCEPT` in parentheses.
hint: Add the label as a literal column in both halves of each EXCEPT, e.g. `SELECT 'only_old', id, email …`.

```sql setup
CREATE TABLE customers_old (id integer PRIMARY KEY, email text NOT NULL);
CREATE TABLE customers_new (id integer PRIMARY KEY, email text NOT NULL);
INSERT INTO customers_old VALUES
  (1, 'ada@example.com'), (2, 'linus@example.com'), (3, 'grace@example.com'), (4, 'margaret@example.com');
INSERT INTO customers_new VALUES
  (1, 'ada@example.com'), (2, 'Linus@Example.com'), (4, 'margaret@example.com'), (5, 'anders@example.com');
```

```sql starter
SELECT 'only_old' AS side, id, email FROM customers_old
EXCEPT
SELECT 'only_old', id, email FROM customers_new
ORDER BY id, side;
```

```sql solution
(SELECT 'only_old' AS side, id, email FROM customers_old
 EXCEPT
 SELECT 'only_old', id, email FROM customers_new)
UNION ALL
(SELECT 'only_new', id, email FROM customers_new
 EXCEPT
 SELECT 'only_new', id, email FROM customers_old)
ORDER BY id, side;
```
:::

:::cards id=db-05-cards1 xp=15 title="Joins"
Q: INNER JOIN keeps…?
A: Only pairs of rows where the ON condition is true.
Q: LEFT JOIN keeps…?
A: Every left row; right columns are NULL where there's no match.
Q: How to find rows without a match (anti-join)?
A: `LEFT JOIN … WHERE right.id IS NULL` (or `NOT EXISTS`).
Q: Counting with a LEFT JOIN?
A: `count(right.id)`, not `count(*)` — otherwise unmatched rows count as 1.
Q: Filter on the right table of a LEFT JOIN — ON or WHERE?
A: In ON. In WHERE it removes the NULL rows and turns it into an inner join.
Q: FULL JOIN is good for…?
A: Reconciliation — showing what's missing on either side.
Q: CROSS JOIN?
A: Every row × every row; for generating combinations.
Q: Self-join?
A: Joining a table to itself with two aliases, e.g. employee → manager.
Q: Row multiplication?
A: Joining to two independent many-sides multiplies rows; aggregate first or use count(DISTINCT).
Q: Do NULL join keys match each other?
A: No. `NULL = NULL` is unknown, so a row with a NULL key never finds a partner.
Q: LEFT JOIN orders, then (inner) JOIN order_items — what happens to customers without orders?
A: They're dropped again: the inner join can't match their NULL `o.id`. Make it a LEFT JOIN too.
Q: Get the key of every row after a FULL JOIN?
A: `COALESCE(left.key, right.key)` — either side may be NULL.
Q: Join vs set operation?
A: A join puts rows side by side (more columns); UNION / INTERSECT / EXCEPT stack or compare whole
   rows (same column count and types, matched by position).
Q: UNION vs UNION ALL?
A: UNION removes duplicates from the whole result (extra sort/hash); UNION ALL keeps every row.
   Default to UNION ALL unless you really want deduplication.
Q: Check that a migration didn't change data?
A: `(old EXCEPT new) UNION ALL (new EXCEPT old)` — zero rows means identical (as sets).
:::

## Recap

- A join pairs rows and keeps those that satisfy `ON`; outer joins add back unmatched rows with
  NULLs. A row is repeated once per partner, so always know the **grain** of your result.
- `JOIN` = inner; `LEFT JOIN` keeps all left rows (use `count(right.id)`); anti-join =
  `LEFT JOIN … WHERE right.id IS NULL`. Qualify columns with table aliases.
- Conditions on the optional side of a LEFT JOIN go in `ON`, not `WHERE` — and everything joined
  to an optional table must be a LEFT JOIN too.
- NULL join keys never match (not even each other).
- `FULL JOIN` for reconciliation (`COALESCE` the keys), `CROSS JOIN` (and `generate_series`) for
  combinations and gap-free series, self-joins for hierarchies.
- Joining to several many-sides multiplies rows — check the grain, aggregate first, or use
  `count(DISTINCT)` (never for sums).
- Set operations stack or compare whole rows: `UNION ALL` (keep all), `UNION` (deduplicate),
  `INTERSECT` (in both), `EXCEPT` (in the first only) — parenthesize when mixing them, and use
  `EXCEPT` both ways to diff data before and after a migration.
