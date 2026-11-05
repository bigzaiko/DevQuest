---
id: be-09
title: Middleware, Logging & Global Error Handling
level: intermediate
minutes: 55
xp: 150
summary: The request pipeline and why order matters, writing middleware, structured logging with ILogger, global exception handling with IExceptionHandler + ProblemDetails, and CORS for a Vite frontend.
---

Every request to an ASP.NET Core app travels through a **pipeline** of middleware before it reaches
your endpoint, and back out again. Exception handling, CORS, authentication, HTTPS redirection,
compression, rate limiting — all middleware. Understanding the pipeline explains a whole class of
"it works locally but…" bugs: CORS errors in the browser, auth that never runs, exceptions that leak
stack traces. This lesson also covers the two things you'll rely on when production breaks: **logs**
and **consistent error responses**.

## The pipeline

Middleware is a chain of functions. Each one receives the `HttpContext` and a `next` delegate, can do
work **before** calling `next`, **after** it returns, or **not call it at all** (short-circuit):

```text
request ─►  ExceptionHandler ─► CorrelationId ─► CORS ─► Auth ─► Endpoint
                                                                    │
response ◄─ ExceptionHandler ◄─ CorrelationId ◄─ CORS ◄─ Auth ◄─────┘
```

It's the same idea as Express/Koa middleware — the "onion" model. The **first** middleware you add is
the **outermost** layer: it sees the request first and the response last.

```csharp
app.Use(async (context, next) =>
{
    Console.WriteLine($"→ {context.Request.Path}");   // before: on the way in
    await next(context);                               // everything further in runs here
    Console.WriteLine($"← {context.Response.StatusCode}"); // after: on the way out
});
```

### Order matters

Because each middleware only wraps what comes **after** it, order changes behaviour:

- `UseExceptionHandler()` must be **first**: it works by wrapping `await next(context)` in a
  `try/catch`, so it can only catch exceptions thrown by middleware registered *after* it.
- `UseCors()` must run **before** authentication/authorization and endpoints, or preflight requests
  get rejected before CORS can answer them.
- `UseAuthentication()` must come before `UseAuthorization()` — you can't check permissions before you
  know who the user is.

A typical API pipeline:

```csharp
var app = builder.Build();

app.UseExceptionHandler();        // 1. outermost: turns exceptions into ProblemDetails
app.UseStatusCodePages();         // 2. empty 4xx/5xx → ProblemDetails
if (!app.Environment.IsDevelopment())
    app.UseHsts();                // 3. Strict-Transport-Security header
app.UseHttpsRedirection();        // 4. http → https
app.UseCors("frontend");          // 5. CORS (needs to answer preflights early)
app.UseAuthentication();          // 6. who are you?
app.UseAuthorization();           // 7. are you allowed?
app.UseRateLimiter();             // 8. throttle

app.MapProductEndpoints();        // endpoints run at the end of the pipeline
app.Run();
```

`WebApplication` adds **routing** automatically at the start of the pipeline, and in Development it
also adds the developer exception page. That's why minimal API apps rarely call `UseRouting()`
explicitly — you only add it if you need middleware to run *before* routing.

:::warn title="Can't touch headers after the response started"
HTTP sends the status line and headers **before** the body. As soon as the endpoint writes its first
body byte, the headers are on the wire and can't be recalled. After that point
(`context.Response.HasStarted == true`), setting `context.Response.StatusCode` or a header throws an
`InvalidOperationException` ("Headers are read-only, response has already started").
Since most endpoints write a body, "after `await next(context)`" is usually too late. To add a header to every response, register a callback with
`context.Response.OnStarting(...)` **before** calling `next` — it runs just before headers are sent,
even for error responses.
:::

## Writing middleware

Three styles, from quick to reusable.

**1. Inline** with `app.Use` — fine for small, app-specific things:

```csharp
app.Use(async (context, next) =>
{
    if (context.Request.Headers.ContainsKey("X-Block-Me"))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;                         // short-circuit: next is never called
    }
    await next(context);
});
```

**2. Convention-based class** — the most common reusable form. The example is a **correlation id**:
one id per request that's written into every log line *and* sent back in a response header. When a
user reports "it failed", the frontend shows that id, and support can search the logs for exactly
that request instead of guessing by timestamp. If the caller (a gateway, another service, the
frontend) already sent an id, we reuse it so the id follows the request across services.

```csharp
public sealed class CorrelationIdMiddleware(RequestDelegate next, ILogger<CorrelationIdMiddleware> logger)
{
    public const string HeaderName = "X-Correlation-Id";

    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = context.Request.Headers[HeaderName].FirstOrDefault() is { Length: > 0 and <= 64 } incoming
            ? incoming
            : Guid.NewGuid().ToString("N");

        context.TraceIdentifier = correlationId;
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[HeaderName] = correlationId;
            return Task.CompletedTask;
        });

        using (logger.BeginScope("CorrelationId:{CorrelationId}", correlationId))
        {
            await next(context);
        }
    }
}

app.UseMiddleware<CorrelationIdMiddleware>();
```

The class is constructed **once** when the pipeline is built (it's effectively a singleton).
`RequestDelegate next` is "the rest of the pipeline". Constructor parameters must be singletons too; **scoped** services (like a `DbContext`) go into `InvokeAsync`'s parameters instead:
`public async Task InvokeAsync(HttpContext context, AppDbContext db)` — they're resolved per request.

**3. `IMiddleware`** — the middleware itself is registered in DI (`builder.Services.AddScoped<MyMiddleware>()`)
and created per request, so it can take scoped dependencies in its constructor. Less common, useful
when the middleware is heavily dependency-driven.

:::pro title="Before writing middleware, check the box"
ASP.NET Core ships middleware for most cross-cutting needs: `UseResponseCompression`,
`UseOutputCache`, `UseRateLimiter`, `UseRequestTimeouts`, `UseForwardedHeaders` (needed behind a
reverse proxy/ingress), `UseHttpLogging`, health checks (`MapHealthChecks`). Reviewers will ask why you
hand-rolled one. Also consider **endpoint filters** (`AddEndpointFilter`) when the logic only applies
to some endpoints and needs their arguments — that's the minimal API equivalent of MVC action filters.
:::

## Logging with `ILogger`

Inject `ILogger<T>` (the category is the class name) and log with **message templates**:

```csharp
public sealed class OrderService(ILogger<OrderService> logger)
{
    public async Task PlaceAsync(Order order, CancellationToken ct)
    {
        logger.LogInformation("Placing order {OrderId} for customer {CustomerId} with total {Total}",
            order.Id, order.CustomerId, order.Total);
        // …
    }
}
```

That `{OrderId}` is **not** string interpolation. The template and the values are kept separately, so
a structured sink (Seq, Elasticsearch, Loki, Application Insights, Datadog) stores `OrderId` as a
**searchable field**: "show me every log line for order 1234" becomes a query instead of a regex.

```csharp
logger.LogInformation($"Placing order {order.Id}");           // ❌ one opaque string; also allocates even if Information is disabled
logger.LogInformation("Placing order {OrderId}", order.Id);   // ✅ structured, cheap when filtered out
```

Analyzer **CA2254** warns about the first form.

### Log levels

| Level | Use for | Typical prod setting |
|---|---|---|
| `Trace` | Very detailed internals, may contain sensitive data | Off |
| `Debug` | Developer diagnostics | Off |
| `Information` | Normal, notable events: request handled, order placed, job finished | On for your code |
| `Warning` | Unexpected but handled: retry, fallback, validation spike, slow call | On |
| `Error` | An operation failed: unhandled exception, failed payment | On, alert-worthy |
| `Critical` | The app is unusable: can't reach the database at all, data corruption | On, page someone |

Levels are configured per **category** in `appsettings.json` — the most specific prefix wins:

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

That last line logs every SQL statement EF Core runs — great in Development, noisy in Production. And
since it's configuration, you can change it without rebuilding: an env var
(`Logging__LogLevel__Default=Debug`) takes effect on the next restart, and an edit to
`appsettings.json` is picked up by a running app because the file is loaded with `reloadOnChange`.

### Scopes and correlation

A **log scope** attaches properties to every log line written inside it — like the `CorrelationId`
above. With scopes enabled (`"Console": { "FormatterOptions": { "IncludeScopes": true } }`) the
console shows:

```text
info: Pipeline.Api[0]
      => SpanId:0cba…, TraceId:453d…, ParentId:0000… => ConnectionId:0HNPRA4ME6JBQ => RequestPath:/hello RequestId:0HNPRA4ME6JBQ:00000001 => CorrelationId:demo-1
      GET /hello finished in 2.0 ms
```

ASP.NET Core already adds `TraceId`/`SpanId` (W3C trace context, compatible with **OpenTelemetry**)
and `RequestPath` to every request's scope. When the frontend shows "Something went wrong (ref:
demo-1)", support can find every log line for that request.

### Performance: source-generated logging

For hot paths, the `[LoggerMessage]` source generator creates strongly typed, allocation-free logging
methods:

```csharp
public static partial class Log
{
    [LoggerMessage(Level = LogLevel.Information, Message = "Placing order {OrderId} with total {Total}")]
    public static partial void PlacingOrder(ILogger logger, int orderId, decimal total);
}

Log.PlacingOrder(logger, order.Id, order.Total);
```

### Serilog and friends

The built-in providers (console, debug, EventSource) are fine to start. Many teams add **Serilog**
(`Serilog.AspNetCore`) for rich sinks (Seq, files, Elasticsearch), enrichers and compact request
logging (`app.UseSerilogRequestLogging()`) — it plugs in *behind* `ILogger<T>`, so your code doesn't
change. The modern alternative is exporting logs, traces and metrics with **OpenTelemetry**. For
containers, writing **JSON to stdout** (`builder.Logging.AddJsonConsole()`) and letting the platform
collect it is the norm.

:::job title="Logging rules teams enforce"
- **Never log secrets or personal data**: passwords, tokens, full card numbers, and often emails.
  Logs get shipped to third parties and kept for months; GDPR applies to them.
- Log the exception **object**, not just its message: `logger.LogError(ex, "Payment failed for {OrderId}", id)`.
  The stack trace is the whole point.
- **Log or rethrow, not both** at every layer — otherwise one failure produces five identical errors.
  Usually the global exception handler does the logging.
- `Information` should tell the story of a request at a glance; if prod logs are 90 % noise, nobody
  reads them during an incident.
:::

## Global exception handling

An unhandled exception in an endpoint must **never** reach the client as a stack trace: it leaks
internals (paths, SQL, sometimes secrets) and gives the frontend nothing usable. The pattern:

1. `builder.Services.AddProblemDetails()` — the standard error format (be-07).
2. One or more `IExceptionHandler` implementations — map exceptions to responses.
3. `app.UseExceptionHandler()` first in the pipeline — catches anything thrown further in.

```csharp
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

public sealed class NotFoundException(string message) : Exception(message);

// Maps a known domain exception to a 404 problem.
public sealed class DomainExceptionHandler(IProblemDetailsService problemDetails) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        if (exception is not NotFoundException notFound) return false;   // not mine -> next handler

        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = StatusCodes.Status404NotFound,
                Title = "Resource not found",
                Detail = notFound.Message,
            },
        });
    }
}

// Fallback: everything else is a 500 - logged, but with no internal details in the response.
public sealed class GlobalExceptionHandler(IProblemDetailsService problemDetails, ILogger<GlobalExceptionHandler> logger)
    : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        // TraceId in the message: the log scope from inner middleware is already gone at this point.
        logger.LogError(exception, "Unhandled exception for {Method} {Path} (trace id {TraceId})",
            context.Request.Method, context.Request.Path, context.TraceIdentifier);

        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = StatusCodes.Status500InternalServerError,
                Title = "An unexpected error occurred",
                // No exception.Message here: it can leak secrets / internals.
            },
        });
    }
}
```

```csharp
builder.Services.AddProblemDetails(options =>
    options.CustomizeProblemDetails = ctx =>
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier);
builder.Services.AddExceptionHandler<DomainExceptionHandler>();   // tried first
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();   // tried next
// …
app.UseExceptionHandler();
```

Handlers run **in registration order** until one returns `true`. `CustomizeProblemDetails` sets the
`traceId` of every problem response to `HttpContext.TraceIdentifier` (which our correlation middleware
sets) — the reference number your frontend shows to users and your support team searches the logs for.

Three things that bite people here:

- **Handlers are singletons.** `AddExceptionHandler<T>()` registers `T` as a singleton, so the
  be-08 rule applies: no `DbContext` or other scoped service in its constructor. Resolve one from
  `context.RequestServices` inside `TryHandleAsync` if you really need it.
- **`UseExceptionHandler()` needs something to do.** Called with no arguments and with neither
  `AddProblemDetails()` nor an `ExceptionHandlingPath` configured, it throws at startup ("An error
  occurred when configuring the exception handler middleware…").
- **Why `IExceptionHandler` and not a `try/catch` middleware?** You could write one, but the built-in
  middleware already clears a half-written response, resets headers, refuses to run when the response
  has already started (it can't fix that one), and integrates with `IProblemDetailsService` and
  diagnostics. Your code only decides *which* status and body to send.

:::info title=".NET 10: handled exceptions aren't logged twice"
In .NET 10, when an `IExceptionHandler` returns `true`, the exception handler middleware no longer
writes its own error log or diagnostics for that exception by default (you can change that with
`ExceptionHandlerOptions.SuppressDiagnosticsCallback`). That's why `GlobalExceptionHandler` logs
explicitly — it's now the single place where unhandled errors are recorded (and
`DomainExceptionHandler` deliberately doesn't log expected 404s as errors). If no handler returns
`true`, the middleware still logs the exception itself.
:::

## CORS for a Vite frontend

Your React app runs on `http://localhost:5173` (Vite) and calls the API on `http://localhost:5214`.
Different **port** = different **origin** (scheme + host + port). Browsers enforce the
**same-origin policy**: JavaScript may *send* cross-origin requests, but may only *read* the response
if the server says it's allowed — via **CORS** (Cross-Origin Resource Sharing) headers.

Without CORS configured you get the infamous console error:

```text
Access to fetch at 'http://localhost:5214/api/products' from origin 'http://localhost:5173'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present…
```

For "non-simple" requests — `Content-Type: application/json`, custom headers like `Authorization`,
methods like `PUT`/`DELETE` — the browser first sends a **preflight**:

```http
OPTIONS /api/products
Origin: http://localhost:5173
Access-Control-Request-Method: POST
Access-Control-Request-Headers: content-type
```

…and only sends the real request if the server answers with matching `Access-Control-Allow-*`
headers. Configure it:

```csharp
const string FrontendCors = "frontend";

builder.Services.AddCors(options => options.AddPolicy(FrontendCors, policy => policy
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:5173"])
    .AllowAnyHeader()
    .AllowAnyMethod()
    .WithExposedHeaders("X-Correlation-Id")));   // let JS read this response header

var app = builder.Build();
app.UseCors(FrontendCors);
```

```json
{
  "Cors": {
    "Origins": [ "http://localhost:5173" ]
  }
}
```

Things that trip people up:

- Origins are exact: `http://localhost:5173` ≠ `http://127.0.0.1:5173` ≠ `https://localhost:5173`. No trailing slash.
- `AllowAnyOrigin()` and `AllowCredentials()` (cookies) **can't be combined** — the spec forbids `*`
  with credentials. List origins explicitly.
- Response headers other than a small safe list are invisible to JS unless exposed with `WithExposedHeaders`.
- **CORS is not API security.** It only controls what *browsers* let JavaScript read. `curl`, Postman
  and servers ignore it. Authentication and authorization protect your API.

:::tip title="Or skip CORS in development with the Vite proxy"
```ts
// vite.config.ts
import { defineConfig } from 'vite'

export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:5214' } },
})
```
The browser calls `http://localhost:5173/api/...` (same origin), and Vite forwards it to the API. In
production the same effect comes from serving both behind one domain (a reverse proxy or ingress
routing `/api` to the backend). You still need CORS whenever the frontend and API are genuinely on
different origins.
:::

## Check yourself

:::quiz id=be-09-q1
What does the console show for one request to `/`? (Spaces added for readability.)

```csharp
app.Use(async (ctx, next) => { Console.Write("A"); await next(ctx); Console.Write("a"); });
app.Use(async (ctx, next) => { Console.Write("B"); await next(ctx); Console.Write("b"); });
app.MapGet("/", () => { Console.Write("E"); return "ok"; });
```

- [ ] `B A E a b`
- [x] `A B E b a`
- [ ] `A B E a b`
- [ ] `E A B b a`
> The first registered middleware is the outermost layer. The request flows in A → B → endpoint, then the response flows back out b → a — the onion model. `A B E a b` is the tempting wrong answer: it treats the "after" code as a queue, but each "after" line runs only when its own `await next(ctx)` returns, and B's returns first because B is nested inside A.
:::

:::quiz id=be-09-q2
A teammate puts `app.UseExceptionHandler()` **after** a custom middleware that sometimes throws. What happens when that middleware throws?

- [ ] The exception handler still catches it — order doesn't matter
- [x] It isn't caught by the exception handler, because the handler only wraps middleware registered after it
- [ ] The app fails to start
- [ ] ASP.NET Core retries the request
> The exception handler is a `try/catch` around its own `next(...)` call, so it can only catch what happens further **in**. A middleware registered before it is further **out**, and its exception propagates straight to the server (which returns a bare 500, or the developer exception page in Development). Order isn't just style — it decides what wraps what. Nothing is retried, and the app starts fine; the bug only shows when that middleware throws.
:::

:::quiz id=be-09-q3
Which log call is the right one?

- [ ] `logger.LogInformation($"User {userId} logged in from {ip}");`
- [x] `logger.LogInformation("User {UserId} logged in from {IpAddress}", userId, ip);`
- [ ] `logger.LogInformation("User " + userId + " logged in from " + ip);`
- [ ] `Console.WriteLine($"User {userId} logged in");`
> Message templates keep `UserId` and `IpAddress` as structured, queryable properties and avoid formatting work when the level is disabled. The interpolated version *looks* identical in the console, which is why it's so common — but it hands the logger one pre-built string, so the sink can't search by `UserId` and the string is built even if `Information` is off (analyzer CA2254). Concatenation has the same problem, and `Console.WriteLine` bypasses levels, categories and sinks entirely.
:::

:::quiz id=be-09-q4
The React app on `http://localhost:5173` gets a CORS error calling the API. The API has `.WithOrigins("http://localhost:5173/")`. What's wrong?

- [ ] CORS must be configured in the React app
- [x] The trailing slash: origins are matched exactly as scheme://host:port, without a path
- [ ] `localhost` is never allowed in CORS
- [ ] The API must use HTTPS
> An origin has no path. `"http://localhost:5173/"` doesn't equal the browser's `Origin: http://localhost:5173` header, so no `Access-Control-Allow-Origin` is sent. CORS is enforced by the browser but **configured on the server** — nothing in the React app can grant itself access. `localhost` is a perfectly valid origin, and HTTP is fine for local development.
:::

:::quiz id=be-09-q5
Which statements about CORS are true? (select all)

- [x] The browser sends an `OPTIONS` preflight before a **cross-origin** `POST` with `Content-Type: application/json`
- [x] `AllowAnyOrigin()` cannot be combined with `AllowCredentials()`
- [ ] CORS stops attackers from calling your API with `curl`
- [x] `UseCors` must run before authorization and the endpoints
> `application/json` isn't one of the "simple" content types, so a cross-origin POST with it needs a preflight. The spec forbids `Access-Control-Allow-Origin: *` together with credentials, and `UseCors` has to run before authorization/endpoints so preflights get answered. The `curl` statement is the trap: CORS is a browser-enforced read permission. Non-browser clients ignore it completely, so it's never a substitute for authentication.
:::

:::quiz id=be-09-q6
Your `GlobalExceptionHandler` returns a 500 ProblemDetails. What should **not** be in the response body?

- [ ] `status: 500`
- [ ] A generic `title`
- [x] `exception.Message` and the stack trace
- [ ] A `traceId` the user can quote to support
> Exception messages and stack traces can contain connection strings, SQL, file paths or user data — the lab's `/boom` endpoint deliberately puts a password in its message. Log them server-side; give the client a generic message plus a correlation/trace id. The `traceId` is safe and useful: it's an opaque reference, not internal detail.
:::

:::quiz id=be-09-q7
A convention-based middleware class needs the scoped `AppDbContext`. Where should it get it?

```csharp
public sealed class AuditMiddleware(RequestDelegate next /* , AppDbContext db ? */)
{
    public async Task InvokeAsync(HttpContext context /* , AppDbContext db ? */) { … }
}
```

- [ ] Constructor — like any other service
- [x] As a parameter of `InvokeAsync` — it's resolved per request
- [ ] From a static field set in `Program.cs`
- [ ] Middleware can't use the database
> Convention-based middleware is constructed once for the app's lifetime, so a scoped service in its constructor would be a captive dependency (be-08) — with Development's scope validation you get "Cannot resolve scoped service … from root provider". `InvokeAsync` parameters are resolved from the request's scope, so each request gets its own `DbContext`. A static field would be the same captive bug with extra steps.
:::

:::quiz id=be-09-q8
Two `IExceptionHandler`s are registered: `DomainExceptionHandler` then `GlobalExceptionHandler`. An `InvalidOperationException` is thrown. What happens?

- [ ] Both handlers write a response
- [x] `DomainExceptionHandler` returns `false` (not its exception type), then `GlobalExceptionHandler` handles it and returns `true`
- [ ] Only the last registered handler is ever called
- [ ] The exception is rethrown because the first handler said `false`
> Handlers are tried in registration order until one returns `true`. Returning `false` means "not mine, try the next one" — not "rethrow". Once a handler returns `true`, the rest are skipped, so only one response is written. If none handles it, the middleware falls back to its default behaviour (a generic problem response when `AddProblemDetails()` is registered).
:::

:::quiz id=be-09-q9
Spot the bug. This middleware works for `/health` (which returns `204 No Content`) but throws for `/hello` (which returns the string `"hello"`). Why?

```csharp
app.Use(async (context, next) =>
{
    await next(context);
    context.Response.Headers["X-Served-By"] = Environment.MachineName;
});
```

- [ ] Header names may not start with `X-`
- [x] `/hello` writes a body, which sends the headers; after that they're read-only, so setting one throws
- [ ] `Environment.MachineName` isn't available inside middleware
- [ ] `app.Use` middleware can only run code before `next`
> Headers travel before the body. Once the endpoint writes `"hello"`, the response has started (`HasStarted == true`) and changing headers throws "Headers are read-only". The bodiless 204 still has unsent headers when control comes back, which is why the bug hides on some endpoints. Fix: register `context.Response.OnStarting(...)` **before** `await next(context)`. `X-` headers are allowed (just discouraged for new standards), and code after `next` is legal — it just can't touch headers once the body started.
:::

:::quiz id=be-09-q10
Which log call gives you the most to work with when a payment fails in production?

```csharp
catch (PaymentException ex) { /* which line? */ throw; }
```

- [ ] `logger.LogError(ex.Message);`
- [ ] `logger.LogError($"Payment failed: {ex}");`
- [x] `logger.LogError(ex, "Payment failed for order {OrderId}", order.Id);`
- [ ] `logger.LogWarning("Payment failed");`
> Passing the exception as the **first argument** gives the sink the type, message, stack trace and inner exceptions as structured data, and the template adds a searchable `OrderId`. `ex.Message` alone throws the stack trace away (and is a non-constant template, CA2254). Interpolating `{ex}` dumps the text into one opaque string. A bare warning tells you nothing. And note the `throw;`: if this layer rethrows, the global handler will log it too — so in real code either log here **or** rethrow, not both.
:::

## Lab: a production-shaped pipeline

:::lab id=be-09-lab1 xp=130
title: Correlation ids, structured logs, exception handlers and CORS — with tests

**1. Create the projects**

```bash
mkdir Pipeline && cd Pipeline
dotnet new sln -n Pipeline
dotnet new web -o src/Pipeline.Api
dotnet new xunit -o tests/Pipeline.Tests
dotnet sln add src/Pipeline.Api tests/Pipeline.Tests
dotnet add tests/Pipeline.Tests reference src/Pipeline.Api
dotnet add tests/Pipeline.Tests package Microsoft.AspNetCore.Mvc.Testing
rm tests/Pipeline.Tests/UnitTest1.cs
```

**2. `src/Pipeline.Api/appsettings.json`**

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    },
    "Console": {
      "FormatterName": "simple",
      "FormatterOptions": { "IncludeScopes": true }
    }
  },
  "AllowedHosts": "*",
  "Cors": {
    "Origins": [ "http://localhost:5173" ]
  }
}
```

**3. `src/Pipeline.Api/CorrelationIdMiddleware.cs`**

```csharp
public sealed class CorrelationIdMiddleware(RequestDelegate next, ILogger<CorrelationIdMiddleware> logger)
{
    public const string HeaderName = "X-Correlation-Id";

    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = context.Request.Headers[HeaderName].FirstOrDefault() is { Length: > 0 and <= 64 } incoming
            ? incoming
            : Guid.NewGuid().ToString("N");

        context.TraceIdentifier = correlationId;
        context.Response.OnStarting(() =>
        {
            context.Response.Headers[HeaderName] = correlationId;
            return Task.CompletedTask;
        });

        using (logger.BeginScope("CorrelationId:{CorrelationId}", correlationId))
        {
            await next(context);
        }
    }
}
```

The `{ Length: > 0 and <= 64 }` pattern refuses absurdly long incoming ids — never trust headers.

**4. `src/Pipeline.Api/ExceptionHandlers.cs`** (the same handlers as in the section above)

```csharp
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;

public sealed class NotFoundException(string message) : Exception(message);

public sealed class DomainExceptionHandler(IProblemDetailsService problemDetails) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        if (exception is not NotFoundException notFound) return false;   // not mine -> next handler

        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = StatusCodes.Status404NotFound,
                Title = "Resource not found",
                Detail = notFound.Message,
            },
        });
    }
}

public sealed class GlobalExceptionHandler(IProblemDetailsService problemDetails, ILogger<GlobalExceptionHandler> logger)
    : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        // TraceId in the message: the log scope from inner middleware is already gone at this point.
        logger.LogError(exception, "Unhandled exception for {Method} {Path} (trace id {TraceId})",
            context.Request.Method, context.Request.Path, context.TraceIdentifier);

        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = StatusCodes.Status500InternalServerError,
                Title = "An unexpected error occurred",
                // No exception.Message here: it can leak secrets / internals.
            },
        });
    }
}
```

**5. `src/Pipeline.Api/Program.cs`**

```csharp
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails(options =>
    options.CustomizeProblemDetails = ctx =>
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier);
builder.Services.AddExceptionHandler<DomainExceptionHandler>();   // runs first
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();   // fallback

const string FrontendCors = "frontend";
builder.Services.AddCors(options => options.AddPolicy(FrontendCors, policy => policy
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? ["http://localhost:5173"])
    .AllowAnyHeader()
    .AllowAnyMethod()
    .WithExposedHeaders(CorrelationIdMiddleware.HeaderName)));

var app = builder.Build();

// ── The pipeline. ORDER MATTERS: top = outermost. ──
app.UseExceptionHandler();                    // 1. catch everything thrown below
app.UseMiddleware<CorrelationIdMiddleware>(); // 2. every request gets an id (+ log scope)
app.UseCors(FrontendCors);                    // 3. CORS before endpoints
app.Use(async (context, next) =>              // 4. inline middleware: timing
{
    var start = TimeProvider.System.GetTimestamp();
    try
    {
        await next(context);
    }
    finally   // runs even when an endpoint throws
    {
        var elapsed = TimeProvider.System.GetElapsedTime(start);
        app.Logger.LogInformation("{Method} {Path} finished in {ElapsedMs:0.0} ms",
            context.Request.Method, context.Request.Path, elapsed.TotalMilliseconds);
    }
});

app.MapGet("/hello", () => "hello");
app.MapGet("/orders/{id:int}", (int id) =>
    id == 42 ? Results.Ok(new { id, total = 99.5m }) : throw new NotFoundException($"Order {id} does not exist."));
app.MapGet("/boom", () => { throw new InvalidOperationException("Database password is hunter2"); });

app.Run();
```

**6. Tests: `tests/Pipeline.Tests/PipelineTests.cs`**

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Pipeline.Tests;

public class PipelineTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Every_response_gets_a_correlation_id()
    {
        var response = await _client.GetAsync("/hello");

        Assert.True(response.Headers.TryGetValues("X-Correlation-Id", out var values));
        Assert.False(string.IsNullOrWhiteSpace(values.Single()));
    }

    [Fact]
    public async Task Incoming_correlation_id_is_echoed_back()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/hello");
        request.Headers.Add("X-Correlation-Id", "abc123");

        var response = await _client.SendAsync(request);

        Assert.Equal("abc123", response.Headers.GetValues("X-Correlation-Id").Single());
    }

    [Fact]
    public async Task Domain_not_found_exception_becomes_a_404_problem()
    {
        var response = await _client.GetAsync("/orders/7");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal("Order 7 does not exist.", json.RootElement.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task Unexpected_exception_becomes_a_500_problem_without_leaking_the_message()
    {
        var response = await _client.GetAsync("/boom");
        var body = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        Assert.DoesNotContain("hunter2", body);
        Assert.Contains("traceId", body);
    }

    [Fact]
    public async Task Error_responses_still_carry_the_correlation_id()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/boom");
        request.Headers.Add("X-Correlation-Id", "err-42");

        var response = await _client.SendAsync(request);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());

        Assert.Equal("err-42", response.Headers.GetValues("X-Correlation-Id").Single());
        Assert.Equal("err-42", json.RootElement.GetProperty("traceId").GetString());
    }

    [Fact]
    public async Task Cors_preflight_from_the_vite_dev_server_is_allowed()
    {
        var preflight = new HttpRequestMessage(HttpMethod.Options, "/hello");
        preflight.Headers.Add("Origin", "http://localhost:5173");
        preflight.Headers.Add("Access-Control-Request-Method", "GET");

        var response = await _client.SendAsync(preflight);

        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        Assert.Equal("http://localhost:5173", response.Headers.GetValues("Access-Control-Allow-Origin").Single());
    }

    [Fact]
    public async Task Cors_does_not_allow_random_origins()
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/hello");
        request.Headers.Add("Origin", "https://evil.example");

        var response = await _client.SendAsync(request);

        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
    }
}
```

**7. Run** `dotnet test` → `Passed: 7`.

**8. Watch the logs.** Start the API on a fixed port:

```bash
dotnet run --project src/Pipeline.Api --urls http://localhost:5214
```

In a second terminal:

```bash
curl -i -H "X-Correlation-Id: demo-1" http://localhost:5214/hello
curl -i -H "X-Correlation-Id: demo-2" http://localhost:5214/boom
```

The first returns `hello` with an `X-Correlation-Id: demo-1` header; the second a 500
`application/problem+json` body with `"traceId":"demo-2"` and no `hunter2`. In the API's console you
should find (ids shortened):

```text
info: Pipeline.Api[0]
      => SpanId:…, TraceId:…, ParentId:… => ConnectionId:… => RequestPath:/hello RequestId:… => CorrelationId:demo-1
      GET /hello finished in 0.4 ms
info: Pipeline.Api[0]
      => … => RequestPath:/boom RequestId:… => CorrelationId:demo-2
      GET /boom finished in 1.2 ms
fail: GlobalExceptionHandler[0]
      => SpanId:…, TraceId:…, ParentId:… => ConnectionId:… => RequestPath:/boom RequestId:…
      Unhandled exception for GET /boom (trace id demo-2)
      System.InvalidOperationException: Database password is hunter2
         at …
```

Three things to notice: the `CorrelationId` scope on the `info:` lines; exactly **one** `fail:` entry
for `/boom` (.NET 10 doesn't add a second one from the middleware); and that the `fail:` line has **no**
`CorrelationId` scope — by the time the exception reaches `UseExceptionHandler` (outermost), it has
already unwound out of the correlation middleware's `using` block. That's why the handler puts the
trace id into the message itself. The secret is in the server log — another reason logs need access
control — but never in the response.

**9. Break the order on purpose** (run the tests after each change, then revert):

- Move `app.UseExceptionHandler()` below `app.UseMiddleware<CorrelationIdMiddleware>()`. Do all tests
  still pass? Look at the `fail:` log line for `/boom` now — why does it suddenly have the
  `CorrelationId` scope? And what would change if the correlation middleware itself threw?
- Replace the `OnStarting` callback with `context.Response.Headers[HeaderName] = correlationId;`
  placed **after** `await next(context)`. Which tests fail, and why?
- Swap the two `AddExceptionHandler` registrations. Which test fails?

- [ ] All 7 tests pass
- [ ] I saw the correlation id in the log scope and in the response header
- [ ] `/boom` returns a 500 problem with a `traceId` and without `hunter2`, and is logged exactly once
- [ ] I broke the header timing and the handler order on purpose and can explain each failure
:::

## Flashcards

:::cards id=be-09-cards1 title="Middleware, logging & errors"
Q: Which middleware sees the request first?
A: The one registered first — it's the outermost layer and also sees the response last.
Q: Why must `UseExceptionHandler()` be first?
A: Middleware only catches what happens inside its `next()` call; anything registered before it isn't covered.
Q: How do you add a response header safely from middleware?
A: `context.Response.OnStarting(...)` before calling `next` — headers can't change after the response has started.
Q: Where do scoped services go in convention-based middleware?
A: As `InvokeAsync` parameters (resolved per request), not the constructor (middleware is created once).
Q: Message template vs string interpolation in logs?
A: Templates (`"Order {OrderId}", id`) keep structured, queryable properties and skip work when the level is off.
Q: What's a log scope for?
A: Attaching properties (correlation id, order id) to every log line written inside it.
Q: How do multiple `IExceptionHandler`s work?
A: Tried in registration order until one returns `true`.
Q: What lifetime does `AddExceptionHandler<T>()` give the handler?
A: Singleton — so no scoped services (like `DbContext`) in its constructor.
Q: Why log the exception object instead of `ex.Message`?
A: `LogError(ex, "…")` keeps type, stack trace and inner exceptions; the message alone loses the part you need to debug.
Q: What should a 500 response contain?
A: Generic ProblemDetails + trace/correlation id. Never exception messages or stack traces.
Q: What does a CORS preflight look like?
A: `OPTIONS` with `Origin`, `Access-Control-Request-Method` (and `-Headers`); the server answers with `Access-Control-Allow-*` headers.
Q: Does CORS protect your API from attackers?
A: No. It only governs what browsers let JavaScript read; non-browser clients ignore it.
:::

## Recap

- Middleware forms an onion: first registered = outermost. Order decides what wraps what.
- Write middleware inline (`app.Use`), as a class (`UseMiddleware<T>`, scoped deps in `InvokeAsync`) or
  as `IMiddleware`. Use `OnStarting` for headers. Check the built-in middleware first.
- Log with `ILogger<T>` and **message templates**; configure levels per category; use scopes for
  correlation; never log secrets or PII; log the exception object.
- Global errors: `AddProblemDetails` + `IExceptionHandler`s (singletons) + `UseExceptionHandler()`
  first. Map known exceptions to 4xx, everything else to a generic 500 with a `traceId`; log it once,
  with the exception object and the trace id.
- CORS: exact origins from configuration, `UseCors` early, preflights for JSON/auth requests, no
  `AllowAnyOrigin` with credentials — or avoid it in dev with the Vite proxy. It's not API security.
