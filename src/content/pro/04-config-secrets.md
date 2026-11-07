---
id: pro-02
title: Configuration, Secrets & Feature Flags
level: intermediate
minutes: 65
xp: 140
summary: 12-factor config, environments, .env files, ASP.NET Core configuration and Vite env vars, secret stores, rotation and feature flags.
---

Every app has values that change between machines: the database connection string, the URL of the
payment provider, an API key, "is the new checkout enabled?". Hard-coding them means rebuilding to
change them — and leaking them the moment the repo is shared. This lesson is about where those
values live, how they reach your code, and how to keep the secret ones secret.

## The 12-factor rule: config lives in the environment

The [Twelve-Factor App](https://12factor.net/config) defines **config** as *everything that varies
between deploys* (dev, staging, production) and says: keep it **out of the code**, inject it from
the **environment**.

The litmus test: *could you open-source the repo right now without leaking a credential?* If not,
config is in your code.

| Config (varies per deploy) | Not config (same everywhere) |
|---|---|
| DB connection string, Redis URL | Route definitions, DI registrations |
| API keys, JWT signing keys | Business rules ("VAT is computed per line") |
| External service URLs | Default page size of 20 (unless ops needs to tune it) |
| Log level, feature switches | Package versions |

**Build once, deploy many.** The *same* Docker image goes to staging and production; only the
injected config differs. If you rebuild per environment, what you tested is not what you ship.

:::job
At a new job, ask on day one: "How do I get the dev secrets?" The answer is usually one of: a
shared password-manager vault, `dotnet user-secrets` + a script, a `.env.example` to copy, or a
CLI login to the company secret store (`az login`, `vault login`). It is **never** supposed to be
"they're in the repo" — if it is, say so politely; you've found a security issue.
:::

## Environments

| Environment | Purpose | Data | Who deploys |
|---|---|---|---|
| **Development** (local) | Your laptop, fast feedback | Seed/fake data, local Docker Postgres | You |
| **Test / CI** | Automated tests | Throwaway DBs, Testcontainers | Pipeline |
| **Staging** (pre-prod, QA) | Prod-like rehearsal, demos, manual QA | Anonymised or synthetic | Pipeline on merge |
| **Production** | Real users | Real, personal data — handle with care | Pipeline + approval |

Staging should be as close to production as you can afford (same image, same infra shape, same
config *keys* with different values). "Works in staging, breaks in prod" usually means a config
difference nobody wrote down.

:::warn
Never copy production data into dev or staging without anonymising it. Personal data in a
developer's laptop database is a GDPR incident waiting to happen.
:::

## Configuration in ASP.NET Core

ASP.NET Core builds one `IConfiguration` from layered **providers**. Later providers override
earlier ones for the same key:

1. `appsettings.json` — defaults, committed, **no secrets**
2. `appsettings.{Environment}.json` — e.g. `appsettings.Development.json`, committed
3. **User Secrets** — only when the environment is `Development`, stored outside the repo
4. **Environment variables**
5. **Command-line arguments**

The environment name comes from `ASPNETCORE_ENVIRONMENT` (or `DOTNET_ENVIRONMENT`), defaulting to
`Production` — a safe default: if you forget to set it, you get prod behaviour, not the developer
exception page.

Why is it `Development` on your laptop then? `dotnet run` reads `Properties/launchSettings.json`,
whose profiles set `ASPNETCORE_ENVIRONMENT=Development`. That file is **only** used by `dotnet run`
and IDEs — a container or `dotnet Api.dll` on a server ignores it. A classic surprise: the app works
with `dotnet run`, but in Docker it runs as `Production`, so user secrets and
`appsettings.Development.json` are not loaded.

```json
// appsettings.json
{
  "ConnectionStrings": { "Default": "Host=localhost;Database=app;Username=app" },
  "Smtp": { "Host": "localhost", "Port": 1025, "From": "noreply@example.com" },
  "FeatureManagement": { "NewCheckout": false }
}
```

Everything is flattened into `key → string` pairs with `:` as separator: `Smtp:Port` → `"1025"`,
`ConnectionStrings:Default` → `"Host=localhost;…"`. Keys are **case-insensitive**. Binding (below) converts
the strings back into `int`, `bool` and so on.

Nested keys are written with `:` in code and with **double underscore** `__` in environment
variables (because `:` isn't allowed in env var names on every OS):

```bash
# overrides Smtp:Host and ConnectionStrings:Default
export Smtp__Host=smtp.sendgrid.net
export ConnectionStrings__Default="Host=db;Database=app;Username=app;Password=s3cret"
```

The same keys work everywhere you can set env vars — `environment:` in Docker Compose, `env:` in a
Kubernetes Deployment, *App settings* in Azure App Service. Arrays use indexes: `Cors__Origins__0`,
`Cors__Origins__1`. A common mistake is a single underscore (`Smtp_Host`) — that's simply a
different, unused key, and nothing warns you.

### User Secrets for local development

```bash
cd api/Api.Web
dotnet user-secrets init                       # adds a UserSecretsId to the .csproj
dotnet user-secrets set "Smtp:Password" "dev-password"
dotnet user-secrets list
```

Values are stored in your user profile (`~/.microsoft/usersecrets/<id>/secrets.json` on
Linux/macOS, `%APPDATA%\Microsoft\UserSecrets\<id>\secrets.json` on Windows) — outside the repo, so
they can't be committed. They are **not encrypted**; they're just out of git's reach. They are also
loaded **only** when the environment is `Development` — they're a laptop tool, never a production
secret store.

### The Options pattern — typed and validated

Don't sprinkle `configuration["Smtp:Host"]` strings through your code. Bind a section to a class
and validate it **at startup**, so a missing value crashes the deploy instead of the first
customer's password-reset email at 3 a.m.

```csharp
// SmtpOptions.cs
using System.ComponentModel.DataAnnotations;

public sealed class SmtpOptions
{
    public const string Section = "Smtp";

    [Required] public string Host { get; init; } = "";
    [Range(1, 65535)] public int Port { get; init; } = 587;
    [Required, EmailAddress] public string From { get; init; } = "";
    public string? Password { get; init; }
}

// Program.cs (top-level statements, before app.Run())
builder.Services
    .AddOptions<SmtpOptions>()
    .Bind(builder.Configuration.GetSection(SmtpOptions.Section))
    .ValidateDataAnnotations()
    .ValidateOnStart();                 // fail fast at boot

// EmailSender.cs (usage)
using Microsoft.Extensions.Options;

public sealed class EmailSender(IOptions<SmtpOptions> options)
{
    private readonly SmtpOptions _smtp = options.Value;
}
```

What each piece does:

- **`Bind(...)`** copies matching keys into the properties (case-insensitive, strings converted to
  `int`/`bool`/…). Keys that don't match any property are silently ignored — a typo like
  `"Hots"` just leaves `Host` empty, which is exactly why you validate.
- **`ValidateDataAnnotations()`** checks the attributes. `[Required]` also rejects an empty string,
  so the `= ""` default fails validation when the key is missing.
- **`ValidateOnStart()`** runs that validation while the host starts. Without it, validation runs
  lazily the first time someone reads `.Value` — possibly hours later, in a request.

Three ways to inject options:

| Interface | Lifetime | Sees config changes? | Use for |
|---|---|---|---|
| `IOptions<T>` | singleton | no — value computed once | most settings |
| `IOptionsSnapshot<T>` | scoped (per request) | yes, at the next request | per-request code that should pick up reloads |
| `IOptionsMonitor<T>` | singleton | yes, `CurrentValue` + `OnChange` callback | singletons / background services |

`appsettings*.json` are loaded with `reloadOnChange: true` by the default builder, so editing the
file on disk changes `IConfiguration` immediately — but an `IOptions<T>` you already resolved keeps
the old value. Common mistake: injecting `IOptionsSnapshot<T>` into a singleton — a scoped service
captured by a singleton. In `Development` the DI container's scope validation throws for this; in
`Production` it silently behaves like a value that never refreshes.

:::quiz id=pro-02-q1 xp=10
`appsettings.json` has `"Smtp": { "Host": "localhost" }`. In the container you set the env var
`Smtp__Host=mail.internal`. What does `configuration["Smtp:Host"]` return?
- [ ] `localhost` — JSON files win
- [x] `mail.internal` — environment variables are added after JSON files and override them
- [ ] `null` — the env var should be named `Smtp:Host`
- [ ] It throws because the key is defined twice
> Providers are layered; the last one that defines a key wins. Env vars come after the JSON files, and `__` maps to the `:` separator — `Smtp:Host` as an env var name wouldn't even be valid in most shells. Defining the same key in several providers is the whole point of layering, so nothing throws.
:::

:::quiz id=pro-02-q4 xp=10
`dotnet run` works on your laptop. The same app in a Docker container starts, but sending mail fails
with an SMTP authentication error, and logging shows `SmtpOptions.Password` is `null` — although you
ran `dotnet user-secrets set "Smtp:Password" …`. What's going on?
- [ ] User secrets must be copied into the image with `COPY secrets.json .`
- [x] The container runs as `Production` (no `launchSettings.json`), and user secrets are only a Development-time, laptop-only provider
- [ ] Environment variables in Docker override user secrets with empty values
- [ ] The user-secret key must be written `Smtp__Password`, like an environment variable
> `launchSettings.json` is what made your laptop run as `Development`; in the container `ASPNETCORE_ENVIRONMENT` is unset, so it defaults to `Production`, and user secrets aren't loaded (they live in your home directory anyway, not in the image). The `__` spelling is only for env var names — user secrets use `:` and worked fine locally. Copying `secrets.json` into an image would bake a secret into a layer — never do that. Supply the value the deployment way: an environment variable (`Smtp__Password`) from a secret store, Compose `env_file`, or a Kubernetes Secret.
:::

:::quiz id=pro-02-q5 xp=10
A singleton `EmailSender` takes `IOptions<SmtpOptions>`. While the app is running you change
`Smtp:Host` in `appsettings.json` on disk. What does `EmailSender` see?
- [x] The old host, until the app restarts
- [ ] The new host immediately, because `appsettings.json` reloads on change
- [ ] An exception, because the options are now invalid
- [ ] `null`, because the section was reloaded
> The *configuration* reloads, but `IOptions<T>` computes its value once and caches it for the app's lifetime. To react to changes, inject `IOptionsMonitor<T>` and read `CurrentValue` (or use `IOptionsSnapshot<T>` in scoped code). Nothing throws and nothing becomes `null` — the singleton simply keeps its first copy.
:::

## Configuration in Vite / React

Vite exposes variables from `.env` files through `import.meta.env`, but **only those prefixed
with `VITE_`**:

```bash
# web/.env              (committed defaults, nothing secret)
VITE_API_URL=http://localhost:5000

# web/.env.local        (gitignored, your machine only)
VITE_API_URL=http://localhost:5199

# web/.env.production   (used by `vite build`)
VITE_API_URL=/api
```

```ts
// src/config.ts — one typed place to read env
const apiUrl = import.meta.env.VITE_API_URL
if (!apiUrl) throw new Error('VITE_API_URL is not set')
export const config = { apiUrl, isDev: import.meta.env.DEV } as const
```

```ts
// src/env.d.ts (any .d.ts file under src/) — autocompletion and type checking
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

(The `vite/client` types may already come from `"types": ["vite/client"]` in `tsconfig.app.json`;
the reference line does no harm either way.) Note that the type is a *promise*, not a check —
`VITE_API_URL: string` doesn't make the value exist, which is why `config.ts` checks it at startup.

The **mode** is `development` for `vite` (dev server) and `production` for `vite build`; you can pick
another with `vite build --mode staging`, which then reads `.env.staging`. Load order (later wins):
`.env` < `.env.local` < `.env.[mode]` < `.env.[mode].local`, and variables already set in the shell
beat all files.

:::info title="Which Vite .env files to commit"
Because Vite `.env` files must only ever contain public values, teams commit `.env` and
`.env.[mode]` as documented defaults and ignore `*.local` (the Vite template's `.gitignore` already
does). That's different from a backend or Compose `.env`, which usually holds real secrets — see below.
:::

:::warn title="There are no secrets in a frontend"
`import.meta.env.VITE_*` values are **string-replaced into your JavaScript bundle at build time**.
Anyone can open DevTools → Sources and read them. A `VITE_STRIPE_SECRET_KEY` is a public key now.
Secrets belong on the server; the browser talks to *your* API, and your API holds the key.
Publishable keys designed for browsers (Stripe `pk_…`, a public Sentry DSN, a Maps key restricted
by HTTP referrer) are fine.
:::

**Build-time vs runtime.** Because Vite bakes values in at build time, "build once, deploy many"
needs a trick for the SPA. Common patterns:

- Serve the SPA from the same origin as the API (`VITE_API_URL=/api` + reverse proxy) — then
  there's nothing environment-specific to bake in. Simplest and most common.
- Fetch a small `/config.json` at startup that the container writes from env vars on boot (e.g. an
  nginx entrypoint script running `envsubst`). The app loads it before rendering:

```tsx
// main.tsx — runtime config, same bundle in every environment
const res = await fetch('/config.json')
const runtimeConfig: { apiUrl: string } = await res.json()
createRoot(document.getElementById('root')!).render(<App config={runtimeConfig} />)
```

Either way, it's still public — runtime config changes *when* a value is read, not *who* can read it.

:::quiz id=pro-02-q2 xp=10
Which statements about Vite env variables are true? (select all that apply)
- [x] Only variables starting with `VITE_` are exposed to client code
- [x] Their values end up as plain text in the built JS bundle
- [ ] Putting the variable in `.env.local` keeps it hidden from users of the deployed site
- [ ] Changing an env var on the server running the static files updates the app without a rebuild
> Vite filters by the `VITE_` prefix precisely so that other variables in your shell (like `DATABASE_PASSWORD`) don't leak — and those that pass the filter are pasted into the JS as plain strings. `.env.local` only keeps the value out of *git*; once built, it's in the bundle for everyone. And since replacement happens during `vite build`, changing a server env var does nothing to already-built static files — you'd need a rebuild or a runtime `/config.json`.
:::

## `.env` files and why you don't commit them

A `.env` file is just `KEY=value` lines — a convenient way to feed env vars locally. Node 20.6+ has
`node --env-file=.env`; .NET can use a small loader package; Docker Compose reads it too, with one
catch that bites everyone once:

:::warn title="Compose's .env does not reach your container by itself"
Docker Compose reads the `.env` file next to `compose.yaml` only to **substitute `${VARS}` inside the
compose file**. The container sees a variable only if you pass it — via `environment:` or `env_file:`:

```yaml
services:
  api:
    image: acme/api
    environment:
      ConnectionStrings__Default: ${DB_CONNECTION}   # substituted from .env
    env_file: [api.env]                              # every line becomes a container env var
```
:::

The rules for any `.env` that contains real values:

```gitignore
# .gitignore
.env
.env.*
!.env.example
*.local
```

(In a monorepo with a Vite app, you may re-include its public files explicitly, e.g. `!web/.env` and
`!web/.env.production`.)

- **Commit `.env.example`** with every key and a fake/placeholder value, plus a comment on where to
  get the real one. It's the documentation of what the app needs.
- **Never commit `.env`** with real values. git history is forever: deleting the file in the next
  commit doesn't remove it from history, forks, clones or CI caches.

```bash
# .env.example
DATABASE_URL=postgres://app:app@localhost:5432/app
STRIPE_SECRET_KEY=sk_test_replace_me        # ask in #team-payments / 1Password "Dev" vault
JWT_SIGNING_KEY=generate-with-openssl-rand-base64-32
```

:::quiz id=pro-02-q6 xp=10
Your folder has `compose.yaml` and a `.env` file containing `Smtp__Host=mail.local`. The `api`
service has neither `environment:` nor `env_file:`. What does the app read for `Smtp:Host`?
- [ ] `mail.local` — Compose injects `.env` into every container
- [x] The value from `appsettings.json` — `.env` is only used to substitute `${…}` in `compose.yaml`
- [ ] Nothing — Compose refuses to start because `.env` has an unused variable
- [ ] `mail.local`, but only after `docker compose build`
> The auto-loaded `.env` is for *interpolation in the compose file*, not for the container's environment — a very common misunderstanding. Unused variables are fine, and building has nothing to do with it. Add `env_file: [.env]` or `environment: { Smtp__Host: "${Smtp__Host}" }` to actually pass it in.
:::

### I committed a secret. Now what?

This is the one playbook in this track for a secret that reached git; the Web Security lesson
links back here. Deleting the file in a new commit does **nothing**: the value is still in
history, in every clone and fork, in CI caches, and possibly already in a scraper's database.
Bots scan public GitHub for key formats continuously and often find a fresh key within minutes
(sometimes seconds). Private repos are not safe either: every person and integration with read
access has a copy. So the order is:

1. **Rotate it immediately.** Revoke the leaked key at the provider and issue a new one. This is
   the only step that makes the leaked value worthless, so it comes before anything else.
2. **Update the new value** in the secret store / CI secrets and redeploy, so the app keeps working.
3. **Check the provider's logs for misuse** between the push and the rotation (API calls, logins,
   unexpected cloud resources, a sudden bill).
4. **Tell your team / security contact.** Hiding it is the only truly bad response. Many companies
   have a mandatory reporting channel for exactly this.
5. Then, optionally, **clean history** with `git filter-repo` or BFG and force-push. That's
   cosmetic compared to step 1: clones and forks still have the value.
6. **Write a short blameless postmortem**: how did it get committed, and what stops it next time
   (push protection, a pre-commit hook, a better `.gitignore`)?

Prevention: enable GitHub **secret scanning + push protection** (blocks pushes containing known key
formats), and run a scanner like **gitleaks** in a pre-commit hook and in CI.

:::info title="Git is not the only place secrets leak"
A secret stored perfectly can still leak at runtime, through URLs in access logs, logged request
bodies or exception messages. The **Web Security for Full-Stack Devs** lesson covers those leaks.
:::

:::quiz id=pro-02-q3 xp=10
You notice that `appsettings.Production.json` with the real database password was pushed to `main`
two days ago. What is the **first** thing to do?
- [ ] Delete the file and push a new commit
- [ ] Rewrite history with `git filter-repo` and force-push
- [x] Rotate the database password (and update it wherever the app reads it)
- [ ] Make the repository private
> Removing it from the repo doesn't un-leak it: the old commit is still in history, in every clone and fork, and possibly in CI logs or caches — and you have to assume someone already copied it during those two days. Deleting the file, rewriting history or making the repo private all leave the leaked password valid. Rotation makes the leaked value worthless; cleanup of history is secondary.
:::

## Secret stores

In deployed environments, secrets come from a **secret store** — a service that encrypts them,
controls who can read them and logs every access.

| Store | Typical use |
|---|---|
| **GitHub Actions secrets / environments** | CI/CD: deploy tokens, registry credentials |
| **Azure Key Vault** | Apps on Azure; integrates with `IConfiguration` and managed identity |
| **AWS Secrets Manager / SSM Parameter Store** | Apps on AWS |
| **HashiCorp Vault** | Cloud-agnostic, on-prem; dynamic secrets (per-app DB users created on demand) |
| **Kubernetes Secrets** | Injected as env vars/files into pods — often synced from one of the above |
| **1Password / Bitwarden** | Humans sharing dev credentials |

### Azure Key Vault with ASP.NET Core

```csharp
// dotnet add package Azure.Extensions.AspNetCore.Configuration.Secrets
// dotnet add package Azure.Identity
if (!builder.Environment.IsDevelopment())
{
    var vaultUri = new Uri(builder.Configuration["KeyVault:Uri"]!);
    builder.Configuration.AddAzureKeyVault(vaultUri, new DefaultAzureCredential());
}
```

A Key Vault secret named `Smtp--Password` maps to the key `Smtp:Password` (`--` replaces `:`,
because Key Vault names allow only letters, digits and dashes). Added last, Key Vault overrides the
JSON files — so `appsettings.json` keeps the non-secret `Smtp:Host` and the vault supplies only the
password.

`DefaultAzureCredential` tries a chain of credential sources: the app's **managed identity** in Azure,
your `az login` / Visual Studio login locally — so there is *no* secret needed to fetch secrets. (In
production many teams use `ManagedIdentityCredential` directly: faster startup, and no surprise
fallback to some other identity.) That's the goal everywhere: **workload identity** — the platform
vouches for the running app (managed identity, AWS IAM roles, Kubernetes service accounts, GitHub
OIDC) — instead of a bootstrap password you'd have to store somewhere.

:::warn title="Kubernetes Secrets are base64, not encryption"
`kubectl get secret db -o yaml` shows `cGFzc3dvcmQ=` — that's just `password` encoded. Protect
Secrets with RBAC, enable encryption at rest in etcd, and prefer syncing from a real store
(External Secrets Operator, Secrets Store CSI driver, Sealed Secrets for GitOps).
:::

## Rotating secrets without downtime

Secrets should be rotated regularly (and *immediately* when someone with access leaves or a leak is
suspected). The trick for zero downtime is to **accept two values during the switch**:

1. Create the new secret (new DB password / API key / signing key) alongside the old one.
2. Deploy the app so it **uses the new** one but still **accepts the old** one where relevant
   (e.g. JWT validation accepts tokens signed with either key — `kid` header identifies which).
3. Wait until nothing uses the old one (tokens expired, all pods restarted).
4. Revoke the old one.

Short-lived, automatically issued credentials (Vault dynamic DB users, OIDC tokens, managed
identities) make rotation a non-event — the best secret is the one that expires in an hour.

## Feature flags

A **feature flag** is config that turns behaviour on or off at runtime. It decouples **deploy**
(code is on the server) from **release** (users see it).

Why not just an `if (config["NewCheckout"] == "true")`? For a simple on/off switch, that *is* a feature
flag. Libraries add what you'd otherwise build yourself: percentage rollouts, user/group targeting,
time windows, and the ability to change flags at runtime from a central service without a redeploy.

```csharp
// dotnet add package Microsoft.FeatureManagement.AspNetCore
builder.Services.AddFeatureManagement();   // reads the "FeatureManagement" section from appsettings.json above
// Override per environment like any key: FeatureManagement__NewCheckout=true

app.MapPost("/checkout", async (IFeatureManager features, CheckoutRequest req) =>
    await features.IsEnabledAsync("NewCheckout")
        ? await NewCheckout(req)
        : await LegacyCheckout(req));
```

```tsx
// React: useFlags() is your own hook (or a vendor SDK's) that fetches flags from your API.
// The server decides; the browser only renders — never trust a client-side flag for security.
function CheckoutButton() {
  const { newCheckout } = useFlags()
  return newCheckout ? <NewCheckout /> : <LegacyCheckout />
}
```

Kinds of flags:

- **Release toggles** — merge unfinished work to `main` behind an off flag (trunk-based
  development). Remove once launched.
- **Experiment / A/B** — split users into variants, measure.
- **Ops / kill switches** — turn off an expensive feature during an incident.
- **Permission toggles** — beta features for selected customers / plans.

Rollouts are usually **percentage-based and sticky**: hash the user id into a bucket 0–99 so the
same user always gets the same answer, and enable for bucket < 10 → 10 % of users. Raising the
percentage to 25 keeps those first 10 % enabled (their buckets are still < 25) and adds more. Why not
`Math.random() < 0.1`? Then a user would flip between old and new checkout on every page load. Include
the **flag name** in the hashed key, so the same 10 % of users aren't the guinea pigs for every flag.

:::pro title="Flag debt"
Every flag doubles the code paths to test. Healthy teams give each flag an owner and an expiry,
delete release toggles within weeks of full rollout, and never nest flags inside flags. Tools:
Microsoft.FeatureManagement / Azure App Configuration, Unleash, LaunchDarkly, Flagsmith,
OpenFeature as a vendor-neutral SDK.
:::

:::challenge id=pro-02-c1 lang=ts xp=40
title: Fail-fast config loader
Write `loadConfig(env)` that turns a raw environment (`Record<string, string | undefined>`, like
`process.env`) into a typed config — and **fails fast** with a helpful message.

- `DATABASE_URL` — required string. If missing or empty, throw an `Error` whose message contains `DATABASE_URL`.
- `PORT` — optional, default `8080`; must be an integer 1–65535, else throw with a message containing `PORT`.
- `FEATURE_NEW_CHECKOUT` — optional boolean: `"true"`/`"1"` → `true`, `"false"`/`"0"`/missing → `false`, anything else throws (message contains `FEATURE_NEW_CHECKOUT`).
- `LOG_LEVEL` — one of `debug | info | warn | error`, default `info`; anything else throws (message contains `LOG_LEVEL`).

Return `{ databaseUrl, port, newCheckout, logLevel }`. "Missing" means the key is absent (`undefined`).

Why bother? `Number(undefined)` is `NaN` and `Boolean("false")` is `true` — the starter shows how
naive parsing silently produces nonsense instead of failing.

hint: `Number.isInteger(Number(raw))` checks the port; `Number('abc')` is `NaN` and `Number('80.5')` is not an integer.
hint: Use `env.PORT ?? '8080'` for defaults — `??` only falls back on `undefined`/`null`.
hint: Write a small helper per type: `requireString`, `parseIntInRange`, `parseBool`.

```ts starter
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface AppConfig { databaseUrl: string; port: number; newCheckout: boolean; logLevel: LogLevel }

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    databaseUrl: env.DATABASE_URL as string,
    port: Number(env.PORT),
    newCheckout: Boolean(env.FEATURE_NEW_CHECKOUT),
    logLevel: env.LOG_LEVEL as LogLevel,
  }
}
```

```ts solution
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export interface AppConfig { databaseUrl: string; port: number; newCheckout: boolean; logLevel: LogLevel }

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const rawPort = env.PORT ?? '8080'
  const port = Number(rawPort)
  if (rawPort.trim() === '' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer 1-65535, got "${rawPort}"`)
  }

  const rawFlag = (env.FEATURE_NEW_CHECKOUT ?? 'false').toLowerCase()
  let newCheckout: boolean
  if (rawFlag === 'true' || rawFlag === '1') newCheckout = true
  else if (rawFlag === 'false' || rawFlag === '0') newCheckout = false
  else throw new Error(`FEATURE_NEW_CHECKOUT must be true/false/1/0, got "${env.FEATURE_NEW_CHECKOUT}"`)

  const logLevel = (env.LOG_LEVEL ?? 'info') as LogLevel
  if (!LEVELS.includes(logLevel)) throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}`)

  return { databaseUrl, port, newCheckout, logLevel }
}
```

```ts tests
const base = { DATABASE_URL: 'postgres://app@db/app' }

test('applies defaults', () => {
  expect(loadConfig(base)).toEqual({ databaseUrl: 'postgres://app@db/app', port: 8080, newCheckout: false, logLevel: 'info' })
})
test('reads all values', () => {
  expect(loadConfig({ ...base, PORT: '5000', FEATURE_NEW_CHECKOUT: 'true', LOG_LEVEL: 'debug' }))
    .toEqual({ databaseUrl: 'postgres://app@db/app', port: 5000, newCheckout: true, logLevel: 'debug' })
})
test('"0" and "false" are false, "1" is true', () => {
  expect(loadConfig({ ...base, FEATURE_NEW_CHECKOUT: '0' }).newCheckout).toBe(false)
  expect(loadConfig({ ...base, FEATURE_NEW_CHECKOUT: 'false' }).newCheckout).toBe(false)
  expect(loadConfig({ ...base, FEATURE_NEW_CHECKOUT: '1' }).newCheckout).toBe(true)
})
test('missing DATABASE_URL fails fast', () => {
  expect(() => loadConfig({})).toThrow('DATABASE_URL')
  expect(() => loadConfig({ DATABASE_URL: '' })).toThrow('DATABASE_URL')
})
test('invalid PORT fails fast', () => {
  expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow('PORT')
  expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow('PORT')
  expect(() => loadConfig({ ...base, PORT: '80.5' })).toThrow('PORT')
})
test('invalid flag value fails fast', () => {
  expect(() => loadConfig({ ...base, FEATURE_NEW_CHECKOUT: 'yes please' })).toThrow('FEATURE_NEW_CHECKOUT')
})
test('invalid LOG_LEVEL fails fast', () => {
  expect(() => loadConfig({ ...base, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL')
})
```
:::

:::challenge id=pro-02-c2 lang=ts xp=40
title: Sticky percentage rollout
Implement `isEnabled(flag, userId)` for a flag `{ name, enabled, percentage, allowList }`:

- `enabled: false` → always `false` (kill switch beats everything).
- A user in `allowList` → always `true` (when enabled).
- Otherwise compute a **bucket** 0–99 from `bucket(flag.name + ':' + userId)` (provided in setup) and
  return `true` when `bucket < percentage`.

The same user must always get the same answer, `percentage: 0` means nobody (except the allow list),
`100` means everybody.

hint: Check in this order: kill switch, allow list, then the bucket.
hint: The setup's `bucket` is deterministic — call it with `` `${flag.name}:${userId}` `` and compare with `percentage` using `<`.

```ts setup
// Deterministic 0-99 bucket from a string (FNV-1a hash).
function bucket(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 100
}
interface Flag { name: string; enabled: boolean; percentage: number; allowList: string[] }
```

```ts starter
export function isEnabled(flag: Flag, userId: string): boolean {
  return Math.random() * 100 < flag.percentage
}
```

```ts solution
export function isEnabled(flag: Flag, userId: string): boolean {
  if (!flag.enabled) return false
  if (flag.allowList.includes(userId)) return true
  return bucket(`${flag.name}:${userId}`) < flag.percentage
}
```

```ts tests
const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`)
const flag = (p: number, extra: Partial<Flag> = {}): Flag => ({ name: 'new-checkout', enabled: true, percentage: p, allowList: [], ...extra })

test('kill switch wins', () => {
  expect(isEnabled(flag(100, { enabled: false, allowList: ['ada'] }), 'ada')).toBe(false)
})
test('allow list always on', () => {
  expect(isEnabled(flag(0, { allowList: ['ada'] }), 'ada')).toBe(true)
})
test('0% is nobody, 100% is everybody', () => {
  expect(users.some((u) => isEnabled(flag(0), u))).toBe(false)
  expect(users.every((u) => isEnabled(flag(100), u))).toBe(true)
})
test('sticky: same answer every time', () => {
  for (const u of users.slice(0, 50)) {
    const first = isEnabled(flag(30), u)
    for (let i = 0; i < 5; i++) expect(isEnabled(flag(30), u)).toBe(first)
  }
})
test('matches the bucket exactly', () => {
  for (const u of users.slice(0, 100)) expect(isEnabled(flag(25), u)).toBe(bucket(`new-checkout:${u}`) < 25)
})
test('roughly the right share', () => {
  const on = users.filter((u) => isEnabled(flag(20), u)).length
  expect(on).toBeGreaterThan(120)
  expect(on).toBeLessThan(280)
})
```
:::

:::lab id=pro-02-lab1 xp=80
title: Typed, validated config in an ASP.NET Core API
In any ASP.NET Core 10 API:

```bash
dotnet new webapi -n ConfigLab
cd ConfigLab
dotnet new gitignore     # the webapi template ships no .gitignore; this one ignores bin/ and obj/
git init
```


1. Add an `Smtp` section to `appsettings.json` with `Host`, `Port` and `From` — no password:
   `"Smtp": { "Host": "localhost", "Port": 1025, "From": "noreply@example.com" }`.
2. Create `SmtpOptions.cs` with the class from this lesson (including its
   `using System.ComponentModel.DataAnnotations;`). Give it its own file, or put it *below*
   `app.Run()` in `Program.cs` — a type declared above the top-level statements is error CS8803.
   Register it in `Program.cs`, before `builder.Build()`:

   ```csharp
   builder.Services.AddOptions<SmtpOptions>()
       .Bind(builder.Configuration.GetSection(SmtpOptions.Section))
       .ValidateDataAnnotations()
       .ValidateOnStart();
   ```

3. Store the password outside the repo:

   ```bash
   dotnet user-secrets init
   dotnet user-secrets set "Smtp:Password" "dev-only"
   ```

4. Add a debug endpoint, mapped only in Development (add `using Microsoft.Extensions.Options;`):

   ```csharp
   if (app.Environment.IsDevelopment())
   {
       app.MapGet("/debug/smtp", (IOptions<SmtpOptions> o) =>
           new { o.Value.Host, o.Value.Port, HasPassword = o.Value.Password is not null });
   }
   ```

   `dotnet run`, then call it (use the port `dotnet run` prints):

   ```bash
   curl http://localhost:5000/debug/smtp
   # {"host":"localhost","port":1025,"hasPassword":true}
   ```

5. Override the host from the shell without touching any file, and call the endpoint again:

   ```bash
   Smtp__Host=override.local dotnet run            # PowerShell: $env:Smtp__Host="override.local"; dotnet run
   # → {"host":"override.local","port":1025,"hasPassword":true}
   ```

6. Break it: set `"Port": 0` in `appsettings.json` and `dotnet run` again. The app must refuse to start
   with something like:

   ```text
   Microsoft.Extensions.Options.OptionsValidationException: DataAnnotation validation failed for
   'SmtpOptions' members: 'Port' with the error: 'The field Port must be between 1 and 65535.'.
   ```

   Set the port back to `1025`.
7. Append the `.env` rules from this lesson to the generated `.gitignore`, create a `.env.example`
   documenting the keys (`Smtp__Host=`, `Smtp__Password=` with a "where to get it" comment). Run
   `git status` *before* `git add .` — you should see source files, `.gitignore` and `.env.example`,
   but no `bin/`, `obj/` or `.env` — then commit.

- [ ] `/debug/smtp` shows values from `appsettings.json`, and `HasPassword` is `true` via user secrets
- [ ] `Smtp__Host=override.local` overrides the JSON value without touching any file
- [ ] With `Port: 0` the app refuses to start with an `OptionsValidationException`
- [ ] `git status` never shows a file containing the password
- [ ] A committed `.env.example` lists every required key with placeholder values
:::

:::cards id=pro-02-cards1 xp=15 title="Config & secrets"
Q: What is "config" in 12-factor terms?
A: Everything that varies between deploys (URLs, credentials, switches). It lives in the environment, not the code.
Q: Why "build once, deploy many"?
A: The artifact you tested in staging is exactly what runs in prod; only injected config differs.
Q: ASP.NET Core config precedence (low → high)?
A: appsettings.json → appsettings.{Env}.json → User Secrets (Development) → environment variables → command line.
Q: How do you write `Smtp:Host` as an environment variable?
A: `Smtp__Host` (double underscore).
Q: What does `ValidateOnStart()` buy you?
A: Invalid or missing options crash the app at boot instead of at first use in production.
Q: Can a Vite app keep a secret in `VITE_*`?
A: No. VITE_ values are inlined into the public bundle at build time.
Q: First step after leaking a secret in git?
A: Rotate/revoke it. History cleanup is secondary.
Q: Are Kubernetes Secrets encrypted?
A: Only base64-encoded by default. Use RBAC, etcd encryption at rest, or sync from a real secret store.
Q: How does `DefaultAzureCredential` avoid a bootstrap secret?
A: It uses managed identity in Azure and your developer login locally.
Q: Does Docker Compose pass `.env` into containers automatically?
A: No. It uses `.env` to substitute `${VARS}` in compose.yaml; pass values to the container with `environment:` or `env_file:`.
Q: Why is my app `Development` with `dotnet run` but `Production` in Docker?
A: `launchSettings.json` sets `ASPNETCORE_ENVIRONMENT` only for `dotnet run`/IDEs; elsewhere it defaults to Production.
Q: IOptions vs IOptionsSnapshot vs IOptionsMonitor?
A: IOptions = singleton, read once. IOptionsSnapshot = scoped, re-read per request. IOptionsMonitor = singleton with CurrentValue + change notifications.
Q: Zero-downtime rotation idea?
A: Run old and new secret side by side (accept both), switch users to the new one, then revoke the old one.
Q: Deploy vs release with feature flags?
A: Deploy = code is on the servers (flag off). Release = flip the flag for users, gradually and reversibly.
Q: Why must percentage rollouts be sticky?
A: A user must see a consistent experience; hash the user id into a fixed bucket instead of using random numbers.
:::

## Recap

- Config = what varies per deploy; keep it out of code and inject it from the environment. Build once, deploy many.
- ASP.NET Core layers JSON → env-specific JSON → user secrets → env vars (`__`) → CLI args; bind to typed Options and `ValidateOnStart()`.
- `launchSettings.json` makes `dotnet run` Development; deployed apps default to Production, where user secrets don't exist.
- Vite only exposes `VITE_*` values and inlines them into the bundle — frontends cannot hold secrets.
- Commit `.env.example`, never a `.env` with real values; Compose's `.env` only fills `${VARS}` in the compose file. Enable secret scanning and push protection.
- Leaked a secret? Rotate first, clean history later, tell the team.
- Deployed secrets come from a store (Key Vault, Vault, Secrets Manager) via workload identity; K8s Secrets are only base64.
- Feature flags separate deploy from release — make rollouts sticky and delete flags when done.
