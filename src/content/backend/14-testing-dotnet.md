---
id: be-14
title: Testing .NET Code with xUnit
level: intermediate
minutes: 50
xp: 150
summary: The test pyramid for APIs, xUnit facts/theories/fixtures, Shouldly, NSubstitute, testing time with FakeTimeProvider — and what NOT to unit test.
---

Tests are not about proving your code is correct. They are about being able to **change** it
next month without fear. A codebase with a fast, trustworthy test suite can be refactored on a
Friday afternoon; a codebase without one ossifies, because every change is a gamble.

That framing answers most "should I test this?" questions: write the tests that let you change
things safely, at the lowest cost, and delete the ones that only make change harder.

:::info title="Where this lesson fits"
You've been running xUnit tests since the be-01 lab, with just `[Fact]`, `Assert` and `dotnet test`
(the box at the start of that lab). This lesson is the proper introduction. It only assumes C#
(be-01 to be-04), the `WebApplicationFactory` tests from be-06 and injecting `TimeProvider` (be-08), so
you can take it any time after be-08. Its domain is the Projects API from be-12 and be-13, but the lab
builds everything it needs from scratch.
:::

## The test pyramid — and why APIs bend it

The classic pyramid says: many fast **unit tests**, fewer **integration tests**, a handful of
**end-to-end tests**. It came from a time when integration tests meant a shared, slow, flaky test
database. For a modern ASP.NET Core API that picture changes:

| Layer | What it exercises | Speed | Catches |
|---|---|---|---|
| Unit | One class / pure function, collaborators faked | µs–ms | Logic errors, edge cases, rules |
| Integration (lesson be-15) | Real HTTP pipeline + real PostgreSQL in a container | 5–50 ms/test (+ a few s startup) | Routing, binding, auth, SQL translation, constraints, migrations |
| End-to-end | Deployed system, browser or HTTP from outside | seconds | Wiring between services, config, infra |

With Testcontainers (next lesson) a real Postgres starts in ~2 seconds and each test costs a few
milliseconds. That makes the middle layer cheap, and the middle layer is where API bugs usually
are: a LINQ query that EF can't translate, a missing `[Authorize]`, a unique index that turns
into a 500 instead of a 409. Many teams therefore build a **"testing trophy"**: a solid base of
unit tests for *logic*, a thick middle of integration tests for *behaviour*, a thin top of E2E.

### What to unit test vs integration test

| Unit test it | Integration test it |
|---|---|
| Validation rules (`ProjectName.Validate`) | That invalid input returns `400 application/problem+json` |
| Permission logic ("only owners can invite") | That the endpoint is actually protected (401/403) |
| Price / quota calculations, state machines | EF queries, `Include`/projection, raw SQL |
| Retry/backoff math, parsing, mapping | Unique constraints → `409`, concurrency tokens → `409` |
| Expiry logic driven by `TimeProvider` | Migrations apply cleanly to a fresh Postgres 18 |

The heuristic: **if the interesting part is a decision your code makes, unit test it. If the
interesting part is how pieces talk to each other (HTTP, DI, SQL, JSON), integration test it.**
A unit test that mocks `DbContext` to "test" a query tests nothing — the query's correctness
lives in the SQL that EF generates, which the mock never produces.

:::job title="What reviewers expect on day one"
On most teams a pull request without tests for new logic gets sent back. Expect: a unit test per
business rule (including the edge case — exactly at the limit, empty list, null), an integration
test for each new endpoint's happy path plus its main failure (404/403/409), and CI green before
review. "I tested it manually in Swagger" is not a test.
:::

## xUnit in 10 minutes

xUnit is the most widely used test framework in modern .NET code (the ASP.NET Core and EF Core
teams use it; NUnit and MSTest are the other two you'll meet, with the same ideas under different
attribute names). A test project is just a class library that references the test framework and a
test runner; `dotnet test` builds it, discovers every method marked as a test and runs them.
Create one:

```bash
dotnet new xunit -o tests/Projects.Core.Tests
dotnet add tests/Projects.Core.Tests reference src/Projects.Core
dotnet test
```

### Facts and theories

A **`[Fact]`** is a test with no parameters — a statement that is always true. A
**`[Theory]`** is a test that should hold for *every* row of data you give it:

```csharp
public class ProjectNameTests
{
    [Fact]
    public void Validate_rejects_null()
    {
        Assert.NotNull(ProjectName.Validate(null));
    }

    [Theory]
    [InlineData("abc")]              // exactly the minimum length
    [InlineData("Apollo")]
    [InlineData("  Moon base  ")]    // trimmed before checking
    public void Validate_accepts_valid_names(string name)
    {
        Assert.Null(ProjectName.Validate(name));
    }
}
```

Each `InlineData` row shows up as a **separate test** in the runner, so a failure tells you which
input broke. For data that isn't a compile-time constant (objects, dates, Guids) use
`[MemberData]` with a strongly typed `TheoryData<T>`:

```csharp
public static TheoryData<DateTimeOffset, bool> ExpiryCases => new()
{
    { new DateTimeOffset(2026, 1, 7, 23, 59, 59, TimeSpan.Zero), true },
    { new DateTimeOffset(2026, 1, 8, 12, 0, 0, TimeSpan.Zero), false },  // exactly at expiry
};

[Theory]
[MemberData(nameof(ExpiryCases))]
public void Link_validity(DateTimeOffset now, bool expected) { /* ... */ }
```

### The lifecycle: a new instance per test

This is the single most important thing to know about xUnit, and it differs from NUnit/MSTest:
**xUnit creates a new instance of the test class for every test.** The constructor is your
"setup", `IDisposable.Dispose` (or `IAsyncLifetime.DisposeAsync`) is your "teardown".

```csharp
public class InviteServiceTests : IDisposable
{
    private readonly IProjectMemberStore _store = Substitute.For<IProjectMemberStore>();
    private readonly InviteService _sut;

    public InviteServiceTests() =>                                          // runs before EACH test
        _sut = new InviteService(_store, Substitute.For<INotifier>(), TimeProvider.System);
    public void Dispose() { /* runs after EACH test */ }
}
```

Why? Isolation. Fields can't leak state from one test into the next, so tests can run in any
order. If you want something **expensive** shared (a database container, a web host), you ask for
it explicitly with a fixture:

| Mechanism | Shared across | Typical use |
|---|---|---|
| Constructor / `Dispose` | nothing (per test) | Fresh mocks, fresh SUT |
| `IClassFixture<T>` | all tests in one class | An expensive object only this class needs |
| `ICollectionFixture<T>` + `[Collection("x")]` | all classes in a collection | One Postgres container for the whole suite |
| `IAsyncLifetime` | (on test class or fixture) | Async setup/teardown: start container, reset DB |

```csharp
public sealed class ExpensiveThing : IAsyncLifetime
{
    public Task InitializeAsync() { /* once, before first test in the class */ return Task.CompletedTask; }
    public Task DisposeAsync()    { /* once, after the last test */ return Task.CompletedTask; }
}

public class SlowTests(ExpensiveThing thing) : IClassFixture<ExpensiveThing>
{
    [Fact] public void A() { /* same `thing` instance as B */ }
    [Fact] public void B() { }
}
```

### Parallelism

By default xUnit 2 runs **test collections in parallel** and the tests **inside** one collection
sequentially. Every test class is its own collection unless you put several classes into a named
collection. That's why database-backed classes share one `[Collection("postgres")]`: they then
run one after another against the same database instead of trampling each other.

:::pro title="xUnit v3"
`dotnet new xunit` on the .NET 10 SDK still scaffolds **xUnit 2** (2.9.x), which this lesson uses.
xUnit **v3** (`xunit.v3` package) is the successor: tests compile to executables and run on the
Microsoft Testing Platform, `IAsyncLifetime` returns `ValueTask`, and you get
`TestContext.Current.CancellationToken` to pass into async calls so a cancelled run stops quickly.
Migration is mostly mechanical; new greenfield projects increasingly start on v3
(`dotnet new install xunit.v3.templates`, then `dotnet new xunit3`).
:::

:::quiz id=be-14-q1 xp=10
A test class has a constructor that writes a line to the console and three `[Fact]` methods.
No fixtures. How many times does the constructor run when you `dotnet test`?
- [ ] Once — the class is created once and the facts are methods on it
- [x] Three times — one fresh instance per test
- [ ] Four times — once for discovery, then once per test
- [ ] It depends on the order the tests run in
> xUnit instantiates the class **per test** so no state leaks between tests. "Once" is the tempting answer if you come from NUnit, where one instance is shared by all tests in a fixture by default; in xUnit that would require an explicit `IClassFixture<T>` / `ICollectionFixture<T>`. Discovery only reads metadata and never calls the constructor.
:::

## Assertions: Assert, Shouldly — and a licensing trap

Built-in `Assert` is fine and has zero dependencies:

```csharp
Assert.Equal(expected, actual);       // expected FIRST — the failure message depends on it
Assert.Null(error);
Assert.Contains("required", error);
var ex = Assert.Throws<ArgumentException>(() => sut.Create(id, ProjectRole.Owner));
await Assert.ThrowsAsync<InvalidOperationException>(() => sut.RunAsync());
```

Many teams prefer a fluent library because failures read better and the argument-order trap
disappears. **Shouldly** (BSD-licensed) reads like English and puts the *expression* in the
failure message:

```csharp
result.ShouldBe(InviteResult.Invited);
// Shouldly failure: "result should be Invited but was Forbidden"
link.ExpiresAt.ShouldBe(new DateTimeOffset(2026, 1, 8, 12, 0, 0, TimeSpan.Zero));
list.Select(p => p.Name).ShouldBe(["Alpha", "Zeta"]);
Should.Throw<ArgumentException>(() => sut.Create(id, ProjectRole.Owner));
await Should.ThrowAsync<InvalidOperationException>(() => sut.RunAsync());
```

:::warn title="FluentAssertions changed its license"
**FluentAssertions v8** (January 2025) moved to a commercial license (Xceed) for commercial use.
Versions 7.x stay Apache-2.0. If you join a company still on `FluentAssertions` 6/7, don't
casually bump to 8 — check with the team. Alternatives: Shouldly, plain `Assert`, or
**AwesomeAssertions**, a community fork of v7 with the same `.Should().Be()` API.
:::

:::quiz id=be-14-q2 xp=15
Spot the bug. This test is green — even when `ArchiveAsync` doesn't throw at all.

```csharp
[Fact]
public void Archiving_twice_throws()
{
    var sut = new ProjectService(_store);
    Assert.ThrowsAsync<InvalidOperationException>(() => sut.ArchiveAsync(_id));
}
```
- [ ] `Assert.ThrowsAsync` only works with `[Theory]`
- [x] The returned `Task` is never awaited, so the assertion's result is thrown away; the method must be `async Task` and `await Assert.ThrowsAsync(...)`
- [ ] `ThrowsAsync` requires the exact exception type `Exception`
- [ ] Nothing — the test correctly fails when no exception is thrown
> `ThrowsAsync` returns a `Task` that faults if the expectation fails. Not awaiting it discards the failure, so the test passes vacuously. xUnit's analyzer flags this (xUnit2021) — treat analyzer warnings in tests as errors.
:::

## Naming and Arrange-Act-Assert

A test name is the first thing you read when CI goes red, often in a log without the code. Make
it a sentence that states **behaviour**, not implementation:

| Weak | Strong |
|---|---|
| `Test1`, `InviteTest` | `Owner_can_invite_a_new_editor` |
| `InviteAsync_Works` | `Non_owners_cannot_invite` |
| `CheckExpiry` | `Link_is_valid_until_just_before_expiry` |

Common styles are `Method_State_ExpectedResult` (`Validate_EmptyName_ReturnsError`) or plain
sentences with underscores. Pick one per codebase and be consistent.

Inside the test, use **Arrange-Act-Assert**: set up, do exactly *one* thing, check the outcome.
Blank lines (or comments) between the three sections make the structure obvious:

```csharp
[Fact]
public async Task Inviting_an_existing_member_is_a_no_op()
{
    // Arrange
    _store.GetRoleAsync(ProjectId, "alice", Arg.Any<CancellationToken>()).Returns(ProjectRole.Owner);
    _store.GetRoleAsync(ProjectId, "bob", Arg.Any<CancellationToken>()).Returns(ProjectRole.Viewer);

    // Act
    var result = await _sut.InviteAsync(ProjectId, "alice", "bob", ProjectRole.Editor);

    // Assert
    result.ShouldBe(InviteResult.AlreadyMember);
    await _store.DidNotReceiveWithAnyArgs().AddAsync(default!, default);
}
```

Several asserts are fine when they describe **one** outcome (the result *and* the side effect).
Several *acts* in one test are a smell: when it fails you don't know which step broke.

## Test doubles and NSubstitute

When the class under test depends on something slow, non-deterministic or external (email,
clock, payment gateway, another service), you replace it with a **test double**:

| Double | What it does | Example |
|---|---|---|
| **Stub** | Returns canned answers | `store.GetRoleAsync(...)` returns `Owner` |
| **Mock** | Records calls so you can verify them | "`NotifyInvitedAsync` was called once with bob" |
| **Fake** | A working lightweight implementation | `FakeTimeProvider`, an in-memory `Dictionary` store |

**NSubstitute** (BSD) does stubs and mocks with very little ceremony. It's the most common choice
in new code; you'll also meet **Moq** in older codebases (same ideas, `mock.Setup(...).Returns(...)`
and `mock.Object`).

```csharp
using NSubstitute;
using NSubstitute.ExceptionExtensions;

var store = Substitute.For<IProjectMemberStore>();

// Stub: when called with these arguments, return this
store.GetRoleAsync(projectId, "alice", Arg.Any<CancellationToken>()).Returns(ProjectRole.Owner);

// Argument matchers
store.GetRoleAsync(Arg.Any<Guid>(), Arg.Is<string>(u => u.StartsWith("admin")), Arg.Any<CancellationToken>())
     .Returns(ProjectRole.Owner);

// Throwing
store.AddAsync(Arg.Any<ProjectMember>(), Arg.Any<CancellationToken>())
     .ThrowsAsync(new TimeoutException());

// Verifying (mock behaviour)
await notifier.Received(1).NotifyInvitedAsync("bob", projectId, ProjectRole.Editor, Arg.Any<CancellationToken>());
await notifier.DidNotReceiveWithAnyArgs().NotifyInvitedAsync(default!, default, default, default);
```

Two details that bite everyone:

1. **Unconfigured calls return defaults.** A `Task<ProjectRole?>` method you didn't stub returns a
   completed task with `null`; a `Task<int>` returns `0`. (NSubstitute even returns `""` for
   strings, empty arrays, and a fresh substitute for interface return types.) No exception: your
   code just takes the "not found" branch, and the test fails somewhere confusing.
2. **Arguments must match exactly.** `CancellationToken` is a value; stubbing with `default` won't
   match a call that passes a real token. Use `Arg.Any<CancellationToken>()`.

:::quiz id=be-14-q3 xp=15
What does `result` contain?

```csharp
var store = Substitute.For<IProjectMemberStore>();
store.GetRoleAsync(projectId, "alice", CancellationToken.None).Returns(ProjectRole.Owner);
store.GetRoleAsync(projectId, "bob", CancellationToken.None).Returns((ProjectRole?)null);
var sut = new InviteService(store, notifier, TimeProvider.System);

using var cts = new CancellationTokenSource();
var result = await sut.InviteAsync(projectId, "alice", "bob", ProjectRole.Editor, cts.Token);
// InviteAsync passes its ct through to store.GetRoleAsync(...)
```
- [ ] `InviteResult.Invited`
- [x] `InviteResult.Forbidden`
- [ ] It throws — NSubstitute can't find a matching configuration
- [ ] `InviteResult.AlreadyMember`
> The stubs were configured for `CancellationToken.None`, but the call passes `cts.Token`, a different value, so no stub matches. NSubstitute doesn't throw for unmatched calls (that's the tempting answer); it silently returns the default (`null`) for alice's role, and the service concludes alice isn't an owner. Fix: `Arg.Any<CancellationToken>()`.
:::

### Don't mock what you don't own

Mocking `DbContext`, `DbSet<T>`, `HttpClient` or `IConfiguration` produces tests that pass while
production fails, because the *behaviour* that matters (SQL translation, HTTP status handling,
config binding) is exactly what the mock replaces with your assumptions. Instead:

- **Database** → integration test with real Postgres (be-15).
- **Outgoing HTTP** → a fake `HttpMessageHandler` that returns canned responses, or WireMock.Net.
- **Configuration** → build a real `IConfiguration` with `AddInMemoryCollection`, or just pass
  options objects.
- **Your own interfaces** (`INotifier`, `IProjectMemberStore`) → mock freely; you define their
  contract.

Over-mocking has a second cost: tests that verify *every* call (`Received` on every collaborator)
are welded to the implementation. Refactor the internals without changing behaviour and twenty
tests go red. Verify **outcomes** and the side effects that matter to the business ("an email was
sent"), not the choreography.

:::quiz id=be-14-q4 xp=15
Which of these are good candidates for **integration** tests rather than unit tests with mocks? (Select all that apply.)
- [x] A repository method that filters projects by membership using `.Where(p => p.Members.Any(...))`
- [ ] The rule "share links can't grant the Owner role"
- [x] That `POST /projects` with an empty name returns `400` with `application/problem+json`
- [x] That inserting a second member with the same `(ProjectId, UserId)` returns `409`, not `500`
- [ ] The full-jitter backoff formula
> Queries, HTTP contracts and database constraints live in the seams between your code and the framework/database — mocks would replace exactly the part that can break (a mocked `DbSet` runs your `Where` as LINQ-to-Objects, never as SQL). The "no Owner links" rule and the backoff formula are decisions made by your own code with no I/O: unit tests check them precisely in microseconds, including every edge case.
:::

## Testing time with TimeProvider

Code that calls `DateTime.UtcNow` or `DateTimeOffset.UtcNow` directly is **untestable at the
edges**: you can't check "valid until exactly 7 days later" without sleeping for a week. Worse,
the test and the code each read the clock at slightly different moments, so tests that compare
against "now" become flaky around boundaries such as midnight or month ends. The fix is to treat
the current time like any other dependency: pass it in.

Since .NET 8 the BCL has an abstraction for this: **`TimeProvider`**. Inject it, call
`GetUtcNow()`, and register the real one in production:

```csharp
// Program.cs
builder.Services.AddSingleton(TimeProvider.System);

// Your code
public sealed class ShareLinkService(TimeProvider time)
{
    public bool IsValid(ShareLink link) => time.GetUtcNow() < link.ExpiresAt;
}
```

In tests, use **`FakeTimeProvider`** from `Microsoft.Extensions.TimeProvider.Testing`. You set
the start time and move it forward explicitly:

```csharp
var time = new FakeTimeProvider(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
var sut = new ShareLinkService(time);
var link = sut.Create(projectId, ProjectRole.Editor, TimeSpan.FromHours(1));

time.Advance(TimeSpan.FromMinutes(59));
sut.IsValid(link).ShouldBeTrue();

time.Advance(TimeSpan.FromMinutes(1));   // exactly at ExpiresAt
sut.IsValid(link).ShouldBeFalse();
```

`TimeProvider` also covers **timers and delays**: `Task.Delay(delay, timeProvider, ct)`,
`timeProvider.CreateTimer(...)`, and `PeriodicTimer` via `new PeriodicTimer(period, timeProvider)`.
With a `FakeTimeProvider`, those fire when you call `Advance` — so you can test a "retry after
30 seconds" loop in microseconds.

:::quiz id=be-14-q5 xp=15
This test passes all day long, but now and then it fails in the **nightly CI build, which starts
just before midnight UTC**. What's the right fix?

```csharp
// The trial runs through the end of the 30th calendar day (UTC).
public bool IsTrialActive(Account a) => DateTime.UtcNow.Date <= a.CreatedAt.Date.AddDays(30);

[Fact]
public void Trial_is_still_active_on_day_30()
{
    var account = new Account { CreatedAt = DateTime.UtcNow.AddDays(-30) };
    Assert.True(_sut.IsTrialActive(account));
}
```
- [ ] Retry failed tests up to 3 times in CI so the rare failure disappears
- [ ] Move the nightly build to 02:00 UTC so it never runs across midnight
- [x] Inject `TimeProvider` into the service and use a `FakeTimeProvider` with a fixed instant in the test
- [ ] Use `DateTime.Now` instead of `DateTime.UtcNow` in both places
> The clock is read **twice**: once in the test (to build `CreatedAt`) and once in the code. If midnight falls between the two reads, the code's "today" is one day later and the trial looks expired. Injecting `TimeProvider` makes time an input you control: both reads see the same instant, and you can test the exact boundaries (23:59:59 on day 30, 00:00:00 on day 31) on purpose. Retries and moving the schedule only hide the race, and `DateTime.Now` adds time-zone and daylight-saving problems on top.
:::

:::quiz id=be-14-q6 xp=10
Two tests in the same class both use an `IClassFixture<SharedList>` whose `Items` is a `List<string>`.
Test A adds `"x"` and asserts `Items.Count == 1`. Test B adds `"y"` and asserts `Items.Count == 1`.
What happens?
- [ ] Both pass — xUnit gives each test a fresh fixture
- [x] One of them fails; which one depends on execution order
- [ ] Both fail because fixtures are read-only
- [ ] xUnit refuses to run tests that mutate fixtures
> A class fixture is created **once** and shared by every test in the class (the test *class* is new per test, the *fixture* is not). Whichever test runs second sees two items and fails. Mutating a fixture couples the tests and makes them order-dependent. Keep shared fixtures immutable (or reset them in the test's constructor / `InitializeAsync`) — exactly what we'll do with Respawn for databases.
:::

:::pro title="Is my test suite any good? Mutation testing"
Code coverage (`dotnet test --collect:"XPlat Code Coverage"` via coverlet) tells you which lines
*ran*, not whether any assertion would notice them being wrong. **Stryker.NET**
(`dotnet tool install -g dotnet-stryker`) mutates your code — flips `<` to `<=`, deletes a
statement, replaces `true` with `false` — and reruns the tests. A mutant that survives means no
test cares about that line. You'll do a manual version of this in the lab.
:::

## Lab: unit-test the project-sharing rules

:::lab id=be-14-lab1 xp=120
title: Unit-test invites and share links

You'll build a tiny domain library for the Projects API — name validation, expiring share links
and the "only owners can invite" rule — and a test project that covers it with facts, theories,
NSubstitute and `FakeTimeProvider`. Then you'll break the code on purpose to see the tests catch it.

**1. Create the solution** (requires the .NET 10 SDK; `dotnet --version` should print `10.0.x`):

```bash
mkdir -p ~/devquest/be-14-lab1 && cd ~/devquest/be-14-lab1
dotnet new sln -n Projects
dotnet new classlib -o src/Projects.Core
dotnet new xunit -o tests/Projects.Core.Tests
dotnet sln add src/Projects.Core tests/Projects.Core.Tests
dotnet add tests/Projects.Core.Tests reference src/Projects.Core
dotnet add tests/Projects.Core.Tests package NSubstitute
dotnet add tests/Projects.Core.Tests package Shouldly
dotnet add tests/Projects.Core.Tests package Microsoft.Extensions.TimeProvider.Testing
rm src/Projects.Core/Class1.cs tests/Projects.Core.Tests/UnitTest1.cs
```

On .NET 10, `dotnet new sln` creates a `Projects.slnx` (the new XML solution format) — that's expected.

**2. Add the domain code.** Create these four files in `src/Projects.Core/`.

`src/Projects.Core/Domain.cs`

```csharp
namespace Projects.Core;

public enum ProjectRole { Viewer, Editor, Owner }

public sealed record ProjectMember(Guid ProjectId, string UserId, ProjectRole Role, DateTimeOffset JoinedAt);

public sealed record ShareLink(Guid ProjectId, ProjectRole Role, string Token, DateTimeOffset ExpiresAt);

public enum InviteResult { Invited, Forbidden, AlreadyMember, CannotInviteOwner }

public interface IProjectMemberStore
{
    Task<ProjectRole?> GetRoleAsync(Guid projectId, string userId, CancellationToken ct);
    Task AddAsync(ProjectMember member, CancellationToken ct);
}

public interface INotifier
{
    Task NotifyInvitedAsync(string userId, Guid projectId, ProjectRole role, CancellationToken ct);
}
```

`src/Projects.Core/ProjectName.cs`

```csharp
namespace Projects.Core;

public static class ProjectName
{
    public const int MinLength = 3;
    public const int MaxLength = 80;

    /// <summary>Returns null when valid, otherwise a human-readable error.</summary>
    public static string? Validate(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "Name is required.";
        var trimmed = name.Trim();
        if (trimmed.Length < MinLength) return $"Name must be at least {MinLength} characters.";
        if (trimmed.Length > MaxLength) return $"Name must be at most {MaxLength} characters.";
        if (trimmed.Any(char.IsControl)) return "Name must not contain control characters.";
        return null;
    }
}
```

`src/Projects.Core/ShareLinkService.cs`

```csharp
using System.Security.Cryptography;

namespace Projects.Core;

public sealed class ShareLinkService(TimeProvider time)
{
    public static readonly TimeSpan DefaultLifetime = TimeSpan.FromDays(7);

    public ShareLink Create(Guid projectId, ProjectRole role, TimeSpan? lifetime = null)
    {
        if (role == ProjectRole.Owner)
            throw new ArgumentException("Share links cannot grant ownership.", nameof(role));

        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        var expiresAt = time.GetUtcNow() + (lifetime ?? DefaultLifetime);
        return new ShareLink(projectId, role, token, expiresAt);
    }

    public bool IsValid(ShareLink link) => time.GetUtcNow() < link.ExpiresAt;
}
```

`src/Projects.Core/InviteService.cs`

```csharp
namespace Projects.Core;

public sealed class InviteService(IProjectMemberStore store, INotifier notifier, TimeProvider time)
{
    public async Task<InviteResult> InviteAsync(
        Guid projectId, string inviterId, string inviteeId, ProjectRole role, CancellationToken ct = default)
    {
        if (role == ProjectRole.Owner) return InviteResult.CannotInviteOwner;

        var inviterRole = await store.GetRoleAsync(projectId, inviterId, ct);
        if (inviterRole != ProjectRole.Owner) return InviteResult.Forbidden;

        var existing = await store.GetRoleAsync(projectId, inviteeId, ct);
        if (existing is not null) return InviteResult.AlreadyMember;

        await store.AddAsync(new ProjectMember(projectId, inviteeId, role, time.GetUtcNow()), ct);
        await notifier.NotifyInvitedAsync(inviteeId, projectId, role, ct);
        return InviteResult.Invited;
    }
}
```

**3. Paste the tests.** Create these three files in `tests/Projects.Core.Tests/`.

`tests/Projects.Core.Tests/ProjectNameTests.cs`

```csharp
using Projects.Core;
using Shouldly;

namespace Projects.Core.Tests;

public class ProjectNameTests
{
    [Theory]
    [InlineData("Apollo")]
    [InlineData("abc")]                 // exactly the minimum
    [InlineData("  Moon base  ")]       // trimmed before checking
    public void Validate_returns_null_for_valid_names(string name)
    {
        ProjectName.Validate(name).ShouldBeNull();
    }

    [Theory]
    [InlineData(null, "required")]
    [InlineData("", "required")]
    [InlineData("   ", "required")]
    [InlineData("ab", "at least")]
    [InlineData("a\tb\nc", "control")]
    public void Validate_returns_error_for_invalid_names(string? name, string expectedFragment)
    {
        var error = ProjectName.Validate(name);

        error.ShouldNotBeNull();
        error.ShouldContain(expectedFragment);
    }

    [Fact]
    public void Validate_rejects_names_longer_than_max()
    {
        var tooLong = new string('x', ProjectName.MaxLength + 1);

        ProjectName.Validate(tooLong).ShouldNotBeNull();
        ProjectName.Validate(tooLong[..^1]).ShouldBeNull(); // 80 chars is fine
    }
}
```

`tests/Projects.Core.Tests/ShareLinkServiceTests.cs`

```csharp
using Microsoft.Extensions.Time.Testing;
using Projects.Core;
using Shouldly;

namespace Projects.Core.Tests;

public class ShareLinkServiceTests
{
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 1, 1, 12, 0, 0, TimeSpan.Zero));
    private readonly ShareLinkService _sut;

    public ShareLinkServiceTests() => _sut = new ShareLinkService(_time);

    [Fact]
    public void Create_sets_expiry_seven_days_from_now_by_default()
    {
        var link = _sut.Create(Guid.NewGuid(), ProjectRole.Viewer);

        link.ExpiresAt.ShouldBe(new DateTimeOffset(2026, 1, 8, 12, 0, 0, TimeSpan.Zero));
        link.Token.Length.ShouldBe(32);
    }

    [Fact]
    public void Link_is_valid_until_just_before_expiry()
    {
        var link = _sut.Create(Guid.NewGuid(), ProjectRole.Editor, TimeSpan.FromHours(1));

        _time.Advance(TimeSpan.FromMinutes(59));
        _sut.IsValid(link).ShouldBeTrue();

        _time.Advance(TimeSpan.FromMinutes(1)); // exactly at ExpiresAt
        _sut.IsValid(link).ShouldBeFalse();
    }

    [Fact]
    public void Create_refuses_owner_links()
    {
        Should.Throw<ArgumentException>(() => _sut.Create(Guid.NewGuid(), ProjectRole.Owner));
    }
}
```

`tests/Projects.Core.Tests/InviteServiceTests.cs`

```csharp
using Microsoft.Extensions.Time.Testing;
using NSubstitute;
using Projects.Core;
using Shouldly;

namespace Projects.Core.Tests;

public class InviteServiceTests
{
    private static readonly Guid ProjectId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private readonly IProjectMemberStore _store = Substitute.For<IProjectMemberStore>();
    private readonly INotifier _notifier = Substitute.For<INotifier>();
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 3, 1, 9, 0, 0, TimeSpan.Zero));
    private readonly InviteService _sut;

    public InviteServiceTests() => _sut = new InviteService(_store, _notifier, _time);

    [Fact]
    public async Task Owner_can_invite_a_new_editor()
    {
        // Arrange
        _store.GetRoleAsync(ProjectId, "alice", Arg.Any<CancellationToken>()).Returns(ProjectRole.Owner);
        _store.GetRoleAsync(ProjectId, "bob", Arg.Any<CancellationToken>()).Returns((ProjectRole?)null);

        // Act
        var result = await _sut.InviteAsync(ProjectId, "alice", "bob", ProjectRole.Editor);

        // Assert
        result.ShouldBe(InviteResult.Invited);
        await _store.Received(1).AddAsync(
            Arg.Is<ProjectMember>(m => m.UserId == "bob" && m.Role == ProjectRole.Editor && m.JoinedAt == _time.GetUtcNow()),
            Arg.Any<CancellationToken>());
        await _notifier.Received(1).NotifyInvitedAsync("bob", ProjectId, ProjectRole.Editor, Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(ProjectRole.Editor)]
    [InlineData(ProjectRole.Viewer)]
    public async Task Non_owners_cannot_invite(ProjectRole inviterRole)
    {
        _store.GetRoleAsync(ProjectId, "carol", Arg.Any<CancellationToken>()).Returns(inviterRole);

        var result = await _sut.InviteAsync(ProjectId, "carol", "dave", ProjectRole.Viewer);

        result.ShouldBe(InviteResult.Forbidden);
        await _store.DidNotReceiveWithAnyArgs().AddAsync(default!, default);
        await _notifier.DidNotReceiveWithAnyArgs().NotifyInvitedAsync(default!, default, default, default);
    }

    [Fact]
    public async Task Inviting_an_existing_member_is_a_no_op()
    {
        _store.GetRoleAsync(ProjectId, "alice", Arg.Any<CancellationToken>()).Returns(ProjectRole.Owner);
        _store.GetRoleAsync(ProjectId, "bob", Arg.Any<CancellationToken>()).Returns(ProjectRole.Viewer);

        var result = await _sut.InviteAsync(ProjectId, "alice", "bob", ProjectRole.Editor);

        result.ShouldBe(InviteResult.AlreadyMember);
        await _store.DidNotReceiveWithAnyArgs().AddAsync(default!, default);
    }

    [Fact]
    public async Task Nobody_can_be_invited_as_owner()
    {
        var result = await _sut.InviteAsync(ProjectId, "alice", "bob", ProjectRole.Owner);

        result.ShouldBe(InviteResult.CannotInviteOwner);
        await _store.DidNotReceiveWithAnyArgs().GetRoleAsync(default, default!, default); // rejected before any lookup
    }
}
```

**4. Run the suite:**

```bash
dotnet test
```

Expected (the summary line; exact wording depends on your OS language):

```text
Passed!  - Failed:     0, Passed:    17, Skipped:     0, Total:    17, Duration: 70 ms - Projects.Core.Tests.dll (net10.0)
```

17 tests from 10 methods — each `InlineData` row counts as its own test.

**5. Be the mutant.** Make each change below in `src/Projects.Core`, run `dotnet test`, note
whether a test goes red (and *read the failure message*), then undo it:

1. In `ShareLinkService.IsValid`, change `<` to `<=`.
2. In `InviteService`, change `if (inviterRole != ProjectRole.Owner)` to `if (inviterRole == ProjectRole.Viewer)`.
3. In `InviteService`, delete the `await notifier.NotifyInvitedAsync(...)` line.
4. In `ProjectName.Validate`, change `trimmed.Length < MinLength` to `name.Length < MinLength`.

Mutations 1–3 each turn exactly one test red. **Mutation 4 survives**: all 17 tests stay green
even though the code is now wrong. Coverage would call this line 100% covered, and yet nothing
checks it. Why? Every short input in the suite (`"ab"`) has no surrounding spaces, so trimmed and
untrimmed lengths agree. Kill the mutant: add `[InlineData(" ab ", "at least")]` to
`Validate_returns_error_for_invalid_names` (`" ab "` has length 4 untrimmed but 2 trimmed), check
that the mutant now fails a test, then restore the original code.

**6. Write one test yourself.** Add a `[Theory]` to `ShareLinkServiceTests` that checks a custom
lifetime (`TimeSpan.FromMinutes(15)`, `TimeSpan.FromDays(30)`) sets `ExpiresAt` to exactly
"now + lifetime". `InlineData` only takes constants, so pass minutes as an `int` and convert
inside the test.

:::tip
Run a single test class while iterating: `dotnet test --filter "FullyQualifiedName~InviteServiceTests"`.
`dotnet watch test` reruns on every save.
:::

- [ ] `dotnet test` reports 17 passing tests on the provided code
- [ ] Mutations 1–3 from step 5 each turn a test red (and I put the code back)
- [ ] Mutation 4 survived at first; my new `" ab "` row kills it, and the suite is green again on the original code (18 tests before step 6)
- [ ] My own custom-lifetime `[Theory]` passes and fails if I break `Create`
:::

## Spot-the-bug round

:::quiz id=be-14-q7 xp=15
A teammate's test for "deleting a project notifies members" keeps passing even after someone
removed the notification code. Why?

```csharp
[Fact]
public async Task Delete_notifies_members()
{
    var notifier = Substitute.For<INotifier>();
    var sut = new ProjectService(_store, notifier);

    await sut.DeleteAsync(_projectId, "alice");

    notifier.NotifyDeletedAsync(_projectId, Arg.Any<CancellationToken>());
}
```
- [ ] NSubstitute verifies every call automatically at the end of the test
- [x] The last line *calls* the substitute instead of verifying it — it needs `.Received()` before the method: `await notifier.Received().NotifyDeletedAsync(...)`
- [ ] `Arg.Any` can't be used outside `Returns`
- [ ] Substitutes must be created in the constructor to record calls
> Without `Received()`, the line is just another call on the substitute, which is recorded and ignored. There's no assertion in the test at all. NSubstitute's analyzers (`NSubstitute.Analyzers.CSharp`) catch several of these mistakes — worth adding to test projects.
:::

:::quiz id=be-14-q8 xp=10
Which statement about `Assert.Equal(expected, actual)` is true?
- [ ] Argument order doesn't matter because equality is symmetric
- [x] The order only affects the failure message, but a swapped order makes the message lie ("Expected: 3, Actual: 2" when the code returned 3)
- [ ] Swapping the arguments makes the test pass when it should fail
- [ ] xUnit reorders the arguments automatically using caller info
> The comparison is symmetric; the diagnostics aren't. A misleading failure message wastes debugging time at 2 a.m. — one reason teams like Shouldly's `actual.ShouldBe(expected)`, which has no order to get wrong.
:::

## Flashcards

:::cards id=be-14-cards1 xp=20 title="Testing .NET"
Q: `[Fact]` vs `[Theory]`?
A: A Fact is a parameterless test. A Theory runs once per data row (`InlineData`, `MemberData`, `ClassData`); each row is reported as its own test.
Q: How often does xUnit create the test class?
A: Once per test. The constructor is setup, `Dispose`/`DisposeAsync` is teardown.
Q: `IClassFixture<T>` vs `ICollectionFixture<T>`?
A: Class fixture: one instance shared by all tests in a class. Collection fixture: one instance shared by every class marked `[Collection("name")]` (and those classes then run sequentially).
Q: What runs in parallel in xUnit 2 by default?
A: Test collections run in parallel; tests within a collection run sequentially. Each class is its own collection unless grouped.
Q: Stub vs mock vs fake?
A: Stub returns canned answers; mock records calls so you can verify them; fake is a working lightweight implementation (in-memory store, FakeTimeProvider).
Q: NSubstitute: stub a call and verify a call.
A: `sub.Method(args).Returns(value)`; `await sub.Received(1).Method(args)` / `DidNotReceiveWithAnyArgs()`.
Q: Why `Arg.Any<CancellationToken>()`?
A: Arguments must match exactly; a stub configured with `default` won't match a call passing a real token, so the default value is returned instead.
Q: How do you test code that depends on the current time?
A: Inject `TimeProvider` (register `TimeProvider.System`), and in tests use `FakeTimeProvider` from Microsoft.Extensions.TimeProvider.Testing with `Advance`/`SetUtcNow`.
Q: What licensing change matters for assertion libraries?
A: FluentAssertions v8 is commercially licensed (Xceed). Alternatives: Shouldly, plain Assert, AwesomeAssertions (v7 fork), or staying on FluentAssertions 7.
Q: Why not mock DbContext?
A: The behaviour that breaks (SQL translation, constraints, transactions) is exactly what the mock replaces. Test data access against real Postgres instead.
Q: What does mutation testing measure?
A: Whether tests detect deliberate code changes (mutants). Surviving mutants show code no assertion cares about. Tool: Stryker.NET.
:::

## Recap

- Tests exist so you can **change code safely**. Unit-test decisions (rules, calculations, state);
  integration-test seams (HTTP, DI, SQL, JSON) — for APIs the middle layer is cheap and valuable.
- xUnit: `[Fact]`, `[Theory]` + `InlineData`/`MemberData`; **new instance per test**; share
  expensive things via `IClassFixture` / `ICollectionFixture`; `IAsyncLifetime` for async setup.
- Name tests as behaviour sentences, structure them Arrange-Act-Assert, and always **await**
  async assertions.
- NSubstitute: `Returns`, `Received`, `Arg.Any`/`Arg.Is`. Unstubbed calls return defaults;
  arguments must match. Mock your own interfaces, not `DbContext` or `HttpClient`.
- Make time an input: `TimeProvider` in code, `FakeTimeProvider` in tests.
- Shouldly or `Assert` are safe choices; FluentAssertions v8 needs a commercial license.
- Check your suite's teeth by mutating the code (by hand or with Stryker.NET).
