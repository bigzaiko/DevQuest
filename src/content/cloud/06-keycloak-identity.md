---
id: cl-07
title: Identity with Keycloak (OIDC in Practice)
level: advanced
minutes: 210
xp: 100
summary: Run Keycloak 26 with its own Postgres, model realms, clients, roles and mappers as code, validate its tokens in ASP.NET Core and sign a React SPA in with code + PKCE and silent renew.
---

You have already met OpenID Connect twice: the frontend security lesson showed the browser side (code + PKCE,
where tokens live), and the backend auth lesson showed `AddJwtBearer`, claims and policies. Both pointed at
"some identity provider" and waved their hands. This lesson is about the **identity provider itself**:
running **Keycloak 26**, configuring it the way real teams do (as code, in Git), and wiring a .NET API and a
React SPA to it, including the failures you'll actually hit.

## Why an identity provider at all?

Every app starts with "just a users table with a password hash". Then the requests arrive:

- "Can we log in with Google / our company Microsoft account?"
- "Security wants MFA, and now passkeys."
- "The new admin tool and the mobile app need the same login."
- "A customer wants SSO with *their* Entra ID tenant."
- "Lock the account after 10 failed attempts, but don't let attackers lock out the CEO."
- "Password reset emails, email verification, session list, 'log out everywhere'..."

Each of these is a project, and each one is security-critical. An **identity provider (IdP)** does all of
them once, for every app you own. Your apps stop handling credentials and only **validate tokens**.

```text
             ┌─────────────────────────────── Keycloak (realm "devquest") ─────────────────────┐
             │  login pages · MFA · passkeys · password policy · brute-force detection          │
             │  users · groups · roles · sessions · Google/Microsoft brokering · audit events   │
             └───────▲───────────────────────────────▲────────────────────────────▲───────────┘
                     │ OIDC                          │ OIDC                       │ JWKS (public keys)
             React SPA (public client)     Admin tool (confidential)     Projects API (resource server)
```

**Keycloak** is an open-source IdP (started at Red Hat, now a CNCF incubating project): a Java/Quarkus
server that keeps its state in a relational database. Alternatives you'll meet: **Microsoft Entra ID** (most .NET shops),
**Auth0/Okta** (SaaS), **Zitadel**, **Authentik**, **Duende IdentityServer** (a .NET library you host). The
protocols are identical, so 90% of this lesson transfers.

:::info title="Self-hosted vs SaaS"
Keycloak costs no licence fee, but **you** run a security-critical, stateful service: upgrades, backups,
monitoring, HA. Teams choose it when they need data residency, deep customisation, many realms (multi-tenant
B2B) or no per-user pricing. Teams with a small ops budget often pick Entra ID or Auth0 instead.
:::

## OIDC and OAuth 2.0 in five minutes

**OAuth 2.0** is about *delegated authorization*: "this app may call that API on my behalf". It hands out
**access tokens**. **OpenID Connect (OIDC)** is a thin layer on top that adds *authentication*: "this is who
signed in". It adds the **ID token**, the `openid` scope, a `userinfo` endpoint and a **discovery document**.

### Authorization Code + PKCE, the only browser flow you need

```text
 SPA (localhost:5173)                Keycloak (localhost:8080)                    API (localhost:5080)
  │ 1. verifier = random(32 bytes); challenge = BASE64URL(SHA256(verifier))        │
  │ 2. redirect → /realms/devquest/protocol/openid-connect/auth                    │
  │      ?response_type=code&client_id=devquest-spa&redirect_uri=…                 │
  │      &scope=openid profile email&state=…&code_challenge=…&code_challenge_method=S256
  │                                    │ 3. login page, MFA / passkey              │
  │ ◄──── 4. 302 → http://localhost:5173/?code=…&state=…                           │
  │ 5. POST /token (code + verifier) ─►│ checks SHA256(verifier) == challenge      │
  │ ◄──── 6. { access_token, id_token, refresh_token, expires_in }                 │
  │ 7. GET /api/projects  Authorization: Bearer <access_token> ──────────────────► │
  │                                    │ ◄── 8. (once, cached) discovery + JWKS    │
  │ ◄──────────────────────────────────────────────── 9. 200 / 401 / 403 ───────── │
```

PKCE (*proof key for code exchange*) makes a stolen `code` useless: redeeming it needs the verifier, which
never left the SPA. The OAuth 2.0 Security Best Current Practice (RFC 9700) requires PKCE for public clients
and recommends it for all clients, and the OAuth 2.1 draft makes it the default for everyone. Keycloak can
enforce it per client (`pkce.code.challenge.method: S256`, used in the lab).

### Three tokens, three audiences

| Token | Format in Keycloak | Who reads it | Purpose | Typical lifetime |
|---|---|---|---|---|
| **ID token** | JWT, `"typ": "ID"` | the **client** (SPA) | who signed in, when, how (`auth_time`, `acr`) | minutes |
| **Access token** | JWT, `"typ": "Bearer"` | the **API** | what the bearer may do (`scope`, roles, `aud`) | 1–15 min |
| **Refresh token** | JWT-shaped but **opaque to you**, `"typ": "Refresh"` | only **Keycloak** | get new access tokens without a login page | tied to the SSO session (e.g. 30 min idle, 10 h max) |

Key words in a token:

- **`iss`** (issuer): the realm URL, e.g. `http://localhost:8080/realms/devquest`. Must match **exactly**.
- **`aud`** (audience): who the token is *for*. An API must reject tokens not addressed to it.
- **`azp`** (authorized party): the client that requested the token (`devquest-spa`).
- **`sub`**: the stable user id (a UUID in Keycloak). Key your users table on `iss` + `sub`, **never on email**.
- **`scope`**: what the client asked for and got (`openid profile email`).
- **`exp` / `iat` / `nbf`**: expiry, issued-at, not-before (Unix seconds). Keycloak doesn't set `nbf`
  by default; other IdPs (Entra) do.

:::warn title="Real incidents: identity keyed on the wrong claim"
In 2023 researchers disclosed **"nOAuth"**: apps signing users in with Microsoft Entra multi-tenant apps
used the `email` claim as the user key. Email is mutable and, there, wasn't guaranteed to be verified, so an
attacker could set a victim's email on their own tenant's account and walk into the victim's account. The
same year, in **Storm-0558**, a stolen Microsoft consumer signing key could forge tokens that some services
accepted for enterprise accounts, because of a gap in the key and issuer check. Lessons: key on `iss` + `sub`;
validate issuer, audience *and* signing key; use a maintained library instead of hand-written checks.
:::

:::quiz id=cl-07-q1 xp=10
Your SPA has both an `id_token` and an `access_token` from Keycloak. Which one goes in
`Authorization: Bearer …` to your Projects API, and why?
- [ ] The ID token, because it contains the user's name and email, which the API needs
- [x] The access token, because it is the one whose `aud` names the API, and APIs must reject tokens not meant for them
- [ ] Either one: both are signed by the same realm key, so the API can verify either
- [ ] The refresh token, because it lives longest and saves round trips
> The ID token is addressed to the *client* (`aud: "devquest-spa"`) and proves a login happened to that
> client. The access token is meant for resource servers, and with an Audience mapper its `aud` contains
> `projects-api`. "Same signing key" is the tempting trap: the signature only proves *who issued* a token,
> not *who it is for*. That is the audience check's job. Refresh tokens are only ever sent to Keycloak.
:::

## Keycloak's mental model

```text
Keycloak server
├── realm "master"                 ← only for Keycloak admins. Never put app users here.
└── realm "devquest"               ← one tenant: its own users, keys, login theme, settings
    ├── clients                    ← apps that request tokens (or receive them)
    │   ├── devquest-spa           public, standard flow + PKCE
    │   ├── admin-portal           confidential (has a secret), server-side app / BFF
    │   └── projects-api           resource server: owns client roles, used as an audience
    ├── client scopes              ← reusable bundles of mappers: profile, email, roles, basic, …
    │   └── mappers                ← "put this data into the token like this"
    ├── roles
    │   ├── realm roles            admin, support           → token: realm_access.roles
    │   └── client roles           projects-api: projects-reader, projects-writer
    │                                                       → token: resource_access["projects-api"].roles
    ├── groups                     /editors → grants projects-writer. Users inherit group roles.
    ├── users                      alice, bob (credentials, attributes, required actions)
    ├── identity providers         Google, Microsoft, a customer's Entra ID (brokering)
    └── authentication flows       browser flow: username/password → OTP or passkey …
```

### Realms

A **realm** is an isolated tenant: its own users, signing keys, sessions and login pages. A token from realm A
is never valid in realm B because the issuer and keys differ. Common setups: one realm per environment
(`devquest` in dev, staging and prod run on *separate* Keycloak instances), or for B2B SaaS one realm per
large customer. Keycloak 26 also has **Organizations** (multiple customer orgs inside one realm, each with
their own IdP and domain), which is often a better fit than hundreds of realms.

### Clients: public vs confidential

| | Public client | Confidential client |
|---|---|---|
| Examples | React SPA, mobile app, CLI | ASP.NET Core BFF, server-rendered app, background worker |
| Can it keep a secret? | No: anything shipped to a browser is public | Yes: secret or private key lives on a server |
| Flows | Authorization code **+ PKCE** | Code (+ PKCE), **client credentials** (service accounts) |
| Keycloak setting | *Client authentication* **off** | *Client authentication* **on** |

A `VITE_CLIENT_SECRET` is not a secret. Vite inlines it into the bundle, and anyone can read it in DevTools.
SPAs are public clients, full stop.

The API is also registered as a client (`projects-api`), although it never requests a token for a user. It
exists so it can **own client roles** and be named as an **audience**.

### Client scopes and mappers

A **mapper** decides what goes into a token: a user attribute, a role list, a hard-coded claim, an
audience. Mappers live in **client scopes** (reusable) or in a client's *dedicated* scope (just that client).

- **Default** client scopes are always added to a client's tokens (`profile`, `email`, `roles`,
  `web-origins`, `acr`, `basic`).
- **Optional** client scopes are only added when the client asks: `scope=openid offline_access`.

The built-in `roles` scope writes `realm_access.roles` and `resource_access.<client>.roles`. It also has an
*audience resolve* mapper that adds every client whose roles the user holds to `aud`, which is why you
often see `"aud": "account"`. **Don't rely on that side effect.** Add an explicit **Audience** mapper that
puts `projects-api` into tokens meant for it.

### Roles and groups

- **Realm roles** are global to the realm (`admin`, `support`).
- **Client roles** are namespaced to one client (`projects-api` → `projects-writer`). Prefer them for app
  permissions: two APIs can both have a `writer` role without colliding.
- **Composite roles** contain other roles. Keycloak expands them *before* writing the token, so the token
  already lists the effective roles.
- **Groups** (hierarchical: `/acme/editors`) carry roles. Assign people to groups, not roles to people,
  and onboarding and offboarding become a single click.
- Every realm has `default-roles-<realm>` (usually containing `offline_access` and `uma_authorization`),
  so those show up in `realm_access.roles` too. Ignore roles you don't map.

### Identity brokering and passkeys

**Brokering** means Keycloak acts as an OIDC/SAML *client* to another IdP (Google, Microsoft, GitHub, a
customer's Entra ID) while your apps keep talking only to Keycloak. Your apps don't change when you add
"Sign in with Google". On the first login Keycloak runs the **first broker login** flow: create a local
user, or link to an existing one.

:::warn title="Account linking by email is an account-takeover vector"
If you auto-link a brokered login to an existing local user **by email**, then any IdP that lets users set
an unverified email can take over accounts. Only enable *Trust email* for IdPs that really verify email
(Google, a known corporate tenant), and keep Keycloak's default of asking the user to re-authenticate
before linking. Same root cause as nOAuth.
:::

**Passkeys (WebAuthn)**: Keycloak has supported WebAuthn as a second factor and *WebAuthn passwordless* for
years, configured as an authentication flow plus a WebAuthn policy. Recent 26.x releases integrated passkeys
more directly into the username/password login form (autofill / conditional UI).

:::warn title="Check the passkey details for your exact 26.x version"
How passkeys are switched on (a realm option, a flow step, a feature flag) changed between 26.x minor
releases. Before you write a runbook, read the *Passkeys* / *WebAuthn* sections of the Keycloak Server
Administration Guide and the release notes for your exact version. Don't copy settings from a blog post
written against a different minor.
:::

:::quiz id=cl-07-q2 xp=10
A teammate registers the React SPA as a **confidential** client and puts the client secret in
`VITE_KEYCLOAK_SECRET` "so the token endpoint is protected". What's the problem?
- [ ] Nothing: Vite env vars are encrypted at build time
- [ ] Confidential clients can't use the authorization code flow
- [x] Vite inlines `VITE_*` values into the JavaScript bundle, so the "secret" is public; an SPA must be a public client using PKCE
- [ ] Keycloak rejects secrets longer than 32 characters from browsers
> Anything that reaches the browser is readable in DevTools, so a secret there protects nothing and creates a
> false sense of security. A public client + PKCE is the correct model, and a BFF is the option if you
> want a real confidential client. The tempting first answer is wrong: `VITE_` means "expose this to client
> code", the opposite of secret.
:::

## Running Keycloak 26

### Dev mode vs production mode

| | `kc.sh start-dev` | `kc.sh start` (production) |
|---|---|---|
| Database | embedded H2 file unless you set `KC_DB` | you must configure a real DB (`KC_DB=postgres`) |
| HTTP | plain HTTP allowed | HTTPS required unless `KC_HTTP_ENABLED=true` (TLS at the proxy) |
| Hostname | inferred from the request | **must** be configured (`KC_HOSTNAME`), or startup fails (unless you opt out with `KC_HOSTNAME_STRICT=false`, which you shouldn't) |
| Caches / themes | theme caching off, local caches | clustered caches (Infinispan), themes cached |
| Startup | auto-builds on every start | best: `kc.sh build` once in the image, then `start --optimized` |

Keycloak 26 options can be set as CLI flags (`--hostname=…`), env vars (`KC_HOSTNAME=…`) or in
`conf/keycloak.conf`. Some are **build-time** options (`KC_DB`, `KC_HEALTH_ENABLED`, `KC_METRICS_ENABLED`,
`KC_FEATURES`): changing them requires a re-build, which plain `start` does on boot (slowly) and
`--optimized` refuses to do.

The admin bootstrap user comes from `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` (Keycloak
26 renamed the old `KEYCLOAK_ADMIN*` variables). It creates a *temporary* admin in `master` on the first start
only. Replace it with a real admin account (or a service account) right away.

### Hostname: the setting behind half of all issuer bugs

Keycloak writes its own URL into every token (`iss`) and the discovery document. With **hostname v2**
(Keycloak 25+), `KC_HOSTNAME` can be a full URL:

```bash
KC_HOSTNAME=https://auth.devquest.example     # what browsers and tokens will see
KC_HOSTNAME_ADMIN=https://kc-admin.internal   # optional: admin console on a separate, private URL
KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true          # optional: back-channel URLs follow the request's host
```

Now picture Docker Compose. The browser reaches Keycloak at `http://localhost:8080`; the API **container**
reaches it at `http://keycloak:8080`. If the hostname isn't fixed, a token the browser obtained says
`iss: http://localhost:8080/realms/devquest` while the API, fetching discovery from `keycloak:8080`, expects
`http://keycloak:8080/realms/devquest`. Result: `IDX10205: Issuer validation failed`. Fixes, in order of
preference:

1. Fix `KC_HOSTNAME` to the **public** URL, so `iss` never depends on who asks.
2. In the API, keep `Authority` as the public URL, but fetch metadata over the internal network:
   `options.MetadataAddress = "http://keycloak:8080/realms/devquest/.well-known/openid-configuration"`.
   Then the `jwks_uri` *inside* that document must also be reachable from the container, which is what
   `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` is for.
3. In local dev, sidestep it: run the API on the host (what the lab does), or give both sides the same name
   (an `/etc/hosts` entry like `127.0.0.1 keycloak`).

**Why fix 1 works.** It helps to know how JwtBearer decides which issuer it expects: it downloads the
discovery document (from `MetadataAddress`, or `{Authority}/.well-known/openid-configuration` if that's unset)
and adds that document's **`issuer` value** to the valid issuers. So the expected issuer is whatever Keycloak
*advertises*, not the string you typed as `Authority`. With a fixed `KC_HOSTNAME`, Keycloak advertises the
public URL no matter which address the API used to fetch the document, and the token's `iss` matches. Without
a fixed hostname, dev mode builds both from the request's host, so the browser's token and the API's discovery
document disagree.

:::warn title="Back-channel vs front-channel URLs"
Which endpoints count as "back-channel" (token, JWKS, introspection, userinfo...) and how
`KC_HOSTNAME_BACKCHANNEL_DYNAMIC` resolves them is precisely defined in the Keycloak *Configuring the
hostname (v2)* guide. Verify your discovery document with
`curl http://keycloak:8080/realms/devquest/.well-known/openid-configuration` from **inside** the API
container rather than trusting memory (including this lesson's).
:::

### Behind a reverse proxy

In production, TLS ends at an ingress / Traefik / nginx, and Keycloak speaks HTTP inside:

```yaml
# production-shaped (not the lab): Keycloak behind a TLS-terminating proxy
keycloak:
  image: registry.example.com/keycloak:26.8.2-optimized   # built with kc.sh build, see Dockerfile below
  command: ["start", "--optimized"]
  environment:
    KC_HOSTNAME: https://auth.devquest.example
    KC_HTTP_ENABLED: "true"            # proxy → Keycloak is plain HTTP on a private network
    KC_PROXY_HEADERS: xforwarded       # trust X-Forwarded-For/-Proto/-Host (or "forwarded" for RFC 7239)
    KC_DB_URL: jdbc:postgresql://kc-db:5432/keycloak
    KC_DB_USERNAME: keycloak
    KC_DB_PASSWORD: ${KC_DB_PASSWORD:?set KC_DB_PASSWORD}   # injected by CI / secret store, never committed
```

```dockerfile
# Dockerfile: bake build-time options into the image (pattern from Keycloak's container guide)
FROM quay.io/keycloak/keycloak:26.8.2 AS builder
ENV KC_DB=postgres
ENV KC_HEALTH_ENABLED=true
ENV KC_METRICS_ENABLED=true
WORKDIR /opt/keycloak
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.8.2
COPY --from=builder /opt/keycloak/ /opt/keycloak/
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
```

:::warn title="Secrets and exposed paths: check the guides for your version"
`${KC_DB_PASSWORD:?…}` is Compose variable interpolation: Compose fills it from the shell or an untracked
`.env` file, and refuses to start if it's unset. Don't assume Keycloak reads `*_FILE` env vars the way the
Postgres image does. That's a convention of some images, not a Keycloak feature you can count on. In
Kubernetes the usual way is an env var from a `Secret` (or the Keycloak Operator's `db.passwordSecret`). The
*Configuring Keycloak* guide lists the supported mechanisms (env vars, `keycloak.conf`, a Java keystore config
source). The *Configuring a reverse proxy* guide lists which URL paths to expose publicly (`/realms/`,
`/resources/`) and which to keep private (`/admin/`, the management port 9000).
:::

Two more production facts:

- **Its own Postgres.** Keycloak owns its schema and migrates it on upgrade. Give it a dedicated database
  (or at least a dedicated DB + user), back it up like any production DB, and don't let apps query its
  tables. Use the Admin REST API or events instead.
- **Health and metrics** run on the **management port 9000** (`/health/ready`, `/health/live`, `/metrics`)
  when enabled, separate from the public 8080/8443. Point Kubernetes probes and Prometheus there.

:::quiz id=cl-07-q3 xp=15
Keycloak runs behind an ingress that terminates TLS for `https://auth.devquest.example`. Logins work, but
the discovery document advertises `http://auth.devquest.example/...` endpoints and the SPA gets
mixed-content errors. What is the most likely fix?
- [ ] Set `KC_HTTP_ENABLED=false` so Keycloak only speaks HTTPS
- [x] Set `KC_PROXY_HEADERS=xforwarded` (make sure the proxy sends `X-Forwarded-Proto: https`) and/or set `KC_HOSTNAME` to the full `https://` URL
- [ ] Turn off `RequireHttpsMetadata` in the API
- [ ] Change the realm's *Require SSL* to `none`
> Keycloak only sees the plain-HTTP hop from the proxy. Unless it trusts the forwarded headers (or has a fixed
> full-URL hostname), it builds URLs with `http://`. Disabling HTTP inside would break the proxy → Keycloak
> hop, and the other two options weaken security without fixing how Keycloak builds its URLs.
:::

## Realms as code

Clicking a realm together in the admin console works until you need the same realm in dev, CI, staging and
prod. Then the environments drift. Teams treat realm configuration like a database migration:

| Approach | How | Good for |
|---|---|---|
| **Realm import on start** | mount JSON into `/opt/keycloak/data/import`, start with `--import-realm` | dev & CI: fresh realm on every `docker compose up` |
| **CLI export** | `kc.sh export --dir /tmp/export --realm devquest --users realm_file` | snapshotting a realm you clicked together |
| **Admin console partial export** | Realm settings → Action → *Partial export* | quick copy without secrets/users |
| **keycloak-config-cli** (adorsys) | idempotent apply of JSON/YAML via the Admin API | staging/prod continuous config |
| **Terraform provider** for Keycloak | `keycloak_realm`, `keycloak_openid_client`, … resources | infra teams already on Terraform |

`--import-realm` **skips realms that already exist**. It doesn't update them. In dev, that means
"`docker compose down -v` to re-import"; in prod, it means you want one of the declarative tools.

:::warn title="Export while running"
Whether `kc.sh export` can safely run *inside* a running server's container (it boots a second Keycloak
instance against the same database) has varied between versions, and with the dev H2 database it can't.
The *Importing and exporting realms* guide for your version is the source of truth. The safe habit is
to export from a stopped instance, or a throwaway container pointed at a copy of the DB.
:::

:::pro title="What a mature team's realm repo looks like"
- `realm/devquest-realm.json` (or keycloak-config-cli YAML) reviewed in PRs like code. No users or secrets in
  it for prod. Secrets come from the secret store, users from brokering or the Admin API.
- Token lifetimes set deliberately: access token 5 min, SSO idle 30 min, SSO max 10 h; refresh-token
  rotation (*Revoke Refresh Token*, a realm-level setting under *Realm settings → Tokens*) switched on.
- Separate admin hostname on a private network. The `master` realm has 2–3 humans with MFA, everything
  else is a service account.
- Keycloak upgrades on a schedule (it ships often), tested against a copy of the prod DB, because the
  schema migrates on start.
- Login and admin events shipped to the log stack (see *Observability: OpenTelemetry, Prometheus, Grafana,
  Loki*): failed logins per IP is your brute-force dashboard.
:::

## Validating Keycloak tokens in ASP.NET Core

The backend auth lesson covered `AddJwtBearer` in general. Here's the Keycloak-specific version:

```csharp
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "http://localhost:8080/realms/devquest";   // discovery base; expected `iss` = its `issuer`
        options.Audience = "projects-api";                             // = required `aud`
        options.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
        options.MapInboundClaims = false;            // keep "sub", "roles", … instead of long SOAP-era URIs
        options.TokenValidationParameters.NameClaimType = "preferred_username";
        options.TokenValidationParameters.RoleClaimType = "roles";
        options.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);   // default is 5 minutes!
        options.Events = new JwtBearerEvents
        {
            OnTokenValidated = ctx =>
            {
                if (ctx.Principal?.Identity is ClaimsIdentity identity)
                    KeycloakRoles.Flatten(identity, clientId: "projects-api");
                return Task.CompletedTask;
            },
        };
    });
```

What the handler does on each request: read the bearer token → check the signature against the realm's JWKS
(downloaded once from discovery, cached, refreshed when an unknown `kid` shows up after key rotation) →
check `iss`, `aud`, `exp`/`nbf` with the skew → build a `ClaimsPrincipal` → raise `OnTokenValidated`.

### Mapping `realm_access` / `resource_access` to roles

Keycloak nests roles in JSON objects. ASP.NET Core's `IsInRole` / `RequireRole` look for **flat** claims of the
`RoleClaimType`. With `MapInboundClaims = false`, the JSON handler gives you `realm_access` as one claim
whose value is the raw JSON `{"roles":["admin",…]}`, so you flatten it yourself:

```csharp
static class KeycloakRoles
{
    public static void Flatten(ClaimsIdentity identity, string clientId)
    {
        var roles = new HashSet<string>();
        if (identity.FindFirst("realm_access")?.Value is { } realm)
            roles.UnionWith(ReadRoles(realm));
        if (identity.FindFirst("resource_access")?.Value is { } resource)
        {
            using var doc = JsonDocument.Parse(resource);
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty(clientId, out var client))   // ONLY this API's client roles
                roles.UnionWith(ReadRoles(client.GetRawText()));
        }
        foreach (var role in roles)
            if (!identity.HasClaim("roles", role))
                identity.AddClaim(new Claim("roles", role));
    }

    static List<string> ReadRoles(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object ||
            !doc.RootElement.TryGetProperty("roles", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return [];
        return arr.EnumerateArray()
            .Where(e => e.ValueKind == JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToList();
    }
}
```

Alternatives: add a **User Realm Role** / **User Client Role** mapper in Keycloak with *Token Claim Name*
`roles` and *Multivalued* on, so the token already has a flat `roles` array (the token becomes
Keycloak-specific either way), or use an `IClaimsTransformation` (runs on *every* authentication, so it must
be idempotent; `OnTokenValidated` runs once per validated token).

:::warn title="Flattening merges namespaces"
The code above puts realm roles and `projects-api` client roles into one `roles` claim. If a realm role and
a client role share a name, they become indistinguishable. Pick one convention per team: app permissions
only as client roles, or prefix when flattening (`realm:admin`). The challenge below keeps them apart.
:::

### From roles to permissions with policies

Hard-coding role names into endpoints (`RequireRole("projects-writer")`) couples your code to how the IdP
admin named things. Name **policies after permissions** and map roles to them in one place:

```csharp
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("projects:read",   p => p.RequireRole("projects-reader", "projects-writer", "admin"))
    .AddPolicy("projects:write",  p => p.RequireRole("projects-writer", "admin"))
    .AddPolicy("projects:delete", p => p.RequireRole("admin"));

app.MapGet("/api/projects", ListProjects).RequireAuthorization("projects:read");
app.MapPost("/api/projects", CreateProject).RequireAuthorization("projects:write");
```

Roles answer *what kind of user is this?*; permissions answer *may they do this?*. Resource-level checks
("is alice a member of project 42?") belong in your app's database, not in Keycloak. Keycloak's
*Authorization Services* (UMA, policies in the IdP) exist, but most teams find them heavyweight and keep
fine-grained rules in the app.

:::quiz id=cl-07-q4 xp=15
Alice's access token contains `"realm_access": { "roles": ["admin"] }`, the API has
`MapInboundClaims = false` and `RoleClaimType = "roles"`, and nothing else. `RequireRole("admin")` returns
**403**. Why?
- [ ] The token signature is invalid
- [ ] `RequireRole` only works with cookie authentication
- [x] There is no flat claim of type `roles` with value `admin`. The role sits inside the `realm_access` JSON claim until you flatten it (or add a Keycloak role mapper named `roles`)
- [ ] Realm roles are never included in access tokens, only in ID tokens
> 403 (not 401) tells you authentication **succeeded**: the token was valid and the user was identified. The
> authorization step found no matching role claim because ASP.NET Core doesn't understand Keycloak's
> nested shape. An invalid signature would give 401. Realm roles *are* in access tokens, via the `roles` client scope.
:::

:::challenge id=cl-07-c1 lang=ts xp=50
title: Validate a JWT's claims with a fake clock
APIs validate tokens with a library, but you should know exactly what it checks. Implement (no signature
check here, the *claims* are the point):

- `decodePayload(token)`: split on `.`; there must be exactly 3 parts. Base64url-decode the middle part
  (`-` → `+`, `_` → `/`, pad with `=`), decode bytes as **UTF-8**, `JSON.parse`. The result must be a plain
  object (not `null`, not an array, not a string). Any failure → `throw new Error('malformed')`.
- `validateClaims(token, { issuer, audience, now, clockSkewSeconds = 0 })`, where `now()` returns **Unix
  seconds** (inject the clock; never call `Date.now()`). Check **in this order** and return the first failure:
  1. undecodable → `{ ok: false, error: 'malformed' }`
  2. `iss !== issuer` (exact string, no trailing-slash forgiveness) → `'issuer'`
  3. `aud` is a string equal to `audience`, or an array containing it; otherwise → `'audience'`
  4. `exp` missing / not a number, or `now() >= exp + skew` → `'expired'`
  5. `nbf` present and either not a number or `now() + skew < nbf` → `'not_yet_valid'`
  6. otherwise `{ ok: true, claims }` with the decoded payload

  `validateClaims` must never throw. A malformed token is a *result*, not an exception.

hint: Wrap the whole decode in `try { … } catch { throw new Error('malformed') }`: `atob` throws on bad input, so does `JSON.parse`.
hint: `Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))` then `new TextDecoder().decode(bytes)`.
hint: Audience: `Array.isArray(aud) ? aud.includes(audience) : aud === audience`.

```ts starter
type Claims = Record<string, unknown>
type Result = { ok: true; claims: Claims } | { ok: false; error: 'malformed' | 'issuer' | 'audience' | 'expired' | 'not_yet_valid' }

export function decodePayload(token: string): Claims {
  return JSON.parse(atob(token.split('.')[1]))
}

export function validateClaims(
  token: string,
  opts: { issuer: string; audience: string; now: () => number; clockSkewSeconds?: number },
): Result {
  const claims = decodePayload(token)
  if (claims.iss !== opts.issuer) return { ok: false, error: 'issuer' }
  return { ok: true, claims }
}
```

```ts solution
type Claims = Record<string, unknown>
type Result = { ok: true; claims: Claims } | { ok: false; error: 'malformed' | 'issuer' | 'audience' | 'expired' | 'not_yet_valid' }

export function decodePayload(token: string): Claims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed')
  let value: unknown
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('malformed')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('malformed')
  return value as Claims
}

export function validateClaims(
  token: string,
  opts: { issuer: string; audience: string; now: () => number; clockSkewSeconds?: number },
): Result {
  let claims: Claims
  try {
    claims = decodePayload(token)
  } catch {
    return { ok: false, error: 'malformed' }
  }
  const skew = opts.clockSkewSeconds ?? 0
  if (claims.iss !== opts.issuer) return { ok: false, error: 'issuer' }
  const aud = claims.aud
  const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience
  if (!audOk) return { ok: false, error: 'audience' }
  const now = opts.now()
  if (typeof claims.exp !== 'number' || now >= claims.exp + skew) return { ok: false, error: 'expired' }
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || now + skew < claims.nbf)) {
    return { ok: false, error: 'not_yet_valid' }
  }
  return { ok: true, claims }
}
```

```ts tests
const FIXTURE_ISS = 'http://localhost:8080/realms/devquest'
function fixtureEncode(text: string) {
  let bin = ''
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fixtureJwt(payload: unknown) {
  return `${fixtureEncode('{"alg":"RS256","typ":"JWT","kid":"k1"}')}.${fixtureEncode(JSON.stringify(payload))}.not-a-real-signature`
}
const fixtureClaims = { iss: FIXTURE_ISS, aud: ['projects-api', 'account'], azp: 'devquest-spa', exp: 1000, iat: 700, preferred_username: 'zoë' }
const at = (t: number, extra: object = {}) => ({ issuer: FIXTURE_ISS, audience: 'projects-api', now: () => t, ...extra })

test('decodePayload handles base64url and UTF-8', () => {
  expect(decodePayload(fixtureJwt({ name: 'Zoë Łukasz 中', q: '>>>???' }))).toEqual({ name: 'Zoë Łukasz 中', q: '>>>???' })
})
test('decodePayload rejects garbage', () => {
  expect(() => decodePayload('abc.def')).toThrow('malformed')
  expect(() => decodePayload('a.!!!.c')).toThrow('malformed')
  expect(() => decodePayload(`x.${fixtureEncode('not json')}.y`)).toThrow('malformed')
  expect(() => decodePayload(fixtureJwt('just a string'))).toThrow('malformed')
  expect(() => decodePayload(fixtureJwt(null))).toThrow('malformed')
  expect(() => decodePayload(fixtureJwt([1, 2]))).toThrow('malformed')
})
test('a valid token passes and returns its claims', () => {
  expect(validateClaims(fixtureJwt(fixtureClaims), at(900))).toEqual({ ok: true, claims: fixtureClaims })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, aud: 'projects-api' }), at(900)).ok).toBe(true)
})
test('malformed tokens are reported, not thrown', () => {
  expect(validateClaims('nope', at(0))).toEqual({ ok: false, error: 'malformed' })
})
test('issuer must match exactly', () => {
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, iss: FIXTURE_ISS + '/' }), at(900))).toEqual({ ok: false, error: 'issuer' })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, iss: 'http://keycloak:8080/realms/devquest' }), at(900))).toEqual({ ok: false, error: 'issuer' })
})
test('audience: account-only tokens and ID tokens are rejected', () => {
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, aud: 'account' }), at(900))).toEqual({ ok: false, error: 'audience' })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, aud: ['account'] }), at(900))).toEqual({ ok: false, error: 'audience' })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, aud: 'devquest-spa', typ: 'ID' }), at(900))).toEqual({ ok: false, error: 'audience' })
  const { aud, ...noAud } = fixtureClaims
  expect(validateClaims(fixtureJwt(noAud), at(900))).toEqual({ ok: false, error: 'audience' })
})
test('expiry uses the injected clock and the skew', () => {
  const t = fixtureJwt(fixtureClaims)
  expect(validateClaims(t, at(999)).ok).toBe(true)
  expect(validateClaims(t, at(1000))).toEqual({ ok: false, error: 'expired' })
  expect(validateClaims(t, at(1029, { clockSkewSeconds: 30 })).ok).toBe(true)
  expect(validateClaims(t, at(1030, { clockSkewSeconds: 30 }))).toEqual({ ok: false, error: 'expired' })
  const now = fn(() => 900)
  validateClaims(t, { issuer: FIXTURE_ISS, audience: 'projects-api', now })
  expect(now).toHaveBeenCalled()
})
test('missing or non-numeric exp means expired', () => {
  const { exp, ...noExp } = fixtureClaims
  expect(validateClaims(fixtureJwt(noExp), at(0))).toEqual({ ok: false, error: 'expired' })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, exp: '1000' }), at(0))).toEqual({ ok: false, error: 'expired' })
})
test('nbf with and without skew', () => {
  const t = fixtureJwt({ ...fixtureClaims, nbf: 800 })
  expect(validateClaims(t, at(799))).toEqual({ ok: false, error: 'not_yet_valid' })
  expect(validateClaims(t, at(800)).ok).toBe(true)
  expect(validateClaims(t, at(770, { clockSkewSeconds: 30 })).ok).toBe(true)
  expect(validateClaims(t, at(769, { clockSkewSeconds: 30 }))).toEqual({ ok: false, error: 'not_yet_valid' })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, nbf: '800' }), at(900))).toEqual({ ok: false, error: 'not_yet_valid' })
})
test('checks run in the documented order', () => {
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, iss: 'x', aud: 'y', exp: 1 }), at(900)).ok).toBe(false)
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, iss: 'x', aud: 'y', exp: 1 }), at(900))).toEqual({ ok: false, error: 'issuer' })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, aud: 'y', exp: 1 }), at(900))).toEqual({ ok: false, error: 'audience' })
  expect(validateClaims(fixtureJwt({ ...fixtureClaims, exp: 1, nbf: 5000 }), at(900))).toEqual({ ok: false, error: 'expired' })
})
```
:::

:::challenge id=cl-07-c2 lang=ts xp=50
title: Map Keycloak roles to app permissions
Your app keeps a mapping from Keycloak roles to fine-grained permissions:

```ts
const mapping = {
  realm:  { admin: ['projects:*', 'users:manage'] },
  client: { 'projects-reader': ['projects:read'], 'projects-writer': ['projects:read', 'projects:write'] },
}
```

Implement:

- `permissionsFor(claims, clientId, mapping)`: realm roles come **only** from `claims.realm_access.roles` and
  are looked up in `mapping.realm`; client roles come **only** from `claims.resource_access[clientId].roles`
  and are looked up in `mapping.client`. Roles of *other* clients must grant nothing, and a realm role never
  matches a client mapping (or vice versa). Ignore unknown roles (including names such as `constructor` or
  `toString` that exist on `Object.prototype`), non-string roles and malformed shapes (missing or `null`
  objects, `roles` that isn't an array, a mapping without `realm` or `client`). Return the permissions
  **unique and sorted** (`Array.prototype.sort()` order), with wildcard entries such as `projects:*` included
  as-is.
- `can(claims, clientId, mapping, permission)`: `true` if the permission is granted exactly, or by a
  wildcard `prefix:*` (`projects:*` grants `projects:delete`, but not `projectsX:read`).

hint: Look up with `Object.hasOwn(mapping.realm ?? {}, role)`. A role called `constructor` must not find `Object.prototype.constructor`.
hint: `const list = (x: unknown) => Array.isArray(x) ? x.filter((r): r is string => typeof r === 'string') : []`.
hint: Wildcard: `p.endsWith(':*') && permission.startsWith(p.slice(0, -1))`.

```ts starter
type RoleMapping = { realm?: Record<string, string[]>; client?: Record<string, string[]> }

export function permissionsFor(claims: Record<string, any>, clientId: string, mapping: RoleMapping): string[] {
  const roles: string[] = [...(claims.realm_access?.roles ?? [])]
  for (const c of Object.values(claims.resource_access ?? {})) roles.push(...((c as any).roles ?? []))
  const out: string[] = []
  for (const r of roles) out.push(...(mapping.realm?.[r] ?? mapping.client?.[r] ?? []))
  return out
}

export function can(claims: Record<string, any>, clientId: string, mapping: RoleMapping, permission: string): boolean {
  return permissionsFor(claims, clientId, mapping).includes(permission)
}
```

```ts solution
type RoleMapping = { realm?: Record<string, string[]>; client?: Record<string, string[]> }

function roleList(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((r): r is string => typeof r === 'string') : []
}

function rolesAt(obj: unknown): string[] {
  return typeof obj === 'object' && obj !== null ? roleList((obj as { roles?: unknown }).roles) : []
}

export function permissionsFor(claims: Record<string, any>, clientId: string, mapping: RoleMapping): string[] {
  const out = new Set<string>()
  const realmMap = mapping.realm ?? {}
  const clientMap = mapping.client ?? {}
  for (const role of rolesAt(claims.realm_access)) {
    if (Object.hasOwn(realmMap, role)) for (const p of realmMap[role]) out.add(p)
  }
  const resource = claims.resource_access
  const mine = typeof resource === 'object' && resource !== null && Object.hasOwn(resource, clientId) ? resource[clientId] : undefined
  for (const role of rolesAt(mine)) {
    if (Object.hasOwn(clientMap, role)) for (const p of clientMap[role]) out.add(p)
  }
  return [...out].sort()
}

export function can(claims: Record<string, any>, clientId: string, mapping: RoleMapping, permission: string): boolean {
  return permissionsFor(claims, clientId, mapping).some(
    (p) => p === permission || (p.endsWith(':*') && permission.startsWith(p.slice(0, -1))),
  )
}
```

```ts tests
const MAPPING = {
  realm: { admin: ['projects:*', 'users:manage'] },
  client: { 'projects-reader': ['projects:read'], 'projects-writer': ['projects:read', 'projects:write'] },
}
const alice = {
  sub: 'a',
  realm_access: { roles: ['admin', 'default-roles-devquest', 'offline_access'] },
  resource_access: { 'projects-api': { roles: ['projects-writer', 'projects-reader'] }, account: { roles: ['manage-account'] } },
}
const bob = { sub: 'b', resource_access: { 'projects-api': { roles: ['projects-reader'] } } }

test('realm + client roles, unique and sorted', () => {
  expect(permissionsFor(alice, 'projects-api', MAPPING)).toEqual(['projects:*', 'projects:read', 'projects:write', 'users:manage'])
})
test('works without realm_access', () => {
  expect(permissionsFor(bob, 'projects-api', MAPPING)).toEqual(['projects:read'])
})
test("other clients' roles grant nothing", () => {
  const eve = { resource_access: { 'billing-api': { roles: ['projects-writer'] } } }
  expect(permissionsFor(eve, 'projects-api', MAPPING)).toEqual([])
})
test('realm and client namespaces stay separate', () => {
  const mallory = { realm_access: { roles: ['projects-writer'] }, resource_access: { 'projects-api': { roles: ['admin'] } } }
  expect(permissionsFor(mallory, 'projects-api', MAPPING)).toEqual([])
})
test('malformed shapes and prototype keys are ignored', () => {
  expect(permissionsFor({}, 'projects-api', MAPPING)).toEqual([])
  expect(permissionsFor({ realm_access: 'admin', resource_access: { 'projects-api': { roles: 'projects-writer' } } }, 'projects-api', MAPPING)).toEqual([])
  expect(permissionsFor({ realm_access: { roles: ['constructor', 'toString', 42, null] } }, 'projects-api', MAPPING)).toEqual([])
  expect(permissionsFor({ resource_access: null }, 'projects-api', MAPPING)).toEqual([])
  expect(permissionsFor(alice, 'projects-api', {})).toEqual([])
})
test('can() with exact and wildcard permissions', () => {
  expect(can(bob, 'projects-api', MAPPING, 'projects:read')).toBe(true)
  expect(can(bob, 'projects-api', MAPPING, 'projects:write')).toBe(false)
  expect(can(alice, 'projects-api', MAPPING, 'projects:delete')).toBe(true)
  expect(can(alice, 'projects-api', MAPPING, 'users:manage')).toBe(true)
  expect(can(alice, 'projects-api', MAPPING, 'billing:read')).toBe(false)
  expect(can(alice, 'projects-api', MAPPING, 'projectsX:read')).toBe(false)
})
```
:::

## Service-to-service: client credentials and token exchange

Not every caller is a person. A nightly report worker, a webhook relay or one API calling another
needs a token too, and there are two standard ways to get one.

**Client credentials: the service is the caller.** Register the worker as a **confidential client**
(`reports-worker`) with *Client authentication* on, *Service accounts roles* on, and the standard
(browser) flow off. Keycloak creates a hidden **service-account user** for it. Give that user the
client role it needs (`projects-api` → `projects:read`), and add the same **Audience mapper** for
`projects-api` you use for the SPA, or the API rejects the token with `IDX10214`. The worker then
asks for a token directly, with no browser and no refresh token:

```http
POST /realms/devquest/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=reports-worker&client_secret=<from the secret store>
```

The access token's `azp` is `reports-worker`, `sub` is the service-account user, and roles come
from the service account. Your API's validation code doesn't change. Two habits matter:

- **Cache the token** until shortly before `exp` (a `DelegatingHandler`, or a library such as
  Duende.AccessTokenManagement). Requesting a new token per HTTP call turns Keycloak into your
  hottest dependency.
- **Prefer keys to shared secrets.** Keycloak supports `private_key_jwt` / signed-JWT client
  authentication, so only a public key lives in Keycloak. Since 26.6 it also supports **federated
  client authentication**: the client proves who it is with a token from another trusted issuer
  (for example its Kubernetes service-account token), and no client secret exists at all. Managed
  clouds call the same idea workload identity (see the Recap).

**Token exchange: the service acts for a user.** API A received Alice's token (`aud: api-a`) and
must call API B *as Alice*. Forwarding her token would mean B accepts tokens issued for A, or that
every token carries every audience. Both widen the blast radius of a leaked token. OAuth 2.0
**Token Exchange** (RFC 8693) solves this: A sends Alice's token to Keycloak and gets back a new,
narrower token for B. Keycloak 26.2 and later support *standard token exchange* for this case;
you enable it per client (*Standard token exchange* in the client's capability config).

```http
POST /realms/devquest/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&client_id=api-a&client_secret=<secret>
&subject_token=<Alice's access token>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&audience=api-b
```

The new token still has `sub` = Alice, so B authorises against her roles, but its `aud` is `api-b`
and `azp` is `api-a`, so B's logs show who called on her behalf. Use client credentials when the
action is the service's own (the nightly report), and token exchange when it is the user's (Alice
exports *her* projects through a second API).

:::quiz id=cl-07-q9 xp=15
A new `reports-worker` gets a token with `grant_type=client_credentials` and calls `projects-api`.
The API answers `401`, and its log says `IDX10214: Audience validation failed`. The service
account has the `projects:read` client role. What's the right fix?
- [ ] Set `ValidateAudience = false` in the API, because service tokens have no audience
- [ ] Switch the worker to the authorization code flow so the token gets an audience
- [x] Add an Audience mapper for `projects-api` to the worker client (or a client scope it uses), so its tokens carry `aud: projects-api`
- [ ] Give the service-account user the realm role `admin`
> Client-credentials tokens go through the same mappers as user tokens. Without an Audience
> mapper, `aud` names only what Keycloak adds by default (often `account`, or nothing), so the
> API correctly refuses a token that wasn't issued for it. Turning audience validation off would
> let *any* token from the realm in, including ones issued for other APIs. The code flow needs a
> user and a browser, which a worker doesn't have. The `admin` role is unrelated to `aud` and
> grants far more than the worker needs.
:::

:::pro title="Running Keycloak for real: replicas, sessions, upgrades, tenants"
- **Two or three replicas** behind the proxy, sharing the Postgres database. Since Keycloak 26,
  user sessions are persisted in the database by default, so a rolling restart no longer logs
  everyone out. The Infinispan caches between the replicas only hold hot copies.
- **Upgrades:** since 26.6, **zero-downtime patch releases** are supported: a patch within the same
  `major.minor` stream (26.8.1 → 26.8.2) can roll pod by pod. A minor or major upgrade can change
  the DB schema and the caches, so plan it as a stop-all-old-pods change unless that release's
  upgrading guide says otherwise. Rehearse it on a copy of the production database either way.
- **Tenants:** a realm per customer gives hard isolation (own keys, own admins) but hundreds of
  realms are slow to manage and to start. **Organizations** keep many customers in one realm,
  each with its own domain and IdP, and put an `organization` claim in the token for your API to
  check. Most B2B SaaS products start with Organizations and give realms only to customers who
  contractually need isolation.
:::

## The React side: oidc-client-ts and react-oidc-context

`oidc-client-ts` implements the protocol (PKCE, state, token storage, renew). `react-oidc-context` wraps it in
a provider and a `useAuth()` hook:

```tsx
// main.tsx
import { AuthProvider } from 'react-oidc-context'
import { WebStorageStateStore } from 'oidc-client-ts'

const oidcConfig = {
  authority: 'http://localhost:8080/realms/devquest',     // discovery: {authority}/.well-known/openid-configuration
  client_id: 'devquest-spa',
  redirect_uri: 'http://localhost:5173/',
  post_logout_redirect_uri: 'http://localhost:5173/',
  scope: 'openid profile email',
  automaticSilentRenew: true,                                // default true; shown for clarity
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  onSigninCallback: () => window.history.replaceState({}, document.title, window.location.pathname),
}

createRoot(document.getElementById('root')!).render(<AuthProvider {...oidcConfig}><App /></AuthProvider>)
```

### Silent renew, and why the iframe trick is dying

Access tokens live minutes, so the SPA has to renew them without bothering the user. `oidc-client-ts`
raises an *access token expiring* event (by default 60 s before `exp`) and calls `signinSilent()`, which uses:

1. **The refresh token**, if it has one. Keycloak issues refresh tokens to public clients, so this is the
   normal path: a background `POST /token` with `grant_type=refresh_token`.
2. Otherwise, a hidden **iframe** to `/auth?prompt=none` (this needs a `silent_redirect_uri` page in your
   config) that relies on Keycloak's session cookie being sent in a third-party context. Safari blocks
   third-party cookies, Firefox partitions them (Total Cookie Protection), and Chrome users can block them
   (Incognito does by default). So when the IdP and app are on different *sites* (for example
   `auth.example.com` vs `app.other.com`), the iframe fails without any visible error, and users get
   "randomly logged out". (`localhost:8080` and `localhost:5173` count as the same site, because ports don't
   matter for "site", so the lab won't show this.)

With refresh-token rotation on (*Revoke Refresh Token*), every refresh returns a new refresh token and
invalidates the old one. That's great against theft, but two tabs refreshing at the same instant can collide.
Libraries mostly cope; know the symptom (an `invalid_grant` error, worded *Maximum allowed refresh token reuse
exceeded* in recent versions and *Stale token* in older ones) if users report losing sessions with many tabs
open.

:::warn title="Tokens in the browser are readable by XSS"
The config above keeps the user (access **and** refresh token) in `sessionStorage`. That survives a reload
but not closing the tab, and it is readable by any script running on your origin. An XSS bug therefore
leaks a refresh token that can mint new access tokens until the SSO session ends. Mitigations: a strict
Content-Security-Policy, refresh-token rotation, short SSO idle timeouts, or, for high-value apps, a **BFF**
that keeps tokens server-side and gives the browser only an `HttpOnly` session cookie.
:::

### Logout is three different things

| What | How | Effect |
|---|---|---|
| Local logout | `auth.removeUser()` | SPA forgets tokens; the Keycloak SSO session still lives, and the next "Sign in" is instant |
| **RP-initiated logout** | `auth.signoutRedirect()` → Keycloak `end_session_endpoint` with `id_token_hint` + `post_logout_redirect_uri` | Keycloak ends the SSO session and refresh tokens die |
| Back-channel logout | Keycloak POSTs a *logout token* to confidential clients' registered URL | server-side apps (BFFs) drop their sessions too |

None of these can recall an **access token** already handed out: it's a self-contained JWT, valid until
`exp`. That's the price of stateless validation and the reason access tokens are short-lived. If you need
instant revocation for a sensitive API, it can call Keycloak's **token introspection** endpoint per
request (or per few seconds, cached) instead of only validating locally. Introspection is an authenticated
call, so the API then needs its own credentials (`projects-api` as a confidential client with a secret).

The `post_logout_redirect_uri` must be registered on the client (*Valid post logout redirect URIs*);
otherwise Keycloak shows an "Invalid redirect uri" error page.

:::quiz id=cl-07-q5 xp=15
Bob clicks **Sign out** (RP-initiated logout). An attacker who copied Bob's access token two minutes earlier
replays it against the API. The access token lifespan is 5 minutes. What happens, and what limits the damage?
Select all that apply.
- [x] The API accepts the token until its `exp`, because local JWT validation doesn't ask Keycloak about sessions
- [x] The short access-token lifetime limits the window
- [ ] The API rejects it immediately because Keycloak pushes revocations to every resource server
- [x] An API that must react instantly can introspect tokens at Keycloak instead of only validating them locally
- [ ] Logout rotates the realm signing key, invalidating every token
> Logout ends the SSO session and kills refresh tokens, so the attacker can't *renew*, but an issued JWT stays
> valid until `exp`. Keycloak doesn't push revocations to APIs (back-channel logout targets clients with
> sessions, not stateless APIs), and rotating realm keys on every logout would log out everyone.
:::

:::quiz id=cl-07-q6 xp=10
After a Safari update, users of your SPA get logged out every 5 minutes. Keycloak and the SPA are on
different sites, and the app was configured years ago to renew tokens using a hidden iframe with
`prompt=none`. What is the most robust fix?
- [ ] Increase the access token lifespan to 24 hours
- [ ] Ask users to enable third-party cookies
- [x] Renew with the refresh token (Keycloak issues them to public clients) or move to a BFF, so renewal doesn't depend on third-party cookies
- [ ] Store the access token in `localStorage` so it survives
> The iframe renew needs Keycloak's session cookie in a third-party context, which Safari blocks, Firefox
> partitions, and Chrome users can block.
> The refresh-token grant is a normal CORS `POST`, no third-party cookies involved. A 24-hour token "fixes" the
> symptom by making every stolen token far more valuable, and storage location doesn't affect renewal at all.
:::

## Common errors, decoded

| Symptom | Where | Usual cause | Fix |
|---|---|---|---|
| `IDX10205: Issuer validation failed` | API log | token `iss` ≠ the `issuer` in the discovery document the API fetched (localhost vs keycloak, http vs https, trailing slash) | fix `KC_HOSTNAME`; point `Authority`/`MetadataAddress` at a URL that advertises the public issuer |
| `IDX10214: Audience validation failed … 'account'` | API log | no Audience mapper for `projects-api` | add an Audience mapper; **never** `ValidateAudience = false` |
| `IDX10223: Lifetime validation failed. The token is expired` | API log | expired token, or clock skew (Docker Desktop VM clock drifts after laptop sleep) | renew earlier; sync clocks (NTP); modest `ClockSkew` |
| `IDX10222: … not yet valid` | API log | the issuer's clock is ahead (IdPs that set `nbf`) | NTP; small skew |
| `IDX10503` / `IDX10500` signature failed, key not found | API log | token from another realm/instance, e.g. after `docker compose down -v` regenerated keys while the SPA kept an old token | sign out / clear `sessionStorage`; check `kid` vs JWKS |
| `IDX20803: Unable to obtain configuration` | API log | API can't reach `{Authority}/.well-known/…` (container networking, DNS, TLS) | curl it from the API's network; `MetadataAddress` |
| `InvalidOperationException: The MetadataAddress or Authority must use HTTPS unless disabled for development by setting RequireHttpsMetadata=false.` | API log; every request (even anonymous ones) returns **500**, not 401 | `http://` authority with `RequireHttpsMetadata = true` (the default) | set it to false **only** in Development |
| "Invalid parameter: redirect_uri" | Keycloak page | redirect URI not in *Valid redirect URIs* (port, trailing slash) | register the exact URI or a narrow `http://localhost:5173/*` |
| CORS error on `/token` | browser console | SPA origin missing from *Web origins* | add `http://localhost:5173` |
| `invalid_grant: Account is not fully set up` | token endpoint | required action pending (e.g. user profile needs first/last name/email, or *Update password*) | complete the user record; check *Required actions* |
| 401 with `WWW-Authenticate: Bearer error="invalid_token"` | HTTP response | any of the above. Read the `error_description` header | — |
| **403** although "the user is admin" | HTTP response | authenticated, but no matching flat role claim | flatten `realm_access`, check `RoleClaimType` |

For deep debugging in Development, `Microsoft.IdentityModel.Logging.IdentityModelEventSource.ShowPII = true`
makes the IDX messages include the actual values (issuer, audience) instead of `[PII is hidden]`. Never in
production.

:::quiz id=cl-07-q7 xp=15
Everything runs in Docker Compose. The SPA (in the browser) gets tokens from `http://localhost:8080`; the API
container has `Authority = "http://keycloak:8080/realms/devquest"`. Every request gets 401 with
`IDX10205: Issuer validation failed`. Which change fixes it **without weakening** validation?
- [ ] `TokenValidationParameters.ValidateIssuer = false`
- [ ] Have the SPA use `http://keycloak:8080` as its authority
- [x] Make the issuer stable: set `KC_HOSTNAME=http://localhost:8080` and set the API's `Authority` to that public URL, fetching metadata over the internal network (`MetadataAddress`) if the container can't reach `localhost:8080`
- [ ] Add `ClockSkew = TimeSpan.FromMinutes(10)`
> The issuer in the token comes from how Keycloak sees its own URL. Give it one canonical public URL and
> expect exactly that in the API. JwtBearer takes the expected issuer from the discovery document's `issuer`.
> With a fixed `KC_HOSTNAME`, that document says `localhost:8080` even when the API fetches it via
> `http://keycloak:8080` (add `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true` so its `jwks_uri` is reachable from the
> container too). Turning off issuer validation removes a defence layer: the API would accept tokens from any
> issuer whose keys it trusts. The browser can't resolve `keycloak` (a Docker-internal DNS name), and clock
> skew has nothing to do with issuers.
:::

:::job title="What day one with Keycloak looks like"
- Someone hands you a realm JSON in the repo and a `docker compose up` that starts Keycloak with
  `--import-realm`. The first task is often "add a role / client / mapper", which means editing that JSON,
  re-importing locally, and getting the change into staging through the team's config tool, **not** by
  clicking in the staging console.
- You'll paste tokens into a decoder (jwt.io or a local script) daily. Know `iss`, `aud`, `azp`, `exp`,
  `realm_access`, `resource_access`, `scope` by heart. Never paste **production** tokens into third-party
  websites.
- "Login is broken" tickets are 80% the errors table above. Read the `WWW-Authenticate` header and the API
  log before touching code.
:::

:::quiz id=cl-07-q8 xp=10
You add "Sign in with GitHub" via identity brokering and turn on *Trust email* plus automatic linking to
existing accounts by email, "to avoid duplicate users". Why does a security reviewer block it?
- [ ] GitHub doesn't support OIDC, so brokering can't work at all
- [x] If the external IdP ever returns an email the user doesn't really own, the attacker is linked to (and signed into) the victim's existing Keycloak account
- [ ] Brokered users can't have roles
- [ ] Trusting email makes Keycloak send password reset mails to GitHub
> Automatic linking by email turns *the other IdP's* email verification into *your* login security. Keep
> Keycloak's default of having the user prove they own the existing account (re-authenticate) before
> linking, and only trust email from IdPs you know verify it. (GitHub is brokered via Keycloak's built-in
> GitHub provider over OAuth2. "Can't work" is false.)
:::

## Lab

:::lab id=cl-07-lab1 xp=150
title: Keycloak + Postgres in Compose, a protected ASP.NET API and a React PKCE login
You'll build this, with realm configuration as code:

```text
browser ── http://localhost:5173 (Vite, React SPA, public client + PKCE)
   │  login redirect
   ▼
http://localhost:8080  Keycloak 26 (start-dev, --import-realm) ──► kc-db (postgres:18)
   ▲  JWKS / discovery
   │
http://localhost:5080  ProjectsApi (ASP.NET Core 10, JwtBearer, policies)   ← runs on the host
```

The API and SPA run **on the host**, so everyone (browser, API, Keycloak's `KC_HOSTNAME`) agrees on
`http://localhost:8080`, with no issuer mismatch. Needs: Docker, .NET 10 SDK, Node 22+, `curl`, `jq`.

**1. Folder layout**

```bash
mkdir -p keycloak-lab/realm && cd keycloak-lab
```

**2. `compose.yaml`**

```yaml
services:
  kc-db:
    image: postgres:18
    environment:
      POSTGRES_DB: keycloak
      POSTGRES_USER: keycloak
      POSTGRES_PASSWORD: keycloak-dev-pw
    volumes:
      - kc-db-data:/var/lib/postgresql        # postgres 18+: mount the parent dir, not .../data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U keycloak -d keycloak"]
      interval: 5s
      timeout: 3s
      retries: 20

  keycloak:
    image: quay.io/keycloak/keycloak:26.8.2
    command: ["start-dev", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://kc-db:5432/keycloak
      KC_DB_USERNAME: keycloak
      KC_DB_PASSWORD: keycloak-dev-pw
      KC_HOSTNAME: http://localhost:8080
      KC_HEALTH_ENABLED: "true"
    ports:
      - "8080:8080"     # public: login pages, OIDC endpoints, admin console (dev only!)
      - "9000:9000"     # management: /health/ready, /metrics
    volumes:
      - ./realm:/opt/keycloak/data/import:ro
    depends_on:
      kc-db:
        condition: service_healthy
    healthcheck:
      # the image has no curl; bash's /dev/tcp does the job
      test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health/ready HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n' >&3 && grep -q UP <&3"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 20s

volumes:
  kc-db-data:
```

:::warn title="Pin the exact version"
`26.8.2` was the newest release when this lesson was last updated (November 2026). Check the tags on
`quay.io/keycloak/keycloak` and pin the newest **26.x.y patch** you can find, in every place this lesson
uses a tag (compose file and both `FROM` lines), so dev, CI and the optimized production image match. Keycloak ships security fixes often. If the
healthcheck misbehaves on your image, delete it and watch the logs for the "started" line instead.
:::

**3. `realm/devquest-realm.json`.** Two users: **alice** is a realm `admin` and in group `/editors`
(→ `projects-writer`); **bob** has only `projects-reader`. Three clients: the SPA, a CLI test client and
the API.

```json
{
  "realm": "devquest",
  "enabled": true,
  "sslRequired": "external",
  "registrationAllowed": false,
  "loginWithEmailAllowed": true,
  "bruteForceProtected": true,
  "accessTokenLifespan": 120,
  "ssoSessionIdleTimeout": 1800,
  "ssoSessionMaxLifespan": 36000,
  "roles": {
    "realm": [
      { "name": "admin", "description": "Full access to every DevQuest app" }
    ],
    "client": {
      "projects-api": [
        { "name": "projects-reader", "description": "Read projects" },
        { "name": "projects-writer", "description": "Create and edit projects" }
      ]
    }
  },
  "groups": [
    { "name": "editors", "clientRoles": { "projects-api": ["projects-writer"] } }
  ],
  "clients": [
    {
      "clientId": "projects-api",
      "name": "Projects API (resource server: owns roles, used as audience)",
      "enabled": true,
      "publicClient": false,
      "standardFlowEnabled": false,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "serviceAccountsEnabled": false
    },
    {
      "clientId": "devquest-spa",
      "name": "DevQuest SPA",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": true,
      "implicitFlowEnabled": false,
      "directAccessGrantsEnabled": false,
      "redirectUris": ["http://localhost:5173/*"],
      "webOrigins": ["http://localhost:5173"],
      "attributes": {
        "pkce.code.challenge.method": "S256",
        "post.logout.redirect.uris": "http://localhost:5173/*"
      },
      "protocolMappers": [
        {
          "name": "audience-projects-api",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.client.audience": "projects-api",
            "access.token.claim": "true",
            "id.token.claim": "false"
          }
        }
      ]
    },
    {
      "clientId": "devquest-cli",
      "name": "Local testing only: password grant",
      "enabled": true,
      "publicClient": true,
      "standardFlowEnabled": false,
      "directAccessGrantsEnabled": true,
      "protocolMappers": [
        {
          "name": "audience-projects-api",
          "protocol": "openid-connect",
          "protocolMapper": "oidc-audience-mapper",
          "config": {
            "included.client.audience": "projects-api",
            "access.token.claim": "true",
            "id.token.claim": "false"
          }
        }
      ]
    }
  ],
  "users": [
    {
      "username": "alice",
      "enabled": true,
      "email": "alice@devquest.test",
      "emailVerified": true,
      "firstName": "Alice",
      "lastName": "Admin",
      "credentials": [{ "type": "password", "value": "alice", "temporary": false }],
      "realmRoles": ["admin"],
      "groups": ["/editors"]
    },
    {
      "username": "bob",
      "enabled": true,
      "email": "bob@devquest.test",
      "emailVerified": true,
      "firstName": "Bob",
      "lastName": "Reader",
      "credentials": [{ "type": "password", "value": "bob", "temporary": false }],
      "clientRoles": { "projects-api": ["projects-reader"] }
    }
  ]
}
```

:::warn title="The CLI client and password grant are for local testing only"
`devquest-cli` uses the *Resource Owner Password Credentials* grant (direct access grants), which OAuth 2.1
removes: the app sees the user's password, and MFA/passkeys can't work. It's here so you can get tokens
with `curl`. Never enable it in a real realm. The audience mapper is duplicated on both clients to keep the
JSON self-contained. In a real realm you'd create one `projects-api-audience` client scope and attach it.
:::

**4. Start it**

```bash
docker compose up -d
docker compose logs -f keycloak      # Ctrl+C once you see the "started" line
```

Expected (roughly; versions and timings differ):

```text
... Realm 'devquest' imported
... Keycloak 26.8.x on JVM (powered by Quarkus 3.x) started in 9.8s. Listening on: http://0.0.0.0:8080. Management interface listening on http://0.0.0.0:9000.
... Running the server in development mode. DO NOT use this configuration in production.
```

```bash
curl -s http://localhost:9000/health/ready | jq .status
curl -s http://localhost:8080/realms/devquest/.well-known/openid-configuration | jq '{issuer, jwks_uri, end_session_endpoint}'
```

```text
"UP"
{
  "issuer": "http://localhost:8080/realms/devquest",
  "jwks_uri": "http://localhost:8080/realms/devquest/protocol/openid-connect/certs",
  "end_session_endpoint": "http://localhost:8080/realms/devquest/protocol/openid-connect/logout"
}
```

Changed the JSON? `--import-realm` skips existing realms, so re-import with `docker compose down -v && docker compose up -d`.

**5. Get a token and read it**

```bash
token() {
  curl -s http://localhost:8080/realms/devquest/protocol/openid-connect/token \
    -d grant_type=password -d client_id=devquest-cli -d scope=openid \
    -d username="$1" -d password="$1" | jq -r .access_token
}
ALICE=$(token alice); BOB=$(token bob)
node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url")))' "$ALICE"
```

You should see (abridged): `iss: 'http://localhost:8080/realms/devquest'`, an `aud` that includes
`'projects-api'`, `azp: 'devquest-cli'`, `typ: 'Bearer'`, `preferred_username: 'alice'`,
`realm_access: { roles: [ 'admin', … ] }` and `resource_access: { 'projects-api': { roles: [ 'projects-writer' ] } }`.

**6. The API**

```bash
dotnet new web -n ProjectsApi -f net10.0
cd ProjectsApi
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

Replace `Program.cs`:

```csharp
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);

var authority = builder.Configuration["Auth:Authority"] ?? "http://localhost:8080/realms/devquest";
var apiClientId = builder.Configuration["Auth:Audience"] ?? "projects-api";

builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins("http://localhost:5173")
    .AllowAnyHeader()
    .AllowAnyMethod()));

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = authority;
        options.Audience = apiClientId;
        options.RequireHttpsMetadata = !builder.Environment.IsDevelopment();
        options.MapInboundClaims = false;
        options.TokenValidationParameters.NameClaimType = "preferred_username";
        options.TokenValidationParameters.RoleClaimType = "roles";
        options.TokenValidationParameters.ClockSkew = TimeSpan.FromSeconds(30);
        options.Events = new JwtBearerEvents
        {
            OnTokenValidated = ctx =>
            {
                if (ctx.Principal?.Identity is ClaimsIdentity identity)
                    KeycloakRoles.Flatten(identity, apiClientId);
                return Task.CompletedTask;
            },
            OnAuthenticationFailed = ctx =>
            {
                ctx.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>()
                    .CreateLogger("Auth").LogWarning("JWT rejected: {Message}", ctx.Exception.Message);
                return Task.CompletedTask;
            },
        };
    });

builder.Services.AddAuthorizationBuilder()
    .AddPolicy("projects:read", p => p.RequireRole("projects-reader", "projects-writer", "admin"))
    .AddPolicy("projects:write", p => p.RequireRole("projects-writer", "admin"))
    .AddPolicy("projects:delete", p => p.RequireRole("admin"));

var app = builder.Build();

app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

var projects = new List<Project> { new(1, "Website relaunch"), new(2, "Mobile app") };

app.MapGet("/api/health", () => new { status = "ok" });

app.MapGet("/api/me", (ClaimsPrincipal user) => new
{
    name = user.Identity?.Name,
    sub = user.FindFirstValue("sub"),
    roles = user.FindAll("roles").Select(c => c.Value).Order().ToArray(),
}).RequireAuthorization();

app.MapGet("/api/projects", () => projects).RequireAuthorization("projects:read");

app.MapPost("/api/projects", (CreateProject body) =>
{
    var project = new Project(projects.Count == 0 ? 1 : projects.Max(p => p.Id) + 1, body.Name);
    projects.Add(project);
    return Results.Created($"/api/projects/{project.Id}", project);
}).RequireAuthorization("projects:write");

app.MapDelete("/api/projects/{id:int}", (int id) =>
    projects.RemoveAll(p => p.Id == id) > 0 ? Results.NoContent() : Results.NotFound())
    .RequireAuthorization("projects:delete");

app.Run();

record Project(int Id, string Name);
record CreateProject(string Name);

static class KeycloakRoles
{
    public static void Flatten(ClaimsIdentity identity, string clientId)
    {
        var roles = new HashSet<string>();
        if (identity.FindFirst("realm_access")?.Value is { } realm)
            roles.UnionWith(ReadRoles(realm));
        if (identity.FindFirst("resource_access")?.Value is { } resource)
        {
            using var doc = JsonDocument.Parse(resource);
            if (doc.RootElement.ValueKind == JsonValueKind.Object &&
                doc.RootElement.TryGetProperty(clientId, out var client))
                roles.UnionWith(ReadRoles(client.GetRawText()));
        }
        foreach (var role in roles)
            if (!identity.HasClaim("roles", role))
                identity.AddClaim(new Claim("roles", role));
    }

    static List<string> ReadRoles(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object ||
            !doc.RootElement.TryGetProperty("roles", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return [];
        return arr.EnumerateArray()
            .Where(e => e.ValueKind == JsonValueKind.String)
            .Select(e => e.GetString()!)
            .ToList();
    }
}
```

Run it (keep this terminal open; use a second one for curl):

```bash
dotnet run -- --urls http://localhost:5080
```

**7. Prove the rules with curl** (from the terminal where `ALICE`/`BOB` are set; tokens live 120 s, so
re-run `ALICE=$(token alice); BOB=$(token bob)` if you get `invalid_token`)

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5080/api/projects
curl -s -i http://localhost:5080/api/projects | grep -i www-authenticate
curl -s -H "Authorization: Bearer $ALICE" http://localhost:5080/api/me | jq
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $BOB" http://localhost:5080/api/projects
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $BOB" -H 'Content-Type: application/json' \
  -d '{"name":"Bob was here"}' http://localhost:5080/api/projects
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ALICE" -H 'Content-Type: application/json' \
  -d '{"name":"Alice was here"}' http://localhost:5080/api/projects
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $ALICE" http://localhost:5080/api/projects/1
```

Expected:

```text
401
WWW-Authenticate: Bearer
{
  "name": "alice",
  "sub": "3f0c…-…",
  "roles": [ "admin", "projects-writer", … ]
}
200
403
201
204
```

(The `roles` array may also contain `default-roles-devquest`, `offline_access` or `uma_authorization`,
depending on how the import assigned default roles.)

**8. Break it on purpose** (restart `dotnet run` after each change, restore afterwards)

| Change | Expected |
|---|---|
| `options.Audience = "something-else"` | 401, log: `IDX10214: Audience validation failed` |
| In `compose.yaml` comment out `KC_HOSTNAME` and run `docker compose up -d` (no `-v`). Then get alice's token from `http://127.0.0.1:8080/...` (edit the URL in `token()`) while the API keeps `localhost` | 401, log: `IDX10205: Issuer validation failed`. Same server, same keys, but the token says `127.0.0.1` and the discovery document the API fetched says `localhost` |
| Remove the `KeycloakRoles.Flatten(...)` call | alice gets **403** on POST although she is "admin" |

Notice what does **not** break: changing only the API's `authority` to `http://127.0.0.1:8080/realms/devquest`
while `KC_HOSTNAME` is fixed. The API's discovery request then goes to `127.0.0.1`, but Keycloak still
advertises `"issuer": "http://localhost:8080/realms/devquest"`, and that's the value JwtBearer validates
against. A fixed hostname protects you from exactly this kind of mismatch.

**9. The React SPA** (new terminal, in `keycloak-lab/`)

```bash
npm create vite@latest spa -- --template react-ts
cd spa
npm install
npm install oidc-client-ts react-oidc-context
```

(If `create vite` asks whether to install and start the dev server right away, answer **no**. You'll start it
after replacing the files.)

Replace `src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from 'react-oidc-context'
import { WebStorageStateStore } from 'oidc-client-ts'
import App from './App'

const oidcConfig = {
  authority: 'http://localhost:8080/realms/devquest',
  client_id: 'devquest-spa',
  redirect_uri: 'http://localhost:5173/',
  post_logout_redirect_uri: 'http://localhost:5173/',
  scope: 'openid profile email',
  automaticSilentRenew: true,
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
  onSigninCallback: () => window.history.replaceState({}, document.title, window.location.pathname),
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider {...oidcConfig}>
      <App />
    </AuthProvider>
  </StrictMode>,
)
```

Replace `src/App.tsx`:

```tsx
import { useState } from 'react'
import { useAuth } from 'react-oidc-context'

const API = 'http://localhost:5080'

export default function App() {
  const auth = useAuth()
  const [result, setResult] = useState('')

  async function call(path: string, method = 'GET', body?: unknown) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${auth.user?.access_token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    setResult(`${res.status} ${res.statusText}\n${await res.text()}`)
  }

  if (auth.isLoading) return <p>Loading…</p>
  if (auth.error) return <p role="alert">Auth error: {auth.error.message}</p>
  if (!auth.isAuthenticated) return <button onClick={() => void auth.signinRedirect()}>Sign in</button>

  return (
    <main>
      <p>
        Signed in as <b>{auth.user?.profile.preferred_username}</b>. Access token expires in{' '}
        {auth.user?.expires_in}s (renews automatically ~60 s before expiry).
      </p>
      <button onClick={() => void call('/api/me')}>GET /api/me</button>
      <button onClick={() => void call('/api/projects')}>GET /api/projects</button>
      <button onClick={() => void call('/api/projects', 'POST', { name: 'From the SPA' })}>POST /api/projects</button>
      <button onClick={() => void auth.signoutRedirect()}>Sign out</button>
      <pre>{result}</pre>
    </main>
  )
}
```

```bash
npm run dev     # http://localhost:5173
```

Sign in as **bob** (password `bob`), click the buttons, then sign out and repeat as **alice**. Open DevTools →
Network and watch:

- the `/auth?…&code_challenge=…&code_challenge_method=S256` redirect,
- the `POST /token` with `grant_type=authorization_code` and a `code_verifier`,
- after about 60 s, another `POST /token` with `grant_type=refresh_token`: that's silent renew,
- on *Sign out*, a redirect to `/protocol/openid-connect/logout?id_token_hint=…&post_logout_redirect_uri=…`.

:::tip title="Stuck?"
"Invalid parameter: redirect_uri" → the SPA isn't on exactly `http://localhost:5173`. A CORS error on
`/token` → check `webOrigins`. An `IDX10503` after `docker compose down -v` → the realm got new keys; sign
out or clear the tab's `sessionStorage`.
:::

- [ ] `docker compose up -d` brings up Keycloak and its Postgres; `/health/ready` reports `UP` and the discovery `issuer` is `http://localhost:8080/realms/devquest`
- [ ] The realm, clients, roles, group and users come only from `realm/devquest-realm.json` (I did `down -v` + `up` and they reappeared)
- [ ] The curl sequence returns 401, 200 (`/api/me` for alice with her roles), 200, 403, 201, 204 as listed
- [ ] I broke audience, issuer (unfixed hostname + token from `127.0.0.1`) and role flattening one at a time and saw the predicted failure
- [ ] The SPA logs in with PKCE (I saw `code_challenge` and `code_verifier` in DevTools), bob gets 403 on POST and alice gets 201
- [ ] I observed a `grant_type=refresh_token` request (silent renew) and an RP-initiated logout redirect
:::

:::cards id=cl-07-cards1 xp=20 title="Keycloak & OIDC in practice"
Q: What is a Keycloak realm?
A: An isolated tenant with its own users, clients, roles, signing keys, sessions and login settings. Tokens from one realm are never valid in another.
Q: Public vs confidential client?
A: Public clients (SPA, mobile, CLI) can't keep a secret and use code + PKCE. Confidential clients (BFF, server apps, workers) authenticate with a secret or key and can use client credentials.
Q: ID token vs access token?
A: ID token: for the client, says who logged in (aud = client id). Access token: for the API, says what the bearer may do (aud must include the API).
Q: Why do Keycloak tokens often have aud "account" and not your API?
A: The roles scope's audience-resolve mapper adds clients whose roles the user holds. Add an explicit Audience mapper for your API.
Q: Where are Keycloak roles in an access token?
A: realm_access.roles for realm roles, resource_access.<clientId>.roles for client roles. Composite roles are already expanded.
Q: Why does RequireRole("admin") return 403 with a valid Keycloak token?
A: ASP.NET Core needs flat role claims of the RoleClaimType. Flatten realm_access/resource_access (OnTokenValidated / IClaimsTransformation) or add a Keycloak role mapper named roles.
Q: What does KC_HOSTNAME control?
A: The URL Keycloak uses for itself: the token issuer and the endpoints in the discovery document. Fix it to the public URL to avoid issuer mismatches.
Q: Which options make Keycloak work behind a TLS-terminating proxy?
A: KC_PROXY_HEADERS=xforwarded (or forwarded), KC_HTTP_ENABLED=true and KC_HOSTNAME=https://…; don't expose /admin publicly.
Q: What does --import-realm do if the realm already exists?
A: Skips it. It doesn't update. Re-create the DB in dev, or use keycloak-config-cli / Terraform for declarative updates.
Q: Default ClockSkew in ASP.NET Core JwtBearer?
A: 5 minutes. Many teams lower it to 30–60 s.
Q: Why is iframe-based silent renew unreliable today?
A: It needs the IdP's session cookie in a third-party context, which browsers block. Use the refresh-token grant or a BFF.
Q: Does logout invalidate an already issued access token?
A: No. It stays valid until exp under local JWT validation. Keep lifetimes short, or introspect for instant revocation.
Q: What claim should key your users table?
A: iss + sub. Never email: it's mutable and not always verified (nOAuth).
:::

## Recap

- An **IdP** centralises login, MFA, passkeys, brokering and sessions. Your apps only **validate tokens**.
- **Code + PKCE** for browsers. **ID token** is for the client, **access token** for the API (its `aud` must
  name the API), **refresh token** only goes to Keycloak.
- Keycloak model: **realm** (tenant) → **clients** (public vs confidential) → **client scopes + mappers**
  (what's in tokens) → **realm/client roles**, **groups**, **identity providers**.
- Keep realms **as code**: import JSON in dev/CI (`--import-realm` skips existing realms), declarative
  tooling (keycloak-config-cli, Terraform) for staging/prod.
- Production Keycloak: `start --optimized` from a pre-built image, its own Postgres, a fixed
  **`KC_HOSTNAME`**, `KC_PROXY_HEADERS` behind a proxy, health/metrics on port 9000, admin not public.
- ASP.NET Core: `Authority` = the realm URL (the expected `iss` comes from its discovery document),
  `Audience` = your API client, `MapInboundClaims = false`, small
  `ClockSkew`, flatten `realm_access`/`resource_access` into role claims, name **policies after permissions**.
- SPA: `oidc-client-ts` + `react-oidc-context`; renew with **refresh tokens**, not third-party-cookie iframes;
  RP-initiated logout ends the session, but issued access tokens live until `exp`.
- Most "auth is broken" bugs are **issuer mismatch, missing audience, clock skew or unflattened roles**.
  Read the IDX code.
- Services get their own tokens with **client credentials** (service account + Audience mapper, cached
  until `exp`) and act for a user with **token exchange**, which narrows the audience instead of
  forwarding the user's token.
- At an Azure or AWS shop the IdP is often **Entra ID** (or Entra External ID) or **Cognito**. OIDC,
  PKCE, audiences and the ASP.NET Core setup are the same; managed identities replace client secrets
  for service-to-service calls. See **The Managed Equivalents: Azure & AWS**.
