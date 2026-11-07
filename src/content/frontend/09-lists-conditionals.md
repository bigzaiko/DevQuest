---
id: fe-09
title: Lists, Keys & Conditional Rendering
level: beginner
minutes: 55
xp: 130
summary: Rendering arrays with map, what keys really do (and how index keys corrupt state), conditional rendering patterns, the `&&` zero trap, and good empty states.
---

Almost every screen is a list of something — orders, messages, search results — plus a handful of
"show this only if…" conditions. Both are plain JavaScript in JSX, but each comes with one React
rule you must understand: **keys** for lists, and **what renders as nothing** for conditions.

## Rendering lists with `map`

JSX can render arrays: `{[<li>a</li>, <li>b</li>]}` shows both items. So to show a list of data,
you **transform** each data item into an element with `map` — there's no special loop syntax like
`v-for` or `*ngFor`:

```tsx
const products = [
  { id: 'p1', name: 'Keyboard', price: 89 },
  { id: 'p2', name: 'Mouse', price: 35 },
]

function ProductList() {
  return (
    <ul>
      {products.map((p) => (
        <li key={p.id}>
          {p.name} — {p.price} €
        </li>
      ))}
    </ul>
  )
}
```

Filtering and sorting are just more array methods before the `map`:

```tsx
const visible = products
  .filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
  .toSorted((a, b) => a.price - b.price)

return <ul>{visible.map((p) => <ProductRow key={p.id} product={p} />)}</ul>
```

`filter`, `map` and `toSorted` all return **new arrays**, so `products` itself is untouched. Never
call the in-place `sort()` on props or state during render — you'd be mutating data you don't own.

Note that the `key` goes on the **outermost element returned from `map`** — here `<ProductRow>`,
not the `<li>` inside it. React looks at the keys of the *siblings in the array*; a key buried
inside `ProductRow` is invisible to it.

If each item renders **several** sibling elements without a wrapper, use a keyed `Fragment` — the
`<>…</>` shorthand can't take a key:

```tsx
import { Fragment } from 'react'

<dl>
  {terms.map((t) => (
    <Fragment key={t.id}>
      <dt>{t.word}</dt>
      <dd>{t.definition}</dd>
    </Fragment>
  ))}
</dl>
```

## What keys are for

When the list changes, React has to match the new items to the old ones: which ones are new,
which were removed, which moved? Without help it can only match by **position**. A `key` gives each
item a stable identity, so React can tell "this is still order #42, it just moved to the top".

Why does that matter? Because each rendered component instance has things attached to it:

- its **state** (`useState` values),
- its **DOM nodes** — including things React doesn't control, like an input's focus, cursor
  position, an uncontrolled checkbox, a playing `<video>`, a CSS animation.

React keeps those attached to the *key*. On every re-render it compares the keys of the old and
new list:

- **Same key as before** → same instance: state and DOM are kept, the props are updated.
- **New key** → a brand-new instance is created (mounted) with fresh state.
- **Key that has disappeared** → that instance is destroyed (unmounted) and its state is gone.

Rules for keys:

- **Unique among siblings** (not globally).
- **Stable**: the same item gets the same key on every render. Use the database id.
- **Not generated during render**: `key={Math.random()}` or `key={crypto.randomUUID()}` gives a new
  identity every render — every item is destroyed and recreated each time (slow, and state and focus are lost).

### Why index keys break

`key={index}` is what React uses by default (with a warning). It's fine for a static list that
never reorders. But insert at the top, delete from the middle, or sort, and the indexes now point at
*different items* — so React hands item B the state and DOM that belonged to item A.

```text
Before:  key=0 → "Milk" ☑ (checked)     key=1 → "Eggs" ☐
Insert "Bread" at the top:
After:   key=0 → "Bread" ☑ (!!)          key=1 → "Milk" ☐ (!!)     key=2 → "Eggs" ☐
```

React compared keys, not content: key `0` existed before and after, so it **reused** that row and
just updated its text from "Milk" to "Bread". The checkbox (DOM state) stayed with key `0`, so now
*Bread* looks checked, and key `2` is treated as the new row.

Note *what* gets corrupted: state that lives **in the component or DOM** (an uncontrolled input,
`useState` inside a row, focus). If the checked flag lived in your data (`item.done`) and was
passed as a prop, each row would receive the right value even with index keys — but it would
still be a bug waiting for the first row with local state. Use real ids and you never have to think
about it. Try it:

:::challenge id=fe-09-c1 lang=tsx xp=40 preview=Groceries
title: Fix the index-key bug
Each row has an **uncontrolled** checkbox (the DOM keeps its checked state). Check "Milk", then press
**Add Bread to top**: with index keys, the tick jumps to Bread. Fix the keys so the tick stays with
Milk.

hint: Each item has an `id`. Use it.

```tsx starter
import { useState } from 'react'

type Item = { id: number; name: string }

export function Groceries() {
  const [items, setItems] = useState<Item[]>([
    { id: 1, name: 'Milk' },
    { id: 2, name: 'Eggs' },
  ])
  return (
    <div>
      <button onClick={() => setItems([{ id: 3, name: 'Bread' }, ...items])}>Add Bread to top</button>
      <ul>
        {items.map((item, index) => (
          <li key={index}>
            <label><input type="checkbox" /> {item.name}</label>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

type Item = { id: number; name: string }

export function Groceries() {
  const [items, setItems] = useState<Item[]>([
    { id: 1, name: 'Milk' },
    { id: 2, name: 'Eggs' },
  ])
  return (
    <div>
      <button onClick={() => setItems([{ id: 3, name: 'Bread' }, ...items])}>Add Bread to top</button>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <label><input type="checkbox" /> {item.name}</label>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

```tsx tests
test('renders the list', () => {
  render(<Groceries />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
})
test('checked state stays with Milk after inserting at the top', async () => {
  render(<Groceries />)
  await user.click(screen.getByLabelText('Milk'))
  expect(screen.getByLabelText('Milk')).toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Add Bread to top' }))
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
  expect(screen.getByLabelText('Milk')).toBeChecked()
  expect(screen.getByLabelText('Bread')).not.toBeChecked()
})
```
:::

:::quiz id=fe-09-q1 xp=15
Which keys are **good** choices for a list of comments loaded from an API? (select all that apply)

- [x] `key={comment.id}`
- [ ] `key={Math.random()}`
- [ ] `key={index}` — the list can be sorted by date or votes
- [x] `` key={`${comment.postId}-${comment.id}`} `` when ids are only unique per post
- [ ] `key={comment.text}`
> Keys must be unique among siblings and stable over time. A random key changes every render (all
> rows remount, losing state and focus). Index keys break when sorting — the tempting "but it's
> unique" is true, it's just not *stable*. Text isn't unique (two people can write "+1") and changes
> when edited. A composite of stable ids is fine.
:::

:::tip title="Resetting state on purpose with a key"
Keys work outside lists too. `<ProfileForm key={userId} userId={userId} />` makes React treat a
different user as a brand-new form instance — all its internal state resets. That's the clean way
to "reset a component when a prop changes", with no effects involved.
:::

:::quiz id=fe-09-q4 xp=10
`<ProfileForm key={userId} userId={userId} />` keeps a half-typed draft in its own `useState`. The
user switches from user `1` to user `2`. What happens to the draft?

- [x] It's reset: the key changed, so React unmounts the old `ProfileForm` and mounts a fresh one with initial state
- [ ] It's kept, because it's the same component type in the same place
- [ ] It's kept until an effect resets it
- [ ] React throws because keys are only allowed in lists
> "Same type in the same place keeps its state" is the normal rule — which is exactly why the draft
> would leak from user 1 to user 2 **without** the key. A different key overrides that rule: React
> treats it as a different instance. No effect is needed, and keys are valid on any element.
:::


## Conditional rendering

There's no special template syntax — use JavaScript. Pick the pattern that reads best:

```tsx
// 1. Early return — great for loading/error/empty "gates"
function OrderList({ orders }: { orders: Order[] | null }) {
  if (orders === null) return <Spinner />
  if (orders.length === 0) return <EmptyState />
  return <ul>{orders.map((o) => <OrderRow key={o.id} order={o} />)}</ul>
}

// 2. Ternary — either A or B, inline
<button>{isSaving ? 'Saving…' : 'Save'}</button>

// 3. && — A or nothing
{error && <p role="alert">{error}</p>}

// 4. A variable — when the JSX gets too nested
let badge = null
if (user.isAdmin) badge = <AdminBadge />
else if (user.isTrial) badge = <TrialBadge daysLeft={user.trialDays} />
return <header>{user.name} {badge}</header>

// 5. A lookup object — for many discrete states
const icons = { info: <InfoIcon />, warning: <WarnIcon />, error: <ErrorIcon /> }
return <div className="toast">{icons[toast.level]} {toast.message}</div>
```

How to choose:

- **Early return** when the whole component looks different (loading, error, no permission).
- **Ternary** when one spot shows *either* A *or* B.
- **`&&`** when one spot shows A *or nothing* — mind the zero trap below.
- **Variable / lookup object** when there are three or more cases.

Returning `null` from a component is perfectly valid and renders nothing. Avoid nesting ternaries
more than one level deep — reviewers will ask you to use early returns, a variable, or a separate
component.

### The `&&` zero trap

Remember how `&&` works in JavaScript: it doesn't return a boolean, it returns one of its
**operands**. `a && b` returns `a` if `a` is falsy, otherwise `b`. React renders `false`, `true`,
`null`, `undefined` and `''` as nothing — but it renders **numbers** as text, including `0`:

```tsx
{messages.length && <Badge count={messages.length} />}
// messages.length === 0 → renders "0" on the page 😬
```

Fix it by making the left side a real boolean:

```tsx
{messages.length > 0 && <Badge count={messages.length} />}
{!!messages.length && <Badge count={messages.length} />}
{messages.length ? <Badge count={messages.length} /> : null}
```

`NaN` has the same problem (it renders "NaN"). In React Native it's worse: a stray `0` or `''`
outside a `<Text>` crashes the app. A good habit: the left side of `&&` should always be a real
boolean.

:::quiz id=fe-09-q2 xp=10
`count` is `0`. What does this render?

```tsx
<div>{count && <span>{count} new</span>}</div>
```

- [ ] `<div></div>`
- [x] `<div>0</div>`
- [ ] `<div><span>0 new</span></div>`
- [ ] It throws
> `0 && …` short-circuits and evaluates to `0` itself — not `false` — and React renders numbers.
> The tempting `<div></div>` would be right if `count` were `false` or `null`. Nothing throws; it's
> a silent visual bug. Use `count > 0 && …`.
:::

:::challenge id=fe-09-c2 lang=tsx xp=30 preview=Demo
title: A notification bell without the stray zero
`Bell` takes `count: number`. It always renders a `<button aria-label="Notifications">` with the
text `🔔`. Inside it, show a `<span className="badge">` with the count **only when count > 0**, and
show `99+` instead of the number when the count is above 99.

hint: `{count > 0 && <span className="badge">{count > 99 ? '99+' : count}</span>}`

```tsx starter
export function Bell({ count }: { count: number }) {
  return (
    <button aria-label="Notifications">
      🔔{count && <span className="badge">{count}</span>}
    </button>
  )
}

export function Demo() {
  return <p><Bell count={0} /> <Bell count={3} /> <Bell count={250} /></p>
}
```

```tsx solution
export function Bell({ count }: { count: number }) {
  return (
    <button aria-label="Notifications">
      🔔{count > 0 && <span className="badge">{count > 99 ? '99+' : count}</span>}
    </button>
  )
}

export function Demo() {
  return <p><Bell count={0} /> <Bell count={3} /> <Bell count={250} /></p>
}
```

```tsx tests
test('no badge and no stray 0 when count is 0', () => {
  render(<Bell count={0} />)
  const btn = screen.getByRole('button', { name: 'Notifications' })
  expect(btn.textContent).toBe('🔔')
})
test('shows the count', () => {
  render(<Bell count={3} />)
  expect(screen.getByText('3')).toHaveClass('badge')
})
test('caps at 99+', () => {
  render(<Bell count={250} />)
  expect(screen.getByText('99+')).toHaveClass('badge')
})
```
:::

## Loading, error, empty, success

Real data has (at least) four states, and each deserves a deliberate UI:

| State | Show | Common mistake |
|---|---|---|
| **Loading** | spinner or skeleton | showing "No results" while still loading |
| **Error** | message + a way to retry | swallowing the error, blank screen |
| **Empty** | friendly explanation + next action ("Create your first project") | an empty table with only headers |
| **Success** | the data | — |

Why not three booleans (`isLoading`, `error`, `data`)? Because they allow impossible combinations
— `isLoading: true` **and** an `error` **and** stale `data` — and every render has to guess which
wins. Model it explicitly instead — a discriminated union is perfect (see the *TypeScript for Real Apps* lesson):
exactly one state at a time, and TypeScript only lets you read `items` once you've checked
`status === 'success'`. Then render with early returns:

```tsx
type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; items: Item[] }
```

:::challenge id=fe-09-c3 lang=tsx xp=50 preview=Demo
title: All four states
Write `ProjectList({ state, onRetry, onCreate })` for the `State` type in the setup:

- `loading` → a `<p role="status">` with `Loading projects…`
- `error` → a `<div role="alert">` containing a `<p>` with the message and a `Retry` button calling `onRetry`
- `success` with **no** items → a `<p>` with `No projects yet.` and a `Create project` button calling `onCreate`
- `success` with items → a `<ul>` with an `<li>` per project showing its name, **sorted by name**; archived projects (`archived: true`) get the class `archived`

hint: Start with `if (state.status === 'loading') return …` — early returns keep it flat.
hint: `state.items.toSorted((a, b) => a.name.localeCompare(b.name))`
hint: `className={p.archived ? 'archived' : undefined}`

```tsx setup
type Project = { id: number; name: string; archived?: boolean }
type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; items: Project[] }
```

```tsx starter
type Props = { state: State; onRetry: () => void; onCreate: () => void }

export function ProjectList({ state }: Props) {
  if (state.status !== 'success') return null
  return <ul>{state.items.map((p) => <li>{p.name}</li>)}</ul>
}

export function Demo() {
  return (
    <ProjectList
      state={{ status: 'success', items: [{ id: 2, name: 'Website' }, { id: 1, name: 'API', archived: true }] }}
      onRetry={() => {}}
      onCreate={() => {}}
    />
  )
}
```

```tsx solution
type Props = { state: State; onRetry: () => void; onCreate: () => void }

export function ProjectList({ state, onRetry, onCreate }: Props) {
  if (state.status === 'loading') return <p role="status">Loading projects…</p>
  if (state.status === 'error') {
    return (
      <div role="alert">
        <p>{state.message}</p>
        <button onClick={onRetry}>Retry</button>
      </div>
    )
  }
  if (state.items.length === 0) {
    return (
      <div>
        <p>No projects yet.</p>
        <button onClick={onCreate}>Create project</button>
      </div>
    )
  }
  const sorted = state.items.toSorted((a, b) => a.name.localeCompare(b.name))
  return (
    <ul>
      {sorted.map((p) => (
        <li key={p.id} className={p.archived ? 'archived' : undefined}>{p.name}</li>
      ))}
    </ul>
  )
}

export function Demo() {
  return (
    <ProjectList
      state={{ status: 'success', items: [{ id: 2, name: 'Website' }, { id: 1, name: 'API', archived: true }] }}
      onRetry={() => {}}
      onCreate={() => {}}
    />
  )
}
```

```tsx tests
const noop = () => {}
test('loading', () => {
  render(<ProjectList state={{ status: 'loading' }} onRetry={noop} onCreate={noop} />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading projects…')
})
test('error with retry', async () => {
  const onRetry = fn()
  render(<ProjectList state={{ status: 'error', message: 'Server unavailable' }} onRetry={onRetry} onCreate={noop} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable')
  await user.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onRetry).toHaveBeenCalledTimes(1)
})
test('empty state', async () => {
  const onCreate = fn()
  render(<ProjectList state={{ status: 'success', items: [] }} onRetry={noop} onCreate={onCreate} />)
  expect(screen.getByText('No projects yet.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Create project' }))
  expect(onCreate).toHaveBeenCalled()
  expect(screen.queryByRole('list')).toBeNull()
})
test('sorted list with archived class', () => {
  const items = [{ id: 1, name: 'Website' }, { id: 2, name: 'API', archived: true }, { id: 3, name: 'Mobile' }]
  render(<ProjectList state={{ status: 'success', items }} onRetry={noop} onCreate={noop} />)
  const rows = screen.getAllByRole('listitem')
  expect(rows.map((r) => r.textContent)).toEqual(['API', 'Mobile', 'Website'])
  expect(rows[0]).toHaveClass('archived')
  expect(rows[1]).not.toHaveClass('archived')
})
```
:::

:::challenge id=fe-09-c4 lang=tsx xp=50 preview=TaskBoard
title: Filter, count and group
Build `TaskBoard({ tasks })`. The `tasks` prop is optional and defaults to `sampleTasks` from the
setup (that's what the preview shows; the tests also pass their own lists):

- three buttons `All`, `Open`, `Done` set a filter (default `All`); the active one has `aria-pressed="true"`, the others `"false"`
- below, an `<h2>` with `N tasks` for the current filter — singular `1 task` for exactly one (`0 tasks` for none)
- then a `<ul>` of task titles for the current filter, in the original order
- if the filter matches nothing, show `<p>Nothing here.</p>` **instead of** the list (no empty `<ul>`)

hint: `const [filter, setFilter] = useState<'all' | 'open' | 'done'>('all')`
hint: The visible list is **derived** from `tasks` + `filter`, not stored.
hint: `aria-pressed={filter === 'open'}` renders `"true"`/`"false"`.

```tsx setup
type Task = { id: number; title: string; done: boolean }
const sampleTasks: Task[] = [
  { id: 1, title: 'Write spec', done: true },
  { id: 2, title: 'Build API', done: false },
  { id: 3, title: 'Design UI', done: true },
  { id: 4, title: 'Write tests', done: false },
  { id: 5, title: 'Deploy', done: false },
]
```

```tsx starter
import { useState } from 'react'

export function TaskBoard({ tasks = sampleTasks }: { tasks?: Task[] }) {
  return (
    <div>
      <button>All</button>
      <button>Open</button>
      <button>Done</button>
      <ul>
        {tasks.map((t) => <li key={t.id}>{t.title}</li>)}
      </ul>
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

type Filter = 'all' | 'open' | 'done'

export function TaskBoard({ tasks = sampleTasks }: { tasks?: Task[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const visible = tasks.filter((t) => (filter === 'all' ? true : filter === 'done' ? t.done : !t.done))
  const filters: [Filter, string][] = [['all', 'All'], ['open', 'Open'], ['done', 'Done']]
  return (
    <div>
      {filters.map(([value, label]) => (
        <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
          {label}
        </button>
      ))}
      <h2>{visible.length} {visible.length === 1 ? 'task' : 'tasks'}</h2>
      {visible.length === 0 ? (
        <p>Nothing here.</p>
      ) : (
        <ul>
          {visible.map((t) => <li key={t.id}>{t.title}</li>)}
        </ul>
      )}
    </div>
  )
}
```

```tsx tests
const titles = () => screen.getAllByRole('listitem').map((li) => li.textContent)
test('all by default', () => {
  render(<TaskBoard />)
  expect(screen.getByRole('heading')).toHaveTextContent('5 tasks')
  expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'false')
})
test('open filter', async () => {
  render(<TaskBoard />)
  await user.click(screen.getByRole('button', { name: 'Open' }))
  expect(titles()).toEqual(['Build API', 'Write tests', 'Deploy'])
  expect(screen.getByRole('heading')).toHaveTextContent('3 tasks')
  expect(screen.getByRole('button', { name: 'Open' })).toHaveAttribute('aria-pressed', 'true')
})
test('done filter', async () => {
  render(<TaskBoard />)
  await user.click(screen.getByRole('button', { name: 'Done' }))
  expect(titles()).toEqual(['Write spec', 'Design UI'])
  expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
})
test('singular for one task', () => {
  render(<TaskBoard tasks={[{ id: 1, title: 'Only one', done: false }]} />)
  expect(screen.getByRole('heading')).toHaveTextContent(/^1 task$/)
})
test('empty filter shows Nothing here instead of a list', async () => {
  render(<TaskBoard tasks={[{ id: 1, title: 'Only one', done: false }]} />)
  await user.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.getByText('Nothing here.')).toBeInTheDocument()
  expect(screen.queryByRole('list')).toBeNull()
  expect(screen.getByRole('heading')).toHaveTextContent('0 tasks')
})
```
:::

:::quiz id=fe-09-q3 xp=10
A list of 500 rows uses `key={crypto.randomUUID()}`. Users complain that typing in a row's input
loses focus after each keystroke. Why?

- [ ] UUIDs are too long for keys
- [x] Every render generates new keys, so React unmounts and recreates every row (and its input) on each keystroke
- [ ] 500 rows is too many for React
> A key must be stable. New key = new component instance = fresh DOM node, so focus and local state
> are gone. Length and list size are red herrings: React handles long string keys and 500 rows
> fine. Generate ids once — when the data is created or loaded — never during render.
:::

:::quiz id=fe-09-q5 xp=10
Spot the bug. The console warns *"Each child in a list should have a unique key prop"* even though
every row has a key:

```tsx
function ProductRow({ product }: { product: Product }) {
  return <li key={product.id}>{product.name}</li>
}

<ul>{products.map((p) => <ProductRow product={p} />)}</ul>
```

- [ ] `key` must be a number, and `product.id` is a string
- [x] The key is on the `<li>` inside `ProductRow`, but React needs it on the element returned **from `map`** — `<ProductRow key={p.id} product={p} />`
- [ ] Keys only work on DOM elements, not on components
- [ ] `ProductRow` must be wrapped in a `<>` fragment to accept a key
> React checks the keys of the array's direct items, which are `<ProductRow>` elements without
> keys. The `<li>`'s key is irrelevant: it has no siblings inside its own component. Keys can be
> strings or numbers and work on components too. A `<>` shorthand fragment can't even take a key;
> you'd need `<Fragment key>`, and here there's no need for one.
:::

:::job title="Lists at work"
- ESLint's `react/jsx-key` rule flags missing keys; reviewers flag index keys on anything dynamic.
- Long lists (thousands of rows) get **virtualised** with TanStack Virtual or react-window: only the visible rows are rendered.
- Designers will hand you all four states (loading skeleton, error, empty illustration, data). If they don't, ask — it's a sign of a mature team to design empty and error states up front.
:::

:::pro title="Extract the row"
Once a list item has more than a couple of lines of JSX or its own handlers, make it a component
(`<OrderRow order={o} onCancel={…} />`). The list becomes readable, the row can be tested on its own,
and later you can wrap it in `memo` if profiling shows the list re-renders too much.
:::

:::cards id=fe-09-cards1 xp=15 title="Lists & conditionals"
Q: How do you render a list in React?
A: `items.map(item => <Row key={item.id} … />)` inside JSX.
Q: What does a key do?
A: Gives each item a stable identity so React can match old and new items and keep state/DOM attached to the right one.
Q: Where does the key go?
A: On the outermost element returned by `map` (e.g. the component, not an inner `<li>`).
Q: Why are index keys risky?
A: When items are inserted, removed or reordered, the index points to a different item — state and DOM get attached to the wrong row.
Q: Why not `key={Math.random()}`?
A: New key each render → every row remounts: slow, loses focus and state.
Q: How do you reset a component's state on purpose?
A: Give it a different `key` (e.g. `key={userId}`).
Q: What's wrong with `{count && <Badge />}`?
A: When `count` is `0` it renders "0". Use `count > 0 && …`.
Q: How do you key an item that renders several siblings (`<dt>` + `<dd>`)?
A: Wrap them in `<Fragment key={id}>` — the `<>` shorthand can't take a key.
Q: The four states of loaded data?
A: Loading, error (with retry), empty (with a next action), success.
:::

## Recap

- Render lists with `map`; filter and sort before mapping (non-mutating!).
- Keys give items identity. Use stable ids; never random; index only for static lists. Put the key on the element returned from `map` (`<Fragment key>` for groups).
- Keys also reset a component on purpose: `key={id}`.
- Conditional rendering is plain JS: early return, ternary, `&&`, variables, lookup objects.
- `0 && …` renders `0` — make the condition a boolean.
- Design loading, error, empty and success states deliberately.
