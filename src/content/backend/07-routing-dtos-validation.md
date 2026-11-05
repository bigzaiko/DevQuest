---
id: be-07
title: Route Groups, DTOs, Validation & ProblemDetails
level: intermediate
minutes: 55
xp: 150
summary: Organise endpoints with route groups, separate DTOs from entities, validate input with .NET 10's built-in validation (or FluentValidation), return RFC 9457 ProblemDetails, pick the right status code every time — and evolve the contract with versions and safe file uploads.
---

The Todo API from be-06 works, but it has habits that don't survive a real team: every endpoint in
`Program.cs`, the same type used for storage and for JSON, hand-rolled validation, and error bodies in
whatever shape the handler felt like. This lesson fixes all four — the patterns here are what reviewers
expect in a production ASP.NET Core API.

## Route groups: organise endpoints

**Why:** five product endpoints usually share a URL prefix, an OpenAPI tag, an auth policy and maybe a
rate limit. Repeating all of that on every `MapGet`/`MapPost` is noisy, and the day someone forgets
`.RequireAuthorization()` on one of them, you have a security hole. A **route group** states the shared
parts once.

**How:** `MapGroup` creates a prefix that endpoints (and their metadata) share:

```csharp
var products = app.MapGroup("/api/products")
    .WithTags("Products");                       // OpenAPI grouping for all endpoints below

products.MapGet("/", ListProducts);              // GET    /api/products
products.MapGet("/{id:int}", GetProduct);        // GET    /api/products/42
products.MapPost("/", CreateProduct);            // POST   /api/products
products.MapPut("/{id:int}", UpdateProduct);     // PUT    /api/products/42
products.MapDelete("/{id:int}", DeleteProduct);  // DELETE /api/products/42
```

Anything you can attach to an endpoint, you can attach to a group: `.RequireAuthorization()`,
`.AddEndpointFilter<…>()`, `.RequireRateLimiting("…")`, `.WithSummary(…)`/`.WithDescription(…)`.
Groups can nest (`api.MapGroup("/v1").MapGroup("/products")`), which is handy for versioning.

:::info title="`{id:int}` is a route constraint, not validation"
The `:int` part is a **route constraint**: the route only *matches* if that URL segment parses as an
`int`. So `GET /api/products/abc` doesn't reach your handler with a bad value — it matches **no**
endpoint and the client gets a **404**, not a 400. Constraints exist to pick between routes
(`/{id:int}` vs `/{slug}`), not to produce friendly error messages. Range rules such as "id must be
positive" belong in validation (below).
:::

:::warn title="`WithOpenApi()` is deprecated in .NET 10"
Older tutorials chain `.WithOpenApi(op => …)` on endpoints. In .NET 10 the built-in
`Microsoft.AspNetCore.OpenApi` generator picks up endpoint metadata automatically and `WithOpenApi`
is marked obsolete (you'll get a deprecation warning). Use `.WithSummary()`, `.WithDescription()`, `.WithTags()`
and `.Produces…()` instead, or an OpenAPI *operation transformer* for advanced cases.
:::

### Endpoints out of `Program.cs`

The convention most teams use: one static class per feature with a `Map…Endpoints` extension method,
and handlers as **named static methods** (easier to read, test and navigate than 40-line lambdas):

```csharp
namespace Catalog.Api.Products;

public static class ProductEndpoints
{
    public static IEndpointRouteBuilder MapProductEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/products").WithTags("Products");

        group.MapGet("/{id:int}", GetById).WithName("GetProductById");
        group.MapPost("/", Create);
        // …
        return app;
    }

    private static Results<Ok<ProductResponse>, NotFound> GetById(int id, ProductRepository repo) =>
        repo.Find(id) is { } p ? TypedResults.Ok(p.ToResponse()) : TypedResults.NotFound();

    // …
}

// Program.cs stays short:
app.MapProductEndpoints();
app.MapOrderEndpoints();
```

This "feature folder" layout (`Products/ProductEndpoints.cs`, `Products/ProductDtos.cs`,
`Products/Product.cs`) scales well: everything about one feature lives together.

Two details in that handler are worth a second look:

- **`TypedResults` + `Results<…>`.** `TypedResults.Ok(x)` returns a concrete type (`Ok<ProductResponse>`)
  instead of the generic `IResult` that `Results.Ok(x)` returns. The union return type
  `Results<Ok<ProductResponse>, NotFound>` lists *every* response the handler can produce, so the
  compiler stops you from returning something undeclared, OpenAPI documents both responses
  automatically, and unit tests can assert on the result type without an HTTP call.
- **Parameter sources are inferred.** `int id` comes from the route (its name matches `{id}`), and
  `ProductRepository repo` comes from DI because it's a registered service. Complex types like
  `CreateProductRequest` are read from the JSON body.

## DTOs vs entities

An **entity** is your internal model — what you store, with every field your business logic needs. A
**DTO** (Data Transfer Object) is the shape of the data that crosses the API boundary. They look
similar at first, which is exactly why people skip the DTO — until one of these happens:

1. **Leaking data.** You add `CostPrice` or `PasswordHash` to the entity, and because the endpoint
   returns the entity, it's now in every API response.
2. **Over-posting (mass assignment).** The client sends `{"name": "x", "isAdmin": true}` to a
   "update profile" endpoint that binds directly to the `User` entity. Congratulations, they're admin.
3. **Coupling.** Renaming a database column renames a JSON property and breaks the mobile app.
4. **Serialization cycles.** `Order.Customer.Orders[0].Customer…` → a JSON cycle error or a 5 MB response.

So: **one request DTO per operation, one response DTO per shape**, and explicit mapping.

```csharp
// What clients SEND to create a product
public record CreateProductRequest(string Name, string Sku, decimal Price);

// What clients SEND to update (SKU is immutable, so it's not even here — over-posting is impossible)
public record UpdateProductRequest(string Name, decimal Price);

// What clients RECEIVE
public record ProductResponse(int Id, string Name, string Sku, decimal Price);

// The entity: internal, mutable, may grow fields clients never see
public class Product
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string Sku { get; set; }
    public decimal Price { get; set; }
    public decimal CostPrice { get; set; }           // secret!
    public DateTimeOffset CreatedAt { get; set; }

    public ProductResponse ToResponse() => new(Id, Name, Sku, Price);
}
```

**Records are perfect DTOs:** concise, immutable, value equality (great in tests), and positional
records deserialize through their constructor.

:::pro title="Mapping: by hand, Mapperly, or AutoMapper?"
Hand-written mapping (`ToResponse()`, or a static `ProductMappings` class) is explicit, debuggable and
refactor-safe — the compiler tells you when a property is missing. Many teams now prefer it, or
**Mapperly**, a source generator that writes the same code for you at compile time. **AutoMapper**
(reflection-based, configured by convention) is still common in older codebases, but it hides
mappings and moves errors to runtime — and its newer versions require a commercial licence. Whatever
your team uses, the rule is the same: **never return entities from endpoints**.
:::

## Validation

Never trust input. The client might be your own React app with perfect form validation — and also
`curl`, a bot, or an attacker. Validation must happen **on the server**.

### Built-in validation in .NET 10

.NET 10 added first-class validation for minimal APIs. Annotate your DTOs with **DataAnnotations**
attributes and enable it with one line:

```csharp
using System.ComponentModel.DataAnnotations;

public record CreateProductRequest(
    [Required, StringLength(100, MinimumLength = 2)] string Name,
    [Required, RegularExpression(@"^[A-Z]{3}-\d{4}$", ErrorMessage = "SKU must look like ABC-1234.")] string Sku,
    [Range(0.01, 100_000)] decimal Price);
```

```csharp
builder.Services.AddValidation();
```

Now any endpoint that takes a `CreateProductRequest` is validated **before your handler runs**. Invalid
input gets an automatic `400` with a standard body:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Name": ["The field Name must be a string with a minimum length of 2 and a maximum length of 100."],
    "Sku": ["SKU must look like ABC-1234."],
    "Price": ["The field Price must be between 0.01 and 100000."]
  }
}
```

:::info title="`Name` or `name`?"
Depending on your .NET 10 build and JSON settings, the keys in `errors` may follow the JSON naming
policy (camelCase `name`) rather than the C# property name. Don't hard-code one casing in the
frontend: match keys case-insensitively (the lab's tests accept both).
:::

Under the hood, a **source generator** finds the types your endpoints accept at compile time and
writes the validation code for them (no runtime reflection, so it works with trimming and Native AOT).
It also validates:

- route/query parameters with attributes: `([Range(1, 100)] int pageSize = 20)`;
- **nested** objects and collections (errors keyed like `Inner.Stars` or `Lines[0].Quantity`);
- cross-field rules via `IValidatableObject` — which run **after** the attribute checks pass:

```csharp
public record SignupRequest(
    [Required, EmailAddress] string Email,
    [Required, MinLength(8)] string Password,
    string ConfirmPassword) : IValidatableObject
{
    public IEnumerable<ValidationResult> Validate(ValidationContext context)
    {
        if (Password != ConfirmPassword)
            yield return new ValidationResult("Passwords do not match.", [nameof(ConfirmPassword)]);
    }
}
```

Opt a specific endpoint out with `.DisableValidation()`.

:::warn title="`[Required]` does nothing on a value type"
`[Required]` checks for `null`. A non-nullable `int Quantity` or `decimal Price` is **never** null — if
the client omits it, JSON deserialization fills in `0` and `[Required]` happily passes. Either make the
property nullable (`[Required] int? Quantity` — now "missing" really is `null`) or use a rule that
rejects the default value (`[Range(1, 99)] int Quantity`). The same trap exists for `Guid`
(`Guid.Empty`) and `DateTime` (`0001-01-01`).
:::

### FluentValidation

Many existing codebases use **FluentValidation** — rules written as code, which shines for complex,
conditional or async rules (and keeps attributes off your DTOs):

```csharp
// dotnet add package FluentValidation.DependencyInjectionExtensions
public sealed class CreateOrderValidator : AbstractValidator<CreateOrder>
{
    public CreateOrderValidator()
    {
        RuleFor(x => x.CustomerEmail).NotEmpty().EmailAddress();
        RuleFor(x => x.Lines).NotEmpty().WithMessage("An order needs at least one line.");
        RuleForEach(x => x.Lines).ChildRules(line =>
        {
            line.RuleFor(l => l.Sku).NotEmpty();
            line.RuleFor(l => l.Quantity).InclusiveBetween(1, 99);
        });
    }
}
```

Minimal APIs don't run FluentValidation automatically (the old `FluentValidation.AspNetCore`
auto-validation package is deprecated and only ever targeted MVC). Teams wire it with a small reusable
**endpoint filter** — a piece of code that runs *around* one endpoint's handler, sees its already-bound
arguments, and may short-circuit with its own response:

```csharp
public sealed class ValidationFilter<T>(IValidator<T> validator) : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var argument = context.Arguments.OfType<T>().First();
        var result = await validator.ValidateAsync(argument, context.HttpContext.RequestAborted);
        return result.IsValid
            ? await next(context)                                     // continue to the handler
            : TypedResults.ValidationProblem(result.ToDictionary());  // same 400 shape as built-in
    }
}

builder.Services.AddValidatorsFromAssemblyContaining<Program>();
app.MapPost("/orders", CreateOrder).AddEndpointFilter<ValidationFilter<CreateOrder>>();
```

`AddValidatorsFromAssemblyContaining<Program>()` scans the assembly and registers every
`AbstractValidator<T>` as `IValidator<T>`, which is what the filter's constructor asks for. Pick **one**
approach per project — running both built-in validation and FluentValidation on the same DTO gives
you two sets of rules to keep in sync.

### What validation is *not*

Format validation (required, length, range, regex) belongs in the DTO. **Business rules** that need
data — "SKU must be unique", "you can't cancel a shipped order", "stock must be available" — belong in
the handler or domain, and usually produce **409 Conflict** or **422**, not a 400. And the database
still needs its own constraints (unique index, `NOT NULL`, check constraints): two requests can pass
the "SKU is unique" check at the same moment.

## ProblemDetails: one error format for everything

Without a convention, errors come back as plain text here, `{ "error": "…" }` there, and an HTML
stack trace somewhere else. The frontend can't handle them consistently.

**RFC 9457 Problem Details** (which replaced RFC 7807) is the standard JSON error format for HTTP APIs,
with media type `application/problem+json`:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.10",
  "title": "SKU already exists",
  "status": 409,
  "detail": "A product with SKU 'ABC-1234' already exists.",
  "instance": "/api/products",
  "traceId": "00-56bc09ba5e765b5005801ffcb2f3806f-6e5e264f86e6bdbd-00"
}
```

- `type` — a URI identifying the problem type (defaults to the RFC section for the status code).
- `title` — short, human-readable, the same for every occurrence of this type.
- `status` — the HTTP status code.
- `detail` — specific to this occurrence.
- `instance` — which request/resource. Optional: ASP.NET Core doesn't fill it in by default; set it
  yourself (e.g. in `CustomizeProblemDetails`, be-09) if your clients want it.
- **extensions** — any extra members, e.g. `errors` for validation or `traceId` for support tickets.
  `AddProblemDetails()` adds `traceId` for you.

Turn it on for the whole app:

```csharp
builder.Services.AddProblemDetails();   // registers IProblemDetailsService

var app = builder.Build();
app.UseExceptionHandler();              // unhandled exceptions → 500 problem details (be-09)
app.UseStatusCodePages();               // empty 4xx/5xx responses (e.g. NotFound()) → problem details
```

Each line has a job. `AddProblemDetails()` only *registers* the writer — on its own it changes no
responses. `UseExceptionHandler()` covers crashes, and `UseStatusCodePages()` covers results that set
an error status but write no body (`TypedResults.NotFound()`, `Unauthorized()`, a 405 from routing).
Forget the last one and your 404s come back with an empty body while everything else is a problem.

And produce problems explicitly from handlers:

```csharp
return TypedResults.Problem(
    title: "SKU already exists",
    detail: $"A product with SKU '{request.Sku}' already exists.",
    statusCode: StatusCodes.Status409Conflict);
```

:::warn title="`Conflict(obj)` is not a problem response"
`TypedResults.Conflict(new ProblemDetails { … })` serializes the object with content type
`application/json`, not `application/problem+json`. Use `TypedResults.Problem(…)` (a
`ProblemHttpResult`) so the content type and the `IProblemDetailsService` customisations apply.
:::

:::job title="Frontends love a single error shape"
With ProblemDetails everywhere, the React app needs exactly one error handler: show `title`/`detail`
in a toast, and map `errors` (for 400s) onto form fields by key. When you join a team, check whether
the API already does this — and if it doesn't, it's a great first improvement to propose.
:::

## Choosing the right status code

| Code | Meaning | Use when |
|---|---|---|
| **200 OK** | Success, with a body | `GET`, or `PUT`/`PATCH` that returns the updated resource |
| **201 Created** | A resource was created | `POST` that creates; include a `Location` header pointing to it |
| **204 No Content** | Success, no body | `DELETE`, or `PUT` that returns nothing |
| **400 Bad Request** | The request is malformed or fails validation | Missing fields, wrong format, unparseable JSON |
| **401 Unauthorized** | **Not authenticated** — "who are you?" | No token, expired token, invalid signature |
| **403 Forbidden** | **Authenticated but not allowed** | Logged in, but not an admin / not your resource |
| **404 Not Found** | The resource doesn't exist (or you may not know it exists) | Unknown id |
| **409 Conflict** | Conflicts with current state | Duplicate unique value, concurrent edit (stale version), invalid state transition |
| **422 Unprocessable Content** | Well-formed but semantically invalid | Some teams use it for business-rule violations; pick 400 *or* 422 for validation and be consistent |
| **500 Internal Server Error** | Bug or unexpected failure | Never return it on purpose; let the exception handler produce it |

Two judgement calls that come up in every API review:

- **401 vs 403**: 401 means "authenticate and try again", 403 means "authenticating again won't help".
  The names are historical — 401 is really "unauthenticated".
- **404 for things you're not allowed to see**: returning 403 for `/orders/123` when it belongs to
  someone else confirms that order 123 exists. Many APIs return 404 instead.

### `Created` and `CreatedAtRoute`

A `201` should tell the client **where** the new resource lives. Hard-coding the URL works
(`TypedResults.Created($"/api/products/{id}", dto)`), but it breaks silently if the route changes.
**`CreatedAtRoute`** generates the URL from a **named** endpoint:

```csharp
group.MapGet("/{id:int}", GetById).WithName("GetProductById");

// in Create:
return TypedResults.CreatedAtRoute(product.ToResponse(), "GetProductById", new { id = product.Id });
// → 201, Location: http://localhost:5299/api/products/1
```

## Evolving the contract: versioning

Once a React app, a mobile app or a partner depends on your API, every response shape is a promise.
The question isn't "which versioning library?" but **"is this change breaking?"**

| Change | Breaking? |
|---|---|
| Add an endpoint, add a field to a response, add an **optional** request field | No. Clients must ignore fields they don't know, and `System.Text.Json` does by default |
| Rename or remove a field, change its type (`price: 9.5` → `price: { amount, currency }`) | **Yes** |
| Make an optional request field required, tighten validation | **Yes** |
| Change meaning without changing shape (`total` now includes VAT) | **Yes**, and the most dangerous kind, because nothing fails loudly |

Most changes should be additive, and additive changes need **no** new version. For the rare breaking
change, the most common approach is a version in the URL, and route groups (above) already give you
everything you need:

```csharp
var v1 = app.MapGroup("/api/v1/products").WithTags("Products v1");
var v2 = app.MapGroup("/api/v2/products").WithTags("Products v2");

v1.MapGet("/", ListProductsV1);     // price: 9.5            (kept until clients have moved)
v2.MapGet("/", ListProductsV2);     // price: { amount, currency }
```

Both versions call the same domain code and differ only in their DTOs and mapping, which is one more
reason for DTOs. If you need header- or query-based versions (`api-version: 2`), version reporting or
deprecation headers, the **`Asp.Versioning.Http`** package adds them to minimal APIs. Whatever you
choose, retire old versions on purpose: announce a date, log who still calls v1, then remove it. A
forgotten v1 that nobody patches is exactly what OWASP calls *improper inventory management* (be-13).

## File uploads: small files only

A form upload binds to `IFormFile`, and you validate it like any other input:

```csharp
app.MapPost("/api/projects/{id:guid}/attachments", async Task<Results<Created, ValidationProblem>> (
    Guid id, IFormFile file, IAttachmentStorage storage, CancellationToken ct) =>
{
    if (file.Length is 0 or > 5 * 1024 * 1024)
        return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            { ["file"] = ["Must be between 1 byte and 5 MB."] });

    var attachmentId = Guid.CreateVersion7();
    var key = $"projects/{id}/{attachmentId}";            // OUR name, never file.FileName
    await using var stream = file.OpenReadStream();
    await storage.UploadAsync(key, stream, file.ContentType, ct);
    return TypedResults.Created($"/api/projects/{id}/attachments/{attachmentId}");
})
.DisableAntiforgery();   // see below
```

What matters here:

- **Never trust the file name or the `Content-Type`.** Both come from the client. Using `file.FileName`
  as a path invites `../../appsettings.json`. Generate your own key, keep the original name only as
  display metadata, and check the content (magic bytes) if the type matters.
- **Limits exist at several levels.** Kestrel rejects bodies over 30 MB by default
  (`MaxRequestBodySize`) and form parsing has its own limits (`FormOptions`). Your handler's limit
  should be the smallest of all of them.
- **Antiforgery.** Since .NET 8, endpoints that bind forms or `IFormFile` require antiforgery validation.
  Without `app.UseAntiforgery()` the request fails with a 500 that tells you to add it. Browser apps that
  authenticate with **cookies** need the real antiforgery check. An API that only accepts **bearer
  tokens** isn't exposed to CSRF (the browser never attaches the token automatically), so
  `.DisableAntiforgery()` is the usual choice there.
- **Big files don't belong in your API at all.** Streaming 2 GB through your server ties up a request,
  memory and bandwidth. The cloud-native pattern is that the API hands out a short-lived **presigned
  URL** and the browser uploads straight to object storage. The Cloud-Native Toolkit lesson
  **Object Storage & Direct Uploads (S3)** builds that end to end, including multipart uploads and upload
  security.

## Check yourself

:::quiz id=be-07-q1
A `PUT /users/me` endpoint binds the request body straight to the EF Core `User` entity and saves it. What's the main security problem?

- [ ] PUT should be PATCH
- [x] Over-posting: a client can send fields like `isAdmin` or `email` that the form never exposed, and they'll be saved
- [ ] Entities can't be deserialized from JSON
- [ ] It returns 200 instead of 204
> Binding to the entity lets the client set **any** property the JSON names — the form only showed two fields, but `curl` can send twenty. A dedicated `UpdateProfileRequest(string DisplayName, string? Bio)` makes it impossible to touch anything else. PUT vs PATCH and 200 vs 204 are style choices, not security holes, and EF Core entities deserialize from JSON just fine — which is exactly the problem.
:::

:::quiz id=be-07-q2
`builder.Services.AddValidation()` is registered and this record is used in a `MapPost`. The client posts `{"name": "X", "sku": "ABC-1234", "price": 5}`. What happens?

```csharp
public record CreateProductRequest(
    [Required, StringLength(100, MinimumLength = 2)] string Name,
    [Required] string Sku,
    [Range(0.01, 100_000)] decimal Price);
```

- [ ] The handler runs and must check `ModelState.IsValid`
- [x] The handler never runs; the client gets 400 with `errors.Name` explaining the minimum length
- [ ] 422 with an empty body
- [ ] 500 because the attribute throws
> `"X"` is shorter than `MinimumLength = 2`. .NET 10's built-in validation runs **before** the handler and short-circuits with a `ValidationProblem` (400, `application/problem+json`, errors keyed by property). The `ModelState.IsValid` option is the MVC-controller habit: minimal APIs have no `ModelState`, and with `AddValidation()` you don't check anything yourself. Failed attributes never throw, so there's no 500.
:::

:::quiz id=be-07-q3
A user is logged in (valid JWT) but calls `DELETE /api/admin/users/7` without the `Admin` role. Which status code?

- [ ] 400
- [ ] 401
- [x] 403
- [ ] 409
> They're authenticated (so not 401), but not permitted — 403 Forbidden. 401 is the tempting answer because of its name ("Unauthorized"), but it really means *unauthenticated*: it tells the client "log in again", which won't help here. 400 and 409 describe problems with the request body or server state, and there's nothing wrong with either.
:::

:::quiz id=be-07-q4
`POST /api/products` with a SKU that already exists. Which response fits best?

- [ ] `400 Bad Request` — the input is invalid
- [x] `409 Conflict` with a problem details body explaining the duplicate SKU
- [ ] `500 Internal Server Error` from the unique index violation
- [ ] `200 OK` returning the existing product
> The request is well-formed and would succeed on an empty database — it conflicts with the **current state** of the server. That's what separates it from a 400: a 400 means "this request could never be valid, fix it". 409 + ProblemDetails tells the client exactly what happened. Letting the database exception bubble up as a 500 is the bug-shaped version of the same thing, and silently returning the existing product with 200 hides the duplicate from the caller.
:::

:::quiz id=be-07-q5
What's the benefit of `CreatedAtRoute(dto, "GetProductById", new { id })` over `Created($"/api/products/{id}", dto)`?

- [ ] It returns 200 instead of 201
- [x] The `Location` URL is generated from the named route, so it stays correct if the route template or group prefix changes
- [ ] It skips JSON serialization
- [ ] It's required for OpenAPI
> Link generation uses the endpoint's name and route values. Hard-coded strings silently drift when someone renames `/api/products` to `/api/v2/products`. Both forms return 201 and serialize the body, and OpenAPI works with either — the only difference is where the URL comes from.
:::

:::quiz id=be-07-q6
Which belong in DTO validation (DataAnnotations/FluentValidation) rather than in business logic? (select all)

- [x] `Name` is required and at most 100 characters
- [x] `Price` is between 0.01 and 100 000
- [ ] The SKU doesn't already exist in the database
- [ ] A shipped order can't be cancelled
> Shape/format rules can be checked by looking at the request alone, so they belong with the DTO. "SKU doesn't exist yet" is tempting to put in a validator too, but it needs a database query and can be invalidated by a concurrent request a millisecond later — it's a business rule (409), checked in the handler and backed by a unique index. "Can't cancel a shipped order" depends on the stored order's state, so it's a domain rule as well.
:::

:::quiz id=be-07-q7
The handler returns `TypedResults.NotFound()` (no body). With `AddProblemDetails()` and `app.UseStatusCodePages()` configured, what does the client receive?

- [ ] An empty 404
- [x] A 404 with an `application/problem+json` body containing `title: "Not Found"` and `status: 404`
- [ ] A 404 HTML page
- [ ] A 200 with `null`
> `UseStatusCodePages` fills error responses that have no body, and with `AddProblemDetails()` registered it writes the standard problem format — so even bodiless results get a consistent error shape. Without `UseStatusCodePages` you'd get the empty 404 from the first option. It never changes the status code (so not 200), and it only writes HTML if you configure it to.
:::

:::quiz id=be-07-q8
Which of these properties appear in the body of a `ValidationProblem` response? (select all)

- [x] `status: 400`
- [x] `errors: { "<Field>": ["message", …] }`
- [ ] `stackTrace`
- [ ] `isValid: false`
> A validation problem is a ProblemDetails (`type`, `title`, `status: 400`) with an `errors` extension: a dictionary of field → messages. That's what frontends map onto form fields. There's no `isValid` flag — the status code already says it failed — and stack traces never belong in responses.
:::

:::quiz id=be-07-q9
Spot the bug. The client posts `{"sku": "ABC-1234"}` (no quantity). What happens?

```csharp
public record AddToCartRequest(
    [Required] string Sku,
    [Required] int Quantity);
```

- [ ] 400, because `Quantity` is missing and marked `[Required]`
- [x] The request passes validation with `Quantity = 0`, because a non-nullable `int` can never be null
- [ ] 500, because JSON can't deserialize a missing `int`
- [ ] 400, because `[Required]` isn't allowed on value types
> `[Required]` only rejects `null`. A missing `int` is deserialized as its default `0`, which isn't null, so the check passes and your handler adds zero items. Fix it with `[Required] int? Quantity` or, better here, `[Range(1, 99)] int Quantity`. It's allowed on value types (no error) — it's just useless there.
:::

:::quiz id=be-07-q10
The API maps `group.MapGet("/{id:int}", GetById)` under `/api/products`. What does `GET /api/products/abc` return?

- [ ] 400 Bad Request with a validation error for `id`
- [x] 404 Not Found — `abc` doesn't satisfy the `:int` constraint, so no endpoint matches
- [ ] 500, because `int.Parse("abc")` throws in the handler
- [ ] 200 with `id = 0`
> Route constraints decide whether a route **matches**; they don't validate. A segment that doesn't parse as `int` means this endpoint is never selected, routing finds nothing else, and the result is a 404 (a ProblemDetails one if `UseStatusCodePages` is on). The handler never runs, so there's no parse exception and no default `0`.
:::

:::quiz id=be-07-q11
Your API returns `{ "id": 1, "name": "Mug", "price": 9.5 }` to a React app and a mobile app. Which changes need a **new API version**? (Select all that apply.)

- [ ] Adding `"stock": 12` to the response
- [x] Renaming `price` to `unitPrice`
- [x] Changing `price` to `{ "amount": 9.5, "currency": "EUR" }`
- [ ] Adding a new endpoint `GET /api/v1/products/{id}/reviews`
- [x] Keeping the shape, but `price` now includes VAT where it didn't before
> Additive changes (a new field, a new endpoint) are safe because clients ignore what they don't know. Renames and type changes break deserialization or display. The VAT change is the sneakiest: every client keeps working and silently shows wrong totals. That's still a breaking change, and arguably the worst kind.
:::

:::quiz id=be-07-q12
An upload endpoint saves files with `Path.Combine(uploadsDir, file.FileName)`. What's the main problem?

- [ ] `IFormFile` can't be saved to disk in ASP.NET Core
- [x] The file name comes from the client, so a name like `../../appsettings.json` can write outside the folder or overwrite other files
- [ ] `Path.Combine` doesn't work on Linux
- [ ] Files must be base64-encoded in JSON instead
> Everything in a multipart upload is client-controlled: the name, the `Content-Type` and the bytes. Using the name as a path is a classic path-traversal bug, and two users uploading `report.pdf` would overwrite each other. Generate your own key (for example a GUID), store the original name only as metadata, and for real products put files in object storage rather than on the API's disk.
:::

## Lab: a catalog API with groups, DTOs, validation and problems

:::lab id=be-07-lab1 xp=130
title: Product catalog — the production-shaped way

You'll build a product API organised by feature, with request/response DTOs, built-in .NET 10
validation, RFC 9457 errors, a 409 for duplicates and `CreatedAtRoute` — and prove it with integration
tests.

**1. Create the projects**

```bash
mkdir Catalog && cd Catalog
dotnet new sln -n Catalog
dotnet new web -o src/Catalog.Api
dotnet new xunit -o tests/Catalog.Tests
dotnet sln add src/Catalog.Api tests/Catalog.Tests
dotnet add tests/Catalog.Tests reference src/Catalog.Api
dotnet add tests/Catalog.Tests package Microsoft.AspNetCore.Mvc.Testing
rm tests/Catalog.Tests/UnitTest1.cs
mkdir src/Catalog.Api/Products
```

**2. `src/Catalog.Api/Program.cs`**

```csharp
using Catalog.Api.Products;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();   // RFC 9457 bodies for errors
builder.Services.AddValidation();       // .NET 10 built-in minimal API validation
builder.Services.AddSingleton<ProductRepository>();

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();

app.MapProductEndpoints();

app.Run();
```

**3. DTOs: `src/Catalog.Api/Products/ProductDtos.cs`**

```csharp
using System.ComponentModel.DataAnnotations;

namespace Catalog.Api.Products;

// What clients SEND when creating a product.
public record CreateProductRequest(
    [Required, StringLength(100, MinimumLength = 2)] string Name,
    [Required, RegularExpression(@"^[A-Z]{3}-\d{4}$", ErrorMessage = "SKU must look like ABC-1234.")] string Sku,
    [Range(0.01, 100_000)] decimal Price);

// What clients SEND when updating (SKU is immutable, so it's not here).
public record UpdateProductRequest(
    [Required, StringLength(100, MinimumLength = 2)] string Name,
    [Range(0.01, 100_000)] decimal Price);

// What clients RECEIVE. Never the entity itself.
public record ProductResponse(int Id, string Name, string Sku, decimal Price);
```

**4. Entity + in-memory repository: `src/Catalog.Api/Products/Product.cs`**

```csharp
namespace Catalog.Api.Products;

// The "entity": internal shape, may grow fields clients must never see.
public class Product
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public required string Sku { get; set; }
    public decimal Price { get; set; }
    public decimal CostPrice { get; set; }          // secret! margin data
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;

    public ProductResponse ToResponse() => new(Id, Name, Sku, Price);
}

public class ProductRepository
{
    private readonly List<Product> _products = [];
    private readonly Lock _lock = new();            // C# 13 / .NET 9+ dedicated lock type
    private int _nextId;

    public IReadOnlyList<Product> All() { lock (_lock) return [.. _products]; }

    public Product? Find(int id) { lock (_lock) return _products.FirstOrDefault(p => p.Id == id); }

    public bool SkuExists(string sku) { lock (_lock) return _products.Any(p => p.Sku == sku); }

    public Product Add(string name, string sku, decimal price)
    {
        lock (_lock)
        {
            var product = new Product { Id = ++_nextId, Name = name, Sku = sku, Price = price, CostPrice = price * 0.6m };
            _products.Add(product);
            return product;
        }
    }

    public bool Remove(int id) { lock (_lock) return _products.RemoveAll(p => p.Id == id) > 0; }
}
```

(In be-10 this repository becomes EF Core + PostgreSQL, and the SKU check becomes a unique index.)

**5. Endpoints: `src/Catalog.Api/Products/ProductEndpoints.cs`**

```csharp
using Microsoft.AspNetCore.Http.HttpResults;

namespace Catalog.Api.Products;

public static class ProductEndpoints
{
    public static IEndpointRouteBuilder MapProductEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/products").WithTags("Products");

        group.MapGet("/", (ProductRepository repo) =>
            TypedResults.Ok(repo.All().Select(p => p.ToResponse())));

        group.MapGet("/{id:int}", GetById).WithName("GetProductById");
        group.MapPost("/", Create);
        group.MapPut("/{id:int}", Update);
        group.MapDelete("/{id:int}", Delete);

        return app;
    }

    private static Results<Ok<ProductResponse>, NotFound> GetById(int id, ProductRepository repo) =>
        repo.Find(id) is { } p ? TypedResults.Ok(p.ToResponse()) : TypedResults.NotFound();

    private static Results<CreatedAtRoute<ProductResponse>, ProblemHttpResult> Create(
        CreateProductRequest request, ProductRepository repo)
    {
        if (repo.SkuExists(request.Sku))
        {
            return TypedResults.Problem(
                title: "SKU already exists",
                detail: $"A product with SKU '{request.Sku}' already exists.",
                statusCode: StatusCodes.Status409Conflict);
        }

        var product = repo.Add(request.Name.Trim(), request.Sku, request.Price);
        return TypedResults.CreatedAtRoute(product.ToResponse(), "GetProductById", new { id = product.Id });
    }

    private static Results<NoContent, NotFound> Update(int id, UpdateProductRequest request, ProductRepository repo)
    {
        var product = repo.Find(id);
        if (product is null) return TypedResults.NotFound();

        product.Name = request.Name.Trim();
        product.Price = request.Price;
        return TypedResults.NoContent();
    }

    private static Results<NoContent, NotFound> Delete(int id, ProductRepository repo) =>
        repo.Remove(id) ? TypedResults.NoContent() : TypedResults.NotFound();
}
```

Notice there's **no validation code** in the handlers — `AddValidation()` already rejected bad input
before they run. The handlers only contain the business rule (unique SKU).

**6. Tests: `tests/Catalog.Tests/ProductApiTests.cs`**

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Tests;

public class ProductApiTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client = factory.CreateClient();

    // The factory (and its in-memory repository) is shared by all tests in this class, so every test
    // needs its own SKU. A counter is unique; a random number would collide now and then.
    private static int _skuCounter = 1000;
    private static string NewSku() => $"TST-{Interlocked.Increment(ref _skuCounter)}";

    [Fact]
    public async Task Create_returns_201_with_location_pointing_at_the_new_product()
    {
        var response = await _client.PostAsJsonAsync("/api/products",
            new { name = "Keyboard", sku = NewSku(), price = 49.90m });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.NotNull(response.Headers.Location);

        var fetched = await _client.GetAsync(response.Headers.Location);
        Assert.Equal(HttpStatusCode.OK, fetched.StatusCode);
    }

    [Fact]
    public async Task Response_never_leaks_internal_fields()
    {
        var response = await _client.PostAsJsonAsync("/api/products",
            new { name = "Mouse", sku = NewSku(), price = 19.90m });
        var json = await response.Content.ReadAsStringAsync();

        Assert.DoesNotContain("costPrice", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("createdAt", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Invalid_body_returns_400_problem_details_with_field_errors()
    {
        var response = await _client.PostAsJsonAsync("/api/products",
            new { name = "X", sku = "nope", price = 0m });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);

        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var errors = doc.RootElement.GetProperty("errors");
        Assert.True(errors.TryGetProperty("Name", out _) || errors.TryGetProperty("name", out _));
        Assert.True(errors.TryGetProperty("Sku", out _) || errors.TryGetProperty("sku", out _));
        Assert.True(errors.TryGetProperty("Price", out _) || errors.TryGetProperty("price", out _));
    }

    [Fact]
    public async Task Duplicate_sku_returns_409_conflict()
    {
        var sku = NewSku();
        await _client.PostAsJsonAsync("/api/products", new { name = "First", sku, price = 1m });

        var second = await _client.PostAsJsonAsync("/api/products", new { name = "Second", sku, price = 2m });

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        Assert.Equal("application/problem+json", second.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Update_returns_204_and_unknown_id_returns_404_problem()
    {
        var created = await _client.PostAsJsonAsync("/api/products", new { name = "Lamp", sku = NewSku(), price = 30m });
        var location = created.Headers.Location!;

        var update = await _client.PutAsJsonAsync(location, new { name = "Desk lamp", price = 35m });
        var missing = await _client.PutAsJsonAsync("/api/products/999999", new { name = "Ghost", price = 1m });

        Assert.Equal(HttpStatusCode.NoContent, update.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);
        Assert.Equal("application/problem+json", missing.Content.Headers.ContentType?.MediaType);
    }
}
```

`WebApplicationFactory<Program>` boots the real app in memory (no port, no network) and gives you an
`HttpClient` wired to it. In .NET 10 the `Program` class generated from top-level statements is
public, so the test project can reference it without the old `public partial class Program { }`
workaround.

**7. Run** `dotnet test` → `Passed: 5`. Then run the API and look at real responses:

```bash
dotnet run --project src/Catalog.Api --urls http://localhost:5299
curl -i -X POST localhost:5299/api/products -H 'content-type: application/json' -d '{"name":"X","sku":"nope","price":0}'
curl -i -X POST localhost:5299/api/products -H 'content-type: application/json' -d '{"name":"Desk","sku":"ABC-1234","price":3}'
curl -i -X POST localhost:5299/api/products -H 'content-type: application/json' -d '{"name":"Desk","sku":"ABC-1234","price":3}'
curl -i localhost:5299/api/products/77
```

You should see 400 (with `errors`), 201 (with `Location: http://localhost:5299/api/products/1`), 409
and 404 — all but the 201 with `Content-Type: application/problem+json`. The 409, for example, looks
roughly like this (your `traceId` will differ):

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.5.10","title":"SKU already exists","status":409,"detail":"A product with SKU 'ABC-1234' already exists.","traceId":"00-…-…-00"}
```

**8. Experiments**

- Change the 409 to `TypedResults.Conflict(new ProblemDetails { … })` (return type
  `Conflict<ProblemDetails>`, plus `using Microsoft.AspNetCore.Mvc;`) and watch
  `Duplicate_sku_returns_409_conflict` fail on the content type.
- Comment out `app.UseStatusCodePages();` — which test fails? (Answer: the update/404 test, because
  `TypedResults.NotFound()` now comes back with an empty body and no problem content type.)
- Add a validated `pageSize` query parameter to the list endpoint (with
  `using System.ComponentModel.DataAnnotations;`). The optional parameter must come **last** — an
  optional parameter can't precede a required one, so putting it before `repo` is a compile error:

  ```csharp
  group.MapGet("/", (ProductRepository repo, [Range(1, 100)] int pageSize = 20) =>
      TypedResults.Ok(repo.All().Take(pageSize).Select(p => p.ToResponse())));
  ```

  Then call `/api/products?pageSize=500`. You should get a 400 problem whose `errors` names
  `pageSize`, without writing a single `if`.

- [ ] All 5 tests pass
- [ ] I saw 400, 201, 409 and 404 responses with curl, and the 4xx ones were `application/problem+json`
- [ ] `CostPrice` never appears in any response
- [ ] I can explain why the unique-SKU check is in the handler, not in a validation attribute
:::

## Flashcards

:::cards id=be-07-cards1 title="Routing, DTOs & errors"
Q: What does `MapGroup` give you?
A: A shared route prefix plus shared metadata/filters/auth/tags for every endpoint in the group.
Q: Four reasons not to expose entities directly?
A: Data leaks (secret fields), over-posting, coupling DB schema to the API contract, serialization cycles.
Q: How do you enable .NET 10 built-in minimal API validation?
A: `builder.Services.AddValidation();` + DataAnnotations on DTOs/parameters. Invalid input → automatic 400 ValidationProblem.
Q: When do `IValidatableObject.Validate` rules run?
A: After all attribute validations on that object pass.
Q: What is RFC 9457?
A: Problem Details for HTTP APIs: a standard JSON error body (`type`, `title`, `status`, `detail`, `instance` + extensions), media type `application/problem+json`. Obsoletes RFC 7807.
Q: 401 vs 403?
A: 401 = not authenticated (no/invalid credentials). 403 = authenticated but not allowed.
Q: When is 409 right?
A: The request conflicts with current state: duplicate unique value, stale concurrent update, invalid state transition.
Q: Why `CreatedAtRoute` over a hard-coded `Location`?
A: The URL is generated from a named route, so it can't drift when routes change.
Q: How do you return a ProblemDetails with a custom status from a handler?
A: `TypedResults.Problem(title: …, detail: …, statusCode: 409)`.
Q: Why is `[Required] int Quantity` a bug?
A: `[Required]` only rejects null, and an `int` is never null — a missing value becomes `0` and passes. Use `int?` or `[Range(1, …)]`.
Q: What does `GET /api/products/abc` return when the route is `/{id:int}`?
A: 404 — the route constraint doesn't match, so no endpoint is selected. Constraints pick routes; they don't validate.
:::

## Recap

- Organise endpoints by **feature** with `MapGroup` and `Map…Endpoints` extension methods; keep
  `Program.cs` short. Route constraints like `{id:int}` choose routes (a mismatch is a 404), they
  don't validate.
- Return `TypedResults` with a `Results<…>` union so the compiler and OpenAPI know every possible
  response.
- **DTOs** (records) at the boundary, **entities** inside, explicit mapping. Never return or bind
  entities directly.
- .NET 10 `AddValidation()` validates DataAnnotations on DTOs, parameters and nested objects before your
  handler runs; FluentValidation + an endpoint filter is the common alternative. `[Required]` on a
  non-nullable value type checks nothing.
- Format rules → validation (400). State/data rules → handler/domain (409/422) + database constraints.
- Use **ProblemDetails** (RFC 9457) everywhere: `AddProblemDetails()`, `UseExceptionHandler()`,
  `UseStatusCodePages()`, `TypedResults.Problem(…)`.
- Pick status codes deliberately: 201 + `Location` (via `CreatedAtRoute`) for creates, 204 for empty
  success, 401 vs 403, 404, 409.
- Additive changes need no new version; for breaking changes, a URL version per route group
  (`/api/v2/…`) is the common default. Retire old versions deliberately.
- Small uploads bind to `IFormFile`: limit the size, ignore the client's file name, decide on
  antiforgery. Big files go straight to object storage via presigned URLs.
