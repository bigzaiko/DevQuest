---
id: cap-04
title: "Concurrency, Sharing & Quotas: No Lost Updates, No Free Rides"
level: expert
minutes: 240
xp: 300
summary: Versioned saves that refuse stale writes with 409 (and If-Match/412), sharing with editor/viewer seats, quotas billed to the owner, and tests that prove all of it under real concurrency.
---

Collaboration breaks naive CRUD. The moment two people (or two browser tabs) edit the same story,
"last write wins" silently destroys someone's work. The moment a project can be shared, "who pays?"
becomes a security question. This lesson makes saves **conflict-aware**, adds **sharing**, and makes
**quotas** impossible to dodge, all proven by tests that fire real parallel requests.

## The lost update, in slow motion

```text
time ─────────────────────────────────────────────────────────────────────►
Ada's tab    GET (v1) ───── edits scene 2 ───────────── PUT doc ──► v2   ✔
Ben's tab        GET (v1) ── edits scene 5 ── PUT doc ──► v2   ✔
                                                       ▲
                       without a version check Ada's PUT replaces the whole
                       document: Ben's scene 5 edit is gone, nobody is told
```

Neither request is "wrong" on its own: each PUT is a perfectly valid full document. The bug is
that the server has no way to know Ada's document was built on top of a version that no longer
exists. This is called a **lost update**, and no amount of input validation catches it.

The fix is **optimistic concurrency**: every save says which version it was based on, and the
database applies it only if that is still the current version.

```sql
UPDATE projects
SET doc = @doc, version = @expected + 1, updated_at = now()
WHERE id = @id AND version = @expected;     -- 1 row: you won.  0 rows: someone saved first.
```

This pattern is a **compare-and-swap** (CAS): "swap in my new value, but only if the current
value is still the one I compared against". The comparison and the write happen in **one SQL
statement**, so nothing can sneak in between them. With that guard, Ada's late save matches
**zero rows**. The API answers **409 Conflict** with the current version, and the editor (cap-06)
offers *reload*, *overwrite* (re-save on top of the new version) or *merge*. Nobody's work
disappears without them knowing.

Walking through the timeline again with the guard: both tabs load `version = 1`. Ben saves first
with `expectedVersion: 1`, the row matches, and it becomes version 2. Ada then saves with
`expectedVersion: 1`, but the row now says 2, so `WHERE version = 1` matches nothing and she gets a
409 telling her `currentVersion: 2`.

**Why "optimistic"?** We don't lock anything while people edit (that could be hours). We assume
conflicts are rare and detect them at write time. Pessimistic locking ("Ben is editing, the story
is read-only for you") is the alternative, and real-time presence (cap-07) makes conflicts rarer
still, but the version check stays as the safety net.

### Three status codes, three meanings

HTTP already has vocabulary for "only do this if the resource hasn't changed". An **ETag** (entity
tag) is an opaque label for one version of a resource that the server sends in a response header.
A client that wants a conditional write echoes it back in an **`If-Match`** request header:
"apply this PUT only if your current ETag is still this one". BranchStory uses the document
version as the ETag, so `ETag: "7"` simply means "version 7". The same check can also arrive in
the JSON body as `expectedVersion`, which is easier for a SPA that already has the version in
its state. The status code tells the client *which* of the two checks failed:

| Situation | Status | Body |
|---|---|---|
| Body says `expectedVersion: 1`, row is at 2 | **409 Conflict** | problem + `currentVersion: 2` |
| Header `If-Match: "1"`, row is at 2 | **412 Precondition Failed** | problem + `currentVersion: 2` |
| Neither body version nor `If-Match` sent | **428 Precondition Required** | "send a version" |

`GET /api/projects/{id}` returns `ETag: "<version>"`, so HTTP-savvy clients can just echo it as
`If-Match`. RFC 9110 says a failed `If-Match` is **412**; a conflict detected from the request body
is a **409** (the request conflicts with the current state of the resource). **428** comes from
RFC 6585 and means "this endpoint requires a precondition and you sent none". Requiring a version
stops a buggy client from silently doing blind overwrites, which would bring the lost update back.

:::tip title="Weak ETags can't guard a write"
An ETag written as `W/"7"` is *weak*: it means "semantically equivalent", not "byte-for-byte
this version". RFC 9110 requires strong comparison for `If-Match`, so a weak tag can never match.
`ETags.Parse` below treats it as "no usable version" and the client gets a 428 telling it to send
a real one.
:::

:::quiz id=cap-04-q1 xp=15
A client sends `PUT /api/projects/42/doc` with header `If-Match: "4"` and no `expectedVersion` in
the body. The project is at version 5. What does BranchStory answer?
- [ ] 409 Conflict
- [x] 412 Precondition Failed, with `currentVersion: 5`
- [ ] 428 Precondition Required
- [ ] 200, because If-Match is only a hint
> The precondition was expressed with an HTTP header, so the HTTP answer for a failed precondition applies: 412 (RFC 9110). 409 is tempting because it *is* a conflict, but BranchStory reserves 409 for a stale `expectedVersion` in the body; both carry `currentVersion` so the client can reload or retry on top of it. 428 is only for "you didn't send any version at all", and `If-Match` is never a hint: a server that supports it must refuse the write when it doesn't match.
:::

## Sharing and the "who pays?" rule

Owners invite people who have signed in at least once, by email, as **editor** (can save) or
**viewer** (read-only). Seats are rows in `project_members`. Two rules make this safe:

1. **Everything is checked against the owner.** Scenes per story, collaborators per project and
   (in cap-08) publishes per day come from the **owner's** plan, no matter who makes the request.
   Otherwise a free owner could invite one Pro friend and "borrow" their limits, and quota checks
   would depend on whoever happened to click save.
2. **Access is re-checked on every HTTP request.** `ProjectGate` reads the membership from the
   database on each REST call; no role is cached in the token. Removing someone takes effect on
   their very next request. If the role lived in the JWT instead, a removed editor could keep
   saving until their token expired. (Long-lived SignalR connections in cap-07 are the one place
   that caches the role, for at most 30 seconds, and removing a member kicks their connections at
   once.)

Two status codes show up again and again below. A user who is **not a member at all** gets
**404** (from cap-03's `ProjectGate`): we don't even confirm the project exists. A member whose
role is too low (a viewer trying to save or share) gets **403**. A plan limit is also a **403**
with a dedicated problem `type`, because the request is understood and authenticated but not
allowed on this plan. (429 Too Many Requests is for rate limiting, which retrying later fixes;
waiting doesn't raise a seat limit.)

| Plan | Projects owned | Scenes per story | Collaborators per project | Publishes per day |
|---|---|---|---|---|
| `free` | 3 | 50 | 2 | 5 |
| `pro` | 100 | 1000 | 25 | 100 |

Sharing endpoints, under `/api/projects/{id}/members`:

| Route | Who | What |
|---|---|---|
| `GET /` | viewer+ | owner first, then members: `{ userId, email, displayName, role }` |
| `PUT /` | owner | `{ "email": "...", "role": "editor" \| "viewer" }` adds or changes a seat (idempotent) |
| `DELETE /{userId}` | owner, or the member themself | remove a seat / leave |

:::lab id=cap-04-lab1 xp=120
title: Versioned saves with quotas

Work from the repository root with Postgres running. Five new files and one replaced one.

**1. Plan limits and the quota problem.** `api/BranchStory.Api/Quotas/PlanLimits.cs`:

```csharp
using BranchStory.Data;
using Microsoft.AspNetCore.Http.HttpResults;

namespace BranchStory.Api.Quotas;

/// <summary>What a plan allows. Always looked up for the project OWNER, never for the caller.</summary>
public sealed record PlanLimits(int MaxProjects, int MaxNodesPerStory, int MaxMembersPerProject, int PublishesPerDay)
{
    public static readonly PlanLimits Free = new(MaxProjects: 3, MaxNodesPerStory: 50, MaxMembersPerProject: 2, PublishesPerDay: 5);
    public static readonly PlanLimits Pro = new(MaxProjects: 100, MaxNodesPerStory: 1000, MaxMembersPerProject: 25, PublishesPerDay: 100);

    public static PlanLimits For(string plan) => plan == Plans.Pro ? Pro : Free;
}

public static class QuotaProblems
{
    public const string Type = "https://branchstory.dev/problems/plan-limit";

    public static ProblemHttpResult Exceeded(string what, int limit, string ownerPlan) =>
        TypedResults.Problem(
            statusCode: StatusCodes.Status403Forbidden,
            type: Type,
            title: "Plan limit reached",
            detail: $"The project owner's '{ownerPlan}' plan allows {limit} {what}.",
            extensions: new Dictionary<string, object?> { ["limit"] = limit, ["plan"] = ownerPlan });
}
```

**2. An events seam for real-time.** Saving and sharing should notify other people, but SignalR
arrives in cap-07. Endpoints depend on an interface now; the do-nothing implementation is swapped
for the hub later without touching endpoint code. `api/BranchStory.Api/Realtime/IProjectEvents.cs`:

```csharp
namespace BranchStory.Api.Realtime;

/// <summary>
/// Side effects other people should hear about. The HTTP endpoints only raise events;
/// the SignalR implementation (cap-07) decides how to deliver them.
/// </summary>
public interface IProjectEvents
{
    Task DocSavedAsync(Guid projectId, int version, Guid savedBy, CancellationToken ct);
    Task MembershipChangedAsync(Guid projectId, Guid userId, CancellationToken ct);
}

/// <summary>Default until real-time lands: do nothing.</summary>
public sealed class NullProjectEvents : IProjectEvents
{
    public Task DocSavedAsync(Guid projectId, int version, Guid savedBy, CancellationToken ct) => Task.CompletedTask;
    public Task MembershipChangedAsync(Guid projectId, Guid userId, CancellationToken ct) => Task.CompletedTask;
}
```

**3. ETag helpers.** `api/BranchStory.Api/Features/Projects/ETags.cs`:

```csharp
using Microsoft.Extensions.Primitives;

namespace BranchStory.Api.Features.Projects;

/// <summary>The document version doubles as a strong ETag: "7" (with the quotes).</summary>
public static class ETags
{
    public static string Format(int version) => $"\"{version}\"";

    public static int? Parse(StringValues ifMatch)
    {
        var raw = ifMatch.ToString().Trim();
        // Weak tags can't guard writes (If-Match uses strong comparison). "*" or a list of
        // several tags isn't a single version either: all of these count as "no usable version".
        if (raw.StartsWith("W/", StringComparison.Ordinal)) return null;
        return int.TryParse(raw.Trim('"'), out var v) ? v : null;
    }
}
```

**4. Server-side graph rules.** The editor validates too (cap-06), but the server must not trust
it. `api/BranchStory.Api/Features/Projects/StoryDocRules.cs`:

```csharp
using BranchStory.Data;

namespace BranchStory.Api.Features.Projects;

/// <summary>
/// Structural rules the server enforces on every save. The editor gives friendlier hints
/// (orphans, dead ends), but these are the ones a buggy or hostile client must not break.
/// </summary>
public static class StoryDocRules
{
    public static Dictionary<string, string[]> Validate(StoryDoc? doc)
    {
        var errors = new Dictionary<string, List<string>>();
        void Add(string key, string msg) => (errors.TryGetValue(key, out var l) ? l : errors[key] = []).Add(msg);

        if (doc?.Nodes is null || doc.Edges is null)
        {
            Add("doc", "A document needs 'nodes' and 'edges' arrays.");
            return Flatten(errors);
        }

        var nodeIds = new HashSet<string>();
        foreach (var n in doc.Nodes)
        {
            if (string.IsNullOrWhiteSpace(n.Id)) Add("doc.nodes", "Every node needs an id.");
            else if (!nodeIds.Add(n.Id)) Add("doc.nodes", $"Duplicate node id '{n.Id}'.");
            if (n.Title?.Length > 120) Add("doc.nodes", $"Node '{n.Id}' title is longer than 120 characters.");
            if (n.MediaUrl is { Length: > 0 } url &&
                !(Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp)))
                Add("doc.nodes", $"Node '{n.Id}' mediaUrl must be an absolute http(s) URL.");
        }

        if (doc.StartNodeId is null || !nodeIds.Contains(doc.StartNodeId))
            Add("doc.startNodeId", "startNodeId must reference an existing node.");

        var edgeIds = new HashSet<string>();
        foreach (var e in doc.Edges)
        {
            if (string.IsNullOrWhiteSpace(e.Id) || !edgeIds.Add(e.Id)) Add("doc.edges", $"Edge ids must be unique and non-empty ('{e.Id}').");
            if (!nodeIds.Contains(e.From) || !nodeIds.Contains(e.To)) Add("doc.edges", $"Edge '{e.Id}' points at a node that doesn't exist.");
        }

        return Flatten(errors);
    }

    static Dictionary<string, string[]> Flatten(Dictionary<string, List<string>> e) =>
        e.ToDictionary(kv => kv.Key, kv => kv.Value.ToArray());
}
```

**5. New DTOs.** Replace `api/BranchStory.Api/Features/Projects/ProjectDtos.cs`:

```csharp
using System.ComponentModel.DataAnnotations;
using BranchStory.Data;

namespace BranchStory.Api.Features.Projects;

public sealed record CreateProjectRequest([Required, StringLength(120, MinimumLength = 1)] string Title);

public sealed record ProjectSummary(Guid Id, string Title, string Role, string OwnerName, int Version, DateTimeOffset UpdatedAt);

public sealed record ProjectDetail(Guid Id, string Title, string Role, Guid OwnerId, int Version, StoryDoc Doc, DateTimeOffset UpdatedAt);

/// <summary>PUT /api/projects/{id}/doc. ExpectedVersion may instead come as an If-Match header.</summary>
public sealed record SaveDocRequest([Required] StoryDoc Doc, int? ExpectedVersion);

public sealed record SaveDocResponse(int Version, DateTimeOffset UpdatedAt);
```

**6. The endpoints.** Replace `api/BranchStory.Api/Features/Projects/ProjectEndpoints.cs`. New:
a project quota in `CreateProject`, an `ETag` on `GetProject`, and `SaveDoc`, the compare-and-swap
done with `ExecuteUpdateAsync` (one `UPDATE … WHERE id = @id AND version = @expected`, no entity
loaded, no tracking):

```csharp
using BranchStory.Api.Auth;
using BranchStory.Api.Authorization;
using BranchStory.Api.Quotas;
using BranchStory.Api.Realtime;
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
        group.MapPut("/{id:guid}/doc", SaveDoc).WithName("SaveProjectDoc");
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

    static async Task<Results<Created<ProjectDetail>, ProblemHttpResult>> CreateProject(
        CreateProjectRequest req, CurrentUser currentUser, BranchStoryDbContext db, CancellationToken ct)
    {
        var me = await currentUser.GetAsync(ct);

        // The creator becomes the owner, so the creator's own plan is the one that pays.
        var limits = PlanLimits.For(me.Plan);
        var owned = await db.Projects.CountAsync(p => p.OwnerId == me.Id, ct);
        if (owned >= limits.MaxProjects) return QuotaProblems.Exceeded("projects", limits.MaxProjects, me.Plan);

        var project = new Project { OwnerId = me.Id, Title = req.Title.Trim() };
        db.Projects.Add(project);
        await db.SaveChangesAsync(ct);

        var dto = new ProjectDetail(project.Id, project.Title, "owner", me.Id, project.Version, project.Doc, project.UpdatedAt);
        return TypedResults.Created($"/api/projects/{project.Id}", dto);
    }

    static async Task<Results<Ok<ProjectDetail>, ProblemHttpResult>> GetProject(
        Guid id, ProjectGate gate, BranchStoryDbContext db, HttpContext http, CancellationToken ct)
    {
        var check = await gate.CheckAsync(id, ProjectRequirements.View, ct);
        if (check.Problem is { } problem) return problem;

        var p = await db.Projects.AsNoTracking().SingleAsync(x => x.Id == id, ct);
        http.Response.Headers.ETag = ETags.Format(p.Version);
        return TypedResults.Ok(new ProjectDetail(p.Id, p.Title, check.Access!.RoleName, p.OwnerId, p.Version, p.Doc, p.UpdatedAt));
    }

    static async Task<Results<Ok<SaveDocResponse>, ValidationProblem, ProblemHttpResult>> SaveDoc(
        Guid id, SaveDocRequest req, HttpContext http, ProjectGate gate, BranchStoryDbContext db,
        IProjectEvents events, CancellationToken ct)
    {
        var check = await gate.CheckAsync(id, ProjectRequirements.Edit, ct);
        if (check.Problem is { } problem) return problem;
        var access = check.Access!;

        // 1. Which version was this edit based on? Body wins; If-Match is the HTTP-native alternative.
        var viaIfMatch = req.ExpectedVersion is null;
        var expected = req.ExpectedVersion ?? ETags.Parse(http.Request.Headers.IfMatch);
        if (expected is null)
            return TypedResults.Problem(statusCode: StatusCodes.Status428PreconditionRequired,
                title: "Expected version required",
                detail: "Send 'expectedVersion' in the body or an If-Match: \"<version>\" header.");

        // 2. Quotas are the OWNER's, even when an editor on a bigger plan is saving.
        var limits = PlanLimits.For(access.OwnerPlan);
        if (req.Doc.Nodes?.Count > limits.MaxNodesPerStory)
            return QuotaProblems.Exceeded("scenes per story", limits.MaxNodesPerStory, access.OwnerPlan);

        // 3. Structural rules.
        var errors = StoryDocRules.Validate(req.Doc);
        if (errors.Count > 0) return TypedResults.ValidationProblem(errors);

        // 4. The compare-and-swap: one UPDATE, guarded by the version the client saw.
        var newVersion = expected.Value + 1;
        var now = DateTimeOffset.UtcNow;
        var updated = await db.Projects
            .Where(p => p.Id == id && p.Version == expected.Value)
            .ExecuteUpdateAsync(s => s
                .SetProperty(p => p.Doc, req.Doc)
                .SetProperty(p => p.Version, newVersion)
                .SetProperty(p => p.UpdatedAt, now), ct);

        if (updated == 0)
        {
            var current = await db.Projects.Where(p => p.Id == id).Select(p => (int?)p.Version).SingleOrDefaultAsync(ct);
            if (current is null) return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Project not found");
            http.Response.Headers.ETag = ETags.Format(current.Value);
            // RFC 9110: a failed If-Match precondition is 412. A stale body version is a 409 Conflict.
            return TypedResults.Problem(
                statusCode: viaIfMatch ? StatusCodes.Status412PreconditionFailed : StatusCodes.Status409Conflict,
                title: "Version conflict",
                detail: $"You edited version {expected}, but the project is now at version {current}. Reload, overwrite or merge.",
                extensions: new Dictionary<string, object?> { ["currentVersion"] = current.Value });
        }

        await events.DocSavedAsync(id, newVersion, access.UserId, ct);
        http.Response.Headers.ETag = ETags.Format(newVersion);
        return TypedResults.Ok(new SaveDocResponse(newVersion, now));
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

**7. Register the events seam.** In `Program.cs`, add `using BranchStory.Api.Realtime;` at the top
and, next to the other registrations:

```csharp
builder.Services.AddSingleton<IProjectEvents, NullProjectEvents>(); // replaced by SignalR in cap-07
```

**8. Make a conflict happen.**

```bash
dotnet run --project api/BranchStory.Api
```

```bash
TOKEN=$(curl -s -X POST localhost:5080/api/dev/token -H 'content-type: application/json' \
  -d '{"username":"ada"}' | jq -r .accessToken)
AUTH="authorization: Bearer $TOKEN"
ID=$(curl -s -X POST localhost:5080/api/projects -H "$AUTH" -H 'content-type: application/json' \
  -d '{"title":"Conflict lab"}' | jq -r .id)
DOC_A='{"startNodeId":"start","nodes":[{"id":"start","title":"From tab A","text":"","mediaUrl":null,"x":0,"y":0}],"edges":[]}'
DOC_B='{"startNodeId":"start","nodes":[{"id":"start","title":"From tab B","text":"","mediaUrl":null,"x":0,"y":0}],"edges":[]}'
JSON='content-type: application/json'

# Tab A and tab B both loaded version 1. Tab A saves first (-i shows the headers):
curl -si -X PUT localhost:5080/api/projects/$ID/doc -H "$AUTH" -H "$JSON" \
  -d "{\"doc\":$DOC_A,\"expectedVersion\":1}"
# HTTP/1.1 200 OK ... ETag: "2" ... {"version":2,"updatedAt":"..."}

# Tab B still believes it is editing version 1:
curl -s -X PUT localhost:5080/api/projects/$ID/doc -H "$AUTH" -H "$JSON" \
  -d "{\"doc\":$DOC_B,\"expectedVersion\":1}"
# {"type":"...","title":"Version conflict","status":409,...,"currentVersion":2}

# The stored document is still tab A's:
curl -s localhost:5080/api/projects/$ID -H "$AUTH" | jq '.version, .doc.nodes[0].title'
# 2
# "From tab A"

# The HTTP-native way: a stale If-Match is a 412.
curl -s -o /dev/null -w '%{http_code}\n' -X PUT localhost:5080/api/projects/$ID/doc -H "$AUTH" -H "$JSON" \
  -H 'If-Match: "1"' -d "{\"doc\":$DOC_B}"                                       # 412

# No version anywhere is refused before anything else is checked.
curl -s -o /dev/null -w '%{http_code}\n' -X PUT localhost:5080/api/projects/$ID/doc -H "$AUTH" -H "$JSON" \
  -d "{\"doc\":$DOC_B}"                                                         # 428

# A start scene that doesn't exist breaks a structural rule.
BAD='{"startNodeId":"ghost","nodes":[{"id":"start","title":"Hi","text":"","mediaUrl":null,"x":0,"y":0}],"edges":[]}'
curl -s -X PUT localhost:5080/api/projects/$ID/doc -H "$AUTH" -H "$JSON" \
  -d "{\"doc\":$BAD,\"expectedVersion\":2}" | jq '.status, .errors'
# 400
# { "doc.startNodeId": ["startNodeId must reference an existing node."] }
```

- [ ] `dotnet build` succeeds
- [ ] The first save returns `200` with `{"version":2,…}` and an `ETag: "2"` header
- [ ] The second, stale save returns `409` with `"currentVersion":2`, and the stored title is still "From tab A"
- [ ] A stale `If-Match: "1"` returns `412`
- [ ] A save without `expectedVersion` and without `If-Match` returns `428`
- [ ] A doc whose `startNodeId` points nowhere returns `400` with an `errors["doc.startNodeId"]` entry
:::

:::warn title="Load, modify, SaveChanges: the tempting bug"
This version *looks* equivalent:

```csharp
var p = await db.Projects.FindAsync([id], ct);
if (p!.Version != expected) return Conflict();
p.Doc = doc;
p.Version++;
await db.SaveChangesAsync(ct);
```

The `if` runs in C#, in your process, and the `UPDATE` runs later in the database. Between the
two, another request can read the same version, pass the same `if`, and save. Both requests
succeed and one edit is lost: the race you were trying to prevent. This code is only saved by a
detail from cap-02: `ProjectConfig` marks `Version` as `IsConcurrencyToken()`, so EF writes
`UPDATE … WHERE id = @id AND version = <the value it loaded>` and throws
`DbUpdateConcurrencyException` when that matches 0 rows. Remove that one line of configuration
and the bug comes back, silently. `ExecuteUpdateAsync` with the version in the `Where` makes the
guard visible right in the endpoint, takes one round trip instead of two, and reports a conflict
as "0 rows" instead of an exception.
:::

:::quiz id=cap-04-q2 xp=15
Ten requests save version 1 of the same project **at the same instant**. With
`ExecuteUpdateAsync(... Where(p => p.Id == id && p.Version == 1) ...)`, what is guaranteed?
- [ ] All ten succeed, the last one's doc is stored
- [ ] They all fail with 409, to be safe
- [x] Exactly one succeeds (version 2); the other nine match zero rows and get 409
- [ ] It depends on the transaction isolation level; under READ COMMITTED several can win
> Under READ COMMITTED (PostgreSQL's default), each UPDATE takes the row lock in turn. When a waiting UPDATE gets the lock, PostgreSQL re-evaluates its WHERE against the newly committed row, sees `version = 2`, and matches nothing. The isolation-level answer is tempting but wrong: no SERIALIZABLE is needed, because the single-row compare-and-swap is atomic at any level. (At REPEATABLE READ or higher the losers would get a serialization error instead of "0 rows", which you would then have to map to 409 yourself.) "All succeed" is what happens *without* the version predicate, and "all fail" never happens because the first one to get the lock still sees version 1. The test suite below fires exactly this scenario.
:::

:::quiz id=cap-04-q4 xp=15
Spot the bug. Imagine `Version` is **not** configured as a concurrency token in EF, and the save
handler is written like this:

```csharp
var p = await db.Projects.SingleAsync(x => x.Id == id, ct);
if (p.Version != req.ExpectedVersion) return TypedResults.Conflict();
p.Doc = req.Doc;
p.Version++;
await db.SaveChangesAsync(ct);
```

Two tabs send `expectedVersion: 3` at the same moment. What can happen?
- [ ] The second `SaveChangesAsync` throws `DbUpdateConcurrencyException`
- [x] Both read version 3, both pass the `if`, both write version 4, and one edit is silently lost
- [ ] PostgreSQL blocks the second `SELECT` until the first request has saved
- [ ] Nothing bad: `SaveChangesAsync` always runs in a SERIALIZABLE transaction
> The check runs in C# and the write runs later, so the two can interleave: a classic check-then-act race. EF only generates `UPDATE projects SET … WHERE id = @id`. The exception is tempting, but EF throws `DbUpdateConcurrencyException` only when a property *is* a concurrency token (cap-02 configures one, which is what makes the naive version safe there). A plain `SELECT` takes no row lock in PostgreSQL, and `SaveChangesAsync` never raises the isolation level: its UPDATE runs at the database default, READ COMMITTED (for a single statement EF Core doesn't even open an explicit transaction), not SERIALIZABLE.
:::

:::lab id=cap-04-lab2 xp=100
title: Sharing endpoints

**1. DTOs.** `api/BranchStory.Api/Features/Sharing/SharingDtos.cs`. `AllowedValues` (a
DataAnnotations attribute since .NET 8) restricts the role to the two seat types:

```csharp
using System.ComponentModel.DataAnnotations;

namespace BranchStory.Api.Features.Sharing;

public sealed record MemberDto(Guid UserId, string Email, string DisplayName, string Role);

public sealed record ShareRequest(
    [Required, EmailAddress, StringLength(320)] string Email,
    [Required, AllowedValues("editor", "viewer")] string Role);
```

**2. Endpoints.** `api/BranchStory.Api/Features/Sharing/SharingEndpoints.cs`. Note the seat quota
reads `access.OwnerPlan`, and `RemoveMember` has its own rule (owner, or yourself), so it uses
`FindAccessAsync` and decides explicitly:

```csharp
using BranchStory.Api.Authorization;
using BranchStory.Api.Quotas;
using BranchStory.Api.Realtime;
using BranchStory.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.EntityFrameworkCore;

namespace BranchStory.Api.Features.Sharing;

public static class SharingEndpoints
{
    /// <summary>Mapped under /api/projects/{id:guid}/members.</summary>
    public static RouteGroupBuilder MapSharingEndpoints(this RouteGroupBuilder group)
    {
        group.MapGet("/", ListMembers).WithName("ListMembers");
        group.MapPut("/", ShareProject).WithName("ShareProject");
        group.MapDelete("/{userId:guid}", RemoveMember).WithName("RemoveMember");
        return group;
    }

    static async Task<Results<Ok<List<MemberDto>>, ProblemHttpResult>> ListMembers(
        Guid id, ProjectGate gate, BranchStoryDbContext db, CancellationToken ct)
    {
        var check = await gate.CheckAsync(id, ProjectRequirements.View, ct);
        if (check.Problem is { } problem) return problem;

        var owner = await db.Users.Where(u => u.Id == check.Access!.OwnerId)
            .Select(u => new MemberDto(u.Id, u.Email, u.DisplayName, "owner"))
            .SingleAsync(ct);
        var members = await db.ProjectMembers.Where(m => m.ProjectId == id)
            .OrderBy(m => m.AddedAt)
            .Select(m => new MemberDto(m.UserId, m.User.Email, m.User.DisplayName, m.Role))
            .ToListAsync(ct);
        return TypedResults.Ok((List<MemberDto>)[owner, .. members]);
    }

    /// <summary>Adds a collaborator, or changes their role. Owner only. Idempotent (PUT).</summary>
    static async Task<Results<Ok<MemberDto>, ProblemHttpResult>> ShareProject(
        Guid id, ShareRequest req, ProjectGate gate, BranchStoryDbContext db, IProjectEvents events, CancellationToken ct)
    {
        var check = await gate.CheckAsync(id, ProjectRequirements.Own, ct);
        if (check.Problem is { } problem) return problem;
        var access = check.Access!;

        var email = req.Email.Trim().ToLowerInvariant();
        var invitee = await db.Users.SingleOrDefaultAsync(u => u.Email == email, ct);
        if (invitee is null)
            return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Unknown user",
                detail: "Nobody with that email has signed in to BranchStory yet.");
        if (invitee.Id == access.OwnerId)
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "You already own this project");

        var member = await db.ProjectMembers.SingleOrDefaultAsync(m => m.ProjectId == id && m.UserId == invitee.Id, ct);
        if (member is null)
        {
            // Seats are billed to the owner's plan.
            var limits = PlanLimits.For(access.OwnerPlan);
            var seats = await db.ProjectMembers.CountAsync(m => m.ProjectId == id, ct);
            if (seats >= limits.MaxMembersPerProject)
                return QuotaProblems.Exceeded("collaborators per project", limits.MaxMembersPerProject, access.OwnerPlan);

            member = new ProjectMember { ProjectId = id, UserId = invitee.Id, Role = req.Role };
            db.ProjectMembers.Add(member);
        }
        else member.Role = req.Role;

        await db.SaveChangesAsync(ct);
        await events.MembershipChangedAsync(id, invitee.Id, ct);
        return TypedResults.Ok(new MemberDto(invitee.Id, invitee.Email, invitee.DisplayName, member.Role));
    }

    /// <summary>The owner can remove anyone; a member can remove themselves ("leave").</summary>
    static async Task<Results<NoContent, ProblemHttpResult>> RemoveMember(
        Guid id, Guid userId, ProjectGate gate, BranchStoryDbContext db, IProjectEvents events, CancellationToken ct)
    {
        var access = await gate.FindAccessAsync(id, ct);
        if (access is null) return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Project not found");
        if (access.Role != ProjectRole.Owner && access.UserId != userId)
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the owner can remove other people");

        var removed = await db.ProjectMembers.Where(m => m.ProjectId == id && m.UserId == userId).ExecuteDeleteAsync(ct);
        if (removed == 0) return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "Not a member");

        await events.MembershipChangedAsync(id, userId, ct);
        return TypedResults.NoContent();
    }
}
```

**3. Final `Program.cs`** for this milestone. The sharing group is mounted at
`/projects/{id:guid}/members`, so its handlers receive `id` from the route:

```csharp
using BranchStory.Api.Auth;
using BranchStory.Api.Authorization;
using BranchStory.Api.Features.Projects;
using BranchStory.Api.Features.Sharing;
using BranchStory.Api.Health;
using BranchStory.Api.Realtime;
using BranchStory.Data;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddBranchStoryDb();
builder.Services.AddBranchStoryAuth();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ProjectGate>();
builder.Services.AddSingleton<IAuthorizationHandler, ProjectRoleHandler>();
builder.Services.AddSingleton<IProjectEvents, NullProjectEvents>(); // replaced by SignalR in cap-07

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
api.MapGroup("/projects/{id:guid}/members").WithTags("Sharing").MapSharingEndpoints();

app.Run();

public partial class Program;
```

**4. Try it with two users.**

```bash
tok() { curl -s -X POST localhost:5080/api/dev/token -H 'content-type: application/json' \
  -d "{\"username\":\"$1\"}" | jq -r .accessToken; }
ADA=$(tok ada); BEN=$(tok ben)
curl -s localhost:5080/api/me -H "authorization: Bearer $BEN"     # Ben must have signed in once
ID=$(curl -s -X POST localhost:5080/api/projects -H "authorization: Bearer $ADA" \
  -H 'content-type: application/json' -d '{"title":"Shared tale"}' | jq -r .id)

curl -si localhost:5080/api/projects/$ID -H "authorization: Bearer $BEN" | head -1   # 404
curl -s -X PUT localhost:5080/api/projects/$ID/members -H "authorization: Bearer $ADA" \
  -H 'content-type: application/json' -d '{"email":"ben@branchstory.test","role":"viewer"}'
curl -si localhost:5080/api/projects/$ID -H "authorization: Bearer $BEN" | head -1   # 200 now
curl -s localhost:5080/api/projects/$ID/members -H "authorization: Bearer $BEN"     # Ada (owner), then Ben
curl -s localhost:5080/api/projects -H "authorization: Bearer $BEN"   # Ben sees it as "viewer"
```

Now the negative cases. Two more people sign in once so they exist:

```bash
EVE=$(tok eve); FAY=$(tok fay)
curl -s localhost:5080/api/me -H "authorization: Bearer $EVE" > /dev/null
curl -s localhost:5080/api/me -H "authorization: Bearer $FAY" > /dev/null
code() { curl -s -o /dev/null -w '%{http_code}\n' "$@"; }    # print only the status code

# A viewer may not share: 403 (he is a member, just not the owner)
code -X PUT localhost:5080/api/projects/$ID/members -H "authorization: Bearer $BEN" \
  -H 'content-type: application/json' -d '{"email":"eve@branchstory.test","role":"viewer"}'   # 403

# Seat 2 of 2 on Ada's free plan works ...
code -X PUT localhost:5080/api/projects/$ID/members -H "authorization: Bearer $ADA" \
  -H 'content-type: application/json' -d '{"email":"eve@branchstory.test","role":"editor"}'   # 200
# ... seat 3 is over the limit
curl -s -X PUT localhost:5080/api/projects/$ID/members -H "authorization: Bearer $ADA" \
  -H 'content-type: application/json' -d '{"email":"fay@branchstory.test","role":"viewer"}' | jq '.status, .type'
# 403
# "https://branchstory.dev/problems/plan-limit"

# Ben leaves the project with his own token, and is locked out on the very next request
BEN_ID=$(curl -s localhost:5080/api/me -H "authorization: Bearer $BEN" | jq -r .id)
code -X DELETE localhost:5080/api/projects/$ID/members/$BEN_ID -H "authorization: Bearer $BEN"   # 204
code localhost:5080/api/projects/$ID -H "authorization: Bearer $BEN"                             # 404
```

- [ ] Before sharing, Ben gets `404` for Ada's project; after, `200` with `"role":"viewer"`
- [ ] `GET …/members` lists Ada as `owner` first, then Ben
- [ ] Ben (viewer) gets `403` when he tries to share the project with Eve
- [ ] Sharing with Eve (the 2nd seat) returns `200`; sharing with Fay (a 3rd seat, over the free limit of 2) returns `403` with `"type":"https://branchstory.dev/problems/plan-limit"`
- [ ] `DELETE …/members/{benId}` with Ben's own token returns `204`, and his next `GET` of the project is `404`
:::

:::sql id=cap-04-sql1 db=empty xp=40
title: A seat quota inside the INSERT
Dan (`'dan'`) should be added as a `viewer` to projects `p1` and `p2`, but **only where the
owner's plan has a free seat** (`plan_limits.max_members` counts `project_members` rows of that
project). `p1` is owned by Ada (free, already full); `p2` by Bob (pro). Write the `INSERT … SELECT`
that adds only the seats the owners can pay for.

hint: Select from `projects p JOIN users o ON o.id = p.owner_id JOIN plan_limits l ON l.plan = o.plan`.
hint: Filter with `p.id IN ('p1', 'p2') AND (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) < l.max_members`.

```sql setup
CREATE TABLE plan_limits (plan text PRIMARY KEY, max_members int NOT NULL);
INSERT INTO plan_limits VALUES ('free', 2), ('pro', 25);
CREATE TABLE users (id text PRIMARY KEY, email text NOT NULL UNIQUE, plan text NOT NULL REFERENCES plan_limits(plan));
CREATE TABLE projects (id text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), title text NOT NULL);
CREATE TABLE project_members (project_id text REFERENCES projects(id), user_id text REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('editor', 'viewer')), PRIMARY KEY (project_id, user_id));
INSERT INTO users VALUES ('ada', 'ada@x.test', 'free'), ('bob', 'bob@x.test', 'pro'), ('dan', 'dan@x.test', 'free'),
  ('e1', 'e1@x.test', 'free'), ('e2', 'e2@x.test', 'free'), ('f1', 'f1@x.test', 'free');
INSERT INTO projects VALUES ('p1', 'ada', 'Lost Key'), ('p2', 'bob', 'Night Train');
INSERT INTO project_members VALUES ('p1', 'e1', 'editor'), ('p1', 'e2', 'viewer'), ('p2', 'f1', 'editor');
```

```sql starter
INSERT INTO project_members (project_id, user_id, role)
VALUES ('p1', 'dan', 'viewer'), ('p2', 'dan', 'viewer');
```

```sql solution
INSERT INTO project_members (project_id, user_id, role)
SELECT p.id, 'dan', 'viewer'
FROM projects p
JOIN users o ON o.id = p.owner_id
JOIN plan_limits l ON l.plan = o.plan
WHERE p.id IN ('p1', 'p2')
  AND (SELECT count(*) FROM project_members m WHERE m.project_id = p.id) < l.max_members;
```

```sql check
SELECT project_id, user_id, role FROM project_members ORDER BY project_id, user_id;
```
:::

:::warn title="Check-then-act is still a race"
The API (and the SQL above) counts seats, then inserts. Under READ COMMITTED two concurrent invites
can both count 1 and both insert, ending at 3 of 2. (Even a single `INSERT … SELECT` doesn't help:
each statement's snapshot can't see the other's uncommitted row.) For seats that is a tolerable,
self-limiting overshoot. Where it is not (money, credits), serialize per owner: start a transaction and
`SELECT … FROM users WHERE id = @owner FOR UPDATE` before counting, or keep a counter column with
`CHECK (used <= quota)` and `UPDATE … SET used = used + 1` so the database refuses the overshoot.
:::

:::quiz id=cap-04-q5 xp=15
Ada's free project has 1 collaborator (limit 2). From two browser tabs she invites two *different*
people, and both requests reach the API at the same instant. With the count-then-insert code in
`ShareProject` under READ COMMITTED, what is possible?
- [ ] Exactly one invite succeeds, because the `SaveChangesAsync` calls are serialized by the row lock
- [x] Both count 1 seat, both pass the check, and the project ends up with 3 collaborators
- [ ] Both fail with 409, like a version conflict
- [ ] The second insert fails with a primary-key violation
> The two requests insert *different* rows, so no row lock or primary key ever brings them into contact, and nothing in this code produces a 409. Each one counts the committed seats (1), passes the check and inserts. The primary-key violation is tempting, but it only happens when the same person is invited twice. To make a limit exact, serialize on something both requests must touch: a `FOR UPDATE` lock on the owner row, or a counter column with a `CHECK` constraint.
:::

:::lab id=cap-04-lab3 xp=120
title: Prove it, under real concurrency

These tests reuse `ApiFactory` from cap-03. They add 16 cases: concurrency, sharing, quotas and
pure unit tests for the graph rules.

**1. Test helpers.** `tests/BranchStory.Api.Tests/TestApi.cs`:

```csharp
using System.Net.Http.Json;
using BranchStory.Api.Features.Projects;
using BranchStory.Data;
using Microsoft.EntityFrameworkCore;

namespace BranchStory.Api.Tests;

/// <summary>Small helpers so tests read like the scenario they prove.</summary>
public static class TestApi
{
    public static async Task<ProjectDetail> CreateProjectAsync(this TestUser user, string title = "Story")
    {
        var res = await user.Client.PostAsJsonAsync("/api/projects", new CreateProjectRequest(title));
        res.EnsureSuccessStatusCode();
        return (await res.Content.ReadFromJsonAsync<ProjectDetail>())!;
    }

    public static Task<HttpResponseMessage> SaveDocAsync(this TestUser user, Guid projectId, StoryDoc doc, int? expectedVersion) =>
        user.Client.PutAsJsonAsync($"/api/projects/{projectId}/doc", new SaveDocRequest(doc, expectedVersion));

    public static Task<HttpResponseMessage> ShareAsync(this TestUser owner, Guid projectId, TestUser with, string role) =>
        owner.Client.PutAsJsonAsync($"/api/projects/{projectId}/members", new { email = with.Email, role });

    public static Task SetPlanAsync(this ApiFactory api, TestUser user, string plan) =>
        api.WithDbAsync(db => db.Users.Where(u => u.Id == user.Id).ExecuteUpdateAsync(s => s.SetProperty(u => u.Plan, plan)));

    /// <summary>A valid doc with a start scene and <paramref name="extraScenes"/> more, chained by choices.</summary>
    public static StoryDoc Doc(int extraScenes = 1, string startTitle = "Start")
    {
        var nodes = new List<StoryNode> { new("start", startTitle, "It begins.", null, 0, 0) };
        var edges = new List<StoryEdge>();
        for (var i = 1; i <= extraScenes; i++)
        {
            nodes.Add(new($"n{i}", $"Scene {i}", "...", null, i * 200, 0));
            edges.Add(new($"e{i}", i == 1 ? "start" : $"n{i - 1}", $"n{i}", $"Go to {i}"));
        }
        return new StoryDoc("start", nodes, edges);
    }
}
```

**2. Concurrency.** `tests/BranchStory.Api.Tests/ConcurrencyTests.cs`. The third test fires ten
saves of version 1 in parallel and demands exactly one winner:

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using BranchStory.Api.Features.Projects;
using BranchStory.Data;

namespace BranchStory.Api.Tests;

public sealed class ConcurrencyTests(ApiFactory api)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Save_with_the_current_version_bumps_it()
    {
        var ada = await api.SignInAsync("ada");
        var project = await ada.CreateProjectAsync();

        var res = await ada.SaveDocAsync(project.Id, TestApi.Doc(2), expectedVersion: 1);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var body = await res.Content.ReadFromJsonAsync<SaveDocResponse>(Ct);
        Assert.Equal(2, body!.Version);
        Assert.Equal("\"2\"", res.Headers.ETag?.Tag);
        var reloaded = await ada.Client.GetFromJsonAsync<ProjectDetail>($"/api/projects/{project.Id}", Ct);
        Assert.Equal(3, reloaded!.Doc.Nodes.Count);
    }

    [Fact]
    public async Task Stale_save_is_refused_with_409_and_the_current_version()
    {
        var ada = await api.SignInAsync("ada");
        var project = await ada.CreateProjectAsync();
        // Two tabs both loaded version 1. Tab A saves first.
        var first = await ada.SaveDocAsync(project.Id, TestApi.Doc(1, startTitle: "Tab A"), expectedVersion: 1);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        // Tab B still believes it is editing version 1.
        var stale = await ada.SaveDocAsync(project.Id, TestApi.Doc(1, startTitle: "Tab B"), expectedVersion: 1);

        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        var problem = await stale.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal(2, problem.GetProperty("currentVersion").GetInt32());
        var stored = await ada.Client.GetFromJsonAsync<ProjectDetail>($"/api/projects/{project.Id}", Ct);
        Assert.Equal("Tab A", stored!.Doc.Nodes[0].Title); // B did NOT clobber A
        Assert.Equal(2, stored.Version);
    }

    [Fact]
    public async Task Of_ten_simultaneous_saves_exactly_one_wins()
    {
        var ada = await api.SignInAsync("ada");
        var project = await ada.CreateProjectAsync();

        var saves = Enumerable.Range(0, 10)
            .Select(i => ada.SaveDocAsync(project.Id, TestApi.Doc(1, startTitle: $"Writer {i}"), expectedVersion: 1));
        var results = await Task.WhenAll(saves);

        Assert.Equal(1, results.Count(r => r.StatusCode == HttpStatusCode.OK));
        Assert.Equal(9, results.Count(r => r.StatusCode == HttpStatusCode.Conflict));
    }

    [Fact]
    public async Task If_Match_works_a_stale_one_is_412_and_a_missing_version_is_428()
    {
        var ada = await api.SignInAsync("ada");
        var project = await ada.CreateProjectAsync();
        var get = await ada.Client.GetAsync($"/api/projects/{project.Id}", Ct);
        var etag = get.Headers.ETag!.Tag; // "\"1\""

        var withoutVersion = await ada.SaveDocAsync(project.Id, TestApi.Doc(), expectedVersion: null);
        var request = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{project.Id}/doc")
        {
            Content = JsonContent.Create(new { doc = TestApi.Doc() }),
        };
        request.Headers.TryAddWithoutValidation("If-Match", etag);
        var withIfMatch = await ada.Client.SendAsync(request, Ct);

        Assert.Equal((HttpStatusCode)428, withoutVersion.StatusCode);
        Assert.Equal(HttpStatusCode.OK, withIfMatch.StatusCode);
        Assert.Equal("\"2\"", withIfMatch.Headers.ETag?.Tag);

        // Replaying the same, now stale, If-Match fails the precondition.
        var replay = new HttpRequestMessage(HttpMethod.Put, $"/api/projects/{project.Id}/doc")
        {
            Content = JsonContent.Create(new { doc = TestApi.Doc() }),
        };
        replay.Headers.TryAddWithoutValidation("If-Match", etag);
        var stale = await ada.Client.SendAsync(replay, Ct);
        Assert.Equal(HttpStatusCode.PreconditionFailed, stale.StatusCode);
    }

    [Fact]
    public async Task Broken_graph_is_a_validation_problem_and_does_not_bump_the_version()
    {
        var ada = await api.SignInAsync("ada");
        var project = await ada.CreateProjectAsync();
        var broken = new StoryDoc("nope",
            [new StoryNode("a", "A", "", null, 0, 0)],
            [new StoryEdge("e1", "a", "ghost", "Into the void")]);

        var res = await ada.SaveDocAsync(project.Id, broken, expectedVersion: 1);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
        var problem = await res.Content.ReadFromJsonAsync<JsonElement>(Ct);
        var errors = problem.GetProperty("errors");
        Assert.True(errors.TryGetProperty("doc.startNodeId", out _));
        Assert.True(errors.TryGetProperty("doc.edges", out _));
        var stored = await ada.Client.GetFromJsonAsync<ProjectDetail>($"/api/projects/{project.Id}", Ct);
        Assert.Equal(1, stored!.Version);
    }
}
```

**3. Sharing and quotas.** `tests/BranchStory.Api.Tests/SharingTests.cs`. The key test is
`A_pro_editor_cannot_exceed_a_free_owners_scene_limit`: the caller's own plan is irrelevant.

```csharp
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using BranchStory.Api.Features.Sharing;
using BranchStory.Data;

namespace BranchStory.Api.Tests;

public sealed class SharingTests(ApiFactory api)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task Editor_can_save_viewer_can_only_read()
    {
        var ada = await api.SignInAsync("ada");
        var ed = await api.SignInAsync("ed");
        var vic = await api.SignInAsync("vic");
        var project = await ada.CreateProjectAsync();
        Assert.Equal(HttpStatusCode.OK, (await ada.ShareAsync(project.Id, ed, "editor")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await ada.ShareAsync(project.Id, vic, "viewer")).StatusCode);

        var edSave = await ed.SaveDocAsync(project.Id, TestApi.Doc(), expectedVersion: 1);
        var vicSave = await vic.SaveDocAsync(project.Id, TestApi.Doc(), expectedVersion: 2);
        var vicRead = await vic.Client.GetAsync($"/api/projects/{project.Id}", Ct);

        Assert.Equal(HttpStatusCode.OK, edSave.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, vicSave.StatusCode);
        Assert.Equal(HttpStatusCode.OK, vicRead.StatusCode);
        var members = await vic.Client.GetFromJsonAsync<List<MemberDto>>($"/api/projects/{project.Id}/members", Ct);
        Assert.Equal(["owner", "editor", "viewer"], members!.Select(m => m.Role));
    }

    [Fact]
    public async Task Only_the_owner_can_share()
    {
        var ada = await api.SignInAsync("ada");
        var ed = await api.SignInAsync("ed");
        var eve = await api.SignInAsync("eve");
        var project = await ada.CreateProjectAsync();
        await ada.ShareAsync(project.Id, ed, "editor");

        var res = await ed.ShareAsync(project.Id, eve, "editor");

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
    }

    [Fact]
    public async Task Seats_are_limited_by_the_owners_plan()
    {
        var ada = await api.SignInAsync("ada");           // free: 2 collaborators per project
        var people = new List<TestUser>();
        for (var i = 0; i < 3; i++) people.Add(await api.SignInAsync($"p{i}"));
        var project = await ada.CreateProjectAsync();

        Assert.Equal(HttpStatusCode.OK, (await ada.ShareAsync(project.Id, people[0], "viewer")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await ada.ShareAsync(project.Id, people[1], "viewer")).StatusCode);
        var third = await ada.ShareAsync(project.Id, people[2], "viewer");
        Assert.Equal(HttpStatusCode.Forbidden, third.StatusCode);
        var problem = await third.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("https://branchstory.dev/problems/plan-limit", problem.GetProperty("type").GetString());

        await api.SetPlanAsync(ada, Plans.Pro);
        Assert.Equal(HttpStatusCode.OK, (await ada.ShareAsync(project.Id, people[2], "viewer")).StatusCode);
    }

    [Fact]
    public async Task A_pro_editor_cannot_exceed_a_free_owners_scene_limit()
    {
        var ada = await api.SignInAsync("ada");           // free owner: 50 scenes
        var pat = await api.SignInAsync("pat");
        await api.SetPlanAsync(pat, Plans.Pro);           // the editor pays for pro, but doesn't own the project
        var project = await ada.CreateProjectAsync();
        await ada.ShareAsync(project.Id, pat, "editor");

        var res = await pat.SaveDocAsync(project.Id, TestApi.Doc(extraScenes: 50), expectedVersion: 1); // 51 scenes

        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        var problem = await res.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("free", problem.GetProperty("plan").GetString());
    }

    [Fact]
    public async Task Free_owners_can_own_three_projects()
    {
        var ada = await api.SignInAsync("ada");
        for (var i = 0; i < 3; i++) await ada.CreateProjectAsync($"Story {i}");

        var fourth = await ada.Client.PostAsJsonAsync("/api/projects", new { title = "One too many" }, Ct);

        Assert.Equal(HttpStatusCode.Forbidden, fourth.StatusCode);
    }

    [Fact]
    public async Task Removing_a_member_revokes_access_and_members_can_leave()
    {
        var ada = await api.SignInAsync("ada");
        var ed = await api.SignInAsync("ed");
        var vic = await api.SignInAsync("vic");
        var project = await ada.CreateProjectAsync();
        await ada.ShareAsync(project.Id, ed, "editor");
        await ada.ShareAsync(project.Id, vic, "viewer");

        var kick = await ada.Client.DeleteAsync($"/api/projects/{project.Id}/members/{ed.Id}", Ct);
        var leave = await vic.Client.DeleteAsync($"/api/projects/{project.Id}/members/{vic.Id}", Ct);

        Assert.Equal(HttpStatusCode.NoContent, kick.StatusCode);
        Assert.Equal(HttpStatusCode.NoContent, leave.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await ed.Client.GetAsync($"/api/projects/{project.Id}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await vic.Client.GetAsync($"/api/projects/{project.Id}", Ct)).StatusCode);
    }
}
```

**4. Unit tests for the rules.** `tests/BranchStory.Api.Tests/StoryDocRulesTests.cs`:

```csharp
using BranchStory.Api.Features.Projects;
using BranchStory.Data;

namespace BranchStory.Api.Tests;

/// <summary>Pure unit tests: no container, no HTTP. Milliseconds.</summary>
public sealed class StoryDocRulesTests
{
    [Fact]
    public void Starter_doc_is_valid() => Assert.Empty(StoryDocRules.Validate(StoryDoc.Starter()));

    [Fact]
    public void Missing_start_is_reported()
    {
        var doc = new StoryDoc(null, [new StoryNode("a", "A", "", null, 0, 0)], []);
        Assert.Contains("doc.startNodeId", StoryDocRules.Validate(doc).Keys);
    }

    [Fact]
    public void Duplicate_node_ids_are_reported()
    {
        var doc = new StoryDoc("a", [new StoryNode("a", "A", "", null, 0, 0), new StoryNode("a", "B", "", null, 0, 0)], []);
        Assert.Contains("doc.nodes", StoryDocRules.Validate(doc).Keys);
    }

    [Theory]
    [InlineData("javascript:alert(1)")]
    [InlineData("/relative/clip.mp4")]
    public void Media_urls_must_be_absolute_http(string url)
    {
        var doc = new StoryDoc("a", [new StoryNode("a", "A", "", url, 0, 0)], []);
        Assert.Contains("doc.nodes", StoryDocRules.Validate(doc).Keys);
    }
}
```

**5. Run everything, then break it on purpose.**

```bash
dotnet test tests/BranchStory.Api.Tests
```

Now remove `&& p.Version == expected.Value` from the `Where` in `SaveDoc` and run again. Then
change `PlanLimits.For(access.OwnerPlan)` to use the **caller's** plan (load it via `CurrentUser`)
and run again. Revert both.

- [ ] `dotnet test` reports 25 passed (9 from cap-03 + 16 new)
- [ ] Without the version predicate, `Stale_save_is_refused…`, `Of_ten_simultaneous_saves…` and `If_Match_works…` (the stale replay now gets 200 instead of 412) fail
- [ ] Billing the caller instead of the owner makes `A_pro_editor_cannot_exceed_a_free_owners_scene_limit` fail
- [ ] `dotnet test --filter StoryDocRulesTests` runs just the 5 rule cases (and you can explain why the container still starts: assembly fixtures are created up front, one reason cap-09 gives pure unit tests their own project)
:::

:::pro title="Beyond reject-on-conflict"
Real-time editors (Figma, Google Docs) avoid most conflicts by streaming small operations and
merging them, with OT or CRDTs (Yjs, Automerge). BranchStory takes the pragmatic middle road used by
many SaaS editors: live patches between open sessions for awareness (cap-07), and the versioned
whole-document save as the authority. If you ever need true offline merging, a CRDT can replace
the `doc` payload while the version check keeps guarding the row.
:::

:::job title="Quota bugs are revenue bugs"
On a SaaS team, "a free user can exceed their limit by sharing with a paid user" is filed as a
billing incident, not a minor bug. Expect reviewers to ask *whose* plan every limit check reads,
and to want a test that proves it, exactly like the one you just wrote.
:::

:::quiz id=cap-04-q3 xp=15
Why are BranchStory's quotas read from the **owner's** plan rather than from the caller's?
Select all that apply.
- [x] A free owner could otherwise invite a Pro friend as editor and use the Pro limits
- [x] The same save would pass or fail depending on who clicked it, which is confusing and untestable
- [x] The owner is the one who pays for the project, so usage must be attributed to them
- [ ] Callers' plans cannot be read inside an API request
> Bill one account per resource and check limits against that account. It closes the "borrow a friend's plan" loophole, attributes usage to the person who pays, and makes behaviour deterministic for every collaborator. The last option is simply false: `CurrentUser` loads the caller's plan just as easily (the lab even asks you to do that on purpose, to watch a test fail). The choice is a business rule, not a technical limitation.
:::

:::cards id=cap-04-cards1 xp=15 title="Concurrency & sharing"
Q: What is a lost update?
A: Two clients read the same version, both write; the second write silently replaces the first.
Q: The optimistic-concurrency UPDATE?
A: `UPDATE projects SET doc=@doc, version=@v+1 WHERE id=@id AND version=@v` – 0 rows affected means conflict.
Q: 409 vs 412 vs 428?
A: 409: stale expectedVersion in the body. 412: failed If-Match header. 428: no version sent at all.
Q: What does the 409 body carry?
A: A ProblemDetails with `currentVersion`, so the client can reload, overwrite or merge.
Q: Why `ExecuteUpdateAsync` for the save?
A: One round trip, the guard is explicit in the WHERE, no tracked entity and no exception-driven flow.
Q: Whose plan do quota checks read?
A: Always the project owner's (`ProjectAccess.OwnerPlan`), never the caller's.
Q: How fast is a removed member locked out?
A: Next request: membership is read from the database on every call, not cached in the token.
Q: Why the `IProjectEvents` interface?
A: Endpoints raise "doc saved" / "membership changed"; cap-07 plugs in SignalR without touching them.
Q: ETag and If-Match in one sentence each?
A: ETag: a response header naming the version of a resource (`"7"`). If-Match: a request header saying "apply this write only if the current ETag is still this one".
Q: Non-member vs viewer calling an owner-only endpoint?
A: Non-member: 404 (don't reveal the project exists). Viewer: 403 (known member, role too low).
Q: Why can a count-then-insert quota overshoot?
A: Two concurrent requests both count the same committed rows, both pass, both insert. Fix with a lock on a shared row (`FOR UPDATE`) or a counter column with a `CHECK`.
:::

## Recap

- Saves carry `expectedVersion` (or `If-Match`); one guarded `UPDATE` makes exactly one concurrent writer win.
- Stale body version → 409 with `currentVersion`; stale `If-Match` → 412; no version → 428; `GET` returns an `ETag`.
- The server validates graph structure itself; clients are helpful, not trusted.
- Sharing = seats in `project_members`, managed by the owner; membership is re-read on every HTTP request.
- Every limit (projects, scenes, seats, publishes) is billed to the **owner's** plan, and tests prove it.
- `IProjectEvents` is the seam where real-time (cap-07) plugs in.
