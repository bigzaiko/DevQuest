---
id: fe-07
title: Props & Composition
level: beginner
minutes: 40
xp: 120
summary: Passing and typing props, defaults, children and slots, composition over configuration, lifting state up, and a first look at prop drilling.
---

A component on its own is a fixed piece of UI. To make it **reusable** — one `Avatar` for every
user, one `Button` for every action — it needs inputs. Those inputs are **props** (short for
*properties*): a parent passes data **down** to a child, and the child renders it.

Props are to components what arguments are to functions — and that's almost literally what they
are: React collects the JSX attributes into one object and calls your function with it.

## Passing and reading props

```tsx
function Avatar({ src, name, size }: { src: string; name: string; size: number }) {
  return <img className="avatar" src={src} alt={name} width={size} height={size} />
}

function Comment() {
  return (
    <article>
      <Avatar src="/ada.png" name="Ada Lovelace" size={48} />
      <p>Great article!</p>
    </article>
  )
}
```

When React renders `<Avatar src="/ada.png" name="Ada Lovelace" size={48} />`, it calls
`Avatar({ src: '/ada.png', name: 'Ada Lovelace', size: 48 })` for you. (You never call a component
yourself — the JSX only *describes* the call; React decides when to make it.)

A few details that trip people up:

- **Strings** can use quotes (`name="Ada"`); **everything else** needs braces: numbers
  (`size={48}`), booleans (`disabled={false}`), objects, arrays, functions. `size="48"` passes the
  *string* `"48"`, which TypeScript will reject if the prop is typed `number`.
- A bare attribute is `true`: `<Input required />` is the same as `<Input required={true} />`.
- Destructuring in the parameter list (`{ src, name, size }`) is just JavaScript. You could also
  write `function Avatar(props)` and use `props.src` — destructuring is the common style because the
  signature then shows exactly which props the component uses.
- `key` is **not** a prop: React consumes it and the component never sees it. In React 19 `ref`,
  on the other hand, **is** a normal prop for function components (no more `forwardRef`).

### Typing props

Give the props object a named type. It documents the component's API and makes every call site
checked and autocompleted:

```tsx
type ButtonProps = {
  label: string
  variant?: 'primary' | 'secondary' | 'danger'   // optional, literal union
  disabled?: boolean
  onClick: () => void                           // a callback prop
}

export function Button({ label, variant = 'primary', disabled = false, onClick }: ButtonProps) {
  return (
    <button className={`btn btn-${variant}`} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  )
}
```

A `?` makes a prop optional, so callers may leave it out. A **literal union**
(`'primary' | 'secondary' | 'danger'`) is better than `string`: a typo like `variant="primay"` becomes
a compile error instead of a silently unstyled button.

**Defaults** use destructuring defaults (`variant = 'primary'`). They apply when the prop is
missing or `undefined` — not when it's `null`, `0` or `''`, because those are real values the caller
chose to pass. (The old `Component.defaultProps` was removed for function components in React 19;
destructuring defaults are the only way now.)

To accept all the normal attributes of a DOM element (so callers can pass `type`, `aria-*`,
`onBlur`, `data-testid`…) without re-declaring dozens of props, combine the built-in type with your
own and **spread the rest** onto the element:

```tsx
import type { ComponentProps } from 'react'

type IconButtonProps = ComponentProps<'button'> & { icon: string }

function IconButton({ icon, children, ...rest }: IconButtonProps) {
  return (
    <button {...rest}>
      <span aria-hidden="true">{icon}</span> {children}
    </button>
  )
}

<IconButton icon="🗑" type="button" aria-describedby="hint" onClick={remove}>Delete</IconButton>
```

`ComponentProps<'button'>` is "every prop a `<button>` accepts" (it includes `children` and, in
React 19, `ref`). `...rest` collects whatever you didn't destructure, and `{...rest}` forwards it.

:::warn title="Spread order matters"
Later attributes win. `<button className="btn" {...rest}>` lets a caller's `className` **replace**
yours; `<button {...rest} className="btn">` silently **ignores** theirs. For classes, take
`className` out of the rest and merge it explicitly:
`function IconButton({ icon, className, ...rest })` →
`className={['btn', className].filter(Boolean).join(' ')}`.
:::

### Props are read-only

A component must **never modify its props**. They belong to the parent; mutating them breaks the
"same input → same output" contract and React won't re-render because of it anyway. If a value needs
to change over time, it's **state** (next lesson) — owned by some component, passed down as props.

The sneaky version is mutating something *inside* a prop. Arrays and objects are passed by
reference, so this changes the parent's data too:

```tsx
function Leaderboard({ players }: { players: Player[] }) {
  players.sort((a, b) => b.score - a.score)            // ❌ sorts the parent's array in place
  const ranked = players.toSorted((a, b) => b.score - a.score)  // ✅ new array, props untouched
  // …
}
```

:::quiz id=fe-07-q1 xp=10
`<Badge count={0} label={null} />` is rendered. Given
`function Badge({ count = 5, label = 'New' })`, what are `count` and `label` inside the component?

- [ ] `5` and `'New'`
- [x] `0` and `null`
- [ ] `0` and `'New'`
- [ ] `5` and `null`
> Destructuring defaults only kick in for `undefined` (including a prop that was left out). `0` and
> `null` are real values the caller passed, so the tempting `0` and `'New'` is wrong: `null` does
> **not** trigger the default. If you want `null` to fall back too, use `label ?? 'New'` in the body.
:::

:::quiz id=fe-07-q4 xp=10
Spot the bug. The parent passes its `players` array down; after `Leaderboard` renders, the parent's
"sorted by join date" list is suddenly sorted by score too.

```tsx
function Leaderboard({ players }: { players: Player[] }) {
  const ranked = players.sort((a, b) => b.score - a.score)
  return <ol>{ranked.map((p) => <li key={p.id}>{p.name}</li>)}</ol>
}
```

- [ ] `sort` needs a `key` per item to work in React
- [x] `sort` reorders the array **in place**, so it mutates the parent's data; use `toSorted` (or `[...players].sort`)
- [ ] Props are copied when passed, so the parent can't be affected — the bug must be elsewhere
- [ ] The comparator is reversed
> Props are read-only, but JavaScript won't stop you: objects and arrays are passed **by
> reference**, so `players.sort` changes the very array the parent owns. Props are *not* deep-copied
> — that's why the third option is wrong. `toSorted` returns a new array and leaves the input alone.
:::

:::challenge id=fe-07-c1 lang=tsx xp=40 preview=Demo
title: A typed Tag component
Write `Tag` with props `{ label: string; tone?: 'neutral' | 'success' | 'danger'; onRemove?: () => void }`:

- renders a `<span>` with classes `tag` and `tag-<tone>` (default tone `neutral`) containing the label
- if `onRemove` is given, also render a `<button>` inside the span with `aria-label="Remove <label>"`
  and text `×` that calls `onRemove` when clicked; if not given, no button

`Demo` is already written to show it off.

hint: ``className={`tag tag-${tone}`}``
hint: ``{onRemove && <button aria-label={`Remove ${label}`} onClick={onRemove}>×</button>}``

```tsx starter
type TagProps = { label: string; tone?: 'neutral' | 'success' | 'danger'; onRemove?: () => void }

export function Tag({ label }: TagProps) {
  return <span>{label}</span>
}

export function Demo() {
  return (
    <p>
      <Tag label="draft" /> <Tag label="paid" tone="success" /> <Tag label="overdue" tone="danger" onRemove={() => alert('removed')} />
    </p>
  )
}
```

```tsx solution
type TagProps = { label: string; tone?: 'neutral' | 'success' | 'danger'; onRemove?: () => void }

export function Tag({ label, tone = 'neutral', onRemove }: TagProps) {
  return (
    <span className={`tag tag-${tone}`}>
      {label}
      {onRemove && (
        <button aria-label={`Remove ${label}`} onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  )
}

export function Demo() {
  return (
    <p>
      <Tag label="draft" /> <Tag label="paid" tone="success" /> <Tag label="overdue" tone="danger" onRemove={() => alert('removed')} />
    </p>
  )
}
```

```tsx tests
test('default tone is neutral', () => {
  render(<Tag label="draft" />)
  const el = screen.getByText('draft')
  expect(el).toHaveClass('tag', 'tag-neutral')
})
test('tone class', () => {
  render(<Tag label="paid" tone="success" />)
  expect(screen.getByText('paid')).toHaveClass('tag-success')
})
test('no remove button without onRemove', () => {
  render(<Tag label="draft" />)
  expect(screen.queryByRole('button')).toBeNull()
})
test('remove button calls onRemove', async () => {
  const onRemove = fn()
  render(<Tag label="overdue" tone="danger" onRemove={onRemove} />)
  await user.click(screen.getByRole('button', { name: 'Remove overdue' }))
  expect(onRemove).toHaveBeenCalledTimes(1)
})
```
:::

## `children`: components that wrap other components

Whatever you put **between** a component's tags arrives as the special `children` prop:

```tsx
import type { ReactNode } from 'react'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="card-body">{children}</div>
    </section>
  )
}

<Card title="Shipping">
  <p>Free over 50 €.</p>
  <a href="/shipping">Details</a>
</Card>
```

`children` isn't magic — `<Card title="Shipping">…</Card>` is shorthand for passing a prop called
`children` whose value is the JSX in between. If nothing is in between, `children` is `undefined`.

`ReactNode` is the type of "anything renderable": elements, strings, numbers, arrays of those,
`null`, `undefined`, booleans. Use it for `children` and other content props. (`ReactElement` is
narrower — only JSX elements, no strings — and rarely what you want for `children`. There's also a
helper, `PropsWithChildren<{ title: string }>`, that adds an optional `children?: ReactNode` for you.)

`Card` doesn't know or care what's inside it. That's the point: one `Card` for every use, instead
of a `Card` that knows about shipping, payments and reviews.

### Slots: more than one "children"

`children` is one hole. When a component has several holes — a layout with a header, a sidebar
and a main area — pass JSX through named props, often called **slots**. A slot prop is typed
`ReactNode` just like `children`:

```tsx
function PageLayout({ header, sidebar, children }: { header: ReactNode; sidebar?: ReactNode; children: ReactNode }) {
  return (
    <div className="layout">
      <header>{header}</header>
      {sidebar && <aside>{sidebar}</aside>}
      <main>{children}</main>
    </div>
  )
}

<PageLayout header={<Logo />} sidebar={<Filters />}>
  <ProductGrid />
</PageLayout>
```

`PageLayout` owns the *structure* (where things go, the CSS grid), while the caller owns the
*content*. If you know Angular's `<ng-content select>` or Vue's named slots, this is the same idea —
in React, it's just props.

## Composition over configuration

Here's how reusable components rot. Version 1 is fine:

```tsx
<Modal title="Delete order?" />
```

Then someone needs an icon: `showIcon`. Then a subtitle: `subtitle`. Then two buttons, then a
danger style, then a footer link, then "hide the close button on this one page"…

```tsx
<Modal title="Delete order?" subtitle="This can't be undone" showIcon iconType="warning"
       primaryLabel="Delete" secondaryLabel="Cancel" danger hideClose footerLink="/help" />
```

Every new need adds a prop and an `if` inside `Modal`. This is **configuration**. The alternative
is **composition** — small pieces the caller assembles:

```tsx
<Modal onClose={close}>
  <Modal.Header icon={<WarningIcon />}>Delete order?</Modal.Header>
  <p>This can't be undone.</p>
  <Modal.Footer>
    <Button variant="secondary" onClick={close}>Cancel</Button>
    <Button variant="danger" onClick={remove}>Delete</Button>
  </Modal.Footer>
</Modal>
```

`Modal` now handles only what's truly shared (overlay, focus trap, Escape to close); the caller
decides the content. New needs usually require **no change to `Modal` at all**. Component libraries
like Radix UI and shadcn/ui are built this way.

`Modal.Header` is nothing fancy: it's an ordinary component attached as a property of the `Modal`
function (`Modal.Header = ModalHeader`), so related pieces travel together. This style is called
**compound components**; you'll build one properly in the UI Forge lessons.

Composition isn't always the answer. A `Button` with a `variant` union is perfectly fine — reach
for composition when the **content and layout** keep varying, not for every small style switch.

:::quiz id=fe-07-q2 xp=10
A `<Card>` component has grown props `showImage`, `imageUrl`, `imagePosition`, `showFooter`,
`footerText`, `footerButtonLabel`… What's the usual refactor?

- [ ] Add a `config` object prop to group them
- [x] Accept `children` (and maybe a few slot props) and let callers compose `<img>`, footers and buttons themselves
- [ ] Split it into `CardWithImage`, `CardWithFooter`, `CardWithImageAndFooter`
> Composition moves the variable parts (image, footer, buttons) to the caller, so `Card` only keeps
> what's truly shared — its frame and spacing. Grouping the props into a `config` object is tempting
> because it *looks* tidier, but it's the same number of options and `if`s, just harder to
> autocomplete. Splitting into variants explodes combinatorially (every new option doubles the
> count).
:::

:::challenge id=fe-07-c2 lang=tsx xp=40 preview=Demo
title: A composable Panel
Write `Panel` with props `{ title: ReactNode; actions?: ReactNode; children: ReactNode }`:

- a `<section>` with `aria-label` equal to the title **if the title is a string** (so it's an accessible region)
- inside: a `<header>` containing an `<h2>` with the title, and — only if given — a `<div className="actions">` with the actions
- then a `<div className="panel-body">` with the children

hint: `aria-label={typeof title === 'string' ? title : undefined}`
hint: `{actions && <div className="actions">{actions}</div>}`

```tsx starter
import type { ReactNode } from 'react'

type PanelProps = { title: ReactNode; actions?: ReactNode; children: ReactNode }

export function Panel({ title }: PanelProps) {
  return <section><h2>{title}</h2></section>
}

export function Demo() {
  return (
    <Panel title="Recent orders" actions={<button>Export</button>}>
      <p>No orders yet.</p>
    </Panel>
  )
}
```

```tsx solution
import type { ReactNode } from 'react'

type PanelProps = { title: ReactNode; actions?: ReactNode; children: ReactNode }

export function Panel({ title, actions, children }: PanelProps) {
  return (
    <section aria-label={typeof title === 'string' ? title : undefined}>
      <header>
        <h2>{title}</h2>
        {actions && <div className="actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Demo() {
  return (
    <Panel title="Recent orders" actions={<button>Export</button>}>
      <p>No orders yet.</p>
    </Panel>
  )
}
```

```tsx tests
test('renders title, actions and children', () => {
  render(<Panel title="Recent orders" actions={<button>Export</button>}><p>No orders yet.</p></Panel>)
  expect(screen.getByRole('heading', { name: 'Recent orders' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Export' }).parentElement).toHaveClass('actions')
  expect(screen.getByText('No orders yet.').parentElement).toHaveClass('panel-body')
})
test('string title makes a named region', () => {
  render(<Panel title="Stats"><p>42</p></Panel>)
  expect(screen.getByRole('region', { name: 'Stats' })).toBeInTheDocument()
})
test('no actions wrapper when no actions', () => {
  const { container } = render(<Panel title="Stats"><p>42</p></Panel>)
  expect(container.querySelector('.actions')).toBeNull()
})
test('JSX titles work too', () => {
  render(<Panel title={<em>Fancy</em>}><p>x</p></Panel>)
  expect(screen.getByText('Fancy').tagName).toBe('EM')
})
```
:::

## Data down, events up

Props flow one way: **down**. That's deliberate — when something looks wrong on screen, you only
have to look *up* the tree to find who supplied the data. So how does a child tell its parent
something happened? The parent passes a **function** as a prop, and the child calls it. (The example
uses `useState`, which the next lesson covers in depth — for now: `query` is a value that can change,
and `setQuery` changes it and re-renders.)

```tsx
function SearchBox({ onSearch }: { onSearch: (query: string) => void }) {
  return <input type="search" onChange={(e) => onSearch(e.target.value)} />
}

function ProductsPage() {
  const [query, setQuery] = useState('')
  return (
    <>
      <SearchBox onSearch={setQuery} />
      <ProductList query={query} />
    </>
  )
}
```

The child doesn't know *what* the parent will do with the query — filter a list, call an API,
update the URL. It just reports the event. That's what makes `SearchBox` reusable.

Naming convention: the prop is `onSomething` (`onSearch`, `onSelect`, `onChange`); the parent's
function that handles it is `handleSomething`. (Above, the parent passes `setQuery` directly
because there's nothing else to do; as soon as it needs extra logic, write
`function handleSearch(q: string) { … }` and pass `onSearch={handleSearch}`.)

Type callback props with exactly the arguments the child will provide: `onSearch: (query: string) => void`.

## Lifting state up

When two components need the **same** changing data, the data can't live in either of them —
siblings can't see each other's state. Move it to their **closest common parent** and pass it
down. That's called *lifting state up*.

Classic example: an accordion where only one panel is open at a time. If each panel kept its own
`isOpen`, they couldn't coordinate. Lift the "which one is open" state to the accordion:

```tsx
function Accordion() {
  const [openId, setOpenId] = useState<string | null>('shipping')
  return (
    <>
      <Section title="Shipping" isOpen={openId === 'shipping'} onToggle={() => setOpenId(openId === 'shipping' ? null : 'shipping')}>…</Section>
      <Section title="Returns"  isOpen={openId === 'returns'}  onToggle={() => setOpenId(openId === 'returns' ? null : 'returns')}>…</Section>
    </>
  )
}
```

`Section` is now a **controlled** component: it doesn't own its open state, it just displays
`isOpen` and reports clicks through `onToggle`. Its opposite is an **uncontrolled** component, which
keeps the state inside itself (like the starter of the next challenge). Controlled = the parent is
in charge; uncontrolled = the component is in charge. One source of truth, no syncing.

The common mistake is trying to *keep* the state in both places — each `Section` has its own
`isOpen` and the parent tries to "tell" them to close via effects. That always drifts out of sync.
Move the state up, delete it from the children.

:::challenge id=fe-07-c3 lang=tsx xp=50 preview=Faq
title: Lift the state — an FAQ accordion
Right now each `Question` keeps its own `open` state, so several can be open at once. Change it so
**at most one** answer is visible:

- `Question` becomes controlled: props `{ q: string; children: ReactNode; isOpen: boolean; onToggle: () => void }`
- `Faq` owns `openIndex` (`number | null`, initially `null`); clicking an open question closes it
- keep the markup: a `<button aria-expanded=…>` with the question text, and the answer in a `<p>` rendered only when open

hint: In `Faq`: `const [openIndex, setOpenIndex] = useState<number | null>(null)`
hint: `onToggle={() => setOpenIndex(openIndex === i ? null : i)}`

```tsx starter
import { useState, type ReactNode } from 'react'

const faqs = [
  { q: 'How long is shipping?', a: '2–4 business days.' },
  { q: 'Can I return items?', a: 'Yes, within 30 days.' },
  { q: 'Do you ship abroad?', a: 'To the EU and UK.' },
]

function Question({ q, children }: { q: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button aria-expanded={open} onClick={() => setOpen(!open)}>{q}</button>
      {open && <p>{children}</p>}
    </div>
  )
}

export function Faq() {
  return (
    <div>
      {faqs.map((f) => (
        <Question key={f.q} q={f.q}>{f.a}</Question>
      ))}
    </div>
  )
}
```

```tsx solution
import { useState, type ReactNode } from 'react'

const faqs = [
  { q: 'How long is shipping?', a: '2–4 business days.' },
  { q: 'Can I return items?', a: 'Yes, within 30 days.' },
  { q: 'Do you ship abroad?', a: 'To the EU and UK.' },
]

function Question({ q, children, isOpen, onToggle }: { q: string; children: ReactNode; isOpen: boolean; onToggle: () => void }) {
  return (
    <div>
      <button aria-expanded={isOpen} onClick={onToggle}>{q}</button>
      {isOpen && <p>{children}</p>}
    </div>
  )
}

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  return (
    <div>
      {faqs.map((f, i) => (
        <Question key={f.q} q={f.q} isOpen={openIndex === i} onToggle={() => setOpenIndex(openIndex === i ? null : i)}>
          {f.a}
        </Question>
      ))}
    </div>
  )
}
```

```tsx tests
test('all closed initially', () => {
  render(<Faq />)
  expect(screen.queryByText('2–4 business days.')).toBeNull()
  expect(screen.getByRole('button', { name: 'How long is shipping?' })).toHaveAttribute('aria-expanded', 'false')
})
test('opening one closes the other', async () => {
  render(<Faq />)
  await user.click(screen.getByRole('button', { name: 'How long is shipping?' }))
  expect(screen.getByText('2–4 business days.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Can I return items?' }))
  expect(screen.getByText('Yes, within 30 days.')).toBeInTheDocument()
  expect(screen.queryByText('2–4 business days.')).toBeNull()
  expect(screen.getByRole('button', { name: 'How long is shipping?' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByRole('button', { name: 'Can I return items?' })).toHaveAttribute('aria-expanded', 'true')
})
test('clicking the open one closes it', async () => {
  render(<Faq />)
  const b = screen.getByRole('button', { name: 'Do you ship abroad?' })
  await user.click(b)
  await user.click(b)
  expect(screen.queryByText('To the EU and UK.')).toBeNull()
})
```
:::

## Prop drilling (a preview)

Lifting state up has a cost. If the state lives high up and a component deep down needs it, every
component in between must accept and forward the prop, even though it doesn't use it:

```tsx
<App>                           // owns user (useState)
  <Layout user={user}>          // doesn't use it, just passes it on
    <Sidebar user={user}>       // doesn't use it either
      <UserMenu user={user} />  // finally uses it
```

That's **prop drilling**. Two or three levels is fine — explicit data flow is easy to follow. Deeper
than that, there are better tools, coming in later lessons:

- **Composition**: pass the finished element instead of the data — `<Layout sidebar={<UserMenu user={user} />}>`. The middle layers just render a slot and never see `user`.
- **Context** (`createContext` + `use`/`useContext`) for app-wide values: current user, theme, locale. (Context & reducers lesson.)
- **State libraries / server-state caches** (Zustand, TanStack Query) for shared data. (Server state lesson.)

Try composition first: it costs nothing and keeps the data flow explicit. Context is great for
truly global values but makes every consumer depend on a provider being somewhere above it.

:::quiz id=fe-07-q3 xp=10
Two sibling components, `CartIcon` (shows the item count) and `ProductList` (has "Add to cart"
buttons), both need the cart. Where should the cart state live?

- [ ] In `ProductList`, and `CartIcon` reads it from there
- [ ] In both, kept in sync with effects
- [x] In their closest common parent, passed down as props (or in context if the parent is far away)
- [ ] In a global variable
> Siblings can't read each other's state. Lift it to the common parent: the count goes down to
> `CartIcon`, an `onAdd` callback goes down to `ProductList`. Keeping it in `ProductList` is tempting,
> but data only flows down, so `CartIcon` has no way to read it. Syncing two copies with effects is a
> classic source of bugs; a module-level variable won't trigger re-renders.
:::

:::quiz id=fe-07-q5 xp=10
`App` owns `user`. `Layout` and `Sidebar` only forward it to `UserMenu`. You change it to:

```tsx
<Layout sidebar={<Sidebar menu={<UserMenu user={user} />} />} />
```

What did that buy you?

- [x] `Layout` and `Sidebar` no longer need a `user` prop at all — they render the slot they're given
- [ ] `UserMenu` now reads `user` from context automatically
- [ ] `user` is now global, so any component can use it
- [ ] Nothing — it's the same prop drilling with different syntax
> This is composition as a drilling fix: `App` builds the finished `<UserMenu user={user} />` itself
> and hands it down as a ready-made element. The middle layers just render `{menu}` / `{sidebar}`
> and never mention `user`, so you can change `UserMenu`'s props without touching them. No context
> is involved and nothing becomes global — `user` still flows explicitly from `App`.
:::

:::quiz id=fe-07-q6 xp=10
What happens here?

```tsx
function Row({ key, label }: { key: string; label: string }) {
  return <li data-id={key}>{label}</li>
}
// …
items.map((i) => <Row key={i.id} label={i.label} />)
```

- [ ] `data-id` gets the item's id
- [x] `key` inside `Row` is `undefined` — React keeps `key` for itself; pass the id again under another name (e.g. `id={i.id}`)
- [ ] React throws because `key` is a reserved word in JavaScript
> `key` is special: React uses it to identify list items and **does not pass it to the
> component** (it even warns if you try to read it). It's not a reserved JavaScript word, so nothing
> throws. If the child needs the id, pass it as a separate prop.
:::

:::job title="Props on a real team"
- Every component has a `type XxxProps` right above it, and reviewers ask for literal unions over `string` (`variant: 'primary' | 'ghost'`).
- Design-system components (`Button`, `Input`) accept `ComponentProps<'button'>` and forward the rest with `{...rest}`, so `aria-*`, `type` and `data-testid` just work.
- Boolean prop soup (`isSmall isPrimary isRounded`) is a review comment waiting to happen — use a variant union or composition.
:::

:::pro title="Keep components dumb when you can"
Many teams separate **presentational** components (props in, JSX out, no data fetching) from
**container** components or hooks that own the data. Presentational components are trivially
reusable, easy to test, and easy to show in Storybook. This isn't a hard rule — it's a gradient you
lean towards.
:::

:::cards id=fe-07-cards1 xp=15 title="Props & composition"
Q: What are props?
A: The single object argument React passes to a component, built from the JSX attributes. Read-only.
Q: How do you give a prop a default?
A: Destructuring default: `function Button({ variant = 'primary' })`. Applies only to `undefined`.
Q: What type is `children` usually?
A: `ReactNode` — anything renderable.
Q: What is a slot prop?
A: A prop that takes JSX (`header={<Logo />}`) — like a named `children`.
Q: Composition vs configuration?
A: Let callers assemble small pieces (children/slots) instead of adding a prop + `if` for every variation.
Q: How does a child notify its parent?
A: The parent passes a callback prop (`onChange`, `onSelect`); the child calls it.
Q: What is lifting state up?
A: Moving state to the closest common parent of the components that need it, then passing it down.
Q: What is prop drilling, and two remedies?
A: Passing props through layers that don't use them. Fix with composition (pass elements) or context.
Q: Controlled vs uncontrolled component?
A: Controlled: the parent owns the value and passes it in (plus a callback). Uncontrolled: the component keeps the value in its own state.
Q: Can a component read `props.key`?
A: No — React consumes `key`. Pass the id under another name. (`ref`, however, is a regular prop in React 19.)
:::

## Recap

- Props are a read-only object passed from parent to child; type them with a `Props` type (literal unions over `string`).
- Don't mutate props — not even arrays inside them (`sort`, `push`); copy or use `toSorted`.
- Defaults via destructuring; `ComponentProps<'button'>` + `...rest` to forward DOM attributes.
- `children` and slot props let components wrap arbitrary content — composition beats a growing list of config props.
- Data flows down via props; events flow up via callback props.
- Shared state lives in the closest common parent ("lifting state up"); children become controlled.
- Deep prop drilling is a smell — composition or context fix it.
