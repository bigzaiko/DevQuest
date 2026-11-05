---
id: fe-24
title: Real-time & Resilient UI
level: expert
minutes: 65
xp: 230
summary: Optimistic UI that survives collaboration — 409 conflicts and versions, useOptimistic, WebSockets vs SSE vs SignalR, presence, reconnection with backoff and an offline queue.
---

A collaborative SaaS — a project board, a shared document, a ticket tracker — has three problems a
simple CRUD app never meets:

1. **Latency.** The network takes 100–800 ms. If every click waits for the server, the app feels sluggish.
2. **Concurrency.** Two people edit the same card at the same time. Whose change wins? Does anyone even notice?
3. **Unreliable connections.** Laptops sleep, trains enter tunnels, Wi-Fi drops. Real-time connections die
   and must come back without losing data.

This lesson is the frontend half of the answer. The backend half (EF Core concurrency tokens, SignalR hubs)
lives in the backend track; here we build the client logic that makes it feel solid.

## Optimistic updates, one level up

You already know the mechanics. **Server State with TanStack Query** taught the four steps — *cancel, snapshot,
apply, roll back on error*, then *re-sync* with `onSettled` — and when not to be optimistic at all. If those
steps aren't automatic yet, revisit that lesson first; this one doesn't repeat them.

What changes in a collaborative app is **why** a mutation fails. In a single-user CRUD app a failed optimistic
write is almost always the network, so "roll back and toast" is the whole story. On a shared board there are two
very different failures:

| Failure | What happened | Right reaction |
|---|---|---|
| Network / 5xx | The server never applied your change | Roll back, tell the user, offer *Retry* (or queue it — see "Offline queue") |
| **409 Conflict** | The server is fine; someone else changed the row first | Roll back **and** show *their* version so the user can decide |

So the optimistic mutation on a shared board carries one extra field — the `version` the user was looking at —
and its `onError` branches on the status:

```ts
const moveCard = useMutation({
  mutationFn: (v: { cardId: string; toColumn: string; version: number }) => api.moveCard(v),
  onMutate: (v) => applyOptimisticMove(queryClient, boardId, v),   // cancel + snapshot + apply, as in Server State
  onError: (err, v, ctx) => {
    queryClient.setQueryData(['board', boardId], ctx?.previous)     // always roll back first
    if (err instanceof ApiError && err.status === 409) {
      openConflictDialog(err.body)            // not a toast: the user must choose (next section)
    } else {
      toast.error('Could not move the card', { action: { label: 'Retry', onClick: () => moveCard.mutate(v) } })
    }
  },
  onSettled: () => queryClient.invalidateQueries({ queryKey: ['board', boardId] }),
})
```

The rest of this section adds the piece the server-state lesson didn't cover: optimism **without** a data library.

### `useOptimistic`: optimism built into React 19

React 19 ships `useOptimistic(state, updateFn?)`. It works inside
an **Action** — React 19's name for an async function run in a transition (`startTransition(async () => …)` or a
`<form action={…}>`). While the Action is pending, the component shows the optimistic value; when it finishes,
React drops the optimistic value and shows whatever `state` is *now*. That is the big mental shift from the
TanStack version: **there is no rollback step**, because the "real" state was never touched.

```tsx
import { startTransition, useOptimistic } from 'react'

function LikeButton({ liked, setLiked }: { liked: boolean; setLiked: (next: boolean) => Promise<void> }) {
  const [shownLiked, setShownLiked] = useOptimistic(liked)
  return (
    <button aria-pressed={shownLiked} onClick={() => startTransition(async () => {
      setShownLiked(!shownLiked)   // instant feedback
      try {
        await setLiked(!shownLiked)  // server call; the parent updates `liked` on success
      } catch {
        showToast('Could not save your like')  // your toast helper; don't let the error escape the Action
      }
    })}>
      {shownLiked ? 'Liked' : 'Like'}
    </button>
  )
}
```

On failure (caught inside the Action, so it doesn't reach an error boundary or surface as an uncaught error — React
19 rethrows errors from Actions) there is nothing to undo: `liked` never changed, so the button snaps back by
itself. The flip side is a
common mistake — if the parent *doesn't* update `liked` after a successful save (say, it forgets to refetch), the
button also snaps back on success, because the optimistic value is always temporary.

The reducer form, `useOptimistic(items, (current, newItem) => [...current, newItem])`, is the one you'll use for
lists: each pending Action adds its item on top of the real list, and several pending Actions stack. Mark the
optimistic rows (`{ ...newItem, pending: true }`) so you can render them greyed out until the server confirms.

| Use | When |
|---|---|
| TanStack `onMutate` + `setQueryData` | The data lives in the query cache and **several components** show it (board column + card count + sidebar) |
| `mutation.variables` while `isPending` | One component shows the pending change; no cache surgery needed |
| `useOptimistic` | No data library, form Actions, or local state owned by a parent; you want React to discard the guess for you |

:::quiz id=fe-24-q1 xp=10
A `LikeButton` uses `useOptimistic(liked)` inside `startTransition`. The server call **succeeds**, yet the button
snaps back to "Like" the moment the Action finishes. What's the most likely cause?
- [ ] `useOptimistic` only works inside `<form action>`, not `startTransition`
- [x] The parent never updated `liked` after the save, and the optimistic value is discarded when the Action ends
- [ ] The component forgot to call `cancelQueries` before the optimistic update
- [ ] React rolled back because the promise resolved with `undefined`
> `useOptimistic` shows the guess only *while the Action is pending*; afterwards it shows the real `state` again.
> If nobody updated `liked` (no `setState`, no refetch), the real state is still the old value, so the UI "rolls
> back" on success. `startTransition(async …)` is a valid Action just like a form action, `cancelQueries` belongs
> to the TanStack Query cache (there is no cache here), and the resolved value of the Action is ignored.
:::

## Optimistic concurrency: versions, ETags and 409

Two users load card #7 at version 5. Alice renames it and saves → server stores version 6. Bob, still looking at
version 5, changes the description and saves. If the server just accepts Bob's whole object, **Alice's rename is
silently lost**. This is the *lost update* problem.

**Optimistic concurrency control** fixes it without locks: every row has a **version** (an incrementing integer,
a `rowversion`, or PostgreSQL's `xmin`). Each write says "I'm editing version 5"; the server only applies it if
the row is still at version 5, otherwise it rejects the write.

```http
GET /api/cards/7
200 OK
ETag: "5"
{ "id": 7, "title": "Login page", "description": "…", "version": 5 }

PUT /api/cards/7
If-Match: "5"
{ "title": "Login page", "description": "Bob's text" }

409 Conflict                       (or 412 Precondition Failed for a failed If-Match)
Content-Type: application/problem+json
{ "title": "Conflict", "status": 409, "detail": "Card was modified", "currentVersion": 6 }
```

The version can travel as an `ETag`/`If-Match` header pair (the HTTP-standard way; a failed `If-Match` is
strictly `412`) or as a `version` field in the body (common in JSON APIs, usually answered with `409`). Pick one
per API and be consistent. In ASP.NET Core + EF Core, the backend maps `DbUpdateConcurrencyException` to that 409.

On the frontend, a 409 is **not an error to toast and forget** — it's a decision for the user:

- **Reload** — discard my edit, show theirs (simple, safe).
- **Overwrite** — resend my edit with the *new* version (only after the user has seen theirs).
- **Merge** — if we changed *different fields*, combine automatically; ask only for true field-level conflicts.

:::job title="How real products handle it"
Linear, Jira and Notion-style apps merge silently when edits touch different fields, and show a non-blocking
banner — "Someone else edited this card — Reload / Keep mine" — when they don't. A modal that blocks the whole
screen for a conflict is considered hostile UX. Whatever you pick, **never silently drop** either side.
:::

:::challenge id=fe-24-c1 lang=ts xp=60
title: Three-way merge of fields
When a save returns 409, fetch the server's current entity (`theirs`) and merge it with your edit (`mine`) using the
version you started from (`base`). Implement `merge3(base, mine, theirs)` for flat objects of primitives:

- Key unchanged by me (`mine[k] === base[k]`) → take `theirs[k]`.
- Key unchanged by them (`theirs[k] === base[k]`) → take `mine[k]`.
- Both changed it to the **same** value → take it.
- Both changed it to **different** values → conflict: put `theirs[k]` in `merged` and list `k` in `conflicts`.

Return `{ merged, conflicts }` with `conflicts` sorted alphabetically. Consider every key present in any of the three
objects (a missing key counts as `undefined`; leave `undefined` values out of `merged`).

hint: `const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])`.
hint: Use `Object.is` for comparisons so `NaN` and `-0` behave.

```ts starter
type Flat = Record<string, string | number | boolean | null | undefined>

export function merge3(base: Flat, mine: Flat, theirs: Flat): { merged: Flat; conflicts: string[] } {
  return { merged: { ...theirs, ...mine }, conflicts: [] }
}
```

```ts solution
type Flat = Record<string, string | number | boolean | null | undefined>

export function merge3(base: Flat, mine: Flat, theirs: Flat): { merged: Flat; conflicts: string[] } {
  const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])
  const merged: Flat = {}
  const conflicts: string[] = []
  for (const k of keys) {
    const b = base[k], m = mine[k], t = theirs[k]
    let v
    if (Object.is(m, b)) v = t
    else if (Object.is(t, b)) v = m
    else if (Object.is(m, t)) v = m
    else { v = t; conflicts.push(k) }
    if (v !== undefined) merged[k] = v
  }
  return { merged, conflicts: conflicts.sort() }
}
```

```ts tests
const base = { title: 'Login', description: 'old', points: 3, done: false }
test('different fields edited → clean merge', () => {
  const r = merge3(base, { ...base, title: 'Login page' }, { ...base, points: 5 })
  expect(r).toEqual({ merged: { title: 'Login page', description: 'old', points: 5, done: false }, conflicts: [] })
})
test('same field, same value → no conflict', () => {
  const r = merge3(base, { ...base, done: true }, { ...base, done: true })
  expect(r.conflicts).toEqual([])
  expect(r.merged.done).toBe(true)
})
test('same field, different values → conflict, theirs kept', () => {
  const r = merge3(base, { ...base, title: 'A', points: 8 }, { ...base, title: 'B', points: 1, description: 'new' })
  expect(r.conflicts).toEqual(['points', 'title'])
  expect(r.merged).toEqual({ title: 'B', description: 'new', points: 1, done: false })
})
test('added and removed keys', () => {
  const r = merge3({ a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { a: 1 })
  expect(r).toEqual({ merged: { a: 1, c: 3 }, conflicts: [] })
})
```
:::

:::challenge id=fe-24-c2 lang=tsx xp=70 preview=Demo
title: A conflict banner that respects both sides
Build `ProjectNameEditor({ initial, save })`:

- `initial` is `{ name, version }`. Show a text input labelled `Project name` and a `Save` button.
- `save(name, version)` returns a promise of either `{ ok: true, version }` or `{ ok: false, status: 409, current: { name, version } }`.
- On success show `Saved` in an element with `role="status"` and remember the new version.
- On 409 show an element with `role="alert"` containing `Someone else edited this project` and their name
  (`Current name: <name>`), plus two buttons:
  - `Use theirs` → put their name in the input, adopt their version, hide the alert.
  - `Overwrite` → call `save` again with **my** name and **their** version.
- On any successful save (including Overwrite) show `Saved` and hide the conflict alert.
- Always send the version you are editing *from* — that's the whole point.

hint: Keep `version` in state next to `name`; update it from the success result or from `current`.
hint: Store the 409 payload in state: `const [conflict, setConflict] = useState<{ name: string; version: number } | null>(null)`.
hint: The tests' fake `save` resolves immediately, so `await user.click(...)` is enough; use `findByRole` if you like.

```tsx starter
import { useState } from 'react'

type SaveResult = { ok: true; version: number } | { ok: false; status: 409; current: { name: string; version: number } }

export function ProjectNameEditor({ initial, save }: { initial: { name: string; version: number }; save: (name: string, version: number) => Promise<SaveResult> }) {
  const [name, setName] = useState(initial.name)
  return (
    <form onSubmit={(e) => { e.preventDefault(); save(name, 0) }}>
      <label htmlFor="pname">Project name</label>
      <input id="pname" value={name} onChange={(e) => setName(e.target.value)} />
      <button type="submit">Save</button>
    </form>
  )
}

export function Demo() {
  let serverVersion = 2
  const save = async (_name: string, version: number): Promise<SaveResult> =>
    version === serverVersion ? { ok: true, version: ++serverVersion } : { ok: false, status: 409, current: { name: 'Apollo (renamed by Sam)', version: serverVersion } }
  return <ProjectNameEditor initial={{ name: 'Apollo', version: 1 }} save={save} />
}
```

```tsx solution
import { useState } from 'react'

type SaveResult = { ok: true; version: number } | { ok: false; status: 409; current: { name: string; version: number } }

export function ProjectNameEditor({ initial, save }: { initial: { name: string; version: number }; save: (name: string, version: number) => Promise<SaveResult> }) {
  const [name, setName] = useState(initial.name)
  const [version, setVersion] = useState(initial.version)
  const [conflict, setConflict] = useState<{ name: string; version: number } | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(fromVersion: number) {
    setSaved(false)
    const r = await save(name, fromVersion)
    if (r.ok) {
      setVersion(r.version)
      setConflict(null)
      setSaved(true)
    } else {
      setConflict(r.current)
    }
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(version) }}>
      <label htmlFor="pname">Project name</label>
      <input id="pname" value={name} onChange={(e) => { setName(e.target.value); setSaved(false) }} />
      <button type="submit">Save</button>
      {saved && <p role="status">Saved</p>}
      {conflict && (
        <div role="alert">
          <p>Someone else edited this project.</p>
          <p>Current name: {conflict.name}</p>
          <button type="button" onClick={() => { setName(conflict.name); setVersion(conflict.version); setConflict(null) }}>Use theirs</button>
          <button type="button" onClick={() => submit(conflict.version)}>Overwrite</button>
        </div>
      )}
    </form>
  )
}

export function Demo() {
  let serverVersion = 2
  const save = async (_name: string, version: number): Promise<SaveResult> =>
    version === serverVersion ? { ok: true, version: ++serverVersion } : { ok: false, status: 409, current: { name: 'Apollo (renamed by Sam)', version: serverVersion } }
  return <ProjectNameEditor initial={{ name: 'Apollo', version: 1 }} save={save} />
}
```

```tsx tests
test('sends the version it started from and shows Saved', async () => {
  const save = fn(async () => ({ ok: true, version: 4 }))
  render(<ProjectNameEditor initial={{ name: 'Apollo', version: 3 }} save={save} />)
  await user.clear(screen.getByLabelText('Project name'))
  await user.type(screen.getByLabelText('Project name'), 'Zeus')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(save).toHaveBeenCalledWith('Zeus', 3)
  expect(await screen.findByRole('status')).toHaveTextContent('Saved')
})
test('uses the new version for the next save', async () => {
  const save = fn(async () => ({ ok: true, version: 4 }))
  render(<ProjectNameEditor initial={{ name: 'Apollo', version: 3 }} save={save} />)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByRole('status')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(save.mock.calls[1]).toEqual(['Apollo', 4])
})
test('409 shows the conflict with their name; Use theirs adopts it', async () => {
  const save = fn(async () => ({ ok: false, status: 409, current: { name: 'Apollo X', version: 9 } }))
  render(<ProjectNameEditor initial={{ name: 'Apollo', version: 3 }} save={save} />)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Someone else edited this project')
  expect(alert).toHaveTextContent('Current name: Apollo X')
  expect(screen.queryByRole('status')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Use theirs' }))
  expect(screen.getByLabelText('Project name')).toHaveValue('Apollo X')
  expect(screen.queryByRole('alert')).toBeNull()
  save.mockImplementation(async () => ({ ok: true, version: 10 }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(save.mock.calls[1]).toEqual(['Apollo X', 9])
})
test('Overwrite resends my name with their version', async () => {
  const save = fn(async () => ({ ok: false, status: 409, current: { name: 'Apollo X', version: 9 } }))
  render(<ProjectNameEditor initial={{ name: 'Mine', version: 3 }} save={save} />)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByRole('alert')
  save.mockImplementation(async () => ({ ok: true, version: 10 }))
  await user.click(screen.getByRole('button', { name: 'Overwrite' }))
  expect(save.mock.calls[1]).toEqual(['Mine', 9])
  expect(await screen.findByRole('status')).toHaveTextContent('Saved')
  expect(screen.queryByRole('alert')).toBeNull()
})
```
:::

## Getting changes pushed to you: WebSockets vs SSE vs SignalR

Polling (`refetchInterval: 5000`) is the simplest real-time strategy and honestly fine for dashboards. For
collaboration you want the server to **push**:

| | WebSocket | Server-Sent Events (SSE) | SignalR |
|---|---|---|---|
| Direction | Full duplex (both ways) | Server → client only | Both ways (RPC-style) |
| Protocol | `ws://` / `wss://` upgrade | Plain HTTP response that never ends (`text/event-stream`) | Negotiates WebSockets, falls back to SSE / long polling |
| Reconnect | DIY | Built into `EventSource` (with `Last-Event-ID`) | `withAutomaticReconnect()` |
| Messages | Raw text/binary — you design the protocol | Text events | Named methods + typed args (JSON or MessagePack) |
| Groups / fan-out | DIY on the server | DIY | Built in: `Groups.AddToGroupAsync`, `Clients.Group(...)` |
| Scaling out | DIY | DIY | Redis backplane or Azure SignalR Service |
| Best for | Games, custom protocols, non-.NET backends | Notifications, live feeds, LLM token streaming | ASP.NET Core apps needing collaboration |

With an ASP.NET Core backend, **SignalR** is the pragmatic default: you get transport fallback, reconnection,
groups and auth integration for free.

SSE deserves a second look for one-way feeds (notifications, progress bars, streaming LLM output): the browser's
`EventSource` reconnects by itself and sends `Last-Event-ID` so the server can resume, and ASP.NET Core 10 can
return an SSE stream directly with `TypedResults.ServerSentEvents(asyncEnumerable)`. Two gotchas:

- **`EventSource` can't set headers**, so no `Authorization: Bearer …` — authenticate with a cookie (a BFF) or use a
  `fetch`-based SSE client.
- **Over HTTP/1.1 a browser allows only ~6 connections per origin.** Each open SSE stream holds one, so a user with
  six tabs open can freeze your app's other requests. HTTP/2 (the default behind any modern proxy) multiplexes and
  removes the limit.

### The SignalR client

```ts
// modules/board/services/boardHub.ts
import { HubConnectionBuilder, LogLevel, type HubConnection } from '@microsoft/signalr'

import { createRetryPolicy } from './retryPolicy'             // you build this in a challenge below

export function createBoardHub(getToken: () => Promise<string>): HubConnection {
  return new HubConnectionBuilder()
    .withUrl('/hubs/board', { accessTokenFactory: getToken })   // token sent as ?access_token= for WebSockets
    .withAutomaticReconnect(createRetryPolicy({ baseMs: 500, maxMs: 30_000, maxRetries: 20, random: Math.random }))
    .configureLogging(LogLevel.Warning)
    .build()
}
```

Browsers can't put an `Authorization` header on a WebSocket handshake, which is why SignalR sends the token as an
`access_token` query parameter. The server must be told to read it (in `JwtBearerEvents.OnMessageReceived`, only
for paths under `/hubs`), and you should keep it out of access logs. A cookie-based BFF avoids both issues.

```tsx
// modules/board/hooks/useBoardRealtime.ts
type Status = 'connecting' | 'live' | 'reconnecting' | 'offline'

export function useBoardRealtime(boardId: string) {
  const queryClient = useQueryClient()
  const { getAccessToken } = useAuth()          // must be a STABLE function (useCallback) — see below
  const [status, setStatus] = useState<Status>('connecting')

  useEffect(() => {
    const hub = createBoardHub(getAccessToken)
    let disposed = false
    const report = (s: Status) => { if (!disposed) setStatus(s) }   // a stopped hub must not overwrite the new one

    hub.on('CardChanged', (patch: CardPatch) =>
      queryClient.setQueryData<Board>(['board', boardId], (b) => (b ? applyRemotePatch(b, patch) : b)))
    hub.on('PresenceChanged', (users: PresenceUser[]) => queryClient.setQueryData(['presence', boardId], users))

    hub.onreconnecting(() => report('reconnecting'))
    hub.onreconnected(async () => {
      await hub.invoke('JoinBoard', boardId)                          // group membership is per connection — rejoin!
      queryClient.invalidateQueries({ queryKey: ['board', boardId] }) // we missed messages while away — re-sync
      report('live')
    })
    hub.onclose(() => report('offline'))

    hub.start()
      .then(() => (disposed ? undefined : hub.invoke('JoinBoard', boardId)))
      .then(() => report('live'))
      .catch(() => report('offline'))

    return () => { disposed = true; void hub.stop() }   // StrictMode mounts twice in dev — cleanup must be solid
  }, [boardId, queryClient, getAccessToken])

  return status
}
```

Why the `disposed` flag and `report` helper? In development, React StrictMode runs every effect, cleans it up and
runs it again, so the first hub is stopped and a second one is created. Every callback of a stopped hub — its
`onclose`, or the rejection of its interrupted `start()` — is asynchronous and *can* run after the new hub reported
live. The most dependable trigger is a hub that had already connected when it was stopped (`boardId` changes, or
the user switches account): its `onclose` definitely fires, and without the guard the dead hub flips the pill to
"Offline" on a perfectly healthy connection. The guard makes the order irrelevant.

:::warn title="Spot the reconnect loop"
`getAccessToken` is in the dependency array. If `useAuth()` returns a **new** function on every render, the effect
tears the connection down and builds a new one on every render — a reconnect storm that looks like "SignalR is
flaky". Make the function stable with `useCallback` in the auth provider (or read it from a ref).
:::

:::quiz id=fe-24-q6 xp=15
A teammate's version of the hook has no `disposed` guard:
`hub.onclose(() => setStatus('offline'))` and
`hub.start().then(() => setStatus('live')).catch(() => setStatus('offline'))`. The pill sometimes shows **Offline**
even though live updates keep arriving. What is happening?
- [x] A callback from an old, stopped hub (its `onclose` or its rejected `start()`) ran after the new hub reported live and overwrote the status — e.g. in StrictMode or when `boardId` changes
- [ ] SignalR's default reconnect policy gave up, but messages still arrive over long polling
- [ ] `setStatus` is called outside a transition, so React shows a stale value
- [ ] The server closes every connection once after `JoinBoard`, which is harmless
> Every time the effect re-runs — StrictMode's mount/unmount/re-mount in development, or a `boardId` change in
> production — the old hub is stopped and a new one is created. The old hub's `onclose` (or the rejection of its
> interrupted `start()`) is asynchronous and can land *after* the new hub reported `live`. Both write to the same
> state, so the dead connection wins. Guarding every status update with "is this effect still current?" fixes it
> regardless of timing. A real give-up would stop the messages too.
:::

Four details that separate a demo from production:

1. **Rejoin groups after reconnect.** A reconnect is a *new* connection id on the server; group memberships are gone.
2. **Re-sync after reconnect.** Messages sent while you were disconnected are **not** replayed. Invalidate queries
   (or fetch "changes since version N").
3. **Push into the query cache**, not into separate component state — one source of truth for server data.
4. **Show connection status.** A small "Reconnecting…" pill prevents users from editing into the void.

:::info title="Stateful reconnect (ASP.NET Core 8+)"
SignalR can also smooth over **short** blips: enable `.withStatefulReconnect()` on the client and
`options.AllowStatefulReconnects = true` in `MapHub` on the server. Both sides then buffer un-acknowledged messages
and replay them, keeping the same connection (and its groups) when the WebSocket comes back quickly. It only works
over WebSockets and only within the buffer size — after a longer outage you still get a brand-new connection, so
rules 1 and 2 still apply.
:::

:::quiz id=fe-24-q2 xp=15
Which statements about SignalR reconnection are true? (Select all that apply.)
- [x] After `onreconnected`, the client must re-invoke `JoinBoard`, because the server sees a new connection
- [x] Messages broadcast while the client was disconnected are lost, so the client should refetch or ask for changes since its last version
- [ ] `withAutomaticReconnect()` retries forever by default
- [ ] SSE is a better choice than SignalR when the client also needs to send frequent messages over the same connection
> A (non-stateful) reconnect is a new connection id, so group membership must be re-established, and nothing that
> was broadcast in the gap is replayed — hence the refetch. The tempting wrong one is "retries forever": the default
> policy retries after 0, 2, 10 and 30 seconds and then gives up (`onclose` fires), which is why production apps
> pass their own policy. SSE is one-way; client→server traffic would need separate HTTP requests.
:::

## Applying remote patches safely

Pushed messages arrive **out of order**, **twice** (after a reconnect), or **after a gap** (you missed one). If each
patch carries the entity's new `version`, a reducer can handle all three cases deterministically:

- version ≤ what I have → **stale or duplicate** → ignore (idempotency!).
- version = mine + 1 → **next in line** → apply.
- version > mine + 1 → **gap** → don't guess; mark the entity for refetch.

:::challenge id=fe-24-c3 lang=ts xp=70
title: A version-aware remote patch reducer
Implement `boardReducer(state, action)`:

- `state` = `{ cards: Record<string, Card>, needsRefetch: string[] }`, `Card` = `{ id, version, title, column }`.
- `remotePatched` `{ id, version, changes }` — apply as described above. Unknown card id → ignore.
  On a gap, add the id to `needsRefetch` (no duplicates) and leave the card unchanged.
- `remoteDeleted` `{ id }` — remove the card (and from `needsRefetch`).
- `refetched` `{ card }` — replace the card with the server copy and remove its id from `needsRefetch`.

Ignored actions must return the **same** state object (so React can bail out). Never mutate.

hint: `const { [id]: _gone, ...rest } = state.cards` removes a key immutably.
hint: Apply with `{ ...card, ...action.changes, version: action.version }`.

```ts starter
type Card = { id: string; version: number; title: string; column: string }
type BoardState = { cards: Record<string, Card>; needsRefetch: string[] }
type BoardAction =
  | { type: 'remotePatched'; id: string; version: number; changes: Partial<Pick<Card, 'title' | 'column'>> }
  | { type: 'remoteDeleted'; id: string }
  | { type: 'refetched'; card: Card }

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  if (action.type === 'remotePatched') {
    const card = state.cards[action.id]
    Object.assign(card, action.changes)
  }
  return state
}
```

```ts solution
type Card = { id: string; version: number; title: string; column: string }
type BoardState = { cards: Record<string, Card>; needsRefetch: string[] }
type BoardAction =
  | { type: 'remotePatched'; id: string; version: number; changes: Partial<Pick<Card, 'title' | 'column'>> }
  | { type: 'remoteDeleted'; id: string }
  | { type: 'refetched'; card: Card }

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case 'remotePatched': {
      const card = state.cards[action.id]
      if (!card || action.version <= card.version) return state
      if (action.version > card.version + 1) {
        if (state.needsRefetch.includes(action.id)) return state
        return { ...state, needsRefetch: [...state.needsRefetch, action.id] }
      }
      return { ...state, cards: { ...state.cards, [action.id]: { ...card, ...action.changes, version: action.version } } }
    }
    case 'remoteDeleted': {
      if (!state.cards[action.id]) return state
      const { [action.id]: _gone, ...rest } = state.cards
      return { cards: rest, needsRefetch: state.needsRefetch.filter((x) => x !== action.id) }
    }
    case 'refetched':
      return {
        cards: { ...state.cards, [action.card.id]: action.card },
        needsRefetch: state.needsRefetch.filter((x) => x !== action.card.id),
      }
    default:
      return state
  }
}
```

```ts tests
const c1 = { id: 'c1', version: 3, title: 'Login', column: 'todo' }
const start = () => ({ cards: { c1 }, needsRefetch: [] as string[] })
test('applies the next version', () => {
  const s = boardReducer(start(), { type: 'remotePatched', id: 'c1', version: 4, changes: { column: 'doing' } })
  expect(s.cards.c1).toEqual({ id: 'c1', version: 4, title: 'Login', column: 'doing' })
})
test('ignores stale and duplicate patches (same object back)', () => {
  const s0 = start()
  expect(boardReducer(s0, { type: 'remotePatched', id: 'c1', version: 3, changes: { title: 'dup' } })).toBe(s0)
  expect(boardReducer(s0, { type: 'remotePatched', id: 'c1', version: 1, changes: { title: 'old' } })).toBe(s0)
  expect(boardReducer(s0, { type: 'remotePatched', id: 'zz', version: 9, changes: { title: '?' } })).toBe(s0)
})
test('a gap marks the card for refetch without applying it', () => {
  const s0 = start()
  const s1 = boardReducer(s0, { type: 'remotePatched', id: 'c1', version: 6, changes: { title: 'jump' } })
  expect(s1.cards.c1).toEqual(c1)
  expect(s1.needsRefetch).toEqual(['c1'])
  const s2 = boardReducer(s1, { type: 'remotePatched', id: 'c1', version: 7, changes: { title: 'jump2' } })
  expect(s2.needsRefetch).toEqual(['c1'])
})
test('refetched replaces and clears the flag', () => {
  const s1 = boardReducer(start(), { type: 'remotePatched', id: 'c1', version: 6, changes: {} })
  const s2 = boardReducer(s1, { type: 'refetched', card: { id: 'c1', version: 6, title: 'Fresh', column: 'done' } })
  expect(s2.cards.c1.title).toBe('Fresh')
  expect(s2.needsRefetch).toEqual([])
})
test('remoteDeleted removes the card and never mutates', () => {
  const s0 = Object.freeze({ cards: Object.freeze({ c1: Object.freeze({ ...c1 }) }), needsRefetch: Object.freeze(['c1']) }) as any
  const s1 = boardReducer(s0, { type: 'remoteDeleted', id: 'c1' })
  expect(s1.cards).toEqual({})
  expect(s1.needsRefetch).toEqual([])
  expect(s0.cards.c1).toEqual(c1)
  const s2 = boardReducer(s0, { type: 'remotePatched', id: 'c1', version: 4, changes: { title: 'x' } })
  expect(s2.cards.c1.title).toBe('x')
  expect(s0.cards.c1.title).toBe('Login')
})
```
:::

## Presence: who else is here?

Presence ("Sam is viewing", avatars on a card, live cursors) is **ephemeral** state: nobody needs it after the
session, so it never goes in the database's main tables.

- The server tracks **connections**, not users — one person with three tabs is three connections. Presence is
  "user has ≥ 1 live connection on this board".
- Connections die without saying goodbye (laptop lid closed). Use **heartbeats** + a TTL: if no heartbeat for
  30 s, the user is gone. SignalR's `OnDisconnectedAsync` covers most cases; the TTL covers the rest.
- Cursor positions and "is typing" are **high-frequency** — throttle on the client (e.g. 10 Hz), never write them
  to the query cache of the board itself, and don't put them in React Context (see the context lesson).
- With several server instances, presence lives in a shared store (Redis) — see the next section.

## Scaling out: what changes with more than one server

Everything so far quietly assumed **one** API instance. In production (two pods behind a load balancer, or an
autoscaled Kubernetes Deployment) a SignalR connection lives on exactly one of them. When the `PUT` that changed card
7 is handled by pod A, `Clients.Group("board:42")` on pod A only reaches the connections **pod A** holds — users
connected to pod B see nothing. Three things fix this:

**1. A backplane.** Every pod publishes outgoing hub messages to a shared message bus, and every pod forwards what
it receives to its own local connections. The standard choice is Redis pub/sub
(package `Microsoft.AspNetCore.SignalR.StackExchangeRedis`):

```csharp
using StackExchange.Redis;   // for RedisChannel

builder.Services.AddSignalR()
    .AddStackExchangeRedis(builder.Configuration.GetConnectionString("redis")!, o =>
        o.Configuration.ChannelPrefix = RedisChannel.Literal("board-api"));  // several apps can share one Redis
```

Redis pub/sub is fire-and-forget: it does not store messages, so a pod or client that is disconnected at that
moment misses them. That is one more reason the client re-syncs after reconnecting. The managed alternative,
**Azure SignalR Service**, takes over the connections entirely so your pods hold none.

**2. Sticky sessions.** SignalR first sends a `negotiate` HTTP request, which registers the connection on one pod,
then opens the transport — which must reach that **same** pod (and with SSE/long polling, so must every later
request). So the load balancer or Ingress needs session affinity (usually a cookie). Two exceptions: all
clients use WebSockets only, with `skipNegotiation: true`, or you use Azure SignalR Service (it holds the client
connections, so your pods need no affinity).

**3. Shared ephemeral state.** Presence and "who is typing" can't live in one pod's memory either. A common Redis
pattern is a sorted set per board scored by the last heartbeat time:

```text
ZADD  presence:board:42  <now-ms>  user:7        # every heartbeat (e.g. every 10 s)
ZREMRANGEBYSCORE presence:board:42 -inf <now-ms − 30000>   # drop anyone silent for 30 s
ZRANGE presence:board:42 0 -1                     # who is here?
```

:::pro title="Autoscaling real-time pods"
Scaling **out** (HPA, or KEDA scaling on a metric such as active connections or a Redis/queue length) is easy:
new pods take new connections. Scaling **in** is where it hurts: every connection on a removed pod drops at the
same instant, and those clients all reconnect at once — the thundering herd described next. Give pods a
`terminationGracePeriodSeconds` long enough to drain, don't let the autoscaler flap (a scale-down stabilisation
window), and make sure clients reconnect with jittered backoff and re-sync. Then a scale-in is a non-event.
:::

:::quiz id=fe-24-q4 xp=15
You scale the board API from one pod to three. Now users report that *some* live updates never show up until they
refresh, while others work fine. What is the most likely cause?
- [ ] WebSockets don't work behind a Kubernetes Service, so SignalR fell back to long polling
- [x] There is no backplane: a broadcast only reaches the connections on the pod that handled the write
- [ ] The default reconnect policy gave up on two thirds of the clients
- [ ] The clients need `withStatefulReconnect()` so messages get buffered
> With three pods and no backplane, `Clients.Group(...)` on pod A reaches only pod A's connections — roughly two
> thirds of the audience never hears about the change, which matches "some updates missing until refresh". Add the
> Redis backplane (or Azure SignalR Service). Long polling would be slower, not lossy; a failed reconnect would show
> "Offline", not silently drop updates; stateful reconnect buffers messages for one connection's blips and can't
> deliver a message that was never sent to that pod.
:::

## Reconnection with exponential backoff and jitter

When a server restarts, *every* client disconnects at the same moment. If they all retry after exactly 1 s, 2 s,
4 s… they hit the recovering server in synchronised waves — a **thundering herd**. The cure is
**exponential backoff with jitter**: delays grow exponentially *and* are randomised so clients spread out.

"Full jitter" (from the AWS architecture blog, widely used): `delay = random(0, min(cap, base × 2^attempt))`.

With `base = 500 ms` and `cap = 30 s` the **ceiling** goes 500 ms, 1 s, 2 s, 4 s, 8 s, 16 s, 30 s, 30 s… and each
client picks a random delay *below* that ceiling. Ten thousand clients that dropped at the same instant now
arrive spread over the whole window instead of all at once. The cap keeps a long outage from producing absurd
waits; the retry limit lets you eventually show "Offline — Retry" instead of spinning forever.

:::warn title="Common mistake"
Jitter that is too small (`delay + Math.random() * 100`) barely helps: the herd still arrives within the same
100 ms. The randomness must be proportional to the delay.
:::

:::challenge id=fe-24-c4 lang=ts xp=50
title: A SignalR retry policy with full jitter
`withAutomaticReconnect` accepts an object with `nextRetryDelayInMilliseconds(retryContext)` that returns a delay
in ms, or `null` to stop retrying. Implement `createRetryPolicy({ baseMs, maxMs, maxRetries, random })`:

- `retryContext.previousRetryCount` is 0 for the first retry, 1 for the second, …
- When `previousRetryCount >= maxRetries`, return `null`.
- Otherwise return `Math.floor(random() * Math.min(maxMs, baseMs * 2 ** previousRetryCount))`.
- `random` is injected (defaults would be `Math.random`) so tests are deterministic.

hint: The ceiling for attempt `n` is `Math.min(maxMs, baseMs * 2 ** n)`; jitter multiplies it by a number in `[0, 1)`.

```ts starter
type RetryContext = { previousRetryCount: number; elapsedMilliseconds: number }
type Opts = { baseMs: number; maxMs: number; maxRetries: number; random: () => number }

export function createRetryPolicy(opts: Opts) {
  return {
    nextRetryDelayInMilliseconds(ctx: RetryContext): number | null {
      return opts.baseMs * ctx.previousRetryCount
    },
  }
}
```

```ts solution
type RetryContext = { previousRetryCount: number; elapsedMilliseconds: number }
type Opts = { baseMs: number; maxMs: number; maxRetries: number; random: () => number }

export function createRetryPolicy(opts: Opts) {
  return {
    nextRetryDelayInMilliseconds(ctx: RetryContext): number | null {
      if (ctx.previousRetryCount >= opts.maxRetries) return null
      const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** ctx.previousRetryCount)
      return Math.floor(opts.random() * ceiling)
    },
  }
}
```

```ts tests
const ctx = (n: number) => ({ previousRetryCount: n, elapsedMilliseconds: 0 })
test('with random=1-ε the delays double up to the cap', () => {
  const p = createRetryPolicy({ baseMs: 500, maxMs: 10_000, maxRetries: 10, random: () => 0.999999 })
  expect([0, 1, 2, 3, 4, 5, 6].map((n) => p.nextRetryDelayInMilliseconds(ctx(n)))).toEqual([499, 999, 1999, 3999, 7999, 9999, 9999])
})
test('jitter scales the ceiling', () => {
  const p = createRetryPolicy({ baseMs: 1000, maxMs: 30_000, maxRetries: 5, random: () => 0.5 })
  expect(p.nextRetryDelayInMilliseconds(ctx(0))).toBe(500)
  expect(p.nextRetryDelayInMilliseconds(ctx(3))).toBe(4000)
})
test('random=0 gives an immediate retry', () => {
  const p = createRetryPolicy({ baseMs: 1000, maxMs: 30_000, maxRetries: 5, random: () => 0 })
  expect(p.nextRetryDelayInMilliseconds(ctx(2))).toBe(0)
})
test('gives up after maxRetries', () => {
  const p = createRetryPolicy({ baseMs: 1000, maxMs: 30_000, maxRetries: 3, random: () => 0.5 })
  expect(p.nextRetryDelayInMilliseconds(ctx(2))).toBe(2000)
  expect(p.nextRetryDelayInMilliseconds(ctx(3))).toBeNull()
  expect(p.nextRetryDelayInMilliseconds(ctx(9))).toBeNull()
})
```
:::

:::pro title="Back off everywhere, not just on sockets"
The same function belongs in your HTTP retry logic (TanStack Query's `retryDelay`), your offline queue flush,
and your background sync. And retry only what's **retryable**: network errors, 408, 429 (respect `Retry-After`),
502/503/504. Don't blindly retry a 400, 403, 404, 409 or 422 — the answer won't change (a 409 goes through the
conflict flow above; a 401 is retried at most once, after refreshing the token). Retrying a `POST` is only safe
if it carries an idempotency key — see the offline queue below.
:::

## Offline queue

For apps people use on the move (field service, notes, checklists), writes made offline should **queue** and
replay when the connection returns:

```ts
window.addEventListener('online', () => queue.flush(sendToApi))
// navigator.onLine === false means "definitely offline"; true only means "maybe online" — the real test is a request.
```

Design rules for the queue:

- **Persist** it (IndexedDB, e.g. via `idb-keyval`) so a reload doesn't lose writes. TanStack Query can persist
  paused mutations too (`persistQueryClient` + `resumePausedMutations`).
- **Preserve order** — "create card" must reach the server before "move card".
- **Idempotency keys** — each queued write carries a unique key (`Idempotency-Key` header) so a replay after a lost
  response doesn't create a duplicate.
- **Coalesce** — five renames of the same card while offline only need to send the last one.
- **Stop on network failure, drop on permanent failure** — a network error (or 408/429/503) means "try again
  later"; a permanent 4xx such as 400, 403, 404 or 422 means "this will never succeed", so surface it to the user
  and move on instead of blocking everything behind it.
- **TanStack Query users:** paused mutations are persisted as data only — functions can't be serialised — so
  register the `mutationFn` with `queryClient.setMutationDefaults(['moveCard'], { mutationFn })` before calling
  `resumePausedMutations()`, or the restored mutations have nothing to run.

Note the two different keys. A **coalescing key** (like `card:7:title`) says *what* a write targets, so later
writes to the same target can replace earlier ones on the client. An **idempotency key** (a UUID per logical write)
lets the *server* recognise a replay of a request it already processed. The challenge below implements the first;
the quiz after it is about the second.

:::challenge id=fe-24-c5 lang=ts xp=70
title: An ordered, coalescing offline queue
Implement `createOfflineQueue()` returning `{ enqueue, pending, flush }`:

- `enqueue(m)` where `m = { key, payload }` — if a mutation with the same `key` is already pending, **replace its
  payload in place** (keep its position); otherwise append.
- `pending()` returns a copy of the pending mutations in order.
- `flush(send)` sends mutations **one at a time, in order** (`await send(m)`). `send` resolves `{ ok: true }`,
  resolves `{ ok: false, retryable: false }` (permanent failure) or **rejects** (network error).
  - ok → remove it, continue.
  - permanent failure → remove it, add it to `dropped`, continue.
  - rejection → **stop**; it and everything after it stay pending.
  - Resolve with `{ sent, dropped }` (`sent` = number of ok sends, `dropped` = the dropped mutations).

hint: Keep an array; `findIndex(x => x.key === m.key)` for coalescing.
hint: In `flush`, loop `while (items.length)`, look at `items[0]`, and `shift()` only after a definite answer.
hint: Wrap only `await send(m)` in `try/catch`; on catch, `break` out of the loop without removing anything.

```ts starter
type Mutation = { key: string; payload: unknown }
type SendResult = { ok: true } | { ok: false; retryable: false }

export function createOfflineQueue() {
  const items: Mutation[] = []
  return {
    enqueue(m: Mutation) { items.push(m) },
    pending() { return items },
    async flush(send: (m: Mutation) => Promise<SendResult>) {
      for (const m of items) await send(m)
      return { sent: items.length, dropped: [] as Mutation[] }
    },
  }
}
```

```ts solution
type Mutation = { key: string; payload: unknown }
type SendResult = { ok: true } | { ok: false; retryable: false }

export function createOfflineQueue() {
  const items: Mutation[] = []
  return {
    enqueue(m: Mutation) {
      const i = items.findIndex((x) => x.key === m.key)
      if (i >= 0) items[i] = { ...items[i], payload: m.payload }
      else items.push(m)
    },
    pending() { return items.slice() },
    async flush(send: (m: Mutation) => Promise<SendResult>) {
      let sent = 0
      const dropped: Mutation[] = []
      while (items.length) {
        const m = items[0]
        let r: SendResult
        try { r = await send(m) } catch { break }
        items.shift()
        if (r.ok) sent++
        else dropped.push(m)
      }
      return { sent, dropped }
    },
  }
}
```

```ts tests
test('coalesces by key, keeping position', () => {
  const q = createOfflineQueue()
  q.enqueue({ key: 'card:1:title', payload: 'A' })
  q.enqueue({ key: 'card:2:move', payload: 'done' })
  q.enqueue({ key: 'card:1:title', payload: 'ABC' })
  expect(q.pending()).toEqual([{ key: 'card:1:title', payload: 'ABC' }, { key: 'card:2:move', payload: 'done' }])
})
test('pending returns a copy', () => {
  const q = createOfflineQueue()
  q.enqueue({ key: 'a', payload: 1 })
  q.pending().push({ key: 'x', payload: 0 })
  expect(q.pending()).toHaveLength(1)
})
test('sends in order and empties the queue', async () => {
  const q = createOfflineQueue()
  q.enqueue({ key: 'a', payload: 1 }); q.enqueue({ key: 'b', payload: 2 })
  const seen: string[] = []
  const r = await q.flush(async (m) => { seen.push(m.key); return { ok: true } })
  expect(seen).toEqual(['a', 'b'])
  expect(r).toEqual({ sent: 2, dropped: [] })
  expect(q.pending()).toEqual([])
})
test('a network error stops the flush and keeps the rest', async () => {
  const q = createOfflineQueue()
  q.enqueue({ key: 'a', payload: 1 }); q.enqueue({ key: 'b', payload: 2 }); q.enqueue({ key: 'c', payload: 3 })
  const send = fn(async (m: any) => { if (m.key === 'b') throw new Error('offline'); return { ok: true } })
  const r = await q.flush(send as any)
  expect(r.sent).toBe(1)
  expect(send).toHaveBeenCalledTimes(2)
  expect(q.pending().map((m) => m.key)).toEqual(['b', 'c'])
})
test('permanent failures are dropped and the flush continues', async () => {
  const q = createOfflineQueue()
  q.enqueue({ key: 'a', payload: 1 }); q.enqueue({ key: 'b', payload: 2 }); q.enqueue({ key: 'c', payload: 3 })
  const r = await q.flush(async (m) => (m.key === 'b' ? { ok: false, retryable: false } : { ok: true }))
  expect(r).toEqual({ sent: 2, dropped: [{ key: 'b', payload: 2 }] })
  expect(q.pending()).toEqual([])
})
```
:::

:::quiz id=fe-24-q3 xp=10
A queued "create comment" request reached the server, but the response was lost when the connection dropped. The
queue replays it after reconnecting. What prevents a duplicate comment?
- [ ] Exponential backoff
- [x] An idempotency key sent with the request, which the server remembers and uses to return the original result
- [ ] Optimistic concurrency with a version number
- [ ] Coalescing mutations with the same key on the client
> The server stores the key with the result for a while; a repeated key returns the stored result instead of
> creating a second comment. The tempting wrong answer is coalescing: it only merges writes that are *still on the
> client* — this one already left, and the client can't know whether it arrived. Versions protect against
> concurrent edits by *different* users (and a "create" has no version yet); backoff only changes *when* the
> replay happens.
:::

:::warn title="A subtle bug in naive queues"
In the challenge's queue, `flush` reads `items[0]`, awaits `send`, then `shift()`s it. If the user renames the same
card **while that request is in flight**, `enqueue` coalesces into `items[0]` — and the `shift()` that follows
throws the new title away. Production queues mark the head item as in-flight and never coalesce into it (append a
new entry instead). Write a test for it before you trust your queue.
:::

:::quiz id=fe-24-q5 xp=10
The offline queue's flush gets these answers for four queued writes. Which ones should **stay in the queue** to be
retried later? (Select all that apply.)
- [x] The request fails with `TypeError: Failed to fetch` (no network)
- [x] `503 Service Unavailable` with `Retry-After: 30`
- [ ] `422 Unprocessable Entity` — "title must not be empty"
- [ ] `403 Forbidden` — the user lost access to the board
> Network errors and 503 are transient: the same request can succeed later, and `Retry-After` even says when. A
> 422 or 403 is a *decision* by the server about this exact request — replaying it will get the same answer forever
> and, in an ordered queue, block every write behind it. Drop those and tell the user.
:::

:::lab id=fe-24-lab1 xp=120
title: Live board updates with SignalR
You need the .NET 10 SDK and your Vite React app. The server below is self-contained (an in-memory store instead
of a database) so you can focus on the real-time part; in the backend track's project you'd use EF Core instead.

**Server** — `dotnet new web -n BoardApi`, then replace `Program.cs`:

```csharp
// Program.cs
using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSignalR();
var app = builder.Build();

// In-memory store with fixed ids, so a restart brings back the same cards (at version 1).
var boardId = Guid.Parse("00000000-0000-0000-0000-000000000042");
var cards = new ConcurrentDictionary<Guid, Card>();
cards[Guid.Parse("00000000-0000-0000-0000-000000000001")] = new(Guid.Parse("00000000-0000-0000-0000-000000000001"), boardId, "Login page", 1);
cards[Guid.Parse("00000000-0000-0000-0000-000000000002")] = new(Guid.Parse("00000000-0000-0000-0000-000000000002"), boardId, "Signup page", 1);

app.MapHub<BoardHub>("/hubs/board");

app.MapGet("/api/boards/{id:guid}/cards", (Guid id) =>
    cards.Values.Where(c => c.BoardId == id).OrderBy(c => c.Title));

app.MapPut("/api/cards/{id:guid}", async (Guid id, CardUpdate dto, IHubContext<BoardHub> hub) =>
{
    if (!cards.TryGetValue(id, out var current)) return Results.NotFound();
    if (current.Version != dto.Version)
        return Results.Conflict(new { currentVersion = current.Version, current });

    var updated = current with { Title = dto.Title, Version = current.Version + 1 };
    // TryUpdate is a compare-and-swap: it fails if another request changed the card since we read it
    if (!cards.TryUpdate(id, updated, current))
        return Results.Conflict(new { currentVersion = cards[id].Version, current = cards[id] });

    await hub.Clients.Group($"board:{updated.BoardId}").SendAsync("CardChanged",
        new { id = updated.Id, version = updated.Version, changes = new { title = updated.Title } });
    return Results.Ok(updated);
});

app.Run();

record Card(Guid Id, Guid BoardId, string Title, int Version);
record CardUpdate(string Title, int Version);

class BoardHub : Hub
{
    public Task JoinBoard(Guid boardId) => Groups.AddToGroupAsync(Context.ConnectionId, $"board:{boardId}");
}
```

:::tip title="With EF Core instead"
Mark `Version` as a concurrency token (`[ConcurrencyCheck]`, or map PostgreSQL's `xmin`). EF Core then adds
`WHERE "Version" = @original` to the `UPDATE`, and `SaveChangesAsync` throws `DbUpdateConcurrencyException` when
another request won the race — catch it and return the 409. Checking `card.Version != dto.Version` in C# alone is
not enough: two requests can both pass the check before either saves.
:::

Run it on a fixed port and check the API and the conflict rule from a second terminal:

```bash
dotnet run --urls http://localhost:5000

curl -s http://localhost:5000/api/boards/00000000-0000-0000-0000-000000000042/cards
# [{"id":"00000000-0000-0000-0000-000000000001","boardId":"…0042","title":"Login page","version":1}, …]

curl -s -o /dev/null -w "%{http_code}\n" -X PUT http://localhost:5000/api/cards/00000000-0000-0000-0000-000000000001 \
  -H 'Content-Type: application/json' -d '{"title":"Login v2","version":1}'
# 200
# run the same command again (still claiming version 1):
# 409
```

**Client**:

1. `npm i @microsoft/signalr`
2. In `vite.config.ts`, proxy the API and the hub (with WebSocket support) so the browser sees one origin:
   `server: { proxy: { '/api': 'http://localhost:5000', '/hubs': { target: 'http://localhost:5000', ws: true } } }`
3. Load the cards with `useQuery({ queryKey: ['board', boardId], queryFn: … })` from
   `/api/boards/00000000-0000-0000-0000-000000000042/cards`, and render each title with an editor like the
   `ProjectNameEditor` from this lesson (sending `PUT /api/cards/{id}` with `{ title, version }`).
4. Write `useBoardRealtime(boardId)` as shown in this lesson, using your `createRetryPolicy` and `boardReducer`
   logic (or `setQueryData` with `applyRemotePatch`). This server has no auth, so leave out `accessTokenFactory`.
5. Render a status pill: `Live` / `Reconnecting…` / `Offline` (`role="status"`).
6. Open the board in two browser windows. Rename a card in one; watch it change in the other within a second.
7. Stop the API (`Ctrl+C`): the pill switches to `Reconnecting…`. Start it again: the pill returns to `Live` and the
   board refetches (DevTools → Network shows a new `negotiate` request, a new WebSocket whose Messages tab contains
   the `JoinBoard` invocation, and a fresh `GET …/cards`).
8. Start editing the **same** card in both windows. Save in A first, then save in B. B's editor still holds the
   version it started from, so the server answers 409 and B must show your conflict banner instead of silently
   overwriting A.

- [ ] `curl` shows 200 for the first PUT and 409 for the stale one
- [ ] A change in window A appears in window B without a refresh
- [ ] Restarting the API shows `Reconnecting…`, then `Live`, and the board re-syncs (group rejoined, cards refetched)
- [ ] A stale save produces a 409 and the conflict banner, not a lost update
- [ ] Duplicate or old `CardChanged` messages are ignored (verified with a unit test on the reducer)
:::

## Recap

- **Optimistic updates** (mechanics from the server-state lesson) on a shared board must tell a **409** (show the
  conflict) apart from a network failure (roll back + retry). `useOptimistic` gives optimism without a data
  library: the guess lives only while the Action is pending, so there is nothing to roll back.
- **Optimistic concurrency**: every write carries the version it was based on; the server rejects stale writes with
  **409** (or 412 for `If-Match`). The UI offers reload / overwrite / merge — never a silent lost update.
- **Three-way merge** (base / mine / theirs) resolves non-overlapping edits automatically.
- **SSE** for one-way feeds, **WebSockets** for custom duplex, **SignalR** for ASP.NET Core apps (fallbacks,
  reconnect, groups, auth).
- After reconnecting: **rejoin groups and re-sync** — missed messages are not replayed.
- Remote patches carry **versions**: ignore stale/duplicate, apply next, refetch on gaps.
- More than one server: add a **Redis backplane** (or Azure SignalR Service), enable **sticky sessions**, and keep
  presence in a shared store with TTLs. Scale-in drops connections — jittered reconnects make it harmless.
- Effects that open connections must ignore callbacks from a **disposed** connection (StrictMode, prop changes)
  and depend only on **stable** functions.
- Reconnect and retry with **exponential backoff + jitter**; retry only retryable failures.
- Offline queues are **persisted, ordered, coalesced and idempotent**.

:::cards id=fe-24-cards1 xp=15 title="Real-time & resilience"
Q: What is the lost update problem?
A: Two clients edit the same version; the second save overwrites the first without anyone noticing.
Q: How does optimistic concurrency prevent it?
A: Each write includes the version it was based on; the server rejects it (409/412) if the row has moved on.
Q: Which HTTP headers carry versions in the standard way?
A: `ETag` on the response, `If-Match` on the write; a failed precondition is `412 Precondition Failed`.
Q: Three ways to resolve a 409 in the UI?
A: Reload theirs, overwrite with mine (using their version), or merge field by field.
Q: SSE vs WebSocket in one sentence?
A: SSE is a one-way server→client stream over plain HTTP with built-in reconnect; WebSocket is a full-duplex socket.
Q: What must you do in SignalR's `onreconnected`?
A: Rejoin groups (new connection id) and re-sync data, because messages sent while disconnected are lost.
Q: Why add jitter to backoff?
A: To spread retries out so thousands of clients don't hammer a recovering server in synchronised waves.
Q: How should a remote patch reducer treat `version <= current`?
A: Ignore it and return the same state — it's a duplicate or out-of-order message.
Q: What makes an offline replay safe from duplicates?
A: An idempotency key per mutation that the server remembers.
Q: Why does SignalR need a backplane with several server instances?
A: A broadcast only reaches connections on the instance that sent it; the backplane (Redis pub/sub) fans it out to every instance.
Q: When does SignalR need sticky sessions?
A: With a load balancer in front of several instances — negotiate and the transport must hit the same instance — unless all clients use WebSockets with `skipNegotiation`, or Azure SignalR Service holds the connections.
Q: Coalescing key vs idempotency key?
A: Coalescing key = which target a write affects, so the client can merge pending writes. Idempotency key = unique id per write, so the server can detect a replay.
:::
