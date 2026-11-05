---
id: cap-02
title: "The Data Model: Projects, Versions & a Job Queue"
level: advanced
minutes: 180
xp: 250
summary: Design the BranchStory schema (jsonb story documents with a version, members, a Postgres job queue), build it with EF Core 10 and write the queries that keep it honest.
---

Every hard problem later in this capstone (lost updates, sharing, quotas, background publishing) is
either easy or impossible depending on the schema you choose **today**. This lesson makes the
decisions explicitly, builds them with EF Core 10 + Npgsql, and then has you write the three SQL
statements the whole product leans on: the **version-checked save**, the **"my projects"** query and
the **`FOR UPDATE SKIP LOCKED`** job claim.

## The schema at a glance

```text
 users                         projects                              project_members
 ─────────────────────         ──────────────────────────────        ─────────────────────
 id          uuid PK  ◄──┐     id          uuid PK         ◄──┬──    project_id uuid PK,FK
 subject     text UQ     └──── owner_id    uuid FK (restrict) │      user_id    uuid PK,FK ──► users
 email       text UQ           title       varchar(120)       │      role       'editor'|'viewer'
 display_name text             doc         jsonb   ◄── the whole graph
 plan        'free'|'pro'      version     int  > 0  ◄── concurrency token
 created_at  timestamptz       created_at / updated_at        │
                                                              │
 jobs (the queue)                              published_stories (public read model)
 ──────────────────────────────────            ───────────────────────────────────────
 id              bigint identity PK            project_id     uuid PK,FK ──► projects
 kind            'publish'                     slug           text UQ   (public URL)
 project_id      uuid FK ──► projects ─────────source_version int       (which doc version)
 payload         jsonb                         player_json    jsonb     (rendered output)
 status          queued|running|succeeded|failed  published_at timestamptz
 attempts / max_attempts
 run_after       timestamptz   ◄── backoff: "not before"
 leased_until / leased_by      ◄── crash recovery
 last_error, idempotency_key UQ, created_at, updated_at
```

Five tables, each with one job:

| Table | Why it exists |
|---|---|
| `users` | One row per person, keyed by the identity provider's **`sub`** claim. Holds the **plan** that quotas are read from. |
| `projects` | One story. The entire graph is **one jsonb `doc`**, guarded by one integer **`version`**. |
| `project_members` | Collaborator seats (`editor` / `viewer`). The **owner is not a member row**: ownership is `projects.owner_id`. |
| `jobs` | A durable work queue inside Postgres. Workers claim rows with `FOR UPDATE SKIP LOCKED`. |
| `published_stories` | What the public player reads. Rendered by the worker from a specific `source_version`. |

## Design decisions (and the alternatives we rejected)

**The graph is a document, not tables of nodes and edges.** The editor always loads and saves the
*whole* story; a save must be atomic (a choice pointing at a scene that another save just deleted
is corruption). With one jsonb column, "save" is one row update with one version check. With
`nodes` and `edges` tables you would need a transaction touching dozens of rows, a version on the
parent anyway, and diffing logic. What we give up: foreign keys *inside* the graph (the API
validates structure instead) and cheap partial updates (we don't need them: stories are kilobytes).

**An integer `version`, not a timestamp and not `xmin`.** Clients must send back "the version I
edited". An integer is easy to put in JSON, an `ETag` and a SignalR message; it never collides when
two saves land in the same millisecond, and it survives `pg_dump`/restore (Postgres' hidden `xmin`
does not, and it changes on *any* row write, including a title rename).

**UUID v7 keys.** A UUID v7 starts with a millisecond timestamp followed by random bits.
`Guid.CreateVersion7()` (new in .NET 9) generates one. Because new ids sort after old ones, inserts
append to the end of the primary-key B-tree like a sequence would, instead of landing on random
index pages the way random v4 UUIDs do (which bloats the index and slows inserts). And unlike an
`int` identity, the app can create the id before talking to the database, and nobody can guess
"the next project" by adding 1. The trade-off: the id reveals roughly when the row was created,
which is fine for projects and users.

**The owner is a column, not a role row.** There is exactly one owner, it can never be "removed",
and every quota is billed to it. Making that a `NOT NULL` foreign key turns "a project without an
owner" into something the database refuses, instead of something code has to remember.

**A job queue in Postgres, not Redis/RabbitMQ (yet).** Enqueueing a publish job can happen in the
**same transaction** as the change that caused it, there is one less system to run, and
`SKIP LOCKED` lets many workers pull without stepping on each other. A single Postgres
comfortably handles thousands of jobs per second (cap-08 looks at where the ceiling is), far
beyond what "publish a story" needs.

:::pro title="What real teams do"
"Document + version" is a common design for diagram editors, form and workflow builders and many
low-code tools, where the editor works on one canvas at a time. (Products built around fine-grained
blocks or real-time merging, like Notion or Figma, use more elaborate models; you'd only reach for
those when per-keystroke collaboration is the core feature.) Teams normalize only what they must
**query across** documents (owners, members, published slugs), and keep the editable blob opaque.
If you later need to search inside documents, a GIN index
(`CREATE INDEX … ON projects USING gin (doc jsonb_path_ops)`) or a generated column gets you there
without changing the model.
:::

:::quiz id=cap-02-q1 xp=15
cap-01 sold you the *benefit* of one `jsonb` document with a version: a save is a single-row
compare-and-swap. Every design has a price. Which of these are **real costs** you accept with it?
Select all that apply.
- [x] The database cannot check that an edge points at an existing scene; the API's validator has to
- [x] Two people editing *different* scenes still conflict, because one version guards the whole document
- [x] Every save writes the whole document again, even when one word changed
- [ ] You can no longer wrap changes to `projects` in a transaction
- [ ] Postgres cannot index anything inside a `jsonb` column
> Foreign keys and `CHECK` constraints work between columns, not inside a JSON value, so graph integrity becomes application code (cap-04's save validation, cap-06's validator). The version is per document, so conflicts are coarse: cap-06's merge dialog and cap-07's live patches exist to soften exactly that. And Postgres stores a `jsonb` value as one unit, so an update writes a new copy of all of it (fine for stories of a few hundred kB, a real problem for megabytes). The last two are false: transactions work on any table, and the GIN index in the callout above does index inside `jsonb`.
:::

:::quiz id=cap-02-q2 xp=15
Why does BranchStory use an explicit `version int` instead of `updated_at` as the concurrency token?
Select all that apply.
- [x] Two saves in the same clock tick would carry the same timestamp
- [x] Clients compare and echo it back exactly (JSON, `ETag`, SignalR) without time-zone or precision surprises
- [ ] Integers are required by EF Core for concurrency tokens
- [x] If the app sets the timestamp (`DateTimeOffset.UtcNow`), clock skew between API pods can even make time go "backwards"
> EF Core accepts any type as a concurrency token, so "integers are required" is the false option. The other three are real: .NET timestamps have 100 ns precision but Postgres stores microseconds, so a value echoed back by the client may not compare equal; two writes can share a tick; and different machines disagree about "now". A counter that only the database increments has none of these problems.
:::

:::lab id=cap-02-lab1 xp=120
title: Build the data layer with EF Core 10

You'll start PostgreSQL 18 with Docker Compose, write the `BranchStory.Data` class library
(entities, Fluent configuration, the jsonb converter), create the first migration and let the API
apply it on startup. Work from the repository root (the folder with `BranchStory.slnx`).

**1. Start Postgres.** Create `deploy/compose.yaml`:

```yaml
# Local infrastructure for BranchStory. Grows a service per lesson; for now only Postgres.
name: branchstory

services:
  db:
    image: postgres:18
    environment:
      POSTGRES_DB: branchstory
      POSTGRES_USER: branchstory
      POSTGRES_PASSWORD: branchstory   # dev only; real secrets come from a Secret in cap-10
    ports:
      - "5432:5432"
    volumes:
      # Postgres 18 images keep data in a versioned subfolder, so mount the parent directory.
      - dbdata:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U branchstory -d branchstory"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  dbdata:
```

```bash
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml ps        # db should become "healthy"
```

**2. Add the packages to the data project.**

```bash
dotnet add api/BranchStory.Data package Npgsql.EntityFrameworkCore.PostgreSQL
dotnet add api/BranchStory.Data package Microsoft.EntityFrameworkCore.Relational
dotnet add api/BranchStory.Data package EFCore.NamingConventions
dotnet add api/BranchStory.Data package Microsoft.Extensions.Hosting.Abstractions
dotnet add api/BranchStory.Data package Microsoft.EntityFrameworkCore.Design
```

Then make sure `api/BranchStory.Data/BranchStory.Data.csproj` looks like this (the `Design` package
is build-time only, hence `PrivateAssets`):

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Npgsql.EntityFrameworkCore.PostgreSQL" Version="10.0.*" />
    <!-- Pin EF Core itself, so the API and worker get the same patch the Design package uses. -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Relational" Version="10.0.*" />
    <PackageReference Include="EFCore.NamingConventions" Version="10.0.*" />
    <PackageReference Include="Microsoft.Extensions.Hosting.Abstractions" Version="10.0.*" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.*">
      <PrivateAssets>all</PrivateAssets>
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
    </PackageReference>
  </ItemGroup>

</Project>
```

:::warn title="Version drift"
`Design` is private, so the API only sees EF Core through Npgsql's (older) minimum dependency. Without the
explicit `Microsoft.EntityFrameworkCore.Relational` reference you get `CS1705: ... uses a higher version`
when the API builds. EF Core assemblies carry the patch number in their version (`10.0.3.0` is not
`10.0.0.0`), so even a patch-level mismatch breaks the build. (If `Class1.cs` survived cap-01,
delete it now.)
:::

**3. Entities.** `api/BranchStory.Data/Entities.cs` holds all five entities plus the string
constants for statuses, roles and plans (stored as short `varchar`s guarded by `CHECK`
constraints, which read better in `psql` than integer enums):

```csharp
namespace BranchStory.Data;

public static class Plans
{
    public const string Free = "free";
    public const string Pro = "pro";
}

public static class MemberRoles
{
    public const string Editor = "editor";
    public const string Viewer = "viewer";
}

public static class JobStatus
{
    public const string Queued = "queued";
    public const string Running = "running";
    public const string Succeeded = "succeeded";
    public const string Failed = "failed";
}

public static class JobKinds
{
    public const string Publish = "publish";
}

/// <summary>A person, keyed by the identity provider's stable "sub" claim.</summary>
public sealed class User
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public required string Subject { get; set; }
    public required string Email { get; set; }
    public required string DisplayName { get; set; }
    public string Plan { get; set; } = Plans.Free;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>One branching story. The whole graph lives in <see cref="Doc"/> (jsonb).</summary>
public sealed class Project
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public Guid OwnerId { get; set; }
    public User Owner { get; set; } = null!;
    public required string Title { get; set; }
    public StoryDoc Doc { get; set; } = StoryDoc.Starter();
    /// <summary>Bumped on every successful save; the optimistic-concurrency token.</summary>
    public int Version { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public List<ProjectMember> Members { get; set; } = [];
}

/// <summary>A collaborator seat. The owner is NOT a member row; ownership is Project.OwnerId.</summary>
public sealed class ProjectMember
{
    public Guid ProjectId { get; set; }
    public Project Project { get; set; } = null!;
    public Guid UserId { get; set; }
    public User User { get; set; } = null!;
    public required string Role { get; set; }
    public DateTimeOffset AddedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>A row in the Postgres job queue (claimed with FOR UPDATE SKIP LOCKED).</summary>
public sealed class Job
{
    public long Id { get; set; }
    public required string Kind { get; set; }
    public Guid ProjectId { get; set; }
    public string Payload { get; set; } = "{}";
    public string Status { get; set; } = JobStatus.Queued;
    public int Attempts { get; set; }
    public int MaxAttempts { get; set; } = 5;
    public DateTimeOffset RunAfter { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LeasedUntil { get; set; }
    public string? LeasedBy { get; set; }
    public string? LastError { get; set; }
    public required string IdempotencyKey { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}

/// <summary>The rendered, public player JSON for a project (one row per project).</summary>
public sealed class PublishedStory
{
    public Guid ProjectId { get; set; }
    public required string Slug { get; set; }
    public int SourceVersion { get; set; }
    public string PlayerJson { get; set; } = "{}";
    public DateTimeOffset PublishedAt { get; set; } = DateTimeOffset.UtcNow;
}
```

**4. The story document and its jsonb mapping.** `api/BranchStory.Data/StoryDoc.cs`:

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace BranchStory.Data;

/// <summary>The story graph: scenes (nodes) and choices (edges). Stored as one jsonb document.</summary>
public sealed record StoryDoc(string? StartNodeId, List<StoryNode> Nodes, List<StoryEdge> Edges)
{
    /// <summary>What a brand-new project starts with: one scene, which is also the start.</summary>
    public static StoryDoc Starter() =>
        new("start", [new StoryNode("start", "Opening scene", "Once upon a time...", null, 0, 0)], []);
}

/// <summary>A scene. X/Y are canvas coordinates for the editor.</summary>
public sealed record StoryNode(string Id, string Title, string Text, string? MediaUrl, double X, double Y);

/// <summary>A choice that leads from one scene to another.</summary>
public sealed record StoryEdge(string Id, string From, string To, string Label);

/// <summary>How EF Core turns a StoryDoc into jsonb text and back.</summary>
public static class StoryDocJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    public static string Serialize(StoryDoc doc) => JsonSerializer.Serialize(doc, Options);

    public static StoryDoc Deserialize(string json) =>
        JsonSerializer.Deserialize<StoryDoc>(json, Options) ?? StoryDoc.Starter();

    public static readonly ValueConverter<StoryDoc, string> Converter =
        new(doc => Serialize(doc), json => Deserialize(json));

    // EF's default snapshot of a class is the same reference, so in-place edits go unnoticed.
    // Compare serialized JSON, and snapshot a deep copy (JSON round trip).
    public static readonly ValueComparer<StoryDoc> Comparer =
        new((a, b) => Serialize(a!) == Serialize(b!), doc => Serialize(doc).GetHashCode(), doc => Deserialize(Serialize(doc)));
}
```

**Why a value converter *and* a value comparer?** The converter answers "how do I turn a `StoryDoc`
into the string Postgres stores, and back?". The comparer answers a different question EF asks on
every `SaveChanges`: "has this property changed since I loaded it?". To answer it, EF keeps a
*snapshot* of each property when it loads the entity and compares against it later. For a class like
`StoryDoc` the default snapshot is just the same reference, so `project.Doc.Nodes.Add(...)` changes
the "original" too, EF sees no change, and the save silently does nothing. (A smarter `Equals` alone
would not help: it would be comparing the object with itself.) The comparer fixes both halves: its
third lambda, `doc => Deserialize(Serialize(doc))`, takes a real deep-copy snapshot (a JSON round
trip), and its first lambda compares the serialized JSON, so in-place edits are detected. The middle
lambda supplies a matching hash code. Serializing is slower than a reference check but always correct
for kilobyte-sized documents.

:::info title="Alternative: EF Core's JSON mapping"
EF Core can also map a complex type straight to a JSON column (`ComplexProperty(...).ToJson()` /
owned types with `ToJson()`), which lets LINQ filter on properties *inside* the document. BranchStory
never queries inside `doc` on the server, so the value converter is simpler and keeps the stored JSON
shape exactly under our control. If you later need `Where(p => p.Doc.Nodes.Count > 50)` in SQL,
check the Npgsql docs for JSON mapping before reaching for raw SQL.
:::

The JSON shape stored in `projects.doc` (and sent to the browser) is therefore:

```json
{
  "startNodeId": "start",
  "nodes": [{ "id": "start", "title": "Opening scene", "text": "Once upon a time...", "mediaUrl": null, "x": 0, "y": 0 }],
  "edges": [{ "id": "e1", "from": "start", "to": "n1", "label": "Open the door" }]
}
```

**5. The DbContext.** `api/BranchStory.Data/BranchStoryDbContext.cs`:

```csharp
using Microsoft.EntityFrameworkCore;

namespace BranchStory.Data;

public sealed class BranchStoryDbContext(DbContextOptions<BranchStoryDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();
    public DbSet<Job> Jobs => Set<Job>();
    public DbSet<PublishedStory> PublishedStories => Set<PublishedStory>();

    protected override void OnModelCreating(ModelBuilder modelBuilder) =>
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(BranchStoryDbContext).Assembly);
}
```

**6. Fluent configuration, one class per entity** in `api/BranchStory.Data/Configurations/`.
Attributes on entities would scatter database concerns across the domain; one file per table
keeps them reviewable.

`Configurations/UserConfig.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BranchStory.Data.Configurations;

public sealed class UserConfig : IEntityTypeConfiguration<User>
{
    public void Configure(EntityTypeBuilder<User> b)
    {
        b.HasKey(u => u.Id);
        b.Property(u => u.Subject).HasMaxLength(200);
        b.Property(u => u.Email).HasMaxLength(320);
        b.Property(u => u.DisplayName).HasMaxLength(120);
        b.Property(u => u.Plan).HasMaxLength(16);
        b.HasIndex(u => u.Subject).IsUnique();
        b.HasIndex(u => u.Email).IsUnique();
        b.ToTable(t => t.HasCheckConstraint("ck_users_plan", "plan IN ('free', 'pro')"));
    }
}
```

`Configurations/ProjectConfig.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BranchStory.Data.Configurations;

public sealed class ProjectConfig : IEntityTypeConfiguration<Project>
{
    public void Configure(EntityTypeBuilder<Project> b)
    {
        b.HasKey(p => p.Id);
        b.Property(p => p.Title).HasMaxLength(120);

        b.Property(p => p.Doc)
            .HasColumnType("jsonb")
            .HasConversion(StoryDocJson.Converter, StoryDocJson.Comparer);

        // Tracked updates (load, change, SaveChanges) now also add "WHERE version = @original".
        // EF does NOT increment it for you: the code that saves must set Version = Version + 1.
        b.Property(p => p.Version).IsConcurrencyToken();

        b.HasOne(p => p.Owner)
            .WithMany()
            .HasForeignKey(p => p.OwnerId)
            .OnDelete(DeleteBehavior.Restrict);

        b.HasIndex(p => p.OwnerId);
        b.ToTable(t => t.HasCheckConstraint("ck_projects_version_positive", "version > 0"));
    }
}
```

`Configurations/ProjectMemberConfig.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BranchStory.Data.Configurations;

public sealed class ProjectMemberConfig : IEntityTypeConfiguration<ProjectMember>
{
    public void Configure(EntityTypeBuilder<ProjectMember> b)
    {
        b.HasKey(m => new { m.ProjectId, m.UserId });
        b.Property(m => m.Role).HasMaxLength(16);

        b.HasOne(m => m.Project)
            .WithMany(p => p.Members)
            .HasForeignKey(m => m.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);

        b.HasOne(m => m.User)
            .WithMany()
            .HasForeignKey(m => m.UserId)
            .OnDelete(DeleteBehavior.Cascade);

        // "Which projects am I a member of?" must not scan the whole table.
        b.HasIndex(m => m.UserId);
        b.ToTable(t => t.HasCheckConstraint("ck_project_members_role", "role IN ('editor', 'viewer')"));
    }
}
```

`Configurations/JobConfig.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BranchStory.Data.Configurations;

public sealed class JobConfig : IEntityTypeConfiguration<Job>
{
    public void Configure(EntityTypeBuilder<Job> b)
    {
        b.HasKey(j => j.Id);
        b.Property(j => j.Id).UseIdentityAlwaysColumn();
        b.Property(j => j.Kind).HasMaxLength(32);
        b.Property(j => j.Status).HasMaxLength(16);
        b.Property(j => j.Payload).HasColumnType("jsonb");
        b.Property(j => j.LeasedBy).HasMaxLength(100);
        b.Property(j => j.IdempotencyKey).HasMaxLength(200);

        b.HasOne<Project>()
            .WithMany()
            .HasForeignKey(j => j.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);

        // Enqueueing the same logical job twice is a no-op, not a duplicate.
        b.HasIndex(j => j.IdempotencyKey).IsUnique();
        // The claim query filters on status and orders by run_after.
        b.HasIndex(j => new { j.Status, j.RunAfter });
        b.HasIndex(j => j.ProjectId);

        b.ToTable(t =>
        {
            t.HasCheckConstraint("ck_jobs_status", "status IN ('queued', 'running', 'succeeded', 'failed')");
            t.HasCheckConstraint("ck_jobs_attempts", "attempts >= 0 AND attempts <= max_attempts");
        });
    }
}
```

`Configurations/PublishedStoryConfig.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace BranchStory.Data.Configurations;

public sealed class PublishedStoryConfig : IEntityTypeConfiguration<PublishedStory>
{
    public void Configure(EntityTypeBuilder<PublishedStory> b)
    {
        b.HasKey(s => s.ProjectId);
        b.Property(s => s.Slug).HasMaxLength(80);
        b.Property(s => s.PlayerJson).HasColumnType("jsonb");
        b.HasIndex(s => s.Slug).IsUnique();

        b.HasOne<Project>()
            .WithOne()
            .HasForeignKey<PublishedStory>(s => s.ProjectId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
```

**7. Registration shared by API and worker.** `api/BranchStory.Data/DataServiceExtensions.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace BranchStory.Data;

public static class DataServiceExtensions
{
    public const string ConnectionStringName = "BranchStory";

    /// <summary>Registers BranchStoryDbContext. Shared by the API and the worker.</summary>
    public static IServiceCollection AddBranchStoryDb(this IServiceCollection services)
    {
        // The lambda runs when a DbContext is first needed, so test overrides of the
        // connection string (WebApplicationFactory, Testcontainers) are always honoured.
        services.AddDbContext<BranchStoryDbContext>((sp, options) =>
        {
            var cs = sp.GetRequiredService<IConfiguration>().GetConnectionString(ConnectionStringName)
                ?? throw new InvalidOperationException($"ConnectionStrings:{ConnectionStringName} is not configured.");
            options.UseNpgsql(cs).UseSnakeCaseNamingConvention();
        });
        return services;
    }

    /// <summary>Applies pending migrations when Database:MigrateOnStartup is true (dev, tests).</summary>
    public static async Task MigrateIfConfiguredAsync(this IHost host)
    {
        var config = host.Services.GetRequiredService<IConfiguration>();
        if (!bool.TryParse(config["Database:MigrateOnStartup"], out var migrate) || !migrate) return;

        await using var scope = host.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BranchStoryDbContext>();
        await db.Database.MigrateAsync();
    }
}
```

**8. A design-time factory** so `dotnet ef` never has to boot the web host.
`api/BranchStory.Data/DesignTimeDbContextFactory.cs`:

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace BranchStory.Data;

/// <summary>Used only by "dotnet ef" so migrations don't need to boot the API.</summary>
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<BranchStoryDbContext>
{
    public BranchStoryDbContext CreateDbContext(string[] args)
    {
        var cs = Environment.GetEnvironmentVariable("ConnectionStrings__BranchStory")
            ?? "Host=localhost;Port=5432;Database=branchstory;Username=branchstory;Password=branchstory";
        var options = new DbContextOptionsBuilder<BranchStoryDbContext>()
            .UseNpgsql(cs)
            .UseSnakeCaseNamingConvention()
            .Options;
        return new BranchStoryDbContext(options);
    }
}
```

**9. Wire it into the API.** Replace `api/BranchStory.Api/Program.cs`:

```csharp
using BranchStory.Data;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddBranchStoryDb();

var app = builder.Build();

await app.MigrateIfConfiguredAsync();

app.MapGet("/", () => "BranchStory API");

// Temporary smoke endpoint. cap-03 replaces it with real, authenticated routes.
app.MapGet("/debug/db", async (BranchStoryDbContext db) => new
{
    migrations = await db.Database.GetAppliedMigrationsAsync(),
    users = await db.Users.CountAsync(),
    projects = await db.Projects.CountAsync(),
});

app.Run();
```

and `api/BranchStory.Api/appsettings.Development.json`:

```json
{
  "ConnectionStrings": {
    "BranchStory": "Host=localhost;Port=5432;Database=branchstory;Username=branchstory;Password=branchstory"
  },
  "Database": {
    "MigrateOnStartup": true
  }
}
```

**10. Create the migration, read it, run the API.**

```bash
dotnet tool restore                       # dotnet-ef from the tool manifest (cap-01)
dotnet ef migrations add Initial --project api/BranchStory.Data --output-dir Migrations
dotnet build
dotnet run --project api/BranchStory.Api  # applies the migration on startup
```

Open the generated `Migrations/*_Initial.cs` and check you can find the jsonb columns, the five
`CHECK` constraints and the unique index on `idempotency_key`. Then, in a second terminal:

```bash
curl -s http://localhost:5080/debug/db    # use the port your API prints
docker compose -f deploy/compose.yaml exec db psql -U branchstory -c '\d projects'
```

The API still has the random port the `web` template chose (cap-03 pins it to 5080), so copy the
`Now listening on: http://localhost:NNNN` URL from its log. Expect something like:

```text
{"migrations":["20261105093012_Initial"],"users":0,"projects":0}
```

and a `\d projects` listing that includes these lines (among others):

```text
 doc        | jsonb   |  | not null |
 version    | integer |  | not null |
Check constraints:
    "ck_projects_version_positive" CHECK (version > 0)
```

:::tip title="Migrations are code"
Commit `Migrations/` with the change that needed it, review the generated SQL with
`dotnet ef migrations script --project api/BranchStory.Data`, and never edit a migration that
already ran somewhere shared. Auto-migrate on startup is fine for dev and tests; in cap-10 we run
migrations as a separate step before the new pods start.
:::

- [ ] `docker compose -f deploy/compose.yaml ps` shows `db` as healthy
- [ ] `dotnet build` succeeds with 0 warnings for `BranchStory.Data` and `BranchStory.Api`
- [ ] The `Initial` migration exists and creates `users`, `projects`, `project_members`, `jobs`, `published_stories` (snake_case)
- [ ] `GET /debug/db` returns `["…_Initial"]` as the applied migrations
- [ ] `\d projects` in psql shows `doc jsonb`, `version integer` and the `ck_projects_version_positive` check
:::

:::job title="Day one at a real company"
You'll rarely design a schema from zero; you'll extend one. The habits are the same: every new
column gets a reason, a constraint where the database can enforce the rule, an index for the query
that will use it, and a migration reviewed like any other code. "The app validates it" is not a
constraint.
:::

## The queries the product depends on

The tables below are a trimmed copy of the real schema (text ids instead of uuids, fewer columns)
so you can read the results at a glance. Ada owns *Lost Key*, edits Bob's *Night Train* and can
view Bob's *Dragon Exam*.

:::sql id=cap-02-sql1 db=empty xp=30 ordered=true
title: "My projects" with my role
The dashboard lists every project **Ada** (`'ada'`) can open and her **role** in it: `'owner'` for
projects she owns, otherwise her role from `project_members`. Return `title, role`, ordered by
`title`.

hint: Two sets glued together: projects where `owner_id = 'ada'` (role is the literal `'owner'`) and projects joined to `project_members` where `user_id = 'ada'`.
hint: `UNION ALL` the two `SELECT`s, then one `ORDER BY title` at the end.

```sql setup
CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL, plan text NOT NULL DEFAULT 'free');
CREATE TABLE projects (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), title text NOT NULL,
  doc jsonb NOT NULL, version int NOT NULL DEFAULT 1 CHECK (version > 0), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_members (project_id text REFERENCES projects(id) ON DELETE CASCADE, user_id text REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('editor', 'viewer')), PRIMARY KEY (project_id, user_id));
INSERT INTO users VALUES ('ada', 'ada@x.test', 'Ada', 'free'), ('bob', 'bob@x.test', 'Bob', 'pro'), ('cy', 'cy@x.test', 'Cy', 'free');
INSERT INTO projects (id, owner_id, title, doc, version) VALUES
  ('p1', 'ada', 'Lost Key', '{"startNodeId":"s1","nodes":[{"id":"s1"},{"id":"s2"},{"id":"s3"}],"edges":[]}', 3),
  ('p2', 'bob', 'Night Train', '{"startNodeId":"a","nodes":[{"id":"a"},{"id":"b"}],"edges":[]}', 2),
  ('p3', 'bob', 'Dragon Exam', '{"startNodeId":"d","nodes":[{"id":"d"}],"edges":[]}', 1),
  ('p4', 'cy', 'Cy''s Draft', '{"startNodeId":"c","nodes":[{"id":"c"},{"id":"c2"}],"edges":[]}', 1);
INSERT INTO project_members VALUES ('p2', 'ada', 'editor'), ('p3', 'ada', 'viewer'), ('p4', 'bob', 'viewer');
```

```sql starter
SELECT title FROM projects WHERE owner_id = 'ada';
```

```sql solution
SELECT p.title, 'owner' AS role
FROM projects p
WHERE p.owner_id = 'ada'
UNION ALL
SELECT p.title, m.role
FROM projects p
JOIN project_members m ON m.project_id = p.id
WHERE m.user_id = 'ada'
ORDER BY title;
```
:::

:::sql id=cap-02-sql2 db=empty xp=25 ordered=true
title: Peek inside the jsonb document
Quotas limit scenes per story, so ops wants a quick report: each project's `title` and its number
of scenes (`jsonb_array_length` of the `nodes` array) as `scenes`, biggest first, ties by `title`.

hint: `doc->'nodes'` returns the array as jsonb; `doc->>'x'` would return text.
hint: `jsonb_array_length(doc->'nodes') AS scenes` and `ORDER BY scenes DESC, title`.

```sql setup
CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL, plan text NOT NULL DEFAULT 'free');
CREATE TABLE projects (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), title text NOT NULL,
  doc jsonb NOT NULL, version int NOT NULL DEFAULT 1 CHECK (version > 0), updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO users VALUES ('ada', 'ada@x.test', 'Ada', 'free'), ('bob', 'bob@x.test', 'Bob', 'pro'), ('cy', 'cy@x.test', 'Cy', 'free');
INSERT INTO projects (id, owner_id, title, doc, version) VALUES
  ('p1', 'ada', 'Lost Key', '{"startNodeId":"s1","nodes":[{"id":"s1"},{"id":"s2"},{"id":"s3"}],"edges":[]}', 3),
  ('p2', 'bob', 'Night Train', '{"startNodeId":"a","nodes":[{"id":"a"},{"id":"b"}],"edges":[]}', 2),
  ('p3', 'bob', 'Dragon Exam', '{"startNodeId":"d","nodes":[{"id":"d"}],"edges":[]}', 1),
  ('p4', 'cy', 'Cy''s Draft', '{"startNodeId":"c","nodes":[{"id":"c"},{"id":"c2"}],"edges":[]}', 1);
```

```sql starter
SELECT title, doc FROM projects;
```

```sql solution
SELECT title, jsonb_array_length(doc->'nodes') AS scenes
FROM projects
ORDER BY scenes DESC, title;
```
:::

:::sql id=cap-02-sql3 db=empty xp=40
title: The version-checked save
Two saves arrive. Write **both** as version-checked `UPDATE`s (each sets the new `doc`, increments
`version` and sets `updated_at = now()`, and `RETURNING version`):

1. Project `p1`, edited from **version 3**, new doc `{"startNodeId":"s9","nodes":[{"id":"s9"}],"edges":[]}`.
2. Project `p2`, edited from **version 1**, new doc `{"startNodeId":"zz","nodes":[{"id":"zz"}],"edges":[]}`.

The database decides who wins: a save whose expected version is no longer current must change
**nothing** (the API then answers 409 Conflict).

hint: The guard is part of the `WHERE`: `WHERE id = 'p1' AND version = 3`.
hint: An `UPDATE` that matches zero rows is not an error; `RETURNING` simply returns no row. That empty result is how the API detects the conflict.

```sql setup
CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE, display_name text NOT NULL, plan text NOT NULL DEFAULT 'free');
CREATE TABLE projects (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), title text NOT NULL,
  doc jsonb NOT NULL, version int NOT NULL DEFAULT 1 CHECK (version > 0), updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO users VALUES ('ada', 'ada@x.test', 'Ada', 'free'), ('bob', 'bob@x.test', 'Bob', 'pro');
INSERT INTO projects (id, owner_id, title, doc, version) VALUES
  ('p1', 'ada', 'Lost Key', '{"startNodeId":"s1","nodes":[{"id":"s1"},{"id":"s2"},{"id":"s3"}],"edges":[]}', 3),
  ('p2', 'bob', 'Night Train', '{"startNodeId":"a","nodes":[{"id":"a"},{"id":"b"}],"edges":[]}', 2);
```

```sql starter
UPDATE projects SET doc = '{"startNodeId":"s9","nodes":[{"id":"s9"}],"edges":[]}', version = version + 1, updated_at = now()
WHERE id = 'p1'
RETURNING version;

UPDATE projects SET doc = '{"startNodeId":"zz","nodes":[{"id":"zz"}],"edges":[]}', version = version + 1, updated_at = now()
WHERE id = 'p2'
RETURNING version;
```

```sql solution
UPDATE projects SET doc = '{"startNodeId":"s9","nodes":[{"id":"s9"}],"edges":[]}', version = version + 1, updated_at = now()
WHERE id = 'p1' AND version = 3
RETURNING version;

UPDATE projects SET doc = '{"startNodeId":"zz","nodes":[{"id":"zz"}],"edges":[]}', version = version + 1, updated_at = now()
WHERE id = 'p2' AND version = 1
RETURNING version;
```

```sql check
SELECT id, version, doc->>'startNodeId' AS start FROM projects ORDER BY id;
```
:::

Notice there is no `SELECT` first. "Read the version, compare in C#, then write" has a gap between
the read and the write where another save can slip in. Putting the comparison **inside** the
`UPDATE` makes Postgres do it under the row lock, atomically. That is the entire trick behind
optimistic concurrency, and cap-04 builds the API on it.

What if two such `UPDATE`s hit the same row at the *same instant*? The first one takes the row
lock; the second waits for it. When the first commits, Postgres (at the default `READ COMMITTED`
isolation level) re-checks the second statement's `WHERE` against the **new** row: the version is
now 4, `version = 3` is false, and the second `UPDATE` matches zero rows. No error, no lost write,
just an empty `RETURNING` that the API turns into a 409.

## A queue in a table: `FOR UPDATE SKIP LOCKED`

Several worker processes poll the `jobs` table. Each must grab a **different** job, and a job whose
worker crashed must eventually be picked up again. The pattern:

```sql
WITH next AS (
  SELECT id FROM jobs
  WHERE <eligible>
  ORDER BY run_after, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED        -- lock the row; rows other workers locked are skipped, not waited on
)
UPDATE jobs j
SET status = 'running', attempts = j.attempts + 1, leased_by = @worker, leased_until = now() + interval '30 seconds'
FROM next
WHERE j.id = next.id
RETURNING j.*;
```

Read it in two halves. The CTE (`WITH next AS (…)`) *finds and locks* one eligible row; the outer
`UPDATE … FROM next` *marks it as taken* and returns it. Both happen in one statement, so a job can
never be "found" by a worker that then forgets to mark it.

The locking clause decides what a second worker sees:

| Clause | Worker B, when A already locked the oldest job |
|---|---|
| `FOR UPDATE` | **waits** until A commits, then re-checks that row. A changed it to `running`, so it no longer matches; Postgres drops it and moves on to the next eligible row. B does get a job, but only after waiting, so all workers queue up behind each other one lock at a time. |
| `FOR UPDATE NOWAIT` | **fails** immediately with `could not obtain lock on row`. |
| `FOR UPDATE SKIP LOCKED` | **skips** the locked row and takes the next eligible one. Exactly what competing workers want. |

The **lease** (`leased_until`) is what makes it crash-safe: a `running` job whose lease expired
belongs to a worker that died (or hung), so it is eligible again. A healthy worker on a job that runs
longer than the lease must extend it periodically (a "heartbeat"), or another worker will take it.

:::sql id=cap-02-sql4 db=empty xp=45
title: Claim the next job
Write the claim for worker `'worker-1'`. A job is eligible when it is

* `queued` and due (`run_after <= now()`), **or**
* `running` but its lease expired (`leased_until < now()`): its worker died,

**and** it still has attempts left (`attempts < max_attempts`). Take the one with the oldest
`run_after` (then lowest `id`), mark it `running`, increment `attempts`, set `leased_by` and
`leased_until = now() + interval '30 seconds'`. Finish with `RETURNING id, status, attempts, leased_by`.

hint: Put the eligibility in a CTE: `WITH next AS (SELECT id FROM jobs WHERE … ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED)`.
hint: Parenthesize the OR: `WHERE ((status = 'queued' AND run_after <= now()) OR (status = 'running' AND leased_until < now())) AND attempts < max_attempts`.
hint: Then `UPDATE jobs j SET … FROM next WHERE j.id = next.id RETURNING j.id, j.status, j.attempts, j.leased_by`.

```sql setup
CREATE TABLE jobs (
  id bigint PRIMARY KEY, kind text NOT NULL, project_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
  run_after timestamptz NOT NULL, leased_until timestamptz, leased_by text);
INSERT INTO jobs VALUES
  (1, 'publish', 'p1', 'queued',    0, 5, now() + interval '1 hour',     NULL, NULL),
  (2, 'publish', 'p2', 'queued',    0, 5, now() - interval '5 minutes',  NULL, NULL),
  (3, 'publish', 'p3', 'running',   1, 5, now() - interval '10 minutes', now() - interval '1 minute',  'worker-dead'),
  (4, 'publish', 'p4', 'running',   1, 5, now() - interval '20 minutes', now() + interval '5 minutes', 'worker-busy'),
  (5, 'publish', 'p1', 'succeeded', 1, 5, now() - interval '30 minutes', NULL, NULL),
  (6, 'publish', 'p2', 'running',   5, 5, now() - interval '1 hour',     now() - interval '2 minutes', 'worker-dead');
```

```sql starter
-- Claim ONE job for worker-1
SELECT id FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1;
```

```sql solution
WITH next AS (
  SELECT id FROM jobs
  WHERE ((status = 'queued' AND run_after <= now())
      OR (status = 'running' AND leased_until < now()))
    AND attempts < max_attempts
  ORDER BY run_after, id
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs j
SET status = 'running',
    attempts = j.attempts + 1,
    leased_by = 'worker-1',
    leased_until = now() + interval '30 seconds'
FROM next
WHERE j.id = next.id
RETURNING j.id, j.status, j.attempts, j.leased_by;
```
:::

Job 6 is the interesting one: its lease expired, but it already used all five attempts. Claiming it
again would retry forever; cap-08's worker moves such jobs to `failed` instead. The composite index
`(status, run_after)` from `JobConfig` is what keeps this query cheap when the table holds
millions of finished jobs.

:::quiz id=cap-02-q3 xp=15
Two workers run the claim query at the same instant and both would pick job 3. What happens with
`FOR UPDATE SKIP LOCKED`?
- [ ] Both get job 3; the second `UPDATE` fails with a serialization error
- [ ] Worker B blocks until worker A commits, then also receives job 3
- [x] Worker A locks job 3; worker B skips the locked row and claims the next eligible job (or nothing)
- [ ] Postgres raises `could not obtain lock` for worker B
> `SKIP LOCKED` turns lock contention into "pick something else". The tempting "B blocks, then also gets job 3" describes plain `FOR UPDATE`, and even that is only half right: B does block, but after A commits B re-checks job 3, sees it is now `running` with a fresh lease, drops it and takes the next eligible job instead. So B never gets job 3, but it had to wait in line, and so does every other worker. `NOWAIT` is the option that raises `could not obtain lock`, and a serialization error only appears at `REPEATABLE READ` or `SERIALIZABLE`. Skipping is exactly what a pool of competing consumers wants.
:::

:::quiz id=cap-02-q4 xp=15
`Version` is configured with `IsConcurrencyToken()`. Two API requests each **load** project `p1`
(version 3) with a tracking query, change `Doc`, set `Version = 4` and call `SaveChangesAsync()`.
What happens to the second request?
- [ ] It succeeds and overwrites the first save, because EF only checks the primary key
- [x] Its `UPDATE … WHERE id = @id AND version = 3` matches zero rows, and EF throws `DbUpdateConcurrencyException`
- [ ] EF merges both documents because the `StoryDoc` comparer detects the difference
- [ ] It blocks until the first request's `DbContext` is disposed
> A concurrency token makes EF add the *original* value to the `WHERE`. The first save moves the row to version 4, so the second save's `WHERE version = 3` affects 0 rows, and EF treats "0 rows affected" as a conflict and throws. Your code catches that and returns 409. Without `IsConcurrencyToken()` the first option would be exactly what happens: last write wins. The comparer only decides *whether* `Doc` changed; it never merges anything. And remember EF does not bump `Version` for you: if you forget `Version = 4`, every save keeps version 3 and conflicts are never detected.
:::

:::quiz id=cap-02-q5 xp=15
**What happens if…** a teammate "simplifies" the claim's `WHERE` to just
`status = 'queued' AND run_after <= now()` (dropping the expired-lease branch)?
- [ ] Nothing changes, because a worker that crashes resets its job to `queued` on the way down
- [ ] Two workers would start claiming the same job
- [x] Jobs whose worker crashed mid-run stay `running` forever, and those publishes never finish
- [ ] Postgres refuses `SKIP LOCKED` without a lease column in the `WHERE`
> A crashed process runs no cleanup code: the power goes, the pod is killed, the row stays `running`. The expired-lease branch is the *only* thing that ever gives such a job a second chance. Double claiming is not the risk here, since `SKIP LOCKED` plus the status change still keep workers apart; the risk is a job that nobody will ever pick up again.
:::

:::warn title="Two traps with EF Core + Npgsql"
`EnableRetryOnFailure()` looks harmless, but with it every user-initiated transaction must run
inside `db.Database.CreateExecutionStrategy()`. The worker in cap-08 uses explicit transactions, so
we leave retries off. And `DateTimeOffset` values must be **UTC** (`DateTimeOffset.UtcNow`): Npgsql
refuses non-zero offsets for `timestamptz`.
:::

:::cards id=cap-02-cards1 xp=15 title="BranchStory data model"
Q: Why is the story graph a single jsonb column?
A: The editor loads and saves the whole graph; one row + one version makes a save atomic and conflict-detectable with a single UPDATE.
Q: What is the concurrency token, and who increments it?
A: `projects.version` (int). Only a successful save increments it, inside the guarded UPDATE.
Q: Why is the owner `projects.owner_id` rather than a member row?
A: Exactly one owner, never removable, and every quota is billed to it; a NOT NULL FK enforces that.
Q: What does `SKIP LOCKED` do?
A: Rows locked by another transaction are skipped instead of waited on, so competing workers claim different jobs.
Q: What makes the job queue crash-safe?
A: The lease: `leased_until`. A `running` job with an expired lease is eligible again; `attempts < max_attempts` stops infinite retries.
Q: Why `Guid.CreateVersion7()`?
A: Time-ordered UUIDs: generated in the app, not guessable counters, but they insert at the end of the index like a sequence.
Q: Why a value comparer on `StoryDoc`?
A: EF's default snapshot of a class is the same reference, so in-place edits to `Nodes`/`Edges` go unnoticed. The comparer deep-copies the snapshot (JSON round trip) and compares serialized JSON, so real changes are detected.
Q: What does `IsConcurrencyToken()` do, and what doesn't it do?
A: EF adds `WHERE version = @original` to tracked updates and throws `DbUpdateConcurrencyException` on 0 rows. It does not increment the version; your save code must.
Q: `FOR UPDATE` vs `NOWAIT` vs `SKIP LOCKED`?
A: Wait for the lock, then re-check the row (no double claim, but workers queue up) · fail immediately · skip locked rows and take the next one.
:::

## Recap

- Five tables: `users`, `projects` (jsonb `doc` + `version`), `project_members`, `jobs`, `published_stories`.
- The owner is a column; members are seats; quotas will be read from the owner's `plan`.
- `UPDATE … WHERE id = @id AND version = @expected` is the whole optimistic-concurrency mechanism.
- `FOR UPDATE SKIP LOCKED` + a lease + an attempt limit turns a table into a safe multi-worker queue.
- EF Core: Fluent configuration per entity, snake_case naming, a jsonb value converter + comparer, `CHECK` constraints, and a design-time factory so `dotnet ef` doesn't boot the host.
