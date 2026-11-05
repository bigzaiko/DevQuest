---
id: fe-11
title: Effects & Data Fetching
level: intermediate
minutes: 45
xp: 160
summary: What useEffect is really for, dependency arrays, cleanup, Strict Mode's double run, race conditions in fetching, loading/error states — and when you don't need an effect at all.
---

`useEffect` is the most misused hook in React. Most bugs blamed on React — infinite loops, stale
data, flickering, double requests — come from treating effects as "code that runs after render" or
"React's lifecycle methods". This lesson gives you the right mental model first, then the patterns.

## The mental model: synchronise with something outside React

Rendering must be **pure**: given the same props and state, a component returns the same JSX and
changes nothing outside itself. React relies on this, because it may render a component several
times, throw a render away, or render ahead of time. But apps need to touch things React doesn't manage: the document title, a
WebSocket, a browser API, a timer, a third-party map widget, the network. An **effect** is how a
component says:

> "Whenever I'm on screen with *these* values, the outside system should be in sync with them.
> Here's how to start syncing, and here's how to stop."

```tsx
import { useEffect, useState } from 'react'

function ChatRoom({ roomId }: { roomId: string }) {
  useEffect(() => {
    const connection = createConnection(roomId)   // start syncing
    connection.connect()
    return () => connection.disconnect()          // stop syncing (cleanup)
  }, [roomId])                                    // re-sync when roomId changes

  return <h1>Welcome to {roomId}</h1>
}
```

Think in terms of **start/stop**, not "mount/update/unmount":

1. After the component renders and the DOM is committed, React runs the effect (setup).
2. When `roomId` changes, React runs the **cleanup** from the previous render (disconnect from the
   old room), then the setup with the new value (connect to the new room).
3. When the component leaves the screen, React runs the cleanup one last time.

## The dependency array

The second argument says **which values the effect uses** — React re-runs it when any of them changed
(compared with `Object.is`):

```tsx
useEffect(() => { … })            // after EVERY render (rarely what you want)
useEffect(() => { … }, [])        // once after mount (+ cleanup on unmount)
useEffect(() => { … }, [a, b])    // after mount and whenever a or b changed
```

The dependency array isn't something you *choose* — it's determined by the code. Every reactive
value (props, state, and anything computed from them) used inside the effect must be listed. The
ESLint rule `react-hooks/exhaustive-deps` checks this; treat its warnings as errors. If you don't
want an effect to re-run for some value, change the code so it doesn't need that value — don't lie
in the array. A value you leave out is **stale**: the effect keeps seeing the value from the render
in which it last ran.

Setter functions from `useState` and refs from `useRef` are stable (always the same object), so
listing them is harmless and the linter doesn't require them.

:::tip title="Reading a value without re-syncing: useEffectEvent"
Sometimes an effect needs the *latest* value of something without reconnecting when it changes. For
example, a chat effect re-syncs on `roomId` but should only *read* the current `theme` when it shows
a "connected" toast. React 19.2 added `useEffectEvent` for this. Wrap the non-reactive part in an
effect event and call it from the effect:
`const onConnected = useEffectEvent(() => showToast('Connected', theme))`. The effect depends on
`[roomId]` only, and `onConnected` always sees the current `theme`. Effect events are only for
calling from inside effects, never as event handlers in JSX.
:::

:::warn title="Objects and functions as dependencies"
`useEffect(() => { … }, [options])` where `options = { roomId }` is created during render gives a
**new object every render** → `Object.is` says "changed" → the effect re-runs on every render. If
the effect also sets state, that's an infinite loop. Depend on primitives (`roomId`), move the
object creation *inside* the effect, or memoise it with `useMemo`/`useCallback`.
:::

:::quiz id=fe-11-q1 xp=15
What happens with this component?

```tsx
function Profile({ userId }: { userId: number }) {
  const [user, setUser] = useState<User | null>(null)
  useEffect(() => {
    fetchUser(userId).then((u) => setUser(u))
  })
  return <p>{user?.name}</p>
}
```

- [ ] It fetches once
- [ ] It fetches whenever `userId` changes
- [x] It fetches after every render; each `setUser` with a new object causes another render — an endless request loop
- [ ] React throws "missing dependency array"
> No dependency array = run after every render. The fetched user is a new object every time, so
> `setUser` always triggers a re-render, which runs the effect again, and so on forever. "It fetches
> whenever `userId` changes" is what you *meant*, and you only get it by writing `[userId]`. React
> doesn't throw, because leaving the array out is valid (and occasionally intended).
:::

:::challenge id=fe-11-c1 lang=tsx xp=30 preview=Demo
title: Sync the document title
`InboxTitle({ unread })` renders `<p>{unread} unread</p>` and keeps `document.title` in sync:
`Inbox (3)` when there are unread messages, just `Inbox` when there are none. The starter only sets
it once — make it follow the prop.

hint: The effect uses `unread`, so `unread` belongs in the dependency array.

```tsx starter
import { useEffect, useState } from 'react'

export function InboxTitle({ unread }: { unread: number }) {
  useEffect(() => {
    document.title = `Inbox (${unread})`
  }, [])
  return <p>{unread} unread</p>
}

export function Demo() {
  const [n, setN] = useState(2)
  return (
    <div>
      <InboxTitle unread={n} />
      <button onClick={() => setN(n + 1)}>New mail</button>
      <button onClick={() => setN(0)}>Read all</button>
    </div>
  )
}
```

```tsx solution
import { useEffect, useState } from 'react'

export function InboxTitle({ unread }: { unread: number }) {
  useEffect(() => {
    document.title = unread > 0 ? `Inbox (${unread})` : 'Inbox'
  }, [unread])
  return <p>{unread} unread</p>
}

export function Demo() {
  const [n, setN] = useState(2)
  return (
    <div>
      <InboxTitle unread={n} />
      <button onClick={() => setN(n + 1)}>New mail</button>
      <button onClick={() => setN(0)}>Read all</button>
    </div>
  )
}
```

```tsx tests
test('sets the title', () => {
  render(<InboxTitle unread={3} />)
  expect(document.title).toBe('Inbox (3)')
})
test('follows prop changes', () => {
  const { rerender } = render(<InboxTitle unread={3} />)
  rerender(<InboxTitle unread={7} />)
  expect(document.title).toBe('Inbox (7)')
  rerender(<InboxTitle unread={0} />)
  expect(document.title).toBe('Inbox')
})
```
:::

## Cleanup, and why Strict Mode runs effects twice

Any effect that *starts* something must *stop* it: unsubscribe, clear the timer, close the socket,
abort the request, remove the event listener.

```tsx
useEffect(() => {
  function onResize() { setWidth(window.innerWidth) }
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
}, [])

useEffect(() => {
  const id = setInterval(() => setSeconds((s) => s + 1), 1000)
  return () => clearInterval(id)
}, [])
```

In development, `<StrictMode>` **mounts every component, unmounts it, and mounts it again**
immediately. So you'll see: setup → cleanup → setup. It's a deliberate stress test: if your
effect is missing a cleanup, you'll notice two subscriptions, two intervals, two connections — in
development, instead of as a memory leak in production (where navigating back and forth would do
the same thing).

The question to ask is never "how do I make it run once?" but **"does my cleanup undo my setup?"**
If yes, setup → cleanup → setup is indistinguishable from a single setup for the user.

:::quiz id=fe-11-q2 xp=15
In development with `<StrictMode>`, this component mounts. What is logged?

```tsx
useEffect(() => {
  console.log('connect')
  return () => console.log('disconnect')
}, [])
```

- [ ] `connect`
- [x] `connect`, `disconnect`, `connect`
- [ ] `connect`, `connect`
- [ ] `disconnect`, `connect`
> Strict Mode simulates an immediate unmount + remount in development to verify that your cleanup
> really undoes the setup. Production builds run it once. `connect`, `connect` would mean React
> re-ran the setup *without* the cleanup, which React never does. Every re-run is preceded by the
> previous run's cleanup.
:::

:::challenge id=fe-11-c2 lang=tsx xp=50 preview=Demo
title: Connect, clean up, reconnect
`chatServer` (in the setup) tracks open connections in `chatServer.open`. Write `ChatRoom({ roomId })`
that connects with `chatServer.connect(roomId)` while it's on screen and disconnects properly:

- exactly **one** open connection per mounted `ChatRoom`, even under `<StrictMode>`
- switching `roomId` closes the old connection and opens the new one
- unmounting leaves no open connections

Render `<h2>Room: {roomId}</h2>`.

```tsx setup
const chatServer = {
  open: [] as string[],
  connect(roomId: string) {
    chatServer.open.push(roomId)
    let closed = false
    return {
      disconnect() {
        if (closed) return
        closed = true
        const i = chatServer.open.indexOf(roomId)
        if (i !== -1) chatServer.open.splice(i, 1)
      },
    }
  },
}
```

hint: `const conn = chatServer.connect(roomId)` inside the effect…
hint: …and `return () => conn.disconnect()`. Dependencies: `[roomId]`.

```tsx starter
import { useEffect, useState } from 'react'

export function ChatRoom({ roomId }: { roomId: string }) {
  useEffect(() => {
    chatServer.connect(roomId)
  }, [roomId])
  return <h2>Room: {roomId}</h2>
}

export function Demo() {
  const [room, setRoom] = useState('general')
  return (
    <div>
      <select value={room} onChange={(e) => setRoom(e.target.value)}>
        <option>general</option>
        <option>music</option>
      </select>
      <ChatRoom roomId={room} />
      <p>Open connections: {chatServer.open.join(', ')}</p>
    </div>
  )
}
```

```tsx solution
import { useEffect, useState } from 'react'

export function ChatRoom({ roomId }: { roomId: string }) {
  useEffect(() => {
    const conn = chatServer.connect(roomId)
    return () => conn.disconnect()
  }, [roomId])
  return <h2>Room: {roomId}</h2>
}

export function Demo() {
  const [room, setRoom] = useState('general')
  return (
    <div>
      <select value={room} onChange={(e) => setRoom(e.target.value)}>
        <option>general</option>
        <option>music</option>
      </select>
      <ChatRoom roomId={room} />
      <p>Open connections: {chatServer.open.join(', ')}</p>
    </div>
  )
}
```

```tsx tests
beforeEach(() => { chatServer.open = [] })
test('one connection under StrictMode', () => {
  render(<React.StrictMode><ChatRoom roomId="general" /></React.StrictMode>)
  expect(screen.getByRole('heading')).toHaveTextContent('Room: general')
  expect(chatServer.open).toEqual(['general'])
})
test('switching rooms reconnects', () => {
  const { rerender } = render(<ChatRoom roomId="general" />)
  rerender(<ChatRoom roomId="music" />)
  expect(chatServer.open).toEqual(['music'])
})
test('unmount disconnects', () => {
  const { unmount } = render(<ChatRoom roomId="general" />)
  unmount()
  expect(chatServer.open).toEqual([])
})
```
:::

## Fetching data in an effect

Fetching is "synchronising with the server": while this component shows user `id`, the data
should be user `id`'s. Here's the naive version — and its bug:

```tsx
function UserCard({ userId }: { userId: number }) {
  const [user, setUser] = useState<User | null>(null)
  useEffect(() => {
    fetchUser(userId).then(setUser)    // 🐛 race condition
  }, [userId])
  // …
}
```

**The race.** The user clicks user 1, then quickly user 2. Two requests are in flight. If user 1's
response is slower, it arrives *last* and overwrites user 2's data: the screen says "user 2" in the
URL but shows user 1. The fix: when the effect is cleaned up (because `userId` changed or the
component unmounted), make sure its result is **ignored** — or better, **abort** the request.

```tsx
useEffect(() => {
  let ignore = false
  setStatus('loading')
  fetchUser(userId)
    .then((u) => { if (!ignore) { setUser(u); setStatus('success') } })
    .catch((err) => { if (!ignore) { setError(err.message); setStatus('error') } })
  return () => { ignore = true }
}, [userId])

// with AbortController — also cancels the network request itself
useEffect(() => {
  const controller = new AbortController()
  fetch(`/api/users/${userId}`, { signal: controller.signal })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)   // fetch does NOT reject on 404/500
      return r.json()
    })
    .then(setUser)
    .catch((err) => { if (err.name !== 'AbortError') setError(err.message) })
  return () => controller.abort()
}, [userId])
```

Each effect run has its own `ignore` variable (a closure), so the cleanup flips the flag of *that*
run only. Under Strict Mode, the first request is ignored/aborted immediately and the second one wins
— exactly right.

Two details in the `AbortController` version trip people up:

- **`fetch` only rejects on network failure** (offline, DNS, CORS, abort). A `404` or `500` is a
  *successful* fetch whose `response.ok` is `false`. If you don't check `r.ok`, your ASP.NET API's
  error body (often a `ProblemDetails` JSON) is treated as user data.
- **Aborting rejects the promise with an `AbortError`.** That's expected, not a failure, so filter
  it out. Otherwise every quick switch between users flashes a scary "aborted" error.

And don't forget the states: **loading** (including when the id changes), **error**, **success**.

:::quiz id=fe-11-q4 xp=15
`GET /api/users/99` returns `404` with a `ProblemDetails` body
`{ "title": "Not Found", "status": 404 }`. What does this code do?

```tsx
fetch('/api/users/99')
  .then((r) => r.json())
  .then((user) => setUser(user))
  .catch(() => setError('Could not load user'))
```

- [ ] The `.catch` runs and the error message is shown
- [x] `setUser` is called with the ProblemDetails object, and the UI tries to render it as a user
- [ ] `r.json()` throws because a 404 has no body
- [ ] The promise never settles
> `fetch` resolves for every HTTP response, error statuses included. It only rejects when no response
> arrives (network error, abort). The body is valid JSON, so `r.json()` succeeds and the error object
> lands in `user`. The `.catch` is what you'd expect from axios-style clients, which throw on 4xx/5xx,
> but `fetch` doesn't. Check `if (!r.ok) throw new Error(...)` before parsing.
:::

:::quiz id=fe-11-q5 xp=15
A user page fetches in `useEffect(..., [userId])` **without** a cleanup. The user clicks user 1, then
quickly user 2. User 1's request takes 900 ms, user 2's takes 100 ms. What does the screen show
after one second?

- [ ] User 2, because the effect for user 2 ran last
- [x] User 1, because its response arrived last and its `setUser` overwrote user 2
- [ ] User 2, because React cancels the first effect's promise when `userId` changes
- [ ] An error, because React forbids two requests in flight
> State shows whichever `setUser` ran *last*, and that's the slower, outdated response for user 1.
> React does not cancel anything for you. It only calls the cleanup you return, so with no cleanup
> nothing stops the old request. Set an `ignore` flag or call `controller.abort()` in the cleanup,
> and the old run's result is discarded.
:::

:::challenge id=fe-11-c3 lang=tsx xp=70 preview=Demo
title: Race-free user card
Write `UserCard({ userId })` using the fake `fetchUser(id, signal?)` from the setup (user `1` is slow,
user `2` is fast, user `404` fails; it rejects with an `AbortError` if the signal is aborted):

- while loading (initially **and** whenever `userId` changes): `<p>Loading…</p>`
- success: `<h2>` with the user's name
- failure: `<p role="alert">` with `Error: <message>`
- a slow, outdated response must **never** overwrite a newer one

hint: Keep one state object: `{ status: 'loading' } | { status: 'success'; user } | { status: 'error'; message }`.
hint: Set `{ status: 'loading' }` at the start of the effect; guard every later `setState` with an `ignore` flag (or check for `AbortError`).

```tsx setup
type User = { id: number; name: string }
const delays: Record<number, number> = { 1: 150, 2: 20, 404: 30 }
function fetchUser(id: number, signal?: AbortSignal): Promise<User> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (id === 404) reject(new Error('User not found'))
      else resolve({ id, name: `User ${id}` })
    }, delays[id] ?? 50)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}
```

```tsx starter
import { useEffect, useState } from 'react'

export function UserCard({ userId }: { userId: number }) {
  const [user, setUser] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchUser(userId).then(setUser).catch((e) => setError(e.message))
  }, [userId])

  if (error) return <p role="alert">Error: {error}</p>
  if (!user) return <p>Loading…</p>
  return <h2>{user.name}</h2>
}

export function Demo() {
  const [id, setId] = useState(1)
  return (
    <div>
      {[1, 2, 404].map((n) => <button key={n} onClick={() => setId(n)}>User {n}</button>)}
      <UserCard userId={id} />
    </div>
  )
}
```

```tsx solution
import { useEffect, useState } from 'react'

type State =
  | { status: 'loading' }
  | { status: 'success'; user: User }
  | { status: 'error'; message: string }

export function UserCard({ userId }: { userId: number }) {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let ignore = false
    setState({ status: 'loading' })
    fetchUser(userId)
      .then((user) => { if (!ignore) setState({ status: 'success', user }) })
      .catch((err) => { if (!ignore) setState({ status: 'error', message: err.message }) })
    return () => { ignore = true }
  }, [userId])

  if (state.status === 'loading') return <p>Loading…</p>
  if (state.status === 'error') return <p role="alert">Error: {state.message}</p>
  return <h2>{state.user.name}</h2>
}

export function Demo() {
  const [id, setId] = useState(1)
  return (
    <div>
      {[1, 2, 404].map((n) => <button key={n} onClick={() => setId(n)}>User {n}</button>)}
      <UserCard userId={id} />
    </div>
  )
}
```

```tsx tests
test('loading then data', async () => {
  render(<UserCard userId={2} />)
  expect(screen.getByText('Loading…')).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'User 2' })).toBeInTheDocument()
})
test('error state', async () => {
  render(<UserCard userId={404} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Error: User not found')
})
test('shows loading again when the id changes', async () => {
  const { rerender } = render(<UserCard userId={2} />)
  await screen.findByRole('heading', { name: 'User 2' })
  rerender(<UserCard userId={1} />)
  expect(screen.getByText('Loading…')).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'User 1' })).toBeInTheDocument()
})
test('a slow old response never wins', async () => {
  const { rerender } = render(<UserCard userId={1} />)
  rerender(<UserCard userId={2} />)
  await sleep(250)
  expect(screen.getByRole('heading')).toHaveTextContent('User 2')
})
```
:::

## You might not need an effect

Effects are an escape hatch for *external* systems. Many effects in real code bases synchronise
React with… React — and every one of them is slower and buggier than the alternative.

| You wrote | Do this instead |
|---|---|
| `useEffect(() => setFullName(first + ' ' + last), [first, last])` | Compute during render: `const fullName = …` |
| `useEffect(() => setVisible(items.filter(…)), [items, query])` | Compute during render (`useMemo` if it's truly expensive) |
| An effect that resets state when a prop changes | Give the component a `key={id}` |
| An effect that reacts to a button click (`useEffect(() => { if (submitted) post() }, [submitted])`) | Do it in the **event handler** |
| An effect that notifies the parent (`useEffect(() => onChange(value), [value])`) | Call `onChange` in the same handler that sets `value` |
| Fetching on mount in every component | A data library (TanStack Query) or your framework's loader |

The `key` row deserves an example. A comment box should start empty for every post. Instead of an
effect that clears the draft when `postId` changes, give the component a key. A different key makes
React treat it as a **different component**, so it throws away the old state and mounts a fresh one:

```tsx
<CommentBox key={postId} postId={postId} />   // new postId → brand-new CommentBox, empty draft
```

Why it matters: an effect-based derived value renders **twice** (first with the stale value, then
again after the effect's `setState`) — a visible flicker and wasted work, and a chain of such
effects becomes very hard to follow.

The question to ask: *"Why does this code run?"* Because **the component is displayed** → effect.
Because **the user did something** → event handler. Because **some other value changed** → compute it.

:::challenge id=fe-11-c4 lang=tsx xp=40 preview=Demo
title: Remove the unnecessary effect
`FilteredList` keeps the filtered items in state and syncs them with an effect. That costs an extra
render every time (the setup counts renders in `renderLog.count` — think of it as a mini React
Profiler). Rewrite it so the filtered list is **computed during render**: one render on mount and
one render per keystroke. The input is labelled `Filter`; matching is case-insensitive.

hint: Delete the `visible` state and the effect.
hint: `const visible = items.filter((i) => i.toLowerCase().includes(query.toLowerCase()))`

```tsx setup
const renderLog = { count: 0 }
```

```tsx starter
import { useEffect, useState } from 'react'

export function FilteredList({ items }: { items: string[] }) {
  renderLog.count++
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState<string[]>([])

  useEffect(() => {
    setVisible(items.filter((i) => i.toLowerCase().includes(query.toLowerCase())))
  }, [items, query])

  return (
    <div>
      <label>Filter <input value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <ul>{visible.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  )
}

export function Demo() {
  return <FilteredList items={['React', 'Redux', 'Vite', 'Vitest', 'TypeScript']} />
}
```

```tsx solution
import { useState } from 'react'

export function FilteredList({ items }: { items: string[] }) {
  renderLog.count++
  const [query, setQuery] = useState('')
  const visible = items.filter((i) => i.toLowerCase().includes(query.toLowerCase()))

  return (
    <div>
      <label>Filter <input value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      <ul>{visible.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  )
}

export function Demo() {
  return <FilteredList items={['React', 'Redux', 'Vite', 'Vitest', 'TypeScript']} />
}
```

```tsx tests
const langs = ['React', 'Redux', 'Vite', 'Vitest', 'TypeScript']
beforeEach(() => { renderLog.count = 0 })
test('filters case-insensitively', async () => {
  render(<FilteredList items={langs} />)
  await user.type(screen.getByLabelText('Filter'), 'VIT')
  expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Vite', 'Vitest'])
})
test('renders once on mount', () => {
  render(<FilteredList items={langs} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(5)
  expect(renderLog.count).toBe(1)
})
test('renders once per keystroke', async () => {
  render(<FilteredList items={langs} />)
  renderLog.count = 0
  await user.type(screen.getByLabelText('Filter'), 're')
  expect(renderLog.count).toBe(2)
})
```
:::

:::quiz id=fe-11-q3 xp=10
After a successful "Buy" click you want to show a toast and send an analytics event. Where should
that code go?

- [ ] `useEffect(() => { if (bought) { toast(); track() } }, [bought])`
- [x] In the click handler, after the purchase request succeeds
- [ ] In the component body, during render
> It happens *because the user clicked*, so it belongs in the event handler. The effect version is
> tempting because it "works" in a quick test, but it re-fires in surprising situations (the Strict
> Mode remount in dev, or the component re-mounting while `bought` is still true), so you get double
> toasts and double analytics events. The render body is worse still: rendering must be pure, and it
> would run on *every* render.
:::

:::info title="Where data fetching is heading"
Effects work for fetching, but you've just seen how much care they need: race conditions, loading
resets, cleanup, no caching, no deduplication, waterfalls (child fetches start only after the parent
rendered). That's why production apps typically use **TanStack Query** (`useQuery({ queryKey: ['user', id], queryFn })`)
or a framework's route loaders, and React 19's `use(promise)` with **Suspense** for
promise-driven rendering. (The promise passed to `use` must come from outside the render, for example
a loader or cache. A `fetch()` created during render is a new promise on every render, so the component
suspends again each time it retries.) Everything you learned here is what those tools do for you internally.
Suspense for data, together with error boundaries, gets its own treatment in the **Failing well** lesson.
:::

:::job title="Effects in code review"
- Every `useEffect` gets the question "what external system is this syncing with?" No answer → it probably shouldn't be an effect.
- Missing cleanup for listeners, timers, sockets or requests → bug.
- `// eslint-disable-next-line react-hooks/exhaustive-deps` → expect pushback; fix the code instead.
- `useEffect(async () => …)` is wrong (an effect must return a cleanup function or nothing, not a promise). Define an async function inside and call it.
:::

:::pro title="useLayoutEffect, briefly"
`useEffect` normally runs after the browser has painted. `useLayoutEffect` runs after the DOM update but
**before** paint — use it only when you must measure the DOM and re-render before the user sees a
flicker (tooltips positioning themselves, for example). It blocks painting, so it's the exception.
:::

:::cards id=fe-11-cards1 xp=15 title="Effects & fetching"
Q: What is an effect for?
A: Synchronising a component with an external system (network, DOM APIs, subscriptions, timers) while it's on screen.
Q: When does the cleanup run?
A: Before the effect re-runs with new dependencies, and when the component unmounts.
Q: `[]` vs no array vs `[a, b]`?
A: Once after mount / after every render / after mount and whenever a or b change.
Q: Why does Strict Mode run setup → cleanup → setup?
A: To prove your cleanup undoes your setup. Dev only.
Q: How do you prevent a stale fetch response from overwriting newer data?
A: An `ignore` flag set in the cleanup, or abort the request with AbortController in the cleanup.
Q: Why are object dependencies dangerous?
A: A new object each render is "changed" by `Object.is`, so the effect re-runs every render (possibly looping).
Q: Derived value via effect — what's wrong?
A: An extra render with stale data and more code. Compute it during render.
Q: Code that runs because the user clicked belongs where?
A: In the event handler, not an effect.
Q: Why not `useEffect(async () => …)`?
A: An async function returns a promise; effects must return a cleanup function or nothing.
Q: Does `fetch` reject on a 404 or 500?
A: No. It only rejects on network failure or abort. Check `response.ok` and throw yourself.
Q: How do you reset a component's state when a prop like `postId` changes?
A: Render it with `key={postId}`. A new key mounts a fresh instance with fresh state, no effect needed.
Q: What is `useEffectEvent` for?
A: Reading the latest props/state inside an effect without making them dependencies (React 19.2+). Call it only from effects.
:::

## Recap

- Effects synchronise with **external** systems: start in the setup, stop in the cleanup.
- Dependencies are dictated by the code; list every reactive value the effect uses.
- Strict Mode's setup → cleanup → setup in dev verifies your cleanup.
- Fetching in effects needs loading/error states and protection against races (`ignore` flag or `AbortController`).
- `fetch` doesn't reject on HTTP errors: check `response.ok`. Ignore `AbortError`s from your own cleanup.
- Don't use effects for derived data, resets (use `key`) or reactions to user events (use handlers).
- In production apps, a data-fetching library usually replaces hand-written fetch effects.
