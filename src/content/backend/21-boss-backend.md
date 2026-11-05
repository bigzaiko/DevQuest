---
id: be-21
title: "Boss Fight: The Projects API"
level: expert
minutes: 180
xp: 400
summary: Build a production-shaped Projects API end to end — OIDC auth, owner/editor/viewer sharing, versioned saves with 409, owner-billed quotas, a crash-safe SKIP LOCKED job worker, live/ready health checks and 22 integration tests on real Postgres 18.
---

This is the backend boss fight. No new concepts: everything here appeared in lessons be-11 to
be-20. The challenge is putting them together so they hold up against concurrency, crashes and
malicious users, and proving it with tests. The **45 minutes** cover reading and the boss-phase
quizzes. The three labs are a project of their own: budget **3–5 hours**, and split them over
several sessions if you like.

You're building the backend of a small collaborative SaaS app. Users create **projects**, share
them with **editors** and **viewers**, and edit **documents** together. Saves are **versioned**,
so nobody silently overwrites anyone else. Documents count against the **project owner's**
quota. A **background worker** computes derived data and survives being killed mid-job.

```text
              ┌────────────── Keycloak / Entra ID (OIDC) ───────────────┐
              │ issues JWT access tokens (sub, aud=projects-api)         │
              └──────────────────────────────────────────────────────────┘
                                    │ Bearer token
   React SPA ──── HTTPS ────► Projects.Api (N replicas)
                                │  /projects, /projects/{id}/members, /projects/{id}/documents
                                │  /health/live  /health/ready
                                │
                                │  same transaction: UPDATE documents … + INSERT INTO jobs
                                ▼
                          PostgreSQL 18  ◄──── JobWorker (BackgroundService in every replica)
                          projects, project_members,      claim: UPDATE … FOR UPDATE SKIP LOCKED
                          documents, owner_usage, jobs     lease: locked_by + locked_until
```

## The contract

| Endpoint | Who | Success | Failure modes |
|---|---|---|---|
| `POST /projects` | any signed-in user | `201` + `{ id, name, ownerId, myRole: "Owner" }` | `400` validation, `401` |
| `GET /projects` | signed-in user | `200`, only projects where you're a member | `401` |
| `GET /projects/{id}` | member | `200` with your role | `404` for non-members (don't reveal that it exists) |
| `PUT /projects/{id}/members/{userId}` | owner | `204` `{ role: "Editor" \| "Viewer" }` | `403` for non-owner members, `400` for granting `Owner` |
| `GET /projects/{id}/members` | member | `200` list | `404` |
| `POST /projects/{id}/documents` | editor, owner | `201` document, version 1 | `403` + problem type `owner-quota-exceeded` when the **owner's** quota is used up |
| `GET /projects/{id}/documents/{docId}` | viewer+ | `200` `{ …, version, wordCount }` | `404` |
| `PUT /projects/{id}/documents/{docId}` | editor, owner | `200` `{ id, version }` `{ content, baseVersion }` | `409` + `currentVersion` when `baseVersion` is stale, `403` for viewers |
| `GET /health/live`, `GET /health/ready` | anonymous | `200` | `/ready` → `503` when Postgres is unreachable; `/live` stays `200` |

Non-functional requirements, each covered by a test:

- **No lost updates.** Ten concurrent saves of version 1 → exactly one `200`, nine `409`.
- **The quota holds under concurrency.** Ten parallel creates with three slots left → exactly three documents.
- **Exactly-once claiming.** Competing workers never claim the same job.
- **Crash safety.** A job whose worker died is re-run after its lease expires. A worker that lost its lease can't overwrite the job's state.
- **Retries and dead letters.** A failing job is retried with backoff, then marked `dead` with its last error.
- **The schema is migrated.** The real EF Core migrations run against Postgres 18, and a test fails if a model change is missing a migration.

## Boss phase 1: architecture decisions

Before writing any code, check your instincts. These are the decisions this codebase makes.

:::quiz id=be-21-q1 xp=20
The API sets a **fallback authorization policy** (`RequireAuthenticatedUser`), so every endpoint
requires a signed-in user unless it opts out. After you deploy, Kubernetes never routes traffic to
the new pods, and their readiness probe reports `401`. What's the right fix?

- [ ] Remove the fallback policy and add `.RequireAuthorization()` to each endpoint instead
- [x] Mark the health endpoints `.AllowAnonymous()`. Probes don't carry tokens, and health endpoints should expose no sensitive detail.
- [ ] Give the kubelet a service-account JWT for the probe
- [ ] Move health checks to a separate port without authentication middleware
> The fallback policy is the right default: a forgotten `RequireAuthorization()` on a new endpoint can't become a data leak, so removing it trades one small fix for a permanent risk. The few public endpoints opt out explicitly with `AllowAnonymous()`. A probe *can* send static headers, but a long-lived token pasted into a manifest is a secret you now have to rotate, and it expires. (A separate management port can also work, but it doesn't remove the need for anonymous access. The fallback policy applies to every endpoint on every port.)
:::

:::quiz id=be-21-q2 xp=20
All integration tests pass. In staging, with real Keycloak tokens, every request fails with
`InvalidOperationException: No 'sub' claim.` from `user.UserId()`. The token clearly contains
`"sub": "a1b2..."`. What's the cause?

- [ ] Keycloak puts the user id in `preferred_username`, not `sub`
- [x] `JwtBearer` maps inbound claim types by default, so `sub` becomes `ClaimTypes.NameIdentifier`. The fix is `MapInboundClaims = false`. The tests passed because the test auth handler creates a `sub` claim directly.
- [ ] The token's audience is wrong, so the claims are stripped
- [ ] `FindFirstValue` only reads the first claim of a token
> This is a classic test/production gap: the test scheme bypasses the JWT handler's claim mapping. Setting `MapInboundClaims = false` keeps OIDC claim names as they appear in the token. If the audience were wrong you would get a `401`, not a missing claim. Keycloak does put the stable user id in `sub`; `preferred_username` is a display name that users can change, so it's the wrong key anyway. Lesson be-13 covers this.
:::

:::quiz id=be-21-q3 xp=20
A non-member requests `GET /projects/{id}` for a project that exists. Why does the API return
`404` rather than `403`, while an *editor* who tries to change members gets `403`?

- [x] A `403` would confirm to a stranger that the project id exists (an enumeration leak). Members already know it exists, so for them `403` is honest and more helpful.
- [ ] `403` is reserved for invalid tokens
- [ ] ASP.NET Core can't return `403` from minimal APIs
- [ ] `404` is cached by browsers, so it reduces load
> Resource-based authorization decides per resource. `Access.Deny` encodes the rule once: no membership → `404`, membership with a role that's too low → `403`. GitHub does the same with private repositories. A missing or invalid token is `401`, not `403`, and minimal APIs return `403` happily (`TypedResults.Forbid()`).
:::

## Lab 1: foundation, auth and sharing

:::lab id=be-21-lab1 xp=150
title: Projects, OIDC-ready auth, owner/editor/viewer sharing, test harness on Postgres 18

**Prerequisites:** .NET 10 SDK and a working Docker (or Podman with `DOCKER_HOST` set, see
lesson be-15). Check with `docker run --rm hello-world`.

**1. Scaffold**

```bash
mkdir -p ~/devquest/be-21-boss && cd ~/devquest/be-21-boss
dotnet new sln -n Projects
dotnet new web -o src/Projects.Api
dotnet new xunit -o tests/Projects.Api.Tests
dotnet sln add src/Projects.Api tests/Projects.Api.Tests
dotnet add tests/Projects.Api.Tests reference src/Projects.Api

dotnet add src/Projects.Api package Npgsql.EntityFrameworkCore.PostgreSQL
dotnet add src/Projects.Api package Microsoft.EntityFrameworkCore.Relational
dotnet add src/Projects.Api package Microsoft.EntityFrameworkCore.Design
dotnet add src/Projects.Api package EFCore.NamingConventions
dotnet add src/Projects.Api package Microsoft.AspNetCore.Authentication.JwtBearer
dotnet add src/Projects.Api package Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore

dotnet add tests/Projects.Api.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet add tests/Projects.Api.Tests package Testcontainers.PostgreSql
dotnet add tests/Projects.Api.Tests package Respawn
dotnet add tests/Projects.Api.Tests package Shouldly
rm tests/Projects.Api.Tests/UnitTest1.cs

dotnet new tool-manifest
dotnet tool install dotnet-ef
```

Versions this lab was verified with: Npgsql EF Core 10.0.3, EF Core 10.0.14, EFCore.NamingConventions
10.0.1, Testcontainers.PostgreSql 4.16.0, Respawn 7.0.0, Shouldly 4.3.0, xUnit 2.9.3. Adding
`Microsoft.EntityFrameworkCore.Relational` explicitly keeps the API and the test project on the same
EF Core patch version and avoids error CS1705 (lesson be-15 explains why).

**2. The data model.** `UseSnakeCaseNamingConvention()` maps `LockedUntil` to `locked_until`
and so on, so the raw SQL later stays readable. The whole schema, including documents, quota
and jobs, goes in now so that one migration covers it.

`src/Projects.Api/Data.cs`

```csharp
using Microsoft.EntityFrameworkCore;

namespace Projects.Api;

public enum ProjectRole { Viewer, Editor, Owner }

public class Project
{
    public Guid Id { get; set; }
    public string Name { get; set; } = "";
    public string OwnerId { get; set; } = "";
    public int Version { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; set; }
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
    public string Title { get; set; } = "";
    public string Content { get; set; } = "";
    public int Version { get; set; } = 1;
    public int? WordCount { get; set; }              // filled in by a background job
    public DateTimeOffset UpdatedAt { get; set; }
}

/// One row per project OWNER: documents are billed to the owner, whoever creates them.
public class OwnerUsage
{
    public string OwnerId { get; set; } = "";
    public int Documents { get; set; }
}

public class Job
{
    public long Id { get; set; }
    public string Type { get; set; } = "";
    public string Payload { get; set; } = "{}";      // jsonb
    public string Status { get; set; } = "queued";   // queued | running | done | dead
    public int Attempts { get; set; }
    public int MaxAttempts { get; set; } = 5;
    public DateTimeOffset RunAfter { get; set; }
    public DateTimeOffset? LockedUntil { get; set; }
    public string? LockedBy { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();
    public DbSet<Document> Documents => Set<Document>();
    public DbSet<OwnerUsage> OwnerUsage => Set<OwnerUsage>();
    public DbSet<Job> Jobs => Set<Job>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Project>(e =>
        {
            e.Property(p => p.Name).HasMaxLength(80);
            e.Property(p => p.OwnerId).HasMaxLength(64);
            e.HasMany(p => p.Members).WithOne().HasForeignKey(m => m.ProjectId);
        });
        b.Entity<ProjectMember>(e =>
        {
            e.HasKey(m => new { m.ProjectId, m.UserId });
            e.Property(m => m.UserId).HasMaxLength(64);
            e.Property(m => m.Role).HasConversion<string>().HasMaxLength(16);
            e.HasIndex(m => m.UserId);                 // "my projects" lookups
        });
        b.Entity<Document>(e =>
        {
            e.Property(d => d.Title).HasMaxLength(200);
            e.HasOne<Project>().WithMany().HasForeignKey(d => d.ProjectId).OnDelete(DeleteBehavior.Cascade);
        });
        b.Entity<OwnerUsage>(e =>
        {
            e.ToTable("owner_usage");
            e.HasKey(u => u.OwnerId);
            e.Property(u => u.OwnerId).HasMaxLength(64);
        });
        b.Entity<Job>(e =>
        {
            e.Property(j => j.Id).UseIdentityAlwaysColumn();
            e.Property(j => j.Payload).HasColumnType("jsonb");
            e.Property(j => j.Status).HasMaxLength(16).HasDefaultValue("queued");
            e.Property(j => j.MaxAttempts).HasDefaultValue(5);
            e.Property(j => j.RunAfter).HasDefaultValueSql("now()");
            e.Property(j => j.CreatedAt).HasDefaultValueSql("now()");
            e.ToTable(t => t.HasCheckConstraint("ck_jobs_status", "status IN ('queued','running','done','dead')"));
            // Small partial index: only claimable rows, in claim order.
            e.HasIndex(j => new { j.RunAfter, j.Id })
             .HasDatabaseName("ix_jobs_claimable")
             .HasFilter("status IN ('queued','running')");
        });
    }
}
```

**3. Access rules in one place.** Every endpoint asks the same question: *what's my role on
this project?* The enum is ordered `Viewer < Editor < Owner`, so "at least editor" is a
comparison.

`src/Projects.Api/Access.cs`

```csharp
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;

namespace Projects.Api;

public static class Access
{
    /// The stable user id. With MapInboundClaims = false the OIDC "sub" claim keeps its name.
    public static string UserId(this ClaimsPrincipal user) =>
        user.FindFirstValue("sub") ?? throw new InvalidOperationException("No 'sub' claim.");

    /// The caller's role on a project, or null if they are not a member (or it doesn't exist).
    public static Task<ProjectRole?> RoleOnAsync(this AppDbContext db, Guid projectId, string userId,
        CancellationToken ct) =>
        db.ProjectMembers
          .Where(m => m.ProjectId == projectId && m.UserId == userId)
          .Select(m => (ProjectRole?)m.Role)
          .FirstOrDefaultAsync(ct);

    /// Resource-based check → the right status code.
    /// Non-member: 404 (don't leak that the project exists). Member without the role: 403.
    public static IResult? Deny(ProjectRole? actual, ProjectRole required) =>
        actual is null ? TypedResults.NotFound()
        : actual < required ? TypedResults.Forbid()
        : null;
}
```

**4. The project endpoints.** One file per feature, mapped with a route group (lesson be-12).

`src/Projects.Api/ProjectEndpoints.cs`

```csharp
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;

namespace Projects.Api;

public record CreateProjectRequest(string Name);
public record ProjectDto(Guid Id, string Name, string OwnerId, string MyRole);
public record SetMemberRequest(ProjectRole Role);
public record MemberDto(string UserId, string Role);

public static class ProjectEndpoints
{
    public static RouteGroupBuilder MapProjects(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/projects").WithTags("Projects");

        g.MapPost("/", async (CreateProjectRequest req, ClaimsPrincipal user, AppDbContext db,
            TimeProvider time, CancellationToken ct) =>
        {
            var name = req.Name?.Trim() ?? "";
            if (name.Length is < 3 or > 80)
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["name"] = ["Name must be 3-80 characters."]
                });

            var me = user.UserId();
            var project = new Project
            {
                Id = Guid.CreateVersion7(),
                Name = name,
                OwnerId = me,
                CreatedAt = time.GetUtcNow(),
                Members = [new ProjectMember { UserId = me, Role = ProjectRole.Owner }]
            };
            db.Projects.Add(project);
            await db.SaveChangesAsync(ct);
            return Results.Created($"/projects/{project.Id}",
                new ProjectDto(project.Id, project.Name, me, nameof(ProjectRole.Owner)));
        });

        g.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
        {
            var me = user.UserId();
            return await db.ProjectMembers
                .Where(m => m.UserId == me)
                .Join(db.Projects, m => m.ProjectId, p => p.Id, (m, p) => new { p, m.Role })
                .OrderBy(x => x.p.Name)
                .Select(x => new ProjectDto(x.p.Id, x.p.Name, x.p.OwnerId, x.Role.ToString()))
                .ToListAsync(ct);
        });

        g.MapGet("/{id:guid}", async (Guid id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
        {
            var me = user.UserId();
            var dto = await db.ProjectMembers
                .Where(m => m.ProjectId == id && m.UserId == me)
                .Join(db.Projects, m => m.ProjectId, p => p.Id, (m, p) => new { p, m.Role })
                .Select(x => new ProjectDto(x.p.Id, x.p.Name, x.p.OwnerId, x.Role.ToString()))
                .FirstOrDefaultAsync(ct);
            return dto is null ? Results.NotFound() : Results.Ok(dto);
        });

        // Sharing: only the owner may add/change members. The Owner role itself is not grantable.
        g.MapPut("/{id:guid}/members/{userId}", async (Guid id, string userId, SetMemberRequest req,
            ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
        {
            var me = user.UserId();
            if (Access.Deny(await db.RoleOnAsync(id, me, ct), ProjectRole.Owner) is { } denied) return denied;
            if (req.Role == ProjectRole.Owner || userId == me)
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["role"] = ["Ownership cannot be granted or changed here."]
                });

            var member = await db.ProjectMembers.FindAsync([id, userId], ct);
            if (member is null) db.ProjectMembers.Add(new ProjectMember { ProjectId = id, UserId = userId, Role = req.Role });
            else member.Role = req.Role;
            await db.SaveChangesAsync(ct);
            return Results.NoContent();
        });

        g.MapGet("/{id:guid}/members", async (Guid id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
        {
            if (Access.Deny(await db.RoleOnAsync(id, user.UserId(), ct), ProjectRole.Viewer) is { } denied) return denied;
            var members = await db.ProjectMembers.Where(m => m.ProjectId == id)
                .OrderBy(m => m.UserId)
                .Select(m => new MemberDto(m.UserId, m.Role.ToString()))
                .ToListAsync(ct);
            return Results.Ok(members);
        });

        return g;
    }
}
```

**5. Program.cs, version 1.** Replace the generated file:

`src/Projects.Api/Program.cs`

```csharp
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using Projects.Api;

var builder = WebApplication.CreateBuilder(args);

// ── Data ──
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(builder.Configuration.GetConnectionString("Db"))
    .UseSnakeCaseNamingConvention());

// ── Auth: Keycloak (or any OIDC provider) issues the JWTs; we only validate them ──
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = builder.Configuration["Auth:Authority"];   // e.g. http://localhost:8080/realms/devquest
        o.Audience = builder.Configuration["Auth:Audience"];     // e.g. projects-api
        o.MapInboundClaims = false;                              // keep "sub" as "sub"
        o.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
    });
builder.Services.AddAuthorizationBuilder()
    // Secure by default: every endpoint requires a signed-in user unless it opts out.
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

// ── App services ──
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));   // "Editor", not 1
builder.Services.AddSingleton(TimeProvider.System);

var app = builder.Build();

// Dev/test convenience. In production run migrations as a separate deploy step (bundle / job),
// so ten replicas starting at once don't race to migrate the same database.
if (app.Configuration.GetValue<bool>("Database:MigrateOnStartup"))
{
    await using var scope = app.Services.CreateAsyncScope();
    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
}

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseAuthentication();
app.UseAuthorization();

app.MapProjects();

app.Run();
```

`src/Projects.Api/appsettings.json`

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Warning"
    }
  },
  "AllowedHosts": "*",
  "ConnectionStrings": {
    "Db": "Host=localhost;Port=5432;Database=projects;Username=postgres;Password=postgres"
  },
  "Auth": {
    "Authority": "http://localhost:8080/realms/devquest",
    "Audience": "projects-api"
  },
  "Quotas": {
    "DocumentsPerOwner": 100
  },
  "Jobs": {
    "PollInterval": "00:00:01",
    "Lease": "00:00:30"
  }
}
```

`src/Projects.Api/appsettings.Development.json`

```json
{
  "Database": {
    "MigrateOnStartup": true
  }
}
```

**6. Create the migration** (no database needed):

```bash
dotnet ef migrations add Initial --project src/Projects.Api
```

Expected: `Build succeeded.` and `Done. To undo this action, use 'ef migrations remove'`. Open the
generated `Migrations/*_Initial.cs` and find `ix_jobs_claimable` with
`filter: "status IN ('queued','running')"` and the `ck_jobs_status` check constraint.

**7. The test harness.** One Postgres 18 container for the whole run, real migrations, Respawn
before every test, and a header-based test auth scheme instead of Keycloak.

`tests/Projects.Api.Tests/TestAuthHandler.cs`

```csharp
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Projects.Api.Tests;

/// Authenticates requests carrying "X-Test-User: alice" as sub=alice. No header → anonymous.
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Test";
    public const string Header = "X-Test-User";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(Header, out var user) || string.IsNullOrEmpty(user))
            return Task.FromResult(AuthenticateResult.NoResult());

        var identity = new ClaimsIdentity([new Claim("sub", user.ToString())], SchemeName);
        return Task.FromResult(AuthenticateResult.Success(
            new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }
}
```

`tests/Projects.Api.Tests/ApiFactory.cs`

```csharp
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Respawn;
using Testcontainers.PostgreSql;

namespace Projects.Api.Tests;

public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const int QuotaLimit = 3;

    private readonly PostgreSqlContainer _pg = new PostgreSqlBuilder("postgres:18").Build();
    private Respawner? _respawner;

    public string ConnectionString => _pg.GetConnectionString();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Db", ConnectionString);
        builder.UseSetting("Database:MigrateOnStartup", "true");
        builder.UseSetting("Quotas:DocumentsPerOwner", QuotaLimit.ToString());
        // Fast worker for tests.
        builder.UseSetting("Jobs:PollInterval", "00:00:00.050");
        builder.UseSetting("Jobs:BackoffBase", "00:00:00.020");
        builder.UseSetting("Jobs:BackoffCap", "00:00:00.100");

        builder.ConfigureTestServices(services =>
        {
            UseTestAuth(services);
        });
    }

    /// Swap JWT bearer (which needs a real Keycloak) for the header-based test scheme.
    public static void UseTestAuth(IServiceCollection services) =>
        services.AddAuthentication(TestAuthHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, _ => { });

    public async Task InitializeAsync()
    {
        await _pg.StartAsync();
        _ = Server;   // builds + starts the host → runs the migrations

        await using var conn = new NpgsqlConnection(ConnectionString);
        await conn.OpenAsync();
        _respawner = await Respawner.CreateAsync(conn, new RespawnerOptions
        {
            DbAdapter = DbAdapter.Postgres,
            SchemasToInclude = ["public"],
            TablesToIgnore = ["__EFMigrationsHistory"],
        });
    }

    public async Task ResetAsync()
    {
        await using var conn = new NpgsqlConnection(ConnectionString);
        await conn.OpenAsync();
        await _respawner!.ResetAsync(conn);
    }

    public HttpClient ClientFor(string? user)
    {
        var client = CreateClient();
        if (user is not null) client.DefaultRequestHeaders.Add(TestAuthHandler.Header, user);
        return client;
    }

    public async Task<T> WithDb<T>(Func<AppDbContext, Task<T>> work)
    {
        await using var scope = Services.CreateAsyncScope();
        return await work(scope.ServiceProvider.GetRequiredService<AppDbContext>());
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();
        await _pg.DisposeAsync();
    }
}
```

`tests/Projects.Api.Tests/ApiTest.cs`

```csharp
using System.Net.Http.Json;

namespace Projects.Api.Tests;

[CollectionDefinition("api")]
public class ApiCollection : ICollectionFixture<ApiFactory>;

/// Base class: one shared Postgres container, wiped before every test.
[Collection("api")]
public abstract class ApiTest(ApiFactory factory) : IAsyncLifetime
{
    protected ApiFactory Factory { get; } = factory;
    protected HttpClient As(string? user) => Factory.ClientFor(user);

    public Task InitializeAsync() => Factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    protected async Task<Guid> CreateProjectAsync(string owner, string name = "Apollo")
    {
        var res = await As(owner).PostAsJsonAsync("/projects", new { name });
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<ProjectDto>())!.Id;
    }

    protected async Task ShareAsync(Guid projectId, string owner, string user, string role)
    {
        var res = await As(owner).PutAsJsonAsync($"/projects/{projectId}/members/{user}", new { role });
        res.EnsureSuccessStatusCode();
    }
}
```

**8. The first acceptance tests**

`tests/Projects.Api.Tests/ProjectsAndSharingTests.cs`

```csharp
using System.Net;
using System.Net.Http.Json;
using Shouldly;

namespace Projects.Api.Tests;

public class ProjectsAndSharingTests(ApiFactory factory) : ApiTest(factory)
{
    [Fact]
    public async Task Anonymous_requests_get_401()
    {
        var res = await As(null).GetAsync("/projects");
        res.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Creator_becomes_owner_and_sees_the_project()
    {
        var id = await CreateProjectAsync("alice");

        var list = await As("alice").GetFromJsonAsync<List<ProjectDto>>("/projects");

        list.ShouldHaveSingleItem().Id.ShouldBe(id);
        list[0].MyRole.ShouldBe("Owner");
        list[0].OwnerId.ShouldBe("alice");
    }

    [Fact]
    public async Task Invalid_name_is_a_validation_problem()
    {
        var res = await As("alice").PostAsJsonAsync("/projects", new { name = "x" });
        res.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        (await res.Content.ReadAsStringAsync()).ShouldContain("name");
    }

    [Fact]
    public async Task Non_members_get_404_not_403()
    {
        var id = await CreateProjectAsync("alice");
        (await As("mallory").GetAsync($"/projects/{id}")).StatusCode.ShouldBe(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Owner_can_share_and_member_sees_their_role()
    {
        var id = await CreateProjectAsync("alice");
        await ShareAsync(id, "alice", "bob", "Editor");

        var dto = await As("bob").GetFromJsonAsync<ProjectDto>($"/projects/{id}");

        dto!.MyRole.ShouldBe("Editor");
    }

    [Fact]
    public async Task Editors_cannot_share()
    {
        var id = await CreateProjectAsync("alice");
        await ShareAsync(id, "alice", "bob", "Editor");

        var res = await As("bob").PutAsJsonAsync($"/projects/{id}/members/carol", new { role = "Viewer" });

        res.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Ownership_cannot_be_granted()
    {
        var id = await CreateProjectAsync("alice");
        var res = await As("alice").PutAsJsonAsync($"/projects/{id}/members/bob", new { role = "Owner" });
        res.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
    }
}
```

```bash
dotnet test
```

Expected (the first run also pulls `postgres:18`):

```text
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7
```

:::tip title="Running against real Keycloak"
The tests replace JWT bearer, but the production path is real. Start Keycloak and create a realm
`devquest` with a client whose tokens carry `aud: projects-api`, as in lesson be-13. Then run
`docker run -d --name projects-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=projects -p 5432:5432 postgres:18`
and `dotnet run --project src/Projects.Api`. Startup applies the migration (Development only), and
`curl -H "Authorization: Bearer $TOKEN" http://localhost:<port>/projects` works with a real token.
:::

- [ ] `dotnet ef migrations add Initial` created the migration with the partial index and the check constraint
- [ ] `dotnet test` shows 7 passing tests against a real Postgres 18 container
- [ ] I can explain why a non-member gets `404` but an editor gets `403` on the members endpoint
- [ ] I can explain what `MapInboundClaims = false` changes and why the tests wouldn't notice it missing
:::

## Boss phase 2: concurrency and money

:::quiz id=be-21-q4 xp=20
A teammate proposes this simpler save. Which statements about it are true? (Select all that apply.)

```csharp
var doc = await db.Documents.FirstAsync(d => d.Id == docId, ct);
if (doc.Version != req.BaseVersion)
    return Results.Conflict(new { currentVersion = doc.Version });
doc.Content = req.Content;
doc.Version++;
await db.SaveChangesAsync(ct);
```

- [x] It's check-then-act. Two requests can both read version 1, both pass the `if`, and both save. The second silently overwrites the first, which is exactly the lost update it was meant to prevent.
- [x] Without a concurrency token on `Version`, EF's `UPDATE` has only `WHERE id = @id`, so the database can't catch the race either
- [ ] `SaveChangesAsync` always runs in a serializable transaction, so it's actually safe
- [x] Marking `Version` as a concurrency token (`IsConcurrencyToken()`) would fix the race. EF then throws `DbUpdateConcurrencyException`, which you map to `409`.
> The version check must happen **in the database, atomically with the write**: either `UPDATE … WHERE version = @base` (what `ExecuteUpdateAsync` does here) or an EF concurrency token, which adds the same predicate. The default isolation level in Postgres is READ COMMITTED, not serializable. Lesson be-18 covers both styles.
:::

:::quiz id=be-21-q5 xp=25
Two `PUT`s with `baseVersion = 1` reach Postgres at the same moment. Both run
`UPDATE documents SET …, version = 2 WHERE id = @id AND version = 1` under READ COMMITTED.
What exactly happens?

- [ ] Both succeed, because each transaction sees its own snapshot in which `version = 1`
- [ ] One fails with a serialization error, which the API surfaces as `500`
- [x] The second `UPDATE` blocks on the row lock held by the first. When the first commits, Postgres re-checks the `WHERE` against the **new** row version (`version = 2`), finds no match and updates 0 rows. The API turns that into `409`.
- [ ] Postgres merges the two updates
> This re-check of the updated row ("EvalPlanQual") is what makes the conditional `UPDATE` race-free without SERIALIZABLE. The first option describes snapshot reads, but an `UPDATE` waits for the row lock and then looks at the *latest committed* row, not its snapshot. Serialization errors (`40001`) only happen under REPEATABLE READ or SERIALIZABLE, not under the default READ COMMITTED. The test `Concurrent_saves_of_the_same_version_have_exactly_one_winner` proves it: exactly 1 × `200` and 9 × `409`.
:::

:::sql id=be-21-sql1 db=studio xp=30
title: Versioned save, in SQL
Project 1 ("The Heist") is at `version = 14`. Two editors loaded version 14. Mara saves first
(sets `fps` to `60`), then Jonas saves his stale copy (sets `fps` to `24`). Each save is one
`UPDATE` that also increments `version`.

Write **both** `UPDATE` statements so that Mara's save applies and Jonas's stale save changes nothing.
The checker then looks at project 1's `version` and `fps`.

hint: A save may only apply `WHERE id = 1 AND version = 14`, the version the client loaded.
hint: `doc = jsonb_set(doc, '{fps}', '60')`

```sql starter
UPDATE projects SET doc = jsonb_set(doc, '{fps}', '60'), version = version + 1 WHERE id = 1;
UPDATE projects SET doc = jsonb_set(doc, '{fps}', '24'), version = version + 1 WHERE id = 1;
```

```sql solution
UPDATE projects SET doc = jsonb_set(doc, '{fps}', '60'), version = version + 1 WHERE id = 1 AND version = 14;
UPDATE projects SET doc = jsonb_set(doc, '{fps}', '24'), version = version + 1 WHERE id = 1 AND version = 14;
```

```sql check
SELECT version, doc->>'fps' AS fps FROM projects WHERE id = 1;
```
:::

:::quiz id=be-21-q6 xp=20
The owner's quota is enforced with this one statement. Why is it safe under concurrency when
"`SELECT documents` → `if (documents < limit)` → `UPDATE … + 1`" is not? (Select all that apply.)

```sql
INSERT INTO owner_usage (owner_id, documents) VALUES (@owner, 1)
ON CONFLICT (owner_id) DO UPDATE SET documents = owner_usage.documents + 1
 WHERE owner_usage.documents < @limit
RETURNING documents;
```

- [x] The check and the increment happen in one statement. Concurrent requests serialize on the owner's row lock, and each one re-checks `documents < @limit` against the committed value.
- [x] Zero returned rows means "over quota", so there's no window between reading the count and writing it
- [x] The read-then-write version lets 10 parallel requests all read a count below the limit and all insert, ending far above 3 (the lab's "break it" step shows up to 10 of 3)
- [ ] It's safe because `ON CONFLICT` runs at SERIALIZABLE isolation
> Atomic conditional updates are the cheapest form of pessimistic concurrency: the row lock is held only until the request's transaction commits, a few milliseconds here. `ON CONFLICT` doesn't change the isolation level; it's safe under READ COMMITTED because of the row lock and re-check. The quota row is keyed by the **owner**, so an editor creating documents in Alice's project spends Alice's quota, which is what owner-billed means.
:::

:::sql id=be-21-sql2 db=studio xp=30
title: Owner-billed: whose credits pay for the render?
Render jobs are billed to the **project owner**, not to whoever clicked "render". For every
project that has a `queued` or `running` render job, return `project_id`, `owner_id` and the
owner's credit `balance` (the sum of `credit_ledger.delta` for that user).

The starter has a classic bug: joining jobs to the ledger fans out the rows, so a project with
two pending jobs has its balance counted twice.

hint: Pick the projects with `EXISTS (SELECT 1 FROM render_jobs …)` instead of joining the jobs.
hint: Compute the balance with a subquery over `credit_ledger` for `p.owner_id`.

```sql starter
SELECT p.id AS project_id, p.owner_id, SUM(l.delta) AS balance
FROM render_jobs j
JOIN projects p ON p.id = j.project_id
JOIN credit_ledger l ON l.user_id = p.owner_id
WHERE j.status IN ('queued', 'running')
GROUP BY p.id, p.owner_id;
```

```sql solution
SELECT p.id AS project_id,
       p.owner_id,
       (SELECT COALESCE(SUM(l.delta), 0) FROM credit_ledger l WHERE l.user_id = p.owner_id) AS balance
FROM projects p
WHERE EXISTS (SELECT 1 FROM render_jobs j
              WHERE j.project_id = p.id AND j.status IN ('queued', 'running'));
```
:::

## Lab 2: versioned documents and owner-billed quotas

:::lab id=be-21-lab2 xp=150
title: Documents with optimistic concurrency (409 + currentVersion) and a race-free owner quota

**1. A first piece of the job queue.** Saves enqueue a job in the same transaction (the worker
comes in lab 3). For now we only need `Enqueue`:

`src/Projects.Api/JobStore.cs`

```csharp
using System.Text.Json;

namespace Projects.Api;

public static class JobTypes
{
    public const string WordCount = "document.wordcount";
}

public record WordCountPayload(Guid DocumentId, int Version);

public static class JobStore
{
    /// Adds a job to the change tracker; it is INSERTed by the caller's SaveChanges (same transaction).
    public static void Enqueue<T>(AppDbContext db, string type, T payload) =>
        db.Jobs.Add(new Job { Type = type, Payload = JsonSerializer.Serialize(payload) });
}
```

**2. The document endpoints.** Read the comments: every guarantee from the contract is one
specific line.

`src/Projects.Api/DocumentEndpoints.cs`

```csharp
using System.Security.Claims;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Projects.Api;

public record CreateDocumentRequest(string Title, string Content);
public record SaveDocumentRequest(string Content, int BaseVersion);
public record DocumentDto(Guid Id, Guid ProjectId, string Title, string Content, int Version, int? WordCount);

public class QuotaOptions
{
    public int DocumentsPerOwner { get; set; } = 100;
}

public static class DocumentEndpoints
{
    public const string QuotaProblemType = "https://devquest.dev/problems/owner-quota-exceeded";
    public const string ConflictProblemType = "https://devquest.dev/problems/version-conflict";

    public static RouteGroupBuilder MapDocuments(this IEndpointRouteBuilder app)
    {
        var g = app.MapGroup("/projects/{projectId:guid}/documents").WithTags("Documents");

        g.MapGet("/{docId:guid}", async (Guid projectId, Guid docId, ClaimsPrincipal user,
            AppDbContext db, CancellationToken ct) =>
        {
            if (Access.Deny(await db.RoleOnAsync(projectId, user.UserId(), ct), ProjectRole.Viewer) is { } denied)
                return denied;
            var dto = await db.Documents.AsNoTracking()
                .Where(d => d.Id == docId && d.ProjectId == projectId)
                .Select(d => new DocumentDto(d.Id, d.ProjectId, d.Title, d.Content, d.Version, d.WordCount))
                .FirstOrDefaultAsync(ct);
            return dto is null ? Results.NotFound() : Results.Ok(dto);
        });

        // Create: editors and owners. The document is billed to the project OWNER's quota.
        g.MapPost("/", async (Guid projectId, CreateDocumentRequest req, ClaimsPrincipal user,
            AppDbContext db, IOptions<QuotaOptions> quota, TimeProvider time, CancellationToken ct) =>
        {
            if (Access.Deny(await db.RoleOnAsync(projectId, user.UserId(), ct), ProjectRole.Editor) is { } denied)
                return denied;
            if (string.IsNullOrWhiteSpace(req.Title))
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["title"] = ["Title is required."] });

            var ownerId = await db.Projects.Where(p => p.Id == projectId).Select(p => p.OwnerId).FirstAsync(ct);
            var limit = quota.Value.DocumentsPerOwner;

            await using var tx = await db.Database.BeginTransactionAsync(ct);

            // Atomic "increment if below limit". Concurrent requests serialize on the owner's row,
            // so 10 parallel creates with 3 slots left produce exactly 3 successes. No row = over quota.
            var used = await db.Database.SqlQuery<int>($"""
                INSERT INTO owner_usage (owner_id, documents) VALUES ({ownerId}, 1)
                ON CONFLICT (owner_id) DO UPDATE SET documents = owner_usage.documents + 1
                 WHERE owner_usage.documents < {limit}
                RETURNING documents AS "Value"
                """).ToListAsync(ct);
            if (used.Count == 0)
                return Results.Problem(
                    statusCode: StatusCodes.Status403Forbidden,
                    type: QuotaProblemType,
                    title: "The project owner's document quota is used up.",
                    extensions: new Dictionary<string, object?> { ["limit"] = limit });

            var doc = new Document
            {
                Id = Guid.CreateVersion7(),
                ProjectId = projectId,
                Title = req.Title.Trim(),
                Content = req.Content ?? "",
                UpdatedAt = time.GetUtcNow(),
            };
            db.Documents.Add(doc);
            JobStore.Enqueue(db, JobTypes.WordCount, new WordCountPayload(doc.Id, doc.Version));
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);

            return Results.Created($"/projects/{projectId}/documents/{doc.Id}",
                new DocumentDto(doc.Id, projectId, doc.Title, doc.Content, doc.Version, null));
        });

        // Versioned save: succeeds only if the client edited the CURRENT version.
        g.MapPut("/{docId:guid}", async (Guid projectId, Guid docId, SaveDocumentRequest req,
            ClaimsPrincipal user, AppDbContext db, TimeProvider time, CancellationToken ct) =>
        {
            if (Access.Deny(await db.RoleOnAsync(projectId, user.UserId(), ct), ProjectRole.Editor) is { } denied)
                return denied;

            var newVersion = req.BaseVersion + 1;
            var now = time.GetUtcNow();

            await using var tx = await db.Database.BeginTransactionAsync(ct);

            // UPDATE documents SET ... WHERE id = @docId AND project_id = @projectId AND version = @baseVersion
            var updated = await db.Documents
                .Where(d => d.Id == docId && d.ProjectId == projectId && d.Version == req.BaseVersion)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(d => d.Content, req.Content)
                    .SetProperty(d => d.Version, newVersion)
                    .SetProperty(d => d.WordCount, (int?)null)
                    .SetProperty(d => d.UpdatedAt, now), ct);

            if (updated == 0)
            {
                var current = await db.Documents
                    .Where(d => d.Id == docId && d.ProjectId == projectId)
                    .Select(d => (int?)d.Version)
                    .FirstOrDefaultAsync(ct);
                if (current is null) return Results.NotFound();

                return Results.Problem(
                    statusCode: StatusCodes.Status409Conflict,
                    type: ConflictProblemType,
                    title: "The document was changed by someone else.",
                    detail: $"You edited version {req.BaseVersion}, but the current version is {current}.",
                    extensions: new Dictionary<string, object?> { ["currentVersion"] = current });
            }

            // Same transaction as the save: the job exists if and only if the save committed.
            JobStore.Enqueue(db, JobTypes.WordCount, new WordCountPayload(docId, newVersion));
            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);

            return Results.Ok(new { id = docId, version = newVersion });
        });

        return g;
    }
}
```

**3. Wire it up.** In `Program.cs`, add the quota options below the `TimeProvider` line and map
the endpoints below `app.MapProjects();`:

```csharp
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.Configure<QuotaOptions>(builder.Configuration.GetSection("Quotas"));   // ← new
```

```csharp
app.MapProjects();
app.MapDocuments();   // ← new
```

**4. More test helpers.** Replace `tests/Projects.Api.Tests/ApiTest.cs` with this version, which
adds `CreateDocAsync` and `Eventually`:

`tests/Projects.Api.Tests/ApiTest.cs`

```csharp
using System.Net.Http.Json;

namespace Projects.Api.Tests;

[CollectionDefinition("api")]
public class ApiCollection : ICollectionFixture<ApiFactory>;

/// Base class: one shared Postgres container, wiped before every test.
[Collection("api")]
public abstract class ApiTest(ApiFactory factory) : IAsyncLifetime
{
    protected ApiFactory Factory { get; } = factory;
    protected HttpClient As(string? user) => Factory.ClientFor(user);

    public Task InitializeAsync() => Factory.ResetAsync();
    public Task DisposeAsync() => Task.CompletedTask;

    protected async Task<Guid> CreateProjectAsync(string owner, string name = "Apollo")
    {
        var res = await As(owner).PostAsJsonAsync("/projects", new { name });
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<ProjectDto>())!.Id;
    }

    protected async Task ShareAsync(Guid projectId, string owner, string user, string role)
    {
        var res = await As(owner).PutAsJsonAsync($"/projects/{projectId}/members/{user}", new { role });
        res.EnsureSuccessStatusCode();
    }

    protected async Task<DocumentDto> CreateDocAsync(Guid projectId, string user, string content = "hello world")
    {
        var res = await As(user).PostAsJsonAsync($"/projects/{projectId}/documents", new { title = "Spec", content });
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<DocumentDto>())!;
    }

    /// Polls until the condition holds (background work is asynchronous by nature).
    /// Measures real elapsed time with a monotonic Stopwatch: we're waiting for a real worker,
    /// not testing time-based logic, so TimeProvider doesn't apply here.
    protected static async Task Eventually(Func<Task<bool>> condition, int timeoutMs = 10_000)
    {
        var elapsed = System.Diagnostics.Stopwatch.StartNew();
        while (elapsed.ElapsedMilliseconds < timeoutMs)
        {
            if (await condition()) return;
            await Task.Delay(50);
        }
        throw new TimeoutException("Condition was not met in time.");
    }
}
```

**5. The acceptance tests**

`tests/Projects.Api.Tests/DocumentTests.cs`

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Shouldly;

namespace Projects.Api.Tests;

public class DocumentTests(ApiFactory factory) : ApiTest(factory)
{
    [Fact]
    public async Task Viewer_can_read_but_not_save()
    {
        var id = await CreateProjectAsync("alice");
        await ShareAsync(id, "alice", "vera", "Viewer");
        var doc = await CreateDocAsync(id, "alice");

        (await As("vera").GetAsync($"/projects/{id}/documents/{doc.Id}")).StatusCode.ShouldBe(HttpStatusCode.OK);
        var save = await As("vera").PutAsJsonAsync($"/projects/{id}/documents/{doc.Id}",
            new { content = "hacked", baseVersion = 1 });
        save.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Save_with_current_version_bumps_the_version()
    {
        var id = await CreateProjectAsync("alice");
        var doc = await CreateDocAsync(id, "alice");

        var res = await As("alice").PutAsJsonAsync($"/projects/{id}/documents/{doc.Id}",
            new { content = "v2 text", baseVersion = 1 });

        res.StatusCode.ShouldBe(HttpStatusCode.OK);
        var after = await As("alice").GetFromJsonAsync<DocumentDto>($"/projects/{id}/documents/{doc.Id}");
        after!.Version.ShouldBe(2);
        after.Content.ShouldBe("v2 text");
    }

    [Fact]
    public async Task Stale_save_gets_409_with_the_current_version()
    {
        var id = await CreateProjectAsync("alice");
        await ShareAsync(id, "alice", "bob", "Editor");
        var doc = await CreateDocAsync(id, "alice");
        (await As("alice").PutAsJsonAsync($"/projects/{id}/documents/{doc.Id}",
            new { content = "alice wins", baseVersion = 1 })).EnsureSuccessStatusCode();

        // Bob still has version 1 open in his editor.
        var res = await As("bob").PutAsJsonAsync($"/projects/{id}/documents/{doc.Id}",
            new { content = "bob overwrites", baseVersion = 1 });

        res.StatusCode.ShouldBe(HttpStatusCode.Conflict);
        res.Content.Headers.ContentType!.MediaType.ShouldBe("application/problem+json");
        var problem = await res.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("currentVersion").GetInt32().ShouldBe(2);
        problem.GetProperty("type").GetString().ShouldBe(DocumentEndpoints.ConflictProblemType);

        var stored = await As("alice").GetFromJsonAsync<DocumentDto>($"/projects/{id}/documents/{doc.Id}");
        stored!.Content.ShouldBe("alice wins");   // no lost update
    }

    [Fact]
    public async Task Concurrent_saves_of_the_same_version_have_exactly_one_winner()
    {
        var id = await CreateProjectAsync("alice");
        var doc = await CreateDocAsync(id, "alice");

        var saves = Enumerable.Range(0, 10).Select(i =>
            As("alice").PutAsJsonAsync($"/projects/{id}/documents/{doc.Id}",
                new { content = $"edit {i}", baseVersion = 1 }));
        var results = await Task.WhenAll(saves);

        results.Count(r => r.StatusCode == HttpStatusCode.OK).ShouldBe(1);
        results.Count(r => r.StatusCode == HttpStatusCode.Conflict).ShouldBe(9);
    }

    [Fact]
    public async Task Documents_are_billed_to_the_project_owner()
    {
        // Alice owns the project; Bob (editor) creates the documents — they count against ALICE.
        var id = await CreateProjectAsync("alice");
        await ShareAsync(id, "alice", "bob", "Editor");
        for (var i = 0; i < ApiFactory.QuotaLimit; i++) await CreateDocAsync(id, "bob");

        var res = await As("bob").PostAsJsonAsync($"/projects/{id}/documents", new { title = "One more", content = "" });

        res.StatusCode.ShouldBe(HttpStatusCode.Forbidden);
        var problem = await res.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("type").GetString().ShouldBe(DocumentEndpoints.QuotaProblemType);

        // Bob's OWN project is unaffected: his quota is untouched.
        var bobs = await CreateProjectAsync("bob", "Bob's");
        (await As("bob").PostAsJsonAsync($"/projects/{bobs}/documents", new { title = "Mine", content = "" }))
            .StatusCode.ShouldBe(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Quota_holds_under_concurrency()
    {
        var id = await CreateProjectAsync("alice");

        var creates = Enumerable.Range(0, 10).Select(i =>
            As("alice").PostAsJsonAsync($"/projects/{id}/documents", new { title = $"Doc {i}", content = "" }));
        var results = await Task.WhenAll(creates);

        results.Count(r => r.StatusCode == HttpStatusCode.Created).ShouldBe(ApiFactory.QuotaLimit);
        var stored = await Factory.WithDb(db => Task.FromResult(db.Documents.Count(d => d.ProjectId == id)));
        stored.ShouldBe(ApiFactory.QuotaLimit);
    }
}
```

```bash
dotnet test
```

```text
Passed!  - Failed:     0, Passed:    13, Skipped:     0, Total:    13
```

**6. Break it on purpose** (undo after each step):

1. In the save endpoint, delete `&& d.Version == req.BaseVersion` from the `Where`.
   `Stale_save_gets_409_with_the_current_version` and
   `Concurrent_saves_of_the_same_version_have_exactly_one_winner` fail. That's the lost update, caught.
2. Replace the atomic quota statement with a read-then-write: query
   `db.OwnerUsage.Where(u => u.OwnerId == ownerId).Select(u => u.Documents).FirstOrDefaultAsync(ct)`,
   return the 403 if it's `>= limit`, and remove the `WHERE owner_usage.documents < {limit}` line.
   `Documents_are_billed_to_the_project_owner` still passes (it runs sequentially), but
   `Quota_holds_under_concurrency` fails. Only the concurrent test catches the race.

:::warn title="Why 403 for the quota, not 409 or 429?"
`409` means "your request conflicts with the resource's state, re-read and retry", which retrying
won't fix here. `429` means "slow down", but waiting won't help either. The request is refused
for a business reason, so `403` with a specific problem `type`
(`…/owner-quota-exceeded`) and the `limit` lets the UI say *"Ask the project owner to upgrade"*.
Some APIs use `402 Payment Required`. Whatever you choose, **document the problem type**, because
clients switch on `type`, not on `title`.
:::

- [ ] `dotnet test` shows 13 passing tests
- [ ] A stale save returns `409` with `application/problem+json` and `currentVersion`
- [ ] Removing the version predicate made the two concurrency tests fail
- [ ] The read-then-write quota passed the sequential test but failed the concurrent one, and I can explain why
:::

## Boss phase 3: the job worker

:::quiz id=be-21-q7 xp=20
Why does `DocumentEndpoints` insert the job **in the same transaction** as the document update,
instead of enqueueing it after `CommitAsync` (or publishing to Redis)?

- [ ] Inserting two rows in one transaction is faster
- [x] Atomicity: the job exists exactly when the save committed. Enqueueing after commit loses the job if the process dies in between. Enqueueing before commit (or to another system) can create a job for a save that then rolls back.
- [ ] Postgres requires jobs to be inserted in a transaction
- [ ] The `jobs` table has a foreign key to `documents`
> This is the main advantage of a Postgres-backed queue: business change and message commit together. Speed isn't the reason (it's about the same either way), Postgres doesn't care whether an insert is in an explicit transaction, and the `jobs` table has no foreign key at all: the payload is plain `jsonb`. With an external broker you need the **transactional outbox** pattern (write the message to an outbox table in the same transaction, then relay it) to get the same guarantee.
:::

:::quiz id=be-21-q8 xp=25
Worker A claims job 7 with a 30-second lease and starts the handler. Then its pod is OOM-killed.
What happens next, and what does the system require of the handler?

- [ ] The job is lost. The transaction that claimed it was rolled back when the pod died.
- [ ] Postgres releases the `FOR UPDATE` lock, and job 7 is immediately queued again
- [x] The claim committed long ago, so job 7 stays `running` with `locked_until` in the past. Once that time has passed, another worker's claim matches `status = 'running' AND locked_until < now()`, re-runs it, and `attempts` becomes 2. Handlers must be **idempotent**, because at-least-once delivery means they can run twice.
- [ ] Job 7 is moved to `dead` because the worker crashed
> The row lock exists only during the short claim statement, so there's no lock left to release when the pod dies, and nothing "rolls back" a claim that committed long ago. Ownership after that is the **lease** (`locked_by`, `locked_until`). Nothing marks the job `dead` on a crash either: only `FailAsync` does that, once `attempts` reaches `max_attempts`. `WordCountHandler` is idempotent: it computes the count for one specific `version` and writes it only where that version still matches, so running it twice changes nothing. The test `A_job_left_running_by_a_crashed_worker_is_reclaimed_after_its_lease` simulates exactly this.
:::

:::quiz id=be-21-q9 xp=25
Worker A stalls in a 45-second GC pause while holding a 30-second lease on job 9. Worker B
reclaims job 9 and completes it. Then A wakes up and calls `CompleteAsync(db, 9, "worker-a")`.
What happens? (Select all that apply.)

- [x] `UPDATE … WHERE id = 9 AND locked_by = 'worker-a' AND status = 'running'` matches 0 rows, so A learns it lost the lease and doesn't overwrite B's result
- [x] Any side effect A performed before the pause (an email, a webhook) may still have happened twice. The fence protects the job row, not the outside world.
- [ ] Postgres raises a deadlock error for worker A
- [ ] B's completion is rolled back because A held the lease first
> The `locked_by` condition is a **fencing token** check. The test `A_zombie_worker_cannot_complete_a_job_it_no_longer_owns` covers it. For external side effects, pass an idempotency key (for example `job:{id}`) to the downstream API so a duplicate call is ignored (lesson be-18).
:::

:::sql id=be-21-sql3 db=studio xp=30
title: Claim the next render job
Write the claim for worker `worker-z`. Take the **oldest** `queued` render job (by `created_at`,
then `id`) and set `status = 'running'`, `worker = 'worker-z'`, `attempts = attempts + 1` and
`started_at = '2025-07-11 00:00:00+00'`. Only **one** job may be claimed, and concurrent workers
must skip rows another worker has locked.

The starter claims every queued job at once.

hint: `UPDATE render_jobs SET … WHERE id = (SELECT id FROM render_jobs WHERE status = 'queued' ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1)`
hint: `RETURNING id` is a nice touch, so the worker learns what it got.

```sql starter
UPDATE render_jobs
   SET status = 'running', worker = 'worker-z', attempts = attempts + 1,
       started_at = '2025-07-11 00:00:00+00'
 WHERE status = 'queued';
```

```sql solution
UPDATE render_jobs
   SET status = 'running', worker = 'worker-z', attempts = attempts + 1,
       started_at = '2025-07-11 00:00:00+00'
 WHERE id = (SELECT id FROM render_jobs
              WHERE status = 'queued'
              ORDER BY created_at, id
              FOR UPDATE SKIP LOCKED
              LIMIT 1)
RETURNING id;
```

```sql check
SELECT id, status, worker, attempts FROM render_jobs WHERE id IN (6, 7, 8, 10) ORDER BY id;
```
:::

## Lab 3: the worker, health checks and the final acceptance run

:::lab id=be-21-lab3 xp=200
title: A crash-safe SKIP LOCKED worker, live/ready health checks, and all 22 acceptance tests green

**1. The full job store.** Replace `src/Projects.Api/JobStore.cs`. It adds claiming with a
lease, fenced completion and retry-or-dead-letter:

`src/Projects.Api/JobStore.cs`

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore;

namespace Projects.Api;

public static class JobTypes
{
    public const string WordCount = "document.wordcount";
}

public record WordCountPayload(Guid DocumentId, int Version);

public static class JobStore
{
    /// Adds a job to the change tracker; it is INSERTed by the caller's SaveChanges (same transaction).
    public static void Enqueue<T>(AppDbContext db, string type, T payload) =>
        db.Jobs.Add(new Job { Type = type, Payload = JsonSerializer.Serialize(payload) });

    /// Claims one due job (or one whose lease expired) and leases it to this worker.
    public static async Task<Job?> ClaimAsync(AppDbContext db, string workerId, TimeSpan lease, CancellationToken ct)
    {
        var rows = await db.Jobs.FromSql($"""
            UPDATE jobs
               SET status = 'running',
                   attempts = attempts + 1,
                   locked_by = {workerId},
                   locked_until = now() + {lease}
             WHERE id = (
                   SELECT id FROM jobs
                    WHERE (status = 'queued'  AND run_after <= now())
                       OR (status = 'running' AND locked_until < now())
                    ORDER BY run_after, id
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1)
            RETURNING *
            """).AsNoTracking().ToListAsync(ct);
        return rows.FirstOrDefault();
    }

    /// Fenced by locked_by: a zombie worker whose lease was taken over updates 0 rows.
    public static Task<int> CompleteAsync(AppDbContext db, long jobId, string workerId, CancellationToken ct) =>
        db.Jobs
          .Where(j => j.Id == jobId && j.LockedBy == workerId && j.Status == "running")
          .ExecuteUpdateAsync(s => s
              .SetProperty(j => j.Status, "done")
              .SetProperty(j => j.LockedBy, (string?)null)
              .SetProperty(j => j.LockedUntil, (DateTimeOffset?)null), ct);

    /// Retry later, or dead-letter once attempts are used up.
    public static Task<int> FailAsync(AppDbContext db, long jobId, string workerId, TimeSpan delay,
        string error, CancellationToken ct) =>
        db.Database.ExecuteSqlAsync($"""
            UPDATE jobs
               SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
                   run_after = now() + {delay},
                   last_error = {error},
                   locked_by = NULL,
                   locked_until = NULL
             WHERE id = {jobId} AND locked_by = {workerId} AND status = 'running'
            """, ct);

    /// Exponential backoff with full jitter: random in [0, min(cap, base * 2^(attempt-1))].
    public static TimeSpan Backoff(int attempt, TimeSpan @base, TimeSpan cap)
    {
        var exp = @base.TotalMilliseconds * Math.Pow(2, Math.Max(0, attempt - 1));
        return TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * Math.Min(cap.TotalMilliseconds, exp));
    }
}
```

`FromSql` with `UPDATE … RETURNING *` works because EF Core doesn't compose anything around it
(no `Where`, no `OrderBy` after it). The `{lease}` `TimeSpan` becomes a Postgres `interval`
parameter. Like everything inside a `FromSql` interpolated string, it's sent as a **parameter**,
never concatenated into the SQL.

**2. Handlers and the worker**

`src/Projects.Api/JobWorker.cs`

```csharp
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Projects.Api;

public class JobOptions
{
    public bool Enabled { get; set; } = true;
    public TimeSpan PollInterval { get; set; } = TimeSpan.FromSeconds(1);
    public TimeSpan Lease { get; set; } = TimeSpan.FromSeconds(30);
    public TimeSpan BackoffBase { get; set; } = TimeSpan.FromSeconds(2);
    public TimeSpan BackoffCap { get; set; } = TimeSpan.FromMinutes(5);
}

public interface IJobHandler
{
    string Type { get; }
    Task HandleAsync(JsonElement payload, CancellationToken ct);
}

/// Idempotent: computes the count for exactly one version. Re-running it, or running it for an
/// old version after a newer save, changes nothing.
public sealed class WordCountHandler(AppDbContext db) : IJobHandler
{
    public string Type => JobTypes.WordCount;

    public async Task HandleAsync(JsonElement payload, CancellationToken ct)
    {
        var p = payload.Deserialize<WordCountPayload>(JsonSerializerOptions.Web)
                ?? throw new InvalidOperationException("Bad payload");

        var content = await db.Documents
            .Where(d => d.Id == p.DocumentId && d.Version == p.Version)
            .Select(d => d.Content)
            .FirstOrDefaultAsync(ct);
        if (content is null) return;   // deleted, or a newer version exists → its own job handles it

        var words = content.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).Length;
        await db.Documents
            .Where(d => d.Id == p.DocumentId && d.Version == p.Version)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.WordCount, words), ct);
    }
}

public sealed class JobWorker(IServiceScopeFactory scopes, IOptions<JobOptions> options,
    ILogger<JobWorker> log) : BackgroundService
{
    // In Kubernetes MachineName is the pod name, which makes locked_by easy to trace.
    public string WorkerId { get; } = $"{Environment.MachineName}-{Guid.NewGuid().ToString("N")[..8]}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var o = options.Value;
        if (!o.Enabled) return;
        log.LogInformation("Job worker {WorkerId} started", WorkerId);

        while (!stoppingToken.IsCancellationRequested)
        {
            bool didWork;
            try
            {
                didWork = await RunOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;   // shutting down; a job we held stays leased and is reclaimed after the lease
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Job loop error (database down?)");
                didWork = false;
            }

            if (!didWork)
            {
                try { await Task.Delay(o.PollInterval, stoppingToken); }
                catch (OperationCanceledException) { break; }
            }
        }
        log.LogInformation("Job worker {WorkerId} stopped", WorkerId);
    }

    /// Claims and runs at most one job. Returns false when the queue had nothing due.
    public async Task<bool> RunOnceAsync(CancellationToken ct)
    {
        var o = options.Value;
        await using var scope = scopes.CreateAsyncScope();   // fresh DbContext per job
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var job = await JobStore.ClaimAsync(db, WorkerId, o.Lease, ct);
        if (job is null) return false;

        try
        {
            var handler = scope.ServiceProvider.GetServices<IJobHandler>().FirstOrDefault(h => h.Type == job.Type)
                          ?? throw new InvalidOperationException($"No handler for job type '{job.Type}'");
            using var json = JsonDocument.Parse(job.Payload);
            await handler.HandleAsync(json.RootElement, ct);

            if (await JobStore.CompleteAsync(db, job.Id, WorkerId, ct) == 0)
                log.LogWarning("Lost the lease on job {JobId}; another worker owns it now", job.Id);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            var delay = JobStore.Backoff(job.Attempts, o.BackoffBase, o.BackoffCap);
            log.LogWarning(ex, "Job {JobId} ({Type}) attempt {Attempt} failed; retry in {Delay}",
                job.Id, job.Type, job.Attempts, delay);
            await JobStore.FailAsync(db, job.Id, WorkerId, delay, ex.Message, CancellationToken.None);
        }
        return true;
    }
}
```

Things to notice:

- **A new DI scope (and `DbContext`) per job.** A `BackgroundService` is a singleton, and a
  `DbContext` must never live that long.
- **Shutdown.** When the host stops, `stoppingToken` is cancelled. A running handler sees the
  cancellation, the loop exits, and the job keeps its lease, so another replica re-runs it after
  `Lease`. Nothing is lost, which is the whole point of the lease.
- **The failure path uses `CancellationToken.None`.** Recording a failure shouldn't be skipped
  just because the handler's token fired.
- **Every replica runs a worker.** `SKIP LOCKED` lets them share the table without blocking each
  other. To scale processing separately from HTTP, run the same image with a
  `Jobs:Enabled=true` worker deployment and HTTP pods with `Jobs:Enabled=false`. KEDA can scale the
  workers on queue depth (lesson be-16).

**3. Program.cs, final version.** Replace the file:

`src/Projects.Api/Program.cs`

```csharp
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.EntityFrameworkCore;
using Projects.Api;

var builder = WebApplication.CreateBuilder(args);

// ── Data ──
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(builder.Configuration.GetConnectionString("Db"))
    .UseSnakeCaseNamingConvention());

// ── Auth: Keycloak (or any OIDC provider) issues the JWTs; we only validate them ──
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = builder.Configuration["Auth:Authority"];   // e.g. http://localhost:8080/realms/devquest
        o.Audience = builder.Configuration["Auth:Audience"];     // e.g. projects-api
        o.MapInboundClaims = false;                              // keep "sub" as "sub"
        o.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
    });
builder.Services.AddAuthorizationBuilder()
    // Secure by default: every endpoint requires a signed-in user unless it opts out.
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

// ── App services ──
builder.Services.AddProblemDetails();
builder.Services.ConfigureHttpJsonOptions(o =>
    o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));   // "Editor", not 1
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.Configure<QuotaOptions>(builder.Configuration.GetSection("Quotas"));
builder.Services.Configure<JobOptions>(builder.Configuration.GetSection("Jobs"));
builder.Services.AddScoped<IJobHandler, WordCountHandler>();
builder.Services.AddHostedService<JobWorker>();

// ── Health ──
builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("postgres", tags: ["ready"]);

var app = builder.Build();

// Dev/test convenience. In production run migrations as a separate deploy step (bundle / job),
// so ten replicas starting at once don't race to migrate the same database.
if (app.Configuration.GetValue<bool>("Database:MigrateOnStartup"))
{
    await using var scope = app.Services.CreateAsyncScope();
    await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
}

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseAuthentication();
app.UseAuthorization();

// Liveness: "is the process alive?" — runs NO checks, so a DB outage never restarts the pod.
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false }).AllowAnonymous();
// Readiness: "should I get traffic?" — includes the database.
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") })
   .AllowAnonymous();

app.MapProjects();
app.MapDocuments();

app.Run();
```

**4. Test support.** Add a no-op job type that the tests can flood the queue with:

`tests/Projects.Api.Tests/NoopHandler.cs`

```csharp
using System.Text.Json;

namespace Projects.Api.Tests;

/// A job type that always succeeds — lets tests flood the queue.
public sealed class NoopHandler : IJobHandler
{
    public string Type => "test.noop";
    public Task HandleAsync(JsonElement payload, CancellationToken ct) => Task.CompletedTask;
}
```

And register it in `ApiFactory.ConfigureWebHost`:

```csharp
        builder.ConfigureTestServices(services =>
        {
            UseTestAuth(services);
            services.AddScoped<IJobHandler, NoopHandler>();   // ← new
        });
```

**5. The final acceptance tests**

`tests/Projects.Api.Tests/JobTests.cs`

```csharp
using System.Net.Http.Json;
using Microsoft.EntityFrameworkCore;
using Shouldly;

namespace Projects.Api.Tests;

public class JobTests(ApiFactory factory) : ApiTest(factory)
{
    [Fact]
    public async Task Saving_a_document_eventually_computes_its_word_count()
    {
        var id = await CreateProjectAsync("alice");
        var doc = await CreateDocAsync(id, "alice", "one two three");
        (await As("alice").PutAsJsonAsync($"/projects/{id}/documents/{doc.Id}",
            new { content = "one two three four five", baseVersion = 1 })).EnsureSuccessStatusCode();

        await Eventually(async () =>
        {
            var d = await As("alice").GetFromJsonAsync<DocumentDto>($"/projects/{id}/documents/{doc.Id}");
            return d!.WordCount == 5;
        });
    }

    [Fact]
    public async Task A_job_left_running_by_a_crashed_worker_is_reclaimed_after_its_lease()
    {
        var id = await CreateProjectAsync("alice");
        var doc = await CreateDocAsync(id, "alice", "a b c d");
        await Eventually(() => Factory.WithDb(db => db.Jobs.AllAsync(j => j.Status == "done")));

        // Simulate: a worker claimed a job, then the pod was killed (lease expired a minute ago).
        var jobId = await Factory.WithDb(async db =>
        {
            await db.Documents.Where(d => d.Id == doc.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(d => d.WordCount, (int?)null));
            var job = new Job
            {
                Type = JobTypes.WordCount,
                Payload = $$"""{"documentId":"{{doc.Id}}","version":1}""",
                Status = "running",
                Attempts = 1,
                LockedBy = "dead-worker",
                // Real clock on purpose: the claim query compares against Postgres now(), not TimeProvider.
                LockedUntil = DateTimeOffset.UtcNow.AddMinutes(-1),
            };
            db.Jobs.Add(job);
            await db.SaveChangesAsync();
            return job.Id;
        });

        await Eventually(() => Factory.WithDb(db => db.Jobs.AnyAsync(j => j.Id == jobId && j.Status == "done")));
        var job = await Factory.WithDb(db => db.Jobs.SingleAsync(j => j.Id == jobId));
        job.Attempts.ShouldBe(2);                      // crashed attempt + successful retry
        (await Factory.WithDb(db => db.Documents.SingleAsync(d => d.Id == doc.Id))).WordCount.ShouldBe(4);
    }

    [Fact]
    public async Task A_zombie_worker_cannot_complete_a_job_it_no_longer_owns()
    {
        var jobId = await Factory.WithDb(async db =>
        {
            var job = new Job
            {
                Type = "test.noop", Payload = "{}", Status = "running", Attempts = 1,
                LockedBy = "worker-b", LockedUntil = DateTimeOffset.UtcNow.AddMinutes(5), // vs Postgres now()
            };
            db.Jobs.Add(job);
            await db.SaveChangesAsync();
            return job.Id;
        });

        var rows = await Factory.WithDb(db => JobStore.CompleteAsync(db, jobId, "worker-a", CancellationToken.None));

        rows.ShouldBe(0);
        (await Factory.WithDb(db => db.Jobs.SingleAsync(j => j.Id == jobId))).Status.ShouldBe("running");
    }

    [Fact]
    public async Task Failing_jobs_are_retried_then_dead_lettered()
    {
        var jobId = await Factory.WithDb(async db =>
        {
            var job = new Job { Type = "no.such.handler", Payload = "{}", MaxAttempts = 3 };
            db.Jobs.Add(job);
            await db.SaveChangesAsync();
            return job.Id;
        });

        await Eventually(() => Factory.WithDb(db => db.Jobs.AnyAsync(j => j.Id == jobId && j.Status == "dead")));
        var job = await Factory.WithDb(db => db.Jobs.SingleAsync(j => j.Id == jobId));
        job.Attempts.ShouldBe(3);
        job.LastError!.ShouldContain("No handler");
    }

    [Fact]
    public async Task Competing_claimers_never_get_the_same_job()
    {
        const int jobCount = 40;
        await Factory.WithDb(async db =>
        {
            for (var i = 0; i < jobCount; i++) db.Jobs.Add(new Job { Type = "test.noop", Payload = "{}" });
            return await db.SaveChangesAsync();
        });

        // 8 extra "workers" race the real background worker for the same rows.
        var claimers = Enumerable.Range(0, 8).Select(w => Task.Run(async () =>
        {
            var worker = $"test-worker-{w}";
            while (true)
            {
                var job = await Factory.WithDb(db => JobStore.ClaimAsync(db, worker, TimeSpan.FromMinutes(1), default));
                if (job is null) return;
                await Factory.WithDb(db => JobStore.CompleteAsync(db, job.Id, worker, default));
            }
        }));
        await Task.WhenAll(claimers);

        await Eventually(() => Factory.WithDb(db => db.Jobs.AllAsync(j => j.Status == "done")));
        // Every claim increments attempts. A double-claimed job would show attempts = 2.
        (await Factory.WithDb(db => db.Jobs.CountAsync(j => j.Attempts == 1))).ShouldBe(jobCount);
    }
}
```

`tests/Projects.Api.Tests/HealthAndMigrationTests.cs`

```csharp
using System.Net;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Shouldly;

namespace Projects.Api.Tests;

public class HealthAndMigrationTests(ApiFactory factory) : ApiTest(factory)
{
    [Fact]
    public async Task Live_and_ready_are_healthy_and_anonymous()
    {
        (await As(null).GetAsync("/health/live")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await As(null).GetAsync("/health/ready")).StatusCode.ShouldBe(HttpStatusCode.OK);
    }

    [Fact]
    public async Task The_model_has_no_changes_missing_from_the_migrations()
    {
        var pending = await Factory.WithDb(db => Task.FromResult(db.Database.HasPendingModelChanges()));
        pending.ShouldBeFalse("Run: dotnet ef migrations add <Name> --project src/Projects.Api");
    }

    [Fact]
    public async Task All_migrations_are_applied()
    {
        var pending = await Factory.WithDb(db => db.Database.GetPendingMigrationsAsync());
        pending.ShouldBeEmpty();
    }

    [Fact]
    public async Task Without_a_database_ready_is_503_but_live_stays_200()
    {
        // A second app instance pointed at a port where nothing listens.
        await using var broken = new WebApplicationFactory<Program>().WithWebHostBuilder(b =>
        {
            b.UseEnvironment("Testing");
            b.UseSetting("ConnectionStrings:Db", "Host=127.0.0.1;Port=1;Username=x;Password=x;Timeout=2");
            b.UseSetting("Jobs:Enabled", "false");
            b.ConfigureTestServices(ApiFactory.UseTestAuth);
        });
        var client = broken.CreateClient();

        (await client.GetAsync("/health/live")).StatusCode.ShouldBe(HttpStatusCode.OK);
        (await client.GetAsync("/health/ready")).StatusCode.ShouldBe(HttpStatusCode.ServiceUnavailable);
    }
}
```

**6. Run everything**

```bash
dotnet test
```

```text
Passed!  - Failed:     0, Passed:    22, Skipped:     0, Total:    22
```

Run it three times in a row. Concurrency tests that pass once and fail the next time are
telling you something, so don't ignore flakiness.

**7. Break it on purpose** (undo after each step):

1. Delete the line `FOR UPDATE SKIP LOCKED` from the claim. `Competing_claimers_never_get_the_same_job`
   fails: some jobs end with `attempts = 2`. Without the row lock, two claimers pick the same id
   in their subqueries. The second `UPDATE` waits, then re-checks only `id = X`, which is still
   true, so the job is claimed twice.
2. In `CompleteAsync`, remove `&& j.LockedBy == workerId`. The zombie test fails: a worker that
   lost its lease overwrites the state of a job it no longer owns.
3. Make `WordCountHandler` skip the version check (`Where(d => d.Id == p.DocumentId)` in both
   queries). All tests still pass. But think through this interleaving: the job for v2 reads v2's
   content, then v3 is saved and its job writes v3's count, and finally the slow v2 job writes
   *its* count. The document now shows v2's word count next to v3's content, and nothing will
   ever correct it. Some races are too timing-dependent to test reliably. You prevent them by
   design (key every effect on the version) and by code review, and this is why the handler
   checks the version.

**8. Run it for real**

```bash
docker run -d --name projects-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=projects -p 5432:5432 postgres:18
dotnet run --project src/Projects.Api
```

The log shows the migration being applied (your timestamp differs) and the worker starting. EF logs one `fail:` line
because `__EFMigrationsHistory` doesn't exist yet on a fresh database. That's expected.

```text
info: Microsoft.EntityFrameworkCore.Migrations[20402]
      Applying migration '20261105152125_Initial'.
info: Projects.Api.JobWorker[0]
      Job worker my-laptop-d7d86c45 started
info: Microsoft.Hosting.Lifetime[14]
      Now listening on: http://localhost:5028
```

In a second terminal (use the port from your log):

```bash
curl -i http://localhost:5028/health/live      # HTTP/1.1 200 OK … Healthy
curl -i http://localhost:5028/health/ready     # HTTP/1.1 200 OK … Healthy
curl -i http://localhost:5028/projects         # HTTP/1.1 401 Unauthorized
docker stop projects-pg
curl -i http://localhost:5028/health/ready     # HTTP/1.1 503 Service Unavailable … Unhealthy
curl -i http://localhost:5028/health/live      # still 200: don't restart the pod for a DB outage
docker start projects-pg
```

- [ ] `dotnet test` shows 22 passing tests, three runs in a row
- [ ] Removing `FOR UPDATE SKIP LOCKED` made the competing-claimers test fail, and I can explain the double claim
- [ ] Removing the `locked_by` fence made the zombie test fail
- [ ] I can describe the interleaving in step 7.3 and why the versioned handler is immune to it
- [ ] With Postgres stopped, `/health/ready` returned `503` while `/health/live` stayed `200`
:::

## Boss phase 4: production

:::quiz id=be-21-q10 xp=25
Postgres fails over and is unreachable for 90 seconds. Your Kubernetes probes are
`livenessProbe: /health/ready` and `readinessProbe: /health/ready`. What happens, and what's the fix?

- [ ] Nothing bad. The pods are marked unready and recover afterwards.
- [x] The liveness probe fails too, so Kubernetes **restarts every pod** during the outage. Cold starts, lost in-flight requests and a thundering herd of reconnects follow when the DB returns. Liveness should point at `/health/live`, which checks only the process itself.
- [ ] The job worker crashes because `ExecuteAsync` throws
- [ ] Readiness should point at `/health/live` instead
> Liveness answers "is this process broken beyond repair?" A database outage isn't something a restart can fix. Readiness answers "should I receive traffic now?", and that's where dependency checks belong. Our worker loop also survives the outage: it logs the error, waits `PollInterval` and tries again.
:::

:::quiz id=be-21-q11 xp=30
All 22 tests pass with one instance. Which of these would break or misbehave once you run
**five replicas** behind a load balancer? (Select all that apply.)

- [x] Caching each user's project role in `IMemoryCache` for 10 minutes. When an owner removes an editor, the other pods keep accepting that editor's saves until their cache expires.
- [x] Sending SignalR `DocumentSaved` events through `IHubContext` without a backplane. Clients connected to pod B never hear about saves handled by pod A.
- [x] Queuing the word-count work in an in-process `Channel<T>` instead of the `jobs` table. Every deploy or crash loses the queued work.
- [ ] The `FOR UPDATE SKIP LOCKED` worker running in every replica
- [ ] The atomic `INSERT … ON CONFLICT … WHERE documents < limit` quota
> Anything kept **in process memory** is per replica: caches, in-memory queues, SignalR connection lists. The database-backed mechanisms are shared by construction, which is why the queue and the quota hold with any number of replicas. Fixes: short-TTL or event-invalidated caches (or no caching of authorization data), a Redis backplane for SignalR (lesson be-17), and durable queues (lesson be-16).
:::

:::quiz id=be-21-q12 xp=25
A customer says: *"I saved, got a 500 error, clicked save again, and now I get 409 Conflict."*
The logs show the first request's transaction committed. Then the connection dropped before the
response was sent. What's the best API-level fix?

- [ ] Return `200` instead of `409` whenever the content is identical
- [ ] Retry the whole save on the server when the connection drops
- [x] Make the client's retry recognizable: send an **idempotency key** with each save (or, as a narrower fallback, treat a save as already applied when the stored version is exactly `baseVersion + 1` with identical content). A retry then replays the first response instead of conflicting with itself.
- [ ] Lower the database command timeout
> From the client's point of view the first save failed, but it actually committed. The retry carries the old `baseVersion`, so optimistic concurrency correctly rejects it. Returning `200` *whenever* the content is identical is too broad: it would also accept a stale save from version 1 after several newer versions, as long as the text happens to match. The server can't retry a request whose client connection is already gone. A shorter command timeout doesn't change that the commit happened. Idempotency keys (lesson be-18) make "retry after an unknown outcome" safe, and that's the general problem behind most "duplicate charge" and "double post" bugs.
:::

## Stretch goals

If you beat the boss and want more, each of these is a realistic ticket:

1. **Observability.** Add OpenTelemetry tracing and metrics (lesson be-19): an
   `ActivitySource("Projects.Api.Jobs")` span per job, with `job.id`, `job.type` and `job.attempt`
   tags, and a `Meter` with counters `documents.saved`, `documents.conflicts` and
   `jobs.processed{outcome}`.
2. **Queue health.** Add a readiness-independent `/health/queue` check that reports `Degraded`
   when more than 1,000 jobs are due or the oldest due job is over 5 minutes old.
3. **Live co-editing.** Broadcast `DocumentSaved(docId, version, userId)` to the SignalR group
   `project:{id}` after commit (lesson be-17). Clients that receive a newer version than their
   `baseVersion` show "someone else saved" before the user even tries.
4. **ETag / If-Match.** Return `ETag: "v{version}"` on `GET` and accept `If-Match` on `PUT`
   (`412` when stale, `428` when missing), as in lesson be-18.
5. **Delete with refund.** `DELETE /projects/{id}/documents/{docId}` decrements the owner's usage
   **in the same transaction**. Write the concurrency test first.
6. **Keyset pagination** for `GET /projects/{id}/documents?cursor=…` (lesson be-20).
7. **CI.** A GitHub Actions workflow that runs `dotnet test` on `ubuntu-latest`, where Docker is
   available for Testcontainers (lesson be-15).

:::job title="This is what a take-home looks like"
"Build a small API with auth, persistence and a background job, with tests" is the most common
backend take-home assignment, and reviewers read it like this lab's contract. Do the status codes
follow a rule? Is there a test for the race condition? Does the job survive a crash? Is the
authorization check per resource? Can I run it with one command? A small, consistent, tested
codebase beats a large one with clever layers every time.
:::

:::pro title="Where real systems go next"
Teams that outgrow this design usually change it in a few predictable places. They move the
worker to its own deployment and scale it on queue depth. They partition the `jobs` table, or
delete `done` rows on a schedule so the partial index stays small. They add `LISTEN/NOTIFY` to
wake workers instead of polling. They add an outbox relay when other services need the events.
Some replace `jobs` with a managed broker once throughput needs it. Every one of those changes
keeps the guarantees you just tested: a transactional enqueue, leases, fencing, idempotent
handlers and backoff with dead letters.

Where to learn those next steps in DevQuest:

- **Message Brokers & the Outbox Pattern** (Cloud-Native Toolkit): publishing events to other
  services with an outbox relay, idempotent consumers and poison messages.
- **Multi-Stage Builds for .NET and React** (Containers & Kubernetes): a production Dockerfile for
  this API on a chiseled image.
- **Shipping Safely: Continuous Delivery & Releases** (Pro Skills): migration bundles and
  expand/contract migrations as a deploy step, health-gated rollouts and rollbacks.
:::

:::cards id=be-21-cards1 xp=20 title="Boss review: the Projects API"
Q: How does the API stop lost updates on document saves?
A: `UPDATE … WHERE id = @id AND version = @baseVersion`. 0 rows → re-read the current version → `409` problem with `currentVersion`.
Q: Why is the conditional UPDATE safe without SERIALIZABLE?
A: Concurrent updaters block on the row lock. After the first commits, Postgres re-checks the WHERE against the new row version, so the loser updates 0 rows.
Q: Non-member vs. under-privileged member: which status codes?
A: Non-member → 404 (no existence leak). Member without the needed role → 403.
Q: How is the owner-billed quota made race-free?
A: One `INSERT … ON CONFLICT (owner_id) DO UPDATE … WHERE documents < @limit RETURNING`. No row returned means over quota.
Q: Why enqueue jobs in the same transaction as the business change?
A: The job exists if and only if the change committed. No lost or phantom jobs (the outbox idea, for free with a Postgres queue).
Q: What do FOR UPDATE and SKIP LOCKED each contribute to the claim?
A: FOR UPDATE stops two claimers from taking the same row. SKIP LOCKED makes them take the next free row instead of waiting.
Q: How does a job survive a worker crash?
A: It stays `running` with a `locked_until` lease. Once that has passed, the claim query picks it up again (at-least-once).
Q: What's the `locked_by` condition on complete/fail for?
A: Fencing. A zombie worker whose lease was taken over updates 0 rows and can't overwrite the new owner's result.
Q: Why must job handlers be idempotent?
A: At-least-once delivery: crashes and lease expiry can run a job twice. Key the effect on stable data (here: the document version).
Q: /health/live vs /health/ready?
A: Live = the process works, no dependency checks (a failure means restart). Ready = it can serve traffic, including the DB (a failure means it's removed from the load balancer).
Q: Why `MapInboundClaims = false`?
A: It keeps OIDC claim names like `sub` instead of mapping them to long `ClaimTypes` URIs. Tests with a custom auth handler won't notice if it's missing.
Q: Which test catches a forgotten migration?
A: `db.Database.HasPendingModelChanges()` must be false. Since EF Core 9, `MigrateAsync` also throws on pending model changes.
:::

## Recap

- The boss combined **every backend skill**: OIDC JWT validation with a secure-by-default
  fallback policy, resource-based roles (`404` vs `403`), EF Core + Npgsql with snake_case and
  real migrations, and route-group feature files.
- **Versioned saves** use an atomic conditional `UPDATE`. Losers get `409` with `currentVersion`,
  and Postgres's row-lock re-check makes it race-free under READ COMMITTED.
- **Owner-billed quotas** use one atomic upsert keyed by the owner. A read-then-write passes
  sequential tests and fails under concurrency.
- The **Postgres job queue** commits jobs with the business change, claims with
  `FOR UPDATE SKIP LOCKED`, owns jobs through **leases**, fences completion with `locked_by`,
  retries with jittered backoff and dead-letters after `max_attempts`. Handlers are idempotent.
- **`/health/live`** checks only the process, **`/health/ready`** checks Postgres, and both are anonymous.
- **22 integration tests** on real Postgres 18 prove each guarantee, and the "break it" steps
  prove that the tests actually catch the bugs.
