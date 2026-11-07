---
id: db-20
title: Postgres From Your Code
level: advanced
minutes: 110
xp: 150
summary: How C# and Node apps talk to Postgres correctly — connection strings, pools and PgBouncer, parameters instead of string concatenation, transactions and retry loops for 40001/40P01, timeouts, mapping SQLSTATEs to HTTP, and proving it all with Testcontainers.
---

Up to now you typed SQL into a console and looked at the result. In a real product, nobody types
the SQL: your **API code** builds it, sends it over a network connection, waits, and turns the
answer (or the error) into an HTTP response. Almost every database incident that reaches a
post-mortem happens in that thin layer between code and database:

- a search box that accepts `' OR '1'='1` and returns every customer (**SQL injection**),
- an API that hangs because all 100 connections are taken (**pool exhaustion**),
- a credit balance that's wrong because a concurrent request slipped in (**no isolation, no retry**),
- a slow report that keeps a lock for 10 minutes (**no timeout**),
- a duplicate e-mail that comes back as `500 Internal Server Error` instead of `409 Conflict`.

This lesson is about getting that layer right, in **C# (Npgsql + EF Core)** and **Node
(node-postgres, the `pg` package)**. It builds directly on *Transactions, Isolation & Locking* — if
`40001` or "Serializable" don't ring a bell yet, read that lesson first.

:::info title="The cast"
- **Driver** — the library that speaks Postgres' wire protocol: **Npgsql** for .NET, **`pg`**
  (node-postgres) for Node. Everything else (EF Core, Dapper, Drizzle, Prisma) sits on a driver.
- **SQLSTATE** — a five-character error code Postgres attaches to every error, e.g. `23505`. Your
  code should branch on it, never on the English message (which can change and can be translated).
- **Pool** — a set of open connections the driver reuses instead of opening a new one per query.
- **Session** — everything that belongs to one server connection for as long as it is open:
  settings made with `SET`, temp tables, `LISTEN` subscriptions, session locks.
- **Autocommit** — a statement sent *without* `BEGIN` is its own tiny transaction that commits
  immediately. That's what `pool.query(…)` or a lone `ExecuteNonQueryAsync()` does.
- **Prepared statement** — SQL that is parsed once with placeholders (`$1`, `$2`) and then run with
  different values. Drivers use this mechanism to send parameters.
:::

## Connection strings: the address and the rules

A **connection string** tells the driver where the database is and how to behave. Npgsql uses
`Key=Value;` pairs; node-postgres accepts a URL or an object.

```text
Host=db.internal;Port=5432;Database=studio;Username=studio_api;Password=…;
Application Name=studio-api;Maximum Pool Size=20;Timeout=5;Command Timeout=30;
Options=-c statement_timeout=5s -c lock_timeout=2s
```

| Key (Npgsql) | What it does | Default |
|---|---|---|
| `Host`, `Port`, `Database`, `Username`, `Password` | where and who | `5432` |
| `Application Name` | shows up in `pg_stat_activity.application_name` — you'll thank yourself during an incident | empty |
| `Maximum Pool Size` | max open connections **per process** for this connection string | `100` |
| `Timeout` | seconds to wait for a connection (opening one *or* getting one from a full pool) | `15` |
| `Command Timeout` | seconds before the driver gives up on a command | `30` |
| `Options` | server settings for every connection (`-c name=value`) | — |
| `SSL Mode` | `Require`/`VerifyFull` in the cloud | `Prefer` |

The same in Node:

```ts
import pg from 'pg'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,      // postgres://studio_api:…@db.internal:5432/studio
  application_name: 'studio-api',
  max: 20,                                         // pool size
  connectionTimeoutMillis: 5_000,                  // wait for a free connection
  idleTimeoutMillis: 30_000,                       // close idle connections
  statement_timeout: 5_000,                        // server-side, per statement
})
```

:::warn title="Secrets don't live in code"
Connection strings contain passwords. Read them from configuration (`appsettings.*.json` without
the password + an environment variable or a secret store) — the *Dependency Injection &
Configuration* lesson shows how. Never log the full string.
:::

In modern .NET you don't pass connection strings around: you build one **`NpgsqlDataSource`**
(Npgsql 7+), register it once, and ask it for connections or commands. It owns the pool.

```csharp
// Program.cs  (package Npgsql.DependencyInjection)
builder.Services.AddNpgsqlDataSource(builder.Configuration.GetConnectionString("Studio")!);

// EF Core can use the same data source:
// builder.Services.AddDbContext<StudioDb>((sp, o) => o.UseNpgsql(sp.GetRequiredService<NpgsqlDataSource>()));

// anywhere:
app.MapGet("/users/{id:long}", async (long id, NpgsqlDataSource db, CancellationToken ct) =>
{
    await using var cmd = db.CreateCommand("SELECT name FROM users WHERE id = $1");
    cmd.Parameters.Add(new() { Value = id });
    return await cmd.ExecuteScalarAsync(ct) is string name ? Results.Ok(name) : Results.NotFound();
});
```

## Connection pooling: why and how it breaks

**Why pool?** Opening a Postgres connection is expensive: a TCP (and often TLS) handshake,
authentication, and the server **forks a new process** for it (several MB of RAM). That can take
5–50 ms — longer than most queries. A **pool** keeps connections open and lends them out.

**How it works.** In Npgsql, `OpenConnectionAsync()` *borrows* a connection from the pool and
`Dispose` *returns* it — the physical connection stays open. In Node, `pool.query(…)` borrows and
returns automatically; `pool.connect()` gives you a client you must `release()`.

```csharp
await using (var conn = await db.OpenConnectionAsync(ct))   // borrow (fast after warm-up)
{
    // … use it …
}                                                           // returned to the pool here
```

**How it breaks: exhaustion.** If code borrows and never returns (missing `using`, a forgotten
`client.release()`), or holds a connection while it awaits something slow (an HTTP call to a
payment provider), the pool runs dry. New requests wait `Timeout` seconds, then fail:

```text
Npgsql.NpgsqlException: The connection pool has been exhausted, either raise 'Max Pool Size'
(currently 20) or 'Timeout' (currently 5 seconds) in your connection string.
```

Raising the pool size usually just moves the problem to the server. **Sizing rule:** the sum of
all pools must stay below the server's `max_connections` (typically 100–500):

```text
API: 10 pods × Maximum Pool Size 20  = 200
Workers: 4 pods × 10                 =  40
Migrations / admin / monitoring      ≈  10
                                       ---
                                       250  → needs max_connections ≥ ~270, or a PgBouncer
```

And you need fewer connections than you think: **busy connections ≈ queries per second × average
query time**. 800 queries/s × 5 ms = **4** connections busy on average. A pool of 20 per pod is
plenty; 100 is a sign of slow queries or leaked connections.

:::quiz id=db-20-q1 xp=15
An endpoint opens a connection, reads the order, then calls the payment provider's HTTP API
(1–3 s), then writes the payment result, then disposes the connection. Under a sale, the API
starts failing with "connection pool has been exhausted". What's the best fix?
- [ ] Raise `Maximum Pool Size` to 1000
- [ ] Raise `Timeout` to 120 seconds
- [x] Don't hold a connection (or a transaction) across the external call: read, release, call the provider, then borrow again to write
- [ ] Switch to `Pooling=false` so every request gets its own connection
> Each request holds a connection for 1–3 s while doing no database work, so 20 connections serve
> only ~10 requests/s. A bigger pool just moves the overload to Postgres (each connection is a
> server process), a longer timeout makes users wait longer for the same failure, and disabling
> pooling adds connection setup to every request. Keep connections — and especially open
> transactions — short and free of network calls to third parties.
:::

### PgBouncer: a pool in front of the server

When many processes each have their own pool, a **server-side pooler** like **PgBouncer** sits
between apps and Postgres and multiplexes thousands of client connections onto a few dozen real
ones. Its **pool mode** decides when a real connection goes back to the shared pool:

| Mode | Real connection returned when… | Safe for |
|---|---|---|
| `session` | the client disconnects | everything (but little multiplexing) |
| `transaction` | each **transaction** ends | the usual choice — if your code avoids session state |
| `statement` | each statement ends | autocommit only; no multi-statement transactions |

In **transaction mode** two consecutive transactions from your app may run on two *different*
server connections. So anything that lives in the **session** (the server connection) is
unreliable:

- `SET app.tenant_id = '7'` — sticks to a server connection someone else gets next. Use
  `SET LOCAL` / `set_config(…, true)` inside each transaction (the challenge below shows why).
- `LISTEN` — the notifications go to a connection you no longer own. Listeners need a direct
  connection.
- Session advisory locks (`pg_advisory_lock` — an application-defined lock on a number, used as a
  mutex) — use `pg_advisory_xact_lock`, which is released automatically at `COMMIT`/`ROLLBACK`.
- Temp tables and `WITH HOLD` cursors across transactions.
- Prepared statements on old PgBouncer (< 1.21, or `max_prepared_statements = 0`).

For Npgsql behind PgBouncer, also set `No Reset On Close=true`: by default Npgsql sends
`DISCARD ALL` (a "forget all session state" command) whenever a connection goes back to its pool,
which is wasted work when PgBouncer resets server connections itself.

:::warn title="Check your PgBouncer version"
Prepared-statement support and its defaults changed across PgBouncer 1.21–1.2x. Before relying on
it, check `max_prepared_statements` in the
[PgBouncer config docs](https://www.pgbouncer.org/config.html) for the version you run, and the
[Npgsql PgBouncer notes](https://www.npgsql.org/doc/compatibility.html#pgbouncer).
:::

The *Production PostgreSQL* lesson covers deploying PgBouncer; here, remember the rule: **in
transaction mode, everything you rely on must be inside the transaction.**

:::quiz id=db-20-q2 xp=15
Your API goes behind PgBouncer in **transaction** mode. Which of these keep working unchanged?
(Select all that apply.)
- [x] `BEGIN; UPDATE …; UPDATE …; COMMIT;` from one `NpgsqlTransaction`
- [x] `SET LOCAL statement_timeout = '2s'` as the first statement inside a transaction
- [ ] A background service that runs `LISTEN render_done` once at start-up and waits for notifications
- [ ] `SET search_path = tenant_42` once after opening the connection
- [ ] `SELECT pg_advisory_lock(1)` in one request, `pg_advisory_unlock(1)` in a later request
> A transaction always runs on one server connection from `BEGIN` to `COMMIT`, so transactions
> and transaction-local settings are fine. `LISTEN`, session-level `SET` and session advisory
> locks attach to a server connection that PgBouncer hands to other clients between your
> transactions — the listener goes deaf, the search path leaks to other tenants, and the lock is
> held by the wrong connection (or released by nobody).
:::

:::sql id=db-20-sql1 db=empty xp=30
title: Settings that end with the transaction
Behind PgBouncer you must scope a tenant id to **one transaction**. Change the script so the setting
is transaction-local. The last statement shows what the *next* transaction on this connection
would see — it must print `(not set)`.

hint: `SET LOCAL name = 'value'` (or `SELECT set_config('app.tenant_id', '7', true)` — the `true` means "local").
hint: After the transaction ends, `current_setting('app.tenant_id', true)` returns an empty string, which `nullif(…, '')` turns into NULL.

```sql starter
BEGIN;
SET app.tenant_id = '7';
SELECT current_setting('app.tenant_id') AS inside;
COMMIT;
SELECT coalesce(nullif(current_setting('app.tenant_id', true), ''), '(not set)') AS next_transaction_sees;
```

```sql solution
BEGIN;
SET LOCAL app.tenant_id = '7';
SELECT current_setting('app.tenant_id') AS inside;
COMMIT;
SELECT coalesce(nullif(current_setting('app.tenant_id', true), ''), '(not set)') AS next_transaction_sees;
```
:::

## Parameters, not concatenation

**SQL injection** happens when user input becomes part of the SQL *text*. The database can't tell
your SQL from the attacker's — it's all one string. Here's the classic bug:

```csharp
// ❌ NEVER: user input glued into SQL
var sql = $"SELECT id, email FROM users WHERE email = '{email}'";
```

With `email = ada@example.com` it works. Now an attacker types `' OR '1'='1`:

```sql
SELECT id, email FROM users WHERE email = '' OR '1'='1'   -- every user comes back
```

Or `x'; DROP TABLE users; --`:

```sql
SELECT id, email FROM users WHERE email = 'x'; DROP TABLE users; --'
```

Escaping quotes by hand is not the fix — there's always one more edge case (backslashes,
encodings, numbers without quotes). The fix is **parameters**: the SQL text has placeholders and
the values travel **separately** in the protocol. Postgres parses the SQL *first*, then plugs the
values in as data. A value can never become SQL.

```csharp
// ✅ Npgsql, positional ($1, $2 …)
await using var cmd = db.CreateCommand("SELECT id, email FROM users WHERE email = $1");
cmd.Parameters.Add(new() { Value = email });

// ✅ Npgsql, named
await using var cmd2 = db.CreateCommand("SELECT id, email FROM users WHERE email = @email");
cmd2.Parameters.AddWithValue("email", email);
```

```ts
// ✅ node-postgres: text + values array
const { rows } = await pool.query('SELECT id, email FROM users WHERE email = $1', [email])
```

```csharp
// ✅ EF Core: interpolated *FromSql* turns {email} into a parameter
var users = await db.Users.FromSql($"SELECT * FROM users WHERE email = {email}").ToListAsync(ct);

// ❌ EF Core: FromSqlRaw with string concatenation is as unsafe as the first example
var bad = await db.Users.FromSqlRaw("SELECT * FROM users WHERE email = '" + email + "'").ToListAsync(ct);
```

Bonus: a command with **positional** parameters (`$1` in node-postgres or Npgsql) is sent as one
prepared statement, and Postgres refuses **several statements** in it (`cannot insert multiple
commands into a prepared statement`, SQLSTATE `42601`). Npgsql's **named** `@email` style is
different: Npgsql splits `…; …` into a batch for you, so several statements do run. Either way the
*values* are safe — the protection comes from parameters, not from that error. When you really need
several statements with parameters, use an `NpgsqlBatch` (or one `client.query` per statement).

You can see the same mechanism in plain SQL with `PREPARE`/`EXECUTE` — it's what drivers do for
you under the hood.

:::sql id=db-20-sql2 db=empty xp=30
title: Injection, defused
The `users` table has three users. The starter is what a concatenating API sends when someone
types `' OR '1'='1` into the login e-mail field — it matches every user. Rewrite it so the SQL is
fixed and the input is a **parameter**: `PREPARE` a statement `find_user(text)` that returns
`count(*) AS matches` of users whose `email = $1`, then `EXECUTE` it with the attacker's input as
the value. The result must be `0` — no user has that odd e-mail, and the input stayed data.

hint: `PREPARE find_user(text) AS SELECT count(*) AS matches FROM users WHERE email = $1;`
hint: The attacker's text as a SQL string literal: `''' OR ''1''=''1'` (quotes inside a literal are doubled).

```sql setup
CREATE TABLE users (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE
);
INSERT INTO users (email) VALUES ('ada@example.com'), ('bo@example.com'), ('cy@example.com');
```

```sql starter
SELECT count(*) AS matches FROM users WHERE email = '' OR '1'='1';
```

```sql solution
PREPARE find_user(text) AS SELECT count(*) AS matches FROM users WHERE email = $1;
EXECUTE find_user(''' OR ''1''=''1');
```
:::

### Identifiers can't be parameters: use an allow-list

Parameters replace **values**, not **identifiers** (table and column names) or keywords
(`ASC`/`DESC`). `ORDER BY $1` sorts by a constant — i.e. not at all. So a sortable table in an API
(`GET /products?sort=-price`) tempts people back into concatenation:

```ts
// ❌ sort=name;DROP TABLE products  or  sort=(SELECT password_hash FROM users LIMIT 1)
const sql = `SELECT … FROM products p ORDER BY ${req.query.sort}`
```

The fix is an **allow-list**: a map from the names the API accepts to the exact SQL you control.
Anything not in the map is rejected with `400 Bad Request`. Input never reaches the SQL text; only
your own constant strings do.

```ts
const SORTABLE = { name: 'p.name', price: 'p.price' } as const
const column = Object.hasOwn(SORTABLE, field) ? SORTABLE[field as keyof typeof SORTABLE] : null
if (!column) throw new BadRequest('Invalid sort field')
```

The same goes for table names (multi-tenant schemas), `LIMIT` values (parse to an integer and
clamp) and JSON keys. If you truly must quote a dynamic identifier, use `quote_ident()` /
`format('%I', …)` in SQL — but an allow-list is simpler to review.

:::tip title="LIKE needs one more step"
`WHERE name ILIKE $1` with `'%' + term + '%'` is injection-safe, but a user typing `%` or `_`
still gets wildcard behaviour. Escape them (`term.replace(/[\\%_]/g, '\\$&')`) when it matters.
:::

:::quiz id=db-20-q3 xp=10
Which one is safe from SQL injection?
- [ ] `` pool.query(`SELECT * FROM users WHERE id = ${id}`) `` where `id` came from `req.params`
- [ ] `db.Users.FromSqlRaw($"SELECT * FROM users WHERE email = '{email}'")`
- [x] `pool.query('SELECT * FROM users WHERE email = $1', [email])`
- [ ] `` `SELECT * FROM users WHERE email = '${email.replaceAll("'", "''")}'` ``
> Only the third sends the value separately from the SQL text. A template literal in Node is plain
> string building. `FromSqlRaw` with a C# interpolated string is still string building (it's
> `FromSql`/`FromSqlInterpolated` that turn holes into parameters). Hand-escaping quotes is fragile
> and is not what reviewers want to see — parameters are the rule, no exceptions.
:::

:::quiz id=db-20-q4 xp=10
`GET /videos?sort=duration` must sort by a column the client picks. What's the right approach?
- [ ] `ORDER BY $1` with the column name as a parameter
- [x] Look the field up in an allow-list map (`duration → v.duration_ms`) and reject anything else with 400
- [ ] Remove spaces and semicolons from the input, then concatenate
- [ ] Concatenate, but run the query in a read-only transaction
> A parameter is always a *value*: `ORDER BY $1` sorts every row by the same constant string. Strip
> lists miss tricks like subqueries in parentheses, and a read-only transaction still lets the
> attacker *read* anything the role can see. An allow-list means only strings you wrote can ever
> appear in the SQL.
:::

:::challenge id=db-20-c1 lang=ts xp=50
title: A safe ORDER BY builder
Write `orderBy(sort)` for `GET /products?sort=…`. `sort` is a comma-separated list of API field
names; a leading `-` means descending. Allowed fields are in `SORTABLE`.

| Input | Output |
|---|---|
| `undefined` or `''` | `ORDER BY p.created_at DESC, p.id DESC` |
| `'price'` | `ORDER BY p.price ASC, p.id ASC` |
| `'-price,name'` | `ORDER BY p.price DESC, p.name ASC, p.id ASC` |
| `' name , -created '` | `ORDER BY p.name ASC, p.created_at DESC, p.id ASC` (trim each item) |

Always append `p.id ASC` as a **tiebreaker** so the order is total (stable paging — see
*Performance Tuning*). Throw an `Error` whose message contains `Invalid sort` for: an unknown field
(including raw column names like `'p.price'` — only the API names are allowed), an empty item
(`'price,'`), a lone `'-'` with no field, a duplicate field in either direction (`'price,-price'`),
or more than 3 fields. Inherited object keys such as
`toString` are **not** allowed fields.

hint: `sort.split(',').map(s => s.trim())`, then for each item: `const desc = item.startsWith('-')`, `const field = desc ? item.slice(1) : item`.
hint: `Object.hasOwn(SORTABLE, field)` is false for `toString` — `field in SORTABLE` and `SORTABLE[field]` are not safe checks.
hint: Track seen fields in a `Set` to detect duplicates.

```ts starter
export const SORTABLE: Record<string, string> = {
  name: 'p.name',
  price: 'p.price',
  created: 'p.created_at',
}

export function orderBy(sort: string | undefined): string {
  return 'ORDER BY ' + sort
}
```

```ts solution
export const SORTABLE: Record<string, string> = {
  name: 'p.name',
  price: 'p.price',
  created: 'p.created_at',
}

export function orderBy(sort: string | undefined): string {
  if (!sort || sort.trim() === '') return 'ORDER BY p.created_at DESC, p.id DESC'
  const items = sort.split(',').map(s => s.trim())
  if (items.length > 3) throw new Error('Invalid sort: too many fields')
  const seen = new Set<string>()
  const parts = items.map(item => {
    const desc = item.startsWith('-')
    const field = desc ? item.slice(1) : item
    if (!field || !Object.hasOwn(SORTABLE, field)) throw new Error(`Invalid sort field: ${field}`)
    if (seen.has(field)) throw new Error(`Invalid sort: duplicate ${field}`)
    seen.add(field)
    return `${SORTABLE[field]} ${desc ? 'DESC' : 'ASC'}`
  })
  return `ORDER BY ${parts.join(', ')}, p.id ASC`
}
```

```ts tests
test('default order is newest first with a tiebreaker', () => {
  expect(orderBy(undefined)).toBe('ORDER BY p.created_at DESC, p.id DESC')
  expect(orderBy('')).toBe('ORDER BY p.created_at DESC, p.id DESC')
})
test('single ascending field', () => {
  expect(orderBy('price')).toBe('ORDER BY p.price ASC, p.id ASC')
})
test('descending and multiple fields', () => {
  expect(orderBy('-price,name')).toBe('ORDER BY p.price DESC, p.name ASC, p.id ASC')
})
test('trims items and maps API names to columns', () => {
  expect(orderBy(' name , -created ')).toBe('ORDER BY p.name ASC, p.created_at DESC, p.id ASC')
})
test('rejects injection attempts', () => {
  expect(() => orderBy('name;DROP TABLE products')).toThrow('Invalid sort')
  expect(() => orderBy('(SELECT password_hash FROM users LIMIT 1)')).toThrow('Invalid sort')
  expect(() => orderBy('p.price')).toThrow('Invalid sort')
})
test('rejects inherited keys', () => {
  expect(() => orderBy('toString')).toThrow('Invalid sort')
  expect(() => orderBy('-constructor')).toThrow('Invalid sort')
})
test('rejects empty items, duplicates and too many fields', () => {
  expect(() => orderBy('price,')).toThrow('Invalid sort')
  expect(() => orderBy('-')).toThrow('Invalid sort')
  expect(() => orderBy('price,-price')).toThrow('Invalid sort')
  expect(() => orderBy('name,price,created,name')).toThrow('Invalid sort')
})
```
:::

## Transactions from code

A transaction groups statements into all-or-nothing. In SQL that's `BEGIN … COMMIT`. From code
there's one critical rule: **every statement of a transaction must go over the same
connection.** The transaction lives in the server connection, not in your code.

### C#: NpgsqlTransaction

```csharp
await using var conn = await db.OpenConnectionAsync(ct);
await using var tx = await conn.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);

await using (var debit = new NpgsqlCommand(
    "UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND balance >= $1", conn, tx))
{
    debit.Parameters.Add(new() { Value = amount });
    debit.Parameters.Add(new() { Value = fromId });
    if (await debit.ExecuteNonQueryAsync(ct) == 0) return Results.Conflict("Not enough credits");
}   // returning here without CommitAsync → tx is disposed → ROLLBACK

await using (var credit = new NpgsqlCommand(
    "UPDATE wallets SET balance = balance + $1 WHERE id = $2", conn, tx))
{
    credit.Parameters.Add(new() { Value = amount });
    credit.Parameters.Add(new() { Value = toId });
    await credit.ExecuteNonQueryAsync(ct);
}

await tx.CommitAsync(ct);
```

`await using` is the safety net: if an exception escapes or you return early, disposing an
uncommitted transaction rolls it back. Pass the transaction to each command (the `tx` argument).

### C#: EF Core

`SaveChangesAsync()` already wraps its own changes in a transaction. You only need an explicit one
when **several** `SaveChanges` calls or raw SQL must commit together, or when you need a stricter
isolation level:

```csharp
await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
var wallet = await db.Wallets.SingleAsync(w => w.Id == walletId, ct);
wallet.Balance -= amount;
db.Ledger.Add(new LedgerEntry { WalletId = walletId, Delta = -amount });
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

### Node: one client for the whole transaction

This is the most common node-postgres bug:

```ts
// ❌ each pool.query may run on a DIFFERENT connection
await pool.query('BEGIN')
await pool.query('UPDATE wallets SET balance = balance - $1 WHERE id = $2', [amount, fromId])
await pool.query('COMMIT')   // might commit a different connection's (empty) transaction
```

Borrow one client, use it for everything, and always release it:

```ts
import type { Pool, PoolClient } from 'pg'

export async function inTransaction<T>(pool: Pool, work: (c: PoolClient) => Promise<T>,
                                       isolation = 'READ COMMITTED'): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)  // isolation comes from our code, not users
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})            // connection may already be broken
    throw err
  } finally {
    client.release()
  }
}
```

:::warn title="After an error, the transaction is dead"
Once any statement inside a transaction fails, Postgres rejects everything else with
`25P02 current transaction is aborted, commands ignored until end of transaction block`. Catching
the exception in C# and "carrying on" with the same transaction doesn't work — roll back (or roll
back to a savepoint) first.
:::

### Isolation levels from code

You pick the level when you start the transaction: `BeginTransactionAsync(IsolationLevel.Serializable)`
in C#, `BEGIN ISOLATION LEVEL SERIALIZABLE` in Node. Quick reminder from *Transactions, Isolation
& Locking*:

- **Read Committed** (default): each statement sees the latest committed data. Great for most
  requests, but "read, decide in code, write" can lose updates.
- **Repeatable Read**: one snapshot for the whole transaction; a write to a row someone else
  changed since your snapshot fails with **`40001`**.
- **Serializable**: as if transactions ran one at a time; Postgres aborts one of two conflicting
  transactions with **`40001`**.

The stricter levels don't make conflicts disappear — they turn silent wrong answers into a loud
error. **Choosing them means you have committed to writing a retry loop.**

:::quiz id=db-20-q5 xp=10
In Node, a handler runs `await pool.query('BEGIN')`, two `pool.query` updates, then
`await pool.query('COMMIT')`. Under light load it seems to work. What's wrong?
- [ ] Nothing — `pg.Pool` keeps a transaction open per request automatically
- [x] Each `pool.query` can borrow a different connection, so the updates may run outside the transaction and `COMMIT` may hit another connection
- [ ] `pool.query` doesn't support `BEGIN`; it throws
- [ ] The updates are fine, but `COMMIT` must be sent with `client.end()`
> `pool.query` is "borrow any free connection, run one query, give it back". Under light load you
> often get the same connection by luck; under real load you don't, and you may even leave a
> connection in an open transaction for the next borrower. Use `const client = await pool.connect()`
> and run `BEGIN`…`COMMIT` on that client, releasing it in `finally`.
:::

## Retry loops for 40001 and 40P01

Two SQLSTATEs mean "**nothing is wrong with your request — you just lost a race; try again**":

| SQLSTATE | Name | When |
|---|---|---|
| `40001` | `serialization_failure` | Repeatable Read / Serializable detected a conflict |
| `40P01` | `deadlock_detected` | two transactions waited on each other; Postgres killed one |

Both roll back the **whole** transaction. So a correct retry:

1. **Retries the whole transaction**, from `BEGIN`, including the reads — the old reads are stale.
2. Retries **only** these SQLSTATEs. A `23505` duplicate or a business rule failure will fail the
   same way every time.
3. Is **bounded** (e.g. 5 attempts), then gives up and lets the error map to `503`.
4. **Waits a little, with jitter** (a random delay that grows: 0–20 ms, 0–40 ms, …), so two
   requests that collided don't collide again in lock-step.
5. Has **no outside side effects inside** the loop: don't send an e-mail or charge a card inside
   the transaction body, or a retry sends it twice. Do it after commit (or via an outbox, see
   *Job Queues in PostgreSQL*).

In C#:

```csharp
public static bool IsRetryable(Exception ex) =>
    ex is PostgresException { SqlState: PostgresErrorCodes.SerializationFailure      // "40001"
                                     or PostgresErrorCodes.DeadlockDetected };      // "40P01"

for (var attempt = 1; ; attempt++)
{
    try
    {
        await using var conn = await db.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(IsolationLevel.Serializable, ct);
        var result = await work(conn, tx, ct);      // all reads AND writes
        await tx.CommitAsync(ct);                   // 40001 can also be raised on COMMIT
        return result;
    }   // leaving the try disposes tx (→ ROLLBACK if not committed) and returns conn to the pool
    catch (PostgresException ex) when (IsRetryable(ex) && attempt < maxAttempts)
    {
        await Task.Delay(Random.Shared.Next(0, 10 * (1 << attempt)), ct);   // full jitter
    }
}
```

Two details matter here. The connection and transaction live **inside** the `try`, so they are
disposed (rolled back, returned to the pool) *before* the delay — a sleeping retry doesn't hog a
pooled connection. And there is **no explicit `RollbackAsync()`** in the `catch`: when `40001` is
raised by `COMMIT` itself, the server has already ended the transaction, and calling
`RollbackAsync()` on it throws `InvalidOperationException` (*"This NpgsqlTransaction has
completed"*) — which would replace the retryable error and kill the retry. `await using` already
rolls back whatever still needs rolling back.

With **EF Core**, the built-in strategy does the loop for you. Turn it on with
`UseNpgsql(…, o => o.EnableRetryOnFailure())`; it retries errors Npgsql marks as transient
(`PostgresException.IsTransient`, which includes `40001` and `40P01`). If you open your own
transaction, you must run the whole unit through the strategy — otherwise EF throws *"does not
support user-initiated transactions"*:

```csharp
var strategy = db.Database.CreateExecutionStrategy();
await strategy.ExecuteAsync(async () =>
{
    db.ChangeTracker.Clear();   // forget entities loaded by a failed attempt
    await using var tx = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, ct);
    var wallet = await db.Wallets.SingleAsync(w => w.Id == walletId, ct);
    wallet.Balance -= amount;
    await db.SaveChangesAsync(ct);
    await tx.CommitAsync(ct);
});
```

:::pro title="The 'commit unknown' case"
If the network drops *during* `COMMIT`, you get a connection error and **don't know** whether the
transaction committed. Blindly retrying a `INSERT INTO payments` could pay twice. Seniors make such
writes **idempotent** (a unique idempotency key + `ON CONFLICT DO NOTHING`, see *Concurrency,
Versions & Idempotency*) so a retry is harmless whatever happened.
:::

:::quiz id=db-20-q6 xp=15
A Serializable transaction reads a project, checks a quota in C#, inserts a render job, sends a
"render queued" e-mail, then commits. Under load, `COMMIT` sometimes fails with `40001`. Which retry
design is correct?
- [ ] Catch `40001` and re-run only the failed `COMMIT`
- [ ] Catch `40001` and re-run only the `INSERT`, reusing the project and quota already read
- [x] Re-run the whole transaction from `BEGIN` (fresh reads), with a bounded number of attempts and jitter — and send the e-mail only after a successful commit
- [ ] Retry every `PostgresException` up to 10 times, so constraint errors also get a second chance
> After `40001` the transaction is gone; nothing can be "re-committed". The earlier reads are
> exactly what caused the conflict, so they must be repeated. Constraint violations are
> deterministic — retrying wastes time and hides the real 409/422. And an e-mail sent inside the
> loop is sent once per attempt; side effects belong after `COMMIT` (or in an outbox).
:::

:::challenge id=db-20-c2 lang=ts xp=60
title: A retry wrapper that knows its SQLSTATEs
node-postgres errors carry the SQLSTATE in `err.code`. Write two functions:

1. `isRetryable(err)` — `true` only for an object whose `code` is the string `'40001'` or `'40P01'`.
   Anything else (`23505`, an `Error` without a code, `null`, a plain string like `'40001'`) is `false`.
2. `withRetry(work, opts)` — calls `work(attempt)` with `attempt = 1, 2, …`.
   - Success → return the value.
   - Retryable error and attempts left → `await opts.sleep(delay)`, then try again.
   - Non-retryable error, or the last attempt failed → re-throw **the same error object**
     immediately (no `sleep` after the final attempt: 3 attempts means 2 sleeps).
   - `maxAttempts` defaults to `5`, `baseMs` to `10`.
   - Full jitter: after failed attempt `n`, `delay = Math.floor(random() * baseMs * 2 ** n)`.
   - `opts.sleep` defaults to a real `setTimeout` promise; `opts.random` defaults to `Math.random`.

The tests pass a fake `sleep` (so no real waiting) and a fixed `random`.

hint: A `for (let attempt = 1; ; attempt++)` loop with `try { return await work(attempt) } catch (err) { … }`.
hint: Inside `catch`: `if (!isRetryable(err) || attempt >= maxAttempts) throw err`.
hint: `typeof err === 'object' && err !== null && 'code' in err` before reading `err.code`.

```ts starter
export type RetryOptions = {
  maxAttempts?: number
  baseMs?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export function isRetryable(err: unknown): boolean {
  return false
}

export async function withRetry<T>(work: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  return work(1)
}
```

```ts solution
export type RetryOptions = {
  maxAttempts?: number
  baseMs?: number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

const RETRYABLE = new Set(['40001', '40P01'])

export function isRetryable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    RETRYABLE.has((err as { code: unknown }).code as string)
}

export async function withRetry<T>(work: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5
  const baseMs = opts.baseMs ?? 10
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const random = opts.random ?? Math.random
  for (let attempt = 1; ; attempt++) {
    try {
      return await work(attempt)
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxAttempts) throw err
      await sleep(Math.floor(random() * baseMs * 2 ** attempt))
    }
  }
}
```

```ts tests
const pgErr = (code: string) => Object.assign(new Error(`pg error ${code}`), { code })

test('isRetryable knows exactly two SQLSTATEs', () => {
  expect(isRetryable(pgErr('40001'))).toBe(true)
  expect(isRetryable(pgErr('40P01'))).toBe(true)
  expect(isRetryable(pgErr('23505'))).toBe(false)
  expect(isRetryable(pgErr('57014'))).toBe(false)
  expect(isRetryable(new Error('boom'))).toBe(false)
  expect(isRetryable(null)).toBe(false)
  expect(isRetryable('40001')).toBe(false)
})

test('returns the value on first success without sleeping', async () => {
  const sleep = fn(async () => {})
  const work = fn(async () => 'ok')
  await expect(withRetry(work, { sleep })).resolves.toBe('ok')
  expect(work).toHaveBeenCalledTimes(1)
  expect(sleep).not.toHaveBeenCalled()
})

test('retries 40001 and 40P01, passing the attempt number', async () => {
  const sleep = fn(async () => {})
  const seen: number[] = []
  const result = await withRetry(async attempt => {
    seen.push(attempt)
    if (attempt === 1) throw pgErr('40001')
    if (attempt === 2) throw pgErr('40P01')
    return 42
  }, { sleep })
  expect(result).toBe(42)
  expect(seen).toEqual([1, 2, 3])
  expect(sleep).toHaveBeenCalledTimes(2)
})

test('full jitter delays grow with the attempt', async () => {
  const delays: number[] = []
  const sleep = async (ms: number) => { delays.push(ms) }
  await withRetry(async attempt => {
    if (attempt < 4) throw pgErr('40001')
    return 'done'
  }, { sleep, random: () => 0.5, baseMs: 10 })
  expect(delays).toEqual([10, 20, 40])
})

test('does not retry a unique violation and rethrows the same error', async () => {
  const sleep = fn(async () => {})
  const dup = pgErr('23505')
  const work = fn(async () => { throw dup })
  let caught: unknown
  try { await withRetry(work, { sleep }) } catch (e) { caught = e }
  expect(caught).toBe(dup)
  expect(work).toHaveBeenCalledTimes(1)
  expect(sleep).not.toHaveBeenCalled()
})

test('gives up after maxAttempts with the last error', async () => {
  const sleep = fn(async () => {})
  const work = fn(async (attempt: number) => { throw pgErr(attempt === 3 ? '40P01' : '40001') })
  let caught: any
  try { await withRetry(work, { sleep, maxAttempts: 3 }) } catch (e) { caught = e }
  expect(caught.code).toBe('40P01')
  expect(work).toHaveBeenCalledTimes(3)
  expect(sleep).toHaveBeenCalledTimes(2)
})

test('defaults to 5 attempts', async () => {
  const sleep = fn(async () => {})
  const work = fn(async () => { throw pgErr('40001') })
  await expect(withRetry(work, { sleep, random: () => 0 })).rejects.toThrow('pg error 40001')
  expect(work).toHaveBeenCalledTimes(5)
})
```
:::

## Timeouts and cancellation

Without timeouts, one bad query (a missing index, a lock held by a forgotten `BEGIN` in someone's
psql) can hold connections until the pool is exhausted and the whole API is down. There are two
sides, and you want both:

| Where | Setting | What happens when it fires |
|---|---|---|
| **Server** | `statement_timeout` | Postgres cancels the statement → error **`57014`** `query_canceled` |
| Server | `lock_timeout` | waiting for a lock too long → **`55P03`** `lock_not_available` |
| Server | `idle_in_transaction_session_timeout` | kills sessions sitting in an open transaction doing nothing |
| Server | `transaction_timeout` (PG 17+) | caps the whole transaction |
| **Client** | Npgsql `Command Timeout` / `cmd.CommandTimeout` | Npgsql sends a cancel request and throws `NpgsqlException` (inner `TimeoutException`) |
| Client | `CancellationToken` | Npgsql sends a cancel request and throws `OperationCanceledException` |
| Client | node-postgres `query_timeout` | the promise rejects — but the server may keep running; rely on `statement_timeout` |

**Server-side timeouts are the real guard** — they protect the database even from clients that
don't cancel. Set them per role (`ALTER ROLE studio_api SET statement_timeout = '5s'`), per
connection (`Options=-c statement_timeout=5s`) or per transaction for one special query:

```sql
BEGIN;
SET LOCAL statement_timeout = '60s';   -- this report may take longer; only this transaction
SELECT … big report …;
COMMIT;
```

**Cancellation** is about not doing useless work. In ASP.NET Core, a `CancellationToken`
parameter in your endpoint fires when the client disconnects. Pass it all the way down and Npgsql
asks Postgres to stop the query:

```csharp
app.MapGet("/reports/revenue", async (NpgsqlDataSource db, CancellationToken ct) =>
{
    await using var cmd = db.CreateCommand("SELECT … slow aggregate …");
    await using var reader = await cmd.ExecuteReaderAsync(ct);   // user closes the tab → query cancelled
    // …
});
```

:::quiz id=db-20-q7 xp=15
A Node API uses `pg` with `query_timeout: 5000` and nothing else. A query hits a missing index and
takes 3 minutes. What happens?
- [ ] Postgres stops the query after 5 seconds
- [x] The API stops waiting after 5 seconds, but the query can keep running on the server, still using CPU and possibly holding locks
- [ ] The query is never started, because `pg` estimates its cost first
- [ ] The whole pool is reset
> `query_timeout` is a client-side timer: it rejects your promise. Only a server-side setting
> (`statement_timeout`, via the pool option, `ALTER ROLE … SET`, or `SET LOCAL`) makes Postgres itself
> cancel the statement with `57014`. Use both: the client timer for responsiveness, the server
> timeout to protect the database.
:::

## From SQLSTATE to HTTP status

Your API should answer with a status the client can act on. Most database errors fall into a
handful of buckets; map them in **one place** (an exception handler), by SQLSTATE:

| SQLSTATE | Meaning | HTTP | Why |
|---|---|---|---|
| `23505` unique_violation | duplicate e-mail, slug, idempotency key | **409 Conflict** | conflicts with existing state |
| `23503` foreign_key_violation | parent missing / row still referenced | **409 Conflict** | conflicts with existing state |
| `23502` not_null, `23514` check, `22P02` bad text, `22001` too long | bad input that validation missed | **422** | client sent invalid data (log it — your validation has a hole) |
| `40001`, `40P01` (after retries) | lost the race repeatedly | **503** + `Retry-After` (a header telling the client how many seconds to wait) | temporary |
| `57014` query_canceled, `55P03` lock_not_available | timeout | **503** | temporary overload |
| `53300` too_many_connections | server full | **503** | temporary |
| anything else | a bug | **500** | never leak the error text to clients |

```csharp
public sealed class PostgresExceptionHandler : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext http, Exception ex, CancellationToken ct)
    {
        var pg = ex as PostgresException ?? ex.InnerException as PostgresException; // EF wraps it in DbUpdateException
        if (pg is null) return false;

        var (status, title) = pg.SqlState switch
        {
            PostgresErrorCodes.UniqueViolation or PostgresErrorCodes.ForeignKeyViolation => (409, "Conflict"),
            PostgresErrorCodes.NotNullViolation or PostgresErrorCodes.CheckViolation
                or PostgresErrorCodes.InvalidTextRepresentation or PostgresErrorCodes.StringDataRightTruncation
                => (422, "Invalid data"),
            PostgresErrorCodes.SerializationFailure or PostgresErrorCodes.DeadlockDetected
                or PostgresErrorCodes.QueryCanceled or PostgresErrorCodes.LockNotAvailable
                or PostgresErrorCodes.TooManyConnections => (503, "Try again"),
            _ => (500, "Server error"),
        };
        if (status == 503) http.Response.Headers.RetryAfter = "1";
        http.Response.StatusCode = status;
        await http.Response.WriteAsJsonAsync(new { title, status, constraint = status < 500 ? pg.ConstraintName : null }, ct);
        return true;
    }
}
// builder.Services.AddExceptionHandler<PostgresExceptionHandler>(); app.UseExceptionHandler(_ => { });
```

`pg.ConstraintName` (e.g. `users_email_key`) lets you tell the client *which* field clashed.

:::tip title="Expected conflicts don't need exceptions"
For a conflict you *expect* (sign-up with an existing e-mail), `INSERT … ON CONFLICT DO NOTHING
RETURNING id` returns **zero rows** instead of throwing. No exception, no aborted transaction —
just `if (id is null) return Results.Conflict(…)`. The exception mapping above is the safety net
for the cases you didn't foresee.
:::

:::sql id=db-20-sql3 db=empty xp=30
title: A conflict without an exception
A bulk invite inserts two users; `ada@example.com` already exists. The starter fails with
`23505` and inserts **nothing**. Write one `INSERT` that skips existing e-mails and returns the
`email` of each row it **actually** inserted (the API reports the rest as conflicts).

hint: `ON CONFLICT (email) DO NOTHING` goes after `VALUES (…)`.
hint: `RETURNING email` returns only the rows that were inserted.

```sql setup
CREATE TABLE users (
  id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name  text NOT NULL
);
INSERT INTO users (email, name) VALUES ('ada@example.com', 'Ada');
```

```sql starter
INSERT INTO users (email, name)
VALUES ('ada@example.com', 'Ada again'), ('cy@example.com', 'Cy')
RETURNING email;
```

```sql solution
INSERT INTO users (email, name)
VALUES ('ada@example.com', 'Ada again'), ('cy@example.com', 'Cy')
ON CONFLICT (email) DO NOTHING
RETURNING email;
```
:::

:::challenge id=db-20-c3 lang=ts xp=40
title: Map Postgres errors to HTTP
Write `httpStatusFor(err)` following the table above:

- `409` for `23505`, `23503`
- `422` for `23502`, `23514`, `22P02`, `22001`
- `503` for `40001`, `40P01`, `57014`, `55P03`, `53300`
- `500` for everything else — including errors without a `code`, `null` and non-objects.

The SQLSTATE is in `err.code` (node-postgres style).

hint: Read the code safely: `const code = typeof err === 'object' && err !== null ? (err as any).code : undefined`.
hint: A `switch (code)` with grouped `case` labels, or three `Set`s.

```ts starter
export function httpStatusFor(err: unknown): number {
  return 500
}
```

```ts solution
const CONFLICT = new Set(['23505', '23503'])
const INVALID = new Set(['23502', '23514', '22P02', '22001'])
const TEMPORARY = new Set(['40001', '40P01', '57014', '55P03', '53300'])

export function httpStatusFor(err: unknown): number {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined
  if (typeof code !== 'string') return 500
  if (CONFLICT.has(code)) return 409
  if (INVALID.has(code)) return 422
  if (TEMPORARY.has(code)) return 503
  return 500
}
```

```ts tests
const e = (code: string) => Object.assign(new Error('db'), { code })

test('conflicts are 409', () => {
  expect(httpStatusFor(e('23505'))).toBe(409)
  expect(httpStatusFor(e('23503'))).toBe(409)
})
test('invalid data is 422', () => {
  for (const c of ['23502', '23514', '22P02', '22001']) expect(httpStatusFor(e(c))).toBe(422)
})
test('temporary problems are 503', () => {
  for (const c of ['40001', '40P01', '57014', '55P03', '53300']) expect(httpStatusFor(e(c))).toBe(503)
})
test('everything else is 500', () => {
  expect(httpStatusFor(e('42P01'))).toBe(500)
  expect(httpStatusFor(e('23'))).toBe(500)
  expect(httpStatusFor(new Error('no code'))).toBe(500)
  expect(httpStatusFor(null)).toBe(500)
  expect(httpStatusFor('23505')).toBe(500)
})
```
:::

:::quiz id=db-20-q8 xp=10
`POST /users` with an e-mail that already exists currently returns `500` with the text
`duplicate key value violates unique constraint "users_email_key"`. What should it return?
- [ ] `400 Bad Request` with the Postgres message
- [x] `409 Conflict` with a safe, client-facing message (optionally naming the field), based on SQLSTATE `23505`
- [ ] `500` is right — the database threw an error
- [ ] `503` with `Retry-After`, so the client tries again
> The request is well-formed but conflicts with existing state — that's 409. Branch on the
> SQLSTATE (`PostgresErrorCodes.UniqueViolation` / `err.code === '23505'`), not on message text,
> and don't leak raw database messages (they reveal table and constraint names). Retrying won't
> help: the e-mail will still exist.
:::

## Integration tests against a real Postgres

Everything in this lesson — SQLSTATEs, isolation, `ON CONFLICT`, timeouts — exists only in a
**real Postgres**. EF Core's InMemory provider and SQLite never raise `40001` or `23505` the same
way, so tests against them are green for the wrong reason. **Testcontainers** starts a throw-away
`postgres:18` container from your test code, gives you a connection string on a random port, and
removes it afterwards. The backend lesson *Integration Tests with WebApplicationFactory &
Testcontainers* builds a whole API test harness on it; here you'll use it to prove the hardest
thing to test by hand: **a retry loop under a real serialization failure**.

The trick to forcing `40001` deterministically, without threads or sleeps:

| t | Our transaction (Serializable) | Another request (autocommit) |
|---|---|---|
| 1 | `BEGIN ISOLATION LEVEL SERIALIZABLE;` | |
| 2 | `SELECT balance FROM wallets WHERE id = 1;` → 100 (snapshot taken) | |
| 3 | | `UPDATE wallets SET balance = balance + 10 WHERE id = 1;` (commits) |
| 4 | `UPDATE wallets SET balance = 70 WHERE id = 1;` → **40001** *could not serialize access due to concurrent update* | |

Our code gets a hook that runs between its read and its write; the test uses that hook to run
step 3 on a second connection — but only on the first attempt.

:::lab id=db-20-lab1 xp=100
title: Prove a retry loop under a forced serialization failure
You'll build a tiny .NET 10 library with a `Wallets.SpendAsync` (read balance → check → write,
under Serializable, wrapped in a retry loop) and an xUnit test project that runs it against
PostgreSQL 18 in a container.

**Prerequisites:** .NET 10 SDK (`dotnet --version` → `10.0.x`) and Docker or Podman.

:::tip title="Podman instead of Docker"
```bash
systemctl --user start podman.socket
export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock
```
If the Ryuk reaper container can't start, also `export TESTCONTAINERS_RYUK_DISABLED=true` (the
fixture disposes the container itself).
:::

**1. Create the solution**

```bash
mkdir credits-retry && cd credits-retry
dotnet new sln -n Credits
dotnet new classlib -n Credits -o src/Credits
dotnet new xunit -n Credits.Tests -o tests/Credits.Tests
dotnet sln add src/Credits tests/Credits.Tests
dotnet add tests/Credits.Tests reference src/Credits
dotnet add src/Credits package Npgsql
dotnet add tests/Credits.Tests package Testcontainers.PostgreSql
rm src/Credits/Class1.cs tests/Credits.Tests/UnitTest1.cs
```

**2. The retry helper** — `src/Credits/PgRetry.cs`:

```csharp
using System.Data;
using Npgsql;

namespace Credits;

public static class PgRetry
{
    // 40001 serialization_failure, 40P01 deadlock_detected: the whole transaction may be retried.
    public static bool IsRetryable(Exception ex) =>
        ex is PostgresException { SqlState: PostgresErrorCodes.SerializationFailure or PostgresErrorCodes.DeadlockDetected };

    public static async Task<T> InTransactionAsync<T>(
        NpgsqlDataSource db,
        IsolationLevel isolation,
        Func<NpgsqlConnection, NpgsqlTransaction, int, CancellationToken, Task<T>> work,
        int maxAttempts = 5,
        CancellationToken ct = default)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using var conn = await db.OpenConnectionAsync(ct);
                await using var tx = await conn.BeginTransactionAsync(isolation, ct);
                var result = await work(conn, tx, attempt, ct);
                await tx.CommitAsync(ct);              // 40001 can also happen here
                return result;
            }   // leaving the block disposes tx (ROLLBACK if not committed) and returns conn to the pool
            catch (PostgresException ex) when (IsRetryable(ex) && attempt < maxAttempts)
            {
                // No tx.RollbackAsync() here: after a failed COMMIT the transaction is already
                // over and RollbackAsync() would throw InvalidOperationException instead.
                var maxDelayMs = 10 * (1 << attempt);  // 20, 40, 80 … ms
                await Task.Delay(Random.Shared.Next(0, maxDelayMs), ct); // full jitter
            }
        }
    }
}
```

**3. The code under test** — `src/Credits/Wallets.cs`. It returns the attempt number that
succeeded, so the test can see the retry happened. `onAttempt` is a test hook that runs between
the read and the write.

```csharp
using System.Data;
using Npgsql;

namespace Credits;

public sealed class Wallets(NpgsqlDataSource db)
{
    // Read-modify-write: exactly the pattern that needs SERIALIZABLE + retry.
    // onAttempt lets a test see (and interfere with) each attempt.
    public Task<int> SpendAsync(long walletId, int amount,
        Func<int, Task>? onAttempt = null, int maxAttempts = 5, CancellationToken ct = default) =>
        PgRetry.InTransactionAsync(db, IsolationLevel.Serializable, async (conn, tx, attempt, token) =>
        {
            await using var read = new NpgsqlCommand(
                "SELECT balance FROM wallets WHERE id = $1", conn, tx);
            read.Parameters.Add(new() { Value = walletId });
            var balance = (int)(await read.ExecuteScalarAsync(token))!;

            if (onAttempt is not null) await onAttempt(attempt);

            if (balance < amount) throw new InvalidOperationException("Not enough credits");

            await using var write = new NpgsqlCommand(
                "UPDATE wallets SET balance = $1 WHERE id = $2", conn, tx);
            write.Parameters.Add(new() { Value = balance - amount });
            write.Parameters.Add(new() { Value = walletId });
            await write.ExecuteNonQueryAsync(token);
            return attempt;
        }, maxAttempts, ct);
}
```

**4. A Postgres 18 fixture** — `tests/Credits.Tests/PostgresFixture.cs`. One container per test
run (a *collection fixture*: xUnit creates it once and hands the same instance to every test class
marked `[Collection("pg")]`), reset between tests. Note the reset is **one** statement: with a
positional `$1` parameter, Postgres refuses `TRUNCATE …; INSERT …` in one command (`42601`).

```csharp
using Npgsql;
using Testcontainers.PostgreSql;

namespace Credits.Tests;

public sealed class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:18").Build();
    public NpgsqlDataSource Db { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _pg.StartAsync();
        Db = NpgsqlDataSource.Create(_pg.GetConnectionString());
        await using var cmd = Db.CreateCommand("""
            CREATE TABLE wallets (
              id      bigint PRIMARY KEY,
              balance int NOT NULL CHECK (balance >= 0)
            );
            """);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task ResetAsync(int balance)
    {
        await using var cmd = Db.CreateCommand("""
            INSERT INTO wallets (id, balance) VALUES (1, $1)
            ON CONFLICT (id) DO UPDATE SET balance = EXCLUDED.balance
            """);
        cmd.Parameters.Add(new() { Value = balance });
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<int> BalanceAsync()
    {
        await using var cmd = Db.CreateCommand("SELECT balance FROM wallets WHERE id = 1");
        return (int)(await cmd.ExecuteScalarAsync())!;
    }

    public async Task DisposeAsync()
    {
        await Db.DisposeAsync();
        await _pg.DisposeAsync();
    }
}

[CollectionDefinition("pg")]
public sealed class PgCollection : ICollectionFixture<PostgresFixture>;
```

**5. The tests** — `tests/Credits.Tests/RetryTests.cs`:

```csharp
using Npgsql;

namespace Credits.Tests;

[Collection("pg")]
public sealed class RetryTests(PostgresFixture pg)
{
    // Another request sneaks in between our SELECT and our UPDATE (autocommit, separate connection).
    private async Task ConcurrentTopUp(int amount)
    {
        await using var cmd = pg.Db.CreateCommand("UPDATE wallets SET balance = balance + $1 WHERE id = 1");
        cmd.Parameters.Add(new() { Value = amount });
        await cmd.ExecuteNonQueryAsync();
    }

    [Fact]
    public async Task Without_retry_the_conflict_surfaces_as_40001()
    {
        await pg.ResetAsync(100);
        var wallets = new Wallets(pg.Db);

        var ex = await Assert.ThrowsAsync<PostgresException>(() =>
            wallets.SpendAsync(1, 30, onAttempt: _ => ConcurrentTopUp(10), maxAttempts: 1));

        Assert.Equal(PostgresErrorCodes.SerializationFailure, ex.SqlState); // "40001"
        Assert.True(ex.IsTransient);
        Assert.Equal(110, await pg.BalanceAsync()); // our spend was rolled back, the top-up kept
    }

    [Fact]
    public async Task Retry_succeeds_on_the_second_attempt_without_losing_the_top_up()
    {
        await pg.ResetAsync(100);
        var wallets = new Wallets(pg.Db);

        var attempts = await wallets.SpendAsync(1, 30,
            onAttempt: a => a == 1 ? ConcurrentTopUp(10) : Task.CompletedTask);

        Assert.Equal(2, attempts);
        Assert.Equal(80, await pg.BalanceAsync()); // 100 + 10 - 30: no lost update
    }

    [Fact]
    public async Task Gives_up_after_max_attempts()
    {
        await pg.ResetAsync(100);
        var wallets = new Wallets(pg.Db);
        var seen = 0;

        var ex = await Assert.ThrowsAsync<PostgresException>(() =>
            wallets.SpendAsync(1, 30, onAttempt: _ => { seen++; return ConcurrentTopUp(1); }, maxAttempts: 3));

        Assert.Equal("40001", ex.SqlState);
        Assert.Equal(3, seen);
        Assert.Equal(103, await pg.BalanceAsync());
    }

    [Fact]
    public async Task Business_errors_are_not_retried()
    {
        await pg.ResetAsync(10);
        var wallets = new Wallets(pg.Db);
        var seen = 0;

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            wallets.SpendAsync(1, 30, onAttempt: _ => { seen++; return Task.CompletedTask; }));

        Assert.Equal(1, seen);
        Assert.Equal(10, await pg.BalanceAsync());
    }
}
```

**6. Run it**

```bash
dotnet test
```

The first run pulls `postgres:18` (can take a minute). Expected summary (the duration varies; on
a German/other-locale system the words are translated):

```text
Passed!  - Failed:     0, Passed:     4, Skipped:     0, Total:     4, Duration: 93 ms - Credits.Tests.dll (net10.0)
```

:::info title="Versions this lab was checked with"
.NET SDK 10.0.4xx (`dotnet new sln` creates `Credits.slnx`, the new XML solution format), the
`xunit` template's xUnit **v2** (2.9.x — so `IAsyncLifetime` returns `Task`), Npgsql 10 and
Testcontainers.PostgreSql 4.x, with Podman 5. If your template gives you xUnit **v3**,
`InitializeAsync`/`DisposeAsync` return `ValueTask` instead — change the two signatures.
:::

**7. Break it on purpose** (run `dotnet test` after each change, then undo it):

1. In `Wallets.cs`, change `IsolationLevel.Serializable` to `IsolationLevel.ReadCommitted`.
   Three tests fail — e.g. `Without_retry_the_conflict_surfaces_as_40001`: *No exception was
   thrown*. Read Committed happily writes `70` over the top-up: a **lost update**, silently.
2. In `PgRetry.IsRetryable`, remove `PostgresErrorCodes.SerializationFailure or`. Now
   `Retry_succeeds_on_the_second_attempt…` and `Gives_up_after_max_attempts` fail: the `40001`
   escapes on the first attempt.

**8. Clean up:** `cd .. && rm -rf credits-retry`. The container is already gone (`docker ps -a`
/ `podman ps -a` shows no `postgres:18` from this run once the reaper exits).

- [ ] `dotnet test` reports 4 passed against a `postgres:18` container
- [ ] With `ReadCommitted`, you saw the test fail and understood why it's a lost update
- [ ] Without `40001` in `IsRetryable`, you saw the retry tests fail
- [ ] You can explain why the retry re-runs the `SELECT` and not just the `UPDATE`
:::

:::job title="What reviewers look for in data-access code"
On day one in a .NET or Node team, a pull request touching the database gets checked for:
parameters everywhere (an interpolated string near SQL gets flagged), `await using` / `release()`
on every connection, no network calls inside a transaction, a `CancellationToken` passed through,
errors mapped by SQLSTATE, and an integration test on real Postgres for anything with
transactions or constraints.
:::

:::pro title="Make it observable"
Seniors set `Application Name` per service, log the SQLSTATE and the retry attempt number,
and export pool metrics (Npgsql publishes connection-pool usage and wait-time metrics through
`System.Diagnostics.Metrics`, which OpenTelemetry can collect — the exact metric names follow the
OpenTelemetry database conventions and have changed between Npgsql versions, so check the
[Npgsql diagnostics docs](https://www.npgsql.org/doc/diagnostics/metrics.html)). A slow rise in retries or pool wait time warns you days before an outage.
:::

:::cards id=db-20-cards1 xp=20 title="Postgres from code"
Q: Why use a connection pool?
A: Opening a connection costs a handshake, authentication and a new server process (5–50 ms). A
   pool keeps connections open and lends them out; "closing" returns it to the pool.
Q: Rule of thumb for how many connections you need?
A: Busy connections ≈ queries per second × average query time (800/s × 5 ms ≈ 4). The sum of all
   pools must stay below the server's max_connections.
Q: What breaks behind PgBouncer in transaction mode?
A: Anything session-level: plain SET, LISTEN, session advisory locks, temp tables across
   transactions, and prepared statements on old PgBouncer. Use SET LOCAL and xact locks.
Q: Why do parameters prevent SQL injection?
A: The SQL text and the values travel separately; Postgres parses the SQL first, then binds values
   as data. A value can never change the statement's structure.
Q: How do you make a client-chosen ORDER BY column safe?
A: An allow-list map from API names to SQL you wrote (checked with Object.hasOwn); reject anything
   else with 400. Identifiers can't be parameters.
Q: Which SQLSTATEs are safe to retry, and how?
A: 40001 serialization_failure and 40P01 deadlock_detected. Re-run the whole transaction from
   BEGIN, bounded attempts, jittered backoff, no outside side effects inside.
Q: The node-postgres transaction rule?
A: const client = await pool.connect(); run BEGIN … COMMIT on that client; ROLLBACK on error;
   client.release() in finally. Never BEGIN via pool.query.
Q: statement_timeout vs CommandTimeout?
A: statement_timeout is enforced by the server (57014) and protects the database. CommandTimeout is
   the driver's timer; Npgsql then sends a cancel request. Use both.
Q: 23505 → ? 23514 → ? 40001 after retries → ?
A: 409 Conflict; 422 Unprocessable; 503 with Retry-After.
Q: Why Testcontainers instead of InMemory/SQLite for data tests?
A: Only real Postgres raises real SQLSTATEs, honours isolation levels, constraints and ON CONFLICT.
   A throw-away postgres:18 container gives that per test run.
:::

## Recap

- The **driver** (Npgsql, `pg`) owns a **pool**; borrow late, return early (`await using`,
  `release()`), never hold a connection or transaction across calls to other services.
- Size pools from **qps × query time**; the sum of all pools must fit `max_connections`.
  **PgBouncer transaction mode** breaks session state — keep everything inside the transaction.
- **Parameters** for every value (`$1`, `@name`, `FromSql($"…")`); **allow-lists** for identifiers
  like `ORDER BY` columns. String-built SQL is a bug, even with "escaping".
- A transaction lives on **one connection**: pass `tx` to Npgsql commands; in Node use one
  `pool.connect()` client. After an error the transaction is aborted until `ROLLBACK`.
- Repeatable Read / Serializable require a **retry loop** for `40001`/`40P01`: whole transaction,
  bounded, jittered, side effects after commit. EF Core: `EnableRetryOnFailure` + execution strategy.
- **Timeouts** on both sides: `statement_timeout`/`lock_timeout` on the server, `Command Timeout`
  and `CancellationToken` in the client.
- Map **SQLSTATEs to HTTP** in one place: `23505`/`23503` → 409, `23502`/`23514`/`22P02` → 422,
  `40001`/`57014`/`53300` → 503, else 500 without leaking messages.
- Prove it with **Testcontainers + postgres:18** — next up, *jsonb, Arrays & Full-Text Search*.
