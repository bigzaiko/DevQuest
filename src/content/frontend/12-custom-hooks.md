---
id: fe-12
title: Custom Hooks
level: intermediate
minutes: 50
xp: 160
summary: The rules of hooks and why they exist, extracting reusable logic into custom hooks (useToggle, useLocalStorage, useDebounce, useFetch), and testing hooks through components.
---

Components let you reuse **UI**. Custom hooks let you reuse **stateful logic** — "a boolean that
toggles", "a value persisted in localStorage", "a debounced search term", "data fetched from a URL" —
without changing the component tree. Every serious React code base has a `hooks/` folder; this
lesson shows you how to write the hooks that go in it, and how to keep them correct.

## The rules of hooks — and the reason behind them

1. **Only call hooks at the top level** of a component or custom hook. Not inside conditions, loops,
   nested functions, or after an early `return`.
2. **Only call hooks from React functions**: components, or custom hooks (functions whose name starts with `use`).

Why? React doesn't know your hooks by name. It stores each component's hook state in a **list**, and
matches them up **by call order** on every render: "the first `useState` call gets slot 0, the second
gets slot 1…". If a hook is skipped on one render because of an `if`, every hook after it reads the
wrong slot:

```tsx
function Profile({ user }: { user: User | null }) {
  if (!user) return <Login />          // ❌ early return before hooks…
  const [tab, setTab] = useState('posts')   // …so this hook is called only sometimes
  useEffect(() => { /* … */ }, [user.id])
  // React: "Rendered more hooks than during the previous render."
}

function ProfileFixed({ user }: { user: User | null }) {
  const [tab, setTab] = useState('posts')     // ✅ hooks first, unconditionally
  useEffect(() => { if (user) { /* … */ } }, [user])
  if (!user) return <Login />                 // ✅ conditions after the hooks
  // …
}
```

The `use` prefix is what lets the linter (`eslint-plugin-react-hooks`) and the React Compiler check
these rules, and it tells your teammates "this function may hold state; follow the rules when
calling it". React itself doesn't look at names at runtime. A hook called conditionally in a function
named `getUser` breaks just the same, but nothing warns you before it does.

:::info title="The one exception: use()"
React 19's `use(promise)` / `use(context)` API *may* be called inside conditions and loops. It still
has to be called from a component or hook, and not inside a `try`/`catch` block. Every other hook
follows the rules above.
:::

:::quiz id=fe-12-q1 xp=15
Which of these break the rules of hooks? (select all that apply)

```tsx
function A({ id }) { if (id) { const [x] = useState(0) } }                  // A
function B({ items }) { items.forEach(() => useEffect(() => {})) }           // B
function C() { const [x, setX] = useState(0); if (x > 3) return null; return <p /> }  // C
function formatUser(u) { const [s] = useState(u); return s }                 // D (a plain helper)
function useUser(id) { const [u, setU] = useState(null); return u }          // E
```

- [x] A
- [x] B
- [ ] C
- [x] D
- [ ] E
> A calls a hook conditionally, B in a loop/callback. C is fine: the hook is called unconditionally,
> the early return comes *after* it. D calls a hook from a normal function (not a component, no `use`
> prefix). E is a valid custom hook.
:::

## Your first custom hook

A custom hook is just a function that starts with `use` and calls other hooks. Extract it when two
components share the same logic, or when a component's logic deserves a name.

```tsx
function useOnlineStatus() {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

function StatusBar() {
  const online = useOnlineStatus()
  return <p>{online ? '✅ Online' : '❌ Offline'}</p>
}
```

Important: custom hooks share **logic**, not **state**. Two components calling `useOnlineStatus()`
each get their own `useState` — it's exactly as if each had written that code inline. (To share
*state*, lift it up or use context.)

:::tip title="Subscribing to a browser or store value: useSyncExternalStore"
`useOnlineStatus` reads an *external* value (`navigator.onLine`) and subscribes to its changes.
React has a built-in hook for exactly that shape, and the React docs use it for this very example:

```tsx
function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => { window.removeEventListener('online', cb); window.removeEventListener('offline', cb) }
}
export function useOnlineStatus() {
  return useSyncExternalStore(subscribe, () => navigator.onLine, () => true) // 3rd arg: server value
}
```

It avoids the brief mismatch between the first render and the effect, and stays consistent during
concurrent rendering. The `useState` + `useEffect` version above is still the clearest way to learn
the pattern.
:::

**What to return.** Return a tuple when there are a few positional values the caller will likely
rename (like `useState`, or `useToggle`'s `[value, toggle, setValue]`): `const [isOpen, toggleOpen] = useToggle()`. Return an object when there are more,
so callers can pick by name: `const { data, error, isLoading } = useFetch(url)`.

:::challenge id=fe-12-c1 lang=tsx xp=30 preview=Demo
title: useToggle
Write `useToggle(initial = false)` returning `[value, toggle, setValue]`:

- `toggle()` flips the value; it must be **stable** (the same function across renders) so it can be
  passed to memoised children and effect dependency lists
- `setValue` is the regular state setter

hint: `const [value, setValue] = useState(initial)`
hint: `const toggle = useCallback(() => setValue((v) => !v), [])` — the updater form means it never needs `value` in its deps.

```tsx starter
import { useState, useCallback } from 'react'

export function useToggle(initial = false) {
  const [value, setValue] = useState(initial)
  const toggle = () => setValue(!value)
  return [value, toggle] as const
}

export function Demo() {
  const [dark, toggleDark] = useToggle()
  return <button onClick={toggleDark}>{dark ? '🌙 Dark' : '☀️ Light'}</button>
}
```

```tsx solution
import { useState, useCallback } from 'react'

export function useToggle(initial = false) {
  const [value, setValue] = useState(initial)
  const toggle = useCallback(() => setValue((v) => !v), [])
  return [value, toggle, setValue] as const
}

export function Demo() {
  const [dark, toggleDark] = useToggle()
  return <button onClick={toggleDark}>{dark ? '🌙 Dark' : '☀️ Light'}</button>
}
```

```tsx tests
const seenToggles: unknown[] = []
function ToggleProbe({ initial }: { initial?: boolean }) {
  const [on, toggle, setOn] = useToggle(initial)
  seenToggles.push(toggle)
  return (
    <div>
      <p>{on ? 'ON' : 'OFF'}</p>
      <button onClick={toggle}>toggle</button>
      <button onClick={() => setOn(false)}>force off</button>
    </div>
  )
}
test('starts with the initial value', () => {
  render(<ToggleProbe initial={true} />)
  expect(screen.getByText('ON')).toBeInTheDocument()
})
test('toggles', async () => {
  render(<ToggleProbe />)
  await user.click(screen.getByRole('button', { name: 'toggle' }))
  expect(screen.getByText('ON')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'toggle' }))
  expect(screen.getByText('OFF')).toBeInTheDocument()
})
test('exposes the setter', async () => {
  render(<ToggleProbe initial={true} />)
  await user.click(screen.getByRole('button', { name: 'force off' }))
  expect(screen.getByText('OFF')).toBeInTheDocument()
})
test('toggle is stable across renders', async () => {
  seenToggles.length = 0
  render(<ToggleProbe />)
  await user.click(screen.getByRole('button', { name: 'toggle' }))
  await user.click(screen.getByRole('button', { name: 'toggle' }))
  expect(seenToggles.length).toBeGreaterThan(2)
  expect(new Set(seenToggles).size).toBe(1)
})
```
:::

:::info title="How you would test this"
A hook can only run inside a component, so tests render a tiny **probe component** that calls the
hook and shows its output — exactly what the tests above do. In your own project the same test runs
with **Vitest** and **React Testing Library**; `renderHook` is a shortcut for the probe:

```tsx
// useToggle.test.tsx
import { renderHook, act } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useToggle } from './useToggle'

test('toggle flips the value', () => {
  const { result } = renderHook(() => useToggle(false))
  act(() => result.current[1]())        // call toggle
  expect(result.current[0]).toBe(true)
})
```

Test the hook through behaviour (what's returned or displayed, what was called), not its internals.
Setup, mocking and the full toolkit come in **Testing React with Vitest & Testing Library**.
:::

## useLocalStorage: state that survives a reload

`localStorage` is a small key/value store in the browser that keeps **strings** per origin, even
across reloads and restarts. The goal is a hook with the same shape as `useState` whose value
survives a reload:

```tsx
const [theme, setTheme] = useLocalStorage('theme', 'light')
```

Design decisions, each with a reason:

- **Read once, lazily.** `useState(() => read())` — the initializer function runs only on the first
  render. `useState(read())` would hit storage on *every* render.
- **JSON** so numbers, booleans and objects round-trip. Wrap `JSON.parse` in `try/catch`: storage is
  user-editable and old app versions may have written something else.
- **Write when setting.** Support the updater form like `useState` does.
- **Inject the storage.** Defaulting to `localStorage` but accepting another `Storage` makes the hook
  testable and lets you use `sessionStorage`. On the server, where `localStorage` doesn't exist (the
  default would throw), the caller can pass a different storage, or the default can be guarded:
  `storage = typeof window !== 'undefined' ? localStorage : undefined`.

:::challenge id=fe-12-c2 lang=tsx xp=60 preview=Demo
title: useLocalStorage
Write `useLocalStorage<T>(key, initialValue, storage = localStorage)` returning `[value, setValue]`:

- initial value: the JSON-parsed `storage.getItem(key)`; if it's missing (`null`) **or invalid JSON**, use `initialValue`
- `setValue(next)` accepts a value **or** an updater function `(prev) => next`, updates state and writes `JSON.stringify(next)` to storage

The tests pass a fresh `createMemoryStorage()` from the setup, so every test starts with empty, isolated storage and never touches the real `localStorage`. That's the payoff of injecting the storage.

hint: `const [value, setValue] = useState<T>(() => { try { const raw = storage.getItem(key); return raw === null ? initialValue : JSON.parse(raw) } catch { return initialValue } })`
hint: In your setter: `const resolved = typeof next === 'function' ? next(value) : next`, then `setValue(resolved)` and `storage.setItem(key, JSON.stringify(resolved))`.

```tsx setup
function createMemoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => { data.set(k, String(v)) },
    removeItem: (k: string) => { data.delete(k) },
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size },
  } as Storage
}
```

```tsx starter
import { useState } from 'react'

export function useLocalStorage<T>(key: string, initialValue: T, storage: Storage = localStorage) {
  const [value, setValue] = useState<T>(initialValue)
  return [value, setValue] as const
}

const demoStorage = createMemoryStorage()
export function Demo() {
  const [count, setCount] = useLocalStorage('clicks', 0, demoStorage)
  return <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
}
```

```tsx solution
import { useState } from 'react'

export function useLocalStorage<T>(key: string, initialValue: T, storage: Storage = localStorage) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = storage.getItem(key)
      return raw === null ? initialValue : (JSON.parse(raw) as T)
    } catch {
      return initialValue
    }
  })

  function set(next: T | ((prev: T) => T)) {
    const resolved = typeof next === 'function' ? (next as (prev: T) => T)(value) : next
    setValue(resolved)
    storage.setItem(key, JSON.stringify(resolved))
  }

  return [value, set] as const
}

const demoStorage = createMemoryStorage()
export function Demo() {
  const [count, setCount] = useLocalStorage('clicks', 0, demoStorage)
  return <button onClick={() => setCount((c) => c + 1)}>Clicked {count} times</button>
}
```

```tsx tests
function Prefs({ storage }: { storage: Storage }) {
  const [prefs, setPrefs] = useLocalStorage('prefs', { theme: 'light', size: 14 }, storage)
  return (
    <div>
      <p>{prefs.theme} {prefs.size}</p>
      <button onClick={() => setPrefs({ ...prefs, theme: 'dark' })}>dark</button>
      <button onClick={() => setPrefs((p) => ({ ...p, size: p.size + 1 }))}>bigger</button>
    </div>
  )
}
test('uses the initial value when storage is empty', () => {
  render(<Prefs storage={createMemoryStorage()} />)
  expect(screen.getByText('light 14')).toBeInTheDocument()
})
test('reads an existing value', () => {
  const storage = createMemoryStorage({ prefs: JSON.stringify({ theme: 'dark', size: 18 }) })
  render(<Prefs storage={storage} />)
  expect(screen.getByText('dark 18')).toBeInTheDocument()
})
test('invalid JSON falls back to the initial value', () => {
  render(<Prefs storage={createMemoryStorage({ prefs: '{oops' })} />)
  expect(screen.getByText('light 14')).toBeInTheDocument()
})
test('writes values and supports updater functions', async () => {
  const storage = createMemoryStorage()
  render(<Prefs storage={storage} />)
  await user.click(screen.getByRole('button', { name: 'dark' }))
  await user.click(screen.getByRole('button', { name: 'bigger' }))
  expect(screen.getByText('dark 15')).toBeInTheDocument()
  expect(JSON.parse(storage.getItem('prefs')!)).toEqual({ theme: 'dark', size: 15 })
})
test('survives a remount ("page reload")', async () => {
  const storage = createMemoryStorage()
  const first = render(<Prefs storage={storage} />)
  await user.click(screen.getByRole('button', { name: 'dark' }))
  first.unmount()
  render(<Prefs storage={storage} />)
  expect(screen.getByText('dark 14')).toBeInTheDocument()
})
```
:::

:::warn title="Known limits of this simple version"
- The updater is resolved against `value` from *this* render. Calling `setCount((c) => c + 1)` twice in
  one click therefore adds 1, not 2, unlike real `useState`. Library versions (e.g. `usehooks-ts`)
  avoid this, typically by keeping the latest value in a ref or persisting from an effect.
- It doesn't re-read storage when `key` changes, and it doesn't hear changes from **other tabs**.
  For those, listen to the window's `storage` event.
- `setItem` can throw (quota exceeded, some private-browsing modes), so production code wraps it in
  `try/catch` too.
:::

## useDebounce: wait until the user stops typing

Firing a search request on every keystroke wastes server time and causes flickering results.
**Debouncing** delays an update until the value has stopped changing for N milliseconds.

The trick is an effect with a cleanup: each new value schedules a timer and **cancels the previous
one**. Only a value that survives `delay` ms without being replaced gets through.

```tsx
function SearchPage() {
  const [query, setQuery] = useState('')
  const debouncedQuery = useDebounce(query, 300)
  const results = useFetch(debouncedQuery ? `/api/search?q=${encodeURIComponent(debouncedQuery)}` : null)
  // the input stays instant; the request waits for a pause in typing
}
```

:::challenge id=fe-12-c3 lang=tsx xp=50 preview=Demo
title: useDebounce
Write `useDebounce<T>(value: T, delay: number): T`. It returns `value` as it was on the first render,
and afterwards follows `value` only once it has stayed unchanged for `delay` ms. Intermediate values
must never come out.

hint: `const [debounced, setDebounced] = useState(value)`
hint: `useEffect(() => { const id = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(id) }, [value, delay])`

```tsx starter
import { useEffect, useState } from 'react'

export function useDebounce<T>(value: T, delay: number): T {
  return value
}

export function Demo() {
  const [text, setText] = useState('')
  const debounced = useDebounce(text, 500)
  return (
    <div>
      <label>Search <input value={text} onChange={(e) => setText(e.target.value)} /></label>
      <p>Searching for: {debounced}</p>
    </div>
  )
}
```

```tsx solution
import { useEffect, useState } from 'react'

export function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

export function Demo() {
  const [text, setText] = useState('')
  const debounced = useDebounce(text, 500)
  return (
    <div>
      <label>Search <input value={text} onChange={(e) => setText(e.target.value)} /></label>
      <p>Searching for: {debounced}</p>
    </div>
  )
}
```

```tsx tests
function SearchProbe({ onDebounced }: { onDebounced: (v: string) => void }) {
  const [text, setText] = React.useState('')
  const debounced = useDebounce(text, 100)
  React.useEffect(() => { onDebounced(debounced) }, [debounced])
  return (
    <div>
      <label>Query <input value={text} onChange={(e) => setText(e.target.value)} /></label>
      <p>Debounced: {debounced}</p>
    </div>
  )
}
test('does not update immediately', async () => {
  render(<SearchProbe onDebounced={fn()} />)
  await user.type(screen.getByLabelText('Query'), 'abc')
  expect(screen.getByText('Debounced:')).toBeInTheDocument()
})
test('updates after the delay', async () => {
  render(<SearchProbe onDebounced={fn()} />)
  await user.type(screen.getByLabelText('Query'), 'abc')
  await waitFor(() => expect(screen.getByText('Debounced: abc')).toBeInTheDocument())
})
test('skips intermediate values', async () => {
  const seen = fn()
  render(<SearchProbe onDebounced={seen} />)
  await user.type(screen.getByLabelText('Query'), 'react')
  await sleep(200)
  expect(seen.mock.calls.map((c) => c[0])).toEqual(['', 'react'])
})
```
:::

:::quiz id=fe-12-q3 xp=15
A teammate's `useDebounce` forgets the cleanup. The user types `r`, `e`, `a` quickly (50 ms apart)
with a 300 ms delay. What does the debounced value do?

```tsx
function useDebounce<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    setTimeout(() => setDebounced(value), delay)
  }, [value, delay])
  return debounced
}
```

- [ ] It works, because each new effect run replaces the old timer
- [x] Every intermediate value still comes through, just 300 ms late: `r`, then `re`, then `rea`
- [ ] Only `rea` comes through, but the timer keeps running after unmount
- [ ] It never updates, because the effect re-runs before any timer fires
> Nothing cancels the earlier timers, so all three fire, one after another, each 300 ms after its
> keystroke. The result is a *delay*, not a debounce, and a search box would still send three
> requests. Effects don't replace each other's timers on their own. React only calls the cleanup you
> return, so `return () => clearTimeout(id)` is what does the debouncing. (A timer firing after unmount
> is a real but separate issue, and the same cleanup fixes it.)
:::

:::quiz id=fe-12-q2 xp=10
`SearchBox` and `FilterPanel` both call `useDebounce(text, 300)` with their own `text`. Do they
share the debounced value?

- [ ] Yes — hooks with the same name share state
- [x] No — each call has its own state and timers; custom hooks share logic, not state
- [ ] Only if they're rendered in the same parent
> Calling a custom hook is like pasting its body into the component. Each component instance gets
> its own `useState` and `useEffect`. Hook names mean nothing to React at runtime, and where the
> components sit in the tree doesn't matter either. Two `useDebounce` calls even in the *same*
> component are independent. To share one debounced value, compute it once in a common parent and pass
> it down (or put it in context).
:::

## useFetch: packaging the effect patterns

The previous lesson's race-free fetching is a perfect candidate for a hook — the component just says
*what* it needs. Be clear about **why** you're writing it, though: this is a lesson in how data hooks
work *inside* (effect, cleanup, abort, loading/error state), not the hook you'll ship. Production apps
use **TanStack Query** for server data — it adds caching, deduplication, retries and refetch-on-focus,
which a hand-rolled `useFetch` doesn't have. Once you've written this one, `useQuery` stops being magic;
**Server State with TanStack Query** picks up exactly where this leaves off.

```tsx
function OrderPage({ id }: { id: number }) {
  const { data, error, isLoading } = useFetch<Order>(`/api/orders/${id}`)
  if (isLoading) return <Spinner />
  if (error) return <ErrorBox message={error.message} />
  return <OrderDetails order={data!} />
}
```

Passing `null` as the URL is a handy convention for "don't fetch yet" (e.g. no search term).

:::challenge id=fe-12-c4 lang=tsx xp=70 preview=Demo
title: useFetch
Write `useFetch<T>(url: string | null, fetcher = fakeFetch)` returning `{ data, error, isLoading }`:

- `url === null` → don't fetch; `{ data: undefined, error: undefined, isLoading: false }`
- otherwise: `isLoading: true` (with `data`/`error` reset to `undefined`) until the fetcher settles, then `data` or `error` (an `Error`)
- call `fetcher(url, signal)` with an `AbortSignal`, and abort it in the cleanup, so a stale response is never shown and `AbortError`s are never reported as errors

The setup's `fakeFetch` serves `/api/users/1` (slow), `/api/users/2` (fast); anything else rejects
with `Error('HTTP 404')`.

hint: One state object: `const [state, setState] = useState<{ data?: T; error?: Error; isLoading: boolean }>({ isLoading: url !== null })`
hint: In the effect: `if (url === null) { setState({ isLoading: false }); return }`, then create an `AbortController`.
hint: In `.catch`: `if (err.name !== 'AbortError') setState({ error: err, isLoading: false })`

```tsx setup
const db: Record<string, { body: unknown; ms: number }> = {
  '/api/users/1': { body: { name: 'Ada' }, ms: 150 },
  '/api/users/2': { body: { name: 'Grace' }, ms: 20 },
}
function fakeFetch(url: string, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const hit = db[url]
    const t = setTimeout(() => (hit ? resolve(hit.body) : reject(new Error('HTTP 404'))), hit?.ms ?? 30)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}
```

```tsx starter
import { useEffect, useState } from 'react'

export function useFetch<T>(url: string | null, fetcher: (url: string, signal?: AbortSignal) => Promise<T> = fakeFetch) {
  const [data, setData] = useState<T | undefined>(undefined)
  useEffect(() => {
    if (url) fetcher(url).then(setData).catch(() => {})
  }, [url])
  return { data, error: undefined as Error | undefined, isLoading: false }
}

export function Demo() {
  const [id, setId] = useState<number | null>(1)
  const { data, error, isLoading } = useFetch<{ name: string }>(id === null ? null : `/api/users/${id}`)
  return (
    <div>
      {[1, 2, 3].map((n) => <button key={n} onClick={() => setId(n)}>User {n}</button>)}
      <button onClick={() => setId(null)}>None</button>
      <p>{isLoading ? 'Loading…' : error ? error.message : data?.name ?? '—'}</p>
    </div>
  )
}
```

```tsx solution
import { useEffect, useState } from 'react'

type FetchState<T> = { data?: T; error?: Error; isLoading: boolean }

export function useFetch<T>(url: string | null, fetcher: (url: string, signal?: AbortSignal) => Promise<T> = fakeFetch) {
  const [state, setState] = useState<FetchState<T>>({ isLoading: url !== null })

  useEffect(() => {
    if (url === null) {
      setState({ isLoading: false })
      return
    }
    const controller = new AbortController()
    setState({ isLoading: true })
    fetcher(url, controller.signal)
      .then((data) => setState({ data, isLoading: false }))
      .catch((err) => {
        if (err?.name !== 'AbortError') setState({ error: err, isLoading: false })
      })
    return () => controller.abort()
  }, [url, fetcher])

  return { data: state.data, error: state.error, isLoading: state.isLoading }
}

export function Demo() {
  const [id, setId] = useState<number | null>(1)
  const { data, error, isLoading } = useFetch<{ name: string }>(id === null ? null : `/api/users/${id}`)
  return (
    <div>
      {[1, 2, 3].map((n) => <button key={n} onClick={() => setId(n)}>User {n}</button>)}
      <button onClick={() => setId(null)}>None</button>
      <p>{isLoading ? 'Loading…' : error ? error.message : data?.name ?? '—'}</p>
    </div>
  )
}
```

```tsx tests
function UserProbe({ url }: { url: string | null }) {
  const { data, error, isLoading } = useFetch<{ name: string }>(url)
  if (isLoading) return <p>loading</p>
  if (error) return <p role="alert">{error.message}</p>
  return <p>name: {data ? data.name : 'none'}</p>
}
test('loading then data', async () => {
  render(<UserProbe url="/api/users/2" />)
  expect(screen.getByText('loading')).toBeInTheDocument()
  expect(await screen.findByText('name: Grace')).toBeInTheDocument()
})
test('errors are reported', async () => {
  render(<UserProbe url="/api/nope" />)
  expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 404')
})
test('null url does not fetch', async () => {
  const fetcher = fn(() => Promise.resolve({ name: 'x' }))
  function NullProbe() {
    const { isLoading, data } = useFetch(null, fetcher)
    return <p>{isLoading ? 'loading' : data ? 'data' : 'idle'}</p>
  }
  render(<NullProbe />)
  await sleep(30)
  expect(screen.getByText('idle')).toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})
test('stale responses never win', async () => {
  const { rerender } = render(<UserProbe url="/api/users/1" />)
  rerender(<UserProbe url="/api/users/2" />)
  await sleep(250)
  expect(screen.getByText('name: Grace')).toBeInTheDocument()
})
test('passes an AbortSignal and aborts on unmount', async () => {
  const fetcher = fn(() => new Promise(() => {}))
  function SignalProbe() {
    useFetch('/api/users/1', fetcher)
    return null
  }
  const { unmount } = render(<SignalProbe />)
  const signal = fetcher.mock.calls[0][1] as AbortSignal
  expect(signal).toBeInstanceOf(AbortSignal)
  unmount()
  expect(signal.aborted).toBe(true)
})
```
:::

:::warn title="Unstable arguments to hooks"
`useFetch(url, (u, s) => fetch(u, { signal: s }).then(r => r.json()))` passes a **new function every
render**; since `fetcher` is a dependency, the effect re-runs on every render — an endless refetch.
Define such functions at module level, or wrap them in `useCallback`. The same goes for object
options (`useThing({ page: 1 })`): accept primitives, or `useMemo` the object. (If your project uses
the React Compiler, it memoises such values automatically, but hooks you publish should still not
*depend* on callers being careful.)
:::

:::quiz id=fe-12-q4 xp=15
With the `useFetch` from the challenge (its effect depends on `[url, fetcher]`), what happens here?

```tsx
function Orders() {
  const { data } = useFetch('/api/orders', (url, signal) =>
    fetch(url, { signal }).then((r) => r.json()),
  )
  return <OrderList orders={data ?? []} />
}
```

- [ ] One request, because `url` never changes
- [x] An endless loop: each render creates a new `fetcher`, the effect re-runs, aborts the old request and starts a new one, and its `setState` triggers another render
- [ ] React notices that the arrow function's code is identical and skips the effect
- [ ] One request in production, two in development
> Dependencies are compared with `Object.is`, and two arrow functions are never the same object, even
> with identical code. So the effect re-runs after every render, and each run sets state
> (`isLoading: true`, then data), which causes the next render. The tempting answer looks only at `url`,
> but `fetcher` is a dependency too. Hoist the fetcher to module level or wrap it in `useCallback`.
:::

:::challenge id=fe-12-c5 lang=tsx mode=tests xp=60
title: Test a useDisclosure hook
`useDisclosure(initial = false)` returns `{ isOpen, open, close, toggle }` — the state behind every
modal, drawer and dropdown. Write tests that pass for this implementation and catch the three hidden
bugs. Tests need a probe component that uses the hook, e.g.:

```tsx
function Probe({ initial }: { initial?: boolean }) {
  const d = useDisclosure(initial)
  return (
    <div>
      <p>State: {d.isOpen ? 'open' : 'closed'}</p>
      <button onClick={d.open}>open</button>
      <button onClick={d.close}>close</button>
      <button onClick={d.toggle}>toggle</button>
    </div>
  )
}
```

hint: What should `open()` do when it's **already** open? And `close()` when already closed?
hint: Does `initial` work?

```tsx impl
import { useState, useCallback } from 'react'

export function useDisclosure(initial = false) {
  const [isOpen, setIsOpen] = useState(initial)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])
  return { isOpen, open, close, toggle }
}
```

```tsx mutant
import { useState, useCallback } from 'react'

export function useDisclosure(initial = false) {
  const [isOpen, setIsOpen] = useState(initial)
  const open = useCallback(() => setIsOpen((v) => !v), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])
  return { isOpen, open, close, toggle }
}
```

```tsx mutant
import { useState, useCallback } from 'react'

export function useDisclosure(initial = false) {
  const [isOpen, setIsOpen] = useState(initial)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen((v) => !v), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])
  return { isOpen, open, close, toggle }
}
```

```tsx mutant
import { useState, useCallback } from 'react'

export function useDisclosure(initial = false) {
  const [isOpen, setIsOpen] = useState(false)
  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])
  return { isOpen, open, close, toggle }
}
```

```tsx starter
function Probe({ initial }: { initial?: boolean }) {
  const d = useDisclosure(initial)
  return (
    <div>
      <p>State: {d.isOpen ? 'open' : 'closed'}</p>
      <button onClick={d.open}>open</button>
      <button onClick={d.close}>close</button>
      <button onClick={d.toggle}>toggle</button>
    </div>
  )
}

test('starts closed', () => {
  render(<Probe />)
  expect(screen.getByText('State: closed')).toBeInTheDocument()
})
```

```tsx solution
function Probe({ initial }: { initial?: boolean }) {
  const d = useDisclosure(initial)
  return (
    <div>
      <p>State: {d.isOpen ? 'open' : 'closed'}</p>
      <button onClick={d.open}>open</button>
      <button onClick={d.close}>close</button>
      <button onClick={d.toggle}>toggle</button>
    </div>
  )
}
const click = (name: string) => user.click(screen.getByRole('button', { name }))

test('respects initial', () => {
  render(<Probe initial={true} />)
  expect(screen.getByText('State: open')).toBeInTheDocument()
})
test('open is idempotent', async () => {
  render(<Probe />)
  await click('open')
  await click('open')
  expect(screen.getByText('State: open')).toBeInTheDocument()
})
test('close is idempotent', async () => {
  render(<Probe />)
  await click('close')
  expect(screen.getByText('State: closed')).toBeInTheDocument()
})
test('toggle flips', async () => {
  render(<Probe />)
  await click('toggle')
  expect(screen.getByText('State: open')).toBeInTheDocument()
  await click('toggle')
  expect(screen.getByText('State: closed')).toBeInTheDocument()
})
```
:::

:::job title="Hooks folder etiquette"
- `src/hooks/useSomething.ts` with a test next to it; one hook per file.
- Prefer battle-tested libraries for the generic ones — `usehooks-ts`, `@uidotdev/usehooks`, TanStack Query for data — and write your own for **domain** logic: `useCart()`, `useCurrentUser()`, `usePermissions()`.
- A hook that only wraps one `useState` with no logic adds indirection, not value. Extract when it removes duplication or gives a meaningful name to a chunk of logic.
:::

:::pro title="Hooks as the seam for testing and swapping"
Components that get their data from a hook (`const { data } = useOrders()`) don't care whether the
hook uses `fetch`, TanStack Query, a WebSocket or a mock. When the team migrates data layers, only
the hook changes. That's the real payoff of custom hooks: they're the boundary between "what the
UI needs" and "how we get it".
:::

:::cards id=fe-12-cards1 xp=15 title="Custom hooks"
Q: What are the two rules of hooks?
A: Call hooks only at the top level (no conditions/loops/after early returns), and only from components or custom hooks.
Q: Why does call order matter?
A: React stores hook state in a list per component and matches calls to slots by order on every render.
Q: What makes a function a custom hook?
A: Its name starts with `use` and it calls other hooks.
Q: Do two components using the same custom hook share state?
A: No. Hooks share logic; each call has its own state.
Q: How do you test a custom hook?
A: Render a small probe component that uses it (or `renderHook`) and assert on behaviour.
Q: Why `useState(() => read())` instead of `useState(read())`?
A: The initializer function runs only on the first render; the plain call runs every render.
Q: How does useDebounce work?
A: An effect sets a timer to copy the value; its cleanup clears the previous timer, so only a value that stays unchanged for `delay` gets through.
Q: Why is passing an inline function to a hook with it in the deps risky?
A: It's a new function every render, so the effect re-runs every render. Hoist it or `useCallback` it.
Q: What happens to a debounce effect without a cleanup?
A: Old timers still fire, so every intermediate value arrives late. That's a delay, not a debounce.
Q: Which built-in hook fits "subscribe to an external value" (online status, a store)?
A: `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot?)`.
:::

## Recap

- Hooks are matched by call order — call them unconditionally at the top level, only from components and `use…` functions.
- Custom hooks extract and name stateful logic; they share logic, not state.
- Return tuples for a few positional values, objects when there are more or they're optional; keep returned functions stable with `useCallback` when callers may depend on them.
- `useLocalStorage`: lazy initial read, safe JSON parsing, injected storage.
- `useDebounce`: timer in an effect, cleared in the cleanup.
- `useFetch`: loading/error/data plus `AbortController` cleanup; beware unstable arguments. It's for learning
  the internals — production server data goes through TanStack Query.
- Test hooks through a probe component.
