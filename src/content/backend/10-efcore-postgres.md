---
id: be-10
title: EF Core 10 with PostgreSQL
level: intermediate
minutes: 55
xp: 160
summary: DbContext and entities, conventions vs Fluent API, relationships, migrations with dotnet-ef, PostgreSQL 18 in Docker, connection strings, change tracking and SaveChanges, and jsonb columns — with a full, tested lab.
---

**Entity Framework Core** is .NET's ORM (object-relational mapper): you write C# classes and LINQ, it
writes SQL, manages connections, tracks changes and evolves the schema with **migrations**. With the
**Npgsql** provider it speaks PostgreSQL natively — identity columns, `jsonb`, arrays, `timestamptz`.
You'll find EF Core in the vast majority of .NET backends; knowing what SQL it generates — and when it
generates something terrible — is what separates juniors from seniors.

## The moving parts

| Piece | What it is |
|---|---|
| `Npgsql.EntityFrameworkCore.PostgreSQL` | The EF Core **provider** for PostgreSQL (pulls in EF Core and the Npgsql driver) |
| `Microsoft.EntityFrameworkCore.Design` | Design-time services used by the migrations tooling (build-time only) |
| `dotnet-ef` | The CLI tool: `dotnet ef migrations add`, `dotnet ef database update` |
| `DbContext` | Your session with the database: queries, change tracking, `SaveChanges` |
| `DbSet<T>` | A queryable table (`IQueryable<T>`) on the context |
| Entities | Plain C# classes mapped to tables |
| Migrations | Generated C# classes that move the schema from one version to the next |

:::info title="EF Core or Dapper?"
**Dapper** is a micro-ORM: you write SQL, it maps rows to objects — fast and transparent. EF Core adds
LINQ, change tracking, relationships and migrations. Many teams use EF Core for most work and drop to
raw SQL (`FromSql`, `SqlQuery<T>`, or Dapper) for hot or complex reporting queries. Both are good;
know both exist.
:::

## PostgreSQL 18 in Docker for development

Never install a database by hand for each project. Run it in a container:

```bash
docker run -d --name blog-db \
  -e POSTGRES_USER=app \
  -e POSTGRES_PASSWORD=app_dev_pw \
  -e POSTGRES_DB=blog \
  -p 5432:5432 \
  -v blog-pgdata:/var/lib/postgresql \
  postgres:18
```

- `-v blog-pgdata:/var/lib/postgresql` — a named volume so data survives `docker rm`. **Postgres 18
  images changed the data path** (`PGDATA` is now `/var/lib/postgresql/18/docker`); mount the parent
  `/var/lib/postgresql`, not the old `/var/lib/postgresql/data` from older tutorials.
- Port in use (a local Postgres)? Map another host port: `-p 5433:5432`, and use `Port=5433`.
- Open a SQL shell: `docker exec -it blog-db psql -U app -d blog`.

Most teams commit a `compose.yaml` so `docker compose up -d` starts everything:

```yaml
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: app_dev_pw
      POSTGRES_DB: blog
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql
volumes:
  pgdata:
```

## Connection strings

Npgsql connection strings are `Key=Value;` pairs:

```text
Host=localhost;Port=5432;Database=blog;Username=app;Password=app_dev_pw
```

Useful extras: `Include Error Detail=true` (dev only: shows parameter values in errors),
`Maximum Pool Size=50`, `SSL Mode=Require` (managed cloud databases), `Timeout=15`.

By convention it lives under `ConnectionStrings` in configuration and is read with
`GetConnectionString("Blog")`:

```json
// appsettings.Development.json — a throw-away local password is acceptable here
{
  "ConnectionStrings": {
    "Blog": "Host=localhost;Port=5432;Database=blog;Username=app;Password=app_dev_pw"
  }
}
```

In every other environment, inject it as an environment variable — `ConnectionStrings__Blog=…` — from
a Kubernetes Secret or vault (be-08). Real passwords never go in `appsettings.json`.

## Entities and the DbContext

```csharp
namespace Blog.Api.Data;

public class Author
{
    public int Id { get; set; }                       // convention: "Id" → primary key, identity column
    public required string Name { get; set; }         // non-nullable string → NOT NULL
    public required string Email { get; set; }
    public List<Post> Posts { get; set; } = [];       // collection navigation (one author → many posts)
}

public class Post
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required string Slug { get; set; }
    public string Body { get; set; } = "";
    public PostStatus Status { get; set; } = PostStatus.Draft;
    public DateTimeOffset CreatedAt { get; set; }     // → timestamp with time zone

    public int AuthorId { get; set; }                 // foreign key (convention: <Navigation>Id)
    public Author Author { get; set; } = null!;       // reference navigation; EF sets it when loaded

    public List<Tag> Tags { get; set; } = [];         // many-to-many: EF creates the join table
}

// Tag (Id, Name, Posts) and enum PostStatus { Draft, Published, Archived } are in the lab below.
```

An **entity** is a class EF maps to a table, where every row has an identity (its primary key). The
**`DbContext`** is the object you talk to: it opens connections, translates LINQ to SQL, and remembers
which entities you loaded so it can save your changes later. You expose each table as a `DbSet<T>`:

```csharp
using Microsoft.EntityFrameworkCore;

public class BlogDbContext(DbContextOptions<BlogDbContext> options) : DbContext(options)
{
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Tag> Tags => Set<Tag>();
}

// Program.cs
builder.Services.AddDbContext<BlogDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Blog")));
```

`AddDbContext` registers the context as **scoped**: one per HTTP request (be-08). It's cheap to create,
not thread-safe, and meant to be short-lived. High-throughput apps can use `AddDbContextPool` to reuse
instances.

:::warn title="One DbContext, one operation at a time"
A `DbContext` is **not thread-safe**. Starting two queries on the same context without awaiting the
first (`Task.WhenAll(db.Posts.ToListAsync(), db.Authors.ToListAsync())`) throws
`InvalidOperationException: A second operation was started on this context instance before a previous
operation completed`. Await each call, or create separate contexts (`IDbContextFactory<T>`) for real
parallel work. Never register a `DbContext` as a singleton.
:::

:::tip title="Why `= null!` on navigations?"
`Author` is always set when loaded with the post (or via `AuthorId` on insert), but the C# compiler
can't know that. `= null!` silences the nullable warning for this one well-understood case — the
EF Core docs recommend it. It's one of the few places a `!` is normal in review.
:::

### Conventions (what EF infers)

| C# | PostgreSQL |
|---|---|
| `int Id` / `long Id` | `integer`/`bigint` `GENERATED BY DEFAULT AS IDENTITY` primary key |
| `string` (non-nullable) | `text NOT NULL` |
| `string?` | `text NULL` |
| `decimal` | `numeric` |
| `bool` | `boolean` |
| `DateTimeOffset` / `DateTime` (UTC) | `timestamp with time zone` |
| `Guid` | `uuid` |
| `enum` | `integer` (unless you configure a conversion) |
| `List<string>` / `string[]` | `text[]` (Npgsql maps primitive collections to native arrays) |
| `int AuthorId` + `Author Author` | foreign key + index `IX_Posts_AuthorId` |

Tables are named after the `DbSet` properties (`"Posts"`), columns after properties (`"Title"`) — in
**PascalCase**, which in PostgreSQL means quoted identifiers (`SELECT "Title" FROM "Posts"`). Many teams
add the `EFCore.NamingConventions` package and `.UseSnakeCaseNamingConvention()` to get idiomatic
`posts.title` instead.

### Relationships: how EF reads your navigations

A **navigation** is a property that points at another entity (`Post.Author`) or a collection of them
(`Author.Posts`). A **foreign key** (FK) is the column that actually stores the link in the database
(`Posts.AuthorId`). EF Core pairs them up by convention:

| Shape in C# | What EF creates in PostgreSQL |
|---|---|
| `Post.AuthorId` + `Post.Author` + `Author.Posts` | **one-to-many**: an `AuthorId` FK column on `Posts`, pointing at `Authors.Id` |
| `Post.Tags` (List) + `Tag.Posts` (List), no join class | **many-to-many**: a join table `PostTag(PostsId, TagsId)` with a composite primary key |
| non-nullable FK (`int AuthorId`) | **required** relationship: a post can't exist without an author |
| nullable FK (`int? AuthorId`) | **optional** relationship: `AuthorId` may be `NULL` |

Why does this matter? Because the relationship decides what happens on delete. A required
relationship defaults to `DeleteBehavior.Cascade`: delete an author and PostgreSQL deletes their
posts too (`ON DELETE CASCADE`). That's convenient for a blog and dangerous for, say, invoices. Pick
the delete behaviour on purpose (`Cascade`, `Restrict`, `SetNull`) and write it down in the Fluent
API so reviewers see it.

### Fluent API: when conventions aren't enough

Override and add details in `OnModelCreating`:

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Author>(author =>
    {
        author.Property(a => a.Name).HasMaxLength(100);          // varchar(100)
        author.Property(a => a.Email).HasMaxLength(254);
        author.HasIndex(a => a.Email).IsUnique();                // unique index
    });

    modelBuilder.Entity<Post>(post =>
    {
        post.Property(p => p.Title).HasMaxLength(200);
        post.HasIndex(p => p.Slug).IsUnique();
        post.Property(p => p.Status).HasConversion<string>().HasMaxLength(20);   // store "Draft", not 0
        post.Property(p => p.CreatedAt).HasDefaultValueSql("now()");

        post.HasOne(p => p.Author)
            .WithMany(a => a.Posts)
            .HasForeignKey(p => p.AuthorId)
            .OnDelete(DeleteBehavior.Cascade);                   // deleting an author deletes posts

        post.HasMany(p => p.Tags).WithMany(t => t.Posts);        // join table "PostTag"
    });
}
```

You *can* use data annotations (`[MaxLength(100)]`, `[Required]`) on entities instead, but the Fluent
API is more powerful and keeps persistence concerns out of your classes. In bigger apps, split it into
one `IEntityTypeConfiguration<T>` class per entity and call
`modelBuilder.ApplyConfigurationsFromAssembly(typeof(BlogDbContext).Assembly)`.

## jsonb: documents inside relational tables

PostgreSQL's `jsonb` stores JSON in a binary, indexable form. It's ideal for data that's read together
with its row but has a flexible shape: settings, metadata, SEO info, an address. EF Core 10 maps a
**complex type** to a single JSON column with `ToJson()`:

```csharp
public class SeoMetadata
{
    public string? Description { get; set; }
    public List<string> Keywords { get; set; } = [];
    public bool NoIndex { get; set; }
}

public class Post
{
    // …
    public SeoMetadata Seo { get; set; } = new();
}

// OnModelCreating
modelBuilder.Entity<Post>().ComplexProperty(p => p.Seo, seo => seo.ToJson());   // column "Seo" jsonb
```

Stored as:

```json
{"NoIndex": false, "Keywords": ["ef", "postgres"], "Description": "Intro"}
```

And — the important part — **LINQ into the JSON is translated to SQL**, so the filter runs inside
PostgreSQL instead of loading every post into memory:

```csharp
db.Posts.Where(p => p.Seo.Keywords.Contains("ef")).Select(p => p.Title)
```

The SQL uses PostgreSQL's JSON operators, along these lines (the exact text varies by provider version
— check yours with `ToQueryString()`, be-11):

```sql
SELECT p."Title" FROM "Posts" AS p WHERE (p."Seo" -> 'Keywords') @> to_jsonb('ef'::text)
```

Before EF Core 10 you'd use **owned entities** (`OwnsOne(...).ToJson()`) for this. Complex types are
now the recommended mapping: they have value semantics (no hidden identity), and `ExecuteUpdateAsync`
can update properties inside the JSON.

:::pro title="jsonb is not a schema escape hatch"
If you filter, join or aggregate on a field constantly, it probably wants to be a real column (with a
real index and constraints). Use `jsonb` for genuinely document-shaped data. Reviewers will ask "why is
`customerId` inside a JSON blob?"
:::

## Migrations

A **migration** is a generated C# class with `Up()` (apply) and `Down()` (revert) that changes the
schema from one model version to the next. EF compares your current model with the last snapshot
(`Migrations/BlogDbContextModelSnapshot.cs`) and generates the difference.

Install the tool **per repository** as a local tool, so everyone uses the same version:

```bash
dotnet new tool-manifest          # creates dotnet-tools.json (commit it)
dotnet tool install dotnet-ef     # teammates run: dotnet tool restore
```

The workflow:

```bash
dotnet ef migrations add InitialCreate --project src/Blog.Api   # generate code; does NOT touch the DB
# … review the generated Migrations/*_InitialCreate.cs …
dotnet ef database update --project src/Blog.Api               # apply pending migrations to the DB
dotnet ef migrations list --project src/Blog.Api               # applied vs pending
dotnet ef migrations remove --project src/Blog.Api             # delete the LAST migration (if not applied)
dotnet ef migrations script --idempotent -o migrate.sql --project src/Blog.Api   # SQL script for production
```

`--project` points at the project that contains the `DbContext` and the `Migrations/` folder. If your
startup project (the one with `Program.cs` and the connection string) is a different one, add
`--startup-project src/Blog.Web` as well. `--idempotent` wraps each migration in an
`IF NOT EXISTS (… __EFMigrationsHistory …)` check, so the same script is safe to run against a database
at any older version.

EF records applied migrations in the `__EFMigrationsHistory` table, so `database update` only runs the
new ones.

:::job title="Migration rules you'll be held to"
- **Always read the generated migration** before committing. Renaming a property can generate
  `DropColumn` + `AddColumn` — silently deleting production data. Fix it to `RenameColumn`.
- **Never edit a migration that's already been applied** in a shared environment. Add a new one.
- Migrations are code: they're reviewed in PRs and merge conflicts in the snapshot are resolved
  carefully (usually: remove yours, merge main, re-add).
- **Production**: apply migrations as a deliberate deployment step — an idempotent SQL script or a
  migration bundle (`dotnet ef migrations bundle`) run by CI/CD or a Kubernetes Job. Calling
  `db.Database.Migrate()` at app startup is fine for local dev and tests, but it needs DDL permissions
  the app user shouldn't have, every replica's startup blocks on the migration lock (EF Core 9+
  serializes concurrent `Migrate()` calls; older versions could race and corrupt the schema), and a
  failing migration crash-loops every pod.
- Destructive changes (drop column, NOT NULL on existing data) are done in steps across releases
  ("expand and contract").
:::

## Querying and saving

All the LINQ from be-03 applies, on `IQueryable`, translated to SQL. Use the **async** methods and pass
the `CancellationToken`. You need exactly two ways of reading for this lesson's lab:

```csharp
// 1. Read-only list → project to a DTO. Only the needed columns; navigations become JOINs.
var posts = await db.Posts
    .Where(p => p.Status == PostStatus.Published)
    .OrderByDescending(p => p.CreatedAt)
    .Select(p => new PostSummary(p.Id, p.Title, p.Slug, p.Author.Name, p.Tags.Select(t => t.Name).ToList()))
    .ToListAsync(ct);

// 2. Load an ENTITY you'll modify → related data only if you ask for it.
var post = await db.Posts.Include(p => p.Tags).FirstAsync(p => p.Slug == slug, ct);
// Without Include, post.Tags is empty and post.Author is null: EF never loads navigations silently.
```

Lazy loading is off by default, and teams keep it off: it turns "50 posts, then `post.Author` on each"
into 51 queries, the **N+1 problem**. The lab's read endpoints also add `AsNoTracking()`, which tells EF
not to keep change-tracking snapshots of results you only read.

:::info title="The details live in the next lesson"
**EF Core Querying Like a Pro** (be-11) is all about reading data well: how to see the generated SQL,
tracking vs `AsNoTracking`, why projections usually beat `Include`, the N+1 problem (and why lazy
loading stays off), split queries, raw SQL and transactions. Here we only need the two shapes above
plus saving, which comes next.
:::

### Change tracking and `SaveChanges`

Why does EF need "tracking" at all? Your entities are plain C# objects. Setting `post.Title = "x"`
doesn't notify anyone. So when a normal query returns entities, the context keeps a **snapshot** of
their original values. On `SaveChanges` it compares each tracked entity with its snapshot ("detect
changes") and writes SQL only for what differs. Every tracked entity has a **state**:

| State | Meaning | What `SaveChanges` does |
|---|---|---|
| `Unchanged` | loaded, not modified | nothing |
| `Modified` | at least one property differs from the snapshot | `UPDATE` of the changed columns only |
| `Added` | passed to `Add` (or reachable from an added entity) | `INSERT` |
| `Deleted` | passed to `Remove` | `DELETE` |
| `Detached` | the context doesn't know it (e.g. `AsNoTracking`, or created with `new` and never added) | nothing |

You can inspect it while debugging: `db.Entry(post).State`. Modify tracked entities and call
`SaveChangesAsync` — EF generates the SQL, all in one transaction:

```csharp
var post = await db.Posts.FirstAsync(p => p.Id == id, ct);   // tracked
post.Title = "New title";
post.Tags.Add(new Tag { Name = "efcore" });
await db.SaveChangesAsync(ct);    // UPDATE "Posts" SET "Title" = … ; INSERT INTO "Tags" … ; INSERT INTO "PostTag" …
```

- `db.Posts.Add(entity)` → `INSERT`; `db.Posts.Remove(entity)` → `DELETE`.
- Entities loaded with `AsNoTracking()` are `Detached`: changes to them are **not saved**. be-11 covers
  when to use it, and bulk `ExecuteUpdateAsync` / `ExecuteDeleteAsync`, which skip tracking entirely.

:::warn title="timestamptz wants UTC"
Npgsql maps `timestamp with time zone` to **UTC** values only. Writing a `DateTimeOffset` with a
non-zero offset (or a `DateTime` with `Kind=Local`/`Unspecified`) throws:
`Cannot write DateTimeOffset with Offset=01:00:00 to PostgreSQL type 'timestamp with time zone', only offset 0 (UTC) is supported.`
Watch out for `new DateTime(2026, 1, 1)` being implicitly converted to a `DateTimeOffset` with your
machine's local offset. Use `DateTimeOffset.UtcNow` / `TimeProvider.GetUtcNow()` and convert to local
time only for display.
:::

### Let the database enforce uniqueness

A tempting way to keep slugs unique is to check first:

```csharp
if (await db.Posts.AnyAsync(p => p.Slug == input.Slug, ct)) return Results.Conflict();
db.Posts.Add(post);
await db.SaveChangesAsync(ct);
```

That check is useful for a friendly error message, but it is **not a guarantee**. Two requests with the
same slug can both run `AnyAsync` (both see "no"), then both insert. Only the database sees every
transaction, so only a **unique index** (`HasIndex(p => p.Slug).IsUnique()`) closes the race. When it
fires, `SaveChangesAsync` throws `DbUpdateException` whose `InnerException` is a `PostgresException`
with `SqlState == "23505"` (unique violation) and `ConstraintName == "IX_Posts_Slug"`. Catch that
specific case and return `409 Conflict`; let everything else bubble up.

## Check yourself

:::quiz id=be-10-q1
You ran `dotnet ef migrations add AddPostSummary`. What happened to the database?

- [x] Nothing — a migration class was generated; `dotnet ef database update` (or a script/bundle) applies it
- [ ] The column was added immediately
- [ ] The database was dropped and recreated
- [ ] The `__EFMigrationsHistory` table got a new row
> `migrations add` only compares the model with the snapshot and writes C# code (the migration plus an updated `ModelSnapshot`). It doesn't even connect to the database, so `__EFMigrationsHistory` is untouched — that row is written only when the migration is *applied*. Keeping generate and apply separate is what makes reviewing migrations possible.
:::

:::quiz id=be-10-q2
What happens here (no `Include`, lazy loading not enabled)?

```csharp
var post = await db.Posts.FirstAsync(p => p.Slug == "hello", ct);
return post.Author.Name;
```

- [ ] EF loads the author automatically with a second query
- [x] `post.Author` is `null`, so it throws `NullReferenceException`
- [ ] It returns an empty string
- [ ] It doesn't compile
> Related entities aren't loaded unless you `Include` them, project them in `Select`, or they're already tracked. The code compiles fine — `Author` is declared non-nullable with `= null!` — so the mistake only shows up at runtime. EF does *not* silently run a second query; that would only happen with lazy-loading proxies, which cause the N+1 problem.
:::

:::quiz id=be-10-q3
Which query sends the least data over the wire for a list page that shows title, author name and tag names?

- [ ] `db.Posts.Include(p => p.Author).Include(p => p.Tags).ToListAsync()`
- [x] `db.Posts.Select(p => new PostSummary(p.Title, p.Author.Name, p.Tags.Select(t => t.Name).ToList())).ToListAsync()`
- [ ] `db.Posts.ToListAsync()` and then `.Select(...)` in memory
- [ ] `db.Posts.AsNoTracking().ToListAsync()`
> A projection fetches only the columns used and turns navigations into JOINs. `Include` loads entire entities (every column of posts, authors and tags), and the in-memory versions load everything first.
:::

:::quiz id=be-10-q4
A teammate wrote this update. Why is nothing saved?

```csharp
var post = await db.Posts.AsNoTracking().FirstAsync(p => p.Id == id, ct);
post.Title = request.Title;
await db.SaveChangesAsync(ct);
```

- [ ] `SaveChangesAsync` needs a transaction
- [x] `AsNoTracking()` means the context isn't tracking `post`, so it has no changes to save
- [ ] Titles can only be changed with `ExecuteUpdateAsync`
- [ ] The `CancellationToken` cancels the save
> Change tracking is what turns property assignments into `UPDATE`s. The entity is `Detached`, so `SaveChangesAsync` finds nothing to do and returns 0 — no exception. A transaction wouldn't help (`SaveChanges` already uses one), and `ExecuteUpdateAsync` is just one option. For updates, use a tracking query (the default), or `db.Update(post)` (which marks *every* column modified), or `ExecuteUpdateAsync`.
:::

:::quiz id=be-10-q5
You renamed `Post.Body` to `Post.Content` and generated a migration. It contains `DropColumn("Body")` and `AddColumn("Content")`. What should you do?

- [ ] Commit it — EF knows best
- [x] Edit the migration to `RenameColumn(name: "Body", table: "Posts", newName: "Content")` so existing data is kept
- [ ] Delete the database and recreate it
- [ ] Revert the rename; columns can never be renamed
> EF can't always tell a rename from drop-and-add. Applied as generated, every post body in production is deleted. Reading generated migrations before committing is a core review habit.
:::

:::quiz id=be-10-q6
Your app runs 4 replicas in Kubernetes and calls `db.Database.Migrate()` at startup. What's the main risk?

- [ ] Migrations run slower in containers
- [x] The app's DB user needs schema-changing (DDL) permissions, and every replica's startup blocks on, or crash-loops with, the migration; before EF Core 9 replicas could even race and apply it twice
- [ ] `Migrate()` only works on SQL Server
- [ ] It drops the history table
> Since EF Core 9, `Migrate()` takes a database lock, so replicas no longer corrupt each other, but they all wait on it at startup, a failed migration takes every pod down, and the runtime user needs DDL rights. In production, run an idempotent script or a migration bundle once, as a deployment step, with a privileged user.
:::

:::quiz id=be-10-q7
Which of these are reasonable uses of a `jsonb` column? (select all)

- [x] Per-post SEO metadata (description, keywords) read with the post
- [x] A user's UI preferences blob
- [ ] The `CustomerId` of every order, which you join on in most reports
- [x] Raw webhook payloads you store for auditing
> `jsonb` suits document-shaped data read together with its row. Foreign keys and frequently filtered/joined fields belong in real columns with indexes and constraints.
:::

:::quiz id=be-10-q8
Saving a `Post` throws `Cannot write DateTimeOffset with Offset=01:00:00 to PostgreSQL type 'timestamp with time zone', only offset 0 (UTC) is supported.` The code did `CreatedAt = new DateTime(2026, 1, 1)`. What's the fix?

- [ ] Change the column to `text`
- [x] Store UTC: `CreatedAt = DateTimeOffset.UtcNow` (or `new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero)`)
- [ ] Set the server's time zone to UTC+1
- [ ] Use `float` for timestamps
> The `DateTime` was implicitly converted to a `DateTimeOffset` with the machine's local offset. Npgsql only writes UTC to `timestamptz` — store UTC, convert for display. Changing the server's time zone doesn't help: the check happens in the Npgsql driver before anything is sent, and a `text` column would throw away date semantics (sorting, ranges, indexes).
:::

:::quiz id=be-10-q9
Two users submit a post with the slug `hello` at the same moment. The endpoint runs `AnyAsync(p => p.Slug == slug)` and only inserts if it returns `false`. There is **no** unique index on `Slug`. What can happen?

- [ ] Nothing bad — `AnyAsync` and `SaveChangesAsync` run in one transaction, so the second request waits
- [x] Both checks see no row, both inserts succeed, and you now have two posts with the same slug
- [ ] EF Core detects the duplicate in the change tracker and throws
- [ ] PostgreSQL rejects the second insert because `Slug` is `required`
> The check and the insert are separate round trips, and the two requests use separate contexts, so neither sees the other's uncommitted row. `SaveChanges` only wraps its *own* statements in a transaction — not the earlier `AnyAsync`. `required` only means NOT NULL. A unique index is the only thing that makes the database reject the second insert (`23505 unique_violation`).
:::

## Lab: a blog API on PostgreSQL

:::lab id=be-10-lab1 xp=150
title: EF Core + Npgsql — model, migrate, query, test against real Postgres

You'll model authors, posts and tags (one-to-many, many-to-many, a `jsonb` column), generate and apply a
migration, query with projections, and run integration tests against a real PostgreSQL 18 database.

**Prerequisites:** .NET 10 SDK and Docker (or Podman — replace `docker` with `podman`).

**1. Start PostgreSQL**

```bash
docker run -d --name blog-db \
  -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app_dev_pw -e POSTGRES_DB=blog \
  -p 5432:5432 -v blog-pgdata:/var/lib/postgresql postgres:18
docker exec blog-db pg_isready -U app
# /var/run/postgresql:5432 - accepting connections
```

(If port 5432 is taken, use `-p 5433:5432` and `Port=5433` in both connection strings below.)

**2. Create the solution and add packages**

```bash
mkdir Blog && cd Blog
dotnet new sln -n Blog
dotnet new web -o src/Blog.Api
dotnet new xunit -o tests/Blog.Tests
dotnet sln add src/Blog.Api tests/Blog.Tests
dotnet add tests/Blog.Tests reference src/Blog.Api
dotnet add src/Blog.Api package Npgsql.EntityFrameworkCore.PostgreSQL
dotnet add src/Blog.Api package Microsoft.EntityFrameworkCore.Design
dotnet add src/Blog.Api package Microsoft.EntityFrameworkCore.Relational
dotnet add tests/Blog.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet new tool-manifest
dotnet tool install dotnet-ef
rm tests/Blog.Tests/UnitTest1.cs
mkdir src/Blog.Api/Data
```

:::info title="Why add Relational explicitly?"
The Npgsql provider may depend on a slightly older EF Core patch than the `Design` package. `Design` is
a private (build-only) dependency, so the test project would see the older EF Core while the API was
compiled against the newer one — MSBuild warning **MSB3277** ("Found conflicts between different
versions"). Referencing `Microsoft.EntityFrameworkCore.Relational` directly makes every project agree on
the newest version.
:::

**3. Entities: `src/Blog.Api/Data/Entities.cs`**

```csharp
namespace Blog.Api.Data;

public class Author
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string Email { get; set; }

    public List<Post> Posts { get; set; } = [];          // one author -> many posts
}

public class Post
{
    public int Id { get; set; }
    public required string Title { get; set; }
    public required string Slug { get; set; }
    public string Body { get; set; } = "";
    public PostStatus Status { get; set; } = PostStatus.Draft;
    public DateTimeOffset CreatedAt { get; set; }

    public int AuthorId { get; set; }                     // foreign key (convention: <Nav>Id)
    public Author Author { get; set; } = null!;           // reference navigation

    public List<Tag> Tags { get; set; } = [];             // many-to-many (EF creates the join table)

    public SeoMetadata Seo { get; set; } = new();         // stored as ONE jsonb column
}

public class Tag
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public enum PostStatus { Draft, Published, Archived }

public class SeoMetadata
{
    public string? Description { get; set; }
    public List<string> Keywords { get; set; } = [];
    public bool NoIndex { get; set; }
}
```

**4. The context: `src/Blog.Api/Data/BlogDbContext.cs`**

```csharp
using Microsoft.EntityFrameworkCore;

namespace Blog.Api.Data;

public class BlogDbContext(DbContextOptions<BlogDbContext> options) : DbContext(options)
{
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Author>(author =>
        {
            author.Property(a => a.Name).HasMaxLength(100);
            author.Property(a => a.Email).HasMaxLength(254);
            author.HasIndex(a => a.Email).IsUnique();
        });

        modelBuilder.Entity<Post>(post =>
        {
            post.Property(p => p.Title).HasMaxLength(200);
            post.Property(p => p.Slug).HasMaxLength(200);
            post.HasIndex(p => p.Slug).IsUnique();

            post.Property(p => p.Status).HasConversion<string>().HasMaxLength(20);
            post.Property(p => p.CreatedAt).HasDefaultValueSql("now()");

            post.HasOne(p => p.Author)
                .WithMany(a => a.Posts)
                .HasForeignKey(p => p.AuthorId)
                .OnDelete(DeleteBehavior.Cascade);

            post.HasMany(p => p.Tags).WithMany(t => t.Posts);

            post.ComplexProperty(p => p.Seo, seo => seo.ToJson());   // jsonb column "Seo"
        });

        modelBuilder.Entity<Tag>().HasIndex(t => t.Name).IsUnique();
    }
}
```

**5. Connection string: replace `src/Blog.Api/appsettings.Development.json`**

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  },
  "ConnectionStrings": {
    "Blog": "Host=localhost;Port=5432;Database=blog;Username=app;Password=app_dev_pw"
  }
}
```

The `Database.Command` category logs every SQL statement — watch the console while you call the API.

**6. Endpoints: replace `src/Blog.Api/Program.cs`**

```csharp
using Blog.Api.Data;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<BlogDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("Blog")));

var app = builder.Build();

app.MapGet("/posts", async (BlogDbContext db, CancellationToken ct) =>
    await db.Posts
        .AsNoTracking()
        .Where(p => p.Status == PostStatus.Published)
        .OrderByDescending(p => p.CreatedAt)
        .Select(p => new PostSummary(p.Id, p.Title, p.Slug, p.Author.Name, p.Tags.Select(t => t.Name).ToList()))
        .ToListAsync(ct));

app.MapGet("/posts/{slug}", async (string slug, BlogDbContext db, CancellationToken ct) =>
    await db.Posts.AsNoTracking()
        .Where(p => p.Slug == slug)
        .Select(p => new PostDetail(p.Id, p.Title, p.Body, p.Author.Name, p.Seo.Description, p.Seo.Keywords))
        .FirstOrDefaultAsync(ct) is { } post
        ? Results.Ok(post)
        : Results.NotFound());

app.MapPost("/authors/{authorId:int}/posts", async (int authorId, CreatePost input, BlogDbContext db, CancellationToken ct) =>
{
    if (!await db.Authors.AnyAsync(a => a.Id == authorId, ct)) return Results.NotFound();

    // Reuse existing tags, create missing ones.
    var tags = await db.Tags.Where(t => input.Tags.Contains(t.Name)).ToListAsync(ct);
    foreach (var name in input.Tags.Except(tags.Select(t => t.Name)))
        tags.Add(new Tag { Name = name });

    var post = new Post
    {
        Title = input.Title,
        Slug = input.Slug,
        Body = input.Body,
        Status = PostStatus.Published,
        AuthorId = authorId,
        Tags = tags,
        Seo = new SeoMetadata { Description = input.SeoDescription, Keywords = input.Keywords },
    };
    db.Posts.Add(post);
    await db.SaveChangesAsync(ct);

    return Results.Created($"/posts/{post.Slug}", new { post.Id, post.Slug });
});

app.Run();

public record PostSummary(int Id, string Title, string Slug, string Author, List<string> Tags);
public record PostDetail(int Id, string Title, string Body, string Author, string? SeoDescription, List<string> Keywords);
public record CreatePost(string Title, string Slug, string Body, List<string> Tags, string? SeoDescription, List<string> Keywords);
```

(To keep the focus on EF Core, this lab skips the DTO validation from be-07 — in a real API you'd add it.)

**7. Generate and apply the migration**

```bash
dotnet ef migrations add InitialCreate --project src/Blog.Api
# Build succeeded.
# Done. To undo this action, use 'ef migrations remove'
dotnet ef database update --project src/Blog.Api
# Build succeeded.
# Applying migration '20261105120000_InitialCreate'.
# Done.
```

Open `src/Blog.Api/Migrations/*_InitialCreate.cs` and find: the identity columns, `character
varying(200)` for `Title`, the `jsonb` column `Seo`, the `PostTag` join table with a composite primary
key, and the unique indexes. Then look at the real schema:

```bash
docker exec -it blog-db psql -U app -d blog -c '\dt' -c '\d "Posts"'
```

**8. Tests against a real database: `tests/Blog.Tests/BlogApiFactory.cs`**

```csharp
using Blog.Api.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Blog.Tests;

// Boots the real API against a throw-away database "blog_tests" on the same dev server.
public sealed class BlogApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string ConnectionString =
        "Host=localhost;Port=5432;Database=blog_tests;Username=app;Password=app_dev_pw";

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.UseSetting("ConnectionStrings:Blog", ConnectionString);

    public async Task InitializeAsync()
    {
        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BlogDbContext>();
        await db.Database.EnsureDeletedAsync();
        await db.Database.MigrateAsync();          // applies YOUR migrations -> tests them too

        var ada = new Author { Name = "Ada Lovelace", Email = "ada@example.com" };
        db.Authors.Add(ada);
        db.Posts.Add(new Post
        {
            Title = "Hello EF Core", Slug = "hello-ef-core", Body = "First post",
            Status = PostStatus.Published, Author = ada,
            Tags = [new Tag { Name = "efcore" }],
            Seo = new SeoMetadata { Description = "Intro", Keywords = ["ef", "postgres"] },
        });
        db.Posts.Add(new Post { Title = "Secret draft", Slug = "secret-draft", Author = ada });
        await db.SaveChangesAsync();
    }

    Task IAsyncLifetime.DisposeAsync() => Task.CompletedTask; // keep the DB around to inspect with psql
}
```

`Task IAsyncLifetime.DisposeAsync()` is an *explicit interface implementation*: `WebApplicationFactory`
already has a `ValueTask DisposeAsync()`, and xUnit's `IAsyncLifetime` wants a `Task` one.

**9. `tests/Blog.Tests/BlogApiTests.cs`**

```csharp
using System.Net;
using System.Net.Http.Json;
using Blog.Api.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Blog.Tests;

public class BlogApiTests(BlogApiFactory factory) : IClassFixture<BlogApiFactory>
{
    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Lists_only_published_posts_with_author_and_tags()
    {
        var posts = await _client.GetFromJsonAsync<List<PostSummary>>("/posts");

        var post = Assert.Single(posts!, p => p.Slug == "hello-ef-core");
        Assert.Equal("Ada Lovelace", post.Author);
        Assert.Contains("efcore", post.Tags);
        Assert.DoesNotContain(posts!, p => p.Slug == "secret-draft");
    }

    [Fact]
    public async Task Reads_values_out_of_the_jsonb_column()
    {
        var post = await _client.GetFromJsonAsync<PostDetail>("/posts/hello-ef-core");

        Assert.Equal("Intro", post!.SeoDescription);
        Assert.Equal(["ef", "postgres"], post.Keywords);
    }

    [Fact]
    public async Task Creating_a_post_reuses_existing_tags_and_creates_new_ones()
    {
        var response = await _client.PostAsJsonAsync("/authors/1/posts", new
        {
            title = "Migrations 101", slug = "migrations-101", body = "...",
            tags = new[] { "efcore", "migrations" },
            seoDescription = (string?)null, keywords = Array.Empty<string>(),
        });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BlogDbContext>();
        var tagNames = await db.Tags.Select(t => t.Name).OrderBy(n => n).ToListAsync();
        Assert.Equal(["efcore", "migrations"], tagNames);   // "efcore" NOT duplicated
    }

    [Fact]
    public async Task Unknown_author_returns_404()
    {
        var response = await _client.PostAsJsonAsync("/authors/999/posts", new
        {
            title = "x", slug = "x", body = "x", tags = Array.Empty<string>(), keywords = Array.Empty<string>(),
        });

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Database_enforces_unique_slugs()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<BlogDbContext>();
        db.Posts.Add(new Post { Title = "Dup", Slug = "hello-ef-core", AuthorId = 1 });

        var ex = await Assert.ThrowsAsync<DbUpdateException>(() => db.SaveChangesAsync());
        Assert.Contains("IX_Posts_Slug", ex.InnerException?.Message);
    }
}
```

**10. Run**

```bash
dotnet test
```

Expected: `Passed!  - Failed:     0, Passed:     5`. Then inspect what the tests left behind:

```bash
docker exec -it blog-db psql -U app -d blog_tests -c 'SELECT "Title", "Seo" FROM "Posts";'
```

You'll see the `Seo` column as real JSON:
`{"NoIndex": false, "Keywords": ["ef", "postgres"], "Description": "Intro"}`.

**11. Run the API and watch the SQL**

The `blog` database is empty (the tests seeded `blog_tests`), so point the API at the test database for
this step. An environment variable overrides `appsettings.Development.json` — the same mechanism you'd
use in production:

```bash
ConnectionStrings__Blog="Host=localhost;Port=5432;Database=blog_tests;Username=app;Password=app_dev_pw" \
  dotnet run --project src/Blog.Api
# the console prints: Now listening on: http://localhost:5xxx   ← use that port below
curl http://localhost:5xxx/posts
```

Expected response (ids may differ):

```json
[{"id":3,"title":"Migrations 101","slug":"migrations-101","author":"Ada Lovelace","tags":["efcore","migrations"]},{"id":1,"title":"Hello EF Core","slug":"hello-ef-core","author":"Ada Lovelace","tags":["efcore"]}]
```

The API console logs the generated `SELECT … FROM "Posts" AS p INNER JOIN "Authors" … LEFT JOIN …` —
**one** query, with JOINs, thanks to the projection. Stop the API with Ctrl+C.

**12. A second migration (the review habit)**

Add `public int ReadingMinutes { get; set; }` to `Post`, then run
`dotnet ef migrations add AddReadingMinutes --project src/Blog.Api`. Read the generated `Up()` — it
should be a single `AddColumn` with `defaultValue: 0`. Apply it with `dotnet ef database update --project src/Blog.Api`, and
run the tests again (they re-create `blog_tests` from all migrations).

- [ ] PostgreSQL 18 runs in Docker with a named volume mounted at `/var/lib/postgresql`
- [ ] `dotnet ef database update` created the tables; I found the `jsonb` column and the `PostTag` join table with `psql`
- [ ] All 5 tests pass against the real database
- [ ] I saw the generated SQL in the console and it used JOINs, not one query per post
- [ ] I added a second migration and read its `Up()` before applying it
:::

## Flashcards

:::cards id=be-10-cards1 title="EF Core & PostgreSQL"
Q: What does `AddDbContext` register, with which lifetime?
A: Your `DbContext` as a **scoped** service — one per HTTP request.
Q: `dotnet ef migrations add` vs `dotnet ef database update`?
A: `add` generates migration code (no DB change). `update` applies pending migrations and records them in `__EFMigrationsHistory`.
Q: How should production apply migrations?
A: As a deployment step: `dotnet ef migrations script --idempotent` or a migration bundle — not `Migrate()` at startup (DDL rights for the app user, every pod blocking on or crash-looping with the migration).
Q: Why read generated migrations?
A: Renames can become drop + add (data loss); defaults and nullability may need fixing.
Q: Why is `post.Author` null after `db.Posts.First(...)`?
A: Related data isn't loaded unless you `Include` it, project it in `Select`, or it's already tracked.
Q: What's the N+1 problem?
A: One query for a list, then one more query per item to load a relation. Fix with `Select` projections or `Include`.
Q: `AsNoTracking()` — when and what's the catch?
A: For read-only queries (faster, less memory). Changes to untracked entities aren't saved.
Q: How do you map a class to a jsonb column in EF Core 10?
A: `modelBuilder.Entity<Post>().ComplexProperty(p => p.Seo, b => b.ToJson());` — LINQ into it is translated to SQL.
Q: Postgres 18 Docker volume path?
A: Mount at `/var/lib/postgresql` (PGDATA is `/var/lib/postgresql/18/docker`).
Q: Npgsql and `timestamptz`?
A: Only UTC values (offset 0 / `DateTimeKind.Utc`) can be written. Store UTC, convert for display.
Q: The five entity states?
A: `Unchanged`, `Modified`, `Added`, `Deleted`, `Detached`. `SaveChanges` turns Modified/Added/Deleted into UPDATE/INSERT/DELETE.
Q: Why isn't `AnyAsync` before insert enough to keep a column unique?
A: Two concurrent requests can both pass the check. Only a unique index makes the database reject the duplicate (`23505`).
:::

## Recap

- EF Core = LINQ → SQL, change tracking, migrations. Npgsql is the PostgreSQL provider; `dotnet-ef` is a
  local tool.
- Run Postgres 18 in Docker with a named volume at `/var/lib/postgresql`; keep real connection strings
  out of git (`ConnectionStrings__Name` env vars).
- Conventions infer keys, FKs, nullability and types; the Fluent API adds lengths, indexes, conversions,
  relationships and `jsonb` (`ComplexProperty(...).ToJson()`).
- Migrations are reviewed code: `add` → read → `update`; scripts or bundles for production.
- Read lists with `Select` projections (JOINs, only needed columns); `Include` when you need whole
  entities you'll modify, then `SaveChangesAsync(ct)`. The deeper querying rules are in be-11.
- Tracked entities have a state (Unchanged / Modified / Added / Deleted / Detached); `SaveChanges` writes
  only the differences. One `DbContext` per request, one operation at a time.
- Store timestamps in UTC; let unique indexes enforce uniqueness the code can't guarantee (check-then-insert
  races).
