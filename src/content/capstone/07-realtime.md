---
id: cap-07
title: "Real-time Collaboration with SignalR"
level: expert
minutes: 300
xp: 250
summary: Presence avatars and live edits — a typed, authorized SignalR hub with project groups, a reconnecting React hook, and remote patches that never clobber what you are typing.
---

Optimistic concurrency (cap-04) makes collaboration **safe**: nobody silently overwrites anyone.
It doesn't make it **pleasant** — two people in the same story still meet in a conflict dialog.
This lesson adds the live layer that real editors have:

- **Presence** — who else is in this story right now (avatars in the toolbar).
- **Live patches** — your edits show up in the other browsers within ~100 ms.
- **Save notifications** — when someone saves, everyone else learns the new version.

The architecture keeps the roles strictly separate:

```text
 Browser A                          API (ASP.NET Core)                         Browser B
 ─────────                          ──────────────────                         ─────────
 local edit ─► diffDocs ─► SendPatch ──► StoryHub ── role ≥ editor? ──► PatchReceived ─► applyRemote
                                         (relay only, never stores)                     (skips my unsent edits)
 autosave ─► PUT /doc {expectedVersion} ─► ProjectEndpoints ──► UPDATE … WHERE version = @v
                                              │ IProjectEvents.DocSavedAsync
                                              ▼
                                         SignalRProjectEvents ─────────────► DocSaved(v) ─► catch up if clean
```

The hub is a **relay**: it checks membership and role, then forwards. The **database document with
its version stays the single source of truth**. If a patch is lost (tab asleep, network blip),
nothing is corrupted — the next save or catch-up converges everyone.

:::pro title="Why not OT or CRDTs?"
Google Docs uses Operational Transformation; Figma and many newer tools use CRDT-like structures
(Yjs, Automerge). They give character-level merging of concurrent text edits. A story *graph*
mostly has entity-level edits (move this scene, rename that choice), where **last-writer-wins per
entity + a versioned save** is far simpler and good enough. Reach for Yjs when you need two people
typing in the same paragraph at the same time.
:::

## SignalR in five minutes

**Why you need it.** HTTP is request/response: the server can only *answer*. "Grace just moved a
scene" has to reach Ada's browser without Ada asking. Polling every second is laggy and wastes
requests. A **WebSocket** keeps one TCP connection open in both directions, so the server can push.
SignalR is ASP.NET Core's library on top of that. It negotiates the best transport, reconnects,
serializes arguments, and gives you **remote procedure calls in both directions**: the browser calls
a hub method by name, and the server calls a browser handler by name.

| Term | Meaning in this lesson |
|---|---|
| **Hub** | A server class whose public methods clients can invoke (`StoryHub.SendPatch`). |
| **Connection / connection id** | One per browser tab. A reconnect gets a **new** id. |
| **Transport** | WebSockets if possible, else Server-Sent Events, else long polling. The client finds out with a first `POST /hubs/story/negotiate`. |
| **Group** | A named set of connection ids (`project:3f2a…`). It exists only on the server and lives in memory. A connection leaves every group when it disconnects. |
| **Targets** | `Clients.Caller`, `Clients.Others`, `Clients.Group(name)`, `Clients.OthersInGroup(name)`, `Clients.Client(connectionId)`. |
| **`IHubContext<THub>`** | Lets code *outside* the hub (an endpoint, a background service) send to clients. |

A minimal round trip looks like this:

```csharp
public sealed class ChatHub : Hub
{
    public async Task JoinRoom(string room) => await Groups.AddToGroupAsync(Context.ConnectionId, room);

    public Task Send(string room, string text) =>
        Clients.OthersInGroup(room).SendAsync("Message", room, text);   // server → client by name
}
```

```ts
connection.on('Message', (room: string, text: string) => console.log(room, text))
await connection.start()
await connection.invoke('JoinRoom', 'room-1')   // client → server by name
await connection.invoke('Send', 'room-1', 'hi')
```

Four facts trip up almost everyone, and the code in this lesson is built around them:

1. **A hub instance lives for one method call.** Hubs are transient: SignalR creates a new
   `StoryHub` for every invocation and disposes it afterwards. A field you set in `JoinProject` is
   gone by the next `SendPatch`. Per-connection state goes in `Context.Items`, and shared state goes
   in a singleton (our `PresenceTracker`).
2. **Groups do not survive a reconnect.** The new connection id is in no group, so the client has to
   join again.
3. **Delivery is best effort.** A message sent while a client is disconnected is simply lost. There
   is no replay. (.NET 8+ has an opt-in *stateful reconnect* that buffers messages during a short
   blip, but nothing survives a server restart.) That is why the database stays the source of truth.
4. **The connection outlives its authorization.** The token is checked once, when the connection
   opens. A socket can stay open for hours, so permissions have to be re-checked while it is open.

## The hub contract

| Direction | Method | Payload |
|---|---|---|
| client → server | `JoinProject(projectId)` | returns `PresenceUser[]`; throws if not a member |
| client → server | `LeaveProject(projectId)` | — |
| client → server | `SendPatch(projectId, patch)` | `{ clientId, baseVersion, ops[] }`; editors and owners only |
| server → client | `PresenceChanged(projectId, users)` | `PresenceUser[]` (`{ userId, displayName, color }`) |
| server → client | `PatchReceived(projectId, fromUserId, patch)` | the patch, to **everyone else** in the group |
| server → client | `DocSaved(projectId, version, byUserId)` | after every successful `PUT /doc` |
| server → client | `AccessRevoked(projectId)` | you were removed from the project |

The URL is `/hubs/story`; the Vite proxy from cap-05 already forwards it with `ws: true`.

:::lab id=cap-07-lab1 xp=200
title: The StoryHub — groups, presence, authorization

This lab builds on these pieces from cap-02 … cap-04:

| Seam | From | Used here |
|---|---|---|
| `IProjectEvents` / `NullProjectEvents` in `api/BranchStory.Api/Realtime/` | cap-04 | replaced by a SignalR implementation |
| `events.DocSavedAsync(id, newVersion, access.UserId, ct)` in `SaveDoc` | cap-04 | becomes the `DocSaved` broadcast |
| `events.MembershipChangedAsync(id, userId, ct)` in sharing | cap-04 | kicks removed members off the hub |
| `ProjectRole` (`Viewer = 1, Editor = 2, Owner = 3`), `MemberRoles` | cap-02/03 | role checks in the hub |
| `users.subject` ← the token's `sub`, created by `CurrentUser` | cap-03 | who is connected |
| `AddBranchStoryAuth()` with `MapInboundClaims = false` | cap-03 | plus a query-string token for `/hubs` |

One thing we can **not** reuse is `ProjectGate`: it resolves the caller through
`IHttpContextAccessor`, and hub method calls have no per-call `HttpContext` (the connection lives
far longer than the request that opened it). The hub gets a small lookup keyed by an explicit user id.

All new files go next to `IProjectEvents.cs` in `api/BranchStory.Api/Realtime/`. SignalR ships
with ASP.NET Core — no server package to install.

**1. Contracts** — `api/BranchStory.Api/Realtime/RealtimeContracts.cs`

A **strongly typed hub** (`Hub<IStoryClient>`) turns a typo in a client method name into a
compile error instead of a silently ignored message.

```csharp
using System.Text.Json;

namespace BranchStory.Api.Realtime;

public sealed record PresenceUser(string UserId, string DisplayName, string Color);

/// <summary>A batch of graph operations. The server relays it; it never interprets Ops.</summary>
public sealed record StoryPatchDto(string ClientId, int BaseVersion, JsonElement Ops);

/// <summary>Everything the server can call on a connected browser (cap-08 adds JobUpdated).</summary>
public interface IStoryClient
{
    Task PresenceChanged(Guid projectId, IReadOnlyList<PresenceUser> users);
    Task PatchReceived(Guid projectId, string fromUserId, StoryPatchDto patch);
    Task DocSaved(Guid projectId, int version, string byUserId);
    Task AccessRevoked(Guid projectId);
}
```

**2. Who may do what** — `api/BranchStory.Api/Realtime/HubAccess.cs`

The same role rule as `ProjectGate.FindAccessAsync` (owner, else member role), but keyed by an
explicit user id:

```csharp
using BranchStory.Api.Authorization;
using BranchStory.Data;
using Microsoft.EntityFrameworkCore;

namespace BranchStory.Api.Realtime;

/// <summary>Role lookups for hub calls. Scoped (uses the DbContext).</summary>
public sealed class HubAccess(BranchStoryDbContext db)
{
    /// <summary>The users row for a token subject; null if the user never called the API.</summary>
    public Task<User?> FindUserAsync(string subject, CancellationToken ct) =>
        db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Subject == subject, ct);

    public async Task<ProjectRole?> GetRoleAsync(Guid projectId, Guid userId, CancellationToken ct)
    {
        var row = await db.Projects
            .Where(p => p.Id == projectId)
            .Select(p => new
            {
                p.OwnerId,
                MemberRole = p.Members.Where(m => m.UserId == userId).Select(m => m.Role).FirstOrDefault(),
            })
            .SingleOrDefaultAsync(ct);

        if (row is null) return null;
        if (row.OwnerId == userId) return ProjectRole.Owner;
        return row.MemberRole switch
        {
            MemberRoles.Editor => ProjectRole.Editor,
            MemberRoles.Viewer => ProjectRole.Viewer,
            _ => null,
        };
    }
}
```

**3. Presence colours** — `api/BranchStory.Api/Realtime/PresenceColors.cs`

```csharp
namespace BranchStory.Api.Realtime;

public static class PresenceColors
{
    private static readonly string[] Palette =
        ["#be123c", "#6d28d9", "#1d4ed8", "#0e7490", "#047857", "#a16207", "#c2410c", "#be185d"];

    /// <summary>
    /// Same colour for a user on every pod and after every restart. Derived from the Guid's bytes, not
    /// from string.GetHashCode(), which is randomized per process.
    /// </summary>
    public static string For(Guid userId)
    {
        var b = userId.ToByteArray();
        return Palette[(b[0] ^ b[7] ^ b[15]) % Palette.Length];
    }
}
```

**4. Presence** — `api/BranchStory.Api/Realtime/PresenceTracker.cs`

A singleton map *project → connection → user*. One user with two tabs has two connections but
appears once. A plain `Lock` keeps it simple and correct — presence changes are rare compared
with patches, so contention is irrelevant.

```csharp
namespace BranchStory.Api.Realtime;

public sealed class PresenceTracker
{
    private readonly Lock _gate = new();
    private readonly Dictionary<Guid, Dictionary<string, PresenceUser>> _byProject = new();

    public IReadOnlyList<PresenceUser> Join(Guid projectId, string connectionId, PresenceUser user)
    {
        lock (_gate)
        {
            if (!_byProject.TryGetValue(projectId, out var connections))
                _byProject[projectId] = connections = new Dictionary<string, PresenceUser>();
            connections[connectionId] = user;
            return SnapshotLocked(projectId);
        }
    }

    public IReadOnlyList<PresenceUser> Leave(Guid projectId, string connectionId)
    {
        lock (_gate)
        {
            if (_byProject.TryGetValue(projectId, out var connections)
                && connections.Remove(connectionId) && connections.Count == 0)
                _byProject.Remove(projectId);
            return SnapshotLocked(projectId);
        }
    }

    /// <summary>Called on disconnect: removes the connection everywhere, returns what changed.</summary>
    public IReadOnlyList<(Guid ProjectId, IReadOnlyList<PresenceUser> Users)> LeaveAll(string connectionId)
    {
        lock (_gate)
        {
            var changed = new List<(Guid, IReadOnlyList<PresenceUser>)>();
            foreach (var (projectId, connections) in _byProject.ToList())
            {
                if (!connections.Remove(connectionId)) continue;
                if (connections.Count == 0) _byProject.Remove(projectId);
                changed.Add((projectId, SnapshotLocked(projectId)));
            }
            return changed;
        }
    }

    public IReadOnlyList<(string ConnectionId, PresenceUser User)> Connections(Guid projectId)
    {
        lock (_gate)
        {
            return _byProject.TryGetValue(projectId, out var connections)
                ? connections.Select(kv => (kv.Key, kv.Value)).ToList()
                : [];
        }
    }

    /// <summary>Is this connection currently joined to the project? False after a leave or a kick.</summary>
    public bool IsIn(Guid projectId, string connectionId)
    {
        lock (_gate)
            return _byProject.TryGetValue(projectId, out var connections) && connections.ContainsKey(connectionId);
    }

    private IReadOnlyList<PresenceUser> SnapshotLocked(Guid projectId) =>
        _byProject.TryGetValue(projectId, out var connections)
            ? connections.Values.DistinctBy(u => u.UserId)
                .OrderBy(u => u.DisplayName, StringComparer.OrdinalIgnoreCase).ToList()
            : [];
}
```

**5. The hub** — `api/BranchStory.Api/Realtime/StoryHub.cs`

Three security rules, each one a real bug in real products when forgotten:

1. **Join is authorized per project**, not just "is signed in". The role comes from the database.
2. **Patches re-check a role that is at most 30 seconds old.** The role read at join time is cached
   in `Context.Items` with a timestamp. Patches inside that window trust the cache; once it is older
   than 30 seconds, the next `SendPatch` reads it from the database again. Without that, a demoted
   editor could keep editing for hours over a socket that never closes. The 30 s cache means we
   don't query the database on every keystroke batch. Step 6 below closes even that window for a
   member who is **removed**, by evicting their connections at once; a demotion (editor to viewer)
   takes effect within those 30 seconds.
3. **The sender never gets its own patch back** (`OthersInGroup`), and the server never trusts a
   user id from the payload — it uses the authenticated identity, resolved once per connection.

`GroupName` is the **one** place that spells group names; cap-08 uses it to broadcast job status.

```csharp
using System.Security.Claims;
using System.Text.Json;
using BranchStory.Api.Authorization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace BranchStory.Api.Realtime;

[Authorize]
public sealed class StoryHub(HubAccess access, PresenceTracker presence, TimeProvider clock) : Hub<IStoryClient>
{
    private static readonly TimeSpan RoleTtl = TimeSpan.FromSeconds(30);
    private const int MaxOpsPerPatch = 500;
    private const string UserKey = "user";

    private sealed record ConnectedUser(Guid Id, string DisplayName);
    private sealed record Grant(ProjectRole Role, DateTimeOffset CheckedAt);

    public static string GroupName(Guid projectId) => $"project:{projectId:N}";

    private static string GrantKey(Guid projectId) => $"grant:{projectId:N}";

    public override async Task OnConnectedAsync()
    {
        // resolve "sub" → users row once per connection (the SPA calls /api/me first, which creates it)
        var subject = Context.User?.FindFirstValue("sub") ?? throw new HubException("Not signed in.");
        var user = await access.FindUserAsync(subject, Context.ConnectionAborted)
            ?? throw new HubException("Unknown user; call GET /api/me once first.");
        Context.Items[UserKey] = new ConnectedUser(user.Id, user.DisplayName);
        await base.OnConnectedAsync();
    }

    public async Task<IReadOnlyList<PresenceUser>> JoinProject(Guid projectId)
    {
        var me = Me();
        var role = await access.GetRoleAsync(projectId, me.Id, Context.ConnectionAborted)
            ?? throw new HubException("You do not have access to this story.");

        Context.Items[GrantKey(projectId)] = new Grant(role, clock.GetUtcNow());
        await Groups.AddToGroupAsync(Context.ConnectionId, GroupName(projectId));

        var users = presence.Join(projectId, Context.ConnectionId,
            new PresenceUser(me.Id.ToString(), me.DisplayName, PresenceColors.For(me.Id)));
        await Clients.OthersInGroup(GroupName(projectId)).PresenceChanged(projectId, users);
        return users;
    }

    public async Task LeaveProject(Guid projectId)
    {
        Context.Items.Remove(GrantKey(projectId));
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(projectId));
        var users = presence.Leave(projectId, Context.ConnectionId);
        await Clients.Group(GroupName(projectId)).PresenceChanged(projectId, users);
    }

    public async Task SendPatch(Guid projectId, StoryPatchDto patch)
    {
        var role = await CurrentRoleAsync(projectId) ?? throw new HubException("Join the story first.");
        if (role < ProjectRole.Editor) throw new HubException("Viewers cannot edit this story.");
        if (patch.Ops.ValueKind != JsonValueKind.Array || patch.Ops.GetArrayLength() > MaxOpsPerPatch)
            throw new HubException("Invalid patch.");

        await Clients.OthersInGroup(GroupName(projectId)).PatchReceived(projectId, Me().Id.ToString(), patch);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var (projectId, users) in presence.LeaveAll(Context.ConnectionId))
            await Clients.Group(GroupName(projectId)).PresenceChanged(projectId, users);
        await base.OnDisconnectedAsync(exception);
    }

    private ConnectedUser Me() =>
        Context.Items.TryGetValue(UserKey, out var value) && value is ConnectedUser user
            ? user
            : throw new HubException("Not signed in.");

    /// <summary>The cached grant, re-read from the database once it is older than RoleTtl.</summary>
    private async Task<ProjectRole?> CurrentRoleAsync(Guid projectId)
    {
        // Kicked by MembershipChangedAsync? It can't reach this connection's Context.Items,
        // but it did remove us from the tracker, so refuse at once instead of trusting the grant.
        if (!presence.IsIn(projectId, Context.ConnectionId))
        {
            Context.Items.Remove(GrantKey(projectId));
            return null;
        }
        if (!Context.Items.TryGetValue(GrantKey(projectId), out var value) || value is not Grant grant) return null;
        if (clock.GetUtcNow() - grant.CheckedAt < RoleTtl) return grant.Role;

        var fresh = await access.GetRoleAsync(projectId, Me().Id, Context.ConnectionAborted);
        if (fresh is null)
        {
            await LeaveProject(projectId);
            await Clients.Caller.AccessRevoked(projectId);
            return null;
        }
        Context.Items[GrantKey(projectId)] = new Grant(fresh.Value, clock.GetUtcNow());
        return fresh;
    }
}
```

**6. Domain events → SignalR** — `api/BranchStory.Api/Realtime/SignalRProjectEvents.cs`

`IHubContext` lets code *outside* the hub (an endpoint, a background service) talk to clients.
When a membership changes, we re-check that user's open connections right away instead of waiting
for the 30-second TTL, and kick the ones that lost access. Code outside the hub can't reach a
connection's `Context.Items`, so the cached grant survives the kick. That is why the hub's
`CurrentRoleAsync` first asks `presence.IsIn(...)`: once we remove the connection from the tracker
here, its next `SendPatch` is refused even if a hostile client ignores `AccessRevoked`.

```csharp
using Microsoft.AspNetCore.SignalR;

namespace BranchStory.Api.Realtime;

public sealed class SignalRProjectEvents(
    IHubContext<StoryHub, IStoryClient> hub,
    PresenceTracker presence,
    IServiceScopeFactory scopes,
    ILogger<SignalRProjectEvents> log) : IProjectEvents
{
    public Task DocSavedAsync(Guid projectId, int version, Guid savedBy, CancellationToken ct) =>
        hub.Clients.Group(StoryHub.GroupName(projectId)).DocSaved(projectId, version, savedBy.ToString());

    public async Task MembershipChangedAsync(Guid projectId, Guid userId, CancellationToken ct)
    {
        var affected = presence.Connections(projectId).Where(c => c.User.UserId == userId.ToString()).ToList();
        if (affected.Count == 0) return;

        // HubAccess is scoped (DbContext) and this class is a singleton → open a scope
        await using var scope = scopes.CreateAsyncScope();
        var access = scope.ServiceProvider.GetRequiredService<HubAccess>();
        if (await access.GetRoleAsync(projectId, userId, ct) is not null) return; // role changed, still a member

        log.LogInformation("Revoking live access of {UserId} to project {ProjectId}", userId, projectId);
        foreach (var (connectionId, _) in affected)
        {
            await hub.Groups.RemoveFromGroupAsync(connectionId, StoryHub.GroupName(projectId), ct);
            await hub.Clients.Client(connectionId).AccessRevoked(projectId);
            var users = presence.Leave(projectId, connectionId);
            await hub.Clients.Group(StoryHub.GroupName(projectId)).PresenceChanged(projectId, users);
        }
    }
}
```

**7. Registration** — `api/BranchStory.Api/Realtime/RealtimeExtensions.cs`

`Replace` swaps cap-04's `NullProjectEvents` for the SignalR implementation, so the endpoints
don't know (or care) that real-time exists.

```csharp
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace BranchStory.Api.Realtime;

public static class RealtimeExtensions
{
    public static IServiceCollection AddRealtime(this IServiceCollection services)
    {
        services.AddSignalR(o =>
        {
            // Default is 32 KB. A 500-op patch can exceed that, so allow 64 KB but nothing near megabytes.
            o.MaximumReceiveMessageSize = 64 * 1024;
            // These two are the defaults, written out because they must match the client:
            // ping every 15 s, drop a client that has been silent for 30 s (= 2 missed pings).
            o.KeepAliveInterval = TimeSpan.FromSeconds(15);
            o.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        });
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<PresenceTracker>();
        services.AddScoped<HubAccess>();
        services.Replace(ServiceDescriptor.Singleton<IProjectEvents, SignalRProjectEvents>());
        return services;
    }

    public static IEndpointRouteBuilder MapRealtime(this IEndpointRouteBuilder app)
    {
        app.MapHub<StoryHub>("/hubs/story").RequireAuthorization();
        return app;
    }
}
```

In `api/BranchStory.Api/Program.cs` add the two calls. `AddRealtime()` must come **after** the
`NullProjectEvents` registration it replaces:

```csharp
builder.Services.AddSingleton<IProjectEvents, NullProjectEvents>(); // cap-04
builder.Services.AddRealtime();                                     // cap-07: replaces it

// … after UseAuthentication/UseAuthorization, next to the other Map… calls:
app.MapRealtime();
```

**8. Tokens on WebSockets.** Browsers cannot set an `Authorization` header on a WebSocket, so the
SignalR JS client sends the token as `?access_token=…`. JWT bearer ignores the query string by
default; teach it — **only for hub paths**. In `api/BranchStory.Api/Auth/AuthSetup.cs`, inside the
existing `.Configure<IConfiguration, DevTokens>((o, config, devTokens) => { … })` lambda, add:

```csharp
o.Events = new JwtBearerEvents
{
    OnMessageReceived = ctx =>
    {
        var accessToken = ctx.Request.Query["access_token"];
        if (!string.IsNullOrEmpty(accessToken) && ctx.HttpContext.Request.Path.StartsWithSegments("/hubs"))
            ctx.Token = accessToken;
        return Task.CompletedTask;
    },
};
```

:::warn title="Query-string tokens end up in logs"
Reverse proxies and request logging happily record full URLs. Keep access tokens short-lived,
exclude `/hubs` query strings from request logs (and from the ingress access log in cap-10), and
never accept `access_token` from the query on normal API routes — that is why the check above is
restricted to `/hubs`.
:::

**9. An integration test with two real clients** — `tests/BranchStory.Api.Tests/StoryHubTests.cs`

```bash
dotnet add tests/BranchStory.Api.Tests package Microsoft.AspNetCore.SignalR.Client
```

It uses cap-03's `ApiFactory` (the assembly fixture with a Testcontainers Postgres) and its
`SignInAsync` helper, and only the public HTTP API to set up a shared project. `TestServer` runs
in memory without a network port. The easiest way to reach it is long polling through its in-memory
`HttpMessageHandler`, and the hub code is identical for every transport. For long polling the
client sends the token as a normal `Authorization` header, so this test does not exercise the
query-string path from step 8.

```csharp
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace BranchStory.Api.Tests;

public sealed class StoryHubTests(ApiFactory api)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private sealed record Created(Guid Id);
    public sealed record PresenceUserDto(string UserId, string DisplayName, string Color);

    [Fact]
    public async Task Members_see_each_other_and_receive_patches()
    {
        var owner = await api.SignInAsync("olive");
        var viewer = await api.SignInAsync("victor");
        var projectId = await CreateSharedProjectAsync(owner, viewer, "viewer");

        await using var ownerHub = Connect(owner);
        await using var viewerHub = Connect(viewer);

        var ownerSeesBoth = new TaskCompletionSource<List<PresenceUserDto>>(TaskCreationOptions.RunContinuationsAsynchronously);
        ownerHub.On<Guid, List<PresenceUserDto>>("PresenceChanged", (_, users) =>
        {
            if (users.Count == 2) ownerSeesBoth.TrySetResult(users);
        });
        var viewerGotPatch = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        viewerHub.On<Guid, string, JsonElement>("PatchReceived", (_, _, patch) => viewerGotPatch.TrySetResult(patch));

        await ownerHub.StartAsync(Ct);
        await ownerHub.InvokeAsync<List<PresenceUserDto>>("JoinProject", projectId, Ct);
        await viewerHub.StartAsync(Ct);
        var seenByViewer = await viewerHub.InvokeAsync<List<PresenceUserDto>>("JoinProject", projectId, Ct);

        Assert.Equal(2, seenByViewer.Count);
        var seenByOwner = await ownerSeesBoth.Task.WaitAsync(Timeout, Ct);
        Assert.Contains(seenByOwner, u => u.UserId == viewer.Id.ToString());

        await ownerHub.InvokeAsync("SendPatch", projectId,
            new { clientId = "owner-tab", baseVersion = 1, ops = new object[] { new { kind = "setStart", nodeId = "start" } } }, Ct);
        var patch = await viewerGotPatch.Task.WaitAsync(Timeout, Ct);
        Assert.Equal("owner-tab", patch.GetProperty("clientId").GetString());
    }

    [Fact]
    public async Task Viewers_cannot_patch_and_strangers_cannot_join()
    {
        var owner = await api.SignInAsync("olive");
        var viewer = await api.SignInAsync("victor");
        var stranger = await api.SignInAsync("sam");
        var projectId = await CreateSharedProjectAsync(owner, viewer, "viewer");

        await using var viewerHub = Connect(viewer);
        await viewerHub.StartAsync(Ct);
        await viewerHub.InvokeAsync<List<PresenceUserDto>>("JoinProject", projectId, Ct);
        var denied = await Assert.ThrowsAsync<HubException>(() =>
            viewerHub.InvokeAsync("SendPatch", projectId, new { clientId = "v", baseVersion = 1, ops = Array.Empty<object>() }, Ct));
        Assert.Contains("Viewers cannot edit", denied.Message);

        await using var strangerHub = Connect(stranger);
        await strangerHub.StartAsync(Ct);
        await Assert.ThrowsAsync<HubException>(() =>
            strangerHub.InvokeAsync<List<PresenceUserDto>>("JoinProject", projectId, Ct));
    }

    private HubConnection Connect(TestUser user) => new HubConnectionBuilder()
        .WithUrl(new Uri(api.Server.BaseAddress, "hubs/story"), o =>
        {
            o.Transports = HttpTransportType.LongPolling;
            o.HttpMessageHandlerFactory = _ => api.Server.CreateHandler();
            // the same bearer token SignInAsync put on the user's HttpClient
            o.AccessTokenProvider = () => Task.FromResult(user.Client.DefaultRequestHeaders.Authorization?.Parameter);
        })
        .AddJsonProtocol(o => o.PayloadSerializerOptions.PropertyNameCaseInsensitive = true)
        .Build();

    private static async Task<Guid> CreateSharedProjectAsync(TestUser owner, TestUser member, string role)
    {
        var res = await owner.Client.PostAsJsonAsync("/api/projects", new { title = "Hub test" }, Ct);
        res.EnsureSuccessStatusCode();
        var project = (await res.Content.ReadFromJsonAsync<Created>(Ct))!;
        var share = await owner.Client.PutAsJsonAsync($"/api/projects/{project.Id}/members", new { email = member.Email, role }, Ct);
        share.EnsureSuccessStatusCode();
        return project.Id;
    }
}
```

```bash
dotnet test tests/BranchStory.Api.Tests --filter "FullyQualifiedName~StoryHubTests"
```

- [ ] `StoryHub`, `HubAccess`, `PresenceTracker`, `SignalRProjectEvents` and `RealtimeExtensions` compile in `Realtime/`
- [ ] `AddRealtime()` runs after the `NullProjectEvents` registration and `MapRealtime()` maps `/hubs/story` with authorization
- [ ] The JWT bearer reads `access_token` from the query string **only** on `/hubs` paths
- [ ] Both `StoryHubTests` pass: presence + patch relay, and viewer/stranger are refused
- [ ] I can explain why the hub can't use `ProjectGate` / `IHttpContextAccessor`
:::

:::quiz id=cap-07-q1 xp=15
Why does the hub check the role again on `SendPatch` (at least every 30 s) when it already checked on `JoinProject`?
- [ ] SignalR forgets `Context.Items` after every call
- [x] A WebSocket can stay open for hours; a role cached at join time would outlive a demotion or removal
- [ ] Viewers are allowed to join but the JWT changes on every message
- [ ] To balance load across database replicas
> The token is validated once, when the connection opens, and the connection can then stay open for
> hours. Authorization decisions have to keep up with what is in the database. Re-checking after a
> short TTL limits how long a stale grant can be used. On top of that, `MembershipChangedAsync`
> removes a kicked connection from the group and from `PresenceTracker`, and `CurrentRoleAsync`
> checks the tracker first, so a removed user can neither receive nor send from that moment on.
> `Context.Items` is the opposite of forgotten: it lives as long as the connection.
> That is exactly why a role cached in it would go stale.
:::

:::quiz id=cap-07-q2 xp=15
The hub relays patches but never writes them to the database. What keeps everyone consistent if a patch is lost?
- [ ] SignalR guarantees exactly-once delivery
- [ ] The hub replays the last 100 patches on reconnect
- [x] The saved document with its `version` is the source of truth: `DocSaved` makes clean clients catch up, and dirty clients resolve through the versioned save (409 → merge)
- [ ] Nothing — lost patches mean lost data
> Live patches are an optimization for *feel*. Correctness comes from the versioned document. That
> split keeps the hub stateless (apart from presence) and makes reconnects boring, which is what you
> want. SignalR does **not** guarantee delivery: messages sent while a client is disconnected are
> dropped, and our hub keeps no history it could replay.
:::

## The client: connection, hook and presence

Applying remote changes is the subtle part. Suppose Grace is typing a scene title and Ada's
patch updates the same scene. If we just replace the scene, Grace's last keystrokes vanish under
her cursor. The rule: **a remote op never overwrites an entity with unsent local edits**. Those
local edits are broadcast within ~100 ms anyway, at which point everyone converges on Grace's
version (last writer wins per entity).

"Unsent local edits" has a precise definition: the entities that differ between the document we
last broadcast (`lastSent`) and the current one. That is exactly what `diffDocs(lastSent, current)`
returns. A trace makes it concrete:

```text
lastSent (what the others have seen)   scene b: title "Fores"
current  (what Grace sees right now)   scene b: title "Forest"           → dirty = { "node:b" }

Ada's patch arrives                    upsertNode b (title "Woods"), upsertNode a (x = 300)
Grace's editor after applyRemote       b keeps "Forest" (dirty, skipped)  a moves to x = 300 (clean)

≤ 100 ms later Grace's throttle sends  upsertNode b "Forest"  → Ada's window shows "Forest" too
```

Both windows end up identical, and nobody lost keystrokes. Ada's rename of `b` lost, because Grace
wrote later: *last writer wins per entity*.

:::challenge id=cap-07-c1 lang=ts xp=70
title: Apply remote patches without clobbering local edits
Write `applyRemote(doc, ops, dirty)`. `dirty` holds keys of entities with **unsent local edits**:
`'node:<id>'`, `'edge:<id>'` and `'start'`. Apply the ops in order:

- `upsertNode` / `upsertEdge`: replace the entity with the same id **in place** (it keeps its
  position in the array), or append it at the end if it is new, unless its key is dirty.
- `removeNode` / `removeEdge`: remove it, unless its key is dirty.
- `setStart`: set `startNodeId` — unless `'start'` is dirty.

Afterwards keep the document consistent: drop every edge whose `from` or `to` no longer exists
(even a dirty one — it can't point at nothing), and set `startNodeId` to `null` if that node is gone.
Never mutate the input; if nothing changed, return the **same** object.

hint: Keep local variables `nodes`, `edges`, `start` and reassign them; compare with the originals at the end.
hint: `nodes.findIndex(...)` → replace with `map`, or append with `[...nodes, node]`.
hint: A remove of an id that isn't there must not create a new array, or "nothing changed → same object" breaks. Check with `some` first.
hint: Do the dangling-edge cleanup once, after the loop, with a `Set` of the remaining node ids.

```ts setup
type StoryNode = { id: string; title: string; text: string; x: number; y: number }
type StoryEdge = { id: string; from: string; to: string; label: string }
type StoryDoc = { startNodeId: string | null; nodes: StoryNode[]; edges: StoryEdge[] }
type PatchOp =
  | { kind: 'upsertNode'; node: StoryNode }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'upsertEdge'; edge: StoryEdge }
  | { kind: 'removeEdge'; edgeId: string }
  | { kind: 'setStart'; nodeId: string | null }
```

```ts starter
export function applyRemote(doc: StoryDoc, ops: PatchOp[], dirty: ReadonlySet<string>): StoryDoc {
  let nodes = doc.nodes
  for (const op of ops) {
    if (op.kind === 'upsertNode') nodes = [...nodes.filter((n) => n.id !== op.node.id), op.node]
  }
  return { ...doc, nodes }
}
```

```ts solution
export function applyRemote(doc: StoryDoc, ops: PatchOp[], dirty: ReadonlySet<string>): StoryDoc {
  let nodes = doc.nodes
  let edges = doc.edges
  let start = doc.startNodeId

  for (const op of ops) {
    switch (op.kind) {
      case 'upsertNode': {
        if (dirty.has(`node:${op.node.id}`)) break
        const i = nodes.findIndex((n) => n.id === op.node.id)
        nodes = i < 0 ? [...nodes, op.node] : nodes.map((n, j) => (j === i ? op.node : n))
        break
      }
      case 'removeNode':
        if (dirty.has(`node:${op.nodeId}`) || !nodes.some((n) => n.id === op.nodeId)) break
        nodes = nodes.filter((n) => n.id !== op.nodeId)
        break
      case 'upsertEdge': {
        if (dirty.has(`edge:${op.edge.id}`)) break
        const i = edges.findIndex((e) => e.id === op.edge.id)
        edges = i < 0 ? [...edges, op.edge] : edges.map((e, j) => (j === i ? op.edge : e))
        break
      }
      case 'removeEdge':
        if (dirty.has(`edge:${op.edgeId}`) || !edges.some((e) => e.id === op.edgeId)) break
        edges = edges.filter((e) => e.id !== op.edgeId)
        break
      case 'setStart':
        if (!dirty.has('start')) start = op.nodeId
        break
    }
  }

  const ids = new Set(nodes.map((n) => n.id))
  if (edges.some((e) => !ids.has(e.from) || !ids.has(e.to))) edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  if (start !== null && !ids.has(start)) start = null
  if (nodes === doc.nodes && edges === doc.edges && start === doc.startNodeId) return doc
  return { startNodeId: start, nodes, edges }
}
```

```ts tests
const nd = (id: string, title = id): StoryNode => ({ id, title, text: '', x: 0, y: 0 })
const ed = (id: string, from: string, to: string): StoryEdge => ({ id, from, to, label: id })
const local = (): StoryDoc => ({ startNodeId: 'a', nodes: [nd('a'), nd('b', 'Mine')], edges: [ed('ab', 'a', 'b')] })
const none = new Set<string>()

test('upsertNode appends a new scene', () => {
  const d = applyRemote(local(), [{ kind: 'upsertNode', node: nd('c') }], none)
  expect(d.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c'])
})
test('upsertNode replaces a clean scene in place', () => {
  const d = applyRemote(local(), [{ kind: 'upsertNode', node: nd('a', 'Theirs') }], none)
  expect(d.nodes.map((n) => n.title)).toEqual(['Theirs', 'Mine'])
})
test('a dirty scene is not overwritten', () => {
  const d = applyRemote(local(), [{ kind: 'upsertNode', node: nd('b', 'Theirs') }], new Set(['node:b']))
  expect(d.nodes[1].title).toBe('Mine')
})
test('removeNode cascades to choices touching it', () => {
  const d = applyRemote(local(), [{ kind: 'removeNode', nodeId: 'b' }], none)
  expect(d.nodes.map((n) => n.id)).toEqual(['a'])
  expect(d.edges).toEqual([])
})
test('a dirty scene survives a remote delete', () => {
  const d = applyRemote(local(), [{ kind: 'removeNode', nodeId: 'b' }], new Set(['node:b']))
  expect(d.nodes).toHaveLength(2)
  expect(d.edges).toHaveLength(1)
})
test('edges: upsert, dirty skip, remove', () => {
  const doc = local()
  const added = applyRemote(doc, [{ kind: 'upsertEdge', edge: ed('ba', 'b', 'a') }], none)
  expect(added.edges.map((e) => e.id)).toEqual(['ab', 'ba'])
  const renamed = applyRemote(doc, [{ kind: 'upsertEdge', edge: { ...ed('ab', 'a', 'b'), label: 'Theirs' } }], new Set(['edge:ab']))
  expect(renamed.edges[0].label).toBe('ab')
  expect(applyRemote(doc, [{ kind: 'removeEdge', edgeId: 'ab' }], none).edges).toEqual([])
})
test('a remote choice into a missing scene is dropped', () => {
  const d = applyRemote(local(), [{ kind: 'upsertEdge', edge: ed('ax', 'a', 'x') }], none)
  expect(d.edges.map((e) => e.id)).toEqual(['ab'])
})
test('a dirty choice into a remotely deleted scene is dropped too', () => {
  const d = applyRemote(local(), [{ kind: 'removeNode', nodeId: 'b' }], new Set(['edge:ab']))
  expect(d.edges).toEqual([])
})
test('setStart respects a dirty start, and the start is cleared when its scene goes', () => {
  expect(applyRemote(local(), [{ kind: 'setStart', nodeId: 'b' }], none).startNodeId).toBe('b')
  expect(applyRemote(local(), [{ kind: 'setStart', nodeId: 'b' }], new Set(['start'])).startNodeId).toBe('a')
  expect(applyRemote(local(), [{ kind: 'removeNode', nodeId: 'a' }], none).startNodeId).toBeNull()
})
test('ops apply in order', () => {
  const d = applyRemote(local(), [{ kind: 'upsertNode', node: nd('c') }, { kind: 'upsertEdge', edge: ed('bc', 'b', 'c') }, { kind: 'removeNode', nodeId: 'c' }], none)
  expect(d.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  expect(d.edges.map((e) => e.id)).toEqual(['ab'])
})
test('nothing applied returns the same object, and the input is untouched', () => {
  const doc = local()
  expect(applyRemote(doc, [{ kind: 'upsertNode', node: nd('b', 'X') }], new Set(['node:b']))).toBe(doc)
  applyRemote(doc, [{ kind: 'removeNode', nodeId: 'b' }], none)
  expect(doc.nodes).toHaveLength(2)
})
```
:::

:::challenge id=cap-07-c2 lang=ts xp=50
title: diffDocs — turn two documents into ops
Write `diffDocs(prev, next)` returning the ops that turn `prev` into `next`, **in this order**:

1. `upsertNode` for every node of `next` that is new or changed (in `next` order)
2. `removeNode` for every node of `prev` missing from `next` (in `prev` order)
3. `upsertEdge` / `removeEdge` — same rules for edges
4. `setStart` if `startNodeId` differs

"Changed" means a different object **and** different content: compare with
`JSON.stringify` only when the references differ (immutable updates keep unchanged objects
identical, so this is cheap). Same document → `[]`.

hint: A `Map` from id to node for `prev`; a `Set` of ids for `next`.

```ts setup
type StoryNode = { id: string; title: string; text: string; x: number; y: number }
type StoryEdge = { id: string; from: string; to: string; label: string }
type StoryDoc = { startNodeId: string | null; nodes: StoryNode[]; edges: StoryEdge[] }
type PatchOp =
  | { kind: 'upsertNode'; node: StoryNode }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'upsertEdge'; edge: StoryEdge }
  | { kind: 'removeEdge'; edgeId: string }
  | { kind: 'setStart'; nodeId: string | null }
```

```ts starter
export function diffDocs(prev: StoryDoc, next: StoryDoc): PatchOp[] {
  return next.nodes.map((node) => ({ kind: 'upsertNode', node }))
}
```

```ts solution
const differs = (a: unknown, b: unknown) => a !== b && JSON.stringify(a) !== JSON.stringify(b)

export function diffDocs(prev: StoryDoc, next: StoryDoc): PatchOp[] {
  if (prev === next) return []
  const ops: PatchOp[] = []

  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodeIds = new Set(next.nodes.map((n) => n.id))
  for (const n of next.nodes) if (differs(prevNodes.get(n.id), n)) ops.push({ kind: 'upsertNode', node: n })
  for (const n of prev.nodes) if (!nextNodeIds.has(n.id)) ops.push({ kind: 'removeNode', nodeId: n.id })

  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]))
  const nextEdgeIds = new Set(next.edges.map((e) => e.id))
  for (const e of next.edges) if (differs(prevEdges.get(e.id), e)) ops.push({ kind: 'upsertEdge', edge: e })
  for (const e of prev.edges) if (!nextEdgeIds.has(e.id)) ops.push({ kind: 'removeEdge', edgeId: e.id })

  if (prev.startNodeId !== next.startNodeId) ops.push({ kind: 'setStart', nodeId: next.startNodeId })
  return ops
}
```

```ts tests
const sn = (id: string, title = id): StoryNode => ({ id, title, text: '', x: 0, y: 0 })
const se = (id: string, from: string, to: string): StoryEdge => ({ id, from, to, label: id })
const before = (): StoryDoc => ({ startNodeId: 'a', nodes: [sn('a'), sn('b')], edges: [se('ab', 'a', 'b')] })

test('the same document gives no ops', () => {
  const d = before()
  expect(diffDocs(d, d)).toEqual([])
})
test('structurally equal copies give no ops', () => {
  expect(diffDocs(before(), before())).toEqual([])
})
test('a changed title is one upsertNode', () => {
  const prev = before()
  const next = { ...prev, nodes: [prev.nodes[0], { ...prev.nodes[1], title: 'New' }] }
  expect(diffDocs(prev, next)).toEqual([{ kind: 'upsertNode', node: { id: 'b', title: 'New', text: '', x: 0, y: 0 } }])
})
test('removing a scene and its choice', () => {
  const prev = before()
  const next = { startNodeId: 'a', nodes: [prev.nodes[0]], edges: [] }
  expect(diffDocs(prev, next)).toEqual([
    { kind: 'removeNode', nodeId: 'b' },
    { kind: 'removeEdge', edgeId: 'ab' },
  ])
})
test('full ordering: nodes, removed nodes, edges, removed edges, start', () => {
  const prev = before()
  const next = { startNodeId: 'c', nodes: [prev.nodes[0], sn('c')], edges: [se('ac', 'a', 'c')] }
  expect(diffDocs(prev, next)).toEqual([
    { kind: 'upsertNode', node: sn('c') },
    { kind: 'removeNode', nodeId: 'b' },
    { kind: 'upsertEdge', edge: se('ac', 'a', 'c') },
    { kind: 'removeEdge', edgeId: 'ab' },
    { kind: 'setStart', nodeId: 'c' },
  ])
})
```
:::

:::lab id=cap-07-lab2 xp=200
title: The realtime module — reconnecting hook, presence, live editing

**1. Install the client**

```bash
cd web
npm install @microsoft/signalr
```

**2. Types** — `web/src/modules/realtime/types.ts`

```ts
import type { StoryEdge, StoryNode } from '../../lib/types'

export interface PresenceUser {
  userId: string
  displayName: string
  color: string
}

export type PatchOp =
  | { kind: 'upsertNode'; node: StoryNode }
  | { kind: 'removeNode'; nodeId: string }
  | { kind: 'upsertEdge'; edge: StoryEdge }
  | { kind: 'removeEdge'; edgeId: string }
  | { kind: 'setStart'; nodeId: string | null }

export interface StoryPatch {
  clientId: string
  baseVersion: number
  ops: PatchOp[]
}

export type HubStatus = 'connecting' | 'online' | 'reconnecting' | 'offline'
```

**3. Ops** — `web/src/modules/realtime/ops.ts` (your `diffDocs` solution, plus `opKey`)

```ts
import type { StoryDoc } from '../../lib/types'
import type { PatchOp } from './types'

const differs = (a: unknown, b: unknown) => a !== b && JSON.stringify(a) !== JSON.stringify(b)

export function diffDocs(prev: StoryDoc, next: StoryDoc): PatchOp[] {
  if (prev === next) return []
  const ops: PatchOp[] = []

  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]))
  const nextNodeIds = new Set(next.nodes.map((n) => n.id))
  for (const n of next.nodes) if (differs(prevNodes.get(n.id), n)) ops.push({ kind: 'upsertNode', node: n })
  for (const n of prev.nodes) if (!nextNodeIds.has(n.id)) ops.push({ kind: 'removeNode', nodeId: n.id })

  const prevEdges = new Map(prev.edges.map((e) => [e.id, e]))
  const nextEdgeIds = new Set(next.edges.map((e) => e.id))
  for (const e of next.edges) if (differs(prevEdges.get(e.id), e)) ops.push({ kind: 'upsertEdge', edge: e })
  for (const e of prev.edges) if (!nextEdgeIds.has(e.id)) ops.push({ kind: 'removeEdge', edgeId: e.id })

  if (prev.startNodeId !== next.startNodeId) ops.push({ kind: 'setStart', nodeId: next.startNodeId })
  return ops
}

/** The entity an op touches: "node:<id>", "edge:<id>" or "start". */
export function opKey(op: PatchOp): string {
  switch (op.kind) {
    case 'upsertNode':
      return `node:${op.node.id}`
    case 'removeNode':
      return `node:${op.nodeId}`
    case 'upsertEdge':
      return `edge:${op.edge.id}`
    case 'removeEdge':
      return `edge:${op.edgeId}`
    case 'setStart':
      return 'start'
  }
}
```

**4. Merge remote** — `web/src/modules/realtime/mergeRemote.ts` (your `applyRemote` solution)

```ts
import type { StoryDoc } from '../../lib/types'
import type { PatchOp } from './types'

export function applyRemote(doc: StoryDoc, ops: PatchOp[], dirty: ReadonlySet<string>): StoryDoc {
  let nodes = doc.nodes
  let edges = doc.edges
  let start = doc.startNodeId

  for (const op of ops) {
    switch (op.kind) {
      case 'upsertNode': {
        if (dirty.has(`node:${op.node.id}`)) break
        const i = nodes.findIndex((n) => n.id === op.node.id)
        nodes = i < 0 ? [...nodes, op.node] : nodes.map((n, j) => (j === i ? op.node : n))
        break
      }
      case 'removeNode':
        if (dirty.has(`node:${op.nodeId}`) || !nodes.some((n) => n.id === op.nodeId)) break
        nodes = nodes.filter((n) => n.id !== op.nodeId)
        break
      case 'upsertEdge': {
        if (dirty.has(`edge:${op.edge.id}`)) break
        const i = edges.findIndex((e) => e.id === op.edge.id)
        edges = i < 0 ? [...edges, op.edge] : edges.map((e, j) => (j === i ? op.edge : e))
        break
      }
      case 'removeEdge':
        if (dirty.has(`edge:${op.edgeId}`) || !edges.some((e) => e.id === op.edgeId)) break
        edges = edges.filter((e) => e.id !== op.edgeId)
        break
      case 'setStart':
        if (!dirty.has('start')) start = op.nodeId
        break
    }
  }

  const ids = new Set(nodes.map((n) => n.id))
  if (edges.some((e) => !ids.has(e.from) || !ids.has(e.to))) edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to))
  if (start !== null && !ids.has(start)) start = null
  if (nodes === doc.nodes && edges === doc.edges && start === doc.startNodeId) return doc
  return { startNodeId: start, nodes, edges }
}
```

**5. The connection** — `web/src/modules/realtime/connection.ts`

`withAutomaticReconnect()` with no arguments gives up after four attempts (~45 s). A laptop that
sleeps for an hour must still come back, so we pass a policy that **never returns `null`**:
exponential backoff capped at 30 s, plus jitter so a server restart isn't greeted by every client
reconnecting in the same millisecond.

```ts
import { HubConnectionBuilder, LogLevel, type HubConnection, type RetryContext } from '@microsoft/signalr'
import { config } from '../../lib/config'
import { session } from '../../lib/session'

const retryForever = {
  nextRetryDelayInMilliseconds(ctx: RetryContext): number {
    const base = Math.min(30_000, 1000 * 2 ** ctx.previousRetryCount)
    return base + Math.floor(Math.random() * 1000)
  },
}

export function createStoryConnection(): HubConnection {
  return new HubConnectionBuilder()
    .withUrl(`${config.apiBase}/hubs/story`, {
      // called on every (re)connect, so a refreshed token is picked up automatically
      accessTokenFactory: () => session.getToken() ?? '',
    })
    .withAutomaticReconnect(retryForever)
    .configureLogging(LogLevel.Warning)
    .build()
}
```

**6. The hook** — `web/src/modules/realtime/useStoryHub.ts`

Responsibilities, in order of subtlety:

- one connection per open story (`useStoryHub(projectId, options)`): connect, `JoinProject`, keep
  `people` and `status` up to date;
- after a reconnect the server has **forgotten our groups** (new connection id) → join again and
  let the editor catch up on what it missed;
- broadcast local changes **throttled** (one patch per 100 ms, carrying everything since the last one);
- on a remote patch, compute the *dirty* set (unsent local edits) and hand both to the editor;
- keep `lastSent` in sync so remote changes are never echoed back.

**Throttle, not debounce.** A *debounce* waits for a pause, so a fast typist would broadcast nothing
until they stopped typing. A *throttle* sends at most one patch per 100 ms while changes keep
coming. Each patch carries everything since the last one, because it is computed as
`diffDocs(lastSent, current)` and not from individual keystrokes.

`useEffectEvent` (stable since React 19.2) lets the long-lived connection call the **latest**
callbacks without reconnecting every time a callback identity changes. Without it you would either
put `handlers` in the connection effect's dependency array, which reconnects on every render
because the parent passes new arrow functions each time, or read stale closures from the first
render.

```ts
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { HubConnectionState, type HubConnection } from '@microsoft/signalr'
import type { StoryDoc } from '../../lib/types'
import { createStoryConnection } from './connection'
import { applyRemote } from './mergeRemote'
import { diffDocs, opKey } from './ops'
import type { HubStatus, PatchOp, PresenceUser, StoryPatch } from './types'

const BROADCAST_MS = 100
const NOTHING_DIRTY: ReadonlySet<string> = new Set()

export interface StoryHubOptions {
  doc: StoryDoc
  baseVersion: number
  canEdit: boolean
  onRemotePatch: (ops: PatchOp[], dirty: ReadonlySet<string>, fromUserId: string) => void
  onDocSaved: (version: number, byUserId: string) => void
  onReconnected: () => void
  onAccessRevoked: () => void
}

export function useStoryHub(projectId: string, { doc, baseVersion, canEdit, ...handlers }: StoryHubOptions) {
  const [status, setStatus] = useState<HubStatus>('connecting')
  const [people, setPeople] = useState<PresenceUser[]>([])
  const [clientId] = useState(() => crypto.randomUUID())
  const connRef = useRef<HubConnection | null>(null)
  const lastSent = useRef(doc)
  const latest = useRef({ doc, baseVersion })
  const timer = useRef<number | null>(null)

  useEffect(() => {
    latest.current = { doc, baseVersion }
  })

  const onPatch = useEffectEvent((fromUserId: string, patch: StoryPatch) => {
    if (patch.clientId === clientId) return
    const dirty = new Set(diffDocs(lastSent.current, latest.current.doc).map(opKey))
    lastSent.current = applyRemote(lastSent.current, patch.ops, NOTHING_DIRTY)
    handlers.onRemotePatch(patch.ops, dirty, fromUserId)
  })
  const onSaved = useEffectEvent((version: number, byUserId: string) => handlers.onDocSaved(version, byUserId))
  const onBack = useEffectEvent(() => handlers.onReconnected())
  const onRevoked = useEffectEvent(() => handlers.onAccessRevoked())

  const sendPending = useEffectEvent(() => {
    const conn = connRef.current
    if (!conn || conn.state !== HubConnectionState.Connected) return
    const current = latest.current.doc
    const ops = diffDocs(lastSent.current, current)
    if (ops.length === 0) return
    lastSent.current = current
    const patch: StoryPatch = { clientId, baseVersion: latest.current.baseVersion, ops }
    conn.invoke('SendPatch', projectId, patch).catch(() => {
      // not delivered: fine — autosave persists the change and peers catch up on DocSaved
    })
  })

  // connection lifecycle: one connection per open story
  useEffect(() => {
    const conn = createStoryConnection()
    connRef.current = conn
    const life = { disposed: false } // set by the cleanup; callbacks below check it
    const isThis = (pid: string) => pid.toLowerCase() === projectId.toLowerCase()

    const join = async () => {
      const users = await conn.invoke<PresenceUser[]>('JoinProject', projectId)
      if (life.disposed) return
      setPeople(users)
      setStatus('online')
    }

    conn.on('PresenceChanged', (pid: string, users: PresenceUser[]) => {
      if (isThis(pid)) setPeople(users)
    })
    conn.on('PatchReceived', (pid: string, fromUserId: string, patch: StoryPatch) => {
      if (isThis(pid)) onPatch(fromUserId, patch)
    })
    conn.on('DocSaved', (pid: string, version: number, byUserId: string) => {
      if (isThis(pid)) onSaved(version, byUserId)
    })
    conn.on('AccessRevoked', (pid: string) => {
      if (!isThis(pid)) return
      onRevoked()
      void conn.stop()
    })
    conn.onreconnecting(() => {
      if (!life.disposed) setStatus('reconnecting')
    })
    conn.onreconnected(async () => {
      try {
        await join() // new connection id → the server forgot our groups
        onBack() // catch up on everything we missed while away
      } catch {
        if (!life.disposed) setStatus('offline')
      }
    })
    conn.onclose(() => {
      if (!life.disposed) setStatus('offline')
    })

    conn.start().then(join).catch(() => {
      if (!life.disposed) setStatus('offline')
    })

    return () => {
      life.disposed = true
      connRef.current = null
      void conn.stop()
    }
  }, [projectId])

  // throttled broadcast: the first change starts a 100 ms timer, later changes ride along
  useEffect(() => {
    if (!canEdit || status !== 'online' || timer.current !== null) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      sendPending()
    }, BROADCAST_MS)
  }, [doc, canEdit, status])

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  /** Changes that came from the server (catch-up) must not be broadcast as ours. */
  const absorb = useCallback((ops: PatchOp[]) => {
    lastSent.current = applyRemote(lastSent.current, ops, NOTHING_DIRTY)
  }, [])

  /** After a full reload: everything we have now is "already known" to the others. */
  const markSynced = useCallback((synced: StoryDoc) => {
    lastSent.current = synced
  }, [])

  return { status, people, clientId, absorb, markSynced }
}
```

**7. Presence UI** — `web/src/modules/realtime/PresenceBar.tsx`

```tsx
import type { HubStatus, PresenceUser } from './types'
import './realtime.css'

const LABEL: Record<HubStatus, string> = {
  connecting: 'Connecting…',
  online: 'Live',
  reconnecting: 'Reconnecting…',
  offline: 'Offline — changes still save',
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

export function PresenceBar({ people, status, meId }: { people: PresenceUser[]; status: HubStatus; meId?: string }) {
  return (
    <div className="bs-presence">
      <ul className="bs-presence__list" aria-label="People here">
        {people.map((p) => (
          <li key={p.userId} className="bs-avatar" style={{ background: p.color }} title={p.displayName}>
            <span aria-hidden="true">{initials(p.displayName)}</span>
            <span className="bs-visually-hidden">
              {p.displayName}
              {p.userId === meId ? ' (you)' : ''}
            </span>
          </li>
        ))}
      </ul>
      <span className="bs-conn" data-state={status}>{LABEL[status]}</span>
    </div>
  )
}
```

`web/src/modules/realtime/realtime.css`

```css
.bs-presence { display: flex; align-items: center; gap: var(--bs-space-2); }
.bs-presence__list { display: flex; list-style: none; margin: 0; padding: 0; }
.bs-avatar { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: #fff;
  font-size: 0.75rem; font-weight: 700; border: 2px solid var(--bs-surface); margin-left: -6px; }
.bs-avatar:first-child { margin-left: 0; }
.bs-conn { font-size: 0.8rem; color: var(--bs-muted); }
.bs-conn::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; background: var(--bs-muted); }
.bs-conn[data-state='online']::before { background: var(--bs-success); }
.bs-conn[data-state='offline']::before { background: var(--bs-danger); }
```

`web/src/modules/realtime/index.ts`

```ts
export { useStoryHub, type StoryHubOptions } from './useStoryHub'
export { PresenceBar } from './PresenceBar'
export { diffDocs, opKey } from './ops'
export { applyRemote } from './mergeRemote'
export type { HubStatus, PatchOp, PresenceUser, StoryPatch } from './types'
```

**8. Remote changes in the history** — replace `web/src/modules/editor/history.ts`

A remote patch is **not** a local edit: it must not bump `rev` (we don't save other people's
changes) and must not be undoable. We also *rebase* the undo snapshots onto it, so pressing
Ctrl+Z reverts **your** last change, not your colleague's.

```ts
import { applyRemote } from '../realtime/mergeRemote'
import type { PatchOp } from '../realtime/types'
import { storyReducer, type StoryAction } from './reducer'
import type { StoryDoc } from './model'

export const HISTORY_LIMIT = 100

export interface EditorHistory {
  past: StoryDoc[]
  present: StoryDoc
  future: StoryDoc[]
  /** increments on every local change; autosave compares it with the last saved rev */
  rev: number
  lastCoalesce: string | null
}

export type HistoryAction =
  | (StoryAction & { coalesce?: string })
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; doc: StoryDoc }
  | { type: 'remote'; ops: PatchOp[]; dirty: ReadonlySet<string> }

const NONE: ReadonlySet<string> = new Set()

export function initHistory(doc: StoryDoc): EditorHistory {
  return { past: [], present: doc, future: [], rev: 0, lastCoalesce: null }
}

export function historyReducer(state: EditorHistory, action: HistoryAction): EditorHistory {
  switch (action.type) {
    case 'undo': {
      if (state.past.length === 0) return state
      return {
        past: state.past.slice(0, -1),
        present: state.past[state.past.length - 1],
        future: [state.present, ...state.future],
        rev: state.rev + 1,
        lastCoalesce: null,
      }
    }
    case 'redo': {
      if (state.future.length === 0) return state
      return {
        past: [...state.past, state.present],
        present: state.future[0],
        future: state.future.slice(1),
        rev: state.rev + 1,
        lastCoalesce: null,
      }
    }
    case 'reset':
      return { ...initHistory(action.doc), rev: state.rev }
    case 'remote': {
      const present = applyRemote(state.present, action.ops, action.dirty)
      return {
        ...state,
        past: state.past.map((d) => applyRemote(d, action.ops, NONE)),
        present,
        future: state.future.map((d) => applyRemote(d, action.ops, NONE)),
        // rev unchanged: not a local edit, nothing for this client to save
      }
    }
    default: {
      const next = storyReducer(state.present, action)
      if (next === state.present) return state
      const coalesce = action.coalesce ?? null
      if (coalesce !== null && coalesce === state.lastCoalesce) {
        return { ...state, present: next, future: [], rev: state.rev + 1 }
      }
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        rev: state.rev + 1,
        lastCoalesce: coalesce,
      }
    }
  }
}
```

**9. Wire it into the editor** — replace `web/src/modules/editor/EditorPage.tsx`

New compared with cap-06:

- `useStoryHub` broadcasts local changes and feeds remote patches into the reducer.
- **Catch-up:** on `DocSaved` from someone else (or after a reconnect) a *clean* editor fetches the
  server document, applies the difference as a remote change and adopts the new version — so its
  next save won't 409 at all.
- **Auto-merge:** a *dirty* editor that gets a 409 first tries the three-way merge silently; the
  dialog only appears when both sides changed the same entity.

```tsx
import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError } from '../../lib/api'
import type { ProjectDetail } from '../../lib/types'
import { useAuth } from '../auth/AuthContext'
import { fetchProject, projectKeys, useProject } from '../projects'
import { diffDocs, PresenceBar, useStoryHub } from '../realtime'
import { Button, Spinner } from '../ui'
import { ConflictDialog } from './ConflictDialog'
import { GraphCanvas } from './GraphCanvas'
import { historyReducer, initHistory } from './history'
import { IssuesPanel } from './IssuesPanel'
import { mergeDocs } from './merge'
import { newId, type StoryDoc } from './model'
import { NodeInspector } from './NodeInspector'
import { useSaveDoc } from './queries'
import { SaveIndicator } from './SaveIndicator'
import { useAutosave } from './useAutosave'
import { validateStory } from './validate'
import './editor.css'

/** The first validation message (e.g. "startNodeId must reference an existing node."), else the error text. */
function saveErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return Object.values(err.problem.errors ?? {})[0]?.[0] ?? err.message
  return 'the server could not be reached.'
}

export function EditorPage() {
  const { projectId = '' } = useParams()
  const project = useProject(projectId)
  if (project.isPending) return <Spinner label="Loading story" />
  if (project.isError) return <p role="alert" className="bs-error">Could not load this story: {project.error.message}</p>
  return <Editor key={project.data.id} project={project.data} />
}

const NO_DIRTY: ReadonlySet<string> = new Set()

function Editor({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [revoked, setRevoked] = useState(false)
  const readOnly = project.role === 'viewer' || revoked
  const [hist, dispatch] = useReducer(historyReducer, project.doc, initHistory)
  const histRef = useRef(hist)
  const [selectedId, setSelectedId] = useState<string | null>(project.doc.startNodeId)
  const versionRef = useRef(project.version)
  const [version, setVersion] = useState(project.version)
  const [notice, setNotice] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [needsDecision, setNeedsDecision] = useState(false)
  const { mutateAsync: saveDoc } = useSaveDoc(project.id)

  useEffect(() => {
    histRef.current = hist
  })

  const setServerVersion = (v: number) => {
    versionRef.current = v
    setVersion(v)
  }

  const save = useCallback(
    async (doc: StoryDoc) => {
      const res = await saveDoc({ expectedVersion: versionRef.current, doc })
      versionRef.current = res.version
      setVersion(res.version)
    },
    [saveDoc],
  )

  const autosave = useAutosave({ doc: hist.present, rev: hist.rev, save, enabled: !readOnly })
  const issues = useMemo(() => validateStory(hist.present), [hist.present])
  const selected = hist.present.nodes.find((n) => n.id === selectedId)
  const conflictVersion = autosave.error instanceof ApiError ? autosave.error.currentVersion : undefined

  const fetchLatest = () =>
    qc.fetchQuery({ queryKey: projectKeys.detail(project.id), queryFn: () => fetchProject(project.id), staleTime: 0 })

  /** Adopt the server document as a remote change (keeps undo history, no save triggered). */
  function adoptServerDoc(serverDoc: StoryDoc, serverVersion: number, atRev: number) {
    const ops = diffDocs(histRef.current.present, serverDoc)
    setServerVersion(serverVersion)
    autosave.markSaved(serverDoc, atRev)
    if (ops.length) {
      dispatch({ type: 'remote', ops, dirty: NO_DIRTY })
      hub.absorb(ops)
    }
  }

  async function catchUp(announced?: number) {
    if (announced !== undefined && announced <= versionRef.current) return // our own save, or old news
    if (autosave.status !== 'saved') return // local edits pending → the next save (+ auto-merge) handles it
    const revAtStart = histRef.current.rev
    const latest = await fetchLatest()
    if (histRef.current.rev !== revAtStart || latest.version <= versionRef.current) return
    adoptServerDoc(latest.doc, latest.version, revAtStart)
  }

  const hub = useStoryHub(project.id, {
    doc: hist.present,
    baseVersion: version,
    canEdit: !readOnly,
    onRemotePatch: (ops, dirty) => dispatch({ type: 'remote', ops, dirty }),
    onDocSaved: (v) => void catchUp(v),
    onReconnected: () => void catchUp(),
    onAccessRevoked: () => {
      setRevoked(true)
      setNotice('Your access to this story was removed.')
    },
  })

  // 409 → try a silent three-way merge first; only real overlaps need the user
  const autoMerge = useEffectEvent((latest: ProjectDetail | null) => {
    const h = histRef.current
    const merged = latest && mergeDocs(autosave.getSavedDoc(), h.present, latest.doc)
    if (!latest || !merged || merged.conflicts.length) {
      setNeedsDecision(true)
    } else if (merged.doc === latest.doc) {
      adoptServerDoc(latest.doc, latest.version, h.rev) // nothing of ours left to save
    } else {
      setServerVersion(latest.version)
      autosave.markSaved(latest.doc, h.rev)
      dispatch({ type: 'replace', doc: merged.doc }) // new local revision → autosave saves the merge
    }
  })
  const loadLatest = useEffectEvent(() => fetchLatest())

  useEffect(() => {
    if (autosave.status !== 'conflict') return
    loadLatest().then(autoMerge, () => autoMerge(null))
  }, [autosave.status])

  useEffect(() => {
    if (readOnly) return
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return
      e.preventDefault()
      dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly])

  async function resolveConflict(choice: 'reload' | 'overwrite' | 'merge') {
    setResolving(true)
    setNeedsDecision(false)
    try {
      if (choice === 'overwrite') {
        setServerVersion(conflictVersion ?? (await fetchLatest()).version)
        autosave.resume()
        return
      }
      const latest = await fetchLatest()
      setServerVersion(latest.version)
      if (choice === 'reload') {
        dispatch({ type: 'reset', doc: latest.doc })
        autosave.markSaved(latest.doc, hist.rev)
        hub.markSynced(latest.doc)
        setNotice('Loaded the latest version from the server.')
      } else {
        const { doc, conflicts } = mergeDocs(autosave.getSavedDoc(), hist.present, latest.doc)
        autosave.markSaved(latest.doc, hist.rev)
        dispatch({ type: 'replace', doc })
        setNotice(
          conflicts.length
            ? `Merged. ${conflicts.length} item(s) were changed on both sides — your version was kept.`
            : 'Merged both sets of changes.',
        )
      }
    } catch (e) {
      setNotice(`Could not resolve the conflict: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setResolving(false)
    }
  }

  function addScene() {
    const n = hist.present.nodes.length
    // same key order and null mediaUrl as the server's JSON, so structural comparisons stay cheap
    const node = { id: newId(), title: `Scene ${n + 1}`, text: '', mediaUrl: null, x: 40 + (n % 4) * 220, y: 40 + Math.floor(n / 4) * 130 }
    dispatch({ type: 'addNode', node })
    setSelectedId(node.id)
  }

  return (
    <div className="bs-editor">
      <div className="bs-editor__bar">
        <h1>{project.title}</h1>
        {readOnly && <span className="bs-badge">Read-only</span>}
        <PresenceBar people={hub.people} status={hub.status} meId={user?.id} />
        <SaveIndicator status={autosave.status} version={version} />
        <Button onClick={addScene} disabled={readOnly}>Add scene</Button>
        <Button onClick={() => dispatch({ type: 'undo' })} disabled={readOnly || hist.past.length === 0}>Undo</Button>
        <Button onClick={() => dispatch({ type: 'redo' })} disabled={readOnly || hist.future.length === 0}>Redo</Button>
      </div>

      {notice && (
        <p className="bs-notice" role="status">
          {notice}
          <Button variant="ghost" onClick={() => setNotice(null)}>Dismiss</Button>
        </p>
      )}
      {autosave.status === 'error' && (
        <p role="alert" className="bs-notice bs-error">
          Saving failed: {saveErrorMessage(autosave.error)} Your changes are still here.
          <Button onClick={autosave.resume}>Retry</Button>
        </p>
      )}

      <div className="bs-editor__body">
        <GraphCanvas
          doc={hist.present}
          selectedId={selectedId}
          readOnly={readOnly}
          onSelect={setSelectedId}
          onMove={(id, x, y) => dispatch({ type: 'moveNode', id, x, y })}
        />
        {selected ? (
          <NodeInspector key={selected.id} doc={hist.present} node={selected} readOnly={readOnly} dispatch={dispatch} />
        ) : (
          <aside className="bs-inspector">
            <p className="bs-muted">Select a scene to edit it.</p>
          </aside>
        )}
      </div>

      <IssuesPanel issues={issues} onShow={setSelectedId} />

      {autosave.status === 'conflict' && needsDecision && (
        <ConflictDialog
          currentVersion={conflictVersion}
          busy={resolving}
          onReload={() => void resolveConflict('reload')}
          onOverwrite={() => void resolveConflict('overwrite')}
          onMerge={() => void resolveConflict('merge')}
        />
      )}
    </div>
  )
}
```

**10. Tests for the pure parts** — `web/src/modules/realtime/realtime.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import type { StoryDoc, StoryNode } from '../../lib/types'
import { historyReducer, initHistory } from '../editor/history'
import { applyRemote } from './mergeRemote'
import { diffDocs, opKey } from './ops'

const n = (id: string, title = id): StoryNode => ({ id, title, text: '', x: 0, y: 0 })
const doc: StoryDoc = { startNodeId: 'a', nodes: [n('a'), n('b')], edges: [{ id: 'ab', from: 'a', to: 'b', label: 'Go' }] }

describe('realtime ops', () => {
  it('diff + applyRemote round-trips a document', () => {
    const next: StoryDoc = { startNodeId: 'c', nodes: [n('a', 'Renamed'), n('c')], edges: [{ id: 'ac', from: 'a', to: 'c', label: 'Hop' }] }
    expect(applyRemote(doc, diffDocs(doc, next), new Set())).toEqual(next)
  })

  it('unsent local edits are the dirty set and survive a remote patch', () => {
    const mine: StoryDoc = { ...doc, nodes: [doc.nodes[0], n('b', 'Typing…')] }
    const dirty = new Set(diffDocs(doc, mine).map(opKey))
    expect([...dirty]).toEqual(['node:b'])
    const merged = applyRemote(mine, [{ kind: 'upsertNode', node: n('b', 'Theirs') }, { kind: 'upsertNode', node: n('a', 'Theirs too') }], dirty)
    expect(merged.nodes.map((x) => x.title)).toEqual(['Theirs too', 'Typing…'])
  })

  it('remote patches do not bump rev and are rebased into undo history', () => {
    let h = historyReducer(initHistory(doc), { type: 'updateNode', id: 'b', patch: { title: 'Mine' } })
    h = historyReducer(h, { type: 'remote', ops: [{ kind: 'upsertNode', node: n('a', 'Theirs') }], dirty: new Set() })
    expect(h.rev).toBe(1)
    h = historyReducer(h, { type: 'undo' })
    expect(h.present.nodes.map((x) => x.title)).toEqual(['Theirs', 'b']) // my edit undone, theirs kept
  })
})
```

```bash
npm test
npx tsc -b
npm run dev
```

**11. Try it with two people.** Sign in as Ada in one browser and as Grace (an editor of the
story) in a private window. Open the same story in both:

1. Both avatars appear in both toolbars; the dot says **Live**.
2. Ada drags a scene — it moves in Grace's window a moment after the drop.
3. Grace types in a title while Ada renames the *same* scene: Grace's text is never replaced
   under her cursor; a moment later both windows show Grace's title (she wrote last).
4. Stop the API for 20 seconds (`Ctrl+C`, then `dotnet run` again): the dot shows
   **Reconnecting…**, then **Live**; edits made meanwhile are saved and broadcast.
5. As the owner, remove Grace from the story in the share dialog: Grace's editor turns read-only
   with "Your access to this story was removed."

:::job title="What on-call learns about WebSockets"
Real-time features fail in ways REST doesn't: proxies with 60-second idle timeouts, load balancers
without WebSocket upgrade, mobile networks dropping sockets silently, and thundering herds after a
deploy. Keep-alives, reconnect-with-jitter, a visible connection state, and "the database is the
truth" are what make those incidents boring.
:::

- [ ] Two browsers on one story see each other's avatars, and the connection dot shows **Live**
- [ ] Moves, new scenes and choices appear in the other browser without a reload
- [ ] Concurrent typing on the same scene never replaces the text under the typist's cursor
- [ ] After restarting the API the client reconnects by itself, re-joins and catches up
- [ ] A clean editor adopts a collaborator's save without a 409; overlapping edits still show the dialog
- [ ] Removing a member turns their open editor read-only; `npm test` and `npx tsc -b` pass
:::

:::warn title="One API pod only — for now"
Groups and the `PresenceTracker` live in the memory of one process. With two API replicas, Ada on
pod 1 and Grace on pod 2 would never see each other. Scaling out needs a **backplane**
(`AddStackExchangeRedis()` or Azure SignalR Service) so group messages fan out across pods, plus
presence in Redis — and either sticky sessions or WebSockets-only clients (`skipNegotiation`).
cap-10 lists this under "what next".
:::

:::quiz id=cap-07-q3 xp=15
Why does `PatchReceived` go to `Clients.OthersInGroup(...)` instead of `Clients.Group(...)`?
- [ ] `Group` is limited to 100 connections
- [x] The sender already applied the change locally; echoing it back wastes bandwidth and can re-apply stale state over newer local edits
- [ ] SignalR forbids sending to the caller from inside a hub method
- [ ] So that viewers don't receive patches
> The local state is always ahead of what the sender broadcast. Receiving its own older patch
> could undo keystrokes typed since. The client also filters by `clientId` as a second line of
> defence (useful if you ever send through a backplane or from a background job).
:::

:::quiz id=cap-07-q4 xp=15
A remote patch arrives. Which local entities count as "dirty" and are protected from it?
- [ ] Every entity changed since the last successful save
- [x] Entities that differ between the last broadcast document (`lastSent`) and the current document
- [ ] Only the entity whose input currently has keyboard focus
- [ ] None — remote patches always win
> Since-the-last-save would protect far too much for far too long (saves are ~1 s apart and may
> fail). Unsent edits are exactly the ones nobody else has seen yet; they go out within 100 ms,
> after which normal last-writer-wins takes over.
:::

:::quiz id=cap-07-q5 xp=15
After `onreconnected` fires, what must the client do? (Select all that apply.)
- [x] Call `JoinProject` again, because the new connection is not in any group
- [x] Catch up on saves it may have missed while disconnected
- [ ] Reload the whole page to get a fresh token
- [ ] Nothing; SignalR restores groups automatically
> Groups belong to connection ids, and a reconnect creates a new one. The hub can't replay what
> you missed, so the client re-joins and refetches the document if it has no unsaved edits.
> `accessTokenFactory` is called again on reconnect, so a refreshed token is used automatically.
:::

:::quiz id=cap-07-q6 xp=15
Spot the bug. A teammate "simplifies" the hub by caching the role in a field:

```csharp
public sealed class StoryHub(HubAccess access) : Hub<IStoryClient>
{
    private ProjectRole? _role;
    // … OnConnectedAsync, Me() and GroupName() exactly as in the real hub

    public async Task JoinProject(Guid projectId) =>
        _role = await access.GetRoleAsync(projectId, Me().Id, Context.ConnectionAborted);

    public Task SendPatch(Guid projectId, StoryPatchDto patch) =>
        _role >= ProjectRole.Editor
            ? Clients.OthersInGroup(StoryHub.GroupName(projectId)).PatchReceived(projectId, Me().Id.ToString(), patch)
            : throw new HubException("Viewers cannot edit this story.");
}
```

What happens when an editor joins and then sends a patch?
- [ ] It works, but every connected user shares the same `_role`
- [x] Every patch is refused: hubs are transient, so `SendPatch` runs on a new instance whose `_role` is `null`
- [ ] It works until the 30-second TTL expires
- [ ] It does not compile, because hubs cannot have fields
> SignalR creates a fresh hub instance for **every** method invocation, so a field set in
> `JoinProject` is gone by the next call. `null >= ProjectRole.Editor` is `false` in C#, so even the
> owner is refused. "Shared by everyone" is the bug you would get with a **static** field, which is
> worse because it is a security hole. State that belongs to a connection goes in `Context.Items`.
> State shared by all connections goes in a singleton service. The code compiles fine, because
> fields are legal C#; it is the lifetime that is wrong.
:::

:::cards id=cap-07-cards1 xp=20 title="SignalR collaboration"
Q: How long does a hub instance live?
A: One method invocation (hubs are transient). Per-connection state goes in `Context.Items`, shared state in a singleton.
Q: Do groups survive a reconnect?
A: No. A reconnect gets a new connection id that is in no group, so the client must call `JoinProject` again.
Q: What is a strongly typed hub?
A: `Hub<IStoryClient>` — server-to-client calls go through an interface, so method-name typos are compile errors.
Q: How does a browser send a JWT on a WebSocket?
A: As the `access_token` query parameter; `JwtBearerEvents.OnMessageReceived` copies it into `ctx.Token` for `/hubs` paths only.
Q: What is `IHubContext<THub, T>` for?
A: Sending to clients from outside the hub — endpoints, background services, domain event handlers.
Q: Why is the hub a relay and not a store?
A: The versioned database document stays the single source of truth; lost patches heal on the next save or catch-up.
Q: What breaks with two API replicas and no backplane?
A: Groups and presence are per process; users on different pods never see each other's messages.
Q: Why jitter in the reconnect delay?
A: After a restart, thousands of clients would otherwise reconnect at the same instant (thundering herd).
Q: What does `useEffectEvent` solve in the hub hook?
A: Long-lived subscriptions can call the latest callbacks without being torn down and reconnected when callbacks change.
:::

## Recap

- `StoryHub : Hub<IStoryClient>` authorizes `JoinProject` per project, re-checks roles on patches (30 s cache, instant eviction when a member is removed), and relays to `OthersInGroup`.
- `PresenceTracker` (singleton) dedupes users across tabs; `OnDisconnectedAsync` keeps rosters honest.
- `SignalRProjectEvents` replaces `NullProjectEvents` via `services.Replace`, broadcasting `DocSaved` and kicking removed members.
- WebSocket auth uses `access_token` from the query, accepted only on `/hubs`.
- The React hook reconnects forever with jittered backoff, re-joins on reconnect, throttles outgoing patches, and never echoes remote changes.
- `applyRemote` skips entities with unsent local edits; remote changes don't bump `rev` and are rebased into undo history.
- The saved, versioned document remains the truth: clean clients catch up on `DocSaved`, dirty ones auto-merge on 409.
