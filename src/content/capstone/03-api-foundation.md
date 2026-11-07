---
id: cap-03
title: "API Foundation: Auth, Resource-Based Authorization & Real Tests"
level: advanced
minutes: 240
xp: 300
summary: Build the ASP.NET Core 10 minimal API for BranchStory with JWT auth, just-in-time users, owner/editor/viewer authorization, validation, ProblemDetails, OpenAPI, health checks and Testcontainers-backed integration tests.
---

The data layer exists; now it needs a front door. By the end of this lesson the API has sign-in,
knows who is calling, decides per project what they may do, rejects bad input in a standard
format, describes itself with OpenAPI, reports its health to Kubernetes, and has integration tests
that run the **real** app against a **real** PostgreSQL in a throw-away container.

## The shape of the API project

Organize by **feature**, not by technical layer. A "Projects" change touches one folder, not
`Controllers/`, `Services/`, `Dtos/` and `Validators/` scattered across the tree.

```text
api/BranchStory.Api/
├── Program.cs                     composition root: services, middleware, route groups
├── Auth/                          who is calling?
│   ├── AuthSetup.cs               JWT bearer: dev issuer or a real OIDC authority
│   ├── DevTokens.cs               signs local dev/test tokens
│   ├── CurrentUser.cs             "sub" claim → users row (created on first sight)
│   └── AuthEndpoints.cs           GET /api/me, POST /api/dev/token (Development only)
├── Authorization/                 what may they do with THIS project?
│   ├── ProjectAccess.cs           roles, requirements, the resource-based handler
│   └── ProjectGate.cs             load access + authorize → 404 / 403 / ok
├── Features/
│   └── Projects/                  ProjectDtos.cs, ProjectEndpoints.cs (one route group)
└── Health/PostgresHealthCheck.cs
```

| Route | Who | What |
|---|---|---|
| `POST /api/dev/token` | anyone, **Development only** | `{ "username": "ada" }` → `{ accessToken, expiresAt }` |
| `GET /api/me` | signed in | the caller's user row (created on first call) |
| `GET /api/projects` | signed in | projects I own or am a member of, with my role |
| `POST /api/projects` | signed in | create; I become the owner |
| `GET /api/projects/{id}` | viewer+ | the project including its `doc` |
| `DELETE /api/projects/{id}` | owner | delete with members and jobs (cascade) |
| `GET /health/live`, `/health/ready` | anyone | liveness / readiness probes |
| `GET /openapi/v1.json` | Development | the OpenAPI document |

## Authentication: tokens in, a user row out

The API never sees passwords. A browser gets an **access token** (a signed JWT) from an identity
provider and sends it as `Authorization: Bearer …`. The API only **validates** it: signature,
issuer, audience, expiry. Locally we are our own tiny issuer (`DevTokens`, HS256 with a dev-only
key); in production `Auth:Authority` points at Keycloak/Entra/Auth0 and the signing keys come from
the provider's JWKS endpoint. Same code path, different configuration.

**What is in a JWT?** Three base64url parts joined by dots: `header.payload.signature`. Decoded, a
BranchStory dev token's payload looks like this:

```json
{
  "sub": "dev|ada",
  "email": "ada@branchstory.test",
  "name": "ada",
  "iss": "branchstory-dev",
  "aud": "branchstory-api",
  "iat": 1793871200,
  "nbf": 1793871200,
  "exp": 1793900000
}
```

Each field is a **claim**. `iss` (issuer) says who signed it, `aud` (audience) says which API it is
meant for, `iat`/`nbf`/`exp` are "issued at", "not before" and "expires" as Unix timestamps, and
`sub` (subject) is the user's stable id at that issuer. The payload is only *encoded*, not encrypted: anyone can read it (try pasting a token
into a JWT decoder), so never put secrets in it. What nobody can do without the key is **change**
it, because the signature would no longer match. That is why the API checks all four things:

| Check | Stops |
|---|---|
| Signature | a forged or edited token |
| Issuer | a token signed by some other provider you happen to trust |
| Audience | a token issued for a *different* API being replayed against yours |
| Lifetime (`exp`, `nbf`) | an old, leaked token being used forever |

**HS256 vs RS256.** The dev issuer uses **HS256**: one shared secret both signs and verifies, which
is fine when the API is its own issuer. Real providers use **RS256/ES256**: they sign with a private
key and publish only the public keys at a **JWKS** URL (JSON Web Key Set), so the API can verify
tokens but could never mint one.

Three details matter:

* **`MapInboundClaims = false`.** By default the JWT handler renames `sub` to
  `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier`. Turning that off keeps
  the claim names you see in the token.
* **Users are created just in time.** The first request carrying an unknown `sub` inserts a `users`
  row. `INSERT … ON CONFLICT (subject) DO NOTHING` makes two simultaneous first requests safe.
* **Identity is `sub`, not email.** Emails change and can be recycled; the provider's subject is
  stable. Email is only used to find someone to share with. One consequence to know about:
  `users.email` is *also* unique (cap-02), so a **different** `sub` arriving with an email that is
  already taken still fails the insert with a unique violation. `ON CONFLICT (subject)` only settles
  the race for the *same* person. Real systems decide this deliberately (link the accounts, or
  reject with a clear error); for BranchStory's dev issuer it can't happen, because the email is
  derived from the username.

## Authorization: roles are per project, not per user

"Is Ada an editor?" has no answer. Ada is the **owner** of one story, an **editor** of a second
and a **viewer** of a third. That is **resource-based authorization**: the decision needs the
resource. ASP.NET Core models it as a requirement (`ProjectRoleRequirement(Editor)`) plus a handler
that receives the resource (`ProjectAccess`) and you call `IAuthorizationService.AuthorizeAsync(user,
resource, requirement)` *after* loading it. `ProjectGate` wraps the load-then-authorize dance and
turns the outcome into the right HTTP answer:

| Situation | Answer | Why |
|---|---|---|
| no token / bad token | **401** | authentication failed |
| not owner and not a member | **404** | don't reveal that the id exists |
| member, but role too low (viewer deleting) | **403** | they know it exists; they may not do *this* |

:::quiz id=cap-03-q1 xp=15
Eve (no relationship to the project) calls `GET /api/projects/{id}` with a valid token. Why does
BranchStory answer **404** instead of **403**?
- [ ] 403 is only for unauthenticated users
- [x] 403 would confirm the project exists, letting anyone probe ids; 404 reveals nothing
- [ ] Minimal APIs cannot return 403 from an endpoint
- [ ] 404 is cached by browsers, 403 is not
> GitHub does the same with private repositories. Members get 403 for actions above their role, because they already know the project exists. Strangers get 404, which is indistinguishable from "no such id". The tempting first option mixes up two codes: **401** means "I don't know who you are" (no or invalid token); **403** means "I know who you are, and the answer is no". Eve *is* authenticated, so 401 would be wrong too.
:::

:::lab id=cap-03-lab1 xp=100
title: Sign-in, the current user and /api/me

Work from the repository root. Postgres from cap-02 must be running
(`docker compose -f deploy/compose.yaml up -d`).

**1. Packages.**

```bash
dotnet add api/BranchStory.Api package Microsoft.AspNetCore.Authentication.JwtBearer
dotnet add api/BranchStory.Api package Microsoft.AspNetCore.OpenApi
```

`api/BranchStory.Api/BranchStory.Api.csproj` should now read:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Authentication.JwtBearer" Version="10.0.*" />
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="10.0.*" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\BranchStory.Data\BranchStory.Data.csproj" />
  </ItemGroup>

</Project>
```

**2. A fixed port.** The web app's Vite proxy (cap-05) expects the API on `http://localhost:5080`.
Replace `api/BranchStory.Api/Properties/launchSettings.json`:

```json
{
  "$schema": "https://json.schemastore.org/launchsettings.json",
  "profiles": {
    "http": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": false,
      "applicationUrl": "http://localhost:5080",
      "environmentVariables": {
        "ASPNETCORE_ENVIRONMENT": "Development"
      }
    }
  }
}
```

**3. Configuration.** `api/BranchStory.Api/appsettings.json`:

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
  "Auth": {
    "Authority": "",
    "Audience": "branchstory-api"
  }
}
```

`api/BranchStory.Api/appsettings.Development.json` (the signing key is a dev-only value; it
must be at least 32 bytes for HS256):

```json
{
  "ConnectionStrings": {
    "BranchStory": "Host=localhost;Port=5432;Database=branchstory;Username=branchstory;Password=branchstory"
  },
  "Database": {
    "MigrateOnStartup": true
  },
  "Auth": {
    "DevSigningKey": "dev-only-signing-key-change-me-0123456789abcdef"
  }
}
```

**4. The dev token issuer.** `api/BranchStory.Api/Auth/DevTokens.cs`:

```csharp
using System.Text;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace BranchStory.Api.Auth;

/// <summary>
/// Signs short-lived HS256 tokens for local development and tests.
/// Production uses a real OIDC provider (Auth:Authority), and this signer is never reachable there.
/// </summary>
public sealed class DevTokens(IConfiguration config)
{
    public SecurityKey SigningKey
    {
        get
        {
            var key = config["Auth:DevSigningKey"];
            if (string.IsNullOrEmpty(key) || Encoding.UTF8.GetByteCount(key) < 32)
                throw new InvalidOperationException("Auth:DevSigningKey must be at least 32 bytes.");
            return new SymmetricSecurityKey(Encoding.UTF8.GetBytes(key));
        }
    }

    public string Create(string subject, string email, string name, TimeSpan? lifetime = null) =>
        new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = AuthSetup.DevIssuer,
            Audience = AuthSetup.DefaultAudience,
            Expires = DateTime.UtcNow.Add(lifetime ?? TimeSpan.FromHours(8)),
            Claims = new Dictionary<string, object>
            {
                ["sub"] = subject,
                ["email"] = email,
                ["name"] = name,
            },
            SigningCredentials = new SigningCredentials(SigningKey, SecurityAlgorithms.HmacSha256),
        });
}
```

**5. JWT bearer setup.** `api/BranchStory.Api/Auth/AuthSetup.cs`. Options are configured through
`AddOptions<JwtBearerOptions>().Configure<IConfiguration, …>`, so they are read when first needed;
that is what lets the integration tests override `Auth:*` settings later.

```csharp
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.Extensions.Options;
using Microsoft.IdentityModel.Tokens;

namespace BranchStory.Api.Auth;

public static class AuthSetup
{
    public const string DevIssuer = "branchstory-dev";
    public const string DefaultAudience = "branchstory-api";

    public static IServiceCollection AddBranchStoryAuth(this IServiceCollection services)
    {
        services.AddSingleton<DevTokens>();
        services.AddScoped<CurrentUser>();

        services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();

        // Configure the bearer options lazily from IConfiguration, so tests can override settings.
        services.AddOptions<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme)
            .Configure<IConfiguration, DevTokens>((o, config, devTokens) =>
            {
                // Keep claim names as the token has them ("sub", "email", "name"),
                // instead of the long legacy SOAP claim URIs.
                o.MapInboundClaims = false;
                o.TokenValidationParameters.NameClaimType = "name";

                var authority = config["Auth:Authority"];
                if (!string.IsNullOrEmpty(authority))
                {
                    // Real OIDC provider (Keycloak, Entra ID, Auth0 ...): keys come from its JWKS endpoint.
                    o.Authority = authority;
                    o.Audience = config["Auth:Audience"] ?? DefaultAudience;
                    o.RequireHttpsMetadata = authority.StartsWith("https://", StringComparison.OrdinalIgnoreCase);
                }
                else
                {
                    o.TokenValidationParameters.ValidIssuer = DevIssuer;
                    o.TokenValidationParameters.ValidAudience = DefaultAudience;
                    o.TokenValidationParameters.IssuerSigningKey = devTokens.SigningKey;
                    o.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
                }
            });

        services.AddAuthorization();
        return services;
    }
}
```

**6. Who is calling?** `api/BranchStory.Api/Auth/CurrentUser.cs`:

```csharp
using System.Security.Claims;
using BranchStory.Data;
using Microsoft.EntityFrameworkCore;

namespace BranchStory.Api.Auth;

/// <summary>
/// Resolves the caller's users row from the token's "sub" claim and creates it on first sight
/// ("just-in-time provisioning"). Scoped: one lookup per request at most.
/// </summary>
public sealed class CurrentUser(IHttpContextAccessor http, BranchStoryDbContext db)
{
    private User? _user;

    public async Task<User> GetAsync(CancellationToken ct = default)
    {
        if (_user is not null) return _user;

        var principal = http.HttpContext?.User
            ?? throw new InvalidOperationException("CurrentUser used outside of an HTTP request.");
        var subject = principal.FindFirstValue("sub")
            ?? throw new InvalidOperationException("The access token has no 'sub' claim.");

        _user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Subject == subject, ct);
        if (_user is not null) return _user;

        var email = (principal.FindFirstValue("email") ?? $"{subject}@users.invalid").ToLowerInvariant();
        var name = principal.FindFirstValue("name") ?? email;

        // Two parallel first requests must not both fail: let Postgres settle the race.
        await db.Database.ExecuteSqlAsync($"""
            INSERT INTO users (id, subject, email, display_name, plan, created_at)
            VALUES ({Guid.CreateVersion7()}, {subject}, {email}, {name}, 'free', now())
            ON CONFLICT (subject) DO NOTHING
            """, ct);

        _user = await db.Users.AsNoTracking().SingleAsync(u => u.Subject == subject, ct);
        return _user;
    }
}
```

**7. Endpoints.** `api/BranchStory.Api/Auth/AuthEndpoints.cs`:

```csharp
using System.ComponentModel.DataAnnotations;

namespace BranchStory.Api.Auth;

public sealed record MeResponse(Guid Id, string Email, string DisplayName, string Plan);

public sealed record DevTokenRequest(
    [Required, StringLength(64, MinimumLength = 2), RegularExpression("^[a-z0-9-]+$")] string Username,
    [StringLength(120)] string? DisplayName);

public sealed record DevTokenResponse(string AccessToken, DateTimeOffset ExpiresAt);

public static class AuthEndpoints
{
    public static RouteGroupBuilder MapMe(this RouteGroupBuilder api)
    {
        api.MapGet("/me", async (CurrentUser currentUser, CancellationToken ct) =>
        {
            var me = await currentUser.GetAsync(ct);
            return TypedResults.Ok(new MeResponse(me.Id, me.Email, me.DisplayName, me.Plan));
        }).WithTags("Auth").WithName("GetMe");
        return api;
    }

    /// <summary>POST /api/dev/token: a sign-in for local development. Mapped ONLY in Development.</summary>
    public static IEndpointRouteBuilder MapDevAuth(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/dev/token", (DevTokenRequest req, DevTokens tokens) =>
        {
            var lifetime = TimeSpan.FromHours(8);
            var token = tokens.Create($"dev|{req.Username}", $"{req.Username}@branchstory.test",
                req.DisplayName ?? req.Username, lifetime);
            return TypedResults.Ok(new DevTokenResponse(token, DateTimeOffset.UtcNow.Add(lifetime)));
        }).AllowAnonymous().WithTags("Auth").WithName("CreateDevToken");
        return app;
    }
}
```

You will wire these into `Program.cs` in the next lab (it also needs the authorization pieces).
Build now to catch typos early:

```bash
dotnet build api/BranchStory.Api
```

:::warn title="The dev token endpoint is a back door"
`POST /api/dev/token` signs a token for **any** username. It is mapped only when
`app.Environment.IsDevelopment()`, the signing key exists only in `appsettings.Development.json`,
and production sets `Auth:Authority` so dev tokens fail validation anyway (wrong issuer, unknown
key). Three locks, on purpose. Never "temporarily" enable it on a shared environment.
:::

- [ ] Both packages are referenced and `dotnet build api/BranchStory.Api` succeeds
- [ ] `launchSettings.json` pins the API to `http://localhost:5080`
- [ ] You can explain why `MapInboundClaims = false` is set
- [ ] You can explain why `CurrentUser` uses `ON CONFLICT (subject) DO NOTHING` instead of "check, then insert"
:::

:::pro title="Swapping in Keycloak"
The code already supports a real OIDC provider: set `Auth__Authority=http://localhost:8081/realms/branchstory`
and `Auth__Audience=branchstory-api` (the double underscore is how environment variables spell the
`:` in `Auth:Authority`). A dev Keycloak is one more compose service
(`quay.io/keycloak/keycloak:26` with `command: start-dev --import-realm`, published as
`"8081:8080"` so it doesn't clash with the compose stack on 8080 in cap-10) plus a realm JSON that
defines a public `branchstory-web` client (PKCE) and an **audience mapper**. Without that mapper
Keycloak's access tokens don't carry `aud: branchstory-api`, and the API rejects every one of them
with 401. Teams usually keep the dev issuer for tests (fast, offline) and run Keycloak in compose to
test the real login screens.
:::

## Validation, ProblemDetails, OpenAPI and health

Four cross-cutting pieces turn "endpoints that work" into an API a frontend team can rely on.

* **Validation.** Bad input should be rejected *before* your handler runs, with a message that says
  which field is wrong. .NET 10 validates minimal-API parameters from DataAnnotations once you call
  `AddValidation()`: `[Required, StringLength(120, MinimumLength = 1)]` on a record parameter is
  enough. A source generator finds those attributes at build time, so the types must be declared in
  the API project (or a referenced one) and be `public`. Failures become `400` with a
  `ValidationProblemDetails` body listing errors per field.
* **ProblemDetails (RFC 9457).** Without it, a 404 is an empty body, a 401 is an empty body with a
  header, and an exception is an HTML page or a stack trace. `AddProblemDetails()` +
  `UseExceptionHandler()` + `UseStatusCodePages()` make **every** error (validation, 401, 404,
  unhandled exception) an `application/problem+json` document with `type`, `title`, `status`,
  `detail`. The frontend writes one error parser instead of ten, and no stack trace ever leaks to a
  client.
* **Typed results.** Handlers return `Results<Ok<ProjectDetail>, ProblemHttpResult>`. The compiler
  checks every branch (returning a `NotFound` from that handler would not compile), and OpenAPI
  learns every possible response from the signature instead of from hand-written attributes.
* **Health.** Liveness says "the process is alive; don't restart me". Readiness says "I can serve
  traffic; send me requests", which requires Postgres. Kubernetes uses both in cap-10.

Here is what a blank title looks like on the wire once these are in place (abridged):

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Title": ["The Title field is required."]
  }
}
```

Note the key is `Title`, the C# property name, not the camelCase JSON name `title`. The frontend's
form code in cap-05 has to map it, and the integration test below asserts on exactly this key.

:::warn title="Common mistake: business rules as 400s"
Validation answers "is this request well-formed?" (`title` present, not too long). Rules that need
the database ("you already have 3 stories on the free plan") are **not** validation: they belong
in the handler and get their own status and problem `type` (cap-04 uses 403 with a
`plan-limit` type). Mixing the two makes the frontend unable to tell "fix your input" from "upgrade
your plan".
:::

:::lab id=cap-03-lab2 xp=120
title: The Projects feature with resource-based authorization

**1. Roles, the resource, the requirement and its handler.**
`api/BranchStory.Api/Authorization/ProjectAccess.cs`. Note that `ProjectAccess` carries the
**owner's plan**: cap-04 checks quotas against it.

```csharp
using Microsoft.AspNetCore.Authorization;

namespace BranchStory.Api.Authorization;

/// <summary>Ordered so that "at least Editor" is a simple comparison.</summary>
public enum ProjectRole { Viewer = 1, Editor = 2, Owner = 3 }

/// <summary>
/// The resource we authorize against: who the caller is to this project, and who owns it.
/// Quotas are always read from the OWNER (OwnerPlan), never from the caller.
/// </summary>
public sealed record ProjectAccess(Guid ProjectId, Guid UserId, Guid OwnerId, string OwnerPlan, ProjectRole Role)
{
    public string RoleName => Role.ToString().ToLowerInvariant();
}

public sealed class ProjectRoleRequirement(ProjectRole minimum) : IAuthorizationRequirement
{
    public ProjectRole Minimum { get; } = minimum;
}

public static class ProjectRequirements
{
    public static readonly ProjectRoleRequirement View = new(ProjectRole.Viewer);
    public static readonly ProjectRoleRequirement Edit = new(ProjectRole.Editor);
    public static readonly ProjectRoleRequirement Own = new(ProjectRole.Owner);
}

/// <summary>Resource-based authorization handler: succeeds when the caller's role is high enough.</summary>
public sealed class ProjectRoleHandler : AuthorizationHandler<ProjectRoleRequirement, ProjectAccess>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, ProjectRoleRequirement requirement, ProjectAccess resource)
    {
        if (resource.Role >= requirement.Minimum) context.Succeed(requirement);
        return Task.CompletedTask;
    }
}
```

**2. The gate.** `api/BranchStory.Api/Authorization/ProjectGate.cs` loads the caller's relationship
to the project in **one** query (owner id, owner plan, member role) and runs the check:

```csharp
using BranchStory.Api.Auth;
using BranchStory.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace BranchStory.Api.Authorization;

/// <summary>Either the caller's access to a project, or the problem response to return.</summary>
public readonly record struct GateResult(ProjectAccess? Access, ProblemHttpResult? Problem);

/// <summary>Loads the caller's relationship to a project and runs the resource-based check.</summary>
public sealed class ProjectGate(
    BranchStoryDbContext db, CurrentUser currentUser, IAuthorizationService authz, IHttpContextAccessor http)
{
    public async Task<ProjectAccess?> FindAccessAsync(Guid projectId, CancellationToken ct)
    {
        var me = await currentUser.GetAsync(ct);
        var row = await db.Projects
            .Where(p => p.Id == projectId)
            .Select(p => new
            {
                p.OwnerId,
                OwnerPlan = p.Owner.Plan,
                MemberRole = p.Members.Where(m => m.UserId == me.Id).Select(m => m.Role).FirstOrDefault(),
            })
            .SingleOrDefaultAsync(ct);

        if (row is null) return null;
        ProjectRole? role = row.OwnerId == me.Id ? ProjectRole.Owner
            : row.MemberRole == MemberRoles.Editor ? ProjectRole.Editor
            : row.MemberRole == MemberRoles.Viewer ? ProjectRole.Viewer
            : null;
        return role is null ? null : new ProjectAccess(projectId, me.Id, row.OwnerId, row.OwnerPlan, role.Value);
    }

    public async Task<GateResult> CheckAsync(Guid projectId, ProjectRoleRequirement requirement, CancellationToken ct)
    {
        var access = await FindAccessAsync(projectId, ct);
        // Not a member? Say "not found", so project ids can't be probed for existence.
        if (access is null)
            return new(null, TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Project not found"));

        var result = await authz.AuthorizeAsync(http.HttpContext!.User, access, requirement);
        return result.Succeeded
            ? new(access, null)
            : new(null, TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden,
                title: "Not allowed", detail: $"This needs the {requirement.Minimum.ToString().ToLowerInvariant()} role; you are {access.RoleName}."));
    }
}
```

**3. DTOs.** `api/BranchStory.Api/Features/Projects/ProjectDtos.cs`. Entities never leave the API;
DTOs are the contract the frontend's typed client mirrors.

```csharp
using System.ComponentModel.DataAnnotations;
using BranchStory.Data;

namespace BranchStory.Api.Features.Projects;

public sealed record CreateProjectRequest([Required, StringLength(120, MinimumLength = 1)] string Title);

public sealed record ProjectSummary(Guid Id, string Title, string Role, string OwnerName, int Version, DateTimeOffset UpdatedAt);

public sealed record ProjectDetail(Guid Id, string Title, string Role, Guid OwnerId, int Version, StoryDoc Doc, DateTimeOffset UpdatedAt);
```

**4. The route group.** `api/BranchStory.Api/Features/Projects/ProjectEndpoints.cs`:

```csharp
using BranchStory.Api.Auth;
using BranchStory.Api.Authorization;
using BranchStory.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace BranchStory.Api.Features.Projects;

public static class ProjectEndpoints
{
    public static RouteGroupBuilder MapProjectEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/", ListProjects).WithName("ListProjects");
        group.MapPost("/", CreateProject).WithName("CreateProject");
        group.MapGet("/{id:guid}", GetProject).WithName("GetProject");
        group.MapDelete("/{id:guid}", DeleteProject).WithName("DeleteProject");
        return group;
    }

    static async Task<Ok<List<ProjectSummary>>> ListProjects(
        CurrentUser currentUser, BranchStoryDbContext db, CancellationToken ct)
    {
        var me = await currentUser.GetAsync(ct);
        var items = await db.Projects
            .Where(p => p.OwnerId == me.Id || p.Members.Any(m => m.UserId == me.Id))
            .OrderByDescending(p => p.UpdatedAt)
            .Select(p => new ProjectSummary(
                p.Id,
                p.Title,
                p.OwnerId == me.Id ? "owner" : p.Members.Where(m => m.UserId == me.Id).Select(m => m.Role).First(),
                p.Owner.DisplayName,
                p.Version,
                p.UpdatedAt))
            .ToListAsync(ct);
        return TypedResults.Ok(items);
    }

    static async Task<Created<ProjectDetail>> CreateProject(
        CreateProjectRequest req, CurrentUser currentUser, BranchStoryDbContext db, CancellationToken ct)
    {
        var me = await currentUser.GetAsync(ct);
        var project = new Project { OwnerId = me.Id, Title = req.Title.Trim() };
        db.Projects.Add(project);
        await db.SaveChangesAsync(ct);

        var dto = new ProjectDetail(project.Id, project.Title, "owner", me.Id, project.Version, project.Doc, project.UpdatedAt);
        return TypedResults.Created($"/api/projects/{project.Id}", dto);
    }

    static async Task<Results<Ok<ProjectDetail>, ProblemHttpResult>> GetProject(
        Guid id, ProjectGate gate, BranchStoryDbContext db, CancellationToken ct)
    {
        var check = await gate.CheckAsync(id, ProjectRequirements.View, ct);
        if (check.Problem is { } problem) return problem;

        var p = await db.Projects.AsNoTracking().SingleAsync(x => x.Id == id, ct);
        return TypedResults.Ok(new ProjectDetail(p.Id, p.Title, check.Access!.RoleName, p.OwnerId, p.Version, p.Doc, p.UpdatedAt));
    }

    static async Task<Results<NoContent, ProblemHttpResult>> DeleteProject(
        Guid id, ProjectGate gate, BranchStoryDbContext db, CancellationToken ct)
    {
        var check = await gate.CheckAsync(id, ProjectRequirements.Own, ct);
        if (check.Problem is { } problem) return problem;

        await db.Projects.Where(p => p.Id == id).ExecuteDeleteAsync(ct);
        return TypedResults.NoContent();
    }
}
```

**5. Readiness check.** `api/BranchStory.Api/Health/PostgresHealthCheck.cs`:

```csharp
using BranchStory.Data;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace BranchStory.Api.Health;

/// <summary>Readiness: can we reach Postgres right now?</summary>
public sealed class PostgresHealthCheck(BranchStoryDbContext db) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken ct = default) =>
        await db.Database.CanConnectAsync(ct)
            ? HealthCheckResult.Healthy()
            : HealthCheckResult.Unhealthy("Cannot connect to PostgreSQL.");
}
```

**6. Compose it.** Replace `api/BranchStory.Api/Program.cs` (the `/debug/db` endpoint is gone):

```csharp
using BranchStory.Api.Auth;
using BranchStory.Api.Authorization;
using BranchStory.Api.Features.Projects;
using BranchStory.Api.Health;
using BranchStory.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddBranchStoryDb();
builder.Services.AddBranchStoryAuth();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ProjectGate>();
builder.Services.AddSingleton<IAuthorizationHandler, ProjectRoleHandler>();

builder.Services.AddProblemDetails();   // every error becomes application/problem+json
builder.Services.AddValidation();       // DataAnnotations on minimal-API parameters (.NET 10)
builder.Services.AddOpenApi();          // /openapi/v1.json
builder.Services.AddHealthChecks()
    .AddCheck<PostgresHealthCheck>("postgres", tags: ["ready"]);

var app = builder.Build();

await app.MigrateIfConfiguredAsync();

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseAuthentication();
app.UseAuthorization();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapDevAuth();
}

// Liveness: the process answers. Readiness: it can also do useful work (DB reachable).
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });

var api = app.MapGroup("/api").RequireAuthorization();
api.MapMe();
api.MapGroup("/projects").WithTags("Projects").MapProjectEndpoints();

app.Run();

// Lets WebApplicationFactory<Program> in the test project see this class. .NET 10 also generates
// this declaration for you; writing it out keeps the intent visible and is harmless.
public partial class Program;
```

**Order matters in the middleware block.** `UseExceptionHandler()` comes first so it can catch
exceptions thrown by everything after it. `UseAuthentication()` must run before
`UseAuthorization()`: authorization decides based on the user that authentication just read from
the token. And `RequireAuthorization()` on the `/api` group makes "signed in" the default for
every endpoint inside it, so a new endpoint is protected even if its author forgets; the dev token
endpoint lives *outside* that group on purpose.

**7. Take it for a drive.**

```bash
dotnet run --project api/BranchStory.Api
```

In a second terminal (needs `jq`; or copy the token by hand):

```bash
TOKEN=$(curl -s -X POST localhost:5080/api/dev/token -H 'content-type: application/json' \
  -d '{"username":"ada"}' | jq -r .accessToken)

curl -i localhost:5080/api/projects                                   # 401, problem+json
curl -s localhost:5080/api/me -H "authorization: Bearer $TOKEN"       # creates Ada's user row
curl -s -X POST localhost:5080/api/projects -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":"The Lost Key"}'
curl -s -X POST localhost:5080/api/projects -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title":""}'               # 400 with errors.Title
curl -s localhost:5080/api/projects -H "authorization: Bearer $TOKEN"
curl -s localhost:5080/health/ready                                   # Healthy
curl -s localhost:5080/openapi/v1.json | jq '.paths | keys'
```

The first call should start like this; the body is the problem document `UseStatusCodePages`
wrote for the empty 401:

```text
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
WWW-Authenticate: Bearer
```

Then stop Postgres and probe both health endpoints:

```bash
docker compose -f deploy/compose.yaml stop db
curl -s -o /dev/null -w '%{http_code}\n' localhost:5080/health/live    # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:5080/health/ready   # 503 (may take a few seconds to time out)
docker compose -f deploy/compose.yaml start db
```

- [ ] Without a token `/api/projects` returns `401`; with one it returns `200`
- [ ] `POST /api/projects` returns `201` with a `Location` header, `"role":"owner"`, `"version":1` and a starter `doc`
- [ ] An empty title returns `400` with `content-type: application/problem+json` and an `errors.Title` entry
- [ ] With Postgres stopped, `/health/live` is `200` but `/health/ready` is `503`
- [ ] `/openapi/v1.json` lists `/api/projects` and `/api/projects/{id}`
:::

:::quiz id=cap-03-q2 xp=15
With Postgres down, `/health/live` keeps answering 200 while `/health/ready` returns 503. Why is it
**wrong** to include the database check in liveness?
- [ ] Liveness probes are not allowed to open network connections
- [x] Kubernetes restarts pods whose liveness fails; a database outage would restart every API pod in a loop without fixing anything
- [ ] Readiness probes run less often, so the database check is cheaper there
- [ ] It isn't wrong; both should check the database
> Liveness answers "is this process stuck?" (restart helps). Readiness answers "should I receive traffic?" (wait helps). A dependency outage is a readiness problem: pods stay up, stop receiving traffic, and recover the moment Postgres returns.
:::

## Integration tests that tell the truth

Mocks of `DbContext` test your mocks. Instead, `WebApplicationFactory<Program>` boots the real API
in memory (real middleware, auth, validation, EF Core) and Testcontainers starts a real
`postgres:18` for the test run. The pieces:

* **One container per test run.** xUnit v3's `[assembly: AssemblyFixture(...)]` shares a single
  `ApiFactory` across all test classes. Starting Postgres takes a few seconds; doing it once keeps
  the suite fast.
* **Isolation by data, not by database.** Every test signs in **fresh, unique users**, so tests
  cannot see each other's projects and can run in parallel without truncating tables.
* **Real tokens.** The factory mints tokens with the API's own `DevTokens`, so the full JWT
  validation pipeline runs in every test.

:::lab id=cap-03-lab3 xp=120
title: ApiFactory + Testcontainers + the first nine tests

You need Docker (or Podman with its Docker-compatible socket) running. Testcontainers talks to it
directly; the compose database is not used by the tests.

**1. The test project.** Replace `tests/BranchStory.Api.Tests/BranchStory.Api.Tests.csproj`
(delete the template's `UnitTest1.cs`):

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
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="10.0.*" />
    <PackageReference Include="Testcontainers.PostgreSql" Version="4.*" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\..\api\BranchStory.Api\BranchStory.Api.csproj" />
  </ItemGroup>

</Project>
```

**2. The factory.** `tests/BranchStory.Api.Tests/ApiFactory.cs`. xUnit v3's `IAsyncLifetime` uses
`ValueTask` and extends `IAsyncDisposable`, which `WebApplicationFactory` already implements, so
we **override** its `DisposeAsync`:

```csharp
using System.Net.Http.Headers;
using System.Net.Http.Json;
using BranchStory.Api.Auth;
using BranchStory.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.PostgreSql;

[assembly: AssemblyFixture(typeof(BranchStory.Api.Tests.ApiFactory))]

namespace BranchStory.Api.Tests;

/// <summary>A signed-in test user: an HttpClient carrying their bearer token.</summary>
public sealed record TestUser(Guid Id, string Email, HttpClient Client);

/// <summary>
/// Boots the real API in memory against a throw-away PostgreSQL 18 container.
/// One instance for the whole test assembly; tests stay independent by using fresh users.
/// </summary>
public sealed class ApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:18").Build();

    public async ValueTask InitializeAsync()
    {
        await _postgres.StartAsync();
        // Boot the API (which applies the migrations) now, once. Left lazy, two tests running in
        // parallel can both start a host, and two concurrent migration runs collide.
        _ = Server;
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _postgres.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.UseSetting("ConnectionStrings:BranchStory", _postgres.GetConnectionString());
        builder.UseSetting("Database:MigrateOnStartup", "true");
        builder.UseSetting("Auth:Authority", "");
        builder.UseSetting("Auth:DevSigningKey", "integration-tests-signing-key-0123456789");
    }

    /// <summary>A client with no token at all.</summary>
    public HttpClient Anonymous() => CreateClient();

    /// <summary>Creates a unique user, signs them in (provisions the users row) and returns their client.</summary>
    public async Task<TestUser> SignInAsync(string? name = null)
    {
        var username = $"{name ?? "user"}-{Guid.NewGuid():N}"[..20];
        var token = Services.GetRequiredService<DevTokens>().Create($"test|{username}", $"{username}@test.local", username);

        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var me = await client.GetFromJsonAsync<MeResponse>("/api/me") ?? throw new InvalidOperationException("no /api/me");
        return new TestUser(me.Id, me.Email, client);
    }

    /// <summary>Run arbitrary arrange/assert code against the same database the API uses.</summary>
    public async Task WithDbAsync(Func<BranchStoryDbContext, Task> action)
    {
        await using var scope = Services.CreateAsyncScope();
        await action(scope.ServiceProvider.GetRequiredService<BranchStoryDbContext>());
    }
}
```

**3. The tests.** `tests/BranchStory.Api.Tests/ProjectsApiTests.cs`. Each one is a sentence about
the product, and the last two prove the authorization table above:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using BranchStory.Api.Features.Projects;
using BranchStory.Data;

namespace BranchStory.Api.Tests;

public sealed class ProjectsApiTests(ApiFactory api)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Anonymous_callers_get_a_401_problem()
    {
        var res = await api.Anonymous().GetAsync("/api/projects", Ct);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task Health_endpoints_are_public_and_healthy()
    {
        var client = api.Anonymous();
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/live", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/ready", Ct)).StatusCode);
    }

    [Fact]
    public async Task OpenApi_document_lists_the_project_routes()
    {
        var json = await api.Anonymous().GetStringAsync("/openapi/v1.json", Ct);
        Assert.Contains("/api/projects/{id}", json);
    }

    [Fact]
    public async Task Created_project_starts_at_version_1_with_a_start_scene()
    {
        var ada = await api.SignInAsync("ada");

        var res = await ada.Client.PostAsJsonAsync("/api/projects", new CreateProjectRequest("The Lost Key"), Ct);

        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        var created = await res.Content.ReadFromJsonAsync<ProjectDetail>(Ct);
        Assert.NotNull(created);
        Assert.Equal("owner", created.Role);
        Assert.Equal(1, created.Version);
        Assert.Equal("start", created.Doc.StartNodeId);
        Assert.Single(created.Doc.Nodes);
        Assert.Equal($"/api/projects/{created.Id}", res.Headers.Location?.OriginalString);
    }

    [Fact]
    public async Task List_shows_only_my_projects()
    {
        var ada = await api.SignInAsync("ada");
        var bob = await api.SignInAsync("bob");
        await ada.Client.PostAsJsonAsync("/api/projects", new CreateProjectRequest("Ada's story"), Ct);
        await bob.Client.PostAsJsonAsync("/api/projects", new CreateProjectRequest("Bob's story"), Ct);

        var list = await ada.Client.GetFromJsonAsync<List<ProjectSummary>>("/api/projects", Ct);

        var only = Assert.Single(list!);
        Assert.Equal("Ada's story", only.Title);
    }

    [Fact]
    public async Task Blank_title_is_a_validation_problem()
    {
        var ada = await api.SignInAsync("ada");

        var res = await ada.Client.PostAsJsonAsync("/api/projects", new { title = "" }, Ct);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        var problem = await res.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.True(problem.GetProperty("errors").TryGetProperty("Title", out _));
    }

    [Fact]
    public async Task Strangers_get_404_not_403()
    {
        var ada = await api.SignInAsync("ada");
        var eve = await api.SignInAsync("eve");
        var created = await (await ada.Client.PostAsJsonAsync("/api/projects", new CreateProjectRequest("Secret"), Ct))
            .Content.ReadFromJsonAsync<ProjectDetail>(Ct);

        var res = await eve.Client.GetAsync($"/api/projects/{created!.Id}", Ct);

        Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
    }

    [Fact]
    public async Task Viewer_can_read_but_not_delete()
    {
        var ada = await api.SignInAsync("ada");
        var vic = await api.SignInAsync("vic");
        var created = await (await ada.Client.PostAsJsonAsync("/api/projects", new CreateProjectRequest("Shared"), Ct))
            .Content.ReadFromJsonAsync<ProjectDetail>(Ct);
        // No sharing endpoint yet (that's cap-04), so arrange the membership directly in the DB.
        await api.WithDbAsync(async db =>
        {
            db.ProjectMembers.Add(new ProjectMember { ProjectId = created!.Id, UserId = vic.Id, Role = MemberRoles.Viewer });
            await db.SaveChangesAsync(Ct);
        });

        var get = await vic.Client.GetFromJsonAsync<ProjectDetail>($"/api/projects/{created!.Id}", Ct);
        var delete = await vic.Client.DeleteAsync($"/api/projects/{created.Id}", Ct);

        Assert.Equal("viewer", get!.Role);
        Assert.Equal(HttpStatusCode.Forbidden, delete.StatusCode);
    }

    [Fact]
    public async Task Owner_can_delete()
    {
        var ada = await api.SignInAsync("ada");
        var created = await (await ada.Client.PostAsJsonAsync("/api/projects", new CreateProjectRequest("Temp"), Ct))
            .Content.ReadFromJsonAsync<ProjectDetail>(Ct);

        var delete = await ada.Client.DeleteAsync($"/api/projects/{created!.Id}", Ct);
        var after = await ada.Client.GetAsync($"/api/projects/{created.Id}", Ct);

        Assert.Equal(HttpStatusCode.NoContent, delete.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, after.StatusCode);
    }
}
```

**4. Run them.**

```bash
dotnet test tests/BranchStory.Api.Tests
```

The first run pulls the `postgres:18` image, so it is slow; later runs take seconds. Expect a
summary with **9 succeeded, 0 failed** (in CI the classic form reads
`Passed!  - Failed: 0, Passed: 9, Skipped: 0, Total: 9`). If every test fails with a Docker error,
Testcontainers cannot reach the Docker socket: check `docker ps` works without `sudo`.

:::tip title="Podman users"
Start the API socket (`systemctl --user start podman.socket`), then
`export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock` and
`export TESTCONTAINERS_RYUK_DISABLED=true` before `dotnet test`.
:::

Finally, prove the tests can fail: change `ProjectRequirements.Own` to `ProjectRequirements.View` in
`DeleteProject` and run again, then revert.

- [ ] `dotnet test` reports 9 passed, 0 failed
- [ ] The suite starts exactly one `postgres:18` container (watch `docker ps` during the run)
- [ ] Weakening `DeleteProject` to `View` makes `Viewer_can_read_but_not_delete` fail
- [ ] Running `dotnet test` twice in a row passes both times (no leftover state problems)
:::

:::job title="What reviewers look for in an API PR"
Every new endpoint comes with an integration test for the happy path **and** for each
authorization rule ("viewer gets 403", "stranger gets 404"). Authorization bugs are the ones that
end up in incident reports, and they are invisible in manual testing as an admin user.
:::

## A pipeline from day one

You now have tests that catch real bugs, so let a machine run them on every push. Real teams set
up CI as soon as the first meaningful test exists, not at the end: every later lesson then lands
on a `main` that is known to be green. Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read            # the workflow token can read the repo and nothing else

jobs:
  backend:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-dotnet@v5
        with:
          dotnet-version: "10.0.x"
      - run: dotnet build -c Release
      # ApiFactory starts its own postgres:18 with Testcontainers; GitHub's Ubuntu runners have Docker.
      - run: dotnet test -c Release --no-build
```

Push it on a branch, open a pull request and watch the `backend` check go green. Then, in the
repository settings, add a branch rule for `main` that requires that check. This file stays small
on purpose: cap-09 replaces it with the full pipeline (unit tests with a coverage gate, the
worker's integration tests on a service container, the web job and Playwright e2e).


:::quiz id=cap-03-q3 xp=15
Why does `ProjectGate` load a small `ProjectAccess` record and then call `IAuthorizationService`,
instead of putting `[Authorize(Roles = "editor")]` on the endpoint?
- [ ] Role attributes are not supported on minimal APIs
- [x] The role depends on which project is being accessed, which the attribute cannot know before the endpoint loads that project
- [ ] `[Authorize]` attributes are slower than calling the service
- [ ] Token roles cannot be read when `MapInboundClaims = false`
> Static roles live in the token and are the same for every request; project roles live in the database and depend on the route's `{id}`. That is exactly what resource-based authorization is for: load the resource, then authorize against it. The first option is false (minimal APIs support `RequireAuthorization(...)` and `[Authorize(Roles = …)]` fine), it just answers the wrong question: "is Ada an editor *somewhere*?" instead of "on *this* project?".
:::

:::quiz id=cap-03-q4 xp=15
**What happens if…** you delete the line `o.MapInboundClaims = false;` from `AuthSetup` and change
nothing else?
- [ ] Nothing: `sub` is a standard claim, so it keeps its name
- [ ] Token validation fails, so every request gets 401
- [x] Tokens still validate, but `FindFirstValue("sub")` returns `null`, so `CurrentUser` throws "The access token has no 'sub' claim" and signed-in requests fail with 500
- [ ] The API starts accepting tokens without a signature
> With inbound mapping on, the handler renames `sub` to the long `…/nameidentifier` URI (and `email`, `name` similarly) *after* validating the token. Signature, issuer and audience are still checked, so 401 is the tempting but wrong answer: authentication succeeds, and the failure shows up later when your code looks for a claim name that no longer exists. Mapping never weakens signature checks. Keeping claim names exactly as the token has them avoids this whole class of "works in the debugger, null in code" bugs.
:::

:::quiz id=cap-03-q5 xp=15
**Spot the bug.** An earlier draft of `CurrentUser` provisioned users like this. Two browser tabs
of a brand-new user send their first requests at the same moment. What goes wrong?

```csharp
var user = await db.Users.SingleOrDefaultAsync(u => u.Subject == subject, ct);
if (user is null)
{
    user = new User { Subject = subject, Email = email, DisplayName = name };
    db.Users.Add(user);
    await db.SaveChangesAsync(ct);
}
return user;
```

- [ ] Nothing: EF Core serializes `SaveChangesAsync` calls across requests
- [x] Both requests see "no user", both insert, and the second one fails with a unique-constraint violation on `subject`, so that tab gets a 500
- [ ] Two user rows are created for the same person
- [ ] The second request waits for the first one's transaction and then reads its row
> Each request has its own `DbContext`, and nothing coordinates them: this is check-then-act again. The unique index on `subject` stops a duplicate row (so "two rows" is wrong: the database saves you from corruption), but the losing request crashes. `INSERT … ON CONFLICT (subject) DO NOTHING` followed by a `SELECT` makes both requests succeed and see the same row, because the database settles the race.
:::

:::cards id=cap-03-cards1 xp=15 title="API foundation"
Q: What does the API validate on a bearer token?
A: Signature (key), issuer, audience and lifetime. It never sees a password.
Q: What does `MapInboundClaims = false` change?
A: Claims keep their JWT names (`sub`, `email`, `name`) instead of being mapped to long legacy URIs.
Q: How are users created?
A: Just in time: first request with an unknown `sub` inserts a row with `ON CONFLICT (subject) DO NOTHING`.
Q: 401 vs 403 vs 404 in BranchStory?
A: 401 = no/invalid token. 404 = not a member (don't leak existence). 403 = member with too low a role.
Q: What turns DataAnnotations into 400 responses in .NET 10 minimal APIs?
A: `builder.Services.AddValidation()`; errors come back as ValidationProblemDetails.
Q: Liveness vs readiness?
A: Liveness: process alive (failing restarts the pod). Readiness: can serve, dependencies included (failing removes it from load balancing).
Q: What does each part of a JWT check stop?
A: Signature: forged/edited tokens. Issuer: tokens from another provider. Audience: tokens meant for another API. Lifetime: old leaked tokens.
Q: HS256 vs RS256?
A: HS256 signs and verifies with one shared secret (fine for a dev issuer). RS256/ES256 sign with a private key; APIs verify with public keys from the provider's JWKS URL and can't mint tokens.
Q: Why put `RequireAuthorization()` on the `/api` group?
A: Secure by default: every endpoint in the group needs a signed-in user unless it explicitly opts out, so a forgotten attribute can't open a hole.
Q: Why one Postgres container for the whole test run?
A: Startup takes seconds; an assembly fixture shares it, and unique users per test keep tests isolated.
:::

## Recap

- Feature folders + route groups: `/api/projects` is one file you can read top to bottom.
- JWT bearer validates tokens from a dev issuer locally or a real OIDC authority in production; users are provisioned just in time from `sub`.
- Project roles are resource-based: `ProjectGate` loads access in one query and maps it to 404 / 403 / allowed.
- `AddValidation`, ProblemDetails and typed results give a consistent, self-describing (OpenAPI) contract.
- Liveness ≠ readiness. Only readiness depends on Postgres.
- `WebApplicationFactory` + Testcontainers + an assembly fixture = fast, honest integration tests.
- A minimal GitHub Actions pipeline runs build + tests on every push from now on; cap-09 grows it.
