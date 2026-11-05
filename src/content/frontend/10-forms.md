---
id: fe-10
title: Forms
level: intermediate
minutes: 60
xp: 160
summary: Controlled vs uncontrolled inputs, submitting, validation with accessible errors, and React 19's form actions — useActionState and useFormStatus.
---

Forms are where users give you data — sign-ups, checkouts, settings, search. They look simple and
are full of traps: lost input on re-render, submit buttons that double-post, error messages screen
readers never announce. This lesson builds forms the way production teams do.

## Always start with a real `<form>`

```tsx
function Search({ onSearch }: { onSearch: (q: string) => void }) {
  const [q, setQ] = useState('')

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()          // stop the browser's full-page navigation
    onSearch(q)
  }

  return (
    <form onSubmit={handleSubmit} role="search">
      <label htmlFor="q">Search</label>
      <input id="q" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="submit">Go</button>
    </form>
  )
}
```

(`@types/react` 19.2+ types `onSubmit` with `SubmitEvent`; older code bases use the now-deprecated `React.FormEvent`.)

Using `<form>` + `onSubmit` (instead of a button with `onClick`) gives you, for free:

- **Enter submits** from any text field — users expect it, and keyboard users depend on it.
- Native validation attributes (`required`, `type="email"`, `minLength`, `pattern`).
- Password managers and autofill understand the form.
- Screen readers announce it as a form.

`e.preventDefault()` matters because a `<form>` is older than JavaScript apps: on submit the browser
serialises the fields and **navigates** to the form's `action` URL (the current page if there is
none). Without `preventDefault()` your single-page app reloads and all React state is lost.

Inside a form, a `<button>` defaults to `type="submit"`. Give non-submitting buttons
`type="button"`, or "Cancel" will submit your form.

:::quiz id=fe-10-q3 xp=10
Spot the bug: users report that clicking **Cancel** saves the half-filled form.

```tsx
<form onSubmit={handleSave}>
  <input name="title" />
  <button>Save</button>
  <button onClick={onCancel}>Cancel</button>
</form>
```

- [ ] `onSubmit` fires for every click inside the form, whatever was clicked
- [x] Both buttons default to `type="submit"`, so Cancel runs `onCancel` *and* submits the form
- [ ] `onCancel` needs `e.stopPropagation()` to stop the click reaching the form
> A `<button>` without a `type` inside a `<form>` is a submit button. Clicking Cancel runs `onCancel`
> and then the browser submits the form. The fix is `type="button"` on Cancel. Clicking non-button
> elements does *not* submit, so the first option is wrong. `stopPropagation()` doesn't help either:
> submission is the button's default action, not a click bubbling up to the form (only
> `preventDefault()` would stop it, and that's a workaround for the wrong `type`).
:::

## Controlled vs uncontrolled inputs

An input's current text has to live *somewhere*. The question is whether it lives in React state
or only in the DOM, and the answer decides how you read it, validate it and reset it.

**Controlled**: React state is the source of truth. The input shows `value={state}`, and every
keystroke goes through `onChange → setState → re-render`. React then writes the state back into the
input. Because the state always holds the current text, you can validate, reformat or disable things
on every keystroke. A re-render per keystroke sounds expensive but is fine for normal forms. It only
starts to matter for very large forms or heavy components around the input.

```tsx
const [email, setEmail] = useState('')
<input value={email} onChange={(e) => setEmail(e.target.value)} />
```

**Uncontrolled**: the DOM keeps the value. You give an initial `defaultValue` and read the value
when you need it — via a **ref** or from the form's `FormData` on submit.

```tsx
const emailRef = useRef<HTMLInputElement>(null)
<input ref={emailRef} defaultValue="" />
// later: emailRef.current?.value

// or, with no ref at all:
function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
  e.preventDefault()
  const data = new FormData(e.currentTarget)
  const email = String(data.get('email'))   // reads <input name="email">
}
```

`FormData` finds fields by their **`name`** attribute, not by `id` or label. An input without a
`name` is simply not in the `FormData`, and `data.get('email')` returns `null`. That's the most
common mistake with uncontrolled forms.

| | Controlled | Uncontrolled |
|---|---|---|
| Source of truth | React state | the DOM |
| Re-renders per keystroke | yes | no |
| Instant validation, formatting, dependent fields | easy | awkward |
| Boilerplate | more | less |
| Good for | interactive forms, live validation, disabling submit | simple forms, very large forms, file inputs (always uncontrolled) |

`useRef` returns a box `{ current }` that survives re-renders and **doesn't trigger** a render when
changed. Attaching it with `ref={…}` makes React put the DOM node in `current` after mounting.
Refs are React's escape hatch to the DOM: focus, measuring, scrolling, reading uncontrolled values.

:::warn title="Don't switch between controlled and uncontrolled"
`value={user.name}` where `user.name` starts as `undefined` creates an *uncontrolled* input that
becomes controlled later — React warns. Always give controlled inputs a defined value:
`value={user.name ?? ''}`. And `value` without `onChange` makes a read-only input (React warns too —
use `readOnly` or `defaultValue` if that's what you meant).
:::

:::quiz id=fe-10-q1 xp=10
You write `<input value={name} />` with no `onChange`. What happens when the user types?

- [ ] The input updates, but `name` doesn't
- [x] Nothing — React keeps forcing the input back to `name`, so it appears frozen (and React warns)
- [ ] React automatically updates `name`
> A controlled input always displays its `value` prop. Without an `onChange` that updates the state,
> React puts `name` straight back after each keystroke, so the field looks frozen. The first option
> is tempting but wrong: React doesn't let the DOM drift away from `value`. React also has no two-way
> binding, so it never writes to `name` for you. The console warning tells you to add `onChange`, or
> to use `readOnly` or `defaultValue`.
:::

:::quiz id=fe-10-q5 xp=10
This uncontrolled form logs `null`. Why?

```tsx
function Subscribe() {
  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    console.log(new FormData(e.currentTarget).get('email'))
  }
  return (
    <form onSubmit={handleSubmit}>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" />
      <button>Subscribe</button>
    </form>
  )
}
```

- [ ] `FormData` only works with controlled inputs
- [x] The input has no `name` attribute, and `FormData` collects fields by `name`
- [ ] `e.currentTarget` is the button, not the form
- [ ] You must read `FormData` before calling `preventDefault()`
> `FormData` uses each field's `name` as its key. `id` (and the label) are for linking and
> accessibility, so the input is skipped and `get('email')` returns `null`. Add `name="email"`.
> `e.currentTarget` is the element the handler is attached to, which is the `<form>`. `preventDefault()`
> only stops the page navigation and doesn't touch the field values.
:::

:::challenge id=fe-10-c1 lang=tsx xp=40 preview=Demo
title: A controlled login form
Build `LoginForm({ onLogin })`:

- inputs labelled `Email` (`type="email"`) and `Password` (`type="password"`), both controlled
- a submit button `Sign in`, **disabled** until both fields are non-empty (after trimming the email)
- submitting (button click *or* Enter) calls `onLogin({ email, password })` with the email trimmed, and must not reload the page

hint: `const canSubmit = email.trim() !== '' && password !== ''` — derived, not state.
hint: `<form onSubmit={(e) => { e.preventDefault(); … }}>`

```tsx starter
import { useState } from 'react'

type Credentials = { email: string; password: string }

export function LoginForm({ onLogin }: { onLogin: (c: Credentials) => void }) {
  return (
    <div>
      <label>Email <input type="email" /></label>
      <label>Password <input type="password" /></label>
      <button onClick={() => onLogin({ email: '', password: '' })}>Sign in</button>
    </div>
  )
}

export function Demo() {
  return <LoginForm onLogin={(c) => alert(JSON.stringify(c))} />
}
```

```tsx solution
import { useState } from 'react'

type Credentials = { email: string; password: string }

export function LoginForm({ onLogin }: { onLogin: (c: Credentials) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const canSubmit = email.trim() !== '' && password !== ''

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (!canSubmit) return
        onLogin({ email: email.trim(), password })
      }}
    >
      <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button type="submit" disabled={!canSubmit}>Sign in</button>
    </form>
  )
}

export function Demo() {
  return <LoginForm onLogin={(c) => alert(JSON.stringify(c))} />
}
```

```tsx tests
test('disabled until both fields are filled', async () => {
  render(<LoginForm onLogin={fn()} />)
  const btn = screen.getByRole('button', { name: 'Sign in' })
  expect(btn).toBeDisabled()
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  expect(btn).toBeDisabled()
  await user.type(screen.getByLabelText('Password'), 'secret')
  expect(btn).toBeEnabled()
})
test('whitespace-only email does not count', async () => {
  render(<LoginForm onLogin={fn()} />)
  await user.type(screen.getByLabelText('Email'), '   ')
  await user.type(screen.getByLabelText('Password'), 'x')
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
})
test('click submits trimmed values', async () => {
  const onLogin = fn()
  render(<LoginForm onLogin={onLogin} />)
  await user.type(screen.getByLabelText('Email'), ' ada@example.com ')
  await user.type(screen.getByLabelText('Password'), 'secret')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  expect(onLogin).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'secret' })
})
test('Enter submits', async () => {
  const onLogin = fn()
  render(<LoginForm onLogin={onLogin} />)
  await user.type(screen.getByLabelText('Email'), 'a@b.co')
  await user.type(screen.getByLabelText('Password'), 'pw{Enter}')
  expect(onLogin).toHaveBeenCalledTimes(1)
})
```
:::

:::challenge id=fe-10-c2 lang=tsx xp=40 preview=Demo
title: An uncontrolled quick-add
Not every form needs state. Build `QuickAdd({ onAdd })` **without `useState`**:

- a form with an input labelled `Task` (uncontrolled, use a ref) and a `type="submit"` button `Add`
- on submit: read the value, trim it; if non-empty call `onAdd(value)` and clear the input; then put focus back into the input so the user can type the next task

hint: `const inputRef = useRef<HTMLInputElement>(null)` and `<input ref={inputRef} />`
hint: `const value = inputRef.current!.value.trim()` … `inputRef.current!.value = ''` … `inputRef.current!.focus()`

```tsx starter
import { useRef } from 'react'

export function QuickAdd({ onAdd }: { onAdd: (task: string) => void }) {
  return (
    <form onSubmit={(e) => e.preventDefault()}>
      <label>Task <input /></label>
      <button type="submit">Add</button>
    </form>
  )
}

export function Demo() {
  return <QuickAdd onAdd={(t) => console.log('added', t)} />
}
```

```tsx solution
import { useRef } from 'react'

export function QuickAdd({ onAdd }: { onAdd: (task: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const input = inputRef.current!
        const value = input.value.trim()
        if (value) {
          onAdd(value)
          input.value = ''
        }
        input.focus()
      }}
    >
      <label>Task <input ref={inputRef} /></label>
      <button type="submit">Add</button>
    </form>
  )
}

export function Demo() {
  return <QuickAdd onAdd={(t) => console.log('added', t)} />
}
```

```tsx tests
test('adds and clears', async () => {
  const onAdd = fn()
  render(<QuickAdd onAdd={onAdd} />)
  const input = screen.getByLabelText('Task')
  await user.type(input, '  Write docs ')
  await user.click(screen.getByRole('button', { name: 'Add' }))
  expect(onAdd).toHaveBeenCalledWith('Write docs')
  expect(input).toHaveValue('')
})
test('ignores blank input', async () => {
  const onAdd = fn()
  render(<QuickAdd onAdd={onAdd} />)
  await user.type(screen.getByLabelText('Task'), '   {Enter}')
  expect(onAdd).not.toHaveBeenCalled()
})
test('focus returns to the input', async () => {
  render(<QuickAdd onAdd={fn()} />)
  await user.type(screen.getByLabelText('Task'), 'One')
  await user.click(screen.getByRole('button', { name: 'Add' }))
  expect(screen.getByLabelText('Task')).toHaveFocus()
})
```
:::

## Validation that everyone can use

Client-side validation is a **UX feature**, not security — the ASP.NET backend must validate again,
because anyone can call your API directly. On the client, the goals are: tell users what's wrong,
where, and how to fix it, at the right moment.

**When to validate.** Validating on every keystroke yells at users who haven't finished typing.
A common, user-friendly policy:

1. Validate on **submit**; show all errors.
2. After a field has been submitted (or blurred) once, re-validate it **as the user types**, so errors disappear as soon as they're fixed.

**How to show errors accessibly.** A red border alone fails colour-blind users and screen readers.
Connect the message to the field:

```tsx
<label htmlFor="email">Email</label>
<input
  id="email"
  type="email"
  value={email}
  onChange={…}
  aria-invalid={errors.email ? true : undefined}
  aria-describedby={errors.email ? 'email-error' : undefined}
/>
{errors.email && <p id="email-error" className="field-error">{errors.email}</p>}
```

- `aria-invalid="true"` tells assistive tech the field is in error.
- `aria-describedby` makes the screen reader read the message when the field is focused.
- On a failed submit, **move focus to the first invalid field** so keyboard and screen-reader users
  land right where the problem is. (Some teams also render an error summary with `role="alert"`.)
- Every input needs a real `<label>`. A `placeholder` is not a label — it disappears when you type
  and has poor contrast.
- When the field is fixed, **remove** both attributes (that's why the example passes `undefined`, which
  makes React leave the attribute out). A stale `aria-describedby` pointing at a message that no
  longer exists is confusing, and `aria-invalid="false"` is just noise.

:::quiz id=fe-10-q4 xp=15
A screen-reader user tabs into the Email field after a failed submit. You want the reader to
announce the field's **name**, that it is **invalid**, and the **error message**. What do you need?
(select all that apply)

- [x] A `<label htmlFor="email">Email</label>` for an `<input id="email">`
- [x] `aria-invalid="true"` on the input
- [x] `aria-describedby="email-error"` on the input, pointing at `<p id="email-error">Enter a valid email</p>`
- [ ] A red border (`className="error"`) with the message in a `<p>` right below the input
- [ ] The message as the input's `placeholder`
> The label gives the field its name, `aria-invalid` makes the reader say "invalid", and
> `aria-describedby` makes it read the linked message on focus. A red border with a `<p>` nearby
> *looks* right, but nothing connects the `<p>` to the input, so nothing is announced. Colour alone
> also fails colour-blind users. A placeholder is neither a label nor an error channel, because it
> vanishes as soon as the user types.
:::

:::info title="What about the browser's built-in validation?"
`required`, `type="email"` and `minLength` give you native validation bubbles for free and are a
fine baseline. Teams that want consistent custom messages add `noValidate` to the `<form>` and
validate in JS — often with a schema library (Zod) shared with the form library (React Hook Form,
TanStack Form).
:::

:::challenge id=fe-10-c3 lang=tsx xp=60 preview=Demo
title: Accessible validation
Build `SignupForm({ onSignup })` with `noValidate` and two controlled fields, `Email` and
`Password` (each `<label htmlFor>` + `<input id>`), and a submit button `Create account`.

On submit, validate:

- email empty → `Email is required`; otherwise no `@` → `Enter a valid email`
- password shorter than 8 characters → `Password must be at least 8 characters`

If there are errors: show each message in a `<p id="<field>-error">` (`email-error`, `password-error`),
set `aria-invalid="true"` and `aria-describedby="<field>-error"` on the input, **focus the first
invalid field**, and don't call `onSignup`. If valid: call `onSignup({ email, password })`.

After the first submit, errors update **as the user types**: fix the email and its message
disappears, and its `aria-invalid` / `aria-describedby` attributes are removed. Before the first
submit, show no errors at all.

hint: Write a pure `validate(values)` that returns `{ email?: string; password?: string }`.
hint: Keep `const [submitted, setSubmitted] = useState(false)`; the errors you *display* are `submitted ? validate(values) : {}` — derived!
hint: For focus, use two refs, or `document.getElementById(firstErrorField)?.focus()`.

```tsx starter
import { useState, useRef } from 'react'

type Values = { email: string; password: string }

export function SignupForm({ onSignup }: { onSignup: (v: Values) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); onSignup({ email, password }) }}>
      <label htmlFor="email">Email</label>
      <input id="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button type="submit">Create account</button>
    </form>
  )
}

export function Demo() {
  return <SignupForm onSignup={(v) => alert('Welcome ' + v.email)} />
}
```

```tsx solution
import { useState, useRef } from 'react'

type Values = { email: string; password: string }
type Errors = Partial<Record<keyof Values, string>>

function validate(v: Values): Errors {
  const errors: Errors = {}
  if (!v.email.trim()) errors.email = 'Email is required'
  else if (!v.email.includes('@')) errors.email = 'Enter a valid email'
  if (v.password.length < 8) errors.password = 'Password must be at least 8 characters'
  return errors
}

export function SignupForm({ onSignup }: { onSignup: (v: Values) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  const values = { email, password }
  const errors = submitted ? validate(values) : {}

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitted(true)
    const found = validate(values)
    if (found.email) return emailRef.current?.focus()
    if (found.password) return passwordRef.current?.focus()
    onSignup(values)
  }

  return (
    <form noValidate onSubmit={handleSubmit}>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        ref={emailRef}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-invalid={errors.email ? true : undefined}
        aria-describedby={errors.email ? 'email-error' : undefined}
      />
      {errors.email && <p id="email-error">{errors.email}</p>}

      <label htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        ref={passwordRef}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-invalid={errors.password ? true : undefined}
        aria-describedby={errors.password ? 'password-error' : undefined}
      />
      {errors.password && <p id="password-error">{errors.password}</p>}

      <button type="submit">Create account</button>
    </form>
  )
}

export function Demo() {
  return <SignupForm onSignup={(v) => alert('Welcome ' + v.email)} />
}
```

```tsx tests
const submit = () => user.click(screen.getByRole('button', { name: 'Create account' }))
test('no errors before submitting', async () => {
  render(<SignupForm onSignup={fn()} />)
  await user.type(screen.getByLabelText('Email'), 'x')
  expect(screen.queryByText('Enter a valid email')).toBeNull()
})
test('empty submit shows errors, focuses email, does not call onSignup', async () => {
  const onSignup = fn()
  render(<SignupForm onSignup={onSignup} />)
  await submit()
  expect(screen.getByText('Email is required')).toHaveAttribute('id', 'email-error')
  expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument()
  const email = screen.getByLabelText('Email')
  expect(email).toHaveAttribute('aria-invalid', 'true')
  expect(email).toHaveAttribute('aria-describedby', 'email-error')
  expect(email).toHaveFocus()
  expect(onSignup).not.toHaveBeenCalled()
})
test('focuses password when only the password is wrong', async () => {
  render(<SignupForm onSignup={fn()} />)
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  await user.type(screen.getByLabelText('Password'), 'short')
  await submit()
  expect(screen.queryByText('Email is required')).toBeNull()
  expect(screen.getByLabelText('Password')).toHaveFocus()
  expect(screen.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'password-error')
})
test('errors update while typing after the first submit', async () => {
  render(<SignupForm onSignup={fn()} />)
  await user.type(screen.getByLabelText('Email'), 'ada')
  await submit()
  expect(screen.getByText('Enter a valid email')).toBeInTheDocument()
  await user.type(screen.getByLabelText('Email'), '@example.com')
  expect(screen.queryByText('Enter a valid email')).toBeNull()
  expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid')
})
test('valid submit calls onSignup', async () => {
  const onSignup = fn()
  render(<SignupForm onSignup={onSignup} />)
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  await user.type(screen.getByLabelText('Password'), 'correct horse')
  await submit()
  expect(onSignup).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct horse' })
})
```
:::

:::tip title="How you would test this"
Forms are the component type most worth testing: they hold real business rules and break quietly. The
challenge's tests are already the pattern; in your own project they run under **Vitest** with **React
Testing Library**, and `vi.fn()` stands in for the callback:

```tsx
// SignupForm.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import { SignupForm } from './SignupForm'

test('an invalid email blocks submit and is announced on the field', async () => {
  const user = userEvent.setup()
  const onSignup = vi.fn()
  render(<SignupForm onSignup={onSignup} />)
  await user.type(screen.getByLabelText('Email'), 'ada')
  await user.click(screen.getByRole('button', { name: 'Create account' }))
  expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true')
  expect(onSignup).not.toHaveBeenCalled()
})
```

Finding the field **by its label** is a free accessibility check: if `getByLabelText('Email')` fails, a
screen reader can't name the field either. The full setup is in **Testing React with Vitest & Testing Library**.
:::

## Submitting to a server: pending, errors, double-submits

A real submit is async. While it runs, you need to show progress, block a second click (or the
user creates two orders), and handle failure. Hand-rolled, that's a lot of state, and every
form repeats it:

```tsx
const [pending, setPending] = useState(false)
const [error, setError] = useState<string | null>(null)

async function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
  e.preventDefault()
  setPending(true)
  setError(null)
  try {
    await api.subscribe(email)
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Something went wrong')
  } finally {
    setPending(false)
  }
}
```

Note what this needs: a `finally` so the button never stays disabled after an error, and `disabled`
on the button, wired to `pending`, to stop the double submit.

## React 19 form actions

React 19 builds this pattern in. A `<form>` can take a **function** as its `action` (instead of
the classic URL string). When the form is submitted, React:

- calls it with the form's `FormData` (no `preventDefault()` needed, because React handles the submit),
- runs it inside a **transition**, a lower-priority update during which the UI stays interactive,
- tracks the pending state for you,
- and **resets the form's uncontrolled fields** once the action has finished.

```tsx
<form action={async (formData) => {
  await api.subscribe(String(formData.get('email')))
}}>
  <input name="email" type="email" required />
  <button>Subscribe</button>
</form>
```

### `useActionState`: the action's result as state

Usually you need the action's outcome (success message, server errors) in the UI.
`useActionState(action, initialState)` wraps your action and returns `[state, formAction, isPending]`:

```tsx
import { useActionState } from 'react'

type State = { ok: boolean; message: string }

async function subscribeAction(prev: State, formData: FormData): Promise<State> {
  try {
    await api.subscribe(String(formData.get('email')))
    return { ok: true, message: 'Subscribed!' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Failed' }
  }
}

function Newsletter() {
  const [state, formAction, isPending] = useActionState(subscribeAction, { ok: false, message: '' })
  return (
    <form action={formAction}>
      <label>Email <input name="email" type="email" required /></label>
      <button disabled={isPending}>{isPending ? 'Subscribing…' : 'Subscribe'}</button>
      {state.message && <p role={state.ok ? 'status' : 'alert'}>{state.message}</p>}
    </form>
  )
}
```

- The action receives the **previous state** first, then the payload (`FormData` when used as a form action).
- Whatever it returns becomes the new `state`. Throwing is not the way to report validation errors — return them.
- `isPending` is `true` from submit until the action resolves.
- Multiple submissions are queued and run in order, each getting the previous result.

:::warn title="The automatic reset also happens when you return errors"
The reset runs when the action *finishes*, and returning `{ ok: false, message: 'Email taken' }` is
still a finished action. So the user's input is wiped exactly when they need to fix it. Two common
fixes: return the submitted values in the state and render them with
`defaultValue={state.values?.email}`, or make the fields controlled (React never resets controlled
inputs).
:::

You can also call the returned function yourself with any payload. When it isn't passed to a form's
`action`, wrap the call in `startTransition`. Otherwise `isPending` isn't tracked and React logs a
warning:

```tsx
const [state, dispatch, isPending] = useActionState(saveAction, initial)
startTransition(() => dispatch({ email }))
```

### `useFormStatus`: pending state for child components

A design-system `SubmitButton` deep in the form wants to know if *its* form is submitting, without
props. `useFormStatus` (from `react-dom`) reads the status of the nearest parent `<form>` with an action:

```tsx
import { useFormStatus } from 'react-dom'

function SubmitButton({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus()
  return <button type="submit" disabled={pending}>{pending ? 'Saving…' : children}</button>
}
```

It must be rendered **inside** the `<form>`, because it doesn't work in the same component that
renders the form. Besides `pending`, it returns `data` (the submitted `FormData`), `method` and
`action`.

:::quiz id=fe-10-q2 xp=15
Which statements about React 19 form actions are true? (select all that apply)

- [x] `<form action={fn}>` calls `fn` with the form's `FormData` on submit
- [x] `useActionState` returns `[state, action, isPending]` and the action receives the previous state as its first argument
- [ ] `useFormStatus` works when called in the same component that renders the `<form>`
- [x] Client-side form actions don't replace server-side validation in your ASP.NET API
- [ ] `isPending` must be managed manually with `useState`
> The first, second and fourth are true. `useFormStatus` reads the status of a **parent** form, so
> called in the component that *renders* the `<form>` it finds no parent form and `pending` is always
> `false`. Move it into a child such as `SubmitButton`. `isPending` comes from `useActionState` (and
> `pending` from `useFormStatus`), so you don't keep it in your own `useState`. And anything the browser
> sends can be forged, so the API validates again.
:::

:::challenge id=fe-10-c4 lang=tsx xp=60 preview=Demo
title: Newsletter with useActionState
Build `Newsletter({ subscribe })` where `subscribe(email)` returns a promise (it may reject).
Use **`useActionState`** for the result and pending state:

- a controlled input labelled `Email` and a submit button `Subscribe`
- while pending the button reads `Subscribing…` and is disabled
- on success show `<p role="status">Subscribed!</p>`; on failure `<p role="alert">` with the error's message
- on submit, call the action with the email inside `startTransition` (the sandbox calls actions this way; in your app `<form action={formAction}>` with a `name="email"` input is equivalent)

hint: `const [state, dispatch, isPending] = useActionState(async (prev: State, email: string) => { … }, { ok: false, message: '' })`
hint: `onSubmit={(e) => { e.preventDefault(); startTransition(() => dispatch(email)) }}` — import `startTransition` from `'react'`.

```tsx starter
import { useActionState, useState, startTransition } from 'react'

type State = { ok: boolean; message: string }

export function Newsletter({ subscribe }: { subscribe: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  return (
    <form onSubmit={(e) => { e.preventDefault() /* TODO: dispatch the action */ }}>
      <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <button type="submit">Subscribe</button>
    </form>
  )
}

export function Demo() {
  return <Newsletter subscribe={(e) => new Promise((ok, fail) => setTimeout(() => (e.includes('@') ? ok() : fail(new Error('Invalid email'))), 800))} />
}
```

```tsx solution
import { useActionState, useState, startTransition } from 'react'

type State = { ok: boolean; message: string }

export function Newsletter({ subscribe }: { subscribe: (email: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [state, dispatch, isPending] = useActionState(
    async (_prev: State, value: string): Promise<State> => {
      try {
        await subscribe(value)
        return { ok: true, message: 'Subscribed!' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : 'Something went wrong' }
      }
    },
    { ok: false, message: '' },
  )

  return (
    <form onSubmit={(e) => { e.preventDefault(); startTransition(() => dispatch(email)) }}>
      <label>Email <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <button type="submit" disabled={isPending}>{isPending ? 'Subscribing…' : 'Subscribe'}</button>
      {state.message && <p role={state.ok ? 'status' : 'alert'}>{state.message}</p>}
    </form>
  )
}

export function Demo() {
  return <Newsletter subscribe={(e) => new Promise((ok, fail) => setTimeout(() => (e.includes('@') ? ok() : fail(new Error('Invalid email'))), 800))} />
}
```

```tsx tests
test('shows pending, then success', async () => {
  const subscribe = fn(() => new Promise((r) => setTimeout(r, 100)))
  render(<Newsletter subscribe={subscribe} />)
  await user.type(screen.getByLabelText('Email'), 'ada@example.com')
  await user.click(screen.getByRole('button', { name: 'Subscribe' }))
  expect(screen.getByRole('button', { name: 'Subscribing…' })).toBeDisabled()
  expect(await screen.findByRole('status')).toHaveTextContent('Subscribed!')
  expect(screen.getByRole('button', { name: 'Subscribe' })).toBeEnabled()
  expect(subscribe).toHaveBeenCalledWith('ada@example.com')
})
test('shows the error message', async () => {
  const subscribe = fn(async () => { throw new Error('Already subscribed') })
  render(<Newsletter subscribe={subscribe} />)
  await user.type(screen.getByLabelText('Email'), 'ada@example.com{Enter}')
  expect(await screen.findByRole('alert')).toHaveTextContent('Already subscribed')
})
```
:::

## Forms at scale: React Hook Form + Zod

Everything above is worth writing by hand **once**, because it shows what a form really needs: values,
"touched" tracking, validation timing, error wiring, focus on the first error, pending state, server errors.
Now imagine a 25-field settings page. Hand-rolled, you'd repeat that plumbing per field, every controlled
input would re-render the whole form on each keystroke, and the rules would live in one place while the
TypeScript type of the form lived in another — free to drift apart.

That's why most React teams reach for two libraries that split the job:

- **Zod** describes the data: one **schema** is both the validation rules *and* (via `z.infer`) the
  TypeScript type. Change the schema and the type follows.
- **React Hook Form (RHF)** runs the form: it registers **uncontrolled** inputs (the DOM holds the value,
  as you saw earlier), tracks touched/dirty/errors, focuses the first invalid field on submit and exposes
  `isSubmitting`. Because inputs are uncontrolled, typing doesn't re-render the whole form.
- `zodResolver` from `@hookform/resolvers` is the glue: RHF asks the schema to validate.

Here is the `SignupForm` from the challenge, rewritten:

```tsx
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

const signupSchema = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})
type SignupValues = z.infer<typeof signupSchema>   // { email: string; password: string }: no second type to maintain

export function SignupForm({ onSignup }: { onSignup: (v: SignupValues) => Promise<void> }) {
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    mode: 'onTouched',       // first check on blur, then live: the policy from "Validation that everyone can use"
  })

  return (
    <form noValidate onSubmit={handleSubmit(onSignup)}>   {/* handleSubmit: preventDefault + validate + call you */}
      <label htmlFor="email">Email</label>
      <input id="email" type="email" {...register('email')}
        aria-invalid={errors.email ? true : undefined}
        aria-describedby={errors.email ? 'email-error' : undefined} />
      {errors.email && <p id="email-error">{errors.email.message}</p>}

      {/* password: same pattern */}

      <button disabled={isSubmitting}>Create account</button>
    </form>
  )
}
```

Read what you *didn't* write: no `useState` per field, no `touched` map, no `finally { setPending(false) }`,
no manual `focus()`. What you still write is the accessibility wiring (`aria-invalid`, `aria-describedby`)
because no library knows your markup, so everything from the validation section still applies.

**Server errors go back onto the fields.** Only the server knows "email already taken". ASP.NET Core answers
with a `ValidationProblemDetails` (`400`, `{ errors: { Email: ['Already registered'] } }`); map it with RHF's
`setError` so the message appears exactly where a client-side one would:

```ts
// inside SignupForm: const { register, handleSubmit, setError, formState } = useForm<SignupValues>(…)

async function onSubmit(values: SignupValues) {
  const res = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) })
  if (res.status === 400) {
    const problem: { errors: Record<string, string[]> } = await res.json()
    for (const [key, messages] of Object.entries(problem.errors)) {
      const field = (key[0].toLowerCase() + key.slice(1)) as keyof SignupValues   // "Email" → "email"
      setError(field, { type: 'server', message: messages[0] })
    }
    return
  }
  if (!res.ok) setError('root', { message: 'Something went wrong, please try again' })   // form-level error
}
```

The same Zod schemas are handy at the other end of the wire too: `schema.parse(await res.json())` checks
that the server's response really has the shape your types claim. The typed API client, including
types generated from the backend's OpenAPI document, is covered in **Server State with TanStack Query**.

:::info title="React Hook Form or React 19 form actions?"
They solve overlapping problems. `useActionState` is built in and works with uncontrolled `FormData`: great
for small forms and for frameworks with server actions. RHF + Zod wins when you need per-field live
validation, many fields, field arrays (add/remove rows) or wizard steps. Many codebases use both: actions
for a search box or newsletter field, RHF for the big settings and checkout forms. TanStack Form is a
newer alternative with the same shape.
:::

:::quiz id=fe-10-q6 xp=10
Your team defines `const orderSchema = z.object({ … })` and then `type Order = z.infer<typeof orderSchema>`.
What is the main benefit compared with writing `type Order = { … }` by hand next to the schema?
- [ ] `z.infer` makes the validation run at compile time, so no runtime check is needed
- [x] The rules and the type come from one source, so they can't drift apart when someone edits one of them
- [ ] It makes the form uncontrolled, which avoids re-renders
- [ ] The server no longer needs to validate, because the types are shared
> TypeScript types vanish at runtime; Zod checks at runtime. `z.infer` derives the static type *from* the
> runtime schema, so adding a field or making one optional updates both at once. Validation still runs at
> runtime (that's the point of a schema), re-render behaviour is React Hook Form's business, not Zod's,
> and the server must validate again regardless: anyone can call the API without your form.
:::

:::quiz id=fe-10-q7 xp=15
A user submits the RHF signup form; the ASP.NET API returns `400` with
`{ "errors": { "Email": ["Already registered"] } }`. What should the form do?
- [ ] Show a toast "Request failed (400)" and clear the form
- [ ] Add an `alreadyRegistered` rule to the Zod schema so the client catches it next time
- [x] Call `setError('email', { type: 'server', message: 'Already registered' })` so the message appears on the Email field
- [ ] Throw the error so the nearest error boundary renders a fallback
> Server validation errors belong next to the field they're about, exactly like client-side ones, and they
> should keep the user's input. A generic toast loses that context and clearing the form punishes the user.
> The client can't know which emails are taken, so no schema rule can catch it. Error boundaries are for
> unexpected crashes, not for an expected "please fix this field" answer.
:::

:::job title="Forms on a real team"
- Larger forms use a library: **React Hook Form** (uncontrolled under the hood, very fast) or **TanStack Form**, with a **Zod** schema for validation and types.
- The backend's validation errors (ASP.NET `ValidationProblemDetails`: `{ errors: { Email: ['…'] } }`) are mapped back onto the fields — the client can't know "email already taken".
- QA will tab through your form with the keyboard and run a screen reader. Labels, focus management and `aria-describedby` are not optional polish.
- The submit button is disabled (or ignored) while pending — double-submitted orders are real incidents.
:::

:::pro title="Validate where the data enters"
Put the validation rules in one pure function or schema, not spread across `onChange` handlers.
It's then testable without rendering, reusable for "save draft" vs "submit" rules, and can even be
shared with a Node backend. With an ASP.NET backend, keep rules in sync deliberately (or generate
them from the OpenAPI spec) — and treat the server as the source of truth.
:::

:::cards id=fe-10-cards1 xp=15 title="Forms"
Q: Why use `<form onSubmit>` instead of a button `onClick`?
A: Enter-to-submit, native validation, autofill/password managers, accessibility. Call `e.preventDefault()`.
Q: Controlled vs uncontrolled input?
A: Controlled: React state is the source of truth (`value` + `onChange`). Uncontrolled: the DOM holds it (`defaultValue`, read via ref/FormData).
Q: What does `useRef` give you?
A: A mutable `{ current }` box that persists across renders without causing re-renders; with `ref={…}` it holds a DOM node.
Q: How do you link an error message to an input accessibly?
A: `aria-invalid="true"` + `aria-describedby="<id of message>"` on the input; focus the first invalid field on submit.
Q: Is client-side validation security?
A: No — it's UX. The API must validate again.
Q: What does `useActionState` return?
A: `[state, action, isPending]`; the action gets `(previousState, payload)` and its return value becomes the state.
Q: What is `useFormStatus` for and where must it be called?
A: Reading `pending` (and data) of the parent form with an action — from a component rendered inside that `<form>`. It's exported by `react-dom`.
Q: Why `type="button"` on a Cancel button?
A: Buttons in a form default to `type="submit"`.
Q: `new FormData(form).get('email')` returns `null`. Most likely cause?
A: The input has no `name="email"`. FormData collects fields by `name`, not `id`.
Q: A React 19 form action returned validation errors and the fields are now empty. Why?
A: React resets uncontrolled fields when the action finishes, errors or not. Echo the values back via `defaultValue`, or use controlled inputs.
:::

## Recap

- Start with a real `<form>` and `onSubmit` + `preventDefault()`.
- Buttons in a form are submit buttons unless you write `type="button"`.
- Controlled inputs = state is the truth (live validation); uncontrolled = DOM is the truth (refs, `FormData` keyed by `name`).
- Validate on submit, then live; show errors next to fields with `aria-invalid` + `aria-describedby`; focus the first invalid field.
- Async submits need pending state, double-submit protection and error display.
- React 19: `<form action={fn}>`, `useActionState` for result + pending, `useFormStatus` for children like submit buttons. Uncontrolled fields reset after the action finishes, even when it returned errors.
- At scale: **Zod** schema = rules + type (`z.infer`), **React Hook Form** runs the form (uncontrolled
  fields, touched/errors, focus on error, `isSubmitting`), `zodResolver` connects them; map server
  `ValidationProblemDetails` onto fields with `setError`.
- The server validates again — always.
