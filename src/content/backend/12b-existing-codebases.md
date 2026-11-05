---
id: be-22
title: Joining an Existing .NET Codebase
level: advanced
minutes: 100
xp: 150
summary: Read, test and safely upgrade the ASP.NET Core app you inherit — controllers and filters, Startup.cs, AutoMapper, MediatR, repositories, Newtonsoft — with characterization tests before every change.
---

Most of this track builds new things the modern way: minimal APIs, `TypedResults`, `System.Text.Json`,
`Program.cs` with top-level statements. Your first job will probably look different. On day one you'll
clone a repository that is five to ten years old. It has a `Startup.cs`, thirty controllers, a
`Filters/` folder, AutoMapper profiles, MediatR handlers, a generic repository with a unit of work,
`AddNewtonsoftJson()`, and it targets .NET 8. .NET 8 goes out of support on **November 10, 2026**.

None of that is wrong. It's what successful software looks like after years of features, and the team
that wrote it made reasonable choices with what they had. Your job is not to rewrite it. Your job is to
**understand it, change it without breaking it, and move it forward in small, safe steps**.

This lesson gives you three things:

1. A **reading method** for a solution you didn't write: entry points, DI, middleware, configuration.
2. The **mental models** for the older building blocks you'll meet: `[ApiController]`, MVC filters,
   `Startup`, AutoMapper, MediatR, repositories over EF Core, Newtonsoft.Json. You'll learn what they do,
   where they bite, and when to keep or remove them.
3. A **safe-change workflow**: characterization tests first, then upgrade to .NET 10, then refactor,
   with every step proven by the same tests.

It builds on *API Architecture That Stays Simple* (the design arguments about controllers, repositories
and MediatR) and on the minimal-API lessons *Your First Minimal API* and *Route Groups, DTOs, Validation
& ProblemDetails*. Here we look at the same ideas from the other side: you didn't choose them, you
inherited them.

## Reading a solution you didn't write

Don't start by reading code file by file. A web app has a small number of **places where decisions are
made**. Read those first, in this order, and you'll understand 80 % of the app's behaviour before you
open a single controller.

| # | Where | What it tells you |
|---|---|---|
| 1 | `*.sln` / `*.slnx` | Which projects exist. Which one is the executable (`Sdk="Microsoft.NET.Sdk.Web"`)? Which are libraries, which are tests? |
| 2 | `global.json`, `Directory.Build.props`, `Directory.Packages.props` | The pinned SDK, settings shared by every project (TFM, `Nullable`, `TreatWarningsAsErrors`), and central package versions |
| 3 | The web project's `.csproj` | Target framework, NuGet packages. AutoMapper, MediatR, Newtonsoft, Serilog, Polly, Swashbuckle each tell you something about how the app works |
| 4 | `Program.cs` (+ `Startup.cs`) | How the host is built: config sources, logging, DI registrations, and the **middleware order** |
| 5 | DI extension methods | `services.AddInfrastructure(Configuration)`, `services.AddApplication()`. Press F12 on each one; that's where the real wiring lives |
| 6 | `appsettings*.json`, `launchSettings.json` | Configuration keys and their per-environment values |
| 7 | `Dockerfile`, CI pipeline, Helm/K8s manifests | What *actually* runs in production: base image, env vars, secrets, health checks |
| 8 | The test projects | What the team considered important enough to protect, and how they test (mocks? real database?) |

Then pick **one request** and trace it end to end: middleware, then routing, then filters, then the
controller action, then `mediator.Send`, then the handler, then the repository, then the SQL. One
complete trace teaches you the architecture better than reading twenty files.

A few commands make the first hour faster:

```bash
dotnet --info                                  # which SDKs/runtimes you have
dotnet sln list                                # projects in the solution
dotnet build                                   # does it even build? (record warnings, don't fix them yet)
dotnet test                                    # what's the baseline? green, red, flaky?
dotnet list package --include-transitive       # everything that ends up in the app
dotnet list package --vulnerable --include-transitive   # .NET 10 SDK also accepts `dotnet package list …`
git log --since="6 months ago" --name-only --format="" | sort | uniq -c | sort -rn | head -20   # hot files
```

The last command lists the files that changed most often recently. That's where the bugs and the
business value are, and where you'll be working.

:::tip title="List every route the app exposes"
Controllers spread routes across attributes in dozens of files. A temporary development-only endpoint
prints them all from the routing table:

```csharp
// Program.cs (or the end of Startup.Configure's UseEndpoints) — Development only, never commit
app.MapGet("/_routes", (EndpointDataSource endpoints) =>
    endpoints.Endpoints.OfType<RouteEndpoint>()
        .Select(e => $"{e.RoutePattern.RawText} -> {e.DisplayName}"));
```

```text
["api/orders -> Legacy.Api.Controllers.OrdersController.List (Legacy.Api)", "api/orders/{id:int} -> …Get (Legacy.Api)", …]
```

The OpenAPI/Swagger page (if the app has one) gives you the same list with schemas.
:::

### Configuration layering: which value wins?

Both hosting models (`Host.CreateDefaultBuilder` and `WebApplication.CreateBuilder`) load configuration
from the same sources, in this order. **A later source overrides an earlier one, key by key:**

```text
1. appsettings.json
2. appsettings.{Environment}.json      ← Environment = ASPNETCORE_ENVIRONMENT / DOTNET_ENVIRONMENT, default "Production"
3. User secrets                         ← only when Environment = Development
4. Environment variables                ← ConnectionStrings__Default  (double underscore = ":")
5. Command-line arguments               ← --ConnectionStrings:Default=...
```

`launchSettings.json` is **not** a configuration source. It's read by `dotnet run` and Visual Studio to
set environment variables on your machine, and is ignored in Docker, Kubernetes and every deployed
environment. When "it works locally but not in staging", compare what each layer contributes. The
lesson *Dependency Injection & Configuration* covers the options pattern that reads these values.

:::quiz id=be-22-q1 xp=10
`appsettings.json` sets `ConnectionStrings:Default` to **A**, `appsettings.Production.json` sets it to
**B**, the Kubernetes deployment sets the env var `ConnectionStrings__Default` to **C**, and
`Properties/launchSettings.json` sets it to **D** in its `environmentVariables`. Which connection string
does the production pod use?

- [ ] **B**, because the environment-specific file always wins
- [x] **C**: environment variables are loaded after the JSON files, so they override them
- [ ] **D**, because `launchSettings.json` is loaded last
- [ ] **A**, because the others only apply in Development
> Later sources override earlier ones: JSON, then environment JSON, then (Development-only) user secrets, then environment variables, then command line. So the env var **C** beats **B**. `launchSettings.json` is tempting but never involved: it's only a launch profile for `dotnet run` / Visual Studio on a developer machine and isn't even copied into the publish output.
:::

## `Startup.cs` vs minimal hosting: reading both

Apps created before .NET 6 use the **generic host + `Startup` class** model. Many were upgraded to
.NET 6 and 8 without changing it, because it still works on .NET 10. You need to read it fluently and
map it onto the modern model in your head.

```csharp
// The Startup model (ASP.NET Core 3.x – 5 templates, still common)
public class Program
{
    public static void Main(string[] args) => CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)                        // config, logging, Kestrel defaults
            .ConfigureWebHostDefaults(web => web.UseStartup<Startup>());
}

public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;
    public IConfiguration Configuration { get; }

    public void ConfigureServices(IServiceCollection services)    // ← DI registrations
    {
        services.AddControllers();
        services.AddDbContext<AppDbContext>(o => o.UseNpgsql(Configuration.GetConnectionString("Default")));
    }

    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)   // ← middleware pipeline
    {
        if (env.IsDevelopment()) app.UseDeveloperExceptionPage();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

```csharp
// The same app with minimal hosting (.NET 6+ templates)
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();                                       // was ConfigureServices
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseNpgsql(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();                                               // ---- the line between the two halves

if (app.Environment.IsDevelopment()) app.UseDeveloperExceptionPage();    // was Configure
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();                                                    // routing + endpoints are implicit

app.Run();
```

| Startup model | Minimal hosting |
|---|---|
| `Host.CreateDefaultBuilder(args)` | `WebApplication.CreateBuilder(args)` (same default config sources and logging) |
| `Startup(IConfiguration configuration)` | `builder.Configuration` |
| `ConfigureServices(IServiceCollection services)` | `builder.Services.…` before `Build()` |
| `Configure(IApplicationBuilder app, IWebHostEnvironment env)` | `app.Use…` after `Build()`, `app.Environment` |
| explicit `UseRouting()` + `UseEndpoints(e => e.Map…)` | `app.Map…` directly; `WebApplication` adds routing for you |
| `ConfigureContainer(ContainerBuilder b)` (Autofac) | `builder.Host.UseServiceProviderFactory(...)` + `builder.Host.ConfigureContainer<…>(…)` |
| `.ConfigureAppConfiguration(...)`, `.UseSerilog()` on the host builder | `builder.Configuration.Add…`, `builder.Host.UseSerilog()` / `builder.Services.AddSerilog()` |

Two things in old `Startup` code surprise people:

- **Environment-named conventions.** If a `Startup` has `ConfigureDevelopmentServices` or
  `ConfigureStaging`, ASP.NET Core calls *those* instead of `ConfigureServices`/`Configure` in that
  environment. Search for `Configure*Services` before you assume what runs in production.
- **Hidden middleware via `IStartupFilter`.** A library can register an `IStartupFilter` in DI that adds
  middleware *before* your `Configure` runs. If a request is modified "by nobody", search for
  `IStartupFilter` registrations.

You don't have to migrate `Startup` to minimal hosting to upgrade .NET. If you want to, the smallest
safe step keeps the `Startup` class and only replaces the host (the lab's optional step does exactly this):

```csharp
var builder = WebApplication.CreateBuilder(args);
var startup = new Startup(builder.Configuration);
startup.ConfigureServices(builder.Services);

var app = builder.Build();
startup.Configure(app, app.Environment);
app.Run();
```

Later PRs then move registrations and middleware out of `Startup` piece by piece.

:::warn title="The shim calls exactly two methods, nothing else"
`UseStartup<Startup>()` does more than call `ConfigureServices` and `Configure`. It picks
environment-specific methods (`ConfigureDevelopmentServices`, `ConfigureStaging`), injects any extra
`Configure` parameters from DI (`Configure(IApplicationBuilder app, ILogger<Startup> log, IOptions<X> o)`),
and calls `ConfigureContainer` for Autofac. The hand-written shim above does none of that. Before you use
it, check that `Startup` has only the two plain methods. If it has more, call them yourself
(`if (builder.Environment.IsStaging()) …`, `app.Services.GetRequiredService<ILogger<Startup>>()`).
:::

:::quiz id=be-22-q2 xp=15
A legacy `Startup.Configure` looks like this. Controllers marked `[Authorize]` start failing. What
happens on a request to one of them?

```csharp
public void Configure(IApplicationBuilder app)
{
    app.UseAuthentication();
    app.UseAuthorization();
    app.UseRouting();
    app.UseEndpoints(e => e.MapControllers());
}
```

- [ ] Nothing visible: authentication and authorization are in the right relative order, so everything works
- [ ] Authorization is silently skipped, so anonymous users reach `[Authorize]` actions
- [x] The request fails with a 500: the endpoint middleware throws because the endpoint has authorization metadata but `UseAuthorization` didn't run *after* routing selected it
- [ ] `UseRouting` throws at startup because it must be the first middleware
> Authorization needs to know **which endpoint** was selected (its `[Authorize]` metadata), and that's only known after `UseRouting`. Placed before routing, the authorization middleware sees no endpoint and does nothing. ASP.NET Core detects this at request time and throws `InvalidOperationException: Endpoint … contains authorization metadata, but a middleware was not found that supports authorization`, so it fails closed instead of opening a security hole, which is why "silently skipped" is wrong. The build even warns about it beforehand (analyzer `ASP0001`: "The call to UseAuthorization should appear between app.UseRouting() and app.UseEndpoints(..)"), which is one more reason to read the build warnings of an inherited app. The fix: `UseRouting` → `UseAuthentication` → `UseAuthorization` → `UseEndpoints`. *Middleware, Logging & Global Error Handling* explains why order is everything in the pipeline.
:::

## Controllers and `[ApiController]`

Controllers are classes deriving from `ControllerBase`, with one public method (an **action**) per
endpoint. *API Architecture That Stays Simple* compares them with minimal APIs. In an existing
codebase, the important thing is to know what the `[ApiController]` attribute changes, because it
silently does a lot:

1. **Attribute routing is required.** Actions are only reachable through `[Route]`/`[HttpGet("…")]`.
2. **Automatic 400 responses.** Model binding and validation (`[Required]`, `[Range]`, …) run *before*
   the action. If `ModelState` is invalid, a built-in filter returns a `ValidationProblemDetails` 400
   and **your action never runs**.
3. **Binding source inference.** Parameters get a binding source without attributes (table below).
4. **ProblemDetails for error status codes.** `return NotFound();` produces an
   `application/problem+json` body, not an empty 404.

```csharp
[ApiController]
[Route("api/orders")]
public class OrdersController(IOrderRepository orders) : ControllerBase
{
    [HttpGet("{id:int}")]
    public ActionResult<OrderDto> Get(int id)               // id ← route
    {
        var order = orders.Find(id);
        if (order is null) return NotFound();               // ActionResult → 404 problem+json
        return OrderDto.From(order);                        // T → 200 with JSON body (implicit conversion)
    }

    [HttpPost]
    public ActionResult<OrderDto> Create(CreateOrderRequest request)   // request ← body (inferred [FromBody])
        => CreatedAtAction(nameof(Get), new { id = 42 }, /* … */ null);
}
```

### Where does each parameter come from?

| Parameter | Inferred source with `[ApiController]` | Explicit attribute |
|---|---|---|
| Name matches a route template token (`{id}`) | route | `[FromRoute]` |
| Simple type (`int`, `string`, `Guid`, enum, `DateTime`, …) | query string | `[FromQuery]` |
| Complex type (a class/record) **not** registered in DI | **request body (JSON)** | `[FromBody]` |
| Type registered in DI (.NET 7+) | DI container | `[FromServices]` |
| `IFormFile`, `IFormFileCollection` | form | `[FromForm]` |
| Request header | (never inferred) | `[FromHeader(Name = "X-Tenant")]` |
| `CancellationToken` | the request-aborted token | — |

Only **one** parameter can come from the body. A complex type for a `GET` filter must be marked
`[FromQuery]`, or the inference will try to read JSON from a request that has none.

### `ActionResult<T>` vs `IActionResult`

`IActionResult` can be anything, so tools can't know the response type, and older code annotates every
action with `[ProducesResponseType(typeof(OrderDto), 200)]`. `ActionResult<T>` lets an action return
**either** a `T` (wrapped in a 200) **or** any `ActionResult` (`NotFound()`, `Conflict()`, …), and
OpenAPI learns `T` from the signature. It is the controller-world counterpart of
`Results<Ok<T>, NotFound>` in minimal APIs.

:::quiz id=be-22-q3 xp=15
Spot the bug. `GET /api/orders/search?customer=ada&page=2` fails. What does the client get?

```csharp
public class OrderSearch
{
    public string? Customer { get; set; }
    public int Page { get; set; } = 1;
}

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    [HttpGet("search")]
    public ActionResult<List<OrderDto>> Search(OrderSearch filter) => /* … */ [];
}
```

- [ ] 200 with the filtered list, since complex types bind from the query string
- [ ] 200, but `filter.Customer` is `null` because query keys are case-sensitive
- [x] 415 Unsupported Media Type, because `[ApiController]` infers `[FromBody]` for the complex `OrderSearch`, and a GET has no JSON body; fix it with `[FromQuery] OrderSearch filter`
- [ ] 404, because `search` is matched as an `{id}`
> Binding-source inference treats every complex type that isn't a DI service as the JSON body. The request has no `Content-Type: application/json` body, so MVC rejects it with **415** before your action runs. Without `[ApiController]` the parameter would bind from the query string, which is why this shows up when someone "modernizes" an old controller by adding the attribute. Query keys are case-insensitive, and there's no `{id}` route here.
:::

:::quiz id=be-22-q4 xp=15
Support says clients regularly get 400 responses from `POST /api/orders`, but the warning below
**never** shows up in the logs. Why?

```csharp
[ApiController]
[Route("api/orders")]
public class OrdersController(ILogger<OrdersController> logger) : ControllerBase
{
    [HttpPost]
    public IActionResult Create(CreateOrderRequest request)
    {
        if (!ModelState.IsValid)
        {
            logger.LogWarning("Rejected order: {Errors}", ModelState.Keys);
            return BadRequest(ModelState);
        }
        // …
    }
}
```

- [ ] `LogWarning` is filtered out because the default log level is `Error`
- [x] With `[ApiController]`, invalid model state is answered with a 400 by a built-in filter *before* the action runs, so this `if` is dead code
- [ ] `BadRequest(ModelState)` throws, and the exception swallows the log
- [ ] `ModelState` is only populated after the action returns
> The automatic 400 (`ModelStateInvalidFilter`) short-circuits the pipeline, so the action, and its logging, never executes for invalid input. The default minimum level is `Information`, so warnings would show if the code ran. To log or customise those responses, set `ApiBehaviorOptions.InvalidModelStateResponseFactory` in `ConfigureApiBehaviorOptions`. Don't disable the filter (`SuppressModelStateInvalidFilter`) just to keep the dead code alive. Every action would then have to check `ModelState` itself, and the ones that forget would run with invalid input.
:::

:::quiz id=be-22-q5 xp=10
This action doesn't compile (`CS0029: Cannot implicitly convert type 'IEnumerable<OrderDto>' to
'ActionResult<IEnumerable<OrderDto>>'`). Why, and what's the usual fix?

```csharp
[HttpGet]
public ActionResult<IEnumerable<OrderDto>> List()
{
    IEnumerable<OrderDto> orders = _repo.All().Select(OrderDto.From);
    return orders;
}
```

- [ ] `ActionResult<T>` can't wrap collections; use `IActionResult`
- [x] C# doesn't apply user-defined implicit conversions from an **interface** type, so `ActionResult<T>`'s `T → ActionResult<T>` operator isn't used; return `Ok(orders)` or a concrete type (`List<OrderDto>` via `.ToList()`)
- [ ] The method must be `async`
- [ ] `Select` returns a lazy query that MVC can't serialize
> `ActionResult<T>` has `implicit operator ActionResult<T>(T value)`, but the C# spec excludes user-defined conversions whose source is an interface. Returning a `List<OrderDto>` (a class) works, as does wrapping it explicitly in `Ok(...)`. Collections and sync methods are fine, and MVC can serialize a lazy `IEnumerable`. It's still better to materialize it so the database query doesn't run during serialization.
:::

## Filters: the MVC pipeline inside the pipeline

Middleware wraps **every** request. Inside the endpoint middleware, MVC runs a second, smaller
pipeline around each controller action: the **filter pipeline**. Filters exist because some
cross-cutting code needs things only MVC knows about, such as the selected action and its attributes,
the bound arguments, `ModelState`, and the `IActionResult` before it is written.

```text
request ──► middleware … ──► routing ──► endpoint middleware
                                           │
                       ┌───────────────────▼────────────────────────────┐
                       │ Authorization filters   (can short-circuit 401/403)
                       │ Resource filters        (before model binding — caching)
                       │   model binding + validation
                       │ Action filters          (see/replace arguments & result)
                       │     ► ACTION METHOD ◄
                       │ Exception filters       (exceptions from binding, action filters, action)
                       │ Result filters          (around writing the IActionResult)
                       └────────────────────────────────────────────────┘
```

```csharp
// An action filter: runs around the action, with bound arguments available
public sealed class RequireIfMatchFilter : IActionFilter
{
    public void OnActionExecuting(ActionExecutingContext context)
    {
        if (!context.HttpContext.Request.Headers.ContainsKey("If-Match"))
            context.Result = new ObjectResult(new ProblemDetails { Title = "If-Match header required" })
                { StatusCode = StatusCodes.Status428PreconditionRequired };   // setting Result short-circuits
    }

    public void OnActionExecuted(ActionExecutedContext context) { }
}
```

What each kind is typically used for in the `Filters/` folder you inherit:

| Filter kind | Interface(s) | What legacy code uses it for | What to watch for |
|---|---|---|---|
| Authorization | `IAuthorizationFilter`, `IAsyncAuthorizationFilter` | hand-rolled API-key or tenant checks from before policy-based auth | runs before model binding, so it can't see the body; modern code uses `[Authorize(Policy = …)]` + an `IAuthorizationHandler` instead |
| Resource | `IResourceFilter`, `IAsyncResourceFilter` | response caching, short-circuiting before binding | rare; if present, it may skip your action entirely |
| Action | `IActionFilter`, `IAsyncActionFilter`, `ActionFilterAttribute` | auditing, argument checks, transaction-per-request | an `IAsyncActionFilter` that forgets `await next()` silently stops the action from running |
| Exception | `IExceptionFilter`, `IAsyncExceptionFilter` | mapping domain exceptions to status codes | covers controller actions only (see below) |
| Result | `IResultFilter`, `IAsyncResultFilter`, `ResultFilterAttribute` | wrapping every response in an envelope (`{ "data": …, "success": true }`), adding headers | an envelope filter means the JSON clients see isn't the type the action returns: pin it with tests |

Where filters are registered decides where they apply, and you have to check all three places when
you read the code:

```csharp
// 1. global: every controller action in the app
services.AddControllers(o => o.Filters.Add<ApiExceptionFilter>());
services.AddScoped<RequireIfMatchFilter>();     // ServiceFilter resolves the filter from DI, so register it

// 2. on a controller class: every action in that controller
[ServiceFilter(typeof(RequireIfMatchFilter))]
public class DocumentsController : ControllerBase { … }

// 3. on a single action
[ServiceFilter(typeof(RequireIfMatchFilter))]
[HttpPut("{id:int}")]
public IActionResult Update(int id, UpdateDocument body) { … }
```

For "before" code, filters run from global to controller to action (outermost to innermost). "After"
code runs in reverse. An `Order` property overrides this.

### Filter or middleware?

| | Middleware | MVC filter |
|---|---|---|
| Runs for | every request (static files, health checks, minimal APIs, 404s) | controller actions only |
| Sees | `HttpContext` | `HttpContext` **plus** action descriptor, arguments, `ModelState`, `IActionResult` |
| Typical use | exception handling, CORS, auth, logging, correlation ids, rate limiting | per-action rules, model-aware validation, shaping MVC results |
| Minimal-API equivalent | the same middleware | endpoint filters (`AddEndpointFilter`) |

The classic legacy case is an **exception filter** that maps domain exceptions to status codes, like
the lab's `ApiExceptionFilter`. It works, but it only catches exceptions thrown inside the MVC
pipeline: not in middleware, not in minimal-API endpoints, not while the result is being written.
New code uses `UseExceptionHandler()` + `IExceptionHandler` + `AddProblemDetails()`, which covers
everything (see *Middleware, Logging & Global Error Handling*). Keep the old filter until your tests pin
its responses, then migrate.

:::quiz id=be-22-q6 xp=15
`ApiExceptionFilter` (a global MVC exception filter) maps `InvalidOperationException` to a 409.
A teammate adds a tenant-resolution **middleware** before `UseRouting` that throws
`InvalidOperationException("Unknown tenant")`. What does the client get for an unknown tenant?

- [ ] A 409, because the filter is registered globally
- [x] A 500 (or the developer exception page in Development): exception filters only see exceptions from inside the MVC action pipeline, not from middleware
- [ ] A 404, because routing never ran
- [ ] A 409 in production, a 500 in Development
> "Global" for an MVC filter means "every **controller action**", not "every request". The middleware throws before routing has even selected an action, so the filter pipeline never starts and the exception travels up through the middleware to the server: a 500. Exception handling that must cover everything belongs in `UseExceptionHandler` with an `IExceptionHandler`. Routing not running doesn't produce a 404, because the exception escapes before any status code is chosen.
:::

:::quiz id=be-22-q7 xp=15
Spot the bug. Someone wants an audit log for some actions and writes:

```csharp
public class AuditAttribute(IAuditLog log) : ActionFilterAttribute
{
    public override void OnActionExecuted(ActionExecutedContext context) =>
        log.Write(context.ActionDescriptor.DisplayName!, context.HttpContext.User.Identity?.Name);
}

[Audit]
[HttpDelete("{id:int}")]
public IActionResult Delete(int id) { /* … */ }
```

- [ ] It compiles, but `log` is `null` at runtime because attributes are created before DI
- [x] It doesn't compile: attribute constructor arguments must be compile-time constants, so `[Audit]` can't receive `IAuditLog`; make `AuditFilter : IActionFilter`, register it in DI, and apply it with `[ServiceFilter(typeof(AuditFilter))]` (or `[TypeFilter(typeof(AuditFilter))]`)
- [ ] `OnActionExecuted` never runs for `DELETE` requests
- [ ] It works; MVC injects constructor parameters into filter attributes automatically
> Attributes are metadata baked into the assembly, so their constructor arguments are constants written at the usage site. `[Audit]` with a required `IAuditLog` parameter is error CS7036. `ServiceFilter` resolves the filter from DI (so it must be registered and its lifetime matters), and `TypeFilter` creates it with DI-provided constructor arguments without registration. You'll see both all over older codebases, and they're the reason filter classes and filter attributes are often separate types.
:::

## AutoMapper in the wild

**What it does:** you declare maps once (`CreateMap<Order, OrderDto>()`) in `Profile` classes, and
`mapper.Map<OrderDto>(order)` copies values by **naming conventions**: same property names, plus
**flattening** (`Customer.Name` → `CustomerName`, `Lines.Count` → `LinesCount`). Anything that doesn't
match by name needs explicit configuration (`ForMember(d => d.Total, o => o.MapFrom(...))`).

**Why teams adopted it:** in 2012-era layered architectures, every entity had three near-identical
DTOs. Writing `a.X = b.X` by hand hundreds of times was tedious, so AutoMapper removed that typing.

**What it costs**, and these are what you'll actually debug:

1. **Silent failures.** Rename `Customer.Name` to `Customer.FullName`, and `CustomerName` is quietly
   `null` in every response. Nothing fails to compile. The only guard is a test calling
   `AssertConfigurationIsValid()`, which fails when a destination member has no source.
2. **Invisible rules.** Behaviour you'd never write by hand happens implicitly: a `null` source
   collection becomes an **empty list**, and `MapFrom(s => s.Lines.Sum(...))` doesn't throw when `Lines`
   is `null`; it quietly yields `0`. The lab pins exactly these two rules, because a "straightforward"
   manual rewrite breaks them.
3. **Business logic hiding in profiles.** `MapFrom` with calculations, `AfterMap`, `ConvertUsing`,
   value resolvers that inject services. When a price is wrong, nobody thinks to look in `Mapping/`.
4. **Tooling goes blind.** "Find all references" on `OrderDto.LinesCount` shows zero usages, so it looks
   dead. Delete it and the API contract changes.
5. **Querying mistakes.** `mapper.Map<List<OrderDto>>(await db.Orders.Include(o => o.Lines).ToListAsync())`
   loads full entities and then maps them in memory. `db.Orders.ProjectTo<OrderDto>(mapper.ConfigurationProvider)`
   turns the map into a SQL `SELECT` of only the needed columns, but it fails at runtime for `MapFrom`
   expressions EF can't translate. (See *EF Core Querying Like a Pro* on projections.)
6. **Mapping onto entities.** `mapper.Map(dto, entity)` overwrites every matching property, including
   ones the client shouldn't control. It's overposting by convention.

:::warn title="AutoMapper 14 and older: a known CVE with no free patch"
Restoring AutoMapper ≤ 14.0.0 prints `warning NU1903: Package 'AutoMapper' 14.0.0 has a known high
severity vulnerability` (GHSA-rvv3-g6hj-g44x / CVE-2026-32933, March 2026). Mapping a deeply nested
**self-referencing** object graph recurses until the process dies with a `StackOverflowException`.
That's a denial of service. The fix shipped in 15.1.1 and 16.1.1, and since July 2025 those versions are
**commercially licensed** (free community tier for small companies; see *API Architecture That Stays
Simple*). For an MIT-licensed AutoMapper there is no patched version. Your options: buy a license and
upgrade, remove AutoMapper, or document why you're not exposed (no recursive types mapped from untrusted
input) and suppress that one advisory with
`<NuGetAuditSuppress Include="https://github.com/advisories/GHSA-rvv3-g6hj-g44x" />`. Never suppress
NU1903 wholesale with `NoWarn`. If `TreatWarningsAsErrors` is on, this warning turns into a failed build.
:::

### Keep it or remove it?

| Keep AutoMapper (for now) when… | Remove it (incrementally) when… |
|---|---|
| maps are mostly trivial and consistent | profiles contain business logic or `AfterMap` surprises |
| `AssertConfigurationIsValid()` runs in a test | you've had bugs from silent renames |
| license/CVE situation is acceptable to the company | the license or the CVE is a blocker |
| the team is productive with it | you're rewriting that feature anyway |

Removing it is never a big-bang PR. Pin behaviour with tests, then replace **one profile at a time**
with plain code (an extension method `order.ToDto()` or a static `From` factory), or with a
compile-time generator like Mapperly. Delete the profile once its tests are green. AutoMapper and
manual mapping coexist happily during the transition; the lab does exactly this.

:::quiz id=be-22-q8 xp=15
A teammate renames `Customer.Name` to `Customer.FullName` in the domain model. AutoMapper had flattened
it into `OrderDto.CustomerName` by convention. The solution compiles. What happens, and what catches it?

- [ ] The build fails because AutoMapper uses source generators
- [ ] AutoMapper throws on the first request, so any smoke test catches it
- [x] Every response silently gets `customerName: null` (or the key disappears); a unit test calling `AssertConfigurationIsValid()` fails because `CustomerName` now has no source
- [ ] AutoMapper automatically maps `FullName` to `CustomerName` because both end in "Name"
> Convention mapping is resolved at runtime by name. With no matching source member the destination keeps its default value, with no exception and no compile error. `AssertConfigurationIsValid()` checks that every destination member is mapped, configured or explicitly ignored, so it fails immediately here. A smoke test that only checks for a 200 wouldn't notice anything, and AutoMapper doesn't do fuzzy name matching.
:::

### Challenge: replace the magic with plain code

:::challenge id=be-22-c2 lang=ts xp=40
title: A manual mapper that keeps the legacy contract
The legacy API used a mapper with conventions and quirks. You're replacing it with an explicit
`toOrderDto(order)` that must produce **exactly** what the old mapper produced (the types are in the
setup block):

- `id`, `status` and `createdAtUtc` are copied unchanged.
- `customerName` is `customer.name`, or `null` when there is no customer.
- `linesCount` is the number of lines; `lines` is `[]` (never `null`) when the order has no lines.
- Each line gets `lineTotal = quantity * unitPrice`; `total` is the sum of all line totals. Both are
  **rounded to cents** (`Math.round(x * 100) / 100`), and `total` is `0` when there are no lines.
- `notes` is **omitted** from the object when it is `null` (the old JSON settings ignored nulls), not
  set to `null` or `undefined`.
- Each line DTO has exactly the keys `sku`, `quantity`, `unitPrice` (copied) and `lineTotal`.
- Return new objects: don't hand out the entity's own line objects.

hint: Start with `const lines = order.lines ?? []` and build everything from that.
hint: Build the object without `notes`, then `if (order.notes !== null) dto.notes = order.notes`.
hint: `0.1 * 3` is `0.30000000000000004` in JavaScript; rounding to cents fixes it.

```ts setup
type OrderLine = { sku: string; quantity: number; unitPrice: number }
type Order = {
  id: number
  customer: { name: string; email: string } | null
  status: 'Pending' | 'Paid' | 'Shipped' | 'Cancelled'
  lines: OrderLine[] | null
  notes: string | null
  createdAtUtc: string
}
type OrderLineDto = { sku: string; quantity: number; unitPrice: number; lineTotal: number }
type OrderDto = {
  id: number
  customerName: string | null
  status: Order['status']
  linesCount: number
  total: number
  notes?: string
  createdAtUtc: string
  lines: OrderLineDto[]
}
```

```ts starter
export function toOrderDto(order: Order): OrderDto {
  return {
    id: order.id,
    customerName: order.customer!.name,
    status: order.status,
    linesCount: order.lines!.length,
    total: order.lines!.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0),
    notes: order.notes ?? undefined,
    createdAtUtc: order.createdAtUtc,
    lines: order.lines!.map((l) => ({ ...l, lineTotal: l.quantity * l.unitPrice })),
  }
}
```

```ts solution
const toCents = (n: number) => Math.round(n * 100) / 100

export function toOrderDto(order: Order): OrderDto {
  const source = order.lines ?? []
  const lines = source.map((l) => ({
    sku: l.sku,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    lineTotal: toCents(l.quantity * l.unitPrice),
  }))
  const dto: OrderDto = {
    id: order.id,
    customerName: order.customer?.name ?? null,
    status: order.status,
    linesCount: source.length,
    total: toCents(source.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0)),
    createdAtUtc: order.createdAtUtc,
    lines,
  }
  if (order.notes !== null) dto.notes = order.notes
  return dto
}
```

```ts tests
const ada: Order = {
  id: 1,
  customer: { name: 'Ada Lovelace', email: 'ada@example.com' },
  status: 'Paid',
  notes: 'Gift wrap',
  createdAtUtc: '2024-03-01T10:00:00Z',
  lines: [
    { sku: 'BOOK-1', quantity: 2, unitPrice: 9.99 },
    { sku: 'PEN-7', quantity: 1, unitPrice: 25 },
  ],
}
const imported: Order = {
  id: 3,
  customer: { name: 'Linus Torvalds', email: 'linus@example.com' },
  status: 'Pending',
  notes: null,
  createdAtUtc: '2019-12-24T00:00:00Z',
  lines: null,
}

test('maps a full order exactly like the legacy mapper', () => {
  expect(toOrderDto(ada)).toEqual({
    id: 1,
    customerName: 'Ada Lovelace',
    status: 'Paid',
    linesCount: 2,
    total: 44.98,
    notes: 'Gift wrap',
    createdAtUtc: '2024-03-01T10:00:00Z',
    lines: [
      { sku: 'BOOK-1', quantity: 2, unitPrice: 9.99, lineTotal: 19.98 },
      { sku: 'PEN-7', quantity: 1, unitPrice: 25, lineTotal: 25 },
    ],
  })
})
test('null lines become an empty list with zero total', () => {
  const dto = toOrderDto(imported)
  expect(dto.lines).toEqual([])
  expect(dto.linesCount).toBe(0)
  expect(dto.total).toBe(0)
})
test('null notes are omitted, not null or undefined', () => {
  expect(Object.keys(toOrderDto(imported))).not.toContain('notes')
  expect(toOrderDto(ada).notes).toBe('Gift wrap')
})
test('missing customer maps to null customerName', () => {
  expect(toOrderDto({ ...imported, customer: null }).customerName).toBeNull()
})
test('totals are rounded to cents', () => {
  const dto = toOrderDto({ ...ada, lines: [{ sku: 'X', quantity: 3, unitPrice: 0.1 }] })
  expect(dto.lines[0].lineTotal).toBe(0.3)
  expect(dto.total).toBe(0.3)
})
test('returns new line objects', () => {
  const dto = toOrderDto(ada)
  expect(dto.lines[0]).not.toBe(ada.lines![0])
  expect(Object.keys(dto.lines[0]).sort()).toEqual(['lineTotal', 'quantity', 'sku', 'unitPrice'])
})
```
:::

## MediatR in the wild

**What it does:** controllers become one-liners that `Send` a request object. MediatR finds the single
`IRequestHandler<TRequest, TResponse>` for that type and runs it, wrapped in every registered
**pipeline behavior** (validation, logging, transactions). `Publish` sends an `INotification` to *all*
its handlers. *API Architecture That Stays Simple* covers the design trade-offs. Here is what you need
when you inherit it:

```csharp
[HttpPost]
public async Task<ActionResult<OrderDto>> Create(PlaceOrder.Command command, CancellationToken ct)
    => await mediator.Send(command, ct);    // F12 on Send lands in MediatR, not in your code
```

**Finding the handler.** "Go to definition" doesn't help. Use "Find usages" on the request *type*
(`PlaceOrder.Command`), or search for `IRequestHandler<PlaceOrder.Command`. Well-kept codebases put the
request, its validator and its handler in the same file. If yours doesn't, that's a cheap first
improvement.

**Pitfalls you'll meet:**

- **Handlers that `Send` other requests.** The call graph disappears from the code, and every inner
  `Send` runs the whole behavior pipeline again: validation twice, nested "transactions", duplicated logs.
- **Behaviors apply to everything.** An open generic `TransactionBehavior<,>` also wraps every *query*.
  Behaviors nest in **registration order** (first registered = outermost). A logging behavior registered
  after the validation behavior never sees rejected requests.
- **Notifications aren't messaging.** By default `Publish` awaits handlers **one after another**. If one
  throws, the remaining handlers don't run and the exception fails the HTTP request, even though the order
  was already saved. Nothing is retried, nothing is durable. For "must happen eventually", use an outbox
  or a queue (*Background Jobs & Durable Queues*).
- **Licensing.** MediatR 13+ is commercially licensed. 12.x is Apache-2.0 and frozen.

**Keep or remove?** If the whole codebase uses MediatR consistently, keep it. A half-removed mediator is
worse than either extreme. To remove it, note that handlers already *are* plain classes with a `Handle`
method. Register them in DI, inject the handler into the controller or endpoint, and replace behaviors
with MVC/endpoint filters or a decorator. Do it feature by feature, behind tests.

:::quiz id=be-22-q9 xp=15
After saving an order, a handler calls `await mediator.Publish(new OrderPlaced(order.Id), ct)`. Three
notification handlers exist: `SendConfirmationEmail`, `UpdateSalesStats`, `NotifyWarehouse`. The SMTP
server is down, so `SendConfirmationEmail` (registered first) throws. With MediatR's default publisher,
what happens?

- [ ] The other two handlers still run in parallel; only the email is lost
- [ ] MediatR retries the email handler three times, then dead-letters it
- [x] Handlers run sequentially, so `UpdateSalesStats` and `NotifyWarehouse` never run, the exception bubbles up and the client gets a 500, although the order is already saved
- [ ] The order save is rolled back automatically because `Publish` is transactional
> The default notification publisher awaits handlers one by one and stops at the first exception. It's in-process method calls, not a message broker: no retries, no isolation, no durability. The client sees an error and may retry, which creates a **duplicate order**. The warehouse is never told. When side effects must happen reliably, write them to an outbox table in the same transaction and process it in a background worker. The tempting "parallel" answer describes the opt-in `TaskWhenAllPublisher`, and even that doesn't isolate failures.
:::

## Repository and unit-of-work layers over EF Core

*API Architecture That Stays Simple* explains why a generic repository over EF Core is usually a mistake.
In an existing codebase it's already there, and rewriting the data layer is rarely your call in month
one. So learn the bugs these layers typically contain, because those are the ones you'll be asked to fix:

```csharp
// ❌ 1. Repositories that save on their own: no unit of work at all
public class OrderRepository(AppDbContext db) : IOrderRepository
{
    public async Task AddAsync(Order order)
    {
        db.Orders.Add(order);
        await db.SaveChangesAsync();          // commits immediately
    }
}

// ❌ 2. "Update" a detached entity built from a DTO
var order = mapper.Map<Order>(dto);           // properties not in the DTO are null/default
orderRepository.Update(order);                // DbSet.Update marks EVERY column as modified…
await unitOfWork.CompleteAsync();             // …so it overwrites them with null/default

// ❌ 3. Returning IEnumerable from a repository that wraps IQueryable
public IEnumerable<Order> GetAll() => db.Orders;           // looks harmless
var open = repo.GetAll().Where(o => o.Status == Open);     // filter runs in C#, after loading the whole table

// ❌ 4. Lifetime mismatch
services.AddSingleton<IUnitOfWork, UnitOfWork>();          // captures one DbContext forever (captive dependency)
```

| Bug | Symptom | Fix inside the existing pattern |
|---|---|---|
| `SaveChanges` inside repositories | partial writes when the second step fails | repositories only stage changes; one `SaveChangesAsync` per use case (the unit of work's job) |
| `Update()` on a mapped detached entity | columns randomly reset to null/0 | load the tracked entity, change the fields you mean to, save |
| `IEnumerable` return types | slow endpoints, memory spikes as tables grow | return materialized lists from specific query methods, or `IQueryable` internally |
| singleton UoW/repository | "second operation started on this context", stale data, cross-request leaks | everything holding a `DbContext` is **scoped** (*Dependency Injection & Configuration*) |

:::quiz id=be-22-q10 xp=15
Spot the bug. Placing an order must create the order **and** reserve stock, all or nothing.

```csharp
public async Task PlaceAsync(Order order, CancellationToken ct)
{
    await _orders.AddAsync(order, ct);                       // db.Orders.Add + SaveChangesAsync
    await _inventory.ReserveAsync(order.Lines, ct);          // updates stock rows + SaveChangesAsync
}
```

`ReserveAsync` throws `OutOfStockException` for one item. What's in the database afterwards, and what's
the smallest fix?

- [ ] Nothing: EF Core rolls back both because they share a `DbContext`
- [x] The order exists without a stock reservation, because each repository commits its own transaction; remove `SaveChangesAsync` from the repositories and call it once at the end of `PlaceAsync` (via the unit of work)
- [ ] Only the stock update, because EF Core saves in reverse order
- [ ] Nothing, because `OutOfStockException` is thrown before any SQL runs
> Each `SaveChangesAsync` call is its own transaction, so the first one is already committed when the second step throws. Sharing a `DbContext` doesn't change that. The point of a unit of work is that repositories only *stage* changes and one `SaveChangesAsync` commits them together. That's exactly what `DbContext` already does, which is the core argument against wrapping it. For steps that need several saves, use an explicit transaction (`db.Database.BeginTransactionAsync`).
:::

## Newtonsoft.Json vs System.Text.Json: the differences that bite

Before .NET Core 3.0, ASP.NET used **Newtonsoft.Json** (Json.NET). Apps from that era call
`AddNewtonsoftJson()`, and their clients depend on its exact behaviour, often without anyone knowing.
`System.Text.Json` (STJ) is faster and built in, but it is **deliberately stricter**. Switching
serializers is an API contract change, not a refactor.

| Behaviour | Newtonsoft (typical MVC setup) | System.Text.Json |
|---|---|---|
| Attributes | `[JsonProperty("x")]`, `Newtonsoft.Json.JsonIgnore` | `[JsonPropertyName("x")]`, `System.Text.Json.Serialization.JsonIgnore`. **The other library's attributes are silently ignored.** |
| Property names on read | case-insensitive | case-insensitive in ASP.NET Core and `ReadFromJsonAsync` (web defaults), **case-sensitive** with a bare `JsonSerializer.Deserialize<T>(json)` |
| Trailing commas, comments | accepted | rejected unless `AllowTrailingCommas` / `ReadCommentHandling` |
| Numbers in strings (`"2"` → `int`) | accepted | accepted under web defaults, rejected with plain defaults |
| Enums | numbers, or strings with `StringEnumConverter` | numbers, or strings with `JsonStringEnumConverter` |
| Ignoring nulls | `NullValueHandling.Ignore` | `DefaultIgnoreCondition = WhenWritingNull` |
| Reference loops | `ReferenceLoopHandling.Ignore` (common in old apps) | throws unless `ReferenceHandler.IgnoreCycles` |
| Public fields | serialized | ignored unless `IncludeFields` / `[JsonInclude]` |
| Private setters, non-default constructors | works in many cases | needs `[JsonInclude]` or a matching public constructor (`[JsonConstructor]`) |
| Decimal zero | `0.0` | `0` |
| Dynamic JSON | `JObject`, `JToken`, `dynamic` | `JsonNode`/`JsonObject` (mutable), `JsonElement` (read-only); no `dynamic` |
| Dates in untyped JSON | date-looking strings are parsed into `DateTime` when reading into `JObject` | strings stay strings unless the target type is a date |

How to approach it in an inherited codebase:

1. **Keep Newtonsoft during the .NET upgrade.** `Microsoft.AspNetCore.Mvc.NewtonsoftJson` 10.0.x is
   supported on .NET 10. Upgrade first, switch serializers later, in a separate PR.
2. Before switching, **pin the JSON contract with characterization tests**: exact response bodies, and
   the lenient inputs real clients send (trailing commas, quoted numbers, odd casing).
3. Search for `Newtonsoft` across the solution: attributes, custom `JsonConverter`s, `JObject` usage,
   `JsonConvert.SerializeObject` in logging or caching code (which may also be persisted data!).
4. Switch, then let the failing tests tell you which options to set (`AllowTrailingCommas`,
   converters) or which client contracts to version.

:::quiz id=be-22-q11 xp=10
After replacing `AddNewtonsoftJson()` with the default System.Text.Json, the mobile team reports that
`order_ref` is now `orderRef` in responses. The DTO didn't change:

```csharp
using Newtonsoft.Json;

public class OrderDto
{
    [JsonProperty("order_ref")]
    public string OrderRef { get; set; } = "";
}
```

Why?

- [ ] STJ doesn't support custom property names
- [x] STJ ignores Newtonsoft's `[JsonProperty]`, so the property falls back to the camelCase naming policy; use `[JsonPropertyName("order_ref")]` from `System.Text.Json.Serialization`
- [ ] The camelCase policy overrides explicit names in STJ
- [ ] The DTO needs `[Serializable]`
> The two libraries have look-alike attributes in different namespaces, and neither reads the other's. Nothing fails at compile time or at runtime; the contract just changes. That's why you grep for `using Newtonsoft.Json` before switching and pin the JSON with characterization tests. An explicit `[JsonPropertyName]` always beats the naming policy in STJ.
:::

## Characterization tests: pin behaviour before you change it

A **characterization test** (Michael Feathers, *Working Effectively with Legacy Code*) records what the
code **does today**, not what it should do. Its purpose is a safety net. If an upgrade or refactor changes
any observable behaviour, a test goes red, and you decide on purpose whether that change is acceptable.

The difference from normal tests is the mindset:

- You don't derive the expected value from a spec. You **run the code and paste the actual output** into
  the assertion. Write `Assert.Equal("", body)`, run it, and copy the "Actual" value from the failure.
- You **pin bugs too**. If `GET /orders?status=shipped` accepts lowercase only because of a framework
  quirk, a client somewhere relies on it. Pin it now and decide about it later, in its own PR.
- You test at the **outermost seam** you can: HTTP requests through `WebApplicationFactory`, comparing raw
  JSON strings. Those survive internal refactors (AutoMapper → manual mapping, Startup → minimal
  hosting) that would break unit tests of internal classes.

What to pin first, in order of value:

1. **Response bodies of the hot endpoints**, byte for byte: property names, casing, null handling,
   number formats, enum format, date format.
2. **Error contracts**: status codes and bodies for not found, validation errors (the keys!), conflicts.
3. **Lenient inputs** real clients send.
4. **Edge data**: nulls, empty collections, legacy rows imported from an older system.

For larger APIs, **snapshot testing** with the Verify library (`await Verify(responseBody)`) stores
expected outputs in `*.verified.txt` files next to the tests and shows a diff when they change. It's
the same idea with less copy-pasting.

:::warn title="A real bug found while writing this lab: culture-dependent validation"
`[Range(typeof(decimal), "0.01", "100000")]` parses its limits with the **current culture**. On a
machine with a German locale `"0.01"` isn't a number, so every request touching that DTO crashed with a
500, while it worked on the original developer's English machine. Characterization tests that run on
CI agents with a different culture catch exactly this kind of thing. Use
`[Range(0.01, 100_000)]` or set `ParseLimitsInInvariantCulture = true`.
:::

:::challenge id=be-22-c1 lang=ts mode=tests xp=50
title: Characterize the shipping calculator before the refactor
`shippingCost` (below) is ten years old and nobody remembers every rule. A colleague is about to "clean
it up". Write characterization tests that pin its **current** behaviour, quirks included. Your tests must
pass on this code and fail on each of four "harmless" refactors hidden behind the run button. Each
refactor changes exactly one rule: the free-shipping threshold, how express interacts with free
shipping, how the country code is compared, or the half-price threshold. Assert exact return values
with `toBe`.

hint: Every `if` has a boundary. Test exactly at it and just past it (50 vs 49.99, 200 vs 200.01).
hint: What does a German express order over 50 cost today? The order of the checks matters.
hint: Is `'de'` treated like `'DE'`? Whatever it does today is the behaviour to pin, even if it looks like a bug.

```ts impl
export function shippingCost(order: { subtotal: number; country: string; express?: boolean }): number {
  if (order.country === 'DE' && order.subtotal >= 50) return 0
  let cost = order.country === 'DE' ? 4.9 : 12.5
  if (order.express) cost = cost * 2
  if (order.subtotal > 200) cost = cost / 2
  return Math.round(cost * 100) / 100
}
```

```ts mutant
export function shippingCost(order: { subtotal: number; country: string; express?: boolean }): number {
  if (order.country === 'DE' && order.subtotal > 50) return 0
  let cost = order.country === 'DE' ? 4.9 : 12.5
  if (order.express) cost = cost * 2
  if (order.subtotal > 200) cost = cost / 2
  return Math.round(cost * 100) / 100
}
```

```ts mutant
export function shippingCost(order: { subtotal: number; country: string; express?: boolean }): number {
  if (order.country === 'DE' && order.subtotal >= 50 && !order.express) return 0
  let cost = order.country === 'DE' ? 4.9 : 12.5
  if (order.express) cost = cost * 2
  if (order.subtotal > 200) cost = cost / 2
  return Math.round(cost * 100) / 100
}
```

```ts mutant
export function shippingCost(order: { subtotal: number; country: string; express?: boolean }): number {
  const country = order.country.toUpperCase()
  if (country === 'DE' && order.subtotal >= 50) return 0
  let cost = country === 'DE' ? 4.9 : 12.5
  if (order.express) cost = cost * 2
  if (order.subtotal > 200) cost = cost / 2
  return Math.round(cost * 100) / 100
}
```

```ts mutant
export function shippingCost(order: { subtotal: number; country: string; express?: boolean }): number {
  if (order.country === 'DE' && order.subtotal >= 50) return 0
  let cost = order.country === 'DE' ? 4.9 : 12.5
  if (order.express) cost = cost * 2
  if (order.subtotal >= 200) cost = cost / 2
  return Math.round(cost * 100) / 100
}
```

```ts starter
test('German orders over 50 ship free', () => {
  expect(shippingCost({ subtotal: 80, country: 'DE' })).toBe(0)
})
```

```ts solution
test('DE free shipping starts at exactly 50', () => {
  expect(shippingCost({ subtotal: 50, country: 'DE' })).toBe(0)
  expect(shippingCost({ subtotal: 49.99, country: 'DE' })).toBe(4.9)
})
test('DE express over 50 is still free', () => {
  expect(shippingCost({ subtotal: 60, country: 'DE', express: true })).toBe(0)
})
test('country code is case-sensitive today: "de" pays the foreign rate', () => {
  expect(shippingCost({ subtotal: 60, country: 'de' })).toBe(12.5)
})
test('foreign half price starts just above 200', () => {
  expect(shippingCost({ subtotal: 200, country: 'US' })).toBe(12.5)
  expect(shippingCost({ subtotal: 200.01, country: 'US' })).toBe(6.25)
})
test('express doubles the cost', () => {
  expect(shippingCost({ subtotal: 10, country: 'US', express: true })).toBe(25)
  expect(shippingCost({ subtotal: 10, country: 'DE', express: true })).toBe(9.8)
})
```
:::

:::pro title="Characterization tests are temporary scaffolding, and that's fine"
Byte-for-byte JSON assertions are brittle on purpose: during an upgrade you *want* any difference to
fail. Once the risky change has shipped, seniors keep the valuable ones (contract tests for endpoints
clients depend on), loosen others into property-level assertions, and delete the ones that pinned
accidental behaviour after deciding, with the product owner, to change it. Record each such decision in
the PR description: "`total` for line-less orders changed from `0.0` to `0`, mobile team confirmed OK".
:::

## Upgrading .NET 6/8 → 10 safely

**Why now:** .NET 8 (LTS) and .NET 9 (STS, extended to 24 months) both leave support on **November 10,
2026**. .NET 6 left in November 2024. After that date there are no security patches, and every new
CVE in the runtime or ASP.NET Core stays open in your app. .NET 10 is the current LTS, supported until
November 2028.

**You don't need intermediate versions.** Going straight from 8 to 10 is normal. You do have to read
the breaking-change notes of **every version you skip** (9 *and* 10; from 6 that's 7, 8, 9 and 10). They
live on Microsoft Learn under "Breaking changes in .NET 9/10", sorted by area (ASP.NET Core, EF Core,
SDK, …). Skim them for the packages and features your app actually uses.

### The procedure

```text
0. Baseline     CI green on the old version. Characterization tests pin the API contract.
1. Read         breaking changes for every skipped version; list the ones that touch your app.
2. Pin the SDK  global.json → 10.0.x; CI images (actions/setup-dotnet dotnet-version: 10.0.x);
                Dockerfile base images (sdk:10.0 / aspnet:10.0).
3. Bump TFM     <TargetFramework>net10.0</TargetFramework>, once, in Directory.Build.props if you have one.
4. Packages     every Microsoft.AspNetCore.* / Microsoft.Extensions.* / Microsoft.EntityFrameworkCore.*
                to 10.0.x; providers that track EF Core's major (Npgsql.EntityFrameworkCore.PostgreSQL 10.x).
                dotnet list package --outdated / --vulnerable --include-transitive
5. Build        fix errors; then READ every new warning (obsoletions, audit warnings, analyzers).
6. Test         characterization + existing tests, then run the app and smoke-test it, deploy to staging.
7. Ship         that PR contains nothing else. Modernize in later PRs.
```

Warnings worth knowing on the way to .NET 10:

| Warning | Means |
|---|---|
| `ASPDEPR004` `WebHostBuilder` is deprecated / `ASPDEPR008` `WebHost` is obsolete | ASP.NET Core 2.x-era hosting (`WebHost.CreateDefaultBuilder`). `Host.CreateDefaultBuilder` + `ConfigureWebHostDefaults` is still fine; `WebApplication.CreateBuilder` is the goal |
| `ASPDEPR006` `IActionContextAccessor` is obsolete | old helper for reaching `ActionContext` from services; use `IHttpContextAccessor` + endpoint metadata |
| `NU1903` / `NU1902` on a project that never referenced the package | the .NET 10 SDK audits **transitive** packages by default for `net10.0` projects, so vulnerabilities that were always there now show up |
| `CS8618`, `CS8602`, … after enabling `<Nullable>` | nullable reference type analysis (see below) |

Two further changes often catch people out. The C# 14 compiler makes `field` a keyword inside property
accessors, so code that uses a member or local named `field` there needs `@field` or `this.field`. And
the default Linux distribution of the .NET 10 container images changed from Debian 12 to **Ubuntu 24.04**
(`mcr.microsoft.com/dotnet/aspnet:10.0` is Ubuntu, `…:8.0` was Debian). Package names and versions that
`apt-get install` lines in your Dockerfile depend on may differ, so build the image in the upgrade PR, not
just the code.

:::info title="upgrade-assistant and Copilot app modernization"
Microsoft's `upgrade-assistant` (a `dotnet tool`) automates TFM and package bumps and was invaluable for
leaving .NET Framework and non-SDK-style projects. For an SDK-style project it does steps 3 and 4 for you:

```bash
dotnet tool install -g upgrade-assistant
upgrade-assistant analyze Legacy.Api/Legacy.Api.csproj          # report only
upgrade-assistant upgrade Legacy.Api/Legacy.Api.csproj \
  --operation Inplace --targetFramework net10.0 --non-interactive
```

On the lab's project, version 1.0.518 changed `net8.0` → `net10.0` and
`Microsoft.AspNetCore.Mvc.NewtonsoftJson` 8.0.x → 10.0.x, and left AutoMapper alone. Pointed at one
project it changes only that project (run it on the test project too), and it doesn't touch
`global.json`, CI or Dockerfiles, so steps 2, 5 and 6 are still yours. Microsoft is
steering users towards **GitHub Copilot app modernization** (Visual Studio / VS Code) as its successor,
and the tool's last release dates from mid-2025. For a two-project solution, doing the steps above by hand
is usually just as fast and easier to review. Either way, treat the result as a draft PR that you review
against the breaking-change notes and your tests.
:::

:::warn title="Check the tool's current status before relying on it"
Tool names, flags and Microsoft's recommended upgrade path change faster than this lesson. Before you put
`upgrade-assistant` into a team process, check `upgrade-assistant --help` and the "Upgrade .NET apps"
pages on Microsoft Learn (learn.microsoft.com/dotnet/core/porting/).
:::

### Multi-targeting and the CI matrix

Shared libraries (NuGet packages, a `Common` project used by several services) often can't move in one
step, because some consumers are still on .NET 8. Multi-target them for the transition:

```xml
<TargetFrameworks>net8.0;net10.0</TargetFrameworks>   <!-- note the plural element name -->
```

…and test both in CI:

```yaml
# .github/workflows/ci.yml
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        tfm: [net8.0, net10.0]
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-dotnet@v6
        with:
          dotnet-version: |
            8.0.x
            10.0.x
      - run: dotnet test --framework ${{ matrix.tfm }}
```

The .NET 10 SDK builds both targets; the 8.0 install is there so the `net8.0` tests run on the real
.NET 8 runtime.

Drop `net8.0` once the last consumer has upgraded. Apps (the web project itself) target exactly one
framework.

### Nullable reference types in an old codebase

Legacy projects usually have `<Nullable>disable</Nullable>`. Turning it on produces hundreds of
warnings. You can still adopt it gradually:

- Enable it project-wide, and put `#nullable disable` at the top of every existing file (a one-line
  script). Then remove that line file by file as you touch them. New files are checked from day one.
- Fix warnings by expressing intent (`string?`, `required`, guard clauses), not by sprinkling `!`.
- Never "fix" the count with `<NoWarn>` or by turning warnings off.

:::warn title="Enabling nullable changes your API's validation"
With `<Nullable>enable</Nullable>`, MVC treats every **non-nullable reference type property** on a
request DTO as implicitly `[Required]`. A `public string Notes { get; set; }` that clients have always been
allowed to omit now produces automatic 400s. Nothing in the code changed except a csproj line. Mark
optional properties `string?`. The lab shows three characterization tests failing on exactly this.
:::

:::quiz id=be-22-q12 xp=15
You upgrade the API project to `net10.0` and enable `<Nullable>enable</Nullable>` in the same PR. You
fix all warnings without touching any logic. In staging, the mobile app suddenly gets 400s for orders
without a note. The DTO:

```csharp
public class CreateOrderRequest
{
    [Required] public string CustomerName { get; set; } = "";
    public string Notes { get; set; } = "";     // optional; clients often omit it
}
```

What happened?

- [ ] .NET 10 made all DTO properties required by default
- [x] With nullable enabled, MVC treats non-nullable reference properties as implicitly `[Required]`, so a missing `notes` now fails validation; declare it `string? Notes`
- [ ] The `= ""` initializer is ignored by System.Text.Json
- [ ] Mobile clients send `null`, which .NET 10 no longer accepts for strings
> The nullable context changes what `string` *means*: "never null". MVC's validation honours that by adding an implicit `[Required]` (it can be turned off with `SuppressImplicitRequiredAttributeForNonNullableReferenceTypes`, but fixing the annotation is better). The `= ""` initializer doesn't save you: an omitted `notes` leaves the property at `""`, and `[Required]` rejects empty strings by default (`AllowEmptyStrings = false`). It isn't a .NET 10 change; the same thing happens on .NET 8 the moment you flip the switch. That's also why the switch belongs in its own PR, after the upgrade, with characterization tests that post requests without optional fields.
:::

:::quiz id=be-22-q13 xp=15
Which changes belong in the **first** PR that moves an app from .NET 8 to .NET 10? (Select all that apply.)

- [x] `TargetFramework` → `net10.0`, plus `global.json`, CI SDK version and Docker base images
- [x] `Microsoft.AspNetCore.*` / `Microsoft.EntityFrameworkCore.*` packages → 10.0.x (and providers like Npgsql's EF Core provider to their 10.x)
- [ ] Replacing Newtonsoft.Json with System.Text.Json while everything is being retested anyway
- [ ] Upgrading to .NET 9 first, because skipping a version isn't supported
- [x] Fixing the compile errors the bump causes, and reading (not necessarily fixing) every new warning
- [ ] Converting `Startup.cs` to minimal hosting, since .NET 10 no longer supports `Startup`
> Keep the upgrade PR **mechanical**: framework, SDK, images, matching package versions, and whatever is needed to compile and pass the tests. If something breaks, the diff is small enough to find the cause. Serializer switches and hosting rewrites change behaviour on their own and get their own PRs, each protected by the same characterization tests. `Startup` with `Host.CreateDefaultBuilder` still works on .NET 10. Skipping 9 is fine, but you must read 9's breaking changes too.
:::

:::quiz id=be-22-q14 xp=10
After bumping both projects to `net10.0`, `dotnet build` shows `NU1903: Package 'AutoMapper' 14.0.0 has
a known high severity vulnerability` for the **test** project too. The test project doesn't reference
AutoMapper. What changed?

- [ ] The test project gained a direct AutoMapper reference during the upgrade
- [ ] The advisory was published today
- [x] For projects targeting .NET 10, the SDK's NuGet audit checks **transitive** packages by default, and AutoMapper reaches the tests through the project reference to the API
- [ ] .NET 10 doesn't support AutoMapper 14
> NuGet audit used to report only direct references by default. For `net10.0` projects it checks the whole graph (`NuGetAuditMode` = `all`). The vulnerable package was always in the test project's dependency graph; now you see it. AutoMapper 14 runs fine on .NET 10 (the lab proves it); the warning is about the CVE, not compatibility. Run `dotnet list package --vulnerable --include-transitive` to see the full picture on any version.
:::

## Lab: characterize, upgrade, de-magic

:::lab id=be-22-lab1 xp=150
title: Take over a .NET 8 controller API: characterization tests → .NET 10 → manual mapping
You've joined a team that owns a small **Orders API**: .NET 8, `Startup.cs`, controllers, an MVC
exception filter, AutoMapper and Newtonsoft.Json. Your ticket: *"Upgrade to .NET 10 before .NET 8
support ends, and get rid of the `OrderProfile` mapping, it hides too much logic."* You'll do it the safe
way: first pin the behaviour, then change one thing at a time.

You need the .NET 10 SDK. To run the tests **before** the upgrade, you also need the **ASP.NET Core 8
runtime**. Check with `dotnet --list-runtimes` (look for `Microsoft.AspNetCore.App 8.0.x`). If it's
missing, install it (`winget install Microsoft.DotNet.AspNetCore.8`, `sudo apt install aspnetcore-runtime-8.0`, or the
`dotnet-install` script with `--runtime aspnetcore --channel 8.0`). With Docker or Podman you can skip
the install and run the baseline in the official .NET 8 SDK image instead (step 5 shows how).

**1. Create the solution and folders**

```bash
mkdir -p ~/devquest/be-22-lab1 && cd ~/devquest/be-22-lab1
dotnet new sln -n Legacy        # the .NET 10 SDK creates Legacy.slnx (the XML solution format)
mkdir -p Legacy.Api/Controllers Legacy.Api/Data Legacy.Api/Domain Legacy.Api/Dtos \
         Legacy.Api/Filters Legacy.Api/Mapping Legacy.Api.Tests
```

**2. The legacy app**: create these files exactly as shown. This is the code you "inherited".

`Legacy.Api/Legacy.Api.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="AutoMapper" Version="14.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Mvc.NewtonsoftJson" Version="8.0.33" />
  </ItemGroup>

</Project>
```

`Legacy.Api/Program.cs`

```csharp
namespace Legacy.Api;

// The pre-.NET 6 hosting model: an explicit Main, a host builder, and a Startup class.
public class Program
{
    public static void Main(string[] args) => CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureWebHostDefaults(web => web.UseStartup<Startup>());
}
```

`Legacy.Api/Startup.cs`

```csharp
using Legacy.Api.Data;
using Legacy.Api.Filters;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;

namespace Legacy.Api;

public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;

    public IConfiguration Configuration { get; }

    // 1. DI registrations (what becomes builder.Services.* in minimal hosting)
    public void ConfigureServices(IServiceCollection services)
    {
        services
            .AddControllers(options => options.Filters.Add<ApiExceptionFilter>())
            .AddNewtonsoftJson(options =>
            {
                options.SerializerSettings.Converters.Add(new StringEnumConverter());
                options.SerializerSettings.NullValueHandling = NullValueHandling.Ignore;
            });

        services.AddAutoMapper(typeof(Startup));          // scans this assembly for Profile classes
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IOrderRepository, InMemoryOrderRepository>();
    }

    // 2. The middleware pipeline (what comes after builder.Build() in minimal hosting)
    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
            app.UseDeveloperExceptionPage();

        app.UseRouting();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

`Legacy.Api/Domain/Order.cs`

```csharp
namespace Legacy.Api.Domain;

public enum OrderStatus { Pending, Paid, Shipped, Cancelled }

public class Customer
{
    public string Name { get; set; }
    public string Email { get; set; }
}

public class OrderLine
{
    public string Sku { get; set; }
    public int Quantity { get; set; }
    public decimal UnitPrice { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public Customer Customer { get; set; }
    public OrderStatus Status { get; set; }
    public List<OrderLine> Lines { get; set; }   // null for orders imported from the old system!
    public string Notes { get; set; }
    public DateTime CreatedAtUtc { get; set; }

    public void Cancel()
    {
        if (Status == OrderStatus.Shipped)
            throw new InvalidOperationException("Shipped orders cannot be cancelled.");
        Status = OrderStatus.Cancelled;
    }
}
```

`Legacy.Api/Dtos/OrderDtos.cs`

```csharp
using System.ComponentModel.DataAnnotations;
using Legacy.Api.Domain;

namespace Legacy.Api.Dtos;

public class OrderDto
{
    public int Id { get; set; }
    public string CustomerName { get; set; }      // AutoMapper flattens Customer.Name by convention
    public OrderStatus Status { get; set; }
    public int LinesCount { get; set; }           // ...and Lines.Count
    public decimal Total { get; set; }
    public string Notes { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public List<OrderLineDto> Lines { get; set; }
}

public class OrderLineDto
{
    public string Sku { get; set; }
    public int Quantity { get; set; }
    public decimal UnitPrice { get; set; }
    public decimal LineTotal { get; set; }
}

public class CreateOrderRequest
{
    [Required] public string CustomerName { get; set; }
    [Required, EmailAddress] public string CustomerEmail { get; set; }
    [Required, MinLength(1)] public List<CreateOrderLine> Lines { get; set; }
    public string Notes { get; set; }
}

public class CreateOrderLine
{
    [Required] public string Sku { get; set; }
    [Range(1, 100)] public int Quantity { get; set; }
    [Range(0.01, 100_000)] public decimal UnitPrice { get; set; }
}
```

`Legacy.Api/Mapping/OrderProfile.cs`

```csharp
using AutoMapper;
using Legacy.Api.Domain;
using Legacy.Api.Dtos;

namespace Legacy.Api.Mapping;

// Read side: entity -> DTO
public class OrderProfile : Profile
{
    public OrderProfile()
    {
        CreateMap<Order, OrderDto>()
            .ForMember(d => d.Total, o => o.MapFrom(s => s.Lines.Sum(l => l.Quantity * l.UnitPrice)));

        CreateMap<OrderLine, OrderLineDto>()
            .ForMember(d => d.LineTotal, o => o.MapFrom(s => s.Quantity * s.UnitPrice));
    }
}
```

`Legacy.Api/Mapping/CreateOrderProfile.cs`

```csharp
using AutoMapper;
using Legacy.Api.Domain;
using Legacy.Api.Dtos;

namespace Legacy.Api.Mapping;

// Write side: request -> entity
public class CreateOrderProfile : Profile
{
    public CreateOrderProfile()
    {
        CreateMap<CreateOrderRequest, Order>()
            .ForMember(d => d.Id, o => o.Ignore())
            .ForMember(d => d.Status, o => o.Ignore())
            .ForMember(d => d.CreatedAtUtc, o => o.Ignore())
            .ForMember(d => d.Customer, o => o.MapFrom(s => new Customer { Name = s.CustomerName, Email = s.CustomerEmail }));

        CreateMap<CreateOrderLine, OrderLine>();
    }
}
```

`Legacy.Api/Data/InMemoryOrderRepository.cs`

```csharp
using System.Collections.Concurrent;
using Legacy.Api.Domain;

namespace Legacy.Api.Data;

public interface IOrderRepository
{
    IEnumerable<Order> All();
    Order Find(int id);
    void Add(Order order);
}

// Stands in for the EF Core repository of a real app, so the lab needs no database.
public class InMemoryOrderRepository : IOrderRepository
{
    private readonly ConcurrentDictionary<int, Order> _orders = new();
    private int _nextId;

    public InMemoryOrderRepository()
    {
        Add(new Order
        {
            Customer = new Customer { Name = "Ada Lovelace", Email = "ada@example.com" },
            Status = OrderStatus.Paid,
            Notes = "Gift wrap",
            CreatedAtUtc = new DateTime(2024, 3, 1, 10, 0, 0, DateTimeKind.Utc),
            Lines =
            [
                new OrderLine { Sku = "BOOK-1", Quantity = 2, UnitPrice = 9.99m },
                new OrderLine { Sku = "PEN-7", Quantity = 1, UnitPrice = 25.00m },
            ],
        });
        Add(new Order
        {
            Customer = new Customer { Name = "Grace Hopper", Email = "grace@example.com" },
            Status = OrderStatus.Shipped,
            CreatedAtUtc = new DateTime(2024, 3, 2, 8, 30, 0, DateTimeKind.Utc),
            Lines = [new OrderLine { Sku = "MUG-3", Quantity = 3, UnitPrice = 4.50m }],
        });
        Add(new Order   // imported from the old system: no lines were migrated
        {
            Customer = new Customer { Name = "Linus Torvalds", Email = "linus@example.com" },
            Status = OrderStatus.Pending,
            CreatedAtUtc = new DateTime(2019, 12, 24, 0, 0, 0, DateTimeKind.Utc),
            Lines = null,
        });
    }

    public IEnumerable<Order> All() => _orders.Values.OrderBy(o => o.Id);

    public Order Find(int id) => _orders.TryGetValue(id, out var order) ? order : null;

    public void Add(Order order)
    {
        order.Id = Interlocked.Increment(ref _nextId);
        _orders[order.Id] = order;
    }
}
```

`Legacy.Api/Filters/ApiExceptionFilter.cs`

```csharp
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Legacy.Api.Filters;

// Turns domain exceptions thrown by controller actions into ProblemDetails responses.
public class ApiExceptionFilter : IExceptionFilter
{
    public void OnException(ExceptionContext context)
    {
        var (status, title) = context.Exception switch
        {
            KeyNotFoundException => (StatusCodes.Status404NotFound, "Not found"),
            InvalidOperationException => (StatusCodes.Status409Conflict, "Conflict"),
            _ => (0, null),
        };
        if (status == 0) return;   // not ours: let it bubble up to the middleware

        context.Result = new ObjectResult(new ProblemDetails
        {
            Status = status,
            Title = title,
            Detail = context.Exception.Message,
        })
        { StatusCode = status };
        context.ExceptionHandled = true;
    }
}
```

`Legacy.Api/Controllers/OrdersController.cs`

```csharp
using AutoMapper;
using Legacy.Api.Data;
using Legacy.Api.Domain;
using Legacy.Api.Dtos;
using Microsoft.AspNetCore.Mvc;

namespace Legacy.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly IOrderRepository _orders;
    private readonly IMapper _mapper;
    private readonly TimeProvider _clock;

    public OrdersController(IOrderRepository orders, IMapper mapper, TimeProvider clock)
    {
        _orders = orders;
        _mapper = mapper;
        _clock = clock;
    }

    [HttpGet]
    public ActionResult<List<OrderDto>> List([FromQuery] OrderStatus? status)
    {
        var orders = _orders.All().Where(o => status == null || o.Status == status);
        return _mapper.Map<List<OrderDto>>(orders);
    }

    [HttpGet("{id:int}")]
    public ActionResult<OrderDto> Get(int id)
    {
        var order = _orders.Find(id);
        if (order == null) return NotFound();
        return _mapper.Map<OrderDto>(order);
    }

    [HttpPost]
    public ActionResult<OrderDto> Create(CreateOrderRequest request)
    {
        var order = _mapper.Map<Order>(request);
        order.Status = OrderStatus.Pending;
        order.CreatedAtUtc = _clock.GetUtcNow().UtcDateTime;
        _orders.Add(order);

        return CreatedAtAction(nameof(Get), new { id = order.Id }, _mapper.Map<OrderDto>(order));
    }

    [HttpPost("{id:int}/cancel")]
    public IActionResult Cancel(int id)
    {
        var order = _orders.Find(id) ?? throw new KeyNotFoundException($"Order {id} does not exist.");
        order.Cancel();   // throws InvalidOperationException for shipped orders
        return NoContent();
    }
}
```

Before writing any test, **read it like a newcomer**, using the order from this lesson: csproj
(packages → AutoMapper, Newtonsoft), `Program` (Startup model), `ConfigureServices` (a global exception
filter, enum-as-string and ignore-nulls JSON settings, assembly scanning for profiles), `Configure`
(middleware order), then one request through the controller.

**3. The test project**

`Legacy.Api.Tests/Legacy.Api.Tests.csproj`

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="8.0.33" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.11.0" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\Legacy.Api\Legacy.Api.csproj" />
  </ItemGroup>

</Project>
```

`Legacy.Api.Tests/LegacyApiFactory.cs`: boots the real app with a frozen clock

```csharp
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Legacy.Api.Tests;

// Boots the real app (Program -> Startup) in memory, with a frozen clock so output is repeatable.
public class LegacyApiFactory : WebApplicationFactory<Program>
{
    public static readonly DateTimeOffset Now = new(2026, 1, 15, 9, 30, 0, TimeSpan.Zero);

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.ConfigureServices(services =>
            services.Replace(ServiceDescriptor.Singleton<TimeProvider>(new FixedClock(Now))));

    private sealed class FixedClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
```

`WebApplicationFactory<Program>` works with the old `Main` + `CreateHostBuilder` model too. It finds the
entry point and intercepts the host it builds.

**4. Write the characterization tests**

The workflow for each test: write it with an empty expected string, run it, copy the **Actual** value
from the failure message into the assertion, run again. Then read the pinned output and ask "is anything
here surprising?" The comments mark the surprises worth noticing. Here is the finished file:

`Legacy.Api.Tests/OrdersCharacterizationTests.cs`

```csharp
using System.Net;
using System.Text;
using System.Text.Json;

namespace Legacy.Api.Tests;

// Characterization tests: they pin what the API DOES today (byte for byte where it matters),
// not what we think it should do. Any refactor or upgrade that changes a response fails here.
public class OrdersCharacterizationTests : IDisposable
{
    // A new factory per test: every test starts with the same three seeded orders.
    private readonly LegacyApiFactory _factory = new();
    private readonly HttpClient _client;

    public OrdersCharacterizationTests() => _client = _factory.CreateClient();

    public void Dispose() => _factory.Dispose();

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    [Fact]
    public async Task Get_order_returns_the_exact_legacy_json()
    {
        var body = await _client.GetStringAsync("/api/orders/1");

        Assert.Equal(
            """{"id":1,"customerName":"Ada Lovelace","status":"Paid","linesCount":2,"total":44.98,"notes":"Gift wrap","createdAtUtc":"2024-03-01T10:00:00Z","lines":[{"sku":"BOOK-1","quantity":2,"unitPrice":9.99,"lineTotal":19.98},{"sku":"PEN-7","quantity":1,"unitPrice":25.00,"lineTotal":25.00}]}""",
            body);
    }

    [Fact]
    public async Task Imported_order_with_null_lines_maps_to_empty_list_and_zero_total()
    {
        var body = await _client.GetStringAsync("/api/orders/3");

        // Quirks worth pinning: "notes" is omitted (NullValueHandling.Ignore), lines is [] not null,
        // and Newtonsoft writes a zero decimal as 0.0.
        Assert.Equal(
            """{"id":3,"customerName":"Linus Torvalds","status":"Pending","linesCount":0,"total":0.0,"createdAtUtc":"2019-12-24T00:00:00Z","lines":[]}""",
            body);
    }

    [Fact]
    public async Task Status_filter_is_case_insensitive()
    {
        var body = await _client.GetStringAsync("/api/orders?status=shipped");

        Assert.Equal(
            """[{"id":2,"customerName":"Grace Hopper","status":"Shipped","linesCount":1,"total":13.50,"createdAtUtc":"2024-03-02T08:30:00Z","lines":[{"sku":"MUG-3","quantity":3,"unitPrice":4.50,"lineTotal":13.50}]}]""",
            body);
    }

    [Fact]
    public async Task Unknown_order_is_404_problem_details()
    {
        var response = await _client.GetAsync("/api/orders/99");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType!.MediaType);
    }

    [Fact]
    public async Task Create_returns_201_with_location_and_mapped_body()
    {
        var response = await _client.PostAsync("/api/orders", Json(
            """{"customerName":"Margaret Hamilton","customerEmail":"mh@example.com","lines":[{"sku":"TAPE-9","quantity":2,"unitPrice":1.5}]}"""));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal("/api/orders/4", response.Headers.Location!.AbsolutePath);
        Assert.Equal(
            """{"id":4,"customerName":"Margaret Hamilton","status":"Pending","linesCount":1,"total":3.0,"createdAtUtc":"2026-01-15T09:30:00Z","lines":[{"sku":"TAPE-9","quantity":2,"unitPrice":1.5,"lineTotal":3.0}]}""",
            await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Invalid_create_is_an_automatic_400_with_pascal_case_keys()
    {
        var response = await _client.PostAsync("/api/orders", Json(
            """{"customerName":"","customerEmail":"nope","lines":[{"sku":"X","quantity":0,"unitPrice":1}]}"""));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var keys = doc.RootElement.GetProperty("errors").EnumerateObject().Select(p => p.Name).Order();
        Assert.Equal(["CustomerEmail", "CustomerName", "Lines[0].Quantity"], keys);
    }

    [Fact]
    public async Task Lenient_json_is_accepted_trailing_comma_and_quoted_number()
    {
        // Newtonsoft accepts this; System.Text.Json (by default) would reject it with a 400.
        // Mobile app v1.2 sends exactly this shape, so it must keep working.
        var response = await _client.PostAsync("/api/orders", Json(
            """{"customerName":"Old Client","customerEmail":"old@example.com","lines":[{"sku":"X","quantity":"2","unitPrice":1},],}"""));

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Cancelling_a_shipped_order_is_409_from_the_exception_filter()
    {
        var response = await _client.PostAsync("/api/orders/2/cancel", null);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(
            """{"title":"Conflict","status":409,"detail":"Shipped orders cannot be cancelled."}""",
            await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Cancelling_an_unknown_order_is_404_from_the_exception_filter()
    {
        var response = await _client.PostAsync("/api/orders/99/cancel", null);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(
            """{"title":"Not found","status":404,"detail":"Order 99 does not exist."}""",
            await response.Content.ReadAsStringAsync());
    }
}
```

`Legacy.Api.Tests/MappingConfigurationTests.cs`

```csharp
using AutoMapper;

namespace Legacy.Api.Tests;

public class MappingConfigurationTests
{
    // Fails if any destination member has no source (e.g. someone renamed a property).
    [Fact]
    public void AutoMapper_configuration_is_valid()
    {
        var config = new MapperConfiguration(cfg => cfg.AddMaps(typeof(Program).Assembly));
        config.AssertConfigurationIsValid();
    }
}
```

**5. Baseline on .NET 8**

```bash
dotnet sln add Legacy.Api Legacy.Api.Tests
dotnet new gitignore
dotnet test
```

```text
Legacy.Api/Legacy.Api.csproj : warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability, https://github.com/advisories/GHSA-rvv3-g6hj-g44x
...
Passed!  - Failed:     0, Passed:    10, Skipped:     0, Total:    10, Duration: 450 ms - Legacy.Api.Tests.dll (net8.0)
```

:::tip title="No ASP.NET Core 8 runtime?"
Run the baseline in the .NET 8 SDK container. The folder is mounted read-only and copied inside, so the
container's build output never mixes with your machine's `bin/` and `obj/` folders:

```bash
docker run --rm -v "$PWD":/src:ro mcr.microsoft.com/dotnet/sdk:8.0 \
  bash -c 'cp -r /src /work && cd /work && rm -rf */bin */obj && dotnet test Legacy.Api.Tests'
# podman works the same; on SELinux systems (Fedora, RHEL) write -v "$PWD":/src:ro,Z
```

```text
Passed!  - Failed:     0, Passed:    10, Skipped:     0, Total:    10, Duration: 290 ms - Legacy.Api.Tests.dll (net8.0)
```

As a last resort, `DOTNET_ROLL_FORWARD=Major dotnet test` runs the `net8.0` build on the .NET 10 runtime.
Then you're characterizing .NET 10's framework behaviour, not 8's. For a real upgrade, run the baseline on
the version that's in production.
:::

Note the `NU1903` warning, then look at the whole dependency graph:

```bash
dotnet list package --vulnerable --include-transitive
dotnet list Legacy.Api package --outdated
```

```text
Project `Legacy.Api.Tests` has the following vulnerable packages
   [net8.0]:
   Transitive Package      Resolved   Severity   Advisory URL
   > AutoMapper            14.0.0     High       https://github.com/advisories/GHSA-rvv3-g6hj-g44x
...
   Top-level Package                              Requested   Resolved   Latest
   > AutoMapper                                   14.0.0      14.0.0     16.3.0
   > Microsoft.AspNetCore.Mvc.NewtonsoftJson      8.0.33      8.0.33     10.0.14
```

"Latest 16.3.0" looks like an easy fix, but it's a commercially licensed major version. That's a
business decision, not a `dotnet add package`. Commit now (`git init && git add . && git commit -m
"Baseline: characterization tests"`) so every later step is a reviewable diff.

**6. Upgrade to .NET 10**: one mechanical change

In **both** `.csproj` files change `net8.0` → `net10.0`. In `Legacy.Api.csproj` change
`Microsoft.AspNetCore.Mvc.NewtonsoftJson` to `10.0.14`, and in the test project change
`Microsoft.AspNetCore.Mvc.Testing` to `10.0.14`. Leave AutoMapper alone: one change at a time.

```bash
dotnet build
dotnet test
```

```text
Legacy.Api/Legacy.Api.csproj : warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability, ...
Legacy.Api.Tests/Legacy.Api.Tests.csproj : warning NU1903: Package 'AutoMapper' 14.0.0 has a known high severity vulnerability, ...
...
Passed!  - Failed:     0, Passed:    10, Skipped:     0, Total:    10, Duration: 390 ms - Legacy.Api.Tests.dll (net10.0)
```

The build reports no obsoletion warnings: `Host.CreateDefaultBuilder` + `UseStartup` is still supported.
The test project now reports `NU1903` too, because the .NET 10 SDK audits transitive packages. All ten
characterization tests pass, which means **no observable behaviour changed**. That one sentence is what
makes the upgrade PR easy to approve. Commit.

**7. Replace `OrderProfile` with explicit mapping**

Delete `Legacy.Api/Mapping/OrderProfile.cs` and create `Legacy.Api/Mapping/OrderMappings.cs`:

```csharp
using Legacy.Api.Domain;
using Legacy.Api.Dtos;

namespace Legacy.Api.Mapping;

// Replaces OrderProfile. Every rule AutoMapper applied implicitly is now a visible line of code.
public static class OrderMappings
{
    public static OrderDto ToDto(this Order order) => new()
    {
        Id = order.Id,
        CustomerName = order.Customer?.Name,                        // was: flattening by convention (null-safe)
        Status = order.Status,
        LinesCount = order.Lines?.Count ?? 0,                       // was: flattening Lines.Count
        Total = order.Lines?.Sum(l => l.Quantity * l.UnitPrice) ?? 0m,  // was: MapFrom (null-safe!)
        Notes = order.Notes,
        CreatedAtUtc = order.CreatedAtUtc,
        Lines = order.Lines?.Select(ToDto).ToList() ?? [],          // was: null collection -> empty list
    };

    public static OrderLineDto ToDto(this OrderLine line) => new()
    {
        Sku = line.Sku,
        Quantity = line.Quantity,
        UnitPrice = line.UnitPrice,
        LineTotal = line.Quantity * line.UnitPrice,
    };
}
```

In `OrdersController.cs`, add `using Legacy.Api.Mapping;` and replace the three read-side
`_mapper.Map<…>` calls. `Create` keeps using AutoMapper for the request → entity direction, because
`CreateOrderProfile` stays for now:

```csharp
    [HttpGet]
    public ActionResult<List<OrderDto>> List([FromQuery] OrderStatus? status)
    {
        var orders = _orders.All().Where(o => status == null || o.Status == status);
        return orders.Select(o => o.ToDto()).ToList();
    }

    [HttpGet("{id:int}")]
    public ActionResult<OrderDto> Get(int id)
    {
        var order = _orders.Find(id);
        if (order == null) return NotFound();
        return order.ToDto();
    }

    [HttpPost]
    public ActionResult<OrderDto> Create(CreateOrderRequest request)
    {
        var order = _mapper.Map<Order>(request);
        order.Status = OrderStatus.Pending;
        order.CreatedAtUtc = _clock.GetUtcNow().UtcDateTime;
        _orders.Add(order);

        return CreatedAtAction(nameof(Get), new { id = order.Id }, order.ToDto());
    }
```

```bash
dotnet test
```

```text
Passed!  - Failed:     0, Passed:    10, Skipped:     0, Total:    10, Duration: 350 ms - Legacy.Api.Tests.dll (net10.0)
```

`AutoMapper_configuration_is_valid` still passes: it now validates only `CreateOrderProfile`.

Now **break it on purpose** to see the safety net work. Change the `Lines` line to the "obvious"
version, `Lines = order.Lines.Select(ToDto).ToList(),`, and run `dotnet test`:

```text
[xUnit.net 00:00:00.53]     Legacy.Api.Tests.OrdersCharacterizationTests.Imported_order_with_null_lines_maps_to_empty_list_and_zero_total [FAIL]
   System.Net.Http.HttpRequestException : Response status code does not indicate success: 500 (Internal Server Error).
Failed!  - Failed:     1, Passed:     9, Skipped:     0, Total:    10
```

That's the legacy order with `Lines = null`. AutoMapper silently turned it into `[]`, and the naive
rewrite crashes. Without the characterization test this would have shipped. Put the `?.` and `?? []` back.

**8. Optional: the next PRs, each guarded by the same tests**

- **Minimal hosting.** Replace `Program.cs` with the version below (keep `Startup.cs`). Tests: 10 passed.

  ```csharp
  using Legacy.Api;

  // Step 1 of a Startup -> minimal hosting migration: same Startup, new host.
  var builder = WebApplication.CreateBuilder(args);

  var startup = new Startup(builder.Configuration);
  startup.ConfigureServices(builder.Services);

  var app = builder.Build();
  startup.Configure(app, app.Environment);

  app.Run();
  ```

- **Nullable.** Set `<Nullable>enable</Nullable>` in `Legacy.Api.csproj`. You get 18 warnings, and three
  tests fail (`Create_returns_201…`, `Lenient_json…`, `Invalid_create…`, now with an extra `Notes`
  key), because `CreateOrderRequest.Notes` became implicitly required. Change it to `public string? Notes`
  and the tests go green. That's the trap from the warning above, caught by a test instead of a client.
- **System.Text.Json.** Replace `.AddNewtonsoftJson(...)` with
  `.AddJsonOptions(o => { o.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter()); o.JsonSerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull; })`
  (namespace `System.Text.Json.Serialization`). Two tests fail: the trailing-comma request now gets a 400,
  and `"total":0.0` became `"total":0`. Each failure is a contract decision to make with the API's
  clients. Revert, or set `AllowTrailingCommas = true` and agree on the number format.

- [ ] I read the app in the order from this lesson before writing tests, and can explain what `ConfigureServices` and `Configure` set up
- [ ] On `net8.0`, `dotnet test` reports 10 passed, and I can explain the `NU1903` warning and why "Latest 16.3.0" isn't a free fix
- [ ] After bumping both projects and the Microsoft packages to 10.x, the build has no new warnings except `NU1903` and `dotnet test` still reports 10 passed
- [ ] `OrderProfile.cs` is deleted, `OrderMappings.ToDto()` is used for all responses, and the 10 tests pass
- [ ] I removed the null handling on purpose, watched `Imported_order_with_null_lines…` fail with a 500, and restored it
- [ ] (Optional) I tried at least one step from 8 and saw which characterization tests caught the behaviour change
:::

:::job title="Your first month on a legacy codebase"
Teams don't expect a newcomer to modernize anything in week one. They expect you to **ship small
changes without breaking things** and to learn why the code looks the way it does. A pattern that earns
trust fast: pick up the .NET upgrade ticket nobody wants, add characterization tests for the endpoints
you touch, and make the upgrade PR boring: framework and packages only, "10/10 characterization tests
unchanged" in the description. Keep a notes file of every surprise you find (hidden filters,
`ConfigureDevelopmentServices`, AutoMapper quirks). It becomes the onboarding doc for the next hire.
:::

:::pro title="How seniors sequence a modernization"
Seniors write the order down before touching code: (1) tests that pin behaviour, (2) the runtime upgrade,
(3) removals that reduce risk (vulnerable or unlicensed packages), (4) structural changes (hosting model,
serializer, mapping), and only then (5) new patterns for new features. They also follow the **boy-scout
rule** for structure: new endpoints may be minimal APIs or vertical slices, but existing controllers are
only rewritten when a feature forces the change. Two styles side by side for a while are fine, as long as
the README says which one is the direction.
:::

## Flashcards

:::cards id=be-22-cards1 xp=20 title="Inherited .NET codebases"
Q: In what order do you read a solution you didn't write?
A: Solution/projects → global.json, Directory.Build.props → web csproj (packages) → Program/Startup (DI + middleware order) → DI extension methods → appsettings → Dockerfile/CI/K8s → tests. Then trace one request end to end.
Q: Configuration precedence in ASP.NET Core (lowest → highest)?
A: appsettings.json → appsettings.{Environment}.json → user secrets (Development only) → environment variables (`__` = `:`) → command line. launchSettings.json is only used by `dotnet run`/VS locally.
Q: `Startup.ConfigureServices` and `Startup.Configure` in minimal hosting?
A: `ConfigureServices` = `builder.Services.…` before `Build()`. `Configure` = `app.Use…/Map…` after `Build()`. Routing and endpoints are implicit in `WebApplication`.
Q: What does `UseStartup<Startup>()` do that a hand-written `new Startup(...).ConfigureServices(...)` shim doesn't?
A: Environment-specific methods (`ConfigureDevelopmentServices`, `ConfigureStaging`), DI-injected extra `Configure` parameters, and `ConfigureContainer` (Autofac). Check for them before switching to the shim.
Q: Four things `[ApiController]` does?
A: Requires attribute routing; automatic 400 ValidationProblemDetails when ModelState is invalid (the action doesn't run); infers binding sources ([FromBody] for complex types!); ProblemDetails bodies for error status codes.
Q: Why does a GET action with a complex parameter return 415 under `[ApiController]`?
A: Complex types are inferred as `[FromBody]`; a GET has no JSON body. Add `[FromQuery]`.
Q: `ActionResult<T>` vs `IActionResult`?
A: `ActionResult<T>` returns either `T` (200) or any ActionResult, and OpenAPI knows `T`. It doesn't convert from an interface-typed value; return a concrete type or `Ok(x)`.
Q: MVC filter types in pipeline order?
A: Authorization → Resource → (model binding) → Action → action method → Exception (for binding/action errors) → Result.
Q: When a filter, when middleware?
A: Middleware for every-request HTTP concerns (errors, CORS, auth, logging). Filters when you need MVC context: action metadata, bound arguments, ModelState, the IActionResult.
Q: Why can't a filter attribute take services in its constructor, and what do you use instead?
A: Attribute arguments must be compile-time constants. Use `[ServiceFilter(typeof(F))]` (F registered in DI) or `[TypeFilter(typeof(F))]`.
Q: Three AutoMapper behaviours a manual rewrite must reproduce or consciously change?
A: Convention flattening (`Customer.Name` → `CustomerName`), null-safe `MapFrom` member chains (no exception, default value), null source collections → empty lists.
Q: What does `AssertConfigurationIsValid()` catch?
A: Destination members without a source or explicit configuration, such as after a rename. Without it, those are silently null/default at runtime.
Q: Why is MediatR's `Publish` not a substitute for a queue?
A: Handlers run in-process, sequentially by default; the first exception stops the rest and fails the request. No retries, no durability. Use an outbox or durable queue.
Q: Most common repository/unit-of-work bug over EF Core?
A: Repositories calling `SaveChanges` themselves, so a use case commits in pieces. Stage changes in repositories; save once per use case.
Q: Three Newtonsoft → System.Text.Json differences that silently change behaviour?
A: Newtonsoft attributes (`[JsonProperty]`) are ignored by STJ; STJ rejects trailing commas/comments; bare `JsonSerializer.Deserialize` is case-sensitive (web defaults aren't). Also: fields ignored, cycles throw, `0.0` vs `0`.
Q: What is a characterization test?
A: A test that pins what code does **today** (including bugs), by running it and pasting the actual output into the assertion. It's the safety net for upgrades and refactors.
Q: The safe .NET 8 → 10 upgrade PR contains…?
A: TFM, global.json, CI SDK and Docker images, matching Microsoft.* package versions, fixes needed to compile. Nothing else. Read 9's and 10's breaking changes first.
Q: Why does enabling `<Nullable>` change API behaviour?
A: MVC treats non-nullable reference properties on request DTOs as implicitly `[Required]`. Optional fields must become `string?`.
Q: Why do new NU1903 warnings appear after moving to `net10.0`?
A: The .NET 10 SDK's NuGet audit checks transitive packages by default for net10.0 projects.
:::

## Recap

- Read an inherited app through its decision points: projects, shared build files, packages,
  `Program`/`Startup` (DI and **middleware order**), DI extension methods, configuration layers, deployment
  files and tests. Then trace one request end to end.
- `Startup.ConfigureServices` is `builder.Services`, `Startup.Configure` is everything after `Build()`. The
  `Startup` model still runs on .NET 10, so migrating it is optional and goes in its own PR.
- `[ApiController]` short-circuits invalid input with automatic 400s, infers `[FromBody]` for complex types
  (415 on GETs) and turns error results into ProblemDetails. `ActionResult<T>` is the typed return.
- MVC filters run only around controller actions and see MVC context. Middleware sees every request. Exception
  filters miss everything outside the action pipeline.
- AutoMapper, MediatR and repository/unit-of-work layers each hide behaviour: silent mappings and null magic,
  hidden call graphs and sequential notifications, scattered `SaveChanges` and full-column updates. Keep them
  while they serve the team, remove them one profile or feature at a time, and weigh licensing and the
  AutoMapper ≤ 14 CVE.
- Newtonsoft → System.Text.Json is a **contract change**: attributes, leniency, casing and number formats differ.
- **Characterization tests first.** Pin real responses byte for byte, including quirks and bugs, at the HTTP
  seam. Then upgrade, then refactor, and prove each step with the same green tests.
- .NET 8 and 9 leave support on November 10, 2026. Go straight to .NET 10 with a mechanical PR (TFM, SDK,
  images, packages), read every skipped version's breaking changes, and treat new warnings, nullable
  enablement and serializer switches as separate, test-guarded steps.
