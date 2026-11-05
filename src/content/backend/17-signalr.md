---
id: be-17
title: Real-time with SignalR
level: advanced
minutes: 60
xp: 150
summary: Hubs, one group per project, presence, authenticating WebSockets with access_token, broadcasting from services via IHubContext, Redis scale-out, and a React client for live co-editing.
---

Open the same project in two browser tabs. In a modern SaaS app, when Bob saves a document,
Alice sees *"Bob updated Spec (v8)"* within milliseconds. Avatars show who's online, and a
"Bob is typing…" hint appears. Without real-time push, Alice keeps editing v7, hits save, and gets
a `409` (be-18). Push doesn't replace concurrency control, but it makes conflicts **rare** and
visible early.

**SignalR** is ASP.NET Core's real-time framework. This lesson builds the live layer of the
Projects API: hubs, per-project groups, presence, auth, server-initiated broadcasts, scale-out and
the React client.

## Why SignalR and not raw WebSockets?

There are several ways to get data to a browser without the user clicking refresh:

| Technique | How | Downsides |
|---|---|---|
| Polling | `GET /changes` every N seconds | Latency = N, wasted requests |
| Long polling | Request hangs until there's news, then repeats | One request per message, header overhead |
| Server-Sent Events | One long HTTP response streaming `text/event-stream` | Server → client only |
| WebSockets | Full-duplex TCP channel after an HTTP upgrade | You build framing, reconnect, auth, fan-out, scale-out yourself |

SignalR can use the last three rows as **transports**. Before connecting, the client sends
`POST /hubs/projects/negotiate`; the server answers with the transports it supports and a
connection token. The client then picks the best one both sides support (WebSockets → SSE →
long polling) and opens the real connection. On top of whichever transport wins, SignalR adds a
typed RPC protocol (JSON or MessagePack), keep-alives, automatic reconnect on the client,
**groups**, user targeting, and a **backplane** for multiple servers. Your code never sees which
transport is in use. Raw WebSockets are worth it only when you need a custom binary protocol or
extreme throughput.

## Hubs: RPC in both directions

A **hub** is a class whose public methods clients can call. Through `Clients`, the hub can call
methods **on** clients. Make it strongly typed with `Hub<TClient>`, so a typo in a client method
name is a compile error instead of a silent no-op.

```csharp
public interface IProjectClient
{
    Task UserJoined(string userId);
    Task UserLeft(string userId);
    Task UserTyping(string userId, Guid documentId);
    Task DocumentSaved(DocumentSaved e);
}

[Authorize]
public class ProjectHub(Membership members, PresenceTracker presence) : Hub<IProjectClient>
{
    public static string Group(Guid projectId) => $"project:{projectId}";

    public async Task<string[]> JoinProject(Guid projectId) { /* … */ }
    public Task Typing(Guid projectId, Guid documentId) { /* … */ }
}

// Program.cs
builder.Services.AddSignalR();
app.MapHub<ProjectHub>("/hubs/projects");
```

What's available inside a hub method:

- `Context.ConnectionId`: unique per **connection**. A user with two tabs has two.
- `Context.UserIdentifier`: the user's id, from `IUserIdProvider`. By default this is the
  `ClaimTypes.NameIdentifier` claim, and you can plug in your own (e.g. the OIDC `sub` claim).
- `Context.User`: the `ClaimsPrincipal`, same as `HttpContext.User`.
- `Clients.Caller`, `Clients.Others`, `Clients.Group(name)`, `Clients.OthersInGroup(name)`,
  `Clients.User(userId)`, `Clients.All`.
- `Groups.AddToGroupAsync(connectionId, name)` / `RemoveFromGroupAsync`.

:::warn title="Hubs are transient"
A **new hub instance is created for every invocation** and disposed right after it. A field like
`private List<string> _online = new()` is empty on the next call. Shared state belongs in an
injected singleton (or Redis). The `Context` is per call too, so don't store it and use it
later from a background task.
:::

### Errors

An exception thrown in a hub method reaches the client as a generic *"An unexpected error
occurred invoking 'JoinProject' on the server."*, because details are hidden so internals don't
leak. To show the client a message on purpose, throw **`HubException`**: its message is always
sent. `EnableDetailedErrors = true` sends every exception message. Use it in development only.

:::quiz id=be-17-q1 xp=10
What does the client see after calling `Join` twice on this hub?

```csharp
public class ChatHub : Hub
{
    private readonly List<string> _joined = new();

    public int Join()
    {
        _joined.Add(Context.ConnectionId);
        return _joined.Count;
    }
}
```

- [ ] `1`, then `2`
- [x] `1`, then `1`. Each invocation gets a fresh hub instance
- [ ] `1`, then an exception, because the list is shared across threads
- [ ] It doesn't compile. Hubs can't have fields
> Hubs are transient: created per invocation and disposed afterwards, so the second call sees a brand-new, empty list. It compiles fine (hubs are ordinary classes), and there's no threading exception because no two calls ever share that list. Keep connection-spanning state in a singleton service (thread-safe!) or an external store like Redis.
:::

## Groups: one per project

A **group** is a named set of connections. You broadcast to the name, and SignalR delivers to
every connection in it. In a project-based SaaS app the natural choice is **one group per
project**, `project:{projectId}`. Everyone viewing that project receives its events, and nobody
else does.

```csharp
public async Task<string[]> JoinProject(Guid projectId)
{
    if (members.RoleOf(projectId, UserId) is null)
        throw new HubException("You are not a member of this project.");

    await Groups.AddToGroupAsync(Context.ConnectionId, Group(projectId));
    var (first, online) = presence.Join(projectId, UserId, Context.ConnectionId);
    if (first) await Clients.OthersInGroup(Group(projectId)).UserJoined(UserId);
    return online;
}
```

Facts about groups that cause real bugs:

- **The join is your security boundary.** Anyone authenticated can *call* `JoinProject` with any
  id. If you don't check membership, a user can subscribe to someone else's project and read
  every live edit. Treat it like a `GET /projects/{id}` authorization check (resource-based
  authorization, be-13).
- **Groups aren't persisted and can't be listed.** There's no API for "who is in group X" and
  no "which groups is connection Y in". Membership vanishes when the connection drops, and a
  reconnect gets a **new connection id**. The client must call `JoinProject` again in its
  `onreconnected` handler.
- SignalR removes a closed connection from all its groups automatically. Any **presence** state
  you built yourself is your job to clean up in `OnDisconnectedAsync`.
- Group names are just strings. Prefix them (`project:`, `doc:`) so ids from different entity types
  can't collide.

:::quiz id=be-17-q2 xp=15
Alice's laptop sleeps for 2 minutes. The JS client's `withAutomaticReconnect()` reconnects
successfully. Bob then saves a document and the server broadcasts to `project:{id}`. Does Alice
get the event?

- [ ] Yes, because SignalR restores group memberships on reconnect
- [x] No. The reconnected connection has a new connection id that isn't in any group. The client must call `JoinProject` again in `onreconnected`, and should refetch state it may have missed
- [ ] Yes, because groups are keyed by user id, not connection id
- [ ] No, because automatic reconnect only works with long polling
> Groups hold connection ids, and a reconnect is a new connection. Messages sent while Alice was offline are lost too: SignalR is fire-and-forget. That's why the client re-joins **and** re-fetches after reconnecting.
:::

## Presence: who's online?

Presence is "which **users** have at least one live connection to this project". The model has
to handle the awkward cases:

- One user, several connections (two tabs, laptop + phone). Show *Bob joined* only for the
  **first** connection and *Bob left* only when the **last** one closes.
- Connections that die without a clean close (Wi-Fi drop). The server notices after
  `ClientTimeoutInterval` (default 30 s) and calls `OnDisconnectedAsync`.
- Server crashes. An in-memory tracker simply forgets everything. With several servers, every
  instance only knows its own connections.

The lab uses a lock-protected in-memory `PresenceTracker`
(`projectId → userId → set of connectionIds`). In production with several instances, move it to
Redis, for example a hash per project holding `userId → lastSeen`, refreshed by a heartbeat and
expired by TTL, so a crashed server's users disappear on their own.

```csharp
public override async Task OnDisconnectedAsync(Exception? exception)
{
    foreach (var projectId in presence.Disconnect(UserId, Context.ConnectionId))
        await Clients.Group(Group(projectId)).UserLeft(UserId);
    await base.OnDisconnectedAsync(exception);
}
```

## Authenticating hubs: the `access_token` query parameter

`[Authorize]` on the hub makes SignalR reject unauthenticated connections during **negotiate**
(`401`). The catch is that the browser's `WebSocket` API and `EventSource` **can't set an
`Authorization` header**. That's why the SignalR JS client sends the bearer token as a
query-string parameter, `?access_token=eyJ…`, for those transports. JWT bearer auth ignores query
strings by default, so you opt in, **only for hub paths**:

```csharp
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = "http://localhost:8080/realms/devquest";   // Keycloak realm (be-13)
        o.Audience = "projects-api";
        o.MapInboundClaims = false;                              // keep "sub" as "sub"
        o.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                var token = ctx.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(token) && ctx.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                    ctx.Token = token;
                return Task.CompletedTask;
            },
        };
    });

builder.Services.AddSingleton<IUserIdProvider, SubUserIdProvider>();   // Context.UserIdentifier = sub
```

Why the custom `IUserIdProvider`? With `MapInboundClaims = false` the token's `sub` claim keeps its
JWT name instead of being renamed to `ClaimTypes.NameIdentifier`. The default provider looks only
for `NameIdentifier`, so `Context.UserIdentifier` would be `null` and `Clients.User(...)` would
reach nobody. `SubUserIdProvider` (in the lab) simply returns the `sub` claim.

Things a security review will ask about:

- **Tokens in URLs end up in logs.** Reverse proxies and access logs record query strings.
  Use short-lived access tokens, and scrub `access_token` from proxy and app request logging.
- **Only accept it on `/hubs`.** Accepting query tokens everywhere turns every link someone
  shares into a credential leak.
- **Connections outlive tokens.** Once connected, the connection stays authenticated even after
  the JWT expires, possibly for days. Set
  `app.MapHub<ProjectHub>("/hubs/projects", o => o.CloseOnAuthenticationExpiration = true)` so
  the server closes the connection when the token expires. The client's
  `accessTokenFactory` then provides a fresh token on reconnect.
- **Authorize per method**, not just per hub. `[Authorize]` only proves *who* the user is. The
  membership check in `JoinProject` and the "did this connection join?" check in `Typing` decide
  *what* they may do.

:::quiz id=be-17-q3 xp=10
Why does the SignalR JavaScript client send the JWT as `?access_token=…` when it uses WebSockets?

- [ ] Query strings are encrypted and headers aren't
- [x] The browser WebSocket API offers no way to set custom headers such as `Authorization` on the upgrade request
- [ ] SignalR doesn't support headers at all
- [ ] It's faster to parse than a header
> Browsers only let you choose the URL and subprotocols for `new WebSocket(...)`. Over TLS the query string is as encrypted as the headers, but it gets **logged** in more places, so keep tokens short-lived and only accept the parameter on hub paths. The .NET client, which isn't in a browser, sends a normal `Authorization` header.
:::

:::quiz id=be-17-q4 xp=15
**Spot the bug.** A user in project A types, and users in **every** project see the typing indicator.

```csharp
public Task Typing(Guid projectId, Guid documentId)
{
    if (!presence.IsIn(projectId, UserId, Context.ConnectionId))
        throw new HubException("Join the project first.");
    return Clients.Others.UserTyping(UserId, documentId);
}
```

- [ ] `HubException` should be `UnauthorizedAccessException`
- [x] `Clients.Others` means every other connection on the server. It must be `Clients.OthersInGroup(ProjectHub.Group(projectId))`
- [ ] `Typing` must return `Task<bool>`
- [ ] Presence checks belong in `OnConnectedAsync`
> `Others` = all connections except the caller, across all projects, which is a cross-tenant data leak. Scope every broadcast to the project's group (or to specific users).
:::

## Broadcasting from outside the hub: `IHubContext`

Most events don't start in the hub. They start in a REST endpoint ("document saved"), a
background job (be-16: "export finished") or a webhook. Inject
`IHubContext<THub, TClient>` anywhere:

```csharp
app.MapPut("/projects/{projectId:guid}/documents/{docId:guid}", async (
    Guid projectId, Guid docId, SaveRequest req, HttpContext http,
    Membership members, DocumentStore store, IHubContext<ProjectHub, IProjectClient> hub) =>
{
    var userId = http.User.FindFirst("sub")!.Value;
    // … membership/role check, then the versioned save from be-18 …
    var (ok, state) = store.TrySave(projectId, docId, req.Content, req.Version);
    if (!ok) return Results.Problem(statusCode: 409, /* … currentVersion … */);

    // Broadcast AFTER the write succeeded.
    await hub.Clients.Group(ProjectHub.Group(projectId))
        .DocumentSaved(new DocumentSaved(docId, state.Version, state.Content, userId));
    return Results.Ok(new { state.Id, state.Version });
}).RequireAuthorization();
```

**Why saves go through REST, not a hub method.** It's tempting to have clients call
`hub.Save(...)`. Production teams usually don't, because the REST endpoint already has
validation, ProblemDetails, rate limiting, idempotency keys, `409`/`412` semantics, OpenAPI
docs, and is trivially testable. Hub messages are also capped (`MaximumReceiveMessageSize`
defaults to **32 KB**) and are fire-and-forget. **Use REST for writes and SignalR for
notifications.** Hub methods fit ephemeral signals like typing, cursors and presence.

:::quiz id=be-17-q5 xp=15
A handler broadcasts `DocumentSaved` **before** calling `SaveChangesAsync()`. The save then fails
with a `409`. What's the consequence?

- [ ] None, because SignalR waits for the HTTP response before delivering
- [x] Other clients apply a version that never existed in the database. Their editors now show content and a version that disagree with the server, and their next save conflicts
- [ ] SignalR rolls the message back automatically
- [ ] The broadcast throws because the transaction is still open
> SignalR knows nothing about your HTTP response or your database transaction: the message leaves the server the moment you `await` the send, and there is no "unsend". Publish side effects only after the commit succeeded. For guaranteed delivery even if the process dies right after the commit, teams use the **transactional outbox**: write the event to an `outbox` table in the same transaction and let a background worker (be-16) publish it.
:::

## Live co-editing with versions

SignalR and the version numbers from be-18 combine into a simple, robust protocol:

```text
Alice (v7, typing)            Server                         Bob (v7, idle)
   │  PUT doc v7 → v8   ───►   UPDATE … WHERE version = 7
   │  ◄── 200, ETag "8"        broadcast DocumentSaved{v8} ─►   applies v8 (not dirty)
   │                                                            Bob edits, PUT with v8 ───►
   │  ◄── DocumentSaved{v9}    ◄───────────────────────────    200, v9
   │  dirty? → "Bob saved v9 — review changes"
```

Client rules:

1. Ignore events whose `version ≤ local.version`. They're echoes of your own save, or arrived out
   of order after a reconnect.
2. If the local editor has **no unsaved changes**, apply the remote version.
3. If it **is dirty**, don't overwrite the user's typing. Keep both and show a merge or reload prompt.
4. After every reconnect, re-join the group and **refetch** the document. Events sent while you
   were disconnected are gone.

:::challenge id=be-17-c1 lang=ts xp=50
title: Apply a remote `DocumentSaved` event
Implement `applyRemote(local, event)` for the editor's state. `local` is
`{ version, content, dirty }` (`dirty` = the user has unsaved changes). `event` is
`{ version, content, savedBy }`. Return `{ action, state }`:

- `event.version <= local.version` → `action: 'ignored'`, `state` = `local` unchanged.
- Not dirty, newer event → `action: 'applied'`, `state` = `{ version: event.version, content: event.content, dirty: false }`.
- Dirty, newer event → `action: 'conflict'`. `state` keeps the user's `version`, `content` and
  `dirty: true`, plus `remote: { version, content, savedBy }` so the UI can offer a merge.

hint: Check the version first. Out-of-order and echo events must never change anything.
hint: Spread the local state for the conflict: `{ ...local, remote: { … } }`.

```ts starter
type Local = { version: number; content: string; dirty: boolean; remote?: { version: number; content: string; savedBy: string } }
type Saved = { version: number; content: string; savedBy: string }

export function applyRemote(local: Local, event: Saved): { action: string; state: Local } {
  return { action: 'applied', state: { version: event.version, content: event.content, dirty: false } }
}
```

```ts solution
type Local = { version: number; content: string; dirty: boolean; remote?: { version: number; content: string; savedBy: string } }
type Saved = { version: number; content: string; savedBy: string }

export function applyRemote(local: Local, event: Saved): { action: string; state: Local } {
  if (event.version <= local.version) return { action: 'ignored', state: local }
  if (!local.dirty) {
    return { action: 'applied', state: { version: event.version, content: event.content, dirty: false } }
  }
  return {
    action: 'conflict',
    state: { ...local, remote: { version: event.version, content: event.content, savedBy: event.savedBy } },
  }
}
```

```ts tests
test('applies a newer version when the editor is clean', () => {
  const r = applyRemote({ version: 7, content: 'a', dirty: false }, { version: 8, content: 'b', savedBy: 'bob' })
  expect(r.action).toBe('applied')
  expect(r.state).toEqual({ version: 8, content: 'b', dirty: false })
})
test('ignores the echo of our own save', () => {
  const local = { version: 8, content: 'mine', dirty: false }
  const r = applyRemote(local, { version: 8, content: 'mine', savedBy: 'alice' })
  expect(r.action).toBe('ignored')
  expect(r.state).toBe(local)
})
test('ignores an out-of-order older event', () => {
  const local = { version: 10, content: 'new', dirty: false }
  expect(applyRemote(local, { version: 9, content: 'old', savedBy: 'bob' }).state).toBe(local)
})
test('never overwrites unsaved typing', () => {
  const r = applyRemote({ version: 7, content: 'typing…', dirty: true }, { version: 8, content: 'bob text', savedBy: 'bob' })
  expect(r.action).toBe('conflict')
  expect(r.state).toEqual({
    version: 7, content: 'typing…', dirty: true,
    remote: { version: 8, content: 'bob text', savedBy: 'bob' },
  })
})
```
:::

## Scale-out: more than one server

Run two instances behind a load balancer and something breaks right away. Alice's connection
lives on **server A**, Bob's `PUT` lands on **server B**, and B's `IHubContext` only knows B's
connections. Alice never hears about it.

A **backplane** fixes this: every server publishes outgoing messages to a shared bus and delivers
the ones meant for its own connections.

```bash
dotnet add package Microsoft.AspNetCore.SignalR.StackExchangeRedis
```

```csharp
builder.Services.AddSignalR()
    .AddStackExchangeRedis(builder.Configuration["Redis"]!, o =>
        o.Configuration.ChannelPrefix = RedisChannel.Literal("projects-api"));  // shared Redis? prefix!
```

What the backplane does and doesn't do:

- It's **Redis pub/sub**: no persistence, no replay. If Redis is down, cross-server messages are
  dropped. Clients stay connected but go stale, which is one more reason to refetch on reconnect.
- **Sticky sessions are still required.** A SignalR connection is several HTTP requests: the
  `negotiate` call, then the WebSocket upgrade, or a stream of SSE/long-polling requests. All of
  them must reach the server that holds that connection's state, and a backplane doesn't change
  that. With nginx ingress, enable cookie affinity. The only exception: if every client uses
  WebSockets **and** skips negotiation (`skipNegotiation: true` plus
  `transport: HttpTransportType.WebSockets`), the whole connection is one long-lived socket on
  one server, so no affinity is needed.
- Every message goes to every server. At very large scale, a managed service (Azure SignalR
  Service) or sharding takes over the fan-out.
- In-memory presence is per instance. Move it to Redis together with the backplane.

:::quiz id=be-17-q6 xp=15
In staging you run 3 replicas of the API. "Bob saved" events reach Alice only about a third of the
time. Locally, with one instance, it always works. What's the most likely cause and fix?

- [ ] WebSockets are blocked. Force long polling
- [x] There's no backplane. Each instance only delivers to its own connections, so add the Redis backplane (`AddStackExchangeRedis`)
- [ ] Group names are case-sensitive on Linux
- [ ] `IHubContext` must be registered as scoped
> "Works with one instance, flaky with N" is the classic scale-out symptom: the delivery rate is roughly 1/N, because the `PUT` lands on a random replica and that replica only knows its own connections. Blocked WebSockets would make the connection fall back to SSE or long polling (slower, but still delivered), group names are plain strings with no OS-dependent behaviour, and `IHubContext` is a singleton by design. A backplane relays messages between instances; keep sticky sessions for the negotiate/connect requests too.
:::

:::pro title="Reliability upgrades seniors reach for"
- **Stateful reconnect** (.NET 8+): `withStatefulReconnect()` on the client plus
  `o.AllowStatefulReconnects = true` in `MapHub` buffers messages across short network blips,
  so the client keeps the same connection.
- **MessagePack protocol** (`AddMessagePackProtocol()`) for smaller payloads in chatty
  hubs such as cursors.
- **Hub filters** (`IHubFilter`) for cross-cutting logging, metrics and per-invocation
  authorization, the middleware of hubs.
- A **transactional outbox** when "the event must be delivered if the save committed". The
  Cloud-Native Toolkit lesson **Message Brokers & the Outbox Pattern** builds one, relay included.
:::

## The React client

```bash
npm install @microsoft/signalr
```

```tsx
import * as signalR from '@microsoft/signalr'
import { useEffect, useRef, useState } from 'react'

type DocumentSaved = { documentId: string; version: number; content: string; savedBy: string }

export function useProjectHub(
  projectId: string,
  getToken: () => Promise<string>,
  onSaved: (e: DocumentSaved) => void,
) {
  const [online, setOnline] = useState<string[]>([])

  // Keep the latest callbacks in refs so the long-lived connection never calls a stale closure.
  const onSavedRef = useRef(onSaved)
  const getTokenRef = useRef(getToken)
  useEffect(() => {
    onSavedRef.current = onSaved
    getTokenRef.current = getToken
  })

  useEffect(() => {
    const conn = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/projects', { accessTokenFactory: () => getTokenRef.current() })   // → ?access_token=… for WebSockets
      .withAutomaticReconnect()                                       // 0s, 2s, 10s, 30s, then gives up
      .configureLogging(signalR.LogLevel.Warning)
      .build()

    conn.on('UserJoined', (u: string) => setOnline((xs) => (xs.includes(u) ? xs : [...xs, u].sort())))
    conn.on('UserLeft', (u: string) => setOnline((xs) => xs.filter((x) => x !== u)))
    conn.on('DocumentSaved', (e: DocumentSaved) => onSavedRef.current(e))

    // A reconnect is a NEW connection: re-join the group and refetch whatever we may have missed.
    conn.onreconnected(async () => {
      try {
        setOnline(await conn.invoke<string[]>('JoinProject', projectId))
        // queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      } catch (err) {
        console.warn('Re-join failed', err)   // e.g. membership revoked while offline
      }
    })

    let cancelled = false
    conn.start()
      .then(() => conn.invoke<string[]>('JoinProject', projectId))
      .then((users) => { if (!cancelled) setOnline(users) })
      .catch((err) => console.warn('SignalR start failed', err))

    return () => {
      cancelled = true
      void conn.stop()   // leaving the page closes the connection, so the server sends UserLeft
    }
  }, [projectId])   // handlers are read through refs, so only projectId restarts the connection

  return online
}
```

Notes from real projects:

- **Why only `[projectId]` in the deps?** Listing `getToken` and `onSaved` would tear down and
  rebuild the connection on every render if the parent passes inline functions. Leaving them out
  but calling them directly would be worse: the connection would keep the *first* closures
  forever, even a `useCallback` version once its own deps change. That stale `onSaved` is a
  classic "the editor shows old state" bug. So the hook stores the latest callbacks in refs
  (updated after every render) and the connection calls through the refs. In React 19.2+,
  `useEffectEvent` does the same job with less code: `const handleSaved = useEffectEvent(onSaved)`
  and register `(e) => handleSaved(e)`.
- In development, **React StrictMode** mounts effects twice. You'll see one "connection stopped
  during negotiation" warning. That's harmless, and the cleanup above handles it.
- Through the **Vite dev server**, proxy WebSockets explicitly:
  `server: { proxy: { '/hubs': { target: 'http://localhost:5080', ws: true } } }`.
- Payload property names arrive **camelCase** (`documentId`), because the JSON protocol uses web
  defaults.
- `accessTokenFactory` runs on every (re)connect. Return a **fresh** token from your OIDC
  library (e.g. `oidc-client-ts`) there, not a value cached at mount time.

:::job title="What you'll meet on day one"
Expect a single `/hubs/...` endpoint per bounded area, a strongly typed client interface shared
by convention with the frontend, broadcasts triggered from application services via
`IHubContext`, and a Redis backplane in every non-local environment. The usual first tickets:
"users see updates from other projects" (unscoped broadcast), "live updates stop after the laptop
sleeps" (no re-join on reconnect), and "works locally, not in Kubernetes" (no backplane or
sticky sessions).
:::

:::quiz id=be-17-q7 xp=10
A user's access token expires after 5 minutes. The SignalR connection was opened at minute 0. By
default, what happens at minute 6?

- [ ] The server closes the connection immediately
- [x] Nothing. The connection stays open and authenticated until it drops, unless you enable `CloseOnAuthenticationExpiration`
- [ ] Every hub call starts returning 401
- [ ] The client refreshes the token automatically mid-connection
> Authentication happens once, when the connection is established. Hub invocations travel over the already-open connection and are not re-authenticated, so there's no per-call `401`, and the client can't swap the token inside a live connection. With `CloseOnAuthenticationExpiration = true` the server closes the connection at expiry, and the client reconnects using `accessTokenFactory`, which yields a fresh token. That matters when you revoke access to a project.
:::

:::lab id=be-17-lab1 xp=140
title: A project hub with presence, auth and REST-triggered broadcasts
You'll build `ProjectHub` with one group per project, a presence tracker, JWT auth that also accepts
`?access_token=`, and a REST save endpoint that pushes `DocumentSaved` through `IHubContext`. The
integration tests connect **real SignalR clients** to an in-memory `TestServer`.

**1. Create the solution**

```bash
mkdir -p ~/devquest/be-17-lab1 && cd ~/devquest/be-17-lab1
dotnet new sln -n Live
dotnet new web -o Live.Api
dotnet new xunit -o Live.Tests
dotnet sln add Live.Api Live.Tests
dotnet add Live.Api package Microsoft.AspNetCore.Authentication.JwtBearer
dotnet add Live.Api package Microsoft.AspNetCore.SignalR.StackExchangeRedis
dotnet add Live.Tests reference Live.Api
dotnet add Live.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet add Live.Tests package Microsoft.AspNetCore.SignalR.Client
rm Live.Tests/UnitTest1.cs
```

**2. Settings.** Replace `Live.Api/appsettings.json`. The key is for local development only. Real
apps validate Keycloak's tokens via `Authority`, as in be-13.

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  },
  "AllowedHosts": "*",
  "Jwt": {
    "Key": "devquest-lab-signing-key-change-me-0123456789"
  },
  "Redis": ""
}
```

**3. Membership and a versioned document store.** Create `Live.Api/Domain.cs`. These stand in for
the `ProjectMember` and `Document` tables, so the lab needs no database.

```csharp
using System.Collections.Concurrent;

namespace Live.Api;

public enum ProjectRole { Viewer, Editor, Owner }

// Stand-in for the ProjectMember table: who may see / edit which project.
public class Membership
{
    public static readonly Guid DemoProject = Guid.Parse("11111111-1111-1111-1111-111111111111");

    private readonly Dictionary<(Guid, string), ProjectRole> _members = new()
    {
        [(DemoProject, "alice")] = ProjectRole.Owner,
        [(DemoProject, "bob")] = ProjectRole.Editor,
        [(DemoProject, "carol")] = ProjectRole.Viewer,
    };

    public ProjectRole? RoleOf(Guid projectId, string userId) =>
        _members.TryGetValue((projectId, userId), out var r) ? r : null;
}

public record DocumentState(Guid Id, Guid ProjectId, string Content, int Version);

// Stand-in for the Documents table, with the same "version must match" rule as be-18.
public class DocumentStore
{
    private readonly ConcurrentDictionary<Guid, DocumentState> _docs = new();

    public DocumentState GetOrCreate(Guid projectId, Guid docId) =>
        _docs.GetOrAdd(docId, id => new DocumentState(id, projectId, "", 1));

    /// Returns (true, newState) or (false, currentState) when expectedVersion is stale.
    public (bool Ok, DocumentState State) TrySave(Guid projectId, Guid docId, string content, int expectedVersion)
    {
        while (true)
        {
            var current = GetOrCreate(projectId, docId);
            if (current.Version != expectedVersion) return (false, current);
            var next = current with { Content = content, Version = current.Version + 1 };
            if (_docs.TryUpdate(docId, next, current)) return (true, next); // compare-and-swap
        }
    }
}
```

**4. Presence.** Create `Live.Api/Presence.cs`:

```csharp
namespace Live.Api;

// Who is online in which project. One user can have several connections (two tabs, phone + laptop).
// NOTE: in-memory = per server instance. With several instances you'd keep this in Redis.
public class PresenceTracker
{
    private readonly Lock _gate = new();
    // projectId -> userId -> connectionIds
    private readonly Dictionary<Guid, Dictionary<string, HashSet<string>>> _online = new();

    /// Returns true if this is the user's FIRST connection in the project, plus who is online now.
    public (bool FirstConnection, string[] Online) Join(Guid projectId, string userId, string connectionId)
    {
        lock (_gate)
        {
            if (!_online.TryGetValue(projectId, out var users)) _online[projectId] = users = new();
            if (!users.TryGetValue(userId, out var conns)) users[userId] = conns = new();
            var first = conns.Count == 0;
            conns.Add(connectionId);
            return (first, users.Keys.Order().ToArray());
        }
    }

    /// Removes the connection from one project. Returns true if the user has no connection left there.
    public bool Leave(Guid projectId, string userId, string connectionId)
    {
        lock (_gate)
        {
            if (!_online.TryGetValue(projectId, out var users) || !users.TryGetValue(userId, out var conns)) return false;
            conns.Remove(connectionId);
            if (conns.Count > 0) return false;
            users.Remove(userId);
            return true;
        }
    }

    /// Removes a dropped connection everywhere; yields the projects where the user went fully offline.
    public List<Guid> Disconnect(string userId, string connectionId)
    {
        lock (_gate)
        {
            var wentOffline = new List<Guid>();
            foreach (var (projectId, users) in _online)
                if (users.TryGetValue(userId, out var conns) && conns.Remove(connectionId) && conns.Count == 0)
                {
                    users.Remove(userId);
                    wentOffline.Add(projectId);
                }
            return wentOffline;
        }
    }

    public bool IsIn(Guid projectId, string userId, string connectionId)
    {
        lock (_gate)
            return _online.TryGetValue(projectId, out var users)
                && users.TryGetValue(userId, out var conns) && conns.Contains(connectionId);
    }
}
```

**5. The hub.** Create `Live.Api/ProjectHub.cs`:

```csharp
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace Live.Api;

public record DocumentSaved(Guid DocumentId, int Version, string Content, string SavedBy);

// Strongly-typed client: the server can only call methods declared here (no magic strings).
public interface IProjectClient
{
    Task UserJoined(string userId);
    Task UserLeft(string userId);
    Task UserTyping(string userId, Guid documentId);
    Task DocumentSaved(DocumentSaved e);
}

[Authorize]
public class ProjectHub(Membership members, PresenceTracker presence) : Hub<IProjectClient>
{
    public static string Group(Guid projectId) => $"project:{projectId}";

    private string UserId => Context.UserIdentifier!;   // from SubUserIdProvider ("sub" claim)

    public async Task<string[]> JoinProject(Guid projectId)
    {
        if (members.RoleOf(projectId, UserId) is null)
            throw new HubException("You are not a member of this project.");   // message reaches the client

        await Groups.AddToGroupAsync(Context.ConnectionId, Group(projectId));
        var (first, online) = presence.Join(projectId, UserId, Context.ConnectionId);
        if (first) await Clients.OthersInGroup(Group(projectId)).UserJoined(UserId);
        return online;
    }

    public async Task LeaveProject(Guid projectId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(projectId));
        if (presence.Leave(projectId, UserId, Context.ConnectionId))
            await Clients.Group(Group(projectId)).UserLeft(UserId);
    }

    public Task Typing(Guid projectId, Guid documentId)
    {
        // Never trust the client: only connections that actually joined may broadcast to the group.
        if (!presence.IsIn(projectId, UserId, Context.ConnectionId))
            throw new HubException("Join the project first.");
        return Clients.OthersInGroup(Group(projectId)).UserTyping(UserId, documentId);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        // SignalR removes the connection from its groups automatically; presence is OUR job.
        foreach (var projectId in presence.Disconnect(UserId, Context.ConnectionId))
            await Clients.Group(Group(projectId)).UserLeft(UserId);
        await base.OnDisconnectedAsync(exception);
    }
}

public class SubUserIdProvider : IUserIdProvider
{
    public string? GetUserId(HubConnectionContext connection) => connection.User.FindFirst("sub")?.Value;
}
```

**6. Wire it up.** Replace `Live.Api/Program.cs`:

```csharp
using System.Text;
using Live.Api;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.SignalR;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

var builder = WebApplication.CreateBuilder(args);

var signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!));

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.MapInboundClaims = false;   // keep "sub" as "sub"
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = "devquest", ValidAudience = "projects-api", IssuerSigningKey = signingKey,
        };
        // Browsers can't set headers on WebSocket / EventSource requests, so the SignalR JS client
        // sends the token as ?access_token=... — accept it ONLY for hub paths.
        o.Events = new JwtBearerEvents
        {
            OnMessageReceived = ctx =>
            {
                var token = ctx.Request.Query["access_token"];
                if (!string.IsNullOrEmpty(token) && ctx.HttpContext.Request.Path.StartsWithSegments("/hubs"))
                    ctx.Token = token;
                return Task.CompletedTask;
            },
        };
    });
builder.Services.AddAuthorization();

var signalr = builder.Services.AddSignalR();
if (builder.Configuration["Redis"] is { Length: > 0 } redis)
    signalr.AddStackExchangeRedis(redis, o => o.Configuration.ChannelPrefix = StackExchange.Redis.RedisChannel.Literal("devquest"));

builder.Services.AddSingleton<IUserIdProvider, SubUserIdProvider>();
builder.Services.AddSingleton<Membership>();
builder.Services.AddSingleton<PresenceTracker>();
builder.Services.AddSingleton<DocumentStore>();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapHub<ProjectHub>("/hubs/projects");

// DEV ONLY: hands out tokens so the lab needs no identity provider. Keycloak does this in real life.
// It reads the real clock directly: the expiry must match the clock the JWT validator uses, and this
// endpoint isn't logic you'd unit-test. Anything with a time-based rule gets an injected TimeProvider.
app.MapPost("/dev/token", (string user) => new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
{
    Issuer = "devquest", Audience = "projects-api",
    Claims = new Dictionary<string, object> { ["sub"] = user },
    Expires = DateTime.UtcNow.AddHours(1),
    SigningCredentials = new SigningCredentials(signingKey, SecurityAlgorithms.HmacSha256),
}));

// A normal REST save. After the write succeeds we push the change to everyone in the project.
app.MapPut("/projects/{projectId:guid}/documents/{docId:guid}", async (
    Guid projectId, Guid docId, SaveRequest req, HttpContext http,
    Membership members, DocumentStore store, IHubContext<ProjectHub, IProjectClient> hub) =>
{
    var userId = http.User.FindFirst("sub")!.Value;
    var role = members.RoleOf(projectId, userId);
    if (role is null) return Results.NotFound();            // don't reveal the project exists
    if (role < ProjectRole.Editor) return Results.Forbid();

    var (ok, state) = store.TrySave(projectId, docId, req.Content, req.Version);
    if (!ok)
        return Results.Problem(statusCode: 409, title: "Stale version",
            extensions: new Dictionary<string, object?> { ["currentVersion"] = state.Version });

    // Broadcast AFTER the save committed, so nobody hears about a change that didn't happen.
    await hub.Clients.Group(ProjectHub.Group(projectId))
        .DocumentSaved(new DocumentSaved(docId, state.Version, state.Content, userId));
    return Results.Ok(new { state.Id, state.Version });
}).RequireAuthorization();

app.Run();

public record SaveRequest(string Content, int Version);

public partial class Program;
```

**7. Tests.** Create `Live.Tests/HubTests.cs`. Each `HubConnection` talks to the `TestServer`
through `factory.Server.CreateHandler()` using long polling, which needs no real socket.

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Threading.Channels;
using Live.Api;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace Live.Tests;

public class HubTests(WebApplicationFactory<Program> factory) : IClassFixture<WebApplicationFactory<Program>>
{
    private static readonly Guid Project = Membership.DemoProject;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    private async Task<string> TokenFor(string user)
    {
        var res = await factory.CreateClient().PostAsync($"/dev/token?user={user}", null);
        res.EnsureSuccessStatusCode();
        return await res.Content.ReadAsStringAsync();   // plain-text token
    }

    // Connects through the in-memory TestServer. LongPolling works over a plain HttpMessageHandler.
    private async Task<HubConnection> ConnectAsync(string user, bool tokenInQuery = false)
    {
        var token = await TokenFor(user);
        var url = tokenInQuery
            ? $"http://localhost/hubs/projects?access_token={token}"   // what browsers do
            : "http://localhost/hubs/projects";
        var conn = new HubConnectionBuilder()
            .WithUrl(url, o =>
            {
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
                if (!tokenInQuery) o.AccessTokenProvider = () => Task.FromResult<string?>(token);
            })
            .Build();
        await conn.StartAsync();
        return conn;
    }

    private static Channel<T> Listen<T>(HubConnection conn, string method)
    {
        var ch = Channel.CreateUnbounded<T>();
        conn.On<T>(method, x => ch.Writer.TryWrite(x));
        return ch;
    }

    [Fact]
    public async Task Anonymous_connections_are_rejected()
    {
        var conn = new HubConnectionBuilder()
            .WithUrl("http://localhost/hubs/projects", o =>
            {
                o.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                o.Transports = HttpTransportType.LongPolling;
            })
            .Build();

        var ex = await Assert.ThrowsAsync<HttpRequestException>(() => conn.StartAsync());
        Assert.Equal(HttpStatusCode.Unauthorized, ex.StatusCode);
    }

    [Fact]
    public async Task Token_in_access_token_query_parameter_is_accepted()
    {
        await using var conn = await ConnectAsync("alice", tokenInQuery: true);

        var online = await conn.InvokeAsync<string[]>("JoinProject", Project);

        Assert.Contains("alice", online);
    }

    [Fact]
    public async Task Non_members_cannot_join_a_project_group()
    {
        await using var dave = await ConnectAsync("dave");

        var ex = await Assert.ThrowsAsync<HubException>(() => dave.InvokeAsync<string[]>("JoinProject", Project));
        Assert.Contains("not a member", ex.Message);
    }

    [Fact]
    public async Task Presence_join_and_leave_are_broadcast_to_the_group()
    {
        await using var alice = await ConnectAsync("alice");
        var joined = Listen<string>(alice, nameof(IProjectClient.UserJoined));
        var left = Listen<string>(alice, nameof(IProjectClient.UserLeft));
        await alice.InvokeAsync<string[]>("JoinProject", Project);

        var bob = await ConnectAsync("bob");
        var online = await bob.InvokeAsync<string[]>("JoinProject", Project);

        Assert.Equal(new[] { "alice", "bob" }, online);
        Assert.Equal("bob", await joined.Reader.ReadAsync().AsTask().WaitAsync(Timeout));

        await bob.DisposeAsync();   // tab closed → OnDisconnectedAsync on the server
        Assert.Equal("bob", await left.Reader.ReadAsync().AsTask().WaitAsync(Timeout));
    }

    [Fact]
    public async Task Saving_over_REST_pushes_DocumentSaved_to_other_members()
    {
        var docId = Guid.NewGuid();
        await using var alice = await ConnectAsync("alice");
        var saved = Listen<DocumentSaved>(alice, nameof(IProjectClient.DocumentSaved));
        await alice.InvokeAsync<string[]>("JoinProject", Project);

        var http = factory.CreateClient();
        http.DefaultRequestHeaders.Authorization = new("Bearer", await TokenFor("bob"));
        var res = await http.PutAsJsonAsync($"/projects/{Project}/documents/{docId}", new { content = "Hello from Bob", version = 1 });

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var e = await saved.Reader.ReadAsync().AsTask().WaitAsync(Timeout);
        Assert.Equal((docId, 2, "Hello from Bob", "bob"), (e.DocumentId, e.Version, e.Content, e.SavedBy));
    }

    [Fact]
    public async Task Stale_save_returns_409_and_viewers_get_403()
    {
        var docId = Guid.NewGuid();
        var bob = factory.CreateClient();
        bob.DefaultRequestHeaders.Authorization = new("Bearer", await TokenFor("bob"));
        var carol = factory.CreateClient();
        carol.DefaultRequestHeaders.Authorization = new("Bearer", await TokenFor("carol"));
        var url = $"/projects/{Project}/documents/{docId}";

        await bob.PutAsJsonAsync(url, new { content = "v2", version = 1 });
        var stale = await bob.PutAsJsonAsync(url, new { content = "again", version = 1 });
        var viewer = await carol.PutAsJsonAsync(url, new { content = "nope", version = 2 });

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, viewer.StatusCode);
    }

    [Fact]
    public async Task Typing_requires_having_joined_the_project()
    {
        await using var bob = await ConnectAsync("bob");

        await Assert.ThrowsAsync<HubException>(() => bob.InvokeAsync("Typing", Project, Guid.NewGuid()));
    }
}
```

**8. Run**

```bash
dotnet test
```

```text
Passed!  - Failed:     0, Passed:     7, Skipped:     0, Total:     7, Duration: 400 ms - Live.Tests.dll (net10.0)
```

**9. (Optional) Watch the backplane work.** Start Redis and two instances:

```bash
docker run --rm -d --name live-redis -p 6379:6379 redis:8-alpine
dotnet run --project Live.Api -- --urls http://localhost:5081 --Redis=localhost:6379
dotnet run --project Live.Api -- --urls http://localhost:5082 --Redis=localhost:6379   # 2nd terminal
```

Connect a client to `:5081` and `PUT` a document on `:5082`, using a copy of the tests' `ConnectAsync`
pointed at the real URLs (drop `HttpMessageHandlerFactory`, keep the token from
`POST http://localhost:5081/dev/token?user=alice`), or the React hook above. Both instances sign
tokens with the same key from `appsettings.json`, so a token from one is valid on the other. The
event crosses instances. Stop Redis (`docker stop live-redis`) and it stops crossing, while
same-instance delivery keeps working. Note that each instance has its **own** in-memory
`DocumentStore` and `PresenceTracker`, which is exactly the per-instance-state problem described
above.

- [ ] All 7 tests pass with `dotnet test`
- [ ] Anonymous connections get `401`, and a token in `?access_token=` is accepted on `/hubs`
- [ ] A non-member gets a `HubException` from `JoinProject`, and `Typing` without joining fails
- [ ] Presence broadcasts `UserJoined`/`UserLeft` once per user, not once per connection
- [ ] A REST save by Bob pushes `DocumentSaved` with the new version to Alice, viewers get `403`, and stale saves get `409`
- [ ] I can explain why a reconnecting client must call `JoinProject` again and refetch
:::

## Flashcards

:::cards id=be-17-cards1 xp=20 title="SignalR"
Q: What does SignalR add on top of WebSockets?
A: Transport negotiation and fallback (WebSockets → SSE → long polling), typed RPC, keep-alives, client reconnect, groups, user targeting and a scale-out backplane.
Q: What is a hub's lifetime?
A: Transient: a new instance per invocation. Keep shared state in singletons or Redis.
Q: Why `Hub<IProjectClient>`?
A: Strongly typed client calls. A typo in a client method name becomes a compile error.
Q: What group strategy fits a project-based SaaS?
A: One group per project, e.g. `project:{id}`. Join only after a membership check.
Q: Do group memberships survive a reconnect?
A: No. A reconnect is a new connection id, so re-join in `onreconnected` and refetch missed state.
Q: How do browsers authenticate SignalR WebSockets?
A: With `?access_token=…`, read in `JwtBearerEvents.OnMessageReceived`, and only for `/hubs` paths.
Q: Which exception's message reaches the client?
A: `HubException`. Other exceptions become a generic error unless EnableDetailedErrors is on (dev only).
Q: How do you push from a controller or background job?
A: Inject `IHubContext<THub, TClient>` and call `Clients.Group(...)`. Do it after the write committed.
Q: Why save via REST instead of a hub method?
A: Validation, ProblemDetails, 409/412, idempotency, rate limiting, testability. Hub messages are also capped at 32 KB by default and fire-and-forget.
Q: Symptom of a missing backplane?
A: Works with one instance. With N instances, messages arrive about 1/N of the time.
Q: What does the Redis backplane not give you?
A: Persistence or replay. It's pub/sub, so messages are lost if Redis or the client is down.
Q: How do you close connections when the token expires?
A: `MapHub<T>(path, o => o.CloseOnAuthenticationExpiration = true)`. The client reconnects with a fresh token.
:::

## Recap

- SignalR negotiates WebSockets, SSE or long polling and gives you typed RPC, groups and reconnect.
  Hubs are transient, so keep shared state elsewhere.
- Use one group per project (`project:{id}`), and treat the join as an authorization check. Groups
  are per connection and vanish on reconnect, so re-join and refetch.
- Presence tracks users, not connections. Announce on first connect and last disconnect, and use
  Redis with TTLs once you have several instances.
- Browsers send the JWT as `access_token` in the query string. Accept it only on `/hubs`, keep
  tokens short-lived, and consider `CloseOnAuthenticationExpiration`.
- Write through REST (versioned saves from be-18), then broadcast via `IHubContext` **after**
  commit. SignalR is for notifications and ephemeral signals.
- Scale-out needs a backplane (Redis) **and** sticky sessions, unless every client uses
  WebSockets with `skipNegotiation`.
- The React client: `HubConnectionBuilder` + `accessTokenFactory` + `withAutomaticReconnect`,
  re-join in `onreconnected`, and stop the connection in the effect cleanup.
