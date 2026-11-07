---
id: fe-06
title: Components & JSX
level: beginner
minutes: 55
xp: 120
summary: What JSX compiles to, its rules, components as plain functions, expressions, fragments, className/style, and React's render → commit model.
---

A React app is a tree of **components**: functions that take some input and return a description of
UI. You don't tell the browser "create a div, set its text, append it" — you describe *what the UI
should look like for the current data*, and React figures out the DOM operations. That shift from
**imperative** ("do these steps") to **declarative** ("this is the result") is the core idea, and
everything in React follows from it.

## A component is a function

```tsx
function Welcome() {
  return <h1>Hello, DevQuest!</h1>
}

export function App() {
  return (
    <main>
      <Welcome />
      <Welcome />
    </main>
  )
}
```

- A component is a **JavaScript function** whose name starts with a **capital letter**, returning JSX (or `null` for nothing).
- You use it like an HTML tag: `<Welcome />`. Each use is an independent *instance*.
- Define components at the **top level** of a module — never inside another component (it would be
  a brand-new component type on every render, so React would throw away its DOM and state each time).

Why the capital letter? JSX uses the case to decide: `<div>` (lowercase) is a DOM element, the string
`'div'`; `<Welcome>` (capitalised) is a reference to the variable `Welcome`. Get it wrong and
`<welcome />` renders an unknown HTML tag `<welcome>` with nothing in it — React only logs a
console warning, so the mistake is easy to miss.

Why functions at all? Because a function is the simplest thing that maps input to output:
*data in, UI description out*. You split the page into components for the same reasons you split
code into functions — to name a piece, reuse it, and reason about it in isolation.

## What JSX really is

JSX is not HTML and browsers can't run it. It's **syntax sugar**: your build tool (Vite, via
`@vitejs/plugin-react`, or `tsc` with `"jsx": "react-jsx"`) compiles it to plain function calls:

```tsx
const el = <a href="/docs" className="link">Read the {topic} docs</a>

// compiles to (the "automatic runtime", React 17+):
import { jsxs as _jsxs } from 'react/jsx-runtime'
const el = _jsxs('a', { href: '/docs', className: 'link', children: ['Read the ', topic, ' docs'] })
// (`jsx` is used for a single child, `jsxs` for several — you never write either by hand)
```

The result is a plain object — a **React element** — roughly `{ type: 'a', props: { … }, key: null }`.
It's not a DOM node, it's a *description*. Creating thousands of them is cheap. That's why you can
write JSX anywhere an expression goes: in variables, in `return`, as function arguments, in arrays.

Before React 17 (the "classic runtime"), JSX compiled to `React.createElement(...)` instead, which is
why older files start with `import React from 'react'`. With the automatic runtime that import is no
longer needed just to use JSX.

:::quiz id=fe-06-q1 xp=10
What is the value of `el`?

```tsx
const el = <button disabled>Save</button>
```

- [ ] An `HTMLButtonElement` you can `.click()`
- [x] A plain object describing a button (type `'button'`, props `{ disabled: true, children: 'Save' }`)
- [ ] A string of HTML: `'<button disabled>Save</button>'`
> JSX produces React elements — lightweight descriptions. React's DOM renderer later turns them into
> real DOM nodes (and only touches the parts that changed). The DOM-element answer is tempting
> because the JSX *looks* like HTML, but nothing touches the DOM until React renders it — there's
> nothing to `.click()` yet. It isn't an HTML string either: React never builds HTML strings in the
> browser, which is also why `{userInput}` is escaped and safe from XSS by default. Note that a bare
> attribute like `disabled` means `disabled={true}`.
:::

## The rules of JSX

**1. Return a single root.** A function can only return one value. Wrap siblings in a parent — or
in a **Fragment** if you don't want an extra DOM node:

```tsx
function Header() {
  return (
    <>
      <h1>Shop</h1>
      <nav>…</nav>
    </>
  )
}
```

`<>…</>` is short for `<Fragment>…</Fragment>` (`import { Fragment } from 'react'`). You need the long
form only to give it a `key` in lists.

**2. Close every tag.** `<img />`, `<input />`, `<br />` — JSX is XML-strict. HTML lets you write
`<input>` and leaves it open; JSX needs the `/>` so the compiler knows where the element ends.

**3. camelCase attributes, with a few renames.** Attributes become JavaScript object keys, so:

| HTML | JSX | Why |
|---|---|---|
| `class` | `className` | `class` is a reserved word in JS |
| `for` | `htmlFor` | `for` is a reserved word |
| `onclick` | `onClick` | camelCase events, value is a function |
| `tabindex` | `tabIndex` | camelCase |
| `style="color: red"` | `style={{ color: 'red' }}` | an object, camelCased CSS properties |
| `aria-label`, `data-id` | unchanged | `aria-*` and `data-*` stay kebab-case |

**4. Curly braces switch to JavaScript.** Inside `{ }` you can put any **expression** (something
that produces a value) — not statements like `if` or `for`:

```tsx
const user = { first: 'Ada', last: 'Lovelace', avatar: '/ada.png' }
const unread = 3

<div className="profile">
  <img src={user.avatar} alt={`${user.first} ${user.last}`} />
  <h2>{user.first} {user.last.toUpperCase()}</h2>
  <p>You have {unread} new {unread === 1 ? 'message' : 'messages'}</p>
  <p>Total: {(19.99 * 3).toFixed(2)} €</p>
</div>
```

**5. Comments** go inside braces: `{/* like this */}`.

**6. Whitespace.** Text on one line keeps its spaces, but line breaks (and the indentation around
them) between elements are dropped. If two elements on separate lines need a space between them,
write `{' '}`.

What renders: strings and numbers render as text; `null`, `undefined`, `true` and `false` render
**nothing**; arrays render each item. Plain objects can't be rendered — `{user}` throws
*"Objects are not valid as a React child"*. Render a field instead (`{user.first}`), or
`{JSON.stringify(user)}` while debugging.

That "booleans render nothing" rule is what makes `{isAdmin && <AdminMenu />}` work: `false && …`
is `false`, which renders nothing. But **numbers are not booleans** — the next quiz shows the trap.

:::quiz id=fe-06-q4 xp=10
`messages` is an empty array. What appears on screen?

```tsx
<div>{messages.length && <p>You have {messages.length} messages</p>}</div>
```

- [ ] Nothing — the condition is falsy, so nothing renders
- [x] A lone `0`
- [ ] `false`
- [ ] React throws because `&&` returns a number
> `&&` returns its left side when it's falsy, so the expression evaluates to the **number** `0` — and
> numbers render as text. Only `null`, `undefined`, `true` and `false` render nothing, which is why
> "nothing" is the tempting wrong answer. Fix it by making the condition a real boolean:
> `{messages.length > 0 && <p>…</p>}`, or use a ternary `{messages.length ? <p>…</p> : null}`.
:::

:::quiz id=fe-06-q2 xp=15
Which of these are **valid** JSX expressions? (select all that apply)

- [x] `<label htmlFor="email">Email</label>`
- [ ] `<div>{if (ok) { 'yes' }}</div>`
- [x] `<p style={{ marginTop: 8 }}>{items.length} items</p>`
- [ ] `<input type="text">`
- [x] `<>{a}{b}</>`
> `if` is a statement, not an expression — use a ternary `{ok ? 'yes' : null}` or compute the value
> before `return`. `<input>` must be self-closed: `<input type="text" />`. The three valid ones:
> `htmlFor` is the JSX name for `for`; the style object is an expression in braces (a numeric value
> like `marginTop: 8` means `8px`), and `{items.length}` is an expression too; and a Fragment may
> hold any expressions.
:::

:::challenge id=fe-06-c1 lang=tsx xp=40 preview=SignupField
title: HTML to JSX
Convert this HTML into a `SignupField` component. Keep every attribute's meaning:

```html
<div class="field" style="margin-bottom: 12px">
  <label for="email">Email</label>
  <input id="email" type="email" placeholder="you@example.com" tabindex="1" required>
  <small class="hint" aria-live="polite">We never share it.</small>
  <button class="btn primary" disabled>Continue</button>
</div>
```

The tests check that the label is linked to the input, that every attribute (type, placeholder,
tabindex, required, classes, `aria-live`, disabled) survives, and that the wrapper has the class and
a `12px` bottom margin.

(The `tabindex="1"` is there only to practise the rename. In real code, positive `tabIndex` values
are an accessibility anti-pattern — they reorder keyboard navigation for the whole page. Use `0` or
leave it out.)

hint: `class` → `className`, `for` → `htmlFor`, `tabindex` → `tabIndex`.
hint: `style={{ marginBottom: 12 }}` — and close the `<input />`.
hint: Numbers go in braces: `tabIndex={1}`. Boolean attributes like `required` and `disabled` can stay bare.

```tsx starter
export function SignupField() {
  return null
}
```

```tsx solution
export function SignupField() {
  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" placeholder="you@example.com" tabIndex={1} required />
      <small className="hint" aria-live="polite">We never share it.</small>
      <button className="btn primary" disabled>Continue</button>
    </div>
  )
}
```

```tsx tests
test('label is linked to the input', () => {
  render(<SignupField />)
  const input = screen.getByLabelText('Email')
  expect(input).toHaveAttribute('type', 'email')
  expect(input).toHaveAttribute('placeholder', 'you@example.com')
  expect(input).toHaveAttribute('tabindex', '1')
  expect(input).toHaveAttribute('required')
})
test('classes and aria survive', () => {
  render(<SignupField />)
  expect(screen.getByText('We never share it.')).toHaveClass('hint')
  expect(screen.getByText('We never share it.')).toHaveAttribute('aria-live', 'polite')
  const btn = screen.getByRole('button', { name: 'Continue' })
  expect(btn).toHaveClass('btn', 'primary')
  expect(btn).toBeDisabled()
})
test('wrapper has class and inline style', () => {
  const { container } = render(<SignupField />)
  const wrapper = container.firstElementChild as HTMLElement
  expect(wrapper).toHaveClass('field')
  expect(wrapper.style.marginBottom).toBe('12px')
})
```
:::

## Components with inputs: a first look at props

Components become useful when they take inputs. Those inputs are **props**, passed like attributes
and received as the function's single object argument (usually destructured):

```tsx
function Price({ amount, currency }: { amount: number; currency: string }) {
  return <span className="price">{amount.toFixed(2)} {currency}</span>
}

<Price amount={19.9} currency="EUR" />   // strings can use quotes, everything else uses { }
```

The next lesson goes deep on props. For now: string props can be written in quotes; numbers,
booleans, objects, arrays and functions go in braces. A common slip is `amount="19.9"` — that passes
the *string* `"19.9"`, and `.toFixed` then fails at runtime (TypeScript catches it at compile time,
one more reason to type your props).

:::challenge id=fe-06-c2 lang=tsx xp=40 preview=Receipt
title: Expressions in JSX
Build `Receipt` for the `items` provided. It renders:

- an `<h2>` with the text `Receipt (3 items)` — the count comes from `items.length` (use `item` when there's exactly 1)
- a `<p>` with `Subtotal: 42.50 €` — sum of `price * qty`, two decimals
- a `<p>` with `VAT (20%): 8.50 €`
- a `<p className="total">` with `Total: 51.00 €`

`items` is defined for you in the setup block (3 items), so `Receipt` takes no props. VAT is 20% of
the subtotal, and the total is subtotal + VAT. Every amount is formatted with two decimals, followed
by a space and `€`. Compute values in normal JavaScript **before** the `return`, then drop them into
the JSX — that's the "logic above, markup below" shape almost every component has.

hint: `const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0)`
hint: Template literals in braces work: ``{`Subtotal: ${subtotal.toFixed(2)} €`}`` — or text and braces mixed: `Subtotal: {subtotal.toFixed(2)} €`.

```tsx setup
const items = [
  { name: 'Notebook', price: 4.5, qty: 3 },
  { name: 'Pen', price: 1.5, qty: 4 },
  { name: 'Backpack', price: 23, qty: 1 },
]
```

```tsx starter
export function Receipt() {
  return (
    <section>
      <h2>Receipt</h2>
    </section>
  )
}
```

```tsx solution
export function Receipt() {
  const count = items.length
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0)
  const vat = subtotal * 0.2
  return (
    <section>
      <h2>Receipt ({count} {count === 1 ? 'item' : 'items'})</h2>
      <p>Subtotal: {subtotal.toFixed(2)} €</p>
      <p>VAT (20%): {vat.toFixed(2)} €</p>
      <p className="total">Total: {(subtotal + vat).toFixed(2)} €</p>
    </section>
  )
}
```

```tsx tests
test('heading shows the item count', () => {
  render(<Receipt />)
  expect(screen.getByRole('heading')).toHaveTextContent('Receipt (3 items)')
})
test('subtotal and VAT', () => {
  render(<Receipt />)
  expect(screen.getByText('Subtotal: 42.50 €')).toBeInTheDocument()
  expect(screen.getByText('VAT (20%): 8.50 €')).toBeInTheDocument()
})
test('total has its class', () => {
  render(<Receipt />)
  expect(screen.getByText('Total: 51.00 €')).toHaveClass('total')
})
```
:::

## How React renders: trigger → render → commit

Understanding this loop explains most "why did that happen?" questions later:

1. **Trigger.** Something asks for a render: the initial `root.render(<App />)`, or a state update (`setCount`).
2. **Render.** React **calls your component functions** to get fresh JSX. For the initial render, all
   of them; afterwards, the component whose state changed **and everything below it in the tree**
   (unless a child is memoised — a later optimisation topic). While rendering, React compares
   (*reconciles*) the new element tree with the previous one to work out what changed.
3. **Commit.** React applies only the **minimal DOM changes** it found — updating a text node,
   flipping an attribute, inserting a row. Unchanged DOM is left alone, which is why your input keeps
   focus and scroll position.

"Rendering" in React-speak means *calling your function*, not touching the DOM. A component may
render many times without any DOM change — so "my component re-rendered" is not, by itself, a
performance problem.

An analogy: rendering is a chef writing a new order ticket; committing is the waiter changing only
the dishes on the table that differ from the ticket.

### Components must be pure

Because React may call your component whenever it likes (and in development, **twice**), the
function body must be **pure**: same props/state in → same JSX out, no side effects. A **side
effect** is anything that changes the world outside the function: modifying a variable or object
that existed before the call, touching the DOM directly, sending a request, writing to
`localStorage`. Purity is what lets React re-render, pause or throw away a render safely.

```tsx
let renders = 0
function Bad({ items }: { items: string[] }) {
  renders++                       // ❌ mutating something outside during render
  document.title = 'Hi'           // ❌ side effect during render (use an effect)
  items.sort()                    // ❌ sorts the PARENT's array in place — props are read-only
  return <p>Rendered {renders} times</p>
}

function Good({ items }: { items: string[] }) {
  const sorted = items.toSorted()   // ✅ sorted copy — ES2023: needs "ES2023" in tsconfig lib; [...items].sort() works everywhere
  return <ul>{sorted.map((i) => <li key={i}>{i}</li>)}</ul>
}
```

Local variables you create *during* the render are fine to mutate — they're brand new on every
call. The rule is about things that outlive the call: props, state, module-level variables, the DOM.

Side effects belong in **event handlers** (in response to a user action) or **effects**
(synchronising with something outside React) — both covered in later lessons.

:::info title="Strict Mode renders twice — on purpose"
`<StrictMode>` (on by default in the Vite template's `main.tsx`) makes React call each component
function twice in development and throw away one result. A pure component doesn't care; an impure
one shows visible weirdness (counts that jump by 2, duplicated list items). It's a cheap impurity
detector, and it does nothing in production builds. (It also runs effects mount → cleanup → mount
once in development — you'll see why in the effects lesson.)
:::

:::quiz id=fe-06-q3 xp=15
In development with `<StrictMode>`, the app renders `<Clock />` once. What does the console show?

```tsx
function Clock() {
  console.log('render Clock')
  return <time>{new Date().toLocaleTimeString()}</time>
}
```

- [ ] `render Clock` once
- [x] `render Clock` twice (the second one may appear greyed out)
- [ ] Nothing — `console.log` is a side effect and is blocked
> Strict Mode double-invokes component functions in development to surface impure rendering, and
> modern React doesn't hide the second call's logs (with React DevTools installed they're dimmed, and
> DevTools has a setting to hide them). "Once" is what you'd see in a production build. React never blocks `console.log` — logging during render
> is harmless for debugging, even though it's technically a side effect. (Reading the current time is
> impure too — two renders a millisecond apart can differ. For a clock you'd keep the time in state
> and update it from an effect.)
:::

:::quiz id=fe-06-q5 xp=15
Spot the bug. After every single letter typed into the search box, the box loses focus and the
user has to click back into it. Why?

```tsx
function ProductPage() {
  const [query, setQuery] = useState('')

  function SearchBox() {
    return <input value={query} onChange={(e) => setQuery(e.target.value)} />
  }

  return <SearchBox />
}
```

- [x] `SearchBox` is defined inside `ProductPage`, so every render creates a new component type and React replaces the input with a fresh one
- [ ] `useState` can't be used together with an `<input>`
- [ ] The input needs a `key` prop so React can find it again
- [ ] `onChange` fires only on blur, so the state is updated too late
> Typing calls `setQuery`, which re-renders `ProductPage`. That render creates a **new** `SearchBox`
> function — a different component type from last time — so React unmounts the old input (losing
> focus) and mounts a brand-new one. Any state *inside* `SearchBox` would be wiped too. Move `SearchBox` to the top level and pass `query` and
> `setQuery` as props, or just inline the `<input>`. A `key` doesn't help: keys distinguish siblings
> of the *same* type, and here the type itself changes. React's `onChange` fires on every keystroke
> (unlike the DOM's `change` event), and controlled inputs with `useState` are the standard pattern.
:::

:::quiz id=fe-06-q6 xp=10
`count` is `4` and the user clicks a button that calls `setCount(5)`. React re-renders `Counter`,
whose JSX is `<div className="counter"><h2>Score</h2><p>{count}</p></div>`. What does
the **commit** phase change in the DOM?

- [ ] It rebuilds the whole `<div>` with its `<h2>` and `<p>` from scratch
- [x] Only the text inside the `<p>` (from `4` to `5`)
- [ ] Nothing — the commit phase only runs on the initial render
- [ ] It re-renders every component in the app
> During render, React reconciles the new element tree with the previous one and finds a single
> difference: the `<p>`'s text. Commit applies just that change; the `<div>` and `<h2>` DOM nodes are
> reused untouched. Rebuilding everything is what naive `innerHTML` code would do — avoiding it is
> React's whole job. Commit follows every render, not only the first; when nothing differs it simply
> makes no DOM changes. And re-rendering happens to `Counter` and its subtree, not the entire app —
> besides, *rendering* (calling functions) is a different phase from *committing* (touching the DOM).
:::

:::challenge id=fe-06-c3 lang=tsx xp=30 preview=App
title: Bug hunt — lowercase component
The badge never shows up. Find out why and fix it so the page shows a `<span className="badge">New</span>`
next to the title. (Look at how JSX decides between DOM tags and components.)

hint: JSX treats `<badge />` as the HTML tag `"badge"`, not your function. (Open the console: React warns that the tag is unrecognised.)
hint: Rename the component to `Badge` and use `<Badge />`.

```tsx starter
function badge() {
  return <span className="badge">New</span>
}

export function App() {
  return (
    <h1>
      Mechanical keyboard <badge />
    </h1>
  )
}
```

```tsx solution
function Badge() {
  return <span className="badge">New</span>
}

export function App() {
  return (
    <h1>
      Mechanical keyboard <Badge />
    </h1>
  )
}
```

```tsx tests
test('renders the badge span', () => {
  render(<App />)
  const badgeEl = screen.getByText('New')
  expect(badgeEl.tagName).toBe('SPAN')
  expect(badgeEl).toHaveClass('badge')
})
test('heading contains title and badge', () => {
  render(<App />)
  expect(screen.getByRole('heading')).toHaveTextContent('Mechanical keyboard New')
})
```
:::

:::challenge id=fe-06-c4 lang=tsx xp=40 preview=App
title: Fragments and composition
Build a small page out of components:

- `StatCells` returns **two** `<td>` siblings (no wrapper element — a `<div>` inside a `<tr>` is invalid HTML): the first with the label, the second with the value. It takes props `{ label: string; value: number }`.
- `App` renders a `<table>` with a `<tbody>` and two rows: `Orders` / `12` and `Revenue` / `840`, each row being `<tr><StatCells … /></tr>`.

hint: `return <><td>{label}</td><td>{value}</td></>`

```tsx starter
export function StatCells({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <td>{label}</td>
      <td>{value}</td>
    </div>
  )
}

export function App() {
  return <table></table>
}
```

```tsx solution
export function StatCells({ label, value }: { label: string; value: number }) {
  return (
    <>
      <td>{label}</td>
      <td>{value}</td>
    </>
  )
}

export function App() {
  return (
    <table>
      <tbody>
        <tr><StatCells label="Orders" value={12} /></tr>
        <tr><StatCells label="Revenue" value={840} /></tr>
      </tbody>
    </table>
  )
}
```

```tsx tests
test('two rows', () => {
  render(<App />)
  expect(screen.getAllByRole('row')).toHaveLength(2)
})
test('cells are direct children of the row', () => {
  render(<App />)
  const rows = screen.getAllByRole('row')
  expect(Array.from(rows[0].children).map((c) => c.tagName)).toEqual(['TD', 'TD'])
  expect(rows[1].children[1]).toHaveTextContent('840')
})
test('labels', () => {
  render(<App />)
  expect(screen.getByText('Orders')).toBeInTheDocument()
  expect(screen.getByText('Revenue')).toBeInTheDocument()
})
```
:::

:::job title="Component conventions you'll see at work"
- One component per file for anything non-trivial, file named like the component (`OrderTable.tsx`).
- Named exports (`export function OrderTable`), co-located styles (`OrderTable.module.css`) and tests (`OrderTable.test.tsx`).
- Small components: if a JSX block needs a comment explaining what it is, it probably wants to be its own component with that name.
- Styling varies by team: CSS Modules, Tailwind (`className="px-4 py-2"`), or CSS-in-JS. `className` + a CSS file is the baseline that all of them build on.
:::

:::pro title="Think in trees"
Before writing JSX, sketch the UI as boxes and name each box — that's your component tree. Then
ask, for each piece of data, *which component owns it?* Seniors spend most of their design time on
that second question; the JSX is the easy part.
:::

:::cards id=fe-06-cards1 xp=15 title="Components & JSX"
Q: What does JSX compile to?
A: Function calls (`jsx('div', props)` / `React.createElement`) that return plain-object React elements.
Q: Why must component names be capitalised?
A: JSX treats lowercase tags as DOM element strings (`'div'`) and capitalised ones as variables (your component).
Q: How do you return siblings without an extra DOM node?
A: A Fragment: `<>…</>` (or `<Fragment key=…>` when you need a key).
Q: `class` and `for` in JSX?
A: `className` and `htmlFor`.
Q: What can go inside `{ }` in JSX?
A: Any expression (values, calls, ternaries) — not statements like `if` or `for`.
Q: What do `null`, `undefined`, `false` render?
A: Nothing.
Q: What does "render" mean in React?
A: React calling your component function to get JSX. The commit phase then applies the minimal DOM changes.
Q: Why does Strict Mode call components twice in dev?
A: To expose impure rendering (side effects or mutations during render). No effect in production.
Q: Why does `{list.length && <List />}` sometimes show `0`?
A: `&&` returns the falsy left side, and the number `0` renders as text. Use `list.length > 0 && …`.
Q: Why never define a component inside another component?
A: Each render creates a new function = a new component type, so React remounts it and loses its DOM, focus and state.
:::

## Recap

- Components are capitalised functions returning JSX; define them at the top level.
- JSX compiles to function calls producing plain-object elements — a description, not DOM.
- JSX rules: one root (or a Fragment), close all tags, camelCase attributes, `className`/`htmlFor`, style objects, expressions in braces.
- React's loop: trigger → render (call your functions) → commit (minimal DOM changes).
- `null`/`undefined`/booleans render nothing, but `0` renders — keep `&&` conditions boolean.
- Rendering must be pure (never mutate props, state or outside variables); side effects go in event handlers or effects. Strict Mode double-renders in dev to catch impurity.
