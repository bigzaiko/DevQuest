---
id: cap-09
title: Quality Gates — Tests at Every Level and CI
level: expert
minutes: 330
xp: 250
summary: xUnit and Vitest for the pure core, Testcontainers for the queue's locking rules, Playwright with an axe accessibility gate for real flows, risk-based coverage thresholds, and a GitHub Actions pipeline that runs all of it against a Postgres service container.
---

BranchStory now has every risky thing a SaaS has: concurrent writers, a job queue, real-time
fan-out, public pages and quotas. This lesson turns "it worked when I clicked it" into
**gates**: automated checks that must be green before anything merges.

## A test portfolio, not a pyramid poster

Pick the *cheapest test that can actually catch the bug*. For BranchStory that maps out like this:

| Risk | Cheapest test that catches it | Tool |
|---|---|---|
| Player JSON leaks a draft scene or a `javascript:` URL | unit test of the pure `PlayerBuilder` | xUnit |
| Backoff grows wrong, never caps | unit test with injected jitter | xUnit |
| Reducer leaves an edge pointing at a deleted node | invariant test over random action sequences | Vitest |
| Player page traps keyboard users | component test with Testing Library | Vitest + RTL |
| Two workers claim the same job | concurrent claims against **real Postgres** | xUnit + Testcontainers |
| Stale save overwrites a newer version | API integration test (cap-04) | WebApplicationFactory |
| Publish → worker → SignalR → player link actually works | one end-to-end journey | Playwright |
| A screen is unusable with a screen reader | axe scan of every main surface | @axe-core/playwright |

Notice what is **not** in the table: unit tests with a mocked `NpgsqlConnection` for `JobStore`.
The value of that code is the SQL's locking behaviour, and a mock cannot tell you whether
`SKIP LOCKED` works. Test SQL against the database it runs on.

:::pro title="Coverage that matters"
A global "80 % line coverage" target rewards testing getters and punishes nobody for skipping the
queue. Real teams set **high thresholds on the core modules** (domain logic, reducers, builders,
authorization rules), track the rest without a gate, and for the few functions where a bug costs
money (quota, permissions) they check that the tests catch deliberately broken versions. That is
mutation testing, and it is exactly what the two "write the tests" challenges below make you do.
:::

## Lab 1: unit tests for the pure core

:::lab id=cap-09-lab1 xp=100
title: xUnit tests for PlayerBuilder, Slug and Backoff with a coverage gate

**1. Create the project**

```bash
dotnet new xunit -n BranchStory.UnitTests -o tests/BranchStory.UnitTests
rm tests/BranchStory.UnitTests/UnitTest1.cs
dotnet sln add tests/BranchStory.UnitTests
```

Depending on your SDK, the built-in `xunit` template may still create an xUnit **v2** project.
BranchStory uses **xUnit v3** everywhere, as in cap-03's API tests. Whatever the template produced,
replace `tests/BranchStory.UnitTests/BranchStory.UnitTests.csproj` completely:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <OutputType>Exe</OutputType>   <!-- xUnit v3 test projects are executables -->
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.*" />
    <PackageReference Include="xunit.v3" Version="3.*" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.*" />
    <PackageReference Include="coverlet.msbuild" Version="6.*" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <!-- The worker is an ASP.NET Core app. Sharing its framework makes NuGet resolve the
         Microsoft.Extensions.* packages the same way (otherwise: NU1605 package downgrade). -->
    <FrameworkReference Include="Microsoft.AspNetCore.App" />
    <ProjectReference Include="..\..\worker\BranchStory.Worker\BranchStory.Worker.csproj" />
  </ItemGroup>

  <!-- step 2 goes here -->

</Project>
```

**2. Coverage gate on the modules that matter**

Two coverage numbers matter. **Line coverage** asks whether each line ran at least once.
**Branch coverage** asks whether each side of every decision ran: both outcomes of an `if`, both
sides of `??`, every `switch` arm. A function can have 100 % line coverage and 50 % branch
coverage if a test only ever takes the `true` side of a one-line `cond ? a : b`.

`coverlet.msbuild` instruments the assemblies during `dotnet test` and fails the run when a
threshold is missed. Add this where the comment says *step 2*:

```xml
<PropertyGroup Condition="'$(CollectCoverage)' == 'true'">
  <CoverletOutputFormat>cobertura</CoverletOutputFormat>
  <CoverletOutput>$(MSBuildThisFileDirectory)../../coverage/unit/</CoverletOutput>
  <!-- Gate only the pure core: the DB-facing code is covered by integration tests instead.
       The trailing * also includes compiler-generated nested types (lambdas, iterators). -->
  <Include>[BranchStory.Worker]BranchStory.Worker.Publishing.PlayerBuilder*,[BranchStory.Worker]BranchStory.Worker.Publishing.Slug*,[BranchStory.Worker]BranchStory.Worker.Jobs.Backoff*</Include>
  <Threshold>95,90</Threshold>
  <ThresholdType>line,branch</ThresholdType>
</PropertyGroup>
```

The `Condition` means plain `dotnet test` stays fast. Coverage and the gate only switch on
with `-p:CollectCoverage=true`, the way CI calls it in Lab 5.

**3. `tests/BranchStory.UnitTests/PlayerBuilderTests.cs`**

```csharp
using System.Text.Json;
using BranchStory.Worker.Jobs;
using BranchStory.Worker.Publishing;

namespace BranchStory.UnitTests;

public class PlayerBuilderTests
{
    private const string Doc = """
        {
          "startNodeId": "a",
          "nodes": [
            { "id": "a", "title": " Gate ", "text": "Two paths.", "mediaUrl": "https://cdn.example.com/gate.jpg", "x": 10, "y": 20 },
            { "id": "b", "title": "Forest", "text": "Dark.", "mediaUrl": "javascript:alert(1)" },
            { "id": "c", "title": "River", "text": "Wet." },
            { "id": "draft", "title": "Unfinished", "text": "todo" }
          ],
          "edges": [
            { "id": "e1", "from": "a", "to": "b", "label": "Go left" },
            { "id": "e2", "from": "a", "to": "c", "label": "   " },
            { "id": "e3", "from": "draft", "to": "a", "label": "Back to the gate" }
          ]
        }
        """;

    [Fact]
    public void Ships_only_scenes_reachable_from_the_start()
    {
        var player = PlayerBuilder.Build("The Gate", 7, Doc);

        Assert.Equal(new[] { "a", "b", "c" }, player.Scenes.Keys.Order());
        Assert.Equal("a", player.Start);
        Assert.Equal(7, player.Version);
        Assert.Equal(1, player.Format);
    }

    [Fact]
    public void Choices_keep_their_order_and_get_a_fallback_label()
    {
        var gate = PlayerBuilder.Build("The Gate", 1, Doc).Scenes["a"];

        Assert.Collection(gate.Choices,
            c => { Assert.Equal("Go left", c.Label); Assert.Equal("b", c.To); },
            c => { Assert.Equal("Choice 2", c.Label); Assert.Equal("c", c.To); });
        Assert.False(gate.End);
        Assert.Equal("Gate", gate.Title);
    }

    [Fact]
    public void Scenes_without_choices_are_endings()
    {
        var player = PlayerBuilder.Build("The Gate", 1, Doc);
        Assert.True(player.Scenes["b"].End);
        Assert.True(player.Scenes["c"].End);
    }

    [Fact]
    public void Unsafe_media_urls_never_reach_the_public_player()
    {
        var player = PlayerBuilder.Build("The Gate", 1, Doc);
        Assert.Equal("https://cdn.example.com/gate.jpg", player.Scenes["a"].Media);
        Assert.Null(player.Scenes["b"].Media);
    }

    [Theory]
    [InlineData("https://cdn.example.com/a.mp4", "https://cdn.example.com/a.mp4")]
    [InlineData("http://localhost:9000/a.png", "http://localhost:9000/a.png")]
    [InlineData("javascript:alert(1)", null)]
    [InlineData("data:image/png;base64,AAAA", null)]
    [InlineData("/relative.png", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void SafeMediaUrl_allows_only_absolute_http_urls(string? input, string? expected) =>
        Assert.Equal(expected, PlayerBuilder.SafeMediaUrl(input));

    [Theory]
    [InlineData("""{ "startNodeId": "x", "nodes": [{ "id": "a" }], "edges": [] }""", "start")]
    [InlineData("""{ "startNodeId": "a", "nodes": [], "edges": [] }""", "no scenes")]
    [InlineData("""{ "startNodeId": "a", "nodes": [{ "id": "a" }, { "id": "a" }] }""", "duplicated")]
    [InlineData("""{ "startNodeId": "a", "nodes": [{ "id": "a" }], "edges": [{ "id": "e", "from": "a", "to": "ghost" }] }""", "missing scene")]
    [InlineData("""{ not json""", "not valid JSON")]
    [InlineData("null", "no scenes")]
    [InlineData("""{ "nodes": [{ "id": "a" }] }""", "start")]
    public void Invalid_documents_fail_permanently(string doc, string reason)
    {
        var ex = Assert.Throws<PermanentJobException>(() => PlayerBuilder.Build("x", 1, doc));
        Assert.Contains(reason, ex.Message);
    }

    [Fact]
    public void A_minimal_story_is_a_single_ending()
    {
        var player = PlayerBuilder.Build("Tiny", 1, """{ "startNodeId": "a", "nodes": [{ "id": "a" }] }""");
        var only = Assert.Single(player.Scenes).Value;
        Assert.True(only.End);
        Assert.Equal("", only.Title);
        Assert.Equal("", only.Text);
        Assert.Null(only.Media);
    }

    [Fact]
    public void Output_is_deterministic_so_republishing_is_idempotent()
    {
        var a = JsonSerializer.Serialize(PlayerBuilder.Build("The Gate", 3, Doc), PlayerJson.Options);
        var b = JsonSerializer.Serialize(PlayerBuilder.Build("The Gate", 3, Doc), PlayerJson.Options);
        Assert.Equal(a, b);
        Assert.DoesNotContain("draft", a);
        Assert.DoesNotContain("\"x\"", a);
    }
}
```

**4. `tests/BranchStory.UnitTests/SlugAndBackoffTests.cs`**

```csharp
using BranchStory.Worker.Jobs;
using BranchStory.Worker.Publishing;

namespace BranchStory.UnitTests;

public class SlugTests
{
    private static readonly Guid Id = Guid.Parse("3f2a9c1b-0000-4000-8000-000000000000");

    [Theory]
    [InlineData("The Forest", "the-forest-3f2a9c1b")]
    [InlineData("Der Wald, Teil 2!", "der-wald-teil-2-3f2a9c1b")]
    [InlineData("Café   Noir", "cafe-noir-3f2a9c1b")]
    [InlineData("!!!", "story-3f2a9c1b")]
    [InlineData("", "story-3f2a9c1b")]
    public void Builds_url_safe_unique_slugs(string title, string expected) =>
        Assert.Equal(expected, Slug.For(title, Id));

    [Fact]
    public void Long_titles_are_cut()
    {
        var slug = Slug.For(new string('a', 200), Id);
        Assert.True(slug.Length <= 40 + 1 + 8, slug);
    }
}

public class BackoffTests
{
    private static readonly TimeSpan Base = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan Max = TimeSpan.FromMinutes(5);

    [Theory]
    [InlineData(1, 0.0, 1_000)]     // exp 2 s → [1 s, 2 s]
    [InlineData(1, 1.0, 2_000)]
    [InlineData(2, 0.0, 2_000)]     // exp 4 s
    [InlineData(4, 0.5, 12_000)]    // exp 16 s → 8 + 4
    [InlineData(30, 0.0, 150_000)]  // capped at 5 min → [2.5 min, 5 min]
    [InlineData(30, 1.0, 300_000)]
    public void Grows_exponentially_with_equal_jitter_and_a_cap(int attempt, double jitter, double expectedMs) =>
        Assert.Equal(expectedMs, Backoff.Compute(attempt, Base, Max, jitter).TotalMilliseconds, precision: 3);

    [Fact]
    public void Jitter_outside_0_1_is_clamped() =>
        Assert.Equal(2_000, Backoff.Compute(1, Base, Max, 5.0).TotalMilliseconds, precision: 3);

    [Fact]
    public void Attempt_is_one_based() =>
        Assert.Throws<ArgumentOutOfRangeException>(() => Backoff.Compute(0, Base, Max, 0));
}
```

**5. Run, then run with the gate**

```bash
dotnet test tests/BranchStory.UnitTests
dotnet test tests/BranchStory.UnitTests -p:CollectCoverage=true
```

Now break something on purpose: delete the `SafeMediaUrl` call in `PlayerBuilder` (use
`n.MediaUrl` directly). The test suite goes red. Restore it. Then comment out the
`Invalid_documents_fail_permanently` theory: every validation branch is now unexecuted and the
coverage gate fails the run. That is the gate doing its job: it notices *missing* tests.

If the gate is red with all tests present, open `coverage/unit/coverage.cobertura.xml` (or run
`dotnet tool install -g dotnet-reportgenerator-globaltool` and render HTML) and look at the
uncovered branches: usually a `?.` or `??` on a path no test takes. Add the test, not an exclusion.

- [ ] All unit tests pass in under 2 seconds
- [ ] `-p:CollectCoverage=true` writes `coverage/unit/coverage.cobertura.xml` and passes the 95 % line / 90 % branch gate
- [ ] Removing the URL sanitizer makes at least one test fail
- [ ] Commenting out the invalid-document theory makes the coverage gate fail
:::

## Lab 2: integration tests for the queue's locking rules

:::lab id=cap-09-lab2 xp=120
title: Prove with real Postgres that two claimers never get the same job

The fixture runs against **Testcontainers** on your laptop, and against the **CI service
container** when `BRANCHSTORY_TEST_DB` is set. Same tests, no Docker-in-Docker in CI, no
"works on my machine" schema: both paths apply the real EF Core migrations.

**1. Create the project**

```bash
dotnet new xunit -n BranchStory.Worker.IntegrationTests -o tests/BranchStory.Worker.IntegrationTests
rm tests/BranchStory.Worker.IntegrationTests/UnitTest1.cs
dotnet sln add tests/BranchStory.Worker.IntegrationTests
```

Replace `tests/BranchStory.Worker.IntegrationTests/BranchStory.Worker.IntegrationTests.csproj`
completely. It is the same xUnit v3 setup as Lab 1, without coverlet and with Testcontainers:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <OutputType>Exe</OutputType>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.*" />
    <PackageReference Include="xunit.v3" Version="3.*" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.*" />
    <PackageReference Include="Testcontainers.PostgreSql" Version="4.*" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\..\worker\BranchStory.Worker\BranchStory.Worker.csproj" />
    <ProjectReference Include="..\..\api\BranchStory.Data\BranchStory.Data.csproj" />
  </ItemGroup>

</Project>
```

**2. `tests/BranchStory.Worker.IntegrationTests/PostgresFixture.cs`**

It applies the real migrations through cap-02's `BranchStoryDbContext` (with the same
snake_case naming convention), so the tests see exactly the schema production has. A
hand-written `CREATE TABLE` in the test would drift from the real one the first time someone
adds a column or a constraint.

A **collection fixture** is xUnit's way to share one expensive object, here the database, across
several test classes: it is created once before the first test of the collection and disposed
after the last. xUnit v3's `IAsyncLifetime` uses `ValueTask` for both methods.

```csharp
using BranchStory.Data;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using Testcontainers.PostgreSql;

namespace BranchStory.Worker.IntegrationTests;

public sealed class PostgresFixture : IAsyncLifetime
{
    private PostgreSqlContainer? _container;

    public NpgsqlDataSource DataSource { get; private set; } = null!;

    public async ValueTask InitializeAsync()
    {
        var connectionString = Environment.GetEnvironmentVariable("BRANCHSTORY_TEST_DB");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            _container = new PostgreSqlBuilder("postgres:18").Build();
            await _container.StartAsync();
            connectionString = _container.GetConnectionString();
        }

        // The real migrations from cap-02: jobs with its CHECK constraints and indexes, published_stories, …
        var options = new DbContextOptionsBuilder<BranchStoryDbContext>()
            .UseNpgsql(connectionString).UseSnakeCaseNamingConvention().Options;
        await using (var db = new BranchStoryDbContext(options))
            await db.Database.MigrateAsync();

        DataSource = NpgsqlDataSource.Create(connectionString);
    }

    public async ValueTask DisposeAsync()
    {
        if (DataSource is not null) await DataSource.DisposeAsync();
        if (_container is not null) await _container.DisposeAsync();
    }

    public async Task ExecAsync(string sql, params (string Name, object Value)[] parameters)
    {
        await using var cmd = DataSource.CreateCommand(sql);
        foreach (var (name, value) in parameters) cmd.Parameters.AddWithValue(name, value);
        await cmd.ExecuteNonQueryAsync();
    }

    public async Task<T> ScalarAsync<T>(string sql, params (string Name, object Value)[] parameters)
    {
        await using var cmd = DataSource.CreateCommand(sql);
        foreach (var (name, value) in parameters) cmd.Parameters.AddWithValue(name, value);
        return (T)(await cmd.ExecuteScalarAsync())!;
    }

    /// <summary>
    /// Inserts queued jobs without creating users/projects first. session_replication_role = replica
    /// disables FK triggers for this transaction only (needs a superuser, which test databases are).
    /// </summary>
    public async Task SeedQueuedJobsAsync(int count, string kind = "test", int maxAttempts = 5)
    {
        await using var conn = await DataSource.OpenConnectionAsync();
        await using var tx = await conn.BeginTransactionAsync();
        await using (var off = new NpgsqlCommand("SET LOCAL session_replication_role = replica", conn, tx))
            await off.ExecuteNonQueryAsync();
        await using (var insert = new NpgsqlCommand("""
            INSERT INTO jobs (kind, project_id, payload, status, attempts, max_attempts, run_after,
                              idempotency_key, created_at, updated_at)
            SELECT @kind, gen_random_uuid(), '{}'::jsonb, 'queued', 0, @max, now() - interval '1 second',
                   'test-' || gen_random_uuid(), now(), now()
            FROM generate_series(1, @n)
            """, conn, tx))
        {
            insert.Parameters.AddWithValue("kind", kind);
            insert.Parameters.AddWithValue("n", count);
            insert.Parameters.AddWithValue("max", maxAttempts);
            await insert.ExecuteNonQueryAsync();
        }
        await tx.CommitAsync();
    }

    public Task ResetAsync() => ExecAsync("TRUNCATE jobs RESTART IDENTITY CASCADE");
}

[CollectionDefinition("postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;
```

**3. `tests/BranchStory.Worker.IntegrationTests/JobStoreTests.cs`**

```csharp
using System.Collections.Concurrent;
using System.Text.Json;
using BranchStory.Worker.Jobs;
using Npgsql;

namespace BranchStory.Worker.IntegrationTests;

[Collection("postgres")]
public class JobStoreTests(PostgresFixture fx) : IAsyncLifetime
{
    private readonly JobStore _store = new(fx.DataSource);
    private static readonly TimeSpan Minute = TimeSpan.FromMinutes(1);
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public ValueTask InitializeAsync() => new(fx.ResetAsync());   // every test starts with an empty queue
    public ValueTask DisposeAsync() => ValueTask.CompletedTask;

    [Fact]
    public async Task Concurrent_claimers_never_get_the_same_job()
    {
        await fx.SeedQueuedJobsAsync(200);
        var claimed = new ConcurrentBag<long>();

        await Parallel.ForEachAsync(Enumerable.Range(0, 8), new ParallelOptions { MaxDegreeOfParallelism = 8 },
            async (worker, ct) =>
            {
                while (await _store.TryClaimAsync($"w{worker}", Minute, ct) is { } job)
                    claimed.Add(job.Id);
            });

        Assert.Equal(200, claimed.Count);
        Assert.Equal(200, claimed.Distinct().Count());
        Assert.Equal(200L, await fx.ScalarAsync<long>("SELECT count(*) FROM jobs WHERE status = 'running' AND attempts = 1"));
    }

    [Fact]
    public async Task A_live_lease_is_not_reclaimed()
    {
        await fx.SeedQueuedJobsAsync(1);
        Assert.NotNull(await _store.TryClaimAsync("w1", Minute, Ct));
        Assert.Null(await _store.TryClaimAsync("w2", Minute, Ct));
    }

    [Fact]
    public async Task An_expired_lease_is_reclaimed_and_the_old_owner_is_fenced_out()
    {
        await fx.SeedQueuedJobsAsync(1);
        var first = await _store.TryClaimAsync("w1", Minute, Ct);
        Assert.NotNull(first);
        await fx.ExecAsync("UPDATE jobs SET leased_until = now() - interval '1 second'");   // w1 "died"

        var second = await _store.TryClaimAsync("w2", Minute, Ct);
        Assert.NotNull(second);
        Assert.Equal(first.Id, second.Id);
        Assert.Equal(2, second.Attempts);

        Assert.False(await _store.ExtendLeaseAsync(first.Id, "w1", Minute, Ct));
        Assert.False(await _store.CompleteAsync(first, "w1", Ct));
        Assert.True(await _store.CompleteAsync(second, "w2", Ct));
        Assert.Equal("succeeded", await fx.ScalarAsync<string>("SELECT status FROM jobs WHERE id = @id", ("id", first.Id)));
    }

    [Fact]
    public async Task A_retry_is_not_claimable_until_its_backoff_has_passed()
    {
        await fx.SeedQueuedJobsAsync(1);
        var job = (await _store.TryClaimAsync("w1", Minute, Ct))!;
        Assert.True(await _store.RetryAsync(job, "w1", TimeSpan.FromMinutes(5), "timeout", Ct));

        Assert.Null(await _store.TryClaimAsync("w1", Minute, Ct));
        await fx.ExecAsync("UPDATE jobs SET run_after = now() - interval '1 second'");
        var again = await _store.TryClaimAsync("w1", Minute, Ct);
        Assert.Equal(2, again!.Attempts);
    }

    [Fact]
    public async Task Release_on_shutdown_does_not_burn_an_attempt()
    {
        await fx.SeedQueuedJobsAsync(1);
        var job = (await _store.TryClaimAsync("w1", Minute, Ct))!;
        Assert.True(await _store.ReleaseAsync(job, "w1", Ct));
        Assert.Equal(1, (await _store.TryClaimAsync("w2", Minute, Ct))!.Attempts);
    }

    [Fact]
    public async Task Status_changes_are_announced_on_job_events()
    {
        await fx.SeedQueuedJobsAsync(1);
        await using var listener = await fx.DataSource.OpenConnectionAsync(Ct);
        var payloads = new ConcurrentQueue<string>();
        listener.Notification += (_, e) => payloads.Enqueue(e.Payload);
        await using (var listen = new NpgsqlCommand("LISTEN job_events", listener)) await listen.ExecuteNonQueryAsync(Ct);

        var job = (await _store.TryClaimAsync("w1", Minute, Ct))!;
        await _store.CompleteAsync(job, "w1", Ct);

        // The claim and the completion each announce themselves. They may arrive in one batch or two.
        while (payloads.Count < 2 && await listener.WaitAsync(TimeSpan.FromSeconds(5), Ct)) { }
        var events = payloads.Select(p => JsonSerializer.Deserialize<JsonElement>(p)).ToList();
        Assert.Equal("running,succeeded", string.Join(",", events.Select(e => e.GetProperty("status").GetString())));
        var done = events[1];
        Assert.Equal(job.Id, done.GetProperty("id").GetInt64());
        Assert.Equal(job.ProjectId, done.GetProperty("projectId").GetGuid());
        Assert.Equal(JsonValueKind.Null, done.GetProperty("slug").ValueKind); // nothing published yet
    }

    [Fact]
    public async Task A_lease_that_expires_on_the_last_attempt_is_dead_lettered()
    {
        await fx.SeedQueuedJobsAsync(1, maxAttempts: 1);
        var job = (await _store.TryClaimAsync("w1", Minute, Ct))!;
        await fx.ExecAsync("UPDATE jobs SET leased_until = now() - interval '1 second'");   // crashed on attempt 1 of 1

        Assert.Null(await _store.TryClaimAsync("w2", Minute, Ct));                   // the claim skips it…
        Assert.Equal(1, await _store.ReapExhaustedAsync(Ct));                         // …the reaper fails it
        Assert.Equal("failed", await fx.ScalarAsync<string>("SELECT status FROM jobs WHERE id = @id", ("id", job.Id)));
    }
}
```

**4. Run locally** (Docker must be running; Testcontainers pulls `postgres:18` once)

```bash
dotnet test tests/BranchStory.Worker.IntegrationTests
```

Then run it against your compose Postgres, the way CI will. Use a **separate, scratch database**
on that server. Never point tests at a database whose data you care about, because `ResetAsync`
truncates `jobs`:

```bash
docker compose -f deploy/compose.yaml exec db createdb -U branchstory branchstory_it
BRANCHSTORY_TEST_DB="Host=localhost;Port=5432;Username=branchstory;Password=branchstory;Database=branchstory_it" \
  dotnet test tests/BranchStory.Worker.IntegrationTests
```

The first run applies the migrations to the empty `branchstory_it`. Later runs find them already
applied and skip straight to the tests.

**5. Prove the test can fail.** In `JobStore.ClaimSql` remove `SKIP LOCKED` and run again: the
concurrency test still passes. Plain `FOR UPDATE` is correct, it just makes the workers wait for each
other's claim to commit. With millisecond claims you may barely notice; in production with slow
claims or many workers it shows up as lock waits. Now remove the whole `FOR UPDATE SKIP LOCKED` line: the test fails with duplicate ids (run it a few
times; races are probabilistic). Restore the line.

:::warn title="Tests that share a database"
xUnit runs test *collections* in parallel. Every class that touches the shared database must be in
the same `[Collection("postgres")]`, or one class's `TRUNCATE` will wipe another class's rows
mid-test and you get flaky failures that are hard to explain.
:::

- [ ] All seven integration tests pass against Testcontainers
- [ ] The same tests pass with `BRANCHSTORY_TEST_DB` pointing at a scratch database
- [ ] Removing `FOR UPDATE SKIP LOCKED` makes the concurrency test fail (at least sometimes); restoring it makes it green
- [ ] The NOTIFY test proves `job_events` carries the job id, project id and status
:::

:::quiz id=cap-09-q1 xp=15
A teammate proposes testing `JobStore` with EF Core's InMemory provider "because it's faster than
Docker". What is the strongest argument against it?
- [ ] InMemory does not support `long` primary keys
- [x] The behaviour under test (row locks, `SKIP LOCKED`, `now()`, `make_interval`, `pg_notify`) does not exist outside Postgres, so the tests would pass while proving nothing
- [ ] Testcontainers is required by xUnit for async tests
- [ ] InMemory tests cannot run in GitHub Actions
> Fakes are good for code whose logic is *yours*. When the logic is the database's (locking, isolation, constraints, JSON operators), test against the real engine. Testcontainers plus a CI service container makes that cheap: seconds, not minutes. Also, `JobStore` uses raw Npgsql commands, so it wouldn't even go through EF Core's InMemory provider. The other options are simply false: InMemory supports `long` keys, xUnit runs async tests without Testcontainers, and InMemory tests run fine on GitHub Actions.
:::

## Lab 3: Vitest for the frontend core

:::lab id=cap-09-lab3 xp=100
title: Reducer invariants, a component test for the player, and coverage thresholds

cap-05 already set up Vitest inside `web/vite.config.ts` (jsdom, `src/test/setup.ts` with
jest-dom and cleanup). This lab adds coverage, invariant tests and a component test.

**1. Coverage provider and scripts**

```bash
cd web
npm i -D @vitest/coverage-v8
```

Add to the `scripts` in `web/package.json` (keep `test` and `test:watch` from cap-05):

```json
"test:ci": "vitest run --coverage",
"typecheck": "tsc -b"
```

**2. Thresholds on the core.** Extend the `test` block in `web/vite.config.ts`:

```ts
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
      unstubGlobals: true,
      coverage: {
        provider: 'v8',
        include: ['src/modules/**/*.{ts,tsx}', 'src/lib/**/*.ts'],
        exclude: ['src/**/*.test.{ts,tsx}', 'src/**/*.d.ts'],
        reporter: ['text-summary', 'html', 'lcov'],
        // Gate the pure core, track the rest.
        thresholds: {
          'src/modules/editor/{reducer,validate,history,merge}.ts': { lines: 90, branches: 75, functions: 90 },
          'src/modules/player/**': { lines: 80, branches: 75 },
        },
      },
    },
```

**3. Reducer invariants: `web/src/modules/editor/reducer.invariants.test.ts`**

Example-based tests (cap-06) check the cases you thought of. An **invariant** test throws hundreds
of random action sequences at the reducer and checks the rules that must *always* hold.

```ts
import { describe, expect, test } from 'vitest'
import { emptyDoc, type StoryDoc } from './model'
import { storyReducer, type StoryAction } from './reducer'

const addNode = (id: string): StoryAction => ({ type: 'addNode', node: { id, title: id, text: '', x: 0, y: 0 } })
const connect = (id: string, from: string, to: string): StoryAction => ({ type: 'connect', edge: { id, from, to, label: `${from}→${to}` } })
const deleteNode = (id: string): StoryAction => ({ type: 'deleteNode', id })

/** Small seeded PRNG so a failing sequence can be replayed exactly. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}

function checkInvariants(doc: StoryDoc) {
  const ids = new Set(doc.nodes.map((n) => n.id))
  expect(ids.size, 'node ids are unique').toBe(doc.nodes.length)
  for (const e of doc.edges) {
    expect(ids.has(e.from), `edge ${e.id} has a live source`).toBe(true)
    expect(ids.has(e.to), `edge ${e.id} has a live target`).toBe(true)
  }
  expect(new Set(doc.edges.map((e) => e.id)).size, 'edge ids are unique').toBe(doc.edges.length)
  if (doc.startNodeId !== null) expect(ids.has(doc.startNodeId), 'the start scene exists').toBe(true)
}

describe('storyReducer invariants', () => {
  for (const seed of [1, 2, 3, 42, 1337]) {
    test(`random sequence #${seed} keeps the graph consistent and never mutates state`, () => {
      const rand = mulberry32(seed)
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]
      let doc: StoryDoc = deepFreeze(structuredClone(emptyDoc))
      let counter = 0

      for (let step = 0; step < 300; step++) {
        const ids = doc.nodes.map((n) => n.id)
        const edgeIds = doc.edges.map((e) => e.id)
        const r = rand()
        // Mostly growth, so the graph gets big enough to be interesting, but every action type runs.
        const action: StoryAction =
          r < 0.3 || ids.length < 2 ? addNode(`n${++counter}`)
          : r < 0.55 ? connect(`e${++counter}`, pick(ids), pick(ids))
          : r < 0.65 ? deleteNode(pick(ids))
          : r < 0.72 ? { type: 'updateNode', id: pick(ids), patch: { title: `t${step % 3}` } }
          : r < 0.79 ? { type: 'moveNode', id: pick(ids), x: rand() * 500, y: rand() * 500 }
          : r < 0.86 ? { type: 'setStart', id: pick(ids) }
          : r < 0.93 && edgeIds.length > 0 ? { type: 'updateEdge', id: pick(edgeIds), label: `l${step % 3}` }
          : edgeIds.length > 0 ? { type: 'deleteEdge', id: pick(edgeIds) }
          : addNode(`n${++counter}`)
        // deepFreeze makes any in-place mutation throw (ES modules run in strict mode).
        doc = deepFreeze(storyReducer(doc, action))
        checkInvariants(doc)
      }
    })
  }
})
```

Because `storyReducer` is a pure `(doc, action) => doc` function, the same test also guards the
undo/redo history (it only stores the docs the reducer returns) and anything else built on top.

**4. Component test for the public player: `web/src/modules/player/PlayerPage.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PlayerPage } from './PlayerPage'
import type { PlayerStory } from '../publish/api'

const story: PlayerStory = {
  format: 1, title: 'The Gate', version: 3, start: 'a',
  scenes: {
    a: { title: 'Gate', text: 'Two paths.', media: null, end: false,
         choices: [{ label: 'Go left', to: 'b' }, { label: 'Go right', to: 'c' }] },
    b: { title: 'Forest', text: 'Dark.', media: null, end: true, choices: [] },
    c: { title: 'River', text: 'Wet.', media: null, end: true, choices: [] },
  },
}

function renderAt(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes><Route path="/play/:slug" element={<PlayerPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
    String(input).endsWith('/api/public/stories/the-gate')
      ? new Response(JSON.stringify(story), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('', { status: 404 })))
})
afterEach(() => vi.unstubAllGlobals())

test('plays a branch to the end, moves focus, and can go back', async () => {
  const user = userEvent.setup()
  renderAt('/play/the-gate')

  expect(await screen.findByRole('heading', { level: 2, name: 'Gate' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Go left' }))
  expect(screen.getByRole('heading', { level: 2, name: 'Forest' })).toHaveFocus()
  expect(screen.getByText('The end.')).toBeInTheDocument()
  expect(screen.queryByRole('navigation', { name: 'Choices' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByRole('heading', { level: 2, name: 'Gate' })).toBeInTheDocument()
})

test('choices are reachable with the keyboard', async () => {
  const user = userEvent.setup()
  renderAt('/play/the-gate')
  await screen.findByRole('heading', { level: 2, name: 'Gate' })

  await user.tab()
  expect(screen.getByRole('button', { name: 'Go left' })).toHaveFocus()
  await user.tab()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('heading', { level: 2, name: 'River' })).toBeInTheDocument()
})

test('an unknown slug shows a friendly not-found page', async () => {
  renderAt('/play/nope')
  expect(await screen.findByRole('heading', { name: 'Story not found' })).toBeInTheDocument()
})
```

**5. Run**

```bash
npm run test:watch   # watch mode while you work (cap-05's script)
npm test             # once, no coverage
npm run test:ci      # what CI runs: once, with coverage thresholds
```

Try the invariant test's value: in `reducer.ts`, change `deleteNode` so it only removes edges whose
`from` is the deleted node. At least one seed fails with a message like `edge e17 has a live
target`, and you can replay the exact sequence because the PRNG is seeded. Restore the code.

- [ ] The invariant test passes for all seeds; introducing a bug in `deleteNode` (for example, not removing incoming edges) fails it with a readable message
- [ ] The three PlayerPage tests pass
- [ ] `npm run test:ci` prints a coverage summary and fails if one of the four gated editor files (`reducer`, `validate`, `history`, `merge`) or the player module drops below its threshold
- [ ] `npm run typecheck` passes with the test files included
:::

## Write the tests: mutation testing by hand

In the next two challenges the roles are reversed. You get a correct implementation, and the
site has hidden several **mutants**: copies of it with one small, realistic bug each (a `>`
where `>=` belongs, a forgotten special case). Your tests must

- **pass** on the real implementation, and
- **fail** on every mutant ("kill" it).

A mutant that survives points at a behaviour your tests never pin down. This is exactly what
mutation-testing tools (Stryker for JS/TS and .NET) automate. Doing it by hand once teaches you to
test *boundaries* and *every cell of a decision table*, not just the happy path.

:::challenge id=cap-09-c1 lang=ts mode=tests xp=60
title: Pin down the permission matrix
`canPerform(role, action)` decides every authorization question in BranchStory (the API's
resource handler and the UI's disabled buttons both mirror it). Owners can do everything, editors
can read, edit and publish (publishing is billed to the owner, but editors may trigger it),
viewers can only read, and non-members (`null`) can do nothing. **Write tests** that pass on this
implementation and catch every subtly broken version (we hide five).

hint: A table of `[role, action, expected]` rows with a loop is the clearest way to cover a matrix.
hint: Think about which cells a lazy implementation gets wrong: editors sharing, viewers editing, editors publishing, owners deleting, strangers reading.

```ts impl
export type Role = 'owner' | 'editor' | 'viewer' | null
export type Action = 'read' | 'edit' | 'publish' | 'share' | 'delete'

export function canPerform(role: Role, action: Action): boolean {
  if (role === null) return false
  if (role === 'owner') return true
  if (role === 'editor') return action === 'read' || action === 'edit' || action === 'publish'
  return action === 'read'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer' | null
export type Action = 'read' | 'edit' | 'publish' | 'share' | 'delete'
export function canPerform(role: Role, action: Action): boolean {
  if (role === null) return false
  if (role === 'owner') return true
  if (role === 'editor') return action !== 'delete'
  return action === 'read'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer' | null
export type Action = 'read' | 'edit' | 'publish' | 'share' | 'delete'
export function canPerform(role: Role, action: Action): boolean {
  if (role === null) return false
  if (role === 'owner') return true
  if (role === 'editor') return action === 'read' || action === 'edit' || action === 'publish'
  return action === 'read' || action === 'edit'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer' | null
export type Action = 'read' | 'edit' | 'publish' | 'share' | 'delete'
export function canPerform(role: Role, action: Action): boolean {
  if (role === null) return action === 'read'
  if (role === 'owner') return true
  if (role === 'editor') return action === 'read' || action === 'edit' || action === 'publish'
  return action === 'read'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer' | null
export type Action = 'read' | 'edit' | 'publish' | 'share' | 'delete'
export function canPerform(role: Role, action: Action): boolean {
  if (role === null) return false
  if (role === 'owner') return true
  if (role === 'editor') return action === 'read' || action === 'edit'
  return action === 'read'
}
```

```ts mutant
export type Role = 'owner' | 'editor' | 'viewer' | null
export type Action = 'read' | 'edit' | 'publish' | 'share' | 'delete'
export function canPerform(role: Role, action: Action): boolean {
  if (role === null) return false
  if (role === 'owner') return action !== 'delete'
  if (role === 'editor') return action === 'read' || action === 'edit' || action === 'publish'
  return action === 'read'
}
```

```ts starter
test('owners can read', () => {
  expect(canPerform('owner', 'read')).toBe(true)
})
```

```ts solution
const matrix: [Role, Action, boolean][] = [
  ['owner', 'read', true], ['owner', 'edit', true], ['owner', 'publish', true], ['owner', 'share', true], ['owner', 'delete', true],
  ['editor', 'read', true], ['editor', 'edit', true], ['editor', 'publish', true], ['editor', 'share', false], ['editor', 'delete', false],
  ['viewer', 'read', true], ['viewer', 'edit', false], ['viewer', 'publish', false], ['viewer', 'share', false], ['viewer', 'delete', false],
  [null, 'read', false], [null, 'edit', false], [null, 'publish', false], [null, 'share', false], [null, 'delete', false],
]
for (const [role, action, expected] of matrix) {
  test(`${role ?? 'stranger'} ${expected ? 'can' : 'cannot'} ${action}`, () => {
    expect(canPerform(role, action)).toBe(expected)
  })
}
```
:::

:::challenge id=cap-09-c2 lang=ts mode=tests xp=60
title: Catch the retry-policy bugs
The worker classifies every failure as `'retry'` (back to `queued` with a backoff) or `'failed'`, the same word as the dead-letter status in the `jobs` table. Permanent failures die at once;
client errors (4xx) die too, **except** `408 Request Timeout` and `429 Too Many Requests`, which are
transient; server errors (5xx) and errors without a status retry; and nothing retries once
`attempt` has reached `maxAttempts`. Write tests that pass on the implementation and catch all
five hidden mutants.

hint: Test both sides of every boundary: attempt 4 vs 5 with `maxAttempts = 5`, status 499 vs 500, 408 and 429 vs 400 and 404.
hint: A permanent failure with a 503 status must still be `'failed'`.

```ts impl
export interface Failure { status?: number; permanent?: boolean }

export function classifyFailure(f: Failure, attempt: number, maxAttempts: number): 'retry' | 'failed' {
  if (f.permanent) return 'failed'
  if (attempt >= maxAttempts) return 'failed'
  const s = f.status
  if (s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429) return 'failed'
  return 'retry'
}
```

```ts mutant
export interface Failure { status?: number; permanent?: boolean }
export function classifyFailure(f: Failure, attempt: number, maxAttempts: number): 'retry' | 'failed' {
  if (f.permanent) return 'failed'
  if (attempt > maxAttempts) return 'failed'
  const s = f.status
  if (s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429) return 'failed'
  return 'retry'
}
```

```ts mutant
export interface Failure { status?: number; permanent?: boolean }
export function classifyFailure(f: Failure, attempt: number, maxAttempts: number): 'retry' | 'failed' {
  if (f.permanent) return 'failed'
  if (attempt >= maxAttempts) return 'failed'
  const s = f.status
  if (s !== undefined && s >= 400 && s < 500 && s !== 408) return 'failed'
  return 'retry'
}
```

```ts mutant
export interface Failure { status?: number; permanent?: boolean }
export function classifyFailure(f: Failure, attempt: number, maxAttempts: number): 'retry' | 'failed' {
  if (attempt >= maxAttempts) return 'failed'
  const s = f.status
  if (s !== undefined && s >= 400 && s < 500 && s !== 408 && s !== 429) return 'failed'
  return 'retry'
}
```

```ts mutant
export interface Failure { status?: number; permanent?: boolean }
export function classifyFailure(f: Failure, attempt: number, maxAttempts: number): 'retry' | 'failed' {
  if (f.permanent) return 'failed'
  if (attempt >= maxAttempts) return 'failed'
  return 'retry'
}
```

```ts mutant
export interface Failure { status?: number; permanent?: boolean }
export function classifyFailure(f: Failure, attempt: number, maxAttempts: number): 'retry' | 'failed' {
  if (f.permanent) return 'failed'
  if (attempt >= maxAttempts) return 'failed'
  const s = f.status
  if (s !== undefined && s >= 400 && s !== 408 && s !== 429) return 'failed'
  return 'retry'
}
```

```ts starter
test('a timeout on the first attempt is retried', () => {
  expect(classifyFailure({}, 1, 5)).toBe('retry')
})
```

```ts solution
test('unknown errors retry', () => expect(classifyFailure({}, 1, 5)).toBe('retry'))
test('server errors retry', () => {
  expect(classifyFailure({ status: 500 }, 1, 5)).toBe('retry')
  expect(classifyFailure({ status: 503 }, 2, 5)).toBe('retry')
})
test('client errors die', () => {
  expect(classifyFailure({ status: 400 }, 1, 5)).toBe('failed')
  expect(classifyFailure({ status: 404 }, 1, 5)).toBe('failed')
  expect(classifyFailure({ status: 499 }, 1, 5)).toBe('failed')
})
test('408 and 429 are transient', () => {
  expect(classifyFailure({ status: 408 }, 1, 5)).toBe('retry')
  expect(classifyFailure({ status: 429 }, 1, 5)).toBe('retry')
})
test('permanent beats everything', () => expect(classifyFailure({ status: 503, permanent: true }, 1, 5)).toBe('failed'))
test('the last attempt is final', () => {
  expect(classifyFailure({ status: 503 }, 4, 5)).toBe('retry')
  expect(classifyFailure({ status: 503 }, 5, 5)).toBe('failed')
})
```
:::

## Lab 4: end-to-end journeys with an accessibility gate

:::lab id=cap-09-lab4 xp=120
title: Playwright specs for publish, conflict and the player, failing on serious axe violations

E2E tests are expensive: keep them few, make each one a **user journey that crosses every layer**,
and seed state through the API instead of clicking through setup screens.

**The seams.** These are the only places the specs touch decisions from earlier lessons. Adjust
them once in `helpers/` if yours differ:

| Helper | Assumes |
|---|---|
| `devToken()` | Development-only `POST /api/dev/token { username }` returns `{ accessToken }` (cap-03) |
| `createProject()` | `POST /api/projects { title }` returns the project with `id` and `version` (cap-03) |
| `saveDoc()` | `PUT /api/projects/{id}/doc { doc, expectedVersion }` returns `{ version }` or `409` with `currentVersion` (cap-04) |
| `signIn()` | the SPA keeps its token in `sessionStorage['branchstory.token']` (cap-05 `session.ts`) |
| routes | `/login`, `/projects`, the editor at `/projects/{id}`, the player at `/play/{slug}` |

Signing in by planting the token is deliberate: the login *form* gets its own accessibility check,
but every other journey should not depend on it. One broken button must fail one test, not twenty.

**1. Set up the package**

```bash
mkdir -p tests/e2e/specs tests/e2e/helpers && cd tests/e2e
npm init -y
npm pkg set type=module scripts.test="playwright test" scripts.report="playwright show-report"
npm i -D @playwright/test @axe-core/playwright @types/node typescript
npx playwright install --with-deps chromium
```

**2. `tests/e2e/playwright.config.ts`**

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0, // a retry that passes is reported as "flaky", not hidden
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
```

**3. `tests/e2e/helpers/api.ts`**

```ts
import { expect, type APIRequestContext } from '@playwright/test'

export const sampleDoc = {
  startNodeId: 'gate',
  nodes: [
    { id: 'gate', title: 'Gate', text: 'Two paths lead away.', mediaUrl: null, x: 0, y: 0 },
    { id: 'forest', title: 'Forest', text: 'It is dark.', mediaUrl: null, x: 200, y: -80 },
    { id: 'river', title: 'River', text: 'The water is cold.', mediaUrl: null, x: 200, y: 80 },
  ],
  edges: [
    { id: 'e1', from: 'gate', to: 'forest', label: 'Into the forest' },
    { id: 'e2', from: 'gate', to: 'river', label: 'Down to the river' },
  ],
}

export const uniqueUser = (prefix: string) => `e2e-${prefix}-${crypto.randomUUID().slice(0, 8)}`
const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

export async function devToken(request: APIRequestContext, username: string): Promise<string> {
  const res = await request.post('/api/dev/token', { data: { username } })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).accessToken as string
}

export async function createProject(request: APIRequestContext, token: string, title: string) {
  const res = await request.post('/api/projects', { headers: auth(token), data: { title } })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()) as { id: string; version: number }
}

export function saveDoc(request: APIRequestContext, token: string, projectId: string, doc: unknown, expectedVersion: number) {
  return request.put(`/api/projects/${projectId}/doc`, { headers: auth(token), data: { doc, expectedVersion } })
}

export async function publishAndWait(request: APIRequestContext, token: string, projectId: string): Promise<string> {
  const res = await request.post(`/api/projects/${projectId}/publish`, {
    headers: { ...auth(token), 'Idempotency-Key': crypto.randomUUID() },
  })
  expect(res.status(), await res.text()).toBe(202)
  const { jobId } = await res.json()
  let slug = ''
  await expect.poll(async () => {
    const job = await (await request.get(`/api/jobs/${jobId}`, { headers: auth(token) })).json()
    slug = job.slug ?? ''
    return job.status
  }, { timeout: 30_000, message: 'publish job should succeed' }).toBe('succeeded')
  return slug
}

/** A project with a saved three-scene story, ready to publish. */
export async function seedStory(request: APIRequestContext, prefix: string) {
  const username = uniqueUser(prefix)
  const token = await devToken(request, username)
  const project = await createProject(request, token, `E2E ${prefix} story`)
  const saved = await saveDoc(request, token, project.id, sampleDoc, project.version)
  expect(saved.ok(), await saved.text()).toBeTruthy()
  return { username, token, projectId: project.id, version: (await saved.json()).version as number }
}
```

**4. `tests/e2e/helpers/ui.ts`**

```ts
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

/** Plants the API token where the SPA's session store reads it, before any page script runs. */
export async function signIn(page: Page, token: string) {
  await page.addInitScript((t) => sessionStorage.setItem('branchstory.token', t), token)
}

/** The gate: zero serious or critical WCAG 2.2 A/AA violations. Minor ones are reported, not blocking. */
export async function expectNoSeriousA11yViolations(page: Page, surface: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  const blocking = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.impact} ${v.id}: ${v.help} → ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`)
  const minor = results.violations.length - blocking.length
  if (minor) console.log(`[axe] ${surface}: ${minor} minor/moderate violation(s) to triage`)
  expect(blocking, `${surface} has serious accessibility violations`).toEqual([])
}
```

**5. `tests/e2e/specs/publish-and-play.spec.ts`**: the money journey

```ts
import { expect, test } from '@playwright/test'
import { seedStory } from '../helpers/api'
import { expectNoSeriousA11yViolations, signIn } from '../helpers/ui'

test('an editor publishes and a stranger plays the story', async ({ page, request, browser }) => {
  const { token, projectId } = await seedStory(request, 'publish')

  await signIn(page, token)
  await page.goto(`/projects/${projectId}`)
  await expectNoSeriousA11yViolations(page, 'editor')

  await page.getByRole('button', { name: 'Publish' }).click()
  const status = page.getByRole('status').filter({ hasText: /Queued|Rendering|Published/ })
  const playerLink = status.getByRole('link', { name: 'Open the player' })
  await expect(playerLink).toBeVisible({ timeout: 30_000 })
  const href = await playerLink.getAttribute('href')
  expect(href).toMatch(/^\/play\/e2e-publish-story-[0-9a-f]{8}$/)

  // A brand-new context = no cookies, no token: the public view.
  const anonymous = await browser.newContext()
  const player = await anonymous.newPage()
  await player.goto(href!)
  await expect(player.getByRole('heading', { level: 2, name: 'Gate' })).toBeVisible()
  await expectNoSeriousA11yViolations(player, 'player')

  await player.getByRole('button', { name: 'Down to the river' }).click()
  await expect(player.getByRole('heading', { level: 2, name: 'River' })).toBeFocused()
  await expect(player.getByText('The end.')).toBeVisible()
  await anonymous.close()
})
```

**6. `tests/e2e/specs/conflict.spec.ts`**: the concurrency contract, end to end

```ts
import { expect, test } from '@playwright/test'
import { sampleDoc, saveDoc, seedStory } from '../helpers/api'

test('a stale save is refused with 409 and the current version', async ({ request }) => {
  const { token, projectId, version } = await seedStory(request, 'conflict')

  const renamed = structuredClone(sampleDoc)
  renamed.nodes[0].title = 'Gate (tab A)'
  const first = await saveDoc(request, token, projectId, renamed, version)
  expect(first.ok(), await first.text()).toBeTruthy()

  const stale = structuredClone(sampleDoc)
  stale.nodes[0].title = 'Gate (tab B)'
  const second = await saveDoc(request, token, projectId, stale, version) // same, now outdated, version
  expect(second.status()).toBe(409)
  const problem = await second.json()
  // Assert the exact field. A loose `JSON.stringify(problem).toContain(String(version + 1))` also
  // matches any trace id or timestamp that happens to contain that digit, so it would almost never fail.
  expect(problem.currentVersion).toBe(version + 1)
})
```

**7. `tests/e2e/specs/accessibility.spec.ts`**: every main surface

```ts
import { expect, test } from '@playwright/test'
import { devToken, uniqueUser } from '../helpers/api'
import { expectNoSeriousA11yViolations, signIn } from '../helpers/ui'

test('sign-in page', async ({ page }) => {
  await page.goto('/login')
  await expectNoSeriousA11yViolations(page, 'sign-in')
})

test('project list', async ({ page, request }) => {
  await signIn(page, await devToken(request, uniqueUser('a11y')))
  await page.goto('/projects')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoSeriousA11yViolations(page, 'project list')
})

test('player not-found page', async ({ page }) => {
  await page.goto('/play/does-not-exist')
  await expect(page.getByRole('heading', { name: 'Story not found' })).toBeVisible()
  await expectNoSeriousA11yViolations(page, 'player 404')
})
```

**8. Run against your local stack** (API, worker and `npm run dev` in `web/` running)

```bash
cd tests/e2e
npx playwright test
npx playwright show-report   # traces for anything that failed
```

:::warn title="No sleeps, ever"
`await page.waitForTimeout(3000)` makes a test slow on fast machines and flaky on slow ones.
Use web-first assertions that retry until a deadline (`toBeVisible`, `toHaveText`, `expect.poll`).
The publish journey above waits up to 30 s but finishes the moment the link appears.
:::

- [ ] `npx playwright test` runs all specs green against the local stack
- [ ] Temporarily removing the label from the sign-in field (or adding an `<img src="/x.png">` without `alt` to `PlayerPage`) makes the axe gate fail with a readable message
- [ ] Stopping the worker makes the publish journey fail on the 30 s timeout, and the HTML report contains a trace
- [ ] The conflict spec fails if you temporarily disable the version check in the API
:::

## Lab 5: the pipeline

:::lab id=cap-09-lab5 xp=100
title: GitHub Actions runs backend, web and e2e gates on every pull request

**1. `.github/workflows/ci.yml`**: replace cap-03's minimal backend-only pipeline with the full
three-job version

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

env:
  DOTNET_NOLOGO: "true"
  DOTNET_CLI_TELEMETRY_OPTOUT: "true"
  NUGET_PACKAGES: ${{ github.workspace }}/.nuget/packages

jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_USER: branchstory
          POSTGRES_PASSWORD: branchstory
          POSTGRES_DB: branchstory_test
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U branchstory -d branchstory_test"
          --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      BRANCHSTORY_TEST_DB: Host=localhost;Port=5432;Username=branchstory;Password=branchstory;Database=branchstory_test
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: "10.0.x"
      - uses: actions/cache@v5
        with:
          path: ${{ env.NUGET_PACKAGES }}
          key: nuget-${{ runner.os }}-${{ hashFiles('**/*.csproj', '**/Directory.Packages.props') }}
          restore-keys: nuget-${{ runner.os }}-
      - run: dotnet restore
      - run: dotnet build --no-restore -c Release
      - name: Unit tests + coverage gate
        run: dotnet test tests/BranchStory.UnitTests -c Release -p:CollectCoverage=true
      - name: Worker integration tests (Postgres service container via BRANCHSTORY_TEST_DB)
        run: >-
          dotnet test tests/BranchStory.Worker.IntegrationTests -c Release --no-build
          --logger trx --results-directory test-results
      - name: API tests (cap-03's ApiFactory starts its own Testcontainers Postgres)
        run: >-
          dotnet test tests/BranchStory.Api.Tests -c Release --no-build
          --logger trx --results-directory test-results
      - uses: actions/upload-artifact@v5
        if: always()
        with:
          name: backend-test-results
          path: |
            test-results
            coverage
          retention-days: 7

  web:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test:ci
      - run: npm run build
      - run: npm run check:bundle   # cap-05's bundle budget: fails when the entry chunk grows too big
      - uses: actions/upload-artifact@v5
        if: always()
        with:
          name: web-coverage
          path: web/coverage
          retention-days: 7

  e2e:
    needs: [backend, web]
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:18
        env:
          POSTGRES_USER: branchstory
          POSTGRES_PASSWORD: branchstory
          POSTGRES_DB: branchstory
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U branchstory -d branchstory"
          --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      ConnectionStrings__BranchStory: Host=localhost;Port=5432;Username=branchstory;Password=branchstory;Database=branchstory
      ASPNETCORE_ENVIRONMENT: Development   # enables the dev token issuer; CI only
      Database__MigrateOnStartup: "true"    # cap-02's switch: the API applies migrations before serving
      CI: "true"
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: "10.0.x"
      - uses: actions/setup-node@v6
        with:
          node-version: lts/*
          cache: npm
          cache-dependency-path: |
            web/package-lock.json
            tests/e2e/package-lock.json
      - uses: actions/cache@v5
        with:
          path: ${{ env.NUGET_PACKAGES }}
          key: nuget-${{ runner.os }}-${{ hashFiles('**/*.csproj', '**/Directory.Packages.props') }}
      - name: Build and start API and worker
        run: |
          # build once, then start both without rebuilding: two parallel builds would race on shared outputs
          dotnet build -c Release
          nohup dotnet run --project api/BranchStory.Api -c Release --no-build --no-launch-profile -- --urls http://localhost:5080 > api.log 2>&1 &
          nohup dotnet run --project worker/BranchStory.Worker -c Release --no-build --no-launch-profile -- --urls http://localhost:5081 > worker.log 2>&1 &
      - name: Build and serve the web app (vite preview reuses the /api and /hubs proxy)
        working-directory: web
        run: |
          npm ci
          npm run build
          nohup npx vite preview --port 5173 --strictPort > ../web.log 2>&1 &
      - name: Wait for the stack
        run: |
          for url in http://localhost:5080/health/ready http://localhost:5081/health/ready http://localhost:5173/; do
            timeout 180 bash -c "until curl -fsS $url > /dev/null; do sleep 2; done" || (echo "not ready: $url"; exit 1)
          done
      - name: Playwright
        working-directory: tests/e2e
        run: |
          npm ci
          npx playwright install --with-deps chromium
          npx playwright test
      - uses: actions/upload-artifact@v5
        if: failure()
        with:
          name: e2e-report
          path: |
            tests/e2e/playwright-report
            tests/e2e/test-results
            api.log
            worker.log
            web.log
          retention-days: 7
```

The action majors above (all on the Node 24 runtime) were current when this was written. Check each
action's releases page when you copy it, and let Dependabot keep them fresh (see the callout below).

How to read it, from top to bottom:

- **`on`**: run for every pull request and for every push to `main`.
- **`concurrency`**: one run per branch. A new push cancels the old run instead of queueing behind it.
- **`permissions: contents: read`**: the workflow's `GITHUB_TOKEN` can read the repo and nothing
  else. A compromised step can't push code or edit releases.
- **`jobs`**: `backend` and `web` run in parallel on separate fresh VMs. `e2e` has
  `needs: [backend, web]`, so it starts only when both are green, which avoids spending 10 minutes of
  browser tests on a commit that doesn't even compile.
- **`services`**: GitHub starts a Docker container next to the job and waits for its
  `--health-cmd` to report healthy before the first step runs. Because the job runs directly on
  the VM, the container's port is published to `localhost:5432`.
- **Two Postgres sources, on purpose.** Only `PostgresFixture` (Lab 2) reads
  `BRANCHSTORY_TEST_DB`; cap-03's `ApiFactory` always starts its own Testcontainers database.
  That is deliberate: the worker tests `TRUNCATE jobs` between tests, while the API tests isolate
  by fresh users and never truncate. Pointed at one shared database, the worker suite's
  `TRUNCATE` would wipe jobs the API tests had just created and were about to assert on. GitHub's Ubuntu runners have Docker, so Testcontainers just works there. Each
  suite gets its own named step, so a red run tells you at a glance which one failed. (If you
  want the API tests on the service container too, give `ApiFactory` the same switch and point
  it at a **second** database, for example `branchstory_api_test`.)
- **Caches** are keyed by a hash of the files that define dependencies (`*.csproj`, lock files).
  Same hash, so the packages are restored from the cache. Any change, and the key changes too.
- **Artifacts** (`upload-artifact`) keep test results, coverage, logs and the Playwright report
  for 7 days, so a red run can be debugged without re-running it.

**2. Make it a gate.** In the repository settings → Branches → add a rule (or ruleset) for `main`:
require a pull request, require the status checks `backend`, `web` and `e2e` to pass, and require
branches to be up to date. Now nothing merges red.

**3. Prove it.** Open a PR that breaks something small (rename the "Publish" button label). The
`e2e` job fails, the HTML report artifact shows the trace, and the merge button stays grey.

:::job title="What reviewers look for in a CI file"
Least-privilege `permissions:`, `concurrency` so a new push cancels the old run, caches keyed on
lock files, artifacts on failure (logs! not just "exit code 1"), timeouts on jobs that start
servers, and no secrets needed for pull requests from forks. Pin third-party actions to a commit
SHA in security-sensitive repos; first-party `actions/*` at a major version is the common
compromise. Action majors move on (new Node runtimes, new defaults), so don't copy version numbers
from old blog posts. Add a `.github/dependabot.yml` entry with `package-ecosystem: github-actions`
and let Dependabot open the upgrade PRs.
:::

- [ ] A push runs `backend`, `web` and `e2e`; `e2e` starts only after the other two are green
- [ ] The backend job runs the worker integration tests against the `postgres:18` service container via `BRANCHSTORY_TEST_DB` (cap-03's API tests still start their own Testcontainers Postgres, which works because GitHub's Ubuntu runners have Docker)
- [ ] Coverage and test-result artifacts are attached to the run
- [ ] A deliberately broken PR is blocked by the branch rule and the failing job uploads logs and the Playwright report
:::

:::quiz id=cap-09-q2 xp=15
The axe gate fails only on **serious** and **critical** violations. Which statements about that
choice are true? Select all that apply.
- [x] It keeps the gate high-signal: a red build always means a real barrier (missing labels, contrast, keyboard traps), so nobody learns to ignore it
- [x] Minor and moderate findings are still reported so they can be triaged
- [ ] A green axe run means the app is WCAG 2.2 AA compliant
- [x] Automated rules find only part of the real issues; a manual keyboard and screen-reader pass is still needed before launch
> Automated scanners catch a good share of the mechanical problems (labels, roles, contrast, names) but cannot judge whether focus order makes sense or alt text is meaningful. So "green axe = WCAG compliant" is the tempting wrong statement. A clean scan means "no machine-detectable violations on the pages we scanned, in the state we scanned them". Gate on what is unambiguous, and test the rest by hand.
:::

:::quiz id=cap-09-q3 xp=15
The publish e2e test fails about once in twenty CI runs with "link not visible after 30 s". What
is the best first move?
- [ ] Raise `retries` to 3 so the pipeline stays green
- [ ] Add `await page.waitForTimeout(10000)` before the assertion
- [x] Download the trace and worker/API logs from the failed run, find which layer stalled (job never claimed? notification lost? UI never refetched?) and fix that, quarantining the test meanwhile if it blocks the team
- [ ] Delete the test, e2e tests are always flaky
> Flakiness in a journey test is often a real bug in the system under test (here: the UI must fall back to polling if a SignalR message is lost). Retries are for reporting flakiness, not hiding it. A fixed `waitForTimeout` makes every run 10 s slower and still fails whenever the real delay is longer: it guesses instead of waiting for a condition. Traces and uploaded logs make the investigation possible.
:::

:::quiz id=cap-09-q4 xp=15
A teammate adds `ReaperTests` for the integration project. It uses `PostgresFixture` through
`IClassFixture<PostgresFixture>` and has no `[Collection]` attribute. With `BRANCHSTORY_TEST_DB`
set in CI, `JobStoreTests` now fails now and then with "expected 200, got 143". Why?
- [ ] `IClassFixture` creates the fixture lazily, so the migrations run twice
- [x] The two classes are now in different collections, which xUnit runs in parallel; both use the same database, and one class's `TRUNCATE jobs` wipes the other's rows mid-test
- [ ] `SKIP LOCKED` does not work when two test classes run at once
- [ ] Testcontainers reuses containers between classes
> xUnit runs tests *within* a collection one after another, but different collections run in
> parallel. A class without `[Collection]` is its own collection. Locally each fixture might even
> get its own container, which hides the bug. In CI both point at the same service database, so
> the classes trample each other. The fix is `[Collection("postgres")]` on every class that
> touches the shared database. `SKIP LOCKED` is fine: the failure is test isolation, not locking.
> And containers are not shared unless you opt into Testcontainers' reuse feature.
:::

:::quiz id=cap-09-q5 xp=15
Your tests for `canPerform` reach **100 % line and branch coverage**, yet in the "write the
tests" challenge one mutant still survives. What does that tell you?
- [ ] The mutation tool is broken; 100 % coverage means every bug is caught
- [ ] Branch coverage should have been measured instead of line coverage
- [x] Coverage only proves the code **ran**; the tests don't **assert** the cells the mutant changed (for example `editor` + `share`)
- [ ] The implementation has dead code that should be deleted
> Coverage counts executed code. Even a test with no `expect` at all "covers" lines. A mutant that
> flips `editor` + `share` from `false` to `true` still runs the same `if`s, so coverage stays 100 %,
> but nothing checks that particular answer. Mutation testing measures what coverage can't: whether
> your assertions would notice a wrong result. Branch coverage was already 100 % here, so measuring it
> instead changes nothing.
:::

:::cards id=cap-09-cards1 xp=20 title="Quality gates"
Q: What decides which level a test belongs at?
A: The cheapest test that can actually catch the bug. Pure logic gets unit tests, database semantics get integration tests on real Postgres, cross-layer journeys get a few e2e tests.
Q: Why Testcontainers locally but a service container in CI?
A: Same tests, two sources of Postgres: Testcontainers needs only Docker on a laptop; the CI service container is faster to start and needs no Docker-in-Docker. `BRANCHSTORY_TEST_DB` switches between them.
Q: What is an invariant (property) test?
A: Random input sequences (seeded, so replayable) checked against rules that must always hold, for example "no edge points at a missing node".
Q: Why deep-freeze state in reducer tests?
A: Any accidental in-place mutation then throws, proving the reducer is pure.
Q: Line coverage vs branch coverage?
A: Line: did each line run at least once? Branch: did each outcome of every decision (`if`, `?:`, `??`, `switch` arm) run? Branch coverage is stricter.
Q: What is a mutant, and what does it mean when one survives?
A: A copy of the code with one small deliberate bug. A survivor means no test asserts the behaviour it changed, even if coverage is 100 %.
Q: What makes coverage "matter"?
A: High thresholds on core modules (reducers, builders, permissions), no vanity global target, and tests that catch deliberately broken versions (mutation testing).
Q: What does the axe gate check?
A: Zero serious or critical WCAG 2.x A/AA violations on every main surface; minor ones are logged for triage.
Q: Why seed e2e state through the API?
A: It is faster and less brittle than clicking through setup screens, and each test gets its own isolated user and project.
Q: Three must-haves in a CI workflow?
A: Least-privilege permissions, concurrency cancel for superseded runs, and artifacts (logs, reports, traces) on failure.
:::

## Recap

- Choose the test level by the **risk** and the cheapest test that can catch it; SQL semantics are
  tested against real Postgres, never mocks.
- xUnit pins down the pure core (`PlayerBuilder`, `Slug`, `Backoff`) with a coverlet gate on just
  those classes; Vitest does the same for the reducer (invariants, deep-freeze) and the player.
- Testcontainers locally and a **service container in CI** share one fixture via
  `BRANCHSTORY_TEST_DB`; concurrent claim tests prove `SKIP LOCKED` and fencing.
- Playwright covers a few cross-layer journeys seeded through the API, with an **axe gate** of zero
  serious/critical violations and no sleeps.
- GitHub Actions runs backend, web and e2e with caches, artifacts and timeouts; branch protection
  turns them into real gates.
