---
id: fe-15
title: Server State with TanStack Query
level: intermediate
minutes: 75
xp: 180
summary: Server state is a cache, not state — queries, query keys, staleTime, mutations, invalidation and optimistic updates with TanStack Query.
---

Most data in a business app doesn't belong to the browser. The project list, the current user's profile,
the invoices — they live in PostgreSQL behind your ASP.NET API. The browser only holds a **copy**, and
that copy starts going stale the moment it arrives, because other users (and other tabs) keep changing
the original.

That's the key insight of this lesson: **server state is a cache, not state.** Treating it like
`useState` data is the root of a whole family of bugs.

## Server state vs client state

| | Client state | Server state |
|---|---|---|
| Owner | the browser | the server/database |
| Examples | is the modal open, form draft, theme, selected tab | projects, tasks, users, permissions |
| Can be out of date? | no — it *is* the truth | **always potentially** |
| Shared with other users? | no | yes |
| Needs | `useState`, `useReducer`, Context, Zustand | fetching, caching, deduping, refetching, invalidation |

:::quiz id=fe-15-q1 xp=10
Which of these are **server state**? (Select all that apply.)
- [x] The list of tasks on a project board
- [ ] Whether the "New task" dialog is open
- [x] The signed-in user's profile and permissions returned by `/api/me`
- [ ] The text currently typed into a search box
- [x] The number of unread notifications shown in the header
> If the source of truth is on the server and it can change without this browser knowing, it's server state.
> Dialog visibility and input drafts are owned by the browser — client state.
:::

## Why `useEffect` + `fetch` isn't enough

Everyone's first data-fetching code looks like this:

```tsx
function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then(setProjects)
      .catch(setError)
      .finally(() => setLoading(false))
  }, [])
  // …
}
```

It works in the demo. In production it has all of these problems:

- **No caching** — navigate away and back, and you get a spinner and another request every time.
- **No deduplication** — the header and the sidebar both need `/api/me`? Two requests.
- **Race conditions** — change a filter quickly and an *older*, slower response can overwrite the newer one.
- **Stale data forever** — another user renames a project; you never find out until a full reload.
- **No retries** — one flaky network blip shows an error page.
- **Mutations are on you** — after creating a project, *who* refetches the list? Every screen that shows it?
- **Boilerplate** — three `useState`s and an effect per request, copy-pasted everywhere.

You could fix each one by hand. That's exactly what **TanStack Query** (formerly React Query) already did,
very well. It is the de-facto standard for server state in React apps.

## Setup

```bash
npm install @tanstack/react-query @tanstack/react-query-devtools
```

The devtools are a regular dependency (not `-D`) because app code imports them. They render only when
`NODE_ENV` is `development`, so they cost nothing in production, and a Docker build that runs
`npm ci --omit=dev` before `vite build` still finds the import.

```tsx
// src/app/providers.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 2 },
  },
})

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  )
}
```

The `QueryClient` holds the **cache**. The provider makes it available to every component (yes — it's
Context under the hood, used for exactly what Context is good at: injecting a rarely-changing dependency).

## Queries

```tsx
import { useQuery } from '@tanstack/react-query'

function ProjectList() {
  const { data, isPending, isError, error, isFetching } = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await fetch('/api/projects')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)   // fetch doesn't throw on 4xx/5xx!
      return (await res.json()) as Project[]
    },
  })

  if (isPending) return <Spinner />
  if (isError && !data) return <p role="alert">Could not load projects: {error.message}</p>
  return (
    <>
      {isFetching && <small>Refreshing…</small>}
      {isError && <small role="status">Couldn't refresh, showing saved data</small>}
      <ul>{data.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
    </>
  )
}
```

- **`queryKey`** — the cache key. Same key anywhere in the app = same cached data, one request.
- **`queryFn`** — any function returning a promise. It must **throw** on failure (remember: `fetch` only
  rejects on network errors, not on HTTP 500).
- **`isPending`** — no data yet (first load). **`isFetching`** — a request is in flight, maybe in the
  background while old data is shown. The difference matters: show a spinner for `isPending`, a subtle
  indicator for background `isFetching`.
- **`isError` with data** — if a *background* refetch fails, the query goes to `isError` but **keeps the
  last good `data`**. Checking `isError` before `data` would replace a perfectly usable list with an error
  page because of one failed refresh; show a small "couldn't refresh" notice next to the data instead.

TanStack Query also hands your `queryFn` an **`AbortSignal`**. Pass it on and requests for data nobody needs
any more (the component unmounted, the key changed, `cancelQueries` was called) are actually aborted:

```ts
queryFn: async ({ signal }) => {
  const res = await fetch('/api/projects', { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as Project[]
}
```

:::quiz id=fe-15-q4 xp=10
Your ASP.NET Core API fails and answers **HTTP 500** with a JSON `ProblemDetails` body
(`{ "title": "An error occurred", "status": 500 }`). What does this query do?

```ts
useQuery({ queryKey: ['projects'], queryFn: () => fetch('/api/projects').then((r) => r.json()) })
```

The component then renders `data.map((p) => <li key={p.id}>{p.name}</li>)`.

- [ ] `isError` becomes `true` and TanStack Query retries the request
- [ ] `fetch` rejects on a 5xx status, so `error.message` is "HTTP 500"
- [x] The query **succeeds**: the `ProblemDetails` object is cached as `data`, and the component crashes later on `data.map`
- [ ] TanStack Query checks `response.status` and turns the 500 into an error automatically
> `fetch` only rejects on **network** failures — a 500 is a perfectly successful HTTP exchange — and the body is
> valid JSON, so `r.json()` resolves too. TanStack Query never sees a `Response`, only whatever your `queryFn`
> returns, so it can't know about the status. The error object is cached as "successful" data (no retry, no
> `isError`), and the crash happens far away. Always `if (!res.ok) throw new Error(...)` inside the `queryFn`.
:::

### Query keys are dependency arrays

Everything the `queryFn` depends on **must** be in the key:

```ts
useQuery({ queryKey: ['projects', { page, status }], queryFn: () => getProjects({ page, status }) })
useQuery({ queryKey: ['projects', projectId], queryFn: () => getProject(projectId) })
useQuery({ queryKey: ['projects', projectId, 'tasks'], queryFn: () => getTasks(projectId) })
```

If you forget `page` in the key, page 2 will happily show the cached data of page 1. When the key changes,
TanStack Query fetches the new key — and the race condition disappears, because each key has its own cache
entry and results can never land in the wrong one.

Keys are **hierarchical**: `['projects']` is a prefix of `['projects', 42]` and `['projects', 42, 'tasks']`.
That's what makes invalidation powerful: `invalidateQueries({ queryKey: ['projects'] })` hits all three.

Keys must be **serialisable** (strings, numbers, booleans, plain objects and arrays). Objects are hashed
with their properties sorted, so `{ page, status }` and `{ status, page }` are the same key.

:::quiz id=fe-15-q5 xp=10
Spot the bug. Users report that switching to page 2 still shows page 1's projects (until they refresh).

```ts
function useProjects(page: number) {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api.getProjects({ page }),
  })
}
```

- [ ] `staleTime` is 0, so the cache is ignored and the wrong page loads
- [x] `page` is missing from the key, so every page shares the single `['projects']` cache entry
- [ ] `queryFn` must be an `async` function
- [ ] You must call `refetch()` manually whenever `page` changes
> The key is the cache identity and the trigger for refetching. With `['projects']`, page 2 finds a cached
> entry and shows it; the `queryFn` closure does change, but TanStack Query only refetches when the **key**
> changes (or the data goes stale). Fix: `queryKey: ['projects', { page }]`. Calling `refetch()` by hand would
> "work" but you'd still overwrite one shared entry — exactly the race the key is meant to prevent. The
> `@tanstack/eslint-plugin-query` rule `exhaustive-deps` catches this automatically.
:::

### Dependent queries and pagination

Two options you'll need in the first week:

```ts
// 1. Dependent query: don't run until we know the user id
const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.getMe })
const { data: tasks } = useQuery({
  queryKey: ['tasks', { assignee: me?.id }],
  queryFn: () => api.getTasks({ assignee: me!.id }),
  enabled: !!me,                       // stays isPending (but not fetching) until me arrives
})

// 2. Pagination without a spinner flash between pages
import { keepPreviousData } from '@tanstack/react-query'
const { data, isPlaceholderData } = useQuery({
  queryKey: ['projects', { page }],
  queryFn: () => api.getProjects({ page }),
  placeholderData: keepPreviousData,   // show page 1 (dimmed) while page 2 loads
})
```

Without `enabled`, the second query would fire immediately with `assignee: undefined`. Without
`placeholderData`, every new page key starts empty, so the table collapses into a spinner on each click.
`isPlaceholderData` tells you the rows on screen are the old page — use it to dim the table or disable "Next".

:::pro title="Query key factories"
Real codebases don't sprinkle string arrays everywhere. They define them once, per feature:

```ts
export const projectKeys = {
  all: ['projects'] as const,
  lists: () => [...projectKeys.all, 'list'] as const,
  list: (filters: ProjectFilters) => [...projectKeys.lists(), filters] as const,
  detail: (id: number) => [...projectKeys.all, 'detail', id] as const,
}

export const projectQuery = (id: number) =>
  queryOptions({ queryKey: projectKeys.detail(id), queryFn: () => api.getProject(id) })
```

`queryOptions()` bundles key + fn + options with full type inference; use it in `useQuery`, in router
loaders (`queryClient.ensureQueryData(projectQuery(id))`) and in prefetching.
:::

:::challenge id=fe-15-c1 lang=ts xp=40
title: How invalidation matches keys
`queryClient.invalidateQueries({ queryKey: filter })` affects every query whose key **starts with**
`filter`. Implement `partialMatchKey(queryKey, filter)` the way TanStack Query does:

- `filter` must be a prefix of `queryKey` (element by element).
- Primitive elements must be equal (`===`).
- If a filter element is an **object**, the query element must be an object that contains every
  property of the filter object with a matching value (recursively — extra properties are fine).
- An empty filter matches everything.

hint: Write a recursive `partial(a, b)`: if `b` is an object (and not null), every key of `b` must partially match in `a`; otherwise `a === b`.
hint: Arrays are objects too — comparing them index-by-index with the same rule works.

```ts starter
export function partialMatchKey(queryKey: unknown[], filter: unknown[]): boolean {
  return JSON.stringify(queryKey) === JSON.stringify(filter)
}
```

```ts solution
function partial(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return Object.keys(b).every((k) => partial((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

export function partialMatchKey(queryKey: unknown[], filter: unknown[]): boolean {
  if (filter.length > queryKey.length) return false
  return filter.every((f, i) => partial(queryKey[i], f))
}
```

```ts tests
test('prefix matches', () => {
  expect(partialMatchKey(['projects', 42, 'tasks'], ['projects'])).toBe(true)
  expect(partialMatchKey(['projects', 42, 'tasks'], ['projects', 42])).toBe(true)
})
test('exact match', () => {
  expect(partialMatchKey(['projects', 42], ['projects', 42])).toBe(true)
})
test('different element does not match', () => {
  expect(partialMatchKey(['projects', 42], ['projects', 7])).toBe(false)
  expect(partialMatchKey(['users'], ['projects'])).toBe(false)
})
test('filter longer than key does not match', () => {
  expect(partialMatchKey(['projects'], ['projects', 42])).toBe(false)
})
test('objects match partially', () => {
  const key = ['projects', 'list', { status: 'active', page: 2 }]
  expect(partialMatchKey(key, ['projects', 'list', { status: 'active' }])).toBe(true)
  expect(partialMatchKey(key, ['projects', 'list', { status: 'archived' }])).toBe(false)
  expect(partialMatchKey(key, ['projects', 'list', {}])).toBe(true)
})
test('nested objects', () => {
  const key = ['search', { filter: { owner: 'ada', tags: ['x'] }, sort: 'name' }]
  expect(partialMatchKey(key, ['search', { filter: { owner: 'ada' } }])).toBe(true)
  expect(partialMatchKey(key, ['search', { filter: { owner: 'bob' } }])).toBe(false)
})
test('object filter vs primitive key element', () => {
  expect(partialMatchKey(['projects', 42], ['projects', { id: 42 }])).toBe(false)
})
test('empty filter matches all', () => {
  expect(partialMatchKey(['anything', 1], [])).toBe(true)
})
```
:::

## Freshness: `staleTime` and `gcTime`

These two options confuse everyone at first. They answer different questions:

- **`staleTime`** (default **0**): *how long is fetched data considered fresh?* While fresh, TanStack Query
  serves it from cache **without** refetching. Once stale, it's still shown instantly, but a background
  refetch is triggered on certain events.
- **`gcTime`** (default **5 minutes**, formerly `cacheTime`): *how long does unused data stay in memory?*
  When no component uses a query any more, a timer starts; when it fires, the entry is garbage-collected.

The **stale-while-revalidate** flow when a component mounts with a cached but stale entry:

1. Render the cached data immediately (no spinner!).
2. Fire a background refetch (`isFetching = true`).
3. Swap in the new data when it arrives.

Stale queries refetch automatically on: a new component mounting with that key, **window refocus**
(`refetchOnWindowFocus`), and **network reconnect**. This is why apps using TanStack Query "just stay up to
date" when you alt-tab back.

| Data | Sensible `staleTime` |
|---|---|
| Live dashboard, chat | `0` (+ maybe `refetchInterval`) or push via SignalR |
| Typical lists/details | 30 s – 5 min |
| Reference data (countries, enum lists) | `Infinity` |

:::quiz id=fe-15-q2 xp=15
A query has `staleTime: 60_000` and default `gcTime`. The user opens the Projects page, leaves for 2 minutes
to another page (no component uses the query), then comes back. What happens?
- [ ] A spinner shows, then fresh data — the cache was cleared
- [x] Cached data shows instantly, and a background refetch runs because the data is stale
- [ ] Cached data shows and no request is made, because the data is still fresh
- [ ] An error: the query was garbage collected
> After 2 minutes the data is older than `staleTime` (stale) but younger than `gcTime` (5 min, still cached).
> Stale-while-revalidate: show cached data instantly, refetch in the background. "No request" would only be
> right within the first 60 s; "spinner, cache cleared" would only be right after more than 5 minutes unused.
:::

:::challenge id=fe-15-c2 lang=ts xp=50
title: A tiny query cache
Build the core of a query cache:

- `hashKey(key)` — a stable string for a key. Object properties must be **sorted**, so
  `['todos', { page: 1, status: 'done' }]` and `['todos', { status: 'done', page: 1 }]` hash the same.
- `class QueryCache` with `constructor(staleTime: number)` and:
  - `set(key, data, now)` — store data with `updatedAt = now`, clears any invalidation.
  - `get(key)` — the data or `undefined`.
  - `isStale(key, now)` — `true` if missing, invalidated, or `now - updatedAt >= staleTime`.
  - `invalidate(prefix)` — mark every entry whose key starts with `prefix` (simple `===` per element) as invalidated.

hint: `JSON.stringify(key, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v))`
hint: Store the original key next to the data in a `Map<string, { key, data, updatedAt, invalidated }>` so `invalidate` can compare elements.

```ts starter
export function hashKey(key: unknown[]): string {
  return JSON.stringify(key)
}

export class QueryCache {
  constructor(public staleTime: number) {}
  set(key: unknown[], data: unknown, now: number) {}
  get(key: unknown[]): unknown {
    return undefined
  }
  isStale(key: unknown[], now: number): boolean {
    return true
  }
  invalidate(prefix: unknown[]) {}
}
```

```ts solution
export function hashKey(key: unknown[]): string {
  return JSON.stringify(key, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  )
}

type Entry = { key: unknown[]; data: unknown; updatedAt: number; invalidated: boolean }

export class QueryCache {
  staleTime: number
  entries = new Map<string, Entry>()
  constructor(staleTime: number) {
    this.staleTime = staleTime
  }
  set(key: unknown[], data: unknown, now: number) {
    this.entries.set(hashKey(key), { key, data, updatedAt: now, invalidated: false })
  }
  get(key: unknown[]): unknown {
    return this.entries.get(hashKey(key))?.data
  }
  isStale(key: unknown[], now: number): boolean {
    const e = this.entries.get(hashKey(key))
    if (!e || e.invalidated) return true
    return now - e.updatedAt >= this.staleTime
  }
  invalidate(prefix: unknown[]) {
    for (const e of this.entries.values()) {
      if (prefix.every((p, i) => e.key[i] === p)) e.invalidated = true
    }
  }
}
```

```ts tests
test('hashKey is stable regardless of property order', () => {
  expect(hashKey(['todos', { page: 1, status: 'done' }])).toBe(hashKey(['todos', { status: 'done', page: 1 }]))
  expect(hashKey(['todos', 1])).not.toBe(hashKey(['todos', 2]))
})
test('hashKey sorts nested objects too', () => {
  expect(hashKey([{ a: { y: 1, x: 2 } }])).toBe(hashKey([{ a: { x: 2, y: 1 } }]))
})
test('get/set', () => {
  const c = new QueryCache(1000)
  c.set(['projects'], [1, 2], 0)
  expect(c.get(['projects'])).toEqual([1, 2])
  expect(c.get(['users'])).toBeUndefined()
})
test('same logical key shares an entry', () => {
  const c = new QueryCache(1000)
  c.set(['p', { b: 2, a: 1 }], 'x', 0)
  expect(c.get(['p', { a: 1, b: 2 }])).toBe('x')
})
test('fresh until staleTime has passed', () => {
  const c = new QueryCache(1000)
  expect(c.isStale(['p'], 0)).toBe(true)
  c.set(['p'], 'x', 5000)
  expect(c.isStale(['p'], 5999)).toBe(false)
  expect(c.isStale(['p'], 6000)).toBe(true)
})
test('invalidate marks matching prefixes stale', () => {
  const c = new QueryCache(60_000)
  c.set(['projects'], 'list', 0)
  c.set(['projects', 42], 'detail', 0)
  c.set(['users'], 'u', 0)
  c.invalidate(['projects'])
  expect(c.isStale(['projects'], 1)).toBe(true)
  expect(c.isStale(['projects', 42], 1)).toBe(true)
  expect(c.isStale(['users'], 1)).toBe(false)
  expect(c.get(['projects', 42])).toBe('detail')
})
test('set clears invalidation', () => {
  const c = new QueryCache(60_000)
  c.set(['p'], 1, 0)
  c.invalidate(['p'])
  c.set(['p'], 2, 10)
  expect(c.isStale(['p'], 11)).toBe(false)
})
```
:::

## Build the hook yourself (once)

To really understand what `useQuery` saves you from, implement a small version: shared cache, request
deduplication, loading and error states, and no "set state after the key changed" race.

:::challenge id=fe-15-c3 lang=tsx xp=70 preview=Demo
title: useQueryLite
Implement `useQueryLite(key, fetcher)` returning `{ status: 'pending' | 'success' | 'error', data?, error? }`:

- Keep a module-level `inflight` map of `key → Promise`. If a promise for the key exists, **reuse** it
  (two components with the same key → the fetcher runs once).
- Re-run when `key` changes; ignore results that arrive after the key changed or the component unmounted.
- On error, remove the key from the map (so a later mount can retry) and expose the error.

`UserName` and `Demo` are given and use the hook.

hint: `useEffect(() => { let active = true; …; return () => { active = false } }, [key])`
hint: `let p = inflight.get(key); if (!p) { p = fetcher(); inflight.set(key, p) }`
hint: `p.then(data => active && setState({ status: 'success', data }), error => { inflight.delete(key); if (active) setState({ status: 'error', error }) })`

```tsx starter
import { useEffect, useState } from 'react'

type QueryState<T> = { status: 'pending' | 'success' | 'error'; data?: T; error?: Error }
const inflight = new Map<string, Promise<unknown>>()

export function useQueryLite<T>(key: string, fetcher: () => Promise<T>): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ status: 'pending' })
  return state
}

export function UserName({ id, fetchUser }: { id: number; fetchUser: (id: number) => Promise<string> }) {
  const q = useQueryLite(`user-${id}`, () => fetchUser(id))
  if (q.status === 'pending') return <p>Loading…</p>
  if (q.status === 'error') return <p role="alert">Error: {q.error!.message}</p>
  return <p>{q.data}</p>
}

const demoFetch = (id: number) => new Promise<string>((r) => setTimeout(() => r(id === 1 ? 'Ada' : 'Linus'), 400))
export function Demo() {
  return <><UserName id={1} fetchUser={demoFetch} /><UserName id={1} fetchUser={demoFetch} /></>
}
```

```tsx solution
import { useEffect, useState } from 'react'

type QueryState<T> = { status: 'pending' | 'success' | 'error'; data?: T; error?: Error }
const inflight = new Map<string, Promise<unknown>>()

export function useQueryLite<T>(key: string, fetcher: () => Promise<T>): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ status: 'pending' })
  useEffect(() => {
    let active = true
    setState({ status: 'pending' })
    let p = inflight.get(key) as Promise<T> | undefined
    if (!p) {
      p = fetcher()
      inflight.set(key, p)
    }
    p.then(
      (data) => { if (active) setState({ status: 'success', data }) },
      (error) => {
        inflight.delete(key)
        if (active) setState({ status: 'error', error })
      },
    )
    return () => { active = false }
  }, [key])
  return state
}

export function UserName({ id, fetchUser }: { id: number; fetchUser: (id: number) => Promise<string> }) {
  const q = useQueryLite(`user-${id}`, () => fetchUser(id))
  if (q.status === 'pending') return <p>Loading…</p>
  if (q.status === 'error') return <p role="alert">Error: {q.error!.message}</p>
  return <p>{q.data}</p>
}

const demoFetch = (id: number) => new Promise<string>((r) => setTimeout(() => r(id === 1 ? 'Ada' : 'Linus'), 400))
export function Demo() {
  return <><UserName id={1} fetchUser={demoFetch} /><UserName id={1} fetchUser={demoFetch} /></>
}
```

```tsx tests
test('shows loading, then data', async () => {
  const fetchUser = fn(async (id: number) => `user #${id}`)
  render(<UserName id={101} fetchUser={fetchUser as any} />)
  expect(screen.getByText('Loading…')).toBeInTheDocument()
  expect(await screen.findByText('user #101')).toBeInTheDocument()
})
test('dedupes: same key → one request', async () => {
  const fetchUser = fn(async () => 'Grace')
  render(<><UserName id={202} fetchUser={fetchUser as any} /><UserName id={202} fetchUser={fetchUser as any} /></>)
  await waitFor(() => expect(screen.getAllByText('Grace')).toHaveLength(2))
  expect(fetchUser).toHaveBeenCalledTimes(1)
})
test('errors are shown', async () => {
  const fetchUser = fn(async () => { throw new Error('boom') })
  render(<UserName id={303} fetchUser={fetchUser as any} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Error: boom')
})
test('refetches when the key changes and ignores the old result', async () => {
  const slow = (id: number) => new Promise<string>((r) => setTimeout(() => r(`slow ${id}`), id === 404 ? 150 : 10))
  const { rerender } = render(<UserName id={404} fetchUser={slow} />)
  rerender(<UserName id={405} fetchUser={slow} />)
  expect(await screen.findByText('slow 405')).toBeInTheDocument()
  await sleep(200)
  expect(screen.queryByText('slow 404')).toBeNull()
  expect(screen.getByText('slow 405')).toBeInTheDocument()
})
```
:::

## Mutations and invalidation

Reading is half the story. To change server data, use `useMutation`:

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query'

function NewProjectForm() {
  const queryClient = useQueryClient()
  const createProject = useMutation({
    mutationFn: (input: NewProject) => api.createProject(input),
    onSuccess: (created) => {
      // Option A: mark related queries stale → active ones refetch
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() })
      // Option B: write the server's response straight into the cache
      queryClient.setQueryData(projectKeys.detail(created.id), created)
    },
  })

  return (
    <form onSubmit={(e) => { e.preventDefault(); createProject.mutate({ name: 'Apollo' }) }}>
      <button disabled={createProject.isPending}>Create</button>
      {createProject.isError && <p role="alert">{createProject.error.message}</p>}
    </form>
  )
}
```

**Invalidate** when you don't know exactly how the change affects cached data (sorting, filters, server-side
computed fields, pagination). It costs a request but is always correct. **`setQueryData`** when the server
returns the exact object you need — no extra request. Teams often do both: set the detail, invalidate lists.

What `invalidateQueries` actually does: it marks every matching query **stale** and immediately refetches
the ones that are **active** (currently used by a mounted component). Inactive matches just refetch the
next time something mounts them. If you `return` the promise from `onSuccess`
(`onSuccess: () => queryClient.invalidateQueries(...)`), the mutation stays `isPending` until that refetch
has finished — handy so the "Saving…" button doesn't re-enable before the list shows the new item.

Common mistake: calling `setQueryData` with a function that **mutates** the old value
(`old.push(created); return old`). The cache compares by reference, so nothing re-renders. Always return a
new array/object, exactly like a reducer.

:::job title="Typical review comment"
"After this mutation, the project list still shows the old name." — 90 % of server-state bugs in code
review are a **missing invalidation**. Whenever you write a `useMutation`, ask: *which query keys show
this data?* and invalidate their common prefix.
:::

## Optimistic updates

Some actions should feel instant: ticking a checkbox, liking, dragging a card. Waiting 300 ms for the
server feels broken. **Optimistic updates** apply the change to the UI *before* the server confirms, and
**roll back** if it fails:

```tsx
const toggleTask = useMutation({
  mutationFn: (task: Task) => api.updateTask(task.id, { done: !task.done }),
  onMutate: async (task) => {
    await queryClient.cancelQueries({ queryKey: taskKeys.list(projectId) })   // don't let a refetch overwrite us
    const previous = queryClient.getQueryData<Task[]>(taskKeys.list(projectId))  // snapshot
    queryClient.setQueryData<Task[]>(taskKeys.list(projectId), (old = []) =>
      old.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)))
    return { previous }                                     // → passed to onError/onSettled
  },
  onError: (_err, _task, onMutateResult) => {
    queryClient.setQueryData(taskKeys.list(projectId), onMutateResult?.previous)  // rollback
    toast.error('Could not update the task')                                      // any toast library
  },
  onSettled: () => queryClient.invalidateQueries({ queryKey: taskKeys.list(projectId) }), // re-sync with truth
})
```

The four steps — **cancel, snapshot, apply, rollback-on-error**, then **re-sync** — are worth memorising.
For simple cases where only one component shows the pending change, v5 also lets you skip the cache and
render `mutation.variables` while `mutation.isPending`.

:::warn title="Don't be optimistic about everything"
Optimistic UI is great when success is very likely and the action is easily reversible (toggle, like,
reorder). Don't fake success for payments, deletions of important data, or anything with server-side
validation that often fails — show a pending state instead. And the rollback must be **visible**: tell the
user it didn't work.
:::

:::challenge id=fe-15-c4 lang=tsx xp=60 preview=Demo
title: Optimistic like with rollback
Make `LikeButton` optimistic:

- The button shows `Like · {count}` and has `aria-pressed` reflecting `liked`.
- On click, flip `liked` and adjust `count` (±1) **immediately**, then `await api.setLiked(nextLiked)`.
- If the promise rejects: restore the previous `liked` and `count`, and show
  `<p role="alert">Could not save your like</p>`. Clear the alert on the next click.

hint: Snapshot first: `const prev = { liked, count }`.
hint: `try { await api.setLiked(next) } catch { setLiked(prev.liked); setCount(prev.count); setError(true) }`

```tsx starter
import { useState } from 'react'

type Api = { setLiked: (liked: boolean) => Promise<void> }

export function LikeButton({ initialLiked, initialCount, api }: { initialLiked: boolean; initialCount: number; api: Api }) {
  const [liked, setLiked] = useState(initialLiked)
  const [count, setCount] = useState(initialCount)

  async function onClick() {
    try {
      await api.setLiked(!liked)
      setLiked(!liked)
      setCount(count + (liked ? -1 : 1))
    } catch {
      // TODO: optimistic update + rollback + alert
    }
  }

  return <button aria-pressed={liked} onClick={onClick}>Like · {count}</button>
}

const flaky: Api = { setLiked: () => new Promise((ok, fail) => setTimeout(() => (Math.random() < 0.5 ? ok() : fail(new Error('500'))), 600)) }
export function Demo() {
  return <LikeButton initialLiked={false} initialCount={41} api={flaky} />
}
```

```tsx solution
import { useState } from 'react'

type Api = { setLiked: (liked: boolean) => Promise<void> }

export function LikeButton({ initialLiked, initialCount, api }: { initialLiked: boolean; initialCount: number; api: Api }) {
  const [liked, setLiked] = useState(initialLiked)
  const [count, setCount] = useState(initialCount)
  const [error, setError] = useState(false)

  async function onClick() {
    const prev = { liked, count }
    const next = !liked
    setError(false)
    setLiked(next)
    setCount(count + (next ? 1 : -1))
    try {
      await api.setLiked(next)
    } catch {
      setLiked(prev.liked)
      setCount(prev.count)
      setError(true)
    }
  }

  return (
    <>
      <button aria-pressed={liked} onClick={onClick}>Like · {count}</button>
      {error && <p role="alert">Could not save your like</p>}
    </>
  )
}

const flaky: Api = { setLiked: () => new Promise((ok, fail) => setTimeout(() => (Math.random() < 0.5 ? ok() : fail(new Error('500'))), 600)) }
export function Demo() {
  return <LikeButton initialLiked={false} initialCount={41} api={flaky} />
}
```

```tsx tests
function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('updates immediately, before the server answers', async () => {
  const d = deferred()
  const api = { setLiked: fn(() => d.promise) }
  render(<LikeButton initialLiked={false} initialCount={10} api={api as any} />)
  const btn = screen.getByRole('button', { name: /like/i })
  await user.click(btn)
  expect(btn).toHaveTextContent('Like · 11')
  expect(btn).toHaveAttribute('aria-pressed', 'true')
  expect(api.setLiked).toHaveBeenCalledWith(true)
  await act(async () => { d.resolve() })
  expect(btn).toHaveTextContent('Like · 11')
  expect(screen.queryByRole('alert')).toBeNull()
})
test('rolls back and shows an alert on failure', async () => {
  const d = deferred()
  render(<LikeButton initialLiked={false} initialCount={10} api={{ setLiked: () => d.promise }} />)
  const btn = screen.getByRole('button', { name: /like/i })
  await user.click(btn)
  expect(btn).toHaveTextContent('Like · 11')
  await act(async () => { d.reject(new Error('500')) })
  await waitFor(() => expect(btn).toHaveTextContent('Like · 10'))
  expect(btn).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('alert')).toHaveTextContent('Could not save your like')
})
test('unliking decrements and the alert clears on the next click', async () => {
  let fail = true
  const api = { setLiked: () => (fail ? Promise.reject(new Error('x')) : Promise.resolve()) }
  render(<LikeButton initialLiked={true} initialCount={5} api={api} />)
  const btn = screen.getByRole('button', { name: /like/i })
  await user.click(btn)
  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  expect(btn).toHaveTextContent('Like · 5')
  fail = false
  await user.click(btn)
  await waitFor(() => expect(btn).toHaveTextContent('Like · 4'))
  expect(btn).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByRole('alert')).toBeNull()
})
```
:::

:::quiz id=fe-15-q3 xp=15
In an optimistic `useMutation`, why call `queryClient.cancelQueries(...)` at the start of `onMutate`?
- [ ] To stop the mutation request from being sent twice
- [x] So an in-flight refetch with old data can't land after the optimistic update and overwrite it
- [ ] Because `setQueryData` throws while a query is fetching
- [ ] To clear the cache so the rollback works
> If a background refetch started before your mutation, its (now outdated) response could arrive after you
> applied the optimistic change and silently revert it. Cancelling it first prevents that flicker.
> It has nothing to do with the mutation request itself (that is sent exactly once), and `setQueryData` works
> fine while a query is fetching — that's precisely why the late response could overwrite you.
:::

## A typed API layer: generated types, one client, auth refresh

So far every `queryFn` has called `fetch` itself and finished with `as Project[]`. Multiply that by a hundred
endpoints and three problems appear: the base URL, headers and error handling are copy-pasted; every `as` is a
promise to the compiler that nobody checks; and when the backend renames a field, nothing fails until a user
sees `undefined`. Real codebases solve this with **one API layer** under `src/api/` that components never
bypass.

**1. Generate the types from the backend's contract.** ASP.NET Core 10 publishes an OpenAPI document
(`Microsoft.AspNetCore.OpenApi`, served at `/openapi/v1.json`). A generator turns it into TypeScript, so the
types *are* the backend's, not a hand-written guess:

```bash
npx openapi-typescript http://localhost:5000/openapi/v1.json -o src/api/schema.d.ts   # run in CI too
```

```ts
// src/api/client.ts — openapi-fetch is a ~6 kB fetch wrapper typed by the generated `paths`
import createClient from 'openapi-fetch'
import type { paths } from './schema'

export const client = createClient<paths>({ baseUrl: '/api' })

// Path, params and response are all checked against the contract:
const { data, error } = await client.GET('/projects/{id}', { params: { path: { id: 42 } } })
//      ^? data: ProjectDto | undefined — a typo in the path or a missing param is a compile error
```

Run the generator in CI and fail the build if `schema.d.ts` changed but wasn't committed: a backend change
that breaks the frontend then shows up as a **type error in a pull request**, not a bug in production.
(Alternatives: **orval** or **Kiota** generate whole clients, and orval can even generate TanStack Query
hooks. The idea is the same.) Generated types describe what the server *promises*; if you don't control
the server, add a runtime check (a Zod schema or type guard from **TypeScript for Real Apps**) at the boundary.

**2. Wrap the client in query options, not in components.** Components ask for *data*, not URLs:

```ts
// src/api/errors.ts
export class ApiError extends Error {
  readonly status: number
  readonly body: unknown                       // usually ASP.NET ProblemDetails
  constructor(status: number, body: unknown) { super(`HTTP ${status}`); this.status = status; this.body = body }
}

// src/api/projects.ts
export const projectQueries = {
  detail: (id: number) => queryOptions({
    queryKey: projectKeys.detail(id),
    queryFn: async ({ signal }) => {
      const { data, error, response } = await client.GET('/projects/{id}', { params: { path: { id } }, signal })
      if (error) throw new ApiError(response.status, error)   // queryFn must throw — same rule as before
      return data
    },
  }),
}

// in a component:  const { data } = useQuery(projectQueries.detail(id))
```

A typed `ApiError` (with `status` and the ProblemDetails body) pays off everywhere: the form layer maps a `400`
onto fields (see **Forms**), a real-time board treats `409` as a conflict, and the query client can stop
retrying errors that will never succeed:

```ts
new QueryClient({ defaultOptions: { queries: {
  retry: (failureCount, err) => !(err instanceof ApiError && err.status < 500) && failureCount < 2,  // don't retry 4xx
} } })
```

**3. One place for auth: the 401 → refresh → retry interceptor.** Access tokens are short-lived (minutes),
so any request can come back `401` because the token just expired. Handling that in every `queryFn` is
hopeless; the API layer does it once. The subtle part is **concurrency**: a dashboard fires five queries,
all five get `401` at the same moment, and a naive interceptor sends five refresh requests. With
refresh-token rotation the second refresh uses an already-rotated token, the IdP sees "reuse" and
revokes the whole session. So refresh **single-flight**: the first `401` starts the refresh, everyone else
awaits the same promise.

```ts
// src/api/auth-fetch.ts — openapi-fetch accepts a custom fetch: createClient<paths>({ baseUrl: '/api', fetch: authFetch })
let accessToken: string | null = null          // in memory, not localStorage (why: Frontend Security & Auth)
let refreshing: Promise<boolean> | null = null

function refreshOnce(): Promise<boolean> {
  refreshing ??= fetch('/auth/refresh', { method: 'POST', credentials: 'include' })  // refresh token = HttpOnly cookie
    .then(async (r) => { if (!r.ok) return false; accessToken = (await r.json()).accessToken; return true })
    .catch(() => false)
    .finally(() => { refreshing = null })      // next expiry starts a fresh refresh
  return refreshing
}

export async function authFetch(input: Request): Promise<Response> {
  const send = (req: Request) => {
    const r = req.clone()                         // a Request body can be read only once
    if (accessToken) r.headers.set('Authorization', `Bearer ${accessToken}`)
    return fetch(r)
  }
  const res = await send(input)
  if (res.status !== 401) return res
  if (await refreshOnce()) return send(input)    // retry exactly once with the new token
  onSessionExpired()                              // e.g. redirect to sign-in, keeping the current URL
  return res
}
```

Three rules hide in that code: retry **once** (a second `401` means the user really is signed out, so
don't loop); never call the refresh endpoint *through* the interceptor (a `401` from it would recurse);
and send the user to sign-in only when the refresh itself failed. If your app uses a **BFF**, none of this
lives in the browser: the server refreshes, and the SPA only handles "session expired". That trade-off is
covered in **Frontend Security & Auth**.

:::warn title="Security basics, before the deep dive"
Two habits from day one, long before the expert security lesson: **don't put tokens in `localStorage`**
(any XSS payload can read and exfiltrate it; keep them in memory or let a BFF hold them), and **never render
server data as HTML** (`dangerouslySetInnerHTML` with an API string is an XSS hole; React's normal `{text}`
escaping is your friend). **Frontend Security & Auth** explains the why in depth.
:::

:::quiz id=fe-15-q6 xp=15
A dashboard mounts and fires five queries. The access token expired a second ago, so all five come back
`401` at once. The backend uses refresh-token rotation. What should the API layer do?
- [ ] Let each request refresh the token independently, then retry it
- [x] Start one refresh, make all five wait for that same promise, then retry each request once with the new token
- [ ] Redirect to the sign-in page immediately, since `401` means the user is signed out
- [ ] Retry each request up to three times; the token will be valid eventually
> With rotation, every refresh invalidates the previous refresh token. Five parallel refreshes means four of
> them present an already-used token, which the IdP treats as theft and revokes the whole session, so the user
> is logged out by your own code. A single shared promise ("single-flight") avoids that. An expired access token
> is normal, so bouncing to sign-in on the first `401` is hostile, and blind retries without a new token just
> get `401` again.
:::

:::quiz id=fe-15-q7 xp=10
Your team generates `schema.d.ts` from the ASP.NET OpenAPI document with `openapi-typescript`. What does that
give you, and what does it **not** give you? (select all that apply)
- [x] A compile error in the frontend when the backend renames a field and the types are regenerated
- [x] Checked paths and parameters, e.g. a typo in `'/projects/{id}'` fails to compile
- [ ] Runtime validation that every response really matches the types
- [ ] Automatic caching and invalidation of the responses
> Generated types move the backend contract into the compiler: renames, removed fields and wrong params become
> type errors once you regenerate (do it in CI). But types are erased at runtime: if the server sends something
> else, nothing checks it unless you add a schema or type guard. Caching is TanStack Query's job; the client
> only knows how to send requests.
:::

## Lab: TanStack Query in your app

:::lab id=fe-15-lab1 xp=90
title: Queries, mutations and optimistic toggles against a fake API
1. In your Vite app: `npm install @tanstack/react-query @tanstack/react-query-devtools` and `npm install -D json-server`.
2. Create `db.json` and run a fake REST API with `npx json-server db.json --port 3001`:

```json
{ "tasks": [ { "id": "1", "title": "Write docs", "done": false }, { "id": "2", "title": "Ship it", "done": true } ] }
```

3. Add a Vite proxy so the frontend calls `/api/...` like it will with ASP.NET later:

```ts
// vite.config.ts
server: { proxy: { '/api': { target: 'http://localhost:3001', rewrite: (p) => p.replace(/^\/api/, '') } } }
```

   Restart `npm run dev` after editing the config, then open `http://localhost:5173/api/tasks` — you should
   see the two tasks as JSON. That proves the proxy works.
4. Wrap your app in the `AppProviders` from this lesson (`QueryClientProvider` + devtools) in `src/main.tsx`.
5. Create `src/modules/tasks/api.ts` with a key factory, query options and fetch functions that
   **throw on `!res.ok`**:

```ts
import { queryOptions } from '@tanstack/react-query'

export type Task = { id: string; title: string; done: boolean }

export const taskKeys = {
  all: ['tasks'] as const,
  list: () => [...taskKeys.all, 'list'] as const,
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export const getTasks = (signal?: AbortSignal) => fetch('/api/tasks', { signal }).then((r) => json<Task[]>(r))

export const createTask = (title: string) =>
  fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, done: false }),
  }).then((r) => json<Task>(r))

export const updateTask = (id: string, patch: Partial<Task>) =>
  fetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }).then((r) => json<Task>(r))

export const tasksQuery = () =>
  queryOptions({ queryKey: taskKeys.list(), queryFn: ({ signal }) => getTasks(signal) })
```

6. `TaskList` calls `useQuery(tasksQuery())` and renders: a spinner while `isPending`; `<p role="alert">` when
   `isError` **and there is no data**; otherwise a `<ul>` with one `<li>` per task (a checkbox labelled with the
   title) and a small "Refreshing…" while `isFetching`.
7. A "New task" form uses `useMutation({ mutationFn: createTask, onSuccess: () => queryClient.invalidateQueries({ queryKey: taskKeys.list() }) })`.
8. Each task's checkbox toggles via an **optimistic** mutation (cancel → snapshot → apply → rollback →
   invalidate on settled), as in the lesson. Stop json-server (Ctrl+C) and click a checkbox: the Vite proxy
   answers with an error status, your `json()` helper throws, and the checkbox must flip back with an error message.
9. Add `src/modules/tasks/TaskList.test.tsx` (Vitest + Testing Library, set up as in the routing lab) with a
   fresh client per test:

```tsx
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { TaskList } from './TaskList'

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

afterEach(() => vi.restoreAllMocks())

test('lists tasks', async () => {
  // mockImplementation → a NEW Response per call (a body can only be read once)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify([{ id: '1', title: 'Write docs', done: false }]), { status: 200 }),
  )
  renderWithClient(<TaskList />)
  expect(await screen.findByText('Write docs')).toBeInTheDocument()
})

test('shows an alert when the API fails', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('boom', { status: 500 }))
  renderWithClient(<TaskList />)
  expect(await screen.findByRole('alert')).toBeInTheDocument()
})
```

   Run `npx vitest run`; expect `Tests  2 passed (2)`.

:::tip
`retry: false` in tests — otherwise a failing query retries 3 times with exponential backoff (about 7 s in
total) and your error test times out. A new `QueryClient` per test prevents cached data leaking between tests.
:::

- [ ] Devtools show the `['tasks', 'list']` query going fresh → stale after `staleTime`
- [ ] Alt-tabbing back to the browser triggers a background refetch (visible in the Network tab)
- [ ] Creating a task updates the list without a page reload
- [ ] With the API stopped, a toggled checkbox flips back and an error is shown, while the existing list stays visible
- [ ] Both `TaskList` tests pass with `npx vitest run`
:::

## Recap

- **Server state is a cache** of data owned elsewhere — it can always be stale. Client state is the browser's own.
- `useEffect` + `fetch` lacks caching, dedupe, race safety, refetching and invalidation — TanStack Query provides them.
- **Query keys** contain every variable the fetch depends on; they're hierarchical, so prefixes invalidate whole families.
- **`staleTime`** = how long data is fresh (default 0); **`gcTime`** = how long unused data stays cached (default 5 min).
  Stale data is shown instantly and revalidated in the background.
- `queryFn` must **throw** on HTTP errors and should pass the `signal` to `fetch`; `isPending` (no data) ≠ `isFetching` (request in flight).
- `enabled` delays dependent queries; `placeholderData: keepPreviousData` keeps the old page on screen while the next loads.
- After a mutation: **invalidate** affected keys (stale + refetch active ones), or `setQueryData` with the server's response — never mutate the cached value.
- Optimistic updates: **cancel → snapshot → apply → rollback on error → re-sync on settled**.
- One **API layer**: types generated from the backend's OpenAPI document, a typed `ApiError`, query-option
  factories, and a single-flight **401 → refresh → retry once** interceptor. Tokens in memory, not `localStorage`.

:::cards id=fe-15-cards1 xp=15 title="Server state"
Q: Server state vs client state?
A: Server state is owned by the server and can be stale/shared; client state (UI toggles, drafts) is owned by the browser.
Q: What must go into a query key?
A: Every variable the query function depends on (ids, filters, page) — the key is the cache identity.
Q: `staleTime` vs `gcTime`?
A: staleTime: how long data counts as fresh (no refetch). gcTime: how long unused data stays in memory before being dropped.
Q: `isPending` vs `isFetching`?
A: isPending: no data yet. isFetching: a request is running, possibly in the background while old data is shown.
Q: Why must `queryFn` throw on `!res.ok`?
A: `fetch` only rejects on network failure; without throwing, a 500 page would be cached as "successful" data.
Q: Invalidate vs `setQueryData`?
A: Invalidate = mark stale and refetch (always correct). setQueryData = write a known result into the cache (no request).
Q: Steps of an optimistic update?
A: Cancel in-flight queries, snapshot the old data, apply the change, roll back on error, invalidate on settled.
Q: How do you stop a query from running until its input exists?
A: `enabled: !!input` — the query stays pending (idle) until the condition is true.
Q: What happens to `data` when a background refetch fails?
A: It's kept. The query reports `isError`, but the last good data is still there — don't hide it behind an error page.
:::
