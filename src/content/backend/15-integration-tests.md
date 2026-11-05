---
id: be-15
title: Integration Tests with WebApplicationFactory & Testcontainers
level: advanced
minutes: 60
xp: 150
summary: Test the real HTTP pipeline against a real PostgreSQL 18 in a container — replacing services, fake auth, Respawn resets, migration checks and CI.
---

Unit tests check your decisions. **Integration tests check that your app actually works**: the
request hits the right route, the JSON binds, the auth middleware runs, EF Core turns your LINQ
into SQL Postgres accepts, the unique index fires, the response serializes the way the React
client expects. Most production bugs in a CRUD-heavy API live in exactly those seams, and none of
them show up in a unit test with a mocked repository.

This lesson builds the setup that real .NET teams use:

```text
xUnit test ──HttpClient──▶ TestServer (in memory) ──▶ your real Program.cs pipeline
                                                          │  (auth replaced by a test scheme)
                                                          ▼
                                         PostgreSQL 18 in a Docker container (Testcontainers)
```

## Why not the EF Core InMemory provider (or SQLite)?

It's tempting: `UseInMemoryDatabase("test")`, no Docker, instant. The problem is that it isn't
a relational database, so it **silently accepts things Postgres rejects**:

| Behaviour | InMemory provider | SQLite | PostgreSQL |
|---|---|---|---|
| Unique index / FK violations | ignored | enforced | enforced |
| Transactions | not supported (throws by default; ignored if you suppress the warning) | yes | yes |
| String comparison | C# (case-sensitive, ordinal) | depends on collation | depends on collation |
| `jsonb`, arrays, `xmin`, `ILIKE`, `FOR UPDATE SKIP LOCKED` | no | no | yes |
| Raw SQL (`FromSql`, `ExecuteUpdate` semantics) | no | dialect differs | yes |
| Your migrations | not used | different SQL | the real thing |

Microsoft's own docs recommend against InMemory for testing. Testing against "something like the
production database" means your tests pass while production returns 500s. Since a Postgres
container starts in a couple of seconds, there is no longer a good reason not to use the real
engine.

:::quiz id=be-15-q1 xp=15
`AppDbContext` configures `HasIndex(p => new { p.OwnerId, p.Name }).IsUnique()`, and the endpoint
turns a Postgres unique violation (SqlState `23505`) into `409 Conflict`. An integration test
using `UseInMemoryDatabase` creates two projects named "Apollo" for alice. What happens on the
second request?
- [ ] EF Core throws `DbUpdateException` and the endpoint returns 409, same as production
- [x] The second insert succeeds with 201 — the InMemory provider doesn't enforce unique indexes, so the 409 path is never exercised
- [ ] The InMemory provider emulates PostgreSQL error codes, so a `PostgresException` is thrown
- [ ] The test fails to compile because InMemory doesn't support `HasIndex`
> The InMemory provider is a set of dictionaries, not a database: unique indexes are metadata it ignores, and it never produces a `PostgresException` with SqlState `23505`. Your conflict-handling code stays untested and the test is green for the wrong reason. Use a real Postgres via Testcontainers.
:::

## WebApplicationFactory: your whole app, in memory

`Microsoft.AspNetCore.Mvc.Testing` provides `WebApplicationFactory<TEntryPoint>`. It boots your
real `Program.cs` — the same DI registrations, middleware and endpoints — on a **TestServer** that
lives in memory. `CreateClient()` gives you an `HttpClient` wired directly into it: no ports, no
network, no firewall.

```csharp
public class SmokeTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Health_endpoint_returns_200()
    {
        var client = factory.CreateClient();
        var response = await client.GetAsync("/health/live");
        response.EnsureSuccessStatusCode();
    }
}
```

`Program` is the class the compiler generates from your top-level statements. On .NET 8/9 it is
`internal`, so test projects need `public partial class Program;` at the bottom of `Program.cs`
(or `InternalsVisibleTo`). **On .NET 10, the Web SDK source-generates that public declaration for
you**; writing it yourself is still harmless and makes the intent obvious, so the lab keeps it.

### Customizing the host: `ConfigureWebHost`

Subclass the factory to change what the test app looks like:

```csharp
public sealed class ApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");                        // appsettings.Testing.json, no dev-only middleware
        builder.UseSetting("ConnectionStrings:Db", "Host=...");   // config override

        builder.ConfigureTestServices(services =>                 // runs AFTER Program's registrations
        {
            services.RemoveAll<IEmailSender>();
            services.AddSingleton<IEmailSender, RecordingEmailSender>();

            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(new FakeTimeProvider(DateTimeOffset.Parse("2026-01-01T00:00:00Z")));
        });
    }
}
```

Why `ConfigureTestServices` and not `ConfigureServices`? `ConfigureTestServices` is guaranteed
to run **after** the app's own registrations in every hosting model. With minimal hosting the
factory's `ConfigureServices` also runs after `Program.cs`, but in older `Startup`-based apps it
ran *before* `Startup.ConfigureServices`, so the real service won. Using `ConfigureTestServices`
makes your replacement the last registration either way.
`RemoveAll<T>()` (from `Microsoft.Extensions.DependencyInjection.Extensions`) removes the
original so that code resolving `IEnumerable<T>` doesn't see both.

What should you replace? **Only things that leave the process or aren't deterministic**: email
and SMS senders, payment gateways, third-party HTTP APIs, the clock, the identity provider. Keep
the database, serialization, validation, authorization policies and your own services real —
that's the point of an integration test.

:::info title="Configuration overrides and eager reads"
`builder.UseSetting(key, value)` is visible even to code that reads configuration eagerly at the
top of `Program.cs` (`var cs = builder.Configuration.GetConnectionString("Db");`). Values added
via `ConfigureAppConfiguration` in the factory may arrive **after** such eager reads in
minimal-hosting apps. Prefer `UseSetting` for simple overrides, and prefer reading config lazily
(inside options lambdas or via `IOptions<T>`) in application code anyway.
:::

:::quiz id=be-15-q2 xp=15
`Program.cs` registers `builder.Services.AddSingleton<IEmailSender, SmtpEmailSender>();`. Which
factory code **reliably** makes the app use `FakeEmailSender` in tests?
- [ ] `builder.ConfigureServices(s => s.AddSingleton<IEmailSender, FakeEmailSender>());` — registering it again is enough
- [x] `builder.ConfigureTestServices(s => { s.RemoveAll<IEmailSender>(); s.AddSingleton<IEmailSender, FakeEmailSender>(); });`
- [ ] Set `ASPNETCORE_ENVIRONMENT=Testing` and the SDK swaps fakes automatically
- [ ] Mark `FakeEmailSender` with `[Primary]`
> `ConfigureTestServices` runs after the app's own registrations, so your registration is last (and `GetService` returns the last one). `RemoveAll` additionally removes the SMTP sender so nothing that resolves `IEnumerable<IEmailSender>` still sends real mail. The first option is tempting and often seems to work with minimal hosting, because the factory's `ConfigureServices` also runs after `Program.cs`. But the SMTP sender stays registered, so anything resolving `IEnumerable<IEmailSender>` still sends real mail, and in older `Startup`-based apps the order was reversed. `ConfigureTestServices` plus `RemoveAll` is the version that is reliable everywhere. Environments don't swap anything by themselves, and `[Primary]` isn't a .NET DI feature.
:::

## Testcontainers: a real Postgres per test run

**Testcontainers** starts throw-away Docker containers from code and tears them down afterwards.
The `Testcontainers.PostgreSql` module knows how to wait until Postgres accepts connections and
builds the connection string for you:

```csharp
private readonly PostgreSqlContainer _db = new PostgreSqlBuilder("postgres:18").Build();

await _db.StartAsync();                      // pulls the image the first time, then ~1–3 s
var cs = _db.GetConnectionString();          // Host=127.0.0.1;Port=49153;Database=postgres;...
await _db.DisposeAsync();                    // stops and removes the container
```

Key decisions:

- **Pin the image** (`postgres:18`, or a digest) to the major version you run in production. A
  test suite on Postgres 16 tells you little about Postgres 18 behaviour.
- **Random host port.** Testcontainers maps 5432 to a free port, so parallel CI jobs and your
  local Postgres don't collide.
- **One container per test run, not per test.** Starting a container costs seconds; a test costs
  milliseconds. Share it with an xUnit **collection fixture** and reset data between tests.
- **Ryuk**, a small sidecar container, removes your containers even if the test process crashes.
  Some rootless Podman setups need `TESTCONTAINERS_RYUK_DISABLED=true`; then *you* must dispose.

Combining both: the factory owns the container and implements `IAsyncLifetime`, so xUnit starts
the container **before** the first test touches `Services` or `CreateClient()` (which is when the
host is built, reading the connection string you injected with `UseSetting`).

```csharp
public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _db = new PostgreSqlBuilder("postgres:18").Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.UseSetting("ConnectionStrings:Db", _db.GetConnectionString());

    public async Task InitializeAsync()
    {
        await _db.StartAsync();
        using var scope = Services.CreateScope();             // builds the host now
        await scope.ServiceProvider.GetRequiredService<AppDbContext>().Database.MigrateAsync();
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();   // stop the app first (it holds pooled connections)…
        await _db.DisposeAsync();    // …then remove the database container
    }
}

[CollectionDefinition("api")]
public sealed class ApiCollection : ICollectionFixture<ApiFactory>;
```

`WebApplicationFactory` already has a public `DisposeAsync()` returning `ValueTask`; xUnit 2's
`IAsyncLifetime.DisposeAsync()` returns `Task`, hence the **explicit interface implementation**.

:::quiz id=be-15-q3 xp=10
Three test classes are all marked `[Collection("api")]`, and `ApiCollection : ICollectionFixture<ApiFactory>`.
Each class has 10 tests. How many Postgres containers start during `dotnet test`?
- [x] 1
- [ ] 3
- [ ] 30
- [ ] 31 — one per test plus one for migrations
> A collection fixture is created once for the whole collection and injected into every class in it. That's the point: pay the container start-up cost once. "3" would be right for an `IClassFixture<ApiFactory>` on each class, and "30" for a container created in each test's constructor, which is exactly the slow setup to avoid. (The trade-off: tests in one collection run sequentially.)
:::

## Isolating tests from each other

One shared database means test B can see the rows test A created. A test that asserts "the list
has 2 projects" fails depending on which tests ran before it. You need a reset strategy:

| Strategy | How | Pros | Cons |
|---|---|---|---|
| **Respawn** | Deletes all rows from your tables between tests (FK-aware ordering) | Simple, works with any app code, keeps schema | ~ms per reset; tests in a collection run sequentially |
| **Transaction rollback** | Begin a transaction per test, roll back at the end | Very fast | Breaks when the app opens its own transactions or uses several connections — which an HTTP test always does |
| **Database per test class** | `CREATE DATABASE t_x TEMPLATE migrated_template` | Full isolation, enables parallelism | More plumbing, more connections |
| **Unique data per test** | Every test uses fresh Guids/users and never asserts global counts | Zero reset cost | Discipline; "list all" assertions become hard |

**Respawn** is the common default. Create a `Respawner` once (it inspects the schema), then call
`ResetAsync` before each test:

```csharp
_respawner = await Respawner.CreateAsync(conn, new RespawnerOptions
{
    DbAdapter = DbAdapter.Postgres,
    SchemasToInclude = ["public"],
    TablesToIgnore = ["__EFMigrationsHistory"],   // keep the migration history!
});

await _respawner.ResetAsync(conn);   // before each test
```

Forgetting `TablesToIgnore = ["__EFMigrationsHistory"]` is a classic: the next `MigrateAsync`
thinks no migrations were applied and tries to create tables that already exist. Seed data that
every test needs (reference tables, a default plan) also goes in `TablesToIgnore`, or is
re-inserted after each reset.

In xUnit, hook the reset into the **test class's** `IAsyncLifetime.InitializeAsync`, which runs
before every test (remember: new instance per test):

```csharp
[Collection("api")]
public sealed class ProjectsEndpointTests(ApiFactory factory) : IAsyncLifetime
{
    public Task InitializeAsync() => factory.ResetDatabaseAsync();
    public Task DisposeAsync() => Task.CompletedTask;
}
```

:::quiz id=be-15-q4 xp=15
Why does the "wrap each test in a transaction and roll it back" approach usually **fail** for
`WebApplicationFactory` tests? (Select all that apply.)
- [x] The request is handled by a different DbContext (scoped to the request) on its own connection, which doesn't share the test's transaction
- [x] Endpoints that call `SaveChangesAsync` or `BeginTransactionAsync` commit or nest their own transactions
- [ ] PostgreSQL doesn't support rolling back transactions that inserted rows
- [x] Background services or a second request in the same test use other connections, which can't see uncommitted data
> Transaction rollback works when the test and the code under test share one connection — true for repository-level tests, false for HTTP tests where each request gets its own scope and connection from the pool. Respawn or per-test databases avoid the problem.
:::

## Authenticating test requests

Your real app validates JWTs from Keycloak (lesson be-13). Tests shouldn't depend on a running
identity provider, so you have three options, from most common to most realistic:

1. **A test authentication handler** that turns a header into a `ClaimsPrincipal`. Fast, lets
   each test choose the user, and exercises your *authorization* (policies, owner checks) for real.
2. **Real JWTs signed with a test key.** In `ConfigureTestServices`, `PostConfigure<JwtBearerOptions>`
   to accept tokens signed by a symmetric key the tests own, then mint tokens with
   `JsonWebTokenHandler`. Exercises claim mapping and token validation too.
3. **Real Keycloak** in a container (`Testcontainers.Keycloak`) for a handful of end-to-end tests
   of the login flow itself. Slow — keep it to a few tests.

The test handler:

```csharp
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Test";
    public const string UserHeader = "X-Test-User";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(UserHeader, out var userId) || string.IsNullOrEmpty(userId))
            return Task.FromResult(AuthenticateResult.NoResult());      // anonymous → 401 on protected endpoints

        Claim[] claims = [new("sub", userId.ToString()), new("name", $"Test {userId}")];
        var identity = new ClaimsIdentity(claims, SchemeName);          // authenticationType set → IsAuthenticated
        return Task.FromResult(AuthenticateResult.Success(
            new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }
}

// in ConfigureTestServices:
services.AddAuthentication(TestAuthHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, _ => { });
```

Calling `AddAuthentication("Test")` again makes `Test` the **default scheme** (the later
configuration wins), so `RequireAuthorization()` endpoints authenticate with it and JwtBearer is
never invoked — no network call to Keycloak.

:::warn title="Never ship the test handler"
Keep `TestAuthHandler` in the **test project** only. A header-based "auth" scheme that leaks into
production code (behind an `if (env.IsDevelopment())` that someone later flips) is a full
authentication bypass.
:::

:::quiz id=be-15-q5 xp=15
With the test handler above, what does each request return? Endpoint: `GET /projects/{id}`,
group has `.RequireAuthorization()`, the handler returns 404 for non-members.

1. No `X-Test-User` header
2. `X-Test-User: bob` for a project owned by alice (bob is not a member)
- [ ] 1 → 403, 2 → 403
- [x] 1 → 401, 2 → 404
- [ ] 1 → 401, 2 → 403
- [ ] 1 → 200, 2 → 404
> No header → `NoResult` → the user is anonymous → the authorization middleware *challenges* → 401. Bob is authenticated and passes `RequireAuthorization()` (it only requires an authenticated user), then the endpoint's own membership filter finds nothing and returns 404 — deliberately not 403, to avoid revealing that the project exists. A 403 would come from a failed *policy* for an authenticated user.
:::

## Testing migrations

Your integration fixture applies the real migrations with `MigrateAsync()` to an empty Postgres 18,
which already proves they run. Two more checks are cheap and catch real incidents:

```csharp
// 1. Nothing pending after migrating
(await db.Database.GetPendingMigrationsAsync()).ShouldBeEmpty();

// 2. Someone changed an entity but forgot `dotnet ef migrations add` (EF Core 9+)
db.Database.HasPendingModelChanges().ShouldBeFalse();
```

Since EF Core 9, `MigrateAsync()` itself refuses to run when the model has changes without a
migration (it throws for `PendingModelChangesWarning`), so with the fixture above a forgotten
migration fails the whole suite at start-up. Check 2 is still worth having: it fails with a
clearly named test, and it protects setups that create the schema differently (`EnsureCreated`,
SQL scripts) or that suppressed the warning. Without either guard, a renamed property compiles,
the unit tests pass, and production crashes with `column "title" does not exist` after deploy.

:::pro title="Testing data migrations"
Schema migrations are easy; *data* migrations (backfilling a column, splitting a table) are
where outages happen. Senior teams test them explicitly: migrate to the migration *before*
(`migrator.MigrateAsync("20261001_AddVersion")`), insert realistic legacy rows with raw SQL,
migrate to the latest, then assert on the transformed data. They also generate the SQL script
(`dotnet ef migrations script --idempotent`) in CI so a DBA or reviewer can read exactly what will
run against production.
:::

## Running in CI

GitHub-hosted Ubuntu runners have Docker, so Testcontainers just works:

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: 10.0.x
      - run: dotnet restore
      - run: dotnet build --no-restore -c Release
      - run: dotnet test --no-build -c Release --logger "trx;LogFileName=results.trx"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: "**/TestResults/*.trx"
```

Things that go wrong in CI and how teams handle them:

- **Image pulls are slow or rate-limited** → pull from a registry mirror, or pre-pull
  `postgres:18` in a setup step so the pull isn't counted against a test timeout.
- **Docker isn't available** (some locked-down runners, Windows agents) → run tests in a Linux
  container job, or use a remote Docker host (`DOCKER_HOST`).
- **Flaky timing** → never `Task.Delay(500)` and hope; poll for a condition with a timeout, or
  inject `FakeTimeProvider`.
- **Podman instead of Docker** locally → point `DOCKER_HOST` at the Podman socket
  (`unix:///run/user/1000/podman/podman.sock` after `systemctl --user start podman.socket`).

:::job title="What a mature API test suite looks like"
On a production SaaS codebase you'll typically find: one `ApiFactory` with a Postgres (and often
Redis) container shared by a collection; Respawn between tests; helpers like
`CreateClientFor("alice")`; builders for test data (`await Given.ProjectOwnedBy("alice")`); one
test class per feature/endpoint group; and a CI pipeline that runs the whole thing in 1–3 minutes
on every pull request. New endpoints without a happy-path and a 401/403/404/409 test don't get
merged.
:::

## Lab: a real integration test suite

:::lab id=be-15-lab1 xp=150
title: Projects API against real PostgreSQL 18

You'll build a small Projects API (EF Core + Npgsql + JWT bearer) with a real migration, then an
integration test project that boots it with `WebApplicationFactory`, runs it against
**PostgreSQL 18 in Testcontainers**, authenticates with a test handler, resets with Respawn and
verifies migrations.

**Prerequisites:** .NET 10 SDK and a running Docker (Docker Desktop, or Podman with
`DOCKER_HOST` set as above). Check with `docker run --rm hello-world`.

**1. Scaffold:**

```bash
mkdir -p ~/devquest/be-15-lab1 && cd ~/devquest/be-15-lab1
dotnet new sln -n Projects
dotnet new web -o src/Projects.Api
dotnet new xunit -o tests/Projects.Api.Tests
dotnet sln add src/Projects.Api tests/Projects.Api.Tests
dotnet add tests/Projects.Api.Tests reference src/Projects.Api

dotnet add src/Projects.Api package Npgsql.EntityFrameworkCore.PostgreSQL
dotnet add src/Projects.Api package Microsoft.EntityFrameworkCore.Relational
dotnet add src/Projects.Api package Microsoft.EntityFrameworkCore.Design
dotnet add src/Projects.Api package Microsoft.AspNetCore.Authentication.JwtBearer

dotnet add tests/Projects.Api.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet add tests/Projects.Api.Tests package Testcontainers.PostgreSql
dotnet add tests/Projects.Api.Tests package Respawn
dotnet add tests/Projects.Api.Tests package Shouldly
rm tests/Projects.Api.Tests/UnitTest1.cs

dotnet new tool-manifest
dotnet tool install dotnet-ef
```

:::info title="Why add EntityFrameworkCore.Relational explicitly?"
`Microsoft.EntityFrameworkCore.Design` is the newest EF patch (e.g. 10.0.14) but is marked
`PrivateAssets=all`, so it doesn't flow to the test project. The Npgsql provider may depend on an
older EF patch (e.g. 10.0.4). The test project would then compile against the older EF while
`Projects.Api.dll` was built against the newer one, and you'd get error **CS1705**. Referencing
`Relational` directly in the API lifts every project to the same EF version.
:::

**2. The data model.** Create:

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

public class AppDbContext(DbContextOptions<AppDbContext> options) : DbContext(options)
{
    public DbSet<Project> Projects => Set<Project>();
    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Project>(e =>
        {
            e.ToTable("projects");
            e.Property(p => p.Name).HasMaxLength(80);
            e.HasMany(p => p.Members).WithOne().HasForeignKey(m => m.ProjectId);
        });
        b.Entity<ProjectMember>(e =>
        {
            e.ToTable("project_members");
            e.HasKey(m => new { m.ProjectId, m.UserId });
            e.Property(m => m.Role).HasConversion<string>().HasMaxLength(16);
        });
    }
}
```

**3. The API.** Replace `src/Projects.Api/Program.cs`:

`src/Projects.Api/Program.cs`

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.EntityFrameworkCore;
using Projects.Api;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Db")));

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = builder.Configuration["Auth:Authority"];   // e.g. Keycloak realm URL
        o.Audience = builder.Configuration["Auth:Audience"];
        o.MapInboundClaims = false;                              // keep "sub" as "sub"
    });
builder.Services.AddAuthorization();
builder.Services.AddProblemDetails();
builder.Services.AddSingleton(TimeProvider.System);

var app = builder.Build();

app.UseAuthentication();
app.UseAuthorization();

var projects = app.MapGroup("/projects").RequireAuthorization();

projects.MapPost("/", async (CreateProjectRequest req, ClaimsPrincipal user, AppDbContext db,
    TimeProvider time, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(req.Name) || req.Name.Trim().Length is < 3 or > 80)
        return Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["name"] = ["Name must be 3-80 characters."]
        });

    var userId = user.FindFirstValue("sub")!;
    var project = new Project
    {
        Id = Guid.CreateVersion7(),
        Name = req.Name.Trim(),
        OwnerId = userId,
        CreatedAt = time.GetUtcNow(),
        Members = [new ProjectMember { UserId = userId, Role = ProjectRole.Owner }]
    };
    db.Projects.Add(project);
    await db.SaveChangesAsync(ct);

    return Results.Created($"/projects/{project.Id}", ProjectDto.From(project));
});

projects.MapGet("/", async (ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var userId = user.FindFirstValue("sub")!;
    var list = await db.Projects
        .Where(p => p.Members.Any(m => m.UserId == userId))
        .OrderBy(p => p.Name)
        .Select(p => new ProjectDto(p.Id, p.Name, p.OwnerId, p.Version))
        .ToListAsync(ct);
    return Results.Ok(list);
});

projects.MapGet("/{id:guid}", async (Guid id, ClaimsPrincipal user, AppDbContext db, CancellationToken ct) =>
{
    var userId = user.FindFirstValue("sub")!;
    var dto = await db.Projects
        .Where(p => p.Id == id && p.Members.Any(m => m.UserId == userId))
        .Select(p => new ProjectDto(p.Id, p.Name, p.OwnerId, p.Version))
        .FirstOrDefaultAsync(ct);
    // 404 (not 403) for non-members: don't reveal that the project exists.
    return dto is null ? Results.NotFound() : Results.Ok(dto);
});

app.Run();

public record CreateProjectRequest(string Name);

public record ProjectDto(Guid Id, string Name, string OwnerId, int Version)
{
    public static ProjectDto From(Project p) => new(p.Id, p.Name, p.OwnerId, p.Version);
}

public partial class Program;
```

Replace `src/Projects.Api/appsettings.json`:

`src/Projects.Api/appsettings.json`

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  },
  "AllowedHosts": "*",
  "ConnectionStrings": {
    "Db": "Host=localhost;Port=5432;Database=projects;Username=postgres;Password=postgres"
  },
  "Auth": {
    "Authority": "http://localhost:8080/realms/devquest",
    "Audience": "projects-api"
  }
}
```

**4. Create the migration** (no database needed for this step):

```bash
dotnet ef migrations add Initial --project src/Projects.Api
```

Expected: `Build succeeded.` then `Done. To undo this action, use 'ef migrations remove'`, and a
`src/Projects.Api/Migrations/` folder with three files.

**5. The test infrastructure.** Create these files in `tests/Projects.Api.Tests/`.

`tests/Projects.Api.Tests/TestAuthHandler.cs`

```csharp
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Projects.Api.Tests;

/// Authenticates any request that carries an "X-Test-User" header. No header → anonymous (401).
public sealed class TestAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Test";
    public const string UserHeader = "X-Test-User";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(UserHeader, out var userId) || string.IsNullOrEmpty(userId))
            return Task.FromResult(AuthenticateResult.NoResult());

        Claim[] claims = [new("sub", userId.ToString()), new("name", $"Test {userId}")];
        var identity = new ClaimsIdentity(claims, SchemeName);
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName);
        return Task.FromResult(AuthenticateResult.Success(ticket));
    }
}
```

`tests/Projects.Api.Tests/ApiFactory.cs`

```csharp
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Respawn;
using Testcontainers.PostgreSql;

namespace Projects.Api.Tests;

public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _db = new PostgreSqlBuilder("postgres:18").Build();
    private Respawner _respawner = null!;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Point the app at the throw-away container instead of appsettings.json.
        builder.UseSetting("ConnectionStrings:Db", _db.GetConnectionString());
        builder.UseEnvironment("Testing");

        builder.ConfigureTestServices(services =>
        {
            // Replace JWT bearer with our header-based test scheme.
            services.AddAuthentication(TestAuthHandler.SchemeName)
                .AddScheme<AuthenticationSchemeOptions, TestAuthHandler>(TestAuthHandler.SchemeName, _ => { });
        });
    }

    public async Task InitializeAsync()
    {
        await _db.StartAsync();

        // Apply the REAL migrations — this is also a test that they work on Postgres 18.
        using (var scope = Services.CreateScope())
        {
            var ctx = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await ctx.Database.MigrateAsync();
        }

        await using var conn = new NpgsqlConnection(_db.GetConnectionString());
        await conn.OpenAsync();
        _respawner = await Respawner.CreateAsync(conn, new RespawnerOptions
        {
            DbAdapter = DbAdapter.Postgres,
            SchemasToInclude = ["public"],
            TablesToIgnore = ["__EFMigrationsHistory"],
        });
    }

    public async Task ResetDatabaseAsync()
    {
        await using var conn = new NpgsqlConnection(_db.GetConnectionString());
        await conn.OpenAsync();
        await _respawner.ResetAsync(conn);
    }

    public HttpClient CreateClientFor(string userId)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add(TestAuthHandler.UserHeader, userId);
        return client;
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();   // stop the test host first
        await _db.DisposeAsync();    // then stop and remove the container
    }
}

[CollectionDefinition(Name)]
public sealed class ApiCollection : ICollectionFixture<ApiFactory>
{
    public const string Name = "api";
}
```

**6. The tests.**

`tests/Projects.Api.Tests/ProjectsEndpointTests.cs`

```csharp
using System.Net;
using System.Net.Http.Json;
using Shouldly;

namespace Projects.Api.Tests;

[Collection(ApiCollection.Name)]
public sealed class ProjectsEndpointTests(ApiFactory factory) : IAsyncLifetime
{
    public Task InitializeAsync() => factory.ResetDatabaseAsync();   // clean slate per test
    public Task DisposeAsync() => Task.CompletedTask;

    [Fact]
    public async Task Anonymous_requests_get_401()
    {
        var anon = factory.CreateClient();

        var response = await anon.GetAsync("/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Create_then_get_round_trips_through_postgres()
    {
        var alice = factory.CreateClientFor("alice");

        var created = await alice.PostAsJsonAsync("/projects", new { name = "Apollo" });

        created.StatusCode.ShouldBe(HttpStatusCode.Created);
        var dto = await created.Content.ReadFromJsonAsync<ProjectDto>();
        dto.ShouldNotBeNull();
        dto.Name.ShouldBe("Apollo");
        dto.OwnerId.ShouldBe("alice");
        dto.Version.ShouldBe(1);
        created.Headers.Location!.ToString().ShouldBe($"/projects/{dto.Id}");

        var fetched = await alice.GetFromJsonAsync<ProjectDto>($"/projects/{dto.Id}");
        fetched.ShouldBe(dto);
    }

    [Fact]
    public async Task Invalid_name_returns_validation_problem()
    {
        var alice = factory.CreateClientFor("alice");

        var response = await alice.PostAsJsonAsync("/projects", new { name = "x" });

        response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
        response.Content.Headers.ContentType!.MediaType.ShouldBe("application/problem+json");
    }

    [Fact]
    public async Task Other_users_cannot_see_the_project()
    {
        var alice = factory.CreateClientFor("alice");
        var bob = factory.CreateClientFor("bob");
        var created = await alice.PostAsJsonAsync("/projects", new { name = "Secret" });
        var dto = (await created.Content.ReadFromJsonAsync<ProjectDto>())!;

        var response = await bob.GetAsync($"/projects/{dto.Id}");
        var bobsList = await bob.GetFromJsonAsync<List<ProjectDto>>("/projects");

        response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
        bobsList.ShouldBeEmpty();
    }

    [Fact]
    public async Task List_only_contains_my_projects_sorted_by_name()
    {
        var alice = factory.CreateClientFor("alice");
        var bob = factory.CreateClientFor("bob");
        await alice.PostAsJsonAsync("/projects", new { name = "Zeta" });
        await alice.PostAsJsonAsync("/projects", new { name = "Alpha" });
        await bob.PostAsJsonAsync("/projects", new { name = "Bob's" });

        var list = await alice.GetFromJsonAsync<List<ProjectDto>>("/projects");

        list!.Select(p => p.Name).ShouldBe(["Alpha", "Zeta"]);
    }
}
```

`tests/Projects.Api.Tests/MigrationTests.cs`

```csharp
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Shouldly;

namespace Projects.Api.Tests;

[Collection(ApiCollection.Name)]
public sealed class MigrationTests(ApiFactory factory)
{
    [Fact]
    public async Task All_migrations_are_applied()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var pending = await db.Database.GetPendingMigrationsAsync();

        pending.ShouldBeEmpty();
    }

    [Fact]
    public void Model_has_no_changes_missing_a_migration()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        // Fails when someone changed an entity but forgot `dotnet ef migrations add`.
        db.Database.HasPendingModelChanges().ShouldBeFalse();
    }
}
```

**7. Run it:**

```bash
dotnet test
```

The first run pulls `postgres:18` (can take a minute). Expected summary:

```text
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7, Duration: 450 ms - Projects.Api.Tests.dll (net10.0)
```

While the tests run, `docker ps` shows a `postgres:18` container on a random port; afterwards it's gone.

:::tip title="Podman users"
Start the socket with `systemctl --user start podman.socket`, then
`export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock`. If Ryuk can't start, also
`export TESTCONTAINERS_RYUK_DISABLED=true` (the factory disposes the container itself).
:::

**8. Prove the safety nets work.** Do each, run `dotnet test`, see the expected failure, undo:

1. In `ProjectsEndpointTests`, replace `factory.ResetDatabaseAsync()` with `Task.CompletedTask`.
   Now rows from earlier tests leak into later ones, and at least one test fails (typically
   `Other_users_cannot_see_the_project`, because bob's list is no longer empty). Which test fails
   depends on execution order, and that flakiness is exactly what the reset prevents. Restore it.
2. Add `public string? Description { get; set; }` to `Project` **without** creating a migration.
   Every test now fails during fixture start-up: EF Core 9+ `MigrateAsync` throws
   `PendingModelChangesWarning ... has pending changes. Add a new migration before updating the database.`
   Run `dotnet ef migrations add AddDescription --project src/Projects.Api` and watch the suite go
   green again (then keep or remove the property and migration, your choice).
3. Remove `.RequireAuthorization()` from the group. `Anonymous_requests_get_401` fails: the
   anonymous request now gets **200 with an empty list**, because the code reads a missing `sub`
   claim as `null` and quietly matches nothing. A security hole that "works". Put it back.

**9. Your turn.** Add a test `Name_is_trimmed_before_saving`: POST `"  Apollo  "` as alice and
assert the stored project's name (via `GET /projects/{id}`) is `"Apollo"`.

- [ ] `dotnet test` shows 7 passing tests against a real `postgres:18` container
- [ ] Removing the per-test reset makes results depend on test order (and I restored it)
- [ ] Adding a property without a migration makes the suite fail with `PendingModelChangesWarning`, and adding the migration fixes it
- [ ] Removing `RequireAuthorization()` turns `Anonymous_requests_get_401` red
- [ ] My `Name_is_trimmed_before_saving` test passes
:::

## More "what happens?"

:::quiz id=be-15-q6 xp=15
Spot the bug. `MigrateAsync` fails on the *second* test class
with `relation "projects" already exists`.

```csharp
_respawner = await Respawner.CreateAsync(conn, new RespawnerOptions
{
    DbAdapter = DbAdapter.Postgres,
    SchemasToInclude = ["public"],
});
// ...and each test class's InitializeAsync does:
await factory.ResetDatabaseAsync();
await db.Database.MigrateAsync();
```
- [ ] Respawn drops all tables, so the migration must be recreated
- [x] Respawn also emptied `__EFMigrationsHistory`, so EF thinks no migration ran and tries to create existing tables — add it to `TablesToIgnore` (and migrate once in the fixture, not per class)
- [ ] `SchemasToInclude` must list `pg_catalog`
- [ ] Postgres 18 doesn't support `MigrateAsync` from multiple classes
> Respawn deletes **rows**, not tables. With the history table emptied, EF's migrator believes the database is fresh and runs `CREATE TABLE projects` again. Always ignore `__EFMigrationsHistory`, and run migrations once per container.
:::

:::quiz id=be-15-q7 xp=10
Which of these should you replace with a fake in an integration test? (Select all that apply.)
- [x] The service that sends emails via SMTP/SendGrid
- [ ] `AppDbContext`
- [x] `TimeProvider`, when a test needs a specific date (e.g. "share link expired")
- [ ] The authorization policies that check project roles
- [x] The JWT bearer authentication scheme (replaced by a test scheme or test-signed tokens)
> Replace what leaves the process or isn't deterministic: outbound email, the clock, the external identity provider. Note that replacing the JWT *scheme* only changes how the user is identified; your authorization policies still run for real. Faking `AppDbContext` or the policies would remove exactly the behaviour (SQL, constraints, 403/404 rules) integration tests are for.
:::

## Flashcards

:::cards id=be-15-cards1 xp=20 title="Integration testing ASP.NET Core"
Q: What does `WebApplicationFactory<Program>` do?
A: Boots your real app (DI, middleware, endpoints) on an in-memory TestServer; `CreateClient()` returns an HttpClient wired to it — no ports or network.
Q: Why does the test project need `public partial class Program;`?
A: The top-level-statements `Program` is internal on .NET 8/9. On .NET 10 the Web SDK generates the public declaration automatically; declaring it is harmless.
Q: `ConfigureServices` vs `ConfigureTestServices` in the factory?
A: `ConfigureTestServices` runs after the app's own registrations, so replacements win. Pair with `RemoveAll<T>()`.
Q: Why not EF Core InMemory or SQLite for API tests?
A: They don't behave like Postgres: missing/different constraints, transactions, SQL dialect, jsonb/xmin/locking — tests pass while production fails.
Q: Container per test or per run?
A: Per run (or per collection) via `ICollectionFixture`. Start-up costs seconds; reset data between tests instead.
Q: What does Respawn do, and what must you ignore?
A: Deletes rows from all tables in FK-safe order between tests. Ignore `__EFMigrationsHistory` (and static seed tables).
Q: Why doesn't transaction-rollback isolation work for HTTP tests?
A: Each request has its own scope/DbContext/connection, which doesn't share the test's transaction; app code also commits its own transactions.
Q: How do you authenticate test requests without Keycloak?
A: Register a test `AuthenticationHandler` as the default scheme (e.g. user id from a header), or accept JWTs signed with a test key via `PostConfigure<JwtBearerOptions>`.
Q: How do you catch a forgotten migration?
A: A test asserting `db.Database.HasPendingModelChanges()` is false (EF Core 9+), plus `GetPendingMigrationsAsync()` empty after migrating.
Q: Why does `ApiFactory` implement `IAsyncLifetime.DisposeAsync` explicitly?
A: `WebApplicationFactory` already has `ValueTask DisposeAsync()`; xUnit 2's interface needs `Task DisposeAsync()`, so the explicit implementation avoids the clash (dispose the host via base, then the container).
:::

## Recap

- Integration tests exercise the seams where API bugs live: routing, binding, auth, SQL,
  constraints, migrations, serialization.
- `WebApplicationFactory<Program>` runs the real app in memory; customize with `UseSetting`,
  `UseEnvironment` and `ConfigureTestServices` + `RemoveAll`. Replace only what leaves the process.
- Use a **real PostgreSQL 18** via Testcontainers, one container per run via a collection fixture
  — not InMemory/SQLite.
- Reset between tests with **Respawn** (ignore `__EFMigrationsHistory`); transaction rollback
  doesn't work across HTTP requests.
- Authenticate with a test auth handler (test project only!) or test-signed JWTs; assert 401 vs
  403 vs 404 deliberately.
- Apply migrations in the fixture and assert `HasPendingModelChanges()` is false.
- CI: Docker-capable runners, pinned images, no sleeps — poll or fake time.
