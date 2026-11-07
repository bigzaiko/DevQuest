---
id: fe-17
title: "Component Forge I: UI Primitives"
level: advanced
minutes: 65
xp: 190
summary: Build the first pieces of a real UI kit — Button, Input, Badge, Spinner — with variant props, rest-prop spreading, ref as a prop and a polymorphic `as`.
---

Every serious frontend team ends up with a **UI kit**: a folder (or a package) of small, boring,
rock-solid components — `Button`, `Input`, `Badge`, `Spinner`, `Dialog`, `Tabs` — that the rest of the
app is built from. Feature code never writes `<button className="px-3 py-2 rounded bg-blue-600 …">`
again; it writes `<Button variant="primary">Save</Button>`.

Why bother?

- **Consistency.** One place defines what "primary" looks like. A rebrand is a token change, not 400 edits.
- **Accessibility baked in.** The label/error wiring, focus rings and `aria-*` attributes are done *once*,
  correctly, by someone who cared — instead of 40 times, mostly wrong.
- **Speed.** Feature developers compose instead of reinventing.
- **Fixability.** A bug in `Input` is fixed for every form in the product at once.

In this lesson and the next two you'll forge that kit. This one covers **primitives** — components that
wrap a single native element. The key skill is not CSS; it's **API design**.

## Principle 1: extend the native element, don't hide it

A `Button` *is* a `<button>`. Anything a `<button>` accepts — `onClick`, `disabled`, `type`, `form`,
`aria-label`, `data-testid`, `autoFocus` — your `Button` should accept too. You get that for free by
typing props as the native props **plus** your additions, and **spreading the rest** onto the element:

```tsx
type ButtonProps = React.ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cn('btn', `btn-${variant}`, `btn-${size}`, className)}
      {...rest}
    />
  )
}
```

Details that matter, each one a real bug someone shipped:

| Detail | Why |
|---|---|
| `type = 'button'` default | A `<button>` inside a `<form>` defaults to `type="submit"`. A "Cancel" button that submits the form is a classic. |
| `className` is **merged**, not overwritten | Callers need to add layout classes (`mt-4`) without losing the variant styles. |
| `{...rest}` comes **after** your defaults | In JSX, the **last** occurrence of a prop wins. Spreading `rest` last lets callers override `aria-*`, `data-*` and event handlers. Anything you *compute* from a caller prop (`className`, `type`) is **destructured out** first, so it isn't in `rest` and can't silently replace your merged value. |
| `children` flows through `rest` | No need to destructure it if you don't touch it. |
| Variants are **string unions**, not booleans | `<Button primary danger>` is ambiguous; `variant="danger"` can only be one thing. |

:::pro title="Boolean props explode; enums compose"
`isPrimary`, `isSecondary`, `isGhost`, `isSmall`, `isLarge` gives 2⁵ = 32 combinations, most of them
nonsense. `variant` × `size` gives exactly the combinations the designer drew. Design-system teams
literally map their Figma component properties 1-to-1 onto these props.
:::

Why `React.ComponentProps<'button'>`? It's the exact prop type React uses for a native `<button>` —
every HTML attribute, every ARIA attribute, every event handler, plus `ref` and `children`. Writing
your own `onClick?: …; disabled?: …` list instead means you'll forget `form`, `name` or `aria-describedby`
and someone will need it next week.

The `cn()` helper you'll see everywhere is just "join the truthy class names". Real projects use
`clsx` + `tailwind-merge` (so `cn('px-2', 'px-4')` resolves the conflict to `px-4`, the last one), and often
**cva** (class-variance-authority) to declare variants as data (both were introduced in the Styling lesson):

```ts
const button = cva('btn', {
  variants: {
    variant: { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger' },
    size: { sm: 'btn-sm', md: 'btn-md', lg: 'btn-lg' },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
})
button({ variant: 'danger' }) // "btn btn-danger btn-md"
```

:::challenge id=fe-17-c1 lang=tsx xp=50 preview=ButtonDemo
title: Forge the Button
Implement `Button`:

- `variant`: `'primary' | 'secondary' | 'danger'` (default `primary`) → class `btn-<variant>`
- `size`: `'sm' | 'md' | 'lg'` (default `md`) → class `btn-<size>`
- always has class `btn`; a caller's `className` is **added**, not replacing
- `type` defaults to `"button"` but can be overridden
- every other prop (`onClick`, `disabled`, `aria-label`, `children`, …) reaches the `<button>`

A `cn()` helper is provided in the setup code.

hint: Destructure what you handle — `{ variant = 'primary', size = 'md', className, type = 'button', ...rest }` — and spread `rest`.
hint: `cn('btn', \`btn-${variant}\`, \`btn-${size}\`, className)`

```tsx setup
function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
```

```tsx starter
type ButtonProps = React.ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant, size, children }: ButtonProps) {
  return <button className="btn">{children}</button>
}

export function ButtonDemo() {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button>Save</Button>
      <Button variant="secondary" size="sm">Cancel</Button>
      <Button variant="danger" size="lg">Delete</Button>
    </div>
  )
}
```

```tsx solution
type ButtonProps = React.ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
}

export function Button({ variant = 'primary', size = 'md', className, type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={cn('btn', `btn-${variant}`, `btn-${size}`, className)} {...rest} />
}

export function ButtonDemo() {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <Button>Save</Button>
      <Button variant="secondary" size="sm">Cancel</Button>
      <Button variant="danger" size="lg">Delete</Button>
    </div>
  )
}
```

```tsx tests
test('defaults: primary, md, type=button', () => {
  render(<Button>Save</Button>)
  const b = screen.getByRole('button', { name: 'Save' })
  expect(b).toHaveClass('btn', 'btn-primary', 'btn-md')
  expect(b).toHaveAttribute('type', 'button')
})
test('variant and size map to classes', () => {
  render(<Button variant="danger" size="lg">Delete</Button>)
  expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('btn', 'btn-danger', 'btn-lg')
})
test('className is merged', () => {
  render(<Button className="mt-4">Go</Button>)
  expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('btn', 'btn-primary', 'mt-4')
})
test('type can be overridden', () => {
  render(<Button type="submit">Send</Button>)
  expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit')
})
test('rest props reach the element', async () => {
  const onClick = fn()
  render(<Button onClick={onClick} aria-label="Close dialog" data-testid="x">×</Button>)
  await user.click(screen.getByRole('button', { name: 'Close dialog' }))
  expect(onClick).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('x')).toBeInTheDocument()
})
test('disabled works and blocks clicks', async () => {
  const onClick = fn()
  render(<Button disabled onClick={onClick}>Nope</Button>)
  const b = screen.getByRole('button', { name: 'Nope' })
  expect(b).toBeDisabled()
  await user.click(b)
  expect(onClick).not.toHaveBeenCalled()
})
```
:::

## Principle 2: form fields own their accessibility wiring

An input without a programmatic label is invisible to screen readers and harder to click. An error
message that isn't linked to its input is never announced. These are the most common accessibility
failures on the web — and a good `Input` makes them **impossible**:

First, the vocabulary. Assistive technology (a screen reader such as NVDA, JAWS or VoiceOver) doesn't see
your layout; it reads the **accessibility tree**, which the browser builds from your HTML. Each control in it
has a **role** ("textbox"), an **accessible name** ("Email") and optionally a **description** ("We never
share it."). Our job is to make sure the input gets a name from its label and a description from its hint
and error text — via ids, because that's how HTML links one element to another.

```tsx
type InputProps = React.ComponentProps<'input'> & { label: string; hint?: string; error?: string }

export function Input({ label, error, hint, id, ...rest }: InputProps) {
  const autoId = useId()                   // stable, SSR-safe unique id
  const inputId = id ?? autoId
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
      {hint && <p id={hintId} className="field-hint">{hint}</p>}
      {error && <p id={errorId} className="field-error">{error}</p>}
    </div>
  )
}
```

- **`useId()`** generates an id that is unique per component instance and identical on server and client
  (so hydration doesn't break). Never use `Math.random()` for ids, and never hard-code them in a reusable component —
  two `<Input label="Email">` on one page would collide.
- **`<label htmlFor>`** gives the input its accessible name *and* makes the label clickable.
- **`aria-invalid`** tells assistive tech the value is wrong; it's also a great CSS hook:
  `input[aria-invalid="true"] { border-color: var(--color-danger) }`.
- **`aria-describedby`** points to the hint and the error; screen readers read them after the label.
  It takes a **space-separated list** of ids. When there's nothing to point to, the attribute must be
  **absent** — an empty string or an id that doesn't exist is useless noise.

Roughly what a screen reader then announces on focus (wording varies by reader):
*"Email, edit text, invalid entry, We never share it. Enter a valid email."*

A common mistake: because `{...rest}` comes last, a caller who passes their own `aria-describedby` silently
**replaces** your hint/error wiring. Production kits destructure it too and merge:
`[hint && hintId, error && errorId, ariaDescribedBy].filter(Boolean).join(' ')`.

:::warn title="Placeholder is not a label"
A placeholder disappears as soon as the user types, usually fails contrast, and isn't reliably announced.
Use it for an *example* (`name@company.com`), never instead of a `<label>`.
:::

:::challenge id=fe-17-c2 lang=tsx xp=60 preview=SignupForm
title: Input with label, hint and error
Implement `Input({ label, hint, error, id, ...rest })`:

- renders a `<label>` connected to the `<input>` (use the passed `id` or `useId()`)
- `hint` renders a paragraph with id `<inputId>-hint`; `error` renders one with id `<inputId>-error`
- `aria-describedby` lists the hint id and/or the error id (space-separated), and is **absent** when there are none
- `aria-invalid="true"` only when there's an `error`
- other props (`type`, `value`, `onChange`, `required`, …) reach the `<input>`

hint: `const autoId = useId(); const inputId = id ?? autoId`
hint: `[hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined` — `undefined` removes the attribute.

```tsx starter
import { useId, useState } from 'react'

type InputProps = React.ComponentProps<'input'> & { label: string; hint?: string; error?: string }

export function Input({ label, hint, error }: InputProps) {
  return (
    <div className="field">
      <label>{label}</label>
      <input />
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

export function SignupForm() {
  const [email, setEmail] = useState('')
  return (
    <form>
      <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
        hint="We never share it." error={email.includes('@') ? undefined : 'Enter a valid email'} />
      <Input label="Name" />
    </form>
  )
}
```

```tsx solution
import { useId, useState } from 'react'

type InputProps = React.ComponentProps<'input'> & { label: string; hint?: string; error?: string }

export function Input({ label, hint, error, id, ...rest }: InputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...rest} />
      {hint && <p id={hintId} className="field-hint">{hint}</p>}
      {error && <p id={errorId} className="field-error">{error}</p>}
    </div>
  )
}

export function SignupForm() {
  const [email, setEmail] = useState('')
  return (
    <form>
      <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
        hint="We never share it." error={email.includes('@') ? undefined : 'Enter a valid email'} />
      <Input label="Name" />
    </form>
  )
}
```

```tsx tests
test('label is connected to the input', () => {
  render(<Input label="Email" type="email" />)
  const input = screen.getByLabelText('Email')
  expect(input.tagName).toBe('INPUT')
  expect(input).toHaveAttribute('type', 'email')
})
test('two inputs get different ids', () => {
  render(<><Input label="First" /><Input label="Second" /></>)
  expect(screen.getByLabelText('First').id).not.toBe(screen.getByLabelText('Second').id)
})
test('uses a passed id', () => {
  render(<Input label="Phone" id="phone" />)
  expect(screen.getByLabelText('Phone')).toHaveAttribute('id', 'phone')
})
test('no hint, no error: no aria-describedby, no aria-invalid', () => {
  render(<Input label="Name" />)
  const input = screen.getByLabelText('Name')
  expect(input).not.toHaveAttribute('aria-describedby')
  expect(input).not.toHaveAttribute('aria-invalid')
})
test('error is linked and marks the field invalid', () => {
  render(<Input label="Email" id="em" hint="Work address" error="Required" />)
  const input = screen.getByLabelText('Email')
  expect(input).toHaveAttribute('aria-invalid', 'true')
  expect(input).toHaveAttribute('aria-describedby', 'em-hint em-error')
  expect(document.getElementById('em-error')).toHaveTextContent('Required')
  expect(document.getElementById('em-hint')).toHaveTextContent('Work address')
})
test('controlled props pass through', async () => {
  function Demo() {
    const [v, setV] = React.useState('')
    return <><Input label="City" value={v} onChange={(e) => setV(e.target.value)} /><p>Typed: {v}</p></>
  }
  render(<Demo />)
  await user.type(screen.getByLabelText('City'), 'Oslo')
  expect(screen.getByText('Typed: Oslo')).toBeInTheDocument()
})
```
:::

## Principle 3: status components must speak

A spinner is a picture of "wait". Sighted users get it; screen-reader users get nothing — unless you
say it. Two cases:

1. **Standalone spinner** (a page or panel is loading): give it `role="status"` (a polite live region)
   and visually-hidden text, so "Loading" is announced.
2. **Spinner inside something that already speaks** (a button saying "Save"): the spinner is
   **decorative** — hide it with `aria-hidden="true"` and put the state on the container instead:
   `aria-busy="true"` plus `disabled` to prevent double submits.

A **live region** is an element whose content changes are read out by screen readers without moving focus.
`role="status"` is a *polite* one (it waits until the user is idle); `role="alert"` is *assertive* (it
interrupts) and is reserved for urgent errors.

"Visually hidden" means: invisible on screen, but still in the accessibility tree:

```css
/* the classic visually-hidden utility — Tailwind calls it `sr-only` */
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
}
```

Never use `display: none`, `visibility: hidden` or the `hidden` attribute for screen-reader text — they
remove the element from the accessibility tree too, so nobody hears it.

:::info title="Live regions must exist before they change"
Screen readers watch live regions for **changes**. A brand-new element that mounts already containing
"Loading" is announced by some screen readers and silently skipped by others. A spinner with `role="status"`
is still a good default, but for messages that *must* be heard ("Saved", "3 results"), keep one status
element mounted permanently and change its text.
:::

Badges are the opposite: they're pure text (`Beta`, `3 new`, `Overdue`), but **colour must not be the
only signal** (WCAG 1.4.1). `tone="danger"` gives it red, but the text "Overdue" carries the meaning.

:::quiz id=fe-17-q1 xp=15
A "Save" button shows a spinner while the request runs. Which markup is best?
- [ ] `<button><span role="status">Loading</span> Save</button>`
- [x] `<button disabled aria-busy="true"><span class="spinner" aria-hidden="true"></span> Save</button>`
- [ ] `<button><img src="spinner.gif"> Save</button>`
- [ ] `<div onClick={save}><span class="spinner"></span> Save</div>`
> The button keeps its name "Save", `aria-busy` marks it as busy, the spinner is hidden from assistive tech, and
> `disabled` blocks double submits. The tempting first option is wrong because text inside a button becomes part of
> its accessible name ("Loading Save"), and a live region nested in a button is announced unreliably. An `<img>`
> without `alt` may be read out as its file name ("spinner.gif"); a clickable `div` isn't focusable or
> keyboard-operable at all.
:::

:::pro title="The fine print on loading buttons"
`disabled` has a side effect: if the button had focus (the user just pressed Enter on it), the browser drops
focus to `<body>`, and keyboard users lose their place. Many design systems therefore use
`aria-disabled="true"` while loading (the button stays focusable, and the click handler returns early) and
announce the outcome ("Saved") through a permanent status region. Also note that `aria-busy` support in screen
readers is patchy — treat it as a hint, not as the only signal.
:::

:::challenge id=fe-17-c3 lang=tsx xp=60 preview=StatusDemo
title: Spinner, Badge and a loading Button
Implement three components:

- `Spinner({ label = 'Loading', decorative = false, size = 'md' })` — a `<span>` with classes
  `spinner spinner-<size>`. Not decorative: `role="status"` with a visually-hidden `<span className="sr-only">` containing
  the label. Decorative: `aria-hidden="true"` and no text.
- `Badge({ tone = 'neutral', children, className, ...rest })` — a `<span>` with classes `badge badge-<tone>`
  (tones: `neutral | success | warning | danger`), merged `className`, rest spread.
- `LoadingButton({ loading, children, disabled, ...rest })` — a `<button type="button">`. While `loading`:
  `disabled`, `aria-busy="true"`, and a **decorative** small spinner before the children. Not loading: no `aria-busy`.

`cn()` is provided.

hint: `{decorative ? null : <span className="sr-only">{label}</span>}` and `role={decorative ? undefined : 'status'}`.
hint: `aria-busy={loading || undefined}` removes the attribute when not loading.
hint: `disabled={disabled || loading}`

```tsx setup
function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
```

```tsx starter
type SpinnerProps = { label?: string; decorative?: boolean; size?: 'sm' | 'md' | 'lg' }
export function Spinner({ label = 'Loading' }: SpinnerProps) {
  return <span className="spinner" />
}

type BadgeProps = React.ComponentProps<'span'> & { tone?: 'neutral' | 'success' | 'warning' | 'danger' }
export function Badge({ children }: BadgeProps) {
  return <span className="badge">{children}</span>
}

type LoadingButtonProps = React.ComponentProps<'button'> & { loading?: boolean }
export function LoadingButton({ loading, children, ...rest }: LoadingButtonProps) {
  return <button type="button" {...rest}>{loading && <Spinner />}{children}</button>
}

export function StatusDemo() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Spinner />
      <Badge tone="success">Paid</Badge>
      <Badge tone="danger">Overdue</Badge>
      <LoadingButton loading>Save</LoadingButton>
    </div>
  )
}
```

```tsx solution
type SpinnerProps = { label?: string; decorative?: boolean; size?: 'sm' | 'md' | 'lg' }
export function Spinner({ label = 'Loading', decorative = false, size = 'md' }: SpinnerProps) {
  return (
    <span
      className={cn('spinner', `spinner-${size}`)}
      role={decorative ? undefined : 'status'}
      aria-hidden={decorative ? true : undefined}
    >
      {decorative ? null : <span className="sr-only">{label}</span>}
    </span>
  )
}

type BadgeProps = React.ComponentProps<'span'> & { tone?: 'neutral' | 'success' | 'warning' | 'danger' }
export function Badge({ tone = 'neutral', className, ...rest }: BadgeProps) {
  return <span className={cn('badge', `badge-${tone}`, className)} {...rest} />
}

type LoadingButtonProps = React.ComponentProps<'button'> & { loading?: boolean }
export function LoadingButton({ loading = false, children, disabled, ...rest }: LoadingButtonProps) {
  return (
    <button type="button" disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <Spinner decorative size="sm" />}
      {children}
    </button>
  )
}

export function StatusDemo() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Spinner />
      <Badge tone="success">Paid</Badge>
      <Badge tone="danger">Overdue</Badge>
      <LoadingButton loading>Save</LoadingButton>
    </div>
  )
}
```

```tsx tests
test('standalone spinner announces its label', () => {
  render(<Spinner label="Loading projects" />)
  // role="status" gets its accessible name from aria-label only, not from its text,
  // so query the role and assert the announced text instead of using { name }
  const s = screen.getByRole('status')
  expect(s).toHaveTextContent('Loading projects')
  expect(s).toHaveClass('spinner', 'spinner-md')
  expect(s.querySelector('.sr-only')).toHaveTextContent('Loading projects')
})
test('spinner default label is "Loading"', () => {
  render(<Spinner size="lg" />)
  const s = screen.getByRole('status')
  expect(s).toHaveTextContent('Loading')
  expect(s).toHaveClass('spinner-lg')
})
test('decorative spinner is hidden from assistive tech', () => {
  const { container } = render(<Spinner decorative />)
  expect(screen.queryByRole('status')).toBeNull()
  expect(container.querySelector('.spinner')).toHaveAttribute('aria-hidden', 'true')
})
test('badge tones and className', () => {
  render(<Badge tone="danger" className="ml-2" title="x">Overdue</Badge>)
  const b = screen.getByText('Overdue')
  expect(b).toHaveClass('badge', 'badge-danger', 'ml-2')
  expect(b).toHaveAttribute('title', 'x')
})
test('badge defaults to neutral', () => {
  render(<Badge>Beta</Badge>)
  expect(screen.getByText('Beta')).toHaveClass('badge', 'badge-neutral')
})
test('loading button: disabled, busy, keeps its name, decorative spinner', () => {
  render(<LoadingButton loading>Save</LoadingButton>)
  const b = screen.getByRole('button', { name: 'Save' })
  expect(b).toBeDisabled()
  expect(b).toHaveAttribute('aria-busy', 'true')
  expect(screen.queryByRole('status')).toBeNull()
  expect(b.querySelector('.spinner')).toHaveClass('spinner-sm')
})
test('idle button is enabled and not busy', async () => {
  const onClick = fn()
  render(<LoadingButton onClick={onClick}>Save</LoadingButton>)
  const b = screen.getByRole('button', { name: 'Save' })
  expect(b).toBeEnabled()
  expect(b).not.toHaveAttribute('aria-busy')
  await user.click(b)
  expect(onClick).toHaveBeenCalledTimes(1)
})
```
:::

## ref as a prop (React 19)

Sometimes a parent needs the underlying DOM node: to focus an input after a validation error, to measure
an element, to scroll a list item into view, or because a library (a popover positioning engine, a
form library like React Hook Form) asks for it. That's what `ref` is for.

Before React 19, a function component could **not** receive `ref` as a prop — React stripped it — so
every UI kit wrapped components in `forwardRef`:

```tsx
// React 18 — still common in existing codebases
const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  return <input ref={ref} {...props} />
})
```

**React 19 makes `ref` an ordinary prop** for function components. No wrapper, no second argument:

```tsx
// React 19
function Input({ ref, ...props }: React.ComponentProps<'input'>) {
  return <input ref={ref} {...props} />
}

function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Input ref={inputRef} aria-label="Search" />
      <button onClick={() => inputRef.current?.focus()}>Focus search</button>
    </>
  )
}
```

`React.ComponentProps<'input'>` already includes `ref`, so if you spread `{...props}` the ref flows through
automatically. `forwardRef` still works in React 19, but the React team has announced it will be deprecated
and eventually removed, so new code shouldn't use it.

A common mistake: destructuring `ref` (to read it, or by habit) and then **not** passing it on. Nothing errors —
the parent's `inputRef.current` just stays `null` forever. That's exactly the bug in the next challenge.

React 19 also allows **ref callbacks to return a cleanup function**, like effects:

```tsx
const measureRef = useCallback((node: HTMLDivElement) => {
  const observer = new ResizeObserver(() => { /* … */ })
  observer.observe(node)
  return () => observer.disconnect()   // called when the node is removed
}, [])

<div ref={measureRef} />
```

When a ref callback returns a cleanup, React calls the cleanup on detach instead of calling your callback with
`null`. Keep the callback **stable** (`useCallback` or a function defined outside the component): an inline
arrow is a new function every render, so React would disconnect and re-create the observer on every render.

:::job title="Day one in an existing codebase"
You'll still see plenty of `forwardRef` and `React.ElementRef<typeof X>` (now deprecated in favour of
`React.ComponentRef<typeof X>`) in kits generated by shadcn/ui before 2025, and in older Radix-based
components. Don't rewrite them for fun — but new components on React 19 should take `ref` as a prop, and the
community codemod (`npx codemod@latest react/19/remove-forward-ref`) can migrate in bulk. Review its diff:
codemods are a starting point, not a guarantee.
:::

:::challenge id=fe-17-c4 lang=tsx xp=50 preview=SearchBar
title: ref as a prop
`TextField` receives a `ref` but drops it, so the "Focus search" button doesn't work, and the "Clear"
button can't reach the DOM node either. Fix `TextField` (React 19 style — no `forwardRef`) so that:

- the `ref` reaches the `<input>`,
- `SearchBar`'s **Focus search** button focuses the input,
- **Clear** empties the (uncontrolled) input via `inputRef.current.value = ''` and focuses it.

Only `TextField` and the `Clear` handler need changes. (Writing `.value` directly is fine here because the input
is **uncontrolled** — it has `defaultValue`, no `value`. On a controlled input React would put its own `value`
back on the next render; there you'd clear the state instead.)

hint: Destructure `ref` like any other prop: `function TextField({ label, ref, ...rest })` and put `ref={ref}` on the `<input>`.
hint: Clear: `if (inputRef.current) { inputRef.current.value = ''; inputRef.current.focus() }`

```tsx starter
import { useRef } from 'react'

type TextFieldProps = React.ComponentProps<'input'> & { label: string }

export function TextField({ label, ref, ...rest }: TextFieldProps) {
  return (
    <label className="field">
      {label}
      <input {...rest} />
    </label>
  )
}

export function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <TextField label="Search" ref={inputRef} defaultValue="" />
      <button onClick={() => inputRef.current?.focus()}>Focus search</button>
      <button onClick={() => {}}>Clear</button>
    </div>
  )
}
```

```tsx solution
import { useRef } from 'react'

type TextFieldProps = React.ComponentProps<'input'> & { label: string }

export function TextField({ label, ref, ...rest }: TextFieldProps) {
  return (
    <label className="field">
      {label}
      <input ref={ref} {...rest} />
    </label>
  )
}

export function SearchBar() {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <TextField label="Search" ref={inputRef} defaultValue="" />
      <button onClick={() => inputRef.current?.focus()}>Focus search</button>
      <button
        onClick={() => {
          if (inputRef.current) {
            inputRef.current.value = ''
            inputRef.current.focus()
          }
        }}
      >
        Clear
      </button>
    </div>
  )
}
```

```tsx tests
test('ref reaches the input element', () => {
  const ref = { current: null as HTMLInputElement | null }
  render(<TextField label="Email" ref={ref} />)
  expect(ref.current).toBe(screen.getByLabelText('Email'))
})
test('Focus search focuses the input', async () => {
  render(<SearchBar />)
  await user.click(screen.getByRole('button', { name: 'Focus search' }))
  expect(screen.getByLabelText('Search')).toHaveFocus()
})
test('Clear empties and focuses the input', async () => {
  render(<SearchBar />)
  const input = screen.getByLabelText('Search')
  await user.type(input, 'react 19')
  expect(input).toHaveValue('react 19')
  await user.click(screen.getByRole('button', { name: 'Clear' }))
  expect(input).toHaveValue('')
  expect(input).toHaveFocus()
})
```
:::

## Polymorphic components: the `as` prop

Typography and layout primitives often need to render **different elements** with the **same styles**:
a `Text` that is a `<p>` here, a `<span>` there, an `<h2>` in a card header; a `Button` that must be an
`<a href>` because it navigates. Hard-coding the element forces copy-paste. The `as` prop solves it:

```tsx
type TextProps<T extends React.ElementType> = {
  as?: T
  size?: 'sm' | 'md' | 'lg'
} & Omit<React.ComponentProps<T>, 'as' | 'size'>

export function Text<T extends React.ElementType = 'p'>({ as, size = 'md', className, ...rest }: TextProps<T>) {
  const Component = (as ?? 'p') as React.ElementType
  return <Component className={cn(`text-${size}`, className)} {...rest} />
}

<Text>Body copy</Text>                         // <p class="text-md">
<Text as="h2" size="lg">Billing</Text>         // <h2 class="text-lg">
<Text as="a" href="/docs">Read the docs</Text> // <a href> — and TypeScript knows `href` is valid!
```

Three things make this work:

- In JSX, a **capitalised variable** holding a string (`'h2'`) or a component renders that element. A lowercase
  one (`<component>`) would be treated as an unknown HTML tag called "component".
- The generic `T` makes TypeScript infer the props of whatever you pass to `as`. `<Text as="a" href>` type-checks;
  `<Text as="p" href>` doesn't. `Omit<…, 'as' | 'size'>` removes native props whose names we reuse (an
  `<input>` has its own numeric `size`).
- The `as React.ElementType` cast inside the body is normal: TypeScript can't relate "props of some unknown `T`"
  to the spread, so the **public** signature stays strict and the implementation is loosened in one place.

:::pro title="Semantics beat looks"
The point of `as` is to pick the **right semantic element** while keeping the visual style: a heading that
looks small is still an `<h2>`; a link that looks like a button is still an `<a>` (it navigates, it can be
opened in a new tab). Never make a `<div>` clickable when `as="button"` or `as="a"` exists.
Radix/shadcn use a variant of this idea called **`asChild`**: `<Button asChild><Link to="/x">Go</Link></Button>`
merges the Button's props onto its single child.
:::

:::challenge id=fe-17-c5 lang=tsx xp=50 preview=TypeScale
title: A polymorphic Text
Implement `Text({ as, size = 'md', tone, className, ...rest })`:

- renders the element given by `as` (default `'p'`)
- classes: `text-<size>`, plus `text-<tone>` when `tone` is set (`'muted' | 'danger'`), plus the caller's `className`
- every other prop (`href`, `id`, `children`, `onClick`, …) reaches the element

hint: `const Component = as ?? 'p'` — then `<Component … />`. JSX treats a capitalised variable as an element type.
hint: `cn(\`text-${size}\`, tone && \`text-${tone}\`, className)`

```tsx setup
function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ')
}
```

```tsx starter
type TextProps<T extends React.ElementType> = {
  as?: T
  size?: 'sm' | 'md' | 'lg'
  tone?: 'muted' | 'danger'
} & Omit<React.ComponentProps<T>, 'as' | 'size'>

export function Text<T extends React.ElementType = 'p'>({ children }: TextProps<T>) {
  return <p className="text-md">{children}</p>
}

export function TypeScale() {
  return (
    <div>
      <Text as="h2" size="lg">Billing</Text>
      <Text tone="muted">Your plan renews on 1 December.</Text>
      <Text as="a" href="#plans" size="sm">Compare plans</Text>
    </div>
  )
}
```

```tsx solution
type TextProps<T extends React.ElementType> = {
  as?: T
  size?: 'sm' | 'md' | 'lg'
  tone?: 'muted' | 'danger'
} & Omit<React.ComponentProps<T>, 'as' | 'size'>

export function Text<T extends React.ElementType = 'p'>({ as, size = 'md', tone, className, ...rest }: TextProps<T>) {
  const Component = (as ?? 'p') as React.ElementType
  return <Component className={cn(`text-${size}`, tone && `text-${tone}`, className)} {...rest} />
}

export function TypeScale() {
  return (
    <div>
      <Text as="h2" size="lg">Billing</Text>
      <Text tone="muted">Your plan renews on 1 December.</Text>
      <Text as="a" href="#plans" size="sm">Compare plans</Text>
    </div>
  )
}
```

```tsx tests
test('defaults to a paragraph with text-md', () => {
  render(<Text>Body</Text>)
  const el = screen.getByText('Body')
  expect(el.tagName).toBe('P')
  expect(el).toHaveClass('text-md')
})
test('as="h2" renders a real heading', () => {
  render(<Text as="h2" size="lg">Billing</Text>)
  const h = screen.getByRole('heading', { name: 'Billing' })
  expect(h.tagName).toBe('H2')
  expect(h).toHaveClass('text-lg')
})
test('as="a" renders a link with href', () => {
  render(<Text as="a" href="#plans" size="sm">Compare plans</Text>)
  const a = screen.getByRole('link', { name: 'Compare plans' })
  expect(a).toHaveAttribute('href', '#plans')
  expect(a).toHaveClass('text-sm')
})
test('tone and className are merged', () => {
  render(<Text as="span" tone="danger" className="ml-1" id="err">Oops</Text>)
  const el = screen.getByText('Oops')
  expect(el.tagName).toBe('SPAN')
  expect(el).toHaveClass('text-md', 'text-danger', 'ml-1')
  expect(el).toHaveAttribute('id', 'err')
})
test('no tone means no tone class', () => {
  render(<Text>Plain</Text>)
  expect(screen.getByText('Plain').className).toBe('text-md')
})
```
:::

## API design checklist

Before a primitive goes into the kit, a design-system reviewer asks:

1. **Does it extend the native element's props** and spread the rest? Can I pass `aria-*` and `data-*`?
2. **Are defaults safe?** (`type="button"`, sensible `size`, no surprising behaviour.)
3. **Is `className` merged** and is `ref` forwarded?
4. **Are variants enums**, named after *intent* (`danger`), not looks (`red`)?
5. **Is accessibility automatic?** Label wiring, `aria-invalid`, focus ring (`:focus-visible`), announced loading states.
6. **Controlled *and* uncontrolled?** Does it work with `value`/`onChange` and with `defaultValue`? (Next lesson.)
7. **Is it documented** with examples — usually a Storybook story per variant, which doubles as visual-regression test input.

:::quiz id=fe-17-q2 xp=10
In React 19, how should a new `Input` component expose its DOM node to a parent?
- [ ] Wrap it in `forwardRef` — function components can't receive `ref`
- [x] Accept `ref` as a normal prop and pass it to the `<input>`
- [ ] Use `document.querySelector` in the parent
- [ ] Expose an `inputRef` callback via Context
> Since React 19, `ref` is a regular prop for function components. `forwardRef` still works but is on its way
> out. Querying the DOM from a parent breaks encapsulation and fails with multiple instances.
:::

:::quiz id=fe-17-q3 xp=15
Which are good API choices for a design-system `Button`? (Select all that apply.)
- [x] `variant: 'primary' | 'secondary' | 'danger'`
- [ ] `isPrimary`, `isSecondary`, `isDanger` booleans
- [x] Defaulting `type` to `"button"`
- [x] Typing props as `React.ComponentProps<'button'> & { … }` and spreading the rest
- [ ] Ignoring `className` so nobody can break the design
> Enum variants can't conflict; booleans can (`isPrimary isDanger`?). `type="button"` avoids accidental form
> submits. Extending native props keeps every HTML/ARIA attribute available. Refusing `className` just forces
> people to wrap your component in extra `div`s for spacing.
:::

:::quiz id=fe-17-q4 xp=15
Spot the bug. A caller writes `<Button className="w-full">Pay</Button>` and the button loses all its
variant styling:

```tsx
export function Button({ variant = 'primary', ...rest }: ButtonProps) {
  return <button type="button" className={cn('btn', `btn-${variant}`)} {...rest} />
}
```

- [ ] `cn()` drops classes it doesn't recognise
- [x] `className` is still inside `rest`, and the spread comes last, so the caller's `className` replaces the computed one
- [ ] `type="button"` must come after the spread
- [ ] Template literals can't be used inside `cn()`
> In JSX the last occurrence of a prop wins. Because `className` wasn't destructured, `{...rest}` re-sets it to
> `"w-full"`, overwriting `"btn btn-primary"`. Fix: destructure `className` and merge it —
> `` cn('btn', `btn-${variant}`, className) ``. Moving `type` wouldn't change anything about classes (and the same bug
> lets a caller override `type`, which is intended here), and `cn()` passes through every truthy string.
:::

:::quiz id=fe-17-q5 xp=10
A reusable `Input` sets `id="email"` on its `<input>` and `htmlFor="email"` on its label. What goes wrong?
- [ ] Nothing, as long as the label text is unique
- [x] With two `Input`s on a page (say, in a login form and a newsletter footer), ids collide and the second label points at the first input
- [ ] `htmlFor` doesn't work with hard-coded ids, only with `useId()`
- [ ] The id breaks server-side rendering
> HTML ids must be unique per document; with duplicates, `htmlFor` and `aria-describedby` resolve to the *first*
> match, so clicking the second label focuses the wrong field and screen readers read the wrong hint. `useId()`
> gives each instance its own id. `htmlFor` itself works with any id string, and a constant id is identical on
> server and client, so hydration isn't the issue (random ids from `Math.random()` are what break hydration).
:::

## Recap

- A UI kit centralises **consistency, accessibility and fixes**. Primitives wrap one native element.
- Type props as **`React.ComponentProps<'el'>` + your additions**, destructure what you handle, **spread the rest**, **merge `className`**.
- Use **string-union variants** (`variant`, `size`) named for intent; default `type="button"`.
- Form fields wire **`<label htmlFor>`** via `useId()`, **`aria-describedby`** for hint/error and **`aria-invalid`**.
- Standalone spinners are `role="status"` with visually-hidden text; spinners inside buttons are `aria-hidden` and the button gets `aria-busy` + `disabled`.
- **React 19: `ref` is a prop** — no `forwardRef`; destructure it and pass it on. Ref callbacks may return a cleanup (keep them stable).
- The polymorphic **`as`** prop picks the right semantic element while keeping the style.

:::cards id=fe-17-cards1 xp=15 title="UI primitives"
Q: Why default a Button's `type` to `"button"`?
A: Inside a `<form>`, a button defaults to `type="submit"` — a "Cancel" button would submit the form.
Q: Why spread `...rest` onto the native element?
A: So callers can pass any HTML/ARIA/data attribute and event handler without the kit having to anticipate each one.
Q: What does `useId()` give you?
A: A unique, stable id per component instance that matches between server and client render — perfect for label/aria wiring.
Q: How do you link an error message to an input?
A: Give the message an id and put it in the input's `aria-describedby` (space-separated list); set `aria-invalid="true"`.
Q: How does a component receive `ref` in React 19?
A: As a regular prop: `function Input({ ref, ...props })` → `<input ref={ref} />`. No `forwardRef`.
Q: What is a polymorphic component?
A: One that takes an `as` prop to choose the rendered element (`<Text as="h2">`), keeping styles while picking correct semantics.
Q: Spinner inside a "Save" button — how do you make it accessible?
A: Spinner `aria-hidden="true"`; the button gets `aria-busy="true"` and `disabled`, keeping its name "Save".
:::
