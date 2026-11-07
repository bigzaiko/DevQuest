---
id: dsk-12
title: "Boss: BranchStory Desktop & Mobile Client"
level: expert
minutes: 300
xp: 250
summary: Build a BranchStory reader for desktop and phone from one shared .NET library (ViewModels, typed API client with auth, 404/409 handling, an ETag-revalidated offline cache, tests), with an Avalonia head, a MAUI head and release builds.
---

This is the region's final boss. Everything from the Desktop & Mobile region comes together in one
product: XAML layout, bindings, MVVM with CommunityToolkit.Mvvm, styles and dark mode, async
loading, headless tests, MAUI and packaging. You also connect it to the backend you built in the
Capstone. You will build the **BranchStory client**, a native reader for the branching stories
your Capstone API stores, and it runs on Windows, macOS, Linux, Android and iOS.

Until now QuestBoard talked to a tiny in-memory API (**Navigation, DI & Services**) or a fake server
(**MAUI Platform Features & Offline Data**). The boss has to talk to a **real server**, and real servers do awkward things: they reject expired tokens, answer `404` for a story
someone deleted a second ago, answer `409` because a colleague saved first, and sometimes don't
answer at all because the laptop is on a train. A client that handles all of that calmly is what
separates a demo from a product.

:::info title="What you need before the fight"
- The **.NET 10 SDK** and the Avalonia templates (`dotnet new install Avalonia.Templates`, from
  *Your First Avalonia App*). Avalonia **12.x** is what the templates generate today (the labs were
  built and tested with 12.1.5 and the .NET 10 SDK on Linux). If you're still on **11.x**, the
  small differences are called out where they matter.
- Your **Capstone BranchStory API** from *Mission Briefing: BranchStory* onwards, runnable on
  `http://localhost:5080` in Development. You can build and test every lab without it, because the
  tests use fakes, but the "run it for real" steps need it.
- For the mobile phase: **Windows or macOS** with `dotnet workload install maui`. Linux cannot
  build MAUI apps (more on that below).
:::

## The mission

**BranchStory** (from the Capstone) stores a story as a graph. Each **scene** is a *node* (a title
and some text), and each **choice** is an *edge* that leads from one scene to another. A reader
starts at the *start scene* and picks choices until they reach an ending. The web app already has
an editor and a player. Product now wants **native apps**:

| As a… | I want to… | So that… |
|---|---|---|
| Author | see **my stories** in a desktop app and read through them | I can proof-read a branch without opening the web editor |
| Author or editor | fix a typo in a scene right in the reader | small fixes don't need the full editor |
| Reader | open a **published story** by its link slug on my phone | I can read on the bus |
| Anyone | keep reading stories I opened before **when I'm offline** | a train tunnel doesn't end the story |
| Anyone | switch to **dark mode** | reading at night doesn't hurt |

Acceptance criteria, the way a ticket would phrase them:

1. Sign in with the **dev token** locally; the design must allow swapping in **OIDC** (Keycloak) later
   without touching the ViewModels.
2. **My stories** lists `GET /api/projects`. **Read** opens a published story by slug
   (`GET /api/public/stories/{slug}`).
3. The reader walks the graph: current scene, its choices, back, restart. Choices pointing at
   missing scenes are hidden. Loops are allowed and are labelled.
4. Every `GET` is cached on disk with its **ETag** and revalidated with `If-None-Match`. When the
   network fails, the app shows the cached copy and says it is offline.
5. A `404` removes the cached copy and explains what happened. A `409` on save **keeps the user's
   text** and offers a reload.
6. One shared library holds all ViewModels and logic. The **Avalonia** desktop app and the **MAUI**
   mobile app are thin "heads" on top of it.
7. ViewModel tests and headless UI tests run in CI on Linux, and release builds exist for each OS.

:::job title="This is what a client ticket at a product company looks like"
Native clients for an existing web product are common work: field-service apps, internal tools,
kiosk apps, "our customers want a desktop app". The API already exists and isn't yours to change
on a whim, so you work from its **contract** (routes, status codes, headers) and make the client
robust against everything that contract allows. Interviewers ask about exactly these situations:
"what does your app do when the token expires? When the server returns 409? When there is no
network?"
:::

## Architecture: one library, two heads

The key decision comes first: **where does each piece of code live?** If the ViewModels live inside
the Avalonia project, the MAUI app can't use them, and you'd write every feature twice. So the
solution is split like this:

```text
BranchStoryClient/
├── BranchStoryClient.slnx
├── src/
│   ├── BranchStory.Client/          ← shared class library (net10.0), NO UI framework references
│   │   ├── Models/                    DTO records + source-generated JSON context
│   │   ├── Api/                       typed API client, auth (token provider + handler), ApiResult
│   │   ├── Cache/                     offline cache (file + memory) with ETags
│   │   ├── Story/                     StoryGraph + StoryWalker (graph walking, cycle detection)
│   │   └── ViewModels/                Shell, SignIn, StoryList, Reader + INavigator, IThemeService
│   ├── BranchStory.Desktop/         ← Avalonia head: Views (.axaml), ViewLocator, theme service
│   └── BranchStory.Mobile/          ← MAUI head: Pages (.xaml), navigator, theme service
└── tests/
    ├── BranchStory.Client.Tests/    ← xUnit v3: API client against a fake network, walker, ViewModels
    └── BranchStory.Desktop.Tests/   ← Avalonia headless: real windows, real clicks, no screen
```

A **head** is a small app project that only contains what is specific to one UI framework: views,
the app start-up, and implementations of a few interfaces. Everything else sits in the library.

| Concern | Lives in | Why there |
|---|---|---|
| What a page shows and does (ViewModels, commands) | `BranchStory.Client` | identical on every platform, unit-testable without a window |
| HTTP, auth, cache, graph logic | `BranchStory.Client` | no UI at all |
| "Go to the reader page" | interface `INavigator` in the library, implemented per head | desktop swaps a `ContentControl`; mobile pushes onto the native navigation stack |
| "Switch to dark mode" | interface `IThemeService` in the library, implemented per head | Avalonia uses `ThemeVariant`, MAUI uses `AppTheme` |
| Pixels: XAML views, styles | each head | Avalonia's XAML and MAUI's XAML are different dialects |

The rule that keeps this honest: **the library must not reference Avalonia or MAUI.** If a
ViewModel ever needs a UI type, that's a sign the work belongs behind an interface.

:::quiz id=dsk-12-q1 xp=10
Which of these belong in the shared `BranchStory.Client` library? (Select all that apply.)
- [x] `ReaderViewModel` with its `ChooseCommand` and `SaveEditCommand`
- [x] The `IThemeService` **interface**
- [ ] The `AvaloniaThemeService` class that sets `Application.RequestedThemeVariant`
- [x] The offline cache and the ETag logic
- [ ] `ReaderView.axaml`
> The library holds everything that is the same on every platform: ViewModels, the API client, the cache and the interfaces (`IThemeService`, `INavigator`) the ViewModels need. Anything that touches a UI framework type, such as `Application.RequestedThemeVariant` or an `.axaml` file, lives in the head. If the library referenced Avalonia, the MAUI head couldn't use it, and the tests would need a UI platform.
:::

:::pro title="Seniors draw this line before writing code"
"Where does this code live?" is cheap to answer on day one and very expensive to fix in month six,
when 40 ViewModels import `Avalonia.Media.Color`. A common team rule is a build check: the shared
project has no `PackageReference` to any UI framework, and a test (or an architecture-test library
such as NetArchTest) fails the build if one appears.
:::

## Phase 1: the API contract, seen from the client

The Capstone lessons defined the API. A client only needs part of it:

| Route | Auth | Success | Failures the client must handle |
|---|---|---|---|
| `POST /api/dev/token {username}` | anonymous, **Development only** | `{accessToken, expiresAt}` | `404` when the API runs in Production (the route doesn't exist) |
| `GET /api/projects` | bearer | `ProjectSummary[]` | `401` expired token |
| `GET /api/projects/{id}` | bearer, viewer+ | `ProjectDetail` with `doc`, header `ETag: "<version>"` (always a full `200`: this route doesn't answer `304`) | `404` deleted or not shared with you, `401` |
| `PUT /api/projects/{id}/doc {doc, expectedVersion}` | bearer, editor+ | `{version, updatedAt}` | `409` + `currentVersion` (someone saved first), `403` (viewer), `404` |
| `GET /api/public/stories/{slug}` | anonymous | `PlayerStory`, `Cache-Control: public, max-age=60`, an `ETag` (from *Ship It*) | `404` unpublished or wrong slug, `304` when `If-None-Match` matches |

A few terms, because the rest of the lesson leans on them:

- **Route** and **contract**: a route is one URL pattern plus HTTP method (`GET /api/projects`); the
  contract is the full list of routes with their request bodies, response bodies, status codes and
  headers. The client is written against the contract, not against the server's code.
- **DTO** (data transfer object): a plain type whose only job is to mirror the JSON on the wire. In
  C# a `record` is perfect: `public sealed record SaveDocResponse(int Version, DateTimeOffset UpdatedAt);`
- **Bearer token**: a string the client sends as `Authorization: Bearer <token>`. Whoever *bears*
  it is treated as signed in, so it's short-lived and never logged.
- **ETag** (entity tag): a version label the server sends with a response, for example `ETag: "7"`.
  Next time the client sends `If-None-Match: "7"`, meaning "only send the body if it's no longer
  version 7". If nothing changed, the server answers **`304 Not Modified`** with an empty body.
- **ProblemDetails**: the standard JSON error body (RFC 9457): `{"type", "title", "status", "detail"}`
  plus extensions. BranchStory adds `currentVersion` to its 409s.

The two story shapes differ. `ProjectDetail.doc` is the *editor* format (nodes and edges lists),
and `PlayerStory` is the *published* format (scenes in a dictionary, choices inside each scene).
The client turns both into one `StoryGraph` so that the reader only knows one shape:

```csharp
// editor format → reader format, one scene at a time
var byFrom = doc.Edges.ToLookup(e => e.From);          // all edges grouped by their source scene
foreach (var node in doc.Nodes)
    scenes[node.Id] = new PlayerScene(node.Title, node.Text, node.MediaUrl,
        byFrom[node.Id].Select(e => new PlayerChoice(e.Label, e.To)).ToList(), End: false);
```

### JSON without reflection

`System.Text.Json` normally inspects your types with **reflection** (reading type information at
run time). Mobile release builds and trimmed desktop builds remove code that *looks* unused, and
reflection-only usage looks unused. The fix is a **source-generated JSON context**: a partial class
the compiler fills in with serialization code for exactly the types you list.

```csharp
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]   // camelCase, case-insensitive: what ASP.NET sends
[JsonSerializable(typeof(PlayerStory))]
public partial class ClientJson : JsonSerializerContext { }

var story = JsonSerializer.Deserialize(json, ClientJson.Default.PlayerStory);   // no reflection
```

:::quiz id=dsk-12-q2 xp=10
Why does the client use a source-generated `ClientJson` context instead of plain
`JsonSerializer.Deserialize<PlayerStory>(json)`?
- [ ] It is the only way to read camelCase JSON
- [x] Trimmed builds (iOS, Android, trimmed single-file desktop builds) can remove the members reflection would need; generated code keeps them and is faster
- [ ] Reflection-based serialization doesn't work in .NET 10
- [ ] It makes the JSON smaller on the wire
> Reflection-based serialization still works in .NET 10 and reads camelCase fine with `JsonSerializerDefaults.Web`. The problem is the **trimmer**: it removes code that looks unused, and properties only touched through reflection look unused. You then get empty objects or exceptions only in Release builds on a phone. The source generator writes the serialization code at compile time, so nothing is invisible to the trimmer, and start-up is faster too. The JSON on the wire is identical.
:::

## Phase 2: auth, dev tokens now and OIDC later

The ViewModels should not care *how* a token is obtained. So the library defines one small
interface, and the HTTP layer depends only on it:

```csharp
public interface ITokenProvider
{
    ValueTask<string?> GetTokenAsync(CancellationToken ct = default);
    void Invalidate();   // "this token was rejected, get a new one next time"
}
```

`DevTokenProvider` calls `POST /api/dev/token`, keeps the token in memory and renews it a minute
before `expiresAt`. (The Capstone only accepts usernames made of lowercase letters, digits and
dashes, so `ada` works and `Ada` gets a `400`.) It reads the clock through .NET's **`TimeProvider`**
instead of `DateTimeOffset.UtcNow`, so a test can pass in a fake clock and check expiry without
waiting. A `SemaphoreSlim(1, 1)` (a lock that works with `await`) makes sure two
requests starting at the same moment don't sign in twice.

The token is attached by a **`DelegatingHandler`**: a class that sits in `HttpClient`'s pipeline
and runs around every request, the client-side twin of ASP.NET Core middleware.

```csharp
protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
{
    if (await tokens.GetTokenAsync(ct) is { } token)
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
    var response = await base.SendAsync(request, ct);   // the next handler (finally: the network)
    if (response.StatusCode == HttpStatusCode.Unauthorized) tokens.Invalidate();
    return response;
}
```

A **handler pipeline** is a chain: `HttpClient` → `BearerTokenHandler` → transport → network. Each
handler can change the request on the way out and look at the response on the way back.
`ClientServices.Create(...)` wires it together: one *transport* handler (the thing that really
opens sockets), an anonymous `HttpClient` for the token endpoint, and an authenticated `HttpClient`
with `BearerTokenHandler` in front of the same transport. Both use a 10-second timeout, because the
default of 100 seconds feels like a frozen app.

### OIDC for real deployments

In production BranchStory signs in through **Keycloak** with **OIDC** (OpenID Connect, the identity
layer on top of OAuth 2.0). A native app is a **public client**: anything you ship inside an app
binary can be extracted, so it **cannot keep a client secret**. The flow for public clients is the
**authorization code flow with PKCE**:

1. The app creates a random `code_verifier` and sends its hash (`code_challenge`) along when it opens
   the login page in the **system browser** (not an embedded web view: the browser already has the
   user's password manager, and the app never sees the password).
2. The user signs in; Keycloak redirects to the app's **redirect URI** with a one-time `code`.
   Desktop apps listen on a **loopback** address such as `http://127.0.0.1:7890/callback`; mobile
   apps register a custom scheme such as `branchstory://callback`.
3. The app swaps the `code` plus the original `code_verifier` for tokens. An attacker who intercepted
   the code doesn't have the verifier, so the code is useless to them. That's what PKCE ("proof key
   for code exchange") buys you.

In .NET the usual library is **Duende.IdentityModel.OidcClient**; on MAUI you open the browser with
`WebAuthenticator.Default.AuthenticateAsync(...)`. Either way you end up with a new class that
implements `ITokenProvider`. Here's the outline (it's not part of the lab build):

```csharp
// Sketch: an OIDC-backed token provider. Nothing else in the app changes.
public sealed class OidcTokenProvider(OidcClient oidc, ISecretStore secrets) : ITokenProvider
{
    private string? _access; private DateTimeOffset _expires;

    public async ValueTask<string?> GetTokenAsync(CancellationToken ct = default)
    {
        if (_access is not null && _expires > DateTimeOffset.UtcNow.AddMinutes(1)) return _access;
        var refresh = await secrets.GetAsync("refresh_token");
        var result = refresh is null
            ? await oidc.LoginAsync(cancellationToken: ct)                    // opens the system browser
            : await oidc.RefreshTokenAsync(refresh, cancellationToken: ct);   // silent
        // store result.RefreshToken in the OS keychain, keep the access token in memory only
        ...
    }
    public void Invalidate() => _access = null;
}
```

:::warn title="Where tokens may live"
The **access token** stays in memory. A **refresh token** (long-lived, gets new access tokens)
goes into the operating system's secret store only: Windows Credential Manager or DPAPI, the macOS
or iOS Keychain, Android Keystore (MAUI's `SecureStorage` wraps the mobile ones), libsecret on
Linux. Never write either to a settings JSON file, never log them, and never put them in a URL.
:::

:::quiz id=dsk-12-q3 xp=10
The desktop client must sign in against Keycloak in production. Which approach is correct?
- [ ] Show your own username/password text boxes and send them to Keycloak (password grant)
- [ ] Ship the Keycloak client secret in `appsettings.json` and use the client-credentials flow
- [x] Authorization code flow with PKCE in the system browser, redirecting to a loopback address the app listens on
- [ ] Open the login page in an embedded web view and read the token out of the page's cookies
> A native app is a public client: anything in the binary can be extracted, so it can't hold a secret, and client credentials would sign in *the app*, not the user. Your own password boxes (the deprecated password grant) teach users to type passwords into random apps and break MFA and single sign-on. Embedded web views hide the address bar and let the app read everything the user types. RFC 8252 ("OAuth for native apps") recommends exactly this: the system browser, PKCE, and a loopback or custom-scheme redirect.
:::

## Phase 3: talking HTTP without crashing

A beginner's API client throws an exception for every non-200 response, and each ViewModel then
wraps every call in `try/catch`. That spreads HTTP knowledge (status codes) all over the UI code.
The boss client instead returns a **result type** that says what happened in words the UI
understands:

```csharp
public enum ApiStatus { Ok, NotFound, Conflict, Unauthorized, Forbidden, Offline, Failed }
public enum DataSource { Network, Revalidated, OfflineCache }

var result = await api.GetProjectAsync(id);
if (result.Status == ApiStatus.NotFound) Status = "This story no longer exists…";
```

The mapping lives in exactly one place, `BranchStoryApi`:

| Wire | `ApiStatus` | What the UI does |
|---|---|---|
| `2xx` | `Ok` | show it |
| `304` with a cached copy | `Ok`, source `Revalidated` | show the cached copy, it's current |
| no connection, DNS failure, timeout | `Ok` + `OfflineCache` if cached, else `Offline` | show the copy with an "Offline" banner, or explain |
| `5xx` with a cached copy | `Ok` + `OfflineCache` | a stale copy beats an error page |
| `401` | `Unauthorized` | handler drops the token; UI says "sign in again" |
| `403` | `Forbidden` | access was revoked: drop the cached copy |
| `404` | `NotFound` | deleted, unpublished or unshared: drop the cached copy |
| `409`, `412` | `Conflict`, with `currentVersion` | keep the draft, offer a reload |

Two details matter in that code:

- **Which exceptions mean "offline"?** `HttpRequestException` (no route, refused, DNS) and
  `TaskCanceledException` *when the caller didn't cancel*: that's `HttpClient.Timeout` firing. If the
  user pressed Back and the `CancellationToken` was cancelled, it's not a network problem, and it
  must not show an "offline" banner.
- **Writes are never queued silently.** A failed `PUT` reports `Offline` and keeps the draft in the
  box. An offline *write queue* is possible (*MAUI Platform Features & Offline Data* built one for
  QuestBoard), but for a shared story it would replay old edits on top of other people's work.

### The 409 dance

Optimistic concurrency (from *Concurrency & Sharing* in the Capstone) means every save says which
version it was based on: `PUT …/doc {doc, expectedVersion: 4}`. If someone else saved version 5 in
the meantime, the server refuses with `409` and `currentVersion: 5`. The client's job:

1. **Keep what the user typed.** Losing someone's text is the worst possible outcome.
2. Say clearly what happened: "Someone saved version 5 while you were editing."
3. Offer **Reload latest**: fetch version 5 and keep the draft in the box. The user checks the new
   text and saves again, now with `expectedVersion: 5`.

```csharp
case ApiStatus.Conflict:
    HasConflict = true;   // shows the "Reload latest" button
    Status = $"Someone saved version {result.Problem?.CurrentVersion} while you were editing. " +
             "Reload to get it; your text stays in the box.";
    break;
```

:::quiz id=dsk-12-q4 xp=15
Ada edits a scene in the desktop reader. When she presses **Save**, the API answers `409` with
`currentVersion: 5` (her edit was based on version 4). What should the client do?
- [ ] Retry the same `PUT` with `expectedVersion: 5` automatically, so the save goes through
- [x] Keep her draft, tell her someone saved version 5, and offer to reload the latest version so she can check and save again
- [ ] Discard the draft and reload, because the server's version always wins
- [ ] Treat it as a network error and retry with exponential backoff
> An automatic retry with the new version silently **overwrites** whatever the other person saved, which is exactly the "last write wins" bug optimistic concurrency exists to prevent. Discarding loses Ada's work. Backoff makes no sense, because 409 isn't a temporary failure and the next try fails the same way. The respectful answer keeps the draft, explains, and lets a human merge. Real editors sometimes merge automatically when the two edits touch different scenes, but that's a feature built on top of this flow, not a replacement for it.
:::

## Phase 4: an offline cache with ETag revalidation

**Why cache at all?** Two reasons: start-up speed (show the last list instantly) and offline
reading. **Why ETags?** Because without them the client must either download the full story every
time (slow, burns mobile data) or guess how long a copy stays valid (stale data). With an ETag the
client asks a cheap question, "is version X still current?", and gets a tiny `304` most of the time.

The flow for every `GET`:

```text
cached = cache[url]                        # may be null
send GET url  (+ If-None-Match: cached.etag  if we have one)
├─ network error / timeout ─▶ cached ? show cached (OFFLINE) : "offline, not cached"
├─ 304                     ─▶ show cached, refresh cached.savedAt          (REVALIDATED)
├─ 200                     ─▶ cache[url] = {etag, body, now}; show body    (NETWORK)
├─ 404 / 403               ─▶ delete cache[url]; explain
├─ 5xx                     ─▶ cached ? show cached (OFFLINE) : error
└─ other                   ─▶ error with ProblemDetails title
```

`FileStoryCache` stores one JSON file per URL:

- **The file name is a hash of the URL** (`SHA256` → hex). URLs contain `/` and `?`, which aren't
  valid in file names, and a hash also hides story slugs from anyone browsing the folder.
- **Writes are atomic**: write `abc.json.tmp`, then `File.Move(temp, path, overwrite: true)`. A rename
  replaces the file in one step, so a crash mid-write never leaves half a JSON file behind. A
  corrupt file is treated as a cache miss, never as a crash.
- **One folder per API and user** (`cache/localhost_5080/ada/`). Ada's private stories must not
  appear when Grace signs in on the same laptop.

One honest detail about the Capstone server: only `GET /api/public/stories/{slug}` (since *Ship
It*) answers `If-None-Match` with a `304`. `GET /api/projects/{id}` sends an `ETag` but always
replies with a full `200`, and `GET /api/projects` sends no `ETag` at all. The client logic still
works for those routes (a `200` simply replaces the cached copy, and the offline fallback works
the same way); you just don't save any bytes there until the API learns `304` on those routes too.

`Cache-Control: max-age=60` means "this copy may be reused for 60 seconds without asking". The
browser respects it for you. A native client must do it itself if it
wants to skip the network for "fresh" entries. The challenge below adds that rule, plus one more
that real clients need: two screens asking for the same URL at the same moment should share **one**
request.

:::quiz id=dsk-12-q5 xp=10
The cache holds `/api/public/stories/the-gate` with `ETag: "3-1730"`. The client sends
`If-None-Match: "3-1730"` and the server answers `304 Not Modified`. What is true? (Select all that apply.)
- [x] The response has no body; the client shows its cached copy
- [x] The client should update the entry's "saved at" time, since the copy was just confirmed current
- [ ] The client must delete the entry, because 304 is a redirect
- [ ] The client should show an "Offline" banner, because the data came from the cache
> `304` means "your copy is still current", so the body is empty and the cached copy is used. Updating `savedAt` records that it was just confirmed, which matters for freshness rules like `max-age`. `304` is in the 3xx range but it isn't a redirect, and nothing should be deleted. "Offline" is only right when the server could not be reached at all; a revalidated copy is as current as a fresh download.
:::

:::challenge id=dsk-12-c2 lang=ts xp=80
title: Offline cache with ETag revalidation
Write `createStoryCache(fetcher, store, now, maxAgeMs)`. It returns an object with
`get(url): Promise<CacheResult>`. The types are in the setup block. `fetcher(url, headers)` performs
the request: it **rejects** when there is no network, otherwise it resolves `{ status, etag?, body? }`.
`store` is a `Map` of cached entries and `now()` returns the current time in milliseconds.

Rules for `get(url)`:

1. **Fresh**: if there is an entry with `now() - savedAt < maxAgeMs`, return `{ body, source: 'cache' }`
   **without** calling `fetcher`.
2. Otherwise call `fetcher(url, headers)`. `headers` is `{ 'If-None-Match': entry.etag }` when a
   cached entry has an etag, else `{}`.
3. `2xx`: store `{ etag, body, savedAt: now() }` (leave `etag` out when the response has none) and
   return `source: 'network'`.
4. `304` with an entry: keep the body, set `savedAt` to `now()`, return `source: 'revalidated'`.
5. `404`: delete the entry and reject with `Error('not-found')`.
6. `fetcher` rejects, or status `>= 500`: with an entry return `{ body: entry.body, source: 'offline' }`
   (don't change `savedAt`); without one reject with `Error('offline')`.
7. Any other status: reject with `Error('HTTP <status>')`, for example `HTTP 401`. Keep the entry.
8. **Concurrent calls** for the same URL while a request is in flight return the **same promise**,
   so `fetcher` runs once. Once it settles, the next call may fetch again.

hint: Keep a `Map<string, Promise<CacheResult>>` of in-flight requests. In `get`, return the running promise if there is one; otherwise start `load(url)`, store it, and remove it in `.finally(...)`.
hint: Wrap only the `await fetcher(...)` in `try/catch`. Everything after it decides on `res.status`.
hint: For the "no etag" case build the entry conditionally: `res.etag ? { etag: res.etag, body, savedAt } : { body, savedAt }`.

```ts setup
interface HttpResult { status: number; etag?: string; body?: string }
type Fetcher = (url: string, headers: Record<string, string>) => Promise<HttpResult>
interface Entry { etag?: string; body: string; savedAt: number }
type Source = 'cache' | 'network' | 'revalidated' | 'offline'
interface CacheResult { body: string; source: Source }
```

```ts starter
export function createStoryCache(
  fetcher: Fetcher,
  store: Map<string, Entry>,
  now: () => number,
  maxAgeMs: number,
) {
  return {
    async get(url: string): Promise<CacheResult> {
      const res = await fetcher(url, {})
      return { body: res.body ?? '', source: 'network' }
    },
  }
}
```

```ts solution
export function createStoryCache(
  fetcher: Fetcher,
  store: Map<string, Entry>,
  now: () => number,
  maxAgeMs: number,
) {
  const inFlight = new Map<string, Promise<CacheResult>>()

  async function load(url: string): Promise<CacheResult> {
    const entry = store.get(url)
    if (entry && now() - entry.savedAt < maxAgeMs) return { body: entry.body, source: 'cache' }

    const headers: Record<string, string> = {}
    if (entry?.etag) headers['If-None-Match'] = entry.etag

    let res: HttpResult
    try {
      res = await fetcher(url, headers)
    } catch {
      if (entry) return { body: entry.body, source: 'offline' }
      throw new Error('offline')
    }

    if (res.status === 304 && entry) {
      store.set(url, { ...entry, savedAt: now() })
      return { body: entry.body, source: 'revalidated' }
    }
    if (res.status >= 200 && res.status < 300) {
      const body = res.body ?? ''
      store.set(url, res.etag ? { etag: res.etag, body, savedAt: now() } : { body, savedAt: now() })
      return { body, source: 'network' }
    }
    if (res.status === 404) {
      store.delete(url)
      throw new Error('not-found')
    }
    if (res.status >= 500) {
      if (entry) return { body: entry.body, source: 'offline' }
      throw new Error('offline')
    }
    throw new Error(`HTTP ${res.status}`)
  }

  return {
    get(url: string): Promise<CacheResult> {
      const running = inFlight.get(url)
      if (running) return running
      const promise = load(url).finally(() => inFlight.delete(url))
      inFlight.set(url, promise)
      return promise
    },
  }
}
```

```ts tests
const URL1 = '/api/public/stories/the-gate'

function fakeNet(responses: Array<HttpResult | 'down'>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetcher: Fetcher = async (url, headers) => {
    calls.push({ url, headers: { ...headers } })
    const next = responses.shift()
    if (next === undefined) throw new Error('unexpected extra request')
    if (next === 'down') throw new TypeError('Failed to fetch')
    return next
  }
  return { fetcher, calls }
}

test('first load comes from the network and is stored with its ETag', async () => {
  const net = fakeNet([{ status: 200, etag: '"v1"', body: 'story v1' }])
  const store = new Map<string, Entry>()
  const cache = createStoryCache(net.fetcher, store, () => 1000, 60000)
  expect(await cache.get(URL1)).toEqual({ body: 'story v1', source: 'network' })
  expect(net.calls[0].headers).toEqual({})
  expect(store.get(URL1)).toEqual({ etag: '"v1"', body: 'story v1', savedAt: 1000 })
})

test('a fresh entry is served without any request', async () => {
  const net = fakeNet([])
  const store = new Map<string, Entry>([[URL1, { etag: '"v1"', body: 'cached', savedAt: 1000 }]])
  const cache = createStoryCache(net.fetcher, store, () => 1000 + 59999, 60000)
  expect(await cache.get(URL1)).toEqual({ body: 'cached', source: 'cache' })
  expect(net.calls).toHaveLength(0)
})

test('an old entry is revalidated with If-None-Match and a 304 refreshes savedAt', async () => {
  const net = fakeNet([{ status: 304 }])
  const store = new Map<string, Entry>([[URL1, { etag: '"v1"', body: 'cached', savedAt: 0 }]])
  const cache = createStoryCache(net.fetcher, store, () => 90000, 60000)
  expect(await cache.get(URL1)).toEqual({ body: 'cached', source: 'revalidated' })
  expect(net.calls[0].headers).toEqual({ 'If-None-Match': '"v1"' })
  expect(store.get(URL1)).toEqual({ etag: '"v1"', body: 'cached', savedAt: 90000 })
})

test('a 200 on revalidation replaces the entry', async () => {
  const net = fakeNet([{ status: 200, etag: '"v2"', body: 'story v2' }])
  const store = new Map<string, Entry>([[URL1, { etag: '"v1"', body: 'cached', savedAt: 0 }]])
  const cache = createStoryCache(net.fetcher, store, () => 90000, 60000)
  expect(await cache.get(URL1)).toEqual({ body: 'story v2', source: 'network' })
  expect(store.get(URL1)).toEqual({ etag: '"v2"', body: 'story v2', savedAt: 90000 })
})

test('no network: the cached copy is served as offline and savedAt is unchanged', async () => {
  const net = fakeNet(['down'])
  const store = new Map<string, Entry>([[URL1, { etag: '"v1"', body: 'cached', savedAt: 0 }]])
  const cache = createStoryCache(net.fetcher, store, () => 90000, 60000)
  expect(await cache.get(URL1)).toEqual({ body: 'cached', source: 'offline' })
  expect(store.get(URL1)?.savedAt).toBe(0)
})

test('no network and nothing cached rejects with "offline"', async () => {
  const cache = createStoryCache(fakeNet(['down']).fetcher, new Map(), () => 0, 60000)
  await expect(cache.get(URL1)).rejects.toThrow('offline')
})

test('a 5xx with a cached copy is treated like offline', async () => {
  const store = new Map<string, Entry>([[URL1, { etag: '"v1"', body: 'cached', savedAt: 0 }]])
  const cache = createStoryCache(fakeNet([{ status: 503 }]).fetcher, store, () => 90000, 60000)
  expect(await cache.get(URL1)).toEqual({ body: 'cached', source: 'offline' })
})

test('a 404 deletes the entry and rejects with "not-found"', async () => {
  const store = new Map<string, Entry>([[URL1, { etag: '"v1"', body: 'cached', savedAt: 0 }]])
  const cache = createStoryCache(fakeNet([{ status: 404 }]).fetcher, store, () => 90000, 60000)
  await expect(cache.get(URL1)).rejects.toThrow('not-found')
  expect(store.has(URL1)).toBe(false)
})

test('other statuses reject with the status and keep the entry', async () => {
  const store = new Map<string, Entry>([[URL1, { etag: '"v1"', body: 'cached', savedAt: 0 }]])
  const cache = createStoryCache(fakeNet([{ status: 401 }]).fetcher, store, () => 90000, 60000)
  await expect(cache.get(URL1)).rejects.toThrow('HTTP 401')
  expect(store.has(URL1)).toBe(true)
})

test('a response without an ETag is stored, and the next request is unconditional', async () => {
  let t = 0
  const net = fakeNet([{ status: 200, body: 'a' }, { status: 200, body: 'b' }])
  const store = new Map<string, Entry>()
  const cache = createStoryCache(net.fetcher, store, () => t, 60000)
  await cache.get(URL1)
  expect(store.get(URL1)).toEqual({ body: 'a', savedAt: 0 })
  t = 70000
  expect(await cache.get(URL1)).toEqual({ body: 'b', source: 'network' })
  expect(net.calls[1].headers).toEqual({})
})

test('concurrent calls share one request; later calls fetch again', async () => {
  let t = 0
  const net = fakeNet([{ status: 200, etag: '"v1"', body: 'one' }, { status: 304 }])
  const cache = createStoryCache(net.fetcher, new Map(), () => t, 60000)
  const first = cache.get(URL1)
  const second = cache.get(URL1)
  expect(second).toBe(first)
  const [a, b] = await Promise.all([first, second])
  expect(a.body).toBe('one')
  expect(b.body).toBe('one')
  expect(net.calls).toHaveLength(1)
  t = 70000
  expect((await cache.get(URL1)).source).toBe('revalidated')
  expect(net.calls).toHaveLength(2)
})
```
:::

:::tip title="The C# version in the lab"
`BranchStoryApi.GetCachedAsync` follows rules 2 to 7 (it has no `max-age` shortcut: a desktop app
revalidates on every open, which costs one tiny `304`). Rule 8, sharing in-flight requests, is
a good stretch goal: a `ConcurrentDictionary<string, Lazy<Task<…>>>` does it in C#.
:::

## Phase 5: walking the story graph

Reading a story is walking a **directed graph**: scenes are **nodes**, choices are **edges** with a
direction (from → to). The reader's position is not just "the current scene" but the **path**, the
list of scenes visited so far (`["gate", "forest"]`), because **Back** must return to where the
reader actually came from. In a graph several scenes can lead to the same one, so a scene alone
doesn't tell you its predecessor.

```text
         ┌──── Go left ────▶ forest ──── Back to the gate ───┐
 gate ───┤                                                   │
   ▲     └──── Go right ───▶ river (end)                     │
   └─────────────────────────────────────────────────────────┘
```

Words you'll need:

- **Dangling edge**: a choice whose `to` scene doesn't exist (the author deleted the scene). The
  editor warns about it; the reader simply **hides** that choice instead of crashing.
- **Cycle** (loop): a path that returns to a scene already on it, such as gate → forest → gate.
  Cycles are **legal** in stories ("you're back at the gate"), so the reader doesn't forbid them,
  it **labels** them: `Looped` is true when the current scene already appears earlier in the path.
- **DFS** (depth-first search): explore one choice as deep as possible before trying the next.
  To find a cycle, DFS tracks two sets: scenes **on the current path** (in progress, often called
  "grey") and scenes **fully explored** ("black"). Reaching a grey scene again means a cycle.
  Reaching a black one only means two routes join (a *diamond*), which is not a cycle.

```text
 diamond (no cycle):  a → b → d          cycle:  a → b → c
                      a → c → d                      ▲   │
                                                     └───┘
```

The C# `StoryWalker` in the lab is small. Here's the core:

```csharp
public IReadOnlyList<PlayerChoice> Choices =>
    Scene.Choices.Where(c => _story.Scenes.ContainsKey(c.To)).ToList();   // hide dangling edges
public bool Looped => _path.IndexOf(SceneId) < _path.Count - 1;            // seen earlier on this path?
```

There's also `StoryWalker.Resume(graph, oldPath)`: after a reload (for example after a 409) it
replays the reader's old path on the new version of the story, stopping at the first step that
no longer exists. The reader keeps their place, even if the story changed under them.

:::quiz id=dsk-12-q6 xp=10
`findCycle` keeps two sets: scenes on the **current DFS path** and scenes that are **fully explored**.
Why not just one `visited` set, reporting a cycle whenever a scene is reached a second time?
- [ ] One set would be slower, because sets are linear-time lookups
- [x] A scene reachable along two different routes (a diamond, a → b → d and a → c → d) would be wrongly reported as a cycle
- [ ] One set would miss self-loops such as x → x
- [ ] Cycles can only be found with breadth-first search, so the two sets are needed to simulate it
> In a diamond, `d` is reached a second time via `c`, but you can't get from `d` back to `a`, `b` or `c`, so there's no cycle. Only a scene that is still **on the current path** proves a loop. Fully explored scenes are just skipped, which also keeps DFS linear in the size of the graph. The other options are false: set lookups are constant time, a single set catches self-loops too (the scene is seen again immediately), and DFS is the standard way to find cycles.
:::

:::challenge id=dsk-12-c1 lang=ts xp=80
title: Story-graph walker with cycle detection
Implement the reader's brain in TypeScript (the C# version in the lab works the same way).

`class StoryWalker` (constructor takes a `Story`; the types are in the setup block):

- The constructor **throws** `Error('no start scene')` when `story.start` is not a scene.
- `sceneId`: the current scene id. `path`: a **copy** of the visited ids, starting with the start scene.
- `choices`: the current scene's choices, **without** those whose `to` isn't an existing scene. Use
  an own-property check: a choice to `"constructor"` or `"toString"` is dangling too.
- `isEnd`: `true` when there are no (valid) choices. `canGoBack`: `true` when the path has more than one entry.
- `looped`: `true` when the current scene also appears **earlier** in the path.
- `choose(index)`: follow `choices[index]`. An invalid index (out of range, negative, not an
  integer) throws a `RangeError`.
- `back()`: go one step back and return `true`; at the start return `false`.

`findCycle(story)`: depth-first search from `start`, following choices **in order** and ignoring
dangling ones. Return the first cycle found as the ids from the repeated scene back to itself
(`['gate', 'forest', 'gate']`), or `null` when the reachable part of the story has no cycle.

hint: `Object.hasOwn(story.scenes, id)` is true only for real scenes, unlike `id in story.scenes`, which is also true for `'toString'`.
hint: Keep the path as an array and return `[...this.trail]` from the getter so callers can't change it.
hint: For `findCycle` keep `stack: string[]` (current path) and `done: Set<string>`. If the next id is in `stack`, return `[...stack.slice(stack.indexOf(id)), id]`; if it is in `done`, skip it; after exploring all choices, pop it from `stack` and add it to `done`.

```ts setup
interface Choice { label: string; to: string }
interface Scene { title: string; choices: Choice[] }
interface Story { start: string; scenes: Record<string, Scene> }
```

```ts starter
export class StoryWalker {
  constructor(story: Story) {}
  get sceneId(): string { return '' }
  get path(): string[] { return [] }
  get choices(): Choice[] { return [] }
  get isEnd(): boolean { return true }
  get canGoBack(): boolean { return false }
  get looped(): boolean { return false }
  choose(index: number): void {}
  back(): boolean { return false }
}

export function findCycle(story: Story): string[] | null {
  return null
}
```

```ts solution
const isScene = (story: Story, id: string) => Object.hasOwn(story.scenes, id)

export class StoryWalker {
  private story: Story
  private trail: string[]

  constructor(story: Story) {
    if (!isScene(story, story.start)) throw new Error('no start scene')
    this.story = story
    this.trail = [story.start]
  }

  get sceneId(): string { return this.trail[this.trail.length - 1] }
  get path(): string[] { return [...this.trail] }
  get choices(): Choice[] {
    return this.story.scenes[this.sceneId].choices.filter((c) => isScene(this.story, c.to))
  }
  get isEnd(): boolean { return this.choices.length === 0 }
  get canGoBack(): boolean { return this.trail.length > 1 }
  get looped(): boolean { return this.trail.indexOf(this.sceneId) < this.trail.length - 1 }

  choose(index: number): void {
    const choices = this.choices
    if (!Number.isInteger(index) || index < 0 || index >= choices.length) {
      throw new RangeError(`no choice ${index}`)
    }
    this.trail.push(choices[index].to)
  }

  back(): boolean {
    if (!this.canGoBack) return false
    this.trail.pop()
    return true
  }
}

export function findCycle(story: Story): string[] | null {
  if (!isScene(story, story.start)) return null
  const done = new Set<string>()
  const stack: string[] = []

  const visit = (id: string): string[] | null => {
    const at = stack.indexOf(id)
    if (at >= 0) return [...stack.slice(at), id]
    if (done.has(id)) return null
    stack.push(id)
    for (const choice of story.scenes[id].choices) {
      if (!isScene(story, choice.to)) continue
      const cycle = visit(choice.to)
      if (cycle) return cycle
    }
    stack.pop()
    done.add(id)
    return null
  }

  return visit(story.start)
}
```

```ts tests
const makeGate = (): Story => ({
  start: 'gate',
  scenes: {
    gate: { title: 'Gate', choices: [{ label: 'Go left', to: 'forest' }, { label: 'Go right', to: 'river' }] },
    forest: { title: 'Forest', choices: [{ label: 'Back to the gate', to: 'gate' }, { label: 'Dig', to: 'nowhere' }] },
    river: { title: 'River', choices: [] },
  },
})

const graph = (start: string, edges: Record<string, string[]>): Story => ({
  start,
  scenes: Object.fromEntries(
    Object.entries(edges).map(([id, tos]) => [id, { title: id, choices: tos.map((to) => ({ label: to, to })) }]),
  ),
})

test('starts at the start scene', () => {
  const w = new StoryWalker(makeGate())
  expect(w.sceneId).toBe('gate')
  expect(w.path).toEqual(['gate'])
  expect(w.choices.map((c) => c.label)).toEqual(['Go left', 'Go right'])
  expect(w.isEnd).toBe(false)
  expect(w.canGoBack).toBe(false)
})

test('a missing start scene throws', () => {
  expect(() => new StoryWalker({ start: 'x', scenes: {} })).toThrow('no start scene')
})

test('choose moves forward and back moves back', () => {
  const w = new StoryWalker(makeGate())
  w.choose(1)
  expect(w.sceneId).toBe('river')
  expect(w.isEnd).toBe(true)
  expect(w.path).toEqual(['gate', 'river'])
  expect(w.back()).toBe(true)
  expect(w.sceneId).toBe('gate')
  expect(w.back()).toBe(false)
})

test('an invalid index throws a RangeError', () => {
  const w = new StoryWalker(makeGate())
  for (const bad of [2, -1, 0.5]) {
    let error: unknown
    try { w.choose(bad) } catch (e) { error = e }
    expect(error).toBeInstanceOf(RangeError)
  }
  expect(w.sceneId).toBe('gate')
})

test('choices pointing at missing scenes are hidden', () => {
  const w = new StoryWalker(makeGate())
  w.choose(0)
  expect(w.choices.map((c) => c.to)).toEqual(['gate'])
  const tricky = graph('a', { a: ['constructor', 'toString', 'b'], b: [] })
  expect(new StoryWalker(tricky).choices.map((c) => c.to)).toEqual(['b'])
})

test('coming round a loop sets looped', () => {
  const w = new StoryWalker(makeGate())
  w.choose(0)
  expect(w.looped).toBe(false)
  w.choose(0)
  expect(w.sceneId).toBe('gate')
  expect(w.looped).toBe(true)
  expect(w.path).toEqual(['gate', 'forest', 'gate'])
  w.back()
  expect(w.looped).toBe(false)
})

test('path returns a copy', () => {
  const w = new StoryWalker(makeGate())
  w.path.push('hacked')
  expect(w.path).toEqual(['gate'])
})

test('findCycle finds the loop through the gate', () => {
  expect(findCycle(makeGate())).toEqual(['gate', 'forest', 'gate'])
})

test('findCycle: a diamond is not a cycle', () => {
  expect(findCycle(graph('a', { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }))).toBeNull()
})

test('findCycle: a self-loop', () => {
  expect(findCycle(graph('x', { x: ['x'] }))).toEqual(['x', 'x'])
})

test('findCycle returns only the looping part, in choice order', () => {
  expect(findCycle(graph('a', { a: ['b'], b: ['c'], c: ['d', 'b'], d: [] }))).toEqual(['b', 'c', 'b'])
})

test('findCycle ignores unreachable scenes and dangling choices', () => {
  expect(findCycle(graph('a', { a: ['ghost', 'b'], b: [], z: ['z'] }))).toBeNull()
})
```
:::

## Phase 6: the shared ViewModels

The ViewModels use CommunityToolkit.Mvvm exactly as in *Data Binding & MVVM*: `[ObservableProperty]`
on `partial` properties, `[RelayCommand]` on methods, and `NotifyCanExecuteChangedFor` to re-check a
command's `CanExecute` when a property changes. Four pages and one shell:

| ViewModel | Shows | Key commands |
|---|---|---|
| `ShellViewModel` | the current page (`Current`) and a back stack; the theme switch | `GoBackCommand` (enabled only when there is something behind), `ToggleThemeCommand` |
| `SignInViewModel` | API address and username | `SignInCommand` (disabled while a field is blank) |
| `StoryListViewModel` | `Stories`, offline banner, status | `LoadCommand`, `OpenCommand(story)`, `OpenPublicCommand` |
| `ReaderViewModel` | scene title/text, `Choices`, `Looped`, `IsEnd`, draft and conflict state | `ChooseCommand(choice)`, `StepBackCommand`, `RestartCommand`, `BeginEditCommand`, `SaveEditCommand`, `ReloadAfterConflictCommand` |

**Navigation** goes through `INavigator` (`Push`, `Pop`, `Reset`). On the desktop,
`ShellViewModel` *is* the navigator: it keeps a `Stack<ViewModelBase>` and the window's
`ContentControl` shows `Current`. On mobile, a `MauiNavigator` pushes real pages onto MAUI's
`NavigationPage`, so the Android back button and the iOS swipe gesture work for free. The
ViewModels can't tell the difference, which is the whole point.

```csharp
// StoryListViewModel: opening a story is a push plus a load, nothing platform-specific.
[RelayCommand]
private void Open(ProjectSummary? story)
{
    if (story is null) return;
    var reader = new ReaderViewModel(api, ReaderSource.ForProject(story.Id, story.Role), story.Title);
    nav.Push(reader);
    _ = reader.LoadCommand.ExecuteAsync(null);   // fire-and-forget is fine: the command tracks IsRunning
}
```

**Who may edit?** `ReaderSource.MayEdit` is true only for projects where the role is `owner` or
`editor`, so the "Fix text" button is disabled for viewers and for published stories. The server
still checks (a viewer's `PUT` gets `403`). The UI check is a courtesy, not security.

:::lab id=dsk-12-lab1 xp=120
title: Phase 1 to 6 — the shared library and its tests
You'll create the solution, the `BranchStory.Client` library with everything above, and an xUnit v3
test project that checks the API client against a **fake network** (an `HttpMessageHandler` that
answers from a function), the walker, and the ViewModels. Nothing here needs a running API.

**1. Create the solution and the projects.**

```bash
mkdir BranchStoryClient && cd BranchStoryClient
dotnet new sln -n BranchStoryClient --format slnx   # .slnx: the newer XML solution file (the .NET 10 default)
dotnet new classlib -n BranchStory.Client -o src/BranchStory.Client
rm src/BranchStory.Client/Class1.cs
mkdir -p src/BranchStory.Client/{Models,Api,Cache,Story,ViewModels} tests/BranchStory.Client.Tests
```

**2. `src/BranchStory.Client/BranchStory.Client.csproj`** (replace it). `IsTrimmable` makes the build
warn if the library does something trimming can't handle.

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsTrimmable>true</IsTrimmable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.2" />
  </ItemGroup>

</Project>
```

**3. `src/BranchStory.Client/Models/ApiModels.cs`**: the DTOs, matching the Capstone API.

```csharp
namespace BranchStory.Client.Models;

// The same shapes the Capstone API sends (cap-02, cap-03, cap-04, cap-08). JSON is camelCase.

public sealed record DevTokenRequest(string Username, string? DisplayName = null);
public sealed record DevTokenResponse(string AccessToken, DateTimeOffset ExpiresAt);

public sealed record ProjectSummary(Guid Id, string Title, string Role, string OwnerName, int Version, DateTimeOffset UpdatedAt);
public sealed record ProjectDetail(Guid Id, string Title, string Role, Guid OwnerId, int Version, StoryDoc Doc, DateTimeOffset UpdatedAt);

public sealed record StoryDoc(string? StartNodeId, List<StoryNode> Nodes, List<StoryEdge> Edges);
public sealed record StoryNode(string Id, string Title, string Text, string? MediaUrl, double X, double Y);
public sealed record StoryEdge(string Id, string From, string To, string Label);

public sealed record SaveDocRequest(StoryDoc Doc, int? ExpectedVersion);
public sealed record SaveDocResponse(int Version, DateTimeOffset UpdatedAt);

public sealed record PlayerStory(int Format, string Title, int Version, string Start, Dictionary<string, PlayerScene> Scenes);
public sealed record PlayerScene(string Title, string Text, string? Media, List<PlayerChoice> Choices, bool End);
public sealed record PlayerChoice(string Label, string To);

/// <summary>The fields of an RFC 9457 problem document we use (plus BranchStory's currentVersion).</summary>
public sealed record Problem(string? Type, string? Title, int Status, string? Detail, int? CurrentVersion);
```

**4. `src/BranchStory.Client/Models/ClientJson.cs`**: the source-generated JSON context.

```csharp
using System.Text.Json;
using System.Text.Json.Serialization;
using BranchStory.Client.Cache;

namespace BranchStory.Client.Models;

/// <summary>
/// Source-generated JSON metadata: no reflection at runtime, so trimming (iOS, Android,
/// single-file desktop builds) cannot remove something the serializer needs.
/// </summary>
[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(List<ProjectSummary>))]
[JsonSerializable(typeof(ProjectDetail))]
[JsonSerializable(typeof(PlayerStory))]
[JsonSerializable(typeof(SaveDocRequest))]
[JsonSerializable(typeof(SaveDocResponse))]
[JsonSerializable(typeof(DevTokenRequest))]
[JsonSerializable(typeof(DevTokenResponse))]
[JsonSerializable(typeof(Problem))]
[JsonSerializable(typeof(CacheEntry))]
public partial class ClientJson : JsonSerializerContext
{
}
```

**5. `src/BranchStory.Client/Cache/StoryCache.cs`**: the cache interface, an in-memory version for
tests and the file version for the apps.

```csharp
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BranchStory.Client.Models;

namespace BranchStory.Client.Cache;

/// <summary>One cached response: the raw JSON, the ETag the server sent with it, and when we got it.</summary>
public sealed record CacheEntry(string? ETag, string Json, DateTimeOffset SavedAt);

public interface IStoryCache
{
    Task<CacheEntry?> GetAsync(string key, CancellationToken ct = default);
    Task SetAsync(string key, CacheEntry entry, CancellationToken ct = default);
    Task RemoveAsync(string key, CancellationToken ct = default);
}

/// <summary>Keeps entries in memory only. Used by tests and as a fallback.</summary>
public sealed class MemoryStoryCache : IStoryCache
{
    private readonly ConcurrentDictionary<string, CacheEntry> _entries = new(StringComparer.Ordinal);

    public Task<CacheEntry?> GetAsync(string key, CancellationToken ct = default) =>
        Task.FromResult(_entries.TryGetValue(key, out var e) ? e : null);

    public Task SetAsync(string key, CacheEntry entry, CancellationToken ct = default)
    {
        _entries[key] = entry;
        return Task.CompletedTask;
    }

    public Task RemoveAsync(string key, CancellationToken ct = default)
    {
        _entries.TryRemove(key, out _);
        return Task.CompletedTask;
    }
}

/// <summary>
/// One JSON file per URL in a folder. The file name is a hash of the key, so any URL
/// (slashes, query strings) becomes a safe file name.
/// </summary>
public sealed class FileStoryCache(string directory) : IStoryCache
{
    public string Directory { get; } = directory;

    private string PathFor(string key)
    {
        var hash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
        return Path.Combine(Directory, hash + ".json");
    }

    public async Task<CacheEntry?> GetAsync(string key, CancellationToken ct = default)
    {
        var path = PathFor(key);
        if (!File.Exists(path)) return null;
        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync(stream, ClientJson.Default.CacheEntry, ct);
        }
        catch (Exception ex) when (ex is JsonException or IOException)
        {
            return null; // a corrupt or half-written file is a cache miss, never a crash
        }
    }

    public async Task SetAsync(string key, CacheEntry entry, CancellationToken ct = default)
    {
        System.IO.Directory.CreateDirectory(Directory);
        var path = PathFor(key);
        var temp = path + ".tmp";
        // Write to a temp file, then rename: a crash mid-write never leaves a broken entry behind.
        await using (var stream = File.Create(temp))
            await JsonSerializer.SerializeAsync(stream, entry, ClientJson.Default.CacheEntry, ct);
        File.Move(temp, path, overwrite: true);
    }

    public Task RemoveAsync(string key, CancellationToken ct = default)
    {
        // The folder may not exist yet (a 404 on the very first request), so check first.
        var path = PathFor(key);
        if (File.Exists(path)) File.Delete(path);
        return Task.CompletedTask;
    }
}
```

**6. `src/BranchStory.Client/Story/StoryGraph.cs`** and **`Story/StoryWalker.cs`**.

```csharp
using BranchStory.Client.Models;

namespace BranchStory.Client.Story;

/// <summary>
/// The reader's view of a story: scenes by id plus the start id. Both API shapes
/// (a published PlayerStory and an editable ProjectDetail) are turned into this.
/// </summary>
public sealed record StoryGraph(string Title, int Version, string Start, IReadOnlyDictionary<string, PlayerScene> Scenes)
{
    public static StoryGraph FromPlayer(PlayerStory story) =>
        new(story.Title, story.Version, story.Start, story.Scenes);

    public static StoryGraph FromProject(ProjectDetail project)
    {
        var doc = project.Doc;
        var byFrom = doc.Edges.ToLookup(e => e.From, StringComparer.Ordinal);
        var scenes = new Dictionary<string, PlayerScene>(StringComparer.Ordinal);
        foreach (var node in doc.Nodes)
        {
            var choices = byFrom[node.Id]
                .Select((e, i) => new PlayerChoice(string.IsNullOrWhiteSpace(e.Label) ? $"Choice {i + 1}" : e.Label.Trim(), e.To))
                .ToList();
            scenes[node.Id] = new PlayerScene(node.Title, node.Text, node.MediaUrl, choices, choices.Count == 0);
        }
        return new StoryGraph(project.Title, project.Version, doc.StartNodeId ?? "", scenes);
    }
}
```

```csharp
using BranchStory.Client.Models;

namespace BranchStory.Client.Story;

/// <summary>
/// Walks a story graph: where am I, which choices are valid, go forward, go back.
/// Pure logic with no UI types, so it is tested without a window.
/// </summary>
public sealed class StoryWalker
{
    private readonly StoryGraph _story;
    private readonly List<string> _path = [];

    public StoryWalker(StoryGraph story)
    {
        if (!story.Scenes.ContainsKey(story.Start))
            throw new InvalidOperationException("The story has no valid start scene.");
        _story = story;
        _path.Add(story.Start);
    }

    public string SceneId => _path[^1];
    public PlayerScene Scene => _story.Scenes[SceneId];
    public IReadOnlyList<string> Path => _path;
    public bool CanGoBack => _path.Count > 1;

    /// <summary>Only choices whose target exists: a dangling edge is hidden, not a crash.</summary>
    public IReadOnlyList<PlayerChoice> Choices =>
        Scene.Choices.Where(c => _story.Scenes.ContainsKey(c.To)).ToList();

    public bool IsEnd => Choices.Count == 0;

    /// <summary>True when the current scene was already visited earlier on this path (the reader went round a loop).</summary>
    public bool Looped => _path.IndexOf(SceneId) < _path.Count - 1;

    public void Choose(int index)
    {
        var choices = Choices;
        if (index < 0 || index >= choices.Count) throw new ArgumentOutOfRangeException(nameof(index));
        _path.Add(choices[index].To);
    }

    public bool Back()
    {
        if (!CanGoBack) return false;
        _path.RemoveAt(_path.Count - 1);
        return true;
    }

    public void Restart()
    {
        _path.RemoveRange(1, _path.Count - 1);
    }

    /// <summary>
    /// Replays a saved path on a (possibly newer) version of the story and stops at the first
    /// step that no longer exists. Used after a reload so the reader keeps their place.
    /// </summary>
    public static StoryWalker Resume(StoryGraph story, IEnumerable<string> path)
    {
        var walker = new StoryWalker(story);
        foreach (var id in path.Skip(1))
        {
            var choices = walker.Choices;
            var index = -1;
            for (var i = 0; i < choices.Count; i++)
                if (choices[i].To == id) { index = i; break; }
            if (index < 0) break;
            walker.Choose(index);
        }
        return walker;
    }

    /// <summary>
    /// Depth-first search from the start, following choices in order. Returns the first cycle
    /// as scene ids that begin and end with the same id (["a","b","a"]), or null.
    /// </summary>
    public static IReadOnlyList<string>? FindCycle(StoryGraph story)
    {
        if (!story.Scenes.ContainsKey(story.Start)) return null;
        var done = new HashSet<string>(StringComparer.Ordinal);   // fully explored ("black")
        var stack = new List<string>();                            // current DFS path ("grey")

        IReadOnlyList<string>? Visit(string id)
        {
            var onStack = stack.IndexOf(id);
            if (onStack >= 0) return [.. stack.Skip(onStack), id];
            if (!done.Add(id)) return null;
            stack.Add(id);
            foreach (var choice in story.Scenes[id].Choices)
            {
                if (!story.Scenes.ContainsKey(choice.To)) continue;
                if (Visit(choice.To) is { } cycle) return cycle;
            }
            stack.RemoveAt(stack.Count - 1);
            return null;
        }

        return Visit(story.Start);
    }
}
```

**7. The API layer.** `Api/ApiResult.cs`:

```csharp
using BranchStory.Client.Models;

namespace BranchStory.Client.Api;

/// <summary>What happened, in words the UI can switch on. HTTP status codes stay inside the API client.</summary>
public enum ApiStatus { Ok, NotFound, Conflict, Unauthorized, Forbidden, Offline, Failed }

/// <summary>Where the data came from.</summary>
public enum DataSource { Network, Revalidated, OfflineCache }

public sealed record ApiResult<T>(
    ApiStatus Status,
    T? Value = default,
    Problem? Problem = null,
    DataSource Source = DataSource.Network,
    DateTimeOffset? CachedAt = null)
{
    public bool IsOk => Status == ApiStatus.Ok;
    public bool IsStale => Source == DataSource.OfflineCache;

    public static ApiResult<T> Ok(T value, DataSource source = DataSource.Network, DateTimeOffset? cachedAt = null) =>
        new(ApiStatus.Ok, value, null, source, cachedAt);

    public static ApiResult<T> Fail(ApiStatus status, Problem? problem = null) => new(status, default, problem);
}
```

`Api/Auth.cs` (token provider and the bearer handler):

```csharp
using System.Net.Http.Headers;
using System.Net.Http.Json;
using BranchStory.Client.Models;

namespace BranchStory.Client.Api;

/// <summary>Anything that can hand out a bearer token: the dev issuer now, OIDC later.</summary>
public interface ITokenProvider
{
    ValueTask<string?> GetTokenAsync(CancellationToken ct = default);
    void Invalidate();
}

/// <summary>Signs in with POST /api/dev/token (mapped only when the API runs in Development).</summary>
public sealed class DevTokenProvider(HttpClient anonymous, string username, TimeProvider? time = null) : ITokenProvider
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DevTokenResponse? _current;

    public async ValueTask<string?> GetTokenAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct); // two requests at once must not sign in twice
        try
        {
            // Renew one minute early so a token never expires halfway through a request.
            if (_current is { } t && t.ExpiresAt - TimeSpan.FromMinutes(1) > _time.GetUtcNow())
                return t.AccessToken;

            using var res = await anonymous.PostAsJsonAsync("/api/dev/token",
                new DevTokenRequest(username), ClientJson.Default.DevTokenRequest, ct);
            if (!res.IsSuccessStatusCode)
                throw new InvalidOperationException(
                    $"Dev sign-in failed with HTTP {(int)res.StatusCode}. Is the API running in Development?");
            _current = await res.Content.ReadFromJsonAsync(ClientJson.Default.DevTokenResponse, ct);
            return _current?.AccessToken;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Invalidate() => _current = null;
}

/// <summary>A message handler: runs around every request of the HttpClient it is plugged into.</summary>
public sealed class BearerTokenHandler(ITokenProvider tokens) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        if (await tokens.GetTokenAsync(ct) is { } token)
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        var response = await base.SendAsync(request, ct);
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
            tokens.Invalidate(); // expired or revoked: the next call signs in again
        return response;
    }
}
```

`Api/BranchStoryApi.cs` (the typed client with cache, ETags and status mapping):

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using BranchStory.Client.Cache;
using BranchStory.Client.Models;

namespace BranchStory.Client.Api;

public interface IBranchStoryApi
{
    Task<ApiResult<List<ProjectSummary>>> GetMyStoriesAsync(CancellationToken ct = default);
    Task<ApiResult<ProjectDetail>> GetProjectAsync(Guid id, CancellationToken ct = default);
    Task<ApiResult<PlayerStory>> GetPublicStoryAsync(string slug, CancellationToken ct = default);
    Task<ApiResult<SaveDocResponse>> SaveDocAsync(Guid id, StoryDoc doc, int expectedVersion, CancellationToken ct = default);
}

/// <summary>
/// The typed client for the Capstone API. Every GET goes through the offline cache with ETag
/// revalidation; every failure becomes an ApiStatus instead of an exception.
/// </summary>
public sealed class BranchStoryApi(HttpClient http, IStoryCache cache, TimeProvider? time = null) : IBranchStoryApi
{
    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public Task<ApiResult<List<ProjectSummary>>> GetMyStoriesAsync(CancellationToken ct = default) =>
        GetCachedAsync("/api/projects", ClientJson.Default.ListProjectSummary, ct);

    public Task<ApiResult<ProjectDetail>> GetProjectAsync(Guid id, CancellationToken ct = default) =>
        GetCachedAsync($"/api/projects/{id}", ClientJson.Default.ProjectDetail, ct);

    public Task<ApiResult<PlayerStory>> GetPublicStoryAsync(string slug, CancellationToken ct = default) =>
        GetCachedAsync($"/api/public/stories/{Uri.EscapeDataString(slug)}", ClientJson.Default.PlayerStory, ct);

    public async Task<ApiResult<SaveDocResponse>> SaveDocAsync(Guid id, StoryDoc doc, int expectedVersion, CancellationToken ct = default)
    {
        HttpResponseMessage res;
        try
        {
            res = await http.PutAsJsonAsync($"/api/projects/{id}/doc",
                new SaveDocRequest(doc, expectedVersion), ClientJson.Default.SaveDocRequest, ct);
        }
        catch (Exception ex) when (IsNetworkFailure(ex, ct))
        {
            return ApiResult<SaveDocResponse>.Fail(ApiStatus.Offline); // never queue a write silently
        }

        using (res)
        {
            if (!res.IsSuccessStatusCode) return await FailAsync<SaveDocResponse>(res, ct);
            await cache.RemoveAsync($"/api/projects/{id}", ct); // our cached copy is now old
            var saved = await res.Content.ReadFromJsonAsync(ClientJson.Default.SaveDocResponse, ct);
            return ApiResult<SaveDocResponse>.Ok(saved!);
        }
    }

    private async Task<ApiResult<T>> GetCachedAsync<T>(string path, JsonTypeInfo<T> type, CancellationToken ct)
    {
        var cached = await cache.GetAsync(path, ct);

        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        if (cached?.ETag is { } etag)
            request.Headers.TryAddWithoutValidation("If-None-Match", etag); // "send it only if it changed"

        HttpResponseMessage res;
        try
        {
            res = await http.SendAsync(request, ct);
        }
        catch (Exception ex) when (IsNetworkFailure(ex, ct))
        {
            return FromCacheOrOffline(cached, type);
        }

        using (res)
        {
            if (res.StatusCode == HttpStatusCode.NotModified && cached is not null)
            {
                var refreshed = cached with { SavedAt = _time.GetUtcNow() };
                await cache.SetAsync(path, refreshed, ct);
                return ApiResult<T>.Ok(JsonSerializer.Deserialize(cached.Json, type)!, DataSource.Revalidated, refreshed.SavedAt);
            }

            if (res.IsSuccessStatusCode)
            {
                var json = await res.Content.ReadAsStringAsync(ct);
                var value = JsonSerializer.Deserialize(json, type)!;
                await cache.SetAsync(path, new CacheEntry(res.Headers.ETag?.ToString(), json, _time.GetUtcNow()), ct);
                return ApiResult<T>.Ok(value);
            }

            // Gone (deleted, unpublished, or we lost access): the cached copy must go too.
            if (res.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden)
                await cache.RemoveAsync(path, ct);

            // The server is having a bad moment: a stale copy beats an error page.
            if ((int)res.StatusCode >= 500 && cached is not null)
                return FromCacheOrOffline(cached, type);

            return await FailAsync<T>(res, ct);
        }
    }

    private static ApiResult<T> FromCacheOrOffline<T>(CacheEntry? cached, JsonTypeInfo<T> type) =>
        cached is null
            ? ApiResult<T>.Fail(ApiStatus.Offline)
            : ApiResult<T>.Ok(JsonSerializer.Deserialize(cached.Json, type)!, DataSource.OfflineCache, cached.SavedAt);

    /// <summary>No connection, DNS failure, refused, or HttpClient's own timeout (not the caller cancelling).</summary>
    private static bool IsNetworkFailure(Exception ex, CancellationToken ct) =>
        ex is HttpRequestException || (ex is TaskCanceledException && !ct.IsCancellationRequested);

    private static async Task<ApiResult<T>> FailAsync<T>(HttpResponseMessage res, CancellationToken ct)
    {
        Problem? problem = null;
        try
        {
            if (res.Content.Headers.ContentType?.MediaType is "application/problem+json" or "application/json")
                problem = await res.Content.ReadFromJsonAsync(ClientJson.Default.Problem, ct);
        }
        catch (JsonException)
        {
            // an HTML error page from a proxy: keep the status, drop the body
        }
        problem ??= new Problem(null, res.ReasonPhrase, (int)res.StatusCode, null, null);

        var status = res.StatusCode switch
        {
            HttpStatusCode.NotFound => ApiStatus.NotFound,
            HttpStatusCode.Conflict or HttpStatusCode.PreconditionFailed => ApiStatus.Conflict,
            HttpStatusCode.Unauthorized => ApiStatus.Unauthorized,
            HttpStatusCode.Forbidden => ApiStatus.Forbidden,
            _ => ApiStatus.Failed,
        };
        return ApiResult<T>.Fail(status, problem);
    }
}
```

`Api/ClientServices.cs` (wires HTTP, auth and cache together for one user):

```csharp
using BranchStory.Client.Cache;

namespace BranchStory.Client.Api;

/// <summary>Everything one signed-in user needs. Desktop and mobile both build it the same way.</summary>
public sealed record ClientServices(IBranchStoryApi Api, ITokenProvider Tokens)
{
    /// <param name="apiBase">For example http://localhost:5080</param>
    /// <param name="username">The dev-token user, for example "ada"</param>
    /// <param name="cacheRoot">An app-data folder; each user gets a sub-folder so caches never mix</param>
    /// <param name="transport">The handler that really talks to the network (MAUI passes its platform handler)</param>
    public static ClientServices Create(Uri apiBase, string username, string cacheRoot, HttpMessageHandler? transport = null)
    {
        transport ??= new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) };
        var timeout = TimeSpan.FromSeconds(10);

        var anonymous = new HttpClient(transport, disposeHandler: false) { BaseAddress = apiBase, Timeout = timeout };
        var tokens = new DevTokenProvider(anonymous, username);

        var authed = new HttpClient(new BearerTokenHandler(tokens) { InnerHandler = transport }, disposeHandler: false)
        {
            BaseAddress = apiBase,
            Timeout = timeout,
        };

        var safeUser = string.Concat(username.Where(char.IsLetterOrDigit));
        var cache = new FileStoryCache(Path.Combine(cacheRoot, apiBase.Authority.Replace(':', '_'), safeUser));
        return new ClientServices(new BranchStoryApi(authed, cache), tokens);
    }
}
```

**8. The ViewModels.** `ViewModels/ViewModelBase.cs` (with the two interfaces):

```csharp
using CommunityToolkit.Mvvm.ComponentModel;

namespace BranchStory.Client.ViewModels;

/// <summary>Base class of every page ViewModel. ObservableObject implements INotifyPropertyChanged.</summary>
public abstract class ViewModelBase : ObservableObject
{
}

/// <summary>A navigation stack the ViewModels can drive without knowing about windows or pages.</summary>
public interface INavigator
{
    void Push(ViewModelBase page);
    bool Pop();
    void Reset(ViewModelBase root);
}

/// <summary>Light/dark switch; each UI framework implements it in a few lines.</summary>
public interface IThemeService
{
    bool IsDark { get; set; }
}
```

`ViewModels/ShellViewModel.cs`:

```csharp
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace BranchStory.Client.ViewModels;

/// <summary>The window's ViewModel: shows one page at a time and remembers the pages behind it.</summary>
public sealed partial class ShellViewModel(IThemeService theme) : ViewModelBase, INavigator
{
    private readonly Stack<ViewModelBase> _behind = new();

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(CanGoBack))]
    [NotifyCanExecuteChangedFor(nameof(GoBackCommand))]
    public partial ViewModelBase? Current { get; set; }

    public bool CanGoBack => _behind.Count > 0;

    public bool IsDark
    {
        get => theme.IsDark;
        set
        {
            if (theme.IsDark == value) return;
            theme.IsDark = value;
            OnPropertyChanged();
        }
    }

    public void Push(ViewModelBase page)
    {
        if (Current is not null) _behind.Push(Current);
        Current = page;
    }

    public bool Pop()
    {
        if (_behind.Count == 0) return false;
        Current = _behind.Pop();
        return true;
    }

    public void Reset(ViewModelBase root)
    {
        _behind.Clear();
        Current = root;
    }

    [RelayCommand(CanExecute = nameof(CanGoBack))]
    private void GoBack() => Pop();

    [RelayCommand]
    private void ToggleTheme() => IsDark = !IsDark;
}
```

`ViewModels/SignInViewModel.cs`:

```csharp
using BranchStory.Client.Api;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace BranchStory.Client.ViewModels;

/// <summary>Dev sign-in: pick the API address and a username, get a token, open the story list.</summary>
public sealed partial class SignInViewModel(INavigator nav, Func<Uri, string, ClientServices> connect) : ViewModelBase
{
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand))]
    public partial string ApiBase { get; set; } = "http://localhost:5080";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SignInCommand))]
    public partial string Username { get; set; } = "ada";

    [ObservableProperty]
    public partial string? Error { get; set; }

    private bool CanSignIn() => !string.IsNullOrWhiteSpace(Username) && !string.IsNullOrWhiteSpace(ApiBase);

    [RelayCommand(CanExecute = nameof(CanSignIn))]
    private async Task SignInAsync(CancellationToken ct)
    {
        Error = null;
        if (!Uri.TryCreate(ApiBase.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
        {
            Error = "Enter an address like http://localhost:5080";
            return;
        }

        var services = connect(uri, Username.Trim());
        var offline = false;
        try
        {
            await services.Tokens.GetTokenAsync(ct);
        }
        catch (Exception ex) when (ex is HttpRequestException ||
                                   (ex is TaskCanceledException && !ct.IsCancellationRequested))
        {
            // No route, refused, or HttpClient's 10-second timeout (a wrong LAN IP on a phone):
            // carry on, the list can still come from the offline cache.
            offline = true;
        }
        catch (InvalidOperationException ex)
        {
            Error = ex.Message;
            return;
        }

        var list = new StoryListViewModel(services.Api, nav);
        nav.Reset(list);
        await list.LoadCommand.ExecuteAsync(null);
        if (offline && list.Stories.Count == 0)
            list.Status = "The API is unreachable and nothing is cached yet.";
    }
}
```

`ViewModels/StoryListViewModel.cs`:

```csharp
using System.Collections.ObjectModel;
using BranchStory.Client.Api;
using BranchStory.Client.Models;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace BranchStory.Client.ViewModels;

/// <summary>"My stories" plus "open a published story by its link slug".</summary>
public sealed partial class StoryListViewModel(IBranchStoryApi api, INavigator nav) : ViewModelBase
{
    public ObservableCollection<ProjectSummary> Stories { get; } = [];

    [ObservableProperty]
    public partial bool IsBusy { get; set; }

    [ObservableProperty]
    public partial bool IsOffline { get; set; }

    [ObservableProperty]
    public partial string? Status { get; set; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(OpenPublicCommand))]
    public partial string Slug { get; set; } = "";

    [RelayCommand]
    private async Task LoadAsync(CancellationToken ct)
    {
        IsBusy = true;
        try
        {
            var result = await api.GetMyStoriesAsync(ct);
            IsOffline = result.IsStale || result.Status == ApiStatus.Offline;
            Status = result.Status switch
            {
                ApiStatus.Ok when result.IsStale => $"Offline: showing the list saved {result.CachedAt:g}.",
                ApiStatus.Ok when result.Value!.Count == 0 => "No stories yet. Create one in the web editor.",
                ApiStatus.Ok => null,
                ApiStatus.Offline => "You're offline and the list isn't cached yet.",
                ApiStatus.Unauthorized => "Your sign-in expired. Go back and sign in again.",
                _ => result.Problem?.Title ?? "Something went wrong.",
            };
            if (result.IsOk)
            {
                Stories.Clear();
                foreach (var s in result.Value!.OrderByDescending(s => s.UpdatedAt)) Stories.Add(s);
            }
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private void Open(ProjectSummary? story)
    {
        if (story is null) return;
        var reader = new ReaderViewModel(api, ReaderSource.ForProject(story.Id, story.Role), story.Title);
        nav.Push(reader);
        _ = reader.LoadCommand.ExecuteAsync(null);
    }

    private bool CanOpenPublic() => !string.IsNullOrWhiteSpace(Slug);

    [RelayCommand(CanExecute = nameof(CanOpenPublic))]
    private void OpenPublic()
    {
        var slug = Slug.Trim();
        var reader = new ReaderViewModel(api, ReaderSource.ForSlug(slug), slug);
        nav.Push(reader);
        _ = reader.LoadCommand.ExecuteAsync(null);
    }
}
```

`ViewModels/ReaderViewModel.cs`:

```csharp
using System.Collections.ObjectModel;
using BranchStory.Client.Api;
using BranchStory.Client.Models;
using BranchStory.Client.Story;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;

namespace BranchStory.Client.ViewModels;

/// <summary>Which story to read: one of my projects (editable if I'm owner/editor) or a published slug.</summary>
public sealed record ReaderSource(Guid? ProjectId, string? Slug, string Role)
{
    public static ReaderSource ForProject(Guid id, string role) => new(id, null, role);
    public static ReaderSource ForSlug(string slug) => new(null, slug, "reader");
    public bool MayEdit => ProjectId is not null && Role is "owner" or "editor";
}

public sealed partial class ReaderViewModel(IBranchStoryApi api, ReaderSource source, string title) : ViewModelBase
{
    private StoryWalker? _walker;
    private ProjectDetail? _project;

    public ObservableCollection<PlayerChoice> Choices { get; } = [];

    [ObservableProperty] public partial string Title { get; set; } = title;
    [ObservableProperty] public partial string SceneTitle { get; set; } = "";
    [ObservableProperty] public partial string SceneText { get; set; } = "";
    [ObservableProperty] public partial bool IsEnd { get; set; }
    [ObservableProperty] public partial bool Looped { get; set; }
    [ObservableProperty] public partial bool IsBusy { get; set; }
    [ObservableProperty] public partial bool IsOffline { get; set; }
    [ObservableProperty] public partial bool HasConflict { get; set; }
    [ObservableProperty] public partial string? Status { get; set; }
    [ObservableProperty] public partial string Draft { get; set; } = "";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(BeginEditCommand), nameof(SaveEditCommand))]
    public partial bool IsEditing { get; set; }

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(StepBackCommand), nameof(RestartCommand), nameof(BeginEditCommand))]
    public partial bool HasStory { get; set; }

    public IReadOnlyList<string> Path => _walker?.Path ?? [];

    [RelayCommand]
    private async Task LoadAsync(CancellationToken ct)
    {
        IsBusy = true;
        try
        {
            var previousPath = _walker?.Path.ToList();
            StoryGraph? graph = null;
            DataSource sourceOfData = DataSource.Network;
            DateTimeOffset? cachedAt = null;
            ApiStatus status;
            Problem? problem;

            if (source.ProjectId is { } id)
            {
                var r = await api.GetProjectAsync(id, ct);
                (status, problem, sourceOfData, cachedAt) = (r.Status, r.Problem, r.Source, r.CachedAt);
                if (r.IsOk) { _project = r.Value; graph = StoryGraph.FromProject(r.Value!); }
            }
            else
            {
                var r = await api.GetPublicStoryAsync(source.Slug!, ct);
                (status, problem, sourceOfData, cachedAt) = (r.Status, r.Problem, r.Source, r.CachedAt);
                if (r.IsOk) graph = StoryGraph.FromPlayer(r.Value!);
            }

            IsOffline = sourceOfData == DataSource.OfflineCache || status == ApiStatus.Offline;
            if (graph is null)
            {
                Status = status switch
                {
                    ApiStatus.NotFound => "This story no longer exists, was unpublished, or isn't shared with you.",
                    ApiStatus.Forbidden => "You no longer have access to this story.",
                    ApiStatus.Offline => "You're offline and this story isn't cached yet.",
                    ApiStatus.Unauthorized => "Your sign-in expired. Sign in again.",
                    _ => problem?.Title ?? "Something went wrong.",
                };
                ClearStory();
                return;
            }

            try
            {
                _walker = previousPath is null ? new StoryWalker(graph) : StoryWalker.Resume(graph, previousPath);
            }
            catch (InvalidOperationException ex)
            {
                Status = ex.Message;
                ClearStory();
                return;
            }

            Title = graph.Title;
            Status = IsOffline ? $"Offline: reading the copy saved {cachedAt:g}." : null;
            HasStory = true;
            ShowScene();
        }
        finally
        {
            IsBusy = false;
        }
    }

    [RelayCommand]
    private void Choose(PlayerChoice? choice)
    {
        if (_walker is null || choice is null || IsEditing) return;
        var index = Choices.IndexOf(choice);
        if (index < 0) return;
        _walker.Choose(index);
        ShowScene();
    }

    private bool CanStepBack() => HasStory && _walker!.CanGoBack;

    [RelayCommand(CanExecute = nameof(CanStepBack))]
    private void StepBack()
    {
        _walker?.Back();
        ShowScene();
    }

    [RelayCommand(CanExecute = nameof(HasStory))]
    private void Restart()
    {
        _walker?.Restart();
        ShowScene();
    }

    private bool CanBeginEdit() => HasStory && source.MayEdit && !IsEditing;

    [RelayCommand(CanExecute = nameof(CanBeginEdit))]
    private void BeginEdit()
    {
        Draft = SceneText;
        HasConflict = false;
        IsEditing = true;
    }

    [RelayCommand]
    private void CancelEdit()
    {
        IsEditing = false;
        HasConflict = false;
    }

    [RelayCommand(CanExecute = nameof(IsEditing))]
    private async Task SaveEditAsync(CancellationToken ct)
    {
        if (_project is null || _walker is null) return;
        var sceneId = _walker.SceneId;
        var doc = _project.Doc with
        {
            Nodes = _project.Doc.Nodes.Select(n => n.Id == sceneId ? n with { Text = Draft } : n).ToList(),
        };

        IsBusy = true;
        try
        {
            var result = await api.SaveDocAsync(_project.Id, doc, _project.Version, ct);
            switch (result.Status)
            {
                case ApiStatus.Ok:
                    IsEditing = false;
                    HasConflict = false;
                    await LoadAsync(ct);   // LoadAsync resets Status, so set the message afterwards
                    Status = $"Saved as version {result.Value!.Version}.";
                    break;
                case ApiStatus.Conflict:
                    // Someone saved first. Keep the draft, explain, and let the user reload on top of it.
                    HasConflict = true;
                    Status = $"Someone saved version {result.Problem?.CurrentVersion} while you were editing. " +
                             "Reload to get it; your text stays in the box.";
                    break;
                case ApiStatus.NotFound:
                    IsEditing = false;
                    Status = "This story was deleted or unshared while you were editing.";
                    ClearStory();
                    break;
                case ApiStatus.Forbidden:
                    IsEditing = false;
                    Status = "You can no longer edit this story.";
                    break;
                case ApiStatus.Offline:
                    Status = "You're offline. Your text is kept; try again when you're back online.";
                    break;
                default:
                    Status = result.Problem?.Title ?? "Saving failed.";
                    break;
            }
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>After a 409: fetch the newer version but keep the draft so nothing typed is lost.</summary>
    [RelayCommand]
    private async Task ReloadAfterConflictAsync(CancellationToken ct)
    {
        var keep = Draft;
        await LoadAsync(ct);
        Draft = keep;
        HasConflict = false;
        Status = "Reloaded the latest version. Check your text, then save again.";
    }

    private void ShowScene()
    {
        if (_walker is null) return;
        SceneTitle = _walker.Scene.Title;
        SceneText = _walker.Scene.Text;
        Choices.Clear();
        foreach (var c in _walker.Choices) Choices.Add(c);
        IsEnd = _walker.IsEnd;
        Looped = _walker.Looped;
        StepBackCommand.NotifyCanExecuteChanged();
        OnPropertyChanged(nameof(Path));
    }

    private void ClearStory()
    {
        _walker = null;
        HasStory = false;
        SceneTitle = "";
        SceneText = "";
        Choices.Clear();
        IsEnd = false;
        Looped = false;
    }
}
```

**9. The test project.** `tests/BranchStory.Client.Tests/BranchStory.Client.Tests.csproj`
(xUnit v3 test projects are executables, hence `OutputType Exe`):

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <OutputType>Exe</OutputType>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.1" />
    <PackageReference Include="xunit.v3" Version="3.2.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\..\src\BranchStory.Client\BranchStory.Client.csproj" />
  </ItemGroup>

</Project>
```

`tests/BranchStory.Client.Tests/TestDoubles.cs`: a fake network, a fake API, sample data.

```csharp
using System.Net;
using System.Text;
using BranchStory.Client.Api;
using BranchStory.Client.Models;
using BranchStory.Client.ViewModels;

namespace BranchStory.Client.Tests;

/// <summary>A fake network: each request is answered by a function, and every request is recorded.</summary>
public sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
{
    public List<HttpRequestMessage> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Requests.Add(request);
        return Task.FromResult(respond(request));
    }

    public static HttpResponseMessage Json(HttpStatusCode status, string json, string? etag = null,
        string mediaType = "application/json")
    {
        var res = new HttpResponseMessage(status) { Content = new StringContent(json, Encoding.UTF8, mediaType) };
        if (etag is not null) res.Headers.TryAddWithoutValidation("ETag", etag);
        return res;
    }
}

public sealed class FakeTheme : IThemeService
{
    public bool IsDark { get; set; }
}

public sealed class FakeTokens : ITokenProvider
{
    public int Invalidated { get; private set; }
    public ValueTask<string?> GetTokenAsync(CancellationToken ct = default) => ValueTask.FromResult<string?>("test-token");
    public void Invalidate() => Invalidated++;
}

public static class Samples
{
    public const string PlayerJson = """
        {"format":1,"title":"The Gate","version":3,"start":"gate","scenes":{
          "gate":{"title":"Gate","text":"A gate in the fog.","media":null,"choices":[{"label":"Go left","to":"forest"},{"label":"Go right","to":"river"}],"end":false},
          "forest":{"title":"Forest","text":"Tall trees.","media":null,"choices":[{"label":"Back to the gate","to":"gate"}],"end":false},
          "river":{"title":"River","text":"The end.","media":null,"choices":[],"end":true}}}
        """;

    public static readonly Guid ProjectId = Guid.Parse("11111111-1111-1111-1111-111111111111");

    public static ProjectDetail Project(int version = 4) => new(
        ProjectId, "Fog", "editor", Guid.NewGuid(), version,
        new StoryDoc("a",
            [new StoryNode("a", "Start", "Hello", null, 0, 0), new StoryNode("b", "Next", "Bye", null, 0, 0)],
            [new StoryEdge("e1", "a", "b", "Walk on")]),
        DateTimeOffset.UnixEpoch);
}

/// <summary>An in-memory IBranchStoryApi for ViewModel tests: no HTTP at all.</summary>
public sealed class FakeApi : IBranchStoryApi
{
    public ProjectDetail Project { get; set; } = Samples.Project();
    public ApiResult<SaveDocResponse>? NextSave { get; set; }
    public List<(StoryDoc Doc, int Expected)> Saves { get; } = [];

    public Task<ApiResult<List<ProjectSummary>>> GetMyStoriesAsync(CancellationToken ct = default) =>
        Task.FromResult(ApiResult<List<ProjectSummary>>.Ok(
            [new ProjectSummary(Project.Id, Project.Title, Project.Role, "Ada", Project.Version, Project.UpdatedAt)]));

    public Task<ApiResult<ProjectDetail>> GetProjectAsync(Guid id, CancellationToken ct = default) =>
        Task.FromResult(ApiResult<ProjectDetail>.Ok(Project));

    public Task<ApiResult<PlayerStory>> GetPublicStoryAsync(string slug, CancellationToken ct = default) =>
        Task.FromResult(ApiResult<PlayerStory>.Fail(ApiStatus.NotFound));

    public Task<ApiResult<SaveDocResponse>> SaveDocAsync(Guid id, StoryDoc doc, int expectedVersion, CancellationToken ct = default)
    {
        Saves.Add((doc, expectedVersion));
        return Task.FromResult(NextSave ?? ApiResult<SaveDocResponse>.Ok(new SaveDocResponse(expectedVersion + 1, DateTimeOffset.UnixEpoch)));
    }
}
```

`tests/BranchStory.Client.Tests/BranchStoryApiTests.cs`:

```csharp
using System.Net;
using BranchStory.Client.Api;
using BranchStory.Client.Cache;

namespace BranchStory.Client.Tests;

public class BranchStoryApiTests
{
    private static (BranchStoryApi Api, StubHandler Net, MemoryStoryCache Cache) Create(Func<HttpRequestMessage, HttpResponseMessage> respond)
    {
        var net = new StubHandler(respond);
        var cache = new MemoryStoryCache();
        var http = new HttpClient(new BearerTokenHandler(new FakeTokens()) { InnerHandler = net })
        {
            BaseAddress = new Uri("http://localhost:5080"),
        };
        return (new BranchStoryApi(http, cache), net, cache);
    }

    [Fact]
    public async Task First_load_stores_the_body_and_the_ETag_and_sends_the_token()
    {
        var (api, net, cache) = Create(_ => StubHandler.Json(HttpStatusCode.OK, Samples.PlayerJson, "\"3-abc\""));

        var result = await api.GetPublicStoryAsync("the-gate", TestContext.Current.CancellationToken);

        Assert.Equal(ApiStatus.Ok, result.Status);
        Assert.Equal(DataSource.Network, result.Source);
        Assert.Equal("Gate", result.Value!.Scenes["gate"].Title);
        Assert.Equal("Bearer test-token", net.Requests[0].Headers.Authorization!.ToString());
        Assert.Equal("\"3-abc\"", (await cache.GetAsync("/api/public/stories/the-gate", TestContext.Current.CancellationToken))!.ETag);
    }

    [Fact]
    public async Task Second_load_revalidates_with_If_None_Match_and_uses_the_cache_on_304()
    {
        var calls = 0;
        var (api, net, _) = Create(_ => ++calls == 1
            ? StubHandler.Json(HttpStatusCode.OK, Samples.PlayerJson, "\"3-abc\"")
            : new HttpResponseMessage(HttpStatusCode.NotModified));
        var ct = TestContext.Current.CancellationToken;

        await api.GetPublicStoryAsync("the-gate", ct);
        var second = await api.GetPublicStoryAsync("the-gate", ct);

        Assert.Equal("\"3-abc\"", net.Requests[1].Headers.IfNoneMatch.Single().ToString());
        Assert.Equal(DataSource.Revalidated, second.Source);
        Assert.Equal("The Gate", second.Value!.Title);
    }

    [Fact]
    public async Task Network_failure_falls_back_to_the_offline_copy()
    {
        var online = true;
        var (api, _, _) = Create(_ => online
            ? StubHandler.Json(HttpStatusCode.OK, Samples.PlayerJson, "\"3-abc\"")
            : throw new HttpRequestException("No route to host"));
        var ct = TestContext.Current.CancellationToken;

        await api.GetPublicStoryAsync("the-gate", ct);
        online = false;
        var result = await api.GetPublicStoryAsync("the-gate", ct);

        Assert.True(result.IsOk);
        Assert.True(result.IsStale);
        Assert.NotNull(result.CachedAt);
    }

    [Fact]
    public async Task Network_failure_without_a_cached_copy_is_Offline()
    {
        var (api, _, _) = Create(_ => throw new HttpRequestException("down"));

        var result = await api.GetMyStoriesAsync(TestContext.Current.CancellationToken);

        Assert.Equal(ApiStatus.Offline, result.Status);
    }

    [Fact]
    public async Task A_404_deletes_the_cached_copy()
    {
        var calls = 0;
        var (api, _, cache) = Create(_ => ++calls == 1
            ? StubHandler.Json(HttpStatusCode.OK, Samples.PlayerJson, "\"3-abc\"")
            : new HttpResponseMessage(HttpStatusCode.NotFound));
        var ct = TestContext.Current.CancellationToken;

        await api.GetPublicStoryAsync("the-gate", ct);
        var result = await api.GetPublicStoryAsync("the-gate", ct);

        Assert.Equal(ApiStatus.NotFound, result.Status);
        Assert.Null(await cache.GetAsync("/api/public/stories/the-gate", ct));
    }

    [Fact]
    public async Task A_409_becomes_Conflict_with_the_current_version()
    {
        var (api, net, _) = Create(_ => StubHandler.Json(HttpStatusCode.Conflict,
            """{"type":"https://branchstory.dev/problems/version-conflict","title":"Version conflict","status":409,"currentVersion":5}""",
            mediaType: "application/problem+json"));

        var result = await api.SaveDocAsync(Samples.ProjectId, Samples.Project().Doc, 4, TestContext.Current.CancellationToken);

        Assert.Equal(ApiStatus.Conflict, result.Status);
        Assert.Equal(5, result.Problem!.CurrentVersion);
        Assert.Equal(HttpMethod.Put, net.Requests[0].Method);
        Assert.Contains("\"expectedVersion\":4", await net.Requests[0].Content!.ReadAsStringAsync(TestContext.Current.CancellationToken));
    }
}
```

`tests/BranchStory.Client.Tests/StoryWalkerTests.cs`:

```csharp
using System.Text.Json;
using BranchStory.Client.Models;
using BranchStory.Client.Story;

namespace BranchStory.Client.Tests;

public class StoryWalkerTests
{
    private static StoryGraph Gate() =>
        StoryGraph.FromPlayer(JsonSerializer.Deserialize(Samples.PlayerJson, ClientJson.Default.PlayerStory)!);

    [Fact]
    public void Starts_at_the_start_scene_with_its_choices()
    {
        var walker = new StoryWalker(Gate());

        Assert.Equal("gate", walker.SceneId);
        Assert.Equal(["Go left", "Go right"], walker.Choices.Select(c => c.Label));
        Assert.False(walker.CanGoBack);
    }

    [Fact]
    public void Choosing_and_going_back_follow_the_path()
    {
        var walker = new StoryWalker(Gate());

        walker.Choose(1);
        Assert.Equal("river", walker.SceneId);
        Assert.True(walker.IsEnd);

        Assert.True(walker.Back());
        Assert.Equal("gate", walker.SceneId);
    }

    [Fact]
    public void Coming_round_a_loop_sets_Looped()
    {
        var walker = new StoryWalker(Gate());

        walker.Choose(0); // forest
        walker.Choose(0); // back to the gate

        Assert.True(walker.Looped);
        Assert.Equal(["gate", "forest", "gate"], walker.Path);
    }

    [Fact]
    public void FindCycle_returns_the_loop()
    {
        Assert.Equal(["gate", "forest", "gate"], StoryWalker.FindCycle(Gate()));
    }

    [Fact]
    public void Resume_stops_where_the_new_version_changed()
    {
        var graph = StoryGraph.FromProject(Samples.Project());

        var walker = StoryWalker.Resume(graph, ["a", "b", "zzz"]);

        Assert.Equal("b", walker.SceneId);
    }

    [Fact]
    public void A_missing_start_scene_throws()
    {
        var bad = new StoryGraph("x", 1, "nope", new Dictionary<string, PlayerScene>());
        Assert.Throws<InvalidOperationException>(() => new StoryWalker(bad));
    }
}
```

`tests/BranchStory.Client.Tests/ViewModelTests.cs`:

```csharp
using BranchStory.Client.Api;
using BranchStory.Client.Models;
using BranchStory.Client.ViewModels;

namespace BranchStory.Client.Tests;

public class ViewModelTests
{
    [Fact]
    public async Task Opening_a_story_pushes_the_reader_and_back_pops_it()
    {
        var shell = new ShellViewModel(new FakeTheme());
        var list = new StoryListViewModel(new FakeApi(), shell);
        shell.Reset(list);
        await list.LoadCommand.ExecuteAsync(null);

        list.OpenCommand.Execute(list.Stories[0]);

        var reader = Assert.IsType<ReaderViewModel>(shell.Current);
        Assert.Equal("Start", reader.SceneTitle);
        Assert.True(shell.GoBackCommand.CanExecute(null));

        shell.GoBackCommand.Execute(null);
        Assert.Same(list, shell.Current);
        Assert.False(shell.CanGoBack);
    }

    [Fact]
    public async Task Reader_walks_the_story_and_updates_the_commands()
    {
        var reader = new ReaderViewModel(new FakeApi(), ReaderSource.ForProject(Samples.ProjectId, "viewer"), "Fog");
        await reader.LoadCommand.ExecuteAsync(null);
        Assert.False(reader.StepBackCommand.CanExecute(null));
        Assert.False(reader.BeginEditCommand.CanExecute(null)); // a viewer cannot edit

        reader.ChooseCommand.Execute(reader.Choices[0]);

        Assert.Equal("Next", reader.SceneTitle);
        Assert.True(reader.IsEnd);
        Assert.True(reader.StepBackCommand.CanExecute(null));
    }

    [Fact]
    public async Task Saving_sends_the_version_it_was_based_on()
    {
        var api = new FakeApi();
        var reader = new ReaderViewModel(api, ReaderSource.ForProject(Samples.ProjectId, "editor"), "Fog");
        await reader.LoadCommand.ExecuteAsync(null);

        reader.BeginEditCommand.Execute(null);
        reader.Draft = "Hello, fixed typo";
        await reader.SaveEditCommand.ExecuteAsync(null);

        var (doc, expected) = Assert.Single(api.Saves);
        Assert.Equal(4, expected);
        Assert.Equal("Hello, fixed typo", doc.Nodes.Single(n => n.Id == "a").Text);
        Assert.False(reader.IsEditing);
    }

    [Fact]
    public async Task A_conflict_keeps_the_draft_and_offers_a_reload()
    {
        var api = new FakeApi
        {
            NextSave = ApiResult<SaveDocResponse>.Fail(ApiStatus.Conflict, new Problem(null, "Version conflict", 409, null, 5)),
        };
        var reader = new ReaderViewModel(api, ReaderSource.ForProject(Samples.ProjectId, "owner"), "Fog");
        await reader.LoadCommand.ExecuteAsync(null);
        reader.BeginEditCommand.Execute(null);
        reader.Draft = "My precious edit";

        await reader.SaveEditCommand.ExecuteAsync(null);

        Assert.True(reader.HasConflict);
        Assert.True(reader.IsEditing);
        Assert.Contains("version 5", reader.Status);

        api.Project = Samples.Project(version: 5);
        await reader.ReloadAfterConflictCommand.ExecuteAsync(null);
        Assert.Equal("My precious edit", reader.Draft);
        Assert.False(reader.HasConflict);

        api.NextSave = null;
        await reader.SaveEditCommand.ExecuteAsync(null);
        Assert.Equal(5, api.Saves[^1].Expected);
    }

    [Fact]
    public void Toggling_the_theme_raises_IsDark()
    {
        var theme = new FakeTheme();
        var shell = new ShellViewModel(theme);
        var raised = new List<string?>();
        shell.PropertyChanged += (_, e) => raised.Add(e.PropertyName);

        shell.ToggleThemeCommand.Execute(null);

        Assert.True(theme.IsDark);
        Assert.Contains(nameof(ShellViewModel.IsDark), raised);
    }
}
```

**10. Add both projects to the solution and run the tests.**

```bash
dotnet sln add src/BranchStory.Client tests/BranchStory.Client.Tests
dotnet build
dotnet test
```

Expected: the build ends with `0 Warning(s)` and `0 Error(s)`, and the test run ends with

```text
Passed!  - Failed:     0, Passed:    17, Skipped:     0, Total:    17, Duration: … - BranchStory.Client.Tests.dll (net10.0)
```

:::tip title="If a test fails"
Read the test name first. It says which rule broke ("A_404_deletes_the_cached_copy"). A
`JsonException` usually means a DTO property name doesn't match the JSON; with
`JsonSerializerDefaults.Web`, `CurrentVersion` maps to `currentVersion` automatically.
:::

- [ ] `dotnet build` of the solution reports 0 warnings and 0 errors
- [ ] `dotnet test` reports 17 passed tests
- [ ] `BranchStory.Client.csproj` references only `CommunityToolkit.Mvvm` (no Avalonia, no MAUI)
- [ ] You can explain why `Network_failure_falls_back_to_the_offline_copy` returns `IsOk` *and* `IsStale`
:::

## Phase 7: the Avalonia desktop head

The desktop head is mostly XAML. Four things deserve a closer look.

**1. An explicit ViewLocator.** The template's `ViewLocator` finds a view by renaming the ViewModel's
type name with reflection (`…ViewModels.ReaderViewModel` → `…Views.ReaderView`). Our ViewModels
live in a *different assembly* and namespace, so that trick fails. A `switch` is clearer, is checked
by the compiler, and survives trimming:

```csharp
public Control? Build(object? param) => param switch
{
    SignInViewModel => new SignInView(),
    StoryListViewModel => new StoryListView(),
    ReaderViewModel => new ReaderView(),
    _ => new TextBlock { Text = $"No view for {param?.GetType().Name}" },
};
```

`MainWindow` contains a `ContentControl` bound to `ShellViewModel.Current`. When `Current` changes,
Avalonia asks the `ViewLocator` (registered in `App.axaml` under `DataTemplates`) for a matching view.
That's the whole navigation system on the desktop.

**2. Compiled bindings and reaching the parent's command.** With `x:DataType`, every `{Binding}` is
checked at **compile time**: a typo becomes a build error instead of a silent blank. Inside a
`DataTemplate x:DataType="m:PlayerChoice"`, though, `{Binding ChooseCommand}` would look for
`ChooseCommand` on the *choice*. To reach the page's ViewModel, walk up to the `UserControl` and
cast its `DataContext`:

```xml
<DataTemplate x:DataType="m:PlayerChoice">
    <Button Content="{Binding Label}"
            Command="{Binding $parent[UserControl].((vm:ReaderViewModel)DataContext).ChooseCommand}"
            CommandParameter="{Binding}" />
</DataTemplate>
```

`$parent[UserControl]` is Avalonia's syntax for "the nearest ancestor of type `UserControl`", and
`((vm:ReaderViewModel)DataContext)` is a cast, so the compiler knows the type. In WPF and MAUI the
same thing is written with `RelativeSource AncestorType`.

**3. Dark mode in three lines.** `AvaloniaThemeService` sets
`Application.RequestedThemeVariant` to `ThemeVariant.Dark` or `ThemeVariant.Light`. The Fluent theme
swaps every theme resource at once, and our own styles use `{DynamicResource …}` brushes so they
follow (from *Styles, Themes & Resources*). The `ToggleSwitch` binds two-way to `ShellViewModel.IsDark`.

**4. The composition root.** `App.OnFrameworkInitializationCompleted` is the one place that
creates concrete classes: the shell, the theme service, the sign-in page and the factory that
builds `ClientServices` for a user. Small apps don't need a DI container; the code reads top to
bottom and every dependency is visible.

:::quiz id=dsk-12-q7 xp=10
Inside `<DataTemplate x:DataType="m:PlayerChoice">` in `ReaderView.axaml`, you write
`Command="{Binding ChooseCommand}"`. What happens with compiled bindings turned on?
- [ ] It works: Avalonia searches up the tree until it finds a `ChooseCommand`
- [x] The build fails, because `PlayerChoice` has no `ChooseCommand` property; you need `$parent[UserControl].((vm:ReaderViewModel)DataContext).ChooseCommand`
- [ ] It compiles, and at run time the button is silently disabled
- [ ] It works only if `CommandParameter` is also set
> Bindings resolve against the **DataContext**, which inside an item template is the item (a `PlayerChoice`). They never search up the tree on their own. With `x:DataType` the XAML compiler knows that type and refuses a property that doesn't exist, which is the main benefit of compiled bindings. Reflection bindings (WPF's default) would compile and then fail silently at run time with a warning in the output, which is the third option and the reason teams turn compiled bindings on.
:::

:::lab id=dsk-12-lab2 xp=150
title: Phase 7 — the Avalonia app, headless UI tests and a release build
Add the desktop head on top of Lab 1, test it headless (Avalonia's in-memory platform: real windows,
layout and input, no screen), run it against your Capstone API, and publish a single-file build.

**1. Create the Avalonia project** (from the `BranchStoryClient` folder) and remove the template's
ViewModels: ours live in the library.

```bash
dotnet new avalonia.mvvm -o src/BranchStory.Desktop -n BranchStory.Desktop
rm -r src/BranchStory.Desktop/ViewModels src/BranchStory.Desktop/ViewLocator.cs
mkdir -p src/BranchStory.Desktop/Services tests/BranchStory.Desktop.Tests
```

**2. `src/BranchStory.Desktop/BranchStory.Desktop.csproj`** (replace it). The template's package
versions plus a reference to the library. In Avalonia 12, compiled bindings are the default, so the
template needs no extra switch.

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ApplicationManifest>app.manifest</ApplicationManifest>
  </PropertyGroup>

  <ItemGroup>
    <AvaloniaResource Include="Assets\**" />
  </ItemGroup>

  <ItemGroup>
    <PackageReference Include="Avalonia" Version="12.1.5" />
    <PackageReference Include="Avalonia.Desktop" Version="12.1.5" />
    <PackageReference Include="Avalonia.Themes.Fluent" Version="12.1.5" />
    <PackageReference Include="Avalonia.Fonts.Inter" Version="12.1.5" />
    <PackageReference Include="AvaloniaUI.DiagnosticsSupport" Version="2.2.3">
      <IncludeAssets Condition="'$(Configuration)' != 'Debug'">None</IncludeAssets>
      <PrivateAssets Condition="'$(Configuration)' != 'Debug'">All</PrivateAssets>
    </PackageReference>
    <PackageReference Include="CommunityToolkit.Mvvm" Version="8.4.2" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\BranchStory.Client\BranchStory.Client.csproj" />
  </ItemGroup>
</Project>
```

Keep the generated `Program.cs`, `app.manifest`, `Assets/` and `Views/MainWindow.axaml.cs` as they are.

:::warn title="On Avalonia 11.x?"
These labs were built and tested on Avalonia 12.1.5 only. For 11.x, keep the version numbers your
template generated and keep its `<AvaloniaUseCompiledBindingsByDefault>true</AvaloniaUseCompiledBindingsByDefault>`
line (on 11.x compiled bindings are opt-in, and the `$parent[...]` casts need them). `TextBox.PlaceholderText`
is called `Watermark` there, and the headless screenshot call is `.Save("file.png")`. Check the
headless-testing page of the Avalonia docs (docs.avaloniaui.net) for which xUnit version your 11.x
`Avalonia.Headless.XUnit` package supports.
:::

**3. `src/BranchStory.Desktop/App.axaml`** and **`App.axaml.cs`**:

```xml
<Application xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             x:Class="BranchStory.Desktop.App"
             xmlns:local="using:BranchStory.Desktop"
             RequestedThemeVariant="Default">

    <Application.DataTemplates>
        <local:ViewLocator />
    </Application.DataTemplates>

    <Application.Styles>
        <FluentTheme />
        <Style Selector="TextBlock.h1">
            <Setter Property="FontSize" Value="24" />
            <Setter Property="FontWeight" Value="SemiBold" />
        </Style>
        <Style Selector="TextBlock.muted">
            <Setter Property="Opacity" Value="0.7" />
            <Setter Property="TextWrapping" Value="Wrap" />
        </Style>
        <Style Selector="Border.banner">
            <Setter Property="Background" Value="{DynamicResource SystemFillColorCautionBackgroundBrush}" />
            <Setter Property="CornerRadius" Value="6" />
            <Setter Property="Padding" Value="12,8" />
        </Style>
    </Application.Styles>
</Application>
```

```csharp
using System;
using System.IO;
using Avalonia;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Markup.Xaml;
using BranchStory.Client.Api;
using BranchStory.Client.ViewModels;
using BranchStory.Desktop.Services;
using BranchStory.Desktop.Views;

namespace BranchStory.Desktop;

public partial class App : Application
{
    public override void Initialize()
    {
        AvaloniaXamlLoader.Load(this);
    }

    public override void OnFrameworkInitializationCompleted()
    {
        if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop)
        {
            // The composition root: the one place that knows every concrete class.
            var cacheRoot = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BranchStory", "cache");
            var shell = new ShellViewModel(new AvaloniaThemeService(this));
            shell.Reset(new SignInViewModel(shell, (api, user) => ClientServices.Create(api, user, cacheRoot)));

            desktop.MainWindow = new MainWindow { DataContext = shell };
        }

        base.OnFrameworkInitializationCompleted();
    }
}
```

**4. `src/BranchStory.Desktop/ViewLocator.cs`** and **`Services/AvaloniaThemeService.cs`**:

```csharp
using Avalonia.Controls;
using Avalonia.Controls.Templates;
using BranchStory.Client.ViewModels;
using BranchStory.Desktop.Views;

namespace BranchStory.Desktop;

/// <summary>
/// Turns a page ViewModel into its View. An explicit switch instead of the template's
/// reflection: the ViewModels live in another assembly, and trimming can't break a switch.
/// </summary>
public sealed class ViewLocator : IDataTemplate
{
    public Control? Build(object? param) => param switch
    {
        SignInViewModel => new SignInView(),
        StoryListViewModel => new StoryListView(),
        ReaderViewModel => new ReaderView(),
        _ => new TextBlock { Text = $"No view for {param?.GetType().Name}" },
    };

    public bool Match(object? data) => data is ViewModelBase;
}
```

```csharp
using Avalonia;
using Avalonia.Styling;
using BranchStory.Client.ViewModels;

namespace BranchStory.Desktop.Services;

/// <summary>Dark mode for the whole app: Fluent swaps every theme resource when the variant changes.</summary>
public sealed class AvaloniaThemeService(Application app) : IThemeService
{
    public bool IsDark
    {
        get => app.ActualThemeVariant == ThemeVariant.Dark;
        set => app.RequestedThemeVariant = value ? ThemeVariant.Dark : ThemeVariant.Light;
    }
}
```

**5. `src/BranchStory.Desktop/Views/MainWindow.axaml`** (replace it):

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        xmlns:vm="using:BranchStory.Client.ViewModels"
        x:Class="BranchStory.Desktop.Views.MainWindow"
        x:DataType="vm:ShellViewModel"
        Icon="/Assets/avalonia-logo.ico"
        Title="BranchStory"
        Width="900" Height="640" MinWidth="360" MinHeight="400">

    <DockPanel>
        <Grid DockPanel.Dock="Top" ColumnDefinitions="Auto,*,Auto" Margin="12,8">
            <Button Name="BackButton" Content="Back" Command="{Binding GoBackCommand}"
                    IsVisible="{Binding CanGoBack}" HotKey="Alt+Left" />
            <TextBlock Grid.Column="1" Text="BranchStory" FontSize="18" FontWeight="SemiBold"
                       VerticalAlignment="Center" Margin="12,0" />
            <ToggleSwitch Grid.Column="2" Name="DarkSwitch" IsChecked="{Binding IsDark}"
                          OnContent="Dark" OffContent="Light" />
        </Grid>
        <ContentControl Name="Page" Content="{Binding Current}" Margin="16,8,16,16" />
    </DockPanel>
</Window>
```

**6. The three page views.** `Views/SignInView.axaml`:

```xml
<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="using:BranchStory.Client.ViewModels"
             x:Class="BranchStory.Desktop.Views.SignInView"
             x:DataType="vm:SignInViewModel">
    <StackPanel MaxWidth="420" Spacing="12" VerticalAlignment="Center">
        <TextBlock Classes="h1" Text="Sign in" />
        <TextBlock Classes="muted"
                   Text="Development sign-in: the API issues a token for any username (POST /api/dev/token)." />
        <TextBox Name="ApiBox" PlaceholderText="API address" Text="{Binding ApiBase}" />
        <TextBox Name="UserBox" PlaceholderText="Username" Text="{Binding Username}" />
        <Button Name="SignInButton" Content="Sign in" Command="{Binding SignInCommand}"
                IsDefault="True" HorizontalAlignment="Stretch" HorizontalContentAlignment="Center" />
        <TextBlock Name="ErrorText" Text="{Binding Error}" IsVisible="{Binding Error, Converter={x:Static ObjectConverters.IsNotNull}}"
                   Foreground="{DynamicResource SystemFillColorCriticalBrush}" TextWrapping="Wrap" />
    </StackPanel>
</UserControl>
```

`Views/StoryListView.axaml`:

```xml
<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="using:BranchStory.Client.ViewModels"
             xmlns:m="using:BranchStory.Client.Models"
             x:Class="BranchStory.Desktop.Views.StoryListView"
             x:DataType="vm:StoryListViewModel">
    <DockPanel>
        <StackPanel DockPanel.Dock="Top" Spacing="8" Margin="0,0,0,12">
            <Grid ColumnDefinitions="*,Auto">
                <TextBlock Classes="h1" Text="My stories" />
                <Button Grid.Column="1" Name="RefreshButton" Content="Refresh" Command="{Binding LoadCommand}" HotKey="F5" />
            </Grid>
            <Grid ColumnDefinitions="*,Auto" >
                <TextBox Name="SlugBox" PlaceholderText="Published story link slug, e.g. the-gate" Text="{Binding Slug}" />
                <Button Grid.Column="1" Margin="8,0,0,0" Content="Read" Command="{Binding OpenPublicCommand}" />
            </Grid>
            <Border Classes="banner" IsVisible="{Binding IsOffline}">
                <TextBlock Text="Offline mode" FontWeight="SemiBold" />
            </Border>
            <TextBlock Name="StatusText" Classes="muted" Text="{Binding Status}" />
            <ProgressBar IsIndeterminate="True" IsVisible="{Binding IsBusy}" />
        </StackPanel>

        <ListBox Name="StoryList" ItemsSource="{Binding Stories}">
            <ListBox.ItemTemplate>
                <DataTemplate x:DataType="m:ProjectSummary">
                    <Grid ColumnDefinitions="*,Auto">
                        <StackPanel>
                            <TextBlock Text="{Binding Title}" FontWeight="SemiBold" />
                            <TextBlock Classes="muted">
                                <Run Text="{Binding Role}" />
                                <Run Text=" · by " />
                                <Run Text="{Binding OwnerName}" />
                                <Run Text=" · v" />
                                <Run Text="{Binding Version}" />
                            </TextBlock>
                        </StackPanel>
                        <Button Grid.Column="1" Content="Open" VerticalAlignment="Center"
                                Command="{Binding $parent[UserControl].((vm:StoryListViewModel)DataContext).OpenCommand}"
                                CommandParameter="{Binding}" />
                    </Grid>
                </DataTemplate>
            </ListBox.ItemTemplate>
        </ListBox>
    </DockPanel>
</UserControl>
```

`Views/ReaderView.axaml`:

```xml
<UserControl xmlns="https://github.com/avaloniaui"
             xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
             xmlns:vm="using:BranchStory.Client.ViewModels"
             xmlns:m="using:BranchStory.Client.Models"
             x:Class="BranchStory.Desktop.Views.ReaderView"
             x:DataType="vm:ReaderViewModel">
    <DockPanel>
        <StackPanel DockPanel.Dock="Top" Spacing="8" Margin="0,0,0,12">
            <TextBlock Classes="muted" Text="{Binding Title}" />
            <Border Classes="banner" IsVisible="{Binding IsOffline}">
                <TextBlock Text="Offline: you're reading a saved copy" FontWeight="SemiBold" />
            </Border>
            <TextBlock Name="StatusText" Classes="muted" Text="{Binding Status}" />
            <ProgressBar IsIndeterminate="True" IsVisible="{Binding IsBusy}" />
        </StackPanel>

        <StackPanel DockPanel.Dock="Bottom" Orientation="Horizontal" Spacing="8" Margin="0,12,0,0">
            <Button Name="StepBackButton" Content="Previous scene" Command="{Binding StepBackCommand}" />
            <Button Content="Restart" Command="{Binding RestartCommand}" />
            <Button Name="EditButton" Content="Fix text" Command="{Binding BeginEditCommand}" />
        </StackPanel>

        <ScrollViewer>
            <StackPanel Spacing="12" MaxWidth="680" HorizontalAlignment="Left" IsVisible="{Binding HasStory}">
                <TextBlock Name="SceneTitle" Classes="h1" Text="{Binding SceneTitle}" />
                <TextBlock Name="SceneText" Text="{Binding SceneText}" TextWrapping="Wrap" FontSize="16"
                           IsVisible="{Binding !IsEditing}" />

                <StackPanel Spacing="8" IsVisible="{Binding IsEditing}">
                    <TextBox Name="DraftBox" Text="{Binding Draft}" AcceptsReturn="True" TextWrapping="Wrap" MinHeight="120" />
                    <StackPanel Orientation="Horizontal" Spacing="8">
                        <Button Name="SaveButton" Content="Save" Command="{Binding SaveEditCommand}" />
                        <Button Content="Cancel" Command="{Binding CancelEditCommand}" />
                        <Button Name="ReloadButton" Content="Reload latest" Command="{Binding ReloadAfterConflictCommand}"
                                IsVisible="{Binding HasConflict}" />
                    </StackPanel>
                </StackPanel>

                <TextBlock Text="You've been here before on this path." Classes="muted" IsVisible="{Binding Looped}" />
                <TextBlock Name="EndText" Text="The End" FontWeight="SemiBold" IsVisible="{Binding IsEnd}" />

                <ItemsControl Name="ChoiceList" ItemsSource="{Binding Choices}">
                    <ItemsControl.ItemTemplate>
                        <DataTemplate x:DataType="m:PlayerChoice">
                            <Button Content="{Binding Label}" Margin="0,0,0,8" HorizontalAlignment="Stretch"
                                    Command="{Binding $parent[UserControl].((vm:ReaderViewModel)DataContext).ChooseCommand}"
                                    CommandParameter="{Binding}" />
                        </DataTemplate>
                    </ItemsControl.ItemTemplate>
                </ItemsControl>
            </StackPanel>
        </ScrollViewer>
    </DockPanel>
</UserControl>
```

Each view needs the usual code-behind. `Views/SignInView.axaml.cs`:

```csharp
using Avalonia.Controls;

namespace BranchStory.Desktop.Views;

public partial class SignInView : UserControl
{
    public SignInView()
    {
        InitializeComponent();
    }
}
```

`Views/StoryListView.axaml.cs` and `Views/ReaderView.axaml.cs` are the same with the class name
changed (`StoryListView`, `ReaderView`).

**7. Headless UI tests.** `tests/BranchStory.Desktop.Tests/BranchStory.Desktop.Tests.csproj`. It
references the Lab 1 test project to reuse `FakeApi`:

```xml
<Project Sdk="Microsoft.NET.Sdk">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <OutputType>Exe</OutputType>
    <IsPackable>false</IsPackable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.1" />
    <PackageReference Include="xunit.v3" Version="3.2.2" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.5" />
    <PackageReference Include="Avalonia.Headless.XUnit" Version="12.1.5" />
    <PackageReference Include="Avalonia.Skia" Version="12.1.5" />
  </ItemGroup>

  <ItemGroup>
    <Using Include="Xunit" />
  </ItemGroup>

  <ItemGroup>
    <ProjectReference Include="..\..\src\BranchStory.Desktop\BranchStory.Desktop.csproj" />
    <ProjectReference Include="..\BranchStory.Client.Tests\BranchStory.Client.Tests.csproj" />
  </ItemGroup>

</Project>
```

`tests/BranchStory.Desktop.Tests/TestAppBuilder.cs` starts the real `App` (styles, ViewLocator) on
the headless platform. **Skia** is the 2D graphics library Avalonia draws with; with
`UseHeadlessDrawing = false` it renders real frames in memory, so the tests can save screenshots:

```csharp
using Avalonia;
using Avalonia.Headless;
using BranchStory.Desktop;

[assembly: AvaloniaTestApplication(typeof(BranchStory.Desktop.Tests.TestAppBuilder))]

namespace BranchStory.Desktop.Tests;

/// <summary>Starts the real App (styles, ViewLocator) on Avalonia's headless platform: no screen needed.</summary>
public class TestAppBuilder
{
    public static AppBuilder BuildAvaloniaApp() => AppBuilder.Configure<App>()
        .UseSkia()
        .UseHeadless(new AvaloniaHeadlessPlatformOptions { UseHeadlessDrawing = false });
}
```

`tests/BranchStory.Desktop.Tests/ReaderUiTests.cs`: click "Open", click a choice, go back; flip the
dark switch. (On Avalonia 11 the screenshot call is just `.Save("story-list.png")`; 12 asks for encoder options.)

```csharp
using Avalonia;
using Avalonia.Controls;
using Avalonia.Headless;
using Avalonia.Headless.XUnit;
using Avalonia.Input;
using Avalonia.Media.Imaging;
using Avalonia.Styling;
using Avalonia.Threading;
using Avalonia.VisualTree;
using BranchStory.Client.Tests;
using BranchStory.Client.ViewModels;
using BranchStory.Desktop.Services;
using BranchStory.Desktop.Views;

namespace BranchStory.Desktop.Tests;

public class ReaderUiTests
{
    private static async Task<(MainWindow Window, ShellViewModel Shell)> ShowStoryListAsync()
    {
        var shell = new ShellViewModel(new AvaloniaThemeService(Application.Current!));
        var list = new StoryListViewModel(new FakeApi(), shell);
        shell.Reset(list);
        await list.LoadCommand.ExecuteAsync(null);

        var window = new MainWindow { DataContext = shell };
        window.Show();
        Dispatcher.UIThread.RunJobs();
        return (window, shell);
    }

    private static void Click(Window window, Control control)
    {
        var center = control.TranslatePoint(new Point(control.Bounds.Width / 2, control.Bounds.Height / 2), window)!.Value;
        window.MouseDown(center, MouseButton.Left);
        window.MouseUp(center, MouseButton.Left);
        Dispatcher.UIThread.RunJobs();
    }

    private static Button ButtonWithText(Window window, string text) =>
        window.GetVisualDescendants().OfType<Button>().First(b => b.IsEffectivelyVisible && b.Content as string == text);

    private static T Named<T>(Window window, string name) where T : Control =>
        window.GetVisualDescendants().OfType<T>().First(c => c.Name == name);

    [AvaloniaFact]
    public async Task Open_a_story_pick_a_choice_and_go_back()
    {
        var (window, shell) = await ShowStoryListAsync();

        Click(window, ButtonWithText(window, "Open"));
        Assert.IsType<ReaderViewModel>(shell.Current);
        Assert.Equal("Start", Named<TextBlock>(window, "SceneTitle").Text);

        Click(window, ButtonWithText(window, "Walk on"));
        Assert.Equal("Next", Named<TextBlock>(window, "SceneTitle").Text);
        Assert.True(Named<TextBlock>(window, "EndText").IsVisible);

        Click(window, Named<Button>(window, "BackButton"));
        Assert.IsType<StoryListViewModel>(shell.Current);

        window.CaptureRenderedFrame()?.Save("story-list.png", new PngBitmapEncoderOptions());
    }

    [AvaloniaFact]
    public async Task The_dark_switch_changes_the_whole_app_theme()
    {
        var (window, _) = await ShowStoryListAsync();
        Application.Current!.RequestedThemeVariant = ThemeVariant.Light;
        Dispatcher.UIThread.RunJobs();

        Click(window, Named<ToggleSwitch>(window, "DarkSwitch"));

        Assert.Equal(ThemeVariant.Dark, Application.Current.ActualThemeVariant);
        window.CaptureRenderedFrame()?.Save("story-list-dark.png", new PngBitmapEncoderOptions());
    }
}
```

**8. Build and test everything.**

```bash
dotnet sln add src/BranchStory.Desktop tests/BranchStory.Desktop.Tests
dotnet build
dotnet test
```

Expected (two test assemblies):

```text
Passed!  - Failed:     0, Passed:    17, Skipped:     0, Total:    17, Duration: … - BranchStory.Client.Tests.dll (net10.0)
Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, Duration: … - BranchStory.Desktop.Tests.dll (net10.0)
```

Open `tests/BranchStory.Desktop.Tests/bin/Debug/net10.0/story-list-dark.png`: it shows the
story list (one story, "Fog", by Ada) in dark mode, rendered without a screen. These tests run
in CI on a Linux runner as they are.

**9. Run it against the Capstone API.** In your `branchstory` repository (a second terminal):

```bash
docker compose -f deploy/compose.yaml up -d db
dotnet run --project api/BranchStory.Api        # http://localhost:5080, Development
```

Then in `BranchStoryClient`:

```bash
dotnet run --project src/BranchStory.Desktop
```

Sign in as `ada` (the user you created stories with in the Capstone). Then try each failure on purpose:

| Try this | Expected in the app |
|---|---|
| Open a story, pick choices, press **Previous scene** and **Restart** | the scene changes, **Previous scene** is disabled at the start, **The End** shows at an ending |
| Open the same story in the web editor, change a scene's text and save. In the desktop app press **Fix text** on that scene, type, **Save** | the status line reports "Someone saved version N…", your text stays in the box and **Reload latest** appears; reload, then **Save** works |
| Type a published slug into the box and press **Read** | the published story opens (you get a 404 message for an unknown slug) |
| Stop the API (`Ctrl+C`), restart the desktop app and sign in again | an **Offline mode** banner and the cached list; stories you opened before still open with "Offline: reading the copy saved …" |
| Open the story list in the desktop app, delete one of its stories (in the web app, or with `curl -X DELETE localhost:5080/api/projects/<id> -H "authorization: Bearer $TOKEN"` as in *API Foundation*), then press **Open** on it in the desktop app without refreshing | "This story no longer exists…", and its cache file is gone |
| Flip the **Dark** switch | the whole window switches theme |

The cache folder is under your local app data: `~/.local/share/BranchStory/cache/` on Linux,
`%LOCALAPPDATA%\BranchStory\cache\` on Windows, `~/Library/Application Support/BranchStory/cache/`
on macOS.

**10. Publish a release build for your OS.** Self-contained (includes the .NET runtime, so users
don't need to install it) and single-file:

```bash
# Linux: linux-x64 · Windows: win-x64 · Apple silicon Mac: osx-arm64 (Intel: osx-x64)
dotnet publish src/BranchStory.Desktop -c Release -r linux-x64 --self-contained \
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o artifacts/linux-x64
./artifacts/linux-x64/BranchStory.Desktop
```

`-r` takes a **runtime identifier** (RID): the operating system plus CPU type to build for.
The output ends with `BranchStory.Desktop -> …/artifacts/linux-x64/`, and the folder holds one
executable of roughly 95 MB (plus `.pdb` debug symbols you don't ship). On Windows the file is
`BranchStory.Desktop.exe`.

- [ ] `dotnet test` passes 17 + 2 tests, and the dark screenshot shows the story list
- [ ] The app signs in against your Capstone API and lists your stories
- [ ] A conflicting edit shows the 409 message, keeps your text and saves after **Reload latest**
- [ ] With the API stopped, previously opened stories still open with the offline banner
- [ ] A deleted story shows the "no longer exists" message
- [ ] The single-file release build starts on your OS
:::

:::warn title="Trimming needs a test run, not hope"
You could add `-p:PublishTrimmed=true` to shrink the build a lot. The library is ready for it
(source-generated JSON, no reflection ViewLocator, compiled bindings), but third-party packages
may not be. Treat every trim warning as a bug, and run the trimmed build through the whole
"try this" table above before shipping it. *Testing & Shipping Desktop and Mobile Apps* covers the
publish matrix in detail.
:::

## Phase 8: the MAUI mobile head

The mobile reader reuses **the same library, unchanged**. Only the head is new: three pages, a
navigator, a theme service and a converter.

:::warn title="Linux can't build MAUI apps"
.NET MAUI has no Linux target and its workload doesn't install on Linux. Build Android and Windows
targets on **Windows** (Visual Studio 2026 or `dotnet` + the Android SDK) and iOS or Mac Catalyst on
**macOS** with Xcode. On Linux you can still build and test the shared library and the Avalonia app,
which is a good argument for keeping logic out of the heads. The MAUI code below was written for
.NET MAUI 10 but could not be compiled for this course (it was written on Linux). **Build and
verify it yourself on Windows or macOS**; if a template detail differs (target framework names,
manifest layout), the official .NET MAUI docs at learn.microsoft.com/dotnet/maui are the reference.
:::

What's different on a phone:

- **Navigation is native.** `MauiNavigator` implements `INavigator` with a `NavigationPage`:
  `Push` → `PushAsync(new ReaderPage(vm))`. The system back button and gestures pop pages
  without any code from you.
- **`localhost` is the phone, not your computer.** The Android emulator reaches your machine as
  `10.0.2.2`; a real phone needs your computer's LAN IP and an API listening on it.
- **Plain HTTP is blocked by default.** Android (API 28+) refuses cleartext traffic and iOS's App
  Transport Security refuses `http://`. For a *debug* build against a local API you allow it
  explicitly (see the lab). Real deployments use HTTPS and need no exception.
- **The platform HTTP stack.** `new HttpClientHandler()` maps to Android's and iOS's native
  handlers (system proxy, certificates). `ClientServices.Create` takes it as the `transport`.
- **No `!` in bindings.** Avalonia lets you write `IsVisible="{Binding !IsEditing}"`. MAUI needs a
  **value converter**, a small class whose `Convert` method turns the bound value into what the
  property needs. `InvertBoolConverter` returns `value is not true`.
- **App data vs cache folder.** `FileSystem.CacheDirectory` may be emptied by the OS when storage
  runs low. For "readable offline" stories use `FileSystem.AppDataDirectory`.

:::quiz id=dsk-12-q8 xp=10
On the Android emulator, the MAUI reader can't reach `http://localhost:5080` although the API runs
fine on your computer. What are the fixes for a **debug** build? (Select all that apply.)
- [x] Use `http://10.0.2.2:5080`, the emulator's alias for the host computer's loopback
- [x] Allow cleartext HTTP for the debug build, for example `android:usesCleartextTraffic="true"` in the manifest
- [ ] Add `localhost` to the device's hosts file through the MAUI project
- [ ] Switch `HttpClientHandler` to `SocketsHttpHandler`, which can reach the host's localhost
> Inside the emulator, `localhost` is the emulator itself; `10.0.2.2` is the special address Android's emulator gives the host. Android 9+ also blocks plain `http://` unless the app opts in, so a local HTTP API needs a debug-only exception (or local HTTPS). Hosts-file tricks don't exist for apps, and changing the handler doesn't change where `localhost` points. Never ship the cleartext exception in a release build.
:::

:::lab id=dsk-12-lab3 xp=120
title: Phase 8 — the MAUI mobile reader (Windows or macOS)
Add a MAUI head that reuses `BranchStory.Client` unchanged. **Verified on Windows/macOS by the
learner**: this can't be built on Linux.

**1. Install the workload and create the project** (in `BranchStoryClient`):

```bash
dotnet workload install maui
dotnet new maui -n BranchStory.Mobile -o src/BranchStory.Mobile
dotnet add src/BranchStory.Mobile reference src/BranchStory.Client
dotnet sln add src/BranchStory.Mobile
mkdir -p src/BranchStory.Mobile/Pages
```

The app uses a `NavigationPage` instead of Shell, so delete the template's `AppShell.xaml`,
`AppShell.xaml.cs`, `MainPage.xaml` and `MainPage.xaml.cs`. Keep `MauiProgram.cs`, `App.xaml`,
`Resources/` and `Platforms/` as generated.

**2. `src/BranchStory.Mobile/App.xaml.cs`** (replace it): the mobile composition root.

```csharp
using BranchStory.Client.Api;
using BranchStory.Client.ViewModels;

namespace BranchStory.Mobile;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
    }

    protected override Window CreateWindow(IActivationState? activationState)
    {
        var window = new Window();
        var navigator = new MauiNavigator(window);

        // AppDataDirectory survives restarts; CacheDirectory may be purged by the OS when space runs low.
        var cacheRoot = Path.Combine(FileSystem.AppDataDirectory, "stories");

        // The Android emulator reaches your computer's localhost as 10.0.2.2.
        var apiBase = DeviceInfo.Platform == DevicePlatform.Android ? "http://10.0.2.2:5080" : "http://localhost:5080";

        // new HttpClientHandler() maps to the platform's native HTTP stack on Android and iOS.
        navigator.Reset(new SignInViewModel(navigator,
            (api, user) => ClientServices.Create(api, user, cacheRoot, new HttpClientHandler()))
        {
            ApiBase = apiBase,
        });
        return window;
    }
}
```

**3. `MauiNavigator.cs`**, **`MauiThemeService.cs`** and **`InvertBoolConverter.cs`** (all in
`src/BranchStory.Mobile/`):

```csharp
using BranchStory.Client.ViewModels;
using BranchStory.Mobile.Pages;

namespace BranchStory.Mobile;

/// <summary>
/// INavigator on top of MAUI's own NavigationPage stack, so the Android back button,
/// the iOS swipe-back gesture and the title bar's back arrow all just work.
/// </summary>
public sealed class MauiNavigator(Window window) : INavigator
{
    private NavigationPage? _stack;

    public void Push(ViewModelBase page)
    {
        if (_stack is null) { Reset(page); return; }
        _ = _stack.PushAsync(PageFor(page));
    }

    public bool Pop()
    {
        if (_stack is null || _stack.Navigation.NavigationStack.Count <= 1) return false;
        _ = _stack.PopAsync();
        return true;
    }

    public void Reset(ViewModelBase root)
    {
        _stack = new NavigationPage(PageFor(root));
        window.Page = _stack;
    }

    private static ContentPage PageFor(ViewModelBase vm) => vm switch
    {
        SignInViewModel s => new SignInPage(s),
        StoryListViewModel l => new StoryListPage(l),
        ReaderViewModel r => new ReaderPage(r),
        _ => throw new ArgumentException($"No page for {vm.GetType().Name}", nameof(vm)),
    };
}
```

```csharp
using BranchStory.Client.ViewModels;

namespace BranchStory.Mobile;

/// <summary>UserAppTheme overrides the phone's setting; AppThemeBinding in Styles.xaml does the rest.</summary>
public sealed class MauiThemeService : IThemeService
{
    public bool IsDark
    {
        get => Application.Current!.RequestedTheme == AppTheme.Dark;
        set => Application.Current!.UserAppTheme = value ? AppTheme.Dark : AppTheme.Light;
    }
}
```

```csharp
using System.Globalization;

namespace BranchStory.Mobile;

/// <summary>MAUI bindings have no "!" operator (Avalonia's {Binding !IsEditing}), so a converter does it.</summary>
public sealed class InvertBoolConverter : IValueConverter
{
    public object? Convert(object? value, Type targetType, object? parameter, CultureInfo culture) => value is not true;
    public object? ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) => value is not true;
}
```

**4. The pages** in `src/BranchStory.Mobile/Pages/`. `SignInPage.xaml` and its code-behind:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:vm="clr-namespace:BranchStory.Client.ViewModels;assembly=BranchStory.Client"
             x:Class="BranchStory.Mobile.Pages.SignInPage"
             x:DataType="vm:SignInViewModel"
             Title="Sign in">
    <VerticalStackLayout Padding="24" Spacing="12">
        <Label Text="Development sign-in" FontSize="22" FontAttributes="Bold" />
        <Label Text="The API issues a token for any username (POST /api/dev/token)." />
        <Entry Placeholder="API address" Text="{Binding ApiBase}" Keyboard="Url" />
        <Entry Placeholder="Username" Text="{Binding Username}" />
        <Button Text="Sign in" Command="{Binding SignInCommand}" />
        <Label Text="{Binding Error}" TextColor="OrangeRed" />
    </VerticalStackLayout>
</ContentPage>
```

```csharp
using BranchStory.Client.ViewModels;

namespace BranchStory.Mobile.Pages;

public partial class SignInPage : ContentPage
{
    public SignInPage(SignInViewModel vm)
    {
        InitializeComponent();
        BindingContext = vm;
    }
}
```

`StoryListPage.xaml` (pull to refresh with `RefreshView`) and its code-behind:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:vm="clr-namespace:BranchStory.Client.ViewModels;assembly=BranchStory.Client"
             xmlns:m="clr-namespace:BranchStory.Client.Models;assembly=BranchStory.Client"
             x:Class="BranchStory.Mobile.Pages.StoryListPage"
             x:DataType="vm:StoryListViewModel"
             Title="My stories">
    <ContentPage.ToolbarItems>
        <ToolbarItem Text="Theme" Clicked="OnThemeClicked" />
    </ContentPage.ToolbarItems>

    <Grid RowDefinitions="Auto,Auto,*" Padding="16" RowSpacing="8">
        <Grid ColumnDefinitions="*,Auto" ColumnSpacing="8">
            <Entry Placeholder="Published slug, e.g. the-gate" Text="{Binding Slug}" />
            <Button Grid.Column="1" Text="Read" Command="{Binding OpenPublicCommand}" />
        </Grid>
        <Label Grid.Row="1" Text="{Binding Status}" />
        <RefreshView Grid.Row="2" IsRefreshing="{Binding IsBusy}" Command="{Binding LoadCommand}">
            <CollectionView ItemsSource="{Binding Stories}">
                <CollectionView.ItemTemplate>
                    <DataTemplate x:DataType="m:ProjectSummary">
                        <Grid ColumnDefinitions="*,Auto" Padding="0,8" ColumnSpacing="8">
                            <VerticalStackLayout>
                                <Label Text="{Binding Title}" FontAttributes="Bold" FontSize="18" />
                                <Label Text="{Binding OwnerName, StringFormat='by {0}'}" />
                            </VerticalStackLayout>
                            <Button Grid.Column="1" Text="Open" VerticalOptions="Center"
                                    Command="{Binding Source={RelativeSource AncestorType={x:Type vm:StoryListViewModel}}, x:DataType=vm:StoryListViewModel, Path=OpenCommand}"
                                    CommandParameter="{Binding .}" />
                        </Grid>
                    </DataTemplate>
                </CollectionView.ItemTemplate>
            </CollectionView>
        </RefreshView>
    </Grid>
</ContentPage>
```

```csharp
using BranchStory.Client.ViewModels;

namespace BranchStory.Mobile.Pages;

public partial class StoryListPage : ContentPage
{
    private readonly MauiThemeService _theme = new();

    public StoryListPage(StoryListViewModel vm)
    {
        InitializeComponent();
        BindingContext = vm;
    }

    private void OnThemeClicked(object? sender, EventArgs e) => _theme.IsDark = !_theme.IsDark;
}
```

`ReaderPage.xaml` and its code-behind. `BindableLayout` repeats a template for each choice without
the scrolling machinery of a `CollectionView`, which suits a list of two or three buttons:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:vm="clr-namespace:BranchStory.Client.ViewModels;assembly=BranchStory.Client"
             xmlns:m="clr-namespace:BranchStory.Client.Models;assembly=BranchStory.Client"
             xmlns:local="clr-namespace:BranchStory.Mobile"
             x:Class="BranchStory.Mobile.Pages.ReaderPage"
             x:DataType="vm:ReaderViewModel"
             Title="{Binding Title}">
    <ContentPage.Resources>
        <local:InvertBoolConverter x:Key="Not" />
    </ContentPage.Resources>

    <ScrollView>
        <VerticalStackLayout Padding="16" Spacing="12">
            <Label Text="{Binding Status}" />
            <ActivityIndicator IsRunning="{Binding IsBusy}" IsVisible="{Binding IsBusy}" />

            <VerticalStackLayout Spacing="12" IsVisible="{Binding HasStory}">
                <Label Text="{Binding SceneTitle}" FontSize="24" FontAttributes="Bold" SemanticProperties.HeadingLevel="Level1" />
                <Label Text="{Binding SceneText}" FontSize="17" IsVisible="{Binding IsEditing, Converter={StaticResource Not}}" />

                <VerticalStackLayout Spacing="8" IsVisible="{Binding IsEditing}">
                    <Editor Text="{Binding Draft}" AutoSize="TextChanges" MinimumHeightRequest="120" />
                    <HorizontalStackLayout Spacing="8">
                        <Button Text="Save" Command="{Binding SaveEditCommand}" />
                        <Button Text="Cancel" Command="{Binding CancelEditCommand}" />
                        <Button Text="Reload latest" Command="{Binding ReloadAfterConflictCommand}" IsVisible="{Binding HasConflict}" />
                    </HorizontalStackLayout>
                </VerticalStackLayout>

                <Label Text="You've been here before on this path." IsVisible="{Binding Looped}" />
                <Label Text="The End" FontAttributes="Bold" IsVisible="{Binding IsEnd}" />

                <VerticalStackLayout Spacing="8" BindableLayout.ItemsSource="{Binding Choices}">
                    <BindableLayout.ItemTemplate>
                        <DataTemplate x:DataType="m:PlayerChoice">
                            <Button Text="{Binding Label}"
                                    Command="{Binding Source={RelativeSource AncestorType={x:Type vm:ReaderViewModel}}, x:DataType=vm:ReaderViewModel, Path=ChooseCommand}"
                                    CommandParameter="{Binding .}" />
                        </DataTemplate>
                    </BindableLayout.ItemTemplate>
                </VerticalStackLayout>

                <HorizontalStackLayout Spacing="8">
                    <Button Text="Previous" Command="{Binding StepBackCommand}" />
                    <Button Text="Restart" Command="{Binding RestartCommand}" />
                    <Button Text="Fix text" Command="{Binding BeginEditCommand}" />
                </HorizontalStackLayout>
            </VerticalStackLayout>
        </VerticalStackLayout>
    </ScrollView>
</ContentPage>
```

```csharp
using BranchStory.Client.ViewModels;

namespace BranchStory.Mobile.Pages;

public partial class ReaderPage : ContentPage
{
    public ReaderPage(ReaderViewModel vm)
    {
        InitializeComponent();
        BindingContext = vm;
    }
}
```

**5. Allow plain HTTP to your local API, in debug builds only.**

*Android*: in `Platforms/Android/AndroidManifest.xml`, add `android:usesCleartextTraffic="true"`
to the `<application …>` element. Remove it (or move it into a debug-only manifest) before a release.

*iOS / Mac Catalyst*: in `Platforms/iOS/Info.plist` (and `Platforms/MacCatalyst/Info.plist`), allow
local networking:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

**6. Build and run.** Start the Capstone API as in Lab 2, then:

```bash
# Windows (no emulator needed):
dotnet build src/BranchStory.Mobile -f net10.0-windows10.0.19041.0 -t:Run
# Android emulator running (Windows or macOS):
dotnet build src/BranchStory.Mobile -f net10.0-android -t:Run
# macOS:
dotnet build src/BranchStory.Mobile -f net10.0-maccatalyst -t:Run
dotnet build src/BranchStory.Mobile -f net10.0-ios -t:Run      # iOS simulator, needs Xcode
```

The target framework names come from `<TargetFrameworks>` in the generated `.csproj`; if your
template's Windows version differs, copy it from there. The build must report 0 errors and no
XC0022/XC0045 compiled-binding warnings (those mean a binding isn't compiled).

Expected: the sign-in page shows `http://10.0.2.2:5080` on Android and `http://localhost:5080`
elsewhere. After **Sign in**, your stories appear; pull down to refresh; **Open** pushes the reader,
and the system back button or gesture returns to the list. Switch the emulator to airplane mode:
stories you opened before still open with "Offline: reading the copy saved …". **Theme** in the
toolbar switches between light and dark.

- [ ] The MAUI project builds for at least one target with 0 errors and no compiled-binding warnings
- [ ] Sign-in, the story list and the reader work against the Capstone API
- [ ] Back navigation uses the system back button or gesture
- [ ] A story opened online still opens in airplane mode
- [ ] `git diff` shows **no changes** in `src/BranchStory.Client` made for the mobile app
:::

## Phase 9: shipping

Building the app is half the job; getting it onto machines safely is the other half. What each
platform expects:

| Target | Build | What users trust it by |
|---|---|---|
| Windows | `dotnet publish -r win-x64 --self-contained` → an installer (MSIX, Windows' own package format, or an updater framework like **Velopack**) | **Authenticode code signing** (a certificate-based signature on the `.exe`); unsigned apps trigger SmartScreen warnings |
| macOS | `-r osx-arm64` → an `.app` bundle (Info.plist + executable) in a `.dmg` | **Developer ID signing + notarization** (Apple scans the build and issues a ticket); otherwise Gatekeeper blocks it |
| Linux | `-r linux-x64` single file, or AppImage / Flatpak / `.deb` | package repository signatures |
| Android | `dotnet publish -f net10.0-android -c Release` → `.aab` for Google Play | the upload key and Play App Signing |
| iOS | `dotnet publish -f net10.0-ios -c Release` on a Mac → `.ipa` | Apple distribution certificate + provisioning profile, App Store review |

:::pro title="Auto-update is a feature, not an afterthought"
A desktop app without updates stays at whatever version people first installed. Teams pick an
update mechanism on day one: the stores (Microsoft Store, Mac App Store) do it for you, MSIX has
App Installer, and frameworks such as Velopack install, update and roll back on all three desktop
OSes. Combine it with an API that tolerates older clients for a while: never remove a field a
shipped client still reads, and version the API when you must break it.
:::

:::quiz id=dsk-12-q9 xp=10
Which statements about shipping the BranchStory client are true? (Select all that apply.)
- [x] A self-contained build includes the .NET runtime, so users don't need to install .NET
- [x] A macOS build distributed outside the Mac App Store must be signed with a Developer ID and notarized, or Gatekeeper warns users or blocks it
- [ ] The CI job on an Ubuntu runner can produce the iOS `.ipa` if the MAUI workload is installed
- [ ] `PublishTrimmed=true` is always safe, because the trimmer only removes code your app never calls
> Self-contained builds bundle the runtime, which is why the single file is about 95 MB. Apple requires Developer ID signing and notarization for apps distributed outside the App Store (store builds are signed and reviewed through App Store Connect instead). iOS builds need macOS and Xcode, and MAUI doesn't build on Linux at all, so CI needs macOS and Windows runners for the mobile targets. The trimmer removes code that *looks* unused, and code reached only through reflection looks unused, which is exactly why the library uses source-generated JSON and an explicit ViewLocator.
:::

## Boss checklist and stretch goals

You've beaten the boss when the three labs are done and you can **explain** each decision: why
one library, why `ApiResult` instead of exceptions, why the 409 keeps the draft, why ETags, why
PKCE. Ideas for going further (each one is good portfolio and interview material):

- **OIDC for real**: implement `OidcTokenProvider` against the Keycloak realm from *Ship It*, with
  the refresh token in the OS keychain (`SecureStorage` on MAUI).
- **Live updates**: connect to `/hubs/story` with `Microsoft.AspNetCore.SignalR.Client` and reload
  the reader when `DocSaved` arrives for the open story, so a 409 becomes rare instead of a surprise.
- **Shared in-flight requests** in `BranchStoryApi` (rule 8 of the cache challenge).
- **Remember the reading position** per story (the `Path` list) and resume it on the next launch.
- **Accessibility**: move keyboard focus to the scene title after each choice (the web player does
  this), and check the app with a screen reader (Narrator, VoiceOver, TalkBack).
- **Images**: show `PlayerScene.Media` and cache image bytes with the same ETag logic.

:::cards id=dsk-12-cards1 xp=20 title="BranchStory client"
Q: What is a "head" in a multi-platform .NET app?
A: A thin app project for one UI framework (Avalonia desktop, MAUI mobile) holding views, start-up
   and a few interface implementations; ViewModels and logic live in a shared library.
Q: Why must the shared library not reference Avalonia or MAUI?
A: So both heads and plain unit tests can use it. A UI type in a ViewModel is a sign the work
   belongs behind an interface such as IThemeService or INavigator.
Q: What does a DelegatingHandler do in HttpClient?
A: It runs around every request in the pipeline, like middleware: here it adds the bearer token
   and invalidates it on 401.
Q: Which OAuth flow does a native app use, and why?
A: Authorization code with PKCE in the system browser. A native app is a public client and can't
   keep a secret; PKCE makes an intercepted code useless.
Q: Where do access and refresh tokens live in a native app?
A: Access token in memory only; refresh token in the OS secret store (Keychain, Credential Manager,
   Android Keystore via SecureStorage, libsecret). Never in files, logs or URLs.
Q: If-None-Match and 304?
A: The client sends its cached ETag in If-None-Match; if the resource is unchanged the server
   answers 304 Not Modified with no body and the client uses its copy.
Q: What should a client do on 404 for a cached story?
A: Delete the cached copy and explain (deleted, unpublished or unshared), never keep showing it.
Q: What should a client do on 409 with currentVersion?
A: Keep the user's draft, explain that someone saved first, offer to reload the latest version,
   then save again with the new expectedVersion. Never auto-retry over the other edit.
Q: Which exceptions mean "offline" for HttpClient?
A: HttpRequestException, and TaskCanceledException when the caller's token was NOT cancelled
   (that's HttpClient.Timeout). A user cancel is not offline.
Q: Grey and black sets in cycle detection?
A: Grey = on the current DFS path; black = fully explored. Reaching grey again is a cycle;
   reaching black is just two routes joining (a diamond).
Q: How does the Android emulator reach the host's localhost?
A: Through 10.0.2.2, plus a debug-only cleartext exception for plain HTTP.
Q: Why an explicit ViewLocator instead of the template's reflection one?
A: The ViewModels are in another assembly and namespace, a switch is compiler-checked, and it
   survives trimming.
:::

## Recap

- **One library, two heads**: ViewModels, API client, cache and graph logic live in a
  UI-free `net10.0` library; Avalonia and MAUI heads add only views, start-up and small interface
  implementations (`INavigator`, `IThemeService`).
- **Auth behind an interface**: `ITokenProvider` + a `DelegatingHandler`. The dev token now, OIDC
  with PKCE in the system browser later; refresh tokens only in the OS secret store.
- **Results, not exceptions**: `ApiResult` turns HTTP into `Ok / NotFound / Conflict / Unauthorized /
  Forbidden / Offline / Failed` in one place. A 404 drops the cache; a 409 keeps the draft and offers a reload.
- **Offline with ETags**: cache every GET with its ETag, revalidate with `If-None-Match`, use the copy
  on `304`, on network failure and on `5xx`, and write cache files atomically, one folder per user.
- **Graph walking**: keep the path (not just the scene) for Back, hide dangling choices, label loops,
  and find cycles with DFS using "on the path" and "done" sets.
- **Tested without a screen**: a fake `HttpMessageHandler` tests the client, plain xUnit tests the
  ViewModels, Avalonia headless tests click through real windows on a Linux CI runner.
- **Shipping**: self-contained single-file builds per runtime identifier, code signing and
  notarization, an update story, and MAUI builds on Windows or macOS only.
