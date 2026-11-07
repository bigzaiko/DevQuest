---
id: db-12
title: Transactions, Isolation & Locking
level: advanced
minutes: 65
xp: 200
summary: ACID, savepoints, MVCC and isolation levels, row locks and deadlocks — and the version-column pattern that turns a lost update into a clean 409 Conflict.
---

Up to now every query you wrote ran alone. Production is different: hundreds of requests hit
the same database at once. In the **studio** app (our branching-video SaaS), two editors save
the same project at the same moment, a user clicks "Render" twice, a worker deducts credits
while a refund is being booked. Each request is correct on its own. Together they can corrupt
data — silently, and only under load, which is the worst kind of bug.

This lesson is about the tools Postgres gives you to stay correct under concurrency:
**transactions**, **isolation levels**, **row locks**, and the **optimistic concurrency**
pattern you'll use in almost every REST API that edits documents.

:::info title="About the playground"
The SQL challenges run on a real PostgreSQL 18, but in a single browser connection — so there
is no "second session" to race against. Concurrency is explained with **timelines** (two
sessions side by side) and checked with quizzes; the challenges let you write the exact SQL
you'd ship.
:::

## ACID on one page

A **transaction** is a group of statements that the database treats as one unit. "ACID" is the
promise a transaction makes:

| Letter | Means | In practice |
|---|---|---|
| **A**tomicity | All or nothing | A credit transfer never debits one user without crediting the other. |
| **C**onsistency | Constraints hold before and after | `CHECK`, `FOREIGN KEY`, `UNIQUE` are never violated by a committed transaction. |
| **I**solation | Concurrent transactions don't see each other's half-done work | How much they *do* see is the **isolation level** — the big topic of this lesson. |
| **D**urability | Committed = survives a crash | Postgres writes the change to the **WAL** (write-ahead log) and flushes it before `COMMIT` returns. |

Atomicity and durability are mostly free: Postgres gives them to you. Consistency is what your
constraints (the **Tables, Types & Constraints** lesson) encode. **Isolation is where developers get burned**, because the default
level allows several anomalies that look impossible until you draw them on a timeline.

## BEGIN, COMMIT, ROLLBACK

Without an explicit transaction, every statement is its own transaction (**autocommit**).
To group statements:

```sql
BEGIN;
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
VALUES (15, 1, -50, 'gift to ivy', '2025-07-11 10:00+00');
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
VALUES (16, 3,  50, 'gift from mara', '2025-07-11 10:00+00');
COMMIT;      -- both rows become visible to everyone, atomically
```

- `COMMIT` makes the changes durable and visible to other sessions.
- `ROLLBACK` throws away everything since `BEGIN`.
- If **any statement fails** inside a transaction, the transaction is **aborted**: Postgres
  rejects every further statement with
  `current transaction is aborted, commands ignored until end of transaction block` until you
  `ROLLBACK`. There is no "skip the failed statement and carry on" — unless you use a savepoint.

In application code you rarely type `BEGIN`; your driver or ORM does it:

```csharp
// Npgsql + Dapper: explicit transaction on an open NpgsqlConnection
await using var tx = await conn.BeginTransactionAsync();
await conn.ExecuteAsync("INSERT INTO credit_ledger ... VALUES (...)", transaction: tx);
await conn.ExecuteAsync("INSERT INTO credit_ledger ... VALUES (...)", transaction: tx);
// Name the argument: Dapper's 2nd positional parameter is `param`, not the transaction.
await tx.CommitAsync();          // dispose without commit = rollback

// EF Core: SaveChanges() already wraps all pending changes in ONE transaction.
db.Ledger.Add(debit);
db.Ledger.Add(credit);
await db.SaveChangesAsync();     // BEGIN; INSERT; INSERT; COMMIT;

// EF Core, several SaveChanges (or raw SQL) that must succeed or fail together:
await using var tx2 = await db.Database.BeginTransactionAsync();
// … SaveChangesAsync() / ExecuteSqlAsync(…) …
await tx2.CommitAsync();
```

A common mistake is to call `SaveChangesAsync()` twice for one business operation (say, "create
the order", then "reserve the stock") without an explicit transaction: if the second call fails,
the first one is already committed and you are left with half an operation.

:::sql id=db-12-sql1 db=studio xp=30
title: An atomic credit transfer
Mara (user 1) gifts 50 credits to Ivy (user 3). Write a transaction that inserts **both**
ledger rows, then commits:

- id `15`: user `1`, delta `-50`, reason `'gift to ivy'`, created_at `'2025-07-11 10:00+00'`
- id `16`: user `3`, delta `50`, reason `'gift from mara'`, same created_at

The checker reads `id, user_id, delta, reason` of the new rows.

hint: `BEGIN; INSERT …; INSERT …; COMMIT;`
hint: A transfer is always two ledger rows that sum to zero.

```sql starter
BEGIN;
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
VALUES (15, 1, -50, 'gift to ivy', '2025-07-11 10:00+00');
COMMIT;
```

```sql solution
BEGIN;
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
VALUES (15, 1, -50, 'gift to ivy', '2025-07-11 10:00+00');
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
VALUES (16, 3, 50, 'gift from mara', '2025-07-11 10:00+00');
COMMIT;
```

```sql check
SELECT id, user_id, delta, reason FROM credit_ledger WHERE id >= 15 ORDER BY id;
```
:::

## Savepoints: a rollback point inside a transaction

A **savepoint** marks a point you can roll back to without abandoning the whole transaction:

```sql
BEGIN;
UPDATE projects SET published = true WHERE id = 2;
SAVEPOINT before_cleanup;
DELETE FROM project_members WHERE project_id = 1;   -- oops, wrong project
ROLLBACK TO SAVEPOINT before_cleanup;               -- undo only the DELETE
COMMIT;                                             -- the publish is kept
```

`ROLLBACK TO SAVEPOINT` also clears the "aborted" state after an error, which is how tools
implement "try this statement, and if it fails, keep going":

- **ORMs** use savepoints for *nested* transactions (EF Core creates one automatically when you
  call `SaveChanges` inside an already-open transaction; `tx.CreateSavepointAsync("x")` exists
  too).
- **PL/pgSQL** `BEGIN … EXCEPTION WHEN … END` blocks are implemented with an implicit savepoint
  (you'll meet them in the Views, Functions & Triggers lesson).
- `psql` has `\set ON_ERROR_ROLLBACK interactive`, which wraps every statement in a savepoint
  so a typo doesn't kill your long manual transaction.

:::warn title="Savepoints are not free"
Each savepoint creates a *subtransaction*. Thousands of them in one transaction (e.g. an
`EXCEPTION` block inside a loop over 100k rows) can slow the whole server down
(subtransaction cache overflow). Use them for error recovery, not as a per-row habit.
:::

:::sql id=db-12-sql2 db=studio xp=40
title: Undo only the mistake
This script publishes project 2 (bumping its version) and then runs a "cleanup" that deletes
the wrong project's members. The author tried to undo the cleanup with `ROLLBACK` — and lost
the publish too.

Fix it so the **publish is kept** (project 2: `published = true`, `version = 4`) and the
**members of project 1 are untouched** (still 3 rows). Keep the `DELETE` in the script; undo it
with the savepoint.

hint: `ROLLBACK TO SAVEPOINT before_cleanup;` instead of `ROLLBACK;`

```sql starter
BEGIN;
UPDATE projects SET published = true, version = version + 1 WHERE id = 2;
SAVEPOINT before_cleanup;
DELETE FROM project_members WHERE project_id = 1;
ROLLBACK;
COMMIT;
```

```sql solution
BEGIN;
UPDATE projects SET published = true, version = version + 1 WHERE id = 2;
SAVEPOINT before_cleanup;
DELETE FROM project_members WHERE project_id = 1;
ROLLBACK TO SAVEPOINT before_cleanup;
COMMIT;
```

```sql check
SELECT (SELECT published FROM projects WHERE id = 2),
       (SELECT version   FROM projects WHERE id = 2),
       (SELECT count(*)  FROM project_members WHERE project_id = 1);
```
:::

:::quiz id=db-12-q1 xp=10
Inside `BEGIN … COMMIT`, the third of five `INSERT`s violates a `UNIQUE` constraint. The app
ignores the error and sends the remaining two `INSERT`s and then `COMMIT`. What ends up in the
table?

- [ ] Rows 1, 2, 4 and 5
- [ ] Rows 1 and 2
- [x] Nothing — the transaction was aborted; the later statements are rejected and `COMMIT` acts as a `ROLLBACK`
- [ ] Rows 1–5, because the constraint is only checked at `COMMIT`
> After an error the transaction is in the *aborted* state. Every statement is refused until the
> transaction ends, and `COMMIT` on an aborted transaction just reports `ROLLBACK`. "Rows 1, 2, 4
> and 5" is what you might expect if you've used a database that keeps going after a failed
> statement (SQL Server without `XACT_ABORT`, for example) — Postgres never does that. To continue
> after an error you need `ROLLBACK TO SAVEPOINT`.
:::

## MVCC: why readers don't block writers

How can one session read a table while another session is updating it, without either one
waiting? Postgres uses **MVCC — Multi-Version Concurrency Control**:

- An `UPDATE` never overwrites a row in place. It writes a **new row version** (a *tuple*) and
  marks the old one as expired. A `DELETE` only marks the row as expired.
- Every tuple carries two hidden system columns: **`xmin`** (the transaction id that created
  it) and **`xmax`** (the transaction id that deleted/replaced it, or 0). Postgres also writes
  `xmax` when a transaction merely *locks* the row (`SELECT … FOR UPDATE`), so a non-zero `xmax`
  doesn't always mean "deleted".
- Each statement (or transaction, depending on the isolation level) works with a
  **snapshot**: "these transactions had committed when I started". A tuple is visible if its
  `xmin` is in the snapshot and its `xmax` isn't.

You can peek at the hidden columns:

```sql
SELECT xmin, xmax, id, title, version FROM projects WHERE id = 1;
```

Consequences you will feel in production:

| Effect | Why |
|---|---|
| Readers never block writers, writers never block readers | Each reads the version its snapshot allows. |
| Writers **do** block writers on the same row | Two transactions can't both create the "next" version of one row; the second waits for the first to commit or roll back. |
| Updates create garbage | Old versions (dead tuples) stay until **VACUUM** removes them — bloat and autovacuum are in the Production PostgreSQL lesson. |
| A long-running transaction is dangerous | Its old snapshot forces Postgres to keep every dead tuple newer than it — vacuum can't clean up behind it. |

## Isolation levels

The isolation level decides **which snapshot** your statements see and which conflicts
Postgres refuses. Postgres implements three distinct levels (asking for `READ UNCOMMITTED`
silently gives you Read Committed):

| Level | Dirty read | Non-repeatable read | Phantom read | Serialization anomaly (e.g. write skew) |
|---|---|---|---|---|
| Read Committed **(default)** | never | possible | possible | possible |
| Repeatable Read | never | never | never *(in Postgres)* | possible |
| Serializable | never | never | never | never |

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;   -- or: BEGIN; SET TRANSACTION ISOLATION LEVEL …;
SHOW transaction_isolation;
COMMIT;
```

A **dirty read** (seeing another transaction's *uncommitted* change) is impossible in
Postgres at every level — uncommitted tuples are never in anyone else's snapshot.

### Read Committed: a fresh snapshot per statement

In Read Committed, **each statement** takes a new snapshot. Within one transaction, two
identical `SELECT`s can return different results if another transaction committed in between —
a **non-repeatable read**:

| t | Session A (Read Committed) | Session B |
|---|---|---|
| 1 | `BEGIN;` | |
| 2 | `SELECT plan FROM users WHERE id = 3;` → `free` | |
| 3 | | `UPDATE users SET plan = 'pro' WHERE id = 3;` (autocommit) |
| 4 | `SELECT plan FROM users WHERE id = 3;` → **`pro`** | |
| 5 | `COMMIT;` | |

New rows that appear between two statements are **phantoms**:
`SELECT count(*) FROM render_jobs WHERE status = 'queued'` can return 3 and then 4 in the same
transaction.

For most web requests this is fine: a request reads a little, writes a little, commits fast.
But it means **"I checked, then I wrote" is not safe** under Read Committed — the world may
have changed between the check and the write.

One more Read Committed rule matters a lot: when an `UPDATE`/`DELETE` finds a row that another
transaction is changing, it **waits**; after that transaction commits, it **re-evaluates its
`WHERE` clause against the new row version** and updates it only if it still matches:

| t | Session A | Session B |
|---|---|---|
| 1 | `BEGIN;` `UPDATE render_jobs SET status='running' WHERE id = 7 AND status = 'queued';` → 1 row | |
| 2 | | `UPDATE render_jobs SET status='running' WHERE id = 7 AND status = 'queued';` … **waits** |
| 3 | `COMMIT;` | |
| 4 | | re-checks row 7: status is now `running` → **0 rows** |

That re-check is why a single conditional `UPDATE … WHERE status = 'queued'` is a safe
compare-and-swap, while `SELECT` followed by `UPDATE` is not. Remember it — the job queue in
the Job Queues lesson is built on it.

:::quiz id=db-12-q2 xp=15
Both sessions use the default isolation level.

| t | Session A | Session B |
|---|---|---|
| 1 | `BEGIN;` | |
| 2 | | `BEGIN;` |
| 3 | | `UPDATE projects SET title = 'Heist 2' WHERE id = 1;` |
| 4 | `SELECT title FROM projects WHERE id = 1;` | |
| 5 | | `COMMIT;` |
| 6 | `SELECT title FROM projects WHERE id = 1;` | |

What do A's two `SELECT`s return?

- [ ] t4 blocks until B commits, then both return `Heist 2`
- [ ] `Heist 2`, then `Heist 2`
- [x] `The Heist`, then `Heist 2`
- [ ] `The Heist`, then `The Heist`
> No dirty reads: at t4 B hasn't committed, so A sees the old version — and readers never wait
> for writers. At t6 Read Committed takes a fresh snapshot that includes B's commit: a
> non-repeatable read. Under Repeatable Read, t6 would still return `The Heist`.
:::

### Repeatable Read: one snapshot for the whole transaction

In Repeatable Read the snapshot is taken at the **first statement** of the transaction and used
until `COMMIT`. Every read is consistent with one moment in time — perfect for reports and
exports that run several queries ("totals must match the detail rows").

The price: if you try to **update a row that someone else changed and committed after your
snapshot**, Postgres can't re-check like Read Committed does (you'd be acting on data your
snapshot can't see), so it aborts you:

| t | Session A (Repeatable Read) | Session B |
|---|---|---|
| 1 | `BEGIN ISOLATION LEVEL REPEATABLE READ;` | |
| 2 | `SELECT version FROM projects WHERE id = 1;` → 14 | |
| 3 | | `UPDATE projects SET version = 15 WHERE id = 1;` (autocommit) |
| 4 | `SELECT version FROM projects WHERE id = 1;` → **still 14** | |
| 5 | `UPDATE projects SET title = 'x' WHERE id = 1;` | |
| 6 | **ERROR: could not serialize access due to concurrent update** (SQLSTATE `40001`) | |

The right reaction to `40001` is always the same: **roll back and retry the whole
transaction** from the beginning — with fresh reads.

:::quiz id=db-12-q3 xp=15
A nightly export runs `BEGIN ISOLATION LEVEL REPEATABLE READ;` and then 10 `SELECT`s over 3
minutes while users keep editing. Which statements are true? (Select all that apply.)

- [x] All 10 queries see the database as of the first query's snapshot
- [ ] The export blocks users from editing until it commits
- [x] Rows inserted by users during the export do not appear in later queries of the export
- [x] Holding the transaction open for 3 minutes keeps VACUUM from removing dead tuples newer than its snapshot
> Repeatable Read gives a stable snapshot without blocking anyone — MVCC means readers never take
> locks that stop writers, so "blocks users" is the wrong mental model from lock-based databases.
> Because the snapshot is frozen, new rows simply aren't visible to it. The cost is on cleanup:
> dead tuples that the old snapshot might still need can't be vacuumed until it ends.
> Read-only reporting transactions can also add `READ ONLY` (and `DEFERRABLE` with
> Serializable) to make intent explicit.
:::

### Serializable: as if transactions ran one at a time

Repeatable Read still allows **write skew**: two transactions read overlapping data, make
decisions based on it, and write *different* rows — so no row-level conflict is ever detected.

Studio rule: *"a project may have at most 3 editors"*. Project 1 already has 2 editors (Jonas
and Kai), and two admins add one more editor each at the same moment — A adds Omar (user 4), B
adds Lena (user 5):

| t | Session A (Repeatable Read) | Session B (Repeatable Read) |
|---|---|---|
| 1 | `SELECT count(*) FROM project_members WHERE project_id=1 AND role='editor';` → 2 | |
| 2 | | same query → 2 |
| 3 | app: 2 < 3, OK → `INSERT INTO project_members VALUES (1, 4, 'editor');` | |
| 4 | | app: 2 < 3, OK → `INSERT INTO project_members VALUES (1, 5, 'editor');` |
| 5 | `COMMIT;` ✅ | `COMMIT;` ✅ → **4 editors** |

Neither transaction touched a row the other wrote, so Repeatable Read sees no conflict. Under
**Serializable**, Postgres tracks *what each transaction read* (predicate locks — "SSI",
Serializable Snapshot Isolation). It notices that A's read was invalidated by B's write and
vice versa, and aborts one of them with `40001 could not serialize access due to read/write
dependencies`. The retry re-counts, sees 3, and refuses.

Serializable is the easiest level to *reason* about — "if every transaction is correct alone,
they're correct together" — but you **must** have a retry loop:

```csharp
for (var attempt = 1; ; attempt++)
{
    try
    {
        await using var tx = await conn.BeginTransactionAsync(IsolationLevel.Serializable);
        var editors = await CountEditors(conn, tx, projectId);
        if (editors >= 3) throw new PlanLimitException();
        await AddEditor(conn, tx, projectId, userId);
        await tx.CommitAsync();
        return;
    }
    catch (PostgresException e) when (
        e.SqlState is PostgresErrorCodes.SerializationFailure      // 40001
                   or PostgresErrorCodes.DeadlockDetected          // 40P01
        && attempt < 5)
    {
        await Task.Delay(Random.Shared.Next(10, 50) * attempt);    // small jittered backoff
    }
}
```

:::quiz id=db-12-q4 xp=15
In the editor-limit timeline above, which fixes actually prevent the 4th editor?
(Select all that apply.)

- [x] Run both transactions at `SERIALIZABLE` and retry on `40001`
- [x] At Read Committed, lock the parent row first: `SELECT … FROM projects WHERE id = 1 FOR UPDATE`, then count and insert
- [ ] Run both at `REPEATABLE READ`
- [ ] Do the count and the insert in the same transaction at Read Committed
> Write skew needs either Serializable (Postgres detects the read/write dependency) or an
> explicit lock that makes the two transactions take turns. Locking the **project** row works
> because both transactions must lock the same row before deciding — the second waits, then
> counts 3. This works at Read Committed because the count after the lock wait takes a new
> snapshot. Under Repeatable Read the snapshot is taken by the first statement (the
> `FOR UPDATE` itself, before the wait), so the second transaction would still count 2. The tempting wrong answer is "same transaction at Read Committed": being in one
> transaction makes *your* statements atomic, but it doesn't stop the *other* transaction from
> counting 2 at the same time. Repeatable Read doesn't help either — the two inserts touch
> different rows, so there is no row conflict to detect.
:::

## The lost update problem

The most common concurrency bug in web apps isn't exotic — it's **read-modify-write in the
application**:

| t | Request A (editor Mara) | Request B (editor Jonas) |
|---|---|---|
| 1 | `SELECT doc FROM projects WHERE id = 1;` → fps 30, autoplay true | |
| 2 | | `SELECT doc FROM projects WHERE id = 1;` → same |
| 3 | user changes fps to 60 | user turns autoplay off |
| 4 | `UPDATE projects SET doc = '{…fps:60, autoplay:true…}' WHERE id = 1;` | |
| 5 | | `UPDATE projects SET doc = '{…fps:30, autoplay:false…}' WHERE id = 1;` |

Both requests succeed. Mara's fps change is **gone** — B overwrote it with the stale copy it
read at t2. No error, no log line. There are three standard fixes, and you should know when to
pick each.

### Fix 1: let the database do the arithmetic

If the change can be expressed relative to the current value, do it in one statement. The row
lock taken by `UPDATE` plus the Read Committed re-check make this safe:

```sql
-- ❌ app reads views = 41, computes 42, writes 42 (two requests → 42, not 43)
UPDATE clip_stats SET views = 42 WHERE clip_id = 1;
-- ✅ atomic, no matter how many requests run at once
UPDATE clip_stats SET views = views + 1 WHERE clip_id = 1;
-- ✅ conditional: only if enough stock/credits/seats remain — 0 rows means "no"
UPDATE wallets SET balance = balance - 40 WHERE user_id = 4 AND balance >= 40;
```

:::sql id=db-12-sql3 db=empty xp=50
title: Atomic counters with upsert
`clip_stats(clip_id, views)` counts views per clip. A batch of events arrives: clip `2` was
viewed **3** more times and clip `4` (which has no row yet) **1** time.

Record both in **one** `INSERT … ON CONFLICT … DO UPDATE` statement that adds to the existing
count (never overwrite it), and return `clip_id, views` of the affected rows.

hint: `ON CONFLICT (clip_id) DO UPDATE SET views = clip_stats.views + EXCLUDED.views`
hint: `EXCLUDED` is the row you tried to insert.

```sql setup
CREATE TABLE clip_stats (clip_id integer PRIMARY KEY, views integer NOT NULL);
INSERT INTO clip_stats VALUES (1, 41), (2, 9), (3, 120);
```

```sql starter
INSERT INTO clip_stats (clip_id, views)
VALUES (2, 3), (4, 1)
RETURNING clip_id, views;
```

```sql solution
INSERT INTO clip_stats (clip_id, views)
VALUES (2, 3), (4, 1)
ON CONFLICT (clip_id) DO UPDATE SET views = clip_stats.views + EXCLUDED.views
RETURNING clip_id, views;
```
:::

:::info title="Atomic is not the same as idempotent"
The **INSERT, UPDATE, DELETE & Upserts** lesson advised upserts that set **absolute** values rather than `+ 1`, and here we insisted on
adding. Both hold, because they protect against different failures. Adding inside the statement
is **atomic**: concurrent requests can't lose each other's views, which is the lost-update
problem this section is about. But it is **not idempotent**: if the same batch is delivered twice
(a retry, a redelivered queue message), the views are counted twice. Real event pipelines need
both properties, so they pair the increment with a dedupe table keyed by the event or batch id:

```sql
WITH fresh AS (
  INSERT INTO processed_batches (batch_id) VALUES ($1)
  ON CONFLICT DO NOTHING
  RETURNING batch_id                   -- no row if this batch was already applied
)
INSERT INTO clip_stats (clip_id, views)
SELECT v.clip_id, v.views
FROM (VALUES (2, 3), (4, 1)) AS v(clip_id, views), fresh
ON CONFLICT (clip_id) DO UPDATE SET views = clip_stats.views + EXCLUDED.views;
```

The first delivery records the batch id and increments; a redelivery finds the id, `fresh` is
empty, and the cross join with it inserts nothing. Use absolute values when you can (they're
idempotent by nature); use increments plus a dedupe key when the source only tells you deltas.
:::

### Fix 2: pessimistic locking with SELECT … FOR UPDATE

When the decision needs logic the database can't express in one statement (call a pricing
service, validate a complex document…), lock the row first. `SELECT … FOR UPDATE` takes the
same row lock an `UPDATE` would; anyone else who tries to lock or modify that row **waits**
until you commit:

```sql
BEGIN;
SELECT id FROM users WHERE id = 4 FOR UPDATE;            -- the mutex
SELECT coalesce(sum(delta), 0) FROM credit_ledger WHERE user_id = 4;  -- balance 130
-- app decides: 130 >= 60 → OK
INSERT INTO credit_ledger (…) VALUES (…, 4, -60, 'ai transition', …);
COMMIT;                                                  -- lock released
```

Notice the trick: you can't `FOR UPDATE` an aggregate (`sum()` has no single row to lock — try
it, Postgres refuses), and a ledger has no row to lock yet for the *new* entry. So you lock a
**parent row** (`users`) that every credit-changing transaction agrees to lock first. That's a
very common pattern: lock the aggregate root.

This relies on **Read Committed** (the default): the `sum()` after the lock wait takes a fresh
snapshot and sees the other transaction's committed debit. Under Repeatable Read the snapshot is
fixed by the first statement — the `FOR UPDATE` itself, taken *before* it waited — so the `sum()`
would still see the old balance. (If the other transaction had *updated* the locked row,
Repeatable Read would raise `40001` instead; merely locking it doesn't.)

Postgres has four row-lock strengths. Each blocks the ones marked ✗:

| Requested ↓ / held → | FOR KEY SHARE | FOR SHARE | FOR NO KEY UPDATE | FOR UPDATE |
|---|---|---|---|---|
| **FOR KEY SHARE** | ✓ | ✓ | ✓ | ✗ |
| **FOR SHARE** | ✓ | ✓ | ✗ | ✗ |
| **FOR NO KEY UPDATE** | ✓ | ✗ | ✗ | ✗ |
| **FOR UPDATE** | ✗ | ✗ | ✗ | ✗ |

- A plain `UPDATE` takes **FOR NO KEY UPDATE** (unless it changes a key column used by a foreign
  key), and a foreign-key check on insert takes **FOR KEY SHARE** on the parent — that's why
  inserting a clip doesn't wait for someone renaming the project.
- `FOR UPDATE` is the strongest: use it when you'll update or delete the row.
- `FOR SHARE`: "nobody may change this row until I commit, but others may read-lock it too".
- `NOWAIT` errors immediately instead of waiting (`55P03 lock_not_available`); `SKIP LOCKED`
  silently skips locked rows — the heart of the Job Queues lesson.

:::warn title="Never hold a lock across a network call or user think time"
`BEGIN; SELECT … FOR UPDATE;` → call Stripe → wait for the HTTP response → `COMMIT` means every
other request touching that user queues up behind a third-party API. Keep locked transactions
to milliseconds; do slow work before or after.
:::

:::sql id=db-12-sql4 db=studio xp=60
title: Debit credits only if the balance covers it
Omar (user 4, balance 130) and Ivy (user 3, balance 20) both start an AI transition costing
**60** credits. In **one transaction**:

1. Lock both users' rows with `SELECT … FOR UPDATE`, in **id order** (you'll see why in the
   deadlock section).
2. Insert a debit row only for users whose current balance (sum of their `delta`) is at least
   60: id = `100 + user_id`, delta `-60`, reason `'ai transition'`, created_at
   `'2025-07-11 10:00+00'`.
3. `COMMIT`.

The checker reads `id, user_id, delta` of all ledger rows with id > 14.

hint: `INSERT INTO credit_ledger (…) SELECT 100 + u.id, u.id, -60, … FROM users u WHERE u.id IN (3, 4) AND (…balance subquery…) >= 60`
hint: Balance: `(SELECT coalesce(sum(delta), 0) FROM credit_ledger l WHERE l.user_id = u.id)`

```sql starter
BEGIN;
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at) VALUES
  (103, 3, -60, 'ai transition', '2025-07-11 10:00+00'),
  (104, 4, -60, 'ai transition', '2025-07-11 10:00+00');
COMMIT;
```

```sql solution
BEGIN;
SELECT id FROM users WHERE id IN (3, 4) ORDER BY id FOR UPDATE;
INSERT INTO credit_ledger (id, user_id, delta, reason, created_at)
SELECT 100 + u.id, u.id, -60, 'ai transition', '2025-07-11 10:00+00'
FROM users u
WHERE u.id IN (3, 4)
  AND (SELECT coalesce(sum(delta), 0) FROM credit_ledger l WHERE l.user_id = u.id) >= 60;
COMMIT;
```

```sql check
SELECT id, user_id, delta FROM credit_ledger WHERE id > 14 ORDER BY id;
```
:::

:::quiz id=db-12-q7 xp=15
Spot the bug. This endpoint runs at the default isolation level; Ivy (balance 20) double-clicks
"Export" (cost 15), so two requests arrive at the same moment. (Assume `credit_ledger.id` is an
identity column here, so the `INSERT` can omit it.)

```csharp
await using var tx = await conn.BeginTransactionAsync();
var balance = await conn.ExecuteScalarAsync<long>(
    "SELECT coalesce(sum(delta), 0) FROM credit_ledger WHERE user_id = @u", new { u = 3 }, tx);
if (balance < 15) return Results.BadRequest("insufficient credits");
await conn.ExecuteAsync(
    "INSERT INTO credit_ledger (user_id, delta, reason, created_at) VALUES (3, -15, 'export', now())",
    transaction: tx);
await tx.CommitAsync();
```

- [ ] Nothing — the transaction makes the check and the insert atomic
- [x] Both requests can read 20 before either commits, so both insert −15 and the balance goes to −10
- [ ] The second request blocks on the `SELECT` until the first commits, so it correctly sees 5
- [ ] Postgres raises `40001` for the second request because both touched the same user
> A transaction gives all-or-nothing, not mutual exclusion. At Read Committed a plain `SELECT`
> takes no lock and never waits for writers, so both requests read 20, both pass the check, and
> both inserts succeed (they are *different* rows, so nothing conflicts and no `40001` appears).
> Fix it by locking the aggregate root first (`SELECT … FROM users WHERE id = 3 FOR UPDATE`), by
> using `SERIALIZABLE` with a retry loop, or by keeping a balance column and debiting it with one
> conditional `UPDATE … WHERE balance >= 15`.
:::

### Fix 3: optimistic concurrency with a version column

Pessimistic locks work inside one request. But the real lost update in a SaaS editor spans
**minutes**: Mara loads the project in the browser, edits for five minutes, then saves. You
can't hold a database lock for five minutes (and the HTTP requests use different connections
anyway).

The solution is **optimistic concurrency control**: don't lock — *detect* the conflict at
save time. Every row carries a `version` (the studio `projects` table has one). The client
remembers the version it loaded and sends it back with the save:

```sql
-- $1 = project id, $2 = version the client loaded, $3 = new document
UPDATE projects
SET    doc = $3, version = version + 1, updated_at = now()
WHERE  id = $1 AND version = $2
RETURNING version;
```

- **1 row returned** → the save won; send the new version back to the client.
- **0 rows** → someone saved in between (the version moved on) — or the project doesn't exist.
  The API answers **409 Conflict**; the client reloads, shows a diff or merges, and lets the
  user retry.

It's a compare-and-swap on the version, and it's atomic thanks to the row lock + re-check you
saw earlier: of two concurrent saves with `version = 14`, exactly one matches.

:::sql id=db-12-sql5 db=studio xp=40
title: A versioned save
Mara's editor loaded **The Heist** (project 1) at version **14** and now saves a change: set
the document's `fps` to `60`. Write the optimistic update: change `doc`, bump `version` by 1,
set `updated_at` to `'2025-07-11 10:00+00'` — but only if the version is still 14. Return the
new `version`.

hint: Add `AND version = 14` to the `WHERE`, and `version = version + 1` to the `SET`.

```sql starter
UPDATE projects
SET doc = jsonb_set(doc, '{fps}', '60')
WHERE id = 1
RETURNING version;
```

```sql solution
UPDATE projects
SET doc = jsonb_set(doc, '{fps}', '60'),
    version = version + 1,
    updated_at = '2025-07-11 10:00+00'
WHERE id = 1 AND version = 14
RETURNING version;
```
:::

:::sql id=db-12-sql6 db=studio xp=50
title: Two saves, one winner
Mara and Jonas both opened project 1 at version **14**. Mara saves first, renaming it to
`'The Heist (Director''s Cut)'`; then Jonas saves his rename to `'Heist!'` — still based on
version 14.

Write **both** `UPDATE` statements (Mara's, then Jonas's) as optimistic updates that bump the
version. Jonas's must affect 0 rows. The checker reads `title, version` of project 1.

hint: Both statements use `WHERE id = 1 AND version = 14`; only the first one matches.

```sql starter
UPDATE projects SET title = 'The Heist (Director''s Cut)' WHERE id = 1;
UPDATE projects SET title = 'Heist!' WHERE id = 1;
```

```sql solution
UPDATE projects SET title = 'The Heist (Director''s Cut)', version = version + 1
WHERE id = 1 AND version = 14;
UPDATE projects SET title = 'Heist!', version = version + 1
WHERE id = 1 AND version = 14;
```

```sql check
SELECT title, version FROM projects WHERE id = 1;
```
:::

### Optimistic concurrency in the API layer

HTTP has this pattern built in: the **ETag** response header and the **If-Match** request
header.

```http
GET /api/projects/1
HTTP/1.1 200 OK
ETag: "14"
{ "id": 1, "title": "The Heist", "doc": { … }, "version": 14 }

PUT /api/projects/1
If-Match: "14"
{ "title": "The Heist", "doc": { "fps": 60, … } }

HTTP/1.1 412 Precondition Failed
{ "error": "version_conflict", "currentVersion": 15 }
```

By the HTTP spec, a failed `If-Match` is answered with **412 Precondition Failed**. Many APIs
instead accept the version in the JSON body (`"version": 14`) and answer **409 Conflict** — both
are fine as long as the API is consistent and the client handles it. The rest of this lesson says
"409" for short.

EF Core supports it natively with a **concurrency token**: it adds `AND version = @original`
to the `UPDATE` and throws when 0 rows are affected.

```csharp
public class Project
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public JsonDocument Doc { get; set; } = null!;
    [ConcurrencyCheck] public int Version { get; set; }   // or .IsConcurrencyToken() in OnModelCreating
}

public record SaveProject(string Title, int Version);

app.MapPut("/api/projects/{id}", async (int id, SaveProject dto, StudioDb db) =>
{
    var p = await db.Projects.FindAsync(id);
    if (p is null) return Results.NotFound();
    db.Entry(p).Property(x => x.Version).OriginalValue = dto.Version;  // what the client loaded
    p.Title = dto.Title;
    p.Version = dto.Version + 1;
    try { await db.SaveChangesAsync(); }
    catch (DbUpdateConcurrencyException) { return Results.Conflict(new { error = "version_conflict" }); }
    return Results.Ok(new { p.Version });
});
```

(Npgsql can also use Postgres's own `xmin` system column as an automatic row version —
`[Timestamp] public uint Version { get; set; }` — so you don't maintain the counter yourself.
An explicit `version` column is easier to expose in the API and survives dump/restore.)

### Which fix when?

| Situation | Use |
|---|---|
| Counters, balances, stock — the change is "relative" | Atomic `UPDATE … SET x = x + 1` / conditional `WHERE x >= n` |
| Short decision inside one request needs several reads | `SELECT … FOR UPDATE` on the aggregate root, keep it brief |
| User edits a document over minutes, conflicts are rare | Optimistic `version` column → 409 |
| Complex invariants across many rows (limits, overlaps) | `SERIALIZABLE` + retry, or a lock on a parent row, or a constraint (`EXCLUDE`, `UNIQUE`) |

:::job title="What you'll be asked on day one"
"Two users edited the same record and one change disappeared" is a classic first ticket.
Reviewers will look for: a `version`/`row_version` column or ETag on every editable resource,
`409` handling in the frontend (reload + "someone else changed this" message), and no
read-modify-write of counters in C#. Saying *"that's a lost update — we need optimistic
concurrency"* in the stand-up is a strong signal.
:::

## Deadlocks

A **deadlock** is two transactions each waiting for a lock the other one holds. Neither can
proceed, ever:

| t | Session A | Session B |
|---|---|---|
| 1 | `BEGIN;` `UPDATE users SET plan='team' WHERE id = 3;` 🔒 row 3 | |
| 2 | | `BEGIN;` `UPDATE users SET plan='pro' WHERE id = 4;` 🔒 row 4 |
| 3 | `UPDATE users … WHERE id = 4;` … waits for B | |
| 4 | | `UPDATE users … WHERE id = 3;` … waits for A → **cycle** |
| 5 | | B has waited `deadlock_timeout` (1 s by default), runs the cycle check, finds the cycle → **ERROR 40P01: deadlock detected**; B is rolled back |
| 6 | A's update of row 4 proceeds; `COMMIT;` ✅ | |

Postgres resolves it for you by aborting **one** of the transactions (the *victim*) — which one
depends on whose deadlock check fires first: the session whose check discovers the cycle is the
one aborted (here B, e.g. because A's check ran before the cycle existed), so your code can't assume it will always be the
"other" request. Either way a request failed. Prevention:

1. **Lock in a consistent order.** If every transaction that touches several users locks them
   in ascending id order (`SELECT … WHERE id IN (3,4) ORDER BY id FOR UPDATE`), a cycle can't
   form — that's why the credit challenge asked for id order.
2. **Keep transactions short.** Fewer locks held for less time means fewer collisions.
3. **Treat `40P01` like `40001`**: roll back and retry (the retry loop above handles both).
4. Bulk updates are a classic source: two jobs updating overlapping sets of rows in different
   physical orders. Sort the keys first.

:::quiz id=db-12-q5 xp=15
In the deadlock timeline above, Postgres picked Session B as the victim. What does the
**application** behind Session B observe?

- [ ] Its second `UPDATE` waits forever until someone kills the connection
- [ ] Both sessions are rolled back
- [x] An error with SQLSTATE `40P01`; its whole transaction is rolled back and should be retried
- [ ] Postgres silently reorders the statements so both succeed
> Postgres detects the cycle after `deadlock_timeout` and aborts one transaction (the victim) so
> the other can continue — so it neither hangs forever nor rolls back both. The victim gets
> `40P01 deadlock_detected` and loses its *whole* transaction (not just the last statement), so
> the app should log it and retry from `BEGIN`. Frequent deadlocks mean your lock order is
> inconsistent.
:::

## Production hygiene: timeouts and lock visibility

A forgotten open transaction or a migration waiting for a lock can stall an entire app.
Set guard rails per role or per connection:

```sql
ALTER ROLE app SET statement_timeout = '15s';                    -- kill runaway queries
ALTER ROLE app SET lock_timeout = '5s';                          -- don't wait forever for a lock
ALTER ROLE app SET idle_in_transaction_session_timeout = '60s';  -- kill "BEGIN; …(app crashed)…"
ALTER ROLE app SET transaction_timeout = '5min';                 -- PG 17+: cap total transaction time
```

When things are stuck, these queries answer "who is blocking whom?":

```sql
SELECT pid, state, wait_event_type, now() - xact_start AS xact_age, left(query, 60)
FROM pg_stat_activity
WHERE state <> 'idle'
ORDER BY xact_age DESC;

SELECT pid, pg_blocking_pids(pid) AS blocked_by, left(query, 60)
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

:::pro title="How senior teams avoid concurrency incidents"
- Every editable aggregate has a `version` column; every `UPDATE` from the API includes it.
- Money and credits live in an **append-only ledger** (like `credit_ledger`), never a mutable
  balance column alone — inserts don't conflict, and the history is the audit log.
- Retries for `40001`/`40P01` live in one place (a helper or an EF Core execution strategy),
  not sprinkled through handlers.
- `lock_timeout` is set on migrations so an `ALTER TABLE` waiting behind a long query fails
  fast instead of queueing every other query behind itself (Production PostgreSQL).
- Invariants that *can* be constraints *are* constraints: a `UNIQUE` index or an `EXCLUDE`
  constraint beats any amount of application locking.
:::

:::quiz id=db-12-q6 xp=10
`PUT /api/projects/1` runs
`UPDATE projects SET … , version = version + 1 WHERE id = 1 AND version = 14 RETURNING version`
and gets **0 rows** back. The project exists. What should the API do?

- [ ] Retry the same `UPDATE` until it succeeds
- [ ] Run the `UPDATE` again without the version condition so the user's work isn't lost
- [x] Return `409 Conflict` (or `412` for `If-Match`) so the client can reload and resolve the conflict
- [ ] Return `500` — the database is inconsistent
> 0 rows means another save landed first. Retrying blindly will fail forever (the version
> won't go back to 14), and dropping the condition re-creates the lost update. The client must
> fetch the new version and let the user (or a merge function) decide.
:::

:::cards id=db-12-cards1 xp=20 title="Transactions & locking"
Q: What does each letter of ACID guarantee?
A: Atomicity (all or nothing), Consistency (constraints hold), Isolation (concurrent transactions
   don't see half-done work), Durability (committed data survives a crash via the WAL).
Q: What happens after an error inside BEGIN … COMMIT?
A: The transaction is aborted: further statements are rejected and COMMIT acts as ROLLBACK —
   unless you ROLLBACK TO SAVEPOINT.
Q: What is MVCC in one sentence?
A: Updates write new row versions (xmin/xmax) and each statement/transaction reads from a snapshot,
   so readers and writers don't block each other.
Q: Postgres's default isolation level and its key property?
A: Read Committed — every statement takes a new snapshot; non-repeatable reads and phantoms are possible.
Q: What does Repeatable Read add, and what error can it raise?
A: One snapshot for the whole transaction; updating a row changed concurrently raises 40001
   (could not serialize access) — retry the transaction.
Q: What is write skew, and which level prevents it?
A: Two transactions read overlapping data and write different rows, together breaking an invariant.
   Only SERIALIZABLE (SSI) prevents it — or an explicit lock on a shared parent row.
Q: What is the lost update problem?
A: Two read-modify-write cycles overlap and the second write overwrites the first with stale data.
Q: Three fixes for lost updates?
A: Atomic relative UPDATE (x = x + 1), pessimistic SELECT … FOR UPDATE, optimistic version column.
Q: The optimistic concurrency UPDATE?
A: UPDATE t SET …, version = version + 1 WHERE id = $1 AND version = $2 RETURNING version;
   0 rows ⇒ 409 Conflict.
Q: How do you prevent deadlocks?
A: Lock rows in a consistent order (e.g. ascending id), keep transactions short, retry on 40P01.
Q: FOR UPDATE vs FOR NO KEY UPDATE vs FOR SHARE?
A: FOR UPDATE blocks every other lock; FOR NO KEY UPDATE (what UPDATE takes) still allows FK checks
   (FOR KEY SHARE); FOR SHARE lets others read-lock but blocks modifications.
Q: Which timeouts protect production from stuck transactions?
A: statement_timeout, lock_timeout, idle_in_transaction_session_timeout, transaction_timeout (PG 17+).
:::

## Recap

- A transaction is all-or-nothing; one error aborts it until `ROLLBACK` (or `ROLLBACK TO SAVEPOINT`).
- MVCC keeps row versions so readers never block writers; writers on the same row wait for each other.
- Read Committed (default) re-snapshots per statement; Repeatable Read freezes one snapshot;
  Serializable also prevents write skew — both stricter levels need a retry loop on `40001`.
- A conditional `UPDATE … WHERE …` is a safe compare-and-swap thanks to locking + re-check;
  `SELECT` then `UPDATE` in the app is not.
- Lost updates: use atomic `UPDATE`s, `SELECT … FOR UPDATE` on the aggregate root, or a
  `version` column with `WHERE version = $2` → 0 rows ⇒ `409 Conflict`.
- Deadlocks come from inconsistent lock order; Postgres kills a victim with `40P01` — sort your
  keys, keep transactions short, retry.
- Guard production with `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`
  (and `transaction_timeout` on PG 17+).
