---
id: be-11
title: EF Core Querying Like a Pro
level: advanced
minutes: 75
xp: 150
summary: Tracking vs no-tracking, projections, N+1, split queries, safe raw SQL, ExecuteUpdate/Delete, compiled queries, SQL logging, transactions — and modeling real domains with query filters, audit interceptors, value objects, enum mapping and many-to-many.
---

In the last lesson you got EF Core talking to PostgreSQL and ran your first migration. That was the
easy part. Most EF Core performance problems in real code are not caused by EF being slow. They
happen because the code asks for the wrong data, or the right data in the wrong shape, or asks one
row at a time. This lesson is about knowing **what SQL your LINQ turns into** and picking the query
shape on purpose.

We keep using the running domain of this track, a *Projects API*:

```csharp
public enum ProjectRole { Viewer, Editor, Owner }

public class Project
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string OwnerId { get; set; } = "";
    public int Version { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public List<Document> Documents { get; set; } = [];
    public List<ProjectMember> Members { get; set; } = [];
}

public class ProjectMember                       // composite key (ProjectId, UserId)
{
    public Guid ProjectId { get; set; }
    public string UserId { get; set; } = "";
    public ProjectRole Role { get; set; }
}

public class Document
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public string Title { get; set; } = "";
    public string Content { get; set; } = "";   // can be large!
    public int Version { get; set; }
}
```

A project has many documents and many members. Keep the big `Content` column in mind: most of this
lesson is about *not* dragging it around when you don't need it.

## The one rule: see the SQL

You can't tune a query when you can't see the SQL it runs. There are three ways to look, and you'll
use all three.

```csharp
// 1. Log every command (dev only). Goes to the console with parameter values.
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(builder.Configuration.GetConnectionString("Default"))
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()     // shows parameter VALUES: never in production
    .EnableDetailedErrors());

// 2. Ask a single query for its SQL without running it.
var sql = db.Projects.Where(p => p.Name == name).ToQueryString();

// 3. In a real app: use the logging category in appsettings.Development.json
//    "Microsoft.EntityFrameworkCore.Database.Command": "Information"
```

`ToQueryString()` for that last query on Npgsql prints:

```sql
-- @name='x'
SELECT p."Id", p."CreatedAt", p."Name", p."OwnerId", p."Version"
FROM "Projects" AS p
WHERE p."Name" = @name
```

Note the **parameter** `@name`. EF Core sends captured C# variables as parameters, never as text
pasted into the SQL. That keeps it safe from injection, and because the SQL text is identical for every
`name`, EF's own query cache can reuse the translated SQL (and if you turn on Npgsql's `Max Auto Prepare=N`
connection-string option, PostgreSQL can also reuse a prepared plan). (EF Core 10 names
parameters after your variable — `@name` — where older versions printed `@__name_0`.)

:::tip title="Quoted identifiers"
Without a naming convention, EF Core uses your C# names as-is, so PostgreSQL needs double quotes:
`"Projects"`, `"OwnerId"`. Many teams add the `EFCore.NamingConventions` package and call
`.UseSnakeCaseNamingConvention()` so tables become `projects` / `owner_id`, which is much nicer in
psql. Pick one convention on day one, because renaming everything later means a big migration.
:::

## Tracking vs. no-tracking

By default, every entity a query returns is **tracked**. The `DbContext` change tracker keeps a
snapshot of the original values. On `SaveChanges()` it compares the snapshot with the current
values and writes `UPDATE`s for whatever changed. Tracking also gives you **identity resolution**:
if the same row comes back twice in one context, you get the *same object instance* both times.

That costs memory and CPU: a snapshot for every entity, plus a lookup per row. For a request that
only *reads* (a GET endpoint), the cost buys you nothing.

```csharp
// Read-only: skip the change tracker entirely
var docs = await db.Documents
    .AsNoTracking()
    .Where(d => d.ProjectId == projectId)
    .ToListAsync();

// Read-only but the graph contains the same entity many times? Keep identity resolution
// without the snapshot cost:
var withOwners = await db.Documents
    .AsNoTrackingWithIdentityResolution()
    .Include(d => d.Project)
    .ToListAsync();

// Read-heavy context? Flip the default and opt IN to tracking where you write:
o.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking);
var doc = await db.Documents.AsTracking().SingleAsync(d => d.Id == id);
```

| | Tracked (default) | `AsNoTracking()` |
|---|---|---|
| `SaveChanges` sees edits | yes | **no**: edits are silently ignored |
| Same row → same instance | yes | no (use `…WithIdentityResolution`) |
| Memory / CPU | snapshot per entity | minimal |
| Typical use | load → modify → save | GET endpoints, reports, exports |

:::quiz id=be-11-q1 xp=10
What happens?

```csharp
var doc = await db.Documents.AsNoTracking().SingleAsync(d => d.Id == id);
doc.Title = "Renamed";
var n = await db.SaveChangesAsync();
Console.WriteLine(n);
```

- [ ] Prints `1` and the title is updated
- [x] Prints `0` and nothing is written
- [ ] Throws `InvalidOperationException` because the entity is not tracked
- [ ] Prints `1` but only after calling `db.Update(doc)` implicitly
> The change tracker never saw this instance, so `SaveChanges` has nothing to do and returns 0 rows affected. There's no exception, which is why this bug survives code review. You could call `db.Update(doc)` to attach it, but that marks *every* column as modified.
:::

## Projection beats Include (most of the time)

`Include` loads **whole related entities**. Projection with `Select` loads **exactly the columns
you need**, straight into a DTO. A DTO is never tracked, so you don't need `AsNoTracking()` at all.

```csharp
// Include: every column of every document, including 10 KB Content each, tracked
var projects = await db.Projects.Include(p => p.Documents).ToListAsync();
var dto = projects.Select(p => new ProjectSummary(p.Id, p.Name, p.Documents.Count));

// Projection: one row per project, three columns, COUNT done by PostgreSQL
var summaries = await db.Projects
    .OrderBy(p => p.Name)
    .Select(p => new ProjectSummary(p.Id, p.Name, p.Documents.Count))
    .ToListAsync();
```

The projection becomes a single SQL statement with a correlated subquery:

```sql
SELECT p."Id", p."Name", (
    SELECT count(*)::int
    FROM "Documents" AS d
    WHERE p."Id" = d."ProjectId")
FROM "Projects" AS p
ORDER BY p."Name"
```

Projections can go deep. Nested collections, conditional fields and aggregates all translate:

```csharp
var detail = await db.Projects
    .Where(p => p.Id == id)
    .Select(p => new ProjectDetailDto(
        p.Id,
        p.Name,
        p.Members.Count(m => m.Role == ProjectRole.Editor),
        p.Documents
            .OrderByDescending(d => d.Version)
            .Take(5)
            .Select(d => new DocumentListItem(d.Id, d.Title, d.Version))
            .ToList()))
    .SingleOrDefaultAsync();
```

**When is `Include` right?** When you're about to *modify* the aggregate: load the project and its
members tracked, change them, then call `SaveChanges`. Rule of thumb: **reads project, writes include.**

:::pro title="Project to DTOs at the query, not in the controller"
Seniors push the `Select(...)` into the query that feeds the endpoint. They don't return entities
and map them afterwards. Mapping after `ToListAsync()` means the database already sent every
column, and any navigation you touch afterwards is either empty or (with lazy loading) a new query.
AutoMapper's `ProjectTo<T>()` and Mapperly exist to generate these projections. A hand-written
`Select` is just as fine and easier to debug.
:::

## The N+1 problem

N+1 means one query to get a list, plus **one more query per item**. With 3 rows nobody notices.
With 500 rows on a page you get 501 round trips, and every round trip has network latency.

```csharp
// ❌ N+1: 1 query for projects + 1 COUNT per project
var projects = await db.Projects.ToListAsync();
foreach (var p in projects)
{
    var count = await db.Documents.CountAsync(d => d.ProjectId == p.Id);
    Console.WriteLine($"{p.Name}: {count}");
}
```

N+1 shows up in three disguises:

1. **An explicit query inside a loop**, as above.
2. **Lazy loading.** With `UseLazyLoadingProxies()`, touching `p.Documents` silently runs a query.
   The code *looks* like plain property access. That's why many teams don't enable lazy loading.
3. **A per-item service call**, such as `foreach (id in ids) await repo.GetAsync(id)`. The fix
   is to fetch them all at once: `Where(x => ids.Contains(x.Id))`. That's **one** query with the ids
   sent as parameters. Npgsql can send the whole list as a single PostgreSQL array
   (`WHERE p."Id" = ANY (@ids)`); EF Core 10 also offers one-parameter-per-value (`IN (@ids1, @ids2, …)`)
   and lets you choose with `UseParameterizedCollectionMode(...)`. Run `ToQueryString()` to see
   which form your provider version emits. Either way: one round trip instead of N.

:::quiz id=be-11-q2 xp=15
Lazy loading is **not** enabled. What does this print for a project that has 4 documents in the
database (fresh `DbContext`, nothing loaded before)?

```csharp
var project = await db.Projects.SingleAsync(p => p.Name == "Project 2");
Console.WriteLine(project.Documents.Count);
```

- [ ] `4`, because EF Core loads navigations on first access
- [x] `0`, because the navigation was never loaded
- [ ] It throws `NullReferenceException`
- [ ] It runs a second query and prints `4`
> Without `Include`, a projection or lazy-loading proxies, the collection just stays as initialised (`[]`). That's a quiet data bug: the API happily returns "0 documents". EF only fills a navigation on its own when the related entities happen to be tracked by the same context already ("relationship fix-up").
:::

## Cartesian explosion and split queries

A single query with **two collection `Include`s** gets expensive fast:

```csharp
var projects = await db.Projects
    .Include(p => p.Documents)   // 50 per project
    .Include(p => p.Members)     // 20 per project
    .ToListAsync();
```

```sql
SELECT p.*, d.*, p0.*
FROM "Projects" AS p
LEFT JOIN "Documents" AS d ON p."Id" = d."ProjectId"
LEFT JOIN "ProjectMembers" AS p0 ON p."Id" = p0."ProjectId"
ORDER BY p."Id", d."Id", p0."ProjectId", p0."UserId"
```

(EF orders by every key so it can tell, while reading the rows, where one project ends and the next
begins.)

Two sibling JOINs multiply: 50 × 20 = **1,000 rows per project**, and every row repeats the
project's columns and the document's `Content`. That's the *cartesian explosion*. EF Core logs a
warning when it sees this. You have three fixes:

```csharp
// a) Split into one query per collection (3 round trips, no duplication)
var projects = await db.Projects
    .Include(p => p.Documents)
    .Include(p => p.Members)
    .AsSplitQuery()
    .ToListAsync();

// b) Make it the default for this context, and opt back in with .AsSingleQuery()
o.UseNpgsql(cs, npgsql => npgsql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery));

// c) Usually the best: project only what the screen needs
```

Split queries have a catch: each query is a separate statement, so if someone writes between them
the data can be inconsistent (unless you wrap them in a serializable/snapshot transaction). With
`Skip`/`Take`, order by something **unique** (e.g. `.OrderBy(p => p.Name).ThenBy(p => p.Id)`), or
the split queries may not agree on which rows are on the page.

:::quiz id=be-11-q3 xp=15
A report endpoint loads 200 projects with `.Include(p => p.Documents).Include(p => p.Members)`. It
takes 9 seconds and the logs show the "multiple collection navigations" warning. Which changes
address the **root cause**? (Select all that apply.)

- [x] Add `.AsSplitQuery()`
- [x] Replace the Includes with a `Select` into a DTO that only has the columns the report shows
- [ ] Add `.AsNoTracking()`
- [ ] Increase the Npgsql `Command Timeout`
> Two sibling collection joins multiply rows (cartesian explosion). Splitting removes the multiplication, and projecting removes the multiplication *and* the unused columns. `AsNoTracking` saves change-tracking cost but still pulls the exploded result set over the wire, and a bigger timeout only hides the problem.
:::

## IQueryable vs IEnumerable: where the query stops

LINQ operators on `IQueryable<T>` become SQL. As soon as the static type turns into
`IEnumerable<T>`, everything that follows runs **in your process**, on whatever the database already
sent.

```csharp
IQueryable<Document> q = db.Documents;
var a = await q.Where(d => d.Title.StartsWith("A")).ToListAsync();
// → WHERE d."Title" LIKE 'A%'

IEnumerable<Document> e = db.Documents;          // ⚠ implicit conversion
var b = e.Where(d => d.Title.StartsWith("A")).ToList();
// → SELECT * FROM "Documents"   (the WHOLE table), then filters in memory
```

The same trap is hiding in repository methods that return `IEnumerable<T>` or `List<T>` and get
filtered by the caller, and in `.AsEnumerable()` / `.ToList()` placed too early. EF Core *throws*
if it can't translate something in a `Where` or `OrderBy`. That's the good case, because you find
out right away. In the **final** `Select`, though, an untranslatable method call (say, your own
`FormatTitle(d.Title)`) is quietly evaluated on the client. That's fine there, because the rows
are already filtered.

:::quiz id=be-11-q4 xp=15
Spot the performance bug.

```csharp
public async Task<List<DocumentListItem>> RecentAsync(Guid projectId)
{
    var docs = await db.Documents.Where(d => d.ProjectId == projectId).ToListAsync();
    return docs
        .OrderByDescending(d => d.Version)
        .Take(10)
        .Select(d => new DocumentListItem(d.Id, d.Title, d.Version))
        .ToList();
}
```

- [ ] `ToListAsync` should be `ToArrayAsync`
- [x] Ordering, `Take(10)` and the projection run in memory after loading *every* document (with `Content`) of the project
- [ ] `Select` into a record can't be translated, so this throws
- [ ] Nothing, because EF Core moves the `Take` into SQL automatically
> Everything after `ToListAsync()` is LINQ-to-Objects: EF has already run its query and can't "see" the `Take` that comes later, and a record projection *would* translate fine if it were before `ToListAsync()`. Move `OrderByDescending`, `Take` and `Select` before `ToListAsync()` and PostgreSQL returns 10 rows × 3 columns.
:::

## Raw SQL, safely

LINQ covers most queries, but sometimes you want a CTE, a window function, full-text search or a
Postgres-specific operator. EF Core gives you raw SQL that still maps to entities or DTOs:

```csharp
// FromSql: interpolated string → every {hole} becomes a DbParameter (safe)
var pattern = $"%{term}%";
var docs = await db.Documents
    .FromSql($"SELECT * FROM \"Documents\" WHERE \"Title\" ILIKE {pattern}")
    .Where(d => d.ProjectId == projectId)     // you can keep composing LINQ on top
    .OrderBy(d => d.Title)
    .ToListAsync();

// SqlQuery<T>: map to any type, not just entities (EF Core 8+). Column names must match.
var stats = await db.Database
    .SqlQuery<ProjectStat>($"""
        SELECT "ProjectId", count(*)::int AS "Count"
        FROM "Documents" GROUP BY "ProjectId"
        """)
    .ToListAsync();

// ExecuteSql: statements without results
await db.Database.ExecuteSqlAsync($"REFRESH MATERIALIZED VIEW CONCURRENTLY project_stats");
```

The danger is **`FromSqlRaw` / `ExecuteSqlRaw` with concatenation or interpolation**, because the
string is built *before* EF sees it:

```csharp
// ❌ SQL injection: term = "' OR '1'='1" returns every document
db.Documents.FromSqlRaw("SELECT * FROM \"Documents\" WHERE \"Title\" ILIKE '%" + term + "%'");
db.Documents.FromSqlRaw($"SELECT * FROM \"Documents\" WHERE \"Title\" = '{term}'");

// ✅ Raw is fine with positional parameters (e.g. when the SQL text itself is dynamic)
db.Documents.FromSqlRaw("SELECT * FROM \"Documents\" WHERE \"Title\" = {0}", term);
```

The EF Core analyzer flags the first case at build time with warning **EF1003**. Treat it as an
error. Parameters only work for *values*. Table or column names can't be parameters, so if those
are dynamic, pick them from an allow-list in code. Never pass user input through.

:::quiz id=be-11-q5 xp=20
Which calls are safe from SQL injection when `name` comes from the query string? (Select all that apply.)

- [x] `db.Projects.FromSql($"SELECT * FROM \"Projects\" WHERE \"Name\" = {name}")`
- [x] `db.Projects.FromSqlRaw("SELECT * FROM \"Projects\" WHERE \"Name\" = {0}", name)`
- [ ] `db.Projects.FromSqlRaw($"SELECT * FROM \"Projects\" WHERE \"Name\" = '{name}'")`
- [x] `db.Projects.Where(p => p.Name == name)`
- [ ] `db.Database.ExecuteSqlRaw("DELETE FROM \"Projects\" WHERE \"Name\" = '" + name + "'")`
> `FromSql` takes a `FormattableString`, so EF turns each hole into a parameter. `FromSqlRaw` with `{0}` placeholders plus arguments also parameterizes. With `$"..."` passed to the *Raw* overload, C# builds the final string first, so the value is pasted into the SQL.
:::

## Bulk updates and deletes: ExecuteUpdate / ExecuteDelete

The classic "load, modify, `SaveChanges`" costs one `SELECT` plus `UPDATE`s, and puts every row in
memory first. For set-based changes, EF Core 7+ translates straight to a single statement:

```csharp
// UPDATE "Documents" SET "Version" = "Version" + 1 WHERE "ProjectId" = @id
int affected = await db.Documents
    .Where(d => d.ProjectId == projectId)
    .ExecuteUpdateAsync(s => s
        .SetProperty(d => d.Version, d => d.Version + 1)
        .SetProperty(d => d.Title, d => d.Title + " (archived)"));

// DELETE FROM "Documents" WHERE "Version" = 0
await db.Documents.Where(d => d.Version == 0).ExecuteDeleteAsync();
```

In **EF Core 10** the setter argument no longer has to be an expression tree. That means you can
use ordinary C# control flow to decide *which* properties to set:

```csharp
await db.Projects.Where(p => p.Id == id).ExecuteUpdateAsync(s =>
{
    s.SetProperty(p => p.Version, p => p.Version + 1);
    if (newName is not null)
        s.SetProperty(p => p.Name, newName);
});
```

Know what you give up:

- They run **immediately**, not on `SaveChanges`, and they're **not** part of the `SaveChanges`
  transaction. If you need several of them to be atomic, open a transaction yourself (below).
- They **bypass the change tracker**. Entities already loaded in the context keep their old values.
- They skip `SaveChanges` interceptors and overrides, so audit columns, soft-delete logic and domain
  events in an overridden `SaveChangesAsync` do *not* run.
- Concurrency tokens are not checked for you. Add the version to the `Where` yourself (lesson be-18).

:::quiz id=be-11-q6 xp=15
What is the state afterwards? (`doc` had `Version = 1` in the DB.)

```csharp
var doc = await db.Documents.SingleAsync(d => d.Id == id);           // tracked, Version 1
await db.Documents.Where(d => d.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(d => d.Version, d => d.Version + 1));
doc.Title = "New title";
await db.SaveChangesAsync();
```

- [x] DB: `Version = 2`, `Title = "New title"`. In memory: `doc.Version == 1`
- [ ] DB: `Version = 1`, because `SaveChanges` writes back the tracked `Version`
- [ ] DB: `Version = 2`, and `doc.Version` is refreshed to 2 automatically
- [ ] `SaveChanges` throws `DbUpdateConcurrencyException`
> `SaveChanges` only writes *modified* properties (`Title`), so the bulk update survives. The tracked object is stale, though, and anything that reads `doc.Version` afterwards gets the wrong value. If `Version` were configured as a concurrency token, the `UPDATE ... WHERE "Version" = 1` would match 0 rows and throw. That's exactly the behaviour you'll want in be-18.
:::

## Compiled queries (and when not to bother)

Every LINQ query is an expression tree that EF Core has to translate to SQL. EF caches that
translation, but it still has to *compute a cache key* from the tree on every execution. For a
very hot query (thousands per second), a **compiled query** skips that step:

```csharp
private static readonly Func<AppDbContext, Guid, Task<ProjectSummary?>> GetSummary =
    EF.CompileAsyncQuery((AppDbContext db, Guid id) =>
        db.Projects
            .Where(p => p.Id == id)
            .Select(p => new ProjectSummary(p.Id, p.Name, p.Documents.Count))
            .FirstOrDefault());

var summary = await GetSummary(db, id);
```

The win is a few microseconds per call, which matters on a hot path and nowhere else. Don't compile
queries "just because". Measure first (BenchmarkDotNet, lesson be-20). If startup time is the
problem in a big model, look at **compiled models** (`dotnet ef dbcontext optimize`) instead.

## Transactions

`SaveChanges()` already wraps **all its changes** in one transaction. You only need an explicit
transaction when one unit of work spans *several* round trips: several `SaveChanges`, or
`ExecuteUpdate`/`ExecuteDelete`/raw SQL calls.

```csharp
await using var tx = await db.Database.BeginTransactionAsync();

await db.Documents.Where(d => d.ProjectId == id).ExecuteDeleteAsync();
await db.ProjectMembers.Where(m => m.ProjectId == id).ExecuteDeleteAsync();
await db.Projects.Where(p => p.Id == id).ExecuteDeleteAsync();

await tx.CommitAsync();   // no commit (exception, early return) → rollback on dispose
```

If you enabled **connection resiliency**, the execution strategy may *retry* a failed operation,
and it can't retry half a transaction you opened by hand. EF Core throws when you try. The fix is to
run the whole unit inside the strategy:

```csharp
// .UseNpgsql(cs, o => o.EnableRetryOnFailure())
var strategy = db.Database.CreateExecutionStrategy();
await strategy.ExecuteAsync(async () =>
{
    await using var tx = await db.Database.BeginTransactionAsync();
    // ... work ...
    await tx.CommitAsync();
});   // on a transient failure, the WHOLE lambda runs again, so keep it idempotent
```

:::quiz id=be-11-q7 xp=15
The DbContext is configured with `EnableRetryOnFailure()`. This code throws an
`InvalidOperationException` as soon as `SaveChangesAsync` runs. Why?

```csharp
await using var tx = await db.Database.BeginTransactionAsync();
db.Projects.Add(project);
await db.SaveChangesAsync();
await tx.CommitAsync();
```

- [ ] Npgsql doesn't support explicit transactions
- [x] The retrying execution strategy doesn't support user-initiated transactions; wrap the block in `CreateExecutionStrategy().ExecuteAsync(...)`
- [ ] You must call `db.Database.OpenConnectionAsync()` first
- [ ] `SaveChangesAsync` can't run inside a transaction
> A retrying strategy has to be able to replay the *entire* unit of work. `SaveChangesAsync` runs through the strategy, sees a transaction it didn't start (and therefore can't replay), and refuses with "The configured execution strategy … does not support user-initiated transactions". Npgsql supports explicit transactions fine, and `SaveChanges` inside a transaction is normal — the problem is only the combination with retries.
:::

:::job title="What reviewers look for in EF Core code"
On a real team, expect PR comments like: "this is N+1", "project to a DTO", "add `AsNoTracking`
on this GET", "don't return `IEnumerable` from the repository", "missing `CancellationToken`" (pass
`ct` to every `…Async` call), and "this `ExecuteUpdate` skips our audit interceptor". Keep the SQL
log on while you develop. Most of these problems are obvious once you *see* the SQL.
:::

## Modeling real domains: filters, interceptors and value objects

The queries so far assumed a simple schema. Real products add rules that apply to **every** query and
every save: "deleted rows are hidden", "a tenant only ever sees its own data", "every row records who
changed it and when". Writing those rules by hand in each query means someone will eventually forget
one, and in multi-tenant code a forgotten `WHERE` is a data leak. EF Core lets you put them into the
model once. To show them, the Projects domain grows into a SaaS product: every row belongs to a
**tenant** (a customer company), documents are **soft-deleted**, and projects get a budget and a status.

### Global query filters: soft delete and multi-tenancy

A **query filter** is a `WHERE` condition that EF Core adds to every query on an entity type, including
`Include`s and projections that reach it. EF Core 10 lets you **name** filters, so you can switch off one
without losing the others:

```csharp
public class AppDbContext(DbContextOptions<AppDbContext> options, ICurrentTenant tenant) : DbContext(options)
{
    public const string SoftDelete = "SoftDelete";
    public const string Tenant = "Tenant";

    // A property on the context: EF re-reads it for every query, so each request's
    // DbContext (scoped) filters by that request's tenant.
    private Guid TenantId => tenant.TenantId;

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Document>(e =>
        {
            e.HasQueryFilter(SoftDelete, d => d.DeletedAt == null);
            e.HasQueryFilter(Tenant, d => d.TenantId == TenantId);
            // Soft-deleted rows still exist, so a plain unique index would block re-using a title.
            e.HasIndex(d => new { d.ProjectId, d.Title }).IsUnique().HasFilter("\"DeletedAt\" IS NULL");
        });
        b.Entity<Project>().HasQueryFilter(Tenant, p => p.TenantId == TenantId);
    }
}
```

`db.Documents.Where(d => d.Title != "")` now produces:

```sql
SELECT d."Id", d."DeletedAt", d."ProjectId", d."TenantId", d."Title"
FROM "Documents" AS d
WHERE d."DeletedAt" IS NULL AND d."TenantId" = @ef_filter__TenantId AND d."Title" <> ''
```

The admin "trash" view turns off **only** the soft-delete filter, so tenant isolation stays on:
`db.Documents.IgnoreQueryFilters([AppDbContext.SoftDelete])`. A bare `IgnoreQueryFilters()` turns off
**all** of them, which in multi-tenant code should make a reviewer stop and ask why.

:::warn title="Query filters are a safety net, not a security boundary"
- Raw SQL (`FromSql`, `SqlQuery`, `ExecuteSql`) and other tools that touch the database (reporting,
  psql, a second service) don't see EF's filters. For hard tenant isolation, teams add PostgreSQL
  **row-level security** underneath (lesson **Production PostgreSQL** in the Database track).
- The tenant must come from something trusted (a claim in the validated token, be-13), never from a
  header or query string the client controls.
- A filter on a *required* navigation's target can make whole parent rows vanish from `Include`
  results. EF Core logs a warning when you configure that. Read it.
:::

### Audit fields and soft delete with a `SaveChanges` interceptor

"Set `CreatedAt`/`CreatedBy` on insert and `UpdatedAt`/`UpdatedBy` on update" is the same four lines on
every entity. A **`SaveChangesInterceptor`** runs just before EF writes, sees every tracked change, and
can fill them in centrally. It can also turn a `Remove()` into a soft delete:

```csharp
public sealed class AuditInterceptor(TimeProvider clock, ICurrentUser user) : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData, InterceptionResult<int> result, CancellationToken ct = default)
    {
        if (eventData.Context is { } db)
        {
            var now = clock.GetUtcNow();                       // injected clock: testable (be-14)
            foreach (var entry in db.ChangeTracker.Entries<ISoftDeletable>())
            {
                if (entry.State != EntityState.Deleted) continue;
                entry.State = EntityState.Modified;            // DELETE becomes UPDATE …
                entry.Entity.DeletedAt = now;                  // … SET "DeletedAt" = now
            }
            foreach (var entry in db.ChangeTracker.Entries<IAudited>())   // after the loop above,
            {                                                           // so deletes record who did it
                if (entry.State == EntityState.Added)
                    (entry.Entity.CreatedAt, entry.Entity.CreatedBy) = (now, user.Id);
                else if (entry.State == EntityState.Modified)
                    (entry.Entity.UpdatedAt, entry.Entity.UpdatedBy) = (now, user.Id);
            }
        }
        return base.SavingChangesAsync(eventData, result, ct);
    }
}

// Program.cs: the interceptor has scoped dependencies (the current user), so resolve it per context.
builder.Services.AddScoped<AuditInterceptor>();
builder.Services.AddDbContext<AppDbContext>((sp, o) => o
    .UseNpgsql(builder.Configuration.GetConnectionString("Projects"))
    .AddInterceptors(sp.GetRequiredService<AuditInterceptor>()));
```

`IAudited` and `ISoftDeletable` are small interfaces your entities implement
(`DateTimeOffset? DeletedAt { get; set; }` and so on), so the interceptor never needs to know concrete types.

:::warn title="What interceptors don't see"
They only run inside `SaveChanges`. **`ExecuteUpdate`/`ExecuteDelete` bypass them**, and so do raw SQL
and migrations. A bulk `db.Documents.Where(…).ExecuteDeleteAsync()` is a real, permanent `DELETE`,
and it writes no audit fields. Either set the audit columns in the `ExecuteUpdate` call yourself, or keep
bulk operations out of audited tables. This is the "skips our audit interceptor" review comment from
the box above.
:::

### Value objects: complex types

A budget is an amount **and** a currency. Two loose columns invite bugs (adding EUR to USD). A small
record keeps them together, and EF Core maps it as a **complex type**: no key, no identity, its
properties become columns of the owner's table (be-10 used the same mechanism with `ToJson()` to store it
as `jsonb` instead):

```csharp
public record Money(decimal Amount, string Currency);

b.Entity<Project>().ComplexProperty(p => p.Budget, money =>
{
    money.Property(m => m.Amount).HasColumnName("BudgetAmount").HasPrecision(12, 2);
    money.Property(m => m.Currency).HasColumnName("BudgetCurrency").HasMaxLength(3);
});
// Queries can reach inside: db.Projects.Where(p => p.Budget.Currency == "EUR")
```

You'll meet the older **owned entity types** (`OwnsOne`/`OwnsMany`) in existing codebases. They do a
similar job but have a hidden key and reference semantics. For new value objects, complex types are the
modern choice.

### Enums: store the name, not the number

By default EF Core stores an enum as its integer, with the renumbering trap from be-02. Storing the name
is one line and makes the column readable in psql and reports:

```csharp
b.Entity<Project>().Property(p => p.Status).HasConversion<string>().HasMaxLength(20);
```

Npgsql can also map to a native PostgreSQL `enum` type (`MapEnum<ProjectStatus>()` on the data source
and the `UseNpgsql` options). That is compact and type-safe in SQL, but adding a value then needs a
migration. Strings are the low-friction default.

### Many-to-many: skip navigations vs an explicit join entity

When the link has **no data of its own** (projects ↔ tags), declare the two collections and EF creates
the join table for you:

```csharp
public class Project { public List<Tag> Tags { get; set; } = []; /* … */ }
public class Tag     { public int Id { get; set; } public string Name { get; set; } = "";
                       public List<Project> Projects { get; set; } = []; }

b.Entity<Project>().HasMany(p => p.Tags).WithMany(t => t.Projects);   // join table "ProjectTag"
```

As soon as the link carries data (a role, an "added at", who invited whom), make it a **real entity**
with a composite key. That's exactly why this lesson's `ProjectMember` exists instead of
`Project.Users`: the membership *has* a `Role`. Converting a skip-navigation many-to-many to an explicit
entity later is a migration plus touching every query that used it, so decide early.

:::quiz id=be-11-q9 xp=15
`Document` has a soft-delete query filter (`DeletedAt == null`) and an `AuditInterceptor` that turns
`Remove()` into `DeletedAt = now`. A cleanup endpoint runs:

```csharp
await db.Documents.Where(d => d.ProjectId == id).ExecuteDeleteAsync(ct);
```

What happens to the project's documents?

- [ ] They're soft-deleted: the interceptor sets `DeletedAt` on each one
- [x] The non-deleted ones are permanently deleted with one SQL `DELETE`; already soft-deleted ones are left untouched
- [ ] All of them, including the soft-deleted ones, are permanently deleted
- [ ] EF Core throws because `ExecuteDelete` can't be combined with query filters
> `ExecuteDelete` translates straight to SQL and never goes through `SaveChanges`, so the interceptor doesn't run and the rows are **really** gone. The query filter, though, is part of the query, so the generated `DELETE … WHERE "DeletedAt" IS NULL AND "ProjectId" = @id` skips rows that were already soft-deleted. Both behaviours surprise people, which is why audited, soft-deleted tables should avoid bulk deletes, or use `ExecuteUpdate` to set `DeletedAt` explicitly.
:::

:::quiz id=be-11-q10 xp=10
A projects ↔ users relationship needs to store each user's `Role` (owner/editor/viewer). How should you model it?

- [ ] `List<User> Users` on `Project` and `List<Project> Projects` on `User`, with the role in a separate dictionary
- [x] An explicit `ProjectMember` entity with a composite key `(ProjectId, UserId)` and a `Role` property
- [ ] A `jsonb` column on `Project` holding `{ userId: role }`
- [ ] Skip navigations plus a `Role` property on `User`
> Skip navigations (`HasMany().WithMany()`) are perfect when the link is just a link. Once it carries data, the link **is** an entity: give it a composite key, foreign keys to both sides and its own properties, and query it directly (`db.ProjectMembers.Where(m => m.UserId == me)`). A role on `User` would be one role for all projects, and a `jsonb` map can't have foreign keys or an efficient "which projects can I see?" index.
:::

## Lab: fix six query bugs, proven by tests

:::lab id=be-11-lab1 xp=120
title: Six EF Core query bugs, caught by tests
You get a `ProjectQueries` class that *works* but has a bug in six methods: N+1, overfetching,
unneeded tracking, row-by-row updates, SQL injection and a missing transaction. The tests run
against a **real PostgreSQL 18** started by Testcontainers. A small `DbCommandInterceptor` records
every SQL command, so the tests can assert things like "exactly one query".

**Prerequisites:** .NET 10 SDK and a running Docker (Docker Desktop, or Podman with its socket).
Check with `docker info`.

:::tip title="Podman instead of Docker?"
Start the API socket (`systemctl --user start podman.socket`), then
`export DOCKER_HOST=unix:///run/user/$UID/podman/podman.sock` and
`export TESTCONTAINERS_RYUK_DISABLED=true` before `dotnet test`.
:::

**1. Create the project**

```bash
mkdir -p ~/devquest/be-11-lab1 && cd ~/devquest/be-11-lab1
dotnet new xunit -o EfQuerying.Tests
cd EfQuerying.Tests
dotnet add package Npgsql.EntityFrameworkCore.PostgreSQL --version 10.0.3
dotnet add package Testcontainers.PostgreSql --version 4.16.0
rm UnitTest1.cs
```

**2. `Model.cs`**: the entities and the `DbContext`

```csharp
using Microsoft.EntityFrameworkCore;

namespace EfQuerying;

public enum ProjectRole { Viewer, Editor, Owner }

public class Project
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string OwnerId { get; set; } = "";
    public int Version { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public List<Document> Documents { get; set; } = [];
    public List<ProjectMember> Members { get; set; } = [];
}

public class ProjectMember
{
    public Guid ProjectId { get; set; }
    public string UserId { get; set; } = "";
    public ProjectRole Role { get; set; }
}

public class Document
{
    public Guid Id { get; set; }
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public string Title { get; set; } = "";
    public string Content { get; set; } = "";
    public int Version { get; set; }
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();
    public DbSet<Document> Documents => Set<Document>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<ProjectMember>().HasKey(m => new { m.ProjectId, m.UserId });
        b.Entity<Project>().Property(p => p.Name).HasMaxLength(200);
        b.Entity<Document>().HasIndex(d => d.ProjectId);
    }
}
```

**3. `CommandCounter.cs`**: an interceptor that records each SQL command

```csharp
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace EfQuerying;

/// Records every SQL command EF Core sends, so tests can assert "exactly one round trip".
public class CommandCounter : DbCommandInterceptor
{
    public List<string> Commands { get; } = [];

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        Commands.Add(command.CommandText);
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }

    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Commands.Add(command.CommandText);
        return base.NonQueryExecutingAsync(command, eventData, result, cancellationToken);
    }

    public override ValueTask<InterceptionResult<object>> ScalarExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<object> result,
        CancellationToken cancellationToken = default)
    {
        Commands.Add(command.CommandText);
        return base.ScalarExecutingAsync(command, eventData, result, cancellationToken);
    }

    public void Reset() => Commands.Clear();
}
```

**4. `PostgresFixture.cs`**: one container per test run, one fresh database per test

```csharp
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Testcontainers.PostgreSql;

namespace EfQuerying;

/// One Postgres container for the whole test run; every test gets its own fresh database.
public class PostgresFixture : IAsyncLifetime
{
    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:18").Build();

    public Task InitializeAsync() => _pg.StartAsync();
    public Task DisposeAsync() => _pg.DisposeAsync().AsTask();

    /// Creates a new database, the schema and seed data. Returns a factory for contexts.
    public async Task<Func<CommandCounter, AppDbContext>> CreateDatabaseAsync()
    {
        var cs = new NpgsqlConnectionStringBuilder(_pg.GetConnectionString())
        {
            Database = "t_" + Guid.NewGuid().ToString("N")
        }.ConnectionString;

        AppDbContext Create(CommandCounter counter) => new(
            new DbContextOptionsBuilder<AppDbContext>()
                .UseNpgsql(cs)
                .AddInterceptors(counter)
                .Options);

        await using var db = Create(new CommandCounter());
        await db.Database.EnsureCreatedAsync();
        Seed(db);
        await db.SaveChangesAsync();
        return Create;
    }

    private static void Seed(AppDbContext db)
    {
        for (var p = 1; p <= 3; p++)
        {
            var project = new Project
            {
                Id = Guid.NewGuid(),
                Name = $"Project {p}",
                OwnerId = $"user-{p}",
                CreatedAt = DateTimeOffset.UtcNow.AddDays(-p),
            };
            for (var d = 1; d <= p * 2; d++)
                project.Documents.Add(new Document
                {
                    Id = Guid.NewGuid(),
                    Title = $"P{p} Doc {d}",
                    Content = new string('x', 10_000), // big column we don't want to drag around
                    Version = 1,
                });
            project.Members.Add(new ProjectMember { UserId = $"user-{p}", Role = ProjectRole.Owner });
            db.Projects.Add(project);
        }
    }
}

[CollectionDefinition("pg")]
public class PgCollection : ICollectionFixture<PostgresFixture>;
```

Seed data: Project 1 has 2 documents, Project 2 has 4, Project 3 has 6. Every document has a
10,000-character `Content`.

**5. `ProjectQueries.cs`**: the buggy version you'll fix

```csharp
using Microsoft.EntityFrameworkCore;

namespace EfQuerying;

public record ProjectSummary(Guid Id, string Name, int DocumentCount);
public record DocumentListItem(Guid Id, string Title, int Version);

// ⚠ This version "works" but has a performance or correctness bug in almost every method.
public class ProjectQueries(AppDbContext db)
{
    // Bug 1: N+1 — one query for projects, then one COUNT per project.
    public async Task<List<ProjectSummary>> GetSummariesAsync()
    {
        var projects = await db.Projects.OrderBy(p => p.Name).ToListAsync();
        var result = new List<ProjectSummary>();
        foreach (var p in projects)
        {
            var count = await db.Documents.CountAsync(d => d.ProjectId == p.Id);
            result.Add(new ProjectSummary(p.Id, p.Name, count));
        }
        return result;
    }

    // Bug 2: loads full tracked entities (incl. the 10 KB Content column), maps in memory.
    public async Task<List<DocumentListItem>> ListDocumentsAsync(Guid projectId)
    {
        var docs = await db.Documents.Where(d => d.ProjectId == projectId).ToListAsync();
        return docs.OrderBy(d => d.Title).Select(d => new DocumentListItem(d.Id, d.Title, d.Version)).ToList();
    }

    // Bug 3: read-only export, but every entity is tracked by the change tracker.
    public Task<List<Document>> GetDocumentsForExportAsync(Guid projectId) =>
        db.Documents.Where(d => d.ProjectId == projectId).OrderBy(d => d.Title).ToListAsync();

    // Bug 4: loads every row just to increment a number, then sends UPDATEs.
    public async Task<int> BumpVersionsAsync(Guid projectId)
    {
        var docs = await db.Documents.Where(d => d.ProjectId == projectId).ToListAsync();
        foreach (var d in docs) d.Version++;
        await db.SaveChangesAsync();
        return docs.Count;
    }

    // Bug 5: SQL injection — user input concatenated into SQL.
    public Task<List<string>> SearchTitlesAsync(string term) =>
        db.Documents
            .FromSqlRaw("SELECT * FROM \"Documents\" WHERE \"Title\" ILIKE '%" + term + "%'")
            .Select(d => d.Title)
            .ToListAsync();

    // Bug 6: not atomic — if the second step fails, the documents are already gone.
    public async Task ArchiveProjectAsync(Guid projectId, bool simulateCrash = false)
    {
        await db.Documents.Where(d => d.ProjectId == projectId).ExecuteDeleteAsync();
        if (simulateCrash) throw new InvalidOperationException("boom");
        await db.Projects.Where(p => p.Id == projectId).ExecuteDeleteAsync();
    }

    // Fine as is: a compiled query skips LINQ-to-SQL translation on every call.
    private static readonly Func<AppDbContext, string, Task<Guid>> ProjectIdByName =
        EF.CompileAsyncQuery((AppDbContext ctx, string name) =>
            ctx.Projects.Where(p => p.Name == name).Select(p => p.Id).First());

    public Task<Guid> GetProjectIdByNameAsync(string name) => ProjectIdByName(db, name);
}
```

**6. `ProjectQueriesTests.cs`**: the tests (don't change these)

```csharp
using Microsoft.EntityFrameworkCore;

namespace EfQuerying;

[Collection("pg")]
public class ProjectQueriesTests(PostgresFixture pg) : IAsyncLifetime
{
    private readonly CommandCounter _counter = new();
    private AppDbContext _db = null!;
    private Func<CommandCounter, AppDbContext> _factory = null!;
    private ProjectQueries _queries = null!;

    public async Task InitializeAsync()
    {
        _factory = await pg.CreateDatabaseAsync();
        _db = _factory(_counter);
        _queries = new ProjectQueries(_db);
    }

    public Task DisposeAsync() => _db.DisposeAsync().AsTask();

    private Task<Guid> ProjectId(string name) =>
        _db.Projects.AsNoTracking().Where(p => p.Name == name).Select(p => p.Id).SingleAsync();

    [Fact]
    public async Task Summaries_are_loaded_in_a_single_query()
    {
        var summaries = await _queries.GetSummariesAsync();

        Assert.Equal([2, 4, 6], summaries.Select(s => s.DocumentCount));
        Assert.True(_counter.Commands.Count == 1,
            $"Expected 1 SQL command, got {_counter.Commands.Count}:\n{string.Join("\n---\n", _counter.Commands)}");
    }

    [Fact]
    public async Task Document_list_does_not_select_content_and_tracks_nothing()
    {
        var id = await ProjectId("Project 2");
        _counter.Reset();

        var items = await _queries.ListDocumentsAsync(id);

        Assert.Equal(4, items.Count);
        Assert.Equal("P2 Doc 1", items[0].Title);
        Assert.DoesNotContain("\"Content\"", _counter.Commands.Single());
        Assert.Empty(_db.ChangeTracker.Entries());
    }

    [Fact]
    public async Task Export_returns_untracked_entities()
    {
        var id = await ProjectId("Project 1");

        var docs = await _queries.GetDocumentsForExportAsync(id);

        Assert.Equal(2, docs.Count);
        Assert.Equal(10_000, docs[0].Content.Length);
        Assert.Empty(_db.ChangeTracker.Entries());
    }

    [Fact]
    public async Task Bump_versions_is_one_UPDATE_statement()
    {
        var id = await ProjectId("Project 3");
        _counter.Reset();

        var affected = await _queries.BumpVersionsAsync(id);

        Assert.Equal(6, affected);
        var command = Assert.Single(_counter.Commands);
        Assert.StartsWith("UPDATE", command.TrimStart());
        await using var fresh = _factory(new CommandCounter());
        Assert.All(await fresh.Documents.Where(d => d.ProjectId == id).ToListAsync(),
            d => Assert.Equal(2, d.Version));
    }

    [Fact]
    public async Task Search_finds_matching_titles()
    {
        var titles = await _queries.SearchTitlesAsync("doc 1");
        Assert.Equal(3, titles.Count);
    }

    [Fact]
    public async Task Search_is_not_injectable()
    {
        var titles = await _queries.SearchTitlesAsync("' OR '1'='1");
        Assert.Empty(titles);
    }

    [Fact]
    public async Task Archive_is_all_or_nothing()
    {
        var id = await ProjectId("Project 1");

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => _queries.ArchiveProjectAsync(id, simulateCrash: true));

        await using var fresh = _factory(new CommandCounter());
        Assert.Equal(2, await fresh.Documents.CountAsync(d => d.ProjectId == id));
    }

    [Fact]
    public async Task Archive_removes_project_and_documents()
    {
        var id = await ProjectId("Project 1");

        await _queries.ArchiveProjectAsync(id);

        await using var fresh = _factory(new CommandCounter());
        Assert.False(await fresh.Projects.AnyAsync(p => p.Id == id));
        Assert.False(await fresh.Documents.AnyAsync(d => d.ProjectId == id));
    }

    [Fact]
    public async Task Compiled_query_finds_project()
    {
        var expected = await ProjectId("Project 2");
        Assert.Equal(expected, await _queries.GetProjectIdByNameAsync("Project 2"));
    }
}
```

**7. Run the tests and watch them fail**

```bash
dotnet test
```

The first run pulls the `postgres:18` image, which can take a minute. During the build, notice the
analyzer warning `EF1003: Method 'FromSqlRaw' inserts concatenated strings directly into the SQL`.
Then you should see something like:

```text
Failed Summaries_are_loaded_in_a_single_query
  Expected 1 SQL command, got 4:
  SELECT p."Id", p."CreatedAt", p."Name", p."OwnerId", p."Version" FROM "Projects" AS p ...
  ---
  SELECT count(*)::int FROM "Documents" AS d WHERE d."ProjectId" = @p_Id
  ...
Failed!  - Failed: 6, Passed: 3, Skipped: 0, Total: 9
```

Read each failure message. The N+1 one even prints the four statements.

**8. Fix `ProjectQueries.cs`** one method at a time, rerunning `dotnet test` after each. Hints:

| Test | Fix |
|---|---|
| `Summaries_are_loaded_in_a_single_query` | `Select` into `ProjectSummary` with `p.Documents.Count` |
| `Document_list_does_not_select_content…` | `OrderBy` + `Select` **before** `ToListAsync` |
| `Export_returns_untracked_entities` | `AsNoTracking()` |
| `Bump_versions_is_one_UPDATE_statement` | `ExecuteUpdateAsync` with `SetProperty` |
| `Search_is_not_injectable` | `FromSql` with an interpolated `{pattern}` |
| `Archive_is_all_or_nothing` | `BeginTransactionAsync` … `CommitAsync` |

**9. Reference solution** (try it yourself first!)

```csharp
using Microsoft.EntityFrameworkCore;

namespace EfQuerying;

public record ProjectSummary(Guid Id, string Name, int DocumentCount);
public record DocumentListItem(Guid Id, string Title, int Version);

public class ProjectQueries(AppDbContext db)
{
    // Fix 1: one query — the COUNT becomes a correlated subquery in SQL.
    public Task<List<ProjectSummary>> GetSummariesAsync() =>
        db.Projects
            .OrderBy(p => p.Name)
            .Select(p => new ProjectSummary(p.Id, p.Name, p.Documents.Count))
            .ToListAsync();

    // Fix 2: project in SQL — only 3 columns travel, and projections are never tracked.
    public Task<List<DocumentListItem>> ListDocumentsAsync(Guid projectId) =>
        db.Documents
            .Where(d => d.ProjectId == projectId)
            .OrderBy(d => d.Title)
            .Select(d => new DocumentListItem(d.Id, d.Title, d.Version))
            .ToListAsync();

    // Fix 3: we need whole entities, but we will never save them.
    public Task<List<Document>> GetDocumentsForExportAsync(Guid projectId) =>
        db.Documents
            .AsNoTracking()
            .Where(d => d.ProjectId == projectId)
            .OrderBy(d => d.Title)
            .ToListAsync();

    // Fix 4: a set-based UPDATE executed directly in the database.
    public Task<int> BumpVersionsAsync(Guid projectId) =>
        db.Documents
            .Where(d => d.ProjectId == projectId)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.Version, d => d.Version + 1));

    // Fix 5: FromSql + interpolation = a real DbParameter, never string concatenation.
    public Task<List<string>> SearchTitlesAsync(string term)
    {
        var pattern = $"%{term}%";
        return db.Documents
            .FromSql($"SELECT * FROM \"Documents\" WHERE \"Title\" ILIKE {pattern}")
            .Select(d => d.Title)
            .ToListAsync();
    }

    // Fix 6: both ExecuteDelete calls share one database transaction.
    public async Task ArchiveProjectAsync(Guid projectId, bool simulateCrash = false)
    {
        await using var tx = await db.Database.BeginTransactionAsync();
        await db.Documents.Where(d => d.ProjectId == projectId).ExecuteDeleteAsync();
        if (simulateCrash) throw new InvalidOperationException("boom");
        await db.Projects.Where(p => p.Id == projectId).ExecuteDeleteAsync();
        await tx.CommitAsync();
    }

    private static readonly Func<AppDbContext, string, Task<Guid>> ProjectIdByName =
        EF.CompileAsyncQuery((AppDbContext ctx, string name) =>
            ctx.Projects.Where(p => p.Name == name).Select(p => p.Id).First());

    public Task<Guid> GetProjectIdByNameAsync(string name) => ProjectIdByName(db, name);
}
```

**10. All green**

```text
Passed!  - Failed: 0, Passed: 9, Skipped: 0, Total: 9
```

**Bonus: read the SQL of the fixed version.** xUnit v2 doesn't show `Console.WriteLine` from tests,
so write through its output helper instead. Add `using Xunit.Abstractions;` at the top of
ProjectQueriesTests.cs (xUnit v2; in xUnit v3 the type moved to the `Xunit` namespace) and
`ITestOutputHelper output` to the test class's
primary constructor (`ProjectQueriesTests(PostgresFixture pg, ITestOutputHelper output)`), and at the end
of a test add `output.WriteLine(string.Join("\n---\n", _counter.Commands));`. Then run
`dotnet test --logger "console;verbosity=detailed"` and look under *Standard Output Messages*.

- [ ] The first run shows 6 failing tests and the EF1003 warning
- [ ] `GetSummariesAsync` runs exactly one SQL command
- [ ] The document list query doesn't select `"Content"` and tracks nothing
- [ ] `BumpVersionsAsync` is a single `UPDATE` statement
- [ ] The injection test returns no rows
- [ ] `ArchiveProjectAsync` rolls back on failure
- [ ] `dotnet test` reports 9 passed
:::

:::quiz id=be-11-q8 xp=10
In the lab fixture, why does every test get its **own database** inside one shared container,
instead of its own container?

- [ ] Testcontainers can only start one container per process
- [x] Starting a container takes seconds; creating a database takes milliseconds, and tests still can't see each other's writes
- [ ] PostgreSQL doesn't allow two connections to the same database
- [ ] `EnsureCreated` only works on new databases
> A container per test would make the suite crawl. One database per test is a cheap, strong form of isolation, so `BumpVersionsAsync` in one test can't break counts in another. Lesson be-15 shows the other popular approach: one database, reset with Respawn between tests.
:::

## Flashcards

:::cards id=be-11-cards1 xp=15 title="EF Core querying"
Q: What does `AsNoTracking()` skip?
A: Change-tracker snapshots and identity resolution. It's faster for reads, but edits aren't saved.
Q: When do you use `Include` instead of a projection?
A: When you load an aggregate in order to **modify** it and call `SaveChanges`. For reads, project with `Select`.
Q: What is N+1?
A: One query for a list plus one query per item, from a loop, lazy loading or per-item service calls.
Q: What is cartesian explosion, and how do you fix it?
A: Two sibling collection Includes multiply rows. Use `AsSplitQuery()`, or better, project only what you need.
Q: `FromSql` vs `FromSqlRaw`?
A: `FromSql` takes a FormattableString and parameterizes every hole. `FromSqlRaw` takes a plain string and is only safe with `{0}` placeholders plus arguments.
Q: Three things `ExecuteUpdate` / `ExecuteDelete` do NOT do
A: They don't update tracked entities, don't run SaveChanges interceptors/overrides, and don't join the SaveChanges transaction or check concurrency tokens.
Q: How do you see the SQL for one query?
A: `query.ToQueryString()`, or `LogTo(...)` / the `Microsoft.EntityFrameworkCore.Database.Command` log category for all of them.
Q: Why does `BeginTransaction` throw with `EnableRetryOnFailure`?
A: The strategy must replay the whole unit. Wrap the work in `db.Database.CreateExecutionStrategy().ExecuteAsync(...)`.
Q: What does `ids.Contains(p.Id)` become?
A: One query with the ids as parameters — on Npgsql typically `WHERE p."Id" = ANY (@ids)` (one array parameter); EF 10 can also emit `IN (@ids1, @ids2, …)`. It's the fix for per-id lookups in a loop.
Q: When is a compiled query worth it?
A: On a measured hot path. It saves the per-call expression-tree cache lookup, a few microseconds.
Q: How do you turn off only the soft-delete filter but keep tenant isolation (EF Core 10)?
A: Name the filters (`HasQueryFilter("SoftDelete", …)`) and call `IgnoreQueryFilters(["SoftDelete"])`. A bare `IgnoreQueryFilters()` removes all of them.
Q: What does a `SaveChangesInterceptor` miss?
A: Everything that doesn't go through `SaveChanges`: `ExecuteUpdate`/`ExecuteDelete`, raw SQL, migrations.
Q: Complex type vs owned entity type?
A: Both map value objects into the owner's table (or JSON). Complex types (the modern choice) have no hidden key and value semantics; owned types are the older mechanism you'll see in existing code.
:::

## Recap

- **Always look at the SQL**: `ToQueryString()`, `LogTo`, or the `Database.Command` log category.
- **Reads project, writes include.** `Select` into DTOs; use `AsNoTracking()` when you need read-only entities.
- **N+1** hides in loops, lazy loading and per-item calls. Batch with projections or `Contains`.
- Two collection Includes cause a **cartesian explosion**. Use `AsSplitQuery()` or a projection.
- Raw SQL is fine with **`FromSql` / `SqlQuery` / `ExecuteSql`**. Never concatenate into `…Raw` (EF1003).
- **`ExecuteUpdate`/`ExecuteDelete`** are single statements that bypass the change tracker, interceptors and the SaveChanges transaction.
- `SaveChanges` is already transactional. Open a transaction for multi-step work, and run it through the execution strategy when retries are on.
- **Named query filters** put soft delete and tenant isolation into the model; `IgnoreQueryFilters([name])` turns off one. They're a safety net, not a security boundary.
- A **`SaveChangesInterceptor`** fills audit fields and turns deletes into soft deletes, but only inside `SaveChanges`.
- Value objects map as **complex types**; store enums as **strings**; a many-to-many link with data of its own is an **explicit join entity**.
