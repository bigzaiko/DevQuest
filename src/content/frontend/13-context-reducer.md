---
id: fe-13
title: Context & useReducer
level: intermediate
minutes: 55
xp: 170
summary: Stop prop drilling with Context, model state transitions with pure reducers, combine both — and know when to reach for Zustand or Redux Toolkit.
---

So far every piece of state lived in a component and travelled down through props. That works
beautifully for small trees. In a real app, though, some data is needed *everywhere*: the signed-in
user, the theme, the current workspace, feature flags, the shopping cart. This lesson gives you two
tools that solve two different problems:

- **Context** solves a *transport* problem: "how does a deeply nested component get this value?"
- **`useReducer`** solves a *logic* problem: "how do I keep complicated state changes understandable?"

They are often combined, but they are independent. Keep that in mind — it prevents a lot of confusion.

## The problem: prop drilling

```tsx
function App() {
  const [user, setUser] = useState<User | null>(null)
  return <Layout user={user} onLogout={() => setUser(null)} />
}
function Layout({ user, onLogout }: LayoutProps) {
  return <Header user={user} onLogout={onLogout} />   // Layout doesn't care about user…
}
function Header({ user, onLogout }: HeaderProps) {
  return <UserMenu user={user} onLogout={onLogout} />  // …neither does Header
}
function UserMenu({ user, onLogout }: UserMenuProps) {
  return user ? <button onClick={onLogout}>Log out {user.name}</button> : null
}
```

`Layout` and `Header` only *forward* props. That is **prop drilling**. It is not evil — it is explicit
and easy to trace — but it gets painful when:

- many intermediate components must change every time the data shape changes,
- the same data is needed in many branches of the tree,
- intermediate components are generic (a `Card`, a `Grid`) that should not know about users at all.

:::tip title="Try composition first"
Before reaching for Context, check whether you can pass **components instead of data**:
`<Layout header={<UserMenu user={user} onLogout={logout} />} />`. Now `Layout` renders a slot and
never sees `user`. The React docs recommend this first; it often removes the drilling entirely.
:::

## Context in three steps

```tsx
import { createContext, useContext, useState } from 'react'

// 1. Create it — the argument is the default used when there is NO provider above.
type Theme = 'light' | 'dark'
const ThemeContext = createContext<Theme>('light')

// 2. Provide it — every component below can read the value.
function App() {
  const [theme, setTheme] = useState<Theme>('dark')
  return (
    <ThemeContext value={theme}>        {/* React 19: the context itself is the provider */}
      <Page />
    </ThemeContext>
  )
}

// 3. Consume it — no props in between.
function Page() {
  const theme = useContext(ThemeContext)
  return <main className={theme}>…</main>
}
```

In React 18 and earlier you wrote `<ThemeContext.Provider value={theme}>`. That still works in React 19,
but the shorter form is now preferred, and `.Provider` is slated for deprecation. React 19 also adds
`use(ThemeContext)`, which behaves like `useContext` but may be called inside `if` blocks and loops.

How it works: when React renders a component that calls `useContext(ThemeContext)`, it walks **up**
the tree to the nearest `<ThemeContext value>` and returns its value. When that value changes
(compared with `Object.is`), **every** consumer below re-renders — even if a `memo` parent in
between would otherwise skip rendering.

Two details that trip people up:

- **The default value is only used when there is no provider above.** It is *not* a fallback for
  `value={undefined}`, and it does not update. If you forget the provider, `useContext` silently returns
  the default — which is why the pattern below uses `null` and throws.
- **Each provider overrides the ones above it.** `<ThemeContext value="dark">` inside
  `<ThemeContext value="light">` gives its subtree `"dark"`. That is handy for "this sidebar is always dark".

### The production pattern: provider component + custom hook

Raw `createContext` + `useContext` leaks implementation details everywhere. Teams wrap it:

```tsx
interface AuthValue { user: User | null; login(u: User): void; logout(): void }

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const value = useMemo(() => ({ user, login: setUser, logout: () => setUser(null) }), [user])
  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
```

Why this shape?

- The default is `null`, so forgetting the provider is a **loud error**, not a silent fake value.
- The context object itself is **not exported** — the only way in is `useAuth()`, so you can change
  the implementation (add a reducer, swap to Zustand) without touching consumers.
- `useMemo` keeps the `value` object identity stable between renders (more on why below).

:::job title="What you'll see at work"
Most codebases have a `providers.tsx` (or `AppProviders`) that stacks providers at the root:
`<QueryClientProvider><AuthProvider><ThemeProvider><Router/></ThemeProvider></AuthProvider></QueryClientProvider>`.
Expect a `useXxx()` hook per context and an error when it's used outside its provider.
:::

:::quiz id=fe-13-q1 xp=10
A `Dashboard` renders `<Grid>` → `<Card>` → `<Avatar user={user} />`. Only `Avatar` needs `user`,
and `Grid`/`Card` are generic UI components used across the app. What is the **first** thing to try?
- [ ] A global Redux store for `user`
- [x] Composition: let `Dashboard` render `<Avatar user={user} />` and pass it into `Card` as `children` or a slot prop
- [ ] Put `user` in `localStorage` and read it in `Avatar`
- [ ] Pass `user` through `Grid` and `Card` as props
> Composition keeps `Grid` and `Card` generic and the data flow explicit. Context is the next step when many
> distant components need the same value. A global store is overkill here, and `localStorage` is not reactive.
> Threading `user` through `Grid` and `Card` works, but forces two generic components to know about users —
> exactly the coupling composition avoids.
:::

## useReducer: state transitions as events

`useState` is perfect for independent values. It becomes awkward when **one user action changes several
pieces of state**, or when the next state depends on the previous one in non-trivial ways:

```tsx
// Scattered updates — easy to forget one
setItems([...items, item])
setTotal(total + item.price)
setLastAdded(item.id)
setError(null)
```

`useReducer` moves all transition logic into one **pure function**:

```ts
type State = { items: Item[]; error: string | null }
type Action =
  | { type: 'added'; item: Item }
  | { type: 'removed'; id: string }
  | { type: 'cleared' }

function cartReducer(state: State, action: Action): State {
  switch (action.type) {
    case 'added':   return { ...state, items: [...state.items, action.item], error: null }
    case 'removed': return { ...state, items: state.items.filter(i => i.id !== action.id) }
    case 'cleared': return { ...state, items: [] }
    default: {
      const _exhaustive: never = action   // compile error if you forget a case
      return state
    }
  }
}

function Cart() {
  const [state, dispatch] = useReducer(cartReducer, { items: [], error: null })
  return <button onClick={() => dispatch({ type: 'cleared' })}>Clear</button>
}
```

The vocabulary:

| Term | Meaning |
|---|---|
| **state** | the current snapshot |
| **action** | a plain object describing *what happened* (`{ type: 'added', item }`) |
| **reducer** | `(state, action) => newState` — decides *how state changes* |
| **dispatch** | sends an action; React calls the reducer and re-renders |

Name actions as **events in the past tense** (`added`, `removed`, `filterChanged`) rather than setters
(`setItems`). The component says *what happened*; the reducer decides *what that means*. That
separation is what makes reducers easy to read and to test.

### Reducers must be pure

A reducer must:

1. **Not mutate** `state` or `action` — always return a new object (or the same object if nothing changed).
2. **Not have side effects** — no `fetch`, no `localStorage`, no `Math.random()`, no `Date.now()`.
3. **Return the same output for the same input.**

Why so strict? In development, Strict Mode calls your reducer **twice** on purpose (to surface impurity —
a reducer that, say, increments a counter outside itself will visibly double-count). React may also replay
queued actions while rendering, and it relies on **reference comparison** (`Object.is`) to decide whether
to re-render. If you do `state.items.push(item); return state`, the reference is unchanged, React concludes
"nothing changed" and skips the update — the classic "I dispatched but nothing happened" bug.

The bonus: a pure function is the easiest thing in the world to unit-test. No rendering, no mocks.

### How `dispatch` actually behaves

Three facts that explain most "my reducer is broken" questions:

1. **`dispatch` does not change the `state` variable you already have.** Like `setState`, it *schedules* a
   re-render. Inside the same event handler, `state` is still the old snapshot:

   ```tsx
   function onAdd() {
     dispatch({ type: 'added', item })
     console.log(state.items.length)   // still the OLD length — the new state arrives on the next render
   }
   ```

   If you need the next value right away, compute it yourself: `const next = cartReducer(state, action)`.
2. **Returning the same object bails out.** If the reducer returns `state` unchanged (`Object.is` equal),
   React skips re-rendering that component's children. That's why no-op actions should `return state`.
3. **Lazy initial state.** `useReducer(reducer, initialArg, init)` calls `init(initialArg)` only on the
   first render — use it when the initial state is expensive (e.g. parsing a saved draft):
   `useReducer(cartReducer, 'cart-draft', (key) => loadDraft(key) ?? { items: [], error: null })`.

:::quiz id=fe-13-q4 xp=10
Spot the bug. The counter starts at `count: 0`. What does the click handler log, and why?

```tsx
const [state, dispatch] = useReducer(counterReducer, { count: 0 })

function onClick() {
  dispatch({ type: 'incremented' })
  dispatch({ type: 'incremented' })
  console.log(state.count)
}
```

- [ ] `2` — each `dispatch` runs the reducer and updates `state` immediately
- [ ] `1` — React batches the two dispatches into one
- [x] `0` — `state` is the snapshot for this render; the screen will show `2` after the re-render
- [ ] It throws, because you can't dispatch twice in one handler
> `dispatch` queues actions and schedules a re-render; it never mutates the `state` constant you are holding.
> Both queued actions *are* applied in order (unlike `setCount(count + 1)` twice, the reducer always receives
> the latest queued state), so the next render shows `2`. The tempting answer "`2`" assumes `state` updates
> synchronously — it doesn't, for `useReducer` or `useState`.
:::

:::pro title="Reducers are where the business rules live"
Senior engineers like pushing logic *into* reducers: "quantity can't drop below 1", "max 5 items per user",
"removing the selected item clears the selection". The component becomes a thin view; the rules get
100 % unit-test coverage in milliseconds. The same idea scales to Redux Toolkit slices and to the
remote-patch reducers you'll write in the real-time lesson.
:::

:::challenge id=fe-13-c1 lang=ts xp=40
title: A pure cart reducer
Implement `cartReducer(state, action)` for these actions:

- `added` — add `item` with `qty: 1`; if an item with the same `id` exists, increase its `qty` by 1 instead.
- `qtyChanged` — set the item's `qty`; a `qty` of `0` or less **removes** the item.
- `removed` — remove the item with `id`.
- `cleared` — empty the cart.

Never mutate the incoming state. Unknown actions return the **same** state object.

hint: `state.items.some(i => i.id === action.item.id)` tells you whether to increment or append.
hint: Use `map` to produce a new array with one changed item: `items.map(i => i.id === id ? { ...i, qty } : i)`.
hint: For `qtyChanged` with `qty <= 0`, reuse your `removed` logic with `filter`.

```ts starter
type CartItem = { id: string; name: string; price: number; qty: number }
type CartState = { items: CartItem[] }
type CartAction =
  | { type: 'added'; item: { id: string; name: string; price: number } }
  | { type: 'qtyChanged'; id: string; qty: number }
  | { type: 'removed'; id: string }
  | { type: 'cleared' }

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'added':
      state.items.push({ ...action.item, qty: 1 })
      return state
    default:
      return state
  }
}
```

```ts solution
type CartItem = { id: string; name: string; price: number; qty: number }
type CartState = { items: CartItem[] }
type CartAction =
  | { type: 'added'; item: { id: string; name: string; price: number } }
  | { type: 'qtyChanged'; id: string; qty: number }
  | { type: 'removed'; id: string }
  | { type: 'cleared' }

export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case 'added': {
      const exists = state.items.some((i) => i.id === action.item.id)
      return {
        ...state,
        items: exists
          ? state.items.map((i) => (i.id === action.item.id ? { ...i, qty: i.qty + 1 } : i))
          : [...state.items, { ...action.item, qty: 1 }],
      }
    }
    case 'qtyChanged':
      if (action.qty <= 0) return { ...state, items: state.items.filter((i) => i.id !== action.id) }
      return { ...state, items: state.items.map((i) => (i.id === action.id ? { ...i, qty: action.qty } : i)) }
    case 'removed':
      return { ...state, items: state.items.filter((i) => i.id !== action.id) }
    case 'cleared':
      return { ...state, items: [] }
    default:
      return state
  }
}
```

```ts tests
const apple = { id: 'a', name: 'Apple', price: 1 }
const pear = { id: 'p', name: 'Pear', price: 2 }
const empty = () => ({ items: [] as { id: string; name: string; price: number; qty: number }[] })

test('added appends with qty 1', () => {
  expect(cartReducer(empty(), { type: 'added', item: apple }).items).toEqual([{ ...apple, qty: 1 }])
})
test('adding the same item twice increments qty', () => {
  let s = cartReducer(empty(), { type: 'added', item: apple })
  s = cartReducer(s, { type: 'added', item: apple })
  expect(s.items).toEqual([{ ...apple, qty: 2 }])
})
test('does not mutate the previous state', () => {
  const s0 = Object.freeze({ items: Object.freeze([Object.freeze({ ...apple, qty: 1 })]) }) as any
  const s1 = cartReducer(s0, { type: 'added', item: pear })
  expect(s1).not.toBe(s0)
  expect(s0.items).toHaveLength(1)
  const s2 = cartReducer(s0, { type: 'added', item: apple })
  expect(s0.items[0].qty).toBe(1)
  expect(s2.items[0].qty).toBe(2)
})
test('qtyChanged sets qty', () => {
  const s = cartReducer({ items: [{ ...apple, qty: 1 }, { ...pear, qty: 1 }] }, { type: 'qtyChanged', id: 'p', qty: 5 })
  expect(s.items).toEqual([{ ...apple, qty: 1 }, { ...pear, qty: 5 }])
})
test('qtyChanged to 0 removes the item', () => {
  const s = cartReducer({ items: [{ ...apple, qty: 3 }] }, { type: 'qtyChanged', id: 'a', qty: 0 })
  expect(s.items).toEqual([])
})
test('removed and cleared', () => {
  const full = { items: [{ ...apple, qty: 1 }, { ...pear, qty: 2 }] }
  expect(cartReducer(full, { type: 'removed', id: 'a' }).items).toEqual([{ ...pear, qty: 2 }])
  expect(cartReducer(full, { type: 'cleared' }).items).toEqual([])
})
test('unknown action returns the same object', () => {
  const s = empty()
  expect(cartReducer(s, { type: 'nope' } as any)).toBe(s)
})
```
:::

### Deriving instead of storing

Notice the cart state has no `total`. Anything you can **compute** from state (totals, counts, "is
empty", filtered lists) should be computed during render, not stored. Stored derived data can drift out
of sync; computed data can't.

```ts
const total = state.items.reduce((sum, i) => sum + i.price * i.qty, 0)
```

## Combining Context + useReducer

A reducer lives in one component. To let the whole tree read the state *and* dispatch actions, put both
in context. The well-known pattern splits them into **two contexts**:

```tsx
const TasksContext = createContext<Task[] | null>(null)
const TasksDispatchContext = createContext<React.Dispatch<TaskAction> | null>(null)

export function TasksProvider({ children }: { children: React.ReactNode }) {
  const [tasks, dispatch] = useReducer(tasksReducer, [])
  return (
    <TasksContext value={tasks}>
      <TasksDispatchContext value={dispatch}>{children}</TasksDispatchContext>
    </TasksContext>
  )
}

// Shortened for the slide — `!` only silences TypeScript. In real code, throw like useAuth() does.
export const useTasks = () => useContext(TasksContext)!
export const useTasksDispatch = () => useContext(TasksDispatchContext)!
```

Why two? `dispatch` is **stable** — React guarantees the same function for the component's lifetime.
Components that only *send* actions (an "Add task" button) consume only the dispatch context and never
re-render when the task list changes. That's a free performance win. (A component that reads *both* still
re-renders on every change, of course — the split only helps writer-only components.)

:::quiz id=fe-13-q5 xp=10
`export const useTasks = () => useContext(TasksContext)!` — and a new teammate renders `<TaskCount />`
(which calls `useTasks().length`) **outside** `<TasksProvider>`. What happens?
- [ ] TypeScript reports a compile error because the provider is missing
- [ ] The `!` throws a "value is null" error inside `useTasks`
- [x] `useTasks()` returns `null` and the app crashes later with "Cannot read properties of null (reading 'length')" inside `TaskCount`
- [ ] React automatically renders the nearest provider's default tasks
> `!` is a **compile-time** non-null assertion; it generates no runtime check at all, and TypeScript cannot
> know at compile time whether a provider sits above a component. So `useContext` returns the default
> (`null`) and the failure shows up somewhere far from the real mistake. A hook that does
> `if (!ctx) throw new Error('useTasks must be used within <TasksProvider>')` turns this into a clear,
> immediate error — that's why the production pattern throws.
:::

:::challenge id=fe-13-c2 lang=tsx xp=60 preview=App
title: Theme provider + custom hook
Build a `ThemeProvider` and a `useTheme()` hook so deeply nested components can read and toggle the theme.

- `ThemeProvider` holds `theme` state (`'light' | 'dark'`, starting at `'light'`) and provides
  `{ theme, toggle }`.
- `useTheme()` returns the context value and **throws** `Error('useTheme must be used within ThemeProvider')`
  when there is no provider.
- `ThemeLabel` shows `Theme: light` / `Theme: dark`. `ThemeToggle` is a button named `Toggle theme`.
- `App` is already written — don't change it.

hint: `const ThemeContext = createContext<ThemeValue | null>(null)` — `null` means "no provider".
hint: In the provider: `const [theme, setTheme] = useState<Theme>('light')` and `toggle = () => setTheme(t => t === 'light' ? 'dark' : 'light')`.
hint: React 19 lets you write `<ThemeContext value={value}>{children}</ThemeContext>`.

```tsx starter
import { createContext, useContext, useState } from 'react'

type Theme = 'light' | 'dark'
type ThemeValue = { theme: Theme; toggle: () => void }

const ThemeContext = createContext<ThemeValue>({ theme: 'light', toggle: () => {} })

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}

export function ThemeLabel() {
  const { theme } = useTheme()
  return <p>Theme: {theme}</p>
}

export function ThemeToggle() {
  const { toggle } = useTheme()
  return <button onClick={toggle}>Toggle theme</button>
}

function Toolbar() {
  return <div className="toolbar"><ThemeToggle /></div>
}

export function App() {
  return (
    <ThemeProvider>
      <ThemeLabel />
      <section><Toolbar /></section>
    </ThemeProvider>
  )
}
```

```tsx solution
import { createContext, useContext, useState } from 'react'

type Theme = 'light' | 'dark'
type ThemeValue = { theme: Theme; toggle: () => void }

const ThemeContext = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light')
  const toggle = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'))
  return <ThemeContext value={{ theme, toggle }}>{children}</ThemeContext>
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}

export function ThemeLabel() {
  const { theme } = useTheme()
  return <p>Theme: {theme}</p>
}

export function ThemeToggle() {
  const { toggle } = useTheme()
  return <button onClick={toggle}>Toggle theme</button>
}

function Toolbar() {
  return <div className="toolbar"><ThemeToggle /></div>
}

export function App() {
  return (
    <ThemeProvider>
      <ThemeLabel />
      <section><Toolbar /></section>
    </ThemeProvider>
  )
}
```

```tsx tests
test('starts light', () => {
  render(<App />)
  expect(screen.getByText('Theme: light')).toBeInTheDocument()
})
test('a deeply nested button toggles the theme for a sibling branch', async () => {
  render(<App />)
  await user.click(screen.getByRole('button', { name: 'Toggle theme' }))
  expect(screen.getByText('Theme: dark')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Toggle theme' }))
  expect(screen.getByText('Theme: light')).toBeInTheDocument()
})
test('useTheme throws without a provider', () => {
  let message = ''
  function Probe() {
    try { useTheme() } catch (e) { message = (e as Error).message }
    return null
  }
  render(<Probe />)
  expect(message).toBe('useTheme must be used within ThemeProvider')
})
```
:::

## Context performance pitfalls

Context is a **broadcast**: when the provided value changes, *every* consumer re-renders. Three classic
mistakes:

**1. A new object every render.**

```tsx
function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // ❌ new object on every render of AuthProvider → all consumers re-render every time
  return <AuthContext value={{ user, setUser }}>{children}</AuthContext>
}
```

If `AuthProvider` re-renders for an unrelated reason (its parent re-rendered), the `{ user, setUser }`
literal is a *new* object, `Object.is` says "changed", and every `useAuth()` consumer re-renders. Fix:
`useMemo(() => ({ user, setUser }), [user])`. (The React Compiler — covered in the performance lesson —
does this memoization for you automatically.)

Why does this matter if the parent re-rendered anyway? Because of `children`. The elements passed as
`children` were created by the *grandparent*; when only `AuthProvider` re-renders, React sees the same
`children` element objects and skips them. A stable context value keeps that optimisation working; a fresh
object every render defeats it for every consumer.

**2. One giant context.** `AppContext = { user, theme, cart, notifications }`. A new notification
re-renders the theme toggle, the avatar and the cart icon. Split contexts by **how often they change**
and **who reads them**.

**3. High-frequency values.** Mouse position, scroll offset, a text input's value, a timer — anything
changing many times a second. Context has **no selectors**: a component can't say "re-render me only when
`cart.count` changes". For that you want an external store.

:::quiz id=fe-13-q2 xp=15
This provider also keeps a clock for the footer, so it re-renders every second:

```tsx
function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState('en')
  const [currency] = useState('EUR')
  const now = useClock()   // updates every second
  return (
    <SettingsContext value={{ locale, currency, setLocale }}>
      {children}
      <Footer now={now} />
    </SettingsContext>
  )
}
```

What happens, and what fixes it? (Select all that apply.)
- [x] Every `useContext(SettingsContext)` consumer inside `children` re-renders every second, because the value object is new each time
- [x] Wrapping the value in `useMemo(() => ({ locale, currency, setLocale }), [locale, currency])` stops those re-renders
- [ ] Nothing happens — React compares context values deeply, and `locale`/`currency` didn't change
- [x] Moving `useClock()` into `Footer` (so the provider itself no longer re-renders) also fixes it
> React compares the context value with `Object.is` (reference equality), never deeply — so the tempting
> "nothing happens" is wrong: a fresh object literal is always "different". `children` is the same element
> object between the provider's renders, so *without* the context change those components would be skipped;
> the new value object is what forces them to re-render. Either stabilise the object with `useMemo` or stop the
> provider from re-rendering. `setLocale` from `useState` is already stable, so it doesn't need to be a dependency.
:::

## When to reach for Zustand or Redux Toolkit

Context + `useReducer` is **dependency injection plus a state machine** — not a full state-management
library. Here's the honest decision table:

| Situation | Use |
|---|---|
| Data from the server (lists, details, users) | **TanStack Query** — covered in **Server State with TanStack Query**, right after Routing. Not Context, not Redux. |
| Rarely-changing app-wide values (theme, auth user, locale, feature flags) | **Context** |
| Complex local transitions in one component or feature | **`useReducer`** (optionally + Context) |
| Frequently changing client state shared across distant components (editor state, a canvas, filters + selection + panels) | **Zustand** — tiny, selector-based, no provider needed |
| Large team, strict conventions, time-travel devtools, many interacting slices | **Redux Toolkit** (`createSlice`, RTK Query) |

Zustand in 10 lines — note the **selector**: the component re-renders only when `count` changes:

```ts
import { create } from 'zustand'

type CounterStore = { count: number; inc: () => void }
// Note the extra () — Zustand's documented TypeScript form, needed once you add middleware
export const useCounter = create<CounterStore>()((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
}))

// in a component
const count = useCounter((s) => s.count)   // re-renders only when count changes
const inc = useCounter((s) => s.inc)       // functions are stable → never re-renders for this
```

:::warn title="Selectors must not build new objects (Zustand v5)"
`useCounter((s) => ({ count: s.count, inc: s.inc }))` returns a **new object on every call**, so the
store thinks the slice always changed — in Zustand v5 that causes an infinite re-render loop
("Maximum update depth exceeded"). Select values one at a time, or wrap the selector with `useShallow`
from `zustand/react/shallow`.
:::

Redux Toolkit's `createSlice` looks like it mutates, but uses **Immer** under the hood to produce
immutable updates from "mutating" code:

```ts
const cartSlice = createSlice({
  name: 'cart',
  initialState: { items: [] as CartItem[] },
  reducers: {
    added(state, action: PayloadAction<CartItem>) { state.items.push(action.payload) }, // Immer makes this safe
  },
})
```

:::job title="Interview favourite"
"Context vs Redux?" The strong answer: *Context is a transport mechanism, not a state manager. I use it for
low-frequency, app-wide values. Server data goes in TanStack Query. If I need shared, high-frequency client
state with selectors, I pick Zustand or Redux Toolkit depending on team size and tooling needs.*
:::

## Putting it together: a store from Context + reducer

:::challenge id=fe-13-c3 lang=tsx xp=70 preview=TodoApp
title: Todo store with split contexts
Wire a `TodosProvider` that owns a reducer and exposes **two** contexts: one with the todos array and one
with `dispatch`. Implement:

- `todosReducer` handling `added` (`{ type: 'added', text }` — append `{ id, text, done: false }`, use
  `id = state.length + 1`), `toggled` (`{ type: 'toggled', id }`) and `removedDone` (drop all done todos).
- `useTodos()` and `useTodosDispatch()` hooks that read the two contexts.
- `AddTodo`: a text input labelled `New todo` and a button `Add`. Clicking `Add` dispatches `added` and
  clears the input; empty (or whitespace-only) text is ignored.
- `TodoList`: a list item (`<li>`) per todo containing a checkbox labelled with the todo text, `checked`
  when the todo is done; changing it dispatches `toggled`.
- `ClearDone`: a button `Clear done` that dispatches `removedDone`.
- The reducer must not mutate: `toggled` returns a new array with a new object for the changed todo.

`TodoApp` is given.

hint: `const [todos, dispatch] = useReducer(todosReducer, [])` inside `TodosProvider`.
hint: Nest the providers: `<TodosContext value={todos}><TodosDispatchContext value={dispatch}>…`.
hint: A checkbox labelled by its text: `<label><input type="checkbox" checked={t.done} onChange={…} /> {t.text}</label>`.

```tsx starter
import { createContext, useContext, useReducer, useState } from 'react'

type Todo = { id: number; text: string; done: boolean }
type TodoAction =
  | { type: 'added'; text: string }
  | { type: 'toggled'; id: number }
  | { type: 'removedDone' }

export function todosReducer(state: Todo[], action: TodoAction): Todo[] {
  return state
}

const TodosContext = createContext<Todo[] | null>(null)
const TodosDispatchContext = createContext<React.Dispatch<TodoAction> | null>(null)

export function TodosProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function useTodos() {
  return [] as Todo[]
}
export function useTodosDispatch() {
  return (_a: TodoAction) => {}
}

export function AddTodo() {
  const [text, setText] = useState('')
  return (
    <div>
      <label htmlFor="new-todo">New todo</label>
      <input id="new-todo" value={text} onChange={(e) => setText(e.target.value)} />
      <button>Add</button>
    </div>
  )
}

export function TodoList() {
  const todos = useTodos()
  return <ul>{todos.map((t) => <li key={t.id}>{t.text}</li>)}</ul>
}

export function ClearDone() {
  return <button>Clear done</button>
}

export function TodoApp() {
  return (
    <TodosProvider>
      <AddTodo />
      <TodoList />
      <ClearDone />
    </TodosProvider>
  )
}
```

```tsx solution
import { createContext, useContext, useReducer, useState } from 'react'

type Todo = { id: number; text: string; done: boolean }
type TodoAction =
  | { type: 'added'; text: string }
  | { type: 'toggled'; id: number }
  | { type: 'removedDone' }

export function todosReducer(state: Todo[], action: TodoAction): Todo[] {
  switch (action.type) {
    case 'added':
      return [...state, { id: state.length + 1, text: action.text, done: false }]
    case 'toggled':
      return state.map((t) => (t.id === action.id ? { ...t, done: !t.done } : t))
    case 'removedDone':
      return state.filter((t) => !t.done)
    default:
      return state
  }
}

const TodosContext = createContext<Todo[] | null>(null)
const TodosDispatchContext = createContext<React.Dispatch<TodoAction> | null>(null)

export function TodosProvider({ children }: { children: React.ReactNode }) {
  const [todos, dispatch] = useReducer(todosReducer, [])
  return (
    <TodosContext value={todos}>
      <TodosDispatchContext value={dispatch}>{children}</TodosDispatchContext>
    </TodosContext>
  )
}

export function useTodos() {
  const ctx = useContext(TodosContext)
  if (!ctx) throw new Error('useTodos must be used within TodosProvider')
  return ctx
}
export function useTodosDispatch() {
  const ctx = useContext(TodosDispatchContext)
  if (!ctx) throw new Error('useTodosDispatch must be used within TodosProvider')
  return ctx
}

export function AddTodo() {
  const [text, setText] = useState('')
  const dispatch = useTodosDispatch()
  const add = () => {
    if (!text.trim()) return
    dispatch({ type: 'added', text: text.trim() })
    setText('')
  }
  return (
    <div>
      <label htmlFor="new-todo">New todo</label>
      <input id="new-todo" value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={add}>Add</button>
    </div>
  )
}

export function TodoList() {
  const todos = useTodos()
  const dispatch = useTodosDispatch()
  return (
    <ul>
      {todos.map((t) => (
        <li key={t.id}>
          <label>
            <input type="checkbox" checked={t.done} onChange={() => dispatch({ type: 'toggled', id: t.id })} /> {t.text}
          </label>
        </li>
      ))}
    </ul>
  )
}

export function ClearDone() {
  const dispatch = useTodosDispatch()
  return <button onClick={() => dispatch({ type: 'removedDone' })}>Clear done</button>
}

export function TodoApp() {
  return (
    <TodosProvider>
      <AddTodo />
      <TodoList />
      <ClearDone />
    </TodosProvider>
  )
}
```

```tsx tests
test('reducer: added / toggled / removedDone', () => {
  let s = todosReducer([], { type: 'added', text: 'a' })
  s = todosReducer(s, { type: 'added', text: 'b' })
  expect(s).toEqual([{ id: 1, text: 'a', done: false }, { id: 2, text: 'b', done: false }])
  const before = s
  s = todosReducer(s, { type: 'toggled', id: 1 })
  expect(s[0].done).toBe(true)
  expect(before[0].done).toBe(false)
  expect(todosReducer(s, { type: 'removedDone' })).toEqual([{ id: 2, text: 'b', done: false }])
})
test('adds todos through the UI and clears the input', async () => {
  render(<TodoApp />)
  const input = screen.getByLabelText('New todo')
  await user.type(input, 'Write tests')
  await user.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.getByRole('checkbox', { name: 'Write tests' })).toBeInTheDocument()
  expect(input).toHaveValue('')
})
test('ignores empty text', async () => {
  render(<TodoApp />)
  await user.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
})
test('toggling and clearing done todos', async () => {
  render(<TodoApp />)
  const input = screen.getByLabelText('New todo')
  await user.type(input, 'One')
  await user.click(screen.getByRole('button', { name: 'Add' }))
  await user.type(input, 'Two')
  await user.click(screen.getByRole('button', { name: 'Add' }))
  await user.click(screen.getByRole('checkbox', { name: 'One' }))
  expect(screen.getByRole('checkbox', { name: 'One' })).toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Clear done' }))
  expect(screen.queryByRole('checkbox', { name: 'One' })).toBeNull()
  expect(screen.getByRole('checkbox', { name: 'Two' })).toBeInTheDocument()
})
```
:::

:::warn title="That `id = state.length + 1` is a trap"
It was fine for the exercise, but after "Clear done" removes items, `length + 1` can repeat an existing id.
Real code uses `crypto.randomUUID()` — generated in the **event handler** (impure!) and passed in the action
payload, so the reducer stays pure: `dispatch({ type: 'added', id: crypto.randomUUID(), text })`.
:::

:::quiz id=fe-13-q3 xp=10
Which of these are allowed inside a reducer? (Select all that apply.)
- [x] `return { ...state, count: state.count + 1 }`
- [ ] `state.count++; return state`
- [ ] `localStorage.setItem('cart', JSON.stringify(state))`
- [x] `return state` for an action that changes nothing
- [ ] `return { ...state, id: crypto.randomUUID() }`
> Reducers must be pure: no mutation, no side effects, deterministic. `state.count++` mutates, so the returned
> reference is unchanged and React may skip the update. Persisting to `localStorage` belongs in an effect (or a
> store middleware). `crypto.randomUUID()` looks harmless but makes the reducer non-deterministic — in Strict Mode
> the double call would even produce two different ids; generate it in the event handler and send it in the
> action payload instead. Returning the same `state` for a no-op is ideal — React can then bail out of re-rendering.
:::

## Common mistakes checklist

| Symptom | Likely cause | Fix |
|---|---|---|
| "I dispatched but the screen didn't change" | Reducer mutated and returned the same object | Return a new object/array |
| `useXxx()` returns the default / `null` | Component rendered outside the provider (often in a test that forgets the provider, or in a separate React root created with a second `createRoot`; portals keep context) | Throwing hook + wrap tests in the provider |
| Whole app re-renders on every keystroke | Input value or other high-frequency state stored in a big context | Keep it local, split the context, or use a selector store |
| Consumers re-render although nothing changed | New `value={{…}}` object every render | `useMemo` (or let the React Compiler do it) |
| A reducer test passes, the app double-counts in dev | Side effect inside the reducer, exposed by Strict Mode's double call | Move the side effect into the handler/effect |

## Recap

- **Prop drilling** is explicit but brittle; try **composition** (children / slot props) before Context.
- **Context** = transport. `createContext(null)` + a provider component + a `useXxx()` hook that throws outside
  its provider. React 19: `<MyContext value={…}>` and `use(MyContext)`.
- **`useReducer`** = state transitions as named events. Reducers are **pure**: no mutation, no side effects,
  deterministic — which makes them trivial to unit-test. `dispatch` schedules a re-render; the `state` you hold is
  a snapshot that doesn't change until then.
- Combine them with **two contexts** (state + dispatch); `dispatch` is stable, so writer-only components don't re-render.
- Context re-renders **all** consumers when the value identity changes: memoise the value, split by change
  frequency, and don't put high-frequency state in Context.
- Server data → TanStack Query; shared high-frequency client state → **Zustand**; big teams wanting strict
  conventions → **Redux Toolkit**.

:::cards id=fe-13-cards1 xp=15 title="Context & reducers"
Q: What problem does Context solve?
A: Transport: getting a value to deeply nested components without passing props through every level.
Q: Why default a context to `null` and throw in the hook?
A: Forgetting the provider becomes a loud, immediate error instead of silently using a fake default.
Q: How does React decide that a context value changed?
A: `Object.is` on the value — reference equality. A new object literal each render always counts as changed.
Q: Three rules of a reducer?
A: Don't mutate state/action, no side effects, same input → same output.
Q: Why split state and dispatch into two contexts?
A: `dispatch` is stable; components that only dispatch never re-render when the state changes.
Q: When Zustand over Context?
A: Frequently changing shared client state — Zustand has selectors, so components re-render only for the slice they read.
Q: React 19 shorthand for a provider?
A: `<ThemeContext value={theme}>…</ThemeContext>` instead of `<ThemeContext.Provider>`.
Q: After `dispatch(action)`, what is `state` in the same handler?
A: Still the old snapshot. The new state arrives on the next render; compute `reducer(state, action)` yourself if you need it now.
Q: When is a context's default value used?
A: Only when there is no matching provider above the component — never as a fallback for `value={undefined}`.
:::
