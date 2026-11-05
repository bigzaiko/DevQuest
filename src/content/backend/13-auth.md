---
id: be-13
title: Authentication & Authorization
level: advanced
minutes: 75
xp: 150
summary: AuthN vs AuthZ, cookies vs JWT bearer, OIDC with Keycloak/Entra ID, claims, policies, resource-based owner/editor/viewer checks, password hashing, API keys, refresh tokens, signed webhooks and an OWASP API Top 10 hardening checklist.
---

Security code fails differently from other code. Most bugs announce themselves; auth bugs stay
silent. If an endpoint forgets a check, every test still passes and every user is still happy,
until someone reads a project they were never invited to. This lesson builds the mental model and
the ASP.NET Core 10 setup used by real SaaS backends. **Identity is delegated to an OpenID Connect
provider** (Keycloak, Entra ID, Auth0, …), and **authorization is decided by your API**, often
per resource.

## Two different questions

| | Authentication (AuthN) | Authorization (AuthZ) |
|---|---|---|
| Question | *Who are you?* | *What may you do, here?* |
| Input | a cookie, a bearer token, an API key | the authenticated user + the operation (+ the resource) |
| ASP.NET Core | authentication **handlers/schemes** produce a `ClaimsPrincipal` | **policies**, requirements and handlers |
| Failure | **401 Unauthorized** ("I don't know you") + `WWW-Authenticate` | **403 Forbidden** ("I know you, and no") |

The names are historical: 401 is really "unauthenticated". A third answer matters just as much in
multi-tenant APIs: **404 Not Found** for resources the caller isn't allowed to know about. If
`GET /api/projects/{id}` returns 403 to strangers, an attacker learns that the id exists.

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(/* default scheme */).AddJwtBearer(/* ... */);
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();   // reads the token → HttpContext.User
app.UseAuthorization();    // evaluates the endpoint's policies against HttpContext.User
```

`WebApplication` adds both middlewares automatically when the services are registered. Many
teams still write them explicitly, because their **position** matters. They must run after routing
and CORS, and before the endpoints.

Three ASP.NET Core terms come up again and again in this lesson:

- An **authentication scheme** is a named handler that knows one way of proving identity:
  `"Bearer"` (JWTs), `"Cookies"`, or your own `"ApiKey"`. The *default scheme* is the one used
  when an endpoint doesn't name one.
- **Authenticate** = the scheme reads the request and either produces a `ClaimsPrincipal`, fails
  (bad/expired token) or says "no result" (no credentials at all → the user stays anonymous).
- When authorization says no, the scheme turns that into a response. **Challenge** is used for an
  anonymous user (JWT bearer: `401` + `WWW-Authenticate: Bearer`), **Forbid** for a known user
  who lacks permission (`403`).

So the middleware pipeline for a protected request is: *authenticate → run the endpoint's
policies → challenge (401), forbid (403) or call the endpoint*.

:::quiz id=be-13-q1 xp=10
Carol is logged in and is a **viewer** on project Apollo. Dave is logged in but is **not a member**.
A third request is sent with **no token at all**. What should a well-designed API return for
`PUT /api/projects/{apolloId}` in each case?

- [ ] Carol 401, Dave 401, no token 403
- [ ] Carol 403, Dave 403, no token 403
- [x] Carol 403, Dave 404, no token 401
- [ ] Carol 404, Dave 403, no token 401
> No token means unauthenticated (401). Carol is a member, so she already knows the project exists, but a viewer may not edit it (403). For Dave the project should be invisible (404). The tempting "Dave 403" answer leaks information: an attacker could probe ids and learn which ones exist. And 401 is never right for Carol or Dave, because the API knows exactly who they are.
:::

## Cookies vs. bearer tokens

Both carry "proof of who you are" on every request. They differ in **who holds the proof** and how
the browser behaves.

| | Cookie auth | JWT bearer |
|---|---|---|
| Sent by | the browser, automatically, to its origin | the client code, explicitly: `Authorization: Bearer <jwt>` |
| Best for | server-rendered apps, **BFF** for SPAs | APIs called by SPAs, mobile apps, other services |
| Revocation | easy (server-side session / security stamp) | hard: valid until expiry, so keep it short (5–15 min) |
| CSRF | a risk: needs SameSite + antiforgery | not affected (the browser doesn't attach it) |
| XSS impact | `HttpOnly` cookies can't be read by script | tokens in JS memory/storage can be stolen by XSS |

A **JWT** (JSON Web Token) is `header.payload.signature`, Base64url-encoded. The payload holds
**claims** such as `sub` (user id), `iss` (issuer), `aud` (audience), `exp` (expiry) and `roles`.
The signature proves the issuer created it, so the API can validate it **without a database
lookup**. That's why JWTs scale. It's also why you can't easily revoke one.

```text
eyJhbGciOiJSUzI1NiIsImtpZCI6IjQyIn0 . eyJzdWIiOiI4ZjFj…LCJleHAiOjE3OTk5OTk5OTl9 . kX3v…
└── header {"alg":"RS256","kid":"42"} └── payload {"sub":"8f1c…","exp":1799999999} └── signature
```

:::warn title="Signed is not encrypted"
Anyone holding a JWT can Base64-decode the payload (paste one into jwt.io). Never put secrets or
sensitive personal data in claims. And never "read" a token in the API without validating it:
decoding the payload by hand and trusting `sub` is an authentication bypass, because anyone can
craft a payload. Let `AddJwtBearer` do the validation (signature, `iss`, `aud`, `exp`, allowed algorithms).
:::

:::pro title="The BFF pattern for SPAs"
The current OAuth guidance for browser apps (the *OAuth 2.0 for Browser-Based Apps* BCP) recommends
a **Backend-for-Frontend**. A thin server-side component does the OIDC login, keeps the tokens
server-side and gives the React app an `HttpOnly; Secure; SameSite=Strict` session cookie. The BFF
forwards API calls with the access token attached (YARP or Duende.BFF are common). The SPA never
touches a token, which removes the biggest XSS payoff. Pure SPA + bearer token is still very
common, though, and is what most APIs (including ours) must support anyway for mobile and service
clients.
:::

:::info title="Cookie auth and APIs in .NET 10"
Cookie authentication used to answer unauthenticated API calls with a **302 redirect to /Account/Login**,
which confused every `fetch` call. Since ASP.NET Core 10, endpoints recognised as API endpoints
(controllers with `[ApiController]`, minimal API endpoints that read or write JSON, SignalR hubs) get a
plain **401/403** instead.
:::

## OpenID Connect in one diagram

Your API doesn't handle passwords or login pages. An **identity provider** (IdP) does. The API is
an OAuth 2.0 **resource server**: it validates access tokens and authorizes requests.

```text
 React SPA                     Keycloak / Entra ID                    Projects API
    │ 1. redirect to /authorize (code + PKCE) ──▶│                        │
    │◀── 2. user logs in, code returned ─────────│                        │
    │ 3. exchange code (+ verifier) ────────────▶│                        │
    │◀── 4. id_token + access_token (+ refresh) ─│                        │
    │ 5. GET /api/projects  Authorization: Bearer <access_token> ───────▶ │
    │                                            │◀ 6. (once, cached) GET  │
    │                                            │   /.well-known/openid-  │
    │                                            │   configuration + JWKS  │
    │◀──────────────────────────────── 7. 200 (signature, iss, aud, exp OK)│
```

- **Authorization Code + PKCE** is *the* flow for SPAs and mobile apps. The IdP returns a short-lived
  one-time *code*, and the client exchanges it for tokens. **PKCE** (*Proof Key for Code Exchange*)
  protects that exchange: the client invents a random `code_verifier`, sends only its hash
  (`code_challenge`) in step 1 and the verifier itself in step 3. A thief who intercepts the code
  can't redeem it without the verifier. The old *implicit* flow (tokens straight in the URL) is
  deprecated; don't use it.
- **Client credentials** is for service-to-service calls (a worker calling the API, no user).
- The **ID token** is for the *client* (who logged in). The **access token** is for the *API*.
  APIs must only accept access tokens meant for them, which is what the **audience** check enforces.

### Configuring `AddJwtBearer`

```csharp
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = builder.Configuration["Auth:Authority"];
        options.Audience = builder.Configuration["Auth:Audience"];
        options.MapInboundClaims = false;
        options.TokenValidationParameters.NameClaimType = "preferred_username";
        options.TokenValidationParameters.RoleClaimType = "roles";
        if (builder.Environment.IsDevelopment())
            options.RequireHttpsMetadata = false;   // local Keycloak on http://
    });
```

- **`Authority`** is the issuer URL. The handler downloads `{Authority}/.well-known/openid-configuration`,
  takes the signing keys (JWKS) from it, caches them and refreshes them when keys rotate. It also
  validates `iss` against the issuer in the metadata.
- **`Audience`** must match the token's `aud`. Without this check, a token issued for *any* app in
  the same realm/tenant would work against your API.
- Lifetime (`exp`/`nbf`) is validated by default, with a **`ClockSkew` of 5 minutes**. A token that
  expired 2 minutes ago is still accepted.

| Provider | `Authority` | `Audience` |
|---|---|---|
| Keycloak | `https://id.example.com/realms/devquest` | the client id the token is for, e.g. `projects-api` |
| Entra ID | `https://login.microsoftonline.com/{tenant-id}/v2.0` | the app id URI / client id, e.g. `api://8f1c…` |
| Auth0 | `https://your-tenant.eu.auth0.com/` | the API identifier |

:::warn title="Keycloak gotchas you will hit"
1. **Audience**: Keycloak access tokens have `aud: "account"` by default. Add an *Audience* mapper
   (client scope → mappers → "Audience", included client = `projects-api`), or you get
   `IDX10214: Audience validation failed`.
2. **Roles** are nested: `"realm_access": { "roles": ["admin"] }`. Either add a *User Realm Role*
   mapper with token claim name `roles` (multivalued), or flatten them with an `IClaimsTransformation`.
3. **Issuer must match exactly.** A token issued via `http://localhost:8080/realms/devquest` isn't
   valid for an API that sees Keycloak as `http://keycloak:8080/...` inside Docker. Set Keycloak's
   `KC_HOSTNAME` so both sides agree.
:::

:::quiz id=be-13-q2 xp=15
Your API responds 401 to a fresh Keycloak token. The logs say:
`IDX10214: Audience validation failed. Audiences: 'account'. Did not match: validationParameters.ValidAudience: 'projects-api'`.
What's the right fix?

- [ ] Set `TokenValidationParameters.ValidateAudience = false`
- [ ] Set `options.Audience = "account"`
- [x] Configure Keycloak to include `projects-api` in the token's `aud` (Audience mapper on the client scope)
- [ ] Switch from `AddJwtBearer` to cookie authentication
> The API is doing its job: this token was not issued *for* it. Disabling the check, or accepting `account` (the audience of Keycloak's own account console), means a token minted for *any* client in the realm works against your API, so a compromised low-value app becomes a key to yours. The token should say it's meant for this API, and that's an IdP configuration change. Switching to cookies doesn't fix anything; it just moves the problem.
:::

## Claims and `ClaimsPrincipal`

After authentication, `HttpContext.User` is a `ClaimsPrincipal`. Minimal API handlers can take it
as a parameter.

```csharp
app.MapGet("/api/me", (ClaimsPrincipal user) => new
{
    Id = user.FindFirstValue("sub"),          // stable user id: use this as your key
    Name = user.Identity?.Name,               // from NameClaimType (preferred_username)
    Roles = user.FindAll("roles").Select(c => c.Value),
    IsAdmin = user.IsInRole("admin"),         // uses RoleClaimType
});
```

Historically the JWT handler **renamed** incoming claims to long WS-Federation URIs: `sub` became
`http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier`, `role` became
`ClaimTypes.Role` and so on. `MapInboundClaims = false` keeps the names from the token, so your
code reads `"sub"` like every other platform does. Set it on day one.

**Never key users by e-mail or username.** Both can change. `sub` (together with the issuer) is
the stable identifier. Store it in `Project.OwnerId` and `ProjectMember.UserId`.

```csharp
// Flatten Keycloak's realm_access.roles into "roles" claims (runs after every authentication)
public sealed class KeycloakRolesTransformation : IClaimsTransformation
{
    public Task<ClaimsPrincipal> TransformAsync(ClaimsPrincipal principal)
    {
        var identity = (ClaimsIdentity)principal.Identity!;
        var json = principal.FindFirstValue("realm_access");
        if (json is null || identity.HasClaim(c => c.Type == "roles")) return Task.FromResult(principal);

        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.TryGetProperty("roles", out var roles))
            foreach (var role in roles.EnumerateArray())
                identity.AddClaim(new Claim("roles", role.GetString()!));
        return Task.FromResult(principal);
    }
}
// builder.Services.AddTransient<IClaimsTransformation, KeycloakRolesTransformation>();
```

:::quiz id=be-13-q3 xp=15
A colleague writes `var userId = user.FindFirstValue("sub");` and gets `null`, even though
jwt.io shows a `sub` claim in the token. `MapInboundClaims` isn't set. Why?

- [ ] The token signature is invalid, so claims are dropped
- [x] Inbound claim mapping renamed `sub` to `ClaimTypes.NameIdentifier`; set `MapInboundClaims = false` (or read `ClaimTypes.NameIdentifier`)
- [ ] `sub` is only available in ID tokens
- [ ] `FindFirstValue` only works for role claims
> The default mapping translates short JWT claim names to the legacy `ClaimTypes.*` URIs, so the claim is there, just under another name. An invalid signature is not the cause: then authentication would fail and the request would get 401, with no claims at all. Turning mapping off is the modern choice, because claim names then match the token, the docs and every other language's libraries.
:::

## Policies

ASP.NET Core authorization is **policy-based**. A policy is a list of requirements, and it passes
when all of them are satisfied.

```csharp
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin", p => p.RequireRole("admin"))
    // OAuth scopes arrive as ONE space-separated claim: "scope": "openid profile projects:write"
    // (Entra ID calls it "scp"), so RequireClaim("scope", "projects:write") would only match a
    // token that has exactly that single scope. Split it instead:
    .AddPolicy("projects:write", p => p.RequireAssertion(ctx =>
        (ctx.User.FindFirstValue("scope") ?? "").Split(' ').Contains("projects:write")))
    .AddPolicy("enterprise", p => p.RequireClaim("plan", "enterprise", "partner")) // any of these values
    // Secure by default: endpoints WITHOUT any auth metadata still require a logged-in user
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

var api = app.MapGroup("/api").RequireAuthorization();          // default policy: authenticated
api.MapGroup("/admin").RequireAuthorization("admin");           // + admin role
app.MapGet("/", () => "Projects API").AllowAnonymous();         // explicit opt-out
app.MapHealthChecks("/health/live").AllowAnonymous();
```

Three different things are in play here, and they're easy to mix up:

- The **default policy** is what a bare `RequireAuthorization()` / `[Authorize]` means. Out of the
  box: "any authenticated user".
- A **named policy** (`RequireAuthorization("admin")`) is a specific set of requirements.
- The **fallback policy** applies only to endpoints that have *no* authorization metadata at all.
  It's your safety net: a forgotten `RequireAuthorization()` then means "authenticated users only"
  rather than "the whole internet". `AllowAnonymous()` opts an endpoint out explicitly.

:::warn title="Don't authorize on e-mail addresses"
A policy like "e-mail ends with `@devquest.dev` → staff" looks harmless but is a known attack
vector: in many IdPs the `email` claim is user-editable or unverified, so an attacker can sign up
as `mallory@devquest.dev`. Authorize on roles, groups or claims your IdP controls, and identify
users by `sub`.
:::

:::quiz id=be-13-q4 xp=15
Spot the bug. Every request with a valid token gets **401**.

```csharp
var app = builder.Build();
app.UseAuthorization();
app.UseAuthentication();
app.MapProjectEndpoints();   // group has .RequireAuthorization()
app.Run();
```

- [ ] `MapProjectEndpoints` must come before the middlewares
- [x] Authorization runs before authentication, so `HttpContext.User` is still anonymous when the policy is evaluated
- [ ] Nothing; order doesn't matter for these two
- [ ] `RequireAuthorization()` needs a policy name
> Middleware runs in registration order. When `UseAuthorization()` runs first, `HttpContext.User` is still the empty anonymous principal, so the policy fails and the request is challenged with 401 before authentication ever looks at the token. Endpoints are mapped separately from middleware, so moving `MapProjectEndpoints` changes nothing, and a bare `RequireAuthorization()` is valid (it uses the default policy). Fix: `UseAuthentication()` then `UseAuthorization()`.
:::

## Role-based vs. resource-based authorization

**Role-based** checks look only at the user: "is this user an `admin`?" That's perfect for
*global* roles that live in the token.

A collaboration SaaS mostly needs **resource-based** checks: "is *this* user at least an *editor*
of *this* project?" The answer depends on data in your database (`ProjectMember` rows), so it can't
be a static attribute. You load the resource and then ask `IAuthorizationService`:

```csharp
public enum ProjectRole { Viewer = 1, Editor = 2, Owner = 3 }   // ordered: Owner ⊇ Editor ⊇ Viewer

public sealed record ProjectAccessRequirement(ProjectRole MinimumRole) : IAuthorizationRequirement
{
    public static readonly ProjectAccessRequirement View = new(ProjectRole.Viewer);
    public static readonly ProjectAccessRequirement Edit = new(ProjectRole.Editor);
    public static readonly ProjectAccessRequirement Own  = new(ProjectRole.Owner);
}

public sealed class ProjectAccessHandler : AuthorizationHandler<ProjectAccessRequirement, Project>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, ProjectAccessRequirement requirement, Project project)
    {
        var member = project.Members.FirstOrDefault(m => m.UserId == context.User.FindFirstValue("sub"));
        if (member is not null && member.Role >= requirement.MinimumRole)
            context.Succeed(requirement);
        return Task.CompletedTask;              // no Succeed = no opinion → denied if nobody succeeds
    }
}
// builder.Services.AddSingleton<IAuthorizationHandler, ProjectAccessHandler>();
```

```csharp
var project = await store.FindAsync(id, ct);
if (project is null || !(await auth.AuthorizeAsync(user, project, ProjectAccessRequirement.View)).Succeeded)
    return TypedResults.NotFound();             // invisible to non-members
if (!(await auth.AuthorizeAsync(user, project, ProjectAccessRequirement.Edit)).Succeeded)
    return TypedResults.Forbid();               // member, but not an editor → 403
```

With EF Core you'd usually not load the whole member list. Instead, query the caller's role
directly: `db.ProjectMembers.Where(m => m.ProjectId == id && m.UserId == userId).Select(m => (ProjectRole?)m.Role).SingleOrDefaultAsync()`.
Then pass a small `ProjectAccess(projectId, role)` record as the resource. For list endpoints,
**filter in the query** (`where p.Members.Any(m => m.UserId == userId)`) instead of authorizing rows
one by one.

:::quiz id=be-13-q5 xp=20
Why not put per-project roles into the JWT, e.g. `"projects": {"apollo":"editor", ...}`? (Select all that apply.)

- [x] Tokens live until they expire, so removing someone from a project wouldn't take effect until then
- [x] Users with hundreds of projects get huge tokens, sent on every request (headers have size limits)
- [x] The IdP would need to know your application's sharing data
- [ ] JWTs can't contain nested objects
> Stale permissions, header bloat and coupling the IdP to your domain data are all real costs. The last option is false: a JWT payload is ordinary JSON, so nested objects are perfectly legal (Keycloak's own `realm_access` claim is one). Tokens are good for *identity* and *coarse, slow-changing* roles (admin, plan tier). Fine-grained, fast-changing permissions belong in your database and are checked per request, which is exactly what resource-based authorization does.
:::

:::job title="Where authorization bugs come from"
Real incidents are rarely "broken crypto". They're **missing checks**: an endpoint added later
without the member check, a list endpoint that filters by `projectId` from the URL but never checks
membership (an IDOR, *insecure direct object reference*), or a bulk endpoint that checks the first
id only. Teams protect themselves with the fallback policy, with authorization in one shared place
(handlers/requirements, not copy-pasted `if`s), and with **integration tests per role**: owner,
editor, viewer, stranger, anonymous. You'll write exactly those in the lab.
:::

## If you must do local accounts: password hashing

Prefer an IdP. If you store passwords yourself, **never** use encryption or a fast hash
(MD5/SHA-x). Use a slow, salted, adaptive algorithm. ASP.NET Core ships `PasswordHasher<TUser>`
(PBKDF2 with HMAC-SHA512, a random 128-bit salt and 100,000 iterations by default in current .NET
versions). Argon2id or bcrypt via a well-known library are fine too.

Why *slow*? Attackers who steal your user table don't attack your login form. They run guesses
offline on GPUs. A single SHA-256 costs nanoseconds, so billions of guesses per second are
realistic. 100,000 PBKDF2 iterations make each guess 100,000 times more expensive. The **salt**
(random bytes stored next to each hash) makes identical passwords hash differently, so one
precomputed table can't crack everyone at once.

```csharp
var hasher = new PasswordHasher<AppUser>();
string hash = hasher.HashPassword(user, "correct horse battery staple");  // salt + params embedded

var result = hasher.VerifyHashedPassword(user, hash, attempt);
if (result == PasswordVerificationResult.SuccessRehashNeeded)
    user.PasswordHash = hasher.HashPassword(user, attempt);  // upgrade old hashes transparently
```

ASP.NET Core Identity (`AddIdentityApiEndpoints` + `MapIdentityApi`) builds on this and adds
lockout, e-mail confirmation and 2FA. Account security has a long tail (resets, MFA, breach checks,
lockout), and that's why outsourcing it to Keycloak or Entra ID is the default.

:::quiz id=be-13-q6 xp=15
Which ways of storing user passwords are acceptable? (Select all that apply.)

- [x] `PasswordHasher<T>.HashPassword` (PBKDF2, salted, many iterations)
- [x] Argon2id with a per-user random salt via a vetted library
- [ ] `SHA256(password + globalPepper)`
- [ ] AES-encrypted with a key from configuration, so support can read them
- [ ] `SHA512(salt + password)` with a random salt, one iteration
> Password hashes must be **slow** so stolen hashes can't be brute-forced at billions of guesses per second on GPUs. The salted single-pass SHA-512 is the tempting one: the salt stops precomputed tables, but one SHA pass is still fast, so each password falls to brute force individually. A global pepper without a per-user salt is worse still: equal passwords give equal hashes. Encryption is reversible, so anyone with the key (or the support tool) has every password.
:::

## API keys for machine clients

Integrations, CI scripts and webhooks often use API keys instead of OAuth. Done properly:

- Generate **≥ 32 random bytes** (`RandomNumberGenerator.GetBytes(32)`), shown to the user **once**.
- Store only a **hash**. SHA-256 is fine *here*, because the key is high-entropy and random, not a
  human password. Store a short **prefix** too (`dq_live_3fA9…`) for lookup and display.
- Compare with **`CryptographicOperations.FixedTimeEquals`** to avoid timing side channels.
- Scope keys (read-only, one project), allow several per account for rotation, and record `LastUsedAt`.

```csharp
public sealed class ApiKeyHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder,
    IApiKeyStore keys)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue("X-Api-Key", out var values)) return AuthenticateResult.NoResult();
        var presented = values.ToString();
        if (presented.Length < 20) return AuthenticateResult.Fail("Malformed API key"); // don't let [..12] throw

        var stored = await keys.FindByPrefixAsync(presented[..12]);         // e.g. "dq_live_3fA9"
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(presented));
        if (stored is null || !CryptographicOperations.FixedTimeEquals(hash, stored.Hash))
            return AuthenticateResult.Fail("Invalid API key");

        var identity = new ClaimsIdentity([new Claim("sub", stored.OwnerId), new Claim("auth", "api-key")], Scheme.Name);
        return AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name));
    }
}
// .AddScheme<AuthenticationSchemeOptions, ApiKeyHandler>("ApiKey", null);
// policy: p.AddAuthenticationSchemes(JwtBearerDefaults.AuthenticationScheme, "ApiKey").RequireAuthenticatedUser()
```

:::quiz id=be-13-q7 xp=10
Why `CryptographicOperations.FixedTimeEquals(hash, stored.Hash)` instead of `hash.SequenceEqual(stored.Hash)`?

- [ ] `SequenceEqual` doesn't work on byte arrays
- [x] `SequenceEqual` returns at the first differing byte, so response timing can leak how many leading bytes matched
- [ ] `FixedTimeEquals` also verifies the hash algorithm
- [ ] It's faster
> A constant-time comparison always looks at every byte. Over many requests, an attacker could otherwise measure which guesses get "further" and recover a secret byte by byte. `SequenceEqual` works fine on byte arrays (it gives the right *answer*), and speed is not the point: `FixedTimeEquals` is deliberately no faster on a mismatch. It also knows nothing about hash algorithms; it just compares two spans.
:::

## Refresh tokens

Access tokens should be **short-lived** (5–15 min), because they can't be revoked. To avoid logging
users in every 10 minutes, the IdP also issues a long-lived **refresh token** that the client trades
for a new access token.

Modern IdPs use **refresh-token rotation**. Every refresh returns a *new* refresh token and
invalidates the old one. If an old token is ever presented **again**, two parties hold it (the
user and a thief). The safe response is to **revoke the whole token family** and force a new login.
Keycloak ("Revoke Refresh Token"), Entra ID and Auth0 implement this. You implement it yourself
only if you're issuing tokens yourself, which is a good reason not to.

:::challenge id=be-13-c1 lang=ts xp=50
title: Refresh-token rotation with reuse detection
Implement `RefreshTokenStore`:

- `issue(userId)` starts a new **family** and returns a token.
- Every token string comes from the injected `newId()`, called **exactly once per new token** (the
  tests use a counter, so `rt1`, `rt2`, … must appear in issue order).
- `rotate(token)`:
  - unknown token, or token whose family was revoked → `{ error: 'invalid' }`
  - a token that was **already rotated once** (reuse!) → revoke the whole family and return `{ error: 'reused' }`
  - otherwise mark it used and return `{ token: <new token in the same family>, userId }`

The starter rotates tokens but never notices reuse.

hint: Store per token: `userId`, `family` (e.g. the first token's id) and `used: boolean`.
hint: Keep a `Set` of revoked families and check it before anything else.

```ts starter
type RotateResult = { token: string; userId: string } | { error: 'invalid' | 'reused' }

export class RefreshTokenStore {
  private newId: () => string
  private tokens = new Map<string, { userId: string }>()

  constructor(newId: () => string) {
    this.newId = newId
  }

  issue(userId: string): string {
    const token = this.newId()
    this.tokens.set(token, { userId })
    return token
  }

  rotate(token: string): RotateResult {
    const t = this.tokens.get(token)
    if (!t) return { error: 'invalid' }
    return { token: this.issue(t.userId), userId: t.userId }
  }
}
```

```ts solution
type RotateResult = { token: string; userId: string } | { error: 'invalid' | 'reused' }

export class RefreshTokenStore {
  private newId: () => string
  private tokens = new Map<string, { userId: string; family: string; used: boolean }>()
  private revoked = new Set<string>()

  constructor(newId: () => string) {
    this.newId = newId
  }

  issue(userId: string, family?: string): string {
    const token = this.newId()
    this.tokens.set(token, { userId, family: family ?? token, used: false })
    return token
  }

  rotate(token: string): RotateResult {
    const t = this.tokens.get(token)
    if (!t || this.revoked.has(t.family)) return { error: 'invalid' }
    if (t.used) {
      this.revoked.add(t.family)
      return { error: 'reused' }
    }
    t.used = true
    return { token: this.issue(t.userId, t.family), userId: t.userId }
  }
}
```

```ts tests
function makeStore() {
  let n = 0
  return new RefreshTokenStore(() => `rt${++n}`)
}

test('rotating a fresh token returns a new token for the same user', () => {
  const s = makeStore()
  const t1 = s.issue('alice')
  const r = s.rotate(t1)
  expect(r).toEqual({ token: 'rt2', userId: 'alice' })
})

test('the new token can be rotated again', () => {
  const s = makeStore()
  const r1 = s.rotate(s.issue('alice')) as { token: string }
  const r2 = s.rotate(r1.token)
  expect(r2).toEqual({ token: 'rt3', userId: 'alice' })
})

test('unknown tokens are invalid', () => {
  expect(makeStore().rotate('nope')).toEqual({ error: 'invalid' })
})

test('reusing an already rotated token is detected', () => {
  const s = makeStore()
  const t1 = s.issue('alice')
  s.rotate(t1)
  expect(s.rotate(t1)).toEqual({ error: 'reused' })
})

test('after reuse the whole family is revoked, including the newest token', () => {
  const s = makeStore()
  const t1 = s.issue('alice')
  const r1 = s.rotate(t1) as { token: string }
  s.rotate(t1) // attacker replays the old token
  expect(s.rotate(r1.token)).toEqual({ error: 'invalid' })
})

test('other families are not affected', () => {
  const s = makeStore()
  const a = s.issue('alice')
  const b = s.issue('bob')
  s.rotate(a)
  s.rotate(a) // revoke alice's family
  expect(s.rotate(b)).toEqual({ token: 'rt4', userId: 'bob' })
})
```
:::

## Webhooks: signed events between systems

A **webhook** is an HTTP `POST` that one system sends to another when something happens ("payment
succeeded", "project shared"). You'll *receive* them from Stripe, GitHub or Keycloak, and sooner or later
you'll *send* them to your own customers. Either way the receiver has the same problem: the endpoint is
public, so anyone can `POST` a fake "payment succeeded". The answer is a **signature**: an HMAC over
the exact request body, made with a secret that only the two parties share. Providers differ in the
details (Stripe signs `"{timestamp}.{body}"` and sends `t=…,v1=<hex>`; GitHub sends
`X-Hub-Signature-256`), so always follow the sender's docs or SDK. The code below implements the
**Standard Webhooks** convention: headers `Webhook-Id`, `Webhook-Timestamp` and `Webhook-Signature`, an
HMAC-SHA256 over `"{id}.{timestamp}.{body}"`, sent as `v1,<base64>`. Signing the id too means an attacker
can't replay a captured body under a fresh id to get past your deduplication.

```csharp
public static class WebhookSignature
{
    public static string Sign(byte[] secret, string id, long timestamp, byte[] body)
    {
        byte[] signed = [.. Encoding.UTF8.GetBytes($"{id}.{timestamp}."), .. body];
        return "v1," + Convert.ToBase64String(HMACSHA256.HashData(secret, signed));
    }

    // Simplified: the spec allows several space-separated signatures (key rotation); check each one.
    public static bool IsValid(byte[] secret, string id, long timestamp, byte[] body, string header) =>
        CryptographicOperations.FixedTimeEquals(            // constant time, like API keys above
            Encoding.ASCII.GetBytes(Sign(secret, id, timestamp, body)),
            Encoding.ASCII.GetBytes(header));
}

app.MapPost("/webhooks/payments", async (HttpRequest request, TimeProvider clock,
    IOptions<WebhookOptions> options, IJobQueue jobs, CancellationToken ct) =>
{
    // 1. The RAW bytes. Deserializing and re-serializing changes whitespace and order,
    //    and then no signature matches.
    using var buffer = new MemoryStream();
    await request.Body.CopyToAsync(buffer, ct);
    var body = buffer.ToArray();
    var webhookId = request.Headers["Webhook-Id"].ToString();

    // 2. Reject old timestamps, so a captured request can't be replayed next week.
    if (!long.TryParse(request.Headers["Webhook-Timestamp"], out var timestamp)
        || Math.Abs(clock.GetUtcNow().ToUnixTimeSeconds() - timestamp) > 300)
        return Results.Unauthorized();

    // 3. Verify the signature before trusting a single byte of the body.
    if (webhookId.Length == 0 || !WebhookSignature.IsValid(options.Value.PaymentsSecret, webhookId,
            timestamp, body, request.Headers["Webhook-Signature"].ToString()))
        return Results.Unauthorized();

    // 4. Answer fast; do the work in a durable job (be-16). Providers retry on timeouts and
    //    non-2xx, so the job must be idempotent: dedupe on Webhook-Id (be-18).
    await jobs.EnqueueAsync("payments.webhook", webhookId, body, ct);
    return Results.Accepted();
}).AllowAnonymous();   // authenticated by the signature, not by a token
```

When **you send** webhooks, you take the other side of the same rules: one secret per subscriber
(shown once, rotatable), sign every delivery, send from a background queue with retries and backoff
(be-16), and use a short timeout. Customer-supplied URLs are also a classic **SSRF** door (OWASP API7
below). Allow only `https`, resolve the host and refuse private and link-local addresses such as
`10.0.0.0/8`, `169.254.169.254` (cloud metadata) and `localhost`.

## Hardening checklist: the OWASP API Top 10

The **OWASP API Security Top 10** (2023 edition) is the list security reviewers, pentesters and
interviewers use for APIs. Most of it maps to things this track teaches, which makes it a good
checklist for a pull request:

| # | Risk | What it looks like | Where you handle it |
|---|---|---|---|
| API1 | Broken object level authorization (BOLA) | `GET /projects/{id}` returns *any* project to anyone logged in | Resource-based checks (this lesson); 404 for non-members |
| API2 | Broken authentication | Homemade token parsing, no `exp` check, keys in URLs | `AddJwtBearer` with `Authority`/`Audience`; hashed API keys |
| API3 | Broken object property level authorization | Returning `CostPrice`; binding `IsAdmin` from the request body (mass assignment) | Separate request/response DTOs (be-07) |
| API4 | Unrestricted resource consumption | `?pageSize=100000`, 2 GB uploads, unlimited requests | Rate limiting (be-19), capped pagination (be-20), body size limits (be-07) |
| API5 | Broken function level authorization | `/admin/*` endpoints that only check "logged in" | Policies, fallback policy, `RequireAuthorization` on groups |
| API6 | Unrestricted access to sensitive business flows | Bots buying all stock, mass sign-ups | Per-user limits, quotas (be-21), CAPTCHA at the edge |
| API7 | Server-side request forgery (SSRF) | "Fetch this URL for me": webhooks, link previews, imports | Allowlists, block private IP ranges, no redirects |
| API8 | Security misconfiguration | Stack traces in responses, `AllowAnyOrigin` with credentials, no HTTPS | ProblemDetails without details (be-09), strict CORS (be-09), headers below |
| API9 | Improper inventory management | A forgotten `/api/v1` or staging API with no auth | Published OpenAPI document, deliberate version retirement (be-07) |
| API10 | Unsafe consumption of APIs | Trusting a partner's response blindly, no timeouts | Validate external responses; timeouts and circuit breakers (be-19) |

### HTTPS, HSTS and response headers

```csharp
builder.WebHost.ConfigureKestrel(o => o.AddServerHeader = false);   // don't advertise "Server: Kestrel"

var app = builder.Build();
if (!app.Environment.IsDevelopment())
    app.UseHsts();             // Strict-Transport-Security: browsers refuse plain HTTP from now on
app.UseHttpsRedirection();

app.Use(async (ctx, next) =>   // cheap defaults for a JSON API
{
    var h = ctx.Response.Headers;
    h.XContentTypeOptions = "nosniff";                                   // don't guess content types
    h.XFrameOptions = "DENY";                                            // never render in a frame
    h.ContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'";
    h["Referrer-Policy"] = "no-referrer";
    await next(ctx);
});
```

In Kubernetes, TLS usually ends at the ingress and the pod only sees plain HTTP. Then
`UseHttpsRedirection` can redirect in a loop, and `Request.Scheme` and client IPs are wrong, until you add
`UseForwardedHeaders()` and tell it which proxies to trust (the Containers & Kubernetes track sets up the
ingress). The strict CSP above is right for JSON responses. Don't apply it to the Scalar docs page or to
an HTML frontend. The SPA's own CSP is covered in **Frontend Security & Auth**.

### Data Protection keys: the multi-replica surprise

ASP.NET Core encrypts auth cookies, antiforgery tokens and some other payloads with its **Data
Protection** keys. By default each process keeps its own keys (in the user profile on local disk, which
in a container disappears with the container, or only in memory if there's nowhere to write). With one replica nobody notices. With three replicas, a cookie issued by pod A can't be read
by pod B, and every deploy logs everyone out. Store the keys somewhere shared, and protect them at rest:

```csharp
builder.Services.AddDataProtection()
    .SetApplicationName("projects-api")            // apps sharing keys must use the same name
    .PersistKeysToDbContext<AppDbContext>();       // package Microsoft.AspNetCore.DataProtection.EntityFrameworkCore
    // alternatives: PersistKeysToStackExchangeRedis(...), PersistKeysToAzureBlobStorage(...) + ProtectKeysWithAzureKeyVault(...)
```

(`AppDbContext` then implements `IDataProtectionKeyContext` with a `DbSet<DataProtectionKey>`.) A pure
bearer-token API doesn't depend on these keys for authentication, because the identity provider signs the
tokens. The moment you add cookies, a BFF or antiforgery, you do.

:::quiz id=be-13-q9 xp=15
A webhook endpoint does this. Which statements are true? (Select all that apply.)

```csharp
app.MapPost("/webhooks/payments", async (PaymentEvent evt, HttpRequest req) =>
{
    var json = JsonSerializer.Serialize(evt);
    var expected = WebhookSignature.Sign(secret, id, ts, Encoding.UTF8.GetBytes(json));
    if (expected != req.Headers["Webhook-Signature"]) return Results.Unauthorized();
    await payments.MarkPaidAsync(evt.OrderId);
    return Results.Ok();
});
```

- [x] Valid deliveries can fail verification, because the re-serialized JSON isn't byte-for-byte what the sender signed
- [x] Comparing with `!=` can leak through response timing how much of a guessed signature was right
- [x] Without a timestamp check, a captured valid request can be replayed later
- [ ] It's safe as long as the endpoint uses HTTPS
- [x] A retried delivery marks the order paid twice unless the handler dedupes on the event id
> The signature covers the **raw bytes**, so read the body yourself before any deserialization. Compare in constant time (`CryptographicOperations.FixedTimeEquals`). Reject timestamps outside a few minutes to stop replays. Providers deliver at least once, so the processing must be idempotent. HTTPS only protects the data in transit. It doesn't prove who sent the request, which is the signature's job.
:::

:::quiz id=be-13-q10 xp=10
`PUT /api/users/me` binds the request body straight into the `User` entity and saves it. A user sends `{ "name": "Eve", "isAdmin": true }`. Which OWASP API risk is this?

- [ ] API1: broken object level authorization
- [x] API3: broken object property level authorization (mass assignment)
- [ ] API7: server-side request forgery
- [ ] API9: improper inventory management
> The user is allowed to update **this object** (their own profile), so object-level authorization is fine. What's broken is which **properties** they may set. Binding entities directly lets clients write any field the entity has. The fix is a request DTO with only the editable fields (be-07), which is also the fix for the response side of API3: never returning fields like `CostPrice` or `PasswordHash`.
:::

## Lab: JWT auth + owner/editor/viewer, tested per role

:::lab id=be-13-lab1 xp=150
title: Secure the Projects API with JWTs and resource-based roles
You'll build an API that validates JWTs exactly as it would against Keycloak (`Authority` +
`Audience`), applies a fallback policy, an `admin` role policy, and **per-project roles** through a
resource-based authorization handler. The tests mint real signed JWTs with a test key and check
**401 / 403 / 404 / 200 for each kind of user**. No Keycloak is needed to run them.

Seed data: project **Apollo** with `alice` (Owner), `bob` (Editor) and `carol` (Viewer). `dave`
is not a member.

:::info title="Still an in-memory store: isolating the auth concern"
Like be-12, this lab keeps projects in a seeded in-memory store so that every test failure is about
**authentication or authorization**, not a missing container or migration. The authorization handler only
needs "what is this user's role in this project?". It doesn't care whether that answer comes from a
dictionary or from `db.ProjectMembers` (be-11). From be-15 on, the Projects API runs on EF Core and real
PostgreSQL again, and the boss fight (be-21) combines this exact auth setup with the database.
:::

**1. Create the solution**

```bash
mkdir -p ~/devquest/be-13-lab1 && cd ~/devquest/be-13-lab1
dotnet new sln -n ProjectsAuth
dotnet new web -o Projects.Api
dotnet new xunit -o Projects.Api.Tests
dotnet sln add Projects.Api Projects.Api.Tests
dotnet add Projects.Api.Tests reference Projects.Api
dotnet add Projects.Api package Microsoft.AspNetCore.Authentication.JwtBearer --version 10.0.14
dotnet add Projects.Api.Tests package Microsoft.AspNetCore.Mvc.Testing --version 10.0.14
rm Projects.Api.Tests/UnitTest1.cs
mkdir -p Projects.Api/Domain Projects.Api/Infrastructure Projects.Api/Auth Projects.Api/Features
```

**2. `Projects.Api/appsettings.json`**: where Keycloak would live

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  },
  "AllowedHosts": "*",
  "Auth": {
    "Authority": "http://localhost:8080/realms/devquest",
    "Audience": "projects-api"
  }
}
```

**3. `Projects.Api/Program.cs`**

```csharp
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;
using Projects.Api.Auth;
using Projects.Api.Features;
using Projects.Api.Infrastructure;

var builder = WebApplication.CreateBuilder(args);

// ── Authentication: WHO are you? Validate JWTs issued by Keycloak (or Entra ID, Auth0, …)
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = builder.Configuration["Auth:Authority"]; // issuer; keys come from its metadata
        options.Audience = builder.Configuration["Auth:Audience"];   // token must be meant for THIS api
        options.MapInboundClaims = false;                            // keep "sub", "roles" as they are
        options.TokenValidationParameters.NameClaimType = "preferred_username";
        options.TokenValidationParameters.RoleClaimType = "roles";
        if (builder.Environment.IsDevelopment())
            options.RequireHttpsMetadata = false;                    // local Keycloak on http://
    });

// ── Authorization: WHAT may you do?
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin", p => p.RequireRole("admin"))
    // Secure by default: every endpoint needs an authenticated user unless it opts out.
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

builder.Services.AddSingleton<IAuthorizationHandler, ProjectAccessHandler>();
builder.Services.AddSingleton<IProjectStore, InMemoryProjectStore>();
builder.Services.AddProblemDetails();

var app = builder.Build();

app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/", () => "Projects API").AllowAnonymous();
app.MapProjectEndpoints();

app.Run();
```

**4. `Projects.Api/Domain/Project.cs`**

```csharp
namespace Projects.Api.Domain;

// Order matters: a higher value includes every permission of the lower ones.
public enum ProjectRole { Viewer = 1, Editor = 2, Owner = 3 }

public record ProjectMember(string UserId, ProjectRole Role);

public class Project
{
    public Guid Id { get; init; }
    public required string Name { get; set; }
    public required string OwnerId { get; init; }
    public int Version { get; set; } = 1;
    public List<ProjectMember> Members { get; init; } = [];
}
```

**5. `Projects.Api/Infrastructure/InMemoryProjectStore.cs`** (seeded)

```csharp
using System.Collections.Concurrent;
using Projects.Api.Domain;

namespace Projects.Api.Infrastructure;

public interface IProjectStore
{
    Task<Project?> FindAsync(Guid id, CancellationToken ct);
    Task<IReadOnlyList<Project>> ListAsync(CancellationToken ct);
    Task RemoveAsync(Guid id, CancellationToken ct);
}

public class InMemoryProjectStore : IProjectStore
{
    public static readonly Guid ApolloId = Guid.Parse("0197a3b0-0000-7000-8000-000000000001");

    private readonly ConcurrentDictionary<Guid, Project> _projects = new()
    {
        [ApolloId] = new Project
        {
            Id = ApolloId,
            Name = "Apollo",
            OwnerId = "alice",
            Members =
            [
                new("alice", ProjectRole.Owner),
                new("bob", ProjectRole.Editor),
                new("carol", ProjectRole.Viewer),
            ],
        },
    };

    public Task<Project?> FindAsync(Guid id, CancellationToken ct) =>
        Task.FromResult(_projects.GetValueOrDefault(id));

    public Task<IReadOnlyList<Project>> ListAsync(CancellationToken ct) =>
        Task.FromResult<IReadOnlyList<Project>>(_projects.Values.ToList());

    public Task RemoveAsync(Guid id, CancellationToken ct)
    {
        _projects.TryRemove(id, out _);
        return Task.CompletedTask;
    }
}
```

**6. `Projects.Api/Auth/ProjectAuthorization.cs`**: requirement + handler

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Projects.Api.Domain;

namespace Projects.Api.Auth;

public static class ClaimsPrincipalExtensions
{
    // "sub" = the stable user id from the identity provider. Never use the e-mail or username as a key.
    public static string? GetUserId(this ClaimsPrincipal user) => user.FindFirstValue("sub");
}

/// "The current user needs at least this role ON THIS PROJECT."
public sealed record ProjectAccessRequirement(ProjectRole MinimumRole) : IAuthorizationRequirement
{
    public static readonly ProjectAccessRequirement View = new(ProjectRole.Viewer);
    public static readonly ProjectAccessRequirement Edit = new(ProjectRole.Editor);
    public static readonly ProjectAccessRequirement Own = new(ProjectRole.Owner);
}

/// Resource-based authorization: the decision needs the project (its member list), not just the token.
public sealed class ProjectAccessHandler : AuthorizationHandler<ProjectAccessRequirement, Project>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext context, ProjectAccessRequirement requirement, Project project)
    {
        var userId = context.User.GetUserId();
        var member = project.Members.FirstOrDefault(m => m.UserId == userId);

        if (member is not null && member.Role >= requirement.MinimumRole)
            context.Succeed(requirement);

        // Not calling Succeed = "no opinion". Another handler could still succeed; if none does, it's denied.
        return Task.CompletedTask;
    }
}
```

**7. `Projects.Api/Features/ProjectEndpoints.cs`**

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http.HttpResults;
using Projects.Api.Auth;
using Projects.Api.Domain;
using Projects.Api.Infrastructure;

namespace Projects.Api.Features;

public record ProjectDto(Guid Id, string Name, int Version, string MyRole);
public record RenameRequest(string Name);

public static class ProjectEndpoints
{
    public static IEndpointRouteBuilder MapProjectEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/me", (ClaimsPrincipal user) => new
        {
            Id = user.GetUserId(),
            Name = user.Identity?.Name,
            Roles = user.FindAll("roles").Select(c => c.Value),
        });

        var projects = app.MapGroup("/api/projects").RequireAuthorization();
        projects.MapGet("/{id:guid}", GetProject);
        projects.MapPut("/{id:guid}", RenameProject);
        projects.MapDelete("/{id:guid}", DeleteProject);

        var admin = app.MapGroup("/api/admin").RequireAuthorization("admin");
        admin.MapGet("/projects", async (IProjectStore store, CancellationToken ct) =>
            (await store.ListAsync(ct)).Select(p => new { p.Id, p.Name, p.OwnerId }));

        return app;
    }

    private static ProjectDto ToDto(Project p, ClaimsPrincipal user) =>
        new(p.Id, p.Name, p.Version,
            p.Members.FirstOrDefault(m => m.UserId == user.GetUserId())?.Role.ToString() ?? "None");

    public static async Task<Results<Ok<ProjectDto>, NotFound>> GetProject(
        Guid id, ClaimsPrincipal user, IProjectStore store, IAuthorizationService auth, CancellationToken ct)
    {
        var project = await store.FindAsync(id, ct);
        if (project is null || !(await auth.AuthorizeAsync(user, project, ProjectAccessRequirement.View)).Succeeded)
            return TypedResults.NotFound(); // non-members must not learn that the project exists

        return TypedResults.Ok(ToDto(project, user));
    }

    public static async Task<Results<Ok<ProjectDto>, NotFound, ForbidHttpResult, ValidationProblem>> RenameProject(
        Guid id, RenameRequest request, ClaimsPrincipal user, IProjectStore store, IAuthorizationService auth,
        CancellationToken ct)
    {
        var project = await store.FindAsync(id, ct);
        if (project is null || !(await auth.AuthorizeAsync(user, project, ProjectAccessRequirement.View)).Succeeded)
            return TypedResults.NotFound();
        if (!(await auth.AuthorizeAsync(user, project, ProjectAccessRequirement.Edit)).Succeeded)
            return TypedResults.Forbid(); // a member, but only a viewer → 403
        if (string.IsNullOrWhiteSpace(request.Name))
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["name"] = ["Required."] });

        project.Name = request.Name.Trim();
        project.Version++;
        return TypedResults.Ok(ToDto(project, user));
    }

    public static async Task<Results<NoContent, NotFound, ForbidHttpResult>> DeleteProject(
        Guid id, ClaimsPrincipal user, IProjectStore store, IAuthorizationService auth, CancellationToken ct)
    {
        var project = await store.FindAsync(id, ct);
        if (project is null || !(await auth.AuthorizeAsync(user, project, ProjectAccessRequirement.View)).Succeeded)
            return TypedResults.NotFound();
        if (!(await auth.AuthorizeAsync(user, project, ProjectAccessRequirement.Own)).Succeeded)
            return TypedResults.Forbid();

        await store.RemoveAsync(id, ct);
        return TypedResults.NoContent();
    }
}
```

**8. Quick manual check.** Without a token, everything except `/` is 401:

```bash
dotnet run --project Projects.Api --urls http://localhost:5198
# second terminal
curl -i localhost:5198/
curl -i localhost:5198/api/projects/0197a3b0-0000-7000-8000-000000000001
```

```text
HTTP/1.1 200 OK
...
Projects API

HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
WWW-Authenticate: Bearer
```

**9. `Projects.Api.Tests/TestAuth.cs`**: a token minter and a factory that trusts it

```csharp
using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Projects.Api.Tests;

/// Mints real, signed JWTs, exactly like Keycloak would, but with a key the tests own.
public static class TestTokens
{
    public const string Issuer = "https://test-issuer.local";
    public const string Audience = "projects-api";

    public static readonly SymmetricSecurityKey Key =
        new(Encoding.UTF8.GetBytes("devquest-test-signing-key-must-be-at-least-256-bits!"));

    public static string Create(string sub, string[]? roles = null,
        DateTime? expiresUtc = null, string audience = Audience)
    {
        // Real clock on purpose: the JwtBearer handler checks `exp`/`nbf` against the real system
        // clock, not an injected TimeProvider, so test tokens must be relative to it.
        var expires = expiresUtc ?? DateTime.UtcNow.AddMinutes(5);
        var claims = new Dictionary<string, object> { ["sub"] = sub, ["preferred_username"] = sub };
        if (roles is { Length: > 0 }) claims["roles"] = roles; // JSON array → one "roles" claim each

        return new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            Audience = audience,
            Claims = claims,
            IssuedAt = expires.AddMinutes(-10),
            NotBefore = expires.AddMinutes(-10),
            Expires = expires,
            SigningCredentials = new SigningCredentials(Key, SecurityAlgorithms.HmacSha256),
        });
    }
}

/// The real app, but JWTs are validated against TestTokens.Key instead of Keycloak's JWKS.
public class AuthApiFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.Configure<JwtBearerOptions>(JwtBearerDefaults.AuthenticationScheme, o =>
            {
                o.Authority = null; // no metadata download from Keycloak
                o.TokenValidationParameters.ValidIssuer = TestTokens.Issuer;
                o.TokenValidationParameters.IssuerSigningKey = TestTokens.Key;
            });
        });
    }

    public HttpClient CreateClientWithToken(string token)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    public HttpClient CreateClientFor(string sub, params string[] roles) =>
        CreateClientWithToken(TestTokens.Create(sub, roles));
}
```

**10. `Projects.Api.Tests/ProjectAccessHandlerTests.cs`**: the handler as a pure unit

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Projects.Api.Auth;
using Projects.Api.Domain;

namespace Projects.Api.Tests;

public class ProjectAccessHandlerTests
{
    private static readonly Project Project = new()
    {
        Id = Guid.NewGuid(),
        Name = "Test",
        OwnerId = "owner",
        Members = [new("owner", ProjectRole.Owner), new("ed", ProjectRole.Editor), new("vi", ProjectRole.Viewer)],
    };

    private static async Task<bool> Evaluate(string userId, ProjectAccessRequirement requirement)
    {
        var user = new ClaimsPrincipal(new ClaimsIdentity([new Claim("sub", userId)], authenticationType: "test"));
        var context = new AuthorizationHandlerContext([requirement], user, Project);
        await new ProjectAccessHandler().HandleAsync(context);
        return context.HasSucceeded;
    }

    [Theory]
    [InlineData("vi", ProjectRole.Viewer, true)]
    [InlineData("vi", ProjectRole.Editor, false)]
    [InlineData("ed", ProjectRole.Editor, true)]
    [InlineData("ed", ProjectRole.Owner, false)]
    [InlineData("owner", ProjectRole.Viewer, true)]
    [InlineData("owner", ProjectRole.Owner, true)]
    public async Task Member_needs_at_least_the_required_role(string userId, ProjectRole required, bool expected)
    {
        Assert.Equal(expected, await Evaluate(userId, new ProjectAccessRequirement(required)));
    }

    [Fact]
    public async Task Non_member_is_never_authorized()
    {
        Assert.False(await Evaluate("stranger", ProjectAccessRequirement.View));
    }
}
```

**11. `Projects.Api.Tests/AuthApiTests.cs`**: the role matrix over HTTP

```csharp
using System.Net;
using System.Net.Http.Json;
using Projects.Api.Features;
using Projects.Api.Infrastructure;

namespace Projects.Api.Tests;

public class AuthApiTests(AuthApiFactory factory) : IClassFixture<AuthApiFactory>
{
    private static readonly string Apollo = $"/api/projects/{InMemoryProjectStore.ApolloId}";

    // ── authentication (401) ──────────────────────────────────────────────

    [Fact]
    public async Task Root_is_public()
    {
        var response = await factory.CreateClient().GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task No_token_is_401_with_a_bearer_challenge()
    {
        var response = await factory.CreateClient().GetAsync(Apollo);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("Bearer", response.Headers.WwwAuthenticate.Single().Scheme);
    }

    [Fact]
    public async Task Fallback_policy_protects_endpoints_without_explicit_authorization()
    {
        var anonymous = await factory.CreateClient().GetAsync("/api/me");
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        var me = await factory.CreateClientFor("carol").GetFromJsonAsync<Dictionary<string, object>>("/api/me");
        Assert.Equal("carol", me!["id"].ToString());
    }

    [Fact]
    public async Task Expired_token_is_401_invalid_token()
    {
        // Expired relative to the real clock the JWT handler uses (see TestTokens.Create).
        var token = TestTokens.Create("carol", expiresUtc: DateTime.UtcNow.AddHours(-1));

        var response = await factory.CreateClientWithToken(token).GetAsync(Apollo);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Contains("invalid_token", response.Headers.WwwAuthenticate.ToString());
    }

    [Fact]
    public async Task Token_for_another_api_is_401()
    {
        var token = TestTokens.Create("carol", audience: "billing-api");
        var response = await factory.CreateClientWithToken(token).GetAsync(Apollo);
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    // ── resource-based authorization (404 / 403) ──────────────────────────

    [Fact]
    public async Task Viewer_can_read()
    {
        var dto = await factory.CreateClientFor("carol").GetFromJsonAsync<ProjectDto>(Apollo);
        Assert.Equal("Viewer", dto!.MyRole);
    }

    [Fact]
    public async Task Stranger_gets_404_not_403()
    {
        var response = await factory.CreateClientFor("dave").GetAsync(Apollo);
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Viewer_cannot_rename()
    {
        var response = await factory.CreateClientFor("carol").PutAsJsonAsync(Apollo, new { name = "Hacked" });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task Editor_cannot_delete()
    {
        var response = await factory.CreateClientFor("bob").DeleteAsync(Apollo);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    // Tests that CHANGE data get their own app instance (own in-memory store).
    [Fact]
    public async Task Editor_can_rename()
    {
        await using var app = new AuthApiFactory();
        var response = await app.CreateClientFor("bob").PutAsJsonAsync(Apollo, new { name = "Apollo 2" });

        response.EnsureSuccessStatusCode();
        var dto = await response.Content.ReadFromJsonAsync<ProjectDto>();
        Assert.Equal("Apollo 2", dto!.Name);
        Assert.Equal(2, dto.Version);
    }

    [Fact]
    public async Task Owner_can_delete()
    {
        await using var app = new AuthApiFactory();
        var response = await app.CreateClientFor("alice").DeleteAsync(Apollo);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
    }

    // ── role-based policy ────────────────────────────────────────────────

    [Fact]
    public async Task Admin_policy_requires_the_admin_role()
    {
        var notAdmin = await factory.CreateClientFor("alice").GetAsync("/api/admin/projects");
        Assert.Equal(HttpStatusCode.Forbidden, notAdmin.StatusCode);

        var admin = await factory.CreateClientFor("root", "admin").GetAsync("/api/admin/projects");
        Assert.Equal(HttpStatusCode.OK, admin.StatusCode);
    }
}
```

**12. Run**

```bash
dotnet test
```

```text
Passed!  - Failed: 0, Passed: 19, Skipped: 0, Total: 19
```

**13. Break it on purpose** (then undo each change). Watch the right tests fail:

| Change | Which tests should fail? |
|---|---|
| Remove `.SetFallbackPolicy(...)` | `Fallback_policy_protects_endpoints_without_explicit_authorization` |
| In `GetProject`, return `TypedResults.Forbid()` for non-members | `Stranger_gets_404_not_403` |
| In the handler, use `>` instead of `>=` | the exact-role `Member_needs_at_least_the_required_role` rows (vi/Viewer, ed/Editor, owner/Owner), plus `Viewer_can_read`, `Viewer_cannot_rename` (now 404), `Editor_can_rename` and `Owner_can_delete`, because nobody passes the check for their own exact role any more |
| Add `options.TokenValidationParameters.ValidateAudience = false;` | `Token_for_another_api_is_401`: a token for another API now gets in |
| Delete the `options.Audience = ...` line instead | **every** test with a valid token gets 401: validation *fails closed* (`IDX10208`, no audience configured) |

:::tip title="Bonus: real Keycloak"
Run `docker run -p 8080:8080 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin quay.io/keycloak/keycloak start-dev`,
create realm `devquest`, a client `projects-api` and a user, and add the Audience and realm-role
mappers from the warning above. Fetch a token (for a quick test, enable *Direct access grants* on
a test client and POST to `/realms/devquest/protocol/openid-connect/token`), then call the API with
`Authorization: Bearer <token>`. The API code doesn't change at all.
:::

- [ ] The curl calls return 200 for `/` and 401 for the project URL
- [ ] All 19 tests pass
- [ ] I broke each line in the table, saw the expected test fail, and restored it
- [ ] I can explain why strangers get 404 but viewers get 403
:::

:::quiz id=be-13-q8 xp=15
In the lab, the `Expired_token_is_401_invalid_token` test creates a token that expired **one hour** ago.
What would happen with a token that expired **two minutes** ago?

- [ ] Also 401, because expiry is exact to the second
- [x] It would still be accepted, because `TokenValidationParameters.ClockSkew` defaults to 5 minutes
- [ ] 403, because the user is known but the token is stale
- [ ] 500, because the handler throws
> The default clock-skew tolerance covers clock drift between IdP and API, so a token is accepted until `exp + 5 min`. 403 is wrong because an expired token doesn't authenticate anyone: the user is *not* known. If you need tighter expiry (e.g. in tests or high-security APIs), set `ClockSkew = TimeSpan.Zero` or something small like 30 seconds.
:::

## Flashcards

:::cards id=be-13-cards1 xp=20 title="Auth in ASP.NET Core"
Q: 401 vs 403 vs 404 in a multi-tenant API?
A: 401 = not authenticated. 403 = authenticated but not allowed (and allowed to know the resource exists). 404 = the caller must not learn that the resource exists.
Q: What do `Authority` and `Audience` do in `AddJwtBearer`?
A: Authority = issuer; its metadata provides the JWKS signing keys and the expected `iss`. Audience = the `aud` the token must carry, so it was meant for this API.
Q: Why `MapInboundClaims = false`?
A: It keeps JWT claim names (`sub`, `roles`) instead of renaming them to legacy `ClaimTypes.*` URIs.
Q: Which OAuth flow for a React SPA? For a worker calling an API?
A: Authorization Code + PKCE (ideally behind a BFF). Client credentials for service-to-service.
Q: ID token vs access token?
A: The ID token tells the client who logged in. The access token is what the API accepts, and it must have the API's audience.
Q: What does the fallback policy do?
A: It applies to endpoints without any authorization metadata. Set it to RequireAuthenticatedUser to be secure by default.
Q: Role-based vs resource-based authorization?
A: Role-based: a global property of the user (token). Resource-based: depends on the resource (e.g. ProjectMember rows); use `IAuthorizationService.AuthorizeAsync(user, resource, requirement)`.
Q: How should local passwords be stored?
A: With a slow, salted, adaptive hash: PasswordHasher (PBKDF2), Argon2id or bcrypt. Never a fast hash or encryption.
Q: How should API keys be stored and compared?
A: Random ≥32 bytes, shown once. Store a SHA-256 hash plus a prefix. Compare with `CryptographicOperations.FixedTimeEquals`.
Q: What is refresh-token reuse detection?
A: With rotation, each refresh token works once. If a used one shows up again, revoke the whole family, because it was stolen.
Q: Keycloak token has `aud: account`. Fix?
A: Add an Audience mapper for the API's client. Never disable audience validation.
:::

## Recap

- **AuthN** builds a `ClaimsPrincipal` (401 when it fails). **AuthZ** evaluates policies against it (403), and **404** hides resources from non-members.
- APIs are OAuth **resource servers**: `AddJwtBearer` with `Authority` + `Audience`, `MapInboundClaims = false`, and the name/role claim types set explicitly.
- Cookies suit server apps and BFFs. Bearer tokens suit APIs. JWTs are signed, not encrypted, so keep secrets out of claims. Keep access tokens short-lived and use refresh-token rotation.
- Use **policies**, a **fallback policy** for secure-by-default, and route-group `RequireAuthorization()`.
- Per-project owner/editor/viewer is **resource-based authorization**: data from your DB, checked via `IAuthorizationService` and a requirement handler.
- Local passwords use PasswordHasher/Argon2id. API keys are random, hashed and compared in constant time.
- **Test every role**: owner, editor, viewer, stranger and anonymous, with real signed tokens.
- **Webhooks** are authenticated by an HMAC signature over the raw body: verify it in constant time, reject old timestamps, process idempotently. Sending them means guarding against SSRF.
- Use the **OWASP API Top 10** as a review checklist. Add HSTS and basic security headers, and share **Data Protection** keys across replicas once cookies or antiforgery are involved.
