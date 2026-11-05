---
id: fe-29
title: "Failing Well: Error Boundaries, Suspense & Production Errors"
level: advanced
minutes: 85
xp: 150
summary: Contain crashes with error boundaries, design loading/empty/error/retry states, map ProblemDetails to the right UI, and report production errors with source maps, releases and correlation ids.
---

Every app fails. The API returns 500, the Wi-Fi drops in a tunnel, a deploy ships a `undefined.map`, a chunk
404s because the user kept a tab open across a release. Users don't judge you by whether things fail — they judge
you by **what they see when it does**, and your team judges you by **whether you find out** before the support
tickets arrive.

"Failing well" has two audiences:

- **The user** needs a contained failure (one broken widget, not a white screen), a clear message in the right
  place, a way to recover (retry, fix the field, reload), and their work kept.
- **The developer** needs the error *reported*, with a readable stack trace (source maps), the release it
  happened in, and an id that links the browser error to the backend logs.

This lesson builds on several neighbours: **Lists, Keys & Conditional Rendering** (the four states),
**Routing with React Router** (`errorElement`), **Server State with TanStack Query** (retries and
caching), **React Performance** (`lazy` + `Suspense` for code) and **Real-time & Resilient UI** (jitter and the
409 conflict flow). Here we tie them into one error strategy.

## The mental model: where can an error go?

A thrown error in a React app ends up in one of three places, and which one depends on **when** it was thrown:

| Thrown during… | Example | Where it goes |
|---|---|---|
| **Rendering** (component body, `use()`, lifecycle, effects) | `project.owner.name` when `owner` is `null` | The nearest **error boundary** above the component |
| **An event handler** | `onClick={() => save()}` where `save` throws synchronously | Nowhere in React — it's a normal JS exception; bubbles to `window.onerror` |
| **Async code** (`setTimeout`, a promise nobody `await`s) | `fetch(...).then(r => r.json())` rejects | `unhandledrejection` on `window` — React never sees it |

Why the split? An error boundary is React's answer to the question *"this part of the tree can't be drawn — what
do I draw instead?"* That question only exists **while React is rendering**. An event handler runs *after* the
render, when the UI on screen is already valid; a crash in it doesn't leave React with a half-built tree, so
there's nothing to replace. Async code runs on a later tick, outside React's call stack entirely.

Since React 16, an error during rendering that **no** boundary catches unmounts the **whole root**. That's the
infamous white screen. It is deliberate: React would rather show nothing than show a corrupt UI (a bank balance
from the wrong account, a "Delete" button wired to the wrong item).

## Error boundaries

An error boundary is a component that implements one or both of these class lifecycles:

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { fallback: ReactNode; children: ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  // 1. Render phase: "an error happened below me — what's my next state?" Must be pure.
  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  // 2. Commit phase: side effects allowed — this is where you report.
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, { componentStack: info.componentStack })
  }

  render() {
    return this.state.error ? this.props.fallback : this.props.children
  }
}
```

Yes, a class. In React 19 there is still **no hook equivalent** of `getDerivedStateFromError` /
`componentDidCatch`, so a function component cannot be a boundary (the React docs say so explicitly). Almost every team
uses the small [`react-error-boundary`](https://github.com/bvaughn/react-error-boundary) package instead of
writing this by hand — but you should write it once (challenge below) so the library is no longer magic.

What a boundary **catches**: errors thrown while rendering any descendant, in descendants' lifecycle methods and
effects, and promises rejected while suspended in `use()` / `lazy()`.

What it **doesn't catch**:

- errors in **event handlers** (`onClick`, `onSubmit`, …),
- errors in **async code** (`setTimeout`, `.then`, an `async` function nobody awaited),
- errors thrown **by the boundary itself** (its own `render`/fallback) — those go to the *next* boundary up,
- errors during server-side rendering that are handled by the server framework instead.

:::quiz id=fe-29-q1 xp=15
Which of these errors will be caught by an `<ErrorBoundary>` wrapped around `<Dashboard />`? (Select all that apply.)

```tsx
function Dashboard({ stats }: { stats: Stats | null }) {
  useEffect(() => { if (!stats) throw new Error('A') }, [stats])       // A
  const total = stats!.items.length                                     // B (stats is null)
  return (
    <button onClick={() => { throw new Error('C') }}>                  {/* C */}
      {total}
      {void fetch('/api/x').then(() => { throw new Error('D') })}       {/* D */}
    </button>
  )
}
```

- [x] A — thrown inside `useEffect`
- [x] B — `TypeError` while rendering
- [ ] C — thrown in the `onClick` handler
- [ ] D — thrown in a `.then` callback
> Boundaries catch errors React encounters while **rendering, committing and running effects** for the subtree, so
> A and B are caught. C is the tempting one: the handler *is* defined inside the component, but it runs later, from
> a browser event, after rendering finished — React only calls it, it doesn't catch around it. D runs on a later
> microtask, completely outside React; it surfaces as an `unhandledrejection` on `window`. (Also: never start a
> fetch in render — D is a bug twice.)
:::

### Getting handler and async errors into a boundary

Sometimes an event-handler failure *should* replace the panel — for example "Import file" failed in a way that
leaves the widget in an unknown state. You hand the error to React by setting state; React re-throws it
during the next render, where the boundary sees it:

```tsx
import { useErrorBoundary } from 'react-error-boundary'

function ImportButton() {
  const { showBoundary } = useErrorBoundary()
  async function onImport(file: File) {
    try {
      await importFile(file)
    } catch (error) {
      showBoundary(error)    // nearest <ErrorBoundary> renders its fallback
    }
  }
  // …
}
```

Without the library, the same trick is `const [, setState] = useState(); setState(() => { throw error })` — React
processes updater functions while it re-renders the component, so the throw happens where boundaries can see it.
(That is exactly what `useErrorBoundary` does internally: it keeps the error in state and throws it on render.)

But most handler failures should **not** blow away the UI. A failed "Save" is an expected outcome: catch it, keep
the user's input, show the message next to the form. Reach for `showBoundary` only when the component genuinely
can't continue.

:::quiz id=fe-29-q2 xp=15
A teammate wants a failed `DELETE` in a click handler to show the panel's error fallback. Which change actually
makes the error boundary render its fallback?

- [ ] Wrap the handler body in `try/catch` and `throw error` again in the `catch`
- [ ] Mark the handler `async` so React awaits it
- [x] Call `showBoundary(error)` from `useErrorBoundary()` (or `setState(() => { throw error })`)
- [ ] Wrap the `<button>` in its own `<ErrorBoundary>`
> Boundaries only see errors thrown **during rendering**. Re-throwing from the `catch` is still inside the event
> handler, so it goes to `window`, not to React. React never awaits handlers, so `async` just turns the throw into
> an unhandled rejection. Moving the boundary closer doesn't help either: the error still isn't thrown during render.
> `showBoundary` stores the error in state; on the next render it is thrown where the boundary can catch it.
:::

### Recovering: reset and `resetKeys`

A fallback with no way out is a dead end. A boundary needs a **reset**: clear its error state and render the
children again. Two triggers matter:

1. **The user asks** — a "Try again" button in the fallback calls `resetErrorBoundary()`.
2. **The input changed** — the user navigated from project 1 (corrupt data, crashed) to project 2. Retrying with
   *new* props is very likely to work, so the boundary should reset by itself. That's `resetKeys`: an array that
   the boundary compares element-by-element on every update; if any element changed while it's showing a
   fallback, it resets.

```tsx
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'

function PanelError({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div role="alert">
      <p>This panel couldn't be displayed.</p>
      <button onClick={resetErrorBoundary}>Try again</button>
    </div>
  )
}

<ErrorBoundary
  FallbackComponent={PanelError}
  resetKeys={[projectId]}                 // new project → automatic reset
  onReset={() => queryClient.resetQueries({ queryKey: ['projects', projectId] })}
>
  <ProjectDetails id={projectId} />
</ErrorBoundary>
```

Resetting only re-renders. If the cause was **cached** (a rejected promise in a cache, a bad value in a store),
the same error comes straight back. `onReset` is where you clear that cause.

:::tip title="key vs resetKeys"
`<ErrorBoundary key={projectId}>` also resets on navigation — by remounting the boundary *and all its children*,
throwing away their state. `resetKeys` resets only when the boundary is actually in the error state, and keeps
the healthy subtree mounted otherwise. Prefer `resetKeys`; use `key` when you *want* fresh state per item anyway.
:::

### Where to put boundaries

Think in **blast radius**. A boundary decides how much of the screen is lost when something below it fails.

- **Root boundary** (around `<App />`): last line of defence. Full-page "Something went wrong" + "Reload". It
  should almost never show.
- **Route / layout boundary**: the page content fails, but the navigation shell keeps working so the user can go
  elsewhere. In React Router that's an `errorElement` on child routes (see **Routing with React Router**).
- **Widget boundary**: around independent pieces — a chart, a comments panel, a third-party embed. A broken chart
  shouldn't take the invoice table with it.

Don't wrap every component: a boundary around a single `<Button>` hides bugs, and a page made of twenty tiny
"couldn't load" boxes is worse than one clear message.

:::challenge id=fe-29-c1 lang=tsx xp=70
title: An ErrorBoundary with reset and resetKeys
Implement the class component `ErrorBoundary` (no libraries) with this API, modelled on `react-error-boundary`:

- With no error, render `children` unchanged.
- `fallbackRender({ error, resetErrorBoundary })` — called to render the fallback **instead of** the children when a
  descendant threw while rendering. Content outside the boundary must keep rendering.
- `resetErrorBoundary()` — clears the error and renders the children again. If the child still throws, the
  fallback simply comes back.
- `onError?(error, info)` — called once the error is committed (`componentDidCatch`); `info.componentStack` is a string.
- `onReset?()` — called exactly once each time the boundary resets (button **or** `resetKeys`), and never
  when no reset happened.
- `resetKeys?: unknown[]` — if the boundary is showing a fallback and any element differs from the previous
  render's array (compare element by element with `Object.is`, and treat a different length as a change), reset.
  A *new array with the same values* must **not** reset.

The tests throw from a child component and click a "Try again" button inside the fallback.

hint: State is `{ error: Error | null }`. `static getDerivedStateFromError(error)` returns `{ error }`.
hint: `reset = () => { this.props.onReset?.(); this.setState({ error: null }) }` — an arrow-function class field, so `this` is bound when passed as `resetErrorBoundary`.
hint: In `componentDidUpdate(prevProps, prevState)` only reset when `prevState.error !== null` — otherwise the update that *sets* the error would immediately clear it again.

```tsx starter
import { Component, type ErrorInfo, type ReactNode } from 'react'

type FallbackProps = { error: Error; resetErrorBoundary: () => void }
type Props = {
  children?: ReactNode
  fallbackRender: (props: FallbackProps) => ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
  onReset?: () => void
  resetKeys?: unknown[]
}
type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  // TODO: getDerivedStateFromError, componentDidCatch, reset, resetKeys

  render() {
    return this.props.children
  }
}
```

```tsx solution
import { Component, type ErrorInfo, type ReactNode } from 'react'

type FallbackProps = { error: Error; resetErrorBoundary: () => void }
type Props = {
  children?: ReactNode
  fallbackRender: (props: FallbackProps) => ReactNode
  onError?: (error: Error, info: ErrorInfo) => void
  onReset?: () => void
  resetKeys?: unknown[]
}
type State = { error: Error | null }

function keysChanged(a: unknown[] = [], b: unknown[] = []) {
  return a.length !== b.length || a.some((item, i) => !Object.is(item, b[i]))
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info)
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    if (this.state.error !== null && prevState.error !== null && keysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset()
    }
  }

  reset = () => {
    this.props.onReset?.()
    this.setState({ error: null })
  }

  render() {
    if (this.state.error) {
      return this.props.fallbackRender({ error: this.state.error, resetErrorBoundary: this.reset })
    }
    return this.props.children
  }
}
```

```tsx tests
let bombArmed = true
function Bomb() {
  if (bombArmed) throw new Error('Widget exploded')
  return <p>Widget is fine</p>
}
const fallback = ({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) => (
  <div role="alert">
    <p>Error: {error.message}</p>
    <button onClick={resetErrorBoundary}>Try again</button>
  </div>
)
function Project({ id }: { id: number }) {
  if (id === 1) throw new Error('Project 1 is corrupt')
  return <p>Project {id}</p>
}
function ProjectHarness({ onReset }: { onReset?: () => void }) {
  const [id, setId] = useState(1)
  const [tick, setTick] = useState(0)
  return (
    <div>
      <button onClick={() => setId((n) => n + 1)}>Next project</button>
      <button onClick={() => setTick((n) => n + 1)}>Rerender {tick}</button>
      <ErrorBoundary resetKeys={[id]} onReset={onReset} fallbackRender={fallback}>
        <Project id={id} />
      </ErrorBoundary>
    </div>
  )
}
beforeEach(() => { bombArmed = true })

test('renders the children when nothing throws', () => {
  bombArmed = false
  render(<ErrorBoundary fallbackRender={fallback}><Bomb /></ErrorBoundary>)
  expect(screen.getByText('Widget is fine')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})
test('a throwing child shows the fallback; siblings outside survive', () => {
  render(
    <div>
      <h1>Header</h1>
      <ErrorBoundary fallbackRender={fallback}><Bomb /></ErrorBoundary>
    </div>,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('Error: Widget exploded')
  expect(screen.getByText('Header')).toBeInTheDocument()
})
test('onError receives the error and a component stack', () => {
  const onError = fn()
  render(<ErrorBoundary fallbackRender={fallback} onError={onError}><Bomb /></ErrorBoundary>)
  expect(onError).toHaveBeenCalled()
  const [error, info] = onError.mock.calls[0] as [Error, { componentStack: string }]
  expect(error.message).toBe('Widget exploded')
  expect(typeof info.componentStack).toBe('string')
})
test('"Try again" resets and re-renders the children', async () => {
  const onReset = fn()
  render(<ErrorBoundary fallbackRender={fallback} onReset={onReset}><Bomb /></ErrorBoundary>)
  bombArmed = false
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  expect(screen.getByText('Widget is fine')).toBeInTheDocument()
  expect(onReset).toHaveBeenCalledTimes(1)
})
test('resetting while the cause is still there shows the fallback again', async () => {
  render(<ErrorBoundary fallbackRender={fallback}><Bomb /></ErrorBoundary>)
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Error: Widget exploded')
})
test('a changed resetKey resets automatically', async () => {
  const onReset = fn()
  render(<ProjectHarness onReset={onReset} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Project 1 is corrupt')
  await user.click(screen.getByRole('button', { name: 'Next project' }))
  expect(screen.getByText('Project 2')).toBeInTheDocument()
  expect(onReset).toHaveBeenCalledTimes(1)
})
test('a new array with the same keys does NOT reset', async () => {
  const onReset = fn()
  render(<ProjectHarness onReset={onReset} />)
  await user.click(screen.getByRole('button', { name: /^Rerender/ }))
  await user.click(screen.getByRole('button', { name: /^Rerender/ }))
  expect(screen.getByRole('alert')).toHaveTextContent('Project 1 is corrupt')
  expect(onReset).not.toHaveBeenCalled()
})
```
:::

## Suspense: loading as part of the tree

An error boundary answers "what if this can't render?". `<Suspense>` answers the sibling question: "what if
this can't render **yet**?" They're designed as a pair:

```tsx
<ErrorBoundary FallbackComponent={PanelError}>      {/* it failed */}
  <Suspense fallback={<ProjectSkeleton />}>         {/* it isn't ready */}
    <ProjectDetails id={id} />                      {/* just render the happy path */}
  </Suspense>
</ErrorBoundary>
```

The payoff is that `ProjectDetails` no longer has `if (isLoading) … if (error) …` at the top — it reads its data
as if it were already there. The loading and error UI are decided by the **parent**, which knows the layout.

### Suspense for code

You've met this in **React Performance**: `lazy(() => import('./Chart'))` suspends until the chunk arrives. The
failure mode belongs here: if the chunk request fails, the lazy component **throws**, and only an error boundary
catches it. The most common cause in production is a **deploy**: the user's tab still references
`Chart-3f9a1c.js`, which no longer exists on the server. Vite fires a `vite:preloadError` event on `window` for
exactly this case:

```ts
// main.tsx — a new version was deployed under the user's feet: reload once to pick it up
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()                    // don't throw; we handle it
  if (!sessionStorage.getItem('reloaded-after-deploy')) {
    sessionStorage.setItem('reloaded-after-deploy', '1')
    window.location.reload()
  }
})
```

(The `sessionStorage` flag stops an endless reload loop if the chunk is broken for a different reason. The
flag lives for the whole tab session, so a *second* deploy during the same session won't auto-reload — many
teams store a timestamp instead and allow one reload per few minutes. Either way, keep an error boundary around
lazy routes: when no reload happens, the chunk import can still reject, and the fallback should say "A new
version is available — Reload" rather than "Something went wrong".)

### Suspense for data: `use(promise)`

React 19's `use(promise)` reads a promise's value during render. If it's pending, the component suspends; if it
rejected, `use` **throws** the rejection reason to the nearest error boundary.

```tsx
import { use } from 'react'

const projectCache = new Map<string, Promise<Project>>()
function loadProject(id: string) {
  if (!projectCache.has(id)) projectCache.set(id, fetchJson<Project>(`/api/projects/${id}`))
  return projectCache.get(id)!
}

function ProjectHeader({ id }: { id: string }) {
  const project = use(loadProject(id))   // suspends, or throws to the boundary
  return <h2>{project.name}</h2>
}

// The reset must evict the rejected promise, or "Try again" re-throws the same error.
<ErrorBoundary FallbackComponent={PanelError} resetKeys={[id]} onReset={() => projectCache.delete(id)}>
  <Suspense fallback={<HeaderSkeleton />}><ProjectHeader id={id} /></Suspense>
</ErrorBoundary>
```

The rule that trips everyone up: **the promise must be stable across renders**. When a component suspends,
React throws away that render attempt and re-renders later. If you create the promise *inside* the component,
every attempt creates a new pending promise — the component suspends forever (or refetches in a loop). The
promise has to come from somewhere that outlives the render: a cache, a router loader, a parent's state, or a
data library.

:::quiz id=fe-29-q3 xp=15
This component shows its skeleton forever and the Network tab shows `/api/me` being requested over and over.
Why?

```tsx
function Profile() {
  const me = use(fetch('/api/me').then((r) => r.json()))
  return <p>Hi {me.name}</p>
}
```

- [ ] `use` only works with `async` functions, not `.then` chains
- [x] Each render attempt creates a **new** promise; React suspends on it, retries the render later, and gets yet another pending promise
- [ ] The `<Suspense>` boundary is missing, so React retries forever
- [ ] `fetch` responses can't be read twice, so `r.json()` throws
> When a component suspends, React discards the attempt and renders it again once the promise settles. Here
> the retry calls `fetch` again, producing a brand-new pending promise, so the component never sees a resolved
> one. The promise must be created **outside render** (a cache keyed by URL, a loader, TanStack Query) so the
> retry gets the *same*, now-resolved promise. A missing `<Suspense>` gives a different symptom (the nearest
> boundary up — possibly the root — shows its fallback), not a request loop.
:::

### Suspense with TanStack Query: `useSuspenseQuery`

In real apps you don't hand-roll the cache — TanStack Query already is one. `useSuspenseQuery` suspends while
loading, and its `data` is **never `undefined`** (TypeScript knows it). Errors go to the nearest boundary. Wire
the boundary's reset to the query cache with `QueryErrorResetBoundary`, so "Try again" refetches instead of
re-throwing the cached error:

```tsx
import { QueryErrorResetBoundary, useSuspenseQuery } from '@tanstack/react-query'
import { ErrorBoundary } from 'react-error-boundary'

function ProjectPage({ id }: { id: string }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <ErrorBoundary onReset={reset} resetKeys={[id]} FallbackComponent={PanelError}>
          <Suspense fallback={<ProjectSkeleton />}>
            <ProjectDetails id={id} />
          </Suspense>
        </ErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  )
}

function ProjectDetails({ id }: { id: string }) {
  const { data: project } = useSuspenseQuery({
    queryKey: ['projects', id],
    queryFn: () => getProject(id),
  })
  return <h2>{project.name}</h2>   // no isLoading / undefined checks
}
```

Three details that matter in practice:

- **Background refetch errors don't throw.** If the query already has data and a refetch fails, the boundary is
  *not* triggered — users keep seeing the (stale) data. Show a small "Couldn't refresh — showing data from 10:42"
  banner using the query's `error`/`isRefetchError`. Replacing good data with an error screen is a classic
  mistake.
- **Waterfalls.** Two `useSuspenseQuery` calls in the same component run **one after the other** (the first
  suspends before the second is even called). Use `useSuspenseQueries`, or prefetch both in a parent/loader.
- **Navigation shouldn't flash the skeleton.** Wrap the state change that switches `id` in `startTransition`;
  React keeps the old screen visible (you can dim it via `isPending`) instead of falling back to the skeleton.

With plain `useQuery` you can opt into the same "errors go to the boundary" behaviour with `throwOnError: true`
(or a function: `throwOnError: (error) => error instanceof ApiError && error.status >= 500`, keeping 4xx inline).
`useSuspenseQuery` has this built in: its default is roughly "throw if the query has no data yet", which is
exactly why background refetch failures don't hit the boundary.

## Designing loading, empty, error and stale states

Every piece of server data has at least four states (you implemented them in
**Lists, Keys & Conditional Rendering**). Designing them *well* is a UX decision, not just a conditional:

| State | Good | Bad |
|---|---|---|
| **Loading** | A skeleton shaped like the content; appears only after ~200 ms so fast responses don't flash | A full-page spinner that hides the nav; layout jumping when data arrives |
| **Empty** | Explains *why* it's empty and offers the next action ("No projects yet — Create project") | A blank area, or an error message for "zero results" |
| **Error** | Says what failed in human words, keeps context, offers Retry, includes a reference id | `Error: Request failed with status code 500`, or a white screen |
| **Stale + error** | Keeps showing the old data with a quiet "Couldn't refresh" notice | Throws away valid data and shows an error screen |
| **Partial** | The broken widget shows its own fallback; the rest of the page works | One failing request blanks the whole dashboard |

The message itself: **what happened**, **what the user can do**, and **whether their work is safe**. "We couldn't
save your changes. Your draft is kept on this device. Try again" beats "Network Error" every time.

## Retry: automatic first, then the user

Not every failure deserves a retry. Ask: *would the same request give a different answer a moment later?*

- **Retry**: network errors (`TypeError: Failed to fetch`), `408`, `429` (wait for `Retry-After`), `500`, `502`,
  `503`, `504`. These are *transient*.
- **Don't retry**: `400`, `401` (refresh the token once instead), `403`, `404`, `409`, `422`. The answer won't
  change; retrying only delays the real message.
- **Mutations** (`POST`/`PUT`/`DELETE`): only retry automatically if the request is idempotent (an
  idempotency key or a naturally idempotent `PUT`). Otherwise a "retry" can create two orders.

The pattern: a few **automatic** retries with **exponential backoff** (wait 1 s, 2 s, 4 s… — giving the server
time to recover instead of hammering it), then stop and give the user a **manual** "Try again" button. TanStack
Query does the automatic part for queries by default (`retry: 3`, delay doubling up to 30 s); the jitter that
stops thousands of clients retrying in lock-step is covered in **Real-time & Resilient UI**.

Watch out: TanStack Query's default retries **every** error, including a 404 or 403 — the user stares at a
spinner for ~7 s before seeing "Not found". Teach it the list above once, in the `QueryClient` defaults:

```ts
// ApiError (with a numeric `status`) is the typed error from the API client later in this lesson
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) =>
        failureCount < 3 &&
        (!(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500),
    },
  },
})
```

For `429` and `503`, a server may send `Retry-After` (seconds, or an HTTP date). When it's present, wait at least
that long instead of your own backoff — the server is telling you exactly when it will accept you again.

While retrying, *say so*: "Still trying… (attempt 2 of 3)" tells the user the app hasn't frozen. And cancel the
pending retry when the component unmounts — a timer that fires after the user left is a leak and can show stale
data on the wrong screen.

:::challenge id=fe-29-c2 lang=tsx xp=70
title: A retry-with-backoff loader
Build `QuoteOfTheDay({ load, baseMs = 1000, maxAttempts = 3 })`. `load()` returns a promise of a string, or
rejects with an error that may have a numeric `status`.

- On mount, call `load()` (attempt 1). While attempt 1 is pending show `<p role="status">Loading…</p>`.
- On success render `<blockquote>{quote}</blockquote>`.
- On failure, if the error is **retryable** (no `status` = network error, or `status` is `408`, `429` or `>= 500`)
  **and** `attempt < maxAttempts`: show `<p role="status">Retrying… (attempt N of M)</p>` where `N` is the
  *next* attempt, and call `load()` again after `baseMs * 2 ** (attempt - 1)` ms, where `attempt` is the number of
  the attempt that just failed (so the waits are 1×, 2×, 4× … `baseMs`). Keep showing that text while the retry is
  pending. Call `load()` exactly once per attempt.
- Otherwise (non-retryable, e.g. `404`, or attempts used up) show `<div role="alert">` containing
  `Couldn't load the quote.` and a `Try again` button that starts over from attempt 1 (with the same retry rules).
  No further automatic `load()` calls happen while the alert is shown.
- Unmounting must cancel a scheduled retry (no `load()` call after unmount).

The tests use a small `baseMs` and real time.

hint: Keep `attempt` in state and run the request in an effect with `[attempt, run]` deps (`run` is a counter bumped by "Try again", so attempt 1 can be re-run).
hint: In the effect: `let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined`, and in cleanup `cancelled = true; clearTimeout(timer)`.
hint: On a retryable failure: `timer = setTimeout(() => setAttempt(attempt + 1), baseMs * 2 ** (attempt - 1))`.

```tsx starter
import { useEffect, useState } from 'react'

type Props = { load: () => Promise<string>; baseMs?: number; maxAttempts?: number }

export function QuoteOfTheDay({ load, baseMs = 1000, maxAttempts = 3 }: Props) {
  const [quote, setQuote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    load().then(setQuote, () => setFailed(true))
  }, [load])

  if (quote !== null) return <blockquote>{quote}</blockquote>
  if (failed) return <div role="alert">Couldn't load the quote.</div>
  return <p role="status">Loading…</p>
}
```

```tsx solution
import { useEffect, useState } from 'react'

type Props = { load: () => Promise<string>; baseMs?: number; maxAttempts?: number }
type View =
  | { kind: 'loading' }
  | { kind: 'retrying'; next: number }
  | { kind: 'error' }
  | { kind: 'success'; quote: string }

function isRetryable(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status
  if (typeof status !== 'number') return true      // network error, no response
  return status === 408 || status === 429 || status >= 500
}

export function QuoteOfTheDay({ load, baseMs = 1000, maxAttempts = 3 }: Props) {
  const [attempt, setAttempt] = useState(1)
  const [run, setRun] = useState(0)
  const [view, setView] = useState<View>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    load().then(
      (quote) => { if (!cancelled) setView({ kind: 'success', quote }) },
      (error) => {
        if (cancelled) return
        if (attempt < maxAttempts && isRetryable(error)) {
          setView({ kind: 'retrying', next: attempt + 1 })
          timer = setTimeout(() => setAttempt(attempt + 1), baseMs * 2 ** (attempt - 1))
        } else {
          setView({ kind: 'error' })
        }
      },
    )
    return () => { cancelled = true; clearTimeout(timer) }
  }, [attempt, run, load, baseMs, maxAttempts])

  function tryAgain() {
    setView({ kind: 'loading' })
    setAttempt(1)
    setRun((r) => r + 1)
  }

  if (view.kind === 'success') return <blockquote>{view.quote}</blockquote>
  if (view.kind === 'error') {
    return (
      <div role="alert">
        <p>Couldn't load the quote.</p>
        <button onClick={tryAgain}>Try again</button>
      </div>
    )
  }
  if (view.kind === 'retrying') return <p role="status">Retrying… (attempt {view.next} of {maxAttempts})</p>
  return <p role="status">Loading…</p>
}
```

```tsx tests
const httpError = (status?: number) => Object.assign(new Error(status ? `HTTP ${status}` : 'Failed to fetch'), status ? { status } : {})
function scripted(steps: (string | Error)[]) {
  let i = 0
  const times: number[] = []
  const load = fn(async () => {
    times.push(Date.now())
    const step = steps[Math.min(i++, steps.length - 1)]
    if (step instanceof Error) throw step
    return step
  })
  return { load, times }
}

test('shows Loading… then the quote', async () => {
  const { load } = scripted(['Ship it.'])
  render(<QuoteOfTheDay load={load} baseMs={20} />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading…')
  expect(await screen.findByText('Ship it.')).toBeInTheDocument()
  expect(load).toHaveBeenCalledTimes(1)
})
test('retries transient failures with exponential backoff', async () => {
  const { load, times } = scripted([httpError(503), httpError(), 'Third time lucky'])
  render(<QuoteOfTheDay load={load} baseMs={30} maxAttempts={3} />)
  expect(await screen.findByText('Retrying… (attempt 2 of 3)')).toBeInTheDocument()
  expect(await screen.findByText('Third time lucky')).toBeInTheDocument()
  expect(load).toHaveBeenCalledTimes(3)
  expect(times[1] - times[0]).toBeGreaterThanOrEqual(25)
  expect(times[2] - times[1]).toBeGreaterThanOrEqual(55)
})
test('gives up after maxAttempts and offers Try again', async () => {
  const { load } = scripted([httpError(500), httpError(500), httpError(500), 'Back online'])
  render(<QuoteOfTheDay load={load} baseMs={10} maxAttempts={3} />)
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the quote.")
  await sleep(80)
  expect(load).toHaveBeenCalledTimes(3)
  await user.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('Back online')).toBeInTheDocument()
  expect(load).toHaveBeenCalledTimes(4)
})
test('does not retry a 404', async () => {
  const { load } = scripted([httpError(404), 'never'])
  render(<QuoteOfTheDay load={load} baseMs={10} />)
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the quote.")
  await sleep(50)
  expect(load).toHaveBeenCalledTimes(1)
})
test('unmounting cancels the scheduled retry', async () => {
  const { load } = scripted([httpError(503), 'too late'])
  const { unmount } = render(<QuoteOfTheDay load={load} baseMs={40} />)
  await screen.findByText('Retrying… (attempt 2 of 3)')
  unmount()
  await sleep(90)
  expect(load).toHaveBeenCalledTimes(1)
})
```
:::

## Toasts vs inline errors

Where a message appears is as important as what it says. The rule of thumb: **put the error where the user's
attention and the fix are.**

| Situation | Use | Why |
|---|---|---|
| A form field is invalid (`422` with field errors) | **Inline**, under the field, linked with `aria-describedby` | The user has to fix *that field*; a toast disappears before they find it |
| The whole form failed (`409`, `500`) | **Inline** banner (`role="alert"`) at the top of the form, input kept | The user's work and the retry button are right there |
| A background action failed ("Couldn't mark as read") | **Toast**, with an Undo/Retry action | Nothing on screen to attach it to; non-blocking |
| A background action succeeded ("Saved", "Copied") | **Toast** or a subtle status (`role="status"`) | Confirmation, no action needed |
| A panel's data couldn't load | **Inline** fallback in the panel (error boundary or error state) | Scoped to the broken thing; rest of the page works |
| Offline / session expired | **Persistent banner** | It affects everything until it's resolved |

Toasts are tempting because one global `toast.error(e.message)` in an interceptor "handles" every error. That's
precisely the problem: the message is generic, disappears after 5 seconds, is often missed by screen readers,
and is shown far from the field that needs fixing.

:::quiz id=fe-29-q4 xp=15
Which of these are good uses of a toast? (Select all that apply.)

- [x] "Link copied to clipboard"
- [ ] "Email: must be a valid address" after submitting a signup form
- [x] "Couldn't archive the card — Undo / Retry" after a drag-and-drop on a board
- [ ] "Your session expired, sign in again" while the user is editing a long document
> Toasts suit **transient, non-blocking** feedback about something with no obvious place on screen: a copy
> confirmation, or a background mutation that failed (with an action to recover). A field validation error is
> the tempting wrong one — it must sit **next to the field** so the user can find and fix it (and assistive tech
> can announce it via `aria-describedby`). An expired session blocks all further saves, so it needs a persistent
> banner or dialog that doesn't vanish — and the editor's content must be kept while the user signs in again.
:::

## Mapping API errors (ProblemDetails) to UI

ASP.NET Core APIs answer errors with **ProblemDetails** (RFC 9457, `Content-Type: application/problem+json`). Your
frontend should turn that into the *right* UI, in **one place** — not with `if (res.status === 422)` scattered
through components.

A validation failure from an `[ApiController]` or a minimal API with validation:

```json
{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.1",
  "title": "One or more validation errors occurred.",
  "status": 400,
  "errors": {
    "Email": ["Email is already in use."],
    "DisplayName": ["Display name must be at least 3 characters."]
  },
  "traceId": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

And a concurrency conflict:

```json
{ "title": "Conflict", "status": 409, "detail": "The project was changed by someone else.", "traceId": "00-…" }
```

| Status | Meaning | UI |
|---|---|---|
| `400` with `errors` | Request shape / validation failed (ASP.NET's automatic model validation) | Field errors inline; unknown keys in a form-level summary |
| `422` | Semantically invalid ("end date before start date", business rule) — often also with `errors` | Same as above |
| `409` | Conflict: stale version, duplicate | Banner with "Reload" / "Compare", **keep the user's input** (see the conflict flow in **Real-time & Resilient UI**) |
| `401` | Not signed in / token expired | Refresh once, else redirect to sign-in with return URL |
| `403` | Signed in but not allowed | Inline "You don't have access", no retry |
| `404` | Doesn't exist (or you can't see it) | "Not found" state for that resource |
| `5xx` / network | Server or connectivity broke | Generic message + Retry + **reference id** |

Two details that bite:

- **Key casing.** Error keys are often PascalCase C# property names (`Email`, `Address.City`, `Items[0].Quantity`)
  while your form fields are camelCase. Normalise in one helper. Keys that don't map to a field (`""`, `$`,
  `$.items`) go to a form-level summary — never silently drop them.
- **Don't trust the body shape.** A 502 from a proxy is HTML, not ProblemDetails. Check the `Content-Type`, parse
  defensively, and fall back to a generic message.

A small fetch wrapper turns every non-2xx into one typed error your UI can branch on:

```ts
export type ProblemDetails = {
  type?: string; title?: string; status?: number; detail?: string
  traceId?: string; errors?: Record<string, string[]>
}

export class ApiError extends Error {
  status: number
  problem: ProblemDetails | null
  correlationId: string | undefined
  constructor(status: number, problem: ProblemDetails | null, correlationId?: string) {
    super(problem?.title ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
    this.correlationId = correlationId
  }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T
  const isJson = res.headers.get('content-type')?.includes('json') ?? false
  const problem = isJson ? ((await res.json().catch(() => null)) as ProblemDetails | null) : null
  throw new ApiError(res.status, problem, problem?.traceId ?? res.headers.get('x-correlation-id') ?? undefined)
}
```

:::warn title="Cross-origin headers are invisible by default"
If the API lives on another origin (`api.example.com` vs `app.example.com`), the browser hides custom response
headers from JavaScript: `res.headers.get('x-correlation-id')` returns `null` unless the server's CORS policy sends
`Access-Control-Expose-Headers: X-Correlation-Id` (in ASP.NET Core: `.WithExposedHeaders("X-Correlation-Id")`).
The `traceId` in the body is unaffected. `X-Correlation-Id` is a team convention, not a standard — check what your
backend actually emits.
:::

:::challenge id=fe-29-c3 lang=tsx xp=80
title: Map ProblemDetails to field errors
The `setup` provides an `ApiError` (with `status` and `problem`). Implement two things.

**1. `toFieldErrors(problem, fields)`** → `{ fieldErrors, formErrors }`:

- For each key in `problem.errors`, normalise it by lower-casing its **first character** (`DisplayName` →
  `displayName`, `email` stays `email`).
- If the normalised key is in `fields`, set `fieldErrors[key]` to the **first** message.
- Otherwise push **all** its messages onto `formErrors`.
- `problem.errors` may be missing → `{ fieldErrors: {}, formErrors: [] }`.

**2. `ProfileForm({ save })`** — a form with labelled inputs **Display name** (`displayName`) and **Email**
(`email`), in that order, and a **Save** button. On submit, clear all previous messages (field errors, alert,
"Saved") and `await save({ displayName, email })` with the typed values. Never reset the inputs — the user's
typing is kept in every outcome.

- Success → `<p role="status">Saved</p>`, and no `role="alert"` element remains.
- `ApiError` with status `400` or `422` → map with `toFieldErrors`. For each field error render
  `<p id="{field}-error">{message}</p>` below the input, and give that input `aria-invalid="true"` and
  `aria-describedby="{field}-error"`. An input **without** an error must have neither attribute. Move focus to the
  **first** invalid field in form order (not the order of keys in the response). If there are `formErrors`, show
  them joined by a space in a `role="alert"` element.
- `ApiError` with status `409` → `role="alert"` with `This profile was changed by someone else. Reload to see the latest version.`
- Anything else (other statuses, or a non-`ApiError` such as `TypeError: Failed to fetch`) → `role="alert"` with
  `Something went wrong. Please try again.` and, only if `error.problem?.traceId` exists, append
  ` Reference: {traceId}`.

hint: `const FIELDS = ['displayName', 'email'] as const` drives both `toFieldErrors` and the focus order.
hint: Keep `useRef`s for both inputs: `const refs = { displayName: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null) }`, then `refs[first].current?.focus()`.
hint: Only render the `aria-describedby` attribute when there is an error: `aria-describedby={err ? 'email-error' : undefined}`.

```tsx setup
type ProblemDetails = {
  type?: string; title?: string; status: number; detail?: string
  traceId?: string; errors?: Record<string, string[]>
}
class ApiError extends Error {
  status: number
  problem: ProblemDetails | null
  constructor(status: number, problem: ProblemDetails | null) {
    super(problem?.title ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }
}
type ProfileValues = { displayName: string; email: string }
```

```tsx starter
import { useRef, useState } from 'react'

export function toFieldErrors(problem: ProblemDetails, fields: readonly string[]) {
  return { fieldErrors: {} as Record<string, string>, formErrors: [] as string[] }
}

export function ProfileForm({ save }: { save: (v: ProfileValues) => Promise<void> }) {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    try {
      await save({ displayName, email })
      setMessage('Saved')
    } catch {
      setMessage('Error')
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="displayName">Display name</label>
      <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      <label htmlFor="email">Email</label>
      <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <button type="submit">Save</button>
      {message && <p role="status">{message}</p>}
    </form>
  )
}
```

```tsx solution
import { useRef, useState } from 'react'

const FIELDS = ['displayName', 'email'] as const
type Field = (typeof FIELDS)[number]
const LABELS: Record<Field, string> = { displayName: 'Display name', email: 'Email' }

export function toFieldErrors(problem: ProblemDetails, fields: readonly string[]) {
  const fieldErrors: Record<string, string> = {}
  const formErrors: string[] = []
  for (const [rawKey, messages] of Object.entries(problem.errors ?? {})) {
    const key = rawKey.charAt(0).toLowerCase() + rawKey.slice(1)
    if (fields.includes(key)) {
      if (messages.length > 0) fieldErrors[key] = messages[0]
    } else {
      formErrors.push(...messages)
    }
  }
  return { fieldErrors, formErrors }
}

export function ProfileForm({ save }: { save: (v: ProfileValues) => Promise<void> }) {
  const [values, setValues] = useState<ProfileValues>({ displayName: '', email: '' })
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [alert, setAlert] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const refs = { displayName: useRef<HTMLInputElement>(null), email: useRef<HTMLInputElement>(null) }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFieldErrors({})
    setAlert(null)
    setSaved(false)
    try {
      await save(values)
      setSaved(true)
    } catch (error) {
      if (error instanceof ApiError && (error.status === 400 || error.status === 422) && error.problem) {
        const mapped = toFieldErrors(error.problem, FIELDS)
        setFieldErrors(mapped.fieldErrors)
        if (mapped.formErrors.length) setAlert(mapped.formErrors.join(' '))
        const first = FIELDS.find((f) => mapped.fieldErrors[f])
        if (first) refs[first].current?.focus()
      } else if (error instanceof ApiError && error.status === 409) {
        setAlert('This profile was changed by someone else. Reload to see the latest version.')
      } else {
        const traceId = error instanceof ApiError ? error.problem?.traceId : undefined
        setAlert(`Something went wrong. Please try again.${traceId ? ` Reference: ${traceId}` : ''}`)
      }
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {alert && <div role="alert">{alert}</div>}
      {FIELDS.map((field) => {
        const err = fieldErrors[field]
        return (
          <div key={field}>
            <label htmlFor={field}>{LABELS[field]}</label>
            <input
              id={field}
              ref={refs[field]}
              value={values[field]}
              aria-invalid={err ? 'true' : undefined}
              aria-describedby={err ? `${field}-error` : undefined}
              onChange={(e) => setValues((v) => ({ ...v, [field]: e.target.value }))}
            />
            {err && <p id={`${field}-error`}>{err}</p>}
          </div>
        )
      })}
      <button type="submit">Save</button>
      {saved && <p role="status">Saved</p>}
    </form>
  )
}
```

```tsx tests
const validation = (status: number) => new ApiError(status, {
  status,
  title: 'One or more validation errors occurred.',
  errors: {
    Email: ['Email is already in use.', 'Ignored second message'],
    DisplayName: ['Display name must be at least 3 characters.'],
    '': ['The request body is invalid.'],
  },
})
async function fillAndSave(name: string, mail: string) {
  await user.clear(screen.getByLabelText('Display name'))
  await user.type(screen.getByLabelText('Display name'), name)
  await user.clear(screen.getByLabelText('Email'))
  await user.type(screen.getByLabelText('Email'), mail)
  await user.click(screen.getByRole('button', { name: 'Save' }))
}

test('toFieldErrors normalises keys and splits field vs form errors', () => {
  const out = toFieldErrors(validation(400).problem!, ['displayName', 'email'])
  expect(out.fieldErrors).toEqual({ email: 'Email is already in use.', displayName: 'Display name must be at least 3 characters.' })
  expect(out.formErrors).toEqual(['The request body is invalid.'])
  expect(toFieldErrors({ status: 400 }, ['email'])).toEqual({ fieldErrors: {}, formErrors: [] })
})
test('saves and shows Saved', async () => {
  const save = fn(async () => {})
  render(<ProfileForm save={save} />)
  await fillAndSave('Ada', 'ada@example.com')
  expect(await screen.findByRole('status')).toHaveTextContent('Saved')
  expect(save).toHaveBeenCalledWith({ displayName: 'Ada', email: 'ada@example.com' })
})
test('400 maps errors onto fields, accessibly, and focuses the first one', async () => {
  render(<ProfileForm save={fn(async () => { throw validation(400) })} />)
  await fillAndSave('Al', 'ada@example.com')
  const email = screen.getByLabelText('Email')
  const name = screen.getByLabelText('Display name')
  await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'))
  expect(email).toHaveAttribute('aria-describedby', 'email-error')
  expect(document.getElementById('email-error')).toHaveTextContent('Email is already in use.')
  expect(name).toHaveAttribute('aria-describedby', 'displayName-error')
  expect(screen.getByText('Display name must be at least 3 characters.')).toBeInTheDocument()
  expect(screen.queryByText('Ignored second message')).toBeNull()
  expect(screen.getByRole('alert')).toHaveTextContent('The request body is invalid.')
  expect(name).toHaveFocus()
})
test('422 is handled the same way, and a successful retry clears the errors', async () => {
  let fail = true
  render(<ProfileForm save={fn(async () => { if (fail) throw validation(422) })} />)
  await fillAndSave('Al', 'ada@example.com')
  expect(await screen.findByText('Email is already in use.')).toBeInTheDocument()
  fail = false
  await fillAndSave('Ada Lovelace', 'ada@lovelace.dev')
  expect(await screen.findByRole('status')).toHaveTextContent('Saved')
  expect(screen.queryByText('Email is already in use.')).toBeNull()
  expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid')
  expect(screen.queryByRole('alert')).toBeNull()
})
test('409 shows the conflict message and keeps the input', async () => {
  render(<ProfileForm save={fn(async () => { throw new ApiError(409, { status: 409, title: 'Conflict' }) })} />)
  await fillAndSave('Ada', 'ada@example.com')
  expect(await screen.findByRole('alert')).toHaveTextContent('This profile was changed by someone else. Reload to see the latest version.')
  expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com')
})
test('500 shows a generic message with the trace id as reference', async () => {
  render(<ProfileForm save={fn(async () => { throw new ApiError(500, { status: 500, traceId: '00-abc123-01' }) })} />)
  await fillAndSave('Ada', 'ada@example.com')
  expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again. Reference: 00-abc123-01')
})
test('a network error shows the generic message without a reference', async () => {
  render(<ProfileForm save={fn(async () => { throw new TypeError('Failed to fetch') })} />)
  await fillAndSave('Ada', 'ada@example.com')
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Something went wrong. Please try again.')
  expect(alert.textContent).not.toContain('Reference')
})
```
:::

:::quiz id=fe-29-q5 xp=15
Saving a project returns `409` with `{ "title": "Conflict", "detail": "The project was changed by someone else." }`.
What should the UI do?

- [ ] Retry the `PUT` automatically with exponential backoff until it succeeds
- [ ] Show a toast "Error 409" and reset the form to the server's version
- [x] Keep the user's edits, show an inline message near the form, and offer to reload/compare with the latest version
- [ ] Throw the error to the route's error boundary so the page shows "Something went wrong"
> A 409 is not transient — retrying sends the same stale version and gets the same 409 (and a blind
> "last write wins" retry would overwrite a colleague's work). Resetting the form throws away the user's edits,
> which is the worst outcome. A boundary fallback treats an **expected business outcome** like a crash and also
> loses the edits. The right flow keeps both versions available and lets the user decide.
:::

## The global safety net: `error` and `unhandledrejection`

Everything React doesn't see — a throw in a handler, a forgotten `await`, a third-party script — ends up on
`window`:

```ts
window.addEventListener('error', (event) => {
  report('window.error', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  report('unhandledrejection', event.reason)   // reason may be anything — not always an Error
})
```

These handlers are for **reporting**, not for UX. By the time an error reaches them you've lost the context
needed to show a helpful message ("which save failed?"). If you find yourself showing toasts from
`unhandledrejection`, the real fix is to catch the error where it happens.

React 19 adds root-level hooks for errors React *does* see, so you can report them in one place instead of in
every boundary's `onError`:

```tsx
createRoot(document.getElementById('root')!, {
  onCaughtError: (error, info) => report('caught', error, info),          // a boundary showed a fallback
  onUncaughtError: (error, info) => report('uncaught', error, info),      // no boundary: the root unmounted
  onRecoverableError: (error, info) => report('recoverable', error, info) // React recovered (e.g. hydration mismatch)
}).render(<App />)
```

By default React 19 logs caught errors with `console.error` and passes uncaught ones to `window.reportError`
(which fires the `error` event). Supplying these options replaces that default — so if you report from
`onUncaughtError`, don't also report the same error from your `window` `error` listener.

:::warn title="Noise will drown your signal"
A naive global handler reports *everything*: browser extensions throwing in your page, `ResizeObserver loop`
warnings, aborted fetches when the user navigates away (`AbortError`), errors from ad blockers. Within a week the
dashboard has 40 000 events and nobody looks at it. Filter known noise (`AbortError`, extension URLs in the
stack), de-duplicate identical errors per page load, rate-limit, and sample high-volume events.
:::

## Production error reporting: Sentry, source maps, releases

A tool like **Sentry** (alternatives: Datadog RUM, Bugsnag, Rollbar, Grafana Faro, Azure Application Insights)
collects browser errors with context: stack, browser, URL, breadcrumbs (the clicks and requests before the
crash), the user id, and the **release**.

```tsx
// src/instrument.ts — import it first in main.tsx
import * as Sentry from '@sentry/react'

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: import.meta.env.VITE_RELEASE,        // e.g. the git SHA, set in CI
  environment: import.meta.env.MODE,
  sendDefaultPii: false,
  integrations: [Sentry.browserTracingIntegration()],   // instruments fetch/XHR + page loads
  tracesSampleRate: 0.1,
  tracePropagationTargets: [/^\/api\//],        // send trace headers to OUR api only
  beforeSend(event) {
    if (event.request?.url) event.request.url = event.request.url.replace(/token=[^&]+/, 'token=[redacted]')
    return event
  },
})

// main.tsx
createRoot(root, {
  onUncaughtError: Sentry.reactErrorHandler(),
  onCaughtError: Sentry.reactErrorHandler(),
  onRecoverableError: Sentry.reactErrorHandler(),
}).render(<App />)
```

:::warn title="Check the SDK docs for your version"
Sentry's JavaScript SDK changes option names between major versions (v7 used `new BrowserTracing()`, v8+ uses
`browserTracingIntegration()`; `reactErrorHandler` only exists in recent v8+ releases). Copy the current snippet
from the [Sentry React docs](https://docs.sentry.io/platforms/javascript/guides/react/) rather than trusting any
tutorial — including this one — for exact option names.
:::

### Why source maps and releases go together

Your production bundle is minified: the stack says `TypeError: Cannot read properties of undefined (reading 'map')
at Xe (index-B4f2a9.js:1:28411)`. A **source map** translates that back to `ProjectList.tsx:42:17`. But:

- **Don't serve source maps publicly** if you don't want your source readable by anyone. Build them with
  `build.sourcemap: 'hidden'` (maps are generated, but the `//# sourceMappingURL` comment is left out), upload
  them to the error tracker in CI, then delete them from `dist/` before deploying.
- **Match the map to the exact bundle.** The tracker must know *which* map belongs to *which* deployed file.
  Modern Sentry tooling (`@sentry/vite-plugin` v2+, `sentry-cli sourcemaps inject`) does this with **debug IDs**:
  at build time it injects a unique id into each `.js` file and its `.map`, and the SDK sends that id with every
  stack frame. Older setups matched by **release name + file URL**, so a release mismatch (app says `1.4.2`, CI
  uploaded as `1.4.3`) meant minified garbage — you will still meet that in older projects and other trackers.
- **Tag everything with a release** anyway. Use the git SHA, set once in CI and passed to both the build and
  the upload. Releases give you "this error first appeared in release `a1b2c3d`", regression alerts, and
  crash-free rates per deploy — which points straight at the deploy that caused a problem.

The classic way to break symbolication today is quieter: the upload **didn't happen**. If `SENTRY_AUTH_TOKEN` is
missing in the step that builds the deployed bundle (a Docker build without the secret, a forked-PR pipeline),
the plugin logs a warning, skips the upload, and the build still succeeds.

```ts
// vite.config.ts
import { sentryVitePlugin } from '@sentry/vite-plugin'

export default defineConfig({
  build: { sourcemap: 'hidden' },
  plugins: [
    react(),
    sentryVitePlugin({                              // keep it last
      org: 'acme', project: 'web',
      authToken: process.env.SENTRY_AUTH_TOKEN,     // a CI secret, never in the repo
      release: { name: process.env.VITE_RELEASE },
      sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] },
    }),
  ],
})
```

:::quiz id=fe-29-q6 xp=15
Sentry shows production errors as `at Xe (index-B4f2a9.js:1:28411)`. The repo's `vite.config.ts` has the Sentry
Vite plugin and `sourcemap: 'hidden'`; the deployed bundle is built inside a `docker build` step, and the build log
there contains a plugin warning. What is the most likely cause?

- [ ] `'hidden'` maps can't be used by error trackers — you must use `sourcemap: true`
- [x] `SENTRY_AUTH_TOKEN` isn't available inside the Docker build, so the plugin skipped the upload and the build still succeeded
- [ ] Source maps only work for errors caught by an error boundary
- [ ] The DSN must be the same as the auth token
> Without the auth token the plugin can't upload, warns, and lets the build pass — so the deployed files have no
> maps on the server. (In older release-based setups, a release-name mismatch between the app and the upload had
> the same symptom.) `'hidden'` is exactly what you want: the map is generated and uploaded, it just isn't
> referenced from the public bundle. Symbolication applies to every reported stack, not only boundary-caught ones.
> The DSN (public, identifies the project) and the auth token (secret, for uploads) are deliberately different.
:::

## Correlation ids: from "it broke" to the exact log line

The most useful thing you can show in an error message is a **reference id** that also appears in your backend
logs. With it, a support ticket "Save failed, Reference: 4bf92f35…" becomes one search in Seq / Loki /
Application Insights / Sentry that shows the exact request, its SQL, and the exception.

How the pieces line up in a .NET + React stack:

1. The browser sends trace headers on API calls so the backend request **joins the same trace**. The
   OpenTelemetry browser SDK sends the W3C `traceparent` header, which ASP.NET Core reads natively. Sentry's
   SDK sends its own `sentry-trace` + `baggage` headers to URLs in `tracePropagationTargets` (understood by the
   Sentry .NET SDK); recent browser SDK versions can *also* send `traceparent` via the `propagateTraceparent`
   option. Cross-origin APIs must allow these headers in `Access-Control-Allow-Headers`, or the browser's CORS
   preflight fails and the request itself breaks.
2. ASP.NET Core's ProblemDetails includes a `traceId` (the current `Activity` id); many teams also return it as an
   `X-Correlation-Id` response header, which works even when the body isn't ProblemDetails.
3. The frontend's `ApiError` keeps that id, the UI shows it (short, copyable), and the error report **tags** it —
   so the browser event and the server log share a searchable key.

```tsx
<div role="alert">
  We couldn't save your changes. Your draft is kept. <button onClick={retry}>Try again</button>
  {error.correlationId && <small> Reference: <code>{error.correlationId}</code></small>}
</div>
```

What **not** to log: passwords, tokens, full request bodies, personal data the user typed. Error reports leave
your infrastructure and are kept for months — treat them like any other data export.

:::quiz id=fe-29-q7 xp=15
A user reports "saving failed" with a screenshot. Which detail on that screen is most useful for finding the cause?

- [ ] The error's `message`, e.g. `Request failed with status code 500`
- [ ] The time on the user's clock
- [x] The `traceId` / correlation id from the ProblemDetails response, shown as "Reference: …"
- [ ] The full JavaScript stack trace rendered in the UI
> The message only tells you *that* it failed, and thousands of requests return 500. The client clock may be off
> and doesn't identify a request. A stack trace on screen is unreadable for users, leaks internals, and is
> minified anyway. The trace id is unique per request and is stored in both the backend logs and the browser
> error report — one search finds the exact exception.
:::

:::job title="What teams expect on day one"
- **A boundary per route and per independent widget**, plus a root one — and the root fallback offers a reload.
- **One API client** that turns non-2xx into a typed `ApiError` with `status`, `problem` and a correlation id.
  Components branch on status, they don't parse responses.
- **Errors reported in one place** (root `onCaughtError`/`onUncaughtError` + global listeners), tagged with the
  release and environment, with noise filtered.
- Source maps uploaded in CI and **not** publicly served; the release is the git SHA.
- In code review, expect comments like "this `catch` swallows the error — report it or rethrow" and "don't show
  `error.message` to users; map it".
:::

:::pro title="How seniors run error budgets on the frontend"
Seniors treat frontend errors like backend SLOs: they watch **crash-free sessions** (e.g. 99.5 %) and "new issues
per release" rather than raw event counts, alert on *regressions* (an error that spikes after a deploy), and
assign every new issue an owner. They also test failure paths deliberately — a Playwright test with
`page.route('**/api/projects', r => r.fulfill({ status: 503 }))` that asserts the retry UI and the reference id,
and a Vitest test that throws inside a boundary — so "failing well" doesn't silently regress.
:::

## Lab: error boundaries and error reporting in a Vite app

:::lab id=fe-29-lab1 xp=120
title: Add react-error-boundary and Sentry-style reporting to a Vite app
You'll build a small app with a crashing panel, a failing save, and a forgotten promise — and a tiny local
"error sink" that plays the role of Sentry (and of a backend returning ProblemDetails). No account needed; the
Sentry swap is shown at the end.

**1. Create the app**

```bash
npm create vite@latest failing-well -- --template react-ts
cd failing-well
npm install
npm install react-error-boundary
```

**2. The error sink** — create `error-sink.mjs` in the project root. It receives error reports on `/errors` and
fakes an API that fails on `/api/profile`:

```js
// error-sink.mjs — a stand-in for Sentry + a failing backend
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/errors') {
      const e = JSON.parse(body || '{}')
      console.log(
        `[sink] ${String(e.kind).padEnd(18)} release=${e.release}  msg="${e.message}"` +
          (e.component ? `  component=${e.component}` : '') +
          (e.correlationId ? `  correlationId=${e.correlationId}` : ''),
      )
      res.writeHead(204).end()
      return
    }
    if (req.method === 'POST' && req.url === '/api/profile') {
      const traceId = randomBytes(16).toString('hex')
      console.log(`[api]  POST /api/profile -> 500  traceId=${traceId}`)
      res.writeHead(500, { 'Content-Type': 'application/problem+json' })
      res.end(JSON.stringify({ title: 'An error occurred while processing your request.', status: 500, traceId }))
      return
    }
    res.writeHead(404).end()
  })
}).listen(4319, () => console.log('[sink] listening on http://localhost:4319'))
```

**3. Proxy and hidden source maps** — replace `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const proxy = { '/api': 'http://localhost:4319', '/errors': 'http://localhost:4319' }

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: 'hidden' },
  server: { proxy },
  preview: { proxy },
})
```

**4. The reporter** — create `src/lib/reporter.ts`:

```ts
type Kind = 'caught' | 'uncaught' | 'recoverable' | 'window.error' | 'unhandledrejection' | 'handled'
type Extra = { componentStack?: string; correlationId?: string }

const RELEASE: string = import.meta.env.VITE_RELEASE ?? 'dev'
const MAX_PER_PAGE = 20
const seen = new Set<string>()
let sent = 0

export function report(kind: Kind, error: unknown, extra: Extra = {}) {
  const err = error instanceof Error ? error : new Error(String(error))
  if (err.name === 'AbortError') return                     // the user navigated away: noise
  const fingerprint = `${kind}:${err.message}`
  if (seen.has(fingerprint) || sent >= MAX_PER_PAGE) return  // de-duplicate + rate-limit
  seen.add(fingerprint)
  sent++
  if (import.meta.env.DEV) console.error(`[report:${kind}]`, err)

  const payload = {
    kind,
    release: RELEASE,
    message: err.message,
    stack: err.stack,
    component: extra.componentStack?.match(/at (\S+)/)?.[1],
    correlationId: extra.correlationId,
    url: location.href,
    at: new Date().toISOString(),
  }
  // keepalive lets the request finish even if the page is unloading; never let reporting throw
  fetch('/errors', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {})
}

export function installGlobalHandlers() {
  window.addEventListener('error', (e) => report('window.error', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => report('unhandledrejection', e.reason))
}
```

**5. The API client** — create `src/lib/api.ts`:

```ts
export type ProblemDetails = {
  type?: string; title?: string; status?: number; detail?: string
  traceId?: string; errors?: Record<string, string[]>
}

export class ApiError extends Error {
  status: number
  problem: ProblemDetails | null
  correlationId: string | undefined
  constructor(status: number, problem: ProblemDetails | null, correlationId?: string) {
    super(problem?.title ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
    this.correlationId = correlationId
  }
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T
  const isJson = res.headers.get('content-type')?.includes('json') ?? false
  const problem = isJson ? ((await res.json().catch(() => null)) as ProblemDetails | null) : null
  throw new ApiError(res.status, problem, problem?.traceId ?? res.headers.get('x-correlation-id') ?? undefined)
}
```

**6. Report from the root** — replace `src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { installGlobalHandlers, report } from './lib/reporter'
import './index.css'

installGlobalHandlers()

createRoot(document.getElementById('root')!, {
  onCaughtError: (error, info) => report('caught', error, { componentStack: info.componentStack }),
  onUncaughtError: (error, info) => report('uncaught', error, { componentStack: info.componentStack }),
  onRecoverableError: (error, info) => report('recoverable', error, { componentStack: info.componentStack }),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

**7. The app** — replace `src/App.tsx`:

```tsx
import { useState } from 'react'
import { ErrorBoundary, useErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { ApiError, apiFetch } from './lib/api'
import { report } from './lib/reporter'

function PanelError({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div role="alert">
      <p>This panel crashed: {error instanceof Error ? error.message : String(error)}</p>
      <button onClick={resetErrorBoundary}>Try again</button>
    </div>
  )
}

function BuggyCounter() {
  const [n, setN] = useState(0)
  if (n === 3) throw new Error('Counter hit 3')
  return <button onClick={() => setN(n + 1)}>Count: {n}</button>
}

function ImportButton() {
  const { showBoundary } = useErrorBoundary()
  async function onImport() {
    try {
      await Promise.reject(new Error('Import file is corrupt'))
    } catch (error) {
      showBoundary(error)
    }
  }
  return <button onClick={onImport}>Import (fails via showBoundary)</button>
}

function SaveProfile() {
  const [message, setMessage] = useState<string | null>(null)
  async function save() {
    setMessage(null)
    try {
      await apiFetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      setMessage('Saved')
    } catch (error) {
      const correlationId = error instanceof ApiError ? error.correlationId : undefined
      report('handled', error, { correlationId })
      setMessage(`We couldn't save your profile. Please try again.${correlationId ? ` Reference: ${correlationId}` : ''}`)
    }
  }
  return (
    <div>
      <button onClick={save}>Save profile</button>
      {message && <p role="alert">{message}</p>}
    </div>
  )
}

export default function App() {
  const [panel, setPanel] = useState<'counter' | 'import'>('counter')
  return (
    <main>
      <h1>Failing well</h1>
      <nav>
        <button onClick={() => setPanel('counter')}>Counter panel</button>{' '}
        <button onClick={() => setPanel('import')}>Import panel</button>
      </nav>
      <section>
        <h2>Inside the boundary</h2>
        <ErrorBoundary FallbackComponent={PanelError} resetKeys={[panel]}>
          {panel === 'counter' ? <BuggyCounter /> : <ImportButton />}
        </ErrorBoundary>
      </section>
      <section>
        <h2>Outside the boundary</h2>
        <SaveProfile />
        <button onClick={() => { void Promise.reject(new Error('Nobody awaited me')) }}>Fire and forget</button>
      </section>
    </main>
  )
}
```

**8. Run it** — two terminals:

```bash
# terminal 1
node error-sink.mjs
# terminal 2
npm run dev
```

Open http://localhost:5173 and do, in order: click **Count** three times; click **Import panel**, then
**Import**; click **Save profile**; click **Fire and forget**. Terminal 1 should print (your trace id differs):

```text
[sink] listening on http://localhost:4319
[sink] caught             release=dev  msg="Counter hit 3"  component=BuggyCounter
[sink] caught             release=dev  msg="Import file is corrupt"  component=ImportButton
[api]  POST /api/profile -> 500  traceId=9f1c4e2ab07d4c55a1e3f0b6d2c8a714
[sink] handled            release=dev  msg="An error occurred while processing your request."  correlationId=9f1c4e2ab07d4c55a1e3f0b6d2c8a714
[sink] unhandledrejection release=dev  msg="Nobody awaited me"
```

Notice the headings and the "Outside the boundary" section stayed on screen during every crash, and the
`traceId` from the `[api]` line is exactly the reference shown in the UI.

**9. Production build with a release and hidden maps**

```bash
VITE_RELEASE=$(git rev-parse --short HEAD 2>/dev/null || echo 1.0.0) npm run build
ls dist/assets
grep -c "sourceMappingURL" dist/assets/*.js
npm run preview
```

Expected: `ls` lists `index-<hash>.js` **and** `index-<hash>.js.map`; `grep -c` prints `0` for every `.js` file
(the maps exist but the bundle doesn't point at them). In `npm run preview` (http://localhost:4173), crash the
counter again: the sink now shows `release=<your sha or 1.0.0>` and a minified name like `component=Xe` — which
is precisely why the maps must be uploaded to your error tracker for exactly this build.

:::tip title="Swapping the sink for real Sentry"
`npm install @sentry/react @sentry/vite-plugin`, call `Sentry.init({ dsn, release: import.meta.env.VITE_RELEASE })`
before rendering, pass `Sentry.reactErrorHandler()` to the three root options instead of `report`, and add
`sentryVitePlugin({ org, project, authToken: process.env.SENTRY_AUTH_TOKEN, release: { name: process.env.VITE_RELEASE }, sourcemaps: { filesToDeleteAfterUpload: ['./dist/**/*.map'] } })`
as the last Vite plugin. Drop `installGlobalHandlers()`: the SDK installs its own `error` / `unhandledrejection`
listeners by default (its `globalHandlersIntegration`). For handled errors use
`Sentry.captureException(error, { tags: { correlationId } })`.
:::

:::warn title="Why didn't the second crash get reported?"
Reset the counter and crash it again: the fallback appears, but the sink stays quiet. That's the
de-duplication in `report()` — one report per fingerprint per page load. Real trackers group identical errors
server-side instead and count occurrences; client-side de-dupe is just cheap noise protection.
:::

- [ ] Crashing the counter shows the panel fallback while the headings and "Outside the boundary" section stay visible
- [ ] **Try again** brings the counter back, and switching to **Import panel** resets a crashed panel via `resetKeys`
- [ ] The sink prints `caught`, `handled` (with a correlationId matching the `[api]` traceId) and `unhandledrejection` lines
- [ ] The UI shows `Reference: <traceId>` for the failed save
- [ ] `npm run build` produces `.js.map` files and `grep -c sourceMappingURL dist/assets/*.js` prints `0`
- [ ] In `npm run preview` the sink shows the release you passed in `VITE_RELEASE`
:::

:::cards id=fe-29-cards1 xp=15 title="Failing well"
Q: What does an error boundary catch?
A: Errors thrown while rendering its descendants, in their lifecycles and effects, and rejections read via `use()`/`lazy()`.
   Not: event handlers, async callbacks, or errors in the boundary itself.
Q: How do you get an event-handler error into a boundary?
A: `showBoundary(error)` from `useErrorBoundary()` (react-error-boundary), or `setState(() => { throw error })` — it's re-thrown during render.
Q: What are `resetKeys` for?
A: Automatic reset when the input changes (e.g. a new `projectId`) while the fallback is shown. Compared element by element.
Q: Why must a promise passed to `use()` be created outside render?
A: Suspending discards the render; a new promise each attempt never resolves for React → infinite suspend/refetch.
Q: Which errors should be retried automatically?
A: Transient ones: network errors, 408, 429 (honour Retry-After), 5xx — with exponential backoff, then a manual Try again. Not 400/403/404/409/422.
Q: 400/422 with `errors` vs 409 — what UI?
A: Field errors inline (aria-invalid + aria-describedby, focus first) vs a form-level conflict message that keeps the user's input.
Q: When is a toast the right choice?
A: Transient, non-blocking feedback with no place on screen: "Copied", or a failed background action with Undo/Retry.
Q: What do `error` and `unhandledrejection` listeners give you?
A: A reporting safety net for errors React never sees. Not a UX mechanism — the context is gone by then.
Q: `build.sourcemap: 'hidden'`?
A: Maps are generated but not referenced from the bundle; upload them to the tracker in CI, then delete them before deploying.
Q: Why tag errors with a release?
A: You can see which deploy introduced an error, alert on regressions, and track crash-free rates per release.
   Older trackers also find source maps by release (modern Sentry matches maps by injected debug IDs).
Q: What is a correlation id good for?
A: It's shown to the user as "Reference: …" and stored in both backend logs and the browser report — one search finds the failing request.
:::

## Recap

- Errors land in one of three places: a **boundary** (render/effects), **window `error`** (handlers), or
  **`unhandledrejection`** (async). Design for all three.
- Error boundaries are class components (or `react-error-boundary`); place them by blast radius — root, route,
  widget — and always give a way out: **reset**, `resetKeys`, and clearing cached causes in `onReset`.
- `<Suspense>` + error boundary split "not ready" from "failed", so components render the happy path.
  `use(promise)` needs a **stable** promise; `useSuspenseQuery` + `QueryErrorResetBoundary` is the production form.
- Design loading, empty, error, stale and partial states; keep stale data on refetch failure.
- Retry only transient failures, automatically with backoff, then hand control to the user; cancel on unmount.
- Map ProblemDetails in one API client: 400/422 → field errors, 409 → keep input and reconcile, 5xx → generic
  message + reference id. Inline for things the user must fix, toasts for transient background feedback.
- Report in one place (root `onCaughtError`/`onUncaughtError` + global listeners), filter noise, upload hidden
  source maps in CI (and check the upload actually ran), tag every event with a **release**, and link browser
  errors to backend logs with **correlation ids**.
