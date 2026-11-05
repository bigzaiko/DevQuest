---
id: be-06
title: Your First Minimal API
level: beginner
minutes: 50
xp: 150
summary: WebApplication and the builder, MapGet/MapPost, parameter binding, System.Text.Json, Results vs TypedResults, launchSettings, OpenAPI with Scalar, .http files — and a tested Todo API.
---

ASP.NET Core **Minimal APIs** are the modern way to build HTTP APIs in .NET: a handful of lines in
`Program.cs`, no controllers required, and performance that sits near the top of the TechEmpower
benchmarks. If you've written Express or Fastify, the shape will feel familiar — with static types,
automatic JSON binding and generated OpenAPI on top.

## The smallest API

```bash
dotnet new web -o HelloApi
cd HelloApi
dotnet run
```

```csharp
// Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => "Hello World!");

app.Run();
```

Those four lines are the skeleton of **every** ASP.NET Core app, so it's worth knowing what each does.

### 1. `WebApplication.CreateBuilder(args)` — configure

The builder sets up the **host** with sensible defaults:

- **Configuration** from `appsettings.json`, `appsettings.{Environment}.json`, user secrets (in
  Development), environment variables and command-line args (be-08).
- **Logging** to the console (be-09).
- **Dependency injection** container: `builder.Services` (be-08).
- **Kestrel**, the cross-platform web server built into ASP.NET Core.

Everything you *register* goes on the builder: `builder.Services.AddSomething()`.

### 2. `builder.Build()` — freeze

Build creates the `WebApplication`. After this point the service collection is **read-only**: adding
services throws `InvalidOperationException`.

### 3. `app.Use…()` / `app.Map…()` — the pipeline and the endpoints

On `app` you add **middleware** (be-09) and **endpoints**. Middleware is code that every request
passes through on the way in and out (logging, HTTPS redirection, authentication). An endpoint = HTTP
method + route template + handler (a lambda or method) — the code that finally produces the response
for one specific URL.

### 4. `app.Run()` — listen

Starts Kestrel and blocks until shutdown (Ctrl+C or SIGTERM from Docker/Kubernetes).

```text
CreateBuilder ──► builder.Services.Add…()  ──► Build() ──► app.Use…() / app.Map…() ──► Run()
   (config, logging, DI, Kestrel)                (frozen)    (middleware + endpoints)     (listen)
```

:::info title="Minimal APIs vs controllers"
ASP.NET Core also has **MVC controllers** (`[ApiController]` classes with `[HttpGet]` methods,
`dotnet new webapi --use-controllers`). They're still fully supported and you'll find them in many
existing codebases. Minimal APIs are the default for new projects in current templates: less ceremony,
faster startup, AOT-friendly. The concepts — routing, binding, DI, results, filters — map one to one.
:::

## Routes and HTTP methods

```csharp
app.MapGet("/todos", () => …);                  // read collection
app.MapGet("/todos/{id}", (int id) => …);       // read one
app.MapPost("/todos", (CreateTodo input) => …); // create
app.MapPut("/todos/{id}", (int id, UpdateTodo input) => …);   // replace
app.MapPatch("/todos/{id}", …);                 // partial update
app.MapDelete("/todos/{id}", (int id) => …);    // delete
```

**Route parameters** are `{name}` segments. **Route constraints** restrict what matches:

```csharp
app.MapGet("/todos/{id:int}", (int id) => …);          // only integers
app.MapGet("/users/{username:minlength(3)}", …);
app.MapGet("/files/{*path}", (string path) => …);      // catch-all: the rest of the URL
app.MapGet("/orders/{id:guid}", (Guid id) => …);
```

If a constraint doesn't match (`/todos/abc` for `{id:int}`), the route simply **doesn't match** and the
request gets a **404** — your handler never runs. Constraints are for routing (disambiguation), not
validation; validate input properly (be-07).

## Parameter binding: where does each argument come from?

ASP.NET Core inspects your handler's parameters and figures out where each one comes from:

```csharp
app.MapGet("/products/{id:int}", (int id, string? sort, int page, ProductStore store, HttpContext ctx) => …);
```

| Parameter | Source | Why |
|---|---|---|
| `int id` | **Route** | Name matches `{id}` |
| `string? sort`, `int page` | **Query string** (`?sort=name&page=2`) | Simple type, not in the route |
| `ProductStore store` | **DI container** | Registered as a service |
| `HttpContext ctx` | **Special** | Also `HttpRequest`, `HttpResponse`, `CancellationToken`, `ClaimsPrincipal` |
| A complex type (`CreateTodo input`) | **JSON body** (POST/PUT/PATCH) | Complex types come from the body |

A **simple type** here means a type that can be parsed from a single string: `int`, `long`, `bool`,
`decimal`, `Guid`, `DateTime`, enums, `string` — technically anything with a static `TryParse`. Anything
else (a record, a class, a list) is a **complex type**.

Rules worth remembering:

- A non-nullable simple parameter (`int page`) is **required**: missing → `400 Bad Request`. Make it
  optional with `int? page` or a default value `int page = 1`.
- Unparseable values (`?page=abc`) → `400`.
- Only **one** parameter can come from the body.
- A complex type that is **not registered in DI** is assumed to be the body. Forget
  `builder.Services.AddSingleton<ProductStore>()` and a `POST` handler silently tries to read
  `ProductStore` from the request JSON; with a `GET` handler, the app can't build its endpoint
  list: startup still succeeds, but from the first request on, **every** endpoint (even `/`)
  returns 500 with `InvalidOperationException: Body was inferred but the method does not allow
  inferred body parameters`. If you see that message, check your service registrations first.
- When inference isn't what you want, be explicit: `[FromRoute]`, `[FromQuery]`, `[FromBody]`,
  `[FromHeader(Name = "X-Tenant")]`, `[FromServices]`, `[FromForm]`.
- Group many parameters into one object with `[AsParameters]`:

```csharp
public record ProductQuery(string? Search, int Page = 1, int PageSize = 20);

app.MapGet("/products", ([AsParameters] ProductQuery q, ProductStore store) => store.Search(q));
```

## JSON with System.Text.Json

Return an object and ASP.NET Core serializes it to JSON with **System.Text.Json** (STJ), using **web
defaults**:

```csharp
public record Todo(int Id, string Title, bool IsDone);

app.MapGet("/todos/1", () => new Todo(1, "Learn APIs", false));
// {"id":1,"title":"Learn APIs","isDone":false}
```

- Property names become **camelCase** (`IsDone` → `isDone`) — exactly what a TypeScript frontend expects.
- Deserialization is **case-insensitive** (`{"ISDONE": true}` binds).
- **Enums serialize as numbers** by default (`"status": 1`). Most teams switch to strings so the API is
  readable and reordering enum members doesn't silently change the contract:

```csharp
using System.Text.Json.Serialization;

builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter());
});
```

- `DateTime`/`DateTimeOffset` use ISO 8601 (`"2026-01-02T03:04:05Z"`), `decimal` stays exact.
- Records with positional parameters deserialize through their constructor.

:::pro title="Contracts are forever"
Once a frontend or a partner integrates with your JSON, renaming a property is a breaking change. Use
dedicated request/response types (DTOs, be-07) instead of serializing database entities, so internal
refactors can't change the API by accident. Teams often add a "contract test" that snapshots the
OpenAPI document and fails CI when it changes unexpectedly.
:::

## Returning results: `Results` vs `TypedResults`

Returning a plain object gives `200 OK` with JSON (a plain `string` is sent as `text/plain`). For
other status codes you return an `IResult` — an object that knows how to write a complete response
(status code, headers, body). The static `Results` class has factory methods for the common ones:

```csharp
app.MapGet("/todos/{id:int}", (int id, TodoStore store) =>
{
    var todo = store.Find(id);
    return todo is null ? Results.NotFound() : Results.Ok(todo);
});
```

**`TypedResults`** does the same but returns **concrete types** (`Ok<Todo>`, `NotFound`,
`Created<Todo>`…). Combine them with `Results<T1, T2, …>` as the return type:

```csharp
using Microsoft.AspNetCore.Http.HttpResults;

app.MapGet("/todos/{id:int}", Results<Ok<Todo>, NotFound> (int id, TodoStore store) =>
    store.Find(id) is { } todo ? TypedResults.Ok(todo) : TypedResults.NotFound());
```

Why bother?

1. **OpenAPI knows every response.** The generated docs list `200` with a `Todo` schema *and* `404` —
   without extra attributes.
2. **Compile-time checks.** Returning something not in the union is a compile error.
3. **Unit-testable.** You can call a handler method directly and assert `Assert.IsType<Ok<Todo>>(result)`.

| Helper | Status | Typical use |
|---|---|---|
| `TypedResults.Ok(value)` | 200 | Successful read/update with a body |
| `TypedResults.Created(uri, value)` | 201 + `Location` header | Resource created |
| `TypedResults.NoContent()` | 204 | Successful update/delete with no body |
| `TypedResults.BadRequest(…)` / `ValidationProblem(errors)` | 400 | Invalid input |
| `TypedResults.NotFound()` | 404 | Unknown id |
| `TypedResults.Conflict(…)` | 409 | Duplicate / state conflict |
| `TypedResults.Problem(…)` | any (default 500) | RFC 9457 problem details (be-07) |

:::warn title="Returning null is not a 404"
`app.MapGet("/todos/{id}", (int id, TodoStore s) => s.Find(id));` returns **`200 OK` with body
`null`** for an unknown id. Frontends then crash on `todo.title`. Always map "not found" to
`NotFound()` explicitly.
:::

## `launchSettings.json`: how `dotnet run` starts your app

`Properties/launchSettings.json` is used by `dotnet run` and IDEs (never in production):

```json
{
  "$schema": "https://json.schemastore.org/launchsettings.json",
  "profiles": {
    "http": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": true,
      "applicationUrl": "http://localhost:5214",
      "environmentVariables": {
        "ASPNETCORE_ENVIRONMENT": "Development"
      }
    },
    "https": {
      "commandName": "Project",
      "applicationUrl": "https://localhost:7135;http://localhost:5214",
      "environmentVariables": {
        "ASPNETCORE_ENVIRONMENT": "Development"
      }
    }
  }
}
```

- The first profile is the default; pick another with `dotnet run --launch-profile https`.
- `applicationUrl` sets the ports (randomised per project at creation).
- `ASPNETCORE_ENVIRONMENT=Development` is why you get the developer exception page and user secrets
  locally. In Docker/Kubernetes you set environment variables and URLs yourself
  (`ASPNETCORE_URLS`, or the default port `8080` in official images).
- For HTTPS locally, trust the dev certificate once: `dotnet dev-certs https --trust`.

## OpenAPI and interactive docs

ASP.NET Core 9+ generates **OpenAPI** documents natively with `Microsoft.AspNetCore.OpenApi`
(.NET 10 produces OpenAPI **3.1**). The `webapi` template includes it; for a `web` project add it:

```bash
dotnet add package Microsoft.AspNetCore.OpenApi
dotnet add package Scalar.AspNetCore        # a modern interactive UI for the document
```

```csharp
using Scalar.AspNetCore;

builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();              // GET /openapi/v1.json
    app.MapScalarApiReference();   // GET /scalar — try requests in the browser
}
```

Swashbuckle (`Swashbuckle.AspNetCore`, with Swagger UI at `/swagger`) was the template default up to
.NET 8 and is still common in existing projects. Either way, the OpenAPI document is the important
part: frontend teams generate TypeScript clients from it (`openapi-typescript`, `orval`, NSwag,
Kiota), so the docs and the client never drift apart.

Enrich endpoints with metadata:

```csharp
app.MapGet("/todos/{id:int}", GetTodo)
   .WithName("GetTodo")                 // operationId, also used for link generation
   .WithSummary("Get a todo by id")
   .WithTags("Todos");
```

### The document is a contract for the React client

Once the frontend generates its types from `/openapi/v1.json`, every inaccuracy in the document becomes a
wrong type in TypeScript. The backend's job is to make the document tell the truth:

- **Declare every outcome.** A handler returning `Results<Ok<TodoDto>, NotFound>` (see `TypedResults` above) documents both
  the 200 body and the 404. A handler returning plain `IResult` documents nothing, and the generated
  client types its response as `unknown`.
- **Nullability flows through.** With nullable reference types on, `string? Notes` becomes an optional or
  nullable field in the schema and `string | null` in TypeScript. Lying with `!` lies to the frontend too.
- **Enums as strings.** By default enums serialize as numbers (be-02). Configure
  `JsonStringEnumConverter` and the schema shows the member names (`"Open" | "Done"`; pass
  `JsonNamingPolicy.CamelCase` to the converter for `"open"`) instead of `0 | 1`.
- **Commit the document, and check it in CI.** The `Microsoft.Extensions.ApiDescription.Server` package
  writes the OpenAPI JSON on every `dotnet build` (into `obj/` by default; set
  `<OpenApiDocumentsDirectory>$(MSBuildProjectDirectory)</OpenApiDocumentsDirectory>` in the `.csproj` to put it next to the
  project). With the file in git, every API change shows up as a diff in the pull request, and the
  frontend can regenerate its client without starting your server.

The frontend half (generating `schema.d.ts` with `openapi-typescript` and a typed `openapi-fetch` client)
is in the frontend lesson **Server State with TanStack Query**.

## `.http` files: requests next to your code

Visual Studio, Rider and VS Code (with the **REST Client** extension) can run requests from a `.http`
file — a lightweight Postman that lives in git:

```http
@host = http://localhost:5214

### List todos
GET {{host}}/todos
Accept: application/json

### Create a todo
POST {{host}}/todos
Content-Type: application/json

{
  "title": "Learn minimal APIs"
}

### Get one
GET {{host}}/todos/1
```

`###` separates requests; `@name = value` defines variables, used as `{{name}}`. A blank line separates
the headers from the body — forget it and the JSON is read as a (broken) header. Committing a `.http`
file per feature is a great way to document an API for teammates; never commit real tokens in it.

:::job title="What you'll find in a real minimal-API codebase"
Not one 2 000-line `Program.cs`. Teams group endpoints per feature with **route groups** and extension
methods, so `Program.cs` stays a short table of contents:

```csharp
// Program.cs
app.MapTodoEndpoints();

// Todos/TodoEndpoints.cs
public static class TodoEndpoints
{
    public static IEndpointRouteBuilder MapTodoEndpoints(this IEndpointRouteBuilder app)
    {
        var todos = app.MapGroup("/todos").WithTags("Todos");   // shared prefix + metadata
        todos.MapGet("/", GetAll);
        todos.MapGet("/{id:int}", GetById);
        return app;
    }

    static Ok<IReadOnlyList<Todo>> GetAll(TodoStore store) => TypedResults.Ok(store.All());
    static Results<Ok<Todo>, NotFound> GetById(int id, TodoStore store) =>
        store.Find(id) is { } t ? TypedResults.Ok(t) : TypedResults.NotFound();
}
```

Expect named handler methods (easy to unit-test), `TypedResults`, a `.http` file per feature and
`WebApplicationFactory` tests in CI. Reviewers will flag endpoints that return `null`, entities instead
of DTOs, or `200` where `201`/`204`/`404` is correct.
:::

## Testing with `WebApplicationFactory`

The best tests for an API send **real HTTP requests** through the **real pipeline** — routing,
binding, JSON, status codes — without opening a port. `Microsoft.AspNetCore.Mvc.Testing` provides
`WebApplicationFactory<Program>`, which boots your app in memory on a `TestServer`:

```csharp
public class TodoTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Root_returns_hello()
    {
        var client = factory.CreateClient();         // HttpClient wired to the in-memory server
        var text = await client.GetStringAsync("/");
        Assert.Equal("Todo API", text);
    }
}
```

- `IClassFixture<T>` makes xUnit create **one** factory per test class (one app instance, shared).
- `Program` is the class the compiler generates for your top-level statements. In .NET 10 it's
  generated as `public`, so tests can reference it with no extra code (older versions needed
  `public partial class Program { }` at the bottom of `Program.cs`).
- These are **integration tests**: fast (milliseconds each), and they catch what unit tests miss —
  a wrong route, a missing service registration, camelCase JSON, a 200 that should be 201.

:::info title="Where testing is taught in full"
From here on, every lab ships tests like this one. You only need the basics from the be-01 lab box
(`[Fact]`, `Assert`, `dotnet test`) plus the factory above. **Testing .NET Code with xUnit** (be-14)
covers theories, fixtures, test doubles and fake time. **Integration Tests with WebApplicationFactory
& Testcontainers** (be-15) customizes the factory, swaps services and runs against a real PostgreSQL.
be-14 only builds on this lesson and be-08 (injecting `TimeProvider`), so you can take it right after be-08 if you prefer.
:::

## Check yourself

:::quiz id=be-06-q1
For `GET /products/42?sort=price`, where does each parameter come from?

```csharp
app.MapGet("/products/{id:int}", (int id, string? sort, ProductStore store) => …);
```

- [ ] All three from the query string
- [x] `id` from the route, `sort` from the query string, `store` from the DI container
- [ ] `id` and `sort` from the route, `store` from the body
- [ ] `store` from the JSON body
> Names matching route segments bind from the route; other simple types bind from the query; registered services are injected from DI. `sort` isn't in the route template, so it can't come from the route, and a GET request has no JSON body to read `store` from — `ProductStore` is a registered service. Complex types that are *not* services would be read from the JSON body (on POST/PUT/PATCH).
:::

:::quiz id=be-06-q2
What does `GET /todos/abc` return?

```csharp
app.MapGet("/todos/{id:int}", (int id) => $"Todo {id}");
```

- [ ] `400 Bad Request` — `abc` isn't an int
- [x] `404 Not Found` — the route doesn't match, so no endpoint handles it
- [ ] `200` with `Todo 0`
- [ ] `500` — parsing throws
> Route constraints take part in **matching**. `abc` doesn't satisfy `:int`, so this endpoint isn't a candidate at all, and with no other match the result is 404. Without the constraint (`{id}`), binding would fail instead and you'd get a 400.
:::

:::quiz id=be-06-q3
Spot the bug: the frontend crashes with `Cannot read properties of null (reading 'title')` for unknown ids.

```csharp
app.MapGet("/todos/{id:int}", (int id, TodoStore store) => store.Find(id));   // Find returns Todo?
```

- [ ] The route needs `{id:guid}`
- [x] For an unknown id the handler returns `null`, which is sent as `200 OK` with body `null`; return `NotFound()` explicitly
- [ ] `TodoStore` must be `[FromServices]`
- [ ] `Find` must be async
> A `null` return value is serialized as the JSON literal `null` with status 200 — the server says "success" and the client trusts it. Use `store.Find(id) is { } t ? TypedResults.Ok(t) : TypedResults.NotFound()`. The other options don't touch the cause: the route already matches, `TodoStore` is correctly injected from DI without `[FromServices]`, and making `Find` async would still return `null`.
:::

:::quiz id=be-06-q4
A C# `record Todo(int Id, string Title, bool IsDone, TodoStatus Status)` (with `enum TodoStatus { Open, InProgress }`) is returned with default settings. What JSON do you get for `new Todo(1, "x", false, TodoStatus.InProgress)`?

- [ ] `{"Id":1,"Title":"x","IsDone":false,"Status":"InProgress"}`
- [x] `{"id":1,"title":"x","isDone":false,"status":1}`
- [ ] `{"id":1,"title":"x","isDone":false,"status":"InProgress"}`
- [ ] `{"id":"1","title":"x","isDone":"false","status":"1"}`
> ASP.NET Core's web defaults use camelCase names (so not `"Id"`), and enums are serialized as their **numeric** value (`InProgress` is the second member → `1`) unless you add `JsonStringEnumConverter`. The camelCase-plus-string-enum option is what most teams *configure*, which is why it's tempting — but it isn't the default. Numbers and booleans are never quoted.
:::

:::quiz id=be-06-q5
What's the main advantage of `Results<Ok<Todo>, NotFound>` + `TypedResults` over `IResult` + `Results`?

- [ ] It's faster at runtime
- [x] The return type documents every possible response, so OpenAPI lists both 200 (with schema) and 404, and the compiler rejects other results
- [ ] It enables JSON serialization
- [ ] It's required for async handlers
> `IResult` is opaque: OpenAPI can't see inside, so it can't know a handler might return 404. Typed results carry the status code and body type in the signature, which feeds OpenAPI metadata and makes handlers unit-testable. Runtime speed is essentially the same, JSON serialization works with either, and async handlers can return `IResult` just fine (`Task<IResult>`).
:::

:::quiz id=be-06-q6
What happens when this app starts?

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
builder.Services.AddSingleton<TodoStore>();   // ← here
app.MapGet("/", () => "hi");
app.Run();
```

- [ ] Nothing special — order doesn't matter
- [x] Adding a service after `Build()` throws `InvalidOperationException` (the collection is read-only)
- [ ] `MapGet` must come before `Build()`
- [ ] `app.Run()` must be awaited
> `Build()` creates the service provider from the registrations made so far and locks the collection, so it fails at startup with `InvalidOperationException` — order matters. Register services on `builder.Services` **before** `Build()`; map endpoints and middleware on `app` **after** (so `MapGet` after `Build()` is correct). `app.Run()` is synchronous and blocks; `await app.RunAsync()` also exists.
:::

:::quiz id=be-06-q7
Why is `app.MapOpenApi()` / `MapScalarApiReference()` usually wrapped in `if (app.Environment.IsDevelopment())`?

- [ ] OpenAPI only works in Development
- [x] Publishing a full map of your API (and an interactive console) on a public production host is unnecessary attack surface; many teams expose it only internally or in dev/staging
- [ ] It slows down production by 50 %
- [ ] Scalar requires the dev certificate
> It's a security/hygiene choice, not a technical limit: OpenAPI works in any environment, the cost per request is negligible, and Scalar doesn't need the dev certificate. Public APIs do publish OpenAPI on purpose — then it's a deliberate decision, often behind auth. Some teams generate the document at build time instead.
:::

:::quiz id=be-06-q8
Your test calls `factory.CreateClient()` from a `WebApplicationFactory<Program>`. What actually happens?

- [ ] It starts Kestrel on a random port and calls it over TCP
- [x] It boots your real app in memory on a `TestServer`; the `HttpClient` sends requests straight into the pipeline
- [ ] It mocks all endpoints
- [ ] It runs the app in a Docker container
> No network, no ports — but the **real** middleware, routing, binding, DI and JSON. Nothing is mocked unless you choose to replace a service, and no container is involved. That's why these integration tests are both fast and trustworthy. You can still override services or configuration per test (be-08).
:::

:::quiz id=be-06-q9
`TodoStore` is a class, but the developer **forgot** `builder.Services.AddSingleton<TodoStore>()`. What happens on `GET /todos`?

```csharp
app.MapGet("/todos", (TodoStore store) => store.All());
```

- [ ] ASP.NET Core creates a new `TodoStore` automatically for each request
- [ ] The parameter is `null`, so the handler throws `NullReferenceException`
- [x] Binding treats the unregistered complex type as the JSON **body**, which GET doesn't allow: the request fails with `InvalidOperationException: Body was inferred but the method does not allow inferred body parameters`
- [ ] `404 Not Found`, because the endpoint isn't registered
> Binding decides per parameter: route name? query-able simple type? registered service? Otherwise a complex type is assumed to be the body. For GET that inference is refused, so ASP.NET Core can't build the endpoint list: every request to the app — not only `/todos` — fails with a 500 and that exact message. DI never invents instances of unregistered types, and the endpoint itself *is* mapped (so not a 404). On a POST the same mistake is quieter — the store would be deserialized from the request JSON — which is why "check the registrations" is the first reflex.
:::

:::quiz id=be-06-q10
What does `GET /products` (no query string) return?

```csharp
app.MapGet("/products", (int page) => $"Page {page}");
```

- [ ] `200` with `Page 0`
- [ ] `200` with `Page 1`
- [x] `400 Bad Request` — a non-nullable `int` query parameter is required
- [ ] `404 Not Found`
> `int page` isn't in the route, so it's bound from the query string, and because it's non-nullable without a default it's **required**: missing → 400 (the route itself matched, so not 404). C# doesn't silently use `default(int)` here. Write `int page = 1` for an optional parameter with a default, or `int? page` to detect "not provided".
:::

## Lab: a tested Todo API

:::lab id=be-06-lab1 xp=120
title: Todo API with OpenAPI, a .http file and WebApplicationFactory tests

**1. Create the solution**

```bash
mkdir TodoApi && cd TodoApi
dotnet new sln -n TodoApi
dotnet new web -o src/TodoApi
dotnet new xunit -o tests/TodoApi.Tests
dotnet sln add src/TodoApi tests/TodoApi.Tests
dotnet add tests/TodoApi.Tests reference src/TodoApi
dotnet add src/TodoApi package Microsoft.AspNetCore.OpenApi
dotnet add src/TodoApi package Scalar.AspNetCore
dotnet add tests/TodoApi.Tests package Microsoft.AspNetCore.Mvc.Testing
rm tests/TodoApi.Tests/UnitTest1.cs
```

**2. Replace `src/TodoApi/Program.cs`**

```csharp
using System.Collections.Concurrent;
using Microsoft.AspNetCore.Http.HttpResults;
using Scalar.AspNetCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddSingleton<TodoStore>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();              // serves /openapi/v1.json
    app.MapScalarApiReference();   // serves /scalar (interactive docs)
}

app.MapGet("/", () => "Todo API");

app.MapGet("/todos", (TodoStore store, bool? done) =>
{
    var items = store.All();
    return done is null ? items : items.Where(t => t.IsDone == done).ToList();
});

app.MapGet("/todos/{id:int}", Results<Ok<Todo>, NotFound> (int id, TodoStore store) =>
    store.Find(id) is { } todo ? TypedResults.Ok(todo) : TypedResults.NotFound())
    .WithName("GetTodo");

app.MapPost("/todos", Results<Created<Todo>, ValidationProblem> (CreateTodo input, TodoStore store) =>
{
    if (string.IsNullOrWhiteSpace(input.Title))
    {
        return TypedResults.ValidationProblem(new Dictionary<string, string[]>
        {
            ["title"] = ["Title is required."]
        });
    }

    var todo = store.Add(input.Title.Trim());
    return TypedResults.Created($"/todos/{todo.Id}", todo);
});

app.MapPut("/todos/{id:int}/done", Results<NoContent, NotFound> (int id, TodoStore store) =>
    store.MarkDone(id) ? TypedResults.NoContent() : TypedResults.NotFound());

app.MapDelete("/todos/{id:int}", Results<NoContent, NotFound> (int id, TodoStore store) =>
    store.Remove(id) ? TypedResults.NoContent() : TypedResults.NotFound());

app.Run();

public record Todo(int Id, string Title, bool IsDone);

public record CreateTodo(string Title);

// In-memory store. Singleton => shared by all requests => must be thread-safe.
public class TodoStore
{
    private readonly ConcurrentDictionary<int, Todo> _items = new();
    private int _nextId;

    public IReadOnlyList<Todo> All() => _items.Values.OrderBy(t => t.Id).ToList();

    public Todo? Find(int id) => _items.GetValueOrDefault(id);

    public Todo Add(string title)
    {
        var todo = new Todo(Interlocked.Increment(ref _nextId), title, false);
        _items[todo.Id] = todo;
        return todo;
    }

    public bool MarkDone(int id)
    {
        if (!_items.TryGetValue(id, out var todo)) return false;
        _items[id] = todo with { IsDone = true };
        return true;
    }

    public bool Remove(int id) => _items.TryRemove(id, out _);
}
```

Why `ConcurrentDictionary` and `Interlocked`? Kestrel handles requests **in parallel** on many threads,
and a singleton is shared by all of them. A plain `Dictionary` + `_nextId++` would corrupt under load.

**3. Run it and explore**

```bash
dotnet run --project src/TodoApi
```

Open `http://localhost:<port>/scalar` (port from the `Now listening on:` line in the console), create a
todo with **POST /todos**, then open `http://localhost:<port>/openapi/v1.json`. Near the top you'll see
`"openapi": "3.1.1"`; under `paths` → `/todos/{id}` → `get` → `responses` you'll find both `"200"`
(with the `Todo` schema) and `"404"` — generated purely from the `Results<Ok<Todo>, NotFound>` return
type.

(`dotnet run` uses the `http` profile from `launchSettings.json`, so the environment is `Development`
and the docs are mapped. Run with `--no-launch-profile` and you're in `Production`: `/scalar` gives 404.)

**4. Add `src/TodoApi/TodoApi.http`** (set the port to yours) and run each request from your editor:

```http
@host = http://localhost:5214

### Create
POST {{host}}/todos
Content-Type: application/json

{ "title": "Learn minimal APIs" }

### Invalid (expect 400 problem+json)
POST {{host}}/todos
Content-Type: application/json

{ "title": "   " }

### List only done
GET {{host}}/todos?done=true

### Mark done
PUT {{host}}/todos/1/done

### Unknown id (expect 404)
GET {{host}}/todos/999
```

**5. Add the tests: `tests/TodoApi.Tests/TodoEndpointsTests.cs`**

```csharp
using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace TodoApi.Tests;

public class TodoEndpointsTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client = factory.CreateClient();

    [Fact]
    public async Task Root_says_hello()
    {
        var text = await _client.GetStringAsync("/");

        Assert.Equal("Todo API", text);
    }

    [Fact]
    public async Task Post_creates_a_todo_and_returns_201_with_location()
    {
        var response = await _client.PostAsJsonAsync("/todos", new { title = "Write tests" });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var created = await response.Content.ReadFromJsonAsync<Todo>();
        Assert.NotNull(created);
        Assert.Equal("Write tests", created.Title);
        Assert.False(created.IsDone);
        Assert.Equal($"/todos/{created.Id}", response.Headers.Location?.ToString());
    }

    [Fact]
    public async Task Created_todo_can_be_fetched_by_id()
    {
        var response = await _client.PostAsJsonAsync("/todos", new { title = "Fetch me" });
        var created = await response.Content.ReadFromJsonAsync<Todo>();

        var fetched = await _client.GetFromJsonAsync<Todo>($"/todos/{created!.Id}");

        Assert.Equal(created, fetched);
    }

    [Fact]
    public async Task Unknown_id_returns_404()
    {
        var response = await _client.GetAsync("/todos/999999");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Empty_title_returns_400_validation_problem()
    {
        var response = await _client.PostAsJsonAsync("/todos", new { title = "   " });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Marking_done_then_filtering_by_done_returns_it()
    {
        var response = await _client.PostAsJsonAsync("/todos", new { title = "Finish lab" });
        var created = await response.Content.ReadFromJsonAsync<Todo>();

        var put = await _client.PutAsync($"/todos/{created!.Id}/done", content: null);
        var doneTodos = await _client.GetFromJsonAsync<List<Todo>>("/todos?done=true");

        Assert.Equal(HttpStatusCode.NoContent, put.StatusCode);
        Assert.Contains(doneTodos!, t => t.Id == created.Id && t.IsDone);
    }

    [Fact]
    public async Task Delete_removes_the_todo()
    {
        var response = await _client.PostAsJsonAsync("/todos", new { title = "Delete me" });
        var created = await response.Content.ReadFromJsonAsync<Todo>();

        var delete = await _client.DeleteAsync($"/todos/{created!.Id}");
        var after = await _client.GetAsync($"/todos/{created.Id}");

        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, after.StatusCode);
    }
}
```

Notice the tests never assume a specific id: all tests in the class share one app (and one singleton
store), and xUnit doesn't guarantee test order. Each test creates the data it needs.

**6. Run the tests**

```bash
dotnet test
```

Expected:

```text
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7, Duration: 240 ms - TodoApi.Tests.dll (net10.0)
```

If you get `CS0122`/`CS0246` errors about `Program` or `Todo`, check that the test project references
`src/TodoApi` (step 1) — no `public partial class Program` is needed on .NET 10.

**7. Extension (optional):** add `GET /todos/stats` returning `{ "total": n, "done": m }` and write a
test for it first.

- [ ] `dotnet test` passes all 7 tests
- [ ] I opened `/scalar` and `/openapi/v1.json` and saw the documented 404
- [ ] I ran the `.http` requests and saw 201, 400, 204 and 404
- [ ] I can explain why `TodoStore` uses `ConcurrentDictionary`
:::

## Flashcards

:::cards id=be-06-cards1 title="Minimal APIs"
Q: The four steps of every ASP.NET Core `Program.cs`?
A: `CreateBuilder` (config/logging/DI/Kestrel) → register services → `Build()` → add middleware + endpoints → `Run()`.
Q: Where do minimal API parameters bind from?
A: Route (name matches a segment), query (other simple types), body (complex type), DI (registered services), special types (`HttpContext`, `CancellationToken`…).
Q: What happens when a route constraint doesn't match?
A: The endpoint isn't selected → 404 (if nothing else matches).
Q: What happens if a handler's complex-type parameter isn't registered in DI?
A: It's inferred as the JSON body. On GET that's refused: `InvalidOperationException: Body was inferred…`, and every endpoint returns 500. Check `builder.Services`.
Q: Default JSON naming in ASP.NET Core?
A: camelCase property names, case-insensitive reading; enums as numbers unless `JsonStringEnumConverter` is added.
Q: `Results` vs `TypedResults`?
A: `TypedResults` returns concrete types (`Ok<T>`, `NotFound`…) — usable in `Results<…>` unions for OpenAPI metadata and unit tests.
Q: What does `TypedResults.Created(uri, value)` send?
A: `201 Created`, a `Location` header with the URI, and the value as JSON.
Q: What is `launchSettings.json` for?
A: Local `dotnet run`/IDE profiles: URLs, environment variables (`ASPNETCORE_ENVIRONMENT`). Not used in production.
Q: Built-in OpenAPI in .NET 10?
A: `builder.Services.AddOpenApi()` + `app.MapOpenApi()` → `/openapi/v1.json` (OpenAPI 3.1). Add a UI like Scalar or Swagger UI.
Q: What does `WebApplicationFactory<Program>` do?
A: Boots the real app in memory (TestServer) and gives you an `HttpClient` — integration tests without ports.
:::

## Recap

- Every app: `CreateBuilder` → `builder.Services` → `Build()` → middleware/endpoints → `Run()`.
- `MapGet/MapPost/MapPut/MapDelete` + route templates; constraints like `{id:int}` affect matching.
- Parameters bind from route, query, body, DI or special types — be explicit with `[From…]` when needed.
- System.Text.Json uses camelCase; add `JsonStringEnumConverter` for readable enums.
- Prefer `TypedResults` with `Results<…>` return types: correct status codes, accurate OpenAPI, testable
  handlers. Never return `null` for "not found".
- `launchSettings.json` is local-only; OpenAPI is built in, with Scalar or Swagger UI on top; `.http`
  files document requests in git.
- `WebApplicationFactory<Program>` gives fast, realistic integration tests.
