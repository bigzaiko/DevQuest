---
id: fe-08
title: State & Events
level: beginner
minutes: 65
xp: 140
summary: useState, event handlers, why state updates are snapshots and batched, functional updates, updating objects and arrays immutably, and deriving instead of storing.
---

Props come from the parent. But some data belongs to the component itself and **changes over
time**: the text in a search box, whether a menu is open, the items in a cart. That's **state**. When
state changes, React re-renders the component with the new value. This lesson is about getting that
loop right — most React bugs in code reviews are state bugs.

## Why not a normal variable?

```tsx
function Counter() {
  let count = 0
  return <button onClick={() => { count = count + 1 }}>Clicked {count} times</button>
}
```

Clicking does nothing visible, for two reasons:

1. Changing a local variable doesn't tell React to re-render.
2. Even if it re-rendered, `Counter()` would run again from the top and `count` would be `0` again —
   local variables don't survive between renders.

`useState` solves both: React **stores** the value outside your function (attached to this
component instance) and **schedules a re-render** when you set it. A *re-render* simply means React
calls your component function again and updates the DOM where the output changed.

```tsx
import { useState } from 'react'

function Counter() {
  const [count, setCount] = useState(0)   // [current value, setter]; 0 = initial value
  return <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
}
```

Reading the line `const [count, setCount] = useState(0)`:

- `0` is the **initial value**. React uses it on the *first* render only; after that it returns
  whatever you last set.
- It returns a pair, destructured as an array: the current value and a **setter**. Name them
  `[thing, setThing]` by convention.
- TypeScript infers the type from the initial value (`number` here). When it can't — an empty array,
  or `null` for "not loaded yet" — pass it explicitly: `useState<Todo[]>([])`,
  `useState<User | null>(null)`.

State is **per component instance**. Render `<Counter />` twice and you get two independent counts,
exactly like two calls of a function each get their own local variables.

`useState` is a **Hook**. Hooks are functions starting with `use` that let components "hook into"
React features. They must be called at the top level of a component (not in loops, conditions or
nested functions). The short reason: React doesn't know your variable names — it recognises
"the first `useState`, the second `useState`…" purely by **call order**, so the order must be the
same on every render. More in the custom hooks lesson. (The one exception is React 19's `use`,
which may be called inside `if`s and loops — you'll meet it in the Context lesson.)

:::warn title="The initial value is read once"
`useState(props.initialName)` copies the prop on the first render. If the parent later passes a
different `initialName`, the state does **not** follow. That's usually what you want for an
"initial" value — but if you expected it to stay in sync, you didn't want state at all (see
*derived state* below). And if computing the initial value is expensive, pass a function:
`useState(() => loadDraft())` runs it once instead of on every render.
:::

## Handling events

```tsx
function Toolbar() {
  function handleSave() {
    console.log('saving…')
  }
  return (
    <>
      <button onClick={handleSave}>Save</button>                {/* pass the function */}
      <button onClick={() => console.log('copy')}>Copy</button>  {/* inline arrow */}
      {/* ❌ <button onClick={handleSave()}> calls it during render! */}
    </>
  )
}
```

- Pass a **function**, don't call it. `onClick={handleSave()}` runs on every render and passes its return value (`undefined`). If the call sets state (`onClick={setOpen(true)}`), it's worse: setting state during render triggers another render, which sets state again… React stops it with *"Too many re-renders"*.
- Need an argument? Wrap it in an arrow: `onClick={() => remove(item.id)}`.
- Event props are camelCase (`onClick`, `onKeyDown`, `onSubmit`), unlike HTML's lowercase `onclick`/`onkeydown` attributes.
- Handlers receive a **synthetic event** — a cross-browser wrapper with the usual API: `e.preventDefault()`, `e.stopPropagation()`, `e.key`, `e.target` (the element where the event *started*, e.g. an `<svg>` inside a button) and `e.currentTarget` (the element the handler is *attached to* — usually the one you want).
- Event handlers are the right place for **side effects** (API calls, analytics, navigation). They run because the user did something, not because React rendered. Rendering itself must stay pure: compute JSX, don't change anything.

```tsx
function NameInput() {
  const [name, setName] = useState('')
  return (
    <input
      value={name}
      onChange={(e) => setName(e.target.value)}   // fires on every keystroke in React
      onKeyDown={(e) => { if (e.key === 'Escape') setName('') }}
    />
  )
}
```

Two things in that example deserve a closer look:

- **`onChange` fires on every keystroke** in React. (The plain DOM `change` event fires only when the
  input loses focus; React's `onChange` behaves like the DOM `input` event.)
- `value={name}` + `onChange` makes this a **controlled input**: the state is the source of truth and
  the input just shows it. If you set `value` but forget `onChange`, React renders a read-only input
  that ignores typing (and warns in the console). Forms get their own lesson.

In TypeScript, inline handlers are typed automatically. For a separate handler, use React's event
types:

```tsx
import type { ChangeEvent, KeyboardEvent } from 'react'

function handleChange(e: ChangeEvent<HTMLInputElement>) { setName(e.target.value) }
function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) { if (e.key === 'Escape') setName('') }
```

:::quiz id=fe-08-q3 xp=10
What happens when this component first renders?

```tsx
function Menu() {
  const [open, setOpen] = useState(false)
  return <button onClick={setOpen(!open)}>Menu</button>
}
```

- [ ] Nothing until the button is clicked, then it toggles
- [ ] It toggles once and then works normally
- [x] React throws *"Too many re-renders"*: `setOpen(!open)` is **called** during render, which schedules another render, which calls it again…
- [ ] TypeScript accepts it and the button is simply never clickable
> The braces contain a *call*, not a function. It runs while rendering, and setting state during
> render re-renders immediately — an infinite loop React aborts with an error. It's tempting to
> think it "toggles once", but every render calls it again. Fix: `onClick={() => setOpen(!open)}`.
> (TypeScript would also complain, because `setOpen` returns `void`, not a handler.)
:::

:::challenge id=fe-08-c1 lang=tsx xp=30 preview=Counter
title: A bounded counter
Build `Counter` with three buttons — `−`, `+` and `Reset` — and a paragraph `Count: N`.

- starts at `0`
- `−` never goes below `0`; `+` never above `10`
- disable `−` at `0` and `+` at `10`
- give the `−`/`+` buttons `aria-label`s `Decrease` and `Increase`

hint: `disabled={count === 0}`
hint: `onClick={() => setCount(Math.min(10, count + 1))}`

```tsx starter
import { useState } from 'react'

export function Counter() {
  let count = 0
  return (
    <div>
      <button aria-label="Decrease" onClick={() => count--}>−</button>
      <p>Count: {count}</p>
      <button aria-label="Increase" onClick={() => count++}>+</button>
      <button>Reset</button>
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

export function Counter() {
  const [count, setCount] = useState(0)
  return (
    <div>
      <button aria-label="Decrease" disabled={count === 0} onClick={() => setCount(Math.max(0, count - 1))}>−</button>
      <p>Count: {count}</p>
      <button aria-label="Increase" disabled={count === 10} onClick={() => setCount(Math.min(10, count + 1))}>+</button>
      <button onClick={() => setCount(0)}>Reset</button>
    </div>
  )
}
```

```tsx tests
test('counts up and resets', async () => {
  render(<Counter />)
  const inc = screen.getByRole('button', { name: 'Increase' })
  await user.click(inc)
  await user.click(inc)
  expect(screen.getByText('Count: 2')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Reset' }))
  expect(screen.getByText('Count: 0')).toBeInTheDocument()
})
test('cannot go below 0', () => {
  render(<Counter />)
  expect(screen.getByRole('button', { name: 'Decrease' })).toBeDisabled()
})
test('stops at 10', async () => {
  render(<Counter />)
  const inc = screen.getByRole('button', { name: 'Increase' })
  for (let i = 0; i < 10; i++) await user.click(inc)
  expect(screen.getByText('Count: 10')).toBeInTheDocument()
  expect(inc).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Decrease' }))
  expect(screen.getByText('Count: 9')).toBeInTheDocument()
})
```
:::

:::tip title="How you would test this"
Look at the `tests` block of that challenge: it is already a real component test. In your own Vite project
the same thing runs with **Vitest** and **React Testing Library** — only the imports are new:

```tsx
// Counter.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { Counter } from './Counter'

test('Increase adds one', async () => {
  const user = userEvent.setup()
  render(<Counter />)
  await user.click(screen.getByRole('button', { name: 'Increase' }))
  expect(screen.getByText('Count: 1')).toBeInTheDocument()
})
```

Notice what the test does: it clicks a button found **by its accessible name** and checks the **text the user
sees**. It never reads `count` directly. Testing what the user experiences, not the implementation, is the
habit to build from day one. Install steps, `jsdom` setup and mocking come in **Testing React with Vitest &
Testing Library**; until then, every challenge in this track is a free sample of the style.
:::

## State is a snapshot

This is the single most important idea in this lesson. During one render, `count` is a
**constant**. Calling `setCount` doesn't change the variable you're holding — it asks React for a
*future* render where `useState` returns the new value.

```tsx
function Counter() {
  const [count, setCount] = useState(0)

  function handleClick() {
    setCount(count + 1)
    console.log(count)      // still 0! This render's snapshot.
  }
  // …
}
```

Think of each render as a photo: the event handlers created in that render "see" the state values
from that photo, forever — even if they run later (in a `setTimeout`, after an `await`).

Why does React work this way? Because it makes a render **consistent**: the JSX, the handlers and
everything you compute in one render all agree on the same values, and nothing changes under your
feet halfway through a function. If you need the new value right away, compute it into a local
variable first:

```tsx
function handleClick() {
  const next = count + 1
  setCount(next)
  console.log(next)         // 1 — use the local variable, not the state
}
```

:::quiz id=fe-08-q1 xp=15
`count` is `0`. The user clicks once. What is shown after the re-render, and what is logged?

```tsx
function handleClick() {
  setCount(count + 1)
  setCount(count + 1)
  setCount(count + 1)
  console.log(count)
}
```

- [ ] Shows `3`, logs `3`
- [ ] Shows `3`, logs `0`
- [x] Shows `1`, logs `0`
- [ ] Shows `1`, logs `1`
> All three calls compute `0 + 1` from the same snapshot, so they all request "set it to 1". And
> `count` in this handler is `0` no matter what — the new value only exists in the next render.
:::

## Batching and functional updates

React **batches** state updates: it waits until your event handler finishes, then re-renders
once with all updates applied. (React 18+ batches everywhere — in timeouts, promises and native
event handlers too.) That's good for performance, and it means a series of setters doesn't cause a
series of renders.

When the next state depends on the previous one, pass an **updater function** instead of a value.
React queues the functions and runs them in order, each receiving the *latest* state:

```tsx
setCount((c) => c + 1)
setCount((c) => c + 1)
setCount((c) => c + 1)   // → 3
```

Compare that with the quiz above: `setCount(count + 1)` means "set it to *1*" (a value fixed at the
time of the click), while `setCount((c) => c + 1)` means "add one to *whatever it is by then*" (an
instruction). The `c` name is a convention — use the first letter, or `prev`.

Rule of thumb: **if the new state is computed from the old state, use the updater form.** It's
also the safe choice in callbacks that run later (intervals, after `await`), where the snapshot may
be **stale** — that is, from an older render. When the new value doesn't depend on the old one
(`setCount(0)`, `setName(e.target.value)`), the plain form is fine.

:::quiz id=fe-08-q4 xp=15
`count` is `0`. After one click, what does the screen show?

```tsx
function handleClick() {
  setCount((c) => c + 1)
  setCount(count + 5)
  setCount((c) => c * 2)
}
```

- [ ] `12` — every call sees the latest value
- [x] `10` — the queue runs in order: `0 → 1`, then *replace with* `0 + 5 = 5`, then `5 × 2`
- [ ] `2` — only the updater functions count
- [ ] `5` — the last plain value wins
> React queues all three and processes them in order on the next render. An updater gets the
> result so far; a plain value **replaces** it. `count + 5` was computed from the snapshot (`0`), so
> it replaces the `1` with `5`, and the final updater doubles that. `12` is tempting, but it would
> require `count` to be `1` inside the handler — it's still `0`.
:::

:::challenge id=fe-08-c2 lang=tsx xp=40 preview=Scoreboard
title: Fix the stale updates
The `+3` button should add 3 points, and `Bonus` should add 1 point now and another 1 point
after 50 ms (a delayed reward). Both are broken because they use the snapshot value. Fix them with
updater functions.

hint: `setScore((s) => s + 1)` three times, or `setScore((s) => s + 3)` once.
hint: Inside the `setTimeout`, the snapshot `score` is old — the updater form gets the latest value.

```tsx starter
import { useState } from 'react'

export function Scoreboard() {
  const [score, setScore] = useState(0)

  function addThree() {
    setScore(score + 1)
    setScore(score + 1)
    setScore(score + 1)
  }

  function bonus() {
    setScore(score + 1)
    setTimeout(() => setScore(score + 1), 50)
  }

  return (
    <div>
      <p>Score: {score}</p>
      <button onClick={addThree}>+3</button>
      <button onClick={bonus}>Bonus</button>
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

export function Scoreboard() {
  const [score, setScore] = useState(0)

  function addThree() {
    setScore((s) => s + 1)
    setScore((s) => s + 1)
    setScore((s) => s + 1)
  }

  function bonus() {
    setScore((s) => s + 1)
    setTimeout(() => setScore((s) => s + 1), 50)
  }

  return (
    <div>
      <p>Score: {score}</p>
      <button onClick={addThree}>+3</button>
      <button onClick={bonus}>Bonus</button>
    </div>
  )
}
```

```tsx tests
test('+3 adds three', async () => {
  render(<Scoreboard />)
  await user.click(screen.getByRole('button', { name: '+3' }))
  expect(screen.getByText('Score: 3')).toBeInTheDocument()
})
test('bonus adds 1 now and 1 later', async () => {
  render(<Scoreboard />)
  await user.click(screen.getByRole('button', { name: 'Bonus' }))
  expect(screen.getByText('Score: 1')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('Score: 2')).toBeInTheDocument())
})
test('bonus does not lose clicks made in between', async () => {
  render(<Scoreboard />)
  await user.click(screen.getByRole('button', { name: 'Bonus' }))
  await user.click(screen.getByRole('button', { name: '+3' }))
  await sleep(120)
  await waitFor(() => expect(screen.getByText('Score: 5')).toBeInTheDocument())
})
```
:::

## Objects and arrays in state: replace, don't mutate

React decides whether to re-render by comparing the old and new state with `Object.is`. If you mutate
an object and set the *same* object, React sees no change and **skips the update**:

```tsx
const [user, setUser] = useState({
  name: 'Ada',
  email: 'ada@x.io',
  address: { city: 'London', zip: 'N1' },
})

// ❌ same object — no re-render (and you've corrupted the previous snapshot)
user.name = 'Grace'
setUser(user)

// ✅ new object with the change
setUser({ ...user, name: 'Grace' })
// ✅ nested: copy every level you change
setUser({ ...user, address: { ...user.address, city: 'Paris' } })
```

Arrays, same story — use the non-mutating operations from the Modern JS lesson:

```tsx
setTodos([...todos, newTodo])                                  // add
setTodos(todos.filter((t) => t.id !== id))                     // remove
setTodos(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))  // update one
setTodos(todos.toSorted((a, b) => a.title.localeCompare(b.title)))      // sort
```

Why the copy is a *shallow* one: `{ ...user }` copies only the top level. `address` in the copy is
still the **same object** as in the old state, so `copy.address.city = 'Paris'` would mutate the
old snapshot too. That's why each level you change gets its own spread. (If the nesting gets deep,
flatten your state or reach for a helper like Immer.)

A handy trick for forms with many fields: one handler, keyed by the input's `name`:

```tsx
function handleChange(e: ChangeEvent<HTMLInputElement>) {
  setForm({ ...form, [e.target.name]: e.target.value })
}
```

:::quiz id=fe-08-q5 xp=10
Spot the bug. Clicking **Add** does nothing visible — but as soon as you type the next character
into the text box, the "missing" todos suddenly appear.

```tsx
function add() {
  todos.push({ id: nextId, text, done: false })
  setTodos(todos)
}
```

- [ ] `push` is asynchronous, so the array isn't updated yet when `setTodos` runs
- [x] `push` mutates the existing array; `setTodos(todos)` passes the **same reference**, so React sees no change and skips the render. Use `setTodos([...todos, newTodo])`
- [ ] `setTodos` must always receive an updater function
- [ ] The list needs a `key` to show new items
> `Object.is(oldTodos, todos)` is `true` because it's the same array, so React bails out. The items
> show up later only because some *other* state change re-renders the component and it reads the
> (mutated) array. `push` is synchronous, and the plain setter form is fine here — the problem is
> purely the missing new reference.
:::

:::challenge id=fe-08-c3 lang=tsx xp=50 preview=TodoApp
title: Todo list with immutable updates
Build `TodoApp`:

- a text input labelled `New todo` and an `Add` button; adding trims the text, ignores empty input, appends `{ id, text, done: false }` and clears the input
- each todo is an `<li>` containing a checkbox labelled with the todo text (wrap it: `<label><input type="checkbox" …/> {text}</label>`) and a button `Delete <text>` (use `aria-label`)
- a paragraph `N left` counting todos that aren't done

Never mutate the array or the todo objects.

hint: For ids, a counter works: `const [nextId, setNextId] = useState(1)`. (`crypto.randomUUID()` also works if you change the `id` type to `string`.)
hint: Toggle: `setTodos(todos.map(t => t.id === id ? { ...t, done: !t.done } : t))`
hint: `N left` is **derived**: `todos.filter(t => !t.done).length` — don't store it in state.

```tsx starter
import { useState } from 'react'

type Todo = { id: number; text: string; done: boolean }

export function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [text, setText] = useState('')

  function add() {
    todos.push({ id: todos.length + 1, text, done: false })
    setTodos(todos)
  }

  return (
    <div>
      <label>New todo <input value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button onClick={add}>Add</button>
      <ul>
        {todos.map((t) => <li key={t.id}>{t.text}</li>)}
      </ul>
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

type Todo = { id: number; text: string; done: boolean }

export function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [text, setText] = useState('')
  const [nextId, setNextId] = useState(1)

  function add() {
    const trimmed = text.trim()
    if (!trimmed) return
    setTodos([...todos, { id: nextId, text: trimmed, done: false }])
    setNextId(nextId + 1)
    setText('')
  }

  function toggle(id: number) {
    setTodos(todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))
  }

  function remove(id: number) {
    setTodos(todos.filter((t) => t.id !== id))
  }

  const left = todos.filter((t) => !t.done).length

  return (
    <div>
      <label>New todo <input value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button onClick={add}>Add</button>
      <ul>
        {todos.map((t) => (
          <li key={t.id}>
            <label>
              <input type="checkbox" checked={t.done} onChange={() => toggle(t.id)} /> {t.text}
            </label>
            <button aria-label={`Delete ${t.text}`} onClick={() => remove(t.id)}>×</button>
          </li>
        ))}
      </ul>
      <p>{left} left</p>
    </div>
  )
}
```

```tsx tests
async function addTodo(text: string) {
  await user.type(screen.getByLabelText('New todo'), text)
  await user.click(screen.getByRole('button', { name: 'Add' }))
}
test('adds trimmed todos and clears the input', async () => {
  render(<TodoApp />)
  await addTodo('  Buy milk ')
  expect(screen.getAllByRole('listitem')).toHaveLength(1)
  expect(screen.getByLabelText('Buy milk')).toBeInTheDocument()
  expect(screen.getByLabelText('New todo')).toHaveValue('')
})
test('ignores empty input', async () => {
  render(<TodoApp />)
  await addTodo('   ')
  expect(screen.queryAllByRole('listitem')).toHaveLength(0)
})
test('toggle updates the count', async () => {
  render(<TodoApp />)
  await addTodo('A')
  await addTodo('B')
  expect(screen.getByText('2 left')).toBeInTheDocument()
  await user.click(screen.getByLabelText('A'))
  expect(screen.getByLabelText('A')).toBeChecked()
  expect(screen.getByText('1 left')).toBeInTheDocument()
})
test('delete removes only that todo', async () => {
  render(<TodoApp />)
  await addTodo('A')
  await addTodo('B')
  await user.click(screen.getByRole('button', { name: 'Delete A' }))
  expect(screen.queryByLabelText('A')).toBeNull()
  expect(screen.getByLabelText('B')).toBeInTheDocument()
  expect(screen.getByText('1 left')).toBeInTheDocument()
})
```
:::

## Derived state: don't store what you can compute

If a value can be computed from props or other state, **compute it during render**. Storing it
separately creates two sources of truth that can — and eventually will — disagree.

```tsx
// ❌ fullName is duplicated state; every setter must remember to update it
const [first, setFirst] = useState('')
const [last, setLast] = useState('')
const [fullName, setFullName] = useState('')

// ✅ derived: always correct, nothing to sync
const fullName = `${first} ${last}`.trim()
```

Why is the derived version also fast enough? Because the component re-runs on every state change
anyway — computing a string or filtering a few hundred items during that render costs microseconds.

The same goes for totals, filtered lists, counts, "is the form valid?", "is anything selected?".
If the computation is genuinely expensive (tens of thousands of items, heavy maths), wrap it in
`useMemo` — but it's still derived, not stored. A quick test for *"should this be state?"*:

- Does it stay the same over time? → not state (a constant or a prop).
- Is it passed in from a parent? → not state (a prop).
- Can you compute it from existing state or props? → **not state** (derive it).
- Otherwise → state.

:::challenge id=fe-08-c4 lang=tsx xp=40 preview=Cart
title: Bug hunt — a total that lies
The cart's total is stored in state and updated "by hand". It's right after adding items, but
**wrong after changing a quantity or removing a line**. Remove the `total` state and derive it.
Also make sure quantity changes don't mutate the line objects.

The quantity inputs are labelled `Quantity <name>`, the remove buttons `Remove <name>`, and the
total is shown as `Total: 12.00 €`.

hint: Delete `const [total, setTotal] = …` and all `setTotal` calls.
hint: `const total = lines.reduce((s, l) => s + l.price * l.qty, 0)`

```tsx starter
import { useState } from 'react'

type Line = { id: number; name: string; price: number; qty: number }

const initial: Line[] = [
  { id: 1, name: 'Coffee', price: 4, qty: 2 },
  { id: 2, name: 'Bagel', price: 2.5, qty: 1 },
]

export function Cart() {
  const [lines, setLines] = useState(initial)
  const [total, setTotal] = useState(10.5)

  function setQty(id: number, qty: number) {
    const line = lines.find((l) => l.id === id)!
    line.qty = qty
    setLines([...lines])
  }

  function remove(id: number) {
    setLines(lines.filter((l) => l.id !== id))
  }

  function addCookie() {
    setLines([...lines, { id: Date.now(), name: 'Cookie', price: 1.5, qty: 1 }])
    setTotal(total + 1.5)
  }

  return (
    <div>
      <ul>
        {lines.map((l) => (
          <li key={l.id}>
            {l.name}
            <input type="number" min={0} aria-label={`Quantity ${l.name}`} value={l.qty} onChange={(e) => setQty(l.id, Number(e.target.value))} />
            <button aria-label={`Remove ${l.name}`} onClick={() => remove(l.id)}>×</button>
          </li>
        ))}
      </ul>
      <button onClick={addCookie}>Add cookie</button>
      <p>Total: {total.toFixed(2)} €</p>
    </div>
  )
}
```

```tsx solution
import { useState } from 'react'

type Line = { id: number; name: string; price: number; qty: number }

const initial: Line[] = [
  { id: 1, name: 'Coffee', price: 4, qty: 2 },
  { id: 2, name: 'Bagel', price: 2.5, qty: 1 },
]

export function Cart() {
  const [lines, setLines] = useState(initial)
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0)

  function setQty(id: number, qty: number) {
    setLines(lines.map((l) => (l.id === id ? { ...l, qty } : l)))
  }

  function remove(id: number) {
    setLines(lines.filter((l) => l.id !== id))
  }

  function addCookie() {
    setLines([...lines, { id: Date.now(), name: 'Cookie', price: 1.5, qty: 1 }])
  }

  return (
    <div>
      <ul>
        {lines.map((l) => (
          <li key={l.id}>
            {l.name}
            <input type="number" min={0} aria-label={`Quantity ${l.name}`} value={l.qty} onChange={(e) => setQty(l.id, Number(e.target.value))} />
            <button aria-label={`Remove ${l.name}`} onClick={() => remove(l.id)}>×</button>
          </li>
        ))}
      </ul>
      <button onClick={addCookie}>Add cookie</button>
      <p>Total: {total.toFixed(2)} €</p>
    </div>
  )
}
```

```tsx tests
test('initial total', () => {
  render(<Cart />)
  expect(screen.getByText('Total: 10.50 €')).toBeInTheDocument()
})
test('removing a line updates the total', async () => {
  render(<Cart />)
  await user.click(screen.getByRole('button', { name: 'Remove Bagel' }))
  expect(screen.getByText('Total: 8.00 €')).toBeInTheDocument()
})
test('changing quantity updates the total', async () => {
  render(<Cart />)
  const qty = screen.getByLabelText('Quantity Coffee')
  await user.clear(qty)
  await user.type(qty, '3')
  expect(screen.getByText('Total: 14.50 €')).toBeInTheDocument()
})
test('the initial data is never mutated', async () => {
  render(<Cart />)
  const qty = screen.getByLabelText('Quantity Coffee')
  await user.clear(qty)
  await user.type(qty, '5')
  expect(initial[0].qty).toBe(2)
})
```
:::

:::challenge id=fe-08-c5 lang=tsx mode=tests xp=60
title: Test a Stepper component
`Stepper` takes `{ initial?: number; min?: number; max?: number; step?: number }` (defaults `0`, `0`,
`10`, `1`), renders `Value: N` and two buttons labelled `Decrease` / `Increase`. The value never
leaves `[min, max]`. Write tests that pass for this implementation and catch the three hidden bugs.

hint: Render with props that make the edge cases easy to reach, e.g. `<Stepper initial={9} max={10} step={1} />`.
hint: Test `step`: `<Stepper step={5} />` then one click on `Increase`.
hint: Test both bounds — what happens when you click `Decrease` at `min`?

```tsx impl
import { useState } from 'react'

export function Stepper({ initial = 0, min = 0, max = 10, step = 1 }: { initial?: number; min?: number; max?: number; step?: number }) {
  const [value, setValue] = useState(initial)
  return (
    <div>
      <button aria-label="Decrease" onClick={() => setValue((v) => Math.max(min, v - step))}>−</button>
      <span>Value: {value}</span>
      <button aria-label="Increase" onClick={() => setValue((v) => Math.min(max, v + step))}>+</button>
    </div>
  )
}
```

```tsx mutant
import { useState } from 'react'

export function Stepper({ initial = 0, min = 0, max = 10, step = 1 }: { initial?: number; min?: number; max?: number; step?: number }) {
  const [value, setValue] = useState(initial)
  return (
    <div>
      <button aria-label="Decrease" onClick={() => setValue((v) => Math.max(min, v - step))}>−</button>
      <span>Value: {value}</span>
      <button aria-label="Increase" onClick={() => setValue((v) => v + step)}>+</button>
    </div>
  )
}
```

```tsx mutant
import { useState } from 'react'

export function Stepper({ initial = 0, min = 0, max = 10, step = 1 }: { initial?: number; min?: number; max?: number; step?: number }) {
  const [value, setValue] = useState(initial)
  return (
    <div>
      <button aria-label="Decrease" onClick={() => setValue((v) => v - step)}>−</button>
      <span>Value: {value}</span>
      <button aria-label="Increase" onClick={() => setValue((v) => Math.min(max, v + step))}>+</button>
    </div>
  )
}
```

```tsx mutant
import { useState } from 'react'

export function Stepper({ initial = 0, min = 0, max = 10, step = 1 }: { initial?: number; min?: number; max?: number; step?: number }) {
  const [value, setValue] = useState(initial)
  return (
    <div>
      <button aria-label="Decrease" onClick={() => setValue((v) => Math.max(min, v - 1))}>−</button>
      <span>Value: {value}</span>
      <button aria-label="Increase" onClick={() => setValue((v) => Math.min(max, v + 1))}>+</button>
    </div>
  )
}
```

```tsx starter
test('starts at the initial value', () => {
  render(<Stepper initial={3} />)
  expect(screen.getByText('Value: 3')).toBeInTheDocument()
})
```

```tsx solution
test('starts at the initial value', () => {
  render(<Stepper initial={3} />)
  expect(screen.getByText('Value: 3')).toBeInTheDocument()
})
test('uses step', async () => {
  render(<Stepper step={5} />)
  await user.click(screen.getByRole('button', { name: 'Increase' }))
  expect(screen.getByText('Value: 5')).toBeInTheDocument()
})
test('clamps at max', async () => {
  render(<Stepper initial={9} max={10} />)
  const inc = screen.getByRole('button', { name: 'Increase' })
  await user.click(inc)
  await user.click(inc)
  expect(screen.getByText('Value: 10')).toBeInTheDocument()
})
test('clamps at min', async () => {
  render(<Stepper initial={1} min={0} />)
  const dec = screen.getByRole('button', { name: 'Decrease' })
  await user.click(dec)
  await user.click(dec)
  expect(screen.getByText('Value: 0')).toBeInTheDocument()
})
```
:::

:::quiz id=fe-08-q2 xp=10
Which of these should **not** be stored in `useState`? (select all that apply)

- [x] `isValid`, computed from the email and password fields
- [ ] The text currently typed into a search box
- [x] `visibleProducts = products.filter(p => p.name.includes(query))`
- [x] A `title` prop received from the parent
- [ ] Whether a dropdown menu is open
> Derived values (`isValid`, `visibleProducts`) are computed during render; props are already owned
> by the parent (copying a prop into state means it won't follow updates). The search text and the
> menu's open flag genuinely change over time, can't be computed from anything else, and belong to
> this component — so they **are** state. The tempting mistake is marking the search text: it's the
> *input* to the filter, not derived from it.
:::

:::job title="State habits reviewers look for"
- Updater form (`setX(x => …)`) whenever the next value depends on the previous one.
- No mutation — a `push`, `splice` or `obj.x = …` on state is an instant review comment.
- Minimal state: no `fullName` next to `first`/`last`, no `filteredItems` next to `items` + `query`.
- Related values that always change together grouped into one object, or into `useReducer` when the update logic grows.
:::

:::pro title="When useState grows up: useReducer"
When a component has many related state updates (a wizard, a cart, an editor), move the logic into a
**reducer** — a pure `(state, action) => newState` function — with `useReducer(reducer, initialState)`.
The component then only *dispatches* intent: `dispatch({ type: 'add', productId })`. Reducers are
trivial to unit test without rendering anything (you wrote one in the *TypeScript for Real Apps* lesson).
:::

:::cards id=fe-08-cards1 xp=15 title="State & events"
Q: Why can't a plain variable hold component state?
A: Changing it doesn't trigger a re-render, and it's reset every time the function runs.
Q: What does `useState` return?
A: `[value, setValue]` — the current snapshot and a setter that schedules a re-render.
Q: `onClick={save}` vs `onClick={save()}`?
A: The first passes the function; the second calls it during render and passes its return value.
Q: After `setCount(count + 1)`, what is `count` in the same handler?
A: The old value — state is a snapshot per render.
Q: What is batching?
A: React groups the state updates from one event and re-renders once afterwards.
Q: When to use `setX(prev => …)`?
A: Whenever the new value depends on the previous one, especially for repeated or delayed updates.
Q: Why doesn't `user.name = 'x'; setUser(user)` re-render?
A: Same object reference — `Object.is` says nothing changed. Create a new object.
Q: What is derived state and what should you do with it?
A: A value computable from props/state. Compute it during render; don't store it.
Q: Why must Hooks be called at the top level, never inside an `if`?
A: React identifies each Hook by its call order; the order must be identical on every render.
Q: What does `onClick={setOpen(true)}` do?
A: Calls the setter during render → another render → … React throws "Too many re-renders". Use `() => setOpen(true)`.
Q: `e.target` vs `e.currentTarget`?
A: `target` = where the event started (maybe a child); `currentTarget` = the element whose handler is running.
:::

## Recap

- `useState` keeps a value across renders and re-renders when you set it.
- The initial value is used once; state is per component instance; Hooks run at the top level in a fixed order.
- Pass functions to event props (`onClick={handle}`, `onClick={() => remove(id)}`); handlers are where side effects go, rendering stays pure.
- State is a snapshot: the setter affects the *next* render, not the current variable.
- Updates are batched; use updater functions when the next value depends on the previous one.
- Replace objects and arrays instead of mutating them.
- Keep state minimal: derive everything you can compute.
