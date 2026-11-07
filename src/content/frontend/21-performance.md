---
id: fe-21
title: React Performance
level: advanced
minutes: 75
xp: 190
summary: Understand what a re-render costs, fix the slow ones with memo, the React Compiler, code splitting and virtualization — and measure with the Profiler, Web Vitals and bundle analysis.
---

Performance work has one golden rule: **measure first**. Most React apps are fast by default, and most
"optimisations" written on instinct add complexity without changing anything the user can feel. This lesson
teaches you the mental model (what actually costs time), the tools that fix real problems, and — most
importantly — the instruments that tell you *where* the problem is.

## What a render actually is

"Render" in React means **calling your component function** to get new JSX. It does *not* mean touching the
DOM. The full cycle:

1. **Trigger** — a state update (`setX`), a parent re-rendering, or a context value changing.
2. **Render** — React calls the component and its children, producing a new element tree.
3. **Reconcile** — React diffs the new tree against the previous one.
4. **Commit** — only the *differences* are applied to the DOM. Then the browser lays out and paints.

So a re-render that produces identical output costs JavaScript time (steps 2–3) but **no DOM work**. For a
typical component that's microseconds to a fraction of a millisecond. It becomes a problem when:

- a component is **expensive to render** (sorting 20 000 rows, rendering a chart, parsing markdown), or
- **many** components re-render on a frequent event (every keystroke, every scroll frame, every websocket message), or
- the DOM itself is huge (10 000 table rows — layout and paint dominate, not React).

### Why components re-render

A component re-renders when:

- its **own state** changes,
- its **parent re-renders** (by default, *all* children re-render, whether their props changed or not),
- a **context** it reads changes.

Props changing is *not* the trigger — the parent rendering is. That surprises many people: by default React
doesn't even look at props before re-rendering a child. That's what `memo` changes.

:::quiz id=fe-21-q1 xp=10
`<Page>` holds `const [query, setQuery] = useState('')` and renders `<SearchBox>`, `<Sidebar />` and
`<Footer year={2026} />`. You type one character in the search box. Which components re-render (none are wrapped in `memo`)?
- [ ] Only `SearchBox`, because only its value changed
- [ ] `Page` and `SearchBox` — `Sidebar` and `Footer` have no changed props
- [x] `Page`, `SearchBox`, `Sidebar` and `Footer`
- [ ] Nothing re-renders until the input loses focus
> State lives in `Page`, so `Page` re-renders — and without `memo` every child re-renders with it, regardless of
> props. Usually that's fine. If `Sidebar` were expensive, you'd move the state down (into `SearchBox`) or memoise `Sidebar`.
:::

## Fix #1: move state down, lift content up

Before reaching for any memo API, restructure. Two patterns fix most problems for free:

**Move state down** — keep state in the smallest component that needs it.

```tsx
// ❌ typing re-renders the whole page, including the expensive chart
function Page() {
  const [query, setQuery] = useState('')
  return <><input value={query} onChange={e => setQuery(e.target.value)} /><ExpensiveChart /></>
}

// ✅ only SearchBox re-renders on typing
function SearchBox() {
  const [query, setQuery] = useState('')
  return <input value={query} onChange={e => setQuery(e.target.value)} />
}
function Page() {
  return <><SearchBox /><ExpensiveChart /></>
}
```

**Lift content up (children as props)** — a component that re-renders often can receive heavy parts as
`children`. Elements passed as `children` were created by the *parent*, so they keep their identity and React
skips them.

```tsx
function ScrollTracker({ children }: { children: React.ReactNode }) {
  const [y, setY] = useState(0)          // updates on every scroll
  return (
    <div style={{ height: 400, overflowY: 'auto' }} onScroll={e => setY(e.currentTarget.scrollTop)}>
      {children}
      <Badge y={y} />
    </div>
  )
}
// <ScrollTracker><ExpensiveArticle /></ScrollTracker>  ← ExpensiveArticle doesn't re-render on scroll
```

Why does that work? `<ExpensiveArticle />` is just an object (a React *element*) created when the **parent of
`ScrollTracker`** rendered. When `ScrollTracker`'s own state changes, it re-renders and returns the *same*
`children` object it received. React sees an identical element in the same position and skips it. `<Badge y={y} />`
is created inside `ScrollTracker`, so it's a new element every time and re-renders, which is what we want.

## Fix #2: `memo`, `useMemo`, `useCallback`

- **`memo(Component)`** — skip re-rendering when all props are `Object.is`-equal to last time (a *shallow*
  comparison: `3 === 3` and `'a' === 'a'` are equal, but two separately created `{}` or `() => {}` never are, even
  with identical contents).
- **`useMemo(() => compute(a, b), [a, b])`** — cache a *computed value* between renders.
- **`useCallback(fn, [deps])`** — cache a *function identity* between renders (it's `useMemo(() => fn, deps)`).

They're a team. `memo` alone is often useless because the parent passes **new** objects or functions every render:

```tsx
const Row = memo(function Row({ item, onSelect }: RowProps) { … })

function List({ items }: { items: Item[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  return items.map(item => (
    <Row
      key={item.id}
      item={item}
      onSelect={(id) => setSelected(id)}    // ❌ new function every render → memo never skips
      style={{ padding: 8 }}                // ❌ new object every render
    />
  ))
}
```

The fix is to make the props stable: pass `setSelected` directly (state setters are stable), wrap custom
handlers in `useCallback`, and hoist constant objects out of the component.

```tsx
const rowStyle = { padding: 8 }                                     // ✅ created once, at module level

function List({ items }: { items: Item[] }) {
  const [selected, setSelected] = useState<string | null>(null)
  return items.map(item => (
    <Row key={item.id} item={item} onSelect={setSelected} style={rowStyle} />   // ✅ all props stable
  ))
}
```

Note that `memo` doesn't stop a component re-rendering because of its **own** state or a **context** it reads;
it only adds the props check in front of the "parent rendered" trigger.

:::quiz id=fe-21-q4 xp=10
`Chart` is wrapped in `memo`. It still re-renders on every keystroke in the parent's search box. Why?

```tsx
const Chart = memo(function Chart({ data, options }: ChartProps) { /* expensive */ })

function Dashboard({ data }: { data: Point[] }) {
  const [q, setQ] = useState('')
  return (
    <>
      <input value={q} onChange={(e) => setQ(e.target.value)} />
      <Chart data={data} options={{ stacked: true }} />
    </>
  )
}
```

- [ ] `memo` only works on components without props
- [x] `options={{ stacked: true }}` creates a new object every render, so the shallow comparison sees a changed prop
- [ ] `data` changes on every keystroke
- [ ] `memo` compares props deeply, and deep comparison of `data` is too slow so React gives up
> `memo` compares each prop with `Object.is`. `data` comes from `Dashboard`'s parent and keeps its identity, but the
> inline `{ stacked: true }` is a brand-new object on every render, so one prop always "changes". Hoist it to
> module level (`const chartOptions = { stacked: true }`) or `useMemo` it. `memo` never does deep comparison
> unless you pass your own `arePropsEqual` function as the second argument.
:::

:::challenge id=fe-21-c1 lang=tsx xp=60 preview=ProductList
title: Stop the row re-renders
`ProductList` renders a row per product and a "Clicked N" counter that has nothing to do with the rows. Right
now every click on the counter re-renders **all** rows, and selecting one row re-renders all of them too. The
`setup` gives you `renderLog`: every `ProductRow` render pushes its product id.

Make it so that:

- clicking the counter re-renders **no** rows,
- selecting a row re-renders **only the rows whose `selected` prop changed**.

Keep the markup and behaviour the same.

hint: Wrap the row: `const ProductRow = memo(function ProductRow(props) { … })`.
hint: `onSelect={(id) => setSelected(id)}` creates a new function each render. Pass something stable: `setSelected` itself, or a `useCallback`.
hint: Don't pass the whole `selected` id to every row — pass a boolean `selected={selected === p.id}` so unaffected rows see equal props.

```tsx setup
const renderLog: string[] = []
type Product = { id: string; name: string }
const products: Product[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'c', name: 'Gamma' },
]
```

```tsx starter
import { memo, useCallback, useState } from 'react'

function ProductRow({ product, selected, onSelect }: { product: Product; selected: boolean; onSelect: (id: string) => void }) {
  renderLog.push(product.id)
  return (
    <li>
      {product.name} {selected ? '(selected)' : ''}
      <button onClick={() => onSelect(product.id)}>Select {product.name}</button>
    </li>
  )
}

export function ProductList() {
  const [count, setCount] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <div>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count}</button>
      <ul>
        {products.map((p) => (
          <ProductRow key={p.id} product={p} selected={selected === p.id} onSelect={(id) => setSelected(id)} />
        ))}
      </ul>
    </div>
  )
}
```

```tsx solution
import { memo, useCallback, useState } from 'react'

const ProductRow = memo(function ProductRow({ product, selected, onSelect }: { product: Product; selected: boolean; onSelect: (id: string) => void }) {
  renderLog.push(product.id)
  return (
    <li>
      {product.name} {selected ? '(selected)' : ''}
      <button onClick={() => onSelect(product.id)}>Select {product.name}</button>
    </li>
  )
})

export function ProductList() {
  const [count, setCount] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const handleSelect = useCallback((id: string) => setSelected(id), [])
  return (
    <div>
      <button onClick={() => setCount((c) => c + 1)}>Clicked {count}</button>
      <ul>
        {products.map((p) => (
          <ProductRow key={p.id} product={p} selected={selected === p.id} onSelect={handleSelect} />
        ))}
      </ul>
    </div>
  )
}
```

```tsx tests
test('renders every row once initially', () => {
  renderLog.length = 0
  render(<ProductList />)
  expect([...renderLog].sort()).toEqual(['a', 'b', 'c'])
})
test('the unrelated counter re-renders no rows', async () => {
  render(<ProductList />)
  renderLog.length = 0
  await user.click(screen.getByRole('button', { name: 'Clicked 0' }))
  expect(screen.getByRole('button', { name: 'Clicked 1' })).toBeInTheDocument()
  expect(renderLog).toEqual([])
})
test('selecting re-renders only rows whose selection changed', async () => {
  render(<ProductList />)
  renderLog.length = 0
  await user.click(screen.getByRole('button', { name: 'Select Beta' }))
  expect(renderLog).toEqual(['b'])
  expect(screen.getByText(/Beta \(selected\)/)).toBeInTheDocument()
  renderLog.length = 0
  await user.click(screen.getByRole('button', { name: 'Select Gamma' }))
  expect([...renderLog].sort()).toEqual(['b', 'c'])
})
```
:::

### `useMemo` for expensive computations

```tsx
function Report({ orders, filter }: Props) {
  const rows = useMemo(
    () => orders.filter(o => matches(o, filter)).sort(byDateDesc),   // 20 000 orders: worth caching
    [orders, filter],
  )
  …
}
```

`useMemo` is worth it when the computation is measurably slow (rule of thumb: > 1 ms — check with
`console.time`) **or** when you need a stable reference for a `memo` child or an effect dependency. Wrapping
`a + b` in `useMemo` costs more than it saves.

## The React Compiler: memoisation on autopilot

Hand-written `memo`/`useMemo`/`useCallback` is error-prone: forget one dependency and you get stale values;
add one inline object and the whole chain breaks. The **React Compiler** (1.0 stable since October 2025) is a
build-time transform that analyses your components and inserts fine-grained memoisation automatically — down to
individual JSX elements and values, which is more granular than you'd ever write by hand. It is a Babel plugin
(`babel-plugin-react-compiler`), with a faster Rust port appearing in newer toolchains.

With Vite 8 and `@vitejs/plugin-react` 6 (which no longer bundles Babel), you add Babel just for the compiler:

```bash
npm install -D @rolldown/plugin-babel @babel/core babel-plugin-react-compiler
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import babel from '@rolldown/plugin-babel'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
})
```

(Older projects on `@vitejs/plugin-react` 4/5 used `react({ babel: { plugins: ['babel-plugin-react-compiler'] } })`.
That option is gone in v6, so you'll see both styles in real repositories. Plugin-react 6 also has an experimental
`react({ compiler: true })` that uses the Rust port.)

How do you know it's working? In React DevTools, compiled components show a **"Memo ✨"** badge.

What it means for you:

- In a compiled codebase, new code rarely needs `useMemo`/`useCallback`/`memo`. Write plain components.
- It only works if you follow the **Rules of React**: components and hooks are pure during render, props and
  state are treated as immutable, hooks are called unconditionally. Code that breaks these rules is skipped
  (the `eslint-plugin-react-hooks` compiler rules tell you where).
- Manual memo APIs are still useful as **escape hatches** — e.g. a value that must stay stable as an effect dependency.
- Some libraries return mutable objects that the compiler can't track (TanStack Table's `useReactTable`, TanStack
  Virtual's `useVirtualizer`); the lint rule warns about them, and you opt that component out with a
  `'use no memo'` directive at the top of its body.

:::quiz id=fe-21-q2 xp=10
Your team enables the React Compiler. Which statements are true? (Select all that apply.)
- [x] Most manual `useMemo`/`useCallback` calls become unnecessary for performance
- [x] Components that mutate props or read refs during render may be skipped by the compiler
- [ ] It makes slow computations faster by running them in a Web Worker
- [ ] It removes the need to measure performance
> The compiler automates *memoisation*, nothing else. An algorithm that takes 200 ms still takes 200 ms the first
> time; a 10 000-row DOM is still slow. It relies on the Rules of React, and bails out of code that breaks them.
:::

## Fix #3: code splitting with `lazy` + `Suspense`

Performance isn't only re-renders. The biggest user-visible cost of most SPAs is **JavaScript download and
parse** before anything is interactive. If the admin settings page pulls in a 400 kB charting library, every
visitor of the login page pays for it — unless you split.

```tsx
import { lazy, Suspense } from 'react'

// Vite turns every dynamic import() into a separate chunk (file) loaded on demand
const SettingsPage = lazy(() => import('./modules/settings/SettingsPage'))

function App() {
  return (
    <Suspense fallback={<Spinner label="Loading…" />}>
      <SettingsPage />
    </Suspense>
  )
}
```

- `lazy(loader)` must be called at **module top level** (not inside a component, or it re-creates the component
  every render and loses state). The loader must resolve to a module with a **default** export.
- The first render *suspends* until the chunk arrives; the nearest `<Suspense>` shows its `fallback`.
- Split by **route** first (routers like React Router do it with `lazy` route definitions), then by heavy,
  rarely-used widgets (editors, charts, maps, PDF viewers).
- Prefetch likely next chunks on hover/idle (`import('./SettingsPage')` without awaiting) so the split is invisible.
  The browser caches the module, so the later `lazy` load resolves instantly.
- Put the `<Suspense>` boundary where a loading state makes sense for the user. One boundary at the root means the
  *whole page* is replaced by a spinner whenever any lazy piece loads.

:::quiz id=fe-21-q5 xp=10
Spot the bug. Each time the user types in the search box, the editor flashes "Loading…" and loses its content:

```tsx
function Page() {
  const [q, setQ] = useState('')
  const Editor = lazy(() => import('./Editor'))
  return (
    <>
      <input value={q} onChange={(e) => setQ(e.target.value)} />
      <Suspense fallback={<p>Loading…</p>}><Editor /></Suspense>
    </>
  )
}
```

- [ ] `lazy` requires the loader to be `async`
- [ ] `Suspense` must wrap the `input` too
- [x] `lazy()` is called during render, so every render creates a *new* component type; React unmounts the old `Editor` (losing its state) and suspends again
- [ ] `import('./Editor')` downloads the file again on every keystroke
> Component identity comes from the function/object you render. A fresh `lazy(...)` per render is a different
> component each time, so React throws away the old subtree and the new one suspends until its promise resolves.
> Move `const Editor = lazy(...)` to module top level. The network isn't the problem: the browser caches the
> module after the first `import()`, but the state loss and fallback flash happen anyway.
:::

:::challenge id=fe-21-c2 lang=tsx xp=60 preview=Dashboard
title: Lazy-load the heavy chart
The `Dashboard` imports the chart eagerly. Make it load **only when the user clicks "Show chart"**, using
`lazy` and `Suspense`. While the chunk is loading, show the fallback text `Loading chart…`.

The `setup` simulates a dynamic import: `loadChart()` resolves after 50 ms to `{ default: Chart }` and counts
how often it was called in `chartLoads`. Use `loadChart` exactly like you'd use `() => import('./Chart')`.

hint: At module top level: `const LazyChart = lazy(loadChart)`.
hint: `{show && <Suspense fallback={<p>Loading chart…</p>}><LazyChart /></Suspense>}`

```tsx setup
let chartLoads = 0
function Chart() {
  return <figure aria-label="Revenue chart">▁▂▃▅▇ (imagine 400 kB of charting library)</figure>
}
const loadChart = () => {
  chartLoads++
  return sleep(50).then(() => ({ default: Chart }))
}
```

```tsx starter
import { lazy, Suspense, useState } from 'react'

export function Dashboard() {
  const [show, setShow] = useState(false)
  return (
    <main>
      <h2>Dashboard</h2>
      <button onClick={() => setShow(true)}>Show chart</button>
      {show && <Chart />}
    </main>
  )
}
```

```tsx solution
import { lazy, Suspense, useState } from 'react'

const LazyChart = lazy(loadChart)

export function Dashboard() {
  const [show, setShow] = useState(false)
  return (
    <main>
      <h2>Dashboard</h2>
      <button onClick={() => setShow(true)}>Show chart</button>
      {show && (
        <Suspense fallback={<p>Loading chart…</p>}>
          <LazyChart />
        </Suspense>
      )}
    </main>
  )
}
```

```tsx tests
test('the chart chunk is not loaded up front', () => {
  render(<Dashboard />)
  expect(chartLoads).toBe(0)
  expect(screen.queryByLabelText('Revenue chart')).toBeNull()
})
test('clicking shows a fallback, then the chart', async () => {
  render(<Dashboard />)
  await user.click(screen.getByRole('button', { name: 'Show chart' }))
  expect(screen.getByText('Loading chart…')).toBeInTheDocument()
  expect(await screen.findByLabelText('Revenue chart')).toBeInTheDocument()
  expect(screen.queryByText('Loading chart…')).toBeNull()
  expect(chartLoads).toBe(1)
})
```
:::

## Fix #4: virtualize long lists

Rendering 10 000 rows means 10 000+ DOM nodes: slow first render, slow layout, high memory — and React can't
help, because the cost is in the browser. **Virtualization** (also "windowing") renders only the rows inside the
viewport plus a small **overscan** buffer, and fakes the full scroll height with a spacer:

```text
┌──────── scroll container (height 300px, overflow: auto) ────────┐
│ ┌──── inner spacer: height = itemCount × rowHeight ───────────┐ │
│ │   (empty space above)                                       │ │
│ │   row 97   ← overscan                                       │ │
│ │   row 100  ┐                                                │ │
│ │   …        │ visible                                         │ │
│ │   row 109  ┘                                                │ │
│ │   row 112  ← overscan                                       │ │
│ │   (empty space below)                                       │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

In production use **TanStack Virtual** (`useVirtualizer`) or `react-window` — they handle variable row
heights, horizontal lists and grids. But the core is plain arithmetic, which you'll implement now.

Virtualization has costs, so reach for it only when lists really are long (hundreds to thousands of rows):

- **Browser find (Ctrl+F)** can't find rows that aren't in the DOM.
- **Screen readers** only see the rendered rows; set `aria-rowcount` / `aria-setsize` + `aria-posinset` so they
  can announce "item 101 of 10 000".
- **Variable heights** need measuring, and the scrollbar can jump while estimates are corrected.
- Often **pagination** or "show 50 more" is the simpler fix and better UX.

:::quiz id=fe-21-q6 xp=10
A table with 200 rows feels slightly slow. A teammate proposes virtualizing it. Which are **real** trade-offs you
should raise in review? (Select all that apply.)
- [x] Ctrl+F no longer finds rows that are scrolled out of view
- [x] Screen-reader users only get the rendered rows unless you add `aria-rowcount`/`aria-posinset`-style hints
- [ ] Virtualized lists can't be styled with CSS
- [x] 200 rows is rarely the real bottleneck; profile first, a slow cell component or a re-render storm is more likely
> Virtualization removes DOM nodes, which is exactly what makes find-in-page and AT see less. It's a big win for
> thousands of rows; at 200 the DOM is usually fine, and the Profiler will often point to expensive cells or
> unnecessary re-renders instead. Styling is unaffected: rows are ordinary elements, just positioned absolutely.
:::

:::challenge id=fe-21-c3 lang=ts xp=40
title: The windowing math
Implement `getVisibleRange({ scrollTop, viewportHeight, rowHeight, itemCount, overscan })` returning
`{ start, end }` — the indexes to render, `end` exclusive.

- The first visible row is `floor(scrollTop / rowHeight)`; the last partially visible row ends at
  `scrollTop + viewportHeight`, so `end` (before overscan) is `ceil((scrollTop + viewportHeight) / rowHeight)`.
- Extend both sides by `overscan` rows.
- Clamp to `0 … itemCount`. An empty list gives `{ start: 0, end: 0 }`.

hint: `Math.max(0, first - overscan)` and `Math.min(itemCount, last + overscan)`.

```ts starter
type RangeInput = { scrollTop: number; viewportHeight: number; rowHeight: number; itemCount: number; overscan: number }

export function getVisibleRange(input: RangeInput): { start: number; end: number } {
  return { start: 0, end: input.itemCount }
}
```

```ts solution
type RangeInput = { scrollTop: number; viewportHeight: number; rowHeight: number; itemCount: number; overscan: number }

export function getVisibleRange({ scrollTop, viewportHeight, rowHeight, itemCount, overscan }: RangeInput): { start: number; end: number } {
  if (itemCount <= 0) return { start: 0, end: 0 }
  const first = Math.floor(scrollTop / rowHeight)
  const last = Math.ceil((scrollTop + viewportHeight) / rowHeight)
  return {
    start: Math.max(0, Math.min(itemCount, first - overscan)),
    end: Math.min(itemCount, last + overscan),
  }
}
```

```ts tests
const base = { viewportHeight: 300, rowHeight: 30, itemCount: 10000, overscan: 0 }
test('top of the list', () => {
  expect(getVisibleRange({ ...base, scrollTop: 0 })).toEqual({ start: 0, end: 10 })
})
test('scrolled exactly to row 100', () => {
  expect(getVisibleRange({ ...base, scrollTop: 3000 })).toEqual({ start: 100, end: 110 })
})
test('partially visible rows count', () => {
  expect(getVisibleRange({ ...base, scrollTop: 3015 })).toEqual({ start: 100, end: 111 })
})
test('overscan on both sides, clamped at 0', () => {
  expect(getVisibleRange({ ...base, scrollTop: 3000, overscan: 3 })).toEqual({ start: 97, end: 113 })
  expect(getVisibleRange({ ...base, scrollTop: 0, overscan: 3 })).toEqual({ start: 0, end: 13 })
})
test('clamped at the end', () => {
  expect(getVisibleRange({ ...base, itemCount: 50, scrollTop: 1200, overscan: 3 })).toEqual({ start: 37, end: 50 })
})
test('short and empty lists', () => {
  expect(getVisibleRange({ ...base, itemCount: 4, scrollTop: 0 })).toEqual({ start: 0, end: 4 })
  expect(getVisibleRange({ ...base, itemCount: 0, scrollTop: 0 })).toEqual({ start: 0, end: 0 })
})
```
:::

:::challenge id=fe-21-c4 lang=tsx xp=70 preview=Demo
title: A virtualized list component
Build `VirtualList({ items, rowHeight, height })` using `getVisibleRange` (provided in `setup`, with overscan 3):

- An outer `div` with `data-testid="viewport"`, `style={{ height, overflowY: 'auto', position: 'relative' }}` and
  an `onScroll` handler that stores `e.currentTarget.scrollTop` in state.
- Inside, a `ul` with `style={{ height: items.length * rowHeight, position: 'relative', margin: 0 }}`.
- Render an `li` **only** for indexes `start … end-1`, each absolutely positioned at `top: index * rowHeight`.

hint: `const [scrollTop, setScrollTop] = useState(0)` and `const { start, end } = getVisibleRange({ scrollTop, viewportHeight: height, rowHeight, itemCount: items.length, overscan: 3 })`.
hint: `items.slice(start, end).map((item, i) => { const index = start + i; return <li key={index} style={{ position: 'absolute', top: index * rowHeight, height: rowHeight }}>{item}</li> })`

```tsx setup
function getVisibleRange({ scrollTop, viewportHeight, rowHeight, itemCount, overscan }: { scrollTop: number; viewportHeight: number; rowHeight: number; itemCount: number; overscan: number }) {
  if (itemCount <= 0) return { start: 0, end: 0 }
  const first = Math.floor(scrollTop / rowHeight)
  const last = Math.ceil((scrollTop + viewportHeight) / rowHeight)
  return { start: Math.max(0, Math.min(itemCount, first - overscan)), end: Math.min(itemCount, last + overscan) }
}
```

```tsx starter
import { useState } from 'react'

export function VirtualList({ items, rowHeight, height }: { items: string[]; rowHeight: number; height: number }) {
  return (
    <div data-testid="viewport" style={{ height, overflowY: 'auto' }}>
      <ul style={{ margin: 0 }}>
        {items.map((item, i) => <li key={i} style={{ height: rowHeight }}>{item}</li>)}
      </ul>
    </div>
  )
}

const many = Array.from({ length: 10000 }, (_, i) => `Item ${i}`)
export function Demo() {
  return <VirtualList items={many} rowHeight={30} height={240} />
}
```

```tsx solution
import { useState } from 'react'

export function VirtualList({ items, rowHeight, height }: { items: string[]; rowHeight: number; height: number }) {
  const [scrollTop, setScrollTop] = useState(0)
  const { start, end } = getVisibleRange({ scrollTop, viewportHeight: height, rowHeight, itemCount: items.length, overscan: 3 })
  return (
    <div data-testid="viewport" style={{ height, overflowY: 'auto', position: 'relative' }} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <ul style={{ height: items.length * rowHeight, position: 'relative', margin: 0 }}>
        {items.slice(start, end).map((item, i) => {
          const index = start + i
          return <li key={index} style={{ position: 'absolute', top: index * rowHeight, height: rowHeight }}>{item}</li>
        })}
      </ul>
    </div>
  )
}

const many = Array.from({ length: 10000 }, (_, i) => `Item ${i}`)
export function Demo() {
  return <VirtualList items={many} rowHeight={30} height={240} />
}
```

```tsx tests
const items = Array.from({ length: 10000 }, (_, i) => `Item ${i}`)

test('renders only the visible window plus overscan', () => {
  render(<VirtualList items={items} rowHeight={30} height={150} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(8)
  expect(screen.getByText('Item 0')).toBeInTheDocument()
  expect(screen.queryByText('Item 50')).toBeNull()
})
test('the spacer keeps the full scroll height and rows are positioned', () => {
  render(<VirtualList items={items} rowHeight={30} height={150} />)
  expect(screen.getByRole('list').style.height).toBe('300000px')
  expect(screen.getByText('Item 2').style.top).toBe('60px')
})
test('scrolling moves the window', async () => {
  render(<VirtualList items={items} rowHeight={30} height={150} />)
  const viewport = screen.getByTestId('viewport')
  await act(async () => {
    viewport.scrollTop = 3000
    const win = viewport.ownerDocument.defaultView as any
    viewport.dispatchEvent(new win.Event('scroll'))
  })
  expect(screen.queryByText('Item 0')).toBeNull()
  expect(screen.getByText('Item 100')).toBeInTheDocument()
  expect(screen.getByText('Item 100').style.top).toBe('3000px')
  expect(screen.getAllByRole('listitem')).toHaveLength(11)
})
```
:::

## Measure: React DevTools Profiler

The **Profiler** tab of React DevTools records commits while you interact:

1. Open DevTools → **Profiler** → ⏺ record → do the slow thing → stop.
2. The **flame graph** shows each commit; bar width = render time. Grey bars didn't render.
3. Click a component → **"Why did this render?"** (enable it in the ⚙ settings) tells you: props changed
   (which ones), state changed, hooks changed, parent rendered.
4. The **ranked** view sorts components by self time — start at the top.

Also turn on **"Highlight updates when components render"** (⚙ → General): every render flashes on screen. A
keystroke that lights up the whole page is your lead.

Programmatically, `<Profiler id="Board" onRender={(id, phase, actualDuration) => …}>` reports render timings —
useful for automated performance budgets in tests. It's a no-op in normal production builds; it only reports in
development and in React's special *profiling* build (`react-dom/profiling`).

:::tip title="Profile production builds"
Development React is much slower (extra checks, Strict Mode double renders). Absolute numbers only mean
something in a production build: `vite build && vite preview`, with the profiling build of React if you need
component timings there. Use **CPU throttling (4×–6×)** in Chrome DevTools to approximate a mid-range phone.
:::

## Measure: Core Web Vitals

Google's **Core Web Vitals** are the user-centred metrics that matter (and affect search ranking for public pages):

| Metric | Measures | "Good" | Typical React culprits |
|---|---|---|---|
| **LCP** — Largest Contentful Paint | when the main content (hero image, headline) appears | ≤ 2.5 s | huge JS bundle before render, unoptimised images, data waterfalls |
| **INP** — Interaction to Next Paint | the (near-)slowest delay, over the whole visit, from a click/tap/keypress to the next frame being painted | ≤ 200 ms | expensive re-renders on input, long tasks on the main thread |
| **CLS** — Cumulative Layout Shift | how much content jumps around while loading | ≤ 0.1 | images without width/height, spinners replaced by taller content, late-loading banners |

"Good" means at least 75 % of real page visits are within the threshold (Google measures the 75th percentile).

INP replaced FID in March 2024 and is the one React developers influence most directly: it's literally "how long
did my event handler + re-render + paint take". The browser can't paint while JavaScript runs, so any task longer
than ~50 ms (a **long task**) delays the next frame. Tools for fixing INP: move state down, memoise, virtualize, and
mark non-urgent updates with **`useTransition`** / **`useDeferredValue`**.

How do those two help? React renders in two priorities. Typing into the input is **urgent**: the new letter must
show immediately. Re-rendering 5 000 search results is **non-urgent**. With `useDeferredValue`, React first
re-renders with the *old* deferred value (cheap, because the expensive child is memoised and its prop didn't
change), paints the letter, and then renders the expensive part in the background, where it can be **interrupted**
if the user types again:

```tsx
function Search() {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)       // lags behind during heavy renders
  return (
    <>
      <input value={query} onChange={(e) => setQuery(e.target.value)} />
      <Results query={deferredQuery} />                {/* Results is wrapped in memo */}
    </>
  )
}
const Results = memo(function Results({ query }: { query: string }) {
  return <ul>{search(bigList, query).map((r) => <li key={r.id}>{r.name}</li>)}</ul>
})
```

The common mistake is forgetting the `memo` (or the compiler): then the urgent render re-renders `Results` anyway
and nothing is gained. `useTransition` does the same for a state update you control:
`startTransition(() => setFilter(next))` marks that update as interruptible.

Measure real users with the `web-vitals` library and send the numbers to your analytics:

```ts
import { onLCP, onINP, onCLS } from 'web-vitals'
const send = (m: { name: string; value: number }) => navigator.sendBeacon('/analytics', JSON.stringify(m))
onLCP(send); onINP(send); onCLS(send)
```

:::quiz id=fe-21-q3 xp=15
Match symptoms to metrics. Which pairings are correct? (Select all that apply.)
- [x] Typing in a filter box freezes the UI for 400 ms → poor **INP**
- [x] The "Buy" button moves down when a cookie banner loads above it → poor **CLS**
- [ ] A 3 MB JavaScript bundle delays the dashboard's first paint → poor **CLS**
- [x] The product image appears 4 s after navigation → poor **LCP**
> INP = responsiveness to input, CLS = visual stability, LCP = loading of the main content. A large bundle hurts
> LCP (and often INP), not CLS. Reserve space for late content (fixed sizes, skeletons) to avoid CLS.
:::

## Measure: bundle analysis

You can't shrink what you can't see. After `vite build`, Vite prints chunk sizes; for a treemap, add
`rollup-plugin-visualizer` (it works with Vite's Rolldown-based bundler):

```ts
// vite.config.ts
import { visualizer } from 'rollup-plugin-visualizer'
export default defineConfig({
  plugins: [react(), visualizer({ filename: 'stats.html', gzipSize: true, open: true })],
})
```

Usual findings and fixes:

- **A whole library for one function** (`lodash`, `moment`, icon packs) → import per function (`lodash-es/debounce`),
  switch to `date-fns` or the built-in `Intl`/`Temporal` APIs where your browsers support them, import icons individually.
- **A heavy widget in the main chunk** → `lazy()` it.
- **Duplicate versions** of the same package → `npm ls <pkg>` to see who pulls which version, then `npm dedupe`
  or align the version ranges.
- **Polyfills and down-levelled syntax you don't need** → Vite's default `build.target` is already
  `'baseline-widely-available'`; check for `@vitejs/plugin-legacy` or `core-js` imports added "just in case" and
  remove them if your supported browsers don't need them.

:::pro title="Performance budgets in CI"
Mature teams don't rely on someone remembering to check. They fail the build when the main chunk grows past a budget
(`size-limit`, `bundlesize`, or a custom script over Vite's manifest), run **Lighthouse CI** on preview deployments,
and watch real-user Web Vitals dashboards after each release. Regressions get caught in the PR that caused them.
:::

:::lab id=fe-21-lab1 xp=90
title: Find and fix a real performance problem
Use any React app you have (or the one you built in earlier lessons).

**1. Make it slow on purpose (if it's fast).** Render a list of 5 000 items with a filter input above it, all in one component:

```tsx
const items = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `Item ${i}` }))
function SlowList() {
  const [q, setQ] = useState('')
  const visible = items.filter(i => i.name.includes(q))
  return <><input value={q} onChange={e => setQ(e.target.value)} />
    <ul>{visible.map(i => <li key={i.id}>{i.name}</li>)}</ul></>
}
```

**2. Profile.** Install React DevTools, enable *Highlight updates* and *Record why each component rendered*.
In Chrome DevTools → **Performance** → ⚙, set **CPU: 6× slowdown**. In the **Profiler** tab, record typing three
characters. You should see one commit per keystroke, with `SlowList` as the widest bar; write down the commit
durations (in dev mode with throttling, typically tens of milliseconds each).

**3. Fix it** with at least two techniques from this lesson: `useDeferredValue` for the filter, a virtualized list,
memoised rows. For the virtualized list, `npm i @tanstack/react-virtual` and use this minimal shape:

```tsx
import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

function VirtualItems({ items }: { items: { id: number; name: string }[] }) {
  'use no memo' // only needed if you enabled the React Compiler
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 5,
  })
  return (
    <div ref={parentRef} style={{ height: 400, overflowY: 'auto' }}>
      <ul style={{ height: virtualizer.getTotalSize(), position: 'relative', margin: 0, padding: 0 }}>
        {virtualizer.getVirtualItems().map((row) => (
          <li key={row.key} style={{ position: 'absolute', top: row.start, height: row.size, width: '100%' }}>
            {items[row.index].name}
          </li>
        ))}
      </ul>
    </div>
  )
}
```

Profile again under the same throttling and compare the numbers.

**4. Analyse the bundle.** `npm i -D rollup-plugin-visualizer`, add it to `vite.config.ts`, run `npm run build`,
open `stats.html`. Find the largest dependency and decide whether it should be lazy-loaded.

**5. Measure Web Vitals.** `npm i web-vitals` and add to `src/main.tsx`:

```ts
import { onLCP, onINP, onCLS } from 'web-vitals'
onLCP(console.log, { reportAllChanges: true })
onINP(console.log, { reportAllChanges: true })
onCLS(console.log, { reportAllChanges: true })
```

Run `npm run build && npm run preview`, open the preview URL and interact. Each metric logs an object like
`{ name: 'INP', value: 48, rating: 'good', … }`. Without `reportAllChanges`, INP and CLS are only reported when
the page is hidden (tab switch or close), which is what you want in production but confusing while testing.
Alternatively run Lighthouse in Chrome DevTools against the preview build (it measures LCP and CLS, and uses
Total Blocking Time as a lab stand-in for INP).

- [ ] I recorded a Profiler session and identified the slowest commit and its cause
- [ ] After my fixes, the commit duration for typing dropped noticeably (I wrote down before/after numbers)
- [ ] I generated a bundle treemap and know my three largest dependencies
- [ ] I logged LCP, INP and CLS (with their `rating`) for my app's preview build
:::

:::job title="How performance work happens on a team"
Tickets say "the board is laggy when it has 500 cards", not "add useMemo". You'll be expected to reproduce it
(with throttling and realistic data), profile, explain the cause in the PR description with before/after
numbers or screenshots, and choose the *simplest* fix. "I wrapped everything in memo" without measurements
usually gets pushback in review.
:::

## Recap

- A render = calling your component; React commits only DOM **differences**. Re-renders are cheap until they're
  expensive, frequent, or the DOM is huge.
- Children re-render when the **parent** renders — props don't need to change. `memo` adds a props check.
- First restructure: **move state down**, pass heavy content as **children**.
- `memo` + stable props (`useCallback`, hoisted constants), `useMemo` for measurably slow computations. With the
  **React Compiler**, most of this is automatic — if you follow the Rules of React.
- `useDeferredValue` / `useTransition` keep input responsive by rendering expensive, memoised parts at low priority.
- **Code split** with `lazy()` at module top level + `<Suspense fallback>`; split by route first.
- **Virtualize** long lists: render only the visible window + overscan inside a full-height spacer.
- **Measure**: React DevTools Profiler, Core Web Vitals (**LCP**, **INP**, **CLS**) via `web-vitals`, and a bundle treemap.

:::cards id=fe-21-cards1 xp=15 title="React performance"
Q: Three things that make a component re-render?
A: Its own state changes, its parent re-renders, or a context it reads changes.
Q: Why is `memo` often useless on its own?
A: The parent passes new objects/functions every render, so the shallow props comparison always fails. Stabilise props with useCallback/useMemo or hoisting.
Q: What does the React Compiler do?
A: Automatically inserts fine-grained memoisation at build time — as long as the code follows the Rules of React.
Q: Rules for `lazy()`?
A: Call it at module top level; the loader returns a promise of a module with a default export; render it inside `<Suspense>`.
Q: What is list virtualization?
A: Rendering only the rows in (and slightly around) the viewport, with a spacer that keeps the full scroll height.
Q: LCP, INP, CLS — good thresholds?
A: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1.
Q: Which hook keeps typing responsive while an expensive result renders?
A: `useDeferredValue` (or `useTransition` for state updates you mark as non-urgent).
Q: Why does an inline `style={{…}}` or `onClick={() => …}` defeat `memo`?
A: Each render creates a new object/function; `memo`'s `Object.is` comparison sees a changed prop. Hoist it, or use useMemo/useCallback.
Q: Two costs of virtualizing a list?
A: Off-screen rows aren't in the DOM, so Ctrl+F and screen readers don't see them (add aria-rowcount/posinset); variable heights need measuring.
Q: First step of any performance fix?
A: Measure — reproduce with realistic data and CPU throttling, then profile.
:::
