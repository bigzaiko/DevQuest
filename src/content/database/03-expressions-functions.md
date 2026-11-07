---
id: db-03
title: Expressions, Functions & NULL
level: beginner
minutes: 90
xp: 130
summary: Compute new values in SQL — arithmetic, strings, dates, intervals and time zones, CASE, COALESCE, casts — and master three-valued NULL logic.
---

A query doesn't just *return* stored values — it can compute new ones: a gross price, a display
label, the number of days since sign-up, a "budget / premium" tier. Doing this in SQL is often
simpler and faster than fetching raw rows and looping over them in C# or TypeScript.

This lesson is a toolbox of the expressions you'll use daily, and ends with the most important
(and most misunderstood) topic in SQL: how `NULL` behaves.

An **expression** is anything that produces a value: a column (`price`), a literal (`1.19`,
`'Berlin'`), an operator (`price * 1.19`) or a function call (`round(…)`). You can put an
expression almost anywhere a column could go — in `SELECT`, `WHERE`, `ORDER BY` — and it is
evaluated **once per row**. Give a computed column a name with `AS`, otherwise Postgres invents
one like `?column?`.

## Arithmetic

The usual operators work: `+ - * /`, `%` (remainder), `^` (power), and functions like `round`,
`abs`, `ceil`, `floor`, `power`. Normal precedence applies (`*` before `+`); use parentheses
when in doubt.

```sql
SELECT name, price, price * 1.19 AS gross, price * stock AS stock_value
FROM products;
-- Wireless Mouse | 29.99 | 35.6881 | 2399.20
```

`round(x, 2)` rounds to two decimals — use it for display: `round(price * 1.19, 2)` gives
`35.69`. For `numeric` values, halves round **away from zero** (`round(2.5)` is `3`).

:::warn title="Integer division truncates"
If both sides are integers, `/` is **integer division**: the fractional part is thrown away.
`7 / 2` is `3`, `-7 / 2` is `-3`, and `9500 / 1000` is `9`. This is the same rule as C# and
Java (`7 / 2 == 3`), but surprising if you're used to JavaScript. Make one side a decimal *before*
dividing: `7 / 2.0`, `7::numeric / 2`, or `duration_ms / 1000.0` → `3.5`.

Also: dividing by zero is an **error** (`ERROR: division by zero`), not `Infinity` — one bad row
fails the whole query. `NULLIF` (below) is the fix.
:::

:::info title="numeric vs float"
`numeric` (used for prices in our shop, `numeric(10,2)`) is an **exact** decimal: `0.1 + 0.2` is
exactly `0.3`. `real` / `double precision` are binary floats like JavaScript's `number`:
`0.1::float8 + 0.2::float8` is `0.30000000000000004`. Use `numeric` for money, floats for
measurements where tiny errors don't matter. (In C#, `numeric` maps to `decimal`.)
:::

## Strings

| Expression | Result |
|---|---|
| `'Ada' \|\| ' ' \|\| 'Lovelace'` | `Ada Lovelace` (concatenation) |
| `concat('Ada', ' ', NULL, 'L')` | `Ada L` (`concat` skips NULLs) |
| `lower('Ada')`, `upper('Ada')` | `ada`, `ADA` |
| `length('Ada')` | `3` |
| `substring('Lovelace' from 1 for 4)` / `left('Lovelace', 4)` | `Love` |
| `trim('  hi  ')` | `hi` |
| `replace('a-b-c', '-', '/')` | `a/b/c` |
| `split_part('ada@example.com', '@', 2)` | `example.com` |
| `position('@' in 'ada@example.com')` | `4` |
| `concat_ws(', ', 'London', NULL, 'UK')` | `London, UK` ("with separator", skips NULLs) |

Two things trip up newcomers:

- **Single quotes are strings, double quotes are names.** `'Ada'` is text; `"Ada"` means a
  column called Ada (`ERROR: column "Ada" does not exist`). Double quotes are only for
  identifiers with capitals or spaces, which you should avoid anyway.
- String positions are **1-based**: `substring('Lovelace' from 1 for 4)` starts at the first
  character, unlike C#'s `Substring(0, 4)`.

The big gotcha: **`||` with a NULL gives NULL.** `'Berlin' || NULL` is `NULL`, so a label built
from a nullable column disappears entirely. Use `concat()` / `concat_ws()` or wrap the column in
`COALESCE` (below).

:::sql id=db-03-sql1 db=shop xp=20
title: Gross prices
Return each product's `name`, `price`, and the price **including 19% VAT rounded to 2
decimals** (three columns).

hint: `round(price * 1.19, 2)`

```sql starter
SELECT name, price FROM products;
```

```sql solution
SELECT name, price, round(price * 1.19, 2) AS gross FROM products;
```
:::

:::sql id=db-03-sql2 db=shop xp=25 ordered=true
title: What's on the shelf?
Return `name` and the **stock value** (`price * stock`) of every product, highest stock value
first. Tiebreaker: `name`.

hint: You can `ORDER BY` an alias: `ORDER BY stock_value DESC, name`.

```sql starter
SELECT name, price * stock AS stock_value FROM products ORDER BY name;
```

```sql solution
SELECT name, price * stock AS stock_value FROM products ORDER BY stock_value DESC, name;
```
:::

:::sql id=db-03-sql3 db=shop xp=25
title: Usernames from emails
Return each customer's `name` in **upper case** and their **username** — the part of the email
before the `@` (two columns).

hint: `upper(name)` and `split_part(email, '@', 1)`

```sql starter
SELECT name, email FROM customers;
```

```sql solution
SELECT upper(name), split_part(email, '@', 1) FROM customers;
```
:::

## COALESCE and NULLIF

`COALESCE(a, b, c, …)` returns the **first non-NULL** argument. It's how you give NULLs a
default:

```sql
SELECT name, COALESCE(city, 'unknown') AS city FROM customers;
-- … Noah Becker | unknown
```

`NULLIF(a, b)` does the reverse: it returns NULL **if a equals b**, otherwise a. Its classic job
is avoiding division by zero:

```sql
SELECT name, price / NULLIF(stock, 0) AS price_per_item_in_stock FROM products;
-- the 24" Monitor (stock 0) gives NULL instead of "ERROR: division by zero"
```

It also turns "magic" empty strings into proper NULLs: `NULLIF(trim(phone), '')`.

:::warn title="COALESCE needs one common type"
All arguments of `COALESCE` must be convertible to one type. `COALESCE(stock, 'none')` fails
with `invalid input syntax for type integer: "none"` — Postgres tries to read `'none'` as an
integer because `stock` is one. If you really want text, convert the column:
`COALESCE(stock::text, 'none')`. The same rule applies to the branches of `CASE`.
:::

:::quiz id=db-03-q4 xp=10
Customer Noah Becker has `city = NULL`. What does
`SELECT name || ' from ' || city FROM customers WHERE id = 10` return for him?
- [ ] `Noah Becker from `
- [ ] `Noah Becker from NULL`
- [x] `NULL` — the whole string disappears
- [ ] An error: cannot concatenate NULL
> `||` follows the general rule "anything combined with unknown is unknown", so one NULL operand
> makes the whole result NULL. It is not converted to an empty string (that's what `concat()`
> does) and not to the text `'NULL'`. Fix it with `COALESCE(city, 'unknown')` or `concat(…)`.
:::

:::sql id=db-03-sql4 db=shop xp=30
title: Shipping labels
Return one column per customer: a label `name, city (country)` — for example
`Ada Lovelace, London (UK)`. If the city is unknown, use the word `unknown` instead:
`Noah Becker, unknown (Germany)`.

hint: Concatenate with `||` and protect the nullable column with `COALESCE(city, 'unknown')`.
hint: Without COALESCE, Noah's whole label becomes NULL.

```sql starter
SELECT name || ', ' || city || ' (' || country || ')' FROM customers;
```

```sql solution
SELECT name || ', ' || COALESCE(city, 'unknown') || ' (' || country || ')' FROM customers;
```
:::

## CASE: if/else inside a query

`CASE` evaluates conditions top to bottom and returns the first match:

```sql
SELECT name, price,
  CASE
    WHEN price < 25  THEN 'budget'
    WHEN price < 100 THEN 'mid'
    ELSE 'premium'
  END AS tier
FROM products;
```

Because the **first** true `WHEN` wins, the order of the branches is part of the logic: the
`price < 100` branch only sees products that already failed `price < 25`. Swap the two lines
and nothing is ever `budget`, because a 14.50 desk mat is also `< 100`.

Without an `ELSE`, unmatched rows get NULL. There's also a short "switch" form that compares
one value with several constants:
`CASE status WHEN 'paid' THEN 'Paid' WHEN 'shipped' THEN 'On its way' ELSE 'Other' END`.
It uses `=` under the hood, so `CASE city WHEN NULL THEN …` **never** matches (`NULL = NULL` is
not true — see the last section); write `CASE WHEN city IS NULL THEN …` instead.

`CASE` works anywhere an expression does — in `ORDER BY` (custom sort orders!), in `WHERE`, and
inside aggregates (next lesson). All branches must return compatible types: mixing `'budget'`
and `0` in one `CASE` is an error.

:::quiz id=db-03-q5 xp=10
What tier does the Desk Mat (price `14.50`) get from this query?

```sql
SELECT name,
  CASE WHEN price < 100 THEN 'mid'
       WHEN price < 25  THEN 'budget'
       ELSE 'premium' END AS tier
FROM products;
```

- [ ] `budget` — 14.50 is under 25
- [x] `mid`
- [ ] `premium`
- [ ] NULL, because two branches match
> `CASE` stops at the **first** branch that is true. `14.50 < 100` is checked first and is true,
> so the `budget` branch is never reached for any product. Two matching branches are not an error
> and don't produce NULL — order the conditions from most specific to least specific.
:::

:::sql id=db-03-sql5 db=shop xp=30
title: Price tiers
Return `name`, `price` and a `tier` for each product: `budget` if the price is under 25,
`mid` if under 100, otherwise `premium`.

hint: `CASE WHEN … THEN … WHEN … THEN … ELSE … END`
hint: Order matters: the first matching WHEN wins.

```sql starter
SELECT name, price, 'mid' AS tier FROM products;
```

```sql solution
SELECT name, price,
  CASE WHEN price < 25 THEN 'budget'
       WHEN price < 100 THEN 'mid'
       ELSE 'premium' END AS tier
FROM products;
```
:::

:::sql id=db-03-sql6 db=shop xp=35 ordered=true
title: A custom sort order
The support team wants orders sorted by urgency: `pending` first, then `paid`, then `shipped`,
then `cancelled`. Within the same status, oldest first (`ordered_at`). Return `id` and `status`.

hint: `ORDER BY CASE status WHEN 'pending' THEN 1 WHEN 'paid' THEN 2 … END, ordered_at`
hint: Alphabetical order (`ORDER BY status`) puts cancelled first — not what we want.

```sql starter
SELECT id, status FROM orders ORDER BY status, ordered_at;
```

```sql solution
SELECT id, status FROM orders
ORDER BY CASE status WHEN 'pending' THEN 1 WHEN 'paid' THEN 2
                     WHEN 'shipped' THEN 3 ELSE 4 END,
         ordered_at, id;
```
:::

## Casting with ::

Postgres converts types with `CAST(x AS type)` or the shorter Postgres-style `x::type`:

```sql
SELECT '42'::integer + 1;          -- 43
SELECT '2025-03-01'::date;         -- a real date, not text
SELECT 9500::numeric / 1000;       -- 9.5000000000000000
SELECT price::integer FROM products;  -- rounds 29.99 → 30
SELECT ordered_at::date FROM orders;  -- drop the time part
```

Why cast at all? Because the type decides the behavior: `/` on integers truncates, `'10' < '9'`
is **true** for text (compared character by character) but false for numbers, and a text
`'2025-03-01'` can't be used in date arithmetic.

Note that `numeric → integer` **rounds** (`29.99::integer` is `30`), whereas C#'s `(int)29.99` and
JavaScript's `Math.trunc` cut off to `29`. Use `trunc(x)` or `floor(x)` if you want that.

A bad cast fails loudly: `'abc'::integer` → `invalid input syntax for type integer`. That's a
feature: Postgres won't silently turn garbage into `0`.

:::quiz id=db-03-q6 xp=10
What does `SELECT 9500 / 1000 * 1.0;` return?
- [ ] `9.5`
- [x] `9.0`
- [ ] `9.5000000000000000`
- [ ] An error: cannot mix integer and numeric
> Operators of the same precedence run left to right, so `9500 / 1000` happens **first** — two
> integers, integer division, `9`. Only then is `9 * 1.0` computed as numeric: `9.0`. Multiplying
> by `1.0` afterwards is too late; the decimal (or cast) has to be on one side of the `/`:
> `9500 / 1000.0` or `9500::numeric / 1000`. Mixing integer and numeric is fine — Postgres
> widens the integer automatically.
:::

:::sql id=db-03-sql7 db=studio xp=30
title: Milliseconds to seconds
In the **studio** database, clips store their length in `duration_ms`. For the clips of project
`1`, return `title` and the duration **in seconds, rounded to 1 decimal** (e.g. `9.5` for
9500 ms).

hint: `duration_ms / 1000` is integer division and gives `9` — cast first.
hint: `round(duration_ms::numeric / 1000, 1)`

```sql starter
SELECT title, duration_ms / 1000 FROM clips WHERE project_id = 1;
```

```sql solution
SELECT title, round(duration_ms::numeric / 1000, 1) FROM clips WHERE project_id = 1;
```
:::

## Dates, times and intervals

Storing dates as text (`'05/03/2025'` — May or March?) makes sorting, comparing and arithmetic
unreliable. Postgres has real temporal types instead:

| Type | Means | Example use |
|---|---|---|
| `date` | a calendar day | birthday, `created_at` in the shop |
| `timestamp` | date + wall-clock time, **no** time zone | a local appointment, e.g. `2025-03-01 09:00` at the dentist |
| `timestamptz` | an absolute **instant**, stored as UTC, shown in the session's time zone | "when did it happen" — use this by default |
| `interval` | a duration | `interval '2 hours 30 minutes'`, `interval '1 month'` |

:::warn title="The shop's `ordered_at` is a legacy smell"
`shop.orders.ordered_at` is a plain `timestamp`, so a value like `2025-01-05 10:12:00` doesn't say
*where* it was 10:12. London? The server's zone? A laptop in Berlin that wrote `DateTime.Now`?
Once rows from different places are mixed, nobody can untangle them. The **Tables, Types & Constraints** lesson's rule — use
`timestamptz` for points in time — is right, and the shop breaks it on purpose: you *will* meet
columns like this in older schemas. In this track, read the shop's values as UTC. The real fix is
a migration that states the zone the values were written in, once:
`ALTER TABLE orders ALTER COLUMN ordered_at TYPE timestamptz USING ordered_at AT TIME ZONE 'UTC'`
(`AT TIME ZONE` is explained below). The **studio** dataset already does it right: every
instant there is a `timestamptz`.
:::

Typed literals are written as `type 'value'`: `date '2025-03-01'`. Arithmetic works the way you'd
hope:

```sql
SELECT now();                                   -- current timestamptz
SELECT current_date;                            -- today
SELECT date '2025-03-01' + 30;                  -- 2025-03-31   (date + integer days)
SELECT date '2025-07-01' - date '2025-03-01';   -- 122          (date - date = integer days)
SELECT timestamp '2025-01-05 10:12' + interval '2 hours 30 minutes';  -- 2025-01-05 12:42:00
SELECT now() - interval '7 days';               -- one week ago
SELECT timestamp '2025-05-01' - timestamp '2025-04-29 12:00';  -- 1 day 12:00:00 (an interval)
```

Watch out for:

- **Only `date` accepts plain integers.** `timestamp '2025-01-01' + 1` is an error
  (`operator does not exist`); write `+ interval '1 day'`.
- **Months have different lengths.** `timestamp '2025-01-31' + interval '1 month'` is
  `2025-02-28` — Postgres clamps to the last day of the month.
- **`now()` is frozen per transaction.** It returns the start time of the current transaction,
  so every row of an `INSERT` gets the same timestamp. `clock_timestamp()` is the "real" clock.

Pulling dates apart and rounding them:

| Expression | Result for `2025-03-15 16:05:00` |
|---|---|
| `extract(year from ts)` | `2025` |
| `extract(month from ts)` | `3` |
| `extract(isodow from ts)` | `6` (Mon = 1 … Sun = 7) |
| `date_trunc('month', ts)` | `2025-03-01 00:00:00` |
| `date_trunc('day', ts)` | `2025-03-15 00:00:00` |
| `to_char(ts, 'YYYY-MM')` | `'2025-03'` (text, for display) |

`date_trunc` is the workhorse of reporting: "revenue per month" is `GROUP BY date_trunc('month',
ordered_at)` — next lesson.

`age(a, b)` gives a human-friendly interval: `age(date '2025-07-01', date '2024-01-15')` is
`1 year 5 mons 17 days`. For machine-friendly durations in seconds use
`extract(epoch from finished_at - started_at)`.

:::sql id=db-03-sql8 db=shop xp=30
title: Weekend shoppers
Return the `id` and `ordered_at` of every order placed on a **Saturday or Sunday**.

hint: `extract(isodow from ordered_at)` is 6 for Saturday and 7 for Sunday.

```sql starter
SELECT id, ordered_at FROM orders WHERE extract(isodow from ordered_at) = 7;
```

```sql solution
SELECT id, ordered_at FROM orders WHERE extract(isodow from ordered_at) IN (6, 7);
```
:::

:::sql id=db-03-sql9 db=shop xp=30 ordered=true
title: Customer tenure
Return each customer's `name` and how many **days** they had been a customer on
`2025-01-01` (that date minus `created_at`). Longest-standing customer first; tiebreaker `name`.

hint: Subtracting two dates gives an integer number of days: `date '2025-01-01' - created_at`.

```sql starter
SELECT name, created_at FROM customers ORDER BY created_at;
```

```sql solution
SELECT name, date '2025-01-01' - created_at AS days
FROM customers ORDER BY days DESC, name;
```
:::

:::sql id=db-03-sql10 db=studio xp=40 ordered=true
title: How long did each render take?
In the **studio** database, return `id`, `status` and the job's run time **in seconds**
(`finished_at - started_at`) for every render job, ordered by `id`. Jobs that haven't finished
should show `0` instead of NULL.

hint: `extract(epoch from finished_at - started_at)` turns an interval into seconds.
hint: Wrap it in `COALESCE(…, 0)`.

```sql starter
SELECT id, status, finished_at - started_at FROM render_jobs ORDER BY id;
```

```sql solution
SELECT id, status, COALESCE(extract(epoch from finished_at - started_at), 0) AS seconds
FROM render_jobs ORDER BY id;
```
:::

## Reporting in the user's time zone

A `timestamptz` is an instant: one point on the world's timeline. But "which **day** was that?"
depends on where you stand. Kai's monthly credits landed at `2025-07-01 00:00:00+00`. In Berlin
that was 02:00 on 1 July; in New York it was 20:00 on **30 June**. A "credits granted per day"
report for a New York team that simply writes `created_at::date` puts the row on the wrong day,
and month-end reports get the wrong month. Every report that groups by day, week or month has to
answer one question first: *whose* calendar?

### The session TimeZone

Every database connection has a `TimeZone` setting (`SHOW TimeZone;` — the practice database here
uses `UTC`). It decides more than how values are printed:

- how a `timestamptz` is **displayed** (`2025-06-30 20:00:00-04` in New York, `…00:00:00+00` in UTC),
- how a literal without an offset is **read** (`'2025-07-01 09:00'` means 09:00 *in the session zone*),
- which calendar `::date`, `date_trunc`, `extract` and `+ interval '1 day'` use on a `timestamptz`.

```sql
SET TimeZone = 'America/New_York';
SELECT timestamptz '2025-07-01 00:00:00+00';          -- 2025-06-30 20:00:00-04
SELECT (timestamptz '2025-07-01 00:00:00+00')::date;  -- 2025-06-30
SET TimeZone = 'UTC';
SELECT (timestamptz '2025-07-01 00:00:00+00')::date;  -- 2025-07-01 — same instant, other day
```

So why not just `SET TimeZone` to the user's zone? Because the setting belongs to the
**connection**, not the user. A pooled connection serves Mara in Berlin, then Jonas in New York,
and whatever one request set leaks into the next. Different tools (psql, DBeaver, your API) may
also use different defaults, so the same query gives different "days". The robust habit: keep
sessions and servers on UTC and make the zone **explicit in the query**, passed in as a
parameter from the user's profile (store an IANA name such as `'Europe/Berlin'` per user).

### AT TIME ZONE converts — and flips the type

`AT TIME ZONE` works in both directions, and the input type decides which one you get:

| Expression | In → out | Question it answers |
|---|---|---|
| `instant AT TIME ZONE 'Europe/Berlin'` | `timestamptz` → `timestamp` | "What did a wall clock in Berlin show at this instant?" |
| `wall_clock AT TIME ZONE 'Europe/Berlin'` | `timestamp` → `timestamptz` | "This was 09:00 in Berlin — which instant is that?" |

```sql
SELECT timestamptz '2025-07-01 00:00:00+00' AT TIME ZONE 'America/New_York';
-- 2025-06-30 20:00:00            (a timestamp: New York's wall clock)
SELECT timestamp '2025-03-30 09:00' AT TIME ZONE 'Europe/Berlin';
-- 2025-03-30 07:00:00+00         (a timestamptz: the instant, shown in UTC)
```

The result of the first form is a wall-clock value, so ordinary `::date` and `date_trunc` now
work on *Berlin's* (or New York's) calendar, no matter what the session says. That's the whole
recipe for "per local day" reports:

```sql
-- studio: each ledger row on New York's calendar
SELECT id, (created_at AT TIME ZONE 'America/New_York')::date AS ny_day, delta
FROM credit_ledger;

-- next lesson's GROUP BY, with the zone as a parameter from the app:
--   GROUP BY date_trunc('day', created_at AT TIME ZONE $1)
```

Postgres 12+ also has a three-argument form, `date_trunc('day', created_at, 'Europe/Berlin')`,
which returns the `timestamptz` of local midnight — handy when you want to keep instants.

:::warn title="Use zone names, not offsets"
`'+01:00'` is Berlin's offset in winter only; in summer it's `+02:00`. Worse, a bare offset string
in `AT TIME ZONE` follows the POSIX convention where the sign is **inverted**:
`AT TIME ZONE '+02:00'` means two hours *west* of UTC. Always use IANA names like
`'Europe/Berlin'` or `'America/New_York'` — they know every daylight-saving rule, past and future.
:::

### Daylight saving: a local day isn't always 24 hours

In Berlin, clocks jump from 02:00 to 03:00 on 30 March 2025 (a 23-hour day) and fall back from
03:00 to 02:00 on 26 October (a 25-hour day). Three consequences:

- **`interval '1 day'` and `interval '24 hours'` differ.** On a `timestamptz`, `+ interval '1 day'`
  means "same wall-clock time tomorrow" *in the session zone*, while `+ interval '24 hours'` adds
  exactly 24 hours. In UTC they're the same; across a change in Berlin they aren't:

  ```sql
  SET TimeZone = 'Europe/Berlin';
  SELECT timestamptz '2025-03-29 12:00+01' + interval '1 day';     -- 2025-03-30 12:00:00+02
  SELECT timestamptz '2025-03-29 12:00+01' + interval '24 hours';  -- 2025-03-30 13:00:00+02
  SET TimeZone = 'UTC';
  ```

- **Some local times don't exist, others happen twice.** 02:30 on 30 March never appears on a
  Berlin clock; 02:30 on 26 October appears twice. Postgres silently picks one interpretation, so
  don't build business rules on those times.
- **Recurring schedules need the zone, not an offset.** "Every day at 09:00 the user's time" is a
  local `time` plus a zone name. Compute each occurrence's instant on its own day:
  `(day + time '09:00') AT TIME ZONE 'Europe/Berlin'` (a `date` plus a `time` is a `timestamp`).
  Storing "08:00 UTC" instead is right in winter and an hour late all summer.

:::quiz id=db-03-q8 xp=15
The session time zone is UTC. What does this return?

```sql
SELECT timestamptz '2025-07-01 00:00:00+00' AT TIME ZONE 'America/New_York';
```

- [x] `2025-06-30 20:00:00`, a `timestamp` (no zone)
- [ ] `2025-06-30 20:00:00-04`, a `timestamptz`
- [ ] `2025-07-01 04:00:00`
- [ ] `2025-07-01 00:00:00+00` — `AT TIME ZONE` only changes the display
> On a `timestamptz`, `AT TIME ZONE` answers "what did a New York wall clock show at this
> instant?" — four hours behind UTC in summer, so 20:00 the evening before — and returns a plain
> `timestamp`. That type flip is the point: `::date` or `date_trunc` on the result now uses New
> York's calendar. `-04` would be a `timestamptz` (what you'd see after `SET TimeZone`, not from
> `AT TIME ZONE`). 04:00 adds the offset in the wrong direction. And it's not display-only: the
> result is a different value of a different type.
:::

:::sql id=db-03-sql12 db=studio xp=35 ordered=true
title: Ledger days, New York edition
The finance team works in New York. For every row of the **studio** `credit_ledger`, return
`id`, `delta` and the **New York calendar date** of `created_at` (zone `America/New_York`).
Order by `id`.

hint: `created_at::date` uses the session's zone (UTC here) — the monthly grants at 00:00 UTC land on the wrong day.
hint: Convert first, then take the date: `(created_at AT TIME ZONE 'America/New_York')::date`.

```sql starter
SELECT id, delta, created_at::date FROM credit_ledger ORDER BY id;
```

```sql solution
SELECT id, delta, (created_at AT TIME ZONE 'America/New_York')::date AS ny_day
FROM credit_ledger ORDER BY id;
```
:::

:::sql id=db-03-sql13 db=empty xp=40 ordered=true
title: A 09:00 reminder through daylight saving
Lena lives in Berlin and wants a reminder at **09:00 her local time** on each day in
`reminder_days(day date)`. Return `day` and the **instant** (`timestamptz`) the reminder must be
sent. Order by `day`. The starter assumes Berlin is always UTC+1 — check what happens after
30 March.

hint: `day + time '09:00'` is a `timestamp` (Berlin wall-clock time, no zone yet).
hint: `(day + time '09:00') AT TIME ZONE 'Europe/Berlin'` turns that wall-clock time into an instant.

```sql setup
CREATE TABLE reminder_days (day date PRIMARY KEY);
INSERT INTO reminder_days VALUES
  ('2025-01-15'), ('2025-03-29'), ('2025-03-30'), ('2025-07-01'), ('2025-10-26');
```

```sql starter
-- "Berlin is UTC+1, so 09:00 there is 08:00 UTC"
SELECT day, (day + time '08:00')::timestamptz AS send_at
FROM reminder_days ORDER BY day;
```

```sql solution
SELECT day, (day + time '09:00') AT TIME ZONE 'Europe/Berlin' AS send_at
FROM reminder_days ORDER BY day;
```
:::

## Three-valued logic: TRUE, FALSE and NULL

`NULL` is not a value like `0` or `''` — it is a marker for "**unknown / missing**". Noah's
city is NULL: we don't know it. Is Noah's city equal to Berlin? We can't say — so the answer
isn't false, it's *unknown*.

That's why in SQL a condition can be **true**, **false** or **unknown** (NULL). Any comparison
with NULL is unknown: `NULL = 1`, `NULL <> 1`, even `NULL = NULL` (two unknown cities are not
known to be the same city). Logical operators follow "what could the unknown be?" —
`TRUE OR ?` is true whatever `?` is, but `TRUE AND ?` depends on it:

| | `AND` | `OR` |
|---|---|---|
| `TRUE` op `NULL` | `NULL` | `TRUE` |
| `FALSE` op `NULL` | `FALSE` | `NULL` |
| `NULL` op `NULL` | `NULL` | `NULL` |

And `NOT NULL` (the expression, not the constraint) is `NULL`. `WHERE` keeps only **true** rows,
so unknown rows vanish silently. Consequences you will hit in real life:

- `WHERE city = NULL` returns **nothing**, not even Noah — it's unknown for every row, with no
  error or warning. Testing for NULL always uses `IS NULL` / `IS NOT NULL`.
- `WHERE city <> 'Berlin'` **does not return** customers with an unknown city.
- `WHERE x NOT IN (1, 2, NULL)` returns **no rows at all** — `x <> NULL` is unknown for every
  `x`. This bites hard with `NOT IN (SELECT …)` when the subquery can return a NULL. Prefer
  `NOT EXISTS`.
- Arithmetic with NULL is NULL: `price * NULL` is `NULL`.

Postgres gives you NULL-safe comparison: `a IS DISTINCT FROM b` treats NULL as a normal value
(`NULL IS DISTINCT FROM 'Berlin'` is **true**; `NULL IS DISTINCT FROM NULL` is **false**).

:::quiz id=db-03-q1 xp=15
What is `NULL = NULL` in PostgreSQL?
- [ ] `TRUE`
- [ ] `FALSE`
- [x] `NULL` (unknown)
- [ ] An error
> Two unknowns are not known to be equal, so the result is NULL (unknown) — not `TRUE`, which is
> what most programming languages would say for `null == null`, and not `FALSE` either. Use
> `IS NULL`, or `IS NOT DISTINCT FROM` for a NULL-safe equality test.
:::

:::quiz id=db-03-q2 xp=15
Which expressions evaluate to **TRUE**? (select all that apply)
- [x] `TRUE OR NULL`
- [ ] `TRUE AND NULL`
- [ ] `NOT NULL` (as an expression, e.g. `SELECT NOT NULL::boolean`)
- [x] `NULL IS NULL`
- [x] `NULL IS DISTINCT FROM 5`
> `TRUE OR anything` is TRUE. `TRUE AND NULL` is NULL — the result depends on the unknown.
> `NOT NULL` is NULL: "not unknown" is still unknown (don't confuse the expression with the
> `NOT NULL` column constraint). `IS NULL` and `IS DISTINCT FROM` never return NULL — they're the
> NULL-safe operators, so `NULL IS NULL` and `NULL IS DISTINCT FROM 5` are both TRUE.
:::

:::quiz id=db-03-q3 xp=15
Table `t(x)` contains the values 1, 2, 3. What does
`SELECT x FROM t WHERE x NOT IN (1, NULL)` return?
- [ ] 2 and 3
- [ ] 1, 2 and 3
- [x] No rows
- [ ] An error
> `x NOT IN (1, NULL)` means `x <> 1 AND x <> NULL`. The second part is unknown for every x, so the
> whole condition is never true. One NULL in a NOT IN list kills the result.
> "2 and 3" is the tempting answer — it's what you'd get with `NOT IN (1)`. There's no error:
> NULL in a list is perfectly legal, just useless here.
:::

:::quiz id=db-03-q7 xp=15
An audit query should find rows of `address_changes(old_city, new_city)` where the city
**changed** — including changes from NULL to `'Berlin'` and from `'Berlin'` to NULL. Which
condition is correct?
- [ ] `WHERE old_city <> new_city`
- [ ] `WHERE old_city != new_city`
- [ ] `WHERE NOT (old_city = new_city)`
- [x] `WHERE old_city IS DISTINCT FROM new_city`
> The first three are the same test in different spellings (`!=` is just an alias for `<>`), and
> all of them are *unknown* when either side is NULL — so exactly the NULL ↔ value changes are
> silently dropped. `IS DISTINCT FROM` treats NULL as an ordinary value: NULL vs `'Berlin'` is
> distinct (true), NULL vs NULL is not distinct (false). It's the standard tool for "did this
> value change?" checks, e.g. in triggers.
:::

:::sql id=db-03-sql11 db=shop xp=35
title: Everyone not in Berlin
Return the `name` of every customer who does **not** live in Berlin — **including** customers
whose city is unknown.

hint: `city <> 'Berlin'` drops the NULL city. Try `IS DISTINCT FROM`, or add `OR city IS NULL`.

```sql starter
SELECT name FROM customers WHERE city <> 'Berlin';
```

```sql solution
SELECT name FROM customers WHERE city IS DISTINCT FROM 'Berlin';
```
:::

:::pro title="Push formatting to the edge, keep logic in SQL"
Compute *values* in SQL (totals, tiers, durations), but leave *presentation* (currency symbols,
locales, "3 minutes ago") to the frontend. `to_char(price, 'FM999.00 €')` in SQL locks the output
to one locale and returns text your API can no longer sort or sum.
:::

:::job title="Time zones will find you"
Store instants as `timestamptz` and keep servers and sessions in UTC; convert to the user's zone
explicitly with `AT TIME ZONE` and an IANA zone name. A `timestamp` (without time zone)
column means "a wall-clock time somewhere" — fine for "the appointment is at 09:00 local time"
(and use `time` for a daily opening hour), wrong for "the
order was placed at…". Teams lose days debugging reports that are off by one hour twice a year.

From .NET, Npgsql (the driver under EF Core) maps `timestamptz` to a `DateTime` with
`Kind = Utc` (or a `DateTimeOffset`) and throws if you write a `DateTime` whose `Kind` is `Local`
**or `Unspecified`** (e.g. `new DateTime(2025, 1, 1)`) into it. Use `DateTime.UtcNow` or
`DateTime.SpecifyKind(x, DateTimeKind.Utc)`, never `DateTime.Now`.
:::

:::cards id=db-03-cards1 xp=15 title="Expressions & NULL"
Q: What is `7 / 2` in Postgres?
A: `3` — integer division. Use `7 / 2.0` or `7::numeric / 2` for `3.5`.
Q: `'Berlin' || NULL`?
A: NULL. Use `concat()` (skips NULLs) or `COALESCE(col, '')`.
Q: COALESCE(a, b, c)?
A: The first non-NULL argument — a default for NULLs.
Q: NULLIF(a, b)?
A: NULL if a = b, else a. Classic use: `x / NULLIF(y, 0)` to avoid division by zero.
Q: Two ways to cast?
A: `CAST(x AS integer)` and the Postgres shorthand `x::integer`.
Q: Group timestamps by month?
A: `date_trunc('month', ts)`.
Q: Interval to seconds?
A: `extract(epoch from interval_value)`.
Q: `TRUE AND NULL` / `TRUE OR NULL`?
A: NULL / TRUE.
Q: Why avoid `NOT IN (subquery)`?
A: If the subquery returns a NULL, the condition is never true and you get no rows. Use NOT EXISTS.
Q: NULL-safe "not equal"?
A: `a IS DISTINCT FROM b`.
Q: How do you test whether a column is NULL?
A: `col IS NULL` / `col IS NOT NULL`. `col = NULL` is never true.
Q: Two `CASE` branches both match — which wins?
A: The first one, top to bottom. Order conditions from most to least specific.
Q: `29.99::integer`?
A: `30` — casting numeric to integer rounds. Use `trunc()` / `floor()` to cut off.
Q: `timestamp` vs `timestamptz`?
A: `timestamp` is a wall-clock time with no zone; `timestamptz` is an absolute instant (stored as
   UTC). Use `timestamptz` for "when did it happen".
Q: `instant AT TIME ZONE 'Europe/Berlin'` returns…?
A: A `timestamp`: Berlin's wall-clock time at that instant. On a `timestamp` it goes the other way
   and returns the `timestamptz` instant.
Q: "Per local day" report?
A: `date_trunc('day', created_at AT TIME ZONE $1)` (or `(… AT TIME ZONE $1)::date`) with the user's
   IANA zone as a parameter — not `SET TimeZone` on a pooled connection.
Q: `+ interval '1 day'` vs `+ interval '24 hours'`?
A: Same in UTC. Across a DST change in the session zone, '1 day' keeps the wall-clock time
   (23 or 25 real hours), '24 hours' adds exactly 24.
Q: Why not `AT TIME ZONE '+01:00'`?
A: Offsets ignore daylight saving, and POSIX offset strings have an inverted sign. Use IANA names.
:::

## Recap

- An expression is evaluated once per row; name computed columns with `AS`.
- Arithmetic works as expected — except **integer / integer truncates** and `/ 0` is an error;
  cast to `numeric` before dividing, protect divisors with `NULLIF(x, 0)`. Use `numeric` for money.
- Strings: `||`, `concat`/`concat_ws`, `lower/upper`, `length`, `substring/left`, `split_part`,
  `trim`. Single quotes = text, double quotes = identifiers.
- `COALESCE` supplies defaults (all arguments one type); `NULLIF` turns a value into NULL.
- `CASE WHEN … THEN … ELSE … END` is if/else for any expression, including `ORDER BY`; the first
  true branch wins.
- `::type` casts (numeric → integer rounds); dates: `date ± integer`, `date - date`, `interval`,
  `extract`, `date_trunc`, `age`, `extract(epoch from …)`. Prefer `timestamptz` for instants (the
  shop's `timestamp` column is a legacy smell).
- "Which day?" depends on the zone: keep sessions in UTC, convert with
  `ts AT TIME ZONE 'Europe/Berlin'` (it flips `timestamptz` ↔ `timestamp`), use IANA names, and
  remember DST days have 23 or 25 hours.
- NULL means unknown: comparisons with it are unknown, `WHERE` drops unknown rows, `NOT IN` with a
  NULL returns nothing. Use `IS [NOT] NULL` and `IS [NOT] DISTINCT FROM`.
