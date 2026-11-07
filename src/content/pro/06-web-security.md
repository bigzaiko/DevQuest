---
id: pro-03
title: Web Security for Full-Stack Devs
level: advanced
minutes: 90
xp: 200
summary: The OWASP Top 10 through a React + ASP.NET Core + Postgres lens — injection, XSS, CSRF, IDOR, auth, headers, CORS, dependencies and secrets that leak through URLs and logs.
---

Security is not a separate job done by "the security team" at the end. On a real product team,
**every pull request is a security decision**: a new endpoint, a new query, a new npm package, a
new environment variable. Most breaches are not clever zero-days — they are an endpoint that
forgot to check who owns the record, a string-concatenated SQL query, or an API key pushed to a
public repo.

This lesson walks through the risks you will actually meet as a full-stack developer, with the
**exact code** that causes them and the exact code that fixes them.

## The mindset: trust boundaries

Draw a line around everything **you** control: your API process, your database, your secrets.
Everything outside that line — the browser, the request body, headers, query strings, cookies,
uploaded files, webhooks, even data from a "trusted" partner API — is **untrusted input**.

| Rule | Means in practice |
|---|---|
| Never trust the client | The React app hiding a button is UX, not security. The API must re-check everything. |
| Validate input, encode output | Validate shape on the way **in** (types, lengths, allowlists); encode for the context on the way **out** (HTML, SQL, URL, shell). |
| Least privilege | The DB user your API uses should not be a superuser. The CI token should not be able to delete repos. |
| Defense in depth | Several layers: parameterized queries **and** a least-privilege DB user **and** a WAF. One layer failing is not a breach. |
| Fail closed | If the permission check throws, deny. Default to "no". |

:::job title="What you'll meet on day one"
Most teams have a **security checklist in the PR template** ("Does this endpoint check
authorization? Does it log PII?"), automated scanners in CI (Dependabot, CodeQL, secret
scanning), and a yearly pentest. Your job is not to be a pentester — it's to not ship the
obvious mistakes, and to recognise them in code review.
:::

## The OWASP Top 10, mapped to our stack

The [OWASP Top 10](https://owasp.org/www-project-top-ten/) is the industry's shared vocabulary for
web risks — the words auditors, pentesters and security tools use. The list is refreshed every few
years based on real breach data. The 2021 edition is still quoted everywhere; the 2025 edition
(order below) reshuffled it, folded SSRF into broken access control and added "mishandling of
exceptional conditions". Names shift, the classics stay:

| # (2025) | Risk | Typical full-stack example |
|---|---|---|
| 1 | **Broken access control** (incl. SSRF) | `GET /api/invoices/1043` returns someone else's invoice (IDOR); `?url=http://169.254.169.254/…` makes your server fetch cloud credentials |
| 2 | **Security misconfiguration** | Developer exception page in production, permissive CORS, default passwords |
| 3 | **Software supply chain failures** | An npm package with a known RCE, a typosquatted package, a hijacked GitHub Action |
| 4 | **Cryptographic failures** | Passwords hashed with SHA-256, HTTP instead of HTTPS, secrets in plain text |
| 5 | **Injection** | `"SELECT … WHERE email = '" + email + "'"`, XSS via `innerHTML` |
| 6 | **Insecure design** | Password reset tokens that never expire, no rate limit on login |
| 7 | **Authentication failures** | Weak sessions, JWTs without expiry checks, no MFA for admins |
| 8 | **Software or data integrity failures** | Unsigned auto-updates, CI that runs untrusted PR code with secrets |
| 9 | **Logging & alerting failures** | Nobody notices 50 000 failed logins at 3 a.m. |
| 10 | **Mishandling of exceptional conditions** | A permission check that throws and the `catch` lets the request through ("fail open"); stack traces in error responses |

Don't memorise the numbers — memorise the *patterns*.

The rest of this lesson is **ten things to check in every review**, in the order you meet them in
code — *not* the OWASP order, and not all of them are OWASP categories in their own right. XSS is
a form of **Injection** (A05); CSRF and a too-loose CORS policy end up under **Broken access
control** (A01) or **Security misconfiguration** (A02). Each section names the category it maps to,
so you can still talk to an auditor in their vocabulary.

## Injection — SQL and friends

*OWASP: Injection (A05).*

Injection happens when **data is interpreted as code**. The attacker's input crosses from "a
value" into "part of the command".

```csharp
// ❌ The attacker sends email = "' OR 1=1 --"
var sql = "SELECT * FROM users WHERE email = '" + email + "'";
// → SELECT * FROM users WHERE email = '' OR 1=1 --'   (every user!)
```

Walk through it: the attacker's `'` closes your string literal early, `OR 1=1` makes the condition
true for every row, and `--` starts an SQL comment that swallows your trailing `'`. The database
can't tell which characters you wrote and which the attacker wrote — it just sees one SQL string.

The fix is always the same: **parameters** (also called *prepared statements* or *bind
variables*). The SQL text and the values travel **separately** to PostgreSQL: first "here is the
query with a placeholder", then "here is the value for placeholder 1". The value is never parsed
as SQL, so `' OR 1=1 --` is just a strange-looking email address that matches nobody.

:::warn title="Escaping quotes yourself is not the fix"
`email.Replace("'", "''")` looks like it works and is a classic code-review red flag. It misses
edge cases (encodings, numeric contexts with no quotes, backslash settings) and has to be
remembered at every call site. Parameters are correct by construction.
:::

```csharp
// ✅ Npgsql / ADO.NET
await using var cmd = new NpgsqlCommand("SELECT * FROM users WHERE email = @email", conn);
cmd.Parameters.AddWithValue("email", email);

// ✅ Dapper
var user = await conn.QuerySingleOrDefaultAsync<User>(
    "SELECT * FROM users WHERE email = @Email", new { Email = email });

// ✅ EF Core LINQ — always parameterized
var user = await db.Users.SingleOrDefaultAsync(u => u.Email == email);
```

EF Core has one famous trap. These two lines look almost identical:

```csharp
// ✅ FromSql takes a FormattableString: {email} becomes a real @p0 parameter
var a = db.Users.FromSql($"SELECT * FROM users WHERE email = {email}");

// ❌ FromSqlRaw + $"..." builds the string FIRST, then sends it → injection
var b = db.Users.FromSqlRaw($"SELECT * FROM users WHERE email = '{email}'");
```

Why the difference? `FromSql` accepts a `FormattableString`, which keeps the template and the
values *apart* until EF Core sees them — EF turns every `{hole}` into a parameter. `FromSqlRaw`
accepts a plain `string`; by the time it runs, C# has already pasted the value into the text. The
same pair exists for commands: `ExecuteSql` (safe) vs `ExecuteSqlRaw` (only with parameters you
pass explicitly). Recent EF Core versions ship an analyzer warning (EF1002) for interpolation
passed to the `Raw` methods — treat it as an error.

:::warn title="You can't parameterize identifiers"
Parameters work for **values**, not for table names, column names or `ASC`/`DESC`. A "sort by"
query string (`?sort=name`) must go through an **allowlist** that maps user input to a fixed set of
known-good SQL fragments. You'll build one below.
:::

Injection is not only SQL. The same idea applies to shell commands (`Process.Start("sh", "-c " +
input)` — pass arguments via `ProcessStartInfo.ArgumentList` instead), LDAP, file paths
(`../../etc/passwd` — path traversal; resolve with `Path.GetFullPath` and check the result is
still inside your upload folder), and HTML (that's XSS, next section).

:::quiz id=pro-03-q6 xp=15
Spot the injectable line. `email` comes from the request body. (select all that apply)
```csharp
// A
db.Users.FromSql($"SELECT * FROM users WHERE email = {email}");
// B
db.Users.FromSqlRaw($"SELECT * FROM users WHERE email = '{email}'");
// C
db.Users.FromSqlRaw("SELECT * FROM users WHERE email = {0}", email);
// D
db.Database.ExecuteSqlRaw("DELETE FROM sessions WHERE email = '" + email + "'");
```
- [ ] A
- [x] B
- [ ] C
- [x] D
> **B** and **D** build the final SQL string in C# before EF Core sees it, so the value becomes
> SQL. **A** looks dangerous because of the `$`, but `FromSql` receives a `FormattableString` and
> turns `{email}` into a parameter. **C** is the explicit-parameter form of `FromSqlRaw`: `{0}` is
> a placeholder EF Core replaces with a real parameter, not string formatting.
:::

:::challenge id=pro-03-c1 lang=ts xp=40
title: Safe ORDER BY with an allowlist
Your API accepts `?sort=field:dir` (e.g. `price:asc`). Write `sortClause(sort)` that returns a
SQL `ORDER BY` fragment **only from an allowlist**:

| user field | SQL column |
|---|---|
| `name` | `name` |
| `price` | `price` |
| `created` | `created_at` |

* `dir` is `asc` or `desc` (case-insensitive) → `ASC` / `DESC`. Missing dir (`?sort=name`) → `ASC`.
  The field name itself is case-sensitive: only the exact keys above are valid.
* Anything unknown, missing (`undefined` or `''`) or malformed (an unknown direction, more than one
  `:`) → the default `ORDER BY created_at DESC`.
* User input must **never** appear in the output — only strings from your own table.

hint: Build a `Record<string, string>` from user field to column and look the field up — never concatenate the input itself.
hint: Split on `:`; if you get more than two parts, it's malformed. Lower-case the direction before comparing.
hint: Watch out for `toString` or `__proto__` as field names: `'toString' in obj` is `true` for every object. Use `Object.hasOwn(COLUMNS, field)`.

```ts starter
export function sortClause(sort: string | undefined): string {
  if (!sort) return 'ORDER BY created_at DESC'
  const [field, dir] = sort.split(':')
  return `ORDER BY ${field} ${dir ?? 'ASC'}`
}
```

```ts solution
const COLUMNS: Record<string, string> = { name: 'name', price: 'price', created: 'created_at' }
const DEFAULT_SORT = 'ORDER BY created_at DESC'

export function sortClause(sort: string | undefined): string {
  if (!sort) return DEFAULT_SORT
  const parts = sort.split(':')
  if (parts.length > 2) return DEFAULT_SORT
  const [field, rawDir] = parts
  if (!Object.hasOwn(COLUMNS, field)) return DEFAULT_SORT
  const dir = rawDir === undefined ? 'asc' : rawDir.toLowerCase()
  if (dir !== 'asc' && dir !== 'desc') return DEFAULT_SORT
  return `ORDER BY ${COLUMNS[field]} ${dir.toUpperCase()}`
}
```

```ts tests
test('maps fields to columns', () => {
  expect(sortClause('price:asc')).toBe('ORDER BY price ASC')
  expect(sortClause('created:desc')).toBe('ORDER BY created_at DESC')
  expect(sortClause('name:DESC')).toBe('ORDER BY name DESC')
})
test('missing direction defaults to ASC', () => {
  expect(sortClause('name')).toBe('ORDER BY name ASC')
})
test('missing or unknown input uses the default', () => {
  expect(sortClause(undefined)).toBe('ORDER BY created_at DESC')
  expect(sortClause('')).toBe('ORDER BY created_at DESC')
  expect(sortClause('password_hash:asc')).toBe('ORDER BY created_at DESC')
  expect(sortClause('toString:asc')).toBe('ORDER BY created_at DESC')
})
test('injection attempts never reach the output', () => {
  expect(sortClause('name; DROP TABLE users --')).toBe('ORDER BY created_at DESC')
  expect(sortClause('price:asc; DELETE FROM orders')).toBe('ORDER BY created_at DESC')
  expect(sortClause('price:asc:extra')).toBe('ORDER BY created_at DESC')
})
```
:::

## Cross-site scripting (XSS)

*OWASP: Injection (A05), into HTML.*

XSS is injection into **HTML**: the attacker gets their JavaScript to run in another user's
browser, on your origin. From there it can read the page, call your API **as the victim**, and
steal any token stored in `localStorage`.

| Kind | How it arrives |
|---|---|
| **Stored** | A comment containing `<img src=x onerror=…>` is saved and shown to every visitor |
| **Reflected** | `/search?q=<script>…</script>` is echoed into the page by the server |
| **DOM-based** | Client JS reads `location.hash` and writes it with `innerHTML` |

Why is "runs on your origin" so bad? The browser's security model trusts all JavaScript on
`https://app.example.com` equally. An injected script is indistinguishable from your own bundle:
it can `fetch('/api/…')` with the user's cookies, read the DOM (including CSRF tokens) and
`localStorage`, and send it all to `evil.example`.

**React protects you by default**: `{comment.text}` in JSX is rendered as a text node, so
`<script>` shows up as literal characters. You lose that protection the moment you step around it:

```tsx
// ❌ All of these execute attacker input
<div dangerouslySetInnerHTML={{ __html: comment.html }} />
el.innerHTML = location.hash.slice(1)
window.location.href = params.get('next')!  // next = "javascript:fetch('/api/me')…"
new Function(userFormula)()

// ⚠️ React 19 blocks this specific case, but don't rely on it
<a href={user.website}>site</a>             // website = "javascript:…"

// ✅ Safer alternatives
<div>{comment.text}</div>                                   // escaped by React
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />  // sanitize rich HTML
const safeHref = /^https?:\/\//i.test(url) ? url : '#'      // allowlist URL schemes
```

About that `href`: React 19 replaces `javascript:` URLs in `href`/`src`/`action` with a stub that
throws instead of running. That's a nice safety net, not a policy — it doesn't cover URLs you use
outside JSX (`window.location`, `window.open`, server-rendered emails), other schemes like `data:`,
or the phishing risk of linking to any attacker-chosen site. **Allowlist the schemes you expect**
(`https:`, maybe `mailto:`) wherever user-supplied URLs are used.

The defence has three layers:

1. **Encode output for its context** — HTML body, HTML attribute, URL, JS string and CSS each need
   different escaping. Frameworks (React, Razor) do the HTML cases for you.
2. **Sanitize** when you genuinely must render user HTML (rich-text editors, Markdown) — use a
   battle-tested library like DOMPurify, never a home-made regex.
3. **Content Security Policy** (CSP) as a safety net — a header that tells the browser which
   scripts are allowed to run at all. With `script-src 'self'`, an injected inline `<script>` or
   `onerror=` handler is refused because it didn't come from a file on your origin.

:::quiz id=pro-03-q7 xp=15
A comment renders like this. An attacker saves the comment text `<img src=x onerror=alert(1)>`.
What happens when another user views it?
```tsx
function Comment({ text }: { text: string }) {
  return <p className="comment">{text}</p>
}
```
- [x] The literal characters `<img src=x onerror=alert(1)>` are shown; nothing runs
- [ ] A broken image appears and `alert(1)` runs
- [ ] React throws an error because the string contains HTML
- [ ] It's safe only if the API sanitized the text before saving it
> `{text}` in JSX becomes a **text node**, so the browser never parses it as HTML — no `<img>`
> element exists, so no `onerror` can fire. The attack works only if you render it with
> `dangerouslySetInnerHTML` or `innerHTML`. Server-side sanitizing is not *required* here; in
> fact, encoding on **output** for the right context is the main defence, which React does for you.
:::

:::challenge id=pro-03-c2 lang=ts xp=35
title: Escape HTML
Server-side templates, emails and legacy code paths sometimes build HTML strings by hand. Write
`escapeHtml(s)` that makes any string safe to put **inside an HTML element or a quoted attribute**.

Replace `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`.

hint: A single `replace` with a character class and a lookup object: `s.replace(/[&<>"']/g, (c) => MAP[c])`.
hint: If you chain several `replace` calls, `&` must be escaped **first** — otherwise `&lt;` becomes `&amp;lt;`.

```ts starter
export function escapeHtml(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
```

```ts solution
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}
```

```ts tests
test('plain text is unchanged', () => {
  expect(escapeHtml('Hello, world')).toBe('Hello, world')
  expect(escapeHtml('')).toBe('')
})
test('escapes a script tag', () => {
  expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
})
test('escapes quotes so attributes cannot be broken out of', () => {
  expect(escapeHtml(`" onmouseover="alert(1)`)).toBe('&quot; onmouseover=&quot;alert(1)')
  expect(escapeHtml("it's")).toBe('it&#39;s')
})
test('escapes ampersands exactly once', () => {
  expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry')
  expect(escapeHtml('&lt;')).toBe('&amp;lt;')
  expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;')
})
```
:::

## Cross-site request forgery (CSRF)

*OWASP: Broken access control (A01).*

Browsers **automatically attach cookies** to requests to your domain — even when the request is
triggered by `evil.example` (a hidden form auto-submitting to `https://bank.example/transfer`).
If your API authenticates with cookies and changes state on that request, the attacker has just
acted as your user without ever seeing the cookie.

Note the difference from XSS: in CSRF the attacker's code runs on **their** site and can't read
your responses — it can only *fire* a request and hope the side effect happens. That's why CSRF
targets state changes (transfer, change email, delete), not data theft.

Defences, from most to least important today:

- **`SameSite` cookies.** The attribute tells the browser when to attach a cookie to a request
  that comes from *another site*. `SameSite=Lax` sends it on top-level link navigations but not on
  cross-site POSTs, `fetch` calls or `<img>`/`<iframe>` loads; `Strict` never sends it
  cross-site (users arriving via a link from email look logged out on the first page). Chromium
  defaults cookies *without* the attribute to `Lax`; other browsers (Firefox, Safari) don't, so
  don't rely on it: always set `SameSite` explicitly, plus `Secure` and `HttpOnly` for session
  cookies.
- **Never change state on GET.** `GET /api/account/delete` can be triggered by an `<img>` tag, and
  `Lax` cookies *are* sent on top-level GET navigations.
- **Anti-forgery tokens** for cookie-authenticated endpoints: a random value the attacker's page
  can't know, sent in a form field or header and checked by the server. ASP.NET Core has this built
  in: `builder.Services.AddAntiforgery()` + `app.UseAntiforgery()`. Razor/Blazor forms include the
  token automatically, and minimal API endpoints that bind form data (`[FromForm]`, `IFormFile`)
  are validated automatically. For a SPA that posts JSON with a cookie, you send the token in a
  header (configure `o.HeaderName = "X-XSRF-TOKEN"`) and validate it with
  `IAntiforgery.ValidateRequestAsync` (or a small endpoint filter).
- **Check `Origin`** on state-changing requests as an extra layer.

:::warn title="'Site' is not 'origin'"
`SameSite` compares *sites* (scheme + registrable domain), not full origins.
`https://blog.example.com` and `https://app.example.com` are the **same site**, so a compromised or
user-content subdomain can still send your `Lax` cookies. Host user uploads on a separate domain
(e.g. `example-usercontent.com`), as Google and GitHub do.
:::

```csharp
builder.Services.ConfigureApplicationCookie(o =>
{
    o.Cookie.HttpOnly = true;                       // JS can't read it → XSS can't steal it
    o.Cookie.SecurePolicy = CookieSecurePolicy.Always;
    o.Cookie.SameSite = SameSiteMode.Lax;           // or Strict
    o.ExpireTimeSpan = TimeSpan.FromHours(8);
    o.SlidingExpiration = true;
});
```

:::pro title="Cookies vs bearer tokens in a SPA"
A JWT sent in an `Authorization: Bearer …` header is **not** vulnerable to CSRF (the browser never
adds it automatically) — but if you store it in `localStorage`, any XSS can read and exfiltrate
it. An `HttpOnly` cookie can't be read by JS but needs CSRF protection. Many teams settle on the
**BFF pattern** (Backend-for-Frontend): the SPA talks to its own backend with a `SameSite`
`HttpOnly` session cookie, and the backend holds the real access tokens.
:::

:::quiz id=pro-03-q1 xp=15
Your React SPA stores the JWT access token in `localStorage` and sends it as a bearer header. Which statements are true? (select all that apply)
- [x] CSRF is not the main risk, because the browser won't attach the header automatically
- [x] Any XSS on your origin can read the token and send it to an attacker
- [ ] `SameSite=Strict` would protect the token
- [x] Short token lifetimes limit the damage of a stolen token
> CSRF relies on the browser attaching credentials **automatically**; a header your own code adds
> is never attached to a request from `evil.example`. But anything in `localStorage` is readable by
> every script on your origin, so one XSS bug leaks the token. The tempting wrong answer is
> `SameSite`: it's a **cookie** attribute and does nothing for `localStorage`. That's why
> short-lived tokens, a strict CSP or the BFF cookie pattern matter.
:::

## Broken access control and IDOR

*OWASP: Broken access control (A01).*

This is the **number one** web risk, and the one you are most likely to write yourself — because
nothing crashes. The code works perfectly for honest users; it just also works for dishonest ones.
*Authentication* answers "who are you?". *Authorization* answers "are you allowed to do **this** to
**this** record?". IDOR (Insecure Direct Object Reference) is the classic failure: the endpoint
checks that you're logged in, but not that the object is yours. The attacker doesn't need any
tooling — they change `1043` to `1044` in the URL.

```csharp
// ❌ Any logged-in user can rename ANY project by guessing/iterating ids
app.MapPut("/api/projects/{id:guid}", async (Guid id, RenameProject dto, AppDb db) =>
{
    var project = await db.Projects.FindAsync(id);
    if (project is null) return Results.NotFound();
    project.Name = dto.Name;
    await db.SaveChangesAsync();
    return Results.NoContent();
}).RequireAuthorization();
```

`RequireAuthorization()` only proves the caller has *a* valid login. The fix: **scope the query
to what the caller may touch**, on every single request.

```csharp
// ✅ Ownership is part of the query itself
app.MapPut("/api/projects/{id:guid}", async (Guid id, RenameProject dto, AppDb db, ClaimsPrincipal user) =>
{
    var userId = Guid.Parse(user.FindFirstValue(ClaimTypes.NameIdentifier)!);

    var project = await db.Projects
        .Where(p => p.Id == id)
        .Where(p => p.OwnerId == userId
                 || p.Members.Any(m => m.UserId == userId && m.Access == Access.Editor))
        .SingleOrDefaultAsync();

    if (project is null) return Results.NotFound();   // 404: don't even confirm it exists
    project.Name = dto.Name;
    await db.SaveChangesAsync();
    return Results.NoContent();
}).RequireAuthorization();
```

For richer rules, ASP.NET Core has **resource-based authorization**: load the resource, then ask
the authorization service whether this user may perform this operation on it.

```csharp
public sealed class EditProjectRequirement : IAuthorizationRequirement { }

public sealed class EditProjectHandler : AuthorizationHandler<EditProjectRequirement, Project>
{
    protected override Task HandleRequirementAsync(
        AuthorizationHandlerContext ctx, EditProjectRequirement req, Project project)
    {
        var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is not null && project.CanBeEditedBy(Guid.Parse(userId)))
            ctx.Succeed(req);
        return Task.CompletedTask;   // not calling Succeed = denied (fail closed)
    }
}

// Program.cs
builder.Services.AddSingleton<IAuthorizationHandler, EditProjectHandler>();

// in the endpoint (inject IAuthorizationService authz)
var result = await authz.AuthorizeAsync(user, project, new EditProjectRequirement());
if (!result.Succeeded) return Results.Forbid();   // 403 (or NotFound() to hide existence)
```

The benefit over inline `if`s: the rule lives in **one** place, is unit-testable, and every
endpoint that edits a project asks the same question.

:::info title="In the capstone"
The project / owner / editor / viewer model used in this section is the one **BranchStory** uses.
In the Capstone's **API Foundation** lesson you implement exactly this resource-based handler
for it, with integration tests that call endpoints as the wrong user.
:::

Other access-control failures to watch for in review:

- **Multi-tenancy leaks** — every query in a SaaS must filter by tenant. EF Core **global query
  filters** (`modelBuilder.Entity<Project>().HasQueryFilter(p => p.TenantId == _tenant.Id)`) make
  that the default rather than something you remember.
- **Mass assignment / over-posting** — binding the request body straight into your entity lets a
  client send `"ownerId": "…"` or `"isAdmin": true`. Bind to a **DTO** with only the editable fields.
- **Admin-only endpoints** guarded only by hiding the menu item in React.
- **Sequential ids** make IDOR trivial to exploit — but GUIDs are *not* a fix, only an obstacle.
  The check is the fix.

:::job title="The code review question"
For every new endpoint, reviewers ask: **"What stops user A from calling this with user B's id?"**
If the answer is "the frontend doesn't show that button", it's a bug. Write an integration test
that calls the endpoint as the wrong user and expects 403/404 — it's the cheapest insurance there is.
:::

:::challenge id=pro-03-c3 lang=ts xp=50
title: An IDOR-safe `canEdit(user, project)`
Your team centralises the rule "may this user edit this project?" in one pure function that both
the API handler and the UI use. The current version has bugs found in a pentest. Fix it so these
rules hold, **in this order**:

1. A user from a **different organisation** can never edit (tenant isolation — not even admins).
2. An **admin** of the same organisation can always edit (even archived projects).
3. **Archived** projects can't be edited by anyone else.
4. The **owner** can edit.
5. A project member with `access: 'editor'` can edit. `viewer`s cannot.
6. Everyone else: no.

hint: Write it as a series of guard clauses (`if (...) return false/true`) in exactly the rule order.
hint: `project.members.some((m) => m.userId === user.id && m.access === 'editor')`

```ts setup
type Role = 'admin' | 'member'
interface User { id: string; orgId: string; role: Role }
interface Membership { userId: string; access: 'editor' | 'viewer' }
interface Project { id: string; orgId: string; ownerId: string; archived: boolean; members: Membership[] }
```

```ts starter
export function canEdit(user: User, project: Project): boolean {
  return user.role === 'admin' || project.ownerId === user.id
}
```

```ts solution
export function canEdit(user: User, project: Project): boolean {
  if (user.orgId !== project.orgId) return false
  if (user.role === 'admin') return true
  if (project.archived) return false
  if (project.ownerId === user.id) return true
  return project.members.some((m) => m.userId === user.id && m.access === 'editor')
}
```

```ts tests
const proj = (over: Partial<Project> = {}): Project => ({
  id: 'p1', orgId: 'acme', ownerId: 'u-owner', archived: false,
  members: [{ userId: 'u-ed', access: 'editor' }, { userId: 'u-view', access: 'viewer' }],
  ...over,
})
const u = (id: string, role: Role = 'member', orgId = 'acme'): User => ({ id, role, orgId })

test('owner can edit', () => {
  expect(canEdit(u('u-owner'), proj())).toBe(true)
})
test('editor member can edit, viewer cannot', () => {
  expect(canEdit(u('u-ed'), proj())).toBe(true)
  expect(canEdit(u('u-view'), proj())).toBe(false)
})
test('a stranger in the same org cannot edit', () => {
  expect(canEdit(u('u-random'), proj())).toBe(false)
})
test('admin of the same org can edit, even archived', () => {
  expect(canEdit(u('u-admin', 'admin'), proj())).toBe(true)
  expect(canEdit(u('u-admin', 'admin'), proj({ archived: true }))).toBe(true)
})
test('admin of ANOTHER org cannot edit', () => {
  expect(canEdit(u('u-admin', 'admin', 'evilcorp'), proj())).toBe(false)
})
test('same user id in another org cannot edit', () => {
  expect(canEdit(u('u-owner', 'member', 'evilcorp'), proj())).toBe(false)
})
test('archived projects are read-only for owner and editors', () => {
  expect(canEdit(u('u-owner'), proj({ archived: true }))).toBe(false)
  expect(canEdit(u('u-ed'), proj({ archived: true }))).toBe(false)
})
```
:::

## Authentication failures

*OWASP: Authentication failures (A07), Insecure design (A06).*

Rule zero: **don't build your own auth crypto.** Use ASP.NET Core Identity, or an OpenID Connect
provider (Entra ID, Auth0, Keycloak, Cognito…). What you still own:

- **Password storage.** Never plain text, never fast hashes (MD5/SHA-256). Use a slow, salted
  algorithm: PBKDF2 (what Identity's `PasswordHasher` uses), bcrypt or Argon2id.
- **Brute-force protection.** Rate-limit login and password-reset endpoints, lock out after N
  failures, and offer MFA (mandatory for admins). ASP.NET Core ships a rate limiter
  (`Microsoft.AspNetCore.RateLimiting`, built in). **Partition** the limit by client — otherwise one
  attacker uses up the budget for everyone:

```csharp
using System.Threading.RateLimiting;

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    // 5 login attempts per minute *per client IP*
    o.AddPolicy("login", ctx => RateLimitPartition.GetFixedWindowLimiter(
        partitionKey: ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        factory: _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 5,
            Window = TimeSpan.FromMinutes(1),
        }));
});

var app = builder.Build();
app.UseRateLimiter();
app.MapPost("/api/auth/login", Login).RequireRateLimiting("login");
```

:::warn title="The shared-bucket trap"
`o.AddFixedWindowLimiter("login", …)` looks simpler, but it creates **one** limiter for the whole
endpoint: 5 logins per minute for *all users combined*. Any script can lock everyone out — you've
built a denial-of-service button. Behind a reverse proxy, `RemoteIpAddress` is the *proxy's* IP —
one shared bucket again — unless you opt in:
`builder.Services.Configure<ForwardedHeadersOptions>(o => { o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto; /* add your proxy to KnownProxies / KnownIPNetworks */ });`
and call `app.UseForwardedHeaders()` **before** `app.UseRateLimiter()`. Without the options the
call does nothing (`ForwardedHeaders` defaults to `None`, and only loopback proxies are trusted).
:::

Two more things the snippet above does **not** solve, and a reviewer will ask about both:

- **One account, many IPs.** Credential stuffing spreads guesses for *one* account over thousands
  of IPs, so a per-IP limit never triggers. Add a second, per-**username** limit keyed on the
  normalised email. Check it inside the login handler, after the body is parsed: the rate-limiting
  middleware's partition function runs before the body is read and can't await it. Or rely on
  account lockout (`SignInManager.PasswordSignInAsync(..., lockoutOnFailure: true)` in Identity). Per-IP stops one
  noisy client; per-account stops a distributed attack on one victim. You want both.
- **The limit is per instance.** The built-in limiter keeps its counters in process memory. With
  `replicas: 3` behind a load balancer, "5 per minute" quietly becomes up to 15. For a limit that
  must hold across instances, keep the counter in a shared store such as Redis. The *Rate
  limiting* section of **System Design for Full-Stack Developers** compares the algorithms and
  this trade-off; **Redis as Queue, Bus and Lock** (Cloud-Native Toolkit) builds a shared Redis
  limiter hands-on.

The rest of what you still own:

- **Generic error messages.** "Invalid email or password" — not "no user with that email" (that
  lets attackers enumerate accounts).
- **JWT validation.** Validate issuer, audience, lifetime **and** signature; keep access tokens
  short-lived (minutes), rotate refresh tokens, and never accept `alg: none`. The defaults in
  `AddJwtBearer` are good — don't switch them off "to make it work locally". This holds for
  **every** service that receives the token, even one that sits behind an API gateway which
  already checked it: if the gateway is misconfigured or something inside the network calls the
  service directly, the service's own check is the layer that still holds (defence in depth).
- **Reset tokens and magic links** must be single-use, random (cryptographically) and expire quickly.
- **Session invalidation** on logout and password change.

:::quiz id=pro-03-q2 xp=15
Which password storage approach is acceptable in a new system?
- [ ] SHA-256 of the password with a global salt
- [ ] AES-encrypting the password so support can read it back
- [x] A slow, per-user-salted hash such as PBKDF2, bcrypt or Argon2id
- [ ] MD5, because the database is private anyway
> Hashes like SHA-256 are designed to be **fast** — a GPU can try billions of guesses per second
> against a leaked table. The "global salt" option is tempting because it sounds salted, but one
> salt for everyone means identical passwords still have identical hashes and one precomputed
> table cracks them all; a **per-user** salt forces the attacker to attack each hash separately.
> PBKDF2/bcrypt/Argon2id add a tunable *work factor* so each guess is slow. Encryption is
> reversible: whoever gets the key (an attacker, a curious insider) gets every password.
:::

## Security misconfiguration and headers

*OWASP: Security misconfiguration (A02).*

Browsers have many protective features that are **off by default** for backwards compatibility.
Response headers are how your server opts in. Add them once in middleware (or at the reverse proxy
/ ingress) and every response benefits:

| Header | What it does |
|---|---|
| `Strict-Transport-Security` | Browser only uses HTTPS for your domain from now on (HSTS) |
| `Content-Security-Policy` | Which scripts, styles, images, connections are allowed — the XSS safety net |
| `X-Content-Type-Options: nosniff` | Stops the browser guessing a file is HTML/JS |
| `frame-ancestors 'none'` (CSP) / `X-Frame-Options: DENY` | Stops clickjacking via iframes |
| `Referrer-Policy: strict-origin-when-cross-origin` | Don't leak full URLs (with tokens/ids) to other sites |
| `Permissions-Policy` | Disable camera, mic, geolocation you don't use |

```csharp
var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/error");   // never show stack traces to users
    app.UseHsts();
}
app.UseHttpsRedirection();

app.Use(async (ctx, next) =>
{
    var h = ctx.Response.Headers;
    h["X-Content-Type-Options"] = "nosniff";
    h["Referrer-Policy"] = "strict-origin-when-cross-origin";
    h["X-Frame-Options"] = "DENY";
    h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()";
    h["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
    await next();
});
```

Order matters: the header middleware sits *before* your endpoints so it runs for every response.
`UseHsts()` is skipped in development on purpose — the browser caches HSTS (ASP.NET Core's default
`max-age` is 30 days; production sites often raise it to a year), and you don't want local dev
hostnames stuck on HTTPS. Only send it once HTTPS works reliably on that domain.

:::tip title="Rolling out a CSP without breaking the site"
A strict CSP blocks *your own* inline scripts and third-party widgets too. Start with
`Content-Security-Policy-Report-Only` (same syntax, only reports violations in the console /
to a `report-to` endpoint), fix what it finds, then switch to the enforcing header. Vite
production builds emit external script files, so `script-src 'self'` usually works for a SPA.
:::

Other misconfigurations that show up again and again: the developer exception page or Swagger UI
exposed in production, verbose error bodies with SQL or stack traces, default credentials on
Postgres/RabbitMQ/Grafana, S3 buckets or blob containers set to public, and debug endpoints left
behind.

:::tip title="Check your headers"
`curl -sI https://your-app.example | grep -iE 'strict|content-security|x-content|referrer|frame'`
shows what you actually send. Mozilla's HTTP Observatory grades a public site for you.
:::

## CORS — what it is and isn't

*OWASP: Security misconfiguration (A02).*

An **origin** is scheme + host + port: `https://app.example.com` and `https://app.example.com:8443`
are different origins, and so are `http://` and `https://`. The browser's **same-origin policy**
stops `https://evil.example`'s JavaScript from *reading* responses from `https://api.yourapp.com`
(the request may still be sent — the browser just hides the answer). **CORS** (Cross-Origin
Resource Sharing) is how your server *relaxes* that policy for specific origins, by answering with
headers such as `Access-Control-Allow-Origin: https://app.example.com`. Two key consequences:

1. **CORS is not a server-side protection.** `curl`, Postman, and attacker scripts on a server
   ignore it completely. It only decides which *browser pages* may read your responses. Your API
   still needs authentication and authorization.
2. **A wrong CORS policy can open a hole**: reflecting any `Origin` back with
   `Access-Control-Allow-Credentials: true` lets any website make authenticated calls as your
   users and read the answers.

```csharp
builder.Services.AddCors(o => o.AddPolicy("spa", p => p
    .WithOrigins("https://app.example.com", "http://localhost:5173")   // exact origins
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .WithHeaders("Content-Type", "Authorization")
    .AllowCredentials()));

app.UseCors("spa");
```

- Use an **exact allowlist** of origins (scheme + host + port). No `*` with credentials — ASP.NET
  Core refuses `AllowAnyOrigin()` combined with `AllowCredentials()`.
- Don't validate origins with `startsWith`/`endsWith`/regex shortcuts:
  `https://app.example.com.evil.net` and `https://evilapp.example.com` are both real attacks.
- Browsers send a **preflight** `OPTIONS` request for non-simple requests (custom headers, JSON
  bodies, PUT/DELETE). Your API must answer it — another reason to use the middleware rather than
  hand-written headers.
- In development, the **Vite proxy** (`server.proxy` in `vite.config.ts`) makes the SPA and API
  same-origin, so you often need no CORS at all locally. In production, serving SPA and API under
  one domain (`/` and `/api`) avoids CORS entirely.

:::quiz id=pro-03-q5 xp=15
Which statements about CORS are true? (select all that apply)
- [x] CORS controls which browser origins may read your API's responses
- [ ] A strict CORS policy stops attackers from calling your API with curl
- [x] Reflecting any `Origin` with `Allow-Credentials: true` is a serious vulnerability
- [x] Serving SPA and API from the same origin avoids the need for CORS
> CORS is enforced by the **browser**, which is why it can only restrict browser pages. `curl`
> never asks for permission, so the curl option is the tempting wrong one: only authentication
> and authorization on the server stop it. Reflecting every `Origin` with credentials lets any
> website read logged-in users' data. With SPA and API on one origin, nothing is cross-origin, so
> there is nothing to relax.
:::

:::challenge id=pro-03-c4 lang=ts mode=tests xp=50
title: Break the origin check
Here is the team's correct origin check. Write tests that **pass** against it and **fail** against
the buggy variants we've hidden — the kind of "clever" shortcuts people write with `startsWith`,
`endsWith`, host-only comparisons and sloppy null handling.

Think like an attacker: lookalike domains, prefix tricks, wrong scheme, missing header. Your
tests must pass against the real implementation below, and each hidden variant must fail at
least one of them.

hint: There are four hidden variants: one uses `startsWith`, one uses `endsWith` on the host, one compares hosts only (ignoring `http` vs `https`), and one treats a missing `Origin` as allowed.
hint: An attacker can register `app.example.com.evil.net` or `evilapp.example.com`.
hint: Test `null`, `undefined` and `''` as the origin.

```ts impl
const ALLOWED_ORIGINS = ['https://app.example.com', 'http://localhost:5173']

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  return ALLOWED_ORIGINS.includes(origin)
}
```

```ts mutant
const ALLOWED_ORIGINS = ['https://app.example.com', 'http://localhost:5173']

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o))
}
```

```ts mutant
const ALLOWED_ORIGINS = ['https://app.example.com', 'http://localhost:5173']

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  return ALLOWED_ORIGINS.some((o) => origin.endsWith(o.replace(/^https?:\/\//, '')))
}
```

```ts mutant
const ALLOWED_ORIGINS = ['https://app.example.com', 'http://localhost:5173']

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false
  const host = (u: string) => u.replace(/^https?:\/\//, '')
  return ALLOWED_ORIGINS.map(host).includes(host(origin))
}
```

```ts mutant
const ALLOWED_ORIGINS = ['https://app.example.com', 'http://localhost:5173']

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true
  return ALLOWED_ORIGINS.includes(origin)
}
```

```ts starter
test('the real app origin is allowed', () => {
  expect(isAllowedOrigin('https://app.example.com')).toBe(true)
})
```

```ts solution
test('allowed origins pass', () => {
  expect(isAllowedOrigin('https://app.example.com')).toBe(true)
  expect(isAllowedOrigin('http://localhost:5173')).toBe(true)
})
test('missing origin is rejected', () => {
  expect(isAllowedOrigin(null)).toBe(false)
  expect(isAllowedOrigin(undefined)).toBe(false)
  expect(isAllowedOrigin('')).toBe(false)
})
test('prefix trick is rejected', () => {
  expect(isAllowedOrigin('https://app.example.com.evil.net')).toBe(false)
})
test('suffix trick is rejected', () => {
  expect(isAllowedOrigin('https://evilapp.example.com')).toBe(false)
})
test('wrong scheme is rejected', () => {
  expect(isAllowedOrigin('http://app.example.com')).toBe(false)
})
```
:::

## Vulnerable dependencies and the supply chain

*OWASP: Software supply chain failures (A03), Software or data integrity failures (A08).*

A typical Vite app pulls in **hundreds** of transitive npm packages; an ASP.NET Core API dozens
of NuGet packages. Each one is code running with your app's permissions. You manage this risk with
tooling, not heroics:

```bash
# npm — known vulnerabilities in the lockfile
npm audit
npm audit --omit=dev          # what actually ships
npm audit fix                 # apply compatible fixes (read the diff!)

# .NET — known vulnerabilities, including transitive packages
dotnet list package --vulnerable --include-transitive
dotnet list package --outdated
# (.NET 10 SDK also accepts the noun-first form: dotnet package list --vulnerable)

# CI: install EXACTLY what the lockfile says
npm ci
dotnet restore --locked-mode   # with RestorePackagesWithLockFile=true
```

Since .NET 8, `dotnet restore` also runs **NuGet Audit** and prints `NU1901`–`NU1904` warnings
for vulnerable packages (transitive ones too with `<NuGetAuditMode>all</NuGetAuditMode>`, the
default in recent SDKs). Many teams make those
warnings fail the build in CI (`<WarningsAsErrors>NU1903;NU1904</WarningsAsErrors>` for high and
critical).

Turn on **Dependabot** (or Renovate) so updates arrive as small, reviewable PRs instead of a
terrifying yearly upgrade. `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /web
    schedule: { interval: weekly }
    groups:
      minor-and-patch:
        update-types: [minor, patch]
  - package-ecosystem: nuget
    directory: /api
    schedule: { interval: weekly }
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
  - package-ecosystem: docker
    directory: /api
    schedule: { interval: weekly }
```

Supply-chain habits seniors have:

- **Commit lockfiles** (`package-lock.json`, `packages.lock.json`) and use `npm ci` in CI.
- **Look before you add**: weekly downloads, maintainers, last release, open issues. Watch for
  typosquats (`reqeusts`, `react-dom-router`).
- **Pin GitHub Actions** to a full commit SHA for third-party actions
  (`uses: some-org/some-action@<40-char-sha> # v4.2.0`). A tag like `@v4` can be moved: in 2025
  attackers re-pointed the tags of the popular `tj-actions/changed-files` action to code that
  dumped CI secrets into build logs. Dependabot still updates SHA pins for you.
- **Treat install scripts as code execution.** `npm install` runs packages' `postinstall`
  scripts; compromised packages (the 2025 "Shai-Hulud" worm, for example) used them to steal
  tokens from developer machines and CI. Prefer `npm ci`, consider `--ignore-scripts` in CI where
  your build allows it, and give CI tokens the minimum permissions (`permissions:` in workflows).
- **Scan container images** (Trivy, Grype, Docker Scout) — your base image has its own CVEs.
- Not every `npm audit` finding is exploitable (a ReDoS in a dev-only build tool is not an
  emergency), but **triage** each one; don't just ignore the noise.

:::quiz id=pro-03-q3 xp=15
Dependabot opens a PR bumping a transitive dependency of your Vite build tool from a vulnerable
version. CI is green. What's the best move?
- [ ] Close it — dev dependencies never matter
- [x] Read the advisory and changelog, then merge it like any small PR
- [ ] Wait and bundle it with all other updates into one big upgrade next quarter
- [ ] Disable Dependabot for dev dependencies to reduce noise
> Small, frequent updates are cheap and low-risk; big-bang upgrades are expensive and scary.
> "Dev dependencies never matter" is the tempting wrong answer: dev tooling runs on developer
> machines and in CI, which holds deploy secrets, so it is part of your attack surface. Reading
> the advisory tells you how urgent it really is, and a green CI plus a small diff makes merging cheap.
:::

## Secrets in URLs, logs and error messages

*OWASP: Cryptographic failures (A04, the old "sensitive data exposure"), Logging & alerting failures (A09).*

Keeping secrets out of git — `.gitignore`, user secrets, secret stores, push protection — and the
full playbook for "I committed a secret" (rotate first, then check for misuse, then clean up) are
covered in **Configuration, Secrets & Feature Flags**. If you skipped it, read that section first.

This section is about the leaks that happen **at runtime**, after the secret was stored correctly.
A token is only as secret as the most careless place it passes through, and a web request passes
through a lot of places:

| Where the value goes | Who can read it later |
|---|---|
| A **URL** (`/reset?token=…`, `/download?apiKey=…`) | Browser history, bookmarks, every proxy / load balancer / CDN access log, analytics and error-tracking scripts on the page (`location.href`), and other sites via the `Referer` header if your `Referrer-Policy` is loose |
| A **log line** (`logger.LogInformation("Request {@Body}", body)`) | Everyone with access to the log system, the log vendor, every backup of it, for as long as retention says |
| An **error response** (exception message containing a connection string) | The user, and anyone they paste the screenshot to |
| An **exception or trace** sent to Sentry / Application Insights | Everyone with access to that tool — often far more people than have production access |

Why do URLs leak so easily? Because the URL is treated as **metadata**, not as data. TLS encrypts
it on the wire, but every component that terminates TLS (your reverse proxy, ingress, CDN) sees it
in clear text and logs it by default. Bodies and headers are usually not logged; URLs always are.

The habits that follow from that:

- **Never put long-lived secrets in URLs.** API keys go in a header (`Authorization`,
  `X-Api-Key`). Tokens that *must* be in a link (password reset, email verification, magic login)
  are **single-use** and **short-lived** (minutes to an hour), and the page that receives one
  exchanges it right away (`POST` it to the API) and removes it from the address bar with
  `history.replaceState`.
- **Keep third-party scripts off sensitive pages** (reset, checkout, account settings). Any script
  on the page can read the URL and the DOM.
- **Send `Referrer-Policy: strict-origin-when-cross-origin`** (or `no-referrer` on sensitive pages)
  so other sites only see your origin, never the path and query.
- **Log structured fields you chose**, not whole objects: `LogInformation("Login failed for
  {UserId}", id)` rather than `{@Request}`. Redact `Authorization`, `Cookie`, `Set-Cookie` and
  `password` fields in request logging (ASP.NET Core's `AddHttpLogging` prints the values of only
  the headers listed in `RequestHeaders` and redacts the rest, so keep that list short).
- **Return `ProblemDetails`, not exception messages** (next section) — `ex.Message` from Npgsql
  can include host names and user names.

:::quiz id=pro-03-q4 xp=15
Your password-reset email links to `https://app.example.com/reset?token=8f3c…` (valid 24 hours,
reusable until the password changes). The reset page loads a third-party analytics script and has
a "Help" link to `https://help.example-vendor.com`. You send
`Referrer-Policy: strict-origin-when-cross-origin`. Where can the token leak? (select all that apply)
- [x] Your reverse proxy's / ingress's access log, which records the full request URL
- [x] The analytics script, which can read `location.href` like any script on the page
- [x] The browser history of a shared or borrowed computer
- [ ] The help site, via the `Referer` header, when the user clicks "Help"
- [ ] Nowhere: the URL is encrypted by HTTPS
> HTTPS protects the URL **on the wire**, but the proxy that terminates TLS sees it in clear text
> and logs it, the browser stores it in history, and every script on the page can read it. The
> `Referer` option is the tempting one: with `strict-origin-when-cross-origin` the help site only
> receives `https://app.example.com/`, never the path or query. The fixes are a short lifetime
> and **single use** (so a leaked old token is worthless), exchanging the token immediately and
> removing it from the address bar, and no third-party scripts on the reset page.
:::

## Logging, monitoring and errors

*OWASP: Logging & alerting failures (A09), Mishandling of exceptional conditions (A10).*

You can't respond to what you can't see. Log **security-relevant events** — logins (success and
failure), permission denials, password changes, admin actions, unusually large exports — with a
user id and correlation id, and alert on anomalies. But never log passwords, tokens, full card
numbers or unnecessary personal data.

Handle errors so they **fail closed** and reveal nothing: a generic `ProblemDetails` body with a
trace id for the client, the full details in your logs.

```csharp
builder.Services.AddProblemDetails();
app.UseExceptionHandler();   // returns RFC 9457 problem+json, no stack trace in production
```

Two things to notice: the problem details are written for the **client** (generic title, status,
`traceId`), while the exception goes to the **log** with full detail; and an exception in a
permission check ends the request with a 500 — it never falls through to "allowed". If you write
your own `try`/`catch` around authorization logic, the `catch` must deny, never continue.

## Lab: a security pass on your own API

:::lab id=pro-03-lab1 xp=100
title: Harden a real project
Pick a project you own (or the capstone API). Work through it like a reviewer would.

**1. Dependencies.** Run the scanners and triage every finding (fix, or write down why it's not
exploitable):

```bash
cd web && npm audit --omit=dev
cd ../api && dotnet list package --vulnerable --include-transitive
```

**2. Dependabot.** Add `.github/dependabot.yml` (see the supply-chain section) for npm, NuGet, GitHub Actions and
Docker. Push and check the **Insights → Dependency graph → Dependabot** tab.

**3. Headers.** Add the security-header middleware from the headers section, run the API (`dotnet run`
prints the URL — the port comes from `Properties/launchSettings.json`) and request any endpoint
that exists, e.g. a health check:

```bash
curl -sI http://localhost:5080/api/health    # use your own port and path
```

You should see your headers in the output:

```text
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self'; ...
```

(`-I` sends a `HEAD` request. If your endpoint only maps `GET` and you get `405`, use
`curl -s -D - -o /dev/null <url>` to send a GET and print only the headers.)

If you get `307 Temporary Redirect` and none of your headers, `UseHttpsRedirection` answered
before your middleware ran (that happens with the `https` launch profile). Curl the
`https://localhost:<port>` URL instead (add `-k` for the dev certificate), or register the header
middleware before `UseHttpsRedirection()` so redirects get the headers too.

**4. IDOR test.** Write an integration test that calls one of your "get by id" or "update"
endpoints **as a different user** and asserts 403 or 404. With `WebApplicationFactory` it looks
like this:

```csharp
[Fact]
public async Task Other_user_cannot_read_my_project()
{
    var alice = _factory.CreateClientAs("alice");
    var bob = _factory.CreateClientAs("bob");

    var created = await alice.PostAsJsonAsync("/api/projects", new { name = "secret" });
    var id = (await created.Content.ReadFromJsonAsync<ProjectDto>())!.Id;

    var res = await bob.GetAsync($"/api/projects/{id}");

    Assert.Equal(HttpStatusCode.NotFound, res.StatusCode);
}
```

(`CreateClientAs` is your own helper that adds a test authentication handler — most real test
suites have one.)

**5. Secrets.** Scan the whole history with [gitleaks](https://github.com/gitleaks/gitleaks)
(`gitleaks git .` in current versions; older versions use `gitleaks detect`). No gitleaks? A poor
man's version is `git log -p | grep -iE 'password|secret|apikey'`. Then check `.gitignore` covers
`.env*` and any local-override files your project uses (e.g. `appsettings.*.local.json`).
`dotnet user-secrets` stores `secrets.json` in your user profile, outside the repo, so it can't
be committed by accident. (If the scan finds a real secret, follow the leak playbook in
**Configuration, Secrets & Feature Flags**: rotate first.)

Then look for **runtime** leaks: run the app, log in, trigger a password reset and an error, and
search your console / log output for `token=`, `Authorization`, `password` and your connection
string's host name. Anything you find is a finding.

:::tip
Write your findings as issues in the tracker, one per problem — that's exactly what a security
review produces at work.
:::

- [ ] `npm audit` and `dotnet list package --vulnerable` run, every finding triaged
- [ ] `dependabot.yml` committed for npm, NuGet, Actions (and Docker if used)
- [ ] `curl -I` shows `X-Content-Type-Options`, `Content-Security-Policy` and `Referrer-Policy`
- [ ] An integration test proves user B cannot read or edit user A's resource
- [ ] Secret scan run; `.gitignore` covers local secret files; logs searched for tokens and passwords
:::

## Flashcards

:::cards id=pro-03-cards1 xp=20 title="Web security essentials"
Q: What is IDOR?
A: Insecure Direct Object Reference — an endpoint accepts an id and returns/changes the object without checking the caller may access it. Fix: scope every query by owner/tenant/permission.
Q: Authentication vs authorization?
A: Authentication = who are you (login). Authorization = may you do this action on this resource.
Q: How do you prevent SQL injection?
A: Parameterized queries (ADO.NET parameters, Dapper, EF Core LINQ, `FromSql` with interpolation). Allowlists for identifiers like sort columns.
Q: The EF Core injection trap?
A: `FromSqlRaw($"... {x} ...")` — the string is built before EF sees it. Use `FromSql($"... {x} ...")`, which turns holes into parameters.
Q: Why is React mostly safe from XSS?
A: JSX expressions are rendered as text and escaped. Danger zones: `dangerouslySetInnerHTML`, direct DOM `innerHTML`, `eval`/`new Function`, and user URLs used outside JSX (React 19 blocks `javascript:` only in JSX attributes) — allowlist URL schemes.
Q: What does a Content Security Policy do?
A: Tells the browser which sources of scripts, styles, images and connections are allowed — a safety net that blocks injected scripts.
Q: What makes CSRF possible?
A: Browsers attach cookies automatically to cross-site requests. Defences: SameSite cookies, anti-forgery tokens, no state changes on GET, Origin checks.
Q: Is CORS a security control for your API?
A: No — it only relaxes the browser's same-origin policy for chosen origins. Non-browser clients ignore it. Misconfigured CORS (any origin + credentials) creates holes.
Q: How should passwords be stored?
A: Slow, per-user-salted hashes: PBKDF2 (ASP.NET Identity), bcrypt or Argon2id. Never plain, never fast hashes, never reversible encryption.
Q: Why are tokens in URLs riskier than tokens in headers?
A: URLs end up in proxy/CDN access logs, browser history, analytics scripts and (with a loose Referrer-Policy) other sites' logs. Keep secrets in headers; make link tokens single-use and short-lived.
Q: Two commands to find vulnerable dependencies?
A: `npm audit` and `dotnet list package --vulnerable --include-transitive`.
Q: What is mass assignment / over-posting?
A: Binding request JSON straight into an entity so a client can set fields like `OwnerId` or `IsAdmin`. Bind to DTOs instead.
Q: Why partition a login rate limiter (e.g. by IP)?
A: An unpartitioned limiter is one shared bucket for everybody — an attacker can exhaust it and lock out all users.
Q: What does `SameSite=Lax` block, and what does it still allow?
A: Blocks the cookie on cross-site POSTs, fetches, images and iframes; still sends it on top-level GET navigations (clicking a link). Hence: no state changes on GET.
Q: Name four useful security headers.
A: Strict-Transport-Security, Content-Security-Policy, X-Content-Type-Options: nosniff, Referrer-Policy (plus frame-ancestors / X-Frame-Options).
Q: 403 or 404 when a user requests someone else's record?
A: 404 is often preferred — it doesn't confirm the record exists. 403 is fine when existence isn't secret. Be consistent.
:::

## Recap

- Everything from outside your trust boundary is untrusted — the React app included. The **API**
  enforces the rules.
- **Injection**: parameters for values, allowlists for identifiers; beware `FromSqlRaw` + `$""`.
- **XSS**: React escapes by default; be careful with `dangerouslySetInnerHTML`, `javascript:` URLs
  and `innerHTML`; sanitize rich HTML; add a CSP.
- **CSRF**: `SameSite`/`HttpOnly`/`Secure` cookies, anti-forgery tokens, no state changes on GET.
- **Broken access control** is the top risk: check ownership/tenant on **every** request, test it
  with "user B calls user A's id".
- Use proven auth (Identity / OIDC), slow per-user-salted password hashes, **partitioned** rate
  limits, MFA, strict JWT validation.
- Ship security headers, hide stack traces, configure **CORS** with an exact origin allowlist.
- Automate dependency scanning (npm audit, `dotnet list package --vulnerable`, Dependabot) and commit
  lockfiles.
- Secrets leak at runtime too: keep them out of URLs, logs and error bodies. A secret in git is
  handled with the **rotate first** playbook from Configuration, Secrets & Feature Flags.
