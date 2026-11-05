---
id: bc-08
title: "HTTP & APIs: The Mental Model"
level: beginner
minutes: 80
xp: 150
summary: What really happens between fetch() and your API — URLs, DNS/TCP/TLS, methods, status codes, headers, cookies vs tokens, CORS and REST — read in DevTools and curl -v.
---

Full-stack work is mostly two programs talking over HTTP: a React app in the browser and an
ASP.NET Core API on a server. Most "weird" bugs live in the conversation between them — a 401 that
should be a 403, a CORS error that is really a crash, a stale page caused by caching, a double
order caused by a retried POST. If you can picture the request on the wire, those bugs stop being
mysterious.

This lesson builds that picture. It's the foundation for **Async JavaScript** and **Effects & Data
Fetching** on the frontend, **Your First Minimal API** and **Route Groups, DTOs, Validation &
ProblemDetails** on the backend, and **Web Security for Full-Stack Devs** later. You met `curl` in
**Terminal Survival Kit**; here you'll learn to *read* what it shows you.

## The running example

Everything in this lesson uses one small API, and you'll run it yourself in the lab:

| What | Where |
|---|---|
| The **Projects API** (later: ASP.NET Core; in the lab: one small Node script, no dependencies) | `http://localhost:5080` |
| The React dev server (Vite) | `http://localhost:5173` |
| The lab's demo page (a *different* origin on purpose) | `http://localhost:5500` |

| Endpoint | Does |
|---|---|
| `GET /api/projects` | List projects |
| `GET /api/projects/{id}` | One project (with an `ETag`) |
| `POST /api/projects` | Create — needs `Authorization: Bearer dev-token` |
| `PUT /api/projects/{id}` | Replace the name (optionally with `If-Match`) — needs the token |
| `DELETE /api/projects/{id}` | Delete — needs the token |
| `GET /projects` | An old URL that redirects (`301`) to `/api/projects` |

Two fake tokens exist: `dev-token` belongs to an **Editor** (may write), `viewer-token` to a
**Viewer** (may only read). Real APIs issue tokens at login; these are hard-coded so you can focus on
the HTTP.

## URL anatomy

A URL is an address with several distinct parts, and each part is used by a different layer:

```text
  http://localhost:5080/api/projects?status=active&page=2#details
  └─┬┘   └───┬───┘ └┬─┘└─────┬────┘ └─────────┬─────────┘ └──┬──┘
 scheme    host   port     path              query         fragment
  └───────────┬──────────┘
            origin
```

- **Scheme** — `http` or `https`. It decides the default port (80 / 443) and whether TLS is used.
- **Host** — a name that DNS turns into an IP address (`localhost` is special: it's your machine).
- **Port** — which program on that machine. Leave it out and the scheme's default is used.
- **Path** — which resource on the server: `/api/projects/42`. Case-sensitive on most servers.
- **Query** — `key=value` pairs after `?`, joined with `&`. Used for filtering, sorting, paging.
  Values must be **URL-encoded** (`a b&c` → `a%20b%26c`); in JS use `URLSearchParams` or
  `encodeURIComponent`, never string concatenation.
- **Fragment** — everything after `#`. It never leaves the browser; it's for in-page anchors and
  client-side state.
- **Origin** = scheme + host + port. It's the unit of trust in the browser, and it's what CORS and
  cookies care about. `http://localhost:5173` and `http://localhost:5080` are **different origins**
  — only the port differs, and that's enough.

```ts
const url = new URL('http://localhost:5080/api/projects?status=active#details')
url.origin                       // "http://localhost:5080"
url.pathname                     // "/api/projects"
url.searchParams.get('status')   // "active"
url.searchParams.set('q', 'a b&c')
url.toString()                   // "...?status=active&q=a+b%26c#details"
```

Notice the space became `+`, not `%20`: `URLSearchParams` uses the HTML-form flavour of encoding,
where `+` means space inside a query string. Both decode to the same value — the point is that a
library did the escaping, so the `&` in the value can't be mistaken for "next parameter".

:::quiz id=bc-08-q1 xp=10
Your code requests `http://localhost:5080/api/projects?sort=name#archived`. Which part of that URL
does the API **never learn about in any form**?
- [ ] `http` — the scheme is only for the browser
- [ ] `?sort=name` — query strings are only for the client
- [x] `#archived` — the fragment stays in the browser
- [ ] `localhost:5080` — host and port are only used to open the connection
> The fragment is never sent in the HTTP request; it's for in-page anchors and client-side routing.
> The query string *is* sent (it's part of the request target `/api/projects?sort=name`), which is why
> you must never put secrets in it — it ends up in server logs and browser history. Host and port
> travel in the `Host` header (`Host: localhost:5080`), so one server can serve many sites. And the
> server knows the scheme from the connection itself — plain TCP vs TLS (HTTP/2 even sends it as a
> `:scheme` field).
:::

## What happens when you press Enter

Before a single byte of HTTP is exchanged, three things happen. Here's the whole journey in one
picture for a real HTTPS API, `https://api.example.com/api/projects`. (For our
`http://localhost:5080`, step 1 is answered by your own machine without asking any DNS server, and
step 3 is skipped entirely because the scheme is `http` — that's why the lab ends with a real HTTPS
API, so you can watch all of it.)

```text
 Browser / curl                                                   api.example.com
 ──────────────                                                   ───────────────
 1. DNS    "where is api.example.com?" ──► resolver ──► 203.0.113.10     (cached for its TTL)

 2. TCP    SYN ─────────────────────────────────────────────────────────►
           ◄───────────────────────────────────────────────────── SYN-ACK
           ACK ─────────────────────────────────────────────────────────►  1 round trip

 3. TLS    ClientHello  "I speak TLS 1.3, h2 or http/1.1" ──────────────►
           ◄────────── ServerHello + certificate for api.example.com + Finished
           Finished ────────────────────────────────────────────────────►  1 round trip

 4. HTTP   GET /api/projects  (encrypted) ──────────────────────────────►
           ◄───────────────────────────────────────── 200 OK + JSON body

 5. Reuse  the next request rides the same connection (keep-alive / HTTP/2)
```

Why you care:

- **DNS** failures look like "could not resolve host". Inside Docker or Kubernetes, the host name is
  often a *service name* (`http://api:8080`), resolved by the cluster's DNS — `localhost` there means
  "this container", not your laptop. That single fact explains a whole class of "works on my machine"
  bugs you'll meet in the containers region.
- **TCP** failures look like "connection refused" (nothing listening on that port — the API isn't
  running, or runs on a different port) or a timeout (a firewall drops packets).
- **TLS** proves the server owns the name (its **certificate** is signed by an authority your machine
  trusts) and then encrypts everything. Failures look like "certificate has expired" or "self-signed
  certificate". `dotnet dev-certs https --trust` exists so local HTTPS doesn't hit this.
- **Connections are expensive, requests are cheap.** That's why browsers keep connections open and
  why HTTP/2 sends many requests over one connection at the same time (*multiplexing*). HTTP/3 does
  the same over QUIC (UDP), merging the TCP and TLS handshakes into one.

:::info title="HTTP/1.1, HTTP/2, HTTP/3 — same meaning, different packaging"
Methods, status codes, headers and bodies mean exactly the same in all three versions. HTTP/1.1
sends them as readable text; HTTP/2 and HTTP/3 pack them into binary frames and lowercase the header
names. So everything below applies whichever version your browser negotiated — DevTools shows it in
the **Protocol** column (`http/1.1`, `h2`, `h3`).
:::

## Anatomy of a request and a response

An HTTP message is plain text with a fixed shape: **one start line, headers, a blank line, an
optional body**. That's it. Here's a request your React app might send:

```http
POST /api/projects HTTP/1.1
Host: localhost:5080
Content-Type: application/json
Accept: application/json
Authorization: Bearer dev-token
Content-Length: 20

{"name":"Docs site"}
```

- **Request line** — method, request target (path + query), protocol version.
- **Headers** — `Name: value` lines. Names are case-insensitive (`content-type` = `Content-Type`).
- **Blank line** — marks the end of the headers. Lines end with `\r\n` (CRLF) on the wire.
- **Body** — the payload; its format is described by `Content-Type`, its size by `Content-Length`.

And the response:

```http
HTTP/1.1 201 Created
Location: /api/projects/3
ETag: "v1"
Content-Type: application/json; charset=utf-8
Content-Length: 39

{"id":3,"name":"Docs site","version":1}
```

- **Status line** — version, **status code** (for programs), **reason phrase** (for humans; HTTP/2
  drops it, so never branch on it).
- Then headers, blank line, body — the same shape as the request.

:::tip title="Everything is text you can read"
Because the format is so simple, every tool — DevTools, curl, Postman, Wireshark, your server's
request logs — shows you the same four parts. When something fails, ask four questions in order:
*Which method and URL? Which status? Which headers? Which body?*
:::

## Methods: safe, idempotent, and why it matters

The method says what you want to do with the resource. Two properties matter more than the names:

- **Safe** — the request doesn't change anything on the server (from the client's point of view).
  Crawlers, prefetchers and caches may send safe requests whenever they like.
- **Idempotent** — sending it once or ten times leaves the server in the **same state**. That makes
  it safe to **retry** after a timeout, when you don't know whether the first attempt arrived.

| Method | Meaning | Safe | Idempotent | Typical success |
|---|---|---|---|---|
| `GET` | Read a resource | ✅ | ✅ | `200` (or `304`) |
| `HEAD` | Like GET, headers only | ✅ | ✅ | `200` |
| `OPTIONS` | "What's allowed here?" (CORS preflight) | ✅ | ✅ | `204` |
| `POST` | Create / run an action | ❌ | ❌ | `201` + `Location`, or `200`/`202` |
| `PUT` | Replace the whole resource at this URL | ❌ | ✅ | `200` or `204` |
| `PATCH` | Change part of a resource | ❌ | ❌ (not guaranteed) | `200` or `204` |
| `DELETE` | Remove it | ❌ | ✅ | `204` |

Idempotent is about **server state**, not the response. `DELETE /api/projects/3` twice: the first
returns `204`, the second `404` — different responses, but the project is gone either way, so it's
idempotent. `POST /api/projects` twice creates **two** projects.

:::warn title="Never change data on GET"
`GET /api/projects/3/delete` "works" until a link-preview bot, a browser prefetch or a monitoring
tool visits the URL and deletes the project. GETs can also be cached, logged with their full URL, and
retried freely. If it changes state, it's not a GET.
:::

:::quiz id=bc-08-q2 xp=15
The client sends a request, the network times out, and you don't know if the server processed it.
Which requests can a generic HTTP client **safely retry** without extra protection? (Select all
that apply.)
- [x] `GET /api/projects/3`
- [x] `PUT /api/projects/3` with body `{"name":"Docs"}`
- [x] `DELETE /api/projects/3`
- [ ] `POST /api/projects` with body `{"name":"Docs"}`
- [ ] `PATCH /api/projects/3` with body `{"op":"incrementStars"}`
> GET, PUT and DELETE are idempotent: repeating them ends in the same server state (the project has
> that name / is gone). POST is the tempting one — "it's just a create" — but retrying it can create
> a **second** project or a second order; that's why payment APIs require an `Idempotency-Key`
> header (see **Concurrency, Versions & Idempotency** in the Backend region). PATCH isn't guaranteed
> to be idempotent: "increment" applied twice increments twice.
:::

## Status codes: the families and the ones you'll meet

The first digit tells you who should act:

| Family | Meaning | Mental shortcut |
|---|---|---|
| `1xx` | Informational | You'll rarely see these (`101` = switching to WebSockets) |
| `2xx` | Success | "Done." |
| `3xx` | Redirection / not modified | "Look elsewhere — or use your copy." |
| `4xx` | **Client** error | "*You* sent something wrong. Retrying the same request won't help." |
| `5xx` | **Server** error | "*We* broke. Retrying later might help." |

The codes you'll meet every week:

| Code | Name | When you'll see it |
|---|---|---|
| `200` | OK | Successful GET, or PUT/PATCH returning the updated resource |
| `201` | Created | POST created something; `Location` header says where it lives |
| `204` | No Content | Success with **no body** — typical for DELETE (don't call `res.json()`!) |
| `301` | Moved Permanently | URL changed for good; browsers and search engines remember it |
| `302` | Found | Temporary redirect — e.g. "log in first" redirects |
| `304` | Not Modified | Your cached copy (matched by `ETag`) is still valid; no body |
| `400` | Bad Request | Malformed request: broken JSON, wrong type, missing field |
| `401` | Unauthorized | Actually means **unauthenticated**: "who are you?" — no or invalid credentials |
| `403` | Forbidden | "I know who you are, and you're not allowed." Logging in again won't help |
| `404` | Not Found | No resource at this URL (also used to hide things you may not see) |
| `409` | Conflict | Clashes with current state: duplicate name, already archived |
| `412` | Precondition Failed | Your `If-Match` ETag is stale — someone else changed it first |
| `422` | Unprocessable Content | Well-formed JSON, but it fails business validation (older name: *Unprocessable Entity* — Node still prints that one) |
| `429` | Too Many Requests | Rate limited; respect the `Retry-After` header |
| `500` | Internal Server Error | Unhandled exception. Look at the **server** logs |
| `502` | Bad Gateway | A proxy (nginx, ingress, load balancer) got no valid answer from your app — it crashed or listens on another port |
| `503` | Service Unavailable | Overloaded, starting up, in maintenance, or no healthy instances behind the proxy |

:::info title="400 vs 422 in ASP.NET Core"
Both are used for "your input is wrong", and teams pick a convention. ASP.NET Core's built-in
validation (`[ApiController]`, minimal-API validation) answers **400** with a `ValidationProblemDetails`
body; some teams switch business-rule failures to **422**. Our example API uses 400 for "not even
valid JSON" and 422 for "valid JSON, invalid values". What matters is consistency and a useful body.
:::

:::info title="Redirects and methods"
With `301`/`302`, browsers historically change a POST into a GET when following the redirect. If the
method and body must be kept, servers use `307` (temporary) or `308` (permanent). For an API, prefer
not redirecting writes at all.
:::

:::quiz id=bc-08-q3 xp=10
A logged-in user with the **Viewer** role calls `DELETE /api/projects/3`. Only Editors may delete.
Which status should the API return?
- [ ] `401 Unauthorized` — they aren't authorized to delete
- [x] `403 Forbidden`
- [ ] `404 Not Found`
- [ ] `400 Bad Request`
> The server knows exactly who the user is (their token is valid), they just lack permission — that's
> 403. The name "401 Unauthorized" is the classic trap: it really means **unauthenticated** (missing,
> expired or invalid credentials), and clients typically react to it by sending the user to log in,
> which won't help a Viewer. 404 is a deliberate choice only when even revealing that the project
> exists would leak information.
:::

:::quiz id=bc-08-q4 xp=10
After a deploy, the browser shows **502 Bad Gateway** from your Kubernetes ingress for every API
call. Where do you look first?
- [ ] The React code — a 5xx means the frontend sent bad data
- [ ] The ingress configuration — 502 means nginx itself crashed
- [x] The API pods: are they running, healthy, and listening on the port the service points to?
- [ ] Nowhere — 502 is a temporary network blip, just retry
> A 502 is generated by the **proxy**, reporting that the app *behind* it gave no valid response:
> the container crashed, is still starting, or listens on 8080 while the service targets 5080. The
> proxy itself is fine — it's the one talking to you. A 4xx would point at the request; a 5xx points
> at the server side, and with 502 specifically, at the hop behind the proxy.
:::

## Headers that do the heavy lifting

Headers are metadata about the message. You'll set and read these all the time:

| Header | Direction | What it says |
|---|---|---|
| `Content-Type` | both | "The body **I'm sending** is …" — `application/json`, `multipart/form-data`, `text/html` |
| `Accept` | request | "I'd **like back** …" — `application/json` |
| `Authorization` | request | Credentials: `Bearer eyJhbGc…` |
| `Cache-Control` | both | Caching rules: `no-store`, `no-cache`, `max-age=60`, `private` |
| `ETag` | response | A version fingerprint of this representation: `"v3"` |
| `If-None-Match` / `If-Match` | request | Conditional requests using an ETag |
| `Location` | response | Where the new resource lives (`201`) or where to go (`3xx`) |
| `Retry-After` | response | How long to wait (`429`, `503`) |
| `Set-Cookie` / `Cookie` | response / request | Store a cookie / send it back |

**`Content-Type` vs `Accept`.** One describes what you send, the other what you want. Forget
`Content-Type: application/json` on a POST and ASP.NET Core answers `415 Unsupported Media Type`
(it doesn't guess). `fetch` with a string body defaults to `text/plain` — a very common cause of
"my endpoint gets null".

**`Cache-Control`** — the three values people mix up:

- `no-store` — never keep a copy. Use for sensitive data.
- `no-cache` — you **may** keep a copy, but must **revalidate** with the server before using it.
  (The name is a lie; it doesn't mean "don't cache".)
- `max-age=60` — the copy is fresh for 60 seconds; use it without asking. Add `private` when only
  the user's browser (not a shared CDN) may store it.

**`ETag` and conditional requests** do two separate jobs:

```text
Caching (saves bandwidth)                 Optimistic concurrency (prevents lost updates)
────────────────────────                  ──────────────────────────────────────────────
GET /api/projects/1                       GET /api/projects/1        → ETag: "v1"
← 200, ETag: "v1", body                   ... colleague saves         → now "v2"
GET /api/projects/1                       PUT /api/projects/1
  If-None-Match: "v1"                       If-Match: "v1"
← 304 Not Modified (no body)              ← 412 Precondition Failed — reload, don't overwrite
```

The second pattern is how you stop two people silently overwriting each other's edits. You'll build it
properly in **Concurrency, Versions & Idempotency**.

:::quiz id=bc-08-q5 xp=10
An endpoint returns `Cache-Control: no-cache`. What does the browser do with the response?
- [ ] Never stores it — `no-cache` means "don't cache this"
- [x] May store it, but asks the server (e.g. with `If-None-Match`) before reusing it
- [ ] Stores it and reuses it for the session without asking
- [ ] Ignores the header unless the request was a POST
> `no-cache` means "revalidate before every use": the browser keeps the copy and sends a conditional
> request; the server answers `304` (use your copy) or `200` with new data. The tempting answer
> describes `no-store`, which really forbids storing. If you want "never keep this", say `no-store`.
:::

## JSON bodies

APIs today speak JSON. A few rules save you hours:

- Send `Content-Type: application/json` and `JSON.stringify` the body. Read with `await res.json()`
  — but **not** on `204` or `304`, where there is no body to parse.
- `fetch` only rejects when there is **no usable response** — network failure, a CORS block, or an
  abort. A `404` or `500` resolves normally, so always check `res.ok` (true for 200–299) — the
  **A fetchJson helper** challenge in **Async JavaScript** drills this.
- ASP.NET Core serializes with **camelCase** by default: C# `ProjectName` becomes `"projectName"`.
- Dates travel as ISO 8601 strings, ideally UTC: `"2026-11-05T15:45:17Z"`. JSON has no date type.
- JS numbers are 64-bit floats: integers beyond 2⁵³ (some `long` ids) and money lose precision.
  Send those as strings, or money as integer cents.
- Errors deserve a body too. The standard is **ProblemDetails** (RFC 9457), with
  `Content-Type: application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Validation failed",
  "status": 422,
  "errors": { "name": ["Name is required."] }
}
```

`status` repeats the status code, `title` is a short human summary, and `type` is a URI that names
the *kind* of problem (`about:blank` = "nothing more specific than the status code"). Extra members
like `errors` are allowed — ASP.NET Core uses exactly that shape for validation errors, so a frontend
can show each message next to its form field.

:::warn title="null is not the same as missing"
`{"description": null}` says "clear the description"; `{}` says "I didn't mention it". For PUT
(replace everything) the difference is small, but for PATCH it's the whole point. Also note that
`JSON.stringify({ a: undefined })` is `"{}"` — `undefined` fields silently disappear.
:::

## Cookies vs bearer tokens

After login, every request must prove who you are. There are two common ways to carry that proof,
and the difference is **who attaches it**:

| | Cookie (session or token in a cookie) | Bearer token |
|---|---|---|
| How it's sent | The **browser** attaches `Cookie:` automatically to every request to that site | **Your code** adds `Authorization: Bearer …` to each request |
| Where it lives | The browser's cookie jar; `HttpOnly` hides it from JavaScript | Wherever your code puts it: memory, `sessionStorage`, … |
| XSS (injected script) | Can't read an `HttpOnly` cookie (but can still make requests from the page) | Can steal a token stored where JS can read it |
| CSRF (other site triggers a request) | A risk — the browser adds the cookie for the attacker. Mitigate with `SameSite` + anti-forgery tokens | Not affected — browsers never add the header on their own |
| Cross-origin calls | Need `credentials: 'include'` and an exact allowed origin + `Access-Control-Allow-Credentials: true` | The `Authorization` header always triggers a CORS preflight |
| Typical use | Browser apps on the same site as their API (often via a backend-for-frontend) | Mobile apps, service-to-service calls, public APIs |

Neither is "the secure one" — they fail differently. The details are in **Frontend Security & Auth**,
**Authentication & Authorization** and **Web Security for Full-Stack Devs**.

:::quiz id=bc-08-q6 xp=10
Your SPA authenticates against `http://localhost:5080` with an `HttpOnly` session cookie. While the
user is logged in, a page on `http://evil.example` makes their browser send
`POST http://localhost:5080/api/projects`. Why is this a risk that a bearer-token API doesn't have?
- [ ] Because `HttpOnly` cookies can be read by the malicious site's JavaScript
- [x] Because the browser attaches the cookie automatically, so the request arrives authenticated
- [ ] Because CORS blocks bearer tokens but not cookies
- [ ] It isn't a risk — the same-origin policy blocks all cross-site POSTs
> That's CSRF: cookies are attached by the browser based on the *destination*, whoever triggered the
> request. A bearer token is only sent when *your* code adds the header, so an attacker's page can't
> make the browser include it. `HttpOnly` prevents reading the cookie, not sending it. And the
> same-origin policy mostly restricts *reading responses*, not sending requests — a plain form POST
> to another site goes through, which is why `SameSite` cookies and anti-forgery tokens exist.
> (Chrome treats cookies without a `SameSite` attribute as `Lax`, which blocks most cross-site POSTs —
> but other browsers don't all do that by default, so set `SameSite` explicitly and don't rely on it alone.)
:::

## CORS, from the browser's side

Here's the error every full-stack developer meets in week one:

```text
Access to fetch at 'http://localhost:5080/api/projects' from origin 'http://localhost:5173'
has been blocked by CORS policy: Response to preflight request doesn't pass access control
check: No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

To understand it, start with the rule CORS relaxes: the **same-origin policy**. Your browser holds
your cookies for your bank, your mail, your company's intranet. If any page you visit could `fetch`
those sites *and read the answers*, any page could read your mail. So by default, JavaScript on
origin A **can't read responses** from origin B.

**CORS** (Cross-Origin Resource Sharing) is how origin B says "it's OK, origin A may read my
responses". It's entirely enforced **by the browser**, using headers the **server** sends. That's
why the same request works in curl or Postman — they're not browsers, they don't protect anyone's
cookies, so they don't care.

The browser sorts cross-origin requests into two kinds:

**1. "Simple" requests** — sent straight away. Method is `GET`, `HEAD` or `POST`; your code only set
safelisted headers (`Accept`, `Accept-Language`, `Content-Language`, `Content-Type`); and
`Content-Type`, if set, is `text/plain`, `multipart/form-data` or `application/x-www-form-urlencoded`.
These are things an HTML `<form>` could always do, so asking first adds no protection.

```text
Browser (page on :5173)                         API on :5080
GET /api/projects
Origin: http://localhost:5173  ───────────────►  runs the handler!
◄───────────────  200 OK
                  Access-Control-Allow-Origin: http://localhost:5173
Browser: origin matches → JS may read the response.  (Missing/different → CORS error,
                                                       even though the server already ran.)
```

**2. Preflighted requests** — everything else: `PUT`/`PATCH`/`DELETE`, `Content-Type:
application/json`, an `Authorization` header, any custom header. Before sending, the browser asks
permission with an `OPTIONS` request:

```text
Browser (page on :5173)                              API on :5080
OPTIONS /api/projects                          ─────►  (no handler runs, no body)
Origin: http://localhost:5173
Access-Control-Request-Method: POST
Access-Control-Request-Headers: authorization,content-type
                                               ◄─────  204 No Content
                     Access-Control-Allow-Origin: http://localhost:5173
                     Access-Control-Allow-Methods: GET, POST, PUT, DELETE
                     Access-Control-Allow-Headers: Content-Type, Authorization
                     Access-Control-Max-Age: 600          (cache this answer for 10 min)
Browser: allowed → now sends the real request
POST /api/projects  + headers + JSON body      ─────►  runs the handler
                                               ◄─────  201 Created + Access-Control-Allow-Origin
```

If the preflight fails, the real request is **never sent**. Note that your page's JavaScript never
sees the `OPTIONS` request — only DevTools does.

Common mistakes:

- **"Fixing" CORS in the frontend.** It's the API (or a proxy) that must send the headers.
  `fetch(url, { mode: 'no-cors' })` silences the error but gives you an *opaque* response with no
  status and no body — useless. In development, the Vite proxy (from **Anatomy of a Vite Project**)
  sidesteps CORS by making the API appear on the page's own origin.
- **Thinking CORS protects your API.** It doesn't: curl, scripts and attackers ignore it. It protects
  **users' browsers**. Your API still needs authentication and authorization.
- **`Access-Control-Allow-Origin: *` with credentials.** When a request carries cookies
  (`credentials: 'include'`), browsers reject the wildcard; the server must echo the exact origin and
  send `Access-Control-Allow-Credentials: true`.
- **Preflight blocked by auth.** The browser never sends credentials on `OPTIONS`. If authentication
  runs before CORS and answers the preflight with `401`, you get a CORS error. In ASP.NET Core,
  `app.UseCors()` goes before `UseAuthentication()` / `UseAuthorization()`.
- **A crash disguised as CORS.** If the server throws and the error response lacks the CORS headers,
  the browser reports a CORS error that hides the real `500`. Check the status in the Network tab
  and the server logs before touching CORS settings.

:::quiz id=bc-08-q7 xp=15
Your page on `http://localhost:5173` calls the API on `http://localhost:5080`. Which `fetch` calls
trigger a **preflight**? (Select all that apply.)
- [x] `fetch(api + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })`
- [x] `fetch(api + '/api/projects', { headers: { Authorization: 'Bearer dev-token' } })`
- [x] `fetch(api + '/api/projects/3', { method: 'DELETE' })`
- [ ] `fetch(api + '/api/projects')`
- [ ] `fetch(api + '/api/projects', { method: 'POST', body: new URLSearchParams({ name: 'Docs' }) })`
> JSON content type, the `Authorization` header and the `DELETE` method are all outside the
> "simple" list, so each needs an `OPTIONS` check first. A plain GET is simple. The last one is the
> sneaky one: `URLSearchParams` makes `fetch` send `application/x-www-form-urlencoded` — exactly
> what an HTML form sends — so it goes straight out, with no preflight. That's also why CSRF
> protection can't rely on CORS.
:::

:::challenge id=bc-08-c2 lang=ts xp=40
title: Does this request need a preflight?
Write `needsPreflight(req)` that answers like the browser does. `req.pageOrigin` is the origin of the
page running the code (e.g. `http://localhost:5173`), `req.url` is what you pass to `fetch` (absolute
or relative), `req.method` is the method, and `req.headers` are the headers **your code** sets (not
the ones the browser adds, like `User-Agent` or `Cookie`).

Rules:

1. Same origin (scheme, host **and** port equal) → never a preflight. A relative URL is same-origin.
2. Method (case-insensitive) other than `GET`, `HEAD`, `POST` → preflight.
3. Any header whose name (case-insensitive) isn't `accept`, `accept-language`, `content-language` or
   `content-type` → preflight.
4. A `content-type` whose MIME type (the part before `;`, trimmed, case-insensitive) isn't
   `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain` → preflight.
5. Otherwise → no preflight.

(Real browsers add a few more rules — `Range` is also safelisted, safelisted header values have
length and character limits. Ignore those; the tests
only check rules 1–5. The full algorithm is in the Fetch Standard, "CORS-safelisted request-header".)

hint: `new URL(req.url, req.pageOrigin).origin` resolves relative URLs and gives you the origin to compare with `new URL(req.pageOrigin).origin`.
hint: Loop with `for (const [name, value] of Object.entries(req.headers))` and lowercase the name before comparing.
hint: For the content type: `value.split(';')[0].trim().toLowerCase()`.

```ts starter
type OutgoingRequest = {
  pageOrigin: string
  url: string
  method: string
  headers: Record<string, string>
}

export function needsPreflight(req: OutgoingRequest): boolean {
  // Is it cross-origin? Is the method simple? Are all headers safelisted?
  return false
}
```

```ts solution
type OutgoingRequest = {
  pageOrigin: string
  url: string
  method: string
  headers: Record<string, string>
}

const SIMPLE_METHODS = ['GET', 'HEAD', 'POST']
const SAFELISTED_HEADERS = ['accept', 'accept-language', 'content-language', 'content-type']
const SIMPLE_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']

export function needsPreflight(req: OutgoingRequest): boolean {
  const pageOrigin = new URL(req.pageOrigin).origin
  const target = new URL(req.url, pageOrigin)
  if (target.origin === pageOrigin) return false

  if (!SIMPLE_METHODS.includes(req.method.toUpperCase())) return true

  for (const [rawName, value] of Object.entries(req.headers)) {
    const name = rawName.toLowerCase()
    if (!SAFELISTED_HEADERS.includes(name)) return true
    if (name === 'content-type') {
      const mime = value.split(';')[0].trim().toLowerCase()
      if (!SIMPLE_CONTENT_TYPES.includes(mime)) return true
    }
  }
  return false
}
```

```ts tests
const page = 'http://localhost:5173'
const api = 'http://localhost:5080'

test('same origin never needs a preflight, even with JSON and auth', () => {
  expect(needsPreflight({ pageOrigin: page, url: page + '/api/projects', method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' } })).toBe(false)
})
test('relative URLs are same-origin', () => {
  expect(needsPreflight({ pageOrigin: page, url: '/api/projects', method: 'DELETE', headers: {} })).toBe(false)
})
test('a plain cross-origin GET is simple', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'GET', headers: {} })).toBe(false)
})
test('a different port is a different origin', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects/3', method: 'DELETE', headers: {} })).toBe(true)
})
test('localhost and 127.0.0.1 are different origins', () => {
  expect(needsPreflight({ pageOrigin: page, url: 'http://127.0.0.1:5173/api/projects', method: 'PUT', headers: {} })).toBe(true)
})
test('Authorization header triggers a preflight', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'GET',
    headers: { Authorization: 'Bearer dev-token' } })).toBe(true)
})
test('a custom header triggers a preflight', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'GET',
    headers: { 'X-Request-Id': 'abc' } })).toBe(true)
})
test('JSON content type triggers a preflight (any casing)', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'POST',
    headers: { 'content-type': 'Application/JSON; charset=utf-8' } })).toBe(true)
})
test('form-style content types are simple', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })).toBe(false)
  expect(needsPreflight({ pageOrigin: page, url: api + '/upload', method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=----x' } })).toBe(false)
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'POST',
    headers: { 'CONTENT-TYPE': ' application/x-www-form-urlencoded ' } })).toBe(false)
})
test('safelisted Accept headers stay simple', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'get',
    headers: { Accept: 'application/json', 'Accept-Language': 'de' } })).toBe(false)
})
test('method names are compared case-insensitively', () => {
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects', method: 'head', headers: {} })).toBe(false)
  expect(needsPreflight({ pageOrigin: page, url: api + '/api/projects/1', method: 'patch', headers: {} })).toBe(true)
})
```
:::

## REST resource design basics

REST is a style, not a standard, but most teams converge on the same habits. The core idea: URLs
name **things** (resources), methods say **what to do** with them.

| Do | Instead of | Why |
|---|---|---|
| `GET /api/projects` | `GET /api/getProjects` | The method is already the verb |
| `GET /api/projects/42` | `GET /api/project?id=42` | Plural collection, id in the path |
| `GET /api/projects?status=active&sort=-createdAt&page=2` | `GET /api/activeProjectsSortedPage2` | Filter, sort, page in the query |
| `GET /api/projects/42/tasks` | `GET /api/tasks?projectId=42` *(both fine)* | Nest only for real ownership, one level deep |
| `POST /api/projects` → `201` + `Location: /api/projects/43` | `200` + `{ "success": true }` | The status code *is* the result |
| `DELETE /api/projects/42` → `204` | `POST /api/projects/42/delete` | Idempotent, cache- and proxy-friendly |
| `POST /api/projects/42/archive` | stretching `PATCH` for a business action | Commands that don't fit CRUD can be sub-resources |
| Errors as `application/problem+json` | `200` + `{ "error": "..." }` | Clients, logs and monitoring understand status codes |

More conventions you'll meet: `PUT` replaces the whole resource while `PATCH` changes a part; large
lists are always **paginated** (offset `?page=2&pageSize=20` or a `?cursor=…`); breaking changes get a
new version (`/api/v2/…` or a header); and JSON field names are consistent (camelCase in .NET land).

:::quiz id=bc-08-q8 xp=10
Two users try to create a project called "Website relaunch". The second request is valid JSON with
a non-empty name, but names must be unique. What should the API answer?
- [ ] `400 Bad Request`
- [ ] `200 OK` with `{ "success": false, "error": "duplicate" }`
- [x] `409 Conflict` with a ProblemDetails body explaining the clash
- [ ] `412 Precondition Failed`
> The request itself is fine; it **conflicts with the current state** of the server — that's 409.
> 400 is for malformed requests (broken JSON, wrong types) and would make the client think its code
> is buggy. A `200` with an error flag hides the failure from every tool that reads status codes
> (fetch's `res.ok`, logs, monitoring). 412 is specifically for a failed precondition header like
> `If-Match`, which this request didn't send.
:::

## Reading a request: DevTools and curl -v

### The DevTools Network tab

Open DevTools (`F12` or `Ctrl/⌘ + Shift + I`) → **Network**, *then* reload or click the thing that
fires the request — the tab records only while it's open. The habits that make it useful:

- **Fetch/XHR** filter — hides images, scripts and fonts so you see API calls only.
- **Preserve log** — keeps requests across page navigations and redirects (login flows!).
- **Disable cache** — while DevTools is open, behave like a first visit.
- Click a request: **Headers** (URL, method, status, remote address, response and request headers),
  **Payload** (query and body you sent), **Preview / Response** (what came back), **Timing** (DNS,
  initial connection, SSL, *Waiting for server response* — that's your API's time — and download).
- Right-click → **Copy → Copy as cURL** to replay the exact request in a terminal or paste it into
  a ticket. (On Windows, Chrome offers **Copy as cURL (bash)** and **(cmd)** — pick the one matching
  the shell you'll paste into; Git Bash and WSL want *bash*.)
- CORS preflights appear as their own row: method `OPTIONS` (Chrome labels the type `preflight`).
- "Provisional headers are shown" means the request never completed or came from cache — you're not
  looking at what the server saw.

### curl -v

`curl -v` prints the whole conversation. Learn its three prefixes and you can read any of it:

```text
$ curl -v http://localhost:5080/api/projects/1
* Host localhost:5080 was resolved.                     ← * curl's own notes: DNS, connect, TLS
* IPv6: ::1
* IPv4: 127.0.0.1
*   Trying [::1]:5080...
* Established connection to localhost (::1 port 5080) from ::1 port 47900
* using HTTP/1.x
> GET /api/projects/1 HTTP/1.1                          ← > what you SENT
> Host: localhost:5080
> User-Agent: curl/8.23.0
> Accept: */*
>
* Request completely sent off
< HTTP/1.1 200 OK                                        ← < what came BACK
< Vary: Origin                                           ← "my answer depends on the Origin header"
< Cache-Control: no-cache
< ETag: "v1"
< Content-Type: application/json; charset=utf-8
< Content-Length: 46
< Date: Thu, 05 Nov 2026 15:52:10 GMT                   ← added by Node itself
< Connection: keep-alive                                 ← "I'll keep the connection open…"
< Keep-Alive: timeout=5                                  ← "…for 5 idle seconds"
<
{"id":1,"name":"Website relaunch","version":1}          ← the body (no prefix)
```

(This is curl 8.23; the exact `*` lines differ between curl versions — older ones print
`* Connected to localhost (::1) port 5080`. The `>` and `<` lines are the real HTTP and look the same
everywhere.) Useful companions:

```bash
curl -i  URL                       # status line + response headers + body (no * noise)
curl -sv URL -o /dev/null          # just the conversation, discard the body
curl --json '{"name":"x"}' URL     # POST JSON: sets Content-Type + Accept for you (curl 7.82+)
curl -H 'If-None-Match: "v1"' -i URL
curl -X DELETE -i URL
```

:::warn title="curl -I is a HEAD request"
`-I` sends `HEAD`, not `GET`. Some endpoints don't implement HEAD (or behave differently), so you
may see a `405` or different headers than the real GET — our lab API is one of them:
`curl -I http://localhost:5080/api/projects/1` answers `405 Method Not Allowed`. To see a GET's
headers use `-i`, or `-s -D - -o /dev/null` to print only the headers.
:::

:::job title="The first question in every API bug"
When a teammate says "the save button doesn't work", the fastest path is: Network tab → find the
request → note **method, URL, status, response body**. That alone tells you which side to look at:
4xx = the request (frontend or the user's input), 5xx = the server, red row with no status = network
or CORS. Then **Copy as cURL** and paste it in the ticket. Reviewers and backend colleagues love
tickets that include the failing request.
:::

:::pro title="Seniors read the wire, not the code"
Experienced developers debug integration issues from the outside in: they reproduce with `curl -v`
first, because it removes React, the browser cache and CORS from the equation in one step. If curl
works and the browser doesn't, the problem is in browser-only territory (CORS, cookies, cache, mixed
content). If curl fails too, it's the API or the network. This halving strategy beats reading code
for most "it doesn't talk to the backend" bugs.
:::

## Parse a raw response yourself

Tools show you responses already split into parts. Doing the split yourself once makes the format
stick: start line, headers, a blank line, then the body.

:::challenge id=bc-08-c1 lang=ts xp=40
title: Parse a raw HTTP response
Write `parseHttpResponse(raw)` that turns a raw response string into `{ status, headers, body }`:

```text
HTTP/1.1 201 Created
Location: http://localhost:5080/api/projects/3
Content-Type: application/json; charset=utf-8

{"id":3,"name":"Docs site"}
```

becomes `{ status: 201, headers: { location: 'http://localhost:5080/api/projects/3', 'content-type': 'application/json; charset=utf-8' }, body: '{"id":3,"name":"Docs site"}' }`.

- `status` is the number in the status line. The reason phrase may contain spaces (`404 Not Found`)
  or be missing entirely (`HTTP/2 204`).
- Header **names are lowercased** (they're case-insensitive), **values are trimmed**. A value may
  itself contain `:` (URLs, times) — split on the **first** colon only.
- A header that appears twice — compared **after** lowercasing, so `Vary` and `vary` are the same
  header — is joined with `", "` in the order it appeared (like `fetch`'s `Headers` does).
- Lines without a `:` after the status line can be skipped.
- The headers end at the first **empty line**. Everything after it is the body, **unchanged** —
  even if it contains empty lines. No empty line → body is `''`.
- Lines end with `\r\n` on the wire, but accept plain `\n` as well.

hint: A regex finds the header/body separator for both line endings: `/\r?\n\r?\n/.exec(raw)` — its `index` and `[0].length` tell you where to slice.
hint: Split only the head into lines (`head.split(/\r?\n/)`); the first line is the status line, `Number(line.split(' ')[1])` gives the code.
hint: For headers: `const i = line.indexOf(':')`, name = `line.slice(0, i)`, value = `line.slice(i + 1)`.

```ts starter
type ParsedResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export function parseHttpResponse(raw: string): ParsedResponse {
  // 1. split head and body at the first empty line
  // 2. status line -> status
  // 3. header lines -> lowercase name, trimmed value
  return { status: 0, headers: {}, body: '' }
}
```

```ts solution
type ParsedResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

export function parseHttpResponse(raw: string): ParsedResponse {
  const sep = /\r?\n\r?\n/.exec(raw)
  const head = sep ? raw.slice(0, sep.index) : raw
  const body = sep ? raw.slice(sep.index + sep[0].length) : ''

  const [statusLine, ...headerLines] = head.split(/\r?\n/)
  const status = Number(statusLine.trim().split(/\s+/)[1])

  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const i = line.indexOf(':')
    if (i === -1) continue
    const name = line.slice(0, i).trim().toLowerCase()
    const value = line.slice(i + 1).trim()
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value
  }
  return { status, headers, body }
}
```

```ts tests
const crlf = (...lines: string[]) => lines.join('\r\n')

test('reads status, headers and JSON body', () => {
  const r = parseHttpResponse(crlf(
    'HTTP/1.1 200 OK',
    'Content-Type: application/json; charset=utf-8',
    'Content-Length: 46',
    '',
    '{"id":1,"name":"Website relaunch","version":1}',
  ))
  expect(r.status).toBe(200)
  expect(r.headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'content-length': '46' })
  expect(JSON.parse(r.body).name).toBe('Website relaunch')
})
test('lowercases names and trims values', () => {
  const r = parseHttpResponse(crlf('HTTP/1.1 200 OK', 'ETag:    "v1"   ', 'X-Request-ID: abc', '', ''))
  expect(r.headers).toEqual({ etag: '"v1"', 'x-request-id': 'abc' })
})
test('splits on the first colon only', () => {
  const r = parseHttpResponse(crlf(
    'HTTP/1.1 201 Created',
    'Location: http://localhost:5080/api/projects/3',
    'Date: Thu, 05 Nov 2026 15:44:37 GMT',
    '',
    '{"id":3}',
  ))
  expect(r.status).toBe(201)
  expect(r.headers.location).toBe('http://localhost:5080/api/projects/3')
  expect(r.headers.date).toBe('Thu, 05 Nov 2026 15:44:37 GMT')
})
test('reason phrases with spaces, or none at all', () => {
  expect(parseHttpResponse(crlf('HTTP/1.1 404 Not Found', '', '')).status).toBe(404)
  expect(parseHttpResponse(crlf('HTTP/1.1 412 Precondition Failed', 'ETag: "v2"', '', '')).status).toBe(412)
  expect(parseHttpResponse(crlf('HTTP/2 204', 'date: Thu, 05 Nov 2026 15:44:37 GMT', '', '')).status).toBe(204)
})
test('no body means an empty string', () => {
  const noBlank = parseHttpResponse(crlf('HTTP/1.1 304 Not Modified', 'ETag: "v1"'))
  expect(noBlank.status).toBe(304)
  expect(noBlank.headers).toEqual({ etag: '"v1"' })
  expect(noBlank.body).toBe('')
  expect(parseHttpResponse(crlf('HTTP/1.1 204 No Content', 'Cache-Control: no-cache', '', '')).body).toBe('')
})
test('keeps the body exactly, including empty lines', () => {
  const body = 'line one\r\n\r\nline three: with a colon\r\n'
  const r = parseHttpResponse(crlf('HTTP/1.1 200 OK', 'Content-Type: text/plain', '') + '\r\n' + body)
  expect(r.body).toBe(body)
  expect(r.headers).toEqual({ 'content-type': 'text/plain' })
})
test('joins repeated headers with ", "', () => {
  const r = parseHttpResponse(crlf('HTTP/1.1 200 OK', 'Vary: Origin', 'Cache-Control: no-cache', 'vary: Accept-Encoding', '', '[]'))
  expect(r.headers.vary).toBe('Origin, Accept-Encoding')
  expect(r.headers['cache-control']).toBe('no-cache')
})
test('accepts plain \\n line endings', () => {
  const r = parseHttpResponse('HTTP/1.1 422 Unprocessable Content\nContent-Type: application/problem+json\n\n{"status":422}')
  expect(r.status).toBe(422)
  expect(r.headers['content-type']).toBe('application/problem+json')
  expect(r.body).toBe('{"status":422}')
})
```
:::

:::info title="Set-Cookie is the exception"
Joining repeated headers with a comma works for almost every header — but not `Set-Cookie`, whose
values can contain commas (in dates). That's why `fetch` gives it its own method,
`response.headers.getSetCookie()`. Our parser ignores the special case; real HTTP libraries don't.
:::

## Lab: watch real HTTP on the wire

:::lab id=bc-08-lab1 xp=80
title: curl -v and DevTools against the Projects API and a public API
You need a current Node.js LTS — 22 or newer (`node -v`) — and curl (`curl --version`). Use Chrome,
Edge or Firefox for the DevTools part.

:::warn title="On Windows, run the commands in Git Bash or WSL"
The commands below are bash: single-quoted JSON, `\` line continuations, `/dev/null`, `grep`,
`head`. PowerShell treats quotes and `\` differently (see **Terminal Survival Kit**), so use Git Bash
or WSL for this lab. Windows' built-in `curl.exe` may also lack HTTP/2 (check `Features:` in
`curl --version` for `HTTP2`); then step 6 shows `HTTP/1.1 200` instead of `HTTP/2 200` — that's fine.
:::

**1. Start the example API**

Create a folder `http-lab` and in it a file `api.mjs` — the Projects API on `:5080` plus a small demo
page on `:5500` (a different origin, so the browser applies CORS). It uses only Node built-ins:

```js
// api.mjs — a tiny Projects API on :5080 plus a demo page on :5500. No dependencies.
import http from 'node:http'

const API = 'http://localhost:5080'
const PAGE_ORIGIN = 'http://localhost:5500'
const TOKENS = { 'dev-token': 'editor', 'viewer-token': 'viewer' }

let nextId = 3
const projects = new Map([
  [1, { id: 1, name: 'Website relaunch', version: 1 }],
  [2, { id: 2, name: 'Mobile app', version: 1 }],
])
const etagOf = (p) => `"v${p.version}"`

function send(res, status, body, headers = {}) {
  const h = { 'Cache-Control': 'no-cache', ...headers }
  const payload = body === undefined ? '' : JSON.stringify(body)
  if (body !== undefined) {
    h['Content-Type'] ??= 'application/json; charset=utf-8'
    h['Content-Length'] = Buffer.byteLength(payload)
  }
  res.writeHead(status, h)
  res.end(payload)
}
const problem = (res, status, title, extra = {}) =>
  send(res, status, { type: 'about:blank', title, status, ...extra }, { 'Content-Type': 'application/problem+json' })

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

function role(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
  return m ? TOKENS[m[1]] : undefined
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, API)
  console.log(`${req.method} ${url.pathname}${url.search}  origin=${req.headers.origin ?? '-'}`)

  // CORS: only our demo page may read responses from another origin.
  res.setHeader('Vary', 'Origin') // the answer depends on Origin, so caches must key on it
  if (req.headers.origin === PAGE_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', PAGE_ORIGIN)
    res.setHeader('Access-Control-Expose-Headers', 'ETag, Location')
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match, If-None-Match')
    res.setHeader('Access-Control-Max-Age', '600')
    return send(res, 204)
  }

  if (url.pathname === '/projects') return send(res, 301, undefined, { Location: '/api/projects' })

  if (url.pathname === '/api/projects') {
    if (req.method === 'GET') return send(res, 200, [...projects.values()])
    if (req.method === 'POST') {
      if (!role(req)) return problem(res, 401, 'Missing or invalid bearer token')
      if (role(req) !== 'editor') return problem(res, 403, 'Viewers cannot create projects')
      if (!(req.headers['content-type'] ?? '').startsWith('application/json'))
        return problem(res, 415, 'Send Content-Type: application/json')
      let input
      try { input = JSON.parse(await readBody(req)) } catch { return problem(res, 400, 'Body is not valid JSON') }
      const name = typeof input?.name === 'string' ? input.name.trim() : ''
      if (!name) return problem(res, 422, 'Validation failed', { errors: { name: ['Name is required.'] } })
      if ([...projects.values()].some((p) => p.name.toLowerCase() === name.toLowerCase()))
        return problem(res, 409, `A project named '${name}' already exists`)
      const p = { id: nextId++, name, version: 1 }
      projects.set(p.id, p)
      return send(res, 201, p, { Location: `/api/projects/${p.id}`, ETag: etagOf(p) })
    }
    return problem(res, 405, 'Method not allowed')
  }

  const m = /^\/api\/projects\/(\d+)$/.exec(url.pathname)
  if (m) {
    const p = projects.get(Number(m[1]))
    if (!p) return problem(res, 404, `Project ${m[1]} not found`)
    if (req.method === 'GET') {
      if (req.headers['if-none-match'] === etagOf(p)) return send(res, 304, undefined, { ETag: etagOf(p) })
      return send(res, 200, p, { ETag: etagOf(p) })
    }
    if (req.method === 'PUT' || req.method === 'DELETE') {
      if (!role(req)) return problem(res, 401, 'Missing or invalid bearer token')
      if (role(req) !== 'editor') return problem(res, 403, 'Viewers cannot change projects')
      const ifMatch = req.headers['if-match']
      if (ifMatch && ifMatch !== etagOf(p))
        return problem(res, 412, 'Project was changed by someone else', { currentETag: etagOf(p) })
      if (req.method === 'DELETE') { projects.delete(p.id); return send(res, 204) }
      let input
      try { input = JSON.parse(await readBody(req)) } catch { return problem(res, 400, 'Body is not valid JSON') }
      const name = typeof input?.name === 'string' ? input.name.trim() : ''
      if (!name) return problem(res, 422, 'Validation failed', { errors: { name: ['Name is required.'] } })
      p.name = name
      p.version++
      return send(res, 200, p, { ETag: etagOf(p) })
    }
    return problem(res, 405, 'Method not allowed')
  }

  problem(res, 404, `No route for ${req.method} ${url.pathname}`)
}).listen(5080, () => console.log(`API  on ${API}`))

// ── The demo page: a different origin (port 5500), so the browser applies CORS ──
const page = `<!doctype html>
<meta charset="utf-8">
<title>HTTP lab</title>
<h1>HTTP lab</h1>
<button id="simple">1. Simple GET</button>
<button id="json">2. POST JSON (preflight)</button>
<button id="cond">3. GET project 1 twice (ETag)</button>
<pre id="out"></pre>
<script>
  const api = '${API}'
  const out = document.getElementById('out')
  const log = (s) => (out.textContent += s + '\\n')
  document.getElementById('simple').onclick = async () => {
    const r = await fetch(api + '/api/projects')
    log('GET /api/projects -> ' + r.status + ' ' + JSON.stringify(await r.json()))
  }
  document.getElementById('json').onclick = async () => {
    const r = await fetch(api + '/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dev-token' },
      body: JSON.stringify({ name: 'From the browser ' + Date.now() }),
    })
    log('POST /api/projects -> ' + r.status + ' Location: ' + r.headers.get('Location'))
  }
  document.getElementById('cond').onclick = async () => {
    const a = await fetch(api + '/api/projects/1')
    const etag = a.headers.get('ETag')
    const b = await fetch(api + '/api/projects/1', { headers: { 'If-None-Match': etag } })
    log('first -> ' + a.status + ' ETag ' + etag + ', second with If-None-Match -> ' + b.status)
  }
</script>`
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(page)
}).listen(5500, () => console.log('Page on http://localhost:5500'))
```

Start it and leave the terminal open — it logs every request it receives:

```bash
cd http-lab
node api.mjs
```

```text
API  on http://localhost:5080
Page on http://localhost:5500
```

**2. Read a conversation with curl -v**

In a second terminal:

```bash
curl -v http://localhost:5080/api/projects/1
```

Find the three kinds of lines. You should see `> GET /api/projects/1 HTTP/1.1` and `> Host:
localhost:5080` (what you sent), then `< HTTP/1.1 200 OK`, `< ETag: "v1"`, `< Content-Type:
application/json; charset=utf-8` (what came back), and finally the body
`{"id":1,"name":"Website relaunch","version":1}`.

**3. Walk through the status codes**

Run each command and compare the first line of the output with the comment:

```bash
# conditional GET: your copy is still current
curl -i -H 'If-None-Match: "v1"' http://localhost:5080/api/projects/1     # HTTP/1.1 304 Not Modified

# writes need a token: none / wrong role / right role
curl -i --json '{"name":"Docs site"}' http://localhost:5080/api/projects   # 401 Unauthorized
curl -i --json '{"name":"Docs site"}' -H "Authorization: Bearer viewer-token" \
  http://localhost:5080/api/projects                                       # 403 Forbidden
curl -i --json '{"name":"Docs site"}' -H "Authorization: Bearer dev-token" \
  http://localhost:5080/api/projects                                       # 201 Created, Location: /api/projects/3

# the same name again, then an empty name, then broken JSON
curl -i --json '{"name":"docs site"}' -H "Authorization: Bearer dev-token" http://localhost:5080/api/projects  # 409 Conflict
curl -i --json '{"name":"  "}'        -H "Authorization: Bearer dev-token" http://localhost:5080/api/projects  # 422 + errors.name
curl -i --json '{name:x}'             -H "Authorization: Bearer dev-token" http://localhost:5080/api/projects  # 400 Bad Request

# optimistic concurrency: the first PUT wins, the second has a stale ETag
curl -i -X PUT --json '{"name":"Website relaunch 2.0"}' -H "Authorization: Bearer dev-token" \
  -H 'If-Match: "v1"' http://localhost:5080/api/projects/1                 # 200 OK, ETag: "v2"
curl -i -X PUT --json '{"name":"Stale write"}' -H "Authorization: Bearer dev-token" \
  -H 'If-Match: "v1"' http://localhost:5080/api/projects/1                 # 412 Precondition Failed

# delete twice: idempotent, different responses
curl -i -X DELETE -H "Authorization: Bearer dev-token" http://localhost:5080/api/projects/3  # 204 No Content
curl -i -X DELETE -H "Authorization: Bearer dev-token" http://localhost:5080/api/projects/3  # 404 Not Found

# a redirect, without and with -L
curl -i  http://localhost:5080/projects                                    # 301, Location: /api/projects
curl -sL http://localhost:5080/projects                                    # the JSON list
```

The 412 body tells you what changed:
`{"type":"about:blank","title":"Project was changed by someone else","status":412,"currentETag":"\"v2\""}`.

Also notice that the 422 line reads `HTTP/1.1 422 Unprocessable Entity`: Node uses the code's older
name, which is exactly why programs look at the number and never at the phrase.

:::tip
No `--json` in your curl (older than 7.82)? Replace `--json '…'` with
`-H "Content-Type: application/json" -d '…'`. Restart `node api.mjs` any time to reset the data.
:::

**4. Fake a preflight by hand**

A preflight is just an `OPTIONS` request — you can send one yourself:

```bash
curl -i -X OPTIONS http://localhost:5080/api/projects \
  -H "Origin: http://localhost:5500" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

Expected: `HTTP/1.1 204 No Content` with `Access-Control-Allow-Origin: http://localhost:5500`,
`Access-Control-Allow-Methods: GET, POST, PUT, DELETE` and `Access-Control-Allow-Headers: Content-Type,
Authorization, If-Match, If-None-Match`. Change the `Origin` to `http://evil.example` and run it
again: the `Access-Control-Allow-Origin` header disappears — that's the API saying "no".

**5. The same requests in DevTools**

Restart the API first (`Ctrl+C`, then `node api.mjs`) so the data is fresh. Open
`http://localhost:5500` in your browser, open DevTools → **Network**, tick **Preserve log**, keep the
**All** filter (preflights don't always show under Fetch/XHR), then click the three buttons in order.
The page prints:

```text
GET /api/projects -> 200 [{"id":1,…},{"id":2,…}]
POST /api/projects -> 201 Location: /api/projects/3
first -> 200 ETag "v1", second with If-None-Match -> 304
```

In the Network tab:

- **Button 1** — one `GET`, no `OPTIONS` (a simple request). Click it and find `Origin:
  http://localhost:5500` in the request headers and `Access-Control-Allow-Origin` in the response.
- **Button 2** — an `OPTIONS` row (the preflight, `204`) right before the `POST` (`201`). In the
  preflight's request headers find `Access-Control-Request-Headers: authorization,content-type`.
  Open the POST's **Payload** tab to see the JSON you sent and **Timing** to see where time went.
- **Button 3** — the custom `If-None-Match` header also caused a preflight; the second GET is `304`.
- Click button 2 again: this time there's **no** `OPTIONS` row. The browser cached the preflight's
  answer for 600 seconds (`Access-Control-Max-Age`), per origin and URL. If you never see a preflight
  for button 2 at all, you probably clicked it within the last 10 minutes — open a private window
  and try again.
- Right-click the `POST` → **Copy → Copy as cURL**, paste it in a terminal, and run it: you get a
  `409 Conflict`, because a project with that name now exists. Same request, replayed from the shell.
- Watch the API's terminal: it logged `OPTIONS /api/projects  origin=http://localhost:5500` — the
  server sees preflights, your JavaScript never does.

**6. A real public API over HTTPS**

```bash
curl -sv -o /dev/null https://api.github.com/repos/dotnet/aspnetcore
```

Now the `*` lines show the whole picture from the start of the lesson:

- **DNS** — `Host api.github.com:443 was resolved` and the IP addresses.
- **TCP** — `Trying 20.…:443`.
- **TLS** — `ALPN: curl offers h2,http/1.1`, then the handshake (`TLSv1.3 (OUT), TLS handshake,
  Client hello`, `Server hello`, `Certificate`, `Finished`), `SSL connection using TLSv1.3 / …` and
  `ALPN: server accepted h2` (the protocol both sides agreed on).
- **The certificate** — `subject: CN=*.github.com`, the `issuer` (the authority that vouches for it),
  the expiry date, and `subjectAltName: "api.github.com" matches cert's "*.github.com"` — that line
  *is* the proof that you're talking to the real api.github.com.
- **HTTP** — the response `< HTTP/2 200` with **lowercase** header names (`content-type`,
  `cache-control: public, max-age=60, s-maxage=60`, `etag: W/"…"`, `x-ratelimit-remaining: …`).
  Unauthenticated calls are limited to 60 per hour — that header is how you'd know before hitting
  `403`/`429`.

:::warn title="Your TLS lines may look different"
How much of the handshake `-v` prints depends on your curl version and its TLS library: OpenSSL
builds (most Linux, Git Bash) print the `TLSv1.3 (OUT)…` lines; Windows' built-in `curl.exe`
(Schannel) and some macOS builds print less. `SSL connection using …` / the certificate block and the
`<` lines are what to look for. `curl --version` shows which TLS library you have.
:::

Finally, a conditional request against GitHub (bash/zsh):

```bash
ETAG=$(curl -s -D - -o /dev/null https://api.github.com/repos/dotnet/aspnetcore | grep -i '^etag:' | cut -d' ' -f2- | tr -d '\r')
echo "$ETAG"
curl -s -D - -o /dev/null -H "If-None-Match: $ETAG" https://api.github.com/repos/dotnet/aspnetcore | grep -iE '^(HTTP|x-ratelimit-remaining)'
```

Expected: the ETag (something like `W/"26f512…"`), then `HTTP/2 304` and the remaining quota. (If you
get `200`, the repository changed between the two calls — it's a busy repo; just run both again.) The
`304` saved the whole body, but notice `x-ratelimit-remaining` still went down: GitHub only exempts
`304`s from the rate limit for **authenticated** requests. Conditional requests save bandwidth; whether
they save quota is up to each API's documentation.

:::warn title="Never paste real tokens into commands you share"
Copy as cURL includes cookies and `Authorization` headers. Before pasting it into a ticket or chat,
delete those headers — a session cookie in a Jira ticket is a logged-in session for anyone who
reads it.
:::

Stop the API with `Ctrl+C` when you're done.

- [ ] `curl -v` shows `>` request lines and `<` response lines for `GET /api/projects/1`, with `ETag: "v1"`
- [ ] I produced 304, 401, 403, 201, 409, 422, 400, 200, 412, 204, 404 and 301 from the commands in step 3
- [ ] My hand-made `OPTIONS` request returns the `Access-Control-Allow-*` headers, and loses `Access-Control-Allow-Origin` for another origin
- [ ] In DevTools I saw the `OPTIONS` preflight before the `POST`, but none before the simple `GET`
- [ ] I replayed a request with **Copy as cURL** and got `409 Conflict`
- [ ] `curl -sv` against api.github.com shows DNS, TLS and the certificate's subject, then `HTTP/2 200` (or `HTTP/1.1 200` on a curl without HTTP/2), and the conditional request returns `304`
:::

## Flashcards

:::cards id=bc-08-cards1 xp=15 title="HTTP & APIs"
Q: What makes up an origin?
A: Scheme + host + port. `http://localhost:5173` and `http://localhost:5080` are different origins.
Q: Which part of a URL is never sent to the server?
A: The fragment (`#…`). It stays in the browser.
Q: What are the four parts of every HTTP message?
A: Start line (request line or status line), headers, an empty line, an optional body.
Q: Safe vs idempotent?
A: Safe = doesn't change server state (GET, HEAD, OPTIONS). Idempotent = repeating it leaves the same state (also PUT, DELETE). POST is neither, PATCH isn't guaranteed.
Q: 401 vs 403?
A: 401 = not authenticated ("who are you?"). 403 = authenticated but not allowed. Logging in again fixes 401, not 403.
Q: 409 vs 412 vs 422?
A: 409 = conflicts with current state (duplicate). 412 = an `If-Match` precondition failed (stale ETag). 422 = well-formed but invalid values.
Q: Who generates a 502, and what does it mean?
A: A proxy/gateway (nginx, ingress, load balancer): the app behind it gave no valid response — crashed, not ready, wrong port.
Q: `Cache-Control: no-cache` vs `no-store`?
A: `no-cache` = may store, but revalidate before each use. `no-store` = never store.
Q: What do `If-None-Match` and `If-Match` do with an ETag?
A: `If-None-Match` → 304 if unchanged (caching). `If-Match` → 412 if changed (optimistic concurrency).
Q: Content-Type vs Accept?
A: Content-Type describes the body you're sending; Accept says what you want back. Missing JSON Content-Type → often 415.
Q: When does the browser send a CORS preflight?
A: For cross-origin requests that aren't "simple": methods other than GET/HEAD/POST, non-safelisted headers (e.g. Authorization), or a Content-Type other than form/text types (e.g. application/json).
Q: Why does the request work in curl but fail with a CORS error in the browser?
A: CORS is enforced only by browsers, based on headers from the server. The API must return Access-Control-Allow-Origin (and answer the preflight); the frontend can't fix it.
Q: Cookie vs bearer token — key difference?
A: The browser attaches cookies automatically (→ CSRF risk, HttpOnly protects from reading). Bearer tokens are added by your code (→ no CSRF, but must be stored safely).
Q: Does `fetch` reject on a 404 or 500?
A: No — only on network failure. Check `res.ok` (2xx) yourself.
Q: What do `*`, `>` and `<` mean in `curl -v` output?
A: `*` = curl's notes (DNS, connect, TLS), `>` = request you sent, `<` = response you received.
:::

## Recap

- A URL is scheme, host, port, path, query and fragment; **origin = scheme + host + port**, and the
  fragment never reaches the server.
- Before HTTP come DNS (name → IP), TCP (connection) and TLS (identity + encryption); connections are
  reused because they're expensive.
- Every message is **start line, headers, empty line, body** — in DevTools, curl and on the wire.
- Methods carry promises: GET/HEAD/OPTIONS are safe; GET, PUT and DELETE are idempotent and can be
  retried; POST is not. Never change state on GET.
- Status families tell you where to look: 2xx done, 3xx elsewhere/cached, 4xx the request, 5xx the
  server (502/503 = the hop behind the proxy). Know 401 vs 403 and 409 vs 412 vs 422.
- `Content-Type` vs `Accept`, `Authorization`, `Cache-Control` (`no-cache` ≠ `no-store`) and `ETag`
  with `If-None-Match` (304) / `If-Match` (412) do most of the work.
- Cookies are attached by the browser (CSRF risk); bearer tokens by your code (preflight, storage risk).
- CORS is the browser asking the server for permission to let a page read cross-origin responses;
  non-simple requests get an `OPTIONS` preflight. Fix it on the server or with a dev proxy.
- REST: plural nouns, ids in the path, filters in the query, honest status codes, ProblemDetails errors.
- Debug from the outside in: Network tab for method/URL/status/body, then `curl -v` to take the
  browser out of the equation.
