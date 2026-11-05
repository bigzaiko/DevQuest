---
id: be-08
title: Dependency Injection & Configuration
level: intermediate
minutes: 45
xp: 150
summary: How the DI container builds your services, singleton vs scoped vs transient and the captive dependency bug, configuration sources and precedence, the options pattern with validation, and environments.
---

Open any ASP.NET Core codebase and the first thing you'll see in `Program.cs` is a wall of
`builder.Services.Add…()` calls and some `builder.Configuration` reads. This lesson explains what
the container actually does with those registrations, how to pick a lifetime (and the classic bug when
you pick wrong), and how configuration flows from JSON files, secrets and environment variables into
strongly typed, validated options.

## Why dependency injection?

Compare two versions of a service:

```csharp
// ❌ Creates its own dependencies
public class CheckoutService
{
    private readonly StripeClient _stripe = new("sk_live_…");      // hard-coded, untestable
    private readonly SmtpEmailSender _email = new("smtp.company.com");

    public async Task CheckoutAsync(Cart cart) { /* … */ }
}

// ✅ Asks for its dependencies
public sealed class CheckoutService(IPaymentGateway payments, IEmailSender email, TimeProvider clock)
{
    public async Task CheckoutAsync(Cart cart, CancellationToken ct) { /* … */ }
}
```

The second version doesn't know or care **which** payment gateway it gets. In production it's Stripe;
in tests it's a fake that records calls; next year it might be Adyen. That's **inversion of control**:
the class declares what it needs, and something else — the **DI container** — builds and supplies it.

What the container gives you:

- **Construction**: it reads constructor parameters and recursively builds the whole object graph.
- **Lifetime management**: it decides when to create new instances and when to reuse them.
- **Disposal**: it calls `Dispose()` on services it created when their lifetime ends.
- **One place to wire things**: swapping an implementation is a one-line change in `Program.cs` (or in
  a test).

## Registering services

```csharp
builder.Services.AddSingleton<IClock, SystemClock>();          // interface → implementation
builder.Services.AddScoped<IOrderRepository, OrderRepository>();
builder.Services.AddTransient<PdfRenderer>();                   // concrete type only
builder.Services.AddSingleton(TimeProvider.System);             // an existing instance
builder.Services.AddScoped<IPaymentGateway>(sp =>               // a factory
    new StripeGateway(sp.GetRequiredService<IOptions<StripeOptions>>().Value.ApiKey));
```

And consuming them — always through the **constructor** (or a minimal API handler parameter):

```csharp
public sealed class OrderService(IOrderRepository orders, IClock clock, ILogger<OrderService> logger) { … }

app.MapPost("/orders", (CreateOrder cmd, OrderService service, CancellationToken ct) => service.PlaceAsync(cmd, ct));
```

`OrderService(…)` uses a C# 12 **primary constructor**: the parameters are in scope for the whole
class, so there's no field-plus-assignment boilerplate. One gotcha: those captured parameters are
*not* `readonly` — code can reassign `orders` by accident. Teams that care assign them to
`private readonly` fields explicitly, or rely on an analyzer.

The minimal API handler shows the same idea without a class: `OrderService service` is resolved from
DI for each request, `CreateOrder cmd` from the JSON body, `CancellationToken ct` from the request.

A few more registration tools you'll meet:

- **Multiple implementations**: register several `INotificationChannel`s and inject
  `IEnumerable<INotificationChannel>` to get all of them. Injecting a single `INotificationChannel`
  gives you the **last** registered.
- **`TryAdd…`**: register only if nothing is registered yet — libraries use it so apps can override.
- **Keyed services** (.NET 8+): `AddKeyedSingleton<IStorage, S3Storage>("s3")` and inject with
  `[FromKeyedServices("s3")] IStorage storage`.
- **Extension methods** to group registrations: `builder.Services.AddCatalog(builder.Configuration);`
  is how libraries (`AddDbContext`, `AddOpenApi`) and well-organised apps do it.

:::warn title="Service locator is an anti-pattern"
Avoid injecting `IServiceProvider` and calling `GetService<T>()` inside business code. It hides
dependencies (the constructor no longer tells the truth), defeats compile-time checking, and makes tests
painful. The legitimate exceptions are framework-style code — factories, middleware plumbing, and
creating scopes in background services (below).
:::

## Lifetimes: singleton, scoped, transient

| Lifetime | One instance per… | Typical services |
|---|---|---|
| **Singleton** | Application (created once, shared by all requests and threads) | Caches, `TimeProvider`, configuration/options, `HttpClient` factories, stateless helpers |
| **Scoped** | Scope — in ASP.NET Core, **one HTTP request** | `DbContext`, repositories, unit of work, "current user" context |
| **Transient** | Every time it's requested (every injection) | Lightweight, stateless services; things with per-use state |

```text
Request A ─┬─ OrderService (transient #1) ──► DbContext (scoped A) ──► TimeProvider (singleton)
           └─ AuditService (transient #2) ──► DbContext (scoped A) ──► TimeProvider (singleton)
Request B ─── OrderService (transient #3) ──► DbContext (scoped B) ──► TimeProvider (singleton)
```

Within request A, both services share **the same** `DbContext` — so changes made by one are saved by
the other in one transaction. Request B gets its own. Everyone shares the singleton.

What exactly is a **scope**? A scope is a child container with its own cache of scoped instances.
ASP.NET Core creates one when a request arrives (`HttpContext.RequestServices`) and disposes it — and
every scoped and transient `IDisposable` it created — when the response is done. Outside a request (a
`BackgroundService`, a console app, a unit test) **there is no scope** unless you create one with
`IServiceScopeFactory.CreateScope()`; that's why "scoped" really means "per scope", not "per request".

Rules of thumb:

- **Singletons must be thread-safe**: many requests use them at the same time. No mutable fields
  without locks/`Interlocked`/concurrent collections.
- **Scoped is the default for anything touching the database or the current request.**
- **Transient** is fine for cheap stateless services, but don't make `IDisposable` heavyweights
  transient: the container must remember every disposable it creates so it can dispose it later, so
  each one stays alive until its scope ends. Resolved from the **root** provider (e.g. inside a
  singleton factory), "until the scope ends" means "until the app shuts down" — a slow memory leak.

## The captive dependency bug

A service can safely depend on services that live **as long or longer** than itself. The bug is the
reverse: a **singleton that depends on a scoped service**.

```csharp
builder.Services.AddScoped<AppDbContext>();          // via AddDbContext
builder.Services.AddSingleton<ProductCache>();       // ❌ takes AppDbContext in its constructor

public sealed class ProductCache(AppDbContext db)     // this db is "captured" forever
{
    public Task<List<Product>> GetAsync() => db.Products.ToListAsync();
}
```

The singleton is created once, with the `DbContext` of whichever request happened to come first. That
`DbContext` is now **captive**: it never gets disposed with its request, it's used by many threads at
once (`DbContext` isn't thread-safe), and its change tracker grows forever. Symptoms in production:
`ObjectDisposedException`, "a second operation was started on this context", stale data, memory leaks
— intermittent, under load, impossible to reproduce locally.

**Scope validation** catches it. In the `Development` environment ASP.NET Core turns on
`ValidateScopes` and `ValidateOnBuild`, so the app fails at startup:

```text
System.AggregateException: Some services are not able to be constructed
 (Error while validating the service descriptor 'ServiceType: ProductCache Lifetime: Singleton ...':
  Cannot consume scoped service 'AppDbContext' from singleton 'ProductCache'.)
```

Fixes, in order of preference:

1. **Make the consumer scoped** (or transient) if it doesn't need to be a singleton.
2. If it must be a singleton (a cache, a background service), inject **`IServiceScopeFactory`** and
   create a short-lived scope per operation:

```csharp
public sealed class ProductCache(IServiceScopeFactory scopes) // singleton
{
    public async Task<List<Product>> RefreshAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.Products.AsNoTracking().ToListAsync(ct);
    }                                                           // scope + DbContext disposed here
}
```

:::job title="Where captive dependencies hide"
- `BackgroundService`/`IHostedService` are **singletons** — every one that touches the database needs
  `IServiceScopeFactory`.
- Middleware classes (`UseMiddleware<T>`) are effectively singletons: inject scoped services into
  `InvokeAsync(HttpContext, MyScopedService svc)`, **not** the constructor (be-09).
- `IOptionsSnapshot<T>` is scoped — inject `IOptionsMonitor<T>` into singletons instead.
- Validation only runs in Development by default. Some teams enable it everywhere:
  `builder.Host.UseDefaultServiceProvider(o => { o.ValidateScopes = true; o.ValidateOnBuild = true; });`
:::

## Configuration

`WebApplication.CreateBuilder` loads configuration from several **sources**, in order. **Later sources
override earlier ones**:

1. `appsettings.json` — defaults, committed to git
2. `appsettings.{Environment}.json` — e.g. `appsettings.Development.json`, `appsettings.Production.json`
3. **User secrets** — only when the environment is `Development` (be-05)
4. **Environment variables**
5. **Command-line arguments** (`dotnet run -- --Pricing:VatPercent=19`)

All sources are flattened into the same **key/value** space with `:` as the hierarchy separator:

```json
{
  "ConnectionStrings": {
    "Default": "Host=localhost;Database=shop;Username=app;Password=dev"
  },
  "Pricing": {
    "Currency": "EUR",
    "VatPercent": 20
  }
}
```

```csharp
var currency = builder.Configuration["Pricing:Currency"];                 // "EUR"
var vat = builder.Configuration.GetValue<decimal>("Pricing:VatPercent");  // 20
var cs = builder.Configuration.GetConnectionString("Default");            // ConnectionStrings:Default
```

**Environment variables** can't contain `:` on every OS, so use a **double underscore** `__`:

```bash
export Pricing__VatPercent=19
export ConnectionStrings__Default="Host=db;Database=shop;Username=app;Password=$DB_PASSWORD"
```

That's how Docker Compose and Kubernetes configure .NET apps: same `appsettings.json` image everywhere,
environment-specific values injected as env vars (often from Kubernetes Secrets).

:::warn title="Secrets don't belong in appsettings.json"
`appsettings.json` is committed and baked into the container image. Passwords, API keys and connection
strings with real credentials go into user secrets (dev) and environment variables / a vault
(everywhere else). A leaked key in git history must be **rotated** — deleting the commit isn't enough.
:::

## The options pattern

Reading `Configuration["Pricing:VatPercent"]` all over the code is stringly-typed and spreads parsing
everywhere. The **options pattern** binds a section to a class once:

```csharp
public sealed class PricingOptions
{
    public const string SectionName = "Pricing";

    [Required, StringLength(3, MinimumLength = 3)]
    public string Currency { get; set; } = "";

    [Range(0, 100)]
    public decimal VatPercent { get; set; }

    public decimal MaxDiscountPercent { get; set; }
}

builder.Services
    .AddOptions<PricingOptions>()
    .BindConfiguration(PricingOptions.SectionName)   // bind the "Pricing" section
    .ValidateDataAnnotations()                        // run the attributes
    .Validate(o => o.MaxDiscountPercent <= 50, "MaxDiscountPercent must be <= 50.")  // custom rule
    .ValidateOnStart();                               // fail at STARTUP, not on first use
```

Then inject one of three interfaces. They differ in **when** they read configuration — which matters
because `appsettings*.json` is loaded with `reloadOnChange: true`, so editing the file on a running app
changes `IConfiguration` immediately (environment variables and command-line args never change
after startup):

| Interface | Lifetime | Reloads when the file changes? | Use in |
|---|---|---|---|
| `IOptions<T>` | Singleton | No — read once | Most code; values fixed for the app's life |
| `IOptionsSnapshot<T>` | **Scoped** | Yes — recomputed per request | Scoped/transient services that should see reloaded values |
| `IOptionsMonitor<T>` | Singleton | Yes — `CurrentValue` + `OnChange` callback | Singletons that need live values |

```csharp
public sealed class PriceCalculator(IOptions<PricingOptions> options)
{
    private readonly PricingOptions _options = options.Value;
    public decimal WithVat(decimal net) => net * (1 + _options.VatPercent / 100m);
}
```

**Why `ValidateOnStart` matters:** options are bound and validated **lazily** — the first time
someone reads `.Value`. Without `ValidateOnStart`, a bad value in a Kubernetes env var
(`Pricing__VatPercent=190` instead of `19`) deploys fine, passes the health check, and explodes on the
first checkout at 3 a.m. With it, the new pod crashes on startup with `OptionsValidationException`,
the rollout stops, and the old version keeps serving traffic. **Fail fast** is a deployment safety
feature.

:::warn title="Validation can't see a misspelled key"
Validation checks the **values** the class ends up with. If the env var is misspelled
(`Pricing__VatPrecent=19`), the binder finds no `VatPrecent` property, silently ignores it, and
`VatPercent` keeps its value from `appsettings.json` (or its C# default) — which passes validation.
To turn unknown keys into a startup error, ask the binder to be strict:

```csharp
.BindConfiguration(PricingOptions.SectionName, binder => binder.ErrorOnUnknownConfiguration = true)
```

With `ValidateOnStart()` that binding happens at startup too, so the typo stops the deployment.
:::

## Environments

`ASPNETCORE_ENVIRONMENT` (or `DOTNET_ENVIRONMENT`) names the environment. Conventional values:
`Development`, `Staging`, `Production`. If it's **not set, the default is `Production`** — a safe
default, and the reason the developer exception page and user secrets disappear when you forget to set
it.

```csharp
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

if (builder.Environment.IsEnvironment("Testing")) { /* … */ }
```

The environment selects `appsettings.{Environment}.json`, toggles user secrets and scope validation,
and is what you branch on for dev-only features. Keep those branches few: the more your Development
setup differs from Production, the more bugs only show up after deploying.

## Testing: swap services and settings

`WebApplicationFactory` lets each test change configuration and replace registrations **after** the
app's own `Program.cs` ran:

```csharp
var client = factory
    .WithWebHostBuilder(b =>
    {
        b.UseSetting("Pricing:VatPercent", "0");                 // override configuration
        b.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();                   // replace a service
            services.AddSingleton<TimeProvider>(new FixedTimeProvider(aFriday));
        });
    })
    .CreateClient();
```

That's the payoff of DI: time, payment gateways, email and HTTP clients become fakes in one line,
while routing, binding and the rest of the app stay real.

:::pro title="Inject time, don't read it"
`DateTime.Now` inside business logic makes "it's Friday, apply the discount" untestable. .NET 8+ ships
the abstract **`TimeProvider`** (`TimeProvider.System` in production; `FakeTimeProvider` from
`Microsoft.Extensions.TimeProvider.Testing`, or a tiny subclass, in tests). Reviewers increasingly flag
`DateTime.Now`/`UtcNow` in services. Same idea for randomness and GUIDs when tests depend on them.

The rule is about **logic whose result depends on the time**. Later lessons read the real clock in a few
places on purpose, each with a comment: a test helper that waits for a real background worker (it
measures elapsed wall time with `Stopwatch`, which is never what's under test), or test data that must
line up with a real JWT validator. If you're not sure, inject `TimeProvider`.
:::

## Check yourself

:::quiz id=be-08-q1
`AppDbContext` is registered with `AddDbContext` (scoped). Which registration is a captive dependency bug?

- [ ] `AddScoped<OrderRepository>()` where `OrderRepository(AppDbContext db)`
- [ ] `AddTransient<OrderService>()` where `OrderService(OrderRepository repo)`
- [x] `AddSingleton<ReportCache>()` where `ReportCache(AppDbContext db)`
- [ ] `AddSingleton<ReportCache>()` where `ReportCache(IServiceScopeFactory scopes)`
> A singleton outlives every request, so the `DbContext` it captures is never disposed and gets shared across threads. The last option looks similar but is the **fix**, not the bug: `IServiceScopeFactory` is itself a singleton, and creating a scope per operation is the correct singleton pattern. Scoped → scoped and transient → scoped are fine, because the consumer never outlives the request.
:::

:::quiz id=be-08-q2
Two services in the **same request** both inject `AppDbContext` (scoped). What do they get?

- [x] The same instance
- [ ] Two different instances
- [ ] The same instance as every other request
- [ ] An exception — scoped services can only be injected once
> Scoped means one instance per scope; ASP.NET Core creates one scope per HTTP request, and every resolution inside it returns the cached instance. That's why both services' changes are saved by a single `SaveChangesAsync`. "Two different instances" would be **transient**; "same as every other request" would be **singleton**. Injecting a scoped service many times is normal, not an error.
:::

:::quiz id=be-08-q3
`appsettings.json` says `"Pricing": { "VatPercent": 20 }`, `appsettings.Production.json` says `19`, and the container has env var `Pricing__VatPercent=0`. The app runs in Production. What's the value?

- [ ] `20`
- [ ] `19`
- [x] `0`
- [ ] Startup fails due to conflicting values
> Sources are layered and later ones win: base JSON → environment JSON → (user secrets in Dev) → environment variables → command line. `__` in env var names maps to `:`, so `Pricing__VatPercent` overrides both JSON files. `19` is tempting because Production JSON is "more specific", but specificity doesn't matter — only the order of sources. Overlapping values are normal; nothing fails.
:::

:::quiz id=be-08-q4
A singleton service needs configuration values that can change at runtime (the JSON file is reloaded). Which should it inject?

- [ ] `IOptions<T>`
- [ ] `IOptionsSnapshot<T>`
- [x] `IOptionsMonitor<T>`
- [ ] `IConfiguration` and parse it every time
> `IOptions<T>` never changes after first read. `IOptionsSnapshot<T>` *does* reload, which makes it tempting — but it's **scoped**, so injecting it into a singleton is itself a captive-dependency error. `IOptionsMonitor<T>` is a singleton exposing `CurrentValue` and change notifications. Parsing `IConfiguration` by hand works but throws away binding, validation and type safety.
:::

:::quiz id=be-08-q5
Why add `.ValidateOnStart()` to an options registration?

- [ ] It makes options reload faster
- [x] Invalid configuration crashes the app at startup (so a bad deployment fails immediately) instead of on first use
- [ ] It's required for `ValidateDataAnnotations()` to do anything
- [ ] It validates user secrets only
> Without it, validation runs lazily the first time `.Value` is read — possibly hours after deploy, inside a customer request. With it, the host refuses to start and the orchestrator keeps the old version running. `ValidateDataAnnotations()` works without it (just later), and it has nothing to do with reload speed or user secrets.
:::

:::quiz id=be-08-q6
You run the published app on a server with **no** `ASPNETCORE_ENVIRONMENT` variable. Which environment is it?

- [ ] Development
- [ ] Staging
- [x] Production
- [ ] None — `app.Environment` is null
> The default is `Production`. Locally you get `Development` only because `Properties/launchSettings.json` sets `ASPNETCORE_ENVIRONMENT` for `dotnet run` — and that file is a local dev tool, never used by a published app or a container. `app.Environment` is never null; `Staging` is only used when you set it.
:::

:::quiz id=be-08-q7
Which statements about this code are true? (select all)

```csharp
builder.Services.AddSingleton<RequestCounter>();
public sealed class RequestCounter { private int _count; public int Next() => ++_count; }
```

- [x] All requests share one `RequestCounter`
- [x] `++_count` is a race condition under concurrent requests; use `Interlocked.Increment(ref _count)`
- [ ] Each request gets its own counter
- [ ] Singletons are automatically thread-safe
> One instance serves every concurrent request. `++` is read-modify-write (read `_count`, add 1, write back): two threads can read the same value and one increment is lost. The container doesn't add any locking for you — singletons must be written to be thread-safe. Per-request instances would be **scoped**.
:::

:::quiz id=be-08-q8
In an integration test you want "now" to be a fixed Friday. The app registers `builder.Services.AddSingleton(TimeProvider.System);`. What's the cleanest approach?

- [ ] Change the machine's clock in the test
- [ ] Add `if (IsTesting)` branches to `PriceCalculator`
- [x] In `WithWebHostBuilder(b => b.ConfigureTestServices(s => { s.RemoveAll<TimeProvider>(); s.AddSingleton<TimeProvider>(fake); }))`
- [ ] Make `PriceCalculator` read `DateTime.Now` and mock `DateTime`
> `ConfigureTestServices` runs after the app's registrations, so the test can replace exactly one dependency while everything else stays real. That only works because the code asks for a `TimeProvider` instead of reading the static clock. `DateTime.Now` is a static property — it can't be mocked without special tooling — and `if (IsTesting)` branches mean production code paths are never the ones you test.
:::

:::quiz id=be-08-q9
`appsettings.json` has `"Pricing": { "VatPercent": 20 }` and the options use `.ValidateDataAnnotations().ValidateOnStart()` with `[Range(0, 100)]` on `VatPercent`. The Kubernetes manifest sets `Pricing__VatPrecent=19` (typo). What happens on deploy?

- [ ] The pod fails to start with `OptionsValidationException`
- [x] The app starts normally and uses `VatPercent = 20` — the misspelled key matches no property and is ignored
- [ ] The app starts with `VatPercent = 19` because the binder matches keys fuzzily
- [ ] The app starts with `VatPercent = 0`
> Validation checks the values the options object ends up with, and `20` is valid. The binder only maps keys that match a property name (case-insensitively, but not typo-tolerant), so `VatPrecent` is silently dropped and the JSON value survives. That's why it's not `0` either: the base JSON still supplies a value. To catch this class of mistake, bind with `binder => binder.ErrorOnUnknownConfiguration = true`.
:::

## Lab: lifetimes, options and test overrides

:::lab id=be-08-lab1 xp=130
title: A pricing API that proves DI lifetimes and fails fast on bad config

**1. Create the projects**

```bash
mkdir Pricing && cd Pricing
dotnet new sln -n Pricing
dotnet new web -o src/Pricing.Api
dotnet new xunit -o tests/Pricing.Tests
dotnet sln add src/Pricing.Api tests/Pricing.Tests
dotnet add tests/Pricing.Tests reference src/Pricing.Api
dotnet add tests/Pricing.Tests package Microsoft.AspNetCore.Mvc.Testing
rm tests/Pricing.Tests/UnitTest1.cs
```

**2. Configuration: replace `src/Pricing.Api/appsettings.json`**

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  },
  "AllowedHosts": "*",
  "Pricing": {
    "Currency": "EUR",
    "VatPercent": 20,
    "MaxDiscountPercent": 10
  }
}
```

**3. Replace `src/Pricing.Api/Program.cs`**

```csharp
using System.ComponentModel.DataAnnotations;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

// 1. Options: bind the "Pricing" section, validate it, fail fast at startup.
builder.Services
    .AddOptions<PricingOptions>()
    .BindConfiguration(PricingOptions.SectionName)
    .ValidateDataAnnotations()
    .Validate(o => o.MaxDiscountPercent <= 50, "MaxDiscountPercent must be <= 50.")
    .ValidateOnStart();

// 2. Services with deliberately different lifetimes.
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<RequestCounter>();
builder.Services.AddScoped<IPriceCalculator, PriceCalculator>();
builder.Services.AddTransient<OperationId>();

var app = builder.Build();

app.MapGet("/price/{basePrice:decimal}", (decimal basePrice, IPriceCalculator calc) =>
    Results.Ok(new { basePrice, finalPrice = calc.FinalPrice(basePrice) }));

app.MapGet("/lifetimes", (RequestCounter counter, OperationId a, OperationId b, IPriceCalculator calc) =>
    Results.Ok(new
    {
        requestNumber = counter.Next(),
        transientA = a.Value,
        transientB = b.Value,
        scopedCalculator = calc.InstanceId,
    }));

app.MapGet("/config", (IOptions<PricingOptions> options) =>
    Results.Ok(new { options.Value.Currency, options.Value.MaxDiscountPercent, environment = app.Environment.EnvironmentName }));

app.Run();

public sealed class PricingOptions
{
    public const string SectionName = "Pricing";

    [Required, StringLength(3, MinimumLength = 3)]
    public string Currency { get; set; } = "";

    [Range(0, 100)]
    public decimal VatPercent { get; set; }

    public decimal MaxDiscountPercent { get; set; }
}

public interface IPriceCalculator
{
    Guid InstanceId { get; }
    decimal FinalPrice(decimal basePrice);
}

public sealed class PriceCalculator(IOptions<PricingOptions> options, TimeProvider clock) : IPriceCalculator
{
    private readonly PricingOptions _options = options.Value;

    public Guid InstanceId { get; } = Guid.NewGuid();

    public decimal FinalPrice(decimal basePrice)
    {
        // Happy hour: max discount on Fridays (UTC). TimeProvider makes this testable.
        var discount = clock.GetUtcNow().DayOfWeek == DayOfWeek.Friday ? _options.MaxDiscountPercent : 0m;
        var discounted = basePrice * (1 - discount / 100m);
        return Math.Round(discounted * (1 + _options.VatPercent / 100m), 2);
    }
}

public sealed class RequestCounter
{
    private int _count;
    public int Next() => Interlocked.Increment(ref _count);
}

public sealed class OperationId
{
    public Guid Value { get; } = Guid.NewGuid();
}
```

**4. Explore by hand**

```bash
dotnet run --project src/Pricing.Api --urls http://localhost:5344
```

In a second terminal:

```bash
curl localhost:5344/lifetimes     # run it twice: compare the ids
curl localhost:5344/config
```

You should see something like this (your GUIDs will differ):

```text
{"requestNumber":1,"transientA":"8c1e…","transientB":"f04a…","scopedCalculator":"2b77…"}
{"requestNumber":2,"transientA":"51d9…","transientB":"c3e0…","scopedCalculator":"9a12…"}
{"currency":"EUR","maxDiscountPercent":10,"environment":"Development"}
```

`transientA` ≠ `transientB` inside one response (two injections, two instances), `scopedCalculator`
changes between requests (one per request), and `requestNumber` keeps counting (one singleton).

Stop it, then override configuration with an environment variable (bash/zsh syntax; in PowerShell
use `$env:Pricing__MaxDiscountPercent=25`):

```bash
Pricing__MaxDiscountPercent=25 dotnet run --project src/Pricing.Api --urls http://localhost:5344
curl localhost:5344/config        # maxDiscountPercent is now 25
```

And break it on purpose:

```bash
Pricing__MaxDiscountPercent=80 dotnet run --project src/Pricing.Api --urls http://localhost:5344
```

```text
Unhandled exception. Microsoft.Extensions.Options.OptionsValidationException: MaxDiscountPercent must be <= 50.
```

The app refuses to start. That's `ValidateOnStart()` doing its job.

**5. A fake clock: `tests/Pricing.Tests/FixedTimeProvider.cs`**

```csharp
namespace Pricing.Tests;

// Minimal fake clock (the Microsoft.Extensions.TimeProvider.Testing package has a richer one).
public sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => now;
}
```

**6. API tests: `tests/Pricing.Tests/PricingApiTests.cs`**

```csharp
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Pricing.Tests;

public class PricingApiTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    private static readonly DateTimeOffset AMonday = new(2026, 11, 2, 12, 0, 0, TimeSpan.Zero);
    private static readonly DateTimeOffset AFriday = new(2026, 11, 6, 12, 0, 0, TimeSpan.Zero);

    private HttpClient ClientAt(DateTimeOffset now) =>
        factory.WithWebHostBuilder(b => b.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(new FixedTimeProvider(now));
        })).CreateClient();

    private record PriceDto(decimal BasePrice, decimal FinalPrice);
    private record LifetimesDto(int RequestNumber, Guid TransientA, Guid TransientB, Guid ScopedCalculator);

    [Fact]
    public async Task Monday_price_is_base_plus_vat()
    {
        var dto = await ClientAt(AMonday).GetFromJsonAsync<PriceDto>("/price/100");

        Assert.Equal(120.00m, dto!.FinalPrice);
    }

    [Fact]
    public async Task Friday_price_applies_the_configured_discount()
    {
        var dto = await ClientAt(AFriday).GetFromJsonAsync<PriceDto>("/price/100");

        Assert.Equal(108.00m, dto!.FinalPrice); // 100 * 0.9 * 1.2
    }

    [Fact]
    public async Task Config_can_be_overridden_per_test()
    {
        var client = factory.WithWebHostBuilder(b => b.UseSetting("Pricing:VatPercent", "0"))
            .WithWebHostBuilder(b => b.ConfigureTestServices(s =>
            {
                s.RemoveAll<TimeProvider>();
                s.AddSingleton<TimeProvider>(new FixedTimeProvider(AMonday));
            }))
            .CreateClient();

        var dto = await client.GetFromJsonAsync<PriceDto>("/price/100");

        Assert.Equal(100.00m, dto!.FinalPrice);
    }

    [Fact]
    public async Task Transient_differs_per_injection_scoped_differs_per_request_singleton_is_shared()
    {
        var client = factory.CreateClient();

        var first = await client.GetFromJsonAsync<LifetimesDto>("/lifetimes");
        var second = await client.GetFromJsonAsync<LifetimesDto>("/lifetimes");

        Assert.NotEqual(first!.TransientA, first.TransientB);              // transient: new every time
        Assert.NotEqual(first.ScopedCalculator, second!.ScopedCalculator); // scoped: new per request
        Assert.True(second.RequestNumber > first.RequestNumber);           // singleton: state survives
    }

    [Fact]
    public void Invalid_options_stop_the_app_from_starting()
    {
        var broken = factory.WithWebHostBuilder(b => b.UseSetting("Pricing:Currency", "EURO"));

        var ex = Assert.ThrowsAny<Exception>(() => broken.CreateClient());

        Assert.Contains("Currency", ex.ToString());
    }
}
```

**7. The captive dependency, caught: `tests/Pricing.Tests/CaptiveDependencyTests.cs`**

```csharp
using Microsoft.Extensions.DependencyInjection;

namespace Pricing.Tests;

public class CaptiveDependencyTests
{
    private sealed class ScopedThing;
    private sealed class SingletonThatCapturesScoped(ScopedThing thing)
    {
        public ScopedThing Thing { get; } = thing;
    }

    [Fact]
    public void Scope_validation_catches_a_singleton_that_depends_on_a_scoped_service()
    {
        var services = new ServiceCollection();
        services.AddScoped<ScopedThing>();
        services.AddSingleton<SingletonThatCapturesScoped>();

        var ex = Assert.Throws<AggregateException>(() =>
            services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true }));

        Assert.Contains("Cannot consume scoped service", ex.ToString());
    }
}
```

**8. Run** `dotnet test` → `Passed: 6`.

**9. Experiments**

- In `Program.cs`, change `AddScoped<IPriceCalculator, PriceCalculator>()` to `AddSingleton`. Which
  test fails, and why? (Expect the lifetimes test: `scopedCalculator` is now the same on both
  requests.)
- Add `builder.Services.AddSingleton<CaptiveCalculatorHolder>();` with a class whose constructor takes
  `IPriceCalculator` (scoped). Run `dotnet run`: read the startup error. Then run with
  `--no-launch-profile` (environment defaults to Production) — does it still fail at startup?

- [ ] All 6 tests pass
- [ ] I saw `/lifetimes` change `scopedCalculator` per request and keep counting `requestNumber`
- [ ] I overrode config with `Pricing__MaxDiscountPercent` and saw `OptionsValidationException` for 80
- [ ] I saw the "Cannot consume scoped service … from singleton" error in Development and noticed it's skipped in Production
:::

## Flashcards

:::cards id=be-08-cards1 title="DI & configuration"
Q: Singleton / scoped / transient in ASP.NET Core?
A: Singleton: one per app. Scoped: one per HTTP request. Transient: a new one for every injection.
Q: What's a captive dependency?
A: A longer-lived service (singleton) holding a shorter-lived one (scoped, e.g. DbContext) — it's never disposed and gets shared across threads.
Q: How does a singleton use a scoped service correctly?
A: Inject `IServiceScopeFactory`, `CreateAsyncScope()` per operation, resolve the scoped service from that scope, dispose the scope.
Q: When is scope validation on by default?
A: In the Development environment (`ValidateScopes` + `ValidateOnBuild`).
Q: Configuration precedence (low → high)?
A: appsettings.json → appsettings.{Env}.json → user secrets (Dev) → environment variables → command line.
Q: How do you write `Pricing:VatPercent` as an environment variable?
A: `Pricing__VatPercent` (double underscore).
Q: `IOptions` vs `IOptionsSnapshot` vs `IOptionsMonitor`?
A: IOptions: singleton, read once. IOptionsSnapshot: scoped, recomputed per request. IOptionsMonitor: singleton, live `CurrentValue` + `OnChange`.
Q: Why `ValidateOnStart()`?
A: Bad configuration crashes the app at startup, so broken deployments fail fast instead of at first use.
Q: Default environment if `ASPNETCORE_ENVIRONMENT` isn't set?
A: Production.
Q: How do tests replace a service in `WebApplicationFactory`?
A: `WithWebHostBuilder(b => b.ConfigureTestServices(s => { s.RemoveAll<T>(); s.AddSingleton<T>(fake); }))`.
Q: Does options validation catch a misspelled config key?
A: No — unknown keys are ignored and the property keeps its old value. Use `ErrorOnUnknownConfiguration = true` on the binder to make them an error.
:::

## Recap

- DI = classes **declare** dependencies; the container builds, shares and disposes them. Inject via
  constructors / handler parameters, not `IServiceProvider`.
- **Singleton** (app, must be thread-safe), **scoped** (per request — DbContext), **transient** (per
  injection).
- Never let a singleton capture a scoped service; use `IServiceScopeFactory`. Development's scope
  validation catches it at startup.
- Configuration layers: JSON → env JSON → user secrets → env vars (`__`) → command line; later wins.
- Bind sections to classes with the **options pattern**, validate with DataAnnotations/`Validate`, and
  **`ValidateOnStart()`**. Misspelled keys are silently ignored unless you set
  `ErrorOnUnknownConfiguration`.
- The environment defaults to **Production**; keep dev-only branches minimal.
- Inject `TimeProvider` and other boundaries so tests can swap them with `ConfigureTestServices`.
