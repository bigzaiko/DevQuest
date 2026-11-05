---
id: be-12
title: API Architecture That Stays Simple
level: advanced
minutes: 55
xp: 150
summary: Controllers vs minimal APIs, route groups and feature modules, vertical slices vs clean architecture, the repository debate and MediatR — and how to keep it simple.
---

Every API starts as a tidy `Program.cs`. Six months later it's 900 lines long, or it has been
"cleaned up" into eleven projects where adding a field means touching nine files. Both are
architecture failures. Architecture isn't about how many layers you have. It's about **how
expensive the next change is**.

This lesson gives you a default structure that works for most SaaS backends. It also gives you the
vocabulary to discuss the alternatives in an interview or a design review: controllers, minimal
APIs, clean/onion, vertical slices, repositories, MediatR.

## Controllers vs. minimal APIs

ASP.NET Core has two first-class ways to declare HTTP endpoints. They share the same routing,
model binding, DI, auth, OpenAPI and middleware, so the choice is about **style and features**, not
performance.

```csharp
// Controller style
[ApiController]
[Route("api/projects")]
public class ProjectsController(AppDbContext db) : ControllerBase
{
    [HttpGet("{id:guid}")]
    public async Task<ActionResult<ProjectDto>> Get(Guid id, CancellationToken ct)
    {
        var p = await db.Projects.FindAsync([id], ct);
        return p is null ? NotFound() : ProjectDto.From(p);
    }
}
// Program.cs: builder.Services.AddControllers(); ... app.MapControllers();
```

```csharp
// Minimal API style
app.MapGet("/api/projects/{id:guid}", async Task<Results<Ok<ProjectDto>, NotFound>> (
    Guid id, AppDbContext db, CancellationToken ct) =>
        await db.Projects.FindAsync([id], ct) is { } p
            ? TypedResults.Ok(ProjectDto.From(p))
            : TypedResults.NotFound());
```

| | Controllers | Minimal APIs |
|---|---|---|
| Grouping | a class per resource | route groups + extension methods |
| Cross-cutting | MVC filters (`IActionFilter`, …) | endpoint filters, group conventions |
| Validation | `[ApiController]` returns 400 automatically when `ModelState` is invalid | built-in `AddValidation()` since .NET 10, or explicit checks / FluentValidation |
| DI | constructor (shared by every action in the class) | per-handler parameters: each endpoint gets only what it uses |
| Return types | `ActionResult<T>` | `TypedResults` + `Results<A, B, …>` (precise OpenAPI, unit-testable) |
| Native AOT | not supported | supported (with the request delegate generator) |
| Microsoft's direction | stable, fully supported | where new features land first |

Both are fine for production. A team with a big MVC codebase should *not* rewrite it. For a new
service in .NET 10, minimal APIs are the default in the templates and in the docs, and they push
you toward small, focused handlers. That's the style we use in this track.

:::job title="Your first job will probably have controllers"
Most existing .NET codebases you'll join use controllers: `[ApiController]`, MVC filters, model binding
attributes, sometimes a `Startup.cs`, AutoMapper and MediatR, often on .NET 6 or 8. The next lesson,
**Joining an Existing .NET Codebase**, is about exactly that: reading a controller-based API, mapping its
patterns to what you learn here, and upgrading it to .NET 10 safely. Everything in this lesson about
layers, slices and keeping things simple applies to both styles.
:::

:::quiz id=be-12-q1 xp=10
A controller has 14 actions and its constructor takes 9 dependencies. A `GET /api/projects` request
comes in. What does the DI container do?

- [ ] Resolves only the dependencies the `List` action uses
- [x] Resolves all 9 constructor dependencies (and their dependency graphs) to create the controller, even though `List` uses one
- [ ] Reuses a singleton controller instance
- [ ] Nothing, because controllers are created at startup
> Controllers are created per request through their constructor, so every dependency is resolved for every action. Fat controllers become slow to construct and painful to test. Minimal API handlers, and controllers split per feature, only ask for what they need.
:::

## Organizing minimal APIs: route groups and feature modules

be-07 already gave you the building blocks: `MapGroup` for shared prefixes and metadata, and one static
class per feature with a `Map…Endpoints` extension method so `Program.cs` only composes. This section
is about what changes when that pattern carries a whole product. In the Projects API it looks like this:

```csharp
// Program.cs stays tiny: it composes, it doesn't implement
app.MapProjectEndpoints();
app.MapDocumentEndpoints();
app.MapSharingEndpoints();

public static class ProjectEndpoints
{
    public static IEndpointRouteBuilder MapProjectEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/projects")
            .WithTags("Projects")
            .RequireAuthorization()               // every endpoint in the group (be-13)
            .AddEndpointFilter<RequestLoggingFilter>();

        group.MapGet("/", ListProjects.Handle);
        group.MapGet("/{id:guid}", GetProject.Handle).WithName(GetProject.RouteName);
        group.MapPost("/", CreateProject.Handle);
        group.MapPut("/{id:guid}", RenameProject.Handle);

        // groups nest: /api/projects/{projectId}/members inherits auth AND the filter
        var members = group.MapGroup("/{projectId:guid}/members");
        members.MapGet("/", ListMembers.Handle);

        return app;
    }
}
```

What's new compared with be-07: the handlers are **one class per use case** (`CreateProject.Handle`), not
private methods in the endpoints class. That's the step towards vertical slices below. And conventions
applied to a group (`RequireAuthorization`, `AddEndpointFilter`, `RequireRateLimiting`, `CacheOutput`, …)
are inherited by **nested groups**, which is how you make "every project endpoint requires auth"
impossible to forget as the API grows.

### Endpoint filters: the minimal-API pipeline

An **endpoint filter** is code that runs *around* a handler, after routing and model binding, with
access to the handler's arguments. It can short-circuit (return a result without calling the handler)
or post-process. Middleware sees only the raw `HttpContext`; a filter sees the bound, typed arguments.
Here is the `RequestLoggingFilter` used above:

```csharp
public sealed class RequestLoggingFilter(ILogger<RequestLoggingFilter> logger) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var started = TimeProvider.System.GetTimestamp();
        var result = await next(context);                        // run the handler (or the next filter)
        logger.LogInformation("{Method} {Path} handled in {Elapsed} ms",
            context.HttpContext.Request.Method, context.HttpContext.Request.Path,
            TimeProvider.System.GetElapsedTime(started).TotalMilliseconds);
        return result;
    }
}
```

A validation filter would instead inspect `context.Arguments`, and `return TypedResults.ValidationProblem(...)`
*without* calling `next` when the input is bad. Filters registered on a group run in the order you
add them, outermost first.

:::quiz id=be-12-q8 xp=10
An endpoint filter returns `TypedResults.ValidationProblem(errors)` **without** calling `next(context)`. What happens?

- [ ] The handler still runs, and its result replaces the filter's
- [x] The handler never runs; the client gets the 400 problem response from the filter
- [ ] ASP.NET Core throws because every filter must call `next`
- [ ] The request falls through to the next matching route
> Not calling `next` short-circuits the pipeline, exactly like middleware that doesn't call `next`. That's how validation filters stop bad input before it reaches your handler. Routing has already chosen this endpoint, so there is no "next route" to fall through to.
:::

### Handlers as static methods with `TypedResults`

be-07 introduced `TypedResults` and `Results<…>` return types. At architecture scale, pointing `MapGet` at
a **named method** instead of an inline lambda pays off twice:

1. **OpenAPI knows every outcome.** `Results<Ok<ProjectDto>, NotFound>` documents both 200 and 404
   with no extra attributes.
2. **You can unit-test the handler by calling it.** There's no HTTP, no server, no mocking of
   `HttpContext`. You call the method and assert on the result type.

```csharp
public static class GetProject
{
    public const string RouteName = "GetProject";

    public static async Task<Results<Ok<ProjectDto>, NotFound>> Handle(
        Guid id, IProjectStore store, CancellationToken ct) =>
        await store.FindAsync(id, ct) is { } project
            ? TypedResults.Ok(ProjectDto.From(project))
            : TypedResults.NotFound();
}

// In a test:
var result = await GetProject.Handle(Guid.NewGuid(), store, default);
Assert.IsType<NotFound>(result.Result);
```

:::tip title="TypedResults vs Results"
`Results.Ok(x)` returns `IResult`, so the compiler and OpenAPI lose the type. `TypedResults.Ok(x)`
returns `Ok<T>`. Always prefer `TypedResults` in handlers. The union `Results<T1, …, T6>` lets one
method return several of them.
:::

:::quiz id=be-12-q2 xp=15
What URL does this endpoint answer?

```csharp
var api = app.MapGroup("/api");
var projects = api.MapGroup("/projects").RequireAuthorization();
projects.MapGroup("/{projectId:guid}/documents")
        .MapGet("/{docId:guid}", GetDocument.Handle);
```

- [ ] `/{docId}`, because nested groups don't combine prefixes
- [ ] `/api/{projectId}/documents/{docId}`
- [x] `/api/projects/{projectId}/documents/{docId}`, and it requires authorization
- [ ] `/api/projects/{projectId}/documents/{docId}`, but without authorization, because conventions don't flow into nested groups
> Group prefixes concatenate, and conventions such as `RequireAuthorization()` apply to everything below the group, including nested groups. That's why groups are the right place for cross-cutting policy.
:::

:::quiz id=be-12-q3 xp=15
This handler doesn't compile. Why?

```csharp
public static async Task<Results<Ok<ProjectDto>, NotFound>> Handle(
    Guid id, IProjectStore store, CancellationToken ct)
{
    var p = await store.FindAsync(id, ct);
    if (p is null) return TypedResults.NotFound();
    if (p.IsArchived) return TypedResults.Conflict();
    return TypedResults.Ok(ProjectDto.From(p));
}
```

- [ ] `TypedResults.NotFound()` must be `Results.NotFound()`
- [x] `Conflict` isn't one of the union's types; add it: `Results<Ok<ProjectDto>, NotFound, Conflict>`
- [ ] Async handlers can't return `Results<…>`
- [ ] Minimal APIs can't return 409
> `Results<…>` has implicit conversions only from the listed types. That's a feature: the compiler forces your signature, and therefore your OpenAPI document, to list every status code the handler can produce. Switching to `Results.NotFound()` would make things *worse*: it returns the untyped `IResult`, which can't convert to `Results<…>` either. Async and 409 are both perfectly fine.
:::

## Layers: clean / onion architecture

The classic "enterprise" layout splits code **by technical concern**, in concentric rings where
dependencies only point inward:

```text
┌────────────────────────── Api (endpoints, DI wiring) ───────────────────┐
│  ┌──────────────── Infrastructure (EF Core, Redis, email) ───────────┐  │
│  │  ┌──────────── Application (use cases, interfaces, DTOs) ─────┐   │  │
│  │  │  ┌──────── Domain (entities, rules, no dependencies) ──┐   │   │  │
│  │  │  └─────────────────────────────────────────────────────┘   │   │  │
│  │  └────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
        Dependency rule: Domain ← Application ← Infrastructure / Api
```

The **dependency rule** is the valuable idea: the domain (business rules) doesn't reference
EF Core, ASP.NET or anything else. Application declares *interfaces* (`IEmailSender`,
`IProjectRepository`) and Infrastructure *implements* them. That's **dependency inversion**: the
high-level code owns the abstraction, the low-level code adapts to it. Concretely, in project references:

```text
Projects.Domain          → (nothing)
Projects.Application     → Domain
Projects.Infrastructure  → Application, Domain      (+ EF Core, SMTP client, …)
Projects.Api             → Application, Infrastructure  ← the composition root
```

The **composition root** is the one place that knows every concrete type and wires interfaces to
implementations in DI. In ASP.NET Core that's `Program.cs` in the Api project
(`services.AddScoped<IEmailSender, SmtpEmailSender>()`).

**What it buys you:** business rules you can test in isolation, swappable infrastructure, and a
clear place for each kind of code. **What it costs:** one feature is spread across four projects,
lots of mapping between near-identical types, interfaces with exactly one implementation, and
ceremony that slows down small teams. A common symptom is the "pass-through" service that only
forwards to a repository that only forwards to `DbContext`.

## Vertical slices

Vertical slice architecture splits code **by feature** instead. Each use case ("create project",
"rename project", "share project") is a self-contained slice: request, validation, handler and
response, usually in one file. Slices may share a domain model and the `DbContext`, but they
don't share "service" layers.

```text
src/Projects.Api/
├─ Program.cs
├─ Domain/                       ← entities + business rules (shared)
│  └─ Project.cs
├─ Infrastructure/               ← DbContext, external clients (shared)
│  └─ AppDbContext.cs
└─ Features/
   ├─ Projects/
   │  ├─ ProjectEndpoints.cs     ← URLs for this feature
   │  ├─ CreateProject.cs        ← request + validation + handler
   │  ├─ GetProject.cs
   │  ├─ ListProjects.cs
   │  └─ RenameProject.cs
   └─ Sharing/
      ├─ SharingEndpoints.cs
      └─ AddMember.cs
```

The insight: **things that change together should live together.** When product asks for "add a
description to projects", you touch `Project.cs`, the create/rename slices and a migration. You
don't touch a controller, a service interface, a service, a repository interface, a repository, two
mappers and three DTOs in four projects.

Each slice can also choose its own data access. `ListProjects` can be a single projection with
`AsNoTracking()`, while `RenameProject` loads the tracked entity and calls a domain method. A
layered architecture tends to force one generic path on every use case.

:::pro title="Vertical slices + a rich domain, not either/or"
Real teams mix the ideas: **feature folders** (vertical slices) for the application code, plus a
**domain model with no infrastructure dependencies** for the rules (`project.Rename(...)` bumps the
version, `project.AddMember(...)` enforces "only one owner"). You keep the dependency rule where it
pays off, in business logic you want to unit-test, and drop the layers that only forward calls.
Split into more projects only when you need separate deployment or strict compile-time boundaries.
:::

:::quiz id=be-12-q4 xp=15
In clean architecture, `Application` defines `IEmailSender` and `Infrastructure` contains
`SmtpEmailSender : IEmailSender`. Which project references which?

- [ ] Application references Infrastructure, so it can call `SmtpEmailSender`
- [x] Infrastructure references Application, and the Api project wires them together in DI
- [ ] Domain references Infrastructure
- [ ] Neither references the other; they communicate through MediatR
> Dependencies point inward. The inner layer owns the abstraction, and the outer layer implements it (dependency inversion). If Application referenced Infrastructure, the arrow would point outward and Application could no longer be tested or reused without SMTP and EF Core. The composition root, `Program.cs` in the Api project, is the only place that knows both and registers `services.AddScoped<IEmailSender, SmtpEmailSender>()`. MediatR has nothing to do with project references.
:::

## The repository debate

"Should I put a repository over EF Core?" comes up in every .NET team and in many interviews.
Know both sides.

`DbContext` **already is** a Unit of Work (`SaveChanges` commits everything as one transaction),
and each `DbSet<T>` **already is** a repository (add, remove, query). A *generic* repository on top
usually makes things worse:

```csharp
// ❌ The classic generic repository
public interface IRepository<T>
{
    Task<IEnumerable<T>> GetAllAsync();                          // loads the whole table
    Task<IEnumerable<T>> FindAsync(Func<T, bool> predicate);     // Func, not Expression → filters in memory!
    Task<T?> GetByIdAsync(Guid id);
    Task AddAsync(T entity);
    Task SaveAsync();
}
```

It hides `Include`, projections, `AsNoTracking`, `ExecuteUpdate`, split queries and cancellation,
which is everything you learned in be-11. Every new need either leaks EF through the abstraction
(`IQueryable<T> Query()`) or adds yet another method.

An **aggregate** (a term from Domain-Driven Design) is a cluster of objects you always load and save as
one unit because they share rules: a `Project` with its `Members`, where "exactly one owner" must hold
across the whole set. A **specific, aggregate-shaped** repository can be worth it:

```csharp
// ✅ Speaks the domain's language, hides complex loading rules, one per aggregate
public interface IProjectRepository
{
    Task<Project?> GetWithMembersAsync(Guid id, CancellationToken ct);
    void Add(Project project);
}
```

Use one when the loading rules of an aggregate are non-trivial and reused, or when the domain layer
mustn't reference EF Core (strict clean architecture). Skip it when the "repository" would just
forward to `DbSet`. For tests, use a real PostgreSQL (Testcontainers, be-15) instead of mocking a
repository. A mocked repository proves almost nothing about your queries.

:::quiz id=be-12-q5 xp=15
Spot the bug in this generic repository method.

```csharp
public async Task<List<T>> FindAsync(Func<T, bool> predicate) =>
    (await _db.Set<T>().ToListAsync()).Where(predicate).ToList();

// usage
var mine = await repo.FindAsync(p => p.OwnerId == userId);
```

- [ ] `Func` can't be used with `Where`
- [x] It loads **the entire table** into memory, then filters in C#; with `Expression<Func<T, bool>>` on the `IQueryable` the filter would become SQL
- [ ] It's correct, but it should be `IEnumerable<T>`
- [ ] The query is translated to SQL but isn't parameterized
> EF can only translate *expression trees*. A `Func<T, bool>` is compiled code that EF can't look into — and here it isn't even given the chance: `ToListAsync()` runs first with no `WHERE` at all, so there's no SQL filter to parameterize. `Where(Func)` compiles fine; it just runs in memory. This exact pattern has taken down production databases once a table grew past a few hundred thousand rows.
:::

## MediatR and the mediator pattern

MediatR dispatches a request object to exactly one handler: `await mediator.Send(new CreateProject.Command("Apollo"))`.
Its **pipeline behaviors** wrap every handler, much like middleware:

```csharp
public class ValidationBehavior<TReq, TRes>(IEnumerable<IValidator<TReq>> validators)
    : IPipelineBehavior<TReq, TRes> where TReq : notnull
{
    public async Task<TRes> Handle(TReq request, RequestHandlerDelegate<TRes> next, CancellationToken ct)
    {
        foreach (var v in validators) await v.ValidateAndThrowAsync(request, ct);
        return await next();
    }
}
```

**Pros:** a uniform handler shape, cross-cutting behaviors (validation, logging, transactions)
applied once, endpoints that stay one line long, and handlers that work the same from HTTP, a
background job or a message consumer.

**Cons:** indirection, since "Go to definition" on `Send` lands in MediatR and not in your handler.
Reflection-based dispatch. A dependency for something ASP.NET Core mostly already gives you: endpoint
filters and route groups *are* a pipeline. Also note the **licensing**: since July 2025, new
MediatR (13+) and AutoMapper (15+) versions use a commercial license, with a free community tier for
small companies. Check the terms before adding them to a company codebase. Older versions keep their
open-source licenses (MediatR Apache-2.0, AutoMapper MIT), but receive no further updates.

Alternatives: plain handler classes registered in DI (`builder.Services.AddScoped<CreateProjectHandler>()`
and inject it into the endpoint), the source-generated `Mediator` library, or Wolverine if you also
need messaging.

:::quiz id=be-12-q6 xp=15
Your team uses minimal APIs and wants "validate every request, log every request, wrap writes in a
transaction". Which statement is accurate?

- [ ] You need MediatR, because minimal APIs have no pipeline
- [x] Endpoint filters on a route group (plus middleware) can do all three; MediatR is one option, not a requirement
- [ ] Only controllers support cross-cutting concerns
- [ ] Each handler must implement these concerns itself
> `group.AddEndpointFilter<ValidationFilter>()` runs around every endpoint in the group with access to the bound arguments, and middleware covers request logging. MediatR behaviors are useful when the same handlers also run outside HTTP (jobs, message consumers).
:::

## Keep it simple: a decision guide

Start here, and add structure only when the pain shows up:

1. **One API project** with `Domain/`, `Infrastructure/`, `Features/<Feature>/`. Add a separate
   test project.
2. **One file per use case** with a static `Handle` method returning `TypedResults`.
3. **`DbContext` directly in handlers.** Add an aggregate repository only for complex, reused
   loading logic.
4. **Business rules on entities** (`project.Rename`), not in endpoints.
5. **Cross-cutting concerns in route groups/filters/middleware.**
6. Split into more projects when there's a **real boundary**: a shared domain used by an API *and*
   a worker service, or compile-time enforcement for a large team.

:::job title="What you'll find at a new job"
You'll meet every style: 2015-era layered MVC with `IGenericRepository<T>`, clean architecture
templates with MediatR + AutoMapper, and newer vertical-slice minimal APIs. Don't rewrite the
codebase in week one. **Follow the existing pattern consistently**, learn why it was chosen, and
propose changes with evidence, e.g. "this feature touched 11 files; here's how a slice would
look". In interviews, show that you know the trade-offs instead of naming one "correct" architecture.
:::

## Lab: a vertical-slice Projects API

:::lab id=be-12-lab1 xp=120
title: Feature-organized minimal API with testable handlers
Build a small Projects API organized as vertical slices, with a route group per feature and
handlers you can test without HTTP. Then prove the HTTP wiring with three
`WebApplicationFactory` tests.

:::info title="Why an in-memory store, after two lessons of EF Core?"
On purpose, and only for this lab and the next one. The subject here is **structure**: slices, groups,
handlers you can call directly. A database would add Docker, migrations and connection strings without
teaching anything about architecture. `IProjectStore` is the seam where `AppDbContext` from be-10/be-11
plugs in. In a real app the handlers would take `AppDbContext` directly (see "The repository debate"
above), and that's exactly what the Projects API does again from be-15 on, against real PostgreSQL. Don't
copy the in-memory store into production code. Lesson be-15 explains why fake stores also make
weak *integration* tests.
:::

**1. Create the solution**

```bash
mkdir -p ~/devquest/be-12-lab1 && cd ~/devquest/be-12-lab1
dotnet new sln -n Projects
dotnet new web -o Projects.Api
dotnet new xunit -o Projects.Api.Tests
dotnet sln add Projects.Api Projects.Api.Tests
dotnet add Projects.Api.Tests reference Projects.Api
dotnet add Projects.Api.Tests package Microsoft.AspNetCore.Mvc.Testing --version 10.0.14
rm Projects.Api.Tests/UnitTest1.cs
mkdir -p Projects.Api/Domain Projects.Api/Infrastructure Projects.Api/Features/Projects
```

The .NET 10 SDK creates `Projects.slnx`, the new XML solution format.

**2. `Projects.Api/Program.cs`**: composition only

```csharp
using Projects.Api.Features.Projects;
using Projects.Api.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IProjectStore, InMemoryProjectStore>();

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();

app.MapProjectEndpoints();

app.Run();
```

**3. `Projects.Api/Domain/Project.cs`**: the rule "renaming bumps the version" lives here

```csharp
namespace Projects.Api.Domain;

public class Project
{
    public Guid Id { get; init; }
    public required string Name { get; set; }
    public required string OwnerId { get; init; }
    public int Version { get; set; } = 1;
    public DateTimeOffset CreatedAt { get; init; }

    // Business rules live on the entity, not in the endpoint.
    public void Rename(string newName)
    {
        Name = newName.Trim();
        Version++;
    }
}
```

**4. `Projects.Api/Infrastructure/InMemoryProjectStore.cs`**

```csharp
using System.Collections.Concurrent;
using Projects.Api.Domain;

namespace Projects.Api.Infrastructure;

// In a real app this is AppDbContext. The interface is a seam so the lab needs no database.
public interface IProjectStore
{
    Task<Project?> FindAsync(Guid id, CancellationToken ct);
    Task<IReadOnlyList<Project>> ListAsync(CancellationToken ct);
    Task AddAsync(Project project, CancellationToken ct);
}

public class InMemoryProjectStore : IProjectStore
{
    private readonly ConcurrentDictionary<Guid, Project> _projects = new();

    public Task<Project?> FindAsync(Guid id, CancellationToken ct) =>
        Task.FromResult(_projects.GetValueOrDefault(id));

    public Task<IReadOnlyList<Project>> ListAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<Project>>(_projects.Values.OrderBy(p => p.Name).ToList());

    public Task AddAsync(Project project, CancellationToken ct)
    {
        _projects[project.Id] = project;
        return Task.CompletedTask;
    }
}
```

**5. The slices**, all in `Projects.Api/Features/Projects/`

`ProjectDto.cs`

```csharp
using Projects.Api.Domain;

namespace Projects.Api.Features.Projects;

public record ProjectDto(Guid Id, string Name, int Version, DateTimeOffset CreatedAt)
{
    public static ProjectDto From(Project p) => new(p.Id, p.Name, p.Version, p.CreatedAt);
}
```

`CreateProject.cs`

```csharp
using Microsoft.AspNetCore.Http.HttpResults;
using Projects.Api.Domain;
using Projects.Api.Infrastructure;

namespace Projects.Api.Features.Projects;

// One slice = request + validation + handler, all in one file.
public static class CreateProject
{
    public record Request(string Name);

    public static async Task<Results<CreatedAtRoute<ProjectDto>, ValidationProblem>> Handle(
        Request request, IProjectStore store, TimeProvider clock, CancellationToken ct)
    {
        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > 200)
            return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            {
                ["name"] = ["Name is required and must be at most 200 characters."]
            });

        var project = new Project
        {
            Id = Guid.CreateVersion7(),
            Name = name,
            OwnerId = "demo-user", // comes from the authenticated user in be-13
            CreatedAt = clock.GetUtcNow(),
        };
        await store.AddAsync(project, ct);

        return TypedResults.CreatedAtRoute(ProjectDto.From(project), GetProject.RouteName, new { id = project.Id });
    }
}
```

`GetProject.cs`

```csharp
using Microsoft.AspNetCore.Http.HttpResults;
using Projects.Api.Infrastructure;

namespace Projects.Api.Features.Projects;

public static class GetProject
{
    public const string RouteName = "GetProject";

    public static async Task<Results<Ok<ProjectDto>, NotFound>> Handle(
        Guid id, IProjectStore store, CancellationToken ct) =>
        await store.FindAsync(id, ct) is { } project
            ? TypedResults.Ok(ProjectDto.From(project))
            : TypedResults.NotFound();
}
```

`ListProjects.cs`

```csharp
using Microsoft.AspNetCore.Http.HttpResults;
using Projects.Api.Infrastructure;

namespace Projects.Api.Features.Projects;

public static class ListProjects
{
    public static async Task<Ok<List<ProjectDto>>> Handle(IProjectStore store, CancellationToken ct)
    {
        var projects = await store.ListAsync(ct);
        return TypedResults.Ok(projects.Select(ProjectDto.From).ToList());
    }
}
```

`RenameProject.cs`

```csharp
using Microsoft.AspNetCore.Http.HttpResults;
using Projects.Api.Infrastructure;

namespace Projects.Api.Features.Projects;

public static class RenameProject
{
    public record Request(string Name);

    public static async Task<Results<Ok<ProjectDto>, NotFound, ValidationProblem>> Handle(
        Guid id, Request request, IProjectStore store, CancellationToken ct)
    {
        var name = request.Name?.Trim() ?? "";
        if (name.Length is 0 or > 200)                  // same rule as CreateProject
            return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            {
                ["name"] = ["Name is required and must be at most 200 characters."]
            });

        var project = await store.FindAsync(id, ct);
        if (project is null) return TypedResults.NotFound();

        project.Rename(name);
        return TypedResults.Ok(ProjectDto.From(project));
    }
}
```

`ProjectEndpoints.cs`: the route group

```csharp
namespace Projects.Api.Features.Projects;

// The ONLY place that knows the URLs of this feature. Program.cs just calls MapProjectEndpoints().
public static class ProjectEndpoints
{
    public static IEndpointRouteBuilder MapProjectEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/projects")
            .WithTags("Projects");
        // later: .RequireAuthorization() applies to every endpoint in the group

        group.MapGet("/", ListProjects.Handle);
        group.MapGet("/{id:guid}", GetProject.Handle).WithName(GetProject.RouteName);
        group.MapPost("/", CreateProject.Handle);
        group.MapPut("/{id:guid}", RenameProject.Handle);

        return app;
    }
}
```

**6. Try it**

```bash
dotnet run --project Projects.Api --urls http://localhost:5199
# in a second terminal:
curl -i -X POST localhost:5199/api/projects -H 'content-type: application/json' -d '{"name":"Apollo"}'
curl -s -X POST localhost:5199/api/projects -H 'content-type: application/json' -d '{"name":""}'
```

Expected (ids and times will differ):

```text
HTTP/1.1 201 Created
Content-Type: application/json; charset=utf-8
Location: http://localhost:5199/api/projects/01a1ac3c-a700-7a07-85eb-8c709762c271

{"id":"01a1ac3c-a700-7a07-85eb-8c709762c271","name":"Apollo","version":1,"createdAt":"2026-11-05T15:03:38.496515+00:00"}

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.1","title":"One or more validation errors occurred.","status":400,"errors":{"name":["Name is required and must be at most 200 characters."]},"traceId":"00-…"}
```

`Guid.CreateVersion7()` produces time-ordered UUIDs. They're friendlier to B-tree indexes than
random v4 GUIDs.

**7. Handler unit tests**: `Projects.Api.Tests/HandlerTests.cs`

```csharp
using Microsoft.AspNetCore.Http.HttpResults;
using Projects.Api.Features.Projects;
using Projects.Api.Infrastructure;

namespace Projects.Api.Tests;

// Handlers are plain static methods returning TypedResults, so we can test them
// without HTTP, without a server and without mocks.
public class HandlerTests
{
    private readonly InMemoryProjectStore _store = new();

    [Fact]
    public async Task Create_returns_201_with_the_new_project()
    {
        var result = await CreateProject.Handle(new("  Apollo  "), _store, TimeProvider.System, default);

        var created = Assert.IsType<CreatedAtRoute<ProjectDto>>(result.Result);
        Assert.Equal("Apollo", created.Value!.Name);
        Assert.Equal(1, created.Value.Version);
        Assert.Equal(GetProject.RouteName, created.RouteName);
        Assert.NotNull(await _store.FindAsync(created.Value.Id, default));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task Create_rejects_blank_names(string name)
    {
        var result = await CreateProject.Handle(new(name), _store, TimeProvider.System, default);

        var problem = Assert.IsType<ValidationProblem>(result.Result);
        Assert.Contains("name", problem.ProblemDetails.Errors.Keys);
        Assert.Empty(await _store.ListAsync(default));
    }

    [Fact]
    public async Task Create_rejects_names_longer_than_200()
    {
        var result = await CreateProject.Handle(new(new string('a', 201)), _store, TimeProvider.System, default);
        Assert.IsType<ValidationProblem>(result.Result);
    }

    [Fact]
    public async Task Get_unknown_id_is_404()
    {
        var result = await GetProject.Handle(Guid.NewGuid(), _store, default);
        Assert.IsType<NotFound>(result.Result);
    }

    [Fact]
    public async Task Rename_changes_name_and_bumps_version()
    {
        var created = await CreateProject.Handle(new("Old"), _store, TimeProvider.System, default);
        var id = ((CreatedAtRoute<ProjectDto>)created.Result).Value!.Id;

        var result = await RenameProject.Handle(id, new("New"), _store, default);

        var ok = Assert.IsType<Ok<ProjectDto>>(result.Result);
        Assert.Equal("New", ok.Value!.Name);
        Assert.Equal(2, ok.Value.Version);
    }
}
```

**8. HTTP wiring tests**: `Projects.Api.Tests/ApiTests.cs`

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Testing;
using Projects.Api.Features.Projects;

namespace Projects.Api.Tests;

// A thin layer of HTTP tests proves the wiring: routes, binding, status codes, JSON.
// (Lesson be-15 goes deep on WebApplicationFactory.)
public class ApiTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Post_then_get_roundtrips_through_the_route_group()
    {
        var post = await _client.PostAsJsonAsync("/api/projects", new { name = "Gemini" });

        Assert.Equal(HttpStatusCode.Created, post.StatusCode);
        var created = await post.Content.ReadFromJsonAsync<ProjectDto>();
        Assert.Equal($"/api/projects/{created!.Id}", post.Headers.Location!.AbsolutePath);

        var get = await _client.GetFromJsonAsync<ProjectDto>(post.Headers.Location);
        Assert.Equal("Gemini", get!.Name);
    }

    [Fact]
    public async Task Invalid_create_returns_problem_details()
    {
        var response = await _client.PostAsJsonAsync("/api/projects", new { name = "" });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
        var problem = await response.Content.ReadFromJsonAsync<ValidationProblemDetails>();
        Assert.Contains("name", problem!.Errors.Keys);
    }

    [Fact]
    public async Task Non_guid_id_does_not_match_the_route()
    {
        var response = await _client.GetAsync("/api/projects/not-a-guid");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}
```

Notice there's no `public partial class Program { }`. Since .NET 10, the Web SDK generates it for
you, so `WebApplicationFactory<Program>` works with top-level statements out of the box.

**9. Run all tests**

```bash
dotnet test
```

```text
Passed!  - Failed: 0, Passed: 9, Skipped: 0, Total: 9
```

**10. Your turn: add a slice.** Add `DeleteProject.cs` (`DELETE /api/projects/{id}` → `204 NoContent`
or `404 NotFound`). You'll need a `RemoveAsync` on the store. Map it in `ProjectEndpoints` and write
one handler test for each outcome. Count the files you touched. It should be three, plus the test file.

- [ ] `dotnet run` works and the curl calls return 201 and a 400 problem+json
- [ ] `Program.cs` contains no endpoint definitions, only `MapProjectEndpoints()`
- [ ] The 6 handler tests pass without starting a server
- [ ] The 3 `WebApplicationFactory` tests pass (`dotnet test` reports 9 passed)
- [ ] I added a `DeleteProject` slice with two passing tests
:::

:::quiz id=be-12-q7 xp=10
In the lab, why can `HandlerTests` assert on `CreatedAtRoute<ProjectDto>` without any HTTP?

- [ ] xUnit starts a hidden test server for every test
- [x] The handler is a plain static method; `TypedResults` returns concrete result objects you can inspect before ASP.NET Core ever writes them to a response
- [ ] `WebApplicationFactory` is injected automatically
- [ ] Because `IProjectStore` is mocked
> An `IResult` is just an object until the framework calls `ExecuteAsync(HttpContext)` on it. Typed results expose `Value`, `StatusCode`, `RouteName` etc., so the business outcome is testable with a direct call. The HTTP tests then only need to cover wiring.
:::

## Flashcards

:::cards id=be-12-cards1 xp=15 title="API architecture"
Q: Controllers vs minimal APIs: performance difference?
A: Negligible for real apps. Choose on style and features. Minimal APIs get new features first and support Native AOT.
Q: How do you keep `Program.cs` small with minimal APIs?
A: One static class per feature with a `Map<Feature>Endpoints(this IEndpointRouteBuilder)` extension, using `MapGroup` for prefixes and shared conventions.
Q: What does a route group convention like `RequireAuthorization()` apply to?
A: Every endpoint in the group, including nested groups.
Q: Why `TypedResults` over `Results`?
A: Concrete return types give accurate OpenAPI metadata, and the result can be inspected in unit tests.
Q: The dependency rule of clean/onion architecture?
A: Dependencies point inward. Domain depends on nothing, inner layers define interfaces, outer layers implement them.
Q: Vertical slice architecture in one sentence?
A: Organize code by feature/use case, so things that change together live together.
Q: Why is a generic `IRepository<T>` over EF Core often harmful?
A: It hides projections, Include, tracking control and bulk operations, and `Func` predicates filter in memory. `DbContext` is already a unit of work + repositories.
Q: When is a repository worth it?
A: As an aggregate-specific repository with complex, reused loading rules, or when the domain must not reference EF Core.
Q: MediatR: main pro and main con?
A: Pro: uniform handlers plus pipeline behaviors for cross-cutting concerns. Con: indirection and an extra (now commercially licensed) dependency for what filters/groups already give you.
Q: Endpoint filter vs middleware?
A: Middleware sees the raw `HttpContext` for every request. An endpoint filter runs for specific endpoints/groups after model binding and can read the typed arguments (`context.Arguments`) and short-circuit.
Q: What is the composition root?
A: The single place (`Program.cs` in the Api project) that knows all concrete types and wires interfaces to implementations in DI.
Q: `Guid.CreateVersion7()`, why?
A: Time-ordered UUIDs (RFC 9562) mean much less index fragmentation than random v4 for primary keys.
:::

## Recap

- Controllers and minimal APIs share the same platform. Pick by style. Minimal APIs are the modern default.
- Organize minimal APIs as **feature modules**: `Map…Endpoints` extension methods plus **route groups** for prefixes and policies.
- Handlers as **static methods returning `TypedResults`** give precise OpenAPI docs and trivially unit-testable code.
- **Clean architecture** contributes the dependency rule. **Vertical slices** contribute cohesion by feature. Combine them pragmatically.
- `DbContext` is already a unit of work. Avoid generic repositories; use aggregate repositories only when they earn their keep.
- MediatR is optional: weigh the indirection and licensing against endpoint filters and plain handlers.
- Architecture is measured by **the cost of the next change**. Start simple and add structure when real pain appears.
