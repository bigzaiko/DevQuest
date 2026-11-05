---
id: be-18
title: Concurrency, Versions & Idempotency
level: expert
minutes: 85
xp: 200
summary: Stop lost updates with optimistic concurrency (version columns, xmin, 409 + current version, ETag/If-Match → 412), make POST retries safe with idempotency keys, and know when to lock pessimistically.
---

Two people open the same document in the Projects editor. Alice fixes a typo in the intro and
saves. Thirty seconds later Bob, who opened the page before Alice saved, adds a paragraph and
saves too. Bob's request carries **his whole copy** of the document, so Alice's fix is gone. Both
got `200 OK`. Nobody got an error. Nothing was logged.

That is the **lost update** problem. It is the most common data-corruption bug in CRUD
applications, and no amount of `try/catch` will show it to you. This lesson covers the tools a
production SaaS backend uses against it:

- **Optimistic concurrency**: version columns, EF Core concurrency tokens, Postgres `xmin`, and
  `409 Conflict` responses that include the current version.
- **HTTP conditional requests**: `ETag`, `If-Match` → `412`, `If-None-Match` → `304`, and `428`.
- **Idempotency keys**, so a retried `POST` can't create two of something.
- **Pessimistic locking** (`FOR UPDATE`, atomic conditional updates, advisory locks) for the
  cases where optimistic concurrency is the wrong tool, like owner-billed quotas.

## The lost-update problem, precisely

| Time | Alice | Bob | Row in DB |
|---|---|---|---|
| t0 | `GET /documents/42` → v3 | | `content=A, version=3` |
| t1 | | `GET /documents/42` → v3 | |
| t2 | `PUT` content=A′ | | `content=A′` |
| t3 | | `PUT` content=A+B | `content=A+B` ← Alice's edit is gone |

Database transactions **don't** prevent this. Each `PUT` is its own short, correct transaction.
The bug lives in the gap between t1 (Bob reads) and t3 (Bob writes). That gap is **user think
time**: seconds or minutes, spread over two HTTP requests, and no database transaction should
stay open that long.

What's missing is a rule: *"apply my write only if the row is still the version I read."* There
are two ways to enforce it.

| | Optimistic | Pessimistic |
|---|---|---|
| Idea | Don't lock. Detect conflicts at write time and reject the loser. | Lock the row first, so nobody else can change it. |
| Mechanism | `UPDATE … WHERE id = @id AND version = @readVersion` | `SELECT … FOR UPDATE` inside a transaction |
| Good for | Human editing, low or medium contention, anything that spans HTTP requests | Short server-side critical sections with high contention (counters, quotas, money) |
| Cost of a conflict | The client re-reads and retries or merges | Waiting, and possibly deadlocks |
| Spans user think time? | Yes, the version travels with the client | **No.** Never hold a lock across requests |

## Optimistic concurrency in EF Core

EF Core implements this with **concurrency tokens**. A property marked as a token is added to the
`WHERE` clause of every `UPDATE` and `DELETE` that EF generates, using the value EF holds as the
property's **original value**.

```csharp
public class Document
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public string Title { get; set; } = "";
    public string Content { get; set; } = "";
    public int Version { get; set; }
}

// OnModelCreating
modelBuilder.Entity<Document>()
    .Property(d => d.Version)
    .IsConcurrencyToken();          // or [ConcurrencyCheck] on the property
```

Saving a modified document now produces SQL like this:

```sql
UPDATE documents SET content = @p0, version = @p1
WHERE id = @p2 AND version = @p3;   -- @p3 = ORIGINAL version
```

If another writer bumped `version` in the meantime, the `WHERE` matches **0 rows**. EF Core checks
the affected-row count. When it expected 1 and got 0, it throws `DbUpdateConcurrencyException`,
and nothing is written.

That check is atomic at the database level. Under PostgreSQL's default `READ COMMITTED`, a second
concurrent `UPDATE` on the same row **waits** for the first transaction to commit. It then
re-evaluates its `WHERE` against the new row version, sees `version = 4 ≠ 3`, and updates
nothing. Exactly one writer wins, even if ten requests arrive in the same millisecond. The lab
proves this with ten parallel saves.

### The disconnected-client twist

In a web API the entity isn't loaded at t1 and saved at t3 by the same `DbContext`. The version the
client read comes back **in the request**. If you load the row fresh at t3, its original value is
whatever is in the database now, which would make the check pointless. You have to tell EF
which version the client actually edited:

```csharp
var doc = await db.Documents.SingleAsync(d => d.Id == id, ct);

db.Entry(doc).Property(d => d.Version).OriginalValue = req.Version; // what the CLIENT saw
doc.Content = req.Content;
doc.Version = req.Version + 1;                                       // the new version

await db.SaveChangesAsync(ct);  // WHERE version = req.Version
```

:::warn title="An int token is just a column"
EF Core doesn't increment an `int` concurrency token for you. If you forget `doc.Version++`, the
version never changes. Every stale writer then matches `WHERE version = 3` and wins, and you have
lost updates again, this time with code that looks protected. Many teams increment centrally in a
`SaveChangesAsync` override for every entity that implements an `IVersioned` interface.
:::

```csharp
public interface IVersioned { int Version { get; set; } }

// Override the (bool, CancellationToken) overload: every other async overload calls it.
public override Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken ct = default)
{
    BumpVersions();
    return base.SaveChangesAsync(acceptAllChangesOnSuccess, ct);
}

// Synchronous SaveChanges() does NOT go through the async override, so cover it too.
public override int SaveChanges(bool acceptAllChangesOnSuccess)
{
    BumpVersions();
    return base.SaveChanges(acceptAllChangesOnSuccess);
}

private void BumpVersions()
{
    foreach (var e in ChangeTracker.Entries<IVersioned>())   // Entries() runs DetectChanges first
        if (e.State == EntityState.Modified)
            e.Entity.Version++;     // original value stays the old one → WHERE version = old
}
```

If you adopt this override, handlers set only `OriginalValue = req.Version` and **don't** write
`doc.Version = req.Version + 1` themselves, or every save would jump by two. Pick one place to
increment. The rest of this lesson (and the lab) increments in the handler so you can see it.

### Option B: PostgreSQL's `xmin`

Every Postgres row has a hidden system column, `xmin`: the ID of the transaction that last wrote
that row version. It changes automatically on every update. Npgsql maps a `uint` row-version
property to it:

```csharp
public class Document
{
    // ...
    [Timestamp]                     // or .Property(d => d.RowVersion).IsRowVersion()
    public uint RowVersion { get; set; }   // Npgsql maps this to the xmin system column
}
```

You need no migration column and no increment code, because the database does it. The trade-offs:

- `xmin` changes on **any** update to the row, including a background job touching
  `updated_at`, so you can get false conflicts.
- It's a 32-bit transaction ID. It's fine as a "has it changed?" token, but it isn't a
  meaningful, monotonic document version for users ("version 17").
- It's Postgres-specific and changes after a dump/restore. That doesn't matter for
  in-flight edits, but it means you shouldn't persist it in clients long-term.

:::pro title="What production teams pick"
For **client-facing** document versions, use an explicit `int Version` column. It's readable in
URLs, logs and UIs ("you're editing v12, the server has v14"), it fits ETags, and SignalR events
can carry it (be-17). Use `xmin` for **internal** entities where you only need "did someone change
this row?" and don't want to maintain a column.
:::

### Handling `DbUpdateConcurrencyException`

When the exception fires, you choose a policy:

| Policy | What you do | Use when |
|---|---|---|
| **Reject (store wins)** | Return 409 with the current state | Human-edited content. The default for this course. |
| **Client wins** | Reload original values and save again | Last-writer-wins is acceptable (user preferences) |
| **Merge** | Combine field by field (e.g. title from A, tags from B) | Structured data with independent fields |
| **Retry the operation** | Re-run the whole read-modify-write | Server-side computations such as counters |

```csharp
catch (DbUpdateConcurrencyException ex)
{
    var entry = ex.Entries.Single();
    var dbValues = await entry.GetDatabaseValuesAsync(ct);
    if (dbValues is null) return Results.NotFound();          // deleted meanwhile
    var currentVersion = dbValues.GetValue<int>(nameof(Document.Version));
    // ... build the 409 response
}
```

### Bulk updates don't check tokens for you

`ExecuteUpdateAsync` / `ExecuteDeleteAsync` (be-11) send one SQL statement and skip the change
tracker, **so concurrency tokens aren't applied**. Put the check in the `Where` yourself. That
gives you a fast, single-round-trip optimistic update:

```csharp
var rows = await db.Documents
    .Where(d => d.Id == id && d.Version == req.Version)
    .ExecuteUpdateAsync(s => s
        .SetProperty(d => d.Content, req.Content)
        .SetProperty(d => d.Version, d => d.Version + 1), ct);

if (rows == 0)   // either the document doesn't exist or the version is stale. Query to tell which.
    return await NotFoundOrConflict(id, ct);
```

:::quiz id=be-18-q1 xp=15
Alice and Bob both loaded document 42 at `version = 3`. Both send `PUT` with `version: 3` at the
same moment. The handler sets `OriginalValue = req.Version`, increments, and calls
`SaveChangesAsync`. PostgreSQL uses its default isolation level. What happens?

- [ ] Both succeed, because `READ COMMITTED` doesn't prevent concurrent writes
- [ ] Both fail with a deadlock error
- [x] One `UPDATE` matches the row and commits. The other waits, re-checks `version = 3` against the committed row, matches 0 rows, and EF throws `DbUpdateConcurrencyException`
- [ ] Whichever arrives second overwrites the first, because EF Core retries automatically
> The concurrency token is part of the `WHERE`. Postgres serializes writers on the same row: the second one waits for the first commit, then re-evaluates its predicate against the new row version (`version = 4`). Zero rows means EF raises `DbUpdateConcurrencyException`, which you translate to `409`. "Both succeed" is what happens **without** a token, and that's the lost update. There's no deadlock (both want one row, so there's no cycle), and EF Core never silently retries a concurrency failure.
:::

:::quiz id=be-18-q2 xp=15
**Spot the bug.** This handler is supposed to reject stale saves.

```csharp
app.MapPut("/documents/{id:guid}", async (Guid id, UpdateDocumentRequest req, AppDbContext db) =>
{
    var doc = await db.Documents.SingleAsync(d => d.Id == id);
    doc.Version = req.Version;          // "use the client's version for the check"
    doc.Content = req.Content;
    doc.Version++;
    await db.SaveChangesAsync();
    return Results.Ok(doc);
});
```

- [ ] Nothing is wrong. The client's version is used in the `WHERE`
- [x] EF uses the **original** value (the version loaded just now) in the `WHERE`, so a stale client still wins. It must set `db.Entry(doc).Property(d => d.Version).OriginalValue = req.Version`
- [ ] `doc.Version++` throws because concurrency tokens are read-only
- [ ] `SingleAsync` should be `FindAsync`. That's the only problem
> Assigning the property changes its *current* value. The `WHERE version = @original` still uses what was loaded from the database a millisecond ago, so it only protects that tiny window, not the user's think time. Setting `OriginalValue` (or comparing explicitly and using `ExecuteUpdate` with the version in `Where`) is what makes it correct.
:::

:::quiz id=be-18-q3 xp=10
A team marks `Version` with `[ConcurrencyCheck]` and never increments it anywhere. What happens
with Alice's and Bob's stale saves?

- [ ] EF Core increments it automatically on every save
- [ ] Every save throws `DbUpdateConcurrencyException`
- [x] Both saves match `WHERE version = 3`, because the version never changes. Lost updates are back
- [ ] PostgreSQL rejects the update because the token didn't change
> Only database-generated tokens (`xmin`, SQL Server `rowversion`) change by themselves. For an app-managed `int` you have to bump it yourself, ideally centrally in a `SaveChangesAsync` override.
:::

## Telling the client: `409 Conflict` with the current version

A bare `409` isn't enough. The client needs to know **what** it conflicted with, so it can show a
merge view ("Alice changed this paragraph") or at least reload without guessing. Return a
ProblemDetails (be-06) with extensions:

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
ETag: "2"

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.10",
  "title": "The document was changed by someone else",
  "status": 409,
  "detail": "You edited a stale version. The current version is 2.",
  "currentVersion": 2,
  "current": { "id": "4230…", "title": "Spec", "content": "Alice", "version": 2 },
  "traceId": "00-37af3f4a…-00"
}
```

```csharp
static IResult Conflict(Document current) => Results.Problem(
    statusCode: StatusCodes.Status409Conflict,
    title: "The document was changed by someone else",
    detail: $"You edited a stale version. The current version is {current.Version}.",
    extensions: new Dictionary<string, object?>
    {
        ["currentVersion"] = current.Version,
        ["current"] = DocumentDto.From(current),   // saves the client a round trip
    });
```

On the React side, the editor keeps `baseVersion` (the version the user started editing from).
On `409`, it shows *"Bob saved a newer version"* with three options: **reload** (lose my
changes), **overwrite** (re-send with `currentVersion`, which is an explicit, logged decision
rather than a silent one) or **merge**.

:::job title="What you'll meet on day one"
Many codebases don't have this at all, and the lost update shows up as a support ticket ("my
changes vanished"). If you join a team and see `PUT` endpoints without any version or `If-Match`,
asking *"what happens if two people save at once?"* is one of the most valuable questions a new
hire can ask. Expect to add a `version` column, a migration, and a `409` path to the frontend.
:::

## ETags and conditional requests: the HTTP-native way

HTTP already has this mechanism built in. An **ETag** is an opaque validator for a representation.
Using the version as the ETag ties the two concepts together:

```http
GET /documents/42                    →  200 OK
                                        ETag: "3"

PUT /documents/42                    →  200 OK          (version matched)
If-Match: "3"                            ETag: "4"

PUT /documents/42                    →  412 Precondition Failed
If-Match: "3"                            ETag: "4"       (someone else saved v4)

GET /documents/42                    →  304 Not Modified  (no body: cache is still valid)
If-None-Match: "4"
```

| Status | Meaning | When |
|---|---|---|
| `409 Conflict` | The request conflicts with the resource's current state | The version is in the **body** and is stale (domain-level conflict) |
| `412 Precondition Failed` | A conditional header (`If-Match`) evaluated to false | The version came in **`If-Match`** and is stale |
| `428 Precondition Required` | The server *requires* a conditional request | The client sent neither version nor `If-Match`. This stops clients that "forgot" from silently overwriting |
| `304 Not Modified` | `If-None-Match` matched on a `GET` | Cache revalidation |

Details that matter:

- **Strong vs weak.** `W/"3"` is a *weak* ETag ("semantically equivalent"). `If-Match` uses
  **strong comparison** (RFC 9110 §13.1.1), so a weak tag never matches. Use strong ETags
  for anything you'll write against.
- `If-Match: *` means "any current representation exists". It's useful for "update, but don't
  create".
- `If-Match` may contain a list: `"3", "4"`.
- Response compression and some proxies weaken ETags. Generate them from your **version**,
  not from a hash of the bytes on the wire.
- Browsers can read the `ETag` response header from `fetch` only if it's same-origin or listed in
  CORS `Access-Control-Expose-Headers: ETag`. Forgetting this is a classic SPA bug.

:::quiz id=be-18-q4 xp=10
Match the situation to the right status. A client sends
`PUT /documents/42` with **no** `If-Match` header and **no** `version` in the body. Your API
requires one of them.

- [ ] `409 Conflict`
- [ ] `412 Precondition Failed`
- [x] `428 Precondition Required`
- [ ] `400 Bad Request` with no further information
> `428` (RFC 6585) exists for exactly this: "this resource needs a conditional request". `412` means a precondition you *sent* was false, and nothing was sent here. `409` is for a stale version in the body, but there's no version to be stale. A bare `400` is the generic "malformed request" catch-all and tells the client nothing about what to add; HTTP has a dedicated code for this case, `428`, ideally with a ProblemDetails body saying "send If-Match or a version".
:::

:::quiz id=be-18-q5 xp=15
A proxy turned your ETag into `W/"7"`. The client sends `If-Match: W/"7"` and the document really
is at version 7. What should a spec-compliant server answer?

- [ ] `200`, because the version number matches
- [x] `412`, because `If-Match` uses strong comparison and weak validators never match
- [ ] `304 Not Modified`
- [ ] `428 Precondition Required`
> RFC 9110 requires strong comparison for `If-Match`: both tags must be strong and byte-identical. Weak ETags are only good for `If-None-Match` and caching. This is why you set ETags yourself from the version and make sure compression middleware doesn't weaken them.
:::

:::challenge id=be-18-c1 lang=ts xp=50
title: Evaluate `If-Match` like RFC 9110
Implement `evaluateIfMatch(header, currentEtag)`, which returns the HTTP status a `PUT` should get
before any work happens:

- `header` is `undefined` (no `If-Match`) → `428`.
- `*` → `200` (any current representation matches).
- Otherwise `header` is a comma-separated list like `"1", W/"2" , "3"`. Return `200` if **any**
  strong tag in the list equals `currentEtag` exactly, else `412`.
- Weak tags (`W/"…"`) never match, even when the value is equal.
- `currentEtag` is always a strong tag such as `"3"`. Whitespace around list items is allowed.

hint: Split on `,`, `trim()` each part, and skip parts that start with `W/`.
hint: Compare the whole quoted string, quotes included: `'"3"' === '"3"'`.

```ts starter
export function evaluateIfMatch(header: string | undefined, currentEtag: string): number {
  if (header === currentEtag) return 200
  return 412
}
```

```ts solution
export function evaluateIfMatch(header: string | undefined, currentEtag: string): number {
  if (header === undefined) return 428
  const value = header.trim()
  if (value === '*') return 200
  const tags = value.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
  for (const tag of tags) {
    if (tag.startsWith('W/')) continue
    if (tag === currentEtag) return 200
  }
  return 412
}
```

```ts tests
test('missing header requires a precondition', () => {
  expect(evaluateIfMatch(undefined, '"3"')).toBe(428)
})
test('exact strong match passes', () => {
  expect(evaluateIfMatch('"3"', '"3"')).toBe(200)
})
test('stale tag fails', () => {
  expect(evaluateIfMatch('"2"', '"3"')).toBe(412)
})
test('star matches anything', () => {
  expect(evaluateIfMatch('*', '"9"')).toBe(200)
})
test('weak tag never matches', () => {
  expect(evaluateIfMatch('W/"3"', '"3"')).toBe(412)
})
test('list with whitespace matches any strong member', () => {
  expect(evaluateIfMatch(' "1", W/"3" ,  "3" ', '"3"')).toBe(200)
  expect(evaluateIfMatch('"1", W/"3"', '"3"')).toBe(412)
})
```
:::

## Idempotency keys: making POST safe to retry

An operation is **idempotent** if doing it twice has the same *effect on the server* as doing it
once. HTTP defines `GET`, `PUT` and `DELETE` as idempotent: "set document 42 to this content"
twice still leaves one document with that content. (The *response* may differ: with the version
check above, a retried `PUT` whose first attempt actually succeeded gets a `409`, because the
version already moved on. A good client compares `current.content` in the 409 with what it sent
and treats a match as "my save went through".) `POST` is different. "Create a document" twice
creates **two** documents.

Retries happen more often than you'd think:

- The mobile network drops the response **after** the server committed. The client sees a timeout
  and retries.
- A user double-clicks "Create".
- Your own resilience pipeline (be-19) retries a `POST` that timed out on the client side.
- A job worker (be-16) crashes after calling an API and re-runs the job (at-least-once delivery).

The fix, popularized by Stripe and being standardized as the IETF `Idempotency-Key` header, works
like this:

1. The client generates a unique key (a UUID) **per logical operation** and sends
   `Idempotency-Key: 8e0f…` with the `POST`. It reuses the **same key** for every retry.
2. The server stores `(key, hash of request, response)` **atomically with the effect**.
3. If the same key comes back with the same request, the server **replays the stored response**
   and doesn't execute again.
4. If the same key comes back with a **different** body, that's a client bug. Return `422`.
5. If the first request is still in flight, either return `409` ("retry later") or wait. The
   database's unique constraint makes sure only one execution wins.

```csharp
db.Documents.Add(doc);
db.IdempotencyRecords.Add(new IdempotencyRecord
{
    Key = key, RequestHash = hash, StatusCode = 201,
    ResponseBody = JsonSerializer.Serialize(dto, JsonSerializerOptions.Web),
    Location = $"/documents/{doc.Id}", CreatedAt = clock.GetUtcNow(),   // injected TimeProvider
});

try
{
    await db.SaveChangesAsync(ct);   // ONE transaction: the effect and the record commit together
}
catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
{
    db.ChangeTracker.Clear();         // a concurrent twin won the race
    var winner = await db.IdempotencyRecords.AsNoTracking().SingleAsync(r => r.Key == key, ct);
    return Replay(winner, hash);
}
```

Design decisions seniors get asked about in reviews:

- **Same transaction as the effect.** If the record lives in Redis but the document lives in
  Postgres, a crash between the two writes gives you either a duplicate (record lost) or a
  phantom (record without a document). If the effect is in the database, put the record there
  too. Use Redis only for effects that are themselves non-transactional, and accept the window.
- **Scope keys** per user or tenant (`PRIMARY KEY (user_id, key)`). Otherwise user A's key can
  replay user B's response, which is a data leak.
- **Expire** records after about 24 hours with a cleanup job. Keys aren't meant to last forever.
- **Hash the request** (method + route + body) to detect key reuse with different payloads.
- Store only successful and deterministic failure responses. Don't store a `500`. The client
  should be able to retry that for real.
- **The cheapest idempotency** is a client-generated ID: `PUT /documents/{clientGeneratedGuid}`
  is naturally idempotent, so you may not need a key table at all.

:::quiz id=be-18-q6 xp=15
The API creates the document in Postgres, commits, and **then** writes the idempotency record to
Redis. The process crashes between the two steps, and the client retries with the same key. What
happens?

- [ ] Redis replays the response, so all is well
- [x] No record is found, so the document is created a second time. The two writes weren't atomic
- [ ] Postgres rejects the duplicate because the key is unique
- [ ] The client gets `422`
> Idempotency is only as strong as the atomicity between "the effect happened" and "we remember it happened". The Redis lookup finds nothing, so there's nothing to replay and no reason for a `422`, and Postgres can't reject the second document because the key was never written to Postgres. Store the record in the same database transaction as the effect, and the unique key then also settles concurrent duplicates.
:::

:::challenge id=be-18-c2 lang=ts xp=60
title: An idempotent request wrapper
Write `createIdempotent(handler)`. It returns `send(key, body)`, which calls the async
`handler(body)` **at most once per key**:

- With no key (`undefined`), always call the handler.
- First call with a key: run the handler and remember `{ bodyJson, result }` (use
  `JSON.stringify(body)` as the "hash").
- Same key + same body: return the **same result** without calling the handler again, and mark
  it by returning `{ ...result, replayed: true }`.
- Same key + **different** body: return `{ status: 422 }` without calling the handler.
- **Concurrent** calls with the same key (the first hasn't finished yet) must not run the handler
  twice. Store the *promise* immediately.
- If the handler **throws**, forget the key so a real retry can run again, and re-throw.

hint: Keep a `Map<string, { bodyJson: string; promise: Promise<Result> }>` and insert before awaiting.
hint: The first caller gets the plain result. Later callers get `{ ...result, replayed: true }`.
hint: In a `catch`, `map.delete(key)` and then `throw e`.

```ts starter
type Result = { status: number; id?: string; replayed?: boolean }

export function createIdempotent(handler: (body: unknown) => Promise<Result>) {
  return async (key: string | undefined, body: unknown): Promise<Result> => {
    return handler(body)
  }
}
```

```ts solution
type Result = { status: number; id?: string; replayed?: boolean }

export function createIdempotent(handler: (body: unknown) => Promise<Result>) {
  const seen = new Map<string, { bodyJson: string; promise: Promise<Result> }>()
  return async (key: string | undefined, body: unknown): Promise<Result> => {
    if (key === undefined) return handler(body)
    const bodyJson = JSON.stringify(body)
    const prior = seen.get(key)
    if (prior) {
      if (prior.bodyJson !== bodyJson) return { status: 422 }
      const r = await prior.promise
      return { ...r, replayed: true }
    }
    const promise = handler(body)
    seen.set(key, { bodyJson, promise })
    try {
      return await promise
    } catch (e) {
      seen.delete(key)
      throw e
    }
  }
}
```

```ts tests
const created = () => {
  let n = 0
  return fn(async (_body: unknown) => {
    n++
    await sleep(5)
    return { status: 201, id: 'doc-' + n }
  })
}

test('without a key every call executes', async () => {
  const h = created()
  const send = createIdempotent(h)
  await send(undefined, { t: 'a' })
  await send(undefined, { t: 'a' })
  expect(h).toHaveBeenCalledTimes(2)
})

test('a retry with the same key replays the first result', async () => {
  const h = created()
  const send = createIdempotent(h)
  const a = await send('k1', { t: 'a' })
  const b = await send('k1', { t: 'a' })
  expect(h).toHaveBeenCalledTimes(1)
  expect(a).toEqual({ status: 201, id: 'doc-1' })
  expect(b).toEqual({ status: 201, id: 'doc-1', replayed: true })
})

test('same key with a different body is a 422', async () => {
  const h = created()
  const send = createIdempotent(h)
  await send('k1', { t: 'a' })
  expect(await send('k1', { t: 'b' })).toEqual({ status: 422 })
  expect(h).toHaveBeenCalledTimes(1)
})

test('concurrent duplicates execute once', async () => {
  const h = created()
  const send = createIdempotent(h)
  const results = await Promise.all([send('k2', { t: 'x' }), send('k2', { t: 'x' }), send('k2', { t: 'x' })])
  expect(h).toHaveBeenCalledTimes(1)
  expect(results.map((r) => r.id)).toEqual(['doc-1', 'doc-1', 'doc-1'])
})

test('a failed execution can be retried', async () => {
  let calls = 0
  const send = createIdempotent(async () => {
    calls++
    if (calls === 1) throw new Error('db down')
    return { status: 201, id: 'ok' }
  })
  await expect(send('k3', {})).rejects.toThrow('db down')
  expect(await send('k3', {})).toEqual({ status: 201, id: 'ok' })
  expect(calls).toBe(2)
})
```
:::

## Pessimistic locking: when optimism is the wrong tool

Optimistic concurrency assumes conflicts are **rare** and that the loser can **retry**. Some
operations break both assumptions. They're short, server-side, highly contended, and the user
shouldn't see "conflict, try again".

**Example: owner-billed quotas.** The owner's plan allows 10 projects. This naive check is a race:

```csharp
var used = await db.Projects.CountAsync(p => p.OwnerId == ownerId, ct);   // two requests both see 9
if (used >= account.MaxProjects) return QuotaExceeded();
db.Projects.Add(project);                                                  // both insert → 11 projects
await db.SaveChangesAsync(ct);
```

Three correct fixes, from simplest to most general:

**1. An atomic conditional update (no explicit lock).** Keep a counter and let one `UPDATE` both
check and reserve:

```csharp
await using var tx = await db.Database.BeginTransactionAsync(ct);

var reserved = await db.Accounts
    .Where(a => a.UserId == ownerId && a.ProjectCount < a.MaxProjects)
    .ExecuteUpdateAsync(s => s.SetProperty(a => a.ProjectCount, a => a.ProjectCount + 1), ct);
if (reserved == 0) return QuotaExceeded();          // the WHERE did the check atomically

db.Projects.Add(project);
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);                            // insert fails → the reservation rolls back
```

This works for the same reason as the version check: a concurrent `UPDATE` of the same account
row waits, then re-evaluates `ProjectCount < MaxProjects` against the committed value. The cost
is a denormalized counter you must keep in sync: deleting a project has to decrement it in the
same transaction.

**2. `SELECT … FOR UPDATE`.** Lock the owner's row, so concurrent creators for the **same owner**
queue up while other owners stay unaffected:

```csharp
await using var tx = await db.Database.BeginTransactionAsync(ct);
var account = await db.Accounts
    .FromSql($"SELECT * FROM accounts WHERE user_id = {ownerId} FOR UPDATE")
    .SingleAsync(ct);                                // second request blocks here until we commit
var used = await db.Projects.CountAsync(p => p.OwnerId == ownerId, ct);
if (used >= account.MaxProjects) return QuotaExceeded();
db.Projects.Add(project);
await db.SaveChangesAsync(ct);
await tx.CommitAsync(ct);
```

Why does the `CountAsync` now see the other request's project? Under `READ COMMITTED` every
**statement** takes a fresh snapshot. The second request blocks on `FOR UPDATE` until the first
commits, so its `COUNT` runs afterwards and sees 10. (Under `REPEATABLE READ` the snapshot is
fixed when the transaction's first statement starts, *before* it blocked on the lock, so the
`COUNT` would still see 9 and the race would quietly be back.) The account row works as a
**mutex for that owner** even though we never update it.

**3. Advisory locks** (`SELECT pg_advisory_xact_lock(hashtext(@key))`) when no natural row exists
to lock, e.g. "only one import per project at a time".

Locking rules that keep you out of trouble:

- Keep locked transactions **short**: no HTTP calls and no user input inside them.
- Lock rows in a **consistent order** (for example by id) to avoid deadlocks. Postgres detects
  deadlocks and kills one transaction with SQLSTATE `40P01`, which you then retry.
- `FOR UPDATE NOWAIT` fails immediately instead of waiting. `FOR UPDATE SKIP LOCKED` skips
  locked rows, which is the basis of the Postgres job queue in be-16.
- `SERIALIZABLE` isolation detects these anomalies for you and aborts with `40001`, but
  then **every** such transaction must be retryable. Npgsql's retrying execution strategy treats
  `40001` and `40P01` as transient, as long as you wrap the transaction in
  `db.Database.CreateExecutionStrategy().ExecuteAsync(…)`.

:::quiz id=be-18-q7 xp=15
Which changes make the quota check above race-free? *(Select all that apply.)*

- [x] Reserve with `ExecuteUpdateAsync` and `Where(a => a.ProjectCount < a.MaxProjects)`, and treat 0 affected rows as "quota exceeded"
- [x] Lock the owner's account row with `SELECT … FOR UPDATE` in the same transaction before counting
- [ ] Wrap the count and insert in a `READ COMMITTED` transaction. Transactions make it atomic
- [ ] Add an `[ConcurrencyCheck]` attribute to `Project.Name`
- [x] Run the transaction as `SERIALIZABLE` and retry on SQLSTATE `40001`
> A plain `READ COMMITTED` transaction doesn't stop two transactions from both counting 9. You need either a single atomic statement, a lock that serializes the contenders, or serializable isolation with retries. A token on an unrelated column does nothing.
:::

:::quiz id=be-18-q8 xp=10
Why shouldn't the editor's "save document" flow use `SELECT … FOR UPDATE` taken when the user
**opens** the document?

- [ ] `FOR UPDATE` isn't supported by EF Core
- [x] The lock would have to be held across HTTP requests and user think time. That means holding a connection and transaction open for minutes, which blocks everyone else and leaks locks when the browser tab closes
- [ ] Postgres can lock only one row per transaction
- [ ] It would make reads slower for other users
> Pessimistic locks belong to short server-side critical sections. For anything that spans a human, use optimistic concurrency: let everyone edit and reject the stale save.
:::

## How this plays with live co-editing

In the Projects editor (be-17) the pieces fit together like this:

1. The client opens document v7 and keeps `baseVersion = 7`.
2. It autosaves with a debounced `PUT` plus `If-Match: "7"` or `version: 7`.
3. On `200 OK` with `ETag: "8"` it sets `baseVersion = 8`. The server broadcasts
   `DocumentSaved { version: 8 }` to the project's SignalR group.
4. Other clients that have **no unsaved changes** just apply v8. A client **with** unsaved changes
   shows a merge prompt instead of clobbering the user's typing.
5. If a save loses the race, it gets `409` or `412` with `current`, and the same merge prompt
   appears.

That's **document-level** optimistic concurrency. It's correct and simple, and it's what most
SaaS products ship. Character-level simultaneous typing (Google Docs style) needs operational
transforms or CRDTs (e.g. Yjs), which merge concurrent edits instead of rejecting them. It's a
deliberate, much bigger step.

:::lab id=be-18-lab1 xp=150
title: Versioned saves with 409, 412 and idempotent POST on real Postgres
You'll build a small Documents API with an explicit version column, `409`/`412`/`428`, ETags,
`304`, and an `Idempotency-Key` table. Then you'll **prove** it with integration tests against a
real PostgreSQL 18 container, including ten truly parallel saves.

**Prerequisites:** .NET 10 SDK and a running Docker (or Podman with the Docker socket enabled).

**1. Create the solution**

```bash
mkdir -p ~/devquest/be-18-lab1 && cd ~/devquest/be-18-lab1
dotnet new sln -n Docs
dotnet new web -o Docs.Api
dotnet new xunit -o Docs.Tests
dotnet sln add Docs.Api Docs.Tests
dotnet add Docs.Api package Npgsql.EntityFrameworkCore.PostgreSQL
dotnet add Docs.Tests reference Docs.Api
dotnet add Docs.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet add Docs.Tests package Testcontainers.PostgreSql
rm Docs.Tests/UnitTest1.cs
```

**2. The model.** Create `Docs.Api/Data.cs`:

```csharp
using Microsoft.EntityFrameworkCore;

namespace Docs.Api;

public class Document
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public string Title { get; set; } = "";
    public string Content { get; set; } = "";
    public int Version { get; set; }          // our explicit, client-visible version
}

public class IdempotencyRecord
{
    public string Key { get; set; } = "";     // primary key → the UNIQUE constraint does the race-proofing
    public string RequestHash { get; set; } = "";
    public int StatusCode { get; set; }
    public string ResponseBody { get; set; } = "";
    public string? Location { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<IdempotencyRecord> IdempotencyRecords => Set<IdempotencyRecord>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Document>(e =>
        {
            e.Property(d => d.Title).HasMaxLength(200);
            // Every UPDATE/DELETE gets "... AND version = @originalVersion".
            e.Property(d => d.Version).IsConcurrencyToken();
        });
        b.Entity<IdempotencyRecord>().HasKey(r => r.Key);
    }
}
```

**3. The API.** Replace `Docs.Api/Program.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Docs.Api;
using Microsoft.EntityFrameworkCore;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Docs")));
builder.Services.AddProblemDetails();

var app = builder.Build();

// Lab shortcut: create the schema on startup. Real apps use migrations (be-09).
using (var scope = app.Services.CreateScope())
    scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.EnsureCreated();

// ---------- GET: returns an ETag, honours If-None-Match ----------
app.MapGet("/documents/{id:guid}", async (Guid id, HttpContext http, AppDbContext db) =>
{
    var doc = await db.Documents.AsNoTracking().SingleOrDefaultAsync(d => d.Id == id);
    if (doc is null) return Results.NotFound();

    var etag = ETags.For(doc.Version);
    http.Response.Headers.ETag = etag;
    if (http.Request.Headers.IfNoneMatch.ToString() == etag)
        return Results.StatusCode(StatusCodes.Status304NotModified);
    return Results.Ok(DocumentDto.From(doc));
});

// ---------- POST: create, with an optional Idempotency-Key ----------
app.MapPost("/projects/{projectId:guid}/documents",
    async (Guid projectId, CreateDocumentRequest req, HttpContext http, AppDbContext db) =>
{
    var key = http.Request.Headers["Idempotency-Key"].ToString();
    var hash = Convert.ToHexString(SHA256.HashData(
        Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { projectId, req }))));

    if (key.Length > 0)
    {
        var seen = await db.IdempotencyRecords.AsNoTracking().SingleOrDefaultAsync(r => r.Key == key);
        if (seen is not null) return Idempotency.Replay(seen, hash, http);
    }

    var doc = new Document
    {
        Id = Guid.NewGuid(), ProjectId = projectId,
        Title = req.Title, Content = req.Content, Version = 1,
    };
    db.Documents.Add(doc);
    var dto = DocumentDto.From(doc);
    var location = $"/documents/{doc.Id}";

    if (key.Length > 0)
        db.IdempotencyRecords.Add(new IdempotencyRecord
        {
            Key = key, RequestHash = hash, StatusCode = StatusCodes.Status201Created,
            ResponseBody = JsonSerializer.Serialize(dto, JsonSerializerOptions.Web),
            // Housekeeping stamp only (a cleanup job purges old keys); no request logic reads it,
            // so the lab skips injecting TimeProvider here. Inject it as soon as a rule depends on it.
            Location = location, CreatedAt = DateTimeOffset.UtcNow,
        });

    try
    {
        await db.SaveChangesAsync();   // document + idempotency record: ONE transaction
    }
    catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
    {
        // A concurrent request with the same key won the race. Replay its result.
        db.ChangeTracker.Clear();
        var winner = await db.IdempotencyRecords.AsNoTracking().SingleAsync(r => r.Key == key);
        return Idempotency.Replay(winner, hash, http);
    }

    http.Response.Headers.ETag = ETags.For(doc.Version);
    return Results.Created(location, dto);
});

// ---------- PUT: optimistic concurrency via body version (409) or If-Match (412) ----------
app.MapPut("/documents/{id:guid}", async (Guid id, UpdateDocumentRequest req, HttpContext http, AppDbContext db) =>
{
    var doc = await db.Documents.SingleOrDefaultAsync(d => d.Id == id);
    if (doc is null) return Results.NotFound();

    var ifMatch = http.Request.Headers.IfMatch.ToString();
    var viaHeader = ifMatch.Length > 0;
    int expected;
    if (viaHeader)
    {
        if (ifMatch == "*") expected = doc.Version;
        else if (!ETags.TryParse(ifMatch, out expected))
            return Stale(doc, viaHeader: true, http);   // weak or garbage tag never matches
    }
    else if (req.Version is int v) expected = v;
    else return Results.Problem(statusCode: StatusCodes.Status428PreconditionRequired,
        title: "Precondition required",
        detail: "Send an If-Match header or the version you edited in the body.");

    // Cheap early check (no write needed if we already know it's stale)...
    if (doc.Version != expected) return Stale(doc, viaHeader, http);

    // ...but the real guarantee is the concurrency token in the UPDATE's WHERE clause.
    db.Entry(doc).Property(d => d.Version).OriginalValue = expected;
    doc.Title = req.Title;
    doc.Content = req.Content;
    doc.Version = expected + 1;

    try
    {
        await db.SaveChangesAsync();
    }
    catch (DbUpdateConcurrencyException)
    {
        // Someone committed between our SELECT and our UPDATE.
        var current = await db.Documents.AsNoTracking().SingleAsync(d => d.Id == id);
        return Stale(current, viaHeader, http);
    }

    http.Response.Headers.ETag = ETags.For(doc.Version);
    return Results.Ok(DocumentDto.From(doc));
});

app.Run();

static IResult Stale(Document current, bool viaHeader, HttpContext http)
{
    http.Response.Headers.ETag = ETags.For(current.Version);
    return Results.Problem(
        statusCode: viaHeader ? StatusCodes.Status412PreconditionFailed : StatusCodes.Status409Conflict,
        title: "The document was changed by someone else",
        detail: $"You edited a stale version. The current version is {current.Version}.",
        extensions: new Dictionary<string, object?>
        {
            ["currentVersion"] = current.Version,
            ["current"] = DocumentDto.From(current),
        });
}

public record CreateDocumentRequest(string Title, string Content);
public record UpdateDocumentRequest(string Title, string Content, int? Version);
public record DocumentDto(Guid Id, Guid ProjectId, string Title, string Content, int Version)
{
    public static DocumentDto From(Document d) => new(d.Id, d.ProjectId, d.Title, d.Content, d.Version);
}

static class ETags
{
    public static string For(int version) => $"\"{version}\"";

    // Strong comparison only: W/"3" is NOT accepted for If-Match (RFC 9110 §13.1.1).
    // Lab simplification: a list such as "1", "2" is not parsed and therefore gets 412.
    // (The be-18-c1 challenge implements the full list rule.)
    public static bool TryParse(string header, out int version)
    {
        version = 0;
        var s = header.Trim();
        return s.Length >= 2 && s[0] == '"' && s[^1] == '"' && int.TryParse(s[1..^1], out version);
    }
}

static class Idempotency
{
    public static IResult Replay(IdempotencyRecord record, string hash, HttpContext http)
    {
        if (record.RequestHash != hash)
            return Results.Problem(statusCode: StatusCodes.Status422UnprocessableEntity,
                title: "Idempotency-Key reused with a different request");

        http.Response.Headers["Idempotent-Replayed"] = "true";
        if (record.Location is not null) http.Response.Headers.Location = record.Location;
        return Results.Text(record.ResponseBody, "application/json", Encoding.UTF8, record.StatusCode);
    }
}

public partial class Program;
```

Read it once before moving on. Note the two layers of protection in `PUT`: the cheap early
`doc.Version != expected` check, and the **real** guarantee, the concurrency token in the
`UPDATE`'s `WHERE`, which catches the race between `SELECT` and `UPDATE`.

**4. Try it by hand (optional).** Start Postgres and add a connection string to
`Docs.Api/appsettings.json` (`"ConnectionStrings": { "Docs": "Host=localhost;Port=5432;Database=docs;Username=postgres;Password=postgres" }`):

```bash
docker run --rm -d --name docs-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:18
dotnet run --project Docs.Api -- --urls http://localhost:5188
```

In a second terminal:

```bash
P=$(uuidgen)
curl -s -X POST localhost:5188/projects/$P/documents -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: k1' -d '{"title":"Spec","content":"v1"}'
# {"id":"4230…","projectId":"…","title":"Spec","content":"v1","version":1}
ID=<paste the id>
curl -s -i -X PUT localhost:5188/documents/$ID -H 'Content-Type: application/json' \
  -d '{"title":"Spec","content":"Alice","version":1}' | grep -E 'HTTP|ETag'
# HTTP/1.1 200 OK
# ETag: "2"
curl -s -i -X PUT localhost:5188/documents/$ID -H 'Content-Type: application/json' \
  -d '{"title":"Spec","content":"Bob","version":1}'
# HTTP/1.1 409 Conflict … "currentVersion":2,"current":{…"content":"Alice","version":2}
```

**5. The test fixture.** One container per test class. Create `Docs.Tests/ApiFixture.cs`:

```csharp
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Testcontainers.PostgreSql;

namespace Docs.Tests;

// One real PostgreSQL 18 container for the whole test class.
public sealed class ApiFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _db = new PostgreSqlBuilder("postgres:18").Build();

    public WebApplicationFactory<Program> Factory { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        await _db.StartAsync();
        Factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
            b.UseSetting("ConnectionStrings:Docs", _db.GetConnectionString()));
    }

    public async Task DisposeAsync()
    {
        await Factory.DisposeAsync();
        await _db.DisposeAsync();
    }
}
```

**6. Concurrency tests.** Create `Docs.Tests/ConcurrencyTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Docs.Tests;

public class ConcurrencyTests(ApiFixture fx) : IClassFixture<ApiFixture>
{
    private readonly HttpClient _client = fx.Factory.CreateClient();
    private static readonly Guid ProjectId = Guid.NewGuid();

    private record Doc(Guid Id, Guid ProjectId, string Title, string Content, int Version);

    private async Task<Doc> CreateAsync(string title = "Spec")
    {
        var res = await _client.PostAsJsonAsync($"/projects/{ProjectId}/documents", new { title, content = "v1" });
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<Doc>())!;
    }

    private Task<HttpResponseMessage> PutAsync(Guid id, object body, string? ifMatch = null)
    {
        var req = new HttpRequestMessage(HttpMethod.Put, $"/documents/{id}") { Content = JsonContent.Create(body) };
        if (ifMatch is not null) req.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        return _client.SendAsync(req);
    }

    [Fact]
    public async Task Update_with_current_version_bumps_version_and_etag()
    {
        var doc = await CreateAsync();

        var res = await PutAsync(doc.Id, new { title = "Spec", content = "v2", version = 1 });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var updated = await res.Content.ReadFromJsonAsync<Doc>();
        Assert.Equal(2, updated!.Version);
        Assert.Equal("\"2\"", res.Headers.ETag?.ToString());
    }

    [Fact]
    public async Task Update_with_stale_version_returns_409_with_current_version()
    {
        var doc = await CreateAsync();
        await PutAsync(doc.Id, new { title = "Spec", content = "Alice", version = 1 });

        var res = await PutAsync(doc.Id, new { title = "Spec", content = "Bob", version = 1 });

        Assert.Equal(HttpStatusCode.Conflict, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        using var problem = JsonDocument.Parse(await res.Content.ReadAsStringAsync());
        Assert.Equal(2, problem.RootElement.GetProperty("currentVersion").GetInt32());
        Assert.Equal("Alice", problem.RootElement.GetProperty("current").GetProperty("content").GetString());
    }

    [Fact]
    public async Task Stale_If_Match_returns_412_and_current_If_Match_succeeds()
    {
        var doc = await CreateAsync();
        await PutAsync(doc.Id, new { title = "Spec", content = "Alice" }, ifMatch: "\"1\"");

        var stale = await PutAsync(doc.Id, new { title = "Spec", content = "Bob" }, ifMatch: "\"1\"");
        var fresh = await PutAsync(doc.Id, new { title = "Spec", content = "Bob" }, ifMatch: "\"2\"");

        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
        Assert.Equal(HttpStatusCode.OK, fresh.StatusCode);
        Assert.Equal("\"3\"", fresh.Headers.ETag?.ToString());
    }

    [Fact]
    public async Task Weak_etag_never_satisfies_If_Match()
    {
        var doc = await CreateAsync();

        var res = await PutAsync(doc.Id, new { title = "Spec", content = "x" }, ifMatch: "W/\"1\"");

        Assert.Equal(HttpStatusCode.PreconditionFailed, res.StatusCode);
    }

    [Fact]
    public async Task Update_without_any_precondition_returns_428()
    {
        var doc = await CreateAsync();

        var res = await PutAsync(doc.Id, new { title = "Spec", content = "x" });

        Assert.Equal(HttpStatusCode.PreconditionRequired, res.StatusCode);
    }

    [Fact]
    public async Task Get_with_matching_If_None_Match_returns_304()
    {
        var doc = await CreateAsync();
        var req = new HttpRequestMessage(HttpMethod.Get, $"/documents/{doc.Id}");
        req.Headers.TryAddWithoutValidation("If-None-Match", "\"1\"");

        var res = await _client.SendAsync(req);

        Assert.Equal(HttpStatusCode.NotModified, res.StatusCode);
    }

    [Fact]
    public async Task Ten_parallel_saves_of_the_same_version_produce_exactly_one_winner()
    {
        var doc = await CreateAsync();

        var results = await Task.WhenAll(Enumerable.Range(0, 10).Select(i =>
            PutAsync(doc.Id, new { title = "Spec", content = $"writer {i}", version = 1 })));

        Assert.Single(results, r => r.StatusCode == HttpStatusCode.OK);
        Assert.Equal(9, results.Count(r => r.StatusCode == HttpStatusCode.Conflict));
        var final = await _client.GetFromJsonAsync<Doc>($"/documents/{doc.Id}");
        Assert.Equal(2, final!.Version);
    }
}
```

**7. Idempotency tests.** Create `Docs.Tests/IdempotencyTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Json;
using Docs.Api;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Docs.Tests;

public class IdempotencyTests(ApiFixture fx) : IClassFixture<ApiFixture>
{
    private readonly HttpClient _client = fx.Factory.CreateClient();
    private static readonly Guid ProjectId = Guid.NewGuid();

    private record Doc(Guid Id, int Version);

    private Task<HttpResponseMessage> PostAsync(string key, string title)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, $"/projects/{ProjectId}/documents")
        {
            Content = JsonContent.Create(new { title, content = "hello" }),
        };
        req.Headers.Add("Idempotency-Key", key);
        return _client.SendAsync(req);
    }

    [Fact]
    public async Task Retrying_with_the_same_key_replays_the_first_response()
    {
        var key = Guid.NewGuid().ToString();

        var first = await PostAsync(key, "Notes");
        var retry = await PostAsync(key, "Notes");

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, retry.StatusCode);
        Assert.True(retry.Headers.Contains("Idempotent-Replayed"));
        var a = await first.Content.ReadFromJsonAsync<Doc>();
        var b = await retry.Content.ReadFromJsonAsync<Doc>();
        Assert.Equal(a!.Id, b!.Id);                       // same document, not a duplicate
        Assert.Equal(first.Headers.Location, retry.Headers.Location);
    }

    [Fact]
    public async Task Same_key_with_a_different_body_is_rejected_with_422()
    {
        var key = Guid.NewGuid().ToString();
        await PostAsync(key, "Notes");

        var res = await PostAsync(key, "Something else");

        Assert.Equal(HttpStatusCode.UnprocessableEntity, res.StatusCode);
    }

    [Fact]
    public async Task Concurrent_duplicates_create_only_one_document()
    {
        var key = Guid.NewGuid().ToString();

        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => PostAsync(key, "Race")));

        Assert.All(results, r => Assert.Equal(HttpStatusCode.Created, r.StatusCode));
        var ids = await Task.WhenAll(results.Select(async r => (await r.Content.ReadFromJsonAsync<Doc>())!.Id));
        Assert.Single(ids.Distinct());

        // Same responses aren't enough: check the TABLE, so no orphaned duplicates were committed.
        using var scope = fx.Factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        Assert.Equal(1, await db.Documents.CountAsync(d => d.ProjectId == ProjectId && d.Title == "Race"));
    }
}
```

**8. Run them**

```bash
dotnet test
```

Expected (the first run pulls `postgres:18`, so give it a minute):

```text
Passed!  - Failed:     0, Passed:    10, Skipped:     0, Total:    10, Duration: 1 s - Docs.Tests.dll (net10.0)
```

:::tip title="Podman instead of Docker?"
Testcontainers talks to the Docker API. With rootless Podman, start the API socket
(`systemctl --user start podman.socket`), then
`export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock` and
`export TESTCONTAINERS_RYUK_DISABLED=true` before `dotnet test`.
:::

**9. Break it on purpose.** Each of these should turn tests red. Undo each one afterwards.

- Delete the line `db.Entry(doc).Property(d => d.Version).OriginalValue = expected;` **and** the
  early check. Which tests fail, and why does the parallel test still sometimes pass?
  *(Answer: the sequential stale-save tests return `200`, because the `WHERE` now uses the version
  loaded a millisecond ago. In the parallel test, requests that all loaded `version = 1` before the
  first commit still collide in the `WHERE`, so it only fails when a request happens to load after
  that commit.)*
- Remove `.IsConcurrencyToken()` from `Data.cs`. The parallel test should now report several
  `200`s: lost updates.
- Move `db.IdempotencyRecords.Add(...)` into a second `SaveChangesAsync` after the first one, then
  run `dotnet test --filter Concurrent_duplicates` a few times. Every response still carries the
  winner's id (the losers hit the unique key on the *second* save and replay), but the final
  assertion fails: the losers' documents were already committed by the first save. That's the
  "two writes, not one transaction" bug from the quiz, caught only because the test checks the
  table and not just the responses.

- [ ] `dotnet test` shows 10 passing tests against a real `postgres:18` container
- [ ] A stale body version returns `409` with `currentVersion` and the current document in ProblemDetails
- [ ] A stale or weak `If-Match` returns `412`, and a missing precondition returns `428`
- [ ] Ten parallel saves of the same version produce exactly one `200` and nine `409`s
- [ ] A retried `POST` with the same `Idempotency-Key` returns the same document id with `Idempotent-Replayed: true`, and a different body gets `422`
- [ ] I broke the concurrency token on purpose and watched the parallel test catch the lost update
:::

## Flashcards

:::cards id=be-18-cards1 xp=20 title="Concurrency & idempotency"
Q: What is a lost update?
A: Two clients read the same version and both write. The later write silently overwrites the earlier one, and both get 200.
Q: How does an EF Core concurrency token work?
A: The token's ORIGINAL value is added to the UPDATE/DELETE WHERE clause. If 0 rows are affected, EF throws DbUpdateConcurrencyException.
Q: In a web API, how do you make EF check the client's version?
A: Set `db.Entry(entity).Property(e => e.Version).OriginalValue = request.Version` before SaveChanges (and increment Version).
Q: Explicit int version vs Postgres xmin?
A: int: client-visible, meaningful, needs manual increment. xmin: automatic (map a `uint` with [Timestamp]/IsRowVersion), but changes on any update and isn't a meaningful version.
Q: Do ExecuteUpdate/ExecuteDelete check concurrency tokens?
A: No. Put `&& e.Version == expected` in the Where yourself and check the affected-row count.
Q: 409 vs 412 vs 428?
A: 409 means the body's version is stale. 412 means an If-Match precondition was false. 428 means the server requires a precondition and none was sent.
Q: Can a weak ETag satisfy If-Match?
A: No. If-Match uses strong comparison, so W/"3" never matches.
Q: What must an idempotency record be stored with?
A: The effect itself, in the same transaction. Otherwise a crash between the two writes causes duplicates or phantoms.
Q: Same Idempotency-Key, different body?
A: Reject with 422. It's a client bug, and replaying would return the wrong response.
Q: When is pessimistic locking the right tool?
A: For short, server-side, high-contention critical sections (quotas, counters, money). Never across HTTP requests or user think time.
Q: What's the simplest race-free quota reservation?
A: A conditional atomic update: `UPDATE accounts SET count = count + 1 WHERE id = @id AND count < max`, with 0 rows meaning "exceeded".
Q: Which SQLSTATEs should a retrying transaction handle in Postgres?
A: 40001 (serialization_failure) and 40P01 (deadlock_detected).
:::

## Recap

- Lost updates come from read-modify-write across user think time. Transactions alone don't
  prevent them.
- Optimistic concurrency puts the version in the `UPDATE`'s `WHERE`. In EF Core use
  `IsConcurrencyToken()` plus **`OriginalValue` = client version**, and always increment.
- An explicit `int Version` suits client-facing documents. `xmin` (a `uint` with `[Timestamp]` in
  Npgsql) is a zero-maintenance internal token.
- Answer a stale body version with `409` and the current version in ProblemDetails, a stale
  `If-Match` with `412`, and a missing precondition with `428`. ETags must be strong to be used
  for writes.
- Idempotency keys make `POST` retry-safe. Store the record in the same transaction as the
  effect, scope keys per user, reject a reused key with a different body (`422`), and expire old
  records.
- Use pessimistic locking (`FOR UPDATE`, conditional atomic updates, advisory locks) only for
  short server-side sections such as quotas. Lock in a consistent order and retry `40001`/`40P01`.
